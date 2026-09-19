/*
 * PSF 再生ゲインの校正(ヘッドレス)
 *   node tools/headless/psf-loudness.js
 *
 * 各形式の音量バランス調整と同じ手法: gain 適用前の生出力 RMS を実ファイルで測り、
 * 「生RMS × gain」が SPC(gain 2.0)の平均にそろう PSF の gain を出す。
 * 冒頭1秒は飛ばして10秒ぶん。コーパス(MML_CORPUS_ROOT)の spc/ と psf/ の各zip先頭曲を使う。
 *
 *   MML_CORPUS_ROOT=D:/snd node tools/headless/psf-loudness.js
 *   node tools/headless/psf-loudness.js --corpus-root D:/snd
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');
const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });

const argv = process.argv.slice(2);
const ROOT = (() => {
  const i = argv.indexOf('--corpus-root');
  const r = i >= 0 && argv[i + 1] ? argv[i + 1] : process.env.MML_CORPUS_ROOT;
  if (!r) { console.error('コーパスの場所を --corpus-root か環境変数 MML_CORPUS_ROOT で指定してください(spc/ と psf/ を見ます)'); process.exit(2); }
  return r;
})();
const rmsOf = (arrL, arrR) => { let s = 0; for (let i = 0; i < arrL.length; i++) s += arrL[i] * arrL[i] + arrR[i] * arrR[i]; return Math.sqrt(s / (arrL.length * 2)); };

(async () => {
  const spcFiles = fs.readdirSync(path.join(ROOT, 'spc')).filter(f => /\.spc$/i.test(f)).slice(0, 12);
  const spcRms = [];
  for (const f of spcFiles) {
    const p = new MML.Emu.SpcPlayer(new Uint8Array(fs.readFileSync(path.join(ROOT, 'spc', f))));
    const N = 32000 * 11, L = new Float32Array(32000 * 10), R = new Float32Array(32000 * 10);
    for (let i = 0; i < N; i++) { const s = p.renderSample(); if (i >= 32000) { L[i - 32000] = s.L; R[i - 32000] = s.R; } }
    const r = rmsOf(L, R);
    if (r > 1e-4) spcRms.push(r);
  }
  const zips = fs.readdirSync(path.join(ROOT, 'psf')).filter(f => /\.zip$/i.test(f));
  const psfRms = [];
  for (const zf of zips) {
    const z = new Uint8Array(fs.readFileSync(path.join(ROOT, 'psf', zf)));
    let ents; try { ents = (await MML.Archive.parse(z)).entries; } catch (_) { continue; }
    const songs = ents.filter(e => /\.(psf|minipsf)$/i.test(e.name)).sort((a, b) => MML.Archive.naturalCompare(a.name, b.name));
    if (!songs.length) continue;
    const e = songs[0];
    try {
      const info = await MML.PSF.load(await MML.Archive.readEntry(z, e), async n => {
        const x = ents.find(y => y.name.toLowerCase() === n.toLowerCase());
        return x ? MML.Archive.readEntry(z, x) : null;
      });
      const p = new MML.Emu.PsfPlayer(info);
      p.render(44100);
      const r = p.render(44100 * 10);
      const v = rmsOf(r.left, r.right);
      if (v > 1e-4) psfRms.push(v);
    } catch (_) { /* 読めない曲は校正から外す */ }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const spcLoud = mean(spcRms) * 2.0;
  const psfMean = mean(psfRms);
  console.log(`SPC n=${spcRms.length} rawRMS mean=${mean(spcRms).toFixed(4)} → ×2.0 = ${spcLoud.toFixed(4)}`);
  console.log(`PSF n=${psfRms.length} rawRMS mean=${psfMean.toFixed(4)} (min ${Math.min(...psfRms).toFixed(4)} max ${Math.max(...psfRms).toFixed(4)})`);
  console.log(`suggested PSF gain = ${(spcLoud / psfMean).toFixed(2)}`);
})();
