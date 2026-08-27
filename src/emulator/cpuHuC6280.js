/*
 * HuC6280 (PC Engine / TurboGrafx-16 CPU) コア
 * MML.Emu.CPUHuC6280
 *
 * 65C02をベースに、PCEハードウェア固有の拡張命令を追加したチップ。cpu6502.js(NES用、
 * NMOS 6502・151正規命令のみ・デコード無効)とは別物として新規実装する
 * (参考: HuC6280 CMOS 8-bit Microprocessor Software Manual、
 *  HuC6280 opcode matrix https://taotao54321.github.io/appsouko/work/PCE/6280op.html 、
 *  PC Engine Hardware Docs 各種。GME(Game_Music_Emu)等の実装は参照せず、公開ドキュメントの
 *  レジスタ/命令仕様という事実のみをクリーンルームで再実装している)。
 *
 * 6502からの主な相違点:
 *   - 65C02系の追加: BRA, PHX/PHY/PLX/PLY, STZ, TRB/TSB, (zp)間接アドレッシング,
 *     JMP (abs,X), BBRi/BBSi/RMBi/SMBi(ゼロページビット演算+分岐), 未定義オペコード無し
 *     (全256通りに何らかの意味がある)。JMP (abs) のページ境界バグは無い(65C02で修正済み)。
 *   - 6280固有拡張: TAM/TMA(MMU、8x8KBページのバンク切替)、ST0/ST1/ST2(HuC6270向け
 *     固定アドレスストア)、TII/TDD/TIA/TAI/TIN(ブロック転送)、SXY/SAX/SAY(レジスタ交換)、
 *     CLA/CLX/CLY(レジスタクリア)、BSR(相対サブルーチン呼出)、CSH/CSL(CPU速度切替)、
 *     SET(次の1命令だけゼロページ,X/Yのラップアラウンドを無効化するTフラグ)、
 *     TST(ゼロページ/絶対アドレスへの即値AND、BITの拡張版)。
 *   - IRQディスパッチを本実装で唯一実装している(GBS/NSF/KSSは簡略化してPLAYを直接呼ぶ設計
 *     だが、HESはヘッダにPLAYアドレスが無く、曲データ自身のIRQベクタ経由でしかPLAY相当の
 *     処理を起動できないため、本物の割込停止/分岐/RTIを実装する必要がある)。
 *     bus.pollIrq() が現在有効な割込のベクタアドレス(無ければ-1)を返す前提
 *     (優先度・個別マスクの判断はhesBus.js側の責務、CPUはIフラグの成否だけを見る)。
 *   - 10進(BCD)モードはHuC6280でも機能する(NESの2A03と違いここは無効化されない)。
 *     ADC/SBCのBCD補正はCMOS 65C02方式(N/V/ZフラグもBCD結果から正しく再計算される)を
 *     採用しているが、実チップでの実測検証はしていない(HES曲データの範囲では
 *     オーディオドライバがSEDを使うことは通常無く、実害の想定は低いという判断)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const F_C = 0x01, F_Z = 0x02, F_I = 0x04, F_D = 0x08, F_B = 0x10, F_T = 0x20, F_V = 0x40, F_N = 0x80;

  const CALL_SENTINEL = 0xFFFF;

  class CPUHuC6280 {
    /**
     * @param {{read:(a:number)=>number, write:(a:number,v:number)=>void, pollIrq?:()=>number}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.A = 0; this.X = 0; this.Y = 0;
      this.S = 0xFF;
      this.P = F_I; // T/D/V/N/Z/Cはクリア、Iはセット(実機はRESET直後IRQ禁止)
      this.PC = 0;
      this.halted = false;
      this.callActive = false;
      this.speedHigh = true; // CSH(既定)/CSL。master clockに対するCPUサイクルの重み換算に使う
      this.lastDataAddr = -1;
    }

    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }
    fetchByte() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    fetchSigned() { const v = this.fetchByte(); return v < 0x80 ? v : v - 0x100; }
    read16(addr) { return this.read(addr) | (this.read((addr + 1) & 0xFFFF) << 8); }

    getFlag(mask) { return (this.P & mask) !== 0; }
    setFlag(mask, on) { this.P = on ? (this.P | mask) : (this.P & ~mask); }
    setZN(v) { v &= 0xFF; this.setFlag(F_Z, v === 0); this.setFlag(F_N, (v & 0x80) !== 0); }

    push(value) { this.write(0x2100 + this.S, value); this.S = (this.S - 1) & 0xFF; }
    pop() { this.S = (this.S + 1) & 0xFF; return this.read(0x2100 + this.S); }

    // ゼロページは実機で $2000-$20FF に固定配置されている(6280固有、通常の6502の
    // $0000-$00FFとは異なる。cc65 issue #317 等で確認済みの既知のハードウェア仕様。
    // PCE本体のI/Oは物理バンク$FFが割り当てられたMPRウィンドウにのみ現れ、通常
    // MPR1(論理$2000-$3FFF)はワークRAM(バンク$F8)に固定されるため、ゼロページ/スタックは
    // 素直にRAMへ到達する)。zpToAddr() で一括してこの+$2000オフセットを付与する。
    zpToAddr(zp) { return 0x2000 + (zp & 0xFF); }

    // ゼロページ,X/Y のインデックス計算(オフセット、0-255の枠内)。SET直後(Tフラグ立)の
    // 1命令だけ0xFFでラップしない(6280固有、マニュアル記載の"T=1のときのゼロページ,X"挙動。
    // ラップしない場合そのまま$20FFを超えて$21xx(スタックページ)側まで伸びうる)。
    zpIndexOffset(base, idx) {
      if (this.getFlag(F_T)) return (base + idx) & 0x1FF;
      return (base + idx) & 0xFF;
    }

    // --- オペランド取得(cpu6502.js と同じ設計。zpindを追加、zp系は$2000オフセット付き) ---
    fetchOperand(mode, skipRead = false) {
      let addr = null, value = 0, pageCrossed = false;
      switch (mode) {
        case 'imm': value = this.fetchByte(); break;
        case 'acc': value = this.A; break;
        case 'impl': break;
        case 'zp': addr = this.zpToAddr(this.fetchByte()); if (!skipRead) value = this.read(addr); break;
        case 'zpx': addr = 0x2000 + this.zpIndexOffset(this.fetchByte(), this.X); if (!skipRead) value = this.read(addr); break;
        case 'zpy': addr = 0x2000 + this.zpIndexOffset(this.fetchByte(), this.Y); if (!skipRead) value = this.read(addr); break;
        case 'zpind': { const zp = this.fetchByte(); addr = this.read(this.zpToAddr(zp)) | (this.read(this.zpToAddr((zp + 1) & 0xFF)) << 8); if (!skipRead) value = this.read(addr); break; }
        case 'abs': addr = this.read16(this.PC); this.PC = (this.PC + 2) & 0xFFFF; if (!skipRead) value = this.read(addr); break;
        case 'absx': {
          const base = this.read16(this.PC); this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.X) & 0xFFFF; pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr); break;
        }
        case 'absy': {
          const base = this.read16(this.PC); this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.Y) & 0xFFFF; pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr); break;
        }
        case 'indx': { const zp = (this.fetchByte() + this.X) & 0xFF; addr = this.read(this.zpToAddr(zp)) | (this.read(this.zpToAddr((zp + 1) & 0xFF)) << 8); if (!skipRead) value = this.read(addr); break; }
        case 'indy': {
          const zp = this.fetchByte();
          const base = this.read(this.zpToAddr(zp)) | (this.read(this.zpToAddr((zp + 1) & 0xFF)) << 8);
          addr = (base + this.Y) & 0xFFFF; pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr); break;
        }
        case 'rel': addr = this.fetchByte(); break;
        default: throw new Error(`未知のアドレッシングモード: ${mode}`);
      }
      // 直近の「メモリからのデータ読出し」の論理アドレス。DDA(PCM)キャプチャ
      // (hesPlayer.js captureHesSongAsync)が「$0806へ書かれたサンプル値はROMのどこから
      // 読まれたか」を突き止めるために参照する(hes2mml/expansion/dpcm.js冒頭コメント参照)。
      // skipRead(STA/STZ等のストア系。書込み先アドレスは読出しではない)とrel(分岐オフセット)
      // は除外する。実測(NX91002.hes)ではストリーミングループのLDA (zp)がここに残り、
      // 43142/43142件でROMバイトと書込み値が一致した。
      if (!skipRead && addr !== null && mode !== 'rel') this.lastDataAddr = addr;
      return { addr, value, pageCrossed };
    }

    writeOperand(mode, addr, value) {
      if (mode === 'acc') this.A = value & 0xFF; else this.write(addr, value);
    }

    // SETのTフラグは「直後の1命令」だけ有効(命令実行後に必ずクリアする)
    clearSetFlagIfNeeded(wasSet) { if (wasSet) this.setFlag(F_T, false); }

    step() {
      // 割込ディスパッチ: Iフラグがクリアで、busが未処理の割込ベクタを返せば分岐する。
      // BRKと違いBフラグは立てずに積む(標準65C02仕様)。
      if (!this.getFlag(F_I) && this.bus.pollIrq) {
        const vector = this.bus.pollIrq();
        if (vector >= 0) {
          this.push((this.PC >> 8) & 0xFF);
          this.push(this.PC & 0xFF);
          this.push(this.P & ~F_B);
          this.setFlag(F_I, true);
          this.setFlag(F_T, false); // 実機挙動未確認だが、割込を跨いでTフラグを持ち越す意味は無い
          this.PC = this.read16(vector);
          return 7; // 割込受付にかかる概算サイクル数
        }
      }
      // 番兵アドレス到達時は実フェッチを一切行わずアイドルする(HuC6280にWAI相当命令が無いための
      // 代替措置)。★重要な経緯: 当初は「INITがRTSで戻ってきたら$3FFF(ゼロ初期化RAM=BRK)へ
      // 落とし、BRK→IRQ2ベクタ→ゲーム側のスタブへ」という設計だったが、実測でHESのINITは
      // 本当にRTSで返ってくることが判明し(GBS/NSF等と違い稀なケースではなかった)、そのたびに
      // $4000番地以降の「たまたまBRKの戻り先計算で踏んでしまった、本来無関係なROMバイト列」を
      // 本物の命令として実行してしまっていた。これが実在の命令列に偶然似た(特に$FF=BBS7が
      // 0除算ならぬ「無限に0xFFを読み進むだけの安定した徘徊」を生む)ため一見動いているように
      // 見えるが、最終的に対応しないRTS(スタックアンダーフロー)を踏んでスタックが破壊され、
      // Iフラグが立ちっぱなしで割込が二度と発生しなくなる(音が1音で固まる/やがて完全に
      // ハングする)不具合の直接原因だった(NAPH-1011.hes/NX91002.hesの実測で確認)。
      // beginCall()が積む番兵($FFFF、cpu.js等の他CPUコアと同じCALL_SENTINEL)へPCが到達したら、
      // メモリ上の中身に関わらず「割込待ちでアイドル」させることで、この種の暴走を根治する。
      if (this.PC === CALL_SENTINEL) return 2;
      const wasSet = this.getFlag(F_T);
      const opcode = this.fetchByte();
      const def = OPS[opcode];
      let cycles;
      if (!def) {
        cycles = 2; // 6280は未定義オペコードが無いはずだが、防御的にNOP扱い
      } else {
        const extra = def.exec(this, def.mode);
        cycles = def.cycles + (extra || 0);
      }
      // TSTのようにmode自体がゼロページ,Xを内部で使う命令もzpIndexed経由でTを消費する。
      // ここで一括してクリアすることで「SET直後の命令」以外に影響が及ばないようにする。
      this.clearSetFlagIfNeeded(wasSet);
      return cycles;
    }

    call(addr, maxSteps = 500000) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF); this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      let steps = 0;
      while (this.PC !== CALL_SENTINEL && steps < maxSteps) { this.step(); steps++; }
      return steps;
    }

    beginCall(addr) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF); this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      this.callActive = true;
    }

    stepCall() {
      const c = this.step();
      if (this.PC === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  // --- 命令ハンドラ ---

  function binAdd(cpu, value, carryIn) {
    const sum = cpu.A + value + carryIn;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
  }
  // CMOS(65C02系)方式のBCD補正。Zは2進加算の結果から、N/Vは下位ニブル補正後の値から
  // 求める(WDC 65C02仕様。冒頭コメントの通り実機未検証の近似)。
  function decAdd(cpu, value, carryIn) {
    const a = cpu.A;
    let al = (a & 0x0F) + (value & 0x0F) + carryIn;
    let ah = (a >> 4) + (value >> 4);
    if (al > 9) { al += 6; }
    if (al > 0x0F) ah++;
    const preClampResult = ((ah & 0x0F) << 4) | (al & 0x0F);
    cpu.setFlag(F_Z, ((a + value + carryIn) & 0xFF) === 0);
    cpu.setFlag(F_N, (preClampResult & 0x80) !== 0);
    cpu.setFlag(F_V, (((a ^ value) & 0x80) === 0) && (((a ^ preClampResult) & 0x80) !== 0));
    if (ah > 9) ah += 6;
    cpu.setFlag(F_C, ah > 15);
    cpu.A = ((ah & 0x0F) << 4) | (al & 0x0F);
  }
  function ADC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    if (cpu.getFlag(F_D)) decAdd(cpu, op.value, c); else binAdd(cpu, op.value, c);
    return op.pageCrossed ? 1 : 0;
  }
  function decSub(cpu, value, carryIn) {
    const a = cpu.A;
    const binResult = (a - value - (1 - carryIn)) & 0xFF;
    let al = (a & 0x0F) - (value & 0x0F) - (1 - carryIn);
    let ah = (a >> 4) - (value >> 4);
    if (al < 0) { al -= 6; ah--; }
    if (ah < 0) ah -= 6;
    const sum = a - value - (1 - carryIn);
    cpu.setFlag(F_C, sum >= 0);
    cpu.setFlag(F_V, (((a ^ value) & 0x80) !== 0) && (((a ^ binResult) & 0x80) !== 0));
    cpu.setFlag(F_Z, binResult === 0);
    cpu.setFlag(F_N, (binResult & 0x80) !== 0);
    cpu.A = ((ah & 0x0F) << 4) | (al & 0x0F);
  }
  function SBC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    if (cpu.getFlag(F_D)) decSub(cpu, op.value, c);
    else binAdd(cpu, op.value ^ 0xFF, c);
    return op.pageCrossed ? 1 : 0;
  }

  function AND(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A &= op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function ORA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A |= op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function EOR(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A ^= op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }

  function ASL(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = (op.value << 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function LSR(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 0x01) !== 0); const r = (op.value >> 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function ROL(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = ((op.value << 1) | c) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function ROR(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 0x01) !== 0); const r = ((op.value >> 1) | (c << 7)) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function INC(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value + 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function DEC(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value - 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }

  function compare(cpu, reg, value) { const r = (reg - value) & 0x1FF; cpu.setFlag(F_C, reg >= value); cpu.setZN(r & 0xFF); }
  function CMP(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.A, op.value); return op.pageCrossed ? 1 : 0; }
  function CPX(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.X, op.value); return 0; }
  function CPY(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.Y, op.value); return 0; }

  function BIT(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_Z, (cpu.A & op.value) === 0);
    if (mode !== 'imm') { cpu.setFlag(F_V, (op.value & 0x40) !== 0); cpu.setFlag(F_N, (op.value & 0x80) !== 0); }
    return 0;
  }
  // TRB/TSB: メモリのZフラグ判定はBITと同じ(A&Mが0か)。TRBはMからAのビットを取り除き、
  // TSBはMへAのビットを立てる(いずれもN/Vは変化しない、65C02仕様)。
  function TSB(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_Z, (cpu.A & op.value) === 0); cpu.writeOperand(mode, op.addr, op.value | cpu.A); return 0; }
  function TRB(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_Z, (cpu.A & op.value) === 0); cpu.writeOperand(mode, op.addr, op.value & ~cpu.A); return 0; }
  function STZ(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, 0); return 0; }

  function branch(cpu, mode, cond) {
    const op = cpu.fetchOperand(mode);
    if (!cond) return 0;
    const offset = op.addr < 0x80 ? op.addr : op.addr - 0x100;
    const oldPC = cpu.PC;
    cpu.PC = (cpu.PC + offset) & 0xFFFF;
    return (oldPC & 0xFF00) !== (cpu.PC & 0xFF00) ? 2 : 1;
  }

  function LDA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function LDX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.X = op.value; cpu.setZN(cpu.X); return op.pageCrossed ? 1 : 0; }
  function LDY(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.Y = op.value; cpu.setZN(cpu.Y); return op.pageCrossed ? 1 : 0; }
  function STA(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A); return 0; }
  function STX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.X); return 0; }
  function STY(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.Y); return 0; }

  function JMP(cpu, mode) {
    if (mode === 'abs') { cpu.PC = cpu.read16(cpu.PC); }
    else if (mode === 'abind') { const ptr = cpu.read16(cpu.PC); cpu.PC = cpu.read16(ptr); } // 65C02: ページ境界バグ無し
    else { const base = cpu.read16(cpu.PC); const ptr = (base + cpu.X) & 0xFFFF; cpu.PC = cpu.read16(ptr); } // abindx
    return 0;
  }
  function JSR(cpu) {
    const target = cpu.read16(cpu.PC);
    const ret = (cpu.PC + 1) & 0xFFFF;
    cpu.push((ret >> 8) & 0xFF); cpu.push(ret & 0xFF);
    cpu.PC = target;
    return 0;
  }
  function RTS(cpu) { const lo = cpu.pop(); const hi = cpu.pop(); cpu.PC = (((hi << 8) | lo) + 1) & 0xFFFF; return 0; }
  function BSR(cpu) {
    // BSR rel: 相対サブルーチン呼出(絶対番地ではなく符号付き8bitオフセット指定のJSR)。
    // JSRと同じく「命令末尾のアドレス」を積み、RTSが+1して次命令へ戻る。
    const d = cpu.fetchSigned();
    const retM1 = (cpu.PC - 1) & 0xFFFF;
    cpu.push((retM1 >> 8) & 0xFF); cpu.push(retM1 & 0xFF);
    cpu.PC = (cpu.PC + d) & 0xFFFF;
    return 0;
  }
  function BRK(cpu) {
    cpu.PC = (cpu.PC + 1) & 0xFFFF;
    cpu.push((cpu.PC >> 8) & 0xFF); cpu.push(cpu.PC & 0xFF);
    cpu.push(cpu.P | F_B);
    cpu.setFlag(F_I, true);
    cpu.setFlag(F_D, false); // 65C02はBRK/IRQでDフラグを自動クリアする
    cpu.PC = cpu.read16(0xFFF6); // HES: BRK/IRQ2ベクタ
    return 0;
  }
  function RTI(cpu) {
    cpu.P = cpu.pop() & ~F_B;
    const lo = cpu.pop(); const hi = cpu.pop();
    cpu.PC = (hi << 8) | lo;
    return 0;
  }

  function PHA(cpu) { cpu.push(cpu.A); return 0; }
  function PHX(cpu) { cpu.push(cpu.X); return 0; }
  function PHY(cpu) { cpu.push(cpu.Y); return 0; }
  function PHP(cpu) { cpu.push(cpu.P | F_B); return 0; }
  function PLA(cpu) { cpu.A = cpu.pop(); cpu.setZN(cpu.A); return 0; }
  function PLX(cpu) { cpu.X = cpu.pop(); cpu.setZN(cpu.X); return 0; }
  function PLY(cpu) { cpu.Y = cpu.pop(); cpu.setZN(cpu.Y); return 0; }
  function PLP(cpu) { cpu.P = cpu.pop() & ~F_B; return 0; }

  function TAX(cpu) { cpu.X = cpu.A; cpu.setZN(cpu.X); return 0; }
  function TAY(cpu) { cpu.Y = cpu.A; cpu.setZN(cpu.Y); return 0; }
  function TXA(cpu) { cpu.A = cpu.X; cpu.setZN(cpu.A); return 0; }
  function TYA(cpu) { cpu.A = cpu.Y; cpu.setZN(cpu.A); return 0; }
  function TSX(cpu) { cpu.X = cpu.S; cpu.setZN(cpu.X); return 0; }
  function TXS(cpu) { cpu.S = cpu.X; return 0; } // Zフラグ等は変化しない(標準6502仕様)
  // 6280固有のレジスタ交換/クリア命令
  function SXY(cpu) { const t = cpu.X; cpu.X = cpu.Y; cpu.Y = t; return 0; }
  function SAX(cpu) { const t = cpu.A; cpu.A = cpu.X; cpu.X = t; return 0; }
  function SAY(cpu) { const t = cpu.A; cpu.A = cpu.Y; cpu.Y = t; return 0; }
  function CLA(cpu) { cpu.A = 0; return 0; }
  function CLX(cpu) { cpu.X = 0; return 0; }
  function CLY(cpu) { cpu.Y = 0; return 0; }

  function INX(cpu) { cpu.X = (cpu.X + 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function INY(cpu) { cpu.Y = (cpu.Y + 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function DEX(cpu) { cpu.X = (cpu.X - 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function DEY(cpu) { cpu.Y = (cpu.Y - 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function INC_A(cpu) { cpu.A = (cpu.A + 1) & 0xFF; cpu.setZN(cpu.A); return 0; }
  function DEC_A(cpu) { cpu.A = (cpu.A - 1) & 0xFF; cpu.setZN(cpu.A); return 0; }

  function SEC(cpu) { cpu.setFlag(F_C, true); return 0; }
  function CLC(cpu) { cpu.setFlag(F_C, false); return 0; }
  function SEI(cpu) { cpu.setFlag(F_I, true); return 0; }
  function CLI(cpu) { cpu.setFlag(F_I, false); return 0; }
  function SED(cpu) { cpu.setFlag(F_D, true); return 0; }
  function CLD(cpu) { cpu.setFlag(F_D, false); return 0; }
  function CLV(cpu) { cpu.setFlag(F_V, false); return 0; }
  function SET(cpu) { cpu.setFlag(F_T, true); return 0; }
  // CSH/CSL: CPU速度切替(High=7.16MHz相当/Low=1.79MHz相当)。命令自体の効果はフラグ切替のみ
  // (hesPlayer.js側がcpu.speedHighを見てCPUサイクル→マスタークロックティックの換算比を変える)。
  function CSH(cpu) { cpu.speedHigh = true; return 0; }
  function CSL(cpu) { cpu.speedHigh = false; return 0; }

  function NOP(cpu, mode) { if (mode !== 'impl') cpu.fetchOperand(mode); return 0; }

  // ST0/ST1/ST2: 即値1byteをそれぞれ $0000/$0002/$0003 (HuC6270 VDCポート) へ直接ストアする
  // 専用命令(通常のSTAより1byte短い・高速)。bus経由で書くのでMMU/I/O分岐は自然に効く。
  function ST0(cpu) { const v = cpu.fetchByte(); cpu.write(0x0000, v); return 0; }
  function ST1(cpu) { const v = cpu.fetchByte(); cpu.write(0x0002, v); return 0; }
  function ST2(cpu) { const v = cpu.fetchByte(); cpu.write(0x0003, v); return 0; }

  // TAMi/TMAi: オペランドはビットマスク(bit0=MPR0 .. bit7=MPR7)。セットされている全bitに
  // 対しAを書き込む/読み出す(複数bit同時指定可、TMAは該当する最初のMPRを返す)。
  function TAMi(cpu) {
    const mask = cpu.fetchByte();
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) cpu.bus.setMpr(i, cpu.A);
    return 0;
  }
  function TMAi(cpu) {
    const mask = cpu.fetchByte();
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) { cpu.A = cpu.bus.getMpr(i); break; }
    return 0;
  }

  // TST #nn,target: target(zp/zpx/abs/absx)の値と即値nnをANDしてN/Zを更新する(Aは変化しない)。
  // Vフラグは変化しない(BITと違い、この命令の対象はメモリ即値マスクでしかない)。
  function TST(cpu, mode) {
    const imm = cpu.fetchByte();
    const op = cpu.fetchOperand(mode);
    const r = imm & op.value;
    cpu.setFlag(F_Z, r === 0);
    cpu.setFlag(F_N, (imm & 0x80) !== 0); // 65C02系実装の通例(即値のbit7をNへ反映)
    return 0;
  }

  // RMBi/SMBi: ゼロページのbit iをクリア/セットする。BBRi/BBSi: 同bitが0/1なら分岐する
  // (65C02標準、opcodeのy=bit3-5相当が命令テーブル生成時にbitIndexとして渡される)。
  function RMB(cpu, bit) { const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); cpu.write(zp, v & ~(1 << bit)); return 0; }
  function SMB(cpu, bit) { const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); cpu.write(zp, v | (1 << bit)); return 0; }
  function BBR(cpu, bit) {
    const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); const d = cpu.fetchSigned();
    if (((v >> bit) & 1) === 0) { cpu.PC = (cpu.PC + d) & 0xFFFF; return 2; }
    return 0;
  }
  function BBS(cpu, bit) {
    const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); const d = cpu.fetchSigned();
    if (((v >> bit) & 1) === 1) { cpu.PC = (cpu.PC + d) & 0xFFFF; return 2; }
    return 0;
  }

  // TII/TDD/TIA/TAI/TIN: 7byte命令(opcode,SL,SH,DL,DH,LL,LH)。srcMode/dstModeはそれぞれ
  // 'inc'|'dec'|'alt'|'fix'。lengthが0なら65536byte転送。cycles=17+6*count(マニュアル値)。
  function blockTransfer(cpu, srcMode, dstMode) {
    let src = cpu.fetchByte() | (cpu.fetchByte() << 8);
    let dst = cpu.fetchByte() | (cpu.fetchByte() << 8);
    let len = cpu.fetchByte() | (cpu.fetchByte() << 8);
    const count = len === 0 ? 0x10000 : len;
    let altToggle = 0; // TIA/TAIの"alternate"側で使う+1/-1の交互パターン
    for (let i = 0; i < count; i++) {
      const value = cpu.read(src);
      cpu.write(dst, value);
      if (srcMode === 'inc') src = (src + 1) & 0xFFFF;
      else if (srcMode === 'dec') src = (src - 1) & 0xFFFF;
      else if (srcMode === 'alt') { src = (src + (altToggle === 0 ? 1 : -1)) & 0xFFFF; }
      if (dstMode === 'inc') dst = (dst + 1) & 0xFFFF;
      else if (dstMode === 'dec') dst = (dst - 1) & 0xFFFF;
      else if (dstMode === 'alt') { dst = (dst + (altToggle === 0 ? 1 : -1)) & 0xFFFF; }
      // 'fix'は据え置き
      altToggle ^= 1;
    }
    cpu.setFlag(F_Z, true); // マニュアル: 転送後Z=1固定 (T列以外は"-"だがZだけ明示的に0扱いの記述あり、安全側でZ=1にしておく)
    return 6 * count; // 基本17サイクルはOPS側cyclesに含める。追加分のみここで返す
  }
  function TII(cpu) { return blockTransfer(cpu, 'inc', 'inc'); }
  function TDD(cpu) { return blockTransfer(cpu, 'dec', 'dec'); }
  function TIA(cpu) { return blockTransfer(cpu, 'inc', 'alt'); }
  function TAI(cpu) { return blockTransfer(cpu, 'alt', 'inc'); }
  function TIN(cpu) { return blockTransfer(cpu, 'inc', 'fix'); }

  // mnemonic -> {mode: [opcodeByte, cycles]}
  const TABLE = {
    ADC: { fn: ADC, modes: { imm: [0x69, 2], zp: [0x65, 4], zpx: [0x75, 4], zpind: [0x72, 7], abs: [0x6D, 5], absx: [0x7D, 5], absy: [0x79, 5], indx: [0x61, 7], indy: [0x71, 7] } },
    AND: { fn: AND, modes: { imm: [0x29, 2], zp: [0x25, 4], zpx: [0x35, 4], zpind: [0x32, 7], abs: [0x2D, 5], absx: [0x3D, 5], absy: [0x39, 5], indx: [0x21, 7], indy: [0x31, 7] } },
    ASL: { fn: ASL, modes: { acc: [0x0A, 2], zp: [0x06, 6], zpx: [0x16, 6], abs: [0x0E, 6], absx: [0x1E, 7] } },
    BCC: { fn: (c, m) => branch(c, m, !c.getFlag(F_C)), modes: { rel: [0x90, 2] } },
    BCS: { fn: (c, m) => branch(c, m, c.getFlag(F_C)), modes: { rel: [0xB0, 2] } },
    BEQ: { fn: (c, m) => branch(c, m, c.getFlag(F_Z)), modes: { rel: [0xF0, 2] } },
    BMI: { fn: (c, m) => branch(c, m, c.getFlag(F_N)), modes: { rel: [0x30, 2] } },
    BNE: { fn: (c, m) => branch(c, m, !c.getFlag(F_Z)), modes: { rel: [0xD0, 2] } },
    BPL: { fn: (c, m) => branch(c, m, !c.getFlag(F_N)), modes: { rel: [0x10, 2] } },
    BVC: { fn: (c, m) => branch(c, m, !c.getFlag(F_V)), modes: { rel: [0x50, 2] } },
    BVS: { fn: (c, m) => branch(c, m, c.getFlag(F_V)), modes: { rel: [0x70, 2] } },
    BRA: { fn: (c, m) => branch(c, m, true), modes: { rel: [0x80, 4] } },
    BIT: { fn: BIT, modes: { imm: [0x89, 2], zp: [0x24, 4], zpx: [0x34, 4], abs: [0x2C, 5], absx: [0x3C, 5] } },
    BRK: { fn: BRK, modes: { impl: [0x00, 8] } },
    BSR: { fn: BSR, modes: { rel: [0x44, 8] } },
    CLC: { fn: CLC, modes: { impl: [0x18, 2] } },
    CLD: { fn: CLD, modes: { impl: [0xD8, 2] } },
    CLI: { fn: CLI, modes: { impl: [0x58, 2] } },
    CLV: { fn: CLV, modes: { impl: [0xB8, 2] } },
    CLA: { fn: CLA, modes: { impl: [0x62, 2] } },
    CLX: { fn: CLX, modes: { impl: [0x82, 2] } },
    CLY: { fn: CLY, modes: { impl: [0xC2, 2] } },
    CSH: { fn: CSH, modes: { impl: [0xD4, 3] } },
    CSL: { fn: CSL, modes: { impl: [0x54, 3] } },
    CMP: { fn: CMP, modes: { imm: [0xC9, 2], zp: [0xC5, 4], zpx: [0xD5, 4], zpind: [0xD2, 7], abs: [0xCD, 5], absx: [0xDD, 5], absy: [0xD9, 5], indx: [0xC1, 7], indy: [0xD1, 7] } },
    CPX: { fn: CPX, modes: { imm: [0xE0, 2], zp: [0xE4, 4], abs: [0xEC, 5] } },
    CPY: { fn: CPY, modes: { imm: [0xC0, 2], zp: [0xC4, 4], abs: [0xCC, 5] } },
    DEC: { fn: DEC, modes: { acc: [0x3A, 2], zp: [0xC6, 6], zpx: [0xD6, 6], abs: [0xCE, 6], absx: [0xDE, 7] } },
    DEX: { fn: DEX, modes: { impl: [0xCA, 2] } },
    DEY: { fn: DEY, modes: { impl: [0x88, 2] } },
    EOR: { fn: EOR, modes: { imm: [0x49, 2], zp: [0x45, 4], zpx: [0x55, 4], zpind: [0x52, 7], abs: [0x4D, 5], absx: [0x5D, 5], absy: [0x59, 5], indx: [0x41, 7], indy: [0x51, 7] } },
    INC: { fn: INC, modes: { acc: [0x1A, 2], zp: [0xE6, 6], zpx: [0xF6, 6], abs: [0xEE, 6], absx: [0xFE, 7] } },
    INX: { fn: INX, modes: { impl: [0xE8, 2] } },
    INY: { fn: INY, modes: { impl: [0xC8, 2] } },
    JMP: { fn: JMP, modes: { abs: [0x4C, 4], abind: [0x6C, 7], abindx: [0x7C, 7] } },
    JSR: { fn: JSR, modes: { abs: [0x20, 7] } },
    LDA: { fn: LDA, modes: { imm: [0xA9, 2], zp: [0xA5, 4], zpx: [0xB5, 4], zpind: [0xB2, 7], abs: [0xAD, 5], absx: [0xBD, 5], absy: [0xB9, 5], indx: [0xA1, 7], indy: [0xB1, 7] } },
    LDX: { fn: LDX, modes: { imm: [0xA2, 2], zp: [0xA6, 4], zpy: [0xB6, 4], abs: [0xAE, 5], absy: [0xBE, 5] } },
    LDY: { fn: LDY, modes: { imm: [0xA0, 2], zp: [0xA4, 4], zpx: [0xB4, 4], abs: [0xAC, 5], absx: [0xBC, 5] } },
    LSR: { fn: LSR, modes: { acc: [0x4A, 2], zp: [0x46, 6], zpx: [0x56, 6], abs: [0x4E, 6], absx: [0x5E, 7] } },
    NOP: { fn: NOP, modes: { impl: [0xEA, 2] } },
    ORA: { fn: ORA, modes: { imm: [0x09, 2], zp: [0x05, 4], zpx: [0x15, 4], zpind: [0x12, 7], abs: [0x0D, 5], absx: [0x1D, 5], absy: [0x19, 5], indx: [0x01, 7], indy: [0x11, 7] } },
    PHA: { fn: PHA, modes: { impl: [0x48, 3] } },
    PHX: { fn: PHX, modes: { impl: [0xDA, 3] } },
    PHY: { fn: PHY, modes: { impl: [0x5A, 3] } },
    PHP: { fn: PHP, modes: { impl: [0x08, 3] } },
    PLA: { fn: PLA, modes: { impl: [0x68, 4] } },
    PLX: { fn: PLX, modes: { impl: [0xFA, 4] } },
    PLY: { fn: PLY, modes: { impl: [0x7A, 4] } },
    PLP: { fn: PLP, modes: { impl: [0x28, 4] } },
    ROL: { fn: ROL, modes: { acc: [0x2A, 2], zp: [0x26, 6], zpx: [0x36, 6], abs: [0x2E, 6], absx: [0x3E, 7] } },
    ROR: { fn: ROR, modes: { acc: [0x6A, 2], zp: [0x66, 6], zpx: [0x76, 6], abs: [0x6E, 6], absx: [0x7E, 7] } },
    RTI: { fn: RTI, modes: { impl: [0x40, 7] } },
    RTS: { fn: RTS, modes: { impl: [0x60, 7] } },
    SAX: { fn: SAX, modes: { impl: [0x22, 3] } },
    SAY: { fn: SAY, modes: { impl: [0x42, 3] } },
    SBC: { fn: SBC, modes: { imm: [0xE9, 2], zp: [0xE5, 4], zpx: [0xF5, 4], zpind: [0xF2, 7], abs: [0xED, 5], absx: [0xFD, 5], absy: [0xF9, 5], indx: [0xE1, 7], indy: [0xF1, 7] } },
    SEC: { fn: SEC, modes: { impl: [0x38, 2] } },
    SED: { fn: SED, modes: { impl: [0xF8, 2] } },
    SEI: { fn: SEI, modes: { impl: [0x78, 2] } },
    SET: { fn: SET, modes: { impl: [0xF4, 2] } },
    STA: { fn: STA, modes: { zp: [0x85, 4], zpx: [0x95, 4], zpind: [0x92, 7], abs: [0x8D, 5], absx: [0x9D, 5], absy: [0x99, 5], indx: [0x81, 7], indy: [0x91, 7] } },
    STX: { fn: STX, modes: { zp: [0x86, 4], zpy: [0x96, 4], abs: [0x8E, 5] } },
    STY: { fn: STY, modes: { zp: [0x84, 4], zpx: [0x94, 4], abs: [0x8C, 5] } },
    STZ: { fn: STZ, modes: { zp: [0x64, 4], zpx: [0x74, 4], abs: [0x9C, 5], absx: [0x9E, 5] } },
    SXY: { fn: SXY, modes: { impl: [0x02, 3] } },
    TAX: { fn: TAX, modes: { impl: [0xAA, 2] } },
    TAY: { fn: TAY, modes: { impl: [0xA8, 2] } },
    TSX: { fn: TSX, modes: { impl: [0xBA, 2] } },
    TXA: { fn: TXA, modes: { impl: [0x8A, 2] } },
    TXS: { fn: TXS, modes: { impl: [0x9A, 2] } },
    TYA: { fn: TYA, modes: { impl: [0x98, 2] } },
    TRB: { fn: TRB, modes: { zp: [0x14, 6], abs: [0x1C, 7] } },
    TSB: { fn: TSB, modes: { zp: [0x04, 6], abs: [0x0C, 7] } },
    ST0: { fn: ST0, modes: { impl: [0x03, 4] } },
    ST1: { fn: ST1, modes: { impl: [0x13, 4] } },
    ST2: { fn: ST2, modes: { impl: [0x23, 4] } },
    TAM: { fn: TAMi, modes: { impl: [0x53, 5] } },
    TMA: { fn: TMAi, modes: { impl: [0x43, 4] } },
    TII: { fn: TII, modes: { impl: [0x73, 17] } },
    TDD: { fn: TDD, modes: { impl: [0xC3, 17] } },
    TIA: { fn: TIA, modes: { impl: [0xE3, 17] } },
    TAI: { fn: TAI, modes: { impl: [0xF3, 17] } },
    TIN: { fn: TIN, modes: { impl: [0xD3, 17] } }
  };

  const OPS = new Array(256).fill(null);
  for (const mnemonic in TABLE) {
    const { fn, modes } = TABLE[mnemonic];
    for (const mode in modes) {
      const [byte, cycles] = modes[mode];
      OPS[byte] = { mnemonic, mode, exec: fn, cycles };
    }
  }
  // TST: y(row)ごとにアドレッシングモードが異なる特殊系列(imm+target二重オペランド)
  OPS[0x83] = { mnemonic: 'TST', mode: 'zp', exec: TST, cycles: 7 };
  OPS[0x93] = { mnemonic: 'TST', mode: 'abs', exec: TST, cycles: 8 };
  OPS[0xA3] = { mnemonic: 'TST', mode: 'zpx', exec: TST, cycles: 7 };
  OPS[0xB3] = { mnemonic: 'TST', mode: 'absx', exec: TST, cycles: 8 };
  // RMBi/SMBi/BBRi/BBSi: 8本ずつ、opcode下位ニブルは固定(x7/xF)、上位ニブルがbit index
  for (let bit = 0; bit < 8; bit++) {
    OPS[bit * 0x10 + 0x07] = { mnemonic: `RMB${bit}`, mode: 'impl', exec: (c) => RMB(c, bit), cycles: 7 };
    OPS[bit * 0x10 + 0x87] = { mnemonic: `SMB${bit}`, mode: 'impl', exec: (c) => SMB(c, bit), cycles: 7 };
    OPS[bit * 0x10 + 0x0F] = { mnemonic: `BBR${bit}`, mode: 'impl', exec: (c) => BBR(c, bit), cycles: 6 };
    OPS[bit * 0x10 + 0x8F] = { mnemonic: `BBS${bit}`, mode: 'impl', exec: (c) => BBS(c, bit), cycles: 6 };
  }

  Emu.CPUHuC6280 = CPUHuC6280;
  Emu.HUC6280_FLAGS = { C: F_C, Z: F_Z, I: F_I, D: F_D, B: F_B, T: F_T, V: F_V, N: F_N };
  Emu.HUC6280_OPS = OPS;
})(window);
