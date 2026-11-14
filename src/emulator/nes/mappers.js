/*
 * NES マッパー (MML.Emu.NesMappers) — 自前 NES エミュレータのバンク機構
 *
 * 対応: 0 NROM / 1 MMC1 / 2 UxROM / 3 CNROM / 4 MMC3 / 5 MMC5 / 7 AxROM / 9,10 MMC2・MMC4 / 16,153,159 Bandai FCG・LZ93D50 /
 *       18 Jaleco SS88006 / 19 Namco 163 / 21,22,23,25 VRC2・VRC4 / 24,26 VRC6 / 32 Irem G-101 / 33,48 Taito TC0190・TC0690 /
 *       34 BNROM・NINA-001 / 65 Irem H3001 / 66 GxROM / 67,68 Sunsoft-3・4 / 69 Sunsoft FME-7・5B / 70,152 Bandai 74161 /
 *       72,92 Jaleco JF-17・19 / 73 VRC3 / 75 VRC1 / 76,88,95,154 Namco 108 派生 / 77 Irem LROG017 / 78 Jaleco JF-16 /
 *       80,82 Taito X1-005・X1-017 / 85 VRC7 / 86,87,140 Jaleco JF-13 他 / 89,93 Sunsoft-2 / 94,97,180 UxROM 派生 /
 *       184 Sunsoft-1 / 185 CNROM 保護 / 206 Namco 108(DxROM) / 210 Namco 175・340。
 * 拡張音源つきの基板(5/19/24/26/69/85)は NSF 用の音源(Emu.VRC6Audio/VRC7Audio/MMC5Audio/N163Audio/FME7Audio)を
 * そのまま this.audio に挿し、extBits(NSF ヘッダと同じビット。録音の NESX ヘッダ用)を立てる。
 *   audioAddr(addr): CPU の書き込み番地を音源レジスタの正規の番地(NSF/VGM の慣例)に直す。音源でなければ -1。
 *     VRC6b(26)は A0/A1 を入れ替えて VRC6a の番地に、VRC7 は未使用のアドレス線を無視、5B は $C000/$E000 に畳む
 *     (tools/mesen/vgm-recorder.lua と同じ規則。録音のフレーム比較が同じ番地で揃う)。
 *   audioReadAddr(addr): 副作用のある読み出し(N163 $4800)。
 *   audioImage(): 録音開始時に先頭へ置く「今の音源の状態」を書き込み列で返す(影レジスタから。Mesen の録音と同じ順)。
 *
 * 作り: PRG は 8K×4 スロット、CHR は 1K×8 スロットの対応表(prgMap/chrMap)で、マッパーはレジスタ書き込みで
 * 表を書き換えるだけ。ネームテーブルも CIRAM(2K、4 画面なら 4K)の 1K ページ表(ntMap)で、ミラーリングは
 * 表の張り替え。N163 のように CHR ROM をネームテーブルに出せる基板は ppuRead/ppuWrite を上書きする。
 *
 * PPU との約束:
 *   ppuRead(addr)/ppuWrite(addr, v): $0000-$2FFF(パレットは PPU 側)。
 *   ppuA12(addr, time): PPU がパターン表/NT/属性を読むたびに呼ぶ(time = 単調なドット番号)。
 *     MMC3 の IRQ カウンタは A12 の立ち上がりで進む。実機は M2 のフィルタで「A12 が約 3 CPU サイクル(≒10 ドット)以上
 *     低かった後の立ち上がり」だけ数えるので、「A12 の低い読みが最初にあった時刻から 10 ドット以上たって高い読みが来たら
 *     1 回」と数える(BG が $1000・スプライトが $0000 なら行ごとにスプライト取得の窓で 1 回。行末 337 ドットの NT 読みから
 *     次の行の 5 ドットまでは 9 ドットなので数えない。以前は「最後に高かった時刻から 10 ドット」で数えていて、A12 が
 *     低くならなくても行末の隙間で 1 回余計に進み、IRQ が 2 倍の速さで来るゲームがあった)
 *     (実機のフィルタ=約 3 CPU サイクル低く続いてからの立ち上がりだけを数える、の近似)。
 *   cpuClock(cycles): CPU サイクル駆動の IRQ カウンタ(N163)用。irqPending(): IRQ 線。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NT_MODES = { H: [0, 0, 1, 1], V: [0, 1, 0, 1], '1A': [0, 0, 0, 0], '1B': [1, 1, 1, 1], '4': [0, 1, 2, 3] };

  class Mapper {
    constructor(rom) {
      this.rom = rom;
      this.prg = rom.prg;
      this.prgBanks8 = Math.max(1, this.prg.length >> 13);
      this.chrIsRam = !rom.chr;
      this.chr = rom.chr || new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrBanks1 = Math.max(1, this.chr.length >> 10);
      this.prgRam = new Uint8Array(Math.max(0x2000, rom.prgRamSize || 0x2000));
      this.ciram = new Uint8Array(rom.fourScreen ? 0x1000 : 0x800);
      this.prgMap = new Int32Array(4);
      this.chrMap = new Int32Array(8);
      this.ntMap = [0, 0, 1, 1];
      this.audio = null;      // 拡張音源(Emu.N163Audio など)。clock()/mixSample() を持つ
      this.ramRead = true; this.ramWrite = true; // PRG RAM($6000-$7FFF)の保護ビット(基板ごとに書き換える。無効なら読みは open bus、書きは捨てる)
      this.extBits = 0;
      this.ppu = null;        // PPU が自分を入れる(MMC5 が描画の位相を見る)
      this.irqFlag = false;
      this.setMirroring(rom.fourScreen ? '4' : rom.mirroring);
      this.setPrg32(0);
      this.setChr8(0);
    }
    setMirroring(mode) { this.ntMap = (NT_MODES[mode] || NT_MODES.H).slice(); }
    setPrg8(slot, bank) { bank %= this.prgBanks8; if (bank < 0) bank += this.prgBanks8; this.prgMap[slot] = bank << 13; }
    setPrg16(slot, bank) { const b16 = this.prgBanks8 >> 1 || 1; bank %= b16; if (bank < 0) bank += b16; this.setPrg8(slot * 2, bank * 2); this.setPrg8(slot * 2 + 1, bank * 2 + 1); }
    setPrg32(bank) { const b32 = this.prgBanks8 >> 2 || 1; bank %= b32; if (bank < 0) bank += b32; for (let i = 0; i < 4; i++) this.setPrg8(i, bank * 4 + i); }
    setChr1(slot, bank) { bank %= this.chrBanks1; if (bank < 0) bank += this.chrBanks1; this.chrMap[slot] = bank << 10; }
    setChr2(slot, bank) { this.setChr1(slot * 2, bank * 2); this.setChr1(slot * 2 + 1, bank * 2 + 1); }
    setChr8(bank) { for (let i = 0; i < 8; i++) this.setChr1(i, bank * 8 + i); }

    cpuRead(addr) {
      if (addr >= 0x8000) return this.prg[this.prgMap[(addr - 0x8000) >> 13] + (addr & 0x1FFF)];
      if (addr >= 0x6000) return this.ramRead ? this.prgRam[(addr - 0x6000) % this.prgRam.length] : -1;
      return -1;
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) this.writeReg(addr, v);
      else if (addr >= 0x6000) { if (this.ramWrite) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v; }
    }
    writeReg() {}
    ppuRead(addr) {
      if (addr < 0x2000) return this.chr[this.chrMap[addr >> 10] + (addr & 0x3FF)];
      return this.ciram[(this.ntMap[(addr >> 10) & 3] << 10) | (addr & 0x3FF)];
    }
    ppuWrite(addr, v) {
      if (addr < 0x2000) { if (this.chrIsRam) this.chr[this.chrMap[addr >> 10] + (addr & 0x3FF)] = v; }
      else this.ciram[(this.ntMap[(addr >> 10) & 3] << 10) | (addr & 0x3FF)] = v;
    }
    ppuA12() {}
    cpuClock() {}
    irqPending() { return this.irqFlag; }
    audioAddr() { return -1; }
    audioReadAddr() { return -1; }
    audioImage() { return []; }
  }

  // VRC4/VRC6/VRC7 共通の IRQ カウンタ(スキャンライン モード=341/3 サイクルごと、サイクル モード=毎サイクル)
  class VrcIrq {
    constructor() { this.latch = 0; this.counter = 0; this.enable = false; this.enableAfterAck = false; this.cycleMode = false; this.prescaler = 341; this.flag = false; }
    writeLatch(v) { this.latch = v; }
    writeControl(v) {
      this.enableAfterAck = (v & 1) !== 0; this.enable = (v & 2) !== 0; this.cycleMode = (v & 4) !== 0;
      this.flag = false;
      if (this.enable) { this.counter = this.latch; this.prescaler = 341; }
    }
    ack() { this.flag = false; this.enable = this.enableAfterAck; }
    clock(cycles) {
      if (!this.enable) return;
      for (let c = 0; c < cycles; c++) {
        if (!this.cycleMode) { this.prescaler -= 3; if (this.prescaler > 0) continue; this.prescaler += 341; }
        if (this.counter === 0xFF) { this.counter = this.latch; this.flag = true; }
        else this.counter++;
      }
    }
  }

  // 0: NROM
  class NROM extends Mapper {}

  // 1: MMC1(シフトレジスタ 5 回書き)
  //   大容量基板(Mesen と同じ扱い): PRG 512K(SUROM)は CHR レジスタの bit4 が PRG の 256K 側を選ぶ。PRG RAM が 32K(SXROM)なら
  //   CHR レジスタの bit2-3 が 8K バンク、16K(SOROM)なら bit3。CHR 4K モードで最後に書いたのが $C000 ならそちらのレジスタを使う。
  //   サブマッパー 5(SEROM/SHROM)は PRG 32K 固定。155(MMC1A)も同じ(PRG RAM の無効ビットはどちらでも見ない)。
  //   連続サイクルの二重書き: RMW 命令(INC $FFFF など)は古い値のダミー書きの次のサイクルに本物を書く。MMC1 は 2 つ目を無視する
  //   (NesConsole が cpuWrite の第 3 引数でダミー書きを知らせる)。リセット用の INC $FFFx で bit7 の古い値が効き、本物の 0 は捨てる
  class MMC1 extends Mapper {
    constructor(rom) {
      super(rom);
      this.shift = 0x10; this.control = 0x0C; this.chr0 = 0; this.chr1 = 0; this.prgReg = 0; this.lastChr = 0; this.skipWrite = false;
      this.fixed32 = (rom.submapper | 0) === 5;
      this.ramBanks = this.prgRam.length >> 13; // 1/2/4
      this.ramBank = 0;
      this.apply();
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[(this.ramBank << 13) | (addr & 0x1FFF)];
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v, rmwDummy) {
      if (addr >= 0x8000) {
        if (this.skipWrite) { this.skipWrite = false; return; } // ダミー書きの直後(同じ命令の本物の書き)は無視
        this.skipWrite = !!rmwDummy;
        this.writeReg(addr, v);
      } else if (addr >= 0x6000) this.prgRam[(this.ramBank << 13) | (addr & 0x1FFF)] = v;
    }
    writeReg(addr, v) {
      if (v & 0x80) { this.shift = 0x10; this.control |= 0x0C; this.apply(); return; }
      const full = this.shift & 1;
      this.shift = (this.shift >> 1) | ((v & 1) << 4);
      if (!full) return;
      const value = this.shift & 0x1F;
      this.shift = 0x10;
      switch ((addr >> 13) & 3) {
        case 0: this.control = value; break;
        case 1: this.chr0 = value; this.lastChr = 0; break;
        case 2: this.chr1 = value; this.lastChr = 1; break;
        case 3: this.prgReg = value; break;
      }
      this.apply();
    }
    apply() {
      this.setMirroring(['1A', '1B', 'V', 'H'][this.control & 3]);
      const chr4k = (this.control & 0x10) !== 0;
      const extra = (this.lastChr === 1 && chr4k) ? this.chr1 : this.chr0;
      const outer = this.prg.length === 0x80000 ? (extra & 0x10) : 0; // 512K: 16K バンク番号の bit4
      this.ramBank = this.ramBanks >= 4 ? (extra >> 2) & 3 : this.ramBanks === 2 ? (extra >> 3) & 1 : 0;
      const prgMode = (this.control >> 2) & 3, prg = (this.prgReg & 0x0F) | outer;
      if (this.fixed32) this.setPrg32(0);
      else if (prgMode < 2) this.setPrg32(prg >> 1);
      else if (prgMode === 2) { this.setPrg16(0, outer); this.setPrg16(1, prg); }
      else { this.setPrg16(0, prg); this.setPrg16(1, 0x0F | outer); }
      if (chr4k) { this.setChr1(0, this.chr0 * 4); this.setChr1(1, this.chr0 * 4 + 1); this.setChr1(2, this.chr0 * 4 + 2); this.setChr1(3, this.chr0 * 4 + 3);
        this.setChr1(4, this.chr1 * 4); this.setChr1(5, this.chr1 * 4 + 1); this.setChr1(6, this.chr1 * 4 + 2); this.setChr1(7, this.chr1 * 4 + 3); }
      else this.setChr8(this.chr0 >> 1);
    }
  }

  // 2: UxROM($8000-$BFFF 切替、末尾固定)
  class UxROM extends Mapper {
    constructor(rom) { super(rom); this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) { this.setPrg16(0, v & 0x0F); }
  }

  // 3: CNROM(CHR 8K 切替)
  class CNROM extends Mapper {
    writeReg(addr, v) { this.setChr8(v & 0x03); }
  }

  // 7: AxROM(PRG 32K 切替 + 1 画面)
  class AxROM extends Mapper {
    constructor(rom) { super(rom); this.setMirroring('1A'); }
    writeReg(addr, v) { this.setPrg32(v & 0x07); this.setMirroring((v & 0x10) ? '1B' : '1A'); }
  }

  // 4: MMC3(TxROM)
  class MMC3 extends Mapper {
    constructor(rom) {
      super(rom);
      this.regs = new Uint8Array(8); this.bankSelect = 0;
      this.irqLatch = 0; this.irqCounter = 0; this.irqReload = false; this.irqEnable = false;
      this.a12Low = -1; // A12 が低い読みが最初にあった時刻(高い読みで -1 に戻す)
      this.regs[6] = 0; this.regs[7] = 1;
      this.apply();
    }
    writeReg(addr, v) {
      switch (addr & 0xE001) {
        case 0x8000: this.bankSelect = v; this.apply(); break;
        case 0x8001: this.regs[this.bankSelect & 7] = v; this.apply(); break;
        case 0xA000: if (!this.rom.fourScreen) this.setMirroring((v & 1) ? 'H' : 'V'); break;
        case 0xA001: this.ramRead = (v & 0x80) !== 0; this.ramWrite = (v & 0xC0) === 0x80; break; // bit7 有効、bit6 書き込み禁止(MMC6 は別)
        case 0xC000: this.irqLatch = v; break;
        case 0xC001: this.irqReload = true; break;
        case 0xE000: this.irqEnable = false; this.irqFlag = false; break;
        case 0xE001: this.irqEnable = true; break;
      }
    }
    apply() {
      const r = this.regs, chrInv = (this.bankSelect & 0x80) ? 4 : 0, prgMode = this.bankSelect & 0x40;
      this.setChr1(0 ^ chrInv, r[0] & 0xFE); this.setChr1(1 ^ chrInv, (r[0] & 0xFE) + 1);
      this.setChr1(2 ^ chrInv, r[1] & 0xFE); this.setChr1(3 ^ chrInv, (r[1] & 0xFE) + 1);
      this.setChr1(4 ^ chrInv, r[2]); this.setChr1(5 ^ chrInv, r[3]); this.setChr1(6 ^ chrInv, r[4]); this.setChr1(7 ^ chrInv, r[5]);
      const last = this.prgBanks8 - 1;
      if (prgMode) { this.setPrg8(0, last - 1); this.setPrg8(1, r[7]); this.setPrg8(2, r[6]); this.setPrg8(3, last); }
      else { this.setPrg8(0, r[6]); this.setPrg8(1, r[7]); this.setPrg8(2, last - 1); this.setPrg8(3, last); }
    }
    ppuA12(addr, time) {
      if (addr & 0x1000) {
        if (this.a12Low >= 0 && time - this.a12Low >= 10) this.clockIrq();
        this.a12Low = -1;
      } else if (this.a12Low < 0) this.a12Low = time;
    }
    clockIrq() {
      if (this.irqCounter === 0 || this.irqReload) { this.irqCounter = this.irqLatch; this.irqReload = false; }
      else this.irqCounter--;
      if (this.irqCounter === 0 && this.irqEnable) this.irqFlag = true;
    }
  }

  // 206: Namco 108 / DxROM(MMC3 の前身。$8000/$8001 だけ、IRQ 無し、ミラーリングはヘッダ固定)
  class Namco108 extends MMC3 {
    writeReg(addr, v) {
      if ((addr & 0x8001) === 0x8000) { this.bankSelect = v & 0x07; this.apply(); }
      else if ((addr & 0x8001) === 0x8001) { this.regs[this.bankSelect & 7] = v & 0x3F; this.apply(); }
    }
    ppuA12() {}
  }

  // 19: Namco 163(PRG 8K×3、CHR 1K×8 + ネームテーブル 4 枚も CHR ROM に出せる、CPU サイクル IRQ、音源)
  class Namco163 extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.N163Audio ? new Emu.N163Audio() : null;
      this.extBits = 0x10; // NSF ヘッダと同じ N163 のビット(録音の NESX ヘッダ用)
      this.irqCounter = 0; this.irqEnable = false;
      this.chrSlots = new Int32Array(12); // 1K スロット 0-7 = $0000-$1FFF、8-11 = ネームテーブル。負数 = CIRAM ページ(-1-page)
      this.ntRamOk = [true, true];        // $E800 bit6/7(0=有効): CHR $0000-$0FFF / $1000-$1FFF で $E0 以上を CIRAM にする
      for (let i = 0; i < 8; i++) this.chrSlots[i] = (i % this.chrBanks1) << 10;
      const nt = NT_MODES[rom.mirroring] || NT_MODES.H;
      for (let i = 0; i < 4; i++) this.chrSlots[8 + i] = -1 - nt[i];
      this.setPrg8(3, this.prgBanks8 - 1);
    }
    audioAddr(addr) { return (addr & 0xF800) === 0x4800 ? 0x4800 : (addr & 0xF800) === 0xF800 ? 0xF800 : -1; }
    audioReadAddr(addr) { return (addr & 0xF800) === 0x4800 ? 0x4800 : -1; }
    audioImage() {
      const au = this.audio, out = [];
      if (!au || !au.ram || au.ram.length !== 128) return out;
      out.push({ addr: 0xF800, value: 0x80 });
      for (let i = 0; i < 128; i++) out.push({ addr: 0x4800, value: au.ram[i] });
      out.push({ addr: 0xF800, value: (au.autoInc ? 0x80 : 0) | (au.addr & 0x7F) });
      return out;
    }
    cpuRead(addr) {
      if ((addr & 0xF800) === 0x4800 && this.audio) return this.audio.readData();
      if (addr === 0x5000) return this.irqCounter & 0xFF;
      if (addr === 0x5800) return ((this.irqCounter >> 8) & 0x7F) | (this.irqEnable ? 0x80 : 0);
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if ((addr & 0xF800) === 0x4800) { if (this.audio) this.audio.writeRegister(0x4800, v); return; }
      if (addr === 0x5000) { this.irqCounter = (this.irqCounter & 0x7F00) | v; this.irqFlag = false; return; }
      if (addr === 0x5800) { this.irqCounter = (this.irqCounter & 0x00FF) | ((v & 0x7F) << 8); this.irqEnable = (v & 0x80) !== 0; this.irqFlag = false; return; }
      if (addr >= 0x6000 && addr < 0x8000) { // 書き込み保護: $F800 bit6 が立ち、その 2K の禁止ビット(bit0-3)が 0 の時だけ書ける
        const p = this.ramProtect | 0;
        if ((p & 0x40) && !(p & (1 << ((addr >> 11) & 3)))) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
        return;
      }
      super.cpuWrite(addr, v);
    }
    writeReg(addr, v) {
      const hi = addr & 0xF800;
      if (hi < 0xE000) { // $8000-$DFFF: CHR/NT スロット
        const slot = (hi - 0x8000) >> 11;
        const half = slot < 8 ? (slot >> 2) : 0;
        if (v >= 0xE0 && (slot >= 8 || this.ntRamOk[half])) this.chrSlots[slot] = -1 - (v & 1);
        else this.chrSlots[slot] = (v % this.chrBanks1) << 10;
        return;
      }
      if (hi === 0xE000) { this.setPrg8(0, v & 0x3F); return; }
      if (hi === 0xE800) { this.setPrg8(1, v & 0x3F); this.ntRamOk[0] = !(v & 0x40); this.ntRamOk[1] = !(v & 0x80); return; }
      if (hi === 0xF000) { this.setPrg8(2, v & 0x3F); return; }
      if (hi === 0xF800) { if (this.audio) this.audio.writeRegister(0xF800, v); this.ramProtect = v; } // 音源アドレス+PRG RAM 書き込み保護(bit6=0 で全体禁止、bit0-3 で 2K ごとに禁止)
    }
    ppuRead(addr) {
      const slot = addr < 0x2000 ? (addr >> 10) : 8 + ((addr >> 10) & 3);
      const m = this.chrSlots[slot];
      if (m < 0) return this.ciram[((-1 - m) << 10) | (addr & 0x3FF)];
      return this.chr[m + (addr & 0x3FF)];
    }
    ppuWrite(addr, v) {
      const slot = addr < 0x2000 ? (addr >> 10) : 8 + ((addr >> 10) & 3);
      const m = this.chrSlots[slot];
      if (m < 0) this.ciram[((-1 - m) << 10) | (addr & 0x3FF)] = v;
      else if (this.chrIsRam) this.chr[m + (addr & 0x3FF)] = v;
    }
    cpuClock(cycles) {
      if (!this.irqEnable || this.irqCounter >= 0x7FFF) return;
      this.irqCounter += cycles;
      if (this.irqCounter >= 0x7FFF) { this.irqCounter = 0x7FFF; this.irqFlag = true; }
    }
  }

  // 24/26: Konami VRC6(PRG 16K+8K 切替、CHR 1K×8、IRQ、音源。26 は A0/A1 が入れ替わった配線)
  //   $B003: bit0-1 CHR モード(0=1K×8、1=2K×4、2/3=1K×4+2K×2)、bit5 2K の下位ビット固定、bit2-3 ミラーリング、bit7 PRG RAM 有効。
  //   未対応: bit4 のネームテーブルを CHR ROM から出す配線
  class VRC6 extends Mapper {
    constructor(rom) {
      super(rom);
      this.swapA0A1 = rom.mapper === 26;
      this.audio = Emu.VRC6Audio ? new Emu.VRC6Audio() : null;
      this.extBits = 0x01;
      this.irq = new VrcIrq();
      this.shadow = new Int16Array(0x10).fill(-1); // 音源 9 レジスタの影(index = (hi-9)*4+lo)
      this.chrRegs = new Uint8Array(8); this.bankMode = 0; // $B003 の値(bit0-1 CHR モード、bit5 2K の下位ビット固定、bit7 PRG RAM 有効)
      this.ramRead = this.ramWrite = false;
      this.setPrg16(0, 0); this.setPrg8(2, -2); this.setPrg8(3, -1);
    }
    // CHR: モード 0=1K×8(R0-R7)、1=2K×4(R0-R3)、2/3=1K×4(R0-R3)+2K×2(R4,R5)。2K は bit5 が立つと下位ビットを 0/1 に固定、
    //   立たなければ R の値そのまま(=同じ 1K が 2 回)。未対応: bit4 のネームテーブルを CHR ROM から出す配線(使うソフトは稀)
    applyChr() {
      const r = this.chrRegs, m = this.bankMode, mask = (m & 0x20) ? 0xFE : 0xFF, or = (m & 0x20) ? 1 : 0;
      const two = (slot, v) => { this.setChr1(slot, v & mask); this.setChr1(slot + 1, (v & mask) | or); };
      switch (m & 3) {
        case 0: for (let i = 0; i < 8; i++) this.setChr1(i, r[i]); break;
        case 1: for (let i = 0; i < 4; i++) two(i * 2, r[i]); break;
        default: for (let i = 0; i < 4; i++) this.setChr1(i, r[i]); two(4, r[4]); two(6, r[5]);
      }
      // ネームテーブル(CIRAM): bit5 が立った通常の組み合わせは bit2-3 のミラーリング、それ以外は R4-R7 の bit0 がページを選ぶ
      // (NesDev の表。bit4=1 で CHR ROM をネームテーブルに出す配線は未対応で、CIRAM として扱う)
      switch (m & 0x2F) {
        case 0x20: case 0x27: this.setMirroring('V'); break;
        case 0x23: case 0x24: this.setMirroring('H'); break;
        case 0x28: case 0x2F: this.setMirroring('1A'); break;
        case 0x2B: case 0x2C: this.setMirroring('1B'); break;
        default: {
          const b = (i) => r[i] & 1;
          switch (m & 7) {
            case 0: case 6: case 7: this.ntMap = [b(6), b(6), b(7), b(7)]; break;
            case 1: case 5: this.ntMap = [b(4), b(5), b(6), b(7)]; break;
            default: this.ntMap = [b(6), b(7), b(6), b(7)];
          }
        }
      }
    }
    _canon(addr) { return this.swapA0A1 ? (addr & 0xFFFC) | ((addr & 1) << 1) | ((addr >> 1) & 1) : addr; }
    audioAddr(addr) {
      addr = this._canon(addr);
      const hi = addr & 0xF000, lo = addr & 0x0FFF;
      return (hi === 0x9000 || hi === 0xA000 || hi === 0xB000) && lo <= 2 ? addr : -1;
    }
    audioImage() {
      const out = [];
      for (let i = 0; i < 12; i++) { const v = this.shadow[i]; if (v >= 0) out.push({ addr: 0x9000 + ((i >> 2) << 12) + (i & 3), value: v }); }
      return out;
    }
    writeReg(addr, v) {
      addr = this._canon(addr);
      const hi = addr & 0xF000, lo = addr & 3;
      switch (hi) {
        case 0x8000: this.setPrg16(0, v & 0x0F); break;
        case 0x9000: case 0xA000:
          if (lo <= 2) { this.shadow[((hi - 0x9000) >> 12) * 4 + lo] = v; if (this.audio) this.audio.writeRegister(hi + lo, v); }
          break; // $9003(周波数制御)は未対応
        case 0xB000:
          if (lo <= 2) { this.shadow[8 + lo] = v; if (this.audio) this.audio.writeRegister(hi + lo, v); }
          else { this.bankMode = v; this.ramRead = this.ramWrite = (v & 0x80) !== 0; this.applyChr(); }
          break;
        case 0xC000: this.setPrg8(2, v & 0x1F); break;
        case 0xD000: this.chrRegs[lo] = v; this.applyChr(); break;
        case 0xE000: this.chrRegs[4 + lo] = v; this.applyChr(); break;
        case 0xF000:
          if (lo === 0) this.irq.writeLatch(v);
          else if (lo === 1) this.irq.writeControl(v);
          else if (lo === 2) this.irq.ack();
          break;
      }
    }
    cpuClock(cycles) { this.irq.clock(cycles); }
    irqPending() { return this.irq.flag; }
  }

  // 85: Konami VRC7(PRG 8K×3 切替、CHR 1K×8、IRQ、FM 音源 $9010/$9030)。
  //   レジスタの第 2 ビットは A3($x008、VRC7b)でも A4($x010、VRC7a)でも受ける。未対応: PRG RAM 保護
  class VRC7 extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.VRC7Audio ? new Emu.VRC7Audio() : null;
      this.extBits = 0x02;
      this.irq = new VrcIrq();
      this.fmAddr = 0;
      this.fmShadow = new Int16Array(0x40).fill(-1);
      this.setPrg8(0, 0); this.setPrg8(1, 1); this.setPrg8(2, 2); this.setPrg8(3, -1);
    }
    audioAddr(addr) { const m = addr & 0xF030; return m === 0x9010 ? 0x9010 : m === 0x9030 ? 0x9030 : -1; }
    audioImage() {
      const out = [];
      for (let r = 0; r < 0x40; r++) if (this.fmShadow[r] >= 0) { out.push({ addr: 0x9010, value: r }); out.push({ addr: 0x9030, value: this.fmShadow[r] }); }
      return out;
    }
    writeReg(addr, v) {
      const hi = addr & 0xF000, second = (addr & 0x18) !== 0;
      if (hi === 0x9000) {
        const m = addr & 0x30;
        if (m === 0x10) { this.fmAddr = v & 0x3F; if (this.audio) this.audio.writeRegister(0x9010, v); return; }
        if (m === 0x30) { this.fmShadow[this.fmAddr] = v; if (this.audio) this.audio.writeRegister(0x9030, v); return; }
        if (!second) this.setPrg8(2, v & 0x3F);
        return;
      }
      switch (hi) {
        case 0x8000: this.setPrg8(second ? 1 : 0, v & 0x3F); break;
        case 0xA000: case 0xB000: case 0xC000: case 0xD000:
          this.setChr1(((hi - 0xA000) >> 12) * 2 + (second ? 1 : 0), v); break;
        case 0xE000:
          if (!second) {
            this.setMirroring(['V', 'H', '1A', '1B'][v & 3]);
            if ((v & 0x40) && this.audio) this.audio.reset(); // bit6: 音源を黙らせる(リセット)
            this.ramRead = this.ramWrite = (v & 0x80) !== 0;  // bit7: PRG RAM 有効
          } else this.irq.writeLatch(v);
          break;
        case 0xF000: if (!second) this.irq.writeControl(v); else this.irq.ack(); break;
      }
    }
    cpuClock(cycles) { this.irq.clock(cycles); }
    irqPending() { return this.irq.flag; }
  }

  // 21/22/23/25: Konami VRC2 / VRC4(PRG 8K×2 切替、CHR 1K×8 を下位 4bit と上位 5bit の 2 レジスタで、ミラーリング、
  //   VRC4 は PRG スワップ($9002 bit1)と IRQ)。4 つのマッパー番号はレジスタ選択に使うアドレス線が違うだけ:
  //     21: VRC4a=A1,A2 / VRC4c=A6,A7     22: VRC2a=A1,A0(CHR は 1bit 右シフト)
  //     23: VRC2b=A0,A1 / VRC4e=A2,A3 / VRC4f=A0,A1     25: VRC2c=A1,A0 / VRC4b=A1,A0 / VRC4d=A3,A2
  //   NES 2.0 のサブマッパー(21: 1=a 2=c、23: 1=f 2=e 3=2b、25: 1=b 2=d 3=2c)があればその配線、無ければ Mesen と同じく
  //   その番号の候補の線を OR して受ける(市販ソフトはどちらかの線しか使わないので両方効かせて困らない)。
  //   VRC2 と確定している時(22、または 23/25 のサブマッパー 3)だけミラーリングを 1bit、IRQ 無し、$9002 もミラーリングにする。
  //   サブマッパー無しの 23/25 は VRC4 の意味論(Mesen は 23 を VRC2b 扱いにするが、VRC2 のソフトは $9002 に書かず
  //   IRQ も使わないので VRC4 側に倒しておく方が両方動く)。$6000-$6FFF は VRC2 の 1bit ラッチの代わりに PRG RAM を
  //   そのまま置く(読み返した bit0 はラッチと同じ値になる)。未対応: PRG RAM 保護。
  class VRC24 extends Mapper {
    constructor(rom) {
      super(rom);
      const m = rom.mapper, sub = rom.submapper | 0;
      // 線の取り方: [A0 になるビット列, A1 になるビット列](ビット番号の配列。複数なら OR)
      let lines, vrc2 = false;
      if (m === 22) { lines = [[1], [0]]; vrc2 = true; }
      else if (m === 21) lines = sub === 1 ? [[1], [2]] : sub === 2 ? [[6], [7]] : [[1, 6], [2, 7]];
      else if (m === 23) { lines = sub === 2 ? [[2], [3]] : sub === 1 || sub === 3 ? [[0], [1]] : [[0, 2], [1, 3]]; vrc2 = sub === 3; }
      else { lines = sub === 2 ? [[3], [2]] : sub === 1 || sub === 3 ? [[1], [0]] : [[1, 3], [0, 2]]; vrc2 = sub === 3; }
      this.lines = lines; this.vrc2 = vrc2; this.chrShift = m === 22 ? 1 : 0;
      this.irq = vrc2 ? null : new VrcIrq();
      this.prgReg = [0, 0]; this.prgMode = 0;
      this.chrLo = new Uint8Array(8); this.chrHi = new Uint8Array(8);
      this.apply();
    }
    _canon(addr) {
      let a0 = 0, a1 = 0;
      for (const b of this.lines[0]) a0 |= (addr >> b) & 1;
      for (const b of this.lines[1]) a1 |= (addr >> b) & 1;
      return (addr & 0xF000) | (a1 << 1) | a0;
    }
    writeReg(addr, v) {
      addr = this._canon(addr);
      const hi = addr & 0xF000, lo = addr & 3;
      switch (hi) {
        case 0x8000: this.prgReg[0] = v & 0x1F; break;
        case 0x9000:
          if (this.vrc2) this.setMirroring(['V', 'H'][v & 1]);
          else if (lo <= 1) this.setMirroring(['V', 'H', '1A', '1B'][v & 3]);
          else this.prgMode = (v >> 1) & 1;
          break;
        case 0xA000: this.prgReg[1] = v & 0x1F; break;
        case 0xB000: case 0xC000: case 0xD000: case 0xE000: {
          const reg = ((hi - 0xB000) >> 12) * 2 + (lo >> 1);
          if (lo & 1) this.chrHi[reg] = v & 0x1F; else this.chrLo[reg] = v & 0x0F;
          break;
        }
        case 0xF000:
          if (!this.irq) break;
          if (lo === 0) this.irq.writeLatch((this.irq.latch & 0xF0) | (v & 0x0F));
          else if (lo === 1) this.irq.writeLatch((this.irq.latch & 0x0F) | ((v & 0x0F) << 4));
          else if (lo === 2) this.irq.writeControl(v);
          else this.irq.ack();
          break;
      }
      this.apply();
    }
    apply() {
      for (let i = 0; i < 8; i++) this.setChr1(i, (this.chrLo[i] | (this.chrHi[i] << 4)) >> this.chrShift);
      if (this.prgMode === 0) { this.setPrg8(0, this.prgReg[0]); this.setPrg8(2, -2); }
      else { this.setPrg8(0, -2); this.setPrg8(2, this.prgReg[0]); }
      this.setPrg8(1, this.prgReg[1]); this.setPrg8(3, -1);
    }
    cpuClock(cycles) { if (this.irq) this.irq.clock(cycles); }
    irqPending() { return this.irq ? this.irq.flag : false; }
  }

  // 75: Konami VRC1(PRG 8K×3 切替、CHR 4K×2(下位 4bit は $E000/$F000、bit4 は $9000 の bit1/bit2)、
  //   $9000 bit0 でミラーリング(0=V 1=H)。IRQ 無し)
  class VRC1 extends Mapper {
    constructor(rom) {
      super(rom);
      this.chrBank = [0, 0];
      this.setPrg8(3, -1);
      this.apply();
    }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.setPrg8(0, v & 0x0F); break;
        case 0xA000: this.setPrg8(1, v & 0x0F); break;
        case 0xC000: this.setPrg8(2, v & 0x0F); break;
        case 0x9000:
          if (!this.rom.fourScreen) this.setMirroring((v & 1) ? 'H' : 'V');
          this.chrBank[0] = (this.chrBank[0] & 0x0F) | ((v & 0x02) << 3);
          this.chrBank[1] = (this.chrBank[1] & 0x0F) | ((v & 0x04) << 2);
          this.apply();
          break;
        case 0xE000: this.chrBank[0] = (this.chrBank[0] & 0x10) | (v & 0x0F); this.apply(); break;
        case 0xF000: this.chrBank[1] = (this.chrBank[1] & 0x10) | (v & 0x0F); this.apply(); break;
      }
    }
    apply() {
      for (let h = 0; h < 2; h++) for (let i = 0; i < 4; i++) this.setChr1(h * 4 + i, this.chrBank[h] * 4 + i);
    }
  }

  // ---- 国内主要基板(音源無し)。挙動は Mesen 2 の各マッパーに揃えてある(合成 ROM で画面と録音を比べる基準) ----

  // バス競合: 書き込み値と ROM のその番地の値の AND が実際に見える(基板に書き込み保護の論理が無い物)
  function busConflict(m, addr, v) { return v & m.prg[m.prgMap[(addr - 0x8000) >> 13] + (addr & 0x1FFF)]; }

  // 9: MMC2(PRG 8K 切替+固定 3 本)/ 10: MMC4(PRG 16K 切替+固定)。CHR 4K×2 は、PPU がタイル $FD/$FE を読むと
  //   切り替わるラッチ(左は $0FD8/$0FE8 ちょうど、右は $1FD8-$1FDF/$1FE8-$1FEF。MMC4 は左も範囲)。
  //   切替はそのタイルの読みが終わってから(Mesen の needChrUpdate と同じ)。$F000 bit0 ミラーリング(1=H)
  class MMC2 extends Mapper {
    constructor(rom) {
      super(rom);
      this.mmc4 = rom.mapper === 10;
      this.latch = [1, 1]; this.chrReg = [[0, 0], [0, 0]]; this.pendingLatch = -1;
      if (this.mmc4) { this.setPrg16(0, 0); this.setPrg16(1, -1); }
      else { this.setPrg8(0, 0); this.setPrg8(1, -3); this.setPrg8(2, -2); this.setPrg8(3, -1); }
      this.applyChr();
    }
    applyChr() { for (let h = 0; h < 2; h++) { const b = this.chrReg[h][this.latch[h]] * 4; for (let i = 0; i < 4; i++) this.setChr1(h * 4 + i, b + i); } }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0xA000: if (this.mmc4) this.setPrg16(0, v & 0x0F); else this.setPrg8(0, v & 0x0F); break;
        case 0xB000: this.chrReg[0][0] = v & 0x1F; this.applyChr(); break;
        case 0xC000: this.chrReg[0][1] = v & 0x1F; this.applyChr(); break;
        case 0xD000: this.chrReg[1][0] = v & 0x1F; this.applyChr(); break;
        case 0xE000: this.chrReg[1][1] = v & 0x1F; this.applyChr(); break;
        case 0xF000: this.setMirroring((v & 1) ? 'H' : 'V'); break;
      }
    }
    ppuRead(addr) {
      const v = super.ppuRead(addr);
      if (addr < 0x2000) {
        const lo = addr & 0x0FF8, h = addr >> 12;
        if (lo === 0x0FD8 || lo === 0x0FE8) {
          if (h === 1 || this.mmc4 || (addr & 7) === 0) { this.latch[h] = lo === 0x0FE8 ? 1 : 0; this.applyChr(); }
        }
      }
      return v;
    }
  }

  // シリアル EEPROM(I2C)。Bandai の基板が $6000 読みの bit4(SDA)と $800D 書きの bit5(SCL)/bit6(SDA)でビット単位に話す。
  //   24C01(X24C01、128 バイト): START → 7bit 番地+R/W → ACK → データ(読みは ACK で続き、書きは 1 バイトごと ACK)。
  //   24C02(256 バイト): START → デバイス番地(1010xxxR) → ACK → (書き: 番地 → ACK → データ…)/(読み: 今の番地から)。
  //   挙動は Mesen の Eeprom24C01/24C02 と同じ(ビットは MSB から。出力は離すと 1)。
  const EE_IDLE = 0, EE_ADDR = 1, EE_READ = 2, EE_WRITE = 3, EE_SENDACK = 4, EE_WAITACK = 5, EE_CHIP = 6;
  class Eeprom24C0X {
    constructor(size) {
      this.size = size; this.data = new Uint8Array(size).fill(0xFF);
      this.mode = EE_IDLE; this.next = EE_IDLE; this.chip = 0; this.address = 0; this.byte = 0; this.counter = 0;
      this.output = 1; this.prevScl = 0; this.prevSda = 0; this.dirty = false;
    }
    read() { return this.output; }
    writeScl(scl) { this.write(scl, this.prevSda); }
    writeSda(sda) { this.write(this.prevScl, sda); }
    _in(field, sda) { if (this.counter < 8) { const bit = 7 - this.counter; this[field] = (this[field] & ~(1 << bit)) | (sda << bit); this.counter++; } }
    _out() { if (this.counter < 8) { this.output = (this.byte >> (7 - this.counter)) & 1; this.counter++; } }
  }
  class Eeprom24C01 extends Eeprom24C0X {
    constructor() { super(128); }
    write(scl, sda) {
      if (this.prevScl && scl && this.prevSda && !sda) { this.mode = EE_ADDR; this.address = 0; this.counter = 0; this.output = 1; } // START
      else if (this.prevScl && scl && !this.prevSda && sda) { this.mode = EE_IDLE; this.output = 1; }                           // STOP
      else if (scl && !this.prevScl) { // 立ち上がり
        switch (this.mode) {
          case EE_ADDR:
            if (this.counter < 7) this._in('address', sda);
            else { this.counter = 8; if (sda) { this.next = EE_READ; this.byte = this.data[this.address & 0x7F]; } else this.next = EE_WRITE; }
            break;
          case EE_SENDACK: this.output = 0; break;
          case EE_READ: this._out(); break;
          case EE_WRITE: this._in('byte', sda); break;
          case EE_WAITACK: if (sda) this.mode = EE_IDLE; break;
        }
      } else if (!scl && this.prevScl) { // 立ち下がり
        switch (this.mode) {
          case EE_ADDR: if (this.counter === 8) { this.mode = EE_SENDACK; this.output = 1; } break;
          case EE_SENDACK: this.mode = this.next; this.counter = 0; this.output = 1; break;
          case EE_READ: if (this.counter === 8) { this.mode = EE_WAITACK; this.address = (this.address + 1) & 0x7F; } break;
          case EE_WRITE: if (this.counter === 8) { this.data[this.address & 0x7F] = this.byte; this.dirty = true; this.address = (this.address + 1) & 0x7F; this.mode = EE_SENDACK; this.next = EE_IDLE; } break;
          case EE_WAITACK: this.mode = EE_READ; this.counter = 0; this.byte = this.data[this.address & 0x7F]; this.output = 1; break;
        }
      }
      this.prevScl = scl; this.prevSda = sda;
    }
  }
  class Eeprom24C02 extends Eeprom24C0X {
    constructor() { super(256); this.decided = null; } // 最初のデバイス番地で 'ok'/'ng'(16 の種別判定用)
    write(scl, sda) {
      if (this.prevScl && scl && this.prevSda && !sda) { this.mode = EE_CHIP; this.counter = 0; this.output = 1; } // START
      else if (this.prevScl && scl && !this.prevSda && sda) { this.mode = EE_IDLE; this.output = 1; }            // STOP
      else if (scl && !this.prevScl) {
        switch (this.mode) {
          case EE_CHIP: this._in('chip', sda); break;
          case EE_ADDR: this._in('address', sda); break;
          case EE_WRITE: this._in('byte', sda); break;
          case EE_READ: this._out(); break;
          case EE_SENDACK: this.output = 0; break;
          case EE_WAITACK: if (!sda) { this.byte = this.data[this.address]; this.next = EE_READ; } else this.next = EE_IDLE; break;
        }
      } else if (!scl && this.prevScl) {
        switch (this.mode) {
          case EE_CHIP:
            if (this.counter === 8) {
              if ((this.chip & 0xF0) === 0xA0) { this.decided = 'ok'; this.counter = 0; this.mode = EE_SENDACK; this.output = 1; if (this.chip & 1) { this.next = EE_READ; this.byte = this.data[this.address]; } else this.next = EE_ADDR; }
              else { this.decided = 'ng'; this.mode = EE_IDLE; this.output = 1; }
            }
            break;
          case EE_ADDR: if (this.counter === 8) { this.counter = 0; this.mode = EE_SENDACK; this.next = EE_WRITE; this.output = 1; } break;
          case EE_READ: if (this.counter === 8) { this.counter = 0; this.mode = EE_WAITACK; this.address = (this.address + 1) & 0xFF; } break;
          case EE_WRITE: if (this.counter === 8) { this.counter = 0; this.data[this.address] = this.byte; this.dirty = true; this.address = (this.address + 1) & 0xFF; this.mode = EE_SENDACK; this.next = EE_WRITE; } break;
          case EE_SENDACK: case EE_WAITACK: this.mode = this.next; this.counter = 0; this.output = 1; break;
        }
      }
      this.prevScl = scl; this.prevSda = sda;
    }
  }

  // 16/153/157/159: Bandai FCG-1/2・LZ93D50(レジスタは $6000-$7FFF と $8000-$FFFF の両方。NES 2.0 のサブマッパー 4 は
  //   FCG-1/2=$6000 側だけ・IRQ カウンタ直書き、5 は LZ93D50=$8000 側だけ)。0-7 CHR 1K、8 PRG 16K、9 ミラーリング、
  //   A IRQ 有効(有効化でラッチをカウンタへ)、B/C ラッチ下位/上位、D EEPROM(bit5=SCL、bit6=SDA。読みは $6000 の bit4)。
  //   EEPROM: 159 は 24C01、157(Datach)は本体の 24C02 とカートリッジの 24C01(SCL は CHR レジスタ 0-3 の bit3、SDA は D の
  //   bit6。読みは両方の AND。バーコードリーダーは無し)。16 は iNES のヘッダでは 24C01 の基板(本来 159)も 16 と書かれているので、
  //   24C02 と 24C01 の両方に同じ信号を入れ、最初の 1 バイトがデバイス番地(1010xxxx)なら 24C02、違えば 24C01 と決める
  //   (NES 2.0 のサブマッパー 4 は EEPROM 無し、5 はセーブ 256 バイトのときだけ 24C02)。16 で PRG 512K の物は 153(SRAM)扱い。
  //   EEPROM の中身はセーブデータとして扱う(getBatteryData/setBatteryData)。
  //   153(大容量): CHR レジスタの bit0 が PRG の外側バンク、$6000 RAM は D の bit5。IRQ は 16bit ダウン、0 で IRQ
  class BandaiFCG extends Mapper {
    constructor(rom) {
      super(rom);
      this.sub = rom.submapper | 0; this.big = rom.mapper === 153 || this.prgBanks8 >= 0x40; // 512K 以上
      this.sram = this.big; // 153(と 16 で 512K): $6000 は SRAM、EEPROM 無し
      this.chrRegs = new Uint8Array(8); this.prgPage = 0; this.outer = 0;
      this.irqEnable = false; this.irqCounter = 0; this.irqLatch = 0;
      this.eeprom = null; this.eeprom2 = null;
      this.eepromAlt = null; // 16(iNES): 種別が決まるまで 24C01 にも同じ信号を入れておく
      if (this.sram) { /* SRAM */ }
      else if (rom.mapper === 157) { this.eeprom = new Eeprom24C02(); this.eeprom2 = new Eeprom24C01(); }
      else if (rom.mapper === 159) this.eeprom = new Eeprom24C01();
      else if (rom.mapper === 16 && this.sub === 0) { this.eeprom = new Eeprom24C02(); this.eepromAlt = new Eeprom24C01(); }
      else if (rom.mapper === 16 && this.sub === 5 && rom.prgRamSize === 256) this.eeprom = new Eeprom24C02();
      if (this.eeprom) {
        this.getBatteryData = () => { const a = this.eeprom.data, b = this.eeprom2 ? this.eeprom2.data : null; const out = new Uint8Array(a.length + (b ? b.length : 0)); out.set(a); if (b) out.set(b, a.length); return out; };
        this.setBatteryData = (bytes) => { const a = this.eeprom.data, b = this.eeprom2 ? this.eeprom2.data : null; if (bytes.length !== a.length + (b ? b.length : 0)) return false; a.set(bytes.subarray(0, a.length)); if (b) b.set(bytes.subarray(a.length)); return true; };
      }
      this.setPrg16(0, 0); this.setPrg16(1, 0x0F);
    }
    get diskDirty() { return !!((this.eeprom && this.eeprom.dirty) || (this.eeprom2 && this.eeprom2.dirty)); } // 本体の batteryDirty が見る
    set diskDirty(v) { if (!v) { if (this.eeprom) this.eeprom.dirty = false; if (this.eeprom2) this.eeprom2.dirty = false; } }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) {
        if (this.sram) return this.prgRam[(addr - 0x6000) & 0x1FFF];
        if (!this.eeprom) return 0x10 | (this.barcodeRead ? this.barcodeRead() : 0); // EEPROM 無し: SDA=1
        let sda = this.eeprom.read(); if (this.eeprom2) sda &= this.eeprom2.read();
        return (sda << 4) | (this.barcodeRead ? this.barcodeRead() : 0); // bit3 = データックのバーコードリーダー(本体が barcodeRead を挿す)
      }
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr < 0x6000) return;
      if (addr < 0x8000) {
        if (this.sram) { this.prgRam[(addr - 0x6000) & 0x1FFF] = v; return; }
        if (this.sub === 5) return;
      } else if (this.sub === 4) return;
      this.writeReg(addr, v);
    }
    writeReg(addr, v) {
      const fcg = this.rom.mapper === 16 && this.sub === 4;
      switch (addr & 0x0F) {
        case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
          this.chrRegs[addr & 7] = v;
          if (this.eeprom2 && (addr & 7) < 4) this.eeprom2.writeScl((v >> 3) & 1);
          if (this.big) {
            this.outer = 0; for (let i = 0; i < 8; i++) this.outer |= (this.chrRegs[i] & 1) << 4;
            this.setPrg16(0, this.prgPage | this.outer); this.setPrg16(1, 0x0F | this.outer);
          } else if (!this.chrIsRam) this.setChr1(addr & 7, v);
          break;
        case 8: this.prgPage = v & 0x0F; this.setPrg16(0, this.prgPage | this.outer); break;
        case 9: this.setMirroring(['V', 'H', '1A', '1B'][v & 3]); break;
        case 0xA: this.irqEnable = (v & 1) !== 0; if (!fcg) this.irqCounter = this.irqLatch; this.irqFlag = false; break;
        case 0xB: if (fcg) this.irqCounter = (this.irqCounter & 0xFF00) | v; else this.irqLatch = (this.irqLatch & 0xFF00) | v; break;
        case 0xC: if (fcg) this.irqCounter = (this.irqCounter & 0x00FF) | (v << 8); else this.irqLatch = (this.irqLatch & 0x00FF) | (v << 8); break;
        case 0xD: // EEPROM / 153 の RAM 許可(RAM は常に許可)
          if (this.eeprom) {
            this.eeprom.write((v >> 5) & 1, (v >> 6) & 1);
            if (this.eeprom2) this.eeprom2.writeSda((v >> 6) & 1);
            if (this.eepromAlt) { // 種別の判定: 24C02 がデバイス番地を受け取った/蹴った時点で決める
              this.eepromAlt.write((v >> 5) & 1, (v >> 6) & 1);
              const d = this.eeprom.decided;
              if (d === 'ok') this.eepromAlt = null;
              else if (d === 'ng') { this.eeprom = this.eepromAlt; this.eepromAlt = null; }
            }
          }
          break;
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) { if (this.irqCounter === 0) this.irqFlag = true; this.irqCounter = (this.irqCounter - 1) & 0xFFFF; }
    }
  }

  // 18: Jaleco SS88006(PRG 8K×3・CHR 1K×8 をニブル 2 回書き、$E000-$E003 IRQ ラッチ 4 ニブル、$F000 ラッチ→カウンタ、
  //   $F001 bit0 有効+bit1-3 で 12/8/4bit 幅、$F002 ミラーリング。$F003 の音源は未対応)
  class JalecoSS88006 extends Mapper {
    constructor(rom) {
      super(rom);
      this.prgRegs = new Uint8Array(3); this.chrRegs = new Uint8Array(8); this.irqLatchN = new Uint8Array(4);
      this.irqCounter = 0; this.irqSize = 0; this.irqEnable = false;
      this.setPrg8(3, -1);
    }
    writeReg(addr, v) {
      const hiNib = (addr & 1) !== 0; v &= 0x0F;
      const upd = (arr, i, set) => { arr[i] = hiNib ? (arr[i] & 0x0F) | (v << 4) : (arr[i] & 0xF0) | v; set(arr[i]); };
      switch (addr & 0xF003) {
        case 0x8000: case 0x8001: upd(this.prgRegs, 0, (b) => this.setPrg8(0, b)); break;
        case 0x8002: case 0x8003: upd(this.prgRegs, 1, (b) => this.setPrg8(1, b)); break;
        case 0x9000: case 0x9001: upd(this.prgRegs, 2, (b) => this.setPrg8(2, b)); break;
        case 0xA000: case 0xA001: upd(this.chrRegs, 0, (b) => this.setChr1(0, b)); break;
        case 0xA002: case 0xA003: upd(this.chrRegs, 1, (b) => this.setChr1(1, b)); break;
        case 0xB000: case 0xB001: upd(this.chrRegs, 2, (b) => this.setChr1(2, b)); break;
        case 0xB002: case 0xB003: upd(this.chrRegs, 3, (b) => this.setChr1(3, b)); break;
        case 0xC000: case 0xC001: upd(this.chrRegs, 4, (b) => this.setChr1(4, b)); break;
        case 0xC002: case 0xC003: upd(this.chrRegs, 5, (b) => this.setChr1(5, b)); break;
        case 0xD000: case 0xD001: upd(this.chrRegs, 6, (b) => this.setChr1(6, b)); break;
        case 0xD002: case 0xD003: upd(this.chrRegs, 7, (b) => this.setChr1(7, b)); break;
        case 0xE000: case 0xE001: case 0xE002: case 0xE003: this.irqLatchN[addr & 3] = v; break;
        case 0xF000: this.irqFlag = false; this.irqCounter = this.irqLatchN[0] | (this.irqLatchN[1] << 4) | (this.irqLatchN[2] << 8) | (this.irqLatchN[3] << 12); break;
        case 0xF001: this.irqFlag = false; this.irqEnable = (v & 1) !== 0; this.irqSize = (v & 8) ? 3 : (v & 4) ? 2 : (v & 2) ? 1 : 0; break;
        case 0xF002: this.setMirroring(['H', 'V', '1A', '1B'][v & 3]); break;
        case 0xF003: break; // 音源
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      const mask = [0xFFFF, 0x0FFF, 0x00FF, 0x000F][this.irqSize];
      for (let c = 0; c < cycles; c++) {
        let ctr = (this.irqCounter & mask); ctr = (ctr - 1) & mask;
        if (ctr === 0) this.irqFlag = true;
        this.irqCounter = (this.irqCounter & ~mask) | ctr;
      }
    }
  }

  // 32: Irem G-101($8000 PRG 8K(モードで $8000 か $C000)、$9000 bit1 モード+bit0 ミラーリング(1=H)、$A000 PRG 8K、
  //   $B000-$B007 CHR 1K。サブマッパー 1 は 1 画面固定・モード固定)
  class IremG101 extends Mapper {
    constructor(rom) {
      super(rom);
      this.prgRegs = [0, 0]; this.prgMode = 0; this.sub = rom.submapper | 0;
      if (this.sub === 1) this.setMirroring('1A');
      this.apply();
    }
    apply() {
      if (this.prgMode === 0) { this.setPrg8(0, this.prgRegs[0]); this.setPrg8(2, -2); }
      else { this.setPrg8(0, -2); this.setPrg8(2, this.prgRegs[0]); }
      this.setPrg8(1, this.prgRegs[1]); this.setPrg8(3, -1);
    }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.prgRegs[0] = v & 0x1F; this.apply(); break;
        case 0x9000: this.prgMode = this.sub === 1 ? 0 : (v >> 1) & 1; this.apply(); if (this.sub !== 1) this.setMirroring((v & 1) ? 'H' : 'V'); break;
        case 0xA000: this.prgRegs[1] = v & 0x1F; this.apply(); break;
        case 0xB000: this.setChr1(addr & 7, v); break;
      }
    }
  }

  // 65: Irem H3001($8000/$A000/$C000 PRG 8K、$9001 bit7 ミラーリング(1=H)、$9003 IRQ 有効、$9004 ラッチ→カウンタ、
  //   $9005/$9006 ラッチ上位/下位、$B000-$B007 CHR 1K。IRQ は 16bit ダウン、0 で IRQ+無効)
  class IremH3001 extends Mapper {
    constructor(rom) {
      super(rom);
      this.irqEnable = false; this.irqCounter = 0; this.irqLatch = 0;
      this.setPrg8(0, 0); this.setPrg8(1, 1); this.setPrg8(2, -2); this.setPrg8(3, -1);
    }
    writeReg(addr, v) {
      switch (addr) {
        case 0x8000: this.setPrg8(0, v); break;
        case 0x9001: this.setMirroring((v & 0x80) ? 'H' : 'V'); break;
        case 0x9003: this.irqEnable = (v & 0x80) !== 0; this.irqFlag = false; break;
        case 0x9004: this.irqCounter = this.irqLatch; this.irqFlag = false; break;
        case 0x9005: this.irqLatch = (this.irqLatch & 0x00FF) | (v << 8); break;
        case 0x9006: this.irqLatch = (this.irqLatch & 0xFF00) | v; break;
        case 0xA000: this.setPrg8(1, v); break;
        case 0xC000: this.setPrg8(2, v); break;
        default: if ((addr & 0xF000) === 0xB000) this.setChr1(addr & 7, v);
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) {
        this.irqCounter = (this.irqCounter - 1) & 0xFFFF;
        if (this.irqCounter === 0) { this.irqEnable = false; this.irqFlag = true; break; }
      }
    }
  }

  // 33: Taito TC0190($8000 PRG 8K+bit6 ミラーリング(1=H)、$8001 PRG 8K、$8002/$8003 CHR 2K、$A000-$A003 CHR 1K)
  //   iNES のヘッダは TC0690(48、IRQ つき)の基板も 33 と書いている物が多いので、33 も TC0690 として動かし、$C000-$C003/$E000
  //   (TC0190 には無いレジスタ)に書いた時点で 48 の流儀に切り替える(それまでは $8000 bit6 がミラーリング、IRQ 無し)
  // 48: Taito TC0690(TC0190 + MMC3 風の A12 IRQ: $C000 ラッチ(値の反転、サブマッパー 1 は +1)、$C001 リロード、
  //   $C002 有効、$C003 無効。IRQ は A12 の数え上げから数サイクル遅れる(Mesen と同じ 22、サブマッパー 1 は 6)。
  //   ミラーリングは $E000 bit6)
  class TaitoTC0690 extends MMC3 {
    constructor(rom) { super(rom); this.irqDelay = 0; this.tc0190 = rom.mapper === 33; this.setPrg8(2, -2); this.setPrg8(3, -1); }
    apply() {}
    writeReg(addr, v) {
      if (this.tc0190) {
        if ((addr & 0xE000) === 0xC000 || (addr & 0xE003) === 0xE000) this.tc0190 = false; // 48 の基板だった
        else if ((addr & 0xA003) === 0x8000) this.setMirroring((v & 0x40) ? 'H' : 'V');
      }
      switch (addr & 0xE003) {
        case 0x8000: this.setPrg8(0, v & 0x3F); break;
        case 0x8001: this.setPrg8(1, v & 0x3F); break;
        case 0x8002: this.setChr2(0, v); break;
        case 0x8003: this.setChr2(1, v); break;
        case 0xA000: case 0xA001: case 0xA002: case 0xA003: this.setChr1(4 + (addr & 3), v); break;
        case 0xC000: this.irqFlag = false; this.irqLatch = ((v ^ 0xFF) + ((this.rom.submapper | 0) === 1 ? 1 : 0)) & 0xFF; break;
        case 0xC001: this.irqFlag = false; this.irqCounter = 0; this.irqReload = true; break;
        case 0xC002: this.irqEnable = true; break;
        case 0xC003: this.irqEnable = false; this.irqFlag = false; break;
        case 0xE000: this.setMirroring((v & 0x40) ? 'H' : 'V'); break;
      }
    }
    clockIrq() {
      if (this.tc0190) return;
      if (this.irqCounter === 0 || this.irqReload) { this.irqCounter = this.irqLatch; this.irqReload = false; }
      else this.irqCounter--;
      if (this.irqCounter === 0 && this.irqEnable) this.irqDelay = (this.rom.submapper | 0) === 1 ? 6 : 22;
    }
    cpuClock(cycles) {
      if (this.irqDelay <= 0) return;
      this.irqDelay -= cycles;
      if (this.irqDelay <= 0) { this.irqDelay = 0; this.irqFlag = true; }
    }
  }

  // 80: Taito X1-005($7EF0/$7EF1 CHR 2K、$7EF2-$7EF5 CHR 1K、$7EF6 bit0 ミラーリング(1=V)、$7EF8 RAM 許可($A3)、
  //   $7EFA/$7EFC/$7EFE PRG 8K。RAM は $7F00-$7FFF の 128 バイト(ミラー)。許可は見ない)
  class TaitoX1005 extends Mapper {
    constructor(rom) { super(rom); this.setPrg8(3, -1); }
    cpuRead(addr) {
      if (addr >= 0x7F00 && addr < 0x8000) return this.prgRam[addr & 0x7F];
      if (addr >= 0x6000 && addr < 0x8000) return -1;
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) return;
      if (addr >= 0x7F00) { this.prgRam[addr & 0x7F] = v; return; }
      if (addr < 0x7EF0) return;
      switch (addr) {
        case 0x7EF0: this.setChr1(0, v); this.setChr1(1, v + 1); break;
        case 0x7EF1: this.setChr1(2, v); this.setChr1(3, v + 1); break;
        case 0x7EF2: case 0x7EF3: case 0x7EF4: case 0x7EF5: this.setChr1(4 + (addr - 0x7EF2), v); break;
        case 0x7EF6: case 0x7EF7: this.setMirroring((v & 1) ? 'V' : 'H'); break;
        case 0x7EFA: case 0x7EFB: this.setPrg8(0, v); break;
        case 0x7EFC: case 0x7EFD: this.setPrg8(1, v); break;
        case 0x7EFE: case 0x7EFF: this.setPrg8(2, v); break;
      }
    }
  }

  // 82: Taito X1-017($7EF0-$7EF5 CHR(2K×2+1K×4、$7EF6 bit1 で上下入れ替え)、$7EF6 bit0 ミラーリング(1=V)、
  //   $7EF7-$7EF9 RAM 許可(見ない)、$7EFA-$7EFC PRG 8K(値>>2)。RAM は $6000-$73FF)
  class TaitoX1017 extends Mapper {
    constructor(rom) { super(rom); this.chrRegs = new Uint8Array(6); this.chrMode = 0; this.setPrg8(3, -1); this.applyChr(); }
    applyChr() {
      const r = this.chrRegs;
      if (this.chrMode === 0) { this.setChr2(0, r[0] >> 1); this.setChr2(1, r[1] >> 1); for (let i = 0; i < 4; i++) this.setChr1(4 + i, r[2 + i]); }
      else { for (let i = 0; i < 4; i++) this.setChr1(i, r[2 + i]); this.setChr2(2, r[0] >> 1); this.setChr2(3, r[1] >> 1); }
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x7400) return this.prgRam[addr - 0x6000];
      if (addr >= 0x6000 && addr < 0x8000) return -1;
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) return;
      if (addr < 0x7400) { if (addr >= 0x6000) this.prgRam[addr - 0x6000] = v; return; }
      switch (addr) {
        case 0x7EF0: case 0x7EF1: case 0x7EF2: case 0x7EF3: case 0x7EF4: case 0x7EF5: this.chrRegs[addr & 0xF] = v; this.applyChr(); break;
        case 0x7EF6: this.setMirroring((v & 1) ? 'V' : 'H'); this.chrMode = (v >> 1) & 1; this.applyChr(); break;
        case 0x7EFA: case 0x7EFB: case 0x7EFC: this.setPrg8(addr - 0x7EFA, v >> 2); break;
      }
    }
  }

  // 184: Sunsoft-1($6000: bit0-2 CHR 4K 下、bit4-6 CHR 4K 上)
  class Sunsoft1 extends Mapper {
    cpuWrite(addr, v) {
      if (addr >= 0x6000 && addr < 0x8000) { for (let i = 0; i < 4; i++) { this.setChr1(i, (v & 7) * 4 + i); this.setChr1(4 + i, ((v >> 4) & 7) * 4 + i); } }
    }
  }

  // 89: Sunsoft-2(Sunsoft-3 基板。$8000: bit4-6 PRG 16K、bit0-2+bit7 CHR 8K、bit3 1 画面)
  //  93: Sunsoft-2(Sunsoft-3R 基板。$8000: bit4-6 PRG 16K、bit0 CHR RAM 有効。無効の間は読みが 0、書きは捨てる。
  //      起動直後は無効なので、CHR RAM を埋める前に有効にしないソフトは画面が出ない(実機・Mesen と同じ))
  class Sunsoft2 extends Mapper {
    constructor(rom) { super(rom); this.chrOn = rom.mapper === 89; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      this.setPrg16(0, (v >> 4) & 7);
      if (this.rom.mapper === 89) { this.setChr8((v & 7) | ((v & 0x80) >> 4)); this.setMirroring((v & 8) ? '1B' : '1A'); }
      else this.chrOn = (v & 1) !== 0;
    }
    ppuRead(addr) { return addr < 0x2000 && !this.chrOn ? (addr & 0xFF) : super.ppuRead(addr); } // 無効時は PPU オープンバス(番地の下位バイト。Mesen と同じ)
    ppuWrite(addr, v) { if (addr < 0x2000 && !this.chrOn) return; super.ppuWrite(addr, v); }
  }

  // 67: Sunsoft-3($8800-$B800 CHR 2K×4、$C800 IRQ カウンタ 16bit を上位→下位の 2 回書き、$D800 bit4 IRQ 有効、
  //   $E800 ミラーリング、$F800 PRG 16K。カウンタは毎サイクル減り、0 から下へ回った時に IRQ+無効)
  class Sunsoft3 extends Mapper {
    constructor(rom) { super(rom); this.irqLatchHi = false; this.irqEnable = false; this.irqCounter = 0; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      switch (addr & 0xF800) {
        case 0x8800: this.setChr2(0, v); break;
        case 0x9800: this.setChr2(1, v); break;
        case 0xA800: this.setChr2(2, v); break;
        case 0xB800: this.setChr2(3, v); break;
        case 0xC800: this.irqCounter = this.irqLatchHi ? (this.irqCounter & 0xFF00) | v : (this.irqCounter & 0x00FF) | (v << 8); this.irqLatchHi = !this.irqLatchHi; break;
        case 0xD800: this.irqEnable = (v & 0x10) !== 0; this.irqLatchHi = false; this.irqFlag = false; break;
        case 0xE800: this.setMirroring(['V', 'H', '1A', '1B'][v & 3]); break;
        case 0xF800: this.setPrg16(0, v); break;
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) {
        this.irqCounter = (this.irqCounter - 1) & 0xFFFF;
        if (this.irqCounter === 0xFFFF) { this.irqEnable = false; this.irqFlag = true; break; }
      }
    }
  }

  // 68: Sunsoft-4($8000-$B000 CHR 2K×4、$C000/$D000 ネームテーブルに出す CHR 1K(|$80)、$E000 bit0-1 ミラーリング+
  //   bit4 で NT を CHR ROM から、$F000 PRG 16K(bit4 RAM 許可は見ない)。ライセンス認証の外部 ROM は未対応)
  class Sunsoft4 extends Mapper {
    constructor(rom) { super(rom); this.ntRegs = [0x80, 0x80]; this.ntFromChr = false; this.mirror = rom.mirroring; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.setChr2(0, v); break;
        case 0x9000: this.setChr2(1, v); break;
        case 0xA000: this.setChr2(2, v); break;
        case 0xB000: this.setChr2(3, v); break;
        case 0xC000: this.ntRegs[0] = v | 0x80; break;
        case 0xD000: this.ntRegs[1] = v | 0x80; break;
        case 0xE000: this.mirror = ['V', 'H', '1A', '1B'][v & 3]; this.setMirroring(this.mirror); this.ntFromChr = (v & 0x10) !== 0; break;
        case 0xF000: this.setPrg16(0, v & 7); break;
      }
    }
    _ntChr(addr) { const page = this.ntMap[(addr >> 10) & 3]; return ((this.ntRegs[page] % this.chrBanks1) << 10) | (addr & 0x3FF); }
    ppuRead(addr) {
      if (addr >= 0x2000 && this.ntFromChr) return this.chr[this._ntChr(addr)];
      return super.ppuRead(addr);
    }
    ppuWrite(addr, v) {
      if (addr >= 0x2000 && this.ntFromChr) { if (this.chrIsRam) this.chr[this._ntChr(addr)] = v; return; }
      super.ppuWrite(addr, v);
    }
  }

  // 210: Namco 175/340(N163 から音源と NT-CHR を除いた物。$8000-$BFFF CHR 1K×8、$E000/$E800/$F000 PRG 8K。
  //   340 は $E000 bit6-7 ミラーリング(0=1A 1=V 2=H 3=1B)、175 は $C000 bit0 RAM 許可(見ない)で固定ミラーリング。
  //   サブマッパー 1=175、2=340、無ければ Mesen と同じ自動判定($E000 の bit6/7 が立てば 340、$C000 系の書きで 175、
  //   $6000 RAM へ書けば 340 ではない))
  class Namco175 extends Mapper {
    constructor(rom) {
      super(rom);
      const sub = rom.submapper | 0;
      this.variant = sub === 1 ? 175 : sub === 2 ? 340 : 0; this.auto = sub === 0; this.ramWritten = false;
      this.setPrg8(3, -1);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x6000 && addr < 0x8000) { this.ramWritten = true; if (this.auto && this.variant === 340) this.variant = 0; }
      super.cpuWrite(addr, v);
    }
    writeReg(addr, v) {
      const hi = addr & 0xF800;
      if (hi < 0xC000) { this.setChr1((hi - 0x8000) >> 11, v); return; }
      if (hi < 0xE000) { if (this.auto && this.variant !== 340) this.variant = 175; return; } // 175: RAM 許可
      if (hi === 0xE000) {
        if (this.auto && (v & 0xC0) && !this.ramWritten) this.variant = 340;
        this.setPrg8(0, v & 0x3F);
        if (this.variant === 340) this.setMirroring(['1A', 'V', 'H', '1B'][(v >> 6) & 3]);
        return;
      }
      if (hi === 0xE800) { this.setPrg8(1, v & 0x3F); return; }
      if (hi === 0xF000) this.setPrg8(2, v & 0x3F);
    }
  }

  // 66: GxROM($8000: bit4-5 PRG 32K、bit0-1 CHR 8K)
  class GxROM extends Mapper {
    writeReg(addr, v) { this.setPrg32((v >> 4) & 3); this.setChr8(v & 3); }
  }

  // 34: BNROM(CHR RAM。$8000 PRG 32K、バス競合)/ NINA-001(CHR ROM。$7FFD PRG 32K、$7FFE/$7FFF CHR 4K。PRG RAM にも書く)。
  //   サブマッパー 1=NINA、2=BNROM、無ければ CHR ROM の有無で決める(Mesen と同じ)
  class BNROM extends Mapper {
    constructor(rom) { super(rom); const sub = rom.submapper | 0; this.nina = sub === 1 || (sub === 0 && !!rom.chr); }
    cpuWrite(addr, v) {
      if (this.nina) {
        if (addr >= 0x6000 && addr < 0x8000) {
          this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
          if (addr === 0x7FFD) this.setPrg32(v & 1);
          else if (addr === 0x7FFE) for (let i = 0; i < 4; i++) this.setChr1(i, (v & 0x0F) * 4 + i);
          else if (addr === 0x7FFF) for (let i = 0; i < 4; i++) this.setChr1(4 + i, (v & 0x0F) * 4 + i);
        }
        return;
      }
      if (addr >= 0x8000) this.setPrg32(busConflict(this, addr, v));
      else if (addr >= 0x6000) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
    }
  }

  // 70/152: Bandai 74161/7432($8000: bit4-6 PRG 16K、bit0-3 CHR 8K。152 は bit7 で 1 画面。70 でも bit7 を一度でも
  //   立てた後は同じ扱い。Mesen 同様)
  class Bandai74161 extends Mapper {
    constructor(rom) { super(rom); this.mirrorCtl = rom.mapper === 152; this.setPrg16(0, 0); this.setPrg16(1, -1); this.setMirroring('V'); }
    writeReg(addr, v) {
      if (v & 0x80) this.mirrorCtl = true;
      if (this.mirrorCtl) this.setMirroring((v & 0x80) ? '1B' : '1A');
      this.setPrg16(0, (v >> 4) & 7); this.setChr8(v & 0x0F);
    }
  }

  // 72: Jaleco JF-17 / 92: JF-19($8000: bit7 の立ち上がりで PRG 16K(72 は $8000、92 は $C000)、bit6 の立ち上がりで
  //   CHR 8K。バス競合。音源(bit4-5 の ADPCM)は未対応)
  class JalecoJF17 extends Mapper {
    constructor(rom) { super(rom); this.jf19 = rom.mapper === 92; this.prgFlag = false; this.chrFlag = false; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      v = busConflict(this, addr, v);
      if (!this.prgFlag && (v & 0x80)) { if (this.jf19) this.setPrg16(1, v & 0x0F); else this.setPrg16(0, v & 0x07); }
      if (!this.chrFlag && (v & 0x40)) this.setChr8(v & 0x0F);
      this.prgFlag = (v & 0x80) !== 0; this.chrFlag = (v & 0x40) !== 0;
    }
  }

  // 86: Jaleco JF-13($6000: bit4-5 PRG 32K、bit0-1+bit6 CHR 8K。$7000 の音声は未対応)
  // 87: ($6000: bit0/bit1 を入れ替えて CHR 8K)
  // 140: Jaleco JF-11/14($6000: bit4-5 PRG 32K、bit0-3 CHR 8K)
  class JalecoJF13 extends Mapper {
    cpuWrite(addr, v) {
      if (addr < 0x6000 || addr >= 0x8000) return;
      const m = this.rom.mapper;
      if (m === 86) { if ((addr & 0x7000) === 0x6000) { this.setPrg32((v & 0x30) >> 4); this.setChr8((v & 3) | ((v >> 4) & 4)); } }
      else if (m === 87) this.setChr8(((v & 1) << 1) | ((v & 2) >> 1));
      else { this.setPrg32((v >> 4) & 3); this.setChr8(v & 0x0F); }
    }
  }

  // 73: Konami VRC3($8000-$B000 IRQ ラッチ 4 ニブル、$C000 bit1 有効(有効化でラッチ→カウンタ)+bit2 で 8bit 幅+
  //   bit0 ack 後の有効、$D000 ack、$F000 PRG 16K。カウンタは毎サイクル増え、あふれで IRQ+ラッチ再設定)
  class VRC3 extends Mapper {
    constructor(rom) { super(rom); this.irqLatch = 0; this.irqCounter = 0; this.irqEnable = false; this.irqAfterAck = false; this.small = false; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.irqLatch = (this.irqLatch & 0xFFF0) | (v & 0x0F); break;
        case 0x9000: this.irqLatch = (this.irqLatch & 0xFF0F) | ((v & 0x0F) << 4); break;
        case 0xA000: this.irqLatch = (this.irqLatch & 0xF0FF) | ((v & 0x0F) << 8); break;
        case 0xB000: this.irqLatch = (this.irqLatch & 0x0FFF) | ((v & 0x0F) << 12); break;
        case 0xC000: this.irqEnable = (v & 2) !== 0; if (this.irqEnable) this.irqCounter = this.irqLatch; this.small = (v & 4) !== 0; this.irqAfterAck = (v & 1) !== 0; this.irqFlag = false; break;
        case 0xD000: this.irqFlag = false; this.irqEnable = this.irqAfterAck; break;
        case 0xF000: this.setPrg16(0, v & 7); break;
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) {
        if (this.small) {
          let lo = ((this.irqCounter & 0xFF) + 1) & 0xFF;
          if (lo === 0) { lo = this.irqLatch & 0xFF; this.irqFlag = true; }
          this.irqCounter = (this.irqCounter & 0xFF00) | lo;
        } else {
          this.irqCounter = (this.irqCounter + 1) & 0xFFFF;
          if (this.irqCounter === 0) { this.irqCounter = this.irqLatch; this.irqFlag = true; }
        }
      }
    }
  }

  // 78: Jaleco JF-16($8000: bit0-2 PRG 16K、bit4-7 CHR 8K、bit3 ミラーリング(サブマッパー 3 は V/H、他は 1 画面)。バス競合)
  class JalecoJF16 extends Mapper {
    constructor(rom) { super(rom); this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      v = busConflict(this, addr, v);
      this.setPrg16(0, v & 7); this.setChr8((v >> 4) & 0x0F);
      if ((this.rom.submapper | 0) === 3) this.setMirroring((v & 8) ? 'V' : 'H'); else this.setMirroring((v & 8) ? '1B' : '1A');
    }
  }

  // 77: Irem LROG017($8000: bit0-3 PRG 32K、bit4-7 CHR 2K を $0000 に(残り 6K は CHR RAM)。4 画面。バス競合)
  class IremLROG017 extends Mapper {
    constructor(rom) {
      super(rom);
      this.chrRam = new Uint8Array(0x1800); this.chrRom = rom.chr || new Uint8Array(0x800); this.chrBank = 0;
      this.ciram = new Uint8Array(0x1000); this.setMirroring('4');
    }
    writeReg(addr, v) { v = busConflict(this, addr, v); this.setPrg32(v & 0x0F); this.chrBank = ((v >> 4) & 0x0F) % Math.max(1, this.chrRom.length >> 11); }
    ppuRead(addr) {
      if (addr < 0x800) return this.chrRom[(this.chrBank << 11) | addr];
      if (addr < 0x2000) return this.chrRam[addr - 0x800];
      return super.ppuRead(addr);
    }
    ppuWrite(addr, v) {
      if (addr < 0x800) return;
      if (addr < 0x2000) { this.chrRam[addr - 0x800] = v; return; }
      super.ppuWrite(addr, v);
    }
  }

  // 94: UN1ROM($8000: bit2-4 PRG 16K)/ 180: UNROM 逆($8000 固定 0、$C000 = bit0-2)/ 97: Irem TAM-S1($8000 固定末尾、
  //   $C000 = bit0-3、bit6-7 ミラーリング 0=1A 1=H 2=V 3=1B)
  class UxROMVariants extends Mapper {
    constructor(rom) {
      super(rom);
      const m = rom.mapper;
      if (m === 97) { this.setPrg16(0, -1); this.setPrg16(1, -1); }
      else { this.setPrg16(0, 0); this.setPrg16(1, m === 180 ? 0 : -1); }
    }
    writeReg(addr, v) {
      const m = this.rom.mapper;
      if (m === 94) this.setPrg16(0, (v >> 2) & 7);
      else if (m === 180) this.setPrg16(1, v & 7);
      else { this.setPrg16(1, v & 0x0F); this.setMirroring(['1A', 'H', 'V', '1B'][v >> 6]); }
    }
  }

  // 185: CNROM の CHR 保護(書いた値が条件に合う時だけ CHR が読める。サブマッパー 0: 下位 4bit が 0 でなく $13 でもない、
  //   4-7: 下位 2bit がそれぞれ 0-3。読めない時は PPU オープンバス(番地の下位バイト)に 1 を立てた値(Mesen と同じ)。バス競合)
  class CNROMProtect extends Mapper {
    constructor(rom) { super(rom); this.chrOn = true; }
    writeReg(addr, v) {
      v = busConflict(this, addr, v);
      const sub = this.rom.submapper | 0;
      this.chrOn = sub === 0 ? ((v & 0x0F) !== 0 && v !== 0x13) : sub >= 4 && sub <= 7 ? (v & 3) === sub - 4 : true;
    }
    ppuRead(addr) { return addr < 0x2000 && !this.chrOn ? ((addr & 0xFF) | 1) : super.ppuRead(addr); }
  }

  // Namco 108 の派生: 76(CHR 2K×4 をレジスタ 2-5 で)、88(CHR 128K: レジスタ 0/1 は下半分、2-5 は上半分)、
  //   95(レジスタ 0/1 の bit5 がネームテーブル)、154(88 + $8000 bit6 で 1 画面)
  class Namco108Variants extends Namco108 {
    writeReg(addr, v) {
      const m = this.rom.mapper;
      if (m === 154 && (addr & 0x8001) === 0x8000) this.setMirroring((v & 0x40) ? '1B' : '1A');
      super.writeReg(addr, v);
      if (m === 95 && (addr & 0x8001) === 0x8001) { const a = (this.regs[0] >> 5) & 1, b = (this.regs[1] >> 5) & 1; this.ntMap = [a, a, b, b]; }
    }
    apply() {
      const m = this.rom.mapper, r = this.regs;
      if (m === 76) { for (let i = 0; i < 4; i++) this.setChr2(i, r[2 + i]); }
      else if (m === 88 || m === 154) {
        this.setChr1(0, r[0] & 0x3E); this.setChr1(1, (r[0] & 0x3E) + 1); this.setChr1(2, r[1] & 0x3E); this.setChr1(3, (r[1] & 0x3E) + 1);
        for (let i = 0; i < 4; i++) this.setChr1(4 + i, r[2 + i] | 0x40);
      } else { // 95
        this.setChr1(0, r[0] & 0x1E); this.setChr1(1, (r[0] & 0x1E) + 1); this.setChr1(2, r[1] & 0x1E); this.setChr1(3, (r[1] & 0x1E) + 1);
        for (let i = 0; i < 4; i++) this.setChr1(4 + i, r[2 + i] & 0x1F);
      }
      const last = this.prgBanks8 - 1;
      this.setPrg8(0, r[6]); this.setPrg8(1, r[7]); this.setPrg8(2, last - 1); this.setPrg8(3, last);
    }
  }

  // 69: Sunsoft FME-7 / 5B(PRG 8K×3 切替 + $6000 は ROM か RAM、CHR 1K×8、16bit サイクル IRQ、5B は AY 系音源
  //   $C000/$E000)。FME-7(音源無し)のソフトもマッパー番号は同じなので、音源は常に挿す(書かれなければ鳴らない)
  class Sunsoft5B extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.FME7Audio ? new Emu.FME7Audio() : null;
      this.extBits = 0x20;
      this.cmd = 0;
      this.ramAt6000 = false; this.ramEnabled = false; this.rom6000 = 0;
      this.irqEnable = false; this.counterEnable = false; this.counter = 0xFFFF;
      this.ayAddr = 0; this.ayShadow = new Int16Array(16).fill(-1);
      this.setPrg8(0, 0); this.setPrg8(1, 1); this.setPrg8(2, 2); this.setPrg8(3, -1);
    }
    audioAddr(addr) { const m = addr & 0xE000; return m === 0xC000 ? 0xC000 : m === 0xE000 ? 0xE000 : -1; }
    audioImage() {
      const out = [];
      for (let r = 0; r < 16; r++) if (this.ayShadow[r] >= 0) { out.push({ addr: 0xC000, value: r }); out.push({ addr: 0xE000, value: this.ayShadow[r] }); }
      out.push({ addr: 0xC000, value: this.ayAddr });
      return out;
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) {
        if (this.ramAt6000) return this.ramEnabled ? this.prgRam[(addr - 0x6000) % this.prgRam.length] : -1;
        return this.prg[((this.rom6000 % this.prgBanks8) << 13) + (addr & 0x1FFF)];
      }
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x6000 && addr < 0x8000) { if (this.ramAt6000 && this.ramEnabled) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v; return; }
      super.cpuWrite(addr, v);
    }
    writeReg(addr, v) {
      switch (addr & 0xE000) {
        case 0x8000: this.cmd = v & 0x0F; break;
        case 0xA000: this.param(this.cmd, v); break;
        case 0xC000: this.ayAddr = v & 0x0F; if (this.audio) this.audio.writeRegister(0xC000, v); break;
        case 0xE000: this.ayShadow[this.ayAddr] = v; if (this.audio) this.audio.writeRegister(0xE000, v); break;
      }
    }
    param(cmd, v) {
      if (cmd < 8) { this.setChr1(cmd, v); return; }
      switch (cmd) {
        case 8: this.ramAt6000 = (v & 0x40) !== 0; this.ramEnabled = (v & 0x80) !== 0; this.rom6000 = v & 0x3F; break;
        case 9: case 10: case 11: this.setPrg8(cmd - 9, v & 0x3F); break;
        case 12: this.setMirroring(['V', 'H', '1A', '1B'][v & 3]); break;
        case 13: this.irqEnable = (v & 1) !== 0; this.counterEnable = (v & 0x80) !== 0; this.irqFlag = false; break;
        case 14: this.counter = (this.counter & 0xFF00) | v; break;
        case 15: this.counter = (this.counter & 0x00FF) | (v << 8); break;
      }
    }
    cpuClock(cycles) {
      if (!this.counterEnable) return;
      for (let c = 0; c < cycles; c++) {
        if (this.counter === 0) { this.counter = 0xFFFF; if (this.irqEnable) this.irqFlag = true; }
        else this.counter--;
      }
    }
  }

  // 5: Nintendo MMC5(ExROM)。PRG モード 0-3($5100)、PRG RAM 64K($5113-$5117 の bit7 で ROM/RAM)、CHR モード 0-3
  //   ($5101)と 8×16 スプライト時の A/B 2 組、ネームテーブル割当($5105: CIRAM/ExRAM/塗りつぶし)、ExRAM の
  //   4 モード($5104。モード 1=拡張属性: タイルごとの 4K CHR バンクとパレット)、スキャンライン IRQ($5203/$5204。
  //   実機と同じく「同じネームテーブル番地の連続 3 回読み」で行を数える)、乗算器($5205/$5206)、音源($5000-$5015)。
  //   縦分割($5200-$5202)、PRG RAM 書き込み保護($5102/$5103)、$5015 の読み出し(音源の長さカウンタ)も対応。
  //   未対応: 2 つめの 64K 以上の RAM 配置(NES 2.0 の 64K/128K RAM を 1 塊として扱う)
  class MMC5 extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.MMC5Audio ? new Emu.MMC5Audio() : null;
      this.extBits = 0x08;
      this.prgRam = new Uint8Array(0x10000);
      this.exram = new Uint8Array(0x400);
      this.prgMode = 3; this.chrMode = 3; this.exMode = 0;
      this.prgRegs = new Uint8Array([0, 0, 0, 0, 0xFF]); // $5113-$5117
      this.chrRegs = new Uint16Array(12);                 // $5120-$512B
      this.chrUpper = 0;                                  // $5130
      this.ntMode = 0; this.fillTile = 0; this.fillAttr = 0;
      this.lastChrSet = 0;                                // 0=A($5120-27) 1=B($5128-2B)。8×8 スプライト時はこれ
      this.chrA = new Int32Array(8); this.chrB = new Int32Array(8);
      this.slotIsRam = [false, false, false, false]; this.slotOff = new Int32Array(4);
      this.irqCompare = 0; this.irqEnable = false; this.irqPend = false; this.inFrame = false;
      this.scanline = 0; this.ntLast = -1; this.ntSame = 0; this.idleDots = 0;
      this.prot1 = 0; this.prot2 = 0; this.ramWrite = false; // $5102/$5103 が 2/1 になるまで PRG RAM は書けない
      this.splitOn = false; this.splitRight = false; this.splitTile = 0; this.splitScroll = 0; this.splitBank = 0; // 縦分割($5200-$5202)
      this.splitN = 0; this.splitIn = false; this.splitAddr = 0; this.tickPending = false; // 行内の NT 取得の通し番号(3 連続読みで 0 に戻る)、分割領域の中か、分割側の NT 番地
      this.mulA = 0xFF; this.mulB = 0xFF;
      this.exTile = 0;                                    // 拡張属性モードで最後に読んだネームテーブルの ExRAM バイト
      this.audioShadow = new Int16Array(0x16).fill(-1);
      this.applyPrg(); this.applyChr();
    }
    audioAddr(addr) { return addr >= 0x5000 && addr <= 0x5015 ? addr : -1; }
    audioImage() {
      const out = [];
      for (const a of [0x5000, 0x5001, 0x5002, 0x5003, 0x5004, 0x5005, 0x5006, 0x5007, 0x5010, 0x5011, 0x5015]) {
        const v = this.audioShadow[a - 0x5000]; if (v >= 0) out.push({ addr: a, value: v });
      }
      return out;
    }
    // ── CPU ──
    cpuRead(addr) {
      if (addr >= 0x8000) {
        const s = (addr - 0x8000) >> 13, o = this.slotOff[s] + (addr & 0x1FFF);
        return this.slotIsRam[s] ? this.prgRam[o % this.prgRam.length] : this.prg[o];
      }
      if (addr >= 0x6000) return this.prgRam[(((this.prgRegs[0] & 7) << 13) + (addr & 0x1FFF)) % this.prgRam.length];
      if (addr >= 0x5C00) return (this.exMode >= 2) ? this.exram[addr & 0x3FF] : -1;
      switch (addr) {
        case 0x5204: { const v = (this.irqPend ? 0x80 : 0) | (this.inFrame ? 0x40 : 0); this.irqPend = false; return v; }
        case 0x5015: { const a = this.audio; return a && a.pulse1 && a.pulse2 ? ((a.pulse1.lengthCounter > 0 ? 1 : 0) | (a.pulse2.lengthCounter > 0 ? 2 : 0)) : 0; } // 音源の状態(長さカウンタ)
        case 0x5205: return (this.mulA * this.mulB) & 0xFF;
        case 0x5206: return ((this.mulA * this.mulB) >> 8) & 0xFF;
      }
      return -1;
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) {
        const s = (addr - 0x8000) >> 13;
        if (this.slotIsRam[s] && this.ramWrite) this.prgRam[(this.slotOff[s] + (addr & 0x1FFF)) % this.prgRam.length] = v;
        return;
      }
      if (addr >= 0x6000) { if (this.ramWrite) this.prgRam[(((this.prgRegs[0] & 7) << 13) + (addr & 0x1FFF)) % this.prgRam.length] = v; return; }
      if (addr === 0x5102 || addr === 0x5103) { // PRG RAM 書き込み保護: $5102=2 かつ $5103=1 の時だけ書ける
        if (addr === 0x5102) this.prot1 = v & 3; else this.prot2 = v & 3;
        this.ramWrite = this.prot1 === 2 && this.prot2 === 1;
        return;
      }
      if (addr >= 0x5200 && addr <= 0x5202) { // 縦分割
        if (addr === 0x5200) { this.splitOn = (v & 0x80) !== 0; this.splitRight = (v & 0x40) !== 0; this.splitTile = v & 0x1F; }
        else if (addr === 0x5201) this.splitScroll = v;
        else this.splitBank = v;
        return;
      }
      if (addr >= 0x5C00) { if (this.exMode < 3) this.exram[addr & 0x3FF] = v; return; }
      if (addr >= 0x5000 && addr <= 0x5015) { this.audioShadow[addr - 0x5000] = v; if (this.audio) this.audio.writeRegister(addr, v); return; }
      if (addr >= 0x5120 && addr <= 0x512B) {
        this.chrRegs[addr - 0x5120] = v | (this.chrUpper << 8);
        this.lastChrSet = addr >= 0x5128 ? 1 : 0;
        this.applyChr();
        return;
      }
      if (addr >= 0x5113 && addr <= 0x5117) { this.prgRegs[addr - 0x5113] = v; this.applyPrg(); return; }
      switch (addr) {
        case 0x5100: this.prgMode = v & 3; this.applyPrg(); break;
        case 0x5101: this.chrMode = v & 3; this.applyChr(); break;
        case 0x5104: this.exMode = v & 3; break;
        case 0x5105: this.ntMode = v; break;
        case 0x5106: this.fillTile = v; break;
        case 0x5107: this.fillAttr = (v & 3) * 0x55; break;
        case 0x5130: this.chrUpper = v & 3; break;
        case 0x5203: this.irqCompare = v; break;
        case 0x5204: this.irqEnable = (v & 0x80) !== 0; break;
        case 0x5205: this.mulA = v; break;
        case 0x5206: this.mulB = v; break;
      }
    }
    applyPrg() {
      const r = this.prgRegs, set = (s, reg, bank) => {
        const isRam = reg < 4 && !(r[reg] & 0x80);
        this.slotIsRam[s] = isRam;
        const n = isRam ? 8 : this.prgBanks8;
        this.slotOff[s] = ((bank % n) + n) % n << 13;
      };
      switch (this.prgMode) {
        case 0: { const b = (r[4] & 0x7C); set(0, 4, b); set(1, 4, b + 1); set(2, 4, b + 2); set(3, 4, b + 3); break; }
        case 1: { const a = r[2] & 0x7E, b = r[4] & 0x7E; set(0, 2, a); set(1, 2, a + 1); set(2, 4, b); set(3, 4, b + 1); break; }
        case 2: { const a = r[2] & 0x7E; set(0, 2, a); set(1, 2, a + 1); set(2, 3, r[3] & 0x7F); set(3, 4, r[4] & 0x7F); break; }
        default: set(0, 1, r[1] & 0x7F); set(1, 2, r[2] & 0x7F); set(2, 3, r[3] & 0x7F); set(3, 4, r[4] & 0x7F);
      }
    }
    applyChr() {
      const c = this.chrRegs, n = this.chrBanks1, A = this.chrA, B = this.chrB;
      const put = (map, slot, bank) => { map[slot] = (((bank % n) + n) % n) << 10; };
      switch (this.chrMode) {
        case 0: for (let i = 0; i < 8; i++) { put(A, i, c[7] * 8 + i); put(B, i, c[11] * 8 + i); } break;
        case 1: for (let i = 0; i < 4; i++) { put(A, i, c[3] * 4 + i); put(A, 4 + i, c[7] * 4 + i); put(B, i, c[11] * 4 + i); put(B, 4 + i, c[11] * 4 + i); } break;
        case 2: for (let i = 0; i < 2; i++) { put(A, i, c[1] * 2 + i); put(A, 2 + i, c[3] * 2 + i); put(A, 4 + i, c[5] * 2 + i); put(A, 6 + i, c[7] * 2 + i);
          put(B, i, c[9] * 2 + i); put(B, 2 + i, c[11] * 2 + i); put(B, 4 + i, c[9] * 2 + i); put(B, 6 + i, c[11] * 2 + i); } break;
        default: for (let i = 0; i < 8; i++) { put(A, i, c[i]); put(B, i, c[8 + (i & 3)]); }
      }
    }
    // ── PPU ──
    _bgFetching() { // 背景の取得中か(8×16 スプライト時の A/B 選択と拡張属性モード用)
      const p = this.ppu;
      if (!p || !(p.mask & 0x18)) return false;
      if (p.scanline >= 240 && p.scanline !== 261) return false;
      const d = p.dot;
      return (d >= 1 && d <= 256) || (d >= 321 && d <= 340);
    }
    _spriteFetching() { const p = this.ppu; return p && (p.mask & 0x18) && p.dot >= 257 && p.dot <= 320 && (p.scanline < 240 || p.scanline === 261); }
    _chrMap() {
      const p = this.ppu;
      if (p && (p.ctrl & 0x20)) { // 8×16: 背景は B、スプライトは A。描画外は最後に書いた組
        if (this._spriteFetching()) return this.chrA;
        if (this._bgFetching()) return this.chrB;
      }
      return this.lastChrSet ? this.chrB : this.chrA;
    }
    _nt(addr) { return (this.ntMode >> (((addr >> 10) & 3) * 2)) & 3; }
    ppuRead(addr) {
      // 縦分割: 行内の NT 取得を数え(ダミー読み 2 回目で 0 に戻す)、境目のタイル列で領域に出入りする。領域内は NT/属性を ExRAM、
      //   パターンを $5202 の 4K バンクと $5201 の縦スクロールから出す(Mesen と同じ数え方。画面の列 = 通し番号+2)
      const isNt = addr >= 0x2000 && (addr & 0x3FF) < 0x3C0;
      if (isNt) this.splitN++;
      if (this.tickPending) { this.tickPending = false; this._scanlineTick(); } // 3 連続読みの「次の読み」(属性)で行を進める(Mesen と同じ)
      if (addr < 0x2000) {
        if (this.splitOn && this.splitIn && this.exMode <= 1 && this.inFrame && this._bgFetching()) {
          const vs = (this.scanline + this.splitScroll) % 240, bank = this.splitBank % Math.max(1, this.chrBanks1 >> 2);
          return this.chr[(bank << 12) + (((addr & ~7) | (vs & 7)) & 0xFFF)];
        }
        if (this.exMode === 1 && this._bgFetching()) {
          const bank = ((this.exTile & 0x3F) | (this.chrUpper << 6)) % Math.max(1, this.chrBanks1 >> 2);
          return this.chr[(bank << 12) + (addr & 0xFFF)];
        }
        return this.chr[this._chrMap()[addr >> 10] + (addr & 0x3FF)];
      }
      // ネームテーブル。スキャンライン検出: 同じ番地の連続 3 回読み(337・339 ドット目のダミー読みと次の行の 1 ドット目)
      if (this._bgFetching()) {
        if (addr === this.ntLast) { if (++this.ntSame === 3) { this.tickPending = true; this.splitN = 0; } }
        else { this.ntLast = addr; this.ntSame = 1; }
      }
      const mode = this._nt(addr), lo = addr & 0x3FF, isAttr = lo >= 0x3C0;
      if (this.splitOn && this.exMode <= 1 && this.inFrame && this._bgFetching()) {
        const sl = this.splitN >= 41 ? this.scanline + 1 : this.scanline;
        const vs = (sl + this.splitScroll) % 240, col = (this.splitN + 2) % 42;
        if (isNt) {
          if (col === 0) this.splitIn = !this.splitRight;
          if (col === this.splitTile && this.splitN < 42) this.splitIn = !this.splitIn;
          else if (col > 32) this.splitIn = false;
          if (this.splitIn) { this.splitAddr = ((vs & 0xF8) << 2) | col; return this.exram[this.splitAddr]; }
        } else if (this.splitIn) {
          const t = this.splitAddr, shift = ((t >> 4) & 4) | (t & 2), at = 0x3C0 | ((t & 0x380) >> 4) | ((t & 0x1F) >> 2);
          return ((this.exram[at] >> shift) & 3) * 0x55;
        }
      }
      if (this.exMode === 1 && this._bgFetching()) {
        if (isAttr) return ((this.exTile >> 6) & 3) * 0x55;
        this.exTile = this.exram[lo];
      }
      switch (mode) {
        case 0: return this.ciram[lo];
        case 1: return this.ciram[0x400 | lo];
        case 2: return this.exMode < 2 ? this.exram[lo] : 0;
        default: return isAttr ? this.fillAttr : this.fillTile;
      }
    }
    ppuWrite(addr, v) {
      if (addr < 0x2000) { if (this.chrIsRam) this.chr[this._chrMap()[addr >> 10] + (addr & 0x3FF)] = v; return; }
      const mode = this._nt(addr), lo = addr & 0x3FF;
      if (mode === 0) this.ciram[lo] = v;
      else if (mode === 1) this.ciram[0x400 | lo] = v;
      else if (mode === 2 && this.exMode < 2) this.exram[lo] = v;
    }
    _scanlineTick() {
      if (!this.inFrame) { this.inFrame = true; this.scanline = 0; this.irqPend = false; }
      else { this.scanline++; if (this.scanline === this.irqCompare && this.irqCompare !== 0) this.irqPend = true; }
      this.idleDots = 0;
    }
    cpuClock(cycles) {
      // 描画が止まった(vblank/描画 OFF)ら「フレーム内」を下ろす。実機は NT 読みが 3 行ぶん無いと下りる
      const p = this.ppu;
      if (this.inFrame && p && (!(p.mask & 0x18) || (p.scanline >= 240 && p.scanline !== 261))) { this.inFrame = false; this.ntSame = 0; this.ntLast = -1; }
    }
    irqPending() { return this.irqPend && this.irqEnable; }
  }

  const TABLE = {
    0: NROM, 1: MMC1, 155: MMC1, 2: UxROM, 3: CNROM, 4: MMC3, 5: MMC5, 7: AxROM, 9: MMC2, 10: MMC2, 16: BandaiFCG, 157: BandaiFCG, 18: JalecoSS88006, 19: Namco163,
    21: VRC24, 22: VRC24, 23: VRC24, 24: VRC6, 25: VRC24, 26: VRC6, 32: IremG101, 33: TaitoTC0690, 34: BNROM, 48: TaitoTC0690,
    65: IremH3001, 66: GxROM, 67: Sunsoft3, 68: Sunsoft4, 69: Sunsoft5B, 70: Bandai74161, 72: JalecoJF17, 73: VRC3, 75: VRC1,
    76: Namco108Variants, 77: IremLROG017, 78: JalecoJF16, 80: TaitoX1005, 82: TaitoX1017, 85: VRC7, 86: JalecoJF13, 87: JalecoJF13,
    88: Namco108Variants, 89: Sunsoft2, 92: JalecoJF17, 93: Sunsoft2, 94: UxROMVariants, 95: Namco108Variants, 97: UxROMVariants,
    140: JalecoJF13, 152: Bandai74161, 153: BandaiFCG, 154: Namco108Variants, 159: BandaiFCG, 180: UxROMVariants, 184: Sunsoft1,
    185: CNROMProtect, 206: Namco108, 210: Namco175,
  };

  const NesMappers = {
    supported(mapper) { return Object.prototype.hasOwnProperty.call(TABLE, mapper); },
    create(rom) {
      const C = TABLE[rom.mapper];
      if (!C) throw new Error(`マッパー ${rom.mapper} は未対応です(対応: ${Object.keys(TABLE).join(', ')})`);
      return new C(rom);
    },
    Mapper, NROM, MMC1, UxROM, CNROM, MMC3, MMC5, AxROM, Namco163, VRC24, VRC1, VRC6, Sunsoft5B, VRC7, Namco108,
    MMC2, BandaiFCG, JalecoSS88006, IremG101, IremH3001, TaitoTC0690, TaitoX1005, TaitoX1017, Sunsoft1, Sunsoft2, Sunsoft3, Sunsoft4,
    Namco175, GxROM, BNROM, Bandai74161, JalecoJF17, JalecoJF13, VRC3, JalecoJF16, IremLROG017, UxROMVariants, CNROMProtect, Namco108Variants,
  };
  Emu.NesMappers = NesMappers;
})(typeof window !== 'undefined' ? window : globalThis);
