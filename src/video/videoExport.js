/*
 * 動画書き出し MML.Video(MML再生 → MP4、X などへの貼り付け用)
 *
 *   MML.Video.isSupported()                 -> boolean(VideoEncoder + AudioEncoder の有無)
 *   await MML.Video.probe()                 -> boolean(H.264 と AAC を実際に符号化できるか)
 *   MML.Video.createScene(opt)              -> { width, height, draw(canvas, t) }(1枚を描く。プレビューにも使う)
 *   await MML.Video.render(opt)             -> Blob('video/mp4')
 *   MML.Video.LAYOUTS / RESOLUTIONS          -> 設定パネル(src/ui/videoExportPanel.js)の選択肢
 *
 * 画面は「ピアノロール+鍵盤」と「MMLエディタ(色分け+再生ハイライト+追随スクロール)」の2区画を、
 * 画面構成(layout)で上下/左右/どちらか一方に並べる。ロールと鍵盤は画面の鍵盤表示と同じ描画コード
 * (keyboardDisplay.renderExportFrame)で、エディタは Mml.highlightTokens のトークン列を canvas に描く
 * (画面のエディタと同じ色分け・同じハイライト規則)。色はページの CSS 変数から読むので、
 * エディタ設定で変えた配色がそのまま動画に乗る。
 *
 * 時間軸: 映像の各フレーム k は曲内時刻 t=k/fps の1枚。音声は同じキャプチャ結果(cap.audio)を
 * AAC にしたもので、ロール/鍵盤も cap の regSnapshots から描くのでループ後まで完全に同期する。
 * 実時間で録画するのではなく1枚ずつ描いて VideoEncoder に送るので、重くてもカクつかない。
 *
 * opt(render / createScene 共通):
 *   width, height, fps            … 出力サイズ・フレームレート
 *   layout                        … LAYOUTS のキー
 *   rollOrientation               … 'vertical'(音符が降る・鍵盤が下) | 'horizontal'(音符が流れる・鍵盤が左)
 *   split                         … 2区画のときロール側の割合(0.3〜0.8)
 *   scale                         … ロール/鍵盤の描画倍率(1/1.5/2。線幅・文字が固定pxなので高解像度では上げる)
 *   editorFontPx, showTitle, title, subtitle, followCh, bitrate
 *   pane2                         … 'editor'(MMLエディタ、既定) | 'score'(楽譜)。「エディタ」の区画に出すもの
 *   scoreMode, scoreStyle         … 楽譜のとき: 'all' | 'piano'(楽譜の形)、'color' | 'mono'(白地に黒)
 *   source, compiled              … MML 原文とコンパイル結果(highlightRanges / channelLetters / frameRate / loopPointFrame / loopLen)
 *   cap                           … captureSongAsync の結果(regSnapshots/writeLog/audio…)。プレビューは即席の同形でよい
 *   keyboardDisplay, chips, tuning… 鍵盤表示のインスタンスとチップ構成、{tuningCents,tuningNotes}
 *   isChannelMuted(ch)            … ミュート中の ch はハイライトしない(音も鳴っていない)
 *   durationSeconds, gain         … render のみ。音声の長さと gain(MML/NSF は 3.0)
 *   onProgress(stage, frac), signal(AbortSignal)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Video = MML.Video = MML.Video || {};

  const LAYOUTS = [
    ['roll-editor-v', 'ロール(上) + エディタ(下)'],
    ['editor-roll-v', 'エディタ(上) + ロール(下)'],
    ['roll-editor-h', 'ロール(左) + エディタ(右)'],
    ['editor-roll-h', 'エディタ(左) + ロール(右)'],
    ['roll', 'ロールのみ'],
    ['editor', 'エディタのみ'],
  ];
  const RESOLUTIONS = [
    ['1280x720', '1280×720 (16:9)'],
    ['1920x1080', '1920×1080 (16:9)'],
    ['1080x1080', '1080×1080 (正方形)'],
    ['720x1280', '720×1280 (縦 9:16)'],
    ['1080x1920', '1080×1920 (縦 9:16)'],
  ];

  function isSupported() {
    return typeof global.VideoEncoder !== 'undefined' && !!(MML.Audio && MML.Audio.Aac && MML.Audio.Aac.isSupported());
  }

  // H.264 のプロファイル/レベル文字列。レベルはマクロブロック/秒で決める(4.0=245760、4.2=522240)
  function codecCandidates(width, height, fps) {
    const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
    const level = mbps > 245760 ? '2A' : '28';
    return ['avc1.6400' + level, 'avc1.4D40' + level, 'avc1.42E0' + level]; // High / Main / Baseline
  }

  async function pickVideoConfig(width, height, fps, bitrate) {
    for (const codec of codecCandidates(width, height, fps)) {
      const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' };
      try {
        const r = await global.VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return r.config ? Object.assign(cfg, { codec: r.config.codec || codec }) : cfg;
      } catch (e) { /* 次の候補 */ }
    }
    return null;
  }

  async function probe() {
    if (!isSupported()) return false;
    try {
      const v = await pickVideoConfig(1280, 720, 30, 6000000);
      const a = await MML.Audio.Aac.probe(44100, 2);
      return !!v && a;
    } catch (e) { return false; }
  }

  // ── 色(ページの CSS 変数から) ──────────────────────────────────────
  const TOK_CLASSES = ['tok-header', 'tok-track', 'tok-note', 'tok-rest', 'tok-cmd-length', 'tok-cmd-volume',
    'tok-cmd-pitch', 'tok-cmd-perf', 'tok-cmd-special', 'tok-def-envelope', 'tok-def-tone', 'tok-comment'];
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    const tok = {};
    for (const c of TOK_CLASSES) tok[c] = v('--' + c, '#e6e6ef');
    return {
      tok,
      bg: v('--bg', '#1e1e24'),
      surface: v('--surface', '#14141a'),
      text: v('--text', '#e6e6ef'),
      textMuted: v('--text-muted', '#9aa0ac'),
      border: v('--border', '#3a3a44'),
      editorBg: v('--mml-editor-bg', '#14141a'),
      editorFg: v('--mml-editor-fg', '#e6e6ef'),
      playingFg: v('--playing-fg', '#ffffff'),
      playingOutline: v('--playing-outline', '#ff8c00'),
      followFg: v('--follow-fg', '#ffffff'),
      followOutline: v('--follow-outline', '#e53935'),
      mono: v('--mml-font-family', '') || v('--mono', 'Consolas, monospace'),
      sans: v('--sans', 'sans-serif'),
    };
  }

  // ── 画面構成 → 各区画の矩形 ───────────────────────────────────────
  function layoutRects(opt, titleH) {
    const W = opt.width, H = opt.height;
    const top = titleH;
    const body = { x: 0, y: top, w: W, h: H - top };
    const split = Math.min(0.85, Math.max(0.15, opt.split || 0.6));
    // MML 原文が無い(ファイル再生)ときはエディタ区画を描けないので、ロールのみに落とす
    const L = (opt.source == null) ? 'roll' : (opt.layout || 'roll-editor-v');
    if (L === 'roll') return { roll: body, editor: null };
    if (L === 'editor') return { roll: null, editor: body };
    if (L === 'roll-editor-v' || L === 'editor-roll-v') {
      const hA = Math.round(body.h * (L === 'roll-editor-v' ? split : 1 - split));
      const A = { x: 0, y: body.y, w: W, h: hA }, B = { x: 0, y: body.y + hA, w: W, h: body.h - hA };
      return L === 'roll-editor-v' ? { roll: A, editor: B } : { roll: B, editor: A };
    }
    const wA = Math.round(W * (L === 'roll-editor-h' ? split : 1 - split));
    const A = { x: 0, y: body.y, w: wA, h: body.h }, B = { x: wA, y: body.y, w: W - wA, h: body.h };
    return L === 'roll-editor-h' ? { roll: A, editor: B } : { roll: B, editor: A };
  }

  // ── エディタ区画 ─────────────────────────────────────────────────
  function makeEditor(opt, colors) {
    const Mml = MML.Mml;
    const src = opt.source || '';
    const lines = Mml.highlightTokens(src);
    // 各行の絶対文字位置(srcStart → 行番号の逆引き用)
    const lineStart = [];
    { let p = 0; const re = /\r\n|\r|\n/g; let m; lineStart.push(0); while ((m = re.exec(src)) !== null) { p = m.index + m[0].length; lineStart.push(p); } }
    const lineOf = (pos) => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };

    const compiled = opt.compiled;
    const ranges = (compiled && compiled.highlightRanges) || {};
    const letters = (compiled && compiled.channelLetters) || Object.keys(ranges);
    const fps = (compiled && compiled.frameRate) || 60;
    const totalFrames = (compiled && compiled.totalFrames) || 0;
    const loopPoint = compiled && compiled.loopPointFrame != null ? compiled.loopPointFrame : null;
    // コンパイル結果は1周ぶん(曲頭〜曲末=totalFrames)。それより先は [L, 曲末) を繰り返すので折り返す
    // (Mml.LoopPlan.mapFrame と同じ写像。音の cap は NSF を実際に回した全長ぶんある)
    const loopLen = (loopPoint != null && compiled.loopLen > 0) ? compiled.loopLen : 0;
    const wrapFrame = (f) => {
      if (f < totalFrames || loopLen <= 0) return Math.min(f, Math.max(0, totalFrames - 1));
      return loopPoint + ((f - loopPoint) % loopLen);
    };
    const cursor = {}; // ch → 前回ヒットした index(曲の進行に合わせて前へ進める)
    function activeRange(ch, frame) {
      const rs = ranges[ch]; if (!rs || !rs.length) return null;
      let i = cursor[ch] || 0;
      if (i >= rs.length) i = rs.length - 1;
      if (rs[i].startFrame > frame) { i = 0; }             // 折り返し(ループ)で巻き戻った
      while (i < rs.length && rs[i].endFrame <= frame) i++;
      cursor[ch] = i;
      if (i < rs.length && rs[i].startFrame <= frame && frame < rs[i].endFrame) return rs[i];
      return null;
    }
    // 追尾チャンネル: 指定があればそれ、無ければ音符のある最初のチャンネル
    const followCh = (opt.followCh && ranges[opt.followCh]) ? opt.followCh : (letters.find((ch) => ranges[ch] && ranges[ch].length) || null);

    const fontPx = Math.max(8, Math.round(opt.editorFontPx || 18));
    const lineH = Math.round(fontPx * 1.4);
    const pad = Math.round(fontPx * 0.6);
    const font = `${fontPx}px ${colors.mono}`;
    const widthCache = new Map();
    let scrollPx = null; // 追随スクロールの現在位置(px)。null=未初期化

    function draw(ctx, rect, t, dt) {
      const frame = wrapFrame(Math.floor(t * fps));
      ctx.save();
      ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
      ctx.fillStyle = colors.editorBg;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.font = font;
      ctx.textBaseline = 'top';
      const measure = (s) => { let w = widthCache.get(s); if (w === undefined) { w = ctx.measureText(s).width; widthCache.set(s, w); } return w; };

      // 今鳴っている範囲(ch ごとに1つ)。ミュート中の ch は音も出ていないので光らせない
      const active = [];
      let followLine = null;
      for (const ch of letters) {
        if (opt.isChannelMuted && opt.isChannelMuted(ch)) continue;
        const r = activeRange(ch, frame);
        if (!r) continue;
        active.push({ s: r.srcStart, e: r.srcEnd, follow: ch === followCh });
        if (ch === followCh) followLine = lineOf(r.srcStart);
      }
      // 追随スクロール: 追尾 ch の行を区画の縦中央へ。行単位で飛ばず、滑らかに寄せる
      const visH = rect.h - pad * 2;
      const maxScroll = Math.max(0, lines.length * lineH - visH);
      if (followLine != null) {
        const target = Math.min(maxScroll, Math.max(0, followLine * lineH - (visH - lineH) / 2));
        if (scrollPx === null) scrollPx = target;
        else scrollPx += (target - scrollPx) * (1 - Math.exp(-(dt || 0) * 6));
      } else if (scrollPx === null) scrollPx = 0;

      const first = Math.max(0, Math.floor(scrollPx / lineH));
      const last = Math.min(lines.length - 1, Math.ceil((scrollPx + visH) / lineH));
      const x0 = rect.x + pad, xMax = rect.x + rect.w - pad;
      for (let li = first; li <= last; li++) {
        const y = rect.y + pad + li * lineH - scrollPx;
        let x = x0;
        for (const tk of lines[li]) {
          if (x >= xMax) break;
          const w = measure(tk.text);
          // 空白トークンは描かない(幅だけ進める)
          if (tk.cls !== 'tok-space' && tk.text.trim() !== '') {
            let hit = null;
            for (const a of active) { if (tk.s < a.e && a.s < tk.e) { hit = a; if (a.follow) break; } }
            if (hit) {
              ctx.lineWidth = Math.max(2, Math.round(fontPx / 7));
              ctx.lineJoin = 'round';
              ctx.strokeStyle = hit.follow ? colors.followOutline : colors.playingOutline;
              ctx.strokeText(tk.text, x, y);
              ctx.fillStyle = hit.follow ? colors.followFg : colors.playingFg;
            } else {
              ctx.fillStyle = tk.cls ? (colors.tok[tk.cls] || colors.editorFg) : colors.editorFg;
            }
            ctx.fillText(tk.text, x, y);
          }
          x += w;
        }
      }
      ctx.restore();
    }
    return { draw };
  }

  // ── 楽譜区画(エディタ区画の代わりに出せる、2026-10-25) ─────────────────
  // 楽譜ウィンドウ(src/ui/scoreView.js)と同じ段組み・同じ描画コード(src/score/engrave.js)。区画の幅で
  // 段組みし、再生位置の段が区画の上寄りに来るよう滑らかにスクロールする。
  //   opt.scoreMode  'all'(1chごとに1段) | 'piano'(右手/左手の2段+打楽器)
  //   opt.scoreStyle 'color'(パートごとの色) | 'mono'(白地に黒)
  function makeScore(opt, colors) {
    const Score = MML.Score;
    const compiled = opt.compiled;
    if (!compiled || !Score) return null;
    let notation;
    try {
      notation = opt.scoreMode === 'piano' ? Score.buildPianoNotation(compiled, {}) : Score.buildNotation(compiled, {});
    } catch (e) { console.warn('動画の楽譜の組み立てに失敗:', e); return null; }
    const kd = opt.keyboardDisplay;
    const ink = Score.inkFor(opt.scoreStyle === 'mono' ? 'mono' : 'color',
      kd && kd.getChannelColorByLetter ? (l) => kd.getChannelColorByLetter(l) : null);
    const fps = compiled.frameRate || 60;
    const totalFrames = compiled.totalFrames || 0;
    const loopPoint = compiled.loopPointFrame != null ? compiled.loopPointFrame : null;
    const loopLen = (loopPoint != null && compiled.loopLen > 0) ? compiled.loopLen : 0;
    const wrapFrame = (f) => {
      if (loopPoint == null || loopLen <= 0) return f;
      return f < totalFrames ? f : loopPoint + ((f - loopPoint) % loopLen);
    };
    // 五線の間隔: エディタの文字サイズに合わせる(18px → 8)
    const sp = Math.max(4, Math.round((opt.editorFontPx || 18) * 0.45));
    let layout = null, layoutW = 0, scrollPx = null;

    function draw(ctx, rect, t, dt) {
      ctx.save();
      ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
      ctx.fillStyle = opt.scoreStyle === 'mono' ? ink.bg : colors.editorBg;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      const pad = Math.round(sp * 1.5);
      const width = Math.max(120, rect.w - pad * 2);
      if (!layout || layoutW !== width) {
        const measureText = (s, px) => { ctx.font = `${px}px ${colors.sans}`; return ctx.measureText(s).width; };
        try { layout = Score.layoutScore(notation, { sp, width, measureText }); } catch (e) { console.warn('動画の楽譜の段組みに失敗:', e); layout = null; }
        layoutW = width; scrollPx = null;
      }
      if (!layout) { ctx.restore(); return; }
      const c = Score.cursorAtFrame(layout, wrapFrame(Math.floor(t * fps)));
      // 追随: カーソルの段を区画の上から1/4あたりへ。段が変わるときは滑らかに寄せる
      const maxScroll = Math.max(0, layout.height - (rect.h - pad));
      if (c) {
        const target = Math.min(maxScroll, Math.max(0, c.y0 - rect.h * 0.25));
        if (scrollPx === null) scrollPx = target;
        else scrollPx += (target - scrollPx) * (1 - Math.exp(-(dt || 0) * 6));
      } else if (scrollPx === null) scrollPx = 0;
      ctx.translate(rect.x + pad, rect.y + pad / 2 - scrollPx);
      Score.drawScore(ctx, layout, ink);
      if (c) {
        ctx.fillStyle = ink.cursor;
        ctx.fillRect(Math.round(c.x) - 1, c.y0, Math.max(2, Math.round(sp / 4)), c.y1 - c.y0);
      }
      ctx.restore();
    }
    return { draw };
  }

  // ── シーン(1枚を描く) ───────────────────────────────────────────
  function createScene(opt) {
    const colors = readColors();
    const W = opt.width, H = opt.height;
    const scale = opt.scale || 1;
    const titleH = opt.showTitle ? Math.round(Math.max(24, Math.min(H * 0.06, 44))) : 0;
    const rects = layoutRects(opt, titleH);
    const kd = opt.keyboardDisplay;
    const orientation = opt.rollOrientation === 'horizontal' ? 'horizontal' : 'vertical';
    // 材料: MML は cap(captureSongAsync の結果)から組む。ファイル再生は鍵盤表示が先読み済みの
    // ものを exportFromCurrent() で渡してくる(opt.ex)
    const ex = (rects.roll && kd) ? (opt.ex || (opt.cap ? kd.prepareExport(opt.cap, opt.chips || [], opt.tuning || null) : null)) : null;

    // ロール/鍵盤の canvas(DOM に付けない)。内部解像度は区画の大きさ ÷ 倍率
    let rollC = null, pianoC = null, rollDst = null, pianoDst = null;
    if (rects.roll) {
      const r = rects.roll;
      const pianoLen = Math.round((MML.UI.PIANO_KEY_LEN || 68) * scale);
      if (orientation === 'vertical') {
        rollDst = { x: r.x, y: r.y, w: r.w, h: r.h - pianoLen };
        pianoDst = { x: r.x, y: r.y + r.h - pianoLen, w: r.w, h: pianoLen };
      } else {
        pianoDst = { x: r.x, y: r.y, w: pianoLen, h: r.h };
        rollDst = { x: r.x + pianoLen, y: r.y, w: r.w - pianoLen, h: r.h };
      }
      const mk = (d) => {
        const c = document.createElement('canvas');
        c._cachedWidth = Math.max(1, Math.round(d.w / scale));
        c._cachedHeight = Math.max(1, Math.round(d.h / scale));
        c.width = c._cachedWidth; c.height = c._cachedHeight;
        return c;
      };
      rollC = mk(rollDst); pianoC = mk(pianoDst);
    }
    // 「エディタ」の区画には MMLエディタか楽譜のどちらかを出す(opt.pane2)
    const editor = rects.editor ? (opt.pane2 === 'score' ? makeScore(opt, colors) : makeEditor(opt, colors)) : null;
    const total = opt.durationSeconds || 0;
    const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    let lastT = null;

    function draw(canvas, t) {
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const ctx = canvas.getContext('2d');
      const dt = lastT === null ? 0 : Math.max(0, t - lastT);
      lastT = t;
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, W, H);

      if (ex) {
        if (t < (ex._lastT || 0)) { ex.rollCursor = {}; ex.scoreCursor = {}; } // 巻き戻し(プレビューのつまみ)
        ex._lastT = t;
        kd.renderExportFrame(ex, t, rollC, pianoC, orientation);
        ctx.imageSmoothingEnabled = scale !== 1;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = colors.surface;
        ctx.fillRect(rects.roll.x, rects.roll.y, rects.roll.w, rects.roll.h);
        ctx.drawImage(rollC, rollDst.x, rollDst.y, rollDst.w, rollDst.h);
        ctx.drawImage(pianoC, pianoDst.x, pianoDst.y, pianoDst.w, pianoDst.h);
      }
      if (editor) editor.draw(ctx, rects.editor, t, dt);

      // 区画の境界線
      ctx.strokeStyle = colors.border; ctx.lineWidth = 1;
      if (rects.roll && rects.editor) {
        ctx.beginPath();
        if (rects.roll.y === rects.editor.y) { const x = Math.max(rects.roll.x, rects.editor.x) + 0.5; ctx.moveTo(x, titleH); ctx.lineTo(x, H); }
        else { const y = Math.max(rects.roll.y, rects.editor.y) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      }
      if (titleH) {
        ctx.fillStyle = colors.surface;
        ctx.fillRect(0, 0, W, titleH);
        ctx.beginPath(); ctx.moveTo(0, titleH - 0.5); ctx.lineTo(W, titleH - 0.5); ctx.stroke();
        const fs = Math.round(titleH * 0.5);
        ctx.font = `600 ${fs}px ${colors.sans}`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = colors.text;
        const pad = Math.round(titleH * 0.4);
        const timeTxt = fmtTime(t) + (total ? ' / ' + fmtTime(total) : '');
        ctx.textAlign = 'right';
        ctx.fillText(timeTxt, W - pad, titleH / 2);
        const timeW = ctx.measureText(timeTxt).width + pad * 2;
        ctx.textAlign = 'left';
        // タイトル(太字)の右に作曲者(細字・薄色)。入り切らなければ末尾を省く
        const maxW = W - pad * 2 - timeW;
        const fit = (s) => { let out = s; while (out.length > 1 && ctx.measureText(out + '…').width > maxW) out = out.slice(0, -1); return out === s ? s : out + '…'; };
        const title = fit(opt.title || '');
        ctx.fillText(title, pad, titleH / 2);
        if (opt.subtitle && title === (opt.title || '')) {
          const tw = ctx.measureText(title).width + (title ? pad : 0);
          ctx.font = `${Math.round(fs * 0.85)}px ${colors.sans}`;
          ctx.fillStyle = colors.textMuted;
          let sub = opt.subtitle;
          while (sub.length > 1 && tw + ctx.measureText(sub + '…').width > maxW) sub = sub.slice(0, -1);
          ctx.fillText(sub === opt.subtitle ? sub : sub + '…', pad + tw, titleH / 2);
        }
      }
    }
    return { width: W, height: H, draw };
  }

  // ── 書き出し本体 ────────────────────────────────────────────────
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function render(opt) {
    if (!isSupported()) throw new Error('このブラウザは動画の書き出しに対応していません');
    const fps = opt.fps || 30;
    const width = opt.width, height = opt.height;
    const bitrate = opt.bitrate || 6000000;
    const cfg = await pickVideoConfig(width, height, fps, bitrate);
    if (!cfg) throw new Error('この解像度/フレームレートの H.264 を符号化できません');
    // 音声の材料: opt.audio({chans, sampleRate, gain}。ファイル再生)か cap.audio(MML)。
    // 曲が途中で終わる形式(VGM)は PCM が短いので、映像もその長さで切る
    const audioSrc = opt.audio
      ? opt.audio
      : (opt.cap && opt.cap.audio ? { chans: opt.cap.chans || [opt.cap.audio, opt.cap.audio], sampleRate: opt.cap.sampleRate, gain: opt.gain } : null);
    let seconds = opt.durationSeconds;
    if (audioSrc && audioSrc.chans[0]) seconds = Math.min(seconds, audioSrc.chans[0].length / audioSrc.sampleRate);
    const nFrames = Math.max(1, Math.round(seconds * fps));
    const TS = 90000;
    const frameDur = Math.round(TS / fps);
    const progress = (stage, f) => { if (opt.onProgress) opt.onProgress(stage, f); };
    const aborted = () => !!(opt.signal && opt.signal.aborted);

    const scene = createScene(opt);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;

    const samples = [];
    const chunks = [];
    let avcC = null, failed = null, total = 0;
    const encoder = new global.VideoEncoder({
      output: (chunk, meta) => {
        if (!avcC && meta && meta.decoderConfig && meta.decoderConfig.description) {
          const d = meta.decoderConfig.description;
          avcC = d instanceof Uint8Array ? d.slice() : new Uint8Array(d.buffer ? d.buffer.slice(0) : d);
        }
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        chunks.push(b); total += b.length;
        samples.push({ size: b.length, key: chunk.type === 'key', dts: samples.length * frameDur,
          pts: Math.round(chunk.timestamp * TS / 1e6) });
      },
      error: (e) => { failed = e; },
    });
    encoder.configure(cfg);
    const keyEvery = fps * 2;
    try {
      for (let k = 0; k < nFrames && !failed; k++) {
        if (aborted()) throw new Error('中止しました');
        scene.draw(canvas, k / fps);
        const frame = new global.VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: k % keyEvery === 0 });
        frame.close();
        // 符号化待ちを溜めすぎない(メモリ)。1秒ぶんを上限に手を離す
        while (encoder.encodeQueueSize > fps && !failed) await tick();
        if (k % 5 === 0) { progress('video', k / nFrames); await tick(); }
      }
      try { await encoder.flush(); } catch (e) { if (!failed) failed = e; }
    } finally {
      try { encoder.close(); } catch (e) { /* 既に閉じている */ }
    }
    if (failed) throw failed;
    if (!avcC) throw new Error('H.264 の decoderConfig が取得できませんでした');
    progress('video', 1);

    const vdata = new Uint8Array(total);
    { let o = 0; for (const c of chunks) { vdata.set(c, o); o += c.length; } chunks.length = 0; }

    // 音声(ステレオにして出す。モノラルAACを受け付けない投稿先があるかもしれないので)
    let audio = null;
    if (audioSrc) {
      const n = Math.min(audioSrc.chans[0].length, Math.round(seconds * audioSrc.sampleRate));
      const chans = audioSrc.chans.map((c) => c.subarray(0, n));
      if (chans.length === 1) chans.push(chans[0]);
      audio = await MML.Audio.Aac.encodeRaw(chans, audioSrc.sampleRate, {
        gain: audioSrc.gain == null ? 1 : audioSrc.gain, bitrate: 192000, onProgress: (f) => progress('audio', f),
      });
    }
    if (aborted()) throw new Error('中止しました');
    progress('mux', 0);
    const blob = Video.Mp4.build({
      video: { width, height, timescale: TS, frameDur, samples, data: vdata, avcC },
      audio,
    });
    progress('mux', 1);
    return blob;
  }

  Video.isSupported = isSupported;
  Video.probe = probe;
  Video.createScene = createScene;
  Video.render = render;
  Video.LAYOUTS = LAYOUTS;
  Video.RESOLUTIONS = RESOLUTIONS;
})(window);
