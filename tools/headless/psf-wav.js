/*
 * PSF を 44.1kHz WAV に書き出して動作状況を報告する(ヘッドレス)
 *   node tools/headless/psf-wav.js <zip> <entry名の一部> [--sec N] [--out file.wav] [--no-idle]
 *   node tools/headless/psf-wav.js <file.psf|.minipsf> [--sec N] [--out file.wav]
 *
 * 報告: 実行速度(実時間比)、停止理由、未実装のBIOS呼び出し、TTY出力、
 *       キーオン回数/鳴ったボイス、ピーク/RMS。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-idle'].includes(args[i - 1])));
const sec = parseFloat(opt('--sec', '10'));
const noIdle = args.includes('--no-idle');

const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });

async function getBytes() {
  const target = positional[0];
  if (/\.zip$/i.test(target)) {
    const zbytes = new Uint8Array(fs.readFileSync(target));
    const parsed = await MML.Archive.parse(zbytes);
    const entries = parsed.entries.filter(e => !e.isDir);
    const key = (positional[1] || '').toLowerCase();
    const entry = entries.find(e => /\.(psf|minipsf)$/i.test(e.name) && e.name.toLowerCase().includes(key));
    if (!entry) throw new Error('entry not found: ' + key);
    const resolve = async (name) => {
      const e = entries.find(x => x.name.toLowerCase() === name.toLowerCase())
        || entries.find(x => MML.Archive.baseName(x.name).toLowerCase() === MML.Archive.baseName(name).toLowerCase());
      return e ? MML.Archive.readEntry(zbytes, e) : null;
    };
    return { name: entry.name, bytes: await MML.Archive.readEntry(zbytes, entry), resolve };
  }
  const dir = path.dirname(target);
  return {
    name: path.basename(target), bytes: new Uint8Array(fs.readFileSync(target)),
    resolve: async (n) => { const p = path.join(dir, n); return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null; },
  };
}

function writeWav(file, left, right, rate) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32768))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32768))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

(async () => {
  const { name, bytes, resolve } = await getBytes();
  const info = await MML.PSF.load(bytes, resolve);
  const player = new MML.Emu.PsfPlayer(info);
  if (noIdle) player.idleSkip = false;
  const spu = player.spu;
  let keyOns = 0;
  const voicesUsed = new Set();
  const startAddrs = new Set();
  spu.onKeyOn = (v, addr) => { keyOns++; voicesUsed.add(v); startAddrs.add(addr); };
  let spuWrites = 0;
  spu.onWrite = () => { spuWrites++; };

  const total = Math.round(sec * 44100);
  const L = new Float32Array(total), R = new Float32Array(total);
  const t0 = Date.now();
  const chunk = 44100;
  const perSecond = [];
  for (let off = 0; off < total; off += chunk) {
    const n = Math.min(chunk, total - off);
    player.renderInto(L, R, off, n);
    let pk = 0; for (let i = off; i < off + n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    perSecond.push(pk.toFixed(2));
  }
  const elapsed = (Date.now() - t0) / 1000;
  let peak = 0, sum = 0;
  for (let i = 0; i < total; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); sum += L[i] * L[i] + R[i] * R[i]; }
  const rms = Math.sqrt(sum / (total * 2));
  const out = opt('--out', path.join(process.env.TEMP || '.', 'psf-out.wav'));
  writeWav(out, L, R, 44100);
  const b = player.bios;
  console.log(`${name}: title="${info.title}" refresh=${info.refresh} len=${info.lengthMs}ms libs=[${info.libs}]`);
  console.log(`  render ${sec}s in ${elapsed.toFixed(2)}s (x${(sec / elapsed).toFixed(2)} realtime), cycles=${player.cpu.cycles}, idle=${(100 * player.stats.idleCycles / Math.max(1, player.cpu.cycles)).toFixed(1)}%`);
  console.log(`  halted=${player.halted} ${player.haltReason}  pc=0x${(player.cpu.pc >>> 0).toString(16)}  cpuExceptions=${player.cpu.exceptionCount} badExc=${b.badExceptions}`);
  console.log(`  bios calls a0=${b.stats.a0} b0=${b.stats.b0} c0=${b.stats.c0} exc=${b.stats.exc} syscall=${b.stats.syscall} softCalls=${b.stats.softCalls} events=${b.stats.events} jmpBuf=0x${(b.jmpBuf >>> 0).toString(16)} chains=${b.chains.map(c => c.length).join('/')}`);
  console.log(`  I_MASK=0x${player.bus.iMask.toString(16)} SPUCNT=0x${spu.cnt.toString(16)} timers=${player.bus.counters.map(c => 'm' + c.mode.toString(16) + '/t' + c.target).join(' ')}`);
  if (b.unknownCalls.size) console.log('  unknown:', [...b.unknownCalls.entries()].map(([k, v]) => `${k}x${v}`).join(' '));
  if (b.ttyLog.length) console.log('  tty:', JSON.stringify(b.ttyLog.slice(0, 10).join('')).slice(0, 400));
  console.log(`  spuWrites=${spuWrites} keyOns=${keyOns} voices=[${[...voicesUsed].sort((a, b) => a - b)}] samples=${startAddrs.size}`);
  console.log(`  peak=${peak.toFixed(3)} rms=${(20 * Math.log10(rms + 1e-9)).toFixed(1)}dBFS  per-second peak: ${perSecond.join(' ')}`);
  console.log(`  wav: ${out}`);
})().catch(err => { console.error(err); process.exit(1); });
