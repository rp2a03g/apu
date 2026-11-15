/*
 * HuC6280(PC エンジンの CPU)コア — サイクル単位(2026-11-15 作り直し、段階 9a)
 * MML.Emu.CPUHuC6280
 *
 * 作り: バスの読み書き 1 回 = 1 CPU サイクル。読み書きの前に必ず bus.tick() を呼ぶので、本体(タイマ/映像/音)は
 * 「いま CPU が何サイクル目のどこを触っているか」を知った状態で進められる。バスを触らないサイクル(内部サイクル)も
 * tick だけ呼ぶ。1 サイクルが何マスタークロックか(CSH=3、CSL=12)はバス側が数える(setSpeed で知らせる)。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3):
 *   [試験] SingleStepTests/huc6280(tools/headless/cpu-test.js huc6280 --all)。レジスタ/メモリ/サイクル数に加えて
 *          サイクルごとのバスの動き(番地・値・読み/書き/内部)まで突き合わせる。このベクタは Mesen 2 が作った物なので、
 *          「実機と合っている」ではなく「Mesen と合っている」の意味(README の断り書きどおり)。
 *   [参照] Mesen 2 の Core/PCE/PceCpu.cpp / PceCpu.Instructions.cpp / PceMemoryManager.cpp を読んで動きを合わせた所
 *          (読んだだけで写していない)。ベクタでは測れない所(割り込み、速度切り替え、ST0-2)に付く。
 *   [文書] HuC6280 CMOS 8-bit Microprocessor Software Manual
 *   [推定] 上のどれでもない所。理由を添える。
 * 札の無い行は、その命令のベクタ([試験])で確かめている。
 *
 * バスに求める物:
 *   read(addr) / write(addr, value)   論理番地(MPR で変換するのはバス)
 *   tick()                            (あれば)1 CPU サイクル進める。読み書きの前に呼ぶ
 *   irqLines()                        (あれば)今かかっている割り込み(マスク後)。bit0=IRQ2 bit1=IRQ1 bit2=タイマ
 *   setMpr(i, bank) / getMpr(i)       MPR の読み書き(TAM/TMA)
 *   setSpeed(high)                    (あれば)CSH/CSL
 *   stWrite(port, value)              (あれば)ST0/ST1/ST2 の書き先(VDC のポート 0/2/3)。MPR を通らない
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const F_C = 0x01, F_Z = 0x02, F_I = 0x04, F_D = 0x08, F_B = 0x10, F_T = 0x20, F_V = 0x40, F_N = 0x80;
  const ZP = 0x2000, STACK = 0x2100; // ゼロページとスタックは論理 $2000/$2100(MPR1 の窓)
  const VEC_IRQ2 = 0xFFF6, VEC_IRQ1 = 0xFFF8, VEC_TIMER = 0xFFFA, VEC_RESET = 0xFFFE;
  const LINE_IRQ2 = 1, LINE_IRQ1 = 2, LINE_TIMER = 4;
  const CALL_SENTINEL = 0xFFFF;

  // アドレッシング。MEM0 以上 MEM1 以下が「番地を指す」種類(値はもう 1 サイクル使って読む)
  const IMP = 0, IMM = 1, REL = 2,
    ZPG = 3, ZPX = 4, ZPY = 5, ABS = 6, ABX = 7, ABY = 8, IZX = 9, IZY = 10, IZP = 11,
    IND = 12, IAX = 13, ZRL = 14, BLK = 15, TZP = 16, TZX = 17, TAB = 18, TAX = 19, NON = 20;
  const MEM0 = ZPG, MEM1 = IZP;

  class CPUHuC6280 {
    constructor(bus) {
      this.bus = bus;
      this.cycles = 0; // 通算の CPU サイクル(速度に関係なく 1 ずつ)
      this.idleAtSentinel = false; // HES 再生だけ true(step() の頭の説明)
      this.reset();
    }

    reset() {
      this.A = 0; this.X = 0; this.Y = 0;
      this.S = 0xFF;
      this.P = F_I;          // [参照] 電源投入で I=1、D と T は 0(PceCpu.cpp のコンストラクタ)
      this.PC = 0;
      this.callActive = false;
      this.idleAtSentinel = false;
      this.speedHigh = true; // 本体(pce/)は電源投入で低速にする。HES 再生は高速のまま始める(hesPlayer.js 側の説明)
      this.lastDataAddr = -1;
      this.irqSample = 0;    // 直前のサイクルで見た割り込み線(I=1 なら 0)
      this.mprBuffer = 0;    // TAM/TMA が最後に通した値
      this.tMode = false;    // いまの命令が T フラグつきで始まったか
      this.ea = 0; this.imm = 0; this.mode = IMP;
    }

    /**
     * リセットベクタから始める(本体用)。HES は使わない。
     * [参照] 電源投入で S=0、CPU は低速(PceCpu.cpp のコンストラクタ、PceMemoryManager.cpp)。A/X/Y と残りのフラグは実機では不定
     */
    powerOn() {
      this.reset();
      this.S = 0;
      this.speedHigh = false;
      if (this.bus.setSpeed) this.bus.setSpeed(false);
      this.PC = (this.bus.read(VEC_RESET) | (this.bus.read(VEC_RESET + 1) << 8)) & 0xFFFF;
    }

    // ── サイクル ──
    // [参照] 割り込み線は「サイクルを進めた直後、そのサイクルの読み書きの前」に見る(PceCpu::ProcessCpuCycle)。
    // 命令の最後のサイクルで見た値で、次に割り込むかが決まる。CLI の直後の 1 命令は割り込まれず、SEI の直後は割り込まれる、
    // という 6502 系の癖はここから出る(I を変えるのは最後のサイクルの後なので)。
    _tick() {
      this.cycles++;
      const b = this.bus;
      if (b.tick) b.tick();
      this.irqSample = (this.P & F_I) ? 0 : (b.irqLines ? b.irqLines() : 0);
    }
    rd(addr) { this._tick(); return this.bus.read(addr & 0xFFFF) & 0xFF; }
    wr(addr, value) { this._tick(); this.bus.write(addr & 0xFFFF, value & 0xFF); }
    /** 内部サイクル。バスが VDC/VCE の読み書きで CPU を 1 サイクル待たせる時にも呼ぶ */
    idle() { this._tick(); }

    // 時間を進めない読み書き(デバッグ/旧い呼び出し用)
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }

    _fetch() { const v = this.rd(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    _push(v) { this.wr(STACK + this.S, v); this.S = (this.S - 1) & 0xFF; }
    _pop() { this.S = (this.S + 1) & 0xFF; return this.rd(STACK + this.S); }
    // ゼロページ上の 2 バイト。上位は $FF の次が $00 に折り返す
    _zpWord(zp) { const lo = this.rd(ZP + zp); return lo | (this.rd(ZP + ((zp + 1) & 0xFF)) << 8); }
    _word(addr) { const lo = this.rd(addr); return lo | (this.rd((addr + 1) & 0xFFFF) << 8); }
    _nz(v) { this.P = (this.P & ~(F_N | F_Z)) | (v & 0x80) | (v ? 0 : F_Z); }

    /** オペランドの値。番地を指す種類なら 1 サイクル使って読む */
    _val() {
      if (this.mode >= MEM0 && this.mode <= MEM1) {
        // DDA(PCM)の採取(hesPlayer.js)が「$0806 へ書いた値は ROM のどこから読んだか」を知るのに使う
        this.lastDataAddr = this.ea;
        return this.rd(this.ea);
      }
      return this.imm;
    }

    // ── オペランドの取り込み(命令ごとのサイクルの前半) ──
    _operand(mode) {
      switch (mode) {
        case IMP: this.rd(this.PC); break;                       // 次のバイトを空読み
        case IMM: case REL: this.imm = this._fetch(); break;
        case ZPG: this.ea = ZP + this._fetch(); this._tick(); break;
        case ZPX: this.ea = ZP + ((this._fetch() + this.X) & 0xFF); this._tick(); break;
        case ZPY: this.ea = ZP + ((this._fetch() + this.Y) & 0xFF); this._tick(); break;
        case ABS: { const lo = this._fetch(); this.ea = lo | (this._fetch() << 8); this._tick(); break; }
        case ABX: { const lo = this._fetch(); this.ea = ((lo | (this._fetch() << 8)) + this.X) & 0xFFFF; this._tick(); break; }
        case ABY: { const lo = this._fetch(); this.ea = ((lo | (this._fetch() << 8)) + this.Y) & 0xFFFF; this._tick(); break; }
        case IZX: { const z = this._fetch(); this._tick(); this.ea = this._zpWord((z + this.X) & 0xFF); this._tick(); break; }
        case IZY: { const z = this._fetch(); this._tick(); this.ea = (this._zpWord(z) + this.Y) & 0xFFFF; this._tick(); break; }
        case IZP: { const z = this._fetch(); this._tick(); this.ea = this._zpWord(z); this._tick(); break; }
        case IND: { const lo = this._fetch(); this.ea = lo | (this._fetch() << 8); break; }
        case IAX: { const lo = this._fetch(); this.ea = ((lo | (this._fetch() << 8)) + this.X) & 0xFFFF; this._tick(); break; }
        case TZP: this.imm = this._fetch(); this.ea = ZP + this._fetch(); this._tick(); break;
        case TZX: this.imm = this._fetch(); this.ea = ZP + ((this._fetch() + this.X) & 0xFF); this._tick(); break;
        case TAB: { this.imm = this._fetch(); const lo = this._fetch(); this.ea = lo | (this._fetch() << 8); this._tick(); break; }
        case TAX: { this.imm = this._fetch(); const lo = this._fetch(); this.ea = ((lo | (this._fetch() << 8)) + this.X) & 0xFFFF; this._tick(); break; }
        default: break; // ZRL / BLK / NON は命令の中で読む
      }
    }

    /**
     * 割り込みへ入る(8 サイクル)。
     * [参照] PceCpu::ProcessIrq: 空読み 2 回 → PC 上位/下位 → P(B=0、D と T はそのまま積む)→ D と T を消して I=1 → ベクタ 2 バイト → 内部 1。
     */
    _interrupt(vector) {
      this.rd(this.PC); this.rd(this.PC);
      this._push(this.PC >> 8); this._push(this.PC & 0xFF);
      this._push(this.P & ~F_B);
      this.P = (this.P & ~(F_D | F_T)) | F_I;
      this.PC = this._word(vector);
      this._tick();
    }

    /**
     * 命令の後の割り込み判定。
     * [参照] PceCpu::Exec / ProcessIrq: 最後のサイクルで見た線(irqSample)で決める。優先はタイマ > IRQ1 > IRQ2。
     * タイマだけは「今もかかっているか」をもう一度見る(最後のサイクルで $1403 に書いて下げた時は入らない)。
     * IRQ1/IRQ2 は最後のサイクルの読み書きで下がっても入る。
     * ★ Mesen のコメントによれば、タイマと IRQ1/IRQ2 でこの扱いが違うのは実機では未確認で、ゲームの動きから決めた物。
     */
    _checkIrq() {
      const p = this.irqSample;
      if (!p) return;
      if ((p & LINE_TIMER) && (this.bus.irqLines() & LINE_TIMER)) this._interrupt(VEC_TIMER);
      else if (p & LINE_IRQ1) this._interrupt(VEC_IRQ1);
      else if (p & LINE_IRQ2) this._interrupt(VEC_IRQ2);
    }

    /** 1 命令(と、その後の割り込み入り)を実行し、使った CPU サイクル数を返す */
    step() {
      const c0 = this.cycles;
      // HES 用の待ち場所: INIT が RTS で戻った先。何も実行せず割り込みだけ待つ。
      // [推定] 実機には無い仕掛け(HES という形式の都合)。Mesen は I/O の空き番地 $1C00 に「自分へ飛ぶ BRA」を見せて同じ事をしている。
      // 4 サイクルの BRA を回すのと同じ間隔で割り込みを見るよう、4 サイクルずつ進める。
      if (this.idleAtSentinel && this.PC === CALL_SENTINEL) {
        this._tick(); this._tick(); this._tick(); this._tick();
        this._checkIrq();
        return this.cycles - c0;
      }
      // T フラグは命令の頭で取り込んで消す(効くのは次の 1 命令だけ)
      this.tMode = (this.P & F_T) !== 0;
      this.P &= ~F_T;
      const op = this._fetch();
      const mode = MODE[op];
      this.mode = mode;
      this._operand(mode);
      EXEC[op](this);
      this._checkIrq();
      return this.cycles - c0;
    }

    // ── HES の呼び出し枠(旧インターフェース) ──
    call(addr, maxSteps = 500000) {
      this.beginCall(addr);
      let steps = 0;
      while (this.PC !== CALL_SENTINEL && steps < maxSteps) { this.step(); steps++; }
      this.callActive = false;
      return steps;
    }
    beginCall(addr) {
      this.idleAtSentinel = true;
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.write(STACK + this.S, ret >> 8); this.S = (this.S - 1) & 0xFF;
      this.write(STACK + this.S, ret & 0xFF); this.S = (this.S - 1) & 0xFF;
      this.PC = addr & 0xFFFF;
      this.callActive = true;
    }
    stepCall() {
      const c = this.step();
      if (this.PC === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  // ── 演算 ──

  // T フラグつきの AND/ORA/EOR/ADC は、A の代わりにゼロページ,X のメモリを相手にする(読み → 内部 1 → 書き)
  function tRead(c) { const v = c.rd(ZP + c.X); c._tick(); return v; }
  function tWrite(c, v) { c._nz(v); c.wr(ZP + c.X, v); }

  function logic(c, f) {
    const v = c._val();
    if (c.tMode) { const m = tRead(c); tWrite(c, f(m, v) & 0xFF); }
    else { c.A = f(c.A, v) & 0xFF; c._nz(c.A); }
  }
  const fAnd = (a, b) => a & b, fOra = (a, b) => a | b, fEor = (a, b) => a ^ b;

  function ADC(c) {
    const v = c._val();
    const src = c.tMode ? tRead(c) : c.A;
    const cin = c.P & F_C;
    let r;
    if (c.P & F_D) {
      // 10 進は 1 サイクル多い。V は変わらない
      if (c.tMode) c._tick(); else c.rd(c.PC);
      r = (src & 0x0F) + (v & 0x0F) + cin;
      if (r > 0x09) r += 0x06;
      r = (src & 0xF0) + (v & 0xF0) + (r > 0x0F ? 0x10 : 0) + (r & 0x0F);
      if (r > 0x9F) r += 0x60;
    } else {
      r = src + v + cin;
      c.P = (~(src ^ v) & (src ^ r) & 0x80) ? (c.P | F_V) : (c.P & ~F_V);
    }
    c.P = (c.P & ~F_C) | (r > 0xFF ? F_C : 0);
    r &= 0xFF;
    if (c.tMode) tWrite(c, r); else { c.A = r; c._nz(r); }
  }

  // SBC は T フラグを見ない(いつも A)。10 進の余分な 1 サイクルだけ T で種類が変わる
  function SBC(c) {
    const v = (~c._val()) & 0xFF;
    const a = c.A, cin = c.P & F_C;
    let r;
    if (c.P & F_D) {
      if (c.tMode) c._tick(); else c.rd(c.PC);
      r = (a & 0x0F) + (v & 0x0F) + cin;
      if (r <= 0x0F) r -= 0x06;
      r = (a & 0xF0) + (v & 0xF0) + (r > 0x0F ? 0x10 : 0) + (r & 0x0F);
      if (r <= 0xFF) r -= 0x60;
    } else {
      r = a + v + cin;
      c.P = (~(a ^ v) & (a ^ r) & 0x80) ? (c.P | F_V) : (c.P & ~F_V);
    }
    c.P = (c.P & ~F_C) | (r > 0xFF ? F_C : 0);
    c.A = r & 0xFF; c._nz(c.A);
  }

  function compare(c, reg) {
    const v = c._val(), r = (reg - v) & 0xFF;
    c.P = (c.P & ~(F_C | F_Z | F_N)) | (reg >= v ? F_C : 0) | (reg === v ? F_Z : 0) | (r & 0x80);
  }

  function shl(c, v) { c.P = (c.P & ~F_C) | (v >> 7); const r = (v << 1) & 0xFF; c._nz(r); return r; }
  function shr(c, v) { c.P = (c.P & ~F_C) | (v & 1); const r = v >> 1; c._nz(r); return r; }
  function rol(c, v) { const ci = c.P & F_C; c.P = (c.P & ~F_C) | (v >> 7); const r = ((v << 1) | ci) & 0xFF; c._nz(r); return r; }
  function ror(c, v) { const ci = c.P & F_C; c.P = (c.P & ~F_C) | (v & 1); const r = (v >> 1) | (ci << 7); c._nz(r); return r; }
  const inc = (c, v) => { const r = (v + 1) & 0xFF; c._nz(r); return r; };
  const dec = (c, v) => { const r = (v - 1) & 0xFF; c._nz(r); return r; };
  // メモリを書き換える命令: 読み → 内部 1 → 書き
  function rmw(c, f) { const v = c.rd(c.ea); c._tick(); c.wr(c.ea, f(c, v)); }

  function branch(c, cond) {
    if (!cond) return;
    c.rd(c.PC); c._tick();
    c.PC = (c.PC + (c.imm < 0x80 ? c.imm : c.imm - 0x100)) & 0xFFFF;
  }

  // BIT は即値でも N/V をオペランドから取る
  function BIT(c) {
    const v = c._val();
    c.P = (c.P & ~(F_Z | F_V | F_N)) | (v & (F_V | F_N)) | ((c.A & v) ? 0 : F_Z);
  }
  // TSB/TRB/TST: N/V は元のメモリの値から。
  // Z は TSB/TRB が「書き戻す値が 0 か」、TST が (即値 & メモリ)=0。
  // ★食い違い: TSB/TRB の Z は参照どうしで合わない。
  //   - Mesen 2 のソース(PceCpu::TSB / TRB)と、手元の Mesen 2 の実物: 書き戻す値(TSB はメモリ|A、TRB はメモリ&~A)が 0 なら Z=1
  //   - SingleStepTests/huc6280 のベクタ(Mesen 製とされる): 4 命令 1 万件すべて (A & メモリ)=0 なら Z=1(65C02 と同じ)
  //   9a ではベクタに合わせていたが、9c で実ソフト 1 本(54 本中)が Mesen の実物と時刻で食い違い、原因がここだった(TSB の後の分岐)。
  //   実物とソースが一致している方に替えた([参照])。命令テストはこの 4 命令の Z だけ比べない(tools/cpu-test-core.js)。
  //   どちらが実機かは未確認(DESIGN-PCE-CAPTURE.md §10)。
  function TSB(c) {
    const v = c.rd(c.ea), r = v | c.A;
    c.P = (c.P & ~(F_Z | F_V | F_N)) | (v & (F_V | F_N)) | (r ? 0 : F_Z);
    c._tick(); c.wr(c.ea, r);
  }
  function TRB(c) {
    const v = c.rd(c.ea), r = v & ~c.A & 0xFF;
    c.P = (c.P & ~(F_Z | F_V | F_N)) | (v & (F_V | F_N)) | (r ? 0 : F_Z);
    c._tick(); c.wr(c.ea, r);
  }
  function TST(c) {
    c._tick();
    const v = c.rd(c.ea);
    c._tick();
    c.P = (c.P & ~(F_Z | F_V | F_N)) | (v & (F_V | F_N)) | ((v & c.imm) ? 0 : F_Z);
  }

  function setP(c, v) { c.P = v & ~F_B; } // B は P の中に無い(積む時だけ立つ)

  function BRK(c) {
    // オペコードの次の 1 バイトは読み飛ばす(_operand が IMM として読んでいる)。B=1 で積む。ベクタは IRQ2 と同じ
    c._push(c.PC >> 8); c._push(c.PC & 0xFF);
    c._push(c.P | F_B);
    c.P = (c.P & ~(F_D | F_T)) | F_I;
    c.PC = c._word(VEC_IRQ2);
    c._tick();
  }
  function JSR(c) {
    const lo = c._fetch();
    c._tick();
    c._push(c.PC >> 8); c._push(c.PC & 0xFF); // 上位バイトの番地を積む(RTS が +1 する)
    const hi = c._fetch();
    c._tick();
    c.PC = lo | (hi << 8);
  }
  function RTS(c) { c._tick(); const lo = c._pop(), hi = c._pop(); c._tick(); c._tick(); c.PC = ((lo | (hi << 8)) + 1) & 0xFFFF; }
  function RTI(c) { c._tick(); setP(c, c._pop()); const lo = c._pop(), hi = c._pop(); c.PC = lo | (hi << 8); c._tick(); }
  function BSR(c) {
    c._tick();
    const ret = (c.PC - 1) & 0xFFFF;
    c._push(ret >> 8); c._push(ret & 0xFF);
    c._tick(); c._tick(); c._tick();
    c.PC = (c.PC + (c.imm < 0x80 ? c.imm : c.imm - 0x100)) & 0xFFFF;
  }
  function BRA(c) { c._tick(); c._tick(); c.PC = (c.PC + (c.imm < 0x80 ? c.imm : c.imm - 0x100)) & 0xFFFF; }

  // [参照] CSH/CSL は 3 サイクルで、最後の内部サイクルは切り替わった後の速さで進む(PceCpu::CSL / CSH)
  function speed(c, high) { c.speedHigh = high; if (c.bus.setSpeed) c.bus.setSpeed(high); c._tick(); }

  // [参照] ST0/ST1/ST2 は内部 1 + 書き 1。書き先は VDC のポートで、MPR を通らない(PceMemoryManager::WriteVdc)。
  // VDC に書いた時の「CPU が 1 サイクル待つ」はバス側(stWrite の中)が cpu.idle() で足す。
  function ST(c, port) { c._tick(); c._tick(); if (c.bus.stWrite) c.bus.stWrite(port, c.imm); }

  // TAM/TMA。オペランドは MPR のビット並び。
  // [参照] TAM は 0 なら何もしない。TMA は 0 なら「最後に通した値」、複数ビットなら OR(PceMemoryManager::SetMprValue / GetMprValue)。
  // ベクタは 1 ビットだけの場合と TAM の複数ビットを通る。
  function TAM(c) {
    c._tick(); c._tick(); c._tick();
    const m = c.imm;
    if (!m) return;
    c.mprBuffer = c.A;
    for (let i = 0; i < 8; i++) if (m & (1 << i)) c.bus.setMpr(i, c.A);
  }
  function TMA(c) {
    c._tick(); c._tick();
    const m = c.imm;
    if (!m) { c.A = c.mprBuffer; return; }
    let v = 0;
    for (let i = 0; i < 8; i++) if (m & (1 << i)) v |= c.bus.getMpr(i);
    c.mprBuffer = v; c.A = v;
  }

  // ブロック転送: 17 + 6×個数 サイクル。Y/A/X を積んでから始め、終わりに戻す。フラグは変えない。長さ 0 は 65536 個。
  // ds/dd: +1 / -1 / 0、2 = 行って戻る(+1, -1, +1, …)
  function block(c, ds, dd) {
    c.rd(c.PC); c._tick();
    c._push(c.Y); c._push(c.A); c._push(c.X);
    let src = c._fetch(); src |= c._fetch() << 8;
    let dst = c._fetch(); dst |= c._fetch() << 8;
    let len = c._fetch(); len |= c._fetch() << 8;
    c._tick();
    let n = 0;
    do {
      c._tick();
      const v = c.rd(src);
      c._tick();
      c.wr(dst, v);
      c._tick(); c._tick();
      src = (src + (ds === 2 ? ((n & 1) ? -1 : 1) : ds)) & 0xFFFF;
      dst = (dst + (dd === 2 ? ((n & 1) ? -1 : 1) : dd)) & 0xFFFF;
      n++;
      len = (len - 1) & 0xFFFF;
    } while (len);
    c._tick();
    c.X = c._pop(); c.A = c._pop(); c.Y = c._pop();
  }

  function bitBranch(c, bit, want) {
    const zp = c._fetch();
    c._tick();
    const off = c._fetch();
    c._tick();
    const v = c.rd(ZP + zp);
    if (((v >> bit) & 1) === want) { c._tick(); c._tick(); c.PC = (c.PC + (off < 0x80 ? off : off - 0x100)) & 0xFFFF; }
  }
  function bitSet(c, bit, on) {
    const v = c.rd(c.ea);
    c._tick(); c._tick();
    c.wr(c.ea, on ? (v | (1 << bit)) : (v & ~(1 << bit)));
  }

  // ── 命令表 ──
  const MODE = new Uint8Array(256); // 既定 IMP
  const EXEC = new Array(256);
  const NAME = new Array(256).fill('NOP');
  const NOP = () => {}; // 空いているオペコードは全部 2 サイクルの NOP
  EXEC.fill(NOP);
  function def(name, fn, list) { for (let i = 0; i < list.length; i += 2) { const op = list[i]; MODE[op] = list[i + 1]; EXEC[op] = fn; NAME[op] = name; } }

  // A を相手にする 8 種類の並び(ORA/AND/EOR/ADC/STA/LDA/CMP/SBC は同じ形。STA に即値は無い)
  const acc8 = (b) => [b + 0x09, IMM, b + 0x05, ZPG, b + 0x15, ZPX, b + 0x12, IZP, b + 0x0D, ABS, b + 0x1D, ABX, b + 0x19, ABY, b + 0x01, IZX, b + 0x11, IZY];
  def('ORA', (c) => logic(c, fOra), acc8(0x00));
  def('AND', (c) => logic(c, fAnd), acc8(0x20));
  def('EOR', (c) => logic(c, fEor), acc8(0x40));
  def('ADC', ADC, acc8(0x60));
  def('STA', (c) => c.wr(c.ea, c.A), acc8(0x80).slice(2));
  def('LDA', (c) => { c.A = c._val(); c._nz(c.A); }, acc8(0xA0));
  def('CMP', (c) => compare(c, c.A), acc8(0xC0));
  def('SBC', SBC, acc8(0xE0));

  def('LDX', (c) => { c.X = c._val(); c._nz(c.X); }, [0xA2, IMM, 0xA6, ZPG, 0xB6, ZPY, 0xAE, ABS, 0xBE, ABY]);
  def('LDY', (c) => { c.Y = c._val(); c._nz(c.Y); }, [0xA0, IMM, 0xA4, ZPG, 0xB4, ZPX, 0xAC, ABS, 0xBC, ABX]);
  def('STX', (c) => c.wr(c.ea, c.X), [0x86, ZPG, 0x96, ZPY, 0x8E, ABS]);
  def('STY', (c) => c.wr(c.ea, c.Y), [0x84, ZPG, 0x94, ZPX, 0x8C, ABS]);
  def('STZ', (c) => c.wr(c.ea, 0), [0x64, ZPG, 0x74, ZPX, 0x9C, ABS, 0x9E, ABX]);
  def('CPX', (c) => compare(c, c.X), [0xE0, IMM, 0xE4, ZPG, 0xEC, ABS]);
  def('CPY', (c) => compare(c, c.Y), [0xC0, IMM, 0xC4, ZPG, 0xCC, ABS]);
  def('BIT', BIT, [0x89, IMM, 0x24, ZPG, 0x34, ZPX, 0x2C, ABS, 0x3C, ABX]);
  def('TSB', TSB, [0x04, ZPG, 0x0C, ABS]);
  def('TRB', TRB, [0x14, ZPG, 0x1C, ABS]);
  def('TST', TST, [0x83, TZP, 0x93, TAB, 0xA3, TZX, 0xB3, TAX]);

  const rmw4 = (b) => [b + 0x06, ZPG, b + 0x16, ZPX, b + 0x0E, ABS, b + 0x1E, ABX];
  def('ASL', (c) => rmw(c, shl), rmw4(0x00));
  def('ROL', (c) => rmw(c, rol), rmw4(0x20));
  def('LSR', (c) => rmw(c, shr), rmw4(0x40));
  def('ROR', (c) => rmw(c, ror), rmw4(0x60));
  def('DEC', (c) => rmw(c, dec), rmw4(0xC0));
  def('INC', (c) => rmw(c, inc), rmw4(0xE0));
  def('ASL', (c) => { c.A = shl(c, c.A); }, [0x0A, IMP]);
  def('ROL', (c) => { c.A = rol(c, c.A); }, [0x2A, IMP]);
  def('LSR', (c) => { c.A = shr(c, c.A); }, [0x4A, IMP]);
  def('ROR', (c) => { c.A = ror(c, c.A); }, [0x6A, IMP]);
  def('INC', (c) => { c.A = inc(c, c.A); }, [0x1A, IMP]);
  def('DEC', (c) => { c.A = dec(c, c.A); }, [0x3A, IMP]);
  def('INX', (c) => { c.X = inc(c, c.X); }, [0xE8, IMP]);
  def('INY', (c) => { c.Y = inc(c, c.Y); }, [0xC8, IMP]);
  def('DEX', (c) => { c.X = dec(c, c.X); }, [0xCA, IMP]);
  def('DEY', (c) => { c.Y = dec(c, c.Y); }, [0x88, IMP]);

  def('BPL', (c) => branch(c, !(c.P & F_N)), [0x10, REL]);
  def('BMI', (c) => branch(c, c.P & F_N), [0x30, REL]);
  def('BVC', (c) => branch(c, !(c.P & F_V)), [0x50, REL]);
  def('BVS', (c) => branch(c, c.P & F_V), [0x70, REL]);
  def('BCC', (c) => branch(c, !(c.P & F_C)), [0x90, REL]);
  def('BCS', (c) => branch(c, c.P & F_C), [0xB0, REL]);
  def('BNE', (c) => branch(c, !(c.P & F_Z)), [0xD0, REL]);
  def('BEQ', (c) => branch(c, c.P & F_Z), [0xF0, REL]);
  def('BRA', BRA, [0x80, REL]);
  def('BSR', BSR, [0x44, REL]);
  def('JMP', (c) => { c.PC = c.ea; }, [0x4C, ABS]);                                      // 番地 2 バイト+内部 1(4 サイクル)
  def('JMP', (c) => { c._tick(); c.PC = c._word(c.ea); c._tick(); }, [0x6C, IND]);        // (abs)。ページ境界でも正しく読む
  def('JMP', (c) => { c.PC = c._word(c.ea); c._tick(); }, [0x7C, IAX]);                   // (abs,X)
  def('JSR', JSR, [0x20, NON]);
  def('RTS', RTS, [0x60, IMP]);
  def('RTI', RTI, [0x40, IMP]);
  def('BRK', BRK, [0x00, IMM]);

  def('PHA', (c) => c._push(c.A), [0x48, IMP]);
  def('PHX', (c) => c._push(c.X), [0xDA, IMP]);
  def('PHY', (c) => c._push(c.Y), [0x5A, IMP]);
  def('PHP', (c) => c._push(c.P | F_B), [0x08, IMP]);
  def('PLA', (c) => { c._tick(); c.A = c._pop(); c._nz(c.A); }, [0x68, IMP]);
  def('PLX', (c) => { c._tick(); c.X = c._pop(); c._nz(c.X); }, [0xFA, IMP]);
  def('PLY', (c) => { c._tick(); c.Y = c._pop(); c._nz(c.Y); }, [0x7A, IMP]);
  def('PLP', (c) => { c._tick(); setP(c, c._pop()); }, [0x28, IMP]);

  def('TAX', (c) => { c.X = c.A; c._nz(c.X); }, [0xAA, IMP]);
  def('TAY', (c) => { c.Y = c.A; c._nz(c.Y); }, [0xA8, IMP]);
  def('TXA', (c) => { c.A = c.X; c._nz(c.A); }, [0x8A, IMP]);
  def('TYA', (c) => { c.A = c.Y; c._nz(c.A); }, [0x98, IMP]);
  def('TSX', (c) => { c.X = c.S; c._nz(c.X); }, [0xBA, IMP]);
  def('TXS', (c) => { c.S = c.X; }, [0x9A, IMP]);
  // レジスタの入れ替えは 3 サイクル、クリアは 2 サイクル。どちらもフラグは変えない
  def('SXY', (c) => { c._tick(); const t = c.X; c.X = c.Y; c.Y = t; }, [0x02, IMP]);
  def('SAX', (c) => { c._tick(); const t = c.A; c.A = c.X; c.X = t; }, [0x22, IMP]);
  def('SAY', (c) => { c._tick(); const t = c.A; c.A = c.Y; c.Y = t; }, [0x42, IMP]);
  def('CLA', (c) => { c.A = 0; }, [0x62, IMP]);
  def('CLX', (c) => { c.X = 0; }, [0x82, IMP]);
  def('CLY', (c) => { c.Y = 0; }, [0xC2, IMP]);

  def('CLC', (c) => { c.P &= ~F_C; }, [0x18, IMP]);
  def('SEC', (c) => { c.P |= F_C; }, [0x38, IMP]);
  def('CLI', (c) => { c.P &= ~F_I; }, [0x58, IMP]);
  def('SEI', (c) => { c.P |= F_I; }, [0x78, IMP]);
  def('CLV', (c) => { c.P &= ~F_V; }, [0xB8, IMP]);
  def('CLD', (c) => { c.P &= ~F_D; }, [0xD8, IMP]);
  def('SED', (c) => { c.P |= F_D; }, [0xF8, IMP]);
  def('SET', (c) => { c.P |= F_T; }, [0xF4, IMP]);
  def('CSL', (c) => speed(c, false), [0x54, IMP]);
  def('CSH', (c) => speed(c, true), [0xD4, IMP]);

  def('ST0', (c) => ST(c, 0), [0x03, IMM]);
  def('ST1', (c) => ST(c, 2), [0x13, IMM]);
  def('ST2', (c) => ST(c, 3), [0x23, IMM]);
  def('TMA', TMA, [0x43, IMM]);
  def('TAM', TAM, [0x53, IMM]);
  def('TII', (c) => block(c, 1, 1), [0x73, BLK]);
  def('TDD', (c) => block(c, -1, -1), [0xC3, BLK]);
  def('TIN', (c) => block(c, 1, 0), [0xD3, BLK]);
  def('TIA', (c) => block(c, 1, 2), [0xE3, BLK]);
  def('TAI', (c) => block(c, 2, 1), [0xF3, BLK]);
  for (let bit = 0; bit < 8; bit++) {
    def('RMB' + bit, (c) => bitSet(c, bit, false), [bit * 0x10 + 0x07, ZPG]);
    def('SMB' + bit, (c) => bitSet(c, bit, true), [bit * 0x10 + 0x87, ZPG]);
    def('BBR' + bit, (c) => bitBranch(c, bit, 0), [bit * 0x10 + 0x0F, ZRL]);
    def('BBS' + bit, (c) => bitBranch(c, bit, 1), [bit * 0x10 + 0x8F, ZRL]);
  }

  Emu.CPUHuC6280 = CPUHuC6280;
  Emu.HUC6280_FLAGS = { C: F_C, Z: F_Z, I: F_I, D: F_D, B: F_B, T: F_T, V: F_V, N: F_N };
  Emu.HUC6280_IRQ = { IRQ2: LINE_IRQ2, IRQ1: LINE_IRQ1, TIMER: LINE_TIMER };
  Emu.HUC6280_OPS = NAME.map((name, op) => ({ mnemonic: name, mode: MODE[op] }));
})(window);
