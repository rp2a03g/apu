/*
 * PSF 容器の読み込み確認ツール(ヘッドレス)
 *   node tools/headless/psf-probe.js <zip|psf|dir> [--limit N] [--verbose]
 *
 * zip内の .psf/.minipsf を PSF.load で _lib 連鎖ごと読み、PC/SP/GP・セグメント・タグを表示する。
 * 読めなかったファイルは末尾にまとめて出す。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;
const verbose = args.includes('--verbose');
if (!target) { console.error('usage: psf-probe.js <zip|psf|dir>'); process.exit(2); }

const { MML } = load({ skip: [/main\.js$/, /src\/ui\//, /src\/audio\//, /capture-worker/] });
const PSF = MML.PSF;
const Archive = MML.Archive;
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

async function probeZip(zipPath) {
  const bytes = new Uint8Array(fs.readFileSync(zipPath));
  const parsed = await Archive.parse(bytes);
  const entries = parsed.entries.filter(e => !e.isDir);
  const songs = entries.filter(e => /\.(psf|minipsf)$/i.test(e.name));
  const failures = [];
  let n = 0;
  const cache = new Map();
  const readNamed = async (name) => {
    const key = name.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const e = entries.find(x => x.name.toLowerCase() === key)
      || entries.find(x => Archive.baseName(x.name).toLowerCase() === Archive.baseName(name).toLowerCase());
    if (!e) return null;
    const b = await Archive.readEntry(bytes, e);
    cache.set(key, b);
    return b;
  };
  console.log(`== ${path.basename(zipPath)}: ${songs.length} songs / ${entries.length} entries`);
  for (const e of songs) {
    if (n++ >= limit) break;
    try {
      const b = await Archive.readEntry(bytes, e);
      const info = await PSF.load(b, readNamed);
      const segs = info.segments.map(s => `${hex(s.addr)}+${s.data.length}`).join(' ');
      console.log(`  ${e.name}: pc=${hex(info.pc)} sp=${hex(info.sp)} gp=${hex(info.gp)} refresh=${info.refresh} len=${info.lengthMs} fade=${info.fadeMs} libs=[${info.libs.join(',')}] segs=[${segs}]`);
      if (verbose) console.log('    tags:', JSON.stringify(info.tags));
    } catch (err) {
      failures.push(`${e.name}: ${err.message}`);
    }
  }
  if (failures.length) { console.log('  FAILED:'); for (const f of failures) console.log('   ', f); }
  return { songs: Math.min(songs.length, limit), failed: failures.length };
}

(async () => {
  const st = fs.statSync(target);
  let tot = { songs: 0, failed: 0 };
  const add = (r) => { tot.songs += r.songs; tot.failed += r.failed; };
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(target)) {
      if (/\.zip$/i.test(f)) add(await probeZip(path.join(target, f)));
    }
  } else if (/\.zip$/i.test(target)) {
    add(await probeZip(target));
  } else {
    const b = new Uint8Array(fs.readFileSync(target));
    const dir = path.dirname(target);
    const info = await PSF.load(b, async (name) => {
      const p = path.join(dir, name);
      return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
    });
    console.log(JSON.stringify({ ...info, segments: info.segments.map(s => ({ addr: hex(s.addr), size: s.data.length })) }, null, 1));
    tot.songs = 1;
  }
  console.log(`total: ${tot.songs} songs, ${tot.failed} failed`);
})().catch(err => { console.error(err); process.exit(1); });
