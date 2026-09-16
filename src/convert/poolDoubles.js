/*
 * 合成ch(プール式PCMの論理レーン)の「複製パート」検出と畳み込み
 * MML.Convert.PoolDoubles
 *
 * ドライバが1本の旋律を複数のボイスで重ねて鳴らすことがある:
 *  - デチューン二重化: 同じ音を同じ瞬間に、わずかに音程をずらしてもう1本(コーラス効果)
 *  - エコー: 同じ音を数フレーム遅れてもう1本(ディレイ効果。音量は同じか小さい)
 * 実測(Namco Anthology 1 / Tower of Babel babel14、ドライバ内部トラックで確認): ベースと上物が +0.14 半音の
 * 二重化、アルペジオ2本が 15 フレーム遅れのエコー。しかもエコーが「どのトラックを追いかけるか」は曲の途中で
 * 入れ替わる(約690フレーム)ので、レーン丸ごとではなくノート単位で見る。
 * ppmck にはディレイもコーラスも無いので、MML では複製の分だけチャンネルを食う。
 *
 *   const found = PoolDoubles.find(frames)       // frames[f][lane] = 合成chのスナップショット(Emu.PoolChannelRegrouper の出力)
 *   found.copyNotes: Map<lane, Set<seq>>            // 複製とみなしたノート(レーン内の seq)
 *   found.groups: [{copy, of, delay, detune, notes}]  // 要約(ヘッダ注記用。copy/of はレーン番号、delay はフレーム)
 *   found.copyCount: Map<lane, number>              // レーンごとの複製ノート数(既定割当の優先度づけ用)
 *   const folded = PoolDoubles.fold(frames, found)  // 複製ノートを無音にした新しい frames(元は変えない)
 *
 * 判定: レーン B のノートが、別レーン A のノートと「同じサンプル・音程差 0.6 半音以内・遅れ d(0〜40 フレーム、
 * ±1 の揺れを許す)」で対応し、同じ A・同じ d の対応が MIN_RUN 音以上続いた区間を複製候補にする。
 * 遅れ 0 の組は、音量の小さい方(同じなら番号の大きいレーン)を複製とする。候補を時刻順に確定し、
 * 対応先がすべて複製と確定済みなら元とみなす(A↔B が互いに追いかけ合う周期的な音型で両方消さないため)。
 * 音程の取れないノート(ドラム等)は対象外。
 * DOM 非依存(INV-4)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const MAX_DELAY = 40;     // フレーム(60fps で約0.67秒)
  const PITCH_TOL = 0.6;    // 半音
  const MIN_RUN = 6;        // 連続して対応したノート数
  const PITCH_CONF = 0.5;

  function laneNotes(frames, li) {
    const notes = [];
    let cur = null;
    for (let f = 0; f < frames.length; f++) {
      const c = frames[f] && frames[f][li];
      if (!c || !c.active) { if (cur) { cur.end = f; cur = null; } continue; }
      if (!cur || c.seq !== cur.seq) {
        if (cur) cur.end = f;
        const pitched = c.pitchHz > 0 && c.pitchConf >= PITCH_CONF;
        cur = { lane: li, f, end: frames.length, seq: c.seq, vol: 0,
          key: c.sample ? c.sample.start + ':' + c.sample.end : null,
          midi: pitched ? 69 + 12 * Math.log2(c.pitchHz / 440) : null };
        notes.push(cur);
      }
      if (c.vol > cur.vol) cur.vol = c.vol;
    }
    return notes;
  }

  function find(frames, opts) {
    opts = opts || {};
    const minRun = opts.minRun || MIN_RUN;
    const nLanes = frames.reduce((m, fr) => Math.max(m, fr ? fr.length : 0), 0);
    const lanes = [];
    const byFrame = new Map(); // f → [note](音程のあるノートだけ)
    for (let li = 0; li < nLanes; li++) {
      const ns = laneNotes(frames, li).filter(n => n.midi !== null && n.key !== null);
      lanes.push(ns);
      for (const n of ns) { if (!byFrame.has(n.f)) byFrame.set(n.f, []); byFrame.get(n.f).push(n); }
    }
    const same = (x, y) => x.key === y.key && Math.abs(x.midi - y.midi) <= PITCH_TOL;
    // 遅れ0の組でどちらを複製とするか(音量の小さい方、同じならレーン番号の大きい方)
    const zeroIsCopy = (n, src) => (n.vol < src.vol * 0.98) || (Math.abs(n.vol - src.vol) <= src.vol * 0.02 && n.lane > src.lane);

    // 1) レーンごとに、同じ(元レーン, 遅れ)の対応が続く区間を探す
    const cand = new Map(); // note → [src note]
    for (const B of lanes) {
      if (B.length < minRun) continue;
      // runs: key 'lane' → {d, notes:[[n, src]]}
      let runs = new Map();
      const flush = (r) => { if (r.items.length >= minRun) for (const [n, s] of r.items) { if (!cand.has(n)) cand.set(n, []); cand.get(n).push(s); } };
      for (const n of B) {
        const matches = new Map(); // lane → [{d, src}]
        for (let d = 0; d <= MAX_DELAY; d++) {
          const cs = byFrame.get(n.f - d);
          if (!cs) continue;
          for (const x of cs) {
            if (x.lane === n.lane || !same(x, n)) continue;
            if (d === 0 && !zeroIsCopy(n, x)) continue;
            if (!matches.has(x.lane)) matches.set(x.lane, []);
            matches.get(x.lane).push({ d, src: x });
          }
        }
        const next = new Map();
        for (const [lane, ms] of matches) {
          const r = runs.get(lane);
          const m = r ? (ms.find(m => Math.abs(m.d - r.d) <= 1) || null) : null;
          if (r && m) { r.items.push([n, m.src]); next.set(lane, r); runs.delete(lane); }
          else {
            // 新しい区間(最も近い遅れから始める)
            ms.sort((a, b) => a.d - b.d);
            next.set(lane, { d: ms[0].d, items: [[n, ms[0].src]] });
          }
        }
        for (const r of runs.values()) flush(r); // 途切れた区間
        runs = next;
      }
      for (const r of runs.values()) flush(r);
    }

    // 2) 時刻順に確定。元がすべて複製と確定していたら、このノートは元として残す
    const isCopy = new Set();
    const ordered = [...cand.keys()].sort((a, b) => a.f - b.f || b.vol - a.vol || a.lane - b.lane);
    const copyNotes = new Map(), copyCount = new Map(), groupMap = new Map();
    for (const n of ordered) {
      const srcs = cand.get(n).filter(s => !isCopy.has(s));
      if (!srcs.length) continue;
      const s = srcs[0];
      isCopy.add(n);
      if (!copyNotes.has(n.lane)) copyNotes.set(n.lane, new Set());
      copyNotes.get(n.lane).add(n.seq);
      copyCount.set(n.lane, (copyCount.get(n.lane) || 0) + 1);
      const d = n.f - s.f;
      const gk = n.lane + ':' + s.lane + ':' + (d <= 1 ? 0 : d);
      const g = groupMap.get(gk) || { copy: n.lane, of: s.lane, delay: d <= 1 ? 0 : d, detuneSum: 0, notes: 0 };
      g.detuneSum += n.midi - s.midi; g.notes++;
      groupMap.set(gk, g);
    }
    const groups = [...groupMap.values()]
      .filter(g => g.notes >= minRun)
      .map(g => ({ copy: g.copy, of: g.of, delay: g.delay, detune: g.detuneSum / g.notes, notes: g.notes }))
      .sort((a, b) => a.copy - b.copy || b.notes - a.notes);
    return { copyNotes, copyCount, groups };
  }

  /** 複製ノートの区間を無音(active:false)にした frames を返す(元の配列/オブジェクトは変えない) */
  function fold(frames, found) {
    if (!found || !found.copyNotes.size) return frames;
    return frames.map(fr => {
      if (!fr) return fr;
      let out = null;
      for (const [lane, seqs] of found.copyNotes) {
        const c = fr[lane];
        if (c && c.active && seqs.has(c.seq)) {
          if (!out) out = fr.slice();
          out[lane] = Object.assign({}, c, { active: false, vol: 0, rawVol: 0 });
        }
      }
      return out || fr;
    });
  }

  /** ヘッダ注記用の文(labelOf(lane) → 'SPU V5' 等) */
  function describe(found, labelOf) {
    if (!found || !found.groups.length) return null;
    const parts = found.groups.map(g => {
      const what = g.delay > 0 ? `${g.delay}フレーム遅れのエコー` : `${g.detune >= 0 ? '+' : ''}${g.detune.toFixed(2)}半音のデチューン二重化`;
      return `${labelOf(g.copy)} は ${labelOf(g.of)} の${what}(${g.notes}音)`;
    });
    return parts;
  }

  MML.Convert.PoolDoubles = { find, fold, describe, MAX_DELAY, PITCH_TOL, MIN_RUN };
})(typeof window !== 'undefined' ? window : globalThis);
