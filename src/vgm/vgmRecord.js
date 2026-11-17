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
  //   { sgbSpc: Uint8Array, t } / { sgbPort, value, t } はスーパーゲームボーイの SNES 側の音源(GBXX 種類 1。本ツールの再生はまだ鳴らさない)。
  //   { buzz: 音の番号, t } はカートリッジ内ブザー(HuC3)。規格外ブロック GBXX(vgmHeader.js)で載せる(本ツールの再生はまだ鳴らさない)。
  const GB_CLOCK = 4194304, GB_FRAME_T = 70224;
  VGM.encodeGbRecording = function (rec) {
    const frames = rec.frames || [];
    const clock = rec.clock || GB_CLOCK;
    const body = [];
    let emitted = 0, dropped = 0, baseT = 0, writes = 0, buzzes = 0, sgbPorts = 0;
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
        if (w.buzz !== undefined && VGM.GBXX) { // カートリッジ内ブザー: 規格外ブロック(種類 2、音の番号)
          flushWait(toSample(baseT + Math.max(0, Math.min(len - 1, w.t | 0))));
          const blk = [].concat(VGM.GBXX.MAGIC, [VGM.GBXX.VERSION, VGM.GBXX.KIND_BUZZER, w.buzz & 3]);
          body.push(0x67, 0x66, VGM.GBXX.TYPE, ...u32(blk.length), ...blk);
          buzzes++;
          continue;
        }
        if ((w.sgbSpc || w.sgbPort !== undefined) && VGM.GBXX) { // スーパーゲームボーイの SNES 側の音源: 規格外ブロック(種類 1)。下位種別 0 = 音源の像(.spc の形)、1 = APU ポートへの書き込み(ポート番号、値)
          flushWait(toSample(baseT + Math.max(0, Math.min(len - 1, w.t | 0))));
          const head = [].concat(VGM.GBXX.MAGIC, [VGM.GBXX.VERSION, VGM.GBXX.KIND_SGB]);
          if (w.sgbSpc) { body.push(0x67, 0x66, VGM.GBXX.TYPE, ...u32(head.length + 1 + w.sgbSpc.length), ...head, VGM.GBXX.SGB_STATE); for (let k = 0; k < w.sgbSpc.length; k++) body.push(w.sgbSpc[k]); }
          else { body.push(0x67, 0x66, VGM.GBXX.TYPE, ...u32(head.length + 7), ...head, VGM.GBXX.SGB_PORT, w.sgbPort & 3, w.value & 0xFF, ...u32((w.c || 0) >>> 0)); sgbPorts++; }
          continue;
        }
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
    return { vgm, frames: frames.length, dropped, writes, buzzes, sgbPorts, samples: total, clock };
  };

  // ── PC エンジンの書き込み列 → VGM (MML.VGM.encodePceRecording) — DESIGN-PCE-CAPTURE.md §6 ──
  // 入力: { frames: [[write...]...], name, creator, notes }
  //   write = { addr(音源のレジスタ 0-9 = $0800-$0809), value, t(画面の頭からのマスタークロック) }、
  //   frames[f].len = その画面の長さ(マスタークロック。無ければ 1365×263)
  //   波形メモリ音源は VGM の正規チップ: ヘッダ $A4 にクロック 3579545(マスタークロック÷6)、0xB9 aa dd。
  //   1 画面は 262 行なら 734.3 サンプル、263 行なら 737.1 サンプルで 0x62(735)に乗らないので、時刻は録音頭からの通算を
  //   サンプルへ換算して 0x61 で待つ(GB と同じ)。画面の中の時刻も保たれるので、DDA(PCM)の間隔がそのまま残る。
  const PCE_MASTER = 21477270, PCE_FRAME = 1365 * 263, PCE_CHIP_CLOCK = 3579545;
  VGM.encodePceRecording = function (rec) {
    const frames = rec.frames || [];
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
    const toSample = (t) => Math.floor(t * 44100 / PCE_MASTER);
    for (let f = 0; f < frames.length; f++) {
      const list = frames[f] || [];
      const len = list.len > 0 ? list.len : PCE_FRAME;
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (w.addr === undefined) continue;
        if (w.addr < 0 || w.addr > 9) { dropped++; continue; }
        flushWait(toSample(baseT + Math.max(0, Math.min(len - 1, w.t | 0))));
        body.push(0xB9, w.addr, w.value & 0xFF);
        writes++;
      }
      baseT += len;
    }
    const total = toSample(baseT);
    flushWait(total);
    body.push(0x66);

    const fields = [].concat(utf16(rec.name || ''), utf16(''), utf16(rec.game || ''), utf16(''),
      utf16(rec.system || 'NEC PC Engine'), utf16(''), utf16(rec.artist || ''), utf16(''), utf16(''),
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
    hdr.set(u32(PCE_CHIP_CLOCK), 0xA4);
    const vgm = new Uint8Array(size);
    vgm.set(hdr, 0); vgm.set(body, HEADER_SIZE); vgm.set(gd3, HEADER_SIZE + body.length);
    return { vgm, frames: frames.length, dropped, writes, samples: total, clock: PCE_CHIP_CLOCK };
  };

  /*
   * CP システム III の録音からループを探す(DESIGN-CPS3-CAPTURE.md §13)。
   * frames: [{ n0, n1, w: [レジスタ番号, 値, n, …] }]。戻り値 { start, length, checked, matched, verified } か null
   * (start / length は録り始めを 0 とした音源のサンプル数)。
   *
   * やり方: キーオンの列(声ごとに、時刻と「開始番地+ピッチ」)を作り、ある周期 T だけ後に同じ声・同じキーのキーオンがあるかを見る。
   *   - フレームごとの書き込みの並びは比べない。曲の 1 小節がフレームの整数倍でないと、周回ごとに書き込みのフレームがずれて一致しない
   *     (実測: 1 小節 347.3 フレームの曲で、フレーム単位の一致率は最高でも 12%)。なので時刻に ±1.5 フレームの幅を持たせる
   *   - 周期の候補は、同じ声の同じキーどうしの時刻の差の多数決。確かめる時に、相手との差の中央値で T を詰める
   *   - 相手のいないキーオンのうち最後の物までがイントロ、その後がループ
   *   - 「確かめられた区間」(録音の長さ − T − 開始)が短い物は採らない(曲の中の繰り返しを 1 周と見誤る。実測: 90 秒の録音で
   *     65 秒のループを 46 秒と誤った)。min(T の半分, 25 秒) 以上を要る。録音が足りなければ「ループ無し」になる
   *   - 最後に、継ぎ目を「音源の状態が 1 周後と同じになる所」へ後ろにずらす(cps3SeamStart)。上で決めた開始位置はイントロの直後なので、
   *     イントロの最後の音がまだ鳴っている。そこへ 1 周目の終わりから戻ると「鳴っているはずの声が止まっている」状態になり、
   *     その声のビットを立てたままのキーの書き込みで、関係ない音が鳴り直す(実測: ループの頭で「ぽーん」と鳴る)
   */
  // 継ぎ目の位置を選ぶ。start 以降のフレームの頭のうち、その時点(s)と 1 周後(s + T)とで音源の状態が一番近い所を返す。
  //   見る物: キーのビット(食い違うと鳴り直しや鳴らし損ねが起きるので最優先)、鳴っている声のレジスタ、前後 1.5 フレームに書き込みが無い事
  //   (周回ごとに書き込みの時刻が 1 フレームほど揺れるので、書き込みのすぐそばで切ると片方だけが継ぎ目をまたぐ)
  //   戻り値 { start, keyDiff }。keyDiff は残ったキーの食い違いの数
  VGM.cps3SeamStart = function (frames, start, T, end) {
    const RATE = (42954545 / 3) / 384, FRAME = RATE / 59.6, TOL = Math.round(FRAME * 1.5), n0 = frames[0].n0;
    let count = 0; for (const f of frames) count += f.w.length / 3;
    const at = new Float64Array(count), reg = new Uint16Array(count), val = new Uint16Array(count);
    { let k = 0; for (const f of frames) for (let i = 0; i + 2 < f.w.length; i += 3) { reg[k] = f.w[i]; val[k] = f.w[i + 1]; at[k] = f.w[i + 2] - n0; k++; } }
    const A = new Uint16Array(0x101), B = new Uint16Array(0x101);
    let ia = 0, ib = 0, best = null;
    const limit = Math.min(end - T - TOL * 2, start + 20 * RATE);            // ずらすのは 20 秒まで(イントロが長くなるだけで、1 周の長さは変わらない)
    const busy = (t) => { let lo = 0, hi = count; while (lo < hi) { const m = (lo + hi) >> 1; if (at[m] < t - TOL) lo = m + 1; else hi = m; } return lo < count && at[lo] <= t + TOL; };
    for (const f of frames) {
      const s = f.n0 - n0;
      if (s < start) continue;
      if (s > limit) break;
      while (ia < count && at[ia] < s) { if (reg[ia] <= 0x100) A[reg[ia]] = val[ia]; ia++; }
      while (ib < count && at[ib] < s + T) { if (reg[ib] <= 0x100) B[reg[ib]] = val[ib]; ib++; }
      const kx = A[0x100] ^ B[0x100]; let keyDiff = 0, regDiff = 0;
      for (let v = 0; v < 16; v++) {
        if (kx >> v & 1) { keyDiff++; continue; }
        if (!(A[0x100] >> v & 1)) continue;                                   // 止まっている声のレジスタは、次のキーオンまでに書き直される
        for (let r = v * 16; r < v * 16 + 16; r++) if (A[r] !== B[r]) regDiff++;
      }
      const score = keyDiff * 1e6 + ((busy(s) || busy(s + T)) ? 1e4 : 0) + regDiff * 100 + (s - start) / RATE;   // 同じなら早い方
      if (!best || score < best.score) best = { start: s, keyDiff, score };
      if (score < 1) break;                                                   // 完全に一致(これより後ろは遠くなるだけ)
    }
    return best || { start, keyDiff: -1 };
  };
  VGM.cps3FindLoop = function (frames, opt) {
    const RATE = (42954545 / 3) / 384, FRAME = RATE / 59.6, TOL = Math.round(FRAME * 1.5);
    const minLoop = ((opt && opt.minLoopSec) || 8) * RATE;
    if (!frames || !frames.length) return null;
    const n0 = frames[0].n0, end = frames[frames.length - 1].n1 - n0;
    const regs = new Uint16Array(0x180); let keyBits = 0;
    const ev = []; for (let v = 0; v < 16; v++) ev.push([]);
    for (const f of frames) for (let i = 0; i + 2 < f.w.length; i += 3) {
      const reg = f.w[i], val = f.w[i + 1], t = f.w[i + 2] - n0;
      if (reg < 0x100) { regs[reg] = val; continue; }
      if (reg !== 0x100) continue;
      for (let v = 0; v < 16; v++) if ((val >> v & 1) && !(keyBits >> v & 1)) ev[v].push({ t, key: regs[v * 16 + 2] + regs[v * 16 + 3] * 65536 + regs[v * 16 + 6] * 4294967296 });
      keyBits = val;
    }
    if (ev.reduce((a, e) => a + e.length, 0) < 40) return null;
    const BIN = Math.round(FRAME), votes = new Map();
    for (const list of ev) {
      const byKey = new Map();
      for (const e of list) { let a = byKey.get(e.key); if (!a) byKey.set(e.key, a = []); a.push(e.t); }
      for (const ts of byKey.values()) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length && j < i + 400; j++) {
        const d = ts[j] - ts[i]; if (d < minLoop) continue; if (d > end * 0.75) break;
        const b = Math.round(d / BIN); votes.set(b, (votes.get(b) || 0) + 1);
      }
    }
    if (!votes.size) return null;
    const score = (b) => (votes.get(b) || 0) + (votes.get(b - 1) || 0) + (votes.get(b + 1) || 0);
    const cands = Array.from(votes.keys()).sort((a, b) => score(b) - score(a)).slice(0, 60);
    const find = (list, key, t) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t - TOL) lo = m + 1; else hi = m; } for (let k = lo; k < list.length && list[k].t <= t + TOL; k++) if (list[k].key === key) return list[k].t; return -1; };
    let best = null;
    for (const b of cands) {
      let T = b * BIN;
      for (let pass = 0; pass < 2; pass++) {
        const diffs = [];
        for (const list of ev) for (const e of list) { if (e.t + T > end - TOL) break; const m = find(list, e.key, e.t + T); if (m >= 0) diffs.push(m - e.t); }
        if (diffs.length < 20) { T = 0; break; }
        diffs.sort((x, y) => x - y); T = diffs[diffs.length >> 1];
      }
      if (!T) continue;
      let lastMiss = -1, checked = 0, matched = 0;
      for (const list of ev) for (const e of list) { if (e.t + T > end - TOL) break; checked++; if (find(list, e.key, e.t + T) >= 0) matched++; else if (e.t > lastMiss) lastMiss = e.t; }
      let start = lastMiss < 0 ? 0 : lastMiss + 1;
      const verified = end - T - start;
      if (verified < Math.max(10 * RATE, Math.min(T * 0.5, 25 * RATE))) continue;
      // 開始位置は、ループに入って最初のキーオンのあるフレームの頭
      let firstEv = Infinity; for (const list of ev) for (const e of list) if (e.t >= start && e.t < firstEv) firstEv = e.t;
      if (firstEv === Infinity) continue;
      let fs = 0; for (const f of frames) { if (f.n0 - n0 <= firstEv) fs = f.n0 - n0; else break; }
      start = Math.max(start, fs);
      const cand = { start, length: T, checked, matched, verified };
      // 倍の周期も必ず通るので、同じくらい確かなら短い周期を採る
      if (!best || cand.length < best.length * 0.75) best = cand;
    }
    if (best) { const seam = VGM.cps3SeamStart(frames, best.start, best.length, end); best.introEnd = best.start; best.start = seam.start; best.keyDiff = seam.keyDiff; }
    return best;
  };

  /*
   * CP システム III の録音 → VGM(規格外ブロック CP3X。DESIGN-CPS3-CAPTURE.md §3、vgmHeader.js VGM.CP3X)
   *
   * 入力: { frames: [{ n0, n1, w: [レジスタ番号, 値, n, …] }…], gfx, name, game, creator, autoLoop, trimSilence }
   *   n は音源の通算サンプル番号(その書き込みが「何サンプル目の前に効くか」)。gfx は波形のある領域を CPU から見える順のまま繋いだ物
   *   (音源が読む順はそれを 2 バイトずつ入れ替えた物。番地 0x400000 が先頭)。本体は src/emulator/cps3/cps3Console.js
   *   autoLoop: ループが見つかったら、イントロ+1 周ぶんで切ってループ位置を入れる(cps3FindLoop)
   *   trimSilence: ループが無い時、最後の音が消えてから 0.5 秒で切る(1 回で終わる曲)
   * 時刻: VGM のサンプル位置 s = ceil(n × 44100 ÷ 出力レート)。再生側は n = floor(s × 出力レート ÷ 44100) で同じ n に戻す
   * 波形: 録った書き込みを音源に通してみて、実際に読まれた所だけ(256 バイト単位)を入れる
   * 書き込みのブロックは 735 サンプルごと。ループの頭はブロックの境目に来るように、そこから数え直す
   */
  VGM.encodeCps3Recording = function (rec) {
    const C = VGM.CP3X, frames = rec.frames || [], gfx = rec.gfx || new Uint8Array(0);
    const CLOCK = 14318182, RATE = (42954545 / 3) / 384, BIAS = 0x400000, FRAME = 735;
    const n0 = frames.length ? frames[0].n0 : 0, nEnd = frames.length ? frames[frames.length - 1].n1 : 0;
    let count = 0; for (const f of frames) count += f.w.length / 3;
    const reg = new Uint16Array(count), val = new Uint16Array(count), at = new Uint32Array(count);
    { let k = 0; for (const f of frames) for (let i = 0; i + 2 < f.w.length; i += 3) { reg[k] = f.w[i]; val[k] = f.w[i + 1]; at[k] = Math.max(0, f.w[i + 2] - n0); k++; } }
    let natTotal = Math.max(0, nEnd - n0);
    const loop = rec.autoLoop ? VGM.cps3FindLoop(frames) : null;
    if (loop) natTotal = Math.min(natTotal, loop.start + loop.length);
    // 音源に通す: 読まれた波形の範囲と、最後に音が出ていた位置
    const chip = new MML.Emu.Cps3Audio(CLOCK);
    chip.rom = gfx; chip.romBase = BIAS; chip.romXor = 1; chip.touched = new Uint8Array((gfx.length >>> 8) + 1);
    let lastSound = -1;
    for (let n = 0, k = 0; n < natTotal; n++) { while (k < count && at[k] <= n) { chip.write(reg[k], val[k]); k++; } chip.clock(); if (chip.outL !== 0 || chip.outR !== 0) lastSound = n; }
    let trimmed = false;
    if (!loop && rec.trimSilence && lastSound >= 0 && natTotal - lastSound > RATE) { natTotal = lastSound + Math.round(RATE * 0.5); trimmed = true; }
    while (count > 0 && at[count - 1] >= natTotal) count--;                // 切った後ろの書き込みは捨てる
    // ループの継ぎ目の後始末: 終わりの時点で鳴っている声のうち、ループの頭では止まっていた物を、終わりの直前で止める。
    // (頭では鳴っていて終わりでは止まっている声は直せない。cps3SeamStart がそうならない位置を選んでいる)
    let seamFix = null;
    if (loop) {
      let k0 = 0, k1 = 0; for (let i = 0; i < count; i++) if (reg[i] === 0x100) { if (at[i] < loop.start) k0 = val[i]; k1 = val[i]; }
      if (k1 & ~k0) seamFix = { at: natTotal - 1, reg: 0x100, val: k1 & k0 };
    }

    const chunks = []; let size = 0;
    const put = (bytes) => { const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); chunks.push(u); size += u.length; };
    const block = (kind, payloadLen) => put([0x67, 0x66, C.TYPE].concat(u32(payloadLen + 6), C.MAGIC, [C.VERSION, kind]));
    block(C.KIND_HEADER, 5); put(u32(CLOCK).concat([C.FLAG_OUT1_LEFT]));
    let romBytes = 0;
    const touched = chip.touched;
    for (let p = 0; p < touched.length; p++) {
      if (!touched[p]) continue;
      let q = p; while (q + 1 < touched.length && touched[q + 1]) q++;
      const from = p << 8, to = Math.min(gfx.length, (q + 1) << 8), data = new Uint8Array(to - from);
      for (let i = from; i < to; i++) data[i - from] = gfx[i ^ 1];           // 音源が読む順で入れる
      block(C.KIND_ROM, 4 + data.length); put(u32(from + BIAS)); put(data);
      romBytes += data.length; p = q;
    }
    const toS = (n) => Math.ceil(n * 44100 / RATE);
    const total = toS(natTotal), loopS = loop ? toS(loop.start) : -1;
    let k = 0, wait = 0, loopByte = -1;
    const flushWait = () => { while (wait > 0) { const d = Math.min(wait, 0xFFFF); put(d === FRAME ? [0x62] : [0x61].concat(u16(d))); wait -= d; } };
    // [sFrom, sTo) を 735 サンプルずつのブロックにして出す
    const emit = (sFrom, sTo) => {
      for (let s0 = sFrom; s0 < sTo; s0 += FRAME) {
        const s1 = Math.min(sTo, s0 + FRAME), j = k;
        while (k < count && toS(at[k]) < s1) k++;
        const fix = seamFix && s1 === sTo && sTo === total ? 1 : 0;        // 最後のブロックの末尾に後始末の書き込みを足す
        if (k > j || fix) {
          flushWait();
          const b = new Uint8Array((k - j + fix) * 6);
          const w = (o, t, r, v) => { b[o] = t & 0xFF; b[o + 1] = t >> 8; b[o + 2] = r & 0xFF; b[o + 3] = r >> 8; b[o + 4] = v & 0xFF; b[o + 5] = v >> 8; };
          for (let i = j; i < k; i++) w((i - j) * 6, Math.max(0, toS(at[i]) - s0), reg[i], val[i]);
          if (fix) w((k - j) * 6, Math.max(0, s1 - 1 - s0), seamFix.reg, seamFix.val);
          block(C.KIND_WRITES, b.length); put(b);
        }
        wait += s1 - s0;
      }
    };
    if (loop && loopS > 0 && loopS < total) { emit(0, loopS); flushWait(); loopByte = size; emit(loopS, total); }
    else { if (loop) loopByte = size; emit(0, total); }
    flushWait();
    put([0x66]);
    const bodyLen = size;
    const fields = [].concat(utf16(rec.name || ''), utf16(''), utf16(rec.game || ''), utf16(''),
      utf16(rec.system || 'CP System III'), utf16(''), utf16(rec.artist || ''), utf16(''), utf16(''),
      utf16(rec.creator || 'Sound Emulation Foundry'), utf16(rec.notes || ''));
    put([].concat([0x47, 0x64, 0x33, 0x20], u32(0x100), u32(fields.length), fields));
    const vgm = new Uint8Array(HEADER_SIZE + size);
    vgm.set([0x56, 0x67, 0x6D, 0x20], 0);
    vgm.set(u32(vgm.length - 4), 0x04);
    vgm.set(u32(0x00000171), 0x08);
    vgm.set(u32(HEADER_SIZE + bodyLen - 0x14), 0x14);
    vgm.set(u32(total), 0x18);
    if (loopByte >= 0) { vgm.set(u32(HEADER_SIZE + loopByte - 0x1C), 0x1C); vgm.set(u32(total - Math.max(0, loopS)), 0x20); }
    vgm.set(u32(60), 0x24);
    vgm.set(u32(HEADER_SIZE - 0x34), 0x34);
    let o = HEADER_SIZE; for (const c of chunks) { vgm.set(c, o); o += c.length; }
    return { vgm, frames: frames.length, dropped: 0, writes: count, samples: total, clock: CLOCK, romBytes, trimmed,
      loop: loop ? { startSec: loop.start / RATE, lengthSec: loop.length / RATE, matched: loop.matched, checked: loop.checked } : null };
  };
})(typeof window !== 'undefined' ? window : globalThis);
