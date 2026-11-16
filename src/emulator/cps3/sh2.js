/*
 * SH-2(SH7604)— CP システム III のメイン CPU。MML.Emu.Cps3.SH2
 * DESIGN-CPS3-CAPTURE.md 段階 10c。
 *
 * 命令の意味は日立の SH-2 の命令表のとおり。実行ループの形、遅延分岐中の PC の扱い、割り込みの受け付けの条件、
 * DIV1 / MAC.L / MAC.W の細部、内蔵の割り算器と DMA の動きは MAME(src/devices/cpu/sh/sh.cpp、sh2.cpp、sh7604.cpp。
 * BSD-3-Clause、THIRD-PARTY-NOTICES.md)に合わせた。
 *   - pc は「次に取ってくる命令」の番地。命令の実行中は その命令+2(遅延スロットの中では分岐先)。
 *     PC 相対の読み出しはこの pc を使う(遅延スロットに置いた PC 相対は分岐先基準になる。実機の命令表にもそう書いてある)
 *   - 割り込みは遅延スロットの直前では受けない。受け付けは sr の I より強い物だけ
 *   - サイクル数は MAME のインタプリタと同じ数え方(1 命令 1、いくつかの命令だけ余分)。実機の数え方ではない
 *     ★MAME は既定で動的再コンパイラで走るので、MAME ともサイクル単位では合わない。合わせるのは書き込みの並び(§4)
 *
 * bus: { r8, r16, r32, w8, w16, w32, fetch(番地) → 命令 16bit }。番地の折り返し(0x2xxxxxxx → 0x0xxxxxxx)は bus 側。
 * 内蔵レジスタ(0xFFFFFE00〜)は bus がこのクラスの ir8/ir16/ir32、iw8/iw16/iw32 へ回す。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  const Cps3 = Emu.Cps3 = Emu.Cps3 || {};

  const T = 1, S = 2, Q = 0x100, M = 0x200, SR_MASK = 0x3F3;

  class SH2 {
    constructor(bus) {
      this.bus = bus;
      this.r = new Int32Array(16);
      this.ireg = new Uint8Array(0x200);          // 内蔵レジスタ 0xFFFFFE00-0xFFFFFFFF の控え(特別扱いしない物はここを読み書きするだけ)
      this.iv = new DataView(this.ireg.buffer);
      this.unknownIo = new Map();                  // 触られたが動きを作っていない内蔵レジスタ(番地 → 回数)。作り込みの手掛かり
      this.onDmaRead = null;                       // (番地, 大きさ 0/1/2) → 値。DMA は暗号を通らない(機械側が生の値を返す)
      this.reset();
    }
    reset() {
      this.r.fill(0);
      this.sr = 0xF0; this.gbr = 0; this.vbr = 0; this.mach = 0; this.macl = 0; this.pr = 0;
      this.pc = this.bus.r32(0) >>> 0;
      this.r[15] = this.bus.r32(4) | 0;
      this.delay = 0;          // 遅延分岐の行き先(0 = 無し)
      this.cycles = 0;         // 通算
      this.pendingIrq = 0;     // 外からの割り込み線(bit = 線の番号 = レベル)
      this.intIrqLevel = -1; this.intIrqVector = -1;
      this.testIrq = false;
      this.sleeping = false;
      this.ireg.fill(0);
      this.dvsr = 0; this.dvdntl = 0; this.dvdnth = 0; this.divuOvf = 0; this.divuOvfie = 0;
      this.dmac = [{ sar: 0, dar: 0, tcr: 0, chcr: 0, irq: 0 }, { sar: 0, dar: 0, tcr: 0, chcr: 0, irq: 0 }];
      this.dmaor = 0;
      this.extra = 0;          // 命令の外で食ったサイクル(DMA のサイクルスチール)
      this.frc = 0; this.frcBase = 0;   // フリーランニングタイマの値と、その値だった時の通算サイクル
      this.stopAt = 0;
    }

    // ── 割り込み ────────────────────────────────────────────────
    setIrq(line, on) {
      if (on) { if (!(this.pendingIrq >> line & 1)) { this.pendingIrq |= 1 << line; this.testIrq = true; } }
      else this.pendingIrq &= ~(1 << line);
    }
    _checkIrq() {
      let irq = this.intIrqLevel;
      if (this.pendingIrq) { const ext = 31 - Math.clz32(this.pendingIrq); if (ext >= irq) irq = ext; }
      if (irq < 0 || irq <= ((this.sr >> 4) & 15)) return;
      let vector;
      if (this.intIrqLevel === irq) { vector = this.intIrqVector; this.intIrqLevel = -1; }
      else vector = 64 + (irq >> 1);
      this._exception(vector, irq);
    }
    _exception(vector, level) {
      const b = this.bus;
      this.r[15] -= 4; b.w32(this.r[15] >>> 0, this.sr);
      this.r[15] -= 4; b.w32(this.r[15] >>> 0, this.pc);
      this.sr = (this.sr & ~0xF0) | (level << 4);
      this.pc = b.r32((this.vbr + vector * 4) >>> 0) >>> 0;
      this.sleeping = false;
      this.cycles += 1;
    }
    _recalcIrq() {
      let irq = 0, vector = -1;
      const ipra = this.iv.getUint16(0xE2);
      for (let ch = 0; ch < 2; ch++) {
        const d = this.dmac[ch];
        if ((d.chcr & 6) === 6 && d.irq) {
          const level = (ipra >> 8) & 15;
          if (level > irq) { irq = level; d.irq = 0; vector = this.iv.getUint32(ch ? 0x1A8 : 0x1A0) & 0x7F; }
          break;
        }
      }
      this.intIrqLevel = irq; this.intIrqVector = vector; this.testIrq = true;
    }

    // フリーランニングタイマを今の時刻まで進める。分周 = 8 << (TCR の下位 2bit × 2)。外部クロック(3)は進めない
    _frcSync() {
      const sel = this.ireg[0x16] & 3;
      if (sel === 3) { this.frcBase = this.cycles; return; }
      const div = 8 << (sel * 2), add = Math.floor((this.cycles - this.frcBase) / div);
      if (add > 0) { this.frc = (this.frc + add) & 0xFFFF; this.frcBase += add * div; }
    }
    // 状態の保存と復元(巻き戻し、ステートセーブ)
    saveState() {
      return { r: this.r.slice(), sr: this.sr, gbr: this.gbr, vbr: this.vbr, mach: this.mach, macl: this.macl, pr: this.pr, pc: this.pc, delay: this.delay,
        cycles: this.cycles, pendingIrq: this.pendingIrq, intIrqLevel: this.intIrqLevel, intIrqVector: this.intIrqVector, testIrq: this.testIrq, sleeping: this.sleeping,
        ireg: this.ireg.slice(), dvsr: this.dvsr, dvdntl: this.dvdntl, dvdnth: this.dvdnth, divuOvf: this.divuOvf, divuOvfie: this.divuOvfie,
        dmac: this.dmac.map((d) => Object.assign({}, d)), dmaor: this.dmaor, extra: this.extra, frc: this.frc, frcBase: this.frcBase };
    }
    loadState(s) {
      this.r.set(s.r); this.sr = s.sr; this.gbr = s.gbr; this.vbr = s.vbr; this.mach = s.mach; this.macl = s.macl; this.pr = s.pr; this.pc = s.pc; this.delay = s.delay;
      this.cycles = s.cycles; this.pendingIrq = s.pendingIrq; this.intIrqLevel = s.intIrqLevel; this.intIrqVector = s.intIrqVector; this.testIrq = s.testIrq; this.sleeping = s.sleeping;
      this.ireg.set(s.ireg); this.dvsr = s.dvsr; this.dvdntl = s.dvdntl; this.dvdnth = s.dvdnth; this.divuOvf = s.divuOvf; this.divuOvfie = s.divuOvfie;
      this.dmac = s.dmac.map((d) => Object.assign({}, d)); this.dmaor = s.dmaor; this.extra = s.extra; this.frc = s.frc || 0; this.frcBase = s.frcBase || 0;
      this.stopAt = 0;
    }

    // ── 内蔵レジスタ(番地は 0xFFFFFE00 からの位置)──────────────
    _note(a) { this.unknownIo.set(a, (this.unknownIo.get(a) || 0) + 1); }
    ir32(a) {
      a &= 0x1FF;
      switch (a) {
        case 0x100: return this.dvsr;
        case 0x104: case 0x114: case 0x11C: return this.dvdntl;
        case 0x110: case 0x118: return this.dvdnth;
        case 0x108: return (this.divuOvfie << 1) | this.divuOvf;
        case 0x180: return this.dmac[0].sar; case 0x184: return this.dmac[0].dar; case 0x188: return this.dmac[0].tcr; case 0x18C: return this.dmac[0].chcr;
        case 0x190: return this.dmac[1].sar; case 0x194: return this.dmac[1].dar; case 0x198: return this.dmac[1].tcr; case 0x19C: return this.dmac[1].chcr;
        case 0x1B0: return this.dmaor;
      }
      if (!KNOWN_PLAIN.has(a & ~3)) this._note(a);
      return this.iv.getUint32(a & ~3);
    }
    ir16(a) { a &= 0x1FF; if (a === 0x12) { this._frcSync(); return this.frc; } if (a >= 0x100) return (this.ir32(a & ~3) >>> ((a & 2) ? 0 : 16)) & 0xFFFF; if (!KNOWN_PLAIN.has(a & ~3)) this._note(a); return this.iv.getUint16(a & ~1); }
    ir8(a) { a &= 0x1FF; if (a === 0x12 || a === 0x13) { this._frcSync(); return a === 0x12 ? this.frc >> 8 : this.frc & 0xFF; } if (a >= 0x100) return (this.ir32(a & ~3) >>> (8 * (3 - (a & 3)))) & 0xFF; if (!KNOWN_PLAIN.has(a & ~3)) this._note(a); return this.ireg[a]; }
    iw32(a, v) {
      a &= 0x1FF; v >>>= 0;
      this.iv.setUint32(a & ~3, v);
      switch (a) {
        case 0x100: this.dvsr = v; return;
        case 0x104: { // 32 ÷ 32
          const x = v | 0, y = this.dvsr | 0;
          if (y) { this.dvdntl = ((x / y) | 0) >>> 0; this.dvdnth = (x % y) >>> 0; }
          else { this.divuOvf = 1; this.dvdntl = 0x7FFFFFFF; this.dvdnth = 0x7FFFFFFF; }
          return;
        }
        case 0x108: this.divuOvf = v & 1; this.divuOvfie = (v >> 1) & 1; return;
        case 0x110: this.dvdnth = v; return;
        case 0x114: { // 64 ÷ 32
          const x = BigInt.asIntN(64, (BigInt(this.dvdnth) << 32n) | BigInt(v)), y = BigInt(this.dvsr | 0);
          if (y !== 0n) {
            const q = x / y;
            if (q !== BigInt.asIntN(32, q)) { this.divuOvf = 1; this.dvdntl = 0x7FFFFFFF; this.dvdnth = 0x7FFFFFFF; }
            else { this.dvdntl = Number(BigInt.asUintN(32, q)); this.dvdnth = Number(BigInt.asUintN(32, x % y)); }
          } else { this.divuOvf = 1; this.dvdntl = 0x7FFFFFFF; this.dvdnth = 0x7FFFFFFF; }
          return;
        }
        case 0x180: this.dmac[0].sar = v; return; case 0x184: this.dmac[0].dar = v; return; case 0x188: this.dmac[0].tcr = v & 0xFFFFFF; return;
        case 0x190: this.dmac[1].sar = v; return; case 0x194: this.dmac[1].dar = v; return; case 0x198: this.dmac[1].tcr = v & 0xFFFFFF; return;
        case 0x18C: case 0x19C: { const d = this.dmac[a === 0x19C ? 1 : 0], old = d.chcr; d.chcr = (v & ~2) | (old & v & 2); this._dmaCheck(a === 0x19C ? 1 : 0); return; }
        case 0x1B0: { const old = this.dmaor & 0xF; this.dmaor = (v & ~6) | (old & v & 6); this._dmaCheck(0); this._dmaCheck(1); return; }
        case 0x1A0: case 0x1A8: return;
      }
      if (!KNOWN_PLAIN.has(a & ~3)) this._note(a);
    }
    iw16(a, v) {
      a &= 0x1FF;
      if (a >= 0x100) { const cur = this.ir32(a & ~3); this.iw32(a & ~3, (a & 2) ? ((cur & 0xFFFF0000) | (v & 0xFFFF)) : ((cur & 0xFFFF) | (v << 16))); return; }
      this.iv.setUint16(a & ~1, v);
      if (a === 0xE2) { this._recalcIrq(); return; }     // IPRA(DMA の割り込みレベル)
      if (!KNOWN_PLAIN.has(a & ~3)) this._note(a);
    }
    iw8(a, v) {
      a &= 0x1FF;
      if (a >= 0x100) { const sh = 8 * (3 - (a & 3)), cur = this.ir32(a & ~3); this.iw32(a & ~3, (cur & ~(0xFF << sh)) | ((v & 0xFF) << sh)); return; }
      if (a === 0x16) this._frcSync();                               // 分周を変える前に、今までの分を数える
      if (a === 0x12) { this._frcSync(); this.frc = (this.frc & 0x00FF) | ((v & 0xFF) << 8); }
      if (a === 0x13) { this._frcSync(); this.frc = (this.frc & 0xFF00) | (v & 0xFF); }
      this.ireg[a] = v;
      if (!KNOWN_PLAIN.has(a & ~3)) this._note(a);
    }

    // DMA: MAME は 1 単位を 2 サイクルごとに時間をかけて送る。ここでは始まった瞬間に全部送る
    // (サイクルスチールなら CPU はその間止まっているので結果は同じ。その分のサイクルは extra に足す)
    _dmaCheck(ch) {
      const d = this.dmac[ch];
      if (!(d.chcr & this.dmaor & 1) || (d.chcr & 2)) return;
      const incd = (d.chcr >> 14) & 3, incs = (d.chcr >> 12) & 3, size = (d.chcr >> 10) & 3, steal = d.chcr & 0x10;
      if (incd === 3 || incs === 3) return;
      let src = d.sar & 0xC7FFFFFF, dst = d.dar & 0xC7FFFFFF, count = d.tcr || 0x1000000;
      const b = this.bus, rd = this.onDmaRead;
      if (size === 1) { src &= ~1; dst &= ~1; } else if (size >= 2) { src &= ~3; dst &= ~3; if (size === 3) count &= ~3; }
      const unit = size === 0 ? 1 : size === 1 ? 2 : 4, n = count;
      for (; count > 0; count--) {
        const s = incs === 2 ? src - unit : src, t = incd === 2 ? dst - unit : dst;
        if (size === 0) b.w8(t >>> 0, rd(s >>> 0, 0)); else if (size === 1) b.w16(t >>> 0, rd(s >>> 0, 1)); else b.w32(t >>> 0, rd(s >>> 0, 2));
        if (size === 3) { src += 4; if (incd === 2) dst -= 4; else if (incd === 1) dst += 4; }   // 16 バイト単位: 元は必ず進む
        else { if (incs === 2) src -= unit; else if (incs === 1) src += unit; if (incd === 2) dst -= unit; else if (incd === 1) dst += unit; }
      }
      if (steal) this.extra += n * 2;
      d.sar = src >>> 0; d.dar = dst >>> 0; d.tcr = 0; d.chcr |= 2; d.irq = 1;
      this._recalcIrq();
    }

    // ── 実行 ────────────────────────────────────────────────────
    /** stopAt(通算サイクル)まで走る。機械側は走っている最中に stopAt を手前へ動かしてよい(割り込みやタイマの時刻で止めるため) */
    run() {
      const b = this.bus, r = this.r;
      while (this.cycles < this.stopAt) {
        if (this.sleeping) {
          if (this.testIrq) { this._checkIrq(); this.testIrq = false; }
          if (this.sleeping) { this.cycles = this.stopAt; break; }
        }
        const op = b.fetch(this.pc);
        if (this.delay) { this.pc = this.delay; this.delay = 0; } else this.pc = (this.pc + 2) >>> 0;
        this.cycles += 1 + this._exec(op, r, b);
        if (this.extra) { this.cycles += this.extra; this.extra = 0; }
        if (this.testIrq && !this.delay) { this._checkIrq(); this.testIrq = false; }
      }
    }

    // 1 命令。戻り値 = 余分のサイクル
    _exec(op, r, b) {
      const n = (op >> 8) & 15, m = (op >> 4) & 15;
      switch (op >> 12) {
        case 0x0:
          switch (op & 0xF) {
            case 0x2: if (m === 0) r[n] = this.sr; else if (m === 1) r[n] = this.gbr; else if (m === 2) r[n] = this.vbr; else return this._illegal(); return 0;
            case 0x3: if (m === 0) { this.pr = (this.pc + 2) >>> 0; this.delay = (this.pc + 2 + r[n]) >>> 0; } else if (m === 2) this.delay = (this.pc + 2 + r[n]) >>> 0; else return this._illegal(); return 0;
            case 0x4: b.w8((r[n] + r[0]) >>> 0, r[m] & 0xFF); return 0;
            case 0x5: b.w16((r[n] + r[0]) >>> 0, r[m] & 0xFFFF); return 0;
            case 0x6: b.w32((r[n] + r[0]) >>> 0, r[m]); return 0;
            case 0x7: this.macl = Math.imul(r[n], r[m]); return 0;
            case 0x8: if (m === 0) this.sr &= ~T; else if (m === 1) this.sr |= T; else if (m === 2) { this.mach = 0; this.macl = 0; } else return this._illegal(); return 0;
            case 0x9: if (m === 0) return 0; if (m === 1) { this.sr &= ~(M | Q | T); return 0; } if (m === 2) { r[n] = this.sr & T; return 0; } return this._illegal();
            case 0xA: if (m === 0) r[n] = this.mach; else if (m === 1) r[n] = this.macl; else if (m === 2) r[n] = this.pr; else return this._illegal(); return 0;
            case 0xB:
              if (m === 0) { this.delay = this.pr >>> 0; return 0; }                                 // RTS
              if (m === 1) { this.sleeping = true; return 2; }                                        // SLEEP
              if (m === 2) {                                                                          // RTE
                this.delay = b.r32(r[15] >>> 0) >>> 0; r[15] += 4;
                this.sr = b.r32(r[15] >>> 0) & SR_MASK; r[15] += 4;
                this.testIrq = true; return 3;
              }
              return this._illegal();
            case 0xC: r[n] = (b.r8((r[m] + r[0]) >>> 0) << 24) >> 24; return 0;
            case 0xD: r[n] = (b.r16((r[m] + r[0]) >>> 0) << 16) >> 16; return 0;
            case 0xE: r[n] = b.r32((r[m] + r[0]) >>> 0); return 0;
            case 0xF: this._macl(m, n); return 2;
          }
          return this._illegal();
        case 0x1: b.w32((r[n] + ((op & 15) << 2)) >>> 0, r[m]); return 0;
        case 0x2:
          switch (op & 0xF) {
            case 0x0: b.w8(r[n] >>> 0, r[m] & 0xFF); return 0;
            case 0x1: b.w16(r[n] >>> 0, r[m] & 0xFFFF); return 0;
            case 0x2: b.w32(r[n] >>> 0, r[m]); return 0;
            case 0x4: { const v = r[m]; r[n] -= 1; b.w8(r[n] >>> 0, v & 0xFF); return 0; }
            case 0x5: { const v = r[m]; r[n] -= 2; b.w16(r[n] >>> 0, v & 0xFFFF); return 0; }
            case 0x6: { const v = r[m]; r[n] -= 4; b.w32(r[n] >>> 0, v); return 0; }
            case 0x7: { let s = this.sr & ~(Q | M | T); if (r[n] < 0) s |= Q; if (r[m] < 0) s |= M; if ((r[m] ^ r[n]) < 0) s |= T; this.sr = s; return 0; }
            case 0x8: this.sr = (r[n] & r[m]) === 0 ? this.sr | T : this.sr & ~T; return 0;
            case 0x9: r[n] &= r[m]; return 0;
            case 0xA: r[n] ^= r[m]; return 0;
            case 0xB: r[n] |= r[m]; return 0;
            case 0xC: { const x = r[n] ^ r[m]; this.sr = (!(x & 0xFF000000) || !(x & 0xFF0000) || !(x & 0xFF00) || !(x & 0xFF)) ? this.sr | T : this.sr & ~T; return 0; }
            case 0xD: r[n] = (r[n] >>> 16) | (r[m] << 16); return 0;
            case 0xE: this.macl = Math.imul(r[n] & 0xFFFF, r[m] & 0xFFFF); return 0;
            case 0xF: this.macl = Math.imul((r[n] << 16) >> 16, (r[m] << 16) >> 16); return 0;
          }
          return this._illegal();
        case 0x3:
          switch (op & 0xF) {
            case 0x0: this.sr = r[n] === r[m] ? this.sr | T : this.sr & ~T; return 0;
            case 0x2: this.sr = (r[n] >>> 0) >= (r[m] >>> 0) ? this.sr | T : this.sr & ~T; return 0;
            case 0x3: this.sr = r[n] >= r[m] ? this.sr | T : this.sr & ~T; return 0;
            case 0x4: this._div1(m, n); return 0;
            case 0x5: { const a = r[n] >>> 0, c = r[m] >>> 0, al = a & 0xFFFF, ah = a >>> 16, cl = c & 0xFFFF, ch = c >>> 16;
              const lo = al * cl, mid = ah * cl + al * ch, hi = ah * ch;                            // mid は 2^33 未満、倍精度で正確
              const low = lo + (mid % 0x10000) * 0x10000;
              this.macl = low | 0; this.mach = (hi + Math.floor(mid / 0x10000) + Math.floor(low / 0x100000000)) | 0; return 0; }
            case 0x6: this.sr = (r[n] >>> 0) > (r[m] >>> 0) ? this.sr | T : this.sr & ~T; return 0;
            case 0x7: this.sr = r[n] > r[m] ? this.sr | T : this.sr & ~T; return 0;
            case 0x8: r[n] -= r[m]; return 0;
            case 0xA: { const a = r[n] >>> 0, c = r[m] >>> 0, t = this.sr & T, t1 = (a - c) >>> 0, res = (t1 - t) >>> 0; let nt = a < t1 ? 1 : 0; if (t1 < res) nt = 1; r[n] = res; this.sr = (this.sr & ~T) | nt; return 0; }
            case 0xB: { const a = r[n], c = r[m], res = (a - c) | 0; this.sr = (((a ^ c) & (a ^ res)) < 0) ? this.sr | T : this.sr & ~T; r[n] = res; return 0; }
            case 0xC: r[n] += r[m]; return 0;
            case 0xD: { const x = BigInt(r[n]) * BigInt(r[m]); this.macl = Number(BigInt.asIntN(32, x)); this.mach = Number(BigInt.asIntN(32, x >> 32n)); return 0; }
            case 0xE: { const a = r[n] >>> 0, c = r[m] >>> 0, t = this.sr & T, t1 = (a + c) >>> 0, res = (t1 + t) >>> 0; let nt = a > t1 ? 1 : 0; if (t1 > res) nt = 1; r[n] = res; this.sr = (this.sr & ~T) | nt; return 0; }
            case 0xF: { const a = r[n], c = r[m], res = (a + c) | 0; this.sr = ((~(a ^ c) & (a ^ res)) < 0) ? this.sr | T : this.sr & ~T; r[n] = res; return 0; }
          }
          return this._illegal();
        case 0x4: return this._exec4(op, n, m, r, b);
        case 0x5: r[n] = b.r32((r[m] + ((op & 15) << 2)) >>> 0); return 0;
        case 0x6:
          switch (op & 0xF) {
            case 0x0: r[n] = (b.r8(r[m] >>> 0) << 24) >> 24; return 0;
            case 0x1: r[n] = (b.r16(r[m] >>> 0) << 16) >> 16; return 0;
            case 0x2: r[n] = b.r32(r[m] >>> 0); return 0;
            case 0x3: r[n] = r[m]; return 0;
            case 0x4: { const v = (b.r8(r[m] >>> 0) << 24) >> 24; if (n !== m) r[m] += 1; r[n] = v; return 0; }
            case 0x5: { const v = (b.r16(r[m] >>> 0) << 16) >> 16; if (n !== m) r[m] += 2; r[n] = v; return 0; }
            case 0x6: { const v = b.r32(r[m] >>> 0); if (n !== m) r[m] += 4; r[n] = v; return 0; }
            case 0x7: r[n] = ~r[m]; return 0;
            case 0x8: { const v = r[m]; r[n] = (v & 0xFFFF0000) | ((v & 0xFF) << 8) | ((v >> 8) & 0xFF); return 0; }
            case 0x9: { const v = r[m]; r[n] = (v << 16) | (v >>> 16); return 0; }
            case 0xA: { const t = this.sr & T, tmp = (0 - r[m]) >>> 0, res = (tmp - t) >>> 0; let nt = tmp > 0 ? 1 : 0; if (tmp < res) nt = 1; r[n] = res; this.sr = (this.sr & ~T) | nt; return 0; }
            case 0xB: r[n] = -r[m]; return 0;
            case 0xC: r[n] = r[m] & 0xFF; return 0;
            case 0xD: r[n] = r[m] & 0xFFFF; return 0;
            case 0xE: r[n] = (r[m] << 24) >> 24; return 0;
            case 0xF: r[n] = (r[m] << 16) >> 16; return 0;
          }
          return 0;
        case 0x7: r[n] += (op << 24) >> 24; return 0;
        case 0x8:
          switch (n) {
            case 0x0: b.w8((r[m] + (op & 15)) >>> 0, r[0] & 0xFF); return 0;
            case 0x1: b.w16((r[m] + ((op & 15) << 1)) >>> 0, r[0] & 0xFFFF); return 0;
            case 0x4: r[0] = (b.r8((r[m] + (op & 15)) >>> 0) << 24) >> 24; return 0;
            case 0x5: r[0] = (b.r16((r[m] + ((op & 15) << 1)) >>> 0) << 16) >> 16; return 0;
            case 0x8: this.sr = r[0] === ((op << 24) >> 24) ? this.sr | T : this.sr & ~T; return 0;
            case 0x9: if (this.sr & T) { this.pc = (this.pc + 2 + (((op << 24) >> 24) << 1)) >>> 0; return 2; } return 0;      // BT
            case 0xB: if (!(this.sr & T)) { this.pc = (this.pc + 2 + (((op << 24) >> 24) << 1)) >>> 0; return 2; } return 0;   // BF
            case 0xD: if (this.sr & T) { this.delay = (this.pc + 2 + (((op << 24) >> 24) << 1)) >>> 0; return 1; } return 0;   // BT/S
            case 0xF: if (!(this.sr & T)) { this.delay = (this.pc + 2 + (((op << 24) >> 24) << 1)) >>> 0; return 1; } return 0; // BF/S
          }
          return this._illegal();
        case 0x9: r[n] = (b.r16((this.pc + 2 + ((op & 0xFF) << 1)) >>> 0) << 16) >> 16; return 0;
        case 0xA: this.delay = (this.pc + 2 + (((op << 20) >> 20) << 1)) >>> 0; return 0;
        case 0xB: this.pr = (this.pc + 2) >>> 0; this.delay = (this.pc + 2 + (((op << 20) >> 20) << 1)) >>> 0; return 0;
        case 0xC: {
          const i = op & 0xFF;
          switch (n) {
            case 0x0: b.w8((this.gbr + i) >>> 0, r[0] & 0xFF); return 0;
            case 0x1: b.w16((this.gbr + (i << 1)) >>> 0, r[0] & 0xFFFF); return 0;
            case 0x2: b.w32((this.gbr + (i << 2)) >>> 0, r[0]); return 0;
            case 0x3: { r[15] -= 4; b.w32(r[15] >>> 0, this.sr); r[15] -= 4; b.w32(r[15] >>> 0, this.pc); this.pc = b.r32((this.vbr + i * 4) >>> 0) >>> 0; return 7; }
            case 0x4: r[0] = (b.r8((this.gbr + i) >>> 0) << 24) >> 24; return 0;
            case 0x5: r[0] = (b.r16((this.gbr + (i << 1)) >>> 0) << 16) >> 16; return 0;
            case 0x6: r[0] = b.r32((this.gbr + (i << 2)) >>> 0); return 0;
            case 0x7: r[0] = (((this.pc + 2) & ~3) + (i << 2)) | 0; return 0;
            case 0x8: this.sr = (r[0] & i) === 0 ? this.sr | T : this.sr & ~T; return 0;
            case 0x9: r[0] &= i; return 0;
            case 0xA: r[0] ^= i; return 0;
            case 0xB: r[0] |= i; return 0;
            case 0xC: { const a = (this.gbr + r[0]) >>> 0; this.sr = (b.r8(a) & i) === 0 ? this.sr | T : this.sr & ~T; return 2; }
            case 0xD: { const a = (this.gbr + r[0]) >>> 0; b.w8(a, b.r8(a) & i); return 2; }
            case 0xE: { const a = (this.gbr + r[0]) >>> 0; b.w8(a, b.r8(a) ^ i); return 2; }
            case 0xF: { const a = (this.gbr + r[0]) >>> 0; b.w8(a, b.r8(a) | i); return 2; }
          }
          return 0;
        }
        case 0xD: r[n] = b.r32((((this.pc + 2) & ~3) + ((op & 0xFF) << 2)) >>> 0); return 0;
        case 0xE: r[n] = (op << 24) >> 24; return 0;
      }
      return this._illegal();
    }

    _exec4(op, n, m, r, b) {
      switch (op & 0xFF) {
        case 0x00: this.sr = (this.sr & ~T) | (r[n] >>> 31); r[n] <<= 1; return 0;                         // SHLL
        case 0x10: r[n] -= 1; this.sr = r[n] === 0 ? this.sr | T : this.sr & ~T; return 0;                 // DT
        case 0x20: this.sr = (this.sr & ~T) | (r[n] >>> 31); r[n] <<= 1; return 0;                         // SHAL
        case 0x01: this.sr = (this.sr & ~T) | (r[n] & 1); r[n] >>>= 1; return 0;                           // SHLR
        case 0x11: this.sr = r[n] >= 0 ? this.sr | T : this.sr & ~T; return 0;                             // CMP/PZ
        case 0x21: this.sr = (this.sr & ~T) | (r[n] & 1); r[n] >>= 1; return 0;                            // SHAR
        case 0x02: r[n] -= 4; b.w32(r[n] >>> 0, this.mach); return 0;
        case 0x12: r[n] -= 4; b.w32(r[n] >>> 0, this.macl); return 0;
        case 0x22: r[n] -= 4; b.w32(r[n] >>> 0, this.pr); return 0;
        case 0x03: r[n] -= 4; b.w32(r[n] >>> 0, this.sr); return 0;
        case 0x13: r[n] -= 4; b.w32(r[n] >>> 0, this.gbr); return 0;
        case 0x23: r[n] -= 4; b.w32(r[n] >>> 0, this.vbr); return 0;
        case 0x04: { const t = r[n] >>> 31; r[n] = (r[n] << 1) | t; this.sr = (this.sr & ~T) | t; return 0; }                     // ROTL
        case 0x24: { const t = r[n] >>> 31; r[n] = (r[n] << 1) | (this.sr & T); this.sr = (this.sr & ~T) | t; return 0; }         // ROTCL
        case 0x05: { const t = r[n] & 1; r[n] = (r[n] >>> 1) | (t << 31); this.sr = (this.sr & ~T) | t; return 0; }               // ROTR
        case 0x15: this.sr = r[n] > 0 ? this.sr | T : this.sr & ~T; return 0;                              // CMP/PL
        case 0x25: { const t = r[n] & 1; r[n] = (r[n] >>> 1) | ((this.sr & T) << 31); this.sr = (this.sr & ~T) | t; return 0; }   // ROTCR
        case 0x06: this.mach = b.r32(r[n] >>> 0); r[n] += 4; return 0;
        case 0x16: this.macl = b.r32(r[n] >>> 0); r[n] += 4; return 0;
        case 0x26: this.pr = b.r32(r[n] >>> 0) >>> 0; r[n] += 4; return 0;
        case 0x07: this.sr = b.r32(r[n] >>> 0) & SR_MASK; r[n] += 4; this.testIrq = true; return 2;
        case 0x17: this.gbr = b.r32(r[n] >>> 0); r[n] += 4; return 2;
        case 0x27: this.vbr = b.r32(r[n] >>> 0); r[n] += 4; return 2;
        case 0x08: r[n] <<= 2; return 0;
        case 0x18: r[n] <<= 8; return 0;
        case 0x28: r[n] <<= 16; return 0;
        case 0x09: r[n] >>>= 2; return 0;
        case 0x19: r[n] >>>= 8; return 0;
        case 0x29: r[n] >>>= 16; return 0;
        case 0x0A: this.mach = r[n]; return 0;
        case 0x1A: this.macl = r[n]; return 0;
        case 0x2A: this.pr = r[n] >>> 0; return 0;
        case 0x0B: this.pr = (this.pc + 2) >>> 0; this.delay = r[n] >>> 0; return 0;                       // JSR
        case 0x1B: { const a = r[n] >>> 0, v = b.r8(a); this.sr = v === 0 ? this.sr | T : this.sr & ~T; b.w8(a, v | 0x80); return 3; } // TAS
        case 0x2B: this.delay = r[n] >>> 0; return 0;                                                      // JMP
        case 0x0E: this.sr = r[n] & SR_MASK; this.testIrq = true; return 0;
        case 0x1E: this.gbr = r[n]; return 0;
        case 0x2E: this.vbr = r[n]; return 0;
      }
      if ((op & 0xF) === 0xF) { this._macw(m, n); return 2; }
      return this._illegal();
    }

    _illegal() {
      const b = this.bus, r = this.r;
      this.illegalCount = (this.illegalCount || 0) + 1;
      if (this.onIllegal) this.onIllegal((this.pc - 2) >>> 0);
      r[15] -= 4; b.w32(r[15] >>> 0, this.sr);
      r[15] -= 4; b.w32(r[15] >>> 0, (this.pc - 2) >>> 0);
      this.pc = b.r32((this.vbr + 16) >>> 0) >>> 0;
      return 5;
    }

    // DIV1(MAME の sh.cpp と同じ分岐)
    _div1(m, n) {
      const r = this.r;
      const oldQ = this.sr & Q;
      if (r[n] < 0) this.sr |= Q; else this.sr &= ~Q;
      r[n] = (r[n] << 1) | (this.sr & T);
      const tmp = r[n] >>> 0, q = (this.sr & Q) !== 0, mm = (this.sr & M) !== 0;
      let setQ;
      if (!oldQ) {
        if (!mm) { r[n] -= r[m]; const gt = (r[n] >>> 0) > tmp; setQ = !q ? gt : !gt; }
        else { r[n] += r[m]; const lt = (r[n] >>> 0) < tmp; setQ = !q ? !lt : lt; }
      } else {
        if (!mm) { r[n] += r[m]; const lt = (r[n] >>> 0) < tmp; setQ = !q ? lt : !lt; }
        else { r[n] -= r[m]; const gt = (r[n] >>> 0) > tmp; setQ = !q ? !gt : gt; }
      }
      if (setQ) this.sr |= Q; else this.sr &= ~Q;
      const qm = this.sr & (Q | M);
      this.sr = (qm === 0 || qm === (Q | M)) ? this.sr | T : this.sr & ~T;
    }
    _macl(m, n) {
      const r = this.r, b = this.bus;
      const a = BigInt(b.r32(r[n] >>> 0) | 0); r[n] += 4;
      const c = BigInt(b.r32(r[m] >>> 0) | 0); r[m] += 4;
      let acc = (BigInt(this.mach | 0) << 32n) | BigInt(this.macl >>> 0);
      if (this.sr & S) {
        // 48bit 飽和(MAME と同じ扱い: MACH の下位 16bit だけを足し込む)
        acc = (BigInt(this.mach & 0xFFFF) << 32n) | BigInt(this.macl >>> 0);
        let res = a * c + acc;
        const hi = BigInt.asIntN(32, res >> 32n);
        if (hi < 0n && BigInt.asUintN(32, hi) < 0xFFFF8000n) res = 0x0000800000000000n;
        else if (hi > 0x7FFFn) res = 0x00007FFFFFFFFFFFn;
        this.mach = Number(BigInt.asIntN(32, res >> 32n)); this.macl = Number(BigInt.asIntN(32, res));
        return;
      }
      const res = a * c + acc;
      this.mach = Number(BigInt.asIntN(32, res >> 32n)); this.macl = Number(BigInt.asIntN(32, res));
    }
    _macw(m, n) {
      const r = this.r, b = this.bus;
      const a = (b.r16(r[n] >>> 0) << 16) >> 16; r[n] += 2;
      const c = (b.r16(r[m] >>> 0) << 16) >> 16; r[m] += 2;
      const prod = Math.imul(a, c), templ = this.macl >>> 0;
      const dest = templ >>> 31, src = (prod >>> 31) + dest;
      this.macl = (this.macl + prod) | 0;
      const ans = (this.macl >>> 31) + dest;
      if (this.sr & S) {
        if (ans === 1) { if (src === 0) this.macl = 0x7FFFFFFF; else if (src === 2) this.macl = 0x80000000 | 0; }
      } else {
        this.mach = (this.mach + (prod < 0 ? -1 : 0)) | 0;
        if (templ > (this.macl >>> 0)) this.mach = (this.mach + 1) | 0;
      }
    }
  }

  // 値を控えるだけで足りる(動きを作らなくてよい)内蔵レジスタ。番地は 0xFFFFFE00 からの位置を 4 で丸めた物
  //   0x60-0x68: IPRB/VCRA-D、0x90: SBYCR/CCR(キャッシュの制御。キャッシュは作らない)、0xE0-0xE4: ICR/IPRA/VCRWDT、
  //   0x1A0/0x1A8: VCRDMA、0x1E0-0x1F8: バスの設定(BCR/WCR/MCR/RTCSR/RTCNT/RTCOR)
  const KNOWN_PLAIN = new Set([0x10, 0x14, 0x60, 0x64, 0x68, 0x90, 0xE0, 0xE4, 0x1A0, 0x1A8, 0x1E0, 0x1E4, 0x1E8, 0x1EC, 0x1F0, 0x1F4, 0x1F8]);

  Cps3.SH2 = SH2;
})(typeof window !== 'undefined' ? window : globalThis);
