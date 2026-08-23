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
      // BIOSトラップ: 実ROMを積んでいないため、既知のBIOSエントリアドレスにPCが
      // 来たら実CPU命令の代わりに登録済みJS関数を実行しRETをシミュレートする
      // (呼び出し元が汎用ドライバでMSX BIOSコールを使う場合に必須。kssPlayer.js参照)。
      if (this.traps) {
        const trap = this.traps[this.pc];
        if (trap) return trap(this);
      }
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

      if (opcode === 0xCB) {
        // 通常のCB xxは2バイトともM1フェッチでRが+2される。DD/FD CB d xxは
        // DD/FD+CBの時点で既に+2済みで、変位byteと最終opcodeバイトはRを増やさない。
        if (!idx) this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        return extraPrefixCycles + this.execCB(idx);
      }
      if (opcode === 0xED) {
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        return extraPrefixCycles + this.execED();
      }
      return extraPrefixCycles + this.execMain(opcode, idx);
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
          case 7: this.iff1 = true; this.iff2 = true; return 4;
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
})(window);
