/*
 * OPN系FM(YM2612/YM2610)と YM2610 ADPCM-A/B(VGM) → MML共通イベント形式 抽出
 *   MML.Vgm2MmlExpansion.opn(snapshots, numCh)   → { channels: [numCh] }
 *   MML.Vgm2MmlExpansion.adpcm(snapshots)         → { a: [6], b: channel }
 *
 * 入力の snapshots は captureVgmSongAsync(src/emulator/vgmPlayer.js)がフレーム(1/60秒)ごとに積む
 *   Emu.snapshotYM2612 / Emu.snapshotYM2610 の結果:
 *   channels[i] = { freq(キャリアop4のHz), keyOn, tlVol, patch:{AL,FB,ops[4]{TL,…}} , … }
 *     ★先読みキャプチャはチップのclock()を回さないため EG は進まない。発音判定は keyOn、音量は
 *       レジスタ(TL)だけから決める(vgmPlayer.js の差し替えと同じ方針)。
 *   adpcmA[i]/adpcmB = { active(推定発音区間), pitchHz, pitchConf, vol, rawVol, seq, waveData, … }
 *     (ym2610.js samplePitch: ROM上のサンプルの基本周期解析 × 再生レート。conf<0.5 は音程なし=休符)
 *
 * イベントは借用先に依存しない形で出す:
 *   note     : 57+12*log2(f/440)(kss2mml/nsf2mml と同じノート番号体系)
 *   attDb    : 減衰量(dB、0=最大)。借用先ファミリごとの音量値への写像は vgm2mml/converter.js
 *              adaptEvents が行う(VRC7=3dB/段のレジスタ減衰値(0が最大。MMLへは mmlEmit が v=15-値 で書く)、
 *              FME-7=3dB/段(v15最大)、2A03/MMC5/VRC6/N163=線形)。volume には VRC7 向けの既定値(round(attDb/3))を入れておく
 *   retrigger: FM=キーオンの立ち上がり、ADPCM=キーオン通番(seq)の変化
 *   rawFreq  : 音程補正(detectChorusDetune)用の生周波数
 *   n163Wave : (ADPCMのみ)サンプルの1周期波形を N163 用 32点4bit にしたもの(借用先がN163のとき音色に)
 * FMの音量: アルゴリズムのキャリアop(最終段)のうち最小TL × 0.75dB(複数キャリアの加算は無視)。
 * ADPCM-A: (IL^0x1f)+(TL^0x3f) × 0.75dB(ymfmの音量計算と同じ単位)。ADPCM-B: -20log10(level/255)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Vgm2MmlExpansion = MML.Vgm2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (!(freq > 0)) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }
  const CARRIER_OPS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  const ADPCM_PITCH_CONF = 0.5; // keyboard.js と同じしきい値

  function fmAttDb(patch) {
    if (!patch || !patch.ops) return 0;
    let minTl = 127;
    for (const op of CARRIER_OPS[patch.AL & 7]) minTl = Math.min(minTl, patch.ops[op].TL);
    return minTl * 0.75;
  }
  const vrc7Vol = (att) => Math.max(0, Math.min(15, Math.round(att / 3)));
  // 音色の同一性キー(全パラメータ。モジュレータTLも音色なので含める=VRC7自作音色への変換結果が変わる単位)
  // ★keepSeq(音量エンベロープを作るモード)のときはキャリアopのTLだけ外す。キャリアTLは
  //   音色ではなく「そのchの音量」そのもの(fmAttDbが同じ値を読んでいる)で、ドライバが
  //   TLを書き換えて音量を作る曲ではここが変わるたびにイベントが切れ、音量が動く音符が
  //   細切れの定数音量になってしまう(=@v/EP/MPの材料が作れない)
  function patchKey(p, keepSeq) {
    if (!p || !p.ops) return '';
    const carriers = keepSeq ? CARRIER_OPS[p.AL & 7] : [];
    return p.AL + '/' + p.FB + '/' + p.AMS + '/' + p.PMS + '/' + p.ops.map((o, i) => [o.DT, o.ML, carriers.indexOf(i) >= 0 ? 'v' : o.TL, o.KS, o.AR, o.DR, o.SR, o.SL, o.RR, o.AM, o.SE].join('.')).join('|');
  }

  // 連続フレームを同一イベントにまとめる共通ループ。frameState(f) → {note, attDb, retrigger, rawFreq, extra}
  // 戻り値: { events, attByFrame, freqByFrame }
  // opts.envelope(変換設定のENV): true なら音量(attDb)の変化だけではイベントを切らず、
  //   フレームごとの音量/周波数を控える。ここで切ると音量が動く音符が細切れの定数音量イベントに
  //   なり、@v(音量エンベロープ)にも EP/MP/PT(ピッチ変調)にもできない。切らずに列で持てば
  //   sn76489.js の volSeq/pitchSeq と同じ土俵に乗る。falseなら従来どおり(定数音量で分割)。
  function collect(totalFrames, frameState, opts) {
    const keepSeq = !!(opts && opts.envelope);
    const events = [];
    const attByFrame = keepSeq ? new Array(totalFrames).fill(0) : null;
    const freqByFrame = keepSeq ? new Array(totalFrames).fill(0) : null;
    let cur = null;
    const flush = (end) => { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } };
    for (let f = 0; f < totalFrames; f++) {
      const st = frameState(f);
      if (keepSeq) {
        attByFrame[f] = st.attDb;
        freqByFrame[f] = (st.note !== null && st.rawFreq > 0) ? st.rawFreq : 0;
      }
      const same = cur && !st.retrigger && st.note === cur.note && (keepSeq || st.attDb === cur.attDb) && (st.key || '') === (cur.key || '');
      if (same) continue;
      flush(f);
      cur = { start: f, end: f, note: st.note, attDb: st.attDb, retrigger: !!st.retrigger, key: st.key,
        rawFreq: st.note !== null ? st.rawFreq : undefined, n163Wave: st.n163Wave, opnPatch: st.opnPatch };
    }
    flush(totalFrames);
    return { events, attByFrame, freqByFrame };
  }

  // 音符区間ぶんの音量列/周波数列をイベントへ付ける(ev.attSeq / ev.freqSeq)。
  // ★必ずビブラート/高速アルペジオの統合(mergeVibratoAndArpeggio)の後に呼ぶこと。
  //   抽出時に持たせると、統合で作り直されたイベントの長さと列の長さがずれて
  //   @vの表が音符の長さと合わなくなる。最終的な start/end で切り出せば必ず一致する。
  // attSeq は減衰dBのまま(借用先の音量値への写像は converter.js adaptGroup が行う)。
  // freqSeq は Hz(assignPitchEnvelope が periodFn で借用先の生周期へ直す)。
  function withSeq(events, frames, opts) {
    if (!frames || !frames.attByFrame) return events;
    const noFreq = !!(opts && opts.noFreq);
    for (const ev of events) {
      if (ev.note === null || ev.end - ev.start < 2) continue;
      const att = frames.attByFrame.slice(ev.start, ev.end);
      if (att.some(a => a !== att[0])) ev.attSeq = att;
      if (noFreq) continue;
      const fq = frames.freqByFrame.slice(ev.start, ev.end);
      if (!(fq[0] > 0)) continue;
      // 途中の0(無音フレーム)は直前の値で埋める。音程が動いた区間だけ列として残す
      let last = fq[0], moved = false;
      for (let i = 0; i < fq.length; i++) { if (fq[i] > 0) last = fq[i]; else fq[i] = last; if (fq[i] !== fq[0]) moved = true; }
      if (moved) ev.freqSeq = fq;
    }
    return events;
  }

  // ── 曲・チップ単位の音量正規化(2026-09-17、ユーザー指示の案A)────────────────
  // attDb は「そのチップのフルスケールからの減衰量」。借用先へは振幅比で写す
  // (borrow.js VOL_FROM_DB.linear = max * 10^(-att/20))ので、**元チップが自分の
  // フルスケールまで振らないと借用先のレンジ上位が永久に使われない**。
  // 実測(2026-09-17): K054539 は8ch合成のヘッドルームぶん常時10dB以上絞っており、
  //   沙羅曼蛇2/リーサルエンフォーサーズとも減衰の最小が10.1dB・中央20dB前後。
  //   絶対値のまま写すと v は 1-8 に張り付き、沙羅曼蛇2は24曲中13曲が v8 止まりだった。
  //   比較: C140(ワルキューレ)は最小3.1dB→v1-10、QSoundは最小1.8dB→v1-12とレンジを
  //   使えている。つまり式ではなく「絶対値で写す」設計がヘッドルームを持つチップに
  //   合っていない。
  // そこで**その曲・そのチップで一番小さい減衰を0dBへ寄せる**。曲内の強弱(相対値)は
  // そのまま保たれる。★曲間の絶対的な音量差は失われるので、これは変換専用の処理
  // (エミュレーション再生は borrow.js を参照しないので無関係)。
  // ★基準は最小値そのものではなく**下位1%点**。一瞬だけフルスケール近くまで鳴る音が
  //   1つあるだけで正規化が効かなくなるのを避ける。
  // ★チャンネル単位ではなく**チップ単位**。ch毎に正規化すると各パートが均されて
  //   曲としての音量バランス(主旋律と伴奏の差)が壊れる。
  const VOL_NORM_PCT = 0.01;   // 基準に使う分位点(下位1%)
  const VOL_NORM_MIN_DB = 0.5; // これ未満のシフトは誤差なので触らない
  const VOL_NORM_MIN_N = 8;    // 標本がこれ未満なら触らない(単発の効果音など)
  // ★基準は**イベントではなくスナップショットから**求める。音階側(pcmChannels)とドラム側
  //   (drumChannelOf)は呼び出しが別なので、イベントから各々求めると基準がズレて両者の相対
  //   バランスが崩れる。同じ snapshots を見れば必ず同じ値になる。
  //   「割当先の音で聴く」プレビュー(assign-preview.js)も同じ関数を通すので、変換と食い違わない。
  //   ADPCM-A のようにフレームが配列でない形(fr.adpcmA)は対象外=基準0(実測でも最小0.0dBで不要)。
  const attRefCache = new WeakMap();
  function attRefOfSnapshots(snapshots) {
    if (!snapshots || !snapshots.length) return 0;
    const hit = attRefCache.get(snapshots);
    if (hit !== undefined) return hit;
    const all = [];
    for (const fr of snapshots) {
      if (!fr || typeof fr.length !== 'number') continue;
      for (const c of fr) if (c && c.active && c.vol > 0) all.push(Math.min(96, -20 * Math.log10(c.vol)));
    }
    let ref = 0;
    if (all.length >= VOL_NORM_MIN_N) {
      all.sort((a, b) => a - b);
      const r = all[Math.floor(all.length * VOL_NORM_PCT)];
      if (r > VOL_NORM_MIN_DB) ref = r;
    }
    attRefCache.set(snapshots, ref);
    return ref;
  }
  MML.Vgm2MmlExpansion.attRefOfSnapshots = attRefOfSnapshots;

  function toCommon(ev) {
    const out = { start: ev.start, end: ev.end, note: ev.note, volume: vrc7Vol(ev.attDb), attDb: ev.attDb, retrigger: ev.retrigger };
    if (ev.note !== null && ev.rawFreq != null) out.rawFreq = ev.rawFreq;
    if (ev.n163Wave) out.n163Wave = ev.n163Wave;
    if (ev.opnPatch) out.opnPatch = ev.opnPatch; // 借用先VRC7の自作音色(4op→2op自動変換)用
    if (ev.sampleHash) out.sampleHash = ev.sampleHash; // 音色の同定(src/convert/toneKey.js、サンプルPCM)
    if (ev.noteEnvOffsets) out.noteEnvOffsets = ev.noteEnvOffsets;
    return out;
  }

  /** OPN FM: snapshots[f].channels[ch] */
  MML.Vgm2MmlExpansion.opn = function (snapshots, numCh, opts) {
    const total = snapshots.length;
    const channels = [];
    for (let ch = 0; ch < numCh; ch++) {
      let prevKey = false;
      const r = collect(total, (f) => {
        const s = snapshots[f] && snapshots[f].channels ? snapshots[f].channels[ch] : null;
        if (!s) { prevKey = false; return { note: null, attDb: 0 }; }
        const on = !!s.keyOn && s.freq > 0;
        const retrigger = on && !prevKey;
        prevKey = !!s.keyOn;
        if (!on) return { note: null, attDb: 0 };
        const att = fmAttDb(s.patch);
        // key: 音色パラメータが変わったら別イベント(VRC7自作音色への変換結果が変わるため)
        return { note: freqToNoteNumber(s.freq), attDb: att, retrigger, rawFreq: s.freq, opnPatch: s.patch, key: patchKey(s.patch, !!(opts && opts.envelope)) };
      }, opts);
      channels.push({ events: withSeq(MML.Convert.mergeVibratoAndArpeggio(r.events).map(toCommon), r), hasVolume: true, hasInstrument: true });
    }
    return { channels };
  };

  // サンプルの1周期波形(128点±1) → N163用32点4bit(0-15)
  function toN163Wave(waveData) {
    if (!waveData || !waveData.length) return null;
    const N = 32, out = new Array(N);
    for (let i = 0; i < N; i++) {
      const pos = i * waveData.length / N;
      const a = waveData[Math.floor(pos)] || 0;
      out[i] = Math.max(0, Math.min(15, Math.round((a + 1) / 2 * 15)));
    }
    return out;
  }
  // ── 打楽器(ピッチ解析が通らなかったサンプル発音)の音符化 ────────────────
  // 音程レジスタで音階演奏していないサンプル(ドラム/効果音)は絶対音程を持たないので、
  // 「1サンプル=1レーン=1音程」のドラムマップ(src/convert/drumMap.js)で疑似音程を与える。
  // ピアノロールのドラム区画と同じ表を使うので、ロールで見た太鼓とMMLに出た音符が一致する
  // ([[roll-as-mml-debugger]])。drumMapが無ければ従来どおり休符。
  //  ・rawFreqは付けない: 実周波数ではないのでデチューン補正/ビブラート統合の対象外にする
  //    (mergeRapidArpeggioはrawFreq無しで素通り、mergeAlternatingVibratoはpitchSeq無しで素通り)
  //  ・key: レーンごとに変えて、別の太鼓へ移ったところで必ずイベントが切れるようにする
  function drumState(c, retrigger, drumMap) {
    const DrumMap = MML.Convert && MML.Convert.DrumMap;
    if (!drumMap || !DrumMap || !c.active || !c.sample) return { note: null, attDb: 0 };
    const k = DrumMap.key(c.sample);
    const lane = drumMap.laneOf.has(k) ? drumMap.laneOf.get(k) : drumMap.otherLane;
    const note = DrumMap.noteOf(lane);
    if (note === null) return { note: null, attDb: 0 };
    const att = c.vol > 0 ? Math.min(96, -20 * Math.log10(c.vol)) : 96;
    return { note, attDb: att, retrigger, key: 'drum' + lane };
  }

  // ドラムマップを組むための観測列。ドラムマップは曲全体で1つなので、
  // 全サンプルチップぶんを converter.js が集めてから DrumMap.build する。
  // getCh(f) はそのフレームのチャンネル状態(無ければnull)。
  function drumObs(total, frameDur, getCh, out) {
    const DrumMap = MML.Convert && MML.Convert.DrumMap;
    if (!DrumMap) return out;
    let prevSeq = null;
    for (let f = 0; f < total; f++) {
      const c = getCh(f);
      if (!c) { prevSeq = null; continue; }
      const isKeyOn = c.seq !== prevSeq && c.seq > 0;
      prevSeq = c.seq;
      if (!isKeyOn || !c.active || !c.sample) continue;
      if (c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0) continue; // 音程が取れた=打楽器扱いしない
      out.push({ key: DrumMap.key(c.sample), sec: f * frameDur });
    }
    return out;
  }

  /**
   * サンプルPCMチップのスナップショット列から打楽器の観測列を集める(converter.js用)。
   * kind: 'pcm'(snapshots[f][ch]) / 'adpcmA'(snapshots[f].adpcmA[ch])
   */
  MML.Vgm2MmlExpansion.collectDrumObs = function (snapshots, numCh, frameDur, kind, out) {
    const total = snapshots.length;
    const res = out || [];
    for (let ch = 0; ch < numCh; ch++) {
      drumObs(total, frameDur, (f) => {
        const s = snapshots[f];
        if (!s) return null;
        return kind === 'adpcmA' ? (s.adpcmA && s.adpcmA[ch]) : s[ch];
      }, res);
    }
    return res;
  };

  /**
   * サンプルPCMチップの打楽器を「1本のドラムパート」にまとめる。
   *
   * なぜスロットごとに出さないか(★設計の要点):
   *   プール式チップ(C140/C352/QSound/MultiPCM)はドライバがスロットを巡回割当するので、
   *   1組のドラムキットが実機上は何本ものスロットへ散る(実測: Dragon Saber の C140 は
   *   8種類の太鼓が7スロットにまたがっていた)。スロットごとに音符を出すと、借用先の枠
   *   (N163 8ch等)をドラムだけで食い潰してメロディが落ちる。曲としては「ドラム=1パート」
   *   なので、ここで1本へ束ね直す。
   *
   * MMLパートは単音なので、同時に鳴っている打点は1つに絞る: 直近に叩かれたものを採る
   * (新しい打点が前の打点を切る = 実際のドラムパートの読み方と同じ)。
   *
   * getCh(f, ch) はそのフレーム・そのチャンネルの状態(無ければnull)。
   * attOf(c) は減衰量(dB)。省略時は振幅比 c.vol から求める。
   */
  const DRUM_PEAK_LOOKAHEAD = 3; // 打点の音量を決めるとき先読みするフレーム数
  function drumChannelOf(total, numCh, drumMap, getCh, attOf, attRef) {
    const ref = attRef || 0;
    const lastOn = new Array(numCh).fill(-1);   // ch → 最後にキーオンされたフレーム
    const prevSeq = new Array(numCh).fill(null);
    let prevPick = -1;
    let curAtt = 0;   // いま鳴っている打点の音量(打点の途中では変えない。下のコメント参照)
    const attOfCh0 = attOf || ((ch) => (ch.vol > 0 ? Math.min(96, -20 * Math.log10(ch.vol)) : 96));
    const attOfCh = (ch) => Math.max(0, attOfCh0(ch) - ref);
    const { events } = collect(total, (f) => {
      let bestCh = -1, bestOn = -1;
      for (let ch = 0; ch < numCh; ch++) {
        const c = getCh(f, ch);
        if (!c) { prevSeq[ch] = null; continue; }
        if (c.seq !== prevSeq[ch] && c.seq > 0) lastOn[ch] = f;
        prevSeq[ch] = c.seq;
        if (!c.active || !c.sample) continue;
        if (c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0) continue; // 音程が取れた=打楽器でない
        if (lastOn[ch] > bestOn) { bestOn = lastOn[ch]; bestCh = ch; }
      }
      if (bestCh < 0) { prevPick = -1; return { note: null, attDb: 0 }; }
      const c = getCh(f, bestCh);
      const st = drumState(c, false, drumMap);
      if (st.note === null) { prevPick = -1; return st; }
      // このフレームで叩き直された、または別スロットの打点へ移った = 打ち直し
      st.retrigger = (bestOn === f) || (prevPick !== bestCh);
      // ★打点1つの中では音量を変えない。サンプル自身の減衰(や、キーオンと音量書き込みが
      //   1フレームずれるドライバ)を「演奏された音量変化」として拾うと、1フレームだけの
      //   微小イベントに刻まれて 192分音符だらけの読めない譜面になる。打点の頭で数フレーム
      //   先読みして一番大きい値(=velocity)を採り、その打点が終わるまで保持する。
      if (st.retrigger || prevPick !== bestCh) {
        curAtt = attOfCh(c);
        for (let k = 1; k <= DRUM_PEAK_LOOKAHEAD && f + k < total; k++) {
          const cn = getCh(f + k, bestCh);
          if (!cn || !cn.active || cn.seq !== c.seq) break; // 次の打点まで来たら打ち切る
          curAtt = Math.min(curAtt, attOfCh(cn));
        }
      }
      st.attDb = curAtt;
      prevPick = bestCh;
      return st;
    });
    // ドラムパートも音階側と同じ基準(attRefOfSnapshots)で正規化済み(上の attOfCh)。実測の減衰の
    // 最小は沙羅曼蛇2=10.1dB / Haunted Castle=8.0dB / Lethal=11.3dB で、音階側と同じく
    // 借用先のレンジ上位が使えていなかった(ドラム行にも v は出る: `D l16 v5 o1 e v7 ffe ...`)。
    return { events: events.map(toCommon), hasVolume: true };
  }

  /**
   * ドラムパート1本を返す(converter.js用)。kind: 'pcm' / 'adpcmA'。
   * drumMapが無ければ空チャンネル(従来と同じ=何も出ない)。
   */
  MML.Vgm2MmlExpansion.drumChannel = function (snapshots, numCh, drumMap, kind, attOf, chans) {
    if (!drumMap) return { events: [], hasVolume: true };
    const use = chans || null; // 省略時は全ch。DPCMへ載せたchを外すために使う
    const getCh = (f, ch) => {
      if (use && use.indexOf(ch) < 0) return null;
      const s = snapshots[f];
      if (!s) return null;
      return kind === 'adpcmA' ? (s.adpcmA && s.adpcmA[ch]) : s[ch];
    };
    return drumChannelOf(snapshots.length, numCh, drumMap, getCh, attOf || null, attRefOfSnapshots(snapshots));
  };

  const waveCache = new WeakMap(); // waveData配列 → 32点(同じサンプルの再変換を避ける)
  function n163WaveOf(c) {
    if (!c.waveData) return null;
    let w = waveCache.get(c.waveData);
    if (!w) { w = toN163Wave(c.waveData); waveCache.set(c.waveData, w); }
    return w;
  }

  /**
   * 汎用PCMチップ抽出(GA20 4ch / SegaPCM 16ch): snapshots[f][ch] は
   * Emu.snapshotGA20 / Emu.snapshotSegaPCM の配列(ADPCMと同じ pitchHz/pitchConf/seq/vol)。
   * どちらもレート(デルタ)レジスタで1サンプルを音階演奏するチップなので、
   * ピッチ解析が信頼できる区間はADPCM-Bと同様に絶対音程の音符になる。
   * 音量: vol は振幅比(0..1)なので attDb = -20*log10(vol)。
   */
  function pcmChannels(snapshots, numCh, opts) {
    const total = snapshots.length;
    const attRef = attRefOfSnapshots(snapshots); // 曲・チップ単位の基準(上のコメント参照)
    const raws = [];
    for (let chIdx = 0; chIdx < numCh; chIdx++) {
      let prevSeq = null;
      const r = collect(total, (f) => {
        const c = snapshots[f] ? snapshots[f][chIdx] : null;
        if (!c) return { note: null, attDb: 0 };
        const retrigger = c.seq !== prevSeq && c.seq > 0;
        prevSeq = c.seq;
        const pitched = c.active && c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        // 音程が取れなかったサンプル(ドラム/効果音)はここでは休符のまま。まとめて
        // 1本のドラムパートへ出す(drumChannelOf参照)ので、スロット側にも出すと二重になる
        if (!pitched) return { note: null, attDb: 0 };
        const att = c.vol > 0 ? Math.max(0, Math.min(96, -20 * Math.log10(c.vol)) - attRef) : 96;
        return { note: freqToNoteNumber(c.pitchHz), attDb: att, retrigger, rawFreq: c.pitchHz,
          n163Wave: n163WaveOf(c), sampleHash: c.sampleHash || undefined, key: String(c.sample ? c.sample.start : '') };
      }, opts);
      raws.push(r);
    }
    const channels = raws.map((r) =>
      ({ events: withSeq(MML.Convert.mergeVibratoAndArpeggio(r.events).map(toCommon), r), hasVolume: true, hasInstrument: true }));
    return { channels };
  }
  MML.Vgm2MmlExpansion.ga20 = (snapshots, drumMap, opts) => pcmChannels(snapshots, 4, opts);
  MML.Vgm2MmlExpansion.k007232 = (snapshots, drumMap, opts) => pcmChannels(snapshots, 2, opts);
  // ★ch数はスナップショットの幅から決める(デュアルは16)。呼び出し口が複数あり(既定割当の
  //   並べ替えは引数なしで呼ぶ)、片方だけ8のままだと channels[8..15] が undefined になる。
  MML.Vgm2MmlExpansion.k054539 = (snapshots, drumMap, opts) =>
    pcmChannels(snapshots, ((snapshots && snapshots[0] && snapshots[0].length) >= 16) ? 16 : 8, opts);
  MML.Vgm2MmlExpansion.segapcm = (snapshots, drumMap, opts) => pcmChannels(snapshots, 16, opts);
  MML.Vgm2MmlExpansion.c140 = (snapshots, drumMap, opts) => pcmChannels(snapshots, 24, opts);
  MML.Vgm2MmlExpansion.c352 = (snapshots, drumMap, opts) => pcmChannels(snapshots, 32, opts);
  MML.Vgm2MmlExpansion.qsound = (snapshots, drumMap, opts) => pcmChannels(snapshots, 16, opts);
  MML.Vgm2MmlExpansion.okim6295 = (snapshots, drumMap, opts) => pcmChannels(snapshots, 4, opts);
  MML.Vgm2MmlExpansion.multipcm = (snapshots, drumMap, opts) => pcmChannels(snapshots, 28, opts);
  // PSF(PlayStation SPU、24ボイス)。スナップショットは Emu.snapshotPsx が C352 と同じ形で作る(src/psf2mml/converter.js)
  // 合成chは32本(Emu.POOL_CHIP_CHANNELS.psx)。実機スロットのスナップショットは24要素なので残りは休符。
  // トラックモード(Emu.PsfTrackVoicer)はレーン数が曲で決まり、キャプチャが進むほど増えるので最大幅まで取る
  MML.Vgm2MmlExpansion.psx = (snapshots, drumMap, opts) => {
    let n = 32;
    for (const s of snapshots) if (s && s.length > n) n = s.length;
    return pcmChannels(snapshots, n, opts);
  };

  /** YM2610 ADPCM-A(6ch)/ADPCM-B: snapshots[f].adpcmA[i] / .adpcmB */
  MML.Vgm2MmlExpansion.adpcm = function (snapshots, drumMap, opts) {
    const total = snapshots.length;
    const one = (get, attOf) => {
      let prevSeq = null;
      const r = collect(total, (f) => {
        const c = snapshots[f] ? get(snapshots[f]) : null;
        if (!c) return { note: null, attDb: 0 };
        const retrigger = c.seq !== prevSeq && c.seq > 0;
        prevSeq = c.seq;
        const pitched = c.active && c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        // 音程なし(ADPCM-Aのドラム等)はここでは休符。ドラムパート側で拾う(drumChannelOf参照)
        if (!pitched) return { note: null, attDb: 0 };
        // key: 同じ音程でもサンプル(波形)が変われば別イベント(N163の音色が変わる)
        const w = n163WaveOf(c);
        return { note: freqToNoteNumber(c.pitchHz), attDb: attOf(c), retrigger, rawFreq: c.pitchHz, n163Wave: w, sampleHash: c.sampleHash || undefined, key: c.seq !== undefined ? String(c.sample ? c.sample.start : '') : '' };
      }, opts);
      return { events: withSeq(MML.Convert.mergeVibratoAndArpeggio(r.events).map(toCommon), r), hasVolume: true, hasInstrument: true };
    };
    // ADPCM-A: vol は snapshot 側で 1-att/63(0.75dB単位63段) にしてあるので逆算
    const attA = (c) => Math.max(0, (1 - c.vol) * 63 * 0.75);
    const attB = (c) => c.rawVol > 0 ? -20 * Math.log10(c.rawVol / 255) : 96;
    const a = [];
    for (let i = 0; i < 6; i++) a.push(one((s) => s.adpcmA && s.adpcmA[i], attA));
    const b = one((s) => s.adpcmB, attB);
    return { a, b };
  };
})(window);
