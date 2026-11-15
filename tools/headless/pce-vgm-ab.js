#!/usr/bin/env node
/*
 * PC エンジンの VGM を、自前の再生と VGMPlay の WAV とで比べる(段階 9b)。
 * 波形メモリ音源の「音量の表」と「左右の混ぜ方」は Mesen から読めないので、ここで見る(pce-apu-ab.js の説明を参照)。
 *
 *   node tools/headless/pce-vgm-ab.js --vgmplay "<VGMPlay64.exe のあるフォルダ>" a.vgz b.vgz ... [--sec 30] [--root <別の作業ツリー>]
 *     --vgmplay  そのフォルダの VGMPlay.ini は LogSound = 1(WAV に書くだけ)、MaxLoops = 1 にしておく(手元の VGMPlay を
 *                そのまま使わず、写しを作って書き換える)
 *   node tools/headless/pce-vgm-ab.js --vgmplay "<folder>" --synth [--root <tree>]
 *     --synth    合成した VGM(矩形波 1ch)で、ch の音量($0804)31→0、ch の左右($0805)15→0、全体($0801)15→0 を
 *                0.1 秒ずつ鳴らし、1 段ごとの音量(最初の段からの dB)を自前と VGMPlay で並べる。音量の表と無音になる段を見る
 *     --detail   1 秒ごとの音量(自前 / VGMPlay)も出す
 *     --root     自前の側を別の作業ツリー(作り直し前の HEAD など)で回す。前後の比較用
 *
 * 出す物(1 曲 1 行):
 *   包絡 … 10ms ごとの音量(RMS)の並びの相関。音量の表・左右の混ぜ方・音の出入りの時刻が合っていれば 1 に近い
 *   形   … 4096 点のスペクトル(大きさ)の向きの一致(コサイン類似度)の平均。音程・波形・ノイズの色が合っていれば 1 に近い
 *   波形 … 波形そのものの相関(参考)。この音源は波形が止まらずに回り続けるので、実装どうしで位相が少し違うだけで 0 付近になる。
 *           PCM の石のようには使えない(2026-11-15 に実測: 作り直しの前後とも 0 付近)
 *   音量比 … 自前 / VGMPlay の RMS。曲ごとに 2 倍単位でずれうる(VGMPlay が曲ごとに全体の音量を 2 の冪で合わせ直すため)。合否には使わない
 * ★ VGMPlay の HuC6280 は MAME 由来か Ootake 由来の実装で、実機そのものではない。「別の実装とも合うか」を見ているだけ。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const vgmplayDir = arg('--vgmplay', null);
const sec = parseFloat(arg('--sec', '30'));
const root = arg('--root', null);
const skipNext = new Set(['--vgmplay', '--sec', '--root']);
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !skipNext.has(all[i - 1]) && /\.(vgm|vgz)$/i.test(a));
const exe = vgmplayDir && path.join(vgmplayDir, 'VGMPlay64.exe');
const synth = process.argv.includes('--synth');
if (!exe || !fs.existsSync(exe) || (!files.length && !synth)) { console.error('usage: node tools/headless/pce-vgm-ab.js --vgmplay "<folder>" a.vgz ... [--sec 30] [--root <tree>]'); process.exit(2); }
{
  const ini = fs.readFileSync(path.join(vgmplayDir, 'VGMPlay.ini'), 'utf8');
  if (!/^LogSound\s*=\s*1/m.test(ini)) { console.error('VGMPlay.ini が LogSound = 1 になっていません(手元の VGMPlay を書き換えず、写しのフォルダで設定してください)'); process.exit(2); }
}
const { load } = require(root ? path.join(path.resolve(root), 'tools', 'headless', 'load.js') : './load');
const { MML } = load({ strict: true });
const SR = 44100;

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, Math.min(b.length, p + 8 + len)); break; }
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('読めない WAV');
  const n = Math.floor(data.length / (2 * fmt.ch)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2); out[i] = s / fmt.ch / 32768; }
  return { rate: fmt.rate, mono: out };
}
function corr(a, ao, b, bo, n) {
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[ao + i]; sb += b[bo + i]; }
  const ma = sa / n, mb = sb / n; let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[ao + i] - ma, y = b[bo + i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
// 10ms ごとの RMS の並び(窓ごとに平均を引く。直流分の扱いは実装ごとに違うので、音量として数えない)
function envelope(a, off, n) {
  const W = 441, m = Math.floor(n / W), out = new Float32Array(m);
  for (let k = 0; k < m; k++) { let mean = 0; for (let i = 0; i < W; i++) mean += a[off + k * W + i]; mean /= W; let s = 0; for (let i = 0; i < W; i++) { const v = a[off + k * W + i] - mean; s += v * v; } out[k] = Math.sqrt(s / W); }
  return out;
}
// 4096 点の FFT(ハン窓)の大きさ。再帰しない基数 2
const NFFT = 4096;
const HANN = new Float32Array(NFFT); for (let i = 0; i < NFFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
const REV = new Uint16Array(NFFT); for (let i = 0; i < NFFT; i++) { let r = 0; for (let b = 0; b < 12; b++) if (i & (1 << b)) r |= 1 << (11 - b); REV[i] = r; }
const COS = new Float64Array(NFFT / 2), SIN = new Float64Array(NFFT / 2); for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / NFFT); SIN[i] = Math.sin(2 * Math.PI * i / NFFT); }
function spectrum(a, off, re, im, mag) {
  for (let i = 0; i < NFFT; i++) { re[REV[i]] = a[off + i] * HANN[i]; im[REV[i]] = 0; }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let st = 0; st < NFFT; st += size) for (let k = 0; k < half; k++) {
      const c = COS[k * step], sn = -SIN[k * step], i = st + k, j = i + half;
      const tr = re[j] * c - im[j] * sn, ti = re[j] * sn + im[j] * c;
      re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
    }
  }
  for (let i = 0; i < NFFT / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
}
function shape(a, ao, b, bo, n) {
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), ma = new Float64Array(NFFT / 2), mb = new Float64Array(NFFT / 2);
  let sum = 0, cnt = 0;
  for (let p = 0; p + NFFT <= n; p += NFFT / 2) {
    spectrum(a, ao + p, re, im, ma); spectrum(b, bo + p, re, im, mb);
    let ab = 0, aa = 0, bb = 0;
    for (let i = 1; i < NFFT / 2; i++) { ab += ma[i] * mb[i]; aa += ma[i] * ma[i]; bb += mb[i] * mb[i]; }
    if (bb < 1e-6) continue; // 無音の区間は数えない
    sum += aa > 0 ? ab / Math.sqrt(aa * bb) : 0; cnt++;
  }
  return cnt ? sum / cnt : NaN;
}
const rms = (a, n) => { let m = 0; for (let i = 0; i < n; i++) m += a[i]; m /= n; let s = 0; for (let i = 0; i < n; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / n); };

// ── 合成 VGM: 音量の表を 1 段ずつ ──
if (synth) {
  const STEP = 4410; // 0.1 秒
  const cmds = [];
  const w = (reg, v) => cmds.push(0xB9, reg, v);
  const wait = (n) => cmds.push(0x61, n & 0xFF, n >> 8);
  const steps = [];
  w(0, 0); w(1, 0xFF); w(4, 0x40); w(4, 0x00);            // ch1 を選ぶ。DDA+切で書き位置を 0 に
  for (let i = 0; i < 32; i++) w(6, i < 16 ? 31 : 0);     // 矩形波
  w(2, 0x00); w(3, 0x01); w(5, 0xFF);                     // 周期 256(約 437Hz)、左右とも最大
  for (let v = 31; v >= 0; v--) { w(4, 0x80 | v); wait(STEP); steps.push('ch の音量 ' + v); }
  w(4, 0x9F);
  for (let p = 15; p >= 0; p--) { w(5, (p << 4) | p); wait(STEP); steps.push('ch の左右 ' + p); }
  w(5, 0xFF);
  for (let g = 15; g >= 0; g--) { w(1, (g << 4) | g); wait(STEP); steps.push('全体 ' + g); }
  cmds.push(0x66);
  const head = Buffer.alloc(0x100);
  head.write('Vgm ', 0, 'ascii');
  head.writeUInt32LE(0x100 + cmds.length - 4, 0x04);
  head.writeUInt32LE(0x161, 0x08);
  head.writeUInt32LE(steps.length * STEP, 0x18);
  head.writeUInt32LE(0x100 - 0x34, 0x34);
  head.writeUInt32LE(3579545, 0xA4);
  const raw = Buffer.concat([head, Buffer.from(cmds)]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-vgm-'));
  const copy = path.join(work, 'synth.vgm');
  fs.writeFileSync(copy, raw);
  spawnSync(exe, [copy], { cwd: vgmplayDir, input: '', encoding: 'utf8', timeout: 120000 });
  const ref = readWav(path.join(work, 'synth.wav'));
  fs.rmSync(work, { recursive: true, force: true });
  const player = new MML.Emu.VgmPlayer(new Uint8Array(raw));
  const total = steps.length * STEP, mine = new Float32Array(total + SR); let pos = 0;
  while (pos < total) { const fr = player.renderFrame(SR, false, true); for (let i = 0; i < fr.left.length && pos < mine.length; i++) mine[pos++] = (fr.left[i] + fr.right[i]) * 0.5; }
  // 段の真ん中 60% の、平均を引いた RMS
  const level = (a, k) => { const from = k * STEP + STEP * 0.2 | 0, n = STEP * 0.6 | 0; return from + n <= a.length ? rms(a.subarray(from, from + n), n) : 0; };
  const db = (v, base) => v > 1e-7 ? (20 * Math.log10(v / base)).toFixed(2).padStart(7) : '   無音';
  const m0 = level(mine, 0), r0 = level(ref.mono, 0);
  console.log('段'.padEnd(14) + '自前 dB   VGMPlay dB   差');
  let worst = 0, muteDiff = 0;
  for (let k = 0; k < steps.length; k++) {
    const a = level(mine, k), b = level(ref.mono, k);
    const da = a > 1e-7 ? 20 * Math.log10(a / m0) : null, dr = b > 1e-7 ? 20 * Math.log10(b / r0) : null;
    let d = '';
    if (da !== null && dr !== null) { d = (da - dr).toFixed(2); if (Math.abs(da - dr) > worst) worst = Math.abs(da - dr); } else if ((da === null) !== (dr === null)) { d = '片方だけ無音'; muteDiff++; }
    console.log(steps[k].padEnd(14) + db(a, m0) + '   ' + db(b, r0) + '      ' + d);
  }
  console.log(`\n両方鳴っている段での差の最大 ${worst.toFixed(2)} dB、片方だけ無音の段 ${muteDiff}`);
  process.exit(0);
}

const rows = [];
for (const file of files) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-vgm-'));
  try {
    let raw = fs.readFileSync(file);
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
    const copy = path.join(work, 'song.vgm');
    fs.writeFileSync(copy, raw);
    spawnSync(exe, [copy], { cwd: vgmplayDir, input: '', encoding: 'utf8', timeout: 120000 });
    const wavPath = path.join(work, 'song.wav');
    if (!fs.existsSync(wavPath)) { rows.push({ file, error: 'VGMPlay が WAV を出しませんでした' }); continue; }
    const ref = readWav(wavPath);
    if (ref.rate !== SR) { rows.push({ file, error: 'VGMPlay の出力が ' + ref.rate + 'Hz(44100 にしてください)' }); continue; }
    const player = new MML.Emu.VgmPlayer(new Uint8Array(raw));
    const total = Math.min(Math.round(sec * SR), ref.mono.length, player.totalSamples || Infinity);
    const mine = new Float32Array(total + SR); let pos = 0;
    while (pos < total) { const f = player.renderFrame(SR, false, true); for (let i = 0; i < f.left.length && pos < mine.length; i++) mine[pos++] = (f.left[i] + f.right[i]) * 0.5; }
    // ずれ合わせ: 包絡(10ms 刻み)で、相関が最大になるずれを探す(±0.2 秒)
    let best = -2, lag = 0;
    {
      const ea = envelope(mine, 0, total), eb = envelope(ref.mono, 0, total), m = ea.length - 40;
      if (m > 50) for (let d = -20; d <= 20; d++) { const c = d >= 0 ? corr(ea, d, eb, 0, m) : corr(ea, 0, eb, -d, m); if (c > best) { best = c; lag = d * 441; } }
    }
    const mo = Math.max(0, lag), ro = Math.max(0, -lag), n = total - Math.abs(lag) - 1;
    let min = 2, secs = 0, sum = 0;
    for (let s = 0; (s + 1) * SR <= n; s++) {
      // 無音の秒は相関が意味を持たないので数えない
      if (rms(ref.mono.subarray(ro + s * SR, ro + (s + 1) * SR), SR) < 1e-4) continue;
      const c = corr(mine, mo + s * SR, ref.mono, ro + s * SR, SR); if (c < min) min = c; sum += c; secs++;
    }
    const ea = envelope(mine, mo, n), eb = envelope(ref.mono, ro, n);
    if (process.argv.includes('--detail')) { // 1 秒ごとの音量(自前 / VGMPlay)
      const line = []; for (let k = 0; k + 100 <= ea.length; k += 100) { let x = 0, y = 0; for (let i = 0; i < 100; i++) { x += ea[k + i]; y += eb[k + i]; } line.push((x / 100).toFixed(3) + '/' + (y / 100).toFixed(3)); }
      console.log(path.basename(file) + ' 1 秒ごとの音量 自前/VGMPlay: ' + line.join(' '));
    }
    rows.push({ file, env: corr(ea, 0, eb, 0, ea.length), shape: shape(mine, mo, ref.mono, ro, n), all: corr(mine, mo, ref.mono, ro, n), min: secs ? min : NaN, mean: secs ? sum / secs : NaN, ratio: rms(mine.subarray(mo, mo + n), n) / (rms(ref.mono.subarray(ro, ro + n), n) || 1), lag, secs: n / SR });
  } catch (e) { rows.push({ file, error: e.message }); }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
}
for (const r of rows) {
  const name = path.basename(r.file).slice(0, 44).padEnd(44);
  console.log(r.error ? `${name} ${r.error}` : `${name} 包絡 ${r.env.toFixed(4)}  形 ${r.shape.toFixed(4)}  波形 ${r.all.toFixed(3)}  音量比 ${r.ratio.toFixed(3)}  ずれ ${r.lag}  ${r.secs.toFixed(0)} 秒`);
}
const ok = rows.filter(r => !r.error);
const avg = (k) => (ok.reduce((s, r) => s + r[k], 0) / ok.length).toFixed(4), low = (k) => Math.min(...ok.map(r => r[k])).toFixed(4);
if (ok.length) console.log(`\n${ok.length} 曲: 包絡の平均 ${avg('env')}(最小 ${low('env')})、形の平均 ${avg('shape')}(最小 ${low('shape')})`);
