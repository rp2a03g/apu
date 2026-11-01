/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-11-01 12:28:12
 *
 * regsOnly capture worker bundle (nesWorklet). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.nesWorklet is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.nesWorkletBuiltAt = '2026-11-01 12:28:12';
  MML.WorkerBundles.nesWorklet = function () {
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

    // --- 割り込み(NES 本体 src/emulator/nes/nesConsole.js 用。NSF 再生は使わない) ---
    // 現在の PC と P(B クリア・U セット)を積み、I を立ててベクタへ飛ぶ。戻り値は消費サイクル(7)
    interrupt(vector) {
      this.push((this.PC >> 8) & 0xFF);
      this.push(this.PC & 0xFF);
      this.push((this.P | F_U) & ~F_B);
      this.setFlag(F_I, true);
      this.PC = this.read16(vector);
      return 7;
    }
    // 次に実行する命令の基本サイクル数(ページ跨ぎ等の追加分を含まない)。NES 本体が「最後の 1 サイクルで
    // メモリアクセスが起きる」近似のため、命令の実行前に周辺を進める量を決めるのに使う。未定義命令は 2
    peekCycles() { const def = OPS[this.bus.read(this.PC) & 0xFF]; return def ? def.cycles : 2; }
    nmi() { return this.interrupt(0xFFFA); }
    irq() { return this.interrupt(0xFFFE); }
    irqInhibited() { return (this.P & F_I) !== 0; }

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
})(globalThis);

/*
 * RP2A03 内蔵音源（APU）エミュレータ
 * MML.Emu.APU2A03
 *
 * パルス波x2, 三角波, ノイズ, DPCM(DMC) の5チャンネルを実装。
 * clock() を1 CPUサイクルごとに呼び出し、mixSample() で現在の合成出力(0.0〜1.0)を取得する。
 * レジスタ $4000-$4017 への書き込みは writeRegister() で受け付ける。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];

  const TRIANGLE_SEQ = [
    15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  ];

  // NTSC ノイズ周期テーブル（NESdev準拠。値=シフトレジスタ更新間のCPUサイクル数）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // NTSC DMC レート(タイマ周期)テーブル
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  class Envelope {
    constructor() {
      this.startFlag = false;
      this.divider = 0;
      this.decay = 0;
      this.loop = false;
      this.constant = false;
      this.volume = 0; // constant時の音量 or envelope period
    }
    clockQuarterFrame() {
      if (this.startFlag) {
        this.startFlag = false;
        this.decay = 15;
        this.divider = this.volume;
      } else if (this.divider > 0) {
        this.divider--;
      } else {
        this.divider = this.volume;
        if (this.decay > 0) this.decay--;
        else if (this.loop) this.decay = 15;
      }
    }
    output() {
      return this.constant ? this.volume : this.decay;
    }
  }

  class PulseChannel {
    constructor(channelNum) {
      this.channelNum = channelNum; // 1 or 2 (スイープの符号反転に使用)
      this.enabled = false;
      this.duty = 0;
      this.dutyStep = 0;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.timerPeriod = 0;
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ
      this.sweepEnabled = false;
      this.sweepPeriod = 0;
      this.sweepDivider = 0;
      this.sweepNegate = false;
      this.sweepShift = 0;
      this.sweepReload = false;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4000/$4004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.envelope.loop = this.lengthCounterHalt;
          this.envelope.constant = (value & 0x10) !== 0;
          this.envelope.volume = value & 0x0F;
          break;
        case 1: // $4001/$4005
          this.sweepEnabled = (value & 0x80) !== 0;
          this.sweepPeriod = (value >> 4) & 0x07;
          this.sweepNegate = (value & 0x08) !== 0;
          this.sweepShift = value & 0x07;
          this.sweepReload = true;
          break;
        case 2: // $4002/$4006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $4003/$4007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envelope.startFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      this.envelope.clockQuarterFrame();
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;

      if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0) {
        const target = this.sweepTarget();
        if (target <= 0x7FF) this.timerPeriod = target;
      }
      if (this.sweepDivider === 0 || this.sweepReload) {
        this.sweepDivider = this.sweepPeriod;
        this.sweepReload = false;
      } else {
        this.sweepDivider--;
      }
    }

    sweepTarget() {
      const change = this.timerPeriod >> this.sweepShift;
      if (this.sweepNegate) {
        // パルス1は1の補数(さらに-1)、パルス2は2の補数
        return this.timerPeriod - change - (this.channelNum === 1 ? 1 : 0);
      }
      return this.timerPeriod + change;
    }

    isMuted() {
      return this.timerPeriod < 8 || this.sweepTarget() > 0x7FF;
    }

    output() {
      if (!this.enabled || this.lengthCounter === 0 || this.isMuted()) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.envelope.output();
    }
  }

  class TriangleChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.linearCounterReload = 0;
      this.linearCounter = 0;
      this.linearReloadFlag = false;
      this.timerPeriod = 0;
      this.timer = 0;
      // 初期位相は出力0の位置(TRIANGLE_SEQ[16]=0)に置く。消音時も最後の値を保持する仕様上、
      // seqStep=0(=最大値15)で始めると再生開始時に 0→15 のDC段差が生じプチノイズになるため。
      // 16 から進むと 0,1,2… と滑らかに立ち上がる。
      this.seqStep = 16;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4008
          this.lengthCounterHalt = (value & 0x80) !== 0;
          this.linearCounterReload = value & 0x7F;
          break;
        case 2: // $400A
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $400B
          // 実機の三角波はレジスタ書き込みでシーケンサ位相をリセットしない。
          // 位相を保持したまま発音を再開することで、音符の頭でのプチノイズ(位相跳躍)を防ぐ。
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.linearReloadFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        // 消音中(linear/length=0)や超音波域(period<2)はシーケンサを停止し、
        // 最後の位相＝最後の出力値をそのまま保持する（実機と同じ挙動）。
        if (this.linearCounter > 0 && this.lengthCounter > 0 && this.timerPeriod >= 2) {
          this.seqStep = (this.seqStep + 1) & 31;
        }
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      if (this.linearReloadFlag) this.linearCounter = this.linearCounterReload;
      else if (this.linearCounter > 0) this.linearCounter--;
      if (!this.lengthCounterHalt) this.linearReloadFlag = false;
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }

    output() {
      // 消音時も最後のシーケンサ値(DC)を保持する。0へ落とすと音符境界で段差が生じ、
      // プチノイズになる。保持したDC成分は出力段のDCブロッカー(Emu.dcBlock)が除去する。
      return TRIANGLE_SEQ[this.seqStep];
    }
  }

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.envelope = new Envelope();
      this.modeFlag = false;
      this.timerPeriod = (NOISE_PERIOD[0] >> 1) - 1;
      this.timer = 0;
      this.shiftReg = 1;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $400C
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.envelope.loop = this.lengthCounterHalt;
          this.envelope.constant = (value & 0x10) !== 0;
          this.envelope.volume = value & 0x0F;
          break;
        case 2: // $400E
          this.modeFlag = (value & 0x80) !== 0;
          // テーブル値はCPUサイクル周期。ノイズタイマはAPUサイクル(2 CPU)ごとに進むので÷2し、
          // カウンタは0到達で発火(reload+1周期)するため -1 する → 実効LFSR周期 = テーブル値CPUサイクル。
          this.timerPeriod = (NOISE_PERIOD[value & 0x0F] >> 1) - 1;
          break;
        case 3: // $400F
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.envelope.startFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        const bit0 = this.shiftReg & 1;
        const other = this.modeFlag ? ((this.shiftReg >> 6) & 1) : ((this.shiftReg >> 1) & 1);
        const feedback = bit0 ^ other;
        this.shiftReg = (this.shiftReg >> 1) | (feedback << 14);
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      this.envelope.clockQuarterFrame();
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }

    output() {
      if (!this.enabled || this.lengthCounter === 0 || (this.shiftReg & 1) === 1) return 0;
      return this.envelope.output();
    }
  }

  class DmcChannel {
    constructor(bus) {
      this.bus = bus;
      this.enabled = false;
      this.irqEnable = false;
      this.loop = false;
      this.rate = DMC_RATE[0];
      this.timer = 0;
      this.outputLevel = 0;
      this.sampleAddr = 0xC000;
      this.sampleLength = 0;
      this.currentAddr = 0xC000;
      this.bytesRemaining = 0;
      this.sampleBuffer = null;
      this.bitsRemaining = 0;
      this.shiftReg = 0;
      this.silence = true;
      this.irqFlag = false;
      // ── DAC振幅(体感音量)の計測 ──────────────────────────────
      // $4011/outputLevel は「波形の現在位置」であって音量ではない(実測: SMB3のスネアは
      // 減衰しても現在値の中央値は46のまま動かない)。1フレーム分のDAC値の振幅(peak-to-peak)を
      // 取ると体感音量そのものになる(ミックス全体の実振幅との相関 r=0.91、$4011直書きスピーチで
      // r=0.99)。DPCMサンプル再生と$4011直書きのどちらも同じ扱いで測れる。
      this.ampMin = 127; this.ampMax = 0; this.ampCount = 0;
      this.ampLast = 0; // 直近の計測窓の値(窓が空のまま読まれても直前値を保つ)
      // キーオン通番: $4015 bit4 でサンプル再生が始まるたびに +1。ロールのドラム区画が
      // 「同じサンプルの連打」を1本に融合させない区切りに使う(VGMのサンプルPCMの seq と同じ役割)
      this.seq = 0;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4010
          this.irqEnable = (value & 0x80) !== 0;
          this.loop = (value & 0x40) !== 0;
          this.rate = DMC_RATE[value & 0x0F];
          if (!this.irqEnable) this.irqFlag = false;
          break;
        case 1: // $4011
          this.outputLevel = value & 0x7F;
          // 直書きPCM(スピーチ)もDACが動く。振幅計測に含める
          if (this.outputLevel < this.ampMin) this.ampMin = this.outputLevel;
          if (this.outputLevel > this.ampMax) this.ampMax = this.outputLevel;
          this.ampCount++;
          break;
        case 2: // $4012
          this.sampleAddr = 0xC000 + (value * 64);
          break;
        case 3: // $4013
          this.sampleLength = (value * 16) + 1;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) {
        this.bytesRemaining = 0;
      } else if (this.bytesRemaining === 0) {
        this.currentAddr = this.sampleAddr;
        this.bytesRemaining = this.sampleLength;
        this.seq++;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.rate;
        this.clockOutput();
      } else {
        this.timer--;
      }
    }

    clockOutput() {
      if (this.bitsRemaining === 0) {
        this.bitsRemaining = 8;
        if (this.bytesRemaining > 0 && this.bus) {
          this.shiftReg = this.bus.read(this.currentAddr);
          this.silence = false;
          this.currentAddr = (this.currentAddr + 1) & 0xFFFF;
          if (this.currentAddr > 0xFFFF || this.currentAddr === 0x0000) this.currentAddr = 0x8000;
          this.bytesRemaining--;
          if (this.bytesRemaining === 0) {
            if (this.loop) {
              this.currentAddr = this.sampleAddr;
              this.bytesRemaining = this.sampleLength;
            } else if (this.irqEnable) {
              this.irqFlag = true;
            }
          }
        } else {
          this.silence = true;
        }
      }
      if (!this.silence) {
        if (this.shiftReg & 1) {
          if (this.outputLevel <= 125) this.outputLevel += 2;
        } else {
          if (this.outputLevel >= 2) this.outputLevel -= 2;
        }
        this.shiftReg >>= 1;
      }
      // 体感音量(DAC振幅)の計測。毎CPUサイクルではなくDACが動きうるここだけで拾う
      // (毎サイクル版はキャプチャが実測+10%重くなった)。無音中もここは回るので
      // 「動いていない=振幅0=無音」も正しく出る。
      if (this.outputLevel < this.ampMin) this.ampMin = this.outputLevel;
      if (this.outputLevel > this.ampMax) this.ampMax = this.outputLevel;
      this.ampCount++;
      this.bitsRemaining--;
    }

    /**
     * 前回の呼び出しからのDAC振幅(peak-to-peak, 0〜127)を返して計測窓をリセットする。
     * これがDPCMの体感音量。窓が空(前回から1サイクルも進んでいない)なら直前の値を返す。
     */
    takeAmplitude() {
      if (this.ampCount > 0) {
        this.ampLast = this.ampMax >= this.ampMin ? this.ampMax - this.ampMin : 0;
        this.ampMin = 127; this.ampMax = 0; this.ampCount = 0;
      }
      return this.ampLast;
    }

    output() {
      return this.outputLevel;
    }
  }

  class APU2A03 {
    /**
     * @param {{read:(addr:number)=>number}} [bus] - DMCのサンプルデータ読み出しに使用
     */
    constructor(bus) {
      this.pulse1 = new PulseChannel(1);
      this.pulse2 = new PulseChannel(2);
      this.triangle = new TriangleChannel();
      this.noise = new NoiseChannel();
      this.dmc = new DmcChannel(bus || null);
      // ★writeRegister の default($5FF8-$5FFF → bus.write、DPCMのページ切替)が this.bus を見る。
      //   以前は DmcChannel にしか渡しておらず this.bus が undefined のままで、ブラウザ再生では
      //   ページ切替が黙って捨てられていた(2ページ目以降の @DPCM が同じアドレスのページ0の音で鳴る。
      //   2026-09-22 修正)。NsfBus は $4000-$4017 しか APU へ回さないので再帰はしない
      this.bus = bus || null;

      this.frameCounter = 0;
      this.frameMode5Step = false;
      this.frameIrqInhibit = false;
      this.frameIrqFlag = false;
      this.cycleParity = 0; // 0/1 交互（パルス・ノイズ・DMCはAPUサイクル=CPU2サイクルごと）

      // チャンネルごとのミュート設定（再生ON/OFF）
      this.mute = { pulse1: false, pulse2: false, triangle: false, noise: false, dmc: false };
      // チャンネルごとの音量(0〜1、既定1=無調整)。鍵盤表示のch別音量バー用(src/ui/keyboard.js)
      this.vol = { pulse1: 1, pulse2: 1, triangle: 1, noise: 1, dmc: 1 };
    }

    reset() {
      this.pulse1.setEnabled(false);
      this.pulse2.setEnabled(false);
      this.triangle.setEnabled(false);
      this.triangle.seqStep = 16; // 曲開始時は三角波を出力0の位相にして開始時DC段差を防ぐ
      this.noise.setEnabled(false);
      this.dmc.setEnabled(false);
      this.frameCounter = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x4000: case 0x4001: case 0x4002: case 0x4003:
          this.pulse1.writeReg(addr - 0x4000, value); break;
        case 0x4004: case 0x4005: case 0x4006: case 0x4007:
          this.pulse2.writeReg(addr - 0x4004, value); break;
        case 0x4008: case 0x4009: case 0x400A: case 0x400B:
          this.triangle.writeReg(addr - 0x4008, value); break;
        case 0x400C: case 0x400D: case 0x400E: case 0x400F:
          this.noise.writeReg(addr - 0x400C, value); break;
        case 0x4010: case 0x4011: case 0x4012: case 0x4013:
          this.dmc.writeReg(addr - 0x4010, value); break;
        case 0x4015:
          this.pulse1.setEnabled((value & 0x01) !== 0);
          this.pulse2.setEnabled((value & 0x02) !== 0);
          this.triangle.setEnabled((value & 0x04) !== 0);
          this.noise.setEnabled((value & 0x08) !== 0);
          this.dmc.setEnabled((value & 0x10) !== 0);
          if ((value & 0x10) === 0) this.dmc.irqFlag = false;
          break;
        case 0x4017:
          this.frameMode5Step = (value & 0x80) !== 0;
          this.frameIrqInhibit = (value & 0x40) !== 0;
          if (this.frameIrqInhibit) this.frameIrqFlag = false;
          this.frameCounter = 0;
          if (this.frameMode5Step) { this.clockQuarterFrame(); this.clockHalfFrame(); }
          break;
        default:
          // NSF方式のバンク切替($5FF8-$5FFF)はAPUのレジスタではないが、MMLのブラウザ再生では
          // DMCの読出し元(player.js/stream-player.js buildDpcmBus)のページ切替として使う(2026-09-10)
          if (addr >= 0x5FF8 && addr <= 0x5FFF && this.bus && this.bus.write) this.bus.write(addr, value);
          break;
      }
    }

    readStatus() {
      let v = 0;
      if (this.pulse1.lengthCounter > 0) v |= 0x01;
      if (this.pulse2.lengthCounter > 0) v |= 0x02;
      if (this.triangle.lengthCounter > 0) v |= 0x04;
      if (this.noise.lengthCounter > 0) v |= 0x08;
      if (this.dmc.bytesRemaining > 0) v |= 0x10;
      if (this.frameIrqFlag) v |= 0x40;
      if (this.dmc.irqFlag) v |= 0x80;
      this.frameIrqFlag = false;
      return v;
    }

    clockQuarterFrame() {
      this.pulse1.clockQuarterFrame();
      this.pulse2.clockQuarterFrame();
      this.triangle.clockQuarterFrame();
      this.noise.clockQuarterFrame();
    }

    clockHalfFrame() {
      this.pulse1.clockHalfFrame();
      this.pulse2.clockHalfFrame();
      this.triangle.clockHalfFrame();
      this.noise.clockHalfFrame();
    }

    // 1 CPUサイクル分進める
    clock() {
      // 三角波とDMCは毎CPUサイクル、パルス・ノイズはAPUサイクル(2 CPUサイクル)ごと。
      // DMC_RATE表はCPUサイクル単位の周期なので、DMCタイマもCPUクロックで進める
      // （APUサイクルで進めると周期が2倍=再生速度・音程が半分になる）。
      this.triangle.clockTimer();
      this.dmc.clockTimer();
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clockTimer();
        this.pulse2.clockTimer();
        this.noise.clockTimer();
      }

      this.frameCounter++;
      if (!this.frameMode5Step) {
        switch (this.frameCounter) {
          case 7457: this.clockQuarterFrame(); break;
          case 14913: this.clockQuarterFrame(); this.clockHalfFrame(); break;
          case 22371: this.clockQuarterFrame(); break;
          case 29829:
            this.clockQuarterFrame();
            this.clockHalfFrame();
            if (!this.frameIrqInhibit) this.frameIrqFlag = true;
            this.frameCounter = 0;
            break;
        }
      } else {
        switch (this.frameCounter) {
          case 7457: this.clockQuarterFrame(); break;
          case 14913: this.clockQuarterFrame(); this.clockHalfFrame(); break;
          case 22371: this.clockQuarterFrame(); break;
          case 37281:
            this.clockQuarterFrame();
            this.clockHalfFrame();
            this.frameCounter = 0;
            break;
        }
      }
    }

    /**
     * 現在の出力レベルを 0.0〜1.0 で取得する（NESの非線形ミキサー近似）
     */
    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : this.pulse1.output() * this.vol.pulse1;
      const p2 = this.mute.pulse2 ? 0 : this.pulse2.output() * this.vol.pulse2;
      const tri = this.mute.triangle ? 0 : this.triangle.output() * this.vol.triangle;
      const noi = this.mute.noise ? 0 : this.noise.output() * this.vol.noise;
      const dmc = this.mute.dmc ? 0 : this.dmc.output() * this.vol.dmc;

      let pulseOut = 0;
      if (p1 + p2 > 0) pulseOut = 95.88 / (8128 / (p1 + p2) + 100);

      let tndOut = 0;
      const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
      if (tndSum > 0) tndOut = 159.79 / (1 / tndSum + 100);

      return pulseOut + tndOut; // おおよそ 0.0 〜 1.16
    }
  }

  Emu.APU2A03 = APU2A03;
  Emu.LENGTH_TABLE = LENGTH_TABLE;
})(globalThis);

/*
 * N163 (Namco 163) 拡張音源エミュレータ
 * MML.Emu.N163Audio
 *
 * 128バイト内部RAMにチャンネルレジスタ($40-$7F)と波形データを保持する
 * ウェーブテーブル音源(最大8チャンネル)。
 *
 *   $F800 : 内部RAMアドレス設定 (bit7=1で$4800書き込み毎にオートインクリメント)
 *   $4800 : 現在のアドレスへデータ書き込み
 *
 * チャンネル ch(0-7) のレジスタは RAM (0x40 + ch*8) の8バイト (インターリーブ配置):
 *   +0 周波数 Low   +2 周波数 Mid   +4 周波数 High(bit0-1) | 波形長(bit2-7)
 *   +1 位相 Low     +3 位相 Mid     +5 位相 High   (24bit位相アキュムレータ, RAMに格納)
 *   +6 波形アドレス(4bitサンプル単位)
 *   +7 音量(bit0-3) | 有効ch数(bit4-6, $7Fのみ)
 * 周波数=18bit, 波形長 length = 256 - (+4 & 0xFC) サンプル(4-256)。
 * 波形は4bitサンプルを1バイトに2つ(リトルエンディアン)格納。
 * 有効チャンネルは上位 (($7F>>4)&7)+1 個で、15 CPUサイクルごとに1chずつ巡回更新される。
 * 出力周波数 f = CPU * freq / (15 * 65536 * length * numChannels)。
 *
 * 注: 実機は freq/phase をインターリーブ配置。ドライバは freq を +0/+2/+4 に書き、
 *     間の位相バイト +1/+3/+5 を LDA $4800 で「読み飛ばし」て保存する(読み出しも
 *     オートインクリメントするのを利用)。Rolling Thunder のCPUトレースで確定。
 *
 * 注2: 波形長は NESdev Wiki 準拠で bit2-7 の6bit(4-256サンプル, length=256-(+4&0xFC))。
 *     これが標準の N163 挙動(NSFPlay/Mesen/VirtuaNSF既定と同じ)。ただし「古いドライバ」で
 *     作られた一部NSF(例: Famicompo mini vol.3 entry023)は波形長を最大32サンプル前提で
 *     使っており、256版だと音程・波形テーブルが崩れる。VirtuaNSFはこれ用に「N163を32サンプル
 *     に制限するモード」を別途用意している(readme 1.0.7.1)。
 *     → legacyWaveLen=true で対応(2026-09-07)。旧ドライバは +4 に (n<<2)|$80 を書く
 *     (VirtuaNES 0.97 の APU_N106: tonelen = 0x20-(data&0x1C))。VirtuaNESの周波数式は
 *     実機式と同じ f = CPU*freq/(15*65536*length*numCh) なので、違いは波形長の解釈だけ。
 *     そこで「+4 への書き込み値を現行エンコードへ書き換えて RAM に置く」方式にした:
 *       (v & 0x1F) | 0xE0   … 256-(0xE0|(n<<2)) = 32-4n = 0x20-(v&0x1C) と同じ長さ
 *     RAM 自体が現行仕様の値になるため、音声合成・鍵盤/ロール(snapshotN163)・
 *     nsf2mml の波形抽出・n163Snapshots 経由の再生(NsfReplayStreamPlayer)が全て
 *     無変更で正しくなる。判定は MML.NSF.detectLegacyN163Driver(nsfBus.js から設定)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CHANNELS = 8;
  const UPDATE_CYCLES = 15; // 1チャンネル更新に要するCPUサイクル

  class N163Audio {
    constructor() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0; // 15CPUサイクルごとに1ch更新
      this.rrIndex = 0;       // 有効ch内の巡回位置
      this.mute = new Array(NUM_CHANNELS).fill(false);
      this.vol = new Array(NUM_CHANNELS).fill(1);
      // 旧ppmckドライバ(波形長32サンプル形式)互換。true のとき +4 レジスタへの書き込みを
      // 現行エンコードへ変換して格納する(ファイル冒頭コメント 注2 参照)。
      this.legacyWaveLen = false;
    }

    reset() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0;
      this.rrIndex = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xF800) {
        this.addr = value & 0x7F;
        this.autoInc = (value & 0x80) !== 0;
      } else if (addr === 0x4800) {
        // 旧ドライバ互換: チャンネルレジスタ +4(波形長|周波数上位)への書き込みは
        // bit2-4 の3bit波形長(0x20-(v&0x1C))を現行の6bit形式(0xE0|(v&0x1C))へ変換する。
        // 周波数上位2bit(bit0-1)はそのまま。
        if (this.legacyWaveLen && this.addr >= 0x40 && (this.addr & 7) === 4) {
          value = (value & 0x1F) | 0xE0;
        }
        this.ram[this.addr] = value;
        if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      }
    }

    // $4800 読み出し: 現在のアドレスの内部RAMを返し、オートインクリメント時はアドレスも進める。
    // (書き込みとアドレス/オートインクリメントを共有。実機同様、読み出しでもインクリメント。
    //  ※ ストア命令の空読みはCPU側で抑止済み。ここに来るのは真の LDA $4800 のみ)
    readData() {
      const v = this.ram[this.addr];
      if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      return v;
    }

    numChannels() {
      return ((this.ram[0x7F] >> 4) & 0x07) + 1;
    }

    // ch(0-7, 7=$78が最上位)を1回更新: 位相を進めてRAM(+1/+3/+5)へ書き戻す
    _updateChannel(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const freq = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC); // 4-256 サンプル
      let phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      phase = (phase + freq) % (length * 0x10000);
      ram[base + 1] = phase & 0xFF;
      ram[base + 3] = (phase >> 8) & 0xFF;
      ram[base + 5] = (phase >> 16) & 0xFF;
    }

    // ch の現在の出力サンプル(0-15)。位相上位8bitで波形を索引。
    _sample(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const length = 256 - (ram[base + 4] & 0xFC);
      const phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      const sampleIndex = (phase >> 16) % length;
      const nibbleAddr = (ram[base + 6] + sampleIndex) & 0xFF; // 波形アドレスは4bitサンプル単位
      const byte = ram[(nibbleAddr >> 1) & 0x7F];
      return (nibbleAddr & 1) ? ((byte >> 4) & 0x0F) : (byte & 0x0F);
    }

    clock() {
      // 実機は15 CPUサイクルで1チャンネルを更新・出力し、有効ch(上位num個)を巡回する。
      if (++this.updateCounter < UPDATE_CYCLES) return;
      this.updateCounter = 0;
      const num = this.numChannels();
      this.rrIndex = (this.rrIndex + 1) % num;
      this._updateChannel((NUM_CHANNELS - num) + this.rrIndex);
    }

    mixSample() {
      const num = this.numChannels();
      let sum = 0;
      for (let ch = NUM_CHANNELS - num; ch < NUM_CHANNELS; ch++) {
        if (this.mute[ch]) continue;
        const volume = this.ram[0x40 + ch * 8 + 7] & 0x0F;
        sum += (this._sample(ch) - 8) * volume * this.vol[ch]; // -120..105
      }
      // 時間多重出力の可聴成分は有効ch平均。120で正規化してゲイン。
      // ゲインは他チップとのバランスで調整(0.8→0.3で全体を半分以下に下げた)。
      return (sum / num / 120) * 0.5;
    }
  }

  // 鍵盤表示用: 128バイトRAMから各チャンネルの freq/vol/波形 スナップショットを作る。
  // 表示スロット i(0..7) → ハードウェアch (7-i)。有効なのは上位 numCh 個($78が常にN1)。
  // 事前キャプチャ(writeLogから復元したRAM)・リアルタイム(ライブチップのRAM)双方から使う。
  Emu.snapshotN163 = function (ram) {
    const CPU = 1789773;
    const sampleAt = (a) => (ram[(a >> 1) & 0x7F] >> ((a & 1) * 4)) & 0x0F;
    const numCh = ((ram[0x7F] >> 4) & 7) + 1;
    const channels = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = 7 - i;
      const base = 0x40 + ch * 8;
      const f18 = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC);
      const rawVol = ram[base + 7] & 0x0F;
      const vol = rawVol / 15;
      const freq = f18 > 0 ? f18 * CPU / (15 * 65536 * length * numCh) : 0;
      const waveData = new Array(length);
      for (let k = 0; k < length; k++) waveData[k] = (sampleAt((ram[base + 6] + k) & 0xFF) - 8) / 8;
      channels.push({ freq, vol, rawVol, active: (i < numCh) && vol > 0 && freq > 0, waveData });
    }
    return { channels, numCh };
  };

  Emu.N163Audio = N163Audio;
})(globalThis);

/*
 * iNES / NES 2.0 ヘッダ (MML.Emu.INES) — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7)の入口
 *
 * 読むのは「遊べる」のに要る項目だけ: PRG/CHR の大きさ、マッパー番号(NES 2.0 なら 12bit)、
 * サブマッパー、ミラーリング、バッテリ、4 画面、トレーナー。PRG RAM の大きさは NES 2.0 の
 * 指数表記を読み、iNES では 8K 固定にする(どの基板でも 8K あれば困らない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INES = {};

  INES.parse = function (bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 16 || bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) {
      throw new Error('iNES ヘッダではありません');
    }
    const nes2 = (bytes[7] & 0x0C) === 0x08;
    let prgUnits = bytes[4], chrUnits = bytes[5];
    let mapper = (bytes[6] >> 4) | (bytes[7] & 0xF0);
    let submapper = 0;
    let prgRamSize = 0x2000, chrRamSize = 0;
    if (nes2) {
      mapper |= (bytes[8] & 0x0F) << 8;
      submapper = bytes[8] >> 4;
      prgUnits |= (bytes[9] & 0x0F) << 8;
      chrUnits |= (bytes[9] & 0xF0) << 4;
      const prgRamShift = bytes[10] & 0x0F, prgNvShift = bytes[10] >> 4;
      prgRamSize = Math.max(prgRamShift ? 64 << prgRamShift : 0, prgNvShift ? 64 << prgNvShift : 0) || 0x2000;
      const chrRamShift = bytes[11] & 0x0F, chrNvShift = bytes[11] >> 4;
      chrRamSize = Math.max(chrRamShift ? 64 << chrRamShift : 0, chrNvShift ? 64 << chrNvShift : 0);
    } else if ((bytes[7] & 0x0C) === 0x04 || bytes.slice(12, 16).some(b => b !== 0)) {
      // 古いダンプの「ゴミ入り」ヘッダ: 上位マッパービットを信用しない
      mapper &= 0x0F;
    }
    const trainer = (bytes[6] & 0x04) !== 0;
    let p = 16 + (trainer ? 512 : 0);
    const prgSize = prgUnits * 0x4000, chrSize = chrUnits * 0x2000;
    if (p + prgSize > bytes.length) throw new Error('PRG ROM がファイルより大きい(壊れたファイル)');
    const prg = bytes.slice(p, p + prgSize); p += prgSize;
    const chr = chrSize ? bytes.slice(p, Math.min(bytes.length, p + chrSize)) : null;
    if (!chr && !chrRamSize) chrRamSize = 0x2000;
    return {
      nes2, mapper, submapper,
      prg, chr, chrRamSize,
      prgRamSize,
      mirroring: (bytes[6] & 0x08) ? '4' : ((bytes[6] & 0x01) ? 'V' : 'H'),
      fourScreen: (bytes[6] & 0x08) !== 0,
      battery: (bytes[6] & 0x02) !== 0,
      trainer,
    };
  };

  INES.describe = function (rom) {
    return `mapper ${rom.mapper}${rom.submapper ? '.' + rom.submapper : ''}, PRG ${rom.prg.length >> 10}K, CHR ${rom.chr ? (rom.chr.length >> 10) + 'K' : 'RAM ' + (rom.chrRamSize >> 10) + 'K'}, ` +
      `mirror ${rom.mirroring}${rom.battery ? ', battery' : ''}${rom.nes2 ? ', NES2.0' : ''}`;
  };

  Emu.INES = INES;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * NES マッパー (MML.Emu.NesMappers) — 自前 NES エミュレータのバンク機構
 *
 * 対応: 0 NROM / 1 MMC1 / 2 UxROM / 3 CNROM / 4 MMC3 / 7 AxROM / 19 Namco 163 / 206 Namco 108(DxROM)。
 * 拡張音源つきのうち 19 は NSF 用の音源(Emu.N163Audio)をそのまま挿す。他(VRC6/VRC7/MMC5/5B)は 6c。
 *
 * 作り: PRG は 8K×4 スロット、CHR は 1K×8 スロットの対応表(prgMap/chrMap)で、マッパーはレジスタ書き込みで
 * 表を書き換えるだけ。ネームテーブルも CIRAM(2K、4 画面なら 4K)の 1K ページ表(ntMap)で、ミラーリングは
 * 表の張り替え。N163 のように CHR ROM をネームテーブルに出せる基板は ppuRead/ppuWrite を上書きする。
 *
 * PPU との約束:
 *   ppuRead(addr)/ppuWrite(addr, v): $0000-$2FFF(パレットは PPU 側)。
 *   ppuA12(addr, time): PPU がパターン表を読むたびに呼ぶ(time = フレーム内で単調なドット番号)。
 *     MMC3 の IRQ カウンタは A12 の立ち上がりで進む。連続する読みは 2 ドット間隔なので、
 *     「A12 が最後に高かった時刻から 10 ドット以上たって再び高くなったら 1 回」と数える
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
      if (addr >= 0x6000) return this.prgRam[(addr - 0x6000) % this.prgRam.length];
      return -1;
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) this.writeReg(addr, v);
      else if (addr >= 0x6000) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
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
  }

  // 0: NROM
  class NROM extends Mapper {}

  // 1: MMC1(シフトレジスタ 5 回書き)
  class MMC1 extends Mapper {
    constructor(rom) {
      super(rom);
      this.shift = 0x10; this.control = 0x0C; this.chr0 = 0; this.chr1 = 0; this.prgReg = 0;
      this.apply();
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
        case 1: this.chr0 = value; break;
        case 2: this.chr1 = value; break;
        case 3: this.prgReg = value; break;
      }
      this.apply();
    }
    apply() {
      this.setMirroring(['1A', '1B', 'V', 'H'][this.control & 3]);
      const prgMode = (this.control >> 2) & 3, prg = this.prgReg & 0x0F;
      if (prgMode < 2) this.setPrg32(prg >> 1);
      else if (prgMode === 2) { this.setPrg16(0, 0); this.setPrg16(1, prg); }
      else { this.setPrg16(0, prg); this.setPrg16(1, (this.prgBanks8 >> 1) - 1); }
      if (this.control & 0x10) { this.setChr1(0, this.chr0 * 4); this.setChr1(1, this.chr0 * 4 + 1); this.setChr1(2, this.chr0 * 4 + 2); this.setChr1(3, this.chr0 * 4 + 3);
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
      this.lastA12High = -1000;
      this.regs[6] = 0; this.regs[7] = 1;
      this.apply();
    }
    writeReg(addr, v) {
      switch (addr & 0xE001) {
        case 0x8000: this.bankSelect = v; this.apply(); break;
        case 0x8001: this.regs[this.bankSelect & 7] = v; this.apply(); break;
        case 0xA000: if (!this.rom.fourScreen) this.setMirroring((v & 1) ? 'H' : 'V'); break;
        case 0xA001: break; // PRG RAM 保護(未対応)
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
      if (!(addr & 0x1000)) return;
      if (time - this.lastA12High >= 10) this.clockIrq();
      this.lastA12High = time;
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
    cpuRead(addr) {
      if (addr === 0x4800 && this.audio) return this.audio.readData();
      if (addr === 0x5000) return this.irqCounter & 0xFF;
      if (addr === 0x5800) return ((this.irqCounter >> 8) & 0x7F) | (this.irqEnable ? 0x80 : 0);
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr === 0x4800) { if (this.audio) this.audio.writeRegister(0x4800, v); return; }
      if (addr === 0x5000) { this.irqCounter = (this.irqCounter & 0x7F00) | v; this.irqFlag = false; return; }
      if (addr === 0x5800) { this.irqCounter = (this.irqCounter & 0x00FF) | ((v & 0x7F) << 8); this.irqEnable = (v & 0x80) !== 0; this.irqFlag = false; return; }
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
      if (hi === 0xF800) { if (this.audio) this.audio.writeRegister(0xF800, v); } // 音源アドレス(+PRG RAM 保護ビット、未対応)
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

  const TABLE = { 0: NROM, 1: MMC1, 2: UxROM, 3: CNROM, 4: MMC3, 7: AxROM, 19: Namco163, 206: Namco108 };

  const NesMappers = {
    supported(mapper) { return Object.prototype.hasOwnProperty.call(TABLE, mapper); },
    create(rom) {
      const C = TABLE[rom.mapper];
      if (!C) throw new Error(`マッパー ${rom.mapper} は未対応です(対応: ${Object.keys(TABLE).join(', ')})`);
      return new C(rom);
    },
    Mapper, MMC3,
  };
  Emu.NesMappers = NesMappers;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * 2C02 PPU (MML.Emu.PPU) — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7)
 *
 * ドット単位で動く(1 CPU サイクル = 3 ドット、1 行 341 ドット、262 行)。「遊べる」に要る物を実装する:
 *   背景(loopy の v/t/x/w、2 本の 16bit シフトレジスタ)、スプライト(8×8 / 8×16、優先順位、行 8 枚、
 *   溢れフラグ)、スプライト 0 ヒット、NMI(241 行目 1 ドット目)、奇数フレームのドット飛ばし、
 *   $2007 の読み出しバッファ、パレット RAM のミラー、グレースケール、左 8 ドットのクリップ。
 * パターン表の読み出しはマッパーの ppuA12(addr, time) にも流す(MMC3 の IRQ カウンタ)。
 * 空スロットのスプライト取得も実機どおり行う(スプライトを $1000 に置く曲で A12 が毎行上がるのは
 * これのため。行に 1 枚もスプライトが無くても MMC3 のカウンタは進む)。
 *
 * やらない物: 色強調(ビット 5-7。色は無視)、$2007 のレンダリング中の奇妙な増分、スプライト評価の
 * 溢れバグ(9 枚目以降は正しく数えるだけ)、読み出しの open bus の減衰。
 *
 * 出力: frame(Uint32Array 256×240、canvas の ImageData にそのまま流せる ABGR = リトルエンディアンの RGBA)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 2C02 の標準パレット(nesdev wiki の表)
  const PALETTE_RGB = [
    84,84,84, 0,30,116, 8,16,144, 48,0,136, 68,0,100, 92,0,48, 84,4,0, 60,24,0, 32,42,0, 8,58,0, 0,64,0, 0,60,0, 0,50,60, 0,0,0, 0,0,0, 0,0,0,
    152,150,152, 8,76,196, 48,50,236, 92,30,228, 136,20,176, 160,20,100, 152,34,32, 120,60,0, 84,90,0, 40,114,0, 8,124,0, 0,118,40, 0,102,120, 0,0,0, 0,0,0, 0,0,0,
    236,238,236, 76,154,236, 120,124,236, 176,98,236, 228,84,236, 236,88,180, 236,106,100, 212,136,32, 160,170,0, 116,196,0, 76,208,32, 56,204,108, 56,180,204, 60,60,60, 0,0,0, 0,0,0,
    236,238,236, 168,204,236, 188,188,236, 212,178,236, 236,174,236, 236,174,212, 236,180,176, 228,196,144, 204,210,120, 180,222,120, 168,226,144, 152,226,180, 160,214,228, 160,162,160, 0,0,0, 0,0,0,
  ];
  const PALETTE = new Uint32Array(64);
  for (let i = 0; i < 64; i++) PALETTE[i] = (0xFF << 24 | PALETTE_RGB[i * 3 + 2] << 16 | PALETTE_RGB[i * 3 + 1] << 8 | PALETTE_RGB[i * 3]) >>> 0;

  const DOTS_PER_LINE = 341, LINES = 262;

  class PPU {
    constructor(mapper) {
      this.mapper = mapper;
      this.palette = new Uint8Array(32);
      this.oam = new Uint8Array(256);
      this.frame = new Uint32Array(256 * 240);
      // 次の行のスプライト(評価済み)と、今の行のスプライト(取得済み)
      this.evalY = new Uint8Array(8); this.evalTile = new Uint8Array(8); this.evalAttr = new Uint8Array(8); this.evalX = new Uint8Array(8);
      this.evalCount = 0; this.evalHasZero = false;
      this.sprX = new Uint8Array(8); this.sprAttr = new Uint8Array(8); this.sprLo = new Uint8Array(8); this.sprHi = new Uint8Array(8);
      this.sprCount = 0; this.sprHasZero = false;
      this.reset();
    }

    reset() {
      this.ctrl = 0; this.mask = 0; this.status = 0; this.oamAddr = 0;
      this.v = 0; this.t = 0; this.x = 0; this.w = 0; this.readBuf = 0; this.openBus = 0;
      this.scanline = 261; this.dot = 0; this.odd = false; this.frameCount = 0; this.frameDone = false;
      this.time = 0; // マッパーの A12 フィルタ用の単調なドット時刻
      this.nmiOccurred = false; this.nmiOutput = false;
      this.vblankStarted = false; // 241 行目 1 ドット目で立つ(本体がフレームの区切り=録音/画面送出の時刻に使う)
      this.ntByte = 0; this.atByte = 0; this.ptLo = 0; this.ptHi = 0;
      this.bgLo = 0; this.bgHi = 0; this.atLo = 0; this.atHi = 0;
      this.sprCount = 0; this.evalCount = 0;
      this.frame.fill(PALETTE[0x0F]);
    }

    // ── VRAM(パレット以外はマッパー) ──
    paletteIndex(addr) { addr &= 0x1F; if ((addr & 0x13) === 0x10) addr &= ~0x10; return addr; }
    vramRead(addr) {
      addr &= 0x3FFF;
      if (addr >= 0x3F00) return this.palette[this.paletteIndex(addr)];
      return this.mapper.ppuRead(addr);
    }
    vramWrite(addr, v) {
      addr &= 0x3FFF;
      if (addr >= 0x3F00) this.palette[this.paletteIndex(addr)] = v & 0x3F;
      else this.mapper.ppuWrite(addr, v);
    }
    // レンダリングのパターン表読み(A12 をマッパーへ)
    fetchPattern(addr) {
      this.mapper.ppuA12(addr, this.time);
      return this.mapper.ppuRead(addr & 0x1FFF);
    }

    // ── CPU からのレジスタ ──
    readReg(reg) {
      switch (reg & 7) {
        case 2: {
          const v = (this.status & 0xE0) | (this.openBus & 0x1F);
          this.status &= ~0x80; this.nmiOccurred = false; this.w = 0;
          this.openBus = v;
          return v;
        }
        case 4: return this.openBus = this.oam[this.oamAddr];
        case 7: {
          const addr = this.v & 0x3FFF;
          let out;
          if (addr >= 0x3F00) { out = this.palette[this.paletteIndex(addr)]; this.readBuf = this.mapper.ppuRead(addr & 0x2FFF); }
          else { out = this.readBuf; this.readBuf = this.mapper.ppuRead(addr); }
          this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
          return this.openBus = out;
        }
        default: return this.openBus;
      }
    }
    writeReg(reg, v) {
      v &= 0xFF;
      this.openBus = v;
      switch (reg & 7) {
        case 0:
          this.ctrl = v;
          this.t = (this.t & ~0x0C00) | ((v & 3) << 10);
          this.nmiOutput = (v & 0x80) !== 0;
          break;
        case 1: this.mask = v; break;
        case 3: this.oamAddr = v; break;
        case 4: this.oam[this.oamAddr] = v; this.oamAddr = (this.oamAddr + 1) & 0xFF; break;
        case 5:
          if (this.w === 0) { this.t = (this.t & ~0x001F) | (v >> 3); this.x = v & 7; this.w = 1; }
          else { this.t = (this.t & ~0x73E0) | ((v & 7) << 12) | ((v >> 3) << 5); this.w = 0; }
          break;
        case 6:
          if (this.w === 0) { this.t = (this.t & 0x00FF) | ((v & 0x3F) << 8); this.w = 1; }
          else { this.t = (this.t & 0x7F00) | v; this.v = this.t; this.w = 0; }
          break;
        case 7:
          this.vramWrite(this.v, v);
          this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
          break;
      }
    }
    // $4014 OAM DMA(本体がページを写す)
    dmaWrite(i, v) { this.oam[(this.oamAddr + i) & 0xFF] = v; }

    // ── loopy ──
    incX() {
      if ((this.v & 0x001F) === 31) this.v = (this.v & ~0x001F) ^ 0x0400;
      else this.v++;
    }
    incY() {
      if ((this.v & 0x7000) !== 0x7000) { this.v += 0x1000; return; }
      this.v &= ~0x7000;
      let y = (this.v & 0x03E0) >> 5;
      if (y === 29) { y = 0; this.v ^= 0x0800; }
      else if (y === 31) y = 0;
      else y++;
      this.v = (this.v & ~0x03E0) | (y << 5);
    }
    copyX() { this.v = (this.v & ~0x041F) | (this.t & 0x041F); }
    copyY() { this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0); }

    reloadShifters() {
      this.bgLo = (this.bgLo & 0xFF00) | this.ptLo;
      this.bgHi = (this.bgHi & 0xFF00) | this.ptHi;
      this.atLo = (this.atLo & 0xFF00) | ((this.atByte & 1) ? 0xFF : 0);
      this.atHi = (this.atHi & 0xFF00) | ((this.atByte & 2) ? 0xFF : 0);
    }

    // 次の行のスプライトを OAM から選ぶ(実機は 65-256 ドットで評価する。ここでは 257 ドット目に一括)
    evaluateSprites(line) {
      const h = (this.ctrl & 0x20) ? 16 : 8;
      let n = 0, hasZero = false;
      for (let i = 0; i < 64; i++) {
        const y = this.oam[i * 4];
        const row = line - y;
        if (row < 0 || row >= h) continue;
        if (n === 8) { this.status |= 0x20; break; }
        this.evalY[n] = row; this.evalTile[n] = this.oam[i * 4 + 1]; this.evalAttr[n] = this.oam[i * 4 + 2]; this.evalX[n] = this.oam[i * 4 + 3];
        if (i === 0) hasZero = true;
        n++;
      }
      this.evalCount = n; this.evalHasZero = hasZero;
    }
    // 257-320 ドット: スロット i のパターン取得(空スロットも $FF タイルを読む=A12 のため)
    fetchSpriteSlot(i, which) {
      const tall = (this.ctrl & 0x20) !== 0;
      let addr;
      if (i < this.evalCount) {
        const attr = this.evalAttr[i];
        let row = this.evalY[i], tile = this.evalTile[i];
        if (attr & 0x80) row = (tall ? 15 : 7) - row;
        if (tall) { addr = ((tile & 1) << 12) | ((tile & 0xFE) << 4) | ((row & 8) << 1) | (row & 7); }
        else addr = ((this.ctrl & 0x08) << 9) | (tile << 4) | row;
      } else {
        addr = ((tall ? 1 : (this.ctrl & 0x08) >> 3) << 12) | 0xFF0;
      }
      const b = this.fetchPattern(addr + (which ? 8 : 0));
      if (i < this.evalCount) {
        if (which) this.sprHi[i] = b; else this.sprLo[i] = b;
        if (which) { this.sprX[i] = this.evalX[i]; this.sprAttr[i] = this.evalAttr[i]; }
      }
      if (which && i === 7) { this.sprCount = this.evalCount; this.sprHasZero = this.evalHasZero; }
    }

    renderPixel(x, line) {
      const mask = this.mask;
      let bgPix = 0, bgPal = 0;
      if ((mask & 0x08) && (x >= 8 || (mask & 0x02))) {
        const bit = 0x8000 >> this.x;
        bgPix = ((this.bgLo & bit) ? 1 : 0) | ((this.bgHi & bit) ? 2 : 0);
        if (bgPix) bgPal = ((this.atLo & bit) ? 1 : 0) | ((this.atHi & bit) ? 2 : 0);
      }
      let sprPix = 0, sprPal = 0, sprBehind = false, sprZero = false;
      if ((mask & 0x10) && (x >= 8 || (mask & 0x04))) {
        for (let i = 0; i < this.sprCount; i++) {
          const dx = x - this.sprX[i];
          if (dx < 0 || dx > 7) continue;
          const attr = this.sprAttr[i];
          const bit = (attr & 0x40) ? dx : 7 - dx;
          const px = ((this.sprLo[i] >> bit) & 1) | (((this.sprHi[i] >> bit) & 1) << 1);
          if (!px) continue;
          sprPix = px; sprPal = attr & 3; sprBehind = (attr & 0x20) !== 0; sprZero = (i === 0 && this.sprHasZero);
          break;
        }
      }
      if (sprZero && bgPix && sprPix && x !== 255) this.status |= 0x40;
      let idx;
      if (!bgPix && !sprPix) idx = this.palette[0];
      else if (sprPix && (!bgPix || !sprBehind)) idx = this.palette[0x10 | (sprPal << 2) | sprPix];
      else idx = this.palette[(bgPal << 2) | bgPix];
      if (mask & 1) idx &= 0x30;
      this.frame[line * 256 + x] = PALETTE[idx & 0x3F];
    }

    // 1 ドット進める
    step() {
      const line = this.scanline, dot = this.dot;
      const rendering = (this.mask & 0x18) !== 0;
      const visible = line < 240;
      if (visible || line === 261) {
        if (line === 261 && dot === 1) { this.status &= ~0xE0; this.nmiOccurred = false; }
        if (rendering) {
          if ((dot >= 2 && dot <= 257) || (dot >= 322 && dot <= 337)) {
            this.bgLo <<= 1; this.bgHi <<= 1; this.atLo <<= 1; this.atHi <<= 1;
            if (((dot - 1) & 7) === 0) this.reloadShifters();
          }
          if ((dot >= 1 && dot <= 256) || (dot >= 321 && dot <= 336)) {
            switch (dot & 7) {
              case 1: this.ntByte = this.mapper.ppuRead(0x2000 | (this.v & 0x0FFF)); break;
              case 3: {
                const at = this.mapper.ppuRead(0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07));
                const shift = ((this.v >> 4) & 4) | (this.v & 2);
                this.atByte = (at >> shift) & 3;
                break;
              }
              case 5: this.ptLo = this.fetchPattern(((this.ctrl & 0x10) << 8) | (this.ntByte << 4) | (this.v >> 12)); break;
              case 7: this.ptHi = this.fetchPattern(((this.ctrl & 0x10) << 8) | (this.ntByte << 4) | (this.v >> 12) | 8); break;
              case 0: this.incX(); if (dot === 256) this.incY(); break;
            }
          }
          if (dot === 257) { this.copyX(); this.evaluateSprites(visible ? line + 1 : 0); }
          if (dot >= 257 && dot <= 320) {
            this.oamAddr = 0;
            const k = (dot - 257) & 7;
            if (k === 5) this.fetchSpriteSlot((dot - 257) >> 3, 0);
            else if (k === 7) this.fetchSpriteSlot((dot - 257) >> 3, 1);
          }
          if (line === 261 && dot >= 280 && dot <= 304) this.copyY();
          if (dot === 337 || dot === 339) this.mapper.ppuRead(0x2000 | (this.v & 0x0FFF)); // ダミーの NT 読み
        } else if (visible && dot >= 1 && dot <= 256) {
          // 描画オフ: 背景色(v がパレットを指していればその色)
          const addr = this.v & 0x3FFF;
          let idx = (addr >= 0x3F00) ? this.palette[this.paletteIndex(addr)] : this.palette[0];
          if (this.mask & 1) idx &= 0x30;
          this.frame[line * 256 + dot - 1] = PALETTE[idx & 0x3F];
        }
        if (rendering && visible && dot >= 1 && dot <= 256) this.renderPixel(dot - 1, line);
      }
      if (line === 241 && dot === 1) { this.status |= 0x80; this.nmiOccurred = true; this.vblankStarted = true; }

      // 次のドットへ(奇数フレームは描画中なら 261 行目の最後の 1 ドットを飛ばす)
      this.time++;
      let next = dot + 1;
      if (line === 261 && next === 340 && this.odd && rendering) next = 341;
      if (next >= DOTS_PER_LINE) {
        next = 0;
        this.scanline++;
        if (this.scanline >= LINES) { this.scanline = 0; this.odd = !this.odd; this.frameCount++; this.frameDone = true; }
      }
      this.dot = next;
    }

    nmiLine() { return this.nmiOccurred && this.nmiOutput; }
  }

  PPU.PALETTE = PALETTE;
  Emu.PPU = PPU;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * NES 本体 (MML.Emu.NesConsole) — CPU(cpu6502.js)/PPU(nes/ppu.js)/APU(apu2a03.js)/マッパー(nes/mappers.js)/
 * 入力の結線と、フレーム/サンプル単位の実行。DOM に依存しない(ヘッドレス tools/headless/nes-run.js、
 * AudioWorklet の中 src/audio/nes-worklet-impl.js、主スレッド src/ui/nesScreen.js のどこでも同じ物が動く)。
 *
 * - 1 命令ごとに消費サイクルぶん APU を進め、PPU を 3 ドットずつ進める。命令のメモリアクセスは最後のサイクルで
 *   起きる近似(基本サイクル数-1 だけ先に周辺を進めてから実行)。$2002 の vblank 待ちやスプライト 0 待ちは、
 *   読みの瞬間とフラグが立つ瞬間の前後関係で結果が変わるため(命令をまるごと先に実行すると NMI ハンドラが
 *   先にフラグを消す側に必ず負けて永久に待つ。実測で踏んだ)。
 * - NMI は PPU の線(vblank フラグ ∧ $2000 bit7)の立ち上がりを命令境界で拾う。IRQ は APU のフレーム/DMC と
 *   マッパー(MMC3/N163)の線の論理和を、I フラグが下りていれば命令境界で受ける。
 * - $4014 OAM DMA は 256 バイトを即座に写し、513/514 サイクルを次の命令に乗せる。
 * - 音: setSampleRate(sr) を呼ぶと周辺を進める中で APU(+拡張音源)の混合をリングバッファへ標本化する。
 *   runFrame() は 1 フレームぶんを返し、runSamples(out) は out.length サンプルぶんだけ進める(AudioWorklet 用)。
 * - 入力: setController(port, bits)。bits は A=1 B=2 Select=4 Start=8 Up=16 Down=32 Left=64 Right=128。
 * - 録音(段階 6b): startRecording() → 以後、音源レジスタの書き込み(2A03/FDS/拡張音源)・N163 $4800 の読み飛ばし・
 *   DPCM の起動(サンプル本体つき)を rec.cur に積み、フレームが終わるたび rec.frames へ移す。書き込みの形は
 *   src/vgm/vgmRecord.js の encodeNesRecording が受ける物({addr,value,t,read?} / {dmc:{addr,data}})。
 *   開始時には今のレジスタ像(2A03 の影 $4000-$4017、N163 の内部 RAM)を書き込みとして先頭に置く
 *   (録音は曲の途中から始まるので、鳴っている音の状態が無いと再生側で復元できない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 1789773;
  const SAMPLES_PER_FRAME = 735;
  const AUDIO_RING = 1 << 14;

  class NesConsole {
    constructor(romBytes) {
      this.rom = Emu.INES.parse(romBytes);
      this.mapper = Emu.NesMappers.create(this.rom);
      this.ppu = new Emu.PPU(this.mapper);
      this.apu = new Emu.APU2A03(this);
      this.cpu = new Emu.CPU6502(this);
      this.ram = new Uint8Array(0x800);
      this.apuShadow = new Uint8Array(0x18); // $4000-$4017 の最後の書き込み値(録音開始時の像)
      this.openBus = 0;
      this.pad = [0, 0]; this.padShift = [0, 0]; this.padStrobe = false;
      this.dmaCycles = 0;
      this.prevNmi = false; this.pendingNmi = false; this.nmiNext = false;
      this.cpuCycles = 0;
      this.frameCount = 0;
      this._frameFlag = false;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0;
      this.underruns = 0;
      this.onWrite = null;   // (addr, value, frameFrac) 音源レジスタの書き込み(ライブ表示など)
      this.onFrame = null;   // () フレームが描き終わるたび(AudioWorklet が画面を送るのに使う)
      this.rec = null;       // 録音中 { frames: [[write...]], cur: [write...] }
      this.reset();
    }

    reset() {
      this.ram.fill(0);
      this.ppu.reset();
      this.apu.reset();
      this.apuShadow.fill(0);
      this.apu.writeRegister(0x4017, 0x00);
      this.apu.writeRegister(0x4015, 0x00);
      this.cpu.reset();
      this.cpu.PC = this.read(0xFFFC) | (this.read(0xFFFD) << 8);
      this.prevNmi = false; this.pendingNmi = false; this.nmiNext = false; this.dmaCycles = 0;
      this.cpuCycles = 0;
    }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; }
    setController(port, bits) { this.pad[port & 1] = bits & 0xFF; }
    // NSF ヘッダと同じ拡張音源ビット(録音の NESX ヘッダ用)
    extBits() { return this.mapper.audio ? (this.mapper.extBits || 0) : 0; }
    // フレーム内の時刻(0〜1)。PPU の位置から出す(書き込みの t と録音の精度はこれ)
    frameFrac() { return (((this.ppu.scanline + 262 - 241) % 262) * 341 + this.ppu.dot) / (262 * 341); } // vblank の頭を 0 とする

    // ── バス ──
    read(addr) {
      addr &= 0xFFFF;
      let v;
      if (addr < 0x2000) v = this.ram[addr & 0x7FF];
      else if (addr < 0x4000) v = this.ppu.readReg(addr & 7);
      else if (addr === 0x4015) v = this.apu.readStatus();
      else if (addr === 0x4016 || addr === 0x4017) {
        const p = addr & 1;
        if (this.padStrobe) v = this.pad[p] & 1;
        else { v = this.padShift[p] & 1; this.padShift[p] = (this.padShift[p] >> 1) | 0x80; }
        v |= this.openBus & 0xE0;
      } else if (addr < 0x4020) v = this.openBus;
      else {
        v = this.mapper.cpuRead(addr);
        if (v < 0) v = this.openBus;
        // N163 $4800 の読み出しは内部ポインタを進める副作用がある(録音には読み飛ばしとして載せる)
        else if (addr === 0x4800 && this.mapper.audio && this.rec) this.rec.cur.push({ addr: 0x4800, value: 0, read: true, t: this._t() });
      }
      this.openBus = v;
      return v;
    }
    write(addr, v) {
      addr &= 0xFFFF; v &= 0xFF;
      this.openBus = v;
      if (addr < 0x2000) { this.ram[addr & 0x7FF] = v; return; }
      if (addr < 0x4000) { this.ppu.writeReg(addr & 7, v); return; }
      if (addr === 0x4014) {
        const base = v << 8;
        for (let i = 0; i < 256; i++) this.ppu.dmaWrite(i, this.read(base + i));
        this.dmaCycles += 513 + (this.cpuCycles & 1);
        return;
      }
      if (addr === 0x4016) {
        const was = this.padStrobe;
        this.padStrobe = (v & 1) !== 0;
        if (was && !this.padStrobe) { this.padShift[0] = this.pad[0]; this.padShift[1] = this.pad[1]; }
        return;
      }
      if (addr < 0x4018) {
        this.apuShadow[addr - 0x4000] = v;
        // DPCM の起動: 再生側が同じサンプルを持てるよう、$4012/$4013 が指す本体をこの瞬間の CPU 空間から写す
        if (addr === 0x4015 && (v & 0x10) && this.rec) this.rec.cur.push({ dmc: this.dmcSample() });
        this.apu.writeRegister(addr, v);
        this._logWrite(addr, v);
        return;
      }
      this.mapper.cpuWrite(addr, v);
      if (this.mapper.audio && (addr === 0x4800 || addr === 0xF800)) this._logWrite(addr, v);
    }
    _t() { return Math.min(SAMPLES_PER_FRAME - 1, Math.floor(this.frameFrac() * SAMPLES_PER_FRAME)); }
    _logWrite(addr, v) {
      if (this.rec) this.rec.cur.push({ addr, value: v, t: this._t() });
      if (this.onWrite) this.onWrite(addr, v, this.frameFrac());
    }
    // 今の $4012/$4013 が指す DPCM サンプル本体(CPU アドレスと中身)。$FFFF を越えたら $8000 へ折り返す
    dmcSample() {
      const addr = 0xC000 + this.apuShadow[0x12] * 64;
      const len = this.apuShadow[0x13] * 16 + 1;
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        let a = addr + i;
        if (a > 0xFFFF) a = 0x8000 + (a - 0x10000);
        const b = this.mapper.cpuRead(a);
        data[i] = b < 0 ? 0 : b;
      }
      return { addr, data };
    }

    // ── 録音 ──
    startRecording() {
      const cur = [];
      // 今のレジスタ像を先頭に置く(2A03: $4000-$4013, $4015, $4017。$4015 は DPCM 起動なら本体つき)
      for (let r = 0; r < 0x14; r++) cur.push({ addr: 0x4000 + r, value: this.apuShadow[r], t: 0 });
      if (this.apuShadow[0x15] & 0x10) cur.push({ dmc: this.dmcSample() });
      cur.push({ addr: 0x4015, value: this.apuShadow[0x15], t: 0 });
      cur.push({ addr: 0x4017, value: this.apuShadow[0x17], t: 0 });
      const au = this.mapper.audio;
      if (au && au.ram && au.ram.length === 128) { // N163: 内部 RAM 128 バイトとアドレスラッチ
        cur.push({ addr: 0xF800, value: 0x80, t: 0 });
        for (let i = 0; i < 128; i++) cur.push({ addr: 0x4800, value: au.ram[i], t: 0 });
        cur.push({ addr: 0xF800, value: (au.autoInc ? 0x80 : 0) | (au.addr & 0x7F), t: 0 });
      }
      this.rec = { frames: [], cur };
    }
    // 録音を終えて、フレームごとの書き込み列を返す(最後の途中フレームも含む)
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) rec.frames.push(rec.cur);
      return rec.frames;
    }

    // ── 実行 ──
    // 1 命令(+割り込み)を実行し、消費サイクルぶん周辺を進める。
    // 命令のメモリアクセスは最後のサイクルで起きる: 基本サイクル数ぶん周辺を先に進めてから実行し、
    // ページ跨ぎ/分岐成立の追加サイクルは後ろに付ける(読み出しは実機の φ2 より最大 1 ドット遅いだけ)。
    // NMI の縁は 6502 の規則どおり「命令の最後のサイクルより前に立てばこの命令の後、最後のサイクル
    // (と追加サイクル)で立てば次の命令の後」。$2002 を回して vblank を待つループ(LDA $2002 / BPL)は
    // この 1 命令の遅れで読みが勝ち、NMI ハンドラがフラグを消す前に抜けられる(実機・Mesen と同じ挙動。
    // 抜けられないと 1 フレーム待ち直す=ゲームが 1 フレーム遅れる。実測で 3 フレーム差になった)
    step() {
      const cpu = this.cpu, ppu = this.ppu, apu = this.apu, mapper = this.mapper;
      let cycles;
      if (this.pendingNmi) { this.pendingNmi = false; cycles = cpu.nmi(); this.advance(cycles); this._nmiEdge(ppu.nmiLine(), false); return cycles; }
      if (this.nmiNext) { this.pendingNmi = true; this.nmiNext = false; }
      if (!cpu.irqInhibited() && (apu.frameIrqFlag || apu.dmc.irqFlag || mapper.irqPending())) {
        cycles = cpu.irq(); this.advance(cycles); this._nmiEdge(ppu.nmiLine(), false); return cycles;
      }
      const base = cpu.peekCycles();
      if (base > 1) this.advance(base - 1);
      this._nmiEdge(ppu.nmiLine(), false);   // 最後のサイクルより前の縁 → この命令の後
      this.advance(1);
      this._nmiEdge(ppu.nmiLine(), true);    // 最後のサイクルの縁 → 次の命令の後
      cycles = cpu.step() - base;            // 追加サイクル(ページ跨ぎ・分岐成立)
      cycles += this.dmaCycles; this.dmaCycles = 0;
      if (cycles > 0) { this.advance(cycles); this._nmiEdge(ppu.nmiLine(), true); }
      return base + cycles;
    }
    _nmiEdge(line, late) {
      if (line && !this.prevNmi) { if (late) this.nmiNext = true; else this.pendingNmi = true; }
      this.prevNmi = line;
    }

    // 周辺(APU/拡張音源/PPU/音の標本化/マッパーの IRQ カウンタ)を cycles サイクルぶん進める
    advance(cycles) {
      const ppu = this.ppu, apu = this.apu, mapper = this.mapper;
      this.cpuCycles += cycles;
      mapper.cpuClock(cycles); // ★命令前の先行分にも掛ける(片側だけだと N163 の IRQ カウンタが 1/3 の速さになる。実測)
      const audio = mapper.audio;
      const sr = this.sampleRate;
      for (let c = 0; c < cycles; c++) {
        apu.clock();
        if (audio) audio.clock();
        ppu.step(); ppu.step(); ppu.step();
        // フレームの区切りは vblank の頭(241 行目)。画面はここで描き上がっているし、録音のフレーム分けが Mesen の
        // endFrame(同じく vblank の頭)と揃う(NMI で書く音源ドライバの書き込みが同じフレームに入る。区切りを
        // 261 行目の末尾にすると NMI の書き込みがフレームの末尾 92% の位置になり、Mesen 録音と 1 フレームずれた)
        if (ppu.vblankStarted) { ppu.vblankStarted = false; this.frameCount++; this._frameEnd(); }
        if (sr) {
          this.cycleAccum += sr;
          if (this.cycleAccum >= CPU_CLOCK) {
            this.cycleAccum -= CPU_CLOCK;
            if (this.ringLen < AUDIO_RING) {
              let s = apu.mixSample();
              if (audio) s += audio.mixSample();
              this.ring[(this.ringHead + this.ringLen) & (AUDIO_RING - 1)] = s;
              this.ringLen++;
            }
          }
        }
      }
    }
    _frameEnd() {
      this._frameFlag = true;
      if (this.rec) { this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      if (this.onFrame) this.onFrame();
    }

    // PPU が 1 フレームを描き終えるまで回す。音を有効にしていればそのフレームのサンプル列を返す
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) {
        this.step();
        if (++guard > 200000) break; // 暴走の保険(1 フレームは約 29780 サイクル = 命令 1 万前後)
      }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    // out.length サンプルぶん進めて out に書く(AudioWorklet の process)。setSampleRate が要る
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.step();
      if (this.ringLen < n) this.underruns++; // 間に合わなかった(音切れ)。AudioWorklet の process が時間内に終われなかった印
      this.takeAudioInto(out, n);
    }
    takeAudio(n) {
      const out = new Float32Array(n);
      this.takeAudioInto(out, n);
      return out;
    }
    takeAudioInto(out, n) {
      const take = Math.min(n, this.ringLen);
      for (let i = 0; i < take; i++) out[i] = this.ring[(this.ringHead + i) & (AUDIO_RING - 1)];
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & (AUDIO_RING - 1);
      this.ringLen -= take;
    }

    get frame() { return this.ppu.frame; }
  }

  NesConsole.CPU_CLOCK = CPU_CLOCK;
  NesConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.NesConsole = NesConsole;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * NES 本体を AudioWorklet の中で回す (nes-worklet バンドルの本体。DESIGN-CAPTURE.md §6/§7、段階 6b)
 *
 * 音の時刻を基準にフレームを刻む: process() が 128 サンプルを求めるたびに、その分だけ CPU/PPU/APU を進める
 * (NesConsole.runSamples)。画面が 1 枚できるたびに主スレッドへ frame(Uint32Array の ArrayBuffer、転送)と、
 * 録音中ならそのフレームの書き込み列を送る。主スレッドは描くだけ。
 * 主スレッドからは load(ROM)/pad(入力)/reset/pause/record を受ける。
 *
 * 出力は APU の混合(0〜1.16 程度、片側)を DC ブロッカー(stream-player.js と同じ係数)に通した物。
 * 音量(NSF_GAIN)とリミッタは主スレッド側の GainNode/DynamicsCompressor(src/ui/nesScreen.js)。
 *
 * バンドル: tools/build-capture-workers.ps1 の nesWorklet(cpu6502/apu2a03/n163/nes/*.js + この本文)。
 * data: URL で addModule するので file:// 直開きでも動く(src/ui/nesScreen.js)。
 */
(function (global) {
  'use strict';
  if (typeof AudioWorkletProcessor === 'undefined' || typeof registerProcessor !== 'function') return;
  const MML = global.MML;

  class NesWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.nes = null;
      this.paused = false;
      this.dcX = 0; this.dcY = 0;
      this.frameSeq = 0;
      this.port.onmessage = (e) => this.onMessage(e.data || {});
    }
    onMessage(m) {
      try {
        switch (m.type) {
          case 'load': {
            const nes = new MML.Emu.NesConsole(new Uint8Array(m.rom));
            nes.setSampleRate(sampleRate);
            nes.onFrame = () => this.onFrame();
            this.nes = nes;
            this.dcX = 0; this.dcY = 0;
            this.port.postMessage({ type: 'loaded', info: MML.Emu.INES.describe(nes.rom), extBits: nes.extBits(), sampleRate });
            break;
          }
          case 'pad': if (this.nes) this.nes.setController(m.port | 0, m.bits | 0); break;
          case 'reset': if (this.nes) this.nes.reset(); break;
          case 'pause': this.paused = !!m.on; break;
          case 'record':
            if (!this.nes) break;
            if (m.on) this.nes.startRecording();
            else { const frames = this.nes.stopRecording(); this.port.postMessage({ type: 'recordEnd', frames }); }
            break;
        }
      } catch (e) {
        this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) });
      }
    }
    onFrame() {
      const nes = this.nes;
      const frame = nes.frame.slice();
      const msg = { type: 'frame', seq: ++this.frameSeq, frame: frame.buffer, underruns: nes.underruns };
      if (nes.rec) { msg.writes = nes.rec.frames.splice(0); }
      this.port.postMessage(msg, [frame.buffer]);
    }
    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      if (!this.nes || this.paused) { out.fill(0); return true; }
      try {
        this.nes.runSamples(out);
      } catch (e) {
        this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) });
        this.nes = null; out.fill(0); return true;
      }
      let x1 = this.dcX, y1 = this.dcY;
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        const y = x - x1 + 0.999 * y1;
        x1 = x; y1 = y;
        out[i] = y;
      }
      this.dcX = x1; this.dcY = y1;
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return true;
    }
  }
  registerProcessor('nes-console', NesWorkletProcessor);
})(typeof window !== 'undefined' ? window : globalThis);

  };
})(window);