/*
 * MusicXML 書き出しの MuseScore 往復検証 (MuseScore 4 の CLI が必要)
 *
 *   node tools/headless/score-midi-check.js                 組み込みサンプルMML
 *   node tools/headless/score-midi-check.js song.mml        任意のMMLファイル
 *   node tools/headless/score-midi-check.js --keep DIR      中間ファイル(.musicxml/.mid/MuseScoreのログ)を DIR に残す
 *   node tools/headless/score-midi-check.js --piano         ピアノ2段(buildPianoNotation)で検証(和音は音ごとに照合)
 *
 * やること(作業計画「フェーズ外: 楽譜出力」段階2の受け入れ条件「MIDI 往復のフレーム突き合わせ」):
 *   1. MML → compile() → 表記モデル → .musicxml を書く
 *   2. MuseScore4.exe -o x.mid x.musicxml で MIDI にする(MuseScore が読めた=構造が正しい)
 *   3. MIDI のノート(開始tick/長さ/音高)を、表記モデル(units)から求めた期待値と突き合わせる。
 *      タイで繋いだ音は MIDI では1音になるので表記側も連結して比べる。打楽器パートは音高を見ない
 *   4. MuseScore のログに MusicXML の警告/エラーが無いこと
 *
 * MuseScore の場所: 環境変数 MUSESCORE_EXE、無ければ C:\Program Files\MuseScore 4\bin\MuseScore4.exe
 * 終了コード: 不一致があれば1。MuseScore が無ければ 2。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { load } = require('./load.js');

function findMuseScore() {
  const cands = [process.env.MUSESCORE_EXE, 'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe', 'C:\\Program Files\\MuseScore 3\\bin\\MuseScore3.exe'].filter(Boolean);
  return cands.find(p => fs.existsSync(p)) || null;
}

// ── 最小の SMF パーサ(format 0/1、ノートon/off とテンポだけ) ────────────────
function parseMidi(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('MThd がない');
  p = 8; const format = u16(), ntrk = u16(), ppq = u16();
  const tracks = [];
  for (let t = 0; t < ntrk; t++) {
    if (buf.toString('latin1', p, p + 4) !== 'MTrk') throw new Error('MTrk がない');
    p += 4; const len = u32(); const end = p + len;
    let tick = 0, status = 0; const notes = []; const open = new Map(); let name = '';
    const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end) {
      tick += vlq();
      let b = buf[p];
      if (b & 0x80) { status = b; p++; }
      if (status === 0xff) {
        const type = buf[p++]; const l = vlq(); const data = buf.slice(p, p + l); p += l;
        if (type === 0x03) name = data.toString('utf8');
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l; continue; }
      const hi = status & 0xf0, ch = status & 0x0f;
      const d1 = buf[p++];
      const d2 = (hi === 0xc0 || hi === 0xd0) ? 0 : buf[p++];
      if (hi === 0x90 && d2 > 0) { open.set(ch * 128 + d1, tick); }
      else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
        const k = ch * 128 + d1; const s = open.get(k);
        if (s != null) { notes.push({ tick: s, dur: tick - s, pitch: d1, ch }); open.delete(k); }
      }
    }
    p = end;
    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    tracks.push({ name, notes });
  }
  return { format, ppq, tracks };
}

// 表記モデル → パートごとの期待ノート列 [{tick, dur, pitch(打楽器はnull)}](タイは連結)
function expectedNotes(notation, ppq) {
  const scale = (ppq * 4) / notation.units;
  const out = {};
  for (const part of notation.parts) {
    const list = [];
    let chain = null;
    for (const m of part.measures) {
      for (const it of m.items) {
        if (it.rest) { chain = null; continue; }
        if (it.chord) {
          // 和音: 音ごとにタイを追う(chain は note → 直前のノート)
          const open = chain instanceof Map ? chain : new Map();
          const next = new Map();
          for (const cn of it.chord) {
            const prev = cn.tieStop ? open.get(cn.note) : null;
            if (prev) { prev.dur += it.dur * scale; if (cn.tieStart) next.set(cn.note, prev); continue; }
            const n = { tick: it.pos * scale, dur: it.dur * scale, pitch: cn.note + 12 };
            list.push(n);
            if (cn.tieStart) next.set(cn.note, n);
          }
          chain = next.size ? next : null;
          continue;
        }
        if (it.tieStop && chain && !(chain instanceof Map)) { chain.dur += it.dur * scale; if (!it.tieStart) chain = null; continue; }
        const n = { tick: it.pos * scale, dur: it.dur * scale, pitch: part.percussion ? null : it.note + 12 };
        list.push(n);
        chain = it.tieStart ? n : null;
      }
    }
    list.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    const key = part.group ? part.group : part.name;
    if (out[key]) { out[key].notes = out[key].notes.concat(list).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch); }
    else out[key] = { percussion: part.percussion, notes: list };
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const pianoMode = argv.includes('--piano');
  const keepIdx = argv.indexOf('--keep');
  const keepDir = keepIdx >= 0 ? argv[keepIdx + 1] : null;
  const files = argv.filter((a, i) => !a.startsWith('--') && i !== keepIdx + 1);
  const exe = findMuseScore();
  if (!exe) { console.log('MuseScore が見つかりません(MUSESCORE_EXE を設定してください)'); process.exit(2); }

  const g = load();
  const MML = global.MML || g.MML;
  const source = files.length ? fs.readFileSync(files[0], 'utf8') : MML.Mml.SAMPLE_SOURCE;
  const label = (files.length ? path.basename(files[0], path.extname(files[0])) : 'sample') + (pianoMode ? '-piano' : '');
  const compiled = MML.Mml.compile(source, {});
  if (compiled.errors.length) { console.log('コンパイルエラー: ' + compiled.errors[0].message); process.exit(1); }
  const notation = pianoMode ? MML.Score.buildPianoNotation(compiled, {}) : MML.Score.buildNotation(compiled, {});
  const xml = MML.Score.toMusicXML(notation, {});

  const dir = keepDir || fs.mkdtempSync(path.join(os.tmpdir(), 'score-midi-'));
  fs.mkdirSync(dir, { recursive: true });
  const xmlPath = path.join(dir, label + '.musicxml');
  const midPath = path.join(dir, label + '.mid');
  fs.writeFileSync(xmlPath, xml);
  let log = '';
  try {
    log = execFileSync(exe, ['-o', midPath, xmlPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (e) {
    log = (e.stdout || '') + (e.stderr || '');
    if (!fs.existsSync(midPath)) { console.log('MuseScore の変換に失敗:\n' + log.slice(0, 2000)); process.exit(1); }
  }
  fs.writeFileSync(path.join(dir, label + '.musescore.log'), log);
  const problems = [];
  const badLog = log.split(/\r?\n/).filter(l => /musicxml|import|invalid|error|warn/i.test(l) && !/^qt\./i.test(l));
  for (const l of badLog.slice(0, 10)) problems.push('MuseScore log: ' + l);

  const midi = parseMidi(fs.readFileSync(midPath));
  const want = expectedNotes(notation, midi.ppq);
  const tracks = midi.tracks.filter(t => t.notes.length);
  const names = Object.keys(want);
  console.log(`${label}: MuseScore ${path.basename(exe)} / MIDI format${midi.format} ppq${midi.ppq} トラック${tracks.length}(音符あり) / 表記パート${names.length}`);
  // MuseScore はパート順にトラックを出す(トラック名=part-name)。名前で引けなければ順番で
  let total = 0, mism = 0;
  names.forEach((name, i) => {
    const w = want[name];
    // 多段パート(ピアノ)は MuseScore が段ごとに同名トラックへ分けるので、同名トラックを全部まとめる
    const disp = name === 'piano' ? 'Piano' : name;
    let trs = tracks.filter(t => t.name === disp);
    if (!trs.length && tracks[i]) trs = [tracks[i]];
    if (!trs.length) { problems.push(`${name}: MIDI トラックが無い`); return; }
    // 右手と左手が同じ音を同時に持つと MuseScore は MIDI で片方を長さ0にする(同じchで同じ音は重ねられない)。
    // 表記側も (tick, pitch) が同じ音は1つにまとめ、MIDI の長さ0の音は捨てて比べる
    const got = trs.flatMap(t => t.notes).filter(n => n.dur > 0).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    {
      const seen = new Map();
      for (const n of w.notes) { const k = n.tick + ':' + n.pitch; const p = seen.get(k); if (!p || p.dur < n.dur) seen.set(k, n); }
      w.notes = Array.from(seen.values()).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    }
    if (got.length !== w.notes.length) problems.push(`${name}: 音符数 MIDI ${got.length} != 期待 ${w.notes.length}`);
    const n = Math.min(got.length, w.notes.length);
    for (let k = 0; k < n; k++) {
      total++;
      const a = got[k], b = w.notes[k];
      const tickOk = Math.abs(a.tick - b.tick) <= 1;
      // MuseScore の MIDI 書き出しは音符長を短くしない(タイは連結)。連符の丸めで ±2tick まで許す
      const durOk = Math.abs(a.dur - b.dur) <= 2;
      const pitchOk = b.pitch == null || a.pitch === b.pitch;
      if (!tickOk || !durOk || !pitchOk) {
        mism++;
        if (mism <= 12) problems.push(`${name} #${k}: MIDI tick${a.tick} dur${a.dur} p${a.pitch} / 期待 tick${b.tick} dur${b.dur} p${b.pitch}`);
      }
    }
  });
  console.log(`突き合わせ: ${total}音 不一致${mism}`);
  for (const p of problems) console.log('  NG ' + p);
  console.log(problems.length ? `不一致 ${problems.length}件 (${dir})` : `OK (${dir})`);
  process.exit(problems.length ? 1 : 0);
}

main();
