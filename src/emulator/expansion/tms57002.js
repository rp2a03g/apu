/*
 * TI TMS57002 "DASP"(エフェクト用 DSP)
 * MML.Emu.createTms57002()
 *
 * 動作は MAME src/devices/cpu/tms57002(tms57002.cpp / tmsinstr.lst / tms57kdec.cpp、BSD-3-Clause、THIRD-PARTY-NOTICES.md)の写し。
 * タイトーの ZOOM 音源基板(ZSG-2 の後段。リバーブとコーラスを作り、直の左右もここを通る)で使う。
 *
 *   - MAME は命令を先に解読してキャッシュする。ここは、まとまりごとに JavaScript の関数へ変換して控える経路(速い)と、
 *     1 命令ずつその場で解読する経路(遅いが単純。変換できない時と照合用)の 2 つを持つ。結果は同じ。
 *   - 52bit の乗算アキュムレータ(MACC)は倍精度の数で持つ(整数として 2^53 まで正確)。64bit での折り返しは再現しない。
 *     検算は tools/zsg2/tms57002.js(BigInt で MAME の式どおりに書いた版)と出力を突き合わせる(tools/zsg2/zsg2-dsp-check.js)。
 *   - MAME が実装していない命令(tmsinstr.lst に中身が無い物)は MAME と同じく何もしない。出てきたら unhandled に数える。
 *   - 1 サンプル = sample() 1 回。その中で、アイドル命令に当たるか 384 命令(12.5MHz ÷ 32552Hz)走るまで進める。
 *   - 速さ(1 サンプル 255 命令のプログラム、実測): 逐次実行は実時間の約 25%、関数へ変換した経路は下の検査の出力を参照。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const IN_PLOAD = 1, IN_CLOAD = 2, SU_CVAL = 4, SU_MASK = 0x18, SU_ST0 = 0, SU_ST1 = 8, SU_PRG = 0x10;
  const S_IDLE = 0x20, S_READ = 0x40, S_WRITE = 0x80, S_BRANCH = 0x100, S_HOST = 0x200, S_UPDATE = 0x400;
  const ST0_INCS = 1, ST0_SIM = 8, ST0_WORD = 0x4000, ST0_SEL = 0x8000, ST0_M = 0x30000;
  const ST1_AOV = 1, ST1_SFAI = 2, ST1_SFAO = 4, ST1_AOVM = 8, ST1_MOVM = 0x20, ST1_MOV = 0x40;
  const ST1_SFMA = 0x180, ST1_SFMO = 0x1800, ST1_RND = 0x38000, ST1_CRM = 0xc0000, ST1_DBP = 0x100000;
  const fl = Math.floor;
  const P16 = 65536, P24 = 16777216, P32 = 4294967296, P43 = 2 ** 43, P45 = 2 ** 45, P47 = 2 ** 47, P51 = 2 ** 51;
  const OVDIV = [P47, P45, P43], OVMASK = [0x1f, 0x7f, 0x1ff], SHMUL = [1, 4, 16];
  const ROUND = [0, 32768, 8388608, 131072, 2147483648], RDIV = [1, 65536, 16777216, 262144, P32];
  const SATNEG = -P47, SATPOS = P47 - 1;
  const CYCLES_PER_SAMPLE = 384;
  const mod = (x, p) => x - fl(x / p) * p;

  Emu.createTms57002 = function () {
    const cmem = new Uint32Array(256), dmem0 = new Uint32Array(256), dmem1 = new Uint32Array(32), prog = new Uint32Array(256);
    const xram = new Uint8Array(0x40000);
    const update = new Uint32Array(16), host = new Uint8Array(4);
    const si = new Uint32Array(4), so = new Uint32Array(4);
    let macc = 0, maccRead = 0, maccWrite = 0;
    let st0 = 0, st1 = 0, sti = S_IDLE, aacc = 0, xoa = 0, xba = 0, xwr = 0, xrd = 0, txrd = 0, creg = 0;
    let pc = 0, ca = 0, id = 0, ba0 = 0, ba1 = 0, rptc = 0, rptcNext = 0, sa = 0, xmAdr = 0, hidx = 0, uHead = 0, uTail = 0;
    const unhandled = new Map();
    let instCount = 0, overrun = 0, xramDirty = false, stepIdx = 0, emptyAt = -1;

    function reset() {
      sti = (sti & ~(SU_MASK | S_READ | S_WRITE | S_BRANCH | S_HOST | S_UPDATE)) | (SU_ST0 | S_IDLE);
      pc = ca = hidx = id = ba0 = ba1 = sa = rptc = rptcNext = uTail = uHead = 0;
      st0 &= ~(0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x40 | 0x80 | 0x100 | 0x600 | 0x800 | 0x1000 | 0x2000);
      st1 &= ~(ST1_AOV | ST1_SFAI | ST1_SFAO | ST1_AOVM | ST1_MOVM | ST1_MOV | ST1_SFMA | ST1_SFMO | ST1_RND | ST1_CRM | ST1_DBP);
      xba = xoa = 0;
    }
    // 制御線。v の bit0 = PLOAD、bit1 = CLOAD(どちらも 0 で有効)。MAME の順番どおり CLOAD → PLOAD
    function ctrl(v) {
      let old = sti;
      if (v & 2) sti &= ~IN_CLOAD; else sti |= IN_CLOAD;
      if ((old ^ sti) && (sti & IN_CLOAD)) hidx = 0;
      old = sti;
      if (v & 1) sti &= ~IN_PLOAD; else sti |= IN_PLOAD;
      if ((old ^ sti) && (sti & IN_PLOAD)) { hidx = 0; pc = 0; ca = 0; sti &= ~SU_MASK; }
    }
    function dataW(data) {
      switch (sti & (IN_PLOAD | IN_CLOAD)) {
        case 0: hidx = 0; sti &= ~SU_CVAL; break;
        case IN_PLOAD:
          host[hidx++] = data;
          if (hidx >= 3) {
            const val = (host[0] << 16) | (host[1] << 8) | host[2];
            hidx = 0;
            switch (sti & SU_MASK) {
              case SU_ST0: st0 = val; sti = (sti & ~SU_MASK) | SU_ST1; blocks.clear(); break;
              case SU_ST1: st1 = val; sti = (sti & ~SU_MASK) | SU_PRG; break;
              case SU_PRG: prog[pc] = val; pc = (pc + 1) & 0xff; blocks.clear(); break;   // プログラムが変わったら、変換して控えた関数は捨てる
            }
          }
          break;
        case IN_CLOAD:
          if (sti & SU_CVAL) {
            host[hidx++] = data;
            if (hidx >= 4) {
              sti &= ~SU_CVAL;
              update[uHead] = ((host[0] << 24) | (host[1] << 16) | (host[2] << 8) | host[3]) >>> 0;
              uHead = (uHead + 1) & 0xf;
              hidx = 1;
            }
          } else { sa = data; hidx = 0; sti |= SU_CVAL; }
          break;
        default:
          host[hidx++] = data;
          if (hidx >= 4) { hidx = 0; cmem[ca] = ((host[0] << 24) | (host[1] << 16) | (host[2] << 8) | host[3]) >>> 0; ca = (ca + 1) & 0xff; }
      }
    }
    function getCmem(addr) {
      if (sa === addr && uHead !== uTail) sti |= S_UPDATE;
      if (sti & S_UPDATE) {
        cmem[addr] = update[uTail]; uTail = (uTail + 1) & 0xf;
        if (uHead === uTail) { sti &= ~S_UPDATE; emptyAt = stepIdx; }
        return cmem[addr];
      }
      const crm = (st1 & ST1_CRM) >> 18, v = cmem[addr];
      return crm === 1 ? (v & 0xffff0000) >>> 0 : crm === 2 ? (v << 16) >>> 0 : v;
    }
    function xmInit() {
      let adr = xoa + xba;
      const m = st0 & ST0_M, mask = m === 0 ? 0xffff : m === 0x10000 ? 0x3ffff : m === 0x20000 ? 0xfffff : 0;
      adr = st0 & ST0_WORD ? adr * 4 : adr * 2;
      if (!(st0 & ST0_SEL)) adr *= 2;
      xmAdr = (adr >>> 0) & mask;
    }
    function xmStepRead() {
      const adr = xmAdr, v = xram[adr & 0x3ffff]; let done, off;
      if (st0 & ST0_WORD) {
        if (st0 & ST0_SEL) { off = 16 - ((adr & 3) << 3); txrd = (txrd & ~(0xff << off)) | (v << off); done = off === 0; }
        else { off = 20 - ((adr & 7) << 2); txrd = (txrd & ~(0xf << off)) | ((v & 0xf) << off); done = off === 0; }
      } else {
        if (st0 & ST0_SEL) { off = 16 - ((adr & 1) << 3); txrd = (txrd & ~(0xff << off)) | (v << off); done = off === 8; }
        else { off = 20 - ((adr & 3) << 2); txrd = (txrd & ~(0xf << off)) | ((v & 0xf) << off); done = off === 8; }
        if (done) txrd &= 0xffff00;
      }
      txrd >>>= 0;
      if (done) { xrd = txrd; sti &= ~S_READ; xmAdr = 0; } else xmAdr = adr + 1;
    }
    function xmStepWrite() {
      const adr = xmAdr; let v, done, off;
      if (st0 & ST0_WORD) {
        if (st0 & ST0_SEL) { off = 16 - ((adr & 3) << 3); v = xwr >>> off; done = off === 0; }
        else { off = 20 - ((adr & 7) << 2); v = (xwr >>> off) & 0xf; done = off === 0; }
      } else {
        if (st0 & ST0_SEL) { off = 16 - ((adr & 1) << 3); v = xwr >>> off; done = off === 8; }
        else { off = 20 - ((adr & 3) << 2); v = (xwr >>> off) & 0xf; done = off === 8; }
      }
      xram[adr & 0x3ffff] = v & 0xff; xramDirty = true;
      if (done) { sti &= ~S_WRITE; xmAdr = 0; } else xmAdr = adr + 1;
    }
    // %mo: MACC(1 命令前の値)を出力用に桁合わせ・丸め・飽和
    function mo() {
      const sfmo = (st1 & ST1_SFMO) >> 11; let rnd = (st1 & ST1_RND) >> 15; if (rnd > 4) rnd = 0;
      let m = maccRead, over = false, t;
      if (sfmo === 3) m = fl(m / 256);
      else { t = fl(m / OVDIV[sfmo]) & OVMASK[sfmo]; over = t !== 0 && t !== OVMASK[sfmo]; m *= SHMUL[sfmo]; }
      if (rnd) { m += ROUND[rnd]; m = fl(m / RDIV[rnd]) * RDIV[rnd]; }
      t = fl(m / P47) & 0x1f; if (t !== 0 && t !== 0x1f) over = true;
      if (over) { st1 |= ST1_MOV; if (st1 & ST1_MOVM) m = fl(m / P51) & 1 ? SATNEG : SATPOS; }
      return m;
    }
    function mv() {
      const sfmo = (st1 & ST1_SFMO) >> 11; let m = maccRead;
      if (sfmo !== 3) { const t = fl(m / OVDIV[sfmo]) & OVMASK[sfmo]; if (t !== 0 && t !== OVMASK[sfmo]) { st1 |= ST1_MOV; if (st1 & ST1_MOVM) m = fl(m / P51) & 1 ? SATNEG : SATPOS; } }
      return m;
    }
    function ml() { const k = (st1 & ST1_SFMA) >> 7; return k === 0 ? macc : k === 1 ? macc * 4 : k === 2 ? macc * 16 : fl(macc / P16); }
    // floor(c × x ÷ div)。c は符号付き 32bit、x は 32bit まで。積が 2^53 を超えるので c を上下 16bit に割って正確に出す(div は 2 のべきで 65536 以下)
    function mulDiv(c, x, div) { return (c >> 16) * x * (P16 / div) + fl((c & 0xffff) * x / div); }
    function wa(r) {
      if (r < -2147483648 || r > 2147483647) { st1 |= ST1_AOV; if (st1 & ST1_AOVM) r = r < 0 ? -2147483648 : 2147483647; }
      aacc = r >= 0 && r < P32 ? r : mod(r, P32);
    }

    let op = 0, param = 0, inc = 0;
    function xmode(c) {
      if (c ? (op & 0x400) : !(op & 0x400)) { if (op & 0x100) return 0; if (op & 0x80) inc |= c ? 1 : 2; return 1; }
      if (op & 0x200) inc |= c ? 1 : 2;
      return 1;
    }
    function cIdx() { return xmode(true) ? ca : param; }
    function C() { return getCmem(cIdx()); }
    let dArr = dmem0, dI = 0;
    function dSel() { const x = xmode(false) ? id : param; if (st1 & ST1_DBP) { dArr = dmem1; dI = (x + ba1) & 0x1f; } else { dArr = dmem0; dI = (x + ba0) & 0xff; } }
    function D() { dSel(); return (dArr[dI] << 8) >>> 0; }
    function D24() { dSel(); return dArr[dI]; }
    function wd(v) { dSel(); dArr[dI] = v; }
    function A() { return st1 & ST1_SFAO ? (aacc << 7) >>> 0 : aacc; }
    function Dsfai() { const d = D(); return st1 & ST1_SFAI ? ((d | 0) >> 1) >>> 0 : d; }
    function sx24(d) { return (d & 0x800000 ? d | 0xff000000 : d) | 0; }
    function miss(cat, n) { const k = cat + ':' + n.toString(16); unhandled.set(k, (unhandled.get(k) || 0) + 1); }
    function branch() { pc = param; sti |= S_BRANCH; }

    function cat1(n) {
      let c, d;
      switch (n) {
        case 0x00: break;
        case 0x01: aacc = A(); if ((aacc | 0) < 0) { aacc = (-aacc) >>> 0; if ((aacc | 0) < 0) st1 |= ST1_AOV; } break;
        case 0x02: wa(-A()); break;
        case 0x03: wa((D() | 0) + (A() | 0)); break;
        case 0x04: wa((C() | 0) + (A() | 0)); break;
        case 0x05: d = Dsfai(); wa((d | 0) + fl(mo() / P16)); break;
        case 0x06: wa((C() | 0) + fl(mo() / P16)); break;
        case 0x07: wa((D() | 0) + (C() | 0)); break;
        case 0x09: wa((D() | 0) - (A() | 0)); break;
        case 0x0a: wa((C() | 0) - (A() | 0)); break;
        case 0x0b: d = Dsfai(); wa((d | 0) - fl(mo() / P16)); break;
        case 0x0c: wa((C() | 0) - fl(mo() / P16)); break;
        case 0x0d: wa((D() | 0) - (C() | 0)); break;
        case 0x11: aacc = Dsfai(); break;
        case 0x12: aacc = C(); break;
        case 0x14: aacc = (aacc & Dsfai()) >>> 0; break;
        case 0x15: aacc = (aacc & C()) >>> 0; break;
        case 0x16: d = Dsfai(); aacc = (C() & d) >>> 0; break;
        case 0x17: aacc = (aacc | Dsfai()) >>> 0; break;
        case 0x18: aacc = (aacc | C()) >>> 0; break;
        case 0x19: d = Dsfai(); aacc = (C() | d) >>> 0; break;
        case 0x21: d = sx24(D24()); creg = c = C(); macc = mulDiv(c | 0, d, 128); break;
        case 0x22: creg = c = C(); macc = mulDiv(c | 0, A() | 0, 32768); break;
        case 0x24: d = sx24(D24()); creg = c = C(); macc = ml() + mulDiv(c | 0, d, 128); break;
        case 0x25: d = sx24(D24()); creg = c = A(); macc = ml() + mulDiv(c | 0, d, 128); break;
        case 0x26: creg = c = C(); macc = ml() + mulDiv(c | 0, A() | 0, 32768); break;
        case 0x28: creg = c = C(); d = D24(); macc = mulDiv(c | 0, d, 128); break;
        case 0x29: d = D24(); creg = c = C(); macc = ml() + mulDiv(c | 0, d, 128); break;
        case 0x2a: d = D24(); creg = c = A(); macc = ml() + mulDiv(c | 0, d, 128); break;
        case 0x2e: creg = c = C(); macc = ml() + mulDiv(c | 0, A() | 0, 16384); break;
        case 0x31: maccWrite = macc = (D() | 0) * P16; break;
        case 0x32: { d = D24(); const lo = mod(macc, P32); maccWrite = macc = (macc - lo) + (((lo & ~0xffffff) | d) >>> 0); break; }
        case 0x33: maccWrite = macc = (C() | 0) * P16; break;
        case 0x34: macc = (fl(macc / P51) & 1) * P51 + mod(macc * 2, P51); break;
        case 0x35: macc = (fl(macc / P51) & 1) * P51 + mod(fl(macc / 2), P51); break;
        // 途中で抜ける命令でも、番地の進み(ca / id の +1)は解読の時点で決まるので先に評価しておく
        case 0x38: xmode(false); xmode(true); if (sti & (S_READ | S_WRITE)) break; xwr = D24(); xoa = C(); xmInit(); sti |= S_WRITE; break;
        case 0x39: xmode(true); if (sti & (S_READ | S_WRITE)) break; xoa = C(); xmInit(); sti |= S_READ; break;
        default: miss('1', n);
      }
    }
    function isPost(n) {
      return n === 0x0c || (n >= 0x1c && n <= 0x1f) || n === 0x3a || n === 0x3c || n === 0x3d || n === 0x40 || n === 0x41 || n === 0x44 || n === 0x45 ||
        (n >= 0x48 && n <= 0x4b) || n === 0x50 || n === 0x51 || n === 0x54 || n === 0x55 || (n >= 0x58 && n <= 0x5b) || (n >= 0x60 && n <= 0x63) || (n >= 0x68 && n <= 0x6f);
    }
    function cat2pre(n) {
      switch (n) {
        case 0x00: break;
        case 0x01: cmem[cIdx()] = A(); break;
        case 0x02: wd(A() >>> 8); break;
        case 0x03: wd(mod(fl(mo() / P24), P24)); break;
        case 0x05: cmem[cIdx()] = mod(fl(mo() / P16), P32); break;
        case 0x06: wd((mod(fl(mv() / P24), P24) & 0xffff00) >>> 0); break;
        case 0x07: wd(mod(fl(mv() / 256), P24)); break;
        case 0x08: ca = A() >>> 24; break;
        case 0x09: id = A() >>> 24; break;
        case 0x0e: break;
        case 0x0f: wd(xrd); break;
        case 0x10: case 0x11: case 0x12: case 0x13: wd(si[n - 0x10]); break;
        case 0x20: case 0x21: case 0x22: case 0x23: so[n - 0x20] = mod(fl(mo() / P24), P24); break;
        case 0x31: { xmode(true); if (sti & S_HOST) break; const c = C(); host[0] = c >>> 24; host[1] = c >>> 16; host[2] = c >>> 8; host[3] = c; hidx = 0; sti |= S_HOST; break; }
        default: if (!isPost(n)) miss('2a', n);
      }
    }
    function cat2post(n) {
      if (n === 0 || !isPost(n)) return;
      if (n === 0x3a) st1 &= ~ST1_MOV;
      else if (n === 0x3c) st1 &= ~ST1_AOVM;
      else if (n === 0x3d) st1 |= ST1_AOVM;
      else if (n === 0x40) st1 &= ~ST1_MOVM;
      else if (n === 0x41) st1 |= ST1_MOVM;
      else if (n === 0x44) st1 &= ~ST1_DBP;
      else if (n === 0x45) st1 |= ST1_DBP;
      else if (n >= 0x48 && n <= 0x4b) st1 = (st1 & ~ST1_CRM) | ((n - 0x48) << 18);
      else if (n === 0x50) st1 &= ~ST1_SFAO;
      else if (n === 0x51) st1 |= ST1_SFAO;
      else if (n === 0x54) st1 &= ~ST1_SFAI;
      else if (n === 0x55) st1 |= ST1_SFAI;
      else if (n >= 0x58 && n <= 0x5b) st1 = (st1 & ~ST1_SFMA) | ((n - 0x58) << 7);
      else if (n >= 0x60 && n <= 0x63) st1 = (st1 & ~ST1_SFMO) | ((n - 0x60) << 11);
      else if (n >= 0x68 && n <= 0x6f) st1 = (st1 & ~ST1_RND) | ((n - 0x68) << 15);
      else miss('2b', n);
    }
    function cat3(n) {
      switch (n) {
        case 0x00: break;
        case 0x08: sti |= S_IDLE; break;
        case 0x10: rptcNext = param; break;
        case 0x18: ca = param; break;
        case 0x20: id = param; break;
        case 0x40: if ((aacc | 0) >= 0) ca = param; break;
        case 0x48: branch(); break;
        case 0x50: if ((aacc | 0) > 0) branch(); break;
        case 0x58: if ((aacc | 0) < 0) branch(); break;
        case 0x60: if (aacc) branch(); break;
        case 0x78: if (st1 & ST1_AOV) { st1 &= ~ST1_AOV; branch(); } break;
        default: miss('3', n);
      }
    }
    function step() {
      if (sti & (S_READ | S_WRITE)) { if (sti & S_READ) xmStepRead(); else xmStepWrite(); }
      maccRead = maccWrite; maccWrite = macc;
      op = prog[pc]; param = op & 0xff; inc = 0;
      if ((op & 0xfc0000) === 0xfc0000) cat3((op >> 11) & 0x7f);
      else { const n2 = (op >> 11) & 0x7f; if (n2) cat2pre(n2); cat1(op >> 18); if (n2) cat2post(n2); }
      if (inc & 1) ca = (ca + 1) & 0xff;
      if (inc & 2) id = (id + 1) & 0xff;
      instCount++;
      if (rptc) rptc--;
      else if (sti & S_BRANCH) sti &= ~S_BRANCH;
      else pc = (pc + 1) & 0xff;
      if (rptcNext) { rptc = rptcNext; rptcNext = 0; }
    }
    // ── まとまりごとに関数へ変換して実行する(速い経路)──────────────────────────────
    // 逐次実行(step)は 1 命令ごとに解読と分岐をするので、1 サンプル 255 命令のプログラムで実時間の約 25% かかる。
    // ここでは「今の pc から、アイドル命令か分岐命令まで」を 1 本の関数に変換して控え、次からはそれを呼ぶ(MAME の解読キャッシュと同じ考え方)。
    //   - 番地の決め方・桁合わせ・丸め・飽和の種類は st1 で決まるので、変換の時点で決め打ちにする。控えの鍵は pc と st1 のその部分
    //   - 状態は S(Float64Array)に写して渡し、戻ったら書き戻す。外付け RAM の読み書き(1 命令ごとに 1 バイト進む)も関数の中に直接書く。
    //     読み書きの形は st0 で決まるので、それも変換の時点で決め打ちにする(st0 が書かれたら控えを捨てる)
    //   - ホストからの係数の更新が待っている間(更新の列が空でない)は、逐次実行に落とす。更新はサンプルの境目でしか届かないので、
    //     サンプルの頭で 1 回見れば足りる。これで関数の中では係数メモリをそのまま読める
    //   - 変換できない物(ホストへの読み出し命令、繰り返し命令の直後が分岐、など)や、残りの命令数に収まらない時は逐次実行に落とす
    //   - new Function が使えない環境(CSP で禁じられている等)では、最初の 1 回で諦めて逐次実行だけにする
    // 結果は逐次実行と同じでないといけない。tools/zsg2/zsg2-dsp-check.js が BigInt の版と 1 サンプルずつ突き合わせる
    const ST1_CACHE = ST1_SFAI | ST1_SFAO | ST1_MOVM | ST1_SFMA | ST1_SFMO | ST1_RND | ST1_CRM | ST1_DBP;
    const S = new Float64Array(24);   // 0 macc 1 maccRead 2 maccWrite 4 st1 5 sti 6 aacc 7 xoa 8 xba 9 xwr 10 xrd 11 txrd 12 creg 13 pc 14 ca 15 id 16 ba0 17 ba1 19 xmAdr 22 外付け RAM に書いた
    const blocks = new Map();
    let jit = true, jitBlocks = 0, jitRuns = 0;
    const H = { miss };
    // 1 命令の頭の文: 外付け RAM の読み書きが進行中なら 1 バイト(または 4bit)進め、MACC を 1 段送る。xmStepRead / xmStepWrite の写し
    function preCode() {
      const word = !!(st0 & ST0_WORD), sel = !!(st0 & ST0_SEL);
      const off = word ? (sel ? '16 - ((xa & 3) << 3)' : '20 - ((xa & 7) << 2)') : (sel ? '16 - ((xa & 1) << 3)' : '20 - ((xa & 3) << 2)');
      const last = word ? 0 : 8, bits = sel ? '0xff' : '0xf';
      const rd = 't = ' + off + '; tx = (tx & ~(' + bits + ' << t)) | ((xram[xa & 0x3ffff] & ' + bits + ') << t); if (t === ' + last + ') { ' + (word ? '' : 'tx &= 0xffff00; ') + 'tx >>>= 0; xrd = tx; sti &= -65; xa = 0; } else { tx >>>= 0; xa++; }';
      const wr = 't = ' + off + '; xram[xa & 0x3ffff] = ' + (sel ? 'xwr >>> t' : '(xwr >>> t) & 0xf') + '; S[22] = 1; if (t === ' + last + ') { sti &= -129; xa = 0; } else xa++;';
      return 'if (sti & 192) { if (sti & 64) { ' + rd + ' } else { ' + wr + ' } } mr = mw; mw = macc;';
    }
    // 外付け RAM の番地の計算(xmInit の写し)。結果は xa
    function xmInitCode() {
      const m = st0 & ST0_M, mask = m === 0 ? 0xffff : m === 0x10000 ? 0x3ffff : m === 0x20000 ? 0xfffff : 0;
      const mul = (st0 & ST0_WORD ? 4 : 2) * (st0 & ST0_SEL ? 1 : 2);
      return 'xa = (((xoa + xba) * ' + mul + ') >>> 0) & ' + mask + ';';
    }
    let PRE = '', XMINIT = '';
    const WA = (expr) => 'r = ' + expr + '; if (r < -2147483648 || r > 2147483647) { st1 |= 1; if (st1 & 8) r = r < 0 ? -2147483648 : 2147483647; } aacc = (r >= 0 && r < 4294967296) ? r : r - Math.floor(r * 2.3283064365386963e-10) * 4294967296;';
    const MUL = (div) => '((ci >> 16) * d * ' + (65536 / div) + ' + Math.floor((ci & 65535) * d * ' + (1 / div) + '))';
    const SX = 'd = (d & 8388608 ? d | 4278190080 : d) | 0;';
    // %mo / %mv に当たる文(結果は m)
    function moCode(st1c, onlyCheck) {
      const sfmo = (st1c & ST1_SFMO) >> 11, movm = !!(st1c & ST1_MOVM); let rnd = (st1c & ST1_RND) >> 15; if (rnd > 4) rnd = 0;
      const sat = movm ? ' m = (Math.floor(m * ' + (1 / P51) + ') & 1) ? ' + SATNEG + ' : ' + SATPOS + ';' : '';
      if (onlyCheck) {
        if (sfmo === 3) return 'm = mr;';
        return 'm = mr; t = Math.floor(m * ' + (1 / OVDIV[sfmo]) + ') & ' + OVMASK[sfmo] + '; if (t !== 0 && t !== ' + OVMASK[sfmo] + ') { st1 |= 64;' + sat + ' }';
      }
      let c = 'm = mr; ';
      if (sfmo === 3) c += 'over = false; m = Math.floor(m * 0.00390625); ';
      else c += 't = Math.floor(m * ' + (1 / OVDIV[sfmo]) + ') & ' + OVMASK[sfmo] + '; over = t !== 0 && t !== ' + OVMASK[sfmo] + ';' + (sfmo ? ' m *= ' + SHMUL[sfmo] + ';' : '') + ' ';
      if (rnd) c += 'm += ' + ROUND[rnd] + '; m = Math.floor(m * ' + (1 / RDIV[rnd]) + ') * ' + RDIV[rnd] + '; ';
      c += 't = Math.floor(m * ' + (1 / P47) + ') & 31; if (t !== 0 && t !== 31) over = true; if (over) { st1 |= 64;' + sat + ' }';
      return c;
    }
    const M24 = 'm = Math.floor(m * 5.960464477539063e-8); m = m - Math.floor(m * 5.960464477539063e-8) * 16777216;';
    // 1 命令(分岐系でない物)を文にする。st 1 つを持ち回る: st.c = 変換の時点の st1(決め打ちに使う部分)。変換できなければ null
    function genInstr(op, st) {
      const param = op & 0xff, n1 = op >>> 18, n2 = (op >> 11) & 0x7f, o = [];
      let inc = 0;
      const xm = (c) => { if (c ? (op & 0x400) : !(op & 0x400)) { if (op & 0x100) return 0; if (op & 0x80) inc |= c ? 1 : 2; return 1; } if (op & 0x200) inc |= c ? 1 : 2; return 1; };
      const cI = () => (xm(true) ? 'ca' : String(param));
      const Cx = () => { const i = cI(), crm = (st.c & ST1_CRM) >> 18;
        const fast = crm === 1 ? '((cmem[' + i + '] & 0xffff0000) >>> 0)' : crm === 2 ? '((cmem[' + i + '] << 16) >>> 0)' : 'cmem[' + i + ']';
        return fast; };
      const dRef = () => { const x = xm(false) ? 'id' : String(param); return (st.c & ST1_DBP) ? 'dmem1[(' + x + ' + ba1) & 31]' : 'dmem0[(' + x + ' + ba0) & 255]'; };
      const Dx = () => '((' + dRef() + ' << 8) >>> 0)';
      const Ax = () => ((st.c & ST1_SFAO) ? '((aacc << 7) >>> 0)' : 'aacc');
      const Dsf = () => ((st.c & ST1_SFAI) ? '(((' + Dx() + ' | 0) >> 1) >>> 0)' : Dx());
      const ML = () => { const k = (st.c & ST1_SFMA) >> 7; return k === 0 ? 'macc' : k === 1 ? 'macc * 4' : k === 2 ? 'macc * 16' : 'Math.floor(macc * 0.0000152587890625)'; };
      const MO = () => moCode(st.c, false), MV = () => moCode(st.c, true);
      // 前段(カテゴリ 2a)
      switch (isPost(n2) ? 0 : n2) {
        case 0x00: break;
        case 0x01: o.push('cmem[' + cI() + '] = ' + Ax() + ';'); break;
        case 0x02: o.push(dRef() + ' = ' + Ax() + ' >>> 8;'); break;
        case 0x03: o.push(MO(), M24, dRef() + ' = m;'); break;
        case 0x05: o.push(MO(), 'cmem[' + cI() + '] = Math.floor(m * 0.0000152587890625);'); break;
        case 0x06: o.push(MV(), M24, dRef() + ' = (m & 0xffff00) >>> 0;'); break;
        case 0x07: o.push(MV(), 'm = Math.floor(m * 0.00390625); m = m - Math.floor(m * 5.960464477539063e-8) * 16777216;', dRef() + ' = m;'); break;
        case 0x08: o.push('ca = ' + Ax() + ' >>> 24;'); break;
        case 0x09: o.push('id = ' + Ax() + ' >>> 24;'); break;
        case 0x0e: break;
        case 0x0f: o.push(dRef() + ' = xrd;'); break;
        case 0x10: case 0x11: case 0x12: case 0x13: o.push(dRef() + ' = si[' + (n2 - 0x10) + '];'); break;
        case 0x20: case 0x21: case 0x22: case 0x23: o.push(MO(), M24, 'so[' + (n2 - 0x20) + '] = m;'); break;
        case 0x31: return null;   // ホストへの読み出し(逐次実行に任せる)
        default: o.push("H.miss('2a', " + n2 + ');');
      }
      // 本体(カテゴリ 1)
      switch (n1) {
        case 0x00: break;
        case 0x01: o.push('aacc = ' + Ax() + '; if ((aacc | 0) < 0) { aacc = (-aacc) >>> 0; if ((aacc | 0) < 0) st1 |= 1; }'); break;
        case 0x02: o.push(WA('-(' + Ax() + ')')); break;
        case 0x03: o.push(WA('(' + Dx() + ' | 0) + (' + Ax() + ' | 0)')); break;
        case 0x04: o.push(WA('(' + Cx() + ' | 0) + (' + Ax() + ' | 0)')); break;
        case 0x05: o.push('d = ' + Dsf() + ';', MO(), WA('(d | 0) + Math.floor(m * 0.0000152587890625)')); break;
        case 0x06: o.push('c = ' + Cx() + ';', MO(), WA('(c | 0) + Math.floor(m * 0.0000152587890625)')); break;
        case 0x07: o.push(WA('(' + Dx() + ' | 0) + (' + Cx() + ' | 0)')); break;
        case 0x09: o.push(WA('(' + Dx() + ' | 0) - (' + Ax() + ' | 0)')); break;
        case 0x0a: o.push(WA('(' + Cx() + ' | 0) - (' + Ax() + ' | 0)')); break;
        case 0x0b: o.push('d = ' + Dsf() + ';', MO(), WA('(d | 0) - Math.floor(m * 0.0000152587890625)')); break;
        case 0x0c: o.push('c = ' + Cx() + ';', MO(), WA('(c | 0) - Math.floor(m * 0.0000152587890625)')); break;
        case 0x0d: o.push(WA('(' + Dx() + ' | 0) - (' + Cx() + ' | 0)')); break;
        case 0x11: o.push('aacc = ' + Dsf() + ';'); break;
        case 0x12: o.push('aacc = ' + Cx() + ';'); break;
        case 0x14: o.push('aacc = (aacc & ' + Dsf() + ') >>> 0;'); break;
        case 0x15: o.push('aacc = (aacc & ' + Cx() + ') >>> 0;'); break;
        case 0x16: o.push('d = ' + Dsf() + '; aacc = (' + Cx() + ' & d) >>> 0;'); break;
        case 0x17: o.push('aacc = (aacc | ' + Dsf() + ') >>> 0;'); break;
        case 0x18: o.push('aacc = (aacc | ' + Cx() + ') >>> 0;'); break;
        case 0x19: o.push('d = ' + Dsf() + '; aacc = (' + Cx() + ' | d) >>> 0;'); break;
        case 0x21: o.push('d = ' + dRef() + ';', SX, 'creg = c = ' + Cx() + '; ci = c | 0; macc = ' + MUL(128) + ';'); break;
        case 0x22: o.push('creg = c = ' + Cx() + '; ci = c | 0; d = ' + Ax() + ' | 0; macc = ' + MUL(32768) + ';'); break;
        case 0x24: o.push('d = ' + dRef() + ';', SX, 'creg = c = ' + Cx() + '; ci = c | 0; macc = ' + ML() + ' + ' + MUL(128) + ';'); break;
        case 0x25: o.push('d = ' + dRef() + ';', SX, 'creg = c = ' + Ax() + '; ci = c | 0; macc = ' + ML() + ' + ' + MUL(128) + ';'); break;
        case 0x26: o.push('creg = c = ' + Cx() + '; ci = c | 0; d = ' + Ax() + ' | 0; macc = ' + ML() + ' + ' + MUL(32768) + ';'); break;
        case 0x28: o.push('creg = c = ' + Cx() + '; ci = c | 0; d = ' + dRef() + '; macc = ' + MUL(128) + ';'); break;
        case 0x29: o.push('d = ' + dRef() + '; creg = c = ' + Cx() + '; ci = c | 0; macc = ' + ML() + ' + ' + MUL(128) + ';'); break;
        case 0x2a: o.push('d = ' + dRef() + '; creg = c = ' + Ax() + '; ci = c | 0; macc = ' + ML() + ' + ' + MUL(128) + ';'); break;
        case 0x2e: o.push('creg = c = ' + Cx() + '; ci = c | 0; d = ' + Ax() + ' | 0; macc = ' + ML() + ' + ' + MUL(16384) + ';'); break;
        case 0x31: o.push('mw = macc = (' + Dx() + ' | 0) * 65536;'); break;
        case 0x32: o.push('d = ' + dRef() + '; t = macc - Math.floor(macc * 2.3283064365386963e-10) * 4294967296; mw = macc = (macc - t) + (((t & ~0xffffff) | d) >>> 0);'); break;
        case 0x33: o.push('mw = macc = (' + Cx() + ' | 0) * 65536;'); break;
        case 0x34: o.push('t = macc * 2; macc = (Math.floor(macc * ' + (1 / P51) + ') & 1) * ' + P51 + ' + (t - Math.floor(t * ' + (1 / P51) + ') * ' + P51 + ');'); break;
        case 0x35: o.push('t = Math.floor(macc * 0.5); macc = (Math.floor(macc * ' + (1 / P51) + ') & 1) * ' + P51 + ' + (t - Math.floor(t * ' + (1 / P51) + ') * ' + P51 + ');'); break;
        case 0x38: { const dr = dRef(), cx = Cx(); o.push('if (!(sti & 192)) { xwr = ' + dr + '; xoa = ' + cx + '; ' + XMINIT + ' sti |= 128; }'); break; }
        case 0x39: { const cx = Cx(); o.push('if (!(sti & 192)) { xoa = ' + cx + '; ' + XMINIT + ' sti |= 64; }'); break; }
        default: o.push("H.miss('1', " + n1 + ');');
      }
      // 後段(カテゴリ 2b): st1 を変える命令。実行時の st1 と、変換の時点の控え st.c の両方を動かす
      if (n2 && isPost(n2)) {
        const set = (mask, val) => { st.c = (st.c & ~mask) | val; o.push('st1 = (st1 & ' + (~mask) + ') | ' + val + ';'); };
        if (n2 === 0x3a) o.push('st1 &= -65;');
        else if (n2 === 0x3c) o.push('st1 &= -9;');
        else if (n2 === 0x3d) o.push('st1 |= 8;');
        else if (n2 === 0x40) set(ST1_MOVM, 0);
        else if (n2 === 0x41) set(ST1_MOVM, ST1_MOVM);
        else if (n2 === 0x44) set(ST1_DBP, 0);
        else if (n2 === 0x45) set(ST1_DBP, ST1_DBP);
        else if (n2 >= 0x48 && n2 <= 0x4b) set(ST1_CRM, (n2 - 0x48) << 18);
        else if (n2 === 0x50) set(ST1_SFAO, 0);
        else if (n2 === 0x51) set(ST1_SFAO, ST1_SFAO);
        else if (n2 === 0x54) set(ST1_SFAI, 0);
        else if (n2 === 0x55) set(ST1_SFAI, ST1_SFAI);
        else if (n2 >= 0x58 && n2 <= 0x5b) set(ST1_SFMA, (n2 - 0x58) << 7);
        else if (n2 >= 0x60 && n2 <= 0x63) set(ST1_SFMO, (n2 - 0x60) << 11);
        else if (n2 >= 0x68 && n2 <= 0x6f) set(ST1_RND, (n2 - 0x68) << 15);
        else o.push("H.miss('2b', " + n2 + ');');
      }
      if (inc & 1) o.push('ca = (ca + 1) & 255;');
      if (inc & 2) o.push('id = (id + 1) & 255;');
      return o.join(' ');
    }
    // pc0 から、アイドルか分岐までを 1 本の関数にする。{ fn, len } か null(変換できない)
    function compileBlock(pc0, st1e) {
      // 1 本の関数は CHUNK 命令まで。255 命令を 1 本にすると大きすぎて、エンジンが最適化しない(実測: 1 本だと実時間の 18%)
      const st = { c: st1e & ST1_CACHE }, fns = [], CHUNK = 16;
      PRE = preCode(); XMINIT = xmInitCode();
      let L = [], inChunk = 0;
      const flush = (nextPc) => {
        if (nextPc !== null) L.push('pc = ' + nextPc + ';');
        const src = '"use strict"; let macc = S[0], mr = S[1], mw = S[2], st1 = S[4], sti = S[5], aacc = S[6], creg = S[12], ca = S[14], id = S[15], pc = 0;\n' +
          'const ba0 = S[16], ba1 = S[17], xba = S[8]; let m = 0, t = 0, over = false, c = 0, d = 0, r = 0, ci = 0, xoa = S[7], xwr = S[9], xrd = S[10], tx = S[11], xa = S[19];\n' + L.join('\n') +
          '\nS[0] = macc; S[1] = mr; S[2] = mw; S[4] = st1; S[5] = sti; S[6] = aacc; S[7] = xoa; S[9] = xwr; S[10] = xrd; S[11] = tx; S[12] = creg; S[13] = pc; S[14] = ca; S[15] = id; S[19] = xa;';
        // eslint-disable-next-line no-new-func
        fns.push(new Function('S', 'cmem', 'dmem0', 'dmem1', 'si', 'so', 'H', 'xram', src));
        L = []; inChunk = 0;
      };
      let pcx = pc0, len = 0, done = false;
      for (let guard = 0; guard < 256 && !done; guard++) {
        const op = prog[pcx], next = (pcx + 1) & 0xff;
        if ((op & 0xfc0000) === 0xfc0000) {
          const n = (op >> 11) & 0x7f, p = op & 0xff;
          if (n === 0x10) {                       // 繰り返し: 次の 1 命令を p+1 回
            const op2 = prog[next];
            if ((op2 & 0xfc0000) === 0xfc0000) return null;
            const before = st.c, body = genInstr(op2, st);
            if (body === null) return null;
            if (p > 0 && st.c !== before) return null;   // 繰り返しの中で決め打ちの条件が変わる物は扱わない
            L.push(PRE, 'for (let rp = ' + (p + 1) + '; rp > 0; rp--) { ' + PRE + ' ' + body + ' }');
            len += p + 2; pcx = (next + 1) & 0xff; inChunk += 2;
            if (inChunk >= CHUNK) flush(pcx);
            continue;
          }
          L.push(PRE); len++;
          if (n === 0x08) { L.push('sti |= 32; pc = ' + next + ';'); done = true; }
          else if (n === 0x18) L.push('ca = ' + p + ';');
          else if (n === 0x20) L.push('id = ' + p + ';');
          else if (n === 0x40) L.push('if ((aacc | 0) >= 0) ca = ' + p + ';');
          else if (n === 0x48) { L.push('pc = ' + p + ';'); done = true; }
          else if (n === 0x50) { L.push('pc = (aacc | 0) > 0 ? ' + p + ' : ' + next + ';'); done = true; }
          else if (n === 0x58) { L.push('pc = (aacc | 0) < 0 ? ' + p + ' : ' + next + ';'); done = true; }
          else if (n === 0x60) { L.push('pc = aacc ? ' + p + ' : ' + next + ';'); done = true; }
          else if (n === 0x78) { L.push('if (st1 & 1) { st1 &= -2; pc = ' + p + '; } else pc = ' + next + ';'); done = true; }
          else if (n !== 0x00) L.push("H.miss('3', " + n + ');');
          pcx = next;
          if (++inChunk >= CHUNK && !done) flush(pcx);
          continue;
        }
        const body = genInstr(op, st);
        if (body === null) return null;
        L.push(PRE, body); len++; pcx = next;
        if (++inChunk >= CHUNK) flush(pcx);
      }
      if (L.length) flush(done ? null : pcx);
      return { fns, len };
    }
    function getBlock() {
      const key = (st1 & ST1_CACHE) * 256 + pc;
      let b = blocks.get(key);
      if (b === undefined) {
        try { b = compileBlock(pc, st1); } catch (e) { jit = false; b = null; }
        blocks.set(key, b); if (b) jitBlocks++;
      }
      return b;
    }
    function runBlock(b) {
      S[0] = macc; S[1] = maccRead; S[2] = maccWrite; S[4] = st1; S[5] = sti; S[6] = aacc; S[7] = xoa; S[9] = xwr; S[10] = xrd; S[11] = txrd; S[12] = creg;
      S[8] = xba; S[14] = ca; S[15] = id; S[16] = ba0; S[17] = ba1; S[19] = xmAdr; S[22] = 0;
      const fns = b.fns; for (let i = 0; i < fns.length; i++) fns[i](S, cmem, dmem0, dmem1, si, so, H, xram);
      macc = S[0]; maccRead = S[1]; maccWrite = S[2]; st1 = S[4]; sti = S[5]; aacc = S[6]; xoa = S[7]; xwr = S[9]; xrd = S[10]; txrd = S[11]; creg = S[12]; pc = S[13]; ca = S[14]; id = S[15]; xmAdr = S[19];
      if (S[22]) xramDirty = true;
      instCount += b.len; jitRuns++;
    }

    // 1 サンプル。入力は -1〜1 の実数、戻りは out[0..3](-1〜1)。
    // MAME の順番: 入力を取り込む → 前のサンプルで計算済みの出力を出す → sync → 次のサンプルまで命令を走らせる
    const out = new Float64Array(4);
    function sample(i0, i1, i2, i3) {
      const k = 32768 * (st0 & ST0_SIM ? 256 : 1);
      si[0] = Math.trunc(i0 * k) & 0xffffff; si[1] = Math.trunc(i1 * k) & 0xffffff; si[2] = Math.trunc(i2 * k) & 0xffffff; si[3] = Math.trunc(i3 * k) & 0xffffff;
      out[0] = ((so[0] << 8) | 0) / 2147483648; out[1] = ((so[1] << 8) | 0) / 2147483648; out[2] = ((so[2] << 8) | 0) / 2147483648; out[3] = ((so[3] << 8) | 0) / 2147483648;
      if (!(sti & IN_PLOAD)) {
        pc = ca = id = 0;
        if (!(st0 & ST0_INCS)) { ba0 = (ba0 - 1) & 0xff; ba1 = (ba1 + 1) & 0xff; }
        xba = (xba - 1) & 0x7ffff;
        st1 &= ~(ST1_AOV | ST1_MOV);
        sti &= ~S_IDLE;
      }
      let n = CYCLES_PER_SAMPLE; emptyAt = -1;
      while (n > 0 && !(sti & (S_IDLE | IN_PLOAD))) {
        if (jit && !rptc && !rptcNext && uHead === uTail && !(sti & S_UPDATE)) { const b = getBlock(); if (b && b.len <= n) { runBlock(b); n -= b.len; continue; } }
        stepIdx = CYCLES_PER_SAMPLE - n; step(); n--;
      }
      if (n === 0) overrun++;
      return out;
    }
    // シークの控え。外付け RAM(256KB)は、一度も書かれていなければ持たない
    function getState() {
      return { cmem: cmem.slice(), dmem0: dmem0.slice(), dmem1: dmem1.slice(), prog: prog.slice(), xram: xramDirty ? xram.slice() : null, update: update.slice(), host: host.slice(), si: si.slice(), so: so.slice(),
        n: [macc, maccRead, maccWrite, st0, st1, sti, aacc, xoa, xba, xwr, xrd, txrd, creg, pc, ca, id, ba0, ba1, rptc, rptcNext, sa, xmAdr, hidx, uHead, uTail] };
    }
    function setState(s) {
      cmem.set(s.cmem); dmem0.set(s.dmem0); dmem1.set(s.dmem1); prog.set(s.prog); if (s.xram) { xram.set(s.xram); xramDirty = true; } else { xram.fill(0); xramDirty = false; }
      update.set(s.update); host.set(s.host); si.set(s.si); so.set(s.so); blocks.clear();
      [macc, maccRead, maccWrite, st0, st1, sti, aacc, xoa, xba, xwr, xrd, txrd, creg, pc, ca, id, ba0, ba1, rptc, rptcNext, sa, xmAdr, hidx, uHead, uTail] = s.n;
    }
    reset();
    return { reset, ctrl, dataW, sample, getState, setState, unhandled, prog, cmem,
      // jit: false で逐次実行だけにする(照合用)。jitStats: 変換した関数の数と、呼んだ回数
      get jit() { return jit; }, set jit(v) { jit = !!v; }, get jitStats() { return { blocks: jitBlocks, runs: jitRuns }; },
      // empty: ホストからの係数の更新を全部食べ終えたか(実機の EMPTY 端子。サウンド CPU はこれを割り込みで待つ)
      get empty() { return uHead === uTail; },
      // emptyAt: 直前の sample() の中で、更新を食べ終えた命令の番号(食べ終えていなければ -1)。サウンド CPU への割り込みの時刻に使う
      get emptyAt() { return emptyAt; },
      get st0() { return st0; }, get st1() { return st1; }, get sti() { return sti; }, get instCount() { return instCount; }, get overrun() { return overrun; } };
  };
})(typeof window !== 'undefined' ? window : globalThis);
