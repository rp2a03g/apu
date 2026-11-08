#!/usr/bin/env node
/*
 * C-BIOS(BSD ライセンスの MSX 互換 BIOS)の ROM を、file:// 直開きでも読める JS データ(src/emulator/msx/cbiosData.js)に埋め込む。
 * DESIGN-MSX-CAPTURE.md §3.3 / §9-2(2026-11-08 決定: C-BIOS を同梱し、ROM カートリッジは BIOS 無しで即遊べる)。
 *
 *   node tools/headless/mk-cbios-data.js <C-BIOS を展開したディレクトリ>
 *     ディレクトリから cbios_main_msx1_jp.rom / cbios_main_msx2_jp.rom / cbios_main_msx2+_jp.rom / cbios_sub.rom /
 *     cbios_logo_msx1.rom / cbios_logo_msx2.rom / cbios_logo_msx2+.rom と、ライセンス文(配布物に LICENSE ファイルは無く
 *     doc/cbios.txt の「License」節にある)、版(version.txt)を拾う。
 *     日本語版(_jp)が無ければ国際版(_eu/_us → 無印)を使う。
 *   出力: MML.Emu.CBIOS = { version, license, music, msx1: { main, logo }, msx2: { main, sub, logo }, msx2plus: { main, sub, logo } }
 *     (music = cbios_music.rom、MSX-MUSIC の BIOS 16K。FM-PAC を挿すときと MSX2+ の内蔵 MSX-MUSIC に使う)
 *     (各 ROM は base64。MsxConsole が bios を渡されなかったとき機種に応じて使う)
 * C-BIOS は BASIC・ディスク・漢字を持たないので、カートリッジ専用。turboR は実 BIOS が要る(C-BIOS に無い)。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/headless/mk-cbios-data.js <cbios dir>'); process.exit(2); }
const out = path.resolve(__dirname, '..', '..', 'src', 'emulator', 'msx', 'cbiosData.js');

function find(names) {
  const all = walk(dir);
  for (const n of names) { const hit = all.find((p) => path.basename(p).toLowerCase() === n.toLowerCase()); if (hit) return hit; }
  return null;
}
function walk(d) { let out = []; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) out = out.concat(walk(p)); else out.push(p); } return out; }
function b64(p) { return p ? fs.readFileSync(p).toString('base64') : null; }
function need(names, what) { const p = find(names); if (!p) { console.error('見つかりません:', what, names.join(' / ')); process.exit(1); } console.log(what, '←', path.relative(dir, p), fs.statSync(p).size, 'bytes'); return p; }

const roms = {
  msx1: { main: need(['cbios_main_msx1_jp.rom', 'cbios_main_msx1.rom', 'cbios_main_msx1_eu.rom'], 'msx1.main'), logo: find(['cbios_logo_msx1.rom']) },
  msx2: { main: need(['cbios_main_msx2_jp.rom', 'cbios_main_msx2.rom', 'cbios_main_msx2_eu.rom'], 'msx2.main'), sub: need(['cbios_sub.rom'], 'msx2.sub'), logo: find(['cbios_logo_msx2.rom']) },
  msx2plus: { main: find(['cbios_main_msx2+_jp.rom', 'cbios_main_msx2+.rom', 'cbios_main_msx2+_eu.rom']), sub: find(['cbios_sub.rom']), logo: find(['cbios_logo_msx2+.rom']) },
};
// 版: version.txt。ライセンス: LICENSE ファイルがあればそれ、無ければ doc/cbios.txt の「License」節(著作権表示+BSD 2 条項)
let version = 'unknown';
const verTxt = find(['version.txt']);
if (verTxt) { const m = /(\d+\.\d+[\w.-]*)/.exec(fs.readFileSync(verTxt, 'utf8')); if (m) version = m[1]; }
let license = null;
const licPath = find(['LICENSE', 'LICENSE.txt', 'COPYING']);
if (licPath) license = fs.readFileSync(licPath, 'utf8');
else {
  const doc = find(['cbios.txt', 'README', 'README.txt']);
  if (doc) {
    const t = fs.readFileSync(doc, 'utf8').replace(/\r\n/g, '\n');
    const m = /\nLicense\n-+\n([\s\S]*?)\n\n\n/.exec(t);
    if (m) license = m[1].trim();
    if (version === 'unknown') { const v = /C-BIOS\s+(\d+\.\d+[\w.-]*)/i.exec(t); if (v) version = v[1]; }
  }
}
if (!license) { console.error('ライセンス文が見つかりません(LICENSE か doc/cbios.txt の License 節)'); process.exit(1); }
console.log('version', version, '/ license', license.split('\n').length, 'lines');

const data = { version, license, music: b64(find(['cbios_music.rom'])) }; // MSX-MUSIC(FM-PAC/内蔵)の BIOS。機種共通
if (data.music) console.log('music ←', 'cbios_music.rom');
for (const [k, v] of Object.entries(roms)) {
  if (!v.main) continue;
  data[k] = { main: b64(v.main), sub: v.sub ? b64(v.sub) : null, logo: v.logo ? b64(v.logo) : null };
}
const header = `/*
 * GENERATED FILE - DO NOT EDIT BY HAND. Built by tools/headless/mk-cbios-data.js from C-BIOS ${version}.
 * C-BIOS is an open source MSX compatible BIOS (BSD 2-clause). The copyright and license text of C-BIOS is kept
 * in MML.Emu.CBIOS.license and shown in the UI. This file only embeds the ROM images so the emulator works from file://.
 * MsxConsole uses these when no BIOS is given (DESIGN-MSX-CAPTURE.md §3.3).
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  Emu.CBIOS = `;
fs.writeFileSync(out, header + JSON.stringify(data, null, 1).replace(/\n/g, '\n  ') + `;
})(typeof window !== 'undefined' ? window : globalThis);
`);
console.log('wrote', out, fs.statSync(out).size, 'bytes');
