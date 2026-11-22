/*
 * MML.Emu.createM68000(bus) — モトローラ MC68000。
 *
 * タイトーの Ensoniq 音源基板(F3 ほか)のサウンド CPU 用に書いた物。命令は 68000 の全部(ユーザ/スーパバイザ、例外、割り込み)。
 * 命令の意味はモトローラの「M68000 Family Programmer's Reference Manual」のとおり。
 * サイクル数は「バスの読み書き 1 回 = 4 クロック」を数え、命令ごとの内部の待ち(乗除算、シフト、分岐など)を足す近似。
 * 1 クロックの狂いが効く使い方(ラスタ同期など)には足りない。音源のタイマ割り込みで動くドライバには足りる。
 *
 * bus: { read8(a), read16(a), write8(a, v), write16(a, v), irqAck(level) → ベクタ番号(省略時は自動ベクタ 24 + level) }
 *   番地は 24bit に切ってから渡す。16bit の読み書きは偶数番地。
 * 口: reset() / run(until)(通しのクロック数 until まで進める)/ setIrq(level)(0 = 無し。レベルは外が保つ)/ pc / cycles / getState / setState
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};

  Emu.createM68000 = function (bus) {
    const D = new Int32Array(8), A = new Int32Array(8);
    let pc = 0, cyc = 0, irq = 0, stopped = false, otherSp = 0, illegalCount = 0;
    // SR: T(15) S(13) I(10-8) X N Z V C。フラグは 0/1 でばらに持つ
    let fT = 0, fS = 1, fI = 7, fX = 0, fN = 0, fZ = 0, fV = 0, fC = 0;
    const MASK = [0xff, 0xffff, 0xffffffff], MSB = [0x80, 0x8000, 0x80000000], BYTES = [1, 2, 4];

    // ── バス(1 回 4 クロック)──
    function rd8(a) { cyc += 4; return bus.read8(a & 0xffffff); }
    function rd16(a) { cyc += 4; return bus.read16(a & 0xfffffe); }
    function rd32(a) { return ((rd16(a) << 16) | rd16(a + 2)) >>> 0; }
    function wr8(a, v) { cyc += 4; bus.write8(a & 0xffffff, v & 0xff); }
    function wr16(a, v) { cyc += 4; bus.write16(a & 0xfffffe, v & 0xffff); }
    function wr32(a, v) { wr16(a, v >>> 16); wr16(a + 2, v); }
    // 下位の語から書く(実機の順番: 読んで書き戻す命令のロング、-(An) へのロングの書き込み)。番地ごとに副作用のある相手(音源のレジスタ)では順番が見える
    function wr32lo(a, v) { wr16(a + 2, v); wr16(a, v >>> 16); }
    const rd = (sz, a) => (sz === 0 ? rd8(a) : sz === 1 ? rd16(a) : rd32(a));
    const wr = (sz, a, v) => { if (sz === 0) wr8(a, v); else if (sz === 1) wr16(a, v); else wr32(a, v); };
    function fetch16() { const v = rd16(pc); pc = (pc + 2) >>> 0; return v; }
    function fetch32() { const h = fetch16(); return ((h << 16) | fetch16()) >>> 0; }
    const s8 = (v) => v << 24 >> 24, s16 = (v) => v << 16 >> 16;
    const sext = (sz, v) => (sz === 0 ? v << 24 >> 24 : sz === 1 ? v << 16 >> 16 : v | 0);

    // ── SR ──
    function getCcr() { return fX << 4 | fN << 3 | fZ << 2 | fV << 1 | fC; }
    function setCcr(v) { fX = v >> 4 & 1; fN = v >> 3 & 1; fZ = v >> 2 & 1; fV = v >> 1 & 1; fC = v & 1; }
    function getSr() { return fT << 15 | fS << 13 | fI << 8 | getCcr(); }
    function setSr(v) {
      const s = v >> 13 & 1;
      if (s !== fS) { const t = A[7]; A[7] = otherSp; otherSp = t; fS = s; }   // スタックポインタを入れ替える
      fT = v >> 15 & 1; fI = v >> 8 & 7; setCcr(v);
    }

    // ── 実効アドレス ──
    // 算出した番地(メモリの時)。mode 0 / 1 はレジスタ、mode 7 reg 4 は即値
    function index(base) {
      const ext = fetch16(), r = ext >> 12 & 7;
      let x = ext & 0x8000 ? A[r] : D[r];
      if (!(ext & 0x800)) x = s16(x);
      cyc += 2;
      return (base + s8(ext) + x) >>> 0;
    }
    function eaAddr(mode, reg, sz) {
      switch (mode) {
        case 2: return A[reg] >>> 0;
        case 3: { const a = A[reg]; A[reg] = (a + (sz === 0 && reg === 7 ? 2 : BYTES[sz])) | 0; return a >>> 0; }
        case 4: { cyc += 2; A[reg] = (A[reg] - (sz === 0 && reg === 7 ? 2 : BYTES[sz])) | 0; return A[reg] >>> 0; }
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
    // 読むだけ
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
      else if (sz === 2 && mode === 4) wr32lo(eaAddr(mode, reg, sz), v);
      else wr(sz, eaAddr(mode, reg, sz), v);
    }
    // 読んで書く(番地は 1 回だけ求める)
    let rmwAddr = 0, rmwReg = -1;
    function rmwRead(mode, reg, sz) {
      if (mode === 0) { rmwReg = reg; return D[reg] & MASK[sz]; }
      rmwReg = -1; rmwAddr = eaAddr(mode, reg, sz);
      return rd(sz, rmwAddr) >>> 0;
    }
    function rmwWrite(sz, v) { if (rmwReg >= 0) setD(rmwReg, sz, v); else if (sz === 2) wr32lo(rmwAddr, v); else wr(sz, rmwAddr, v); }

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
    // d - s - x。setX = false は CMP(X を変えない)
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

    // ── 例外 ──
    function exception(vec, retPc) {
      const sr = getSr();
      if (!fS) { const t = A[7]; A[7] = otherSp; otherSp = t; fS = 1; }
      fT = 0;
      A[7] = (A[7] - 4) | 0; wr32(A[7], retPc);
      A[7] = (A[7] - 2) | 0; wr16(A[7], sr);
      pc = rd32(vec * 4);
      cyc += 10;
    }
    function illegal(op, at) { if ((op >> 12) !== 0xA && (op >> 12) !== 0xF) illegalCount++; exception((op >> 12) === 0xA ? 10 : (op >> 12) === 0xF ? 11 : 4, at); }
    function checkIrq() {
      if (irq > fI || irq === 7) {
        const level = irq;
        stopped = false;
        const vec = bus.irqAck ? bus.irqAck(level) : 24 + level;
        exception(vec, pc);
        fI = level;
        cyc += 10;
        return true;
      }
      return false;
    }

    // ── シフト・回転(kind 0 AS / 1 LS / 2 ROX / 3 RO、left)──
    function shift(kind, left, sz, v, n) {
      const m = MASK[sz] >>> 0, msb = MSB[sz] >>> 0, bits = BYTES[sz] * 8;
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
      void bits;
      flagsNZ(sz, v);
      return v;
    }

    function movem(op) {
      const toReg = op & 0x400, sz = op & 0x40 ? 2 : 1, mode = op >> 3 & 7, reg = op & 7, list = fetch16(), step = BYTES[sz];
      if (!toReg) {
        if (mode === 4) {   // -(An): 並びが逆(A7 … D0)
          let a = A[reg] >>> 0;
          for (let i = 0; i < 16; i++) if (list >> i & 1) { a = (a - step) >>> 0; const v = i < 8 ? A[7 - i] : D[15 - i]; wr(sz, a, v); }
          A[reg] = a | 0;
        } else {
          let a = eaAddr(mode, reg, sz);
          for (let i = 0; i < 16; i++) if (list >> i & 1) { wr(sz, a, i < 8 ? D[i] : A[i - 8]); a = (a + step) >>> 0; }
        }
      } else {
        let a = mode === 3 ? A[reg] >>> 0 : eaAddr(mode, reg, sz);
        for (let i = 0; i < 16; i++) if (list >> i & 1) { const v = sz === 1 ? s16(rd16(a)) : rd32(a) | 0; if (i < 8) D[i] = v; else A[i - 8] = v; a = (a + step) >>> 0; }
        if (mode === 3) A[reg] = a | 0;
        cyc += 4;
      }
    }

    function bcd(sub2, s, d) {
      // ABCD / SBCD(X つき)。Z は結果が 0 でない時だけ落とす
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

    function step() {
      const at = pc, op = fetch16();
      const mode = op >> 3 & 7, reg = op & 7, rx = op >> 9 & 7;
      switch (op >> 12) {
        case 0x0: {
          if (op & 0x100) {
            if (mode === 1) {   // MOVEP
              const dir = op >> 6 & 3; let a = (A[reg] + s16(fetch16())) >>> 0;
              if (dir === 0) setD(rx, 1, rd8(a) << 8 | rd8(a + 2));
              else if (dir === 1) D[rx] = (rd8(a) << 24 | rd8(a + 2) << 16 | rd8(a + 4) << 8 | rd8(a + 6)) | 0;
              else if (dir === 2) { wr8(a, D[rx] >> 8); wr8(a + 2, D[rx]); }
              else { wr8(a, D[rx] >>> 24); wr8(a + 2, D[rx] >> 16); wr8(a + 4, D[rx] >> 8); wr8(a + 6, D[rx]); }
              return;
            }
            return bitOp(op, D[rx], mode, reg);          // BTST/BCHG/BCLR/BSET Dn
          }
          const kind = op >> 9 & 7, sz = op >> 6 & 3;
          if (kind === 4) return bitOp(op, fetch16(), mode, reg);   // ビット操作(即値)
          if (sz === 3) return illegal(op, at);
          if (mode === 7 && reg === 4) {   // CCR / SR への演算
            const v = fetch16();
            if (sz === 1 && !fS) return exception(8, at);
            const cur = sz === 0 ? getCcr() : getSr();
            const r = kind === 0 ? cur | v : kind === 1 ? cur & v : kind === 5 ? cur ^ v : -1;
            if (r < 0) return illegal(op, at);
            if (sz === 0) setCcr(r); else setSr(r);
            cyc += 8; return;
          }
          const imm = sz === 2 ? fetch32() : sz === 1 ? fetch16() : fetch16() & 0xff;
          if (kind === 6) { const d = readEa(mode, reg, sz); sub(sz, imm, d, 0, false); if (mode === 0 && sz === 2) cyc += 2; return; }   // CMPI
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
          if (mode === 0 && sz === 2) cyc += 4;
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
              const disp = s16(rd16(pc)), base = pc; pc = (pc + 2) >>> 0;
              if (!cond(cc)) {
                const c = ((D[reg] & 0xffff) - 1) & 0xffff; setD(reg, 1, c);
                if (c !== 0xffff) { pc = (base + disp) >>> 0; cyc += 2; } else cyc += 6;
              } else cyc += 4;
              return;
            }
            const t = cond(cc);   // Scc
            if (mode === 0) { setD(reg, 0, t ? 0xff : 0); if (t) cyc += 2; } else { const a = eaAddr(mode, reg, 0); rd8(a); wr8(a, t ? 0xff : 0); }
            return;
          }
          const q = rx || 8;   // ADDQ / SUBQ
          if (mode === 1) { A[reg] = (op & 0x100 ? A[reg] - q : A[reg] + q) | 0; cyc += 4; return; }
          const d = rmwRead(mode, reg, sz);
          rmwWrite(sz, op & 0x100 ? sub(sz, q, d, 0, true) : add(sz, q, d, 0));
          if (mode === 0 && sz === 2) cyc += 4;
          return;
        }
        case 0x6: {   // Bcc / BRA / BSR
          const cc = op >> 8 & 15, base = pc;
          let disp = s8(op);
          if (disp === 0) disp = s16(fetch16());
          if (cc === 1) { A[7] = (A[7] - 4) | 0; wr32(A[7], pc); pc = (base + disp) >>> 0; cyc += 2; return; }
          if (cond(cc)) { pc = (base + disp) >>> 0; cyc += 2; if ((op & 0xff) !== 0) cyc += 4; } else cyc += 4;
          return;
        }
        case 0x7: if (op & 0x100) return illegal(op, at); D[rx] = s8(op); logic(2, D[rx]); return;   // MOVEQ
        case 0x8: case 0xC: {
          const isAnd = (op >> 12) === 0xC, opm = op >> 6 & 7;
          if (opm === 3 || opm === 7) {   // DIVU / DIVS / MULU / MULS
            const s = readEa(mode, reg, 1);
            if (isAnd) {
              const r = opm === 3 ? (D[rx] & 0xffff) * s : Math.imul(s16(D[rx]), s16(s));
              D[rx] = r | 0; logic(2, D[rx]); cyc += 50; return;
            }
            if (s === 0) { exception(5, pc); return; }
            if (opm === 3) {
              const n = D[rx] >>> 0, q = Math.floor(n / s), r = n % s;
              if (q > 0xffff) { fV = 1; fN = 1; fC = 0; } else { D[rx] = (r << 16 | q) | 0; logic(1, q); }
              cyc += 120;
            } else {
              const n = D[rx], dv = s16(s), q = Math.trunc(n / dv), r = n - q * dv;
              if (q > 32767 || q < -32768) { fV = 1; fN = 1; fC = 0; } else { D[rx] = ((r & 0xffff) << 16 | (q & 0xffff)) | 0; logic(1, q); }
              cyc += 140;
            }
            return;
          }
          if ((op & 0x1f0) === 0x100) {   // SBCD / ABCD
            let s, d;
            if (mode === 1) { s = rd8(eaAddr(4, reg, 0)); const a = eaAddr(4, rx, 0); d = rd8(a); wr8(a, bcd(!isAnd, s, d)); }
            else { s = D[reg] & 0xff; d = D[rx] & 0xff; setD(rx, 0, bcd(!isAnd, s, d)); cyc += 2; }
            return;
          }
          if (isAnd && (op & 0x130) === 0x100 && (opm === 5 || opm === 6)) {   // EXG
            const m5 = op >> 3 & 0x1f;
            if (m5 === 0x08) { const t = D[rx]; D[rx] = D[reg]; D[reg] = t; }
            else if (m5 === 0x09) { const t = A[rx]; A[rx] = A[reg]; A[reg] = t; }
            else if (m5 === 0x11) { const t = D[rx]; D[rx] = A[reg]; A[reg] = t; }
            else return illegal(op, at);
            cyc += 2; return;
          }
          const sz = opm & 3;
          if (opm & 4) { const d = rmwRead(mode, reg, sz); rmwWrite(sz, logic(sz, isAnd ? d & D[rx] : d | D[rx])); }
          else { const s = readEa(mode, reg, sz); setD(rx, sz, logic(sz, isAnd ? (D[rx] & s) : (D[rx] | s))); if (sz === 2) cyc += 2; }
          return;
        }
        case 0x9: case 0xD: {   // SUB / ADD
          const isAdd = (op >> 12) === 0xD, opm = op >> 6 & 7;
          if (opm === 3 || opm === 7) {   // ADDA / SUBA
            const sz = opm === 3 ? 1 : 2, s = sext(sz, readEa(mode, reg, sz));
            A[rx] = (isAdd ? A[rx] + s : A[rx] - s) | 0; cyc += sz === 2 ? 2 : 4; return;
          }
          const sz = opm & 3;
          if ((opm & 4) && mode < 2) {   // ADDX / SUBX
            const z = fZ;
            if (mode === 1) { const s = rd(sz, eaAddr(4, reg, sz)), a = eaAddr(4, rx, sz), d = rd(sz, a); wr(sz, a, isAdd ? add(sz, s, d, fX) : sub(sz, s, d, fX, true)); }
            else { const r = isAdd ? add(sz, D[reg], D[rx], fX) : sub(sz, D[reg], D[rx], fX, true); setD(rx, sz, r); if (sz === 2) cyc += 4; }
            if (!fZ) { /* 結果が 0 でない: Z を落とす(add/sub が済ませた) */ } else fZ = z;
            return;
          }
          if (opm & 4) { const d = rmwRead(mode, reg, sz); rmwWrite(sz, isAdd ? add(sz, D[rx], d, 0) : sub(sz, D[rx], d, 0, true)); }
          else { const s = readEa(mode, reg, sz); setD(rx, sz, isAdd ? add(sz, s, D[rx], 0) : sub(sz, s, D[rx], 0, true)); if (sz === 2) cyc += 2; }
          return;
        }
        case 0xB: {   // CMP / CMPA / EOR / CMPM
          const opm = op >> 6 & 7;
          if (opm === 3 || opm === 7) { const sz = opm === 3 ? 1 : 2, s = sext(sz, readEa(mode, reg, sz)); sub(2, s, A[rx], 0, false); cyc += 2; return; }
          const sz = opm & 3;
          if (!(opm & 4)) { const s = readEa(mode, reg, sz); sub(sz, s, D[rx], 0, false); if (sz === 2) cyc += 2; return; }
          if (mode === 1) { const s = rd(sz, eaAddr(3, reg, sz)), d = rd(sz, eaAddr(3, rx, sz)); sub(sz, s, d, 0, false); return; }
          { const d = rmwRead(mode, reg, sz); rmwWrite(sz, logic(sz, d ^ D[rx])); if (mode === 0 && sz === 2) cyc += 4; }
          return;
        }
        case 0xE: {
          const sz = op >> 6 & 3, left = op >> 8 & 1;
          if (sz === 3) {   // メモリを 1 ビット
            const kind = op >> 9 & 3, a = eaAddr(mode, reg, 1);
            wr16(a, shift(kind, left, 1, rd16(a), 1)); return;
          }
          const kind = op >> 3 & 3, n = op & 0x20 ? D[rx] & 63 : (rx || 8);
          setD(reg, sz, shift(kind, left, sz, D[reg], n));
          cyc += 2 + 2 * n + (sz === 2 ? 2 : 0);
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
        cyc += kind ? 4 : 2; return;
      }
      const b = 1 << (bitNo & 7);
      if (kind === 0) { fZ = (readEa(mode, reg, 0) & b) ? 0 : 1; return; }
      const a = eaAddr(mode, reg, 0), v = rd8(a);
      fZ = (v & b) ? 0 : 1;
      wr8(a, kind === 1 ? v ^ b : kind === 2 ? v & ~b : v | b);
    }

    function group4(op, at, mode, reg, rx) {
      if (op & 0x100) {
        if ((op & 0x1c0) === 0x1c0) { A[rx] = eaAddr(mode, reg, 2) | 0; if (mode === 6 || (mode === 7 && reg === 3)) cyc += 2; return; }   // LEA
        if ((op & 0x1c0) === 0x180) {   // CHK
          const b = s16(readEa(mode, reg, 1)), v = s16(D[rx]);
          if (v < 0) { fN = 1; exception(6, pc); } else if (v > b) { fN = 0; exception(6, pc); }
          cyc += 6; return;
        }
        return illegal(op, at);
      }
      const sz = op >> 6 & 3;
      switch (op >> 8 & 15) {
        case 0x0:
          if (sz === 3) { writeEa(mode, reg, 1, getSr()); cyc += 2; return; }   // MOVE SR, ea
          { const d = rmwRead(mode, reg, sz), z = fZ, r = sub(sz, d, 0, fX, true); if (r === 0) fZ = z; rmwWrite(sz, r); }   // NEGX
          return;
        case 0x2: if (sz === 3) return illegal(op, at); rmwRead(mode, reg, sz); fN = 0; fZ = 1; fV = 0; fC = 0; rmwWrite(sz, 0); return;   // CLR
        case 0x4:
          if (sz === 3) { setCcr(readEa(mode, reg, 1)); cyc += 8; return; }     // MOVE ea, CCR
          { const d = rmwRead(mode, reg, sz); rmwWrite(sz, sub(sz, d, 0, 0, true)); }   // NEG
          return;
        case 0x6:
          if (sz === 3) { if (!fS) return exception(8, at); setSr(readEa(mode, reg, 1)); cyc += 8; return; }   // MOVE ea, SR
          { const d = rmwRead(mode, reg, sz); rmwWrite(sz, logic(sz, ~d & MASK[sz])); }   // NOT
          return;
        case 0x8:
          if (sz === 0) { const d = rmwRead(mode, reg, 0), z = fZ; fZ = 1; const r = bcd(true, d, 0); if (r === 0) fZ = z; rmwWrite(0, r); cyc += 2; return; }   // NBCD
          if (sz === 1) {
            if (mode === 0) { D[reg] = (D[reg] << 16) | (D[reg] >>> 16); logic(2, D[reg]); return; }   // SWAP
            const a = eaAddr(mode, reg, 2); A[7] = (A[7] - 4) | 0; wr32(A[7], a); if (mode === 6 || (mode === 7 && reg === 3)) cyc += 2; return;   // PEA
          }
          if (mode === 0) { if (sz === 2) { setD(reg, 1, s8(D[reg])); logic(1, D[reg]); } else { D[reg] = s16(D[reg]); logic(2, D[reg]); } return; }   // EXT
          return movem(op);
        case 0xA:
          if (sz === 3) {
            if (mode === 7 && reg === 4) return illegal(op, at);
            if (mode === 0) { logic(0, D[reg]); D[reg] |= 0x80; cyc += 2; return; }   // TAS
            const a = eaAddr(mode, reg, 0), v = rd8(a); logic(0, v); wr8(a, v | 0x80); cyc += 2; return;
          }
          logic(sz, readEa(mode, reg, sz)); return;   // TST
        case 0xC: return movem(op);
        case 0xE:
          if (sz === 1) {
            if (mode < 2) { exception(32 + (op & 15), pc); return; }   // TRAP
            if (mode === 2) { A[7] = (A[7] - 4) | 0; wr32(A[7], A[reg]); A[reg] = A[7]; A[7] = (A[7] + s16(fetch16())) | 0; return; }   // LINK
            if (mode === 3) { A[7] = A[reg]; A[reg] = rd32(A[7]) | 0; A[7] = (A[7] + 4) | 0; return; }   // UNLK
            if (mode === 4) { if (!fS) return exception(8, at); otherSp = A[reg]; return; }   // MOVE An, USP
            if (mode === 5) { if (!fS) return exception(8, at); A[reg] = otherSp; return; }   // MOVE USP, An
            switch (op & 0x3f) {
              case 0x30: if (!fS) return exception(8, at); cyc += 128; return;   // RESET
              case 0x31: return;   // NOP
              case 0x32: if (!fS) return exception(8, at); setSr(fetch16()); stopped = true; return;   // STOP
              case 0x33: { if (!fS) return exception(8, at); const sr = rd16(A[7]); A[7] = (A[7] + 2) | 0; const p = rd32(A[7]); A[7] = (A[7] + 4) | 0; setSr(sr); pc = p; cyc += 4; return; }   // RTE
              case 0x35: pc = rd32(A[7]); A[7] = (A[7] + 4) | 0; cyc += 4; return;   // RTS
              case 0x36: if (fV) exception(7, pc); return;   // TRAPV
              case 0x37: { setCcr(rd16(A[7])); A[7] = (A[7] + 2) | 0; pc = rd32(A[7]); A[7] = (A[7] + 4) | 0; cyc += 4; return; }   // RTR
              default: return illegal(op, at);
            }
          }
          if (sz === 2) { const a = eaAddr(mode, reg, 2); A[7] = (A[7] - 4) | 0; wr32(A[7], pc); pc = a; cyc += 4; return; }   // JSR
          if (sz === 3) { pc = eaAddr(mode, reg, 2); cyc += 4; return; }   // JMP
          return illegal(op, at);
        default: return illegal(op, at);
      }
    }

    function reset() {
      D.fill(0); A.fill(0); otherSp = 0;
      fT = 0; fS = 1; fI = 7; setCcr(0); stopped = false; irq = 0;
      A[7] = rd32(0) | 0; pc = rd32(4);
    }
    function run(until) {
      while (cyc < until) {
        if (irq && checkIrq()) continue;
        if (stopped) { cyc = until; break; }
        step();
      }
    }
    function getState() { return { D: D.slice(), A: A.slice(), n: [pc, cyc, irq, stopped ? 1 : 0, otherSp, getSr()] }; }
    function setState(s) { D.set(s.D); A.set(s.A); let st, sr; [pc, cyc, irq, st, otherSp, sr] = s.n; stopped = !!st; fS = sr >> 13 & 1; fT = sr >> 15 & 1; fI = sr >> 8 & 7; setCcr(sr); }
    return { reset, run, step, setIrq(level) { irq = level & 7; }, getState, setState,
      get pc() { return pc; }, get cycles() { return cyc; }, set cycles(v) { cyc = v; }, get sr() { return getSr(); }, get d() { return D; }, get a() { return A; },
      get illegalCount() { return illegalCount; }, get stopped() { return stopped; } };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
