/*
 * 6502 CPUコア（NES/NSF用、デコードモード無効）
 * MML.Emu.CPU6502
 *
 * - 全151正規オペコードに対応
 * - bus.read(addr) / bus.write(addr, value) を介してメモリアクセス
 * - call(addr) で「addrをCALLして RTS で戻るまで実行」を行うヘルパーを提供
 *   (NSFのINIT/PLAYルーチン呼び出しに使用)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // フラグビット
  const F_C = 0x01; // Carry
  const F_Z = 0x02; // Zero
  const F_I = 0x04; // IRQ disable
  const F_D = 0x08; // Decimal (NESでは演算に影響しない)
  const F_B = 0x10; // Break
  const F_U = 0x20; // Unused (常に1)
  const F_V = 0x40; // Overflow
  const F_N = 0x80; // Negative

  // CALL終了検知のためのスタックに積む「番兵」リターンアドレス。
  // RTSでこのアドレスに戻ったら呼び出し終了とみなす。
  const CALL_SENTINEL = 0xFFFF;

  class CPU6502 {
    /**
     * @param {{read:(addr:number)=>number, write:(addr:number, value:number)=>void}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.A = 0;
      this.X = 0;
      this.Y = 0;
      this.S = 0xFD;
      this.P = F_U | F_I;
      this.PC = 0;
      this.cycles = 0;
      this.halted = false;
      this.callActive = false;
    }

    // --- メモリアクセス ---
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }
    // PCから1バイト読んでPCを16bitでラップさせながら進める
    fetchByte() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    read16(addr) {
      return this.read(addr) | (this.read(addr + 1) << 8);
    }
    // JMP (ind) のページ境界バグ: 下位バイトが$xxFFの場合、上位バイトは$xx00から読む
    read16Bug(addr) {
      const lo = this.read(addr);
      const hiAddr = (addr & 0xFF00) | ((addr + 1) & 0xFF);
      const hi = this.read(hiAddr);
      return lo | (hi << 8);
    }

    // --- フラグ操作 ---
    getFlag(mask) { return (this.P & mask) !== 0; }
    setFlag(mask, on) { this.P = on ? (this.P | mask) : (this.P & ~mask); }
    setZN(value) {
      value &= 0xFF;
      this.setFlag(F_Z, value === 0);
      this.setFlag(F_N, (value & 0x80) !== 0);
    }

    // --- スタック ---
    push(value) {
      this.write(0x0100 + this.S, value);
      this.S = (this.S - 1) & 0xFF;
    }
    pop() {
      this.S = (this.S + 1) & 0xFF;
      return this.read(0x0100 + this.S);
    }

    // --- オペランド取得 ---
    // 戻り値: { addr: number|null, value: number, pageCrossed: boolean }
    // skipRead=true の場合、書き込み先アドレスのみ算出し値の読み出しをしない。
    // (STA/STX/STY 等のストア命令用。実機のストアは書き込み先を読まないため、
    //  $4800(N163) や $4015 等の読み出し副作用を持つレジスタで空読みが悪影響を与える)
    fetchOperand(mode, skipRead = false) {
      let addr = null, value = 0, pageCrossed = false;
      switch (mode) {
        case 'imm':
          value = this.fetchByte();
          break;
        case 'acc':
          value = this.A;
          break;
        case 'impl':
          break;
        case 'zp':
          addr = this.fetchByte();
          if (!skipRead) value = this.read(addr);
          break;
        case 'zpx':
          addr = (this.fetchByte() + this.X) & 0xFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'zpy':
          addr = (this.fetchByte() + this.Y) & 0xFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'abs':
          addr = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'absx': {
          const base = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.X) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'absy': {
          const base = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.Y) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'indx': {
          const zp = (this.fetchByte() + this.X) & 0xFF;
          addr = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'indy': {
          const zp = this.fetchByte();
          const base = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
          addr = (base + this.Y) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'rel': {
          const off = this.fetchByte();
          addr = off; // 呼び出し側で符号付きオフセットとして解釈
          break;
        }
        default:
          throw new Error(`未知のアドレッシングモード: ${mode}`);
      }
      return { addr, value, pageCrossed };
    }

    writeOperand(mode, addr, value) {
      if (mode === 'acc') this.A = value & 0xFF;
      else this.write(addr, value);
    }

    // --- 命令実行（1命令）---
    // 戻り値: 消費サイクル数
    step() {
      const opcode = this.fetchByte();
      const def = OPS[opcode];
      if (!def) {
        // 未定義オペコードは2サイクルNOP相当として無視する
        return 2;
      }
      const extra = def.exec(this, def.mode);
      return def.cycles + (extra || 0);
    }

    /**
     * addr のサブルーチンを呼び出し、RTS で戻るまで実行する。
     * NSFのINITやPLAYの呼び出しに使用。
     * @param {number} addr
     * @param {number} [maxSteps=200000] - 無限ループ対策の上限命令数
     * @returns {number} 実行した命令数
     */
    call(addr, maxSteps = 200000) {
      // 番兵アドレス-1 をリターンアドレスとしてプッシュ（RTSで+1されてCALL_SENTINELに戻る）
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF);
      this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;

      let steps = 0;
      while (this.PC !== CALL_SENTINEL && steps < maxSteps) {
        this.step();
        steps++;
      }
      return steps;
    }

    // --- 呼び出しをAPUクロックとインターリーブするための逐次実行API ---
    // beginCall で番兵を積んでPCを設定し callActive=true にする。以後 stepCall() を
    // 呼ぶたびに1命令実行し、RTSで番兵に戻ったら callActive=false になる。
    // ($4011直書きPCMのように、PLAY中のレジスタ書き込みをサンプル精度で反映するため)
    beginCall(addr) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF);
      this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      this.callActive = true;
    }

    // callActive中に1命令実行し、消費CPUサイクル数を返す。番兵到達でcallActive=false。
    stepCall() {
      const c = this.step();
      if (this.PC === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  // --- 命令ハンドラ ---

  function ADC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const sum = cpu.A + op.value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (op.value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function SBC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const value = op.value ^ 0xFF;
    const sum = cpu.A + value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function AND(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A & op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function ORA(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A | op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function EOR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A ^ op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function ASL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = (op.value << 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function LSR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = (op.value >> 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function ROL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = ((op.value << 1) | c) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function ROR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = ((op.value >> 1) | (c << 7)) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function INC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value + 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function DEC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value - 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function compare(cpu, reg, value) {
    const result = (reg - value) & 0x1FF;
    cpu.setFlag(F_C, reg >= value);
    cpu.setZN(result & 0xFF);
  }
  function CMP(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.A, op.value); return op.pageCrossed ? 1 : 0; }
  function CPX(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.X, op.value); return 0; }
  function CPY(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.Y, op.value); return 0; }

  function BIT(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_Z, (cpu.A & op.value) === 0);
    cpu.setFlag(F_V, (op.value & 0x40) !== 0);
    cpu.setFlag(F_N, (op.value & 0x80) !== 0);
    return 0;
  }

  function branch(cpu, mode, cond) {
    const op = cpu.fetchOperand(mode);
    if (!cond) return 0;
    const offset = op.addr < 0x80 ? op.addr : op.addr - 0x100;
    const oldPC = cpu.PC;
    cpu.PC = (cpu.PC + offset) & 0xFFFF;
    const pageCrossed = (oldPC & 0xFF00) !== (cpu.PC & 0xFF00);
    return pageCrossed ? 2 : 1;
  }

  function LDA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function LDX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.X = op.value; cpu.setZN(cpu.X); return op.pageCrossed ? 1 : 0; }
  function LDY(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.Y = op.value; cpu.setZN(cpu.Y); return op.pageCrossed ? 1 : 0; }

  function STA(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A); return 0; }
  function STX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.X); return 0; }
  function STY(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.Y); return 0; }

  function JMP(cpu, mode) {
    if (mode === 'abs') {
      cpu.PC = cpu.read16(cpu.PC);
    } else { // ind
      const ptr = cpu.read16(cpu.PC);
      cpu.PC = cpu.read16Bug(ptr);
    }
    return 0;
  }

  function JSR(cpu) {
    const target = cpu.read16(cpu.PC);
    const ret = (cpu.PC + 1) & 0xFFFF; // JSR命令最後のバイトのアドレス
    cpu.push((ret >> 8) & 0xFF);
    cpu.push(ret & 0xFF);
    cpu.PC = target;
    return 0;
  }

  function RTS(cpu) {
    const lo = cpu.pop();
    const hi = cpu.pop();
    cpu.PC = ((hi << 8) | lo) + 1;
    cpu.PC &= 0xFFFF;
    return 0;
  }

  function BRK(cpu) {
    cpu.PC = (cpu.PC + 1) & 0xFFFF;
    cpu.push((cpu.PC >> 8) & 0xFF);
    cpu.push(cpu.PC & 0xFF);
    cpu.push(cpu.P | F_B | F_U);
    cpu.setFlag(F_I, true);
    cpu.PC = cpu.read16(0xFFFE);
    return 0;
  }

  function RTI(cpu) {
    cpu.P = (cpu.pop() | F_U) & ~F_B;
    const lo = cpu.pop();
    const hi = cpu.pop();
    cpu.PC = (hi << 8) | lo;
    return 0;
  }

  function PHA(cpu) { cpu.push(cpu.A); return 0; }
  function PHP(cpu) { cpu.push(cpu.P | F_B | F_U); return 0; }
  function PLA(cpu) { cpu.A = cpu.pop(); cpu.setZN(cpu.A); return 0; }
  function PLP(cpu) { cpu.P = (cpu.pop() | F_U) & ~F_B; return 0; }

  function TAX(cpu) { cpu.X = cpu.A; cpu.setZN(cpu.X); return 0; }
  function TAY(cpu) { cpu.Y = cpu.A; cpu.setZN(cpu.Y); return 0; }
  function TXA(cpu) { cpu.A = cpu.X; cpu.setZN(cpu.A); return 0; }
  function TYA(cpu) { cpu.A = cpu.Y; cpu.setZN(cpu.A); return 0; }
  function TSX(cpu) { cpu.X = cpu.S; cpu.setZN(cpu.X); return 0; }
  function TXS(cpu) { cpu.S = cpu.X; return 0; }

  function INX(cpu) { cpu.X = (cpu.X + 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function INY(cpu) { cpu.Y = (cpu.Y + 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function DEX(cpu) { cpu.X = (cpu.X - 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function DEY(cpu) { cpu.Y = (cpu.Y - 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }

  function SEC(cpu) { cpu.setFlag(F_C, true); return 0; }
  function CLC(cpu) { cpu.setFlag(F_C, false); return 0; }
  function SEI(cpu) { cpu.setFlag(F_I, true); return 0; }
  function CLI(cpu) { cpu.setFlag(F_I, false); return 0; }
  function SED(cpu) { cpu.setFlag(F_D, true); return 0; }
  function CLD(cpu) { cpu.setFlag(F_D, false); return 0; }
  function CLV(cpu) { cpu.setFlag(F_V, false); return 0; }

  function NOP(cpu, mode) {
    if (mode !== 'impl') cpu.fetchOperand(mode); // オペランド読み飛ばし(通常未使用)
    return 0;
  }

  // mnemonic -> {mode: [opcodeByte, cycles]}
  const TABLE = {
    ADC: { fn: ADC, modes: { imm: [0x69, 2], zp: [0x65, 3], zpx: [0x75, 4], abs: [0x6D, 4], absx: [0x7D, 4], absy: [0x79, 4], indx: [0x61, 6], indy: [0x71, 5] } },
    AND: { fn: AND, modes: { imm: [0x29, 2], zp: [0x25, 3], zpx: [0x35, 4], abs: [0x2D, 4], absx: [0x3D, 4], absy: [0x39, 4], indx: [0x21, 6], indy: [0x31, 5] } },
    ASL: { fn: ASL, modes: { acc: [0x0A, 2], zp: [0x06, 5], zpx: [0x16, 6], abs: [0x0E, 6], absx: [0x1E, 7] } },
    BCC: { fn: (c, m) => branch(c, m, !c.getFlag(F_C)), modes: { rel: [0x90, 2] } },
    BCS: { fn: (c, m) => branch(c, m, c.getFlag(F_C)), modes: { rel: [0xB0, 2] } },
    BEQ: { fn: (c, m) => branch(c, m, c.getFlag(F_Z)), modes: { rel: [0xF0, 2] } },
    BMI: { fn: (c, m) => branch(c, m, c.getFlag(F_N)), modes: { rel: [0x30, 2] } },
    BNE: { fn: (c, m) => branch(c, m, !c.getFlag(F_Z)), modes: { rel: [0xD0, 2] } },
    BPL: { fn: (c, m) => branch(c, m, !c.getFlag(F_N)), modes: { rel: [0x10, 2] } },
    BVC: { fn: (c, m) => branch(c, m, !c.getFlag(F_V)), modes: { rel: [0x50, 2] } },
    BVS: { fn: (c, m) => branch(c, m, c.getFlag(F_V)), modes: { rel: [0x70, 2] } },
    BIT: { fn: BIT, modes: { zp: [0x24, 3], abs: [0x2C, 4] } },
    BRK: { fn: BRK, modes: { impl: [0x00, 7] } },
    CLC: { fn: CLC, modes: { impl: [0x18, 2] } },
    CLD: { fn: CLD, modes: { impl: [0xD8, 2] } },
    CLI: { fn: CLI, modes: { impl: [0x58, 2] } },
    CLV: { fn: CLV, modes: { impl: [0xB8, 2] } },
    CMP: { fn: CMP, modes: { imm: [0xC9, 2], zp: [0xC5, 3], zpx: [0xD5, 4], abs: [0xCD, 4], absx: [0xDD, 4], absy: [0xD9, 4], indx: [0xC1, 6], indy: [0xD1, 5] } },
    CPX: { fn: CPX, modes: { imm: [0xE0, 2], zp: [0xE4, 3], abs: [0xEC, 4] } },
    CPY: { fn: CPY, modes: { imm: [0xC0, 2], zp: [0xC4, 3], abs: [0xCC, 4] } },
    DEC: { fn: DEC, modes: { zp: [0xC6, 5], zpx: [0xD6, 6], abs: [0xCE, 6], absx: [0xDE, 7] } },
    DEX: { fn: DEX, modes: { impl: [0xCA, 2] } },
    DEY: { fn: DEY, modes: { impl: [0x88, 2] } },
    EOR: { fn: EOR, modes: { imm: [0x49, 2], zp: [0x45, 3], zpx: [0x55, 4], abs: [0x4D, 4], absx: [0x5D, 4], absy: [0x59, 4], indx: [0x41, 6], indy: [0x51, 5] } },
    INC: { fn: INC, modes: { zp: [0xE6, 5], zpx: [0xF6, 6], abs: [0xEE, 6], absx: [0xFE, 7] } },
    INX: { fn: INX, modes: { impl: [0xE8, 2] } },
    INY: { fn: INY, modes: { impl: [0xC8, 2] } },
    JMP: { fn: JMP, modes: { abs: [0x4C, 3], ind: [0x6C, 5] } },
    JSR: { fn: JSR, modes: { abs: [0x20, 6] } },
    LDA: { fn: LDA, modes: { imm: [0xA9, 2], zp: [0xA5, 3], zpx: [0xB5, 4], abs: [0xAD, 4], absx: [0xBD, 4], absy: [0xB9, 4], indx: [0xA1, 6], indy: [0xB1, 5] } },
    LDX: { fn: LDX, modes: { imm: [0xA2, 2], zp: [0xA6, 3], zpy: [0xB6, 4], abs: [0xAE, 4], absy: [0xBE, 4] } },
    LDY: { fn: LDY, modes: { imm: [0xA0, 2], zp: [0xA4, 3], zpx: [0xB4, 4], abs: [0xAC, 4], absx: [0xBC, 4] } },
    LSR: { fn: LSR, modes: { acc: [0x4A, 2], zp: [0x46, 5], zpx: [0x56, 6], abs: [0x4E, 6], absx: [0x5E, 7] } },
    NOP: { fn: NOP, modes: { impl: [0xEA, 2] } },
    ORA: { fn: ORA, modes: { imm: [0x09, 2], zp: [0x05, 3], zpx: [0x15, 4], abs: [0x0D, 4], absx: [0x1D, 4], absy: [0x19, 4], indx: [0x01, 6], indy: [0x11, 5] } },
    PHA: { fn: PHA, modes: { impl: [0x48, 3] } },
    PHP: { fn: PHP, modes: { impl: [0x08, 3] } },
    PLA: { fn: PLA, modes: { impl: [0x68, 4] } },
    PLP: { fn: PLP, modes: { impl: [0x28, 4] } },
    ROL: { fn: ROL, modes: { acc: [0x2A, 2], zp: [0x26, 5], zpx: [0x36, 6], abs: [0x2E, 6], absx: [0x3E, 7] } },
    ROR: { fn: ROR, modes: { acc: [0x6A, 2], zp: [0x66, 5], zpx: [0x76, 6], abs: [0x6E, 6], absx: [0x7E, 7] } },
    RTI: { fn: RTI, modes: { impl: [0x40, 6] } },
    RTS: { fn: RTS, modes: { impl: [0x60, 6] } },
    SBC: { fn: SBC, modes: { imm: [0xE9, 2], zp: [0xE5, 3], zpx: [0xF5, 4], abs: [0xED, 4], absx: [0xFD, 4], absy: [0xF9, 4], indx: [0xE1, 6], indy: [0xF1, 5] } },
    SEC: { fn: SEC, modes: { impl: [0x38, 2] } },
    SED: { fn: SED, modes: { impl: [0xF8, 2] } },
    SEI: { fn: SEI, modes: { impl: [0x78, 2] } },
    STA: { fn: STA, modes: { zp: [0x85, 3], zpx: [0x95, 4], abs: [0x8D, 4], absx: [0x9D, 5], absy: [0x99, 5], indx: [0x81, 6], indy: [0x91, 6] } },
    STX: { fn: STX, modes: { zp: [0x86, 3], zpy: [0x96, 4], abs: [0x8E, 4] } },
    STY: { fn: STY, modes: { zp: [0x84, 3], zpx: [0x94, 4], abs: [0x8C, 4] } },
    TAX: { fn: TAX, modes: { impl: [0xAA, 2] } },
    TAY: { fn: TAY, modes: { impl: [0xA8, 2] } },
    TSX: { fn: TSX, modes: { impl: [0xBA, 2] } },
    TXA: { fn: TXA, modes: { impl: [0x8A, 2] } },
    TXS: { fn: TXS, modes: { impl: [0x9A, 2] } },
    TYA: { fn: TYA, modes: { impl: [0x98, 2] } }
  };

  // 256エントリのオペコードディスパッチテーブルを構築
  const OPS = new Array(256).fill(null);
  for (const mnemonic in TABLE) {
    const { fn, modes } = TABLE[mnemonic];
    for (const mode in modes) {
      const [byte, cycles] = modes[mode];
      OPS[byte] = { mnemonic, mode, exec: fn, cycles };
    }
  }

  Emu.CPU6502 = CPU6502;
  Emu.FLAGS = { C: F_C, Z: F_Z, I: F_I, D: F_D, B: F_B, U: F_U, V: F_V, N: F_N };
  Emu.OPS = OPS; // デバッグ/逆アセンブル用に公開
})(window);
