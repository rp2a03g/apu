/*
 * テンポ推定+音長量子化のベンチマーク(正解つき合成曲の往復テスト、2026-09-09)
 *
 *   node tools/headless/tempo-bench.js                       既定(テンポ12種 × 三連比率 0/0.3/0.6 = 36曲)
 *   node tools/headless/tempo-bench.js --tempos 120,150 --shares 0,0.6 --gate q8
 *   node tools/headless/tempo-bench.js --preset plain        変換設定を変えて比べる(--cmd も可)
 *   node tools/headless/tempo-bench.js --verbose             曲ごとの行を出す
 *
 * 正解テンポ・正解音価が分かっている MML(4パート: メロディ/和音/ベース/ドラム、三連グループ入り)を
 * 生成 → MML.Mml.compile → NSF 書き出し(Driver.buildBankedNsfBytes) → 実機さながらにキャプチャ →
 * nsf2mml で MML に戻し、
 *   ・BPM正解率(整数一致 / 2倍・半分も許容した格子一致)
 *   ・発音位置一致率(累積位置が ±15tick 以内)
 *   ・音長一致率(正解の音価と ±15tick 以内)
 * を集計する。実曲には正解が無いので、推定器や量子化器を変えたときの退行はここで見る
 * (src/convert/bpm.js / duration.js 冒頭コメントの数値はこのベンチのもの)。
 *
 * 実曲側の比較(現行 vs 新方式、15秒/30秒の安定性、譜面の複雑さ)は正解が無いため
 * ここには入れていない。regress.js --dump の本文 diff で見る。
 */
'use strict';

const conv = require('./convert');
const MML = conv.ctx();

const WHOLE = 1920;
function ticks(den, dots) { return WHOLE / den * (dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75); }
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const NOTES = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];

// 1小節(4拍)ぶんの音価列。tripShare = 三連グループ(3個一組)を選ぶ確率
function bar(r, tripShare, style) {
  const out = []; let left = WHOLE;
  while (left > 0) {
    let choice;
    if (style === 'melody') {
      if (r() < tripShare) {
        const den = r() < 0.6 ? 12 : (r() < 0.6 ? 24 : 6);
        const group = ticks(den, 0) * 3;
        if (group <= left) { for (let i = 0; i < 3; i++) out.push([den, 0]); left -= group; continue; }
      }
      const opts = [[8, 0], [8, 0], [16, 0], [16, 0], [4, 0], [8, 1], [16, 1], [2, 0]];
      choice = opts[Math.floor(r() * opts.length)];
    } else if (style === 'bass') {
      const opts = [[4, 0], [8, 0], [8, 0], [4, 1], [2, 0]];
      choice = opts[Math.floor(r() * opts.length)];
    } else if (style === 'chord') {
      const opts = [[2, 0], [4, 0], [1, 0], [2, 1]];
      choice = opts[Math.floor(r() * opts.length)];
    } else {
      const opts = [[8, 0], [8, 0], [8, 0], [16, 0], [16, 0], [4, 0]];
      choice = opts[Math.floor(r() * opts.length)];
    }
    const t = ticks(choice[0], choice[1]);
    if (t > left) {
      for (const den of [4, 8, 16, 32]) { const tt = ticks(den, 0); while (left >= tt) { out.push([den, 0]); left -= tt; } }
      break;
    }
    out.push(choice); left -= t;
  }
  return out;
}

function partText(seq, r, octave, fixedNote) {
  let s = `o${octave} `, k = Math.floor(r() * 7);
  for (const [den, dots] of seq) {
    const n = fixedNote || NOTES[k % 7]; k += 1 + Math.floor(r() * 3);
    s += `${n}${den}${'.'.repeat(dots)}`;
  }
  return s;
}

function makeSong(o) {
  const r = rng(o.seed);
  const bars = Math.max(2, Math.floor((o.seconds || 18) * o.tempo / 240));
  const parts = { A: [], B: [], C: [], D: [] };
  for (let b = 0; b < bars; b++) {
    parts.A.push(...bar(r, o.tripShare, 'melody'));
    parts.B.push(...bar(r, o.tripShare * 0.5, 'chord'));
    parts.C.push(...bar(r, 0, 'bass'));
    parts.D.push(...bar(r, 0, 'drums'));
  }
  const gate = o.gate || 'q6';
  const src = `#TITLE bench\n` +
    `A t${o.tempo} @0 v12 ${gate} ${partText(parts.A, r, 4)}\n` +
    `B @1 v9 ${gate} ${partText(parts.B, r, 3)}\n` +
    `C v12 ${gate} ${partText(parts.C, r, 2)}\n` +
    `D v10 ${gate} ${partText(parts.D, r, 2, 'c')}\n`;
  const truth = {};
  for (const L of Object.keys(parts)) truth[L] = parts[L].map(([d, dt]) => ticks(d, dt));
  return { src, truth };
}

// 変換結果 MML からパートごとの音符 tick 列を復元(l<n> 追跡、& 結合、休符は直前の音符へ吸収)
function lenTicks(n, dots) { return WHOLE / n * (dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75); }
function parseParts(mml) {
  const parts = {};
  for (const line of mml.split('\n')) {
    const m0 = /^([A-Z]+)\s+(.*)$/.exec(line);
    if (!m0) continue;
    for (const L of m0[1]) {
      if (!parts[L]) parts[L] = { def: 4, defDots: 0, notes: [], tie: false, tokens: 0 };
      scan(m0[2], parts[L]);
    }
  }
  return parts;
}
function scan(s, p) {
  let i = 0; const n = s.length;
  const num = () => { let j = i; while (j < n && /\d/.test(s[j])) j++; const v = j > i ? parseInt(s.slice(i, j), 10) : null; i = j; return v; };
  const dots = () => { let d = 0; while (i < n && s[i] === '.') { d++; i++; } return d; };
  while (i < n) {
    const c = s[i];
    if (c === ';') return;
    if (c === '$') { i++; while (i < n && /[0-9A-Fa-f]/.test(s[i])) i++; continue; }
    if (c === '@') { i++; while (i < n && /[A-Za-z]/.test(s[i])) i++; num(); continue; }
    if (c === '&') { p.tie = true; i++; continue; }
    if (c === 'l') { i++; const v = num(); const d = dots(); if (v) { p.def = v; p.defDots = d; } continue; }
    if (/[a-gr]/.test(c)) {
      i++; if (i < n && /[+#\-]/.test(s[i])) i++;
      const v = num(); const d = dots();
      const t = v ? lenTicks(v, d) : lenTicks(p.def, p.defDots + d);
      p.tokens++;
      if (c === 'r' || p.tie) { if (p.notes.length) p.notes[p.notes.length - 1] += t; }
      else p.notes.push(t);
      p.tie = false; continue;
    }
    if (/[A-Za-z]/.test(c)) { while (i < n && /[A-Za-z]/.test(s[i])) i++; while (i < n && /[\d,\-.]/.test(s[i])) i++; continue; }
    i++;
  }
}

// 発音位置(累積)を突き合わせ、位置一致数と音長一致数を返す
function score(truth, notes) {
  const T = [0]; for (const t of truth) T.push(T[T.length - 1] + t);
  const O = [0]; for (const t of notes) O.push(O[O.length - 1] + t);
  let on = 0, len = 0; const tol = 15; let j = 0;
  for (let i = 0; i < truth.length; i++) {
    while (j + 1 < O.length && O[j + 1] <= T[i] + tol) j++;
    let k = j; if (j + 1 < O.length && Math.abs(O[j + 1] - T[i]) < Math.abs(O[j] - T[i])) k = j + 1;
    if (Math.abs(O[k] - T[i]) <= tol) { on++; if (k < notes.length && Math.abs(notes[k] - truth[i]) <= tol) len++; }
  }
  return { on, len, n: truth.length };
}

(async () => {
  const argv = process.argv.slice(2);
  const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
  const tempos = flag('--tempos', '71,90,100,113,120,128,137,143,150,160,175,200').split(',').map(Number);
  const shares = flag('--shares', '0,0.3,0.6').split(',').map(Number);
  const gate = flag('--gate', 'q6');
  const verbose = argv.includes('--verbose');
  const cmd = conv.parseCmdFlags(flag('--preset', null), flag('--cmd', null));

  const agg = { bpmOk: 0, bpmOct: 0, n: 0, on: 0, len: 0, notes: 0, tok: 0, byShare: {} };
  for (const tempo of tempos) for (const share of shares) {
    const song = makeSong({ tempo, tripShare: share, seed: tempo * 7 + share * 100, gate, seconds: 18 });
    const c = MML.Mml.compile(song.src);
    if (c.errors && c.errors.length) { console.error(`compile error (t${tempo}):`, c.errors[0].message); continue; }
    const nsf = MML.Driver.buildBankedNsfBytes(c, {});
    const r = await conv.convertBytes(nsf.nsfBytes, 'nsf', { seconds: 22, cmd });
    const parts = parseParts(r.mml);
    let on = 0, len = 0, n = 0, tok = 0;
    for (const L of ['A', 'B', 'C', 'D']) {
      const p = parts[L]; if (!p) continue;
      const s = score(song.truth[L], p.notes);
      on += s.on; len += s.len; n += s.n; tok += p.tokens;
    }
    const bpm = Math.round(r.bpm);
    const ok = bpm === tempo, oct = ok || bpm === tempo * 2 || bpm === Math.round(tempo / 2);
    agg.n++; agg.bpmOk += ok ? 1 : 0; agg.bpmOct += oct ? 1 : 0; agg.on += on; agg.len += len; agg.notes += n; agg.tok += tok;
    const bs = agg.byShare[share] = agg.byShare[share] || { n: 0, ok: 0, len: 0, notes: 0 };
    bs.n++; bs.ok += ok ? 1 : 0; bs.len += len; bs.notes += n;
    if (verbose) console.log(`t${String(tempo).padEnd(3)} 三連${share}: 推定 ${String(bpm).padStart(3)}${ok ? ' ○' : oct ? ' △' : ' ×'}  位置一致 ${(100 * on / n).toFixed(0).padStart(3)}%  音長一致 ${(100 * len / n).toFixed(0).padStart(3)}%`);
  }
  console.log(`曲数 ${agg.n}  BPM正解 ${agg.bpmOk}/${agg.n} (2倍/半分許容 ${agg.bpmOct}/${agg.n})  発音位置一致 ${(100 * agg.on / agg.notes).toFixed(1)}%  音長一致 ${(100 * agg.len / agg.notes).toFixed(1)}%  トークン/音符 ${(agg.tok / agg.notes).toFixed(2)}`);
  for (const s of Object.keys(agg.byShare)) {
    const b = agg.byShare[s];
    console.log(`  三連比率 ${s}: BPM ${b.ok}/${b.n}  音長一致 ${(100 * b.len / b.notes).toFixed(1)}%`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
