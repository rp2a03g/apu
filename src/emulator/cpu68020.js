/*
 * MML.Emu.createM68020(bus) — モトローラ MC68EC020(番地は 24bit)。
 *
 * タイトー F3 システムのメイン CPU 用。cpu68000.js(音源基板のサウンド CPU 用。タイミングを MAME と突き合わせてある)を元に、
 * 68020 で増えた物を足した別の物(68000 の側のタイミングを動かさないため、分けてある)。
 *   増えた物: フル形式の拡張語(ベース変位、メモリ間接、スケール)、32bit の分岐、MULL / DIVL、EXTB、LINK.L、RTD、MOVEC(VBR ほか)、
 *             ビットフィールド、CAS / CAS2、CHK2 / CMP2、CHK.L、TRAPcc、PACK / UNPK、MOVE CCR,ea、MOVES、
 *             例外のスタックフレーム(形式の語つき。形式 0 と 2)、マスタ / 割り込みのスタック、奇数番地の語の読み書き
 *   無い物: コプロセッサ(F ライン例外になる)、CALLM / RTM、トレース、キャッシュ(CACR は値を持つだけ)
 * 命令の意味はモトローラの「M68000 Family Programmer's Reference Manual」のとおり。
 * サイクル数は粗い近似(命令の取り込み 1 語 = 2、データの読み書き 1 回 = 3、ほか内部の待ち)。垂直同期で動くゲームには足りる。
 *
 * bus: { read8(a), read16(a), write8(a, v), write16(a, v), irqAck(level) → ベクタ番号(省略時は自動ベクタ 24 + level) }
 *   番地は 24bit に切ってから渡す。16bit の読み書きは偶数番地だけ渡す(奇数番地の語はこちらでバイトに割る)。
 * 口: reset() / run(until)(通しのクロック数 until まで進める)/ setIrq(level)(0 = 無し。レベルは外が保つ)/ pc / cycles / getState / setState
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};

  Emu.createM68020 = function (bus) {
    const D = new Int32Array(8), A = new Int32Array(8);
    let pc = 0, cyc = 0, irq = 0, stopped = false, illegalCount = 0, lastIllegal = 0;
    // SR: T1(15) T0(14) S(13) M(12) I(10-8) X N Z V C。フラグは 0/1 でばらに持つ
    let fT = 0, fS = 1, fM = 0, fI = 7, fX = 0, fN = 0, fZ = 0, fV = 0, fC = 0;
    // 使っていないスタックポインタの控え(今のスタックは A[7])
    let usp = 0, isp = 0, msp = 0;
    let vbr = 0, cacr = 0, caar = 0, sfc = 0, dfc = 0;
    const MASK = [0xff, 0xffff, 0xffffffff], MSB = [0x80, 0x8000, 0x80000000], BYTES = [1, 2, 4];

    // ── バス ──
    function rd8(a) { cyc += 3; return bus.read8(a & 0xffffff); }
    function rd16(a) { cyc += 3; return a & 1 ? (bus.read8(a & 0xffffff) << 8 | bus.read8((a + 1) & 0xffffff)) : bus.read16(a & 0xffffff); }
    function rd32(a) { cyc += 3; return a & 1 ? ((bus.read8(a & 0xffffff) << 24 | bus.read16((a + 1) & 0xffffff) << 8 | bus.read8((a + 3) & 0xffffff)) >>> 0) : ((bus.read16(a & 0xffffff) << 16 | bus.read16((a + 2) & 0xffffff)) >>> 0); }
    function wr8(a, v) { cyc += 3; bus.write8(a & 0xffffff, v & 0xff); }
    function wr16(a, v) { cyc += 3; if (a & 1) { bus.write8(a & 0xffffff, v >> 8 & 0xff); bus.write8((a + 1) & 0xffffff, v & 0xff); } else bus.write16(a & 0xffffff, v & 0xffff); }
    function wr32(a, v) {
      cyc += 3;
      if (a & 1) { bus.write8(a & 0xffffff, v >>> 24); bus.write16((a + 1) & 0xffffff, v >>> 8 & 0xffff); bus.write8((a + 3) & 0xffffff, v & 0xff); }
      else { bus.write16(a & 0xffffff, v >>> 16); bus.write16((a + 2) & 0xffffff, v & 0xffff); }
    }
    const rd = (sz, a) => (sz === 0 ? rd8(a) : sz === 1 ? rd16(a) : rd32(a));
    const wr = (sz, a, v) => { if (sz === 0) wr8(a, v); else if (sz === 1) wr16(a, v); else wr32(a, v); };
    function fetch16() { const v = bus.read16(pc & 0xfffffe); cyc += 2; pc = (pc + 2) >>> 0; return v; }
    function fetch32() { const h = fetch16(); return ((h << 16) | fetch16()) >>> 0; }
    const s8 = (v) => v << 24 >> 24, s16 = (v) => v << 16 >> 16;
    const sext = (sz, v) => (sz === 0 ? v << 24 >> 24 : sz === 1 ? v << 16 >> 16 : v | 0);

    // ── SR ──
    function getCcr() { return fX << 4 | fN << 3 | fZ << 2 | fV << 1 | fC; }
    function setCcr(v) { fX = v >> 4 & 1; fN = v >> 3 & 1; fZ = v >> 2 & 1; fV = v >> 1 & 1; fC = v & 1; }
    function getSr() { return fT << 14 | fS << 13 | fM << 12 | fI << 8 | getCcr(); }
    // 今のスタックを控えへ戻し、(s, m) のスタックを A[7] に出す
    function setMode(s, m) {
      if (s === fS && m === fM) return;
      if (!fS) usp = A[7]; else if (fM) msp = A[7]; else isp = A[7];
      fS = s; fM = m;
      A[7] = !fS ? usp : fM ? msp : isp;
    }
    function setSr(v) { setMode(v >> 13 & 1, v >> 12 & 1); fT = v >> 14 & 3; fI = v >> 8 & 7; setCcr(v); }

    // ── 実効アドレス ──
    function index(base) {
      const ext = fetch16(), r = ext >> 12 & 7;
      let x = ext & 0x8000 ? A[r] : D[r];
      if (!(ext & 0x800)) x = s16(x);
      x = x << (ext >> 9 & 3);
      cyc += 2;
      if (!(ext & 0x100)) return (base + s8(ext) + x) >>> 0;       // 短い形式
      // フル形式
      if (ext & 0x80) base = 0;                                    // ベースなし
      if (ext & 0x40) x = 0;                                       // インデックスなし
      const bdSize = ext >> 4 & 3, iis = ext & 7;
      const bd = bdSize === 2 ? s16(fetch16()) : bdSize === 3 ? fetch32() | 0 : 0;
      if (iis === 0) return (base + bd + x) >>> 0;
      const odSize = iis & 3, post = (iis & 4) && !(ext & 0x40);
      const ptr = post ? rd32((base + bd) >>> 0) : rd32((base + bd + x) >>> 0);
      const od = odSize === 2 ? s16(fetch16()) : odSize === 3 ? fetch32() | 0 : 0;
      return (ptr + (post ? x : 0) + od) >>> 0;
    }
    function eaAddr(mode, reg, sz) {
      switch (mode) {
        case 2: return A[reg] >>> 0;
        case 3: { const a = A[reg]; A[reg] = (a + (sz === 0 && reg === 7 ? 2 : BYTES[sz])) | 0; return a >>> 0; }
        case 4: { A[reg] = (A[reg] - (sz === 0 && reg === 7 ? 2 : BYTES[sz])) | 0; return A[reg] >>> 0; }
        case 5: return (A[reg] + s16(fetch16())) >>> 0;
        case 6: return index(A[reg]);
        default:
          switch (reg) {
            case 0: return s16(fetch16()) >>> 0;
            case 1: return fetch32();
            case 2: { const b = pc; return (b + s16(fetch16())) >>> 0; }
            case 3: { const b = pc; return index(b); }
            default: return -1;
          }
      }
    }
    function readEa(mode, reg, sz) {
      if (mode === 0) return D[reg] & MASK[sz];
      if (mode === 1) return (sz === 1 ? A[reg] & 0xffff : A[reg]) >>> 0;
      if (mode === 7 && reg === 4) return sz === 2 ? fetch32() : sz === 1 ? fetch16() : fetch16() & 0xff;
      return rd(sz, eaAddr(mode, reg, sz)) >>> 0;
    }
    function setD(reg, sz, v) { if (sz === 2) D[reg] = v | 0; else if (sz === 1) D[reg] = (D[reg] & 0xffff0000) | (v & 0xffff); else D[reg] = (D[reg] & 0xffffff00) | (v & 0xff); }
    function writeEa(mode, reg, sz, v) {
      if (mode === 0) setD(reg, sz, v);
      else if (mode === 1) A[reg] = sz === 1 ? s16(v) : v | 0;
      else wr(sz, eaAddr(mode, reg, sz), v);
    }
    let rmwAddr = 0, rmwReg = -1;
    function rmwRead(mode, reg, sz) {
      if (mode === 0) { rmwReg = reg; return D[reg] & MASK[sz]; }
      rmwReg = -1; rmwAddr = eaAddr(mode, reg, sz);
      return rd(sz, rmwAddr) >>> 0;
    }
    function rmwWrite(sz, v) { if (rmwReg >= 0) setD(rmwReg, sz, v); else wr(sz, rmwAddr, v); }

    // ── 演算とフラグ ──
    function flagsNZ(sz, r) { fN = (r & MSB[sz]) ? 1 : 0; fZ = (r & MASK[sz]) === 0 ? 1 : 0; }
    function logic(sz, r) { flagsNZ(sz, r); fV = 0; fC = 0; return r; }
    function add(sz, s, d, x) {
      const m = MASK[sz], sm = (s & m) >>> 0, dm = (d & m) >>> 0, r = sm + dm + x, rm = sz === 2 ? r % 4294967296 : r & m;
      fC = r > (m >>> 0) ? 1 : 0; fX = fC;
      fV = ((sm ^ rm) & (dm ^ rm) & MSB[sz]) ? 1 : 0;
      fN = (rm & MSB[sz]) ? 1 : 0; fZ = rm === 0 ? 1 : 0;
      return rm >>> 0;
    }
    function sub(sz, s, d, x, setX) {
      const m = MASK[sz], sm = (s & m) >>> 0, dm = (d & m) >>> 0, r = dm - sm - x, rm = (sz === 2 ? (r < 0 ? r + 4294967296 : r) : r & m) >>> 0;
      fC = r < 0 ? 1 : 0; if (setX) fX = fC;
      fV = ((sm ^ dm) & (rm ^ dm) & MSB[sz]) ? 1 : 0;
      fN = (rm & MSB[sz]) ? 1 : 0; fZ = rm === 0 ? 1 : 0;
      return rm;
    }
    function cond(cc) {
      switch (cc) {
        case 0: return true; case 1: return false;
        case 2: return !fC && !fZ; case 3: return !!(fC || fZ);
        case 4: return !fC; case 5: return !!fC;
        case 6: return !fZ; case 7: return !!fZ;
        case 8: return !fV; case 9: return !!fV;
        case 10: return !fN; case 11: return !!fN;
        case 12: return fN === fV; case 13: return fN !== fV;
        case 14: return !fZ && fN === fV; default: return !!(fZ || fN !== fV);
      }
    }

    // ── 例外(形式 0: SR、PC、形式とベクタ。形式 2: それに命令の番地)──
    function exception(vec, retPc, instAddr) {
      const sr = getSr();
      setMode(1, fM);
      fT = 0;
      if (instAddr !== undefined) { A[7] = (A[7] - 4) | 0; wr32(A[7], instAddr); }
      A[7] = (A[7] - 2) | 0; wr16(A[7], (instAddr !== undefined ? 0x2000 : 0) | (vec * 4));
      A[7] = (A[7] - 4) | 0; wr32(A[7], retPc);
      A[7] = (A[7] - 2) | 0; wr16(A[7], sr);
      pc = rd32((vbr + vec * 4) >>> 0);
      cyc += 8;
    }
    function illegal(op, at) {
      const g = op >> 12;
      if (g !== 0xA && g !== 0xF) { illegalCount++; lastIllegal = at; }
      exception(g === 0xA ? 10 : g === 0xF ? 11 : 4, at);
    }
    function checkIrq() {
      if (irq > fI || irq === 7) {
        const level = irq;
        stopped = false;
        const vec = bus.irqAck ? bus.irqAck(level) : 24 + level;
        const sr = getSr();
        exception(vec, pc);
        if (fM) {   // マスタのスタックを使っていた時: 割り込みのスタックへ移り、形式 1 のフレームをもう 1 つ積む
          setMode(1, 0);
          A[7] = (A[7] - 2) | 0; wr16(A[7], 0x1000 | (vec * 4));
          A[7] = (A[7] - 4) | 0; wr32(A[7], pc);
          A[7] = (A[7] - 2) | 0; wr16(A[7], sr | 0x2000);
        }
        fI = level;
        cyc += 8;
        return true;
      }
      return false;
    }
    function rte(at) {
      for (;;) {
        const sr = rd16(A[7]), p = rd32((A[7] + 2) >>> 0), fmt = rd16((A[7] + 6) >>> 0) >> 12;
        if (fmt === 0) { A[7] = (A[7] + 8) | 0; setSr(sr); pc = p; return; }
        if (fmt === 2) { A[7] = (A[7] + 12) | 0; setSr(sr); pc = p; return; }
        if (fmt === 1) { A[7] = (A[7] + 8) | 0; setSr(sr); continue; }   // 形式 1: SR を戻して、次のフレームへ
        exception(14, at); return;                                       // 形式エラー
      }
    }

    // ── シフト・回転(kind 0 AS / 1 LS / 2 ROX / 3 RO、left)──
    function shift(kind, left, sz, v, n) {
      const m = MASK[sz] >>> 0, msb = MSB[sz] >>> 0;
      v = (v & m) >>> 0;
      fV = 0;
      if (n === 0) { fC = kind === 2 ? fX : 0; flagsNZ(sz, v); return v; }
      for (let i = 0; i < n; i++) {
        if (left) {
          const out = (v & msb) ? 1 : 0;
          let nv = (v * 2) % 4294967296; nv = (nv & m) >>> 0;
          if (kind === 2) nv = (nv | fX) >>> 0; else if (kind === 3) nv = (nv | out) >>> 0;
          if (kind === 0 && ((nv & msb) !== (v & msb))) fV = 1;
          if (kind !== 3) fX = out;
          fC = out; v = nv;
        } else {
          const out = v & 1;
          let nv = v >>> 1;
          if (kind === 0) nv = (nv | (v & msb)) >>> 0; else if (kind === 2) nv = (nv | (fX ? msb : 0)) >>> 0; else if (kind === 3) nv = (nv | (out ? msb : 0)) >>> 0;
          if (kind !== 3) fX = out;
          fC = out; v = nv;
        }
      }
      flagsNZ(sz, v);
      return v;
    }

    function movem(op) {
      const toReg = op & 0x400, sz = op & 0x40 ? 2 : 1, mode = op >> 3 & 7, reg = op & 7, list = fetch16(), step = BYTES[sz];
      if (!toReg) {
        if (mode === 4) {   // -(An): 並びが逆(A7 … D0)。An 自身を積む時は、引いた後の値(68020)
          let a = A[reg] >>> 0;
          const self = (a - step) | 0;
          for (let i = 0; i < 16; i++) if (list >> i & 1) { a = (a - step) >>> 0; const v = i < 8 ? (7 - i === reg ? self : A[7 - i]) : D[15 - i]; wr(sz, a, v); }
          A[reg] = a | 0;
        } else {
          let a = eaAddr(mode, reg, sz);
          for (let i = 0; i < 16; i++) if (list >> i & 1) { wr(sz, a, i < 8 ? D[i] : A[i - 8]); a = (a + step) >>> 0; }
        }
      } else {
        let a = mode === 3 ? A[reg] >>> 0 : eaAddr(mode, reg, sz);
        for (let i = 0; i < 16; i++) if (list >> i & 1) { const v = sz === 1 ? s16(rd16(a)) : rd32(a) | 0; if (i < 8) D[i] = v; else A[i - 8] = v; a = (a + step) >>> 0; }
        if (mode === 3) A[reg] = a | 0;
      }
      cyc += 4;
    }

    function bcd(sub2, s, d) {
      let r;
      if (!sub2) {
        let lo = (s & 15) + (d & 15) + fX, hi = (s >> 4 & 15) + (d >> 4 & 15);
        if (lo > 9) { lo -= 10; hi++; }
        fC = 0; if (hi > 9) { hi -= 10; fC = 1; }
        r = (hi << 4 | lo) & 0xff;
      } else {
        let lo = (d & 15) - (s & 15) - fX, hi = (d >> 4 & 15) - (s >> 4 & 15);
        if (lo < 0) { lo += 10; hi--; }
        fC = 0; if (hi < 0) { hi += 10; fC = 1; }
        r = (hi << 4 | lo) & 0xff;
      }
      fX = fC; if (r) fZ = 0; fN = r >> 7 & 1;
      return r;
    }

    // ── 68020: MULL / DIVL(64bit は BigInt)──
    function mull(at, mode, reg) {
      const ext = fetch16(), dl = ext >> 12 & 7, dh = ext & 7, signed = ext & 0x800, wide = ext & 0x400;
      const s = readEa(mode, reg, 2);
      const p = signed ? BigInt(s | 0) * BigInt(D[dl]) : BigInt(s >>> 0) * BigInt(D[dl] >>> 0);
      const lo = Number(BigInt.asUintN(32, p));
      fC = 0;
      if (wide) {
        const hi = Number(BigInt.asUintN(32, p >> 32n));
        D[dh] = hi | 0; D[dl] = lo | 0;
        fN = hi >>> 31; fZ = (hi === 0 && lo === 0) ? 1 : 0; fV = 0;
      } else {
        D[dl] = lo | 0;
        fN = lo >>> 31; fZ = lo === 0 ? 1 : 0;
        fV = (signed ? p !== BigInt(lo | 0) : p !== BigInt(lo)) ? 1 : 0;
      }
      cyc += 40;
    }
    function divl(at, mode, reg) {
      const ext = fetch16(), dq = ext >> 12 & 7, dr = ext & 7, signed = ext & 0x800, wide = ext & 0x400;
      const s = readEa(mode, reg, 2);
      if (s === 0) { exception(5, pc, at); return; }
      let n, d;
      if (signed) { d = BigInt(s | 0); n = wide ? BigInt.asIntN(64, (BigInt(D[dr] >>> 0) << 32n) | BigInt(D[dq] >>> 0)) : BigInt(D[dq]); }
      else { d = BigInt(s >>> 0); n = wide ? (BigInt(D[dr] >>> 0) << 32n) | BigInt(D[dq] >>> 0) : BigInt(D[dq] >>> 0); }
      const q = n / d, r = n % d;
      fC = 0;
      if (signed ? (q > 2147483647n || q < -2147483648n) : q > 4294967295n) { fV = 1; cyc += 80; return; }
      const qn = Number(BigInt.asUintN(32, q)), rn = Number(BigInt.asUintN(32, r));
      if (dr !== dq) D[dr] = rn | 0;
      D[dq] = qn | 0;
      fV = 0; fN = qn >>> 31; fZ = qn === 0 ? 1 : 0;
      cyc += 80;
    }

    // ── 68020: ビットフィールド(kind 0 TST / 1 EXTU / 2 CHG / 3 EXTS / 4 CLR / 5 FFO / 6 SET / 7 INS)──
    function bitfield(op, at, mode, reg) {
      const kind = op >> 8 & 7, ext = fetch16(), dn = ext >> 12 & 7;
      let offset = ext & 0x800 ? D[ext >> 6 & 7] : ext >> 6 & 31;
      let width = ext & 0x20 ? D[ext & 7] & 31 : ext & 31;
      if (width === 0) width = 32;
      let field, old, a = 0, bo = 0;
      const wm = width === 32 ? 4294967296 : Math.pow(2, width);
      if (mode === 0) {
        offset &= 31;
        old = D[reg] >>> 0;
        const rot = offset === 0 ? old : ((old << offset) | (old >>> (32 - offset))) >>> 0;   // フィールドを上位へ寄せる
        field = width === 32 ? rot : rot >>> (32 - width);
      } else {
        a = eaAddr(mode, reg, 0);
        a = (a + (offset >> 3)) >>> 0; bo = offset & 7;      // offset は符号つき。>> は床関数になる
        const nb = (bo + width + 7) >> 3;
        old = 0; for (let i = 0; i < 5; i++) old = old * 256 + (i < nb ? rd8((a + i) >>> 0) : 0);   // 40bit(上位詰め)
        field = Math.floor(old / Math.pow(2, 40 - bo - width)) % wm;
      }
      fN = Math.floor(field / (wm / 2)) & 1; fZ = field === 0 ? 1 : 0; fV = 0; fC = 0;
      let nv = -1;
      switch (kind) {
        case 0: break;
        case 1: D[dn] = field | 0; break;
        case 3: D[dn] = width === 32 ? field | 0 : (field << (32 - width)) >> (32 - width); break;
        case 5: { let k = 0; while (k < width && !(Math.floor(field / Math.pow(2, width - 1 - k)) & 1)) k++; D[dn] = (offset + k) | 0; break; }
        case 2: nv = wm - 1 - field; break;
        case 4: nv = 0; break;
        case 6: nv = wm - 1; break;
        default: {
          nv = width === 32 ? D[dn] >>> 0 : (D[dn] >>> 0) % wm;
          fN = Math.floor(nv / (wm / 2)) & 1; fZ = nv === 0 ? 1 : 0;
        }
      }
      if (nv < 0) return;
      if (mode === 0) {
        const up = width === 32 ? nv : (nv << (32 - width)) >>> 0, maskUp = width === 32 ? 0xffffffff : ((wm - 1) << (32 - width)) >>> 0;
        const rot = offset === 0 ? old : ((old << offset) | (old >>> (32 - offset))) >>> 0;
        const r2 = ((rot & ~maskUp) | up) >>> 0;
        D[reg] = (offset === 0 ? r2 : ((r2 >>> offset) | (r2 << (32 - offset)))) | 0;
      } else {
        const sh = Math.pow(2, 40 - bo - width), nb = (bo + width + 7) >> 3;
        const res = old + (nv - field) * sh;
        for (let i = 0; i < nb; i++) wr8((a + i) >>> 0, Math.floor(res / Math.pow(2, 32 - i * 8)) & 0xff);
      }
    }

    // ── 68020: MOVEC ──
    function movec(at, toCtl) {
      if (!fS) return exception(8, at);
      const ext = fetch16(), r = ext >> 12 & 7, isA = ext & 0x8000, id = ext & 0xfff;
      if (toCtl) {
        const v = isA ? A[r] : D[r];
        switch (id) {
          case 0x000: sfc = v & 7; break; case 0x001: dfc = v & 7; break; case 0x002: cacr = v & 3; break;
          case 0x800: usp = v; break; case 0x801: vbr = v >>> 0; break; case 0x802: caar = v; break;
          case 0x803: if (fM) A[7] = v; else msp = v; break;
          case 0x804: if (!fM) A[7] = v; else isp = v; break;
          default: return illegal(0x4E7B, at);
        }
      } else {
        let v;
        switch (id) {
          case 0x000: v = sfc; break; case 0x001: v = dfc; break; case 0x002: v = cacr; break;
          case 0x800: v = usp; break; case 0x801: v = vbr; break; case 0x802: v = caar; break;
          case 0x803: v = fM ? A[7] : msp; break;
          case 0x804: v = !fM ? A[7] : isp; break;
          default: return illegal(0x4E7A, at);
        }
        if (isA) A[r] = v | 0; else D[r] = v | 0;
      }
      cyc += 8;
    }

    function step() {
      const at = pc, op = fetch16();
      const mode = op >> 3 & 7, reg = op & 7, rx = op >> 9 & 7;
      switch (op >> 12) {
        case 0x0: {
          if (op & 0x100) {
            if (mode === 1) {   // MOVEP
              const dir = op >> 6 & 3; const a = (A[reg] + s16(fetch16())) >>> 0;
              if (dir === 0) setD(rx, 1, rd8(a) << 8 | rd8(a + 2));
              else if (dir === 1) D[rx] = (rd8(a) << 24 | rd8(a + 2) << 16 | rd8(a + 4) << 8 | rd8(a + 6)) | 0;
              else if (dir === 2) { wr8(a, D[rx] >> 8); wr8(a + 2, D[rx]); }
              else { wr8(a, D[rx] >>> 24); wr8(a + 2, D[rx] >> 16); wr8(a + 4, D[rx] >> 8); wr8(a + 6, D[rx]); }
              return;
            }
            return bitOp(op, D[rx], mode, reg);
          }
          const kind = op >> 9 & 7, sz = op >> 6 & 3;
          if (kind === 4) return bitOp(op, fetch16(), mode, reg);
          if (sz === 3) {
            if (kind < 3) {   // CMP2 / CHK2
              const ext = fetch16(), r = ext >> 12 & 7, a = eaAddr(mode, reg, kind);
              const lo = sext(kind, rd(kind, a)), hi = sext(kind, rd(kind, (a + BYTES[kind]) >>> 0));
              const v = ext & 0x8000 ? A[r] : sext(kind, D[r]);
              fZ = (v === lo || v === hi) ? 1 : 0;
              // 境界は符号つき / 符号なしのどちらでも通るように、lo <= hi なら符号つき、逆なら符号なしで見る
              const out = lo <= hi ? (v < lo || v > hi) : ((v >>> 0) < (lo >>> 0) || (v >>> 0) > (hi >>> 0));
              fC = out ? 1 : 0;
              if (out && (ext & 0x800)) exception(6, pc, at);
              return;
            }
            if (kind >= 5) {   // CAS / CAS2
              const csz = kind - 5;
              if (mode === 7 && reg === 4) {
                const e1 = fetch16(), e2 = fetch16();
                const a1 = (e1 & 0x8000 ? A[e1 >> 12 & 7] : D[e1 >> 12 & 7]) >>> 0, a2 = (e2 & 0x8000 ? A[e2 >> 12 & 7] : D[e2 >> 12 & 7]) >>> 0;
                const v1 = rd(csz, a1), v2 = rd(csz, a2);
                sub(csz, D[e1 & 7], v1, 0, false);
                if (fZ) sub(csz, D[e2 & 7], v2, 0, false);
                if (fZ) { wr(csz, a1, D[e1 >> 6 & 7]); wr(csz, a2, D[e2 >> 6 & 7]); }
                else { setD(e1 & 7, csz, v1); setD(e2 & 7, csz, v2); }
                return;
              }
              const ext = fetch16(), a = eaAddr(mode, reg, csz), v = rd(csz, a);
              sub(csz, D[ext & 7], v, 0, false);
              if (fZ) wr(csz, a, D[ext >> 6 & 7]); else setD(ext & 7, csz, v);
              return;
            }
            return illegal(op, at);   // CALLM / RTM
          }
          if (kind === 7) {   // MOVES
            if (!fS) return exception(8, at);
            const ext = fetch16(), r = ext >> 12 & 7, a = eaAddr(mode, reg, sz);
            if (ext & 0x800) wr(sz, a, ext & 0x8000 ? A[r] : D[r]);
            else { const v = rd(sz, a); if (ext & 0x8000) A[r] = sext(sz, v); else setD(r, sz, v); }
            return;
          }
          if (mode === 7 && reg === 4) {   // CCR / SR への演算
            const v = fetch16();
            if (sz === 1 && !fS) return exception(8, at);
            const cur = sz === 0 ? getCcr() : getSr();
            const r = kind === 0 ? cur | v : kind === 1 ? cur & v : kind === 5 ? cur ^ v : -1;
            if (r < 0) return illegal(op, at);
            if (sz === 0) setCcr(r); else setSr(r);
            cyc += 6; return;
          }
          const imm = sz === 2 ? fetch32() : sz === 1 ? fetch16() : fetch16() & 0xff;
          if (kind === 6) { const d = readEa(mode, reg, sz); sub(sz, imm, d, 0, false); return; }   // CMPI
          const d = rmwRead(mode, reg, sz);
          let r;
          switch (kind) {
            case 0: r = logic(sz, d | imm); break;
            case 1: r = logic(sz, d & imm); break;
            case 2: r = sub(sz, imm, d, 0, true); break;
            case 3: r = add(sz, imm, d, 0); break;
            case 5: r = logic(sz, d ^ imm); break;
            default: return illegal(op, at);
          }
          rmwWrite(sz, r);
          return;
        }
        case 0x1: case 0x2: case 0x3: {   // MOVE / MOVEA
          const sz = (op >> 12) === 1 ? 0 : (op >> 12) === 3 ? 1 : 2;
          const v = readEa(mode, reg, sz), dm = op >> 6 & 7;
          if (dm === 1) { A[rx] = sz === 1 ? s16(v) : v | 0; return; }
          logic(sz, v);
          writeEa(dm, rx, sz, v);
          return;
        }
        case 0x4: return group4(op, at, mode, reg, rx);
        case 0x5: {
          const sz = op >> 6 & 3;
          if (sz === 3) {
            const cc = op >> 8 & 15;
            if (mode === 1) {   // DBcc
              const base = pc, disp = s16(fetch16());
              if (!cond(cc)) {
                const c = ((D[reg] & 0xffff) - 1) & 0xffff; setD(reg, 1, c);
                if (c !== 0xffff) pc = (base + disp) >>> 0;
              }
              cyc += 4;
              return;
            }
            if (mode === 7 && reg >= 2) {   // TRAPcc
              if (reg === 2) fetch16(); else if (reg === 3) fetch32(); else if (reg !== 4) return illegal(op, at);
              if (cond(cc)) exception(7, pc, at);
              return;
            }
            const t = cond(cc);   // Scc
            if (mode === 0) setD(reg, 0, t ? 0xff : 0); else wr8(eaAddr(mode, reg, 0), t ? 0xff : 0);
            return;
          }
          const q = rx || 8;   // ADDQ / SUBQ
          if (mode === 1) { A[reg] = (op & 0x100 ? A[reg] - q : A[reg] + q) | 0; return; }
          const d = rmwRead(mode, reg, sz);
          rmwWrite(sz, op & 0x100 ? sub(sz, q, d, 0, true) : add(sz, q, d, 0));
          return;
        }
        case 0x6: {   // Bcc / BRA / BSR
          const cc = op >> 8 & 15, base = pc;
          let disp = s8(op);
          if (disp === 0) disp = s16(fetch16()); else if (disp === -1) disp = fetch32() | 0;
          if (cc === 1) { A[7] = (A[7] - 4) | 0; wr32(A[7], pc); pc = (base + disp) >>> 0; cyc += 2; return; }
          if (cond(cc)) { pc = (base + disp) >>> 0; cyc += 4; } else cyc += 2;
          return;
        }
        case 0x7: if (op & 0x100) return illegal(op, at); D[rx] = s8(op); logic(2, D[rx]); return;   // MOVEQ
        case 0x8: case 0xC: {
          const isAnd = (op >> 12) === 0xC, opm = op >> 6 & 7;
          if (opm === 3 || opm === 7) {   // DIVU / DIVS / MULU / MULS(語)
            const s = readEa(mode, reg, 1);
            if (isAnd) {
              const r = opm === 3 ? (D[rx] & 0xffff) * s : Math.imul(s16(D[rx]), s16(s));
              D[rx] = r | 0; logic(2, D[rx]); cyc += 25; return;
            }
            if (s === 0) { exception(5, pc, at); return; }
            if (opm === 3) {
              const n = D[rx] >>> 0, q = Math.floor(n / s), r = n % s;
              if (q > 0xffff) { fV = 1; fN = 1; fC = 0; } else { D[rx] = (r << 16 | q) | 0; logic(1, q); }
              cyc += 42;
            } else {
              const n = D[rx], dv = s16(s), q = Math.trunc(n / dv), r = n - q * dv;
              if (q > 32767 || q < -32768) { fV = 1; fN = 1; fC = 0; } else { D[rx] = ((r & 0xffff) << 16 | (q & 0xffff)) | 0; logic(1, q); }
              cyc += 54;
            }
            return;
          }
          if ((op & 0x1f0) === 0x100) {   // SBCD / ABCD
            let s, d;
            if (mode === 1) { s = rd8(eaAddr(4, reg, 0)); const a = eaAddr(4, rx, 0); d = rd8(a); wr8(a, bcd(!isAnd, s, d)); }
            else { s = D[reg] & 0xff; d = D[rx] & 0xff; setD(rx, 0, bcd(!isAnd, s, d)); }
            return;
          }
          if (!isAnd && mode < 2 && (opm === 5 || opm === 6)) {   // PACK / UNPK
            const adj = fetch16();
            if (opm === 5) {
              let s; if (mode === 1) { const lo = rd8(eaAddr(4, reg, 0)), hi = rd8(eaAddr(4, reg, 0)); s = hi << 8 | lo; } else s = D[reg] & 0xffff;
              s = (s + adj) & 0xffff; const r = (s >> 4 & 0xf0) | (s & 0x0f);
              if (mode === 1) wr8(eaAddr(4, rx, 0), r); else setD(rx, 0, r);
            } else {
              const s = mode === 1 ? rd8(eaAddr(4, reg, 0)) : D[reg] & 0xff;
              const r = (((s << 4 & 0x0f00) | (s & 0x0f)) + adj) & 0xffff;
              if (mode === 1) { wr8(eaAddr(4, rx, 0), r); wr8(eaAddr(4, rx, 0), r >> 8); } else setD(rx, 1, r);
            }
            return;
          }
          if (isAnd && (op & 0x130) === 0x100 && (opm === 5 || opm === 6)) {   // EXG
            const m5 = op >> 3 & 0x1f;
            if (m5 === 0x08) { const t = D[rx]; D[rx] = D[reg]; D[reg] = t; }
            else if (m5 === 0x09) { const t = A[rx]; A[rx] = A[reg]; A[reg] = t; }
            else if (m5 === 0x11) { const t = D[rx]; D[rx] = A[reg]; A[reg] = t; }
            else return illegal(op, at);
            return;
          }
          const sz = opm & 3;
          if (opm & 4) { const d = rmwRead(mode, reg, sz); rmwWrite(sz, logic(sz, isAnd ? d & D[rx] : d | D[rx])); }
          else { const s = readEa(mode, reg, sz); setD(rx, sz, logic(sz, isAnd ? (D[rx] & s) : (D[rx] | s))); }
          return;
        }
        case 0x9: case 0xD: {   // SUB / ADD
          const isAdd = (op >> 12) === 0xD, opm = op >> 6 & 7;
          if (opm === 3 || opm === 7) {   // ADDA / SUBA
            const sz = opm === 3 ? 1 : 2, s = sext(sz, readEa(mode, reg, sz));
            A[rx] = (isAdd ? A[rx] + s : A[rx] - s) | 0; return;
          }
          const sz = opm & 3;
          if ((opm & 4) && mode < 2) {   // ADDX / SUBX
            const z = fZ;
            if (mode === 1) { const s = rd(sz, eaAddr(4, reg, sz)), a = eaAddr(4, rx, sz), d = rd(sz, a); wr(sz, a, isAdd ? add(sz, s, d, fX) : sub(sz, s, d, fX, true)); }
            else { const r = isAdd ? add(sz, D[reg], D[rx], fX) : sub(sz, D[reg], D[rx], fX, true); setD(rx, sz, r); }
            if (fZ) fZ = z;
            return;
          }
          if (opm & 4) { const d = rmwRead(mode, reg, sz); rmwWrite(sz, isAdd ? add(sz, D[rx], d, 0) : sub(sz, D[rx], d, 0, true)); }
          else { const s = readEa(mode, reg, sz); setD(rx, sz, isAdd ? add(sz, s, D[rx], 0) : sub(sz, s, D[rx], 0, true)); }
          return;
        }
        case 0xB: {   // CMP / CMPA / EOR / CMPM
          const opm = op >> 6 & 7;
          if (opm === 3 || opm === 7) { const sz = opm === 3 ? 1 : 2, s = sext(sz, readEa(mode, reg, sz)); sub(2, s, A[rx], 0, false); return; }
          const sz = opm & 3;
          if (!(opm & 4)) { const s = readEa(mode, reg, sz); sub(sz, s, D[rx], 0, false); return; }
          if (mode === 1) { const s = rd(sz, eaAddr(3, reg, sz)), d = rd(sz, eaAddr(3, rx, sz)); sub(sz, s, d, 0, false); return; }
          { const d = rmwRead(mode, reg, sz); rmwWrite(sz, logic(sz, d ^ D[rx])); }
          return;
        }
        case 0xE: {
          const sz = op >> 6 & 3, left = op >> 8 & 1;
          if (sz === 3) {
            if (op & 0x800) return bitfield(op, at, mode, reg);
            const kind = op >> 9 & 3, a = eaAddr(mode, reg, 1);   // メモリを 1 ビット
            wr16(a, shift(kind, left, 1, rd16(a), 1)); return;
          }
          const kind = op >> 3 & 3, n = op & 0x20 ? D[rx] & 63 : (rx || 8);
          setD(reg, sz, shift(kind, left, sz, D[reg], n));
          cyc += 4;
          return;
        }
        default: return illegal(op, at);
      }
    }

    function bitOp(op, bitNo, mode, reg) {
      const kind = op >> 6 & 3;
      if (mode === 0) {
        const b = 1 << (bitNo & 31);
        fZ = (D[reg] & b) ? 0 : 1;
        if (kind === 1) D[reg] ^= b; else if (kind === 2) D[reg] &= ~b; else if (kind === 3) D[reg] |= b;
        return;
      }
      const b = 1 << (bitNo & 7);
      if (kind === 0) { fZ = (readEa(mode, reg, 0) & b) ? 0 : 1; return; }
      const a = eaAddr(mode, reg, 0), v = rd8(a);
      fZ = (v & b) ? 0 : 1;
      wr8(a, kind === 1 ? v ^ b : kind === 2 ? v & ~b : v | b);
    }

    function group4(op, at, mode, reg, rx) {
      if (op & 0x100) {
        if ((op & 0x1c0) === 0x1c0) {
          if (mode === 0) { D[reg] = s8(D[reg]); logic(2, D[reg]); return; }   // EXTB.L
          A[rx] = eaAddr(mode, reg, 2) | 0; return;                            // LEA
        }
        if ((op & 0x1c0) === 0x180 || (op & 0x1c0) === 0x100) {   // CHK(語 / ロング)
          const long = (op & 0x1c0) === 0x100;
          const b = long ? readEa(mode, reg, 2) | 0 : s16(readEa(mode, reg, 1)), v = long ? D[rx] : s16(D[rx]);
          if (v < 0) { fN = 1; exception(6, pc, at); } else if (v > b) { fN = 0; exception(6, pc, at); }
          cyc += 4; return;
        }
        return illegal(op, at);
      }
      const sz = op >> 6 & 3;
      switch (op >> 8 & 15) {
        case 0x0:
          if (sz === 3) { if (!fS) return exception(8, at); writeEa(mode, reg, 1, getSr()); return; }   // MOVE SR, ea(特権)
          { const d = rmwRead(mode, reg, sz), z = fZ, r = sub(sz, d, 0, fX, true); if (r === 0) fZ = z; rmwWrite(sz, r); }   // NEGX
          return;
        case 0x2:
          if (sz === 3) { writeEa(mode, reg, 1, getCcr()); return; }   // MOVE CCR, ea
          if (mode === 0) setD(reg, sz, 0); else wr(sz, eaAddr(mode, reg, sz), 0);   // CLR(68020 は読まない)
          fN = 0; fZ = 1; fV = 0; fC = 0; return;
        case 0x4:
          if (sz === 3) { setCcr(readEa(mode, reg, 1)); cyc += 4; return; }     // MOVE ea, CCR
          { const d = rmwRead(mode, reg, sz); rmwWrite(sz, sub(sz, d, 0, 0, true)); }   // NEG
          return;
        case 0x6:
          if (sz === 3) { if (!fS) return exception(8, at); setSr(readEa(mode, reg, 1)); cyc += 6; return; }   // MOVE ea, SR
          { const d = rmwRead(mode, reg, sz); rmwWrite(sz, logic(sz, ~d & MASK[sz])); }   // NOT
          return;
        case 0x8:
          if (sz === 0) {
            if (mode === 1) { A[7] = (A[7] - 4) | 0; wr32(A[7], A[reg]); A[reg] = A[7]; A[7] = (A[7] + (fetch32() | 0)) | 0; return; }   // LINK.L
            const d = rmwRead(mode, reg, 0), z = fZ; fZ = 1; const r = bcd(true, d, 0); if (r === 0) fZ = z; rmwWrite(0, r); return;   // NBCD
          }
          if (sz === 1) {
            if (mode === 0) { D[reg] = (D[reg] << 16) | (D[reg] >>> 16); logic(2, D[reg]); return; }   // SWAP
            if (mode === 1) return illegal(op, at);   // BKPT
            const a = eaAddr(mode, reg, 2); A[7] = (A[7] - 4) | 0; wr32(A[7], a); return;   // PEA
          }
          if (mode === 0) { if (sz === 2) { setD(reg, 1, s8(D[reg])); logic(1, D[reg]); } else { D[reg] = s16(D[reg]); logic(2, D[reg]); } return; }   // EXT
          return movem(op);
        case 0xA:
          if (sz === 3) {
            if (mode === 7 && reg === 4) return illegal(op, at);
            if (mode === 0) { logic(0, D[reg]); D[reg] |= 0x80; return; }   // TAS
            const a = eaAddr(mode, reg, 0), v = rd8(a); logic(0, v); wr8(a, v | 0x80); return;
          }
          logic(sz, readEa(mode, reg, sz)); return;   // TST
        case 0xC:
          if (sz === 0) return mull(at, mode, reg);
          if (sz === 1) return divl(at, mode, reg);
          return movem(op);
        case 0xE:
          if (sz === 1) {
            if (mode < 2) { exception(32 + (op & 15), pc); return; }   // TRAP
            if (mode === 2) { A[7] = (A[7] - 4) | 0; wr32(A[7], A[reg]); A[reg] = A[7]; A[7] = (A[7] + s16(fetch16())) | 0; return; }   // LINK
            if (mode === 3) { A[7] = A[reg]; A[reg] = rd32(A[7]) | 0; A[7] = (A[7] + 4) | 0; return; }   // UNLK
            if (mode === 4) { if (!fS) return exception(8, at); usp = A[reg]; return; }   // MOVE An, USP
            if (mode === 5) { if (!fS) return exception(8, at); A[reg] = usp; return; }   // MOVE USP, An
            switch (op & 0x3f) {
              case 0x30: if (!fS) return exception(8, at); cyc += 500; if (bus.reset) bus.reset(); return;   // RESET
              case 0x31: return;   // NOP
              case 0x32: if (!fS) return exception(8, at); setSr(fetch16()); stopped = true; return;   // STOP
              case 0x33: if (!fS) return exception(8, at); rte(at); cyc += 10; return;   // RTE
              case 0x34: { const p = rd32(A[7]); A[7] = (A[7] + 4 + s16(fetch16())) | 0; pc = p; cyc += 4; return; }   // RTD
              case 0x35: pc = rd32(A[7]); A[7] = (A[7] + 4) | 0; cyc += 4; return;   // RTS
              case 0x36: if (fV) exception(7, pc, at); return;   // TRAPV
              case 0x37: { setCcr(rd16(A[7])); A[7] = (A[7] + 2) | 0; pc = rd32(A[7]); A[7] = (A[7] + 4) | 0; cyc += 4; return; }   // RTR
              case 0x3a: return movec(at, false);
              case 0x3b: return movec(at, true);
              default: return illegal(op, at);
            }
          }
          if (sz === 2) { const a = eaAddr(mode, reg, 2); A[7] = (A[7] - 4) | 0; wr32(A[7], pc); pc = a; cyc += 2; return; }   // JSR
          if (sz === 3) { pc = eaAddr(mode, reg, 2); cyc += 2; return; }   // JMP
          return illegal(op, at);
        default: return illegal(op, at);
      }
    }

    function reset() {
      D.fill(0); A.fill(0); usp = 0; msp = 0; isp = 0; vbr = 0; cacr = 0; caar = 0; sfc = 0; dfc = 0;
      fT = 0; fS = 1; fM = 0; fI = 7; setCcr(0); stopped = false; irq = 0;
      A[7] = rd32(0) | 0; pc = rd32(4);
    }
    function run(until) {
      while (cyc < until) {
        if (irq && checkIrq()) continue;
        if (stopped) { cyc = until; break; }
        step();
      }
    }
    function getState() { return { D: D.slice(), A: A.slice(), n: [pc, cyc, irq, stopped ? 1 : 0, getSr(), usp, isp, msp, vbr, cacr, caar, sfc, dfc] }; }
    function setState(s) {
      D.set(s.D); A.set(s.A); let st, sr;
      [pc, cyc, irq, st, sr, usp, isp, msp, vbr, cacr, caar, sfc, dfc] = s.n;
      stopped = !!st; fS = sr >> 13 & 1; fM = sr >> 12 & 1; fT = sr >> 14 & 3; fI = sr >> 8 & 7; setCcr(sr);
    }
    return { reset, run, step, setIrq(level) { irq = level & 7; }, getState, setState,
      get pc() { return pc; }, get cycles() { return cyc; }, set cycles(v) { cyc = v; }, get sr() { return getSr(); }, get d() { return D; }, get a() { return A; },
      get illegalCount() { return illegalCount; }, get lastIllegal() { return lastIllegal; }, get stopped() { return stopped; } };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
