/*
 * SM83 (LR35902 / Game Boy CPU) コア
 * MML.Emu.CPUSm83
 *
 * Z80と命令セットは似ているが別物であり、cpuZ80.js は流用できない
 * (参考: Pan Docs https://gbdev.io/pandocs/ 、
 *  NESdev BBS "Game Boy CPU isn't a Z80. What is it?" https://forums.nesdev.org/viewtopic.php?t=18335)。
 * 主な相違点:
 *   - IX/IY・裏レジスタ(BC'/DE'/HL'/AF')・ブロック命令(LDIR等)・IN/OUT・IM0-2・NMI が無い
 *   - フラグはZ/N/H/Cの4bitのみ(Z80のS・P/V・未定義X/Yビットは無い。下位4bitは常に0)
 *   - GB固有命令: LD (HL+/-),A / LD A,(HL+/-) / LDH (n),A / LDH A,(n) / LDH (C),A / LDH A,(C) /
 *     ADD SP,r8 / LD HL,SP+r8 / STOP
 *   - RLCA/RRCA/RLA/RRA はZ80と異なり常にZフラグをクリアする(CB接頭辞のRLC A等はZ80同様
 *     結果に応じてZが立つ。ここが取り違えやすい既知の相違点)
 *   - CB接頭辞のビット演算はZ80とほぼ同一だが、y=6のスロットがZ80の非公式SLLではなく
 *     正式命令SWAP(上下ニブル交換)になっている
 *   - DAAの補正アルゴリズムはZ80と異なる専用式(下記daa()参照)
 *   - RETIはRETと違い、戻った直後ではなく即座に割込を許可する(EIのような1命令遅延が無い)
 *
 * bus.read(addr)/bus.write(addr,value) のみを介してアクセスする(I/Oポートは無く、
 * 全てメモリマップド。IE($FFFF)/IF($FF0F)もこのバス経由の通常アドレスとして扱う)。
 * call(addr)/beginCall(addr)/stepCall() は cpu6502.js/cpuZ80.js と同じ設計
 * (呼び出し先アドレスをCALLし、番兵アドレスへのRETで終了を検知する)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const F_C = 0x10;
  const F_H = 0x20;
  const F_N = 0x40;
  const F_Z = 0x80;

  // CALL終了検知用の番兵リターンアドレス(cpuZ80.js/cpu6502.jsと同じ手法)
  const CALL_SENTINEL = 0xFFFF;

  class CPUSm83 {
    /**
     * @param {{read:(addr:number)=>number, write:(addr:number,value:number)=>void}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.a = 0; this.f = 0;
      this.b = 0; this.c = 0;
      this.d = 0; this.e = 0;
      this.h = 0; this.l = 0;
      this.sp = 0xFFFF;
      this.pc = 0;
      this.ime = false;
      this.imePending = 0; // EI発行後の遅延カウンタ(2で発行、0でime=true確定)
      this.halted = false;
      this.stopped = false;
      this.callActive = false;
    }

    // --- メモリアクセス ---
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }

    fetchByte() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
    fetchSigned() { const v = this.fetchByte(); return v < 0x80 ? v : v - 0x100; }
    fetch16() {
      const lo = this.fetchByte();
      const hi = this.fetchByte();
      return lo | (hi << 8);
    }

    push16(value) {
      this.sp = (this.sp - 1) & 0xFFFF;
      this.write(this.sp, (value >> 8) & 0xFF);
      this.sp = (this.sp - 1) & 0xFFFF;
      this.write(this.sp, value & 0xFF);
    }
    pop16() {
      const lo = this.read(this.sp);
      this.sp = (this.sp + 1) & 0xFFFF;
      const hi = this.read(this.sp);
      this.sp = (this.sp + 1) & 0xFFFF;
      return lo | (hi << 8);
    }

    // --- フラグ(下位4bitは常に0) ---
    getFlag(mask) { return (this.f & mask) !== 0; }
    setFlag(mask, on) { this.f = on ? (this.f | mask) : (this.f & ~mask); }

    // --- レジスタペア ---
    getBC() { return (this.b << 8) | this.c; }
    setBC(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
    getDE() { return (this.d << 8) | this.e; }
    setDE(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
    getHL() { return (this.h << 8) | this.l; }
    setHL(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
    getAF() { return (this.a << 8) | this.f; }
    setAF(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xF0; } // Fの下位4bitは実機同様常に0

    // 8bitレジスタコード(0=B,1=C,2=D,3=E,4=H,5=L,6=(HL),7=A)。Z80と同じ並び。
    getR8(code) {
      switch (code) {
        case 0: return this.b;
        case 1: return this.c;
        case 2: return this.d;
        case 3: return this.e;
        case 4: return this.h;
        case 5: return this.l;
        case 6: return this.read(this.getHL());
        case 7: return this.a;
      }
    }
    setR8(code, value) {
      value &= 0xFF;
      switch (code) {
        case 0: this.b = value; break;
        case 1: this.c = value; break;
        case 2: this.d = value; break;
        case 3: this.e = value; break;
        case 4: this.h = value; break;
        case 5: this.l = value; break;
        case 6: this.write(this.getHL(), value); break;
        case 7: this.a = value; break;
      }
    }

    // --- 8bit ALU ---
    add8(value, carryIn) {
      const a = this.a;
      const sum = a + value + carryIn;
      const result = sum & 0xFF;
      this.setFlag(F_H, ((a & 0xF) + (value & 0xF) + carryIn) > 0xF);
      this.setFlag(F_C, sum > 0xFF);
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      this.a = result;
    }
    sub8(value, carryIn, storeResult) {
      const a = this.a;
      const diff = a - value - carryIn;
      const result = diff & 0xFF;
      this.setFlag(F_H, ((a & 0xF) - (value & 0xF) - carryIn) < 0);
      this.setFlag(F_C, diff < 0);
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0);
      if (storeResult) this.a = result;
    }
    and8(value) {
      this.a &= value;
      this.setFlag(F_H, true); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, this.a === 0);
    }
    or8(value) {
      this.a |= value;
      this.setFlag(F_H, false); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, this.a === 0);
    }
    xor8(value) {
      this.a ^= value;
      this.setFlag(F_H, false); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, this.a === 0);
    }
    inc8(v) {
      const result = (v + 1) & 0xFF;
      this.setFlag(F_H, (v & 0xF) === 0xF);
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      return result;
    }
    dec8(v) {
      const result = (v - 1) & 0xFF;
      this.setFlag(F_H, (v & 0xF) === 0x0);
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0);
      return result;
    }
    aluOp(y, value) {
      switch (y) {
        case 0: this.add8(value, 0); break;
        case 1: this.add8(value, this.getFlag(F_C) ? 1 : 0); break;
        case 2: this.sub8(value, 0, true); break;
        case 3: this.sub8(value, this.getFlag(F_C) ? 1 : 0, true); break;
        case 4: this.and8(value); break;
        case 5: this.xor8(value); break;
        case 6: this.or8(value); break;
        case 7: this.sub8(value, 0, false); break;
      }
    }

    // --- 16bit ---
    addHL(rpVal) {
      const hl = this.getHL();
      const sum = hl + rpVal;
      const result = sum & 0xFFFF;
      this.setFlag(F_H, ((hl & 0xFFF) + (rpVal & 0xFFF)) > 0xFFF);
      this.setFlag(F_C, sum > 0xFFFF);
      this.setFlag(F_N, false);
      this.setHL(result); // Zは変化しない(実機仕様)
    }
    // ADD SP,r8 と LD HL,SP+r8 で共用。r8をフェッチし、フラグはSPの下位バイト+符号無し
    // 表現の加算で計算する(実機の既知仕様。符号拡張した実際の加算結果とは別に判定する)。
    addSpR8() {
      const r8 = this.fetchSigned();
      const raw = r8 & 0xFF;
      const result = (this.sp + r8) & 0xFFFF;
      this.setFlag(F_H, ((this.sp & 0xF) + (raw & 0xF)) > 0xF);
      this.setFlag(F_C, ((this.sp & 0xFF) + raw) > 0xFF);
      this.setFlag(F_Z, false);
      this.setFlag(F_N, false);
      return result;
    }

    // RLCA/RRCA/RLA/RRA: CB接頭辞版と異なり常にZをクリアする(GB固有、取り違え注意)
    rlca() { const c = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }
    rrca() { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }
    rla() { const c = (this.a >> 7) & 1; const oldC = this.getFlag(F_C) ? 1 : 0; this.a = ((this.a << 1) | oldC) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }
    rra() { const c = this.a & 1; const oldC = this.getFlag(F_C) ? 0x80 : 0; this.a = ((this.a >> 1) | oldC) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }

    // GB固有のDAA補正式(Z80とは別物。Pan Docs "DAA" 参照)
    daa() {
      let a = this.a;
      let corr = 0;
      let setC = false;
      const n = this.getFlag(F_N), c = this.getFlag(F_C), h = this.getFlag(F_H);
      if (!n) {
        if (h || (a & 0x0F) > 0x09) corr |= 0x06;
        if (c || a > 0x99) { corr |= 0x60; setC = true; }
        a = (a + corr) & 0xFF;
      } else {
        if (h) corr |= 0x06;
        if (c) corr |= 0x60;
        a = (a - corr) & 0xFF;
        setC = c;
      }
      this.a = a;
      this.setFlag(F_C, setC);
      this.setFlag(F_H, false);
      this.setFlag(F_Z, a === 0);
    }

    // --- CB接頭辞の回転/シフト共通処理。y=6はZ80の非公式SLLではなく正式命令SWAP ---
    rotOp(y, v) {
      let carry, result;
      switch (y) {
        case 0: carry = (v >> 7) & 1; result = ((v << 1) | carry) & 0xFF; break; // RLC
        case 1: carry = v & 1; result = ((v >> 1) | (carry << 7)) & 0xFF; break; // RRC
        case 2: carry = (v >> 7) & 1; result = ((v << 1) | (this.getFlag(F_C) ? 1 : 0)) & 0xFF; break; // RL
        case 3: carry = v & 1; result = ((v >> 1) | (this.getFlag(F_C) ? 0x80 : 0)) & 0xFF; break; // RR
        case 4: carry = (v >> 7) & 1; result = (v << 1) & 0xFF; break; // SLA
        case 5: carry = v & 1; result = ((v >> 1) | (v & 0x80)) & 0xFF; break; // SRA
        case 6: carry = 0; result = (((v & 0x0F) << 4) | ((v & 0xF0) >> 4)) & 0xFF; break; // SWAP
        case 7: carry = v & 1; result = (v >> 1) & 0xFF; break; // SRL
      }
      this.setFlag(F_C, carry !== 0);
      this.setFlag(F_H, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      return result;
    }

    // --- メイン実行ループ ---
    step() {
      // EI発行から1命令分遅延させてimeを立てる(EI自身の命令実行中はまだ有効化しない)。
      // RETIはこの経路を通さず即座にthis.ime=trueにする(GB固有、Pan Docs "Interrupts"参照)。
      if (this.imePending > 0) {
        this.imePending--;
        if (this.imePending === 0) this.ime = true;
      }
      const opcode = this.fetchByte();
      if (opcode === 0xCB) return this.execCB();
      return this.execMain(opcode);
    }

    execMain(opcode) {
      switch (opcode) {
        case 0x00: return 4; // NOP
        case 0x01: this.setBC(this.fetch16()); return 12;
        case 0x02: this.write(this.getBC(), this.a); return 8;
        case 0x03: this.setBC((this.getBC() + 1) & 0xFFFF); return 8;
        case 0x04: this.b = this.inc8(this.b); return 4;
        case 0x05: this.b = this.dec8(this.b); return 4;
        case 0x06: this.b = this.fetchByte(); return 8;
        case 0x07: this.rlca(); return 4;
        case 0x08: { const nn = this.fetch16(); this.write(nn, this.sp & 0xFF); this.write((nn + 1) & 0xFFFF, (this.sp >> 8) & 0xFF); return 20; }
        case 0x09: this.addHL(this.getBC()); return 8;
        case 0x0A: this.a = this.read(this.getBC()); return 8;
        case 0x0B: this.setBC((this.getBC() - 1) & 0xFFFF); return 8;
        case 0x0C: this.c = this.inc8(this.c); return 4;
        case 0x0D: this.c = this.dec8(this.c); return 4;
        case 0x0E: this.c = this.fetchByte(); return 8;
        case 0x0F: this.rrca(); return 4;

        // STOP 0: SingleStepTests実測では2バイト目を実際には読まず(bus読出し無しの内部
        // サイクルのみ)、PCは1しか進まないが所要時間は3Mサイクル(12T)。
        case 0x10: this.stopped = true; return 12;
        case 0x11: this.setDE(this.fetch16()); return 12;
        case 0x12: this.write(this.getDE(), this.a); return 8;
        case 0x13: this.setDE((this.getDE() + 1) & 0xFFFF); return 8;
        case 0x14: this.d = this.inc8(this.d); return 4;
        case 0x15: this.d = this.dec8(this.d); return 4;
        case 0x16: this.d = this.fetchByte(); return 8;
        case 0x17: this.rla(); return 4;
        case 0x18: { const d = this.fetchSigned(); this.pc = (this.pc + d) & 0xFFFF; return 12; }
        case 0x19: this.addHL(this.getDE()); return 8;
        case 0x1A: this.a = this.read(this.getDE()); return 8;
        case 0x1B: this.setDE((this.getDE() - 1) & 0xFFFF); return 8;
        case 0x1C: this.e = this.inc8(this.e); return 4;
        case 0x1D: this.e = this.dec8(this.e); return 4;
        case 0x1E: this.e = this.fetchByte(); return 8;
        case 0x1F: this.rra(); return 4;

        case 0x20: { const d = this.fetchSigned(); if (!this.getFlag(F_Z)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x21: this.setHL(this.fetch16()); return 12;
        case 0x22: this.write(this.getHL(), this.a); this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x23: this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x24: this.h = this.inc8(this.h); return 4;
        case 0x25: this.h = this.dec8(this.h); return 4;
        case 0x26: this.h = this.fetchByte(); return 8;
        case 0x27: this.daa(); return 4;
        case 0x28: { const d = this.fetchSigned(); if (this.getFlag(F_Z)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x29: this.addHL(this.getHL()); return 8;
        case 0x2A: this.a = this.read(this.getHL()); this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x2B: this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x2C: this.l = this.inc8(this.l); return 4;
        case 0x2D: this.l = this.dec8(this.l); return 4;
        case 0x2E: this.l = this.fetchByte(); return 8;
        case 0x2F: this.a = (~this.a) & 0xFF; this.setFlag(F_N, true); this.setFlag(F_H, true); return 4; // CPL

        case 0x30: { const d = this.fetchSigned(); if (!this.getFlag(F_C)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x31: this.sp = this.fetch16(); return 12;
        case 0x32: this.write(this.getHL(), this.a); this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x33: this.sp = (this.sp + 1) & 0xFFFF; return 8;
        case 0x34: { const hl = this.getHL(); this.write(hl, this.inc8(this.read(hl))); return 12; }
        case 0x35: { const hl = this.getHL(); this.write(hl, this.dec8(this.read(hl))); return 12; }
        case 0x36: this.write(this.getHL(), this.fetchByte()); return 12;
        case 0x37: this.setFlag(F_C, true); this.setFlag(F_N, false); this.setFlag(F_H, false); return 4; // SCF
        case 0x38: { const d = this.fetchSigned(); if (this.getFlag(F_C)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x39: this.addHL(this.sp); return 8;
        case 0x3A: this.a = this.read(this.getHL()); this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; return 8;
        case 0x3C: this.a = this.inc8(this.a); return 4;
        case 0x3D: this.a = this.dec8(this.a); return 4;
        case 0x3E: this.a = this.fetchByte(); return 8;
        case 0x3F: { const c = this.getFlag(F_C); this.setFlag(F_C, !c); this.setFlag(F_N, false); this.setFlag(F_H, false); return 4; } // CCF
      }

      if (opcode >= 0x40 && opcode <= 0x7F) {
        if (opcode === 0x76) { this.halted = true; return 12; } // HALT(SingleStepTests実測で3Mサイクル=12T)
        const y = (opcode >> 3) & 7, z = opcode & 7;
        this.setR8(y, this.getR8(z));
        return (y === 6 || z === 6) ? 8 : 4;
      }

      if (opcode >= 0x80 && opcode <= 0xBF) {
        const y = (opcode >> 3) & 7, z = opcode & 7;
        this.aluOp(y, this.getR8(z));
        return z === 6 ? 8 : 4;
      }

      switch (opcode) {
        case 0xC0: if (!this.getFlag(F_Z)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xC1: this.setBC(this.pop16()); return 12;
        case 0xC2: { const nn = this.fetch16(); if (!this.getFlag(F_Z)) { this.pc = nn; return 16; } return 12; }
        case 0xC3: this.pc = this.fetch16(); return 16;
        case 0xC4: { const nn = this.fetch16(); if (!this.getFlag(F_Z)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xC5: this.push16(this.getBC()); return 16;
        case 0xC6: this.add8(this.fetchByte(), 0); return 8;
        case 0xC7: this.push16(this.pc); this.pc = 0x00; return 16;
        case 0xC8: if (this.getFlag(F_Z)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xC9: this.pc = this.pop16(); return 16;
        case 0xCA: { const nn = this.fetch16(); if (this.getFlag(F_Z)) { this.pc = nn; return 16; } return 12; }
        case 0xCC: { const nn = this.fetch16(); if (this.getFlag(F_Z)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xCD: { const nn = this.fetch16(); this.push16(this.pc); this.pc = nn; return 24; }
        case 0xCE: this.add8(this.fetchByte(), this.getFlag(F_C) ? 1 : 0); return 8;
        case 0xCF: this.push16(this.pc); this.pc = 0x08; return 16;

        case 0xD0: if (!this.getFlag(F_C)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xD1: this.setDE(this.pop16()); return 12;
        case 0xD2: { const nn = this.fetch16(); if (!this.getFlag(F_C)) { this.pc = nn; return 16; } return 12; }
        case 0xD4: { const nn = this.fetch16(); if (!this.getFlag(F_C)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xD5: this.push16(this.getDE()); return 16;
        case 0xD6: this.sub8(this.fetchByte(), 0, true); return 8;
        case 0xD7: this.push16(this.pc); this.pc = 0x10; return 16;
        case 0xD8: if (this.getFlag(F_C)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xD9: this.pc = this.pop16(); this.ime = true; this.imePending = 0; return 16; // RETI(EIと違い即時)
        case 0xDA: { const nn = this.fetch16(); if (this.getFlag(F_C)) { this.pc = nn; return 16; } return 12; }
        case 0xDC: { const nn = this.fetch16(); if (this.getFlag(F_C)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xDE: this.sub8(this.fetchByte(), this.getFlag(F_C) ? 1 : 0, true); return 8;
        case 0xDF: this.push16(this.pc); this.pc = 0x18; return 16;

        case 0xE0: { const n = this.fetchByte(); this.write(0xFF00 + n, this.a); return 12; } // LDH (n),A
        case 0xE1: this.setHL(this.pop16()); return 12;
        case 0xE2: this.write(0xFF00 + this.c, this.a); return 8; // LDH (C),A
        case 0xE5: this.push16(this.getHL()); return 16;
        case 0xE6: this.and8(this.fetchByte()); return 8;
        case 0xE7: this.push16(this.pc); this.pc = 0x20; return 16;
        case 0xE8: this.sp = this.addSpR8(); return 16;
        case 0xE9: this.pc = this.getHL(); return 4; // JP HL(間接読出しではなくPC=HL)
        case 0xEA: { const nn = this.fetch16(); this.write(nn, this.a); return 16; }
        case 0xEE: this.xor8(this.fetchByte()); return 8;
        case 0xEF: this.push16(this.pc); this.pc = 0x28; return 16;

        case 0xF0: { const n = this.fetchByte(); this.a = this.read(0xFF00 + n); return 12; } // LDH A,(n)
        case 0xF1: this.setAF(this.pop16()); return 12;
        case 0xF2: this.a = this.read(0xFF00 + this.c); return 8; // LDH A,(C)
        case 0xF3: this.ime = false; this.imePending = 0; return 4; // DI
        case 0xF5: this.push16(this.getAF()); return 16;
        case 0xF6: this.or8(this.fetchByte()); return 8;
        case 0xF7: this.push16(this.pc); this.pc = 0x30; return 16;
        case 0xF8: this.setHL(this.addSpR8()); return 12;
        case 0xF9: this.sp = this.getHL(); return 8;
        case 0xFA: { const nn = this.fetch16(); this.a = this.read(nn); return 16; }
        case 0xFB: this.imePending = 2; return 4; // EI(1命令分遅延して有効化)
        case 0xFE: this.sub8(this.fetchByte(), 0, false); return 8;
        case 0xFF: this.push16(this.pc); this.pc = 0x38; return 16;
      }
      // 未定義オペコード(D3/DB/DD/E3/E4/EB/EC/ED/F4/FC/FD): 実機はCPU停止(フリーズ)するが、
      // GBSの曲データがこれらを使うことは無い想定のためNOP相当として扱い暴走を防ぐ
      return 4;
    }

    execCB() {
      const opcode = this.fetchByte();
      const x = (opcode >> 6) & 3, y = (opcode >> 3) & 7, z = opcode & 7;
      const hasMem = z === 6;
      const v = this.getR8(z);
      if (x === 1) { // BIT b,r
        const bit = (v >> y) & 1;
        this.setFlag(F_Z, bit === 0);
        this.setFlag(F_N, false);
        this.setFlag(F_H, true);
        return hasMem ? 12 : 8;
      }
      let result;
      if (x === 0) result = this.rotOp(y, v);
      else if (x === 2) result = v & ~(1 << y); // RES
      else result = v | (1 << y); // SET
      this.setR8(z, result);
      return hasMem ? 16 : 8;
    }

    /**
     * addr のサブルーチンを呼び出し、RET で戻るまで実行する(GBSのINIT/PLAY呼び出しに使用)
     * @param {number} addr
     * @param {number} [maxSteps=500000]
     * @returns {number} 実行した命令数
     */
    call(addr, maxSteps = 500000) {
      this.push16(CALL_SENTINEL);
      this.pc = addr & 0xFFFF;
      let steps = 0;
      while (this.pc !== CALL_SENTINEL && steps < maxSteps) {
        if (this.halted) { this.halted = false; break; }
        this.step();
        steps++;
      }
      return steps;
    }

    beginCall(addr) {
      this.push16(CALL_SENTINEL);
      this.pc = addr & 0xFFFF;
      this.callActive = true;
      this.halted = false;
    }

    stepCall() {
      if (this.halted) { this.callActive = false; return 4; }
      const c = this.step();
      if (this.pc === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  Emu.CPUSm83 = CPUSm83;
  Emu.SM83_FLAGS = { C: F_C, H: F_H, N: F_N, Z: F_Z };
})(window);
