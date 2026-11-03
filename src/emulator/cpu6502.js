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
      this.rmwDummy = false;
      this.irqPolledI = F_I; // IRQ 判定に使う I フラグ(前の命令の最後のサイクルで見た値。CLI/SEI/PLP は 1 命令遅れて効く)
      this.callActive = false;
    }

    // --- 割り込み(NES 本体 src/emulator/nes/nesConsole.js 用。NSF 再生は使わない) ---
    // 現在の PC と P(B クリア・U セット)を積み、I を立ててベクタへ飛ぶ。戻り値は消費サイクル(7)
    interrupt(vector) {
      this.push((this.PC >> 8) & 0xFF);
      this.push(this.PC & 0xFF);
      this.push((this.P | F_U) & ~F_B);
      this.setFlag(F_I, true);
      this.irqPolledI = F_I;
      this.PC = this.read16(vector);
      return 7;
    }
    // 次に実行する命令の基本サイクル数(ページ跨ぎ等の追加分を含まない)。NES 本体が「最後の 1 サイクルで
    // メモリアクセスが起きる」近似のため、命令の実行前に周辺を進める量を決めるのに使う。未定義命令は 2
    peekCycles() { const def = OPS[this.bus.read(this.PC) & 0xFF]; return def ? def.cycles : 2; }
    nmi() { return this.interrupt(0xFFFA); }
    irq() { return this.interrupt(0xFFFE); }
    irqInhibited() { return (this.P & F_I) !== 0; }
    // 実機の IRQ 判定: I フラグは命令の最後のサイクルで見るので、CLI/SEI/PLP で変えた値は次の命令の後から効く
    // (CLI の直後の BRK が先に実行される。BRK でサブルーチンを呼ぶゲームが CLI; BRK で 2 バイト前に戻って暴走した)。RTI は即時
    irqPolledInhibited() { return this.irqPolledI !== 0; }

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
    // RMW 命令(ASL/LSR/ROL/ROR/INC/DEC と非公式の SLO/RLA/SRE/RRA/DCP/ISC)の書き戻し: 実機は読んだ古い値をいったん
    // 書いてから(ダミー書き)新しい値を書く(2 サイクル連続)。マッパーのレジスタに INC すると、MMC1 はダミー書き(古い値、bit7 が
    // 立っていればリセット)だけを受けて続く本物の書きを無視する(連続サイクルの書きは無視)ので、両方を再現する。
    // rmwDummy はダミー書きの間だけ true(NesConsole がマッパーへ伝える)
    writeRmw(mode, addr, old, value) {
      if (mode === 'acc') { this.A = value & 0xFF; return; }
      this.rmwDummy = true;
      try { this.write(addr, old); } finally { this.rmwDummy = false; }
      this.write(addr, value);
    }

    // --- 命令実行（1命令）---
    // 戻り値: 消費サイクル数
    step() {
      const iBefore = this.P & F_I;
      const opcode = this.fetchByte();
      const def = OPS[opcode];
      if (!def) {
        // 未定義オペコードは2サイクルNOP相当として無視する
        this.irqPolledI = iBefore;
        return 2;
      }
      const extra = def.exec(this, def.mode);
      this.irqPolledI = (opcode === 0x40 || opcode === 0x00) ? (this.P & F_I) : iBefore; // RTI($40)と BRK($00)は即時
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

  function adcValue(cpu, value) {
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const sum = cpu.A + value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
  }
  function ADC(cpu, mode) { const op = cpu.fetchOperand(mode); adcValue(cpu, op.value); return op.pageCrossed ? 1 : 0; }
  function SBC(cpu, mode) { const op = cpu.fetchOperand(mode); adcValue(cpu, op.value ^ 0xFF); return op.pageCrossed ? 1 : 0; }

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
    cpu.writeRmw(mode, op.addr, op.value, result);
    return 0;
  }

  function LSR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = (op.value >> 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeRmw(mode, op.addr, op.value, result);
    return 0;
  }

  function ROL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = ((op.value << 1) | c) & 0xFF;
    cpu.setZN(result);
    cpu.writeRmw(mode, op.addr, op.value, result);
    return 0;
  }

  function ROR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = ((op.value >> 1) | (c << 7)) & 0xFF;
    cpu.setZN(result);
    cpu.writeRmw(mode, op.addr, op.value, result);
    return 0;
  }

  function INC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value + 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeRmw(mode, op.addr, op.value, result);
    return 0;
  }

  function DEC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value - 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeRmw(mode, op.addr, op.value, result);
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
  function NOPX(cpu, mode) { const op = cpu.fetchOperand(mode); return op.pageCrossed ? 1 : 0; } // 非公式 NOP abs,X はページ跨ぎで +1

  // --- 非公式(未定義)命令。NESdev Wiki「CPU unofficial opcodes」の安定な物と、不安定な物は一般的な解釈 ---
  //   読み書き複合(SLO/RLA/SRE/RRA/DCP/ISC)は「RMW してから A と演算」。SH*/TAS はページ跨ぎで番地の上位が値になる癖まで。
  //   JAM は PC を進めず止まる(本体は回り続ける)。XAA/LAX #imm の定数は $EE(実機でもばらつく)
  function LAX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = cpu.X = op.value; cpu.setZN(op.value); return op.pageCrossed ? 1 : 0; }
  function SAX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A & cpu.X); return 0; }
  function DCP(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value - 1) & 0xFF; cpu.writeRmw(mode, op.addr, op.value, r); compare(cpu, cpu.A, r); return 0; }
  function ISC(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value + 1) & 0xFF; cpu.writeRmw(mode, op.addr, op.value, r); adcValue(cpu, r ^ 0xFF); return 0; }
  function SLO(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = (op.value << 1) & 0xFF; cpu.writeRmw(mode, op.addr, op.value, r); cpu.A |= r; cpu.setZN(cpu.A); return 0; }
  function RLA(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = ((op.value << 1) | c) & 0xFF; cpu.writeRmw(mode, op.addr, op.value, r); cpu.A &= r; cpu.setZN(cpu.A); return 0; }
  function SRE(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 1) !== 0); const r = op.value >> 1; cpu.writeRmw(mode, op.addr, op.value, r); cpu.A ^= r; cpu.setZN(cpu.A); return 0; }
  function RRA(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 1) !== 0); const r = (op.value >> 1) | (c << 7); cpu.writeRmw(mode, op.addr, op.value, r); adcValue(cpu, r); return 0; }
  function ANC(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A &= op.value; cpu.setZN(cpu.A); cpu.setFlag(F_C, (cpu.A & 0x80) !== 0); return 0; }
  function ALR(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A &= op.value; cpu.setFlag(F_C, (cpu.A & 1) !== 0); cpu.A >>= 1; cpu.setZN(cpu.A); return 0; }
  function ARR(cpu, mode) {
    const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.A = (((cpu.A & op.value) >> 1) | (c << 7)) & 0xFF; cpu.setZN(cpu.A);
    cpu.setFlag(F_C, (cpu.A & 0x40) !== 0); cpu.setFlag(F_V, (((cpu.A >> 6) ^ (cpu.A >> 5)) & 1) !== 0); return 0;
  }
  function SBX(cpu, mode) { const op = cpu.fetchOperand(mode); const t = (cpu.A & cpu.X) - op.value; cpu.setFlag(F_C, t >= 0); cpu.X = t & 0xFF; cpu.setZN(cpu.X); return 0; }
  function XAA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = (cpu.A | 0xEE) & cpu.X & op.value; cpu.setZN(cpu.A); return 0; }
  function LAXimm(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = cpu.X = (cpu.A | 0xEE) & op.value; cpu.setZN(cpu.A); return 0; }
  function LAS(cpu, mode) { const op = cpu.fetchOperand(mode); const v = op.value & cpu.S; cpu.A = cpu.X = cpu.S = v; cpu.setZN(v); return op.pageCrossed ? 1 : 0; }
  // SHY/SHX/SHA/TAS: 値 = レジスタ & (ベース番地の上位+1)。ページを跨いだ時は書き込み先の上位バイトがその値になる
  function storeHigh(cpu, mode, reg) {
    const op = cpu.fetchOperand(mode, true);
    const idx = mode === 'absx' ? cpu.X : cpu.Y;
    const base = (op.addr - idx) & 0xFFFF;
    const v = reg & (((base >> 8) + 1) & 0xFF);
    const addr = op.pageCrossed ? ((v << 8) | (op.addr & 0xFF)) : op.addr;
    cpu.write(addr, v);
    return 0;
  }
  function SHY(cpu, mode) { return storeHigh(cpu, mode, cpu.Y); }
  function SHX(cpu, mode) { return storeHigh(cpu, mode, cpu.X); }
  function SHA(cpu, mode) { return storeHigh(cpu, mode, cpu.A & cpu.X); }
  function TAS(cpu, mode) { cpu.S = cpu.A & cpu.X; return storeHigh(cpu, mode, cpu.S); }
  function JAM(cpu) { cpu.halted = true; cpu.PC = (cpu.PC - 1) & 0xFFFF; return 0; }

  // mnemonic -> {mode: [opcodeByte, cycles]}
  const TABLE = {
    // 非公式(安定)
    LAX: { fn: LAX, modes: { zp: [0xA7, 3], zpy: [0xB7, 4], abs: [0xAF, 4], absy: [0xBF, 4], indx: [0xA3, 6], indy: [0xB3, 5] } },
    SAX: { fn: SAX, modes: { zp: [0x87, 3], zpy: [0x97, 4], abs: [0x8F, 4], indx: [0x83, 6] } },
    DCP: { fn: DCP, modes: { zp: [0xC7, 5], zpx: [0xD7, 6], abs: [0xCF, 6], absx: [0xDF, 7], absy: [0xDB, 7], indx: [0xC3, 8], indy: [0xD3, 8] } },
    ISC: { fn: ISC, modes: { zp: [0xE7, 5], zpx: [0xF7, 6], abs: [0xEF, 6], absx: [0xFF, 7], absy: [0xFB, 7], indx: [0xE3, 8], indy: [0xF3, 8] } },
    SLO: { fn: SLO, modes: { zp: [0x07, 5], zpx: [0x17, 6], abs: [0x0F, 6], absx: [0x1F, 7], absy: [0x1B, 7], indx: [0x03, 8], indy: [0x13, 8] } },
    RLA: { fn: RLA, modes: { zp: [0x27, 5], zpx: [0x37, 6], abs: [0x2F, 6], absx: [0x3F, 7], absy: [0x3B, 7], indx: [0x23, 8], indy: [0x33, 8] } },
    SRE: { fn: SRE, modes: { zp: [0x47, 5], zpx: [0x57, 6], abs: [0x4F, 6], absx: [0x5F, 7], absy: [0x5B, 7], indx: [0x43, 8], indy: [0x53, 8] } },
    RRA: { fn: RRA, modes: { zp: [0x67, 5], zpx: [0x77, 6], abs: [0x6F, 6], absx: [0x7F, 7], absy: [0x7B, 7], indx: [0x63, 8], indy: [0x73, 8] } },
    'SBC*': { fn: SBC, modes: { imm: [0xEB, 2] } },
    ANC: { fn: ANC, modes: { imm: [0x0B, 2] } },
    'ANC*': { fn: ANC, modes: { imm: [0x2B, 2] } },
    ALR: { fn: ALR, modes: { imm: [0x4B, 2] } },
    ARR: { fn: ARR, modes: { imm: [0x6B, 2] } },
    SBX: { fn: SBX, modes: { imm: [0xCB, 2] } },
    'NOP*': { fn: NOP, modes: { impl: [0x1A, 2] } },
    'NOP*2': { fn: NOP, modes: { impl: [0x3A, 2] } },
    'NOP*3': { fn: NOP, modes: { impl: [0x5A, 2] } },
    'NOP*4': { fn: NOP, modes: { impl: [0x7A, 2] } },
    'NOP*5': { fn: NOP, modes: { impl: [0xDA, 2] } },
    'NOP*6': { fn: NOP, modes: { impl: [0xFA, 2] } },
    'NOP#': { fn: NOP, modes: { imm: [0x80, 2] } },
    'NOP#2': { fn: NOP, modes: { imm: [0x82, 2] } },
    'NOP#3': { fn: NOP, modes: { imm: [0x89, 2] } },
    'NOP#4': { fn: NOP, modes: { imm: [0xC2, 2] } },
    'NOP#5': { fn: NOP, modes: { imm: [0xE2, 2] } },
    'NOPz': { fn: NOP, modes: { zp: [0x04, 3] } },
    'NOPz2': { fn: NOP, modes: { zp: [0x44, 3] } },
    'NOPz3': { fn: NOP, modes: { zp: [0x64, 3] } },
    'NOPzx': { fn: NOP, modes: { zpx: [0x14, 4] } },
    'NOPzx2': { fn: NOP, modes: { zpx: [0x34, 4] } },
    'NOPzx3': { fn: NOP, modes: { zpx: [0x54, 4] } },
    'NOPzx4': { fn: NOP, modes: { zpx: [0x74, 4] } },
    'NOPzx5': { fn: NOP, modes: { zpx: [0xD4, 4] } },
    'NOPzx6': { fn: NOP, modes: { zpx: [0xF4, 4] } },
    'NOPa': { fn: NOP, modes: { abs: [0x0C, 4] } },
    'NOPax': { fn: NOPX, modes: { absx: [0x1C, 4] } },
    'NOPax2': { fn: NOPX, modes: { absx: [0x3C, 4] } },
    'NOPax3': { fn: NOPX, modes: { absx: [0x5C, 4] } },
    'NOPax4': { fn: NOPX, modes: { absx: [0x7C, 4] } },
    'NOPax5': { fn: NOPX, modes: { absx: [0xDC, 4] } },
    'NOPax6': { fn: NOPX, modes: { absx: [0xFC, 4] } },
    // 非公式(不安定。一般的な解釈)
    XAA: { fn: XAA, modes: { imm: [0x8B, 2] } },
    'LAX#': { fn: LAXimm, modes: { imm: [0xAB, 2] } },
    LAS: { fn: LAS, modes: { absy: [0xBB, 4] } },
    SHY: { fn: SHY, modes: { absx: [0x9C, 5] } },
    SHX: { fn: SHX, modes: { absy: [0x9E, 5] } },
    SHA: { fn: SHA, modes: { absy: [0x9F, 5], indy: [0x93, 6] } },
    TAS: { fn: TAS, modes: { absy: [0x9B, 5] } },
    JAM: { fn: JAM, modes: { impl: [0x02, 2] } },
    'JAM2': { fn: JAM, modes: { impl: [0x12, 2] } },
    'JAM3': { fn: JAM, modes: { impl: [0x22, 2] } },
    'JAM4': { fn: JAM, modes: { impl: [0x32, 2] } },
    'JAM5': { fn: JAM, modes: { impl: [0x42, 2] } },
    'JAM6': { fn: JAM, modes: { impl: [0x52, 2] } },
    'JAM7': { fn: JAM, modes: { impl: [0x62, 2] } },
    'JAM8': { fn: JAM, modes: { impl: [0x72, 2] } },
    'JAM9': { fn: JAM, modes: { impl: [0x92, 2] } },
    'JAM10': { fn: JAM, modes: { impl: [0xB2, 2] } },
    'JAM11': { fn: JAM, modes: { impl: [0xD2, 2] } },
    'JAM12': { fn: JAM, modes: { impl: [0xF2, 2] } },
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
