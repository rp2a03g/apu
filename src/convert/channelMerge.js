/*
 * 複数の元チャンネルを1パートに「まとめる」— MML.Convert.ChannelMerge (2026-09-29)
 *
 * PCM系ドライバは1つのパート(旋律)を2本以上のボイスで交互/順繰りに鳴らすことがある
 * (前の音の余韻を残したまま次の音を別ボイスで鳴らす)。そのままだとボイスごとに借用先が要り、
 * しかも各借用先には歯抜けの音符列しか載らない。ここでは、ユーザーが鍵盤表示の割当で
 * 「同じ借用先+まとめる」を付けた元chの音符を1本の単音列に畳む。
 *
 *   const r = MML.Convert.ChannelMerge.merge([{ id, events }, ...])
 *   r.events … { start, end, note(null=休符), ...元の項目 } の連続被覆(音符+隙間の休符)
 *   r.stats  … 注記用の数(下の describe() で文にする)
 *
 * 規則(実測 かまいたちの夜 Requiem V0/V1・V2/V3・V4/V7 で決めた):
 *   1. 全メンバーの音符を開始フレーム順に並べる。交互/順繰りの順番を知る必要は無い
 *      (絶対時刻があるので、どの順で回していても抜けがあってもそのまま拾える)
 *   2. 前の音は「自分の終わり」と「次の音の開始」の早い方で終わる(=次の音で切る)。次の音が来ない
 *      隙間では余韻を最後まで残す。失われるのは次の音と重なっていた部分だけで、これは1本の単音chでは
 *      原理的に書けない
 *   3. 前の音から DOUBLE_WINDOW フレーム以内に始まった音は「同時」とみなして捨てる(先に並んだ方=
 *      音量が大きい方、同じなら高い方、同じならメンバー順が勝つ)。1フレーム遅れのデチューン重ねを
 *      まとめてしまうと1フレームの断片が並ぶだけになるため。捨てた数は注記に出す(大半が同時なら
 *      交互ではなく重ねパートなので、まとめるより片方をスキップにする方がよい)
 *   4. フレーム単位の列(volSeq/pitchSeq 等)は切った長さに詰める。タイ候補(tieCandidate=同じ元chの
 *      直前の音から音程だけ変わって続いている印)は、直前が別の元chになったら外す
 * DOM 非依存(INV-4)。イベントの形は各 *2mml の共通形式({start,end,note})。SPC の {frame,len} は
 * 呼び出し側(spc2mml)で往復変換する。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const DOUBLE_WINDOW = 2;   // フレーム。これ以内に始まった2音は「同時」
  const QUIET_RATIO = 0.25;  // 切った時点の音量がピークのこれ以下なら「余韻」と数える
  // 1フレーム1要素の列(長さが音符の長さと一致するものだけ詰める)
  const PER_FRAME_SEQ = ['volSeq', 'pitchSeq', 'freqSeq', 'dutySeq', 'attSeq', 'hwEnvSeq'];

  function peakOf(ev) {
    const s = ev.volSeq;
    if (s && s.length) { let m = 0; for (let i = 0; i < s.length; i++) if (s[i] > m) m = s[i]; return m; }
    return (typeof ev.vol === 'number') ? ev.vol : null;
  }
  function volAt(ev, k) {
    const s = ev.volSeq;
    if (s && s.length) return s[Math.min(k, s.length - 1)];
    return (typeof ev.vol === 'number') ? ev.vol : null;
  }

  /**
   * @param {Array<{id?:string, events:Array}>} members
   * @param {object} [opts] { doubleWindow }
   * @returns {{events:Array, stats:object}}
   */
  function merge(members, opts) {
    opts = opts || {};
    const win = opts.doubleWindow != null ? opts.doubleWindow : DOUBLE_WINDOW;
    const all = [];
    let minStart = Infinity, maxEnd = 0;
    members.forEach((m, mi) => {
      for (const ev of (m.events || [])) {
        if (ev.start < minStart) minStart = ev.start;
        if (ev.end > maxEnd) maxEnd = ev.end;
        if (ev.note === null || ev.note === undefined) continue;
        all.push({ ev, mi, peak: peakOf(ev) });
      }
    });
    if (!isFinite(minStart)) minStart = 0;
    all.sort((a, b) => (a.ev.start - b.ev.start) || ((b.peak || 0) - (a.peak || 0)) || ((b.ev.note || 0) - (a.ev.note || 0)) || (a.mi - b.mi));

    const stats = { notes: 0, dropped: 0, cut: 0, quietCut: 0, ratios: [], perMember: members.map(() => 0), members: members.length, window: win };
    const kept = [];
    for (const item of all) {
      const last = kept[kept.length - 1];
      if (last && item.ev.start - last.ev.start <= win) {
        stats.dropped++;
        // 音量が大きい方を採る(同じなら先に始まった方)。並びは開始順なので、後から来た方が大きければ差し替える
        if ((item.peak || 0) > (last.peak || 0)) kept[kept.length - 1] = item;
        continue;
      }
      kept.push(item);
    }
    const out = [];
    let cursor = minStart;
    let prevKept = null; // 直前に採った音(タイ候補の判定用)
    for (let i = 0; i < kept.length; i++) {
      const cur = kept[i], next = kept[i + 1];
      const ev = Object.assign({}, cur.ev);
      const len0 = ev.end - ev.start;
      if (next && ev.end > next.ev.start) {
        const k = next.ev.start - ev.start;
        const v = volAt(ev, k), peak = cur.peak;
        stats.cut++;
        if (peak != null && v != null && peak > 0) { const r = v / peak; stats.ratios.push(r); if (r <= QUIET_RATIO) stats.quietCut++; }
        ev.end = next.ev.start;
        const len1 = ev.end - ev.start;
        for (const key of PER_FRAME_SEQ) if (Array.isArray(ev[key]) && ev[key].length === len0) ev[key] = ev[key].slice(0, len1);
      }
      if (ev.tieCandidate && !(prevKept && prevKept.mi === cur.mi && prevKept.end === ev.start)) ev.tieCandidate = false;
      if (ev.start > cursor) out.push({ start: cursor, end: ev.start, note: null });
      out.push(ev);
      cursor = ev.end;
      stats.notes++;
      stats.perMember[cur.mi]++;
      prevKept = { mi: cur.mi, end: ev.end };
    }
    if (cursor < maxEnd) out.push({ start: cursor, end: maxEnd, note: null });
    return { events: out, stats };
  }

  /** 注記(変換結果のヘッダコメント。出力物なので訳さない) */
  function describe(label, targetLabel, stats) {
    const per = stats.perMember.map(n => String(n)).join('+');
    const total = stats.notes + stats.dropped;
    let s = `${label} を1パートにまとめて ${targetLabel} へ載せました: 音符 ${stats.notes}個(内訳 ${per})。`;
    if (stats.cut) {
      let q = '';
      if (stats.ratios.length) {
        const sorted = stats.ratios.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        q = `、切った時点の音量はピークの中央値 ${Math.round(med * 100)}%、25%以下=余韻だったのは ${stats.quietCut}個`;
      }
      s += `次の音が始まったので切った音 ${stats.cut}個(重なっていた部分は1本のチャンネルでは書けません${q})。`;
    }
    if (stats.dropped) {
      s += `同時(${stats.window}フレーム以内)に始まった音 ${stats.dropped}個は片方を捨てました。`;
      if (total && stats.dropped >= total * 0.4) {
        s += ' ※ 同時発音が大半です。交互に鳴らす分担ではなく重ね(デチューン)パートの可能性が高いので、まとめるより片方をスキップにする方がよいかもしれません。';
      }
    }
    return s;
  }

  MML.Convert.ChannelMerge = { merge, describe, DOUBLE_WINDOW, QUIET_RATIO, PER_FRAME_SEQ };
})(typeof window !== 'undefined' ? window : globalThis);
