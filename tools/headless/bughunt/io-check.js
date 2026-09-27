/*
 * 入出力と変換の通し検査(耳を使わずに拾える不具合をまとめて)
 *
 *   node tools/headless/bughunt/io-check.js                    (要 MML_CORPUS_ROOT。無ければコーパス無しの項目だけ)
 *   node tools/headless/bughunt/io-check.js --only pipeline,fuzz
 *   node tools/headless/bughunt/io-check.js --json out.json
 *
 * 項目:
 *   pipeline  MML → コンパイル → NSF書き出し → 6502実行(captureSong) の音が JS 再生(Mml.render)と同じか。
 *             書き出した NSF のヘッダ(曲数/拡張音源フラグ)が MML の宣言と合うか。
 *             変換(各形式→MML)の出力も同じ経路に通す。MML → NSF → nsf2mml → MML の往復も見る。
 *   archive   コーパスの zip/7z/rar を全部展開し、サイズと CRC(あるもの)を照合。自作 zip で m3u の順序と曲番号。
 *   sniff     先頭バイトからの形式判定(URLで開く時の経路)が全形式で正しいか
 *   robust    壊れた/切れた/でたらめなファイルをヘッダ解析へ入れて、TypeError 等の「変な例外」や固まりが無いか
 *   fuzz      壊れた MML(空/未閉じ/桁あふれ/深いループ/ランダム変異)でコンパイラが変な例外・固まり・爆発をしないか
 *   flac      FLAC 書き出しの容器(署名/STREAMINFO のサンプル数と MD5)
 *   suites    既存の自己点検(i18n-dupkeys / help-lint / notelist-check / score-check / musicxml-import-check / replay-check)
 *
 * 判定できないもの: 実ブラウザの File System Access / IndexedDB(.dmc 台帳)/ ダウンロードは Node に無いので対象外。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { load, readBytes, ROOT: REPO } = require('../load');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const CORPUS = flag('--corpus-root', process.env.MML_CORPUS_ROOT || null);
const ONLY = (flag('--only', 'pipeline,archive,sniff,robust,fuzz,flac,suites')).split(',');
const JSON_OUT = flag('--json', null);
const SEC = +flag('--sec', '12');
const SR = 44100;
const VERBOSE = argv.includes('--verbose');

const findings = []; // { area, item, pass(true/false/null), detail }
function rec(area, item, pass, detail) {
  findings.push({ area, item, pass, detail });
  if (pass === false || VERBOSE) console.log(`  ${pass === null ? '--' : pass ? 'ok' : 'NG'} [${area}] ${item}: ${detail}`);
}
const UNFRIENDLY = /undefined|null|is not a function|Cannot read|is not iterable|out of bounds|Invalid typed array|Maximum call stack|Invalid array length|DataView|ArrayBuffer/i;
function classifyError(e) {
  const msg = (e && e.message) || String(e);
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || UNFRIENDLY.test(msg)) return { kind: 'unfriendly', msg };
  return { kind: 'friendly', msg };
}

// ---------------------------------------------------------------- スペクトル類似度(playback-check.js と同じ)
const N = 4096;
function fft(re, im) {
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const WIN = new Float32Array(N); for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
const BINS = Math.floor(6000 / (SR / N));
function spec(x, at) {
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[at + i] || 0) * WIN[i];
  fft(re, im);
  const m = new Float32Array(BINS); let e = 0;
  for (let k = 0; k < BINS; k++) { m[k] = Math.hypot(re[k], im[k]); e += m[k] * m[k]; }
  return { m, e: Math.sqrt(e) };
}
function cosSim(a, b) {
  if (a.e < 2 && b.e < 2) return null;
  if (a.e < 2 || b.e < 2) return 0;
  let s = 0; for (let k = 0; k < BINS; k++) s += a.m[k] * b.m[k];
  return s / (a.e * b.e);
}
function similarity(a, b, seconds) {
  const HOP = SR / 10, frames = [];
  for (let t = 0; t + N <= Math.min(a.length, seconds * SR); t += HOP) frames.push({ t, s: spec(a, t) });
  const score = (lag) => { let s = 0, n = 0, min = 1, minAt = 0; for (const f of frames) { const c = cosSim(f.s, spec(b, f.t + lag)); if (c === null) continue; s += c; n++; if (c < min) { min = c; minAt = f.t / SR; } } return { mean: n ? s / n : 1, min: n ? min : 1, minAt, n }; };
  let best = null;
  for (const lag of [-1500, -1000, -500, -200, -100, 0, 100, 200, 500, 1000, 1500]) { const r = score(lag); if (!best || r.mean > best.mean) { best = r; best.lag = lag; } }
  return best;
}

// ---------------------------------------------------------------- 子プロセスで時間制限つきに実行(固まり検出)
function runChild(code, timeoutMs) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, cwd: REPO });
  if (r.error && r.error.code === 'ETIMEDOUT') return { hang: true, out: r.stdout + r.stderr };
  return { hang: false, code: r.status, out: (r.stdout || '') + (r.stderr || ''), signal: r.signal };
}
const CHILD_PRELUDE = `const { MML } = require(${JSON.stringify(path.join(REPO, 'tools/headless/load'))}).load({ strict: true });`;
// 子プロセスのコードは必ず関数の中で動かす(script スコープの const MML は読み込み中の main.js から見えないため)
const childWrap = (body) => `(async () => { ${CHILD_PRELUDE} ${body} })().catch(e => { console.log('ERR ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)); });`;

// ---------------------------------------------------------------- 検査項目
async function pipeline(MML) {
  const cases = [];
  const sample = MML.Mml.sampleSource ? MML.Mml.sampleSource('ja') : null;
  if (sample) cases.push({ label: '組み込みサンプルMML', source: sample });
  cases.push({ label: '手書き(2A03のみ)', source: '#TITLE test\n#EX-NONE\nA t120 l8 o4 @0 v12 cdefgab>c< [cdef]2 L cc\nB t120 l8 o3 @2 v10 c4e4g4c4 L ee\nC t120 l8 o3 cegc L gg\nD t120 l8 @0 v10 cccc L dd\n', roundTrip: true });
  // 変換した曲(形式ごとに1曲、先頭 SEC 秒)
  if (CORPUS) {
    const { convertFile, expandInput, detectFormat } = require('../convert');
    const pick = (sub, exts) => { const d = path.join(CORPUS, sub); if (!fs.existsSync(d)) return null; const f = fs.readdirSync(d).filter(x => exts.includes(path.extname(x).toLowerCase().slice(1))).sort()[0]; return f ? path.join(d, f) : null; };
    for (const [sub, exts] of [['nsf', ['nsf', 'nsfe']], ['spc', ['spc']], ['kss', ['7z', 'zip', 'kss']], ['gbs', ['gbs']], ['hes', ['hes']], ['psf', ['zip']]]) {
      const f = pick(sub, exts);
      if (!f) continue;
      try {
        const inputs = await expandInput(f);
        const first = inputs.find(i => detectFormat(i.name) === sub) || inputs[0];
        const r = await require('../convert').convertBytes(await first.read(), sub, { seconds: SEC, resolveLib: first.resolveLib });
        cases.push({ label: `${sub}→MML(${path.basename(f)})`, source: r.mml, dpcm: r.dmcFiles });
      } catch (e) { rec('pipeline', `${sub}→MML(${path.basename(f)})`, false, `変換で例外: ${e.message}`); }
    }
  }
  for (const c of cases) {
    let compiled;
    const dpcmSamples = {};
    for (const d of (c.dpcm || [])) dpcmSamples[d.name || d.filename] = d.bytes || d.data;
    try { compiled = MML.Mml.compile(c.source, { dpcmSamples }); }
    catch (e) { rec('pipeline', c.label, false, `コンパイル失敗: ${e.message}`); continue; }
    // JS 再生
    let js;
    try { js = MML.Mml.render(c.source, { sampleRate: SR, dpcmSamples }).audio; } catch (e) { rec('pipeline', c.label, false, `Mml.render 例外: ${e.message}`); continue; }
    // NSF 書き出し
    let built;
    try { built = MML.Driver.buildBankedNsfBytes(compiled, { songName: 't', artist: '', copyright: '', totalSongs: 1, startingSong: 1 }); }
    catch (e) { rec('pipeline', c.label, false, `NSF書き出し例外: ${classifyError(e).msg}`); continue; }
    if (built.asmErrors && built.asmErrors.length) { rec('pipeline', c.label, false, `NSFドライバのアセンブル失敗: ${built.asmErrors.map(e => e.message).join('; ')}`); continue; }
    const nsf = built.nsfBytes;
    let h;
    try { h = MML.NSF.parseHeader(nsf); } catch (e) { rec('pipeline', c.label, false, `書き出したNSFのヘッダが読めない: ${e.message}`); continue; }
    // NSF ヘッダの拡張音源はビットマスク(byte 123)。dpcm はチップではないので比べない
    const wantChips = (compiled.expansions || []).filter(x => x !== 'dpcm').map(x => x.toLowerCase()).sort().join(',');
    const gotChips = Object.entries(MML.NSF.CHIP_FLAGS).filter(([, bit]) => (h.extraChips & bit) !== 0).map(([k]) => k.toLowerCase()).sort().join(',');
    rec('pipeline', c.label + ' / NSFヘッダ', h.totalSongs === 1 && wantChips === gotChips, `曲数 ${h.totalSongs} / 拡張音源 MML=[${wantChips}] NSF=[${gotChips}] / ${nsf.length} bytes`);
    // 6502 で実行した音 vs JS 再生
    const sec = Math.min(SEC, js.length / SR);
    let cap;
    try { cap = MML.Emu.captureSong(nsf, { songIndex: 0, durationSeconds: sec + 0.5, sampleRate: SR }); }
    catch (e) { rec('pipeline', c.label, false, `書き出したNSFの実行で例外: ${classifyError(e).msg}`); continue; }
    const s = similarity(js, cap.audio, sec);
    rec('pipeline', c.label + ' / NSF実行 vs JS再生', s.mean >= 0.9 && s.min >= 0.5, `類似度 平均 ${s.mean.toFixed(3)} 最低 ${s.min.toFixed(3)}@${s.minAt.toFixed(1)}s (窓 ${s.n}, lag ${s.lag})`);
    // MML → NSF → nsf2mml → MML → JS再生 の往復
    if (c.roundTrip) {
      try {
        const cap2 = MML.Emu.captureSong(nsf, { songIndex: 0, durationSeconds: sec, sampleRate: SR, mute: {} });
        const r2 = MML.NSF2MML.convert(cap2.writeLog, nsf, h, 0, cap2.initRegs, cap2.initWrites, {});
        const js2 = MML.Mml.render(r2.mml, { sampleRate: SR }).audio;
        const s2 = similarity(js, js2, sec - 0.5);
        rec('pipeline', c.label + ' / NSF→MML往復', s2.mean >= 0.85, `往復後の類似度 平均 ${s2.mean.toFixed(3)} 最低 ${s2.min.toFixed(3)}@${s2.minAt.toFixed(1)}s`);
      } catch (e) { rec('pipeline', c.label + ' / NSF→MML往復', false, `例外: ${classifyError(e).msg}`); }
    }
    // MusicXML 往復(書き出し→取り込み→コンパイル。音符の区間が同じか)。組み込みサンプルは専用の
    // musicxml-import-check.js(suites)が固定ケース込みで見るので、ここでは変換した曲と手書きだけ
    if (c.source === sample) continue;
    try {
      const { xml } = MML.Score.compiledToMusicXML(compiled, {});
      const imp = MML.Score.importMusicXML(xml, {});
      const mml2 = typeof imp === 'string' ? imp : imp.mml;
      const c2 = MML.Mml.compile(mml2, {});
      // 音高ごとの「鳴っている区間」の集合で比べる(musicxml-import-check.js と同じ考え方。タイ/和音の分け方の違いを吸収)
      const a = intervalsOf(MML, compiled), b = intervalsOf(MML, c2);
      const problems = [];
      const { count, bad } = compareIntervals(a, b, problems);
      rec('pipeline', c.label + ' / MusicXML往復', bad === 0, bad ? `区間 ${count} 中 ${bad} 不一致: ${problems.slice(0, 3).join(' / ')}` : `区間 ${count} 件が一致 / XML ${xml.length} 文字`);
    } catch (e) { rec('pipeline', c.label + ' / MusicXML往復', false, `例外: ${classifyError(e).msg}`); }
  }
}
const TOL = 1.5; // フレーム
function intervalsOf(MML, compiled) {
  const map = new Map();
  for (const ch of compiled.channelLetters) {
    const perc = MML.Score.partInfoOf(ch, compiled).percussion;
    const list = (compiled.noteList[ch] || []).map(n => (perc && n.note != null) ? Object.assign({}, n, { note: -1 }) : n);
    let open = null;
    for (const n of list) {
      const s = n.startFrame, e = n.startFrame + n.frames;
      if (n.kind === 'keyOff' || n.note == null) {
        if (n.joined && open && n.kind === 'wait') { open.end = e; continue; }
        if (n.joined && open && n.note == null && n.kind !== 'keyOff') { open.end = e; continue; }
        open = null; continue;
      }
      if (n.joined && open && open.note === n.note && Math.abs(open.end - s) < 0.01) { open.end = e; continue; }
      open = { note: n.note, start: s, end: e };
      if (!map.has(n.note)) map.set(n.note, []);
      map.get(n.note).push(open);
    }
  }
  for (const [note, arr] of map) {
    arr.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const iv of arr) { const last = merged[merged.length - 1]; if (last && iv.start <= last.end + TOL) last.end = Math.max(last.end, iv.end); else merged.push({ start: iv.start, end: iv.end }); }
    map.set(note, merged);
  }
  return map;
}
function compareIntervals(a, b, problems) {
  const notes = new Set([...a.keys(), ...b.keys()]);
  let count = 0, bad = 0;
  for (const note of notes) {
    const x = a.get(note) || [], y = b.get(note) || [];
    if (x.length !== y.length) { bad++; problems.push(`音 ${note} の区間数 ${x.length} != ${y.length}`); continue; }
    for (let i = 0; i < x.length; i++) {
      count++;
      if (Math.abs(x[i].start - y[i].start) > TOL || Math.abs(x[i].end - y[i].end) > TOL) { bad++; problems.push(`音 ${note} #${i} [${x[i].start},${x[i].end}) != [${y[i].start},${y[i].end})`); }
    }
  }
  return { count, bad };
}

async function archive(MML) {
  // 自作 zip: store + deflate、m3u の順序と曲番号($16進)、サブフォルダ
  const files = [
    ['dir/02 b.nsf', Buffer.from('NESM\x1a' + 'x'.repeat(200))],
    ['dir/01 a.nsf', Buffer.from('NESM\x1a' + 'y'.repeat(300))],
    ['dir/list.m3u', Buffer.from('# comment\r\n02 b.nsf::NSF,$0A,Title B,1:00,,\r\n01 a.nsf::NSF,3,Title A\r\n')],
  ];
  const zip = makeZip(files);
  try {
    const { entries } = await MML.Archive.parse(zip);
    const list = await MML.Archive.buildPlaylist(entries, ['nsf'], (e) => MML.Archive.readEntry(zip, e));
    const ok = list.length === 2 && list[0].title === 'Title B' && list[0].song === 10 && list[1].title === 'Title A' && list[1].song === 3;
    rec('archive', '自作zip(m3u順序・$16進曲番号)', ok, JSON.stringify(list.map(l => [l.title, l.song])));
    for (const e of entries) {
      if (e.isDir) continue;
      const data = await MML.Archive.readEntry(zip, e);
      const want = files.find(f => f[0] === e.name)[1];
      rec('archive', `自作zip 展開 ${e.name}`, Buffer.compare(Buffer.from(data), want) === 0, `${data.length} bytes`);
    }
  } catch (e) { rec('archive', '自作zip', false, `例外: ${classifyError(e).msg}`); }
  // 空 zip / エントリ0
  try { const z = makeZip([]); const p = await MML.Archive.parse(z); rec('archive', '空zip', p.entries.length === 0, `entries=${p.entries.length}`); }
  catch (e) { rec('archive', '空zip', false, `例外: ${classifyError(e).msg}`); }

  if (!CORPUS) return;
  const list = [];
  for (const sub of ['kss', 'spc', 'psf', 'vgm', '']) {
    const d = path.join(CORPUS, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (/\.(zip|7z|rar|rsn)$/i.test(f)) list.push(path.join(d, f));
    }
  }
  const zipCrc = (bytes) => {
    const map = new Map();
    const u16 = (o) => bytes[o] | (bytes[o + 1] << 8), u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    let eocd = -1; for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p--) if (u32(p) === 0x06054b50) { eocd = p; break; }
    if (eocd < 0) return map;
    let p = u32(eocd + 16);
    for (let i = 0; i < u16(eocd + 10); i++) { if (u32(p) !== 0x02014b50) break; const nl = u16(p + 28); map.set(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/'), u32(p + 16)); p += 46 + nl + u16(p + 30) + u16(p + 32); }
    return map;
  };
  const crc32 = (b) => zlib.crc32 ? zlib.crc32(b) >>> 0 : null;
  let total = 0, bad = 0, checked = 0;
  for (const f of list.slice(0, 40)) {
    const bytes = readBytes(f);
    let parsed;
    try { parsed = await MML.Archive.parse(bytes); } catch (e) { rec('archive', path.basename(f), false, `解析失敗: ${classifyError(e).msg}`); bad++; continue; }
    const crcs = parsed.type === 'zip' ? zipCrc(bytes) : null;
    let n = 0, err = null;
    for (const e of parsed.entries) {
      if (e.isDir) continue;
      try {
        const data = await MML.Archive.readEntry(bytes, e);
        n++;
        if (data.length !== e.size) { err = `${e.name}: サイズ ${data.length} != ${e.size}`; break; }
        const want = crcs ? crcs.get(e.name) : (e.crc !== undefined && e.crc !== null ? e.crc : null);
        if (want !== null && want !== undefined && crc32(data) !== null) { checked++; if (crc32(data) !== want) { err = `${e.name}: CRC不一致`; break; } }
      } catch (ex) { err = `${e.name}: ${classifyError(ex).msg}`; break; }
    }
    total++;
    if (err) bad++;
    rec('archive', `${path.basename(f)} (${parsed.type}, ${n}件)`, !err, err || 'サイズ/CRC一致');
  }
  rec('archive', 'コーパスの書庫', bad === 0, `${total} 書庫 / CRC照合 ${checked} 件 / 不良 ${bad}`);
}
function makeZip(files) {
  const parts = [], central = [];
  let off = 0;
  const crc = (b) => zlib.crc32 ? zlib.crc32(b) >>> 0 : 0;
  for (const [name, data] of files) {
    const nameB = Buffer.from(name, 'utf8');
    const deflate = name.endsWith('.m3u') ? 0 : 8;
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(deflate, 8);
    lh.writeUInt32LE(crc(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    parts.push(lh, nameB, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(deflate, 10);
    ch.writeUInt32LE(crc(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nameB);
    off += 30 + nameB.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

function sampleFiles() {
  // 形式ごとに1本(コーパスから)。無いものは飛ばす
  const out = {};
  if (!CORPUS) return out;
  const first = (sub, re) => { const d = path.join(CORPUS, sub); if (!fs.existsSync(d)) return null; const f = fs.readdirSync(d).filter(x => re.test(x)).sort()[0]; return f ? path.join(d, f) : null; };
  const add = (k, f) => { if (f) out[k] = readBytes(f); };
  add('nsf', first('nsf', /\.nsf$/i)); add('spc', first('spc', /\.spc$/i)); add('gbs', first('gbs', /\.gbs$/i)); add('hes', first('hes', /\.hes$/i));
  add('zip', first('psf', /\.zip$/i)); add('7z', first('kss', /\.7z$/i)); add('rar', first('', /\.(rsn|rar)$/i));
  const vd = path.join(CORPUS, 'vgm');
  if (fs.existsSync(vd)) for (const e of fs.readdirSync(vd)) { const p = path.join(vd, e); if (fs.statSync(p).isDirectory()) { const g = fs.readdirSync(p).find(x => /\.vgz$/i.test(x)); const v = fs.readdirSync(p).find(x => /\.vgm$/i.test(x)); if (g && !out.vgz) out.vgz = readBytes(path.join(p, g)); if (v && !out.vgm) out.vgm = readBytes(path.join(p, v)); } }
  return out;
}

async function sniff(MML) {
  const files = sampleFiles();
  // 書庫の中身から kss / psf / nsfe も1本ずつ
  try { if (files['7z']) { const l = await MML.Archive.buildPlaylist((await MML.Archive.parse(files['7z'])).entries, ['kss']); if (l[0]) files.kss = await MML.Archive.readEntry(files['7z'], l[0].entry); } } catch (e) { /* skip */ }
  try { if (files.zip) { const l = await MML.Archive.buildPlaylist((await MML.Archive.parse(files.zip)).entries, ['psf', 'minipsf']); if (l[0]) files.psf = await MML.Archive.readEntry(files.zip, l[0].entry); } } catch (e) { /* skip */ }
  try { if (files.rar) { const l = await MML.Archive.buildPlaylist((await MML.Archive.parse(files.rar)).entries, ['nsfe']); if (l[0]) files.nsfe = await MML.Archive.readEntry(files.rar, l[0].entry); } } catch (e) { /* skip */ }
  const want = { nsf: 'nsf', nsfe: 'nsfe', spc: 'spc', kss: 'kss', gbs: 'gbs', hes: 'hes', vgm: 'vgm', vgz: 'vgz', psf: 'psf', zip: 'zip', '7z': '7z', rar: 'rar' };
  for (const [k, b] of Object.entries(files)) {
    let got = null, err = null;
    try { got = MML.UI.UrlLoad.sniffExt(b); } catch (e) { err = classifyError(e).msg; }
    rec('sniff', k, got === want[k], err ? `例外: ${err}` : `判定 ${got} (期待 ${want[k]})`);
  }
  for (const [k, b] of [['空', new Uint8Array(0)], ['3バイト', new Uint8Array([1, 2, 3])], ['テキスト', new TextEncoder().encode('A cdefg\n')]]) {
    try { const got = MML.UI.UrlLoad.sniffExt(b); rec('sniff', k, got === null, `判定 ${got}`); } catch (e) { rec('sniff', k, false, `例外: ${classifyError(e).msg}`); }
  }
}

async function robust(MML) {
  const files = sampleFiles();
  const parsers = {
    nsf: (b) => MML.NSF.normalize(b), spc: (b) => MML.SPC.parseHeader(b), gbs: (b) => MML.GBS.parseHeader(b), hes: (b) => MML.HES.parseHeader(b),
    vgm: (b) => MML.VGM.parseHeader(b), vgz: async (b) => MML.VGM.parseHeader(await MML.Archive.gunzipIfNeeded(b)),
    zip: (b) => MML.Archive.parse(b), '7z': (b) => MML.Archive.parse(b), rar: (b) => MML.Archive.parse(b),
  };
  try { if (files['7z']) { const l = await MML.Archive.buildPlaylist((await MML.Archive.parse(files['7z'])).entries, ['kss']); if (l[0]) { files.kss = await MML.Archive.readEntry(files['7z'], l[0].entry); parsers.kss = (b) => MML.KSS.parseHeader(b); } } } catch (e) { /* skip */ }
  try { if (files.zip) { const l = await MML.Archive.buildPlaylist((await MML.Archive.parse(files.zip)).entries, ['psf', 'minipsf']); if (l[0]) { files.psf = await MML.Archive.readEntry(files.zip, l[0].entry); parsers.psf = (b) => MML.PSF.parse(b); } } } catch (e) { /* skip */ }
  const rng = mulberry(12345);
  for (const [k, parse] of Object.entries(parsers)) {
    const b = files[k];
    if (!b) continue;
    const variants = [];
    for (const n of [0, 1, 4, 15, 16, 63, 64, 127, 128, 255, 256, Math.floor(b.length / 2), b.length - 1]) if (n <= b.length) variants.push([`先頭${n}バイトで切る`, b.subarray(0, n)]);
    const rnd = new Uint8Array(512); for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(rng() * 256);
    variants.push(['でたらめ512バイト', rnd]);
    for (let t = 0; t < 3; t++) { const m = b.slice(); for (let i = 0; i < 16; i++) { const at = Math.floor(rng() * Math.min(m.length, 512)); m[at] ^= 1 << Math.floor(rng() * 8); } variants.push([`ヘッダ付近を16ビット反転#${t}`, m]); }
    const bad = [];
    for (const [label, v] of variants) {
      try { await parse(v); }
      catch (e) { const c = classifyError(e); if (c.kind === 'unfriendly') bad.push(`${label}: ${c.msg.slice(0, 80)}`); }
    }
    rec('robust', `${k} ヘッダ解析(${variants.length}通り)`, bad.length === 0, bad.length ? bad.slice(0, 3).join(' / ') + (bad.length > 3 ? ` (+${bad.length - 3})` : '') : '例外は全て通常のエラー(または解析成功)');
  }
  // 深い経路(エミュレータ起動)に壊れたデータ: 固まり・変な例外。子プロセスで時間制限
  const deep = {
    nsf: 'MML.Emu.captureSong(b, { songIndex: 0, durationSeconds: 2, sampleRate: 22050 })',
    spc: 'new MML.Emu.SpcPlayer(b).renderSeconds(2, 22050)',
    gbs: 'await MML.Emu.captureGbsSongAsync(b, { songIndex: 0, durationSeconds: 2, sampleRate: 22050, yieldFn: async () => {} })',
    hes: 'await MML.Emu.captureHesSongAsync(b, { track: 0, durationSeconds: 2, sampleRate: 22050, yieldFn: async () => {} })',
    kss: 'await MML.Emu.captureKssSongAsync(b, { songIndex: 0, durationSeconds: 2, sampleRate: 22050, yieldFn: async () => {} })',
    vgm: '{ const p = new MML.Emu.VgmPlayer(b); for (let i = 0; i < 120; i++) if (!p.renderFrame(22050, false, true)) break; }',
  };
  for (const [k, code] of Object.entries(deep)) {
    const b = files[k];
    if (!b) continue;
    const tmp = path.join(require('os').tmpdir(), `bughunt-${k}-${process.pid}.bin`);
    const results = [];
    const variants = [['後半を切り落とす(60%)', b.subarray(0, Math.floor(b.length * 0.6))], ['データ部を64ビット反転', (() => { const m = b.slice(); for (let i = 0; i < 64; i++) { const at = 256 + Math.floor(rng() * Math.max(1, m.length - 256)); m[at] ^= 1 << Math.floor(rng() * 8); } return m; })()]];
    for (const [label, v] of variants) {
      fs.writeFileSync(tmp, v);
      const r = runChild(childWrap(`const b = new Uint8Array(require('fs').readFileSync(${JSON.stringify(tmp)})); try { ${code}; console.log('done'); } catch (e) { console.log('ERR ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)); }`), 30000);
      if (r.hang) results.push(`${label}: 30秒で終わらない(固まり)`);
      else if (r.signal || (r.code !== 0)) results.push(`${label}: 異常終了 ${r.signal || r.code} ${r.out.slice(-200).replace(/\s+/g, ' ')}`);
      else { const m = /ERR (\w+): (.*)/.exec(r.out); if (m && (m[1] === 'TypeError' || m[1] === 'RangeError' || UNFRIENDLY.test(m[2]))) results.push(`${label}: ${m[1]}: ${m[2].slice(0, 80)}`); }
    }
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    rec('robust', `${k} 壊れたデータで再生(2秒)`, results.length === 0, results.length ? results.join(' / ') : '固まらず、例外も通常のエラーだけ');
  }
}
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function fuzz(MML) {
  const cases = [
    ['空', ''], ['コメントだけ', '; hello\n'], ['チャンネル文字だけ', 'A'], ['閉じ括弧不足', 'A [cde'], ['開き括弧不足', 'A cde]'], ['ループ回数0', 'A [cde]0'],
    ['l0', 'A l0 c'], ['o99', 'A o99 c'], ['o-1', 'A o-1 c'], ['c%0', 'A c%0'], ['c%999999', 'A c%999999'], ['v99', 'A v99 c'], ['@999', 'A @999 c'],
    ['t0', 'A t0 c'], ['t99999', 'A t99999 c'], ['L 2回', 'A L c L d'], ['末尾&', 'A c&'], ['先頭&', 'A &c'], ['付点だらけ', 'A c1.........'],
    ['n999', 'A n999'], ['@v999', 'A @v999 c'], ['N163 9ch', '#EX-N163 9\nP c'], ['N163 0ch', '#EX-N163 0\nP c'], ['未定義DPCM', 'E @0 c'],
    ['DPCM未読込', '@DPCM0 = { "none.dmc", 15 }\nE @0 c'], ['深いネスト', 'A ' + '['.repeat(30) + 'c' + ']2'.repeat(30)],
    ['長い1行', 'A ' + 'c'.repeat(100000)], ['巨大な音長', 'A c%2147483647'], ['未知コマンド', 'A ç c'], ['全角', 'A ｃｄｅ'],
    ['@EP 未定義', 'A @EP99 c'], ['マクロ再帰', '$X = c $X\nA $X'], ['#EX 不正', '#EX-FOO\nA c'], ['タイトルだけ', '#TITLE x'],
    ['ハイフン', 'A c-'], ['連続ドット', 'A .'], ['0除算風', 'A c0'], ['q0/q99', 'A q0 c q99 c'], ['w大', 'A w9999 c'],
  ];
  // ランダム変異(組み込みサンプルの一部を壊す)
  const rng = mulberry(777);
  const sample = MML.Mml.sampleSource ? MML.Mml.sampleSource('ja') : 'A cdefgab';
  const chunk = sample.slice(0, 4000);
  for (let i = 0; i < 12; i++) {
    let s = chunk;
    for (let k = 0; k < 8; k++) {
      const at = Math.floor(rng() * s.length), op = rng();
      if (op < 0.4) s = s.slice(0, at) + s.slice(at + 1);
      else if (op < 0.8) s = s.slice(0, at) + '[]{}<>&%$@#0123456789cdefgabrLvt'[Math.floor(rng() * 33)] + s.slice(at);
      else s = s.slice(0, at) + s.slice(at, at + 20).repeat(3) + s.slice(at + 20);
    }
    cases.push([`変異#${i}`, s]);
  }
  const bad = [], hangs = [];
  for (const [label, src] of cases) {
    const r = runChild(childWrap(`const src = ${JSON.stringify(src)}; try { const c = MML.Mml.compile(src, {}); console.log('OK frames=' + c.totalFrames); } catch (e) { console.log('ERR ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)); }`), 20000);
    if (r.hang) { hangs.push(label); continue; }
    if (r.signal || r.code !== 0) { bad.push(`${label}: 異常終了 ${r.signal || r.code} ${r.out.slice(-160).replace(/\s+/g, ' ')}`); continue; }
    const m = /ERR (\w+): (.*)/.exec(r.out);
    if (m && (m[1] === 'TypeError' || m[1] === 'RangeError' || m[1] === 'ReferenceError' || UNFRIENDLY.test(m[2]))) bad.push(`${label}: ${m[1]}: ${m[2].slice(0, 100)}`);
    const ok = /OK frames=(\d+)/.exec(r.out);
    if (ok && +ok[1] > 60 * 60 * 60) bad.push(`${label}: ${ok[1]} フレーム(1時間超)の曲になった`);
    if (VERBOSE) console.log(`    ${label}: ${r.out.trim().slice(0, 100)}`);
  }
  rec('fuzz', `MMLコンパイラ(${cases.length}通り)`, bad.length === 0 && hangs.length === 0, [hangs.length ? `固まり(20秒超): ${hangs.join(', ')}` : '', bad.length ? bad.join(' / ') : ''].filter(Boolean).join(' ; ') || '変な例外・固まりなし');
}

async function flac(MML) {
  const n = SR * 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = Math.sin(i * 2 * Math.PI * 440 / SR) * 0.5; R[i] = Math.sin(i * 2 * Math.PI * 660 / SR) * 0.25 + (i % 100 === 0 ? 0.3 : 0); }
  try {
    const blob = await MML.Audio.Flac.encode([L, R], SR, { yieldFn: async () => {} });
    const b = new Uint8Array(await blob.arrayBuffer());
    const sig = String.fromCharCode(...b.subarray(0, 4));
    // STREAMINFO: 4バイトのブロックヘッダの後 34 バイト。総サンプル数は 36bit(オフセット 13.5〜18)、MD5 は 18..34
    const si = b.subarray(8, 8 + 34);
    const total = ((si[13] & 0x0f) * 2 ** 32) + ((si[14] << 24) >>> 0) + (si[15] << 16) + (si[16] << 8) + si[17];
    const md5 = Buffer.from(si.subarray(18, 34)).toString('hex');
    const pcm = Buffer.alloc(n * 4);
    const q = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    for (let i = 0; i < n; i++) { pcm.writeInt16LE(q(L[i]), i * 4); pcm.writeInt16LE(q(R[i]), i * 4 + 2); }
    const wantMd5 = crypto.createHash('md5').update(pcm).digest('hex');
    const sr = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    const ch = ((si[12] >> 1) & 7) + 1, bps = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
    rec('flac', '容器', sig === 'fLaC' && total === n && sr === SR && ch === 2 && bps === 16, `署名 ${sig} / サンプル数 ${total} (期待 ${n}) / ${sr}Hz ${ch}ch ${bps}bit / ${b.length} bytes (WAV比 ${(b.length / (n * 4) * 100).toFixed(0)}%)`);
    rec('flac', 'MD5', md5 === wantMd5, md5 === wantMd5 ? 'PCM の MD5 が一致' : `MD5 不一致 ${md5} != ${wantMd5}(量子化の丸めが違うだけなら害はない)`);
  } catch (e) { rec('flac', '符号化', false, `例外: ${classifyError(e).msg}`); }
}

function suites() {
  const list = [
    ['i18n-dupkeys', ['tools/headless/i18n-dupkeys.js']],
    ['help-lint', ['tools/headless/help-lint.js']],
    ['notelist-check', ['tools/headless/notelist-check.js']],
    ['score-check', ['tools/headless/score-check.js']],
    ['musicxml-import-check', ['tools/headless/musicxml-import-check.js']],
  ];
  if (CORPUS) list.push(['replay-check', ['tools/headless/replay-check.js', '--corpus-root', CORPUS]]);
  for (const [name, args] of list) {
    const r = spawnSync(process.execPath, args.map(a => (a.startsWith('tools/') ? path.join(REPO, a) : a)), { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 << 20, cwd: REPO, env: Object.assign({}, process.env, CORPUS ? { MML_CORPUS_ROOT: CORPUS } : {}) });
    const out = (r.stdout || '') + (r.stderr || '');
    const last = out.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    rec('suites', name, r.status === 0, `${r.status === 0 ? '通過' : '失敗(exit ' + (r.status === null ? r.signal : r.status) + ')'}: ${last}`);
  }
}

async function main() {
  const { MML } = load({ strict: true });
  const t0 = Date.now();
  const run = async (name, fn) => {
    if (!ONLY.includes(name)) return;
    console.log(`== ${name}`);
    const t = Date.now();
    try { await fn(MML); } catch (e) { rec(name, '(全体)', false, `例外: ${(e && e.stack || e).toString().split('\n').slice(0, 2).join(' | ')}`); }
    console.log(`   (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  };
  await run('pipeline', pipeline);
  await run('archive', archive);
  await run('sniff', sniff);
  await run('robust', robust);
  await run('fuzz', fuzz);
  await run('flac', flac);
  await run('suites', suites);
  const ng = findings.filter(f => f.pass === false).length, ok = findings.filter(f => f.pass === true).length;
  console.log(`io-check: OK ${ok} / NG ${ng} / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 1));
  process.exit(ng ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
