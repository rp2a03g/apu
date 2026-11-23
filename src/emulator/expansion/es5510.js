/*
 * MML.Emu.createEs5510() — Ensoniq ES5510(ESP)。エフェクト用の DSP(残響、コーラスなど)。
 * MAME の src/devices/cpu/es5510/es5510.cpp(Christian Brunschen、BSD-3-Clause)の写し。
 *
 * 1 サンプルごとに最大 160 命令のプログラムを 1 周する。1 命令は 48bit で、ALU(24bit)と乗算累算(24×24 → 48bit)と、
 * 遅延メモリ(16bit × 1M 語)の読み書きを 1 つずつ持つ。命令はパイプラインになっていて、読んだオペランドは次の命令の時に演算される。
 * 入出力は 16bit のシリアル 4 組(ser0〜ser3 の左右)。タイトーの基板では ser0〜2 に ES5505 の出力 3 組が入り、ser3 から最終の左右が出る。
 *
 * 口:
 *   hostW(レジスタ, 値) / hostR(レジスタ)  サウンド CPU から(プログラムと係数の読み書き、遅延メモリの読み書き)
 *   run(in[6]) → 出力は out[0](左)と out[1](右)。入出力は 16bit の整数
 *   halted  基板の ESPHALT(true の間は走らせない。ホストからの読み書きはできる)
 *   getState / setState
 * MAME と同じく、I/O 空間の読み書き(RAM 制御の 6・7)は中身なし。MAME のソースの TODO にあるとおり、実機との差は確かめられていない。
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const FN = 0x80, FC = 0x40, FV = 0x20, FLT = 0x10, FZ = 0x08, FNOT = 0x04, FMASK = FN | FC | FV | FLT | FZ;
  const DRAM_SIZE = 1 << 20, DRAM_MASK = DRAM_SIZE - 1, P24 = 16777216, P47 = 140737488355328, P48 = 281474976710656;
  // オペランドの選び方: [ALU の元, ALU の先, 乗算の元, 乗算の先](1 = レジスタ、2 = 遅延メモリ、3 = 両方)
  const OPSEL = [[1, 1, 1, 1], [1, 1, 1, 2], [1, 1, 1, 3], [1, 1, 2, 1], [1, 1, 2, 3], [1, 2, 1, 1], [1, 2, 2, 1], [1, 3, 1, 1],
    [1, 3, 2, 1], [2, 1, 1, 1], [2, 1, 1, 2], [2, 1, 1, 3], [2, 1, 2, 1], [2, 1, 2, 3], [2, 3, 1, 1], [2, 3, 2, 1]];
  // RAM 制御: [サイクル(0 読む / 1 書く / 2 読んで FIFO を進める), 種類(0 遅延 / 1 表 A / 2 表 B / 3 I/O)]
  const RAMCTL = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [2, 0], [0, 3], [1, 3]];
  const ALU_OPERANDS = [2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0];
  const s24 = (v) => v << 8 >> 8;
  const mod24 = (x) => ((x % P24) + P24) % P24;

  Emu.createEs5510 = function () {
    const gpr = new Int32Array(0xc0), instrLo = new Uint32Array(160), instrHi = new Uint16Array(160);
    // 命令をばらした控え(命令が書かれた時に作る): RAM のサイクルと種類、オペランドの選び方 4 つ、スキップ可、累算、ALU の命令とレジスタ、乗算のレジスタ
    const dCyc = new Uint8Array(160), dAcc = new Uint8Array(160), dS0 = new Uint8Array(160).fill(1), dS1 = new Uint8Array(160).fill(1), dS2 = new Uint8Array(160).fill(1), dS3 = new Uint8Array(160).fill(1);
    const dSkip = new Uint8Array(160), dMacAcc = new Uint8Array(160), dOp = new Uint8Array(160), dA = new Uint8Array(160), dB = new Uint8Array(160), dC = new Uint8Array(160), dD = new Uint8Array(160);
    function decode(i) {
      const lo = instrLo[i], hi = instrHi[i], rc = RAMCTL[lo >> 3 & 7], sel = OPSEL[lo >> 8 & 15];
      dCyc[i] = rc[0]; dAcc[i] = rc[1]; dS0[i] = sel[0]; dS1[i] = sel[1]; dS2[i] = sel[2]; dS3[i] = sel[3];
      dSkip[i] = lo >> 7 & 1; dMacAcc[i] = lo >> 6 & 1; dOp[i] = lo >> 12 & 15; dA[i] = lo >> 16 & 0xff; dB[i] = lo >>> 24; dC[i] = hi & 0xff; dD[i] = hi >> 8 & 0xff;
    }
    const dram = new Int16Array(DRAM_SIZE);
    const ser = new Int16Array(8);            // 0 ser0l 1 ser0r 2 ser1l 3 ser1r 4 ser2l 5 ser2r 6 ser3l 7 ser3r
    const out = new Int16Array(2);
    let pc = 0, running = true, haltLine = false, halted = true, dramHi = 0;   // running: リセット直後は「走っている」(MAME の device_reset と同じ)。halted は基板の ESPHALT(既定は掛かっている)
    let machl = 0, macOverflow = false, dil = 0, memsiz = 0xffffff, memmask = 0, memincrement = 0x1000000, memshift = 24;
    let dlength = 0, abase = 0, bbase = 0, dbase = 0, sigreg = 0, mulshift = 2, ccr = 0, cmr = 0, dol0 = 0, dol1 = 0, dolCount = 0;
    let dolLatch = 0, dilLatch = 0, dadrLatch = 0, gprLatch = 0, latchLo = 0, latchHi = 0, ramSel = 0, hostControl = 0x04, hostSerial = 0, flags = 0;
    // 実行中の命令
    let aluA = 0, aluB = 0, aluOp = 0, aluDst = 1, aluAV = 0, aluBV = 0, aluWrite = false, aluCcr = false;
    let macC = 0, macDst = 1, macAcc = false, macCV = 0, macDV = 0, macWrite = false;
    let ramAddr = 0, ramIo = false, ramCycle = 0, ramPAddr = 0, ramPIo = false, ramPCycle = 0, ramPPAddr = 0, ramPPIo = false, ramPPCycle = 0;

    function readReg(r) {
      if (r < 0xc0) return gpr[r];
      switch (r) {
        case 234: return ser[1] << 8; case 235: return ser[0] << 8; case 236: return ser[3] << 8; case 237: return ser[2] << 8;
        case 238: return ser[5] << 8; case 239: return ser[4] << 8; case 240: return ser[7] << 8; case 241: return ser[6] << 8;
        case 242: return macOverflow ? (machl < 0 ? 0 : 0xffffff) : mod24(machl);
        case 243: return macOverflow ? (machl < 0 ? 0x800000 : 0x7fffff) : mod24(Math.floor(machl / P24));
        case 244: return dil << 8;
        case 245: return dlength; case 246: return abase; case 247: return bbase; case 248: return dbase; case 249: return sigreg;
        case 250: return ccr << 16; case 251: return cmr << 16;
        case 252: return 0xffffff; case 253: return 0x800000; case 254: return 0x7fffff;
        default: return 0;
      }
    }
    const to16 = (v) => (v >> 8) << 16 >> 16;
    function writeReg(r, value) {
      value &= 0xffffff;
      if (r < 0xc0) { gpr[r] = value; return; }
      switch (r) {
        case 234: ser[1] = to16(value); break; case 235: ser[0] = to16(value); break; case 236: ser[3] = to16(value); break; case 237: ser[2] = to16(value); break;
        case 238: ser[5] = to16(value); break; case 239: ser[4] = to16(value); break; case 240: ser[7] = to16(value); break; case 241: ser[6] = to16(value); break;
        case 242: { let v = mod24(Math.floor(machl / P24)) * P24 + value; if (v >= P47) v -= P48; machl = v; break; }
        case 243: { let v = value * P24 + mod24(machl); if (v >= P47) v -= P48; machl = v; macOverflow = false; break; }
        case 244: { let n = 0, x = value; while (x & 1) { n++; x >>= 1; } memshift = n; memsiz = n >= 24 ? 0xffffff : 0xffffff >> (24 - n); memmask = 0xffffff & ~memsiz; memincrement = n >= 31 ? 0 : 1 << n; dbase &= memmask; break; }
        case 245: dlength = value; break; case 246: abase = value; break; case 247: bbase = value; break; case 248: dbase = value; break;
        case 249: sigreg = value; mulshift = (sigreg >> 22 & 1) ? 1 : 2; break;
        case 250: ccr = (value >> 16) & FMASK; break;
        case 251: cmr = (value >> 16) & (FMASK | FNOT); break;
        default: break;
      }
    }
    function writeToDol(value) {
      const d = (value >> 8) << 16 >> 16;       // 下位 8bit を捨てる(-∞ 方向)
      if (dolCount >= 2) { dol0 = dol1; dol1 = d; } else if (dolCount++ === 0) dol0 = d; else dol1 = d;
    }
    const setTo = (f, on) => { flags = on ? flags | f : flags & ~f; };
    function add(a, b) {
      const aS = a & 0x800000, bS = b & 0x800000, r = (a + b) | 0, rS = r & 0x800000;
      const ov = aS === bS && aS !== rS, neg = rS !== 0;
      setTo(FC, r & 0x1000000); setTo(FN, neg); setTo(FZ, (r & 0xffffff) === 0); setTo(FV, ov); setTo(FLT, (ov && !neg) || (!ov && neg));
      return r & 0xffffff;
    }
    function saturate(v, negative) { if (flags & FV) { setTo(FN, negative); flags &= ~FZ; return negative ? 0x800000 : 0x7fffff; } return v; }
    const negate = (v) => ((v ^ 0xffffff) + 1) & 0xffffff;
    function asl(value, shift) {
      const src = value & 0xffffff, carry = src >> (24 - shift) & 1, shifted = s24(src) * (1 << shift);
      const ov = shifted > 0x7fffff || shifted < -0x800000, r = ov ? (shifted < 0 ? 0x800000 : 0x7fffff) : shifted & 0xffffff;
      setTo(FC, carry); setTo(FV, ov); setTo(FN, r & 0x800000); setTo(FZ, (r & 0xffffff) === 0);
      return r;
    }
    function alu(op, a, b) {
      switch (op) {
        case 0x0: return saturate(add(a, b), (a & 0x800000) !== 0);
        case 0x1: return saturate(add(a, negate(b)), (a & 0x800000) !== 0);
        case 0x2: return add(a, b);
        case 0x3: return add(a, negate(b));
        case 0x4: add(a, negate(b)); return a;
        case 0x5: a &= b; setTo(FN, a & 0x800000); setTo(FZ, a === 0); return a;
        case 0x6: a |= b; setTo(FN, a & 0x800000); setTo(FZ, a === 0); return a;
        case 0x7: a ^= b; setTo(FN, a & 0x800000); setTo(FZ, a === 0); return a;
        case 0x8: { flags &= ~FN; const neg = (b & 0x800000) !== 0; setTo(FC, neg); const r = neg ? (0xffffff ^ b) : b; setTo(FZ, (r & 0xffffff) === 0); return r; }   // 1 の補数で絶対値
        case 0x9: return b;
        case 0xa: return asl(b, 2);
        case 0xb: return asl(b, 8);
        case 0xc: flags &= ~FN; setTo(FC, b & 0x800000); return (b << 15) & 0x7fffff;
        case 0xd: return add(0x7fffff, negate(b));
        case 0xe: setTo(FN, b & 0x800000); setTo(FC, b & 1); return (b >> 1) | (b & 0x800000);
        default: return 0;
      }
    }
    // 1 命令ぶん(MAME の execute_run の 1 回)
    function step() {
      if (!running) {
        if (haltLine) hostControl &= ~0x04; else { running = true; hostControl |= 0x04; pc = 0; }
        return;
      }
      ramPPAddr = ramPAddr; ramPPIo = ramPIo; ramPPCycle = ramPCycle;
      ramPAddr = ramAddr; ramPIo = ramIo; ramPCycle = ramCycle;
      const i = pc < 160 ? pc : pc % 160;
      if (ramPPCycle !== 1) dil = ramPPIo ? 0 : dram[ramPPAddr & DRAM_MASK];
      const acc = dAcc[i], offset = gpr[i];
      ramCycle = dCyc[i]; ramIo = acc === 3;
      if (acc === 0) { const m = dlength + memincrement; ramAddr = m ? (((dbase + offset) % m) & memmask) >>> memshift : 0; }
      else if (acc === 1) ramAddr = ((abase + offset) & memmask) >>> memshift;
      else if (acc === 2) ramAddr = ((bbase + offset) & memmask) >>> memshift;
      else ramAddr = offset & 0xfffff0;
      const skippable = dSkip[i] !== 0;
      let skip = false;
      if (skippable) { skip = (ccr & cmr & FMASK) !== 0; if (cmr & FNOT) skip = !skip; }
      // 乗算累算: 前の命令で読んだオペランドを掛ける
      if (macWrite) {
        const product = s24(macCV) * s24(macDV) * (1 << mulshift), result = macAcc ? product + machl : product;
        macOverflow = result < -P47 || result >= P47;
        machl = result;
        const tmp = macOverflow ? (machl < 0 ? 0x800000 : 0x7fffff) : mod24(Math.floor(result / P24));
        if (macDst & 1) { if (macC < 0xc0) gpr[macC] = tmp; else writeReg(macC, tmp); }
        if (macDst & 2) writeToDol(tmp);
      }
      macC = dC[i]; const macD = dD[i];
      macDst = dS3[i]; macAcc = dMacAcc[i] !== 0; macWrite = !skip;
      macCV = dS2[i] === 1 ? (macC < 0xc0 ? gpr[macC] : readReg(macC)) : dil << 8;
      macDV = macD < 0xc0 ? gpr[macD] : readReg(macD);
      // ALU
      if (aluWrite) {
        flags = ccr;
        const r = alu(aluOp, aluAV, aluBV);
        if (aluOp !== 4) { if (aluDst & 1) { if (aluA < 0xc0) gpr[aluA] = r & 0xffffff; else writeReg(aluA, r); } if (aluDst & 2) writeToDol(r); }
        if (aluCcr) ccr = flags;
      }
      aluA = dA[i]; aluB = dB[i]; aluOp = dOp[i]; aluDst = dS1[i];
      aluWrite = !skip || aluOp === 4; aluCcr = !skippable || aluOp === 4;
      if (aluOp === 0xf) {
        // END: HALT 線を見て止まる。遅延メモリの基点を 1 つ戻す
        if (haltLine) { running = false; hostControl &= ~0x04; }
        dbase = (dbase - memincrement) | 0; if (dbase < 0) dbase = dlength;
        if (running) pc = 0;
      } else if (ALU_OPERANDS[aluOp] === 1) aluBV = dS0[i] === 1 ? (aluB < 0xc0 ? gpr[aluB] : readReg(aluB)) : dil << 8;
      else { aluAV = dS0[i] === 1 ? (aluA < 0xc0 ? gpr[aluA] : readReg(aluA)) : dil << 8; aluBV = aluB < 0xc0 ? gpr[aluB] : readReg(aluB); }
      if (ramPCycle !== 0) {
        if (ramPCycle === 1 && !ramPIo) { const a = ramPAddr & DRAM_MASK; dram[a] = dol0; if (a > dramHi) dramHi = a; }
        dol0 = dol1; if (dolCount > 0) dolCount--;
      }
      pc = (pc + 1) & 0xff;
    }
    // 1 サンプル(MAME の run_once): HALT を離して 1 命令、HALT を掛けて END まで
    function run(inp) {
      if (halted) return;
      ser[0] = inp[0]; ser[1] = inp[1]; ser[2] = inp[2]; ser[3] = inp[3]; ser[4] = inp[4]; ser[5] = inp[5];
      haltLine = false; step();
      haltLine = true;
      let guard = 400;                       // END の無いプログラム(書きかけ)で回り続けないように
      while (running && guard-- > 0) step();
      out[0] = ser[6]; out[1] = ser[7];
    }
    function hostR(off) {
      switch (off) {
        case 0x00: return gprLatch >> 16 & 0xff; case 0x01: return gprLatch >> 8 & 0xff; case 0x02: return gprLatch & 0xff;
        case 0x03: return latchHi >> 8 & 0xff; case 0x04: return latchHi & 0xff;
        case 0x05: return latchLo >>> 24; case 0x06: return latchLo >> 16 & 0xff; case 0x07: return latchLo >> 8 & 0xff; case 0x08: return latchLo & 0xff;
        case 0x09: return dilLatch >> 16 & 0xff; case 0x0a: return dilLatch >> 8 & 0xff; case 0x0b: return 0;
        case 0x0c: return dolLatch >> 16 & 0xff; case 0x0d: return dolLatch >> 8 & 0xff; case 0x0e: return 0xff;
        case 0x0f: return dadrLatch >> 16 & 0xff; case 0x10: return dadrLatch >> 8 & 0xff; case 0x11: return dadrLatch & 0xff;
        case 0x16: return 0x27;
        default: return 0;
      }
    }
    function hostW(off, d) {
      d &= 0xff;
      switch (off) {
        case 0x00: gprLatch = (gprLatch & 0x00ffff) | d << 16; break;
        case 0x01: gprLatch = (gprLatch & 0xff00ff) | d << 8; break;
        case 0x02: gprLatch = (gprLatch & 0xffff00) | d; break;
        case 0x03: latchHi = (latchHi & 0x00ff) | d << 8; break;
        case 0x04: latchHi = (latchHi & 0xff00) | d; break;
        case 0x05: latchLo = ((latchLo & 0x00ffffff) | d << 24) >>> 0; break;
        case 0x06: latchLo = ((latchLo & 0xff00ffff) | d << 16) >>> 0; break;
        case 0x07: latchLo = ((latchLo & 0xffff00ff) | d << 8) >>> 0; break;
        case 0x08: latchLo = ((latchLo & 0xffffff00) | d) >>> 0; break;
        case 0x0c: dolLatch = (dolLatch & 0x00ffff) | d << 16; break;
        case 0x0d: dolLatch = (dolLatch & 0xff00ff) | d << 8; break;
        case 0x0e: dolLatch = (dolLatch & 0xffff00) | d; break;
        case 0x0f:
          dadrLatch = (dadrLatch & 0x00ffff) | d << 16;
          if (ramSel) dilLatch = dram[dadrLatch & DRAM_MASK] << 8;
          else { const a = dadrLatch & DRAM_MASK; dram[a] = (dolLatch >> 8) << 16 >> 16; if (a > dramHi) dramHi = a; }
          break;
        case 0x10: dadrLatch = (dadrLatch & 0xff00ff) | d << 8; break;
        case 0x11: dadrLatch = (dadrLatch & 0xffff00) | d; break;
        case 0x12:
          hostControl = (hostControl & 0x4) | (d & 0x3);
          if (hostControl & 2) { if (!running) { dram.fill(0, 0, dramHi + 1); dramHi = 0; } hostControl &= ~0x2; }   // RAM の消去(止まっている時だけ)
          break;
        case 0x14: ramSel = d & 0x80; break;
        case 0x18: hostSerial = d; break;
        case 0x1f: if (haltLine) running = false; break;
        case 0x80: if (d < 0xa0) { latchLo = instrLo[d]; latchHi = instrHi[d]; } if (d < 0xc0) gprLatch = gpr[d] & 0xffffff; else if (d >= 0xea) gprLatch = readReg(d); break;
        case 0xa0: writeReg(d, gprLatch); break;
        case 0xc0: if (d < 0xa0) { instrLo[d] = latchLo; instrHi[d] = latchHi; decode(d); } break;
        case 0xe0: if (d < 0xa0) { instrLo[d] = latchLo; instrHi[d] = latchHi; decode(d); } writeReg(d, gprLatch); break;
        default: break;
      }
    }
    // 状態(シークの控え)。遅延メモリは書かれた所まで
    function getState() {
      return { gpr: gpr.slice(), instrLo: instrLo.slice(), instrHi: instrHi.slice(), dram: dram.slice(0, dramHi + 1), ser: ser.slice(), out: out.slice(),
        n: [pc, running ? 1 : 0, haltLine ? 1 : 0, halted ? 1 : 0, machl, macOverflow ? 1 : 0, dil, memsiz, memmask, memincrement, memshift, dlength, abase, bbase, dbase, sigreg, mulshift, ccr, cmr, dol0, dol1, dolCount,
          dolLatch, dilLatch, dadrLatch, gprLatch, latchLo, latchHi, ramSel, hostControl, hostSerial,
          aluA, aluB, aluOp, aluDst, aluAV, aluBV, aluWrite ? 1 : 0, aluCcr ? 1 : 0, macC, macDst, macAcc ? 1 : 0, macCV, macDV, macWrite ? 1 : 0,
          ramAddr, ramIo ? 1 : 0, ramCycle, ramPAddr, ramPIo ? 1 : 0, ramPCycle, ramPPAddr, ramPPIo ? 1 : 0, ramPPCycle] };
    }
    function setState(s) {
      gpr.set(s.gpr); instrLo.set(s.instrLo); instrHi.set(s.instrHi); for (let i = 0; i < 160; i++) decode(i); dram.fill(0, 0, Math.max(dramHi, s.dram.length) + 1); dram.set(s.dram); dramHi = Math.max(0, s.dram.length - 1); ser.set(s.ser); out.set(s.out);
      let r, hl, h, mo, aw, ac, ma, mw, ri, rpi, rppi;
      [pc, r, hl, h, machl, mo, dil, memsiz, memmask, memincrement, memshift, dlength, abase, bbase, dbase, sigreg, mulshift, ccr, cmr, dol0, dol1, dolCount,
        dolLatch, dilLatch, dadrLatch, gprLatch, latchLo, latchHi, ramSel, hostControl, hostSerial,
        aluA, aluB, aluOp, aluDst, aluAV, aluBV, aw, ac, macC, macDst, ma, macCV, macDV, mw,
        ramAddr, ri, ramCycle, ramPAddr, rpi, ramPCycle, ramPPAddr, rppi, ramPPCycle] = s.n;
      running = !!r; haltLine = !!hl; halted = !!h; macOverflow = !!mo; aluWrite = !!aw; aluCcr = !!ac; macAcc = !!ma; macWrite = !!mw; ramIo = !!ri; ramPIo = !!rpi; ramPPIo = !!rppi;
    }
    return { hostR, hostW, run, out, getState, setState, readReg, writeReg,
      get halted() { return halted; }, set halted(v) { halted = !!v; },
      get programLength() { let n = 0; for (let i = 0; i < 160; i++) if ((instrLo[i] >> 12 & 15) === 0xf) { n = i + 1; break; } return n; } };
  };
})(typeof window !== 'undefined' ? window : globalThis);
