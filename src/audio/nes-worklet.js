/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-11-13 20:33:55
 *
 * regsOnly capture worker bundle (nesWorklet). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.nesWorklet is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.nesWorkletBuiltAt = '2026-11-13 20:33:55';
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
      if (this.timer <= 0) { // 保険: 周期が負になっても止まらない
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
        // 負(パルス 1 の 1 の補数で周期 0/1 のとき)は 11bit の加算器どおり折り返す。以前は -1 がそのまま周期になり、
        // タイマが負のまま減り続けて(0 に戻らない)そのチャンネルが永久に黙った(ゲームの効果音でスイープを使うと起きた)
        if (target <= 0x7FF) this.timerPeriod = target & 0x7FF;
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
 *   ppuA12(addr, time): PPU がパターン表/NT/属性を読むたびに呼ぶ(time = 単調なドット番号)。
 *     MMC3 の IRQ カウンタは A12 の立ち上がりで進む。実機は M2 のフィルタで「A12 が約 3 CPU サイクル(≒10 ドット)以上
 *     低かった後の立ち上がり」だけ数えるので、「A12 の低い読みが最初にあった時刻から 10 ドット以上たって高い読みが来たら
 *     1 回」と数える(BG が $1000・スプライトが $0000 なら行ごとにスプライト取得の窓で 1 回。行末 337 ドットの NT 読みから
 *     次の行の 5 ドットまでは 9 ドットなので数えない。以前は「最後に高かった時刻から 10 ドット」で数えていて、A12 が
 *     低くならなくても行末の隙間で 1 回余計に進み、IRQ が 2 倍の速さで来るゲームがあった)
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
  //   連続サイクルの二重書き: RMW 命令(INC $FFFF など)は古い値のダミー書きの次のサイクルに本物を書く。MMC1 は 2 つ目を無視する
  //   (NesConsole が cpuWrite の第 3 引数でダミー書きを知らせる)。リセット用の INC $FFFx で bit7 の古い値が効き、本物の 0 は捨てる
  class MMC1 extends Mapper {
    constructor(rom) {
      super(rom);
      this.shift = 0x10; this.control = 0x0C; this.chr0 = 0; this.chr1 = 0; this.prgReg = 0; this.lastChr = 0; this.skipWrite = false;
      this.fixed32 = (rom.submapper | 0) === 5;
      this.ramBanks = this.prgRam.length >> 13; // 1/2/4
      this.ramBank = 0;
      this.apply();
    }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[(this.ramBank << 13) | (addr & 0x1FFF)];
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v, rmwDummy) {
      if (addr >= 0x8000) {
        if (this.skipWrite) { this.skipWrite = false; return; } // ダミー書きの直後(同じ命令の本物の書き)は無視
        this.skipWrite = !!rmwDummy;
        this.writeReg(addr, v);
      } else if (addr >= 0x6000) this.prgRam[(this.ramBank << 13) | (addr & 0x1FFF)] = v;
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
      this.a12Low = -1; // A12 が低い読みが最初にあった時刻(高い読みで -1 に戻す)
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
      if (addr & 0x1000) {
        if (this.a12Low >= 0 && time - this.a12Low >= 10) this.clockIrq();
        this.a12Low = -1;
      } else if (this.a12Low < 0) this.a12Low = time;
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

  // シリアル EEPROM(I2C)。Bandai の基板が $6000 読みの bit4(SDA)と $800D 書きの bit5(SCL)/bit6(SDA)でビット単位に話す。
  //   24C01(X24C01、128 バイト): START → 7bit 番地+R/W → ACK → データ(読みは ACK で続き、書きは 1 バイトごと ACK)。
  //   24C02(256 バイト): START → デバイス番地(1010xxxR) → ACK → (書き: 番地 → ACK → データ…)/(読み: 今の番地から)。
  //   挙動は Mesen の Eeprom24C01/24C02 と同じ(ビットは MSB から。出力は離すと 1)。
  const EE_IDLE = 0, EE_ADDR = 1, EE_READ = 2, EE_WRITE = 3, EE_SENDACK = 4, EE_WAITACK = 5, EE_CHIP = 6;
  class Eeprom24C0X {
    constructor(size) {
      this.size = size; this.data = new Uint8Array(size).fill(0xFF);
      this.mode = EE_IDLE; this.next = EE_IDLE; this.chip = 0; this.address = 0; this.byte = 0; this.counter = 0;
      this.output = 1; this.prevScl = 0; this.prevSda = 0; this.dirty = false;
    }
    read() { return this.output; }
    writeScl(scl) { this.write(scl, this.prevSda); }
    writeSda(sda) { this.write(this.prevScl, sda); }
    _in(field, sda) { if (this.counter < 8) { const bit = 7 - this.counter; this[field] = (this[field] & ~(1 << bit)) | (sda << bit); this.counter++; } }
    _out() { if (this.counter < 8) { this.output = (this.byte >> (7 - this.counter)) & 1; this.counter++; } }
  }
  class Eeprom24C01 extends Eeprom24C0X {
    constructor() { super(128); }
    write(scl, sda) {
      if (this.prevScl && scl && this.prevSda && !sda) { this.mode = EE_ADDR; this.address = 0; this.counter = 0; this.output = 1; } // START
      else if (this.prevScl && scl && !this.prevSda && sda) { this.mode = EE_IDLE; this.output = 1; }                           // STOP
      else if (scl && !this.prevScl) { // 立ち上がり
        switch (this.mode) {
          case EE_ADDR:
            if (this.counter < 7) this._in('address', sda);
            else { this.counter = 8; if (sda) { this.next = EE_READ; this.byte = this.data[this.address & 0x7F]; } else this.next = EE_WRITE; }
            break;
          case EE_SENDACK: this.output = 0; break;
          case EE_READ: this._out(); break;
          case EE_WRITE: this._in('byte', sda); break;
          case EE_WAITACK: if (sda) this.mode = EE_IDLE; break;
        }
      } else if (!scl && this.prevScl) { // 立ち下がり
        switch (this.mode) {
          case EE_ADDR: if (this.counter === 8) { this.mode = EE_SENDACK; this.output = 1; } break;
          case EE_SENDACK: this.mode = this.next; this.counter = 0; this.output = 1; break;
          case EE_READ: if (this.counter === 8) { this.mode = EE_WAITACK; this.address = (this.address + 1) & 0x7F; } break;
          case EE_WRITE: if (this.counter === 8) { this.data[this.address & 0x7F] = this.byte; this.dirty = true; this.address = (this.address + 1) & 0x7F; this.mode = EE_SENDACK; this.next = EE_IDLE; } break;
          case EE_WAITACK: this.mode = EE_READ; this.counter = 0; this.byte = this.data[this.address & 0x7F]; this.output = 1; break;
        }
      }
      this.prevScl = scl; this.prevSda = sda;
    }
  }
  class Eeprom24C02 extends Eeprom24C0X {
    constructor() { super(256); this.decided = null; } // 最初のデバイス番地で 'ok'/'ng'(16 の種別判定用)
    write(scl, sda) {
      if (this.prevScl && scl && this.prevSda && !sda) { this.mode = EE_CHIP; this.counter = 0; this.output = 1; } // START
      else if (this.prevScl && scl && !this.prevSda && sda) { this.mode = EE_IDLE; this.output = 1; }            // STOP
      else if (scl && !this.prevScl) {
        switch (this.mode) {
          case EE_CHIP: this._in('chip', sda); break;
          case EE_ADDR: this._in('address', sda); break;
          case EE_WRITE: this._in('byte', sda); break;
          case EE_READ: this._out(); break;
          case EE_SENDACK: this.output = 0; break;
          case EE_WAITACK: if (!sda) { this.byte = this.data[this.address]; this.next = EE_READ; } else this.next = EE_IDLE; break;
        }
      } else if (!scl && this.prevScl) {
        switch (this.mode) {
          case EE_CHIP:
            if (this.counter === 8) {
              if ((this.chip & 0xF0) === 0xA0) { this.decided = 'ok'; this.counter = 0; this.mode = EE_SENDACK; this.output = 1; if (this.chip & 1) { this.next = EE_READ; this.byte = this.data[this.address]; } else this.next = EE_ADDR; }
              else { this.decided = 'ng'; this.mode = EE_IDLE; this.output = 1; }
            }
            break;
          case EE_ADDR: if (this.counter === 8) { this.counter = 0; this.mode = EE_SENDACK; this.next = EE_WRITE; this.output = 1; } break;
          case EE_READ: if (this.counter === 8) { this.counter = 0; this.mode = EE_WAITACK; this.address = (this.address + 1) & 0xFF; } break;
          case EE_WRITE: if (this.counter === 8) { this.counter = 0; this.data[this.address] = this.byte; this.dirty = true; this.address = (this.address + 1) & 0xFF; this.mode = EE_SENDACK; this.next = EE_WRITE; } break;
          case EE_SENDACK: case EE_WAITACK: this.mode = this.next; this.counter = 0; this.output = 1; break;
        }
      }
      this.prevScl = scl; this.prevSda = sda;
    }
  }

  // 16/153/157/159: Bandai FCG-1/2・LZ93D50(レジスタは $6000-$7FFF と $8000-$FFFF の両方。NES 2.0 のサブマッパー 4 は
  //   FCG-1/2=$6000 側だけ・IRQ カウンタ直書き、5 は LZ93D50=$8000 側だけ)。0-7 CHR 1K、8 PRG 16K、9 ミラーリング、
  //   A IRQ 有効(有効化でラッチをカウンタへ)、B/C ラッチ下位/上位、D EEPROM(bit5=SCL、bit6=SDA。読みは $6000 の bit4)。
  //   EEPROM: 159 は 24C01、157(Datach)は本体の 24C02 とカートリッジの 24C01(SCL は CHR レジスタ 0-3 の bit3、SDA は D の
  //   bit6。読みは両方の AND。バーコードリーダーは無し)。16 は iNES のヘッダでは 24C01 の基板(本来 159)も 16 と書かれているので、
  //   24C02 と 24C01 の両方に同じ信号を入れ、最初の 1 バイトがデバイス番地(1010xxxx)なら 24C02、違えば 24C01 と決める
  //   (NES 2.0 のサブマッパー 4 は EEPROM 無し、5 はセーブ 256 バイトのときだけ 24C02)。16 で PRG 512K の物は 153(SRAM)扱い。
  //   EEPROM の中身はセーブデータとして扱う(getBatteryData/setBatteryData)。
  //   153(大容量): CHR レジスタの bit0 が PRG の外側バンク、$6000 RAM は D の bit5。IRQ は 16bit ダウン、0 で IRQ
  class BandaiFCG extends Mapper {
    constructor(rom) {
      super(rom);
      this.sub = rom.submapper | 0; this.big = rom.mapper === 153 || this.prgBanks8 >= 0x40; // 512K 以上
      this.sram = this.big; // 153(と 16 で 512K): $6000 は SRAM、EEPROM 無し
      this.chrRegs = new Uint8Array(8); this.prgPage = 0; this.outer = 0;
      this.irqEnable = false; this.irqCounter = 0; this.irqLatch = 0;
      this.eeprom = null; this.eeprom2 = null;
      this.eepromAlt = null; // 16(iNES): 種別が決まるまで 24C01 にも同じ信号を入れておく
      if (this.sram) { /* SRAM */ }
      else if (rom.mapper === 157) { this.eeprom = new Eeprom24C02(); this.eeprom2 = new Eeprom24C01(); }
      else if (rom.mapper === 159) this.eeprom = new Eeprom24C01();
      else if (rom.mapper === 16 && this.sub === 0) { this.eeprom = new Eeprom24C02(); this.eepromAlt = new Eeprom24C01(); }
      else if (rom.mapper === 16 && this.sub === 5 && rom.prgRamSize === 256) this.eeprom = new Eeprom24C02();
      if (this.eeprom) {
        this.getBatteryData = () => { const a = this.eeprom.data, b = this.eeprom2 ? this.eeprom2.data : null; const out = new Uint8Array(a.length + (b ? b.length : 0)); out.set(a); if (b) out.set(b, a.length); return out; };
        this.setBatteryData = (bytes) => { const a = this.eeprom.data, b = this.eeprom2 ? this.eeprom2.data : null; if (bytes.length !== a.length + (b ? b.length : 0)) return false; a.set(bytes.subarray(0, a.length)); if (b) b.set(bytes.subarray(a.length)); return true; };
      }
      this.setPrg16(0, 0); this.setPrg16(1, 0x0F);
    }
    get diskDirty() { return !!((this.eeprom && this.eeprom.dirty) || (this.eeprom2 && this.eeprom2.dirty)); } // 本体の batteryDirty が見る
    set diskDirty(v) { if (!v) { if (this.eeprom) this.eeprom.dirty = false; if (this.eeprom2) this.eeprom2.dirty = false; } }
    cpuRead(addr) {
      if (addr >= 0x6000 && addr < 0x8000) {
        if (this.sram) return this.prgRam[(addr - 0x6000) & 0x1FFF];
        if (!this.eeprom) return 0x10; // EEPROM 無し: SDA=1
        let sda = this.eeprom.read(); if (this.eeprom2) sda &= this.eeprom2.read();
        return sda << 4; // バーコードリーダー(bit3)は無し
      }
      return super.cpuRead(addr);
    }
    cpuWrite(addr, v) {
      if (addr < 0x6000) return;
      if (addr < 0x8000) {
        if (this.sram) { this.prgRam[(addr - 0x6000) & 0x1FFF] = v; return; }
        if (this.sub === 5) return;
      } else if (this.sub === 4) return;
      this.writeReg(addr, v);
    }
    writeReg(addr, v) {
      const fcg = this.rom.mapper === 16 && this.sub === 4;
      switch (addr & 0x0F) {
        case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
          this.chrRegs[addr & 7] = v;
          if (this.eeprom2 && (addr & 7) < 4) this.eeprom2.writeScl((v >> 3) & 1);
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
        case 0xD: // EEPROM / 153 の RAM 許可(RAM は常に許可)
          if (this.eeprom) {
            this.eeprom.write((v >> 5) & 1, (v >> 6) & 1);
            if (this.eeprom2) this.eeprom2.writeSda((v >> 6) & 1);
            if (this.eepromAlt) { // 種別の判定: 24C02 がデバイス番地を受け取った/蹴った時点で決める
              this.eepromAlt.write((v >> 5) & 1, (v >> 6) & 1);
              const d = this.eeprom.decided;
              if (d === 'ok') this.eepromAlt = null;
              else if (d === 'ng') { this.eeprom = this.eepromAlt; this.eepromAlt = null; }
            }
          }
          break;
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
  //   iNES のヘッダは TC0690(48、IRQ つき)の基板も 33 と書いている物が多いので、33 も TC0690 として動かし、$C000-$C003/$E000
  //   (TC0190 には無いレジスタ)に書いた時点で 48 の流儀に切り替える(それまでは $8000 bit6 がミラーリング、IRQ 無し)
  // 48: Taito TC0690(TC0190 + MMC3 風の A12 IRQ: $C000 ラッチ(値の反転、サブマッパー 1 は +1)、$C001 リロード、
  //   $C002 有効、$C003 無効。IRQ は A12 の数え上げから数サイクル遅れる(Mesen と同じ 22、サブマッパー 1 は 6)。
  //   ミラーリングは $E000 bit6)
  class TaitoTC0690 extends MMC3 {
    constructor(rom) { super(rom); this.irqDelay = 0; this.tc0190 = rom.mapper === 33; this.setPrg8(2, -2); this.setPrg8(3, -1); }
    apply() {}
    writeReg(addr, v) {
      if (this.tc0190) {
        if ((addr & 0xE000) === 0xC000 || (addr & 0xE003) === 0xE000) this.tc0190 = false; // 48 の基板だった
        else if ((addr & 0xA003) === 0x8000) this.setMirroring((v & 0x40) ? 'H' : 'V');
      }
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
      if (this.tc0190) return;
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
    0: NROM, 1: MMC1, 155: MMC1, 2: UxROM, 3: CNROM, 4: MMC3, 5: MMC5, 7: AxROM, 9: MMC2, 10: MMC2, 16: BandaiFCG, 157: BandaiFCG, 18: JalecoSS88006, 19: Namco163,
    21: VRC24, 22: VRC24, 23: VRC24, 24: VRC6, 25: VRC24, 26: VRC6, 32: IremG101, 33: TaitoTC0690, 34: BNROM, 48: TaitoTC0690,
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
    MMC2, BandaiFCG, JalecoSS88006, IremG101, IremH3001, TaitoTC0690, TaitoX1005, TaitoX1017, Sunsoft1, Sunsoft2, Sunsoft3, Sunsoft4,
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

  // ディスクシステムの BIOS(disksys.rom)か: 8K ちょうどで、MSX カートリッジの 'AB' ヘッダが無く、末尾の 6502 ベクタ(NMI/RESET/IRQ)が
  // すべて $E000-$FFFF(BIOS の置き場)を指す。拡張子は見ない(.rom なので MSX の ROM と取り違えやすい)
  function isFdsBios(bytes) {
    if (!bytes || bytes.length !== 0x2000) return false;
    if (bytes[0] === 0x41 && bytes[1] === 0x42) return false;
    for (let o = 0x1FFA; o < 0x2000; o += 2) if (bytes[o + 1] < 0xE0) return false;
    return true;
  }
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
      this.diskAccess = (this.diskAccess || 0) + 1; // アクセスランプ用(ヘッドが読み書きしたバイト数)
      this.diskPosition++;
      if (this.diskPosition >= side.length) { this.motorOn = false; if (this.diskIrqEnabled) this.diskIrq = true; }
      else this.delay = 149;
    }
  }

  Emu.FdsDisk = { isFds, isFdsBios, parse, buildSide, describe, Mapper: FdsMapper, SIDE_SIZE };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * 2C02 PPU (MML.Emu.PPU) — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7)
 *
 * ドット単位で動く(1 CPU サイクル = 3 ドット、1 行 341 ドット、262 行)。「遊べる」に要る物を実装する:
 *   背景(loopy の v/t/x/w、2 本の 16bit シフトレジスタ)、スプライト(8×8 / 8×16、優先順位、行 8 枚、
 *   溢れフラグ)、スプライト 0 ヒット、NMI(241 行目 1 ドット目)、奇数フレームのドット飛ばし、
 *   $2007 の読み出しバッファ、パレット RAM のミラー、グレースケール、左 8 ドットのクリップ。
 * パターン表の読み出しと NT/属性の読み出しはマッパーの ppuA12(addr, time) にも流す(MMC3 の IRQ カウンタ。NT 読みは A12 が低い印)。
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
      this.frameIdx = new Uint8Array(256 * 240); // 同じ画面のパレット番号(6bit)。巻き戻しの映像の輪(nesRewind.js)が 8bit で控える
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
    // レンダリングの NT/属性読み(A12 が低い読みとしてマッパーへ。MMC3 は「低い読みが続いた後の高い読み」で数える)
    fetchNt(addr) {
      this.mapper.ppuA12(addr, this.time);
      return this.mapper.ppuRead(addr);
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
          this.mapper.ppuA12(this.v & 0x3FFF, this.time); // CPU 側の VRAM アクセスも A12 を動かす(MMC3 の IRQ カウンタ。Mesen と同じく増やした後の番地)
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
          else { this.t = (this.t & 0x7F00) | v; this.v = this.t; this.w = 0; this.mapper.ppuA12(this.v & 0x3FFF, this.time); } // 2 回目の書きで v が出る(A12 をマッパーへ)
          break;
        case 7:
          this.vramWrite(this.v, v);
          this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
          this.mapper.ppuA12(this.v & 0x3FFF, this.time);
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
      this.frameIdx[line * 256 + x] = idx & 0x3F;
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
              case 1: this.ntByte = this.fetchNt(0x2000 | (this.v & 0x0FFF)); break;
              case 3: {
                const at = this.fetchNt(0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07));
                const shift = ((this.v >> 4) & 4) | (this.v & 2);
                this.atByte = (at >> shift) & 3;
                break;
              }
              case 5: this.ptLo = this.fetchPattern(((this.ctrl & 0x10) << 8) | (this.ntByte << 4) | (this.v >> 12)); break;
              case 7: this.ptHi = this.fetchPattern(((this.ctrl & 0x10) << 8) | (this.ntByte << 4) | (this.v >> 12) | 8); break;
              case 0: this.incX(); if (dot === 256) this.incY(); break;
            }
          }
          if (dot === 257) { this.copyX(); this.evaluateSprites(visible ? line : -1); }
          if (dot >= 257 && dot <= 320) {
            this.oamAddr = 0;
            const k = (dot - 257) & 7;
            if (k === 1) this.fetchNt(0x2000 | (this.v & 0x0FFF)); // ゴミの NT 読み(実機どおり。MMC5 はこれもタイル列として数える)
            else if (k === 3) this.fetchNt(0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07)); // ゴミの属性読み
            else if (k === 5) this.fetchSpriteSlot((dot - 257) >> 3, 0);
            else if (k === 7) this.fetchSpriteSlot((dot - 257) >> 3, 1);
          }
          if (line === 261 && dot >= 280 && dot <= 304) this.copyY();
          if (dot === 337 || dot === 339) this.fetchNt(0x2000 | (this.v & 0x0FFF)); // ダミーの NT 読み
        } else if (visible && dot >= 1 && dot <= 256) {
          // 描画オフ: 背景色(v がパレットを指していればその色)
          const addr = this.v & 0x3FFF;
          let idx = (addr >= 0x3F00) ? this.palette[this.paletteIndex(addr)] : this.palette[0];
          if (this.mask & 1) idx &= 0x30;
          this.frame[line * 256 + dot - 1] = PALETTE[idx & 0x3F];
          this.frameIdx[line * 256 + dot - 1] = idx & 0x3F;
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
  PPU.PALETTE = PALETTE; // パレット番号 → RGBA(主スレッドが巻き戻しの 8bit 画面を描くのに使う)
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
    // アクセスランプ(ディスク系の媒体の共通形、MsxConsole と同じ): ドライブごとの [{ access, media }]。FDS は 1 台。ディスクでなければ null
    diskActivity() { const mp = this.mapper; return mp.sides ? [{ access: mp.diskAccess || 0, media: mp.diskNumber !== undefined && mp.diskNumber >= 0 }] : null; }
    // ディスクを読み書きしている最中か(FDS のモータが回っている。「速い読み込み」の自動早送りが見る)
    diskBusy() { const mp = this.mapper; return !!(mp.sides && mp.motorOn && mp.diskNumber >= 0); }
    get diskNumber() { return this.mapper.sides ? this.mapper.diskNumber : -1; }
    insertDisk(n) { if (this.mapper.insertDisk) this.mapper.insertDisk(n); }
    ejectDisk() { if (this.mapper.ejectDisk) this.mapper.ejectDisk(); }
    // NSF ヘッダと同じ拡張音源ビット(録音の NESX ヘッダ用)
    extBits() { return this.mapper.audio ? (this.mapper.extBits || 0) : 0; }
    // ── バッテリ バックアップ(セーブ)──
    // iNES でバッテリ ビットが立っていれば PRG RAM 全体、.fds ならディスク全面(ギャップつき)が保存の対象。
    // 書き込みがあると batteryDirty が立つ(主スレッド/ヘッドレスがそれを見て保存し、clearBatteryDirty() で下ろす)
    get hasBattery() { return !!(this.rom.battery || this.rom.fds || this.mapper.getBatteryData); } // getBatteryData: EEPROM など基板が持つセーブ
    get batteryDirty() { return this._batDirty || !!this.mapper.diskDirty; }
    clearBatteryDirty() { this._batDirty = false; this.mapper.diskDirty = false; }
    getBattery() {
      if (!this.hasBattery) return null;
      if (this.rom.fds) { const sides = this.mapper.sides, out = new Uint8Array(sides.length * sides[0].length); sides.forEach((s, i) => out.set(s, i * s.length)); return out; }
      if (this.mapper.getBatteryData) return this.mapper.getBatteryData();
      return this.mapper.prgRam.slice();
    }
    setBattery(bytes) {
      if (!this.hasBattery || !bytes) return false;
      bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (this.rom.fds) {
        const sides = this.mapper.sides;
        if (bytes.length !== sides.length * sides[0].length) return false;
        sides.forEach((s, i) => s.set(bytes.subarray(i * s.length, (i + 1) * s.length)));
      } else if (this.mapper.setBatteryData) {
        if (!this.mapper.setBatteryData(bytes)) return false;
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
      this.mapper.cpuWrite(addr, v, this.cpu.rmwDummy); // 第 3 引数: RMW 命令のダミー書き(MMC1 が次の書きを無視する印)
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
      if (!cpu.irqPolledInhibited() && (apu.frameIrqFlag || apu.dmc.irqFlag || mapper.irqPending())) {
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

  const SKIP_KEYS = new Set(['rom', 'rec', 'ring', 'frame', 'frameIdx', 'onFrame', 'onWrite', 'bus']);
  const REF = '__ref';

  function isTyped(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); }

  function snapshot(root, skipArrays, skipKeys) {
    skipKeys = skipKeys || SKIP_KEYS;
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
        if (skipKeys.has(k)) continue;
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
  // 木の写し/書き戻しは MSX 本体(msx/msxState.js)も使う。skipKeys を渡すと除外するキーを差し替えられる
  Emu.StateTree = { snapshot, restore, SKIP_KEYS, isTyped };
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
 *
 * 逆再生(押している間の滑らかな巻き戻し、段階 6h): 表示した画面をパレット番号 8bit(ppu.frameIdx、61KB/枚)で RING 枚
 * (10 秒)の輪に控えておき、beginReverse() の後は reverseStep() で 1 枚ずつ古い画面を返す(本体は止めたまま。音は無し)。
 * 輪より前へ戻るときは、その手前のスナップショットを読んで記録したパッドで進め直しながら輪を埋める(regenStep。
 * 1 回 1 フレームなので AudioWorklet の process() の予算に収まり、再生成 344 枚/秒 > 表示 60×速さ で追いつく)。
 * endReverse() で表示していたフレームへ本当に戻る(rewindTo と同じ: スナップショット読込+再生)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INTERVAL = 30;   // スナップショットの間隔(フレーム)。0.5 秒
  const KEEP = 240;      // 控える個数。2 分
  const RING = 600;      // 映像の輪の枚数(10 秒。61KB × 600 = 37MB)
  const FRAME_BYTES = 256 * 240;

  class NesRewind {
    // opt: { State, frameBytes }(GB の GbRewind が差し替える。既定は NES)
    constructor(nes, opt) {
      this.nes = nes;
      this.State = (opt && opt.State) || Emu.NesState;
      this.frameBytes = (opt && opt.frameBytes) || FRAME_BYTES;
      this.snaps = [];          // [{ frame, state }] frame = そのフレームが終わった時点の frameCount
      this.pads = [];           // pads[frameCount] = pad0 | pad1 << 8(そのフレーム終わりの値。フレーム番号は frameCount)
      this.base = 0;            // pads の先頭が指す frameCount(古い分は捨てる)
      this.replaying = false;
      this.ring = null;         // 映像の輪(Uint8Array RING×FRAME_BYTES。最初の capture で確保)
      this.ringFrame = new Int32Array(RING).fill(-1); // 各枠に入っているフレーム番号
      this.rv = null;           // 逆再生中 { cur: 表示しているフレーム, regen: {next, upto} | null, moved, wasRec }
    }
    clear() { this.snaps.length = 0; this.pads.length = 0; this.base = this.nes.frameCount; this.ringFrame.fill(-1); }
    // 今の画面(ppu.frameIdx)を輪に控える
    _capture(f) {
      const FB = this.frameBytes;
      if (!this.ring) this.ring = new Uint8Array(RING * FB);
      const slot = f % RING;
      this.ring.set(this.nes.ppu.frameIdx, slot * FB);
      this.ringFrame[slot] = f;
    }
    // 輪にあるフレーム f の画面(無ければ null)
    frameAt(f) {
      const slot = f % RING;
      return this.ring && this.ringFrame[slot] === f ? this.ring.subarray(slot * this.frameBytes, (slot + 1) * this.frameBytes) : null;
    }
    // 逆再生を始める(本体は止めたまま呼び手が reverseStep/regenStep を回す)。戻れる履歴が無ければ false
    beginReverse() {
      if (this.rv || !this.snaps.length) return false;
      const nes = this.nes;
      this.rv = { cur: nes.frameCount, regen: null, moved: false, wasRec: !!nes.rec };
      nes.rec = null;
      return this.rv;
    }
    // 1 枚戻る。戻れたら 8bit の画面(輪の中の subarray。すぐ写すこと)、まだ作っていなければ null(待つ)、これ以上戻れなければ false
    reverseStep() {
      const rv = this.rv;
      if (!rv) return false;
      const target = rv.cur - 1;
      if (target <= this.oldest) return false; // 一番古いスナップショットの画面は無い(そのフレームの終わりの状態しか無い)
      const img = this.frameAt(target);
      if (img) { rv.cur = target; rv.moved = true; return img; }
      if (!rv.regen) {
        let si = -1;
        for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame < target) { si = i; break; }
        if (si < 0) return false;
        this.State.load(this.nes, this.snaps[si].state);
        rv.regen = { next: this.snaps[si].frame + 1, upto: target };
        this.replaying = true;
      }
      return null;
    }
    // 再生成を n フレームぶん進める(逆再生中、毎 process/毎 rAF に呼ぶ)
    regenStep(n) {
      const rv = this.rv;
      if (!rv || !rv.regen) return;
      const nes = this.nes, g = rv.regen;
      for (let k = 0; k < n && g.next <= g.upto; k++) {
        const p = this.pads[g.next - this.base];
        if (p !== undefined) { nes.pad[0] = p & 0xFF; nes.pad[1] = (p >> 8) & 0xFF; }
        nes.runFrame();
        this._capture(nes.frameCount);
        g.next = nes.frameCount + 1;
      }
      if (g.next > g.upto) { rv.regen = null; this.replaying = false; }
    }
    // 逆再生を終え、表示していたフレームへ本当に戻る。戻った frameCount を返す
    endReverse() {
      const rv = this.rv;
      if (!rv) return this.nes.frameCount;
      const nes = this.nes;
      this.rv = null; this.replaying = false;
      const recNow = !!nes.rec; nes.rec = null;
      let got = nes.frameCount;
      if (rv.moved || rv.regen) got = this.rewindTo(rv.cur, true);
      if (rv.wasRec || recNow) nes.startRecording();
      return got;
    }
    // 戻れる一番古いフレーム(無ければ今のフレーム)
    get oldest() { return this.snaps.length ? this.snaps[0].frame : this.nes.frameCount; }
    // 毎フレーム(_frameEnd の後)に呼ぶ
    onFrame() {
      if (this.replaying) return;
      const nes = this.nes, f = nes.frameCount;
      if (this.base > f) this.clear();
      this.pads[f - this.base] = (nes.pad[0] & 0xFF) | ((nes.pad[1] & 0xFF) << 8);
      this._capture(f);
      if (f % INTERVAL === 0) {
        this.snaps.push({ frame: f, state: this.State.save(nes) });
        if (this.snaps.length > KEEP) {
          const drop = this.snaps.shift();
          // 捨てたスナップショットより前のパッド記録も要らない
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.pads.splice(0, keepFrom - this.base); this.base = keepFrom; }
          void drop;
        }
      }
    }
    // frame(frameCount)の終わりの状態へ戻す。戻れた frameCount を返す(目標が古すぎれば一番古い所、未来なら今のまま)。
    // force は本体が再生成で別のフレームにいる時(endReverse)用: 今の frameCount に関係なくスナップショットから作り直す
    rewindTo(frame, force) {
      const nes = this.nes;
      if (!this.snaps.length || (frame >= nes.frameCount && !force)) return nes.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const snap = this.snaps[si];
      // 今押している物は状態を読む「前」に控える(読んだ後に取ると、巻き戻した先で押していた物が残って押しっぱなしになった。2026-11-11)
      const held = [nes.padHeld[0], nes.padHeld[1]], turbo = [nes.padTurbo[0], nes.padTurbo[1]];
      this.State.load(nes, snap.state);
      // 控えていたパッドの値で進める(setController を通さず pad を直接。連射の位相も記録に含まれている)
      this.replaying = true;
      try {
        while (nes.frameCount < frame) {
          const p = this.pads[nes.frameCount + 1 - this.base];
          if (p !== undefined) { nes.pad[0] = p & 0xFF; nes.pad[1] = (p >> 8) & 0xFF; }
          nes.runFrame();
          this._capture(nes.frameCount); // 進め直した画面も輪へ(戻った直後の巻き戻しに使える)
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
  NesRewind.RING = RING;
  Emu.NesRewind = NesRewind;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * Z80 CPUコア (MSX/KSS用)
 * MML.Emu.CPUZ80
 *
 * - メインオペコード全種 + CB/ED/DD/FD プレフィックス + DD CB/FD CB(IX/IY間接ビット演算)に対応
 * - 未定義フラグ(X/Y, ビット3/5)も一般的な近似式で実装
 * - bus.read(addr)/bus.write(addr,value)/bus.ioRead(port)/bus.ioWrite(port,value) を介してアクセス
 * - call(addr)/beginCall(addr)/stepCall() で「addrをCALLしてRETで戻るまで実行」するヘルパーを提供
 *   (cpu6502.js の call/beginCall/stepCall と同じ設計、KSSのINIT/PLAY呼び出しに使用)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const F_C = 0x01;
  const F_N = 0x02;
  const F_PV = 0x04;
  const F_X = 0x08; // 未定義(ビット3のコピー)
  const F_H = 0x10;
  const F_Y = 0x20; // 未定義(ビット5のコピー)
  const F_Z = 0x40;
  const F_S = 0x80;

  // CALL終了検知用の番兵リターンアドレス。RETでこのアドレスに戻ったら終了とみなす。
  // 番兵そのものをスタックへ積む(番兵-1を積んで1バイト実行させる方式にすると、
  // push16がその着地アドレスへ 0xFF を書き込んでしまい、RET後に RST 38h として
  // 暴走実行される。SP初期値0xFFFFのときに実際に踏む。)
  const CALL_SENTINEL = 0xFFFF;

  // パリティテーブル(偶数個の1ビットならtrue)
  const PARITY = new Array(256);
  for (let i = 0; i < 256; i++) {
    let bits = 0, v = i;
    while (v) { bits += v & 1; v >>= 1; }
    PARITY[i] = (bits % 2) === 0;
  }

  function setXY(cpu, value) {
    cpu.f = (cpu.f & ~(F_X | F_Y)) | (value & F_X) | (value & F_Y);
  }

  class CPUZ80 {
    /**
     * @param {{read:(addr:number)=>number, write:(addr:number,value:number)=>void,
     *           ioRead:(port:number)=>number, ioWrite:(port:number,value:number)=>void}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.traps = null; // {addr: (cpu)=>cycles} BIOSコールトラップ。resetでは消さない
      // M1(命令フェッチ)1回ごとに足すウェイト数。素の Z80 は 0、MSX は 1(kssPlayer.js が設定)。
      // M1 の回数は R レジスタの増分と同じ(プレフィックス DD/FD/CB/ED もそれぞれ 1 回、
      // DD CB d op の d と op は M1 ではない)。resetでは消さない
      this.m1Wait = 0;
      // INT 受け付けの線(MSX 本体が VDP 等の線を毎命令セットする)。interrupt() は呼び手(msxConsole.js)が
      // iff1 && !eiPending を見て呼ぶ。eiPending は EI の直後 1 命令だけ受け付けない Z80 の規則
      this.eiPending = false;
      // R800(MSX turboR、段階 7e): true のとき MULUB/MULUW(ED C1/C9/D1/D9、ED C3/F3)が動き、step() の時間が r800Scale 倍になる。
      // R800 の命令時間は 1 命令 1〜2 クロック(7.16MHz)+メモリ待ちで Z80 とは表が全く違う。ここでは Z80 の T 数に定数を掛ける近似
      // (DRAM モード 0.2、ROM モード 0.35: 「Z80 の 4〜6 倍/ROM では 2.5〜3 倍」という通説からの推定値。msxConsole.js の S1990 が設定する)。
      // 本体の時間は Z80 クロック(3.58MHz)のままなので、値は「Z80 クロックで数えた所要時間」
      this.r800 = false; this.r800Scale = 0.2;
      this.reset();
    }

    reset() {
      this.a = 0; this.f = 0;
      this.b = 0; this.c = 0;
      this.d = 0; this.e = 0;
      this.h = 0; this.l = 0;
      this.a2 = 0; this.f2 = 0;
      this.b2 = 0; this.c2 = 0;
      this.d2 = 0; this.e2 = 0;
      this.h2 = 0; this.l2 = 0;
      this.ixh = 0; this.ixl = 0;
      this.iyh = 0; this.iyl = 0;
      this.sp = 0xFFFF;
      this.pc = 0;
      this.i = 0; this.r = 0;
      this.iff1 = false; this.iff2 = false; this.im = 0;
      this.halted = false;
      this.eiPending = false;
      this.callActive = false;
      this._eaddr = 0; // 直近に計算した実効アドレス((HL)/(IX+d)/(IY+d))
    }

    // --- メモリ/IOアクセス ---
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }
    ioRead(port) { return this.bus.ioRead(port & 0xFF) & 0xFF; }
    ioWrite(port, value) { this.bus.ioWrite(port & 0xFF, value & 0xFF); }

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

    // --- フラグ ---
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
    setAF(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }
    getIX() { return (this.ixh << 8) | this.ixl; }
    setIX(v) { this.ixh = (v >> 8) & 0xFF; this.ixl = v & 0xFF; }
    getIY() { return (this.iyh << 8) | this.iyl; }
    setIY(v) { this.iyh = (v >> 8) & 0xFF; this.iyl = v & 0xFF; }

    getIdxPair(idx) { return idx === 'ix' ? this.getIX() : idx === 'iy' ? this.getIY() : this.getHL(); }
    setIdxPair(idx, v) { if (idx === 'ix') this.setIX(v); else if (idx === 'iy') this.setIY(v); else this.setHL(v); }

    // rp テーブル(LD rp,nn / INC rp / DEC rp / ADD HL,rp用): 0=BC,1=DE,2=HL(idx時はIX/IY),3=SP
    getRP(p, idx) {
      switch (p) {
        case 0: return this.getBC();
        case 1: return this.getDE();
        case 2: return this.getIdxPair(idx);
        case 3: return this.sp;
      }
    }
    setRP(p, v, idx) {
      switch (p) {
        case 0: this.setBC(v); break;
        case 1: this.setDE(v); break;
        case 2: this.setIdxPair(idx, v); break;
        case 3: this.sp = v & 0xFFFF; break;
      }
    }
    // rp2 テーブル(PUSH/POP用): 0=BC,1=DE,2=HL(idx時はIX/IY),3=AF
    getRP2(p, idx) {
      switch (p) {
        case 0: return this.getBC();
        case 1: return this.getDE();
        case 2: return this.getIdxPair(idx);
        case 3: return this.getAF();
      }
    }
    setRP2(p, v, idx) {
      switch (p) {
        case 0: this.setBC(v); break;
        case 1: this.setDE(v); break;
        case 2: this.setIdxPair(idx, v); break;
        case 3: this.setAF(v); break;
      }
    }

    // 8bitレジスタコード(0=B,1=C,2=D,3=E,4=H,5=L,6=(HL)相当,7=A)。
    // code===6 のときは this._eaddr を実効アドレスとして使う(呼び出し側が事前に計算)。
    // idx が指定され、かつ redirectHL=true のとき 4=>IXH/IYH, 5=>IXL/IYL にリダイレクトする
    // (同一命令中で(HL)がIX+d化されている場合は redirectHL=false にすること)
    getR8(code, idx, redirectHL) {
      switch (code) {
        case 0: return this.b;
        case 1: return this.c;
        case 2: return this.d;
        case 3: return this.e;
        case 4: return (idx && redirectHL) ? (idx === 'ix' ? this.ixh : this.iyh) : this.h;
        case 5: return (idx && redirectHL) ? (idx === 'ix' ? this.ixl : this.iyl) : this.l;
        case 6: return this.read(this._eaddr);
        case 7: return this.a;
      }
    }
    setR8(code, value, idx, redirectHL) {
      value &= 0xFF;
      switch (code) {
        case 0: this.b = value; break;
        case 1: this.c = value; break;
        case 2: this.d = value; break;
        case 3: this.e = value; break;
        case 4: if (idx && redirectHL) { if (idx === 'ix') this.ixh = value; else this.iyh = value; } else this.h = value; break;
        case 5: if (idx && redirectHL) { if (idx === 'ix') this.ixl = value; else this.iyl = value; } else this.l = value; break;
        case 6: this.write(this._eaddr, value); break;
        case 7: this.a = value; break;
      }
    }

    condTest(y) {
      switch (y) {
        case 0: return !this.getFlag(F_Z);
        case 1: return this.getFlag(F_Z);
        case 2: return !this.getFlag(F_C);
        case 3: return this.getFlag(F_C);
        case 4: return !this.getFlag(F_PV);
        case 5: return this.getFlag(F_PV);
        case 6: return !this.getFlag(F_S);
        case 7: return this.getFlag(F_S);
      }
    }

    // --- 8bit ALU ---
    add8(value, carryIn) {
      const a = this.a;
      const sum = a + value + carryIn;
      const result = sum & 0xFF;
      this.setFlag(F_H, ((a & 0xF) + (value & 0xF) + carryIn) > 0xF);
      this.setFlag(F_C, sum > 0xFF);
      this.setFlag(F_PV, (((a ^ value) & 0x80) === 0) && (((a ^ result) & 0x80) !== 0));
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      this.setFlag(F_S, (result & 0x80) !== 0);
      setXY(this, result);
      this.a = result;
    }
    sub8(value, carryIn, storeResult) {
      const a = this.a;
      const diff = a - value - carryIn;
      const result = diff & 0xFF;
      this.setFlag(F_H, ((a & 0xF) - (value & 0xF) - carryIn) < 0);
      this.setFlag(F_C, diff < 0);
      this.setFlag(F_PV, (((a ^ value) & 0x80) !== 0) && (((a ^ result) & 0x80) !== 0));
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0);
      this.setFlag(F_S, (result & 0x80) !== 0);
      if (storeResult) { setXY(this, result); this.a = result; }
      else { setXY(this, value); } // CP: 未定義フラグは被減数(オペランド)由来
    }
    and8(value) {
      this.a &= value;
      this.setFlag(F_H, true); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_PV, PARITY[this.a]);
      this.setFlag(F_Z, this.a === 0); this.setFlag(F_S, (this.a & 0x80) !== 0);
      setXY(this, this.a);
    }
    or8(value) {
      this.a |= value;
      this.setFlag(F_H, false); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_PV, PARITY[this.a]);
      this.setFlag(F_Z, this.a === 0); this.setFlag(F_S, (this.a & 0x80) !== 0);
      setXY(this, this.a);
    }
    xor8(value) {
      this.a ^= value;
      this.setFlag(F_H, false); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_PV, PARITY[this.a]);
      this.setFlag(F_Z, this.a === 0); this.setFlag(F_S, (this.a & 0x80) !== 0);
      setXY(this, this.a);
    }
    inc8(v) {
      const result = (v + 1) & 0xFF;
      this.setFlag(F_H, (v & 0xF) === 0xF);
      this.setFlag(F_PV, v === 0x7F);
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0); this.setFlag(F_S, (result & 0x80) !== 0);
      setXY(this, result);
      return result;
    }
    dec8(v) {
      const result = (v - 1) & 0xFF;
      this.setFlag(F_H, (v & 0xF) === 0x0);
      this.setFlag(F_PV, v === 0x80);
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0); this.setFlag(F_S, (result & 0x80) !== 0);
      setXY(this, result);
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

    // --- 16bit ALU ---
    addHL(idx, rpVal) {
      const hl = this.getIdxPair(idx);
      const sum = hl + rpVal;
      const result = sum & 0xFFFF;
      this.setFlag(F_H, ((hl & 0xFFF) + (rpVal & 0xFFF)) > 0xFFF);
      this.setFlag(F_C, sum > 0xFFFF);
      this.setFlag(F_N, false);
      this.f = (this.f & ~(F_X | F_Y)) | ((result >> 8) & (F_X | F_Y));
      this.setIdxPair(idx, result);
    }
    adcHL(rpVal) {
      const hl = this.getHL();
      const carry = this.getFlag(F_C) ? 1 : 0;
      const sum = hl + rpVal + carry;
      const result = sum & 0xFFFF;
      this.setFlag(F_H, ((hl & 0xFFF) + (rpVal & 0xFFF) + carry) > 0xFFF);
      this.setFlag(F_C, sum > 0xFFFF);
      this.setFlag(F_PV, (((hl ^ rpVal) & 0x8000) === 0) && (((hl ^ result) & 0x8000) !== 0));
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      this.setFlag(F_S, (result & 0x8000) !== 0);
      this.f = (this.f & ~(F_X | F_Y)) | ((result >> 8) & (F_X | F_Y));
      this.setHL(result);
    }
    sbcHL(rpVal) {
      const hl = this.getHL();
      const carry = this.getFlag(F_C) ? 1 : 0;
      const diff = hl - rpVal - carry;
      const result = diff & 0xFFFF;
      this.setFlag(F_H, ((hl & 0xFFF) - (rpVal & 0xFFF) - carry) < 0);
      this.setFlag(F_C, diff < 0);
      this.setFlag(F_PV, (((hl ^ rpVal) & 0x8000) !== 0) && (((hl ^ result) & 0x8000) !== 0));
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0);
      this.setFlag(F_S, (result & 0x8000) !== 0);
      this.f = (this.f & ~(F_X | F_Y)) | ((result >> 8) & (F_X | F_Y));
      this.setHL(result);
    }

    // --- 回転/シフト(CBテーブル用、汎用) ---
    rotOp(y, v) {
      let carry, result;
      switch (y) {
        case 0: carry = (v >> 7) & 1; result = ((v << 1) | carry) & 0xFF; break; // RLC
        case 1: carry = v & 1; result = ((v >> 1) | (carry << 7)) & 0xFF; break; // RRC
        case 2: carry = (v >> 7) & 1; result = ((v << 1) | (this.getFlag(F_C) ? 1 : 0)) & 0xFF; break; // RL
        case 3: carry = v & 1; result = ((v >> 1) | (this.getFlag(F_C) ? 0x80 : 0)) & 0xFF; break; // RR
        case 4: carry = (v >> 7) & 1; result = (v << 1) & 0xFF; break; // SLA
        case 5: carry = v & 1; result = ((v >> 1) | (v & 0x80)) & 0xFF; break; // SRA
        case 6: carry = (v >> 7) & 1; result = ((v << 1) | 1) & 0xFF; break; // SLL(undoc)
        case 7: carry = v & 1; result = (v >> 1) & 0xFF; break; // SRL
      }
      this.setFlag(F_C, carry !== 0);
      this.setFlag(F_H, false); this.setFlag(F_N, false);
      this.setFlag(F_PV, PARITY[result]);
      this.setFlag(F_Z, result === 0); this.setFlag(F_S, (result & 0x80) !== 0);
      setXY(this, result);
      return result;
    }

    daa() {
      const a = this.a;
      const n = this.getFlag(F_N);
      const cf = this.getFlag(F_C);
      const hf = this.getFlag(F_H);
      let corr = 0;
      let newC = cf;
      if (hf || (a & 0x0F) > 9) corr |= 0x06;
      if (cf || a > 0x99) { corr |= 0x60; newC = true; }
      const result = n ? (a - corr) & 0xFF : (a + corr) & 0xFF;
      const newH = n ? (hf && (a & 0x0F) < 6) : (((a & 0x0F) + (corr & 0x0F)) > 0x0F);
      this.a = result;
      this.setFlag(F_C, newC);
      this.setFlag(F_H, newH);
      this.setFlag(F_PV, PARITY[result]);
      this.setFlag(F_Z, result === 0); this.setFlag(F_S, (result & 0x80) !== 0);
      setXY(this, result);
    }

    // --- メイン実行ループ ---
    step() {
      const c = this._stepZ80();
      return this.r800 ? Math.max(1, Math.ceil(c * this.r800Scale)) : c;
    }
    _stepZ80() {
      // BIOSトラップ: 実ROMを積んでいないため、既知のBIOSエントリアドレスにPCが
      // 来たら実CPU命令の代わりに登録済みJS関数を実行しRETをシミュレートする
      // (呼び出し元が汎用ドライバでMSX BIOSコールを使う場合に必須。kssPlayer.js参照)。
      if (this.traps) {
        const trap = this.traps[this.pc];
        if (trap) return trap(this);
      }
      this.eiPending = false;
      // HALT 中は割り込みが来るまで NOP を実行し続ける(PC は HALT の次を指したまま)。KSS の call()/stepCall() は
      // ここへ来る前に halted を見て抜けるので従来の挙動は変わらない
      if (this.halted) { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F); return 4 + this.m1Wait; }
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      let idx = null;
      let prefixBytes = 0;
      let opcode = this.fetchByte();
      while (opcode === 0xDD || opcode === 0xFD) {
        idx = opcode === 0xDD ? 'ix' : 'iy';
        prefixBytes++;
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        opcode = this.fetchByte();
      }
      // DD/FDプレフィックスは(たとえ後続命令がHL/IXを使わなくても)それ自体が
      // 常に+4サイクルのM1フェッチになる。displacementを伴う(HL)->(IX+d)化された
      // 命令だけは execMain/execCB 側で「この+4を除いた残りコスト」を返す設計にしている。
      const extraPrefixCycles = prefixBytes * 4;
      const m1 = this.m1Wait;

      if (opcode === 0xCB) {
        // 通常のCB xxは2バイトともM1フェッチでRが+2される。DD/FD CB d xxは
        // DD/FD+CBの時点で既に+2済みで、変位byteと最終opcodeバイトはRを増やさない。
        if (!idx) this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        return extraPrefixCycles + this.execCB(idx) + (m1 ? m1 * (prefixBytes + (idx ? 1 : 2)) : 0);
      }
      if (opcode === 0xED) {
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        return extraPrefixCycles + this.execED() + (m1 ? m1 * (prefixBytes + 2) : 0);
      }
      return extraPrefixCycles + this.execMain(opcode, idx) + (m1 ? m1 * (prefixBytes + 1) : 0);
    }

    /**
     * マスカブル割り込み(INT)を受け付ける。呼び手が「iff1 && !eiPending && 線が立っている」を確認してから呼ぶ。
     * IM0 はデータバスに RST 38H(0xFF)が乗る前提(MSX は IM1 が普通。IM0 の機種は無い)、IM1 は RST 38H、
     * IM2 は I レジスタ上位+バスの 0xFF をベクタ表の番地にする(実機のデータバスはプルアップで 0xFF)。
     * @returns {number} 消費サイクル(IM0/1: 13、IM2: 19。M1 ウェイト込み)
     */
    interrupt() {
      this.halted = false;
      this.iff1 = false; this.iff2 = false;
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      this.push16(this.pc);
      if (this.im === 2) {
        const vec = (this.i << 8) | 0xFF;
        this.pc = this.read(vec) | (this.read((vec + 1) & 0xFFFF) << 8);
        return 19 + this.m1Wait;
      }
      this.pc = 0x0038;
      return 13 + this.m1Wait;
    }

    // 実効アドレスを計算して this._eaddr にセットする(code===6のとき使用)。
    // idxがあれば変位バイトをフェッチする。戻り値: 追加消費サイクル(変位読み込み分)
    calcEaddr(idx) {
      if (idx) {
        const d = this.fetchSigned();
        this._eaddr = (this.getIdxPair(idx) + d) & 0xFFFF;
        return 0;
      }
      this._eaddr = this.getHL();
      return 0;
    }

    execMain(opcode, idx) {
      const x = (opcode >> 6) & 3;
      const y = (opcode >> 3) & 7;
      const z = opcode & 7;
      const p = y >> 1;
      const q = y & 1;

      if (x === 0) {
        if (z === 0) {
          if (y === 0) return 4; // NOP
          if (y === 1) { // EX AF,AF'
            const af = this.getAF();
            const af2 = (this.a2 << 8) | this.f2;
            this.setAF(af2);
            this.a2 = (af >> 8) & 0xFF;
            this.f2 = af & 0xFF;
            return 4;
          }
          if (y === 2) { // DJNZ d
            const d = this.fetchSigned();
            this.b = (this.b - 1) & 0xFF;
            if (this.b !== 0) { this.pc = (this.pc + d) & 0xFFFF; return 13; }
            return 8;
          }
          if (y === 3) { const d = this.fetchSigned(); this.pc = (this.pc + d) & 0xFFFF; return 12; }
          // y=4..7: JR cc,d
          {
            const d = this.fetchSigned();
            if (this.condTest(y - 4)) { this.pc = (this.pc + d) & 0xFFFF; return 12; }
            return 7;
          }
        }
        if (z === 1) {
          if (q === 0) { const nn = this.fetch16(); this.setRP(p, nn, idx); return 10; }
          else { this.addHL(idx, this.getRP(p, idx)); return 11; }
        }
        if (z === 2) {
          if (q === 0) {
            if (p === 0) { this.write(this.getBC(), this.a); return 7; }
            if (p === 1) { this.write(this.getDE(), this.a); return 7; }
            if (p === 2) { const nn = this.fetch16(); this.write(nn, this.getIdxPair(idx) & 0xFF); this.write((nn + 1) & 0xFFFF, (this.getIdxPair(idx) >> 8) & 0xFF); return 16; }
            { const nn = this.fetch16(); this.write(nn, this.a); return 13; }
          } else {
            if (p === 0) { this.a = this.read(this.getBC()); return 7; }
            if (p === 1) { this.a = this.read(this.getDE()); return 7; }
            if (p === 2) { const nn = this.fetch16(); const v = this.read(nn) | (this.read((nn + 1) & 0xFFFF) << 8); this.setIdxPair(idx, v); return 16; }
            { const nn = this.fetch16(); this.a = this.read(nn); return 13; }
          }
        }
        if (z === 3) {
          const v = this.getRP(p, idx);
          this.setRP(p, (v + (q === 0 ? 1 : -1)) & 0xFFFF, idx);
          return 6;
        }
        if (z === 4 || z === 5) {
          const isInc = z === 4;
          const hasMem = y === 6;
          let cyc = 4;
          if (hasMem) {
            this.calcEaddr(idx);
            const v = this.read(this._eaddr);
            const result = isInc ? this.inc8(v) : this.dec8(v);
            this.write(this._eaddr, result);
            cyc = idx ? 19 : 11;
          } else {
            const v = this.getR8(y, idx, true);
            const result = isInc ? this.inc8(v) : this.dec8(v);
            this.setR8(y, result, idx, true);
            cyc = 4;
          }
          return cyc;
        }
        if (z === 6) {
          const hasMem = y === 6;
          if (hasMem) {
            this.calcEaddr(idx);
            const n = this.fetchByte();
            this.write(this._eaddr, n);
            return idx ? 15 : 10;
          }
          const n = this.fetchByte();
          this.setR8(y, n, idx, true);
          return 7;
        }
        // z===7
        switch (y) {
          case 0: { const c = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); setXY(this, this.a); return 4; }
          case 1: { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); setXY(this, this.a); return 4; }
          case 2: { const c = (this.a >> 7) & 1; const oldC = this.getFlag(F_C) ? 1 : 0; this.a = ((this.a << 1) | oldC) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); setXY(this, this.a); return 4; }
          case 3: { const c = this.a & 1; const oldC = this.getFlag(F_C) ? 0x80 : 0; this.a = ((this.a >> 1) | oldC) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); setXY(this, this.a); return 4; }
          case 4: this.daa(); return 4;
          case 5: this.a = (~this.a) & 0xFF; this.setFlag(F_H, true); this.setFlag(F_N, true); setXY(this, this.a); return 4;
          case 6: this.setFlag(F_C, true); this.setFlag(F_H, false); this.setFlag(F_N, false); setXY(this, this.a); return 4;
          case 7: { const oldC = this.getFlag(F_C); this.setFlag(F_H, oldC); this.setFlag(F_C, !oldC); this.setFlag(F_N, false); setXY(this, this.a); return 4; }
        }
      }

      if (x === 1) {
        if (y === 6 && z === 6) { this.halted = true; return 4; } // HALT
        const hasMem = (y === 6 || z === 6);
        if (hasMem) this.calcEaddr(idx);
        const v = this.getR8(z, idx, !hasMem);
        this.setR8(y, v, idx, !hasMem);
        if (z === 6 || y === 6) return idx ? 15 : 7;
        return 4;
      }

      if (x === 2) {
        const hasMem = z === 6;
        if (hasMem) this.calcEaddr(idx);
        const v = this.getR8(z, idx, !hasMem);
        this.aluOp(y, v);
        return hasMem ? (idx ? 15 : 7) : 4;
      }

      // x === 3
      if (z === 0) { if (this.condTest(y)) { this.pc = this.pop16(); return 11; } return 5; }
      if (z === 1) {
        if (q === 0) { this.setRP2(p, this.pop16(), idx); return 10; }
        if (p === 0) { this.pc = this.pop16(); return 10; }
        if (p === 1) { // EXX
          let t = this.b; this.b = this.b2; this.b2 = t;
          t = this.c; this.c = this.c2; this.c2 = t;
          t = this.d; this.d = this.d2; this.d2 = t;
          t = this.e; this.e = this.e2; this.e2 = t;
          t = this.h; this.h = this.h2; this.h2 = t;
          t = this.l; this.l = this.l2; this.l2 = t;
          return 4;
        }
        if (p === 2) { this.pc = this.getIdxPair(idx); return 4; }
        { this.sp = this.getIdxPair(idx); return 6; }
      }
      if (z === 2) { const nn = this.fetch16(); if (this.condTest(y)) this.pc = nn; return 10; }
      if (z === 3) {
        switch (y) {
          case 0: this.pc = this.fetch16(); return 10;
          case 1: return 0; // CB(呼び出し元でハンドル済み、ここには来ない)
          case 2: { const n = this.fetchByte(); this.ioWrite(n, this.a); return 11; }
          case 3: { const n = this.fetchByte(); this.a = this.ioRead(n); return 11; }
          case 4: { // EX (SP),HL/IX/IY
            const v = this.getIdxPair(idx);
            const memLo = this.read(this.sp);
            const memHi = this.read((this.sp + 1) & 0xFFFF);
            this.write(this.sp, v & 0xFF);
            this.write((this.sp + 1) & 0xFFFF, (v >> 8) & 0xFF);
            this.setIdxPair(idx, memLo | (memHi << 8));
            return 19;
          }
          case 5: { const de = this.getDE(); this.setDE(this.getHL()); this.setHL(de); return 4; }
          case 6: this.iff1 = false; this.iff2 = false; return 4;
          case 7: this.iff1 = true; this.iff2 = true; this.eiPending = true; return 4;
        }
      }
      if (z === 4) { const nn = this.fetch16(); if (this.condTest(y)) { this.push16((this.pc) & 0xFFFF); this.pc = nn; return 17; } return 10; }
      if (z === 5) {
        if (q === 0) { this.push16(this.getRP2(p, idx)); return 11; }
        if (p === 0) { const nn = this.fetch16(); this.push16(this.pc); this.pc = nn; return 17; }
        return 0; // p=1,2,3: DD/ED/FD prefix、呼び出し元でハンドル済み
      }
      if (z === 6) { const n = this.fetchByte(); this.aluOp(y, n); return 7; }
      if (z === 7) { this.push16(this.pc); this.pc = y * 8; return 11; }
      return 4;
    }

    execCB(idx) {
      if (idx) {
        const d = this.fetchSigned();
        const addr = (this.getIdxPair(idx) + d) & 0xFFFF;
        const opcode = this.fetchByte();
        const x = (opcode >> 6) & 3;
        const y = (opcode >> 3) & 7;
        const z = opcode & 7;
        const v = this.read(addr);
        if (x === 1) { // BIT b,(idx+d)
          const bit = (v >> y) & 1;
          this.setFlag(F_Z, bit === 0);
          this.setFlag(F_PV, bit === 0);
          this.setFlag(F_H, true);
          this.setFlag(F_N, false);
          this.setFlag(F_S, y === 7 && bit !== 0);
          // 未定義フラグ: 実効アドレス上位バイトから(WZ/メモリポインタの近似)
          this.f = (this.f & ~(F_X | F_Y)) | (((addr >> 8) & (F_X | F_Y)));
          return 16; // 実際は20T。うちDD/FD分の4Tはstep()側で加算済み
        }
        let result;
        if (x === 0) result = this.rotOp(y, v);
        else if (x === 2) result = v & ~(1 << y);
        else result = v | (1 << y);
        this.write(addr, result);
        if (z !== 6) this.setR8(z, result, null, false); // 未定義: レジスタへもコピー(常に無印B..A)
        return 19; // 実際は23T。うちDD/FD分の4Tはstep()側で加算済み
      }
      const opcode = this.fetchByte();
      const x = (opcode >> 6) & 3;
      const y = (opcode >> 3) & 7;
      const z = opcode & 7;
      const hasMem = z === 6;
      if (hasMem) this._eaddr = this.getHL();
      const v = this.getR8(z, null, false);
      if (x === 1) { // BIT b,r
        const bit = (v >> y) & 1;
        this.setFlag(F_Z, bit === 0);
        this.setFlag(F_PV, bit === 0);
        this.setFlag(F_H, true);
        this.setFlag(F_N, false);
        this.setFlag(F_S, y === 7 && bit !== 0);
        if (hasMem) {
          this.f = (this.f & ~(F_X | F_Y)) | (((this._eaddr >> 8) & (F_X | F_Y)));
        } else {
          setXY(this, v);
        }
        return hasMem ? 12 : 8;
      }
      let result;
      if (x === 0) result = this.rotOp(y, v);
      else if (x === 2) result = v & ~(1 << y);
      else result = v | (1 << y);
      this.setR8(z, result, null, false);
      return hasMem ? 15 : 8;
    }

    execED() {
      const opcode = this.fetchByte();
      const x = (opcode >> 6) & 3;
      const y = (opcode >> 3) & 7;
      const z = opcode & 7;
      const p = y >> 1;
      const q = y & 1;

      if (x === 3 && this.r800) {
        // R800 の乗算(Z80 では ED の未定義=NOP)。フラグ: Z=結果 0、C=上位(バイト/ワード)が非 0、S/PV=0、H/N は保存(openMSX の実装に合わせた)
        if (z === 1 && y < 4) { // MULUB A,r(r = B/C/D/E): HL = A × r
          const r = y === 0 ? this.b : y === 1 ? this.c : y === 2 ? this.d : this.e;
          const res = this.a * r;
          this.h = (res >> 8) & 0xFF; this.l = res & 0xFF;
          this.f = (this.f & (F_N | F_H)) | (res === 0 ? F_Z : 0) | (res > 0xFF ? F_C : 0);
          return 14;
        }
        if (z === 3 && (y === 0 || y === 6)) { // MULUW HL,rr(rr = BC/SP): DE:HL = HL × rr
          const rr = y === 0 ? ((this.b << 8) | this.c) : this.sp;
          const hl = (this.h << 8) | this.l;
          const res = hl * rr; // 32bit(2^32 未満なので倍精度で正確)
          const lo = res % 0x10000, hi = Math.floor(res / 0x10000);
          this.h = (lo >> 8) & 0xFF; this.l = lo & 0xFF; this.d = (hi >> 8) & 0xFF; this.e = hi & 0xFF;
          this.f = (this.f & (F_N | F_H)) | (res === 0 ? F_Z : 0) | (hi ? F_C : 0);
          return 36;
        }
      }

      if (x === 1) {
        if (z === 0) {
          const v = this.ioRead(this.c);
          if (y !== 6) this.setR8(y, v, null, false);
          this.setFlag(F_Z, v === 0); this.setFlag(F_S, (v & 0x80) !== 0);
          this.setFlag(F_H, false); this.setFlag(F_N, false);
          this.setFlag(F_PV, PARITY[v]);
          setXY(this, v);
          return 12;
        }
        if (z === 1) {
          const v = (y === 6) ? 0 : this.getR8(y, null, false);
          this.ioWrite(this.c, v);
          return 12; // OUT (C),r はフラグ不変
        }
        if (z === 2) {
          if (q === 0) this.sbcHL(this.getRP(p, null));
          else this.adcHL(this.getRP(p, null));
          return 15;
        }
        if (z === 3) {
          if (q === 0) { const nn = this.fetch16(); const v = this.getRP(p, null); this.write(nn, v & 0xFF); this.write((nn + 1) & 0xFFFF, (v >> 8) & 0xFF); }
          else { const nn = this.fetch16(); const v = this.read(nn) | (this.read((nn + 1) & 0xFFFF) << 8); this.setRP(p, v, null); }
          return 20;
        }
        if (z === 4) { const v = this.a; this.a = 0; this.sub8(v, 0, true); return 8; }
        if (z === 5) { this.iff1 = this.iff2; this.pc = this.pop16(); return 14; }
        if (z === 6) { const modes = [0, 0, 1, 2, 0, 0, 1, 2]; this.im = modes[y]; return 8; }
        if (z === 7) {
          switch (y) {
            case 0: this.i = this.a; return 9;
            case 1: this.r = this.a; return 9;
            case 2: this.a = this.i; this.setFlag(F_S, (this.a & 0x80) !== 0); this.setFlag(F_Z, this.a === 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_PV, this.iff2); setXY(this, this.a); return 9;
            case 3: this.a = this.r; this.setFlag(F_S, (this.a & 0x80) !== 0); this.setFlag(F_Z, this.a === 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_PV, this.iff2); setXY(this, this.a); return 9;
            case 4: { const a = this.a; const m = this.read(this.getHL()); const newA = (a & 0xF0) | (m & 0x0F); const newM = ((a & 0x0F) << 4) | (m >> 4); this.write(this.getHL(), newM); this.a = newA; this.setFlag(F_S, (newA & 0x80) !== 0); this.setFlag(F_Z, newA === 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_PV, PARITY[newA]); setXY(this, newA); return 18; } // RRD
            case 5: { const a = this.a; const m = this.read(this.getHL()); const newA = (a & 0xF0) | (m >> 4); const newM = ((m << 4) & 0xF0) | (a & 0x0F); this.write(this.getHL(), newM); this.a = newA; this.setFlag(F_S, (newA & 0x80) !== 0); this.setFlag(F_Z, newA === 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_PV, PARITY[newA]); setXY(this, newA); return 18; } // RLD
            default: return 8;
          }
        }
      }

      if (x === 2 && z < 4 && y >= 4) {
        return this.execBlock(y, z);
      }

      // その他の未定義EDオペコード: 8T NOP相当
      return 8;
    }

    // ブロック命令(LDIR/CPIR/INIR/OTIR系)が「もう一周する」と決まったときだけ、
    // 未定義フラグ XF/YF を PC上位バイトから取り直す。実機はこの経路でだけ
    // A+転送値ではなく巻き戻したPCのPCHをフラグ源にする(SingleStepTests z80 で確認)。
    // 最終周(BC=0で抜ける回)は通常どおりなので、ここを通さないのが正しい。
    _blockRepeatFlags() {
      const pch = (this.pc >> 8) & 0xFF;
      this.f = (this.f & ~(F_X | F_Y)) | (pch & (F_X | F_Y));
    }

    execBlock(y, z) {
      const inc = (y === 4 || y === 6) ? 1 : -1;
      const repeat = (y === 6 || y === 7);
      if (z === 0) { // LDI/LDD/LDIR/LDDR
        const hl = this.getHL(), de = this.getDE();
        const value = this.read(hl);
        this.write(de, value);
        this.setHL((hl + inc) & 0xFFFF);
        this.setDE((de + inc) & 0xFFFF);
        const bc = (this.getBC() - 1) & 0xFFFF;
        this.setBC(bc);
        this.setFlag(F_H, false); this.setFlag(F_N, false);
        this.setFlag(F_PV, bc !== 0);
        const n = (value + this.a) & 0xFF;
        this.f = (this.f & ~(F_X | F_Y)) | (n & F_X) | (((n & 0x02) << 4));
        if (repeat && bc !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this._blockRepeatFlags(); return 21; }
        return 16;
      }
      if (z === 1) { // CPI/CPD/CPIR/CPDR
        const hl = this.getHL();
        const value = this.read(hl);
        const a = this.a;
        const diff = a - value;
        const result = diff & 0xFF;
        const halfBorrow = ((a & 0xF) - (value & 0xF)) < 0;
        this.setHL((hl + inc) & 0xFFFF);
        const bc = (this.getBC() - 1) & 0xFFFF;
        this.setBC(bc);
        this.setFlag(F_H, halfBorrow);
        this.setFlag(F_N, true);
        this.setFlag(F_PV, bc !== 0);
        this.setFlag(F_Z, result === 0);
        this.setFlag(F_S, (result & 0x80) !== 0);
        const n = (result - (halfBorrow ? 1 : 0)) & 0xFF;
        this.f = (this.f & ~(F_X | F_Y)) | (n & F_X) | (((n & 0x02) << 4));
        if (repeat && bc !== 0 && result !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this._blockRepeatFlags(); return 21; }
        return 16;
      }
      if (z === 2) { // INI/IND/INIR/INDR
        const hl = this.getHL();
        const value = this.ioRead(this.c);
        this.write(hl, value);
        this.setHL((hl + inc) & 0xFFFF);
        this.b = (this.b - 1) & 0xFF;
        this.setFlag(F_Z, this.b === 0); this.setFlag(F_N, (value & 0x80) !== 0);
        this.setFlag(F_S, (this.b & 0x80) !== 0);
        const k = value + ((this.c + inc) & 0xFF);
        this.setFlag(F_C, k > 0xFF); this.setFlag(F_H, k > 0xFF);
        this.setFlag(F_PV, PARITY[(k & 7) ^ this.b]);
        setXY(this, this.b);
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this._blockRepeatFlags(); return 21; }
        return 16;
      }
      // z===3: OUTI/OUTD/OTIR/OTDR
      const hl = this.getHL();
      const value = this.read(hl);
      this.setHL((hl + inc) & 0xFFFF);
      this.b = (this.b - 1) & 0xFF;
      this.ioWrite(this.c, value);
      this.setFlag(F_Z, this.b === 0); this.setFlag(F_N, (value & 0x80) !== 0);
      this.setFlag(F_S, (this.b & 0x80) !== 0);
      const k = value + this.l;
      this.setFlag(F_C, k > 0xFF); this.setFlag(F_H, k > 0xFF);
      this.setFlag(F_PV, PARITY[(k & 7) ^ this.b]);
      setXY(this, this.b);
      if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this._blockRepeatFlags(); return 21; }
      return 16;
    }

    /**
     * addr のサブルーチンを呼び出し、RET で戻るまで実行する(KSSのINIT/PLAY呼び出しに使用)
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

  Emu.CPUZ80 = CPUZ80;
  Emu.Z80_FLAGS = { C: F_C, N: F_N, PV: F_PV, X: F_X, H: F_H, Y: F_Y, Z: F_Z, S: F_S };
})(globalThis);

/*
 * AY-3-8910 PSG エミュレータ (MSX標準音源)
 * MML.Emu.AY8910Audio
 *
 * コア(トーン/ノイズ/エンベロープ/DAC)は src/emulator/expansion/fme7.js と共通設計
 * (FME-7=Sunsoft 5B は AY-3-8910/YM2149 とレジスタ・DSP的に実質同一のため)。
 * バス面のみMSX実機に合わせてポート0xA0(レジスタ選択)/0xA1(データ書込)/0xA2(データ読出)、
 * レジスタ14/15(I/Oポート A/B、未接続なので読み出しは既定0xFF)に置き換えている。
 *
 * トーン: f = Z80クロック/(32*period)。ノイズ: f = clock/(32*period)。
 * エンベロープ: 5bit(0-31)、1ステップ = clock/(16*period)。
 * 音量DAC: 5bit対数(1.5dB/step)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const AY_DAC = new Float32Array(32);
  for (let i = 0; i < 32; i++) AY_DAC[i] = i < 2 ? 0 : Math.pow(10, (i - 31) * 1.5 / 20);

  const NUM_CH = 3;
  // ★超音波のトーン(2026-09-19): 周期 5 以下は Z80クロック/32(f=3579545/(32*周期)。VGM で別クロックのときも近い値) で 20kHz を超える。出力サンプルの瞬間値を拾うと
  //   サンプリング周波数との差で折り返し、聞こえる高音(例: 48kHz で FME7 周期1=55.9kHz → 約7.9kHz)になる。
  //   実機ではアナログ段で平均され、方形波の半分の高さの直流(音量を変えた瞬間の「カチッ」)にしかならないので、
  //   その平均(0.5)で鳴らす。Konami の MSX ドライバはバスドラの頭を周期1+エンベロープで作る
  //   (Metal Gear 2 曲153。元の AY は約15.8kHz、FME7 へ写すと約7.9kHz に折り返して金属音になっていた)
  const ULTRA_TONE_PERIOD_MAX = 5;

  class AyTone {
    constructor() { this.period = 1; this.timer = 0; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.level = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.level ^= 1;
      } else {
        this.timer--;
      }
    }
  }

  class AyNoise {
    constructor() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    reset() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.flip ^= 1;
        if (this.flip) {
          const fb = (this.lfsr ^ (this.lfsr >> 3)) & 1;
          this.lfsr = ((this.lfsr >> 1) | (fb << 16)) & 0x1FFFF;
        }
        this.out = this.lfsr & 1;
      } else {
        this.timer--;
      }
    }
  }

  class AyEnvelope {
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
      this.level = this.att ? 0 : 31;
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
        if (!this.cont) { this.holding = true; this.level = 0; return; }
        if (this.hold) { this.holding = true; this.level = this.alt ? (this.att ? 0 : 31) : (this.att ? 31 : 0); return; }
        if (this.alt) this.att = !this.att;
      }
      this.level = this.att ? this.step : (31 - this.step);
    }
  }

  class AY8910Audio {
    constructor() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38; // 既定: トーンON・ノイズOFF、I/Oポートは入力扱い
      this.regs[14] = 0xFF;
      this.regs[15] = 0xFF;
      this.tones = [new AyTone(), new AyTone(), new AyTone()];
      this.noise = new AyNoise();
      this.env = new AyEnvelope();
      this._div = 0;
      this.mute = [false, false, false];
      this.vol = [1, 1, 1];
    }

    reset() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38;
      this.regs[14] = 0xFF;
      this.regs[15] = 0xFF;
      for (const t of this.tones) t.reset();
      this.noise.reset();
      this.env.reset();
      this._div = 0;
    }

    // port: 0xA0=レジスタ選択, 0xA1=データ書込
    ioWrite(port, value) {
      value &= 0xFF;
      if (port === 0xA0) {
        this.addr = value & 0x0F;
      } else if (port === 0xA1) {
        this.writeInternal(this.addr, value);
      }
    }

    // port 0xA2=データ読出
    readData() {
      return this.regs[this.addr];
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
      }
    }

    clock() {
      if (++this._div >= 16) {
        this._div = 0;
        this.tones[0].clock();
        this.tones[1].clock();
        this.tones[2].clock();
        this.noise.clock();
        this.env.clock();
      }
    }

    channelLevel(ch) {
      const volReg = this.regs[8 + ch];
      if (volReg & 0x10) return this.env.level;
      return ((volReg & 0x0F) * 2) + 1;
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
      return sum * 0.35;
    }
  }

  // 鍵盤表示用スナップショット。clockHz省略時はMSX Z80クロック基準(=このエミュレータの
  // clock()呼び出しレート、実AYクロックの2倍)。VGMのように別クロックで叩く場合は
  // clock()の呼び出しレートを渡す
  Emu.snapshotAY8910 = function (chip, clockHz) {
    const CLOCK = clockHz || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    const mix = chip.regs[7];
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const period = chip.tones[i].period;
      const toneOn = ((mix >> i) & 1) === 0;
      const noiseOn = ((mix >> (i + 3)) & 1) === 0;
      const level = chip.channelLevel(i);
      const envMode = (chip.regs[8 + i] & 0x10) !== 0;
      const freq = (toneOn && period > 0) ? CLOCK / (32 * period) : 0;
      out.push({
        freq,
        vol: level / 31,
        // ★数値は**実レジスタ値**(2026-09-17のユーザー合意)。スケールがモードで変わる:
        //   ・固定音量(AY-3-8910 も YM2149 も) … 音量レジスタの4bit、**0-15**
        //   ・ハードウェアエンベロープ中(YM2149)  … エンベロープの5bitレベル、**0-31**
        //   当実装は AY と YM2149 を区別せず内部は常に32段で回している(channelLevel が
        //   固定音量時に (nibble*2)+1 で32段空間へ写す)。**表示だけ**をモードで切り替える。
        //   0-31 のときは既存の黄色表示(envMode)が「レジスタそのままではない」印になる。
        rawVol: envMode ? level : (chip.regs[8 + i] & 0x0F),
        rawVolMax: envMode ? 31 : 15,
        // ★2026-08-22: 「トーン有効だが周期0で、ノイズだけで鳴らしている」打楽器chが
        // 消灯していた(Aleste Gaiden MSX2のch A=全曲period 0/ノイズのみ)。旧式は
        // toneOnを先に見てfreq>0を要求していたため、ノイズ発音中でもactive=falseになる。
        // 実際に音が出る条件は「音量>0 かつ (実周期のあるトーン または ノイズ)」。
        // 音量判定に level>0 は使えない: channelLevel()は音量レジスタ0でも1を返す
        // ((nibble*2)+1 の5bit DACインデックス)ため、固定音量時は level>1 で見る。
        active: (envMode ? level > 0 : level > 1) && ((toneOn && freq > 0) || noiseOn),
        noise: noiseOn,
        // ノイズLFSRのシフトレート。トーンと同じ分周(clock()内で1/16 → 2フリップで1シフト)
        // なので式もトーンと同一(CLOCK/(32*周期))。周期0は実機同様1として扱う。
        noiseFreq: CLOCK / (32 * Math.max(1, chip.noise.period)),
        // トーン発生器が実質鳴っていない(無効 or 周期0)のにノイズが有効 = ノイズ専用ch。
        // 鍵盤のnote列/波形をノイズ表示に切り替える判断に使う(SN76489/GBSのノイズ行と同じ扱い)。
        noiseOnly: noiseOn && !(toneOn && period > 0),
        envMode
      });
    }
    return out;
  };

  Emu.AY8910Audio = AY8910Audio;
})(globalThis);

/*
 * Konami SCC/SCC+ 波形メモリ音源エミュレータ
 * MML.Emu.SCCAudio
 *
 * 5ch、各32byte符号付き波形テーブル。classic(SCC)モードではch3/ch4が波形テーブルを
 * 共有し、SCC+(SCC-I)モードではch4が独立波形を持つ。
 * kssBus.js が「どちらのモードでレジスタ窓が開いているか」を判定した上で
 * readClassic/writeClassic または readPlus/writePlus を、窓先頭+0x800からの
 * オフセット(0x00-0xFF)で呼び出す。内部発振は窓の有無に関わらず常時動作する
 * (実チップはメモリデコードと無関係に発振し続けるため)。
 *
 * ★classicとSCC+でレジスタ配置が異なる(emu2212 write_standard/write_enhanced準拠)。
 *   classic(窓 0x9800-0x98FF):
 *     0x00-0x7F : 波形 ch0-3 (32byte×4、ch3への書込みはch4にも反映される共有波形)
 *     0x80-0x89 : 周波数(12bit、ch0-4、各2byte 下位byte+上位nibble)
 *     0x8A-0x8E : 音量(4bit、ch0-4)
 *     0x8F      : 有効ビット(bit0-4、1で発音)
 *     0xA0-0xBF : 波形ch4 (読出専用、ch3と同一)
 *     0xE0-0xFF : deformレジスタ
 *   SCC+(窓 0xB800-0xB8FF):
 *     0x00-0x9F : 波形 ch0-4 (32byte×5、ch4も独立)
 *     0xA0-0xA9 : 周波数 / 0xAA-0xAE : 音量 / 0xAF : 有効ビット
 *     0xC0-0xDF : deformレジスタ
 *
 * 周波数式: f = Z80クロック / (32 * (period+1))。period<=8で発振停止(実機の既知の仕様)。
 * 出力: 符号付き8bit波形サンプル × 4bit音量 >> 4。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 5;

  class SCCAudio {
    constructor() {
      this.wave = [];
      for (let i = 0; i < NUM_CH; i++) this.wave.push(new Int8Array(32));
      this.freq = new Uint16Array(NUM_CH);
      this.volume = new Uint8Array(NUM_CH);
      this.enable = 0x1F;
      this.deformClassic = 0;
      this.deformPlus = 0;
      this.modeReg = 0;
      this.counter = new Uint32Array(NUM_CH);
      this.pos = new Uint8Array(NUM_CH);
      this.mute = [false, false, false, false, false];
      this.vol = [1, 1, 1, 1, 1];
    }

    reset() {
      for (const w of this.wave) w.fill(0);
      this.freq.fill(0);
      this.volume.fill(0);
      this.enable = 0x1F;
      this.deformClassic = 0;
      this.deformPlus = 0;
      this.modeReg = 0;
      this.counter.fill(0);
      this.pos.fill(0);
    }

    // --- classicモード(0x9800基準オフセット) ---
    readClassic(off) {
      off &= 0xFF;
      if (off < 0x80) return this.wave[off >> 5][off & 0x1F] & 0xFF;
      if (off <= 0x89) { const ch = (off - 0x80) >> 1; return (off & 1) ? ((this.freq[ch] >> 8) & 0x0F) : (this.freq[ch] & 0xFF); }
      if (off <= 0x8E) return this.volume[off - 0x8A] & 0x0F;
      if (off === 0x8F) return this.enable & 0x1F;
      if (off >= 0xA0 && off <= 0xBF) return this.wave[3][off & 0x1F] & 0xFF; // ch4=ch3共有(読出のみ)
      return 0xFF;
    }

    writeClassic(off, value) {
      off &= 0xFF;
      value &= 0xFF;
      if (off < 0x80) {
        const ch = off >> 5;
        this.wave[ch][off & 0x1F] = value;
        if (ch === 3) this.wave[4][off & 0x1F] = value; // ch3書込みはch4にも反映(共有波形)
        return;
      }
      if (off <= 0x89) {
        const ch = (off - 0x80) >> 1;
        if (off & 1) this.freq[ch] = (this.freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
        else this.freq[ch] = (this.freq[ch] & 0x0F00) | value;
        return;
      }
      if (off <= 0x8E) { this.volume[off - 0x8A] = value & 0x0F; return; }
      if (off === 0x8F) { this.enable = value & 0x1F; return; }
      if (off >= 0xE0) { this.deformClassic = value; return; }
      // 0xA0-0xBF (ch4波形) はclassicモードでは書込不可
    }

    // --- SCC+(SCC-I)モード(0xB800基準オフセット) ---
    // ★classicとレジスタ配置が違う(emu2212 write_enhanced準拠)。ここをclassicと同じ
    // 配置で実装していたため、SCC+を使うタイトル(スナッチャー/SDスナッチャー等)は
    // 周波数(0xA0-)と音量(0xAA-)の書込みが「ch4の波形」と誤解釈されて一切設定されず、
    // PSGだけ鳴ってSCCが無音になっていた。
    //   0x00-0x9F : 波形 ch0-4 (32byte×5、ch4も独立して書ける)
    //   0xA0-0xA9 : 周波数(12bit、各2byte)
    //   0xAA-0xAE : 音量(4bit)
    //   0xAF      : 有効ビット(bit0-4)
    //   0xC0-0xDF : deformレジスタ
    readPlus(off) {
      off &= 0xFF;
      if (off < 0xA0) return this.wave[off >> 5][off & 0x1F] & 0xFF;
      if (off <= 0xA9) { const ch = (off - 0xA0) >> 1; return (off & 1) ? ((this.freq[ch] >> 8) & 0x0F) : (this.freq[ch] & 0xFF); }
      if (off <= 0xAE) return this.volume[off - 0xAA] & 0x0F;
      if (off === 0xAF) return this.enable & 0x1F;
      if (off >= 0xC0 && off <= 0xDF) return this.deformPlus;
      return 0xFF;
    }

    writePlus(off, value) {
      off &= 0xFF;
      value &= 0xFF;
      if (off < 0xA0) { this.wave[off >> 5][off & 0x1F] = value; return; }
      if (off <= 0xA9) {
        const ch = (off - 0xA0) >> 1;
        if (off & 1) this.freq[ch] = (this.freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
        else this.freq[ch] = (this.freq[ch] & 0x0F00) | value;
        return;
      }
      if (off <= 0xAE) { this.volume[off - 0xAA] = value & 0x0F; return; }
      if (off === 0xAF) { this.enable = value & 0x1F; return; }
      if (off >= 0xC0 && off <= 0xDF) { this.deformPlus = value; return; }
    }

    // 1 Z80サイクル分クロック
    // (deformレジスタによる周波数マスクは、実運用でほぼ使われない特殊効果のため
    //  常時ゲームが使う生のfreqレジスタで発振させる。deformレジスタ自体の読み書きは
    //  read/writeClassic・read/writePlus で保持している)
    clock() {
      for (let ch = 0; ch < NUM_CH; ch++) {
        const period = this.freq[ch];
        if (period <= 8) continue; // 実機の既知の仕様: 低周期で発振停止(DC出力)
        this.counter[ch]++;
        if (this.counter[ch] >= period + 1) {
          this.counter[ch] = 0;
          this.pos[ch] = (this.pos[ch] + 1) & 0x1F;
        }
      }
    }

    mixSample() {
      let sum = 0;
      for (let ch = 0; ch < NUM_CH; ch++) {
        if (this.mute[ch]) continue;
        if (!((this.enable >> ch) & 1)) continue;
        const sample = this.wave[ch][this.pos[ch]]; // 符号付き -128..127
        const vol = this.volume[ch];
        sum += ((sample * vol) >> 4) * this.vol[ch];
      }
      return sum * (0.2 / 128);
    }
  }

  // 鍵盤表示用スナップショット
  Emu.snapshotSCC = function (chip) {
    const CLOCK = MML.KSS ? MML.KSS.Z80_CLOCK : 3579545;
    const out = [];
    for (let ch = 0; ch < NUM_CH; ch++) {
      const period = chip.freq[ch];
      const enabled = !!((chip.enable >> ch) & 1);
      const freq = period > 8 ? CLOCK / (32 * (period + 1)) : 0;
      const waveData = new Array(32);
      for (let i = 0; i < 32; i++) waveData[i] = chip.wave[ch][i] / 128;
      out.push({
        freq,
        vol: chip.volume[ch] / 15,
        rawVol: chip.volume[ch],
        waveData,
        active: enabled && chip.volume[ch] > 0 && freq > 0
      });
    }
    return out;
  };

  Emu.SCCAudio = SCCAudio;
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
 * FMPAC(MSX-MUSIC) 拡張音源エミュレータ (OPLL / YM2413)
 * MML.Emu.OPLLAudio
 *
 * ★2026-08-22: 既定の再生コアは opllNuked.js (Nuked-OPLL移植) に移行した。このファイルの
 * 実装は MML.Emu.OPLL_CORE = 'emu2413' を指定したときのA/B比較用として残してある。
 *
 * src/emulator/expansion/vrc7.js のOPLLコア(Mitsutaka Okazaki emu2413移植)をそのまま
 * 流用し、バス面のみMSX実機のFMPAC I/Oポート(0x7C=アドレス, 0x7D=データ)に置き換えている。
 * VRC7とFMPACはハードウェア的に同一のYM2413(OPLL)であるため、DSPコアは変更していない。
 * 出力49716Hz。clock()はOPLLマスタクロック(=MSXでは3.579545MHz、Z80と同一)基準で
 * 呼ばれるため分周は72(3579545/72=49716)。★VRC7(vrc7.js)はNES CPUクロック1.79MHz
 * =マスタの半分を渡される設計なので分周36。両者で定数が違うのは正しい。
 *
 * ノイズ合成(short_noise)アルゴリズムは digital-sound-antiques/emu2413
 * (MIT License, Copyright (c) 2001-2019 Mitsutaka Okazaki) の emu2413.c を参照して移植。
 * 音色ROM(メロディ15音色・リズム3音色)は nukeykt/Nuked-OPLL (GPLv2) の patch_ym2413
 * = YM2413実チップの die shot 読み出し値。本リポジトリもGPLv2。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // FMPAC(YM2413)は9メロディチャンネル。リズムモード時はch6-8が
  // BD(ch6両slot)/HH+SD(ch7 mod+car)/TOM+CYM(ch8 mod+car)に化ける。
  // VRC7(6ch専用・リズムモード無し)から移植したコアをここで9ch+リズム対応に拡張している。
  const NUM_CH = 9;
  // ミュート/音量の添字: 0-8=メロディch, 9-13=リズム(BD,SD,TOM,CYM,HH)。
  // SDとHH(TOMとCYM)は実機では同じchだが鍵盤には別行で出るため、実ch単位の添字だと
  // getMuteConfig()の書き込み順で片方が無視される(opllNuked.js RHYTHM_CH のコメント参照)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14;
  const CYCLES_PER_SAMPLE = 72; // ★2026-08-22: 36は誤り(1オクターブ高かった)。ファイル冒頭コメント参照
  const SAMPLE_RATE = 49716;

  const PG_BITS = 10, PG_WIDTH = 1 << PG_BITS; // emu2413に合わせて9→10bit化
  const DP_BITS = 19, DP_WIDTH = 1 << DP_BITS, DP_BASE_BITS = DP_BITS - PG_BITS;
  const DB_STEP = 0.375, DB_BITS = 7, DB_MUTE = 1 << DB_BITS;
  const EG_STEP = 0.375, EG_BITS = 7;
  const EG2DB = 1;
  const TL2EG = 2;
  const DB2LIN_AMP_BITS = 10, SLOT_AMP_BITS = DB2LIN_AMP_BITS;
  const EG_DP_BITS = 22, EG_DP_WIDTH = 1 << EG_DP_BITS;
  const PM_PG_BITS = 8, PM_PG_WIDTH = 1 << PM_PG_BITS;
  const PM_DP_BITS = 16, PM_DP_WIDTH = 1 << PM_DP_BITS;
  const AM_PG_BITS = 8, AM_PG_WIDTH = 1 << AM_PG_BITS;
  const AM_DP_BITS = 16, AM_DP_WIDTH = 1 << AM_DP_BITS;
  const PM_AMP_BITS = 8, PM_AMP = 1 << PM_AMP_BITS;
  const PM_SPEED = 6.4, PM_DEPTH = 13.75, AM_SPEED = 3.7, AM_DEPTH = 4.8;

  const SETTLE = 0, ATTACK = 1, DECAY = 2, SUSHOLD = 3, SUSTINE = 4, RELEASE = 5, FINISH = 6;

  // 音色ROM(YM2413本来の内蔵15音色)。
  // ★2026-08-22: emu2413(2413tone.h)の値から、nukeykt/Nuked-OPLL の patch_ym2413 へ
  // 差し替え。emu2413のROM値は原典のWikiが "Estimated ROM Instruments" と明記している通り
  // YM2413B実機録音からの耳コピ推定だが、Nuked-OPLL のものは decap/die shot
  // (siliconpr0n: digshadow, John McMaster)から読み出したROM内容そのもの。
  // 同じ経緯で vrc7.js の VRC7(DS1001)側テーブルも patch_ds1001 へ差し替え済み。
  // ★2026-08-02(履歴): それ以前はVirtuaNESのvrc7tone.h(=VRC7固有ROM)を「FMPAC/YM2413も
  // 同一ROM」という誤った前提で流用していた。VRC7とYM2413のROMは別物。
  const OPLL_INST = [
    [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // 0: ユーザー音色枠(@0所定値なし)
    [0x71,0x61,0x1e,0x17,0xd0,0x78,0x00,0x17], // 1: Violin
    [0x13,0x41,0x1a,0x0d,0xd8,0xf7,0x23,0x13], // 2: Guitar
    [0x13,0x01,0x99,0x00,0xf2,0xc4,0x11,0x23], // 3: Piano
    [0x31,0x61,0x0e,0x07,0xa8,0x64,0x70,0x27], // 4: Flute
    [0x32,0x21,0x1e,0x06,0xe0,0x76,0x00,0x28], // 5: Clarinet
    [0x31,0x22,0x16,0x05,0xe0,0x71,0x00,0x18], // 6: Oboe
    [0x21,0x61,0x1d,0x07,0x82,0x81,0x10,0x07], // 7: Trumpet
    [0x23,0x21,0x2d,0x14,0xa2,0x72,0x00,0x07], // 8: Organ
    [0x61,0x61,0x1b,0x06,0x64,0x65,0x10,0x17], // 9: Horn
    [0x41,0x61,0x0b,0x18,0x85,0xf7,0x71,0x07], // 10: Synthesizer
    [0x13,0x01,0x83,0x11,0xfa,0xe4,0x10,0x04], // 11: Harpsichord
    [0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12], // 12: Vibraphone
    [0x61,0x50,0x0c,0x05,0xc2,0xf5,0x20,0x42], // 13: Synth Bass
    [0x01,0x01,0x55,0x03,0xc9,0x95,0x03,0x02], // 14: Acoustic Bass
    [0x61,0x41,0x89,0x03,0xf1,0xe4,0x40,0x13]  // 15: Electric Guitar
  ];

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
  const PATCH = OPLL_INST.map(dump2patch);

  // リズム音色。★2026-08-22: メロディ音色と同じく Nuked-OPLL の patch_ym2413 由来の
  // die shot 読み出し値へ差し替え。Nuked側はドラムをmod半分(drum_0..2)とcar半分
  // (drum_3..5)に分けて持つので、$00-$07 の8バイト形式へは対になる2エントリをORして復元
  // (BDの結果 01 01 18 0F DF F8 6A 6D は NESdev Wiki "VRC7 audio" のドラム表とも一致)。
  const RHYTHM_PATCH_BD  = dump2patch([0x01, 0x01, 0x18, 0x0f, 0xdf, 0xf8, 0x6a, 0x6d]);
  const RHYTHM_PATCH_HHSD = dump2patch([0x01, 0x01, 0x00, 0x00, 0xc8, 0xd8, 0xa7, 0x48]);
  const RHYTHM_PATCH_TOMCYM = dump2patch([0x05, 0x01, 0x00, 0x00, 0xf8, 0xaa, 0x59, 0x55]);

  function Min(a, b) { return a < b ? a : b; }

  const AR_ADJUST = new Uint32Array(1 << EG_BITS);
  AR_ADJUST[0] = 1 << EG_BITS;
  for (let i = 1; i < 128; i++)
    AR_ADJUST[i] = ((1 << EG_BITS) - 1 - (1 << EG_BITS) * Math.log(i) / Math.log(128)) | 0;

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

  const fullsin = new Uint32Array(PG_WIDTH);
  const halfsin = new Uint32Array(PG_WIDTH);
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[i] = lin2db(Math.sin(2.0 * Math.PI * i / PG_WIDTH));
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[PG_WIDTH / 2 - 1 - i] = fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) fullsin[PG_WIDTH / 2 + i] = DB_MUTE + DB_MUTE + fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) halfsin[i] = fullsin[i];
  for (let i = PG_WIDTH / 2; i < PG_WIDTH; i++) halfsin[i] = fullsin[0];
  const WAVEFORM = [fullsin, halfsin];

  const pmtable = new Int32Array(PM_PG_WIDTH);
  for (let i = 0; i < PM_PG_WIDTH; i++)
    pmtable[i] = (PM_AMP * Math.pow(2, PM_DEPTH * Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH) / 1200)) | 0;
  const amtable = new Int32Array(AM_PG_WIDTH);
  for (let i = 0; i < AM_PG_WIDTH; i++)
    amtable[i] = (AM_DEPTH / 2 / DB_STEP * (1.0 + Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH))) | 0;

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

  const rksTable = [];
  for (let f8 = 0; f8 < 2; f8++) {
    const a = []; rksTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Int32Array(2); a.push(b);
      b[0] = block >> 1;
      b[1] = (block << 1) + f8;
    }
  }

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

  const SL_DB = [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,48];
  const SL = new Uint32Array(16);
  for (let i = 0; i < 16; i++) SL[i] = ((((SL_DB[i] / 3.0) * 8) | 0) << (EG_DP_BITS - EG_BITS)) >>> 0;

  const pm_dphase = ((PM_SPEED * PM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;
  const am_dphase = ((AM_SPEED * AM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;

  class Slot {
    constructor(type) {
      this.type = type;
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

  // emu2413.c の _PD マクロ: リズム位相定数は10bit(PG_BITS=10)テーブル基準の値。
  // 自前のPG_BITSも10なので通常は恒等変換だが、将来PG_BITSを変える場合に備え式のまま残す。
  function PD(phase) {
    return ((PG_BITS < 10 ? phase >> (10 - PG_BITS) : phase << (PG_BITS - 10)) & (PG_WIDTH - 1));
  }

  function rhythmOut(slot, egout, pgout) {
    if (egout >= DB_MUTE - 1) return 0;
    return DB2LIN[slot.sintbl[pgout] + egout];
  }

  class OpllChannel {
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

  class OPLLAudio {
    constructor(opts) {
      // ★2026-08-22: 既定ではNuked-OPLLコア(opllNuked.js)へ委譲する。
      // MML.Emu.OPLL_CORE = 'emu2413' を指定するとこの下の旧コア(emu2413 0.6x系移植)に戻る。
      // opts.core === 'legacy' でもこの下の旧コアになる。無音自動送りの先読みスキャンのように
      // 「音が鳴っているかどうかしか見ない」用途では、サイクルアキュレートである必要が無い一方
      // 主スレッドを食うため軽い方を明示的に選ぶ(kss-stream-player.js _scanBuildChips参照)。
      const useNuked = !(opts && opts.core === 'legacy') && Emu.OPLL_CORE !== 'emu2413' && Emu.OPLLNuked;
      if (useNuked) return new Emu.OPLLNuked({ chipType: 'ym2413' });
      this._init(); this.mute = new Array(NUM_MUTE_SLOTS).fill(false); this.vol = new Array(NUM_MUTE_SLOTS).fill(1); }
    _init() {
      this.addr = 0;
      this.reg = new Uint8Array(0x40);
      this.patches = [];
      for (let i = 0; i < 16; i++) this.patches.push({ mod: Object.assign({}, PATCH[i].mod), car: Object.assign({}, PATCH[i].car) });
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) { const c = new OpllChannel(); this.channels.push(c); this._setPatch(i, 0); }
      this.pm_phase = 0; this.am_phase = 0; this.lfo_pm = 0; this.lfo_am = 0;
      this.cyc = 0; this.lastSample = 0;
      this.rhythmMode = false;
      this.noiseLfsr = 1;
    }
    reset() { this._init(); }

    _setPatch(i, num) {
      const c = this.channels[i];
      c.patchNumber = num;
      c.mod.patch = this.patches[num].mod;
      c.car.patch = this.patches[num].car;
    }

    // port: 0x7C=アドレス, 0x7D=データ (FMPAC/MSX-MUSIC)
    ioWrite(port, value) {
      value &= 0xFF;
      if (port === 0x7C) this.addr = value & 0x3F;
      else if (port === 0x7D) this.writeReg(this.addr, value);
    }

    writeReg(reg, data) {
      reg &= 0x3F; data &= 0xFF;
      const cust = this.patches[0];
      if (reg <= 0x07) {
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
      } else if (reg === 0x0E) {
        this._writeRhythmReg(data);
      } else if (reg >= 0x10 && reg <= 0x18) {
        const ch = reg - 0x10, c = this.channels[ch];
        const fnum = data + ((this.reg[0x20 + ch] & 1) << 8);
        c.mod.fnum = c.car.fnum = fnum;
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x20 && reg <= 0x28) {
        const ch = reg - 0x20, c = this.channels[ch];
        const fnum = ((data & 1) << 8) + this.reg[0x10 + ch];
        const block = (data >> 1) & 7;
        c.mod.fnum = c.car.fnum = fnum; c.mod.block = c.car.block = block;
        if ((this.reg[reg] ^ data) & 0x20) { c.car.sustine = (data >> 5) & 1; }
        // リズムモード中のch6-8はキーオン/オフを0x0Eのビットで行うため、ここでは無視する
        // (周波数/ブロックの更新自体はBD/TOM等のピッチに使うので常に行う)。
        if (!(this.rhythmMode && ch >= 6)) {
          const key = (data & 0x10) !== 0;
          if (key) { if (!c.keyStatus) { c.mod.slotOn(); c.car.slotOn(); } c.keyStatus = 1; }
          else { if (c.keyStatus) c.car.slotOff(); c.keyStatus = 0; }
        }
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x30 && reg <= 0x38) {
        // emu2413.c OPLL_writeReg(): リズムモード中のch7/8上位ニブルはHH/TOMの音量(mod側の
        // TLLをTLでなくvolumeから引く、cf. mod.type=1切替はrhythmMode切替時)。
        // 下位ニブルはBD/SD/CYMも含め常にCAR側の音量として通常のTLLパスに乗る。
        const ch = reg - 0x30, c = this.channels[ch];
        if (this.rhythmMode && ch >= 6) {
          if (reg === 0x37 || reg === 0x38) { c.mod.volume = ((data >> 4) & 15) << 2; c.mod.updateTLL(); }
          c.car.volume = (data & 15) << 2;
          c.car.updateTLL();
        } else {
          this._setPatch(ch, (data >> 4) & 15);
          c.car.volume = (data & 15) << 2;
          c.mod.updateAll(); c.car.updateAll();
        }
      }
      this.reg[reg] = data;
    }

    // レジスタ0x0E: bit5=リズムモード有効, bit4-0=BD/SD/TOM/CYM/HHのキーオン
    _writeRhythmReg(data) {
      const old = this.reg[0x0E] || 0;
      const wasRhythm = this.rhythmMode;
      const newRhythm = !!(data & 0x20);
      if (newRhythm && !wasRhythm) {
        // ch6-8を専用リズム音色に切替。HH(ch7.mod)/TOM(ch8.mod)は本来モジュレータだが
        // リズムモードでは独立した音声出力になり、TLLもTL固定でなくvolumeレジスタ由来に
        // なる(emu2413 commit_slot_update: type&1==0以外はvolumeを参照)ためtypeを1にする。
        this.channels[6].mod.patch = RHYTHM_PATCH_BD.mod; this.channels[6].car.patch = RHYTHM_PATCH_BD.car;
        this.channels[7].mod.patch = RHYTHM_PATCH_HHSD.mod; this.channels[7].car.patch = RHYTHM_PATCH_HHSD.car;
        this.channels[8].mod.patch = RHYTHM_PATCH_TOMCYM.mod; this.channels[8].car.patch = RHYTHM_PATCH_TOMCYM.car;
        this.channels[7].mod.type = 1; this.channels[8].mod.type = 1;
        // 0x37/0x38の上位ニブルはレジスタとして常に保持されているため、直前の値を反映する
        this.channels[7].mod.volume = ((this.reg[0x37] >> 4) & 15) << 2;
        this.channels[8].mod.volume = ((this.reg[0x38] >> 4) & 15) << 2;
        for (const ch of [6, 7, 8]) { this.channels[ch].mod.updateAll(); this.channels[ch].car.updateAll(); }
      } else if (!newRhythm && wasRhythm) {
        // 通常モードに戻す: mod側のtypeを戻し、直前の0x36-38値で音色/音量を再設定
        this.channels[7].mod.type = 0; this.channels[8].mod.type = 0;
        for (const ch of [6, 7, 8]) {
          const rv = this.reg[0x30 + ch] || 0;
          this._setPatch(ch, (rv >> 4) & 15);
          this.channels[ch].car.volume = (rv & 15) << 2;
          this.channels[ch].mod.updateAll(); this.channels[ch].car.updateAll();
        }
      }
      this.rhythmMode = newRhythm;
      // slotOn/slotOffはeg_modeを変えるだけでeg_dphaseを再計算しないため、通常チャンネルの
      // キーオン(reg 0x20-0x28ハンドラ)同様にupdateEG()で追従させる必要がある。
      const trig = (bit, slots) => {
        if (!this.rhythmMode) return;
        const on = !!(data & bit), wasOn = !!(old & bit);
        if (on && !wasOn) for (const s of slots) { s.slotOn(); s.updateEG(); }
        else if (!on && wasOn) for (const s of slots) { s.slotOff(); s.updateEG(); }
      };
      trig(0x10, [this.channels[6].mod, this.channels[6].car]); // BD
      trig(0x08, [this.channels[7].car]); // SD
      trig(0x04, [this.channels[8].mod]); // TOM
      trig(0x02, [this.channels[8].car]); // CYM
      trig(0x01, [this.channels[7].mod]); // HH
    }

    _updateAMPM() {
      this.pm_phase = (this.pm_phase + pm_dphase) & (PM_DP_WIDTH - 1);
      this.am_phase = (this.am_phase + am_dphase) & (AM_DP_WIDTH - 1);
      this.lfo_am = amtable[this.am_phase >>> (AM_DP_BITS - AM_PG_BITS)];
      this.lfo_pm = pmtable[this.pm_phase >>> (PM_DP_BITS - PM_PG_BITS)];
    }

    _calc() {
      this._updateAMPM();
      // ノイズLFSR(HH/SD/CYMの疑似ノイズ合成用)を1サンプルにつき1回進める
      if (this.noiseLfsr & 1) this.noiseLfsr ^= 0x800200;
      this.noiseLfsr = (this.noiseLfsr >>> 1) || 1;
      const noiseBit = this.noiseLfsr & 1;

      let inst = 0;
      const lastCh = this.rhythmMode ? 6 : NUM_CH;
      for (let i = 0; i < lastCh; i++) {
        const c = this.channels[i];
        if (c.car.eg_mode === FINISH) continue;
        const fm = c.calcModulator(this.lfo_am, this.lfo_pm);
        const out = c.calcCarrier(fm, this.lfo_am, this.lfo_pm);
        if (!this.mute[i]) inst += out * this.vol[i];
      }
      if (this.rhythmMode) {
        const ch6 = this.channels[6], ch7 = this.channels[7], ch8 = this.channels[8];
        // BD: 通常チャンネルと同じmod→car 2opFM接続(emu2413はcalc_slot_mod/carをch6にも
        // そのまま流用している)。
        if (ch6.car.eg_mode !== FINISH) {
          const fm = ch6.calcModulator(this.lfo_am, this.lfo_pm);
          const out = ch6.calcCarrier(fm, this.lfo_am, this.lfo_pm);
          if (!this.mute[MUTE_BD]) inst += out * this.vol[MUTE_BD];
        }

        // HH/SD/TOM/CYM: 先に位相を進めてからshort_noiseを計算し(emu2413 update_short_noise)、
        // それを使って各スロットの出力サイン位相を選ぶ。音量はEG/TLL経由(rhythmOut内でegout
        // が既にvolumeレジスタ由来のTLLを反映済み)。
        const hh = ch7.mod, sd = ch7.car, tom = ch8.mod, cym = ch8.car;
        const hhPg = hh.calcPhase(this.lfo_pm);
        const sdPg = sd.calcPhase(this.lfo_pm);
        const tomPg = tom.calcPhase(this.lfo_pm);
        const cymPg = cym.calcPhase(this.lfo_pm);
        // emu2413 update_short_noise: BIT位置はPG_BITS基準の相対式のままにしておく
        const h_bit2 = (hhPg >> (PG_BITS - 8)) & 1;
        const h_bit7 = (hhPg >> (PG_BITS - 3)) & 1;
        const h_bit3 = (hhPg >> (PG_BITS - 7)) & 1;
        const c_bit3 = (cymPg >> (PG_BITS - 7)) & 1;
        const c_bit5 = (cymPg >> (PG_BITS - 5)) & 1;
        const shortNoise = (h_bit2 ^ h_bit7) | (h_bit3 ^ c_bit5) | (c_bit3 ^ c_bit5);

        const hhEg = hh.calcEnvelope(this.lfo_am);
        const sdEg = sd.calcEnvelope(this.lfo_am);
        const tomEg = tom.calcEnvelope(this.lfo_am);
        const cymEg = cym.calcEnvelope(this.lfo_am);

        if (tom.eg_mode !== FINISH && !this.mute[MUTE_TOM]) inst += rhythmOut(tom, tomEg, tomPg) * this.vol[MUTE_TOM];
        if (hh.eg_mode !== FINISH && !this.mute[MUTE_HH]) {
          const ph = shortNoise ? (noiseBit ? PD(0x2d0) : PD(0x234)) : (noiseBit ? PD(0x34) : PD(0xd0));
          inst += rhythmOut(hh, hhEg, ph) * this.vol[MUTE_HH];
        }
        if (sd.eg_mode !== FINISH && !this.mute[MUTE_SD]) {
          const sdOwnBit = (sdPg >> (PG_BITS - 2)) & 1;
          const ph = sdOwnBit ? (noiseBit ? PD(0x300) : PD(0x200)) : (noiseBit ? PD(0x0) : PD(0x100));
          inst += rhythmOut(sd, sdEg, ph) * this.vol[MUTE_SD];
        }
        if (cym.eg_mode !== FINISH && !this.mute[MUTE_CYM]) {
          const ph = shortNoise ? PD(0x300) : PD(0x100);
          inst += rhythmOut(cym, cymEg, ph) * this.vol[MUTE_CYM];
        }
      }
      return inst;
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this.lastSample = this._calc();
    }

    mixSample() {
      return (this.lastSample / 4096) * 0.5;
    }
  }

  function melodySnapshot(c, N) {
    const mod = c.mod, car = c.car;
    const freq = (c.keyStatus && car.fnum > 0) ? SAMPLE_RATE * car.fnum / Math.pow(2, 19 - car.block) : 0;
    const active = c.keyStatus && car.eg_mode !== FINISH && car.eg_mode !== SETTLE;
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
    return {
      freq,
      vol: (15 - (c.car.volume >> 2)) / 15,
      rawVol: c.car.volume >> 2,
      instrument: c.patchNumber,
      active,
      waveData: active ? wave : new Array(N).fill(0),
      // patch: 鍵盤の大波形表示の下に音色データ(@OT形式)を出すためのパラメータ
      // (現在選択中の音色のスロット {mod,car}。emu2413のpatch構造体そのまま)
      patch: { type: 'opll', inst: c.patchNumber, mod: mod.patch, car: car.patch }
    };
  }

  function rhythmSlotInfo(slot, keyOn, freq) {
    const active = keyOn && slot.eg_mode !== FINISH;
    return { freq: active ? freq : 0, vol: active ? 1 : 0, active };
  }

  // 通常モード: 9メロディチャンネル分を返す({rhythmMode:false, melody:[9]})。
  // リズムモード: melodyは0-5chの6要素のみ、加えてrhythm{bd,sd,tom,cym,hh}を返す
  // (ch6-8の8スロットが5種の打楽器に化けるため、鍵盤表示側は6melody+5rhythmの
  // 11行として描画する)。
  Emu.snapshotOPLL = function (chip) {
    if (typeof chip.snapshot === 'function') return chip.snapshot(); // Nukedコア
    const N = 128;
    const melodyCount = chip.rhythmMode ? 6 : NUM_CH;
    const melody = [];
    for (let i = 0; i < melodyCount; i++) melody.push(melodySnapshot(chip.channels[i], N));

    if (!chip.rhythmMode) return { rhythmMode: false, melody };

    const ch6 = chip.channels[6], ch7 = chip.channels[7], ch8 = chip.channels[8];
    const bdFreq = ch6.car.fnum > 0 ? SAMPLE_RATE * ch6.car.fnum / Math.pow(2, 19 - ch6.car.block) : 0;
    const tomFreq = ch8.mod.fnum > 0 ? SAMPLE_RATE * ch8.mod.fnum / Math.pow(2, 19 - ch8.mod.block) : 0;
    const rhythm = {
      bd: rhythmSlotInfo(ch6.car, true, bdFreq),
      sd: rhythmSlotInfo(ch7.car, true, 0),
      tom: rhythmSlotInfo(ch8.mod, true, tomFreq),
      cym: rhythmSlotInfo(ch8.car, true, 0),
      hh: rhythmSlotInfo(ch7.mod, true, 0),
    };
    return { rhythmMode: true, melody, rhythm };
  };

  Emu.OPLLAudio = OPLLAudio;
})(globalThis);

/*
 * YM2610 (OPNB) 音源エミュレータ — FM + ADPCM-A + ADPCM-B (Neo Geo / VGM)
 * MML.Emu.YM2610Audio
 *
 * YM2610は SSG(AY-3-8910互換,3ch) + FM(4ch) + ADPCM-A(6ch) + ADPCM-B(1ch) を1チップに
 * 内蔵する。このファイルは FM と ADPCM-A/B を扱う(SSGはEmu.AY8910Audioをそのまま再利用)。
 * VGM上は 0x58(ポート0)/0x59(ポート1) のレジスタ書込みでまとめて叩かれるので、SSG/FMの
 * 振り分けは呼び出し側(vgmPlayer.js)が行う(SSGはここに来ても弾くだけ)。
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植)の薄いラッパー。
 * 理由: YM2610のFMレジスタ配置はYM2612と完全に同一(0x30 DT/MUL … 0xB4 L/R/AMS/PMS、0x22 LFO、
 * 0x27 ch3モード、0x28 キーオン、サンプルレート=clock/144、周波数式も同じ)で、違いは
 *   (1) 6chぶんのアドレス空間のうち実チャンネルが各ポートのオフセット1,2だけ
 *       (オフセット0,3は結線されていないダミー。ymfm(aaronsgiles/ymfm, BSD-3)の
 *       ym2610 channel_mask=0x36=YM2612番号でch1,2,4,5 と一致。YM2610Bは6ch全部が実チャンネル)、
 *   (2) ch6 DAC(0x2A/0x2B、YM2612固有)が無い、
 *   (3) SSG/ADPCM-A/ADPCM-Bのレジスタ領域(port0 0x00-0x1F, port1 0x00-0x2F)が挟まる、
 * の3点だけなので、YM2612コアを6chのまま動かしてダミーch/DACを常時ミュートし、
 * 該当領域の書込みを弾くだけで済む。ch3特殊モード(0x27上位ビット、YM2612のch3=port0
 * オフセット2=YM2610のFM2に相当。MAME fm.cppのym2610もCH[2]に適用)もそのまま効く。
 * キーオン0x28の値1,2,5,6 → YM2612コアのch1,2,4,5 = 本クラスのFM1-4。
 *
 * コアは chipType:'ym3438' で使う: FMオペレータ本体(PG/EG/log-sin・exp ROM/LFO/SSG-EG)は
 * OPNファミリ共通設計だが、YM2612固有の9bit DACラダー効果はYM2610には無い
 * (OPNA/OPNBは内部加算して16bit出力)ため、ラダー無しモードが正しい。
 *
 * ★ADPCM-A/B は ymfm(ymfm_adpcm.cpp / ymfm_opn.cpp ym2610)の関数単位の移植:
 *   ADPCM-A: 6ch、4bit ADPCM(MSM5205系、12bit累算器はラップ)、アドレスは 開始/終了レジスタ<<8、
 *            終了比較は下位20bitのみ(twinspri等の実挙動)、FMサンプル3回に1回クロック
 *            (=EGサイクル、Neo Geo 8MHz で 18518Hz)。音量=(IL^0x1f)+(TL^0x3f) を乗数15-(v&7)と
 *            シフト5+(v>>3)へ。パンL/R。
 *   ADPCM-B: 1ch、4bit ADPCM(累算器16bitクランプ、ステップ127〜24576を0.9〜2.4倍)、
 *            Δ-N(16bit位相累算、fs=ΔN×55555/65536)、線形補間、レベル(0-255)、リピート、
 *            リミット/終了アドレス(<<8)、YM2610では常に外部メモリ(ROM)モード。
 *   ROMは VGM データブロック 0x82(ADPCM-A)/0x83(ADPCM-B=DELTA-T) を loadRom() で受け取る。
 *   出力尺度: ymfmでは FMチャンネルのフルスケール=4096(13bit>>1)、ADPCM-A最大≒15360、
 *   ADPCM-B最大≒16320(レベル255、YM2610はrshift=1)。本クラスのFMコアはフルスケール0.2
 *   (実測)なのでADPCM出力は ×0.2/4096 で同じ比率に合わせる(ADPCM_SCALE)。
 *
 * ★表示専用のサンプルピッチ解析(samplePitch / decodeAdpcmA・B / detectCps): 音程レジスタの無い
 *   ADPCM-Aと、Δ-Nしか無いADPCM-Bに絶対音名を出すため、ROM上のサンプルを1回だけデコードして
 *   基本周期(cps=1入力サンプルあたりの周期数)を求めキャッシュする(詳細は同関数群のコメント)。
 *
 *   手動キャリブレーション(setSampleTuning: cps上書き、localStorage 'ym2610AdpcmTuning' にサンプル内容の
 *   ハッシュをキーで永続化)と、波形アイコン用の1周期/概形波形(makeSampleWave)もここで作る。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample() / loadRom(kind,...) /
 * samplePitch(kind,start,end) / setSampleTuning(kind,start,end,cps|null) /
 * mute[fmCh] / vol[fmCh] / muteAdpcm[7](A1-6,B) / volAdpcm[7](書き換えたら syncMuteVol()) /
 * core / numFm(4 or 6) / flushWrites() / Emu.snapshotYM2610(chip)。
 * Neo Geo: 8000000Hz → 55555Hz。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CYCLES_PER_SAMPLE = 144;
  const ADPCM_SCALE = 0.2 / 4096; // ymfm出力単位 → 本クラスのFM尺度(FMチャンネルのフルスケール0.2)

  // ── ADPCM-A (ymfm adpcm_a_channel/engine) ──
  const ADPCMA_STEPS = [
    16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552
  ];
  const ADPCMA_STEP_INC = [-1, -1, -1, -1, 2, 5, 7, 9];
  const ADPCMA_ADDR_SHIFT = 8;

  class AdpcmA {
    /**
     * @param {object} owner - romA / sampleRate を持つチップ本体
     * @param {{fixedAddr?: Array<{start:number,end:number}>}} [opts]
     *   fixedAddr: サンプルの開始/終了(バイト、endは実機表と同じinclusive)を固定する。
     *   YM2608の内蔵リズム(6サンプルのアドレスがROM固定でレジスタが無い)用。
     *   省略時は従来どおり開始/終了レジスタ(YM2610 ADPCM-A)。
     */
    constructor(owner, opts) {
      this.owner = owner;
      this.fixedAddr = (opts && opts.fixedAddr) || null;
      this.regs = new Uint8Array(0x30);
      this.ch = [];
      // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
      for (let i = 0; i < 6; i++) this.ch.push({ playing: false, curnibble: 0, curbyte: 0, curaddress: 0, acc: 0, stepIndex: 0, seq: 0 });
      this.reset();
    }
    // ch i の開始バイトアドレス(fixedAddr優先)
    _startAddr(i) {
      if (this.fixedAddr) return this.fixedAddr[i].start;
      return (this.regs[0x10 + i] | (this.regs[0x18 + i] << 8)) << ADPCMA_ADDR_SHIFT;
    }
    // ch i の終了バイトアドレス(exclusive、fixedAddr優先)
    _endAddr(i) {
      if (this.fixedAddr) return this.fixedAddr[i].end + 1;
      return ((this.regs[0x20 + i] | (this.regs[0x28 + i] << 8)) + 1) << ADPCMA_ADDR_SHIFT;
    }
    // ch i の現在の開始/終了レジスタから求めたサンプル長(秒)。ADPCM-Aは18518Hz(=FMサンプルレート/3)固定
    lengthSeconds(i) {
      const bytes = Math.max(0, this._endAddr(i) - this._startAddr(i));
      return bytes * 2 / (this.owner.sampleRate / 3);
    }
    reset() {
      this.regs.fill(0);
      // パンは両方ON・音色レベル最大が既定(Neo Geoホームブリュー(ffeast等)が依存する。ymfmと同じ)
      for (let i = 0x08; i <= 0x0D; i++) this.regs[i] = 0xDF;
      for (const c of this.ch) { c.playing = false; c.curnibble = 0; c.curbyte = 0; c.curaddress = 0; c.acc = 0; c.stepIndex = 0; }
    }
    write(reg, data) {
      this.regs[reg] = data;
      if (reg === 0x00) {
        const on = !(data & 0x80); // bit7=1 dump(停止)、0=キーオン
        for (let i = 0; i < 6; i++) if (data & (1 << i)) this._keyonoff(i, on);
      }
    }
    _keyonoff(i, on) {
      const c = this.ch[i];
      c.playing = on;
      if (on) {
        c.curaddress = this._startAddr(i);
        c.curnibble = 0; c.curbyte = 0; c.acc = 0; c.stepIndex = 0;
        c.seq++;
        // 鳴っているサンプルの範囲(バイト)。ドライバがキーオン後に次の音のレジスタを先書きしても
        // 表示側(ピッチ解析)が正しいサンプルを見られるようキーオン時点で確定させる
        c.smpStart = c.curaddress;
        c.smpEnd = this._endAddr(i);
      }
    }
    // FMサンプル3回に1回。
    clock() {
      const rom = this.owner.romA;
      for (let i = 0; i < 6; i++) {
        const c = this.ch[i];
        if (!c.playing) { c.acc = 0; continue; }
        let data;
        if (c.curnibble === 0) {
          // 終了アドレス(inclusive)の次のバイトを読もうとした時点で停止。比較は下位20bitのみ
          const end = this._endAddr(i);
          if (((c.curaddress ^ end) & 0xFFFFF) === 0) { c.playing = false; c.acc = 0; continue; }
          c.curbyte = rom && c.curaddress < rom.length ? rom[c.curaddress] : 0;
          c.curaddress = (c.curaddress + 1) & 0xFFFFFF;
          data = c.curbyte >> 4; c.curnibble = 1;
        } else {
          data = c.curbyte & 0x0F; c.curnibble = 0;
        }
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[c.stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        c.acc = (c.acc + delta) & 0xFFF; // 12bit累算器はラップ(MSM5205と同じ)
        c.stepIndex = Math.max(0, Math.min(48, c.stepIndex + ADPCMA_STEP_INC[data & 7]));
      }
    }
    // ch i の現在出力(ymfm単位、パン適用前)。0=無音
    value(i) {
      const c = this.ch[i];
      const vol = ((this.regs[0x08 + i] & 0x1F) ^ 0x1F) + ((this.regs[0x01] & 0x3F) ^ 0x3F);
      if (vol >= 63) return 0;
      const mul = 15 - (vol & 7);
      const shift = 4 + 1 + (vol >> 3);
      let a = c.acc & 0xFFF; if (a & 0x800) a -= 0x1000; // 12bit符号拡張
      return (((a << 4) * mul) >> shift) & ~3;
    }
    panL(i) { return !!(this.regs[0x08 + i] & 0x80); }
    panR(i) { return !!(this.regs[0x08 + i] & 0x40); }
  }

  // ── ADPCM-B (ymfm adpcm_b_channel/engine、YM2610=外部メモリ固定・addrshift 8) ──
  const ADPCMB_STEP_MIN = 127, ADPCMB_STEP_MAX = 24576;
  const ADPCMB_STEP_SCALE = [57, 57, 57, 57, 77, 102, 128, 153];
  const ADPCMB_ADDR_SHIFT = 8;

  class AdpcmB {
    /**
     * @param {object} owner - romB / sampleRate を持つチップ本体
     * @param {{addrShift?: number, forceExternal?: boolean}} [opts]
     *   addrShift: 開始/終了/リミットレジスタ値→バイトアドレスのシフト。
     *   YM2610=8(256バイト単位、既定)、YM2608/Y8950=5(32バイト単位。MAME ymdeltat portshift)。
     *   forceExternal: control1へ外部メモリ・録音無効を強制(YM2610の実機挙動、既定true)。
     *   Y8950はCPU書込み(REC|MEMDATA)を使うので false にする(書込み自体は呼び出し側が実装)。
     */
    constructor(owner, opts) {
      this.owner = owner;
      this.addrShift = (opts && opts.addrShift) || ADPCMB_ADDR_SHIFT;
      this.forceExternal = !opts || opts.forceExternal !== false;
      this.regs = new Uint8Array(0x11);
      this.reset();
    }
    reset() {
      this.regs.fill(0);
      this.regs[0x0C] = this.regs[0x0D] = 0xFF; // リミット既定=全開
      this._resetChannel();
    }
    _resetChannel() {
      this.playing = false; this.curnibble = 0; this.curbyte = 0; this.position = 0; this.curaddress = 0;
      this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      if (this.seq === undefined) this.seq = 0; // 開始通番(先読みキャプチャ用、AdpcmA.ch[].seqと同じ役割)。リセットでは戻さない
    }
    // 現在の開始/終了/Δ-Nから求めたサンプル長(秒)。リピート時は無限(Infinity)
    lengthSeconds() {
      const start = (this.regs[0x02] | (this.regs[0x03] << 8)) << this.addrShift;
      const end = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift;
      const rate = this.rate();
      if (this.regs[0x00] & 0x10) return Infinity;
      return rate > 0 ? Math.max(0, end - start) * 2 / rate : 0;
    }
    // reg = port0 アドレス - 0x10 (0x00-0x0B)
    write(reg, data) {
      // YM2610は外部モード強制・録音無効(ymfm ym2610::write_data)
      if (reg === 0x00 && this.forceExternal) data = (data | 0x20) & ~0x40;
      this.regs[reg] = data;
      if (reg === 0x00) {
        if (data & 0x80) this._loadStart(); // start
        if (data & 0x01) this._resetChannel(); // reset
      }
    }
    _loadStart() {
      this.playing = true;
      this.curaddress = (this.regs[0x02] | (this.regs[0x03] << 8)) << this.addrShift;
      this.curnibble = 0; this.curbyte = 0; this.position = 0; this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      this.seq++;
      this.smpStart = this.curaddress; // 鳴っているサンプルの範囲(AdpcmA.ch[].smpStart/Endと同じ用途)
      this.smpEnd = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift;
    }
    _atEnd() { return this.curaddress === ((((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift) - 1); }
    _atLimit() { return this.curaddress === ((((this.regs[0x0C] | (this.regs[0x0D] << 8)) + 1) << this.addrShift) - 1); }
    // FMサンプル毎
    clock() {
      if (!(this.regs[0x00] & 0x80) || !this.playing) { this.playing = false; return; }
      const deltaN = this.regs[0x09] | (this.regs[0x0A] << 8);
      const position = this.position + deltaN;
      this.position = position & 0xFFFF;
      if (position < 0x10000) return;
      const rom = this.owner.romB;
      if (this.curnibble === 0) this.curbyte = rom && this.curaddress < rom.length ? rom[this.curaddress] : 0;
      const data = ((this.curbyte << (4 * this.curnibble)) & 0xFF) >> 4;
      this.curnibble ^= 1;
      if (this.curnibble === 0) {
        if (this._atEnd()) {
          if (this.regs[0x00] & 0x10) this._loadStart(); // repeat
          else { this.acc = 0; this.prevAcc = 0; this.playing = false; return; }
        } else if (this._atLimit()) {
          this.curaddress = 0;
        } else {
          this.curaddress = (this.curaddress + 1) & 0xFFFFFF;
        }
      }
      this.prevAcc = this.acc;
      let delta = ((2 * (data & 7) + 1) * this.step) >> 3;
      if (data & 8) delta = -delta;
      this.acc = Math.max(-32768, Math.min(32767, this.acc + delta));
      this.step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((this.step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
    }
    // 現在出力(ymfm単位、パン適用前)。線形補間×レベル(/256)、さらにYM2610では>>1
    // (ymfm ym2610::clock_fm_and_adpcm の m_adpcm_b.output(…, rshift=1))
    value() {
      const r = ((this.prevAcc * ((this.position ^ 0xFFFF) + 1) + this.acc * this.position) >> 16);
      return (r * this.regs[0x0B]) >> 9;
    }
    panL() { return !!(this.regs[0x01] & 0x80); }
    panR() { return !!(this.regs[0x01] & 0x40); }
    // 表示用: 現在の再生レート(Hz)
    rate() { return (this.regs[0x09] | (this.regs[0x0A] << 8)) * this.owner.sampleRate / 65536; }
  }

  // ── サンプルのピッチ解析(鍵盤/ロールの音程表示用。再生には一切関与しない) ──
  // ADPCM-A/B のサンプルは ROM 上の固定データなので、同じ範囲(開始/終了アドレス)は毎回同じ波形。
  // 初めて見たサンプルを1回だけ丸ごとデコードして基本周期を求め、「1入力サンプルあたりの周期数
  // cps」(再生レート非依存)としてキャッシュする。表示周波数 = cps × 現在の再生レート
  // (ADPCM-A: 固定18518Hz、ADPCM-B: Δ-N由来)。ADPCM-Bは「1つのサンプルをΔ-Nで音階演奏」が
  // 典型なので、Δ-Nの比で正確な音程差 + 解析で正確な基準、の組み合わせで絶対音名まで出せる。
  // ADPCM-Aは「音程ごとに別サンプル」の場合にサンプルごとの検出値がそのまま絶対音になる。
  // ドラム/ノイズ系は検出信頼度(conf)が低くなるので、表示側はしきい値で音程なし表示に落とす。
  //
  // 検出は McLeod の NSDF(正規化二乗差関数、実体は正規化自己相関)。アタック部(先頭15%)を避けて
  // 最大 PITCH_FRAMES 個の窓を等間隔に取り、各窓で「最初の主要ピーク」(グローバル最大の90%以上で
  // 最初に現れる正の山、放物線補間)を周期とする。窓ごとの結果の中央値を採用し、中央値±3%以内で
  // 一致した窓の割合を conf(0-1)にする(オクターブ誤りや非周期部分があると下がる)。
  // コスト: 窓1600×ラグ800×6窓≒8M積和/サンプル、ユニークなサンプルごとに1回だけ(数ms〜十数ms)。
  // PITCH_MIN_LAG: 検出上限周波数=レート/16(ADPCM-A 18518Hz→1157Hz、ADPCM-B 55kHz→3.4kHz)。
  // 小さくするとハイハット等の高域ノイズが最小ラグ境界に偽ピークを作る(初版は8で 18518/8=2314.8Hz
  // が実曲のハイハットに出た)。境界(τ==PITCH_MIN_LAG)で最大となる山も真の極大でないので捨てる。
  const PITCH_WIN = 1600, PITCH_MAX_LAG = 800, PITCH_MIN_LAG = 16, PITCH_FRAMES = 6, PITCH_CLARITY = 0.85;

  function decodeAdpcmA(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, stepIndex = 0, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        acc = (acc + delta) & 0xFFF;
        stepIndex = Math.max(0, Math.min(48, stepIndex + ADPCMA_STEP_INC[data & 7]));
        let s = acc; if (s & 0x800) s -= 0x1000;
        out[k++] = s / 2048;
      }
    }
    return out;
  }
  function decodeAdpcmB(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, step = ADPCMB_STEP_MIN, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * step) >> 3;
        if (data & 8) delta = -delta;
        acc = Math.max(-32768, Math.min(32767, acc + delta));
        step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
        out[k++] = acc / 32768;
      }
    }
    return out;
  }

  // 1窓のNSDFから周期(ラグ、小数)と明瞭度(0-1)を返す
  function nsdfPeriod(pcm, off, W, maxLag) {
    let mean = 0;
    for (let i = 0; i < W; i++) mean += pcm[off + i];
    mean /= W;
    const x = new Float32Array(W);
    for (let i = 0; i < W; i++) x[i] = pcm[off + i] - mean;
    const nsdf = new Float32Array(maxLag + 1);
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      let acf = 0, m = 0;
      for (let i = 0; i + tau < W; i++) { const a = x[i], b = x[i + tau]; acf += a * b; m += a * a + b * b; }
      nsdf[tau] = m > 0 ? 2 * acf / m : 0;
    }
    // 正の山ごとの最大値を集める(負→正の交差から次の負への交差まで)
    const peaks = [];
    let inPos = false, best = -1, bestTau = 0;
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (!inPos) { inPos = true; best = -1; }
        if (v > best) { best = v; bestTau = tau; }
      } else if (inPos) {
        inPos = false;
        if (bestTau > PITCH_MIN_LAG) peaks.push({ tau: bestTau, v: best }); // 境界の偽ピークは捨てる
      }
    }
    if (inPos && best > 0 && bestTau > PITCH_MIN_LAG && bestTau < maxLag) peaks.push({ tau: bestTau, v: best });
    if (!peaks.length) return null;
    let gmax = 0;
    for (const p of peaks) if (p.v > gmax) gmax = p.v;
    const p = peaks.find(q => q.v >= gmax * 0.9);
    // 放物線補間
    let tau = p.tau;
    if (tau > PITCH_MIN_LAG && tau < maxLag) {
      const y0 = nsdf[tau - 1], y1 = nsdf[tau], y2 = nsdf[tau + 1];
      const d = y0 - 2 * y1 + y2;
      if (d < 0) tau += 0.5 * (y0 - y2) / d;
    }
    return { lag: tau, clarity: p.v };
  }

  // pcm(Float32Array)から {cps, conf}。conf<0.5 は表示側で「音程なし」扱い
  function detectCps(pcm) {
    const len = pcm.length;
    if (len < 256) return { cps: 0, conf: 0 };
    const W = Math.min(PITCH_WIN, Math.floor(len * 0.6));
    const maxLag = Math.min(PITCH_MAX_LAG, Math.floor(W / 2));
    if (maxLag <= PITCH_MIN_LAG + 2) return { cps: 0, conf: 0 };
    const first = Math.floor(len * 0.15);
    const span = len - first - W;
    const frames = span <= 0 ? 1 : Math.min(PITCH_FRAMES, Math.floor(span / (W / 2)) + 1);
    const lags = [];
    for (let f = 0; f < frames; f++) {
      const off = span <= 0 ? Math.max(0, len - W) : first + Math.floor(span * f / Math.max(1, frames - 1));
      const r = nsdfPeriod(pcm, off, W, maxLag);
      if (r && r.clarity >= PITCH_CLARITY) lags.push(r.lag);
    }
    if (!lags.length) return { cps: 0, conf: 0 };
    lags.sort((a, b) => a - b);
    const med = lags[lags.length >> 1];
    let agree = 0;
    for (const l of lags) if (Math.abs(l - med) / med <= 0.03) agree++;
    return { cps: 1 / med, conf: agree / frames };
  }

  // サンプル内容のハッシュ(FNV-1a、先頭4KB+長さ)。手動キャリブレーションのキー。ROM上のアドレスは
  // ゲームごと/ダンプごとに違いうるが、サンプル内容が同じなら同じ音なので内容で同定する。
  function sampleHash(rom, start, end) {
    let h = 0x811c9dc5;
    const n = Math.min(end, rom.length) - start;
    const lim = Math.min(n, 4096);
    for (let i = 0; i < lim; i++) { h ^= rom[start + i]; h = Math.imul(h, 0x01000193); }
    h ^= n; h = Math.imul(h, 0x01000193);
    return (h >>> 0).toString(16) + '-' + n.toString(16);
  }
  const TUNING_KEY = 'ym2610AdpcmTuning'; // localStorage: { [sampleHash]: cps }
  // 毎回localStorageから読む(サンプル初出時とキャリブレーション時だけなので頻度は低い。
  // メモリキャッシュにすると開発者ツール等で消した設定が残り続けて紛らわしい)
  function getTuningMap() {
    try { return JSON.parse(global.localStorage.getItem(TUNING_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveTuningMap(map) {
    try { global.localStorage.setItem(TUNING_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  // ── 打楽器/音階の手動上書き ────────────────────────────────────────────
  // 「このサンプルは打楽器か、音階楽器か」はピッチ解析の信頼度(conf>=0.5)で自動判定して
  // いるが、外れる曲がある。ユーザーが耳で決めた指定をここへ集約する。
  // ★applyKindOverride を samplePitch() の中で conf に反映させることで、
  //   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換の4箇所が
  //   すべて自動的に追随する(判定の分岐を増やさない)。
  // キーはサンプル内容のハッシュ(チューニングと同じ)。ROM上のアドレスと違い、
  // 別のゲーム/別のリビジョンでも同じ音なら同じ指定が効く。
  const KIND_KEY = 'samplePitchKind'; // localStorage: { [sampleHash]: 'drum' | 'pitch' }
  function getKindMap() {
    try { return JSON.parse(global.localStorage.getItem(KIND_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveKindMap(map) {
    try { global.localStorage.setItem(KIND_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }
  /** samplePitch() の結果 r に手動指定を反映する(r.kindManual に指定内容を残す) */
  function applyKindOverride(r) {
    if (!r || !r.hash) return r;
    const k = getKindMap()[r.hash];
    if (k === 'drum') { r.conf = 0; r.kindManual = 'drum'; }
    else if (k === 'pitch' && r.cps > 0) { r.conf = 1; r.kindManual = 'pitch'; }
    else r.kindManual = null;
    return r;
  }
  /** 手動指定の設定/解除。kind: 'drum' | 'pitch' | null(=自動へ戻す) */
  function setKindOverride(hash, kind) {
    if (!hash) return;
    const map = getKindMap();
    if (kind === 'drum' || kind === 'pitch') map[hash] = kind; else delete map[hash];
    saveKindMap(map);
  }

  // 波形アイコン用の128点。cps>0(音程あり)なら持続部(先頭40%位置)から1周期を線形補間で切り出し、
  // 音程なし(ドラム等)ならサンプル全体を128区間に分け各区間の絶対値最大(符号付き)=概形。
  // どちらも最大絶対値で正規化(±1)。
  function makeSampleWave(pcm, cps) {
    const N = 128;
    const len = pcm.length;
    if (len < 8) return null;
    const out = new Float32Array(N);
    let mx = 1e-9;
    if (cps > 0) {
      const period = 1 / cps;
      let off = Math.floor(len * 0.4);
      if (off + period + 1 >= len) off = Math.max(0, len - period - 2);
      for (let k = 0; k < N; k++) {
        const pos = off + period * k / N;
        const i = Math.floor(pos), f = pos - i;
        const v = pcm[i] * (1 - f) + (pcm[Math.min(len - 1, i + 1)] || 0) * f;
        out[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
      }
    } else {
      for (let k = 0; k < N; k++) {
        const a = Math.floor(len * k / N), b = Math.max(a + 1, Math.floor(len * (k + 1) / N));
        let best = 0;
        for (let i = a; i < b; i++) if (Math.abs(pcm[i]) > Math.abs(best)) best = pcm[i];
        out[k] = best; if (Math.abs(best) > mx) mx = Math.abs(best);
      }
    }
    for (let k = 0; k < N; k++) out[k] /= mx;
    return out;
  }

  class YM2610Audio {
    /**
     * @param {number} [clock=8000000] - マスタークロック(サンプルレート=clock/144)
     * @param {{ym2610b?: boolean}} [opts] - ym2610b: YM2610B(FM 6ch全部が実チャンネル)
     */
    constructor(clock, opts) {
      this.clockHz = clock || 8000000;
      this.core = new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' });
      this.sampleRate = this.core.sampleRate;
      this.isB = !!(opts && opts.ym2610b);
      // 本クラスのFM1-n → YM2612コア(6ch)上のチャンネル番号
      this.coreCh = this.isB ? [0, 1, 2, 3, 4, 5] : [1, 2, 4, 5];
      this.numFm = this.coreCh.length;
      this.mute = new Array(this.numFm).fill(false);
      this.vol = new Array(this.numFm).fill(1);
      this.muteAdpcm = new Array(7).fill(false); // 0-5=ADPCM-A ch1-6, 6=ADPCM-B
      this.volAdpcm = new Array(7).fill(1);
      this.romA = null; this.romB = null;
      this._pitchCache = new Map(); // 'a:start:end' / 'b:start:end' → {cps, conf}(samplePitch)
      this.adpcmA = new AdpcmA(this);
      this.adpcmB = new AdpcmB(this);
      this.cyc = 0; this.cycA = 0;
      this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    // mute[]/vol[]をコアの6要素へ写す。ダミーch(YM2610の0,3)とDAC(6)は常時ミュート。
    syncMuteVol() {
      const c = this.core;
      for (let i = 0; i < 7; i++) c.mute[i] = true;
      for (let i = 0; i < this.numFm; i++) { c.mute[this.coreCh[i]] = !!this.mute[i]; c.vol[this.coreCh[i]] = this.vol[i]; }
    }

    reset() {
      this.core.reset(); this.adpcmA.reset(); this.adpcmB.reset();
      this.cyc = 0; this.cycA = 0; this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    /**
     * VGMデータブロック 0x82(ADPCM-A ROM)/0x83(ADPCM-B ROM)。
     * @param {'a'|'b'} kind  @param {number} romSize  @param {number} start  @param {Uint8Array} data
     */
    loadRom(kind, romSize, start, data) {
      const key = kind === 'b' ? 'romB' : 'romA';
      let rom = this[key];
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this[key] = n; }
      rom.set(data, start);
      this._pitchCache.clear(); // ROMが変わったら解析結果は無効
    }

    /**
     * サンプル(ROM上のstart..end-1バイト)の基本周期解析結果(キャッシュ)。表示専用。
     * @param {'a'|'b'} kind
     * @returns {{cps:number, conf:number, cpsAuto:number, confAuto:number, manual:boolean, hash:string, wave:Float32Array|null}|null}
     *   cps=1入力サンプルあたりの周期数(手動補正があればその値、conf=1)。cpsAuto/confAutoは自動検出値。
     *   wave=波形アイコン用128点(音程あり: 持続部の1周期 / 無し: サンプル全体の概形)
     */
    samplePitch(kind, start, end) {
      if (start === undefined || end === undefined || !(end > start)) return null;
      const key = kind + ':' + start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const rom = kind === 'b' ? this.romB : this.romA;
      if (!rom) return null;
      const pcm = this._decodeSample(kind, start, end);
      const auto = detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: sampleHash(rom, start, end), wave: null };
      // 手動キャリブレーション(localStorage、サンプル内容のハッシュがキーなので同じゲームの他トラックでも効く)
      const t = getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      // 打楽器/音階の手動上書きをconfへ反映(ロール/鍵盤/変換の4箇所がこの1点で追随する)
      applyKindOverride(r);
      r.wave = makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(kind, start, end) {
      const rom = kind === 'b' ? this.romB : this.romA;
      // 極端に長いサンプル(ADPCM-Bのループ曲データ等)は先頭部分だけ見る(解析コスト上限)
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES);
      return kind === 'b' ? decodeAdpcmB(rom, start, e) : decodeAdpcmA(rom, start, e);
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.kind + ':' + sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.kind, sample.start, sample.end);
    }

    /**
     * サンプルの手動ピッチ補正(表示専用)。cps=null で解除。localStorage に永続化し、
     * 同じ内容のサンプル(ハッシュ一致)なら別トラック/別セッションでも効く。
     */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const map = getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      saveTuningMap(map);
      r.wave = makeSampleWave(this._decodeSample(kind, start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }

    // レジスタ書込み(port 0/1)。SSG(port0 0x00-0x0F)は呼び出し側がAY8910Audioへ振り分ける前提
    // (渡ってきても弾く)。
    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      if (port === 0) {
        if (reg < 0x10) return;                              // SSG / I/Oポート
        if (reg < 0x1C) { this.adpcmB.write(reg - 0x10, val); return; } // ADPCM-B
        if (reg === 0x1C) return;                            // EOSフラグ制御(再生には無関係)
        if (reg < 0x20) return;
        if (reg === 0x2A || reg === 0x2B) return;            // YM2612のDAC。YM2610には無い
      } else if (reg < 0x30) {
        this.adpcmA.write(reg, val); return;                 // ADPCM-A
      }
      this.core.writeReg(port, reg, val);
    }

    clock() {
      this.core.clock();
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      // FMサンプル毎: ADPCM-B。3回に1回(EGサイクル): ADPCM-A
      this.adpcmB.clock();
      if (++this.cycA >= 3) { this.cycA = 0; this.adpcmA.clock(); }
      let l = 0, r = 0;
      const A = this.adpcmA;
      for (let i = 0; i < 6; i++) {
        if (this.muteAdpcm[i] || !A.ch[i].playing) continue;
        const v = A.value(i) * this.volAdpcm[i];
        if (A.panL(i)) l += v;
        if (A.panR(i)) r += v;
      }
      if (!this.muteAdpcm[6] && this.adpcmB.playing) {
        const v = this.adpcmB.value() * this.volAdpcm[6];
        if (this.adpcmB.panL()) l += v;
        if (this.adpcmB.panR()) r += v;
      }
      this.adpcmL = l * ADPCM_SCALE; this.adpcmR = r * ADPCM_SCALE;
    }
    mixSample() {
      const s = this.core.mixSample();
      return { left: s.left + this.adpcmL, right: s.right + this.adpcmR };
    }
    // 書込みキュー適用(clock()を回さない先読み/シーク経路用)
    flushWrites(collapse) { if (this.core.flushWrites) this.core.flushWrites(collapse); }
  }

  // 鍵盤表示用スナップショット: FMはYM2612版の6chから実チャンネルを抜き出す(形は同じ)。
  // adpcmA[6]/adpcmB: {active, vol(0-1), rawVol, rawVolMax, panL, panR, rate, pitchHz, pitchConf, ...}
  //   pitchHz/pitchConf: 鳴っているサンプルのピッチ解析(samplePitch)結果 × 現在の再生レート。
  //   conf<0.5 は表示側で音程なし扱い(ドラム等)。ADPCM-Aは音程レジスタが無いのでこれが唯一の音程情報、
  //   ADPCM-Bは refRate ベースの仮基準(下記)より優先して使う。
  Emu.snapshotYM2610 = function (chip, opt) {
    const s = Emu.snapshotYM2612(chip.core, opt);
    const A = chip.adpcmA, B = chip.adpcmB;
    const tl = (A.regs[0x01] & 0x3F);
    const adpcmA = [];
    const rateA = chip.sampleRate / 3;
    for (let i = 0; i < 6; i++) {
      const il = A.regs[0x08 + i] & 0x1F;
      const att = (il ^ 0x1F) + (tl ^ 0x3F); // 0=最大
      const vol = att >= 63 ? 0 : Math.max(0, 1 - att / 63);
      const c = A.ch[i];
      const p = c.seq ? chip.samplePitch('a', c.smpStart, c.smpEnd) : null;
      // seq/lenSec: clock()を回さない先読みキャプチャ(vgmPlayer.js captureVgmSongAsync)が、キーオン通番の
      // 変化とサンプル長から「鳴っている区間」を推定するために使う(ライブ表示は playing で足りる)
      adpcmA.push({ active: c.playing && vol > 0, vol, rawVol: il, rawVolMax: 31, panL: A.panL(i) ? 1 : 0, panR: A.panR(i) ? 1 : 0,
        rate: rateA, seq: c.seq, lenSec: A.lengthSeconds(i),
        pitchHz: p ? p.cps * rateA : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'a', start: c.smpStart, end: c.smpEnd } : null }); // 手動キャリブレーション用の同定情報
    }
    const lvl = B.regs[0x0B];
    const rateB = B.rate();
    const pb = B.seq ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
    const adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
      panL: B.panL() ? 1 : 0, panR: B.panR() ? 1 : 0, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
      pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual), sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
      waveData: pb ? pb.wave : null,
      sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
      // refRate: ピッチ解析が信頼できない時のフォールバック用。ADPCM-Bの再生レート(Delta-N由来)を
      // 鍵盤/ロールで疑似音程表示する際の基準(=C4扱い)。ADPCM-Bには「これが基準ピッチ」という
      // レジスタは無いので、同チップのADPCM-A固定レート(chip.sampleRate/3)を基準に採用した
      // (keyboard.js側の相対表示。絶対音名は目安)
      refRate: rateA };
    return { channels: chip.coreCh.map(i => s.channels[i]), adpcmA, adpcmB };
  };

  Emu.YM2610Audio = YM2610Audio;

  // サンプルピッチ解析ユーティリティの共有(GA20等、他のPCMチップからの流用。抽出器を複製しない)。
  // getTuningMap/saveTuningMap の localStorage キーはYM2610と共通('ym2610AdpcmTuning')だが、
  // キーはサンプル内容ハッシュなのでチップをまたいで共有しても衝突しない(むしろ同じサンプルなら
  // 同じ補正が効くのが望ましい)。
  // ループ区間の基本周期推定(qsound.jsで実証した「ループ因数分解方式」の共有版)。
  // ハードウェアループは継ぎ目なく繋がる=ループ長は基本周期の整数倍。k=2..64の lag=N/k で
  // 巡回自己相関(補間つき)を測り、最大相関の90%以上の中で最大のk(=最高周波数解釈)を採る。
  // 汎用detectCpsは探索上限(PITCH_MAX_LAG)を長周期ベースが超えるが、この方式は上限なし。
  // どのkも通らなければ「ループ全体=1周期」(単一周期シンセ波形。≤1024サンプルに限る)。
  // 返り値は detectCps 互換 {cps, conf} または null。
  function loopCps(one) {
    const N = one.length;
    if (N < 16) return null;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += one[i];
    mean /= N;
    const x = new Float32Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) { x[i] = one[i] - mean; e += x[i] * x[i]; }
    if (e < 1e-9) return null;
    let bestK = 0, bestCorr = 0;
    const cands = [];
    for (let k = 2; k <= 64; k++) {
      const lag = N / k;
      if (lag < 8) break;
      let acf = 0;
      for (let i = 0; i < N; i++) {
        const pos = (i + lag) % N;
        const j = Math.floor(pos), f = pos - j;
        const v = x[j] * (1 - f) + x[(j + 1) % N] * f;
        acf += x[i] * v;
      }
      const corr = acf / e;
      cands.push([k, corr]);
      if (corr > bestCorr) { bestCorr = corr; bestK = k; }
    }
    if (bestCorr >= 0.85) {
      for (const [k, corr] of cands) if (corr >= bestCorr * 0.9 && k > bestK) bestK = k;
      return { cps: bestK / N, conf: Math.min(1, bestCorr) };
    }
    if (N <= 1024) return { cps: 1 / N, conf: 0.75 };
    return null;
  }

  Emu.SamplePitchUtil = { detectCps, makeSampleWave, sampleHash, getTuningMap, saveTuningMap, loopCps,
                          getKindMap, saveKindMap, applyKindOverride, setKindOverride };

  // ── OPNファミリ共有(YM2608=ym2608.jsが流用) ─────────────────────────
  // AdpcmA(fixedAddr指定でYM2608内蔵リズムに使える)/AdpcmB(addrShift=5でYM2608 DELTA-T)/
  // デコーダ、そして表示用サンプルピッチ解析API一式。
  // attachSampleApi: YM2610Audioのピッチ解析メソッド群(this.romA/romB/_pitchCacheしか
  // 参照しない)を別チップのprototypeへそのまま移植する(実装の複製を作らない)。
  Emu.OpnAdpcm = {
    AdpcmA, AdpcmB, decodeAdpcmA, decodeAdpcmB, ADPCM_SCALE,
    attachSampleApi(proto) {
      // ★loadRom は上書きしない(2026-11-08): OPLAudio は自前の loadRom(romSize, start, data) を持ち、VGM の 0x88 ブロックは
      //   その形で呼ぶ。ここで (kind, romSize, start, data) の物に差し替えると data が undefined になり Y8950 の DELTA-T が落ちていた
      if (!proto.loadRom) proto.loadRom = YM2610Audio.prototype.loadRom;
      proto.samplePitch = YM2610Audio.prototype.samplePitch;
      proto._decodeSample = YM2610Audio.prototype._decodeSample;
      proto.samplePcm = YM2610Audio.prototype.samplePcm;
      proto.setSampleTuning = YM2610Audio.prototype.setSampleTuning;
      proto.setSampleKind = YM2610Audio.prototype.setSampleKind;
    }
  };
})(globalThis);

/*
 * OPL系FM音源エミュレータ — YM3526(OPL) / YM3812(OPL2) / Y8950(MSX-AUDIO) (VGM / KSS)
 * MML.Emu.OPLAudio
 *
 * 2オペレータFM×9ch、またはリズムモード(6メロディ+5打楽器)。EG(AR/DR/SL/RR、EGT=サステイン
 * 保持ビット、KSR)、KSL(キースケールレベル)、固定LFO(AM≈3.7Hz/VIB≈6.1Hz、深度は0xBDの
 * グローバルビット)、フィードバック、接続(CNT: 0=FM直列 1=加算)。モノラル出力。
 *  - YM3812(OPL2)のみ: 波形選択(WS 0-3: サイン/半サイン/絶対値/四半パルス、0x01 bit5で有効化)
 *  - Y8950のみ: ADPCM-B(DELTA-T 1ch)。ym2610.jsの共有クラス(Emu.OpnAdpcm.AdpcmB)を
 *    addrShift=5(YM2608と同じ32バイト単位)で流用し、Y8950レジスタ(0x07-0x12)を
 *    共有クラスのOPNA配置へ写像する。メモリはVGMデータブロック0x88、またはKSS(MSX-AUDIO)の
 *    データレジスタ(0x0F)経由のCPU書込み(REC|MEMDATAモード)で埋まる。
 *
 * 設計は ym2151.js(OPM)と同じ「dB単位のログサイン+EG」方式(EGレベル0..1023、1単位=
 * 0.09375dB、TL=6bit×8単位、振幅=2^(-att/64)、オペレータ出力±8192)。EG増分表/レート選択も
 * 同じOPNファミリ共通表(OPLのレート値は rate=4*R+RKS、EGクロックは毎サンプル=OPNの3倍速。
 * MAME fmopl.cと同じ時間スケール)。
 *
 * ★変調量の尺度(2026-09-07修正): モジュレータ→キャリアは出力>>1(±8192→±4096=サイン表
 *   1024点の4周期ぶん。MAME fmopl/Nuked-OPLLの「12bit出力をそのまま位相へ」と同じ深さ)、
 *   帰還は(直前2出力の和)>>(10-FB)(FB=7で±2048=2周期。Nuked-OPLLの「2出力の平均>>(7-FB)」
 *   =11bit出力で2周期、MAME fmopl の out<<(FB+7)>>16 と同じ)。以前は帰還が >>(9-FB) で
 *   実機の2倍の深さになっており、FB=7の音色(Bubble Bobble FM8等)が実機よりずっと
 *   ノイジーに崩れていた。ym2151.js(OPM)の >>(10-FB) と同じ値に揃えた。
 *
 * ★リズム(HH/SD/CYM)の位相ビット細工とノイズLFSRは、die解析済みの opllNuked.js
 *   (Nuked-OPLL。OPLLのリズム回路はOPL由来で同一)から式を移植:
 *     HH: サイン索引 = rm_bit<<9 | ((rm_bit^noise) ? 0xd0 : 0x34)
 *     SD: hh_bit8<<9 | ((hh_bit8^noise)<<8) / CYM: rm_bit<<9 | 0x100 / TOM,BD: 通常
 *     rm_bit = (hh2^hh7)|(hh3^tc5)|(tc3^tc5)、ノイズ=23bit LFSR(タップ14)
 *   ビブラートの8ステップ表(±f>>7/±f>>8)も同じ(OPLは0xBD bit6=深度で半減)。
 *   KSLも同じ回路(KSLTABLE - (8-block)*8)で、OPL2/OPL3系のビット解釈
 *   {0:off, 1:3dB/oct, 2:1.5dB/oct, 3:6dB/oct} を使う。
 *
 * 音程: F-Number(10bit)+Block。freq = fnum × 2^(block-1) × fs / 2^19、fs = clock/72
 * (3579545Hz → 49716Hz。OPLLと同じ)。A4=440Hz ≒ fnum 577 / block 4。
 *
 * ミュート添字(mute[]/vol[]): 0-8=メロディch、9-13=BD,SD,TOM,CYM,HH(opllNuked.jsの
 * MUTE_*と同じ並び)、14=ADPCM-B(Y8950)。リズムモード中のch7/ch8はスロット単位で
 * SD/HH/TOM/CYMに分離してミュートできる。
 *
 * 外部I/F: writeReg(reg,val) / readStatus()(Y8950: KSSのポート0xC0読出し用) /
 * clock()(マスタークロック毎、/72で1サンプル) / mixSample()(モノラル、数値) /
 * loadRom(romSize,start,data)(Y8950 DELTA-T、VGMデータブロック0x88) /
 * mute[15] / vol[15] / Emu.snapshotOPL(chip)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 9;
  const CYCLES_PER_SAMPLE = 72;
  const EG_MAX = 1023;
  const SIN_LEN = 1024;
  const SIN_MASK = SIN_LEN - 1;
  const PHASE_BITS = 20;
  const PHASE_MASK = (1 << PHASE_BITS) - 1;
  const PHASE_TO_SIN = PHASE_BITS - 10;

  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13, MUTE_ADPCM = 14;
  const NUM_MUTE = 15;

  // ── テーブル(ym2151.jsと同型) ──
  const SIN_ATT = new Uint16Array(SIN_LEN);
  const SIN_SIGN = new Int8Array(SIN_LEN);
  for (let i = 0; i < SIN_LEN; i++) {
    const s = Math.sin((i + 0.5) * 2 * Math.PI / SIN_LEN);
    SIN_SIGN[i] = s < 0 ? -1 : 1;
    const a = Math.abs(s);
    SIN_ATT[i] = a < 1e-6 ? EG_MAX : Math.min(EG_MAX, Math.round(-20 * Math.log10(a) / 0.09375));
  }
  const EXP_LEN = 4096;
  const EXP_TAB = new Float32Array(EXP_LEN);
  for (let i = 0; i < EXP_LEN; i++) EXP_TAB[i] = i >= EG_MAX ? 0 : 8192 * Math.pow(2, -i / 64);

  const MUL_TAB = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]; // ×2表現(0→0.5、11=10,13=12,14=15,15=15はOPL実機の丸め)
  const SL_TAB = new Uint16Array(16);
  for (let i = 0; i < 16; i++) SL_TAB[i] = i < 15 ? i * 32 : 992; // 3dB/step、15=93dB

  // KSL基礎表(opllNuked.js EG_KSLTABLEと同じ die 由来値)。索引=F-Number上位4bit
  const KSL_TAB = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
  // KSL設定 → 右シフト量(OPL2/OPL3系: 1=3dB/oct, 2=1.5dB/oct, 3=6dB/oct)
  const KSL_SHIFT = [31, 1, 2, 0];

  // EG増分表(OPN/OPM/OPL共通の一般値。ym2151.jsと同一)
  // ★値は MAME fmopl.cpp の eg_inc と同じ(GPL-2.0+, Copyright Jarek Burczynski, Tatsuyuki Satoh)。THIRD-PARTY-NOTICES.md 参照
  const EG_INC = [
    0,1,0,1,0,1,0,1,  0,1,0,1,1,1,0,1,  0,1,1,1,0,1,1,1,  0,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,  1,1,1,2,1,1,1,2,  1,2,1,2,1,2,1,2,  1,2,2,2,1,2,2,2,
    2,2,2,2,2,2,2,2,  2,2,2,4,2,2,2,4,  2,4,2,4,2,4,2,4,  2,4,4,4,2,4,4,4,
    4,4,4,4,4,4,4,4,  4,4,4,8,4,4,4,8,  4,8,4,8,4,8,4,8,  4,8,8,8,4,8,8,8,
    8,8,8,8,8,8,8,8,  16,16,16,16,16,16,16,16,  0,0,0,0,0,0,0,0
  ];
  const EG_SEL = new Uint8Array(64);
  const EG_SHIFT = new Uint8Array(64);
  for (let r = 0; r < 64; r++) {
    const rn = r >> 2, sub = r & 3;
    if (rn === 0) { EG_SEL[r] = sub < 2 ? 18 : 0; EG_SHIFT[r] = 11; continue; }
    if (rn === 1) { EG_SEL[r] = sub < 2 ? 0 : 2; EG_SHIFT[r] = 10; continue; }
    if (rn <= 11) { EG_SEL[r] = sub; EG_SHIFT[r] = 11 - rn; continue; }
    if (rn <= 14) { EG_SEL[r] = 4 + (rn - 12) * 4 + sub; EG_SHIFT[r] = 0; continue; }
    EG_SEL[r] = 16; EG_SHIFT[r] = 0;
  }

  // スロットレジスタオフセット(0x00-0x15、グループ8個中6個有効) → (ch, op)
  const SLOT_CH = new Int8Array(32).fill(-1);
  const SLOT_OP = new Int8Array(32);
  for (let s = 0; s < 0x16; s++) {
    const k = s & 7;
    if (k >= 6) continue;
    SLOT_CH[s] = (s >> 3) * 3 + (k % 3);
    SLOT_OP[s] = k < 3 ? 0 : 1;
  }

  const EG_OFF = 0, EG_REL = 1, EG_SUS = 2, EG_DEC = 3, EG_ATT = 4;

  class Slot {
    constructor() { this.reset(); }
    reset() {
      this.am = false; this.vib = false; this.egt = false; this.ksrFlag = false; this.mul = 2;
      this.ksl = 0; this.tl = 0;
      this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0;
      this.ws = 0;
      this.state = EG_OFF; this.volume = EG_MAX;
      this.phase = 0; this.inc = 0; this.rks = 0; this.kslAtt = 0;
      this.keySrc = 0; // bit0=メロディKON(0xB0 bit5) / bit1=リズム(0xBD)
      this.prev = [0, 0];
    }
    rate(r) { return r === 0 ? 0 : Math.min(63, 4 * r + this.rks); }
  }

  class Channel {
    constructor(idx) { this.idx = idx; this.slots = [new Slot(), new Slot()]; this.reset(); }
    reset() {
      for (const s of this.slots) s.reset();
      this.fnum = 0; this.block = 0; this.kcode = 0; this.fb = 0; this.cnt = 0; this.kon = false;
    }
  }

  // Y8950 ADPCMレジスタ → 共有AdpcmB(OPNA配置)のレジスタ番号
  const Y8950_DT_MAP = { 0x07: 0x00, 0x08: 0x01, 0x09: 0x02, 0x0A: 0x03, 0x0B: 0x04, 0x0C: 0x05, 0x10: 0x09, 0x11: 0x0A, 0x12: 0x0B };
  const Y8950_RAM_SIZE = 256 * 1024; // 仕様上の最大(MSX-AUDIOカートは32KB/256KB)

  class OPLAudio {
    /**
     * @param {number} [clock=3579545] - マスタークロック(サンプルレート=clock/72)
     * @param {{type?: 'ym3526'|'ym3812'|'y8950'}} [opts]
     */
    constructor(clock, opts) {
      this.clockHz = clock || 3579545;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.type = (opts && opts.type) || 'ym3812';
      this.hasWave = this.type === 'ym3812';
      this.hasAdpcm = this.type === 'y8950';
      this.mute = new Array(NUM_MUTE).fill(false);
      this.vol = new Array(NUM_MUTE).fill(1);
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) this.channels.push(new Channel(i));
      if (this.hasAdpcm) {
        this.romB = null; // DELTA-Tメモリ(VGM: ROMブロック / KSS: CPU書込みRAM)
        this._pitchCache = new Map();
        this.adpcmB = new Emu.OpnAdpcm.AdpcmB(this, { addrShift: 5, forceExternal: false });
        this._dtWriteAddr = 0;
      }
      this._init();
    }
    _init() {
      for (const c of this.channels) c.reset();
      this.regs = new Uint8Array(256);
      this.cyc = 0;
      this.egCnt = 0;
      this.wse = false;       // 0x01 bit5(OPL2波形選択有効)
      this.nts = false;       // 0x08 bit6(キーボードスプリット)
      this.rhythm = 0;        // 0xBD生値(bit5=リズムモード, bit4-0=BD,SD,TOM,TC,HH)
      this.amDeep = false; this.vibDeep = false;
      this.lfoCnt = 0;        // サンプルカウンタ(vib=>>10で8ステップ、am=>>6で210ステップ三角)
      this.amStep = 0; this.amDir = 0; this.amVal = 0;
      this.noise = 1;         // 23bit LFSR
      this.adpcmOut = 0;
      this.last = 0;
      this._latch = 0;
      if (this.hasAdpcm) { this.adpcmB.reset(); this._dtWriteAddr = 0; }
    }
    reset() { this._init(); }

    /** Y8950 DELTA-Tメモリ(VGMデータブロック0x88) */
    loadRom(romSize, start, data) {
      if (!this.hasAdpcm) return;
      let rom = this.romB;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.romB = n; }
      rom.set(data, start);
      if (this._pitchCache) this._pitchCache.clear();
    }

    /** ステータス読出し(Y8950/KSSのポート0xC0)。BUF_RDY(bit3)常時セット、EOS(bit4)=再生終了 */
    readStatus() {
      if (!this.hasAdpcm) return 0x06; // OPL: タイマフラグ無し(未実装)、bit1-2は常に1を返す実装が多い
      const eos = this.adpcmB.seq > 0 && !this.adpcmB.playing;
      return 0x08 | (eos ? 0x10 : 0);
    }

    // ── KSS(MSX-AUDIO)用のI/Oポートインターフェース(kssBus.js chips.opl) ──
    /** port 0xC0=アドレスラッチ / 0xC1=データ */
    ioWrite(port, value) {
      if ((port & 1) === 0) this._latch = value & 0xFF;
      else this.writeReg(this._latch || 0, value);
    }
    /** データポート読出し(レジスタ影を返す。ADPCMメモリ読出しモードは未実装) */
    readData() { return this.regs[this._latch || 0]; }

    writeReg(reg, val) {
      reg &= 0xFF; val &= 0xFF;
      this.regs[reg] = val;
      if (reg < 0x20) {
        if (reg === 0x01) { this.wse = this.hasWave && !!(val & 0x20); return; }
        if (reg === 0x08) { this.nts = !!(val & 0x40); return; } // CSMは未実装(実曲で未使用)
        if (this.hasAdpcm) {
          if (reg === 0x0F) { this._dtWriteData(val); return; }
          const m = Y8950_DT_MAP[reg];
          if (m !== undefined) {
            // 0x08(control2)はY8950にパンが無いので両ch ONを強制(共有クラスのビット位置合わせ)
            if (m === 0x01) val = (val & 0x3F) | 0xC0;
            if (m === 0x00) {
              // REC|MEMDATA=CPU書込みモード: 再生を止めて書込みポインタを開始アドレスへ
              if ((val & 0x60) === 0x60) {
                this.adpcmB.regs[0x00] = val;
                this.adpcmB.playing = false;
                this._dtWriteAddr = (this.adpcmB.regs[0x02] | (this.adpcmB.regs[0x03] << 8)) << 5;
                return;
              }
            }
            this.adpcmB.write(m, val);
            return;
          }
          if (reg <= 0x19) return; // プリスケール/DAC/IOポートは未実装
        }
        return;
      }
      if (reg === 0xBD) {
        const prev = this.rhythm;
        this.rhythm = val;
        this.amDeep = !!(val & 0x80); this.vibDeep = !!(val & 0x40);
        this._rhythmKeys(prev, val);
        return;
      }
      if (reg >= 0xA0 && reg <= 0xA8) { const c = this.channels[reg - 0xA0]; c.fnum = (c.fnum & 0x300) | val; this._refreshCh(c); return; }
      if (reg >= 0xB0 && reg <= 0xB8) {
        const c = this.channels[reg - 0xB0];
        c.fnum = (c.fnum & 0xFF) | ((val & 3) << 8);
        c.block = (val >> 2) & 7;
        this._refreshCh(c);
        const on = !!(val & 0x20);
        if (on !== c.kon) {
          c.kon = on;
          this._key(c.slots[0], 1, on);
          this._key(c.slots[1], 1, on);
        }
        return;
      }
      if (reg >= 0xC0 && reg <= 0xC8) { const c = this.channels[reg - 0xC0]; c.fb = (val >> 1) & 7; c.cnt = val & 1; return; }
      const si = reg & 0x1F;
      const ch = SLOT_CH[si];
      if (ch < 0) return;
      const s = this.channels[ch].slots[SLOT_OP[si]];
      switch (reg & 0xE0) {
        case 0x20:
          s.am = !!(val & 0x80); s.vib = !!(val & 0x40); s.egt = !!(val & 0x20); s.ksrFlag = !!(val & 0x10);
          s.mul = MUL_TAB[val & 0x0F];
          this._refreshCh(this.channels[ch]);
          break;
        case 0x40: s.ksl = (val >> 6) & 3; s.tl = (val & 0x3F) << 3; this._refreshCh(this.channels[ch]); break;
        case 0x60: s.ar = (val >> 4) & 15; s.dr = val & 15; break;
        case 0x80: s.sl = SL_TAB[(val >> 4) & 15]; s.rr = val & 15; break;
        case 0xE0: if (this.hasWave) s.ws = val & 3; break;
      }
    }

    // 位相増分・キースケールレート・KSL減衰を再計算
    _refreshCh(c) {
      c.kcode = (c.block << 1) | (this.nts ? (c.fnum >> 8) & 1 : (c.fnum >> 9) & 1);
      const kslBase = Math.max(0, KSL_TAB[c.fnum >> 6] - ((8 - c.block) << 3)); // 0..64(0.375dB×2単位)
      for (const s of c.slots) {
        s.rks = s.ksrFlag ? c.kcode : (c.kcode >> 2);
        // (kslBase<<1)>>shift は0.375dB単位 → 家内単位(0.09375dB)へ×4
        s.kslAtt = s.ksl ? (((kslBase << 1) >> KSL_SHIFT[s.ksl]) << 2) : 0;
        // incはビブラート適用込みで毎サンプル計算する(_slotInc)ので、素の値だけ持つ
      }
    }

    // ビブラート込みの位相増分。f2 = fnum<<1 の領域で8ステップ表(opllNukedと同じ)を適用
    _slotInc(c, s) {
      let f2 = c.fnum << 1;
      if (s.vib) {
        const step = (this.lfoCnt >> 10) & 7;
        const d = this.vibDeep ? 0 : 1; // 浅い時は半分
        switch (step) {
          case 1: case 3: f2 += f2 >> (8 + d); break;
          case 2: f2 += f2 >> (7 + d); break;
          case 5: case 7: f2 -= f2 >> (8 + d); break;
          case 6: f2 -= f2 >> (7 + d); break;
        }
      }
      return ((((f2 << c.block) >> 1) * s.mul) >> 1) & PHASE_MASK;
    }

    // キーオン/オフ(src: 1=メロディKON, 2=リズム)
    _key(s, src, on) {
      const before = s.keySrc;
      if (on) s.keySrc |= src; else s.keySrc &= ~src;
      if (before === 0 && s.keySrc) {
        s.phase = 0;
        if (s.rate(s.ar) >= 62) { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
        else { s.state = EG_ATT; }
      } else if (before && s.keySrc === 0) {
        if (s.state > EG_REL) s.state = EG_REL;
      }
    }

    // 0xBDのリズムキービット変化を各スロットへ(BD=ch6両op、HH=ch7 mod、SD=ch7 car、
    // TOM=ch8 mod、CYM(TC)=ch8 car)
    _rhythmKeys(prev, val) {
      const en = !!(val & 0x20);
      const key = (bit, slots) => {
        const on = en && !!(val & bit);
        for (const s of slots) this._key(s, 2, on);
      };
      key(0x10, [this.channels[6].slots[0], this.channels[6].slots[1]]); // BD
      key(0x01, [this.channels[7].slots[0]]);                            // HH
      key(0x08, [this.channels[7].slots[1]]);                            // SD
      key(0x04, [this.channels[8].slots[0]]);                            // TOM
      key(0x02, [this.channels[8].slots[1]]);                            // CYM
    }

    // Y8950: データレジスタ(0x0F)へのCPU書込み(REC|MEMDATAモードでメモリへ格納)
    _dtWriteData(v) {
      if ((this.adpcmB.regs[0x00] & 0x60) !== 0x60) return;
      if (!this.romB || !(this.romB instanceof Uint8Array) || this.romB.length < Y8950_RAM_SIZE) {
        const n = new Uint8Array(Y8950_RAM_SIZE);
        if (this.romB) n.set(this.romB.subarray(0, Math.min(this.romB.length, n.length)), 0);
        this.romB = n;
      }
      this.romB[this._dtWriteAddr & (Y8950_RAM_SIZE - 1)] = v;
      this._dtWriteAddr++;
      if (this._pitchCache) this._pitchCache.clear();
    }

    // ── EG(毎サンプル。OPLのEGクロックはfs) ──
    _advanceEg() {
      const cnt = ++this.egCnt;
      for (const c of this.channels) {
        for (const s of c.slots) {
          switch (s.state) {
            case EG_ATT: {
              const r = s.rate(s.ar);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                const inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                s.volume += (~s.volume * inc) >> 3;
                if (s.volume <= 0) { s.volume = 0; s.state = (s.sl === 0 && s.egt) ? EG_SUS : EG_DEC; }
              }
              break;
            }
            case EG_DEC: {
              const r = s.rate(s.dr);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= s.sl) {
                  s.volume = Math.min(s.volume, EG_MAX);
                  // EGT=1: SLで保持(キーオフでEG_RELへ) / EGT=0: SL以降もRRレートで減衰(打楽器型。
                  // EG_RELはキーオン状態と無関係に進むのでそのまま流用できる)
                  s.state = s.egt ? EG_SUS : EG_REL;
                }
              }
              break;
            }
            case EG_SUS:
              break; // EGT=1はキーオフまで保持
            case EG_REL: {
              const r = s.rate(s.rr);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= EG_MAX) { s.volume = EG_MAX; s.state = EG_OFF; }
              }
              break;
            }
          }
        }
      }
    }

    // ── LFO(AM: 210ステップ三角×64サンプル≈3.7Hz / VIB: 8ステップ×1024サンプル≈6.1Hz) ──
    _advanceLfo() {
      this.lfoCnt = (this.lfoCnt + 1) & 0xFFFF;
      if ((this.lfoCnt & 63) === 0) {
        // 三角波 0..26(0.1875dB単位、MAME fmopl同様)を0.5ずつ上下(105ステップ×2)
        if (this.amDir === 0) { if (++this.amStep >= 105) this.amDir = 1; }
        else { if (--this.amStep <= 0) this.amDir = 0; }
        this.amVal = (this.amStep * 26 / 105) | 0;
      }
      // ノイズLFSR(23bit、タップ14。opllNuked/実チップと同型)。毎サンプル1シフト
      let nbit = (this.noise ^ (this.noise >>> 14)) & 1;
      nbit |= this.noise === 0 ? 1 : 0;
      this.noise = ((nbit << 22) | (this.noise >>> 1)) >>> 0;
    }
    _amAtt() { // 家内単位(0.09375dB)
      const v = this.amDeep ? this.amVal : (this.amVal >> 2);
      return v << 1; // 0.1875dB → ×2
    }

    // ── オペレータ出力(波形選択込み) ──
    _opOut(s, att, modIndex) {
      const idx = ((s.phase >> PHASE_TO_SIN) + modIndex) & SIN_MASK;
      return this._wave(s.ws, idx, att);
    }
    _wave(ws, idx, att) {
      if (!this.wse || ws === 0) {
        const a = att + SIN_ATT[idx];
        return a >= EXP_LEN ? 0 : SIN_SIGN[idx] * EXP_TAB[a];
      }
      switch (ws) {
        case 1: { // 半サイン(後半無音)
          if (idx & 512) return 0;
          const a = att + SIN_ATT[idx];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
        case 2: { // 絶対値サイン
          const a = att + SIN_ATT[idx & 511];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
        default: { // 四半パルス(各半周期の前半のみ)
          if (idx & 256) return 0;
          const a = att + SIN_ATT[idx & 255];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
      }
    }
    _egOut(s) { return Math.min(EG_MAX, s.volume + s.tl + s.kslAtt + (s.am ? this._amAtt() : 0)); }

    // リズム用: スロットの位相からサイン索引(HH/SD/CYMは実機の位相ビット細工)
    _rhythmIndex(kind, hhPhase, tcPhase) {
      const hh2 = (hhPhase >> (2 + PHASE_TO_SIN)) & 1, hh3 = (hhPhase >> (3 + PHASE_TO_SIN)) & 1;
      const hh7 = (hhPhase >> (7 + PHASE_TO_SIN)) & 1, hh8 = (hhPhase >> (8 + PHASE_TO_SIN)) & 1;
      const tc3 = (tcPhase >> (3 + PHASE_TO_SIN)) & 1, tc5 = (tcPhase >> (5 + PHASE_TO_SIN)) & 1;
      const rmBit = (hh2 ^ hh7) | (hh3 ^ tc5) | (tc3 ^ tc5);
      const nz = this.noise & 1;
      if (kind === 'hh') return ((rmBit << 9) | ((rmBit ^ nz) ? 0xd0 : 0x34)) & SIN_MASK;
      if (kind === 'sd') return ((hh8 << 9) | ((hh8 ^ nz) << 8)) & SIN_MASK;
      return ((rmBit << 9) | 0x100) & SIN_MASK; // cym(TC)
    }

    _calcSample() {
      this._advanceEg();
      this._advanceLfo();
      const rhythmOn = !!(this.rhythm & 0x20);
      let out = 0;
      // 位相を全スロット進める(進める前の値で今サンプルを計算)
      const phases = [];
      for (const c of this.channels) {
        for (const s of c.slots) {
          phases.push(s.phase);
          s.phase = (s.phase + this._slotInc(c, s)) & PHASE_MASK;
        }
      }
      const melodyN = rhythmOn ? 6 : 9;
      for (let i = 0; i < melodyN; i++) {
        const c = this.channels[i];
        const [m, cr] = c.slots;
        const fbIn = c.fb ? ((m.prev[0] + m.prev[1]) >> (10 - c.fb)) : 0;
        const om = this._opOut(m, this._egOut(m), fbIn);
        m.prev[0] = m.prev[1]; m.prev[1] = om;
        let o;
        if (c.cnt) o = om + this._opOut(cr, this._egOut(cr), 0);
        else o = this._opOut(cr, this._egOut(cr), om >> 1);
        if (!this.mute[i]) out += o * this.vol[i];
      }
      if (rhythmOn) {
        const ch6 = this.channels[6], ch7 = this.channels[7], ch8 = this.channels[8];
        const hhPhase = phases[7 * 2], tcPhase = phases[8 * 2 + 1];
        // BD: 通常の2op FM(×2)
        {
          const [m, cr] = ch6.slots;
          const fbIn = ch6.fb ? ((m.prev[0] + m.prev[1]) >> (10 - ch6.fb)) : 0;
          const om = this._opOut(m, this._egOut(m), fbIn);
          m.prev[0] = m.prev[1]; m.prev[1] = om;
          const o = ch6.cnt ? this._opOut(cr, this._egOut(cr), 0) : this._opOut(cr, this._egOut(cr), om >> 1);
          if (!this.mute[MUTE_BD]) out += 2 * o * this.vol[MUTE_BD];
        }
        // HH(ch7 mod) / SD(ch7 car) / TOM(ch8 mod) / CYM(ch8 car): 単オペ×2
        const one = (s, idx) => { const a = this._egOut(s); return this._wave(0, idx, a); };
        {
          const s = ch7.slots[0];
          const o = one(s, this._rhythmIndex('hh', hhPhase, tcPhase));
          if (!this.mute[MUTE_HH]) out += 2 * o * this.vol[MUTE_HH];
        }
        {
          const s = ch7.slots[1];
          const o = one(s, this._rhythmIndex('sd', hhPhase, tcPhase));
          if (!this.mute[MUTE_SD]) out += 2 * o * this.vol[MUTE_SD];
        }
        {
          const s = ch8.slots[0];
          const o = one(s, (phases[8 * 2] >> PHASE_TO_SIN) & SIN_MASK);
          if (!this.mute[MUTE_TOM]) out += 2 * o * this.vol[MUTE_TOM];
        }
        {
          const s = ch8.slots[1];
          const o = one(s, this._rhythmIndex('cym', hhPhase, tcPhase));
          if (!this.mute[MUTE_CYM]) out += 2 * o * this.vol[MUTE_CYM];
        }
      }
      // ADPCM-B(Y8950): FMサンプルと同レートでクロック
      if (this.hasAdpcm) {
        this.adpcmB.clock();
        this.adpcmOut = (!this.mute[MUTE_ADPCM] && this.adpcmB.playing)
          ? this.adpcmB.value() * this.vol[MUTE_ADPCM] * (8192 / 16384) : 0;
      }
      // 9ch合算を±1.0程度へ(ym2151の按分と同じ感覚)
      this.last = (out + this.adpcmOut) / (8192 * 6);
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return this.last; }
  }

  // 鍵盤表示の波形列/大波形用: いまのEG状態・波形選択(WS)・接続・帰還で2opを定常状態として
  // 1周期(キャリア基準128点)合成する(ym2151.js snapshot の簡易合成と同じ考え方)。
  // ★これが無いと鍵盤の波形アイコンが汎用FMアイコン(=サイン波)になり、YM3812の波形選択も
  //   モジュレーションも見えず「波形が全部サイン波」に見える(2026-09-07)
  function synthOplWave(chip, c) {
    const N = 128;
    const [m, cr] = c.slots;
    const wave = new Array(N).fill(0);
    const ratio = (m.mul || 1) / (cr.mul || 1);
    const attM = chip._egOut(m), attC = chip._egOut(cr);
    let p0 = 0, p1 = 0, mx = 1e-6;
    // 帰還を定常化するため2周期回して後半だけ採る
    for (let n = 0; n < 2 * N; n++) {
      const k = n % N;
      const phm = Math.round(k / N * SIN_LEN * ratio) & SIN_MASK;
      const phc = Math.round(k / N * SIN_LEN) & SIN_MASK;
      const fbIn = c.fb ? ((p0 + p1) >> (10 - c.fb)) : 0;
      const om = chip._wave(m.ws, (phm + fbIn) & SIN_MASK, attM);
      p0 = p1; p1 = om;
      const v = c.cnt ? om + chip._wave(cr.ws, phc, attC) : chip._wave(cr.ws, (phc + (om >> 1)) & SIN_MASK, attC);
      if (n >= N) { wave[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v); }
    }
    for (let k = 0; k < N; k++) wave[k] /= mx;
    return wave;
  }

  // ── 鍵盤表示用スナップショット ──
  // channels[9]: { freq, vol, rawVol, active, keyOn, tlVol, patch, waveData } + rhythm行(rhythmOn時):
  // rhythm: { on, bd:{...}, sd, tom, cym, hh } 各 { keyOn, vol, freq(TOM/HH/SDはch7/8のfnum由来) }
  // opt.skipWave=true で waveData(表示専用の合成波形128点)を作らない(先読みキャプチャ向け)
  Emu.snapshotOPL = function (chip, opt) {
    const skipWave = !!(opt && opt.skipWave);
    const out = { channels: [], rhythm: null };
    const rhythmOn = !!(chip.rhythm & 0x20);
    const melodyN = rhythmOn ? 6 : 9;
    const freqOf = (c, s) => c.fnum > 0 ? c.fnum * Math.pow(2, c.block - 1) * chip.sampleRate / (1 << 19) * (s.mul / 2) : 0;
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.channels[i];
      const cr = c.slots[1];
      const inMelody = i < melodyN;
      const carAtt = Math.min(EG_MAX, cr.volume + cr.tl);
      const modS = c.slots[0];
      const anyOn = inMelody && (cr.state !== EG_OFF || (c.cnt === 1 && modS.state !== EG_OFF));
      const vol = anyOn ? Math.max(0, 1 - carAtt / EG_MAX) : 0;
      const tlVol = Math.max(0, 1 - Math.min(504, cr.tl) / 504);
      const freq = freqOf(c, cr);
      const active = anyOn && vol > 0.02 && freq > 0;
      out.channels.push({
        freq, vol, rawVol: Math.round(vol * 15), active, keyOn: inMelody && c.kon, tlVol,
        panL: 1, panR: 1,
        waveData: (active && !skipWave) ? synthOplWave(chip, c) : null,
        patch: Emu.decodeOplPatch(chip.regs, i, chip.hasWave)
      });
    }
    if (rhythmOn) {
      const r = chip.rhythm;
      // freqSlot: 音程表示に使うスロット(BD=ch6キャリア、TOM=ch8モジュレータ)。SD/CYM/HHは音程なし
      const drum = (slots, bit, c, freqSlot) => {
        let att = EG_MAX;
        let on = false;
        for (const s of slots) { if (s.state !== EG_OFF) { on = true; att = Math.min(att, Math.min(EG_MAX, s.volume + s.tl)); } }
        return { keyOn: !!(r & bit), active: on && att < EG_MAX - 16, vol: on ? Math.max(0, 1 - att / EG_MAX) : 0,
                 freq: c ? freqOf(c, freqSlot) : 0 };
      };
      const ch6 = chip.channels[6], ch7 = chip.channels[7], ch8 = chip.channels[8];
      out.rhythm = {
        on: true,
        bd: drum(ch6.slots, 0x10, ch6, ch6.slots[1]),
        hh: drum([ch7.slots[0]], 0x01, null, null),
        sd: drum([ch7.slots[1]], 0x08, null, null),
        tom: drum([ch8.slots[0]], 0x04, ch8, ch8.slots[0]),
        cym: drum([ch8.slots[1]], 0x02, null, null)
      };
    }
    if (chip.hasAdpcm) {
      const B = chip.adpcmB;
      const lvl = B.regs[0x0B];
      const rateB = B.rate();
      const pb = (B.seq && chip.samplePitch) ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
      out.adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
        panL: 1, panR: 1, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
        pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual),
        sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
        waveData: pb ? pb.wave : null,
        sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
        refRate: chip.sampleRate / 3 };
    }
    return out;
  };

  // レジスタ影から2op音色を取り出す。鍵盤の音色表示は既存のOPLL書式(formatOpllPatch)を
  // 流用するため type:'opll' 互換の形で返す(PM=VIB, EG=EGT, KR=KSR, KL=KSL, WF=半波近似
  // (OPL2のWS1-3を1bitへ落とす)。CNT=1(加算接続)とWSの2bit値はOPLLに表現が無いので
  // 表示上は落ちる。inst=0は「ユーザー音色」表示のため)。
  Emu.decodeOplPatch = function (regs, ch, hasWave) {
    const so = [(ch % 3) + ((ch / 3) | 0) * 8, (ch % 3) + 3 + ((ch / 3) | 0) * 8];
    const wse = hasWave && !!(regs[0x01] & 0x20);
    const op = (s) => ({
      AM: (regs[0x20 + s] >> 7) & 1, PM: (regs[0x20 + s] >> 6) & 1, EG: (regs[0x20 + s] >> 5) & 1,
      KR: (regs[0x20 + s] >> 4) & 1, ML: regs[0x20 + s] & 15,
      KL: (regs[0x40 + s] >> 6) & 3, TL: regs[0x40 + s] & 0x3F,
      AR: (regs[0x60 + s] >> 4) & 15, DR: regs[0x60 + s] & 15,
      SL: (regs[0x80 + s] >> 4) & 15, RR: regs[0x80 + s] & 15,
      WF: (wse && (regs[0xE0 + s] & 3) >= 1) ? 1 : 0,
      FB: (regs[0xC0 + ch] >> 1) & 7
    });
    return { type: 'opll', inst: 0, cnt: regs[0xC0 + ch] & 1, mod: op(so[0]), car: op(so[1]) };
  };

  // 表示用サンプルピッチ解析API(Y8950 ADPCM-B、romB/_pitchCacheのみ参照)
  if (Emu.OpnAdpcm && Emu.OpnAdpcm.attachSampleApi) Emu.OpnAdpcm.attachSampleApi(OPLAudio.prototype);

  Emu.OPL_MUTE = { BD: MUTE_BD, SD: MUTE_SD, TOM: MUTE_TOM, CYM: MUTE_CYM, HH: MUTE_HH, ADPCM: MUTE_ADPCM, NUM: NUM_MUTE };
  Emu.OPLAudio = OPLAudio;
})(globalThis);

/*
 * コナミ「牌の魔術師」カートリッジ内蔵の 8bit D/A
 * MML.Emu.MajutsushiDAC
 *
 * メモリ 0x5000-0x5FFF への書込み値(符号なし8bit、0x80=中点)がそのまま出力電圧になる。
 * ゲームは PLAY の中で DI したまま 4bit 差分符号を展開し、DJNZ の空ループで間隔を取りながら
 * LD (5000h),A を連打してしゃべる(割込みは使わない)。
 *
 * 資料(KSS の D/A はこの3つしか見当たらない):
 *   - libkss kssxspec.md: device flag の bit3-4 = 2 が "Majutushi D/A"。iomap.md: 5000-5FFFH 8bit D/A port
 *   - libkss vm.c memwrite: DA8 >>= 1; DA8 += (d - 0x80) << 3 を SCC の出力に足す
 *     (定常値 16×(d-0x80) ≒ SCC 1ch の最大 15×127 と同程度)
 *   - openMSX RomMajutsushi.cc: Konami マッパー+DAC、0x5000-0x5FFF の書込みは DAC へ(ROM には書かない)。
 *     DACSound8U は value-0x80 をそのまま出す(零次ホールド)
 * 出力は openMSX と同じ零次ホールド。libkss の「書込みごとに半分へ減衰」は書込み間隔で特性が
 * 変わる近似なので真似しない。振幅は libkss の比率(SCC 1ch 最大と同程度)を sccAudio.js の
 * スケール(1ch 最大 ≒ 0.186)へ写して 0.2/128 とした。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const GAIN = 0.2 / 128;

  class MajutsushiDAC {
    constructor() {
      this.value = 0x80;
      this.mute = [false];
      this.vol = [1];
      this.writes = 0;  // 書込み回数(鍵盤表示の「鳴っているか」判定用。snapshotMajutsushiDac 参照)
      this.peak = 0;    // 前回スナップショット以降の最大振幅 |value-0x80|
      this._snapWrites = 0;
    }
    reset() { this.value = 0x80; this.writes = 0; this.peak = 0; this._snapWrites = 0; }
    write(value) {
      this.value = value & 0xFF;
      this.writes++;
      const a = Math.abs(this.value - 0x80);
      if (a > this.peak) this.peak = a;
    }
    clock() {}
    mixSample() {
      if (this.mute[0]) return 0;
      return (this.value - 0x80) * GAIN * this.vol[0];
    }
  }

  // DAC の書込みアドレスか(KssBus と再生側の振り分けで共用)
  MajutsushiDAC.isDacAddr = (addr) => addr >= 0x5000 && addr <= 0x5FFF;

  // 鍵盤表示用スナップショット(KDA行)。★呼ぶたびに「前回からの書込み有無」と最大振幅を消費する
  // (鍵盤の描画ループから1フレーム1回だけ呼ぶ前提)。D/A は最後に書いた値を保持し続けるので、
  // 値そのものでは鳴り終わりが分からない。書込みが続いている間だけ active にする
  Emu.snapshotMajutsushiDac = function (chip) {
    const active = chip.writes !== chip._snapWrites;
    chip._snapWrites = chip.writes;
    const peak = chip.peak;
    chip.peak = 0;
    return { level: chip.value, vol: active ? Math.min(1, peak / 128) : 0, active };
  };

  Emu.MajutsushiDAC = MajutsushiDAC;
})(globalThis);

/*
 * MSX カートリッジ(ROM とメガ ROM マッパー) — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md §3.3、段階 7a/7b)
 * MML.Emu.MsxCartridge
 *
 * .rom にはヘッダが無いので、種別は (1) 呼び手の指定(手動上書き/辞書)→ (2) guessType() の発見的手法で決める。
 * guessType は openMSX の RomInfo::guessRomType と同じ考え方: ROM 全体を走査して「LD (nn),A」(0x32 lo hi)の
 * 書き込み先がどのバンク切替アドレスかを数え、種別ごとに採点する(ここでは要点だけ移植した近似。ASCII8 と
 * Konami の取り違えが定番なので、外れたら画面の ⚙ で手動指定する前提)。
 *
 * 種別(8K ページ単位の参照張り替え。kssBus.js と同じく mem へコピーしない):
 *   plain      : 64K 以下の素の ROM。'AB' ヘッダの INIT 番地で置き場所(0x4000 か 0x8000)を決め、8K/16K は 64K 空間に鏡像
 *   konami     : Konami(SCC 無し)。8K バンク。0x4000 固定(バンク 0)、レジスタ 0x6000/0x8000/0xA000 → 0x6000/0x8000/0xA000
 *   konamiScc  : Konami SCC。8K バンク。レジスタ 0x5000/0x7000/0x9000/0xB000 → 0x4000/0x6000/0x8000/0xA000。
 *                0x9000 のバンクが 0x3F のとき 0x9800-0x9FFF に SCC(sccAudio.js、classic 配置)
 *   konamiSccI : Konami SCC-I(サウンドカートリッジ。7b): 128K RAM を 8K×16 バンクで konamiScc と同じレジスタで切り替える。
 *                モードレジスタ 0xBFFE/0xBFFF: bit5=SCC+ 配置(0xB800-0xBFFF、0xB000 のバンク値 bit7 で窓が開く)、
 *                bit4=全バンク RAM 書き込み可、bit0-2=窓 0x4000/0x6000/0x8000 の RAM 書き込み可(書き込み可の窓では
 *                バンクレジスタも SCC も書けず RAM に入る。openMSX SCCPlusCart と同じ)。rom を渡すと RAM の初期内容になる
 *   konamiDac  : 牌の魔術師: konami マッパー+0x5000-0x5FFF に 8bit D/A(expansion/majutsushiDac.js。本体が opts.dac で渡す)。
 *                発見的判定では konami に見えるので手動指定(辞書)で選ぶ
 *   ascii8     : ASCII 8K。レジスタ 0x6000/0x6800/0x7000/0x7800 → 0x4000/0x6000/0x8000/0xA000
 *   ascii16    : ASCII 16K。レジスタ 0x6000/0x7000 → 0x4000/0x8000(16K バンク)
 *   SRAM 付き(ASCII8/16 SRAM、Game Master 2、Koei)、R-Type、Cross Blaim は 7c。
 *
 * 音源の書き込みは onWrite(kind, addr, value) で本体へ知らせる(kind 'scc' はメモリ番地、'dac' は 0x5000 台の番地)。
 * 読み出し: read(addr) は 0x0000-0xFFFF のどこでも呼ばれうる(スロットに挿さった状態)。ROM の無い所は 0xFF。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PAGE = 0x2000;
  const EMPTY = new Uint8Array(PAGE).fill(0xFF);
  const SCCI_RAM = 0x20000; // SCC-I の RAM(128K)

  // SRAM 付き(7c): ascii8Sram(ASCII8+SRAM 8K。バンク値の「ROM のバンク数の次のビット」が立つと SRAM。openMSX RomAscii8_8)、
  //   ascii16Sram(ASCII16+SRAM 2K 鏡像。バンク値 bit4。RomAscii16_2)、gameMaster2(Konami+SRAM 8K。バンク値 bit4 で SRAM、bit5 で 4K の半分、
  //   書けるのは 0xB000 台だけ)、koei(ASCII8+SRAM 8K〜32K。バンク値 bit7 で SRAM)。SRAM へ書くと sramDirty(本体のバッテリー保存)
  const TYPES = ['plain', 'konami', 'konamiScc', 'konamiSccI', 'konamiDac', 'ascii8', 'ascii16', 'ascii8Sram', 'ascii16Sram', 'gameMaster2', 'koei'];
  const SRAM_SIZE = { ascii8Sram: 0x2000, ascii16Sram: 0x800, gameMaster2: 0x2000, koei: 0x8000 };

  // 'AB' ヘッダ(0x4000 境界ごと)の位置を返す(-1 なら無し)
  function findHeader(rom) {
    for (let off = 0; off + 16 <= rom.length && off < 0x10000; off += 0x4000) {
      if (rom[off] === 0x41 && rom[off + 1] === 0x42) return off;
    }
    return -1;
  }

  // 発見的な種別判定(openMSX RomInfo::guessRomType の近似)。64K 以下は plain
  // CRC32 → 種別の小辞書(2026-11-09、手元の ROM の総当たりで「全種別を試して明らかに別の種別の方が動く」と確かめた物だけ。名前は書かない。
  // 発見的手法(guessType)より優先。辞書に無ければ発見的手法)
  const MAPPER_DB = {
    'c29edd84': 'ascii16', '8cf0e6c0': 'ascii8', '28094960': 'konami', 'd6465702': 'ascii16', 'fb348de6': 'ascii8',
    'c89b93b5': 'koei', // 2026-11-11: 推定 konami だと SRAM の検査で止まる。koei で起動を確認
  };
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0'); }
  function guessType(rom) {
    const known = MAPPER_DB[crc32(rom)];
    if (known) return known;
    return guessTypeHeuristic(rom);
  }
  function guessTypeHeuristic(rom) {
    if (rom.length <= 0x10000) return 'plain';
    const score = { konami: 0, konamiScc: 0, ascii8: 0, ascii16: 0 };
    for (let i = 0; i + 2 < rom.length; i++) {
      if (rom[i] !== 0x32) continue; // LD (nn),A
      const a = rom[i + 1] | (rom[i + 2] << 8);
      switch (a) {
        case 0x5000: case 0x9000: case 0xB000: score.konamiScc++; break;
        case 0x4000: case 0x8000: case 0xA000: score.konami++; break;
        case 0x6800: case 0x7800: score.ascii8++; break;
        case 0x6000: score.konami++; score.ascii8++; score.ascii16++; break;
        case 0x7000: score.konamiScc++; score.ascii8++; score.ascii16++; break;
        case 0x77FF: score.ascii16++; break;
        default: break;
      }
    }
    if (score.ascii8) score.ascii8--; // ASCII8 は他より出やすい(openMSX と同じ補正)
    let best = 'konamiScc', bestN = -1;
    for (const t of ['konamiScc', 'konami', 'ascii8', 'ascii16']) { // 同点はこの順(Konami が多数派)
      if (score[t] > bestN) { best = t; bestN = score[t]; }
    }
    return best;
  }

  class MsxCartridge {
    /**
     * @param {Uint8Array|null} rom  ROM(konamiSccI は無くてよい: 空の RAM で始まる)
     * @param {object} [opts] { type: 種別(省略で推定), scc: SCCAudio(konamiScc/konamiSccI のとき音源を挿す), dac: MajutsushiDAC(konamiDac) }
     */
    constructor(rom, opts) {
      opts = opts || {};
      this.rom = rom ? (rom instanceof Uint8Array ? rom : new Uint8Array(rom)) : new Uint8Array(0);
      const given = opts.type && TYPES.includes(opts.type);
      this.type = given ? opts.type : (this.rom.length ? guessType(this.rom) : 'konamiSccI');
      this.guessed = !given;
      this.scc = opts.scc || null;
      this.dac = opts.dac || null;
      this.onWrite = null; // (kind, addr, value) 音源(SCC/DAC)の書き込み。本体が録音/ライブ表示に使う
      // 8K ページ参照(0x0000-0xFFFF の 8 ページ)。バンク ROM は bankSize 単位の配列
      this.pages = new Array(8).fill(EMPTY);
      this.bankSize = (this.type === 'ascii16' || this.type === 'ascii16Sram') ? 0x4000 : PAGE;
      this.banks = [];
      if (this.type === 'konamiSccI') {
        // RAM 128K を 8K×16 のバンクに割る(ram は 1 本。banks はその部分参照)
        this.ram = new Uint8Array(SCCI_RAM);
        if (this.rom.length) this.ram.set(this.rom.subarray(0, Math.min(this.rom.length, SCCI_RAM)));
        for (let i = 0; i < SCCI_RAM / PAGE; i++) this.banks.push(this.ram.subarray(i * PAGE, (i + 1) * PAGE));
        this.bankMask = 0x0F;
      } else {
        this.ram = null;
        const n = Math.max(1, Math.ceil(this.rom.length / this.bankSize));
        for (let i = 0; i < n; i++) {
          const b = new Uint8Array(this.bankSize).fill(0xFF);
          b.set(this.rom.subarray(i * this.bankSize, Math.min(this.rom.length, (i + 1) * this.bankSize)));
          this.banks.push(b);
        }
        this.bankMask = n <= 1 ? 0 : (1 << Math.ceil(Math.log2(n))) - 1;
      }
      this.bankSel = new Uint8Array(4); // 4 つのバンク窓(0x4000/0x6000/0x8000/0xA000、ascii16 は 0x4000/0x8000 の 2 つ)
      // SRAM(7c): 窓ごとに「SRAM が見えている」印(sramSel)。sramBank は SRAM 内のバンク(gameMaster2 の半分、koei の 8K 単位)
      this.sram = SRAM_SIZE[this.type] ? new Uint8Array(SRAM_SIZE[this.type]) : null;
      this.sramSel = new Uint8Array(4); this.sramBank = new Uint8Array(4);
      this.sramDirty = false;
      this.sramEnableBit = this.type === 'ascii8Sram' ? Math.max(0x20, 1 << Math.ceil(Math.log2(Math.max(2, this.banks.length)))) : this.type === 'ascii16Sram' ? 0x10 : this.type === 'gameMaster2' ? 0x10 : this.type === 'koei' ? 0x80 : 0;
      this.sccEnabled = false;   // classic SCC の窓(0x9800)が開いている
      this.sccPlusEnabled = false; // SCC+ の窓(0xB800)が開いている(konamiSccI、0xB000 の bit7)
      this.mode = 0;             // konamiSccI のモードレジスタ(0xBFFE)
      this.reset();
    }

    get header() { return findHeader(this.rom); }
    get title() {
      if (this.type === 'konamiSccI') return `SCC-I ${this.rom.length ? ((this.rom.length / 1024) | 0) + 'K+' : ''}RAM 128K`;
      return `${this.type}${this.guessed ? '(推定)' : ''} ${(this.rom.length / 1024) | 0}K`;
    }
    get isKonamiLike() { return this.type === 'konami' || this.type === 'konamiScc' || this.type === 'konamiSccI' || this.type === 'konamiDac' || this.type === 'gameMaster2'; }
    get isAscii16() { return this.type === 'ascii16' || this.type === 'ascii16Sram'; }
    get hasSram() { return !!this.sram; }

    reset() {
      this.sccEnabled = false; this.sccPlusEnabled = false; this.mode = 0;
      this.sramSel.fill(0); this.sramBank.fill(0);
      if (this.scc) this.scc.reset();
      if (this.dac) this.dac.reset();
      if (this.type === 'plain') { this._mapPlain(); return; }
      for (let i = 0; i < 4; i++) this.bankSel[i] = this.isKonamiLike ? i : 0;
      this._remap();
    }

    // 素の ROM: 'AB' の位置と INIT 番地で置き場所を決める
    _mapPlain() {
      const rom = this.rom, size = rom.length;
      const hdr = findHeader(rom);
      let base;
      if (size <= 0x4000) {
        // 8K/16K: INIT が 0x8000 以上なら 0x8000 に、それ以外は 0x4000 に(64K 空間へ鏡像)
        const init = hdr >= 0 ? (rom[hdr + 2] | (rom[hdr + 3] << 8)) : 0x4000;
        base = init >= 0x8000 ? 0x8000 : 0x4000;
        // 8K は 8K ページそのまま、16K は 2 ページ。鏡像は 0x0000-0xFFFF 全体(置き場所は読み手に見えない)
        const img = new Uint8Array(size <= PAGE ? PAGE : 0x4000).fill(0xFF); img.set(rom);
        void base;
        for (let p = 0; p < 8; p++) this.pages[p] = img.length === PAGE ? img : img.subarray(((p & 1) * PAGE), ((p & 1) + 1) * PAGE);
        return;
      }
      if (size <= 0x8000) {
        // 32K: 'AB' が先頭なら 0x4000-0xBFFF、'AB' が 0x4000 にあるなら 0x0000-0x7FFF(前半がデータ)
        base = hdr === 0x4000 ? 0x0000 : 0x4000;
        // INIT がページ 1〜3 を指すなら、ヘッダのページと INIT のページの差で置き場所を決める(openMSX と同じ考え。2026-11-11:
        //  前半 16K が空でヘッダが $4000、INIT が $8010 の ROM は 0x4000-0xBFFF に置くのが正しく、決め打ちだと C-BIOS が「BASIC の ROM」と見て止まった)
        const init = hdr >= 0 ? (rom[hdr + 2] | (rom[hdr + 3] << 8)) : 0;
        //  元の置き方で INIT が ROM の中に入るなら変えない(先頭にヘッダ、INIT $8010 の ROM は $4000-$BFFF のままが正しい)
        if (init >= 0x4000 && !(init >= base && init < base + size)) { const b = ((init >> 14) - (hdr >> 14)) * 0x4000; if (b >= 0 && b <= 0x8000) base = b; }
      } else if (size <= 0xC000) {
        base = hdr === 0x4000 ? 0x0000 : 0x4000; // 48K: 0x0000-0xBFFF か 0x4000-0xFFFF
      } else base = 0x0000; // 64K
      const img = new Uint8Array(0x10000).fill(0xFF);
      img.set(rom.subarray(0, Math.min(size, 0x10000 - base)), base);
      // 32K は 64K 全体に鏡像で置く(openMSX の Mirrored と同じ。番地 a は rom[(a - base) & 0x7FFF])。
      // INIT がページ 0($003B など)を指す ROM があり、鏡像が無いと $FF(RST 38)を実行して止まっていた(2026-11-11、openMSX との突き合わせで判明)
      if (size === 0x8000) for (let a = 0; a < 0x10000; a++) img[a] = rom[(a - base) & 0x7FFF];
      for (let p = 0; p < 8; p++) this.pages[p] = img.subarray(p * PAGE, (p + 1) * PAGE);
    }

    _remap() {
      const pg = this.pages;
      pg[0] = EMPTY; pg[1] = EMPTY; pg[6] = EMPTY; pg[7] = EMPTY;
      if (this.isAscii16) {
        for (let w = 0; w < 2; w++) {
          if (this.sramSel[w]) { const s = this._sramView(w, 0x4000); pg[2 + w * 2] = s.subarray(0, PAGE); pg[3 + w * 2] = s.subarray(PAGE, 2 * PAGE); continue; }
          const b = this.banks[this.bankSel[w] & this.bankMask] || EMPTY16();
          pg[2 + w * 2] = b.subarray(0, PAGE); pg[3 + w * 2] = b.subarray(PAGE, 2 * PAGE);
        }
        return;
      }
      for (let w = 0; w < 4; w++) pg[2 + w] = this.sramSel[w] ? this._sramView(w, PAGE) : (this.banks[this.bankSel[w] & this.bankMask] || EMPTY);
    }
    // 窓 w に見せる SRAM(size バイト)。小さい SRAM は鏡像にした像を作る(読みは pages 経由、書きは write() が sram へ直接)
    _sramView(w, size) {
      const s = this.sram;
      if (this.type === 'ascii16Sram') { // 2K を 16K に鏡像
        const v = this._sramMirror || (this._sramMirror = new Uint8Array(0x4000));
        for (let i = 0; i < 0x4000; i += s.length) v.set(s, i);
        return v;
      }
      if (this.type === 'gameMaster2') { // 4K の半分を 8K に鏡像
        const v = this._sramMirror || (this._sramMirror = new Uint8Array(PAGE));
        const half = s.subarray(this.sramBank[w] * 0x1000, this.sramBank[w] * 0x1000 + 0x1000);
        v.set(half, 0); v.set(half, 0x1000);
        return v;
      }
      const off = (this.sramBank[w] * size) % s.length;
      return s.subarray(off, off + size);
    }
    // SRAM の読みの像(鏡像の複製)は書き込みで古くなるので、書いたら張り直す
    _sramWrite(w, addr, v) {
      const s = this.sram;
      let off;
      if (this.type === 'ascii16Sram') off = addr & 0x7FF;
      else if (this.type === 'gameMaster2') off = this.sramBank[w] * 0x1000 + (addr & 0xFFF);
      else off = ((this.sramBank[w] * PAGE) + (addr & 0x1FFF)) % s.length;
      if (s[off] === v) return;
      s[off] = v; this.sramDirty = true;
      if (this._sramMirror) this._remap();
    }

    read(addr) { return this.pages[addr >>> 13][addr & 0x1FFF]; }

    // konamiSccI: 窓 w(0-3)が RAM として書けるか(モードレジスタ bit4=全部、bit0-2=窓 0-2)
    _ramWritable(w) { return !!(this.mode & 0x10) || (w < 3 && !!((this.mode >> w) & 1)); }

    write(addr, v) {
      switch (this.type) {
        case 'plain': return;
        case 'konami':
        case 'konamiDac':
          if (this.type === 'konamiDac' && addr >= 0x5000 && addr <= 0x5FFF) {
            if (this.dac) this.dac.write(v);
            if (this.onWrite) this.onWrite('dac', addr, v);
            return;
          }
          // $6000-$BFFF のどこに書いても、その 8K の窓のバンク($4000-$5FFF は固定)。2026-11-11: $6000/$8000/$A000 ちょうどだけにしていて、
          //  $7000/$9000/$B000 に書くゲームでバンクが切り替わらず別のコードを実行していた(openMSX RomKonami の記憶による推定、ab.js で一致を確認)
          if (addr >= 0x6000 && addr < 0xC000) this.bankSel[(addr - 0x4000) >> 13] = v; else return;
          this._remap(); return;
        case 'konamiScc':
          if (this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) {
            if (this.scc) this.scc.writeClassic(addr & 0xFF, v);
            if (this.onWrite) this.onWrite('scc', addr, v);
            return;
          }
          if ((addr & 0xF800) === 0x5000) this.bankSel[0] = v;
          else if ((addr & 0xF800) === 0x7000) this.bankSel[1] = v;
          else if ((addr & 0xF800) === 0x9000) { this.bankSel[2] = v; this.sccEnabled = (v & 0x3F) === 0x3F; }
          else if ((addr & 0xF800) === 0xB000) this.bankSel[3] = v;
          else return;
          this._remap(); return;
        case 'konamiSccI': {
          if (addr < 0x4000 || addr >= 0xC000) return;
          if ((addr & 0xFFFE) === 0xBFFE) { // モードレジスタ(RAM 書き込み可の窓でも効く)
            this.mode = v;
            if (this.onWrite) this.onWrite('scc', addr, v); // SCC+ 配置の切替は録音/ロールの読み手(kss2mml の SCC デコーダ)も要る
            return;
          }
          const w = (addr - 0x4000) >> 13;
          if (this._ramWritable(w)) { this.banks[this.bankSel[w] & this.bankMask][addr & 0x1FFF] = v; return; }
          const plus = !!(this.mode & 0x20);
          if (plus && this.sccPlusEnabled && addr >= 0xB800) {
            if (this.scc) this.scc.writePlus(addr & 0xFF, v);
            if (this.onWrite) this.onWrite('scc', addr, v);
            return;
          }
          if (!plus && this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) {
            if (this.scc) this.scc.writeClassic(addr & 0xFF, v);
            if (this.onWrite) this.onWrite('scc', addr, v);
            return;
          }
          if ((addr & 0x1800) !== 0x1000) return; // バンクレジスタは各窓の +0x1000-0x17FF(0x5000/0x7000/0x9000/0xB000)
          this.bankSel[w] = v;
          if (w === 2) this.sccEnabled = (v & 0x3F) === 0x3F;
          if (w === 3) { this.sccPlusEnabled = !!(v & 0x80); if (this.onWrite) this.onWrite('scc', addr, v); } // 窓の開閉も読み手が要る
          this._remap(); return;
        }
        case 'ascii8':
          if (addr >= 0x6000 && addr < 0x8000) { this.bankSel[(addr - 0x6000) >> 11] = v; this._remap(); }
          return;
        case 'ascii16':
          if (addr >= 0x6000 && addr < 0x6800) { this.bankSel[0] = v; this._remap(); }
          else if (addr >= 0x7000 && addr < 0x7800) { this.bankSel[1] = v; this._remap(); }
          return;
        case 'ascii8Sram': case 'koei': {
          // SRAM が見えている 0x8000-0xBFFF への書き込みは SRAM へ。バンクレジスタは 0x6000-0x7FFF
          if (addr >= 0x8000 && addr < 0xC000) { const w = (addr - 0x4000) >> 13; if (this.sramSel[w]) this._sramWrite(w, addr, v); return; }
          if (addr >= 0x6000 && addr < 0x8000) {
            const w = (addr - 0x6000) >> 11;
            if (v & this.sramEnableBit) { this.sramSel[w] = 1; this.sramBank[w] = v & ((this.sram.length >> 13) - 1); }
            else { this.sramSel[w] = 0; this.bankSel[w] = v; }
            this._remap();
          }
          return;
        }
        case 'ascii16Sram': {
          if (addr >= 0x8000 && addr < 0xC000) { if (this.sramSel[1]) this._sramWrite(1, addr, v); return; }
          let w = -1;
          if (addr >= 0x6000 && addr < 0x6800) w = 0; else if (addr >= 0x7000 && addr < 0x7800) w = 1;
          if (w < 0) return;
          // SRAM はバンク値がちょうど $10 のときだけ(openMSX RomAscii16_2 の記憶による推定。bit4 で見ると $10 以外の値で ROM のはずが SRAM になった)
          if (v === 0x10) this.sramSel[w] = 1; else { this.sramSel[w] = 0; this.bankSel[w] = v; }
          this._remap(); return;
        }
        case 'gameMaster2': {
          // SRAM への書き込みは 0xB000-0xBFFF(窓 3 に SRAM が見えているとき)。バンクレジスタは 0x6000/0x8000/0xA000(各窓の先頭 4K: 0x6000-0x6FFF 等)
          if (addr >= 0xB000 && addr < 0xC000) { if (this.sramSel[3]) this._sramWrite(3, addr, v); return; }
          if (addr >= 0x6000 && addr < 0xC000 && !(addr & 0x1000)) {
            const w = (addr - 0x4000) >> 13;
            if (v & 0x10) { this.sramSel[w] = 1; this.sramBank[w] = (v >> 5) & 1; }
            else { this.sramSel[w] = 0; this.bankSel[w] = v & 0x0F; }
            this._remap();
          }
          return;
        }
        default: return;
      }
    }
    // SCC の読み出し(窓が開いているとき)。本体が read の前に見る。-1 なら SCC ではない
    readScc(addr) {
      if (!this.scc) return -1;
      if (this.type === 'konamiScc') return (this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) ? this.scc.readClassic(addr & 0xFF) : -1;
      if (this.type === 'konamiSccI') {
        const plus = !!(this.mode & 0x20);
        if (plus && this.sccPlusEnabled && addr >= 0xB800 && addr <= 0xBFFF) return this.scc.readPlus(addr & 0xFF);
        if (!plus && this.sccEnabled && addr >= 0x9800 && addr <= 0x9FFF) return this.scc.readClassic(addr & 0xFF);
      }
      return -1;
    }
    get hasScc() { return (this.type === 'konamiScc' || this.type === 'konamiSccI') && !!this.scc; }
    // バッテリーバックアップ(SRAM)の出し入れ(本体の getBattery/setBattery)
    getSram() { return this.sram ? this.sram.slice() : null; }
    setSram(bytes) { if (!this.sram || !bytes) return false; this.sram.set(bytes.subarray(0, Math.min(bytes.length, this.sram.length))); this.sramDirty = false; if (this._sramMirror) this._remap(); return true; }
    get hasDac() { return this.type === 'konamiDac' && !!this.dac; }
    get sccPlusMode() { return this.type === 'konamiSccI' && !!(this.mode & 0x20); }
  }
  const EMPTY16_BUF = new Uint8Array(0x4000).fill(0xFF);
  function EMPTY16() { return EMPTY16_BUF; }

  MsxCartridge.TYPES = TYPES;
  MsxCartridge.guessType = guessType;
  MsxCartridge.findHeader = findHeader;
  Emu.MsxCartridge = MsxCartridge;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MSX キーボードのマトリクス(日本語配列)と、PC のキー(KeyboardEvent.code)からの既定の対応表
 * MML.Emu.MsxKeyboard — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md §3.5、段階 7a)
 *
 * PPI(ポート 0xAA の下位 4 ビットで行を選び、0xA9 で 8 ビットを読む。押している=0)の 11 行(+日本語機の 11 行目)。
 * 行とビットの並びは MSX 日本語配列(JIS)の実機の表。英字配列(ANSI)との違いは行 1〜2 の記号の位置だけ。
 *   行 0 : 0 1 2 3 4 5 6 7(bit0〜7)
 *   行 1 : 8 9 - ^ ¥ @ [ ;
 *   行 2 : : ] , . / _ A B
 *   行 3 : C D E F G H I J
 *   行 4 : K L M N O P Q R
 *   行 5 : S T U V W X Y Z
 *   行 6 : SHIFT CTRL GRAPH CAPS かな F1 F2 F3
 *   行 7 : F4 F5 ESC TAB STOP BS SELECT RETURN
 *   行 8 : SPACE HOME INS DEL ← ↑ ↓ →
 *   行 9 : テンキー * + / 0 1 2 3 4
 *   行 10: テンキー 5 6 7 8 9 - , .
 *   行 11: 日本語機の 実行(bit1)/取消(bit3) (推定: 機種により無い。openMSX の JP 配列表に合わせた)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // キー名 → [行, ビット]
  const KEYS = {
    Digit0: [0, 0], Digit1: [0, 1], Digit2: [0, 2], Digit3: [0, 3], Digit4: [0, 4], Digit5: [0, 5], Digit6: [0, 6], Digit7: [0, 7],
    Digit8: [1, 0], Digit9: [1, 1], Minus: [1, 2], Caret: [1, 3], Yen: [1, 4], At: [1, 5], BracketLeft: [1, 6], Semicolon: [1, 7],
    Colon: [2, 0], BracketRight: [2, 1], Comma: [2, 2], Period: [2, 3], Slash: [2, 4], Underscore: [2, 5], A: [2, 6], B: [2, 7],
    C: [3, 0], D: [3, 1], E: [3, 2], F: [3, 3], G: [3, 4], H: [3, 5], I: [3, 6], J: [3, 7],
    K: [4, 0], L: [4, 1], M: [4, 2], N: [4, 3], O: [4, 4], P: [4, 5], Q: [4, 6], R: [4, 7],
    S: [5, 0], T: [5, 1], U: [5, 2], V: [5, 3], W: [5, 4], X: [5, 5], Y: [5, 6], Z: [5, 7],
    Shift: [6, 0], Ctrl: [6, 1], Graph: [6, 2], Caps: [6, 3], Kana: [6, 4], F1: [6, 5], F2: [6, 6], F3: [6, 7],
    F4: [7, 0], F5: [7, 1], Esc: [7, 2], Tab: [7, 3], Stop: [7, 4], BS: [7, 5], Select: [7, 6], Return: [7, 7],
    Space: [8, 0], Home: [8, 1], Ins: [8, 2], Del: [8, 3], Left: [8, 4], Up: [8, 5], Down: [8, 6], Right: [8, 7],
    NumMul: [9, 0], NumAdd: [9, 1], NumDiv: [9, 2], Num0: [9, 3], Num1: [9, 4], Num2: [9, 5], Num3: [9, 6], Num4: [9, 7],
    Num5: [10, 0], Num6: [10, 1], Num7: [10, 2], Num8: [10, 3], Num9: [10, 4], NumSub: [10, 5], NumComma: [10, 6], NumDot: [10, 7],
    Jikkou: [11, 1], Torikeshi: [11, 3],
  };

  // PC の KeyboardEvent.code → MSX キー名(既定。UI の設定で上書きできる)
  // 文字キーは「刻印の位置」で合わせる(日本語キーボードの PC なら記号も同じ位置になる)
  const DEFAULT_MAP = {
    Digit0: 'Digit0', Digit1: 'Digit1', Digit2: 'Digit2', Digit3: 'Digit3', Digit4: 'Digit4', Digit5: 'Digit5', Digit6: 'Digit6', Digit7: 'Digit7', Digit8: 'Digit8', Digit9: 'Digit9',
    Minus: 'Minus', Equal: 'Caret', IntlYen: 'Yen', Backslash: 'Yen', BracketLeft: 'At', BracketRight: 'BracketLeft', Semicolon: 'Semicolon', Quote: 'Colon', Backquote: 'BracketRight',
    Comma: 'Comma', Period: 'Period', Slash: 'Slash', IntlRo: 'Underscore',
    KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L', KeyM: 'M',
    KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X', KeyY: 'Y', KeyZ: 'Z',
    ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Graph', AltRight: 'Graph', CapsLock: 'Caps',
    KanaMode: 'Kana', Lang1: 'Kana', Lang2: 'Kana', NonConvert: 'Kana',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', Escape: 'Esc', Tab: 'Tab', F8: 'Stop', End: 'Stop', Backspace: 'BS', F6: 'Select', PageUp: 'Select', Enter: 'Return', NumpadEnter: 'Return',
    Space: 'Space', Home: 'Home', Insert: 'Ins', Delete: 'Del', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down', ArrowRight: 'Right',
    NumpadMultiply: 'NumMul', NumpadAdd: 'NumAdd', NumpadDivide: 'NumDiv', Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3', Numpad4: 'Num4',
    Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7', Numpad8: 'Num8', Numpad9: 'Num9', NumpadSubtract: 'NumSub', NumpadComma: 'NumComma', NumpadDecimal: 'NumDot',
    PageDown: 'Jikkou', ScrollLock: 'Torikeshi',
  };

  const ROWS = 12;

  class MsxKeyboard {
    constructor() {
      this.rows = new Uint8Array(ROWS).fill(0xFF); // 押している=0
      this.map = Object.assign({}, DEFAULT_MAP);
    }
    reset() { this.rows.fill(0xFF); }
    /** MSX のキー名で押す/離す */
    setKey(name, down) {
      const k = KEYS[name];
      if (!k) return false;
      if (down) this.rows[k[0]] &= ~(1 << k[1]); else this.rows[k[0]] |= (1 << k[1]);
      return true;
    }
    /** 行とビットで押す/離す(UI のソフトキーボード等) */
    setMatrix(row, bit, down) {
      if (row < 0 || row >= ROWS) return;
      if (down) this.rows[row] &= ~(1 << bit); else this.rows[row] |= (1 << bit);
    }
    /** PC の KeyboardEvent.code で押す/離す。対応が無ければ false */
    setPcKey(code, down) {
      const name = this.map[code];
      return name ? this.setKey(name, down) : false;
    }
    readRow(row) { return row < ROWS ? this.rows[row] : 0xFF; }
    releaseAll() { this.rows.fill(0xFF); }
  }
  MsxKeyboard.KEYS = KEYS;
  MsxKeyboard.DEFAULT_MAP = DEFAULT_MAP;
  MsxKeyboard.ROWS = ROWS;
  Emu.MsxKeyboard = MsxKeyboard;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MSX VDP (MML.Emu.MsxVdp) — TMS9918A / V9938 / V9958 を 1 本で(DESIGN-MSX-CAPTURE.md §3.4、段階 7a/7c)
 *
 * 画面モード: TMS9918 系(GRAPHIC1=SCREEN1、GRAPHIC2=SCREEN2、MULTICOLOR=SCREEN3、TEXT1=SCREEN0)+スプライトモード 1、
 * V9938(7c): GRAPHIC3=SCREEN4、GRAPHIC4=SCREEN5(256×212 4bpp)、GRAPHIC5=SCREEN6(512×212 2bpp)、GRAPHIC6=SCREEN7(512×212 4bpp)、
 * GRAPHIC7=SCREEN8(256×212 8bpp GRB332)、TEXT2=SCREEN0 WIDTH80 と スプライトモード 2(行 8 枚、行ごとの色、EC/CC/IC)、
 * 212 ライン、縦スクロール(R23)、パレット 16×9bit、ライン割り込み(R19/S1)、ステータス S0〜S9、VDP コマンド(下記)。
 * V9958(7e): 横スクロール(R26 bit0-4 ×8 ドット、R27 bit0-2 の右ずらし、R25 bit0 SP2=2 ページ(ページは R26 bit5、R2 の bit5 は無視)、
 * R25 bit1 MSK=左 8 ドットをボーダー色で隠す。全モードに効き、スプライトは動かない)、YJK(R25 bit3、GRAPHIC7 のバイト列を 4 ドット 1 組の
 * Y5+J6/K6 で色にする=SCREEN12。R25 bit4 YAE=バイトの bit3 が 1 のドットはパレット(bit7-4)=SCREEN10/11)、R25 bit6 CMD=ビットマップ以外の
 * モードでもコマンドが動く(GRAPHIC7 の配置として扱う: openMSX の挙動の記憶による推定)。S1 bit2 で V9958 を名乗る。
 * YJK の frameIdx(巻き戻し用)は GRB332 への丸め(表示は frame の正確な色)。
 * インターレース(R9 bit3 IL): フレームを 480 行にし、偶奇フィールドを交互の行に描く(frameHeight が 480 になる。interlaced で分かる)。
 * EO(R9 bit2): フィールドごとに名前表のページ(R2 bit5)を 0/1 に切り替える(IL 無しなら 240 行のままフレームごとに切替)。巻き戻し用の frameIdx は偶数フィールドだけ。
 *
 * ■ 時間
 *   行単位。1 行 = 228 Z80 サイクル(VDP 1368 サイクル/6)、NTSC 262 行・PAL(R9 bit1)313 行。1 行の終わりでその行を描く
 *   (行の途中の VRAM 書き込みは行全体に効く近似)。フレームの区切り(本体が録音/画面送出に使う)は表示の最終行の次=F フラグが
 *   立つ行の頭(vblankStarted)。VRAM アクセススロットの待ちは模擬しない。
 * ■ VDP コマンド(R32〜R46。R46 の上位 4bit が命令、下位 4bit が論理演算)
 *   HMMC/YMMM/HMMM/HMMV/LMMC/LMCM/LMMM/LMMV/LINE/SRCH/PSET/POINT/STOP。GRAPHIC4〜7 でだけ動く(V9938 と同じ。V9958 の他モード対応は 7e)。
 *   時間は openMSX の表(表示中・スプライト有効)を Z80 サイクルに丸めた近似: 1 ドットあたり HMMV 8 / HMMM 15 / YMMM 11 / LMMV 12 /
 *   LMMM 20 / LINE 20 / PSET 12 / SRCH 15 / POINT 8。VBlank 中と表示 OFF は半分。MSX2 のゲームは S2 の CE で完了を待つので
 *   速すぎても遅すぎても画が変わる(近似であることに注意)。HMMC/LMMC は CPU の R44 書き込みに合わせて 1 ドットずつ進む(TR)。
 * ■ 出力
 *   frame(Uint32Array、ABGR)。幅はそのフレームのモードで 256 か 512(frameWidth。GRAPHIC5/6・TEXT2 が 512)、高さ 240。
 *   192 行は上下 24 行、212 行は上下 14 行がボーダー。frameIdx(Uint8Array 256×240)は巻き戻しの映像の輪用: 幅 512 のモードは 1 ドットおき、
 *   GRAPHIC7 のフレームはパレット番号でなく GRB332 の値(frameIdxKind=1。表示色は MsxVdp.G7_PALETTE)。
 *   幅の違う行(フレームの途中でモードを変えた)はフレームの幅に合わせて 2 倍/間引きで描く。
 *
 * レジスタの要点:
 *   R0: bit1-3 M3/M4/M5、bit4 IE1(ライン割り込み)  R1: bit6 BL(表示)、bit5 IE0、bit4 M1、bit3 M2、bit1 SI(16×16)、bit0 MAG
 *   R2 名前表(G1-3/T1: ×$400、G4/5: bit6-5=A16-15、G6/7: bit5=A16、T2: bit6-2 ×$1000)  R3/R10 色表  R4 パターン表  R5/R11 スプライト属性表
 *   R6 スプライトパターン ×$800  R7 文字色<<4|背景色(G7 ではボーダー色 8bit)  R8: bit1 SPD(スプライト無効)、bit5 TP(色 0 もパレット)
 *   R9: bit7 LN(212 行)、bit1 NT(PAL)  R12/R13 TEXT2 の点滅色/周期(未対応: 常に文字色)  R14: VRAM 番地の A16-14  R15: 読むステータス番号
 *   R16/R17: パレット/間接レジスタの番地  R18: 表示位置調整(縦のみ反映)  R19: ライン割り込みの行  R23: 縦スクロール
 *   R25(V9958): bit0 SP2、bit1 MSK、bit3 YJK、bit4 YAE、bit6 CMD  R26/R27(V9958): 横スクロール(上記)
 *   R32-R46: コマンドの SX/SY/DX/DY/NX/NY/CLR/ARG/CMD
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 256, WIDE = 512, H = 240;
  const CYCLES_PER_LINE = 228;
  const LINES_NTSC = 262, LINES_PAL = 313;

  // TMS9918A の固定パレット(RGB)。V9938 の初期パレットは同じ色の 3bit 版
  const TMS_RGB = [
    [0, 0, 0], [0, 0, 0], [33, 200, 66], [94, 220, 120], [84, 85, 237], [125, 118, 252], [212, 82, 77], [66, 235, 245],
    [252, 85, 84], [255, 121, 120], [212, 193, 84], [230, 206, 128], [33, 176, 59], [201, 91, 186], [204, 204, 204], [255, 255, 255],
  ];
  const V9938_DEFAULT_PALETTE = [ // [R,G,B] 各 0-7
    [0, 0, 0], [0, 0, 0], [1, 6, 1], [3, 7, 3], [1, 1, 7], [2, 3, 7], [5, 1, 1], [2, 6, 7],
    [7, 1, 1], [7, 3, 3], [6, 6, 1], [6, 6, 4], [1, 4, 1], [6, 2, 5], [5, 5, 5], [7, 7, 7],
  ];
  function abgr(r, g, b) { return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; }
  const TMS_PALETTE = new Uint32Array(16);
  for (let i = 0; i < 16; i++) TMS_PALETTE[i] = abgr(TMS_RGB[i][0], TMS_RGB[i][1], TMS_RGB[i][2]);
  const LEVEL3 = [0, 36, 73, 109, 146, 182, 219, 255];
  const LEVEL5 = Array.from({ length: 32 }, (_, i) => Math.round(i * 255 / 31)); // YJK の 5bit
  const LEVEL2 = [0, 85, 170, 255];
  // GRAPHIC7 の 8bit 色(GGGRRRBB → 表示色)
  const G7_PALETTE = new Uint32Array(256);
  for (let c = 0; c < 256; c++) G7_PALETTE[c] = abgr(LEVEL3[(c >> 2) & 7], LEVEL3[(c >> 5) & 7], LEVEL2[c & 3]);
  // GRAPHIC7 のスプライト色(パレットでなく固定の 8bit 色。V9938 の仕様表の GRB)
  const G7_SPRITE_COLOR = [0x00, 0x02, 0x03, 0x07, 0x24, 0x64, 0x80, 0x1B, 0xC0, 0xE4, 0x90, 0xB5, 0x0C, 0xD6, 0xDB, 0xFF];

  // コマンドの 1 ドットあたりの時間(Z80 サイクル、表示中)。VBlank/表示 OFF は半分(_cmdCost)
  // コマンド 1 歩(H 系はバイト、L 系/LINE/SRCH はドット)の所要時間。VDP の 21.48MHz 刻み(Z80 の 6 倍)で [表示 OFF/帰線, 表示 ON+スプライトあり, 表示 ON+スプライトなし]。
  // 2026-11-11: openMSX の VDPCmdEngine の表の記憶(推定)。HMMV の表示 OFF(8.1 Z80 サイクル/バイト)とスプライトあり(VBlank 込みで 10.2)は openMSX の
  //  残り行数の減り方で実測して一致。以前は「表示 OFF と VBlank の間は半分」にしていて、画面を消して塗るゲームで 2 倍速になり流れが変わった
  const CMD_TICKS = { 0xC: [49, 65, 62], 0x8: [98, 137, 124], 0xE: [65, 125, 68], 0xD: [92, 136, 97], 0x9: [129, 197, 132], 0x7: [120, 147, 120], 0x6: [92, 125, 92], 0x5: [72, 72, 72], 0x4: [48, 48, 48] };

  class MsxVdp {
    /** @param {object} [opts] { type: 'tms9918' | 'v9938' | 'v9958', vramKB: 16 | 64 | 128 } */
    constructor(opts) {
      opts = opts || {};
      this.type = opts.type || 'v9938';
      this.isTms = this.type === 'tms9918';
      this.isV9958 = this.type === 'v9958';
      const kb = opts.vramKB || (this.isTms ? 16 : 128);
      this.vram = new Uint8Array(kb * 1024);
      this.vramMask = this.vram.length - 1;
      this.regs = new Uint8Array(64);
      this.status = new Uint8Array(10);
      this.palette = new Uint32Array(16);   // 表示色(ABGR)
      this.paletteRaw = new Uint16Array(16); // V9938 の 9bit 値(保存/録音用)
      this.frame = new Uint32Array(WIDE * H * 2); // 幅 256 のフレームは先頭 256×240 だけ使う(frameWidth)。インターレース中は 480 行(frameHeight)
      this.frameIdx = new Uint8Array(W * H);
      this.lineBuf = new Uint8Array(WIDE);   // 1 行の色番号(0 は透明=背景色)。G7 は 8bit 色そのもの
      this.sprBuf = new Uint8Array(W);       // 1 行のスプライト色(0 無し、bit4 = スプライトあり)
      this.lineRgb = new Uint32Array(W);     // YJK(V9958)の 1 行の表示色(lb は GRB332 への丸め。スプライトと索引は lb で)
      this.lineTmpA = new Uint8Array(WIDE); this.lineTmpB = new Uint8Array(WIDE); this.lineRgbA = new Uint32Array(W); this.lineRgbB = new Uint32Array(W); this.yjkBg = new Uint8Array(W); // 横スクロール/YJK の作業用
      this.onInt = null;                     // 割り込み線の変化(本体が見てもよい。線は intLine() で読む)
      this.reset();
    }

    reset() {
      this.regs.fill(0);
      this.status.fill(0);
      this.status[2] = 0x0C; // bit2-3 は常に 1(TR/CE は読むときにコマンドの状態から作る。ここでは BD=bit4 だけを持つ)
      this.vram.fill(0);
      this.addr = 0; this.latch = -1; this.readBuf = 0; this.palLatch = -1;
      this.line = 0;              // 今の行(0 = フレームの先頭。表示は displayStart 行から)
      this.cycle = 0;             // 行内のサイクル
      this.frameCount = 0;
      this.vblankStarted = false; // 表示の最終行の次の行の頭で立つ(本体が落とす)
      this.unsupportedMode = false;
      this.outW = W;              // 今描いているフレームの幅
      this.frameWidthOut = W;     // 本体に見せる幅(VBlank で確定)
      this.frameIdxKind = 0;      // 0=パレット番号、1=GRB332(G7)
      this.idxKindCur = 0;
      this.field = 0; this.ilCur = false; this.eoCur = false; this.frameHeightOut = H; this.interlacedOut = false; // インターレース(IL/EO)
      this.cmd = { op: 0, sx: 0, sy: 0, dx: 0, dy: 0, nx: 0, ny: 0, anx: 0, any: 0, clr: 0, arg: 0, lop: 0, dix: 1, diy: 1, cx: 0, cy: 0, maj: 0, eq: 0, lineAcc: 0, budget: 0, tr: false };
      for (let i = 0; i < 16; i++) this._setPalette(i, V9938_DEFAULT_PALETTE[i][0], V9938_DEFAULT_PALETTE[i][1], V9938_DEFAULT_PALETTE[i][2]);
      this.frame.fill(this.palette[0]); this.frameIdx.fill(0);
      this._updateTiming();
    }

    _setPalette(i, r, g, b) {
      this.paletteRaw[i] = (r << 8) | (g << 4) | b;
      this.palette[i] = this.isTms ? TMS_PALETTE[i] : abgr(LEVEL3[r & 7], LEVEL3[g & 7], LEVEL3[b & 7]);
    }

    // ── 画面モード ──
    get mode() {
      const r0 = this.regs[0], r1 = this.regs[1];
      // M1=R1 bit4, M2=R1 bit3, M3=R0 bit1, M4=R0 bit2, M5=R0 bit3 → ビット列 M5 M4 M3 M2 M1
      return ((r1 >> 4) & 1) | ((r1 >> 2) & 2) | ((r0 << 1) & 4) | ((r0 << 1) & 8) | ((r0 << 1) & 16);
    }
    static modeName(m) { return { 0: 'G1', 1: 'T1', 2: 'MC', 4: 'G2', 8: 'G3', 9: 'T2', 12: 'G4', 16: 'G5', 20: 'G6', 28: 'G7' }[m] || ('?' + m); }
    get isBitmap() { const m = this.mode; return m === 12 || m === 16 || m === 20 || m === 28; }
    get modeWidth() { const m = this.mode; return (m === 16 || m === 20 || m === 9) ? WIDE : W; }
    get displayLines() { return (!this.isTms && (this.regs[9] & 0x80)) ? 212 : 192; }
    get linesPerFrame() { return (!this.isTms && (this.regs[9] & 0x02)) ? LINES_PAL : LINES_NTSC; }
    get cyclesPerFrame() { return this.linesPerFrame * CYCLES_PER_LINE; }
    get displayEnabled() { return (this.regs[1] & 0x40) !== 0; }
    get frameWidth() { return this.frameWidthOut; }
    get frameHeight() { return this.frameHeightOut; } // 240、インターレース中は 480
    get interlaced() { return this.interlacedOut; }
    _row(fy) { return this.ilCur ? fy * 2 + this.field : fy; } // frame 上の行(インターレースはフィールドで交互)
    get frameIdxWidth() { return W; }
    _updateTiming() {
      // 表示の先頭行: 垂直同期 3 + 上の消去 13 + 上のボーダー(192 行: 26、212 行: 16)+ R18 の縦調整(符号付き 4bit)
      const adj = this.isTms ? 0 : (((this.regs[18] >> 4) ^ 8) - 8); // -7..+8 → 上へ/下へ
      this.displayStart = 3 + 13 + (this.displayLines === 212 ? 16 : 26) - adj;
      this.displayEnd = this.displayStart + this.displayLines; // この行の頭が VBlank の始まり
      this.frameY0 = this.displayLines === 212 ? 14 : 24;      // frame 上の表示開始 y
    }

    // ── 割り込み線 ──
    intLine() {
      return ((this.status[0] & 0x80) && (this.regs[1] & 0x20)) || ((this.status[1] & 0x01) && (this.regs[0] & 0x10));
    }
    // フレーム内の位置(0〜1)。フレームの頭 = VBlank の始まり(displayEnd 行)
    frameFrac() {
      const total = this.cyclesPerFrame;
      let l = this.line - this.displayEnd; if (l < 0) l += this.linesPerFrame;
      return (l * CYCLES_PER_LINE + this.cycle) / total;
    }
    get inVBlank() { return this.line < this.displayStart || this.line >= this.displayEnd; }

    // ── I/O ポート ──
    // 0x98 VRAM / 0x99 制御・ステータス / 0x9A パレット / 0x9B 間接レジスタ
    readPort(port) {
      switch (port & 3) {
        case 0: { // VRAM 読み: 先読みバッファを返し、次を読む
          const v = this.readBuf;
          this.readBuf = this.vram[this.addr & this.vramMask];
          this._incAddr();
          this.latch = -1;
          return v;
        }
        case 1: { // ステータス(R15 で選んだ物。TMS は S0 のみ)
          const n = this.isTms ? 0 : (this.regs[15] & 0x0F);
          this.latch = -1;
          if (n === 0) { const v = this.status[0]; this.status[0] &= 0x1F; return v; } // F/5S/C は読むと消える
          if (n === 1) { const v = this.status[1]; this.status[1] &= ~0x01; return v | (this.type === 'v9958' ? 0x04 : 0x00); } // FH は読むと消える。ID: V9958=bit2
          if (n === 2) { // TR/VR/HR/BD/CE
            const vr = this.inVBlank ? 0x40 : 0x00;
            const hr = this.cycle >= 200 ? 0x20 : 0x00; // 水平帰線(行末 28 サイクルを近似)
            const c = this.cmd;
            // TR はコマンドの最中でデータを受け渡せるときだけ 1。コマンドが無い間は 0(2026-11-11、openMSX の S#2 で確認: 待機中 $6C、HMMC 中 $ED。
            //  待機中 1 にしていたら、割り込み処理が S#2 を選んだまま割り込まれたゲームが「VBlank 来た」と読み違え、要因を消さずに戻って入れ子の割り込みでスタックがあふれた)
            return ((c.op && c.tr) ? 0x80 : 0x00) | 0x0C | vr | hr | (this.status[2] & 0x10) | (c.op ? 0x01 : 0x00);
          }
          if (n === 7) { const v = this.status[7]; if (this.cmd.op === 0xA) this._lmcmNext(); return v; } // LMCM: 読むと次のドットへ
          return n < 10 ? this.status[n] : 0xFF;
        }
        default: return 0xFF;
      }
    }
    writePort(port, v) {
      v &= 0xFF;
      switch (port & 3) {
        case 0: // VRAM 書き
          this.vram[this.addr & this.vramMask] = v;
          this.readBuf = v;
          this._incAddr();
          this.latch = -1;
          return;
        case 1: // 制御: 2 バイト目で レジスタ書き(bit7) / 番地設定(bit6=書き、0=読み先読み)
          if (this.latch < 0) { this.latch = v; return; }
          {
            const lo = this.latch; this.latch = -1;
            if (v & 0x80) { this.writeReg(v & 0x3F, lo); return; }
            const hi = (this.isTms ? 0 : (this.regs[14] & 0x07) << 14);
            this.addr = hi | ((v & 0x3F) << 8) | lo;
            if (!(v & 0x40)) { this.readBuf = this.vram[this.addr & this.vramMask]; this._incAddr(); }
          }
          return;
        case 2: // パレット(V9938): 1 バイト目 0RRR0BBB、2 バイト目 00000GGG → R16 が指す色、R16 を +1
          if (this.isTms) return;
          if (this.palLatch < 0) { this.palLatch = v; return; }
          {
            const i = this.regs[16] & 0x0F;
            this._setPalette(i, (this.palLatch >> 4) & 7, v & 7, this.palLatch & 7);
            this.palLatch = -1;
            this.regs[16] = (i + 1) & 0x0F;
          }
          return;
        case 3: // 間接レジスタ(V9938): R17 が指すレジスタへ。bit7 が 0 なら R17 を +1
          if (this.isTms) return;
          {
            const r = this.regs[17] & 0x3F;
            if (r !== 17) this.writeReg(r, v);
            if (!(this.regs[17] & 0x80)) this.regs[17] = (this.regs[17] & 0x80) | ((r + 1) & 0x3F);
          }
          return;
      }
    }
    // VRAM の番地を 1 進める。V9938 のモード(G3〜G7/T2)では下位 14bit が 0 に戻ったら R14 も +1(128K を通しで)、それ以外のモードと TMS は 16K の中で回る
    // (2026-11-11、openMSX の作りの記憶による推定)
    _incAddr() {
      const lo = (this.addr + 1) & 0x3FFF;
      if (this.isTms) { this.addr = lo; return; }
      if (lo === 0 && (this.mode & 0x18)) this.regs[14] = (this.regs[14] + 1) & 0x07;
      this.addr = (this.regs[14] << 14) | lo;
    }
    writeReg(r, v) {
      if (this.isTms) { if (r > 7) return; }
      else if (r >= 47) return;
      const old = this.regs[r];
      this.regs[r] = v;
      if (r === 9 || r === 18) this._updateTiming();
      if (r === 1 && ((old ^ v) & 0x20) && this.onInt) this.onInt(this.intLine());
      if (r === 0 && ((old ^ v) & 0x10) && this.onInt) this.onInt(this.intLine());
      if (r === 15) this.regs[15] = v & 0x0F;
      // R14(VRAM 番地の上位 3bit)は読み書きのたびに使われる: 番地(下位 14bit)を設定した後に R14 を書いても効く(2026-11-11。
      //  番地→R14 の順で書くゲームで、設定時の R14 で番地を決めていたため部品が別のページに書かれ画面が崩れていた)
      if (r === 14 && !this.isTms) { this.regs[14] = v & 0x07; this.addr = (this.regs[14] << 14) | (this.addr & 0x3FFF); }
      if (r === 44) this._cmdData(v);        // HMMC/LMMC のデータ
      else if (r === 46) this._cmdStart(v);  // コマンド開始
    }

    // ── 実行 ──
    /** Z80 の cycles サイクルぶん進める。行の終わりで描き、表示の最終行の次の行の頭で VBlank(F)を立てる */
    step(cycles) {
      if (this.cmd.op) this._cmdRun(cycles);
      this.cycle += cycles;
      while (this.cycle >= CYCLES_PER_LINE) {
        this.cycle -= CYCLES_PER_LINE;
        this._endLine();
      }
    }
    _endLine() {
      const l = this.line;
      if (l === this.displayStart) { this.outW = this.modeWidth; this.idxKindCur = (this.mode === 28) ? 1 : 0; this.ilCur = !this.isTms && (this.regs[9] & 0x08) !== 0; this.eoCur = !this.isTms && (this.regs[9] & 0x04) !== 0; } // このフレームの幅/索引の種類/インターレースはモードで決める
      if (l >= this.displayStart && l < this.displayEnd) this._renderLine(l - this.displayStart);
      // ライン割り込み(V9938): 表示行 R19(縦スクロール R23 ぶんずれる)の終わりで FH。FH は IE1(R0 bit4)が立っている時だけ立てる
      // (2026-11-11。IE1=0 でも立てていたら、割り込みのたびに S#1 の FH で「行割り込みか VBlank か」を見分けるゲームが
      //  VBlank を行割り込みと取り違え、空のラスタ表で BIOS の先頭を VDP レジスタへ流し込んで画面が崩れていた。openMSX も IE1 の時だけ、の記憶による推定)
      if (!this.isTms && (this.regs[0] & 0x10) && l >= this.displayStart && l < this.displayEnd) {
        const dl = l - this.displayStart;
        if (((dl + this.regs[23]) & 0xFF) === this.regs[19]) { this.status[1] |= 0x01; if (this.onInt) this.onInt(this.intLine()); }
      }
      this.line++;
      if (this.line >= this.linesPerFrame) { this.line = 0; }
      if (this.line === this.displayEnd) {
        // VBlank の頭: F フラグ、フレームの区切り。ボーダー行はここで一括で塗る(表示部は毎行描いた)
        this.status[0] |= 0x80;
        this._fillBorders();
        this.frameWidthOut = this.outW;
        this.frameIdxKind = this.idxKindCur;
        this.frameHeightOut = this.ilCur ? H * 2 : H; this.interlacedOut = this.ilCur;
        this.field = (this.ilCur || this.eoCur) ? (this.field ^ 1) : 0;
        this.frameCount++;
        this.vblankStarted = true;
        if (this.onInt && (this.regs[1] & 0x20)) this.onInt(true);
      }
    }
    _borderColor() { // 表示色と索引(G7 はボーダーも 8bit 色)
      if (this.mode === 28 && !this.isTms) { const c = this.regs[7]; return [G7_PALETTE[c], c]; }
      const bd = this.regs[7] & 0x0F;
      return [this.palette[bd], this.idxKindCur ? this._toGrb(bd) : bd];
    }
    _toGrb(palIdx) { const p = this.paletteRaw[palIdx]; return (((p >> 4) & 7) << 5) | (((p >> 8) & 7) << 2) | ((p & 7) >> 1); } // パレット → GRB332(G7 の索引に混ぜる時)
    _fillBorders() {
      const [c, ci] = this._borderColor();
      const ow = this.outW, y0 = this.frameY0, y1 = y0 + this.displayLines;
      if (this.ilCur) { for (let r = 0; r < H; r++) if (r < y0 || r >= y1) { const b = (r * 2 + this.field) * ow; this.frame.fill(c, b, b + ow); } }
      else { this.frame.fill(c, 0, y0 * ow); this.frame.fill(c, y1 * ow, H * ow); }
      if (!this.ilCur || this.field === 0) { this.frameIdx.fill(ci, 0, y0 * W); this.frameIdx.fill(ci, y1 * W); }
    }

    // 表示行 y(0〜displayLines-1)を描く
    _renderLine(y) {
      const regs = this.regs;
      const fy = this.frameY0 + y;
      if (fy >= H) return;
      const lb = this.lineBuf;
      const mode = this.mode;
      const mw = this.modeWidth;
      const g7 = mode === 28 && !this.isTms;
      let spritesOn = false;
      if (!this.displayEnabled) { lb.fill(0, 0, mw); }
      else {
        // 縦スクロール(V9938 R23): パターン行/ビットマップ行をずらす
        const sy = this.isTms ? y : ((y + regs[23]) & 0xFF);
        const yjk = g7 && this.isV9958 && (regs[25] & 0x08) !== 0;
        // 横スクロール(V9958 R26/R27): SP2 の 2 ページはビットマップでだけ(ページは R26 bit5 が R2 bit5 の代わり)
        const hs = this.isV9958 && ((regs[26] & 0x1F) || (regs[27] & 0x07));
        const sp2 = hs && (regs[25] & 0x01) && (mode === 12 || mode === 16 || mode === 20 || mode === 28);
        const r2eo = regs[2];
        if (this.eoCur && (mode === 12 || mode === 16 || mode === 20 || mode === 28)) regs[2] = (r2eo & ~0x20) | (this.field << 5); // EO: 偶奇フィールドでページ 0/1
        const r2 = regs[2];
        if (sp2) regs[2] = (r2 & ~0x20) | (regs[26] & 0x20);
        this._lineBg(mode, sy, lb, mw, yjk ? this.lineRgb : null);
        if (hs) this._hScroll(mode, sy, mw, sp2, yjk);
        if (sp2) regs[2] = r2;
        regs[2] = r2eo;
        if (yjk) this.yjkBg.set(lb.subarray(0, W)); // スプライトの前の背景(合成で「スプライトが上書きした所」を見分ける)
        if (mode !== 1 && mode !== 9 && !(regs[8] & 0x02)) {
          // スプライトの Y は縦スクロール後の行で比べる(V9938: スプライトも R23 で背景と一緒にずれる。2026-11-11、推定。
          //  画面の途中で R23 を変えるゲームで自機の表示が当たり判定より下にずれていた)
          if (this.isTms || mode === 0 || mode === 2 || mode === 4) this._spritesMode1(sy, lb, mw);
          else this._spritesMode2(sy, lb, mw, g7);
          spritesOn = true;
        }
      }
      void spritesOn;
      if (!this.isTms && (regs[18] & 0x0F)) this._hAdjust(lb, mw, g7);
      // 合成: frame(フレームの幅 outW に合わせる)と frameIdx(常に 256)
      const ow = this.outW, row = this._row(fy), base = row * ow, pal = this.palette, tp = !this.isTms && (regs[8] & 0x20);
      const frame = this.frame, idx = this.frameIdx, ibase = fy * W, wIdx = !this.ilCur || this.field === 0; // 巻き戻し用の索引は偶数フィールドだけ
      const [bdc, bdi] = this._borderColor();
      const kind = this.idxKindCur;
      if (g7) {
        // G7: lb は 8bit 色(ボーダー色 R7 を透明 0 の代わりに使う: 背景の 0 は黒ではなく 0 色そのもの。スプライトは _spritesMode2 が 8bit 色に直して上書き済み)
        // YJK(V9958): 背景の正確な色は lineRgb。lb が背景のまま(スプライトに上書きされていない)なら lineRgb を出す
        const yjk = this.isV9958 && this.displayEnabled && (regs[25] & 0x08) !== 0, rgb = this.lineRgb, bgc = this.yjkBg;
        for (let x = 0; x < W; x++) {
          const c = lb[x];
          const col = (yjk && c === bgc[x]) ? rgb[x] : G7_PALETTE[c];
          if (ow === W) { frame[base + x] = col; } else { frame[base + x * 2] = col; frame[base + x * 2 + 1] = col; }
          if (wIdx) idx[ibase + x] = kind ? c : (c & 0x0F);
        }
        void bdc; void bdi;
        this._maskLeft(fy, row, ow);
        return;
      }
      for (let x = 0; x < mw; x++) {
        let c = lb[x];
        if (c === 0 && !tp) c = regs[7] & 0x0F;
        const col = pal[c];
        if (ow === mw) frame[base + x] = col;
        else if (ow === WIDE) { frame[base + x * 2] = col; frame[base + x * 2 + 1] = col; }
        else if (!(x & 1)) frame[base + (x >> 1)] = col;
        if (!wIdx) continue;
        if (mw === W) idx[ibase + x] = kind ? this._toGrb(c) : c;
        else if (!(x & 1)) idx[ibase + (x >> 1)] = kind ? this._toGrb(c) : c;
      }
      this._maskLeft(fy, row, ow);
    }
    // 横の set adjust(R18 下位 4bit): 表示全体(背景+スプライト)を横にずらす。0=中央、1〜7=左へ 1〜7、8〜15=右へ 8〜1 ドット(幅 512 のモードは 2 倍)。
    // 空いた所はボーダー色。2026-11-11(画面の途中で R18 を 8/A/C/E と変えて 2 ドットずつ横スクロールするゲームで、背景が 8 ドットずつ飛んでいた)
    _hAdjust(lb, mw, g7) {
      const h = this.regs[18] & 0x0F, sh = -(((h ^ 8) - 8)) * (mw / W);
      const fill = g7 ? this.regs[7] : (this.regs[7] & 0x0F);
      const yjk = g7 && this.isV9958 && (this.regs[25] & 0x08) !== 0;
      for (const a of yjk ? [lb, this.lineRgb, this.yjkBg] : [lb]) {
        const f = a === lb ? fill : (a === this.yjkBg ? -1 : G7_PALETTE[this.regs[7]]);
        if (sh > 0) { a.copyWithin(sh, 0, mw - sh); a.fill(f, 0, sh); }
        else { a.copyWithin(0, -sh, mw); a.fill(f, mw + sh, mw); }
      }
    }
    // 背景の 1 行をモードで描く(lb に色番号/G7 は 8bit 色。rgb を渡すと YJK として lineRgb に表示色も)
    _lineBg(mode, sy, lb, mw, rgb) {
      switch (mode) {
        case 0: this._lineG1(sy, lb); break;                 // GRAPHIC1 (SCREEN 1)
        case 1: this._lineT1(sy, lb); break;                 // TEXT1 (SCREEN 0)
        case 2: this._lineMC(sy, lb); break;                 // MULTICOLOR (SCREEN 3)
        case 4: this._lineG2(sy, lb); break;                 // GRAPHIC2 (SCREEN 2)
        case 8: this._lineG2(sy, lb); break;                 // GRAPHIC3 (SCREEN 4): 背景は G2 と同じ、スプライトはモード 2
        case 9: if (this.isTms) { this.unsupportedMode = true; lb.fill(0, 0, mw); } else this._lineT2(sy, lb); break; // TEXT2 (SCREEN 0 WIDTH 80)
        case 12: this._lineG4(sy, lb); break;                // GRAPHIC4 (SCREEN 5)
        case 16: this._lineG5(sy, lb); break;                // GRAPHIC5 (SCREEN 6)
        case 20: this._lineG6(sy, lb); break;                // GRAPHIC6 (SCREEN 7)
        case 28: if (rgb) this._lineYjk(sy, lb, rgb); else this._lineG7(sy, lb); break; // GRAPHIC7 (SCREEN 8) / YJK (SCREEN 10-12)
        default: this.unsupportedMode = true; lb.fill(0, 0, mw); break;
      }
    }
    // 横スクロール(V9958): lb(と YJK の lineRgb)を R26/R27 ぶんずらす。幅 512 のモードは 2 倍。SP2 はもう一方のページ(R2 bit5 を反転)を
    // 右側(と、R27 で右にずれた左端)に続ける。SP2 でなければ同じページで巻く
    _hScroll(mode, sy, mw, sp2, yjk) {
      const regs = this.regs, lb = this.lineBuf, A = this.lineTmpA, B = this.lineTmpB, rgb = this.lineRgb, rgbA = this.lineRgbA, rgbB = this.lineRgbB;
      const unit = mw === WIDE ? 2 : 1;
      const x0 = (((regs[26] & 0x1F) << 3) - (regs[27] & 0x07)) * unit; // 画面の左端に出る元の x(負あり)
      A.set(lb.subarray(0, mw)); if (yjk) rgbA.set(rgb);
      if (sp2) { regs[2] ^= 0x20; this._lineBg(mode, sy, B, mw, yjk ? rgbB : null); regs[2] ^= 0x20; }
      for (let x = 0; x < mw; x++) {
        let sx = x + x0, other = false;
        if (sx < 0) { sx += mw; other = true; } else if (sx >= mw) { sx -= mw; other = true; }
        const src = (sp2 && other) ? B : A;
        lb[x] = src[sx];
        if (yjk) rgb[x] = (sp2 && other) ? rgbB[sx] : rgbA[sx];
      }
    }
    // 左 8 ドット(幅 512 は 16)をボーダー色で隠す(V9958 R25 bit1 MSK)。横スクロールの R27 で欠けた端を隠すための物
    _maskLeft(fy, row, ow) {
      if (!this.isV9958 || !(this.regs[25] & 0x02)) return;
      const [c, ci] = this._borderColor();
      const n = ow === WIDE ? 16 : 8, base = row * ow;
      for (let x = 0; x < n; x++) this.frame[base + x] = c;
      if (!this.ilCur || this.field === 0) for (let x = 0; x < 8; x++) this.frameIdx[fy * W + x] = ci;
    }
    // YJK(V9958 SCREEN 10-12): 4 ドット 1 組。各バイトの bit7-3 が Y(5bit)、bit2-0 が 4 バイトで K(下位 3+上位 3、符号つき 6bit)と J。
    //   R = Y + J、G = Y + K、B = (5Y - 2J - K) / 4(各 0-31 に飽和、5bit → 8bit は ×255/31)。YAE(R25 bit4)のとき bit3=1 のドットはパレット bit7-4
    // lb には GRB332 への丸め(索引/スプライト合成/巻き戻しの画用)、rgb に表示色
    _lineYjk(y, lb, rgb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x20) << 11) + (y << 8);
      const yae = (this.regs[25] & 0x10) !== 0, pal = this.palette;
      for (let x = 0; x < 256; x += 4) {
        const b0 = vram[(base + x) & m], b1 = vram[(base + x + 1) & m], b2 = vram[(base + x + 2) & m], b3 = vram[(base + x + 3) & m];
        let k = (b0 & 7) | ((b1 & 7) << 3), j = (b2 & 7) | ((b3 & 7) << 3);
        if (k & 0x20) k -= 64; if (j & 0x20) j -= 64;
        for (let i = 0; i < 4; i++) {
          const b = i === 0 ? b0 : i === 1 ? b1 : i === 2 ? b2 : b3;
          if (yae && (b & 0x08)) { const p = b >> 4; rgb[x + i] = pal[p]; lb[x + i] = this._toGrb(p); continue; }
          const yy = b >> 3;
          let r = yy + j, g = yy + k, bl = ((5 * yy - 2 * j - k) >> 2);
          r = r < 0 ? 0 : r > 31 ? 31 : r; g = g < 0 ? 0 : g > 31 ? 31 : g; bl = bl < 0 ? 0 : bl > 31 ? 31 : bl;
          rgb[x + i] = abgr(LEVEL5[r], LEVEL5[g], LEVEL5[bl]);
          lb[x + i] = ((g >> 2) << 5) | ((r >> 2) << 2) | (bl >> 3);
        }
      }
    }
    _lineG1(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10, ct = regs[3] << 6, pg = (regs[4] & 0x3F) << 11;
      const row = y >> 3, pr = y & 7;
      for (let col = 0; col < 32; col++) {
        const ch = vram[(nt + row * 32 + col) & m];
        const pat = vram[(pg + ch * 8 + pr) & m];
        const color = vram[(ct + (ch >> 3)) & m];
        const fg = color >> 4, bg = color & 0x0F;
        for (let b = 0; b < 8; b++) lb[col * 8 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    _lineG2(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10;
      const row = y >> 3, pr = y & 7, block = row >> 3;
      // 色表/パターン表の基準とマスク(R3 bit7 / R4 bit2 が基準、下位ビットはマスク)。V9938 は R10 が色表の上位
      const ctBase = (((regs[10] & 0x07) << 8) | (regs[3] & 0x80)) << 6, ctMask = ((regs[3] & 0x7F) << 6) | 0x3F;
      const pgBase = (regs[4] & 0x3C) << 11, pgMask = ((regs[4] & 0x03) << 11) | 0x7FF;
      for (let col = 0; col < 32; col++) {
        const ch = vram[(nt + row * 32 + col) & m];
        const off = ((block << 11) | (ch << 3) | pr);
        const pat = vram[(pgBase | (off & pgMask)) & m];
        const color = vram[(ctBase | (off & ctMask)) & m];
        const fg = color >> 4, bg = color & 0x0F;
        for (let b = 0; b < 8; b++) lb[col * 8 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    _lineMC(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10, pg = (regs[4] & 0x3F) << 11;
      const row = y >> 3, sub = (y >> 2) & 1;
      for (let col = 0; col < 32; col++) {
        const ch = vram[(nt + row * 32 + col) & m];
        const color = vram[(pg + ch * 8 + ((row & 3) << 1) + sub) & m];
        const left = color >> 4, right = color & 0x0F;
        for (let b = 0; b < 4; b++) { lb[col * 8 + b] = left; lb[col * 8 + 4 + b] = right; }
      }
    }
    _lineT1(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10, pg = (regs[4] & 0x3F) << 11;
      const fg = regs[7] >> 4, bg = regs[7] & 0x0F;
      const row = y >> 3, pr = y & 7;
      for (let x = 0; x < 8; x++) { lb[x] = bg; lb[248 + x] = bg; } // 左右 8 ドットはボーダー(背景色)
      for (let col = 0; col < 40; col++) {
        const ch = vram[(nt + row * 40 + col) & m];
        const pat = vram[(pg + ch * 8 + pr) & m];
        for (let b = 0; b < 6; b++) lb[8 + col * 6 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    // TEXT2(80 桁、幅 512): 名前表 R2 bit6-2 ×$1000(80×27 行)、パターン R4、点滅表 R3/R10(未対応: 文字色で描く)。左右 16 ドットは背景色
    _lineT2(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7C) << 10, pg = (regs[4] & 0x3F) << 11;
      const fg = regs[7] >> 4, bg = regs[7] & 0x0F;
      const row = y >> 3, pr = y & 7;
      for (let x = 0; x < 16; x++) { lb[x] = bg; lb[496 + x] = bg; }
      for (let col = 0; col < 80; col++) {
        const ch = vram[(nt + row * 80 + col) & m];
        const pat = vram[(pg + ch * 8 + pr) & m];
        for (let b = 0; b < 6; b++) lb[16 + col * 6 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    // ビットマップ(V9938)。名前表の基準: G4/G5 は R2 bit6-5(A16-15)、G6/G7 は R2 bit5(A16)
    _lineG4(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x60) << 10) + (y << 7);
      for (let x = 0; x < 128; x++) { const b = vram[(base + x) & m]; lb[x * 2] = b >> 4; lb[x * 2 + 1] = b & 0x0F; }
    }
    _lineG5(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x60) << 10) + (y << 7);
      for (let x = 0; x < 128; x++) { const b = vram[(base + x) & m]; lb[x * 4] = b >> 6; lb[x * 4 + 1] = (b >> 4) & 3; lb[x * 4 + 2] = (b >> 2) & 3; lb[x * 4 + 3] = b & 3; }
    }
    _lineG6(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x20) << 11) + (y << 8);
      for (let x = 0; x < 256; x++) { const b = vram[(base + x) & m]; lb[x * 2] = b >> 4; lb[x * 2 + 1] = b & 0x0F; }
    }
    _lineG7(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x20) << 11) + (y << 8);
      for (let x = 0; x < 256; x++) lb[x] = vram[(base + x) & m];
    }
    // スプライトモード 1(TMS/G1/G2/MC): 行に 4 枚まで、5 枚目で 5S、重なりで C。色 0 は透明。EC(bit7)で 32 ドット左へ
    _spritesMode1(y, lb, mw) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const sat = ((regs[5] & 0x7F) << 7) | (this.isTms ? 0 : ((regs[11] & 0x03) << 15));
      const spg = (regs[6] & 0x3F) << 11;
      const size = (regs[1] & 0x02) ? 16 : 8, mag = (regs[1] & 0x01) ? 2 : 1, h = size * mag;
      const sb = this.sprBuf; sb.fill(0);
      let count = 0, collision = false;
      for (let i = 0; i < 32; i++) {
        const a = (sat + i * 4) & m;
        let sy = vram[a];
        if (sy === 0xD0) break; // 終端
        sy = sy > 0xE0 ? sy - 0x100 : sy; // 画面上端より上
        const top = sy + 1;
        const d = this.isTms ? y - top : ((y - top) & 0xFF); // V9938 は 8bit で折り返す(縦スクロールで行が 255 を越える)
        if (d < 0 || d >= h) continue;
        if (count === 4) { if (!(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x40 | (i & 0x1F); break; }
        count++;
        let sx = vram[a + 1];
        const pat = vram[a + 2], attr = vram[a + 3];
        const color = attr & 0x0F;
        if (attr & 0x80) sx -= 32;
        const ly = (d / mag) | 0;
        const pbase = spg + ((size === 16 ? (pat & 0xFC) : pat) << 3);
        for (let px = 0; px < size; px++) {
          const byte = vram[(pbase + ly + ((px >> 3) << 4)) & m];
          if (!(byte & (0x80 >> (px & 7)))) continue;
          for (let k = 0; k < mag; k++) {
            const x = sx + px * mag + k;
            if (x < 0 || x >= W) continue;
            if (sb[x]) { collision = true; continue; } // 先に描いた(番号の小さい)方が手前
            sb[x] = 0x10 | color; // 色 0 でも「ここにスプライトがある」印(衝突判定に要る)
          }
        }
      }
      if (collision) this.status[0] |= 0x20;
      if (count < 5 && !(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x1F; // 5 枚目が無い間は番号 31
      this._composeSprites(lb, mw, false);
    }
    // スプライトモード 2(G3〜G7): 行に 8 枚まで(9 枚目で 5S)、行ごとの色(属性表-$200 の色表、16 バイト/枚: bit7 EC、bit6 CC、bit5 IC、bit3-0 色)。
    // CC=1 は重なった所で先に描いた物と色を OR(衝突しない)。IC=1 は衝突を数えない。Y の終端は $D8
    _spritesMode2(y, lb, mw, g7) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const sat = ((regs[11] & 0x03) << 15) | ((regs[5] & 0xFC) << 7);
      const sct = (sat - 0x200) & 0x1FFFF;
      const spg = (regs[6] & 0x3F) << 11;
      const size = (regs[1] & 0x02) ? 16 : 8, mag = (regs[1] & 0x01) ? 2 : 1, h = size * mag;
      const sb = this.sprBuf; sb.fill(0);
      const owner = this._sprOwner || (this._sprOwner = new Uint8Array(W)); owner.fill(0); // その x の最前面のスプライト(1+番号)。IC/CC 判定用
      let count = 0, collision = false;
      for (let i = 0; i < 32; i++) {
        const a = (sat + i * 4) & m;
        let sy = vram[a];
        if (sy === 0xD8) break;
        sy = sy > 0xE0 ? sy - 0x100 : sy;
        const top = sy + 1;
        const d = this.isTms ? y - top : ((y - top) & 0xFF); // V9938 は 8bit で折り返す(縦スクロールで行が 255 を越える)
        if (d < 0 || d >= h) continue;
        if (count === 8) { if (!(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x40 | (i & 0x1F); break; }
        count++;
        const ly = (d / mag) | 0;
        const cattr = vram[(sct + i * 16 + ly) & m];
        let sx = vram[a + 1];
        const pat = vram[a + 2];
        const color = cattr & 0x0F, ec = cattr & 0x80, cc = cattr & 0x40, ic = cattr & 0x20;
        if (ec) sx -= 32;
        const pbase = spg + ((size === 16 ? (pat & 0xFC) : pat) << 3);
        for (let px = 0; px < size; px++) {
          const byte = vram[(pbase + ly + ((px >> 3) << 4)) & m];
          if (!(byte & (0x80 >> (px & 7)))) continue;
          for (let k = 0; k < mag; k++) {
            const x = sx + px * mag + k;
            if (x < 0 || x >= W) continue;
            if (sb[x]) {
              if (cc) { sb[x] |= color; continue; }    // CC: 手前の物と OR
              if (!ic) collision = true;
              continue;
            }
            if (cc) continue; // CC のスプライトは手前の物が無い所には出ない
            sb[x] = 0x10 | color; owner[x] = i + 1;
          }
        }
      }
      if (collision) this.status[0] |= 0x20;
      if (count < 9 && !(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x1F;
      this._composeSprites(lb, mw, g7);
    }
    // スプライトの行を背景の上に(色 0 は透明)。幅 512 のモードはスプライトの 1 ドット=2 ドット。G7 は固定の 8bit 色に
    _composeSprites(lb, mw, g7) {
      const sb = this.sprBuf;
      if (g7) { for (let x = 0; x < W; x++) { const c = sb[x] & 0x0F; if (sb[x] && c) lb[x] = G7_SPRITE_COLOR[c]; } return; }
      if (mw === W) { for (let x = 0; x < W; x++) { const c = sb[x] & 0x0F; if (sb[x] && c) lb[x] = c; } return; }
      for (let x = 0; x < W; x++) { const c = sb[x] & 0x0F; if (sb[x] && c) { lb[x * 2] = c; lb[x * 2 + 1] = c; } }
    }

    // ── VDP コマンド(V9938) ──
    // ビットマップのドット単位アクセス。モードごとの 1 行のバイト数と 1 バイトのドット数
    _pixInfo() {
      switch (this.mode) {
        case 12: return { shift: 7, ppb: 2, w: 256 }; // G4: 128 バイト/行、2 ドット/バイト
        case 16: return { shift: 7, ppb: 4, w: 512 }; // G5
        case 20: return { shift: 8, ppb: 2, w: 512 }; // G6
        case 28: return { shift: 8, ppb: 1, w: 256 }; // G7
        default: return (this.isV9958 && (this.regs[25] & 0x40)) ? { shift: 8, ppb: 1, w: 256 } : null; // V9958 R25 CMD: ビットマップ以外でも G7 の配置で動く(推定)
      }
    }
    _addrOf(pi, x, y) { return (((y & 0x3FF) << pi.shift) + ((x & (pi.w - 1)) / pi.ppb | 0)) & this.vramMask; }
    _readPix(pi, x, y) {
      const b = this.vram[this._addrOf(pi, x, y)];
      if (pi.ppb === 1) return b;
      if (pi.ppb === 2) return (x & 1) ? (b & 0x0F) : (b >> 4);
      return (b >> ((3 - (x & 3)) * 2)) & 3;
    }
    _writePix(pi, x, y, c, lop) {
      const a = this._addrOf(pi, x, y);
      const old = this.vram[a];
      let mask, shift;
      if (pi.ppb === 1) { mask = 0xFF; shift = 0; }
      else if (pi.ppb === 2) { shift = (x & 1) ? 0 : 4; mask = 0x0F << shift; }
      else { shift = (3 - (x & 3)) * 2; mask = 0x03 << shift; }
      const cur = (old & mask) >> shift;
      c &= mask >> shift;
      if ((lop & 0x08) && c === 0) return; // 透明演算: 色 0 は書かない
      let nv;
      switch (lop & 0x07) {
        case 0: nv = c; break;
        case 1: nv = cur & c; break;
        case 2: nv = cur | c; break;
        case 3: nv = cur ^ c; break;
        case 4: nv = (~c) & (mask >> shift); break;
        default: nv = c; break;
      }
      this.vram[a] = (old & ~mask) | (nv << shift);
    }
    _cmdStart(v) {
      const c = this.cmd, r = this.regs;
      c.op = v >> 4; c.lop = v & 0x0F;
      if (c.op === 0) { c.tr = false; this.status[2] &= ~0x10; return; } // STOP
      if (!this._pixInfo()) { c.op = 0; c.tr = false; return; }          // ビットマップ以外では何もしない(V9938)
      c.sx = r[32] | ((r[33] & 1) << 8); c.sy = r[34] | ((r[35] & 3) << 8);
      c.dx = r[36] | ((r[37] & 1) << 8); c.dy = r[38] | ((r[39] & 3) << 8);
      c.nx = (r[40] | ((r[41] & 1) << 8)) || 512; c.ny = (r[42] | ((r[43] & 3) << 8)) || 1024;
      // LINE の NX/NY は長辺/短辺の長さそのもの(0 は 0。範囲のコマンドの「0 = 512/1024」は当てない)。2026-11-11: 短辺 0 の水平線/垂直線が
      //  1024 として斜め線になっていた(お絵描きソフトの格子、openMSX との突き合わせで判明)
      if ((v >> 4) === 0x7) { c.nx = r[40] | ((r[41] & 1) << 8); c.ny = r[42] | ((r[43] & 3) << 8); }
      c.clr = r[44]; c.arg = r[45];
      c.dix = (c.arg & 0x04) ? -1 : 1; c.diy = (c.arg & 0x08) ? -1 : 1;
      c.maj = (c.arg & 0x01); c.eq = (c.arg & 0x02);
      c.anx = 0; c.any = 0; c.budget = 0; c.lineAcc = 0;
      c.tr = false;
      this.status[2] &= ~0x10;
      const pi = this._pixInfo();
      // 横幅 NX は画面の端で打ち切る(右へ進むなら 幅-X、左へなら X+1。転送は転送元と転送先の両方で)。2026-11-11: SCREEN 5 で NX=512 の HMMC を
      //  出すゲームで、打ち切らないと 1 行で 2 行ぶんのデータを使って絵が崩れた(openMSX の clipNX の記憶による推定、ab.js で一致を確認)
      {
        const w = pi.w, room = (x) => c.dix > 0 ? w - (x & (w - 1)) : (x & (w - 1)) + 1;
        let lim = (c.op === 0xA) ? room(c.sx) : room(c.dx);
        if (c.op === 0xD || c.op === 0x9) lim = Math.min(lim, room(c.sx));
        if (c.op !== 0xE && c.op !== 0x4 && c.op !== 0x5 && c.op !== 0x6 && c.op !== 0x7) c.nx = Math.min(c.nx, lim);
      }
      // バイト単位のコマンド(HMMV/HMMM/YMMM/HMMC)は x をバイト境界に
      if (c.op === 0xC || c.op === 0xD || c.op === 0xE || c.op === 0xF) { const q = pi.ppb; c.nx = Math.max(1, (c.nx / q) | 0) * q; }
      switch (c.op) {
        case 0xF: case 0xB: c.tr = true; this._cmdData(c.clr); break; // HMMC/LMMC: 開始時の R44(CLR)が最初のデータ。以後は CPU の R44 書き込み待ち
        case 0xA: this._lmcmFetch(); break;                           // LMCM: 最初のドットを S7 へ
        case 0x4: { this.status[7] = this._readPix(pi, c.sx, c.sy); c.op = 0; break; } // POINT: 即時
        case 0x5: { this._writePix(pi, c.dx, c.dy, c.clr, c.lop); c.op = 0; break; }   // PSET: 即時(時間は無視)
        case 0x6: c.budget = 0; break;                                // SRCH
        default: break;
      }
    }
    _cmdCost() {
      const c = this.cmd;
      const t = CMD_TICKS[c.op]; if (!t) return 10;
      if (!this.displayEnabled || this.inVBlank) return t[0] / 6;
      const m = this.mode, spr = m !== 1 && m !== 9 && !(this.regs[8] & 0x02); // テキスト(T1/T2)はスプライト無し、R8 bit1 SPD=1 で消える
      return t[spr ? 1 : 2] / 6;
    }
    // 時間を進めてコマンドを実行する(HMMC/LMMC は CPU 駆動なのでここでは進まない)
    _cmdRun(cycles) {
      const c = this.cmd;
      if (c.op === 0xF || c.op === 0xB || c.op === 0xA) return;
      const pi = this._pixInfo();
      if (!pi) { c.op = 0; return; }
      c.budget += cycles;
      const cost = this._cmdCost();
      let guard = 0;
      while (c.op && c.budget >= cost && ++guard < 100000) {
        c.budget -= cost;
        this._cmdStep(pi);
      }
    }
    _cmdStep(pi) {
      const c = this.cmd;
      switch (c.op) {
        case 0xC: { // HMMV: バイト塗り
          this.vram[this._addrOf(pi, c.dx + c.anx * c.dix, c.dy)] = c.clr;
          c.anx += pi.ppb; if (c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0xD: { // HMMM: バイト転送
          this.vram[this._addrOf(pi, c.dx + c.anx * c.dix, c.dy)] = this.vram[this._addrOf(pi, c.sx + c.anx * c.dix, c.sy)];
          c.anx += pi.ppb; if (c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0xE: { // YMMM: 縦方向の転送(DX から行末まで)
          const x = c.dx + c.anx * c.dix;
          this.vram[this._addrOf(pi, x, c.dy)] = this.vram[this._addrOf(pi, x, c.sy)];
          c.anx += pi.ppb;
          const remain = c.dix > 0 ? (pi.w - c.dx) : (c.dx + 1);
          if (c.anx >= remain) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0x8: { // LMMV: ドット塗り(論理演算)
          this._writePix(pi, c.dx + c.anx * c.dix, c.dy, c.clr, c.lop);
          if (++c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0x9: { // LMMM: ドット転送(論理演算)
          this._writePix(pi, c.dx + c.anx * c.dix, c.dy, this._readPix(pi, c.sx + c.anx * c.dix, c.sy), c.lop);
          if (++c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0x7: { // LINE: 長辺 NX(MAJ=0: X が長辺)、短辺 NY。ブレゼンハム
          this._writePix(pi, c.dx, c.dy, c.clr, c.lop);
          const maj = c.nx, min = c.ny;
          if (c.anx >= maj) { c.op = 0; break; }
          c.anx++;
          c.lineAcc += min;
          if (c.maj === 0) { c.dx += c.dix; if (c.lineAcc >= maj) { c.lineAcc -= maj; c.dy = (c.dy + c.diy) & 0x3FF; } }
          else { c.dy = (c.dy + c.diy) & 0x3FF; if (c.lineAcc >= maj) { c.lineAcc -= maj; c.dx += c.dix; } }
          if (c.dx < 0 || c.dx >= pi.w) c.op = 0;
          break;
        }
        case 0x6: { // SRCH: SX から横に CLR と同じ(EQ=0)/違う(EQ=1)色を探す。見つかれば BD と S8/S9
          const x = c.sx + c.anx * c.dix;
          if (x < 0 || x >= pi.w) { this.status[2] &= ~0x10; c.op = 0; break; }
          const p = this._readPix(pi, x, c.sy);
          const hit = c.eq ? (p !== c.clr) : (p === c.clr);
          if (hit) { this.status[2] |= 0x10; this.status[8] = x & 0xFF; this.status[9] = (x >> 8) & 1; c.op = 0; break; }
          c.anx++;
          break;
        }
        default: c.op = 0; break;
      }
      if (!c.op) c.tr = false;
    }
    // R44 への書き込み: HMMC/LMMC の 1 ドット(バイト)
    _cmdData(v) {
      const c = this.cmd;
      if (!(c.op === 0xF || c.op === 0xB) || !c.tr) return;
      const pi = this._pixInfo();
      if (!pi) { c.op = 0; c.tr = false; return; }
      if (c.op === 0xF) {
        this.vram[this._addrOf(pi, c.dx + c.anx * c.dix, c.dy)] = v;
        c.anx += pi.ppb;
      } else {
        this._writePix(pi, c.dx + c.anx * c.dix, c.dy, v, c.lop);
        c.anx++;
      }
      if (c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; if (--c.ny <= 0) { c.op = 0; c.tr = false; } }
    }
    // LMCM: S7 に今のドットを置く / 読まれたら次へ
    _lmcmFetch() {
      const c = this.cmd, pi = this._pixInfo();
      if (!pi) { c.op = 0; return; }
      this.status[7] = this._readPix(pi, c.sx + c.anx * c.dix, c.sy);
      c.tr = true;
    }
    _lmcmNext() {
      const c = this.cmd;
      c.anx++;
      if (c.anx >= c.nx) { c.anx = 0; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) { c.op = 0; c.tr = false; return; } }
      this._lmcmFetch();
    }
  }
  MsxVdp.W = W; MsxVdp.WIDE = WIDE; MsxVdp.H = H;
  MsxVdp.CYCLES_PER_LINE = CYCLES_PER_LINE;
  MsxVdp.TMS_PALETTE = TMS_PALETTE;
  MsxVdp.G7_PALETTE = G7_PALETTE;
  Emu.MsxVdp = MsxVdp;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MSX のフロッピーディスク(DESIGN-MSX-CAPTURE.md §3.5、段階 7d) — MML.Emu.MsxDiskImage / Emu.WD2793 / Emu.TC8566AF / Emu.MsxDiskInterface
 *
 * ■ ディスク画像(.dsk、ヘッダ無しの生セクタ列。セクタ 512 バイト)
 *   720K = 2 面×80 トラック×9 セクタ、360K = 1 面×80×9、640K = 2×80×8、320K = 1×80×8。並びはトラック→面→セクタ(MSX-DOS/標準 .dsk)。
 *   書き込みは画像の配列に直接入れて dirty を立てる(本体のバッテリー保存で書き戻す)。
 * ■ FDC は 2 系統(機種で違う。ディスク ROM(利用者が用意)が叩く方に合わせる。設定 ⚙「ディスク」で選ぶ)
 *   WD2793(Philips/Sony 系): $7FF8 ステータス/コマンド、$7FF9 トラック、$7FFA セクタ、$7FFB データ、$7FFC 面(bit0)、$7FFD ドライブ(bit0-1)と
 *     モータ(bit7)、$7FFF 読み: bit6=~IRQ、bit7=~DRQ(負論理。openMSX PhilipsFDC と同じ)。$BFF8-$BFFF にも鏡像。
 *     コマンド: タイプ I(RESTORE/SEEK/STEP/STEP-IN/STEP-OUT。ステップ時間 r1r0=6/12/20/30ms)、タイプ II(READ/WRITE SECTOR、m=複数)、
 *     タイプ III(READ ADDRESS、READ TRACK は未対応=すぐ終わる、WRITE TRACK=フォーマットはバイトを飲み込むだけ)、タイプ IV(FORCE INTERRUPT)。
 *     データは 1 バイトごとに DRQ。
 *   TC8566AF(松下/turboR。μPD765 互換): $7FF8 制御 0(bit0-1 ドライブ、bit2=1 で動作、bit4-7 ドライブごとのモータ)、$7FF9 制御 1、$7FFA メインステータス(読み:
 *     RQM bit7、DIO bit6、NDM bit5、CB bit4)、$7FFB データ、$7FF9 bit0 TC(転送の打ち切り)。コマンド: SPECIFY/SENSE DRIVE STATUS/RECALIBRATE/SENSE INTERRUPT STATUS/SEEK/
 *     READ DATA/WRITE DATA/READ ID/FORMAT TRACK(非 DMA、結果 7 バイト)。無効コマンドは ST0=$80。割り込み線は MSX では使わない(ポーリング)。
 * ■ インターフェース(MsxDiskInterface): スロット 3-1 に置く。$4000-$7FFF がディスク ROM(16K。32K は前半だけ)、末尾 8 バイトが FDC のレジスタ。
 *   ドライブは A/B の 2 台(images[] から入れる。insertDisk(n) はドライブ A に n 番の画像)。
 * 時間は本体が clock(cycles) で進める(Z80 サイクル)。
 * ■ 実機の時間(2026-11-12。録音が主体なので読み込みの間も実機どおりに。速くしたい時は再生側がアクセス中だけ早送りする)
 *   ディスクは 300rpm(1 周 200ms)で回り続け、1 周 6250 バイト(250kbps MFM、1 バイト 32µs)。トラックの並びは openMSX の
 *   セクタ型ディスクと同じ: 頭に 146 バイト(GAP4a 80+SYNC 12+IAM 4+GAP1 50)、セクタごとに 658 バイト(SYNC 12+IDAM 4+ID 4+CRC 2+GAP2 22+
 *   SYNC 12+DAM 4+データ 512+CRC 2+GAP3 84)。インターリーブ 1:1。角度はドライブごとにモータが回っていた時間の累計(spin)で決める(openMSX の RealDrive と同じく、モータが止まると角度も止まる。電源投入時は 0)。
 *   READ/WRITE SECTOR はそのセクタの ID が頭を通るまで待ち、データは 32µs ごとに 1 バイト。WD2793 の読みは、CPU が読む前に次のバイトが
 *   来ていたらロストデータ(ステータス bit2)を立て、データレジスタは来ている一番新しいバイトになる(openMSX と同じ。ディスク ROM はこれで
 *   そのセクタを読み直し、1 周ぶん遅れる)。セクタを読み終わらないうちに CRC が過ぎたら、ロストデータで終わる。無いセクタはインデックス 5 回で RNF。E(ヘッド整定)は 30ms(1MHz 時)。タイプ I の V(照合)は時間を足さない。
 *   1 セクタの READ は最後のバイトを読んだ時点で終わり、複数セクタ(m)はその場から次のセクタを探す。
 *   INDEX(タイプ I の bit1)はモータが回っている間、1 周に 1 回 4ms。TRACK0 もモータが止まっていると見えない(openMSX の RealDrive.isTrack00 と同じ)。
 *   そのため WD2793 の RESTORE はモータが止まっていると 255 ステップ(トラックレジスタ $FF→0。openMSX と同じ 278→369 フレームを実測)で諦める
 *   (途中でモータが回り出したら次のステップで終わる)、TC8566AF の RECALIBRATE は
 *   255 ステップして EC(装置チェック)。ディスク ROM は起動時にこれをタイムアウトで抜けるので、起動が実機どおり数秒かかる。
 *   TC8566AF: SPECIFY のステップ (16-SRT)ms、ヘッドロード 2×HLT ms(ヘッドが降りている時だけ)、ヘッドアンロード 16×HUT ms(コマンドの終わりから)。
 *   SEEK/RECALIBRATE はその場で終わり裏でステップ(1 歩目はすぐ、N 歩で N×ステップ後にシーク終了 SE)、その間メインステータスの D0B/D1B が立つ。
 *   SENSE INTERRUPT STATUS はいつでも ST0 と PCN の 2 バイト(シーク中は SE の無い ST0=0)。データの 1 バイト目は ID の FE が通った時点
 *   (ギャップを待たない)。READ ID は次に通る ID のセクタ番号を返す。
 *   ★時間の決め方は openMSX(src/fdc/TC8566AF.cc、WD2793.cc、RealDrive.cc)に揃えた。tools/openmsx/disk-timing.js で読んだバイト数のフレーム推移を比べる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SECTOR = 512;
  const CPU_HZ = 3579545;
  const ms = (n) => Math.round(CPU_HZ * n / 1000);
  // 回転と並び(上の説明)
  const ROT = CPU_HZ * 0.2;          // 1 周(サイクル)
  const TRACK_BYTES = 6250;
  const BYTE = ROT / TRACK_BYTES;    // 1 バイト(約 114.5 サイクル)
  const GAP_HEAD = 146, SEC_LEN = 658;
  const ID_MARK = 12, ID_LEN = 10, DATA_OFF = 60; // セクタの頭から: A1 A1 A1 FE の始まり、そこから C H R N CRC の終わりまで、データの始まり
  const INDEX_LEN = ROT / 50;        // インデックス穴が見えている長さ(4ms)
  // from 以降で角度が off(バイト)になる時刻
  // ph: そのドライブの角度と FDC の時刻の差(drive.spin - fdc.now。モータが回っている間は一定)
  function nextAt(off, from, ph) {
    const a = off * BYTE, r = (from + ph) % ROT;
    let d = a - r; if (d < 0) d += ROT;
    return from + d;
  }
  // セクタ r の ID(A1 から CRC まで)を from 以降に読み終える時刻
  const idEndAt = (r, from, ph) => nextAt(GAP_HEAD + (r - 1) * SEC_LEN + ID_MARK, from, ph) + ID_LEN * BYTE;
  // from 以降で最初に頭を通る ID: { r, end(読み終える時刻) }
  function nextId(spt, from, ph) {
    let best = null;
    for (let r = 1; r <= spt; r++) { const e = idEndAt(r, from, ph); if (!best || e < best.end) best = { r, end: e }; }
    return best;
  }

  class MsxDiskImage {
    constructor(bytes) {
      this.img = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const n = this.img.length;
      // 面数とセクタ数を大きさから
      if (n === 737280) { this.sides = 2; this.spt = 9; } else if (n === 368640) { this.sides = 1; this.spt = 9; }
      else if (n === 655360) { this.sides = 2; this.spt = 8; } else if (n === 327680) { this.sides = 1; this.spt = 8; }
      else { this.sides = n > 368640 ? 2 : 1; this.spt = 9; } // 不明: 720K/360K として扱う
      this.tracks = Math.max(1, Math.round(n / (this.sides * this.spt * SECTOR)));
      this.dirty = false;
      this.writeProtect = false;
    }
    static isDsk(bytes) { const n = bytes.length; return n === 737280 || n === 368640 || n === 655360 || n === 327680; }
    offset(track, side, sector) { return ((track * this.sides + side) * this.spt + (sector - 1)) * SECTOR; }
    hasSector(track, side, sector) { return track >= 0 && track < this.tracks && side >= 0 && side < this.sides && sector >= 1 && sector <= this.spt; }
    readByte(track, side, sector, i) { return this.img[this.offset(track, side, sector) + i]; }
    writeByte(track, side, sector, i, v) { const o = this.offset(track, side, sector) + i; if (this.img[o] !== v) { this.img[o] = v; this.dirty = true; } }
  }

  class Drive {
    constructor() { this.image = null; this.track = 0; this.side = 0; this.motor = false; this.access = 0; this.spin = 0; this.changed = false; } // changed: ディスクが入れ替わった(Philips の $7FFD bit2 が 0 になる。読むと消える) // spin: モータが回っていた時間の累計(サイクル。ディスクの角度) // access: 読み書きしたバイト数(アクセスランプ用。増えたら点ける)
    get ready() { return !!this.image; }
  }

  // ── WD2793 ──
  const STEP_MS = [6, 12, 20, 30];
  class WD2793 {
    constructor(drives) {
      this.drives = drives;
      this.drive = drives[0];
      this.reset();
    }
    reset() {
      this.status = 0; this.track = 0; this.sector = 1; this.data = 0;
      this.cmd = 0; this.busy = false; this.drq = false; this.irq = false;
      this.dirIn = true;         // ステップの向き(1=内側)
      this.now = this.now || 0;  // 通算サイクル(ディスクの角度。リセットでも回り続ける)
      this.due = 0;              // 次の出来事の時刻(0 = 無し)
      this.t0 = 0;               // 今のデータ(セクタのデータ/ID/トラック)の 1 バイト目が頭に来る時刻
      this.writing = false;
      this.restoring = 0;        // モータ待ちの RESTORE(ステップの間隔)
      this.hldTime = Infinity;   // ヘッドを載せた時刻(HLD の 3 秒の起点)
      this.typeI = true;         // 最後のコマンドがタイプ I か IV(ステータスの bit1・bit2 の意味が変わる)
      this.phase = 0;            // 0 無し、1 タイプ I、2 読み、3 書き、4 READ ADDRESS、5 WRITE TRACK、6 READ TRACK、7 エラー終了待ち、9 セクタの終わり(CRC)
      this.pos = 0; this.multi = false; this.addrBuf = null;
      this.sideSel = 0;
    }
    selectDrive(n) { this.drive = this.drives[n] || null; }
    setSide(s) { this.sideSel = s & 1; if (this.drive) this.drive.side = this.sideSel; }
    // ── レジスタ ──
    readStatus() {
      this.irq = false;
      let s = this.status;
      if (this.typeI) { // タイプ I(と IV)の形: bit2 TRACK0、bit1 INDEX(回転で点滅)、bit5 ヘッドロード。タイプ II/III の後は bit2 ロストデータ・bit1 DRQ のまま(終わった後も。ここを I の形にするとディスク ROM が TRACK0 をロストデータと読んで読み直しを繰り返した)
        s &= ~0x06;
        if (this.drive && this.drive.track === 0 && this.drive.motor) s |= 0x04;
        s = (s & ~0x20) | (this._hld() ? 0x20 : 0);
        if (this.drive && this.drive.ready && this.drive.motor && (this.drive.spin % ROT) < INDEX_LEN) s |= 0x02;
      }
      if (!this.drive || !this.drive.ready) s |= 0x80; else s &= ~0x80;
      if (this.drive && this.drive.image && this.drive.image.writeProtect) s |= 0x40;
      return (s & ~0x03) | (this.busy ? 0x01 : 0) | (this.drq ? 0x02 : 0);
    }
    readData() {
      if (this.phase === 2 && this.drq) { // 遅れて読んだ: その間に来たバイトで上書きされている
        const last = Math.min(SECTOR - 1, Math.floor((this.now - this.t0) / BYTE) - 1);
        if (last > this.pos) { this.status |= 0x04; this.pos = last; this._fetch(); }
      }
      const v = this.data; // 今のバイトを返してから次のバイトを用意する(先に進めると 1 バイト目が飛ぶ)
      if (this.drq && (this.phase === 2 || this.phase === 4 || this.phase === 6)) this._nextRead();
      return v;
    }
    writeData(v) {
      this.data = v & 0xFF;
      if (this.drq && (this.phase === 3 || this.phase === 5)) this._nextWrite(v & 0xFF);
    }
    writeCommand(v) {
      v &= 0xFF;
      const type4 = (v & 0xF0) === 0xD0;
      if (this.busy && !type4) return;
      this.irq = false;
      if (type4) { // FORCE INTERRUPT
        this.typeI = true;
        const was = this.busy;
        this.busy = false; this.drq = false; this.phase = 0; this.due = 0; this.restoring = 0;
        this.status &= ~0x01;
        if (v & 0x08 || !was) this.irq = true; // 即時割り込み(bit3)。待機中なら IRQ だけ
        return;
      }
      this.cmd = v;
      // ヘッドロード(HLD): タイプ I は h フラグの時だけ、タイプ II/III はいつも。そこから 3 秒(openMSX の IDLE。実機は 15 インデックス)。終わる時にまだ載っていれば延長
      this.hldTime = v < 0x80 ? ((v & 0x08) ? this.now : Infinity) : this.now;
      this.busy = true; this.drq = false; this.status = 0;
      const d = this.drive;
      this.typeI = v < 0x80;
      if (v < 0x80) { // タイプ I
        this.phase = 1;
        const rate = ms(STEP_MS[v & 3]);
        let steps = 0;
        const op = v >> 4;
        if (op === 0) { // RESTORE: TRACK0 が見えるまで外へ(モータが止まっていると見えないので、回り出すまで終わらない)
          steps = d ? d.track : 0; if (d) d.track = 0; this.track = 0; this.dirIn = true;
          if (d && !d.motor) { this.restoring = rate; this.due = this.now + 255 * rate; return; }
        }
        else if (op === 1) { const to = this.data; steps = d ? Math.abs(to - d.track) : 0; this.dirIn = to >= this.track; if (d) d.track = Math.max(0, Math.min(d.image ? d.image.tracks + 1 : 85, to)); this.track = to; } // SEEK(データレジスタへ)
        else {
          if (op >= 4 && op <= 5) this.dirIn = true; else if (op >= 6) this.dirIn = false;
          if (d) d.track = Math.max(0, Math.min(85, d.track + (this.dirIn ? 1 : -1)));
          if (v & 0x10) this.track = d ? d.track : this.track; // u: トラックレジスタも更新
          steps = 1;
        }
        if (v & 0x04 && d && d.ready && d.track !== this.track) this.status |= 0x10; // V: 照合(トラック不一致)
        this.due = this.now + steps * rate + 64;
        return;
      }
      const op = v & 0xF0;
      if (op === 0x80 || op === 0x90 || op === 0xA0 || op === 0xB0) { // READ/WRITE SECTOR
        this.multi = !!(v & 0x10);
        const write = op >= 0xA0;
        if (!d || !d.ready) { this.busy = false; this.irq = true; this.status |= 0x80; this.phase = 0; return; }
        const from = this.now + 64 + ((v & 0x04) ? ms(30) : 0); // E: ヘッド整定 30ms
        if (!d.image.hasSector(d.track, d.side, this.sector)) { this.status |= 0x10; this.due = nextAt(0, from, this._ph()) + 4 * ROT; this.phase = 7; return; } // RNF(インデックス 5 回)
        if (write && d.image.writeProtect) { this.status |= 0x40; this.due = from; this.phase = 7; return; }
        this.writing = write;
        this._seekSector(from);
        return;
      }
      if (op === 0xC0) { // READ ADDRESS: トラック、面、セクタ、サイズ(2=512)、CRC×2
        if (!d || !d.ready) { this.busy = false; this.irq = true; this.status |= 0x80; this.phase = 0; return; }
        const id = nextId(d.image.spt, this.now + 64 + ((v & 0x04) ? ms(30) : 0), this._ph());
        this.addrBuf = [d.track, d.side, id.r, 2, 0, 0]; this.pos = 0; this.phase = 4;
        this.t0 = id.end - 6 * BYTE; this.due = this.t0 + BYTE;
        return;
      }
      if (op === 0xE0) { this.phase = 6; this.pos = 0; this.t0 = nextAt(0, this.now + 64, this._ph()); this.due = this.t0 + BYTE; return; }  // READ TRACK(中身は $4E で埋める。インデックスから 1 周)
      if (op === 0xF0) { this.phase = 5; this.pos = 0; this.multi = false; this.t0 = nextAt(0, this.now + 3 * BYTE, this._ph()); this.due = this.now + 3 * BYTE; return; }  // WRITE TRACK(フォーマット: インデックスから 1 周ぶん飲み込むだけ)
      this.busy = false; this.phase = 0; this.irq = true;
    }
    // ── 時間 ──
    // セクタ this.sector の ID を from 以降に見つけ、読みなら 1 バイト目、書きなら最初の DRQ を予約
    _seekSector(from) {
      const idEnd = idEndAt(this.sector, from, this._ph());
      this.t0 = idEnd + (DATA_OFF - ID_MARK - ID_LEN) * BYTE;
      this.phase = this.writing ? 3 : 2; this.pos = 0;
      this.due = this.writing ? idEnd + 2 * BYTE : this.t0 + BYTE; // 書き: ID の 2 バイト後に DRQ(データを書き始めるまでに 1 バイト目を入れる)
    }
    _ph() { return this.drive ? this.drive.spin - this.now : 0; }
    _done() { this.drq = false; this.busy = false; this.phase = 0; this.due = 0; this.irq = true; this.restoring = 0; if (this._hld()) this.hldTime = this.now; }
    _hld() { return this.hldTime <= this.now && this.now < this.hldTime + ms(3000); }
    clock(cycles) {
      this.now += cycles;
      if (this.phase === 2 && this.drq && this.now > this.t0 + (SECTOR + 2) * BYTE) { this.status |= 0x04; this.drq = false; this.phase = 9; this.due = this.now; } // 読まれないままセクタが過ぎた
      if (this.restoring && this.busy && this.drive && this.drive.motor) { this.due = Math.min(this.due, this.now + this.restoring); this.restoring = 0; }
      if (!this.busy || !this.due || this.now < this.due) return;
      this.due = 0;
      switch (this.phase) {
        case 1: case 7: this._done(); break;                                       // タイプ I 完了 / エラー終了
        case 2: this._fetch(); this.drq = true; break;                             // 次のバイトが頭を通った
        case 3: case 5: this.drq = true; break;                                    // 次のバイトを書く番
        case 4: this.data = this.addrBuf[this.pos]; this.drq = true; break;
        case 6: this.data = 0x4E; this.drq = true; break;
        case 9: { // セクタの終わり(CRC を通った)。複数セクタなら次のセクタへ
          const d = this.drive;
          if (this.multi && d && d.image && d.image.hasSector(d.track, d.side, this.sector + 1)) { this.sector++; this._seekSector(this.now); }
          else this._done();
          break;
        }
        default: break;
      }
    }
    _fetch() { const d = this.drive; d.access++; this.data = d.image.readByte(d.track, d.side, this.sector, this.pos); }
    // CPU がバイトを読んだ: 次のバイトの時刻を予約(遅れて読んでもデータは失わない)
    _nextRead() {
      const d = this.drive;
      this.drq = false;
      this.pos++;
      if (this.phase === 4) {
        if (this.pos >= 6) { this._done(); this.sector = d.track; return; } // READ ADDRESS の後はセクタレジスタにトラック
        this.due = this.t0 + (this.pos + 1) * BYTE; return;
      }
      if (this.phase === 6) {
        if (this.pos >= TRACK_BYTES) { this._done(); return; }
        this.due = this.t0 + (this.pos + 1) * BYTE; return;
      }
      if (this.pos >= SECTOR) { this.phase = 9; this.due = this.now + 1; return; }
      this.due = this.t0 + (this.pos + 1) * BYTE;
    }
    _nextWrite(v) {
      const d = this.drive;
      this.drq = false;
      if (this.phase === 5) { // WRITE TRACK: インデックスから 1 トラックぶん(6250 バイト)飲み込んで終わる
        if (++this.pos >= TRACK_BYTES) { this.phase = 9; this.due = this.t0 + TRACK_BYTES * BYTE; return; }
        this.due = Math.max(this.now + 1, this.t0 + (this.pos - 1) * BYTE);
        return;
      }
      d.access++; d.image.writeByte(d.track, d.side, this.sector, this.pos, v);
      this.pos++;
      if (this.pos >= SECTOR) { this.phase = 9; this.due = this.t0 + (SECTOR + 2) * BYTE; return; }
      this.due = Math.max(this.now + 1, this.t0 + (this.pos - 1) * BYTE); // 前のバイトが書き出され始めたら次を求める
    }
  }

  // ── TC8566AF(μPD765 互換) ──
  const CMD_LEN = { 0x03: 3, 0x04: 2, 0x07: 2, 0x08: 1, 0x0F: 3, 0x06: 9, 0x0C: 9, 0x05: 9, 0x09: 9, 0x0A: 2, 0x0D: 6, 0x11: 9, 0x19: 9, 0x1D: 9 };
  class TC8566AF {
    constructor(drives) { this.drives = drives; this.reset(); }
    reset() {
      this.drive = this.drives[0]; this.driveNo = 0;
      this.phase = 0;            // 0 コマンド待ち、1 コマンドのバイト受け、2 実行(データ)、3 結果
      this.cmd = []; this.cmdLen = 0;
      this.result = []; this.resPos = 0;
      this.st0 = 0; this.st1 = 0; this.st2 = 0; this.st3 = 0;
      this.pcn = [0, 0, 0, 0];   // ドライブごとのシリンダ
      this.seekEnd = false; this.intPending = false;
      this.dataPos = 0; this.sectorCount = 0; this.xfer = null; // 実行中の READ/WRITE の状態
      this.enabled = true;
      this.now = this.now || 0;  // 通算サイクル(ディスクの角度)
      this.srt = 0; this.hut = 0; this.hlt = 0; // SPECIFY の値(openMSX のリセット値)
      this.seekDue = 0; this.seekDrive = 0; // シーク中ならステップが終わる時刻
      this.due = 0; this.ready = false; this.t0 = 0; this.headUntil = 0; // 実行中: 次のバイトの時刻、そのバイトが用意できたか、データの 1 バイト目の時刻、ヘッドが載っている期限
      this.idWait = false;       // READ ID の待ち(実行中だがデータは無い)
    }
    get stepCycles() { return ms(16 - this.srt); }
    get hltCycles() { return ms(2 * this.hlt); }
    get hutCycles() { return ms(16 * this.hut); }
    _headFrom() { return this.now < this.headUntil ? this.now : this.now + this.hltCycles; }
    // 実行中のセクタ x.r の ID を from 以降に見つけ、最初のバイトを予約
    _seekSector(from) {
      const x = this.xfer;
      this.t0 = idEndAt(x.r, from, this._ph()) - 6 * BYTE; // ID の FE が通った時刻(openMSX の TC はここから 1 バイトごと。ギャップを待たない)
      this.ready = false;
      this.due = this.t0;
    }
    _ph() { return this.drive ? this.drive.spin - this.now : 0; }
    _startSeek(steps) { this.seekDrive = this.driveNo & 1; this.seekEnd = false; this.seekDue = this.now + Math.min(255, steps) * this.stepCycles + 1; }
    clock(cycles) {
      this.now += cycles;
      if (this.seekDue && this.now >= this.seekDue) { this.seekDue = 0; this.seekEnd = true; }
      if (this.phase === 2 && !this.ready && this.due && this.now >= this.due) {
        this.due = 0;
        if (this.idWait) { this.idWait = false; this.phase = 3; this.resPos = 0; this.headUntil = this.now + this.hutCycles; }
        else this.ready = true;
      }
    }
    selectDrive(n) { this.driveNo = n & 3; this.drive = this.drives[this.driveNo] || null; }
    get mainStatus() {
      let s = 0x80; // RQM
      if (this.seekDue) s |= 1 << this.seekDrive; // D0B/D1B: シーク中
      if (this.phase === 2) { s |= this.idWait ? 0x10 : 0x20 | 0x10 | (this.xfer && this.xfer.write ? 0 : 0x40); if (!this.ready) s &= ~0x80; } // 実行中: NDM、CB、読みなら DIO=1。バイトが頭に来るまで RQM=0
      else if (this.phase === 3) s |= 0x40 | 0x10;                                            // 結果: DIO=1、CB
      else if (this.phase === 1) s |= 0x10;
      return s;
    }
    readData() {
      if (this.phase === 3) {
        const v = this.result[this.resPos++] | 0;
        if (this.resPos >= this.result.length) { this.phase = 0; this.result = []; }
        return v;
      }
      if (this.phase === 2 && this.xfer && !this.xfer.write) {
        if (!this.ready) return 0xFF;
        const x = this.xfer, d = this.drive;
        d.access++; const v = d.image.readByte(x.c, x.h, x.r, this.dataPos);
        this._advance();
        this._next();
        return v;
      }
      return 0xFF;
    }
    writeData(v) {
      v &= 0xFF;
      if (this.phase === 2 && this.xfer && this.xfer.write) {
        if (!this.ready) return;
        const x = this.xfer, d = this.drive;
        if (x.format) { // FORMAT: セクタごとの 4 バイト(C H R N)を、そのセクタが頭を通る頃に 1 組ずつ受ける
          if (++this.dataPos >= 4 * d.image.spt) { this._finish(0x00); return; }
          this.ready = false; this.due = Math.max(this.now + 1, this.t0 + Math.floor(this.dataPos / 4) * SEC_LEN * BYTE);
          return;
        }
        d.access++; d.image.writeByte(x.c, x.h, x.r, this.dataPos, v);
        this._advance();
        this._next();
        return;
      }
      if (this.phase === 0) {
        this.cmd = [v]; this.cmdLen = CMD_LEN[v & 0x1F] || 1;
        if (this.cmdLen === 1) this._execute(); else this.phase = 1;
        return;
      }
      if (this.phase === 1) {
        this.cmd.push(v);
        if (this.cmd.length >= this.cmdLen) this._execute();
      }
    }
    // バイトを受け渡した後: 次のバイトの時刻(セクタが変われば次のセクタの ID を探す)
    _next() {
      if (this.phase !== 2 || !this.xfer) return;
      const x = this.xfer;
      if (this.dataPos === 0) { this._seekSector(this.t0 + (SECTOR + 2) * BYTE); return; }
      this.ready = false;
      this.due = Math.max(this.now + 1, this.t0 + this.dataPos * BYTE); void x;
    }
    _advance() {
      const x = this.xfer;
      x.justAdvanced = false;
      if (++this.dataPos < SECTOR) return;
      this.dataPos = 0;
      if (x.r >= x.eot) { this._finish(0x00); return; } // EOT まで転送した: 正常終了(ST1 の EN は立てない。ドライバは結果の R を見る)
      x.r++; x.justAdvanced = true;
      if (!this.drive.image.hasSector(x.c, x.h, x.r)) { this._finish(0x40, 0x80); return; } // 無い: EN
    }
    // TC(Terminal Count): 実行中なら転送を打ち切って結果へ。セクタ境界で来たら結果の R は次のセクタ(もう進めてある)
    terminalCount() {
      if (this.phase !== 2 || !this.xfer) return;
      this.dataPos = 0;
      this._finish(0x00, 0x00);
    }
    _finish(st0, st1) {
      const x = this.xfer, d = this.drive;
      this.st0 = (st0 | this.driveNo | (x.h << 2)) & 0xFF; this.st1 = st1 || 0; this.st2 = 0;
      let c = x.c, h = x.h, r = x.r;
      if (!x.format && !(x.justAdvanced && this.dataPos === 0)) { r++; if (r > d.image.spt) { r = 1; c++; } }
      this.result = [this.st0, this.st1, this.st2, c, h, r, 2];
      this.resPos = 0; this.phase = 3; this.xfer = null; this.ready = false; this.due = 0;
      this.headUntil = this.now + this.hutCycles;
    }
    _execute() {
      const c = this.cmd, op = c[0] & 0x1F; let d = this.drive;
      switch (op) {
        case 0x03: this.srt = c[1] >> 4; this.hut = c[1] & 0x0F; this.hlt = c[2] >> 1; this.phase = 0; break; // SPECIFY
        case 0x04: { // SENSE DRIVE STATUS → ST3
          const n = c[1] & 3; const dr = this.drives[n];
          this.st3 = n | ((c[1] >> 2) & 1) << 2 | (dr && dr.image ? 0x20 : 0) | (dr && dr.track === 0 ? 0x10 : 0) | (dr && dr.image && dr.image.sides === 2 ? 0x08 : 0) | (dr && dr.image && dr.image.writeProtect ? 0x40 : 0);
          this.result = [this.st3]; this.resPos = 0; this.phase = 3; break;
        }
        case 0x07: { // RECALIBRATE
          this.selectDrive(c[1] & 3); d = this.drive;
          // TRACK0 が見えるまで最大 255 ステップ。モータが止まっていると見えないので 255 ステップして EC(装置チェック)
          const blind = !this.drive || !this.drive.motor;
          const steps = blind ? 255 : this.drive.track;
          if (this.drive) this.drive.track = 0; this.pcn[this.driveNo] = 0;
          this.st0 = 0x20 | this.driveNo | (blind ? 0x10 : 0); this._startSeek(steps); this.phase = 0; break;
        }
        case 0x0F: { // SEEK
          this.selectDrive(c[1] & 3); d = this.drive;
          const to = c[2];
          const steps = Math.abs(to - this.pcn[this.driveNo]);
          if (this.drive) this.drive.track = Math.max(0, Math.min(85, to)); this.pcn[this.driveNo] = to;
          this.st0 = 0x20 | this.driveNo; this._startSeek(steps); this.phase = 0; break;
        }
        case 0x08: { // SENSE INTERRUPT STATUS → ST0, PCN
          // openMSX と同じく常に 2 バイト。シーク中(まだ SE が無い)は ST0=0
          if (this.seekEnd) { this.seekEnd = false; this.result = [this.st0, this.pcn[this.driveNo]]; }
          else this.result = [0x00, this.pcn[this.driveNo]];
          this.resPos = 0; this.phase = 3; break;
        }
        case 0x06: case 0x0C: case 0x05: case 0x09: { // READ DATA / READ DELETED / WRITE DATA / WRITE DELETED
          this.selectDrive(c[1] & 3); d = this.drive;
          const h = (c[1] >> 2) & 1;
          if (!d || !d.image) { this.xfer = { c: c[2], h, r: c[4], eot: c[6], write: false }; this._finish(0x40, 0x00); this.st0 |= 0x08; this.result[0] = this.st0; break; } // NR
          d.side = h;
          const x = { c: c[2], h, r: c[4], eot: c[6], write: op === 0x05 || op === 0x09 };
          if (!d.image.hasSector(x.c, x.h, x.r)) { this.xfer = x; this._finish(0x40, 0x04); break; } // ND
          if (x.write && d.image.writeProtect) { this.xfer = x; this._finish(0x40, 0x02); break; }  // NW
          this.xfer = x; this.dataPos = 0; this.phase = 2;
          d.track = x.c;
          this._seekSector(this._headFrom());
          break;
        }
        case 0x0A: { // READ ID → ST0 ST1 ST2 C H R N
          this.selectDrive(c[1] & 3); d = this.drive;
          const h = (c[1] >> 2) & 1;
          if (!d || !d.image) { this.result = [0x48 | this.driveNo, 0, 0, 0, h, 1, 2]; this.resPos = 0; this.phase = 3; break; }
          const id = nextId(d.image.spt, this._headFrom(), this._ph()); // 次に頭を通る ID を読み終えたら結果
          this.result = [this.driveNo | (h << 2), 0, 0, d.track, h, id.r, 2];
          this.xfer = null; this.phase = 2; this.idWait = true; this.ready = false; this.due = id.end;
          break;
        }
        case 0x0D: { // FORMAT TRACK: N SC GPL D のあとセクタごとの 4 バイト(飲み込む)
          this.selectDrive(c[1] & 3); d = this.drive;
          const h = (c[1] >> 2) & 1;
          if (!d || !d.image || d.image.writeProtect) { this.xfer = { c: d ? d.track : 0, h, r: 1, eot: 1, write: true, format: true }; this._finish(0x40, 0x02); break; }
          this.xfer = { c: d.track, h, r: 1, eot: 1, write: true, format: true }; this.dataPos = 0; this.phase = 2;
          this.t0 = nextAt(0, this._headFrom(), this._ph()); this.ready = false; this.due = this.t0; break; // インデックスから
        }
        default: this.result = [0x80]; this.resPos = 0; this.phase = 3; break; // 無効
      }
    }
  }

  // ── スロットに挿すディスクインターフェース ──
  class MsxDiskInterface {
    /** @param {Uint8Array} rom ディスク ROM(16K) @param {'wd2793'|'tc8566af'} kind @param {MsxDiskImage[]} images */
    constructor(rom, kind, images) {
      this.rom = rom || new Uint8Array(0x4000).fill(0xFF);
      this.kind = kind === 'tc8566af' ? 'tc8566af' : 'wd2793';
      this.images = images || [];
      this.drives = [new Drive(), new Drive()];
      this.fdc = this.kind === 'tc8566af' ? new TC8566AF(this.drives) : new WD2793(this.drives);
      this.ctrl = 0; this.sideReg = 0;
      if (this.images.length) { this.drives[0].image = this.images[0]; this.drives[0].changed = true; } // 起動時に入っていたディスクも「入れ替わった」(openMSX と同じ)
      this.inserted = this.images.length ? 0 : -1;
    }
    reset() { this.fdc.reset(); this.ctrl = 0; this.sideReg = 0; for (const d of this.drives) { d.track = 0; d.side = 0; d.motor = false; } }
    get diskCount() { return this.images.length; }
    get dirty() { return this.images.some((i) => i.dirty); }
    clearDirty() { for (const i of this.images) i.dirty = false; }
    // アクセスランプ: ドライブごとの { access(読み書きしたバイト数), media(入っているか) }。ドライブは A/B の 2 台
    diskActivity() { return this.drives.map((d) => ({ access: d.access, media: !!d.image })); }
    // ディスクを読み書きしている最中か(モータが回っている/FDC が動いている。「速い読み込み」の自動早送りが見る)
    diskBusy() {
      const f = this.fdc;
      return this.drives.some((d) => d.motor && d.image) || (this.kind === 'wd2793' ? f.busy : (f.phase === 2 || !!f.seekDue));
    }
    insertDisk(n) { if (!this.images.length) return; n = ((n % this.images.length) + this.images.length) % this.images.length; this.drives[0].image = this.images[n]; this.drives[0].changed = true; this.inserted = n; }
    ejectDisk() { this.drives[0].image = null; this.drives[0].changed = true; this.inserted = -1; }
    addImage(img) { this.images.push(img); return this.images.length - 1; }
    clock(cycles) { for (const d of this.drives) if (d.motor) d.spin += cycles; this.fdc.clock(cycles); }
    read(a) {
      if (a >= 0x7FF8 && a <= 0x7FFF || (a >= 0xBFF8 && a <= 0xBFFF)) return this._readReg(a & 7);
      if (a >= 0x4000 && a < 0x8000) { const o = a - 0x4000; return o < this.rom.length ? this.rom[o] : 0xFF; }
      return 0xFF;
    }
    write(a, v) {
      if (a >= 0x7FF8 && a <= 0x7FFF || (a >= 0xBFF8 && a <= 0xBFFF)) this._writeReg(a & 7, v & 0xFF);
    }
    _readReg(r) {
      const f = this.fdc;
      if (this.kind === 'wd2793') {
        switch (r) {
          case 0: return f.readStatus();
          case 1: return f.track;
          case 2: return f.sector;
          case 3: return f.readData();
          case 4: return this.sideReg;  // 書いた値のまま(openMSX PhilipsFDC)
          case 5: { // 書いた値。bit2 だけは「ディスクが入れ替わっていない」(0 = 入れ替わった。読むと消える)
            const d = f.drive; let v = this.ctrl & ~4;
            if (!(d && d.changed)) v |= 4; else d.changed = false;
            return v;
          }
          case 7: return (0xC0 & ~(f.irq ? 0x40 : 0) & ~(f.drq ? 0x80 : 0)) | 0x3F; // bit6=~IRQ、bit7=~DRQ、他は 1
          default: return 0xFF;
        }
      }
      switch (r) {
        case 2: return f.mainStatus;
        case 3: return f.readData();
        default: return 0xFF;
      }
    }
    _writeReg(r, v) {
      const f = this.fdc;
      if (this.kind === 'wd2793') {
        switch (r) {
          case 0: f.writeCommand(v); return;
          case 1: f.track = v; return;
          case 2: f.sector = v; return;
          case 3: f.writeData(v); return;
          case 4: this.sideReg = v; f.setSide(v & 1); return;
          case 5: { // bit0-1 ドライブ(2/3 は無し)、bit7 モータ
            this.ctrl = v;
            const n = v & 3;
            const sel = n === 3 ? -1 : (n & 1); // 0・2 = A、1 = B、3 = 無し
            f.selectDrive(sel);
            for (let i = 0; i < 2; i++) this.drives[i].motor = !!(v & 0x80) && sel === i;
            if (f.drive) f.drive.side = f.sideSel;
            return;
          }
          default: return;
        }
      }
      switch (r) {
        case 0: { // 制御 0: bit0-1 ドライブ、bit2 有効(0 でリセット)、bit3 DMA、bit4-7 ドライブ A〜D のモータ
          this.ctrl = v;
          if (!(v & 0x04)) f.reset();
          f.selectDrive(v & 3);
          for (let i = 0; i < 2; i++) this.drives[i].motor = !!(v & (0x10 << i));
          return;
        }
        case 1: if (v & 0x01) f.terminalCount(); return; // 制御 1: bit0 TC(転送の打ち切り。実機のディスク ROM は 1 セクタ読むごとに 2→3→2 と打つ)
        case 3: f.writeData(v); return;
        default: return;
      }
    }
  }

  Emu.MsxDiskImage = MsxDiskImage;
  Emu.WD2793 = WD2793;
  Emu.TC8566AF = TC8566AF;
  Emu.MsxDiskInterface = MsxDiskInterface;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MSX 本体 (MML.Emu.MsxConsole) — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md、段階 7a/7b)
 *
 * NES 本体(nes/nesConsole.js)と同じ外形: DOM に依存せず、ヘッドレス(tools/headless/msx-run.js)/AudioWorklet
 * (src/audio/nes-worklet-impl.js)/主スレッド(src/ui/nesScreen.js)のどこでも同じ物が動く。
 *   runFrame()/runSamples(out)/setSampleRate(sr)/frame/frameCount/onFrame/onWrite/startRecording()/stopRecording()/
 *   setController(port, bits, turbo)(NES と同じビット: A=1 B=2 Up=16 Down=32 Left=64 Right=128 → ジョイスティックのトリガ 1/2 と方向)/
 *   setKey(code, down)(PC のキー)/reset()/hasBattery・getBattery・setBattery(SRAM/FM-PAC/RTC、7c)
 *
 * ■ 構成(機種は opts.machine: 'msx1' | 'msx2' | 'msx2plus' | 'turbor')
 *   turboR(7e): スロット 0-0 メイン BIOS、0-2 内蔵 MSX-MUSIC、3-0 マッパー RAM 256K、3-1 サブ ROM(+漢字ドライバ 32K bios.kdr を $4000〜)、3-2 ディスク(TC8566AF)
 *   (FS-A1ST/GT の配置。パナソニックの内蔵ソフト ROM(3-1、512K の専用マッパー)は載せない)。S1990(I/O $E4-$E7: CPU モードと
 *   255.68kHz の 16bit タイマ)、PCM(I/O $A4/$A5、8bit D/A、15.75kHz の 2bit カウンタ。A/D は無し)、PAUSE($A7、押せない)。
 *   R800 は cpuZ80.js の r800 フラグ(MULUB/MULUW と時間の近似)。実 BIOS は利用者の物(C-BIOS に turboR は無い)
 *   Z80 3.58MHz(M1 ウェイト 1)、PPI 8255($A8-$AB: 一次スロット選択/キーボード行/キー読み)、拡張スロットレジスタ($FFFF)、
 *   メモリマッパー RAM($FC-$FF、msx1 64K / msx2〜 128K〜)、VDP(msx/vdp.js、$98-$9B)、PSG(expansion/ay8910Msx.js、$A0-$A2。
 *   R14 はジョイスティック、R15 は口の選択)、カートリッジ(msx/cartridge.js、スロット 1 と 2)、BIOS ROM(利用者または同梱 C-BIOS)。
 *   スロット配置(C-BIOS と大半の実機に合う既定): 0-0 メイン ROM(+$8000 にロゴ ROM)、1 カートリッジ A(ゲーム)、2 カートリッジ B、
 *   3-0 サブ ROM(MSX2〜)、3-2 マッパー RAM(msx1 は 3-0 に RAM、拡張無し)、3-3 内蔵 MSX-MUSIC(msx2plus/turbor、music ROM があるとき)。
 * ■ 音源(7b)
 *   PSG(常に)、SCC/SCC+(カートリッジ A が konamiScc/konamiSccI、または B が SCC-I)、OPLL=MSX-MUSIC(カートリッジ B が FM-PAC、
 *   または MSX2+/turboR の内蔵。expansion/opllMsx.js → 既定は Nuked コア。I/O $7C/$7D)、Y8950=MSX-AUDIO(カートリッジ B、
 *   expansion/opl.js type y8950、I/O $C0/$C1、ADPCM RAM 256K。タイマ割り込みは未実装)、コナミ DAC(カートリッジ A が konamiDac、
 *   expansion/majutsushiDac.js)。カートリッジ B は opts.cartB = { kind: 'fmpac'|'msxaudio'|'scci'|'rom', rom?, mapperType? }。
 *   ★FM-PAC の OPLL I/O は実機では $7FF6 bit0 で有効化されるが、ここでは挿した時点で常に有効にしている(値は fm.enable に覚える。
 *     内蔵 MSX-MUSIC の機種と同じ扱い。ROM 検出のみで $7FF6 を書かないソフトを鳴らすため)。
 * ■ 時間
 *   1 命令ごとに消費サイクルぶん VDP/音源を進める。INT は VDP の線(F∧IE0 ∨ FH∧IE1)を命令境界で見る(IFF1 かつ EI の直後でない)。
 *   フレームの区切り=VDP の VBlank の頭(表示最終行の次の行)。60Hz なら 262 行×228=59,736 サイクル、50Hz(R9 bit1)は 313 行。
 * ■ 録音(列を積む。VGM への符号化は vgm/vgmRecord.js encodeMsxRecording)
 *   書き込み { chip, addr, value, t }。chip と addr: 'psg'=レジスタ番号(0〜13。14/15 は I/O なので載せない)、'scc'=メモリ番地
 *   ($9800-$9FFF classic / $B800-$BFFF SCC+、それにモード $BFFE と窓の開閉 $B000)、'opll'=レジスタ番号($00-$3F)、
 *   'opl'=Y8950 のレジスタ番号(ADPCM 再生開始の書き込みには adpcm:{start,data} を添える。§5.3)、'dac'=番地($5000 台)。
 *   t はフレーム内のサンプル位置(60Hz: 0〜734、50Hz: 0〜881)。フレームの配列には spf(そのフレームのサンプル数)を付ける。
 *   開始時に各音源の像(P-4)を先頭に置く。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 3579545;
  const AUDIO_RING = 1 << 14;
  const PSG_GAIN = 1.99 / 1.56; // KSS 再生(stream-player 1.99)と同じ大きさに。画面側の GainNode は NES と同じ 1.56
  const SCC_GAIN = 1.99 / 1.56;
  const OPLL_GAIN = 1.99 / 1.56;       // kssPlayer は OPLL を素通し(×1)
  const OPL_GAIN = 0.7 * 1.99 / 1.56;  // kssPlayer の MSX-AUDIO は ×0.7(VGM 側の較正比)
  const DAC_GAIN = 1.99 / 1.56;
  const PAGE = 0x2000;
  const Y8950_ADPCM_UNIT = 5; // ADPCM の開始/停止番地は 32 バイト単位(opl.js addrShift=5)

  const MACHINES = {
    msx1: { vdp: 'tms9918', vramKB: 16, ramKB: 64, expanded: [false, false, false, false], sub: false, fm: false },
    msx2: { vdp: 'v9938', vramKB: 128, ramKB: 128, expanded: [false, false, false, true], sub: true, fm: false },
    msx2plus: { vdp: 'v9958', vramKB: 128, ramKB: 128, expanded: [false, false, false, true], sub: true, fm: true, f4: 'inverted' },
    turbor: { vdp: 'v9958', vramKB: 128, ramKB: 256, expanded: [false, false, false, true], sub: true, fm: true, turbor: true, f4: 'normal',
      layout: { sub: [3, 1], disk: [3, 2], ram: [3, 0], music: [0, 2] } }, // FS-A1ST/GT: RAM 3-0、サブ+漢字ドライバ 3-1、ディスク 3-2、内蔵ソフト 3-3(載せない)。★turboR の BIOS は RAM を探さず 3-0 と決め打つ(実測: $FFFF=0 で page 3 を 3-0 に)
  };
  // 内蔵物のスロット(一次, 二次)。msx2/2+ は 7a〜7d の配置のまま(C-BIOS と実 BIOS の両方で動いている)
  const DEFAULT_LAYOUT = { sub: [3, 0], disk: [3, 1], ram: [3, 2], music: [3, 3] };
  const PCM_TICK = 3579545 / 15750; // PCM のカウンタ(2bit)の 1 刻み(Z80 サイクル)
  const S1990_TICK = 14;            // S1990 のタイマ: 3.579545MHz / 14 = 255.68kHz

  // turboR の S1990(システム制御): $E4 レジスタ番号、$E5 データ、$E6/$E7 タイマ(読み=下位/上位、$E6 書き=リセット)。
  //   レジスタ 6 = CPU モード(bit5: 1=Z80 0=R800、bit6: 1=ROM モード 0=DRAM モード。リセット時 $60)。5 = PAUSE LED 等(読み書きだけ)。
  //   13/14 は openMSX が固定値を返している記憶(0x03/0x2F)による推定。DRAM モードは速度の違いだけ(BIOS の RAM への写しは模擬しない)
  class S1990 {
    constructor(owner) { this.owner = owner; this.sel = 0; this.regs = new Uint8Array(16); this.timerBase = 0; this.reset(); }
    reset() { this.sel = 0; this.regs.fill(0); this.regs[6] = 0x60; this.timerBase = 0; this._applyCpu(); }
    ioRead(port) {
      switch (port) {
        case 0xE4: return this.sel;
        case 0xE5: return this.sel === 13 ? 0x03 : this.sel === 14 ? 0x2F : this.regs[this.sel & 15];
        case 0xE6: return this._timer() & 0xFF;
        case 0xE7: return (this._timer() >> 8) & 0xFF;
        default: return 0xFF;
      }
    }
    ioWrite(port, v) {
      switch (port) {
        case 0xE4: this.sel = v & 0x0F; return;
        case 0xE5: this.regs[this.sel] = v; if (this.sel === 6) this._applyCpu(); return;
        case 0xE6: this.timerBase = this.owner.cpuCycles; return;
        default: return;
      }
    }
    _timer() { return Math.floor((this.owner.cpuCycles - this.timerBase) / S1990_TICK) & 0xFFFF; }
    get r800() { return !(this.regs[6] & 0x20); }
    get dram() { return !(this.regs[6] & 0x40); }
    _applyCpu() { const cpu = this.owner.cpu; if (!cpu) return; cpu.r800 = this.r800; cpu.r800Scale = this.dram ? 0.2 : 0.35; }
  }
  // turboR の PCM(8bit D/A。A/D は模擬しない): $A4 データ(書き=D/A、読み=最後の値)、$A5 制御/状態。
  //   $A5 書き: bit0 SMPL、bit1 SEL(1 のとき $A4 の書き込みが D/A に出る)、bit2 FILT、bit3 MUTE(1=消音)。読み: bit1-0 = $A4 アクセスからの
  //   15.75kHz カウンタ(2bit。BIOS/ゲームはこれを待って 1 サンプルずつ書く)、bit4-2 = 書いた値、bit7 = 比較器(A/D 無しなので 0)。
  //   ビット配置は MSX Datapack の記述の記憶による(SEL/MUTE の極性は推定。録音には SEL のときの $A4 を載せる)。音は牌の魔術師の D/A と同じ零次ホールド
  class TurboRPcm {
    constructor(owner) { this.owner = owner; this.dac = new Emu.MajutsushiDAC(); this.status = 0; this.value = 0x80; this.lastAccess = 0; }
    reset() { this.dac.reset(); this.status = 0; this.value = 0x80; this.lastAccess = 0; }
    get outputOn() { return (this.status & 0x02) !== 0; }
    ioRead(port) {
      if (port === 0xA4) { this.lastAccess = this.owner.cpuCycles; return this.value; }
      const ticks = Math.floor((this.owner.cpuCycles - this.lastAccess) / PCM_TICK) & 3;
      return (this.status & 0x1C) | ticks;
    }
    ioWrite(port, v) {
      if (port === 0xA4) { this.lastAccess = this.owner.cpuCycles; this.value = v & 0xFF; if (this.outputOn) this.dac.write(v); return true; }
      this.status = v & 0x1F; return false;
    }
    mixSample() { return (this.status & 0x08) ? 0 : this.dac.mixSample(); }
    get mute() { return this.dac.mute; } get vol() { return this.dac.vol; }
  }

  const CART_B_KINDS = ['none', 'fmpac', 'msxaudio', 'scci', 'rom'];

  const EMPTY_PAGE = new Uint8Array(PAGE).fill(0xFF);

  // ── スロットに挿す物(read(addr)/write(addr,v)) ──
  class RomDevice {
    /** @param {Uint8Array} rom @param {number} base 置く番地 */
    constructor(rom, base) { this.rom = rom; this.base = base; this.end = base + rom.length; }
    read(a) { return (a >= this.base && a < this.end) ? this.rom[a - this.base] : 0xFF; }
    write() {}
  }
  class MultiRomDevice { // 1 スロットに複数の ROM(メイン+ロゴ など)
    constructor(list) { this.list = list; }
    read(a) { for (const d of this.list) { if (a >= d.base && a < d.end) return d.rom[a - d.base]; } return 0xFF; }
    write() {}
  }
  class MapperRam {
    constructor(kb) {
      this.ram = new Uint8Array(kb * 1024);
      this.segments = this.ram.length >> 14;
      this.segMask = this.segments - 1;
      this.sel = new Uint8Array(4); // ページ(16K)ごとのセグメント
      this.reset();
    }
    reset() { this.sel[0] = 3; this.sel[1] = 2; this.sel[2] = 1; this.sel[3] = 0; this.ram.fill(0); }
    read(a) { return this.ram[((this.sel[a >> 14] & this.segMask) << 14) | (a & 0x3FFF)]; }
    write(a, v) { this.ram[((this.sel[a >> 14] & this.segMask) << 14) | (a & 0x3FFF)] = v; }
    ioWrite(port, v) { this.sel[port & 3] = v; }
    ioRead(port) { return this.sel[port & 3] | ~this.segMask; } // 未使用上位ビットは 1(実機のマッパーもそう読める物が多い)
  }
  class CartDevice {
    constructor(cart) { this.cart = cart; }
    read(a) { const s = this.cart.readScc(a); return s >= 0 ? s : this.cart.read(a); }
    write(a, v) { this.cart.write(a, v); }
  }
  // FM-PAC / 内蔵 MSX-MUSIC: ROM(16K、または 64K を $7FF7 で 16K バンク)を $4000-$7FFF に、$7FF6 bit0=OPLL I/O 有効(値だけ覚える)、
  // $5FFE/$5FFF に 0x4D/0x69 を書くと $4000-$5FFF が SRAM 8K(PAC のセーブ。7b は保存しない)
  class FmPacDevice {
    constructor(rom) {
      this.rom = rom || new Uint8Array(0);
      this.sram = new Uint8Array(0x2000);
      this.bank = 0; this.enable = 0; this.magic = new Uint8Array(2); this.dirty = false;
      this.bankMask = Math.max(0, (this.rom.length >> 14) - 1);
    }
    reset() { this.bank = 0; this.enable = 0; this.magic.fill(0); }
    get sramOn() { return this.magic[0] === 0x4D && this.magic[1] === 0x69; }
    read(a) {
      if (a < 0x4000 || a >= 0x8000) return 0xFF;
      if (a === 0x7FF6) return this.enable & 0x11;
      if (a === 0x7FF7) return this.bank & 3;
      if (a < 0x6000 && this.sramOn) return this.sram[a & 0x1FFF];
      const off = ((this.bank & this.bankMask) << 14) | (a & 0x3FFF);
      return off < this.rom.length ? this.rom[off] : 0xFF;
    }
    write(a, v) {
      if (a === 0x7FF6) { this.enable = v; return; }
      if (a === 0x7FF7) { this.bank = v & 3; return; }
      if (a === 0x5FFE) { this.magic[0] = v; return; }
      if (a === 0x5FFF) { this.magic[1] = v; return; }
      if (a >= 0x4000 && a < 0x5FFE && this.sramOn && this.sram[a & 0x1FFF] !== v) { this.sram[a & 0x1FFF] = v; this.dirty = true; }
    }
  }

  // RTC RP5C01(I/O $B4 レジスタ番号、$B5 データ。MSX2〜)。モード 0 = 時計(JS の時計から読む。書き込みは無視)、1 = アラーム/12・24 時間/うるう年、
  // 2・3 = 13 ニブルずつの RAM(BIOS が画面色・ビープ・起動ロゴ等の設定を置く。バッテリー保存に含める)。レジスタ 13 = モード(bit0-1)+タイマ有効(bit3)
  class Rp5c01 {
    constructor() { this.ram = new Uint8Array(26); this.mode = 0x08; this.reg = 0; this.alarm = new Uint8Array(13); this.dirty = false; }
    reset() { this.reg = 0; this.mode = 0x08; }
    ioWrite(port, v) {
      if ((port & 1) === 0) { this.reg = v & 0x0F; return; }
      v &= 0x0F;
      if (this.reg === 13) { this.mode = v; return; }
      if (this.reg >= 13) return; // 14 テスト、15 リセット
      const m = this.mode & 3;
      if (m === 0) return; // 時計は JS の物
      if (m === 1) { this.alarm[this.reg] = v; return; }
      const i = (m - 2) * 13 + this.reg;
      if (this.ram[i] !== v) { this.ram[i] = v; this.dirty = true; }
    }
    ioRead(port) {
      if ((port & 1) === 0) return 0xFF;
      if (this.reg === 13) return this.mode | 0xF0;
      if (this.reg >= 13) return 0xFF;
      const m = this.mode & 3;
      if (m === 0) return this._clock(this.reg) | 0xF0;
      if (m === 1) return this.alarm[this.reg] | 0xF0;
      return this.ram[(m - 2) * 13 + this.reg] | 0xF0;
    }
    _clock(r) {
      const d = new Date();
      const h24 = (this.alarm[10] & 1) !== 0; // モード 1 レジスタ 10 bit0: 1=24 時間
      const h = d.getHours(), hh = h24 ? h : (h % 12), pm = h >= 12 ? 2 : 0;
      switch (r) {
        case 0: return d.getSeconds() % 10; case 1: return (d.getSeconds() / 10) | 0;
        case 2: return d.getMinutes() % 10; case 3: return (d.getMinutes() / 10) | 0;
        case 4: return hh % 10; case 5: return ((hh / 10) | 0) | (h24 ? 0 : pm);
        case 6: return d.getDay(); case 7: return d.getDate() % 10; case 8: return (d.getDate() / 10) | 0;
        case 9: return (d.getMonth() + 1) % 10; case 10: return ((d.getMonth() + 1) / 10) | 0;
        case 11: return (d.getFullYear() - 1980) % 10; case 12: return (((d.getFullYear() - 1980) / 10) | 0) % 10;
        default: return 0;
      }
    }
  }
  // 漢字 ROM(I/O $D8/$D9 = JIS 第一水準 128K、$DA/$DB = 第二水準 128K。書き込み 2 回で文字番号、読み出しは 32 バイト順送り)
  class KanjiRom {
    constructor(rom) { this.rom = rom; this.addr = [0, 0]; this.lo = [0, 0]; }
    reset() { this.addr.fill(0); this.lo.fill(0); }
    ioWrite(port, v) {
      const k = (port >> 1) & 1; // $D8/$D9 → 0、$DA/$DB → 1
      if ((port & 1) === 0) this.lo[k] = v & 0x3F; else this.addr[k] = (((v & 0x3F) << 6) | this.lo[k]) << 5;
    }
    ioRead(port) {
      if ((port & 1) === 0) return 0xFF;
      const k = (port >> 1) & 1;
      const base = k ? 0x20000 : 0;
      const a = base + (this.addr[k] & 0x1FFFF);
      const v = a < this.rom.length ? this.rom[a] : 0xFF;
      this.addr[k] = (this.addr[k] & ~0x1F) | ((this.addr[k] + 1) & 0x1F);
      return v;
    }
  }

  class MsxConsole {
    /**
     * @param {Uint8Array} romBytes カートリッジ ROM(.rom)。null なら BIOS だけで起動
     * @param {object} [opts] { machine, bios: { main, sub, logo, disk, kanji, kdr(漢字ドライバ 32K、2+/turboR), music }, mapperType, ramKB,
     *                          cartB: { kind: 'fmpac'|'msxaudio'|'scci'|'rom', rom?: Uint8Array, mapperType? } | Uint8Array(=rom),
     *                          disks: Uint8Array[](.dsk 画像。bios.disk=ディスク ROM 16K が要る), fdc: 'wd2793'|'tc8566af' }
     */
    constructor(romBytes, opts) {
      opts = opts || {};
      this.opts = opts;
      this.machine = MACHINES[opts.machine] ? opts.machine : 'msx2';
      const mc = MACHINES[this.machine];
      // BIOS: 渡された物 → 同梱の C-BIOS(msx/cbiosData.js、mk-cbios-data.js が作る。turboR には無い)→ 無ければ例外
      this.bios = (opts.bios && opts.bios.main) ? opts.bios : MsxConsole.defaultBios(this.machine);
      if (!this.bios || !this.bios.main) throw new Error('MSX の BIOS(メイン ROM)がありません');
      this.cpu = new Emu.CPUZ80(this);
      this.cpu.m1Wait = 1;
      this.vdp = new Emu.MsxVdp({ type: mc.vdp, vramKB: mc.vramKB });
      this.psg = new Emu.AY8910Audio();
      this.keyboard = new Emu.MsxKeyboard();
      this.rtc = mc.sub ? new Rp5c01() : null; // MSX2 以降
      this.kanji = this.bios.kanji && this.bios.kanji.length >= 0x20000 ? new KanjiRom(this.bios.kanji) : null;
      this.ramDev = new MapperRam(opts.ramKB || mc.ramKB);
      // カートリッジ B の指定を正規化
      let cb = opts.cartB || null;
      if (cb instanceof Uint8Array || (cb && cb.buffer && !cb.kind)) cb = { kind: 'rom', rom: cb };
      if (cb && (!CART_B_KINDS.includes(cb.kind) || cb.kind === 'none')) cb = null;
      if (cb && cb.kind === 'rom' && !cb.rom) cb = null;
      this.cartBKind = cb ? cb.kind : 'none';
      // 音源(載せる物だけ作る)
      const typeA = opts.mapperType || (romBytes ? Emu.MsxCartridge.guessType(romBytes) : null);
      const sccA = typeA === 'konamiScc' || typeA === 'konamiSccI';
      this.scc = (sccA || this.cartBKind === 'scci') && Emu.SCCAudio ? new Emu.SCCAudio() : null;
      this.dac = typeA === 'konamiDac' && Emu.MajutsushiDAC ? new Emu.MajutsushiDAC() : null;
      const fmRom = (cb && cb.kind === 'fmpac' && cb.rom) ? cb.rom : (this.bios.music || (mc.fm ? MsxConsole.defaultMusicRom() : null)); // 内蔵 FM の機種で控えが無ければ同梱 C-BIOS の MSX-MUSIC ROM
      this.fmInternal = !!mc.fm && !!fmRom;
      this.opll = ((cb && cb.kind === 'fmpac') || this.fmInternal) && Emu.OPLLAudio ? new Emu.OPLLAudio() : null;
      this.fm = this.opll ? new FmPacDevice(fmRom) : null;
      this.opl = cb && cb.kind === 'msxaudio' && Emu.OPLAudio ? new Emu.OPLAudio(CPU_CLOCK, { type: 'y8950' }) : null;
      this.cpuCycles = 0;
      this.s1990 = mc.turbor ? new S1990(this) : null; // turboR(7e)
      this.f4Mode = mc.f4 || null; this.f4 = 0; // I/O $F4(2+/turboR): 起動フラグ。bit7=1 なら BIOS は暖かい起動(RAM の初期化を飛ばす)。電源投入で 0。'inverted' は読み書きが反転(パナソニック 2+)。★0xFF を返すと turboR BIOS は RAM の未初期化ベクタへ飛んで暴走する
      this.pcm = mc.turbor && Emu.MajutsushiDAC ? new TurboRPcm(this) : null;
      this.cart = romBytes ? new Emu.MsxCartridge(romBytes, { type: opts.mapperType, scc: sccA ? this.scc : null, dac: this.dac }) : null;
      this.cartB = null;
      if (cb && cb.kind === 'rom') this.cartB = new Emu.MsxCartridge(cb.rom, { type: cb.mapperType, scc: null });
      else if (cb && cb.kind === 'scci') this.cartB = new Emu.MsxCartridge(cb.rom || null, { type: 'konamiSccI', scc: this.scc });
      if (this.cart) this.cart.onWrite = (kind, a, v) => this._logWrite(kind, a, v);
      if (this.cartB) this.cartB.onWrite = (kind, a, v) => this._logWrite(kind, a, v);
      // スロット表 slot[primary][secondary]
      this.expanded = mc.expanded.slice();
      this.slot = [[null, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]];
      const lay = mc.layout || DEFAULT_LAYOUT;
      const mainList = [new RomDevice(this.bios.main, 0)];
      if (this.bios.logo) mainList.push(new RomDevice(this.bios.logo, 0x8000));
      this.slot[0][0] = new MultiRomDevice(mainList);
      if (this.cart) this.slot[1][0] = new CartDevice(this.cart);
      if (this.cartB) this.slot[2][0] = new CartDevice(this.cartB);
      else if (this.fm && !this.fmInternal) this.slot[2][0] = this.fm; // FM-PAC はカートリッジ B
      if (mc.sub) {
        // サブ ROM(+turboR/2+ の漢字ドライバ 32K を $4000〜 に同居: FS-A1ST/WSX の 3-0 と同じ)
        const subList = [];
        if (this.bios.sub) subList.push(new RomDevice(this.bios.sub, 0));
        if (this.bios.kdr && this.bios.kdr.length === 0x8000) subList.push(new RomDevice(this.bios.kdr, 0x4000));
        if (subList.length) this.slot[lay.sub[0]][lay.sub[1]] = subList.length === 1 ? subList[0] : new MultiRomDevice(subList);
        this.slot[lay.ram[0]][lay.ram[1]] = this.ramDev;
      }
      else this.slot[3][0] = this.ramDev;
      // ディスク(7d): ディスク ROM(利用者の物)+FDC をスロット 3-1 に。画像が無くても ROM があればドライブ(空)は付く
      this.disk = null;
      if (opts.disks && opts.disks.length && !this.bios.disk) throw new Error('ディスク ROM がありません');
      if (this.bios.disk && Emu.MsxDiskInterface) {
        const images = (opts.disks || []).map((b) => new Emu.MsxDiskImage(b));
        this.disk = new Emu.MsxDiskInterface(this.bios.disk, opts.fdc || 'wd2793', images);
        this.slot[lay.disk[0]][lay.disk[1]] = this.disk;
      }
      if (this.fm && this.fmInternal) this.slot[lay.music[0]][lay.music[1]] = this.fm; // 内蔵 MSX-MUSIC(2+ は 3-3、turboR は 0-2)
      this.pageDev = new Array(8).fill(null);
      this.ppiA = 0; this.ppiC = 0; this.ssl = new Uint8Array(4);
      this.joy = [0, 0]; this.joyHeld = [0, 0]; this.joyTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0;
      this.underruns = 0;
      this.cpuCycles = 0; this.frameCount = 0; this._frameFlag = false;
      this.onWrite = null; this.onFrame = null; this.rec = null;
      this.opllLatch = 0; this.oplLatch = 0;
      this.reset();
    }

    reset() {
      this.ppiA = 0; this.ppiC = 0; this.ssl.fill(0);
      this.ramDev.reset();
      this.vdp.reset();
      this.psg.reset();
      if (this.scc) this.scc.reset();
      if (this.opll) this.opll.reset();
      if (this.opl) this.opl.reset();
      if (this.dac) this.dac.reset();
      if (this.fm) this.fm.reset();
      if (this.rtc) this.rtc.reset();
      if (this.kanji) this.kanji.reset();
      if (this.disk) this.disk.reset();
      if (this.s1990) this.s1990.reset();
      if (this.pcm) this.pcm.reset();
      if (this.cart) this.cart.reset();
      if (this.cartB) this.cartB.reset();
      this.keyboard.releaseAll();
      this.cpu.reset();
      this.cpu.pc = 0; this.cpu.sp = 0xF380; this.cpu.im = 1;
      this.opllLatch = 0; this.oplLatch = 0;
      this._remapAll();
      this.cpuCycles = 0;
    }

    // 同梱 C-BIOS を Uint8Array に戻す(機種に無ければ null)。turbor は msx2plus の C-BIOS で代用しない(実 BIOS が要る)
    static defaultBios(machine) {
      const C = Emu.CBIOS;
      if (!C || !C[machine] || !C[machine].main) return null;
      const dec = (b) => { if (!b) return null; if (typeof atob === 'function') { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(b, 'base64')); };
      const e = C[machine];
      return { main: dec(e.main), sub: dec(e.sub), logo: dec(e.logo), music: dec(C.music || null), name: 'C-BIOS ' + (C.version || '') };
    }
    static hasDefaultBios(machine) { const C = Emu.CBIOS; return !!(C && C[machine] && C[machine].main); }
    // 同梱の MSX-MUSIC ROM(C-BIOS の cbios_music.rom)。FM-PAC を挿すときの ROM の既定
    static defaultMusicRom() {
      const C = Emu.CBIOS;
      if (!C || !C.music) return null;
      return MsxConsole.defaultBios(Object.keys(C).find((k) => C[k] && C[k].main) || 'msx2').music;
    }
    static describe(c) {
      const parts = [{ msx1: 'MSX1', msx2: 'MSX2', msx2plus: 'MSX2+', turbor: 'MSX turbo R' }[c.machine] + (c.r800Active ? ' (R800)' : '')];
      if (c.cart) parts.push(c.cart.title + (c.cart.hasSram ? '+SRAM' : ''));
      if (c.kanji) parts.push('漢字');
      const b = { fmpac: 'FM-PAC', msxaudio: 'MSX-AUDIO', scci: 'SCC-I' }[c.cartBKind];
      if (b) parts.push('+' + b); else if (c.cartB) parts.push('+' + c.cartB.title);
      if (c.fmInternal) parts.push('+MSX-MUSIC');
      if (c.disk) parts.push((c.disk.kind === 'tc8566af' ? 'TC8566AF' : 'WD2793') + (c.disk.diskCount ? ' ' + c.disk.diskCount + ' disk' : ''));
      parts.push(`RAM ${(c.ramDev.ram.length / 1024) | 0}K`);
      if (c.bios.name) parts.push(c.bios.name);
      return parts.join(' / ');
    }
    get biosName() { return this.bios.name || null; }
    // 録音/ライブ表示に載る音源
    chips() {
      const out = ['psg'];
      if (this.scc) out.push('scc');
      if (this.opll) out.push('opll');
      if (this.opl) out.push('opl');
      if (this.dac) out.push('dac');
      if (this.pcm) out.push('pcm');
      return out;
    }
    get r800Active() { return !!(this.s1990 && this.s1990.r800); }
    get sccPlus() { return !!((this.cart && this.cart.sccPlusMode) || (this.cartB && this.cartB.sccPlusMode)); }
    extBits() { return 0; }
    // バッテリーバックアップ(7c): カートリッジの SRAM + FM-PAC の SRAM + RTC の RAM を 1 本に("MSXB" + [tag len32 data]...)。
    // 書き込みがあると batteryDirty(主スレッド/Worklet が 1 秒ごとに見て保存し、clearBatteryDirty() で下ろす)。NES と同じ経路(IndexedDB)
    get hasBattery() { return !!((this.cart && this.cart.hasSram) || (this.cartB && this.cartB.hasSram) || this.fm || this.rtc || this.disk); }
    get batteryDirty() { return !!((this.cart && this.cart.sramDirty) || (this.cartB && this.cartB.sramDirty) || (this.fm && this.fm.dirty) || (this.rtc && this.rtc.dirty) || (this.disk && this.disk.dirty)); }
    clearBatteryDirty() { if (this.cart) this.cart.sramDirty = false; if (this.cartB) this.cartB.sramDirty = false; if (this.fm) this.fm.dirty = false; if (this.rtc) this.rtc.dirty = false; if (this.disk) this.disk.clearDirty(); }
    getBattery() {
      if (!this.hasBattery) return null;
      const parts = [];
      const put = (tag, data) => { if (data) parts.push({ tag, data }); };
      put(1, this.cart && this.cart.hasSram ? this.cart.getSram() : null);
      put(2, this.fm ? this.fm.sram.slice() : null);
      put(3, this.rtc ? this.rtc.ram.slice() : null);
      put(4, this.cartB && this.cartB.hasSram ? this.cartB.getSram() : null);
      // 5: 書き込みのあったディスク画像([番号 1 バイト]+画像。開いた .dsk への書き戻し。次に同じ .dsk を開くと復元される)
      if (this.disk) this.disk.images.forEach((im, i) => { if (im.dirty || im.wasDirty) { const d = new Uint8Array(1 + im.img.length); d[0] = i; d.set(im.img, 1); put(5, d); im.wasDirty = true; } });
      let n = 4; for (const p of parts) n += 5 + p.data.length;
      const out = new Uint8Array(n); out.set([0x4D, 0x53, 0x58, 0x42], 0);
      let o = 4;
      for (const p of parts) { out[o] = p.tag; out[o + 1] = p.data.length & 0xFF; out[o + 2] = (p.data.length >> 8) & 0xFF; out[o + 3] = (p.data.length >> 16) & 0xFF; out[o + 4] = (p.data.length >>> 24) & 0xFF; out.set(p.data, o + 5); o += 5 + p.data.length; }
      return out;
    }
    setBattery(bytes) {
      if (!this.hasBattery || !bytes || bytes.length < 4 || bytes[0] !== 0x4D || bytes[1] !== 0x53 || bytes[2] !== 0x58 || bytes[3] !== 0x42) return false;
      let o = 4;
      while (o + 5 <= bytes.length) {
        const tag = bytes[o], len = (bytes[o + 1] | (bytes[o + 2] << 8) | (bytes[o + 3] << 16) | (bytes[o + 4] << 24)) >>> 0;
        const data = bytes.subarray(o + 5, o + 5 + len); o += 5 + len;
        if (tag === 1 && this.cart && this.cart.hasSram) this.cart.setSram(data);
        else if (tag === 2 && this.fm) this.fm.sram.set(data.subarray(0, Math.min(data.length, this.fm.sram.length)));
        else if (tag === 3 && this.rtc) this.rtc.ram.set(data.subarray(0, Math.min(data.length, this.rtc.ram.length)));
        else if (tag === 4 && this.cartB && this.cartB.hasSram) this.cartB.setSram(data);
        else if (tag === 5 && this.disk && data.length > 1) { const im = this.disk.images[data[0]]; if (im && im.img.length === data.length - 1) { im.img.set(data.subarray(1)); im.wasDirty = true; } }
      }
      this.clearBatteryDirty();
      return true;
    }
    get diskCount() { return this.disk ? this.disk.diskCount : 0; }
    // アクセスランプ(ディスク系の媒体の共通形): ドライブごとの [{ access, media }]。ディスクが無ければ null
    diskActivity() { return this.disk ? this.disk.diskActivity() : null; }
    diskBusy() { return this.disk ? this.disk.diskBusy() : false; } // 「速い読み込み」の自動早送りが見る
    insertDisk(n) { if (this.disk) this.disk.insertDisk(n); }
    ejectDisk() { if (this.disk) this.disk.ejectDisk(); }
    addDisk(bytes) { return this.disk ? this.disk.addImage(new Emu.MsxDiskImage(bytes)) : -1; }
    get diskInserted() { return this.disk ? this.disk.inserted : -1; }
    get frame() { return this.vdp.frame; }
    get frameIdx() { return this.vdp.frameIdx; }
    get frameWidth() { return this.vdp.frameWidth; }      // そのフレームの幅(256/512。モードで変わる)
    get frameHeight() { return this.vdp.frameHeight; }      // 240、インターレース中は 480
    get frameIdxHeight() { return Emu.MsxVdp.H; }          // 巻き戻しの索引は常に 240 行
    get interlaced() { return this.vdp.interlaced; }
    get frameIdxWidth() { return this.vdp.frameIdxWidth; } // 巻き戻しの映像の輪(frameIdx)の幅(常に 256)
    get frameIdxKind() { return this.vdp.frameIdxKind; }   // 0=パレット番号、1=GRB332(GRAPHIC7)
    idxPalette(kind) { return kind ? Emu.MsxVdp.G7_PALETTE : this.vdp.palette; }
    get samplesPerFrame() { return this.vdp.linesPerFrame === 313 ? 882 : 735; }
    get frameRate() { return CPU_CLOCK / this.vdp.cyclesPerFrame; }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; }
    // NES と同じビット割り当てで受ける(UI 共通)。A=トリガ 1、B=トリガ 2
    setController(port, bits, turbo) { port &= 1; this.joyHeld[port] = bits & 0xFF; this.joyTurbo[port] = (turbo | 0) & 0xFF; this._applyJoy(port); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyJoy(0); this._applyJoy(1); }
    _applyJoy(p) {
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      const b = this.joyHeld[p] | (on ? this.joyTurbo[p] : 0);
      // NES ビット → PSG R14 のビット(上 1、下 2、左 4、右 8、トリガ A 16、トリガ B 32)
      this.joy[p] = ((b & 16) ? 1 : 0) | ((b & 32) ? 2 : 0) | ((b & 64) ? 4 : 0) | ((b & 128) ? 8 : 0) | ((b & 1) ? 16 : 0) | ((b & 2) ? 32 : 0);
    }
    /** PC のキー(KeyboardEvent.code)。対応が無ければ false */
    setKey(code, down) { return this.keyboard.setPcKey(code, down); }
    setMsxKey(name, down) { return this.keyboard.setKey(name, down); }

    // ── スロット ──
    _remapAll() { for (let p = 0; p < 8; p++) this._remapPage(p); }
    _remapPage(p) {
      const pri = (this.ppiA >> ((p >> 1) * 2)) & 3;
      const sec = this.expanded[pri] ? (this.ssl[pri] >> ((p >> 1) * 2)) & 3 : 0;
      this.pageDev[p] = this.slot[pri][sec];
    }
    _primaryOfPage3() { return (this.ppiA >> 6) & 3; }

    // ── バス(Z80 から) ──
    read(addr) {
      addr &= 0xFFFF;
      if (addr === 0xFFFF) { const pri = this._primaryOfPage3(); if (this.expanded[pri]) return (~this.ssl[pri]) & 0xFF; }
      const d = this.pageDev[addr >>> 13];
      return d ? d.read(addr) : 0xFF;
    }
    write(addr, v) {
      addr &= 0xFFFF; v &= 0xFF;
      if (addr === 0xFFFF) { const pri = this._primaryOfPage3(); if (this.expanded[pri]) { this.ssl[pri] = v; this._remapAll(); return; } }
      const d = this.pageDev[addr >>> 13];
      if (d) d.write(addr, v);
    }
    ioRead(port) {
      port &= 0xFF;
      switch (port) {
        case 0x98: case 0x99: case 0x9A: case 0x9B: return this.vdp.readPort(port);
        case 0xA2: return this.psg.addr === 14 ? this._readJoy() : this.psg.readData();
        case 0xA8: return this.ppiA;
        case 0xA9: return this.keyboard.readRow(this.ppiC & 0x0F);
        case 0xAA: return this.ppiC;
        case 0xAB: return 0xFF;
        case 0xB4: case 0xB5: return this.rtc ? this.rtc.ioRead(port) : 0xFF;
        case 0xD8: case 0xD9: case 0xDA: case 0xDB: return this.kanji ? this.kanji.ioRead(port) : 0xFF;
        case 0xA4: case 0xA5: return this.pcm ? this.pcm.ioRead(port) : 0xFF; // turboR PCM
        case 0xA7: return this.s1990 ? 0x00 : 0xFF;                            // turboR PAUSE(bit0: 押されていない)
        case 0xF4: return this.f4Mode ? (this.f4Mode === 'inverted' ? (~this.f4 & 0xFF) : this.f4) : 0xFF;
        case 0xE4: case 0xE5: case 0xE6: case 0xE7: return this.s1990 ? this.s1990.ioRead(port) : 0xFF;
        case 0xE8: case 0xE9: case 0xEA: case 0xEB: case 0xEC: case 0xED: case 0xEE: case 0xEF: return this.s1990 ? 0x00 : 0xFF; // turboR 内蔵 MSX-MIDI(GT)。無い: 0(★BIOS の INT が $E9 の bit1/bit7 を見てフックへ飛ぶので 0xFF は駄目)
        case 0xC0: return this.opl ? this.opl.readStatus() : 0xFF; // MSX-AUDIO: ステータス(無ければ 0xFF=無し)
        case 0xC1: return this.opl ? this.opl.readData() : 0xFF;
        case 0xFC: case 0xFD: case 0xFE: case 0xFF: return this.ramDev.ioRead(port);
        default: return 0xFF; // OPLL は書き込み専用
      }
    }
    ioWrite(port, v) {
      port &= 0xFF; v &= 0xFF;
      switch (port) {
        case 0x98: case 0x99: case 0x9A: case 0x9B: this.vdp.writePort(port, v); return;
        case 0xA0: this.psg.ioWrite(port, v); return;
        case 0xA1: {
          const reg = this.psg.addr;
          this.psg.ioWrite(port, v);
          if (reg < 14) this._logWrite('psg', reg, v);
          return;
        }
        case 0xA8: this.ppiA = v; this._remapAll(); return;
        case 0xAA: this.ppiC = v; return;
        case 0xAB: if (!(v & 0x80)) { const bit = (v >> 1) & 7; this.ppiC = (v & 1) ? (this.ppiC | (1 << bit)) : (this.ppiC & ~(1 << bit)); } return;
        case 0x7C: if (this.opll) { this.opllLatch = v & 0x3F; this.opll.ioWrite(0x7C, v); } return; // MSX-MUSIC(FM-PAC/内蔵)
        case 0x7D: if (this.opll) { this.opll.ioWrite(0x7D, v); this._logWrite('opll', this.opllLatch, v); } return;
        case 0xB4: case 0xB5: if (this.rtc) this.rtc.ioWrite(port, v); return;
        case 0xD8: case 0xD9: case 0xDA: case 0xDB: if (this.kanji) this.kanji.ioWrite(port, v); return;
        case 0xA4: case 0xA5: if (this.pcm) { const out = this.pcm.ioWrite(port, v); if (out || port === 0xA5) this._logWrite('pcm', port, v); } return; // turboR PCM($A4 は D/A に出た物だけ録音)
        case 0xA7: return;
        case 0xF4: if (this.f4Mode) this.f4 = (this.f4Mode === 'inverted' ? ~v : v) & 0xFF; return;
        case 0xE4: case 0xE5: case 0xE6: case 0xE7: if (this.s1990) this.s1990.ioWrite(port, v); return;
        case 0xE8: case 0xE9: case 0xEA: case 0xEB: case 0xEC: case 0xED: case 0xEE: case 0xEF: return; // MSX-MIDI(無し)
        case 0xC0: if (this.opl) { this.oplLatch = v; this.opl.ioWrite(0xC0, v); } return; // MSX-AUDIO
        case 0xC1: if (this.opl) this._oplData(v); return;
        case 0xFC: case 0xFD: case 0xFE: case 0xFF: this.ramDev.ioWrite(port, v); return;
        default: return;
      }
    }
    // Y8950 のデータ書き込み: ADPCM の再生開始($07 bit7、録音でなく外部メモリ)なら、鳴らす範囲の RAM を書き込みに添える(§5.3)。
    // $0F(メモリへのデータ)は本体が RAM へ入れる。録音には載せない(符号化側で落とす)
    _oplData(v) {
      const reg = this.oplLatch, opl = this.opl;
      let adpcm = null;
      if (reg === 0x07 && (v & 0xE0) === 0xA0) {
        const r = opl.regs;
        const start = (r[0x09] | (r[0x0A] << 8)) << Y8950_ADPCM_UNIT;
        const stop = ((r[0x0B] | (r[0x0C] << 8)) + 1) << Y8950_ADPCM_UNIT;
        const ram = opl.romB;
        if (ram && stop > start) adpcm = { start, data: ram.slice(start, Math.min(stop, ram.length)) };
      }
      opl.ioWrite(0xC1, v);
      if (this.rec) { const w = { chip: 'opl', addr: reg, value: v, t: this._t() }; if (adpcm) w.adpcm = adpcm; this.rec.cur.push(w); }
      if (this.onWrite) this.onWrite('opl', reg, v, this.vdp.frameFrac());
    }
    // PSG R14: R15 bit6 で選んだ口のジョイスティック(押している=0)。bit6 カセット入力=1、bit7 キーボード配列=0(日本語)
    _readJoy() {
      const p = (this.psg.regs[15] >> 6) & 1;
      return (0x3F & ~this.joy[p]) | 0x40;
    }

    // ── 録音 ──
    _t() { const n = this.samplesPerFrame; return Math.min(n - 1, Math.floor(this.vdp.frameFrac() * n)); }
    _logWrite(chip, addr, v) {
      if (this.rec) this.rec.cur.push({ chip, addr, value: v, t: this._t() });
      if (this.onWrite) this.onWrite(chip, addr, v, this.vdp.frameFrac());
    }
    // 今の音源の像(P-4): PSG R0-R13、SCC(波形、周波数、音量、有効)、OPLL($00-$07 音色、$30-$38、$10-$18、$0E、$20-$28 キーオン)、
    // Y8950(音色/周波数、$BD、$B0-$B8 キーオン)。音を出す物(R7、SCC 有効、キーオン)は最後
    audioImage() {
      const out = [];
      const put = (chip, addr, value) => out.push({ chip, addr, value: value & 0xFF, t: 0 });
      const r = this.psg.regs;
      for (let i = 0; i < 14; i++) if (i !== 7) put('psg', i, r[i]);
      put('psg', 7, r[7]);
      if (this.scc) {
        const s = this.scc;
        if (this.sccPlus) {
          put('scc', 0xBFFE, 0x20); put('scc', 0xB000, 0x80); // 配置と窓(読み手の SCC デコーダ用)
          for (let ch = 0; ch < 5; ch++) for (let i = 0; i < 32; i++) put('scc', 0xB800 + ch * 32 + i, s.wave[ch][i]);
          for (let ch = 0; ch < 5; ch++) { put('scc', 0xB8A0 + ch * 2, s.freq[ch]); put('scc', 0xB8A1 + ch * 2, (s.freq[ch] >> 8) & 0x0F); }
          for (let ch = 0; ch < 5; ch++) put('scc', 0xB8AA + ch, s.volume[ch] & 0x0F);
          put('scc', 0xB8AF, s.enable & 0x1F);
        } else {
          put('scc', 0x9000, 0x3F);
          for (let ch = 0; ch < 4; ch++) for (let i = 0; i < 32; i++) put('scc', 0x9800 + ch * 32 + i, s.wave[ch][i]);
          for (let ch = 0; ch < 5; ch++) { put('scc', 0x9880 + ch * 2, s.freq[ch]); put('scc', 0x9881 + ch * 2, (s.freq[ch] >> 8) & 0x0F); }
          for (let ch = 0; ch < 5; ch++) put('scc', 0x988A + ch, s.volume[ch] & 0x0F);
          put('scc', 0x988F, s.enable & 0x1F);
        }
      }
      if (this.opll) {
        const sh = this.opll.regShadow || this.opll.reg || null;
        if (sh) {
          for (let i = 0; i <= 0x07; i++) put('opll', i, sh[i]);
          for (let i = 0; i < 9; i++) put('opll', 0x30 + i, sh[0x30 + i]);
          for (let i = 0; i < 9; i++) put('opll', 0x10 + i, sh[0x10 + i]);
          put('opll', 0x0E, sh[0x0E]);
          for (let i = 0; i < 9; i++) put('opll', 0x20 + i, sh[0x20 + i]);
        }
      }
      if (this.opl) {
        const rg = this.opl.regs;
        put('opl', 0x01, rg[0x01]); put('opl', 0x08, rg[0x08]);
        for (const base of [0x20, 0x40, 0x60, 0x80, 0xE0]) for (let i = 0; i <= 0x15; i++) put('opl', base + i, rg[base + i]);
        for (let i = 0; i < 9; i++) put('opl', 0xC0 + i, rg[0xC0 + i]);
        for (let i = 0; i < 9; i++) put('opl', 0xA0 + i, rg[0xA0 + i]);
        put('opl', 0xBD, rg[0xBD]);
        for (let i = 0; i < 9; i++) put('opl', 0xB0 + i, rg[0xB0 + i]);
      }
      if (this.pcm) put('pcm', 0xA5, this.pcm.status);
      return out;
    }
    startRecording() { this.rec = { frames: [], cur: this.audioImage() }; }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) { rec.cur.spf = this.samplesPerFrame; rec.frames.push(rec.cur); }
      return rec.frames;
    }

    // ── 実行 ──
    step() {
      const cpu = this.cpu;
      let cycles;
      if (cpu.iff1 && !cpu.eiPending && this.vdp.intLine()) cycles = cpu.interrupt();
      else cycles = cpu.step();
      this.advance(cycles);
      return cycles;
    }
    advance(cycles) {
      const vdp = this.vdp, psg = this.psg, scc = this.scc, opll = this.opll, opl = this.opl, dac = this.dac, pcm = this.pcm;
      this.cpuCycles += cycles;
      vdp.step(cycles);
      if (this.disk) this.disk.clock(cycles);
      if (vdp.vblankStarted) { vdp.vblankStarted = false; this.frameCount++; this._frameEnd(); }
      const sr = this.sampleRate;
      for (let c = 0; c < cycles; c++) {
        psg.clock();
        if (scc) scc.clock();
        if (opll) opll.clock();
        if (opl) opl.clock();
        if (sr) {
          this.cycleAccum += sr;
          if (this.cycleAccum >= CPU_CLOCK) {
            this.cycleAccum -= CPU_CLOCK;
            if (this.ringLen < AUDIO_RING) {
              let s = psg.mixSample() * PSG_GAIN;
              if (scc) s += scc.mixSample() * SCC_GAIN;
              if (opll) s += opll.mixSample() * OPLL_GAIN;
              if (opl) s += opl.mixSample() * OPL_GAIN;
              if (dac) s += dac.mixSample() * DAC_GAIN;
              if (pcm) s += pcm.mixSample() * DAC_GAIN;
              this.ring[(this.ringHead + this.ringLen) & (AUDIO_RING - 1)] = s;
              this.ringLen++;
            }
          }
        }
      }
    }
    _frameEnd() {
      this._frameFlag = true;
      if (this.joyTurbo[0] || this.joyTurbo[1] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyJoy(0); this._applyJoy(1); }
      if (this.rec) { this.rec.cur.spf = this.samplesPerFrame; this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      if (this.onFrame) this.onFrame();
    }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) { this.step(); if (++guard > 400000) break; }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 800000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    takeAudioInto(out, n) {
      const take = Math.min(n, this.ringLen);
      for (let i = 0; i < take; i++) out[i] = this.ring[(this.ringHead + i) & (AUDIO_RING - 1)];
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & (AUDIO_RING - 1);
      this.ringLen -= take;
    }

    // 鍵盤表示のミュート/音量(worklet の mix メッセージ)。psg: [3]、scc: [5]、opll: [14]、opl: [15]、dac: [1]
    applyMix(mute, volume) {
      const put = (target, source, conv) => { if (!target || !source) return; for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); };
      const chips = { psg: this.psg, scc: this.scc, opll: this.opll, opl: this.opl, dac: this.dac, pcm: this.pcm };
      for (const k of Object.keys(chips)) {
        const c = chips[k];
        if (!c) continue;
        if (k === 'pcm') { if (mute && mute.dac) put(c.mute, mute.dac, (v) => !!v); if (volume && volume.dac) put(c.vol, volume.dac, (v) => Math.max(0, Math.min(2, +v || 0))); continue; } // turboR PCM は dac(KDA 行)の指定に従う
        if (mute && mute[k]) put(c.mute, mute[k], (v) => !!v);
        if (volume && volume[k] && c.vol) put(c.vol, volume[k], (v) => Math.max(0, Math.min(2, +v || 0)));
      }
    }
    // ステート復元の後(msxState.js): 参照の張り替えだけの物を作り直す
    afterRestore() {
      if (this.cart) { if (this.cart.type === 'plain') this.cart._mapPlain(); else this.cart._remap(); }
      if (this.cartB) { if (this.cartB.type === 'plain') this.cartB._mapPlain(); else this.cartB._remap(); }
      if (this.opl && this.opl._pitchCache) this.opl._pitchCache.clear();
      if (this.s1990) { this.s1990.owner = this; this.s1990._applyCpu(); }
      if (this.pcm) this.pcm.owner = this;
      this._remapAll();
    }
  }
  // バッテリーの塊("MSXB")から tag 5(書き込みのあったディスク画像: [番号]+画像)を取り出す(主スレッドが書き出し/書き戻しに使う)
  MsxConsole.batteryDisks = (blob) => {
    const out = [];
    if (!blob || blob.length < 4 || blob[0] !== 0x4D || blob[1] !== 0x53 || blob[2] !== 0x58 || blob[3] !== 0x42) return out;
    let o = 4;
    while (o + 5 <= blob.length) {
      const tag = blob[o], len = (blob[o + 1] | (blob[o + 2] << 8) | (blob[o + 3] << 16) | (blob[o + 4] << 24)) >>> 0;
      const data = blob.subarray(o + 5, o + 5 + len); o += 5 + len;
      if (tag === 5 && data.length > 1) out.push({ index: data[0], image: data.subarray(1) });
    }
    return out;
  };
  MsxConsole.CPU_CLOCK = CPU_CLOCK;
  MsxConsole.MACHINES = MACHINES;
  MsxConsole.CART_B_KINDS = CART_B_KINDS;
  MsxConsole.BUTTON = { A: 1, B: 2, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  // ファイル名/中身から MSX の物か(ゲーム画面の機種自動判別)
  MsxConsole.isMsxFile = (name, bytes) => (/\.(rom|mx1|mx2)$/i.test(name || '') && !(bytes && bytes.length >= 4 && bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1A)) || MsxConsole.isDskFile(name, bytes);
  MsxConsole.isDskFile = (name, bytes) => /\.dsk$/i.test(name || '') && !!(bytes && Emu.MsxDiskImage && Emu.MsxDiskImage.isDsk(bytes));
  Emu.MsxConsole = MsxConsole;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MSX 本体のステート(状態の保存・復元) MML.Emu.MsxState — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md §4、段階 7a)
 *
 * 作り: NES と同じく本体のオブジェクト木を汎用に写す(nes/nesState.js の Emu.StateTree)。除外するキー:
 *   rom(カートリッジ/BIOS の ROM 本体)、banks/pages/pageDev/slot/list(ROM への参照の張り替えだけの物。復元後に afterRestore() で作り直す)、
 *   rec/ring/frame/frameIdx/lineBuf/sprBuf/onFrame/onWrite/onInt/bus/opts/bios/keyboard.map。
 *   palette(表示色)は paletteRaw から作れるが小さいので写す。
 * 形: { v: 1, machine, romLen, tree }
 *
 * 差分圧縮(巻き戻しの控え用、2026-11-08 決定): pack(state, prevState) は木を辿り、2048 バイト以上の型付き配列で
 * 前回と同じ長さ・型の物を「前回との XOR をランレングスで」{ __xd: Uint8Array } に置き換える。VRAM 128K+RAM 128K〜 でも
 * ゲーム中に 1 スナップショット(0.5 秒)で変わる領域は狭いので数 KB になる。unpack(packed, prevUnpacked) で戻す。
 * 連鎖の長さは呼び手(msxRewind.js)がキーフレーム間隔で切る。
 *   XOR-RLE の形: [ゼロ連長 u16][非ゼロ連長 u16][非ゼロの XOR バイト列] の繰り返し(連長は 0xFFFF で分割)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SKIP_KEYS = new Set(['rom', 'banks', 'pages', 'pageDev', 'slot', 'list', 'rec', 'ring', 'frame', 'frameIdx', 'lineBuf', 'sprBuf',
    'onFrame', 'onWrite', 'onInt', 'bus', 'opts', 'bios', 'map', 'traps',
    'owner', '_pitchCache', 'patchrom', 'sintbl', '_sramMirror', '_sprOwner', 'img', 'images', 'image']); // img/images/image: ディスク画像(大きい。本体に残る) // _sramMirror/_sprOwner: 作業用(復元後に作り直す) // owner: Y8950 の ADPCM が親を指す(循環)、_pitchCache: Map(復元後に消す)、patchrom/sintbl: 定数表
  const DIFF_MIN = 2048;

  function xorRle(cur, prev) {
    const n = cur.length, out = [];
    let i = 0;
    while (i < n) {
      let z = 0; while (i + z < n && cur[i + z] === prev[i + z] && z < 0xFFFF) z++;
      i += z;
      let nz = 0; while (i + nz < n && cur[i + nz] !== prev[i + nz] && nz < 0xFFFF) nz++;
      out.push(z & 0xFF, z >> 8, nz & 0xFF, nz >> 8);
      for (let k = 0; k < nz; k++) out.push((cur[i + k] ^ prev[i + k]) & 0xFF);
      i += nz;
    }
    return Uint8Array.from(out);
  }
  function unXorRle(rle, prev, Ctor) {
    const n = prev.length, out = new Uint8Array(n);
    out.set(prev);
    let p = 0, i = 0;
    while (p + 4 <= rle.length) {
      const z = rle[p] | (rle[p + 1] << 8), nz = rle[p + 2] | (rle[p + 3] << 8); p += 4;
      i += z;
      for (let k = 0; k < nz; k++) out[i + k] ^= rle[p + k];
      p += nz; i += nz;
    }
    return Ctor === Uint8Array ? out : new Ctor(out.buffer);
  }
  const isTyped = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);
  // 型付き配列はバイト列として比較/差分する(Uint16/Uint32 も)
  const bytesOf = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

  function pack(node, prev) {
    if (node === null || typeof node !== 'object') return node;
    if (isTyped(node)) {
      if (prev && isTyped(prev) && prev.constructor === node.constructor && prev.length === node.length && node.byteLength >= DIFF_MIN) {
        return { __xd: xorRle(bytesOf(node), bytesOf(prev)), __ct: node.constructor.name };
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((x, i) => pack(x, prev && Array.isArray(prev) ? prev[i] : undefined));
    const out = {};
    for (const k of Object.keys(node)) out[k] = pack(node[k], prev && typeof prev === 'object' && !isTyped(prev) ? prev[k] : undefined);
    return out;
  }
  function unpack(node, prev) {
    if (node === null || typeof node !== 'object') return node;
    if (isTyped(node)) return node;
    if (node.__xd) {
      const Ctor = global[node.__ct] || Uint8Array;
      return unXorRle(node.__xd, bytesOf(prev), Ctor);
    }
    if (Array.isArray(node)) return node.map((x, i) => unpack(x, prev && Array.isArray(prev) ? prev[i] : undefined));
    const out = {};
    for (const k of Object.keys(node)) out[k] = unpack(node[k], prev && typeof prev === 'object' ? prev[k] : undefined);
    return out;
  }
  // 木のおよその大きさ(バイト)。容量の実測用
  function sizeOf(node) {
    if (node === null || typeof node !== 'object') return 8;
    if (isTyped(node)) return node.byteLength;
    if (node.__xd) return node.__xd.byteLength + 16;
    let n = 16;
    if (Array.isArray(node)) { for (const x of node) n += sizeOf(x); return n; }
    for (const k of Object.keys(node)) n += k.length + sizeOf(node[k]);
    return n;
  }

  const MsxState = {
    save(msx) {
      const T = Emu.StateTree;
      return { v: 1, machine: msx.machine, romLen: msx.cart ? msx.cart.rom.length : 0, tree: T.snapshot(msx, [], SKIP_KEYS) };
    },
    load(msx, state) {
      if (!state || state.v !== 1 || !state.tree) return false;
      if (state.machine !== msx.machine || state.romLen !== (msx.cart ? msx.cart.rom.length : 0)) return false;
      const rec = msx.rec;
      Emu.StateTree.restore(msx, state.tree);
      msx.rec = rec;
      msx.ringHead = 0; msx.ringLen = 0;
      msx._frameFlag = false;
      msx.afterRestore();
      return true;
    },
    // 巻き戻しの控え用: 前のステート(展開済み)との差分に圧縮 / 展開
    pack(state, prevState) { return Object.assign({}, state, { tree: pack(state.tree, prevState ? prevState.tree : undefined), packed: true }); },
    unpack(packed, prevState) { return Object.assign({}, packed, { tree: unpack(packed.tree, prevState ? prevState.tree : undefined), packed: false }); },
    sizeOf(state) { return sizeOf(state.tree); },
    SKIP_KEYS,
  };
  Emu.MsxState = MsxState;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * MSX 巻き戻し (MML.Emu.MsxRewind) — nes/nesRewind.js と同じ作り(状態スナップショット+入力ログ+映像の輪)。違いは 3 つ:
 *   1. スナップショットは前回との差分に圧縮して控える(msxState.js の pack/unpack)。KEY_EVERY 個ごとに全量(キーフレーム)、
 *      間は直前からの XOR-RLE。読むときはキーフレームから順に展開する(最長 KEY_EVERY-1 回)。
 *   2. 入力はジョイスティック 2 口(joy[])に加えてキーボードの行(12 バイト)も毎フレーム控える(キー入力で進むゲームの再現に要る)
 *   3. 映像の輪は 8bit の索引(vdp.frameIdx、常に 256 幅。フレームの幅 512 のモードは 1 ドットおき)。表示色は paletteOf(frame)
 *      (パレット番号なら本体の vdp.palette 16 色、GRAPHIC7 のフレームなら GRB332 の 256 色表)。呼び手が rwframe に palette を添える
 * 使い方は NesRewind と同じ: onFrame()/rewindTo(frame)/beginReverse()/reverseStep()/regenStep(n)/endReverse()/clear()/oldest
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INTERVAL = 30;   // スナップショットの間隔(フレーム)。0.5 秒
  const KEEP = 240;      // 控える個数。2 分
  const KEY_EVERY = 16;  // キーフレーム(全量)の間隔。実測(テスト ROM、MSX2 128K+VRAM 128K): 全量 265KB、差分 2.6KB。240 個で 8 なら 13.8MB、16 なら約 8MB
  const RING = 600;      // 映像の輪の枚数(10 秒)
  const KB_ROWS = 12;

  class MsxRewind {
    constructor(msx) {
      this.msx = msx;
      this.snaps = [];          // [{ frame, state(packed or full), key }]
      this.inputs = [];         // inputs[frame - base] = Uint8Array(2 + KB_ROWS): joy0, joy1, 行 0-11
      this.base = 0;
      this.replaying = false;
      this.ring = null;
      this.frameBytes = (msx.frameIdxWidth || msx.frameWidth) * msx.frameHeight; // frameIdx は常に 256 幅(vdp.js)
      this.ringFrame = new Int32Array(RING).fill(-1);
      this.ringKind = new Uint8Array(RING); // そのフレームの frameIdx の種類(0=パレット番号、1=GRB332。GRAPHIC7)
      this.rv = null;
      this._lastFull = null;    // 直近に控えた全量のステート(次の差分の基準)
      this.bytes = 0;           // 控えている状態のおよその合計バイト数(容量の実測用)
    }
    clear() { this.snaps.length = 0; this.inputs.length = 0; this.base = this.msx.frameCount; this.ringFrame.fill(-1); this._lastFull = null; this.bytes = 0; }
    _capture(f) {
      if (!this.ring) this.ring = new Uint8Array(RING * this.frameBytes);
      const slot = f % RING;
      this.ring.set(this.msx.frameIdx, slot * this.frameBytes);
      this.ringFrame[slot] = f;
      this.ringKind[slot] = this.msx.frameIdxKind || 0;
    }
    frameAt(f) {
      const slot = f % RING;
      return this.ring && this.ringFrame[slot] === f ? this.ring.subarray(slot * this.frameBytes, (slot + 1) * this.frameBytes) : null;
    }
    get palette() { return this.msx.vdp.palette; }
    get idxWidth() { return this.msx.frameIdxWidth || this.msx.frameWidth; }
    // フレーム f の映像の輪の表示色(G7 のフレームは 256 色の GRB 表)
    paletteOf(f) { const slot = f % RING; return this.msx.idxPalette ? this.msx.idxPalette(this.ringFrame[slot] === f ? this.ringKind[slot] : 0) : this.msx.vdp.palette; }
    // i 番目のスナップショットを全量で返す(キーフレームから展開)
    _stateAt(i) {
      const S = Emu.MsxState;
      let k = i;
      while (k > 0 && !this.snaps[k].key) k--;
      let st = this.snaps[k].state;
      for (let j = k + 1; j <= i; j++) st = S.unpack(this.snaps[j].state, st);
      return st;
    }
    _inputNow() {
      const m = this.msx, u = new Uint8Array(2 + KB_ROWS);
      u[0] = m.joy[0]; u[1] = m.joy[1];
      u.set(m.keyboard.rows.subarray(0, KB_ROWS), 2);
      return u;
    }
    _applyInput(u) {
      const m = this.msx;
      if (!u) return;
      m.joy[0] = u[0]; m.joy[1] = u[1];
      m.keyboard.rows.set(u.subarray(2, 2 + KB_ROWS));
    }
    beginReverse() {
      if (this.rv || !this.snaps.length) return false;
      const m = this.msx;
      this.rv = { cur: m.frameCount, regen: null, moved: false, wasRec: !!m.rec };
      m.rec = null;
      return this.rv;
    }
    reverseStep() {
      const rv = this.rv;
      if (!rv) return false;
      const target = rv.cur - 1;
      if (target <= this.oldest) return false;
      const img = this.frameAt(target);
      if (img) { rv.cur = target; rv.moved = true; return img; }
      if (!rv.regen) {
        let si = -1;
        for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame < target) { si = i; break; }
        if (si < 0) return false;
        Emu.MsxState.load(this.msx, this._stateAt(si));
        rv.regen = { next: this.snaps[si].frame + 1, upto: target };
        this.replaying = true;
      }
      return null;
    }
    regenStep(n) {
      const rv = this.rv;
      if (!rv || !rv.regen) return;
      const m = this.msx, g = rv.regen;
      for (let k = 0; k < n && g.next <= g.upto; k++) {
        this._applyInput(this.inputs[g.next - this.base]);
        m.runFrame();
        this._capture(m.frameCount);
        g.next = m.frameCount + 1;
      }
      if (g.next > g.upto) { rv.regen = null; this.replaying = false; }
    }
    endReverse() {
      const rv = this.rv;
      if (!rv) return this.msx.frameCount;
      const m = this.msx;
      this.rv = null; this.replaying = false;
      const recNow = !!m.rec; m.rec = null;
      let got = m.frameCount;
      if (rv.moved || rv.regen) got = this.rewindTo(rv.cur, true);
      if (rv.wasRec || recNow) m.startRecording();
      return got;
    }
    get oldest() { return this.snaps.length ? this.snaps[0].frame : this.msx.frameCount; }
    onFrame() {
      if (this.replaying) return;
      const m = this.msx, f = m.frameCount;
      if (this.base > f) this.clear();
      this.inputs[f - this.base] = this._inputNow();
      this._capture(f);
      if (f % INTERVAL === 0) {
        const S = Emu.MsxState;
        const full = S.save(m);
        const key = !this._lastFull || (this.snaps.length % KEY_EVERY) === 0;
        const state = key ? full : S.pack(full, this._lastFull);
        this._lastFull = full;
        this.snaps.push({ frame: f, state, key });
        this.bytes += S.sizeOf(state);
        if (this.snaps.length > KEEP) {
          // 先頭を落とす。先頭は常にキーフレーム(全量)。次が差分なら、落とす物を基準に全量へ戻して新しい先頭をキーフレームにする
          const drop = this.snaps.shift();
          this.bytes -= S.sizeOf(drop.state);
          if (!this.snaps[0].key) {
            const full0 = S.unpack(this.snaps[0].state, drop.state);
            this.bytes -= S.sizeOf(this.snaps[0].state);
            this.snaps[0] = { frame: this.snaps[0].frame, state: full0, key: true };
            this.bytes += S.sizeOf(full0);
          }
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.inputs.splice(0, keepFrom - this.base); this.base = keepFrom; }
        }
      }
    }
    rewindTo(frame, force) {
      const m = this.msx;
      if (!this.snaps.length || (frame >= m.frameCount && !force)) return m.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const full = this._stateAt(si);
      // 今押している物(ジョイスティック/キーボード)は状態を読む「前」に控える(読んだ後に取ると、巻き戻した先で押していた物が残って押しっぱなしになった。2026-11-11)
      const held = [m.joyHeld[0], m.joyHeld[1]], turbo = [m.joyTurbo[0], m.joyTurbo[1]];
      const rowsNow = m.keyboard.rows.slice();
      Emu.MsxState.load(m, full);
      this.replaying = true;
      try {
        while (m.frameCount < frame) {
          this._applyInput(this.inputs[m.frameCount + 1 - this.base]);
          m.runFrame();
          this._capture(m.frameCount);
        }
      } finally { this.replaying = false; }
      // 未来のスナップショットと入力記録は捨てる。差分の基準は今の状態(全量)に置き直す
      for (let i = si + 1; i < this.snaps.length; i++) this.bytes -= Emu.MsxState.sizeOf(this.snaps[i].state);
      this.snaps.length = si + 1;
      this._lastFull = full;
      if (!this.snaps[si].key) { this.bytes -= Emu.MsxState.sizeOf(this.snaps[si].state); this.snaps[si] = { frame: this.snaps[si].frame, state: full, key: true }; this.bytes += Emu.MsxState.sizeOf(full); }
      this.inputs.length = Math.max(0, m.frameCount + 1 - this.base);
      m.joyHeld[0] = held[0]; m.joyHeld[1] = held[1]; m.joyTurbo[0] = turbo[0]; m.joyTurbo[1] = turbo[1];
      m._applyJoy(0); m._applyJoy(1);
      m.keyboard.rows.set(rowsNow);
      return m.frameCount;
    }
  }
  MsxRewind.INTERVAL = INTERVAL;
  MsxRewind.KEEP = KEEP;
  MsxRewind.RING = RING;
  MsxRewind.KEY_EVERY = KEY_EVERY;
  Emu.MsxRewind = MsxRewind;
})(typeof window !== 'undefined' ? window : globalThis);

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
 *
 * ★2026-11-13 M サイクル単位に作り直し(DESIGN-GB-CAPTURE.md §2.1)。バスに次が在れば使う(本体コア gb/gbConsole.js):
 *   - bus.tick()        : 1 M サイクル(4T)ぶん本体を進める。読み書きの前と内部サイクルで呼ぶ
 *   - bus.irqPending()  : IE & IF & $1F。bus.irqAck(bit) で IF を下ろす。割り込みの受け付け/HALT の起床/HALT バグに使う
 *   - bus.stop(cpu)     : STOP 命令
 *   どれも無いバス(CPU テストなど)では「割り込み無し、step() が T を返すだけ」で動く。
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
      this.hasTick = typeof bus.tick === 'function';        // 本体コア(gb/gbConsole.js)は M サイクルごとに進む
      this.hasIrq = typeof bus.irqPending === 'function';   // IE & IF & $1F を返す。無ければ割り込み無し(GBS の旧経路)
      this.cyc = 0; // 通算 T(4 刻み)
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
      this.haltBug = false;
      this.callActive = false;
    }

    // --- メモリアクセス ---
    // バスの読み書き 1 回 = 1 M サイクル。アクセスの前に本体を 4T 進める(bus.tick が在る時。GBS の旧バスには無い)
    read(addr) { this.cyc += 4; if (this.hasTick) this.bus.tick(); return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.cyc += 4; if (this.hasTick) this.bus.tick(); this.bus.write(addr & 0xFFFF, value & 0xFF); }
    // バスに触らない内部 M サイクル
    idle() { this.cyc += 4; if (this.hasTick) this.bus.tick(); }

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
      this.idle();
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
    // 1 命令(または割り込みの受け付け、HALT 中の 1 M サイクル)を実行し、かかった T を返す。
    // 時間は read/write/idle が進めた分を数える。execMain/execCB の return 値は命令表の公称値で、
    // 両者が合うことは tools/headless/cpu-test.js が見る(M サイクルごとのバスの動きも突き合わせる)。
    //
    // 割り込みを見るのは「命令の取り込みサイクルを進めた後」。実機は前の命令の最後のサイクル(=次の命令の取り込みと
    // 重なる)で割り込みを判定するので、取り込みサイクルの間に立った IF はその命令を実行させずに飛ぶ
    // (mooneye の timer/rapid_toggle が見る。先に判定すると 1 命令遅れる)。
    step() {
      const c0 = this.cyc;
      if (this.halted) {
        this.idle();
        if (!(this.hasIrq && this.bus.irqPending())) return this.cyc - c0;
        this.halted = false;
        if (this.ime) { this.dispatchIrq(); return this.cyc - c0; }
        // IME=0 の起床: 保留を見つけたこのサイクルが次の命令の取り込みを兼ねる
      } else {
        // EI の次の 1 命令が終わるまで割り込みは入らない(この命令の後から有効)。RETI は即時
        const ime = this.ime;
        if (this.imePending > 0) { this.imePending = 0; this.ime = true; }
        this.cyc += 4; if (this.hasTick) this.bus.tick(); // 取り込みサイクル
        if (ime && this.hasIrq && this.bus.irqPending()) { this.dispatchIrq(); return this.cyc - c0; }
      }
      const opcode = this.bus.read(this.pc) & 0xFF;
      if (this.haltBug) this.haltBug = false; else this.pc = (this.pc + 1) & 0xFFFF;
      this.lastNominal = opcode === 0xCB ? this.execCB() : this.execMain(opcode);
      return this.cyc - c0;
    }

    // 割り込みの受け付け。判定した取り込みサイクル(または HALT の起床サイクル)を含めて 5 M サイクル:
    // 内部 2、PC の上位/下位を積む 2。PC の上位を積んだ後に IE/IF が変わって保留が消えると PC=0 へ飛ぶ(実機の癖)
    dispatchIrq() {
      this.ime = false; this.imePending = 0;
      this.idle(); this.idle();
      this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, (this.pc >> 8) & 0xFF);
      const pend = this.bus.irqPending();
      this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, this.pc & 0xFF);
      if (!pend) this.pc = 0;
      else {
        let bit = 0; while (!((pend >> bit) & 1)) bit++;
        this.bus.irqAck(bit);
        this.pc = 0x40 + bit * 8;
      }
    }

    execMain(opcode) {
      switch (opcode) {
        case 0x00: return 4; // NOP
        case 0x01: this.setBC(this.fetch16()); return 12;
        case 0x02: this.write(this.getBC(), this.a); return 8;
        case 0x03: this.setBC((this.getBC() + 1) & 0xFFFF); this.idle(); return 8;
        case 0x04: this.b = this.inc8(this.b); return 4;
        case 0x05: this.b = this.dec8(this.b); return 4;
        case 0x06: this.b = this.fetchByte(); return 8;
        case 0x07: this.rlca(); return 4;
        case 0x08: { const nn = this.fetch16(); this.write(nn, this.sp & 0xFF); this.write((nn + 1) & 0xFFFF, (this.sp >> 8) & 0xFF); return 20; }
        case 0x09: this.addHL(this.getBC()); return 8;
        case 0x0A: this.a = this.read(this.getBC()); return 8;
        case 0x0B: this.setBC((this.getBC() - 1) & 0xFFFF); this.idle(); return 8;
        case 0x0C: this.c = this.inc8(this.c); return 4;
        case 0x0D: this.c = this.dec8(this.c); return 4;
        case 0x0E: this.c = this.fetchByte(); return 8;
        case 0x0F: this.rrca(); return 4;

        // STOP 0: SingleStepTests実測では2バイト目を実際には読まず(bus読出し無しの内部
        // サイクルのみ)、PCは1しか進まないが所要時間は3Mサイクル(12T)。
        case 0x10:
          if (this.bus.stop) { this.bus.stop(this); return 4; } // 本体コア: CGB の速度切り替え/キー待ち
          this.stopped = true; this.idle(); this.idle(); return 12;
        case 0x11: this.setDE(this.fetch16()); return 12;
        case 0x12: this.write(this.getDE(), this.a); return 8;
        case 0x13: this.setDE((this.getDE() + 1) & 0xFFFF); this.idle(); return 8;
        case 0x14: this.d = this.inc8(this.d); return 4;
        case 0x15: this.d = this.dec8(this.d); return 4;
        case 0x16: this.d = this.fetchByte(); return 8;
        case 0x17: this.rla(); return 4;
        case 0x18: { const d = this.fetchSigned(); this.pc = (this.pc + d) & 0xFFFF; this.idle(); return 12; }
        case 0x19: this.addHL(this.getDE()); return 8;
        case 0x1A: this.a = this.read(this.getDE()); return 8;
        case 0x1B: this.setDE((this.getDE() - 1) & 0xFFFF); this.idle(); return 8;
        case 0x1C: this.e = this.inc8(this.e); return 4;
        case 0x1D: this.e = this.dec8(this.e); return 4;
        case 0x1E: this.e = this.fetchByte(); return 8;
        case 0x1F: this.rra(); return 4;

        case 0x20: { const d = this.fetchSigned(); if (!this.getFlag(F_Z)) { this.pc = (this.pc + d) & 0xFFFF; this.idle(); return 12; } return 8; }
        case 0x21: this.setHL(this.fetch16()); return 12;
        case 0x22: this.write(this.getHL(), this.a); this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x23: this.setHL((this.getHL() + 1) & 0xFFFF); this.idle(); return 8;
        case 0x24: this.h = this.inc8(this.h); return 4;
        case 0x25: this.h = this.dec8(this.h); return 4;
        case 0x26: this.h = this.fetchByte(); return 8;
        case 0x27: this.daa(); return 4;
        case 0x28: { const d = this.fetchSigned(); if (this.getFlag(F_Z)) { this.pc = (this.pc + d) & 0xFFFF; this.idle(); return 12; } return 8; }
        case 0x29: this.addHL(this.getHL()); return 8;
        case 0x2A: this.a = this.read(this.getHL()); this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x2B: this.setHL((this.getHL() - 1) & 0xFFFF); this.idle(); return 8;
        case 0x2C: this.l = this.inc8(this.l); return 4;
        case 0x2D: this.l = this.dec8(this.l); return 4;
        case 0x2E: this.l = this.fetchByte(); return 8;
        case 0x2F: this.a = (~this.a) & 0xFF; this.setFlag(F_N, true); this.setFlag(F_H, true); return 4; // CPL

        case 0x30: { const d = this.fetchSigned(); if (!this.getFlag(F_C)) { this.pc = (this.pc + d) & 0xFFFF; this.idle(); return 12; } return 8; }
        case 0x31: this.sp = this.fetch16(); return 12;
        case 0x32: this.write(this.getHL(), this.a); this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x33: this.sp = (this.sp + 1) & 0xFFFF; this.idle(); return 8;
        case 0x34: { const hl = this.getHL(); this.write(hl, this.inc8(this.read(hl))); return 12; }
        case 0x35: { const hl = this.getHL(); this.write(hl, this.dec8(this.read(hl))); return 12; }
        case 0x36: this.write(this.getHL(), this.fetchByte()); return 12;
        case 0x37: this.setFlag(F_C, true); this.setFlag(F_N, false); this.setFlag(F_H, false); return 4; // SCF
        case 0x38: { const d = this.fetchSigned(); if (this.getFlag(F_C)) { this.pc = (this.pc + d) & 0xFFFF; this.idle(); return 12; } return 8; }
        case 0x39: this.addHL(this.sp); return 8;
        case 0x3A: this.a = this.read(this.getHL()); this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; this.idle(); return 8;
        case 0x3C: this.a = this.inc8(this.a); return 4;
        case 0x3D: this.a = this.dec8(this.a); return 4;
        case 0x3E: this.a = this.fetchByte(); return 8;
        case 0x3F: { const c = this.getFlag(F_C); this.setFlag(F_C, !c); this.setFlag(F_N, false); this.setFlag(F_H, false); return 4; } // CCF
      }

      if (opcode >= 0x40 && opcode <= 0x7F) {
        if (opcode === 0x76) { // HALT: 命令は 1 M サイクル。止まっている間は step() が 1 M サイクルずつ空回りする
          // IME=0 で割り込みが既に保留なら止まらず、次の 1 バイトを 2 度読む(HALT バグ)
          if (!this.ime && this.hasIrq && this.bus.irqPending()) this.haltBug = true;
          else this.halted = true;
          return 4;
        }
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
        case 0xC0: this.idle(); if (!this.getFlag(F_Z)) { this.pc = this.pop16(); this.idle(); return 20; } return 8;
        case 0xC1: this.setBC(this.pop16()); return 12;
        case 0xC2: { const nn = this.fetch16(); if (!this.getFlag(F_Z)) { this.pc = nn; this.idle(); return 16; } return 12; }
        case 0xC3: this.pc = this.fetch16(); this.idle(); return 16;
        case 0xC4: { const nn = this.fetch16(); if (!this.getFlag(F_Z)) { this.idle(); this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xC5: this.idle(); this.push16(this.getBC()); return 16;
        case 0xC6: this.add8(this.fetchByte(), 0); return 8;
        case 0xC7: this.idle(); this.push16(this.pc); this.pc = 0x00; return 16;
        case 0xC8: this.idle(); if (this.getFlag(F_Z)) { this.pc = this.pop16(); this.idle(); return 20; } return 8;
        case 0xC9: this.pc = this.pop16(); this.idle(); return 16;
        case 0xCA: { const nn = this.fetch16(); if (this.getFlag(F_Z)) { this.pc = nn; this.idle(); return 16; } return 12; }
        case 0xCC: { const nn = this.fetch16(); if (this.getFlag(F_Z)) { this.idle(); this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xCD: { const nn = this.fetch16(); this.idle(); this.push16(this.pc); this.pc = nn; return 24; }
        case 0xCE: this.add8(this.fetchByte(), this.getFlag(F_C) ? 1 : 0); return 8;
        case 0xCF: this.idle(); this.push16(this.pc); this.pc = 0x08; return 16;

        case 0xD0: this.idle(); if (!this.getFlag(F_C)) { this.pc = this.pop16(); this.idle(); return 20; } return 8;
        case 0xD1: this.setDE(this.pop16()); return 12;
        case 0xD2: { const nn = this.fetch16(); if (!this.getFlag(F_C)) { this.pc = nn; this.idle(); return 16; } return 12; }
        case 0xD4: { const nn = this.fetch16(); if (!this.getFlag(F_C)) { this.idle(); this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xD5: this.idle(); this.push16(this.getDE()); return 16;
        case 0xD6: this.sub8(this.fetchByte(), 0, true); return 8;
        case 0xD7: this.idle(); this.push16(this.pc); this.pc = 0x10; return 16;
        case 0xD8: this.idle(); if (this.getFlag(F_C)) { this.pc = this.pop16(); this.idle(); return 20; } return 8;
        case 0xD9: this.pc = this.pop16(); this.idle(); this.ime = true; this.imePending = 0; return 16; // RETI(EIと違い即時)
        case 0xDA: { const nn = this.fetch16(); if (this.getFlag(F_C)) { this.pc = nn; this.idle(); return 16; } return 12; }
        case 0xDC: { const nn = this.fetch16(); if (this.getFlag(F_C)) { this.idle(); this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xDE: this.sub8(this.fetchByte(), this.getFlag(F_C) ? 1 : 0, true); return 8;
        case 0xDF: this.idle(); this.push16(this.pc); this.pc = 0x18; return 16;

        case 0xE0: { const n = this.fetchByte(); this.write(0xFF00 + n, this.a); return 12; } // LDH (n),A
        case 0xE1: this.setHL(this.pop16()); return 12;
        case 0xE2: this.write(0xFF00 + this.c, this.a); return 8; // LDH (C),A
        case 0xE5: this.idle(); this.push16(this.getHL()); return 16;
        case 0xE6: this.and8(this.fetchByte()); return 8;
        case 0xE7: this.idle(); this.push16(this.pc); this.pc = 0x20; return 16;
        case 0xE8: { const r = this.addSpR8(); this.idle(); this.idle(); this.sp = r; return 16; }
        case 0xE9: this.pc = this.getHL(); return 4; // JP HL(間接読出しではなくPC=HL)
        case 0xEA: { const nn = this.fetch16(); this.write(nn, this.a); return 16; }
        case 0xEE: this.xor8(this.fetchByte()); return 8;
        case 0xEF: this.idle(); this.push16(this.pc); this.pc = 0x28; return 16;

        case 0xF0: { const n = this.fetchByte(); this.a = this.read(0xFF00 + n); return 12; } // LDH A,(n)
        case 0xF1: this.setAF(this.pop16()); return 12;
        case 0xF2: this.a = this.read(0xFF00 + this.c); return 8; // LDH A,(C)
        case 0xF3: this.ime = false; this.imePending = 0; return 4; // DI
        case 0xF5: this.idle(); this.push16(this.getAF()); return 16;
        case 0xF6: this.or8(this.fetchByte()); return 8;
        case 0xF7: this.idle(); this.push16(this.pc); this.pc = 0x30; return 16;
        case 0xF8: this.setHL(this.addSpR8()); this.idle(); return 12;
        case 0xF9: this.sp = this.getHL(); this.idle(); return 8;
        case 0xFA: { const nn = this.fetch16(); this.a = this.read(nn); return 16; }
        case 0xFB: if (!this.ime && this.imePending === 0) this.imePending = 1; return 4; // EI(次の 1 命令が終わってから有効)
        case 0xFE: this.sub8(this.fetchByte(), 0, false); return 8;
        case 0xFF: this.idle(); this.push16(this.pc); this.pc = 0x38; return 16;
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
      if (this.halted || this.haltBug) { this.halted = false; this.haltBug = false; this.callActive = false; return 4; }
      const c = this.step();
      if (this.pc === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  Emu.CPUSm83 = CPUSm83;
  Emu.SM83_FLAGS = { C: F_C, H: F_H, N: F_N, Z: F_Z };
})(globalThis);

/*
 * Game Boy 内蔵音源エミュレータ
 * MML.Emu.APUGb
 *
 * CH1(パルス+周波数スイープ)、CH2(パルス)、CH3(波形メモリ 32 サンプル×4bit)、CH4(ノイズ)。
 * レジスタは $FF10-$FF26(NR10-NR52)+ $FF30-$FF3F(波形 RAM)。
 *
 * ★2026-11-13 作り直し(DESIGN-GB-CAPTURE.md §2.2)。旧実装との違い:
 *   - ノイズの周期が 16 倍遅かった(16×分周値×2^shift としていた。正しくは 分周値×2^shift。VGMPlay 0.52 と突き合わせて確認)
 *   - 各 ch のタイマが「周期+1」T で 1 歩進んでいた(高い音ほど低くずれる)
 *   - フレームシーケンサ(長さ/スイープ/エンベロープ)は本体の DIV で進む(seqTick を本体が呼ぶ)。
 *     単体で使う時(VGM、GBS の写し再生)は内部の 8192T 分周で進む
 *   - 長さカウンタの余分な 1 減算、ゾンビモード、スイープの減算→加算での停止、ノイズ shift 14/15 の停止、
 *     NR52 OFF でのレジスタ消去と書き込み無視、読み出しのマスク、パルスのデューティ位置をトリガで戻さない、
 *     波形 ch のサンプルバッファと再生中の RAM アクセス(DMG/CGB)
 *   - 出力は ch ごとの DAC(デジタル 0〜15 → アナログ、DAC OFF は 0)+ハイパスフィルタ。
 *     NR50 や DAC の ON/OFF、波形 ch の直流分を使った PCM 再生が鳴る
 *
 * 時間は advance(t) で T(4194304Hz)単位に進める。clock() は advance(1)(旧呼び出し側との互換)。
 *
 * 参考: Pan Docs "Audio" "Audio details"、gbdev wiki "Gameboy sound hardware"。細部は blargg の dmg_sound で確かめる
 *       (tools/headless/gb-testroms.js)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
    [1, 0, 0, 0, 0, 0, 0, 1], // 25%
    [1, 0, 0, 0, 0, 1, 1, 1], // 50%
    [0, 1, 1, 1, 1, 1, 1, 0]  // 75%
  ];

  // ノイズの分周値(T)。LFSR の 1 歩 = NOISE_DIVISOR[r] << shift T(= 262144 / (r × 2^shift) Hz、r=0 は 0.5)
  const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];

  // 読み出しで 1 が返るビット($FF10 からの並び。$FF27-$FF2F は全部 1)
  const READ_OR_MASK = [
    0x80, 0x3F, 0x00, 0xFF, 0xBF,
    0xFF, 0x3F, 0x00, 0xFF, 0xBF,
    0x7F, 0xFF, 0x9F, 0xFF, 0xBF,
    0xFF, 0xFF, 0x00, 0x00, 0xBF,
    0x00, 0x00, 0x70
  ];

  // 音量エンベロープ(NRx2)。CH1/CH2/CH4 共用
  class Envelope {
    constructor() {
      this.initialVolume = 0;
      this.direction = 0; // 0=減衰, 1=増加
      this.period = 0;
      this.volume = 0;
      this.timer = 0;
      this.running = false; // 自動更新が続いているか(端に着くと止まる。ゾンビモードの式が見る)
    }
    // active: その ch が鳴っている最中か(鳴っている最中の書き込みは音量を変える=ゾンビモード)
    write(value, active) {
      const oldPeriod = this.period, oldDir = this.direction;
      this.initialVolume = (value >> 4) & 0x0F;
      this.direction = (value & 0x08) ? 1 : 0;
      this.period = value & 0x07;
      if (active) {
        let v = this.volume;
        if (oldPeriod === 0 && this.running) v += 1;
        else if (oldDir === 0) v += 2;
        if (oldDir !== this.direction) v = 16 - v;
        this.volume = v & 0x0F;
      }
    }
    dacOn() { return this.initialVolume !== 0 || this.direction !== 0; } // NRx2 の上位 5bit が非 0
    trigger(nextIsEnvStep) {
      this.volume = this.initialVolume;
      this.timer = this.period === 0 ? 8 : this.period;
      if (nextIsEnvStep) this.timer++; // 次のシーケンサ段がエンベロープなら 1 回ぶん遅れる
      this.running = true;
    }
    clock() {
      if (--this.timer > 0) return;
      this.timer = this.period === 0 ? 8 : this.period;
      if (this.period === 0 || !this.running) return;
      if (this.direction === 1 && this.volume < 15) this.volume++;
      else if (this.direction === 0 && this.volume > 0) this.volume--;
      else this.running = false;
    }
  }

  class PulseChannel {
    constructor(hasSweep) {
      this.hasSweep = !!hasSweep;
      this.enabled = false;
      this.dac = false;
      this.duty = 0;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0; // 11bit
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ(CH1 のみ)
      this.sweepPeriod = 0;
      this.sweepDirection = 0; // 0=加算, 1=減算
      this.sweepShift = 0;
      this.sweepTimer = 0;
      this.sweepEnabled = false;
      this.sweepNegUsed = false; // トリガ以降に減算で計算したか(その後に加算へ変えると ch が止まる)
      this.shadowFreq = 0;
      // トリガのたびに増える通し番号(gbs2mml の抽出が「このフレームでアタックがあったか」を見る)
      this.triggerSeq = 0;
    }

    writeNRx0(value) {
      const wasNeg = this.sweepDirection === 1;
      this.sweepPeriod = (value >> 4) & 0x07;
      this.sweepDirection = (value & 0x08) ? 1 : 0;
      this.sweepShift = value & 0x07;
      if (wasNeg && this.sweepDirection === 0 && this.sweepNegUsed) this.enabled = false;
    }
    writeDuty(value) { this.duty = (value >> 6) & 0x03; }
    writeLength(value) { this.lengthCounter = 64 - (value & 0x3F); }
    writeNRx2(value) {
      this.envelope.write(value, this.enabled);
      this.dac = this.envelope.dacOn();
      if (!this.dac) this.enabled = false;
    }
    writeNRx3(value) { this.freq = (this.freq & 0x700) | value; }
    // oddStep: 次のシーケンサ段が長さを数えない段か(長さの余分な 1 減算の条件)
    writeNRx4(value, oddStep, envNext) {
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      const was = this.lengthEnabled;
      this.lengthEnabled = (value & 0x40) !== 0;
      if (!was && this.lengthEnabled && oddStep && this.lengthCounter > 0) {
        if (--this.lengthCounter === 0 && !(value & 0x80)) this.enabled = false;
      }
      if (value & 0x80) this.trigger(oddStep, envNext);
    }

    trigger(oddStep, envNext) {
      this.triggerSeq++;
      if (this.dac) this.enabled = true;
      if (this.lengthCounter === 0) { this.lengthCounter = 64; if (this.lengthEnabled && oddStep) this.lengthCounter--; }
      this.timer = (2048 - this.freq) * 4; // デューティ位置は戻さない(電源 OFF でだけ戻る)
      this.envelope.trigger(envNext);
      if (this.hasSweep) {
        this.shadowFreq = this.freq;
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
        this.sweepNegUsed = false;
        if (this.sweepShift !== 0) this.sweepCalc(); // トリガ時にもあふれを確かめる
      }
    }

    // シャドウ周波数からスイープ後の値を計算する。あふれたら ch を止める
    sweepCalc() {
      const delta = this.shadowFreq >> this.sweepShift;
      let newFreq;
      if (this.sweepDirection === 1) { newFreq = this.shadowFreq - delta; this.sweepNegUsed = true; }
      else newFreq = this.shadowFreq + delta;
      if (newFreq > 0x7FF) this.enabled = false;
      return newFreq;
    }

    clockSweep() {
      if (!this.hasSweep) return;
      if (--this.sweepTimer > 0) return;
      this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
      if (!this.sweepEnabled || this.sweepPeriod === 0) return;
      const newFreq = this.sweepCalc();
      if (newFreq <= 0x7FF && this.sweepShift !== 0) {
        this.shadowFreq = newFreq;
        this.freq = newFreq;
        this.sweepCalc(); // 反映した値でもう一度あふれを確かめる
      }
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
    }

    advance(t) {
      this.timer -= t;
      while (this.timer <= 0) {
        this.timer += (2048 - this.freq) * 4;
        this.dutyStep = (this.dutyStep + 1) & 7;
      }
    }
    clockTimer() { this.advance(1); }

    // DAC へ入るデジタル値(0〜15)。ch が止まっていれば 0
    output() {
      if (!this.enabled) return 0;
      return DUTY_TABLE[this.duty][this.dutyStep] ? this.envelope.volume : 0;
    }
  }

  class WaveChannel {
    constructor() {
      this.enabled = false;
      this.dacOn = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0;
      this.timer = 0;
      this.volumeShift = 0; // 0=ミュート, 1=100%, 2=50%, 3=25%
      // 展開済みの 4bit サンプル(0-15)。電源投入時の波形 RAM は $00,$FF の繰り返し(DMG。書かずに鳴らす曲がある)
      this.wave = new Uint8Array(32);
      for (let i = 0; i < 32; i++) this.wave[i] = (i & 2) ? 15 : 0;
      this.samplePos = 0;
      this.sampleBuffer = 0; // 最後に取り込んだサンプル。トリガしても次の取り込みまで前の値が出る
      this.sinceFetch = 0x7FFFFFFF; // 最後の取り込みからの T(DMG は取り込みと同時でないと RAM に触れない)
      this.triggerSeq = 0;
    }

    writeNR30(value) {
      this.dacOn = (value & 0x80) !== 0;
      if (!this.dacOn) this.enabled = false;
    }
    writeLength(value) { this.lengthCounter = 256 - value; }
    writeNR32(value) { this.volumeShift = (value >> 5) & 0x03; }
    writeNR33(value) { this.freq = (this.freq & 0x700) | value; }
    writeNR34(value, oddStep, dmg) {
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      const was = this.lengthEnabled;
      this.lengthEnabled = (value & 0x40) !== 0;
      if (!was && this.lengthEnabled && oddStep && this.lengthCounter > 0) {
        if (--this.lengthCounter === 0 && !(value & 0x80)) this.enabled = false;
      }
      if (value & 0x80) this.trigger(oddStep, dmg);
    }
    // $FF30-$FF3F: 1 バイト = 2 サンプル(上位ニブルが先)
    writeWaveRam(offset, value) {
      this.wave[offset * 2] = (value >> 4) & 0x0F;
      this.wave[offset * 2 + 1] = value & 0x0F;
    }
    readWaveRam(offset) {
      return (this.wave[offset * 2] << 4) | this.wave[offset * 2 + 1];
    }

    trigger(oddStep, dmg) {
      this.triggerSeq++;
      // DMG: 鳴っている最中に、次の取り込みの直前でトリガすると波形 RAM の先頭が壊れる
      if (dmg && this.enabled && this.timer === WaveChannel.CORRUPT_T) {
        const off = (((this.samplePos + 1) & 31) >> 1);
        if (off < 4) this.writeWaveRam(0, this.readWaveRam(off));
        else { const b = off & ~3; for (let i = 0; i < 4; i++) this.writeWaveRam(i, this.readWaveRam(b + i)); }
      }
      if (this.dacOn) this.enabled = true;
      if (this.lengthCounter === 0) { this.lengthCounter = 256; if (this.lengthEnabled && oddStep) this.lengthCounter--; }
      this.timer = (2048 - this.freq) * 2 + WaveChannel.TRIGGER_DELAY_T;
      this.samplePos = 0; // バッファは取り込み直さない(最初に出るのは前の値)
      this.sinceFetch = 0x7FFFFFFF;
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
    }

    advance(t) {
      if (this.sinceFetch < 0x40000000) this.sinceFetch += t;
      if (!this.enabled) return; // 止まっている間は位置も進まない
      this.timer -= t;
      while (this.timer <= 0) {
        const period = (2048 - this.freq) * 2;
        this.timer += period;
        this.samplePos = (this.samplePos + 1) & 31;
        this.sampleBuffer = this.wave[this.samplePos];
        this.sinceFetch = period - this.timer;
      }
    }
    clockTimer() { this.advance(1); }

    output() {
      if (!this.enabled || this.volumeShift === 0) return 0;
      return this.sampleBuffer >> (this.volumeShift - 1);
    }
  }
  WaveChannel.TRIGGER_DELAY_T = 6; // トリガから最初の取り込みまでの余分な遅れ
  WaveChannel.CORRUPT_T = 2;       // 「次の取り込みの直前」= 残り 2T
  WaveChannel.ACCESS_T = 2;        // DMG: 取り込みからこの T 未満なら RAM に触れる

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.dac = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.envelope = new Envelope();
      this.clockShift = 0;
      this.widthMode = 0; // 0=15bit, 1=7bit
      this.divisorCode = 0;
      this.timer = 0;
      this.lfsr = 0x7FFF;
      this.triggerSeq = 0;
    }

    writeLength(value) { this.lengthCounter = 64 - (value & 0x3F); }
    writeNR42(value) {
      this.envelope.write(value, this.enabled);
      this.dac = this.envelope.dacOn();
      if (!this.dac) this.enabled = false;
    }
    writeNR43(value) {
      this.clockShift = (value >> 4) & 0x0F;
      this.widthMode = (value & 0x08) ? 1 : 0;
      this.divisorCode = value & 0x07;
    }
    writeNR44(value, oddStep, envNext) {
      const was = this.lengthEnabled;
      this.lengthEnabled = (value & 0x40) !== 0;
      if (!was && this.lengthEnabled && oddStep && this.lengthCounter > 0) {
        if (--this.lengthCounter === 0 && !(value & 0x80)) this.enabled = false;
      }
      if (value & 0x80) this.trigger(oddStep, envNext);
    }

    periodT() { return NOISE_DIVISOR[this.divisorCode] << this.clockShift; }

    trigger(oddStep, envNext) {
      this.triggerSeq++;
      if (this.dac) this.enabled = true;
      if (this.lengthCounter === 0) { this.lengthCounter = 64; if (this.lengthEnabled && oddStep) this.lengthCounter--; }
      this.timer = this.periodT();
      this.lfsr = 0x7FFF;
      this.envelope.trigger(envNext);
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0 && --this.lengthCounter === 0) this.enabled = false;
    }

    advance(t) {
      this.timer -= t;
      if (this.timer > 0) return;
      const period = this.periodT();
      if (this.clockShift >= 14) { this.timer = period; return; } // shift 14/15 は LFSR が進まない
      while (this.timer <= 0) {
        this.timer += period;
        const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
        this.lfsr = (this.lfsr >> 1) | (bit << 14);
        if (this.widthMode) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
      }
    }
    clockTimer() { this.advance(1); }

    output() {
      if (!this.enabled) return 0;
      return (this.lfsr & 1) === 0 ? this.envelope.volume : 0; // LFSR の bit0 が 0 で出力あり
    }
  }

  const STATE_SKIP = new Set(['mute', 'vol', 'divBit', '_out', 'apu']);
  class APUGb {
    // model: 'dmg'(既定)/ 'cgb'。波形 RAM の再生中アクセス、OFF 中の長さ書き込み、フィルタの定数が変わる
    constructor(model) {
      this.model = model || 'dmg';
      this.regRaw = new Uint8Array(0x17); // $FF10-$FF26 に最後に書いた値
      this.mute = { ch1: false, ch2: false, ch3: false, ch4: false };
      this.vol = { ch1: 1, ch2: 1, ch3: 1, ch4: 1 };
      this.externalSeq = false; // true: フレームシーケンサは本体が DIV の立ち下がりで seqTick() を呼ぶ
      this.divBit = null;       // () => DIV の該当ビットが今 1 か(電源 ON 直後の 1 回を飛ばす判定)
      this._out = { left: 0, right: 0 };
      this.setSampleRate(44100);
      this.reset();
    }
    // VGM 再生のシーク用の控え(vgmPlayer.js のチェックポイント)。ミュート/音量と関数は写さない
    getState() {
      const cp = (v) => { if (v === null || typeof v !== 'object') return v; if (ArrayBuffer.isView(v)) return v.slice(); if (Array.isArray(v)) return v.map(cp); const o = {}; for (const k of Object.keys(v)) { if (typeof v[k] === 'function' || STATE_SKIP.has(k)) continue; o[k] = cp(v[k]); } return o; };
      return cp(this);
    }
    setState(st) {
      const put = (o, v) => { for (const k of Object.keys(v)) { const x = v[k], cur = o[k]; if (x === null || typeof x !== 'object') o[k] = x; else if (ArrayBuffer.isView(x)) { if (cur && ArrayBuffer.isView(cur) && cur.length === x.length) cur.set(x); else o[k] = x.slice(); } else if (Array.isArray(x)) o[k] = x.map((e) => (ArrayBuffer.isView(e) ? e.slice() : e)); else if (cur && typeof cur === 'object') put(cur, x); else o[k] = x; } };
      put(this, st);
    }

    reset() {
      this.ch1 = new PulseChannel(true);
      this.ch2 = new PulseChannel(false);
      this.ch3 = new WaveChannel();
      this.ch4 = new NoiseChannel();
      this.ch1.duty = 2; // ブート ROM 実行後の NR11=$BF(50%)。NR21 は $3F(12.5%)。デューティを書かない曲はこの値で鳴る
      // 単体利用(GBS の旧経路、VGM)は起動直後から鳴らせる状態で始める: 電源 ON、NR50/NR51 はブート ROM 実行後の値。
      // 本体コア(gbConsole.js)は reset の後で起動後のレジスタを書き直す
      this.powerOn = true;
      this.nr50 = 0x77;
      this.nr51 = 0xF3;
      this.regRaw.fill(0);
      this.regRaw[0x14] = 0x77; this.regRaw[0x15] = 0xF3; this.regRaw[0x16] = 0x80;
      this.seqStep = 0;     // 次に実行するシーケンサ段(0-7)。偶数=長さ、2/6=スイープ、7=エンベロープ
      this.seqCounter = 0;  // 内部分周(externalSeq=false の時)
      this.skipSeq = false;
      this.capL = 0; this.capR = 0;
    }

    // ハイパスフィルタ(出力段のコンデンサ)の 1 サンプルぶんの係数。mixSample を呼ぶ頻度を伝える
    setSampleRate(sr) {
      this.sampleRate = sr;
      this.hpf = Math.pow(this.model === 'cgb' ? 0.998943 : 0.999958, 4194304 / sr);
    }

    // フレームシーケンサを 1 段進める(512Hz)
    seqTick() {
      if (!this.powerOn) return;
      if (this.skipSeq) { this.skipSeq = false; return; }
      const s = this.seqStep;
      this.seqStep = (s + 1) & 7;
      if (!(s & 1)) { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
      if (s === 2 || s === 6) this.ch1.clockSweep();
      if (s === 7) { this.ch1.envelope.clock(); this.ch2.envelope.clock(); this.ch4.envelope.clock(); }
    }
    // 旧名(外から呼ぶ所は無いが残す)
    clockLength() { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
    clockSweep() { this.ch1.clockSweep(); }
    clockEnvelope() { this.ch1.envelope.clock(); this.ch2.envelope.clock(); this.ch4.envelope.clock(); }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0xFF30 && addr <= 0xFF3F) {
        const w = this.ch3;
        if (w.enabled) { // 再生中: 今読んでいるバイトに当たる。DMG は取り込みと同時の時だけ
          if (this.model === 'dmg' && w.sinceFetch >= WaveChannel.ACCESS_T) return;
          w.writeWaveRam(w.samplePos >> 1, value);
        } else w.writeWaveRam(addr - 0xFF30, value);
        return;
      }
      if (addr < 0xFF10 || addr > 0xFF26) return;
      const dmg = this.model === 'dmg';
      if (!this.powerOn && addr !== 0xFF26) {
        // 電源 OFF 中は書けない。DMG だけ長さカウンタ(NRx1 の長さ部分)は書ける
        if (!dmg) return;
        if (addr === 0xFF11) this.ch1.writeLength(value);
        else if (addr === 0xFF16) this.ch2.writeLength(value);
        else if (addr === 0xFF1B) this.ch3.writeLength(value);
        else if (addr === 0xFF20) this.ch4.writeLength(value);
        return;
      }
      this.regRaw[addr - 0xFF10] = value;
      const odd = (this.seqStep & 1) === 1, envNext = this.seqStep === 7;
      switch (addr) {
        case 0xFF10: this.ch1.writeNRx0(value); break;
        case 0xFF11: this.ch1.writeDuty(value); this.ch1.writeLength(value); break;
        case 0xFF12: this.ch1.writeNRx2(value); break;
        case 0xFF13: this.ch1.writeNRx3(value); break;
        case 0xFF14: this.ch1.writeNRx4(value, odd, envNext); break;
        case 0xFF16: this.ch2.writeDuty(value); this.ch2.writeLength(value); break;
        case 0xFF17: this.ch2.writeNRx2(value); break;
        case 0xFF18: this.ch2.writeNRx3(value); break;
        case 0xFF19: this.ch2.writeNRx4(value, odd, envNext); break;
        case 0xFF1A: this.ch3.writeNR30(value); break;
        case 0xFF1B: this.ch3.writeLength(value); break;
        case 0xFF1C: this.ch3.writeNR32(value); break;
        case 0xFF1D: this.ch3.writeNR33(value); break;
        case 0xFF1E: this.ch3.writeNR34(value, odd, dmg); break;
        case 0xFF20: this.ch4.writeLength(value); break;
        case 0xFF21: this.ch4.writeNR42(value); break;
        case 0xFF22: this.ch4.writeNR43(value); break;
        case 0xFF23: this.ch4.writeNR44(value, odd, envNext); break;
        case 0xFF24: this.nr50 = value; break;
        case 0xFF25: this.nr51 = value; break;
        case 0xFF26: {
          const on = (value & 0x80) !== 0;
          if (this.powerOn && !on) this._powerOff();
          else if (!this.powerOn && on) {
            this.powerOn = true;
            this.seqStep = 0; this.seqCounter = 0;
            // 本体の DIV で進む時: 該当ビットが 1 の最中に電源を入れると、最初の立ち下がりは数えない
            this.skipSeq = !!(this.externalSeq && this.divBit && this.divBit());
            this.ch1.dutyStep = 0; this.ch2.dutyStep = 0;
            this.ch3.sampleBuffer = 0;
          }
          this.regRaw[0x16] = value & 0x80;
          break;
        }
      }
    }

    // NR52 OFF: $FF10-$FF25 を全部 0 にする(波形 RAM は残る。DMG は長さカウンタも残る)
    _powerOff() {
      const keep = this.model === 'dmg' ? [this.ch1.lengthCounter, this.ch2.lengthCounter, this.ch3.lengthCounter, this.ch4.lengthCounter] : null;
      for (let a = 0xFF10; a < 0xFF26; a++) { if (a !== 0xFF15 && a !== 0xFF1F) this.writeRegister(a, 0); }
      this.regRaw.fill(0);
      this.powerOn = false;
      for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) { ch.enabled = false; ch.lengthEnabled = false; ch.lengthCounter = 0; }
      this.ch1.envelope.volume = 0; this.ch2.envelope.volume = 0; this.ch4.envelope.volume = 0;
      if (keep) { this.ch1.lengthCounter = keep[0]; this.ch2.lengthCounter = keep[1]; this.ch3.lengthCounter = keep[2]; this.ch4.lengthCounter = keep[3]; }
    }

    readRegister(addr) {
      if (addr >= 0xFF30 && addr <= 0xFF3F) {
        const w = this.ch3;
        if (!w.enabled) return w.readWaveRam(addr - 0xFF30);
        if (this.model === 'dmg' && w.sinceFetch >= WaveChannel.ACCESS_T) return 0xFF;
        return w.readWaveRam(w.samplePos >> 1);
      }
      if (addr < 0xFF10 || addr > 0xFF2F) return 0xFF;
      if (addr > 0xFF26) return 0xFF;
      if (addr === 0xFF26) {
        return (this.powerOn ? 0x80 : 0) | 0x70 | (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) | (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
      }
      const off = addr - 0xFF10;
      return this.regRaw[off] | READ_OR_MASK[off];
    }

    // CGB の PCM12 / PCM34($FF76/$FF77): 各 ch の今のデジタル出力
    readPcm12() { return this.ch1.output() | (this.ch2.output() << 4); }
    readPcm34() { return this.ch3.output() | (this.ch4.output() << 4); }

    // t T 進める
    advance(t) {
      if (this.powerOn) {
        this.ch1.advance(t); this.ch2.advance(t); this.ch3.advance(t); this.ch4.advance(t);
        if (!this.externalSeq) {
          this.seqCounter += t;
          while (this.seqCounter >= 8192) { this.seqCounter -= 8192; this.seqTick(); }
        }
      }
    }
    clock() { this.advance(1); }

    /**
     * 今の出力を {left, right} で返す(同じオブジェクトを使い回す。呼ぶたびにフィルタが 1 サンプル進む)。
     * ch ごとに DAC がデジタル 0〜15 をアナログ −1〜+1 に直す(DAC OFF は 0)。NR51 で左右へ配り、NR50 の音量(1〜8)を掛け、
     * 出力段のコンデンサ(ハイパスフィルタ)を通す。大きさは旧実装に合わせてある(1ch の振れ幅が 0.25)。
     */
    mixSample() {
      const m = this.mute, vol = this.vol, nr51 = this.nr51;
      let left = 0, right = 0, a;
      if (this.ch1.dac && !m.ch1) { a = (this.ch1.output() / 7.5 - 1) * vol.ch1; if (nr51 & 0x10) left += a; if (nr51 & 0x01) right += a; }
      if (this.ch2.dac && !m.ch2) { a = (this.ch2.output() / 7.5 - 1) * vol.ch2; if (nr51 & 0x20) left += a; if (nr51 & 0x02) right += a; }
      if (this.ch3.dacOn && !m.ch3) { a = (this.ch3.output() / 7.5 - 1) * vol.ch3; if (nr51 & 0x40) left += a; if (nr51 & 0x04) right += a; }
      if (this.ch4.dac && !m.ch4) { a = (this.ch4.output() / 7.5 - 1) * vol.ch4; if (nr51 & 0x80) left += a; if (nr51 & 0x08) right += a; }
      left *= (((this.nr50 >> 4) & 7) + 1) * 0.015625;  // ÷8(音量)÷8(1ch の振れ幅 2 → 0.25)
      right *= ((this.nr50 & 7) + 1) * 0.015625;
      const o = this._out;
      o.left = left - this.capL; this.capL = left - o.left * this.hpf;
      o.right = right - this.capR; this.capR = right - o.right * this.hpf;
      return o;
    }
  }

  // NR51 の該当ビットが左右とも 0 なら、音量があっても聞こえない(ch=0-3)
  function nr51Audible(nr51, ch) {
    return (((nr51 >> (4 + ch)) & 1) !== 0) || (((nr51 >> ch) & 1) !== 0);
  }

  // 鍵盤表示用のライブ値(snapshotAY8910/snapshotSCC と同じ考え方)
  Emu.snapshotGbApu = function (apu) {
    const p = (ch, chIndex) => {
      const freq = ch.enabled ? 131072 / (2048 - ch.freq) : 0;
      return {
        freq, vol: ch.envelope.volume / 15, rawVol: ch.envelope.volume,
        duty: ch.duty, envPeriod: ch.envelope.period,
        active: ch.enabled && ch.envelope.volume > 0 && freq > 0 && nr51Audible(apu.nr51, chIndex)
      };
    };
    const w = apu.ch3;
    const wVol = { 0: 0, 1: 1, 2: 0.5, 3: 0.25 }[w.volumeShift] || 0;
    const wFreq = (w.enabled && w.dacOn) ? 65536 / (2048 - w.freq) : 0;
    const n = apu.ch4;
    const nFreq = n.enabled ? 4194304 / (NOISE_DIVISOR[n.divisorCode] * Math.pow(2, n.clockShift)) : 0;
    return {
      ch1: p(apu.ch1, 0),
      ch2: p(apu.ch2, 1),
      ch3: {
        freq: wFreq, vol: wVol, rawVol: w.volumeShift,
        waveData: Array.from(w.wave, v => v / 7.5 - 1), // 0-15 → -1..1
        active: w.enabled && w.dacOn && wVol > 0 && wFreq > 0 && nr51Audible(apu.nr51, 2)
      },
      ch4: {
        freq: nFreq, vol: n.envelope.volume / 15, rawVol: n.envelope.volume,
        widthMode: n.widthMode, envPeriod: n.envelope.period,
        active: n.enabled && n.envelope.volume > 0 && nr51Audible(apu.nr51, 3)
      },
      nr50: apu.nr50, nr51: apu.nr51
    };
  };

  APUGb.NOISE_DIVISOR = NOISE_DIVISOR;
  APUGb.WaveChannel = WaveChannel;
  Emu.APUGb = APUGb;
})(globalThis);

/*
 * ゲームボーイのカートリッジ(ヘッダ解析と MBC)
 * MML.Emu.GbCart
 *
 * ROM のみ / MBC1(多本入り含む) / MBC2 / MBC3(時計) / MBC5(振動) / MBC7(傾き+EEPROM) / HuC1(赤外線)。
 * MBC6 / MMM01 / HuC3 / ポケットカメラは gb/cartMore.js(下の EXTRA の差し込み口に登録する。このファイルの後に読む)。
 *
 * 時計(MBC3): 動いている間はエミュレータ内の時間で進む(巻き戻し/ステートと食い違わない)。セーブには実時刻も控え、
 *   次に読み込んだ時に「電源を切っていた間」の分を進める。
 * MBC7: $A000 台はレジスタ(加速度の取り込みと値、EEPROM 93LC56 の 4 本の線)。傾きは tiltX/tiltY(−1〜+1、右/下が正、1 = 重力 1 個ぶん)。
 * HuC1: $0000 台に $0E で $A000 台が赤外線レジスタになる(読むと $C0 = 光なし / $C1 = 光あり。irIn を本体が入れる)。
 *
 * 本体(gbConsole.js)からは read(addr)/write(addr,v)($0000-$7FFF)と readRam(addr)/writeRam(addr,v)($A000-$BFFF)で触る。
 * 参考: Pan Docs "The Cartridge Header" "MBCs"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const RAM_SIZES = { 0: 0, 1: 0x800, 2: 0x2000, 3: 0x8000, 4: 0x20000, 5: 0x10000 };
  // ヘッダ $0147 → { mbc, ram, battery, rtc, rumble }
  const TYPES = {
    0x00: { mbc: 'rom' }, 0x08: { mbc: 'rom', ram: 1 }, 0x09: { mbc: 'rom', ram: 1, battery: 1 },
    0x01: { mbc: 'mbc1' }, 0x02: { mbc: 'mbc1', ram: 1 }, 0x03: { mbc: 'mbc1', ram: 1, battery: 1 },
    0x05: { mbc: 'mbc2' }, 0x06: { mbc: 'mbc2', battery: 1 },
    0x0F: { mbc: 'mbc3', battery: 1, rtc: 1 }, 0x10: { mbc: 'mbc3', ram: 1, battery: 1, rtc: 1 },
    0x11: { mbc: 'mbc3' }, 0x12: { mbc: 'mbc3', ram: 1 }, 0x13: { mbc: 'mbc3', ram: 1, battery: 1 },
    0x19: { mbc: 'mbc5' }, 0x1A: { mbc: 'mbc5', ram: 1 }, 0x1B: { mbc: 'mbc5', ram: 1, battery: 1 },
    0x1C: { mbc: 'mbc5', rumble: 1 }, 0x1D: { mbc: 'mbc5', ram: 1, rumble: 1 }, 0x1E: { mbc: 'mbc5', ram: 1, battery: 1, rumble: 1 },
    0x22: { mbc: 'mbc7', battery: 1, tilt: 1 },
    0xFF: { mbc: 'huc1', ram: 1, battery: 1, ir: 1 },
  };

  // 追加の基板(gb/cartMore.js が登録する)。EXTRA[mbc] = { detect?, init?, reset?, map?, read?, write?, readRam?, writeRam?, tick?, getBattery?, setBattery? }
  const EXTRA = {};

  // ヘッダのチェックサム($0134-$014C)。実機のブート ROM が確かめるのと同じ式
  function headerChecksum(rom) {
    let x = 0;
    for (let a = 0x134; a <= 0x14C; a++) x = (x - rom[a] - 1) & 0xFF;
    return x;
  }
  function isGb(bytes) {
    return !!bytes && bytes.length >= 0x150 && headerChecksum(bytes) === bytes[0x14D] &&
      bytes[0x104] === 0xCE && bytes[0x105] === 0xED; // 任天堂ロゴの先頭 2 バイト(ロゴ全体は持たない)
  }

  function parseHeader(rom) {
    const cgbFlag = rom[0x143];
    let title = '';
    for (let a = 0x134; a < (cgbFlag & 0x80 ? 0x13F : 0x144); a++) { const c = rom[a]; if (!c) break; title += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '?'; }
    const type = rom[0x147];
    const info = TYPES[type] || null;
    return {
      title: title.trim(), type, info,
      cgb: (cgbFlag & 0x80) !== 0, cgbOnly: (cgbFlag & 0xC0) === 0xC0,
      sgb: rom[0x146] === 0x03 && rom[0x14B] === 0x33,
      romBanks: Math.max(2, rom.length >> 14),
      ramSize: info && info.mbc === 'mbc2' ? 0x200 : info && info.mbc === 'mbc7' ? 0x100 : (RAM_SIZES[rom[0x149]] || 0), // MBC7 は EEPROM 256 バイト
      checksumOk: headerChecksum(rom) === rom[0x14D],
    };
  }

  class GbCart {
    constructor(bytes) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      // バンク境界(16K)へ切り上げて持つ(端数のある吸い出しでも範囲外を読まない)
      const size = Math.max(0x8000, Math.ceil(bytes.length / 0x4000) * 0x4000);
      this.rom = new Uint8Array(size).fill(0xFF); this.rom.set(bytes);
      // 中身で決まる基板(MMM01 はメニューが ROM の最後の 32K にあり、ヘッダもそこ)
      for (const k of Object.keys(EXTRA)) if (EXTRA[k].detect) { const r = EXTRA[k].detect(this.rom); if (r) { this.rom = r.rom; this.headerAt = r.headerAt; break; } }
      this.header = parseHeader(this.headerAt ? this.rom.subarray(this.headerAt) : this.rom);
      if (this.headerAt) this.header.romBanks = this.rom.length >> 14;
      const info = this.header.info;
      this.unsupported = !info;                 // 未対応の種別は ROM のみとして動かす(起動画面くらいは出る)
      this.mbc = info ? info.mbc : 'rom';
      this.hasBattery = !!(info && info.battery);
      this.hasRtc = !!(info && info.rtc);
      this.hasRumble = !!(info && info.rumble);
      this.hasTilt = !!(info && info.tilt);
      this.hasIr = !!(info && info.ir);
      this.tiltX = 0; this.tiltY = 0; // 傾き(本体が入れる)
      this.irIn = false; this.irOut = false; // 赤外線: 受光している/発光している
      this.romMask = (this.rom.length >> 14) - 1; // バンク数は 2 のべき(違う吸い出しは下の % で畳む)
      this.romBanks = this.rom.length >> 14;
      // MBC1 の多本入り(1MB で、$40000 のバンクにもロゴがある): BANK2 が 4bit 上にずれ、BANK1 は下位 4bit だけ効く
      this.multicart = this.mbc === 'mbc1' && this.rom.length === 0x100000 && [0x104, 0x105, 0x106, 0x107].every(a => this.rom[0x40000 + a] === this.rom[a]) && this.rom[0x104] === 0xCE;
      this.x = EXTRA[this.mbc] || null;
      this.ram = new Uint8Array((this.x && this.x.ramSize) || this.header.ramSize || (info && info.ram ? 0x2000 : 0));
      this.hasBuzzer = !!(info && info.buzzer); this.hasCamera = !!(info && info.camera);
      this.buzzQueue = [];    // 鳴らしたブザーの音番号(本体が takeBuzz で取る)
      if (this.x && this.x.init) this.x.init(this);
      if (this.mbc === 'mbc7') this.ram.fill(0xFF); // 新品の EEPROM は全ビット 1
      this.dirty = false;     // セーブ RAM/時計に書いた(本体が batteryDirty として見る)
      this.rumble = false;    // 振動モータ(MBC5 の RAM バンクレジスタ bit3)
      this.reset();
    }

    reset() {
      this.ramEnable = false;
      this.bank1 = 1; this.bank2 = 0; this.mode = 0; // MBC1
      this.romBank = 1; this.ramBank = 0;            // MBC2/3/5
      this.rtcSel = -1; this.rtcLatchPrev = 1;
      this.irMode = false;                           // HuC1
      this.ramEnable2 = false; this.accX = 0x8000; this.accY = 0x8000; this.accErased = false; // MBC7
      this.ee = { cs: 0, clk: 0, di: 0, dout: 1, bits: 0, n: 0, state: 0, addr: 0, data: 0, left: 0, wen: false };
      if (!this.rtc) this.rtc = { s: 0, m: 0, h: 0, dl: 0, dh: 0, latched: new Uint8Array(5), sub: 0 };
      if (this.x && this.x.reset) this.x.reset(this);
      this._map();
    }

    _map() {
      if (this.x && this.x.map) { this.x.map(this); return; }
      const n = this.romBanks;
      if (this.mbc === 'mbc1') {
        const sh = this.multicart ? 4 : 5, b1 = this.multicart ? this.bank1 & 0x0F : this.bank1;
        this.lo = (this.mode ? (this.bank2 << sh) % n : 0) << 14;
        this.hi = (((this.bank2 << sh) | b1) % n) << 14;
        this.ramOff = this.ram.length > 0x2000 && this.mode ? (this.bank2 << 13) % this.ram.length : 0;
      } else {
        this.lo = 0;
        this.hi = (this.romBank % n) << 14;
        this.ramOff = this.ram.length > 0x2000 ? (this.ramBank << 13) % this.ram.length : 0;
      }
    }

    read(addr) {
      if (this.x && this.x.read) return this.x.read(this, addr);
      return addr < 0x4000 ? this.rom[this.lo + addr] : this.rom[this.hi + (addr & 0x3FFF)];
    }
    takeBuzz() { return this.buzzQueue.length ? this.buzzQueue.splice(0) : null; }

    write(addr, v) {
      if (this.x && this.x.write) { this.x.write(this, addr, v); this._map(); return; }
      switch (this.mbc) {
        case 'mbc1':
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x4000) { this.bank1 = v & 0x1F; if (!this.bank1) this.bank1 = 1; }
          else if (addr < 0x6000) this.bank2 = v & 3;
          else this.mode = v & 1;
          break;
        case 'mbc2': // $0000-$3FFF: 番地の bit8 が 0 なら RAM 許可、1 なら ROM バンク
          if (addr < 0x4000) { if (addr & 0x100) { this.romBank = v & 0x0F; if (!this.romBank) this.romBank = 1; } else this.ramEnable = (v & 0x0F) === 0x0A; }
          break;
        case 'mbc3':
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x4000) { this.romBank = v & 0x7F; if (!this.romBank) this.romBank = 1; }
          else if (addr < 0x6000) { if (v >= 0x08 && v <= 0x0C) this.rtcSel = v - 8; else { this.rtcSel = -1; this.ramBank = v & 3; } }
          else { // 0 → 1 で時計を控える
            if (this.rtcLatchPrev === 0 && (v & 1) === 1) { const r = this.rtc; r.latched[0] = r.s; r.latched[1] = r.m; r.latched[2] = r.h; r.latched[3] = r.dl; r.latched[4] = r.dh; }
            this.rtcLatchPrev = v & 1;
          }
          break;
        case 'huc1': // RAM は常に使える。$0E で赤外線レジスタへ切り替え
          if (addr < 0x2000) this.irMode = (v & 0x0F) === 0x0E;
          else if (addr < 0x4000) { this.romBank = v & 0x3F; if (!this.romBank) this.romBank = 1; }
          else if (addr < 0x6000) this.ramBank = v & 3;
          break;
        case 'mbc7': // RAM(レジスタ)の許可は 2 か所とも要る
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x4000) this.romBank = v & 0x7F;
          else if (addr < 0x6000) this.ramEnable2 = v === 0x40;
          break;
        case 'mbc5':
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x3000) this.romBank = (this.romBank & 0x100) | v;
          else if (addr < 0x4000) this.romBank = (this.romBank & 0xFF) | ((v & 1) << 8);
          else if (addr < 0x6000) { if (this.hasRumble) { this.rumble = (v & 8) !== 0; this.ramBank = v & 7; } else this.ramBank = v & 0x0F; }
          break;
      }
      this._map();
    }

    readRam(addr) {
      if (this.x && this.x.readRam) return this.x.readRam(this, addr);
      if (this.mbc === 'huc1') return this.irMode ? (this.irIn ? 0xC1 : 0xC0) : (this.ram.length ? this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length] : 0xFF);
      if (this.mbc === 'mbc7') return this._mbc7Read(addr);
      if (!this.ramEnable) return 0xFF;
      if (this.mbc === 'mbc3' && this.rtcSel >= 0) return this.hasRtc ? this.rtc.latched[this.rtcSel] : 0xFF;
      if (!this.ram.length) return 0xFF;
      if (this.mbc === 'mbc2') return this.ram[addr & 0x1FF] | 0xF0; // 4bit RAM。上位は 1
      return this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length];
    }

    writeRam(addr, v) {
      if (this.x && this.x.writeRam) { this.x.writeRam(this, addr, v); return; }
      if (this.mbc === 'huc1') {
        if (this.irMode) this.irOut = (v & 1) !== 0;
        else if (this.ram.length) { this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length] = v; this.dirty = true; }
        return;
      }
      if (this.mbc === 'mbc7') { this._mbc7Write(addr, v); return; }
      if (!this.ramEnable) return;
      if (this.mbc === 'mbc3' && this.rtcSel >= 0) {
        if (!this.hasRtc) return;
        const r = this.rtc;
        switch (this.rtcSel) {
          case 0: r.s = v & 0x3F; r.sub = 0; break;
          case 1: r.m = v & 0x3F; break;
          case 2: r.h = v & 0x1F; break;
          case 3: r.dl = v; break;
          case 4: r.dh = v & 0xC1; break;
        }
        this.dirty = true;
        return;
      }
      if (!this.ram.length) return;
      if (this.mbc === 'mbc2') this.ram[addr & 0x1FF] = v & 0x0F;
      else this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length] = v;
      this.dirty = true;
    }

    // ── MBC7 ──
    _mbc7Read(addr) {
      if (!this.ramEnable || !this.ramEnable2 || addr >= 0xB000) return 0xFF;
      switch ((addr >> 4) & 0x0F) {
        case 2: return this.accX & 0xFF;
        case 3: return this.accX >> 8;
        case 4: return this.accY & 0xFF;
        case 5: return this.accY >> 8;
        case 6: return 0x00;
        case 8: { const e = this.ee; return (e.dout ? 1 : 0) | (e.di ? 2 : 0) | (e.clk ? 0x40 : 0) | (e.cs ? 0x80 : 0); }
      }
      return 0xFF;
    }
    _mbc7Write(addr, v) {
      if (!this.ramEnable || !this.ramEnable2 || addr >= 0xB000) return;
      switch ((addr >> 4) & 0x0F) {
        case 0: if (v === 0x55) { this.accErased = true; this.accX = 0x8000; this.accY = 0x8000; } break;
        case 1: // $55 で消した後の $AA でだけ取り込む。中心 $81D0、重力 1 個で約 $70。X は右へ傾けると小さく、Y は下へ傾けると小さく
          if (v === 0xAA && this.accErased) {
            this.accErased = false;
            const cl = (t) => Math.max(-2, Math.min(2, +t || 0));
            this.accX = (0x81D0 - Math.round(cl(this.tiltX) * 0x70)) & 0xFFFF;
            this.accY = (0x81D0 - Math.round(cl(this.tiltY) * 0x70)) & 0xFFFF;
          }
          break;
        case 8: this._eeWrite(v); break;
      }
    }
    // EEPROM 93LC56(16bit × 128 語。語 n の上位バイトが ram[n*2]、下位が ram[n*2+1])。bit7=CS、bit6=CLK、bit1=DI、読み出しの bit0=DO。
    // CLK の立ち上がりで DI を 1 ビット取り込む。開始ビット 1 の後に 10 ビット(命令 2+番地 8)。命令: 10=READ、01=WRITE、11=ERASE、
    // 00 は番地の上位 2 ビットで 11=EWEN、00=EWDS、10=ERAL、01=WRAL。書き込み系は EWEN の後だけ効く
    _eeWrite(v) {
      const e = this.ee, cs = (v >> 7) & 1, clk = (v >> 6) & 1, di = (v >> 1) & 1;
      const rise = cs && clk && !e.clk;
      if (!cs) { e.state = 0; e.n = 0; e.bits = 0; e.dout = 1; }
      e.cs = cs; e.clk = clk; e.di = di;
      if (!rise) return;
      const ram = this.ram;
      switch (e.state) {
        case 0: if (di) { e.state = 1; e.bits = 0; e.n = 0; } break;          // 開始ビット待ち
        case 1:                                                               // 命令+番地の 10 ビット
          e.bits = (e.bits << 1) | di;
          if (++e.n < 10) break;
          { const op = (e.bits >> 8) & 3, a = e.bits & 0x7F, sub = (e.bits >> 6) & 3;
            e.addr = a; e.n = 0; e.data = 0;
            if (op === 2) { e.data = (ram[a * 2] << 8) | ram[a * 2 + 1]; e.left = 16; e.state = 2; e.dout = 0; }
            else if (op === 1) { e.state = 3; e.left = 16; e.wral = false; }
            else if (op === 3) { if (e.wen) { ram[a * 2] = 0xFF; ram[a * 2 + 1] = 0xFF; this.dirty = true; } e.state = 4; e.dout = 1; }
            else if (sub === 3) { e.wen = true; e.state = 4; }
            else if (sub === 0) { e.wen = false; e.state = 4; }
            else if (sub === 2) { if (e.wen) { ram.fill(0xFF); this.dirty = true; } e.state = 4; e.dout = 1; }
            else { e.state = 3; e.left = 16; e.wral = true; } }
          break;
        case 2:                                                               // READ: 上位ビットから 16 ビット出す
          e.dout = (e.data >> 15) & 1; e.data = (e.data << 1) & 0xFFFF;
          if (--e.left === 0) e.state = 4;
          break;
        case 3:                                                               // WRITE / WRAL: 16 ビット受ける
          e.data = ((e.data << 1) | di) & 0xFFFF;
          if (--e.left === 0) {
            if (e.wen) {
              if (e.wral) for (let i = 0; i < ram.length; i += 2) { ram[i] = e.data >> 8; ram[i + 1] = e.data & 0xFF; }
              else { ram[e.addr * 2] = e.data >> 8; ram[e.addr * 2 + 1] = e.data & 0xFF; }
              this.dirty = true;
            }
            e.state = 4; e.dout = 1; // 書き終わり(RDY)
          }
          break;
        default: break;                                                       // 命令の終わり: CS が下がるまで何もしない
      }
    }

    // 時計を t T ぶん進める(本体が 1 フレームごとに呼ぶ)。エミュレータ内の時間で進む
    tickRtc(t, clockHz) {
      if (this.x && this.x.tick) this.x.tick(this, t, clockHz);
      if (!this.hasRtc) return;
      const r = this.rtc;
      if (r.dh & 0x40) return; // 停止ビット
      r.sub += t;
      while (r.sub >= clockHz) {
        r.sub -= clockHz;
        this.dirty = true; // 時計が進んだ(セーブに実時刻を控え直す)
        r.s = (r.s + 1) & 0x3F;
        if (r.s !== 60) continue; // 60 以上を書かれた時は 63→0 で桁上がりしない(実機の癖)
        r.s = 0; r.m = (r.m + 1) & 0x3F; if (r.m !== 60) continue;
        r.m = 0; r.h = (r.h + 1) & 0x1F; if (r.h !== 24) continue;
        r.h = 0; r.dl = (r.dl + 1) & 0xFF; if (r.dl !== 0) continue;
        if (r.dh & 1) r.dh = (r.dh & 0xFE) | 0x80; else r.dh |= 1; // 512 日であふれフラグ
      }
    }

    // 時計を秒数ぶんまとめて進める(電源を切っていた間の分)
    advanceRtc(seconds) {
      const r = this.rtc;
      if (!this.hasRtc || (r.dh & 0x40) || !(seconds > 0)) return;
      let total = Math.floor(seconds) + (r.s % 60) + (r.m % 60) * 60 + (r.h % 24) * 3600 + (r.dl | ((r.dh & 1) << 8)) * 86400;
      r.s = total % 60; total = Math.floor(total / 60);
      r.m = total % 60; total = Math.floor(total / 60);
      r.h = total % 24; total = Math.floor(total / 24);
      if (total > 511) { r.dh |= 0x80; total %= 512; }
      r.dl = total & 0xFF; r.dh = (r.dh & 0xFE) | ((total >> 8) & 1);
    }
    // セーブ: RAM の後ろに時計 16 バイト(s m h dl dh、予約 3、控えた時の実時刻 = 1970 年からのミリ秒を倍精度 8 バイト)
    getBattery() {
      if (!this.hasBattery) return null;
      if (this.x && this.x.getBattery) return this.x.getBattery(this);
      const out = new Uint8Array(this.ram.length + (this.hasRtc ? 16 : 0));
      out.set(this.ram);
      if (this.hasRtc) {
        const r = this.rtc, o = this.ram.length; out[o] = r.s; out[o + 1] = r.m; out[o + 2] = r.h; out[o + 3] = r.dl; out[o + 4] = r.dh;
        new DataView(out.buffer).setFloat64(o + 8, GbCart.now(), true);
      }
      return out;
    }
    setBattery(bytes) {
      if (this.hasBattery && bytes && this.x && this.x.setBattery) { const ok = this.x.setBattery(this, bytes); if (ok) this.dirty = false; return ok; }
      if (!this.hasBattery || !bytes || bytes.length < this.ram.length) return false;
      this.ram.set(bytes.subarray(0, this.ram.length));
      if (this.hasRtc && bytes.length >= this.ram.length + 5) {
        const r = this.rtc, o = this.ram.length; r.s = bytes[o]; r.m = bytes[o + 1]; r.h = bytes[o + 2]; r.dl = bytes[o + 3]; r.dh = bytes[o + 4];
        if (bytes.length >= o + 16) { // 電源を切っていた間の分を進める
          const saved = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(o + 8, true);
          if (saved > 0 && isFinite(saved)) this.advanceRtc((GbCart.now() - saved) / 1000);
        }
      }
      this.dirty = false;
      return true;
    }
  }

  GbCart.now = () => Date.now(); // 実時刻(試験で差し替える)
  GbCart.EXTRA = EXTRA;
  GbCart.TYPES = TYPES;
  GbCart.isGb = isGb;
  GbCart.parseHeader = parseHeader;
  GbCart.headerChecksum = headerChecksum;
  Emu.GbCart = GbCart;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ゲームボーイの追加の基板: HuC3 / MMM01 / MBC6 / ポケットカメラ
 * (gb/cart.js の GbCart.EXTRA に登録する。cart.js の後に読む)
 *
 * どれも市販ソフトで確かめられていない(手元に無い)。仕様の出どころと、分かっていない所は各節に書く。
 * 参考: Pan Docs(HuC-3 / MMM01 / MBC6 / Game Boy Camera)、SameBoy(Expat License)の Core/mbc.c・memory.c・camera.c(読んで動作を確かめた。写してはいない)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  const GbCart = Emu.GbCart;
  if (!GbCart) return;
  const EXTRA = GbCart.EXTRA, TYPES = GbCart.TYPES;
  const f64 = (bytes, o) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(o, true);
  const putF64 = (bytes, o, v) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(o, v, true);

  // ───────────────────────── HuC3(時計+赤外線+ブザー)─────────────────────────
  // $0000 台の下位 4bit で $A000 台の中身を選ぶ: 0=RAM(読むだけ)、A=RAM、B=時計マイコンへの命令(上位=命令、下位=引数)、
  // C=命令と結果の読み出し、D=セマフォ(bit0=1 で受け付け可。bit0=0 を書くと B の命令を実行)、E=赤外線。
  // マイコンは 256 ニブルの記憶を持つ: $10-12=1 日の中の分(0〜1439)、$13-15=日数、$26=音の番号(下位 2bit)、$27=1 でブザー有効。
  // 命令: 1=読んで番地+1、3=書いて番地+1、4/5=番地の下位/上位、6=拡張(0=今の時刻を $00-06 へ、1=$00-06 を時刻へ、2=状態(1 を返す)、
  //   $E=2 回続けるとブザーを鳴らす)。
  // ★ブザーの音の高さと長さは資料が無い。鳴らした事実と音の番号だけを確かに記録し、音そのものは本体側の仮の値で鳴らす
  TYPES[0xFE] = { mbc: 'huc3', ram: 1, battery: 1, ir: 1, buzzer: 1 };
  EXTRA.huc3 = {
    init(c) { c.h3 = { mode: 0, cmd: 0, arg: 0, result: 0, addr: 0, mem: new Uint8Array(256), sub: 0, sec: 0, tone: 0 }; },
    reset(c) { const h = c.h3; h.mode = 0; h.cmd = 0; h.arg = 0; h.result = 0; h.addr = 0; h.tone = 0; },
    map(c) { c.lo = 0; c.hi = (c.romBank % c.romBanks) << 14; c.ramOff = c.ram.length > 0x2000 ? (c.ramBank << 13) % c.ram.length : 0; },
    write(c, addr, v) {
      if (addr < 0x2000) c.h3.mode = v & 0x0F;
      else if (addr < 0x4000) c.romBank = v & 0x7F;
      else if (addr < 0x6000) c.ramBank = v & 3;
    },
    readRam(c, addr) {
      const h = c.h3;
      switch (h.mode) {
        case 0x0: case 0xA: return c.ram.length ? c.ram[(c.ramOff + (addr & 0x1FFF)) % c.ram.length] : 0xFF;
        case 0xC: return 0x80 | (h.cmd << 4) | h.result;
        case 0xD: return 0x81; // いつでも受け付け可
        case 0xE: return 0xC0 | (c.irIn ? 1 : 0);
      }
      return 0xFF;
    },
    writeRam(c, addr, v) {
      const h = c.h3, m = h.mem;
      switch (h.mode) {
        case 0xA: if (c.ram.length) { c.ram[(c.ramOff + (addr & 0x1FFF)) % c.ram.length] = v; c.dirty = true; } break;
        case 0xB: h.cmd = (v >> 4) & 7; h.arg = v & 0x0F; break;
        case 0xE: c.irOut = (v & 1) !== 0; break;
        case 0xD:
          if (v & 1) break;
          switch (h.cmd) {
            case 1: h.result = m[h.addr]; h.addr = (h.addr + 1) & 0xFF; break;
            case 3: m[h.addr] = h.arg; h.addr = (h.addr + 1) & 0xFF; c.dirty = true; break;
            case 4: h.addr = (h.addr & 0xF0) | h.arg; break;
            case 5: h.addr = (h.addr & 0x0F) | (h.arg << 4); break;
            case 6:
              if (h.arg === 0) { for (let i = 0; i < 6; i++) m[i] = m[0x10 + i]; m[6] = 0; }
              else if (h.arg === 1) { for (let i = 0; i < 6; i++) m[0x10 + i] = m[i]; h.sec = 0; c.dirty = true; }
              else if (h.arg === 2) h.result = 1;
              else if (h.arg === 0xE) { if (++h.tone >= 2) { h.tone = 0; if (m[0x27] === 1) c.buzzQueue.push(m[0x26] & 3); } }
              if (h.arg !== 0xE) h.tone = 0;
              break;
          }
          break;
      }
    },
    // 時計: 1 分ごとに $10-12 を進め、1440 で日数 $13-15 へ
    addMinutes(c, n) {
      const m = c.h3.mem;
      let min = m[0x10] | (m[0x11] << 4) | (m[0x12] << 8), day = m[0x13] | (m[0x14] << 4) | (m[0x15] << 8);
      min += n; day = (day + Math.floor(min / 1440)) & 0xFFF; min %= 1440;
      m[0x10] = min & 15; m[0x11] = (min >> 4) & 15; m[0x12] = (min >> 8) & 15;
      m[0x13] = day & 15; m[0x14] = (day >> 4) & 15; m[0x15] = (day >> 8) & 15;
    },
    tick(c, t, clockHz) {
      const h = c.h3;
      h.sub += t;
      while (h.sub >= clockHz) { h.sub -= clockHz; if (++h.sec >= 60) { h.sec = 0; EXTRA.huc3.addMinutes(c, 1); c.dirty = true; } }
    },
    // セーブ: RAM、マイコンの記憶 256、秒、控えた時の実時刻(倍精度 8 バイト)
    getBattery(c) {
      const out = new Uint8Array(c.ram.length + 256 + 8 + 8);
      out.set(c.ram); out.set(c.h3.mem, c.ram.length); out[c.ram.length + 256] = c.h3.sec;
      putF64(out, c.ram.length + 264, GbCart.now());
      return out;
    },
    setBattery(c, bytes) {
      if (bytes.length < c.ram.length) return false;
      c.ram.set(bytes.subarray(0, c.ram.length));
      const o = c.ram.length;
      if (bytes.length >= o + 272) {
        c.h3.mem.set(bytes.subarray(o, o + 256)); c.h3.sec = bytes[o + 256] % 60;
        const saved = f64(bytes, o + 264);
        if (saved > 0 && isFinite(saved)) { const s = Math.floor((GbCart.now() - saved) / 1000) + c.h3.sec; if (s > 0) { EXTRA.huc3.addMinutes(c, Math.floor(s / 60)); c.h3.sec = s % 60; } }
      }
      return true;
    },
  };

  // ───────────────────────── MMM01(多本入り)─────────────────────────
  // 電源投入時は「未マップ」: ROM の最後の 32K(メニュー)が $0000-$7FFF に出る。メニューが選んだゲームの位置と大きさをレジスタの
  // 上位ビットに書き、$0000 台の bit6 で「マップ」すると、以後は選ばれたゲームに対して MBC1 として振る舞う(上位ビットは書けなくなる)。
  //   $0000: bit0-3 RAM 許可、bit4-5 RAM バンクの固定マスク、bit6 マップ
  //   $2000: bit0-4 ROM バンク下位(マスクされたビットは書けない)、bit5-6 ROM バンク中位
  //   $4000: bit0-1 RAM バンク下位、bit2-3 RAM バンク上位、bit4-5 ROM バンク上位、bit6 モード切替の禁止
  //   $6000: bit0 MBC1 のモード、bit2-5 ROM バンク下位の固定マスク(bit1-4 に当たる)、bit6 多重化(市販品では未使用)
  // 吸い出しには「メニューが先頭」の物と「最後」の物がある。先頭の種別が MMM01 なら最初の 32K を最後へ回す(SameBoy と同じ扱い)
  for (const [t, o] of [[0x0B, {}], [0x0C, { ram: 1 }], [0x0D, { ram: 1, battery: 1 }]]) TYPES[t] = Object.assign({ mbc: 'mmm01' }, o);
  const isMmm01Type = (t) => t >= 0x0B && t <= 0x0D;
  EXTRA.mmm01 = {
    detect(rom) {
      const n = rom.length;
      if (n <= 0x8000) return null;
      if (isMmm01Type(rom[0x147])) { // メニューが先頭 → 最後へ回す
        const out = new Uint8Array(n); out.set(rom.subarray(0x8000)); out.set(rom.subarray(0, 0x8000), n - 0x8000);
        return { rom: out, headerAt: n - 0x8000 };
      }
      const m = n - 0x8000;
      let logo = true; for (let i = 0x104; i < 0x134; i++) if (rom[i] !== rom[m + i]) { logo = false; break; }
      if (logo && rom[0x104] === 0xCE && isMmm01Type(rom[m + 0x147])) return { rom, headerAt: m };
      return null;
    },
    reset(c) { c.mm = { mapped: false, ramMask: 0, romLow: 0, romMid: 0, romMask: 0, ramLow: 0, ramHigh: 0, romHigh: 0, modeLock: false, mode: 0, mux: false }; },
    map(c) {
      const m = c.mm, n = c.romBanks;
      if (!m.mapped) { c.lo = (n - 2) << 14; c.hi = (n - 1) << 14; c.ramOff = 0; return; }
      let rom0, romB, ramB;
      if (m.mux) {
        rom0 = (m.romLow & m.romMask) | ((m.mode ? m.ramLow : m.ramLow & m.ramMask) << 5) | (m.romHigh << 7);
        romB = m.romLow | (m.ramLow << 5) | (m.romHigh << 7);
        ramB = m.romMid | (m.ramHigh << 2);
      } else {
        rom0 = (m.romLow & m.romMask) | (m.romMid << 5) | (m.romHigh << 7);
        romB = m.romLow | (m.romMid << 5) | (m.romHigh << 7);
        ramB = (m.mode ? m.ramLow : m.ramLow & m.ramMask) | (m.ramHigh << 2);
      }
      if ((m.romLow & ~m.romMask & 0x1F) === 0) romB |= 1; // ゲーム内のバンク 0 は 1 に読み替え(MBC1 と同じ)
      c.lo = (rom0 % n) << 14; c.hi = (romB % n) << 14;
      c.ramOff = c.ram.length ? (ramB << 13) % c.ram.length : 0;
    },
    write(c, addr, v) {
      const m = c.mm;
      if (addr < 0x2000) {
        c.ramEnable = (v & 0x0F) === 0x0A;
        if (!m.mapped) { m.ramMask = (v >> 4) & 3; if (v & 0x40) m.mapped = true; }
      } else if (addr < 0x4000) {
        if (!m.mapped) m.romMid = (v >> 5) & 3;
        m.romLow = (m.romLow & m.romMask) | (v & 0x1F & ~m.romMask);
      } else if (addr < 0x6000) {
        m.ramLow = (m.ramLow & m.ramMask) | (v & 3 & ~m.ramMask);
        if (!m.mapped) { m.ramHigh = (v >> 2) & 3; m.romHigh = (v >> 4) & 3; m.modeLock = (v & 0x40) !== 0; }
      } else {
        if (!m.modeLock) m.mode = v & 1;
        if (!m.mapped) { m.romMask = ((v >> 2) & 0x0F) << 1; m.mux = (v & 0x40) !== 0; }
      }
    },
  };

  // ───────────────────────── MBC6(フラッシュメモリつき)─────────────────────────
  // ROM は 8K 単位で 2 窓($4000 台=A、$6000 台=B)、RAM は 4K 単位で 2 窓($A000 台=A、$B000 台=B)。
  // 窓ごとに ROM とフラッシュ(1MB+隠し領域 256 バイト)を切り替えられる。フラッシュは JEDEC 式の命令列
  // ($5555 に $AA、$2AAA に $55、$5555 に命令)。番地はフラッシュ内の番地 = バンク×$2000+窓内の位置。
  //   $80…$30=セクタ(128K)消去、$80…$10=全消去、$90=ID(C2 81)、$A0=書き込み(128 バイト単位。最後の番地にもう一度書くと確定)、
  //   $60…$04/$E0=隠し領域の消去/書き込み、$60…$40/$20=セクタ 0 の保護解除/保護、$77…$77=隠し領域を読む、$F0=読み出しへ戻る
  // 書き込み/消去の後は状態バイト($80=完了)が読める。セクタ 0 と隠し領域は $1000 の書き込み許可が要る
  TYPES[0x20] = { mbc: 'mbc6', ram: 1, battery: 1 };
  const FLASH = 0x100000;
  EXTRA.mbc6 = {
    ramSize: 0x8000,
    init(c) { c.m6 = { flash: new Uint8Array(FLASH).fill(0xFF), hidden: new Uint8Array(256).fill(0xFF), protect0: false }; },
    reset(c) { Object.assign(c.m6, { romA: 2, romB: 3, flashA: false, flashB: false, ramA: 0, ramB: 0, flashOn: false, wp: false, seq: 0, mode: 'read', pre: 0, last: -1, status: 0x80 }); },
    map() {},
    read(c, addr) {
      if (addr < 0x4000) return c.rom[addr];
      const m = c.m6, isB = addr >= 0x6000, bank = isB ? m.romB : m.romA, off = addr & 0x1FFF;
      if (isB ? m.flashB : m.flashA) {
        if (!m.flashOn) return 0xFF;
        const fa = ((bank << 13) | off) & (FLASH - 1);
        if (m.mode === 'status') return m.status;
        if (m.mode === 'id') return (off & 1) ? 0x81 : 0xC2;
        if (m.mode === 'hidden') return m.hidden[fa & 0xFF];
        return m.flash[fa];
      }
      return c.rom[((bank << 13) | off) % c.rom.length];
    },
    write(c, addr, v) {
      const m = c.m6;
      if (addr < 0x0400) c.ramEnable = (v & 0x0F) === 0x0A;
      else if (addr < 0x0800) m.ramA = v & 7;
      else if (addr < 0x0C00) m.ramB = v & 7;
      else if (addr < 0x1000) m.flashOn = (v & 1) !== 0;
      else if (addr === 0x1000) m.wp = (v & 1) !== 0;
      else if (addr < 0x2000) { /* 使われていない */ }
      else if (addr < 0x2800) m.romA = v & 0x7F;
      else if (addr < 0x3000) m.flashA = v === 0x08;
      else if (addr < 0x3800) m.romB = v & 0x7F;
      else if (addr < 0x4000) m.flashB = v === 0x08;
      else EXTRA.mbc6.flashWrite(c, addr, v);
    },
    flashWrite(c, addr, v) {
      const m = c.m6, isB = addr >= 0x6000;
      if (!(isB ? m.flashB : m.flashA) || !m.flashOn) return;
      const fa = (((isB ? m.romB : m.romA) << 13) | (addr & 0x1FFF)) & (FLASH - 1);
      const canSector0 = m.wp && !m.protect0;
      if (m.mode === 'program' || m.mode === 'programHidden') {
        if (v === 0xF0 && m.last < 0) { m.mode = 'read'; return; }
        if (fa === m.last) { m.mode = 'status'; m.status = 0x80; m.last = -1; c.dirty = true; return; } // 最後の番地にもう一度 = 確定
        if (m.mode === 'programHidden') { if (m.wp) m.hidden[fa & 0xFF] &= v; }
        else if (fa >= 0x20000 || canSector0) m.flash[fa] &= v; // 書き込みは 1→0 だけ
        m.last = fa;
        return;
      }
      if (v === 0xF0) { m.mode = 'read'; m.seq = 0; m.pre = 0; return; }
      if (m.seq === 0) { if (fa === 0x5555 && v === 0xAA) m.seq = 1; return; }
      if (m.seq === 1) { m.seq = (fa === 0x2AAA && v === 0x55) ? 2 : 0; return; }
      m.seq = 0; // 3 つ目 = 命令
      const pre = m.pre; m.pre = 0;
      if (pre === 0x80) {
        if (v === 0x30) { const s = fa >> 17; if (s || canSector0) m.flash.fill(0xFF, s << 17, (s + 1) << 17); }
        else if (v === 0x10) m.flash.fill(0xFF, canSector0 ? 0 : 0x20000);
        else return;
        m.mode = 'status'; m.status = 0x80; c.dirty = true; return;
      }
      if (pre === 0x60) {
        if (v === 0x04) { if (m.wp) m.hidden.fill(0xFF); }
        else if (v === 0xE0) { m.mode = 'programHidden'; m.last = -1; return; }
        else if (v === 0x40) { if (m.wp) m.protect0 = false; }
        else if (v === 0x20) { if (m.wp) m.protect0 = true; }
        else return;
        m.mode = 'status'; m.status = 0x80 | (m.protect0 ? 2 : 0); c.dirty = true; return;
      }
      if (pre === 0x77) { if (v === 0x77) m.mode = 'hidden'; return; }
      if (v === 0x80 || v === 0x60 || v === 0x77) m.pre = v;
      else if (v === 0x90) m.mode = 'id';
      else if (v === 0xA0) { m.mode = 'program'; m.last = -1; }
    },
    readRam(c, addr) { if (!c.ramEnable) return 0xFF; const m = c.m6; return c.ram[(((addr < 0xB000 ? m.ramA : m.ramB) << 12) | (addr & 0xFFF)) % c.ram.length]; },
    writeRam(c, addr, v) { if (!c.ramEnable) return; const m = c.m6; c.ram[(((addr < 0xB000 ? m.ramA : m.ramB) << 12) | (addr & 0xFFF)) % c.ram.length] = v; c.dirty = true; },
    // セーブ: RAM 32K、フラッシュ 1MB、隠し領域 256、保護の印 1
    getBattery(c) { const m = c.m6, out = new Uint8Array(c.ram.length + FLASH + 257); out.set(c.ram); out.set(m.flash, c.ram.length); out.set(m.hidden, c.ram.length + FLASH); out[out.length - 1] = m.protect0 ? 1 : 0; return out; },
    setBattery(c, bytes) {
      if (bytes.length < c.ram.length) return false;
      c.ram.set(bytes.subarray(0, c.ram.length));
      if (bytes.length >= c.ram.length + FLASH + 257) { const m = c.m6, o = c.ram.length; m.flash.set(bytes.subarray(o, o + FLASH)); m.hidden.set(bytes.subarray(o + FLASH, o + FLASH + 256)); m.protect0 = bytes[o + FLASH + 256] === 1; }
      return true;
    },
  };

  // ───────────────────────── ポケットカメラ ─────────────────────────
  // バンクは MBC5 と同じ。RAM バンクに $10 以上を選ぶと $A000 台がカメラのレジスタになる:
  //   $A000 bit0=撮影開始/撮影中、$A001 下位 5bit=ゲイン・上位 3bit=輪郭強調の種類、$A002-3=露光時間、$A004 bit4-6=輪郭強調の強さ、
  //   $A006-$A035=ディザの閾値(4×4 画素 × 3 段)
  // 撮影が終わると、128×112 の絵が 2bpp のタイル(16×14 個)で RAM バンク 0 の $A100-$AEFF に入る。撮影中は RAM が読めない(0)。
  // 画素の作り方は SameBoy と同じ考え方: 明るさ × ゲイン × 露光/$1000 → 輪郭強調 → 位置ごとの 3 つの閾値で 4 階調。
  // 元の絵は camImage(128×112、0〜255。本体が Web カメラから入れる)。無ければ斜めの濃淡の試験模様
  TYPES[0xFC] = { mbc: 'camera', ram: 1, battery: 1, camera: 1 };
  const CAM_W = 128, CAM_H = 112;
  const GAIN = [0.8809390, 0.9149149, 0.9457498, 0.9739758, 1.0000000, 1.0241412, 1.0466537, 1.0677433, 1.0875793, 1.1240310, 1.1568911, 1.1868043, 1.2142561, 1.2396208, 1.2743837, 1.3157323,
    1.3525190, 1.3856512, 1.4157897, 1.4434309, 1.4689574, 1.4926697, 1.5148087, 1.5355703, 1.5551159, 1.5735801, 1.5910762, 1.6077008, 1.6235366, 1.6386550, 1.6531183, 1.6669808];
  const EDGE = [0.5, 0.75, 1, 1.25, 2, 3, 4, 5];
  EXTRA.camera = {
    ramSize: 0x20000,
    init(c) { c.cam = { regs: new Uint8Array(0x36), mapped: false, left: 0, shots: 0 }; c.camImage = null; },
    reset(c) { c.cam.regs.fill(0); c.cam.mapped = false; c.cam.left = 0; c.romBank = 1; },
    map(c) { c.lo = 0; c.hi = (c.romBank % c.romBanks) << 14; c.ramOff = ((c.ramBank & 0x0F) << 13) % c.ram.length; },
    write(c, addr, v) {
      if (addr < 0x2000) c.ramEnable = (v & 0x0F) === 0x0A;
      else if (addr < 0x4000) c.romBank = v & 0x3F;
      else if (addr < 0x6000) { c.ramBank = v & 0x1F; c.cam.mapped = (v & 0x10) !== 0; }
    },
    readRam(c, addr) {
      const cam = c.cam;
      if (cam.mapped) return (addr & 0x7F) === 0 ? cam.regs[0] & 7 : 0x00; // レジスタは $A000 だけ読める
      if (cam.regs[0] & 1) return 0x00;                                    // 撮影中は RAM が読めない
      return c.ram[c.ramOff + (addr & 0x1FFF)];
    },
    writeRam(c, addr, v) {
      const cam = c.cam;
      if (cam.mapped) {
        const r = addr & 0x7F;
        if (r >= 0x36) return;
        if (r === 0) {
          v &= 7;
          if ((v & 1) && !(cam.regs[0] & 1)) { // 撮影開始。掛かる時間は露光時間で決まる(実機の値)
            const exposure = (cam.regs[2] << 8) | cam.regs[3];
            cam.left = 129792 + ((cam.regs[1] & 0x80) ? 0 : 2048) + exposure * 64;
            cam.shots++;
          }
          if (!(v & 1) && (cam.regs[0] & 1)) v |= 1; // 途中でやめる操作は無視
        }
        cam.regs[r] = v;
        return;
      }
      if (!c.ramEnable || (cam.regs[0] & 1)) return;
      c.ram[c.ramOff + (addr & 0x1FFF)] = v; c.dirty = true;
    },
    tick(c, t) {
      const cam = c.cam;
      if (!(cam.regs[0] & 1)) return;
      cam.left -= t;
      if (cam.left <= 0) { EXTRA.camera.develop(c); cam.regs[0] &= ~1; }
    },
    // 元の絵をレジスタどおりに 4 階調へ落として RAM に入れる
    develop(c) {
      const r = c.cam.regs, img = c.camImage;
      const gain = GAIN[r[1] & 0x1F], exposure = ((r[2] << 8) | r[3]) / 0x1000;
      const lum = new Float32Array(CAM_W * CAM_H);
      for (let y = 0; y < CAM_H; y++) for (let x = 0; x < CAM_W; x++) {
        const src = img && img.length >= CAM_W * CAM_H ? img[y * CAM_W + x] : ((x + y) * 255 / (CAM_W + CAM_H)) | 0;
        lum[y * CAM_W + x] = src * gain * exposure;
      }
      const edgeOn = (r[1] & 0xE0) === 0xE0, ratio = EDGE[(r[4] >> 4) & 7];
      const at = (x, y) => lum[Math.max(0, Math.min(CAM_H - 1, y)) * CAM_W + Math.max(0, Math.min(CAM_W - 1, x))];
      const out = c.ram; // バンク 0 の $0100 から
      for (let ty = 0; ty < 14; ty++) for (let tx = 0; tx < 16; tx++) for (let py = 0; py < 8; py++) {
        let lo = 0, hi = 0;
        const y = ty * 8 + py;
        for (let px = 0; px < 8; px++) {
          const x = tx * 8 + px;
          let v = at(x, y);
          if (edgeOn) v += (v * 4 - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1)) * ratio;
          const pb = 6 + ((x & 3) + (y & 3) * 4) * 3;
          const col = v < r[pb] ? 3 : v < r[pb + 1] ? 2 : v < r[pb + 2] ? 1 : 0;
          lo = (lo << 1) | (col & 1); hi = (hi << 1) | (col >> 1);
        }
        const o = 0x100 + (ty * 16 + tx) * 16 + py * 2;
        out[o] = lo; out[o + 1] = hi;
      }
      c.dirty = true;
    },
  };
  GbCart.CAM_W = CAM_W; GbCart.CAM_H = CAM_H;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ゲームボーイの PPU(DMG)
 * MML.Emu.GbPpu
 *
 * 1 行 = 456T、154 行(0-143 表示、144-153 VBlank)。行の中はモード 2(OAM 走査、0-79)→ 3(描画)→ 0(HBlank)。
 *
 * ★2026-11-13 段階 8c で行単位から作り直し(DESIGN-GB-CAPTURE.md §3):
 *   - モード 3 の長さは 172T+(SCX の下位 3bit)+ウィンドウ 6T+スプライトごとの遅れ(Pan Docs の OBJ penalty の式)。
 *     HBlank の STAT 割り込みで音ドライバや演出を回すソフトの時刻が合う
 *   - 画素はモード 3 の間、時間の進みに合わせて左から描く(本体は 4T ずつ進むので 4 画素刻み)。行の途中で
 *     SCX/SCY/LCDC/パレット/ウィンドウを書き換えるとその位置から効く。スプライトの遅れによる画素位置のずれまでは追わない
 *   - モード 2/3 の間の OAM、モード 3 の間の VRAM は CPU から触れない(読むと $FF、書きは捨てる)
 *   - 153 行目は 4T で LY=0 になる。LCD を点けた直後の 1 行目はモード 2 が無く 4T 短い。LCD が消えている間 LY=LYC の旗は動かない
 *   CGB(段階 8d): VRAM 2 バンク、BG の属性(バンク 1 のマップ: パレット/タイルのバンク/反転/優先)、パレット 8+8 本(15bit 色)、
 *     スプライトの優先は OAM 順、LCDC bit0 は「BG がスプライトより前に出られるか」。frameIdx はパレットの番号(BG 0-31、OBJ 32-63)
 *   まだ無い物: 画素 FIFO の細部(スプライトの遅れによる画素位置、WX=166 などの癖)、STAT 書き込みの癖(DMG)、OAM 破壊バグ
 *
 * 参考: Pan Docs "Rendering" "STAT" "OAM"。細部は mooneye の acceptance/ppu と dmg-acid2 で確かめる(tools/headless/gb-testroms.js)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 160, H = 144;
  const FIRST_PIXEL_DOT = 92; // モード 3 の頭(80)から最初の画素が出るまで 12T(+SCX の下位 3bit)

  class GbPpu {
    constructor(con) {
      this.con = con; // requestIrq(bit)
      this.vram = new Uint8Array(0x4000); // 8K × 2 バンク(DMG はバンク 0 だけ)
      this.cgb = false;                   // 本体が決める
      this.bgPalRam = new Uint8Array(64); this.objPalRam = new Uint8Array(64); // CGB のパレット(色 1 つ 2 バイト、15bit BGR)
      this.colors = new Uint32Array(64);  // 上を 0xAABBGGRR に直した物(BG 0-31、OBJ 32-63)
      this.sprSorted = new Uint8Array(10);
      this.oam = new Uint8Array(0xA0);
      this.frame = new Uint32Array(W * H);   // 0xAABBGGRR
      this.frameIdx = new Uint8Array(W * H); // 階調番号 0-3(巻き戻しの映像の輪が控える。色は shades で引く)
      this.shades = [0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000]; // 白 → 黒(設定で差し替える)
      this.sprList = new Uint8Array(10); // その行のスプライト(OAM 番号、優先順)
      this.noRender = false;             // true: 絵は描かない(GBS プレイヤー)
      this.reset();
    }

    reset() {
      this.vram.fill(0); this.oam.fill(0);
      this.lcdc = 0x91; this.statEn = 0;
      this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
      this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF;
      this.wy = 0; this.wx = 0;
      this.vbk = 0; this.bcps = 0; this.ocps = 0; this.opri = 0;
      this.bgPalRam.fill(0xFF); this.objPalRam.fill(0xFF); this.colors.fill(0xFFFFFFFF);
      this.line = 0;          // 内部の行(153 行目でも 153 のまま。ly は読み出し値)
      this.dot = 0; this.mode = 2;
      this.mode3End = 252;    // この行のモード 3 が終わる位置(T)
      this.px = 0;            // この行で次に描く画素
      this.scxFine = 0;
      this.sprCount = 0;
      this.winLine = 0; this.wyHit = false; this.winActive = false; this.winX = 0;
      this.firstLine = false; // LCD を点けた直後の 1 行目(モード 2 が無い)
      this.lycFlag = true;    // 起動直後は LY=LYC=0
      this.statLine = false;
      this.vblankStarted = false;
      this.frame.fill(this.shades[0]); this.frameIdx.fill(0);
    }

    get on() { return (this.lcdc & 0x80) !== 0; }
    // CGB のパレットへ 1 バイト(which: 0=BG $FF69、1=OBJ $FF6B)。番号は自動で進む(bit7)
    writePal(which, v) {
      const ram = which ? this.objPalRam : this.bgPalRam, sel = which ? this.ocps : this.bcps, i = sel & 0x3F;
      ram[i] = v;
      const c = ram[i & 0x3E] | (ram[i | 1] << 8), r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
      this.colors[(which ? 32 : 0) + (i >> 1)] = (0xFF000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2))) >>> 0;
      if (sel & 0x80) { if (which) this.ocps = 0x80 | ((i + 1) & 0x3F); else this.bcps = 0x80 | ((i + 1) & 0x3F); }
    }
    // CPU から見て触れない間(本体のバスが見る)
    oamBlocked() { return (this.lcdc & 0x80) !== 0 && this.line < H && !this.firstLine && (this.mode === 2 || this.mode === 3); }
    vramBlocked() { return (this.lcdc & 0x80) !== 0 && this.line < H && this.mode === 3; }

    readReg(addr) {
      switch (addr) {
        case 0xFF40: return this.lcdc;
        case 0xFF41: return 0x80 | this.statEn | (this.lycFlag ? 4 : 0) | (this.on ? (this.firstLine && this.mode === 2 ? 0 : this.mode) : 0);
        case 0xFF42: return this.scy;
        case 0xFF43: return this.scx;
        case 0xFF44: return this.ly;
        case 0xFF45: return this.lyc;
        case 0xFF47: return this.bgp;
        case 0xFF48: return this.obp0;
        case 0xFF49: return this.obp1;
        case 0xFF4A: return this.wy;
        case 0xFF4B: return this.wx;
      }
      return 0xFF;
    }

    writeReg(addr, v) {
      switch (addr) {
        case 0xFF40: {
          const was = this.on;
          this.lcdc = v;
          if (was && !this.on) { // 消灯: LY=0、モード 0、画面は白。LY=LYC の旗はそのまま残る
            this.ly = 0; this.line = 0; this.dot = 0; this.mode = 0; this.winLine = 0; this.wyHit = false; this.firstLine = false;
            this.frame.fill(this.shades[0]); this.frameIdx.fill(0);
            this._stat();
          } else if (!was && this.on) { // 点灯: 1 行目は 4T 短く、モード 2 の間も STAT はモード 0 を返す(OAM にも触れる)
            this.ly = 0; this.line = 0; this.dot = 4; this.mode = 2; this.firstLine = true;
            this.winLine = 0; this.wyHit = false; this.px = 0;
            this.lycFlag = this.lyc === 0;
            this._stat();
          }
          break;
        }
        case 0xFF41: this.statEn = v & 0x78; this._stat(); break;
        case 0xFF42: this.scy = v; break;
        case 0xFF43: this.scx = v; break;
        case 0xFF44: break; // LY は読み出し専用
        case 0xFF45: this.lyc = v; if (this.on) { this.lycFlag = this._lyCmp() === v; this._stat(); } break;
        case 0xFF47: this.bgp = v; break;
        case 0xFF48: this.obp0 = v; break;
        case 0xFF49: this.obp1 = v; break;
        case 0xFF4A: this.wy = v; break;
        case 0xFF4B: this.wx = v; break;
      }
    }

    // LYC と比べる値。153 行目は LY が 0 に変わった後もしばらく 153 と比べ、その後 0 と比べる
    _lyCmp() { return this.line === 153 ? (this.dot < 12 ? 153 : 0) : this.line; }

    // STAT の割り込み線は各要因の OR。立ち上がりでだけ割り込む(要因が重なっている間は次が出ない)
    _stat() {
      const e = this.statEn, m = this.firstLine && this.mode === 2 ? 0 : this.mode;
      const line = this.on && (((e & 0x40) && this.lycFlag) || ((e & 0x20) && m === 2) || ((e & 0x10) && m === 1) || ((e & 0x08) && m === 0) ||
        ((e & 0x20) && this.line === H && this.dot < 4)); // VBlank の頭ではモード 2 の要因でも割り込む(実機の癖)
      if (line && !this.statLine) this.con.requestIrq(1);
      this.statLine = !!line;
    }

    // step T 進める(本体が M サイクルごとに呼ぶ。4、CGB の倍速なら 2)
    tick(step) {
      if (!(this.lcdc & 0x80)) return;
      const d = (this.dot += step || 4);
      if (this.line < H) {
        if (this.mode === 2) {
          if (d >= 80) this._startMode3();
        } else if (this.mode === 3) {
          if (!this.noRender) this._renderTo(d - FIRST_PIXEL_DOT - this.scxFine + 4);
          if (d >= this.mode3End) {
            if (!this.noRender) this._renderTo(W);
            if (this.con.sgb) this.con.sgb.lcdLine(this.line, this.frameIdx); // スーパーゲームボーイ: 描き終えた行を ICD2 へ
            if (this.winActive) this.winLine++;
            this.mode = 0; this.firstLine = false;
            this._stat();
            if (this.cgb) this.con.hblank(); // HDMA(HBlank ごと)
          }
        }
      } else if (this.line === 153) {
        if (d === 4) this.ly = 0;
        else if (d === 12) { this.lycFlag = this.lyc === 0; this._stat(); }
      } else if (d === 4 && this.line === H && this.statLine) this._stat(); // VBlank 頭だけのモード 2 要因を下ろす
      // LY の読み出し値は行の終わりの 4T 前に次の行へ進む(DMG。mooneye の hblank_ly_scx_timing が見る)
      if (d === 452 && this.line < 153) this.ly = this.line + 1;
      // 新しい行の LY=LYC は行頭の 4T 後に立つ
      if (d === 4 && !this.firstLine) { this.lycFlag = this.line === this.lyc; this._stat(); }
      if (d >= 456) {
        this.dot = 0;
        this.line++;
        if (this.line === 154) { this.line = 0; this.winLine = 0; this.wyHit = false; }
        if (this.line !== 0) this.ly = this.line;
        if (this.line !== 0) this.lycFlag = false; // 行頭の 4T は比較が外れる(0 行目は 153 行目の途中から LY=0 として比べている)
        if (this.line === H) { this.mode = 1; this.vblankStarted = true; this.con.requestIrq(0); }
        else if (this.line < H) { this.mode = 2; this.px = 0; }
        this._stat();
      }
    }

    // モード 2 の終わり: その行のスプライトを集め、モード 3 の長さを決める
    _startMode3() {
      const y = this.line, lcdc = this.lcdc, oam = this.oam;
      if (y === this.wy) this.wyHit = true;
      const h = (lcdc & 0x04) ? 16 : 8;
      let n = 0;
      const list = this.sprList;
      if (lcdc & 0x02) for (let i = 0; i < 40 && n < 10; i++) { const sy = oam[i * 4] - 16; if (y >= sy && y < sy + h) list[n++] = i; }
      // X の小さい順(同じなら OAM の若い方)。挿入ソート(高々 10 個)。DMG はこれが描画の優先順、CGB の優先は OAM 順のまま(遅れの計算だけ X 順)
      const sorted = this.cgb && !this.opri ? this.sprSorted : list;
      if (sorted !== list) sorted.set(list);
      for (let i = 1; i < n; i++) { const v = sorted[i]; let j = i - 1; while (j >= 0 && oam[sorted[j] * 4 + 1] > oam[v * 4 + 1]) { sorted[j + 1] = sorted[j]; j--; } sorted[j + 1] = v; }
      this.sprCount = n;
      this.scxFine = this.scx & 7;
      const winOnLine = (lcdc & 0x20) && this.wyHit && this.wx <= 166;
      let len = 172 + this.scxFine + (winOnLine ? 6 : 0);
      // スプライトの遅れ: 左端の画素が乗る BG/ウィンドウのタイルごとに 1 回だけ「そのタイルの残り画素 − 2(0 未満は 0)」、どのスプライトにも一律 6
      let lastTile = -999;
      for (let i = 0; i < n; i++) {
        const ox = oam[sorted[i] * 4 + 1];
        if (ox >= 168) continue;
        let tile, right;
        if (winOnLine && ox >= this.wx + 1) { const wxp = ox - (this.wx + 1); tile = 0x1000 + (wxp >> 3); right = 7 - (wxp & 7); }
        else { const bx = (ox + this.scx) & 0xFF; tile = bx >> 3; right = 7 - (bx & 7); }
        if (tile !== lastTile) { lastTile = tile; len += Math.max(0, right - 2); }
        len += 6;
      }
      this.mode3End = 80 + len;
      this.mode = 3; this.px = 0; this.winActive = false; this.winX = 0;
      this._stat();
    }

    // この行の画素を x1 の手前まで描く(今のレジスタで)
    _renderTo(x1) {
      if (x1 > W) x1 = W;
      let x = this.px;
      if (x >= x1) return;
      if (this.cgb) { this._renderToCgb(x1); return; }
      const y = this.line, lcdc = this.lcdc, vram = this.vram, oam = this.oam, sh = this.shades;
      const out = this.frame, outIdx = this.frameIdx, base = y * W;
      const bgOn = (lcdc & 0x01) !== 0, signedTiles = !(lcdc & 0x10);
      const winOk = bgOn && (lcdc & 0x20) && this.wyHit && this.wx <= 166, wx0 = this.wx - 7;
      const bgMap = (lcdc & 0x08) ? 0x1C00 : 0x1800, winMap = (lcdc & 0x40) ? 0x1C00 : 0x1800;
      const yy = (y + this.scy) & 0xFF, bgRow = bgMap + (yy >> 3) * 32, bgFine = (yy & 7) * 2, scx = this.scx;
      const wl = this.winLine, winRow = winMap + (wl >> 3) * 32, winFine = (wl & 7) * 2;
      const sprOn = (lcdc & 0x02) !== 0, n = this.sprCount, list = this.sprList, h = (lcdc & 0x04) ? 16 : 8;
      const bgp = this.bgp;
      for (; x < x1; x++) {
        let c = 0;
        if (bgOn) {
          // ウィンドウはその行で WX に達した所から始まり、行の終わりまで続く(WX<7 は左が欠ける)
          if (winOk && !this.winActive && x >= wx0) { this.winActive = true; this.winX = x - wx0; }
          let a, bit;
          if (this.winActive && (lcdc & 0x20)) {
            const wxp = this.winX++;
            const t = vram[winRow + ((wxp >> 3) & 31)];
            a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + winFine; bit = 7 - (wxp & 7);
          } else {
            const xx = (x + scx) & 0xFF;
            const t = vram[bgRow + (xx >> 3)];
            a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + bgFine; bit = 7 - (xx & 7);
          }
          c = (((vram[a + 1] >> bit) & 1) << 1) | ((vram[a] >> bit) & 1);
        }
        let shade = (bgp >> (c * 2)) & 3;
        if (sprOn) {
          for (let i = 0; i < n; i++) {
            const o = list[i] * 4, sx = oam[o + 1] - 8;
            if (x < sx || x >= sx + 8) continue;
            const fl = oam[o + 3];
            let ln = y - (oam[o] - 16), tile = oam[o + 2];
            if (fl & 0x40) ln = h - 1 - ln;
            if (h === 16) tile &= 0xFE;
            const sa = tile * 16 + ln * 2, sb = (fl & 0x20) ? x - sx : 7 - (x - sx);
            const sc = (((vram[sa + 1] >> sb) & 1) << 1) | ((vram[sa] >> sb) & 1);
            if (!sc) continue;
            // 勝ったスプライトが BG の後ろなら BG が出る(下位のスプライトは出ない)
            if (!((fl & 0x80) && c)) shade = (((fl & 0x10) ? this.obp1 : this.obp0) >> (sc * 2)) & 3;
            break;
          }
        }
        outIdx[base + x] = shade;
        out[base + x] = sh[shade];
      }
      this.px = x;
    }
  }

  // CGB の描画(_renderTo の CGB 版)
  GbPpu.prototype._renderToCgb = function (x1) {
    let x = this.px;
    const y = this.line, lcdc = this.lcdc, vram = this.vram, oam = this.oam, colors = this.colors;
    const out = this.frame, outIdx = this.frameIdx, base = y * W;
    const master = (lcdc & 0x01) !== 0, signedTiles = !(lcdc & 0x10);
    const winOk = (lcdc & 0x20) && this.wyHit && this.wx <= 166, wx0 = this.wx - 7;
    const bgMap = (lcdc & 0x08) ? 0x1C00 : 0x1800, winMap = (lcdc & 0x40) ? 0x1C00 : 0x1800;
    const yy = (y + this.scy) & 0xFF, bgRow = bgMap + (yy >> 3) * 32, scx = this.scx;
    const wl = this.winLine, winRow = winMap + (wl >> 3) * 32;
    const sprOn = (lcdc & 0x02) !== 0, n = this.sprCount, list = this.sprList, h = (lcdc & 0x04) ? 16 : 8;
    for (; x < x1; x++) {
      if (winOk && !this.winActive && x >= wx0) { this.winActive = true; this.winX = x - wx0; }
      let mi, pxl, fy;
      if (this.winActive && (lcdc & 0x20)) { const wxp = this.winX++; mi = winRow + ((wxp >> 3) & 31); pxl = wxp & 7; fy = wl & 7; }
      else { const xx = (x + scx) & 0xFF; mi = bgRow + (xx >> 3); pxl = xx & 7; fy = yy & 7; }
      const t = vram[mi], at = vram[0x2000 + mi];
      const a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + ((at & 0x40) ? 7 - fy : fy) * 2 + ((at & 0x08) ? 0x2000 : 0);
      const bit = (at & 0x20) ? pxl : 7 - pxl;
      const c = (((vram[a + 1] >> bit) & 1) << 1) | ((vram[a] >> bit) & 1);
      let entry = (at & 7) * 4 + c;
      if (sprOn) {
        for (let i = 0; i < n; i++) {
          const o = list[i] * 4, sx = oam[o + 1] - 8;
          if (x < sx || x >= sx + 8) continue;
          const fl = oam[o + 3];
          let ln = y - (oam[o] - 16), tile = oam[o + 2];
          if (fl & 0x40) ln = h - 1 - ln;
          if (h === 16) tile &= 0xFE;
          const sa = tile * 16 + ln * 2 + ((fl & 0x08) ? 0x2000 : 0), sb = (fl & 0x20) ? x - sx : 7 - (x - sx);
          const sc = (((vram[sa + 1] >> sb) & 1) << 1) | ((vram[sa] >> sb) & 1);
          if (!sc) continue;
          // LCDC bit0=0 ならスプライトが常に前。そうでなければ BG の色 0 か、BG 属性とスプライトの両方が「前」を譲っている時だけ
          if (!master || !c || (!(at & 0x80) && !(fl & 0x80))) entry = 32 + (fl & 7) * 4 + sc;
          break;
        }
      }
      outIdx[base + x] = entry;
      out[base + x] = colors[entry];
    }
    this.px = x;
  };

  GbPpu.WIDTH = W; GbPpu.HEIGHT = H;
  Emu.GbPpu = GbPpu;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ポケットプリンタ(通信ポートにつなぐ感熱プリンタ)
 * MML.Emu.GbPrinter
 *
 * 本体(gbConsole.js)の serialDevice として使う: exchange(GB が送ったバイト) → プリンタが返すバイト。
 * パケット: $88 $33 命令 圧縮 長さ(下位, 上位) データ… チェックサム(下位, 上位)、続く 2 バイトの間にプリンタが $81 と状態を返す。
 *   命令 1 = 初期化、2 = 印刷(枚数、余白[上位=前/下位=後]、パレット、濃さ)、4 = 画像データ(2bpp のタイル、横 20 タイル。
 *   1 パケット最大 $280 バイト = 2 段)、$F = 状態の問い合わせ
 *   圧縮(フラグ 1): 制御バイトの bit7 が 1 なら次の 1 バイトを (下位 7bit+2) 回、0 なら続く (値+1) バイトをそのまま
 * 印刷: 溜まったタイルをパレットで階調(0=白〜3=黒)にして 1 枚の帯にする。後ろの余白が 0 の印刷は次の印刷とつながる(長い絵)ので、
 *   余白ありの印刷が来た所で 1 枚として確定し、onPrint({ width: 160, height, pixels: Uint8Array(階調) }) に渡す。
 * 状態: データあり $08 → 印刷命令の直後 $06(印刷中)→ 何度か問い合わせると $04(完了)。初期化で 0 に戻る。
 *
 * 参考: Pan Docs "Game Boy Printer"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 160;

  class GbPrinter {
    constructor() {
      this.onPrint = null;
      this.pages = [];       // 確定した絵(onPrint が無い時に溜まる)
      this.reset();
    }
    reset() {
      this.state = 0;        // 0,1 = マジック、2 = 命令、3 = 圧縮、4,5 = 長さ、6 = データ、7,8 = チェックサム、9 = $81 を返す、10 = 状態を返す
      this.cmd = 0; this.compress = 0; this.len = 0; this.got = 0; this.sum = 0; this.chk = 0;
      this.data = new Uint8Array(0x280);
      this.tiles = [];       // 溜まった画像データ(バイト列)
      this.strips = [];      // 印刷済みでまだ確定していない帯(階調の行列)
      this.status = 0;
      this.busy = 0;         // 印刷中として答える残り回数
    }

    // 1 バイトのやり取り
    exchange(b) {
      b &= 0xFF;
      switch (this.state) {
        case 0: this.state = b === 0x88 ? 1 : 0; return 0x00;
        case 1: this.state = b === 0x33 ? 2 : (b === 0x88 ? 1 : 0); return 0x00;
        case 2: this.cmd = b; this.sum = b; this.state = 3; return 0x00;
        case 3: this.compress = b & 1; this.sum += b; this.state = 4; return 0x00;
        case 4: this.len = b; this.sum += b; this.state = 5; return 0x00;
        case 5: this.len |= b << 8; this.sum += b; this.got = 0; this.state = this.len ? 6 : 7; if (this.len > this.data.length) this.data = new Uint8Array(this.len); return 0x00;
        case 6: this.data[this.got++] = b; this.sum += b; if (this.got >= this.len) this.state = 7; return 0x00;
        case 7: this.chk = b; this.state = 8; return 0x00;
        case 8: this.chk |= b << 8; this._run((this.sum & 0xFFFF) === this.chk); this.state = 9; return 0x00;
        case 9: this.state = 10; return 0x81;
        default: {
          this.state = 0;
          const st = this.status;
          if (this.busy > 0 && --this.busy === 0) this.status = (this.status & ~0x02) & ~0x08 | 0x04; // 印刷が終わった
          return st;
        }
      }
    }

    _run(sumOk) {
      if (!sumOk) { this.status |= 0x01; return; }
      this.status &= ~0x01;
      const d = this.data.subarray(0, this.len);
      switch (this.cmd) {
        case 0x01: this.tiles = []; this.status = 0; this.busy = 0; break;
        case 0x04:
          if (!this.len) break; // 空のデータ = 「これで全部」
          if (this.compress) {
            for (let i = 0; i < d.length;) {
              const c = d[i++];
              if (c & 0x80) { const v = d[i++]; for (let k = (c & 0x7F) + 2; k > 0; k--) this.tiles.push(v); }
              else { for (let k = c + 1; k > 0 && i < d.length; k--) this.tiles.push(d[i++]); }
            }
          } else for (let i = 0; i < d.length; i++) this.tiles.push(d[i]);
          this.status |= 0x08;
          break;
        case 0x02: {
          const margins = d.length > 1 ? d[1] : 0x13, pal = (d.length > 2 && d[2]) ? d[2] : 0xE4;
          if (d.length && d[0] === 0) { this._finish(); break; } // 0 枚 = 紙送りだけ
          this._strip(pal);
          this.tiles = [];
          this.status = (this.status | 0x02 | 0x08) & 0xFF; this.busy = 3;
          if (margins & 0x0F) this._finish(); // 後ろに余白がある = ここで 1 枚
          break;
        }
        default: break; // $0F: 状態だけ
      }
    }
    // 溜まったタイル(横 20 個ずつ)を階調の帯にする
    _strip(pal) {
      const rows = Math.floor(this.tiles.length / (20 * 16));
      if (!rows) return;
      const px = new Uint8Array(W * rows * 8), t = this.tiles;
      for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < 20; tx++) {
        const base = (ty * 20 + tx) * 16;
        for (let y = 0; y < 8; y++) {
          const lo = t[base + y * 2], hi = t[base + y * 2 + 1];
          for (let x = 0; x < 8; x++) {
            const c = (((hi >> (7 - x)) & 1) << 1) | ((lo >> (7 - x)) & 1);
            px[(ty * 8 + y) * W + tx * 8 + x] = (pal >> (c * 2)) & 3;
          }
        }
      }
      this.strips.push(px);
    }
    // 帯をつないで 1 枚にして渡す
    _finish() {
      if (!this.strips.length) return;
      const total = this.strips.reduce((n, s) => n + s.length, 0);
      const pixels = new Uint8Array(total);
      let o = 0; for (const s of this.strips) { pixels.set(s, o); o += s.length; }
      this.strips = [];
      const page = { width: W, height: total / W, pixels };
      if (this.onPrint) this.onPrint(page); else this.pages.push(page);
    }
    // つながる印刷の途中で止まっている帯があれば確定する(ゲームを閉じる時など)
    flush() { this._finish(); }
  }

  Emu.GbPrinter = GbPrinter;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * バーコードボーイ(通信ポートにつなぐバーコードリーダー、1992 年、対応ソフト 5 本)
 * MML.Emu.GbBarcodeBoy
 *
 * 1. ゲームが内部クロックで $10 $07 $10 $07 を送る。リーダーは $FF $FF $10 $07 を返す(後ろの 2 つが合えば「つながっている」)
 * 2. その後ゲームは外部クロックで待つ。カードを通すとリーダーの側がクロックを出して 30 バイト送る:
 *    $02、EAN-13 の 13 桁(ASCII)、$03 を 2 回
 * 3. 送り終わるとまた 1 の握手から
 *
 * exchange(b): ゲームが内部クロックで送った 1 バイトへの返事。握手に関係ないバイトは null(呼び出し側が他の機器=プリンタへ回す)
 * pull(): ゲームが外部クロックで待っている時に本体が呼ぶ。送るバイトがあればそれ、無ければ −1
 * scan(digits): 13 桁(JAN/EAN-13)を読ませる。握手が済んでいる時だけ受け付ける
 *
 * 参考: Shonumi "Dan Docs" の Barcode Boy の章。実機の送る間隔は分からないので、本体の都合の速さ(約 2ms に 1 バイト)で送る
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const HELLO = [0x10, 0x07, 0x10, 0x07], REPLY = [0xFF, 0xFF, 0x10, 0x07];

  class GbBarcodeBoy {
    constructor() { this.reset(); }
    reset() { this.pos = 0; this.armed = false; this.queue = []; }
    exchange(b) {
      if (b === HELLO[this.pos]) { const r = REPLY[this.pos]; if (++this.pos === 4) { this.pos = 0; this.armed = true; } return r; }
      if (this.pos > 0) { this.pos = b === HELLO[0] ? 1 : 0; return b === HELLO[0] ? REPLY[0] : 0xFF; }
      return this.armed ? 0xFF : null; // 握手の後、ゲームが自分のクロックで送ってきた物には $FF
    }
    pull() {
      if (!this.queue.length) return -1;
      const b = this.queue.shift();
      if (!this.queue.length) this.armed = false; // 送り終わったら握手からやり直し
      return b;
    }
    scan(digits) {
      const s = String(digits || '').replace(/\D/g, '');
      if (s.length !== 13 || !this.armed || this.queue.length) return false;
      const part = [0x02]; for (let i = 0; i < 13; i++) part.push(s.charCodeAt(i)); part.push(0x03);
      this.queue = part.concat(part);
      return true;
    }
    // EAN-13 の検査数字が合っているか(入力の確認用)
    static checkEan13(digits) {
      const s = String(digits || '').replace(/\D/g, '');
      if (s.length !== 13) return false;
      let sum = 0; for (let i = 0; i < 12; i++) sum += (s.charCodeAt(i) - 48) * (i % 2 ? 3 : 1);
      return (10 - sum % 10) % 10 === s.charCodeAt(12) - 48;
    }
  }

  Emu.GbBarcodeBoy = GbBarcodeBoy;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ゲームボーイ本体(段階 8a: DMG の骨格)
 * MML.Emu.GbConsole
 *
 * CPU(cpuSm83.js)がバスに触るたび(1 M サイクル)に tick() で本体を 4T 進める。進むのは
 * タイマ(DIV/TIMA)、シリアル、OAM DMA、PPU、APU、音の標本化。NesConsole/MsxConsole と同じ形の API を持つ
 * (runFrame / runSamples / setController / startRecording / getBattery …)。
 *
 * CGB(段階 8d): 倍速(KEY1+STOP。CPU/タイマ/シリアル/OAM DMA は CPU の速さ、PPU と APU は元の速さのまま)、VRAM 2 バンク、WRAM 8 バンク、
 *   HDMA(一括/HBlank ごと)、パレット、赤外線ポート(受光なし)、PCM12/34。機種は opts.model('dmg' / 'cgb' / 'auto'=カートリッジのヘッダで決める)。
 * まだ無い物(DESIGN-GB-CAPTURE.md §9): 
 * CGB(8d)、周辺と残りの MBC(8e)、SGB(8g)。ブート ROM は使わず起動後の状態を直接セットする。
 *
 * 参考: Pan Docs "Timer obscure behaviour" "Interrupts" "Power-Up Sequence"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CLOCK = 4194304;
  const FRAME_T = 70224; // 154 行 × 456T(59.7275Hz)
  const AUDIO_RING = 1 << 14;
  // TAC の下位 2bit → TIMA を進める DIV(16bit)のビット。そのビットと許可の AND の立ち下がりで +1
  const TAC_BIT = [1 << 9, 1 << 3, 1 << 5, 1 << 7];
  const SERIAL_BIT = 1 << 8; // 内部クロック 8192Hz = DIV bit8 の立ち下がり
  // HuC3 のブザー: 音の番号 0-3 の高さと 1 回の長さ。★実機の値は分からない(推定の仮の値)。分かったらここだけ直す
  const BUZZ_HZ = [2048, 2560, 3072, 4096], BUZZ_SEC = 0.2, BUZZ_LEVEL = 0.06;
  const APU_BIT = 1 << 12;   // APU のフレームシーケンサ 512Hz = DIV bit12 の立ち下がり(CGB の倍速時は bit13。this.apuBit)

  class GbConsole {
    // opts.model: 'dmg'(既定)/ 'cgb' / 'auto'(カートリッジがカラー対応なら cgb)。'sgb' は後の段階
    constructor(romBytes, opts) {
      opts = opts || {};
      // opts.cart: 出来合いのカートリッジを挿す(GBS プレイヤーが使う)。opts.lcdAlwaysOn / opts.noRender も GBS 用
      this.cart = opts.cart || new Emu.GbCart(romBytes);
      this.model = opts.model === 'auto' ? (this.cart.header.cgb ? 'cgb' : 'dmg') : (opts.model || 'dmg');
      this.cgb = this.model === 'cgb';
      this.lcdAlwaysOn = !!opts.lcdAlwaysOn;
      this.ppu = new Emu.GbPpu(this);
      this.ppu.cgb = this.cgb;
      this.ppu.noRender = !!opts.noRender;
      this.apu = new Emu.APUGb(this.model === 'cgb' ? 'cgb' : 'dmg');
      this.apu.externalSeq = true;
      this.apuBit = APU_BIT;
      this.apu.divBit = () => (this.div & this.apuBit) !== 0;
      this.cpu = new Emu.CPUSm83(this);
      this.wram = new Uint8Array(0x8000); // 4K × 8 バンク(DMG は 0 と 1 だけ使う)
      this.hram = new Uint8Array(0x7F);
      // パッドは NesConsole と同じ形(配列の [0] だけ使う。巻き戻し NesRewind/GbRewind が pad[0]/pad[1] を記録する)
      this.pad = [0, 0]; this.padHeld = [0, 0]; this.padTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.cpuCycles = 0; this.frameCount = 0; this.frameT = 0; this._frameFlag = false;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringR = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0; this.underruns = 0;
      this.onWrite = null;  // (addr, value, frameFrac) 音源レジスタの書き込み
      this.onFrame = null;
      this.onSerial = null; // (byte) シリアルへ 1 バイト送り終えた(テスト ROM の結果表示など)
      this.serialDevice = null; // (byte) => 受け取るバイト。未接続は $FF
      // 通信ポートのポケットプリンタ(opts.printer === false で外す)。刷り上がった絵は prints に溜まる(画面側が takePrints で取る)
      this.prints = [];
      this.printer = opts.printer === false || !Emu.GbPrinter ? null : new Emu.GbPrinter();
      if (this.printer) this.printer.onPrint = (page) => { this.prints.push(page); };
      // バーコードボーイも同じ口に。ゲームが送る最初のバイトで見分かれる(握手 $10 $07… はバーコードボーイ、$88 $33… はプリンタ)
      this.barcode = opts.barcode === false || !Emu.GbBarcodeBoy ? null : new Emu.GbBarcodeBoy();
      if (this.printer || this.barcode) this.serialDevice = (b) => { const r = this.barcode ? this.barcode.exchange(b) : null; return r !== null ? r : (this.printer ? this.printer.exchange(b) : 0xFF); };
      // カートリッジ内ブザー(HuC3)。音の高さと長さは資料が無く仮の値(BUZZ_HZ / BUZZ_SEC)。録音には「鳴らした時刻と音の番号」を載せる
      this.bzLeft = 0; this.bzPhase = 0; this.bzStep = 0;
      this.irIn = false; // 赤外線の受光(CGB 本体のポートと HuC1 のカートリッジ。画面側が setLight で入れる)
      this.serialOut = [];  // 送り終えたバイト
      this.serialSent = []; // 送り始めたバイト(完了を待たずに次を送るソフトの出力も拾える。mooneye のテスト ROM の合否)
      this.rec = null;
      // スーパーゲームボーイ: opts.sgb = ICD2(snes/icd2.js。パッドの線と LCD の行を横取りする)、opts.bootRom = ブート ROM 256 バイト(任意)
      this.sgb = opts.sgb || null;
      this.clockHz = CLOCK; // 音の標本化に使う時計。スーパーゲームボーイ(初代)は 4295454Hz で動くので ICD2 が入れ直す
      this.bootImage = opts.bootRom || null; this.bootRom = null;
      this.reset();
    }

    // 電源投入+ブート ROM 実行後の状態(DMG)
    reset() {
      this.wram.fill(0); this.hram.fill(0);
      this.cart.reset(); this.ppu.reset(); this.apu.reset();
      const cpu = this.cpu;
      cpu.reset();
      cpu.a = 0x01; cpu.f = 0xB0; cpu.b = 0x00; cpu.c = 0x13; cpu.d = 0x00; cpu.e = 0xD8; cpu.h = 0x01; cpu.l = 0x4D;
      if (this.cgb) { cpu.a = 0x11; cpu.f = 0x80; cpu.b = 0x00; cpu.c = 0x00; cpu.d = 0xFF; cpu.e = 0x56; cpu.h = 0x00; cpu.l = 0x0D; }
      cpu.sp = 0xFFFE; cpu.pc = 0x0100;
      this.bootRom = this.bootImage;
      // CGB のレジスタ
      this.stepT = 4;          // CPU の 1 M サイクルが元のクロックで何 T か(倍速なら 2)
      this.apuBit = APU_BIT;
      this.key1 = 0; this.doubleSpeed = false; this.svbk = 1; this.rp = 0;
      this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaLeft = 0; this.hdmaActive = false; this.hdmaDue = false; this.hdmaReg = [0xFF, 0xFF, 0xFF, 0xFF];
      this.undoc = [0, 0, 0, 0]; // $FF72-$FF75
      this.ie = 0; this.if = 0x01;
      this.div = this.cgb ? 0x2674 : 0xABC8; // CGB の値は mooneye の boot_div-cgbABCDE を総当たりして決めた(白黒ソフトを CGB で起動した時の値。カラー対応ソフトでも同じとみなす=推定) this.tima = 0; this.tma = 0; this.tac = 0; this.timaReload = false; this.timaReloading = false;
      this.p1 = 0x00; this.sb = 0; this.sc = 0; this.serialBits = 0;
      // タイマ。ここで 0 を入れておかないと、TMA を一度も書かないソフトで TIMA が NaN→0 のままあふれ続ける(実ソフトの総当たりで見つけた)
      this.tima = 0; this.tma = 0; this.tac = 0; this.timaReload = false; this.timaReloading = false;
      this.dma = 0xFF; this.dmaActive = false; this.dmaPos = 0; this.dmaSrc = 0; this.dmaStart = 0; this.dmaNext = 0; this.dmaByte = 0xFF;
      // ブート ROM が「ポーン」を鳴らした後のレジスタ。CH1 は鳴り終わりかけで有効のまま(NR52=$F1)。
      // 残響の音量は分からないので 0 にしておく(起動直後に余韻は鳴らさない)
      const apu = this.apu;
      for (const [a, v] of [[0xFF26, 0x80], [0xFF10, 0x80], [0xFF11, 0xBF], [0xFF12, 0xF3], [0xFF13, 0xC1], [0xFF14, 0x87], [0xFF16, 0x3F], [0xFF18, 0xFF],
        [0xFF1A, 0x7F], [0xFF1B, 0xFF], [0xFF1C, 0x9F], [0xFF1D, 0xFF], [0xFF20, 0xFF], [0xFF24, 0x77], [0xFF25, 0xF3]]) apu.writeRegister(a, v);
      apu.ch1.envelope.volume = 0; apu.ch1.envelope.running = false;
      apu.regRaw[0x03] = 0xFF; apu.ch1.triggerSeq = 0;
      this.cpuCycles = 0; this.frameT = 0;
      if (this.bootRom) { // ブート ROM を $0000 から実行する(LCD は消えた状態から。$FF50 に書くとカートリッジに切り替わる)
        cpu.a = 0; cpu.f = 0; cpu.b = 0; cpu.c = 0; cpu.d = 0; cpu.e = 0; cpu.h = 0; cpu.l = 0; cpu.sp = 0; cpu.pc = 0;
        this.ppu.writeReg(0xFF40, 0x00); this.if = 0; this.div = 0;
      }
    }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; if (sr) this.apu.setSampleRate(sr); }
    // ボタンのビットは NesConsole.BUTTON と同じ並び(A B SELECT START UP DOWN LEFT RIGHT)。画面側の入力をそのまま使える
    setController(port, bits, turbo) { if (port) return; this.padHeld[0] = bits & 0xFF; this.padTurbo[0] = (turbo | 0) & 0xFF; this._applyPad(0); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(0); }
    _applyPad(port) {
      if (port) return;
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      const before = this._p1Low();
      this.pad[0] = this.padHeld[0] | (on ? this.padTurbo[0] : 0);
      if (before & ~this._p1Low() & 0x0F) this.requestIrq(4); // 選ばれている線が H→L
    }
    // P1 の下位 4bit(押すと 0)。bit4=0 で十字(右左上下)、bit5=0 でボタン(A B SELECT START)
    _p1Low() {
      if (this.sgb) return this.sgb.p1Low(this.p1);
      const p = this.pad[0];
      let low = 0x0F;
      if (!(this.p1 & 0x10)) low &= ~(((p >> 7) & 1) | (((p >> 6) & 1) << 1) | (((p >> 4) & 1) << 2) | (((p >> 5) & 1) << 3));
      if (!(this.p1 & 0x20)) low &= ~(p & 0x0F);
      return low & 0x0F;
    }

    get hasBattery() { return this.cart.hasBattery; }
    get batteryDirty() { return this.cart.dirty; }
    clearBatteryDirty() { this.cart.dirty = false; }
    getBattery() { return this.cart.getBattery(); }
    setBattery(bytes) { return this.cart.setBattery(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    get frame() { return this.ppu.frame; }
    get frameWidth() { return 160; }
    get frameHeight() { return 144; }
    get frameRate() { return CLOCK / FRAME_T; } // 59.7275Hz
    get stereo() { return true; }
    // ── 周辺の入出力(段階 8e)──
    // 傾き(MBC7): −1〜+1、右/下が正、1 = 重力 1 個ぶん
    setTilt(x, y) { this.cart.tiltX = +x || 0; this.cart.tiltY = +y || 0; }
    get hasTilt() { return !!this.cart.hasTilt; }
    // 赤外線の受光(押している間 true)
    setLight(on) { this.irIn = !!on; this.cart.irIn = !!on; }
    // ゲームが今、赤外線を読もうとしているか(画面側が受光ボタンを出す目安)
    get irWanted() { return !!(this.cart.hasIr && this.cart.irMode) || (this.cgb && (this.rp & 0xC0) === 0xC0); }
    // 振動モータ(MBC5 の振動つき)
    get rumble() { return !!this.cart.rumble; }
    takePrints() { return this.prints.length ? this.prints.splice(0) : null; }
    // ポケットカメラ: 元の絵(128×112、0〜255 の明るさ)を入れる。cameraWanted はゲームが撮影を始めたか(画面側が Web カメラを動かす目安)
    setCameraImage(u8) { if (this.cart.hasCamera) this.cart.camImage = u8; }
    get cameraWanted() { return !!(this.cart.hasCamera && this.cart.cam && this.cart.cam.shots > 0); }
    // バーコードボーイ: ゲームが握手を済ませて読み取りを待っているか/13 桁を読ませる
    get barcodeWanted() { return !!(this.barcode && this.barcode.armed && !this.barcode.queue.length); }
    scanBarcode(digits) { return !!(this.barcode && this.barcode.scan(digits)); }
    _buzz(tones) {
      for (const tone of tones) {
        if (this.rec) this.rec.cur.push({ buzz: tone & 3, t: this.frameT });
        this.bzLeft = Math.round(BUZZ_SEC * (this.sampleRate || 44100)); this.bzPhase = 0; this.bzStep = BUZZ_HZ[tone & 3] / (this.sampleRate || 44100);
      }
    }
    // ゲーム画面(nesScreen.js / nes-worklet-impl.js)が機種を問わず呼ぶ口
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['gb']; }
    // 鍵盤表示のミュート/音量: { gb: { ch1..ch4 } }
    applyMix(mute, volume) {
      const put = (t, s, conv) => { if (s) for (const k of Object.keys(t)) if (s[k] !== undefined) t[k] = conv(s[k]); };
      if (mute && mute.gb) put(this.apu.mute, mute.gb, (v) => !!v);
      if (volume && volume.gb) put(this.apu.vol, volume.gb, (v) => Math.max(0, Math.min(2, +v || 0)));
    }
    frameFrac() { return Math.min(0.999999, this.frameT / FRAME_T); }

    // ── 割り込み(CPU から呼ばれる)──
    requestIrq(bit) { this.if |= 1 << bit; }
    irqPending() { return this.ie & this.if & 0x1F; }
    irqAck(bit) { this.if &= ~(1 << bit); }
    // STOP: CGB で KEY1 bit0 が立っていれば速度切り替え(DIV は 0 に戻る)。それ以外はボタンが押されるまで止まる
    stop(cpu) {
      if (this.cgb && (this.key1 & 1)) {
        this.key1 = 0;
        this.doubleSpeed = !this.doubleSpeed;
        this.stepT = this.doubleSpeed ? 2 : 4;
        this.apuBit = this.doubleSpeed ? APU_BIT << 1 : APU_BIT;
        this._setDiv(0);
        return;
      }
      cpu.stopped = true;
    }
    // WRAM の番地 → 配列の位置($C000-$CFFF はバンク 0、$D000-$DFFF は SVBK のバンク。$E000 台は写し)
    _w(addr) { const a = addr & 0x1FFF; return a < 0x1000 ? a : (this.svbk << 12) | (a & 0xFFF); }
    // HDMA の 1 ブロック(16 バイト)を VRAM へ
    _hdmaBlock() {
      const ppu = this.ppu;
      for (let i = 0; i < 16; i++) { ppu.vram[ppu.vbk * 0x2000 + (this.hdmaDst & 0x1FFF)] = this._busRead(this.hdmaSrc & 0xFFFF); this.hdmaSrc++; this.hdmaDst++; }
      this.hdmaLeft--;
      const stall = this.doubleSpeed ? 16 : 8; // 1 ブロックは元のクロックで 32T。その間 CPU は止まる
      for (let i = 0; i < stall; i++) this.tick();
    }
    hblank() { if (this.hdmaActive) this.hdmaDue = true; } // PPU がモード 0 に入った

    // ── CPU の 1 M サイクルぶん進める(元のクロックで 4T。CGB の倍速なら 2T)──
    tick() {
      const st = this.stepT;
      this.cpuCycles += st;
      // TIMA があふれた 1 M サイクル後に TMA を読み込んで割り込む(その間 TIMA は 0)
      this.timaReloading = false;
      if (this.timaReload) { this.timaReload = false; this.timaReloading = true; this.tima = this.tma; this.if |= 4; }
      this._setDiv((this.div + 4) & 0xFFFF);

      // OAM DMA: $FF46 に書いた M サイクルの 2 つ後から 160 サイクル、1 サイクルに 1 バイト。
      // 走っている最中に書き直すと、古い方は新しい方が始まる直前まで続く
      if (this.dmaActive && this.dmaPos >= 0xA0) this.dmaActive = false;
      if (this.dmaStart > 0 && --this.dmaStart === 0) { this.dmaActive = true; this.dmaPos = 0; this.dmaSrc = this.dmaNext; }
      if (this.dmaActive) {
        this.dmaByte = this._busRead((this.dmaSrc + this.dmaPos) & 0xFFFF);
        this.ppu.oam[this.dmaPos++] = this.dmaByte;
      }

      const ppu = this.ppu;
      ppu.tick(st);
      const apu = this.apu;
      apu.advance(st);

      this.frameT += st;
      // フレームの区切りは VBlank の頭。LCD が消えている間は 70224T ごとに刻む(音と録音の時間を止めない)
      if (ppu.vblankStarted) { ppu.vblankStarted = false; this._frameEnd(); }
      else if (this.frameT >= FRAME_T && !ppu.on) this._frameEnd();

      const sr = this.sampleRate;
      if (sr) {
        this.cycleAccum += sr * st;
        if (this.cycleAccum >= this.clockHz) {
          this.cycleAccum -= this.clockHz;
          if (this.ringLen < AUDIO_RING) {
            const s = apu.mixSample();
            const i = (this.ringHead + this.ringLen) & (AUDIO_RING - 1);
            let bz = 0;
            if (this.bzLeft > 0) { this.bzLeft--; this.bzPhase += this.bzStep; if (this.bzPhase >= 1) this.bzPhase -= 1; bz = this.bzPhase < 0.5 ? BUZZ_LEVEL : -BUZZ_LEVEL; }
            this.ring[i] = s.left + bz; this.ringR[i] = s.right + bz;
            this.ringLen++;
          }
        }
      }
    }

    // DIV(16bit)を書き換える。TIMA とシリアルは DIV のビットの立ち下がりで進むので、DIV への書き込み(0 に戻る)でも進み得る
    _setDiv(nv) {
      const old = this.div;
      this.div = nv;
      if (this.tac & 4) { const b = TAC_BIT[this.tac & 3]; if ((old & b) && !(nv & b)) this._incTima(); }
      if ((old & this.apuBit) && !(nv & this.apuBit)) {
        this.apu.seqTick();
        // 外部クロックで待っているゲームへ、つないだ機器(バーコードボーイ)の側から 1 バイト送る(512Hz に 1 回見る)
        if ((this.sc & 0x81) === 0x80 && this.barcode) { const b = this.barcode.pull(); if (b >= 0) { this.sb = b; this.sc &= 0x7F; this.if |= 8; } }
      }
      const sbit = (this.sc & 2) ? 1 << 3 : SERIAL_BIT; // CGB の高速クロック(SC bit1)
      if (this.serialBits && (old & sbit) && !(nv & sbit)) {
        if (--this.serialBits === 0) {
          const out = this.sb;
          this.sb = this.serialDevice ? (this.serialDevice(out) & 0xFF) : 0xFF;
          this.sc &= 0x7F; this.if |= 8;
          this.serialOut.push(out);
          if (this.onSerial) this.onSerial(out);
        }
      }
    }
    _incTima() {
      this.tima = (this.tima + 1) & 0xFF;
      if (this.tima === 0) this.timaReload = true;
    }

    _frameEnd() {
      this.cart.tickRtc(this.frameT, CLOCK);
      this.frameCount++;
      this._frameFlag = true;
      if (this.padTurbo[0] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(0); }
      if (this.rec) { this.rec.cur.len = this.frameT; this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      this.frameT = 0;
      if (this.onFrame) this.onFrame();
    }

    // ── バス(CPU から。tick は CPU 側が先に呼んでいる)──
    read(addr) {
      if (this.dmaActive && addr < 0xFF00) {
        // OAM DMA の間: OAM は $FF。DMA の読み元と同じバス(外部バス=ROM/カートリッジ RAM/WRAM、または VRAM)を読むと、
        // DMA が今運んでいるバイトが見える(DMG)。I/O と HRAM は普通に読める
        if (addr >= 0xFE00) return 0xFF;
        // バスは DMG が 2 本(外部=ROM/カートリッジ RAM/WRAM、VRAM)、CGB は WRAM が別で 3 本。
        // CGB で WRAM から運んでいる間も ROM のコードは普通に走る(倍速のソフトが HRAM の待ちを早く抜けて ROM へ戻る例があった)
        const busOf = (x) => x >= 0x8000 && x < 0xA000 ? 1 : (this.cgb && x >= 0xC000 ? 2 : 0);
        if (busOf(this.dmaSrc) === busOf(addr)) return this.dmaByte;
      }
      // モード 3 の VRAM、モード 2/3 の OAM は PPU が使っていて読めない
      if (addr >= 0x8000 && addr < 0xA000) { if (this.ppu.vramBlocked()) return 0xFF; }
      else if (addr >= 0xFE00 && addr < 0xFEA0) { if (this.ppu.oamBlocked()) return 0xFF; }
      return this._busRead(addr);
    }
    _busRead(addr) {
      if (addr < 0x8000) return this.bootRom && addr < 0x100 ? this.bootRom[addr] : this.cart.read(addr);
      if (addr < 0xA000) return this.ppu.vram[this.ppu.vbk * 0x2000 + addr - 0x8000];
      if (addr < 0xC000) return this.cart.readRam(addr);
      if (addr < 0xFE00) return this.wram[this._w(addr)]; // $E000-$FDFF は WRAM の写し
      if (addr < 0xFEA0) return this.ppu.oam[addr - 0xFE00];
      if (addr < 0xFF00) return 0x00;
      if (addr >= 0xFF80) return addr === 0xFFFF ? this.ie : this.hram[addr - 0xFF80];
      if (addr >= 0xFF10 && addr <= 0xFF3F) return this.apu.readRegister(addr);
      if (addr >= 0xFF40 && addr <= 0xFF4B) return addr === 0xFF46 ? this.dma : this.ppu.readReg(addr);
      switch (addr) {
        case 0xFF00: return 0xC0 | (this.p1 & 0x30) | this._p1Low();
        case 0xFF01: return this.sb;
        case 0xFF02: return this.sc | 0x7E;
        case 0xFF04: return this.div >> 8;
        case 0xFF05: return this.tima;
        case 0xFF06: return this.tma;
        case 0xFF07: return this.tac | 0xF8;
        case 0xFF0F: return this.if | 0xE0;
      }
      if (this.cgb) {
        const ppu = this.ppu;
        switch (addr) {
          case 0xFF4D: return (this.doubleSpeed ? 0x80 : 0) | (this.key1 & 1) | 0x7E;
          case 0xFF4F: return ppu.vbk | 0xFE;
          case 0xFF55: return this.hdmaActive ? ((this.hdmaLeft - 1) & 0x7F) : (this.hdmaLeft > 0 ? 0x80 | ((this.hdmaLeft - 1) & 0x7F) : 0xFF);
          case 0xFF56: return (this.rp & 0xC1) | 0x3C | (this.irIn && (this.rp & 0xC0) === 0xC0 ? 0 : 2); // 赤外線: 読み取りを有効にしていて光があれば bit1=0
          case 0xFF68: return ppu.bcps | 0x40;
          case 0xFF69: return ppu.bgPalRam[ppu.bcps & 0x3F];
          case 0xFF6A: return ppu.ocps | 0x40;
          case 0xFF6B: return ppu.objPalRam[ppu.ocps & 0x3F];
          case 0xFF6C: return ppu.opri | 0xFE;
          case 0xFF70: return this.svbk | 0xF8;
          case 0xFF72: return this.undoc[0];
          case 0xFF73: return this.undoc[1];
          case 0xFF74: return this.undoc[2];
          case 0xFF75: return this.undoc[3] | 0x8F;
          case 0xFF76: return this.apu.readPcm12();
          case 0xFF77: return this.apu.readPcm34();
        }
      }
      return 0xFF;
    }

    write(addr, v) {
      if (addr < 0x8000) { this.cart.write(addr, v); return; }
      if (addr < 0xA000) { if (!this.ppu.vramBlocked()) this.ppu.vram[this.ppu.vbk * 0x2000 + addr - 0x8000] = v; return; }
      if (addr < 0xC000) { this.cart.writeRam(addr, v); if (this.cart.buzzQueue && this.cart.buzzQueue.length) this._buzz(this.cart.takeBuzz()); return; } // buzzQueue: GBS 用のカートリッジには無い
      if (addr < 0xFE00) { this.wram[this._w(addr)] = v; return; }
      if (addr < 0xFEA0) { if (!this.dmaActive && !this.ppu.oamBlocked()) this.ppu.oam[addr - 0xFE00] = v; return; }
      if (addr < 0xFF00) return;
      if (addr >= 0xFF80) { if (addr === 0xFFFF) this.ie = v; else this.hram[addr - 0xFF80] = v; return; }
      if (addr >= 0xFF10 && addr <= 0xFF3F) {
        this.apu.writeRegister(addr, v);
        if (this.rec) this.rec.cur.push({ addr, value: v, t: this.frameT });
        if (this.onWrite) this.onWrite(addr, v, this.frameFrac());
        return;
      }
      if (addr >= 0xFF40 && addr <= 0xFF4B) {
        if (addr === 0xFF46) { this.dma = v; this.dmaNext = (v >= 0xE0 ? v - 0x20 : v) << 8; this.dmaStart = 2; } // $E0 以上は WRAM の写し側を読む
        else if (addr === 0xFF40 && this.lcdAlwaysOn) this.ppu.writeReg(addr, v | 0x80);
        else this.ppu.writeReg(addr, v);
        return;
      }
      switch (addr) {
        case 0xFF50: if (v & 1) this.bootRom = null; break;
        case 0xFF00: { const before = this._p1Low(); this.p1 = v & 0x30; if (this.sgb) this.sgb.joypWrite((v >> 4) & 1, (v >> 5) & 1); if (before & ~this._p1Low() & 0x0F) this.requestIrq(4); break; }
        case 0xFF01: this.sb = v; break;
        case 0xFF02:
          this.sc = v & (this.cgb ? 0x83 : 0x81);
          // 内部クロックで開始。外部クロック(bit0=0)は相手がいないので終わらない
          this.serialBits = (v & 0x81) === 0x81 ? 8 : 0;
          if (this.serialBits) { this.serialSent.push(this.sb); if (this.serialSent.length > 4096) this.serialSent.splice(0, 2048); }
          break;
        case 0xFF04: this._setDiv(0); break;
        default: if (this.cgb) this._writeCgb(addr, v); break;
        // あふれた直後のサイクルの書き込みは再読込を取り消す。再読込のサイクルの書き込みは無視される(TMA が勝つ)
        case 0xFF05: if (!this.timaReloading) { this.tima = v; this.timaReload = false; } break;
        case 0xFF06: this.tma = v; if (this.timaReloading) this.tima = v; break; // 再読込のサイクルなら新しい値がそのまま入る
        case 0xFF07: { // 許可/選択を変えた瞬間に選択ビットの AND が落ちると 1 進む
          const was = (this.tac & 4) && (this.div & TAC_BIT[this.tac & 3]);
          this.tac = v & 7;
          const now = (this.tac & 4) && (this.div & TAC_BIT[this.tac & 3]);
          if (was && !now) this._incTima();
          break;
        }
        case 0xFF0F: this.if = v & 0x1F; break;
      }
    }

    // CGB だけのレジスタ
    _writeCgb(addr, v) {
      const ppu = this.ppu;
      switch (addr) {
        case 0xFF4D: this.key1 = v & 1; break;
        case 0xFF4F: ppu.vbk = v & 1; break;
        case 0xFF51: case 0xFF52: case 0xFF53: case 0xFF54: this.hdmaReg[addr - 0xFF51] = v; break;
        case 0xFF55: {
          if (this.hdmaActive && !(v & 0x80)) { this.hdmaActive = false; break; } // HBlank ごとの転送を止める(残りは読める)
          const r = this.hdmaReg;
          this.hdmaSrc = ((r[0] << 8) | r[1]) & 0xFFF0;
          this.hdmaDst = ((r[2] << 8) | r[3]) & 0x1FF0;
          this.hdmaLeft = (v & 0x7F) + 1;
          if (v & 0x80) { this.hdmaActive = true; this.hdmaDue = false; if (!ppu.on) this._hdmaBlock(); } // HBlank ごと(LCD が消えていれば 1 ブロックはすぐ)
          else { this.hdmaActive = false; while (this.hdmaLeft > 0) this._hdmaBlock(); }                    // 一括
          break;
        }
        case 0xFF56: this.rp = v & 0xC1; break;
        case 0xFF68: ppu.bcps = v & 0xBF; break;
        case 0xFF69: ppu.writePal(0, v); break;
        case 0xFF6A: ppu.ocps = v & 0xBF; break;
        case 0xFF6B: ppu.writePal(1, v); break;
        case 0xFF6C: ppu.opri = v & 1; break;
        case 0xFF70: this.svbk = (v & 7) || 1; break;
        case 0xFF72: this.undoc[0] = v; break;
        case 0xFF73: this.undoc[1] = v; break;
        case 0xFF74: this.undoc[2] = v; break;
        case 0xFF75: this.undoc[3] = v & 0x70; break;
      }
    }

    // ── 録音(VGM への符号化は段階 8c)。書き込みの t はフレーム頭からの T、フレームの長さは frames[f].len ──
    startRecording() {
      const cur = [];
      const apu = this.apu;
      // 今のレジスタ像(NR52 を先に。OFF だと他が書けない)と波形 RAM
      cur.push({ addr: 0xFF26, value: apu.powerOn ? 0x80 : 0x00, t: 0 });
      for (let a = 0xFF10; a < 0xFF26; a++) {
        if (a === 0xFF15 || a === 0xFF1F) continue;
        let v = apu.regRaw[a - 0xFF10];
        if (a === 0xFF14 || a === 0xFF19 || a === 0xFF1E || a === 0xFF23) v &= 0x7F; // トリガは写さない(鳴り直してしまう)
        cur.push({ addr: a, value: v, t: 0 });
      }
      for (let i = 0; i < 16; i++) cur.push({ addr: 0xFF30 + i, value: apu.ch3.readWaveRam(i), t: 0 });
      this.rec = { frames: [], cur };
    }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) { rec.cur.len = this.frameT; rec.frames.push(rec.cur); }
      return rec.frames;
    }

    // ── 実行 ──
    step() {
      const cpu = this.cpu;
      if (cpu.stopped) { // STOP 中: ボタンが押されるまで時間だけ進む
        if ((this.pad[0] & 0xFF) !== 0) cpu.stopped = false;
        else { this.tick(); return 4; }
      }
      // CGB の HBlank ごとの HDMA: モード 0 に入るたびに 1 ブロック(CPU が HALT 中は運ばない)
      if (this.hdmaDue) { this.hdmaDue = false; if (this.hdmaActive && !cpu.halted) { this._hdmaBlock(); if (this.hdmaLeft <= 0) this.hdmaActive = false; } }
      return cpu.step();
    }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) { this.step(); if (++guard > 200000) break; }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    // 左右別(AudioWorklet の process)
    runSamplesStereo(outL, outR) {
      const n = outL.length;
      if (!this.sampleRate) { outL.fill(0); outR.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(outL, n, outR);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    // 音はステレオ(NR51 の左右振り分け)。outR を渡せば左右別、渡さなければ左右の平均を out へ
    takeAudioInto(out, n, outR) {
      const take = Math.min(n, this.ringLen), M = AUDIO_RING - 1, h = this.ringHead;
      if (outR) { for (let i = 0; i < take; i++) { out[i] = this.ring[(h + i) & M]; outR[i] = this.ringR[(h + i) & M]; } for (let i = take; i < n; i++) outR[i] = 0; }
      else for (let i = 0; i < take; i++) out[i] = (this.ring[(h + i) & M] + this.ringR[(h + i) & M]) * 0.5;
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & (AUDIO_RING - 1);
      this.ringLen -= take;
    }

    static describe(gb) {
      const h = gb.cart.header;
      return `${h.title || '(no title)'} [${gb.cart.mbc}${gb.cart.unsupported ? ' 未対応種別 $' + h.type.toString(16) : ''}] ROM ${gb.cart.rom.length >> 10}K RAM ${gb.cart.ram.length}` +
        `${gb.cart.hasBattery ? ' battery' : ''}${gb.cart.hasRtc ? ' rtc' : ''}${h.cgb ? (h.cgbOnly ? ' CGB専用' : ' CGB対応') : ''}${h.sgb ? ' SGB対応' : ''}${h.checksumOk ? '' : ' ヘッダ不整合'}`;
    }
  }

  GbConsole.CLOCK = CLOCK;
  GbConsole.FRAME_T = FRAME_T;
  GbConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.GbConsole = GbConsole;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ゲームボーイ本体のステート(状態の保存・復元)と巻き戻し
 * MML.Emu.GbState / MML.Emu.GbRewind
 *
 * どちらも NES の物(nes/nesState.js の StateTree、nes/nesRewind.js)をそのまま使う:
 *   - ステート: 本体(GbConsole)のオブジェクト木を汎用に写す。除外は ROM、録音、音のリング、画面、コールバック、シリアルの記録
 *   - 巻き戻し: 0.5 秒ごとのステート+毎フレームのパッド値。逆再生の映像は ppu.frameIdx(階調番号 8bit、160×144)
 * 形: { v: 1, machine: 'gb', title, romLen, tree }
 * MBC6 のフラッシュ(1MB)はステート/巻き戻しに入れない(大きすぎる。フラッシュへ書いた後に巻き戻すと中身は戻らない)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SKIP_KEYS = new Set(['rom', 'rec', 'ring', 'ringR', 'frame', 'frameIdx', 'onFrame', 'onWrite', 'onSerial', 'serialDevice',
    'serialOut', 'serialSent', 'bus', 'divBit', 'con', 'shades', 'palRing', 'prints', 'onPrint', 'pages', 'camImage', 'flash', 'x', 'buzzQueue', 'lineIdx', 'claimed', '_out', 'header', 'data', 'low']);

  const GbState = {
    save(gb) {
      const T = Emu.StateTree;
      return { v: 1, machine: 'gb', title: gb.cart.header.title || '', romLen: gb.cart.rom.length, tree: T.snapshot(gb, [gb.cart.rom], SKIP_KEYS) };
    },
    // 同じ ROM で作ったステートを書き戻す。合わなければ false
    load(gb, state) {
      if (!state || state.v !== 1 || state.machine !== 'gb' || !state.tree) return false;
      if (state.romLen !== gb.cart.rom.length || state.title !== (gb.cart.header.title || '')) return false;
      const rec = gb.rec;
      Emu.StateTree.restore(gb, state.tree);
      gb.rec = rec;                      // 録音中ならそのまま続ける
      gb.ringHead = 0; gb.ringLen = 0;   // 音のリングは捨てる
      gb._frameFlag = false;
      gb.cart._map();                    // バンクの参照位置を作り直す
      return true;
    },
  };

  // 逆再生の色: 階調番号 → 色(ppu.shades)。nesScreen.js の blitIndex / Worklet の rwframe が palette として使う
  class GbRewind extends (Emu.NesRewind || class {}) {
    constructor(gb) {
      super(gb, { State: GbState, frameBytes: 160 * 144 });
      this.idxWidth = 160;
    }
    // DMG は階調 4 色、CGB はパレット 64 色(BG 0-31、OBJ 32-63)
    get palette() { const p = new Uint32Array(256), ppu = this.nes.ppu; if (ppu.cgb) p.set(ppu.colors); else for (let i = 0; i < ppu.shades.length; i++) p[i] = ppu.shades[i]; return p; }
    // CGB はフレームごとに色表も控える(逆再生の画面をその時の色で出す。行の途中の色替えまでは追わない)
    _capture(f) {
      super._capture(f);
      const ppu = this.nes.ppu;
      if (!ppu.cgb) return;
      const RING = Emu.NesRewind.RING;
      if (!this.palRing) this.palRing = new Uint32Array(RING * 64);
      this.palRing.set(ppu.colors, (f % RING) * 64);
    }
    paletteOf(f) {
      const RING = Emu.NesRewind.RING;
      if (!this.palRing || this.ringFrame[f % RING] !== f) return this.palette;
      const p = new Uint32Array(256); p.set(this.palRing.subarray((f % RING) * 64, (f % RING) * 64 + 64)); return p;
    }
  }

  Emu.GbState = GbState;
  Emu.GbRewind = GbRewind;
})(typeof window !== 'undefined' ? window : globalThis);

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
                       |((ya^r)&(m^r)&0x8000?0x40:0)|(h>0xFFF?0x08:0)|((r&0xFFFF)===0?0x02:0)|(r>0xFFFF?0x01:0);
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
  // ★2026-09-07 σ=0.63 のガウス関数から合成した近似表(実機との最大差20、8kHzで0.14dB差)を、
  // 実機DSPのROM表そのもの(blargg snes_spc / snes9x SPC_DSP.cpp の gauss[512]、fullsnes と同一)へ
  // 差し替えた。鍵盤表示の「ガウス補間」の図と実出力を実機どおりにするため。
  const GAUSS = new Int16Array([
       0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,
       1,   1,   1,   1,   1,   1,   1,   1,   1,   1,   1,   2,   2,   2,   2,   2,
       2,   2,   3,   3,   3,   3,   3,   4,   4,   4,   4,   4,   5,   5,   5,   5,
       6,   6,   6,   6,   7,   7,   7,   8,   8,   8,   9,   9,   9,  10,  10,  10,
      11,  11,  11,  12,  12,  13,  13,  14,  14,  15,  15,  15,  16,  16,  17,  17,
      18,  19,  19,  20,  20,  21,  21,  22,  23,  23,  24,  24,  25,  26,  27,  27,
      28,  29,  29,  30,  31,  32,  32,  33,  34,  35,  36,  36,  37,  38,  39,  40,
      41,  42,  43,  44,  45,  46,  47,  48,  49,  50,  51,  52,  53,  54,  55,  56,
      58,  59,  60,  61,  62,  64,  65,  66,  67,  69,  70,  71,  73,  74,  76,  77,
      78,  80,  81,  83,  84,  86,  87,  89,  90,  92,  94,  95,  97,  99, 100, 102,
     104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132,
     134, 137, 139, 141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168,
     171, 173, 175, 178, 180, 183, 186, 188, 191, 193, 196, 199, 201, 204, 207, 210,
     212, 215, 218, 221, 224, 227, 230, 233, 236, 239, 242, 245, 248, 251, 254, 257,
     260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297, 300, 304, 307, 311,
     314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366, 370,
     374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434,
     439, 443, 447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504,
     508, 513, 517, 522, 527, 531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577,
     582, 587, 592, 596, 601, 606, 611, 615, 620, 625, 630, 635, 640, 644, 649, 654,
     659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708, 713, 718, 723, 728, 732,
     737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802, 806, 811,
     816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889,
     894, 899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965,
     969, 974, 978, 983, 988, 992, 997,1001,1005,1010,1014,1019,1023,1027,1032,1036,
    1040,1045,1049,1053,1057,1061,1066,1070,1074,1078,1082,1086,1090,1094,1098,1102,
    1106,1109,1113,1117,1121,1125,1128,1132,1136,1139,1143,1146,1150,1153,1157,1160,
    1164,1167,1170,1174,1177,1180,1183,1186,1190,1193,1196,1199,1202,1205,1207,1210,
    1213,1216,1219,1221,1224,1227,1229,1232,1234,1237,1239,1241,1244,1246,1248,1251,
    1253,1255,1257,1259,1261,1263,1265,1267,1269,1270,1272,1274,1275,1277,1279,1280,
    1282,1283,1284,1286,1287,1288,1290,1291,1292,1293,1294,1295,1296,1297,1297,1298,
    1299,1300,1300,1301,1302,1302,1303,1303,1303,1304,1304,1304,1304,1304,1305,1305,
  ]);

  // ── ガウス補間(実機の演算順そのまま) ──────────────────────────────
  // buf: brrBuf(履歴4+現ブロック16[+先読み])、i: sampleIdx、frac: 8bit 小数(pitchFrac>>4)。
  // タップは古い順に buf[1+i], buf[2+i], buf[3+i], buf[4+i](=サンプル i−3 … i)。
  // frac=0 のとき重みは s[i−2] を中心に対称、frac→1 で s[i−1] 中心へ移る。つまり出力は
  // 「サンプル位置 (i−2)+frac/256」の値(鍵盤表示の横軸合わせに使う)。
  // 実機は各タップを個別に >>11 し、3タップ目までの和を16bitに折り返してから4タップ目を
  // 足し、クランプして最下位ビットを落とす(blargg SPC_DSP.cpp 準拠。以前は合計してから
  // >>11 していたため数LSBの丸め差があり、大音量時の折り返し歪みも無かった)
  function gaussInterp(buf, i, frac) {
    let out = (GAUSS[0xFF - frac] * buf[1 + i]) >> 11;
    out += (GAUSS[0x1FF - frac] * buf[2 + i]) >> 11;
    out += (GAUSS[0x100 + frac] * buf[3 + i]) >> 11;
    out = (out << 16) >> 16;
    out += (GAUSS[frac] * buf[4 + i]) >> 11;
    return Math.max(-32768, Math.min(32767, out)) & ~1;
  }

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
      this.voiceVol = new Array(8).fill(1); // ボイスごとの音量(0〜2、既定1=100%)。鍵盤表示のch別音量バー用
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
          // カスタムモード。rate=0は実機では「周期無限=エンベロープ変化なし」(sustainの
          // sr===0と同じ扱い)。RATE_TABLE[0]=0のまま比較すると毎サンプル発火=最速減衰に
          // 化け、GAIN $A0(exp減衰,rate0)を「現レベル保持」として使うFF4等のAKAOドライバで
          // 全ボイスが数フレームで無音になっていた(2026-08-25、FF4全曲異常の真因)。
          if (rate === 0) { v.env = Math.max(0, Math.min(0x7FF, v.env)); return; }
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
      return gaussInterp(v.brrBuf, v.sampleIdx, (v.pitchFrac >> 4) & 0xFF);
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

  // ── 鍵盤表示(大波形)プレビュー用: 現ブロックのガウス補間後の連続波形と、現在ピッチでの
  // 実際の出力サンプル位置を、dsp本体と同じ式で非破壊に計算する(voice本体は変更しない)。
  //   curve[k] (k=0..16*STEPS-1): サンプル位置 p=k/STEPS(0〜16、現ブロック内)の補間値。
  //     位置 p は (i−2)+frac/256 なので i=floor(p)+2、ブロック末尾(i=16,17)は次ブロックの
  //     先頭2サンプルが要る → 次ブロックを非破壊にデコードして継ぎ足す(ループ/終端は
  //     brrAddr が既に次に読む先を指しているのでそのまま使える)
  //   points: 現在位置から DSP と同じ順(位置を進めてから補間)で出す出力サンプル。ブロックを
  //     抜けるまで(最大 maxPoints 個)。{ p: 位置(0〜16), v: 値 }
  // ★2026-09-07 以前は「48出力サンプルを現ブロック内で折り返して並べただけ」で、BRR16点と
  //   横軸が対応せず(48出力サンプルの元波形上の長さは 48×pitch/4096 で pitch 依存)、境界の先も
  //   実出力と違っていた。位置基準の曲線+出力点に改めた。
  function previewVoiceWave(voice, dsp, pitchVal, opts) {
    const STEPS = (opts && opts.steps) || 8;
    const maxPoints = (opts && opts.maxPoints) || 64;
    const ext = new Int16Array(20 + 16);
    ext.set(voice.brrBuf.subarray(0, 20), 0);
    if (dsp && voice.envMode !== 'off') {
      try {
        const res = decodeBrrBlock(dsp.origRam || dsp.ram, voice.brrAddr, voice.brrPrev1, voice.brrPrev2);
        ext.set(res.samples, 20);
      } catch (e) { /* 先読み不能なら 0 のまま */ }
    }
    const curve = new Float32Array(16 * STEPS);
    for (let k = 0; k < curve.length; k++) {
      const p = k / STEPS;
      const i = Math.floor(p) + 2;
      const frac = Math.round((p - Math.floor(p)) * 256) & 0xFF;
      curve[k] = gaussInterp(ext, i, frac);
    }
    const points = [];
    let sampleIdx = voice.sampleIdx, pitchFrac = voice.pitchFrac;
    for (let n = 0; n < maxPoints; n++) {
      pitchFrac += pitchVal;
      const steps = (pitchFrac >> 12) & 0xF;
      pitchFrac &= 0xFFF;
      const next = sampleIdx + steps;
      if (next >= 16) break;            // 次ブロックへ(実機はここでフェッチ)
      sampleIdx = next;
      const frac = (pitchFrac >> 4) & 0xFF;
      const p = (sampleIdx - 2) + frac / 256;
      // ブロック先頭2サンプル分(i=0,1)は位置が負=前ブロックの末尾に当たるので図の範囲外として省く
      if (p >= 0) points.push({ p, v: gaussInterp(ext, sampleIdx, frac) });
    }
    return { curve, points };
  }

  Emu.SpcDsp = SpcDsp;
  Emu.decodeBrrBlock = decodeBrrBlock;
  Emu.previewVoiceWave = previewVoiceWave;
  Emu.gaussInterp = gaussInterp;
  Emu.GAUSS = GAUSS;

})(globalThis);

/*
 * スーパーファミコンの PPU(段階 8g-2/8g-3 の範囲)
 * MML.Emu.SnesPpu
 *
 * スーパーゲームボーイの枠と GB 画面の表示、公開テスト ROM の結果表示に要る範囲:
 *   - レジスタ $2100-$213F(VRAM/CGRAM/OAM の読み書き、スクロール、BG の設定、表示の有効、明るさ)
 *   - 描画は行単位。BG モード 0(2bpp×4)、1(4bpp×2+2bpp)、3(8bpp+4bpp)。タイル 8×8/16×16、マップ 32/64、反転、優先
 *   - スプライト(1 行 32 個まで、大きさ 6 通り、優先 4 段)
 *   まだ無い物: 窓、色演算(サブ画面)、モザイク、モード 2/4/5/6/7、オフセットパータイル、高解像度、インターレース、
 *   スプライトの 1 行あたりのタイル数制限。SNES 本体(SNES2VGM)をやる時に足す
 *
 * 画面は 256×224(frame、0xAABBGGRR)。本体(snesConsole.js)が表示行ごとに renderLine(y) を呼ぶ。
 * 参考: fullsnes(nocash)、SNESdev Wiki "PPU registers" "Backgrounds" "Sprites"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 256, H = 224;
  const OBJ_SIZES = [[8, 16], [8, 32], [8, 64], [16, 32], [16, 64], [32, 64], [16, 32], [16, 32]];
  // モードごとの BG の色深度(0 = その BG は無い)
  const BPP = [[2, 2, 2, 2], [4, 4, 2, 0], [4, 4, 0, 0], [8, 4, 0, 0], [8, 2, 0, 0], [4, 2, 0, 0], [4, 0, 0, 0], [8, 0, 0, 0]];

  class SnesPpu {
    constructor() {
      this.vram = new Uint16Array(0x8000);
      this.cgram = new Uint16Array(256);
      this.oam = new Uint8Array(544);
      this.frame = new Uint32Array(W * H);
      this.lineZ = new Uint8Array(W);
      this.lineC = new Uint16Array(W);
      this.objC = new Uint8Array(W); this.objP = new Uint8Array(W);
      this.reset();
    }

    reset() {
      this.vram.fill(0); this.cgram.fill(0); this.oam.fill(0);
      this.forceBlank = true; this.brightness = 0;
      this.obsel = 0; this.oamAddr = 0; this.oamReload = 0; this.oamLatch = 0;
      this.bgMode = 0; this.bg3Prio = false; this.tileBig = [false, false, false, false];
      this.bgMap = [0, 0, 0, 0]; this.bgMapSize = [0, 0, 0, 0]; this.bgChar = [0, 0, 0, 0];
      this.hofs = [0, 0, 0, 0]; this.vofs = [0, 0, 0, 0]; this.bgLatch = 0; this.hLatch = 0;
      this.vmain = 0; this.vaddr = 0; this.vbuf = 0;
      this.cgAddr = 0; this.cgFlip = false; this.cgLatch = 0;
      this.tm = 0; this.ts = 0;
      this.ophct = 0; this.opvct = 0; this.opLatched = false; this.opHFlip = false; this.opVFlip = false;
      this.openBus = 0;
      this.frame.fill(0xFF000000);
    }

    // VRAM の番地の変換($2115 bit2-3)
    _vaddr() {
      const a = this.vaddr;
      switch ((this.vmain >> 2) & 3) {
        case 1: return ((a & 0xFF00) | ((a & 0x00E0) >> 5) | ((a & 0x001F) << 3)) & 0x7FFF;
        case 2: return ((a & 0xFE00) | ((a & 0x01C0) >> 6) | ((a & 0x003F) << 3)) & 0x7FFF;
        case 3: return ((a & 0xFC00) | ((a & 0x0380) >> 7) | ((a & 0x007F) << 3)) & 0x7FFF;
      }
      return a & 0x7FFF;
    }
    _vstep() { const s = this.vmain & 3; this.vaddr = (this.vaddr + (s === 0 ? 1 : s === 1 ? 32 : 128)) & 0xFFFF; }

    write(reg, v) {
      switch (reg) {
        case 0x00: this.forceBlank = (v & 0x80) !== 0; this.brightness = v & 15; break;
        case 0x01: this.obsel = v; break;
        case 0x02: this.oamReload = (this.oamReload & 0x200) | (v << 1); this.oamAddr = this.oamReload; break;
        case 0x03: this.oamReload = (this.oamReload & 0x1FE) | ((v & 1) << 9); this.oamAddr = this.oamReload; break;
        case 0x04: {
          const a = this.oamAddr;
          if (a >= 0x200) this.oam[0x200 | (a & 0x1F)] = v;
          else if (a & 1) { this.oam[a - 1] = this.oamLatch; this.oam[a] = v; }
          else this.oamLatch = v;
          this.oamAddr = (a + 1) & 0x3FF;
          break;
        }
        case 0x05: this.bgMode = v & 7; this.bg3Prio = (v & 8) !== 0; for (let i = 0; i < 4; i++) this.tileBig[i] = (v & (0x10 << i)) !== 0; break;
        case 0x07: case 0x08: case 0x09: case 0x0A: this.bgMap[reg - 7] = ((v >> 2) << 10) & 0x7FFF; this.bgMapSize[reg - 7] = v & 3; break;
        case 0x0B: this.bgChar[0] = (v & 0x0F) << 12; this.bgChar[1] = (v >> 4) << 12; break;
        case 0x0C: this.bgChar[2] = (v & 0x0F) << 12; this.bgChar[3] = (v >> 4) << 12; break;
        // スクロール: 2 回書き(下位 → 上位)。水平は前々回の下位 3bit が混ざる
        case 0x0D: case 0x0F: case 0x11: case 0x13: { const i = (reg - 0x0D) >> 1; this.hofs[i] = ((v << 8) | (this.bgLatch & ~7) | (this.hLatch & 7)) & 0x3FF; this.bgLatch = v; this.hLatch = v; break; }
        case 0x0E: case 0x10: case 0x12: case 0x14: { const i = (reg - 0x0E) >> 1; this.vofs[i] = ((v << 8) | this.bgLatch) & 0x3FF; this.bgLatch = v; break; }
        case 0x15: this.vmain = v; break;
        case 0x16: this.vaddr = (this.vaddr & 0xFF00) | v; this.vbuf = this.vram[this._vaddr()]; break;
        case 0x17: this.vaddr = (this.vaddr & 0x00FF) | (v << 8); this.vbuf = this.vram[this._vaddr()]; break;
        case 0x18: { const a = this._vaddr(); this.vram[a] = (this.vram[a] & 0xFF00) | v; if (!(this.vmain & 0x80)) this._vstep(); break; }
        case 0x19: { const a = this._vaddr(); this.vram[a] = (this.vram[a] & 0x00FF) | (v << 8); if (this.vmain & 0x80) this._vstep(); break; }
        case 0x21: this.cgAddr = v; this.cgFlip = false; break;
        case 0x22:
          if (!this.cgFlip) this.cgLatch = v;
          else { this.cgram[this.cgAddr] = ((v & 0x7F) << 8) | this.cgLatch; this.cgAddr = (this.cgAddr + 1) & 0xFF; }
          this.cgFlip = !this.cgFlip;
          break;
        case 0x2C: this.tm = v; break;
        case 0x2D: this.ts = v; break;
      }
    }

    read(reg) {
      let v;
      switch (reg) {
        case 0x38: { const a = this.oamAddr; v = a >= 0x200 ? this.oam[0x200 | (a & 0x1F)] : this.oam[a]; this.oamAddr = (a + 1) & 0x3FF; break; }
        case 0x39: v = this.vbuf & 0xFF; if (!(this.vmain & 0x80)) { this.vbuf = this.vram[this._vaddr()]; this._vstep(); } break;
        case 0x3A: v = this.vbuf >> 8; if (this.vmain & 0x80) { this.vbuf = this.vram[this._vaddr()]; this._vstep(); } break;
        case 0x3B:
          if (!this.cgFlip) v = this.cgram[this.cgAddr] & 0xFF;
          else { v = (this.cgram[this.cgAddr] >> 8) | (this.openBus & 0x80); this.cgAddr = (this.cgAddr + 1) & 0xFF; }
          this.cgFlip = !this.cgFlip;
          break;
        case 0x3C: v = this.opHFlip ? ((this.ophct >> 8) & 1) | (this.openBus & 0xFE) : this.ophct & 0xFF; this.opHFlip = !this.opHFlip; break;
        case 0x3D: v = this.opVFlip ? ((this.opvct >> 8) & 1) | (this.openBus & 0xFE) : this.opvct & 0xFF; this.opVFlip = !this.opVFlip; break;
        case 0x3E: v = 0x01; break; // STAT77: PPU1 の版
        case 0x3F: v = 0x02 | (this.opLatched ? 0x40 : 0); this.opLatched = false; this.opHFlip = false; this.opVFlip = false; break; // STAT78: NTSC、PPU2 の版
        default: return this.openBus;
      }
      this.openBus = v;
      return v;
    }
    // H/V カウンタを控える($2137 の読み出し、または $4201 bit7 の立ち下がり)
    latchCounters(h, vline) { this.ophct = h; this.opvct = vline; this.opLatched = true; }
    // VBlank の頭: OAM の番地を戻す
    vblank() { if (!this.forceBlank) this.oamAddr = this.oamReload; }

    // ── 描画 ──
    // BG 1 枚をこの行ぶん。zLow/zHigh = タイルの優先ビット 0/1 の時の深さ(大きいほど手前)
    _bgLine(bg, y, bpp, zLow, zHigh, palBase) {
      const vram = this.vram, lineZ = this.lineZ, lineC = this.lineC;
      const big = this.tileBig[bg], tsh = big ? 4 : 3;
      const size = this.bgMapSize[bg], wide = (size & 1) !== 0, tall = (size & 2) !== 0;
      const map = this.bgMap[bg], chr = this.bgChar[bg];
      const hofs = this.hofs[bg], py = (y + this.vofs[bg]) & 0x3FF;
      const ty = py >> tsh, words = bpp * 4;
      let lastTx = -1, entry = 0, p0 = 0, p1 = 0, p2 = 0, p3 = 0, zt = 0, pal = 0, hflip = false;
      for (let x = 0; x < W; x++) {
        const px = (x + hofs) & 0x3FF, tx = px >> tsh;
        if (tx !== lastTx || big) {
          lastTx = tx;
          let off = ((ty & 31) << 5) | (tx & 31);
          if (wide && (tx & 32)) off += 0x400;
          if (tall && (ty & 32)) off += wide ? 0x800 : 0x400;
          entry = vram[(map + off) & 0x7FFF];
          hflip = (entry & 0x4000) !== 0;
          const vflip = (entry & 0x8000) !== 0;
          let tile = entry & 0x3FF, row = py & 7;
          if (big) {
            const subX = ((px >> 3) & 1) ^ (hflip ? 1 : 0), subY = ((py >> 3) & 1) ^ (vflip ? 1 : 0);
            tile = (tile + subX + (subY << 4)) & 0x3FF;
          }
          if (vflip) row = 7 - row;
          const a = (chr + tile * words + row) & 0x7FFF;
          const w0 = vram[a]; p0 = w0 & 0xFF; p1 = w0 >> 8;
          if (bpp >= 4) { const w1 = vram[(a + 8) & 0x7FFF]; p2 = w1 & 0xFF; p3 = w1 >> 8; }
          if (bpp === 8) { this._w2 = vram[(a + 16) & 0x7FFF]; this._w3 = vram[(a + 24) & 0x7FFF]; }
          zt = (entry & 0x2000) ? zHigh : zLow;
          pal = (entry >> 10) & 7;
        }
        if (zt <= lineZ[x]) continue;
        const bit = hflip ? (px & 7) : 7 - (px & 7);
        let c = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
        if (bpp >= 4) c |= (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        if (bpp === 8) c |= (((this._w2 >> bit) & 1) << 4) | (((this._w2 >> (bit + 8)) & 1) << 5) | (((this._w3 >> bit) & 1) << 6) | (((this._w3 >> (bit + 8)) & 1) << 7);
        if (!c) continue;
        lineZ[x] = zt;
        lineC[x] = bpp === 8 ? c : bpp === 4 ? (pal << 4) | c : palBase + (pal << 2) + c;
      }
    }

    // スプライトをこの行ぶん objC/objP(色番号 1-15+パレット、優先)に集める
    _objLine(y) {
      const oam = this.oam, vram = this.vram, objC = this.objC, objP = this.objP;
      objC.fill(0);
      const sizes = OBJ_SIZES[this.obsel >> 5];
      const base = (this.obsel & 7) << 13, gap = (((this.obsel >> 3) & 3) + 1) << 12;
      let count = 0;
      for (let i = 0; i < 128 && count < 32; i++) {
        const o = i * 4, hb = (oam[0x200 + (i >> 2)] >> ((i & 3) * 2)) & 3;
        const size = sizes[hb >> 1];
        const sy = oam[o + 1];
        let row = (y - sy) & 0xFF;
        if (row >= size) continue;
        count++;
        let sx = oam[o] | ((hb & 1) << 8);
        if (sx >= 256) sx -= 512;
        if (sx <= -size) continue;
        const attr = oam[o + 3], tile = oam[o + 2] | ((attr & 1) << 8);
        const pal = (attr >> 1) & 7, prio = (attr >> 4) & 3, hflip = (attr & 0x40) !== 0;
        if (attr & 0x80) row = size - 1 - row;
        const tcol0 = tile & 0x0F, trow = ((tile >> 4) + (row >> 3)) & 0x0F;
        const tbase = base + ((tile & 0x100) ? gap : 0);
        for (let px = 0; px < size; px++) {
          const x = sx + px;
          if (x < 0 || x >= W || objC[x]) continue;
          const col = hflip ? size - 1 - px : px;
          const t = (trow << 4) | ((tcol0 + (col >> 3)) & 0x0F);
          const a = (tbase + t * 16 + (row & 7)) & 0x7FFF;
          const w0 = vram[a], w1 = vram[(a + 8) & 0x7FFF], bit = 7 - (col & 7);
          const c = ((w0 >> bit) & 1) | (((w0 >> (bit + 8)) & 1) << 1) | (((w1 >> bit) & 1) << 2) | (((w1 >> (bit + 8)) & 1) << 3);
          if (!c) continue;
          objC[x] = 0x80 | (pal << 4) | c; objP[x] = prio;
        }
      }
    }

    // 表示行 y(1〜224)を frame の y-1 行目に描く
    renderLine(y) {
      if (y < 1 || y > H) return;
      const out = this.frame, base = (y - 1) * W;
      if (this.forceBlank) { for (let x = 0; x < W; x++) out[base + x] = 0xFF000000; return; }
      const lineZ = this.lineZ, lineC = this.lineC, tm = this.tm, mode = this.bgMode, bpp = BPP[mode];
      lineZ.fill(0); lineC.fill(0);
      if (mode === 0) {
        if ((tm & 1) && bpp[0]) this._bgLine(0, y, 2, 8, 11, 0);
        if ((tm & 2) && bpp[1]) this._bgLine(1, y, 2, 7, 10, 32);
        if ((tm & 4) && bpp[2]) this._bgLine(2, y, 2, 2, 5, 64);
        if ((tm & 8) && bpp[3]) this._bgLine(3, y, 2, 1, 4, 96);
      } else {
        if ((tm & 1) && bpp[0]) this._bgLine(0, y, bpp[0], 8, 11, 0);
        if ((tm & 2) && bpp[1]) this._bgLine(1, y, bpp[1], 7, 10, 0);
        if ((tm & 4) && bpp[2]) this._bgLine(2, y, bpp[2], 2, (mode === 1 && this.bg3Prio) ? 13 : 5, 0);
      }
      if (tm & 0x10) {
        this._objLine(y);
        const objC = this.objC, objP = this.objP;
        for (let x = 0; x < W; x++) { const c = objC[x]; if (!c) continue; const z = 3 + objP[x] * 3; if (z > lineZ[x]) { lineZ[x] = z; lineC[x] = c; } } // 優先 0-3 → 深さ 3/6/9/12
      }
      const cg = this.cgram, br = this.brightness;
      for (let x = 0; x < W; x++) {
        const c = cg[lineC[x]];
        let r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
        r = ((r << 3) | (r >> 2)) * br / 15 | 0; g = ((g << 3) | (g >> 2)) * br / 15 | 0; b = ((b << 3) | (b >> 2)) * br / 15 | 0;
        out[base + x] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  SnesPpu.WIDTH = W; SnesPpu.HEIGHT = H;
  Emu.SnesPpu = SnesPpu;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * スーパーファミコン本体の骨格(段階 8g-2)
 * MML.Emu.SnesConsole / MML.Emu.SnesApu
 *
 * スーパーゲームボーイ(DESIGN-GB-CAPTURE.md §5)の SNES 側。SGB の BIOS を動かすのに要る範囲から作る:
 *   - 65816(cpu65816.js)、メモリ配置(LoROM/HiROM、WRAM 128K、SRAM)、番地ごとのアクセスの速さ
 *   - $4200 台: NMI/IRQ(H/V タイマ)、乗除算、パッドの自動読み、$4016/$4017 の直列読み
 *   - DMA(一括)と HDMA(行ごと)
 *   - PPU(snes/ppu.js)を行単位で描く。1 行 = 1364 マスタークロック、262 行(NTSC)
 *   - APU: 既存の SPC700(spc700.js、IPL ROM つき)と DSP(spcDsp.js)。ポート $2140-$2143 の読み書きのたびに時間を合わせる
 *   - 拡張の口 ext($6000-$7FFF。SGB の ICD2 が挿さる)
 * 時間はマスタークロック(21.477MHz)で数える。CPU の 1 サイクルは番地で 6/8/12 クロック、内部サイクルは 6。
 * まだ無い物: 行の長さの例外、DRAM リフレッシュ、DMA/HDMA の細かい時刻、PAL、オープンバスの細部、音の出力(8g-5)
 *
 * 参考: fullsnes(nocash)、SNESdev Wiki
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LINE_CLK = 1364, LINES = 262, VBLANK_LINE = 225;
  const APU_RATIO = 1024000 / 21477272; // SPC700 のサイクル / マスタークロック
  const DMA_PATTERN = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];

  // ── APU(SPC700+DSP)。SNES 側とは 4 本のポートでつながる ──
  class SnesApu {
    constructor() {
      this.ram = new Uint8Array(65536);
      this.dsp = Emu.SpcDsp ? new Emu.SpcDsp(this.ram) : null;
      this.in = new Uint8Array(4);  // SNES → SPC($F4-$F7 を読むと見える)
      this.out = new Uint8Array(4); // SPC → SNES($2140-$2143 を読むと見える)
      this.cpu = new Emu.SPC700(this);
      this.onSample = null;         // (L, R) DSP の 1 サンプル(32kHz)
      this.reset();
    }
    reset() {
      this.ram.fill(0); this.in.fill(0); this.out.fill(0);
      this.dspAddr = 0; this.romEnable = true;
      this.timers = [0, 0, 0]; this.timerDiv = [0, 0, 0]; this.timerCnt = [0, 0, 0]; this.timerEn = [false, false, false]; this.timerClk = [0, 0, 0];
      this.dspClk = 0;
      this.cycles = 0; // 走らせた SPC700 のサイクルの通算(録音がポート書き込みの刻印に使う)
      if (this.dsp) { this.dsp.reset(); this.dsp.regs[0x6C] = 0xE0; } // 電源投入時の FLG は $E0(リセット+ミュート+エコー書き込み禁止)。0 だとエコーが RAM $0000 台を壊し、IPL の転送先が化ける
      this.cpu.halted = false;
      this.cpu.reset(); // IPL ROM の先頭($FFC0)から
    }
    read(addr) {
      if (this.romEnable && addr >= 0xFFC0) return Emu.SPC_IPL_ROM[addr - 0xFFC0];
      if (addr >= 0xF0 && addr <= 0xFF) {
        switch (addr) {
          case 0xF2: return this.dspAddr;
          case 0xF3: return this.dsp ? this.dsp.readReg(this.dspAddr & 0x7F) : 0;
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.in[addr - 0xF4];
          case 0xFD: case 0xFE: case 0xFF: { const c = this.timerCnt[addr - 0xFD]; this.timerCnt[addr - 0xFD] = 0; return c; }
          case 0xF0: case 0xF1: case 0xFA: case 0xFB: case 0xFC: return 0;
        }
      }
      return this.ram[addr];
    }
    write(addr, v) {
      if (addr >= 0xF0 && addr <= 0xFF) {
        switch (addr) {
          case 0xF1:
            this.romEnable = (v & 0x80) !== 0;
            for (let t = 0; t < 3; t++) { const en = (v & (1 << t)) !== 0; if (en && !this.timerEn[t]) { this.timers[t] = 0; this.timerCnt[t] = 0; } this.timerEn[t] = en; }
            if (v & 0x10) { this.in[0] = 0; this.in[1] = 0; }
            if (v & 0x20) { this.in[2] = 0; this.in[3] = 0; }
            return;
          case 0xF2: this.dspAddr = v; return;
          case 0xF3: if (this.dsp && !(this.dspAddr & 0x80)) this.dsp.writeReg(this.dspAddr, v); return;
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: this.out[addr - 0xF4] = v; return;
          case 0xFA: case 0xFB: case 0xFC: this.timerDiv[addr - 0xFA] = v; return;
        }
      }
      this.ram[addr] = v;
    }
    // .spc ファイルの形の像(toSpc の逆)から始める。VGM の再生(GBXX 種類 1)が使う。DSP の内部(エンベロープの途中など)は像に無いので、鳴っていた音は次のキーオンから
    loadSpc(img) {
      if (!img || img.length < 0x10180) return false;
      this.reset();
      const c = this.cpu;
      this.ram.set(img.subarray(0x100, 0x10100));
      c.PC = img[0x25] | (img[0x26] << 8); c.A = img[0x27]; c.X = img[0x28]; c.Y = img[0x29]; c.PSW = img[0x2A]; c.SP = img[0x2B];
      const ctl = img[0x1F1];
      this.romEnable = (ctl & 0x80) !== 0;
      for (let t = 0; t < 3; t++) { this.timerEn[t] = (ctl & (1 << t)) !== 0; this.timerDiv[t] = img[0x1FA + t]; this.timerCnt[t] = img[0x1FD + t] & 0x0F; }
      this.dspAddr = img[0x1F2];
      for (let i = 0; i < 4; i++) this.in[i] = img[0x1F4 + i];
      if (this.dsp) for (let i = 0; i < 128; i++) { if (i === 0x4C || i === 0x5C) continue; this.dsp.writeReg(i, img[0x10100 + i]); } // KON/KOFF は書かない(鳴り直さない)
      if (this.dsp) this.dsp.regs[0x6C] = img[0x10100 + 0x6C];
      return true;
    }
    // シークの控え用(VGM 再生のチェックポイント)。関数と RAM への別名は写さない
    getState() {
      const cp = (v) => { if (v === null || typeof v !== 'object') return v; if (ArrayBuffer.isView(v)) return v.slice(); if (Array.isArray(v)) return v.map(cp); const o = {}; for (const k of Object.keys(v)) { if (typeof v[k] === 'function' || k === 'bus' || k === 'ram' || k === 'origRam') continue; o[k] = cp(v[k]); } return o; };
      return { ram: this.ram.slice(), in: this.in.slice(), out: this.out.slice(), dspAddr: this.dspAddr, romEnable: this.romEnable, timers: this.timers.slice(), timerDiv: this.timerDiv.slice(), timerCnt: this.timerCnt.slice(), timerEn: this.timerEn.slice(), timerClk: this.timerClk.slice(), dspClk: this.dspClk, cycles: this.cycles,
        cpu: cp(this.cpu), dsp: this.dsp ? cp(this.dsp) : null };
    }
    setState(s) {
      const put = (o, v) => { for (const k of Object.keys(v)) { const x = v[k], cur = o[k]; if (x === null || typeof x !== 'object') o[k] = x; else if (ArrayBuffer.isView(x)) { if (cur && ArrayBuffer.isView(cur) && cur.length === x.length) cur.set(x); else o[k] = x.slice(); } else if (Array.isArray(x)) { if (Array.isArray(cur) && cur.length === x.length && x.length && x[0] && typeof x[0] === 'object' && !ArrayBuffer.isView(x[0])) for (let i = 0; i < x.length; i++) put(cur[i], x[i]); else o[k] = x.map((e) => (ArrayBuffer.isView(e) ? e.slice() : e)); } else if (cur && typeof cur === 'object') put(cur, x); else o[k] = x; } };
      this.ram.set(s.ram); this.in.set(s.in); this.out.set(s.out); this.dspAddr = s.dspAddr; this.romEnable = s.romEnable;
      this.timers = s.timers.slice(); this.timerDiv = s.timerDiv.slice(); this.timerCnt = s.timerCnt.slice(); this.timerEn = s.timerEn.slice(); this.timerClk = s.timerClk.slice(); this.dspClk = s.dspClk; this.cycles = s.cycles || 0;
      put(this.cpu, s.cpu); if (this.dsp && s.dsp) put(this.dsp, s.dsp);
    }
    // 今の状態を .spc ファイルの形(0x10200 バイト)にする。録音の頭に入れる(SPC の再生系がそのまま読める形)
    toSpc() {
      const out = new Uint8Array(0x10200), c = this.cpu;
      const sig = 'SNES-SPC700 Sound File Data v0.30';
      for (let i = 0; i < sig.length; i++) out[i] = sig.charCodeAt(i);
      out[0x21] = 26; out[0x22] = 26; out[0x23] = 27; out[0x24] = 30; // 27 = ID666 タグ無し
      out[0x25] = c.PC & 0xFF; out[0x26] = (c.PC >> 8) & 0xFF; out[0x27] = c.A; out[0x28] = c.X; out[0x29] = c.Y; out[0x2A] = c.PSW; out[0x2B] = c.SP;
      out.set(this.ram, 0x100);
      // $F0-$FF はレジスタの値を入れておく(.spc の約束)
      out[0x1F1] = (this.romEnable ? 0x80 : 0) | (this.timerEn[0] ? 1 : 0) | (this.timerEn[1] ? 2 : 0) | (this.timerEn[2] ? 4 : 0);
      out[0x1F2] = this.dspAddr;
      for (let i = 0; i < 4; i++) out[0x1F4 + i] = this.in[i];
      for (let i = 0; i < 3; i++) { out[0x1FA + i] = this.timerDiv[i]; out[0x1FD + i] = this.timerCnt[i]; }
      if (this.dsp) for (let i = 0; i < 128; i++) out[0x10100 + i] = this.dsp.regs[i];
      out.set(this.ram.subarray(0xFFC0, 0x10000), 0x101C0);
      return out;
    }
    // SPC700 を cycles サイクルぶん進める。戻り値は実際に進んだサイクル(命令の切れ目まで)
    run(cycles) {
      let spent = 0;
      const cpu = this.cpu;
      while (spent < cycles) {
        const c = cpu.halted ? 2 : cpu.step();
        spent += c;
        for (let t = 0; t < 3; t++) {
          if (!this.timerEn[t]) continue;
          const period = t < 2 ? 128 : 16;
          this.timerClk[t] += c;
          while (this.timerClk[t] >= period) {
            this.timerClk[t] -= period;
            if (++this.timers[t] >= (this.timerDiv[t] || 256)) { this.timers[t] = 0; this.timerCnt[t] = (this.timerCnt[t] + 1) & 0x0F; }
          }
        }
        this.cycles += c;
        this.dspClk += c;
        while (this.dspClk >= 32) { this.dspClk -= 32; if (this.dsp) { this.dsp.clock(); if (this.onSample) this.onSample(this.dsp.outL, this.dsp.outR); } }
      }
      return spent;
    }
  }

  // ── カートリッジ(LoROM/HiROM。SGB の BIOS は LoROM 256K)──
  function parseRom(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if ((bytes.length & 0x3FF) === 0x200) bytes = bytes.subarray(0x200); // コピー機のヘッダ
    const score = (at) => {
      if (at + 0x40 > bytes.length) return -1;
      let s = 0;
      const ck = bytes[at + 0x1E] | (bytes[at + 0x1F] << 8), cc = bytes[at + 0x1C] | (bytes[at + 0x1D] << 8);
      if (((ck ^ cc) & 0xFFFF) === 0xFFFF) s += 4;
      const map = bytes[at + 0x15] & 0x0F;
      if (at === 0x7FC0 && (map & 1) === 0) s += 2;
      if (at === 0xFFC0 && (map & 1) === 1) s += 2;
      const reset = bytes[at + 0x3C] | (bytes[at + 0x3D] << 8);
      if (reset >= 0x8000) s += 2;
      for (let i = 0; i < 21; i++) { const c = bytes[at + i]; if (c >= 0x20 && c < 0x7F) s += 0.05; }
      return s;
    };
    const hi = score(0xFFC0) > score(0x7FC0);
    const at = hi ? 0xFFC0 : 0x7FC0;
    let title = ''; for (let i = 0; i < 21; i++) { const c = bytes[at + i]; title += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ' '; }
    const ramCode = bytes[at + 0x18];
    return { rom: bytes, hirom: hi, title: title.trim(), sramSize: ramCode ? (0x400 << ramCode) : 0 };
  }

  class SnesConsole {
    constructor(romBytes, opts) {
      opts = opts || {};
      this.cart = parseRom(romBytes);
      this.rom = this.cart.rom;
      this.romMask = 1; while (this.romMask < this.rom.length) this.romMask <<= 1; this.romMask -= 1;
      this.sram = new Uint8Array(Math.max(this.cart.sramSize, 0));
      this.wram = new Uint8Array(0x20000);
      this.ppu = new Emu.SnesPpu();
      this.apu = new SnesApu();
      this.ext = opts.ext || null; // $6000-$7FFF(バンク $00-$3F/$80-$BF)に挿さる機器: { read(a), write(a, v), tick?(clk) }
      // CPU は生成時にリセットベクタを読む(= advance が走る)ので、時計を先に置く
      this.clock = 0; this.hclk = 0; this.vline = 0; this.apuAcc = 0; this.lineStage = 0; this.irqMode = 0; this.hdmaEn = 0; this.fastRom = false; this.openBus = 0;
      this.cpu = new Emu.CPU65816(this);
      this.pad = [0, 0];          // パッド 1/2(16bit: B Y Sel Start ↑ ↓ ← → A X L R 0 0 0 0)
      this.dma = Array.from({ length: 8 }, () => ({ dmap: 0xFF, bbad: 0xFF, a1t: 0xFFFF, a1b: 0xFF, das: 0xFFFF, dasb: 0xFF, a2a: 0xFFFF, nltr: 0xFF, done: true, doXfer: false }));
      this.onFrame = null;
      this.onApuPort = null; // (port, value) APU ポート $2140-$2143 への書き込み(録音用)
      this.frameCount = 0;
      this.reset();
    }

    reset() {
      this.wram.fill(0x55);
      this.ppu.reset(); this.apu.reset();
      this.clock = 0; this.hclk = 0; this.vline = 0; this.apuAcc = 0;
      this.nmiEnable = false; this.irqMode = 0; this.autoJoy = false;
      this.nmiFlag = false; this.nmiPending = false; this.irqFlag = false; this.irqDone = false;
      this.htime = 0x1FF; this.vtime = 0x1FF;
      this.wrio = 0xFF; this.mpyA = 0xFF; this.rdmpy = 0; this.rddiv = 0; this.dividend = 0xFFFF;
      this.hdmaEn = 0; this.fastRom = false;
      this.joy = [0, 0, 0, 0]; this.joyStrobe = false; this.joyShift = [0, 0]; this.autoJoyBusyUntil = -1;
      this.wmAddr = 0;
      this.openBus = 0;
      this.lineStage = 0;
      this._frameFlag = false;
      for (const d of this.dma) { d.done = true; d.doXfer = false; }
      this.cpu.reset();
    }

    setController(port, bits) { this.pad[port & 1] = bits & 0xFFFF; }
    get frame() { return this.ppu.frame; }
    get frameWidth() { return 256; }
    get frameHeight() { return 224; }

    // ── 時間 ──
    // CPU の 1 サイクルが何マスタークロックか(番地で決まる)
    speed(addr) {
      const bank = addr >> 16, a = addr & 0xFFFF;
      if ((bank & 0x40) === 0) { // $00-$3F / $80-$BF
        if (a < 0x2000) return 8;
        if (a < 0x4000) return 6;
        if (a < 0x4200) return 12;
        if (a < 0x6000) return 6;
        if (a < 0x8000) return 8;
        return (bank & 0x80) && this.fastRom ? 6 : 8;
      }
      if (bank >= 0xC0) return this.fastRom ? 6 : 8;
      return 8;
    }
    // マスタークロックを進め、行の中の出来事(行頭、描画、HBlank、H/V タイマ)を起こす
    advance(clk) {
      this.clock += clk;
      this.apuAcc += clk * APU_RATIO;
      if (this.ext && this.ext.tick) this.ext.tick(clk);
      let h = (this.hclk += clk);
      for (;;) {
        if (this.lineStage === 0) { if (h < 2) break; this.lineStage = 1; this._lineStart(); }
        if (this.lineStage === 1) { if (h < 88) break; this.lineStage = 2; if (this.vline >= 1 && this.vline < VBLANK_LINE) this.ppu.renderLine(this.vline); }
        if (this.lineStage === 2) { if (h < 1112) break; this.lineStage = 3; if (this.vline < VBLANK_LINE && this.hdmaEn) this._hdmaRun(); }
        if (h < LINE_CLK) break;
        h = (this.hclk -= LINE_CLK);
        this.lineStage = 0; this.irqDone = false;
        if (++this.vline >= LINES) this.vline = 0;
      }
      // H/V タイマの IRQ: モード 1 = 毎行 HTIME、2 = VTIME の行頭、3 = VTIME の行の HTIME
      if (this.irqMode && !this.irqDone) {
        const vOk = this.irqMode === 1 || this.vline === this.vtime;
        const ht = this.irqMode === 2 ? 10 : this.htime * 4 + 14;
        if (vOk && this.hclk >= ht && ht < LINE_CLK) { this.irqDone = true; this.irqFlag = true; }
      }
    }
    _lineStart() {
      const v = this.vline;
      if (v === VBLANK_LINE) {
        this.nmiFlag = true;
        if (this.nmiEnable) this.nmiPending = true;
        this.ppu.vblank();
        if (this.autoJoy) { this.joy[0] = this.pad[0]; this.joy[1] = this.pad[1]; this.joy[2] = 0; this.joy[3] = 0; this.autoJoyBusyUntil = this.clock + 4224; }
        this.syncApu();
        this.frameCount++; this._frameFlag = true;
        if (this.onFrame) this.onFrame();
      } else if (v === 0) {
        this.nmiFlag = false;
        if (this.hdmaEn) this._hdmaInit();
      }
    }
    syncApu() {
      const n = Math.floor(this.apuAcc);
      if (n > 0) this.apuAcc -= this.apu.run(n);
    }

    // ── バス(CPU から)──
    read(addr) { this.advance(this.speed(addr)); const v = this.peek(addr); this.openBus = v; return v; }
    write(addr, v) { this.advance(this.speed(addr)); this.openBus = v; this.poke(addr, v); }
    idle() { this.advance(6); }

    _romAddr(bank, a) { return this.cart.hirom ? (((bank & 0x3F) << 16) | a) : (((bank & 0x7F) << 15) | (a & 0x7FFF)); }
    peek(addr) {
      const bank = addr >> 16, a = addr & 0xFFFF;
      if (bank === 0x7E || bank === 0x7F) return this.wram[addr & 0x1FFFF];
      if ((bank & 0x40) === 0) {
        if (a < 0x2000) return this.wram[a];
        if (a < 0x6000) return this._ioRead(a);
        if (a < 0x8000) {
          if (this.ext) return this.ext.read(a);
          if (this.cart.hirom && this.sram.length && (bank & 0x3F) >= 0x20) return this.sram[(((bank & 0x1F) << 13) | (a & 0x1FFF)) % this.sram.length];
          return this.openBus;
        }
        return this.rom[this._romAddr(bank, a) & this.romMask] | 0;
      }
      // $40-$7D / $C0-$FF
      if (!this.cart.hirom && (bank & 0x7F) >= 0x70 && a < 0x8000) return this.sram.length ? this.sram[((((bank & 0x7F) - 0x70) << 15) | a) % this.sram.length] : this.openBus;
      return this.rom[this._romAddr(bank, a) & this.romMask] | 0;
    }
    poke(addr, v) {
      const bank = addr >> 16, a = addr & 0xFFFF;
      if (bank === 0x7E || bank === 0x7F) { this.wram[addr & 0x1FFFF] = v; return; }
      if ((bank & 0x40) === 0) {
        if (a < 0x2000) { this.wram[a] = v; return; }
        if (a < 0x6000) { this._ioWrite(a, v); return; }
        if (a < 0x8000) {
          if (this.ext) this.ext.write(a, v);
          else if (this.cart.hirom && this.sram.length && (bank & 0x3F) >= 0x20) this.sram[(((bank & 0x1F) << 13) | (a & 0x1FFF)) % this.sram.length] = v;
        }
        return;
      }
      if (!this.cart.hirom && (bank & 0x7F) >= 0x70 && a < 0x8000 && this.sram.length) this.sram[((((bank & 0x7F) - 0x70) << 15) | a) % this.sram.length] = v;
    }

    _ioRead(a) {
      if (a >= 0x2100 && a < 0x2140) {
        if (a === 0x2137) { if (this.wrio & 0x80) this.ppu.latchCounters((this.hclk >> 2) & 0x1FF, this.vline); return this.openBus; }
        return this.ppu.read(a - 0x2100);
      }
      if (a >= 0x2140 && a < 0x2180) { this.syncApu(); return this.apu.out[a & 3]; }
      if (a === 0x2180) { const v = this.wram[this.wmAddr]; this.wmAddr = (this.wmAddr + 1) & 0x1FFFF; return v; }
      if (a === 0x4016 || a === 0x4017) { // 直列読み(B から 1 ビットずつ)。読み切ると 1
        const p = a & 1;
        if (this.joyStrobe) return (this.openBus & 0xFC) | ((this.pad[p] >> 15) & 1);
        const bit = (this.joyShift[p] >> 15) & 1;
        this.joyShift[p] = ((this.joyShift[p] << 1) | 1) & 0xFFFF;
        return (this.openBus & 0xFC) | bit | (p ? 0x1C : 0);
      }
      if (a >= 0x4300 && a < 0x4380) {
        const d = this.dma[(a >> 4) & 7];
        switch (a & 0x0F) {
          case 0x0: return d.dmap; case 0x1: return d.bbad;
          case 0x2: return d.a1t & 0xFF; case 0x3: return d.a1t >> 8; case 0x4: return d.a1b;
          case 0x5: return d.das & 0xFF; case 0x6: return d.das >> 8; case 0x7: return d.dasb;
          case 0x8: return d.a2a & 0xFF; case 0x9: return d.a2a >> 8; case 0xA: return d.nltr;
        }
        return this.openBus;
      }
      switch (a) {
        case 0x4210: { const v = (this.nmiFlag ? 0x80 : 0) | 0x02 | (this.openBus & 0x70); this.nmiFlag = false; return v; }
        case 0x4211: { const v = (this.irqFlag ? 0x80 : 0) | (this.openBus & 0x7F); this.irqFlag = false; return v; }
        case 0x4212: return (this.vline >= VBLANK_LINE ? 0x80 : 0) | (this.hclk < 4 || this.hclk >= 1096 ? 0x40 : 0) | (this.clock < this.autoJoyBusyUntil ? 1 : 0) | (this.openBus & 0x3E);
        case 0x4213: return this.wrio;
        case 0x4214: return this.rddiv & 0xFF; case 0x4215: return this.rddiv >> 8;
        case 0x4216: return this.rdmpy & 0xFF; case 0x4217: return this.rdmpy >> 8;
        case 0x4218: case 0x421A: case 0x421C: case 0x421E: return this.joy[(a - 0x4218) >> 1] & 0xFF;
        case 0x4219: case 0x421B: case 0x421D: case 0x421F: return this.joy[(a - 0x4218) >> 1] >> 8;
      }
      return this.openBus;
    }
    _ioWrite(a, v) {
      if (a >= 0x2100 && a < 0x2140) { this.ppu.write(a - 0x2100, v); return; }
      if (a >= 0x2140 && a < 0x2180) { this.syncApu(); this.apu.in[a & 3] = v; if (this.onApuPort) this.onApuPort(a & 3, v); return; }
      if (a >= 0x2180 && a < 0x2184) {
        if (a === 0x2180) { this.wram[this.wmAddr] = v; this.wmAddr = (this.wmAddr + 1) & 0x1FFFF; }
        else if (a === 0x2181) this.wmAddr = (this.wmAddr & 0x1FF00) | v;
        else if (a === 0x2182) this.wmAddr = (this.wmAddr & 0x100FF) | (v << 8);
        else this.wmAddr = (this.wmAddr & 0x0FFFF) | ((v & 1) << 16);
        return;
      }
      if (a === 0x4016) { const was = this.joyStrobe; this.joyStrobe = (v & 1) !== 0; if (was && !this.joyStrobe) { this.joyShift[0] = this.pad[0]; this.joyShift[1] = this.pad[1]; } return; }
      if (a >= 0x4300 && a < 0x4380) {
        const d = this.dma[(a >> 4) & 7];
        switch (a & 0x0F) {
          case 0x0: d.dmap = v; break; case 0x1: d.bbad = v; break;
          case 0x2: d.a1t = (d.a1t & 0xFF00) | v; break; case 0x3: d.a1t = (d.a1t & 0xFF) | (v << 8); break; case 0x4: d.a1b = v; break;
          case 0x5: d.das = (d.das & 0xFF00) | v; break; case 0x6: d.das = (d.das & 0xFF) | (v << 8); break; case 0x7: d.dasb = v; break;
          case 0x8: d.a2a = (d.a2a & 0xFF00) | v; break; case 0x9: d.a2a = (d.a2a & 0xFF) | (v << 8); break; case 0xA: d.nltr = v; break;
        }
        return;
      }
      switch (a) {
        case 0x4200: {
          const was = this.nmiEnable;
          this.nmiEnable = (v & 0x80) !== 0; this.irqMode = (v >> 4) & 3; this.autoJoy = (v & 1) !== 0;
          if (!was && this.nmiEnable && this.nmiFlag) this.nmiPending = true; // VBlank の最中に許可すると、その場で入る
          if (!this.irqMode) this.irqFlag = false;
          break;
        }
        case 0x4201: if ((this.wrio & 0x80) && !(v & 0x80)) this.ppu.latchCounters((this.hclk >> 2) & 0x1FF, this.vline); this.wrio = v; break;
        case 0x4202: this.mpyA = v; break;
        case 0x4203: this.rdmpy = this.mpyA * v; break;
        case 0x4204: this.dividend = (this.dividend & 0xFF00) | v; break;
        case 0x4205: this.dividend = (this.dividend & 0xFF) | (v << 8); break;
        case 0x4206: if (v) { this.rddiv = (this.dividend / v) | 0; this.rdmpy = this.dividend % v; } else { this.rddiv = 0xFFFF; this.rdmpy = this.dividend; } break;
        case 0x4207: this.htime = (this.htime & 0x100) | v; break;
        case 0x4208: this.htime = (this.htime & 0xFF) | ((v & 1) << 8); break;
        case 0x4209: this.vtime = (this.vtime & 0x100) | v; break;
        case 0x420A: this.vtime = (this.vtime & 0xFF) | ((v & 1) << 8); break;
        case 0x420B: if (v) this._dmaRun(v); break;
        case 0x420C: this.hdmaEn = v; break;
        case 0x420D: this.fastRom = (v & 1) !== 0; break;
      }
    }

    // ── DMA ──
    _bRead(reg) { return this._ioRead(0x2100 | reg); }
    _bWrite(reg, v) { this._ioWrite(0x2100 | reg, v); }
    _dmaRun(mask) {
      this.advance(8);
      for (let ch = 0; ch < 8; ch++) {
        if (!(mask & (1 << ch))) continue;
        const d = this.dma[ch], pat = DMA_PATTERN[d.dmap & 7], toA = (d.dmap & 0x80) !== 0;
        const step = (d.dmap & 0x08) ? 0 : (d.dmap & 0x10) ? -1 : 1;
        this.advance(8);
        let i = 0;
        do {
          const aaddr = (d.a1b << 16) | d.a1t, breg = (d.bbad + pat[i % pat.length]) & 0xFF;
          if (toA) this.poke(aaddr, this._bRead(breg)); else this._bWrite(breg, this.peek(aaddr));
          d.a1t = (d.a1t + step) & 0xFFFF;
          d.das = (d.das - 1) & 0xFFFF;
          i++;
          this.advance(8);
        } while (d.das !== 0);
      }
    }
    // HDMA: フレームの頭で表を読み始め、行ごとの HBlank で決まったバイト数を B バスへ書く
    _hdmaLoad(d) {
      d.nltr = this.peek((d.a1b << 16) | d.a2a); d.a2a = (d.a2a + 1) & 0xFFFF;
      if (d.nltr === 0) { d.done = true; return; }
      if (d.dmap & 0x40) { // 間接: 表にはデータの番地が入っている
        const lo = this.peek((d.a1b << 16) | d.a2a), hi = this.peek((d.a1b << 16) | ((d.a2a + 1) & 0xFFFF));
        d.a2a = (d.a2a + 2) & 0xFFFF; d.das = lo | (hi << 8);
      }
      d.doXfer = true;
    }
    _hdmaInit() {
      for (let ch = 0; ch < 8; ch++) {
        const d = this.dma[ch];
        if (!(this.hdmaEn & (1 << ch))) { d.done = true; continue; }
        d.done = false; d.a2a = d.a1t;
        this._hdmaLoad(d);
      }
    }
    _hdmaRun() {
      for (let ch = 0; ch < 8; ch++) {
        const d = this.dma[ch];
        if (!(this.hdmaEn & (1 << ch)) || d.done) continue;
        if (d.doXfer) {
          const pat = DMA_PATTERN[d.dmap & 7], ind = (d.dmap & 0x40) !== 0;
          for (let i = 0; i < pat.length; i++) {
            let v;
            if (ind) { v = this.peek((d.dasb << 16) | d.das); d.das = (d.das + 1) & 0xFFFF; }
            else { v = this.peek((d.a1b << 16) | d.a2a); d.a2a = (d.a2a + 1) & 0xFFFF; }
            this._bWrite((d.bbad + pat[i]) & 0xFF, v);
          }
        }
        d.nltr = (d.nltr - 1) & 0xFF;
        d.doXfer = (d.nltr & 0x80) !== 0;
        if ((d.nltr & 0x7F) === 0) this._hdmaLoad(d);
      }
    }

    // ── 実行 ──
    step() {
      const cpu = this.cpu;
      if (this.nmiPending) { this.nmiPending = false; cpu.nmi(); return; }
      if (this.irqFlag && this.irqMode) {
        if (!(cpu.p & 0x04)) { cpu.irq(); return; }
        if (cpu.waiting) cpu.waiting = false; // I が立っていても WAI は抜ける
      }
      cpu.step();
    }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag && ++guard < 400000) this.step();
      this.syncApu();
    }
  }

  SnesConsole.BUTTON = { B: 0x8000, Y: 0x4000, SELECT: 0x2000, START: 0x1000, UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100, A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010 };
  Emu.SnesConsole = SnesConsole;
  Emu.SnesApu = SnesApu;
  Emu.parseSnesRom = parseRom;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * スーパーゲームボーイのカートリッジ(段階 8g-4): ICD2 チップ+ゲームボーイ本体
 * MML.Emu.SgbIcd2
 *
 * SNES 側からは $6000-$7FFF に見える(SnesConsole の ext に挿す)。中にゲームボーイ(gb/gbConsole.js)が丸ごと入っていて、
 * SNES のマスタークロックを分周した時計で動く(初代: 21.477MHz÷5 = 4.295MHz。実機のゲームボーイより約 2.4% 速い)。
 *   $6000 R : 今 LCD が描いている行(上位 5bit = 8 行単位の段)と、書き込み中のバッファ番号(下位 2bit)
 *   $6001 W : 読み出すバッファ番号(読み出し位置を 0 に戻す)
 *   $6002 R : ゲームボーイからのコマンド(16 バイト)が届いているか。読むと 1 つ取り出して $7000-$700F に置く
 *   $6003 W : bit7 = 0 でゲームボーイをリセット、1 で動かす / bit5-4 = パッドの人数(0=1 人、1=2 人、3=4 人) / bit1-0 = 時計の分周(÷4 ÷5 ÷7 ÷9)
 *   $6004-7 W: パッド 1〜4(0 = 押している。bit7-4 = START SELECT B A、bit3-0 = ↓ ↑ ← →)
 *   $600F R : チップの版
 *   $7000-F R: コマンド 16 バイト
 *   $7800 R : 選んだバッファの絵(20 タイル × 16 バイト = 320 バイト、ゲームボーイのタイル形式)。続けて読むと進む
 * ゲームボーイ側は P1($FF00)の P14/P15 の上げ下げでコマンドを 1 ビットずつ送る(両方 L = 開始、P14 だけ L = 0、P15 だけ L = 1)。
 * LCD の出力(4 階調の番号)は 8 行ぶんずつ 4 本のバッファに順に溜まり、BIOS がそれを読んで SNES の画面に描く。
 *
 * ブート ROM(256 バイト)があればそれを実行する(カートリッジのヘッダを 6 個のコマンドで SNES へ送るのがその仕事)。
 * 無ければ同じ 6 個のコマンドをここで作って届け、ゲームボーイは起動後の状態から始める。
 *
 * 出どころ: fullsnes(nocash)の SGB の章。パッド番号の進み方とコマンド受信の状態機械は bsnes の ICD を覚えている範囲で再現した物(推定を含む)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DIVIDER = [4, 5, 7, 9];

  class SgbIcd2 {
    // opts: { bootRom: Uint8Array(256) | null, revision: 1 | 2, gbOpts: GbConsole へ渡す追加の指定 }
    constructor(gbRom, opts) {
      opts = opts || {};
      this.revision = opts.revision || 1;
      this.gb = new Emu.GbConsole(gbRom, Object.assign({ model: 'dmg', sgb: this, bootRom: opts.bootRom || null }, opts.gbOpts || {}));
      this.hasBoot = !!opts.bootRom;
      this.baseHz = 21477272; this.clkScale = 1; // SGB2 は専用の水晶(20.97152MHz)。SgbConsole が入れる
      this.onClock = null;                       // (clk) SNES のマスタークロックが進んだ(音の標本化に使う)
      this.rows = new Uint8Array(4 * 8 * 160); // バッファ 4 本 × 8 行 × 160 画素(階調番号 0-3)
      this.packet = new Uint8Array(16);         // $7000-$700F
      this.reset();
    }
    reset() {
      this.r6003 = 0; this.running = false; this.div = DIVIDER[1]; this.mltReq = 0;
      this.pads = [0xFF, 0xFF, 0xFF, 0xFF];
      this.joypId = 0; this.joypLock = false;
      this.queue = [];                 // 届いたコマンド(16 バイトずつ)
      this.pulseLock = true; this.strobeLock = false; this.packetLock = false;
      this.bitData = 0; this.bitOffset = 0; this.packetOffset = 0; this.joypPacket = new Uint8Array(16);
      this.v = 0; this.writeBank = 0; this.readBank = 0; this.readAddr = 0;
      this.rows.fill(0); this.packet.fill(0);
      this.acc = 0; this.idleAcc = 0;
      this._applyClock();
    }
    // ゲームボーイの時計(Hz)= 元の時計 ÷ 分周。音の標本化が使う
    _applyClock() { this.gb.clockHz = this.baseHz / this.div; }

    // ── SNES 側 ──
    read(a) {
      a &= 0xFFFF;
      if (a === 0x6000) { this._follow(this.gb.ppu.line); return (this.v & 0xF8) | this.writeBank; }
      if (a === 0x6002) {
        if (!this.queue.length) return 0;
        this.packet.set(this.queue.shift());
        return 1;
      }
      if (a === 0x600F) return 0x21;
      if ((a & 0xFFF0) === 0x7000) return this.packet[a & 15];
      if (a === 0x7800) {
        const p = this.readAddr; this.readAddr = (p + 1) & 511;
        if (p >= 320) return 0xFF;
        // タイル t の y 行目、ビットプレーン pl(左端の画素が bit7)
        const t = p >> 4, y = (p >> 1) & 7, pl = p & 1, base = this.readBank * 1280 + y * 160 + t * 8, rows = this.rows;
        let b = 0;
        for (let i = 0; i < 8; i++) b = (b << 1) | ((rows[base + i] >> pl) & 1);
        return b;
      }
      return 0;
    }
    write(a, v) {
      a &= 0xFFFF;
      if (a === 0x6001) { this.readBank = v & 3; this.readAddr = 0; return; }
      if (a === 0x6003) {
        if (!(this.r6003 & 0x80) && (v & 0x80)) this._powerGb();
        this.r6003 = v; this.running = (v & 0x80) !== 0; this.div = DIVIDER[v & 3]; this._applyClock();
        this.mltReq = (v >> 4) & 3;
        this.joypId &= this.mltReq === 2 ? 3 : this.mltReq;
        return;
      }
      if (a >= 0x6004 && a <= 0x6007) { this.pads[a - 0x6004] = v; return; }
    }
    // SNES のマスタークロックが clk 進んだ
    tick(clk) {
      if (this.onClock) this.onClock(clk);
      if (!this.running) {
        // 止められている間も、録音中なら録音の時間(ゲームボーイのフレーム内時刻)だけは進める。
        // 進めないと、その間の SNES 側の音(APU ポートへの書き込み)が全部同じ時刻に潰れる
        const gb = this.gb;
        if (gb.rec) {
          this.idleAcc += clk * this.clkScale;
          const t = Math.floor(this.idleAcc / this.div);
          if (t > 0) { this.idleAcc -= t * this.div; gb.frameT += t; if (gb.frameT >= 70224) gb._frameEnd(); }
        }
        return;
      }
      this.acc += clk * this.clkScale;
      const gb = this.gb, div = this.div, need = div * 4;
      while (this.acc >= need) {
        const before = gb.cpuCycles;
        gb.step();
        this.acc -= (gb.cpuCycles - before) * div;
      }
    }

    _powerGb() {
      this.gb.reset();
      this.joypId = 0; this.joypLock = false;
      this.pulseLock = true; this.strobeLock = false; this.packetLock = false; this.bitOffset = 0; this.packetOffset = 0;
      this.queue.length = 0;
      this.v = 0; this.acc = 0;
      this._applyClock();
      if (!this.hasBoot) { // ブート ROM の代わり: ヘッダ $0104-$0157 を 14 バイトずつ 6 個のコマンドで届ける
        const rom = this.gb.cart.rom || [];
        for (let i = 0; i < 6; i++) {
          const pk = new Uint8Array(16);
          pk[0] = 0xF1 + i * 2;
          let sum = 0;
          for (let k = 0; k < 14; k++) { const b = rom[0x104 + i * 14 + k] | 0; pk[2 + k] = b; sum += b; }
          pk[1] = sum & 0xFF;
          this.queue.push(pk);
        }
      }
    }

    // ── ゲームボーイ側 ──
    // LCD の行 y を描き終えた(idx = 画面全体の階調番号)
    lcdLine(y, idx) {
      this._follow(y);
      this.rows.set(idx.subarray(y * 160, y * 160 + 160), this.writeBank * 1280 + (y & 7) * 160);
    }
    // 行カウンタを追いかける。見えている行の 8 行ごと(0 行目を含む)に書き込みバッファが次へ移る。VBlank の間は移らない
    // (VBlank でも移すと、BIOS が中身の無いバッファを最後の段として読んでしまう。実測: dmg-acid2 の最下段が化けた)
    _follow(line) {
      while (this.v !== line) {
        if (++this.v >= 154) this.v = 0;
        if (this.v < 144 && (this.v & 7) === 0) this.writeBank = (this.writeBank + 1) & 3;
      }
    }
    // P1 の下位 4bit。両方 H の時はパッド番号($F − 番号)が読める
    p1Low(p1) {
      const p14 = (p1 >> 4) & 1, p15 = (p1 >> 5) & 1, pad = this.pads[this.joypId];
      let low = 0x0F;
      if (p14 && p15) low = 0x0F - this.joypId;
      if (!p14) low &= pad & 0x0F;
      if (!p15) low &= (pad >> 4) & 0x0F;
      return low & 0x0F;
    }
    // P1 への書き込み(p14/p15 = 書いた値の bit4/bit5)
    joypWrite(p14, p15) {
      // パッド番号: 両方 H に戻るたびに次の人へ(人数は $6003)
      if (p14 && p15) {
        if (!this.joypLock) {
          this.joypLock = true;
          this.joypId = (this.joypId + 1) & (this.mltReq === 2 ? 3 : this.mltReq);
        }
      }
      if (p14 && !p15) this.joypLock = false;

      // コマンドの受信
      if (!p14 && !p15) { this.pulseLock = false; this.packetOffset = 0; this.bitOffset = 0; this.strobeLock = true; this.packetLock = false; return; }
      if (this.pulseLock) return;
      if (p14 && p15) { this.strobeLock = false; return; }
      if (this.strobeLock) return; // 前のビットから H に戻っていない
      this.strobeLock = true;
      const bit = p15 ? 0 : 1; // P14 だけ L = 0、P15 だけ L = 1
      if (this.packetLock) { // 16 バイト受け終えた後の止めのビット(0)
        if (!bit) { if (this.queue.length < 64) this.queue.push(this.joypPacket.slice()); }
        this.packetLock = false; this.pulseLock = true;
        return;
      }
      this.bitData = (bit << 7) | (this.bitData >> 1);
      if (++this.bitOffset < 8) return;
      this.bitOffset = 0;
      this.joypPacket[this.packetOffset] = this.bitData;
      if (++this.packetOffset < 16) return;
      this.packetOffset = 0;
      this.packetLock = true;
    }
  }

  Emu.SgbIcd2 = SgbIcd2;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * スーパーゲームボーイ本体(段階 8g-5): SNES(snesConsole.js)+ICD2(icd2.js)+ゲームボーイ(gb/gbConsole.js)を 1 台にまとめる
 * MML.Emu.SgbConsole / MML.Emu.SgbState
 *
 * 外形は GbConsole / NesConsole と同じ(Worklet と画面がそのまま扱える): setSampleRate / runSamplesStereo / runFrame / frame /
 * setController / startRecording / stopRecording / セーブ RAM / 周辺(傾き、赤外線、プリンタ…は中の GbConsole へ素通し)。
 *   - 画面は SNES の 256×224(枠つき)。1 フレーム = SNES の 1 フレーム(60.0988Hz)
 *   - 時計: 初代は SNES のマスタークロック ÷5 = 4,295,454Hz(実機のゲームボーイより約 2.4% 速い)。SGB2 は専用の水晶で 4,194,304Hz
 *   - 音: ゲームボーイの APU(出力レートで直接標本化)+SNES の DSP(32kHz を線形補間で出力レートへ)を足す。
 *     SPC700 は出力 1 サンプルごとに追いつかせる(ポートを触った時だけだと 1 フレームぶん固まって届く)
 *   - 録音: ゲームボーイの書き込み列(GbConsole の録音)に、SNES 側の音源の控え(.spc の形の像)と APU ポートへの書き込みを混ぜる。
 *     VGM では規格外ブロック GBXX の種類 1 に載る(vgmRecord.js encodeGbRecording)
 *   - パッド: NesConsole.BUTTON の並びを SNES のパッドへ写す(A→A、B→B、SELECT、START、十字)。2P も渡す(多人数対応ソフト用)
 * ステート(SgbState)は SNES 側を木ごと写し、ゲームボーイは GbState に任せる。巻き戻しは無い(1 枚が大きい)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const MASTER = 21477272, SGB2_XTAL = 20971520;
  const RING = 16384, SPC_FIFO = 4096, SPC_RATE = 32000;
  // NesConsole.BUTTON(A B SELECT START UP DOWN LEFT RIGHT)→ SNES のパッド
  const PAD_MAP = [0x0080, 0x8000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200, 0x0100];
  const toSnesPad = (bits) => { let o = 0; for (let i = 0; i < 8; i++) if (bits & (1 << i)) o |= PAD_MAP[i]; return o; };

  class SgbConsole {
    // opts: { bios: SGB の BIOS(256K = 初代、512K = SGB2), bootRom: ゲームボーイ側のブート ROM 256 バイト(任意), revision: 1 | 2(省略時は BIOS の大きさ) }
    constructor(gbRom, opts) {
      opts = opts || {};
      if (!opts.bios) throw new Error('SGB BIOS が要ります');
      const bios = opts.bios instanceof Uint8Array ? opts.bios : new Uint8Array(opts.bios);
      this.revision = opts.revision || (bios.length > 0x40000 ? 2 : 1);
      this.icd = new Emu.SgbIcd2(gbRom, { bootRom: opts.bootRom || null, revision: this.revision });
      this.gb = this.icd.gb;
      this.snes = new Emu.SnesConsole(bios, { ext: this.icd });
      this.icd.baseHz = this.revision === 2 ? SGB2_XTAL : MASTER;
      this.icd.clkScale = this.revision === 2 ? SGB2_XTAL / MASTER : 1;
      this.icd._applyClock();
      this.model = 'sgb'; this.cgb = false; this.isSgb = true;
      this.cart = this.gb.cart; this.ppu = this.gb.ppu; this.apu = this.gb.apu;
      this.sampleRate = 0; this.acc = 0; this.underruns = 0;
      this.ring = new Float32Array(RING); this.ringR = new Float32Array(RING); this.ringHead = 0; this.ringLen = 0;
      this.spcL = new Float32Array(SPC_FIFO); this.spcR = new Float32Array(SPC_FIFO); this.spcHead = 0; this.spcLen = 0; this.spcFrac = 0; this.spcStep = 0;
      this.spcGain = 1; this.gbGain = 1;
      this.padHeld = [0, 0]; this.padTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.onFrame = null;
      this.recBase = 0; this.recPort = [0, 0, 0, 0];
      this.snes.apu.onSample = (l, r) => {
        if (!this.sampleRate) return;
        if (this.spcLen >= SPC_FIFO) { this.spcHead = (this.spcHead + 1) & (SPC_FIFO - 1); this.spcLen--; }
        const i = (this.spcHead + this.spcLen) & (SPC_FIFO - 1);
        this.spcL[i] = l; this.spcR[i] = r; this.spcLen++;
      };
      // 録音: APU ポートへの書き込み。c = 録音の頭からの SPC700 のサイクル数(再生はこの刻印どおりに書く)
      this.snes.onApuPort = (port, v) => { const rec = this.gb.rec; if (rec && this.recPort[port & 3] === (v & 0xFF)) return; if (rec) this.recPort[port & 3] = v & 0xFF; if (rec) rec.cur.push({ sgbPort: port & 3, value: v & 0xFF, t: this.gb.frameT, c: (this.snes.apu.cycles - this.recBase) >>> 0 }); };
      this.icd.onClock = (clk) => this._clock(clk);
      this.snes.onFrame = () => {
        if (this.padTurbo[0] || this.padTurbo[1] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(); }
        if (this.onFrame) this.onFrame();
      };
    }

    reset() {
      this.icd.reset(); this.gb.reset(); this.snes.reset(); this.icd._applyClock();
      this.acc = 0; this.ringHead = 0; this.ringLen = 0; this.spcHead = 0; this.spcLen = 0; this.spcFrac = 0;
      this._applyPad();
    }

    // ── 音 ──
    setSampleRate(sr) {
      this.sampleRate = sr; this.acc = 0; this.ringHead = 0; this.ringLen = 0; this.spcHead = 0; this.spcLen = 0; this.spcFrac = 0;
      this.spcStep = sr ? SPC_RATE / sr : 0;
      this.gb.setSampleRate(sr);
    }
    // SNES のマスタークロックが clk 進んだ(ICD2 から)。出力 1 サンプルぶん溜まるたびに GB と SPC の音を足して輪へ
    _clock(clk) {
      const sr = this.sampleRate;
      if (!sr) return;
      this.acc += clk * sr;
      while (this.acc >= MASTER) {
        this.acc -= MASTER;
        this.snes.syncApu();
        // SPC: 32kHz → 出力レート(線形補間)
        let sl = 0, sp = 0;
        const M = SPC_FIFO - 1;
        while (this.spcFrac >= 1 && this.spcLen > 1) { this.spcFrac -= 1; this.spcHead = (this.spcHead + 1) & M; this.spcLen--; }
        if (this.spcLen > 1) {
          const a = this.spcHead, b = (a + 1) & M, f = this.spcFrac < 1 ? this.spcFrac : 1;
          sl = this.spcL[a] + (this.spcL[b] - this.spcL[a]) * f; sp = this.spcR[a] + (this.spcR[b] - this.spcR[a]) * f;
          this.spcFrac += this.spcStep;
        } else if (this.spcLen === 1) { sl = this.spcL[this.spcHead]; sp = this.spcR[this.spcHead]; }
        // GB: 中の GbConsole が同じ出力レートで自分の輪に溜めている(止められている間は空)
        let gl = 0, gr = 0;
        const gb = this.gb;
        if (gb.ringLen > 0) {
          const GM = gb.ring.length - 1;
          if (gb.ringLen > 256) { gb.ringHead = (gb.ringHead + gb.ringLen - 8) & GM; gb.ringLen = 8; } // 溜まり過ぎ(時計の切り替え直後など)は捨てて遅れを持ち越さない
          gl = gb.ring[gb.ringHead]; gr = gb.ringR[gb.ringHead]; gb.ringHead = (gb.ringHead + 1) & GM; gb.ringLen--;
        }
        if (this.ringLen < RING) {
          const i = (this.ringHead + this.ringLen) & (RING - 1);
          this.ring[i] = gl * this.gbGain + sl * this.spcGain; this.ringR[i] = gr * this.gbGain + sp * this.spcGain;
          this.ringLen++;
        }
      }
    }
    runFrame() { this.snes.runFrame(); return this.sampleRate ? this.takeAudio(this.ringLen) : null; }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.snes.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    runSamplesStereo(outL, outR) {
      const n = outL.length;
      if (!this.sampleRate) { outL.fill(0); outR.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.snes.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(outL, n, outR);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    takeAudioInto(out, n, outR) {
      const take = Math.min(n, this.ringLen), M = RING - 1, h = this.ringHead;
      if (outR) { for (let i = 0; i < take; i++) { out[i] = this.ring[(h + i) & M]; outR[i] = this.ringR[(h + i) & M]; } for (let i = take; i < n; i++) outR[i] = 0; }
      else for (let i = 0; i < take; i++) out[i] = (this.ring[(h + i) & M] + this.ringR[(h + i) & M]) * 0.5;
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (h + take) & M; this.ringLen -= take;
    }
    applyMix(mute, volume) { return this.gb.applyMix(mute, volume); }

    // ── 画面と時間 ──
    get frame() { return this.snes.frame; }
    get frameWidth() { return 256; }
    get frameHeight() { return 224; }
    get frameRate() { return MASTER / (1364 * 262); }
    get frameCount() { return this.snes.frameCount; }
    set frameCount(v) { this.snes.frameCount = v; }
    get stereo() { return true; }
    get clockHz() { return this.gb.clockHz; } // 録音の VGM ヘッダに入れるゲームボーイのクロック

    // ── パッド ──
    setController(port, bits, turbo) { const p = port ? 1 : 0; this.padHeld[p] = bits & 0xFF; this.padTurbo[p] = (turbo | 0) & 0xFF; this._applyPad(); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(); }
    _applyPad() {
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      for (let p = 0; p < 2; p++) this.snes.setController(p, toSnesPad(this.padHeld[p] | (on ? this.padTurbo[p] : 0)));
    }
    get pad() { return this.padHeld; }

    // ── 録音 ──
    get rec() { return this.gb.rec; }
    startRecording() {
      this.gb.startRecording();
      this.snes.syncApu();
      this.recBase = this.snes.apu.cycles;
      this.recPort = Array.from(this.snes.apu.in); // 同じ値の書き直しは録音に入れない(SPC700 から見て変化が無い。BIOS は毎フレーム書く)
      this.gb.rec.cur.unshift({ sgbSpc: this.snes.apu.toSpc(), t: 0 }); // SNES 側の音源の今の像(.spc の形)。VGM の先頭に来るよう、GB のレジスタ像より前へ
    }
    stopRecording() { return this.gb.stopRecording(); }

    // ── 中のゲームボーイへ素通し ──
    get hasBattery() { return this.gb.hasBattery; }
    get batteryDirty() { return this.gb.batteryDirty; }
    clearBatteryDirty() { this.gb.clearBatteryDirty(); }
    getBattery() { return this.gb.getBattery(); }
    setBattery(b) { return this.gb.setBattery(b); }
    setTilt(x, y) { this.gb.setTilt(x, y); }
    get hasTilt() { return this.gb.hasTilt; }
    setLight(on) { this.gb.setLight(on); }
    get irWanted() { return this.gb.irWanted; }
    get rumble() { return this.gb.rumble; }
    takePrints() { return this.gb.takePrints(); }
    setCameraImage(u8) { this.gb.setCameraImage(u8); }
    get cameraWanted() { return this.gb.cameraWanted; }
    get barcodeWanted() { return this.gb.barcodeWanted; }
    scanBarcode(d) { return this.gb.scanBarcode(d); }
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['gb']; }

    static describe(sgb) { return Emu.GbConsole.describe(sgb.gb) + (sgb.revision === 2 ? ' / Super Game Boy 2' : ' / Super Game Boy'); }
  }

  // ── ステート ──
  // SNES 側(本体、CPU、PPU、APU、DSP、ICD2)は木ごと写す。関数と、親や ROM への参照(下の SKIP)は写さない
  const SKIP = new Set(['bus', 'rom', 'cart', 'ext', 'gb', 'frame', 'con', 'sgb', 'bootImage']);
  function snap(o) {
    const out = {};
    for (const k of Object.keys(o)) {
      if (SKIP.has(k)) continue;
      const v = o[k];
      if (typeof v === 'function') continue;
      out[k] = snapVal(v);
    }
    return out;
  }
  function snapVal(v) {
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return v.slice();
    if (Array.isArray(v)) return v.map(snapVal);
    return snap(v);
  }
  function restore(o, s) {
    for (const k of Object.keys(s)) {
      const v = s[k], cur = o[k];
      if (v === null || typeof v !== 'object') { o[k] = v; continue; }
      if (ArrayBuffer.isView(v)) { if (cur && ArrayBuffer.isView(cur) && cur.length === v.length) cur.set(v); else o[k] = v.slice(); continue; }
      if (Array.isArray(v)) {
        const plainObjs = v.length > 0 && Array.isArray(cur) && cur.length === v.length && v.every((e) => e && typeof e === 'object' && !ArrayBuffer.isView(e) && !Array.isArray(e));
        if (plainObjs) for (let i = 0; i < v.length; i++) restore(cur[i], v[i]);
        else o[k] = v.map(snapVal);
        continue;
      }
      if (cur && typeof cur === 'object') restore(cur, v); else o[k] = snapVal(v);
    }
  }
  const SgbState = {
    VERSION: 1,
    save(sgb) {
      sgb.snes.syncApu();
      const snes = snap(sgb.snes);
      if (snes.apu && snes.apu.dsp) delete snes.apu.dsp.ram; // APU の RAM と同じ物
      return { kind: 'sgb', v: SgbState.VERSION, revision: sgb.revision, snes, icd: snap(sgb.icd), gb: Emu.GbState.save(sgb.gb), gbBoot: !!sgb.gb.bootRom, gbClock: sgb.gb.clockHz };
    },
    load(sgb, st) {
      if (!st || st.kind !== 'sgb' || st.v !== SgbState.VERSION || st.revision !== sgb.revision) return false;
      if (!Emu.GbState.load(sgb.gb, st.gb)) return false;
      restore(sgb.snes, st.snes);
      restore(sgb.icd, st.icd);
      sgb.gb.bootRom = st.gbBoot ? sgb.gb.bootImage : null;
      sgb.gb.clockHz = st.gbClock;
      sgb.acc = 0; sgb.ringHead = 0; sgb.ringLen = 0; sgb.spcHead = 0; sgb.spcLen = 0; sgb.spcFrac = 0;
      sgb.gb.ringHead = 0; sgb.gb.ringLen = 0;
      sgb._applyPad();
      return true;
    },
  };

  Emu.SgbConsole = SgbConsole;
  Emu.SgbState = SgbState;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * NES / MSX 本体を AudioWorklet の中で回す (nes-worklet バンドルの本体。DESIGN-CAPTURE.md §6/§7 段階 6b、DESIGN-MSX-CAPTURE.md §6 段階 7a)
 *
 * 本体クラスは load メッセージの machine('nes' | 'msx' | 'gb')で選ぶ(NesConsole / MsxConsole / GbConsole。外形は同じ)。State/Rewind も機種で選ぶ。
 * GB(2026-11-13、DESIGN-GB-CAPTURE.md 段階 8c)は音がステレオ(本体の stereo が真なら左右別に出す)。
 * 以下「NES」「nes」とあるのは本体一般のこと(変数名は NES 時代のまま)。MSX だけの物: load の msx オプション(機種/BIOS/マッパー)、
 * key/keyReleaseAll(PC のキー → MSX キーボード)、rwframe の palette(逆再生の 8bit 画面の色)、loaded の chips。
 *
 * 音の時刻を基準にフレームを刻む: process() が 128 サンプルを求めるたびに、その分だけ CPU/PPU/APU を進める
 * (NesConsole.runSamples)。画面が 1 枚できるたびに主スレッドへ frame(Uint32Array の ArrayBuffer、転送)と、
 * 録音中ならそのフレームの書き込み列を送る。主スレッドは描くだけ。
 * 主スレッドからは load(ROM)/pad(入力)/reset/pause/record/rewind(飛ぶ)/rewindStart・rewindSpeed・rewindEnd(逆再生)を受ける。
 * 速い読み込み(diskFast、2026-11-12): 本体は常に実機の時間で動き(ディスクの待ちも実機どおり。録音も実機の時間)、ディスクを読み書きしている間
 * (本体の diskBusy())だけ自動で早送りする。1 回の process で回す回数 afN は、直近の処理時間が実時間の 7 割に収まるよう増減させる
 * (Worklet には performance.now が無く Date.now は 1ms 刻みなので、64 回ぶん溜めて割合を見る)。画面は 60 枚/秒まで送る。
 * 逆再生(押している間の巻き戻し)の間は本体を止め、無音を出しながら NesRewind の映像の輪から古い画面を rwframe
 * (8bit パレット番号)で送る。離したら rewindEnd でそのフレームへ本当に戻り、rewound を返す。
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
      this.diskFast = false; this.afN = 2; this.afOn = false; this.afMs = 0; this.afBlocks = 0; this.afT = 0; this.lastPost = -1; // 速い読み込み
      this.dcX = 0; this.dcY = 0;
      this.frameSeq = 0;
      this.rw = null; // 逆再生中 { speed, acc }
      this.machine = 'nes'; this.State = null; // load で機種に合わせる
      this.port.onmessage = (e) => this.onMessage(e.data || {});
    }
    onMessage(m) {
      try {
        switch (m.type) {
          case 'load': {
            const machine = m.machine === 'msx' ? 'msx' : m.machine === 'gb' ? 'gb' : 'nes';
            let nes, info;
            if (machine === 'msx') {
              // MSX: ROM(null なら BIOS だけで起動)+ 機種/BIOS(main 32K・sub/logo 16K、ArrayBuffer で届く)/マッパー種別
              const o = m.msx || {};
              const bios = {};
              if (o.bios) { for (const k of ['main', 'sub', 'logo', 'kanji', 'disk', 'kdr', 'music']) if (o.bios[k]) bios[k] = new Uint8Array(o.bios[k]); if (o.bios.name) bios.name = o.bios.name; }
              const cartB = o.cartB && o.cartB.kind ? { kind: o.cartB.kind, rom: o.cartB.rom ? new Uint8Array(o.cartB.rom) : null } : null; // 音源カートリッジ(FM-PAC/MSX-AUDIO/SCC-I)
              const disks = (o.disks || []).map((b) => new Uint8Array(b)); // .dsk 画像(7d)
              nes = new MML.Emu.MsxConsole(m.rom ? new Uint8Array(m.rom) : null, { machine: o.machine, bios: bios.main ? bios : null, mapperType: o.mapperType || undefined, cartB, disks, fdc: o.fdc || undefined });
              info = MML.Emu.MsxConsole.describe(nes);
            } else if (machine === 'gb') {
              if (m.gb && m.gb.sgb) { // スーパーゲームボーイ: SNES 側ごと動かす(BIOS は主スレッドから。ブート ROM は任意)
                const o = m.gb.sgb;
                nes = new MML.Emu.SgbConsole(new Uint8Array(m.rom), { bios: new Uint8Array(o.bios), bootRom: o.boot ? new Uint8Array(o.boot) : null, revision: o.revision || 0 });
                info = MML.Emu.SgbConsole.describe(nes);
              } else {
                nes = new MML.Emu.GbConsole(new Uint8Array(m.rom), { model: (m.gb && m.gb.model) || 'dmg' });
                if (m.gb && m.gb.shades) nes.ppu.shades = Array.from(m.gb.shades);
                info = MML.Emu.GbConsole.describe(nes);
              }
            } else {
              nes = new MML.Emu.NesConsole(new Uint8Array(m.rom), { bios: m.bios ? new Uint8Array(m.bios) : null });
              info = MML.Emu.INES.describe(nes.rom);
            }
            nes.setSampleRate(sampleRate);
            nes.onFrame = () => this.onFrame();
            if (m.battery && nes.hasBattery) nes.setBattery(new Uint8Array(m.battery)); // 前回のセーブ(主スレッドが IndexedDB から)
            this.nes = nes;
            this.machine = machine;
            this.State = machine === 'msx' ? MML.Emu.MsxState : machine === 'gb' ? (nes.isSgb ? MML.Emu.SgbState : MML.Emu.GbState) : MML.Emu.NesState;
            const Rewind = machine === 'msx' ? MML.Emu.MsxRewind : machine === 'gb' ? (nes.isSgb ? null : MML.Emu.GbRewind) : MML.Emu.NesRewind; // SGB は巻き戻し無し(1 枚が大きい)
            this.rewind = Rewind ? new Rewind(nes) : null;
            this.dcX = 0; this.dcY = 0; this.dcX2 = 0; this.dcY2 = 0;
            this.port.postMessage({ type: 'loaded', machine, info, chips: typeof nes.chips === 'function' ? nes.chips() : null, fps: nes.frameRate || 0, extBits: nes.extBits(), sampleRate, tilt: !!nes.hasTilt, disks: nes.diskCount, battery: nes.hasBattery, w: this.frameW(), h: this.frameH(), clock: nes.clockHz || 0, sgb: nes.isSgb ? nes.revision : 0 });
            break;
          }
          case 'key': // MSX: PC のキー(KeyboardEvent.code)を押す/離す。対応の無いキーは本体が無視する
            if (this.nes && typeof this.nes.setKey === 'function') this.nes.setKey(String(m.code || ''), !!m.down);
            break;
          case 'keyReleaseAll':
            if (this.nes && this.nes.keyboard && this.nes.keyboard.releaseAll) this.nes.keyboard.releaseAll();
            break;
          case 'unload': // 止める前の最後のセーブ要求。変化が無くても返事をする(主スレッドが待つ)
            this.postBattery(true);
            break;
          case 'disk': // FDS: side < 0 で取り出し、0 以上でその面を入れる
            if (!this.nes || typeof this.nes.insertDisk !== 'function') break;
            if (m.side < 0) this.nes.ejectDisk(); else this.nes.insertDisk(m.side | 0);
            if (this.rewind) this.rewind.clear();
            break;
          case 'diskAdd': { // MSX: .dsk を足してドライブ A に入れる(入れ替え。主スレッドが取り出し→少し待って送る)
            if (!this.nes || typeof this.nes.addDisk !== 'function') break;
            const n = this.nes.addDisk(new Uint8Array(m.image)); if (n >= 0) this.nes.insertDisk(n);
            if (this.rewind) this.rewind.clear();
            this.port.postMessage({ type: 'diskAdded', count: this.nes.diskCount, index: n });
            break;
          }
          case 'pad': if (this.nes) this.nes.setController(m.port | 0, m.bits | 0, m.turbo | 0); break;
          case 'sensor': // GB: 傾き(MBC7)と赤外線の受光
            if (!this.nes) break;
            if (m.tiltX !== undefined && typeof this.nes.setTilt === 'function') this.nes.setTilt(+m.tiltX || 0, +m.tiltY || 0);
            if (m.light !== undefined && typeof this.nes.setLight === 'function') this.nes.setLight(!!m.light);
            if (m.camera && typeof this.nes.setCameraImage === 'function') this.nes.setCameraImage(new Uint8Array(m.camera)); // ポケットカメラの元の絵(128×112 の明るさ)
            if (m.barcode !== undefined && typeof this.nes.scanBarcode === 'function') this.port.postMessage({ type: 'barcode', ok: this.nes.scanBarcode(String(m.barcode)) });
            break;
          case 'turboRate': if (this.nes) this.nes.setTurboRate(m.frames | 0); break;
          case 'reset': if (this.nes) { this.nes.reset(); if (this.rewind) this.rewind.clear(); } break;
          case 'mix': { // 鍵盤表示のミュート/音量(2A03 は apu.mute/vol、拡張音源はマッパーの audio.mute/vol)。capture.js の applyMute/applyVolume と同じ流儀(バンドルに無いので自前)
            if (!this.nes) break;
            if (typeof this.nes.applyMix === 'function') { this.nes.applyMix(m.mute || null, m.volume || null); break; } // MSX: 本体が { psg: [...], scc: [...] } を受ける
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
          case 'rewindStart': // 逆再生を始める(押している間)。speed は 1 秒に何秒ぶん戻るか
            if (!this.nes || !this.rewind || this.rw) break;
            if (this.rewind.beginReverse()) this.rw = { speed: Math.max(1, Math.min(8, m.speed | 0) || 1), acc: 0, pending: null, pendingSeq: 0, lastPost: 0 };
            break;
          case 'rewindSpeed': if (this.rw) this.rw.speed = Math.max(1, Math.min(8, m.speed | 0) || 1); break;
          case 'rewindEnd': { // 離した: 表示していたフレームへ本当に戻る
            if (!this.nes || !this.rewind || !this.rw) break;
            this.rw = null;
            const got = this.rewind.endReverse();
            this.frameSeq = got;
            const frame = this.nes.frame.slice(0, this.frameW() * this.frameH());
            this.port.postMessage({ type: 'rewound', frame: frame.buffer, seq: got, oldest: this.rewind.oldest, w: this.frameW(), h: this.frameH() }, [frame.buffer]);
            break;
          }
          case 'rewind': { // frame(本体の frameCount)の終わりへ戻る。録音中なら像から取り直す。戻った所の画面と frameCount を返す
            if (!this.nes || !this.rewind || this.rw) break;
            const wasRec = !!this.nes.rec;
            this.nes.rec = null;
            const got = this.rewind.rewindTo(m.frame | 0);
            if (wasRec) this.nes.startRecording();
            this.frameSeq = got;
            const frame = this.nes.frame.slice(0, this.frameW() * this.frameH());
            this.port.postMessage({ type: 'rewound', frame: frame.buffer, seq: got, oldest: this.rewind.oldest, w: this.frameW(), h: this.frameH() }, [frame.buffer]);
            break;
          }
          case 'pause': this.paused = !!m.on; break;
          case 'diskFast': this.diskFast = !!m.on; break;
          case 'speed': this.speed = Math.max(1, Math.min(8, m.n | 0)); break; // 早送り: 1 回の process で speed 回ぶん進める(音は最後の 1 回ぶんだけ出す)
          case 'saveState': // ステート保存: 木を写して主スレッドへ(構造化複製。IndexedDB に置くのは主スレッド)
            if (this.nes) this.port.postMessage({ type: 'state', state: this.State.save(this.nes), slot: m.slot });
            break;
          case 'loadState':
            if (this.nes) { const ok = this.State.load(this.nes, m.state); if (ok) { if (this.rewind) this.rewind.clear(); this.frameSeq = this.nes.frameCount; } this.port.postMessage({ type: 'stateLoaded', ok }); }
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
    frameW() { return (this.nes && this.nes.frameWidth) || 256; }
    frameH() { return (this.nes && this.nes.frameHeight) || 240; }
    onFrame() {
      const nes = this.nes;
      if (this.rewind) { if (this.rewind.replaying) return; this.rewind.onFrame(); } // 巻き戻しの再生中は送らない
      this.frameSeq = nes.frameCount; // 主スレッドのフレーム番号 = 本体の frameCount(巻き戻しで戻る)
      if (this.speed > 1 && (++this.ffSkip % this.speed) !== 0) { if ((this.frameSeq % 60) === 0) this.postBattery(false); return; } // 早送り中は speed 枚に 1 枚だけ送る(録音の書き込み列は次に送る時まで溜まる)
      if (this.afOn) { if (currentTime - this.lastPost < 1 / 62) { if ((this.frameSeq % 60) === 0) this.postBattery(false); return; } this.lastPost = currentTime; } // 自動早送り中: 60 枚/秒まで
      const frame = nes.frame.slice(0, this.frameW() * this.frameH()); // MSX は幅がモードで変わる(frame は最大幅で確保。幅ぶんだけ送る)
      const msg = { type: 'frame', seq: this.frameSeq, frame: frame.buffer, underruns: nes.underruns, w: this.frameW(), h: this.frameH(), il: !!nes.interlaced, disk: nes.diskActivity ? nes.diskActivity() : null }; // disk: アクセスランプ(ドライブごとの { access, media })
      if (nes.rec) { msg.writes = nes.rec.frames.splice(0); }
      const tr = [frame.buffer];
      if (this.machine === 'gb') { // GB の周辺: 振動モータ、赤外線を読もうとしているか、刷り上がった絵
        msg.gb = { rumble: !!nes.rumble, ir: !!nes.irWanted, camera: !!nes.cameraWanted, barcode: !!nes.barcodeWanted };
        const pr = nes.takePrints();
        if (pr) msg.gb.prints = pr.map((p) => { tr.push(p.pixels.buffer); return { width: p.width, height: p.height, pixels: p.pixels.buffer }; });
      }
      this.port.postMessage(msg, tr);
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
    // 逆再生の 1 回(process ごと): 再生成を 1 フレーム進め、速さに応じて戻し、画面は 60 枚/秒まで(それ以上送ると主スレッドが詰まる)
    reverseTick() {
      const rw = this.rw, rewind = this.rewind;
      rewind.regenStep(1);
      rw.acc += rw.speed * 128 / (sampleRate / (this.nes.frameRate || 60.0988));
      for (let n = 0; rw.acc >= 1 && n < 8; n++) {
        const r = rewind.reverseStep();
        if (r === null) { rw.acc = Math.min(rw.acc, 1); break; } // まだ作っていない: 待つ(溜めない)
        if (r === false) { rw.acc = 0; break; }                   // これ以上戻れない
        rw.acc -= 1; rw.pending = r; rw.pendingSeq = rewind.rv.cur;
      }
      if (rw.pending && currentTime - rw.lastPost >= 1 / 61) {
        rw.lastPost = currentTime;
        const idx = rw.pending.slice(); rw.pending = null;
        const msg = { type: 'rwframe', seq: rw.pendingSeq, idx: idx.buffer, oldest: rewind.oldest, w: rewind.idxWidth || this.frameW(), h: (this.nes && this.nes.frameIdxHeight) || this.frameH() };
        const tr = [idx.buffer];
        if (this.machine !== 'nes' && rewind.palette) { const pal = (rewind.paletteOf ? rewind.paletteOf(rw.pendingSeq) : rewind.palette).slice(); msg.palette = pal.buffer; tr.push(pal.buffer); } // 8bit 画面の色(そのフレームの色表: パレット 16 色か GRAPHIC7 の 256 色)
        this.port.postMessage(msg, tr);
      }
    }
    // 速い読み込み: ディスクを読んでいる間、afN 回ぶん余分に進める(音は最後の 1 回ぶんだけ)。afN は処理時間の割合で増減
    autoFast(len) {
      const t0 = Date.now();
      const n = Math.max(1, Math.round(this.afN));
      for (let k = 0; k < n && this.nes.diskBusy(); k++) this.nes.runSamples(this.ffTmp);
      this.afMs += Date.now() - t0;
      if (++this.afBlocks >= 64) {
        const budget = 64 * len / sampleRate * 1000;
        const load = (this.afMs + 1) / budget;            // 余分に回した分が実時間に占める割合(1x の分は含まない)
        this.afN = Math.max(1, Math.min(64, this.afN * Math.max(0.5, Math.min(1.5, 0.6 / load))));
        this.afMs = 0; this.afBlocks = 0;
      }
    }
    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      if (this.nes && this.rw) {
        out.fill(0); for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        try { this.reverseTick(); } catch (e) { this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) }); this.rw = null; }
        return true;
      }
      if (!this.nes || this.paused) { out.fill(0); for (let c = 1; c < outputs[0].length; c++) outputs[0][c].fill(0); return true; }
      // 本体がステレオ(GB)で出力が 2ch あれば左右別に
      const stereoOut = this.nes.stereo && outputs[0].length > 1 && typeof this.nes.runSamplesStereo === 'function' ? outputs[0][1] : null;
      try {
        if (!this.ffTmp || this.ffTmp.length !== out.length) this.ffTmp = new Float32Array(out.length);
        if (this.speed > 1) {
          for (let k = 1; k < this.speed; k++) this.nes.runSamples(this.ffTmp); // 捨てる分
        }
        this.afOn = this.diskFast && this.speed === 1 && !!(this.nes.diskBusy && this.nes.diskBusy());
        if (this.afOn) this.autoFast(out.length);
        if (stereoOut) this.nes.runSamplesStereo(out, stereoOut); else this.nes.runSamples(out);
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
      if (stereoOut) {
        let x2 = this.dcX2, y2 = this.dcY2;
        for (let i = 0; i < stereoOut.length; i++) { const x = stereoOut[i]; const y = x - x2 + 0.999 * y2; x2 = x; y2 = y; stereoOut[i] = y; }
        this.dcX2 = x2; this.dcY2 = y2;
        for (let c = 2; c < outputs[0].length; c++) outputs[0][c].set(out);
        return true;
      }
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return true;
    }
  }
  registerProcessor('nes-console', NesWorkletProcessor);
})(typeof window !== 'undefined' ? window : globalThis);

  };
})(window);