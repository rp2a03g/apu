/*
 * PlayStation カーネル(BIOS)の高水準模倣(HLE)
 * MML.Emu.PsxBios
 *
 * BIOS ROM は同梱できないので、PSF の音源ドライバが使うカーネル機能を JS で肩代わりする。
 * 方針は PCSX / Highly Experimental の HLE と同じ:
 *   - RAM 0xA0/0xB0/0xC0 の呼び出し口と 0x80 の例外ベクタに、BIOS 領域(0xBFC01000..)の
 *     「トラップ番地」へ飛ぶ 4 命令のスタブを置く。CPU がトラップ番地に来たら JS で処理して戻る。
 *   - 例外(割込み): レジスタを TCB に退避 → カーネルイベント(ルートカウンタ/VBlank)を配送 →
 *     SysEnqIntRP で登録された利用者ハンドラ列を verifier/handler の順に呼ぶ →
 *     SetCustomExitFromException(HookEntryInt) の jmp_buf があればそこへ longjmp(libetc の
 *     コールバック機構がこれ)、無ければ I_STAT を ack して ReturnFromException。
 *   - SYSCALL: EnterCriticalSection(1)/ExitCriticalSection(2) は SR の IEp/IM2 を操作して即復帰。
 *   - イベント(OpenEvent/EnableEvent/DeliverEvent/WaitEvent/TestEvent…)、ルートカウンタ
 *     (SetRCnt/StartRCnt…)、ヒープ(InitHeap/malloc/free)、文字列/メモリ関数、printf(ログのみ)。
 *   - ネストした呼び出し(イベントハンドラ等)は softCall(): ra を「戻りトラップ番地」にして
 *     CPU を回し、そこへ戻ってきたら抜ける。その間も bus.sync で周辺を進める。
 *
 * 未知の関数番号は「0 を返す」だけにして unknownCalls に記録する(黙って壊れない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const TRAP_A0 = 0xBFC01000 | 0, TRAP_B0 = 0xBFC01010 | 0, TRAP_C0 = 0xBFC01020 | 0;
  const TRAP_EXC = 0xBFC01030 | 0, TRAP_RET = 0xBFC01040 | 0, TRAP_IDLE = 0xBFC01050 | 0;
  const KERNEL_STACK = 0x8000FF00 | 0;       // HLE が使うカーネルスタック
  const KERNEL_ALLOC_BASE = 0x8000E000 | 0;  // alloc_kernel_memory の払い出し先
  const EV_FREE = 0, EV_DISABLED = 0x1000, EV_ACTIVE = 0x2000, EV_READY = 0x4000;
  const EvMdINTR = 0x1000, EvMdNOINTR = 0x2000;
  const EvSpINT = 0x0002;
  const SOFTCALL_STEP_LIMIT = 20000000;

  // レジスタ番号
  const A0 = 4, A1 = 5, A2 = 6, A3 = 7, V0 = 2, V1 = 3, T1 = 9, SP = 29, FP = 30, RA = 31, GP = 28;

  class PsxBios {
    constructor(bus, cpu) {
      this.bus = bus; this.cpu = cpu;
      this.ttyLog = [];
      this.unknownCalls = new Map();
      this.reset();
      bus.onTrap = (c, pc) => this.onTrap(c, pc);
    }

    reset() {
      this.events = [];
      for (let i = 0; i < 256; i++) this.events.push({ status: EV_FREE, cls: 0, spec: 0, mode: 0, func: 0 });
      this.chains = [[], [], [], []];
      this.jmpBuf = 0;
      this.tcb = null;
      this.autoAck = [false, true, true, true]; // [vblank, tmr0, tmr1, tmr2]
      this.heapBase = 0; this.heapSize = 0; this.heapBlocks = [];
      this.kernelAllocPtr = KERNEL_ALLOC_BASE;
      this.randSeed = 0x12345678;
      this.softDepth = 0; this.softReturned = false;
      this.inException = false;
      this.lastExceptionCount = -1;
      this.sideEffectSeq = 0;
      this.exceptionDepth = 0;
      this.halted = false; this.haltReason = '';
      this.badExceptions = 0;
      this.ttyLog.length = 0;
      this.stats = { a0: 0, b0: 0, c0: 0, exc: 0, syscall: 0, softCalls: 0, events: 0 };
    }

    /** RAM にスタブを置く(bus.reset 後に呼ぶ) */
    install() {
      const bus = this.bus;
      // 例外ベクタは k0、関数呼び出し口は t0 を使う(実機 BIOS と同じ)。
      // 呼び出し口で k0 を使うと、スタブ実行中に割込みが入ったとき例外入口が k0 を
      // 上書きし、復帰後の jr k0 が例外トラップへ飛んで無限ループになる。
      const stub = (at, target, reg) => {
        const hi = (target >>> 16) & 0xFFFF, lo = target & 0xFFFF;
        bus.write32(at, (0x0F << 26) | (reg << 16) | hi);                  // lui reg, hi
        bus.write32(at + 4, (0x0D << 26) | (reg << 21) | (reg << 16) | lo); // ori reg, reg, lo
        bus.write32(at + 8, (reg << 21) | 0x08);                          // jr reg
        bus.write32(at + 12, 0);                                          // nop
      };
      stub(0x80, TRAP_EXC, 26);
      stub(0xA0, TRAP_A0, 8); stub(0xB0, TRAP_B0, 8); stub(0xC0, TRAP_C0, 8);
      // 0xBFC00000(リセットベクタ)にも来たら halt
      bus.protectStubs = true;
    }

    // ── トラップ入口 ──────────────────────────────────────
    onTrap(cpu, pc) {
      switch (pc | 0) {
        // 状態を読むだけの呼び出し(TestEvent/WaitEvent)以外は、アイドル判定を崩すため sideEffectSeq を進める
        case TRAP_A0: this.stats.a0++; this.sideEffectSeq++; this.callA0(cpu.r[T1] & 0xFF); return true;
        case TRAP_B0: { this.stats.b0++; const n = cpu.r[T1] & 0xFF; if (n !== 0x0A && n !== 0x0B) this.sideEffectSeq++; this.callB0(n); return true; }
        case TRAP_C0: this.stats.c0++; this.sideEffectSeq++; this.callC0(cpu.r[T1] & 0xFF); return true;
        case TRAP_EXC:
          this.sideEffectSeq++;
          if (cpu.exceptionCount === this.lastExceptionCount) { this.halt('jumped to exception vector without an exception'); return true; }
          this.lastExceptionCount = cpu.exceptionCount;
          this.exception(); return true;
        case TRAP_RET: this.softReturned = true; return true;
        case TRAP_IDLE: return true; // 何もしない(時間だけ進む)
        default:
          this.halt('unexpected pc in BIOS area: 0x' + (pc >>> 0).toString(16));
          return true;
      }
    }

    halt(reason) {
      if (!this.halted) { this.halted = true; this.haltReason = reason; }
      this.cpu.halted = true;
    }

    /** 呼び出し元(ra)へ戻る */
    ret(v0) {
      const cpu = this.cpu;
      if (v0 !== undefined) cpu.r[V0] = v0 | 0;
      cpu.pc = cpu.r[RA]; cpu.nextPc = (cpu.pc + 4) | 0;
      cpu.branchDelay = false;
    }

    /** 同じ関数をもう一度実行させる(ビジーウェイト相当。割込みは間に入れる) */
    retry() {
      const cpu = this.cpu;
      cpu.nextPc = (cpu.pc + 4) | 0; // pc は変えない(トラップに留まる)
      cpu.branchDelay = false;
    }

    unknown(table, n) {
      const key = table + ':' + n.toString(16).padStart(2, '0');
      this.unknownCalls.set(key, (this.unknownCalls.get(key) || 0) + 1);
      this.ret(0);
    }

    // ── ネスト呼び出し ────────────────────────────────────
    /**
     * addr の MIPS 関数を呼び、戻るまで CPU を回す。戻り値は v0。
     * 呼び出し中のレジスタは全て保存/復元する(呼び出し元の状態を壊さない)。
     */
    softCall(addr, args) {
      const cpu = this.cpu, bus = this.bus;
      if (!addr) return 0;
      this.stats.softCalls++;
      const savedR = Int32Array.from(cpu.r);
      const saved = { pc: cpu.pc, nextPc: cpu.nextPc, hi: cpu.hi, lo: cpu.lo, branchDelay: cpu.branchDelay, returned: this.softReturned };
      cpu.branchDelay = false;
      if (args) for (let i = 0; i < args.length && i < 4; i++) cpu.r[A0 + i] = args[i] | 0;
      cpu.r[RA] = TRAP_RET;
      cpu.r[SP] = (KERNEL_STACK - 0x100 * this.softDepth) | 0;
      cpu.pc = addr | 0; cpu.nextPc = (addr + 4) | 0;
      this.softDepth++;
      this.softReturned = false;
      let steps = 0;
      while (!this.softReturned && !cpu.halted) {
        cpu.step();
        if ((++steps & 0xFF) === 0) bus.sync(cpu.cycles);
        if (steps > SOFTCALL_STEP_LIMIT) { this.halt('softCall runaway at 0x' + (addr >>> 0).toString(16)); break; }
      }
      this.softDepth--;
      const result = cpu.r[V0];
      cpu.r.set(savedR);
      cpu.pc = saved.pc; cpu.nextPc = saved.nextPc; cpu.hi = saved.hi; cpu.lo = saved.lo;
      cpu.branchDelay = saved.branchDelay;
      this.softReturned = saved.returned;
      return result;
    }

    // ── 例外 ──────────────────────────────────────────────
    exception() {
      const cpu = this.cpu, bus = this.bus;
      const code = (cpu.cause >> 2) & 0x1F;
      this.stats.exc++;
      if (code === 8) { // SYSCALL
        this.stats.syscall++;
        const fn = cpu.r[A0];
        if (fn === 1) { cpu.r[V0] = (cpu.sr & 0x4) ? 1 : 0; cpu.sr &= ~0x404; }      // EnterCriticalSection
        else if (fn === 2) { cpu.sr |= 0x404; cpu.r[V0] = 0; }                        // ExitCriticalSection
        else if (fn === 3) { cpu.r[V0] = 0; }                                         // ChangeThreadSubFunction
        cpu.pc = (cpu.epc + 4) | 0; cpu.nextPc = (cpu.pc + 4) | 0;
        cpu.rfe();
        cpu.branchDelay = false;
        return;
      }
      if (code === 0) { // 割込み
        this.saveTcb();
        this.exceptionDepth++;
        const pending = bus.iStat & bus.iMask;
        // カーネルのタイマ/VBlank ハンドラ相当: イベント配送
        if (pending & 1) {
          this.deliverEvent(0xF2000003, EvSpINT);
          this.deliverEvent(0xF0000001, EvSpINT);
          if (this.autoAck[0]) { bus.iStat &= ~1; bus.updateIrqLine(); }
        }
        for (let i = 0; i < 3; i++) {
          const bit = 0x10 << i;
          if (pending & bit) {
            this.deliverEvent(0xF2000000 + i, EvSpINT);
            if (this.autoAck[1 + i]) { bus.iStat &= ~bit; bus.updateIrqLine(); }
          }
        }
        if (pending & 0x200) this.deliverEvent(0xF0000009, EvSpINT); // SPU
        if (pending & 0x008) this.deliverEvent(0xF0000004, EvSpINT); // (慣例的な DMA クラス)
        // 利用者の割込みハンドラ列(SysEnqIntRP)
        for (let prio = 0; prio < 4; prio++) {
          const chain = this.chains[prio];
          for (let k = 0; k < chain.length; k++) {
            const el = chain[k];
            const verifier = bus.read32(el + 8), handler = bus.read32(el + 4);
            if (!verifier) continue;
            const v = this.softCall(verifier, []);
            if (v !== 0 && handler) this.softCall(handler, [v]);
          }
        }
        this.exceptionDepth--;
        if (this.jmpBuf) {
          // libetc のコールバック機構へ longjmp(I_STAT の ack は向こうがやる)
          const jb = this.jmpBuf;
          cpu.r[RA] = bus.read32(jb); cpu.r[SP] = bus.read32(jb + 4); cpu.r[FP] = bus.read32(jb + 8);
          for (let i = 0; i < 8; i++) cpu.r[16 + i] = bus.read32(jb + 12 + i * 4);
          cpu.r[GP] = bus.read32(jb + 44);
          cpu.r[V0] = 1;
          cpu.pc = cpu.r[RA]; cpu.nextPc = (cpu.pc + 4) | 0; cpu.branchDelay = false;
          return;
        }
        // 誰も処理しないビットが残ると無限に再入するので、保留していた分は全て ack する
        bus.iStat &= ~pending; bus.updateIrqLine();
        this.returnFromException();
        return;
      }
      // その他の例外(アドレスエラー/不正命令/オーバーフロー): 実機なら SystemError で停止。
      // 変換用途では「その命令を飛ばして続行」し、多発したら止める。
      this.badExceptions++;
      if (this.badExceptions === 1) this.ttyLog.push(`[exception code ${code} at 0x${(cpu.epc >>> 0).toString(16)} badvaddr=0x${(cpu.badVaddr >>> 0).toString(16)}]`);
      if (this.badExceptions > 10000) { this.halt('too many CPU exceptions (code ' + code + ')'); return; }
      cpu.pc = (cpu.epc + 4) | 0; cpu.nextPc = (cpu.pc + 4) | 0;
      cpu.rfe(); cpu.branchDelay = false;
    }

    saveTcb() {
      const cpu = this.cpu;
      this.tcb = { r: Int32Array.from(cpu.r), hi: cpu.hi, lo: cpu.lo, epc: cpu.epc, sr: cpu.sr };
    }

    returnFromException() {
      const cpu = this.cpu;
      const t = this.tcb;
      if (!t) { this.halt('ReturnFromException without saved context'); return; }
      cpu.r.set(t.r); cpu.hi = t.hi; cpu.lo = t.lo;
      cpu.sr = t.sr;
      cpu.pc = t.epc; cpu.nextPc = (t.epc + 4) | 0;
      cpu.rfe();
      cpu.branchDelay = false;
      cpu.cause &= ~0x400; // 再評価させる
    }

    // ── イベント ──────────────────────────────────────────
    deliverEvent(cls, spec) {
      for (let i = 0; i < this.events.length; i++) {
        const ev = this.events[i];
        if (ev.status !== EV_ACTIVE || (ev.cls >>> 0) !== (cls >>> 0) || ev.spec !== spec) continue;
        this.stats.events++;
        if (ev.mode === EvMdINTR && ev.func) this.softCall(ev.func, []);
        else ev.status = EV_READY;
      }
    }
    eventOf(id) {
      const idx = id & 0xFFFF;
      if ((id & 0xFFFF0000) !== (0xF1000000 | 0) || idx >= this.events.length) return null;
      return this.events[idx];
    }

    // ── A0 ────────────────────────────────────────────────
    callA0(n) {
      const cpu = this.cpu, bus = this.bus, r = cpu.r;
      const a0 = r[A0], a1 = r[A1], a2 = r[A2];
      switch (n) {
        case 0x0E: this.ret(Math.abs(a0) | 0); return;              // abs
        case 0x0F: this.ret(Math.abs(a0) | 0); return;              // labs
        case 0x10: case 0x11: this.ret(parseInt(bus.readString(a0, 32), 10) | 0); return; // atoi/atol
        case 0x13: { // setjmp
          bus.write32(a0, r[RA]); bus.write32(a0 + 4, r[SP]); bus.write32(a0 + 8, r[FP]);
          for (let i = 0; i < 8; i++) bus.write32(a0 + 12 + i * 4, r[16 + i]);
          bus.write32(a0 + 44, r[GP]);
          this.ret(0); return;
        }
        case 0x14: { // longjmp
          r[RA] = bus.read32(a0); r[SP] = bus.read32(a0 + 4); r[FP] = bus.read32(a0 + 8);
          for (let i = 0; i < 8; i++) r[16 + i] = bus.read32(a0 + 12 + i * 4);
          r[GP] = bus.read32(a0 + 44);
          this.ret(a1); return;
        }
        case 0x15: { // strcat
          let d = a0; while (bus.read8(d)) d++;
          let s = a1, c; do { c = bus.read8(s++); bus.write8(d++, c); } while (c);
          this.ret(a0); return;
        }
        case 0x16: { // strncat
          let d = a0; while (bus.read8(d)) d++;
          let s = a1, i = 0;
          for (; i < a2; i++) { const c = bus.read8(s++); if (!c) break; bus.write8(d++, c); }
          bus.write8(d, 0); this.ret(a0); return;
        }
        case 0x17: { // strcmp
          let p = a0, q = a1;
          for (;;) { const x = bus.read8(p++), y = bus.read8(q++); if (x !== y) { this.ret(x - y); return; } if (!x) { this.ret(0); return; } }
        }
        case 0x18: { // strncmp
          let p = a0, q = a1;
          for (let i = 0; i < a2; i++) { const x = bus.read8(p++), y = bus.read8(q++); if (x !== y) { this.ret(x - y); return; } if (!x) break; }
          this.ret(0); return;
        }
        case 0x19: { let d = a0, s = a1, c; do { c = bus.read8(s++); bus.write8(d++, c); } while (c); this.ret(a0); return; } // strcpy
        case 0x1A: { // strncpy
          let d = a0, s = a1, i = 0, ended = false;
          for (; i < a2; i++) { let c = 0; if (!ended) { c = bus.read8(s++); if (!c) ended = true; } bus.write8(d++, c); }
          this.ret(a0); return;
        }
        case 0x1B: { let p = a0, len = 0; if (a0) while (bus.read8(p++)) len++; this.ret(len); return; } // strlen
        case 0x1C: case 0x1E: { // index/strchr
          let p = a0; for (;;) { const c = bus.read8(p); if (c === (a1 & 0xFF)) { this.ret(p); return; } if (!c) { this.ret(0); return; } p++; }
        }
        case 0x1D: case 0x1F: { // rindex/strrchr
          let p = a0, found = 0; for (;;) { const c = bus.read8(p); if (c === (a1 & 0xFF)) found = p; if (!c) break; p++; } this.ret(found); return;
        }
        case 0x24: { // strstr
          const hay = bus.readString(a0, 4096), needle = bus.readString(a1, 4096);
          const idx = hay.indexOf(needle); this.ret(idx < 0 ? 0 : (a0 + idx)); return;
        }
        case 0x25: this.ret((a0 >= 0x61 && a0 <= 0x7A) ? a0 - 0x20 : a0); return; // toupper
        case 0x26: this.ret((a0 >= 0x41 && a0 <= 0x5A) ? a0 + 0x20 : a0); return; // tolower
        case 0x27: this.memmove(a1, a0, a2); this.ret(a1); return;    // bcopy(src,dst,len)
        case 0x28: this.memset(a0, 0, a1); this.ret(a0); return;      // bzero
        case 0x29: this.ret(this.memcmp(a0, a1, a2)); return;         // bcmp
        case 0x2A: this.memmove(a0, a1, a2); this.ret(a0); return;    // memcpy
        case 0x2B: this.memset(a0, a1, a2); this.ret(a0); return;     // memset
        case 0x2C: this.memmove(a0, a1, a2); this.ret(a0); return;    // memmove
        case 0x2D: this.ret(this.memcmp(a0, a1, a2)); return;         // memcmp
        case 0x2E: { for (let i = 0; i < a2; i++) if (bus.read8(a0 + i) === (a1 & 0xFF)) { this.ret(a0 + i); return; } this.ret(0); return; } // memchr
        case 0x2F: { this.randSeed = (Math.imul(this.randSeed, 1103515245) + 12345) | 0; this.ret((this.randSeed >>> 16) & 0x7FFF); return; } // rand
        case 0x30: this.randSeed = a0; this.ret(0); return;           // srand
        case 0x33: this.ret(this.malloc(a0)); return;
        case 0x34: this.free(a0); this.ret(0); return;
        case 0x37: { const p = this.malloc(Math.imul(a0, a1)); if (p) this.memset(p, 0, Math.imul(a0, a1)); this.ret(p); return; } // calloc
        case 0x38: { // realloc
          if (!a0) { this.ret(this.malloc(a1)); return; }
          const blk = this.heapBlocks.find(b => b.addr === (a0 | 0));
          const p = this.malloc(a1);
          if (p && blk) this.memmove(p, a0, Math.min(blk.size, a1));
          this.free(a0); this.ret(p); return;
        }
        case 0x39: this.heapBase = a0 | 0; this.heapSize = a1 | 0; this.heapBlocks = []; this.ret(0); return; // InitHeap
        case 0x3C: this.tty(String.fromCharCode(a0 & 0xFF)); this.ret(a0); return; // std_out_putchar
        case 0x3E: this.tty(bus.readString(a0, 1024) + '\n'); this.ret(0); return; // std_out_puts
        case 0x3F: this.printf(); this.ret(0); return;
        case 0x40: this.halt('SystemErrorUnresolvedException'); return;
        case 0x44: this.ret(0); return;                               // FlushCache
        case 0x4D: this.ret(bus.read32(0x1F801814)); return;          // GetGPUStatus
        case 0x4E: this.ret(0); return;                               // gpu_sync
        case 0x46: case 0x47: case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: this.ret(0); return; // GPU 各種
        case 0x54: case 0x71: this.ret(1); return;                    // CdInit / _96_init
        case 0x56: case 0x72: this.ret(1); return;                    // CdRemove / _96_remove
        case 0x55: case 0x70: this.ret(1); return;                    // _bu_init
        case 0x78: case 0x7C: case 0x7E: case 0x81: this.ret(1); return; // CdAsync*
        case 0x90: case 0x91: case 0x92: case 0x93: this.ret(0); return;
        case 0x94: case 0x95: this.ret(0); return;
        case 0x96: case 0x97: case 0x98: case 0x99: this.ret(0); return; // Add*Device
        case 0x9C: this.ret(0); return;                               // SetConf
        case 0x9D: bus.write32(a0, 4); bus.write32(a1, 16); bus.write32(a2, 0x801FFF00); this.ret(0); return; // GetConf
        case 0x9E: this.ret(0); return;                               // SetCdromIrqAutoAbort
        case 0x9F: this.ret(0); return;                               // SetMemSize
        case 0xA1: this.halt('SystemErrorBootOrDiskFailure'); return;
        case 0xA2: case 0xA3: this.ret(0); return;                    // EnqueueCdIntr/DequeueCdIntr
        case 0xA4: case 0xA5: case 0xA6: this.ret(0); return;         // CdGetLbn/CdReadSector/CdGetStatus
        case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05: this.ret(-1); return; // file I/O
        case 0x06: this.halt('exit()'); return;
        case 0x3A: this.halt('SystemErrorExit'); return;
        case 0x08: this.ret(-1); return;                              // getc
        case 0x09: this.tty(String.fromCharCode(a0 & 0xFF)); this.ret(a0); return; // putc
        default: this.unknown('A0', n); return;
      }
    }

    // ── B0 ────────────────────────────────────────────────
    callB0(n) {
      const cpu = this.cpu, bus = this.bus, r = cpu.r;
      const a0 = r[A0], a1 = r[A1], a2 = r[A2], a3 = r[A3];
      switch (n) {
        case 0x00: { // alloc_kernel_memory
          const p = this.kernelAllocPtr; this.kernelAllocPtr = (p + ((a0 + 7) & ~7)) | 0;
          if ((this.kernelAllocPtr & 0x1FFFFF) > 0xFF00) { this.kernelAllocPtr = KERNEL_ALLOC_BASE; }
          this.ret(p); return;
        }
        case 0x01: this.ret(0); return; // free_kernel_memory
        // ── ルートカウンタ ──
        case 0x02: { // SetRCnt(index, target, mode)
          const t = a0 & 3;
          if (t !== 3) {
            const base = 0x1F801100 + t * 0x10;
            bus.write32(base + 8, a1 & 0xFFFF);
            let mode = 0;
            if (a2 & 0x1000) mode |= 0x050;   // RCntMdINTR: 目標でIRQ+繰り返し
            if (a2 & 0x0100) mode |= 0x008;   // 目標で0に戻す
            if (a2 & 0x0010) mode |= 0x001;   // RCntMdSP (stop)
            if (t === 2 && (a2 & 0x0001)) mode |= 0x200; // sysclk/8
            bus.write32(base + 4, mode);
          }
          this.ret(1); return;
        }
        case 0x03: { const t = a0 & 3; this.ret(t === 3 ? 0 : bus.counters[t].count & 0xFFFF); return; } // GetRCnt
        case 0x04: { const t = a0 & 3; bus.iMask |= (t === 3 ? 1 : (0x10 << t)); bus.updateIrqLine(); this.ret(1); return; } // StartRCnt
        case 0x05: { const t = a0 & 3; bus.iMask &= ~(t === 3 ? 1 : (0x10 << t)); bus.updateIrqLine(); this.ret(1); return; } // StopRCnt
        case 0x06: { const t = a0 & 3; if (t !== 3) bus.counters[t].count = 0; this.ret(1); return; } // ResetRCnt
        // ── イベント ──
        case 0x07: this.deliverEvent(a0, a1 & 0xFFFF); this.ret(0); return; // DeliverEvent
        case 0x08: { // OpenEvent(class, spec, mode, func)
          const idx = this.events.findIndex(e => e.status === EV_FREE);
          if (idx < 0) { this.ret(-1); return; }
          const ev = this.events[idx];
          ev.status = EV_DISABLED; ev.cls = a0; ev.spec = a1 & 0xFFFF; ev.mode = a2 & 0xFFFF; ev.func = a3;
          this.ret((0xF1000000 | idx) | 0); return;
        }
        case 0x09: { const ev = this.eventOf(a0); if (ev) ev.status = EV_FREE; this.ret(1); return; } // CloseEvent
        case 0x0A: { // WaitEvent
          const ev = this.eventOf(a0);
          if (!ev || ev.status === EV_FREE) { this.ret(0); return; }
          if (ev.status === EV_READY) { ev.status = EV_ACTIVE; this.ret(1); return; }
          if (ev.status === EV_DISABLED) { this.ret(0); return; }
          this.retry(); return; // 来るまで待つ(割込みは入る)
        }
        case 0x0B: { const ev = this.eventOf(a0); if (ev && ev.status === EV_READY) { ev.status = EV_ACTIVE; this.ret(1); } else this.ret(0); return; } // TestEvent
        case 0x0C: { const ev = this.eventOf(a0); if (ev && ev.status !== EV_FREE) ev.status = EV_ACTIVE; this.ret(1); return; } // EnableEvent
        case 0x0D: { const ev = this.eventOf(a0); if (ev && ev.status !== EV_FREE) ev.status = EV_DISABLED; this.ret(1); return; } // DisableEvent
        case 0x20: { for (const ev of this.events) if (ev.status === EV_READY && (ev.cls >>> 0) === (a0 >>> 0) && ev.spec === (a1 & 0xFFFF)) ev.status = EV_ACTIVE; this.ret(0); return; } // UnDeliverEvent
        // ── スレッド(形だけ) ──
        case 0x0E: this.ret(0xFF000001 | 0); return; // OpenThread
        case 0x0F: this.ret(1); return;              // CloseThread
        case 0x10: this.ret(1); return;              // ChangeThread
        // ── パッド ──
        case 0x12: case 0x13: case 0x14: case 0x15: this.ret(1); return;
        case 0x16: this.ret(0xFFFF); return;
        case 0x5B: this.ret(0); return;              // ChangeClearPad
        // ── 例外関連 ──
        case 0x17: this.returnFromException(); return;
        case 0x18: this.jmpBuf = 0; this.ret(0); return;               // SetDefaultExitFromException
        case 0x19: this.jmpBuf = a0 | 0; this.ret(0); return;          // SetCustomExitFromException(HookEntryInt)
        // ── ファイル/TTY ──
        case 0x32: this.ret(-1); return; // FileOpen
        case 0x33: case 0x34: case 0x36: case 0x37: this.ret(-1); return;
        case 0x35: this.ret(a2); return; // FileWrite(標準出力扱い)
        case 0x38: this.halt('exit()'); return;
        case 0x3B: this.tty(String.fromCharCode(a1 & 0xFF)); this.ret(a1); return; // FilePutc
        case 0x3C: this.ret(-1); return;
        case 0x3D: this.tty(String.fromCharCode(a0 & 0xFF)); this.ret(a0); return; // std_out_putchar
        case 0x3F: this.tty(bus.readString(a0, 1024) + '\n'); this.ret(0); return; // std_out_puts
        case 0x47: case 0x48: this.ret(0); return; // AddDevice/RemoveDevice
        case 0x49: this.ret(0); return;
        case 0x4A: case 0x4B: case 0x4C: this.ret(1); return; // InitCard/StartCard/StopCard
        case 0x4D: case 0x4E: case 0x4F: case 0x50: this.ret(0); return;
        case 0x51: case 0x53: this.ret(0); return;
        case 0x54: case 0x55: this.ret(0); return; // GetLastError
        case 0x56: this.ret(0xC0); return;         // GetC0Table(便宜上)
        case 0x57: this.ret(0xB0); return;         // GetB0Table
        case 0x58: this.ret(0); return;
        case 0x59: this.ret(0); return;
        case 0x5C: case 0x5D: this.ret(1); return; // get_card_status/wait_card_status
        default: this.unknown('B0', n); return;
      }
    }

    // ── C0 ────────────────────────────────────────────────
    callC0(n) {
      const cpu = this.cpu, bus = this.bus, r = cpu.r;
      const a0 = r[A0], a1 = r[A1];
      switch (n) {
        case 0x00: case 0x01: this.ret(0); return; // EnqueueTimerAndVblankIrqs / EnqueueSyscallHandler
        case 0x02: { // SysEnqIntRP(priority, element)
          const prio = a0 & 3;
          if (!this.chains[prio].includes(a1 | 0)) this.chains[prio].unshift(a1 | 0);
          this.ret(0); return;
        }
        case 0x03: { // SysDeqIntRP
          const prio = a0 & 3;
          this.chains[prio] = this.chains[prio].filter(e => e !== (a1 | 0));
          this.ret(0); return;
        }
        case 0x04: { const idx = this.events.findIndex(e => e.status === EV_FREE); this.ret(idx < 0 ? -1 : idx); return; } // get_free_EvCB_slot
        case 0x05: this.ret(0); return;
        case 0x06: this.ret(0); return;
        case 0x07: this.ret(0); return; // InstallExceptionHandlers(スタブは既にある)
        case 0x08: this.ret(0); return; // SysInitMemory
        case 0x09: this.ret(0); return; // SysInitKernelVariables
        case 0x0A: { // ChangeClearRCnt(t, flag) → 旧値
          const t = a0 & 3;
          const slot = t === 3 ? 0 : 1 + t;
          const old = this.autoAck[slot] ? 1 : 0;
          this.autoAck[slot] = !!a1;
          this.ret(old); return;
        }
        case 0x0B: this.halt('SystemError(C0:0B)'); return;
        case 0x0C: this.ret(0); return; // InitDefInt
        case 0x0D: { // SetIrqAutoAck(irq, flag)
          const irq = a0 | 0;
          if (irq === 0) this.autoAck[0] = !!a1;
          else if (irq >= 4 && irq <= 6) this.autoAck[irq - 3] = !!a1;
          this.ret(0); return;
        }
        case 0x12: case 0x13: this.ret(0); return; // InstallDevices/FlushStdInOutPut
        case 0x1B: this.ret(0); return;            // KernelRedirect
        case 0x1C: this.ret(0); return;            // AdjustA0Table
        default: this.unknown('C0', n); return;
      }
    }

    // ── メモリ補助 ────────────────────────────────────────
    memmove(dst, src, len) {
      const bus = this.bus;
      if (len <= 0) return;
      const d = dst >>> 0, s = src >>> 0;
      // RAM 同士なら typed array で一気に(重なりは copyWithin が面倒を見る)
      const dp = d & 0x1FFFFFFF, sp = s & 0x1FFFFFFF;
      if (dp < 0x800000 && sp < 0x800000 && (dp & 0x1FFFFF) + len <= 0x200000 && (sp & 0x1FFFFF) + len <= 0x200000) {
        bus.ram.copyWithin(dp & 0x1FFFFF, sp & 0x1FFFFF, (sp & 0x1FFFFF) + len);
        return;
      }
      if (d > s && d < s + len) { for (let i = len - 1; i >= 0; i--) bus.write8(d + i, bus.read8(s + i)); }
      else { for (let i = 0; i < len; i++) bus.write8(d + i, bus.read8(s + i)); }
    }
    memset(dst, val, len) {
      const bus = this.bus;
      const dp = (dst >>> 0) & 0x1FFFFFFF;
      if (dp < 0x800000 && (dp & 0x1FFFFF) + len <= 0x200000) { bus.ram.fill(val & 0xFF, dp & 0x1FFFFF, (dp & 0x1FFFFF) + len); return; }
      for (let i = 0; i < len; i++) bus.write8(dst + i, val & 0xFF);
    }
    memcmp(a, b, len) {
      const bus = this.bus;
      for (let i = 0; i < len; i++) { const x = bus.read8(a + i), y = bus.read8(b + i); if (x !== y) return x - y; }
      return 0;
    }

    // ── ヒープ(first-fit) ─────────────────────────────────
    malloc(size) {
      if (!this.heapSize) return 0;
      size = (size + 7) & ~7;
      if (size <= 0) size = 8;
      const blocks = this.heapBlocks.sort((x, y) => x.addr - y.addr);
      let cur = this.heapBase;
      for (const b of blocks) {
        if (b.addr - cur >= size) break;
        cur = b.addr + b.size;
      }
      if (cur + size > this.heapBase + this.heapSize) return 0;
      this.heapBlocks.push({ addr: cur | 0, size });
      return cur | 0;
    }
    free(addr) {
      const i = this.heapBlocks.findIndex(b => b.addr === (addr | 0));
      if (i >= 0) this.heapBlocks.splice(i, 1);
    }

    // ── TTY / printf ──────────────────────────────────────
    tty(s) {
      if (this.ttyLog.length > 2000) return;
      const last = this.ttyLog.length - 1;
      if (last >= 0 && !this.ttyLog[last].endsWith('\n')) this.ttyLog[last] += s;
      else this.ttyLog.push(s);
    }
    printf() {
      const cpu = this.cpu, bus = this.bus;
      const fmt = bus.readString(cpu.r[A0], 1024);
      let argIdx = 1;
      const nextArg = () => {
        const i = argIdx++;
        if (i < 4) return cpu.r[A0 + i];
        return bus.read32(cpu.r[SP] + i * 4);
      };
      let out = '';
      for (let i = 0; i < fmt.length; i++) {
        const c = fmt[i];
        if (c !== '%') { out += c; continue; }
        let j = i + 1, spec = '';
        while (j < fmt.length && /[-+ 0-9.lh#]/.test(fmt[j])) spec += fmt[j++];
        const conv = fmt[j] || '';
        i = j;
        const width = parseInt(spec.replace(/[^0-9]/g, ''), 10) || 0;
        const pad = (s) => { if (s.length >= width) return s; return (spec.startsWith('0') ? '0' : ' ').repeat(width - s.length) + s; };
        switch (conv) {
          case 'd': case 'i': out += pad(String(nextArg())); break;
          case 'u': out += pad(String(nextArg() >>> 0)); break;
          case 'x': out += pad((nextArg() >>> 0).toString(16)); break;
          case 'X': out += pad((nextArg() >>> 0).toString(16).toUpperCase()); break;
          case 'c': out += String.fromCharCode(nextArg() & 0xFF); break;
          case 's': out += bus.readString(nextArg(), 1024); break;
          case 'p': out += '0x' + (nextArg() >>> 0).toString(16); break;
          case '%': out += '%'; break;
          default: out += '%' + spec + conv; break;
        }
      }
      this.tty(out);
    }
  }

  PsxBios.TRAP = { A0: TRAP_A0, B0: TRAP_B0, C0: TRAP_C0, EXC: TRAP_EXC, RET: TRAP_RET, IDLE: TRAP_IDLE };
  Emu.PsxBios = PsxBios;
})(window);
