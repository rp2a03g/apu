/*
 * CP システム III の本体(録音用。画面は作らない)。MML.Emu.Cps3.Machine
 * DESIGN-CPS3-CAPTURE.md 段階 10c。メモリマップ、暗号の解除、割り込み、DMA の状態は MAME src/mame/capcom/cps3.cpp
 * (BSD-3-Clause、THIRD-PARTY-NOTICES.md)に合わせた。
 *
 * 入力:
 *   bios  : BIOS(0x80000 バイト、暗号のまま)
 *   simm1 : プログラム(CD のファイル「10」= SIMM1 の像、8MB、暗号のまま)。simm2 は「20」(無いゲームは省略)
 *   gfx   : SIMM3 以降の像を CPU から見える順に繋いだ物(CD の「30」「31」「40」…をそのまま連結)
 *   key1, key2, alt : ゲームごとの鍵と方式(MAME の init_crypt の引数)
 *
 * 暗号: 番地と鍵から作る 16bit のマスクを 32bit に並べて XOR するだけ。
 *   - BIOS は命令もデータも解いた物が見える
 *   - プログラムのフラッシュ(0x06000000〜)は、命令は解いた物、データは alt = 0 なら解いた物・alt ≠ 0 なら生
 *   - 0xC0000000〜の 1KB(SH-2 のキャッシュを RAM として使う領域)は、データは生、命令は解いた物
 *   - SH-2 内蔵の DMA は暗号を通らない(生の値が流れる)。BIOS とフラッシュを元にした DMA は生を読ませる
 *
 * 画面まわりで作ってあるのは「CPU から見える状態」だけ: スプライト/パレット/キャラクタの各 DMA は実際の転送や展開をせず、
 * 状態ビットと完了の割り込み(レベル 10)だけ出す。垂直帰線の割り込みはレベル 12、1 フレーム = 264 ライン。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  const Cps3 = Emu.Cps3 = Emu.Cps3 || {};

  const CPU_HZ = 25000000;                                   // 6.25MHz × 4
  const FRAME_CYCLES = CPU_HZ * 546 * 264 / (42954545 / 5);  // 画素クロック 42.954545MHz/5、横 546、縦 264 → 59.60Hz
  const VBLANK_LINE = 224, LINES = 264;

  // ゲームごとの鍵(MAME cps3.cpp の init_*)
  Cps3.KEYS = {
    redearth: [0x9e300ab1, 0xa175b82c, 0], sfiii: [0xb5fe053e, 0xfc03925a, 0], sfiii2: [0x00000000, 0x00000000, 1],
    jojo: [0x02203ee3, 0x01301972, 0], sfiii3: [0xa55432b4, 0x0c129981, 0], jojoba: [0x23323ee3, 0x03021972, 0]
  };

  const rotl16 = (v, n) => ((v << n) | (v >>> (16 - n))) & 0xFFFF;
  const rotxor = (val, x) => { const res = (val + rotl16(val, 2)) & 0xFFFF; return (rotl16(res, 4) ^ (res & (val ^ x))) & 0xFFFF; };
  function makeMask(key1, key2, alt) {
    if (alt === 2) return () => 0;
    return (address) => {
      address = (address ^ key1) >>> 0;
      let val = (address & 0xFFFF) ^ 0xFFFF;
      val = rotxor(val, key2 & 0xFFFF);
      val ^= (address >>> 16) ^ 0xFFFF;
      val = rotxor(val, key2 >>> 16);
      val ^= (address & 0xFFFF) ^ (key2 & 0xFFFF);
      return ((val << 16) | val) >>> 0;
    };
  }
  Cps3.makeMask = makeMask;

  // フラッシュ素子(富士通 MBM29F016A)。作ってあるのは ID の読み出しだけ: BIOS は起動時に素子の種類を確かめる。
  // 書き込み・消去(CD からの書き込み手順)は作らない。手順は MAME の intelfsh.cpp と同じ: 0xAA → 0x55 → 0x90 で ID、0xF0/0xFF で戻る。0x90 単独でも ID
  class FlashChip {
    constructor() { this.mode = 0; }            // 0 = 通常、1/2 = 手順の途中、3 = ID を返す
    /** 戻り値: 通常でなくなった +1、通常に戻った -1、変わらず 0 */
    write(d) {
      const was = this.mode !== 0;
      if (this.mode === 1) this.mode = d === 0x55 ? 2 : 0;
      else if (this.mode === 2) this.mode = d === 0x90 ? 3 : 0;
      else if (d === 0xF0 || d === 0xFF) this.mode = 0;
      else if (d === 0x90) this.mode = 3;
      else if (d === 0xAA) this.mode = 1;
      return (this.mode !== 0 ? 1 : 0) - (was ? 1 : 0);
    }
    id(addr) { const a = addr & 0xFF; return a === 0 ? 0x04 : a === 1 ? 0xAD : 0; }   // メーカー = 富士通、素子 = 0xAD
  }

  class Machine {
    constructor(opt) {
      this.mask = makeMask(opt.key1 >>> 0, opt.key2 >>> 0, opt.alt | 0);
      this.alt = opt.alt | 0;
      const dec = (raw, base) => {
        const out = new Uint8Array(raw.length), s = new DataView(raw.buffer, raw.byteOffset, raw.length), d = new DataView(out.buffer);
        for (let i = 0; i + 3 < raw.length; i += 4) d.setUint32(i, (s.getUint32(i) ^ this.mask(base + i)) >>> 0);
        return out;
      };
      this.biosRaw = opt.bios; this.bios = dec(opt.bios, 0);
      this.flashRaw = new Uint8Array(0x1000000).fill(0xFF);
      this.flashRaw.set(opt.simm1.subarray(0, 0x800000), 0);
      this.hasSimm2 = !!opt.simm2;
      if (opt.simm2) this.flashRaw.set(opt.simm2.subarray(0, 0x800000), 0x800000);
      this.flashOp = dec(this.flashRaw, 0x6000000);
      this.flashData = this.alt ? this.flashRaw : this.flashOp;
      this.gfx = opt.gfx || new Uint8Array(0);

      this.ram = new Uint8Array(0x80000); this.fram = new Uint8Array(0x400); this.spr = new Uint8Array(0x80000);
      this.col = new Uint8Array(0x40000); this.ppu = new Uint8Array(0x100); this.cram = new Uint8Array(0x800000);
      this.ssram = new Uint8Array(0x10000); this.ssregs = new Uint8Array(0x30);
      this.cache = new Uint8Array(0x400); this.cacheOp = new Uint8Array(0x400);
      this.eeprom = new Uint16Array(0x40); this.eepromRead = 0;
      this.snd = new Uint32Array(0x300 >> 2);
      const dv = (u) => new DataView(u.buffer, u.byteOffset, u.length);
      this.vBios = dv(this.bios); this.vBiosRaw = dv(this.biosRaw); this.vFlashOp = dv(this.flashOp); this.vFlashData = dv(this.flashData); this.vFlashRaw = dv(this.flashRaw);
      this.vRam = dv(this.ram); this.vSpr = dv(this.spr); this.vCol = dv(this.col); this.vPpu = dv(this.ppu); this.vCram = dv(this.cram);
      this.vCache = dv(this.cache); this.vCacheOp = dv(this.cacheOp); this.vGfx = dv(this.gfx); this.vFram = dv(this.fram);

      this.inputs = 0xFFFFFFFF; this.extra = 0xFFFFFFFF;       // 押していない = 1
      this.cramBank = 0; this.gfxBank = 0; this.dmaStatus = 0; this.spriteDma = 0;
      this.events = [];                                         // { at: 通算サイクル, kind }(kind: 1 = スプライト DMA の終わり、2 = キャラクタ/パレット DMA の終わり)
      this.eepromDirty = false;                                 // EEPROM が書かれた(ゲーム画面がブラウザへ保存する合図)
      this.frame = 0;
      this.onSoundWrite = null;                                 // (番地 - 0x040E0000 を 4 で丸めた物, 値 32bit, マスク 32bit, 秒)
      this.unmapped = new Map();                                // 作っていない番地への読み書き(番地の上位 → 回数)
      this.flashWrites = 0;
      this.progChips = Array.from({ length: 8 }, () => new FlashChip());        // SIMM1/2 × 4 個(バイト位置ごとに 1 個)
      this.gfxChips = Array.from({ length: 40 }, () => new FlashChip());        // SIMM3〜7 × 8 個
      this.flashBusy = 0;                                                        // 通常でない素子の数(0 なら読み出しは配列を見るだけ)

      this.cpu = new Cps3.SH2(this);
      this.cpu.onDmaRead = (a, size) => {
        if (a < 0x80000) return size === 0 ? this.biosRaw[a] : size === 1 ? this.vBiosRaw.getUint16(a & ~1) : this.vBiosRaw.getUint32(a & ~3);
        if (a >= 0x6000000 && a < 0x7000000) {
          const o = a - 0x6000000;
          if (this.flashBusy) {                                                    // 素子が ID を返している間(BIOS は ID も DMA で読む)
            const by = (x) => { const c = this.progChips[(x >= 0x800000 ? 4 : 0) + (x & 3)]; return c.mode === 3 ? c.id((x & 0x7FFFFF) >> 2) : this.flashRaw[x]; };
            if (size === 0) return by(o); if (size === 1) { const e = o & ~1; return (by(e) << 8) | by(e + 1); }
            const e = o & ~3; return ((by(e) << 24) | (by(e + 1) << 16) | (by(e + 2) << 8) | by(e + 3)) >>> 0;
          }
          return size === 0 ? this.flashRaw[o] : size === 1 ? this.vFlashRaw.getUint16(o & ~1) : this.vFlashRaw.getUint32(o & ~3);
        }
        return size === 0 ? this.r8(a) : size === 1 ? this.r16(a) : this.r32(a);
      };
      this.frameStart = 0; this.vblDone = false;
      this.onFrameEnd = null;                                   // フレームの終わり(ゲーム画面の本体が絵を作る所)
    }

    get seconds() { return this.cpu.cycles / CPU_HZ; }
    _miss(a, w) { const k = (w ? 'W ' : 'R ') + (a >>> 0).toString(16).padStart(8, '0').slice(0, 6); this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1); }
    schedule(delayCycles, kind) {
      const at = this.cpu.cycles + delayCycles;
      this.events.push({ at, kind }); this.events.sort((x, y) => x.at - y.at);
      if (this.cpu.stopAt > at) this.cpu.stopAt = at;
    }

    // ── 命令の取り出し ─────────────────────────────────────────
    fetch(pc) {
      if (pc < 0x40000000) pc &= 0x07FFFFFF;
      if (pc < 0x80000) return this.vBios.getUint16(pc);
      if (pc >= 0x6000000 && pc < 0x7000000) return this.vFlashOp.getUint16(pc - 0x6000000);
      if (pc >= 0xC0000000 && pc < 0xC0000400) return this.vCacheOp.getUint16(pc - 0xC0000000);
      if (pc >= 0x2000000 && pc < 0x2080000) return this.vRam.getUint16(pc - 0x2000000);
      this._miss(pc, false); return 0x0009;
    }

    // ── 読み出し ───────────────────────────────────────────────
    r32(a) {
      const top = a >>> 28; if (top === 0 || top === 2) a &= 0x07FFFFFF;
      if (a >= 0x2000000 && a < 0x2080000) return this.vRam.getUint32(a - 0x2000000);
      if (a < 0x80000) return this.vBios.getUint32(a);
      if (a >= 0x6000000 && a < 0x7000000 && !this.flashBusy) return this.vFlashData.getUint32(a - 0x6000000);
      if (a >= 0xFFFFFE00) return this.cpu.ir32(a);
      if (a >= 0x4000000 && a < 0x4080000) return this.vSpr.getUint32(a - 0x4000000);
      return ((this.r16(a) << 16) | this.r16((a + 2) >>> 0)) >>> 0;
    }
    r16(a) {
      const top = a >>> 28; if (top === 0 || top === 2) a &= 0x07FFFFFF;
      if (a >= 0x2000000 && a < 0x2080000) return this.vRam.getUint16(a - 0x2000000);
      if (a < 0x80000) return this.vBios.getUint16(a);
      if (a >= 0x6000000 && a < 0x7000000) return this.flashBusy ? (this._progByte(a) << 8) | this._progByte(a + 1) : this.vFlashData.getUint16(a - 0x6000000);
      if (a >= 0x4000000 && a < 0x4080000) return this.vSpr.getUint16(a - 0x4000000);
      if (a >= 0x4080000 && a < 0x40C0000) return this.vCol.getUint16(a - 0x4080000);
      if (a >= 0x40C0000 && a < 0x40C0100) return a === 0x40C000C ? this.dmaStatus : 0;
      if (a >= 0x40E0000 && a < 0x40E0300) { const v = this.snd[(a - 0x40E0000) >> 2]; return (a & 2) ? v & 0xFFFF : v >>> 16; }
      if (a >= 0x4100000 && a < 0x4200000) return this.vCram.getUint16((this.cramBank & 7) * 0x100000 + (a - 0x4100000));
      if (a >= 0x4200000 && a < 0x4400000) { if (this.flashBusy) return (this._gfxByte(a) << 8) | this._gfxByte(a + 1); const o = this.gfxBank * 0x200000 + (a - 0x4200000); return o >= 0 && o + 1 < this.gfx.length ? this.vGfx.getUint16(o) : 0xFFFF; }
      if (a >= 0x5000000 && a < 0x5000008) { const v = a < 0x5000004 ? this.inputs : this.extra; return (a & 2) ? v & 0xFFFF : v >>> 16; }
      if (a >= 0x5000A00 && a < 0x5000A20) return 0xFFFF;
      if (a >= 0x5001000 && a < 0x5001204) {
        const o = a - 0x5001000;
        if (o >= 0x100 && o < 0x180) { this.eepromRead = this.eeprom[(o - 0x100) >> 1]; return 0; }
        return o === 0x202 ? this.eepromRead : 0;
      }
      if (a >= 0x5040000 && a < 0x5050000) return this.ssram[(a - 0x5040000) >> 1];
      if (a >= 0x5140000 && a < 0x5140004) return 0;                                  // SCSI(CD)。CD 無しの起動では使わない
      if (a >= 0x3000000 && a < 0x3000400) return this.vFram.getUint16(a - 0x3000000);
      if (a >= 0xC0000000 && a < 0xC0000400) return this.vCache.getUint16(a - 0xC0000000);
      if (a >= 0xFFFFFE00) return this.cpu.ir16(a);
      if (a >= 0x40000000 && a < 0xC0000000) return 0xA5A5;
      this._miss(a, false); return 0;
    }
    r8(a) {
      const top = a >>> 28; if (top === 0 || top === 2) a &= 0x07FFFFFF;
      if (a >= 0x2000000 && a < 0x2080000) return this.ram[a - 0x2000000];
      if (a < 0x80000) return this.bios[a];
      if (a >= 0x6000000 && a < 0x7000000) return this.flashBusy ? this._progByte(a) : this.flashData[a - 0x6000000];
      if (a >= 0xFFFFFE00) return this.cpu.ir8(a);
      if (a >= 0x5040000 && a < 0x5050000) return (a & 1) ? this.ssram[(a - 0x5040000) >> 1] : 0;
      const w = this.r16((a & ~1) >>> 0);
      return (a & 1) ? w & 0xFF : w >>> 8;
    }

    // 素子が ID を返している間の読み出し(1 バイトずつ)。プログラム側は読んだ値にも暗号のマスクがかかる(alt = 0 の時)
    _progByte(a) {
      const o = a - 0x6000000, lane = o & 3, chip = this.progChips[(o >= 0x800000 ? 4 : 0) + lane];
      if (chip.mode !== 3) return this.flashData[o];
      const v = chip.id((o & 0x7FFFFF) >> 2);
      return this.alt ? v : (v ^ (this.mask(a & ~3) >>> (24 - lane * 8))) & 0xFF;
    }
    _gfxByte(a) {
      const off = a - 0x4200000, pair = this.gfxBank & ~1, chip = this.gfxChips[pair + (off & 1)];
      if (chip && chip.mode === 3) return chip.id(((off >> 1) + ((this.gfxBank & 1) ? 0x100000 : 0)));
      const o = this.gfxBank * 0x200000 + off;
      return o >= 0 && o < this.gfx.length ? this.gfx[o] : 0xFF;
    }

    // ── 書き込み ───────────────────────────────────────────────
    w32(a, v) {
      const top = a >>> 28; if (top === 0 || top === 2) a &= 0x07FFFFFF;
      if (a >= 0x2000000 && a < 0x2080000) { this.vRam.setUint32(a - 0x2000000, v); return; }
      if (a >= 0x4000000 && a < 0x4080000) { this.vSpr.setUint32(a - 0x4000000, v); return; }
      if (a >= 0xFFFFFE00) { this.cpu.iw32(a, v); return; }
      this._io((a & ~3) >>> 0, v >>> 0, 0xFFFFFFFF);
    }
    w16(a, v) {
      const top = a >>> 28; if (top === 0 || top === 2) a &= 0x07FFFFFF;
      if (a >= 0x2000000 && a < 0x2080000) { this.vRam.setUint16(a - 0x2000000, v); return; }
      if (a >= 0x4000000 && a < 0x4080000) { this.vSpr.setUint16(a - 0x4000000, v); return; }
      if (a >= 0xFFFFFE00) { this.cpu.iw16(a, v); return; }
      if (a & 2) this._io((a & ~3) >>> 0, v & 0xFFFF, 0x0000FFFF); else this._io((a & ~3) >>> 0, (v << 16) >>> 0, 0xFFFF0000);
    }
    w8(a, v) {
      const top = a >>> 28; if (top === 0 || top === 2) a &= 0x07FFFFFF;
      if (a >= 0x2000000 && a < 0x2080000) { this.ram[a - 0x2000000] = v; return; }
      if (a >= 0x4000000 && a < 0x4080000) { this.spr[a - 0x4000000] = v; return; }
      if (a >= 0xFFFFFE00) { this.cpu.iw8(a, v); return; }
      const sh = 8 * (3 - (a & 3));
      this._io((a & ~3) >>> 0, ((v & 0xFF) << sh) >>> 0, (0xFF << sh) >>> 0);
    }
    // 32bit 単位に揃えた書き込み(a は 4 の倍数、mask は書かれたバイトの位置)
    _put(view, o, v, mask) { view.setUint32(o, mask === 0xFFFFFFFF ? v : ((view.getUint32(o) & ~mask) | (v & mask)) >>> 0); }
    _io(a, v, mask) {
      if (a >= 0x40E0000 && a < 0x40E0300) {
        const i = (a - 0x40E0000) >> 2;
        this.snd[i] = ((this.snd[i] & ~mask) | (v & mask)) >>> 0;
        if (this.onSoundWrite) this.onSoundWrite(a - 0x40E0000, v, mask, this.cpu.cycles / CPU_HZ);
        return;
      }
      if (a >= 0x4080000 && a < 0x40C0000) { this._put(this.vCol, a - 0x4080000, v, mask); return; }
      if (a >= 0x40C0000 && a < 0x40C0100) { this._put(this.vPpu, a - 0x40C0000, v, mask); this._ppu(a - 0x40C0000, v & mask, mask); return; }
      if (a >= 0x4100000 && a < 0x4200000) { this._put(this.vCram, (this.cramBank & 7) * 0x100000 + (a - 0x4100000), v, mask); return; }
      if (a >= 0x4200000 && a < 0x4400000) {                                           // 絵のフラッシュへのコマンド。素子は 2 個 1 組(偶数バイト = 1 個目)
        this.flashWrites++;
        const pair = this.gfxBank & ~1;
        if (pair >= 0 && pair + 1 < this.gfxChips.length) for (let k = 0; k < 4; k++) if (mask & (0xFF000000 >>> (k * 8))) this.flashBusy += this.gfxChips[pair + (k & 1)].write((v >>> (24 - k * 8)) & 0xFF);
        return;
      }
      if (a >= 0x5000000 && a < 0x5000010) return;                                     // 出力ポート(コインカウンタなど)
      if (a >= 0x5001000 && a < 0x5001204) {
        const o = a - 0x5001000;
        if (o >= 0x80 && o < 0x100) { const i = (o - 0x80) >> 1; if (mask & 0xFFFF0000) this.eeprom[i] = v >>> 16; if (mask & 0xFFFF) this.eeprom[i + 1] = v & 0xFFFF; this.eepromDirty = true; }
        return;
      }
      if (a >= 0x5040000 && a < 0x5050000) { const o = (a - 0x5040000) >> 1; if (mask & 0x00FF0000) this.ssram[o] = (v >>> 16) & 0xFF; if (mask & 0xFF) this.ssram[o + 1] = v & 0xFF; return; }
      if (a >= 0x5050000 && a < 0x505002C) { const o = (a - 0x5050000) >> 1; if (mask & 0x00FF0000) this.ssregs[o] = (v >>> 16) & 0xFF; if (mask & 0xFF) this.ssregs[o + 1] = v & 0xFF; return; }
      if (a === 0x5100000) { this.cpu.setIrq(12, false); return; }
      if (a === 0x5110000) { this.cpu.setIrq(10, false); return; }
      if (a === 0x5120000 || a === 0x5130000 || a === 0x5140000) return;
      if (a >= 0x6000000 && a < 0x7000000) {                                           // プログラムのフラッシュへのコマンド。素子は 4 個 1 組(バイト位置ごと)
        this.flashWrites++;
        const s = a >= 0x6800000 ? 4 : 0;
        for (let k = 0; k < 4; k++) if (mask & (0xFF000000 >>> (k * 8))) this.flashBusy += this.progChips[s + k].write((v >>> (24 - k * 8)) & 0xFF);
        return;
      }
      if (a >= 0x7FF0000 && a < 0x7FF0100) return;                                     // フラッシュの書き込み電圧など
      if (a >= 0x5000A00 && a < 0x5000A20) return;                                     // 開発用の表示器
      if (a >= 0x5150000 && a < 0x5150004) return;
      if (a >= 0x3000000 && a < 0x3000400) { this._put(this.vFram, a - 0x3000000, v, mask); return; }
      if (a >= 0xC0000000 && a < 0xC0000400) {
        const o = a - 0xC0000000;
        this._put(this.vCache, o, v, mask);
        this.vCacheOp.setUint32(o, (this.vCache.getUint32(o) ^ this.mask(a)) >>> 0);
        return;
      }
      if (a >= 0x40000000 && a < 0xC0000000) return;                                   // SH-2 のキャッシュの番地配列など(キャッシュは作らない)
      this._miss(a, true);
    }
    // 画面の制御レジスタ。v は書かれたバイトだけ(他は 0)
    _ppu(o, v, mask) {
      if (o === 0x80 && (mask & 0xFFFF)) {                                              // スプライトリストの DMA
        const prev = this.spriteDma; this.spriteDma = ((prev & ~mask) | (v & mask)) & 0xFFFF;
        if (!(this.dmaStatus & 1) && (this.spriteDma & 9) === 8 && (prev & 9) === 9) {
          this.dmaStatus |= 1;
          this.schedule(CPU_HZ * 4e-6, 1);
        }
      } else if (o === 0x84 && (mask & 0xFF)) this.cramBank = v & 0xFF;
      else if (o === 0x88 && (mask & 0xFF000000)) this.gfxBank = ((v >>> 16) - 2) | 0;
      else if (o === 0x98 && (mask & 0xFF000000) && ((v >>> 16) & 0x40)) this._dmaDone(2);   // キャラクタの DMA(展開はしない)
      else if (o === 0xAC && (mask & 0xFF) && (v & 2)) { this._paletteDma(v & 1); this._dmaDone(4); }   // パレットの DMA
    }
    // パレットの DMA: 絵のフラッシュから色の RAM へ 16bit ずつ写す(フェードつき)。MAME の palettedma_w と同じ。
    //   元 = (レジスタ 0xA0 << 1) - 0x400000、先 = レジスタ 0xA4、フェード = 0xA8、長さ = 0xAC の上位 16bit(+ bit0 が 17 ビット目)
    //   MAME は 16bit の並びを 1 つずつ入れ替えて読み書きしている(元も先も添字 ^ 1)。this.gfx は CPU から見える順なので、その 16bit はビッグエンディアン
    _paletteDma(hi) {
      const src = ((this.vPpu.getUint32(0xA0) << 1) - 0x400000) >> 1, dst = this.vPpu.getUint32(0xA4), fade = this.vPpu.getUint32(0xA8);
      const len = (this.vPpu.getUint32(0xAC) >>> 16) | (hi << 16), doFade = (fade & 0x40400040) !== 0;
      const f1 = (c, f) => (f & 0x40) ? ((f & 0x20) ? ((((c ^ 0x1F) * (~f & 0x1F)) >> 5) ^ 0x1F) : ((c * (f & 0x1F)) >> 5)) : c;
      for (let i = 0; i < len; i++) {
        const so = ((src + i) ^ 1) * 2;
        let data = so >= 0 && so + 1 < this.gfx.length ? this.vGfx.getUint16(so) : 0;
        if (doFade) data = (data & 0x8000) | f1(data & 0x1F, (fade >>> 24) & 0x7F) | (f1((data >> 5) & 0x1F, (fade >>> 16) & 0x7F) << 5) | (f1((data >> 10) & 0x1F, fade & 0x7F) << 10);
        this.vCol.setUint16((((dst + i) ^ 1) & 0x1FFFF) * 2, data);
      }
    }
    _dmaDone(bit) {
      this.dmaStatus |= bit;
      this.schedule(CPU_HZ * 100e-6, 2);   // 100µs は MAME の仮の値(実機の速さは不明)
    }
    _fire(kind) {
      if (kind === 1) this.dmaStatus &= ~1;
      else if (kind === 2) { this.dmaStatus &= ~6; this.cpu.setIrq(10, true); }
    }

    // ── 文字の面(スコアなどを出す 8×8 の面。テストモードもこの面)────────────
    /**
     * 文字の面だけを RGBA(384×224)に描く。他の面(スプライト、背景)は作っていないので地は黒。MAME の draw_fg_layer と同じ読み方:
     *   マップ = ssram の先頭から 1 行 128 バイト(64 マス × 2 バイト: 下位 9bit がタイル、bit9-13 がパレット、bit14/15 が上下/左右反転)
     *   タイルの絵 = ssram の 0x4000 から 1 個 32 バイト(4bpp、1 バイトに 2 画素で下位 4bit が左)。色 0 は透明
     *   行ごとの横ずらし = ssram の 0x2000 から 2 バイトおき
     */
    renderText(out) {
      const W = 384, H = 224, ss = this.ssram, col = this.vCol;
      const vscroll = this.ssregs[0x10] | (this.ssregs[0x11] << 8), palBase = this.ssregs[0x12] << 5;
      const scrolly = (-vscroll) & 0x100;
      out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255;
      for (let line = 0; line < H; line++) {
        const ty = (line + scrolly) & 7, row = ((((line + scrolly) >> 3) * 128) & 0x1FFF);
        const rowscroll = ss[(((line + scrolly - 1) & 0x1FF) * 2 + 0x2000) & 0xFFFF];
        for (let x = 0; x < 64; x++) {
          const data = ss[row + x * 2] | (ss[row + x * 2 + 1] << 8);
          const tile = data & 0x1FF, pal = ((data >> 9) & 0x1F) + palBase,          // 色の組は折り返さない(実測: SFIII の文字は色の RAM の 0x1FE10 付近を使う)
           flipy = data & 0x4000, flipx = data & 0x8000;
          const base = 0x4000 + tile * 32 + (flipy ? 7 - ty : ty) * 4;
          for (let px = 0; px < 8; px++) {
            const sx = flipx ? 7 - px : px, b = ss[base + (sx >> 1)], pix = (sx & 1) ? b >> 4 : b & 15;
            if (!pix) continue;
            let dx = x * 8 + px - rowscroll; if (dx < 0) dx += 512; if (dx >= W) continue;
            const c = col.getUint16(((pal * 16 + pix) & 0x1FFFF) * 2), o = (line * W + dx) * 4;
            out[o] = (c & 0x1F) << 3; out[o + 1] = ((c >> 5) & 0x1F) << 3; out[o + 2] = ((c >> 10) & 0x1F) << 3;
          }
        }
      }
      return out;
    }

    /** 文字の面を文字列で返す(タイル番号がそのまま文字コード。48 列 × 28 行。絵でしか出ていない物は '.')。台本での操作と検査用 */
    textScreen() {
      const ss = this.ssram, vscroll = this.ssregs[0x10] | (this.ssregs[0x11] << 8), scrolly = (-vscroll) & 0x100, rows = [];
      for (let y = 0; y < 28; y++) {
        const row = ((((y * 8 + scrolly) >> 3) * 128) & 0x1FFF); let s = '';
        for (let x = 0; x < 48; x++) {
          const d = ss[row + x * 2] | (ss[row + x * 2 + 1] << 8), c = d & 0x1FF;                 // タイル 0x00-0x0F は 16 進の数字(サウンドコードの表示など)
          s += !d ? ' ' : c < 0x10 ? '0123456789ABCDEF'[c] : c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '.';
        }
        rows.push(s.replace(/\s+$/, ''));
      }
      return rows;
    }

    // ── 状態の保存と復元 ────────────────────────────────────────
    // 大きい配列(RAM、スプライト RAM、色、キャラクタ RAM、文字の面)は 64KB のページに分け、prev(前回の状態)と中身が同じページは
    // 前回の物をそのまま指す。巻き戻しは 0.5 秒ごとに状態を控えるので、変わらないページ(キャラクタ RAM の大半など)を写さずに済む。
    // ROM(BIOS、プログラム、波形と絵)は入れない。
    saveState(prev) {
      const PAGE = 0x10000;
      const pages = (u, old) => {
        const out = [];
        for (let o = 0, k = 0; o < u.length; o += PAGE, k++) {
          const cur = u.subarray(o, Math.min(u.length, o + PAGE)), was = old && old[k];
          let same = !!was && was.length === cur.length;
          if (same) for (let i = 0; i < cur.length; i++) if (cur[i] !== was[i]) { same = false; break; }
          out.push(same ? was : cur.slice());
        }
        return out;
      };
      const p = prev || {};
      return {
        ram: pages(this.ram, p.ram), spr: pages(this.spr, p.spr), col: pages(this.col, p.col), cram: pages(this.cram, p.cram), ssram: pages(this.ssram, p.ssram),
        fram: this.fram.slice(), ppu: this.ppu.slice(), ssregs: this.ssregs.slice(), cache: this.cache.slice(), cacheOp: this.cacheOp.slice(),
        eeprom: this.eeprom.slice(), eepromRead: this.eepromRead, snd: this.snd.slice(),
        cramBank: this.cramBank, gfxBank: this.gfxBank, dmaStatus: this.dmaStatus, spriteDma: this.spriteDma,
        events: this.events.map((e) => ({ at: e.at, kind: e.kind })), frame: this.frame, frameStart: this.frameStart, vblDone: this.vblDone,
        flash: this.progChips.map((c) => c.mode).concat(this.gfxChips.map((c) => c.mode)), flashBusy: this.flashBusy,
        cpu: this.cpu.saveState()
      };
    }
    loadState(s) {
      const put = (u, pg) => { let o = 0; for (const x of pg) { u.set(x, o); o += x.length; } };
      put(this.ram, s.ram); put(this.spr, s.spr); put(this.col, s.col); put(this.cram, s.cram); put(this.ssram, s.ssram);
      this.fram.set(s.fram); this.ppu.set(s.ppu); this.ssregs.set(s.ssregs); this.cache.set(s.cache); this.cacheOp.set(s.cacheOp);
      this.eeprom.set(s.eeprom); this.eepromRead = s.eepromRead; this.snd.set(s.snd);
      this.cramBank = s.cramBank; this.gfxBank = s.gfxBank; this.dmaStatus = s.dmaStatus; this.spriteDma = s.spriteDma;
      this.events = s.events.map((e) => ({ at: e.at, kind: e.kind })); this.frame = s.frame; this.frameStart = s.frameStart; this.vblDone = s.vblDone;
      const all = this.progChips.concat(this.gfxChips); for (let i = 0; i < all.length; i++) all[i].mode = s.flash[i] | 0;
      this.flashBusy = s.flashBusy;
      this.cpu.loadState(s.cpu);
    }

    // ── 進行 ───────────────────────────────────────────────────
    _runTo(target) {
      const cpu = this.cpu;
      while (cpu.cycles < target) {
        while (this.events.length && this.events[0].at <= cpu.cycles) this._fire(this.events.shift().kind);
        cpu.stopAt = this.events.length ? Math.min(target, this.events[0].at) : target;
        cpu.run();
      }
    }
    /** target(通算サイクル)まで進める。途中でライン 224 に来たら垂直帰線の割り込み、フレームの終わりで onFrameEnd */
    advanceTo(target) {
      for (;;) {
        const end = this.frameStart + FRAME_CYCLES, next = this.vblDone ? end : this.frameStart + FRAME_CYCLES * VBLANK_LINE / LINES;
        if (next > target) { this._runTo(target); return; }
        this._runTo(next);
        if (!this.vblDone) { this.cpu.setIrq(12, true); this.vblDone = true; }
        else { this.vblDone = false; this.frameStart = end; this.frame++; if (this.onFrameEnd) this.onFrameEnd(); }
      }
    }
    /** 1 フレーム進める */
    runFrame() { this.advanceTo(this.frameStart + FRAME_CYCLES); }
  }

  Cps3.Machine = Machine;
  Cps3.CPU_HZ = CPU_HZ; Cps3.FRAME_CYCLES = FRAME_CYCLES;
})(typeof window !== 'undefined' ? window : globalThis);
