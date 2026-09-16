/*
 * MIPS R3000A CPU エミュレータ (PlayStation)
 * MML.Emu.CPUR3000
 *
 * - MIPS I 命令セット + COP0(SR/CAUSE/EPC/BadVaddr、RFE)。GTE(COP2)は演算しない(レジスタ読みは0)。
 * - 分岐遅延スロットを実装する。ロード結果は即時に見える(ld() の注記参照)。
 * - 例外: 割込み(0)/アドレス(4: 命令フェッチの非整列のみ)/SYSCALL(8)/BREAK(9)/不正命令(10)/オーバーフロー(12)。
 *   データアクセスの非整列は例外にしない(実機/DuckStation と同じ。バス側でバイト単位に読む)。
 *   ベクタは SR.BEV に従い 0x80000080 / 0xBFC00180。
 * - 命令あたりのサイクルは固定 CPI(既定2、PCSXのBIASと同じ)。実機のキャッシュ/バス待ちは模倣しない。
 *   (音源ドライバの時間管理はルートカウンタ/VBlank割込み駆動なので、CPIの誤差は
 *    ビジーループの消費時間にしか効かない)
 *
 * バスに要求するもの:
 *   bus.read8/read16/read32(addr), bus.write8/write16/write32(addr, value)
 *   bus.irqLine  (I_STAT & I_MASK != 0 なら true。CAUSE.IP2 に反映される)
 *   bus.onSyscall?(cpu)  HLE BIOS が SYSCALL/BREAK を横取りしたいとき(true を返すと例外を起こさない)
 *   bus.onTrap?(cpu, pc) 実行アドレスが bus.trapMask に一致したとき(HLE BIOSの入口)。true で命令を実行しない
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const EXC_INT = 0, EXC_ADEL = 4, EXC_ADES = 5, EXC_SYS = 8, EXC_BP = 9, EXC_RI = 10, EXC_CPU = 11, EXC_OV = 12;
  const DEFAULT_CPI = 2;

  class CPUR3000 {
    constructor(bus) {
      this.bus = bus;
      this.r = new Int32Array(32);
      this.hi = 0; this.lo = 0;
      this.pc = 0xBFC00000 | 0;
      this.nextPc = 0;
      this.sr = 0; this.cause = 0; this.epc = 0; this.badVaddr = 0;
      this.cop0 = new Int32Array(16); // その他のCOP0レジスタ(BPC/DCIC等)の置き場
      this.branchDelay = false;   // 次に実行する命令が分岐遅延スロットか
      this.inDelay = false;       // 今実行中の命令が分岐遅延スロットか
      this.curPc = 0;             // 実行中の命令のアドレス(例外のEPC用)
      this.cycles = 0;            // 累積サイクル
      this.cpi = DEFAULT_CPI;
      this.halted = false;        // HLE側が「もう進めない」と判断したとき
      this.exceptionCount = 0;
    }

    reset() {
      this.r.fill(0);
      this.hi = 0; this.lo = 0;
      this.pc = 0xBFC00000 | 0; this.nextPc = (this.pc + 4) | 0;
      this.sr = 0x10900000 | 0; // BEV=1, CU0 は不要。RFE前はカーネルモード
      this.cause = 0; this.epc = 0; this.badVaddr = 0;
      this.cop0.fill(0);
      this.cop0[15] = 0x00000002; // PRID
      this.branchDelay = false; this.inDelay = false;
      this.cycles = 0;
      this.halted = false;
      this.exceptionCount = 0;
    }

    /** レジスタを直接設定して実行開始点を決める(PSF: PC/SP/GP) */
    setEntry(pc, sp, gp) {
      this.pc = pc | 0; this.nextPc = (pc + 4) | 0;
      this.r[29] = sp | 0; this.r[28] = gp | 0;
      this.branchDelay = false;
    }

    // ── 例外 ──────────────────────────────────────────────
    exception(code, badAddr) {
      this.exceptionCount++;
      const bd = this.inDelay;
      this.epc = bd ? (this.curPc - 4) | 0 : this.curPc;
      this.cause = (this.cause & 0x0000FF00) | (code << 2) | (bd ? 0x80000000 : 0) | (this.cop0[13] & 0x30000000);
      if (code === EXC_ADEL || code === EXC_ADES) this.badVaddr = badAddr | 0;
      // SR: KU/IE を2ビット分シフト(現在→旧)
      this.sr = (this.sr & ~0x3F) | ((this.sr << 2) & 0x3C);
      const vec = (this.sr & 0x400000) ? 0xBFC00180 : 0x80000080;
      this.pc = vec | 0; this.nextPc = (vec + 4) | 0;
      this.branchDelay = false; this.inDelay = false;
    }

    /** RFE: SR の KU/IE を戻す */
    rfe() {
      this.sr = (this.sr & ~0x0F) | ((this.sr >> 2) & 0x0F);
    }

    /** 割込み要求ラインの状態を CAUSE.IP2 に写し、受理できれば例外を起こす */
    pollInterrupt() {
      if (this.bus.irqLine) this.cause |= 0x400; else this.cause &= ~0x400;
      if ((this.sr & 1) && (this.sr & this.cause & 0xFF00)) {
        this.curPc = this.pc;
        // 分岐遅延スロットの直前で受理すると EPC が分岐命令になる: そのまま扱える
        this.inDelay = this.branchDelay;
        this.exception(EXC_INT, 0);
        return true;
      }
      return false;
    }

    // ── 実行 ──────────────────────────────────────────────
    /**
     * 指定サイクルぶん実行する(命令境界で停止)。戻り値は実際に消費したサイクル。
     */
    run(budget) {
      const start = this.cycles;
      const end = start + budget;
      while (this.cycles < end && !this.halted) {
        this.step();
      }
      return this.cycles - start;
    }

    /** 1命令実行。戻り値は消費サイクル */
    step() {
      const bus = this.bus;
      const r = this.r;
      // 割込み受理(命令境界)
      if (bus.irqLine || (this.cause & 0x400)) {
        if (this.pollInterrupt()) { this.cycles += this.cpi; return this.cpi; }
      }
      const pc = this.pc;
      this.curPc = pc;
      this.inDelay = this.branchDelay;
      this.branchDelay = false;
      // HLE BIOS の入口(トラップ)
      if (bus.trapMask !== undefined && ((pc & bus.trapMask) >>> 0) === bus.trapBase) {
        if (bus.onTrap(this, pc)) {
          this.cycles += this.cpi;
          return this.cpi;
        }
      }
      if (pc & 3) { this.exception(EXC_ADEL, pc); this.cycles += this.cpi; return this.cpi; }
      const op = bus.read32(pc) | 0;
      this.pc = this.nextPc;
      this.nextPc = (this.nextPc + 4) | 0;

      const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31;
      const imm = op << 16 >> 16;        // 符号拡張即値
      const immU = op & 0xFFFF;
      const sa = (op >>> 6) & 31;
      let cyc = this.cpi;

      switch (op >>> 26) {
        case 0x00: // SPECIAL
          switch (op & 0x3F) {
            case 0x00: this.wr(rd, r[rt] << sa); break;                    // SLL
            case 0x02: this.wr(rd, r[rt] >>> sa); break;                   // SRL
            case 0x03: this.wr(rd, r[rt] >> sa); break;                    // SRA
            case 0x04: this.wr(rd, r[rt] << (r[rs] & 31)); break;          // SLLV
            case 0x06: this.wr(rd, r[rt] >>> (r[rs] & 31)); break;         // SRLV
            case 0x07: this.wr(rd, r[rt] >> (r[rs] & 31)); break;          // SRAV
            case 0x08: this.nextPc = r[rs]; this.branchDelay = true; break; // JR
            case 0x09: { const t = r[rs]; this.wr(rd, this.nextPc); this.nextPc = t; this.branchDelay = true; break; } // JALR
            case 0x0C: // SYSCALL
              if (bus.onSyscall && bus.onSyscall(this, false)) break;
              this.exception(EXC_SYS, 0); break;
            case 0x0D: // BREAK
              if (bus.onSyscall && bus.onSyscall(this, true)) break;
              this.exception(EXC_BP, 0); break;
            case 0x10: this.wr(rd, this.hi); break;                        // MFHI
            case 0x11: this.hi = r[rs]; break;                             // MTHI
            case 0x12: this.wr(rd, this.lo); break;                        // MFLO
            case 0x13: this.lo = r[rs]; break;                             // MTLO
            case 0x18: this.mult(r[rs], r[rt], true); cyc += 6; break;     // MULT
            case 0x19: this.mult(r[rs], r[rt], false); cyc += 6; break;    // MULTU
            case 0x1A: { // DIV
              const a = r[rs], b = r[rt];
              if (b === 0) { this.lo = a >= 0 ? -1 : 1; this.hi = a; }
              else if (a === -2147483648 && b === -1) { this.lo = -2147483648; this.hi = 0; }
              else { this.lo = (a / b) | 0; this.hi = a % b; }
              cyc += 30; break;
            }
            case 0x1B: { // DIVU
              const a = r[rs] >>> 0, b = r[rt] >>> 0;
              if (b === 0) { this.lo = -1; this.hi = a | 0; }
              else { this.lo = Math.floor(a / b) | 0; this.hi = (a % b) | 0; }
              cyc += 30; break;
            }
            case 0x20: { // ADD
              const a = r[rs], b = r[rt], s = (a + b) | 0;
              if (((a ^ s) & (b ^ s)) < 0) { this.exception(EXC_OV, 0); break; }
              this.wr(rd, s); break;
            }
            case 0x21: this.wr(rd, (r[rs] + r[rt]) | 0); break;            // ADDU
            case 0x22: { // SUB
              const a = r[rs], b = r[rt], s = (a - b) | 0;
              if (((a ^ b) & (a ^ s)) < 0) { this.exception(EXC_OV, 0); break; }
              this.wr(rd, s); break;
            }
            case 0x23: this.wr(rd, (r[rs] - r[rt]) | 0); break;            // SUBU
            case 0x24: this.wr(rd, r[rs] & r[rt]); break;                  // AND
            case 0x25: this.wr(rd, r[rs] | r[rt]); break;                  // OR
            case 0x26: this.wr(rd, r[rs] ^ r[rt]); break;                  // XOR
            case 0x27: this.wr(rd, ~(r[rs] | r[rt])); break;               // NOR
            case 0x2A: this.wr(rd, r[rs] < r[rt] ? 1 : 0); break;          // SLT
            case 0x2B: this.wr(rd, (r[rs] >>> 0) < (r[rt] >>> 0) ? 1 : 0); break; // SLTU
            default: this.exception(EXC_RI, 0); break;
          }
          break;
        case 0x01: { // REGIMM
          const cond = r[rs] < 0;
          const link = (rt & 0x1E) === 0x10;
          const target = (this.pc + (imm << 2)) | 0;
          if (link) this.wr(31, this.nextPc);
          // BLTZ(0)/BGEZ(1)/BLTZAL(16)/BGEZAL(17)。他のrtはビット0で判定する実機挙動
          if ((rt & 1) ? !cond : cond) this.nextPc = target;
          this.branchDelay = true;
          break;
        }
        case 0x02: this.nextPc = ((this.pc & 0xF0000000) | ((op & 0x03FFFFFF) << 2)) | 0; this.branchDelay = true; break; // J
        case 0x03: this.wr(31, this.nextPc); this.nextPc = ((this.pc & 0xF0000000) | ((op & 0x03FFFFFF) << 2)) | 0; this.branchDelay = true; break; // JAL
        case 0x04: if (r[rs] === r[rt]) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break; // BEQ
        case 0x05: if (r[rs] !== r[rt]) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break; // BNE
        case 0x06: if (r[rs] <= 0) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break;   // BLEZ
        case 0x07: if (r[rs] > 0) this.nextPc = (this.pc + (imm << 2)) | 0; this.branchDelay = true; break;    // BGTZ
        case 0x08: { // ADDI
          const a = r[rs], s = (a + imm) | 0;
          if (((a ^ s) & (imm ^ s)) < 0) { this.exception(EXC_OV, 0); break; }
          this.wr(rt, s); break;
        }
        case 0x09: this.wr(rt, (r[rs] + imm) | 0); break;                  // ADDIU
        case 0x0A: this.wr(rt, r[rs] < imm ? 1 : 0); break;                // SLTI
        case 0x0B: this.wr(rt, (r[rs] >>> 0) < (imm >>> 0) ? 1 : 0); break; // SLTIU
        case 0x0C: this.wr(rt, r[rs] & immU); break;                       // ANDI
        case 0x0D: this.wr(rt, r[rs] | immU); break;                       // ORI
        case 0x0E: this.wr(rt, r[rs] ^ immU); break;                       // XORI
        case 0x0F: this.wr(rt, immU << 16); break;                         // LUI
        case 0x10: // COP0
          switch (rs) {
            case 0x00: this.ld(rt, this.mfc0(rd)); break;                  // MFC0
            case 0x02: this.ld(rt, this.mfc0(rd)); break;                  // CFC0(実機には無いが無害)
            case 0x04: this.mtc0(rd, r[rt]); break;                        // MTC0
            case 0x06: break;                                               // CTC0
            case 0x10: if ((op & 0x3F) === 0x10) this.rfe(); break;        // RFE
            default: break;
          }
          break;
        case 0x11: // COP1(無い): 例外
        case 0x13: this.exception(EXC_CPU, 0); break;
        case 0x12: // COP2(GTE): 演算はしない。読みは0
          switch (rs) {
            case 0x00: case 0x02: this.ld(rt, 0); break;                   // MFC2/CFC2
            default: break;                                                 // MTC2/CTC2/演算
          }
          break;
        case 0x20: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read8(a) << 24 >> 24); cyc++; break; }   // LB
        case 0x21: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read16(a) << 16 >> 16); cyc++; break; } // LH
        case 0x22: { // LWL
          const a = (r[rs] + imm) | 0;
          const mem = bus.read32(a & ~3) | 0;
          const cur = r[rt];
          let v;
          switch (a & 3) {
            case 0: v = (mem << 24) | (cur & 0x00FFFFFF); break;
            case 1: v = (mem << 16) | (cur & 0x0000FFFF); break;
            case 2: v = (mem << 8) | (cur & 0x000000FF); break;
            default: v = mem; break;
          }
          this.ld(rt, v); cyc++; break;
        }
        case 0x23: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read32(a) | 0); cyc++; break; } // LW
        case 0x24: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read8(a) & 0xFF); cyc++; break; }     // LBU
        case 0x25: { const a = (r[rs] + imm) | 0; this.ld(rt, bus.read16(a) & 0xFFFF); cyc++; break; } // LHU
        case 0x26: { // LWR
          const a = (r[rs] + imm) | 0;
          const mem = bus.read32(a & ~3) | 0;
          const cur = r[rt];
          let v;
          switch (a & 3) {
            case 0: v = mem; break;
            case 1: v = (mem >>> 8) | (cur & 0xFF000000); break;
            case 2: v = (mem >>> 16) | (cur & 0xFFFF0000); break;
            default: v = (mem >>> 24) | (cur & 0xFFFFFF00); break;
          }
          this.ld(rt, v | 0); cyc++; break;
        }
        case 0x28: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write8(a, r[rt] & 0xFF); cyc++; break; }   // SB
        case 0x29: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write16(a, r[rt] & 0xFFFF); cyc++; break; } // SH
        case 0x2A: { // SWL
          const a = (r[rs] + imm) | 0;
          if (this.sr & 0x10000) break;
          const al = a & ~3;
          const mem = bus.read32(al) | 0, v = r[rt];
          let out;
          switch (a & 3) {
            case 0: out = (mem & 0xFFFFFF00) | (v >>> 24); break;
            case 1: out = (mem & 0xFFFF0000) | (v >>> 16); break;
            case 2: out = (mem & 0xFF000000) | (v >>> 8); break;
            default: out = v; break;
          }
          bus.write32(al, out | 0); cyc++; break;
        }
        case 0x2B: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write32(a, r[rt]); cyc++; break; } // SW
        case 0x2E: { // SWR
          const a = (r[rs] + imm) | 0;
          if (this.sr & 0x10000) break;
          const al = a & ~3;
          const mem = bus.read32(al) | 0, v = r[rt];
          let out;
          switch (a & 3) {
            case 0: out = v; break;
            case 1: out = (mem & 0x000000FF) | (v << 8); break;
            case 2: out = (mem & 0x0000FFFF) | (v << 16); break;
            default: out = (mem & 0x00FFFFFF) | (v << 24); break;
          }
          bus.write32(al, out | 0); cyc++; break;
        }
        case 0x30: case 0x31: case 0x33: this.exception(EXC_CPU, 0); break; // LWC0/1/3
        case 0x32: { const a = (r[rs] + imm) | 0; bus.read32(a); cyc++; break; }   // LWC2 (GTEへ: 読み捨て)
        case 0x38: case 0x39: case 0x3B: this.exception(EXC_CPU, 0); break; // SWC0/1/3
        case 0x3A: { const a = (r[rs] + imm) | 0; if (!(this.sr & 0x10000)) bus.write32(a, 0); cyc++; break; } // SWC2 (GTEレジスタは0)
        default: this.exception(EXC_RI, 0); break;
      }

      r[0] = 0;
      this.cycles += cyc;
      return cyc;
    }

    /** レジスタへ即時書き込み(遅延中の同レジスタへのロードは捨てる) */
    wr(reg, val) {
      if (reg === 0) return;
      this.r[reg] = val | 0;
    }

    /**
     * ロード結果の書き込み。
     * MIPS I の仕様書上は「次の命令からは古い値が見える」ロード遅延があるが、PS1 の実機では
     * 即時に見える(Philosoma の起動コードが lw s7 直後の add s7,s7,s4 で新しい値を前提にしており、
     * 遅延を入れると加算オーバーフロー例外で止まる)。PCSX/Mednafen/DuckStation も即時扱い。
     */
    ld(reg, val) {
      if (reg === 0) return;
      this.r[reg] = val | 0;
    }

    mult(a, b, signed) {
      let neg = false;
      let ua = a, ub = b;
      if (signed) {
        if (a < 0) { ua = (-a) | 0; neg = !neg; }
        if (b < 0) { ub = (-b) | 0; neg = !neg; }
      }
      ua >>>= 0; ub >>>= 0;
      const ah = ua >>> 16, al = ua & 0xFFFF, bh = ub >>> 16, bl = ub & 0xFFFF;
      const ll = al * bl;
      const mid = al * bh + ah * bl + Math.floor(ll / 65536);
      let lo = (ll % 65536 + (mid % 65536) * 65536) >>> 0;
      let hi = (ah * bh + Math.floor(mid / 65536)) >>> 0;
      if (neg) {
        lo = (-lo) >>> 0;
        hi = ((~hi) + (lo === 0 ? 1 : 0)) >>> 0;
      }
      this.lo = lo | 0; this.hi = hi | 0;
    }

    mfc0(reg) {
      switch (reg) {
        case 8: return this.badVaddr;
        case 12: return this.sr;
        case 13: return this.cause;
        case 14: return this.epc;
        default: return this.cop0[reg & 15];
      }
    }

    mtc0(reg, val) {
      switch (reg) {
        case 12: this.sr = val | 0; break;
        case 13: this.cause = (this.cause & ~0x300) | (val & 0x300); break; // ソフト割込みビットのみ書ける
        case 14: this.epc = val | 0; break;
        case 8: break;
        default: this.cop0[reg & 15] = val | 0; break;
      }
    }
  }

  CPUR3000.EXC = { INT: EXC_INT, ADEL: EXC_ADEL, ADES: EXC_ADES, SYS: EXC_SYS, BP: EXC_BP, RI: EXC_RI, CPU: EXC_CPU, OV: EXC_OV };
  Emu.CPUR3000 = CPUR3000;
})(window);
