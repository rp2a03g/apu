/*
 * ピッチのフレーム列 → 音符列 (MML.Input.NoteSegment) — コア層
 *
 * 聴音の二段目。src/input/pitchDetect.js のフレーム列 { t, f, rms, rmsShort } を
 * 音符 { startSec, endSec, midi, pitch } の列にし、TimedPitchEvent 列(DESIGN.md §3)として
 * src/input/quantize.js へ渡す。
 *
 * ■ 方式(2026-10-12、合成鼻歌 144 件・合成楽器 14 件で決めた)
 *   1. 5点メディアンで単発の跳び(オクターブ誤り等)を潰す
 *   2. Viterbi(状態=半音+無声)は**区切りを見つけるためだけ**に使う。σ を広く、乗り換えコストを
 *      高くして、ビブラートやスクープで状態が往復しないようにする
 *   3. 区間の音高は、頭の min(50ms, 30%) を捨てた残りの**メディアン**で決める。
 *      ★第1案(Viterbi の状態をそのまま音符にする)は、ビブラート 50 セント+音程ずれで半音の境目を
 *        またぐと d+16d16d+16… と交互に割れ、崩れた歌い方で精度 45% だった。メディアンで 91〜96%
 *   4. 丸めた音高が同じ隣接区間は結合(Viterbi 由来の分裂)
 *   5. 同一音高の連続は音量で再アタックに分ける。2種類:
 *        谷   … 10ms 窓の RMS が前後 100ms の最大より dipDb 下がって戻る(鼻歌の「ん・ん」)
 *        立ち上がり … 30ms 以内に riseDb 以上上がる(撥弦/打弦の弾き直し。減衰の途中からなので谷が無い)
 *   6. 発声の頭にある短い区間で、音高が次の区間へ向かって scoopMinMove 以上動いているものは
 *      スクープ(下から入る癖)として次へ畳む。★0.6 半音未満だとフレーズ頭の16分音符を食う
 *   7. minNoteSec 未満の音符は音高の近い隣へ吸収(孤立していれば捨てる)
 *   8. keySnap: 半音の境目 ±keySnapBand にいる音は、音高ヒストグラムから推定した長調音階に乗る側へ寄せる
 *
 * ■ 調整が効くこと
 *   人の声・楽器・マイクで最適値が違うので、しきい値は全部 opts で渡せる(UI では全部スライダー)。
 *   PRESETS に「声」「楽器」の出発点を置く。
 *
 * DOM 非依存。tools/headless/dictation-bench.js で合成音の回帰を取る。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  const DEFAULTS = Object.freeze({
    sigma: 0.6,          // 半音。発音の揺れの許容(Viterbi の放出コスト幅)
    switchCost: 15,      // 状態の乗り換えコスト(大きいほど音符が割れにくい)
    unvoicedCost: 2.5,   // 有声フレームを無声状態に置く/無声フレームを有声状態に置くコスト
    midiMin: 36,         // 探索する音域(MIDI)。声 36、楽器 24
    midiMax: 96,
    minNoteSec: 0.06,    // これ未満の音符は隣へ吸収
    dipDb: 5,            // 同音連打の「谷」(0 で切る)
    riseDb: 6,           // 弾き直しの「立ち上がり」(0 で切る)
    scoopMaxSec: 0.12,   // スクープとみなす最大の長さ(0 で切る)
    scoopMinMove: 0.6,   // 半音。スクープが次の音へ向かって動いた量の下限
    keySnap: true,       // 半音の境目を調へ寄せる
    keySnapBand: 0.2     // 境目とみなす幅(±半音)
  });

  /* 声/楽器の出発点。detect は pitchDetect.js の opts、segment はこのファイルの opts */
  const PRESETS = Object.freeze({
    voice:      { detect: { fmin: 70, fmax: 1100 }, segment: { midiMin: 36, scoopMaxSec: 0.12 } },
    instrument: { detect: { fmin: 40, fmax: 2100 }, segment: { midiMin: 24, scoopMaxSec: 0 } }
  });

  const MAJOR = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
  const toMidi = (f) => 69 + 12 * Math.log2(f / 440);

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[(s.length - 1) >> 1];
  }

  /*
   * 音符列から長調の調を推定する(音高ヒストグラム × 全音階マスク)。
   * 戻り値 { root(0=C), scale[12] } 。材料が無ければ null
   */
  function estimateKey(notes) {
    const hist = new Array(12).fill(0);
    let total = 0;
    for (const n of notes) { const w = Math.max(0.01, n.endSec - n.startSec); hist[((n.midi % 12) + 12) % 12] += w; total += w; }
    if (!total) return null;
    let best = -Infinity, root = 0;
    for (let r = 0; r < 12; r++) {
      let sc = 0;
      for (let i = 0; i < 12; i++) sc += hist[i] * (MAJOR[((i - r) % 12 + 12) % 12] ? 1 : -1);
      if (sc > best) { best = sc; root = r; }
    }
    return { root, scale: MAJOR.map((_, i) => MAJOR[((i - root) % 12 + 12) % 12]) };
  }

  /*
   * frames: pitchDetect.js の出力。opts: DEFAULTS を上書き。
   * 戻り値 { notes: [{ startSec, endSec, midi, pitch, onset }], key }
   *   pitch は丸める前の音高(MIDI、小数)。onset は区切りの理由 'voice'|'dip'|'rise'|'jump'
   */
  function segment(frames, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const n = frames.length;
    if (n < 3) return { notes: [], key: null };
    const hop = frames[1].t - frames[0].t;

    // 1) メディアン
    const m = new Array(n);
    for (let i = 0; i < n; i++) m[i] = frames[i].f ? toMidi(frames[i].f) : null;
    const med = m.slice();
    for (let i = 0; i < n; i++) {
      if (m[i] == null) continue;
      const w = [];
      for (let k = -2; k <= 2; k++) { const v = m[i + k]; if (v != null) w.push(v); }
      if (w.length >= 3) med[i] = median(w);
    }

    // 2) Viterbi
    const midiMin = Math.round(o.midiMin), midiMax = Math.max(midiMin + 12, Math.round(o.midiMax));
    const NS = midiMax - midiMin + 2, UNV = NS - 1;
    const cost = new Float64Array(NS), prev = new Float64Array(NS);
    const back = new Int16Array(n * NS);
    const inv2s2 = 1 / (2 * o.sigma * o.sigma);
    const sw = o.switchCost, swUnv = o.switchCost * 0.3;
    for (let i = 0; i < n; i++) {
      let gmin = Infinity, gidx = 0;
      for (let s = 0; s < NS; s++) if (cost[s] < gmin) { gmin = cost[s]; gidx = s; }
      const v = med[i];
      for (let s = 0; s < NS; s++) {
        const stay = cost[s];
        const swc = gmin + ((s === UNV || gidx === UNV) ? swUnv : sw);
        let bestc = stay, bp = s;
        if (swc < stay) { bestc = swc; bp = gidx; }
        let emit;
        if (s === UNV) emit = (v == null) ? 0 : o.unvoicedCost;
        else if (v == null) emit = o.unvoicedCost;
        else { const d = v - (midiMin + s); emit = Math.min(d * d * inv2s2, 12); }
        prev[s] = bestc + emit; back[i * NS + s] = bp;
      }
      cost.set(prev);
    }
    let s = 0; for (let k = 1; k < NS; k++) if (cost[k] < cost[s]) s = k;
    const path = new Int16Array(n);
    for (let i = n - 1; i >= 0; i--) { path[i] = s; s = back[i * NS + s]; }

    let segs = [];
    for (let i = 0; i < n;) {
      let j = i; while (j < n && path[j] === path[i]) j++;
      if (path[i] !== UNV) segs.push({ a: i, b: j, onset: (i === 0 || path[i - 1] === UNV) ? 'voice' : 'jump' });
      i = j;
    }

    // 3) 区間の音高 = 頭を捨てたメディアン
    const pitchOf = (sg) => {
      const len = sg.b - sg.a;
      const skip = Math.min(Math.round(0.05 / hop), Math.floor(len * 0.3));
      const w = [];
      for (let i = sg.a + skip; i < sg.b; i++) if (med[i] != null) w.push(med[i]);
      if (!w.length) for (let i = sg.a; i < sg.b; i++) if (med[i] != null) w.push(med[i]);
      return median(w);
    };
    for (const sg of segs) sg.pitch = pitchOf(sg);
    segs = segs.filter(sg => sg.pitch != null);
    for (const sg of segs) sg.midi = Math.round(sg.pitch);

    // 4) 同音高の隣接区間を結合(間が 20ms 以内)
    segs = mergeSame(segs, hop);

    // 5) 同音高の再アタック(谷 / 立ち上がり)
    const rms = frames.map(p => (p.rmsShort != null ? p.rmsShort : p.rms));
    const look = Math.max(2, Math.round(0.1 / hop));
    const riseWin = Math.max(1, Math.round(0.03 / hop));
    const split = [];
    for (const sg of segs) {
      let a = sg.a, aReason = sg.onset;
      for (let i = sg.a + look; i < sg.b - look; i++) {
        let lmax = -Infinity, rmax = -Infinity, isMin = true;
        for (let k = 1; k <= look; k++) {
          lmax = Math.max(lmax, rms[i - k]); rmax = Math.max(rmax, rms[i + k]);
          if (rms[i - k] < rms[i] || rms[i + k] < rms[i]) isMin = false;
        }
        const dip = o.dipDb > 0 && isMin && lmax - rms[i] >= o.dipDb && rmax - rms[i] >= o.dipDb;
        let rise = false;
        if (o.riseDb > 0 && i + riseWin < sg.b) {
          let after = -Infinity, minBefore = true;
          for (let k = 1; k <= riseWin; k++) { after = Math.max(after, rms[i + k]); if (rms[i - k] < rms[i]) { minBefore = false; break; } }
          rise = minBefore && (after - rms[i] >= o.riseDb) && rms[i + 1] >= rms[i];
        }
        if (dip || rise) {
          split.push({ a, b: i, midi: sg.midi, pitch: sg.pitch, onset: aReason });
          // 分けた後ろの区間の音高は改めて測る(連打の2音目が別の音高なこともある)
          a = i; aReason = dip ? 'dip' : 'rise'; i += look;
        }
      }
      split.push({ a, b: sg.b, midi: sg.midi, pitch: sg.pitch, onset: aReason });
    }
    segs = split;
    for (const sg of segs) { if (sg.onset === 'dip' || sg.onset === 'rise') { sg.pitch = pitchOf(sg) ?? sg.pitch; sg.midi = Math.round(sg.pitch); } }

    const dur = (sg) => (sg.b - sg.a) * hop;

    // 6) スクープ吸収
    if (o.scoopMaxSec > 0) {
      for (let i = 0; i + 1 < segs.length; i++) {
        const sg = segs[i], nx = segs[i + 1];
        if (sg.onset !== 'voice' || dur(sg) > o.scoopMaxSec) continue;
        if ((nx.a - sg.b) * hop > 0.02 || Math.abs(nx.pitch - sg.pitch) > 3) continue;
        const half = (sg.a + sg.b) >> 1, w1 = [], w2 = [];
        for (let k = sg.a; k < half; k++) if (med[k] != null) w1.push(med[k]);
        for (let k = half; k < sg.b; k++) if (med[k] != null) w2.push(med[k]);
        const m1 = median(w1), m2 = median(w2);
        if (m1 == null || m2 == null) continue;
        if (Math.abs(nx.pitch - m2) < Math.abs(nx.pitch - m1) - o.scoopMinMove) {
          nx.a = sg.a; nx.onset = 'voice'; segs.splice(i, 1); i--;
        }
      }
    }

    // 7) 短い音符を吸収
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        if (dur(sg) >= o.minNoteSec) continue;
        const p = segs[i - 1], q = segs[i + 1];
        const pc = p && (sg.a - p.b) * hop <= 0.02, qc = q && (q.a - sg.b) * hop <= 0.02;
        let target = null;
        if (pc && qc) target = Math.abs(p.pitch - sg.pitch) <= Math.abs(q.pitch - sg.pitch) ? p : q;
        else if (pc) target = p; else if (qc) target = q;
        if (target) {
          if (target.a > sg.a) { target.a = sg.a; target.onset = sg.onset; }
          target.b = Math.max(target.b, sg.b);
        }
        segs.splice(i, 1); i--; changed = true;
      }
      if (!changed) break;
    }

    // 8) 調へ寄せる
    let key = null;
    const pre = segs.map(sg => ({ startSec: frames[sg.a].t, endSec: frames[Math.min(sg.b, n - 1)].t, midi: sg.midi }));
    if (o.keySnap) {
      key = estimateKey(pre);
      if (key) {
        for (const sg of segs) {
          const p = sg.pitch, frac = p - Math.floor(p);
          if (Math.abs(frac - 0.5) > o.keySnapBand) continue;
          const lo = Math.floor(p), hi = lo + 1;
          const inLo = key.scale[((lo % 12) + 12) % 12], inHi = key.scale[((hi % 12) + 12) % 12];
          if (inLo && !inHi) sg.midi = lo; else if (inHi && !inLo) sg.midi = hi;
        }
        segs = mergeSame(segs, hop);
      }
    } else key = estimateKey(pre);

    const notes = segs.map(sg => ({
      startSec: frames[sg.a].t, endSec: frames[Math.min(sg.b, n - 1)].t,
      midi: sg.midi, pitch: sg.pitch, onset: sg.onset
    }));
    return { notes, key };
  }

  function mergeSame(segs, hop) {
    const out = [];
    for (const sg of segs) {
      const last = out[out.length - 1];
      // 結合するのは Viterbi 由来の分裂だけ。谷/立ち上がりで分けた境目は残す
      if (last && last.midi === sg.midi && (sg.a - last.b) * hop <= 0.02 && sg.onset === 'jump') { last.b = sg.b; continue; }
      out.push(sg);
    }
    return out;
  }

  /*
   * 音符列 → TimedPitchEvent 列(src/input/quantize.js の第1引数)。
   * transpose: 半音(鼻歌は低くなりがちなので +12 等)。
   * 隣の音符と 20ms 以上離れていれば無音(midiNote:null)を挟む。
   */
  function toTimedEvents(notes, transpose) {
    const tr = transpose || 0;
    const ev = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i], next = notes[i + 1];
      ev.push({ timeSec: n.startSec, midiNote: n.midi + tr });
      if (!next || next.startSec > n.endSec + 0.02) ev.push({ timeSec: n.endSec, midiNote: null });
    }
    return ev;
  }

  /*
   * メトロノーム無しで歌った音符列からテンポを推定する。
   * 発音間隔を 60Hz のフレーム数に丸めて MML.Convert.detectBpm に渡す(合成テストで 30Hz より正解率が高い)。
   * 材料が足りなければ fallback(既定 120)
   */
  function estimateBpm(notes, fallback) {
    const fb = Number.isFinite(fallback) ? fallback : 120;
    if (!notes || notes.length < 3 || !MML.Convert || !MML.Convert.detectBpm) return fb;
    const ioi = [];
    for (let i = 1; i < notes.length; i++) ioi.push(Math.round((notes[i].startSec - notes[i - 1].startSec) * 60));
    const bpm = MML.Convert.detectBpm(ioi, 60);
    return Number.isFinite(bpm) ? Math.round(bpm) : fb;
  }

  /* 音域からオクターブ補正の提案(中央が o3 以下なら +12)。鼻歌はメロディより1オクターブ低くなりがち */
  function suggestTranspose(notes) {
    if (!notes || !notes.length) return 0;
    const ms = notes.map(n => n.midi).sort((a, b) => a - b);
    const mid = ms[ms.length >> 1];
    return mid < 60 ? 12 : 0;
  }

  Input.NoteSegment = { DEFAULTS, PRESETS, segment, estimateKey, toTimedEvents, estimateBpm, suggestTranspose };

})(window);
