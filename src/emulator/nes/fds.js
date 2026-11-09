/*
 * Famicom Disk System (MML.Emu.FdsDisk) — 自前 NES エミュレータの FDS 対応(DESIGN-CAPTURE.md §7、段階 6d)
 *
 * ■ ディスク画像
 *   .fds(先頭 16 バイトの "FDS\x1a" ヘッダは任意、1 面 65500 バイト)をブロック列として読み、ドライブが読む
 *   「ギャップつきの面」に展開する: 先頭に 28300 ビットのギャップ(0)、各ブロックは $80(ブロック開始マーク)+本体+
 *   CRC 2 バイト+976 ビットのギャップ。CRC は Mesen と同じ固定値($4D $62)を置く(ドライブ側で CRC エラーを
 *   報告しないので値は何でもよい。再生側が同じ並びになる)。
 * ■ ドライブ(RP2C33)
 *   Mesen の模型に揃える(録音をフレーム単位で比べる基準): モーター停止/ディスク無しで「ヘッド終端」、ヘッド終端
 *   から 50000 サイクル待って先頭へ、以後 149 サイクルごとに 1 バイト。読みは「ready(bit6)が立ってから最初の
 *   非 0 バイト($80)でギャップ終わり(このバイトは IRQ を出さない)」、以後は毎バイト転送フラグ+IRQ(bit7)。
 *   $4030 の CRC エラービットは .fds では常に 0(Mesen 同様)。面の終わりでモーター停止。
 * ■ メモリ
 *   $6000-$DFFF 32K RAM、$E000-$FFFF BIOS(8K、利用者が用意する disksys.rom)、CHR RAM 8K、ミラーリングは $4025 bit3。
 *   タイマ IRQ($4020-$4022)、音源 $4040-$408A は NSF 用の Emu.FDSAudio。
 * ■ 録音
 *   FDS の音源レジスタは VGM の標準部分($4023/$4040-$408A → 0xB4)。extBits は 0x04。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SIDE_SIZE = 65500;
  const NO_DISK = -1;

  // ディスクシステムの BIOS(disksys.rom)か: 8K ちょうどで、MSX カートリッジの 'AB' ヘッダが無く、末尾の 6502 ベクタ(NMI/RESET/IRQ)が
  // すべて $E000-$FFFF(BIOS の置き場)を指す。拡張子は見ない(.rom なので MSX の ROM と取り違えやすい)
  function isFdsBios(bytes) {
    if (!bytes || bytes.length !== 0x2000) return false;
    if (bytes[0] === 0x41 && bytes[1] === 0x42) return false;
    for (let o = 0x1FFA; o < 0x2000; o += 2) if (bytes[o + 1] < 0xE0) return false;
    return true;
  }
  function isFds(bytes) {
    if (!bytes || bytes.length < 16) return false;
    if (bytes[0] === 0x46 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x1A) return true;
    if (bytes[0] !== 0x01) return false;
    const s = '*NINTENDO-HVC*';
    for (let i = 0; i < s.length; i++) if (bytes[1 + i] !== s.charCodeAt(i)) return false;
    return true;
  }

  // 1 面(65500 バイトのブロック列)→ ギャップつきの面(65500 バイト)
  function buildSide(raw) {
    const out = [];
    for (let i = 0; i < 28300 / 8; i++) out.push(0);
    let i = 0;
    while (i < raw.length) {
      const type = raw[i];
      let len = 1;
      switch (type) {
        case 1: len = 56; break;
        case 2: len = 2; break;
        case 3: len = 16; break;
        case 4: len = 1 + raw[i - 3] + raw[i - 2] * 0x100; break;
        default: len = 0;
      }
      if (!len) break;
      out.push(0x80);
      for (let k = 0; k < len; k++) out.push(raw[i + k] || 0);
      out.push(0x4D, 0x62);
      for (let k = 0; k < 976 / 8; k++) out.push(0);
      i += len;
    }
    const side = new Uint8Array(Math.max(SIDE_SIZE, out.length));
    side.set(out);
    return side;
  }

  function parse(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (!isFds(bytes)) throw new Error('FDS ディスク画像ではありません');
    let off = 0, n;
    if (bytes[0] === 0x46) { n = bytes[4] || Math.floor((bytes.length - 16) / SIDE_SIZE); off = 16; }
    else n = Math.max(1, Math.floor(bytes.length / SIDE_SIZE));
    const raw = [], sides = [], headers = [];
    for (let s = 0; s < n; s++) {
      const r = new Uint8Array(SIDE_SIZE);
      r.set(bytes.subarray(off + s * SIDE_SIZE, Math.min(bytes.length, off + (s + 1) * SIDE_SIZE)));
      raw.push(r); sides.push(buildSide(r)); headers.push(r.slice(1, 57));
    }
    return { fds: true, mapper: 20, sides, raw, headers, prg: new Uint8Array(0), chr: null, chrRamSize: 0x2000, prgRamSize: 0x8000, mirroring: 'H', fourScreen: false, battery: false, nes2: false, submapper: 0, trainer: false };
  }

  function describe(rom) {
    const h = rom.headers[0] || new Uint8Array(56);
    const name = String.fromCharCode(h[0x0F], h[0x10], h[0x11]).replace(/[^\x20-\x7E]/g, '?');
    return `FDS ${rom.sides.length} 面, ${name}, mirror ${rom.mirroring}`;
  }

  class FdsMapper extends Emu.NesMappers.Mapper {
    constructor(rom, bios) {
      if (!bios || bios.length < 0x2000) throw new Error('FDS BIOS (disksys.rom、8K) が必要です');
      super(rom);
      this.bios = bios instanceof Uint8Array ? bios.subarray(bios.length - 0x2000) : new Uint8Array(bios).subarray(bios.length - 0x2000);
      this.ram = new Uint8Array(0x8000);
      this.audio = Emu.FDSAudio ? new Emu.FDSAudio() : null;
      this.extBits = 0x04;
      this.sides = rom.sides;
      this.diskNumber = rom.sides.length ? 0 : NO_DISK;
      // タイマ
      this.irqReload = 0; this.irqCounter = 0; this.irqEnable = false; this.irqRepeat = false; this.timerIrq = false;
      this.diskIoOn = true; this.soundRegEnabled = true;
      // ドライブ
      this.writeLatch = 0; this.readLatch = 0; this.extCon = 0;
      this.motorOn = false; this.xferReset = false; this.readMode = false; this.crcControl = false; this.diskReady = false; this.diskIrqEnabled = false;
      this.headAtEnd = false; this.scanning = false; this.pastGap = true; this.byteReady = false; this.diskIrq = false;
      this.diskPosition = 0; this.delay = 0; this.crcAcc = 0; this.prevCrcControl = false;
      this.audioShadow = new Int16Array(0xA0).fill(-1); // $4000-$409F の影($4023, $4040-$409E)
    }
    // ── 録音 ──
    audioAddr(addr) { return (addr === 0x4023 || (addr >= 0x4040 && addr <= 0x409E)) ? addr : -1; }
    audioImage() {
      const out = [], sh = this.audioShadow;
      let any = false;
      for (let a = 0x4040; a <= 0x409E; a++) if (sh[a - 0x4000] >= 0) { any = true; break; }
      if (!any) return out;
      out.push({ addr: 0x4023, value: sh[0x23] >= 0 ? sh[0x23] : 0x83 });
      out.push({ addr: 0x4089, value: 0x80 }); // 波形 RAM 書き込み許可
      for (let a = 0x4040; a <= 0x407F; a++) if (sh[a - 0x4000] >= 0) out.push({ addr: a, value: sh[a - 0x4000] });
      for (let a = 0x4080; a <= 0x408A; a++) if (a !== 0x4088 && sh[a - 0x4000] >= 0) out.push({ addr: a, value: sh[a - 0x4000] }); // $4088(変調 FIFO)は復元できない。$4089 は本来の値で書き戻す
      return out;
    }
    // ── ディスク ──
    get diskCount() { return this.sides.length; }
    insertDisk(n) { if (this.diskNumber === NO_DISK && this.sides.length) this.diskNumber = ((n % this.sides.length) + this.sides.length) % this.sides.length; }
    ejectDisk() { this.diskNumber = NO_DISK; }
    // ── CPU ──
    cpuRead(addr) {
      if (addr >= 0xE000) return this.bios[addr - 0xE000];
      if (addr >= 0x6000) return this.ram[addr - 0x6000];
      switch (addr) {
        case 0x4030: {
          let v = 0; // open bus のビット(2,5)は本体が足す
          if (this.timerIrq) v |= 0x01;
          if (this.byteReady) v |= 0x02;
          if (this.ntMap[1] === 0) v |= 0x08; // 水平ミラー(ntMap が [0,0,1,1])
          this.byteReady = false; this.timerIrq = false; this.diskIrq = false;
          return v;
        }
        case 0x4031: this.byteReady = false; this.diskIrq = false; return this.readLatch;
        case 0x4032: {
          let v = 0;
          if (this.diskNumber === NO_DISK) v |= 0x07;
          else if (!this.scanning) v |= 0x02;
          return v;
        }
        case 0x4033: return this.extCon;
        case 0x4090: case 0x4092: return this.audio ? this.audio.readRegister(addr) : 0;
      }
      return -1;
    }
    cpuWrite(addr, v) {
      if (addr >= 0xE000) return;
      if (addr >= 0x6000) { this.ram[addr - 0x6000] = v; return; }
      if (addr >= 0x4040) {
        if (addr <= 0x409E) this.audioShadow[addr - 0x4000] = v;
        if (this.soundRegEnabled && this.audio) this.audio.writeRegister(addr, v);
        return;
      }
      if (!this.diskIoOn && addr >= 0x4024 && addr <= 0x4026) return;
      switch (addr) {
        case 0x4020: this.irqReload = (this.irqReload & 0xFF00) | v; break;
        case 0x4021: this.irqReload = (this.irqReload & 0x00FF) | (v << 8); break;
        case 0x4022:
          this.irqRepeat = (v & 1) !== 0;
          this.irqEnable = (v & 2) !== 0 && this.diskIoOn;
          if (this.irqEnable) this.irqCounter = this.irqReload; else this.timerIrq = false;
          break;
        case 0x4023:
          this.audioShadow[0x23] = v;
          this.diskIoOn = (v & 1) !== 0; this.soundRegEnabled = (v & 2) !== 0;
          if (!this.diskIoOn) { this.irqEnable = false; this.timerIrq = false; this.diskIrq = false; }
          if (this.audio) this.audio.writeRegister(0x4023, v);
          break;
        case 0x4024: this.writeLatch = v; this.byteReady = false; this.diskIrq = false; break;
        case 0x4025:
          this.motorOn = (v & 0x01) !== 0; this.xferReset = (v & 0x02) !== 0; this.readMode = (v & 0x04) !== 0;
          this.setMirroring((v & 0x08) ? 'H' : 'V');
          this.crcControl = (v & 0x10) !== 0; this.diskReady = (v & 0x40) !== 0; this.diskIrqEnabled = (v & 0x80) !== 0;
          this.diskIrq = false;
          break;
        case 0x4026: this.extCon = v; break;
      }
    }
    irqPending() { return this.timerIrq || this.diskIrq; }
    cpuClock(cycles) {
      for (let c = 0; c < cycles; c++) {
        if (this.irqEnable) {
          if (this.irqCounter === 0) { this.timerIrq = true; this.irqCounter = this.irqReload; if (!this.irqRepeat) this.irqEnable = false; }
          else this.irqCounter--;
        }
        this._driveClock();
      }
    }
    _crc(value) {
      let acc = this.crcAcc;
      for (let n = 0x01; n <= 0x80; n <<= 1) {
        const carry = acc & 1;
        acc >>= 1;
        if (carry) acc ^= 0x8408;
        if (value & n) acc ^= 0x8000;
      }
      this.crcAcc = acc;
    }
    _driveClock() {
      if (this.diskNumber === NO_DISK || !this.motorOn) { this.headAtEnd = true; this.scanning = false; return; }
      if (this.xferReset && !this.scanning) return;
      if (this.headAtEnd) { this.delay = 50000; this.headAtEnd = false; this.diskPosition = 0; this.pastGap = false; return; }
      if (this.delay > 0) { this.delay--; return; }
      this.scanning = true;
      const side = this.sides[this.diskNumber];
      let irqOnByte = this.diskIrqEnabled;
      let data = 0;
      if (this.readMode) {
        data = side[this.diskPosition];
        if (!this.prevCrcControl) this._crc(data);
        if (!this.diskReady) { this.pastGap = false; this.crcAcc = 0; }
        else if (data && !this.pastGap) { this.pastGap = true; irqOnByte = false; }
        if (this.pastGap) { this.byteReady = true; this.readLatch = data; if (irqOnByte) this.diskIrq = true; }
      } else {
        if (!this.crcControl) { this.byteReady = true; data = this.writeLatch; if (irqOnByte) this.diskIrq = true; }
        if (!this.diskReady) { data = 0; this.crcAcc = 0; }
        if (!this.crcControl) this._crc(data);
        else { data = this.crcAcc & 0xFF; this.crcAcc >>= 8; }
        side[this.diskPosition] = data;
        this.diskDirty = true; // ディスクへの書き込み(セーブの対象。NesConsole.batteryDirty が見る)
        this.pastGap = false;
      }
      this.prevCrcControl = this.crcControl;
      this.diskPosition++;
      if (this.diskPosition >= side.length) { this.motorOn = false; if (this.diskIrqEnabled) this.diskIrq = true; }
      else this.delay = 149;
    }
  }

  Emu.FdsDisk = { isFds, isFdsBios, parse, buildSide, describe, Mapper: FdsMapper, SIDE_SIZE };
})(typeof window !== 'undefined' ? window : globalThis);
