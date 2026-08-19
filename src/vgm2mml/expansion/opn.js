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
 *              adaptEvents が行う(VRC7=3dB/段(v0が最大・反転)、FME-7=3dB/段(v15最大)、
 *              2A03/MMC5/VRC6/N163=線形)。volume には VRC7 向けの既定値(round(attDb/3))を入れておく
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
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
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

  // 連続フレームを同一イベントにまとめる共通ループ。frameState(f) → {note, attDb, retrigger, rawFreq, extra}
  function collect(totalFrames, frameState) {
    const events = [];
    let cur = null;
    const flush = (end) => { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } };
    for (let f = 0; f < totalFrames; f++) {
      const st = frameState(f);
      const same = cur && !st.retrigger && st.note === cur.note && st.attDb === cur.attDb && (st.key || '') === (cur.key || '');
      if (same) continue;
      flush(f);
      cur = { start: f, end: f, note: st.note, attDb: st.attDb, retrigger: !!st.retrigger, key: st.key,
        rawFreq: st.note !== null ? st.rawFreq : undefined, n163Wave: st.n163Wave };
    }
    flush(totalFrames);
    return events;
  }

  function toCommon(ev) {
    const out = { start: ev.start, end: ev.end, note: ev.note, volume: vrc7Vol(ev.attDb), attDb: ev.attDb, retrigger: ev.retrigger };
    if (ev.note !== null && ev.rawFreq != null) out.rawFreq = ev.rawFreq;
    if (ev.n163Wave) out.n163Wave = ev.n163Wave;
    if (ev.noteEnvOffsets) out.noteEnvOffsets = ev.noteEnvOffsets;
    return out;
  }

  /** OPN FM: snapshots[f].channels[ch] */
  MML.Vgm2MmlExpansion.opn = function (snapshots, numCh) {
    const total = snapshots.length;
    const channels = [];
    for (let ch = 0; ch < numCh; ch++) {
      let prevKey = false;
      const events = collect(total, (f) => {
        const s = snapshots[f] && snapshots[f].channels ? snapshots[f].channels[ch] : null;
        if (!s) { prevKey = false; return { note: null, attDb: 0 }; }
        const on = !!s.keyOn && s.freq > 0;
        const retrigger = on && !prevKey;
        prevKey = !!s.keyOn;
        if (!on) return { note: null, attDb: 0 };
        const att = fmAttDb(s.patch);
        return { note: freqToNoteNumber(s.freq), attDb: att, retrigger, rawFreq: s.freq };
      });
      channels.push({ events: MML.Convert.mergeVibratoAndArpeggio(events).map(toCommon), hasVolume: true, hasInstrument: true });
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
  const waveCache = new WeakMap(); // waveData配列 → 32点(同じサンプルの再変換を避ける)
  function n163WaveOf(c) {
    if (!c.waveData) return null;
    let w = waveCache.get(c.waveData);
    if (!w) { w = toN163Wave(c.waveData); waveCache.set(c.waveData, w); }
    return w;
  }

  /** YM2610 ADPCM-A(6ch)/ADPCM-B: snapshots[f].adpcmA[i] / .adpcmB */
  MML.Vgm2MmlExpansion.adpcm = function (snapshots) {
    const total = snapshots.length;
    const one = (get, attOf) => {
      let prevSeq = null;
      const events = collect(total, (f) => {
        const c = snapshots[f] ? get(snapshots[f]) : null;
        if (!c) return { note: null, attDb: 0 };
        const retrigger = c.seq !== prevSeq && c.seq > 0;
        prevSeq = c.seq;
        const pitched = c.active && c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        if (!pitched) return { note: null, attDb: 0 };
        // key: 同じ音程でもサンプル(波形)が変われば別イベント(N163の音色が変わる)
        const w = n163WaveOf(c);
        return { note: freqToNoteNumber(c.pitchHz), attDb: attOf(c), retrigger, rawFreq: c.pitchHz, n163Wave: w, key: c.seq !== undefined ? String(c.sample ? c.sample.start : '') : '' };
      });
      return { events: MML.Convert.mergeVibratoAndArpeggio(events).map(toCommon), hasVolume: true, hasInstrument: true };
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
