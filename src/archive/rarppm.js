/*
 * RAR 2.9/3.x の PPMd(var.H)展開器
 * rar.js の展開器から、ブロック種別が PPM の区間で呼ばれる(Archive._RarPPM)。
 *
 * 中身は Dmitry Shkarin の PPMd var.H と、RAR が使う桁上げ無しレンジコーダ。
 * unrar の model.cpp / suballoc.cpp / coder.cpp と同じ手順・同じ記憶域の使い方で書いてある
 * (記憶域の確保順や使い切った時の作り直しの時期が符号化側とずれると、それ以降が全部化ける)。
 *
 * 記憶域は1本の Uint8Array で、ポインタはその中のバイト位置(0 は NULL)。
 *  - 文脈(12バイト): NumStats u16 @0, SummFreq u16 @2, Stats u32 @4, Suffix u32 @8
 *    NumStats==1 の文脈は @2 から 6 バイトに状態を1つ直に持つ(OneState)
 *  - 状態(6バイト): Symbol u8 @0, Freq u8 @1, Successor u32 @2
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Archive = MML.Archive = MML.Archive || {};

  const UNIT_SIZE = 12;
  const N1 = 4, N2 = 4, N3 = 4, N4 = Math.floor((128 + 3 - 1 * N1 - 2 * N2 - 3 * N3) / 4);
  const N_INDEXES = N1 + N2 + N3 + N4;
  const MAX_O = 64;
  const PERIOD_BITS = 7, TOT_BITS = 14, INTERVAL = 1 << 7, BIN_SCALE = 1 << TOT_BITS;
  const MAX_FREQ = 124;
  const TOP = 1 << 24, BOT = 1 << 15;
  const ExpEscape = [25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2];
  const InitBinEsc = [0x3CDD, 0x1F3F, 0x59BF, 0x48F3, 0x64A1, 0x5ABC, 0x6632, 0x6051];
  const HEAP_START = UNIT_SIZE; // 0 を NULL に使うので先頭を空ける
  const SEE_DUMMY = 25 * 16;

  const Indx2Units = new Uint8Array(N_INDEXES);
  const Units2Indx = new Uint8Array(128);
  (() => {
    let i = 0, k = 1;
    for (; i < N1; i++, k += 1) Indx2Units[i] = k;
    for (k++; i < N1 + N2; i++, k += 2) Indx2Units[i] = k;
    for (k++; i < N1 + N2 + N3; i++, k += 3) Indx2Units[i] = k;
    for (k++; i < N1 + N2 + N3 + N4; i++, k += 4) Indx2Units[i] = k;
    for (k = 0, i = 0; k < 128; k++) {
      i += (Indx2Units[i] < k + 1) ? 1 : 0;
      Units2Indx[k] = i;
    }
  })();

  const NS2Indx = new Uint8Array(256), NS2BSIndx = new Uint8Array(256), HB2Flag = new Uint8Array(256);
  (() => {
    NS2BSIndx[0] = 2 * 0;
    NS2BSIndx[1] = 2 * 1;
    NS2BSIndx.fill(2 * 2, 2, 11);
    NS2BSIndx.fill(2 * 3, 11, 256);
    let i = 0;
    for (; i < 3; i++) NS2Indx[i] = i;
    for (let m = i, k = 1, step = 1; i < 256; i++) {
      NS2Indx[i] = m;
      if (--k === 0) { k = ++step; m++; }
    }
    HB2Flag.fill(0, 0, 0x40);
    HB2Flag.fill(0x08, 0x40, 0x100);
  })();

  class RarPPM {
    constructor() {
      this.H = null;
      this.size = 0;
      this.freeList = new Uint32Array(N_INDEXES);
      this.binSumm = new Uint16Array(128 * 64);
      this.seeSumm = new Uint16Array(25 * 16 + 1);
      this.seeShift = new Uint8Array(25 * 16 + 1);
      this.seeCount = new Uint8Array(25 * 16 + 1);
      this.charMask = new Uint8Array(256);
      this.ps = new Uint32Array(256);
      this.minContext = 0;
      this.maxContext = 0;
      this.foundState = 0;
      this.inp = null;
    }

    // ---- 記憶域の読み書き ----
    u16(p) { const H = this.H; return H[p] | (H[p + 1] << 8); }
    set16(p, v) { const H = this.H; H[p] = v & 0xff; H[p + 1] = (v >>> 8) & 0xff; }
    u32(p) { const H = this.H; return (H[p] | (H[p + 1] << 8) | (H[p + 2] << 16) | (H[p + 3] << 24)) >>> 0; }
    set32(p, v) { const H = this.H; H[p] = v & 0xff; H[p + 1] = (v >>> 8) & 0xff; H[p + 2] = (v >>> 16) & 0xff; H[p + 3] = (v >>> 24) & 0xff; }
    copyState(dst, src) { const H = this.H; for (let i = 0; i < 6; i++) H[dst + i] = H[src + i]; }
    swapStates(a, b) {
      const H = this.H;
      for (let i = 0; i < 6; i++) { const t = H[a + i]; H[a + i] = H[b + i]; H[b + i] = t; }
    }

    // ---- SubAllocator ----
    startSubAllocator(mb) {
      const size = mb << 20;
      if (this.size !== size || !this.H) {
        this.H = null;
        this.H = new Uint8Array(HEAP_START + size + UNIT_SIZE * 2);
        this.size = size;
      }
      this.heapEnd = HEAP_START + size;
    }
    initSubAllocator() {
      this.freeList.fill(0);
      this.pText = HEAP_START;
      const size2 = UNIT_SIZE * (Math.floor(Math.floor(this.size / 8) / UNIT_SIZE) * 7);
      const size1 = this.size - size2;
      this.loUnit = this.unitsStart = HEAP_START + size1;
      this.hiUnit = this.loUnit + size2;
      this.glueCount = 0;
    }
    insertNode(p, indx) { this.set32(p, this.freeList[indx]); this.freeList[indx] = p; }
    removeNode(indx) { const p = this.freeList[indx]; this.freeList[indx] = this.u32(p); return p; }
    splitBlock(pv, oldIndx, newIndx) {
      let uDiff = Indx2Units[oldIndx] - Indx2Units[newIndx];
      let p = pv + Indx2Units[newIndx] * UNIT_SIZE;
      let i = Units2Indx[uDiff - 1];
      if (Indx2Units[i] !== uDiff) {
        this.insertNode(p, --i);
        i = Indx2Units[i];
        p += i * UNIT_SIZE;
        uDiff -= i;
      }
      this.insertNode(p, Units2Indx[uDiff - 1]);
    }
    glueFreeBlocks() {
      // 空きブロックを双方向リストにつなぎ、隣り合うものを合体してから大きさ別の空きリストへ戻す
      // (unrar の SubAllocator::GlueFreeBlocks と同じ順序)。番兵 s0 は記憶域の末尾の1単位。
      const H = this.H;
      const s0 = this.heapEnd;
      const STAMP = 0, NU = 2, NEXT = 4, PREV = 8;
      this.set16(s0 + STAMP, 0);
      this.set32(s0 + NEXT, s0);
      this.set32(s0 + PREV, s0);
      if (this.loUnit !== this.hiUnit) H[this.loUnit] = 0;
      for (let i = 0; i < N_INDEXES; i++) {
        while (this.freeList[i]) {
          const p = this.removeNode(i);
          // insertAt(&s0)
          const nx = this.u32(s0 + NEXT);
          this.set32(p + NEXT, nx);
          this.set32(p + PREV, s0);
          this.set32(nx + PREV, p);
          this.set32(s0 + NEXT, p);
          this.set16(p + STAMP, 0xFFFF);
          this.set16(p + NU, Indx2Units[i]);
        }
      }
      for (let p = this.u32(s0 + NEXT); p !== s0; p = this.u32(p + NEXT)) {
        for (;;) {
          const p1 = p + this.u16(p + NU) * UNIT_SIZE;
          if (this.u16(p1 + STAMP) !== 0xFFFF || this.u16(p + NU) + this.u16(p1 + NU) >= 0x10000) break;
          // p1->remove()
          const pp = this.u32(p1 + PREV), pn = this.u32(p1 + NEXT);
          this.set32(pp + NEXT, pn);
          this.set32(pn + PREV, pp);
          this.set16(p + NU, this.u16(p + NU) + this.u16(p1 + NU));
        }
      }
      let p;
      while ((p = this.u32(s0 + NEXT)) !== s0) {
        const pp = this.u32(p + PREV), pn = this.u32(p + NEXT);
        this.set32(pp + NEXT, pn);
        this.set32(pn + PREV, pp);
        let sz = this.u16(p + NU);
        for (; sz > 128; sz -= 128, p += 128 * UNIT_SIZE) this.insertNode(p, N_INDEXES - 1);
        let i = Units2Indx[sz - 1];
        if (Indx2Units[i] !== sz) {
          const k = sz - Indx2Units[--i];
          this.insertNode(p + (sz - k) * UNIT_SIZE, k - 1);
        }
        this.insertNode(p, i);
      }
    }
    allocUnitsRare(indx) {
      if (!this.glueCount) {
        this.glueCount = 255;
        this.glueFreeBlocks();
        if (this.freeList[indx]) return this.removeNode(indx);
      }
      let i = indx;
      do {
        if (++i === N_INDEXES) {
          this.glueCount--;
          const n = Indx2Units[indx] * UNIT_SIZE;
          if (this.unitsStart - this.pText > n) {
            this.unitsStart -= n;
            return this.unitsStart;
          }
          return 0;
        }
      } while (!this.freeList[i]);
      const r = this.removeNode(i);
      this.splitBlock(r, i, indx);
      return r;
    }
    allocUnits(nu) {
      const indx = Units2Indx[nu - 1];
      if (this.freeList[indx]) return this.removeNode(indx);
      const r = this.loUnit;
      this.loUnit += Indx2Units[indx] * UNIT_SIZE;
      if (this.loUnit <= this.hiUnit) return r;
      this.loUnit -= Indx2Units[indx] * UNIT_SIZE;
      return this.allocUnitsRare(indx);
    }
    allocContext() {
      if (this.hiUnit !== this.loUnit) return (this.hiUnit -= UNIT_SIZE);
      if (this.freeList[0]) return this.removeNode(0);
      return this.allocUnitsRare(0);
    }
    expandUnits(oldPtr, oldNU) {
      const i0 = Units2Indx[oldNU - 1], i1 = Units2Indx[oldNU];
      if (i0 === i1) return oldPtr;
      const p = this.allocUnits(oldNU + 1);
      if (p) {
        this.H.copyWithin(p, oldPtr, oldPtr + oldNU * UNIT_SIZE);
        this.insertNode(oldPtr, i0);
      }
      return p;
    }
    shrinkUnits(oldPtr, oldNU, newNU) {
      const i0 = Units2Indx[oldNU - 1], i1 = Units2Indx[newNU - 1];
      if (i0 === i1) return oldPtr;
      if (this.freeList[i1]) {
        const p = this.removeNode(i1);
        this.H.copyWithin(p, oldPtr, oldPtr + newNU * UNIT_SIZE);
        this.insertNode(oldPtr, i0);
        return p;
      }
      this.splitBlock(oldPtr, i0, i1);
      return oldPtr;
    }
    freeUnits(p, oldNU) { this.insertNode(p, Units2Indx[oldNU - 1]); }

    // ---- レンジコーダ(桁上げ無し) ----
    getChar() { return this.inp.getChar(); }
    initDecoder() {
      this.low = 0;
      this.code = 0;
      this.range = 0xFFFFFFFF;
      for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.getChar()) >>> 0;
    }
    normalize() {
      for (;;) {
        if (((this.low ^ ((this.low + this.range) >>> 0)) >>> 0) >= TOP) {
          if (this.range >= BOT) break;
          this.range = ((-this.low) >>> 0) & (BOT - 1);
        }
        this.code = ((this.code << 8) | this.getChar()) >>> 0;
        this.range = (this.range << 8) >>> 0;
        this.low = (this.low << 8) >>> 0;
      }
    }
    getCurrentCount() {
      this.range = Math.floor(this.range / this.scale) >>> 0;
      return Math.floor(((this.code - this.low) >>> 0) / this.range);
    }
    getCurrentShiftCount(shift) {
      this.range = this.range >>> shift;
      return Math.floor(((this.code - this.low) >>> 0) / this.range);
    }
    coderDecode() {
      this.low = (this.low + Math.imul(this.range, this.lowCount)) >>> 0;
      this.range = Math.imul(this.range, this.highCount - this.lowCount) >>> 0;
    }

    // ---- SEE ----
    seeGetMean(i) {
      const r = this.seeSumm[i] >>> this.seeShift[i];
      this.seeSumm[i] -= r;
      return r + (r === 0 ? 1 : 0);
    }
    seeUpdate(i) {
      if (this.seeShift[i] < PERIOD_BITS) {
        this.seeCount[i] = (this.seeCount[i] - 1) & 0xff;
        if (this.seeCount[i] === 0) {
          this.seeSumm[i] += this.seeSumm[i];
          this.seeCount[i] = 3 << this.seeShift[i]++;
        }
      }
    }

    // ---- モデル ----
    restartModelRare() {
      this.charMask.fill(0);
      this.initSubAllocator();
      const mo = this.maxOrder;
      this.initRL = -(mo < 12 ? mo : 12) - 1;
      const mc = this.allocContext();
      this.minContext = this.maxContext = mc;
      this.set32(mc + 8, 0);
      this.orderFall = this.maxOrder;
      this.set16(mc, 256);
      this.set16(mc + 2, 257);
      const st = this.allocUnits(256 / 2);
      this.foundState = st;
      this.set32(mc + 4, st);
      this.runLength = this.initRL;
      this.prevSuccess = 0;
      const H = this.H;
      for (let i = 0; i < 256; i++) {
        const s = st + i * 6;
        H[s] = i;
        H[s + 1] = 1;
        this.set32(s + 2, 0);
      }
      for (let i = 0; i < 128; i++)
        for (let k = 0; k < 8; k++)
          for (let m = 0; m < 64; m += 8)
            this.binSumm[i * 64 + k + m] = BIN_SCALE - Math.floor(InitBinEsc[k] / (i + 2));
      for (let i = 0; i < 25; i++)
        for (let k = 0; k < 16; k++) {
          const j = i * 16 + k;
          this.seeShift[j] = PERIOD_BITS - 4;
          this.seeSumm[j] = (5 * i + 10) << this.seeShift[j];
          this.seeCount[j] = 4;
        }
    }
    startModelRare(maxOrder) {
      this.escCount = 1;
      this.maxOrder = maxOrder;
      this.restartModelRare();
      this.seeShift[SEE_DUMMY] = PERIOD_BITS;
      this.seeSumm[SEE_DUMMY] = 0;
      this.seeCount[SEE_DUMMY] = 64;
    }
    clearMask() {
      this.escCount = 1;
      this.charMask.fill(0);
    }
    cleanUp() {
      this.startSubAllocator(1);
      this.startModelRare(2);
    }

    createSuccessors(skip, p1) {
      const H = this.H;
      let pc = this.minContext;
      const fsSym = H[this.foundState];
      const upBranch = this.u32(this.foundState + 2);
      const ps = [];
      let p = 0;
      let noLoop = false;
      if (!skip) {
        ps.push(this.foundState);
        if (!this.u32(pc + 8)) noLoop = true;
      }
      if (!noLoop) {
        let entry = false;
        if (p1) { p = p1; pc = this.u32(pc + 8); entry = true; }
        for (;;) {
          if (!entry) {
            pc = this.u32(pc + 8);
            if (this.u16(pc) !== 1) {
              p = this.u32(pc + 4);
              while (H[p] !== fsSym) p += 6;
            } else {
              p = pc + 2;
            }
          }
          entry = false;
          const succ = this.u32(p + 2);
          if (succ !== upBranch) { pc = succ; break; }
          if (ps.length >= MAX_O) return 0;
          ps.push(p);
          if (!this.u32(pc + 8)) break;
        }
      }
      if (ps.length === 0) return pc;
      const upSym = H[upBranch];
      const upSucc = upBranch + 1;
      let upFreq;
      if (this.u16(pc) !== 1) {
        if (pc <= this.pText) return 0;
        p = this.u32(pc + 4);
        while (H[p] !== upSym) p += 6;
        const cf = H[p + 1] - 1;
        const s0 = this.u16(pc + 2) - this.u16(pc) - cf;
        upFreq = 1 + ((2 * cf <= s0) ? (5 * cf > s0 ? 1 : 0) : Math.floor((2 * cf + 3 * s0 - 1) / (2 * s0)));
      } else {
        upFreq = H[pc + 3];
      }
      do {
        const c = this.allocContext();
        if (!c) return 0;
        this.set16(c, 1);
        H[c + 2] = upSym;
        H[c + 3] = upFreq & 0xff;
        this.set32(c + 4, upSucc);
        this.set32(c + 8, pc);
        this.set32(ps.pop() + 2, c);
        pc = c;
      } while (ps.length);
      return pc;
    }

    updateModel() {
      const H = this.H;
      const fsp = this.foundState;
      const fsSym = H[fsp], fsFreq = H[fsp + 1];
      let fsSucc = this.u32(fsp + 2);
      const minC = this.minContext;
      let p = 0;
      let pc = this.u32(minC + 8);
      if (fsFreq < MAX_FREQ / 4 && pc) {
        if (this.u16(pc) !== 1) {
          p = this.u32(pc + 4);
          if (H[p] !== fsSym) {
            do { p += 6; } while (H[p] !== fsSym);
            if (H[p + 1] >= H[p - 6 + 1]) { this.swapStates(p, p - 6); p -= 6; }
          }
          if (H[p + 1] < MAX_FREQ - 9) {
            H[p + 1] += 2;
            this.set16(pc + 2, this.u16(pc + 2) + 2);
          }
        } else {
          p = pc + 2;
          if (H[p + 1] < 32) H[p + 1]++;
        }
      }
      if (!this.orderFall) {
        const c = this.createSuccessors(true, p);
        this.minContext = this.maxContext = c;
        this.set32(this.foundState + 2, c);
        if (!c) this.restartModel();
        return;
      }
      H[this.pText++] = fsSym;
      let successor = this.pText;
      if (this.pText >= this.unitsStart) { this.restartModel(); return; }
      if (fsSucc) {
        if (fsSucc <= this.pText) {
          fsSucc = this.createSuccessors(false, p);
          if (!fsSucc) { this.restartModel(); return; }
        }
        if (--this.orderFall === 0) {
          successor = fsSucc;
          if (this.maxContext !== this.minContext) this.pText--;
        }
      } else {
        this.set32(fsp + 2, successor);
        fsSucc = this.minContext;
      }
      const ns = this.u16(minC);
      const s0 = this.u16(minC + 2) - ns - (fsFreq - 1);
      for (pc = this.maxContext; pc !== minC; pc = this.u32(pc + 8)) {
        let ns1 = this.u16(pc);
        if (ns1 !== 1) {
          if ((ns1 & 1) === 0) {
            const np = this.expandUnits(this.u32(pc + 4), ns1 >> 1);
            if (!np) { this.restartModel(); return; }
            this.set32(pc + 4, np);
          }
          const sf = this.u16(pc + 2);
          this.set16(pc + 2, sf + ((2 * ns1 < ns) ? 1 : 0) + 2 * (((4 * ns1 <= ns) ? 1 : 0) & ((sf <= 8 * ns1) ? 1 : 0)));
        } else {
          const np = this.allocUnits(1);
          if (!np) { this.restartModel(); return; }
          this.copyState(np, pc + 2);
          this.set32(pc + 4, np);
          if (H[np + 1] < MAX_FREQ / 4 - 1) H[np + 1] += H[np + 1];
          else H[np + 1] = MAX_FREQ - 4;
          this.set16(pc + 2, H[np + 1] + this.initEsc + (ns > 3 ? 1 : 0));
        }
        let cf = 2 * fsFreq * (this.u16(pc + 2) + 6);
        const sf = s0 + this.u16(pc + 2);
        if (cf < 6 * sf) {
          cf = 1 + (cf > sf ? 1 : 0) + (cf >= 4 * sf ? 1 : 0);
          this.set16(pc + 2, this.u16(pc + 2) + 3);
        } else {
          cf = 4 + (cf >= 9 * sf ? 1 : 0) + (cf >= 12 * sf ? 1 : 0) + (cf >= 15 * sf ? 1 : 0);
          this.set16(pc + 2, this.u16(pc + 2) + cf);
        }
        const np = this.u32(pc + 4) + ns1 * 6;
        this.set32(np + 2, successor);
        H[np] = fsSym;
        H[np + 1] = cf;
        this.set16(pc, ++ns1);
      }
      this.maxContext = this.minContext = fsSucc;
    }
    restartModel() {
      this.restartModelRare();
      this.escCount = 0;
    }

    rescale(c) {
      const H = this.H;
      const oldNS = this.u16(c);
      let i = oldNS - 1;
      const stats = this.u32(c + 4);
      for (let p = this.foundState; p !== stats; p -= 6) this.swapStates(p, p - 6);
      H[stats + 1] += 4;
      let summ = this.u16(c + 2) + 4;
      let escFreq = summ - H[stats + 1];
      const adder = this.orderFall !== 0 ? 1 : 0;
      let p = stats;
      H[p + 1] = (H[p + 1] + adder) >> 1;
      summ = H[p + 1];
      do {
        p += 6;
        escFreq -= H[p + 1];
        H[p + 1] = (H[p + 1] + adder) >> 1;
        summ += H[p + 1];
        if (H[p + 1] > H[p - 6 + 1]) {
          const t0 = H[p], t1 = H[p + 1], t2 = H[p + 2], t3 = H[p + 3], t4 = H[p + 4], t5 = H[p + 5];
          let p1 = p;
          do { this.copyState(p1, p1 - 6); p1 -= 6; } while (p1 !== stats && t1 > H[p1 - 6 + 1]);
          H[p1] = t0; H[p1 + 1] = t1; H[p1 + 2] = t2; H[p1 + 3] = t3; H[p1 + 4] = t4; H[p1 + 5] = t5;
        }
      } while (--i);
      if (H[p + 1] === 0) {
        do { i++; p -= 6; } while (H[p + 1] === 0);
        escFreq += i;
        const ns = oldNS - i;
        this.set16(c, ns);
        if (ns === 1) {
          const t0 = H[stats], t2 = H[stats + 2], t3 = H[stats + 3], t4 = H[stats + 4], t5 = H[stats + 5];
          let tf = H[stats + 1];
          do { tf -= tf >> 1; escFreq >>= 1; } while (escFreq > 1);
          this.freeUnits(stats, (oldNS + 1) >> 1);
          const os = c + 2;
          H[os] = t0; H[os + 1] = tf; H[os + 2] = t2; H[os + 3] = t3; H[os + 4] = t4; H[os + 5] = t5;
          this.foundState = os;
          return;
        }
      }
      escFreq -= escFreq >> 1;
      summ += escFreq;
      this.set16(c + 2, summ);
      const n0 = (oldNS + 1) >> 1, n1 = (this.u16(c) + 1) >> 1;
      if (n0 !== n1) this.set32(c + 4, this.shrinkUnits(stats, n0, n1));
      this.foundState = this.u32(c + 4);
    }

    decodeBinSymbol(c) {
      const H = this.H;
      const rs = c + 2;
      this.hiBitsFlag = HB2Flag[H[this.foundState]];
      const suffix = this.u32(c + 8);
      const idx = (H[rs + 1] - 1) * 64 + this.prevSuccess + NS2BSIndx[this.u16(suffix) - 1] +
        this.hiBitsFlag + 2 * HB2Flag[H[rs]] + ((this.runLength >> 26) & 0x20);
      let bs = this.binSumm[idx];
      if (this.getCurrentShiftCount(TOT_BITS) < bs) {
        this.foundState = rs;
        if (H[rs + 1] < 128) H[rs + 1]++;
        this.lowCount = 0;
        this.highCount = bs;
        this.binSumm[idx] = (bs + INTERVAL - ((bs + 32) >> 7)) & 0xffff;
        this.prevSuccess = 1;
        this.runLength++;
      } else {
        this.lowCount = bs;
        bs = (bs - ((bs + 32) >> 7)) & 0xffff;
        this.binSumm[idx] = bs;
        this.highCount = BIN_SCALE;
        this.initEsc = ExpEscape[bs >> 10];
        this.numMasked = 1;
        this.charMask[H[rs]] = this.escCount;
        this.prevSuccess = 0;
        this.foundState = 0;
      }
    }

    update1(c, p) {
      const H = this.H;
      this.foundState = p;
      H[p + 1] += 4;
      this.set16(c + 2, this.u16(c + 2) + 4);
      if (H[p + 1] > H[p - 6 + 1]) {
        this.swapStates(p, p - 6);
        this.foundState = p -= 6;
        if (H[p + 1] > MAX_FREQ) this.rescale(c);
      }
    }

    decodeSymbol1(c) {
      const H = this.H;
      this.scale = this.u16(c + 2);
      let p = this.u32(c + 4);
      const count = this.getCurrentCount();
      if (count >= this.scale) return false;
      let hiCnt = H[p + 1];
      if (count < hiCnt) {
        this.highCount = hiCnt;
        this.prevSuccess = (2 * hiCnt > this.scale) ? 1 : 0;
        this.runLength += this.prevSuccess;
        this.foundState = p;
        hiCnt += 4;
        H[p + 1] = hiCnt;
        this.set16(c + 2, this.u16(c + 2) + 4);
        if (hiCnt > MAX_FREQ) this.rescale(c);
        this.lowCount = 0;
        return true;
      } else if (this.foundState === 0) return false;
      this.prevSuccess = 0;
      let i = this.u16(c) - 1;
      while ((hiCnt += H[(p += 6) + 1]) <= count) {
        if (--i === 0) {
          this.hiBitsFlag = HB2Flag[H[this.foundState]];
          this.lowCount = hiCnt;
          this.charMask[H[p]] = this.escCount;
          i = (this.numMasked = this.u16(c)) - 1;
          this.foundState = 0;
          do { p -= 6; this.charMask[H[p]] = this.escCount; } while (--i);
          this.highCount = this.scale;
          return true;
        }
      }
      this.highCount = hiCnt;
      this.lowCount = hiCnt - H[p + 1];
      this.update1(c, p);
      return true;
    }

    update2(c, p) {
      const H = this.H;
      this.foundState = p;
      H[p + 1] += 4;
      this.set16(c + 2, this.u16(c + 2) + 4);
      if (H[p + 1] > MAX_FREQ) this.rescale(c);
      this.escCount = (this.escCount + 1) & 0xff;
      this.runLength = this.initRL;
    }

    makeEscFreq2(c, diff) {
      const ns = this.u16(c);
      if (ns !== 256) {
        const suffix = this.u32(c + 8);
        const idx = NS2Indx[diff - 1] * 16 +
          ((diff < this.u16(suffix) - ns) ? 1 : 0) +
          2 * ((this.u16(c + 2) < 11 * ns) ? 1 : 0) +
          4 * ((this.numMasked > diff) ? 1 : 0) +
          this.hiBitsFlag;
        this.scale = this.seeGetMean(idx);
        return idx;
      }
      this.scale = 1;
      return SEE_DUMMY;
    }

    decodeSymbol2(c) {
      const H = this.H;
      let i = this.u16(c) - this.numMasked;
      const see = this.makeEscFreq2(c, i);
      const ps = this.ps;
      let n = 0;
      let p = this.u32(c + 4) - 6;
      let hiCnt = 0;
      do {
        do { p += 6; } while (this.charMask[H[p]] === this.escCount);
        hiCnt += H[p + 1];
        if (n >= 256) return false;
        ps[n++] = p;
      } while (--i);
      this.scale += hiCnt;
      const count = this.getCurrentCount();
      if (count >= this.scale) return false;
      let k = 0;
      p = ps[0];
      if (count < hiCnt) {
        hiCnt = 0;
        while ((hiCnt += H[p + 1]) <= count) {
          k++;
          if (k >= n) return false;
          p = ps[k];
        }
        this.highCount = hiCnt;
        this.lowCount = hiCnt - H[p + 1];
        this.seeUpdate(see);
        this.update2(c, p);
      } else {
        this.lowCount = hiCnt;
        this.highCount = this.scale;
        i = this.u16(c) - this.numMasked;
        k = -1;
        do { this.charMask[H[ps[++k]]] = this.escCount; } while (--i);
        this.seeSumm[see] += this.scale;
        this.numMasked = this.u16(c);
      }
      return true;
    }

    // 1文字復号する。終端/壊れたデータなら -1
    decodeChar() {
      const H = this.H;
      let mc = this.minContext;
      if (mc <= this.pText || mc > this.heapEnd) return -1;
      if (this.u16(mc) !== 1) {
        const st = this.u32(mc + 4);
        if (st <= this.pText || st > this.heapEnd) return -1;
        if (!this.decodeSymbol1(mc)) return -1;
      } else {
        this.decodeBinSymbol(mc);
      }
      this.coderDecode();
      while (!this.foundState) {
        this.normalize();
        do {
          this.orderFall++;
          mc = this.u32(mc + 8);
          if (mc <= this.pText || mc > this.heapEnd) return -1;
        } while (this.u16(mc) === this.numMasked);
        this.minContext = mc;
        if (!this.decodeSymbol2(mc)) return -1;
        this.coderDecode();
      }
      const symbol = H[this.foundState];
      const succ = this.u32(this.foundState + 2);
      if (!this.orderFall && succ > this.pText) {
        this.minContext = this.maxContext = succ;
      } else {
        this.updateModel();
        if (this.escCount === 0) this.clearMask();
      }
      this.normalize();
      return symbol;
    }

    /** PPM ブロックの頭(フラグ/メモリ量/エスケープ文字)を読んでレンジコーダを始める。 */
    decodeInit(inp) {
      this.inp = inp;
      let maxOrder = this.getChar();
      const reset = (maxOrder & 0x20) !== 0;
      let maxMB = 0;
      if (reset) maxMB = this.getChar();
      else if (!this.H) return { ok: false };
      let escChar;
      if (maxOrder & 0x40) escChar = this.getChar();
      this.initDecoder();
      if (reset) {
        maxOrder = (maxOrder & 0x1f) + 1;
        if (maxOrder > 16) maxOrder = 16 + (maxOrder - 16) * 3;
        if (maxOrder === 1) { this.H = null; this.size = 0; return { ok: false, escChar }; }
        this.startSubAllocator(maxMB + 1);
        this.startModelRare(maxOrder);
      }
      return { ok: this.minContext !== 0, escChar };
    }
  }

  Archive._RarPPM = RarPPM;
})(typeof window !== 'undefined' ? window : globalThis);
