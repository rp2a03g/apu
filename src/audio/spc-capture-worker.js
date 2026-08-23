/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-08-22 23:25:42
 *
 * regsOnly capture worker bundle (spcCapture). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.spcCapture is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.spcCaptureBuiltAt = '2026-08-22 23:25:42';
  MML.WorkerBundles.spcCapture = function () {
/*
 * SPC (SNES-SPC700 Sound File) v0.30 ヘッダ / ID666 タグ解析
 * MML.SPC.parseHeader(bytes) → { magicOk, pc, a, x, y, psw, sp, id666, ... }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const SPC = MML.SPC = MML.SPC || {};

  // ファイル識別子 (先頭33バイト)
  const MAGIC = 'SNES-SPC700 Sound File Data v0.30';

  function readAsciiZ(bytes, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readLE16(bytes, off) {
    return bytes[off] | (bytes[off + 1] << 8);
  }

  function readLE32(bytes, off) {
    return (bytes[off] | (bytes[off+1]<<8) | (bytes[off+2]<<16) | (bytes[off+3]<<24)) >>> 0;
  }

  /**
   * SPC ファイルを解析してヘッダ情報を返す
   * @param {Uint8Array} bytes - SPCファイル全体
   * @returns {object}
   */
  SPC.parseHeader = function (bytes) {
    if (bytes.length < 0x100) throw new Error('SPCファイルが短すぎます（最低256バイト必要）');

    // マジック確認
    let magic = '';
    for (let i = 0; i < 33; i++) magic += String.fromCharCode(bytes[i]);
    const magicOk = magic === MAGIC && bytes[0x21] === 0x1A && bytes[0x22] === 0x1A;

    // ID666 タグ有無
    const hasId666 = bytes[0x23] === 0x1A;
    const minorVer = bytes[0x24];

    // SPC700 レジスタ初期値 (0x25-0x2D)
    const pc  = readLE16(bytes, 0x25);
    const a   = bytes[0x27];
    const x   = bytes[0x28];
    const y   = bytes[0x29];
    const psw = bytes[0x2A];
    const sp  = bytes[0x2B];

    // ID666 タグ (0x2E-0xFF, 210 bytes)
    let id666 = null;
    if (hasId666 && bytes.length >= 0x100) {
      id666 = {
        songTitle:  readAsciiZ(bytes, 0x2E, 32),
        gameTitle:  readAsciiZ(bytes, 0x4E, 32),
        dumperName: readAsciiZ(bytes, 0x6E, 16),
        comments:   readAsciiZ(bytes, 0x7E, 32),
        dumpDate:   readAsciiZ(bytes, 0x9E, 11),
        playSeconds: _parseDecStr(bytes, 0xA9, 3),
        fadeMs:      _parseDecStr(bytes, 0xAC, 5),
        artistName: readAsciiZ(bytes, 0xB1, 32),
        defaultChannelEnable: bytes[0xD1],
        emulatorUsed: bytes[0xD2],
      };
    }

    // RAM / DSP レジスタ / XRAM 存在確認
    const hasRam    = bytes.length >= 0x10100;
    const hasDspReg = bytes.length >= 0x10180;
    const hasXram   = bytes.length >= 0x101C0;

    return {
      magicOk,
      hasId666,
      minorVer,
      pc, a, x, y, psw, sp,
      id666,
      hasRam,
      hasDspReg,
      hasXram,
    };
  };

  /** 数字文字列デコード (ASCII 数字、スペース含む) */
  function _parseDecStr(bytes, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[off + i];
      if (c >= 0x30 && c <= 0x39) s += String.fromCharCode(c);
    }
    return s ? parseInt(s, 10) : 0;
  }

  /**
   * SPC ファイルから64KBのRAMダンプを取得
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} 65536バイト
   */
  SPC.getRam = function (bytes) {
    if (bytes.length < 0x10100) throw new Error('RAM領域がありません');
    return bytes.slice(0x100, 0x10100);
  };

  /**
   * SPC ファイルから128バイトのDSPレジスタダンプを取得
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} 128バイト
   */
  SPC.getDspRegs = function (bytes) {
    if (bytes.length < 0x10180) throw new Error('DSPレジスタ領域がありません');
    return bytes.slice(0x10100, 0x10180);
  };

  /**
   * SPC ファイルから64バイトのXRAMを取得
   * @param {Uint8Array} bytes
   * @returns {Uint8Array|null}
   */
  SPC.getXram = function (bytes) {
    if (bytes.length < 0x101C0) return null;
    return bytes.slice(0x10180, 0x101C0);
  };

})(globalThis);

/*
 * SPC700 CPU エミュレータ
 * Sony 製 8bit CPU（SFC/SNES APU 内蔵）
 *
 * MML.Emu.SPC700
 *   constructor(bus)
 *   reset()
 *   step() → cycles
 *   runCycles(n)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // IPL ROM (64 bytes, $FFC0-$FFFF)
  const IPL_ROM = new Uint8Array([
    0xCD,0xEF,0xBD,0xE8,0x00,0xC6,0x1D,0xD0,0xFC,0x8F,0xAA,0xF4,0x8F,0xBB,0xF5,0x78,
    0xCC,0xF4,0xD0,0xFB,0x2F,0x19,0xEB,0xF4,0xD0,0xFC,0x7E,0xF4,0xD0,0x0B,0xE4,0xF5,
    0xCB,0xF4,0xD7,0x00,0xFC,0xD0,0xF3,0xAB,0x01,0x10,0xEF,0x7E,0xF4,0x10,0xEB,0xBA,
    0xF6,0xDA,0x00,0xBA,0xF4,0xC4,0xF4,0xDD,0x5D,0xD0,0xDB,0x1F,0x00,0x00,0xC0,0xFF,
  ]);

  class SPC700 {
    constructor(bus) {
      this.bus = bus;
      this.A = 0; this.X = 0; this.Y = 0;
      this.SP = 0xFF; this.PC = 0xFFC0; this.PSW = 0;
      this.halted = false; // STOP/SLEEP で真になる
      // PSW bits: N=7 V=6 P=5 B=4 H=3 I=2 Z=1 C=0
    }

    reset() {
      this.A = 0; this.X = 0; this.Y = 0;
      this.SP = 0xFF; this.PSW = 0;
      this.PC = this.bus.read(0xFFFE) | (this.bus.read(0xFFFF) << 8);
    }

    // ── バス ──────────────────────────────────────────────────────
    _r(addr) { return this.bus.read(addr & 0xFFFF); }
    _w(addr, val) { this.bus.write(addr & 0xFFFF, val & 0xFF); }

    // ── スタック ──────────────────────────────────────────────────
    _push(v) { this._w(0x0100 | this.SP, v & 0xFF); this.SP = (this.SP - 1) & 0xFF; }
    _pop()   { this.SP = (this.SP + 1) & 0xFF; return this._r(0x0100 | this.SP); }

    // ── フラグ ────────────────────────────────────────────────────
    _getC() { return this.PSW & 0x01; }
    _dpBase() { return (this.PSW & 0x20) ? 0x0100 : 0x0000; }

    _setNZ(v) {
      const b = v & 0xFF;
      this.PSW = (this.PSW & ~0x82) | (b & 0x80) | (b === 0 ? 0x02 : 0);
      return b;
    }
    _setC(v)  { this.PSW = (this.PSW & ~0x01) | (v ? 0x01 : 0); }
    _setV(v)  { this.PSW = (this.PSW & ~0x40) | (v ? 0x40 : 0); }
    _setH(v)  { this.PSW = (this.PSW & ~0x08) | (v ? 0x08 : 0); }

    // ── アドレッシング ────────────────────────────────────────────
    _imm()   { return this._r(this.PC++); }
    _dpAddr(){ return (this._dpBase() + this._r(this.PC++)) & 0xFFFF; }
    _dpXAddr(){ const b=this._dpBase(); return b | ((this._r(this.PC++) + this.X) & 0xFF); }
    _dpYAddr(){ const b=this._dpBase(); return b | ((this._r(this.PC++) + this.Y) & 0xFF); }
    // ダイレクトページ内 16bit アクセスの上位バイトアドレス。dp+1 はページ内で
    // ラップする（$xxFF の次は $xx00）。実機準拠。MOVW/ADDW/(dp)+Y 等で使用。
    _dpHi(a){ return (a & 0xFF00) | ((a + 1) & 0xFF); }
    _absAddr(){
      const lo = this._r(this.PC++); const hi = this._r(this.PC++);
      return (hi << 8) | lo;
    }
    _absXAddr(){ return (this._absAddr() + this.X) & 0xFFFF; }
    _absYAddr(){ return (this._absAddr() + this.Y) & 0xFFFF; }
    _dpIndX() { // (dp+X) → 16bit address, dp+X wraps within DP page
      const base = this._dpBase();
      const off  = (this._r(this.PC++) + this.X) & 0xFF;
      const ptr0 = base | off;
      const ptr1 = base | ((off + 1) & 0xFF);
      return this._r(ptr0) | (this._r(ptr1) << 8);
    }
    _dpIndY() { // (dp)+Y → 16bit address
      const base = this._dpBase();
      const dp   = (base + this._r(this.PC++)) & 0xFFFF;
      const ptr  = this._r(dp) | (this._r(this._dpHi(dp)) << 8);
      return (ptr + this.Y) & 0xFFFF;
    }
    // mem.bit 形式: 2バイト読み取り → { addr, bit }
    _memBit() {
      const lo = this._r(this.PC++); const hi = this._r(this.PC++);
      const v  = (hi << 8) | lo;
      return { addr: v & 0x1FFF, bit: (v >> 13) & 7 };
    }

    // ── ALU ───────────────────────────────────────────────────────
    _adc(a, b) {
      const c = this._getC();
      const r = a + b + c;
      const h = (a & 0xF) + (b & 0xF) + c;
      this.PSW = (this.PSW & ~0xCB)
        | (r & 0x80)
        | (((a ^ r) & (b ^ r) & 0x80) ? 0x40 : 0)
        | (h > 0xF ? 0x08 : 0)
        | ((r & 0xFF) === 0 ? 0x02 : 0)
        | (r > 0xFF ? 0x01 : 0);
      return r & 0xFF;
    }
    _sbc(a, b) {
      const c = this._getC();
      const r = a - b - (1 - c);
      const h = (a & 0xF) - (b & 0xF) - (1 - c);
      this.PSW = (this.PSW & ~0xCB)
        | (r & 0x80)
        | (((a ^ b) & (a ^ r) & 0x80) ? 0x40 : 0)
        | (h >= 0 ? 0x08 : 0)
        | ((r & 0xFF) === 0 ? 0x02 : 0)
        | (r >= 0 ? 0x01 : 0);
      return r & 0xFF;
    }
    _cmp(a, b) {
      const r = a - b;
      this.PSW = (this.PSW & ~0x83) | (r & 0x80) | ((r & 0xFF) === 0 ? 0x02 : 0) | (r >= 0 ? 0x01 : 0);
    }
    _asl(v) {
      const c = (v >> 7) & 1, r = (v << 1) & 0xFF;
      this.PSW = (this.PSW & ~0x83) | (r & 0x80) | (r === 0 ? 0x02 : 0) | c;
      return r;
    }
    _lsr(v) {
      const c = v & 1, r = (v >> 1) & 0xFF;
      this.PSW = (this.PSW & ~0x83) | (r & 0x80) | (r === 0 ? 0x02 : 0) | c;
      return r;
    }
    _rol(v) {
      const cin = this._getC(), cout = (v >> 7) & 1;
      const r = ((v << 1) | cin) & 0xFF;
      this.PSW = (this.PSW & ~0x83) | (r & 0x80) | (r === 0 ? 0x02 : 0) | cout;
      return r;
    }
    _ror(v) {
      const cin = this._getC(), cout = v & 1;
      const r = ((v >> 1) | (cin << 7)) & 0xFF;
      this.PSW = (this.PSW & ~0x83) | (r & 0x80) | (r === 0 ? 0x02 : 0) | cout;
      return r;
    }

    // ── 分岐ヘルパー ──────────────────────────────────────────────
    // 条件分岐は成立時に +2 サイクル。取った extra を返す（呼び出し側で加算）。
    _branch(cond) {
      const off = this._r(this.PC++);
      if (cond) { this.PC = (this.PC + ((off & 0x80) ? off - 256 : off)) & 0xFFFF; return 2; }
      return 0;
    }

    // ── CALL 系 ───────────────────────────────────────────────────
    _call(addr) {
      this._push((this.PC >> 8) & 0xFF);
      this._push(this.PC & 0xFF);
      this.PC = addr;
    }
    _tcall(n) {
      const vec = 0xFFDE - n * 2;
      this._call(this._r(vec) | (this._r(vec + 1) << 8));
    }

    // ── ビット操作ヘルパー ────────────────────────────────────────
    _set1(addr, bit) { this._w(addr, this._r(addr) | (1 << bit)); }
    _clr1(addr, bit) { this._w(addr, this._r(addr) & ~(1 << bit)); }
    _bbs(addr, bit)  {
      const d = this._r(addr), off = this._r(this.PC++);
      if ((d >> bit) & 1) { this.PC = (this.PC + ((off & 0x80) ? off - 256 : off)) & 0xFFFF; return 2; }
      return 0;
    }
    _bbc(addr, bit)  {
      const d = this._r(addr), off = this._r(this.PC++);
      if (!((d >> bit) & 1)) { this.PC = (this.PC + ((off & 0x80) ? off - 256 : off)) & 0xFFFF; return 2; }
      return 0;
    }

    // ── 1命令実行、消費サイクル数を返す ──────────────────────────
    step() {
      const cycles = this._step1();
      this.PC &= 0xFFFF; // PC が $FFFF で命令フェッチすると $10000 に溢れるためラップ
      return cycles;
    }
    _step1() {
      const op = this._r(this.PC++);
      switch (op) {

        // ── NOP / 特殊 ────────────────────────────────────────────
        case 0x00: /* NOP  */ return 2;
        case 0xEF: /* SLEEP */ this.halted = true; return 3;
        case 0xFF: /* STOP  */ this.halted = true; return 3;

        // ── TCALL 0-15 ───────────────────────────────────────────
        case 0x01: this._tcall(0);  return 8;
        case 0x11: this._tcall(1);  return 8;
        case 0x21: this._tcall(2);  return 8;
        case 0x31: this._tcall(3);  return 8;
        case 0x41: this._tcall(4);  return 8;
        case 0x51: this._tcall(5);  return 8;
        case 0x61: this._tcall(6);  return 8;
        case 0x71: this._tcall(7);  return 8;
        case 0x81: this._tcall(8);  return 8;
        case 0x91: this._tcall(9);  return 8;
        case 0xA1: this._tcall(10); return 8;
        case 0xB1: this._tcall(11); return 8;
        case 0xC1: this._tcall(12); return 8;
        case 0xD1: this._tcall(13); return 8;
        case 0xE1: this._tcall(14); return 8;
        case 0xF1: this._tcall(15); return 8;

        // ── SET1 dp.n / CLR1 dp.n ────────────────────────────────
        case 0x02: this._set1(this._dpAddr(),0); return 4;
        case 0x22: this._set1(this._dpAddr(),1); return 4;
        case 0x42: this._set1(this._dpAddr(),2); return 4;
        case 0x62: this._set1(this._dpAddr(),3); return 4;
        case 0x82: this._set1(this._dpAddr(),4); return 4;
        case 0xA2: this._set1(this._dpAddr(),5); return 4;
        case 0xC2: this._set1(this._dpAddr(),6); return 4;
        case 0xE2: this._set1(this._dpAddr(),7); return 4;
        case 0x12: this._clr1(this._dpAddr(),0); return 4;
        case 0x32: this._clr1(this._dpAddr(),1); return 4;
        case 0x52: this._clr1(this._dpAddr(),2); return 4;
        case 0x72: this._clr1(this._dpAddr(),3); return 4;
        case 0x92: this._clr1(this._dpAddr(),4); return 4;
        case 0xB2: this._clr1(this._dpAddr(),5); return 4;
        case 0xD2: this._clr1(this._dpAddr(),6); return 4;
        case 0xF2: this._clr1(this._dpAddr(),7); return 4;

        // ── BBS / BBC ────────────────────────────────────────────
        case 0x03: { const a=this._dpAddr(); return 5 + this._bbs(a,0); }
        case 0x23: { const a=this._dpAddr(); return 5 + this._bbs(a,1); }
        case 0x43: { const a=this._dpAddr(); return 5 + this._bbs(a,2); }
        case 0x63: { const a=this._dpAddr(); return 5 + this._bbs(a,3); }
        case 0x83: { const a=this._dpAddr(); return 5 + this._bbs(a,4); }
        case 0xA3: { const a=this._dpAddr(); return 5 + this._bbs(a,5); }
        case 0xC3: { const a=this._dpAddr(); return 5 + this._bbs(a,6); }
        case 0xE3: { const a=this._dpAddr(); return 5 + this._bbs(a,7); }
        case 0x13: { const a=this._dpAddr(); return 5 + this._bbc(a,0); }
        case 0x33: { const a=this._dpAddr(); return 5 + this._bbc(a,1); }
        case 0x53: { const a=this._dpAddr(); return 5 + this._bbc(a,2); }
        case 0x73: { const a=this._dpAddr(); return 5 + this._bbc(a,3); }
        case 0x93: { const a=this._dpAddr(); return 5 + this._bbc(a,4); }
        case 0xB3: { const a=this._dpAddr(); return 5 + this._bbc(a,5); }
        case 0xD3: { const a=this._dpAddr(); return 5 + this._bbc(a,6); }
        case 0xF3: { const a=this._dpAddr(); return 5 + this._bbc(a,7); }

        // ── OR A, ... ─────────────────────────────────────────────
        case 0x04: this.A=this._setNZ(this.A|this._r(this._dpAddr())); return 3;
        case 0x05: this.A=this._setNZ(this.A|this._r(this._absAddr())); return 4;
        case 0x06: this.A=this._setNZ(this.A|this._r((this._dpBase()+(this.X&0xFF))&0xFFFF)); return 3;
        case 0x07: this.A=this._setNZ(this.A|this._r(this._dpIndX())); return 6;
        case 0x08: this.A=this._setNZ(this.A|this._imm()); return 2;
        case 0x09: { const s=this._dpAddr(), d=this._dpAddr(); this._w(d,this._setNZ(this._r(d)|this._r(s))); return 6; }
        case 0x14: this.A=this._setNZ(this.A|this._r(this._dpXAddr())); return 4;
        case 0x15: this.A=this._setNZ(this.A|this._r(this._absXAddr())); return 5;
        case 0x16: this.A=this._setNZ(this.A|this._r(this._absYAddr())); return 5;
        case 0x17: this.A=this._setNZ(this.A|this._r(this._dpIndY())); return 6;
        // encoding: [18][imm][dp]  imm先読み
        case 0x18: { const imm=this._imm(), d=this._dpAddr(); this._w(d,this._setNZ(this._r(d)|imm)); return 5; }
        case 0x19: this._w((this._dpBase()+(this.X&0xFF))&0xFFFF,
                     this._setNZ(this._r((this._dpBase()+(this.X&0xFF))&0xFFFF)|
                                 this._r((this._dpBase()+(this.Y&0xFF))&0xFFFF))); return 5;

        // ── AND A, ... ────────────────────────────────────────────
        case 0x24: this.A=this._setNZ(this.A&this._r(this._dpAddr())); return 3;
        case 0x25: this.A=this._setNZ(this.A&this._r(this._absAddr())); return 4;
        case 0x26: this.A=this._setNZ(this.A&this._r((this._dpBase()+this.X)&0xFFFF)); return 3;
        case 0x27: this.A=this._setNZ(this.A&this._r(this._dpIndX())); return 6;
        case 0x28: this.A=this._setNZ(this.A&this._imm()); return 2;
        case 0x29: { const s=this._dpAddr(), d=this._dpAddr(); this._w(d,this._setNZ(this._r(d)&this._r(s))); return 6; }
        case 0x34: this.A=this._setNZ(this.A&this._r(this._dpXAddr())); return 4;
        case 0x35: this.A=this._setNZ(this.A&this._r(this._absXAddr())); return 5;
        case 0x36: this.A=this._setNZ(this.A&this._r(this._absYAddr())); return 5;
        case 0x37: this.A=this._setNZ(this.A&this._r(this._dpIndY())); return 6;
        case 0x38: { const imm=this._imm(), d=this._dpAddr(); this._w(d,this._setNZ(this._r(d)&imm)); return 5; }
        case 0x39: { const xA=(this._dpBase()+this.X)&0xFFFF, yA=(this._dpBase()+this.Y)&0xFFFF;
                     this._w(xA,this._setNZ(this._r(xA)&this._r(yA))); return 5; }

        // ── EOR A, ... ────────────────────────────────────────────
        case 0x44: this.A=this._setNZ(this.A^this._r(this._dpAddr())); return 3;
        case 0x45: this.A=this._setNZ(this.A^this._r(this._absAddr())); return 4;
        case 0x46: this.A=this._setNZ(this.A^this._r((this._dpBase()+this.X)&0xFFFF)); return 3;
        case 0x47: this.A=this._setNZ(this.A^this._r(this._dpIndX())); return 6;
        case 0x48: this.A=this._setNZ(this.A^this._imm()); return 2;
        case 0x49: { const s=this._dpAddr(), d=this._dpAddr(); this._w(d,this._setNZ(this._r(d)^this._r(s))); return 6; }
        case 0x54: this.A=this._setNZ(this.A^this._r(this._dpXAddr())); return 4;
        case 0x55: this.A=this._setNZ(this.A^this._r(this._absXAddr())); return 5;
        case 0x56: this.A=this._setNZ(this.A^this._r(this._absYAddr())); return 5;
        case 0x57: this.A=this._setNZ(this.A^this._r(this._dpIndY())); return 6;
        case 0x58: { const imm=this._imm(), d=this._dpAddr(); this._w(d,this._setNZ(this._r(d)^imm)); return 5; }
        case 0x59: { const xA=(this._dpBase()+this.X)&0xFFFF, yA=(this._dpBase()+this.Y)&0xFFFF;
                     this._w(xA,this._setNZ(this._r(xA)^this._r(yA))); return 5; }

        // ── CMP A, ... ────────────────────────────────────────────
        case 0x64: this._cmp(this.A,this._r(this._dpAddr())); return 3;
        case 0x65: this._cmp(this.A,this._r(this._absAddr())); return 4;
        case 0x66: this._cmp(this.A,this._r((this._dpBase()+this.X)&0xFFFF)); return 3;
        case 0x67: this._cmp(this.A,this._r(this._dpIndX())); return 6;
        case 0x68: this._cmp(this.A,this._imm()); return 2;
        case 0x69: { const s=this._dpAddr(), d=this._dpAddr(); this._cmp(this._r(d),this._r(s)); return 6; }
        case 0x74: this._cmp(this.A,this._r(this._dpXAddr())); return 4;
        case 0x75: this._cmp(this.A,this._r(this._absXAddr())); return 5;
        case 0x76: this._cmp(this.A,this._r(this._absYAddr())); return 5;
        case 0x77: this._cmp(this.A,this._r(this._dpIndY())); return 6;
        case 0x78: { const imm=this._imm(), d=this._dpAddr(); this._cmp(this._r(d),imm); return 5; }
        case 0x79: this._cmp(this._r((this._dpBase()+this.X)&0xFFFF),
                             this._r((this._dpBase()+this.Y)&0xFFFF)); return 5;

        // ── ADC A, ... ────────────────────────────────────────────
        case 0x84: this.A=this._adc(this.A,this._r(this._dpAddr())); return 3;
        case 0x85: this.A=this._adc(this.A,this._r(this._absAddr())); return 4;
        case 0x86: this.A=this._adc(this.A,this._r((this._dpBase()+this.X)&0xFFFF)); return 3;
        case 0x87: this.A=this._adc(this.A,this._r(this._dpIndX())); return 6;
        case 0x88: this.A=this._adc(this.A,this._imm()); return 2;
        case 0x89: { const s=this._dpAddr(), d=this._dpAddr(); this._w(d,this._adc(this._r(d),this._r(s))); return 6; }
        case 0x94: this.A=this._adc(this.A,this._r(this._dpXAddr())); return 4;
        case 0x95: this.A=this._adc(this.A,this._r(this._absXAddr())); return 5;
        case 0x96: this.A=this._adc(this.A,this._r(this._absYAddr())); return 5;
        case 0x97: this.A=this._adc(this.A,this._r(this._dpIndY())); return 6;
        case 0x98: { const imm=this._imm(), d=this._dpAddr(); this._w(d,this._adc(this._r(d),imm)); return 5; }
        case 0x99: { const xA=(this._dpBase()+this.X)&0xFFFF, yA=(this._dpBase()+this.Y)&0xFFFF;
                     this._w(xA,this._adc(this._r(xA),this._r(yA))); return 5; }

        // ── SBC A, ... ────────────────────────────────────────────
        case 0xA4: this.A=this._sbc(this.A,this._r(this._dpAddr())); return 3;
        case 0xA5: this.A=this._sbc(this.A,this._r(this._absAddr())); return 4;
        case 0xA6: this.A=this._sbc(this.A,this._r((this._dpBase()+this.X)&0xFFFF)); return 3;
        case 0xA7: this.A=this._sbc(this.A,this._r(this._dpIndX())); return 6;
        case 0xA8: this.A=this._sbc(this.A,this._imm()); return 2;
        case 0xA9: { const s=this._dpAddr(), d=this._dpAddr(); this._w(d,this._sbc(this._r(d),this._r(s))); return 6; }
        case 0xB4: this.A=this._sbc(this.A,this._r(this._dpXAddr())); return 4;
        case 0xB5: this.A=this._sbc(this.A,this._r(this._absXAddr())); return 5;
        case 0xB6: this.A=this._sbc(this.A,this._r(this._absYAddr())); return 5;
        case 0xB7: this.A=this._sbc(this.A,this._r(this._dpIndY())); return 6;
        case 0xB8: { const imm=this._imm(), d=this._dpAddr(); this._w(d,this._sbc(this._r(d),imm)); return 5; }
        case 0xB9: { const xA=(this._dpBase()+this.X)&0xFFFF, yA=(this._dpBase()+this.Y)&0xFFFF;
                     this._w(xA,this._sbc(this._r(xA),this._r(yA))); return 5; }

        // ── ASL ──────────────────────────────────────────────────
        case 0x0B: { const a=this._dpAddr(); this._w(a,this._asl(this._r(a))); return 4; }
        case 0x0C: { const a=this._absAddr(); this._w(a,this._asl(this._r(a))); return 5; }
        case 0x1B: { const a=this._dpXAddr(); this._w(a,this._asl(this._r(a))); return 5; }
        case 0x1C: this.A=this._asl(this.A); return 2;

        // ── LSR ──────────────────────────────────────────────────
        case 0x4B: { const a=this._dpAddr(); this._w(a,this._lsr(this._r(a))); return 4; }
        case 0x4C: { const a=this._absAddr(); this._w(a,this._lsr(this._r(a))); return 5; }
        case 0x5B: { const a=this._dpXAddr(); this._w(a,this._lsr(this._r(a))); return 5; }
        case 0x5C: this.A=this._lsr(this.A); return 2;

        // ── ROL ──────────────────────────────────────────────────
        case 0x2B: { const a=this._dpAddr(); this._w(a,this._rol(this._r(a))); return 4; }
        case 0x2C: { const a=this._absAddr(); this._w(a,this._rol(this._r(a))); return 5; }
        case 0x3B: { const a=this._dpXAddr(); this._w(a,this._rol(this._r(a))); return 5; }
        case 0x3C: this.A=this._rol(this.A); return 2;

        // ── ROR ──────────────────────────────────────────────────
        case 0x6B: { const a=this._dpAddr(); this._w(a,this._ror(this._r(a))); return 4; }
        case 0x6C: { const a=this._absAddr(); this._w(a,this._ror(this._r(a))); return 5; }
        case 0x7B: { const a=this._dpXAddr(); this._w(a,this._ror(this._r(a))); return 5; }
        case 0x7C: this.A=this._ror(this.A); return 2;

        // ── INC ──────────────────────────────────────────────────
        case 0xAB: { const a=this._dpAddr(); this._w(a,this._setNZ(this._r(a)+1)); return 4; }
        case 0xAC: { const a=this._absAddr(); this._w(a,this._setNZ(this._r(a)+1)); return 5; }
        case 0xBB: { const a=this._dpXAddr(); this._w(a,this._setNZ(this._r(a)+1)); return 5; }
        case 0xBC: this.A=this._setNZ(this.A+1); return 2;
        case 0x3D: this.X=this._setNZ(this.X+1); return 2;
        case 0xFC: this.Y=this._setNZ(this.Y+1); return 2;

        // ── DEC ──────────────────────────────────────────────────
        case 0x8B: { const a=this._dpAddr(); this._w(a,this._setNZ(this._r(a)-1)); return 4; }
        case 0x8C: { const a=this._absAddr(); this._w(a,this._setNZ(this._r(a)-1)); return 5; }
        case 0x9B: { const a=this._dpXAddr(); this._w(a,this._setNZ(this._r(a)-1)); return 5; }
        case 0x9C: this.A=this._setNZ(this.A-1); return 2;
        case 0x1D: this.X=this._setNZ(this.X-1); return 2;
        case 0xDC: this.Y=this._setNZ(this.Y-1); return 2;

        // ── CMP X/Y ──────────────────────────────────────────────
        case 0xC8: this._cmp(this.X,this._imm()); return 2;
        case 0x3E: this._cmp(this.X,this._r(this._dpAddr())); return 3;
        case 0x1E: this._cmp(this.X,this._r(this._absAddr())); return 4;
        case 0xAD: this._cmp(this.Y,this._imm()); return 2;
        case 0x7E: this._cmp(this.Y,this._r(this._dpAddr())); return 3;
        case 0x5E: this._cmp(this.Y,this._r(this._absAddr())); return 4;

        // ── 分岐 ─────────────────────────────────────────────────
        case 0x10: return 2 + this._branch(!(this.PSW&0x80));  // BPL
        case 0x30: return 2 + this._branch(!!(this.PSW&0x80)); // BMI
        case 0x50: return 2 + this._branch(!(this.PSW&0x40));  // BVC
        case 0x70: return 2 + this._branch(!!(this.PSW&0x40)); // BVS
        case 0x90: return 2 + this._branch(!(this.PSW&0x01));  // BCC
        case 0xB0: return 2 + this._branch(!!(this.PSW&0x01)); // BCS
        case 0xD0: return 2 + this._branch(!(this.PSW&0x02));  // BNE
        case 0xF0: return 2 + this._branch(!!(this.PSW&0x02)); // BEQ
        case 0x2F: this._branch(true); return 4;               // BRA

        // ── CBNE ─────────────────────────────────────────────────
        // CBNE/DBNZ も分岐成立時 +2 サイクル
        case 0x2E: { const a=this._dpAddr(), d=this._r(a), off=this._r(this.PC++);
                     if(d!==this.A){ this.PC=(this.PC+((off&0x80)?off-256:off))&0xFFFF; return 7; } return 5; }
        case 0xDE: { const a=this._dpXAddr(), d=this._r(a), off=this._r(this.PC++);
                     if(d!==this.A){ this.PC=(this.PC+((off&0x80)?off-256:off))&0xFFFF; return 8; } return 6; }

        // ── DBNZ ─────────────────────────────────────────────────
        case 0x6E: { const a=this._dpAddr(), d=(this._r(a)-1)&0xFF; this._w(a,d);
                     const off=this._r(this.PC++);
                     if(d!==0){ this.PC=(this.PC+((off&0x80)?off-256:off))&0xFFFF; return 7; } return 5; }
        case 0xFE: { this.Y=(this.Y-1)&0xFF;
                     const off=this._r(this.PC++);
                     if(this.Y!==0){ this.PC=(this.PC+((off&0x80)?off-256:off))&0xFFFF; return 6; } return 4; }

        // ── CALL / RET ────────────────────────────────────────────
        case 0x3F: { const a=this._absAddr(); this._call(a); return 8; }
        case 0x6F: { const lo=this._pop(), hi=this._pop(); this.PC=(hi<<8)|lo; return 5; } // RET
        // RETI: BRK/割り込みがPCH→PCL→PSWの順でpushするので逆順でpop
        case 0x7F: { this.PSW=this._pop();
                     const lo=this._pop(), hi=this._pop(); this.PC=(hi<<8)|lo; return 6; } // RETI

        // ── PCALL ─────────────────────────────────────────────────
        case 0x4F: { const u=this._imm(); this._call(0xFF00|u); return 6; }

        // ── BRK ──────────────────────────────────────────────────
        case 0x0F: {
          this._push((this.PC>>8)&0xFF); this._push(this.PC&0xFF); this._push(this.PSW);
          this.PSW=(this.PSW|0x10)&~0x04; // B=1, I=0
          this.PC=this._r(0xFFDE)|(this._r(0xFFDF)<<8);
          return 8;
        }

        // ── JMP ──────────────────────────────────────────────────
        case 0x5F: this.PC=this._absAddr(); return 3;
        case 0x1F: { const a=this._absAddr(); this.PC=this._r((a+this.X)&0xFFFF)|(this._r((a+this.X+1)&0xFFFF)<<8); return 6; }

        // ── PUSH / POP ───────────────────────────────────────────
        case 0x2D: this._push(this.A); return 4;
        case 0x4D: this._push(this.X); return 4;
        case 0x6D: this._push(this.Y); return 4;
        case 0x0D: this._push(this.PSW); return 4;
        // POP A/X/Y は SPC700 ではフラグを一切変更しない（6502 の PLA と違う）。
        // 誤って N/Z を書き換えると "PUSH A; …; POP A; Bcc" のイディオムが壊れる。
        case 0xAE: this.A=this._pop(); return 4;
        case 0xCE: this.X=this._pop(); return 4;
        case 0xEE: this.Y=this._pop(); return 4;
        case 0x8E: this.PSW=this._pop(); return 4;

        // ── MOV A, ... ───────────────────────────────────────────
        case 0xE4: this.A=this._setNZ(this._r(this._dpAddr())); return 3;
        case 0xE5: this.A=this._setNZ(this._r(this._absAddr())); return 4;
        case 0xE6: this.A=this._setNZ(this._r((this._dpBase()+this.X)&0xFFFF)); return 3;
        case 0xE7: this.A=this._setNZ(this._r(this._dpIndX())); return 6;
        case 0xE8: this.A=this._setNZ(this._imm()); return 2;
        case 0xF4: this.A=this._setNZ(this._r(this._dpXAddr())); return 4;
        case 0xF5: this.A=this._setNZ(this._r(this._absXAddr())); return 5;
        case 0xF6: this.A=this._setNZ(this._r(this._absYAddr())); return 5;
        case 0xF7: this.A=this._setNZ(this._r(this._dpIndY())); return 6;
        case 0x7D: this.A=this._setNZ(this.X); return 2;        // MOV A, X
        case 0xDD: this.A=this._setNZ(this.Y); return 2;        // MOV A, Y
        case 0xBF: { this.A=this._setNZ(this._r((this._dpBase()+this.X)&0xFFFF)); // MOV A, (X)+
                     this.X=(this.X+1)&0xFF; return 4; }

        // ── MOV X, ... ───────────────────────────────────────────
        case 0xF8: this.X=this._setNZ(this._r(this._dpAddr())); return 3;
        case 0xE9: this.X=this._setNZ(this._r(this._absAddr())); return 4;
        case 0xF9: this.X=this._setNZ(this._r(this._dpYAddr())); return 4;
        case 0xCD: this.X=this._setNZ(this._imm()); return 2;
        case 0x5D: this.X=this._setNZ(this.A); return 2;        // MOV X, A
        case 0x9D: this.X=this._setNZ(this.SP); return 2;       // MOV X, SP

        // ── MOV Y, ... ───────────────────────────────────────────
        case 0xEB: this.Y=this._setNZ(this._r(this._dpAddr())); return 3;
        case 0xEC: this.Y=this._setNZ(this._r(this._absAddr())); return 4;
        case 0xFB: this.Y=this._setNZ(this._r(this._dpXAddr())); return 4;
        case 0x8D: this.Y=this._setNZ(this._imm()); return 2;
        case 0xFD: this.Y=this._setNZ(this.A); return 2;        // MOV Y, A

        // ── MOV mem, A ───────────────────────────────────────────
        case 0xC4: this._w(this._dpAddr(),this.A); return 4;
        case 0xC5: this._w(this._absAddr(),this.A); return 5;
        case 0xC6: this._w((this._dpBase()+this.X)&0xFFFF,this.A); return 4;
        case 0xC7: this._w(this._dpIndX(),this.A); return 7;
        case 0xD4: this._w(this._dpXAddr(),this.A); return 5;
        case 0xD5: this._w(this._absXAddr(),this.A); return 6;
        case 0xD6: this._w(this._absYAddr(),this.A); return 6;
        case 0xD7: this._w(this._dpIndY(),this.A); return 7;
        case 0xAF: { this._w((this._dpBase()+this.X)&0xFFFF,this.A); // MOV (X)+, A
                     this.X=(this.X+1)&0xFF; return 4; }

        // ── MOV mem, X ───────────────────────────────────────────
        case 0xD8: this._w(this._dpAddr(),this.X); return 4;
        case 0xC9: this._w(this._absAddr(),this.X); return 5;
        case 0xD9: this._w(this._dpYAddr(),this.X); return 5;

        // ── MOV mem, Y ───────────────────────────────────────────
        case 0xCB: this._w(this._dpAddr(),this.Y); return 4;
        case 0xCC: this._w(this._absAddr(),this.Y); return 5;
        case 0xDB: this._w(this._dpXAddr(),this.Y); return 5;

        // ── MOV dp, dp / dp, #imm ────────────────────────────────
        // FA: [FA][src][dst]  ニーモニックは MOV dd,ds だが機械語は src バイトが先・
        // dst バイトが後（SPC700 特有の逆順）。以前は第1バイトを書き込み先として扱い
        // src/dst が逆になっていた。MOV dp,dp で「マスクをコピーしてから走査」する
        // N-SPC 系ドライバ（Chrono Trigger 等）でコピー元（アクティブボイスマスク）を
        // 0 で潰し、全ボイスの発音が止まっていた。
        case 0xFA: { const s=this._dpAddr(), d=this._dpAddr(); this._w(d,this._r(s)); return 5; }
        // 8F: [8F][imm][dst]  imm 先読み
        case 0x8F: { const imm=this._imm(), d=this._dpAddr(); this._w(d,imm); return 5; }

        // ── MOV SP, X ────────────────────────────────────────────
        case 0xBD: this.SP=this.X; return 2;

        // ── MOVW YA, dp ──────────────────────────────────────────
        case 0xBA: { const a=this._dpAddr(); const lo=this._r(a), hi=this._r(this._dpHi(a));
                     this.A=lo; this.Y=hi;
                     const ya=(hi<<8)|lo;
                     this.PSW=(this.PSW&~0x82)|(ya&0x8000?0x80:0)|(ya===0?0x02:0); return 5; }

        // ── MOVW dp, YA ──────────────────────────────────────────
        case 0xDA: { const a=this._dpAddr(); this._w(a,this.A); this._w(this._dpHi(a),this.Y); return 5; }

        // ── ADDW YA, dp ──────────────────────────────────────────
        case 0x7A: { const a=this._dpAddr();
                     const ya=(this.Y<<8)|this.A, m=this._r(a)|(this._r(this._dpHi(a))<<8);
                     const r=ya+m;
                     const h=(ya&0xFFF)+(m&0xFFF);
                     this.PSW=(this.PSW&~0xCB)|(r&0x8000?0x80:0)
                       |((ya^r)&(m^r)&0x8000?0x40:0)|(h>0xFFF?0x08:0)|(r===0?0x02:0)|(r>0xFFFF?0x01:0);
                     this.A=r&0xFF; this.Y=(r>>8)&0xFF; return 5; }

        // ── SUBW YA, dp ──────────────────────────────────────────
        case 0x9A: { const a=this._dpAddr();
                     const ya=(this.Y<<8)|this.A, m=this._r(a)|(this._r(this._dpHi(a))<<8);
                     const r=ya-m;
                     const h=(ya&0xFFF)-(m&0xFFF);
                     this.PSW=(this.PSW&~0xCB)|(r&0x8000?0x80:0)
                       |((ya^m)&(ya^r)&0x8000?0x40:0)|(h>=0?0x08:0)|((r&0xFFFF)===0?0x02:0)|(r>=0?0x01:0);
                     this.A=r&0xFF; this.Y=(r>>8)&0xFF; return 5; }

        // ── CMPW YA, dp ──────────────────────────────────────────
        case 0x5A: { const a=this._dpAddr();
                     const ya=(this.Y<<8)|this.A, m=this._r(a)|(this._r(this._dpHi(a))<<8);
                     const r=ya-m;
                     this.PSW=(this.PSW&~0x83)|(r&0x8000?0x80:0)|((r&0xFFFF)===0?0x02:0)|(r>=0?0x01:0);
                     return 4; }

        // ── INCW / DECW ──────────────────────────────────────────
        case 0x3A: { const a=this._dpAddr(), a1=this._dpHi(a); const lo=this._r(a), hi=this._r(a1);
                     const v=((hi<<8)|lo)+1;
                     this._w(a,v&0xFF); this._w(a1,(v>>8)&0xFF);
                     this.PSW=(this.PSW&~0x82)|(v&0x8000?0x80:0)|((v&0xFFFF)===0?0x02:0); return 6; }
        case 0x1A: { const a=this._dpAddr(), a1=this._dpHi(a); const lo=this._r(a), hi=this._r(a1);
                     const v=((hi<<8)|lo)-1;
                     this._w(a,v&0xFF); this._w(a1,(v>>8)&0xFF);
                     this.PSW=(this.PSW&~0x82)|(v&0x8000?0x80:0)|((v&0xFFFF)===0?0x02:0); return 6; }

        // ── MUL YA ───────────────────────────────────────────────
        case 0xCF: { const r=this.Y*this.A; this.Y=(r>>8)&0xFF; this.A=r&0xFF;
                     this.PSW=(this.PSW&~0x82)|(this.Y&0x80)|(this.Y===0?0x02:0); return 9; }

        // ── DIV YA, X ────────────────────────────────────────────
        case 0x9E: {
          // SPC700 の DIV YA,X は独特（bsnes/higan 準拠）。9bit に収まらない商は
          // 別式で近似され、V/H フラグも特殊。以前の素朴な ya/X, ya%X は不一致だった。
          const ya=(this.Y<<8)|this.A, X=this.X;
          // H: X 下位ニブル <= Y 下位ニブル、V: Y >= X
          if((X&0x0F)<=(this.Y&0x0F)) this.PSW|=0x08; else this.PSW&=~0x08;
          if(this.Y>=X) this.PSW|=0x40; else this.PSW&=~0x40;
          if(this.Y < (X<<1)) {
            this.A = Math.floor(ya / X) & 0xFF;
            this.Y = (ya % X) & 0xFF;
          } else {
            this.A = (255 - Math.floor((ya - (X<<9)) / (256 - X))) & 0xFF;
            this.Y = (X + ((ya - (X<<9)) % (256 - X))) & 0xFF;
          }
          this._setNZ(this.A); return 12;
        }

        // ── XCN A ────────────────────────────────────────────────
        case 0x9F: this.A=this._setNZ(((this.A>>4)|(this.A<<4))&0xFF); return 5;

        // ── DAA / DAS ────────────────────────────────────────────
        case 0xDF: { // DAA
          let a=this.A; const c=this._getC(), h=(this.PSW>>3)&1;
          if(c||a>0x99){a+=0x60; this.PSW|=0x01;} else this.PSW&=~0x01;
          if(h||(a&0xF)>9) a+=0x06;
          this.A=this._setNZ(a); return 3;
        }
        case 0xBE: { // DAS
          let a=this.A; const c=this._getC(), h=(this.PSW>>3)&1;
          if(!c||a>0x99){a-=0x60; this.PSW&=~0x01;} else this.PSW|=0x01;
          if(!h||(a&0xF)>9) a-=0x06;
          this.A=this._setNZ(a); return 3;
        }

        // ── フラグ操作 ────────────────────────────────────────────
        case 0x60: this.PSW&=~0x01; return 2;  // CLRC
        case 0x80: this.PSW|=0x01; return 2;   // SETC
        case 0x20: this.PSW&=~0x20; return 2;  // CLRP
        case 0x40: this.PSW|=0x20; return 2;   // SETP
        case 0xE0: this.PSW&=~0x48; return 2;  // CLRV（V と H の両方をクリア）
        case 0xA0: this.PSW|=0x04; return 3;   // EI
        case 0xC0: this.PSW&=~0x04; return 3;  // DI
        case 0xED: this.PSW^=0x01; return 3;   // NOTC

        // ── TSET1 / TCLR1 ────────────────────────────────────────
        // TSET1/TCLR1: N,Z は A-mem（CMP と同じ）で決まる。以前は A&mem で判定して
        // いたため N/Z が誤り。C,V は不変。
        case 0x0E: { const a=this._absAddr(), d=this._r(a); this._w(a,d|this.A);
                     this._setNZ((this.A-d)&0xFF); return 6; }
        case 0x4E: { const a=this._absAddr(), d=this._r(a); this._w(a,d&~this.A);
                     this._setNZ((this.A-d)&0xFF); return 6; }

        // ── 1ビット演算 (C, mem.bit) ─────────────────────────────
        case 0x0A: { const mb=this._memBit(); const bit=(this._r(mb.addr)>>mb.bit)&1;
                     this.PSW=(this.PSW&~0x01)|(this._getC()|bit); return 5; }    // OR1
        case 0x2A: { const mb=this._memBit(); const bit=((this._r(mb.addr)>>mb.bit)&1)^1;
                     this.PSW=(this.PSW&~0x01)|(this._getC()|bit); return 5; }   // OR1 /
        case 0x4A: { const mb=this._memBit(); const bit=(this._r(mb.addr)>>mb.bit)&1;
                     this.PSW=(this.PSW&~0x01)|(this._getC()&bit); return 4; }   // AND1
        case 0x6A: { const mb=this._memBit(); const bit=((this._r(mb.addr)>>mb.bit)&1)^1;
                     this.PSW=(this.PSW&~0x01)|(this._getC()&bit); return 4; }   // AND1 /
        case 0x8A: { const mb=this._memBit(); const bit=(this._r(mb.addr)>>mb.bit)&1;
                     this.PSW=(this.PSW&~0x01)|(this._getC()^bit); return 5; }   // EOR1
        case 0xEA: { const mb=this._memBit();
                     const d=this._r(mb.addr), bit=(d>>mb.bit)&1;
                     this._w(mb.addr,(d&~(1<<mb.bit))|((bit^1)<<mb.bit)); return 5; } // NOT1
        case 0xAA: { const mb=this._memBit();
                     this.PSW=(this.PSW&~0x01)|((this._r(mb.addr)>>mb.bit)&1); return 4; } // MOV1 C, mb
        case 0xCA: { const mb=this._memBit(); const d=this._r(mb.addr);
                     this._w(mb.addr,(d&~(1<<mb.bit))|(this._getC()<<mb.bit)); return 6; } // MOV1 mb, C

        // ── デフォルト（未定義命令 = NOP 扱い） ────────────────────
        default:
          return 2;
      }
    }

    /**
     * 指定サイクル数実行 (STOP/SLEEP でハルトしたら即座に抜ける)
     */
    runCycles(cycles) {
      if (this.halted) return;
      let spent = 0;
      while (spent < cycles) {
        spent += this.step();
        if (this.halted) return;
      }
    }
  }

  Emu.SPC700 = SPC700;
  Emu.SPC_IPL_ROM = IPL_ROM;

})(globalThis);

/*
 * SNES DSP エミュレータ (CXD1222Q/CXD2922Q)
 * MML.Emu.SpcDsp
 *
 * 8ボイス BRR サンプル再生、ADSR エンベロープ、エコー処理
 * clock() を 32 SPC700 サイクルごとに呼び出すと 32kHz で 1 ステレオサンプルを生成
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ── ガウシアン補間テーブル (512 entries) ─────────────────────────
  // SNES DSP の4タップ・ガウシアン補間カーネル。
  // 【修正】旧テーブルは形状が誤っており(index 426 付近で 0x3FF 頭打ち・末尾 0)、
  // 4タップの合計が 2048 にならず、補間利得がサブサンプル位置(frac)に依存して
  // 最大 ±30% 変動していた。frac は毎サンプル進むため、この利得リップルが持続音
  // (特に低音)に信号比例の高域うなり=音割れを生じさせていた。
  // 正しくは実機同様に単調増加(ピーク G[511]≈1305)し、各列(4タップ)合計が
  // ほぼ 2048 になる単位利得カーネルでなければならない。
  //   G[n] = round(h((511.5 - n)/256) * scale),  h(u) = exp(-u^2 / (2σ^2))
  // σ=0.63 で実機ピーク(≈1305)を再現し、全列合計が 2044〜2050(±0.3%)に収まる。
  const GAUSS = (() => {
    const SIGMA = 0.63;
    const h = (u) => Math.exp(-(u * u) / (2 * SIGMA * SIGMA));
    // f=0..1 の全列平均合計が 2048 になるよう scale を決定(単位利得化)
    let colAvg = 0;
    for (let p = 0; p < 256; p++) {
      const f = (p + 0.5) / 256;
      colAvg += h(1 + f) + h(f) + h(1 - f) + h(2 - f);
    }
    const scale = 2048 / (colAvg / 256);
    const t = new Int16Array(512);
    for (let n = 0; n < 512; n++) {
      const u = (511.5 - n) / 256;
      t[n] = Math.round(h(u) * scale);
    }
    return t;
  })();

  // ── エンベロープレートテーブル ──────────────────────────────────
  // 各エントリ = 何 DSP サンプルごとに envelope を更新するか
  const RATE_TABLE = new Uint16Array([
    0,2048,1536,1280,1024,768,640,512,
    384,320,256,192,160,128,96,80,
    64,48,40,32,24,20,16,12,
    10,8,6,5,4,3,2,1,
  ]);

  // ── BRR デコーダ ─────────────────────────────────────────────────
  function decodeBrrBlock(ram, addr, prev1, prev2) {
    const header = ram[addr & 0xFFFF];
    const shift  = header >> 4;
    const filter = (header >> 2) & 3;
    const loop   = (header >> 1) & 1;
    const end    = header & 1;
    const samples = new Int16Array(16);

    for (let i = 0; i < 8; i++) {
      const byte = ram[(addr + 1 + i) & 0xFFFF];
      for (let nib = 0; nib < 2; nib++) {
        const raw = (nib === 0) ? (byte >> 4) : (byte & 0xF);
        // 4bit符号拡張 → 16bit
        let s = (raw & 8) ? (raw | 0xFFFFFFF0) : raw;
        // シフト適用
        if (shift <= 12) {
          s = (s << shift) >> 1;
        } else {
          // range 13-15: nybble の符号ビット（bit3）で飽和
          // 実機では BRR フェードアウト用の意図的な無音化に使われる
          // 負 nybble (bit3=1) → -1、非負 nybble (bit3=0) → 0
          s = (s >> 3) & ~1;  // 符号だけ残して偶数化（SNESAPU 準拠）
        }

        // フィルタ適用
        switch (filter) {
          case 1: s += prev1 - (prev1 >> 4); break;
          case 2: s += (prev1 << 1) - ((prev1 * 3) >> 5) - prev2 + (prev2 >> 4); break;
          case 3: s += (prev1 << 1) - ((prev1 * 13) >> 6) - prev2 + ((prev2 * 3) >> 4); break;
        }
        // 15bit符号付きにクランプ
        s = Math.max(-32768, Math.min(32767, s));
        // 15bit（下位 1bit は常に 0）
        s = (s << 1) >> 1;
        samples[i * 2 + nib] = s;
        prev2 = prev1;
        prev1 = s;
      }
    }
    return { samples, prev1, prev2, loop, end };
  }

  // ── ボイス状態 ────────────────────────────────────────────────────
  class Voice {
    constructor() {
      this.volL = 0; this.volR = 0;
      this.pitch = 0;
      this.srcn  = 0;
      this.adsr1 = 0; this.adsr2 = 0; this.gain = 0;
      this.env   = 0;          // 11bit エンベロープ値 0x000-0x7FF
      this.envMode = 'off';    // 'attack'|'decay'|'sustain'|'release'|'off'
      this.sampleIdx = 0;      // デコード済みサンプルバッファ内インデックス
      this.pitchFrac = 0;      // 12.12 固定小数点の小数部 (0-0xFFF)
      this.pitchInt  = 0;      // 整数部
      // [0-3]=直前ブロック末尾4サンプル(履歴), [4-19]=現ブロック16サンプル
      this.brrBuf  = new Int16Array(20);
      this.brrPrev1 = 0; this.brrPrev2 = 0;
      this.brrAddr  = 0;       // 次に読む BRR ブロックアドレス
      this.loopAddr = 0;
      this.konDelay = 0;       // KON 後の遅延サンプル数
      this.outSample = 0;      // 直近のボイス出力 (for PMON)
      this.envRate  = 0;       // エンベロープ更新カウンタ
    }
  }

  // ── DSP クラス ────────────────────────────────────────────────────
  class SpcDsp {
    /**
     * @param {Uint8Array} ram - SPC 64KB RAM (参照渡し)
     */
    constructor(ram) {
      this.ram = ram;
      // BRR サンプル読み取り専用の元データコピー（エコー書き込みによる破壊を防ぐ）
      // spcPlayer 側から set される
      this.origRam = null;
      this.regs = new Uint8Array(128); // DSP レジスタ
      this.voices = Array.from({length:8}, () => new Voice());
      this.kon  = 0;  // KON ラッチ
      this.koff = 0;  // KOFF ラッチ
      this.endx = 0;  // ENDX フラグ
      this.mutedVoices = 0;  // ミュートビットマスク (bit0=Voice0 ... bit7=Voice7)
      this.voiceVol = new Array(8).fill(1); // ボイスごとの音量(0〜1、既定1)。鍵盤表示のch別音量バー用
      // エコー
      this.echoPos = 0;
      this.echoBufL = new Int32Array(8192);
      this.echoBufR = new Int32Array(8192);
      // メインステレオ出力
      this.outL = 0;
      this.outR = 0;
      // ノイズ
      this.noiseLfsr = 0x4000;
      this.noiseSample = 0;
      this.noiseCounter = 0;
      // ログ用 DSP 書き込みコールバック
      this.onWrite = null;
      // サンプルカウンタ (エンベロープ/エコー用)
      this.sampleClock = 0;
    }

    reset() {
      this.regs.fill(0);
      this.voices.forEach(v => {
        Object.assign(v, new Voice());
      });
      this.endx = 0; this.echoPos = 0;
      this.echoBufL.fill(0); this.echoBufR.fill(0);
      this.outL = 0; this.outR = 0;
      this.noiseLfsr = 0x4000; this.sampleClock = 0;
    }

    // ── レジスタ アクセス ──────────────────────────────────────────
    readReg(addr) {
      addr &= 0x7F;
      const v = addr & 0x0F;
      if (v === 0x08) return this.voices[addr >> 4].env & 0xFF;
      if (v === 0x09) return this.voices[addr >> 4].outSample >> 7;
      if (addr === 0x7C) { const e=this.endx; this.endx=0; return e; }
      return this.regs[addr];
    }

    writeReg(addr, val) {
      addr &= 0x7F; val &= 0xFF;
      this.regs[addr] = val;
      if (this.onWrite) this.onWrite(addr, val);

      const ch = addr >> 4, reg = addr & 0x0F;
      const v  = this.voices[ch];

      switch (addr) {
        case 0x4C: // KON
          this.kon = val;
          for (let i = 0; i < 8; i++) {
            if (val & (1 << i)) this._keyOn(i);
          }
          break;
        case 0x5C: // KOFF
          this.koff = val;
          for (let i = 0; i < 8; i++) {
            if (val & (1 << i)) this.voices[i].envMode = 'release';
          }
          break;
        case 0x6C: // FLG
          if (val & 0x80) this.reset(); // RESET
          break;
      }

      // per-voice ADSR/GAIN
      if (reg === 0x05) v.adsr1 = val;
      else if (reg === 0x06) v.adsr2 = val;
      else if (reg === 0x07) v.gain  = val;
    }

    // ── KON ───────────────────────────────────────────────────────
    _keyOn(ch) {
      const v = this.voices[ch];
      const srcn = this.regs[(ch << 4) | 0x04];
      const dir  = this.regs[0x5D];
      const dirAddr = (dir << 8) + srcn * 4;
      // brrDirCache があればそちらを優先（エコーバッファとの重複破壊対策）
      if (this.brrDirCache) {
        const base = srcn * 4;
        v.brrAddr  = this.brrDirCache[base] | (this.brrDirCache[base+1] << 8);
        v.loopAddr = this.brrDirCache[base+2] | (this.brrDirCache[base+3] << 8);
      } else {
        v.brrAddr  = this.ram[dirAddr & 0xFFFF] | (this.ram[(dirAddr+1) & 0xFFFF] << 8);
        v.loopAddr = this.ram[(dirAddr+2) & 0xFFFF] | (this.ram[(dirAddr+3) & 0xFFFF] << 8);
      }
      v.srcn     = srcn;
      v.pitchFrac = 0; v.pitchInt = 0;
      v.sampleIdx = 0;
      v.brrPrev1 = 0; v.brrPrev2 = 0;
      v.brrBuf.fill(0); // 20要素すべてクリア（履歴も含む）
      v.env      = 0;
      v.envMode  = 'attack';
      v.envRate  = 0;
      v.konDelay = 5; // KON 後 5 サンプル遅延
      // KON したボイスの ENDX ビットをクリア (SNESAPU v2.11.3 相当)
      this.endx &= ~(1 << ch);
    }

    // ── エンベロープ更新 ───────────────────────────────────────────
    _updateEnvelope(ch) {
      const v = this.voices[ch];
      if (v.envMode === 'off') return;

      const adsr1 = this.regs[(ch << 4) | 0x05];
      const adsr2 = this.regs[(ch << 4) | 0x06];
      const gain  = this.regs[(ch << 4) | 0x07];
      const adsrEn = adsr1 & 0x80;

      if (v.envMode === 'release') {
        // Release: 指数減衰 rate=31 (毎サンプル) - 線形 -8 ではなく指数
        v.env -= ((v.env - 1) >> 8) + 1;
        if (v.env <= 0) { v.env = 0; v.envMode = 'off'; }
        return;
      }

      if (!adsrEn) {
        // GAIN モード
        const mode = (gain >> 5) & 3;
        const rate = gain & 0x1F;
        if (gain & 0x80) {
          // カスタムモード
          v.envRate++;
          if (v.envRate >= RATE_TABLE[rate]) {
            v.envRate = 0;
            switch (mode) {
              case 0: v.env -= 32; break; // Linear decrease
              case 1: // Exponential decrease
                v.env -= ((v.env - 1) >> 8) + 1;
                break;
              case 2: v.env += 32; break; // Linear increase
              case 3: v.env += (v.env < 0x600) ? 32 : 8; break; // Bent increase
            }
          }
        } else {
          // Direct GAIN: 直接 0-127 → 0x000-0x7E0
          v.env = (gain & 0x7F) << 4;
        }
        v.env = Math.max(0, Math.min(0x7FF, v.env));
        return;
      }

      // ADSR モード
      if (v.envMode === 'attack') {
        const ar = (adsr1 & 0x0F);
        const rate = ar === 15 ? 31 : ar * 2 + 1;
        v.envRate++;
        if (v.envRate >= RATE_TABLE[rate]) {
          v.envRate = 0;
          v.env += (ar === 15) ? 1024 : 32;
          if (v.env >= 0x7E0) { v.env = 0x7E0; v.envMode = 'decay'; }
        }
      } else if (v.envMode === 'decay') {
        const dr = (adsr1 >> 4) & 0x07;
        const rate = 8 + dr * 2;
        v.envRate++;
        if (v.envRate >= RATE_TABLE[rate]) {
          v.envRate = 0;
          v.env -= ((v.env - 1) >> 8) + 1;
          const sl = ((adsr2 >> 5) & 0x07);
          const sustLevel = (sl + 1) << 8;
          if (v.env <= sustLevel) { v.env = sustLevel; v.envMode = 'sustain'; }
        }
      } else if (v.envMode === 'sustain') {
        const sr = adsr2 & 0x1F;
        if (sr === 0) return;
        v.envRate++;
        if (v.envRate >= RATE_TABLE[sr]) {
          v.envRate = 0;
          v.env -= ((v.env - 1) >> 8) + 1;
          if (v.env <= 0) { v.env = 0; v.envMode = 'off'; }
        }
      }
      v.env = Math.max(0, Math.min(0x7FF, v.env));
    }

    // ── BRR サンプル取得（ガウシアン補間） ────────────────────────
    // brrBuf[0-3]=直前ブロック末尾4サンプル, brrBuf[4-19]=現ブロック16サンプル
    // sampleIdx=i(0-15) → buf[4+i], buf[3+i], buf[2+i], buf[1+i] を参照
    // i=0 のとき buf[1-3] は直前ブロックの末尾サンプルを正しく参照する
    _getSample(v) {
      const i   = v.sampleIdx;
      const s0  = v.brrBuf[1 + i];
      const s1  = v.brrBuf[2 + i];
      const s2  = v.brrBuf[3 + i];
      const s3  = v.brrBuf[4 + i];
      const frac = (v.pitchFrac >> 4) & 0xFF;
      const out = (GAUSS[0xFF - frac] * s0 + GAUSS[0x1FF - frac] * s1 +
                   GAUSS[0x100 + frac] * s2 + GAUSS[frac] * s3) >> 11;
      return Math.max(-32768, Math.min(32767, out));
    }

    // ── ノイズ更新 ────────────────────────────────────────────────
    _updateNoise() {
      const flg  = this.regs[0x6C];
      const rate = flg & 0x1F;
      if (rate === 0) return;
      this.noiseCounter++;
      if (this.noiseCounter >= RATE_TABLE[rate]) {
        this.noiseCounter = 0;
        const bit = (this.noiseLfsr & 1) ^ ((this.noiseLfsr >> 1) & 1);
        this.noiseLfsr = ((this.noiseLfsr >> 1) | (bit << 14)) & 0x7FFF;
        this.noiseSample = (this.noiseLfsr & 0x7FFF) - (bit ? 0x8000 : 0);
      }
    }

    // ── メインクロック (32 SPC サイクルごとに呼ぶ) ─────────────────
    clock() {
      this.sampleClock++;
      this._updateNoise();

      const flg  = this.regs[0x6C];
      const non  = this.regs[0x3D]; // noise enable
      const pmon = this.regs[0x2D]; // pitch modulation
      const eon  = this.regs[0x4D]; // echo enable
      const echoOff = (flg & 0x20) !== 0;

      let mainL = 0, mainR = 0, echoInL = 0, echoInR = 0;
      let prevVoiceOut = 0;

      for (let ch = 0; ch < 8; ch++) {
        const v   = this.voices[ch];
        const base = ch << 4;

        // KON 遅延 (5サンプル: ピッチ進行・エンベロープも停止)
        if (v.konDelay > 0) {
          v.konDelay--;
          if (v.konDelay === 0) {
            // 最初のブロックをデコード（履歴部[0-3]は0のまま=KON直後は無音から開始）
            const res = decodeBrrBlock(this.origRam || this.ram, v.brrAddr, 0, 0);
            v.brrBuf.fill(0, 0, 4);        // 履歴ゼロクリア
            v.brrBuf.set(res.samples, 4);   // 現ブロックを[4-19]に配置
            v.brrPrev1 = res.prev1; v.brrPrev2 = res.prev2;
            v.brrAddr += 9;
            v.sampleIdx = 0;
            v.pitchFrac = 0;
          }
          continue; // 遅延中はサンプル生成をスキップ
        }

        // エンベロープ更新
        this._updateEnvelope(ch);

        // ピッチ計算
        let pitchVal = (this.regs[base+2] | ((this.regs[base+3] & 0x3F) << 8));
        // ピッチモジュレーション (PMON bit で前ボイス出力を乗算)
        if (ch > 0 && (pmon & (1 << ch))) {
          pitchVal = (pitchVal * (prevVoiceOut + 0x8000)) >> 15;
          pitchVal = Math.max(0, Math.min(0x3FFF, pitchVal));
        }
        v.pitch = pitchVal;

        // 位置進行
        v.pitchFrac += pitchVal;
        const steps = (v.pitchFrac >> 12) & 0xF;
        v.pitchFrac &= 0xFFF;
        v.sampleIdx = (v.sampleIdx + steps) % 16;

        // 次ブロックが必要かチェック (sampleIdx < steps ⇔ ブロック境界を越えた)
        if (v.sampleIdx < steps || v.sampleIdx >= 16) {
          // 直前ブロック末尾4サンプルを履歴[0-3]に保存してから上書き
          v.brrBuf[0] = v.brrBuf[16];
          v.brrBuf[1] = v.brrBuf[17];
          v.brrBuf[2] = v.brrBuf[18];
          v.brrBuf[3] = v.brrBuf[19];
          const res = decodeBrrBlock(this.origRam || this.ram, v.brrAddr, v.brrPrev1, v.brrPrev2);
          v.brrBuf.set(res.samples, 4); // 現ブロックを[4-19]に配置
          v.brrPrev1 = res.prev1; v.brrPrev2 = res.prev2;
          if (res.end) {
            this.endx |= (1 << ch);
            if (res.loop) {
              v.brrAddr = v.loopAddr;
              v.envMode = v.envMode === 'attack' ? 'decay' : v.envMode; // ループ時はdecayへ
            } else {
              v.envMode = 'off';
              v.env = 0;
            }
          } else {
            v.brrAddr += 9;
          }
        }

        // サンプル取得
        let sample;
        if (non & (1 << ch)) {
          sample = this.noiseSample; // ノイズ
        } else {
          sample = this._getSample(v);
        }

        // エンベロープ適用
        const envApplied = Math.round((sample * v.env) / 0x800);
        v.outSample = Math.max(-32768, Math.min(32767, envApplied));

        // ボリューム適用・ミックス
        const volL = (this.regs[base+0] << 24) >> 24; // 符号付き
        const volR = (this.regs[base+1] << 24) >> 24;
        const mixL = Math.round((v.outSample * volL) / 128);
        const mixR = Math.round((v.outSample * volR) / 128);

        if (!(this.mutedVoices & (1 << ch))) {
          const vv = this.voiceVol[ch];
          mainL += mixL * vv; mainR += mixR * vv;
          if (eon & (1 << ch)) { echoInL += mixL * vv; echoInR += mixR * vv; }
        }

        prevVoiceOut = v.outSample;
      }

      // マスターボリューム
      const mvolL = (this.regs[0x0C] << 24) >> 24;
      const mvolR = (this.regs[0x1C] << 24) >> 24;

      // エコー処理
      const edl      = this.regs[0x7D] & 0x0F;
      // エコーバッファのサイズ = EDL × 2KB（EDL=0 は最小 4 バイト = 1 フレーム）。
      // フレーム(=4バイト)単位では EDL × 512。以前は (edl+1)*512 と 1 段大きく取って
      // いたため、ESA が高位のゲーム（例 Axelay "Unkai" ESA=$D8/EDL=5 → 0xD800+）で
      // 書き込みアドレスが $FFFF を跨いでページ0（$F1 タイマー制御やドライバの
      // ゼロページ変数）を上書きし、バッファ一巡直後（約0.08秒）にタイマーが停止して
      // 曲が最初の音で止まっていた。
      const eLen     = (edl === 0 ? 1 : edl * 512); // フレーム数 (512〜7680)
      const ePos     = this.echoPos;              // 既に % eLen 済み
      const esa      = this.regs[0x6D];
      const echoBase = (esa << 8);

      // FIR フィルタ読み取り (8タップ、1フレームずつ遡る)
      let echoL = 0, echoR = 0;
      for (let tap = 0; tap < 8; tap++) {
        const fir     = (this.regs[tap * 0x10 + 0x0F] << 24) >> 24;
        const tapPos  = (ePos - tap + eLen) % eLen;  // tap*2→tap に修正
        const addr    = (echoBase + tapPos * 4) & 0xFFFF;
        const eL = (this.ram[addr] | (this.ram[(addr+1)&0xFFFF] << 8)) << 16 >> 16;
        const eR = (this.ram[(addr+2)&0xFFFF] | (this.ram[(addr+3)&0xFFFF] << 8)) << 16 >> 16;
        echoL += (eL * fir) >> 7;
        echoR += (eR * fir) >> 7;
      }
      echoL = Math.max(-32768, Math.min(32767, echoL));
      echoR = Math.max(-32768, Math.min(32767, echoR));

      // エコーフィードバック書き込み
      // BRR サンプルディレクトリ領域 (DIR<<8 ～ DIR<<8+1023) には書き込まない。
      // エコーバッファとディレクトリが重複する場合、実機では整合した値になるが
      // 我々の計算値は異なるため、初期 SPC ダンプ値をそのまま保持することで
      // KON 時に正しいサンプルアドレスを読めるようにする。
      if (!echoOff) {
        const efb = (this.regs[0x0D] << 24) >> 24;
        const writeL = Math.max(-32768, Math.min(32767, echoInL + ((echoL * efb) >> 7)));
        const writeR = Math.max(-32768, Math.min(32767, echoInR + ((echoR * efb) >> 7)));
        const waddr = (echoBase + ePos * 4) & 0xFFFF;
        // BRR ディレクトリは brrDirCache にキャッシュ済みなので RAM には自由に書ける
        this.ram[waddr]               = writeL & 0xFF;
        this.ram[(waddr+1) & 0xFFFF]  = (writeL >> 8) & 0xFF;
        this.ram[(waddr+2) & 0xFFFF]  = writeR & 0xFF;
        this.ram[(waddr+3) & 0xFFFF]  = (writeR >> 8) & 0xFF;
      }
      this.echoPos = (this.echoPos + 1) % eLen;

      // エコーボリューム適用（全ボイスミュート中はエコーも無音）
      const allMuted = (this.mutedVoices & 0xFF) === 0xFF;
      const evolL = allMuted ? 0 : (this.regs[0x2C] << 24) >> 24;
      const evolR = allMuted ? 0 : (this.regs[0x3C] << 24) >> 24;

      // 最終出力 (-1.0〜+1.0 に正規化)
      const outL = (Math.round((mainL * mvolL) / 128) + Math.round((echoL * evolL) / 128));
      const outR = (Math.round((mainR * mvolR) / 128) + Math.round((echoR * evolR) / 128));
      this.outL = Math.max(-32768, Math.min(32767, outL)) / 32768;
      this.outR = Math.max(-32768, Math.min(32767, outR)) / 32768;
    }
  }

  // ── 鍵盤表示(大波形)プレビュー用: ガウス補間+ピッチ進行を dsp本体と同じ式で
  // 非破壊に計算する。voice本体(sampleIdx/pitchFrac)は変更しない。ブロック境界を
  // 跨ぐ新規BRRフェッチは行わず、現在のbrrBuf(16サンプル+履歴4)内で折り返す簡易プレビュー。
  function previewVoiceOutput(voice, pitchVal, count) {
    let sampleIdx = voice.sampleIdx, pitchFrac = voice.pitchFrac;
    const buf = voice.brrBuf;
    const out = new Array(count);
    for (let n = 0; n < count; n++) {
      const i = sampleIdx;
      const s0 = buf[1 + i], s1 = buf[2 + i], s2 = buf[3 + i], s3 = buf[4 + i];
      const frac = (pitchFrac >> 4) & 0xFF;
      const v = (GAUSS[0xFF - frac] * s0 + GAUSS[0x1FF - frac] * s1 +
                 GAUSS[0x100 + frac] * s2 + GAUSS[frac] * s3) >> 11;
      out[n] = Math.max(-32768, Math.min(32767, v));
      pitchFrac += pitchVal;
      const steps = (pitchFrac >> 12) & 0xF;
      pitchFrac &= 0xFFF;
      sampleIdx = (sampleIdx + steps) % 16;
    }
    return out;
  }

  Emu.SpcDsp = SpcDsp;
  Emu.decodeBrrBlock = decodeBrrBlock;
  Emu.previewVoiceOutput = previewVoiceOutput;
  Emu.GAUSS = GAUSS;

})(globalThis);

/*
 * SPC プレイヤー（SPC700 CPU + DSP + バス の統合）
 * MML.Emu.SpcPlayer
 *
 *   constructor(spcBytes)
 *   renderSample()    → { L, R }  — 1 DSP サンプル (32kHz ステレオ) を生成
 *   renderSeconds(sec, outSampleRate) → Float32Array  — 指定秒数分を指定レートで合成
 */
(function (global) {
  'use strict';
  const MML  = global.MML  = global.MML  || {};
  const Emu  = MML.Emu    = MML.Emu    || {};

  // SPC700 クロック (Hz)
  const SPC_CLOCK   = 1024000;
  // DSP サンプルレート (Hz) = SPC_CLOCK / 32
  const DSP_RATE    = 32000;
  // DSP クロックごとのCPUサイクル数
  const CYCLES_PER_DSP = SPC_CLOCK / DSP_RATE; // 32

  // ── バス ─────────────────────────────────────────────────────────
  class SpcBus {
    constructor(ram, dsp) {
      this.ram = ram;
      this.dsp = dsp;
      this.dspAddr = 0;

      // タイマー
      this.timers    = [0, 0, 0];  // ダウンカウンタ
      this.timerDiv  = [0, 0, 0];  // 分周器 ($FA-$FC)
      this.timerCnt  = [0, 0, 0];  // 4bit カウンタ ($FD-$FF, 読み出しでクリア)
      this.timerEn   = [false, false, false];
      this.timerClk  = [0, 0, 0];  // サイクルカウント

      // IPL ROM 制御
      this.romEnable = true;

      // I/O ポート（SNES CPU との通信、SPC 単体再生では外部からは使わない）
      this.ioPorts = new Uint8Array(4);

      // DSP 書き込み追跡コールバック
      this.onWrite = null;
      // バス読み取り追跡コールバック (addr, returnValue) → void
      this.onRead = null;
    }

    /** SPC700 サイクル経過に合わせてタイマーを進める */
    tickTimers(cycles) {
      for (let t = 0; t < 3; t++) {
        if (!this.timerEn[t]) continue;
        // Timer 0,1: 8kHz (128 SPC cycles/tick), Timer 2: 64kHz (16 SPC cycles/tick)
        const period = (t < 2) ? 128 : 16;
        this.timerClk[t] += cycles;
        while (this.timerClk[t] >= period) {
          this.timerClk[t] -= period;
          this.timers[t]++;
          const div = this.timerDiv[t] || 256;
          if (this.timers[t] >= div) {
            this.timers[t] = 0;
            this.timerCnt[t] = (this.timerCnt[t] + 1) & 0x0F;
          }
        }
      }
    }

    read(addr) {
      addr &= 0xFFFF;
      // IPL ROM ($FFC0-$FFFF)
      if (this.romEnable && addr >= 0xFFC0) {
        return Emu.SPC_IPL_ROM[addr - 0xFFC0];
      }
      switch (addr) {
        case 0x00F2: return this.dspAddr;
        case 0x00F3: return this.dsp.readReg(this.dspAddr);
        case 0x00F4: return this.ioPorts[0];
        case 0x00F5: return this.ioPorts[1];
        case 0x00F6: return this.ioPorts[2];
        case 0x00F7: return this.ioPorts[3];
        case 0x00FD: { const c=this.timerCnt[0]; this.timerCnt[0]=0; if(this.onRead) this.onRead(0xFD, c); return c; }
        case 0x00FE: { const c=this.timerCnt[1]; this.timerCnt[1]=0; if(this.onRead) this.onRead(0xFE, c); return c; }
        case 0x00FF: { const c=this.timerCnt[2]; this.timerCnt[2]=0; if(this.onRead) this.onRead(0xFF, c); return c; }
      }
      const v = this.ram[addr];
      if(this.onRead) this.onRead(addr, v);
      return v;
    }

    write(addr, val) {
      addr &= 0xFFFF; val &= 0xFF;
      if (this.onWrite) this.onWrite(addr, val);
      switch (addr) {
        case 0x00F1: // CONTROL
          this.romEnable = (val & 0x80) !== 0;
          for (let t = 0; t < 3; t++) {
            this.timerEn[t] = (val & (1 << t)) !== 0;
            if (!this.timerEn[t]) this.timerCnt[t] = 0;
          }
          // bit 4: ポート $F4/$F5 クリア, bit 5: $F6/$F7 クリア
          if (val & 0x10) { this.ioPorts[0] = 0; this.ioPorts[1] = 0; }
          if (val & 0x20) { this.ioPorts[2] = 0; this.ioPorts[3] = 0; }
          return;
        case 0x00F2: this.dspAddr = val & 0x7F; return;
        case 0x00F3: this.dsp.writeReg(this.dspAddr, val); return;
        case 0x00FA: this.timerDiv[0] = val; return;
        case 0x00FB: this.timerDiv[1] = val; return;
        case 0x00FC: this.timerDiv[2] = val; return;
      }
      // ROM 領域への書き込みは RAM に通す
      this.ram[addr] = val;
    }
  }

  // ── プレイヤー ────────────────────────────────────────────────────
  class SpcPlayer {
    /**
     * @param {Uint8Array} spcBytes - SPC ファイル全体
     */
    constructor(spcBytes) {
      this.spcBytes = spcBytes;
      this.header   = MML.SPC.parseHeader(spcBytes);

      // RAM コピー（DSP がエコー書き込みするので必ずコピーを使う）
      const ramSrc  = MML.SPC.getRam(spcBytes);
      this.ram      = new Uint8Array(65536);
      this.ram.set(ramSrc);

      // （旧「KON 蓄積バグ修正」パッチを削除。$0FDF の "09 48 5C" を書き換えて
      //  ドライバのコードを改変する対症療法だったが、真因は POP A/X/Y のフラグ
      //  誤更新（spc700.js で修正済み）だった。CPU がビット精度になった今、実機と
      //  同じコードをそのまま実行すべきで、ロード時のコード改変は実機と異なる
      //  挙動を生む有害物。現行の全SPCで発火しないことも確認済み。）

      // DSP レジスタ初期化
      this.dsp = new Emu.SpcDsp(this.ram);
      const dspRegs = MML.SPC.getDspRegs(spcBytes);
      for (let i = 0; i < 128; i++) this.dsp.writeReg(i, dspRegs[i]);
      this.dsp.onWrite = null; // ログは後から設定可能

      // BRR サンプル読み取り用の元 RAM コピー（エコーバッファ書き込みによる破壊を防ぐ）
      // エコーバッファと BRR サンプルが重複するゲームでも正しいサンプルデータを読める
      this.dsp.origRam = new Uint8Array(this.ram);

      // BRR ディレクトリをキャッシュしてからエコーバッファを完全クリア
      // エコーバッファと BRR ディレクトリが重複するゲームで FIR フィルターが
      // ディレクトリポインタ値を音声として解釈するアーティファクトを防ぐ。
      {
        const esa      = dspRegs[0x6D];
        const edl      = dspRegs[0x7D] & 0x0F;
        const dir      = dspRegs[0x5D];
        const echoBase = (esa << 8) & 0xFFFF;
        const dirBase  = (dir << 8) & 0xFFFF;
        // エコーバッファのバイトサイズ = EDL × 2KB（EDL=0 は最小 4 バイト）。
        // 以前は (edl+1)*512*4 = (edl+1)*2KB バイトをクリアしており、実サイズより
        // 大きく、かつ ESA が高位のゲーム（例: Unkai ESA=$D8/EDL=5 → 0xD800+）で
        // $FFFF を跨いでゼロページ($0000-)に回り込んでいた。その結果タイマー制御
        // レジスタ($F1/$FA)やドライバのゼロページ変数が 0 で破壊され、ドライバが
        // タイマー同期待ち（$FD ポーリング）で無限ループし「最初の音しか鳴らない/
        // 無音」状態になっていた。
        const echoBytes = edl ? edl * 2048 : 4;

        // ディレクトリ 256 エントリ × 4 バイト = 1024 バイトをキャッシュ
        this.dsp.brrDirCache = new Uint8Array(256 * 4);
        for (let i = 0; i < 256 * 4; i++) {
          this.dsp.brrDirCache[i] = this.ram[(dirBase + i) & 0xFFFF];
        }

        // エコー書き込みが無効（FLG bit5 = ECEN）のときは、その領域はエコー実体
        // ではなくドライバが曲データ等に流用している。実際 Final Fight の一部曲
        // （例 05/06/08、FLG=$20 で echo OFF・ESA=$0D）は $0D00-$14FF に曲データを
        // 置いており、ここをクリアするとトラックデータが 0 で潰れて全曲が同じ
        // 出鱈目（pitch=0→0x1F70…）に化けていた。echo 有効時のみクリアする。
        const echoOff = (dspRegs[0x6C] & 0x20) !== 0;
        if (!echoOff) {
          // エコーバッファをゼロクリア（ディレクトリ含む）。メモリマップド I/O
          // レジスタ領域 $00F0-$00FF は決してエコー実体ではないため保護する。
          for (let i = 0; i < echoBytes; i++) {
            const a = (echoBase + i) & 0xFFFF;
            if (a >= 0x00F0 && a <= 0x00FF) continue;
            this.ram[a] = 0;
          }
        }
      }

      // バス
      this.bus = new SpcBus(this.ram, this.dsp);

      // I/O ポートを RAM ダンプから初期化（ドライバが $F4-$F7 を読む前に正しい値を提供）
      // I/O ポートを RAM ダンプから初期化
      this.bus.ioPorts[0] = this.ram[0x00F4];
      this.bus.ioPorts[1] = this.ram[0x00F5];
      this.bus.ioPorts[2] = this.ram[0x00F6];
      this.bus.ioPorts[3] = this.ram[0x00F7];

      // ── タイマー状態を RAM ダンプから復元 ────────────────────────
      // SPC ダンプは演奏途中の状態なので $F1/$FA/$FB/$FC の値が有効
      const f1Init = this.ram[0x00F1];
      this.bus.romEnable    = (f1Init & 0x80) !== 0;
      this.bus.timerEn[0]   = (f1Init & 0x01) !== 0;
      this.bus.timerEn[1]   = (f1Init & 0x02) !== 0;
      this.bus.timerEn[2]   = (f1Init & 0x04) !== 0;
      this.bus.timerDiv[0]  = this.ram[0x00FA] || 256;
      this.bus.timerDiv[1]  = this.ram[0x00FB] || 256;
      this.bus.timerDiv[2]  = this.ram[0x00FC] || 256;
      // タイマーカウンタは 0 から開始（最大1周期後に最初のティック）
      this.bus.timerCnt[0]  = 0;
      this.bus.timerCnt[1]  = 0;
      this.bus.timerCnt[2]  = 0;

      // CPU
      this.cpu = new Emu.SPC700(this.bus);
      this.cpu.A   = this.header.a;
      this.cpu.X   = this.header.x;
      this.cpu.Y   = this.header.y;
      this.cpu.PSW = this.header.psw;
      this.cpu.SP  = this.header.sp;
      this.cpu.PC  = this.header.pc;

      // DSP クロックカウンタ
      this._dspCycleAcc = 0;

      // 再生速度(1=等速 〜 1/8=低速)。CPU/タイマーの実行頻度のみを間引き、
      // DSP(音声合成)は常に毎サンプル駆動するため音程は変わらずテンポだけ落ちる。
      this.speedFactor = 1;
      this._cpuAdvanceAccum = 0;

      // KON を DSP regs から取得して再発火（初期ボイス起動）
      const konInit = dspRegs[0x4C];
      if (konInit) {
        this.dsp.writeReg(0x4C, konInit);
        this.dsp.writeReg(0x4C, 0); // KON は 1 フレームだけ有効
      }
    }

    /** CPU が STOP/SLEEP でハルトしたか */
    get isHalted() { return this.cpu.halted; }

    /**
     * 1 DSP サンプル (32kHz) を生成。
     * 内部で CPU を 32 サイクル実行、DSP を 1 クロック駆動。
     * @returns {{ L: number, R: number }} -1.0〜+1.0
     */
    renderSample() {
      // speedFactor<1のときはCPU/タイマーの進行だけを間引く。DSPは常に
      // このメソッド呼び出し=実サンプルごとに1回クロックするため、サンプルの
      // 内部再生位置(音程)は変わらず、ノート/エンベロープの進行(テンポ)だけが遅くなる。
      this._cpuAdvanceAccum += this.speedFactor;
      if (this._cpuAdvanceAccum >= 1) {
        this._cpuAdvanceAccum -= 1;
        this.bus.tickTimers(CYCLES_PER_DSP);
        this.cpu.runCycles(CYCLES_PER_DSP);
      }
      this.dsp.clock();
      return { L: this.dsp.outL, R: this.dsp.outR };
    }

    /**
     * 指定秒数分の音声を出力サンプルレートで合成
     * @param {number} seconds
     * @param {number} outRate - 出力サンプルレート (例: 44100)
     * @returns {Float32Array} モノラル (L+R)/2
     */
    renderSeconds(seconds, outRate) {
      const outSamples  = Math.round(seconds * outRate);
      const result      = new Float32Array(outSamples);
      // 32kHz → outRate への変換比率
      let dspFrac       = 0;
      let lastL = 0, lastR = 0;

      for (let i = 0; i < outSamples; i++) {
        dspFrac += DSP_RATE / outRate;
        while (dspFrac >= 1.0) {
          const s = this.renderSample();
          lastL = s.L; lastR = s.R;
          dspFrac -= 1.0;
        }
        result[i] = (lastL + lastR) * 0.5;
      }
      return result;
    }
  }

  Emu.SpcPlayer = SpcPlayer;
  Emu.SpcBus    = SpcBus;
  Emu.DSP_RATE  = DSP_RATE;

})(globalThis);

/*
 * SPC → MML コンバータ
 * MML.SPC2MML.fromSpc(spcBytes, durationSec, options) → { mml, dmcFiles, bpm, expansion }
 *
 * options.channelMap  : 長さ8の配列。各要素は { type: string } または null(スキップ)
 *   type の値:
 *     'skip'
 *     'pulse1'|'pulse2'|'triangle'|'noise'   … 2A03
 *     'dpcm'                                  … 2A03 DMC (BRR→DPCM変換)
 *     'fds'                                   … FDS 波形
 *     'vrc6pulse1'|'vrc6pulse2'|'vrc6saw'     … VRC6
 *     'mmc5pulse1'|'mmc5pulse2'               … MMC5
 *     'fme7a'|'fme7b'|'fme7c'                 … FME7
 *     'n163_0'|'n163_1'|'n163_2'|'n163_3'    … N163
 * options.bpm         : BPM (省略時はマッピング済みチャンネルの音長から自動検出)
 */
(function (global) {
  'use strict';
  const MML    = global.MML    = global.MML    || {};
  MML.SPC2MML  = MML.SPC2MML  || {};

  const DSP_RATE        = 32000;
  const SAMPLES_PER_FRAME = Math.round(DSP_RATE / 60);
  const FPS_SPC          = DSP_RATE / SAMPLES_PER_FRAME; // 実効フレームレート
  MML.SPC2MML.FRAME_RATE = FPS_SPC; // capture()完了を待たずにフレームレートだけ知りたい呼び出し元向け

  // ── type → 2A03固定チャンネル文字(拡張音源分はassignExpansionLettersで決定) ──
  const TYPE_TO_LETTER = {
    pulse1: 'A', pulse2: 'B', triangle: 'C', noise: 'D',
  };

  // type → 拡張音源名
  const TYPE_TO_EXPANSION = {
    fds:       'fds',
    vrc6pulse1:'vrc6', vrc6pulse2:'vrc6', vrc6saw:'vrc6',
    mmc5pulse1:'mmc5', mmc5pulse2:'mmc5',
    fme7a:     'fme7', fme7b:'fme7', fme7c:'fme7',
    n163_0:    'n163', n163_1:'n163', n163_2:'n163', n163_3:'n163',
  };

  // type → そのチップ内でのチャンネル通し番号(0始まり)。
  // src/mml/compiler.jsのassignExpansionLettersが返す配列のインデックスに対応する。
  const TYPE_TO_CHIP_INDEX = {
    fds: 0,
    vrc6pulse1: 0, vrc6pulse2: 1, vrc6saw: 2,
    mmc5pulse1: 0, mmc5pulse2: 1,
    fme7a: 0, fme7b: 1, fme7c: 2,
    n163_0: 0, n163_1: 1, n163_2: 2, n163_3: 3,
  };

  // ── ピッチ変換 ───────────────────────────────────────────────────────
  // pitch: DSP 14bit ピッチ値。tune: そのボイスが使うBRRサンプルの原音チューニング
  // 補正(半音, 実数)。tune=0 は「原音=C5(約523Hz)で pitch=0x1000 のとき note 60」
  // という従来の固定仮定に一致する(後方互換)。
  //
  // SNESの各楽器サンプルは固有のチューニングを持ち、ピッチレジスタだけでは絶対音程が
  // 決まらない(pitch=0x1000 は「サンプルを原音のまま32kHzで鳴らす」という意味でしか
  // なく、その原音が何Hzかはサンプル次第)。原音がC5からずれるサンプルでは、この固定
  // 仮定のままだと実機と数半音ズレる(例: HyperZone「Old Capital」の主旋律サンプルは
  // 原音≈333Hz=E4付近で、C5仮定だと約8半音高く出てしまっていた)。computeSrcnFineTune
  // が実測した基本周波数から算出した tune を渡すことで実機の発音音程に一致させる。
  function pitchToSemitone(pitch, tune = 0) {
    if (pitch <= 0) return null;
    const semi = Math.round(12 * Math.log2(pitch / 0x1000) + tune) + 60;
    return (semi >= 0 && semi <= 119) ? semi : null;
  }

  // pitchToSemitoneの丸めない連続版をHzへ変換する(DESIGN-PITCH.md Phase 1、
  // ev.pitchSeqを借用先チップの生レジスタ空間へ変換する前段としてHzを経由する)。
  // continuousSemi(57基準)=12*log2(pitch/0x1000)+tune+60 → freq=440*2^((continuousSemi-57)/12)
  // = 440*(pitch/4096)*2^((tune+3)/12)
  function pitchRegToFreqHz(pitch, tune) {
    return pitch > 0 ? 440 * (pitch / 4096) * Math.pow(2, ((tune || 0) + 3) / 12) : 0;
  }

  // ── 借用先チップの生レジスタ空間への変換式(compiler.js/nsf2mml/converter.jsの
  // 各periodFnと同じ、丸めない連続値。DESIGN-PITCH.md Phase 1、EP<n>用) ──────
  const CPU_CLOCK_NTSC = 1789773; // 借用先(2A03/VRC6/MMC5/FME7/FDS/N163)のクロック
  function pulsePeriodRaw(freq)   { return CPU_CLOCK_NTSC / (16 * freq) - 1; }   // 2A03/MMC5パルス
  function triPeriodRaw(freq)     { return CPU_CLOCK_NTSC / (32 * freq) - 1; }   // 2A03三角波
  function vrc6PulsePeriodRaw(freq) { return CPU_CLOCK_NTSC / (16 * freq) - 1; } // VRC6パルス
  function vrc6SawPeriodRaw(freq) { return CPU_CLOCK_NTSC / (14 * freq) - 1; }   // VRC6サウ
  function fme7ToneRaw(freq)      { return CPU_CLOCK_NTSC / (32 * freq); }       // FME7
  function fdsPeriodRawSpc(freq)  { return freq * 65536 * 64 / CPU_CLOCK_NTSC; } // FDS
  // N163: pcmToN163Wave()が常に16サンプルへリサンプリングするためwaveLen固定16。
  // numChはSPC変換で実際に確保されるN163ch数(expansionLetters.length)を呼び出し側から渡す。
  function n163FreqRegRawSpc(freq, numCh) { return freq * 15 * 65536 * 16 * numCh / CPU_CLOCK_NTSC; }

  // type文字列(options.channelMap[ch].type)→借用先の生周期変換関数。ノイズ/DPCM/skipは
  // 対象外(null)。VRC7/OPLLはこのアプリのSPC変換先候補に無いため定義不要。
  function periodFnForType(type, n163NumCh) {
    switch (type) {
      case 'pulse1': case 'pulse2': case 'mmc5pulse1': case 'mmc5pulse2': return pulsePeriodRaw;
      case 'triangle': return triPeriodRaw;
      case 'vrc6pulse1': case 'vrc6pulse2': return vrc6PulsePeriodRaw;
      case 'vrc6saw': return vrc6SawPeriodRaw;
      case 'fme7a': case 'fme7b': case 'fme7c': return fme7ToneRaw;
      case 'fds': return fdsPeriodRawSpc;
      case 'n163_0': case 'n163_1': case 'n163_2': case 'n163_3':
        return (freq) => n163FreqRegRawSpc(freq, n163NumCh);
      default: return null;
    }
  }

  // ── BRR サンプルの原音(基本周波数)検出 ───────────────────────────
  // pitch=0x1000(原音・32kHz再生)で鳴らした時の基本周波数[Hz]を自己相関で推定する。
  // 旋律楽器のように明確な周期を持つ波形では高い信頼度で検出できる。打楽器/ノイズは
  // 周期が不明瞭で信頼度が低くなるため、呼び出し側(computeSrcnFineTune)で閾値により
  // フォールバックする。倍音/低調波の取り違えを避けるため、自己相関のピーク(全体最大の
  // 90%超)のうち最短ラグ=基本波を採用する。
  function detectBrrFundamental(brrBytes) {
    const pcm = decodeBrrBytes(brrBytes);
    const L0 = pcm.length;
    if (L0 < 128) return null;
    // アタックの過渡を避けるため少し後ろから、かつ長すぎる場合は上限を設けて定常部を見る
    const start = Math.min(L0 >> 2, 512);
    const end   = Math.min(L0, start + 4000);
    const N = end - start;
    if (N < 128) return null;
    let mean = 0;
    for (let i = start; i < end; i++) mean += pcm[i];
    mean /= N;
    const s = new Float64Array(N);
    for (let i = 0; i < N; i++) s[i] = pcm[start + i] - mean;
    const minLag = 8, maxLag = Math.min(1600, N >> 1);
    let gMax = -Infinity;
    const vals = new Float64Array(maxLag);
    for (let lag = minLag; lag < maxLag; lag++) {
      let sum = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + lag < N; i++) { sum += s[i] * s[i + lag]; e1 += s[i] * s[i]; e2 += s[i + lag] * s[i + lag]; }
      const norm = sum / (Math.sqrt(e1 * e2) || 1);
      vals[lag] = norm;
      if (norm > gMax) gMax = norm;
    }
    if (gMax <= 0) return null;
    const thr = 0.9 * gMax;
    let period = -1;
    for (let lag = minLag + 1; lag < maxLag - 1; lag++) {
      if (vals[lag] > thr && vals[lag] >= vals[lag - 1] && vals[lag] >= vals[lag + 1]) { period = lag; break; }
    }
    if (period < 1) return null;
    return { freq: DSP_RATE / period, conf: gMax };
  }

  // ── srcn ごとの原音チューニング補正(半音)を算出 ─────────────────
  // 各BRRサンプルの実測基本周波数を、pitchToSemitoneの+60が暗黙に仮定する原音 C5
  // (REFERENCE_HZ)と比較した半音差として返す。旋律的で信頼度の高いサンプルのみ補正し、
  // 打楽器/ノイズなど周期が不明瞭なもの(信頼度が閾値未満)は補正せず(=従来動作)に
  // フォールバックする。これによりドラム等の退行を避けつつ、音階の合っていた曲
  // (原音がC5付近のサンプル→補正≈0)も従来どおりの結果を保つ。
  const REFERENCE_HZ = 440 * Math.pow(2, 3 / 12); // ≈523.25Hz(C5)
  const FUNDAMENTAL_CONF_MIN = 0.8;
  function computeSrcnFineTune(brrSamples) {
    const tune = {};
    if (!brrSamples) return tune;
    for (const srcn in brrSamples) {
      const brr = brrSamples[srcn];
      if (!brr || !brr.bytes || brr.bytes.length === 0) continue;
      const f = detectBrrFundamental(brr.bytes);
      if (f && f.conf >= FUNDAMENTAL_CONF_MIN && f.freq > 0) {
        tune[srcn] = 12 * Math.log2(f.freq / REFERENCE_HZ);
      }
    }
    return tune;
  }
  MML.SPC2MML.computeSrcnFineTune = computeSrcnFineTune;
  // BPM検出・音長量子化・チャンネルMML生成は共通モジュール
  // (src/convert/bpm.js, duration.js, mmlEmit.js) に切り出し済み。

  // ── ADSR/GAINエンベロープ → ppmck @v/@vr テーブル抽出 ───────────────
  // src/emulator/spcDsp.js の _updateEnvelope と同じレート表・計算式を
  // 1DSPサンプル(32kHz)刻みで再現し、1フレーム(約533サンプル)ごとに
  // サンプリングして 0-15 に量子化する。実際にDSPを鳴らすのではなく、
  // 与えられたADSR1/ADSR2/GAINからカーブを机上シミュレートするだけ。
  const ENV_RATE_TABLE = [
    0,2048,1536,1280,1024,768,640,512,
    384,320,256,192,160,128,96,80,
    64,48,40,32,24,20,16,12,
    10,8,6,5,4,3,2,1,
  ];

  // 末尾が一定値に収束していたら切り詰める(ppmckの「|省略時は末尾値を保持」仕様に委ねる)
  function trimConstantTail(values) {
    while (values.length > 1 && values[values.length - 1] === values[values.length - 2]) values.pop();
    if (values.length === 0) values.push(0);
    return values;
  }

  // KON時点のADSR1/ADSR2/GAINから、アタック〜サステインのエンベロープを
  // maxFrames分シミュレートし、1フレーム1値(0-15)の配列にする。
  function simulateSpcEnvelope(adsr1, adsr2, gain, maxFrames) {
    const adsrEn = adsr1 & 0x80;
    let env = 0, envMode = 'attack', envRate = 0;
    const perFrame = [];
    const totalTicks = maxFrames * SAMPLES_PER_FRAME;

    for (let tick = 0; tick < totalTicks; tick++) {
      if (envMode !== 'off') {
        if (!adsrEn) {
          const mode = (gain >> 5) & 3;
          const rate = gain & 0x1F;
          if (gain & 0x80) {
            envRate++;
            if (envRate >= ENV_RATE_TABLE[rate]) {
              envRate = 0;
              switch (mode) {
                case 0: env -= 32; break;
                case 1: env -= ((env - 1) >> 8) + 1; break;
                case 2: env += 32; break;
                case 3: env += (env < 0x600) ? 32 : 8; break;
              }
            }
          } else {
            env = (gain & 0x7F) << 4;
          }
        } else if (envMode === 'attack') {
          const ar = adsr1 & 0x0F;
          const rate = ar === 15 ? 31 : ar * 2 + 1;
          envRate++;
          if (envRate >= ENV_RATE_TABLE[rate]) {
            envRate = 0;
            env += (ar === 15) ? 1024 : 32;
            if (env >= 0x7E0) { env = 0x7E0; envMode = 'decay'; }
          }
        } else if (envMode === 'decay') {
          const dr = (adsr1 >> 4) & 0x07;
          const rate = 8 + dr * 2;
          envRate++;
          if (envRate >= ENV_RATE_TABLE[rate]) {
            envRate = 0;
            env -= ((env - 1) >> 8) + 1;
            const sl = (adsr2 >> 5) & 0x07;
            const sustLevel = (sl + 1) << 8;
            if (env <= sustLevel) { env = sustLevel; envMode = 'sustain'; }
          }
        } else if (envMode === 'sustain') {
          const sr = adsr2 & 0x1F;
          if (sr !== 0) {
            envRate++;
            if (envRate >= ENV_RATE_TABLE[sr]) {
              envRate = 0;
              env -= ((env - 1) >> 8) + 1;
              if (env <= 0) { env = 0; envMode = 'off'; }
            }
          }
        }
        env = Math.max(0, Math.min(0x7FF, env));
      }
      if ((tick + 1) % SAMPLES_PER_FRAME === 0) {
        perFrame.push(Math.round((env / 0x7FF) * 15));
      }
    }
    return trimConstantTail(perFrame);
  }

  // キーオフ後のリリースカーブをシミュレートする。実機ではADSR/GAINの設定に
  // 関係なく常に固定の指数減衰レートなので、曲全体で1つだけ生成すればよい。
  // (どの音量から離鍵されたかは考慮せず、フル音量からの減衰で近似する)
  function simulateSpcRelease(maxFrames) {
    let env = 0x7E0;
    const perFrame = [];
    const totalTicks = maxFrames * SAMPLES_PER_FRAME;

    for (let tick = 0; tick < totalTicks; tick++) {
      if (env > 0) {
        env -= ((env - 1) >> 8) + 1;
        if (env < 0) env = 0;
      }
      if ((tick + 1) % SAMPLES_PER_FRAME === 0) {
        perFrame.push(Math.round((env / 0x7FF) * 15));
      }
    }
    return trimConstantTail(perFrame);
  }

  // ── BRR バイト列 → PCM (Float32Array, -1..1) ────────────────────────
  function decodeBrrBytes(brrBytes) {
    const pcm = [];
    let prev1 = 0, prev2 = 0;
    for (let blk = 0; blk + 8 < brrBytes.length; blk += 9) {
      const header = brrBytes[blk];
      const shift  = header >> 4;
      const filter = (header >> 2) & 3;
      const end    = header & 1;

      for (let i = 0; i < 8; i++) {
        const byte = brrBytes[blk + 1 + i];
        for (let nib = 0; nib < 2; nib++) {
          const raw = nib === 0 ? (byte >> 4) : (byte & 0xF);
          let s = (raw & 8) ? (raw | 0xFFFFFFF0) : raw;
          if (shift <= 12) { s = (s << shift) >> 1; }
          else             { s = (s >> 3) & ~1; }
          switch (filter) {
            case 1: s += prev1 - (prev1 >> 4); break;
            case 2: s += (prev1 << 1) - ((prev1 * 3) >> 5) - prev2 + (prev2 >> 4); break;
            case 3: s += (prev1 << 1) - ((prev1 * 13) >> 6) - prev2 + ((prev2 * 3) >> 4); break;
          }
          s = Math.max(-32768, Math.min(32767, s));
          s = (s << 1) >> 1;
          pcm.push(s / 32768);
          prev2 = prev1;
          prev1 = s;
        }
      }
      if (end) break;
    }
    return new Float32Array(pcm);
  }

  // ── PCM 1周期 → FDS 波形 (64点 0-63) ───────────────────────────────
  function pcmToFdsWave(pcm) {
    const wave = new Array(64);
    for (let i = 0; i < 64; i++) {
      const srcPos = (i / 64) * pcm.length;
      const i0 = Math.floor(srcPos) % pcm.length;
      const v  = pcm[i0];
      wave[i] = Math.max(0, Math.min(63, Math.round((v * 0.5 + 0.5) * 63)));
    }
    return wave;
  }

  // ── PCM 1周期 → N163 波形 (16点 0-15) ──────────────────────────────
  function pcmToN163Wave(pcm) {
    const wave = new Array(16);
    for (let i = 0; i < 16; i++) {
      const srcPos = (i / 16) * pcm.length;
      const i0 = Math.floor(srcPos) % pcm.length;
      const v  = pcm[i0];
      wave[i] = Math.max(0, Math.min(15, Math.round((v * 0.5 + 0.5) * 15)));
    }
    return wave;
  }

  // ── PCM → DPCM エンコード (MML.Dpcm.encode を利用) ─────────────────
  function brrToDpcm(brrBytes, rateIndex) {
    const pcm = decodeBrrBytes(brrBytes);
    return MML.Dpcm.encode(pcm, DSP_RATE, rateIndex != null ? rateIndex : 15);
  }

  // ── SPC キャプチャ ───────────────────────────────────────────────────
  // ディレクトリ($5D)を辿ってROM上の全BRRサンプルを収集する(capture/captureAsync共通)。
  function _collectBrrSamples(player) {
    const brrSamples = {};
    const dir = player.dsp.regs[0x5D];
    for (let srcn = 0; srcn < 256; srcn++) {
      const dirAddr  = ((dir << 8) + srcn * 4) & 0xFFFF;
      const startAddr = player.ram[dirAddr] | (player.ram[(dirAddr+1) & 0xFFFF] << 8);
      if (startAddr === 0) break;
      const brrBytes = [];
      let addr = startAddr;
      for (let blk = 0; blk < 4096; blk++) {
        const header = player.ram[addr & 0xFFFF];
        for (let b = 0; b < 9; b++) brrBytes.push(player.ram[(addr + b) & 0xFFFF]);
        if (header & 1) break;
        addr += 9;
      }
      brrSamples[srcn] = { startAddr, bytes: new Uint8Array(brrBytes) };
    }
    return brrSamples;
  }

  // .spcファイルは「曲の演奏途中の瞬間」をダンプしたスナップショットであることが多く、
  // 保存されたDSPレジスタ自体が既にKON済み(アタック中)のボイスを含んでいることがある。
  // この初期状態はSpcPlayerのコンストラクタ内(ログ記録を始める前)に一度だけ適用されて
  // しまうため、onWriteフックでは一切観測できず、extractVoiceEvents側は「そのボイスの
  // KONが来るまで無音」として扱ってしまい、実際には曲の最初から鳴っている音がロール/MML
  // 変換のどちらにも一切現れない不具合になっていた(実SPCで確認)。そこで、SpcPlayerが
  // 内部で読み込むのと同じ生のDSPレジスタ値(MML.SPC.getDspRegs、player.dsp.regsではない
  // ―― KONレジスタは_keyOn発火後クリアされてしまうため必ずファイルの生バイトを使う)を
  // frame0の先頭に疑似的な書き込みとして注入し、フレーム0時点で既に鳴っているボイスを
  // 正しく認識できるようにする。
  function _seedInitialFrame(frameLog, spcBytes) {
    const dspRegs = MML.SPC.getDspRegs(spcBytes);
    for (let reg = 0; reg < 128; reg++) frameLog[0].push({ reg, val: dspRegs[reg] });
  }

  MML.SPC2MML.capture = function (spcBytes, durationSec) {
    const player  = new MML.Emu.SpcPlayer(spcBytes);
    const totalDspSamples = Math.round(durationSec * DSP_RATE);
    const frames  = Math.ceil(totalDspSamples / SAMPLES_PER_FRAME);
    const frameLog = Array.from({ length: frames }, () => []);
    _seedInitialFrame(frameLog, spcBytes);

    let frame = 0, samplesInFrame = 0;
    player.dsp.onWrite = (reg, val) => {
      if (frame < frames) frameLog[frame].push({ reg: reg & 0x7F, val });
    };

    for (let s = 0; s < totalDspSamples; s++) {
      samplesInFrame++;
      player.renderSample();
      if (samplesInFrame >= SAMPLES_PER_FRAME) { samplesInFrame = 0; frame++; }
    }

    return { log: frameLog, brrSamples: _collectBrrSamples(player), frameRate: FPS_SPC };
  };

  // captureの非同期チャンク版。SPCは事前レンダリングを持たない完全リアルタイム合成
  // フォーマットのため、ピアノロールの先読み表示はこの関数で裏キャプチャした結果を使う
  // (src/emulator/kssPlayer.js の captureKssSongAsync と同じ「一定量ごとにイベント
  // ループへ制御を返す」パターン)。onProgressにはその時点までのframeLog(同一配列参照、
  // 伸びていく)も渡すので、キャプチャ完了を待たずに途中経過だけでピアノロールを段階的に
  // 埋めていける。戻り値はcapture()と同じ { log, brrSamples } 形。
  MML.SPC2MML.captureAsync = async function (spcBytes, durationSec, onProgress, shouldCancel, opt = {}) {
    const player  = new MML.Emu.SpcPlayer(spcBytes);
    const totalDspSamples = Math.round(durationSec * DSP_RATE);
    const frames  = Math.ceil(totalDspSamples / SAMPLES_PER_FRAME);
    const frameLog = Array.from({ length: frames }, () => []);
    _seedInitialFrame(frameLog, spcBytes);

    let frame = 0, samplesInFrame = 0;
    player.dsp.onWrite = (reg, val) => {
      if (frame < frames) frameLog[frame].push({ reg: reg & 0x7F, val });
    };

    // ★2026-08-20 スライスを「フレーム数固定(CHUNK_FRAMES=10)」から「時間予算固定」へ変更
    // (capture.js captureSongAsyncと同じ方式・同じ理由。端末速度差の自動吸収)。
    // Worker実行時(src/audio/capture-worker-client.js)はopt.yieldFn/sliceBudgetMsで
    // 上書きされる。frame===1で必ず一度onProgressを発火するのも同様(最初のonProgressで
    // 実再生のplayer.load()が走るため。SPCはフレームレンダリングが重く、旧来の
    // 10フレーム待ちは再生開始遅延としてそのまま効いていた)。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : 5;
    const yieldFn = opt.yieldFn || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    let sliceStart = performance.now();
    for (let s = 0; s < totalDspSamples; s++) {
      samplesInFrame++;
      player.renderSample();
      if (samplesInFrame >= SAMPLES_PER_FRAME) {
        samplesInFrame = 0;
        frame++;
        if (frame === 1 || performance.now() - sliceStart >= sliceBudgetMs) {
          if (onProgress) onProgress(frame, frames, frameLog);
          await yieldFn();
          // 曲切替/停止の連打で先読みキャプチャが何本も積み上がりCPUを食い合うのを防ぐため、
          // 呼び出し元から「もう不要」と言われたらここでループ自体を打ち切る(onProgress側だけ
          // 無視してもエミュレーション自体は最後まで回り続けてしまうため不十分だった)。
          if (shouldCancel && shouldCancel()) {
            return { log: frameLog, brrSamples: _collectBrrSamples(player), frameRate: FPS_SPC };
          }
          sliceStart = performance.now();
        }
      }
    }
    if (onProgress) onProgress(frames, frames, frameLog);

    return { log: frameLog, brrSamples: _collectBrrSamples(player), frameRate: FPS_SPC };
  };

  // ── DSPログ(フレーム単位のreg/val書き込み列)からボイスごとのノートイベントを抽出 ──
  // 戻り値: 長さ8の配列、各要素は {frame, len, pitchSemi, srcn, adsr1, adsr2, gain} の配列。
  // MML変換(convert)とピアノロールの先読みタイムライン構築の両方から使う共通ロジック。
  //
  // KON(キーオン)だけでなく、ノート途中のピッチレジスタ変化(KONを送り直さずピッチだけ
  // 書き換えて音を滑らかに繋ぐ「ポルタメント/レガート」。ゲーム音楽のSPCドライバでは
  // 一般的な手法)でもイベントを区切り直す。KONを再送しない限り音程が変わったことを検知
  // できず、実際には音程が動いているのに1つの固定ピッチのノートとして出力されてしまう
  // 問題があったため(ロールで発見、実SPCで確認済み)。
  //
  // ★ただし「新しいピッチに変わった瞬間」を無条件に区切ると、ビブラート(音を伸ばしながら
  // 半音境界をまたいで細かく音程を揺らす奏法。ギター/リードパートで非常によく使われる)まで
  // 1フレームごとに別々の新しい音符として誤検出し、極薄(1フレーム程度)の音符の連続に
  // 化けて描画も崩れる不具合があった(実SPCのピクセル単位検証で確認)。
  // ★2026-08-10(DESIGN-PITCH.md Phase 2): 以前はここで独自のPITCH_CONFIRM_FRAMES
  // デバウンス(候補ピッチがNフレーム続くまで確定しない)を行っていたが、他形式と同じ
  // 「即座に分割してから後段でmergeAlternatingVibratoにより統合する」方式に統一した
  // (境界判定そのものは変えず、統合だけを共有ロジックに委ねるINV-3の原則)。
  // 分割直後の配列はmergeSpcVoiceEvents()で後処理する。

  MML.SPC2MML.extractVoiceEvents = function (log, options = {}) {
    const FRAMES = log.length;
    // srcn → 原音チューニング補正(半音)。未指定なら全サンプル補正0(=従来動作)。
    // ピッチ→ノート変換は、その音符を鳴らしているサンプル(activeSrcn)固有の補正を使う。
    const srcnFineTune = options.srcnFineTune || null;
    const tuneOf = (srcn) => srcnFineTune ? (srcnFineTune[srcn] || 0) : 0;

    // ── DSP ログをフレームごとに追跡 ────────────────────────────────
    const dspState   = new Uint8Array(128);
    const konLatched  = new Uint8Array(FRAMES);
    const koffLatched = new Uint8Array(FRAMES);

    for (let f = 0; f < FRAMES; f++) {
      for (const { reg, val } of log[f]) {
        dspState[reg] = val;
        if (reg === 0x4C) konLatched[f]  |= val;
        if (reg === 0x5C) koffLatched[f] |= val;
      }
    }

    // ── ボイスごとのピッチ履歴 (KONタイミング時点のdspStateから取得) ─
    // dspState は上のループで最終状態になっているので、
    // ボイスイベント抽出は別パスで行う。
    const voiceEvents = Array.from({ length: 8 }, () => []);

    for (let ch = 0; ch < 8; ch++) {
      const voiceDsp = new Uint8Array(8); // このボイスのレジスタ追跡用
      let activePitch = 0, activeSrcn = 0, activeStart = -1;
      let activeAdsr1 = 0, activeAdsr2 = 0, activeGain = 0;
      // pitchSeq(DESIGN-PITCH.md Phase 0): 確定済みセグメントのフレーム毎生ピッチレジスタ値。
      let activePitchSeq = [];
      // pendingTieCandidate(別プロジェクトE、2026-08-12): 次にpushされるイベントが
      // 「純粋な音程変化のみ」による区切りで始まったか(=スラー分割のタイ候補か)を
      // 一時保持する。KON(本物のアタック)/KOFF後の再開時はfalseにリセットする。
      let pendingTieCandidate = false;

      for (let f = 0; f < FRAMES; f++) {
        for (const { reg, val } of log[f]) {
          const vc = reg >> 4, r = reg & 0x0F;
          if (vc !== ch) continue;
          voiceDsp[r] = val;
        }
        const curPitch = voiceDsp[0x02] | ((voiceDsp[0x03] & 0x3F) << 8);
        // 音程比較・区切りは、現在鳴っているノートのサンプル(activeSrcn)の補正で統一する
        // (1音符の間 srcn は不変なので curPitch/activePitch とも同じ補正を使えばよい)。
        const curPitchSemi = pitchToSemitone(curPitch, tuneOf(activeSrcn));
        const activePitchSemi = pitchToSemitone(activePitch, tuneOf(activeSrcn));

        if (konLatched[f] & (1 << ch)) {
          if (activeStart >= 0) {
            voiceEvents[ch].push({ frame: activeStart, len: f - activeStart, pitch: activePitch, pitchSemi: activePitchSemi, srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
          }
          activePitch = curPitch;
          activeSrcn  = voiceDsp[0x04];
          activeAdsr1 = voiceDsp[0x05];
          activeAdsr2 = voiceDsp[0x06];
          activeGain  = voiceDsp[0x07];
          activeStart = f;
          activePitchSeq = [curPitch];
          pendingTieCandidate = false; // KON=本物のアタックなので次のイベントはタイ候補ではない
        } else if (activeStart >= 0 && curPitchSemi !== activePitchSemi) {
          // ポルタメント/レガート: KONを送り直さない音程変化はここで即座に区切る
          // (ビブラートによる細切れ化はmergeSpcVoiceEvents()の共有ロジックで後統合する、
          // DESIGN-PITCH.md Phase 2)。KONが無い=まさに「純粋な音程変化のみによる区切り」
          // なので、次に始まるイベント(=今まさに開始するイベント。まだ未pushで、
          // このelse if節の中でactiveStart=fに更新される)をスラー分割のタイ候補とする
          // (pendingTieCandidateに立てておき、そのイベントが実際にpushされる時に読む。
          // 別プロジェクトE、2026-08-12)
          voiceEvents[ch].push({ frame: activeStart, len: f - activeStart, pitch: activePitch, pitchSemi: activePitchSemi, srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
          activePitch = curPitch;
          activeSrcn  = voiceDsp[0x04];
          activeAdsr1 = voiceDsp[0x05];
          activeAdsr2 = voiceDsp[0x06];
          activeGain  = voiceDsp[0x07];
          activeStart = f;
          activePitchSeq = [curPitch];
          pendingTieCandidate = true; // このイベントを閉じたのは純粋な音程変化 → 次のイベントはタイ候補
        } else if (activeStart >= 0) {
          activePitchSeq.push(curPitch);
        }
        // 同じフレーム内にこのボイスのKONも来ている場合、そのKOFFは無視する。
        // 実機のDSPはKON/KOFFが同一タイミングで競合するとKON側が優先され、
        // ノートは途切れずクリーンに継続/再始動する(音が鳴ったまま次に繋がる)。
        // ここでKOFFを適用してしまうと、KONで開いたばかりのノートを同フレームで
        // 即座に閉じてしまい、幅1フレームの偽ノートが生成され、かつその直後の
        // 本物のピッチ変化(レガート)が「無音状態からの変化」として完全に無視
        // されてしまう不具合があった(実SPCのV5パートで確認、ノート脱落の原因)。
        if ((koffLatched[f] & (1 << ch)) && !(konLatched[f] & (1 << ch))) {
          if (activeStart >= 0) {
            voiceEvents[ch].push({ frame: activeStart, len: Math.max(1, f - activeStart), pitch: activePitch, pitchSemi: pitchToSemitone(activePitch, tuneOf(activeSrcn)), srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
            activeStart = -1;
            activePitchSeq = [];
            pendingTieCandidate = false; // KOFF後、次に始まるノートは新規アタックなのでタイ候補ではない
          }
        }
      }
      if (activeStart >= 0) {
        voiceEvents[ch].push({ frame: activeStart, len: Math.max(1, FRAMES - activeStart), pitch: activePitch, pitchSemi: pitchToSemitone(activePitch, tuneOf(activeSrcn)), srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
      }
      // rawFreq(高速アルペジオ→EN統合のセント判定用、2026-08-14拡張): mergeSpcVoiceEvents
      // (外側のIIFEスコープの関数でtuneOfへ直接アクセスできない)へ渡す前にここで計算して
      // 各イベントへ付与しておく(DESIGN-PITCH.md Phase 1のpitchRegToFreqHzを流用)。
      for (const ev of voiceEvents[ch]) ev.rawFreq = pitchRegToFreqHz(ev.pitch, tuneOf(ev.srcn));
      voiceEvents[ch] = mergeSpcVoiceEvents(voiceEvents[ch]);
    }

    return voiceEvents;
  };

  // 即座に分割されたvoiceEvents(frame/len/pitchSemi/pitchSeq/srcn/adsr/gain形式)を
  // 共有のMML.Convert.mergeAlternatingVibrato(start/end/note形式)へ橋渡しするアダプタ。
  // KOFFで打ち切られた休符区間はvoiceEvents自体に含まれない(=配列内で隣接しない)ため、
  // 休符ぶんのダミー区切り(note:null)を挟んでから渡すことで、休符を跨いだ誤統合を防ぐ
  // (他形式は休符も1イベントとして持つため自然に区切られるが、SPCの配列表現には無い)。
  function mergeSpcVoiceEvents(events) {
    const mapped = [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (i > 0) {
        const prevEnd = events[i - 1].frame + events[i - 1].len;
        if (ev.frame !== prevEnd) mapped.push({ start: prevEnd, end: ev.frame, note: null });
      }
      mapped.push({
        start: ev.frame, end: ev.frame + ev.len, note: ev.pitchSemi, pitch: ev.pitch,
        rawFreq: ev.rawFreq,
        pitchSeq: ev.pitchSeq, srcn: ev.srcn, adsr1: ev.adsr1, adsr2: ev.adsr2, gain: ev.gain,
        tieCandidate: ev.tieCandidate
      });
    }
    // 高速アルペジオ→EN統合(2026-08-14拡張)。登録(noteEnvReg.registerShape)は
    // 呼び出し元のfromSpcがpitchRegと同じタイミングで曲全体共有のnoteEnvRegを使って
    // 行う(ay.js/scc.js/opll.jsと同じ「検出はここ、登録は呼び出し元」の遅延登録方式)。
    // その後にP-5「不明瞭→EPテーブル」側(スラー分割の相方、2026-08-12)。
    return MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(mapped))
      .filter(ev => ev.note != null)
      .map(ev => Object.assign({
        frame: ev.start, len: ev.end - ev.start, pitch: ev.pitch, pitchSemi: ev.note,
        srcn: ev.srcn, adsr1: ev.adsr1, adsr2: ev.adsr2, gain: ev.gain, pitchSeq: ev.pitchSeq,
        tieCandidate: ev.tieCandidate
      }, ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}));
  }

  // ── MML 生成 ─────────────────────────────────────────────────────────
  MML.SPC2MML.convert = function (log, brrSamples, options = {}) {
    const FRAMES = log.length;

    // デフォルトマップ: V0→A, V1→B ... V3→D, V4→スキップ
    const DEFAULT_TYPES = ['pulse1','pulse2','triangle','noise','skip','skip','skip','skip'];
    const channelMap = options.channelMap || DEFAULT_TYPES.map(t => ({ type: t }));

    // 各BRRサンプルの実測原音から音程補正マップを作り、ノート抽出に反映する
    // (これにより実機の発音音程=SPC再生と一致する)。
    const srcnFineTune = computeSrcnFineTune(brrSamples);
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    const tuneOf = (srcn) => srcnFineTune ? (srcnFineTune[srcn] || 0) : 0;
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14拡張)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry();

    // ── BPM (未指定ならマッピング済みチャンネルの有音イベントから自動検出、
    //         指定時もフレームグリッドへ吸着補正) ──
    // 音長(len)に加え、チャンネル毎の発音開始間隔(IOI)も検出材料にする。
    // IOIはゲートタイムで音符が短く切られてもグリッドに乗るため頑健。
    const noteDurations = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;
      const sounding = voiceEvents[ch].filter(ev => ev.pitchSemi !== null);
      for (const ev of sounding) noteDurations.push(ev.len);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.frame)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, FPS_SPC)
      : MML.Convert.detectBpm(noteDurations, FPS_SPC);
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパートで誤差が蓄積してドリフトする
    // ([[tempo-rounding-drift-future-issue]]参照)。
    const fpb = FPS_SPC * 60 / Math.round(bpm);

    // ── ADSR/GAIN → ppmck @v/@vr テーブル抽出 (2A03 pulse/noise のみ対象) ──
    // 同じ (adsr1,adsr2,gain) の組み合わせは同じ音色とみなし @vN を共有する。
    // リリースは実機的に音色非依存の固定カーブなので曲全体で @vr0 を1つだけ使う。
    const ENV_CAPABLE_TYPES = new Set(['pulse1', 'pulse2', 'noise']);
    const MAX_ENV_FRAMES = 180; // 約3秒分まで机上シミュレート
    const envelopeIndexByKey = new Map();
    const envelopeTables = [];
    let usesReleaseTable = false;

    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || !ENV_CAPABLE_TYPES.has(cfg.type)) continue;
      for (const ev of voiceEvents[ch]) {
        if (ev.pitchSemi === null) continue;
        const key = `${ev.adsr1},${ev.adsr2},${ev.gain}`;
        let idx = envelopeIndexByKey.get(key);
        if (idx === undefined) {
          idx = envelopeTables.length;
          envelopeIndexByKey.set(key, idx);
          envelopeTables.push({ index: idx, values: simulateSpcEnvelope(ev.adsr1, ev.adsr2, ev.gain, MAX_ENV_FRAMES) });
        }
        ev.envelopeIdx = idx;
        usesReleaseTable = true;
      }
    }
    const releaseTable = usesReleaseTable ? simulateSpcRelease(MAX_ENV_FRAMES) : null;

    // ── 拡張音源を確定 ───────────────────────────────────────────────
    let expansion = 'none';
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip' || cfg.type === 'dpcm') continue;
      const exp = TYPE_TO_EXPANSION[cfg.type];
      if (exp) { expansion = exp; break; } // 最初に見つかった拡張を使用
    }

    // ── DPCM 変換 (全ボイス中で DPCM 指定されたものの srcn を収集) ──
    // SNESのBRRサンプルは元々ノートごとにピッチシフトして鳴らす前提の楽器なので、
    // 実機ppmckc(音符バイト=dpcm_dataテーブルの行選択、ピッチの動的変換は無い)を
    // そのまま真似るのではなく、このツール独自の連続ピッチ量子化
    // (compiler.jsのdpcmRateIndexForNote)を使う設計にする。@DPCM<n>定義は
    // 基準ピッチ(pitchSemi=60、SNESのPitch=0x1000=原音)での再生レートとして
    // 固定レート15(最高音質)を使い、実際に弾かれた音は基準からの半音差で
    // 最寄りのハードウェアレートへ量子化される(NSF側のような複数レート定義の
    // 使い分けはしない。BRRサンプルにNES実機のような固定サンプルテーブルの
    // 概念が無いため)。
    const dpcmSrcns = new Set();
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type !== 'dpcm') continue;
      for (const ev of voiceEvents[ch]) dpcmSrcns.add(ev.srcn);
    }

    // srcn → DPCM インデックス (@N) の対応表
    const srcnToDpcmIdx = {};
    const dmcFiles = [];
    let dpcmIdx = 0;
    for (const srcn of dpcmSrcns) {
      const brr = brrSamples[srcn];
      if (!brr || brr.bytes.length === 0) continue;
      const result = brrToDpcm(brr.bytes, 15);
      srcnToDpcmIdx[srcn] = dpcmIdx;
      dmcFiles.push({ name: `dpcm_srcn${String(srcn).padStart(3,'0')}.dmc`, bytes: result.bytes, rateIndex: result.rateIndex });
      dpcmIdx++;
    }

    // DPCM(物理的に1系統しか無いDMCチャンネル)は全dpcm指定ボイスのノートを
    // 時系列で1本にまとめる。複数ボイスが同時にdpcmを使った場合、後から
    // 鳴った方が先の再生を上書きする実機同様の制約になる(開始フレーム順に
    // 並べるだけで自然にそうなる)。
    const dpcmNoteEvents = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type !== 'dpcm') continue;
      for (const ev of voiceEvents[ch]) {
        if (ev.pitchSemi === null || srcnToDpcmIdx[ev.srcn] === undefined) continue;
        // DPCMはBRRサンプルそのものを再生レートを変えて鳴らす方式で、@DPCM定義は
        // 原音(pitch=0x1000)をレート15で収録している。サンプルには実音程が既に焼き込まれて
        // いるため、必要なのは原音レートからの相対比(pitch/0x1000)だけで、サンプル固有の
        // 原音チューニング補正(tune)は加えてはならない(加えると二重補正になる)。そのため
        // 音源発振型(パルス/FDS/N163等)で使う補正済み pitchSemi ではなく、生ピッチから
        // 補正0で算出したノートを使う。基準ピッチ(pitch=0x1000)→60→DPCM_BASE_NOTE(48)へ-12。
        const rawSemi = pitchToSemitone(ev.pitch, 0);
        if (rawSemi === null) continue;
        dpcmNoteEvents.push({
          start: ev.frame, end: ev.frame + ev.len,
          note: Math.max(0, Math.min(95, rawSemi - 12)),
          instrument: srcnToDpcmIdx[ev.srcn]
        });
      }
    }
    dpcmNoteEvents.sort((a, b) => a.start - b.start);

    // DPCM/拡張音源のチャンネル文字は、src/mml/compiler.jsのassignExpansionLettersを
    // そのまま再利用して決める(実機ppmck同様、各チップの文字範囲は他チップの有無に
    // 関わらず完全固定。EXPANSION_PRIORITY = dpcm,fds,vrc7,vrc6,n163,fme7,mmc5)。
    // これによりコンパイル時に実際に割り当てられる文字と一致する。
    const usesDpcm = dpcmNoteEvents.length > 0;
    const letterExpansions = [
      ...(usesDpcm ? ['dpcm'] : []),
      ...(expansion !== 'none' ? [expansion] : []),
    ];
    const expansionLetterMap = MML.Mml.assignExpansionLetters(letterExpansions);
    const dpcmLetter = usesDpcm ? expansionLetterMap.dpcm[0] : null;
    const expansionLetters = expansion !== 'none' ? expansionLetterMap[expansion] : null;

    // ── FDS/N163 波形をボイスごとに生成 ────────────────────────────
    // 同じ srcn でも複数ボイスが使う場合は先頭ボイスの波形を採用
    const waveCache = {}; // srcn → { fds: [], n163: [] }
    function getWave(srcn) {
      if (waveCache[srcn]) return waveCache[srcn];
      const brr = brrSamples[srcn];
      const pcm = brr && brr.bytes.length > 0 ? decodeBrrBytes(brr.bytes) : new Float32Array([0]);
      waveCache[srcn] = { fds: pcmToFdsWave(pcm), n163: pcmToN163Wave(pcm) };
      return waveCache[srcn];
    }

    // ── MML 生成 ─────────────────────────────────────────────────────
    let mml = `; SPC → MML 変換 (${Math.round(bpm)} BPM, ${FRAMES} フレーム, 分解能480TPQN)\n`;
    if (expansion !== 'none') mml += `; 拡張音源: ${expansion}\n`;
    // #EX-*(機能する本文ディレクティブ。上の`; `コメントとは別。これがないと
    // MML本文だけからは拡張音源が有効にならず、UI側の操作が必要になってしまう)
    if (expansion !== 'none') {
      mml += expansion === 'n163'
        ? `${MML.Mml.EX_CHIP_DIRECTIVE[expansion]} ${expansionLetters.length}\n`
        : `${MML.Mml.EX_CHIP_DIRECTIVE[expansion]}\n`;
    }

    // @DPCM<n>定義(実機ppmckcと同じ書式)。以後Eチャンネルの音符で@<n>により選択する
    for (let i = 0; i < dmcFiles.length; i++) {
      const f = dmcFiles[i];
      mml += `@DPCM${i} = { "${f.name}", ${f.rateIndex}, ${f.bytes.length}, 255, 0 }\n`;
    }

    // FDS/N163 波形コメント (波形データは別途コンパイラオプションで渡す)
    const waveVoices = []; // { ch, srcn, type }
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg) continue;
      const isFds  = cfg.type === 'fds';
      const isN163 = cfg.type && cfg.type.startsWith('n163');
      if (isFds || isN163) {
        const srcn = voiceEvents[ch][0]?.srcn ?? 0;
        waveVoices.push({ ch, srcn, type: cfg.type });
      }
    }

    // ADSR/GAIN由来の音量エンベロープ定義 (@vN / @vr0)
    for (const { index, values } of envelopeTables) {
      mml += `@v${index} = { ${values.join(' ')} }\n`;
    }
    if (releaseTable) {
      mml += `@vr0 = { ${releaseTable.join(' ')} }\n`;
    }

    mml += '\n';

    // チャンネルごとの共通イベント形式を組み立て、最後にまとめて
    // 小節揃えスコア形式(1曲まるごと1回のemitScore呼び出し)で出力する。
    const scoreChannels = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;

      const events = voiceEvents[ch];
      if (events.length === 0) continue;

      const targetType = cfg.type;

      // DPCMは全ボイス分をdpcmNoteEventsに一本化済みなのでここではスキップ
      // (ループの外で1回だけscoreChannelsに追加する)
      if (targetType === 'dpcm') continue;

      const chipIndex = TYPE_TO_CHIP_INDEX[targetType];
      const targetLetter = TYPE_TO_LETTER[targetType]
        || (expansionLetters && chipIndex !== undefined ? expansionLetters[chipIndex] : undefined);
      if (!targetLetter) continue;

      const hasEnvelope = ENV_CAPABLE_TYPES.has(targetType);
      // ピッチエンベロープ(厳密周期ビブラート、DESIGN-PITCH.md Phase 1)。ev.pitchSeq
      // (DSP生ピッチレジスタ、Phase 0で追加済み)をHz経由で借用先チップの生レジスタ
      // 空間へ変換してから分類・登録する(KSS/GBS/HESと同じ「差を取ってから1回だけ
      // 丸める」方針、MML.Convert.rescalePitchSeqFromFreq参照)。ノイズ/DPCMは
      // periodFnForTypeがnullを返すため自動的に対象外になる。
      const n163NumCh = expansion === 'n163' ? expansionLetters.length : undefined;
      const periodFn = periodFnForType(targetType, n163NumCh);
      // 借用先チップの生周期換算関数(periodFn)自体の増減方向をfitVibratoへ渡す
      // (compiler.jsのperiodFnIncreasingと同じ2点比較、src/convert/pitch.js fitVibrato参照)。
      const directionUp = periodFn ? periodFn(2000) > periodFn(200) : undefined;
      const chEvents = events.map(ev => {
        const common = {
          start: ev.frame, end: ev.frame + ev.len, note: ev.pitchSemi,
          envelopeV: hasEnvelope && ev.envelopeIdx !== undefined ? ev.envelopeIdx : undefined,
          envelopeVr: hasEnvelope && ev.envelopeIdx !== undefined ? 0 : undefined,
          tieCandidate: ev.tieCandidate,
        };
        if (periodFn && ev.pitchSemi !== null && ev.pitchSeq && ev.pitchSeq.length > 0) {
          const tune = tuneOf(ev.srcn);
          const freqSeq = ev.pitchSeq.map(p => pitchRegToFreqHz(p, tune));
          const rescaled = MML.Convert.rescalePitchSeqFromFreq(freqSeq, periodFn);
          MML.Convert.applyPitchAssignment(common, pitchReg.assign(rescaled, directionUp));
        }
        // 高速アルペジオ→EN統合(2026-08-14拡張)。mergeSpcVoiceEvents側で検出済みの
        // ev.noteEnvOffsetsを、曲全体で共有するnoteEnvRegへ登録する
        if (ev.noteEnvOffsets) {
          const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
          if (idx != null) common.noteEnv = idx;
        }
        return common;
      });
      // スラー分割(別プロジェクトE、2026-08-12): pitchEp/portamentoが確定した直後に行う
      MML.Convert.markSlurTies(chEvents);
      scoreChannels.push({ letter: targetLetter, events: chEvents, hasEnvelope, hasPitchMod: !!periodFn, hasNoteEnv: !!periodFn });
    }

    if (dpcmLetter) {
      scoreChannels.push({ letter: dpcmLetter, events: dpcmNoteEvents, hasInstrument: true });
    }

    if (scoreChannels.length > 0) {
      mml += MML.Convert.emitScore(scoreChannels, fpb,
        { totalFrames: FRAMES, tempoBpm: bpm, headerLines: [...pitchReg.defLines(), ...noteEnvReg.defLines()] }) + '\n';
    }

    // ── 波形データを options に付加して返す ─────────────────────────
    // fdsWave / n163Wave: 最初に見つかったボイスの波形を採用
    let fdsWave  = null;
    let n163Wave = null;
    for (const { ch, srcn, type } of waveVoices) {
      const w = getWave(srcn);
      if (type === 'fds'  && !fdsWave)  fdsWave  = w.fds;
      if (type.startsWith('n163') && !n163Wave) n163Wave = w.n163;
    }

    return { mml, dmcFiles, bpm: Math.round(bpm), expansion, fdsWave, n163Wave };
  };

  MML.SPC2MML.fromSpc = function (spcBytes, durationSec, options) {
    const { log, brrSamples } = MML.SPC2MML.capture(spcBytes, durationSec);
    return MML.SPC2MML.convert(log, brrSamples, options);
  };

})(globalThis);

/*
 * ピッチ変調(ビブラート)検出 → { delay, values, loop? } 変換。
 * @EP<N> = { ... | ... } テーブル構文(src/mml/lexer.js PITCH_NOTE_ENVELOPE_DEF_RE)用の
 * データを作る。DESIGN-PITCH.md Phase 1(厳密周期ビブラート→ループEP)の実装。
 *
 * MML.Convert.classifyPitchMod(pitchSeq) ->
 *   { type:'periodic', delay, values } | { type:'literal'|'ramp', delay, values } | null
 *   pitchSeq: 1音符区間のフレーム毎の生ピッチレジスタ値(*2mmlのev.pitchSeq、Phase 0で追加)。
 *   戻り値 null … 変調が見つからない(フラット・短すぎ・範囲外)。
 *                 呼び出し側は従来通りD<n>(定数オフセット)のみを使うべき。
 *
 * 判定は基準値(pitchSeq[0]、detune.js/D<n>と同じ基準点)からの差分列に対して行う。
 * D<n>とEP<n>はcompiler.js側で加算される(pitchRegisterOffset: offset = detune +
 * stepEnvelope(ep) + ...)ため、基準点さえ揃っていれば両者は独立に正しく合成される。
 *
 * ★2026-08-11(DESIGN-PITCH.md 別プロジェクトA): `delay`はテーブル本体(values)とは
 * 別に返す独立フィールドになった。以前は「変調開始前の実測ゼロ区間」をテーブル先頭に
 * そのままゼロ値として焼き込んでいた(EP<n>,<delay>引数が未実装だったための代替、
 * P-1参照)が、`EP<n>,<delay>`引数拡張の実装によりMML側で明示的に指定できるようになった
 * ため、pitch.js側では常にゼロ区間をテーブルから分離してdelayとして返す
 * (`values`にゼロ埋めのpadding抜き)。呼び出し側(*2mml converter)は
 * `ev.pitchEp`(テーブル番号)と`ev.pitchEpDelay`(delayフレーム数)の両方を
 * mmlEmit.jsへ渡し、`EP<n>,<delay>`として出力する。利点: 同じLFO形状を遅延違いで
 * 使う曲でもテーブルが重複登録されずEnvelopeRegistryの重複排除が効く、NSF書き出しの
 * ROMサイズもゼロ埋めNバイトよりdelay1バイトの方が小さい(§4参照)。
 *
 * 周期探索パラメータはenvelope.js/retrigger.jsの前例に倣い、このモジュール専用に
 * 独立させる(共有しない。DESIGN-PITCH.md P-3参照)。envelope.jsが踏んだ2つのバグ
 * (loop食い違いの前方一致共有、固定窓による長周期の誤検出)は同じ形で回避する。
 *
 * MML.Convert.PitchEnvelopeRegistry … 曲全体で共有するEPテーブル登録先(重複排除)。
 * EnvelopeRegistryと同型・同ルール(0番から採番、loop食い違いは前方一致させない)。
 *
 * MML.Convert.rescalePitchSeqFromFreq(freqSeq, periodFn) -> number[]
 *   借用変換(DESIGN.md §5、変換元と変換先でチップ・クロックが異なる)用。ev.pitchSeq
 *   (変換元チップの生レジスタ値)をそのままEPへ使うと、変換元と変換先で周期レジスタの
 *   スケール(クロック比)が違うため変調の深さが誤って伸縮する(例: KSS PSG→FME7は
 *   クロック比≈2倍)。ev.freqSeq(Hz、Phase 0で追加済み)を変換先チップのperiodFn
 *   (detectChorusDetune/applyPitchDetuneが使うのと同じ生周期換算関数、例:
 *   fme7PeriodRaw/n163FreqRegRaw/pulsePeriodRaw)へ通してから分類する。
 *   detune.js冒頭コメントと同じ「差を取ってから1回だけ丸める」方針(基準フレームの
 *   連続値を保持し、各フレームは基準との差分を丸めてから整数化する。フレーム毎に
 *   独立で丸めてから引き算すると誤差が余分に乗る)。
 *   ネイティブ変換(変換元=変換先、NSF本体+拡張音源)はスケール変換が不要なので
 *   ev.pitchSeqをそのままPitchEnvelopeRegistry.assignへ渡せばよく、この関数は使わない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  // 非周期(こぶし/アタックベンド/ランプ、DESIGN-PITCH.md Phase 3)を非ループEPテーブルとして
  // 書き出すための閾値。周期判定用の定数(MIN_PERIOD等)とは独立させる(P-3参照)。
  // 非周期側は「同じ形が繰り返される」という裏付けが取れない(1回きりの観測)ため、
  // 周期判定のMIN_LOOP_RANGE(=2)よりやや厳しめにして丸め誤差ノイズの誤検出を避ける。
  const MIN_LITERAL_RANGE  = 3;
  const MIN_LITERAL_FRAMES = 4; // MIN_PERIODと同じ考え方(3フレーム以下は打鍵ジッタと区別できない)

  const MIN_PERIOD       = 4;  // 3フレーム以下の「周期」は単発の打鍵ジッタと区別できないため除外
  const MAX_PERIOD       = 64; // Phase 0実測(GBS周期12、SPC周期13-15)を踏まえた余裕のある上限
  // 誤検出防止の基準は「最低N周期分の一致」(envelope.jsの流儀)ではなく「一致確認に使った
  // 絶対フレーム数」で取る。★実データ(GBS Star Wars CH1)で実測した所、1音符が32フレーム
  // 程度と短くビブラート周期が15フレームに達する曲があり、「最低2周期分」要求だと
  // 30フレーム超が必要になり大半の実ノートで確認しきれず未検出になっていた
  // (envelope.jsの用途=音量は数百フレームの持続音が前提だが、ピッチのビブラートは
  // 1音符=数十フレームの中で完結することが多く前提が異なる)。決定的(ノイズ無し)な
  // エミュレーション値の完全一致比較であるため、MIN_CONFIRM_FRAMES分の一致さえあれば
  // 偶然の一致はほぼあり得ない(全区間フラットの場合はflatRunチェックで別途除外済み、
  // 周期が短いほど実質の確認周期数は増えるので短周期の検出精度は従来通り高いまま)。
  const MIN_CONFIRM_FRAMES = 8;
  const MIN_LOOP_RANGE = 2; // ループ内振幅(最大-最小)がこれ未満なら装飾として弾く(丸め誤差対策)
  const MAX_SEARCH_START = 64; // ループ開始位置(=delay相当)の探索上限
  const MAX_CHECK_WINDOW = 180; // 確認窓の下限(envelope.jsのMAX_ENV_FRAMESと同じ考え方)
  const EP_VALUE_MIN = -127, EP_VALUE_MAX = 126; // @EP<n>テーブル値は符号付きbyte(lexer.js参照)
  const MAX_EP_DELAY = 255; // EP<n>,<delay>のdelayは1byte(mckBytecode.js/ppmckDriver.js側)

  // 厳密周期チェック。確認窓は「MAX_CHECK_WINDOW」と「period+MIN_CONFIRM_FRAMES(呼び出し元の
  // maxPeriod計算が既に保証する下限)」の大きい方に取る(envelope.js:isPeriodicFromと同じ
  // 固定窓バグの回避策)。
  function isPeriodicFrom(seq, start, period) {
    const limit = Math.min(seq.length, start + Math.max(MAX_CHECK_WINDOW, period + MIN_CONFIRM_FRAMES));
    for (let i = start + period; i < limit; i++) {
      if (seq[i] !== seq[i - period]) return false;
    }
    return true;
  }

  // 末尾の「同一値が続く足踏み区間」だけを1個残してtrimする
  // ([[envelope-nonloop-tail-trim-fix]]と同じ考え方: 非ループテーブルは末尾値を
  // 永久ホールドする(compiler.js stepEnvelope参照)ため、末尾の重複はテーブル長を
  // 縮めるだけで再生結果に影響しない)。
  function trimTrailingHold(diff) {
    let end = diff.length;
    while (end > 1 && diff[end - 1] === diff[end - 2]) end--;
    return diff.slice(0, end);
  }

  // 先頭の連続ゼロ区間を切り出してdelayフレーム数として返す(残りがテーブル本体)。
  // classifyPitchModのperiodic/literal/ramp全パターンで共通利用(2026-08-11 別プロジェクトA)。
  function splitLeadingDelay(arr) {
    let i = 0;
    while (i < arr.length && arr[i] === 0) i++;
    return { delay: i, rest: arr.slice(i) };
  }

  function isMonotonic(arr) {
    let up = true, down = true;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] < arr[i - 1]) up = false;
      if (arr[i] > arr[i - 1]) down = false;
    }
    return up || down;
  }

  MML.Convert.classifyPitchMod = function (pitchSeq) {
    if (!pitchSeq || pitchSeq.length < MIN_LITERAL_FRAMES) return null;
    const base = pitchSeq[0];
    const diff = pitchSeq.map(p => p - base);
    const n = diff.length;

    let flatRun = 0;
    while (flatRun < n && diff[flatRun] === 0) flatRun++;
    if (flatRun === n) return null; // 全区間フラット。従来のD<n>のみで表現できる

    const maxStart = Math.min(flatRun, MAX_SEARCH_START);
    for (let start = 0; start <= maxStart; start++) {
      const remain = n - start;
      // 確認フレーム数(remain-period)がMIN_CONFIRM_FRAMES未満になる周期は試さない
      const maxPeriod = Math.min(MAX_PERIOD, remain - MIN_CONFIRM_FRAMES);
      for (let period = MIN_PERIOD; period <= maxPeriod; period++) {
        if (!isPeriodicFrom(diff, start, period)) continue;
        const loop = diff.slice(start, start + period);
        if (loop.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX)) continue; // この周期は範囲外、他を試す
        // 振幅が小さすぎる周期は却下し他を試す。特にKSS/GBS/HES/SPCの借用変換は
        // rescalePitchSeqFromFreq(Hz経由の丸め)を通すため、実際には無変調のノートでも
        // 境界値の丸め起因で1ステップだけ変化する区間がたまたま長い周期として
        // 「厳密に一致」してしまうことがある(実測: SPC Frog's Themeで振幅1のみの
        // 30フレーム超ループを誤検出)。ネイティブ変換(丸め無し)でも振幅1は
        // 装飾として意味を持ちにくいため、形式を問わず同じ基準で弾く。
        const loopMax = Math.max(...loop), loopMin = Math.min(...loop);
        if (loopMax - loopMin < MIN_LOOP_RANGE) continue;
        if (start > MAX_EP_DELAY) return null; // delayがbyte幅を超える異常値は安全側に倒す
        return { type: 'periodic', delay: start, values: loop };
      }
    }

    // 周期的でなければ、非周期だが意味のある変調(こぶし/アタックベンド/ランプ、
    // DESIGN-PITCH.md Phase 3)として非ループEPテーブル(literal、末尾は最終値を永久
    // ホールド)を試す。末尾の同一値足踏みをtrimしたのち、先頭の実測ゼロ区間も
    // delayとして切り出す(別プロジェクトA、pitch.js冒頭コメント参照)。
    const trimmed = trimTrailingHold(diff);
    const { delay: litDelay, rest } = splitLeadingDelay(trimmed);
    if (rest.length >= MIN_LITERAL_FRAMES) {
      const litMax = Math.max(...rest), litMin = Math.min(...rest);
      if (litMax - litMin >= MIN_LITERAL_RANGE &&
          !rest.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX) &&
          litDelay <= MAX_EP_DELAY) {
        return { type: isMonotonic(rest) ? 'ramp' : 'literal', delay: litDelay, values: rest };
      }
    }
    return null;
  };

  MML.Convert.PitchEnvelopeRegistry = function () {
    this.tables = new Map(); // index(@EP<N>の番号) -> { values, loop }
    this.keyToIndex = new Map();
    this.nextIndex = 0;
    // @MP<N>(ビブラート、{delay,speed,depth})用の独立した番号空間・重複排除マップ。
    // EPと違い、MPは本文側コマンド(MP<n>)がdelay引数を取れない(lexer.js参照。
    // EP<n>,<delay>のような拡張が無い)ため、delayもテーブル自体のキーに含める必要がある。
    this.vibratoTables = new Map(); // index(@MP<N>の番号) -> { delay, speed, depth }
    this.vibratoKeyToIndex = new Map();
    this.nextVibratoIndex = 0;
  };

  // {delay,speed,depth}が完全一致する@MP<n>を再利用し、無ければ新規登録する。
  MML.Convert.PitchEnvelopeRegistry.prototype.registerVibrato = function (mp) {
    const key = mp.delay + ',' + mp.speed + ',' + mp.depth;
    let idx = this.vibratoKeyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextVibratoIndex++;
      this.vibratoKeyToIndex.set(key, idx);
      this.vibratoTables.set(idx, mp);
    }
    return idx;
  };

  function shapeKey(shape) {
    return shape.values.join(',') + '|' + (shape.loop == null ? '-' : shape.loop);
  }

  // aがbの前方一致(prefix)かどうか(envelope.jsのisPrefixと同じ)。
  function isPrefix(a, b) {
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // pitchMod({type,delay,values})を{values,loop}テーブルへ変換して登録し、
  // {index, delay}を返す(2026-08-11 別プロジェクトA: delayはテーブルと独立管理する
  // ようになったため、登録先インデックスとは別に呼び出し元のpitchModが持つdelayを
  // そのまま素通しで返す。テーブル自体にdelayの概念は無い=同じ形なら異なるdelay値の
  // 呼び出し同士でも同じテーブル番号を共有できる)。
  // periodic: loop=0(テーブル全体が繰り返し単位、headの概念が無くなったため常に先頭から
  // ループする)。literal/ramp: loop=null(非ループ、末尾を永久ホールド)。
  // ★loop有り同士(片方でもloop!=null)は前方一致していても共有・置き換えを一切行わない
  // (envelope.js EnvelopeRegistry.registerShapeと同じ理由・同じガード。
  // [[envelope-registry-loop-upgrade-bug]]参照。ループ有りのvaluesは「最小の繰り返し単位」に
  // 切り詰められており配列長が観測フレーム数を反映しないため、前方一致だけを根拠にした
  // 共有/差し替えは無関係な変調を混同する事故になる)。
  MML.Convert.PitchEnvelopeRegistry.prototype.registerShape = function (pitchMod) {
    if (!pitchMod) return null;
    const isPeriodic = pitchMod.type === 'periodic';
    const shape = { values: pitchMod.values, loop: isPeriodic ? 0 : null };
    for (const [idx, existing] of this.tables) {
      if (existing.loop != null || shape.loop != null) continue;
      if (isPrefix(existing.values, shape.values)) {
        if (shape.values.length > existing.values.length) this.tables.set(idx, shape);
        return { index: idx, delay: pitchMod.delay };
      }
      if (isPrefix(shape.values, existing.values)) return { index: idx, delay: pitchMod.delay };
    }
    const key = shapeKey(shape);
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextIndex++;
      this.keyToIndex.set(key, idx);
      this.tables.set(idx, shape);
    }
    return { index: idx, delay: pitchMod.delay };
  };

  // ── ポルタメントコマンド(DESIGN-PITCH.md 別プロジェクトC、2026-08-11) ──────
  // P-5「単調ランプ→ポルタメント(コマンドは将来)」の実装。検出側(classifyPitchMod)は
  // 無変更のまま、type:'ramp'の結果を後段(このファイル内)でさらに判定する:
  // 「MPの`warizan_start`(delay無し・反転無しの片道版)で寸分違わず再現できる、
  // 単純な一定ペースの直線グライドか」を検査し、再現できればPT<target>,<duration>
  // (2値だけの軽量コマンド、テーブル不要)へ、できなければ従来通り非ループEP
  // テーブル(literal、全フレーム値をそのまま保持)へ回す。
  // ★実機ppmck公式ドキュメント(doc/mck.txt)には専用のポルタメントコマンドが存在せず
  // 「ピッチエンベロープ(EP)で代用してください」と明記されている。したがってこの
  // PT<n>コマンドはppmck方言からの独自拡張であり(README.md方言対応表に明記、INV-2)、
  // EPは今後も可逆性チェックに失敗した場合のフォールバックとして必須(P-1「音の
  // 正しさ=軌跡保存」の非負妥協ライン。近似で妥協せず、再現できないものは安全側=EPへ)。
  // MMLの構文・バイトコード上(mckBytecode.js)のtargetは符号付き16bit(D<n>と同じ)まで
  // 表現できるが、6502ドライバ側のCEILDIV(MPと共有、ceilDivPpmck相当)がCDA/CDB共に
  // 1byteスクラッチのため|target|は255までしか正しく計算できない。この判定側でも
  // 同じ上限を掛けておく(判定と実装の上限がズレると「JS側は portamento と判定したのに
  // 6502側は8bit溢れで誤動作する」事故になるため、必ず両方揃えること)。
  const MAX_PORTAMENTO_TARGET = 255;
  const MAX_PORTAMENTO_DURATION = 255; // 6502側PTSTEPINT/duration格納は1byte

  // MPのwarizan_start(ceil除算によるBresenham風の一定ペース階段化)の片道版。
  // target(0からの目標オフセット)へduration フレームで到達する列をシミュレートする
  // (compiler.jsのvibratoSequence/ceilDivPpmckと同じアルゴリズムを反転無しで流用)。
  function simulatePortamento(target, duration) {
    const absTarget = Math.abs(target);
    const dir = target < 0 ? -1 : 1;
    let stepSize, stepInterval;
    if (duration === absTarget) { stepSize = 1; stepInterval = 1; }
    else if (duration > absTarget) { stepInterval = ceilDivPpmck(duration, absTarget); stepSize = 1; }
    else { stepSize = ceilDivPpmck(absTarget, duration); stepInterval = 1; }
    const seq = new Array(duration);
    let value = 0, counter = stepInterval;
    for (let t = 0; t < duration; t++) {
      if (counter === stepInterval) { counter = 0; value += dir * stepSize; }
      counter++;
      seq[t] = value;
    }
    return seq;
  }

  // ceilDiv(a,b): a>bの2値をwarizanと同じ規則(割り切れなければ+1、実測トレース済み。
  // src/mml/compiler.jsのceilDivPpmckと同一実装をここでも独立に持つ、共有しない
  // 理由はP-3参照)で割る。
  function ceilDivPpmck(a, b) {
    if (a === b) return 1;
    let q = 0, rem = a;
    while (rem > 0) { q++; rem -= b; }
    return q;
  }

  // valuesがsimulatePortamento(target,duration)と1バイトも違わず一致するかを確認し、
  // 一致すれば{target,duration}を、しなければnullを返す(rampだが直線でない=EPへ)。
  function fitPortamento(values) {
    const duration = values.length;
    const target = values[values.length - 1];
    if (target === 0 || duration < 1) return null;
    if (Math.abs(target) > MAX_PORTAMENTO_TARGET || duration > MAX_PORTAMENTO_DURATION) return null;
    const simulated = simulatePortamento(target, duration);
    for (let i = 0; i < duration; i++) if (simulated[i] !== values[i]) return null;
    return { target, duration };
  }

  // ── ビブラートコマンド(DESIGN-PITCH.md 別プロジェクトB、gate解除は2026-08-15) ──
  // P-5「周期的振動(三角形状)→MP<n>」の実装。別プロジェクトBでcompiler.jsのMPが
  // lfo_sub/warizan_startの厳密移植になった(2026-08-11)後も、抽出側(ここ)は
  // 「MPは近似実装だった名残」でしばらく常にループEP<n>を使い続けていた
  // (gateが実装完了後も外されないまま残っていた、2026-08-15にユーザー指摘で発覚・解消)。
  // 検出側(classifyPitchMod)は無変更のまま、type:'periodic'の結果を後段(このファイル内)
  // でさらに判定する: 「MPの`lfo_sub`(delay無しでオシレーション形状だけを見る)で
  // 寸分違わず再現できる、階段状の対称往復振動か」を検査し、再現できればMP<n>
  // (3パラメータだけの軽量コマンド、テーブルは{delay,speed,depth}の3値のみ)へ、
  // できなければ従来通りループEPテーブルへ回す(fitPortamentoと全く同じ「シミュレート
  // して安全に妥協しない」設計方針)。
  const MAX_MP_SPEED = 255, MAX_MP_DEPTH = 255; // @MP<n>={delay,speed,depth}は各値1byte幅
                                                 // (mckBytecode.js/ppmckDriver.js側、delay/speed/depth共通)

  // compiler.jsのvibratoSequence(lfo_sub厳密移植)と同一アルゴリズムをここでも独立に持つ
  // (ceilDivPpmckと同じ理由=P-3で共有しない)。delay=0固定(delayはpitchModが別途返すため、
  // ここでは純粋なオシレーション形状の照合だけを行う)。
  function simulateVibrato(quarter, rawDepth, dur, direction) {
    let stepSize, stepInterval;
    if (quarter === rawDepth) { stepSize = 1; stepInterval = 1; }
    else if (quarter > rawDepth) { stepInterval = ceilDivPpmck(quarter, rawDepth); stepSize = 1; }
    else { stepSize = ceilDivPpmck(rawDepth, quarter); stepInterval = 1; }
    const seq = new Array(dur);
    let reverseCounter = quarter, adcSbcCounter = stepInterval, dir = direction, value = 0;
    for (let t = 0; t < dur; t++) {
      if (reverseCounter === quarter * 2) { reverseCounter = 0; dir = -dir; }
      if (adcSbcCounter === stepInterval) { adcSbcCounter = 0; value += dir * stepSize; }
      reverseCounter++; adcSbcCounter++;
      seq[t] = value;
    }
    return seq;
  }

  // periodFn(freqを生レジスタへ写す関数)が増加関数か減少関数かを実測判定する
  // (compiler.jsのperiodFnIncreasingと全く同じ2点比較、独立に持つ=P-3)。
  function periodFnIncreasingLocal(periodFn) {
    return periodFn(2000) > periodFn(200);
  }

  // 周期的ビブラート(classifyPitchModのperiodic、1周期分のvalues)がMP<n>の
  // {speed,depth}パラメータ空間(lfo_sub、ceil除算の階段状LFO)で寸分違わず再現できるか
  // 検査する。再現できれば{speed,depth}を、できなければnullを返す(呼び出し側は
  // 従来通りループEPテーブルへフォールバックする)。
  //
  // directionUp: 出力先チップの周波数方向。true=周波数レジスタ(値が上がるほど音程が
  // 上がる: FDS/N163)、false=周期レジスタ(値が下がるほど音程が上がる: 2A03/VRC6/
  // MMC5/FME7)。compiler.jsのperiodFnIncreasing→vibratoSequence呼び出しと完全に同じ
  // 規則で、呼び出し元が出力先チャンネルのチップに合わせて渡す必要がある(渡し間違えると
  // 実際にMPで再コンパイルした時だけ逆位相になる=ここでのbit一致確認をすり抜けてしまう
  // 唯一のポイントなので注意)。VRC7はEP/MP対象外(fnum/blockの対数空間)なので
  // directionUpをundefinedのまま渡せば自動的にフィットを試みない。
  //
  // ★探索範囲: 観測周期period が4の倍数でなければ不採用(quarter=period/4が整数に
  // ならないと lfo_sub の基本周期4*quarterと噛み合わない。quarter>depthの場合は
  // ceil除算の噛み合わせで真の周期が4*quarterより長くなることがあるが、そのケースは
  // 下の「3周期ぶん完全一致」チェックで自然に弾かれる=安全側にEPへフォールバックする)。
  // quarterは上記でただ1通りに決まるため、depthだけを観測振幅(peak)近傍で総当たりする。
  //
  // ★位相はvalues[0]がそのままsim[0](オシレーション開始直後の最初のステップ済み値)と
  // 一致することを要求する(任意回転は許容しない)。理由: vibratoSequenceは「delay
  // フレームだけ0を保持し、その直後は必ず自前の初期状態(reverseCounter=quarter,
  // adcSbcCounter=stepInterval,value=0)から新規にオシレーションを開始する」実装であり、
  // ノート開始のたびに位相をリセットする(=途中の任意の位相から始めることはできない、
  // かつsim自体は最初の1フレーム目から必ずステップ済みの非0値になり、0そのものには
  // ならない)。
  //
  // ★ただし「values先頭の連続0」だけは特別扱いしてdelay側へ吸収する。classifyPitchModは
  // (EP用途では位相を気にする理由が無いため)観測データの0交差を「delay」側に含めるか
  // 「valuesの先頭」に含めるかを一意に決めない=前方一致で複数の(start,period)が同等に
  // 有効なため、実測で「valuesの先頭が0(オシレーション自身の自然な0交差)」という
  // 決定をしがちだと確認済み(delay=5で生成した合成データがdelay=4+values=[0,-2,...]と
  // 分類され、素朴にpitchMod.delayをそのまま使うと1フレームずれた誤った波形になる、
  // 実装時に発覚)。0は「delayホールド中の値」でもあるため、この曖昧さは
  // 「valuesの先頭の連続0をdelay側の延長とみなす」ことで一意に解消できる(0以外の
  // 値は延長候補になり得ない=sim自体が0を返さないため、この吸収は安全側の補正であり
  // 妥協ではない)。吸収した後の残りの列がsim[0..]と寸分違わず一致することを要求する
  // (先頭以外の回転は引き続き許容しない)。
  const MAX_VIBRATO_FIT_PERIOD = 64; // MAX_PERIODと同じ(classifyPitchModが返す周期の上限)
  const MAX_MP_DELAY = 255; // @MP<n>のdelayも1byte幅(mckBytecode.js/ppmckDriver.js側)

  function fitVibrato(values, baseDelay, directionUp) {
    if (directionUp == null) return null;
    const period = values.length;
    if (period < 4 || period % 4 !== 0 || period > MAX_VIBRATO_FIT_PERIOD) return null;
    let leadingZeros = 0;
    while (leadingZeros < period && values[leadingZeros] === 0) leadingZeros++;
    if (leadingZeros >= period) return null; // 全区間0(あり得ないはずだが念のため)
    const delay = baseDelay + leadingZeros;
    if (delay > MAX_MP_DELAY) return null;
    const quarter = period / 4;
    if (quarter > MAX_MP_SPEED) return null;
    const direction = directionUp ? 1 : -1;
    const peak = Math.max(...values.map(v => Math.abs(v)));
    const depthLo = Math.max(1, peak - quarter - 1);
    const depthHi = Math.min(MAX_MP_DEPTH, peak + quarter + 1);
    const simDur = period * 3; // 3周期ぶん確認し、真に無限に繰り返し可能なことを保証する
    for (let rawDepth = depthLo; rawDepth <= depthHi; rawDepth++) {
      const sim = simulateVibrato(quarter, rawDepth, simDur, direction);
      let ok = true;
      for (let i = 0; i < simDur; i++) {
        if (sim[i] !== values[(i + leadingZeros) % period]) { ok = false; break; }
      }
      if (ok) return { delay, speed: quarter, depth: rawDepth };
    }
    return null;
  }

  // pitchSeqを解析し、{kind:'portamento', target, duration, delay} |
  // {kind:'vibrato', index} | {kind:'ep', index, delay} | nullを返す(呼び出し側は
  // kindで分岐してev.portamento/ev.vibrato/ev.pitchEp+ev.pitchEpDelayを設定する)。
  // 変調が見つからなければnull(呼び出し側はD<n>のみを使うべき合図)。
  //
  // directionUp: 周期的ビブラート(periodic)をMP<n>へフィットする際に使う出力先チップの
  // 周波数方向(fitVibrato参照)。省略時(undefined)はMPへのフィットを試みず、
  // 従来通り常にループEPテーブルを使う(VRC7=EP/MP対象外チャンネルの既定動作と一致)。
  MML.Convert.PitchEnvelopeRegistry.prototype.assign = function (pitchSeq, directionUp) {
    const pitchMod = MML.Convert.classifyPitchMod(pitchSeq);
    if (!pitchMod) return null;
    if (pitchMod.type === 'ramp') {
      const fit = fitPortamento(pitchMod.values);
      if (fit) return { kind: 'portamento', target: fit.target, duration: fit.duration, delay: pitchMod.delay };
    } else if (pitchMod.type === 'periodic') {
      const fit = fitVibrato(pitchMod.values, pitchMod.delay, directionUp);
      if (fit) {
        const idx = this.registerVibrato({ delay: fit.delay, speed: fit.speed, depth: fit.depth });
        return { kind: 'vibrato', index: idx };
      }
    }
    const registered = this.registerShape(pitchMod);
    return registered ? { kind: 'ep', index: registered.index, delay: registered.delay } : null;
  };

  MML.Convert.PitchEnvelopeRegistry.prototype.defLines = function () {
    const epLines = Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      return `@EP${i} = { ${parts.join(' ')} }`;
    });
    const mpLines = Array.from(this.vibratoTables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.vibratoTables.get(i);
      return `@MP${i} = { ${t.delay}, ${t.speed}, ${t.depth} }`;
    });
    return [...epLines, ...mpLines];
  };

  // periodFn(freq, ev): applyPitchDetune/detectChorusDetuneと同じ2引数版
  // 生周期換算関数(evはHESのn163PeriodRawのようにev.rawLength等を参照する場合に必要)。
  MML.Convert.rescalePitchSeqFromFreq = function (freqSeq, periodFn, ev) {
    const cont0 = periodFn(freqSeq[0], ev);
    const base = Math.round(cont0);
    return freqSeq.map(f => base + Math.round(periodFn(f, ev) - cont0));
  };

  // 借用変換(KSS/GBS/HES)向けのまとめ役: channels([{events}])の各イベントの
  // ev.freqSeqをperiodFn(detectChorusDetune/applyPitchDetuneと同じ生周期換算関数)で
  // 借用先チップの生レジスタ空間へ変換して分類・登録し、該当すればev.pitchEpを立てる
  // (MML出力側でのgetter用にイベントオブジェクトを直接書き換える。detectChorusDetuneが
  // ev.detuneを直接書き込むのと同じ流儀)。
  MML.Convert.assignPitchEnvelope = function (channels, periodFn, pitchReg) {
    // このperiodFn(=呼び出し元が渡す借用先チップの生周期換算関数)自体の増減方向を
    // 1回だけ調べ、fitVibratoへ渡す(compiler.jsのperiodFnIncreasingと同じ2点比較)。
    const directionUp = periodFnIncreasingLocal(periodFn);
    for (const ch of channels) {
      for (const ev of ch.events) {
        if (ev.note === null || !ev.freqSeq || ev.freqSeq.length === 0) continue;
        const rescaled = MML.Convert.rescalePitchSeqFromFreq(ev.freqSeq, periodFn, ev);
        const assigned = pitchReg.assign(rescaled, directionUp);
        MML.Convert.applyPitchAssignment(ev, assigned);
      }
      // スラー分割(別プロジェクトE、2026-08-12): pitchEp/portamentoが確定した直後に
      // まとめて行う(markSlurTiesの安全ガードが両方の値を参照するため)。KSS(ay/scc)・
      // GBS(pulse/wave)・HES(wave)は全てこの共通ヘルパーを経由するため、ここ1箇所で
      // 3形式に一括で効く(Project A/Cと同じ集約点の再利用)
      MML.Convert.markSlurTies(ch.events);
    }
  };

  // pitchReg.assign()の戻り値({kind:'portamento',...}|{kind:'vibrato',...}|{kind:'ep',...}|null)
  // をevへ適用する共通ヘルパー(2026-08-11 別プロジェクトC、2026-08-15 別プロジェクトB gate解除)。
  // 呼び出し元(assignPitchEnvelope・各*2mmlのtoPitchFields相当)で同じkind分岐を
  // 重複させないためにここへ集約する。
  MML.Convert.applyPitchAssignment = function (ev, assigned) {
    if (!assigned) return;
    if (assigned.kind === 'portamento') {
      ev.portamento = { target: assigned.target, duration: assigned.duration, delay: assigned.delay };
    } else if (assigned.kind === 'vibrato') {
      ev.vibrato = assigned.index;
    } else {
      ev.pitchEp = assigned.index;
      ev.pitchEpDelay = assigned.delay;
    }
  };

  // ── 高速アルペジオ→ノートエンベロープ(EN)統合(2026-08-14) ──────────────
  // チップチューンでは、1chしか無い音源で和音を鳴らすため「フレーム単位で複数の
  // 音程を高速に切り替える」演奏方法(アルペジオ)が非常によく使われる。抽出ループ
  // 自体は「音程(半音丸め値)が変わったら即新イベント」という規則のため、これは
  // 1フレームだけの極短いイベントの連なりとして抽出される。従来はこれをEP(生
  // レジスタ差分のピッチエンベロープ)で表現しようとしていたが、EPは「基準ノート
  // からの生レジスタオフセット」空間のテーブルであり、本来「複数の異なる音程を
  // 正確に鳴らしている」という演奏意図を表すのに適さない(値がチップ・音域ごとに
  // 意味の変わる生レジスタ単位になり、可読性も低い)。ここでは、各ステップの実測
  // 周波数が最寄りの12平均律半音に十分近い(=本当にその音程を狙って鳴らしている)
  // 場合に限り、1つの音符+EN<n>(ノート番号空間の相対オフセット、ppmck仕様通り
  // 累積値)へ統合する。セント誤差が大きい(=半音に乗っていない生々しいピッチベンド/
  // ビブラート)場合は対象外とし、従来通りEP/個別音符のままにする(実測: GBS Robocop
  // CH2冒頭のアルペジオは誤差1〜3セントで綺麗に半音に乗っており、CH1のEP0/EP4等の
  // 浅いビブラートは22〜47セットとずれているため、この閾値で正しく判別できる)。
  const MAX_ARPEGGIO_STEP_FRAMES = 8; // 1ステップがこれ以下のフレーム数なら「高速」とみなす
  const MIN_ARPEGGIO_PERIOD = 2;
  const MAX_ARPEGGIO_PERIOD = 8; // 一般的な和音の構成音数を超える周期は誤検出とみなして除外
  const MIN_ARPEGGIO_CYCLES = 2; // 最低2周期分の反復確認(偶然の一致除け)
  const ARPEGGIO_CENTS_TOLERANCE = 25; // 半音の1/4以内なら「その半音に厳密に乗っている」とみなす
  const EN_VALUE_MIN = -127, EN_VALUE_MAX = 126; // @EN<n>テーブル値は符号付きbyte(lexer.js参照、EPと共通)

  // freq(Hz)が最寄りの12平均律半音(o4a=57=440Hz基準、他の抽出コードと同じ規約)から
  // 何セントずれているかを返す(-50〜+50の範囲)。
  function centsFromNearestSemitone(freq) {
    if (!(freq > 0)) return Infinity;
    const cont = 57 + 12 * Math.log2(freq / 440);
    return (cont - Math.round(cont)) * 100;
  }

  // 実測周波数(Hz)を保持するフィールド名はフォーマットの抽出コードによって
  // rawFreq/freqHzのどちらか一方に揺れている(toCommon内で最終的にどちらも
  // rawFreqへ揃えて出力されるが、mergeRapidArpeggioはtoCommon実行前の生イベントを
  // 見るためこの時点では揺れが残っている)。両対応にしておくことで、呼び出し側
  // フォーマット毎の個別対応を増やさずに済む。
  function eventFreq(ev) {
    return ev.rawFreq != null ? ev.rawFreq : ev.freqHz;
  }

  // absorbed(短いイベントの連なり)のnote列から、周期的に繰り返す最小周期を探す
  // (classifyPitchModのperiodic探索と同じ「最小周期優先・最低2周期分確認」方針)。
  // 見つかれば{ period, matchLen }(matchLen=absorbed先頭から実際にその周期へ
  // 一致し続けた長さ、period以上でperiodの倍数とは限らない)を返す。無ければnull。
  function findArpeggioPeriod(notes) {
    const n = notes.length;
    const maxPeriod = Math.min(MAX_ARPEGGIO_PERIOD, Math.floor(n / MIN_ARPEGGIO_CYCLES));
    for (let period = MIN_ARPEGGIO_PERIOD; period <= maxPeriod; period++) {
      let matchLen = period;
      while (matchLen < n && notes[matchLen] === notes[matchLen - period]) matchLen++;
      if (matchLen >= period * MIN_ARPEGGIO_CYCLES) return { period, matchLen };
    }
    return null;
  }

  // 周期分のnote列(cycleNotes、最後の要素が「MML本文の音符として書き出す基準ノート」
  // になる。詳細は下記)から、@EN<n>用の累積差分テーブルを作る。
  //
  // cumulativeEnvelopeValue(compiler.js)は値を毎フレーム加算していく「累積」方式で、
  // stepEnvelope(EPで使用)のような単純な周期的インデックス参照ではない。そのため
  // ループ(loop=0)で正しく繰り返すには、1周期ぶんの差分の合計が必ず0になっている
  // 必要がある(そうでないと繰り返すたびに音程がドリフトしてしまう)。
  // 「周期内の最後のノート(cycleNotes末尾)」を基準(オフセット0)に選び、
  // 差分列を「基準→note[0]→note[1]→...→note[P-2]→基準(次周期の頭)」という
  // 閉じた巡回として構成すると、和音の回り方に関わらず合計は必ず0になる
  // (P角形を1周する経路の合計変位は常に0という単純な性質)。
  // durations(各ステップのフレーム数、通常は全て1)ぶん、2フレーム目以降は
  // 差分0(保持)を挟む。
  function buildNoteEnvelopeDeltas(cycleNotes, durations) {
    const period = cycleNotes.length;
    const refNote = cycleNotes[period - 1];
    let prevOffset = 0; // 基準ノート自身のオフセット
    const deltas = [];
    for (let k = 0; k < period; k++) {
      const offset = cycleNotes[k] - refNote;
      deltas.push(offset - prevOffset);
      for (let f = 1; f < durations[k]; f++) deltas.push(0);
      prevOffset = offset;
    }
    return { refNote, deltas };
  }

  // mergeAlternatingVibratoと同じ「隣接イベント列→統合後イベント列」形式。
  // 統合したイベントには ev.noteEnvOffsets(累積差分配列)を付与する(登録・EN<n>への
  // 割当ては呼び出し元のassignNoteEnvelopeが曲全体で共有するNoteEnvelopeRegistry経由で
  // 行う。envelope.js/pitch.jsの既存レジストリと同じ「検出はここ、登録は呼び出し元」
  // という役割分担)。mergeAlternatingVibratoより先に(=優先して)呼ぶこと
  // (セントの綺麗な高速アルペジオはこちらで、それ以外の2値往復ビブラートは
  // mergeAlternatingVibratoで、と役割を分けるため)。
  MML.Convert.mergeRapidArpeggio = function (events) {
    const result = [];
    let i = 0;
    const n = events.length;
    while (i < n) {
      const home = events[i];
      const homeFreq = eventFreq(home);
      if (home.note == null || homeFreq == null ||
          (home.end - home.start) > MAX_ARPEGGIO_STEP_FRAMES ||
          Math.abs(centsFromNearestSemitone(homeFreq)) > ARPEGGIO_CENTS_TOLERANCE) {
        result.push(home); i++; continue;
      }
      // 短く・セントの綺麗な・音色が揃っている連続イベントを貪欲に集める
      // (★直接連続する同ノートはretrigger等のハード境界とみなし跨がない、
      // mergeAlternatingVibratoと同じ安全策)
      const run = [home];
      let j = i + 1;
      while (j < n) {
        const seg = events[j];
        const segFreq = eventFreq(seg);
        if (seg.note == null || segFreq == null) break;
        if ((seg.end - seg.start) > MAX_ARPEGGIO_STEP_FRAMES) break;
        if (seg.note === run[run.length - 1].note) break;
        if (Math.abs(centsFromNearestSemitone(segFreq)) > ARPEGGIO_CENTS_TOLERANCE) break;
        if (!hysteresisCompatible(seg, home)) break;
        run.push(seg);
        j++;
      }
      const found = findArpeggioPeriod(run.map(e => e.note));
      if (found) {
        const used = run.slice(0, found.matchLen);
        const cycle = used.slice(0, found.period);
        const cycleNotes = cycle.map(e => e.note);
        const durations = cycle.map(e => e.end - e.start);
        const { refNote, deltas } = buildNoteEnvelopeDeltas(cycleNotes, durations);
        if (!deltas.some(v => v < EN_VALUE_MIN || v > EN_VALUE_MAX)) {
          const last = used[used.length - 1];
          // refNote(=cycle末尾のノート)を基準ノートとしてMML本文に書き出すため、
          // rawFreq/freqSeqもhome(周期先頭)ではなくrefNoteに対応する値へ揃える
          // (揃えないと、後段のapplyPitchDetune/detectChorusDetuneがnoteとrawFreqの
          // 食い違い=無関係な2音間の周波数比較からD<n>を誤計算してしまう)。
          // rawFreq/freqHzの両方を設定するのは、フォーマットごとにtoCommon()が
          // 参照するフィールド名が揺れているため(eventFreq()コメント参照)。
          const refEvent = cycle[cycle.length - 1];
          const refFreq = eventFreq(refEvent);
          result.push(Object.assign({}, home, {
            note: refNote,
            rawFreq: refFreq,
            freqHz: refFreq,
            end: last.end,
            volSeq: concatField(used, 'volSeq'),
            // 統合前の各音符が持っていた「ハード音量エンベロープの打ち直し」位置
            // (nsf2mml/converter.js begin()のhwEnvSeq参照)。1音符=1本の減衰カーブしか
            // 持てないため、統合先で実測レベル列を組み直せるようにフレーム毎の並びのまま繋ぐ
            hwEnvSeq: concatField(used, 'hwEnvSeq'),
            // pitchSeqはhome(周期先頭の1音符ぶん、通常は極短い)のまま残すと、各*2mmlの
            // toCommon()がev.pitchSeq.map(periodFn)からfreqSeqを組み立てる際にend-startと
            // 長さの合わないデータになる。空にしておけばfreqSeq=[]となり、後段の
            // assignPitchEnvelopeが「変調無し」として安全にスキップする
            // (noteEnvOffsetsで表現済みなのでEP側の変調検出はそもそも不要)。
            pitchSeq: [],
            noteEnvOffsets: deltas
          }));
          i += used.length;
          continue;
        }
      }
      result.push(home);
      i++;
    }
    return result;
  };

  MML.Convert.NoteEnvelopeRegistry = function () {
    this.tables = new Map(); // index(@EN<N>の番号) -> { values, loop }
    this.keyToIndex = new Map();
    this.nextIndex = 0;
  };

  // 周期的アルペジオは常にloop=0(先頭からループ、buildNoteEnvelopeDeltasが1周期分の
  // 合計0の閉じた差分列を作るため)。EnvelopeRegistry/PitchEnvelopeRegistryと同じ
  // 「loop有無が食い違うテーブルは前方一致でも共有しない」規約([[envelope-registry-loop-upgrade-bug]]
  // 参照)は、EN側は現状ループ専用(非ループ生成経路が無い)ため該当しないが、将来
  // 非ループEN生成を追加する場合はここも同じガードを入れること。
  MML.Convert.NoteEnvelopeRegistry.prototype.registerShape = function (deltas) {
    if (!deltas || deltas.length === 0) return null;
    const key = deltas.join(',');
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextIndex++;
      this.keyToIndex.set(key, idx);
      this.tables.set(idx, { values: deltas, loop: 0 });
    }
    return idx;
  };

  MML.Convert.NoteEnvelopeRegistry.prototype.defLines = function () {
    return Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      return `@EN${i} = { ${parts.join(' ')} }`;
    });
  };

  // assignPitchEnvelopeと対になる、mergeRapidArpeggioが付与したev.noteEnvOffsetsを
  // 曲全体で共有するNoteEnvelopeRegistryへ登録してev.noteEnvを確定する。
  // mergeRapidArpeggio自身が登録まで行わないのは、EnvelopeRegistry/PitchEnvelopeRegistry
  // と同じく複数チャンネルをまたいだ重複排除を1つの共有レジストリで行うため
  // (曲中の別チャンネル・別箇所で偶然同じ形のアルペジオが出れば1つのEN<n>にまとまる)。
  MML.Convert.assignNoteEnvelope = function (channels, noteEnvReg) {
    for (const ch of channels) {
      for (const ev of ch.events) {
        if (!ev.noteEnvOffsets) continue;
        const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
        if (idx != null) ev.noteEnv = idx;
        delete ev.noteEnvOffsets;
      }
    }
  };

  // extractEvents直後にどのフォーマットも呼んでいた「MML.Convert.mergeAlternatingVibrato(...)」
  // を置き換える統合ヘルパー。mergeRapidArpeggioを必ず先に(優先して)適用し、そこで
  // 統合されなかった残りのイベントにだけmergeAlternatingVibratoを適用する
  // (pitch.js冒頭のmergeRapidArpeggioコメント参照)。rawFreqを持たない抽出結果
  // (SPC/ノイズ/OPLL等)ではmergeRapidArpeggioは何もせず素通りするだけなので、
  // 呼び出し側を条件分岐させずに一律この関数へ差し替えて問題ない。
  MML.Convert.mergeVibratoAndArpeggio = function (events) {
    return MML.Convert.mergeAlternatingVibrato(MML.Convert.mergeRapidArpeggio(events));
  };

  // ── 分節のヒステリシス化(DESIGN-PITCH.md Phase 2、§5手順3) ──────────────
  // 「半音丸め値が変わったら即分割」(note !== cur.note)のせいで、半音境界を跨ぐ
  // 深いビブラートが音符連打(note spam)に化ける問題を、抽出後の後処理パスとして
  // 修正する(各extractorの毎フレームループ自体は変更しない。既存のsplitRetriggers
  // と同じ「抽出→後処理パスで分割/統合」の型を踏襲)。
  //
  // 方式: 隣接するイベント列から「同じ2つの隣接ノート番号(home/alt)が交互に現れる
  // 連続区間」を貪欲に集め、連結したpitchSeqが実際に
  // MML.Convert.classifyPitchMod で周期的と判定できた場合にのみ1イベントへ統合する。
  // T(セント)/M(フレーム)の固定しきい値を新たに発明せず、Phase 1で既に実データ調整済みの
  // 周期検出(MIN_CONFIRM_FRAMES/MIN_LOOP_RANGE等)をそのまま「これは統合してよい
  // ビブラートか」の判定に流用する(判定基準を増やさずP-3の厳密周期性だけで揺れを
  // 判別する)。
  //
  // ★同じノート番号の隣接イベント(retrigger等、ハード境界由来)は絶対に跨がない
  // (実データで確認: KSSのYs1やGBSの一部曲では、ビブラートと無関係な音量打ち直しが
  // 同じ音程のまま複数イベントに分かれることがあり、これを跨いで統合すると打ち直しが
  // 消えてしまう。DMG-CVJ.gbsで実測)。「home,home」のような直接連続する同ノートは
  // 常にheam boundaryとみなし、そこで貪欲集めを打ち切る(集められた区間が短すぎれば
  // 何も統合しない=安全側)。
  //
  // ev.duty/waveKey/mode/noise/envUsed/envShape/envPeriod/modKey/constVol/envKeyの
  // いずれかが食い違う隣接イベントも統合しない(音色/エンベロープの変化は既存どおり
  // 独立した音符のまま)。
  const HYSTERESIS_HARD_KEYS = [
    'duty', 'constVol', 'envKey', 'waveKey', 'mode', 'noise',
    'envUsed', 'envShape', 'envPeriod', 'modKey',
    // FDS(nsf2mml/expansion/fds.js)専用: ハードウェア音量エンベロープの有効/無効が
    // 食い違う隣接イベントは統合しない(音量の扱いが根本的に変わるため)
    'envEnabled',
    // OPLL(kss2mml/expansion/opll.js)専用: 音色番号・VRC7カスタム音色が食い違う
    // 隣接イベントは統合しない(dutyに相当する「音色選択」がこのフィールド名のため)
    'instrument', 'vrc7Tone',
    // SPC(spc2mml/converter.js)専用: 楽器(サンプル/エンベロープ)が食い違う隣接イベントは
    // 統合しない。他形式のイベントにはこれらのキー自体が存在しないため素通りする。
    'srcn', 'adsr1', 'adsr2', 'gain'
  ];
  function hysteresisCompatible(a, b) {
    for (const k of HYSTERESIS_HARD_KEYS) {
      if ((k in a || k in b) && a[k] !== b[k]) return false;
    }
    return true;
  }
  function concatField(list, key) {
    if (!list[0] || !list[0][key]) return undefined;
    return list.reduce((acc, e) => acc.concat(e[key] || []), []);
  }

  MML.Convert.mergeAlternatingVibrato = function (events) {
    const result = [];
    let i = 0;
    const n = events.length;
    while (i < n) {
      const home = events[i];
      if (home.note == null || !home.pitchSeq) { result.push(home); i++; continue; }
      let altNote = null;
      const absorbed = [home];
      let j = i + 1;
      while (j < n) {
        const seg = events[j];
        if (seg.note == null || !seg.pitchSeq) break;
        const prevNote = absorbed[absorbed.length - 1].note;
        if (seg.note === prevNote) break; // 直接連続する同ノート=ハード境界、跨がない
        if (seg.note !== home.note) {
          if (altNote === null) {
            if (Math.abs(seg.note - home.note) !== 1) break; // 隣接半音以外は対象外
            altNote = seg.note;
          } else if (seg.note !== altNote) {
            break; // 3値目が出たら対象外(こぶし・グリッサンド等はここで自然に除外される)
          }
        }
        if (!hysteresisCompatible(seg, home)) break;
        absorbed.push(seg);
        j++;
      }
      // home単体では判定しない(最低1往復=home,alt,homeの3イベント必要)
      if (absorbed.length >= 3 && altNote !== null) {
        const last = absorbed[absorbed.length - 1];
        const candidateSeq = concatField(absorbed, 'pitchSeq');
        // ★Phase 3でclassifyPitchModが非周期(literal/ramp)も返すようになったため、
        // ここは明示的に'periodic'型だけを統合の根拠とする(元々の意図どおり「規則的
        // 周期で2音を高速往復=ビブラート」だけを統合対象とし、非周期の2値往復
        // (トレモロ的な打ち直し等、周期性の裏付けが無いもの)を誤って1音化しない)。
        const classified = MML.Convert.classifyPitchMod(candidateSeq);
        if (classified && classified.type === 'periodic') {
          result.push(Object.assign({}, home, {
            end: last.end,
            volSeq: concatField(absorbed, 'volSeq'),
            // mergeRapidArpeggio側と同じ理由でフレーム毎の並びのまま繋ぐ
            hwEnvSeq: concatField(absorbed, 'hwEnvSeq'),
            pitchSeq: candidateSeq
          }));
          i = j;
          continue;
        }
      }
      result.push(home);
      i++;
    }
    return result;
  };

  // ── スラー分割(DESIGN-PITCH.md §3「レガートA→G」「こぶし」、2026-08-12) ──────
  // 現状の抽出ループは「半音丸め値が変わったら即新イベント」という境界規則自体は
  // Phase 2でも変えていない(mergeAlternatingVibratoは周期的な2値往復だけを後から
  // 再統合するだけ)ため、非周期の音程クロス(1回きりのレガート/こぶし)は既に
  // 別々のイベントとして抽出済みである。このスラー分割は「新しいプラトー検出/分割
  // アルゴリズム」ではなく、隣接イベントの境界が(a)実アタック/デューティ/エンベロープ
  // 種別変化を伴わない**純粋な音程変化のみ**で、(b)両側とも十分な長さ(プラトー)を
  // 持ち、(c)どちらの側も自前の変調(EP/PT)が既に割り当てられていない、という
  // 3条件を満たす場合に限り、独立した再アタック音符ではなくタイ(&)で繋いだ
  // レガートとして出力する後処理パス。
  //
  // 呼び出し順序: 抽出(ev.tieCandidateを立てる。純粋な音程変化での分割だったかを
  // extractor自身が記録する。他の要因では立てない)→音量/ピッチ割当て(pitchEp/
  // portamentoの確定)→本関数、の順を必ず守ること(本関数はpitchEp/portamentoが
  // 未割当のイベントしかタイの対象にしない。理由: compiler.jsのタイ処理は「新しい
  // セグメントを作らず前のセグメントを延長する」設計のため、タイで繋いだ2音目以降が
  // 独自のD/EP/MP/PTを持つことはできない(仮に出力しても再生時に無視される)。
  // よって、タイに使うと自前の変調を握りつぶすことになる候補は安全側にスキップする)。
  //
  // 「不明瞭」な場合(短すぎる/自前の変調がある)は何もしない = 従来通りの独立した
  // 再アタック音符のまま(markSlurTiesが安全に判定できるペアだけを個別にタイで繋ぐ)。
  // P-5「プラトー明瞭→スラー分割、不明瞭→EPテーブル」の不明瞭側(非周期の複数プラトーを
  // 1音+EPへ統合する側)は`mergeUnclearPitchRuns`(下記)が別途担当する。
  const MIN_SLUR_PLATEAU_FRAMES = 4; // Phase 3のMIN_LITERAL_FRAMESと同じ考え方(打鍵ジッタ除外)

  function qualifiesForSlur(ev) {
    // ev.noteEnv(2026-08-14拡張): タイで繋いだ2音目以降が独自のD/EP/MP/PTを持てないのと
    // 同じ理由でEN<n>も持てない(RD_NOTEでのtick0/累積値0への再初期化が起きないため、
    // タイ側にEN<n>を出力しても再生時に無視される)。ここで除外しないと、
    // mergeRapidArpeggioが統合したEN持ちイベントがタイ候補と誤認されて
    // mmlEmit側のEN再送出(前回状態との差分判定)がスキップされ、テーブル定義だけが
    // 出力されて実際にどの音符もEN<n>を参照しないという「検出したのに黙って
    // 捨てられる」退行になる(実測: SPC変換で発覚)。
    return !!ev && ev.note != null && (ev.end - ev.start) >= MIN_SLUR_PLATEAU_FRAMES &&
      ev.pitchEp == null && ev.portamento == null && ev.noteEnv == null && ev.vibrato == null;
  }

  MML.Convert.markSlurTies = function (events) {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1], ev = events[i];
      // hysteresisCompatible(HYSTERESIS_HARD_KEYS、mergeAlternatingVibratoと共有)も
      // ここで再利用する: SPCのsrcn/adsr1/adsr2/gain(楽器/エンベロープ)等、tieCandidate
      // 計算だけでは拾いきれないチップ固有の「音色が変わったら別音符」制約を、
      // extractorごとに個別実装させず一箇所に集約するため
      if (ev.tieCandidate && prev.end === ev.start &&
          qualifiesForSlur(prev) && qualifiesForSlur(ev) && hysteresisCompatible(prev, ev)) {
        ev.slurTie = true;
      }
    }
    return events;
  };

  // ── P-5「不明瞭→EPテーブル」側(スラー分割の相方、2026-08-12) ──────────────
  // tieCandidateで繋がった隣接イベントの連なり(§3の「レガート/こぶし」候補)のうち、
  // 全メンバーが個々に十分な長さ(プラトー、MIN_SLUR_PLATEAU_FRAMES以上)を持つとは
  // 限らない場合(=markSlurTiesが安全側にスキップしうる「不明瞭」な連なり)、run全体を
  // 1つのイベントへ統合し、そのpitchSeqをclassifyPitchModで再分類できるか試す。
  // 再分類できれば(周期/非ループどちらでも良い)「1音+EPテーブル」表現(§3の
  // `EP4 a2`)に置き換わる。できなければ何もしない(=従来通り個々のイベントのまま。
  // markSlurTiesが安全に判定できるペアだけ個別にタイで繋ぐ、既存動作への後退)。
  // ★実際のEP登録(pitchReg.assign)はここでは行わない。統合後のpitchSeqを持つ1つの
  // イベントとして返すだけで、呼び出し元の通常のtoPitchFields相当が普段通り処理する
  // (mergeAlternatingVibratoと全く同じ「試し分類→統合、実登録は後段に委ねる」設計)。
  //
  // 呼び出し順序: 抽出(tieCandidate計算済み)→mergeAlternatingVibrato→本関数→
  // (pitchEp/portamento割当て)→markSlurTies、を必ず守ること(本関数は割当て前の
  // 生のpitchSeqを直接連結して再分類するため、割当て後には呼べない。呼び出し箇所は
  // mergeAlternatingVibratoと全く同じ12箇所、その直後に連結して呼ぶだけでよい)。
  // ★2026-08-14: 本関数は当面パススルー(無効化)する。実測(Last Bible DMG-M7J.gbs、
  // GBS波形ch→FDS借用)で2件の実害が確認された:
  //  ①上限の無いrun収集: tieCandidateの連鎖が続く限り無制限に伸び続け、短い装飾音
  //    (<4フレーム)混じりの本物のメロディ(約4秒=239フレーム)をまるごと1つのrunに
  //    飲み込んだ。EP<n>の生レジスタ差分が符号付きbyte範囲(EP_VALUE_MIN/MAX=-127〜126)を
  //    超えてpitchReg.assign()がnullを返し、mergeがそのまま握りつぶされてピッチ情報が
  //    完全に消失(pitchEp/pitchBreaksどちらにも登録されない)、音符が先頭ノートに
  //    凍りついたまま伸び続ける「音程が全く動かなくなる」不具合になっていた。
  //  ②run長に8*MIN_SLUR_PLATEAU_FRAMES(32フレーム)の上限を設けて①を塞いだ後も、
  //    E4→G4→B4→F#4のような明瞭な複数の実在ノート(E短調アルペジオ、各ノートは正確に
  //    半音上に乗っている)がclassifyPitchMod()に「ランプ/周期」として誤って連続ピッチ
  //    カーブに近似され、本来の離散音程と異なる音(実測: g/bが欠落しfが混入する等)に
  //    化ける「音を外す」不具合が発生した。classifyPitchMod()は本来「同じ音の中での
  //    こぶし/アタックベンド」のような連続的なピッチ揺れを想定した分類器であり、
  //    「複数の異なる実音符が短時間に並ぶ」ケース(本関数がmarkSlurTiesの補完として
  //    対象にしたかったはずの範囲)の判別に十分な精度が無いことが分かった。
  // 通常のタイ機構(markSlurTies→pushNoteのpitchBreaks)は十分な長さ(MIN_SLUR_PLATEAU_
  // FRAMES以上)を持つ音符同士なら正確にレガート表現できることを実測確認済みなので、
  // 「不明瞭(短すぎる)音符が混じる連なりは無理に1つへ統合せず、個々のイベントのまま
  // 独立した音符として出力する」という安全側(近似ゼロ、劣化なし)に倒す。
  MML.Convert.mergeUnclearPitchRuns = function (events) { return events; };

})(globalThis);

/*
 * ピアノロール タイムライン構築(全フォーマット共通・純粋関数)
 * MML.RollBuild
 *
 * 元はmain.jsのbuildXxxRollTimeline群(+keyboard.jsのbuildRollTracksFromRegSnapshots)
 * としてメインスレッド専用だったが、キャプチャWorker化に伴い「1回あたりO(曲全体)の
 * タイムライン構築」がメインスレッドの長タスク(実測~90ms=オーディオバッファ級)として
 * 残ったため、構築そのものをキャプチャWorker内で実行できるようここへ分離した
 * (README-worker-build.txt参照)。メインスレッド(Workerフォールバック時)とWorker
 * バンドルの両方から同じコードが使われる。
 *
 * 依存(すべて実行時参照なので読み込み順は問わない。Workerバンドルには
 * tools/build-capture-workers.ps1が対応フォーマットぶんだけ同梱する):
 *   nsf/vgm: MML.UI.buildRollTracksFromRegSnapshots (src/ui/keyboard.js)
 *   kss/vgm: MML.Kss2MmlExpansion.ay/scc/opll (+MML.Convert: convert/pitch.js)
 *   gbs/vgm: MML.Gbs2MmlExpansion.pulse/noise/wave
 *   hes/vgm: MML.Hes2MmlExpansion.wave/noiseChannel/extractDdaClips
 *   spc:     MML.SPC2MML.extractVoiceEvents
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const RollBuild = MML.RollBuild = MML.RollBuild || {};

  // ── 高速アルペジオ(@EN)の展開 ────────────────────────────────────────
  // MML.Convert.mergeRapidArpeggio(src/convert/pitch.js)は、フレーム単位で音程が
  // 周期的に切り替わる高速アルペジオを「基準ノート1音 + ev.noteEnvOffsets(=@EN<n>、
  // フレーム毎の累積半音差分)」へ畳む。MML本文としてはそれが正しい表現だが、
  // ロールはそのイベントをそのまま描くため、基準ノート1本の長い帯になり、毎フレームの
  // 実レジスタ値を出している鍵盤表示と見た目が食い違う
  // (Space Manbow(MSX) 60曲目のSCC ch3=Rで実測。3.2秒以降のアルペジオ全域)。
  // @ENは「前フレームからの半音差分」なので基準ノートから順に足し込めば元の音程列が
  // 完全に復元でき、それは実レジスタ列とも(MMLを再生したときの実発音とも)一致する。
  // deltas省略時は分割せず元の1区間をそのまま返すので、呼び出し側は無条件に通してよい。
  RollBuild.expandNoteEnv = function (start, end, note, deltas) {
    if (!deltas || !deltas.length) return [{ start, end, note }];
    const out = [];
    let cur = note;
    let segStart = start;
    for (let f = start; f < end; f++) {
      const d = deltas[(f - start) % deltas.length];
      if (!d) continue;
      if (f > start) { out.push({ start: segStart, end: f, note: cur }); segStart = f; }
      cur += d;
    }
    out.push({ start: segStart, end, note: cur });
    return out;
  };

  // ── SPC ──────────────────────────────────────────────────────────────
  RollBuild.spc = function (log, frameRate, srcnFineTune) {
    const frameDur = 1 / frameRate;
    // MML変換と同じ原音チューニング補正を渡し、ロール表示の音程も実機発音に一致させる
    // (ロール=MML変換デバッガの方針。補正マップは再生開始時に一度だけ算出して使い回す)。
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    return voiceEvents.map((events, ch) => ({
      id: `V${ch}`,
      color: `hsl(${ch * 45},90%,65%)`,
      notes: events
        .filter(e => e.pitchSemi !== null)
        // 音量シェーディング用の簡易近似: ADSRモード(adsr1 bit7=1)ならサスティンレベル(adsr2 bit5-7、
        // 0-7)を目安の音量とする。GAINモード(直接指定)は減衰カーブを追わず常に最大音量扱い。
        // pitchSemi は note-number 空間(57=A4=MIDI69)なので MIDI へは +12。
        .reduce((acc, e) => {
          // freqSeq(セント偏差オーバーレイ用): DSPピッチレジスタ(pitch=0x1000で原音32kHz)を
          // pitchToSemitone(src/spc2mml/converter.js)と同じ式でHzへ変換する。
          const tune = (srcnFineTune && srcnFineTune[e.srcn]) || 0;
          const tuneFactor = Math.pow(2, (tune + 3) / 12);
          const vol = (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1;
          const freqSeq = (e.pitchSeq || []).map(p => 440 * (p / 4096) * tuneFactor);
          // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
          // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)
          const steps = RollBuild.expandNoteEnv(e.frame, e.frame + e.len, e.pitchSemi + 12, e.noteEnvOffsets);
          for (let si = 0; si < steps.length; si++) {
            acc.push({
              startSec: steps[si].start * frameDur, endSec: steps[si].end * frameDur, midi: steps[si].note,
              vol, freqSeq: si === 0 ? freqSeq : [],
            });
          }
          return acc;
        }, []),
    }));
  };

  // ── KSS ──────────────────────────────────────────────────────────────
  // headerがSCCデコーダを持ちうる構成か(16Kバンク+RAMモードはバス側でSCCが殺される)
  RollBuild.kssHasSccDecoder = function (header) {
    return !!header && !(header.bankMode === '16K' && header.device.ramMode);
  };

  // writeLogのフレーム範囲[from,to)にSCC音源レジスタ(周波数/音量/有効ビット)への
  // 書込みがあるか。波形テーブルはクリア目的で0書きされることがあるため判定材料にせず、
  // 実際に発音に効くレジスタだけを見る。classic(SCC)は0x80-0x8F、SCC+(SCC-I)は
  // 0xA0-0xAF側も見る。
  RollBuild.kssWriteLogUsesScc = function (writeLog, from, to) {
    for (let f = from; f < to && f < writeLog.length; f++) {
      for (const w of writeLog[f]) {
        if (w.io) continue;
        const off = (w.addr >= 0x9800 && w.addr <= 0x98FF) ? w.addr - 0x9800
          : (w.addr >= 0xB800 && w.addr <= 0xB8FF) ? w.addr - 0xB800 : -1;
        if (off < 0 || w.value === 0) continue;
        if ((off >= 0x80 && off <= 0x8F) || (off >= 0xA0 && off <= 0xAF)) return true;
      }
    }
    return false;
  };

  // PSG→KP/SCC→KS/FMPAC→KF は src/ui/keyboard.js の extractChannels() の色分けと揃える。
  // clockOverride(省略可): AY/SCC抽出器に渡すZ80相当クロック。KSSは常にMSXの3.58MHz、
  // VGMはチップごとに違う(vgmPlayer.js captureVgmSongAsync の kss.clock)ので呼び出し側が渡す。
  RollBuild.kss = function (writeLog, totalFrames, frameRate, header, sccUsed, clockOverride) {
    const frameDur = 1 / frameRate;
    const clock = clockOverride || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // ★2026-08-22: ただし **OPLLだけ向きが逆**。AY/SCCの音量は「大きいほど大音量」だが、
    // OPLLのレジスタ$30下位4bitは減衰値で0が最大音量・15が無音(3dB/step)。
    // レジスタ生値の向きは変えられない(MML変換が v<n> をそのまま $30 のニブルへ書き戻す
    // 往復経路になっている。src/mml/compiler.js segmentsToWriteLogVrc7 の
    // `(instrument << 4) | seg.volume`、src/vgm2mml/converter.js の `ev.volume * 3` 参照)。
    // そのため反転はこの表示用正規化の中だけで行う。
    // note: Kss2MmlExpansionのfreqToNoteNumberはMML変換共通のノート番号体系(57=A4)で、
    // 標準MIDIより1オクターブ(12)低い。鍵盤描画に合わせるロール側でのみ+12補正する。
    // ★抽出イベントは「音量が1でも変わったら別イベント」に切れているため、音程が同じまま
    // 途切れず続いている区間を1本の音符に統合する(retriggerだけは区切りとして残す)。
    const toNotes = (events, attenuated) => {
      const norm = (v) => {
        const n = Math.max(0, Math.min(15, v || 0));
        return (attenuated ? (15 - n) : n) / 15;
      };
      // ノイズ行(AYの@2)は note がノイズ周期そのもの(ppmckのFME-7仕様)なので、
      // そのまま +12 すると MIDI_MIN(24) を下回って描画されない。抽出器が付けてくれる
      // noiseRollIndex(0-15)を使い、他チップのノイズ行と同じ C1〜D#2 に並べる
      // (keyboard.js noisePeriodIndexToMidi と同じ 24+idx)。
      const midiOf = (e) => (e.noiseRollIndex !== undefined) ? 24 + e.noiseRollIndex : e.note + 12;
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
        // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)。
        // freqSeq(セント偏差オーバーレイ)と retrigger は元イベント先頭の区間にだけ効く。
        const steps = RollBuild.expandNoteEnv(e.start, e.end, midiOf(e), e.noteEnvOffsets);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && !(e.retrigger && si === 0) && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, norm(e.volume));
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
          } else {
            out.push({ startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: norm(e.volume), freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] });
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push({ id: `KP${i + 1}`, color: KP_COLS[i], notes: toNotes(ch.events) }));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push({ id: `KS${i + 1}`, color: `hsl(${(280 + i * 20) % 360},80%,60%)`, notes: toNotes(ch.events) }));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      // 第2引数true = OPLLの音量は減衰値なので表示用に反転する(toNotes冒頭のコメント参照)
      opllResult.channels.forEach((ch, i) => tracks.push({ id: `KF${i + 1}`, color: KF_COLS[i % KF_COLS.length], notes: toNotes(ch.events, true) }));
      // リズムモードの打楽器5行。id/色/並び順は鍵盤側(keyboard.js の kssOpll 分岐、
      // RCOLS/RLABEL)と1対1で合わせる。音程を持たないので疑似音程(noiseRollIndex)で
      // 5レーンに分けている(kss2mml/expansion/opll.js の RHYTHM_DEFS 参照)。
      if (opllResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: `KF${RLABEL[key]}`, color: RCOLS[key],
            notes: toNotes(opllResult.rhythm[key] || [], true) });
        }
      }
    }

    return tracks;
  };

  // ── GBS ──────────────────────────────────────────────────────────────
  RollBuild.gbs = function (snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // toNotes: 音程が同じまま途切れず続いている区間を1本の音符に統合する(GBは実トリガbitが
    // あるためretrigger判定はtriggerSeqの変化そのもの=抽出側で既にイベント境界として反映済み)。
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
          } else {
            out.push({ startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] });
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになり無音扱いになる。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push({ id: 'GB1', color: '#66ddff', notes: toNotes(ch1.events) });
    tracks.push({ id: 'GB2', color: '#0077dd', notes: toNotes(ch2.events) });
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push({ id: 'GW', color: '#ffcc00', notes: toNotes(wave.events) });
    return tracks;
  };

  // ── HES ──────────────────────────────────────────────────────────────
  RollBuild.hes = function (snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
          } else {
            out.push({ startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] });
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots);
    // id/色はkeyboard.js extractChannels()のisHesブロック(PSG0-5, PCOLS)と揃える。
    const colors = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
    // ノイズはch4/5独自の発音で、行/鍵盤表示でも同じPSG4/PSG5の行がwave/noiseを兼ねる
    // (wave/noiseは同一chで排他なので時間的に重ならず、単純にマージしてよい)。
    waveResult.channels.forEach((ch, i) => {
      let notes = toNotes(ch.events);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes });
    });
    return tracks;
  };

  // ── NSF(keyboard.jsの共通抽出経路への橋渡し)──────────────────────────
  RollBuild.nsf = function (regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
    return MML.UI.buildRollTracksFromRegSnapshots(
      regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
  };

  // ── VGM(チップファミリごとに上の各ビルダー/共通抽出経路を連結)─────────
  RollBuild.vgm = function (data, done) {
    const frameRate = data.frameRate;
    const sr = 44100;
    const buildTracks = MML.UI.buildRollTracksFromRegSnapshots;
    let tracks = [];
    if (data.nes) {
      const nesChips = ['nes'].concat(data.nes.fds ? ['fds'] : []);
      const t = buildTracks(data.nes.regSnapshots, data.nes.writeLog, done, sr / frameRate, sr, nesChips, null);
      if (t) tracks = tracks.concat(t);
    }
    if (data.gb) tracks = tracks.concat(RollBuild.gbs(data.gb.snapshots.slice(0, done), frameRate));
    if (data.hes) tracks = tracks.concat(RollBuild.hes(data.hes.snapshots.slice(0, done), frameRate));
    if (data.kss) {
      const wl = data.kss.writeLog.slice(0, done);
      const fakeHeader = { device: { mode: 'MSX', fmpac: data.kss.opll } };
      const kssTracks = RollBuild.kss(wl, done, frameRate, fakeHeader, data.kss.scc, data.kss.clock);
      // AY未使用(SCC/OPLLのみ)のVGMではKP行が鍵盤に無いのでロール側も落とす
      tracks = tracks.concat(data.kss.ay ? kssTracks : kssTracks.filter(t => !/^KP\d/.test(t.id)));
    }
    // スナップショット型チップ: extractChannels(keyboard.js)が読むextraSnapsに
    // フレーム毎スナップショット配列を渡して同じ抽出経路でトラック化する
    const snapChips = ['sn', 'ym2612', 'ym2610fm', 'ym2151', 'ga20', 'segapcm', 'c140', 'pwm', 'rf5c164', 'rf5c68'];
    const chipToken = { sn: 'sn76489' };
    for (const key of snapChips) {
      if (!data[key]) continue;
      const token = chipToken[key] || key;
      const extra = {}; extra[key] = data[key].snapshots;
      const t = buildTracks(data[key].snapshots, [], done, sr / frameRate, sr, ['vgm', token], null, extra);
      if (t) tracks = tracks.concat(t);
    }
    return tracks;
  };

  // ── 構築スロットル ────────────────────────────────────────────────────
  // 壁時計ベース+直前の構築実測コスト×10を次回までの最小間隔にする適応制御
  // (構築のCPU占有率を~10%以下に自動制御。曲が進み1回の走査が重くなるほど自動的に
  // 間遠になる)。メインスレッドでは加えて非表示タブ中は最終回以外スキップする
  // (Worker内にはdocumentが無いので可視性チェックは自動的に無効=常時構築でよい。
  // Worker内の構築はメインスレッドをブロックしないため)。
  RollBuild.makeThrottle = function () {
    let lastBuildEnd = -Infinity;
    let minIntervalMs = 300;
    return {
      shouldBuild(done, total) {
        if (done >= total) return true; // 最終回は必ず構築(取りこぼし防止)
        if (typeof document !== 'undefined' && document.hidden) return false;
        return performance.now() - lastBuildEnd >= minIntervalMs;
      },
      didBuild(buildStartMs) {
        lastBuildEnd = performance.now();
        minIntervalMs = Math.max(300, Math.min(5000, (lastBuildEnd - buildStartMs) * 10));
      },
      force() { lastBuildEnd = -Infinity; }
    };
  };

  // ── ロール構築ジョブ(フォーマット差異の吸収)─────────────────────────
  // Worker実装(capture-worker-*-impl.js)とクライアントのフォールバック
  // (capture-worker-client.js)の両方から使う。build(data, done, total)は
  // {timeline, info} を返す(infoはフォーマット固有の副産物: KSSのsccUsed、
  // HESのddaChannel)。dataの形はフォーマットごとのキャプチャ進行データ:
  //   nsf: {regSnapshots, writeLog, n163Snapshots} / kss: {writeLog}
  //   gbs: {snapshots} / hes: {snapshots, dpcmTrace, controlTrace}
  //   spc: {frameLog} / vgm: captureVgmSongAsyncのdataそのもの
  RollBuild.createRollJob = function (format, params) {
    params = params || {};
    if (format === 'nsf') {
      return { build: (data, done) => ({
        timeline: RollBuild.nsf(data.regSnapshots, data.writeLog, done,
          params.samplesPerFrame, params.sampleRate, params.chips || [], data.n163Snapshots),
        info: {}
      }) };
    }
    if (format === 'kss') {
      const sccPossible = RollBuild.kssHasSccDecoder(params.header);
      let sccUsed = false;
      let scanned = 0;
      return { build: (data, done) => {
        // SCCは「使われたと分かった時点で行を足す」単調運用(main.js playKssStream参照)
        if (sccPossible && !sccUsed && RollBuild.kssWriteLogUsesScc(data.writeLog, scanned, done)) sccUsed = true;
        scanned = done;
        return {
          timeline: RollBuild.kss(data.writeLog.slice(0, done), done, params.frameRate, params.header, sccUsed),
          info: { sccUsed }
        };
      } };
    }
    if (format === 'gbs') {
      return { build: (data, done) => ({
        timeline: RollBuild.gbs(data.snapshots.slice(0, done), params.frameRate), info: {}
      }) };
    }
    if (format === 'hes') {
      return { build: (data, done) => {
        const snaps = data.snapshots.slice(0, done);
        const out = { timeline: RollBuild.hes(snaps, params.frameRate), info: {} };
        // DDA(PCM)を担当するchの判定(曲全体でDDA区間が最も長い1ch)も同じ頻度で更新する。
        // 実際の再生に使う生のdpcmTrace列はメインスレッド側が保持しているので、
        // ここではチャンネル番号だけをinfoで返す(main.js側でsetDdaChannel)。
        if (data.dpcmTrace && data.controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.extractDdaClips) {
          out.info.ddaChannel = MML.Hes2MmlExpansion.extractDdaClips(
            snaps, data.dpcmTrace, data.controlTrace, params.frameRate).channel;
        }
        return out;
      } };
    }
    if (format === 'spc') {
      return { build: (data, done) => ({
        timeline: RollBuild.spc(data.frameLog.slice(0, done), params.frameRate, params.fineTune || null),
        info: {}
      }) };
    }
    if (format === 'vgm') {
      return { build: (data, done) => ({ timeline: RollBuild.vgm(data, done), info: {} }) };
    }
    return null;
  };
})(globalThis);

/*
 * KSS/GBS/VGM/SPC/HES regsOnlyキャプチャ Worker本体(汎用ディスパッチ)
 *
 * NSF用のnsf-capture-worker-impl.jsと同じ仕組み(README-worker-build.txt参照)だが、
 * こちらは1本で複数フォーマットを扱う。各フォーマットのバンドルにこのファイルを
 * 結合し、msg.formatで対応するcaptureXxxSongAsyncへディスパッチする(バンドルに
 * 入っていないフォーマットを要求されたらerrorを返す)。
 *
 * プロトコル(capture-worker-client.jsの汎用ランナーと対):
 *   受信 {cmd:'capture', format:'kss'|'gbs'|'vgm'|'spc'|'hes', bytes, opt}
 *   受信 {cmd:'cancel'}
 *   送信 {type:'progress', done, total, arrays:{path:差分slice}, [meta]}
 *        - onProgressが渡すペイロード(進行中に育つ配列を含む構造)を走査し、
 *          「トップレベルまたは1段ネストの配列」をフレーム配列として前回送信位置
 *          からの差分だけ送る。配列以外(スカラ・フラグ・headerオブジェクト)は
 *          初回のみmetaとして送る。
 *   送信 {type:'done', [finalMeta]} … finalMetaはキャプチャ完了後に追加された
 *        非配列プロパティ(VGMのnes.dpcmRom等)を拾うための最終メタ再送
 *   送信 {type:'error', message}
 *   送信 {type:'roll', done, total, timeline, info}
 *        … opt.rollが渡された場合のみ。ピアノロールのタイムライン構築(1回あたり
 *          O(done)の全走査。メインスレッドでは長タスク=カクつきの主因だった)を
 *          Worker内で行い、完成品だけを送る(src/audio/roll-builders.js参照)。
 *          infoはフォーマット固有の副産物(KSS:sccUsed / HES:ddaChannel)。
 *   送信 {type:'rollError', message} … ロール構築の失敗(以後この曲では送らない。
 *        クライアントはメインスレッド構築へ切り替える)。キャプチャ自体は継続する。
 *
 * ★HESも汎用差分プロトコルを使わない: dpcmTrace/controlTraceが「外側は固定長6(ch数)、
 * 中身のch別イベント配列が伸びる」二重配列で、汎用差分(トップレベル/1段ネスト配列の
 * 長さ基準)では外側6要素を初回に送ったきり以後更新されない。専用ハンドラ(_runHes)で
 * snapshotsは長さ基準、トレース2本はch別の長さ基準で差分送信する。
 *
 * ★SPCだけは汎用差分プロトコルを使わない: MML.SPC2MML.captureAsyncのframeLogは
 * 「全フレーム分を空配列で事前確保してから埋めていく」ため、配列長が最初から
 * total固定で、長さ基準の差分検出が機能しない(初回に空配列の山を全送信し、以後
 * 何も送らなくなる)。完了フレーム数done基準で {start, frames:[...]} を差分送信する
 * 専用ハンドラ(_runSpc)を使う。書き込み途中の未完了フレーム(frameLog[done])は
 * まだ伸びている最中なので送らない(次のスライス境界で完成後に送られる)。
 */
(function (global) {
  const MML = global.MML;
  const Emu = MML.Emu;

  // setTimeout(0)の4msクランプを回避するマクロタスクyield(nsf-capture-worker-impl.jsと同じ)
  function macroYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  // onProgressペイロードを「フレーム配列(差分送信)」と「メタ(初回/最終のみ送信)」に
  // 分解する。sentは path->送信済み件数 の記録(呼び出しをまたいで保持)。
  // 'header'キーはVGMのパース済みヘッダ(ネストした静的オブジェクト)なので、
  // 中身を配列走査せず丸ごとメタ扱いにする。
  function diffPayload(payload, sent, includeMeta) {
    const arrays = {};
    const meta = includeMeta ? {} : null;
    for (const key of Object.keys(payload)) {
      const v = payload[key];
      if (Array.isArray(v)) {
        const n = sent[key] || 0;
        if (v.length > n) { arrays[key] = v.slice(n); sent[key] = v.length; }
      } else if (v && typeof v === 'object' && key !== 'header' && !ArrayBuffer.isView(v)) {
        let subMeta = null;
        for (const k2 of Object.keys(v)) {
          const v2 = v[k2];
          if (Array.isArray(v2)) {
            const path = key + '.' + k2;
            const n = sent[path] || 0;
            if (v2.length > n) { arrays[path] = v2.slice(n); sent[path] = v2.length; }
          } else if (meta) {
            (subMeta = subMeta || {})[k2] = v2;
          }
        }
        // 配列しか持たないファミリでも「存在する(nullではない)」ことをメタで伝える
        if (meta) meta[key] = subMeta || {};
      } else if (meta) {
        meta[key] = v; // スカラ / null / 型付き配列
      }
    }
    return { arrays, meta };
  }

  // 各フォーマットのキャプチャ呼び出し。onProgressの引数形状の違いをここで
  // 「ペイロードオブジェクト1個」に正規化する(client側で逆変換する)。
  const FORMATS = {
    kss: (bytes, opt, onP) =>
      Emu.captureKssSongAsync(bytes, opt, (done, total, writeLog) => onP(done, total, { writeLog })),
    gbs: (bytes, opt, onP) =>
      Emu.captureGbsSongAsync(bytes, opt, (done, total, data) => onP(done, total, data)),
    vgm: (bytes, opt, onP) =>
      Emu.captureVgmSongAsync(bytes, opt, (done, total, data) => onP(done, total, data))
  };

  let cancelled = false;

  // ロール構築・送信(opt.rollが無ければ無効)。スロットルはRollBuild.makeThrottleを流用
  // (Worker内にdocumentが無いため可視性チェックは自動的に素通り=常時構築。構築は
  // メインスレッドをブロックしないので問題なく、コストに応じた間隔制御だけが効く)。
  function makeRollSender(format, msg) {
    const RollBuild = MML.RollBuild;
    if (!RollBuild || !msg.opt || !msg.opt.roll) return null;
    let params;
    if (format === 'kss') params = { frameRate: msg.opt.roll.frameRate, header: MML.KSS.parseHeader(msg.bytes) };
    else if (format === 'spc') params = { frameRate: MML.SPC2MML.FRAME_RATE, fineTune: msg.opt.roll.fineTune || null };
    else params = msg.opt.roll; // gbs/hes: {frameRate} / vgm: {}
    const job = RollBuild.createRollJob(format, params);
    if (!job) return null;
    const throttle = RollBuild.makeThrottle();
    let failed = false;
    return (data, done, total) => {
      if (failed || !throttle.shouldBuild(done, total)) return;
      const t0 = performance.now();
      try {
        const r = job.build(data, done, total);
        throttle.didBuild(t0);
        global.postMessage({ type: 'roll', done, total, timeline: r.timeline, info: r.info });
      } catch (err) {
        failed = true;
        global.postMessage({ type: 'rollError', message: String((err && err.stack) || err) });
      }
    };
  }

  // SPC専用(冒頭コメント参照)。opt.durationSecondsだけを使う。
  async function _runSpc(msg) {
    const sendRoll = makeRollSender('spc', msg);
    let lastSent = 0;
    const onProgress = (done, total, frameLog) => {
      if (done <= lastSent) return;
      global.postMessage({ type: 'progress', done, total, start: lastSent, frames: frameLog.slice(lastSent, done) });
      lastSent = done;
      if (sendRoll) sendRoll({ frameLog }, done, total);
    };
    await MML.SPC2MML.captureAsync(msg.bytes, msg.opt.durationSeconds, onProgress,
      () => cancelled, { yieldFn: macroYield, sliceBudgetMs: 30 });
    global.postMessage({ type: 'done', cancelled });
  }

  // HES専用(冒頭コメント参照)。regsOnly前提(client側でperChannelAudio等は弾く)。
  async function _runHes(msg) {
    const sendRoll = makeRollSender('hes', msg);
    let sentSnap = 0;
    const sentDpcm = [0, 0, 0, 0, 0, 0];
    const sentCtl  = [0, 0, 0, 0, 0, 0];
    let metaSent = false;
    const onProgress = (done, total, data) => {
      const chunk = {
        type: 'progress', done, total,
        snapStart: sentSnap,
        snapshots: data.snapshots.slice(sentSnap),
        dpcmTrace: [], controlTrace: []
      };
      sentSnap = data.snapshots.length;
      for (let c = 0; c < 6; c++) {
        chunk.dpcmTrace.push(data.dpcmTrace[c].slice(sentDpcm[c]));
        sentDpcm[c] = data.dpcmTrace[c].length;
        chunk.controlTrace.push(data.controlTrace[c].slice(sentCtl[c]));
        sentCtl[c] = data.controlTrace[c].length;
      }
      if (!metaSent) { metaSent = true; chunk.frameRate = data.frameRate; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(data, done, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: 30
    });
    await Emu.captureHesSongAsync(msg.bytes, opt, onProgress);
    global.postMessage({ type: 'done', cancelled });
  }

  global.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { cancelled = true; return; }
    if (msg.cmd !== 'capture') return;

    if (msg.format === 'hes') {
      if (typeof Emu.captureHesSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: hes' });
        return;
      }
      cancelled = false;
      try { await _runHes(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'spc') {
      if (!MML.SPC2MML || typeof MML.SPC2MML.captureAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: spc' });
        return;
      }
      cancelled = false;
      try { await _runSpc(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    const run = FORMATS[msg.format];
    if (!run || typeof (msg.format === 'kss' ? Emu.captureKssSongAsync
                       : msg.format === 'gbs' ? Emu.captureGbsSongAsync
                       : Emu.captureVgmSongAsync) !== 'function') {
      global.postMessage({ type: 'error', message: 'unsupported format in this bundle: ' + msg.format });
      return;
    }

    cancelled = false;
    const opt = Object.assign({}, msg.opt, {
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: 30 // Worker内はUI非ブロックなので大きめ(=cancel応答性の上限)
    });

    const sendRoll = makeRollSender(msg.format, msg);
    const sent = {};
    let metaSent = false;
    let lastPayload = null;
    const onProgress = (done, total, payload) => {
      lastPayload = payload;
      const { arrays, meta } = diffPayload(payload, sent, !metaSent);
      const chunk = { type: 'progress', done, total, arrays };
      if (!metaSent) { metaSent = true; chunk.meta = meta; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(payload, done, total);
    };

    try {
      await run(msg.bytes, opt, onProgress);
      // キャプチャ完了後に追加された非配列プロパティ(VGMのnes.dpcmRom等)を最終メタで拾う
      const doneMsg = { type: 'done', cancelled };
      if (lastPayload) doneMsg.finalMeta = diffPayload(lastPayload, sent, true).meta;
      global.postMessage(doneMsg);
    } catch (err) {
      global.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  };
})(globalThis);

  };
})(window);