#!/usr/bin/env node
/*
 * 自前 MSX エミュレータ(src/emulator/msx/)を openMSX と同じ条件で回し、画面と VRAM を突き合わせる(NES の Mesen 比較の MSX 版)。
 * 2026-11-11: 「細部を記憶で書いて、私が書いたテスト ROM で確かめる」では同じ思い込みが通ってしまうので、基準を外に置くための道具。
 *
 * 使い方(1 本):
 *   node tools/openmsx/ab.js game.rom [--machine cbios2|cbios1|fsa1f] [--frames 1200] [--shots 300,600,900,1200]
 *        [--script "Space:180-190,Return:300-306"] [--out dir] [--keep]
 *   node tools/openmsx/ab.js --disk a.dsk [--disk b.dsk] --machine fsa1f [--script "...,disk1:3000"]
 * まとめて(ずれの大きい順に並べる):
 *   node tools/openmsx/ab.js --batch <folder> [--kind rom|dsk] [--jobs 4] [--out dir] [--limit N]
 *
 * openMSX の場所: 環境変数 OPENMSX(openmsx.exe)。無ければ _tmp_test/openmsx/app/openmsx.exe(公式の Windows 版 zip を展開した物)。
 * 実 BIOS の機種(fsa1f)は、手元の分割 BIOS(--bios-dir、既定 _tmp_test/msx/sweep/bios)を openMSX の share/systemroms/sef/ に写し、
 * こちらと同じスロット配置の機種定義(share/machines/SEF_*.xml)を書いて使う(openMSX 付属の FS-A1F は 1 本にまとめた ROM が要るため)。
 *
 * 比べ方:
 *   - 画面: openMSX の raw スクリーンショット(320×240 か 640×480、ボーダー込み)を 320×240 にし、こちらの 256×240(幅 512 は半分、480 行は偶数行)
 *     との位置合わせ(横 ox・縦 oy)を探してから比べる。色は機種の色変換が違うので「同じ色の塊になっているか」で見る
 *     (こちらの色 → openMSX の色の対応表を作り、いちばん多い対応に乗らない画素の割合。逆向きも数えて大きい方)。
 *   - フレームの起点は両方とも電源投入からの VBlank 回数。こちらが数フレーム先に進む傾向があるので、shot-6〜+3 フレームから最も合う物を採る。
 *   - VRAM: 128K を丸ごと比べ、違うバイト数と最初に違う番地を出す(画面に出ない所の違いも分かる)。
 * 出力: <out>/<名前>/ に ours_<f>.png / ref_<f>.png / cmp_<f>.png(左こちら・中 openMSX・右 違う所を赤)、result.json。
 * まとめて回すときは <out>/ab.jsonl に 1 本 1 行、終わりにずれの大きい順の表。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const args = (n) => argv.map((a, i) => a === n ? argv[i + 1] : null).filter(Boolean);
const has = (n) => argv.includes(n);

const OPENMSX = process.env.OPENMSX || path.join(ROOT, '_tmp_test', 'openmsx', 'app', 'openmsx.exe');
const BIOS_DIR = arg('--bios-dir', path.join(ROOT, '_tmp_test', 'msx', 'sweep', 'bios'));
const OUT = path.resolve(arg('--out', path.join(ROOT, '_tmp_test', 'openmsx', 'ab')));

// ── 機種 ──
// こちら(MsxConsole の opts)と openMSX(機種定義の名前)の組。BIOS のファイル名は BIOS_DIR の中
const MACHINES = {
  cbios2: { ours: { machine: 'msx2' }, openmsx: 'SEF_CBIOS_MSX2' },
  cbios1: { ours: { machine: 'msx1' }, openmsx: 'C-BIOS_MSX1_JP' },
  fsa1f: {
    ours: { machine: 'msx2', fdc: 'tc8566af' }, openmsx: 'SEF_FSA1F',
    bios: { main: 'paraMSX032__MSX2_J.ROM', sub: 'paraMSX032__MSX2EXT_J.ROM', disk: 'paraMSX032__DISK_P.ROM' },
  },
};
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// openMSX 側の機種定義を書く(毎回上書き。中身が同じなら同じ)
function ensureMachines() {
  const share = path.join(path.dirname(OPENMSX), 'share');
  const mdir = path.join(share, 'machines');
  if (!fs.existsSync(mdir)) throw new Error('openMSX が見つかりません: ' + OPENMSX + '(環境変数 OPENMSX で指定)');
  // C-BIOS MSX2: 付属の定義の RAM 512K をこちらと同じ 128K に
  const cb = fs.readFileSync(path.join(mdir, 'C-BIOS_MSX2_JP.xml'), 'utf8').replace('<size>512</size>', '<size>128</size>');
  fs.writeFileSync(path.join(mdir, 'SEF_CBIOS_MSX2.xml'), cb);
  // 実 BIOS(分割)の FS-A1F 相当: メイン 0、サブ 3-0、ディスク(TC8566AF)3-1、RAM 128K 3-2。こちらの DEFAULT_LAYOUT と同じ
  const b = MACHINES.fsa1f.bios;
  if (Object.values(b).every((f) => fs.existsSync(path.join(BIOS_DIR, f)))) {
    const sdir = path.join(share, 'systemroms', 'sef'); fs.mkdirSync(sdir, { recursive: true });
    const rom = {};
    for (const [k, f] of Object.entries(b)) { const bytes = fs.readFileSync(path.join(BIOS_DIR, f)); fs.writeFileSync(path.join(sdir, f), bytes); rom[k] = { f, h: sha1(bytes) }; }
    const romEl = (r) => `<rom><filename>${r.f}</filename><sha1>${r.h}</sha1></rom>`;
    const xml = `<?xml version="1.0" ?>
<!DOCTYPE msxconfig SYSTEM 'msxconfig2.dtd'>
<msxconfig>
  <info><manufacturer>SEF</manufacturer><code>FS-A1F split BIOS</code><release_year>1988</release_year>
    <description>Sound Emulation Foundry の比較用(分割 BIOS、こちらと同じスロット配置)</description><type>MSX2</type></info>
  <MapperReadBackBits>largest</MapperReadBackBits>
  <CassettePort/>
  <devices>
    <primary slot="0"><ROM id="Main ROM"><mem base="0x0000" size="0x8000"/>${romEl(rom.main)}</ROM></primary>
    <primary external="true" slot="1"/>
    <primary external="true" slot="2"/>
    <primary slot="3">
      <secondary slot="0"><ROM id="Sub ROM"><mem base="0x0000" size="0x4000"/>${romEl(rom.sub)}</ROM></secondary>
      <secondary slot="1"><TC8566AF id="Memory Mapped FDC"><io_regs>7FF8</io_regs><drives>2</drives>${romEl(rom.disk)}<mem base="0x4000" size="0x4000"/></TC8566AF></secondary>
      <secondary slot="2"><MemoryMapper id="Main RAM"><mem base="0x0000" size="0x10000"/><size>128</size></MemoryMapper></secondary>
    </primary>
    <PPI id="ppi"><io base="0xA8" num="4"/><sound><volume>16000</volume></sound><key_ghosting>false</key_ghosting><keyboard_type>jp_jis</keyboard_type><has_keypad>false</has_keypad><code_kana_locks>true</code_kana_locks><graph_locks>false</graph_locks></PPI>
    <VDP id="VDP"><io base="0x98" num="4" type="O"/><io base="0x98" num="2" type="I"/><version>V9938</version><vram>128</vram></VDP>
    <PSG id="PSG"><type>YM2149</type><keyboardlayout>50on</keyboardlayout><io base="0xA0" num="4" type="IO"/><sound><volume>21000</volume></sound></PSG>
    <RTC id="Real time clock"><io base="0xB4" num="2" type="O"/><io base="0xB5" num="1" type="I"/><sramname>sef_fsa1f.cmos</sramname></RTC>
    <PrinterPort id="Printer Port"><io base="0x90" num="2"/></PrinterPort>
  </devices>
</msxconfig>
`;
    fs.writeFileSync(path.join(mdir, 'SEF_FSA1F.xml'), xml);
  }
}

// ── 台本(入力) ──
// "Space:180-190,Return:300-306,disk1:3000" → [{ key, from, to } | { disk, at }]。キー名は msxKeyboard.js の KEYS(Space/Return/Up/F1 …)
function parseScript(s) {
  const out = [];
  for (const part of (s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [name, range] = part.split(':');
    const m = /^disk(\d+)$/.exec(name);
    if (m) { out.push({ disk: +m[1], at: +range }); continue; }
    const [a, b] = range.split('-').map(Number);
    out.push({ key: name, from: a, to: b === undefined ? a + 6 : b });
  }
  return out;
}

// ── openMSX 側 ──
function tclFor(job, dir, KEYS) {
  const q = (p) => '{' + p.replace(/\\/g, '/') + '}';
  const lines = [
    // ★スロットル OFF だと描画されず screenshot が真っ黒(640×480)になる(実測)。スロットル ON のまま speed を 2000% にし、撮る 6 フレーム前から 100% に戻す
    'set mute on', 'set throttle on', 'set speed 2000',
    `set ::out ${q(dir)}`, `set ::shots {${job.shots.join(' ')}}`, `set ::stop ${Math.max(...job.shots) + 1}`, 'set ::n 0',
    'proc dump {f} {',
    '  screenshot -raw "$::out/ref_$f.png"',
    '  set regs {}; for {set r 0} {$r < 47} {incr r} { lappend regs [debug read "VDP regs" $r] }',
    '  set st {}; for {set r 0} {$r < 10} {incr r} { lappend st [debug read "VDP status regs" $r] }',
    '  set fh [open "$::out/ref_$f.txt" w]; puts $fh "regs $regs"; puts $fh "status $st"; close $fh',
    '  set fh [open "$::out/ref_$f.vram" w]; fconfigure $fh -translation binary; puts -nonewline $fh [debug read_block VRAM 0 0x20000]; close $fh',
    '}',
    'proc act {f} {',
  ];
  for (const a of job.script) {
    if (a.disk !== undefined) { lines.push(`  if {$f == ${a.at}} { diska ${q(job.disks[a.disk])} }`); continue; }
    const k = KEYS[a.key]; if (!k) throw new Error('キー名が分かりません: ' + a.key);
    lines.push(`  if {$f == ${a.from}} { keymatrixdown ${k[0]} ${1 << k[1]} }`, `  if {$f == ${a.to}} { keymatrixup ${k[0]} ${1 << k[1]} }`);
  }
  lines.push('}',
    'proc onFrame {} {',
    '  foreach s $::shots { if {$::n == $s - 6} { set speed 100 } }',
    '  if {[catch { act $::n; if {$::n in $::shots} { dump $::n; set speed 2000 } } err]} { set fh [open "$::out/ref_error.txt" a]; puts $fh "$::n $err"; close $fh }',
    '  if {$::n >= $::stop} { exit }',
    '  incr ::n',
    '  after frame onFrame',
    '}',
    'after frame onFrame');
  return lines.join('\n') + '\n';
}
function runOpenMsx(job, dir, KEYS, timeoutMs) {
  const tcl = path.join(dir, 'ref.tcl');
  fs.writeFileSync(tcl, tclFor(job, dir, KEYS));
  const a = ['-machine', MACHINES[job.machine].openmsx];
  if (job.rom) a.push('-cart', job.rom);
  if (job.disks.length) a.push('-diska', job.disks[0]);
  a.push('-script', tcl);
  return new Promise((resolve) => {
    const p = spawn(OPENMSX, a, { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } resolve('timeout'); }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
    p.on('error', (e) => { clearTimeout(t); resolve('spawn error ' + e.message); });
  });
}

// ── こちら側 ──
let MML = null;
function ours(job) {
  if (!MML) MML = require(path.join(ROOT, 'tools', 'headless', 'load.js')).load({ strict: true }).MML;
  const Emu = MML.Emu, M = MACHINES[job.machine];
  const opts = Object.assign({}, M.ours);
  if (M.bios) { opts.bios = {}; for (const [k, f] of Object.entries(M.bios)) opts.bios[k] = new Uint8Array(fs.readFileSync(path.join(BIOS_DIR, f))); opts.bios.name = 'split'; }
  if (job.disks.length) opts.disks = job.disks.map((f) => new Uint8Array(fs.readFileSync(f)));
  if (job.mapper) opts.mapperType = job.mapper;
  const m = new Emu.MsxConsole(job.rom ? new Uint8Array(fs.readFileSync(job.rom)) : null, opts);
  const want = new Set(); for (const s of job.shots) for (let d = -6; d <= 3; d++) want.add(s + d);
  const snaps = {};
  const end = Math.max(...job.shots) + 2;
  // openMSX の after frame は「フレーム n の終わり」に呼ばれ、そこで入れたキーは次のフレームから効く。こちらも runFrame の前に入れる
  for (let f = 0; f <= end; f++) {
    for (const a of job.script) {
      if (a.disk !== undefined) { if (a.at === f) m.insertDisk(a.disk); continue; }
      if (a.from === f) m.setMsxKey(a.key, true);
      if (a.to === f) m.setMsxKey(a.key, false);
    }
    m.runFrame();
    if (want.has(f)) snaps[f] = { w: m.frameWidth, h: m.frameHeight, px: m.frame.slice(0, m.frameWidth * m.frameHeight), vram: m.vdp.vram.slice(0, 0x20000), regs: Array.from(m.vdp.regs.subarray(0, 47)) };
  }
  return { snaps, KEYS: Emu.MsxKeyboard && Emu.MsxKeyboard.KEYS };
}

// ── PNG ──
function pngDecode(buf) {
  let p = 8, w = 0, h = 0, ct = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('PNG: 8bit 非インターレースだけ'); }
    else if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error('PNG: RGB/RGBA だけ');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = new Uint32Array(w * h), cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 0xFF;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = cur[x * bpp] | (cur[x * bpp + 1] << 8) | (cur[x * bpp + 2] << 16);
    cur.copy(prev);
  }
  return { w, h, px: out };
}
function pngEncode(file, w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px[y * w + x], o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = c & 255; raw[o + 1] = (c >> 8) & 255; raw[o + 2] = (c >> 16) & 255; }
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ── 比べる ──
const W = 256, H = 240;
function normOurs(s) { // 256×240 に(幅 512 は偶数列、480 行は偶数行)
  const out = new Uint32Array(W * H), sx = s.w / W, sy = s.h / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = s.px[(y * sy) * s.w + x * sx] & 0xFFFFFF;
  return out;
}
function normRef(r) { // 640×480 → 320×240(320×240 ならそのまま)
  if (r.w <= 320) return r;
  const w = r.w >> 1, h = r.h >> 1, out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = r.px[(y * 2) * r.w + x * 2];
  return { w, h, px: out };
}
// 色の対応で比べる: こちらの色 a → openMSX の色 b の組を数え、各 a でいちばん多い b に乗らない画素の割合(逆向きも数えて大きい方)
function mismatch(a, ref, ox, oy, step) {
  const ab = new Map(), ba = new Map(); let n = 0;
  for (let y = 0; y < H; y += step) {
    const ry = y + oy; if (ry < 0 || ry >= ref.h) continue;
    for (let x = 0; x < W; x += step) {
      const rx = x + ox; if (rx < 0 || rx >= ref.w) continue;
      const ca = a[y * W + x], cb = ref.px[ry * ref.w + rx];
      const k1 = ca * 16777216 + cb, k2 = cb * 16777216 + ca;
      ab.set(k1, (ab.get(k1) || 0) + 1); ba.set(k2, (ba.get(k2) || 0) + 1); n++;
    }
  }
  const best = (mp) => { const top = new Map(); for (const [k, c] of mp) { const s = Math.floor(k / 16777216); if (c > (top.get(s) || 0)) top.set(s, c); } let t = 0; for (const c of top.values()) t += c; return t; };
  return n ? 1 - Math.min(best(ab), best(ba)) / n : 1;
}
function align(a, ref) { // 粗く探してから細かく
  let best = { m: 2, ox: 32, oy: 0 };
  for (let oy = -16; oy <= 16; oy += 2) for (let ox = 0; ox <= ref.w - W; ox += 2) { const m = mismatch(a, ref, ox, oy, 4); if (m < best.m) best = { m, ox, oy }; }
  const c = best;
  for (let oy = c.oy - 2; oy <= c.oy + 2; oy++) for (let ox = Math.max(0, c.ox - 2); ox <= Math.min(ref.w - W, c.ox + 2); ox++) { const m = mismatch(a, ref, ox, oy, 2); if (m < best.m || (best === c)) best = { m, ox, oy }; }
  return best;
}
function cmpImage(file, a, ref, ox, oy) {
  // 左: こちら、中: openMSX(同じ位置を切り出し)、右: 対応表のいちばん多い組に乗らない画素を赤
  const ab = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ry = y + oy, rx = x + ox; if (ry < 0 || ry >= ref.h) continue; const k = a[y * W + x] * 16777216 + ref.px[ry * ref.w + rx]; ab.set(k, (ab.get(k) || 0) + 1); }
  const top = new Map(); for (const [k, c] of ab) { const s = Math.floor(k / 16777216); const t = top.get(s); if (!t || c > t.c) top.set(s, { c, b: k % 16777216 }); }
  const out = new Uint32Array(W * 3 * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ry = y + oy, rx = x + ox, ca = a[y * W + x], cb = (ry >= 0 && ry < ref.h) ? ref.px[ry * ref.w + rx] : 0;
    out[y * W * 3 + x] = ca; out[y * W * 3 + W + x] = cb;
    out[y * W * 3 + 2 * W + x] = (top.get(ca) && top.get(ca).b === cb) ? ((ca >> 2) & 0x3F3F3F) : 0x0000FF;
  }
  pngEncode(file, W * 3, H, out);
}
function vramDiff(a, b) {
  let n = 0, first = -1;
  for (let i = 0; i < 0x20000; i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
  return { bytes: n, first };
}

// ── 1 本 ──
async function runJob(job) {
  const dir = path.join(OUT, job.name); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^(ref_|ours_|cmp_)/.test(f)) fs.unlinkSync(path.join(dir, f));
  const t0 = Date.now();
  const o = ours(job);
  const code = await runOpenMsx(job, dir, o.KEYS, job.timeout || 120000);
  const res = { name: job.name, machine: job.machine, openmsx: code, ms: Date.now() - t0, shots: [] };
  if (fs.existsSync(path.join(dir, 'ref_error.txt'))) res.tclError = fs.readFileSync(path.join(dir, 'ref_error.txt'), 'utf8').trim().split('\n')[0];
  for (const f of job.shots) {
    const rp = path.join(dir, `ref_${f}.png`);
    if (!fs.existsSync(rp)) { res.shots.push({ f, err: 'openMSX の画面が無い' }); continue; }
    const ref = normRef(pngDecode(fs.readFileSync(rp)));
    // フレームのずれ: こちらの f-6..f+3 から最も合う物(こちらが数フレーム先に進む傾向。VRAM の埋まり方で 1〜5 フレームと実測)。
    // 位置合わせは候補ごとに探す(1 枚で決めた位置を使い回すと、その位置が外れたとき候補選びも外れた。実測)
    let best = null;
    for (let d = -6; d <= 3; d++) { const s = o.snaps[f + d]; if (!s) continue; const a = normOurs(s); const al = align(a, ref); if (!best || al.m < best.al.m) best = { d, a, al, s }; }
    const m = mismatch(best.a, ref, best.al.ox, best.al.oy, 1);
    const shot = { f, mismatch: +(m * 100).toFixed(2), df: best.d, ox: best.al.ox, oy: best.al.oy };
    const vp = path.join(dir, `ref_${f}.vram`);
    if (fs.existsSync(vp)) { const vd = vramDiff(best.s.vram, fs.readFileSync(vp)); shot.vramDiff = vd.bytes; if (vd.first >= 0) shot.vramFirst = '0x' + vd.first.toString(16); }
    const tp = path.join(dir, `ref_${f}.txt`);
    if (fs.existsSync(tp)) { const regs = (/regs (.*)/.exec(fs.readFileSync(tp, 'utf8')) || [])[1]; if (regs) { const r = regs.trim().split(/\s+/).map(Number); const dif = []; for (let i = 0; i < 28; i++) if (r[i] !== best.s.regs[i] && i !== 15 && i !== 16 && i !== 17) dif.push(`R${i}:${best.s.regs[i].toString(16)}/${r[i].toString(16)}`); if (dif.length) shot.regDiff = dif.join(' '); } }
    pngEncode(path.join(dir, `ours_${f}.png`), W, H, best.a);
    cmpImage(path.join(dir, `cmp_${f}.png`), best.a, ref, best.al.ox, best.al.oy);
    res.shots.push(shot);
  }
  res.worst = Math.max(0, ...res.shots.map((s) => s.mismatch || 0));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res, null, 1));
  if (!has('--keep') && !job.keep) for (const f of fs.readdirSync(dir)) if (/\.vram$/.test(f)) fs.unlinkSync(path.join(dir, f));
  return res;
}

// ── まとめて ──
// キーは 40 フレーム押す(30 フレームに 1 回しか入力を読まないゲームがあり、10 フレームだと読み逃した。2026-11-11)
const SWEEP_SCRIPT = 'Space:180-220,Return:300-340,Space:420-460,Space:660-700';
async function batch() {
  const folder = arg('--batch'), kind = arg('--kind', 'rom'), jobs = +arg('--jobs', '3'), limit = +arg('--limit', '0');
  const re = kind === 'dsk' ? /\.dsk$|^[^.]+$/i : /\.(rom|mx1|mx2)$/i;
  let files = fs.readdirSync(folder).filter((f) => re.test(f) && fs.statSync(path.join(folder, f)).isFile()).sort();
  if (limit) files = files.slice(0, limit);
  const shots = (arg('--shots', '300,600,900,1200')).split(',').map(Number);
  const machine = arg('--machine', kind === 'dsk' ? 'fsa1f' : 'cbios2');
  fs.mkdirSync(OUT, { recursive: true });
  const jl = path.join(OUT, 'ab.jsonl');
  const resume = has('--resume');
  if (!resume) fs.writeFileSync(jl, '');
  let next = 0, done = 0; const all = [];
  // 1 本ずつ別のプロセスで回す(こちらのエミュレーションと比較は同期処理なので、同じプロセスで並べても openMSX が 1 つずつしか動かない。実測)
  const script = arg('--script', SWEEP_SCRIPT);
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const name = f.replace(/[^\w.-]/g, '_'), rp = path.join(OUT, name, 'result.json');
      let r = null;
      if (resume && fs.existsSync(rp)) { try { r = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) { r = null; } if (r) { all.push(r); done++; continue; } }
      const a = [__filename, ...(kind === 'dsk' ? ['--disk', path.join(folder, f)] : [path.join(folder, f)]), '--name', name, '--out', OUT, '--machine', machine, '--shots', shots.join(','), '--script', script, '--quiet', '--bios-dir', BIOS_DIR];
      const code = await new Promise((res) => { const p = spawn(process.execPath, a, { stdio: 'ignore', windowsHide: true }); p.on('exit', res); p.on('error', () => res(-1)); });
      try { r = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) { r = { name, error: 'result.json がありません(exit ' + code + ')', worst: 100 }; }
      all.push(r); fs.appendFileSync(jl, JSON.stringify(r) + '\n');
      if (++done % 10 === 0) console.error(`${done}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  all.sort((a, b) => b.worst - a.worst);
  const bucket = (lo, hi) => all.filter((r) => r.worst >= lo && r.worst < hi).length;
  console.log(`== ${all.length} 本(${machine}) ずれ(画素 %): 0-1: ${bucket(0, 1)}  1-5: ${bucket(1, 5)}  5-20: ${bucket(5, 20)}  20-: ${bucket(20, 101)}`);
  for (const r of all.slice(0, 40)) console.log(String(r.worst).padStart(6), r.name, r.error || r.tclError || (r.shots || []).map((s) => `${s.f}:${s.mismatch ?? s.err}${s.vramDiff ? ' v' + s.vramDiff : ''}`).join(' '));
}

async function main() {
  ensureMachines();
  if (arg('--batch')) return batch();
  const rom = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const disks = args('--disk').map((d) => path.resolve(d));
  if (!rom && !disks.length) { console.log('使い方は先頭のコメントを見てください'); process.exit(1); }
  const job = {
    name: arg('--name', path.basename(rom || disks[0]).replace(/[^\w.-]/g, '_')),
    machine: arg('--machine', disks.length ? 'fsa1f' : 'cbios2'), rom: rom ? path.resolve(rom) : null, disks,
    mapper: arg('--mapper', null),
    shots: arg('--shots', '300,600,900,1200').split(',').map(Number), script: parseScript(arg('--script', '')),
  };
  // openMSX のソフトウェア DB(SHA-1 → マッパー種別・吸い出しの良否)。openMSX はこれで種別を決めるので、こちらも同じ種別で回す
  // (マッパー推定の外れは画面の比較に混ぜず、mapperGuess/mapperDb として別に出す)
  let dbInfo = null;
  if (job.rom) {
    dbInfo = softDb().get(sha1(fs.readFileSync(job.rom))) || null;
    if (!job.mapper && dbInfo && dbInfo.ours) job.mapper = dbInfo.ours;
  }
  const r = await runJob(job);
  if (job.rom) {
    if (!MML) MML = require(path.join(ROOT, 'tools', 'headless', 'load.js')).load({ strict: true }).MML;
    r.mapperGuess = MML.Emu.MsxCartridge.guessType(new Uint8Array(fs.readFileSync(job.rom)));
    if (dbInfo) { r.mapperDb = dbInfo.type; if (dbInfo.status) r.dbStatus = dbInfo.status; if (!dbInfo.ours) r.mapperUnsupported = true; }
    r.mapperUsed = job.mapper || r.mapperGuess;
    fs.writeFileSync(path.join(OUT, job.name, 'result.json'), JSON.stringify(r, null, 1));
  }
  if (has('--quiet')) return;
  console.log(JSON.stringify(r, null, 1));
  console.log('画像: ' + path.join(OUT, job.name));
}
// openMSX の share/softwaredb.xml を読む。type は openMSX の名前、ours はこちらの MsxCartridge の種別(対応していなければ null)
const DB_TYPES = {
  Mirrored: 'plain', Normal: 'plain', Page0: 'plain', Page1: 'plain', Page2: 'plain', Page12: 'plain', Page23: 'plain', Page012: 'plain', Page123: 'plain', Page0123: 'plain',
  Konami: 'konami', KonamiSCC: 'konamiScc', ASCII8: 'ascii8', ASCII16: 'ascii16', ASCII8SRAM8: 'ascii8Sram', ASCII8SRAM2: 'ascii8Sram',
  ASCII16SRAM2: 'ascii16Sram', ASCII16SRAM8: 'ascii16Sram', GameMaster2: 'gameMaster2', KoeiSRAM8: 'koei', KoeiSRAM32: 'koei', Majutsushi: 'konamiDac',
};
let softDbCache = null;
function softDb() {
  if (softDbCache) return softDbCache;
  softDbCache = new Map();
  const p = path.join(path.dirname(OPENMSX), 'share', 'softwaredb.xml');
  if (!fs.existsSync(p)) return softDbCache;
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/<rom\b([^>]*)\/?>/g)) {
    const at = {}; for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) at[a[1]] = a[2];
    if (!at.sha1) continue;
    const type = at.type || 'Mirrored';
    softDbCache.set(at.sha1, { type, status: at.status || '', ours: DB_TYPES[type] || null });
  }
  return softDbCache;
}
module.exports = { ensureMachines, runOpenMsx, ours, pngDecode, normRef, normOurs, align, mismatch, parseScript, MACHINES, softDb, DB_TYPES };
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
