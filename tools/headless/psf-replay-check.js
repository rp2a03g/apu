/*
 * PSF キャプチャ→SPU 単独再生が元のエミュレーション出力と一致することの確認(ヘッドレス)
 *   node tools/headless/psf-replay-check.js <zip> <曲名の一部> [秒]
 *
 * capturePsfSongAsync(音声あり)の出力と、その frameLog/ramLog を PsfReplay で流し直した
 * 出力を1サンプルずつ比べる。ブラウザ再生(PsfReplayStreamPlayer)が実エミュと同じ音を
 * 出す根拠になる。あわせて1秒あたりの SPU 単独再生コストとログの大きさを出す。
 */
'use strict';
const fs = require('fs');
const { load } = require('./load');
const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });

(async () => {
  const [zp, key, secS] = process.argv.slice(2);
  const sec = parseFloat(secS || '20');
  const z = new Uint8Array(fs.readFileSync(zp));
  const ents = (await MML.Archive.parse(z)).entries;
  const e = ents.find(x => x.name.toLowerCase().includes(key.toLowerCase()) && /\.(psf|minipsf)$/i.test(x.name));
  const info = await MML.PSF.load(await MML.Archive.readEntry(z, e), async n => {
    const x = ents.find(y => y.name.toLowerCase() === n.toLowerCase());
    return x ? MML.Archive.readEntry(z, x) : null;
  });
  const t0 = Date.now();
  const cap = await MML.Emu.capturePsfSongAsync(info, { durationSeconds: sec, yieldFn: async () => {} });
  const tCap = Date.now() - t0;
  const replay = new MML.Emu.PsfReplay(cap);
  const n = cap.frameLog.length * cap.samplesPerFrame;
  const t1 = Date.now();
  let mism = 0, firstMism = -1, maxd = 0;
  for (let i = 0; i < n; i++) {
    replay.step();
    const l = replay.spu.outL / 32768, r = replay.spu.outR / 32768;
    const d = Math.max(Math.abs(l - cap.audioL[i]), Math.abs(r - cap.audioR[i]));
    if (d > 0) { mism++; if (firstMism < 0) firstMism = i; if (d > maxd) maxd = d; }
  }
  const tRep = Date.now() - t1;
  let writes = 0; for (const f of cap.frameLog) writes += f.length / 2;
  let ramBytes = 0; for (const r of cap.ramLog) ramBytes += r.data.length * 2;
  let snapKon = 0; const S = cap.snapshots; for (let f = 1; f < S.length; f++) for (let v = 0; v < 24; v++) if (S[f][v * MML.Emu.PSF_SNAP.VOICE_FIELDS + MML.Emu.PSF_SNAP.SERIAL] !== S[f - 1][v * MML.Emu.PSF_SNAP.VOICE_FIELDS + MML.Emu.PSF_SNAP.SERIAL]) snapKon++;
  console.log(`${e.name}: frames=${cap.frameLog.length} writes=${writes} ramChunks=${cap.ramLog.length} ramBytes=${ramBytes} snapKeyOnChanges=${snapKon}`);
  console.log(`  capture ${tCap}ms (x${(sec * 1000 / tCap).toFixed(1)})  replay ${tRep}ms (x${(sec * 1000 / tRep).toFixed(1)})`);
  console.log(`  mismatched samples=${mism} first=${firstMism} maxdiff=${maxd}`);
  process.exit(mism ? 1 : 0);
})().catch(err => { console.error(err); process.exit(2); });
