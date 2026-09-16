/*
 * 合成ch(Emu.PoolChannelRegrouper)の採点(ヘッドレス)
 *   node tools/headless/pool-regroup-score.js <psf|zip|7z> [--song 名前の一部] [--sec 60]
 *        [--hook-pc a8a40 --hook-reg 2 --table 0c43d0 --stride 10]
 *
 * PSF はドライバごと動くので、ドライバ内部の「トラック構造体」を正解ラベルにできる。
 * ボイスの影テーブル(table + voice*stride)へ hook-pc の命令が書き込んだ瞬間の CPU レジスタ hook-reg を
 * そのボイスの持ち主(トラック)として控え、キーオンに結び付ける。既定値は Namco Anthology 1 /
 * Tower of Babel(babel14 で実測: 22 トラック、各トラックが1音色=純度100%)のドライバのもの。
 * 他のドライバではフック位置が違う(自動探索は未実装)。
 *
 * 出力: レーン純度(各レーンで最多トラックの割合)、トラック集中度(各トラックが最多レーンに入った割合)、
 *       1トラックあたりのレーン数。実機ボイス/合成ch/正解を並べる。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');
const { MML } = load({ skip: [/main\.js$/, /capture-worker\.js$/] });

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!target) { console.error('usage: pool-regroup-score.js <psf|zip|7z> [--song babel14] [--sec 60]'); process.exit(2); }
const songPat = new RegExp(opt('--song', '.'), 'i');
const SEC = parseFloat(opt('--sec', '60'));
const HOOK_PC = parseInt(opt('--hook-pc', 'a8a40'), 16) & 0x1FFFFF;
const REG = parseInt(opt('--hook-reg', '2'), 10);
const TABLE = parseInt(opt('--table', '0c43d0'), 16) & 0x1FFFFF;
const STRIDE = parseInt(opt('--stride', '10'), 16);

async function loadPsf() {
  const bytes = new Uint8Array(fs.readFileSync(target));
  if (/\.(mini)?psf$/i.test(target)) {
    const dir = path.dirname(target);
    return { name: path.basename(target), info: await MML.PSF.load(bytes, async n => { const p = path.join(dir, n); return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null; }) };
  }
  const ents = (await MML.Archive.parse(bytes)).entries.filter(e => !e.isDir);
  const e = ents.filter(x => /\.(mini)?psf$/i.test(x.name)).find(x => songPat.test(x.name));
  if (!e) throw new Error('song not found');
  const info = await MML.PSF.load(await MML.Archive.readEntry(bytes, e), async n => {
    const x = ents.find(y => MML.Archive.baseName(y.name).toLowerCase() === MML.Archive.baseName(n).toLowerCase());
    return x ? MML.Archive.readEntry(bytes, x) : null;
  });
  return { name: e.name, info };
}

(async () => {
  const { name, info } = await loadPsf();
  console.log('song:', name);
  const Emu = MML.Emu;
  // CPU とバスを横取りして、影テーブルへの書き込み時のレジスタをボイスの持ち主として控える。
  // キャプチャはトラック推定の試し走らせで Player を何個も作るので、状態は Player(バス/SPU)ごとに持つ
  const OrigCpu = Emu.CPUR3000, OrigBus = Emu.PsxBus;
  Emu.CPUR3000 = class extends OrigCpu { constructor(bus) { super(bus); bus._cpu = this; } };
  Emu.PsxBus = class extends OrigBus { constructor(spu) { super(spu); spu._owner = this._owner = new Array(24).fill(-1); } };
  const truth = new Map(); // 'voice:serial' → トラック(同じ曲を決定的に回すので、試し走らせと本キャプチャで一致する)
  const hookWrite = (orig) => function (addr, v) {
    const p = addr & 0x1FFFFF, cpu = this._cpu;
    if (cpu && (cpu.pc & 0x1FFFFF) === HOOK_PC && (addr & 0x1FFFFFFF) < 0x800000 && p >= TABLE && p < TABLE + 24 * STRIDE) {
      this._owner[((p - TABLE) / STRIDE) | 0] = (cpu.r[REG] >>> 0) & 0x1FFFFF;
    }
    return orig.call(this, addr, v);
  };
  for (const m of ['write8', 'write16', 'write32']) OrigBus.prototype[m] = hookWrite(OrigBus.prototype[m]);
  const origKon = Emu.SpuPsx.prototype.applyKeyOn;
  Emu.SpuPsx.prototype.applyKeyOn = function (bits) {
    const r = origKon.call(this, bits);
    if (this._owner) for (let v = 0; v < 24; v++) if ((bits >> v) & 1) truth.set(v + ':' + this.voices[v].keyOnSerial, this._owner[v]);
    return r;
  };
  const cap = await Emu.capturePsfSongAsync(info, { durationSeconds: SEC, regsOnly: true, yieldFn: async () => {} });
  const tp = cap.trackProbe || {};
  console.log('trackProbe:', tp.found
    ? `found kind=${tp.kind} pc=${tp.pc.toString(16)} ${tp.reg ? 'r' + tp.reg : 'sp+' + tp.stackOff.toString(16)}${tp.tables ? ' table=' + tp.tables.map(t => t.base.toString(16) + '+v*' + t.stride.toString(16)).join(',') : ''} tracks=${tp.tracks.length} purity=${tp.purity.toFixed(3)} overlap=${tp.overlapRate.toFixed(3)}`
    : `not found (${tp.reason || 'off'}) tables=${(tp.tables || []).map(t => t.base.toString(16) + '+v*' + t.stride.toString(16)).join(',')} top=${JSON.stringify(tp.top || [])}`);
  const bank = new Emu.PsxSampleBank(cap.samples);
  const phys = cap.snapshots.map(s => Emu.snapshotPsx(s, bank).map((c, v) => Object.assign(c, { _trk: truth.get(v + ':' + c.seq) })));
  const labeled = [...truth.values()].filter(t => t !== -1).length;
  console.log(`keyons=${truth.size} labeled=${labeled}${labeled < truth.size * 0.9 ? '  ★正解フックの位置がこのドライバに合っていない可能性' : ''}`);

  const score = (label, frames) => {
    const prev = [], recs = [];
    frames.forEach(fr => fr.forEach((c, li) => {
      if (c.active && prev[li] !== c.seq) recs.push({ li, trk: c._trk });
      if (c.active) prev[li] = c.seq;
    }));
    const lanes = new Map(), trks = new Map();
    const bump = (m, a, b) => { if (!m.has(a)) m.set(a, new Map()); m.get(a).set(b, (m.get(a).get(b) || 0) + 1); };
    for (const r of recs) { bump(lanes, r.li, r.trk); bump(trks, r.trk, r.li); }
    const sumMax = (m) => [...m.values()].reduce((a, x) => a + Math.max(...x.values()), 0);
    const per = [...trks.values()].reduce((a, x) => a + x.size, 0) / Math.max(1, trks.size);
    console.log(`${label.padEnd(12)} lanes=${String(lanes.size).padStart(3)}  レーン純度=${(100 * sumMax(lanes) / recs.length).toFixed(1)}%  トラック集中度=${(100 * sumMax(trks) / recs.length).toFixed(1)}%  レーン/トラック=${per.toFixed(1)}  notes=${recs.length}`);
  };
  score('実機ボイス', phys);
  const nLanes = Emu.POOL_CHIP_CHANNELS.psx;
  const rg0 = new Emu.PoolChannelRegrouper(nLanes);
  score('合成ch(音色)', phys.map(s => rg0.step(s.map(c => Object.assign({}, c, { laneKey: null })))));
  const rg = new Emu.PoolChannelRegrouper(nLanes);
  score('合成ch(トラック)', phys.map(s => rg.step(s)));
  if (args.includes('--wide')) {
    const n = parseInt(opt('--wide', '48'), 10);
    const rgw = new Emu.PoolChannelRegrouper(n);
    score(`レーン${n}本(試算)`, phys.map(s => rgw.step(s.concat(Array.from({ length: n - 24 }, () => ({ active: false }))))));
  }
})().catch(err => { console.error(err); process.exit(1); });
