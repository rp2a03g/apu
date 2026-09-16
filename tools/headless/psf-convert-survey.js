/*
 * PSF→MML 変換の品質調査(ヘッドレス)
 *   node tools/headless/psf-convert-survey.js <dir|zip> [--sec 30] [--per 1] [--modes logical,phys]
 *
 * 各曲を指定モード(合成ch/実機スロット)で変換し、コンパイル可否と音程検証(verifyPitch)の
 * checked / diffs(音程違い) / missing(聞こえない) を並べる。既定モードの選定と回帰の目安に使う。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');
const { MML } = load({ skip: [/main\.js$/, /capture-worker\.js$/] });

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const sec = parseFloat(opt('--sec', '30'));
const per = parseInt(opt('--per', '1'), 10);
const modes = opt('--modes', 'logical,phys').split(',');

(async () => {
  const st = fs.statSync(target);
  const zips = st.isDirectory() ? fs.readdirSync(target).filter(f => /\.zip$/i.test(f)).map(f => path.join(target, f)) : [target];
  const tot = {};
  for (const m of modes) tot[m] = { songs: 0, checked: 0, diffs: 0, missing: 0, compileErr: 0, fail: 0 };
  for (const zp of zips) {
    const z = new Uint8Array(fs.readFileSync(zp));
    let ents;
    try { ents = (await MML.Archive.parse(z)).entries.filter(e => !e.isDir); } catch (_) { continue; }
    const songs = ents.filter(e => /\.(psf|minipsf)$/i.test(e.name)).sort((a, b) => MML.Archive.naturalCompare(a.name, b.name));
    if (!songs.length) continue;
    for (let k = 0; k < per && k < songs.length; k++) {
      const e = songs[Math.floor(k * songs.length / per)];
      let info;
      try {
        info = await MML.PSF.load(await MML.Archive.readEntry(z, e), async n => {
          const x = ents.find(y => y.name.toLowerCase() === n.toLowerCase()) || ents.find(y => MML.Archive.baseName(y.name).toLowerCase() === MML.Archive.baseName(n).toLowerCase());
          return x ? MML.Archive.readEntry(z, x) : null;
        });
      } catch (err) { console.log(`LOADFAIL ${path.basename(zp)} / ${e.name}: ${err.message}`); continue; }
      const cells = [];
      for (const m of modes) {
        const T = tot[m];
        try {
          const r = await MML.PSF2MML.fromPsf(info, sec, { yieldFn: async () => {}, poolMode: m });
          const comp = MML.Mml && MML.Mml.compile ? MML.Mml.compile(r.mml) : null;
          const cerr = comp && comp.errors ? comp.errors.length : 0;
          const pc = r.pitchCheck || { checked: 0, diffs: [], missing: 0 };
          T.songs++; T.checked += pc.checked; T.diffs += pc.diffs.length; T.missing += pc.missing; if (cerr) T.compileErr++;
          cells.push(`${m}: bpm${r.bpm} chk${pc.checked} diff${pc.diffs.length} miss${pc.missing}${cerr ? ' CERR' + cerr : ''}`);
        } catch (err) {
          T.fail++;
          cells.push(`${m}: FAIL ${err.message}`);
        }
      }
      console.log(`${path.basename(zp).replace(/ \(EMU\)\.zophar\.zip$/, '')} / ${e.name}  ${cells.join('  |  ')}`);
    }
  }
  console.log('\n== total');
  for (const m of modes) {
    const T = tot[m];
    console.log(`${m}: songs=${T.songs} fail=${T.fail} compileErr=${T.compileErr} checked=${T.checked} diffs=${T.diffs} (${(100 * T.diffs / Math.max(1, T.checked)).toFixed(1)}%) missing=${T.missing} (${(100 * T.missing / Math.max(1, T.checked)).toFixed(1)}%)`);
  }
})().catch(err => { console.error(err); process.exit(1); });
