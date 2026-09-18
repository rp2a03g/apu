/*
 * 楽譜の表記モデル(ROADMAP「フェーズ外: 楽譜出力」段階2、2026-09-16)
 *
 * compile() の noteList(書かれたとおりの音符列、音価付き。src/mml/compiler.js recordNote 参照)を
 * 「小節 → 音符(音価の型/付点/連符/タイ/スラー/連桁/臨時記号)」の表記モデルへ直す。
 * MusicXML 書き出し(musicxml.js)と五線表示(段階3以降)の両方がこのモデルを食う。
 * 音符を「見栄え」のために動かすことはしない: 全ての音の開始位置と長さは noteList と厳密に一致する
 * (小節線をまたぐ音はタイで分ける、1つの音価で書けない長さはタイで分ける、それだけ)。
 *
 * 時間の単位: 1曲ぶんの「単位(units)」= 全音符を U 等分した整数。U は曲中の全音価(連符含む)と
 * 拍子の分母の最小公倍数なので、どの音符も整数で表せて、浮動小数の誤差が入らない。
 * MusicXML の divisions(四分音符あたり)= U/4。
 *
 * モデル:
 *   { title, composer, units(U), divisions, time:{beats,beatType}, key:{fifths,mode,estimated},
 *     parts: [ { id, letter, name, percussion, clef:{sign,line},
 *                measures: [ { number, startUnits, items: [ Item ... ], measureRest } ] } ] }
 *   Item(音符/休符1つ):
 *   { rest, pitch:{step,alter,octave}|null, unpitched:{step,octave}|null, dur(units), noteType(1|2|4|8|...),
 *     dots, tuplet:{actual,normal,start,stop}|null, tieStart, tieStop, slurStart, slurStop,
 *     accidental:string|null, beams:[ 'begin'|'continue'|'end'|'forward hook'|'backward hook' ... ],
 *     tempo:number|null(この音の直前でテンポが変わる/曲頭), note(元のノート番号|null),
 *     srcStart, srcEnd, noteIndex(noteList の添字) }
 *
 * 音名の綴り(異名同音)は「調の音階に載る綴り > 書かれた綴り(c+ と d- の区別) > 調の向きの既定表」の順。
 * 調が無指定(;@key なし)なら Krumhansl-Schmuckler の調プロファイル相関で推定する(estimated=true)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Score = MML.Score = MML.Score || {};

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a || 1; }
  function lcm(a, b) { return (a / gcd(a, b)) * b; }

  // ── 音名 ─────────────────────────────────────────────────────────
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SHARP_TABLE = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const FLAT_TABLE = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

  // 調号 fifths → 各音名の変化(調の音階)
  function keyAlters(fifths) {
    const m = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
    if (fifths > 0) for (let i = 0; i < fifths; i++) m[SHARP_ORDER[i]] = 1;
    else for (let i = 0; i < -fifths; i++) m[SHARP_ORDER[6 - i]] = -1;
    return m;
  }
  Score.keyAlters = keyAlters;

  // ノート番号(compiler の規約: o4 c = 48 = C4 = 261.6Hz、A4=57) → {step, alter, octave}
  // hint: noteList の spelled(書かれた綴り)。移調(K)がかかっていると綴りが実音とずれるので使わない
  function spell(note, fifths, hint) {
    const pc = ((note % 12) + 12) % 12;
    const ka = keyAlters(fifths);
    let chosen = null;
    for (const L of LETTERS) {
      let a = pc - LETTER_PC[L];
      a = ((a + 6) % 12 + 12) % 12 - 6;
      if (a === ka[L]) { chosen = [L, a]; break; }
    }
    if (!chosen && hint && hint.transpose === 0 && Math.abs(hint.accidental) <= 2) {
      const L = String(hint.name || '').toUpperCase();
      if (LETTER_PC[L] != null && ((LETTER_PC[L] + hint.accidental) % 12 + 12) % 12 === pc) chosen = [L, hint.accidental];
    }
    if (!chosen) chosen = (fifths < 0 ? FLAT_TABLE : SHARP_TABLE)[pc];
    const [step, alter] = chosen;
    return { step, alter, octave: Math.floor((note - alter) / 12) };
  }
  Score.spell = spell;

  // ── 調の推定(Krumhansl-Kessler プロファイル) ────────────────────────
  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function correlation(x, y) {
    const n = x.length; let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  }
  function fifthsOfTonic(pc) { return ((pc * 7 + 6) % 12 + 12) % 12 - 6; }
  // weights: 12要素(ピッチクラスごとの重み=音価の合計)。戻り値 {fifths, mode, tonic, score}
  Score.estimateKey = function (weights) {
    let best = null;
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const [mode, prof] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
        const rotated = new Array(12);
        for (let i = 0; i < 12; i++) rotated[i] = prof[((i - tonic) % 12 + 12) % 12];
        const r = correlation(weights, rotated);
        if (!best || r > best.score) best = { tonic, mode, score: r };
      }
    }
    if (!best) return { fifths: 0, mode: 'major', tonic: 0, score: 0 };
    const relMajor = best.mode === 'minor' ? (best.tonic + 3) % 12 : best.tonic;
    return { fifths: fifthsOfTonic(relMajor), mode: best.mode, tonic: best.tonic, score: best.score };
  };

  // ── パート情報(チャンネル文字 → 名前/打楽器か) ─────────────────────
  function partInfoOf(letter, compiled) {
    const map = compiled.expansionLetterMap || {};
    if (letter === 'A') return { name: '2A03 Pulse 1', percussion: false };
    if (letter === 'B') return { name: '2A03 Pulse 2', percussion: false };
    if (letter === 'C') return { name: '2A03 Triangle', percussion: false };
    if (letter === 'D') return { name: '2A03 Noise', percussion: true };
    const names = {
      dpcm: (i) => ({ name: 'DPCM', percussion: true }),
      vrc6: (i) => ({ name: i === 2 ? 'VRC6 Saw' : `VRC6 Pulse ${i + 1}`, percussion: false }),
      vrc7: (i) => ({ name: `VRC7 FM ${i + 1}`, percussion: false }),
      fds: (i) => ({ name: 'FDS', percussion: false }),
      mmc5: (i) => ({ name: `MMC5 Pulse ${i + 1}`, percussion: false }),
      n163: (i) => ({ name: `N163 ${i + 1}`, percussion: false }),
      fme7: (i) => ({ name: `5B ${i + 1}`, percussion: false })
    };
    for (const exp of Object.keys(map)) {
      const i = (map[exp] || []).indexOf(letter);
      if (i >= 0) return names[exp] ? names[exp](i) : { name: `${exp} ${i + 1}`, percussion: false };
    }
    return { name: letter, percussion: false };
  }
  Score.partInfoOf = partInfoOf;

  // ── 音価の分解 ──────────────────────────────────────────────────────
  // 1つの音符(units)を「音価の型+付点(+連符比)」の列に分解する。1個で書けなければタイで
  // 繋ぐ複数個に割る(長い方から)。戻り値: [{units, noteType, dots, tuplet:{actual,normal}|null}]
  // maxDots: 付点の上限(音符=2、休符=1。付点2つの休符は読みにくいので分けて書く)
  function decompose(units, U, maxDots) {
    const maxK = (maxDots == null ? 2 : maxDots) + 1;
    const out = [];
    if (units <= 0) return out;
    const g = gcd(units, U);
    let p = units / g, q = U / g;          // 値 = p/q 全音符
    let m = q; while (m % 2 === 0) m /= 2;  // q の奇数部分(1なら連符でない)
    let ratio = null;
    if (m > 1) {
      const normal = Math.pow(2, Math.floor(Math.log2(m)));
      ratio = { actual: m, normal };
      // 連符の内側の見かけの値 v' = v * actual / normal(2進の値になる)
      const p2 = p * m, q2 = q * normal;
      const g2 = gcd(p2, q2); p = p2 / g2; q = q2 / g2;
    }
    // ここで q は2のべき。p を上位ビットから「連続する1(最大3個=付点2つ)」ずつ切り出す
    while (p > 0) {
      if (p / q >= 2) {                     // 2全音符以上(w や連結)。全音符ずつ切ってタイで繋ぐ
        out.push({ units: U * (ratio ? ratio.normal / ratio.actual : 1), noteType: 1, dots: 0, tuplet: ratio ? { ...ratio } : null });
        p -= q;
        continue;
      }
      const h = Math.floor(Math.log2(p));
      let k = 0;
      while (k < maxK && h - k >= 0 && (p & (1 << (h - k)))) k++;
      const val = (Math.pow(2, k) - 1) * Math.pow(2, h - k + 1); // p のうち今回書く分
      const noteType = q / Math.pow(2, h);                        // 1=全音符, 2=2分, ...
      const realUnits = (val / q) * U * (ratio ? ratio.normal / ratio.actual : 1);
      out.push({ units: realUnits, noteType, dots: k - 1, tuplet: ratio ? { ...ratio } : null });
      p -= val;
    }
    return out;
  }
  Score.decompose = decompose;

  // 音符の値(units)。noteList の len/tuplet から厳密に求める(U は unitsBase で決めた公倍数)
  function unitsOf(n, U) {
    const d = n.len.dots, count = n.tuplet ? n.tuplet.count : 1;
    return ((Math.pow(2, d + 1) - 1) * U) / (Math.pow(2, d) * n.len.n * count);
  }
  // 曲全体の U: 全音符の音価の分母と拍子の分母の最小公倍数(4 の倍数にして divisions を整数に)
  function unitsBase(compiled, beatType) {
    let U = lcm(4, beatType);
    for (const ch of compiled.channelLetters) {
      for (const n of compiled.noteList[ch] || []) {
        const d = n.len.dots, count = n.tuplet ? n.tuplet.count : 1;
        const num = Math.pow(2, d + 1) - 1, den = Math.pow(2, d) * n.len.n * count;
        U = lcm(U, den / gcd(num, den));
      }
    }
    return U;
  }

  const NOTE_TYPES = new Set([1, 2, 4, 8, 16, 32, 64, 128, 256]);
  function accidentalName(alter) {
    return { '-2': 'flat-flat', '-1': 'flat', '0': 'natural', '1': 'sharp', '2': 'double-sharp' }[String(alter)] || null;
  }

  // 打楽器(ノイズ/DPCM)の表示位置と、楽譜ソフトで鳴らすときの GM ドラム音(MIDI ch10)。
  // 表示位置はノート番号を五線の位置に散らすだけ(E4 から上へ)。
  // gm: ノイズは周期が長い(低い=周期index が大きい。ノイズchの note は index 0-15 の直値、本家ppmck準拠 2026-09-18)
  //     ほうからキック(36)/スネア(38)/クローズドハイハット(42)、
  //     DPCM はサンプル番号(note - 48)でキック/スネア/ハイハット/タム/クラッシュ/オープンハイハット/ロータム/ライドを回す。
  //     楽譜ソフトがピアノで鳴らして雑音にならないためのもので、実機の音を表すものではない(2026-09-16)
  const GM_DRUM_NAMES = { 36: 'Bass Drum', 38: 'Snare', 42: 'Closed Hi-Hat', 45: 'Low Tom', 49: 'Crash', 46: 'Open Hi-Hat', 41: 'Floor Tom', 51: 'Ride' };
  const DPCM_DRUM_CYCLE = [36, 38, 42, 45, 49, 46, 41, 51];
  function unpitchedOf(note, part) {
    const steps = ['E', 'F', 'G', 'A', 'B', 'C', 'D'];
    const pos = ((note % 16) + 16) % 16;
    const i = pos % 7, oct = 4 + Math.floor(pos / 7) + (i >= 5 ? 1 : 0);
    let gm;
    if (part && /DPCM/.test(part.name)) gm = DPCM_DRUM_CYCLE[((note - 48) % DPCM_DRUM_CYCLE.length + DPCM_DRUM_CYCLE.length) % DPCM_DRUM_CYCLE.length];
    else gm = pos >= 10 ? 36 : (pos >= 5 ? 38 : 42);
    return { step: steps[i], octave: oct, gm, gmName: GM_DRUM_NAMES[gm] || ('Drum ' + gm) };
  }
  Score.unpitchedOf = unpitchedOf;

  // 調: 指示 > 推定(音程を持つ全chの音価重み)
  function resolveKey(compiled, opts) {
    const explicitFifths = opts.keyFifths != null ? opts.keyFifths : (compiled.score && compiled.score.key ? compiled.score.key.fifths : null);
    if (explicitFifths != null) return { fifths: explicitFifths, mode: 'major', estimated: false };
    const w = new Array(12).fill(0);
    for (const ch of compiled.channelLetters) {
      if (partInfoOf(ch, compiled).percussion) continue;
      for (const n of compiled.noteList[ch] || []) if (n.note != null) w[((n.note % 12) + 12) % 12] += n.ticks;
    }
    const est = Score.estimateKey(w);
    return { fifths: est.fifths, mode: est.mode, estimated: true };
  }

  // 全パートの小節数を揃える(短いチャンネルの末尾は小節休符)。MuseScore はパート間で小節数が違うと崩れる
  function padMeasures(parts, measureUnits) {
    const maxMeasures = parts.reduce((a, p) => Math.max(a, p.measures.length), 0);
    for (const part of parts) {
      while (part.measures.length < maxMeasures) {
        const number = part.measures.length + 1;
        const prev = part.measures[part.measures.length - 1];
        const frameStart = prev ? prev.frameEnd : 0;
        const frameEnd = frameStart + measureUnits * (part.framesPerUnit || 0);
        part.measures.push({ number, startUnits: (number - 1) * measureUnits, measureRest: true, frameStart, frameEnd, items: [{
          rest: true, pitch: null, unpitched: null, dur: measureUnits, noteType: 1, dots: 0, tuplet: null,
          tieStart: false, tieStop: false, slurStart: false, slurStop: false, accidental: null, beams: [],
          tempo: null, note: null, srcStart: undefined, srcEnd: undefined, noteIndex: -1,
          pos: (number - 1) * measureUnits, continued: false, measureRest: true, frameStart, frameEnd }] });
      }
    }
  }

  function finishNotation(compiled, opts, ctx, parts) {
    padMeasures(parts, ctx.measureUnits);
    return {
      title: opts.title != null ? opts.title : ((compiled.meta && compiled.meta.title) || ''),
      composer: opts.composer != null ? opts.composer : ((compiled.meta && compiled.meta.composer) || ''),
      units: ctx.U, divisions: ctx.U / 4, time: { beats: ctx.time.beats, beatType: ctx.time.beatType }, key: ctx.key, parts
    };
  }

  function makeCtx(compiled, opts) {
    const time = opts.time || (compiled.score && compiled.score.time) || { beats: 4, beatType: 4 };
    const U = unitsBase(compiled, time.beatType);
    return { U, measureUnits: (time.beats * U) / time.beatType, time, key: resolveKey(compiled, opts), compiled };
  }

  // ── 本体 ────────────────────────────────────────────────────────────
  // opts: { title, composer, time:{beats,beatType}, keyFifths, includeEmpty }
  Score.buildNotation = function (compiled, opts) {
    opts = opts || {};
    const ctx = makeCtx(compiled, opts);
    const parts = [];
    for (const letter of compiled.channelLetters) {
      const list = compiled.noteList[letter] || [];
      if (!list.length && !opts.includeEmpty) continue;
      const info = partInfoOf(letter, compiled);
      const part = { id: 'P_' + letter, letter, name: `${letter}: ${info.name}`, percussion: info.percussion, clef: null, measures: [] };
      const src = piecesFromNoteList(part, list, ctx);
      layoutPieces(part, src.pieces, src.pitched, ctx);
      if (!part.measures.length && !opts.includeEmpty) continue;
      parts.push(part);
    }
    return finishNotation(compiled, opts, ctx, parts);
  };

  // ── ピアノ2段への統合(段階5、2026-09-16) ──────────────────────────────
  // 音程を持つチャンネルを右手/左手に振り分け、各手は「同時に鳴っている音の集合」を和音として
  // 1声部に畳む。変換ではなく編曲なので規則は固定:
  //   ・平均音高がいちばん高いch = メロディ → 右手、いちばん低いch = ベース → 左手
  //   ・残りは中央値が C4(ノート番号48)以上なら右手、未満なら左手(opts.split で変更可)
  //   ・打楽器ch(ノイズ/DPCM)はそのまま別段(opts.includePercussion=false で省く)
  // 和音の切れ目は「どれかのchで打ち直しがある」か「鳴っている音の集合が変わる」所。集合が変わっても
  // 鳴り続けている音はタイで繋ぐ(item.chord の各音が tieStart/tieStop を持つ)。
  // 音符は一切動かさない(開始位置・長さは元のchのまま)。
  Score.buildPianoNotation = function (compiled, opts) {
    opts = opts || {};
    const ctx = makeCtx(compiled, opts);
    const split = opts.split != null ? opts.split : 48;
    const sources = [];
    const percParts = [];
    for (const letter of compiled.channelLetters) {
      const list = compiled.noteList[letter] || [];
      if (!list.length) continue;
      const info = partInfoOf(letter, compiled);
      const part = { id: 'P_' + letter, letter, name: `${letter}: ${info.name}`, percussion: info.percussion, clef: null, measures: [] };
      const src = piecesFromNoteList(part, list, ctx);
      if (info.percussion) {
        if (opts.includePercussion !== false) { layoutPieces(part, src.pieces, src.pitched, ctx); if (part.measures.length) percParts.push(part); }
        continue;
      }
      if (!src.pitched.length) continue;
      const sorted = src.pitched.slice().sort((a, b) => a - b);
      sources.push({ letter, pieces: src.pieces, mean: src.pitched.reduce((a, b) => a + b, 0) / src.pitched.length,
        median: sorted[Math.floor(sorted.length / 2)] });
    }
    const rh = [], lh = [];
    if (sources.length) {
      const byMean = sources.slice().sort((a, b) => b.mean - a.mean);
      const melody = byMean[0], bass = byMean[byMean.length - 1];
      for (const s of sources) {
        if (s === melody) rh.push(s);
        else if (s === bass) lh.push(s);
        else (s.median >= split ? rh : lh).push(s);
      }
    }
    const parts = [];
    const hands = [['RH', 'Piano', rh, { sign: 'G', line: 2 }], ['LH', 'Piano', lh, { sign: 'F', line: 4 }]];
    for (const [letter, name, srcs, clef] of hands) {
      const part = { id: 'P_' + letter, letter, name, percussion: false, clef, measures: [], group: 'piano',
        sourceLetters: srcs.map(s => s.letter) };
      const merged = mergeChordStream(srcs, ctx);
      layoutPieces(part, merged.pieces, merged.pitched, ctx, { clef });
      if (!part.measures.length) {
        // 何も無い手も段は出す(ピアノ譜は常に2段)。小節数は padMeasures が揃える
        part.framesPerUnit = merged.framesPerUnit || 0;
      }
      parts.push(part);
    }
    for (const p of percParts) parts.push(p);
    const notation = finishNotation(compiled, opts, ctx, parts);
    notation.piano = { rh: rh.map(s => s.letter), lh: lh.map(s => s.letter), split };
    return notation;
  };

  // 複数chの音符片を「和音の流れ」(1声部)へ畳む。戻り値 { pieces, pitched, framesPerUnit }
  function mergeChordStream(srcs, ctx) {
    const events = [];   // { start, end, note, onset(打ち直しか) }
    const tempoMarks = new Map(); // pos → bpm(最初の1つ)
    const framePts = [];  // units → frame の対応点(先頭ソースから)
    srcs.forEach((s, si) => {
      let prev = null;
      for (const pc of s.pieces) {
        if (pc.tempo != null && !tempoMarks.has(pc.pos)) tempoMarks.set(pc.pos, pc.tempo);
        if (si === 0) { framePts.push([pc.pos, pc.frameStart]); framePts.push([pc.pos + pc.units, pc.frameStart + pc.frames]); }
        if (pc.rest) { prev = null; continue; }
        if (pc.tieFromPrev && prev && prev.note === pc.note && prev.end === pc.pos) { prev.end = pc.pos + pc.units; continue; }
        prev = { start: pc.pos, end: pc.pos + pc.units, note: pc.note };
        events.push(prev);
      }
    });
    framePts.sort((a, b) => a[0] - b[0]);
    const lastPt = framePts.length ? framePts[framePts.length - 1] : [1, 0];
    const framesPerUnit = lastPt[0] > 0 ? lastPt[1] / lastPt[0] : 0;
    const frameAt = (u) => {
      if (!framePts.length) return 0;
      if (u >= lastPt[0]) return lastPt[1] + (u - lastPt[0]) * framesPerUnit;
      let lo = 0, hi = framePts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (framePts[mid][0] < u) lo = mid + 1; else hi = mid; }
      const b = framePts[lo], a = lo > 0 ? framePts[lo - 1] : [0, 0];
      return b[0] === a[0] ? b[1] : a[1] + (u - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
    };
    const bounds = new Set([0]);
    for (const e of events) { bounds.add(e.start); bounds.add(e.end); }
    for (const p of tempoMarks.keys()) bounds.add(p);
    const B = Array.from(bounds).sort((a, b) => a - b);
    const pieces = [];
    const pitched = [];
    let cur = null;      // 直前の片 { ..., set:Set }
    for (let i = 0; i + 1 < B.length; i++) {
      const t0 = B[i], t1 = B[i + 1];
      const active = events.filter(e => e.start <= t0 && t0 < e.end);
      const onsets = new Set(events.filter(e => e.start === t0).map(e => e.note));
      const notes = Array.from(new Set(active.map(e => e.note))).sort((a, b) => a - b);
      const tempo = tempoMarks.has(t0) ? tempoMarks.get(t0) : null;
      if (!notes.length) {
        if (cur && cur.rest && tempo == null) { cur.units += t1 - t0; cur.frames = frameAt(cur.pos + cur.units) - cur.frameStart; continue; }
        cur = { pos: t0, units: t1 - t0, rest: true, note: null, chord: null, spelled: null, tieFromPrev: false, tieFromPrevSet: null,
          slurFromPrev: false, tempo, srcStart: undefined, srcEnd: undefined, noteIndex: -1, frameStart: frameAt(t0), frames: frameAt(t1) - frameAt(t0), set: new Set() };
        pieces.push(cur);
        continue;
      }
      const same = cur && !cur.rest && cur.set.size === notes.length && notes.every(n => cur.set.has(n));
      if (same && onsets.size === 0 && tempo == null) { cur.units += t1 - t0; cur.frames = frameAt(cur.pos + cur.units) - cur.frameStart; continue; }
      const tieSet = new Set();
      if (cur && !cur.rest) for (const n of notes) if (cur.set.has(n) && !onsets.has(n)) tieSet.add(n);
      cur = { pos: t0, units: t1 - t0, rest: false, note: notes[0], chord: notes, spelled: null, tieFromPrev: false, tieFromPrevSet: tieSet,
        slurFromPrev: false, tempo, srcStart: undefined, srcEnd: undefined, noteIndex: -1, frameStart: frameAt(t0), frames: frameAt(t1) - frameAt(t0), set: new Set(notes) };
      pieces.push(cur);
      for (const n of notes) pitched.push(n);
    }
    return { pieces, pitched, framesPerUnit };
  }

  // noteList(1ch) → 小節割り前の「音符片」列。戻り値 { pieces, pitched }
  function piecesFromNoteList(part, list, ctx) {
    const { U } = ctx;
    const pieces = [];
    let pos = 0;
    let prevPitched = null;   // 直前に出した音程あり片(スラーの起点)
    let lastTempo = null;
    const pitched = [];
    for (let idx = 0; idx < list.length; idx++) {
      const n = list[idx];
      let units = unitsOf(n, U);
      if (!(units > 0) || Math.round(units) !== units) throw new Error(`notation: units が整数になりません ch=${part.letter} #${idx} ${units}`);
      let note = n.note;
      const isRest = n.kind === 'keyOff' || note == null;
      // & の直後の休符/w は直前の音を延ばす(compiler pushNote と同じ)
      let joinedPrev = false, slurFromPrev = false;
      if ((n.joined || n.glide) && prevPitched && prevPitched.endPos === pos) {
        if (n.joined && note == null && n.kind !== 'keyOff') note = prevPitched.note;
        if (note != null) {
          if (n.joined && note === prevPitched.note) joinedPrev = true;   // タイ
          else slurFromPrev = true;                                          // レガート/グライド
        }
      }
      const rest = isRest && note == null;
      const tempo = (lastTempo == null || n.tempo !== lastTempo) ? n.tempo : null;
      lastTempo = n.tempo;
      pieces.push({ pos, units, rest, note: rest ? null : note, chord: null, spelled: n.spelled, tieFromPrev: joinedPrev, tieFromPrevSet: null,
        slurFromPrev, tempo, srcStart: n.srcStart, srcEnd: n.srcEnd, noteIndex: idx, frameStart: n.startFrame, frames: n.frames });
      if (!rest) { prevPitched = { note, endPos: pos + units }; pitched.push(note); }
      pos += units;
    }
    return { pieces, pitched };
  }

  // 音符片の列 → 小節/音符片(Item)の表記モデル。part.measures を埋める。
  // 和音の片(pc.chord=[ノート番号昇順])は item.chord=[{note,pitch,tieStart,tieStop,accidental}] になり、
  // item.pitch/note は最低音(MusicXML の先頭の音)を指す。
  function layoutPieces(part, pieces, pitched, ctx, popts) {
    const { U, measureUnits, key } = ctx;
    popts = popts || {};
    const totalUnits = pieces.reduce((a, p) => a + p.units, 0);
    if (totalUnits === 0) return;
    // フレーム位置(五線表示の時間比例描画用): 各片は noteList の startFrame/frames をそのまま持ち、
    // 分割片は units の比で内挿する。埋め休符は平均のフレーム/units で外挿する
    const totalFramesCh = pieces.reduce((a, p) => a + p.frames, 0);
    const fpu = totalFramesCh / totalUnits;
    part.framesPerUnit = fpu;
    // 最後の小節の余りは休符で埋める(小節の長さは常に拍子どおり)。noteIndex=-1 は「元の音符が無い」印
    if (totalUnits % measureUnits !== 0) {
      const padUnits = measureUnits - (totalUnits % measureUnits);
      pieces.push({ pos: totalUnits, units: padUnits, rest: true, note: null, chord: null, spelled: null,
        tieFromPrev: false, tieFromPrevSet: null, slurFromPrev: false, tempo: null, srcStart: undefined, srcEnd: undefined, noteIndex: -1,
        frameStart: totalFramesCh, frames: padUnits * fpu });
    }

    // 音部記号: 指定 > 打楽器 > 中央値が C4 未満ならヘ音記号
    if (popts.clef) part.clef = popts.clef;
    else if (part.percussion) part.clef = { sign: 'percussion', line: 2 };
    else {
      const sorted = pitched.slice().sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 48;
      part.clef = median < 48 ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 };
    }

    // 小節に割り付ける。小節線をまたぐ片はタイで分割、1音価で書けない長さも分割(decompose)
    const measureCount = Math.ceil(totalUnits / measureUnits);
    const measures = [];
    for (let m = 0; m < measureCount; m++) measures.push({ number: m + 1, startUnits: m * measureUnits, items: [], measureRest: false });

    let lastItem = null;         // 直前に出した Item(スラー/タイの起点)
    let openTuplet = null;       // { actual, normal, accum, items:[...] }
    const closeTuplet = () => { if (openTuplet) { openTuplet.items[openTuplet.items.length - 1].tuplet.stop = true; openTuplet = null; } };
    // 和音の各音のタイ: 前の Item に同じ音があれば tieStart を立てる
    const tieChordNote = (prevItem, item, note) => {
      const cn = item.chord ? item.chord.find(c => c.note === note) : null;
      if (!cn) return;
      if (prevItem.chord) { const pn = prevItem.chord.find(c => c.note === note); if (pn) { pn.tieStart = true; cn.tieStop = true; } }
      else if (prevItem.note === note) { prevItem.tieStart = true; cn.tieStop = true; }
      if (item.chord[0] === cn) { item.tieStop = cn.tieStop; }
    };

    for (const pc of pieces) {
      let at = pc.pos, remain = pc.units, first = true;
      let prevSplitItem = null;
      while (remain > 0) {
        const mi = Math.floor(at / measureUnits);
        const measure = measures[mi];
        const measureEnd = (mi + 1) * measureUnits;
        const chunkUnits = Math.min(remain, measureEnd - at);
        const subs = decompose(chunkUnits, U, pc.rest ? 1 : 2);
        for (let si = 0; si < subs.length; si++) {
          const s = subs[si];
          if (!NOTE_TYPES.has(s.noteType)) throw new Error(`notation: 音価の型が不正 ${s.noteType} (ch=${part.letter} #${pc.noteIndex})`);
          const item = {
            rest: pc.rest, pitch: null, unpitched: null,
            dur: s.units, noteType: s.noteType, dots: s.dots,
            tuplet: s.tuplet ? { actual: s.tuplet.actual, normal: s.tuplet.normal, start: false, stop: false } : null,
            tieStart: false, tieStop: false, slurStart: false, slurStop: false,
            accidental: null, beams: [], tempo: first ? pc.tempo : null,
            note: pc.note, srcStart: pc.srcStart, srcEnd: pc.srcEnd, noteIndex: pc.noteIndex,
            pos: at, continued: !first,
            frameStart: pc.frameStart + ((at - pc.pos) / pc.units) * pc.frames,
            frameEnd: pc.frameStart + ((at - pc.pos + s.units) / pc.units) * pc.frames
          };
          if (!pc.rest) {
            if (part.percussion) item.unpitched = unpitchedOf(pc.note, part);
            else item.pitch = spell(pc.note, key.fifths, pc.spelled);
            if (pc.chord) {
              item.chord = pc.chord.map(n => ({ note: n, pitch: spell(n, key.fifths, null), tieStart: false, tieStop: false, accidental: null }));
            }
          }
          // タイ/スラー: 元の音符の先頭片だけが前の音符と結ぶ。分割片同士は必ずタイ
          if (!pc.rest) {
            if (item.chord) {
              if (first && pc.tieFromPrevSet && pc.tieFromPrevSet.size && lastItem && !lastItem.rest) for (const n of pc.tieFromPrevSet) tieChordNote(lastItem, item, n);
              if (!first && prevSplitItem) {
                for (const cn of item.chord) { cn.tieStop = true; const pn = prevSplitItem.chord.find(c => c.note === cn.note); if (pn) pn.tieStart = true; }
                prevSplitItem.tieStart = true; item.tieStop = true;
              }
            } else {
              if (first && pc.tieFromPrev && lastItem && !lastItem.rest) { lastItem.tieStart = true; item.tieStop = true; }
              if (first && pc.slurFromPrev && lastItem && !lastItem.rest) { lastItem.slurStart = true; item.slurStop = true; }
              if (!first && prevSplitItem) { prevSplitItem.tieStart = true; item.tieStop = true; }
            }
          }
          // 連符の括弧: 同じ比の片が続く間は1グループ。実時間の合計が2進の値になったら閉じる
          if (item.tuplet) {
            if (openTuplet && (openTuplet.actual !== item.tuplet.actual || openTuplet.normal !== item.tuplet.normal || openTuplet.measure !== mi)) closeTuplet();
            if (!openTuplet) { openTuplet = { actual: item.tuplet.actual, normal: item.tuplet.normal, accum: 0, items: [], measure: mi }; item.tuplet.start = true; }
            openTuplet.items.push(item);
            openTuplet.accum += item.dur;
            const g = gcd(openTuplet.accum, U); let q = U / g; while (q % 2 === 0) q /= 2;
            if (q === 1) { item.tuplet.stop = true; openTuplet = null; }
          } else if (openTuplet) {
            closeTuplet();
          }
          measure.items.push(item);
          prevSplitItem = item;
          lastItem = item;
          at += s.units;
          first = false;
        }
        remain -= chunkUnits;
      }
    }
    closeTuplet();

    // 小節ごとの後処理: 全休符の小節、臨時記号、連桁
    const beatUnits = U / ctx.time.beatType;
    const groupUnits = (ctx.time.beatType >= 8 && ctx.time.beats % 3 === 0) ? beatUnits * 3 : beatUnits;
    for (const measure of measures) {
      const items = measure.items;
      if (items.length && items.every(it => it.rest)) {
        const tempo = items.find(it => it.tempo != null);
        measure.items = [{ rest: true, pitch: null, unpitched: null, dur: measureUnits, noteType: 1, dots: 0, tuplet: null,
          tieStart: false, tieStop: false, slurStart: false, slurStop: false, accidental: null, beams: [],
          tempo: tempo ? tempo.tempo : null, note: null, srcStart: items[0].srcStart, srcEnd: items[items.length - 1].srcEnd,
          noteIndex: items[0].noteIndex, pos: measure.startUnits, continued: false, measureRest: true,
          frameStart: items[0].frameStart, frameEnd: items[items.length - 1].frameEnd }];
        measure.measureRest = true;
        measure.frameStart = items[0].frameStart;
        measure.frameEnd = items[items.length - 1].frameEnd;
        continue;
      }
      measure.frameStart = items[0].frameStart;
      measure.frameEnd = items[items.length - 1].frameEnd;
      // 臨時記号: 小節内で「音名+オクターブ」ごとに有効な変化を追う(調号が初期値)。タイの続きには付けない
      if (!part.percussion) {
        const inEffect = {};
        const ka = keyAlters(key.fifths);
        const mark = (p, tieStop) => {
          const k = p.step + p.octave;
          const cur = inEffect[k] != null ? inEffect[k] : ka[p.step];
          const acc = (p.alter !== cur && !tieStop) ? accidentalName(p.alter) : null;
          inEffect[k] = p.alter;
          return acc;
        };
        for (const it of items) {
          if (it.rest || !it.pitch) continue;
          if (it.chord) { for (const cn of it.chord) cn.accidental = mark(cn.pitch, cn.tieStop); it.accidental = it.chord[0].accidental; }
          else it.accidental = mark(it.pitch, it.tieStop);
        }
      }
      // 連桁: 拍(x/8系は3拍)の中で連続する8分以下の音符をまとめる。休符で切る
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const levels = run.map(it => Math.log2(it.noteType) - 2);
          for (let i = 0; i < run.length; i++) {
            for (let lv = 1; lv <= levels[i]; lv++) {
              const prevHas = i > 0 && levels[i - 1] >= lv;
              const nextHas = i < run.length - 1 && levels[i + 1] >= lv;
              let b;
              if (prevHas && nextHas) b = 'continue';
              else if (nextHas) b = 'begin';
              else if (prevHas) b = 'end';
              else b = (i < run.length - 1) ? 'forward hook' : 'backward hook';
              run[i].beams.push(b);
            }
          }
        }
        run = [];
      };
      let curGroup = -1;
      for (const it of items) {
        const beamable = !it.rest && it.noteType >= 8;
        const grp = Math.floor((it.pos - measure.startUnits) / groupUnits);
        if (!beamable || grp !== curGroup) flush();
        curGroup = grp;
        if (beamable) run.push(it);
      }
      flush();
    }
    part.measures = measures;
  }
})(window);
