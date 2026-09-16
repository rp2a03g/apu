/*
 * PSF のアイドル省略が出力を変えないことの確認(ヘッドレス)
 *   node tools/headless/psf-idle-check.js <zip> <曲名の一部> [秒]
 * idleSkip on/off で波形相関=1・最大差=0・キーオン時刻のずれ=0 になるはず。
 */
const fs=require('fs');
const { load } = require('./load');
const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });
(async()=>{
  const [zp,key,secS]=process.argv.slice(2); const sec=parseFloat(secS||'10');
  const z=new Uint8Array(fs.readFileSync(zp)); const ents=(await MML.Archive.parse(z)).entries;
  const e=ents.find(x=>x.name.toLowerCase().includes(key.toLowerCase()));
  const info=await MML.PSF.load(await MML.Archive.readEntry(z,e), async n=>{const x=ents.find(y=>y.name.toLowerCase()===n.toLowerCase()); return x?MML.Archive.readEntry(z,x):null;});
  const run=(idle)=>{ const p=new MML.Emu.PsfPlayer(info); p.idleSkip=idle; const kon=[]; p.spu.onKeyOn=(v)=>kon.push(p.spu.sampleCount); const t=Date.now(); const r=p.render(Math.round(44100*sec)); return {r, kon, ms:Date.now()-t}; };
  const a=run(true), b=run(false);
  let num=0, da=0, db=0, maxd=0; for(let i=0;i<a.r.left.length;i++){ const x=a.r.left[i], y=b.r.left[i]; num+=x*y; da+=x*x; db+=y*y; maxd=Math.max(maxd,Math.abs(x-y)); }
  const offs=[]; for(let i=0;i<Math.min(a.kon.length,b.kon.length);i++) offs.push(a.kon[i]-b.kon[i]);
  const hist={}; for(const o of offs) hist[o]=(hist[o]||0)+1;
  console.log(e.name, 'idle ms', a.ms, 'noidle ms', b.ms, 'corr', (num/Math.sqrt(da*db)).toFixed(6), 'maxdiff', maxd.toFixed(4), 'keyons', a.kon.length, b.kon.length, 'keyon sample offsets (idle-noidle) hist', JSON.stringify(hist).slice(0,200));
})();
