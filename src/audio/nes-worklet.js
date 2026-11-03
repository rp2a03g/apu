/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-11-03 19:26:59
 *
 * regsOnly capture worker bundle (nesWorklet). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.nesWorklet is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.nesWorkletBuiltAt = '2026-11-03 19:26:59';
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
  function NOPX(cpu, mode) { const op = cpu.fetchOperand(mode); return op.pageCrossed ? 1 : 0; } // 非公式 NOP abs,X はページ跨ぎで +1

  // --- 非公式(未定義)命令。NESdev Wiki「CPU unofficial opcodes」の安定な物と、不安定な物は一般的な解釈 ---
  //   読み書き複合(SLO/RLA/SRE/RRA/DCP/ISC)は「RMW してから A と演算」。SH*/TAS はページ跨ぎで番地の上位が値になる癖まで。
  //   JAM は PC を進めず止まる(本体は回り続ける)。XAA/LAX #imm の定数は $EE(実機でもばらつく)
  function LAX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = cpu.X = op.value; cpu.setZN(op.value); return op.pageCrossed ? 1 : 0; }
  function SAX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A & cpu.X); return 0; }
  function DCP(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value - 1) & 0xFF; cpu.write(op.addr, r); compare(cpu, cpu.A, r); return 0; }
  function ISC(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value + 1) & 0xFF; cpu.write(op.addr, r); adcValue(cpu, r ^ 0xFF); return 0; }
  function SLO(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = (op.value << 1) & 0xFF; cpu.write(op.addr, r); cpu.A |= r; cpu.setZN(cpu.A); return 0; }
  function RLA(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = ((op.value << 1) | c) & 0xFF; cpu.write(op.addr, r); cpu.A &= r; cpu.setZN(cpu.A); return 0; }
  function SRE(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 1) !== 0); const r = op.value >> 1; cpu.write(op.addr, r); cpu.A ^= r; cpu.setZN(cpu.A); return 0; }
  function RRA(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 1) !== 0); const r = (op.value >> 1) | (c << 7); cpu.write(op.addr, r); adcValue(cpu, r); return 0; }
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
 * VRC6 拡張音源エミュレータ
 * MML.Emu.VRC6Audio
 *
 * パルス x2 ($9000-$9002 / $A000-$A002) + 矩形波(サウ) ($B000-$B002)
 * パルスはデューティ比1/16刻みで指定可能(0=幅1/16 ... 15=幅16/16)。
 * サウ(sawtooth)はNESdev準拠の14ステップアキュムレータ実装(Vrc6Saw.clock()参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class Vrc6Pulse {
    constructor() {
      this.duty = 0;
      this.volume = 0;
      this.digitized = false;
      this.enabled = false;
      this.period = 0;
      this.timer = 0;
      this.step = 15; // dutyカウンタは 15→0 のダウンカウント。先頭=15
    }
    writeCtrl(value) {
      this.duty = (value >> 4) & 0x07;
      this.volume = value & 0x0F;
      this.digitized = (value & 0x80) !== 0;
    }
    writePeriodLo(value) {
      this.period = (this.period & 0x0F00) | value;
    }
    writePeriodHi(value) {
      this.period = (this.period & 0x00FF) | ((value & 0x0F) << 8);
      this.enabled = (value & 0x80) !== 0;
      // NESdev: E=0 で duty カウンタを即リセット＋停止（再有効化で先頭から）
      if (!this.enabled) { this.step = 15; this.timer = 0; }
    }
    clock() {
      if (!this.enabled) return; // 無効時は停止（カウンタを進めない）
      if (this.timer === 0) {
        this.timer = this.period;
        this.step = (this.step - 1) & 0x0F; // 15→0 ダウンカウント
      } else {
        this.timer--;
      }
    }
    output() {
      if (!this.enabled) return 0;
      if (this.digitized) return this.volume;
      return (this.step <= this.duty) ? this.volume : 0;
    }
  }

  class Vrc6Saw {
    constructor() {
      this.accumRate = 0;
      this.accum = 0;
      this.enabled = false;
      this.period = 0;
      this.timer = 0;
      this.step = 0; // 14ステップ周期のカウンタ (0-13)
    }
    writeCtrl(value) {
      this.accumRate = value & 0x3F;
    }
    writePeriodLo(value) {
      this.period = (this.period & 0x0F00) | value;
    }
    writePeriodHi(value) {
      this.period = (this.period & 0x00FF) | ((value & 0x0F) << 8);
      this.enabled = (value & 0x80) !== 0;
    }
    // NESdev準拠: タイマは1 CPUサイクルごと。14ステップ周期で、偶数ステップに accumRate を
    // 6回加算し、14ステップ目で加算せずアキュムレータを0リセット（＝7段のこぎり波、f=CPU/(14*(t+1))）。
    clock() {
      if (!this.enabled) { this.accum = 0; return; } // E=0 でアキュムレータ0固定
      if (this.timer === 0) {
        this.timer = this.period;
        this.step++;
        if (this.step >= 14) {
          this.step = 0;
          this.accum = 0;                 // 7回目の作用クロック = リセット
        } else if ((this.step & 1) === 0) {
          this.accum = (this.accum + this.accumRate) & 0xFF; // 偶数ステップで加算(計6回)
        }
      } else {
        this.timer--;
      }
    }
    output() {
      if (!this.enabled) return 0;
      return (this.accum >> 3) & 0x1F; // 上位5bit (0-31)
    }
  }

  class VRC6Audio {
    constructor() {
      this.pulse1 = new Vrc6Pulse();
      this.pulse2 = new Vrc6Pulse();
      this.saw = new Vrc6Saw();
      this.mute = { pulse1: false, pulse2: false, saw: false };
      this.vol = { pulse1: 1, pulse2: 1, saw: 1 };
    }

    reset() {
      this.pulse1 = new Vrc6Pulse();
      this.pulse2 = new Vrc6Pulse();
      this.saw = new Vrc6Saw();
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x9000: this.pulse1.writeCtrl(value); break;
        case 0x9001: this.pulse1.writePeriodLo(value); break;
        case 0x9002: this.pulse1.writePeriodHi(value); break;
        case 0xA000: this.pulse2.writeCtrl(value); break;
        case 0xA001: this.pulse2.writePeriodLo(value); break;
        case 0xA002: this.pulse2.writePeriodHi(value); break;
        case 0xB000: this.saw.writeCtrl(value); break;
        case 0xB001: this.saw.writePeriodLo(value); break;
        case 0xB002: this.saw.writePeriodHi(value); break;
      }
    }

    clock() {
      this.pulse1.clock();
      this.pulse2.clock();
      this.saw.clock();
    }

    // 0.0 ~ 約0.65 (2A03と同程度のレベル感)
    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : (this.pulse1.output() / 15) * this.vol.pulse1;   // 0-1
      const p2 = this.mute.pulse2 ? 0 : (this.pulse2.output() / 15) * this.vol.pulse2;   // 0-1
      const sw = this.mute.saw ? 0 : (this.saw.output() / 31) * this.vol.saw;         // 0-1
      return (p1 + p2 + sw) * 0.2;
    }
  }

  Emu.VRC6Audio = VRC6Audio;
})(globalThis);

/*
 * OPLL (Yamaha YM2413 / Konami VRC VII = DS1001) サイクルアキュレート・エミュレータ
 * MML.Emu.OPLLNuked
 *
 * nukeykt/Nuked-OPLL (opll.c v1.0.2, GPLv2, Copyright (C) 2019-2023 Nuke.YKT) の移植。
 * 音色ROM・アルゴリズムとも siliconpr0n (digshadow, John McMaster) による
 * VRC VII decap / die shot 由来。本リポジトリもGPLv2なのでライセンス上の問題は無い。
 *
 * 従来の emu2413 0.6x系移植(vrc7.js / opllMsx.js)との違い:
 *   - 演算器が1個しか無い実チップの18スロット時分割パイプラインをそのまま再現する。
 *     1サンプル = 18サイクル、各サイクルが1スロットぶんの演算と1chぶんのDAC出力を担う。
 *   - EGは位相蓄積(dphaseARTable等の近似)ではなく、実機のeg_timer + シフト量テーブル方式。
 *     キーオン時のDAMP(rate12まで一旦落としてからアタック)も含む。
 *   - AM/PM LFOがfloat sin近似ではなく実機の整数カウンタ/テーブル。
 *   - 出力は9bit相当の時分割DACをそのまま合算するため、実機特有の量子化感が出る。
 *
 * チップ種別 (constructor の opts.chipType):
 *   'ds1001'(VRC7): 6メロディch、リズムモード無し(rhythm常時0x20)、音色ROM=patch_ds1001。
 *   'ym2413'(FMPAC/VGM、既定): 9メロディch、リズムモード有り、音色ROM=patch_ym2413。
 *
 * クロック: clock() は「呼び出し側のホストクロック1サイクル」ごとに呼ぶ。OPLLの1内部
 * サイクルは実チップのマスタクロック4個ぶんなので、
 *   VRC7 (NSF)      : ホスト=NES CPU 1.789773MHz = マスタ/2 → 2ホストサイクルで1内部サイクル
 *   FMPAC/VGM       : ホスト=3.579545MHz = マスタそのもの   → 4ホストサイクルで1内部サイクル
 * どちらも 18内部サイクル = 1サンプル で 49716Hz になる(36 / 72 ホストサイクル)。
 * ★この非対称はFM-PACのクロック分周と同じ理由。取り違えると1オクターブずれる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ---- EG状態 ----
  const EG_ATTACK = 0, EG_DECAY = 1, EG_SUSTAIN = 2, EG_RELEASE = 3;
  // ---- リズムスロット選択 ----
  const RM_BD0 = 0, RM_HH = 1, RM_TOM = 2, RM_BD1 = 3, RM_SD = 4, RM_TC = 5;
  const PATCH_DRUM_0 = 15; // patchrom内のドラム音色開始index

  const SAMPLE_RATE = 49716;
  const CYCLES_PER_SAMPLE = 18; // OPLL内部サイクル/サンプル

  const LOGSIN = new Uint16Array([
    0x859,0x6c3,0x607,0x58b,0x52e,0x4e4,0x4a6,0x471,0x443,0x41a,0x3f5,0x3d3,0x3b5,0x398,0x37e,
    0x365,0x34e,0x339,0x324,0x311,0x2ff,0x2ed,0x2dc,0x2cd,0x2bd,0x2af,0x2a0,0x293,0x286,0x279,
    0x26d,0x261,0x256,0x24b,0x240,0x236,0x22c,0x222,0x218,0x20f,0x206,0x1fd,0x1f5,0x1ec,0x1e4,
    0x1dc,0x1d4,0x1cd,0x1c5,0x1be,0x1b7,0x1b0,0x1a9,0x1a2,0x19b,0x195,0x18f,0x188,0x182,0x17c,
    0x177,0x171,0x16b,0x166,0x160,0x15b,0x155,0x150,0x14b,0x146,0x141,0x13c,0x137,0x133,0x12e,
    0x129,0x125,0x121,0x11c,0x118,0x114,0x10f,0x10b,0x107,0x103,0x0ff,0x0fb,0x0f8,0x0f4,0x0f0,
    0x0ec,0x0e9,0x0e5,0x0e2,0x0de,0x0db,0x0d7,0x0d4,0x0d1,0x0cd,0x0ca,0x0c7,0x0c4,0x0c1,0x0be,
    0x0bb,0x0b8,0x0b5,0x0b2,0x0af,0x0ac,0x0a9,0x0a7,0x0a4,0x0a1,0x09f,0x09c,0x099,0x097,0x094,
    0x092,0x08f,0x08d,0x08a,0x088,0x086,0x083,0x081,0x07f,0x07d,0x07a,0x078,0x076,0x074,0x072,
    0x070,0x06e,0x06c,0x06a,0x068,0x066,0x064,0x062,0x060,0x05e,0x05c,0x05b,0x059,0x057,0x055,
    0x053,0x052,0x050,0x04e,0x04d,0x04b,0x04a,0x048,0x046,0x045,0x043,0x042,0x040,0x03f,0x03e,
    0x03c,0x03b,0x039,0x038,0x037,0x035,0x034,0x033,0x031,0x030,0x02f,0x02e,0x02d,0x02b,0x02a,
    0x029,0x028,0x027,0x026,0x025,0x024,0x023,0x022,0x021,0x020,0x01f,0x01e,0x01d,0x01c,0x01b,
    0x01a,0x019,0x018,0x017,0x017,0x016,0x015,0x014,0x014,0x013,0x012,0x011,0x011,0x010,0x00f,
    0x00f,0x00e,0x00d,0x00d,0x00c,0x00c,0x00b,0x00a,0x00a,0x009,0x009,0x008,0x008,0x007,0x007,
    0x007,0x006,0x006,0x005,0x005,0x005,0x004,0x004,0x004,0x003,0x003,0x003,0x002,0x002,0x002,
    0x002,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x000,0x000,0x000,0x000,0x000,0x000,0x000,
    0x000
  ]);

  const EXPROM = new Uint16Array([
    0x7fa,0x7f5,0x7ef,0x7ea,0x7e4,0x7df,0x7da,0x7d4,0x7cf,0x7c9,0x7c4,0x7bf,0x7b9,0x7b4,0x7ae,
    0x7a9,0x7a4,0x79f,0x799,0x794,0x78f,0x78a,0x784,0x77f,0x77a,0x775,0x770,0x76a,0x765,0x760,
    0x75b,0x756,0x751,0x74c,0x747,0x742,0x73d,0x738,0x733,0x72e,0x729,0x724,0x71f,0x71a,0x715,
    0x710,0x70b,0x706,0x702,0x6fd,0x6f8,0x6f3,0x6ee,0x6e9,0x6e5,0x6e0,0x6db,0x6d6,0x6d2,0x6cd,
    0x6c8,0x6c4,0x6bf,0x6ba,0x6b5,0x6b1,0x6ac,0x6a8,0x6a3,0x69e,0x69a,0x695,0x691,0x68c,0x688,
    0x683,0x67f,0x67a,0x676,0x671,0x66d,0x668,0x664,0x65f,0x65b,0x657,0x652,0x64e,0x649,0x645,
    0x641,0x63c,0x638,0x634,0x630,0x62b,0x627,0x623,0x61e,0x61a,0x616,0x612,0x60e,0x609,0x605,
    0x601,0x5fd,0x5f9,0x5f5,0x5f0,0x5ec,0x5e8,0x5e4,0x5e0,0x5dc,0x5d8,0x5d4,0x5d0,0x5cc,0x5c8,
    0x5c4,0x5c0,0x5bc,0x5b8,0x5b4,0x5b0,0x5ac,0x5a8,0x5a4,0x5a0,0x59c,0x599,0x595,0x591,0x58d,
    0x589,0x585,0x581,0x57e,0x57a,0x576,0x572,0x56f,0x56b,0x567,0x563,0x560,0x55c,0x558,0x554,
    0x551,0x54d,0x549,0x546,0x542,0x53e,0x53b,0x537,0x534,0x530,0x52c,0x529,0x525,0x522,0x51e,
    0x51b,0x517,0x514,0x510,0x50c,0x509,0x506,0x502,0x4ff,0x4fb,0x4f8,0x4f4,0x4f1,0x4ed,0x4ea,
    0x4e7,0x4e3,0x4e0,0x4dc,0x4d9,0x4d6,0x4d2,0x4cf,0x4cc,0x4c8,0x4c5,0x4c2,0x4be,0x4bb,0x4b8,
    0x4b5,0x4b1,0x4ae,0x4ab,0x4a8,0x4a4,0x4a1,0x49e,0x49b,0x498,0x494,0x491,0x48e,0x48b,0x488,
    0x485,0x482,0x47e,0x47b,0x478,0x475,0x472,0x46f,0x46c,0x469,0x466,0x463,0x460,0x45d,0x45a,
    0x457,0x454,0x451,0x44e,0x44b,0x448,0x445,0x442,0x43f,0x43c,0x439,0x436,0x433,0x430,0x42d,
    0x42a,0x428,0x425,0x422,0x41f,0x41c,0x419,0x416,0x414,0x411,0x40e,0x40b,0x408,0x406,0x403,
    0x400
  ]);

  const CH_OFFSET = new Uint8Array([1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 6, 7, 8, 0]);
  const PG_MULTI = new Uint8Array([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
  const EG_STEPHI = [
    new Uint8Array([0, 0, 0, 0]),
    new Uint8Array([1, 0, 0, 0]),
    new Uint8Array([1, 0, 1, 0]),
    new Uint8Array([1, 1, 1, 0])
  ];
  const EG_KSLTABLE = new Uint8Array([0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64]);

  // PATCH_DS1001
  const PATCH_DS1001 = [
    { tl: 5, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[0,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[14, 8], dr:[ 8, 1], sl:[ 4, 2], rr:[ 2, 7] }, // @1
    { tl:20, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 6], sl:[ 2, 1], rr:[ 3, 2] }, // @2
    { tl: 8, dc:0, dm:1, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,1], multi:[ 1, 1], ksl:[0,0], ar:[15,11], dr:[10, 2], sl:[ 2, 1], rr:[ 0, 2] }, // @3
    { tl:12, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 6, 2], rr:[ 1, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 1, 6], sl:[ 0, 2], rr:[ 1, 8] }, // @5
    { tl: 6, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 2, 1], ksl:[0,0], ar:[10,14], dr:[ 3, 2], sl:[15,15], rr:[ 4, 4] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 1, 7] }, // @7
    { tl:34, dc:1, dm:0, fb:7, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 1], rr:[ 1, 7] }, // @8
    { tl:37, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[1,0], ksr:[1,1], multi:[ 5, 1], ksl:[0,0], ar:[ 4, 7], dr:[ 0, 3], sl:[ 7, 0], rr:[ 2, 1] }, // @9
    { tl:15, dc:0, dm:1, fb:7, am:[1,0], vib:[0,0], et:[1,0], ksr:[1,0], multi:[ 5, 1], ksl:[0,0], ar:[10,10], dr:[ 8, 5], sl:[ 5, 0], rr:[ 1, 2] }, // @10
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @11
    { tl:17, dc:0, dm:0, fb:6, am:[0,0], vib:[1,0], et:[1,1], ksr:[1,0], multi:[ 1, 3], ksl:[0,0], ar:[ 6, 7], dr:[ 5, 4], sl:[ 1, 1], rr:[ 8, 6] }, // @12
    { tl:19, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 2], ksl:[3,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @13
    { tl:12, dc:0, dm:0, fb:0, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 3], ksl:[0,0], ar:[ 9,12], dr:[ 4, 0], sl:[ 3,15], rr:[ 3, 6] }, // @14
    { tl:13, dc:0, dm:0, fb:0, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,1], multi:[ 1, 2], ksl:[0,0], ar:[12,13], dr:[ 1, 5], sl:[ 5, 0], rr:[ 6, 6] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // PATCH_YM2413
  const PATCH_YM2413 = [
    { tl:30, dc:1, dm:0, fb:7, am:[0,0], vib:[1,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[13, 7], dr:[ 0, 8], sl:[ 0, 1], rr:[ 0, 7] }, // @1
    { tl:26, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 7], sl:[ 2, 1], rr:[ 3, 3] }, // @2
    { tl:25, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,12], dr:[ 2, 4], sl:[ 1, 2], rr:[ 1, 3] }, // @3
    { tl:14, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 7, 2], rr:[ 0, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 0, 6], sl:[ 0, 2], rr:[ 0, 8] }, // @5
    { tl:22, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 1, 2], ksl:[0,0], ar:[14, 7], dr:[ 0, 1], sl:[ 0, 1], rr:[ 0, 8] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 0, 7] }, // @7
    { tl:45, dc:1, dm:0, fb:4, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 0], rr:[ 0, 7] }, // @8
    { tl:27, dc:0, dm:0, fb:6, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 6, 6], dr:[ 4, 5], sl:[ 1, 1], rr:[ 0, 7] }, // @9
    { tl:11, dc:1, dm:1, fb:0, am:[0,0], vib:[1,1], et:[0,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8,15], dr:[ 5, 7], sl:[ 7, 0], rr:[ 1, 7] }, // @10
    { tl: 3, dc:1, dm:0, fb:1, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,14], dr:[10, 4], sl:[ 1, 0], rr:[ 0, 4] }, // @11
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @12
    { tl:12, dc:0, dm:0, fb:5, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,1], multi:[ 1, 0], ksl:[0,0], ar:[12,15], dr:[ 2, 5], sl:[ 2, 4], rr:[ 0, 2] }, // @13
    { tl:21, dc:0, dm:0, fb:3, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 1], ksl:[1,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @14
    { tl: 9, dc:0, dm:0, fb:3, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,0], multi:[ 1, 1], ksl:[2,0], ar:[15,14], dr:[ 1, 4], sl:[ 4, 1], rr:[ 0, 3] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // ---- サイクル→チャンネル対応表 ----
  // output_m は ismod=(cycles/3)&1 が0のサイクルだけ「そのchのキャリア出力」を運ぶ。
  // 担当chは CH_OFFSET を演算パイプラインの段数ぶん遡った位置。段数は解析で出すより
  // 実測が確実なので、1chずつ鳴らして output_m が立つサイクルを調べた結果 11 と判明
  // (cycle 0,1,2→ch6,7,8 / 6,7,8→ch0,1,2 / 12,13,14→ch3,4,5)。
  const PIPELINE_DELAY = 11;
  const CARRIER_CH = new Int8Array(18).fill(-1);
  for (let c = 0; c < 18; c++) {
    if (((c / 3) | 0) & 1) continue;          // モジュレータ側のサイクルは出力しない
    CARRIER_CH[c] = CH_OFFSET[(c + PIPELINE_DELAY) % 18];
  }
  // output_r(リズム)も同様に実測(太鼓を1種ずつ鳴らして output_r が立つサイクルを特定)。
  // 各太鼓は1巡で2回ぶん出力される(実機の時分割DACがリズムchを2回読むため。旧コアには
  // 無かった挙動で、リズムがメロディに対して相対的に大きく出るのはこれが理由)。
  //   BD:cycle 0,5 / SD:1,9 / CYM:2,10 / HH:3,16 / TOM:4,17
  // 鍵盤のミュート枠は旧コア(opllMsx.js)と同じく BD=ch6 / HH,SD=ch7 / TOM,CYM=ch8。
  // ★2026-08-22: 打楽器のミュート/音量は実チャンネル(6-8)ではなく専用の添字9-13を使う。
  // SDとHHは実機では同じch7、TOMとCYMは同じch8だが、鍵盤には5行が別々に出るため
  // 実ch単位だと2行が同じ添字を共有し、getMuteConfig()の書き込み順で片方が無視される。
  // ここは出力サイクルで打楽器を識別できるので5種を独立させられる(keyboard.js KF_RHYTHM_INDEX)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14; // 0-8=メロディch / 9-13=BD,SD,TOM,CYM,HH
  const RHYTHM_CH = new Int8Array(18).fill(-1);
  RHYTHM_CH[0] = MUTE_BD;  RHYTHM_CH[5] = MUTE_BD;       // BD
  RHYTHM_CH[1] = MUTE_SD;  RHYTHM_CH[9] = MUTE_SD;       // SD
  RHYTHM_CH[3] = MUTE_HH;  RHYTHM_CH[16] = MUTE_HH;      // HH
  RHYTHM_CH[4] = MUTE_TOM; RHYTHM_CH[17] = MUTE_TOM;     // TOM
  RHYTHM_CH[2] = MUTE_CYM; RHYTHM_CH[10] = MUTE_CYM;     // CYM

  // ---- eg_level[] のスロット番号 ↔ (ch, mod/car) 対応 ----
  // eg_level は「サイクル番号=スロット番号」で索かれ、そのスロットの担当は
  // ch=CH_OFFSET[c] / mcsel=((c+1)/3)&1 (1がキャリア)。鍵盤スナップショット用に逆引きを作る。
  const SLOT_MOD = new Int8Array(9).fill(-1);
  const SLOT_CAR = new Int8Array(9).fill(-1);
  for (let c = 0; c < 18; c++) {
    const ch = CH_OFFSET[c];
    if (((((c + 1) / 3) | 0) & 1) === 1) SLOT_CAR[ch] = c; else SLOT_MOD[ch] = c;
  }

  // 打楽器5種が使う eg_level のスロット番号(bd,sd,tom,cym,hh)。実測で確認済み
  // (1種ずつ鳴らして下がるスロットを特定: BD=11と14, SD=15, TOM=13, CYM=16, HH=12)。
  const RHYTHM_SLOT = [SLOT_CAR[6], SLOT_CAR[7], SLOT_MOD[8], SLOT_CAR[8], SLOT_MOD[7]];

  const s8 = (v) => (v << 24) >> 24; // int8_t への切り詰め(rm_enableの算術右シフト用)

  function newPatch() {
    return {
      tl: 0, dc: 0, dm: 0, fb: 0,
      am: [0, 0], vib: [0, 0], et: [0, 0], ksr: [0, 0],
      multi: [0, 0], ksl: [0, 0], ar: [0, 0], dr: [0, 0], sl: [0, 0], rr: [0, 0]
    };
  }

  class OPLLNuked {
    constructor(opts) {
      opts = opts || {};
      this.chipType = (opts.chipType === 'ds1001') ? 'ds1001' : 'ym2413';
      this.isDs1001 = this.chipType === 'ds1001';
      this.patchrom = this.isDs1001 ? PATCH_DS1001 : PATCH_YM2413;
      this.numCh = this.isDs1001 ? 6 : 9;
      // ホストクロック→内部サイクルの分周(冒頭コメント参照)
      this.hostPerOpll = opts.hostCyclesPerOpllCycle || (this.isDs1001 ? 2 : 4);
      // 0-8=メロディch / 9-13=リズム(BD,SD,TOM,CYM,HH)。RHYTHM_CH のコメント参照
      this.mute = new Array(NUM_MUTE_SLOTS).fill(false);
      this.vol = new Array(NUM_MUTE_SLOTS).fill(1);
      this._alloc();
      this.reset();
    }

    _alloc() {
      this.eg_state = new Uint8Array(18);
      this.eg_level = new Uint8Array(18);
      this.pg_phase = new Uint32Array(18);
      this.op_fb1 = new Int16Array(9);
      this.op_fb2 = new Int16Array(9);
      this.fnum = new Uint16Array(9);
      this.block = new Uint8Array(9);
      this.kon = new Uint8Array(9);
      this.son = new Uint8Array(9);
      this.regVol = new Uint8Array(9);
      this.inst = new Uint8Array(9);
      this.patch = newPatch();
      this.regShadow = new Uint8Array(0x40); // $00-$3F の素の値(スナップショット/デバッグ用)
      this._rhythmPeak = new Uint8Array(5); // 打楽器のピークホールド(_rhythmSlotInfo参照)
      this.writebuf = [];
      this.writeHead = 0; // shift()を使わないための取り出し位置
    }

    reset() {
      this.cycles = 0; this.slot = 0;
      this.write_data = 0; this.write_a = 0; this.write_d = 0;
      this.write_a_en = 0; this.write_d_en = 0;
      this.write_fm_address = 0; this.write_fm_data = 0; this.write_mode_address = 0;
      this.address = 0; this.data = 0;

      this.eg_counter_state = 0; this.eg_counter_state_prev = 0;
      this.eg_timer = 0; this.eg_timer_low_lock = 0; this.eg_timer_carry = 0;
      this.eg_timer_shift = 0; this.eg_timer_shift_lock = 0; this.eg_timer_shift_stop = 0;
      this.eg_kon = 0; this.eg_dokon = 0; this.eg_off = 0;
      this.eg_rate = 0; this.eg_maxrate = 0; this.eg_zerorate = 0;
      this.eg_inc_lo = 0; this.eg_inc_hi = 0; this.eg_rate_hi = 0;
      this.eg_sl = 0; this.eg_ksltl = 0; this.eg_out = 0x7f; this.eg_silent = 0;

      this.pg_fnum = 0; this.pg_block = 0; this.pg_out = 0; this.pg_inc = 0; this.pg_phase_next = 0;

      this.op_fbsum = 0; this.op_mod = 0; this.op_neg = 0;
      this.op_logsin = 0; this.op_exp_m = 0; this.op_exp_s = 0;

      this.ch_out = 0; this.ch_out_hh = 0; this.ch_out_tm = 0;
      this.ch_out_bd = 0; this.ch_out_sd = 0; this.ch_out_tc = 0;

      this.lfo_counter = 0; this.lfo_vib_counter = 0; this.lfo_am_counter = 0;
      this.lfo_am_step = 0; this.lfo_am_dir = 0; this.lfo_am_car = 0; this.lfo_am_out = 0;

      this.rhythm = 0; this.testmode = 0;
      this.c_instr = 0; this.c_op = 0; this.c_tl = 0; this.c_dc = 0; this.c_dm = 0; this.c_fb = 0;
      this.c_am = 0; this.c_vib = 0; this.c_et = 0; this.c_ksr = 0;
      this.c_ksr_freq = 0; this.c_ksl_freq = 0; this.c_ksl_block = 0;
      this.c_multi = 0; this.c_ksl = 0;
      this.c_adrr = [0, 0, 0];
      this.c_sl = 0; this.c_fnum = 0; this.c_block = 0;

      this.rm_enable = 0; this.rm_noise = 0; this.rm_select = RM_TC + 1;
      this.rm_hh_bit2 = 0; this.rm_hh_bit3 = 0; this.rm_hh_bit7 = 0; this.rm_hh_bit8 = 0;
      this.rm_tc_bit3 = 0; this.rm_tc_bit5 = 0;

      this.output_m = 0; this.output_r = 0;

      this.eg_state.fill(EG_RELEASE);
      this.eg_level.fill(0x7f);
      this._rhythmPeak.fill(0x7f);
      this.pg_phase.fill(0);
      this.op_fb1.fill(0); this.op_fb2.fill(0);
      this.fnum.fill(0); this.block.fill(0); this.kon.fill(0); this.son.fill(0);
      this.regVol.fill(0); this.inst.fill(0);
      this.regShadow.fill(0);
      const p = this.patch;
      p.tl = p.dc = p.dm = p.fb = 0;
      for (let i = 0; i < 2; i++) {
        p.am[i] = p.vib[i] = p.et[i] = p.ksr[i] = 0;
        p.multi[i] = p.ksl[i] = p.ar[i] = p.dr[i] = p.sl[i] = p.rr[i] = 0;
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      this._addrLatch = 0;
      this._writePhase = 0;

      if (this.isDs1001) { // VRC7はリズムモードが常時ON扱い
        this.rhythm = 0x20;
        this.rm_enable = s8(0x80);
      }

      this.hostAccum = 0;
      this.sampleAccum = 0;
      this.sampleCycles = 0;
      this.lastSample = 0;
      this.dcX = 0; this.dcY = 0; this.dcPrimed = 0;
    }

    // ────────── OPLL_DoIO ──────────
    _doIO() {
      this.write_a_en = ((this.write_a & 0x03) === 0x01) ? 1 : 0;
      this.write_d_en = ((this.write_d & 0x03) === 0x01) ? 1 : 0;
      this.write_a = (this.write_a << 1) & 0xff;
      this.write_d = (this.write_d << 1) & 0xff;
    }

    // ────────── OPLL_DoModeWrite ──────────
    _doModeWrite() {
      if (!((this.write_mode_address & 0x10) && this.write_d_en)) return;
      const slot = this.write_mode_address & 0x01;
      const d = this.write_data;
      const p = this.patch;
      switch (this.write_mode_address & 0x0f) {
        case 0x00: case 0x01:
          p.multi[slot] = d & 0x0f;
          p.ksr[slot] = (d >> 4) & 0x01;
          p.et[slot] = (d >> 5) & 0x01;
          p.vib[slot] = (d >> 6) & 0x01;
          p.am[slot] = (d >> 7) & 0x01;
          break;
        case 0x02: p.ksl[0] = (d >> 6) & 0x03; p.tl = d & 0x3f; break;
        case 0x03:
          p.ksl[1] = (d >> 6) & 0x03;
          p.dc = (d >> 4) & 0x01; p.dm = (d >> 3) & 0x01; p.fb = d & 0x07;
          break;
        case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
        case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        case 0x0e:
          this.rhythm = d & 0x3f;
          if (this.isDs1001) this.rhythm |= 0x20;
          this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
          break;
        case 0x0f: this.testmode = d & 0x0f; break;
      }
    }

    // ────────── OPLL_DoRegWrite ──────────
    _doRegWrite() {
      if (this.write_a_en) {
        if ((this.write_data & 0xc0) === 0x00) {
          this.write_fm_address = 1;
          this.address = this.write_data;
        } else {
          this.write_fm_address = 0;
        }
      }
      if (this.write_fm_address && this.write_d_en) this.data = this.write_data;

      if (this.write_fm_data && !this.write_a_en) {
        if ((this.address & 0x0f) === this.cycles && this.cycles < 16) {
          const channel = this.cycles % 9;
          switch (this.address & 0xf0) {
            case 0x10:
              this.fnum[channel] = (this.fnum[channel] & 0x100) | this.data;
              break;
            case 0x20:
              this.fnum[channel] = (this.fnum[channel] & 0xff) | ((this.data & 0x01) << 8);
              this.block[channel] = (this.data >> 1) & 0x07;
              this.kon[channel] = (this.data >> 4) & 0x01;
              this.son[channel] = (this.data >> 5) & 0x01;
              break;
            case 0x30:
              this.regVol[channel] = this.data & 0x0f;
              this.inst[channel] = (this.data >> 4) & 0x0f;
              break;
          }
        }
      }

      if (this.write_a_en) this.write_fm_data = 0;
      if (this.write_fm_address && this.write_d_en) this.write_fm_data = 1;
      if (this.write_a_en) {
        this.write_mode_address = ((this.write_data & 0xf0) === 0x00)
          ? (0x10 | (this.write_data & 0x0f)) : 0x00;
      }
    }

    // ────────── OPLL_PreparePatch1 / 2 ──────────
    _selectPatch(mcsel) {
      const ch = CH_OFFSET[this.cycles];
      const instr = this.inst[ch];
      if (this.rm_select <= RM_TC) return this.patchrom[PATCH_DRUM_0 + this.rm_select];
      if (instr > 0) return this.patchrom[instr - 1];
      return this.patch;
    }

    _preparePatch1() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      if (this.rm_select === RM_HH || this.rm_select === RM_TOM) this.c_tl = this.inst[ch] << 2;
      else if (mcsel === 1) this.c_tl = this.regVol[ch] << 2;
      else this.c_tl = patch.tl;

      this.c_adrr[0] = patch.ar[mcsel];
      this.c_adrr[1] = patch.dr[mcsel];
      this.c_adrr[2] = patch.rr[mcsel];
      this.c_et = patch.et[mcsel];
      this.c_ksr = patch.ksr[mcsel];
      this.c_ksl = patch.ksl[mcsel];
      this.c_ksr_freq = (this.block[ch] << 1) | (this.fnum[ch] >> 8);
      this.c_ksl_freq = this.fnum[ch] >> 5;
      this.c_ksl_block = this.block[ch];
    }

    _preparePatch2() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      this.c_fnum = this.fnum[ch];
      this.c_block = this.block[ch];
      this.c_multi = patch.multi[mcsel];
      this.c_sl = patch.sl[mcsel];
      this.c_fb = patch.fb;
      this.c_vib = patch.vib[mcsel];
      this.c_am = patch.am[mcsel];
      this.c_dc = ((this.c_dc << 1) | patch.dc) & 0xff;
      this.c_dm = ((this.c_dm << 1) | patch.dm) & 0xff;
    }

    // ────────── OPLL_PhaseGenerate ──────────
    _phaseGenerate() {
      this.pg_phase[(this.cycles + 17) % 18] = (this.pg_phase_next + this.pg_inc) >>> 0;

      let ismod;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod = 0;
      else ismod = (((this.cycles + 3) / 3) | 0) & 1;

      const phase = this.pg_phase[this.cycles];
      if ((this.testmode & 0x04)
        || (ismod && (this.eg_dokon & 0x8000)) || (!ismod && (this.eg_dokon & 0x01))) {
        this.pg_phase_next = 0;
      } else {
        this.pg_phase_next = phase;
      }

      if (this.cycles === 13) {
        this.rm_hh_bit2 = (phase >>> (2 + 9)) & 1;
        this.rm_hh_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_hh_bit7 = (phase >>> (7 + 9)) & 1;
        this.rm_hh_bit8 = (phase >>> (8 + 9)) & 1;
      } else if (this.cycles === 17 && (this.rm_enable & 0x80)) {
        this.rm_tc_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_tc_bit5 = (phase >>> (5 + 9)) & 1;
      }

      let pg_out;
      if (this.rm_enable & 0x80) {
        let rm_bit;
        switch (this.cycles) {
          case 13: // HH
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = rm_bit << 9;
            pg_out |= (rm_bit ^ (this.rm_noise & 1)) ? 0xd0 : 0x34;
            break;
          case 16: // SD
            pg_out = (this.rm_hh_bit8 << 9)
                   | ((this.rm_hh_bit8 ^ (this.rm_noise & 1)) << 8);
            break;
          case 17: // TC
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = (rm_bit << 9) | 0x100;
            break;
          default:
            pg_out = phase >>> 9;
        }
      } else {
        pg_out = phase >>> 9;
      }
      this.pg_out = pg_out & 0xffff;
    }

    // ────────── OPLL_PhaseCalcIncrement ──────────
    _phaseCalcIncrement() {
      let freq = this.c_fnum << 1;
      const block = this.c_block;
      if (this.c_vib) {
        switch (this.lfo_vib_counter) {
          case 0: case 4: break;
          case 1: case 3: freq += freq >> 8; break;
          case 2: freq += freq >> 7; break;
          case 5: case 7: freq -= freq >> 8; break;
          case 6: freq -= freq >> 7; break;
        }
      }
      freq = (freq << block) >> 1;
      this.pg_inc = (freq * PG_MULTI[this.c_multi]) >>> 1;
    }

    // ────────── OPLL_EnvelopeKSLTL ──────────
    _envelopeKSLTL() {
      let ksl = EG_KSLTABLE[this.c_ksl_freq] - ((8 - this.c_ksl_block) << 3);
      if (ksl < 0) ksl = 0;
      ksl <<= 1;
      ksl = this.c_ksl ? (ksl >> (3 - this.c_ksl)) : 0;
      this.eg_ksltl = ksl + (this.c_tl << 1);
    }

    // ────────── OPLL_EnvelopeOutput ──────────
    _envelopeOutput() {
      let level = this.eg_level[(this.cycles + 17) % 18];
      level += this.eg_ksltl;
      if (this.c_am) level += this.lfo_am_out;
      if (level >= 128) level = 127;
      if (this.testmode & 0x01) level = 0;
      this.eg_out = level;
    }

    // ────────── OPLL_EnvelopeGenerate ──────────
    _envelopeGenerate() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;

      // --- EGタイマ ---
      let timer_inc;
      if ((this.eg_counter_state & 3) !== 3) timer_inc = 0;
      else if (this.cycles === 0) timer_inc = 1;
      else timer_inc = this.eg_timer_carry;

      const timer_low = this.eg_timer & 3;
      let timer_bit = (this.eg_timer & 1) + timer_inc;
      this.eg_timer_carry = timer_bit >> 1;
      this.eg_timer = (((timer_bit & 1) << 17) | (this.eg_timer >>> 1)) >>> 0;
      if (this.testmode & 0x08) {
        this.eg_timer &= 0x2ffff;
        this.eg_timer |= (this.write_data << (16 - 2)) & 0x10000;
      }
      if (!this.eg_timer_shift_stop && ((this.eg_timer >>> 16) & 1)) {
        this.eg_timer_shift = this.cycles;
      }
      if (this.cycles === 0 && (this.eg_counter_state_prev & 1) === 1) {
        this.eg_timer_low_lock = timer_low;
        this.eg_timer_shift_lock = this.eg_timer_shift;
        if (this.eg_timer_shift_lock > 13) this.eg_timer_shift_lock = 0;
        this.eg_timer_shift = 0;
      }
      this.eg_timer_shift_stop |= (this.eg_timer >>> 16) & 1;
      if (this.cycles === 0) this.eg_timer_shift_stop = 0;
      this.eg_counter_state_prev = this.eg_counter_state;
      if (this.cycles === 17) this.eg_counter_state = (this.eg_counter_state + 1) & 0xff;

      // --- レベル更新 ---
      const idx = (this.cycles + 16) % 18;
      const level = this.eg_level[idx];
      let next_level = level;
      const zero = (level === 0);
      this.eg_silent = (level === 0x7f) ? 1 : 0;

      if (this.eg_state[idx] !== EG_ATTACK && (this.eg_off & 2) && !(this.eg_dokon & 2)) {
        next_level = 0x7f;
      }
      if (this.eg_maxrate && (this.eg_dokon & 2)) next_level = 0x00;

      const state = this.eg_state[idx];
      let next_state = EG_ATTACK;
      let step = 0;
      const sl = this.eg_sl;

      switch (state) {
        case EG_ATTACK:
          if (!this.eg_maxrate && (this.eg_kon & 2) && !zero) {
            const shift = (this.eg_rate_hi < 12) ? this.eg_inc_lo : (this.eg_rate_hi - 11 + this.eg_inc_hi);
            if (shift > 0) step = (~level) >> (5 - shift);
          }
          next_state = zero ? EG_DECAY : EG_ATTACK;
          break;
        case EG_DECAY:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2) && (level >> 3) !== sl) {
            step = this._egStep();
          }
          next_state = ((level >> 3) === sl) ? EG_SUSTAIN : EG_DECAY;
          break;
        case EG_SUSTAIN:
        case EG_RELEASE:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2)) step = this._egStep();
          next_state = state;
          break;
      }

      if (!(this.eg_kon & 2)) next_state = EG_RELEASE;
      if (this.eg_dokon & 2) next_state = EG_ATTACK;

      this.eg_level[idx] = (next_level + step) & 0xff;
      this.eg_state[idx] = next_state;

      // --- 次サイクルぶんのレート計算 ---
      const rate_hi = this.eg_rate >> 2;
      const rate_lo = this.eg_rate & 3;
      this.eg_inc_hi = EG_STEPHI[rate_lo][this.eg_timer_low_lock];
      const sum = (this.eg_timer_shift_lock + rate_hi) & 0x0f;
      this.eg_inc_lo = 0;
      if (rate_hi < 12 && !this.eg_zerorate) {
        switch (sum) {
          case 12: this.eg_inc_lo = 1; break;
          case 13: this.eg_inc_lo = (rate_lo >> 1) & 1; break;
          case 14: this.eg_inc_lo = rate_lo & 1; break;
        }
      }
      this.eg_maxrate = (rate_hi === 0x0f) ? 1 : 0;
      this.eg_rate_hi = rate_hi;

      this.eg_kon = ((this.eg_kon << 1) | this.kon[CH_OFFSET[this.cycles]]) & 0xff;
      this.eg_off = ((this.eg_off << 1) | (((this.eg_level[this.cycles] >> 2) === 0x1f) ? 1 : 0)) & 0xff;

      switch (this.rm_select) {
        case RM_BD0: case RM_BD1: this.eg_kon |= (this.rhythm >> 4) & 1; break;
        case RM_SD:  this.eg_kon |= (this.rhythm >> 3) & 1; break;
        case RM_TOM: this.eg_kon |= (this.rhythm >> 2) & 1; break;
        case RM_TC:  this.eg_kon |= (this.rhythm >> 1) & 1; break;
        case RM_HH:  this.eg_kon |= this.rhythm & 1; break;
      }

      let rate = 0;
      this.eg_dokon = (this.eg_dokon << 1) & 0xffff;
      let state_rate = this.eg_state[this.cycles];
      if (state_rate === EG_RELEASE && (this.eg_kon & 1) && (this.eg_off & 1)) {
        state_rate = EG_ATTACK;
        this.eg_dokon |= 1;
      }
      switch (state_rate) {
        case EG_ATTACK: rate = this.c_adrr[0]; break;
        case EG_DECAY: rate = this.c_adrr[1]; break;
        case EG_SUSTAIN: if (!this.c_et) rate = this.c_adrr[2]; break;
        case EG_RELEASE: rate = this.son[CH_OFFSET[this.cycles]] ? 5 : this.c_adrr[2]; break;
      }
      if (!(this.eg_kon & 1) && !mcsel && this.rm_select !== RM_TOM && this.rm_select !== RM_HH) rate = 0;
      if ((this.eg_kon & 1) && this.eg_state[this.cycles] === EG_RELEASE && !(this.eg_off & 1)) rate = 12;
      if (!(this.eg_kon & 1) && !this.son[CH_OFFSET[this.cycles]] && mcsel === 1 && !this.c_et) rate = 7;

      this.eg_zerorate = (rate === 0) ? 1 : 0;
      let ksr = this.c_ksr_freq;
      if (!this.c_ksr) ksr >>= 2;
      this.eg_rate = (rate << 2) + ksr;
      if (this.eg_rate & 0x40) this.eg_rate = 0x3c | (ksr & 3);
      this.eg_sl = this.c_sl;
    }

    // DECAY/SUSTAIN/RELEASE共通の増分(opll.cで同じ式が2箇所に展開されているもの)
    _egStep() {
      const rh = this.eg_rate_hi, ih = this.eg_inc_hi, il = this.eg_inc_lo;
      const cs = this.eg_counter_state_prev;
      const i0 = (rh === 15 || (rh === 14 && ih)) ? 1 : 0;
      const i1 = ((rh === 14 && !ih) || (rh === 13 && ih)
        || (rh === 13 && !ih && (cs & 1))
        || (rh === 12 && ih && (cs & 1))
        || (rh === 12 && !ih && ((cs & 3) === 3))
        || (il && ((cs & 3) === 3))) ? 1 : 0;
      return (i0 << 1) | i1;
    }

    // ────────── OPLL_Channel ──────────
    _channel() {
      let ch_out = this.ch_out;
      const ismod = ((this.cycles / 3) | 0) & 1;
      const mute_m = ismod || ((this.rm_enable & 0x40) && (this.cycles + 15) % 18 >= 12);

      if (this.isDs1001) {
        this.output_m = ch_out;
        if (this.output_m >= 0) this.output_m++;
        if (mute_m) this.output_m = 0;
        this.output_r = 0;
      } else {
        let mute_r = 1;
        if (this.rm_enable & 0x40) {
          switch (this.cycles) {
            case 16: case 17: case 0: case 1: case 2:
            case 3: case 4: case 5: case 9: case 10:
              mute_r = 0; break;
          }
        }
        const sign0 = ch_out >> 8;
        let sign = sign0;
        if (ch_out >= 0) { ch_out++; sign++; }
        this.output_m = mute_m ? sign : ch_out;
        this.output_r = mute_r ? sign : ch_out;
      }

      // ── ch別ミュート/音量(実機には無い機能) ──
      // output_m / output_r は最終DAC出力なので、ここで倍率を掛けても合成には一切影響しない。
      const cm = CARRIER_CH[this.cycles];
      if (cm >= 0) {
        if (this.mute[cm]) this.output_m = 0;
        else if (this.vol[cm] !== 1) this.output_m = this.output_m * this.vol[cm];
      }
      const cr = RHYTHM_CH[this.cycles];
      if (cr >= 0 && this.output_r !== 0) {
        if (this.mute[cr]) this.output_r = 0;
        else if (this.vol[cr] !== 1) this.output_r = this.output_r * this.vol[cr];
      }
    }

    // ────────── OPLL_Operator ──────────
    _operator() {
      let ismod1, ismod2, ismod3;
      if ((this.rm_enable & 0x80) && (this.cycles === 15 || this.cycles === 16)) ismod1 = 0;
      else ismod1 = (((this.cycles + 1) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod2 = 0;
      else ismod2 = (((this.cycles + 3) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 16 || this.cycles === 17)) ismod3 = 0;
      else ismod3 = ((this.cycles / 3) | 0) & 1;

      let op_mod = 0;
      if (ismod3) op_mod |= this.op_mod << 1;
      if (ismod2 && this.c_fb) op_mod |= this.op_fbsum >> (7 - this.c_fb);

      let exp_shift = this.op_exp_s;
      if (this.eg_silent || ((this.op_neg & 2) && (ismod1 ? (this.c_dm & 4) : (this.c_dc & 4)))) {
        exp_shift |= 12;
      }

      let output = this.op_exp_m >> exp_shift;
      if (!this.eg_silent && (this.op_neg & 2)) output = ~output;

      let level = this.op_logsin + (this.eg_out << 4);
      if (level >= 4096) level = 4095;
      this.op_exp_m = EXPROM[level & 0xff];
      this.op_exp_s = level >> 8;

      let phase = (op_mod + this.pg_out) & 0x3ff;
      if (phase & 0x100) phase ^= 0xff;
      this.op_logsin = LOGSIN[phase & 0xff];
      this.op_neg = ((this.op_neg << 1) | (phase >> 9)) & 0xff;
      this.op_fbsum = (this.op_fb1[(this.cycles + 3) % 9] + this.op_fb2[(this.cycles + 3) % 9]) >> 1;

      if (ismod1) {
        this.op_fb2[this.cycles % 9] = this.op_fb1[this.cycles % 9];
        this.op_fb1[this.cycles % 9] = output;
      }
      this.op_mod = output & 0x1ff;

      let routput = 0;
      if (!this.isDs1001) {
        switch (this.cycles) {
          case 2: routput = this.ch_out_hh; break;
          case 3: routput = this.ch_out_tm; break;
          case 4: routput = this.ch_out_bd; break;
          case 8: routput = this.ch_out_sd; break;
          case 9: routput = this.ch_out_tc; break;
        }
        switch (this.cycles) {
          case 15: this.ch_out_hh = output >> 3; break;
          case 16: this.ch_out_tm = output >> 3; break;
          case 17: this.ch_out_bd = output >> 3; break;
          case 0: this.ch_out_sd = output >> 3; break;
          case 1: this.ch_out_tc = output >> 3; break;
        }
      }
      if (!(this.rm_enable & 0x80)) routput = 0;

      this.ch_out = ismod1 ? routput : (output >> 3);
    }

    // ────────── OPLL_DoRhythm / OPLL_DoLFO ──────────
    _doRhythm() {
      let nbit = (this.rm_noise ^ (this.rm_noise >>> 14)) & 0x01;
      nbit |= ((this.rm_noise === 0x00) ? 1 : 0) | ((this.testmode >> 1) & 0x01);
      this.rm_noise = ((nbit << 22) | (this.rm_noise >>> 1)) >>> 0;
    }

    _doLFO() {
      let am_inc = 0;
      if (this.cycles === 17) {
        let vib_step = (((this.lfo_counter & 0x3ff) + 1) >> 10);
        this.lfo_am_step = ((this.lfo_counter & 0x3f) + 1) >> 6;
        vib_step |= (this.testmode >> 3) & 0x01;
        this.lfo_vib_counter = (this.lfo_vib_counter + vib_step) & 0x07;
        this.lfo_counter = (this.lfo_counter + 1) & 0xffff;
      }
      if ((this.lfo_am_step || (this.testmode & 0x08)) && this.cycles < 9) {
        am_inc = this.lfo_am_dir | ((this.cycles === 0) ? 1 : 0);
      }
      if (this.cycles >= 9) this.lfo_am_car = 0;
      if (this.cycles === 0) {
        if (this.lfo_am_dir && (this.lfo_am_counter & 0x7f) === 0) this.lfo_am_dir = 0;
        else if (!this.lfo_am_dir && (this.lfo_am_counter & 0x69) === 0x69) this.lfo_am_dir = 1;
      }
      let am_bit = (this.lfo_am_counter & 0x01) + am_inc + this.lfo_am_car;
      this.lfo_am_car = am_bit >> 1;
      am_bit &= 0x01;
      this.lfo_am_counter = ((am_bit << 8) | (this.lfo_am_counter >>> 1)) & 0x1ff;

      if (this.testmode & 0x02) {
        this.lfo_vib_counter = 0;
        this.lfo_counter = 0;
        this.lfo_am_dir = 0;
        this.lfo_am_counter &= 0xff;
      }
    }

    // ────────── OPLL_Clock 1回ぶん ──────────
    _stepOpll() {
      // buffer[0]/[1] 相当。前サイクルの OPLL_Channel が確定させた値を取り込む
      this.sampleAccum += this.output_m + this.output_r;

      if (this.cycles === 0) this.lfo_am_out = (this.lfo_am_counter >> 3) & 0x0f;
      this.rm_enable = s8(this.rm_enable) >> 1;
      this._doModeWrite();
      this.rm_select++;
      if (this.rm_select > RM_TC) this.rm_select = RM_TC + 1;
      if (this.cycles === 11 && (this.rm_enable & 0x80) === 0x80) this.rm_select = RM_BD0;

      this._preparePatch1();
      this._channel();
      this._phaseGenerate();
      this._operator();
      this._phaseCalcIncrement();
      this._envelopeOutput();
      this._envelopeKSLTL();
      this._envelopeGenerate();
      this._doLFO();
      this._doRhythm();
      this._preparePatch2();
      this._doRegWrite();
      this._doIO();

      this.cycles = (this.cycles + 1) % 18;

      if (++this.sampleCycles >= CYCLES_PER_SAMPLE) {
        this.sampleCycles = 0;
        // 打楽器のピークホールド更新(1サンプルごとで十分。減衰は最短でも数千サンプル続く)
        for (let i = 0; i < 5; i++) {
          const lv = this.eg_level[RHYTHM_SLOT[i]];
          if (lv < this._rhythmPeak[i]) this._rhythmPeak[i] = lv;
        }
        // 実チップの時分割DACは無音時も基準レベル(OPLL_Channelのsign)を出し続けるため
        // 出力にDC成分が乗る。実機ではAC結合で落ちるぶんなので1次ハイパスで除去する。
        // カットオフ約5Hz。HESのDDAで踏んだ教訓から、立ち上がりのオーバー
        // シュートを避けるため十分低く取っている。
        const x = this.sampleAccum;
        if (this.dcPrimed === 0) { this.dcX = x; this.dcPrimed = 1; } // 初回は段差を作らない
        this.dcY = x - this.dcX + DC_BLOCK_R * this.dcY;
        this.dcX = x;
        this.lastSample = this.dcY;
        this.sampleAccum = 0;
      }
    }

    // ────────── 書き込み ──────────
    // アドレス/データは実機同様「別々のタイミング」で入らないと取りこぼす(write_dataが共用の
    // 1バイトラッチのため)。バス経由(nsfBus/kssBus)は元々CPUサイクルが空くので問題ないが、
    // writeReg()のような即時2連書きのために最小間隔を空けるキューを通す。
    // ★キューの単位は「レジスタ書き込み1件(アドレス+データの対)」。エントリ形式は
    // reg | (data << 8)。実チップは2フェーズ(アドレスポート→データポート)だが、
    // **キュー上で対を分割してはいけない**。
    // 以前はアドレスとデータを別エントリにしていたため、「アドレスだけ先に取り出されて
    // パイプラインへ入り、データがまだキューに居るときに溢れて _drainDirect() が走る」と
    // 宙に浮いたアドレスが捨てられ、直後のデータが**アドレス無しのデータ書き込み**として
    // パイプラインに入り、そのレジスタ書き込みが丸ごと消えていた。
    // (Illusion City KSS 1曲目で実測: カスタム音色の $00 が一度も適用されず multi[0] が
    //  0 のままになり、@0 を多用する FM2/FM4 の音色が変わっていた。VGMは書き込み密度が
    //  低くて溢れないため無傷で、同じ曲なのに KSS と VGM で聞こえ方が違う原因だった)
    _pushWrite(reg, data) {
      this.writebuf.push((reg & 0x3f) | ((data & 0xff) << 8));
      // ★clock()を呼ばずに書き込みだけ流し込む経路(無音先読みスキャンの早送り
      // stream-player.js/_resetScan、kss-stream-player.js/_resetScan など)への保険。
      // 実チップ相当のウェイト間隔でしか掃けないキューに数十万件積まれると、
      // shift()がO(n)化して主スレッドごと焼き付く。上限を超えたらパイプラインを
      // 介さずレジスタへ直接反映する(そもそもclock()が無い=時間が進まない経路なので
      // サイクル精度に意味が無く、旧コアの「即時反映」と同じ挙動になる)。
      if (this.writebuf.length - this.writeHead > WRITE_QUEUE_MAX) this._drainDirect();
    }

    /** 溜まった書き込みをパイプラインを介さずレジスタへ直接反映してキューを空にする */
    _drainDirect() {
      for (let i = this.writeHead; i < this.writebuf.length; i++) {
        const w = this.writebuf[i];
        this._applyRegDirect(w & 0x3f, (w >> 8) & 0xff);
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      // 対の途中(アドレスだけ出した状態)なら先頭から出し直す。宙に浮いたアドレスは
      // 次の対が自分のアドレスを出し直すので害が無い。
      this._writePhase = 0;
    }

    /** レジスタ1本を即時反映(_doModeWrite / _doRegWrite と同じデコード) */
    _applyRegDirect(reg, d) {
      reg &= 0x3f; d &= 0xff;
      const p = this.patch;
      if (reg <= 0x07) {
        const slot = reg & 0x01;
        switch (reg) {
          case 0x00: case 0x01:
            p.multi[slot] = d & 0x0f; p.ksr[slot] = (d >> 4) & 1;
            p.et[slot] = (d >> 5) & 1; p.vib[slot] = (d >> 6) & 1; p.am[slot] = (d >> 7) & 1;
            break;
          case 0x02: p.ksl[0] = (d >> 6) & 3; p.tl = d & 0x3f; break;
          case 0x03: p.ksl[1] = (d >> 6) & 3; p.dc = (d >> 4) & 1; p.dm = (d >> 3) & 1; p.fb = d & 7; break;
          case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
          case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        }
        return;
      }
      if (reg === 0x0e) {
        this.rhythm = d & 0x3f;
        if (this.isDs1001) this.rhythm |= 0x20;
        this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
        return;
      }
      if (reg === 0x0f) { this.testmode = d & 0x0f; return; }
      const ch = reg & 0x0f;
      if (ch > 8) return;
      switch (reg & 0xf0) {
        case 0x10: this.fnum[ch] = (this.fnum[ch] & 0x100) | d; break;
        case 0x20:
          this.fnum[ch] = (this.fnum[ch] & 0xff) | ((d & 1) << 8);
          this.block[ch] = (d >> 1) & 7;
          this.kon[ch] = (d >> 4) & 1;
          this.son[ch] = (d >> 5) & 1;
          break;
        case 0x30: this.regVol[ch] = d & 0x0f; this.inst[ch] = (d >> 4) & 0x0f; break;
      }
    }

    // 先頭の1件を実チップと同じ2フェーズ(アドレス→データ)へ展開して流す。
    // _writePhase が対の途中を表すので、キューから取り出すのはデータを出す時だけ。
    _pumpWrites() {
      if (this.writeHead >= this.writebuf.length) return;
      if (this.writeDelay > 0) { this.writeDelay--; return; }
      const w = this.writebuf[this.writeHead];
      if (this._writePhase === 0) {
        this.write_data = w & 0x3f;   // アドレスフェーズ
        this.write_a |= 1;
        this._writePhase = 1;
        this.writeDelay = WRITE_GAP_ADDR;
      } else {
        this.write_data = (w >> 8) & 0xff; // データフェーズ
        this.write_d |= 1;
        this._writePhase = 0;
        this.writeHead++;
        if (this.writeHead > 1024 && this.writeHead * 2 > this.writebuf.length) {
          this.writebuf = this.writebuf.slice(this.writeHead); this.writeHead = 0; // たまに詰める
        }
        this.writeDelay = WRITE_GAP_DATA;
      }
    }

    /** レジスタ番号を直接指定して書く(VGM / テスト用) */
    writeReg(reg, data) {
      reg &= 0x3f; data &= 0xff;
      this.regShadow[reg] = data;
      this._addrLatch = reg;
      this._pushWrite(reg, data);
    }

    /** VRC7のNSFバス: $9010=アドレス, $9030=データ */
    writeRegister(addr, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (addr === 0x9010) { this._addrLatch = value & 0x3f; }
      else if (addr === 0x9030) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** FMPACのMSX I/Oポート: 0x7C=アドレス, 0x7D=データ */
    ioWrite(port, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (port === 0x7C) { this._addrLatch = value & 0x3f; }
      else if (port === 0x7D) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** ホストクロック1サイクル。hostPerOpll個で内部1サイクル進む */
    clock() {
      if (++this.hostAccum < this.hostPerOpll) return;
      this.hostAccum = 0;
      this._pumpWrites();
      this._stepOpll();
    }

    /**
     * clock()を回さない経路(regsOnlyキャプチャ等)で溜まった書き込みを反映させる。
     * ym2612Nuked.flushWrites() と同じ用途。
     */
    flushWrites() {
      let guard = 0;
      while (this.writeHead < this.writebuf.length && guard++ < 1000000) this.clock();
      for (let i = 0; i < this.hostPerOpll * CYCLES_PER_SAMPLE * 2; i++) this.clock();
    }

    mixSample() { return this.lastSample * OUTPUT_GAIN; }

    get rhythmMode() { return !this.isDs1001 && !!(this.rhythm & 0x20); }

    // ────────── 鍵盤表示用スナップショット ──────────
    // 実機のレジスタ影から音色パラメータを取り出し、波形は「今のパラメータでの概形」を
    // 再合成する(時分割パイプラインは模擬しない)。ym2612Nuked.js の nukedSynthWave と同方針。
    _patchOf(ch) {
      const instr = this.inst[ch];
      return instr > 0 ? this.patchrom[instr - 1] : this.patch;
    }

    _dumpPatch(ch) {
      const p = this._patchOf(ch);
      return {
        type: 'opll', inst: this.inst[ch],
        mod: { AM: p.am[0], PM: p.vib[0], EG: p.et[0], KR: p.ksr[0], ML: p.multi[0],
               KL: p.ksl[0], TL: p.tl, FB: p.fb, WF: p.dm,
               AR: p.ar[0], DR: p.dr[0], SL: p.sl[0], RR: p.rr[0] },
        car: { AM: p.am[1], PM: p.vib[1], EG: p.et[1], KR: p.ksr[1], ML: p.multi[1],
               KL: p.ksl[1], TL: 0, FB: 0, WF: p.dc,
               AR: p.ar[1], DR: p.dr[1], SL: p.sl[1], RR: p.rr[1] }
      };
    }

    /** 1周期ぶんのFM波形(-1..1, N点)。egは現在値を使う */
    _synthWave(ch, N) {
      const p = this._patchOf(ch);
      const modEg = this.eg_level[SLOT_MOD[ch]] + (p.tl << 1);
      const carEg = this.eg_level[SLOT_CAR[ch]] + (this.regVol[ch] << 3);
      const ratio = PG_MULTI[p.multi[0]] / (PG_MULTI[p.multi[1]] || 1);
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const mp = Math.round((k / N) * ratio * 1024) & 0x3ff;
        const mo = opOut(mp, modEg, p.dm);
        const cp = (Math.round((k / N) * 1024) + (mo >> 0)) & 0x3ff;
        const co = opOut(cp, carEg, p.dc);
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      return wave;
    }

    _melodySnapshot(ch, N) {
      const fnum = this.fnum[ch], block = this.block[ch];
      const carLevel = this.eg_level[SLOT_CAR[ch]];
      const active = !!this.kon[ch] && carLevel < 0x7f;
      return {
        freq: (this.kon[ch] && fnum > 0) ? SAMPLE_RATE * fnum / Math.pow(2, 19 - block) : 0,
        vol: (15 - this.regVol[ch]) / 15,
        rawVol: this.regVol[ch],
        instrument: this.inst[ch],
        active,
        waveData: active ? this._synthWave(ch, N) : new Array(N).fill(0),
        patch: this._dumpPatch(ch)
      };
    }

    // ★2026-08-22: 打楽器はピークホールドで返す。
    // 鍵盤表示はrAF(約16ms間隔)でスナップショットを読むが、チップはオーディオバッファ単位
    // (ScriptProcessorNodeで50〜90ms)にまとめて進むため、瞬時値だけ見ると短い打楽器の
    // 減衰がサンプリングの隙間に丸ごと落ちる。実測: Aleste Gaiden 7曲目のBDは約50msで
    // 減衰しきり(eg_level 16→33→96→127)、鍵盤のBD行が一度も点灯しなかった
    // (SDは減衰が緩いので見えていた)。前回読んだ時点以降の最小レベル(=最大音量)を保持する。
    _rhythmSlotInfo(peakIdx, slotIdx, freq) {
      const now = this.eg_level[slotIdx];
      const level = Math.min(this._rhythmPeak[peakIdx], now);
      this._rhythmPeak[peakIdx] = now; // 次の窓は現在値から測り直す
      return { freq, active: level < 0x7f, vol: (0x7f - level) / 0x7f };
    }

    snapshot() {
      const N = 128;
      if (this.isDs1001) {
        const out = [];
        for (let i = 0; i < 6; i++) out.push(this._melodySnapshot(i, N));
        return out;
      }
      // ★2026-08-22: melody は常に9本、rhythm も常に付けて返す。
      // リズムモードのビット($0E bit5)を「打つ瞬間だけ立てて即降ろす」ドライバが実在し
      // (SMS版After Burnerは毎秒10〜16回トグル)、返す形をビットに追随させると鍵盤の
      // 行構成が激しく入れ替わって読めなくなる。どちらを表示するかは表示側(keyboard.js)が
      // 「一度リズムを見たら以後保持」する単調な運用で決める。
      const rhythmMode = this.rhythmMode;
      const melody = [];
      for (let i = 0; i < 9; i++) melody.push(this._melodySnapshot(i, N));

      const f = (ch) => this.fnum[ch] > 0 ? SAMPLE_RATE * this.fnum[ch] / Math.pow(2, 19 - this.block[ch]) : 0;
      return {
        rhythmMode,
        melody,
        rhythm: {
          bd:  this._rhythmSlotInfo(0, RHYTHM_SLOT[0], f(6)),
          sd:  this._rhythmSlotInfo(1, RHYTHM_SLOT[1], 0),
          tom: this._rhythmSlotInfo(2, RHYTHM_SLOT[2], f(8)),
          cym: this._rhythmSlotInfo(3, RHYTHM_SLOT[3], 0),
          hh:  this._rhythmSlotInfo(4, RHYTHM_SLOT[4], 0)
        }
      };
    }
  }

  // 書き込みキューの最小間隔(内部サイクル)。実チップのウェイト仕様に対応する。
  //  - アドレス書き込み後: write_dataラッチを取り合わないよう数サイクル空ければよい。
  //  - データ書き込み後  : ★18以上必須。FMレジスタ($10/$20/$30系)は _doRegWrite が
  //    「(address&0x0f) == cycles」の1サイクルでしか反映しないため、次のアドレス書き込みが
  //    write_fm_data を落とす前に18サイクル(全cycles値)を一巡させないと書き込みが消える。
  //    実機YM2413のデータ書き込み後ウェイト84マスタサイクル(=21内部サイクル)とも符合する。
  // キュー上限。超えたら直接反映へ切り替える(_pushWrite のコメント参照)
  // ★キュー上限は「実ドライバの通常の書き込みバーストでは絶対に届かない」値にすること。
  // 32では実測でIllusion City(KSS)の通常再生中に80フレームで95回も直接反映が発動し、
  // 実チップのウェイトを踏んだ書き込みタイミングが壊れてFM2の音が変わっていた
  // (直接反映を止めるとVGM経路と完全一致した)。KSSのOPLL書き込みは最大74件/フレーム。
  // 取り出しは writeHead 方式(shift不使用)なので、キューが長くても取り出しコストは一定。
  // ここが効くのは clock() が呼ばれない早送り経路だけで、そこは数万〜数十万件積まれる。
  const WRITE_QUEUE_MAX = 4096;
  const WRITE_GAP_ADDR = 4;
  const WRITE_GAP_DATA = 20;

  // 出力ゲイン。旧コア(emu2413移植)とラウドネスを揃えるための実測較正値。
  // 新コアの生の出力は「18サイクルぶんの時分割DAC出力の総和」。@1/@4/@8/@12/@15
  // を単音で鳴らしてRMSを旧コアと突き合わせ、平均比が1.0になるよう決めた(音色ごとの比は
  // 0.4〜1.2とばらつく。コアが違えばEG/出力段が違うので一致はしない)
  // (フォーマット間の音量バランスを崩さないため)。
  const OUTPUT_GAIN = 1 / 2000;

  // DC遮断フィルタ係数(1 - 2π*5Hz/49716)
  const DC_BLOCK_R = 0.99937;

  // 波形プレビュー用の1オペレータ出力(実機と同じ対数sin→exp経路)
  function opOut(phase10, egLevel, halfWave) {
    let phase = phase10 & 0x3ff;
    const neg = (phase >> 9) & 1;
    if (phase & 0x100) phase ^= 0xff;
    let level = LOGSIN[phase & 0xff] + (Math.min(127, egLevel) << 4);
    if (level >= 4096) level = 4095;
    const out = EXPROM[level & 0xff] >> (level >> 8);
    if (halfWave && neg) return 0;
    return neg ? ~out : out;
  }

  // 音色エディタの逆算(src/ui/vrc7ToneSolver.js)が定常状態の1周期を実機と同じ演算で
  // 作るために使う。LOGSIN/EXPROM表そのものは外へ出さない(表を持ち出すと写しがずれる)
  OPLLNuked.opOut = opOut;

  // 内蔵音色ROMをレジスタ$00-$07と同じ8バイト並びで返す(type: 'ym2413' | 'ds1001'(VRC7)、inst 1-15)。
  // 変換側(src/convert/toneDerive.js)が「YM2413のプリセット音色の波形」をN163等へ写すときに使う。
  // ★VRC7(ds1001)側の写しは src/convert/vrc7Tone.js PRESETS にもある(Workerバンドル都合の複製)
  OPLLNuked.presetBytes = function (type, inst) {
    const rom = type === 'ds1001' ? PATCH_DS1001 : PATCH_YM2413;
    const p = rom[(inst | 0) - 1];
    if (!p) return null;
    const b20 = (i) => (p.am[i] << 7) | (p.vib[i] << 6) | (p.et[i] << 5) | (p.ksr[i] << 4) | (p.multi[i] & 15);
    return [
      b20(0), b20(1),
      ((p.ksl[0] & 3) << 6) | (p.tl & 63),
      ((p.ksl[1] & 3) << 6) | ((p.dc & 1) << 4) | ((p.dm & 1) << 3) | (p.fb & 7),
      (p.ar[0] << 4) | p.dr[0], (p.ar[1] << 4) | p.dr[1],
      (p.sl[0] << 4) | p.rr[0], (p.sl[1] << 4) | p.rr[1]
    ];
  };

  Emu.OPLLNuked = OPLLNuked;
})(globalThis);

/*
 * VRC7 拡張音源エミュレータ (OPLL / YM2413)
 * MML.Emu.VRC7Audio
 *
 * ★2026-08-22: 既定の再生コアは opllNuked.js (Nuked-OPLL移植) に移行した。このファイルの
 * 実装は MML.Emu.OPLL_CORE = 'emu2413' を指定したときのA/B比較用として残してある。
 *
 * Mitsutaka Okazaki の emu2413 (VirtuaNES同梱版) を忠実に移植した2オペレータFM。
 * 6メロディチャンネル。DB単位系(0.375dB/step)・1024点対数sin・DB2LIN・正確なEG状態機械。
 * 音色ROMは nukeykt/Nuked-OPLL (GPLv2) の patch_ds1001 = VRC7実チップの die shot 読み出し値。
 *   $9010 : アドレスポート  $9030 : データポート
 * 出力49716Hz (VRC7マスタ3.58MHz/72 = CPUクロック/36)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 6;
  const CYCLES_PER_SAMPLE = 36;
  const SAMPLE_RATE = 49716;

  // ---- 定数 (emu2413) ----
  const PG_BITS = 10, PG_WIDTH = 1 << PG_BITS;       // 1024点波形(emu2413に合わせて9→10bit化)
  const DP_BITS = 19, DP_WIDTH = 1 << DP_BITS, DP_BASE_BITS = DP_BITS - PG_BITS; // 9
  const DB_STEP = 0.375, DB_BITS = 7, DB_MUTE = 1 << DB_BITS;   // 128
  const EG_STEP = 0.375, EG_BITS = 7;
  const EG2DB = 1;                                    // EG_STEP/DB_STEP
  const TL2EG = 2;                                    // TL_STEP/EG_STEP (0.75/0.375)
  const DB2LIN_AMP_BITS = 10, SLOT_AMP_BITS = DB2LIN_AMP_BITS;
  const EG_DP_BITS = 22, EG_DP_WIDTH = 1 << EG_DP_BITS;
  const PM_PG_BITS = 8, PM_PG_WIDTH = 1 << PM_PG_BITS;
  const PM_DP_BITS = 16, PM_DP_WIDTH = 1 << PM_DP_BITS;
  const AM_PG_BITS = 8, AM_PG_WIDTH = 1 << AM_PG_BITS;
  const AM_DP_BITS = 16, AM_DP_WIDTH = 1 << AM_DP_BITS;
  const PM_AMP_BITS = 8, PM_AMP = 1 << PM_AMP_BITS;
  const PM_SPEED = 6.4, PM_DEPTH = 13.75, AM_SPEED = 3.7, AM_DEPTH = 4.8;

  // EGモード
  const SETTLE = 0, ATTACK = 1, DECAY = 2, SUSHOLD = 3, SUSTINE = 4, RELEASE = 5, FINISH = 6;

  // ---- 音色ROM (実チップ内蔵ROM。各8バイト=$00-$07) ----
  // ★2026-08-22: 従来の VirtuaNES vrc7tone.h は実測値ではなく耳コピ推定で、実体は
  // YM2413用テーブルの微改変だった(@2 Guitar が opllMsx.js の YM2413 値と1バイト違い)。
  // nukeykt/Nuked-OPLL の patch_ds1001 は VRC7(Konami DS1001)を decap/die shot
  // (siliconpr0n: digshadow, John McMaster)から読み出した本物のROM内容なので差し替え。
  // NESdev Wiki "VRC7 audio" の音色表と全15音色一致を確認済み。音色名はNESdev Wiki準拠。
  const VRC7_INST = [
    [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // 0: ユーザー音色枠($00-$07で可変)
    [0x03,0x21,0x05,0x06,0xe8,0x81,0x42,0x27], // 1: Buzzy Bell
    [0x13,0x41,0x14,0x0d,0xd8,0xf6,0x23,0x12], // 2: Guitar
    [0x11,0x11,0x08,0x08,0xfa,0xb2,0x20,0x12], // 3: Wurly
    [0x31,0x61,0x0c,0x07,0xa8,0x64,0x61,0x27], // 4: Flute
    [0x32,0x21,0x1e,0x06,0xe1,0x76,0x01,0x28], // 5: Clarinet
    [0x02,0x01,0x06,0x00,0xa3,0xe2,0xf4,0xf4], // 6: Synth
    [0x21,0x61,0x1d,0x07,0x82,0x81,0x11,0x07], // 7: Trumpet
    [0x23,0x21,0x22,0x17,0xa2,0x72,0x01,0x17], // 8: Organ
    [0x35,0x11,0x25,0x00,0x40,0x73,0x72,0x01], // 9: Bells
    [0xb5,0x01,0x0f,0x0f,0xa8,0xa5,0x51,0x02], // 10: Vibes
    [0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12], // 11: Vibraphone
    [0x71,0x23,0x11,0x06,0x65,0x74,0x18,0x16], // 12: Tutti
    [0x01,0x02,0xd3,0x05,0xc9,0x95,0x03,0x02], // 13: Fretless
    [0x61,0x63,0x0c,0x00,0x94,0xc0,0x33,0xf6], // 14: Synth Bass
    [0x21,0x72,0x0d,0x00,0xc1,0xd5,0x56,0x06]  // 15: Sweep
  ];

  // dump(8byte) → {mod,car} パッチ (emu2413 dump2patch)
  function dump2patch(d) {
    return {
      mod: { AM:(d[0]>>7)&1, PM:(d[0]>>6)&1, EG:(d[0]>>5)&1, KR:(d[0]>>4)&1, ML:d[0]&15,
             KL:(d[2]>>6)&3, TL:d[2]&63, FB:d[3]&7, WF:(d[3]>>3)&1,
             AR:(d[4]>>4)&15, DR:d[4]&15, SL:(d[6]>>4)&15, RR:d[6]&15 },
      car: { AM:(d[1]>>7)&1, PM:(d[1]>>6)&1, EG:(d[1]>>5)&1, KR:(d[1]>>4)&1, ML:d[1]&15,
             KL:(d[3]>>6)&3, TL:0, FB:0, WF:(d[3]>>4)&1,
             AR:(d[5]>>4)&15, DR:d[5]&15, SL:(d[7]>>4)&15, RR:d[7]&15 }
    };
  }
  const PATCH = VRC7_INST.map(dump2patch); // [16] {mod,car}
  // 変換側(src/convert/vrc7Tone.js の「近いプリセット探し」)にも同じ表が要る。あちらは
  // Workerバンドルにエミュレータを同梱できない都合で自前の写しを持っているので、
  // tools/headless/check-all.js がこの export と突き合わせて食い違いを検出する。
  Emu.VRC7_INST = VRC7_INST;

  // ---- テーブル ----
  function Min(a, b) { return a < b ? a : b; }

  // AR用 線形→対数
  const AR_ADJUST = new Uint32Array(1 << EG_BITS);
  AR_ADJUST[0] = 1 << EG_BITS;
  for (let i = 1; i < 128; i++)
    AR_ADJUST[i] = ((1 << EG_BITS) - 1 - (1 << EG_BITS) * Math.log(i) / Math.log(128)) | 0;

  // DB2LIN
  const DB2LIN = new Int32Array((DB_MUTE + DB_MUTE) * 2);
  for (let i = 0; i < DB_MUTE + DB_MUTE; i++) {
    let v = (((1 << DB2LIN_AMP_BITS) - 1) * Math.pow(10, -i * DB_STEP / 20)) | 0;
    if (i >= DB_MUTE) v = 0;
    DB2LIN[i] = v;
    DB2LIN[i + DB_MUTE + DB_MUTE] = -v;
  }

  function lin2db(d) {
    if (d === 0) return DB_MUTE - 1;
    return Min(-(((20.0 * Math.log10(d)) / DB_STEP) | 0), DB_MUTE - 1);
  }

  // sinテーブル (0=full, 1=half)
  const fullsin = new Uint32Array(PG_WIDTH);
  const halfsin = new Uint32Array(PG_WIDTH);
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[i] = lin2db(Math.sin(2.0 * Math.PI * i / PG_WIDTH));
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[PG_WIDTH / 2 - 1 - i] = fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) fullsin[PG_WIDTH / 2 + i] = DB_MUTE + DB_MUTE + fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) halfsin[i] = fullsin[i];
  for (let i = PG_WIDTH / 2; i < PG_WIDTH; i++) halfsin[i] = fullsin[0];
  const WAVEFORM = [fullsin, halfsin];

  // LFO
  const pmtable = new Int32Array(PM_PG_WIDTH);
  for (let i = 0; i < PM_PG_WIDTH; i++)
    pmtable[i] = (PM_AMP * Math.pow(2, PM_DEPTH * Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH) / 1200)) | 0;
  const amtable = new Int32Array(AM_PG_WIDTH);
  for (let i = 0; i < AM_PG_WIDTH; i++)
    amtable[i] = (AM_DEPTH / 2 / DB_STEP * (1.0 + Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH))) | 0;

  // clk/rate はネイティブ(49716Hz)固定なので rate_adjust=恒等。
  // dphaseTable[fnum][block][ML]
  const MLT = [1, 1*2, 2*2, 3*2, 4*2, 5*2, 6*2, 7*2, 8*2, 9*2, 10*2, 10*2, 12*2, 12*2, 15*2, 15*2];
  const dphaseTable = [];
  for (let fnum = 0; fnum < 512; fnum++) {
    const a = []; dphaseTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Uint32Array(16); a.push(b);
      for (let ML = 0; ML < 16; ML++)
        b[ML] = (((fnum * MLT[ML]) << block) >> (20 - DP_BITS)) >>> 0;
    }
  }

  // tllTable[fnum4][block][TL][KL]
  const KL_DB2 = [0.000,9.000,12.000,13.875,15.000,16.125,16.875,17.625,18.000,18.750,19.125,19.500,19.875,20.250,20.625,21.000].map(x => (x * 2) | 0);
  const tllTable = [];
  for (let fnum = 0; fnum < 16; fnum++) {
    const a = []; tllTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = []; a.push(b);
      for (let TL = 0; TL < 64; TL++) {
        const c = new Uint32Array(4); b.push(c);
        for (let KL = 0; KL < 4; KL++) {
          if (KL === 0) c[KL] = (TL2EG * TL) >>> 0;
          else {
            const tmp = KL_DB2[fnum] - (3 * 2) * (7 - block);
            if (tmp <= 0) c[KL] = (TL2EG * TL) >>> 0;
            else c[KL] = (((tmp >> (3 - KL)) / EG_STEP) | 0) + TL2EG * TL;
          }
        }
      }
    }
  }

  // rksTable[fnum8][block][KR]
  const rksTable = [];
  for (let f8 = 0; f8 < 2; f8++) {
    const a = []; rksTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Int32Array(2); a.push(b);
      b[0] = block >> 1;
      b[1] = (block << 1) + f8;
    }
  }

  // dphaseARTable[AR][Rks], dphaseDRTable[DR][Rks]
  const dphaseARTable = [], dphaseDRTable = [];
  for (let AR = 0; AR < 16; AR++) {
    const a = new Uint32Array(16); dphaseARTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = AR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (AR === 0) a[Rks] = 0;
      else if (AR === 15) a[Rks] = EG_DP_WIDTH;
      else a[Rks] = ((3 * (RL + 4)) << (RM + 1)) >>> 0;
    }
  }
  for (let DR = 0; DR < 16; DR++) {
    const a = new Uint32Array(16); dphaseDRTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = DR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (DR === 0) a[Rks] = 0;
      else a[Rks] = ((RL + 4) << (RM - 1)) >>> 0;
    }
  }

  // SL[16] (eg_phase単位)
  const SL_DB = [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,48];
  const SL = new Uint32Array(16);
  for (let i = 0; i < 16; i++) SL[i] = ((((SL_DB[i] / 3.0) * 8) | 0) << (EG_DP_BITS - EG_BITS)) >>> 0;

  const pm_dphase = ((PM_SPEED * PM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;
  const am_dphase = ((AM_SPEED * AM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;

  // ---- スロット ----
  class Slot {
    constructor(type) {
      this.type = type; // 0=mod 1=car
      this.patch = PATCH[0].mod;
      this.reset();
    }
    reset() {
      this.sintbl = WAVEFORM[0];
      this.phase = 0; this.dphase = 0; this.pgout = 0;
      this.output = [0, 0]; this.feedback = 0;
      this.eg_mode = SETTLE; this.eg_phase = EG_DP_WIDTH; this.eg_dphase = 0; this.egout = 0;
      this.fnum = 0; this.block = 0; this.volume = 0; this.sustine = 0;
      this.tll = 0; this.rks = 0;
    }
    calcEgDphase() {
      const p = this.patch;
      switch (this.eg_mode) {
        case ATTACK: return dphaseARTable[p.AR][this.rks];
        case DECAY: return dphaseDRTable[p.DR][this.rks];
        case SUSHOLD: return 0;
        case SUSTINE: return dphaseDRTable[p.RR][this.rks];
        case RELEASE:
          if (this.sustine) return dphaseDRTable[5][this.rks];
          else if (p.EG) return dphaseDRTable[p.RR][this.rks];
          else return dphaseDRTable[7][this.rks];
        default: return 0;
      }
    }
    updatePG() { this.dphase = dphaseTable[this.fnum][this.block][this.patch.ML]; }
    updateTLL() {
      this.tll = (this.type === 0)
        ? tllTable[this.fnum >> 5][this.block][this.patch.TL][this.patch.KL]
        : tllTable[this.fnum >> 5][this.block][this.volume][this.patch.KL];
    }
    updateRKS() { this.rks = rksTable[this.fnum >> 8][this.block][this.patch.KR]; }
    updateWF() { this.sintbl = WAVEFORM[this.patch.WF]; }
    updateEG() { this.eg_dphase = this.calcEgDphase(); }
    updateAll() { this.updatePG(); this.updateTLL(); this.updateRKS(); this.updateWF(); this.updateEG(); }
    slotOn() { this.eg_mode = ATTACK; this.phase = 0; this.eg_phase = 0; }
    slotOff() {
      if (this.eg_mode === ATTACK)
        this.eg_phase = (AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F] << (EG_DP_BITS - EG_BITS)) >>> 0;
      this.eg_mode = RELEASE;
    }
    calcPhase(lfo_pm) {
      if (this.patch.PM) this.phase = (this.phase + (((this.dphase * lfo_pm) >> PM_AMP_BITS) >>> 0)) >>> 0;
      else this.phase = (this.phase + this.dphase) >>> 0;
      this.phase &= (DP_WIDTH - 1);
      this.pgout = this.phase >>> DP_BASE_BITS;
      return this.pgout;
    }
    calcEnvelope(lfo_am) {
      let egout;
      switch (this.eg_mode) {
        case ATTACK:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          if (this.eg_phase & EG_DP_WIDTH) { egout = 0; this.eg_phase = 0; this.eg_mode = DECAY; this.updateEG(); }
          else egout = AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F];
          break;
        case DECAY:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.eg_phase >= SL[this.patch.SL]) {
            this.eg_phase = SL[this.patch.SL];
            this.eg_mode = this.patch.EG ? SUSHOLD : SUSTINE;
            this.updateEG();
            egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          }
          break;
        case SUSHOLD:
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.patch.EG === 0) { this.eg_mode = SUSTINE; this.updateEG(); }
          break;
        case SUSTINE:
        case RELEASE:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (egout >= (1 << EG_BITS)) { this.eg_mode = FINISH; egout = (1 << EG_BITS) - 1; }
          break;
        case FINISH: default:
          egout = (1 << EG_BITS) - 1;
          break;
      }
      egout = this.patch.AM ? (EG2DB * (egout + this.tll) + lfo_am) : (EG2DB * (egout + this.tll));
      if (egout >= DB_MUTE) egout = DB_MUTE - 1;
      this.egout = egout;
      return egout;
    }
  }

  // emu2413 calc_slot_car: modOut = 2*(fm>>1) (fmのLSBを切り捨てるだけで倍化はしない)
  function modToCarPhase(fm) { return 2 * (fm >> 1); }

  class Vrc7Channel {
    constructor() {
      this.mod = new Slot(0);
      this.car = new Slot(1);
      this.patchNumber = 0;
      this.keyStatus = 0;
    }
    reset() { this.mod.reset(); this.car.reset(); this.keyStatus = 0; }

    calcModulator(lfo_am, lfo_pm) {
      const s = this.mod;
      s.output[1] = s.output[0];
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) s.output[0] = 0;
      else if (s.patch.FB !== 0) {
        // emu2413: fm = (output[1]+output[0]) >> (9-FB)。s.feedbackは(output[1]+output[0])>>1で
        // 既に1bitシフト済みのため、ここでのシフト量は(9-FB)-1 = (8-FB)。
        const fm = (s.feedback) >> (8 - s.patch.FB);
        s.output[0] = DB2LIN[s.sintbl[(pgout + fm) & (PG_WIDTH - 1)] + egout];
      } else {
        s.output[0] = DB2LIN[s.sintbl[pgout] + egout];
      }
      // s.feedbackは自己変調(次回calcModulator呼び出し時のfm計算)専用。キャリアへ渡すのは
      // emu2413同様、平均化前の生のoutput[0]。
      s.feedback = (s.output[1] + s.output[0]) >> 1;
      return s.output[0];
    }
    calcCarrier(fm, lfo_am, lfo_pm) {
      const s = this.car;
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) return 0;
      return DB2LIN[s.sintbl[(pgout + modToCarPhase(fm)) & (PG_WIDTH - 1)] + egout];
    }
  }

  class VRC7Audio {
    constructor() { 
      // ★2026-08-22: 既定ではNuked-OPLLコア(opllNuked.js)へ委譲する。
      // MML.Emu.OPLL_CORE = 'emu2413' を指定するとこの下の旧コア(emu2413 0.6x系移植)に戻る。
      if (Emu.OPLL_CORE !== 'emu2413' && Emu.OPLLNuked) return new Emu.OPLLNuked({ chipType: 'ds1001' });
      this._init(); this.mute = new Array(NUM_CH).fill(false); this.vol = new Array(NUM_CH).fill(1); }
    _init() {
      this.addr = 0;
      this.reg = new Uint8Array(0x40);
      this.patches = [];               // [16] {mod,car} (音色0はカスタム, 可変)
      for (let i = 0; i < 16; i++) this.patches.push({ mod: Object.assign({}, PATCH[i].mod), car: Object.assign({}, PATCH[i].car) });
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) { const c = new Vrc7Channel(); this.channels.push(c); this._setPatch(i, 0); }
      this.pm_phase = 0; this.am_phase = 0; this.lfo_pm = 0; this.lfo_am = 0;
      this.cyc = 0; this.lastSample = 0;
    }
    reset() { this._init(); }

    _setPatch(i, num) {
      const c = this.channels[i];
      c.patchNumber = num;
      c.mod.patch = this.patches[num].mod;
      c.car.patch = this.patches[num].car;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0x9010) this.addr = value & 0x3F;
      else if (addr === 0x9030) this.writeReg(this.addr, value);
    }

    writeReg(reg, data) {
      reg &= 0x3F; data &= 0xFF;
      const cust = this.patches[0];
      if (reg <= 0x07) {
        // カスタム音色
        switch (reg) {
          case 0x00: cust.mod.AM=(data>>7)&1; cust.mod.PM=(data>>6)&1; cust.mod.EG=(data>>5)&1; cust.mod.KR=(data>>4)&1; cust.mod.ML=data&15; break;
          case 0x01: cust.car.AM=(data>>7)&1; cust.car.PM=(data>>6)&1; cust.car.EG=(data>>5)&1; cust.car.KR=(data>>4)&1; cust.car.ML=data&15; break;
          case 0x02: cust.mod.KL=(data>>6)&3; cust.mod.TL=data&63; break;
          case 0x03: cust.car.KL=(data>>6)&3; cust.car.WF=(data>>4)&1; cust.mod.WF=(data>>3)&1; cust.mod.FB=data&7; break;
          case 0x04: cust.mod.AR=(data>>4)&15; cust.mod.DR=data&15; break;
          case 0x05: cust.car.AR=(data>>4)&15; cust.car.DR=data&15; break;
          case 0x06: cust.mod.SL=(data>>4)&15; cust.mod.RR=data&15; break;
          case 0x07: cust.car.SL=(data>>4)&15; cust.car.RR=data&15; break;
        }
        for (let i = 0; i < NUM_CH; i++) if (this.channels[i].patchNumber === 0) { this.channels[i].mod.updateAll(); this.channels[i].car.updateAll(); }
      } else if (reg >= 0x10 && reg <= 0x15) {
        const ch = reg - 0x10, c = this.channels[ch];
        const fnum = data + ((this.reg[0x20 + ch] & 1) << 8);
        c.mod.fnum = c.car.fnum = fnum;
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x20 && reg <= 0x25) {
        const ch = reg - 0x20, c = this.channels[ch];
        const fnum = ((data & 1) << 8) + this.reg[0x10 + ch];
        const block = (data >> 1) & 7;
        c.mod.fnum = c.car.fnum = fnum; c.mod.block = c.car.block = block;
        // sustine
        if ((this.reg[reg] ^ data) & 0x20) { c.car.sustine = (data >> 5) & 1; }
        // key on/off
        const key = (data & 0x10) !== 0;
        if (key) { if (!c.keyStatus) { c.mod.slotOn(); c.car.slotOn(); } c.keyStatus = 1; }
        else { if (c.keyStatus) c.car.slotOff(); c.keyStatus = 0; }
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x30 && reg <= 0x35) {
        const ch = reg - 0x30, c = this.channels[ch];
        this._setPatch(ch, (data >> 4) & 15);
        c.car.volume = (data & 15) << 2; // 6bit
        c.mod.updateAll(); c.car.updateAll();
      }
      this.reg[reg] = data;
    }

    _updateAMPM() {
      this.pm_phase = (this.pm_phase + pm_dphase) & (PM_DP_WIDTH - 1);
      this.am_phase = (this.am_phase + am_dphase) & (AM_DP_WIDTH - 1);
      this.lfo_am = amtable[this.am_phase >>> (AM_DP_BITS - AM_PG_BITS)];
      this.lfo_pm = pmtable[this.pm_phase >>> (PM_DP_BITS - PM_PG_BITS)];
    }

    _calc() {
      this._updateAMPM();
      let inst = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.channels[i];
        if (c.car.eg_mode === FINISH) continue;
        const fm = c.calcModulator(this.lfo_am, this.lfo_pm);
        const out = c.calcCarrier(fm, this.lfo_am, this.lfo_pm);
        if (!this.mute[i]) inst += out * this.vol[i];
      }
      return inst; // ±(1023*6)
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this.lastSample = this._calc();
    }

    mixSample() {
      // emu2413: out16 = clamp(inst*8). ここでは -1..1 に正規化しゲイン調整。
      return (this.lastSample / 4096) * 0.5;
    }
  }

  // ---- 鍵盤表示用スナップショット ----
  Emu.snapshotVRC7 = function (chip) {
    if (typeof chip.snapshot === 'function') return chip.snapshot(); // Nukedコア
    const out = [];
    const N = 128; // FM連続波形なので線形補間前提で高めの解像度
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.channels[i];
      const mod = c.mod, car = c.car;
      const freq = (c.keyStatus && car.fnum > 0) ? SAMPLE_RATE * car.fnum / Math.pow(2, 19 - car.block) : 0;
      const active = c.keyStatus && car.eg_mode !== FINISH && car.eg_mode !== SETTLE;
      // 現在のオペレータ状態で1周期のFM波形を合成
      const modEg = mod.egout, carEg = car.egout;
      const ratio = car.dphase > 0 ? mod.dphase / car.dphase : 1;
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const cp = Math.round((k / N) * PG_WIDTH) & (PG_WIDTH - 1);
        const mp = Math.round((k / N) * ratio * PG_WIDTH) & (PG_WIDTH - 1);
        const mo = DB2LIN[mod.sintbl[mp] + Math.min(DB_MUTE - 1, modEg)];
        const co = (carEg >= DB_MUTE - 1) ? 0 : DB2LIN[car.sintbl[(cp + (mo << 1)) & (PG_WIDTH - 1)] + carEg];
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      // patch: 鍵盤の大波形表示の下に音色データ(@OT形式)を出すためのパラメータ
      // (chip.patches[n] の {mod,car}。emu2413のpatch構造体そのまま: AM/PM/EG/KR/ML/KL/TL/FB/WF/AR/DR/SL/RR)
      const pt = chip.patches[c.patchNumber];
      out.push({
        freq,
        vol: (15 - (c.car.volume >> 2)) / 15,
        rawVol: c.car.volume >> 2,
        instrument: c.patchNumber,
        active,
        waveData: active ? wave : new Array(N).fill(0),
        patch: pt ? { type: 'opll', inst: c.patchNumber, mod: pt.mod, car: pt.car } : null
      });
    }
    return out;
  };

  Emu.VRC7Audio = VRC7Audio;
})(globalThis);

/*
 * MMC5 拡張音源エミュレータ
 * MML.Emu.MMC5Audio
 *
 * パルス x2 ($5000-$5003 / $5004-$5007, 有効化は $5015)。
 * レジスタ形式は2A03のパルスチャンネルと同様だが、スイープユニットを持たない。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];
  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  class Mmc5Pulse {
    constructor() {
      this.enabled = false;
      this.duty = 0;
      this.lengthCounterHalt = false; // = エンベロープループフラグ
      this.constantVolume = true;
      this.volume = 0;                // 固定音量 or エンベロープ周期
      this.timerPeriod = 0;
      this.timer = 0;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      // エンベロープ(2A03パルスと同形式)
      this.envStart = false;
      this.envDivider = 0;
      this.envDecay = 0;
    }
    writeReg(index, value) {
      switch (index) {
        case 0: // $5000/$5004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.constantVolume = (value & 0x10) !== 0;
          this.volume = value & 0x0F;
          break;
        case 2: // $5002/$5006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $5003/$5007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envStart = true; // 書き込みでエンベロープ再スタート
          break;
      }
    }
    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }
    clock() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }
    // エンベロープ更新(240Hzでクロック)。2A03パルスと同一ロジック。
    clockEnvelope() {
      if (this.envStart) {
        this.envStart = false;
        this.envDecay = 15;
        this.envDivider = this.volume;
      } else if (this.envDivider === 0) {
        this.envDivider = this.volume;
        if (this.envDecay > 0) this.envDecay--;
        else if (this.lengthCounterHalt) this.envDecay = 15; // ループ
      } else {
        this.envDivider--;
      }
    }
    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }
    output() {
      // MMC5はスイープを持たないため 2A03 の「period<8で消音」は無い(超音波域も出力)。
      if (!this.enabled || this.lengthCounter === 0) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.constantVolume ? this.volume : this.envDecay;
    }
  }

  class MMC5Audio {
    constructor() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;   // $5011 8bit 生PCM DAC 出力
      this.pcmReadMode = false; // $5010 bit0
      this.mute = { pulse1: false, pulse2: false, pcm: false };
      this.vol = { pulse1: 1, pulse2: 1, pcm: 1 };
    }

    reset() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;
      this.pcmReadMode = false;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x5000 && addr <= 0x5003) {
        this.pulse1.writeReg(addr - 0x5000, value);
      } else if (addr >= 0x5004 && addr <= 0x5007) {
        this.pulse2.writeReg(addr - 0x5004, value);
      } else if (addr === 0x5010) {
        this.pcmReadMode = (value & 0x01) !== 0; // bit0: 0=writeモード, 1=readモード
      } else if (addr === 0x5011) {
        // 8bit 生PCM。writeモードのみ出力を更新($4011相当だが8bit)。
        if (!this.pcmReadMode) this.pcmLevel = value;
      } else if (addr === 0x5015) {
        this.pulse1.setEnabled((value & 0x01) !== 0);
        this.pulse2.setEnabled((value & 0x02) !== 0);
      }
    }

    clock() {
      // パルスタイマは 2A03 と同じくAPUサイクル(2 CPUサイクル)ごとに進める。
      // f = CPU/(16*(period+1))。毎CPUサイクルで進めると1オクターブ高くなる。
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clock();
        this.pulse2.clock();
      }
      // MMC5はエンベロープ・長さカウンタとも 240Hz 固定(APU長さカウンタの2倍速)。
      // 7457 CPUサイクル(≒240Hz)ごとに両方クロックする。
      this.frameCounter++;
      if (this.frameCounter >= 7457) {
        this.frameCounter = 0;
        this.pulse1.clockEnvelope();
        this.pulse2.clockEnvelope();
        this.pulse1.clockHalfFrame();
        this.pulse2.clockHalfFrame();
      }
    }

    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : (this.pulse1.output() / 15) * this.vol.pulse1;
      const p2 = this.mute.pulse2 ? 0 : (this.pulse2.output() / 15) * this.vol.pulse2;
      const pcm = this.mute.pcm ? 0 : (this.pcmLevel / 255) * this.vol.pcm;
      return (p1 + p2) * 0.25 + pcm * 0.30;
    }
  }

  // 鍵盤表示用: ライブチップから pulse1/pulse2/pcm のスナップショットを作る。
  // 音量はエンベロープ実出力(constantVolume=false時はenvDecay)を反映。
  Emu.snapshotMMC5 = function (chip) {
    const CPU = 1789773;
    const pulse = (p) => {
      const eff = p.constantVolume ? p.volume : p.envDecay; // 実効音量
      const freq = (p.timerPeriod >= 8) ? CPU / (16 * (p.timerPeriod + 1)) : 0;
      return {
        freq,
        vol: eff / 15,
        rawVol: eff,
        duty: p.duty,
        active: p.enabled && p.lengthCounter > 0 && eff > 0 && freq > 0
      };
    };
    return {
      pulse1: pulse(chip.pulse1),
      pulse2: pulse(chip.pulse2),
      pcm: { level: chip.pcmLevel, vol: chip.pcmLevel / 255, active: chip.pcmLevel > 0 }
    };
  };

  Emu.MMC5Audio = MMC5Audio;
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
 * FME-7 (Sunsoft 5B) 拡張音源エミュレータ
 * MML.Emu.FME7Audio
 *
 * AY-3-8910/YM2149 系。矩形波(50%)x3 + ノイズ + ハードウェアエンベロープ。
 * アドレスラッチ $C000 でレジスタ番号(0-15)を選択し、$E000 で書き込む。
 *   $00/$01,$02/$03,$04/$05 : 各chの12bitトーン周期(下位8bit/上位4bit)
 *   $06                     : ノイズ周期(5bit)
 *   $07                     : ミキサー。bit0-2=トーン有効(0で有効), bit3-5=ノイズ有効(0で有効)
 *   $08/$09/$0A             : 各chの音量。bit0-3=固定音量, bit4=1でエンベロープ制御
 *   $0B/$0C                 : 16bitエンベロープ周期
 *   $0D                     : エンベロープ形状 (bit0=Hold,bit1=Alternate,bit2=Attack,bit3=Continue)
 *
 * トーン: f = CPU/(32*period) (period=0は1扱い、+1しない)。
 * ノイズ: 17bit LFSR(タップ bit0^bit3)、f = CPU/(32*period)。
 * エンベロープ: 5bit(0-31)、1ステップ = CPU/(16*period)。
 * 音量DAC: 5bit対数(1.5dB/step、level0-1=無音)。固定音量Vは 5bit=2V+1。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 5B/AY 32段対数DAC。1.5dB/step、最大(31)=1.0、level0-1は無音。
  const AY_DAC = new Float32Array(32);
  for (let i = 0; i < 32; i++) AY_DAC[i] = i < 2 ? 0 : Math.pow(10, (i - 31) * 1.5 / 20);

  const NUM_CH = 3;
  // ★超音波のトーン(2026-09-19): 周期 2 以下は CPU/32(f=1789773/(32*周期)) で 20kHz を超える。出力サンプルの瞬間値を拾うと
  //   サンプリング周波数との差で折り返し、聞こえる高音(例: 48kHz で FME7 周期1=55.9kHz → 約7.9kHz)になる。
  //   実機ではアナログ段で平均され、方形波の半分の高さの直流(音量を変えた瞬間の「カチッ」)にしかならないので、
  //   その平均(0.5)で鳴らす。Konami の MSX ドライバはバスドラの頭を周期1+エンベロープで作る
  //   (Metal Gear 2 曲153。元の AY は約15.8kHz、FME7 へ写すと約7.9kHz に折り返して金属音になっていた)
  const ULTRA_TONE_PERIOD_MAX = 2;

  // トーン(矩形波)。period チャンネルクロックごとにレベル反転。
  class Fme7Tone {
    constructor() { this.period = 1; this.timer = 0; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.level = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1; // period クロックごとに反転
        this.level ^= 1;
      } else {
        this.timer--;
      }
    }
  }

  // ノイズ。17bit LFSR。period チャンネルクロックごとに flip をトグルし、
  // flip立ち上がりでシフト(=2*period チャンネルクロック=32*period CPUクロックごと)。
  class Fme7Noise {
    constructor() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    reset() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.flip ^= 1;
        if (this.flip) {
          const fb = (this.lfsr ^ (this.lfsr >> 3)) & 1; // タップ bit0 ^ bit3
          this.lfsr = ((this.lfsr >> 1) | (fb << 16)) & 0x1FFFF;
        }
        this.out = this.lfsr & 1;
      } else {
        this.timer--;
      }
    }
  }

  // ハードウェアエンベロープ。5bit(0-31)出力。
  class Fme7Envelope {
    constructor() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.cont = false; this.alt = false; this.hold = false; this.holding = false; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.holding = false; this.level = 0; }
    writeShape(s) {
      this.hold = (s & 1) !== 0;
      this.alt = (s & 2) !== 0;
      this.att = (s & 4) !== 0;
      this.cont = (s & 8) !== 0;
      this.step = 0;
      this.holding = false;
      this.timer = 0;
      this.level = this.att ? 0 : 31; // Attack=上昇なら0から、下降なら31から
    }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this._step();
      } else {
        this.timer--;
      }
    }
    _step() {
      if (this.holding) return;
      this.step++;
      if (this.step > 31) {
        this.step = 0;
        if (!this.cont) { this.holding = true; this.level = 0; return; }          // 一発(減衰/上昇後に無音)
        if (this.hold) { this.holding = true; this.level = this.alt ? (this.att ? 0 : 31) : (this.att ? 31 : 0); return; }
        if (this.alt) this.att = !this.att; // 交互(三角)なら方向反転
      }
      this.level = this.att ? this.step : (31 - this.step);
    }
  }

  class FME7Audio {
    constructor() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38; // 既定: トーンON・ノイズOFF
      this.tones = [new Fme7Tone(), new Fme7Tone(), new Fme7Tone()];
      this.noise = new Fme7Noise();
      this.env = new Fme7Envelope();
      this._div = 0;
      this.mute = [false, false, false];
      this.vol = [1, 1, 1];
    }

    reset() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38;
      for (const t of this.tones) t.reset();
      this.noise.reset();
      this.env.reset();
      this._div = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xC000) {
        this.addr = value & 0x0F;
      } else if (addr === 0xE000) {
        this.writeInternal(this.addr, value);
      }
    }

    writeInternal(reg, value) {
      this.regs[reg] = value;
      switch (reg) {
        case 0: case 1: this.tones[0].period = this.regs[0] | ((this.regs[1] & 0x0F) << 8); break;
        case 2: case 3: this.tones[1].period = this.regs[2] | ((this.regs[3] & 0x0F) << 8); break;
        case 4: case 5: this.tones[2].period = this.regs[4] | ((this.regs[5] & 0x0F) << 8); break;
        case 6: this.noise.period = value & 0x1F; break;
        case 11: case 12: this.env.period = this.regs[11] | (this.regs[12] << 8); break;
        case 13: this.env.writeShape(value); break;
        // 7=ミキサー, 8-10=音量 は出力時に参照
      }
    }

    clock() {
      // 内部クロックはCPUクロックの1/16
      if (++this._div >= 16) {
        this._div = 0;
        this.tones[0].clock();
        this.tones[1].clock();
        this.tones[2].clock();
        this.noise.clock();
        this.env.clock();
      }
    }

    // ch(0-2)の5bit音量レベル(0-31)。bit4でエンベロープ、固定音量Vは 2V+1。
    channelLevel(ch) {
      const volReg = this.regs[8 + ch];
      if (volReg & 0x10) return this.env.level;
      return ((volReg & 0x0F) * 2) + 1; // V=0→1(DAC上無音), V=15→31
    }

    mixSample() {
      const mix = this.regs[7];
      let sum = 0;
      for (let i = 0; i < NUM_CH; i++) {
        if (this.mute[i]) continue;
        const toneOn = ((mix >> i) & 1) === 0;
        const noiseOn = ((mix >> (i + 3)) & 1) === 0;
        const t = toneOn ? (this.tones[i].period <= ULTRA_TONE_PERIOD_MAX ? 0.5 : this.tones[i].level) : 1;
        const n = noiseOn ? this.noise.out : 1;
        if (t && n) sum += AY_DAC[this.channelLevel(i)] * this.vol[i] * t;
      }
      // 3ch分の対数振幅和。他チップとのバランスでゲイン調整。
      return sum * 0.35;
    }
  }

  // 鍵盤表示用: ライブチップから3ch分の {freq,vol,rawVol,active,noise,envMode} を作る。
  // freq=CPU/(32*period)(修正後), vol/rawVolはエンベロープ含む実効5bitレベル由来。
  Emu.snapshotFME7 = function (chip) {
    const CPU = 1789773;
    const mix = chip.regs[7];
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const period = chip.tones[i].period;
      const toneOn = ((mix >> i) & 1) === 0;
      const noiseOn = ((mix >> (i + 3)) & 1) === 0;
      const level = chip.channelLevel(i);          // 0-31
      const envMode = (chip.regs[8 + i] & 0x10) !== 0;
      const freq = (toneOn && period > 0) ? CPU / (32 * period) : 0;
      out.push({
        freq,
        vol: level / 31,
        // ★数値は**実レジスタ値**(2026-09-17のユーザー合意)。スケールがモードで変わる:
        //   ・固定音量 … 音量レジスタの4bit、**0-15**
        //   ・ハードウェアエンベロープ中(YM2149系のこの機能) … 5bitレベル、**0-31**
        //   内部は常に32段(channelLevel が固定音量時に (nibble*2)+1 で写す)ので、表示だけ切り替える。
        //   0-31 のときは既存の黄色表示(envMode)が「レジスタそのままではない」印になる。
        rawVol: envMode ? level : (chip.regs[8 + i] & 0x0F),
        rawVolMax: envMode ? 31 : 15,
        active: (toneOn ? (level > 0 && freq > 0) : (noiseOn && level > 0)),
        noise: noiseOn,
        envMode
      });
    }
    return out;
  };

  Emu.FME7Audio = FME7Audio;
})(globalThis);

/*
 * FDS (ディスクシステム) 拡張音源エミュレータ
 * MML.Emu.FDSAudio
 *
 * 64サンプル(6bit)のウェーブテーブル波形メモリ音源 + ボリュームエンベロープ + ピッチモジュレータ。
 *
 *   $4040-$407F : 波形メモリ(6bit, $4089 bit7=1 の間のみ書き込み可)
 *   $4080       : ボリュームエンベロープ (bit7=1:直接指定, bit6=方向, bits0-5=速度/ゲイン)
 *   $4082       : 周波数下位8bit
 *   $4083       : bits0-3=周波数上位4bit, bit6=エンベロープ停止, bit7=1で消音/波形リセット
 *   $4084       : モジュレータゲイン/エンベロープ (同形式)。ゲインはピッチ変調の深さを決める(0=変調なし)
 *   $4085       : モジュレータカウンタ直接設定 (7bit符号付き)
 *   $4086       : モジュレータ周波数下位8bit
 *   $4087       : bits0-3=モジュレータ周波数上位4bit, bit7=1で停止
 *   $4088       : モジュレータテーブル書き込み (停止中のみ有効, 下位3bit)。再生位置に書いて2ステップ進む
 *
 * 変調ユニットは NSFPlay 2.6 nes_fds.cpp(rainwarrior、実機検証済み)に合わせてある(2026-09-22)。
 * リファレンスWAV(NSFPlay、FDSのみ・LPF無し)との0.1秒窓スペクトル類似度で採点した。要点:
 *   - テーブルは32項目だが位置は64ステップ(1項目を2回ずつ)。16bitの端数アキュムレータ
 *   - カウンタは7bitで折り返す(63+1=-64)。クランプではない
 *   - 変調量 = counter×gain を >>4(端数があり結果のbit7が0なら 負:-1/正:+2 の丸め)、
 *     -64..191 へ8bit折り返し、×freq/64(四捨五入)。折り返しは実機の挙動で、深いFMでは
 *     周波数が搬送波の最大4倍まで跳ねる(Golf US Course 3秒目で実際に鳴っている音)
 *   - 変調式は $4087 で停止中も常に効く($4085 直書きのベンド)。停止はテーブルの歩進を
 *     止めて端数を0にするだけで、位置は保つ。$4088 は再生位置へ書く
 * 以前は「1項目1回・クランプ・折り返し無し(Math.max(0))・停止中は無効」で、深さが半分、
 * 深いFMで別の音になっていた。
 *   $4089       : bit7=波形メモリ書き込み許可, bits0-1=マスターボリューム
 *   $408A       : エンベロープ速度マスタ (0=最速, 値が大きいほど遅い)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // NESdev 準拠: マスターボリューム 0=全量, 1=2/3, 2=2/4, 3=2/5
  const MASTER_VOLUME_SCALE = [1.0, 2 / 3, 2 / 4, 2 / 5];

  // モジュレータテーブルの3bitエントリをカウンタ増分に変換
  // 0=+0, 1=+1, 2=+2, 3=+4, 4=リセット(0), 5=-4, 6=-2, 7=-1
  const MOD_TABLE_DELTA = [0, 1, 2, 4, 0, -4, -2, -1];
  const MOD_STEPS = 64;                  // 変調テーブルの位置は64ステップ(32項目×2)
  const MOD_STEP_CYCLES = 65536;         // 1ステップ = 65536/modFreq CPUサイクル

  class FDSAudio {
    constructor() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;

      // ボリュームエンベロープ
      this.volEnvEnabled = false; // bit7=0 のとき有効
      this.volEnvIncrease = false; // bit6
      this.volEnvSpeed = 0;        // bits0-5 (リロード値)
      this.volGain = 32;           // 実際の出力ゲイン (0-32)
      this.volEnvTimer = 0;

      // メインチャンネル
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false; // $4083 bit6
      this.phaseAcc = 0;
      this.effectiveFreq = 0; // モジュレーション適用後の実ピッチ(内部単位、鍵盤表示用)

      // モジュレータエンベロープ
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;

      // モジュレータ
      this.modFreq = 0;
      this.modEnabled = false; // bit7=0 のとき有効
      this.modPhaseAcc = 0;               // 位置の端数(0..65535)
      this.modTable = new Uint8Array(MOD_STEPS); // 生3bit値 (0-7)。$4088 1回で2項目埋まる
      this.modTablePos = 0;   // 再生位置(0..63)。$4088 の書き込み位置も兼ねる
      this.modCounter = 0;    // 現在のモジュレータ出力値 (-64..63、7bit折り返し)

      // エンベロープマスタ速度レジスタ ($408A)
      // FDS 電源ON時デフォルト = $E8 = 232 (実機ハードウェア仕様)
      // ゲームが $408A を書かない場合もこの値が使われる
      this.envRate = 0xE8;
      this.envRateClock = 0;

      this.mute = { wave: false };
      this.vol = { wave: 1 };
    }

    reset() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;
      this.volEnvEnabled = false;
      this.volEnvIncrease = false;
      this.volEnvSpeed = 0;
      this.volGain = 32;
      this.volEnvTimer = 0;
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false;
      this.phaseAcc = 0;
      this.effectiveFreq = 0;
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;
      this.modFreq = 0;
      this.modEnabled = false;
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(MOD_STEPS);
      this.modTablePos = 0;
      this.modCounter = 0;
      this.envRate = 0xE8; // FDS 電源ON時デフォルト
      this.envRateClock = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x4040 && addr <= 0x407F) {
        if (this.waveWriteEnable) this.wave[addr - 0x4040] = value & 0x3F;
      } else if (addr === 0x4080) {
        if (value & 0x80) {
          // 直接指定モード: bits0-5 をゲインとして即時反映(6bit生値を保持。出力段で32に
          // 頭打ちするのはmixSample側。エンベロープ減衰は書かれた値から数え始めるため)
          this.volEnvEnabled = false;
          this.volGain = value & 0x3F;
        } else {
          // エンベロープモード
          this.volEnvEnabled = true;
          this.volEnvIncrease = (value & 0x40) !== 0;
          this.volEnvSpeed = value & 0x3F;
          this.volEnvTimer = this.volEnvSpeed + 1;
        }
      } else if (addr === 0x4082) {
        this.freq = (this.freq & 0x0F00) | value;
      } else if (addr === 0x4083) {
        this.freq = (this.freq & 0x00FF) | ((value & 0x0F) << 8);
        this.envHalt = (value & 0x40) !== 0;
        this.disabled = (value & 0x80) !== 0;
        if (this.disabled) this.phaseAcc = 0;
        if (this.envHalt) { this.volEnvTimer = this.volEnvSpeed + 1; this.modEnvTimer = this.modEnvSpeed + 1; }
      } else if (addr === 0x4084) {
        if (value & 0x80) {
          this.modEnvEnabled = false;
          this.modGain = value & 0x3F;
        } else {
          this.modEnvEnabled = true;
          this.modEnvIncrease = (value & 0x40) !== 0;
          this.modEnvSpeed = value & 0x3F;
          this.modEnvTimer = this.modEnvSpeed + 1;
        }
      } else if (addr === 0x4085) {
        // モジュレータカウンタを直接設定 (7bit符号付き)
        const v = value & 0x7F;
        this.modCounter = (v >= 64) ? (v - 128) : v;
      } else if (addr === 0x4086) {
        this.modFreq = (this.modFreq & 0x0F00) | value;
      } else if (addr === 0x4087) {
        this.modFreq = (this.modFreq & 0x00FF) | ((value & 0x0F) << 8);
        this.modEnabled = (value & 0x80) === 0;
        // 停止時は位置の端数だけ0にする(再生位置は保つ。変調式は停止中も効き続ける)
        if (!this.modEnabled) this.modPhaseAcc = 0;
      } else if (addr === 0x4088) {
        // モジュレータ停止中に、現在の再生位置へ1項目(=2ステップ分)書いて進める
        if (!this.modEnabled) {
          this.modTable[this.modTablePos] = value & 0x07;
          this.modTablePos = (this.modTablePos + 1) & (MOD_STEPS - 1);
          this.modTable[this.modTablePos] = value & 0x07;
          this.modTablePos = (this.modTablePos + 1) & (MOD_STEPS - 1);
        }
      } else if (addr === 0x4089) {
        this.waveWriteEnable = (value & 0x80) !== 0;
        this.masterVolume = value & 0x03;
      } else if (addr === 0x408A) {
        this.envRate = value;
        this.envRateClock = 0;
      }
    }

    // バス読み出し ($4090 = ボリュームエンベロープ出力, $4092 = モジュレータエンベロープ出力)
    readRegister(addr) {
      if (addr === 0x4090) return this.volGain & 0x3F;
      if (addr === 0x4092) return this.modGain & 0x3F;
      return 0;
    }

    // エンベロープを1ティック進める (エンベロープマスタ速度に応じて呼ばれる)
    _clockEnvelope() {
      if (this.disabled) return; // $4083 bit7=1 の間はどちらのエンベロープも進まない
      // ボリュームエンベロープ
      if (this.volEnvEnabled && !this.envHalt) {
        this.volEnvTimer--;
        if (this.volEnvTimer <= 0) {
          this.volEnvTimer = this.volEnvSpeed + 1;
          if (this.volEnvIncrease) {
            if (this.volGain < 32) this.volGain++;
          } else {
            if (this.volGain > 0) this.volGain--;
          }
        }
      }
      // モジュレータエンベロープ
      if (this.modEnvEnabled && !this.envHalt) {
        this.modEnvTimer--;
        if (this.modEnvTimer <= 0) {
          this.modEnvTimer = this.modEnvSpeed + 1;
          if (this.modEnvIncrease) {
            if (this.modGain < 32) this.modGain++;
          } else {
            if (this.modGain > 0) this.modGain--;
          }
        }
      }
    }

    clock() {
      // エンベロープクロック: NESdev "c = 8 * (e+1) * (m+1)" のm(マスタ速度)部分。
      // period = 8 * (envRate + 1) CPU サイクルに1回(envRate=0→8, envRate=$E8=232→1864 cycles)。
      // 旧実装は envRate×8 (envRate=0のみ特別扱い)で、envRate>0全域で周期が短すぎた
      // (envRate=1で本来16のところ8になる等、小さい値ほど相対誤差が大きいバグ)
      this.envRateClock++;
      const envPeriod = (this.envRate + 1) * 8;
      if (this.envRateClock >= envPeriod) {
        this.envRateClock = 0;
        this._clockEnvelope();
      }

      // モジュレータテーブルの歩進(1ステップ = 65536/modFreq サイクル、64ステップで1周。
      // レジスタログ実測: modFreq=16 で 6.83 Hz ビブラート → 16×1789773/(64×65536)=6.83Hz ✓)
      this._stepMod(1);

      // メインチャンネル
      if (this.disabled || this.freq === 0) return;
      // 鍵盤表示等の外部参照用(実際に揺れているピッチをHz換算する際、$4082/4083の
      // 生の周期値ではなくこちらを使う。単位はthis.freqと同じ内部単位)
      const effectiveFreq = this._modulatedFreq();
      this.effectiveFreq = effectiveFreq;
      this.phaseAcc = (this.phaseAcc + effectiveFreq) & 0x3FFFFF; // 64サンプル × 16bit端数
    }

    // 変調テーブルを cycles サイクル分歩進させる(停止中は進まない)
    _stepMod(cycles) {
      if (!this.modEnabled || this.modFreq === 0) return;
      this.modPhaseAcc += this.modFreq * cycles;
      while (this.modPhaseAcc >= MOD_STEP_CYCLES) {
        this.modPhaseAcc -= MOD_STEP_CYCLES;
        const raw = this.modTable[this.modTablePos];
        this.modTablePos = (this.modTablePos + 1) & (MOD_STEPS - 1);
        if (raw === 4) {
          this.modCounter = 0; // リセット
        } else {
          let c = this.modCounter + MOD_TABLE_DELTA[raw];
          if (c > 63) c -= 128; else if (c < -64) c += 128; // 7bit折り返し
          this.modCounter = c;
        }
      }
    }

    // 変調適用後の周波数(内部単位)。NSFPlay nes_fds.cpp の "complex mod calculation" と同じ式。
    // $4087 で停止中でも効く(カウンタは止まったまま = $4085 直書きの固定ベンド)
    _modulatedFreq() { return FDSAudio.modulatedFreq(this.freq, this.modCounter, this.modGain); }

    /**
     * 変調式そのもの(純関数)。freq=$4082/83 の12bit周期値、counter=モジュレータカウンタ(-64..63)、
     * gain=$4084 のゲイン。戻り値は変調後の周期値(内部単位、freq と同じ)。
     * nsf2mml($4085 直書きの固定ベンドを音符/Dへ落とす)からも使う。
     */
    static modulatedFreq(freq, counter, gain) {
      if (gain === 0 || counter === 0) return freq;
      let temp = counter * gain;
      const rem = temp & 0x0F;
      temp >>= 4; // 算術シフト(符号保持)
      if (rem > 0 && (temp & 0x80) === 0) temp += (counter < 0) ? -1 : 2;
      while (temp >= 192) temp -= 256; // 8bitの折り返し(-64..191)
      while (temp < -64) temp += 256;
      temp = freq * temp;
      const r2 = temp & 0x3F;
      temp >>= 6;
      if (r2 >= 32) temp += 1;
      return freq + temp; // temp >= -freq なので負にならない
    }

    /**
     * 表示専用の早送り: 変調ユニットとエンベロープだけを cycles CPUサイクル分進め、その間の
     * 実効周波数(effectiveFreqと同じ内部単位)の平均/最小/最大を返す。音は作らない。
     * ピアノロール構築(src/ui/keyboard.js buildFdsModSnapshots)が writeLog から
     * 「フレーム内でピッチがどれだけ動いたか」を復元するのに使う。1フレーム=約29780サイクルを
     * clock()で1サイクルずつ回すと1曲で数億回になるため、STEP サイクル刻みの粗い歩進にしてある
     * (変調テーブルの歩進は最速でも16サイクルに1回なので、表示用には十分)。
     * 歩進と変調式は clock() と同じ _stepMod / _modulatedFreq を使う(式の二重管理はしない)。
     * @returns {{mean:number,min:number,max:number}|null} 発音していない/変調が効いていない間は null
     */
    advanceForDisplay(cycles) {
      const STEP = 16;
      const envPeriod = (this.envRate + 1) * 8;
      let sum = 0, n = 0, min = Infinity, max = -Infinity;
      for (let c = 0; c < cycles; c += STEP) {
        const step = Math.min(STEP, cycles - c); // 端数を切り上げない(切り上げると clock() と位置がずれていく)
        this.envRateClock += step;
        while (this.envRateClock >= envPeriod) { this.envRateClock -= envPeriod; this._clockEnvelope(); }
        this._stepMod(step);
        if (this.disabled || this.freq === 0) continue;
        const eff = this._modulatedFreq();
        sum += eff; n++;
        if (eff < min) min = eff;
        if (eff > max) max = eff;
      }
      return n > 0 ? { mean: sum / n, min, max } : null;
    }

    mixSample() {
      if (this.disabled || this.mute.wave) return 0;
      const index = Math.floor(this.phaseAcc / 65536) % 64;
      const sample = this.wave[index] & 0x3F; // 0-63
      const centered = sample - 32; // -32..31
      // 実機の有効ゲインは32で頭打ち(33-63を書いても32相当。以前はクランプ漏れで最大約2倍
      // 大きく鳴っていた、2026-08-24)
      const volScale = Math.min(32, this.volGain) / 32;
      const masterScale = MASTER_VOLUME_SCALE[this.masterVolume & 0x03];
      // FDS 混合係数: NES 実機の抵抗網 (FDS=47Ω直列, 2A03=100Ω直列, 負荷=39Ω) から
      // FDS 出力は 2A03 の約 39% 程度に相当。係数 0.20 は実機バランスに合わせた値。
      return (centered / 32) * volScale * masterScale * 0.20 * this.vol.wave;
    }
  }

  Emu.FDSAudio = FDSAudio;
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
    if (rom.fds && Emu.FdsDisk) return Emu.FdsDisk.describe(rom);
    return `mapper ${rom.mapper}${rom.submapper ? '.' + rom.submapper : ''}, PRG ${rom.prg.length >> 10}K, CHR ${rom.chr ? (rom.chr.length >> 10) + 'K' : 'RAM ' + (rom.chrRamSize >> 10) + 'K'}, ` +
      `mirror ${rom.mirroring}${rom.battery ? ', battery' : ''}${rom.nes2 ? ', NES2.0' : ''}`;
  };

  Emu.INES = INES;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * NES マッパー (MML.Emu.NesMappers) — 自前 NES エミュレータのバンク機構
 *
 * 対応: 0 NROM / 1 MMC1 / 2 UxROM / 3 CNROM / 4 MMC3 / 5 MMC5 / 7 AxROM / 9,10 MMC2・MMC4 / 16,153,159 Bandai FCG・LZ93D50 /
 *       18 Jaleco SS88006 / 19 Namco 163 / 21,22,23,25 VRC2・VRC4 / 24,26 VRC6 / 32 Irem G-101 / 33,48 Taito TC0190・TC0690 /
 *       34 BNROM・NINA-001 / 65 Irem H3001 / 66 GxROM / 67,68 Sunsoft-3・4 / 69 Sunsoft FME-7・5B / 70,152 Bandai 74161 /
 *       72,92 Jaleco JF-17・19 / 73 VRC3 / 75 VRC1 / 76,88,95,154 Namco 108 派生 / 77 Irem LROG017 / 78 Jaleco JF-16 /
 *       80,82 Taito X1-005・X1-017 / 85 VRC7 / 86,87,140 Jaleco JF-13 他 / 89,93 Sunsoft-2 / 94,97,180 UxROM 派生 /
 *       184 Sunsoft-1 / 185 CNROM 保護 / 206 Namco 108(DxROM) / 210 Namco 175・340。
 * 拡張音源つきの基板(5/19/24/26/69/85)は NSF 用の音源(Emu.VRC6Audio/VRC7Audio/MMC5Audio/N163Audio/FME7Audio)を
 * そのまま this.audio に挿し、extBits(NSF ヘッダと同じビット。録音の NESX ヘッダ用)を立てる。
 *   audioAddr(addr): CPU の書き込み番地を音源レジスタの正規の番地(NSF/VGM の慣例)に直す。音源でなければ -1。
 *     VRC6b(26)は A0/A1 を入れ替えて VRC6a の番地に、VRC7 は未使用のアドレス線を無視、5B は $C000/$E000 に畳む
 *     (tools/mesen/vgm-recorder.lua と同じ規則。録音のフレーム比較が同じ番地で揃う)。
 *   audioReadAddr(addr): 副作用のある読み出し(N163 $4800)。
 *   audioImage(): 録音開始時に先頭へ置く「今の音源の状態」を書き込み列で返す(影レジスタから。Mesen の録音と同じ順)。
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
      this.ramRead = true; this.ramWrite = true; // PRG RAM($6000-$7FFF)の保護ビット(基板ごとに書き換える。無効なら読みは open bus、書きは捨てる)
      this.extBits = 0;
      this.ppu = null;        // PPU が自分を入れる(MMC5 が描画の位相を見る)
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
      if (addr >= 0x6000) return this.ramRead ? this.prgRam[(addr - 0x6000) % this.prgRam.length] : -1;
      return -1;
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) this.writeReg(addr, v);
      else if (addr >= 0x6000) { if (this.ramWrite) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v; }
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
    audioAddr() { return -1; }
    audioReadAddr() { return -1; }
    audioImage() { return []; }
  }

  // VRC4/VRC6/VRC7 共通の IRQ カウンタ(スキャンライン モード=341/3 サイクルごと、サイクル モード=毎サイクル)
  class VrcIrq {
    constructor() { this.latch = 0; this.counter = 0; this.enable = false; this.enableAfterAck = false; this.cycleMode = false; this.prescaler = 341; this.flag = false; }
    writeLatch(v) { this.latch = v; }
    writeControl(v) {
      this.enableAfterAck = (v & 1) !== 0; this.enable = (v & 2) !== 0; this.cycleMode = (v & 4) !== 0;
      this.flag = false;
      if (this.enable) { this.counter = this.latch; this.prescaler = 341; }
    }
    ack() { this.flag = false; this.enable = this.enableAfterAck; }
    clock(cycles) {
      if (!this.enable) return;
      for (let c = 0; c < cycles; c++) {
        if (!this.cycleMode) { this.prescaler -= 3; if (this.prescaler > 0) continue; this.prescaler += 341; }
        if (this.counter === 0xFF) { this.counter = this.latch; this.flag = true; }
        else this.counter++;
      }
    }
  }

  // 0: NROM
  class NROM extends Mapper {}

  // 1: MMC1(シフトレジスタ 5 回書き)
  //   大容量基板(Mesen と同じ扱い): PRG 512K(SUROM)は CHR レジスタの bit4 が PRG の 256K 側を選ぶ。PRG RAM が 32K(SXROM)なら
  //   CHR レジスタの bit2-3 が 8K バンク、16K(SOROM)なら bit3。CHR 4K モードで最後に書いたのが $C000 ならそちらのレジスタを使う。
  //   サブマッパー 5(SEROM/SHROM)は PRG 32K 固定。155(MMC1A)も同じ(PRG RAM の無効ビットはどちらでも見ない)。
  //   未対応: 連続サイクルの二重書き無視(本体 CPU は RMW 命令でも 1 回しか書かないので実害は無い)
  class MMC1 extends Mapper {
    constructor(rom) {
      super(rom);
      this.shift = 0x10; this.control = 0x0C; this.chr0 = 0; this.chr1 = 0; this.prgReg = 0; this.lastChr = 0;
      this.fixed32 = (rom.submapper | 0) === 5;
      this.ramBanks = this.prgRam.length >> 13; // 1/2/4
      this.ramBank = 0;
      this.apply();
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[(this.ramBank << 13) | (addr & 0x1FFF)];
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) this.writeReg(addr, v);
      else if (addr >= 0x6000) this.prgRam[(this.ramBank << 13) | (addr & 0x1FFF)] = v;
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
        case 1: this.chr0 = value; this.lastChr = 0; break;
        case 2: this.chr1 = value; this.lastChr = 1; break;
        case 3: this.prgReg = value; break;
      }
      this.apply();
    }
    apply() {
      this.setMirroring(['1A', '1B', 'V', 'H'][this.control & 3]);
      const chr4k = (this.control & 0x10) !== 0;
      const extra = (this.lastChr === 1 && chr4k) ? this.chr1 : this.chr0;
      const outer = this.prg.length === 0x80000 ? (extra & 0x10) : 0; // 512K: 16K バンク番号の bit4
      this.ramBank = this.ramBanks >= 4 ? (extra >> 2) & 3 : this.ramBanks === 2 ? (extra >> 3) & 1 : 0;
      const prgMode = (this.control >> 2) & 3, prg = (this.prgReg & 0x0F) | outer;
      if (this.fixed32) this.setPrg32(0);
      else if (prgMode < 2) this.setPrg32(prg >> 1);
      else if (prgMode === 2) { this.setPrg16(0, outer); this.setPrg16(1, prg); }
      else { this.setPrg16(0, prg); this.setPrg16(1, 0x0F | outer); }
      if (chr4k) { this.setChr1(0, this.chr0 * 4); this.setChr1(1, this.chr0 * 4 + 1); this.setChr1(2, this.chr0 * 4 + 2); this.setChr1(3, this.chr0 * 4 + 3);
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
        case 0xA001: this.ramRead = (v & 0x80) !== 0; this.ramWrite = (v & 0xC0) === 0x80; break; // bit7 有効、bit6 書き込み禁止(MMC6 は別)
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
    audioAddr(addr) { return (addr & 0xF800) === 0x4800 ? 0x4800 : (addr & 0xF800) === 0xF800 ? 0xF800 : -1; }
    audioReadAddr(addr) { return (addr & 0xF800) === 0x4800 ? 0x4800 : -1; }
    audioImage() {
      const au = this.audio, out = [];
      if (!au || !au.ram || au.ram.length !== 128) return out;
      out.push({ addr: 0xF800, value: 0x80 });
      for (let i = 0; i < 128; i++) out.push({ addr: 0x4800, value: au.ram[i] });
      out.push({ addr: 0xF800, value: (au.autoInc ? 0x80 : 0) | (au.addr & 0x7F) });
      return out;
    }
    cpuRead(addr) {
      if ((addr & 0xF800) === 0x4800 && this.audio) return this.audio.readData();
      if (addr === 0x5000) return this.irqCounter & 0xFF;
      if (addr === 0x5800) return ((this.irqCounter >> 8) & 0x7F) | (this.irqEnable ? 0x80 : 0);
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if ((addr & 0xF800) === 0x4800) { if (this.audio) this.audio.writeRegister(0x4800, v); return; }
      if (addr === 0x5000) { this.irqCounter = (this.irqCounter & 0x7F00) | v; this.irqFlag = false; return; }
      if (addr === 0x5800) { this.irqCounter = (this.irqCounter & 0x00FF) | ((v & 0x7F) << 8); this.irqEnable = (v & 0x80) !== 0; this.irqFlag = false; return; }
      if (addr >= 0x6000 && addr < 0x8000) { // 書き込み保護: $F800 bit6 が立ち、その 2K の禁止ビット(bit0-3)が 0 の時だけ書ける
        const p = this.ramProtect | 0;
        if ((p & 0x40) && !(p & (1 << ((addr >> 11) & 3)))) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
        return;
      }
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
      if (hi === 0xF800) { if (this.audio) this.audio.writeRegister(0xF800, v); this.ramProtect = v; } // 音源アドレス+PRG RAM 書き込み保護(bit6=0 で全体禁止、bit0-3 で 2K ごとに禁止)
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

  // 24/26: Konami VRC6(PRG 16K+8K 切替、CHR 1K×8、IRQ、音源。26 は A0/A1 が入れ替わった配線)
  //   $B003: bit0-1 CHR モード(0=1K×8、1=2K×4、2/3=1K×4+2K×2)、bit5 2K の下位ビット固定、bit2-3 ミラーリング、bit7 PRG RAM 有効。
  //   未対応: bit4 のネームテーブルを CHR ROM から出す配線
  class VRC6 extends Mapper {
    constructor(rom) {
      super(rom);
      this.swapA0A1 = rom.mapper === 26;
      this.audio = Emu.VRC6Audio ? new Emu.VRC6Audio() : null;
      this.extBits = 0x01;
      this.irq = new VrcIrq();
      this.shadow = new Int16Array(0x10).fill(-1); // 音源 9 レジスタの影(index = (hi-9)*4+lo)
      this.chrRegs = new Uint8Array(8); this.bankMode = 0; // $B003 の値(bit0-1 CHR モード、bit5 2K の下位ビット固定、bit7 PRG RAM 有効)
      this.ramRead = this.ramWrite = false;
      this.setPrg16(0, 0); this.setPrg8(2, -2); this.setPrg8(3, -1);
    }
    // CHR: モード 0=1K×8(R0-R7)、1=2K×4(R0-R3)、2/3=1K×4(R0-R3)+2K×2(R4,R5)。2K は bit5 が立つと下位ビットを 0/1 に固定、
    //   立たなければ R の値そのまま(=同じ 1K が 2 回)。未対応: bit4 のネームテーブルを CHR ROM から出す配線(使うソフトは稀)
    applyChr() {
      const r = this.chrRegs, m = this.bankMode, mask = (m & 0x20) ? 0xFE : 0xFF, or = (m & 0x20) ? 1 : 0;
      const two = (slot, v) => { this.setChr1(slot, v & mask); this.setChr1(slot + 1, (v & mask) | or); };
      switch (m & 3) {
        case 0: for (let i = 0; i < 8; i++) this.setChr1(i, r[i]); break;
        case 1: for (let i = 0; i < 4; i++) two(i * 2, r[i]); break;
        default: for (let i = 0; i < 4; i++) this.setChr1(i, r[i]); two(4, r[4]); two(6, r[5]);
      }
      // ネームテーブル(CIRAM): bit5 が立った通常の組み合わせは bit2-3 のミラーリング、それ以外は R4-R7 の bit0 がページを選ぶ
      // (NesDev の表。bit4=1 で CHR ROM をネームテーブルに出す配線は未対応で、CIRAM として扱う)
      switch (m & 0x2F) {
        case 0x20: case 0x27: this.setMirroring('V'); break;
        case 0x23: case 0x24: this.setMirroring('H'); break;
        case 0x28: case 0x2F: this.setMirroring('1A'); break;
        case 0x2B: case 0x2C: this.setMirroring('1B'); break;
        default: {
          const b = (i) => r[i] & 1;
          switch (m & 7) {
            case 0: case 6: case 7: this.ntMap = [b(6), b(6), b(7), b(7)]; break;
            case 1: case 5: this.ntMap = [b(4), b(5), b(6), b(7)]; break;
            default: this.ntMap = [b(6), b(7), b(6), b(7)];
          }
        }
      }
    }
    _canon(addr) { return this.swapA0A1 ? (addr & 0xFFFC) | ((addr & 1) << 1) | ((addr >> 1) & 1) : addr; }
    audioAddr(addr) {
      addr = this._canon(addr);
      const hi = addr & 0xF000, lo = addr & 0x0FFF;
      return (hi === 0x9000 || hi === 0xA000 || hi === 0xB000) && lo <= 2 ? addr : -1;
    }
    audioImage() {
      const out = [];
      for (let i = 0; i < 12; i++) { const v = this.shadow[i]; if (v >= 0) out.push({ addr: 0x9000 + ((i >> 2) << 12) + (i & 3), value: v }); }
      return out;
    }
    writeReg(addr, v) {
      addr = this._canon(addr);
      const hi = addr & 0xF000, lo = addr & 3;
      switch (hi) {
        case 0x8000: this.setPrg16(0, v & 0x0F); break;
        case 0x9000: case 0xA000:
          if (lo <= 2) { this.shadow[((hi - 0x9000) >> 12) * 4 + lo] = v; if (this.audio) this.audio.writeRegister(hi + lo, v); }
          break; // $9003(周波数制御)は未対応
        case 0xB000:
          if (lo <= 2) { this.shadow[8 + lo] = v; if (this.audio) this.audio.writeRegister(hi + lo, v); }
          else { this.bankMode = v; this.ramRead = this.ramWrite = (v & 0x80) !== 0; this.applyChr(); }
          break;
        case 0xC000: this.setPrg8(2, v & 0x1F); break;
        case 0xD000: this.chrRegs[lo] = v; this.applyChr(); break;
        case 0xE000: this.chrRegs[4 + lo] = v; this.applyChr(); break;
        case 0xF000:
          if (lo === 0) this.irq.writeLatch(v);
          else if (lo === 1) this.irq.writeControl(v);
          else if (lo === 2) this.irq.ack();
          break;
      }
    }
    cpuClock(cycles) { this.irq.clock(cycles); }
    irqPending() { return this.irq.flag; }
  }

  // 85: Konami VRC7(PRG 8K×3 切替、CHR 1K×8、IRQ、FM 音源 $9010/$9030)。
  //   レジスタの第 2 ビットは A3($x008、VRC7b)でも A4($x010、VRC7a)でも受ける。未対応: PRG RAM 保護
  class VRC7 extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.VRC7Audio ? new Emu.VRC7Audio() : null;
      this.extBits = 0x02;
      this.irq = new VrcIrq();
      this.fmAddr = 0;
      this.fmShadow = new Int16Array(0x40).fill(-1);
      this.setPrg8(0, 0); this.setPrg8(1, 1); this.setPrg8(2, 2); this.setPrg8(3, -1);
    }
    audioAddr(addr) { const m = addr & 0xF030; return m === 0x9010 ? 0x9010 : m === 0x9030 ? 0x9030 : -1; }
    audioImage() {
      const out = [];
      for (let r = 0; r < 0x40; r++) if (this.fmShadow[r] >= 0) { out.push({ addr: 0x9010, value: r }); out.push({ addr: 0x9030, value: this.fmShadow[r] }); }
      return out;
    }
    writeReg(addr, v) {
      const hi = addr & 0xF000, second = (addr & 0x18) !== 0;
      if (hi === 0x9000) {
        const m = addr & 0x30;
        if (m === 0x10) { this.fmAddr = v & 0x3F; if (this.audio) this.audio.writeRegister(0x9010, v); return; }
        if (m === 0x30) { this.fmShadow[this.fmAddr] = v; if (this.audio) this.audio.writeRegister(0x9030, v); return; }
        if (!second) this.setPrg8(2, v & 0x3F);
        return;
      }
      switch (hi) {
        case 0x8000: this.setPrg8(second ? 1 : 0, v & 0x3F); break;
        case 0xA000: case 0xB000: case 0xC000: case 0xD000:
          this.setChr1(((hi - 0xA000) >> 12) * 2 + (second ? 1 : 0), v); break;
        case 0xE000:
          if (!second) {
            this.setMirroring(['V', 'H', '1A', '1B'][v & 3]);
            if ((v & 0x40) && this.audio) this.audio.reset(); // bit6: 音源を黙らせる(リセット)
            this.ramRead = this.ramWrite = (v & 0x80) !== 0;  // bit7: PRG RAM 有効
          } else this.irq.writeLatch(v);
          break;
        case 0xF000: if (!second) this.irq.writeControl(v); else this.irq.ack(); break;
      }
    }
    cpuClock(cycles) { this.irq.clock(cycles); }
    irqPending() { return this.irq.flag; }
  }

  // 21/22/23/25: Konami VRC2 / VRC4(PRG 8K×2 切替、CHR 1K×8 を下位 4bit と上位 5bit の 2 レジスタで、ミラーリング、
  //   VRC4 は PRG スワップ($9002 bit1)と IRQ)。4 つのマッパー番号はレジスタ選択に使うアドレス線が違うだけ:
  //     21: VRC4a=A1,A2 / VRC4c=A6,A7     22: VRC2a=A1,A0(CHR は 1bit 右シフト)
  //     23: VRC2b=A0,A1 / VRC4e=A2,A3 / VRC4f=A0,A1     25: VRC2c=A1,A0 / VRC4b=A1,A0 / VRC4d=A3,A2
  //   NES 2.0 のサブマッパー(21: 1=a 2=c、23: 1=f 2=e 3=2b、25: 1=b 2=d 3=2c)があればその配線、無ければ Mesen と同じく
  //   その番号の候補の線を OR して受ける(市販ソフトはどちらかの線しか使わないので両方効かせて困らない)。
  //   VRC2 と確定している時(22、または 23/25 のサブマッパー 3)だけミラーリングを 1bit、IRQ 無し、$9002 もミラーリングにする。
  //   サブマッパー無しの 23/25 は VRC4 の意味論(Mesen は 23 を VRC2b 扱いにするが、VRC2 のソフトは $9002 に書かず
  //   IRQ も使わないので VRC4 側に倒しておく方が両方動く)。$6000-$6FFF は VRC2 の 1bit ラッチの代わりに PRG RAM を
  //   そのまま置く(読み返した bit0 はラッチと同じ値になる)。未対応: PRG RAM 保護。
  class VRC24 extends Mapper {
    constructor(rom) {
      super(rom);
      const m = rom.mapper, sub = rom.submapper | 0;
      // 線の取り方: [A0 になるビット列, A1 になるビット列](ビット番号の配列。複数なら OR)
      let lines, vrc2 = false;
      if (m === 22) { lines = [[1], [0]]; vrc2 = true; }
      else if (m === 21) lines = sub === 1 ? [[1], [2]] : sub === 2 ? [[6], [7]] : [[1, 6], [2, 7]];
      else if (m === 23) { lines = sub === 2 ? [[2], [3]] : sub === 1 || sub === 3 ? [[0], [1]] : [[0, 2], [1, 3]]; vrc2 = sub === 3; }
      else { lines = sub === 2 ? [[3], [2]] : sub === 1 || sub === 3 ? [[1], [0]] : [[1, 3], [0, 2]]; vrc2 = sub === 3; }
      this.lines = lines; this.vrc2 = vrc2; this.chrShift = m === 22 ? 1 : 0;
      this.irq = vrc2 ? null : new VrcIrq();
      this.prgReg = [0, 0]; this.prgMode = 0;
      this.chrLo = new Uint8Array(8); this.chrHi = new Uint8Array(8);
      this.apply();
    }
    _canon(addr) {
      let a0 = 0, a1 = 0;
      for (const b of this.lines[0]) a0 |= (addr >> b) & 1;
      for (const b of this.lines[1]) a1 |= (addr >> b) & 1;
      return (addr & 0xF000) | (a1 << 1) | a0;
    }
    writeReg(addr, v) {
      addr = this._canon(addr);
      const hi = addr & 0xF000, lo = addr & 3;
      switch (hi) {
        case 0x8000: this.prgReg[0] = v & 0x1F; break;
        case 0x9000:
          if (this.vrc2) this.setMirroring(['V', 'H'][v & 1]);
          else if (lo <= 1) this.setMirroring(['V', 'H', '1A', '1B'][v & 3]);
          else this.prgMode = (v >> 1) & 1;
          break;
        case 0xA000: this.prgReg[1] = v & 0x1F; break;
        case 0xB000: case 0xC000: case 0xD000: case 0xE000: {
          const reg = ((hi - 0xB000) >> 12) * 2 + (lo >> 1);
          if (lo & 1) this.chrHi[reg] = v & 0x1F; else this.chrLo[reg] = v & 0x0F;
          break;
        }
        case 0xF000:
          if (!this.irq) break;
          if (lo === 0) this.irq.writeLatch((this.irq.latch & 0xF0) | (v & 0x0F));
          else if (lo === 1) this.irq.writeLatch((this.irq.latch & 0x0F) | ((v & 0x0F) << 4));
          else if (lo === 2) this.irq.writeControl(v);
          else this.irq.ack();
          break;
      }
      this.apply();
    }
    apply() {
      for (let i = 0; i < 8; i++) this.setChr1(i, (this.chrLo[i] | (this.chrHi[i] << 4)) >> this.chrShift);
      if (this.prgMode === 0) { this.setPrg8(0, this.prgReg[0]); this.setPrg8(2, -2); }
      else { this.setPrg8(0, -2); this.setPrg8(2, this.prgReg[0]); }
      this.setPrg8(1, this.prgReg[1]); this.setPrg8(3, -1);
    }
    cpuClock(cycles) { if (this.irq) this.irq.clock(cycles); }
    irqPending() { return this.irq ? this.irq.flag : false; }
  }

  // 75: Konami VRC1(PRG 8K×3 切替、CHR 4K×2(下位 4bit は $E000/$F000、bit4 は $9000 の bit1/bit2)、
  //   $9000 bit0 でミラーリング(0=V 1=H)。IRQ 無し)
  class VRC1 extends Mapper {
    constructor(rom) {
      super(rom);
      this.chrBank = [0, 0];
      this.setPrg8(3, -1);
      this.apply();
    }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.setPrg8(0, v & 0x0F); break;
        case 0xA000: this.setPrg8(1, v & 0x0F); break;
        case 0xC000: this.setPrg8(2, v & 0x0F); break;
        case 0x9000:
          if (!this.rom.fourScreen) this.setMirroring((v & 1) ? 'H' : 'V');
          this.chrBank[0] = (this.chrBank[0] & 0x0F) | ((v & 0x02) << 3);
          this.chrBank[1] = (this.chrBank[1] & 0x0F) | ((v & 0x04) << 2);
          this.apply();
          break;
        case 0xE000: this.chrBank[0] = (this.chrBank[0] & 0x10) | (v & 0x0F); this.apply(); break;
        case 0xF000: this.chrBank[1] = (this.chrBank[1] & 0x10) | (v & 0x0F); this.apply(); break;
      }
    }
    apply() {
      for (let h = 0; h < 2; h++) for (let i = 0; i < 4; i++) this.setChr1(h * 4 + i, this.chrBank[h] * 4 + i);
    }
  }

  // ---- 国内主要基板(音源無し)。挙動は Mesen 2 の各マッパーに揃えてある(合成 ROM で画面と録音を比べる基準) ----

  // バス競合: 書き込み値と ROM のその番地の値の AND が実際に見える(基板に書き込み保護の論理が無い物)
  function busConflict(m, addr, v) { return v & m.prg[m.prgMap[(addr - 0x8000) >> 13] + (addr & 0x1FFF)]; }

  // 9: MMC2(PRG 8K 切替+固定 3 本)/ 10: MMC4(PRG 16K 切替+固定)。CHR 4K×2 は、PPU がタイル $FD/$FE を読むと
  //   切り替わるラッチ(左は $0FD8/$0FE8 ちょうど、右は $1FD8-$1FDF/$1FE8-$1FEF。MMC4 は左も範囲)。
  //   切替はそのタイルの読みが終わってから(Mesen の needChrUpdate と同じ)。$F000 bit0 ミラーリング(1=H)
  class MMC2 extends Mapper {
    constructor(rom) {
      super(rom);
      this.mmc4 = rom.mapper === 10;
      this.latch = [1, 1]; this.chrReg = [[0, 0], [0, 0]]; this.pendingLatch = -1;
      if (this.mmc4) { this.setPrg16(0, 0); this.setPrg16(1, -1); }
      else { this.setPrg8(0, 0); this.setPrg8(1, -3); this.setPrg8(2, -2); this.setPrg8(3, -1); }
      this.applyChr();
    }
    applyChr() { for (let h = 0; h < 2; h++) { const b = this.chrReg[h][this.latch[h]] * 4; for (let i = 0; i < 4; i++) this.setChr1(h * 4 + i, b + i); } }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0xA000: if (this.mmc4) this.setPrg16(0, v & 0x0F); else this.setPrg8(0, v & 0x0F); break;
        case 0xB000: this.chrReg[0][0] = v & 0x1F; this.applyChr(); break;
        case 0xC000: this.chrReg[0][1] = v & 0x1F; this.applyChr(); break;
        case 0xD000: this.chrReg[1][0] = v & 0x1F; this.applyChr(); break;
        case 0xE000: this.chrReg[1][1] = v & 0x1F; this.applyChr(); break;
        case 0xF000: this.setMirroring((v & 1) ? 'H' : 'V'); break;
      }
    }
    ppuRead(addr) {
      const v = super.ppuRead(addr);
      if (addr < 0x2000) {
        const lo = addr & 0x0FF8, h = addr >> 12;
        if (lo === 0x0FD8 || lo === 0x0FE8) {
          if (h === 1 || this.mmc4 || (addr & 7) === 0) { this.latch[h] = lo === 0x0FE8 ? 1 : 0; this.applyChr(); }
        }
      }
      return v;
    }
  }

  // 16/153/159: Bandai FCG-1/2・LZ93D50(レジスタは $6000-$7FFF と $8000-$FFFF の両方。NES 2.0 のサブマッパー 4 は
  //   FCG-1/2=$6000 側だけ・IRQ カウンタ直書き、5 は LZ93D50=$8000 側だけ)。0-7 CHR 1K、8 PRG 16K、9 ミラーリング、
  //   A IRQ 有効(有効化でラッチをカウンタへ)、B/C ラッチ下位/上位、D EEPROM(未対応: 読みは SDA=1 を返す)。
  //   153(大容量): CHR レジスタの bit0 が PRG の外側バンク、$6000 RAM は D の bit5。IRQ は 16bit ダウン、0 で IRQ
  class BandaiFCG extends Mapper {
    constructor(rom) {
      super(rom);
      this.sub = rom.submapper | 0; this.big = rom.mapper === 153 || this.prgBanks8 >= 0x40; // 512K 以上
      this.chrRegs = new Uint8Array(8); this.prgPage = 0; this.outer = 0;
      this.irqEnable = false; this.irqCounter = 0; this.irqLatch = 0;
      this.setPrg16(0, 0); this.setPrg16(1, 0x0F);
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) {
        if (this.rom.mapper === 153) return this.prgRam[(addr - 0x6000) & 0x1FFF];
        return 0x10; // EEPROM の SDA(アイドル=1)。バーコードリーダーは無し
      }
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr < 0x6000) return;
      if (addr < 0x8000) {
        if (this.rom.mapper === 153) { this.prgRam[(addr - 0x6000) & 0x1FFF] = v; return; }
        if (this.sub === 5) return;
      } else if (this.sub === 4) return;
      this.writeReg(addr, v);
    }
    writeReg(addr, v) {
      const fcg = this.rom.mapper === 16 && this.sub === 4;
      switch (addr & 0x0F) {
        case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
          this.chrRegs[addr & 7] = v;
          if (this.big) {
            this.outer = 0; for (let i = 0; i < 8; i++) this.outer |= (this.chrRegs[i] & 1) << 4;
            this.setPrg16(0, this.prgPage | this.outer); this.setPrg16(1, 0x0F | this.outer);
          } else if (!this.chrIsRam) this.setChr1(addr & 7, v);
          break;
        case 8: this.prgPage = v & 0x0F; this.setPrg16(0, this.prgPage | this.outer); break;
        case 9: this.setMirroring(['V', 'H', '1A', '1B'][v & 3]); break;
        case 0xA: this.irqEnable = (v & 1) !== 0; if (!fcg) this.irqCounter = this.irqLatch; this.irqFlag = false; break;
        case 0xB: if (fcg) this.irqCounter = (this.irqCounter & 0xFF00) | v; else this.irqLatch = (this.irqLatch & 0xFF00) | v; break;
        case 0xC: if (fcg) this.irqCounter = (this.irqCounter & 0x00FF) | (v << 8); else this.irqLatch = (this.irqLatch & 0x00FF) | (v << 8); break;
        case 0xD: break; // EEPROM / 153 の RAM 許可(RAM は常に許可)
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) { if (this.irqCounter === 0) this.irqFlag = true; this.irqCounter = (this.irqCounter - 1) & 0xFFFF; }
    }
  }

  // 18: Jaleco SS88006(PRG 8K×3・CHR 1K×8 をニブル 2 回書き、$E000-$E003 IRQ ラッチ 4 ニブル、$F000 ラッチ→カウンタ、
  //   $F001 bit0 有効+bit1-3 で 12/8/4bit 幅、$F002 ミラーリング。$F003 の音源は未対応)
  class JalecoSS88006 extends Mapper {
    constructor(rom) {
      super(rom);
      this.prgRegs = new Uint8Array(3); this.chrRegs = new Uint8Array(8); this.irqLatchN = new Uint8Array(4);
      this.irqCounter = 0; this.irqSize = 0; this.irqEnable = false;
      this.setPrg8(3, -1);
    }
    writeReg(addr, v) {
      const hiNib = (addr & 1) !== 0; v &= 0x0F;
      const upd = (arr, i, set) => { arr[i] = hiNib ? (arr[i] & 0x0F) | (v << 4) : (arr[i] & 0xF0) | v; set(arr[i]); };
      switch (addr & 0xF003) {
        case 0x8000: case 0x8001: upd(this.prgRegs, 0, (b) => this.setPrg8(0, b)); break;
        case 0x8002: case 0x8003: upd(this.prgRegs, 1, (b) => this.setPrg8(1, b)); break;
        case 0x9000: case 0x9001: upd(this.prgRegs, 2, (b) => this.setPrg8(2, b)); break;
        case 0xA000: case 0xA001: upd(this.chrRegs, 0, (b) => this.setChr1(0, b)); break;
        case 0xA002: case 0xA003: upd(this.chrRegs, 1, (b) => this.setChr1(1, b)); break;
        case 0xB000: case 0xB001: upd(this.chrRegs, 2, (b) => this.setChr1(2, b)); break;
        case 0xB002: case 0xB003: upd(this.chrRegs, 3, (b) => this.setChr1(3, b)); break;
        case 0xC000: case 0xC001: upd(this.chrRegs, 4, (b) => this.setChr1(4, b)); break;
        case 0xC002: case 0xC003: upd(this.chrRegs, 5, (b) => this.setChr1(5, b)); break;
        case 0xD000: case 0xD001: upd(this.chrRegs, 6, (b) => this.setChr1(6, b)); break;
        case 0xD002: case 0xD003: upd(this.chrRegs, 7, (b) => this.setChr1(7, b)); break;
        case 0xE000: case 0xE001: case 0xE002: case 0xE003: this.irqLatchN[addr & 3] = v; break;
        case 0xF000: this.irqFlag = false; this.irqCounter = this.irqLatchN[0] | (this.irqLatchN[1] << 4) | (this.irqLatchN[2] << 8) | (this.irqLatchN[3] << 12); break;
        case 0xF001: this.irqFlag = false; this.irqEnable = (v & 1) !== 0; this.irqSize = (v & 8) ? 3 : (v & 4) ? 2 : (v & 2) ? 1 : 0; break;
        case 0xF002: this.setMirroring(['H', 'V', '1A', '1B'][v & 3]); break;
        case 0xF003: break; // 音源
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      const mask = [0xFFFF, 0x0FFF, 0x00FF, 0x000F][this.irqSize];
      for (let c = 0; c < cycles; c++) {
        let ctr = (this.irqCounter & mask); ctr = (ctr - 1) & mask;
        if (ctr === 0) this.irqFlag = true;
        this.irqCounter = (this.irqCounter & ~mask) | ctr;
      }
    }
  }

  // 32: Irem G-101($8000 PRG 8K(モードで $8000 か $C000)、$9000 bit1 モード+bit0 ミラーリング(1=H)、$A000 PRG 8K、
  //   $B000-$B007 CHR 1K。サブマッパー 1 は 1 画面固定・モード固定)
  class IremG101 extends Mapper {
    constructor(rom) {
      super(rom);
      this.prgRegs = [0, 0]; this.prgMode = 0; this.sub = rom.submapper | 0;
      if (this.sub === 1) this.setMirroring('1A');
      this.apply();
    }
    apply() {
      if (this.prgMode === 0) { this.setPrg8(0, this.prgRegs[0]); this.setPrg8(2, -2); }
      else { this.setPrg8(0, -2); this.setPrg8(2, this.prgRegs[0]); }
      this.setPrg8(1, this.prgRegs[1]); this.setPrg8(3, -1);
    }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.prgRegs[0] = v & 0x1F; this.apply(); break;
        case 0x9000: this.prgMode = this.sub === 1 ? 0 : (v >> 1) & 1; this.apply(); if (this.sub !== 1) this.setMirroring((v & 1) ? 'H' : 'V'); break;
        case 0xA000: this.prgRegs[1] = v & 0x1F; this.apply(); break;
        case 0xB000: this.setChr1(addr & 7, v); break;
      }
    }
  }

  // 65: Irem H3001($8000/$A000/$C000 PRG 8K、$9001 bit7 ミラーリング(1=H)、$9003 IRQ 有効、$9004 ラッチ→カウンタ、
  //   $9005/$9006 ラッチ上位/下位、$B000-$B007 CHR 1K。IRQ は 16bit ダウン、0 で IRQ+無効)
  class IremH3001 extends Mapper {
    constructor(rom) {
      super(rom);
      this.irqEnable = false; this.irqCounter = 0; this.irqLatch = 0;
      this.setPrg8(0, 0); this.setPrg8(1, 1); this.setPrg8(2, -2); this.setPrg8(3, -1);
    }
    writeReg(addr, v) {
      switch (addr) {
        case 0x8000: this.setPrg8(0, v); break;
        case 0x9001: this.setMirroring((v & 0x80) ? 'H' : 'V'); break;
        case 0x9003: this.irqEnable = (v & 0x80) !== 0; this.irqFlag = false; break;
        case 0x9004: this.irqCounter = this.irqLatch; this.irqFlag = false; break;
        case 0x9005: this.irqLatch = (this.irqLatch & 0x00FF) | (v << 8); break;
        case 0x9006: this.irqLatch = (this.irqLatch & 0xFF00) | v; break;
        case 0xA000: this.setPrg8(1, v); break;
        case 0xC000: this.setPrg8(2, v); break;
        default: if ((addr & 0xF000) === 0xB000) this.setChr1(addr & 7, v);
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) {
        this.irqCounter = (this.irqCounter - 1) & 0xFFFF;
        if (this.irqCounter === 0) { this.irqEnable = false; this.irqFlag = true; break; }
      }
    }
  }

  // 33: Taito TC0190($8000 PRG 8K+bit6 ミラーリング(1=H)、$8001 PRG 8K、$8002/$8003 CHR 2K、$A000-$A003 CHR 1K)
  class TaitoTC0190 extends Mapper {
    constructor(rom) { super(rom); this.setPrg8(2, -2); this.setPrg8(3, -1); }
    writeReg(addr, v) {
      switch (addr & 0xA003) {
        case 0x8000: this.setPrg8(0, v & 0x3F); this.setMirroring((v & 0x40) ? 'H' : 'V'); break;
        case 0x8001: this.setPrg8(1, v & 0x3F); break;
        case 0x8002: this.setChr2(0, v); break;
        case 0x8003: this.setChr2(1, v); break;
        case 0xA000: case 0xA001: case 0xA002: case 0xA003: this.setChr1(4 + (addr & 3), v); break;
      }
    }
  }

  // 48: Taito TC0690(TC0190 + MMC3 風の A12 IRQ: $C000 ラッチ(値の反転、サブマッパー 1 は +1)、$C001 リロード、
  //   $C002 有効、$C003 無効。IRQ は A12 の数え上げから数サイクル遅れる(Mesen と同じ 22、サブマッパー 1 は 6)。
  //   ミラーリングは $E000 bit6)
  class TaitoTC0690 extends MMC3 {
    constructor(rom) { super(rom); this.irqDelay = 0; this.setPrg8(2, -2); this.setPrg8(3, -1); }
    apply() {}
    writeReg(addr, v) {
      switch (addr & 0xE003) {
        case 0x8000: this.setPrg8(0, v & 0x3F); break;
        case 0x8001: this.setPrg8(1, v & 0x3F); break;
        case 0x8002: this.setChr2(0, v); break;
        case 0x8003: this.setChr2(1, v); break;
        case 0xA000: case 0xA001: case 0xA002: case 0xA003: this.setChr1(4 + (addr & 3), v); break;
        case 0xC000: this.irqFlag = false; this.irqLatch = ((v ^ 0xFF) + ((this.rom.submapper | 0) === 1 ? 1 : 0)) & 0xFF; break;
        case 0xC001: this.irqFlag = false; this.irqCounter = 0; this.irqReload = true; break;
        case 0xC002: this.irqEnable = true; break;
        case 0xC003: this.irqEnable = false; this.irqFlag = false; break;
        case 0xE000: this.setMirroring((v & 0x40) ? 'H' : 'V'); break;
      }
    }
    clockIrq() {
      if (this.irqCounter === 0 || this.irqReload) { this.irqCounter = this.irqLatch; this.irqReload = false; }
      else this.irqCounter--;
      if (this.irqCounter === 0 && this.irqEnable) this.irqDelay = (this.rom.submapper | 0) === 1 ? 6 : 22;
    }
    cpuClock(cycles) {
      if (this.irqDelay <= 0) return;
      this.irqDelay -= cycles;
      if (this.irqDelay <= 0) { this.irqDelay = 0; this.irqFlag = true; }
    }
  }

  // 80: Taito X1-005($7EF0/$7EF1 CHR 2K、$7EF2-$7EF5 CHR 1K、$7EF6 bit0 ミラーリング(1=V)、$7EF8 RAM 許可($A3)、
  //   $7EFA/$7EFC/$7EFE PRG 8K。RAM は $7F00-$7FFF の 128 バイト(ミラー)。許可は見ない)
  class TaitoX1005 extends Mapper {
    constructor(rom) { super(rom); this.setPrg8(3, -1); }
    cpuRead(addr) {
      if (addr >= 0x7F00 && addr < 0x8000) return this.prgRam[addr & 0x7F];
      if (addr >= 0x6000 && addr < 0x8000) return -1;
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) return;
      if (addr >= 0x7F00) { this.prgRam[addr & 0x7F] = v; return; }
      if (addr < 0x7EF0) return;
      switch (addr) {
        case 0x7EF0: this.setChr1(0, v); this.setChr1(1, v + 1); break;
        case 0x7EF1: this.setChr1(2, v); this.setChr1(3, v + 1); break;
        case 0x7EF2: case 0x7EF3: case 0x7EF4: case 0x7EF5: this.setChr1(4 + (addr - 0x7EF2), v); break;
        case 0x7EF6: case 0x7EF7: this.setMirroring((v & 1) ? 'V' : 'H'); break;
        case 0x7EFA: case 0x7EFB: this.setPrg8(0, v); break;
        case 0x7EFC: case 0x7EFD: this.setPrg8(1, v); break;
        case 0x7EFE: case 0x7EFF: this.setPrg8(2, v); break;
      }
    }
  }

  // 82: Taito X1-017($7EF0-$7EF5 CHR(2K×2+1K×4、$7EF6 bit1 で上下入れ替え)、$7EF6 bit0 ミラーリング(1=V)、
  //   $7EF7-$7EF9 RAM 許可(見ない)、$7EFA-$7EFC PRG 8K(値>>2)。RAM は $6000-$73FF)
  class TaitoX1017 extends Mapper {
    constructor(rom) { super(rom); this.chrRegs = new Uint8Array(6); this.chrMode = 0; this.setPrg8(3, -1); this.applyChr(); }
    applyChr() {
      const r = this.chrRegs;
      if (this.chrMode === 0) { this.setChr2(0, r[0] >> 1); this.setChr2(1, r[1] >> 1); for (let i = 0; i < 4; i++) this.setChr1(4 + i, r[2 + i]); }
      else { for (let i = 0; i < 4; i++) this.setChr1(i, r[2 + i]); this.setChr2(2, r[0] >> 1); this.setChr2(3, r[1] >> 1); }
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x7400) return this.prgRam[addr - 0x6000];
      if (addr >= 0x6000 && addr < 0x8000) return -1;
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) return;
      if (addr < 0x7400) { if (addr >= 0x6000) this.prgRam[addr - 0x6000] = v; return; }
      switch (addr) {
        case 0x7EF0: case 0x7EF1: case 0x7EF2: case 0x7EF3: case 0x7EF4: case 0x7EF5: this.chrRegs[addr & 0xF] = v; this.applyChr(); break;
        case 0x7EF6: this.setMirroring((v & 1) ? 'V' : 'H'); this.chrMode = (v >> 1) & 1; this.applyChr(); break;
        case 0x7EFA: case 0x7EFB: case 0x7EFC: this.setPrg8(addr - 0x7EFA, v >> 2); break;
      }
    }
  }

  // 184: Sunsoft-1($6000: bit0-2 CHR 4K 下、bit4-6 CHR 4K 上)
  class Sunsoft1 extends Mapper {
    cpuWrite(addr, v) {
      if (addr >= 0x6000 && addr < 0x8000) { for (let i = 0; i < 4; i++) { this.setChr1(i, (v & 7) * 4 + i); this.setChr1(4 + i, ((v >> 4) & 7) * 4 + i); } }
    }
  }

  // 89: Sunsoft-2(Sunsoft-3 基板。$8000: bit4-6 PRG 16K、bit0-2+bit7 CHR 8K、bit3 1 画面)
  //  93: Sunsoft-2(Sunsoft-3R 基板。$8000: bit4-6 PRG 16K、bit0 CHR RAM 有効。無効の間は読みが 0、書きは捨てる。
  //      起動直後は無効なので、CHR RAM を埋める前に有効にしないソフトは画面が出ない(実機・Mesen と同じ))
  class Sunsoft2 extends Mapper {
    constructor(rom) { super(rom); this.chrOn = rom.mapper === 89; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      this.setPrg16(0, (v >> 4) & 7);
      if (this.rom.mapper === 89) { this.setChr8((v & 7) | ((v & 0x80) >> 4)); this.setMirroring((v & 8) ? '1B' : '1A'); }
      else this.chrOn = (v & 1) !== 0;
    }
    ppuRead(addr) { return addr < 0x2000 && !this.chrOn ? (addr & 0xFF) : super.ppuRead(addr); } // 無効時は PPU オープンバス(番地の下位バイト。Mesen と同じ)
    ppuWrite(addr, v) { if (addr < 0x2000 && !this.chrOn) return; super.ppuWrite(addr, v); }
  }

  // 67: Sunsoft-3($8800-$B800 CHR 2K×4、$C800 IRQ カウンタ 16bit を上位→下位の 2 回書き、$D800 bit4 IRQ 有効、
  //   $E800 ミラーリング、$F800 PRG 16K。カウンタは毎サイクル減り、0 から下へ回った時に IRQ+無効)
  class Sunsoft3 extends Mapper {
    constructor(rom) { super(rom); this.irqLatchHi = false; this.irqEnable = false; this.irqCounter = 0; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      switch (addr & 0xF800) {
        case 0x8800: this.setChr2(0, v); break;
        case 0x9800: this.setChr2(1, v); break;
        case 0xA800: this.setChr2(2, v); break;
        case 0xB800: this.setChr2(3, v); break;
        case 0xC800: this.irqCounter = this.irqLatchHi ? (this.irqCounter & 0xFF00) | v : (this.irqCounter & 0x00FF) | (v << 8); this.irqLatchHi = !this.irqLatchHi; break;
        case 0xD800: this.irqEnable = (v & 0x10) !== 0; this.irqLatchHi = false; this.irqFlag = false; break;
        case 0xE800: this.setMirroring(['V', 'H', '1A', '1B'][v & 3]); break;
        case 0xF800: this.setPrg16(0, v); break;
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) {
        this.irqCounter = (this.irqCounter - 1) & 0xFFFF;
        if (this.irqCounter === 0xFFFF) { this.irqEnable = false; this.irqFlag = true; break; }
      }
    }
  }

  // 68: Sunsoft-4($8000-$B000 CHR 2K×4、$C000/$D000 ネームテーブルに出す CHR 1K(|$80)、$E000 bit0-1 ミラーリング+
  //   bit4 で NT を CHR ROM から、$F000 PRG 16K(bit4 RAM 許可は見ない)。ライセンス認証の外部 ROM は未対応)
  class Sunsoft4 extends Mapper {
    constructor(rom) { super(rom); this.ntRegs = [0x80, 0x80]; this.ntFromChr = false; this.mirror = rom.mirroring; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.setChr2(0, v); break;
        case 0x9000: this.setChr2(1, v); break;
        case 0xA000: this.setChr2(2, v); break;
        case 0xB000: this.setChr2(3, v); break;
        case 0xC000: this.ntRegs[0] = v | 0x80; break;
        case 0xD000: this.ntRegs[1] = v | 0x80; break;
        case 0xE000: this.mirror = ['V', 'H', '1A', '1B'][v & 3]; this.setMirroring(this.mirror); this.ntFromChr = (v & 0x10) !== 0; break;
        case 0xF000: this.setPrg16(0, v & 7); break;
      }
    }
    _ntChr(addr) { const page = this.ntMap[(addr >> 10) & 3]; return ((this.ntRegs[page] % this.chrBanks1) << 10) | (addr & 0x3FF); }
    ppuRead(addr) {
      if (addr >= 0x2000 && this.ntFromChr) return this.chr[this._ntChr(addr)];
      return super.ppuRead(addr);
    }
    ppuWrite(addr, v) {
      if (addr >= 0x2000 && this.ntFromChr) { if (this.chrIsRam) this.chr[this._ntChr(addr)] = v; return; }
      super.ppuWrite(addr, v);
    }
  }

  // 210: Namco 175/340(N163 から音源と NT-CHR を除いた物。$8000-$BFFF CHR 1K×8、$E000/$E800/$F000 PRG 8K。
  //   340 は $E000 bit6-7 ミラーリング(0=1A 1=V 2=H 3=1B)、175 は $C000 bit0 RAM 許可(見ない)で固定ミラーリング。
  //   サブマッパー 1=175、2=340、無ければ Mesen と同じ自動判定($E000 の bit6/7 が立てば 340、$C000 系の書きで 175、
  //   $6000 RAM へ書けば 340 ではない))
  class Namco175 extends Mapper {
    constructor(rom) {
      super(rom);
      const sub = rom.submapper | 0;
      this.variant = sub === 1 ? 175 : sub === 2 ? 340 : 0; this.auto = sub === 0; this.ramWritten = false;
      this.setPrg8(3, -1);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x6000 && addr < 0x8000) { this.ramWritten = true; if (this.auto && this.variant === 340) this.variant = 0; }
      super.cpuWrite(addr, v);
    }
    writeReg(addr, v) {
      const hi = addr & 0xF800;
      if (hi < 0xC000) { this.setChr1((hi - 0x8000) >> 11, v); return; }
      if (hi < 0xE000) { if (this.auto && this.variant !== 340) this.variant = 175; return; } // 175: RAM 許可
      if (hi === 0xE000) {
        if (this.auto && (v & 0xC0) && !this.ramWritten) this.variant = 340;
        this.setPrg8(0, v & 0x3F);
        if (this.variant === 340) this.setMirroring(['1A', 'V', 'H', '1B'][(v >> 6) & 3]);
        return;
      }
      if (hi === 0xE800) { this.setPrg8(1, v & 0x3F); return; }
      if (hi === 0xF000) this.setPrg8(2, v & 0x3F);
    }
  }

  // 66: GxROM($8000: bit4-5 PRG 32K、bit0-1 CHR 8K)
  class GxROM extends Mapper {
    writeReg(addr, v) { this.setPrg32((v >> 4) & 3); this.setChr8(v & 3); }
  }

  // 34: BNROM(CHR RAM。$8000 PRG 32K、バス競合)/ NINA-001(CHR ROM。$7FFD PRG 32K、$7FFE/$7FFF CHR 4K。PRG RAM にも書く)。
  //   サブマッパー 1=NINA、2=BNROM、無ければ CHR ROM の有無で決める(Mesen と同じ)
  class BNROM extends Mapper {
    constructor(rom) { super(rom); const sub = rom.submapper | 0; this.nina = sub === 1 || (sub === 0 && !!rom.chr); }
    cpuWrite(addr, v) {
      if (this.nina) {
        if (addr >= 0x6000 && addr < 0x8000) {
          this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
          if (addr === 0x7FFD) this.setPrg32(v & 1);
          else if (addr === 0x7FFE) for (let i = 0; i < 4; i++) this.setChr1(i, (v & 0x0F) * 4 + i);
          else if (addr === 0x7FFF) for (let i = 0; i < 4; i++) this.setChr1(4 + i, (v & 0x0F) * 4 + i);
        }
        return;
      }
      if (addr >= 0x8000) this.setPrg32(busConflict(this, addr, v));
      else if (addr >= 0x6000) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v;
    }
  }

  // 70/152: Bandai 74161/7432($8000: bit4-6 PRG 16K、bit0-3 CHR 8K。152 は bit7 で 1 画面。70 でも bit7 を一度でも
  //   立てた後は同じ扱い。Mesen 同様)
  class Bandai74161 extends Mapper {
    constructor(rom) { super(rom); this.mirrorCtl = rom.mapper === 152; this.setPrg16(0, 0); this.setPrg16(1, -1); this.setMirroring('V'); }
    writeReg(addr, v) {
      if (v & 0x80) this.mirrorCtl = true;
      if (this.mirrorCtl) this.setMirroring((v & 0x80) ? '1B' : '1A');
      this.setPrg16(0, (v >> 4) & 7); this.setChr8(v & 0x0F);
    }
  }

  // 72: Jaleco JF-17 / 92: JF-19($8000: bit7 の立ち上がりで PRG 16K(72 は $8000、92 は $C000)、bit6 の立ち上がりで
  //   CHR 8K。バス競合。音源(bit4-5 の ADPCM)は未対応)
  class JalecoJF17 extends Mapper {
    constructor(rom) { super(rom); this.jf19 = rom.mapper === 92; this.prgFlag = false; this.chrFlag = false; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      v = busConflict(this, addr, v);
      if (!this.prgFlag && (v & 0x80)) { if (this.jf19) this.setPrg16(1, v & 0x0F); else this.setPrg16(0, v & 0x07); }
      if (!this.chrFlag && (v & 0x40)) this.setChr8(v & 0x0F);
      this.prgFlag = (v & 0x80) !== 0; this.chrFlag = (v & 0x40) !== 0;
    }
  }

  // 86: Jaleco JF-13($6000: bit4-5 PRG 32K、bit0-1+bit6 CHR 8K。$7000 の音声は未対応)
  // 87: ($6000: bit0/bit1 を入れ替えて CHR 8K)
  // 140: Jaleco JF-11/14($6000: bit4-5 PRG 32K、bit0-3 CHR 8K)
  class JalecoJF13 extends Mapper {
    cpuWrite(addr, v) {
      if (addr < 0x6000 || addr >= 0x8000) return;
      const m = this.rom.mapper;
      if (m === 86) { if ((addr & 0x7000) === 0x6000) { this.setPrg32((v & 0x30) >> 4); this.setChr8((v & 3) | ((v >> 4) & 4)); } }
      else if (m === 87) this.setChr8(((v & 1) << 1) | ((v & 2) >> 1));
      else { this.setPrg32((v >> 4) & 3); this.setChr8(v & 0x0F); }
    }
  }

  // 73: Konami VRC3($8000-$B000 IRQ ラッチ 4 ニブル、$C000 bit1 有効(有効化でラッチ→カウンタ)+bit2 で 8bit 幅+
  //   bit0 ack 後の有効、$D000 ack、$F000 PRG 16K。カウンタは毎サイクル増え、あふれで IRQ+ラッチ再設定)
  class VRC3 extends Mapper {
    constructor(rom) { super(rom); this.irqLatch = 0; this.irqCounter = 0; this.irqEnable = false; this.irqAfterAck = false; this.small = false; this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      switch (addr & 0xF000) {
        case 0x8000: this.irqLatch = (this.irqLatch & 0xFFF0) | (v & 0x0F); break;
        case 0x9000: this.irqLatch = (this.irqLatch & 0xFF0F) | ((v & 0x0F) << 4); break;
        case 0xA000: this.irqLatch = (this.irqLatch & 0xF0FF) | ((v & 0x0F) << 8); break;
        case 0xB000: this.irqLatch = (this.irqLatch & 0x0FFF) | ((v & 0x0F) << 12); break;
        case 0xC000: this.irqEnable = (v & 2) !== 0; if (this.irqEnable) this.irqCounter = this.irqLatch; this.small = (v & 4) !== 0; this.irqAfterAck = (v & 1) !== 0; this.irqFlag = false; break;
        case 0xD000: this.irqFlag = false; this.irqEnable = this.irqAfterAck; break;
        case 0xF000: this.setPrg16(0, v & 7); break;
      }
    }
    cpuClock(cycles) {
      if (!this.irqEnable) return;
      for (let c = 0; c < cycles; c++) {
        if (this.small) {
          let lo = ((this.irqCounter & 0xFF) + 1) & 0xFF;
          if (lo === 0) { lo = this.irqLatch & 0xFF; this.irqFlag = true; }
          this.irqCounter = (this.irqCounter & 0xFF00) | lo;
        } else {
          this.irqCounter = (this.irqCounter + 1) & 0xFFFF;
          if (this.irqCounter === 0) { this.irqCounter = this.irqLatch; this.irqFlag = true; }
        }
      }
    }
  }

  // 78: Jaleco JF-16($8000: bit0-2 PRG 16K、bit4-7 CHR 8K、bit3 ミラーリング(サブマッパー 3 は V/H、他は 1 画面)。バス競合)
  class JalecoJF16 extends Mapper {
    constructor(rom) { super(rom); this.setPrg16(0, 0); this.setPrg16(1, -1); }
    writeReg(addr, v) {
      v = busConflict(this, addr, v);
      this.setPrg16(0, v & 7); this.setChr8((v >> 4) & 0x0F);
      if ((this.rom.submapper | 0) === 3) this.setMirroring((v & 8) ? 'V' : 'H'); else this.setMirroring((v & 8) ? '1B' : '1A');
    }
  }

  // 77: Irem LROG017($8000: bit0-3 PRG 32K、bit4-7 CHR 2K を $0000 に(残り 6K は CHR RAM)。4 画面。バス競合)
  class IremLROG017 extends Mapper {
    constructor(rom) {
      super(rom);
      this.chrRam = new Uint8Array(0x1800); this.chrRom = rom.chr || new Uint8Array(0x800); this.chrBank = 0;
      this.ciram = new Uint8Array(0x1000); this.setMirroring('4');
    }
    writeReg(addr, v) { v = busConflict(this, addr, v); this.setPrg32(v & 0x0F); this.chrBank = ((v >> 4) & 0x0F) % Math.max(1, this.chrRom.length >> 11); }
    ppuRead(addr) {
      if (addr < 0x800) return this.chrRom[(this.chrBank << 11) | addr];
      if (addr < 0x2000) return this.chrRam[addr - 0x800];
      return super.ppuRead(addr);
    }
    ppuWrite(addr, v) {
      if (addr < 0x800) return;
      if (addr < 0x2000) { this.chrRam[addr - 0x800] = v; return; }
      super.ppuWrite(addr, v);
    }
  }

  // 94: UN1ROM($8000: bit2-4 PRG 16K)/ 180: UNROM 逆($8000 固定 0、$C000 = bit0-2)/ 97: Irem TAM-S1($8000 固定末尾、
  //   $C000 = bit0-3、bit6-7 ミラーリング 0=1A 1=H 2=V 3=1B)
  class UxROMVariants extends Mapper {
    constructor(rom) {
      super(rom);
      const m = rom.mapper;
      if (m === 97) { this.setPrg16(0, -1); this.setPrg16(1, -1); }
      else { this.setPrg16(0, 0); this.setPrg16(1, m === 180 ? 0 : -1); }
    }
    writeReg(addr, v) {
      const m = this.rom.mapper;
      if (m === 94) this.setPrg16(0, (v >> 2) & 7);
      else if (m === 180) this.setPrg16(1, v & 7);
      else { this.setPrg16(1, v & 0x0F); this.setMirroring(['1A', 'H', 'V', '1B'][v >> 6]); }
    }
  }

  // 185: CNROM の CHR 保護(書いた値が条件に合う時だけ CHR が読める。サブマッパー 0: 下位 4bit が 0 でなく $13 でもない、
  //   4-7: 下位 2bit がそれぞれ 0-3。読めない時は PPU オープンバス(番地の下位バイト)に 1 を立てた値(Mesen と同じ)。バス競合)
  class CNROMProtect extends Mapper {
    constructor(rom) { super(rom); this.chrOn = true; }
    writeReg(addr, v) {
      v = busConflict(this, addr, v);
      const sub = this.rom.submapper | 0;
      this.chrOn = sub === 0 ? ((v & 0x0F) !== 0 && v !== 0x13) : sub >= 4 && sub <= 7 ? (v & 3) === sub - 4 : true;
    }
    ppuRead(addr) { return addr < 0x2000 && !this.chrOn ? ((addr & 0xFF) | 1) : super.ppuRead(addr); }
  }

  // Namco 108 の派生: 76(CHR 2K×4 をレジスタ 2-5 で)、88(CHR 128K: レジスタ 0/1 は下半分、2-5 は上半分)、
  //   95(レジスタ 0/1 の bit5 がネームテーブル)、154(88 + $8000 bit6 で 1 画面)
  class Namco108Variants extends Namco108 {
    writeReg(addr, v) {
      const m = this.rom.mapper;
      if (m === 154 && (addr & 0x8001) === 0x8000) this.setMirroring((v & 0x40) ? '1B' : '1A');
      super.writeReg(addr, v);
      if (m === 95 && (addr & 0x8001) === 0x8001) { const a = (this.regs[0] >> 5) & 1, b = (this.regs[1] >> 5) & 1; this.ntMap = [a, a, b, b]; }
    }
    apply() {
      const m = this.rom.mapper, r = this.regs;
      if (m === 76) { for (let i = 0; i < 4; i++) this.setChr2(i, r[2 + i]); }
      else if (m === 88 || m === 154) {
        this.setChr1(0, r[0] & 0x3E); this.setChr1(1, (r[0] & 0x3E) + 1); this.setChr1(2, r[1] & 0x3E); this.setChr1(3, (r[1] & 0x3E) + 1);
        for (let i = 0; i < 4; i++) this.setChr1(4 + i, r[2 + i] | 0x40);
      } else { // 95
        this.setChr1(0, r[0] & 0x1E); this.setChr1(1, (r[0] & 0x1E) + 1); this.setChr1(2, r[1] & 0x1E); this.setChr1(3, (r[1] & 0x1E) + 1);
        for (let i = 0; i < 4; i++) this.setChr1(4 + i, r[2 + i] & 0x1F);
      }
      const last = this.prgBanks8 - 1;
      this.setPrg8(0, r[6]); this.setPrg8(1, r[7]); this.setPrg8(2, last - 1); this.setPrg8(3, last);
    }
  }

  // 69: Sunsoft FME-7 / 5B(PRG 8K×3 切替 + $6000 は ROM か RAM、CHR 1K×8、16bit サイクル IRQ、5B は AY 系音源
  //   $C000/$E000)。FME-7(音源無し)のソフトもマッパー番号は同じなので、音源は常に挿す(書かれなければ鳴らない)
  class Sunsoft5B extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.FME7Audio ? new Emu.FME7Audio() : null;
      this.extBits = 0x20;
      this.cmd = 0;
      this.ramAt6000 = false; this.ramEnabled = false; this.rom6000 = 0;
      this.irqEnable = false; this.counterEnable = false; this.counter = 0xFFFF;
      this.ayAddr = 0; this.ayShadow = new Int16Array(16).fill(-1);
      this.setPrg8(0, 0); this.setPrg8(1, 1); this.setPrg8(2, 2); this.setPrg8(3, -1);
    }
    audioAddr(addr) { const m = addr & 0xE000; return m === 0xC000 ? 0xC000 : m === 0xE000 ? 0xE000 : -1; }
    audioImage() {
      const out = [];
      for (let r = 0; r < 16; r++) if (this.ayShadow[r] >= 0) { out.push({ addr: 0xC000, value: r }); out.push({ addr: 0xE000, value: this.ayShadow[r] }); }
      out.push({ addr: 0xC000, value: this.ayAddr });
      return out;
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) {
        if (this.ramAt6000) return this.ramEnabled ? this.prgRam[(addr - 0x6000) % this.prgRam.length] : -1;
        return this.prg[((this.rom6000 % this.prgBanks8) << 13) + (addr & 0x1FFF)];
      }
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr >= 0x6000 && addr < 0x8000) { if (this.ramAt6000 && this.ramEnabled) this.prgRam[(addr - 0x6000) % this.prgRam.length] = v; return; }
      super.cpuWrite(addr, v);
    }
    writeReg(addr, v) {
      switch (addr & 0xE000) {
        case 0x8000: this.cmd = v & 0x0F; break;
        case 0xA000: this.param(this.cmd, v); break;
        case 0xC000: this.ayAddr = v & 0x0F; if (this.audio) this.audio.writeRegister(0xC000, v); break;
        case 0xE000: this.ayShadow[this.ayAddr] = v; if (this.audio) this.audio.writeRegister(0xE000, v); break;
      }
    }
    param(cmd, v) {
      if (cmd < 8) { this.setChr1(cmd, v); return; }
      switch (cmd) {
        case 8: this.ramAt6000 = (v & 0x40) !== 0; this.ramEnabled = (v & 0x80) !== 0; this.rom6000 = v & 0x3F; break;
        case 9: case 10: case 11: this.setPrg8(cmd - 9, v & 0x3F); break;
        case 12: this.setMirroring(['V', 'H', '1A', '1B'][v & 3]); break;
        case 13: this.irqEnable = (v & 1) !== 0; this.counterEnable = (v & 0x80) !== 0; this.irqFlag = false; break;
        case 14: this.counter = (this.counter & 0xFF00) | v; break;
        case 15: this.counter = (this.counter & 0x00FF) | (v << 8); break;
      }
    }
    cpuClock(cycles) {
      if (!this.counterEnable) return;
      for (let c = 0; c < cycles; c++) {
        if (this.counter === 0) { this.counter = 0xFFFF; if (this.irqEnable) this.irqFlag = true; }
        else this.counter--;
      }
    }
  }

  // 5: Nintendo MMC5(ExROM)。PRG モード 0-3($5100)、PRG RAM 64K($5113-$5117 の bit7 で ROM/RAM)、CHR モード 0-3
  //   ($5101)と 8×16 スプライト時の A/B 2 組、ネームテーブル割当($5105: CIRAM/ExRAM/塗りつぶし)、ExRAM の
  //   4 モード($5104。モード 1=拡張属性: タイルごとの 4K CHR バンクとパレット)、スキャンライン IRQ($5203/$5204。
  //   実機と同じく「同じネームテーブル番地の連続 3 回読み」で行を数える)、乗算器($5205/$5206)、音源($5000-$5015)。
  //   縦分割($5200-$5202)、PRG RAM 書き込み保護($5102/$5103)、$5015 の読み出し(音源の長さカウンタ)も対応。
  //   未対応: 2 つめの 64K 以上の RAM 配置(NES 2.0 の 64K/128K RAM を 1 塊として扱う)
  class MMC5 extends Mapper {
    constructor(rom) {
      super(rom);
      this.audio = Emu.MMC5Audio ? new Emu.MMC5Audio() : null;
      this.extBits = 0x08;
      this.prgRam = new Uint8Array(0x10000);
      this.exram = new Uint8Array(0x400);
      this.prgMode = 3; this.chrMode = 3; this.exMode = 0;
      this.prgRegs = new Uint8Array([0, 0, 0, 0, 0xFF]); // $5113-$5117
      this.chrRegs = new Uint16Array(12);                 // $5120-$512B
      this.chrUpper = 0;                                  // $5130
      this.ntMode = 0; this.fillTile = 0; this.fillAttr = 0;
      this.lastChrSet = 0;                                // 0=A($5120-27) 1=B($5128-2B)。8×8 スプライト時はこれ
      this.chrA = new Int32Array(8); this.chrB = new Int32Array(8);
      this.slotIsRam = [false, false, false, false]; this.slotOff = new Int32Array(4);
      this.irqCompare = 0; this.irqEnable = false; this.irqPend = false; this.inFrame = false;
      this.scanline = 0; this.ntLast = -1; this.ntSame = 0; this.idleDots = 0;
      this.prot1 = 0; this.prot2 = 0; this.ramWrite = false; // $5102/$5103 が 2/1 になるまで PRG RAM は書けない
      this.splitOn = false; this.splitRight = false; this.splitTile = 0; this.splitScroll = 0; this.splitBank = 0; // 縦分割($5200-$5202)
      this.splitN = 0; this.splitIn = false; this.splitAddr = 0; this.tickPending = false; // 行内の NT 取得の通し番号(3 連続読みで 0 に戻る)、分割領域の中か、分割側の NT 番地
      this.mulA = 0xFF; this.mulB = 0xFF;
      this.exTile = 0;                                    // 拡張属性モードで最後に読んだネームテーブルの ExRAM バイト
      this.audioShadow = new Int16Array(0x16).fill(-1);
      this.applyPrg(); this.applyChr();
    }
    audioAddr(addr) { return addr >= 0x5000 && addr <= 0x5015 ? addr : -1; }
    audioImage() {
      const out = [];
      for (const a of [0x5000, 0x5001, 0x5002, 0x5003, 0x5004, 0x5005, 0x5006, 0x5007, 0x5010, 0x5011, 0x5015]) {
        const v = this.audioShadow[a - 0x5000]; if (v >= 0) out.push({ addr: a, value: v });
      }
      return out;
    }
    // ── CPU ──
    cpuRead(addr) {
      if (addr >= 0x8000) {
        const s = (addr - 0x8000) >> 13, o = this.slotOff[s] + (addr & 0x1FFF);
        return this.slotIsRam[s] ? this.prgRam[o % this.prgRam.length] : this.prg[o];
      }
      if (addr >= 0x6000) return this.prgRam[(((this.prgRegs[0] & 7) << 13) + (addr & 0x1FFF)) % this.prgRam.length];
      if (addr >= 0x5C00) return (this.exMode >= 2) ? this.exram[addr & 0x3FF] : -1;
      switch (addr) {
        case 0x5204: { const v = (this.irqPend ? 0x80 : 0) | (this.inFrame ? 0x40 : 0); this.irqPend = false; return v; }
        case 0x5015: { const a = this.audio; return a && a.pulse1 && a.pulse2 ? ((a.pulse1.lengthCounter > 0 ? 1 : 0) | (a.pulse2.lengthCounter > 0 ? 2 : 0)) : 0; } // 音源の状態(長さカウンタ)
        case 0x5205: return (this.mulA * this.mulB) & 0xFF;
        case 0x5206: return ((this.mulA * this.mulB) >> 8) & 0xFF;
      }
      return -1;
    }
    cpuWrite(addr, v) {
      if (addr >= 0x8000) {
        const s = (addr - 0x8000) >> 13;
        if (this.slotIsRam[s] && this.ramWrite) this.prgRam[(this.slotOff[s] + (addr & 0x1FFF)) % this.prgRam.length] = v;
        return;
      }
      if (addr >= 0x6000) { if (this.ramWrite) this.prgRam[(((this.prgRegs[0] & 7) << 13) + (addr & 0x1FFF)) % this.prgRam.length] = v; return; }
      if (addr === 0x5102 || addr === 0x5103) { // PRG RAM 書き込み保護: $5102=2 かつ $5103=1 の時だけ書ける
        if (addr === 0x5102) this.prot1 = v & 3; else this.prot2 = v & 3;
        this.ramWrite = this.prot1 === 2 && this.prot2 === 1;
        return;
      }
      if (addr >= 0x5200 && addr <= 0x5202) { // 縦分割
        if (addr === 0x5200) { this.splitOn = (v & 0x80) !== 0; this.splitRight = (v & 0x40) !== 0; this.splitTile = v & 0x1F; }
        else if (addr === 0x5201) this.splitScroll = v;
        else this.splitBank = v;
        return;
      }
      if (addr >= 0x5C00) { if (this.exMode < 3) this.exram[addr & 0x3FF] = v; return; }
      if (addr >= 0x5000 && addr <= 0x5015) { this.audioShadow[addr - 0x5000] = v; if (this.audio) this.audio.writeRegister(addr, v); return; }
      if (addr >= 0x5120 && addr <= 0x512B) {
        this.chrRegs[addr - 0x5120] = v | (this.chrUpper << 8);
        this.lastChrSet = addr >= 0x5128 ? 1 : 0;
        this.applyChr();
        return;
      }
      if (addr >= 0x5113 && addr <= 0x5117) { this.prgRegs[addr - 0x5113] = v; this.applyPrg(); return; }
      switch (addr) {
        case 0x5100: this.prgMode = v & 3; this.applyPrg(); break;
        case 0x5101: this.chrMode = v & 3; this.applyChr(); break;
        case 0x5104: this.exMode = v & 3; break;
        case 0x5105: this.ntMode = v; break;
        case 0x5106: this.fillTile = v; break;
        case 0x5107: this.fillAttr = (v & 3) * 0x55; break;
        case 0x5130: this.chrUpper = v & 3; break;
        case 0x5203: this.irqCompare = v; break;
        case 0x5204: this.irqEnable = (v & 0x80) !== 0; break;
        case 0x5205: this.mulA = v; break;
        case 0x5206: this.mulB = v; break;
      }
    }
    applyPrg() {
      const r = this.prgRegs, set = (s, reg, bank) => {
        const isRam = reg < 4 && !(r[reg] & 0x80);
        this.slotIsRam[s] = isRam;
        const n = isRam ? 8 : this.prgBanks8;
        this.slotOff[s] = ((bank % n) + n) % n << 13;
      };
      switch (this.prgMode) {
        case 0: { const b = (r[4] & 0x7C); set(0, 4, b); set(1, 4, b + 1); set(2, 4, b + 2); set(3, 4, b + 3); break; }
        case 1: { const a = r[2] & 0x7E, b = r[4] & 0x7E; set(0, 2, a); set(1, 2, a + 1); set(2, 4, b); set(3, 4, b + 1); break; }
        case 2: { const a = r[2] & 0x7E; set(0, 2, a); set(1, 2, a + 1); set(2, 3, r[3] & 0x7F); set(3, 4, r[4] & 0x7F); break; }
        default: set(0, 1, r[1] & 0x7F); set(1, 2, r[2] & 0x7F); set(2, 3, r[3] & 0x7F); set(3, 4, r[4] & 0x7F);
      }
    }
    applyChr() {
      const c = this.chrRegs, n = this.chrBanks1, A = this.chrA, B = this.chrB;
      const put = (map, slot, bank) => { map[slot] = (((bank % n) + n) % n) << 10; };
      switch (this.chrMode) {
        case 0: for (let i = 0; i < 8; i++) { put(A, i, c[7] * 8 + i); put(B, i, c[11] * 8 + i); } break;
        case 1: for (let i = 0; i < 4; i++) { put(A, i, c[3] * 4 + i); put(A, 4 + i, c[7] * 4 + i); put(B, i, c[11] * 4 + i); put(B, 4 + i, c[11] * 4 + i); } break;
        case 2: for (let i = 0; i < 2; i++) { put(A, i, c[1] * 2 + i); put(A, 2 + i, c[3] * 2 + i); put(A, 4 + i, c[5] * 2 + i); put(A, 6 + i, c[7] * 2 + i);
          put(B, i, c[9] * 2 + i); put(B, 2 + i, c[11] * 2 + i); put(B, 4 + i, c[9] * 2 + i); put(B, 6 + i, c[11] * 2 + i); } break;
        default: for (let i = 0; i < 8; i++) { put(A, i, c[i]); put(B, i, c[8 + (i & 3)]); }
      }
    }
    // ── PPU ──
    _bgFetching() { // 背景の取得中か(8×16 スプライト時の A/B 選択と拡張属性モード用)
      const p = this.ppu;
      if (!p || !(p.mask & 0x18)) return false;
      if (p.scanline >= 240 && p.scanline !== 261) return false;
      const d = p.dot;
      return (d >= 1 && d <= 256) || (d >= 321 && d <= 340);
    }
    _spriteFetching() { const p = this.ppu; return p && (p.mask & 0x18) && p.dot >= 257 && p.dot <= 320 && (p.scanline < 240 || p.scanline === 261); }
    _chrMap() {
      const p = this.ppu;
      if (p && (p.ctrl & 0x20)) { // 8×16: 背景は B、スプライトは A。描画外は最後に書いた組
        if (this._spriteFetching()) return this.chrA;
        if (this._bgFetching()) return this.chrB;
      }
      return this.lastChrSet ? this.chrB : this.chrA;
    }
    _nt(addr) { return (this.ntMode >> (((addr >> 10) & 3) * 2)) & 3; }
    ppuRead(addr) {
      // 縦分割: 行内の NT 取得を数え(ダミー読み 2 回目で 0 に戻す)、境目のタイル列で領域に出入りする。領域内は NT/属性を ExRAM、
      //   パターンを $5202 の 4K バンクと $5201 の縦スクロールから出す(Mesen と同じ数え方。画面の列 = 通し番号+2)
      const isNt = addr >= 0x2000 && (addr & 0x3FF) < 0x3C0;
      if (isNt) this.splitN++;
      if (this.tickPending) { this.tickPending = false; this._scanlineTick(); } // 3 連続読みの「次の読み」(属性)で行を進める(Mesen と同じ)
      if (addr < 0x2000) {
        if (this.splitOn && this.splitIn && this.exMode <= 1 && this.inFrame && this._bgFetching()) {
          const vs = (this.scanline + this.splitScroll) % 240, bank = this.splitBank % Math.max(1, this.chrBanks1 >> 2);
          return this.chr[(bank << 12) + (((addr & ~7) | (vs & 7)) & 0xFFF)];
        }
        if (this.exMode === 1 && this._bgFetching()) {
          const bank = ((this.exTile & 0x3F) | (this.chrUpper << 6)) % Math.max(1, this.chrBanks1 >> 2);
          return this.chr[(bank << 12) + (addr & 0xFFF)];
        }
        return this.chr[this._chrMap()[addr >> 10] + (addr & 0x3FF)];
      }
      // ネームテーブル。スキャンライン検出: 同じ番地の連続 3 回読み(337・339 ドット目のダミー読みと次の行の 1 ドット目)
      if (this._bgFetching()) {
        if (addr === this.ntLast) { if (++this.ntSame === 3) { this.tickPending = true; this.splitN = 0; } }
        else { this.ntLast = addr; this.ntSame = 1; }
      }
      const mode = this._nt(addr), lo = addr & 0x3FF, isAttr = lo >= 0x3C0;
      if (this.splitOn && this.exMode <= 1 && this.inFrame && this._bgFetching()) {
        const sl = this.splitN >= 41 ? this.scanline + 1 : this.scanline;
        const vs = (sl + this.splitScroll) % 240, col = (this.splitN + 2) % 42;
        if (isNt) {
          if (col === 0) this.splitIn = !this.splitRight;
          if (col === this.splitTile && this.splitN < 42) this.splitIn = !this.splitIn;
          else if (col > 32) this.splitIn = false;
          if (this.splitIn) { this.splitAddr = ((vs & 0xF8) << 2) | col; return this.exram[this.splitAddr]; }
        } else if (this.splitIn) {
          const t = this.splitAddr, shift = ((t >> 4) & 4) | (t & 2), at = 0x3C0 | ((t & 0x380) >> 4) | ((t & 0x1F) >> 2);
          return ((this.exram[at] >> shift) & 3) * 0x55;
        }
      }
      if (this.exMode === 1 && this._bgFetching()) {
        if (isAttr) return ((this.exTile >> 6) & 3) * 0x55;
        this.exTile = this.exram[lo];
      }
      switch (mode) {
        case 0: return this.ciram[lo];
        case 1: return this.ciram[0x400 | lo];
        case 2: return this.exMode < 2 ? this.exram[lo] : 0;
        default: return isAttr ? this.fillAttr : this.fillTile;
      }
    }
    ppuWrite(addr, v) {
      if (addr < 0x2000) { if (this.chrIsRam) this.chr[this._chrMap()[addr >> 10] + (addr & 0x3FF)] = v; return; }
      const mode = this._nt(addr), lo = addr & 0x3FF;
      if (mode === 0) this.ciram[lo] = v;
      else if (mode === 1) this.ciram[0x400 | lo] = v;
      else if (mode === 2 && this.exMode < 2) this.exram[lo] = v;
    }
    _scanlineTick() {
      if (!this.inFrame) { this.inFrame = true; this.scanline = 0; this.irqPend = false; }
      else { this.scanline++; if (this.scanline === this.irqCompare && this.irqCompare !== 0) this.irqPend = true; }
      this.idleDots = 0;
    }
    cpuClock(cycles) {
      // 描画が止まった(vblank/描画 OFF)ら「フレーム内」を下ろす。実機は NT 読みが 3 行ぶん無いと下りる
      const p = this.ppu;
      if (this.inFrame && p && (!(p.mask & 0x18) || (p.scanline >= 240 && p.scanline !== 261))) { this.inFrame = false; this.ntSame = 0; this.ntLast = -1; }
    }
    irqPending() { return this.irqPend && this.irqEnable; }
  }

  const TABLE = {
    0: NROM, 1: MMC1, 155: MMC1, 2: UxROM, 3: CNROM, 4: MMC3, 5: MMC5, 7: AxROM, 9: MMC2, 10: MMC2, 16: BandaiFCG, 18: JalecoSS88006, 19: Namco163,
    21: VRC24, 22: VRC24, 23: VRC24, 24: VRC6, 25: VRC24, 26: VRC6, 32: IremG101, 33: TaitoTC0190, 34: BNROM, 48: TaitoTC0690,
    65: IremH3001, 66: GxROM, 67: Sunsoft3, 68: Sunsoft4, 69: Sunsoft5B, 70: Bandai74161, 72: JalecoJF17, 73: VRC3, 75: VRC1,
    76: Namco108Variants, 77: IremLROG017, 78: JalecoJF16, 80: TaitoX1005, 82: TaitoX1017, 85: VRC7, 86: JalecoJF13, 87: JalecoJF13,
    88: Namco108Variants, 89: Sunsoft2, 92: JalecoJF17, 93: Sunsoft2, 94: UxROMVariants, 95: Namco108Variants, 97: UxROMVariants,
    140: JalecoJF13, 152: Bandai74161, 153: BandaiFCG, 154: Namco108Variants, 159: BandaiFCG, 180: UxROMVariants, 184: Sunsoft1,
    185: CNROMProtect, 206: Namco108, 210: Namco175,
  };

  const NesMappers = {
    supported(mapper) { return Object.prototype.hasOwnProperty.call(TABLE, mapper); },
    create(rom) {
      const C = TABLE[rom.mapper];
      if (!C) throw new Error(`マッパー ${rom.mapper} は未対応です(対応: ${Object.keys(TABLE).join(', ')})`);
      return new C(rom);
    },
    Mapper, NROM, MMC1, UxROM, CNROM, MMC3, MMC5, AxROM, Namco163, VRC24, VRC1, VRC6, Sunsoft5B, VRC7, Namco108,
    MMC2, BandaiFCG, JalecoSS88006, IremG101, IremH3001, TaitoTC0190, TaitoTC0690, TaitoX1005, TaitoX1017, Sunsoft1, Sunsoft2, Sunsoft3, Sunsoft4,
    Namco175, GxROM, BNROM, Bandai74161, JalecoJF17, JalecoJF13, VRC3, JalecoJF16, IremLROG017, UxROMVariants, CNROMProtect, Namco108Variants,
  };
  Emu.NesMappers = NesMappers;
})(typeof window !== 'undefined' ? window : globalThis);

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

  Emu.FdsDisk = { isFds, parse, buildSide, describe, Mapper: FdsMapper, SIDE_SIZE };
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
      mapper.ppu = this; // MMC5 が描画の位相(ドット・行・$2000/$2001)を見る
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
            if (k === 1) this.mapper.ppuRead(0x2000 | (this.v & 0x0FFF)); // ゴミの NT 読み(実機どおり。MMC5 はこれもタイル列として数える)
            else if (k === 3) this.mapper.ppuRead(0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07)); // ゴミの属性読み
            else if (k === 5) this.fetchSpriteSlot((dot - 257) >> 3, 0);
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
 *   マッパー(MMC3/MMC5/N163/VRC6/VRC7/5B)の線の論理和を、I フラグが下りていれば命令境界で受ける。
 * - $4014 OAM DMA は 256 バイトを即座に写し、513/514 サイクルを次の命令に乗せる。
 * - 音: setSampleRate(sr) を呼ぶと周辺を進める中で APU(+拡張音源)の混合をリングバッファへ標本化する。
 *   runFrame() は 1 フレームぶんを返し、runSamples(out) は out.length サンプルぶんだけ進める(AudioWorklet 用)。
 * - 入力: setController(port, bits)。bits は A=1 B=2 Select=4 Start=8 Up=16 Down=32 Left=64 Right=128。
 * - 録音(段階 6b): startRecording() → 以後、音源レジスタの書き込み(2A03/FDS/拡張音源)・N163 $4800 の読み飛ばし・
 *   DPCM の起動(サンプル本体つき)を rec.cur に積み、フレームが終わるたび rec.frames へ移す。書き込みの形は
 *   src/vgm/vgmRecord.js の encodeNesRecording が受ける物({addr,value,t,read?} / {dmc:{addr,data}})。
 *   開始時には今のレジスタ像(2A03 の影 $4000-$4017、拡張音源はマッパーの audioImage())を書き込みとして先頭に置く
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
    // opts.bios: FDS の BIOS(disksys.rom、8K)。.fds を開くときだけ要る
    constructor(romBytes, opts) {
      opts = opts || {};
      if (!(romBytes instanceof Uint8Array)) romBytes = new Uint8Array(romBytes);
      if (Emu.FdsDisk && Emu.FdsDisk.isFds(romBytes)) {
        this.rom = Emu.FdsDisk.parse(romBytes);
        this.mapper = new Emu.FdsDisk.Mapper(this.rom, opts.bios);
      } else {
        this.rom = Emu.INES.parse(romBytes);
        this.mapper = Emu.NesMappers.create(this.rom);
      }
      this.ppu = new Emu.PPU(this.mapper);
      this.apu = new Emu.APU2A03(this);
      this.cpu = new Emu.CPU6502(this);
      this.ram = new Uint8Array(0x800);
      this.apuShadow = new Uint8Array(0x18); // $4000-$4017 の最後の書き込み値(録音開始時の像)
      this.openBus = 0;
      this.pad = [0, 0]; this.padShift = [0, 0]; this.padStrobe = false;
      // 連射: padHeld(押しっぱなし)に padTurbo のビットを turboRate フレームごとに ON/OFF して足した物が pad(ゲームが読む値)
      this.padHeld = [0, 0]; this.padTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
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
    // bits=押しているボタン、turbo=連射するボタン(同じビット割り当て)。連射は turboRate フレームごとに押す/離すを繰り返す
    setController(port, bits, turbo) { port &= 1; this.padHeld[port] = bits & 0xFF; this.padTurbo[port] = (turbo | 0) & 0xFF; this._applyPad(port); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(0); this._applyPad(1); }
    _applyPad(p) { const on = ((this.turboPhase / this.turboRate) | 0) === 0; this.pad[p] = this.padHeld[p] | (on ? this.padTurbo[p] : 0); }
    // FDS のディスク(面)。.fds 以外では 0 面
    get diskCount() { return this.mapper.sides ? this.mapper.sides.length : 0; }
    get diskNumber() { return this.mapper.sides ? this.mapper.diskNumber : -1; }
    insertDisk(n) { if (this.mapper.insertDisk) this.mapper.insertDisk(n); }
    ejectDisk() { if (this.mapper.ejectDisk) this.mapper.ejectDisk(); }
    // NSF ヘッダと同じ拡張音源ビット(録音の NESX ヘッダ用)
    extBits() { return this.mapper.audio ? (this.mapper.extBits || 0) : 0; }
    // ── バッテリ バックアップ(セーブ)──
    // iNES でバッテリ ビットが立っていれば PRG RAM 全体、.fds ならディスク全面(ギャップつき)が保存の対象。
    // 書き込みがあると batteryDirty が立つ(主スレッド/ヘッドレスがそれを見て保存し、clearBatteryDirty() で下ろす)
    get hasBattery() { return !!(this.rom.battery || this.rom.fds); }
    get batteryDirty() { return this._batDirty || !!this.mapper.diskDirty; }
    clearBatteryDirty() { this._batDirty = false; this.mapper.diskDirty = false; }
    getBattery() {
      if (!this.hasBattery) return null;
      if (this.rom.fds) { const sides = this.mapper.sides, out = new Uint8Array(sides.length * sides[0].length); sides.forEach((s, i) => out.set(s, i * s.length)); return out; }
      return this.mapper.prgRam.slice();
    }
    setBattery(bytes) {
      if (!this.hasBattery || !bytes) return false;
      bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (this.rom.fds) {
        const sides = this.mapper.sides;
        if (bytes.length !== sides.length * sides[0].length) return false;
        sides.forEach((s, i) => s.set(bytes.subarray(i * s.length, (i + 1) * s.length)));
      } else {
        if (bytes.length !== this.mapper.prgRam.length) return false;
        this.mapper.prgRam.set(bytes);
      }
      this.clearBatteryDirty();
      return true;
    }
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
        else if (this.rec && addr >= 0x4800) { const ra = this.mapper.audioReadAddr(addr); if (ra >= 0) this.rec.cur.push({ addr: ra, value: 0, read: true, t: this._t() }); }
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
      if (addr >= 0x6000 && addr < 0x8000) this._batDirty = true; // PRG RAM(セーブ)への書き込み
      if (this.mapper.audio) { const aa = this.mapper.audioAddr(addr); if (aa >= 0) this._logWrite(aa, v); } // 正規の番地で記録(VRC6b の A0/A1 入れ替えなど)
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
      // 拡張音源の像(マッパーが影レジスタから作る。N163 は内部 RAM 128 バイト、VRC7/5B はレジスタ番号と値の対)
      if (this.mapper.audio) for (const w of this.mapper.audioImage()) cur.push({ addr: w.addr, value: w.value, t: 0 });
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
      if (this.padTurbo[0] || this.padTurbo[1] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(0); this._applyPad(1); }
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
 * NES 本体のステート(状態の保存・復元) MML.Emu.NesState — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7、段階 6e-6)
 *
 * 作り: 本体(NesConsole)のオブジェクト木を汎用に深く写す。CPU/PPU/APU/マッパー/拡張音源のクラスごとに直列化を書かない。
 *   - 数値・真偽・文字列・null はそのまま、型付き配列は複製、配列と普通のオブジェクト(クラスのインスタンス含む)は再帰。
 *   - 除外: 関数、ROM データ(rom と、rom.prg / rom.chr と同じ実体の配列=CHR ROM)、録音中の列(rec)、音のリング(ring)、
 *     画面(frame。復元後の最初のフレームで描き直る)、コールバック(onFrame/onWrite)、本体自身への逆参照(cpu.bus、
 *     apu.dmc.bus)。2 度目に出会ったオブジェクト(ppu.mapper と console.mapper など)は参照の印だけ置く。
 *   - 復元は「同じ順で木を辿って、既存のインスタンスへ値を書き戻す」。型付き配列は長さが同じなら set、違えば置き換え。
 *     プロトタイプ(メソッド)はそのまま残るので、どの音源クラスでも動く。保存と復元で木の形が同じことが前提
 *     (同じ ROM、同じ BIOS)。
 * 形: { v: 1, mapper, prgLen, chrLen, tree }。postMessage / IndexedDB の構造化複製で運べる(JSON にはしない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SKIP_KEYS = new Set(['rom', 'rec', 'ring', 'frame', 'onFrame', 'onWrite', 'bus']);
  const REF = '__ref';

  function isTyped(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); }

  function snapshot(root, skipArrays) {
    const seen = new Map();
    let nextId = 1;
    function walk(obj, top) {
      if (obj === null || typeof obj !== 'object') return typeof obj === 'function' ? undefined : obj;
      if (isTyped(obj)) { for (const a of skipArrays) if (a === obj) return undefined; return obj.slice(); }
      if (obj === root && !top) return undefined; // 本体への逆参照(cpu.bus など)
      if (seen.has(obj)) return { [REF]: seen.get(obj) };
      const id = nextId++; seen.set(obj, id);
      if (Array.isArray(obj)) return obj.map((x) => { const w = walk(x); return w === undefined ? null : w; });
      const out = {};
      for (const k of Object.keys(obj)) {
        if (SKIP_KEYS.has(k)) continue;
        const w = walk(obj[k]);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return walk(root, true);
  }

  function restore(live, snap) {
    function apply(target, s) {
      for (const k of Object.keys(s)) {
        const v = s[k], cur = target[k];
        if (v === null || typeof v !== 'object') { target[k] = v; continue; }
        if (v[REF] !== undefined && Object.keys(v).length === 1) continue; // 参照の印: 主経路で復元済み
        if (isTyped(v)) { if (isTyped(cur) && cur.length === v.length && cur.constructor === v.constructor) cur.set(v); else target[k] = v.slice(); continue; }
        if (Array.isArray(v)) {
          if (Array.isArray(cur) && cur.length === v.length) {
            for (let i = 0; i < v.length; i++) {
              const x = v[i];
              if (x === null || typeof x !== 'object') cur[i] = x;
              else if (x[REF] !== undefined && Object.keys(x).length === 1) continue;
              else if (isTyped(x)) { if (isTyped(cur[i]) && cur[i].length === x.length && cur[i].constructor === x.constructor) cur[i].set(x); else cur[i] = x.slice(); }
              else if (cur[i] && typeof cur[i] === 'object') apply(cur[i], x);
              else cur[i] = x;
            }
          } else target[k] = v.map((x) => (isTyped(x) ? x.slice() : x));
          continue;
        }
        if (cur && typeof cur === 'object') apply(cur, v); else target[k] = v;
      }
    }
    apply(live, snap);
  }

  const NesState = {
    // 本体 nes の状態を写して返す(nes は走らせたまま呼んでよい。rec は含めない)
    save(nes) {
      const rom = nes.rom;
      const skip = [rom.prg, rom.chr].filter(Boolean);
      return { v: 1, mapper: rom.mapper, prgLen: rom.prg ? rom.prg.length : 0, chrLen: rom.chr ? rom.chr.length : 0, tree: snapshot(nes, skip) };
    },
    // 同じ ROM で作ったステートを nes に書き戻す。合わなければ false
    load(nes, state) {
      if (!state || state.v !== 1 || !state.tree) return false;
      const rom = nes.rom;
      if (state.mapper !== rom.mapper || state.prgLen !== (rom.prg ? rom.prg.length : 0) || state.chrLen !== (rom.chr ? rom.chr.length : 0)) return false;
      const rec = nes.rec;
      restore(nes, state.tree);
      nes.rec = rec;                       // 録音中ならそのまま続ける
      nes.ringHead = 0; nes.ringLen = 0;   // 音のリングは捨てる
      nes._frameFlag = false;
      return true;
    },
  };
  Emu.NesState = NesState;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * NES 巻き戻し (MML.Emu.NesRewind) — 状態スナップショット+入力ログで任意のフレームへ戻る
 *
 * 仕組み: INTERVAL フレームごとに NesState.save で状態を控え(直近 KEEP 個)、毎フレームの終わりにパッドの値
 * (ゲームが $4016/$4017 で読む値。連射の ON/OFF 後)を記録する。rewindTo(frame) は目標以前の一番近い
 * スナップショットを読み込み、記録したパッド値を与えながら目標フレームまで進める(同じ入力なので同じ結果になる。
 * フレームの途中で変わった入力はそのフレームの終わりの値で代表させるので、そこだけ 1 フレーム以内の違いが出うる)。
 * 録音(rec)はスナップショットに入らないので、戻った後は像から取り直す(呼び出し側)。
 * 使い方: const rw = new NesRewind(nes); 毎フレーム rw.onFrame(); 戻るときは rw.rewindTo(frame)。
 * reset/ステート読込/ディスク交換の後は clear()(履歴が今の状態とつながらない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INTERVAL = 30;   // スナップショットの間隔(フレーム)。0.5 秒
  const KEEP = 240;      // 控える個数。2 分

  class NesRewind {
    constructor(nes) {
      this.nes = nes;
      this.snaps = [];          // [{ frame, state }] frame = そのフレームが終わった時点の frameCount
      this.pads = [];           // pads[frameCount] = pad0 | pad1 << 8(そのフレーム終わりの値。フレーム番号は frameCount)
      this.base = 0;            // pads の先頭が指す frameCount(古い分は捨てる)
      this.replaying = false;
    }
    clear() { this.snaps.length = 0; this.pads.length = 0; this.base = this.nes.frameCount; }
    // 戻れる一番古いフレーム(無ければ今のフレーム)
    get oldest() { return this.snaps.length ? this.snaps[0].frame : this.nes.frameCount; }
    // 毎フレーム(_frameEnd の後)に呼ぶ
    onFrame() {
      if (this.replaying) return;
      const nes = this.nes, f = nes.frameCount;
      if (this.base > f) this.clear();
      this.pads[f - this.base] = (nes.pad[0] & 0xFF) | ((nes.pad[1] & 0xFF) << 8);
      if (f % INTERVAL === 0) {
        this.snaps.push({ frame: f, state: Emu.NesState.save(nes) });
        if (this.snaps.length > KEEP) {
          const drop = this.snaps.shift();
          // 捨てたスナップショットより前のパッド記録も要らない
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.pads.splice(0, keepFrom - this.base); this.base = keepFrom; }
          void drop;
        }
      }
    }
    // frame(frameCount)の終わりの状態へ戻す。戻れた frameCount を返す(目標が古すぎれば一番古い所、未来なら今のまま)
    rewindTo(frame) {
      const nes = this.nes;
      if (!this.snaps.length || frame >= nes.frameCount) return nes.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const snap = this.snaps[si];
      Emu.NesState.load(nes, snap.state);
      // 控えていたパッドの値で進める(setController を通さず pad を直接。連射の位相も記録に含まれている)
      const held = [nes.padHeld[0], nes.padHeld[1]], turbo = [nes.padTurbo[0], nes.padTurbo[1]];
      this.replaying = true;
      try {
        while (nes.frameCount < frame) {
          const p = this.pads[nes.frameCount + 1 - this.base];
          if (p !== undefined) { nes.pad[0] = p & 0xFF; nes.pad[1] = (p >> 8) & 0xFF; }
          nes.runFrame();
        }
      } finally { this.replaying = false; }
      // 未来のスナップショットとパッド記録は捨てる
      this.snaps.length = si + 1;
      this.pads.length = Math.max(0, nes.frameCount + 1 - this.base);
      // 今押している物に戻す
      nes.padHeld[0] = held[0]; nes.padHeld[1] = held[1]; nes.padTurbo[0] = turbo[0]; nes.padTurbo[1] = turbo[1];
      nes._applyPad(0); nes._applyPad(1);
      return nes.frameCount;
    }
  }
  NesRewind.INTERVAL = INTERVAL;
  NesRewind.KEEP = KEEP;
  Emu.NesRewind = NesRewind;
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
      this.speed = 1; this.ffTmp = null; this.ffSkip = 0;
      this.dcX = 0; this.dcY = 0;
      this.frameSeq = 0;
      this.port.onmessage = (e) => this.onMessage(e.data || {});
    }
    onMessage(m) {
      try {
        switch (m.type) {
          case 'load': {
            const nes = new MML.Emu.NesConsole(new Uint8Array(m.rom), { bios: m.bios ? new Uint8Array(m.bios) : null });
            nes.setSampleRate(sampleRate);
            nes.onFrame = () => this.onFrame();
            if (m.battery) nes.setBattery(new Uint8Array(m.battery)); // 前回のセーブ(主スレッドが IndexedDB から)
            this.nes = nes;
            this.rewind = MML.Emu.NesRewind ? new MML.Emu.NesRewind(nes) : null;
            this.dcX = 0; this.dcY = 0;
            this.port.postMessage({ type: 'loaded', info: MML.Emu.INES.describe(nes.rom), extBits: nes.extBits(), sampleRate, disks: nes.diskCount, battery: nes.hasBattery });
            break;
          }
          case 'unload': // 止める前の最後のセーブ要求。変化が無くても返事をする(主スレッドが待つ)
            this.postBattery(true);
            break;
          case 'disk': // FDS: side < 0 で取り出し、0 以上でその面を入れる
            if (!this.nes) break;
            if (m.side < 0) this.nes.ejectDisk(); else this.nes.insertDisk(m.side | 0);
            if (this.rewind) this.rewind.clear();
            break;
          case 'pad': if (this.nes) this.nes.setController(m.port | 0, m.bits | 0, m.turbo | 0); break;
          case 'turboRate': if (this.nes) this.nes.setTurboRate(m.frames | 0); break;
          case 'reset': if (this.nes) { this.nes.reset(); if (this.rewind) this.rewind.clear(); } break;
          case 'mix': { // 鍵盤表示のミュート/音量(2A03 は apu.mute/vol、拡張音源はマッパーの audio.mute/vol)。capture.js の applyMute/applyVolume と同じ流儀(バンドルに無いので自前)
            if (!this.nes) break;
            const put = (target, source, conv) => {
              if (!target || !source) return;
              if (Array.isArray(target)) { for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); }
              else for (const k of Object.keys(target)) if (source[k] !== undefined) target[k] = conv(source[k]);
            };
            const a = this.nes.mapper.audio;
            if (m.mute) { put(this.nes.apu.mute, m.mute.apu, (v) => !!v); if (a) put(a.mute, m.mute.ext, (v) => !!v); }
            if (m.volume) { put(this.nes.apu.vol, m.volume.apu, (v) => Math.max(0, Math.min(2, +v || 0))); if (a) put(a.vol, m.volume.ext, (v) => Math.max(0, Math.min(2, +v || 0))); }
            break;
          }
          case 'rewind': { // frame(本体の frameCount)の終わりへ戻る。録音中なら像から取り直す。戻った所の画面と frameCount を返す
            if (!this.nes || !this.rewind) break;
            const wasRec = !!this.nes.rec;
            this.nes.rec = null;
            const got = this.rewind.rewindTo(m.frame | 0);
            if (wasRec) this.nes.startRecording();
            this.frameSeq = got;
            const frame = this.nes.frame.slice();
            this.port.postMessage({ type: 'rewound', frame: frame.buffer, seq: got, oldest: this.rewind.oldest }, [frame.buffer]);
            break;
          }
          case 'pause': this.paused = !!m.on; break;
          case 'speed': this.speed = Math.max(1, Math.min(8, m.n | 0)); break; // 早送り: 1 回の process で speed 回ぶん進める(音は最後の 1 回ぶんだけ出す)
          case 'saveState': // ステート保存: 木を写して主スレッドへ(構造化複製。IndexedDB に置くのは主スレッド)
            if (this.nes) this.port.postMessage({ type: 'state', state: MML.Emu.NesState.save(this.nes), slot: m.slot });
            break;
          case 'loadState':
            if (this.nes) { const ok = MML.Emu.NesState.load(this.nes, m.state); if (ok) { if (this.rewind) this.rewind.clear(); this.frameSeq = this.nes.frameCount; } this.port.postMessage({ type: 'stateLoaded', ok }); }
            break;
          case 'record':
            // 録音は VGM(主スレッドが溜める)とライブ表示(ロールへ流す)の 2 つが使う。
            //   on: 既に録音中なら溜まった分(途中のフレーム込み)を writes として先に送ってから、像を取り直して始める
            //   off: 止めて recordEnd を返す。keep なら(ライブ表示が要るので)すぐ像を取り直して続ける。discard なら返さない
            if (!this.nes) break;
            if (m.on) {
              if (this.nes.rec) this.port.postMessage({ type: 'writes', frames: this.nes.stopRecording() }); // 途中のフレームも末尾に入る
              this.nes.startRecording();
            } else {
              const frames = this.nes.stopRecording();
              if (!m.discard) this.port.postMessage({ type: 'recordEnd', frames });
              if (m.keep) this.nes.startRecording();
            }
            break;
        }
      } catch (e) {
        this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) });
      }
    }
    onFrame() {
      const nes = this.nes;
      if (this.rewind) { if (this.rewind.replaying) return; this.rewind.onFrame(); } // 巻き戻しの再生中は送らない
      this.frameSeq = nes.frameCount; // 主スレッドのフレーム番号 = 本体の frameCount(巻き戻しで戻る)
      if (this.speed > 1 && (++this.ffSkip % this.speed) !== 0) { if ((this.frameSeq % 60) === 0) this.postBattery(false); return; } // 早送り中は speed 枚に 1 枚だけ送る(録音の書き込み列は次に送る時まで溜まる)
      const frame = nes.frame.slice();
      const msg = { type: 'frame', seq: this.frameSeq, frame: frame.buffer, underruns: nes.underruns };
      if (nes.rec) { msg.writes = nes.rec.frames.splice(0); }
      this.port.postMessage(msg, [frame.buffer]);
      if ((this.frameSeq % 60) === 0) this.postBattery(false); // 1 秒ごとに、セーブ RAM が変わっていれば主スレッドへ
    }
    // セーブ RAM(バッテリ/FDS ディスク)を主スレッドへ送る。final=true は unload への返事(変化が無くても data 無しで返す)
    postBattery(final) {
      const nes = this.nes;
      if (!nes || !nes.hasBattery) { if (final) this.port.postMessage({ type: 'battery', final: true, data: null }); return; }
      if (!nes.batteryDirty) { if (final) this.port.postMessage({ type: 'battery', final: true, data: null }); return; }
      const data = nes.getBattery();
      nes.clearBatteryDirty();
      this.port.postMessage({ type: 'battery', final: !!final, data: data.buffer }, [data.buffer]);
    }
    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      if (!this.nes || this.paused) { out.fill(0); return true; }
      try {
        if (this.speed > 1) {
          if (!this.ffTmp || this.ffTmp.length !== out.length) this.ffTmp = new Float32Array(out.length);
          for (let k = 1; k < this.speed; k++) this.nes.runSamples(this.ffTmp); // 捨てる分
        }
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