/*
 * PSF コーパス一括動作確認(ヘッドレス)
 *   node tools/headless/psf-sweep.js <dir|zip> [--per N] [--sec S] [--json out.json]
 *
 * 各 zip から先頭 N 曲(既定2)を S 秒(既定15)鳴らし、
 *   停止(halt)・未実装BIOS呼び出し・無音・キーオン数・実時間比 を1行ずつ出す。
 * 最後に「未実装呼び出しの出現曲数」と「問題のあった曲」をまとめる。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const per = parseInt(opt('--per', '2'), 10);
const sec = parseFloat(opt('--sec', '15'));
const jsonOut = opt('--json', null);
const only = opt('--only', null);

const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });

async function runSong(name, bytes, resolve) {
  const info = await MML.PSF.load(bytes, resolve);
  const player = new MML.Emu.PsfPlayer(info);
  let keyOns = 0;
  player.spu.onKeyOn = () => { keyOns++; };
  const total = Math.round(sec * 44100);
  const L = new Float32Array(total), R = new Float32Array(total);
  const t0 = Date.now();
  let firstSound = -1;
  for (let off = 0; off < total; off += 11025) {
    const n = Math.min(11025, total - off);
    player.renderInto(L, R, off, n);
    if (firstSound < 0) for (let i = off; i < off + n; i++) if (Math.abs(L[i]) > 0.003 || Math.abs(R[i]) > 0.003) { firstSound = i / 44100; break; }
    if (Date.now() - t0 > 60000) break; // 1曲60秒で打ち切り
  }
  const elapsed = (Date.now() - t0) / 1000;
  let peak = 0, sum = 0, clip = 0;
  for (let i = 0; i < total; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a; if (b > peak) peak = b;
    if (a >= 0.999 || b >= 0.999) clip++;
    sum += L[i] * L[i] + R[i] * R[i];
  }
  const b = player.bios;
  return {
    name, title: info.title, speed: +(sec / elapsed).toFixed(1),
    halted: player.halted ? player.haltReason : '',
    unknown: [...b.unknownCalls.keys()],
    badExc: b.badExceptions, keyOns, peak: +peak.toFixed(3), clip,
    rmsDb: +(20 * Math.log10(Math.sqrt(sum / (total * 2)) + 1e-9)).toFixed(1),
    firstSound: firstSound < 0 ? null : +firstSound.toFixed(2),
    idle: +(100 * player.stats.idleCycles / Math.max(1, player.cpu.cycles)).toFixed(0),
    tty: b.ttyLog.join('').slice(0, 120),
  };
}

async function sweepZip(zipPath, results) {
  const z = new Uint8Array(fs.readFileSync(zipPath));
  let entries;
  try { entries = (await MML.Archive.parse(z)).entries.filter(e => !e.isDir); } catch (e) { console.log(`!! ${path.basename(zipPath)}: ${e.message}`); return; }
  const songs = entries.filter(e => /\.(psf|minipsf)$/i.test(e.name)).sort((a, b) => MML.Archive.naturalCompare(a.name, b.name));
  if (!songs.length) { console.log(`-- ${path.basename(zipPath)}: PSFなし(${entries.length} entries)`); return; }
  const cache = new Map();
  const resolve = async (n) => {
    const k = n.toLowerCase();
    if (cache.has(k)) return cache.get(k);
    const e = entries.find(x => x.name.toLowerCase() === k) || entries.find(x => MML.Archive.baseName(x.name).toLowerCase() === MML.Archive.baseName(n).toLowerCase());
    const b = e ? await MML.Archive.readEntry(z, e) : null;
    cache.set(k, b);
    return b;
  };
  // 先頭と中ほどから選ぶ(同じドライバの別曲を見る)
  const pick = [];
  for (let i = 0; i < per && i < songs.length; i++) pick.push(songs[Math.floor(i * songs.length / per)]);
  for (const e of pick) {
    let r;
    try { r = await runSong(e.name, await MML.Archive.readEntry(z, e), resolve); }
    catch (err) { r = { name: e.name, error: String(err && err.message || err) }; }
    r.zip = path.basename(zipPath).replace(/ \(EMU\)\.zophar\.zip$/, '');
    results.push(r);
    const flag = r.error ? 'ERR ' : (r.halted ? 'HALT' : (r.peak < 0.003 ? 'MUTE' : (r.unknown && r.unknown.length ? 'UNK ' : 'ok  ')));
    console.log(`${flag} ${r.zip} / ${r.name}` + (r.error ? `  ${r.error}` :
      `  x${r.speed} idle${r.idle}% kon=${r.keyOns} peak=${r.peak} rms=${r.rmsDb}dB clip=${r.clip} first=${r.firstSound}s` +
      (r.halted ? `  halt="${r.halted}"` : '') + (r.unknown.length ? `  unk=${r.unknown.join(',')}` : '') + (r.badExc ? ` badExc=${r.badExc}` : '')));
  }
}

(async () => {
  const results = [];
  const st = fs.statSync(target);
  const zips = st.isDirectory() ? fs.readdirSync(target).filter(f => /\.zip$/i.test(f)).map(f => path.join(target, f)) : [target];
  for (const z of zips) {
    if (only && !path.basename(z).toLowerCase().includes(only.toLowerCase())) continue;
    await sweepZip(z, results);
  }
  const unk = new Map();
  for (const r of results) for (const u of (r.unknown || [])) unk.set(u, (unk.get(u) || 0) + 1);
  console.log('\n== summary');
  console.log(`songs=${results.length} ok=${results.filter(r => !r.error && !r.halted && r.peak >= 0.003).length} err=${results.filter(r => r.error).length} halt=${results.filter(r => r.halted).length} mute=${results.filter(r => !r.error && r.peak < 0.003).length}`);
  if (unk.size) console.log('unknown calls:', [...unk.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(' '));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
})().catch(err => { console.error(err); process.exit(1); });
