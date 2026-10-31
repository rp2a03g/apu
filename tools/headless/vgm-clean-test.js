/*
 * 録音の補正(src/vgm/vgmClean.js、変換設定 SFX_REMOVE / LAG_FIX)の点検
 *
 *   node tools/headless/vgm-clean-test.js "song.nsf" [--song n] [--sec s] [--vgm other.vgm] [--dump DIR]
 *
 * ゲームプレイ録音を手で用意しなくても検証できるように、NSF から作った「きれいな VGM」(nsf2vgm.js)に
 * 効果音と処理落ちを人工的に混ぜた「汚れた VGM」を作り、次を確かめる:
 *   1. OFF の不変性: 汚れた VGM を cmd 無指定で変換した MML と、SFX_REMOVE=0,LAG_FIX=0 を明示して変換した
 *      MML が 1 バイトも違わない(--vgm で指定した実ファイルでも同じ検査をする)
 *   2. 効き: 汚れた VGM を両方 ON で補正した VGM に、注入した効果音の書き込みが 1 フレームも残らず、
 *      フレーム数がきれいな VGM と同じ(処理落ちぶんが戻る)。周回ごとに書き込みが少し揺れる曲では多数決の
 *      勝ち負けが変わるので MML の完全一致は求めず、「きれいな VGM に同じ補正を掛けた MML」との行の差を参考に出す
 * 混ぜ方: きれいな VGM の周期 T と周期性の始まり s を vgmClean.js の検出で取り、
 *   効果音 … 2 周目と 3 周目の別々の位相に 45 フレームずつ、パルス1(aa 0-3)とノイズ(aa 0C-0F)の
 *            音楽の書き込みを捨てて代わりの書き込み(下降スイープ+ノイズ)を入れる
 *   処理落ち … 2 周目と 3 周目の別々の位相に空フレーム(0x62 だけ)を 2 枚と 3 枚差し込む
 * 録音は 3 周以上要る(--sec を伸ばす)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ctx, convertBytes } = require('./convert');
const { nsfToVgm } = require('./nsf2vgm');

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const file = argv.find((a, i) => !a.startsWith('-') && !['--song', '--sec', '--vgm', '--dump'].includes(argv[i - 1]));
if (!file) { console.error('usage: vgm-clean-test.js song.nsf [--song n] [--sec s] [--vgm other.vgm] [--dump DIR]'); process.exit(2); }
const song = parseInt(get('--song', '0'), 10);
const seconds = parseFloat(get('--sec', '120'));
const dumpDir = get('--dump', null);
const otherVgm = get('--vgm', null);

// VGM のコマンド列を「フレームごとのコマンドバイト列」に分ける(1 フレーム=0x62 固定の nsf2vgm 出力向け)
function splitFrames(MML, vgm) {
  const h = MML.VGM.parseHeader(vgm);
  const frames = [[]];
  let p = h.dataOffset;
  const end = h.gd3Offset || vgm.length;
  while (p < end) {
    const op = vgm[p];
    if (op === 0x66) break;
    if (op === 0x62) { frames.push([]); p++; continue; }
    if (op === 0x61) { // nsf2vgm は続く空フレームを 0x61(735 の倍数)にまとめる
      const n = vgm[p + 1] | (vgm[p + 2] << 8);
      // nsf2vgm は曲の終わりの端数の待ちも 0x61 で書くので、735 の倍数でない分は切り捨てる
      for (let i = 0; i < Math.floor(n / 735); i++) frames.push([]);
      p += 3; continue;
    }
    let len;
    if (op === 0x67) len = 7 + ((vgm[p + 3] | (vgm[p + 4] << 8) | (vgm[p + 5] << 16) | (vgm[p + 6] << 24)) & 0x7FFFFFFF);
    else { const n = MML.VGM.operandLength(op); if (n < 0 || op === 0x63 || (op >= 0x70 && op <= 0x7F)) throw new Error('unexpected cmd ' + op.toString(16) + ' at ' + p); len = 1 + n; }
    frames[frames.length - 1].push(Array.from(vgm.subarray(p, p + len)));
    p += len;
  }
  if (!frames[frames.length - 1].length) frames.pop();
  return { header: vgm.subarray(0, h.dataOffset), gd3: h.gd3Offset ? vgm.subarray(h.gd3Offset) : new Uint8Array(0), frames };
}
function joinFrames(parts) {
  const body = [];
  for (const fr of parts.frames) { for (const c of fr) for (const b of c) body.push(b); body.push(0x62); }
  body.push(0x66);
  const out = new Uint8Array(parts.header.length + body.length + parts.gd3.length);
  out.set(parts.header, 0); out.set(body, parts.header.length); out.set(parts.gd3, parts.header.length + body.length);
  const u32 = (off, v) => { out[off] = v & 0xFF; out[off + 1] = (v >> 8) & 0xFF; out[off + 2] = (v >> 16) & 0xFF; out[off + 3] = (v >>> 24) & 0xFF; };
  u32(0x04, out.length - 4);
  u32(0x14, parts.gd3.length ? parts.header.length + body.length - 0x14 : 0);
  u32(0x18, parts.frames.length * 735);
  return out;
}
const isApu = (c, lo, hi) => c[0] === 0xB4 && c[1] >= lo && c[1] <= hi;

// 効果音: フレーム [f0, f0+n) のパルス1とノイズの音楽書き込みを捨て、代わりの書き込みを入れる
function injectSfx(frames, f0, n) {
  for (let i = 0; i < n && f0 + i < frames.length; i++) {
    const fr = frames[f0 + i].filter(c => !(isApu(c, 0x00, 0x03) || isApu(c, 0x0C, 0x0F)));
    const period = 0x100 + i * 9;
    fr.push([0xB4, 0x00, 0x3F], [0xB4, 0x02, period & 0xFF], [0xB4, 0x03, 0x08 | (period >> 8)]);
    fr.push([0xB4, 0x0C, 0x30 | Math.max(0, 15 - (i >> 1))], [0xB4, 0x0E, i & 0x0F], [0xB4, 0x0F, 0x08]);
    frames[f0 + i] = fr;
  }
}
// 処理落ち: フレーム f0 の前に空フレームを n 枚
function injectLag(frames, f0, n) { for (let i = 0; i < n; i++) frames.splice(f0, 0, []); }

// 譜面部分だけ(ヘッダコメントの「; ※ 効果音除去/処理落ち補正」行は ON のときだけ出るので比較から外す)
function scoreLines(mml) { return mml.split('\n').filter(l => !/^; ※ (効果音除去|処理落ち補正|録音の補正)/.test(l)); }
function diffLines(a, b) {
  const A = scoreLines(a), B = scoreLines(b);
  const cnt = new Map();
  for (const l of A) cnt.set(l, (cnt.get(l) || 0) + 1);
  for (const l of B) cnt.set(l, (cnt.get(l) || 0) - 1);
  let plus = 0, minus = 0; const ex = [];
  let nm = 0, np = 0;
  for (const [l, c] of cnt) { if (c > 0) { minus += c; if (nm++ < 5) ex.push('- ' + l.slice(0, 110)); } else if (c < 0) { plus -= c; if (np++ < 5) ex.push('+ ' + l.slice(0, 110)); } }
  return { plus, minus, ex };
}

(async () => {
  const MML = ctx();
  const nsf = new Uint8Array(fs.readFileSync(file));
  const clean = nsfToVgm(nsf, { song, seconds, name: path.basename(file) }).vgm;
  const det = MML.VGM.cleanCapture(clean, { sfx: true }).report.sfx;
  if (!det.period) { console.error(`周期が出ない(${det.reason}、候補 ${det.candidates || '-'})。別の曲か長さで`); process.exit(1); }
  const T = det.period, s = det.start, laps = det.laps;
  console.log(`clean: ${clean.length} bytes, 周期 ${T} フレーム, 周期性の始まり ${s}, ${laps} 周 (一致率 ${(det.score * 100).toFixed(1)}%)`);
  if (laps < 3) { console.error('3 周以上要る。--sec を伸ばす'); process.exit(1); }

  const parts = splitFrames(MML, clean);
  const frames = parts.frames;
  // 後ろから差し込む(前の位置がずれないように)
  injectLag(frames, s + Math.round(2.7 * T), 3);
  injectSfx(frames, s + Math.round(2.4 * T), 45);
  injectLag(frames, s + Math.round(1.55 * T), 2);
  injectSfx(frames, s + Math.round(1.2 * T), 45);
  const dirty = joinFrames(parts);
  console.log(`dirty: ${dirty.length} bytes, ${frames.length} フレーム(効果音 2 箇所×45、処理落ち 2+3 フレーム)`);
  if (dumpDir) { fs.mkdirSync(dumpDir, { recursive: true }); fs.writeFileSync(path.join(dumpDir, 'clean.vgm'), clean); fs.writeFileSync(path.join(dumpDir, 'dirty.vgm'), dirty); }

  const sec = frames.length / 60;
  const conv = async (bytes, cmd) => (await convertBytes(bytes, 'vgm', { seconds: sec, cmd })).mml;
  let fail = 0;
  // 1. OFF の不変性
  const offA = await conv(dirty, undefined);
  const offB = await conv(dirty, { SFX_REMOVE: false, LAG_FIX: false });
  console.log(`OFF 不変性(汚れた VGM): ${offA === offB ? 'OK 一致' : 'NG 違う'}`);
  if (offA !== offB) fail++;
  if (otherVgm) {
    const ob = MML.Archive && MML.Archive.gunzipIfNeeded ? MML.Archive.gunzipIfNeeded(new Uint8Array(fs.readFileSync(otherVgm))) : new Uint8Array(fs.readFileSync(otherVgm));
    const oa = await conv(ob, undefined), obm = await conv(ob, { SFX_REMOVE: false, LAG_FIX: false });
    console.log(`OFF 不変性(${path.basename(otherVgm)}): ${oa === obm ? 'OK 一致' : 'NG 違う'}`);
    if (oa !== obm) fail++;
  }
  // 2. 効き
  const cleanMml = await conv(clean, undefined);
  const dOff = diffLines(cleanMml, offA);
  console.log(`汚れた VGM(OFF) vs きれいな VGM: 行の差 -${dOff.minus} +${dOff.plus}(差があって正しい)`);
  const r = MML.VGM.cleanCapture(dirty, { sfx: true, lag: true }).report;
  console.log('補正の報告:', JSON.stringify(r));
  const dirtyOn = MML.VGM.cleanCapture(dirty, { sfx: true, lag: true }).bytes;
  const cleanOnR = MML.VGM.cleanCapture(clean, { sfx: true, lag: true }), cleanOn = cleanOnR.bytes;
  console.log('きれいな VGM への補正の報告:', JSON.stringify(cleanOnR.report));
  if (dumpDir) { fs.writeFileSync(path.join(dumpDir, 'dirty-on.vgm'), dirtyOn); fs.writeFileSync(path.join(dumpDir, 'clean-on.vgm'), cleanOn); }
  const onMml = await conv(dirty, { SFX_REMOVE: true, LAG_FIX: true });
  const dOn = diffLines(cleanMml, onMml);
  console.log(`汚れた VGM(ON) vs きれいな VGM: 行の差 -${dOn.minus} +${dOn.plus}${dOn.minus + dOn.plus === 0 ? ' OK 一致' : ''}`);
  // 周回ごとに書き込みが少し違う曲(エンベロープや LFO の位相がループで戻らない)では、きれいな VGM でも多数決で
  // 1 周目の書き込みが置き換わる。それは汚れの扱いとは別の話なので、合否は「きれいな VGM に同じ補正を掛けた MML」と比べる
  const cleanOnMml = await conv(clean, { SFX_REMOVE: true, LAG_FIX: true });
  const dOnOn = diffLines(cleanOnMml, onMml);
  console.log(`汚れた VGM(ON) vs きれいな VGM(ON): 行の差 -${dOnOn.minus} +${dOnOn.plus}${dOnOn.minus + dOnOn.plus === 0 ? ' 一致' : '(多数決の勝ち負けが変わったぶん。参考)'}`);
  for (const l of dOnOn.ex) console.log('   ' + l);
  // 合否: 注入した効果音(同じフレームに B4 00 3F と B4 0F 08)が残っていない+フレーム数が戻っている
  const A = splitFrames(MML, cleanOn).frames, B = splitFrames(MML, dirtyOn).frames;
  const sfxLeft = B.filter(fr => fr.some(c => c[0] === 0xB4 && c[1] === 0x00 && c[2] === 0x3F) && fr.some(c => c[0] === 0xB4 && c[1] === 0x0F && c[2] === 0x08)).length;
  console.log(`効果音の残り: ${sfxLeft} フレーム ${sfxLeft ? 'NG' : 'OK'} / 補正後のフレーム数: きれい ${A.length} 汚れ ${B.length} ${A.length === B.length ? 'OK' : 'NG'}`);
  if (sfxLeft || A.length !== B.length) fail++;
  if (dOnOn.minus + dOnOn.plus) {
    // どのフレームで違うか(補正後の VGM どうし)
    let shown = 0;
    for (let f = 0; f < Math.min(A.length, B.length) && shown < 8; f++) {
      const x = A[f].map(c => c.map(b => b.toString(16)).join(',')).join('|'), y = B[f].map(c => c.map(b => b.toString(16)).join(',')).join('|');
      if (x !== y) { console.log(`  frame ${f}: きれい ${x.slice(0, 90)} / 汚れ ${y.slice(0, 90)}`); shown++; }
    }
  }
  const dCleanOn = diffLines(cleanMml, cleanOnMml);
  console.log(`参考: きれいな VGM(ON) vs きれいな VGM: 行の差 -${dCleanOn.minus} +${dCleanOn.plus}(周回ごとの書き込みの揺れが多数決で均されたぶん)`);
  const lagOnly = await conv(dirty, { LAG_FIX: true });
  const sfxOnly = await conv(dirty, { SFX_REMOVE: true });
  console.log(`参考: LAG_FIX だけ → 差 ${(() => { const d = diffLines(cleanMml, lagOnly); return `-${d.minus} +${d.plus}`; })()}, SFX_REMOVE だけ → 差 ${(() => { const d = diffLines(cleanMml, sfxOnly); return `-${d.minus} +${d.plus}`; })()}`);
  if (dumpDir) { fs.writeFileSync(path.join(dumpDir, 'clean.mml'), cleanMml); fs.writeFileSync(path.join(dumpDir, 'dirty-off.mml'), offA); fs.writeFileSync(path.join(dumpDir, 'dirty-on.mml'), onMml); }
  for (const l of MML.VGM.describeClean(r)) console.log('; ※ ' + l);
  console.log(fail ? `NG ${fail} 件` : 'ALL OK');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
