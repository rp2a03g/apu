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

})(window);
