/*
 * MusicXML → MML 取り込み(src/score/musicxmlImport.js)の往復検証 (ブラウザ不要)
 *
 *   node tools/headless/musicxml-import-check.js              固定ケース + 組み込みサンプル
 *   node tools/headless/musicxml-import-check.js song.musicxml  任意の MusicXML を取り込んで結果の MML を表示(--out で保存)
 *   node tools/headless/musicxml-import-check.js --keep DIR    中間ファイルを DIR に残す
 *
 * 見るもの:
 *   1. MML → (楽譜出力) MusicXML → (取り込み) MML → compile。元の compile と「音ごとの鳴っている区間」が一致する
 *      (音高ごとに [開始,終了) フレームの区間集合を作り、タイ/和音の分け方が違っても同じになる比べ方)
 *   2. ピアノ2段(和音・backup・2段)の MusicXML も同じく往復で一致する
 *   3. MuseScore 4 があれば、MuseScore が保存し直した MusicXML(divisions/声部/タイの書き方が違う)も往復で一致する
 *   4. 固定ケース: タイ、連符(c12)、付点、休符、テンポ変化、♭の調、1パート内の和音→2行、打楽器(D)、.mxl(zip)
 *
 * 終了コード: 不一致があれば1。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { load } = require('./load.js');

const TOL = 1.5; // フレーム。音長の丸め(carry)と MuseScore の書き直しを許す

// compile() の noteList → 音高ごとの区間集合 { note → [[start,end], ...] }(タイ/w は連結、隣接は併合)
// 打楽器ch(ノイズ/DPCM)は音高に意味が無い(取り込みは n<num> に置き換える)ので、音高を -1 に潰して区間だけ比べる
function intervalsOf(compiled, letters) {
  const map = new Map();
  const MML = global.MML;
  for (const ch of letters || compiled.channelLetters) {
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
  // 音高ごとに開始順で並べ、重なり/隣接を併合(和音の重複や行の分け方の違いを吸収)
  for (const [note, arr] of map) {
    arr.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const iv of arr) {
      const last = merged[merged.length - 1];
      if (last && iv.start <= last.end + TOL) last.end = Math.max(last.end, iv.end);
      else merged.push({ start: iv.start, end: iv.end });
    }
    map.set(note, merged);
  }
  return map;
}

function compareIntervals(label, a, b, problems) {
  const notes = new Set([...a.keys(), ...b.keys()]);
  let count = 0, bad = 0;
  for (const note of notes) {
    const x = a.get(note) || [], y = b.get(note) || [];
    if (x.length !== y.length) { bad++; if (bad <= 6) problems.push(`${label}: 音 ${note} の区間数 ${x.length} != ${y.length}`); continue; }
    for (let i = 0; i < x.length; i++) {
      count++;
      if (Math.abs(x[i].start - y[i].start) > TOL || Math.abs(x[i].end - y[i].end) > TOL) {
        bad++;
        if (bad <= 6) problems.push(`${label}: 音 ${note} #${i} [${x[i].start.toFixed(1)},${x[i].end.toFixed(1)}) != [${y[i].start.toFixed(1)},${y[i].end.toFixed(1)})`);
      }
    }
  }
  return { count, bad };
}

function roundTrip(label, MML, source, opts, problems, keepDir) {
  const compiled = MML.Mml.compile(source, {});
  if (compiled.errors.length) { problems.push(`${label}: 元MMLのコンパイルエラー ${compiled.errors[0].message}`); return null; }
  const { xml } = MML.Score.compiledToMusicXML(compiled, opts || {});
  const imp = MML.Score.importMusicXML(xml, {});
  const back = MML.Mml.compile(imp.mml, {});
  if (keepDir) { fs.writeFileSync(path.join(keepDir, label + '.musicxml'), xml); fs.writeFileSync(path.join(keepDir, label + '.imported.mml'), imp.mml); }
  if (back.errors.length) { problems.push(`${label}: 取り込んだMMLのコンパイルエラー ${back.errors[0].message}\n${imp.mml.slice(0, 400)}`); return null; }
  // 元は「取り込み対象になったパート」だけ(打楽器は D のみ、16行超は落ちる)
  const srcLetters = compiled.channelLetters.filter(ch => (compiled.noteList[ch] || []).length);
  const a = intervalsOf(compiled, (opts && opts.letters) || srcLetters);
  const b = intervalsOf(back, null);
  const r = compareIntervals(label, a, b, problems);
  console.log(`${label}: 行 ${imp.info.lines} → ch ${imp.info.channels.map(c => c.letter).join('')}${imp.info.expansions.length ? ' +' + imp.info.expansions.join('/') : ''} / 区間 ${r.count} 不一致 ${r.bad}${imp.warnings.length ? ' / 警告: ' + imp.warnings.join(' ; ') : ''}`);
  return { compiled, xml, imp, back };
}

function findMuseScore() {
  const cands = [process.env.MUSESCORE_EXE, 'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe'].filter(Boolean);
  return cands.find(p => fs.existsSync(p)) || null;
}

function main() {
  const argv = process.argv.slice(2);
  const keepIdx = argv.indexOf('--keep');
  const keepDir = keepIdx >= 0 ? argv[keepIdx + 1] : null;
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
  const files = argv.filter((a, i) => !a.startsWith('--') && i !== keepIdx + 1 && i !== outIdx + 1);
  if (keepDir) fs.mkdirSync(keepDir, { recursive: true });
  const g = load();
  const MML = global.MML || g.MML;
  const problems = [];

  if (files.length) {
    const text = fs.readFileSync(files[0], 'utf8');
    const imp = MML.Score.importMusicXML(text, {});
    const back = MML.Mml.compile(imp.mml, {});
    console.log(imp.mml.slice(0, 3000));
    console.log(`--- ${path.basename(files[0])}: 行 ${imp.info.lines} / ch ${imp.info.channels.map(c => c.letter).join('')} / コンパイルエラー ${back.errors.length} / 警告 ${imp.warnings.join(' ; ')}`);
    if (outFile) fs.writeFileSync(outFile, imp.mml);
    process.exit(back.errors.length ? 1 : 0);
  }

  // ── 固定ケース(自前の書き出し→取り込み) ──
  const cases = [
    ['tie', ';@key 0\nA t120 o4 c4&c8 d4&e8&e8 c1 c2'],
    ['triplet', ';@key 0\nA t120 o4 {ceg}4 c12 e12 g12 c2 {cdefg}4 c4 c2'],
    ['dots', ';@key 0\nA t120 o4 c4. c8 c4.. c16 c2 r4. r8 c2'],
    ['tempo', ';@key 0\nA t120 o4 c4 d4 t90 e4 f4 t150 g1'],
    ['flats', ';@key -3\nA t120 o4 e-4 a-4 b-4 d-4 c1'],
    ['multi', ';@key 0\nA t120 o4 c4 e4 g4 c4\nB t120 o4 e4 g4 b4 e4\nC t120 o3 c1\nD t120 o1 c8 c8 r2.'],
    ['long', ';@key 0\nA t100 o5 ' + 'c8 d8 e8 f8 g8 a8 b8 >c8< '.repeat(6) + 'c1'],
  ];
  for (const [label, src] of cases) roundTrip(label, MML, src, {}, problems, keepDir);
  // 和音の楽譜(ピアノ2段)を取り込むと、和音は行(チャンネル)に分かれ、音の区間は元と同じになる
  roundTrip('piano', MML, ';@key 0\nA t120 o4 c4 e4 g4 c4\nB t120 o4 e4 g4 b4 e4\nC t120 o3 c1\nD t120 o1 c8 c8 r2.', { piano: true }, problems, keepDir);
  roundTrip('piano-held', MML, ';@key 0\nA t120 o5 c8 d8 e8 f8 g2\nB t120 o4 c2 r2\nC t120 o2 c1', { piano: true }, problems, keepDir);
  // 組み込みサンプル(25パート → 16行に収める。落ちた分は比較から除く)
  {
    const compiled = MML.Mml.compile(MML.Mml.SAMPLE_SOURCE, {});
    const src = compiled.channelLetters.filter(ch => (compiled.noteList[ch] || []).length);
    const pitched = src.filter(ch => !MML.Score.partInfoOf(ch, compiled).percussion);
    const perc = src.filter(ch => MML.Score.partInfoOf(ch, compiled).percussion);
    const letters = pitched.slice(0, 16).concat(perc.slice(0, 1));
    roundTrip('sample', MML, MML.Mml.SAMPLE_SOURCE, { letters }, problems, keepDir);
  }
  // .mxl(zip)
  {
    const compiled = MML.Mml.compile(cases[0][1], {});
    const { xml } = MML.Score.compiledToMusicXML(compiled, {});
    if (MML.Archive && MML.Archive.isZip && typeof require('zlib').deflateRawSync === 'function') {
      const zlib = require('zlib');
      const files2 = [['META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'], ['score.musicxml', xml]];
      const parts = [], central = []; let off = 0;
      for (const [name, text] of files2) {
        const data = Buffer.from(text, 'utf8'); const comp = zlib.deflateRawSync(data);
        const crc = require('zlib').crc32 ? require('zlib').crc32(data) : crc32(data);
        const nm = Buffer.from(name, 'utf8');
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
        const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
        parts.push(lh, nm, comp); central.push(ch, nm); off += lh.length + nm.length + comp.length;
      }
      const cd = Buffer.concat(central);
      const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files2.length, 8); eocd.writeUInt16LE(files2.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
      const mxl = new Uint8Array(Buffer.concat([...parts, cd, eocd]));
      MML.Score.importMusicXMLBytes(mxl, 'tie.mxl', {}).then((imp) => {
        const back = MML.Mml.compile(imp.mml, {});
        const r = compareIntervals('mxl', intervalsOf(compiled, null), intervalsOf(back, null), problems);
        console.log(`mxl: 区間 ${r.count} 不一致 ${r.bad}`);
        stage2();
      }).catch((e) => { problems.push('mxl: ' + (e.stack || e)); stage2(); });
    } else stage2();
  }

  function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }

  function stage2() {
    // ── MuseScore が保存し直した MusicXML の取り込み ──
    const exe = findMuseScore();
    if (exe) {
      const dir = keepDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mxml-import-'));
      for (const [label, src, opts] of [['ms-multi', cases[5][1], {}], ['ms-tie', cases[0][1], {}], ['ms-piano', cases[5][1], { piano: true }], ['ms-sample', MML.Mml.SAMPLE_SOURCE, null]]) {
        const compiled = MML.Mml.compile(src, {});
        let o = opts;
        if (o == null) {
          const srcL = compiled.channelLetters.filter(ch => (compiled.noteList[ch] || []).length);
          const pitched = srcL.filter(ch => !MML.Score.partInfoOf(ch, compiled).percussion);
          const perc = srcL.filter(ch => MML.Score.partInfoOf(ch, compiled).percussion);
          o = { letters: pitched.slice(0, 16).concat(perc.slice(0, 1)) };
        }
        const { xml } = MML.Score.compiledToMusicXML(compiled, o);
        const inP = path.join(dir, label + '.in.musicxml'), outP = path.join(dir, label + '.ms.musicxml');
        fs.writeFileSync(inP, xml);
        try { execFileSync(exe, ['-o', outP, inP], { stdio: 'ignore', timeout: 180000 }); } catch (e) { /* 出力があれば続行 */ }
        if (!fs.existsSync(outP)) { problems.push(`${label}: MuseScore の書き直しに失敗`); continue; }
        let imp;
        try { imp = MML.Score.importMusicXML(fs.readFileSync(outP, 'utf8'), {}); } catch (e) { problems.push(`${label}: 取り込み例外 ${e.message}`); continue; }
        const back = MML.Mml.compile(imp.mml, {});
        if (keepDir) fs.writeFileSync(path.join(dir, label + '.imported.mml'), imp.mml);
        if (back.errors.length) { problems.push(`${label}: 取り込んだMMLのコンパイルエラー ${back.errors[0].message}`); continue; }
        const r = compareIntervals(label, intervalsOf(compiled, o.letters || null), intervalsOf(back, null), problems);
        console.log(`${label}(MuseScore 書き直し): 行 ${imp.info.lines} → ch ${imp.info.channels.map(c => c.letter).join('')} / 区間 ${r.count} 不一致 ${r.bad}${imp.warnings.length ? ' / 警告: ' + imp.warnings.join(' ; ') : ''}`);
      }
    } else {
      console.log('(MuseScore が無いので書き直しの往復は省略)');
    }
    for (const p of problems) console.log('  NG ' + p);
    console.log(problems.length ? `不一致 ${problems.length}件` : 'OK');
    process.exit(problems.length ? 1 : 0);
  }
}

main();
