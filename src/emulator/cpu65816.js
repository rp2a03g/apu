/*
 * 65C816(スーパーファミコンの CPU)コア
 * MML.Emu.CPU65816
 *
 * スーパーゲームボーイ(DESIGN-GB-CAPTURE.md §5、段階 8g)の土台。SNES 本体を作る時もそのまま使う。
 *
 * バス: bus.read(addr24) / bus.write(addr24, value)。あれば bus.idle()(バスに触らない内部サイクル)。
 * 1 サイクル = バスの読み/書き/内部のどれか 1 回。時間(マスタークロック)はバス側が番地ごとの速さで数える。
 * step() は 1 命令を実行してサイクル数を返す。nmi() / irq() は割り込みの受け付け。
 *
 * レジスタ: a(16bit、8bit モードでも上位 = B を保つ)、x、y、s、d(ダイレクトページ)、pc(16bit)、pbr、dbr、p(NVMXDIZC)、e(エミュレーション)。
 * e=1 の間は M=X=1、S の上位は $01、X/Y の上位は 0。
 *
 * 検証: SingleStepTests/65816(tools/headless/cpu-test.js 65816)。ネイティブモード(.n)を基準にし、エミュレーションモード(.e)の
 * ページ内折り返しなどの癖は分かる範囲で入れてある。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const C = 0x01, Z = 0x02, I = 0x04, D = 0x08, X = 0x10, M = 0x20, V = 0x40, N = 0x80;

  class CPU65816 {
    constructor(bus) {
      this.bus = bus;
      this.hasIdle = typeof bus.idle === 'function';
      this.cyc = 0;
      this.reset();
    }

    reset() {
      this.a = 0; this.x = 0; this.y = 0; this.s = 0x01FF; this.d = 0; this.pbr = 0; this.dbr = 0;
      this.p = M | X | I; this.e = 1;
      this.waiting = false; this.stopped = false;
      this.wrap = 0;
      this.pc = this.bus.read(0x00FFFC) | (this.bus.read(0x00FFFD) << 8);
    }

    // ── バス ──
    rd(addr) { this.cyc++; return this.bus.read(addr & 0xFFFFFF) & 0xFF; }
    wr(addr, v) { this.cyc++; this.bus.write(addr & 0xFFFFFF, v & 0xFF); }
    io() { this.cyc++; if (this.hasIdle) this.bus.idle(); }
    fetch() { const v = this.rd((this.pbr << 16) | this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
    fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }

    // 次のバイトの番地。wrap: 0 = 24bit で進む(絶対/ロング)、1 = バンク内 16bit で折り返す(ダイレクトページ/スタック)
    next(ea) { return this.wrap ? ((ea & 0xFF0000) | ((ea + 1) & 0xFFFF)) : ((ea + 1) & 0xFFFFFF); }
    // ダイレクトページの 1 バイト(off = オペランド+添字+何バイト目)。e=1 で D の下位が 0 ならページ内で折り返す
    rdDp(off) { return (this.e && !(this.d & 0xFF)) ? this.rd(this.d | (off & 0xFF)) : this.rd((this.d + off) & 0xFFFF); }
    dpAddr(off) { return (this.e && !(this.d & 0xFF)) ? (this.d | (off & 0xFF)) : ((this.d + off) & 0xFFFF); }

    // ── スタック ──
    push(v) { this.wr(this.s, v); this.s = this.e ? (0x0100 | ((this.s - 1) & 0xFF)) : ((this.s - 1) & 0xFFFF); }
    pull() { this.s = this.e ? (0x0100 | ((this.s + 1) & 0xFF)) : ((this.s + 1) & 0xFFFF); return this.rd(this.s); }
    // 65816 で増えた命令は e=1 でも 16bit の S で積み降ろしし、終わってから上位を $01 に戻す
    pushN(v) { this.wr(this.s, v); this.s = (this.s - 1) & 0xFFFF; }
    pullN() { this.s = (this.s + 1) & 0xFFFF; return this.rd(this.s); }
    fixS() { if (this.e) this.s = 0x0100 | (this.s & 0xFF); }

    // ── フラグ ──
    setP(v) {
      this.p = v & 0xFF;
      if (this.e) this.p |= M | X;
      if (this.p & X) { this.x &= 0xFF; this.y &= 0xFF; }
    }
    nz8(v) { this.p = (this.p & ~(N | Z)) | (v & 0x80) | ((v & 0xFF) ? 0 : Z); }
    nz16(v) { this.p = (this.p & ~(N | Z)) | ((v >> 8) & 0x80) | ((v & 0xFFFF) ? 0 : Z); }

    // ── アドレッシング(実効番地を返し、wrap を決める)──
    aDp() { const o = this.fetch(); if (this.d & 0xFF) this.io(); this.wrap = 1; return this.dpAddr(o); }
    aDpX() { const o = this.fetch(); if (this.d & 0xFF) this.io(); this.io(); this.wrap = 1; return this.dpAddr(o + this.x); }
    aDpY() { const o = this.fetch(); if (this.d & 0xFF) this.io(); this.io(); this.wrap = 1; return this.dpAddr(o + this.y); }
    aAbs() { const a = this.fetch16(); this.wrap = 0; return (this.dbr << 16) | a; }
    // 絶対,X/Y: 書き込み命令か、添字が 16bit か、ページをまたぐ時は 1 サイクル余分
    aAbsI(idx, write) {
      const a = this.fetch16();
      if (write || !(this.p & X) || ((a & 0xFF) + (idx & 0xFF)) > 0xFF) this.io();
      this.wrap = 0;
      return ((this.dbr << 16) + a + idx) & 0xFFFFFF;
    }
    aLong() { const a = this.fetch16(); const b = this.fetch(); this.wrap = 0; return (b << 16) | a; }
    aLongX() { const a = this.fetch16(); const b = this.fetch(); this.wrap = 0; return (((b << 16) | a) + this.x) & 0xFFFFFF; }
    aInd() { const o = this.fetch(); if (this.d & 0xFF) this.io(); const lo = this.rdDp(o), hi = this.rdDp(o + 1); this.wrap = 0; return (this.dbr << 16) | (hi << 8) | lo; }
    aIndX() { const o = this.fetch(); if (this.d & 0xFF) this.io(); this.io(); let lo, hi;
      if (this.e && (this.d & 0xFF)) { // 実機の癖: E=1 で DL≠0 の時、上位バイトだけページ内で折り返して読む(gilyon/snes-tests で確認できる)
        const p = (this.d + o + this.x) & 0xFFFF; lo = this.rd(p); hi = this.rd((p & 0xFF00) | ((p + 1) & 0xFF));
      } else { lo = this.rdDp(o + this.x); hi = this.rdDp(o + this.x + 1); }
      this.wrap = 0; return (this.dbr << 16) | (hi << 8) | lo; }
    aIndY(write) {
      const o = this.fetch(); if (this.d & 0xFF) this.io();
      const lo = this.rdDp(o), hi = this.rdDp(o + 1), a = (hi << 8) | lo;
      if (write || !(this.p & X) || ((a & 0xFF) + (this.y & 0xFF)) > 0xFF) this.io();
      this.wrap = 0;
      return ((this.dbr << 16) + a + this.y) & 0xFFFFFF;
    }
    aIndL() { const o = this.fetch(); if (this.d & 0xFF) this.io(); const b0 = this.rd((this.d + o) & 0xFFFF), b1 = this.rd((this.d + o + 1) & 0xFFFF), b2 = this.rd((this.d + o + 2) & 0xFFFF); this.wrap = 0; return (b2 << 16) | (b1 << 8) | b0; }
    aIndLY() { return (this.aIndL() + this.y) & 0xFFFFFF; }
    aSr() { const o = this.fetch(); this.io(); this.wrap = 1; return (this.s + o) & 0xFFFF; }
    aSrY() { const o = this.fetch(); this.io(); const lo = this.rd((this.s + o) & 0xFFFF), hi = this.rd((this.s + o + 1) & 0xFFFF); this.io(); this.wrap = 0; return ((this.dbr << 16) + ((hi << 8) | lo) + this.y) & 0xFFFFFF; }

    // 演算系 8 族(ORA AND EOR ADC STA LDA CMP SBC)の番地。mode = op & 0x1F
    aluAddr(mode, write) {
      switch (mode) {
        case 0x01: return this.aIndX();
        case 0x03: return this.aSr();
        case 0x05: return this.aDp();
        case 0x07: return this.aIndL();
        case 0x0D: return this.aAbs();
        case 0x0F: return this.aLong();
        case 0x11: return this.aIndY(write);
        case 0x12: return this.aInd();
        case 0x13: return this.aSrY();
        case 0x15: return this.aDpX();
        case 0x17: return this.aIndLY();
        case 0x19: return this.aAbsI(this.y, write);
        case 0x1D: return this.aAbsI(this.x, write);
        case 0x1F: return this.aLongX();
      }
      return -1;
    }

    // ── 幅つきの読み書き ──
    rdM(ea) { if (this.p & M) return this.rd(ea); const lo = this.rd(ea); return lo | (this.rd(this.next(ea)) << 8); }
    rdX(ea) { if (this.p & X) return this.rd(ea); const lo = this.rd(ea); return lo | (this.rd(this.next(ea)) << 8); }
    wrM(ea, v) { this.wr(ea, v); if (!(this.p & M)) this.wr(this.next(ea), v >> 8); }
    wrX(ea, v) { this.wr(ea, v); if (!(this.p & X)) this.wr(this.next(ea), v >> 8); }
    immM() { return (this.p & M) ? this.fetch() : this.fetch16(); }
    immX() { return (this.p & X) ? this.fetch() : this.fetch16(); }

    // ── 演算 ──
    ora(v) { if (this.p & M) { const r = (this.a | v) & 0xFF; this.a = (this.a & 0xFF00) | r; this.nz8(r); } else { this.a = (this.a | v) & 0xFFFF; this.nz16(this.a); } }
    and(v) { if (this.p & M) { const r = this.a & v & 0xFF; this.a = (this.a & 0xFF00) | r; this.nz8(r); } else { this.a &= v; this.nz16(this.a); } }
    eor(v) { if (this.p & M) { const r = (this.a ^ v) & 0xFF; this.a = (this.a & 0xFF00) | r; this.nz8(r); } else { this.a = (this.a ^ v) & 0xFFFF; this.nz16(this.a); } }
    lda(v) { if (this.p & M) { this.a = (this.a & 0xFF00) | (v & 0xFF); this.nz8(v); } else { this.a = v & 0xFFFF; this.nz16(v); } }
    cmpW(reg, v, eight) {
      if (eight) { const r = (reg & 0xFF) - (v & 0xFF); this.p = (this.p & ~C) | (r >= 0 ? C : 0); this.nz8(r); }
      else { const r = (reg & 0xFFFF) - (v & 0xFFFF); this.p = (this.p & ~C) | (r >= 0 ? C : 0); this.nz16(r); }
    }
    // 加算(10 進モードは桁ごとに補正。V は最上位の桁を補正する前の値で決まる)
    adc(v) {
      const dec = (this.p & D) !== 0;
      let c = this.p & C, r;
      if (this.p & M) {
        const a = this.a & 0xFF;
        if (!dec) r = a + v + c;
        else { r = (a & 0x0F) + (v & 0x0F) + c; if (r > 0x09) r += 0x06; c = r > 0x0F ? 1 : 0; r = (a & 0xF0) + (v & 0xF0) + (c << 4) + (r & 0x0F); }
        const ov = ~(a ^ v) & (a ^ r) & 0x80;
        if (dec && r > 0x9F) r += 0x60;
        this.p = (this.p & ~(C | V)) | (r > 0xFF ? C : 0) | (ov ? V : 0);
        this.a = (this.a & 0xFF00) | (r & 0xFF); this.nz8(r);
      } else {
        const a = this.a;
        if (!dec) r = a + v + c;
        else {
          r = (a & 0x000F) + (v & 0x000F) + c; if (r > 0x0009) r += 0x0006; c = r > 0x000F ? 1 : 0;
          r = (a & 0x00F0) + (v & 0x00F0) + (c << 4) + (r & 0x000F); if (r > 0x009F) r += 0x0060; c = r > 0x00FF ? 1 : 0;
          r = (a & 0x0F00) + (v & 0x0F00) + (c << 8) + (r & 0x00FF); if (r > 0x09FF) r += 0x0600; c = r > 0x0FFF ? 1 : 0;
          r = (a & 0xF000) + (v & 0xF000) + (c << 12) + (r & 0x0FFF);
        }
        const ov = ~(a ^ v) & (a ^ r) & 0x8000;
        if (dec && r > 0x9FFF) r += 0x6000;
        this.p = (this.p & ~(C | V)) | (r > 0xFFFF ? C : 0) | (ov ? V : 0);
        this.a = r & 0xFFFF; this.nz16(r);
      }
    }
    sbc(v) {
      const dec = (this.p & D) !== 0;
      let c = this.p & C, r;
      if (this.p & M) {
        const a = this.a & 0xFF; v ^= 0xFF;
        if (!dec) r = a + v + c;
        else { r = (a & 0x0F) + (v & 0x0F) + c; if (r <= 0x0F) r -= 0x06; c = r > 0x0F ? 1 : 0; r = (a & 0xF0) + (v & 0xF0) + (c << 4) + (r & 0x0F); }
        const ov = ~(a ^ v) & (a ^ r) & 0x80;
        if (dec && r <= 0xFF) r -= 0x60;
        this.p = (this.p & ~(C | V)) | (r > 0xFF ? C : 0) | (ov ? V : 0);
        this.a = (this.a & 0xFF00) | (r & 0xFF); this.nz8(r);
      } else {
        const a = this.a; v ^= 0xFFFF;
        if (!dec) r = a + v + c;
        else {
          r = (a & 0x000F) + (v & 0x000F) + c; if (r <= 0x000F) r -= 0x0006; c = r > 0x000F ? 1 : 0;
          r = (a & 0x00F0) + (v & 0x00F0) + (c << 4) + (r & 0x000F); if (r <= 0x00FF) r -= 0x0060; c = r > 0x00FF ? 1 : 0;
          r = (a & 0x0F00) + (v & 0x0F00) + (c << 8) + (r & 0x00FF); if (r <= 0x0FFF) r -= 0x0600; c = r > 0x0FFF ? 1 : 0;
          r = (a & 0xF000) + (v & 0xF000) + (c << 12) + (r & 0x0FFF);
        }
        const ov = ~(a ^ v) & (a ^ r) & 0x8000;
        if (dec && r <= 0xFFFF) r -= 0x6000;
        this.p = (this.p & ~(C | V)) | (r > 0xFFFF ? C : 0) | (ov ? V : 0);
        this.a = r & 0xFFFF; this.nz16(r);
      }
    }
    // シフト/回転/増減(値を受けて結果を返す。eight = 8bit 幅)
    shift(kind, v, eight) {
      const top = eight ? 0x80 : 0x8000, mask = eight ? 0xFF : 0xFFFF;
      let r, c = this.p & C;
      switch (kind) {
        case 0: r = (v << 1) & mask; c = (v & top) ? 1 : 0; break;                  // ASL
        case 1: r = ((v << 1) | c) & mask; c = (v & top) ? 1 : 0; break;            // ROL
        case 2: r = v >> 1; c = v & 1; break;                                       // LSR
        case 3: r = (v >> 1) | (c ? top : 0); c = v & 1; break;                     // ROR
        case 4: r = (v + 1) & mask; break;                                          // INC
        default: r = (v - 1) & mask; break;                                         // DEC
      }
      if (kind < 4) this.p = (this.p & ~C) | c;
      if (eight) this.nz8(r); else this.nz16(r);
      return r;
    }
    // メモリを読んで書き戻す命令(RMW): 読む、内部 1 サイクル、書く(16bit は上位から)
    rmw(ea, kind) {
      if (this.p & M) { const v = this.rd(ea); this.io(); this.wr(ea, this.shift(kind, v, true)); }
      else { const hiA = this.next(ea); const v = this.rd(ea) | (this.rd(hiA) << 8); this.io(); const r = this.shift(kind, v, false); this.wr(hiA, r >> 8); this.wr(ea, r); }
    }
    tsbTrb(ea, set) {
      if (this.p & M) {
        const v = this.rd(ea); this.io(); const a = this.a & 0xFF;
        this.p = (this.p & ~Z) | ((v & a) ? 0 : Z);
        this.wr(ea, set ? (v | a) : (v & ~a));
      } else {
        const hiA = this.next(ea); const v = this.rd(ea) | (this.rd(hiA) << 8); this.io();
        this.p = (this.p & ~Z) | ((v & this.a) ? 0 : Z);
        const r = set ? (v | this.a) : (v & ~this.a);
        this.wr(hiA, r >> 8); this.wr(ea, r);
      }
    }
    bit(v) {
      if (this.p & M) this.p = (this.p & ~(N | V | Z)) | (v & 0xC0) | ((v & this.a & 0xFF) ? 0 : Z);
      else this.p = (this.p & ~(N | V | Z)) | ((v >> 8) & 0xC0) | ((v & this.a) ? 0 : Z);
    }
    branch(cond) {
      const o = this.fetch();
      if (!cond) return;
      this.io();
      const t = (this.pc + (o < 0x80 ? o : o - 0x100)) & 0xFFFF;
      if (this.e && ((t ^ this.pc) & 0xFF00)) this.io(); // e=1 はページをまたぐと 1 サイクル余分
      this.pc = t;
    }

    // ── 割り込み ──
    // 受け付け(NMI / IRQ / ABORT): 内部 2 サイクル、(ネイティブなら PBR)、PC、P を積み、ベクタへ
    interrupt(vecNative, vecEmu) {
      const c0 = this.cyc;
      this.waiting = false;
      this.io(); this.io();
      if (!this.e) this.push(this.pbr);
      this.push(this.pc >> 8); this.push(this.pc);
      this.push(this.e ? (this.p & ~0x10) : this.p); // e=1 では B フラグ(bit4)を落として積む
      this.p = (this.p | I) & ~D;
      const v = this.e ? vecEmu : vecNative;
      this.pc = this.rd(v) | (this.rd(v + 1) << 8);
      this.pbr = 0;
      return this.cyc - c0;
    }
    nmi() { return this.interrupt(0x00FFEA, 0x00FFFA); }
    irq() { return this.interrupt(0x00FFEE, 0x00FFFE); }

    // ── 1 命令 ──
    step() {
      const c0 = this.cyc;
      if (this.stopped || this.waiting) { this.io(); return this.cyc - c0; }
      const op = this.fetch();
      const m5 = op & 0x1F;
      // 演算系 8 族
      if (m5 === 0x01 || m5 === 0x03 || m5 === 0x05 || m5 === 0x07 || m5 === 0x0D || m5 === 0x0F || m5 === 0x11 || m5 === 0x12 || m5 === 0x13 || m5 === 0x15 || m5 === 0x17 || m5 === 0x19 || m5 === 0x1D || m5 === 0x1F || (m5 === 0x09 && op !== 0x89)) {
        const fam = op >> 5;
        if (m5 === 0x09) { const v = this.immM(); this.alu(fam, v); return this.cyc - c0; }
        const ea = this.aluAddr(m5, fam === 4);
        if (fam === 4) this.wrM(ea, this.a); else this.alu(fam, this.rdM(ea));
        return this.cyc - c0;
      }
      this.exec(op);
      return this.cyc - c0;
    }
    alu(fam, v) {
      switch (fam) {
        case 0: this.ora(v); break;
        case 1: this.and(v); break;
        case 2: this.eor(v); break;
        case 3: this.adc(v); break;
        case 5: this.lda(v); break;
        case 6: this.cmpW(this.a, v, (this.p & M) !== 0); break;
        case 7: this.sbc(v); break;
      }
    }

    exec(op) {
      const x8 = (this.p & X) !== 0, m8 = (this.p & M) !== 0;
      switch (op) {
        // ── 割り込み命令 ──
        case 0x00: case 0x02: { // BRK / COP
          this.fetch();
          if (!this.e) this.push(this.pbr);
          this.push(this.pc >> 8); this.push(this.pc);
          this.push(this.e ? (this.p | 0x10) : this.p);
          this.p = (this.p | I) & ~D;
          const v = op === 0x00 ? (this.e ? 0x00FFFE : 0x00FFE6) : (this.e ? 0x00FFF4 : 0x00FFE4);
          this.pc = this.rd(v) | (this.rd(v + 1) << 8); this.pbr = 0;
          break;
        }
        case 0x40: { // RTI
          this.io(); this.io();
          this.setP(this.pull());
          this.pc = this.pull(); this.pc |= this.pull() << 8;
          if (!this.e) this.pbr = this.pull();
          break;
        }
        // ── メモリの TSB/TRB/シフト/増減 ──
        case 0x04: this.tsbTrb(this.aDp(), true); break;
        case 0x0C: this.tsbTrb(this.aAbs(), true); break;
        case 0x14: this.tsbTrb(this.aDp(), false); break;
        case 0x1C: this.tsbTrb(this.aAbs(), false); break;
        case 0x06: this.rmw(this.aDp(), 0); break;   case 0x0E: this.rmw(this.aAbs(), 0); break;
        case 0x16: this.rmw(this.aDpX(), 0); break;  case 0x1E: this.rmw(this.aAbsI(this.x, true), 0); break;
        case 0x26: this.rmw(this.aDp(), 1); break;   case 0x2E: this.rmw(this.aAbs(), 1); break;
        case 0x36: this.rmw(this.aDpX(), 1); break;  case 0x3E: this.rmw(this.aAbsI(this.x, true), 1); break;
        case 0x46: this.rmw(this.aDp(), 2); break;   case 0x4E: this.rmw(this.aAbs(), 2); break;
        case 0x56: this.rmw(this.aDpX(), 2); break;  case 0x5E: this.rmw(this.aAbsI(this.x, true), 2); break;
        case 0x66: this.rmw(this.aDp(), 3); break;   case 0x6E: this.rmw(this.aAbs(), 3); break;
        case 0x76: this.rmw(this.aDpX(), 3); break;  case 0x7E: this.rmw(this.aAbsI(this.x, true), 3); break;
        case 0xE6: this.rmw(this.aDp(), 4); break;   case 0xEE: this.rmw(this.aAbs(), 4); break;
        case 0xF6: this.rmw(this.aDpX(), 4); break;  case 0xFE: this.rmw(this.aAbsI(this.x, true), 4); break;
        case 0xC6: this.rmw(this.aDp(), 5); break;   case 0xCE: this.rmw(this.aAbs(), 5); break;
        case 0xD6: this.rmw(this.aDpX(), 5); break;  case 0xDE: this.rmw(this.aAbsI(this.x, true), 5); break;
        // ── A のシフト/増減 ──
        case 0x0A: case 0x2A: case 0x4A: case 0x6A: case 0x1A: case 0x3A: {
          this.io();
          const kind = op === 0x0A ? 0 : op === 0x2A ? 1 : op === 0x4A ? 2 : op === 0x6A ? 3 : op === 0x1A ? 4 : 5;
          if (m8) this.a = (this.a & 0xFF00) | this.shift(kind, this.a & 0xFF, true); else this.a = this.shift(kind, this.a, false);
          break;
        }
        // ── スタック ──
        case 0x08: this.io(); this.push(this.e ? (this.p | 0x30) : this.p); break;                 // PHP
        case 0x28: this.io(); this.io(); this.setP(this.pull()); break;                           // PLP
        case 0x48: this.io(); if (!m8) this.push(this.a >> 8); this.push(this.a); break;         // PHA
        case 0x68: this.io(); this.io(); if (m8) { const v = this.pull(); this.a = (this.a & 0xFF00) | v; this.nz8(v); } else { const lo = this.pull(); this.a = lo | (this.pull() << 8); this.nz16(this.a); } break; // PLA
        case 0xDA: this.io(); if (!x8) this.push(this.x >> 8); this.push(this.x); break;         // PHX
        case 0xFA: this.io(); this.io(); if (x8) { this.x = this.pull(); this.nz8(this.x); } else { const lo = this.pull(); this.x = lo | (this.pull() << 8); this.nz16(this.x); } break; // PLX
        case 0x5A: this.io(); if (!x8) this.push(this.y >> 8); this.push(this.y); break;         // PHY
        case 0x7A: this.io(); this.io(); if (x8) { this.y = this.pull(); this.nz8(this.y); } else { const lo = this.pull(); this.y = lo | (this.pull() << 8); this.nz16(this.y); } break; // PLY
        case 0x0B: this.io(); this.pushN(this.d >> 8); this.pushN(this.d); this.fixS(); break;   // PHD
        case 0x2B: { this.io(); this.io(); const lo = this.pullN(); this.d = lo | (this.pullN() << 8); this.nz16(this.d); this.fixS(); break; } // PLD
        case 0x4B: this.io(); this.push(this.pbr); break;                                         // PHK
        case 0x8B: this.io(); this.push(this.dbr); break;                                         // PHB
        case 0xAB: this.io(); this.io(); this.dbr = this.pullN(); this.nz8(this.dbr); this.fixS(); break; // PLB
        case 0xF4: { const v = this.fetch16(); this.pushN(v >> 8); this.pushN(v); this.fixS(); break; } // PEA
        case 0xD4: { const o = this.fetch(); if (this.d & 0xFF) this.io(); const lo = this.rd((this.d + o) & 0xFFFF), hi = this.rd((this.d + o + 1) & 0xFFFF); this.pushN(hi); this.pushN(lo); this.fixS(); break; } // PEI
        case 0x62: { const o = this.fetch16(); this.io(); const v = (this.pc + o) & 0xFFFF; this.pushN(v >> 8); this.pushN(v); this.fixS(); break; } // PER
        // ── 分岐/ジャンプ ──
        case 0x10: this.branch(!(this.p & N)); break;  case 0x30: this.branch((this.p & N) !== 0); break;
        case 0x50: this.branch(!(this.p & V)); break;  case 0x70: this.branch((this.p & V) !== 0); break;
        case 0x90: this.branch(!(this.p & C)); break;  case 0xB0: this.branch((this.p & C) !== 0); break;
        case 0xD0: this.branch(!(this.p & Z)); break;  case 0xF0: this.branch((this.p & Z) !== 0); break;
        case 0x80: this.branch(true); break;
        case 0x82: { const o = this.fetch16(); this.io(); this.pc = (this.pc + o) & 0xFFFF; break; }                   // BRL
        case 0x4C: this.pc = this.fetch16(); break;                                                                     // JMP abs
        case 0x5C: { const a = this.fetch16(); this.pbr = this.fetch(); this.pc = a; break; }                           // JML
        case 0x6C: { const a = this.fetch16(); const lo = this.rd(a); this.pc = lo | (this.rd((a + 1) & 0xFFFF) << 8); break; } // JMP (abs)
        case 0x7C: { const a = (this.fetch16() + this.x) & 0xFFFF; this.io(); const b = this.pbr << 16; const lo = this.rd(b | a); this.pc = lo | (this.rd(b | ((a + 1) & 0xFFFF)) << 8); break; } // JMP (abs,X)
        case 0xDC: { const a = this.fetch16(); const lo = this.rd(a), hi = this.rd((a + 1) & 0xFFFF); this.pbr = this.rd((a + 2) & 0xFFFF); this.pc = lo | (hi << 8); break; } // JML [abs]
        case 0x20: { const a = this.fetch16(); this.io(); const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r); this.pc = a; break; } // JSR
        case 0x22: { const a = this.fetch16(); this.pushN(this.pbr); this.io(); const b = this.fetch(); const r = (this.pc - 1) & 0xFFFF; this.pushN(r >> 8); this.pushN(r); this.fixS(); this.pbr = b; this.pc = a; break; } // JSL
        case 0xFC: { const lo = this.fetch(); this.pushN(this.pc >> 8); this.pushN(this.pc); const hi = this.fetch(); this.io(); const a = (((hi << 8) | lo) + this.x) & 0xFFFF, b = this.pbr << 16; const l2 = this.rd(b | a); this.pc = l2 | (this.rd(b | ((a + 1) & 0xFFFF)) << 8); this.fixS(); break; } // JSR (abs,X)
        case 0x60: { this.io(); this.io(); const lo = this.pull(); this.pc = ((lo | (this.pull() << 8)) + 1) & 0xFFFF; this.io(); break; } // RTS
        case 0x6B: { this.io(); this.io(); const lo = this.pullN(), hi = this.pullN(); this.pbr = this.pullN(); this.pc = ((lo | (hi << 8)) + 1) & 0xFFFF; this.fixS(); break; } // RTL
        // ── フラグ ──
        case 0x18: this.io(); this.p &= ~C; break;  case 0x38: this.io(); this.p |= C; break;
        case 0x58: this.io(); this.p &= ~I; break;  case 0x78: this.io(); this.p |= I; break;
        case 0xD8: this.io(); this.p &= ~D; break;  case 0xF8: this.io(); this.p |= D; break;
        case 0xB8: this.io(); this.p &= ~V; break;
        case 0xC2: { const v = this.fetch(); this.io(); this.setP(this.p & ~v); break; }             // REP
        case 0xE2: { const v = this.fetch(); this.io(); this.setP(this.p | v); break; }              // SEP
        case 0xFB: { // XCE: C と E を入れ替える
          this.io();
          const c = this.p & C;
          this.p = (this.p & ~C) | this.e;
          this.e = c;
          if (this.e) { this.p |= M | X; this.s = 0x0100 | (this.s & 0xFF); this.x &= 0xFF; this.y &= 0xFF; }
          break;
        }
        // ── 転送 ──
        case 0xAA: this.io(); if (x8) { this.x = this.a & 0xFF; this.nz8(this.x); } else { this.x = this.a; this.nz16(this.x); } break; // TAX
        case 0xA8: this.io(); if (x8) { this.y = this.a & 0xFF; this.nz8(this.y); } else { this.y = this.a; this.nz16(this.y); } break; // TAY
        case 0x8A: this.io(); if (m8) { this.a = (this.a & 0xFF00) | (this.x & 0xFF); this.nz8(this.a); } else { this.a = this.x; this.nz16(this.a); } break; // TXA
        case 0x98: this.io(); if (m8) { this.a = (this.a & 0xFF00) | (this.y & 0xFF); this.nz8(this.a); } else { this.a = this.y; this.nz16(this.a); } break; // TYA
        case 0x9A: this.io(); this.s = this.e ? (0x0100 | (this.x & 0xFF)) : this.x; break;                                              // TXS
        case 0xBA: this.io(); if (x8) { this.x = this.s & 0xFF; this.nz8(this.x); } else { this.x = this.s; this.nz16(this.x); } break; // TSX
        case 0x9B: this.io(); this.y = this.x; if (x8) this.nz8(this.y); else this.nz16(this.y); break;                                  // TXY
        case 0xBB: this.io(); this.x = this.y; if (x8) this.nz8(this.x); else this.nz16(this.x); break;                                  // TYX
        case 0x1B: this.io(); this.s = this.e ? (0x0100 | (this.a & 0xFF)) : this.a; break;                                              // TCS
        case 0x3B: this.io(); this.a = this.s; this.nz16(this.a); break;                                                                 // TSC
        case 0x5B: this.io(); this.d = this.a; this.nz16(this.d); break;                                                                 // TCD
        case 0x7B: this.io(); this.a = this.d; this.nz16(this.a); break;                                                                 // TDC
        case 0xEB: { this.io(); this.io(); this.a = ((this.a >> 8) | (this.a << 8)) & 0xFFFF; this.nz8(this.a); break; }               // XBA
        // ── X/Y の増減 ──
        case 0xE8: this.io(); this.x = this.shift(4, this.x, x8); break;  case 0xCA: this.io(); this.x = this.shift(5, this.x, x8); break;
        case 0xC8: this.io(); this.y = this.shift(4, this.y, x8); break;  case 0x88: this.io(); this.y = this.shift(5, this.y, x8); break;
        // ── BIT ──
        case 0x89: { const v = this.immM(); if (m8) this.p = (this.p & ~Z) | ((v & this.a & 0xFF) ? 0 : Z); else this.p = (this.p & ~Z) | ((v & this.a) ? 0 : Z); break; } // BIT #(Z だけ)
        case 0x24: this.bit(this.rdM(this.aDp())); break;   case 0x2C: this.bit(this.rdM(this.aAbs())); break;
        case 0x34: this.bit(this.rdM(this.aDpX())); break;  case 0x3C: this.bit(this.rdM(this.aAbsI(this.x, false))); break;
        // ── STZ / STX / STY ──
        case 0x64: this.wrM(this.aDp(), 0); break;   case 0x74: this.wrM(this.aDpX(), 0); break;
        case 0x9C: this.wrM(this.aAbs(), 0); break;  case 0x9E: this.wrM(this.aAbsI(this.x, true), 0); break;
        case 0x86: this.wrX(this.aDp(), this.x); break;  case 0x96: this.wrX(this.aDpY(), this.x); break;  case 0x8E: this.wrX(this.aAbs(), this.x); break;
        case 0x84: this.wrX(this.aDp(), this.y); break;  case 0x94: this.wrX(this.aDpX(), this.y); break;  case 0x8C: this.wrX(this.aAbs(), this.y); break;
        // ── LDX / LDY / CPX / CPY ──
        case 0xA2: this.x = this.immX(); if (x8) this.nz8(this.x); else this.nz16(this.x); break;
        case 0xA6: this.x = this.rdX(this.aDp()); if (x8) this.nz8(this.x); else this.nz16(this.x); break;
        case 0xB6: this.x = this.rdX(this.aDpY()); if (x8) this.nz8(this.x); else this.nz16(this.x); break;
        case 0xAE: this.x = this.rdX(this.aAbs()); if (x8) this.nz8(this.x); else this.nz16(this.x); break;
        case 0xBE: this.x = this.rdX(this.aAbsI(this.y, false)); if (x8) this.nz8(this.x); else this.nz16(this.x); break;
        case 0xA0: this.y = this.immX(); if (x8) this.nz8(this.y); else this.nz16(this.y); break;
        case 0xA4: this.y = this.rdX(this.aDp()); if (x8) this.nz8(this.y); else this.nz16(this.y); break;
        case 0xB4: this.y = this.rdX(this.aDpX()); if (x8) this.nz8(this.y); else this.nz16(this.y); break;
        case 0xAC: this.y = this.rdX(this.aAbs()); if (x8) this.nz8(this.y); else this.nz16(this.y); break;
        case 0xBC: this.y = this.rdX(this.aAbsI(this.x, false)); if (x8) this.nz8(this.y); else this.nz16(this.y); break;
        case 0xE0: this.cmpW(this.x, this.immX(), x8); break;  case 0xE4: this.cmpW(this.x, this.rdX(this.aDp()), x8); break;  case 0xEC: this.cmpW(this.x, this.rdX(this.aAbs()), x8); break;
        case 0xC0: this.cmpW(this.y, this.immX(), x8); break;  case 0xC4: this.cmpW(this.y, this.rdX(this.aDp()), x8); break;  case 0xCC: this.cmpW(this.y, this.rdX(this.aAbs()), x8); break;
        // ── ブロック転送(1 バイトぶん。A が $FFFF になるまで同じ命令を繰り返す)──
        case 0x44: case 0x54: {
          const dst = this.fetch(), src = this.fetch();
          this.dbr = dst;
          const v = this.rd((src << 16) | this.x);
          this.wr((dst << 16) | this.y, v);
          this.io(); this.io();
          const step = op === 0x54 ? 1 : -1, mask = x8 ? 0xFF : 0xFFFF;
          this.x = (this.x + step) & mask; this.y = (this.y + step) & mask;
          this.a = (this.a - 1) & 0xFFFF;
          if (this.a !== 0xFFFF) this.pc = (this.pc - 3) & 0xFFFF;
          break;
        }
        // ── その他 ──
        case 0xEA: this.io(); break;                    // NOP
        case 0x42: this.fetch(); break;                 // WDM(2 バイトの NOP)
        case 0xCB: this.io(); this.io(); this.waiting = true; break;  // WAI: 割り込みまで待つ
        case 0xDB: this.io(); this.io(); this.stopped = true; break;  // STP: リセットまで止まる
      }
    }
  }

  CPU65816.FLAGS = { C, Z, I, D, X, M, V, N };
  Emu.CPU65816 = CPU65816;
})(typeof window !== 'undefined' ? window : globalThis);
