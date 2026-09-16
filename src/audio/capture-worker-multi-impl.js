/*
 * KSS/GBS/VGM/SPC/HES regsOnlyキャプチャ Worker本体(汎用ディスパッチ)
 *
 * NSF用のnsf-capture-worker-impl.jsと同じ仕組み(README-worker-build.txt参照)だが、
 * こちらは1本で複数フォーマットを扱う。各フォーマットのバンドルにこのファイルを
 * 結合し、msg.formatで対応するcaptureXxxSongAsyncへディスパッチする(バンドルに
 * 入っていないフォーマットを要求されたらerrorを返す)。
 *
 * プロトコル(capture-worker-client.jsの汎用ランナーと対):
 *   受信 {cmd:'capture', format:'kss'|'gbs'|'vgm'|'spc'|'hes', bytes, opt}
 *   受信 {cmd:'cancel'}
 *   送信 {type:'progress', done, total, arrays:{path:差分slice}, [meta]}
 *        - onProgressが渡すペイロード(進行中に育つ配列を含む構造)を走査し、
 *          「トップレベルまたは1段ネストの配列」をフレーム配列として前回送信位置
 *          からの差分だけ送る。配列以外(スカラ・フラグ・headerオブジェクト)は
 *          初回のみmetaとして送る。
 *   送信 {type:'done', [finalMeta]} … finalMetaはキャプチャ完了後に追加された
 *        非配列プロパティ(VGMのnes.dpcmRom等)を拾うための最終メタ再送
 *   送信 {type:'error', message}
 *   送信 {type:'roll', done, total, timeline, info}
 *        … opt.rollが渡された場合のみ。ピアノロールのタイムライン構築(1回あたり
 *          O(done)の全走査。メインスレッドでは長タスク=カクつきの主因だった)を
 *          Worker内で行い、完成品だけを送る(src/audio/roll-builders.js参照)。
 *          infoはフォーマット固有の副産物(KSS:sccUsed / HES:ddaChannel)。
 *   送信 {type:'rollError', message} … ロール構築の失敗(以後この曲では送らない。
 *        クライアントはメインスレッド構築へ切り替える)。キャプチャ自体は継続する。
 *
 * ★HESも汎用差分プロトコルを使わない: dpcmTrace/controlTraceが「外側は固定長6(ch数)、
 * 中身のch別イベント配列が伸びる」二重配列で、汎用差分(トップレベル/1段ネスト配列の
 * 長さ基準)では外側6要素を初回に送ったきり以後更新されない。専用ハンドラ(_runHes)で
 * snapshotsは長さ基準、トレース2本はch別の長さ基準で差分送信する。
 *
 * ★SPCだけは汎用差分プロトコルを使わない: MML.SPC2MML.captureAsyncのframeLogは
 * 「全フレーム分を空配列で事前確保してから埋めていく」ため、配列長が最初から
 * total固定で、長さ基準の差分検出が機能しない(初回に空配列の山を全送信し、以後
 * 何も送らなくなる)。完了フレーム数done基準で {start, frames:[...]} を差分送信する
 * 専用ハンドラ(_runSpc)を使う。書き込み途中の未完了フレーム(frameLog[done])は
 * まだ伸びている最中なので送らない(次のスライス境界で完成後に送られる)。
 */
(function (global) {
  const MML = global.MML;
  const Emu = MML.Emu;

  // Worker内で解析を進める1スライスの長さ(ms)。1スライスごとに進捗(progress)を1通送る。
  // ★以前は30msだったが、30msぶんのデータ(VGMで3000〜5000件)をメインスレッドが受け取って復元するのに
  //   40〜95msかかり、再生開始直後の画面の止まりと音声コールバックの遅れの原因になっていた
  //   (2026-09-13 実Chromeで計測。Worker受信のうちロール(type:roll)は1〜2msで、重いのはprogressだった)。
  //   送る総量は変えずに1通を小さくして、受信を短い処理に分ける。cancel応答性の上限でもある。
  //   8msで1通の復元が最大32ms、4msで最大20〜25msになり、ワルキューレの伝説/レイブレーサーの開始直後の長いタスク(50ms超)が消えた。
  const WORKER_SLICE_MS = 30;     // 既定(SPC/HES/KSS/GBS。受信が軽いので細かく区切る必要が無い)
  const WORKER_SLICE_MS_VGM = 4;  // VGMだけ: PCMプール系で1通の復元が重いため細かく区切る
  // setTimeout(0)の4msクランプを回避するマクロタスクyield(nsf-capture-worker-impl.jsと同じ)
  function macroYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  // onProgressペイロードを「フレーム配列(差分送信)」と「メタ(初回/最終のみ送信)」に
  // 分解する。sentは path->送信済み件数 の記録(呼び出しをまたいで保持)。
  // 'header'キーはVGMのパース済みヘッダ(ネストした静的オブジェクト)なので、
  // 中身を配列走査せず丸ごとメタ扱いにする。
  function diffPayload(payload, sent, includeMeta) {
    const arrays = {};
    const meta = includeMeta ? {} : null;
    for (const key of Object.keys(payload)) {
      const v = payload[key];
      if (Array.isArray(v)) {
        const n = sent[key] || 0;
        if (v.length > n) { arrays[key] = v.slice(n); sent[key] = v.length; }
      } else if (v && typeof v === 'object' && key !== 'header' && !ArrayBuffer.isView(v)) {
        let subMeta = null;
        for (const k2 of Object.keys(v)) {
          const v2 = v[k2];
          // プール式PCMチップの logical(合成ch)は snapshots から画面側で作り直せるので送らない
          // (roll-builders.js RollBuild.poolLogical)。c140 で progress の復元時間の約4割を占めていた
          if (k2 === 'logical' && Array.isArray(v.snapshots)) continue;
          if (Array.isArray(v2)) {
            const path = key + '.' + k2;
            const n = sent[path] || 0;
            if (v2.length > n) { arrays[path] = v2.slice(n); sent[path] = v2.length; }
          } else if (meta) {
            (subMeta = subMeta || {})[k2] = v2;
          }
        }
        // 配列しか持たないファミリでも「存在する(nullではない)」ことをメタで伝える
        if (meta) meta[key] = subMeta || {};
      } else if (meta) {
        meta[key] = v; // スカラ / null / 型付き配列
      }
    }
    return { arrays, meta };
  }

  // 各フォーマットのキャプチャ呼び出し。onProgressの引数形状の違いをここで
  // 「ペイロードオブジェクト1個」に正規化する(client側で逆変換する)。
  const FORMATS = {
    kss: (bytes, opt, onP) =>
      Emu.captureKssSongAsync(bytes, opt, (done, total, writeLog) => onP(done, total, { writeLog })),
    gbs: (bytes, opt, onP) =>
      Emu.captureGbsSongAsync(bytes, opt, (done, total, data) => onP(done, total, data)),
    vgm: (bytes, opt, onP) =>
      Emu.captureVgmSongAsync(bytes, opt, (done, total, data) => onP(done, total, data))
  };

  let cancelled = false;

  // ロール構築・送信(opt.rollが無ければ無効)。スロットルはRollBuild.makeThrottleを流用
  // (Worker内にdocumentが無いため可視性チェックは自動的に素通り=常時構築。構築は
  // メインスレッドをブロックしないので問題なく、コストに応じた間隔制御だけが効く)。
  function makeRollSender(format, msg) {
    const RollBuild = MML.RollBuild;
    if (!RollBuild || !msg.opt || !msg.opt.roll) return null;
    let params;
    if (format === 'kss') params = { frameRate: msg.opt.roll.frameRate, header: MML.KSS.parseHeader(msg.bytes) };
    else if (format === 'spc') params = { frameRate: MML.SPC2MML.FRAME_RATE, fineTune: msg.opt.roll.fineTune || null, drumKinds: msg.opt.roll.drumKinds || null };
    else params = msg.opt.roll; // gbs/hes: {frameRate} / vgm: {}
    const job = RollBuild.createRollJob(format, params);
    if (!job) return null;
    const throttle = RollBuild.makeThrottle();
    let failed = false;
    return (data, done, total) => {
      if (failed || !throttle.shouldBuild(done, total)) return;
      const t0 = performance.now();
      try {
        const r = job.build(data, done, total);
        throttle.didBuild(t0);
        global.postMessage({ type: 'roll', done, total, timeline: r.timeline, info: r.info });
      } catch (err) {
        failed = true;
        global.postMessage({ type: 'rollError', message: String((err && err.stack) || err) });
      }
    };
  }

  // SPC専用(冒頭コメント参照)。opt.durationSecondsだけを使う。
  async function _runSpc(msg) {
    const sendRoll = makeRollSender('spc', msg);
    let lastSent = 0;
    const onProgress = (done, total, frameLog) => {
      if (done <= lastSent) return;
      global.postMessage({ type: 'progress', done, total, start: lastSent, frames: frameLog.slice(lastSent, done) });
      lastSent = done;
      if (sendRoll) sendRoll({ frameLog }, done, total);
    };
    await MML.SPC2MML.captureAsync(msg.bytes, msg.opt.durationSeconds, onProgress,
      () => cancelled, { yieldFn: macroYield, sliceBudgetMs: WORKER_SLICE_MS });
    global.postMessage({ type: 'done', cancelled });
  }

  // HES専用(冒頭コメント参照)。regsOnly前提(client側でperChannelAudio等は弾く)。
  async function _runHes(msg) {
    const sendRoll = makeRollSender('hes', msg);
    let sentSnap = 0;
    const sentDpcm = [0, 0, 0, 0, 0, 0];
    const sentCtl  = [0, 0, 0, 0, 0, 0];
    let metaSent = false;
    const onProgress = (done, total, data) => {
      const chunk = {
        type: 'progress', done, total,
        snapStart: sentSnap,
        snapshots: data.snapshots.slice(sentSnap),
        dpcmTrace: [], controlTrace: []
      };
      sentSnap = data.snapshots.length;
      for (let c = 0; c < 6; c++) {
        // dpcmTraceは列ごとの型付き配列(Emu.HesTraceBuf)なので、列ごとに差分を切って送る
        chunk.dpcmTrace.push(data.dpcmTrace[c].slicePlain(sentDpcm[c]));
        sentDpcm[c] = data.dpcmTrace[c].length;
        chunk.controlTrace.push(data.controlTrace[c].slice(sentCtl[c]));
        sentCtl[c] = data.controlTrace[c].length;
      }
      if (!metaSent) { metaSent = true; chunk.frameRate = data.frameRate; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(data, done, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: WORKER_SLICE_MS
    });
    await Emu.captureHesSongAsync(msg.bytes, opt, onProgress);
    global.postMessage({ type: 'done', cancelled });
  }

  // PSF専用。msg.info = MML.PSF.load() の結果(_lib 解決はメインスレッドで済ませてから渡す)。
  // 差分: frameLog/snapshots はフレーム数、ramLog/samples は件数で切って送る。
  async function _runPsf(msg) {
    const sendRoll = makeRollSender('psf', msg);
    let sentFrames = 0, sentRam = 0, sentSamples = 0;
    let metaSent = false;
    const onProgress = (done, total, cap) => {
      const n = cap.frameLog.length;
      const chunk = {
        type: 'progress', done, total,
        frameStart: sentFrames,
        frameLog: cap.frameLog.slice(sentFrames, n),
        snapshots: cap.snapshots.slice(sentFrames, n),
        ramStart: sentRam, ramLog: cap.ramLog.slice(sentRam),
        sampleStart: sentSamples, samples: cap.samples.slice(sentSamples),
      };
      sentFrames = n; sentRam = cap.ramLog.length; sentSamples = cap.samples.length;
      if (!metaSent) { metaSent = true; chunk.meta = { frameRate: cap.frameRate, samplesPerFrame: cap.samplesPerFrame, totalFrames: cap.totalFrames }; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(cap, n, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: WORKER_SLICE_MS
    });
    const cap = await Emu.capturePsfSongAsync(msg.info, opt, onProgress);
    global.postMessage({ type: 'done', cancelled, bios: cap.bios });
  }

  global.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { cancelled = true; return; }
    if (msg.cmd !== 'capture') return;

    if (msg.format === 'hes') {
      if (typeof Emu.captureHesSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: hes' });
        return;
      }
      cancelled = false;
      try { await _runHes(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'psf') {
      if (typeof Emu.capturePsfSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: psf' });
        return;
      }
      cancelled = false;
      try { await _runPsf(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'spc') {
      if (!MML.SPC2MML || typeof MML.SPC2MML.captureAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: spc' });
        return;
      }
      cancelled = false;
      try { await _runSpc(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    const run = FORMATS[msg.format];
    if (!run || typeof (msg.format === 'kss' ? Emu.captureKssSongAsync
                       : msg.format === 'gbs' ? Emu.captureGbsSongAsync
                       : Emu.captureVgmSongAsync) !== 'function') {
      global.postMessage({ type: 'error', message: 'unsupported format in this bundle: ' + msg.format });
      return;
    }

    cancelled = false;
    const opt = Object.assign({}, msg.opt, {
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: msg.format === 'vgm' ? WORKER_SLICE_MS_VGM : WORKER_SLICE_MS
    });

    // VGMだけ、送ったデータの大きさに応じて次の解析を少し待つ。PCMプール系の曲は1通の複製が重く、
    // 解析が速すぎると画面側が受信の復元で埋まって、解析が終わるまで音と描画が詰まる(2026-09-13実測、
    // ワルキューレの伝説3曲目で最初の1秒に復元650ms)。postMessage に掛かった時間(=複製の手間の目安)の
    // PACE_RATIO 倍だけ待ち、画面側の受信を時間方向に薄める。軽い曲では待ち時間はほぼ0になる
    const PACE_RATIO = msg.format === 'vgm' ? 3 : 0;
    const PACE_MAX_MS = 120;
    let paceMs = 0;
    opt.yieldFn = () => {
      if (paceMs <= 0) return macroYield();
      const ms = paceMs; paceMs = 0;
      return new Promise((resolve) => setTimeout(resolve, ms));
    };
    const sendRoll = makeRollSender(msg.format, msg);
    const sent = {};
    let metaSent = false;
    let lastPayload = null;
    const onProgress = (done, total, payload) => {
      lastPayload = payload;
      const { arrays, meta } = diffPayload(payload, sent, !metaSent);
      const chunk = { type: 'progress', done, total, arrays };
      if (!metaSent) { metaSent = true; chunk.meta = meta; }
      const tPost = performance.now();
      global.postMessage(chunk);
      if (PACE_RATIO > 0 && done < total) paceMs = Math.min(PACE_MAX_MS, (performance.now() - tPost) * PACE_RATIO);
      if (sendRoll) sendRoll(payload, done, total);
    };

    try {
      await run(msg.bytes, opt, onProgress);
      // キャプチャ完了後に追加された非配列プロパティ(VGMのnes.dpcmRom等)を最終メタで拾う
      const doneMsg = { type: 'done', cancelled };
      if (lastPayload) doneMsg.finalMeta = diffPayload(lastPayload, sent, true).meta;
      global.postMessage(doneMsg);
    } catch (err) {
      global.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  };
})(window);
