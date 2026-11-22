/*
 * MML.Emu.createMn10200(bus)
 *
 * パナソニック MN10200(MN1020012A)。タイトーの ZOOM 音源基板(ZSG-2+TMS57002)のサウンド CPU。
 * MAME の src/devices/cpu/mn10200/mn10200.cpp(Olivier Galibert / R. Belmont / hap、BSD-3-Clause)の写し。
 * 命令の動き・フラグ・サイクル数・内蔵の 8bit タイマ・割り込みの受け付けは MAME のとおり。DMA・シリアル・16bit タイマは MAME と同じく中身なし。
 *
 * bus: { rom: Uint8Array(0x080000 番地から), read8(a), read16(a), write8(a, v), write16(a, v), portWrite(番号, 値), portRead(番号) }
 *   0xFC00〜0xFFFF(内蔵の周辺)はここで処理し、bus へは回さない。16bit の読み書きは偶数番地へ切り捨ててから渡す。
 * 時間の単位は「サイクル」= クロックの 2 分周(12.5MHz なら毎秒 625 万)。run(until) は通しのサイクル数 until まで進める。
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const ZF = 1, NF = 2, CF = 4, VF = 8, ZX = 0x10, NX = 0x20, CX = 0x40, VX = 0x80, IE = 0x800;
  const NEVER = Infinity, ROM_BASE = 0x80000;

  Emu.createMn10200 = function (bus) {
    const rom = bus.rom, romEnd = ROM_BASE + rom.length;
    const D = new Int32Array(4), A = new Int32Array(4);   // どれも 24bit に切って持つ
    let pc = 0, psw = 0, mdr = 0, cyc = 0, possibleIrq = false, illegalCount = 0;
    let nmicr = 0, iagr = 0, extmdl = 0, extmdh = 0, p4 = 0xf, pplul = 0, ppluh = 0, p3md = 0;
    const icrl = new Uint8Array(31), icrh = new Uint8Array(31);
    const tMode = new Uint8Array(10), tBase = new Uint8Array(10), tCur = new Uint8Array(10), tAt = new Float64Array(10).fill(NEVER);
    const pMode = new Uint8Array(2), pBase = new Uint8Array(2), pCur = new Uint8Array(2);
    const portOut = new Uint8Array(4), portDir = new Uint8Array(4);
    const serCtrlL = new Uint8Array(2), serCtrlH = new Uint8Array(2), serRecv = new Uint8Array(2), dmaIrq = new Uint8Array(8);
    let nextTimer = NEVER;

    // ---- 内蔵の 8bit タイマ ----
    function timerNext() { let m = NEVER; for (let i = 0; i < 10; i++) if (tAt[i] < m) m = tAt[i]; nextTimer = m; }
    function refreshTimer(t, now) {
      const p = tMode[t] & 1;
      tAt[t] = ((tMode[t] & 0x82) === 0x82 && (pMode[p] & 0x80)) ? now + (pBase[p] + 1) * (tCur[t] + 1) : NEVER;
    }
    function tickSimple(t) {
      const next = t + 1;
      if (next < 10 && (tMode[next] & 0x83) === 0x81) {           // 次のタイマがカスケードで動いている
        tCur[next] = (tCur[next] - 1) & 0xff;
        if (tCur[next] === 0xff) { if (tickSimple(next) !== 2) { tCur[next] = tBase[next]; return 1; } }
        return 2;
      }
      icrl[1 + (t >> 2)] |= 1 << (4 + (t & 3)); possibleIrq = true;
      return 0;
    }
    function fireTimers() {
      for (let t = 0; t < 10; t++) {
        while (tAt[t] <= cyc) {
          const at = tAt[t];
          tCur[t] = tickSimple(t) === 2 ? 0xff : tBase[t];
          refreshTimer(t, at);
        }
      }
      timerNext();
    }

    // ---- 割り込み ----
    function takeIrq(level, group) {
      cyc += 7;
      wr24(A[3] - 4, pc); wr16(A[3] - 6, psw);
      A[3] = (A[3] - 6) & 0xffffff; pc = 0x80008;
      psw = (psw & 0xf0ff) | (level << 8); iagr = group;
    }
    function checkIrq() {
      if (!nmicr && !(psw & IE)) return;
      let level = psw >> 8 & 7, group = 0;
      for (let i = 1; i < 11; i++) {
        if ((icrl[i] >> 4 & icrh[i] & 0xf) && (icrh[i] >> 4 & 7) < level) { level = icrh[i] >> 4 & 7; group = i; }
      }
      if (nmicr && group) takeIrq(level, 0); else if (nmicr) takeIrq(0, 0); else if (group) takeIrq(level, group);
    }
    function checkExtIrq() {
      for (let i = 0; i < 4; i++) if ((p4 >> i & 1) === (extmdl >> (i * 2) & 3)) icrl[8] |= 1 << (4 + i);
      possibleIrq = true;
    }
    // 外からの割り込み線(0〜3)。state は MAME の set_input_line と同じ向き(1 = ASSERT = 端子は L)
    function setInput(n, state) {
      const pin = state ? 0 : 1, old = p4 >> n & 1;
      let active = false;
      switch (extmdl >> (n * 2) & 3) {
        case 0: active = pin === 0; break;
        case 1: active = pin === 1; break;
        case 2: active = pin === 0 && old === 1; break;
        case 3: active = pin === 1 && old === 0; break;
      }
      p4 = (p4 & ~(1 << n)) | (pin << n);
      if (active) { icrl[8] |= 1 << (4 + n); possibleIrq = true; }
    }

    // ---- 内蔵の周辺(0xFC00〜)----
    function ioW(o, v) {
      if (o >= 0x42 && o <= 0x55) {
        const g = (o & 0x3f) >> 1;
        if (o & 1) { icrh[g] = v; possibleIrq = true; } else { icrl[g] &= v; if (o === 0x50) checkExtIrq(); }
        return;
      }
      if (o >= 0x210 && o <= 0x219) { tBase[o & 0xf] = v; return; }
      if (o === 0x21a || o === 0x21b) { pBase[o & 1] = v; return; }
      if (o >= 0x220 && o <= 0x229) {
        const t = o & 0xf; tMode[t] = v & 0xc3; if (v & 0x40) tCur[t] = tBase[t];
        refreshTimer(t, cyc); timerNext(); return;
      }
      if (o === 0x22a || o === 0x22b) {
        pMode[o & 1] = v & 0xc0; if (v & 0x40) pCur[o & 1] = pBase[o & 1];
        for (let t = 0; t < 10; t++) refreshTimer(t, cyc);
        timerNext(); return;
      }
      switch (o) {
        case 0x040: nmicr &= v; break;
        case 0x056: extmdl = v; checkExtIrq(); break;
        case 0x057: extmdh = v & 3; break;
        case 0x180: case 0x190: serCtrlL[(o - 0x180) >> 4] = v; break;
        case 0x181: case 0x191: serCtrlH[(o - 0x180) >> 4] = v; break;
        case 0x28c: case 0x29c: case 0x2ac: case 0x2bc: case 0x2cc: case 0x2dc: case 0x2ec: case 0x2fc: dmaIrq[(o - 0x280) >> 4] = v & 7; break;
        case 0x3b0: pplul = v & 0x7f; break;
        case 0x3b1: ppluh = v & 0x3f; break;
        case 0x3c0: portOut[0] = v; bus.portWrite(0, portOut[0] | (portDir[0] ^ 0xff)); break;
        case 0x264: portOut[1] = v; bus.portWrite(1, portOut[1] | (portDir[1] ^ 0xff)); break;
        case 0x3c2: portOut[2] = v & 0x0f; bus.portWrite(2, portOut[2] | (portDir[2] ^ 0x0f)); break;
        case 0x3c3: portOut[3] = v & 0x1f; bus.portWrite(3, portOut[3] | (portDir[3] ^ 0x1f)); break;
        case 0x3e0: portDir[0] = v; break;
        case 0x3e1: portDir[1] = v; break;
        case 0x3e2: portDir[2] = v & 0x0f; break;
        case 0x3e3: portDir[3] = v & 0x1f; break;
        case 0x3f3: p3md = v & 0x7f; break;
        default: break;
      }
    }
    function ioR(o) {
      if (o >= 0x42 && o <= 0x55) {
        const g = (o & 0x3f) >> 1;
        return (o & 1) ? icrh[g] : (icrl[g] & 0xf0) | (icrl[g] >> 4 & icrh[g]);
      }
      if (o >= 0x200 && o <= 0x209) return tCur[o & 0xf];
      if (o === 0x20a || o === 0x20b) return pCur[o & 1];
      if (o >= 0x210 && o <= 0x219) return tBase[o & 0xf];
      if (o === 0x21a || o === 0x21b) return pBase[o & 1];
      if (o >= 0x220 && o <= 0x229) return tMode[o & 0xf];
      if (o === 0x22a || o === 0x22b) return pMode[o & 1];
      switch (o) {
        case 0x00e: return (iagr << 1) & 0xff;
        case 0x040: return nmicr;
        case 0x056: return extmdl;
        case 0x057: return (extmdh | (p4 << 4)) & 0xff;
        case 0x180: case 0x190: return serCtrlL[(o - 0x180) >> 4];
        case 0x181: case 0x191: return serCtrlH[(o - 0x180) >> 4];
        case 0x182: { const r = serRecv[0]; serRecv[0] = (r + 1) & 0xff; return r; }
        case 0x183: return 0x10;
        case 0x28c: case 0x29c: case 0x2ac: case 0x2bc: case 0x2cc: case 0x2dc: case 0x2ec: case 0x2fc: return dmaIrq[(o - 0x280) >> 4];
        case 0x3b0: return pplul;
        case 0x3b1: return ppluh;
        case 0x3c0: return portOut[0];
        case 0x264: return portOut[1];
        case 0x3c2: return portOut[2];
        case 0x3c3: return portOut[3];
        case 0x3d0: return (bus.portRead(0) | portDir[0]) & 0xff;
        case 0x3d1: return (bus.portRead(1) | portDir[1]) & 0xff;
        case 0x3d2: return (bus.portRead(2) & 0x0f) | portDir[2];
        case 0x3d3: return (bus.portRead(3) & 0x1f) | portDir[3];
        case 0x3e0: return portDir[0];
        case 0x3e1: return portDir[1];
        case 0x3e2: return portDir[2];
        case 0x3e3: return portDir[3];
        case 0x3f3: return p3md;
        default: return 0;
      }
    }

    // ---- メモリ ----
    const isIo = (a) => a >= 0xfc00 && a < 0x10000;
    function rd8(a) { a &= 0xffffff; if (a >= ROM_BASE && a < romEnd) return rom[a - ROM_BASE]; return isIo(a) ? ioR(a - 0xfc00) : bus.read8(a); }
    function rd16(a) {
      a &= 0xfffffe;
      if (a >= ROM_BASE && a < romEnd) return rom[a - ROM_BASE] | rom[a + 1 - ROM_BASE] << 8;
      return isIo(a) ? ioR(a - 0xfc00) | ioR(a - 0xfbff) << 8 : bus.read16(a);
    }
    function rd24(a) { a &= 0xfffffe; return rd16(a) | rd8(a + 2) << 16; }
    function wr8(a, v) { a &= 0xffffff; if (isIo(a)) ioW(a - 0xfc00, v & 0xff); else bus.write8(a, v & 0xff); }
    function wr16(a, v) { a &= 0xfffffe; if (isIo(a)) { ioW(a - 0xfc00, v & 0xff); ioW(a - 0xfbff, v >> 8 & 0xff); } else bus.write16(a, v & 0xffff); }
    function wr24(a, v) { a &= 0xfffffe; wr16(a, v); wr8(a + 2, v >> 16); }
    // 命令のオペランド(プログラムは ROM の中)
    function arg8(a) { a &= 0xffffff; return (a >= ROM_BASE && a < romEnd) ? rom[a - ROM_BASE] : rd8(a); }
    function arg16(a) { return arg8(a) | arg8(a + 1) << 8; }
    function arg24(a) { return arg8(a) | arg8(a + 1) << 8 | arg8(a + 2) << 16; }
    const s8 = (v) => v << 24 >> 24, s16 = (v) => v << 16 >> 16, M = 0xffffff;

    // ---- 演算 ----
    function doAdd(a, b, c) {
      a &= M; b &= M;
      const r = a + b + c;
      psw &= 0xff00;
      if ((a ^ r) & (b ^ r) & 0x800000) psw |= VX;
      if (r & 0x1000000) psw |= CX;
      if (r & 0x800000) psw |= NX;
      if (!(r & M)) psw |= ZX;
      if ((a ^ r) & (b ^ r) & 0x8000) psw |= VF;
      if (((a & 0xffff) + (b & 0xffff) + c) & 0x10000) psw |= CF;
      if (r & 0x8000) psw |= NF;
      if (!(r & 0xffff)) psw |= ZF;
      return r & M;
    }
    function doSub(a, b, c) {
      a &= M; b &= M;
      const r = (a - b - c) | 0;
      psw &= 0xff00;
      if ((a ^ b) & (a ^ r) & 0x800000) psw |= VX;
      if (r & 0x1000000) psw |= CX;
      if (r & 0x800000) psw |= NX;
      if (!(r & M)) psw |= ZX;
      if ((a ^ b) & (a ^ r) & 0x8000) psw |= VF;
      if (((a & 0xffff) - (b & 0xffff) - c) & 0x10000) psw |= CF;
      if (r & 0x8000) psw |= NF;
      if (!(r & 0xffff)) psw |= ZF;
      return r & M;
    }
    function nz16(v) { psw &= 0xfff0; if (v & 0x8000) psw |= NF; if (!(v & 0xffff)) psw |= ZF; }
    function jsr(to, ret) { A[3] = (A[3] - 4) & M; wr24(A[3], ret & M); pc = to & M; }
    function branch(cond) { if (cond) { cyc += 1; pc = (pc + s8(arg8(pc))) & M; } }
    function illegal() { illegalCount++; nmicr |= 2; possibleIrq = true; }
    const lt = (n, v) => { const f = psw & (n | v); return f === n || f === v; };          // (V^N)=1
    const ge = (n, v) => { const f = psw & (n | v); return f === 0 || f === (n | v); };    // (V^N)=0

    function step() {
      while (possibleIrq) { possibleIrq = false; checkIrq(); }
      cyc += 1;
      let op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3;
      switch (op >> 4) {
        case 0x0: wr16(A[n], D[m]); return;                                        // mov dm, (an)
        case 0x1: wr8(A[n], D[m]); return;                                         // movb dm, (an)
        case 0x2: D[m] = s16(rd16(A[n])) & M; return;                              // mov (an), dm
        case 0x3: D[m] = rd8(A[n]); return;                                        // movbu (an), dm
        case 0x4: wr16(A[n] + s8(arg8(pc)), D[m]); pc++; return;                   // mov dm, (d8, an)
        case 0x5: cyc += 1; wr24(A[n] + s8(arg8(pc)), A[m]); pc++; return;         // mov am, (d8, an)
        case 0x6: D[m] = s16(rd16(A[n] + s8(arg8(pc)))) & M; pc++; return;         // mov (d8, an), dm
        case 0x7: cyc += 1; A[m] = rd24(A[n] + s8(arg8(pc))); pc++; return;        // mov (d8, an), am
        case 0x8: if (m === n) { D[m] = s8(arg8(pc)) & M; pc++; } else D[m] = D[n]; return;   // mov imm8, dn / mov dn, dm
        case 0x9: D[m] = doAdd(D[m], D[n], 0); return;                             // add dn, dm
        case 0xa: D[m] = doSub(D[m], D[n], 0); return;                             // sub dn, dm
        case 0xb:
          if (n === 0) D[m] = s16(D[m]) & M; else if (n === 1) D[m] &= 0xffff; else if (n === 2) D[m] = s8(D[m]) & M; else D[m] &= 0xff;
          return;
        case 0xc: {
          const a = arg16(pc); pc += 2;
          if (n === 0) wr16(a, D[m]); else if (n === 1) wr8(a, D[m]); else if (n === 2) D[m] = s16(rd16(a)) & M; else D[m] = rd8(a);
          return;
        }
        case 0xd:
          if (n === 3) { A[m] = arg16(pc); pc += 2; return; }                      // mov imm16, an
          { const i = s8(arg8(pc)); pc++;
            if (n === 0) A[m] = doAdd(A[m], i, 0); else if (n === 1) D[m] = doAdd(D[m], i, 0); else doSub(D[m], i, 0); }
          return;
        case 0xe:
          if (n === 3) { doSub(A[m], arg16(pc), 0); pc += 2; return; }             // cmp imm16, an
          switch (op) {
            case 0xe0: branch(lt(NF, VF)); break;
            case 0xe1: branch(!(psw & ZF) && ge(NF, VF)); break;
            case 0xe2: branch(ge(NF, VF)); break;
            case 0xe3: branch((psw & ZF) || lt(NF, VF)); break;
            case 0xe4: branch(psw & CF); break;
            case 0xe5: branch(!(psw & (ZF | CF))); break;
            case 0xe6: branch(!(psw & CF)); break;
            case 0xe7: branch(psw & (ZF | CF)); break;
            case 0xe8: branch(psw & ZF); break;
            case 0xe9: branch(!(psw & ZF)); break;
            case 0xea: branch(1); break;
            default:   // 0xeb rti
              cyc += 5; psw = rd16(A[3]); pc = rd24(A[3] + 2) & M; A[3] = (A[3] + 6) & M; possibleIrq = true; return;
          }
          pc = (pc + 1) & M; return;
        default: break;
      }
      // 0xf0〜0xff
      switch (op) {
        case 0xf6: return;                                                                      // nop
        case 0xf8: case 0xf9: case 0xfa: case 0xfb: D[m] = s16(arg16(pc)) & M; pc += 2; return;  // mov imm16, dn
        case 0xfc: cyc += 1; pc = (pc + 2 + s16(arg16(pc))) & M; return;                        // jmp label16
        case 0xfd: cyc += 3; jsr(pc + 2 + s16(arg16(pc)), pc + 2); return;                      // jsr label16
        case 0xfe: cyc += 4; pc = rd24(A[3]) & M; A[3] = (A[3] + 4) & M; return;                // rts
        case 0xf0: return opF0();
        case 0xf1: return opF1();
        case 0xf2: return opF2();
        case 0xf3: return opF3();
        case 0xf4: return opF4();
        case 0xf5: return opF5();
        case 0xf7: return opF7();
        default: illegal(); return;
      }
    }

    function opF0() {
      cyc += 1; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3, i = op >> 4 & 3;
      if (op >= 0xc0) { wr8(A[n] + D[i], D[m]); return; }                          // movb dm, (di, an)
      if (op >= 0x80) { D[m] = rd8(A[n] + D[i]); return; }                         // movbu (di, an), dm
      if (op >= 0x40) { D[m] = s8(rd8(A[n] + D[i])) & M; return; }                 // movb (di, an), dm
      if (op >= 0x30) { cyc += 3; const v = rd8(A[n]); nz16(v & D[m]); wr8(A[n], v & ~D[m]); return; }   // bclr
      if (op >= 0x20) { cyc += 3; const v = rd8(A[n]); nz16(v & D[m]); wr8(A[n], v | D[m]); return; }    // bset
      if (op < 0x10 && m === 0) { cyc += 1; pc = A[n] & M; return; }               // jmp (an)
      if (op < 0x10 && m === 1) { cyc += 3; jsr(A[n], pc); return; }               // jsr (an)
      illegal();
    }
    function opF1() {
      cyc += 1; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3, a = A[n] + D[op >> 4 & 3];
      switch (op & 0xc0) {
        case 0x00: cyc += 1; A[m] = rd24(a); return;
        case 0x40: D[m] = s16(rd16(a)) & M; return;
        case 0x80: cyc += 1; wr24(a, A[m]); return;
        default: wr16(a, D[m]); return;
      }
    }
    function opF2() {
      cyc += 1; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3;
      switch (op & 0xf0) {
        case 0x00: A[m] = doAdd(A[m], D[n], 0); return;
        case 0x10: A[m] = doSub(A[m], D[n], 0); return;
        case 0x20: doSub(A[m], D[n], 0); return;
        case 0x30: A[m] = D[n]; return;
        case 0x40: A[m] = doAdd(A[m], A[n], 0); return;
        case 0x50: A[m] = doSub(A[m], A[n], 0); return;
        case 0x60: doSub(A[m], A[n], 0); return;
        case 0x70: A[m] = A[n]; return;
        case 0x80: { const keep = ~ZF | (psw & ZF); D[m] = doAdd(D[m], D[n], (psw & CF) ? 1 : 0); psw &= keep & 0xffff; return; }
        case 0x90: { const keep = ~ZF | (psw & ZF); D[m] = doSub(D[m], D[n], (psw & CF) ? 1 : 0); psw &= keep & 0xffff; return; }
        case 0xc0: D[m] = doAdd(D[m], A[n], 0); return;
        case 0xd0: D[m] = doSub(D[m], A[n], 0); return;
        case 0xe0: doSub(D[m], A[n], 0); return;
        case 0xf0: D[m] = A[n]; return;
        default: illegal(); return;
      }
    }
    function opF3() {
      cyc += 1; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3;
      switch (op >> 4) {
        case 0x0: D[m] &= 0xff0000 | D[n]; nz16(D[m]); return;
        case 0x1: D[m] |= 0xffff & D[n]; nz16(D[m]); return;
        case 0x2: D[m] ^= 0xffff & D[n]; nz16(D[m]); return;
        case 0x3: {
          const d = D[m];
          if (n === 0) { D[m] = (d & 0xff0000) | ((d << 1) & 0xfffe) | ((psw & CF) ? 1 : 0); nz16(D[m]); if (d & 0x8000) psw |= CF; }
          else {
            if (n === 1) D[m] = (d & 0xff0000) | ((d >> 1) & 0x7fff) | ((psw & CF) ? 0x8000 : 0);
            else if (n === 2) D[m] = (d & 0xff8000) | ((d >> 1) & 0x7fff);
            else D[m] = (d & 0xff0000) | ((d >> 1) & 0x7fff);
            nz16(D[m]); if (d & 1) psw |= CF;
          }
          return;
        }
        case 0x4: {
          cyc += 10; const res = Math.imul(s16(D[m]), s16(D[n]));
          D[m] = res & M; psw &= 0xff00; if (res < 0) psw |= NF; else if (res === 0) psw |= ZF; mdr = res >>> 16; return;
        }
        case 0x5: {
          cyc += 10; const res = (D[m] & 0xffff) * (D[n] & 0xffff);     // 2^32 未満
          D[m] = res % 0x1000000; psw &= 0xff00; if (res >= 0x80000000) psw |= NF; else if (res === 0) psw |= ZF; mdr = Math.floor(res / 65536); return;
        }
        case 0x6: {
          cyc += 11; psw &= 0xff00;
          const num = mdr * 65536 + (D[m] & 0xffff), d = D[n] & 0xffff;
          if (d === 0) { psw |= VF; return; }
          const q = Math.floor(num / d);
          if (q >= 0x10000) { psw |= VF; return; }
          D[m] = q; mdr = num % d;
          if (q === 0) psw |= ZF | ZX;
          if (q & 0x8000) psw |= NF;
          return;
        }
        case 0x9: doSub(D[m], D[n], 0); return;
        case 0xc: if (m === 0) { mdr = D[n] & 0xffff; return; } if (m === 1) { cyc += 1; mdr = (D[n] & 0x8000) ? 0xffff : 0; return; } break;
        case 0xd: if (m === 0) { cyc += 1; psw = D[n] & 0xffff; possibleIrq = true; return; } break;
        case 0xe: if (n === 0) { D[m] = mdr; return; } if (n === 1) { D[m] ^= 0xffff; nz16(D[m]); return; } break;
        case 0xf: if (n === 0) { D[m] = psw; return; } break;
        default: break;
      }
      illegal();
    }
    function opF4() {
      cyc += 2; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3, i = arg24(pc);
      switch (op >> 4) {
        case 0x0: wr16(i + A[n], D[m]); break;
        case 0x1: cyc += 1; wr24(i + A[n], A[m]); break;
        case 0x2: wr8(i + A[n], D[m]); break;
        case 0x3: cyc += 1; wr24(i + A[n], D[m]); break;
        case 0x4: if (n === 0) wr16(i, D[m]); else if (n === 1) wr8(i, D[m]); else illegal(); break;
        case 0x5: if (n === 0) { cyc += 1; wr24(i, A[m]); } else illegal(); break;
        case 0x6: if (n === 0) D[m] = doAdd(D[m], i, 0); else if (n === 1) A[m] = doAdd(A[m], i, 0); else if (n === 2) D[m] = doSub(D[m], i, 0); else A[m] = doSub(A[m], i, 0); break;
        case 0x7: if (n === 0) D[m] = i; else if (n === 1) A[m] = i; else if (n === 2) doSub(D[m], i, 0); else doSub(A[m], i, 0); break;
        case 0x8: D[m] = s16(rd16(A[n] + i)) & M; break;
        case 0x9: D[m] = rd8(A[n] + i); break;
        case 0xa: D[m] = s8(rd8(A[n] + i)) & M; break;
        case 0xb: cyc += 1; D[m] = rd24(A[n] + i); break;
        case 0xc: if (n === 0) D[m] = s16(rd16(i)) & M; else if (n === 1) D[m] = s8(rd8(i)) & M; else if (n === 2) D[m] = rd8(i); else illegal(); break;
        case 0xd: if (n === 0) { cyc += 1; A[m] = rd24(i); } else illegal(); break;
        case 0xe:
          if (op === 0xe0) { cyc += 1; pc = (pc + i) & M; }
          else if (op === 0xe1) { cyc += 2; jsr(pc + i, pc + 3); }
          else illegal();
          break;
        default: cyc += 1; A[m] = rd24(A[n] + i); break;     // 0xf: mov (d24, an), am
      }
      pc = (pc + 3) & M;
    }
    function opF5() {
      cyc += 1; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3;
      switch (op >> 4) {
        case 0x0:
          if (n === 0) { D[m] &= 0xff0000 | arg8(pc); nz16(D[m]); }
          else if (n === 1) nz16(D[m] & arg8(pc));
          else if (n === 2) { D[m] |= arg8(pc); nz16(D[m]); }
          else A[m] = (A[m] + s8(arg8(pc))) & M;
          break;
        case 0x1: wr8(A[n] + s8(arg8(pc)), D[m]); break;
        case 0x2: D[m] = s8(rd8(A[n] + s8(arg8(pc)))) & M; break;
        case 0x3: D[m] = rd8(A[n] + s8(arg8(pc))); break;
        case 0x5: cyc += 1; wr24(A[n] + s8(arg8(pc)), D[m]); break;
        case 0x7: cyc += 1; D[m] = rd24(A[n] + s8(arg8(pc))); break;
        case 0xe:
          switch (op) {
            case 0xe0: branch(lt(NX, VX)); break;
            case 0xe1: branch(!(psw & ZX) && ge(NX, VX)); break;
            case 0xe2: branch(ge(NX, VX)); break;
            case 0xe3: branch((psw & ZX) || lt(NX, VX)); break;
            case 0xe4: branch(psw & CX); break;
            case 0xe5: branch(!(psw & (ZX | CX))); break;
            case 0xe6: branch(!(psw & CX)); break;
            case 0xe7: branch(psw & (ZX | CX)); break;
            case 0xe8: branch(psw & ZX); break;
            case 0xe9: branch(!(psw & ZX)); break;
            case 0xec: branch(!(psw & VX)); break;
            case 0xed: branch(psw & VX); break;
            case 0xee: branch(!(psw & NX)); break;
            case 0xef: branch(psw & NX); break;
            default: illegal(); break;
          }
          break;
        case 0xf:
          if (op === 0xfc) branch(!(psw & VF)); else if (op === 0xfd) branch(psw & VF);
          else if (op === 0xfe) branch(!(psw & NF)); else if (op === 0xff) branch(psw & NF);
          else illegal();
          break;
        default: illegal(); break;
      }
      pc = (pc + 1) & M;
    }
    function opF7() {
      cyc += 1; const op = arg8(pc); pc = (pc + 1) & M;
      const m = op & 3, n = op >> 2 & 3, u = arg16(pc), s = s16(u);
      switch (op >> 4) {
        case 0x0:
          if (n === 0) { D[m] &= 0xff0000 | u; nz16(D[m]); }
          else if (n === 1) nz16(D[m] & u);
          else if (n === 2) A[m] = doAdd(A[m], s, 0);
          else A[m] = doSub(A[m], s, 0);
          break;
        case 0x1:
          if (op === 0x10) { cyc += 1; psw &= u; }
          else if (op === 0x14) { cyc += 1; psw |= u; possibleIrq = true; }
          else if (n === 2) D[m] = doAdd(D[m], s, 0);
          else if (n === 3) D[m] = doSub(D[m], s, 0);
          else illegal();
          break;
        case 0x2: if (n === 0) { cyc += 1; wr24(u, A[m]); } else illegal(); break;
        case 0x3: if (n === 0) { cyc += 1; A[m] = rd24(u); } else illegal(); break;
        case 0x4:
          if (n === 0) { D[m] |= u; nz16(D[m]); }
          else if (n === 2) doSub(D[m], s, 0);
          else if (n === 3) { D[m] ^= u; nz16(D[m]); }
          else illegal();
          break;
        case 0x5: D[m] = rd8(A[n] + s); break;
        case 0x6: cyc += 1; wr24(A[n] + s, D[m]); break;
        case 0x7: cyc += 1; D[m] = rd24(A[n] + s); break;
        case 0x8: wr16(A[n] + s, D[m]); break;
        case 0x9: wr8(A[n] + s, D[m]); break;
        case 0xa: cyc += 1; wr24(A[n] + s, A[m]); break;
        case 0xb: cyc += 1; A[m] = rd24(A[n] + s); break;
        case 0xc: D[m] = s16(rd16(A[n] + s)) & M; break;
        case 0xd: D[m] = s8(rd8(A[n] + s)) & M; break;
        default: illegal(); break;
      }
      pc = (pc + 2) & M;
    }

    function reset() {
      pc = 0x80000; psw = 0; mdr = 0; D.fill(0); A.fill(0); nmicr = 0; iagr = 0;
      wr16(0xfc00, 0x8000); wr16(0xfc02, 0x0737);
      for (let i = 0; i < 2; i++) for (let a = 0xfc04; a < 0x10000; a++) wr16(a, 0);
      possibleIrq = false; timerNext();
    }
    function run(until) {
      while (cyc < until) {
        if (cyc >= nextTimer) fireTimers();
        step();
      }
    }
    function getState() {
      return { D: D.slice(), A: A.slice(), icrl: icrl.slice(), icrh: icrh.slice(), tMode: tMode.slice(), tBase: tBase.slice(), tCur: tCur.slice(), tAt: tAt.slice(),
        pMode: pMode.slice(), pBase: pBase.slice(), pCur: pCur.slice(), portOut: portOut.slice(), portDir: portDir.slice(),
        serCtrlL: serCtrlL.slice(), serCtrlH: serCtrlH.slice(), serRecv: serRecv.slice(), dmaIrq: dmaIrq.slice(),
        n: [pc, psw, mdr, cyc, possibleIrq ? 1 : 0, nmicr, iagr, extmdl, extmdh, p4, pplul, ppluh, p3md] };
    }
    function setState(s) {
      D.set(s.D); A.set(s.A); icrl.set(s.icrl); icrh.set(s.icrh); tMode.set(s.tMode); tBase.set(s.tBase); tCur.set(s.tCur); tAt.set(s.tAt);
      pMode.set(s.pMode); pBase.set(s.pBase); pCur.set(s.pCur); portOut.set(s.portOut); portDir.set(s.portDir);
      serCtrlL.set(s.serCtrlL); serCtrlH.set(s.serCtrlH); serRecv.set(s.serRecv); dmaIrq.set(s.dmaIrq);
      let pi; [pc, psw, mdr, cyc, pi, nmicr, iagr, extmdl, extmdh, p4, pplul, ppluh, p3md] = s.n; possibleIrq = !!pi; timerNext();
    }
    return { reset, run, step, setInput, getState, setState,
      get pc() { return pc; }, get psw() { return psw; }, get cycles() { return cyc; }, get illegalCount() { return illegalCount; },
      get d() { return D; }, get a() { return A; } };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
