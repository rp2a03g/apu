'use strict';
/*
 * VGMPlay の NormalizeOverallVolume(2の冪の自動正規化)を再現し、自前の再生音量と
 * ライブラリ全体で「何曲がどれだけ動くか」を先に数える。
 *   absVol = Σ chipVol × _PB_VOL_AMNT/0x100
 *   absVol <= 0x180 なら ×2 を繰り返す / absVol > 0x300 なら ÷2 を繰り返す
 */
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const { load } = require('./load');
const { MML } = load();

// libvgm VGMPlayer::_DEV_LIST の並び(= 拡張ヘッダのチップ音量ID)
const DEV = ['sn76489','ym2413','ym2612','ym2151','segapcm','rf5c68','ym2203','ym2608',
  'ym2610','ym3812','ym3526','y8950','ymf262','ymf278b','ymf271','ymz280b',
  'rf5c164','pwm','ay8910','gb','nes','multipcm','upd7759','okim6258',
  'okim6295','k051649','huc6280','c140','c219','k053260','pokey','qsound',
  'scsp','wswan','vsu','saa1099','es5503','es5506','x1_010','c352',
  'ga20','mikey','k007232','k005289','msm5205','msm5232','bsmt2000','ics2115'];
const CHIP_VOLUME = [0x80,0x200,0x100,0x100,0x180,0xB0,0x100,0x80,
  0x80,0x100,0x100,0x100,0x100,0x100,0x100,0x98,
  0x80,0xE0,0x100,0xC0,0x100,0x40,0x11E,0x1C0,
  0x100,0xA0,0x100,0x100,0x100,0x100,0x100,0x100,
  0x20,0x100,0x100,0x100,0x40,0x20,0x100,0x40,
  0x280,0x100,0x100,0x100,0x100,0x100,0x200,0x40];
const PB_VOL = [0x100,0x80,0x100,0x100,0x100,0x100,0x100,0x100,
  0x100,0x200,0x200,0x200,0x200,0x100,0x100,0x1AF,
  0x200,0x100,0x200,0x400,0x200,0x400,0x100,0x200,
  0x200,0x100,0x100,0x100,0x180,0x100,0x100,0x100,
  0x800,0x100,0x100,0x100,0x800,0x1000,0x100,0x800,
  0x100,0x200,0x100,0x100,0x200,0x100,0x100,0x400];
const IDX = {}; DEV.forEach((d, i) => { IDX[d] = i; });

function normFactor(h) {
  let absVol = 0;
  for (const info of h.usedChips) {
    const i = IDX[info.id];
    if (i === undefined) continue;
    let vol = CHIP_VOLUME[i];
    const n = info.dual ? 2 : 1;
    if (n > 1) vol = Math.floor(vol / n);
    const xv = h.extra.chipVolumes[info.id];
    if (xv !== undefined) vol = Math.round(xv * 0x100);   // 絶対指定(bit15=0)のみ実測で確認済み
    if (info.id === 'k051649') vol = Math.floor(vol * 8 / 5);
    if (info.id === 'c140') vol = Math.floor((vol * 2 + 1) / 3);
    absVol += Math.floor(vol * PB_VOL[i] / 0x100) * n;
  }
  if (!absVol) return { f: 1, absVol: 0 };
  let f = 1, v = absVol;
  if (v <= 0x180) { while (v <= 0x180) { f *= 2; v *= 2; } }
  else if (v > 0x300) { while (v > 0x300) { f /= 2; v = Math.floor(v / 2); } }
  return { f, absVol };
}

function unzip(b) {
  let eo = -1;
  for (let i = b.length - 22; i >= 0; i--) { if (b.readUInt32LE(i) === 0x06054b50) { eo = i; break; } }
  if (eo < 0) return [];
  const n = b.readUInt16LE(eo + 10), cd = b.readUInt32LE(eo + 16);
  let o = cd; const out = [];
  for (let i = 0; i < n; i++) {
    const nl = b.readUInt16LE(o + 28), el = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32);
    const lho = b.readUInt32LE(o + 42), m = b.readUInt16LE(o + 10), cs = b.readUInt32LE(o + 20);
    const lnl = b.readUInt16LE(lho + 26), lel = b.readUInt16LE(lho + 28);
    let dd = b.slice(lho + 30 + lnl + lel, lho + 30 + lnl + lel + cs);
    try { if (m === 8) dd = zlib.inflateRawSync(dd); } catch (e) { dd = null; }
    if (dd) out.push(dd);
    o += 46 + nl + el + cl;
  }
  return out;
}
function walk(d, a) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, a); else a.push(f); } return a; }

const ENV = process.env.MML_CORPUS_ROOT;
const argRoot = (() => { const i = process.argv.indexOf('--corpus-root'); return i >= 0 ? process.argv[i + 1] : null; })();
const base = argRoot || ENV;
if (!base) { console.error('コーパスの場所を MML_CORPUS_ROOT か --corpus-root で指定してください'); process.exit(2); }
const root = path.join(base, 'vgm');
const tally = {};
const byPack = {};
let total = 0;
for (const f of walk(root, []).filter(x => /\.(vgm|vgz|zip)$/i.test(x))) {
  let b; try { b = fs.readFileSync(f); } catch (e) { continue; }
  const label = path.relative(root, f).split(path.sep).join('/');
  for (let d of (/\.zip$/i.test(f) ? unzip(b) : [b])) {
    try { if (d[0] === 0x1f && d[1] === 0x8b) d = zlib.gunzipSync(d); } catch (e) { continue; }
    if (!(d.length > 0x40 && d[0] === 0x56 && d[1] === 0x67)) continue;
    let h; try { h = MML.VGM.parseHeader(new Uint8Array(d)); } catch (e) { continue; }
    if (!h.magicOk) continue;
    const r = normFactor(h);
    total++;
    tally[r.f] = (tally[r.f] || 0) + 1;
    if (r.f !== 1) { (byPack[label] = byPack[label] || { f: new Set(), n: 0 }); byPack[label].f.add(r.f); byPack[label].n++; }
  }
}
console.log('走査した曲数:', total);
console.log('正規化係数の分布:');
for (const k of Object.keys(tally).map(Number).sort((a, b) => a - b)) {
  console.log('  ×' + k + ' : ' + tally[k] + '曲' + (k === 1 ? '  (VGMPlayと同じ=いま合っている)' : '  ← いまズレている'));
}
const packs = Object.entries(byPack).sort((a, b) => b[1].n - a[1].n);
console.log('影響するパック ' + packs.length + '件(上位20):');
for (const [p, v] of packs.slice(0, 20)) console.log('  ' + p + '  ' + v.n + '曲  係数 ' + [...v.f].join(','));
