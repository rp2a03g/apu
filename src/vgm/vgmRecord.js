/*
 * NES の書き込み列 → VGM (MML.VGM.encodeNesRecording) — DESIGN-CAPTURE.md §3 の符号化
 *
 * Mesen の録音スクリプト(tools/mesen/vgm-recorder.lua)、NSF からの変換(tools/headless/nsf2vgm.js)、
 * 自前 NES エミュレータの録音(src/emulator/nes/nesConsole.js の rec → nesScreen.js / nes-run.js)が
 * 同じ VGM を作るための 1 本。
 *   - 1 フレーム = 735 サンプル固定(P-2)。書き込みにはフレーム内の時刻 t(0〜734 サンプル)を付けられる
 *   - 2A03/FDS($4000-$401F、$4023、$4040-$409E)は 0xB4 aa dd。FDS を使うとヘッダ 0x84 の bit31
 *   - DPCM は $4015 bit4 の直前に data block 0xC2(CPU アドレス + サンプル本体)。同じ内容は 1 回だけ
 *   - 他の NES 拡張音源(VRC6/VRC7/MMC5/N163/5B)は規格外の NESX ブロック(0x67 0x66 0xBF "NESX")。
 *     先頭に kind=0 のヘッダ(NSF と同じチップビット)、書き込みは kind=1 に addr16 value8 meta8(bit7=読み出し、
 *     bit0-6=フレーム内時刻/128)。同じ時刻の物は 1 ブロックにまとめる
 *
 * 入力: { frames: [[write...]...], extBits, name, artist, game, system, creator }
 *   write = { addr, value, t?, read? } | { dmc: { addr, data } }   (dmc は $4015 の直前に置く)
 *   t は省略するとフレーム頭(0)。read:true は N163 $4800 の読み飛ばし(NESX にだけ載る)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const VGM = MML.VGM = MML.VGM || {};

  const SAMPLES_PER_FRAME = 735;
  const NES_APU_CLOCK = 1789772;
  const HEADER_SIZE = 0x100;

  // CPU アドレス → VGM の NES APU レジスタ番号(0xB4 aa dd の aa)。対象外なら -1
  function mapAddr(a) {
    if (a >= 0x4000 && a <= 0x401F) return (a === 0x4014 || a === 0x4016) ? -1 : a - 0x4000;
    if (a === 0x4023) return 0x3F;
    if (a >= 0x4040 && a <= 0x407F) return 0x40 + (a - 0x4040);
    if (a >= 0x4080 && a <= 0x409E) return 0x20 + (a - 0x4080);
    return -1;
  }
  // NESX に載せる拡張音源のレジスタか
  function isExt(a) {
    return (a >= 0x9000 && a <= 0x9002) || (a >= 0xA000 && a <= 0xA002) || (a >= 0xB000 && a <= 0xB002) || // VRC6
      a === 0x9010 || a === 0x9030 || // VRC7
      (a >= 0x5000 && a <= 0x5015) || // MMC5
      a === 0x4800 || a === 0xF800 || // N163
      a === 0xC000 || a === 0xE000;   // SUNSOFT 5B
  }
  function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF]; }
  function utf16(s) {
    const out = [];
    for (const ch of String(s || '')) { const c = ch.codePointAt(0); out.push(c < 0x80 ? c : 0x3F, 0); }
    out.push(0, 0);
    return out;
  }

  VGM.encodeNesRecording = function (rec) {
    const frames = rec.frames || [];
    const extBits = (rec.extBits || 0) & ~0x04; // FDS は標準部分なので NESX には含めない
    const body = [];
    let emitted = 0, fds = false, dropped = 0;
    const dpcmCache = new Map();
    const flushWait = (t) => {
      let d = t - emitted;
      while (d > 0) {
        if (d === SAMPLES_PER_FRAME) { body.push(0x62); d = 0; }
        else if (d > 0xFFFF) { body.push(0x61, ...u16(0xFFFF)); d -= 0xFFFF; }
        else { body.push(0x61, ...u16(d)); d = 0; }
      }
      if (t > emitted) emitted = t;
    };
    const NESX = VGM.NESX;
    const nesxBlock = (kind, payload) => {
      const b = [].concat(NESX.MAGIC, [NESX.VERSION, kind], payload);
      return [0x67, 0x66, NESX.TYPE, ...u32(b.length), ...b];
    };
    if (extBits) body.push(...nesxBlock(NESX.KIND_HEADER, [extBits]));
    let ext = null; // { t, entries }
    const flushExt = () => {
      if (!ext) return;
      flushWait(ext.t);
      body.push(...nesxBlock(NESX.KIND_WRITES, ext.entries));
      ext = null;
    };
    const extWrite = (a, v, read, t) => {
      if (ext && ext.t !== t) flushExt();
      if (!ext) ext = { t, entries: [] };
      const frac = Math.min(127, Math.round((t % SAMPLES_PER_FRAME) / SAMPLES_PER_FRAME * 128));
      ext.entries.push(a & 0xFF, (a >> 8) & 0xFF, read ? 0 : (v & 0xFF), (read ? 0x80 : 0) | frac);
    };
    const emitDpcm = (blk, t) => {
      const data = blk.data, addr = blk.addr;
      const key = addr + ':' + data.length;
      const prev = dpcmCache.get(key);
      if (prev && prev.length === data.length && prev.every((b, i) => b === data[i])) return;
      dpcmCache.set(key, Uint8Array.from(data));
      flushWait(t);
      body.push(0x67, 0x66, 0xC2, ...u32(data.length + 2), ...u16(addr), ...data);
    };
    let frameSample = 0;
    for (let f = 0; f < frames.length; f++) {
      const list = frames[f] || [];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const t = frameSample + Math.max(0, Math.min(SAMPLES_PER_FRAME - 1, w.t | 0));
        if (w.dmc) { flushExt(); emitDpcm(w.dmc, t); continue; }
        const a = w.addr;
        const aa = mapAddr(a);
        if (aa < 0) {
          if (extBits && isExt(a)) extWrite(a, w.value, !!w.read, t);
          else if (a >= 0x4000 && a <= 0xFFFF && a !== 0x4014 && a !== 0x4016) dropped++;
          continue;
        }
        if (a === 0x4023 || (a >= 0x4040 && a <= 0x409E)) fds = true;
        flushExt();
        flushWait(t);
        body.push(0xB4, aa, w.value & 0xFF);
      }
      frameSample += SAMPLES_PER_FRAME;
    }
    flushExt();
    flushWait(frameSample);
    body.push(0x66);

    // GD3: track, game, system, artist, date, creator(英語欄のみ。日本語欄は空)
    const fields = [].concat(utf16(rec.name || ''), utf16(''), utf16(rec.game || ''), utf16(''),
      utf16(rec.system || 'Nintendo Famicom / NES'), utf16(''), utf16(rec.artist || ''), utf16(''), utf16(''),
      utf16(rec.creator || 'Sound Emulation Foundry'), utf16(rec.notes || ''));
    const gd3 = [].concat([0x47, 0x64, 0x33, 0x20], u32(0x100), u32(fields.length), fields);

    const hdr = new Uint8Array(HEADER_SIZE);
    hdr.set([0x56, 0x67, 0x6D, 0x20], 0);
    const total = HEADER_SIZE + body.length + gd3.length;
    hdr.set(u32(total - 4), 0x04);
    hdr.set(u32(0x00000161), 0x08);
    hdr.set(u32(HEADER_SIZE + body.length - 0x14), 0x14);
    hdr.set(u32(frameSample), 0x18);
    hdr.set(u32(60), 0x24);
    hdr.set(u32(HEADER_SIZE - 0x34), 0x34);
    hdr.set(u32((NES_APU_CLOCK | (fds ? 0x80000000 : 0)) >>> 0), 0x84);

    const vgm = new Uint8Array(total);
    vgm.set(hdr, 0); vgm.set(body, HEADER_SIZE); vgm.set(gd3, HEADER_SIZE + body.length);
    return { vgm, frames: frames.length, dropped, fds };
  };
  VGM.SAMPLES_PER_FRAME = VGM.SAMPLES_PER_FRAME || SAMPLES_PER_FRAME;
})(typeof window !== 'undefined' ? window : globalThis);
