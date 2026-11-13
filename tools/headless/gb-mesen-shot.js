#!/usr/bin/env node
/*
 * Mesen 2 にゲームボーイの ROM を無操作で回させ、決めたフレームの画面を PNG に取る(自前コアの画面と見比べる用)。
 *
 *   node tools/headless/gb-mesen-shot.js "rom.gb" --mesen "C:\path\Mesen.exe" [--frames 1000] [--out shot.png]
 *
 * Mesen はブート ROM を実行してからゲームに入る(DMG で約 83 フレーム)ので、自前コアより少し遅れた絵になる。
 * 出力: PNG と、色数・PC を 1 行。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const rom = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(gb|gbc|sgb)$/i.test(a));
const mesen = arg('--mesen', process.env.MESEN_EXE || '');
const frames = parseInt(arg('--frames', '1000'), 10);
if (!rom || !mesen) { console.error('usage: node tools/headless/gb-mesen-shot.js "rom.gb" --mesen "C:\\path\\Mesen.exe" [--frames 1000] [--out shot.png]'); process.exit(2); }
const out = path.resolve(arg('--out', path.join(os.tmpdir(), 'gb-mesen-shot.png'))).replace(/\\/g, '/');
const lua = [
  'local frame = 0',
  'emu.addEventCallback(function()',
  '  local ok, err = pcall(function()',
  '    frame = frame + 1',
  `    if frame == ${frames} then`,
  `      local png = emu.takeScreenshot(); local f = io.open("${out}", "wb"); f:write(png); f:close()`,
  `      local st = emu.getState(); local t = io.open("${out}.txt", "w"); t:write(string.format("pc=%04x", st["cpu.pc"] or 0)); t:close()`,
  '      emu.stop(0)',
  '    end',
  '  end)',
  '  if not ok then emu.log("endFrame: " .. tostring(err)) end',
  'end, emu.eventType.endFrame)',
].join('\n');
const luaPath = path.join(os.tmpdir(), 'gb-mesen-shot.lua');
fs.writeFileSync(luaPath, lua);
try { fs.unlinkSync(out); } catch (e) { /* 無ければよい */ }
const run = spawnSync(mesen, ['--testRunner', path.resolve(rom), luaPath, '--timeout=120'], { encoding: 'utf8', timeout: 180000 });
if (!fs.existsSync(out)) { console.error('Mesen が画面を出さなかった', run.status, (run.stderr || '').slice(0, 300)); process.exit(1); }

// PNG を読んで色数を数える(8bit RGB/RGBA、インターレース無しだけ)
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len); if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xFF;
    }
  }
  const colors = new Set(); for (let i = 0; i < w * h; i++) colors.add(px[i * bpp] | (px[i * bpp + 1] << 8) | (px[i * bpp + 2] << 16));
  return { w, h, colors: colors.size };
}
const d = decodePng(fs.readFileSync(out));
let st = ''; try { st = fs.readFileSync(out + '.txt', 'utf8'); fs.unlinkSync(out + '.txt'); } catch (e) { /* 無ければよい */ }
console.log(`${path.basename(rom)}: Mesen ${frames} フレーム目 ${d.w}x${d.h} 色数 ${d.colors} ${st} → ${out}`);
