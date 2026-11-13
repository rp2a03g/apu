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

  // ── MSX の書き込み列 → VGM (MML.VGM.encodeMsxRecording) — DESIGN-MSX-CAPTURE.md §5 ──
  // 入力: { frames: [[write...]...], chips: ['psg','scc','opll','opl','dac','pcm'], machine, name, creator, notes }
  //   frames[f].spf = そのフレームのサンプル数(735=60Hz / 882=50Hz。無ければ 735)
  //   write = { chip, addr, value, t, adpcm?: { start, data } }(msxConsole.js の録音列そのまま)
  //   psg: addr=レジスタ(0-13) → 0xA0 rr dd。scc: addr=メモリ番地 → 0xD2 pp aa dd(classic $9800 台/SCC+ $B800 台を
  //   pp に写す。$BFFE のモードと $B000 の窓は符号化せず SCC+ の有無(ヘッダ bit31)だけに使う)。opll: 0x51。opl(Y8950): 0x5C
  //   ($0F のメモリデータは落とし、adpcm 付きの書き込みの直前に 0x88 のデータブロック)。dac: MSXX ブロック(kind 1、同じ時刻を 1 ブロックに)。
  //   pcm(turboR、7e): $A4 は kind 1 に meta bit7 を立てて、$A5 は kind 2 に
  //   1 フレーム=VBlank 1 回。待ちは 0x62(735)/0x63(882)/0x61。ヘッダの 0x24 は多数派のレート、GD3 notes に "rate: 50Hz"
  const MSX_PSG_CLOCK = 1789772;
  const MSX_SCC_CLOCK = 1789772;
  const MSX_FM_CLOCK = 3579545;
  const Y8950_RAM = 0x40000;
  const SCC_PLUS_FLAG = 0x80000000;
  VGM.encodeMsxRecording = function (rec) {
    const frames = rec.frames || [];
    const MSXX = VGM.MSXX;
    const body = [];
    let emitted = 0, dropped = 0, sccPlus = false, n882 = 0;
    const used = { psg: false, scc: false, opll: false, opl: false, dac: false, pcm: false };
    const flushWait = (t) => {
      let d = t - emitted;
      while (d > 0) {
        if (d === 735) { body.push(0x62); d = 0; }
        else if (d === 882) { body.push(0x63); d = 0; }
        else if (d > 0xFFFF) { body.push(0x61, ...u16(0xFFFF)); d -= 0xFFFF; }
        else { body.push(0x61, ...u16(d)); d = 0; }
      }
      if (t > emitted) emitted = t;
    };
    const msxxBlock = (kind, payload) => {
      const b = [].concat(MSXX.MAGIC, [MSXX.VERSION, kind], payload);
      return [0x67, 0x66, MSXX.TYPE, ...u32(b.length), ...b];
    };
    // 先に全体を見て、載る音源(ヘッダのクロック)と DAC の有無を決める
    let plusMode = false;
    for (const list of frames) for (const w of (list || [])) {
      if (w.chip === 'scc') {
        if ((w.addr & 0xFFFE) === 0xBFFE) plusMode = !!(w.value & 0x20);
        else if (w.addr >= 0xB800 && w.addr <= 0xBFFD && plusMode) sccPlus = true;
      }
      if (w.chip === 'pcm') { if (w.addr === 0xA4) used.pcm = true; }
      else if (used[w.chip] !== undefined) used[w.chip] = true;
    }
    const chips = rec.chips || [];
    for (const c of chips) if (used[c] !== undefined && c !== 'dac' && c !== 'pcm') used[c] = true; // 挿している音源はヘッダに出す(書き込みが無くても。DAC/PCM は鳴った時だけ)
    if (used.dac || used.pcm) body.push(...msxxBlock(MSXX.KIND_HEADER, [MSXX.MACHINES[rec.machine] || 2, (used.dac ? MSXX.DAC_KONAMI : 0) | (used.pcm ? MSXX.DAC_TURBOR_PCM : 0)]));
    // DAC: 同じ時刻の書き込みをまとめて 1 ブロック
    let dac = null; // { t, entries }
    const flushDac = () => { if (!dac) return; flushWait(dac.t); body.push(...msxxBlock(MSXX.KIND_DAC, dac.entries)); dac = null; };
    const adpcmCache = new Map();
    const emitAdpcm = (blk, t) => {
      const data = blk.data;
      let h = 2166136261 | 0; for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619) | 0;
      const key = blk.start + ':' + data.length + ':' + (h >>> 0);
      if (adpcmCache.has(key)) return;
      adpcmCache.set(key, true);
      flushWait(t);
      body.push(0x67, 0x66, 0x88, ...u32(data.length + 8), ...u32(Math.max(Y8950_RAM, blk.start + data.length)), ...u32(blk.start), ...data);
    };
    // SCC のメモリ番地 → 0xD2 の (pp, aa)。載せない物は null
    const sccCmd = (addr) => {
      if (addr >= 0x9800 && addr <= 0x9FFF) {
        const off = addr & 0xFF;
        if (off < 0x80) return [0, off];
        if (off < 0x8A) return [1, off - 0x80];
        if (off < 0x8F) return [2, off - 0x8A];
        if (off === 0x8F) return [3, 0];
        return null; // ch4 の波形(読み出し専用)とテスト/デフォーム
      }
      if (addr >= 0xB800 && addr <= 0xBFFD) {
        const off = addr & 0xFF;
        if (off < 0x80) return [0, off];
        if (off < 0xA0) return [4, off - 0x80];
        if (off < 0xAA) return [1, off - 0xA0];
        if (off < 0xAF) return [2, off - 0xAA];
        if (off === 0xAF) return [3, 0];
        return null;
      }
      return null; // $BFFE のモード、$B000 の窓
    };
    let frameSample = 0;
    plusMode = false;
    for (let f = 0; f < frames.length; f++) {
      const list = frames[f] || [];
      const spf = list.spf === 882 ? 882 : 735;
      if (spf === 882) n882++;
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const t = frameSample + Math.max(0, Math.min(spf - 1, w.t | 0));
        switch (w.chip) {
          case 'psg':
            if (w.addr > 13) { dropped++; break; }
            flushDac(); flushWait(t); body.push(0xA0, w.addr & 0x0F, w.value & 0xFF); break;
          case 'scc': {
            if ((w.addr & 0xFFFE) === 0xBFFE) { plusMode = !!(w.value & 0x20); break; }
            const c = sccCmd(w.addr);
            if (!c) { if (!((w.addr & 0xF800) === 0xB000 && w.addr < 0xB800) && (w.addr & 0xF800) !== 0x9000) dropped++; break; }
            flushDac(); flushWait(t); body.push(0xD2, c[0], c[1], w.value & 0xFF); break;
          }
          case 'opll': flushDac(); flushWait(t); body.push(0x51, w.addr & 0x3F, w.value & 0xFF); break;
          case 'opl':
            if (w.addr === 0x0F) break; // ADPCM メモリへのデータは本体同梱(0x88)で運ぶ
            flushDac();
            if (w.adpcm && w.adpcm.data && w.adpcm.data.length) emitAdpcm(w.adpcm, t);
            flushWait(t); body.push(0x5C, w.addr & 0xFF, w.value & 0xFF); break;
          case 'dac': case 'pcm': {
            const meta = Math.min(127, Math.round((t - frameSample) / spf * 128));
            if (w.chip === 'pcm' && w.addr !== 0xA4) { flushDac(); flushWait(t); body.push(...msxxBlock(MSXX.KIND_PCM_CTRL, [w.value & 0xFF, meta])); break; } // $A5 の制御
            if (dac && dac.t !== t) flushDac();
            if (!dac) dac = { t, entries: [] };
            dac.entries.push(w.value & 0xFF, meta | (w.chip === 'pcm' ? MSXX.META_PCM : 0));
            break;
          }
          default: dropped++; break;
        }
      }
      frameSample += spf;
    }
    flushDac();
    flushWait(frameSample);
    body.push(0x66);

    const SYSTEMS = { msx1: 'MSX', msx2: 'MSX2', msx2plus: 'MSX2+', turbor: 'MSX turbo R' };
    const rate50 = n882 > frames.length / 2;
    const notes = [rec.notes || '', n882 ? 'rate: 50Hz' : ''].filter(Boolean).join(' ');
    const fields = [].concat(utf16(rec.name || ''), utf16(''), utf16(rec.game || ''), utf16(''),
      utf16(rec.system || SYSTEMS[rec.machine] || 'MSX'), utf16(''), utf16(rec.artist || ''), utf16(''), utf16(''),
      utf16(rec.creator || 'Sound Emulation Foundry'), utf16(notes));
    const gd3 = [].concat([0x47, 0x64, 0x33, 0x20], u32(0x100), u32(fields.length), fields);

    const hdr = new Uint8Array(HEADER_SIZE);
    hdr.set([0x56, 0x67, 0x6D, 0x20], 0);
    const total = HEADER_SIZE + body.length + gd3.length;
    hdr.set(u32(total - 4), 0x04);
    hdr.set(u32(0x00000161), 0x08);
    hdr.set(u32(HEADER_SIZE + body.length - 0x14), 0x14);
    hdr.set(u32(frameSample), 0x18);
    hdr.set(u32(rate50 ? 50 : 60), 0x24);
    hdr.set(u32(HEADER_SIZE - 0x34), 0x34);
    if (used.psg) { hdr.set(u32(MSX_PSG_CLOCK), 0x74); hdr[0x78] = 0x00; hdr[0x79] = 0x01; } // AY-3-8910、legacy output
    if (used.scc) hdr.set(u32((MSX_SCC_CLOCK | (sccPlus ? SCC_PLUS_FLAG : 0)) >>> 0), 0x9C);
    if (used.opll) hdr.set(u32(MSX_FM_CLOCK), 0x10);
    if (used.opl) hdr.set(u32(MSX_FM_CLOCK), 0x58);

    const vgm = new Uint8Array(total);
    vgm.set(hdr, 0); vgm.set(body, HEADER_SIZE); vgm.set(gd3, HEADER_SIZE + body.length);
    return { vgm, frames: frames.length, dropped, chips: Object.keys(used).filter((k) => used[k]), sccPlus, rate: rate50 ? 50 : 60 };
  };

  // ── ゲームボーイの書き込み列 → VGM (MML.VGM.encodeGbRecording) — DESIGN-GB-CAPTURE.md §4 ──
  // 入力: { frames: [[write...]...], clock, name, creator, notes }
  //   write = { addr($FF10-$FF3F), value, t(フレーム頭からの T) }、frames[f].len = そのフレームの長さ(T。無ければ 70224)
  //   本体 APU は VGM の正規チップ: ヘッダ $80 にクロック(DMG/CGB/SGB2 は 4194304、SGB 初代は 4295454)、0xB3 aa dd(aa = 番地 - $FF10)。
  //   1 フレームは 70224T ≒ 738.35 サンプルで 0x62(735)に乗らないので、時刻は録音頭からの通算 T をサンプルへ換算して 0x61 で待つ
  //   (フレーム境界の端数は自然に 738/739 へ散る)。フレーム内の時刻も T から換算するので、PCM 再生の技の間隔が保たれる。
  const GB_CLOCK = 4194304, GB_FRAME_T = 70224;
  VGM.encodeGbRecording = function (rec) {
    const frames = rec.frames || [];
    const clock = rec.clock || GB_CLOCK;
    const body = [];
    let emitted = 0, dropped = 0, baseT = 0, writes = 0;
    const flushWait = (s) => {
      let d = s - emitted;
      while (d > 0) {
        if (d > 0xFFFF) { body.push(0x61, 0xFF, 0xFF); d -= 0xFFFF; }
        else if (d <= 16) { body.push(0x70 + d - 1); d = 0; }
        else { body.push(0x61, ...u16(d)); d = 0; }
      }
      if (s > emitted) emitted = s;
    };
    const toSample = (t) => Math.floor(t * 44100 / clock);
    for (let f = 0; f < frames.length; f++) {
      const list = frames[f] || [];
      const len = list.len > 0 ? list.len : GB_FRAME_T;
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (w.addr === undefined) continue;
        if (w.addr < 0xFF10 || w.addr > 0xFF3F) { dropped++; continue; }
        flushWait(toSample(baseT + Math.max(0, Math.min(len - 1, w.t | 0))));
        body.push(0xB3, w.addr - 0xFF10, w.value & 0xFF);
        writes++;
      }
      baseT += len;
    }
    const total = toSample(baseT);
    flushWait(total);
    body.push(0x66);

    const fields = [].concat(utf16(rec.name || ''), utf16(''), utf16(rec.game || ''), utf16(''),
      utf16(rec.system || 'Nintendo Game Boy'), utf16(''), utf16(rec.artist || ''), utf16(''), utf16(''),
      utf16(rec.creator || 'Sound Emulation Foundry'), utf16(rec.notes || ''));
    const gd3 = [].concat([0x47, 0x64, 0x33, 0x20], u32(0x100), u32(fields.length), fields);
    const hdr = new Uint8Array(HEADER_SIZE);
    hdr.set([0x56, 0x67, 0x6D, 0x20], 0);
    const size = HEADER_SIZE + body.length + gd3.length;
    hdr.set(u32(size - 4), 0x04);
    hdr.set(u32(0x00000161), 0x08);
    hdr.set(u32(HEADER_SIZE + body.length - 0x14), 0x14);
    hdr.set(u32(total), 0x18);
    hdr.set(u32(60), 0x24);
    hdr.set(u32(HEADER_SIZE - 0x34), 0x34);
    hdr.set(u32(clock), 0x80);
    const vgm = new Uint8Array(size);
    vgm.set(hdr, 0); vgm.set(body, HEADER_SIZE); vgm.set(gd3, HEADER_SIZE + body.length);
    return { vgm, frames: frames.length, dropped, writes, samples: total, clock };
  };
})(typeof window !== 'undefined' ? window : globalThis);
