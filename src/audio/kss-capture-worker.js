/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-09-16 20:37:14
 *
 * regsOnly capture worker bundle (kssCapture). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.kssCapture is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.kssCaptureBuiltAt = '2026-09-16 20:37:14';
  MML.WorkerBundles.kssCapture = function () {
/*
 * KSS (MSX/SEGA chiptune) ヘッダ解析
 * 参考: libkss (digital-sound-antiques) kssxspec.md / src/kss/kss.c
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const KSS = MML.KSS = MML.KSS || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キーは日本語の原文。MML.I18nが無い環境でも動くよう素通し
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  // 拡張チップフラグ (オフセット 0x0F) の意味
  // MSXモード (bit1=0):
  //   bit0: FMPAC(FM-PAC/OPLL) or FMUNIT (bit1で判別、MSXモードなのでFMPAC)
  //   bit2: RAM使用
  //   bit3: MSX-AUDIO使用
  //   bit4: (MSX-AUDIO使用時) ステレオ
  //   bit6: 0=NTSC, 1=PAL
  // SEGAモード (bit1=1):
  //   bit0: FMUNIT使用
  //   bit1: 1固定(SN76489使用)
  //   bit2: GGステレオ
  //   bit3: RAM使用
  //   bit6: 0=NTSC, 1=PAL
  function decodeDeviceFlag(flag) {
    const sn76489 = !!(flag & 0x02);
    const palMode = !!(flag & 0x40);
    if (sn76489) {
      return {
        mode: 'SEGA',
        fmunit: !!(flag & 0x01),
        fmpac: false,
        sn76489: true,
        ggStereo: !!(flag & 0x04),
        ramMode: !!(flag & 0x08),
        msxAudio: false,
        stereo: !!(flag & 0x04),
        palMode
      };
    }
    const msxAudio = !!(flag & 0x08);
    return {
      mode: 'MSX',
      fmpac: !!(flag & 0x01),
      fmunit: !!(flag & 0x01),
      sn76489: false,
      ramMode: !!(flag & 0x04),
      msxAudio,
      stereo: msxAudio ? !!(flag & 0x10) : false,
      palMode
    };
  }

  /**
   * KSSファイルのバイト列を解析する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  KSS.parseHeader = function (bytes) {
    if (bytes.length < 16) throw new Error(T('KSSヘッダは最低16バイト必要です'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magicStr = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const magicOk = magicStr === 'KSCC' || magicStr === 'KSSX';
    const isExtended = magicStr === 'KSSX';

    const loadAddr = view.getUint16(0x04, true);
    const dataLength = view.getUint16(0x06, true);
    const initAddr = view.getUint16(0x08, true);
    const playAddr = view.getUint16(0x0A, true);
    const bankOffset = view.getUint8(0x0C);
    const bankByte = view.getUint8(0x0D);
    const bankNum = bankByte & 0x7F;
    const bankMode = (bankByte & 0x80) ? '8K' : '16K';
    const extraHeaderSize = view.getUint8(0x0E); // 0x00 (KSCC) or 0x10 (KSSX)
    const deviceFlag = view.getUint8(0x0F);
    const device = decodeDeviceFlag(deviceFlag);

    let firstSong = 0;
    let lastSong = 0;
    let hasSongRange = false;
    let volumes = null;
    let fileSize = null;
    if (isExtended && extraHeaderSize >= 0x10 && bytes.length >= 0x10 + 0x10) {
      const ext = new DataView(bytes.buffer, bytes.byteOffset + 0x10, 0x10);
      fileSize = ext.getUint32(0x00, true);
      firstSong = ext.getUint16(0x08, true);
      lastSong = ext.getUint16(0x0A, true);
      hasSongRange = true;
      volumes = {
        psg: ext.getUint8(0x0C),
        scc: ext.getUint8(0x0D),
        opll: ext.getUint8(0x0E),
        opl: ext.getUint8(0x0F)
      };
    }

    const dataOffset = 0x10 + extraHeaderSize;

    return {
      magic: magicStr,
      magicOk,
      isExtended,
      loadAddr,
      dataLength,
      initAddr,
      playAddr,
      bankOffset,
      bankNum,
      bankMode,
      extraHeaderSize,
      deviceFlag,
      device,
      hasSongRange,
      firstSong,
      lastSong,
      volumes,
      fileSize,
      dataOffset
    };
  };

  /**
   * チップフラグを人間可読な文字列配列にする(ヘッダ表示用)
   */
  KSS.describeChips = function (header) {
    const list = ['PSG(AY-3-8910)'];
    // 16KバンクモードかつRAMモードのタイトルはSCCを積まず0x9800台を素のRAMとして使うため
    // SCCデコード自体を止める(src/emulator/kssBus.js の sccDisable と同じ判定)。
    const sccDisabled = header.bankMode === '16K' && header.device.ramMode;
    if (!sccDisabled) list.push(T('SCC/SCC+ (Konami、使用時のみ)'));
    const d = header.device;
    if (d.mode === 'SEGA') {
      if (d.sn76489) list.push('SN76489');
      if (d.fmunit) list.push('FM Unit (Y8950)');
    } else {
      if (d.fmpac) list.push('FMPAC (OPLL/YM2413)');
      if (d.msxAudio) list.push('MSX-AUDIO (Y8950)');
    }
    return list;
  };

  // Z80クロック(MSX標準)とNTSC/PAL再生周波数
  KSS.Z80_CLOCK = 3579545;
  KSS.NTSC_FPS = KSS.Z80_CLOCK / 59718; // ≒ 59.9256Hz (libkss NTSC_FREQ)
  KSS.PAL_FPS = 50.0;
})(globalThis);

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
})(globalThis);

/*
 * AY-3-8910 PSG エミュレータ (MSX標準音源)
 * MML.Emu.AY8910Audio
 *
 * コア(トーン/ノイズ/エンベロープ/DAC)は src/emulator/expansion/fme7.js と共通設計
 * (FME-7=Sunsoft 5B は AY-3-8910/YM2149 とレジスタ・DSP的に実質同一のため)。
 * バス面のみMSX実機に合わせてポート0xA0(レジスタ選択)/0xA1(データ書込)/0xA2(データ読出)、
 * レジスタ14/15(I/Oポート A/B、未接続なので読み出しは既定0xFF)に置き換えている。
 *
 * トーン: f = Z80クロック/(32*period)。ノイズ: f = clock/(32*period)。
 * エンベロープ: 5bit(0-31)、1ステップ = clock/(16*period)。
 * 音量DAC: 5bit対数(1.5dB/step)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const AY_DAC = new Float32Array(32);
  for (let i = 0; i < 32; i++) AY_DAC[i] = i < 2 ? 0 : Math.pow(10, (i - 31) * 1.5 / 20);

  const NUM_CH = 3;

  class AyTone {
    constructor() { this.period = 1; this.timer = 0; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.level = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.level ^= 1;
      } else {
        this.timer--;
      }
    }
  }

  class AyNoise {
    constructor() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    reset() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.flip ^= 1;
        if (this.flip) {
          const fb = (this.lfsr ^ (this.lfsr >> 3)) & 1;
          this.lfsr = ((this.lfsr >> 1) | (fb << 16)) & 0x1FFFF;
        }
        this.out = this.lfsr & 1;
      } else {
        this.timer--;
      }
    }
  }

  class AyEnvelope {
    constructor() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.cont = false; this.alt = false; this.hold = false; this.holding = false; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.holding = false; this.level = 0; }
    writeShape(s) {
      this.hold = (s & 1) !== 0;
      this.alt = (s & 2) !== 0;
      this.att = (s & 4) !== 0;
      this.cont = (s & 8) !== 0;
      this.step = 0;
      this.holding = false;
      this.timer = 0;
      this.level = this.att ? 0 : 31;
    }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this._step();
      } else {
        this.timer--;
      }
    }
    _step() {
      if (this.holding) return;
      this.step++;
      if (this.step > 31) {
        this.step = 0;
        if (!this.cont) { this.holding = true; this.level = 0; return; }
        if (this.hold) { this.holding = true; this.level = this.alt ? (this.att ? 0 : 31) : (this.att ? 31 : 0); return; }
        if (this.alt) this.att = !this.att;
      }
      this.level = this.att ? this.step : (31 - this.step);
    }
  }

  class AY8910Audio {
    constructor() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38; // 既定: トーンON・ノイズOFF、I/Oポートは入力扱い
      this.regs[14] = 0xFF;
      this.regs[15] = 0xFF;
      this.tones = [new AyTone(), new AyTone(), new AyTone()];
      this.noise = new AyNoise();
      this.env = new AyEnvelope();
      this._div = 0;
      this.mute = [false, false, false];
      this.vol = [1, 1, 1];
    }

    reset() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38;
      this.regs[14] = 0xFF;
      this.regs[15] = 0xFF;
      for (const t of this.tones) t.reset();
      this.noise.reset();
      this.env.reset();
      this._div = 0;
    }

    // port: 0xA0=レジスタ選択, 0xA1=データ書込
    ioWrite(port, value) {
      value &= 0xFF;
      if (port === 0xA0) {
        this.addr = value & 0x0F;
      } else if (port === 0xA1) {
        this.writeInternal(this.addr, value);
      }
    }

    // port 0xA2=データ読出
    readData() {
      return this.regs[this.addr];
    }

    writeInternal(reg, value) {
      this.regs[reg] = value;
      switch (reg) {
        case 0: case 1: this.tones[0].period = this.regs[0] | ((this.regs[1] & 0x0F) << 8); break;
        case 2: case 3: this.tones[1].period = this.regs[2] | ((this.regs[3] & 0x0F) << 8); break;
        case 4: case 5: this.tones[2].period = this.regs[4] | ((this.regs[5] & 0x0F) << 8); break;
        case 6: this.noise.period = value & 0x1F; break;
        case 11: case 12: this.env.period = this.regs[11] | (this.regs[12] << 8); break;
        case 13: this.env.writeShape(value); break;
      }
    }

    clock() {
      if (++this._div >= 16) {
        this._div = 0;
        this.tones[0].clock();
        this.tones[1].clock();
        this.tones[2].clock();
        this.noise.clock();
        this.env.clock();
      }
    }

    channelLevel(ch) {
      const volReg = this.regs[8 + ch];
      if (volReg & 0x10) return this.env.level;
      return ((volReg & 0x0F) * 2) + 1;
    }

    mixSample() {
      const mix = this.regs[7];
      let sum = 0;
      for (let i = 0; i < NUM_CH; i++) {
        if (this.mute[i]) continue;
        const toneOn = ((mix >> i) & 1) === 0;
        const noiseOn = ((mix >> (i + 3)) & 1) === 0;
        const t = toneOn ? this.tones[i].level : 1;
        const n = noiseOn ? this.noise.out : 1;
        if (t && n) sum += AY_DAC[this.channelLevel(i)] * this.vol[i];
      }
      return sum * 0.35;
    }
  }

  // 鍵盤表示用スナップショット。clockHz省略時はMSX Z80クロック基準(=このエミュレータの
  // clock()呼び出しレート、実AYクロックの2倍)。VGMのように別クロックで叩く場合は
  // clock()の呼び出しレートを渡す
  Emu.snapshotAY8910 = function (chip, clockHz) {
    const CLOCK = clockHz || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    const mix = chip.regs[7];
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const period = chip.tones[i].period;
      const toneOn = ((mix >> i) & 1) === 0;
      const noiseOn = ((mix >> (i + 3)) & 1) === 0;
      const level = chip.channelLevel(i);
      const envMode = (chip.regs[8 + i] & 0x10) !== 0;
      const freq = (toneOn && period > 0) ? CLOCK / (32 * period) : 0;
      out.push({
        freq,
        vol: level / 31,
        rawVol: Math.round(level / 2),
        // ★2026-08-22: 「トーン有効だが周期0で、ノイズだけで鳴らしている」打楽器chが
        // 消灯していた(Aleste Gaiden MSX2のch A=全曲period 0/ノイズのみ)。旧式は
        // toneOnを先に見てfreq>0を要求していたため、ノイズ発音中でもactive=falseになる。
        // 実際に音が出る条件は「音量>0 かつ (実周期のあるトーン または ノイズ)」。
        // 音量判定に level>0 は使えない: channelLevel()は音量レジスタ0でも1を返す
        // ((nibble*2)+1 の5bit DACインデックス)ため、固定音量時は level>1 で見る。
        active: (envMode ? level > 0 : level > 1) && ((toneOn && freq > 0) || noiseOn),
        noise: noiseOn,
        // ノイズLFSRのシフトレート。トーンと同じ分周(clock()内で1/16 → 2フリップで1シフト)
        // なので式もトーンと同一(CLOCK/(32*周期))。周期0は実機同様1として扱う。
        noiseFreq: CLOCK / (32 * Math.max(1, chip.noise.period)),
        // トーン発生器が実質鳴っていない(無効 or 周期0)のにノイズが有効 = ノイズ専用ch。
        // 鍵盤のnote列/波形をノイズ表示に切り替える判断に使う(SN76489/GBSのノイズ行と同じ扱い)。
        noiseOnly: noiseOn && !(toneOn && period > 0),
        envMode
      });
    }
    return out;
  };

  Emu.AY8910Audio = AY8910Audio;
})(globalThis);

/*
 * Konami SCC/SCC+ 波形メモリ音源エミュレータ
 * MML.Emu.SCCAudio
 *
 * 5ch、各32byte符号付き波形テーブル。classic(SCC)モードではch3/ch4が波形テーブルを
 * 共有し、SCC+(SCC-I)モードではch4が独立波形を持つ。
 * kssBus.js が「どちらのモードでレジスタ窓が開いているか」を判定した上で
 * readClassic/writeClassic または readPlus/writePlus を、窓先頭+0x800からの
 * オフセット(0x00-0xFF)で呼び出す。内部発振は窓の有無に関わらず常時動作する
 * (実チップはメモリデコードと無関係に発振し続けるため)。
 *
 * ★classicとSCC+でレジスタ配置が異なる(emu2212 write_standard/write_enhanced準拠)。
 *   classic(窓 0x9800-0x98FF):
 *     0x00-0x7F : 波形 ch0-3 (32byte×4、ch3への書込みはch4にも反映される共有波形)
 *     0x80-0x89 : 周波数(12bit、ch0-4、各2byte 下位byte+上位nibble)
 *     0x8A-0x8E : 音量(4bit、ch0-4)
 *     0x8F      : 有効ビット(bit0-4、1で発音)
 *     0xA0-0xBF : 波形ch4 (読出専用、ch3と同一)
 *     0xE0-0xFF : deformレジスタ
 *   SCC+(窓 0xB800-0xB8FF):
 *     0x00-0x9F : 波形 ch0-4 (32byte×5、ch4も独立)
 *     0xA0-0xA9 : 周波数 / 0xAA-0xAE : 音量 / 0xAF : 有効ビット
 *     0xC0-0xDF : deformレジスタ
 *
 * 周波数式: f = Z80クロック / (32 * (period+1))。period<=8で発振停止(実機の既知の仕様)。
 * 出力: 符号付き8bit波形サンプル × 4bit音量 >> 4。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 5;

  class SCCAudio {
    constructor() {
      this.wave = [];
      for (let i = 0; i < NUM_CH; i++) this.wave.push(new Int8Array(32));
      this.freq = new Uint16Array(NUM_CH);
      this.volume = new Uint8Array(NUM_CH);
      this.enable = 0x1F;
      this.deformClassic = 0;
      this.deformPlus = 0;
      this.modeReg = 0;
      this.counter = new Uint32Array(NUM_CH);
      this.pos = new Uint8Array(NUM_CH);
      this.mute = [false, false, false, false, false];
      this.vol = [1, 1, 1, 1, 1];
    }

    reset() {
      for (const w of this.wave) w.fill(0);
      this.freq.fill(0);
      this.volume.fill(0);
      this.enable = 0x1F;
      this.deformClassic = 0;
      this.deformPlus = 0;
      this.modeReg = 0;
      this.counter.fill(0);
      this.pos.fill(0);
    }

    // --- classicモード(0x9800基準オフセット) ---
    readClassic(off) {
      off &= 0xFF;
      if (off < 0x80) return this.wave[off >> 5][off & 0x1F] & 0xFF;
      if (off <= 0x89) { const ch = (off - 0x80) >> 1; return (off & 1) ? ((this.freq[ch] >> 8) & 0x0F) : (this.freq[ch] & 0xFF); }
      if (off <= 0x8E) return this.volume[off - 0x8A] & 0x0F;
      if (off === 0x8F) return this.enable & 0x1F;
      if (off >= 0xA0 && off <= 0xBF) return this.wave[3][off & 0x1F] & 0xFF; // ch4=ch3共有(読出のみ)
      return 0xFF;
    }

    writeClassic(off, value) {
      off &= 0xFF;
      value &= 0xFF;
      if (off < 0x80) {
        const ch = off >> 5;
        this.wave[ch][off & 0x1F] = value;
        if (ch === 3) this.wave[4][off & 0x1F] = value; // ch3書込みはch4にも反映(共有波形)
        return;
      }
      if (off <= 0x89) {
        const ch = (off - 0x80) >> 1;
        if (off & 1) this.freq[ch] = (this.freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
        else this.freq[ch] = (this.freq[ch] & 0x0F00) | value;
        return;
      }
      if (off <= 0x8E) { this.volume[off - 0x8A] = value & 0x0F; return; }
      if (off === 0x8F) { this.enable = value & 0x1F; return; }
      if (off >= 0xE0) { this.deformClassic = value; return; }
      // 0xA0-0xBF (ch4波形) はclassicモードでは書込不可
    }

    // --- SCC+(SCC-I)モード(0xB800基準オフセット) ---
    // ★classicとレジスタ配置が違う(emu2212 write_enhanced準拠)。ここをclassicと同じ
    // 配置で実装していたため、SCC+を使うタイトル(スナッチャー/SDスナッチャー等)は
    // 周波数(0xA0-)と音量(0xAA-)の書込みが「ch4の波形」と誤解釈されて一切設定されず、
    // PSGだけ鳴ってSCCが無音になっていた。
    //   0x00-0x9F : 波形 ch0-4 (32byte×5、ch4も独立して書ける)
    //   0xA0-0xA9 : 周波数(12bit、各2byte)
    //   0xAA-0xAE : 音量(4bit)
    //   0xAF      : 有効ビット(bit0-4)
    //   0xC0-0xDF : deformレジスタ
    readPlus(off) {
      off &= 0xFF;
      if (off < 0xA0) return this.wave[off >> 5][off & 0x1F] & 0xFF;
      if (off <= 0xA9) { const ch = (off - 0xA0) >> 1; return (off & 1) ? ((this.freq[ch] >> 8) & 0x0F) : (this.freq[ch] & 0xFF); }
      if (off <= 0xAE) return this.volume[off - 0xAA] & 0x0F;
      if (off === 0xAF) return this.enable & 0x1F;
      if (off >= 0xC0 && off <= 0xDF) return this.deformPlus;
      return 0xFF;
    }

    writePlus(off, value) {
      off &= 0xFF;
      value &= 0xFF;
      if (off < 0xA0) { this.wave[off >> 5][off & 0x1F] = value; return; }
      if (off <= 0xA9) {
        const ch = (off - 0xA0) >> 1;
        if (off & 1) this.freq[ch] = (this.freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
        else this.freq[ch] = (this.freq[ch] & 0x0F00) | value;
        return;
      }
      if (off <= 0xAE) { this.volume[off - 0xAA] = value & 0x0F; return; }
      if (off === 0xAF) { this.enable = value & 0x1F; return; }
      if (off >= 0xC0 && off <= 0xDF) { this.deformPlus = value; return; }
    }

    // 1 Z80サイクル分クロック
    // (deformレジスタによる周波数マスクは、実運用でほぼ使われない特殊効果のため
    //  常時ゲームが使う生のfreqレジスタで発振させる。deformレジスタ自体の読み書きは
    //  read/writeClassic・read/writePlus で保持している)
    clock() {
      for (let ch = 0; ch < NUM_CH; ch++) {
        const period = this.freq[ch];
        if (period <= 8) continue; // 実機の既知の仕様: 低周期で発振停止(DC出力)
        this.counter[ch]++;
        if (this.counter[ch] >= period + 1) {
          this.counter[ch] = 0;
          this.pos[ch] = (this.pos[ch] + 1) & 0x1F;
        }
      }
    }

    mixSample() {
      let sum = 0;
      for (let ch = 0; ch < NUM_CH; ch++) {
        if (this.mute[ch]) continue;
        if (!((this.enable >> ch) & 1)) continue;
        const sample = this.wave[ch][this.pos[ch]]; // 符号付き -128..127
        const vol = this.volume[ch];
        sum += ((sample * vol) >> 4) * this.vol[ch];
      }
      return sum * (0.2 / 128);
    }
  }

  // 鍵盤表示用スナップショット
  Emu.snapshotSCC = function (chip) {
    const CLOCK = MML.KSS ? MML.KSS.Z80_CLOCK : 3579545;
    const out = [];
    for (let ch = 0; ch < NUM_CH; ch++) {
      const period = chip.freq[ch];
      const enabled = !!((chip.enable >> ch) & 1);
      const freq = period > 8 ? CLOCK / (32 * (period + 1)) : 0;
      const waveData = new Array(32);
      for (let i = 0; i < 32; i++) waveData[i] = chip.wave[ch][i] / 128;
      out.push({
        freq,
        vol: chip.volume[ch] / 15,
        rawVol: chip.volume[ch],
        waveData,
        active: enabled && chip.volume[ch] > 0 && freq > 0
      });
    }
    return out;
  };

  Emu.SCCAudio = SCCAudio;
})(globalThis);

/*
 * OPLL (Yamaha YM2413 / Konami VRC VII = DS1001) サイクルアキュレート・エミュレータ
 * MML.Emu.OPLLNuked
 *
 * nukeykt/Nuked-OPLL (opll.c v1.0.2, GPLv2, Copyright (C) 2019-2023 Nuke.YKT) の移植。
 * 音色ROM・アルゴリズムとも siliconpr0n (digshadow, John McMaster) による
 * VRC VII decap / die shot 由来。本リポジトリもGPLv2なのでライセンス上の問題は無い。
 *
 * 従来の emu2413 0.6x系移植(vrc7.js / opllMsx.js)との違い:
 *   - 演算器が1個しか無い実チップの18スロット時分割パイプラインをそのまま再現する。
 *     1サンプル = 18サイクル、各サイクルが1スロットぶんの演算と1chぶんのDAC出力を担う。
 *   - EGは位相蓄積(dphaseARTable等の近似)ではなく、実機のeg_timer + シフト量テーブル方式。
 *     キーオン時のDAMP(rate12まで一旦落としてからアタック)も含む。
 *   - AM/PM LFOがfloat sin近似ではなく実機の整数カウンタ/テーブル。
 *   - 出力は9bit相当の時分割DACをそのまま合算するため、実機特有の量子化感が出る。
 *
 * チップ種別 (constructor の opts.chipType):
 *   'ds1001'(VRC7): 6メロディch、リズムモード無し(rhythm常時0x20)、音色ROM=patch_ds1001。
 *   'ym2413'(FMPAC/VGM、既定): 9メロディch、リズムモード有り、音色ROM=patch_ym2413。
 *
 * クロック: clock() は「呼び出し側のホストクロック1サイクル」ごとに呼ぶ。OPLLの1内部
 * サイクルは実チップのマスタクロック4個ぶんなので、
 *   VRC7 (NSF)      : ホスト=NES CPU 1.789773MHz = マスタ/2 → 2ホストサイクルで1内部サイクル
 *   FMPAC/VGM       : ホスト=3.579545MHz = マスタそのもの   → 4ホストサイクルで1内部サイクル
 * どちらも 18内部サイクル = 1サンプル で 49716Hz になる(36 / 72 ホストサイクル)。
 * ★この非対称は [[opll-fmpac-clock-divider-octave-bug]] と同じ理由。取り違えると1オクターブずれる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ---- EG状態 ----
  const EG_ATTACK = 0, EG_DECAY = 1, EG_SUSTAIN = 2, EG_RELEASE = 3;
  // ---- リズムスロット選択 ----
  const RM_BD0 = 0, RM_HH = 1, RM_TOM = 2, RM_BD1 = 3, RM_SD = 4, RM_TC = 5;
  const PATCH_DRUM_0 = 15; // patchrom内のドラム音色開始index

  const SAMPLE_RATE = 49716;
  const CYCLES_PER_SAMPLE = 18; // OPLL内部サイクル/サンプル

  const LOGSIN = new Uint16Array([
    0x859,0x6c3,0x607,0x58b,0x52e,0x4e4,0x4a6,0x471,0x443,0x41a,0x3f5,0x3d3,0x3b5,0x398,0x37e,
    0x365,0x34e,0x339,0x324,0x311,0x2ff,0x2ed,0x2dc,0x2cd,0x2bd,0x2af,0x2a0,0x293,0x286,0x279,
    0x26d,0x261,0x256,0x24b,0x240,0x236,0x22c,0x222,0x218,0x20f,0x206,0x1fd,0x1f5,0x1ec,0x1e4,
    0x1dc,0x1d4,0x1cd,0x1c5,0x1be,0x1b7,0x1b0,0x1a9,0x1a2,0x19b,0x195,0x18f,0x188,0x182,0x17c,
    0x177,0x171,0x16b,0x166,0x160,0x15b,0x155,0x150,0x14b,0x146,0x141,0x13c,0x137,0x133,0x12e,
    0x129,0x125,0x121,0x11c,0x118,0x114,0x10f,0x10b,0x107,0x103,0x0ff,0x0fb,0x0f8,0x0f4,0x0f0,
    0x0ec,0x0e9,0x0e5,0x0e2,0x0de,0x0db,0x0d7,0x0d4,0x0d1,0x0cd,0x0ca,0x0c7,0x0c4,0x0c1,0x0be,
    0x0bb,0x0b8,0x0b5,0x0b2,0x0af,0x0ac,0x0a9,0x0a7,0x0a4,0x0a1,0x09f,0x09c,0x099,0x097,0x094,
    0x092,0x08f,0x08d,0x08a,0x088,0x086,0x083,0x081,0x07f,0x07d,0x07a,0x078,0x076,0x074,0x072,
    0x070,0x06e,0x06c,0x06a,0x068,0x066,0x064,0x062,0x060,0x05e,0x05c,0x05b,0x059,0x057,0x055,
    0x053,0x052,0x050,0x04e,0x04d,0x04b,0x04a,0x048,0x046,0x045,0x043,0x042,0x040,0x03f,0x03e,
    0x03c,0x03b,0x039,0x038,0x037,0x035,0x034,0x033,0x031,0x030,0x02f,0x02e,0x02d,0x02b,0x02a,
    0x029,0x028,0x027,0x026,0x025,0x024,0x023,0x022,0x021,0x020,0x01f,0x01e,0x01d,0x01c,0x01b,
    0x01a,0x019,0x018,0x017,0x017,0x016,0x015,0x014,0x014,0x013,0x012,0x011,0x011,0x010,0x00f,
    0x00f,0x00e,0x00d,0x00d,0x00c,0x00c,0x00b,0x00a,0x00a,0x009,0x009,0x008,0x008,0x007,0x007,
    0x007,0x006,0x006,0x005,0x005,0x005,0x004,0x004,0x004,0x003,0x003,0x003,0x002,0x002,0x002,
    0x002,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x000,0x000,0x000,0x000,0x000,0x000,0x000,
    0x000
  ]);

  const EXPROM = new Uint16Array([
    0x7fa,0x7f5,0x7ef,0x7ea,0x7e4,0x7df,0x7da,0x7d4,0x7cf,0x7c9,0x7c4,0x7bf,0x7b9,0x7b4,0x7ae,
    0x7a9,0x7a4,0x79f,0x799,0x794,0x78f,0x78a,0x784,0x77f,0x77a,0x775,0x770,0x76a,0x765,0x760,
    0x75b,0x756,0x751,0x74c,0x747,0x742,0x73d,0x738,0x733,0x72e,0x729,0x724,0x71f,0x71a,0x715,
    0x710,0x70b,0x706,0x702,0x6fd,0x6f8,0x6f3,0x6ee,0x6e9,0x6e5,0x6e0,0x6db,0x6d6,0x6d2,0x6cd,
    0x6c8,0x6c4,0x6bf,0x6ba,0x6b5,0x6b1,0x6ac,0x6a8,0x6a3,0x69e,0x69a,0x695,0x691,0x68c,0x688,
    0x683,0x67f,0x67a,0x676,0x671,0x66d,0x668,0x664,0x65f,0x65b,0x657,0x652,0x64e,0x649,0x645,
    0x641,0x63c,0x638,0x634,0x630,0x62b,0x627,0x623,0x61e,0x61a,0x616,0x612,0x60e,0x609,0x605,
    0x601,0x5fd,0x5f9,0x5f5,0x5f0,0x5ec,0x5e8,0x5e4,0x5e0,0x5dc,0x5d8,0x5d4,0x5d0,0x5cc,0x5c8,
    0x5c4,0x5c0,0x5bc,0x5b8,0x5b4,0x5b0,0x5ac,0x5a8,0x5a4,0x5a0,0x59c,0x599,0x595,0x591,0x58d,
    0x589,0x585,0x581,0x57e,0x57a,0x576,0x572,0x56f,0x56b,0x567,0x563,0x560,0x55c,0x558,0x554,
    0x551,0x54d,0x549,0x546,0x542,0x53e,0x53b,0x537,0x534,0x530,0x52c,0x529,0x525,0x522,0x51e,
    0x51b,0x517,0x514,0x510,0x50c,0x509,0x506,0x502,0x4ff,0x4fb,0x4f8,0x4f4,0x4f1,0x4ed,0x4ea,
    0x4e7,0x4e3,0x4e0,0x4dc,0x4d9,0x4d6,0x4d2,0x4cf,0x4cc,0x4c8,0x4c5,0x4c2,0x4be,0x4bb,0x4b8,
    0x4b5,0x4b1,0x4ae,0x4ab,0x4a8,0x4a4,0x4a1,0x49e,0x49b,0x498,0x494,0x491,0x48e,0x48b,0x488,
    0x485,0x482,0x47e,0x47b,0x478,0x475,0x472,0x46f,0x46c,0x469,0x466,0x463,0x460,0x45d,0x45a,
    0x457,0x454,0x451,0x44e,0x44b,0x448,0x445,0x442,0x43f,0x43c,0x439,0x436,0x433,0x430,0x42d,
    0x42a,0x428,0x425,0x422,0x41f,0x41c,0x419,0x416,0x414,0x411,0x40e,0x40b,0x408,0x406,0x403,
    0x400
  ]);

  const CH_OFFSET = new Uint8Array([1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 6, 7, 8, 0]);
  const PG_MULTI = new Uint8Array([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
  const EG_STEPHI = [
    new Uint8Array([0, 0, 0, 0]),
    new Uint8Array([1, 0, 0, 0]),
    new Uint8Array([1, 0, 1, 0]),
    new Uint8Array([1, 1, 1, 0])
  ];
  const EG_KSLTABLE = new Uint8Array([0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64]);

  // PATCH_DS1001
  const PATCH_DS1001 = [
    { tl: 5, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[0,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[14, 8], dr:[ 8, 1], sl:[ 4, 2], rr:[ 2, 7] }, // @1
    { tl:20, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 6], sl:[ 2, 1], rr:[ 3, 2] }, // @2
    { tl: 8, dc:0, dm:1, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,1], multi:[ 1, 1], ksl:[0,0], ar:[15,11], dr:[10, 2], sl:[ 2, 1], rr:[ 0, 2] }, // @3
    { tl:12, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 6, 2], rr:[ 1, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 1, 6], sl:[ 0, 2], rr:[ 1, 8] }, // @5
    { tl: 6, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 2, 1], ksl:[0,0], ar:[10,14], dr:[ 3, 2], sl:[15,15], rr:[ 4, 4] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 1, 7] }, // @7
    { tl:34, dc:1, dm:0, fb:7, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 1], rr:[ 1, 7] }, // @8
    { tl:37, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[1,0], ksr:[1,1], multi:[ 5, 1], ksl:[0,0], ar:[ 4, 7], dr:[ 0, 3], sl:[ 7, 0], rr:[ 2, 1] }, // @9
    { tl:15, dc:0, dm:1, fb:7, am:[1,0], vib:[0,0], et:[1,0], ksr:[1,0], multi:[ 5, 1], ksl:[0,0], ar:[10,10], dr:[ 8, 5], sl:[ 5, 0], rr:[ 1, 2] }, // @10
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @11
    { tl:17, dc:0, dm:0, fb:6, am:[0,0], vib:[1,0], et:[1,1], ksr:[1,0], multi:[ 1, 3], ksl:[0,0], ar:[ 6, 7], dr:[ 5, 4], sl:[ 1, 1], rr:[ 8, 6] }, // @12
    { tl:19, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 2], ksl:[3,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @13
    { tl:12, dc:0, dm:0, fb:0, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 3], ksl:[0,0], ar:[ 9,12], dr:[ 4, 0], sl:[ 3,15], rr:[ 3, 6] }, // @14
    { tl:13, dc:0, dm:0, fb:0, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,1], multi:[ 1, 2], ksl:[0,0], ar:[12,13], dr:[ 1, 5], sl:[ 5, 0], rr:[ 6, 6] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // PATCH_YM2413
  const PATCH_YM2413 = [
    { tl:30, dc:1, dm:0, fb:7, am:[0,0], vib:[1,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[13, 7], dr:[ 0, 8], sl:[ 0, 1], rr:[ 0, 7] }, // @1
    { tl:26, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 7], sl:[ 2, 1], rr:[ 3, 3] }, // @2
    { tl:25, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,12], dr:[ 2, 4], sl:[ 1, 2], rr:[ 1, 3] }, // @3
    { tl:14, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 7, 2], rr:[ 0, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 0, 6], sl:[ 0, 2], rr:[ 0, 8] }, // @5
    { tl:22, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 1, 2], ksl:[0,0], ar:[14, 7], dr:[ 0, 1], sl:[ 0, 1], rr:[ 0, 8] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 0, 7] }, // @7
    { tl:45, dc:1, dm:0, fb:4, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 0], rr:[ 0, 7] }, // @8
    { tl:27, dc:0, dm:0, fb:6, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 6, 6], dr:[ 4, 5], sl:[ 1, 1], rr:[ 0, 7] }, // @9
    { tl:11, dc:1, dm:1, fb:0, am:[0,0], vib:[1,1], et:[0,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8,15], dr:[ 5, 7], sl:[ 7, 0], rr:[ 1, 7] }, // @10
    { tl: 3, dc:1, dm:0, fb:1, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,14], dr:[10, 4], sl:[ 1, 0], rr:[ 0, 4] }, // @11
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @12
    { tl:12, dc:0, dm:0, fb:5, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,1], multi:[ 1, 0], ksl:[0,0], ar:[12,15], dr:[ 2, 5], sl:[ 2, 4], rr:[ 0, 2] }, // @13
    { tl:21, dc:0, dm:0, fb:3, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 1], ksl:[1,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @14
    { tl: 9, dc:0, dm:0, fb:3, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,0], multi:[ 1, 1], ksl:[2,0], ar:[15,14], dr:[ 1, 4], sl:[ 4, 1], rr:[ 0, 3] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // ---- サイクル→チャンネル対応表 ----
  // output_m は ismod=(cycles/3)&1 が0のサイクルだけ「そのchのキャリア出力」を運ぶ。
  // 担当chは CH_OFFSET を演算パイプラインの段数ぶん遡った位置。段数は解析で出すより
  // 実測が確実なので、1chずつ鳴らして output_m が立つサイクルを調べた結果 11 と判明
  // (cycle 0,1,2→ch6,7,8 / 6,7,8→ch0,1,2 / 12,13,14→ch3,4,5)。
  const PIPELINE_DELAY = 11;
  const CARRIER_CH = new Int8Array(18).fill(-1);
  for (let c = 0; c < 18; c++) {
    if (((c / 3) | 0) & 1) continue;          // モジュレータ側のサイクルは出力しない
    CARRIER_CH[c] = CH_OFFSET[(c + PIPELINE_DELAY) % 18];
  }
  // output_r(リズム)も同様に実測(太鼓を1種ずつ鳴らして output_r が立つサイクルを特定)。
  // 各太鼓は1巡で2回ぶん出力される(実機の時分割DACがリズムchを2回読むため。旧コアには
  // 無かった挙動で、リズムがメロディに対して相対的に大きく出るのはこれが理由)。
  //   BD:cycle 0,5 / SD:1,9 / CYM:2,10 / HH:3,16 / TOM:4,17
  // 鍵盤のミュート枠は旧コア(opllMsx.js)と同じく BD=ch6 / HH,SD=ch7 / TOM,CYM=ch8。
  // ★2026-08-22: 打楽器のミュート/音量は実チャンネル(6-8)ではなく専用の添字9-13を使う。
  // SDとHHは実機では同じch7、TOMとCYMは同じch8だが、鍵盤には5行が別々に出るため
  // 実ch単位だと2行が同じ添字を共有し、getMuteConfig()の書き込み順で片方が無視される。
  // ここは出力サイクルで打楽器を識別できるので5種を独立させられる(keyboard.js KF_RHYTHM_INDEX)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14; // 0-8=メロディch / 9-13=BD,SD,TOM,CYM,HH
  const RHYTHM_CH = new Int8Array(18).fill(-1);
  RHYTHM_CH[0] = MUTE_BD;  RHYTHM_CH[5] = MUTE_BD;       // BD
  RHYTHM_CH[1] = MUTE_SD;  RHYTHM_CH[9] = MUTE_SD;       // SD
  RHYTHM_CH[3] = MUTE_HH;  RHYTHM_CH[16] = MUTE_HH;      // HH
  RHYTHM_CH[4] = MUTE_TOM; RHYTHM_CH[17] = MUTE_TOM;     // TOM
  RHYTHM_CH[2] = MUTE_CYM; RHYTHM_CH[10] = MUTE_CYM;     // CYM

  // ---- eg_level[] のスロット番号 ↔ (ch, mod/car) 対応 ----
  // eg_level は「サイクル番号=スロット番号」で索かれ、そのスロットの担当は
  // ch=CH_OFFSET[c] / mcsel=((c+1)/3)&1 (1がキャリア)。鍵盤スナップショット用に逆引きを作る。
  const SLOT_MOD = new Int8Array(9).fill(-1);
  const SLOT_CAR = new Int8Array(9).fill(-1);
  for (let c = 0; c < 18; c++) {
    const ch = CH_OFFSET[c];
    if (((((c + 1) / 3) | 0) & 1) === 1) SLOT_CAR[ch] = c; else SLOT_MOD[ch] = c;
  }

  // 打楽器5種が使う eg_level のスロット番号(bd,sd,tom,cym,hh)。実測で確認済み
  // (1種ずつ鳴らして下がるスロットを特定: BD=11と14, SD=15, TOM=13, CYM=16, HH=12)。
  const RHYTHM_SLOT = [SLOT_CAR[6], SLOT_CAR[7], SLOT_MOD[8], SLOT_CAR[8], SLOT_MOD[7]];

  const s8 = (v) => (v << 24) >> 24; // int8_t への切り詰め(rm_enableの算術右シフト用)

  function newPatch() {
    return {
      tl: 0, dc: 0, dm: 0, fb: 0,
      am: [0, 0], vib: [0, 0], et: [0, 0], ksr: [0, 0],
      multi: [0, 0], ksl: [0, 0], ar: [0, 0], dr: [0, 0], sl: [0, 0], rr: [0, 0]
    };
  }

  class OPLLNuked {
    constructor(opts) {
      opts = opts || {};
      this.chipType = (opts.chipType === 'ds1001') ? 'ds1001' : 'ym2413';
      this.isDs1001 = this.chipType === 'ds1001';
      this.patchrom = this.isDs1001 ? PATCH_DS1001 : PATCH_YM2413;
      this.numCh = this.isDs1001 ? 6 : 9;
      // ホストクロック→内部サイクルの分周(冒頭コメント参照)
      this.hostPerOpll = opts.hostCyclesPerOpllCycle || (this.isDs1001 ? 2 : 4);
      // 0-8=メロディch / 9-13=リズム(BD,SD,TOM,CYM,HH)。RHYTHM_CH のコメント参照
      this.mute = new Array(NUM_MUTE_SLOTS).fill(false);
      this.vol = new Array(NUM_MUTE_SLOTS).fill(1);
      this._alloc();
      this.reset();
    }

    _alloc() {
      this.eg_state = new Uint8Array(18);
      this.eg_level = new Uint8Array(18);
      this.pg_phase = new Uint32Array(18);
      this.op_fb1 = new Int16Array(9);
      this.op_fb2 = new Int16Array(9);
      this.fnum = new Uint16Array(9);
      this.block = new Uint8Array(9);
      this.kon = new Uint8Array(9);
      this.son = new Uint8Array(9);
      this.regVol = new Uint8Array(9);
      this.inst = new Uint8Array(9);
      this.patch = newPatch();
      this.regShadow = new Uint8Array(0x40); // $00-$3F の素の値(スナップショット/デバッグ用)
      this._rhythmPeak = new Uint8Array(5); // 打楽器のピークホールド(_rhythmSlotInfo参照)
      this.writebuf = [];
      this.writeHead = 0; // shift()を使わないための取り出し位置
    }

    reset() {
      this.cycles = 0; this.slot = 0;
      this.write_data = 0; this.write_a = 0; this.write_d = 0;
      this.write_a_en = 0; this.write_d_en = 0;
      this.write_fm_address = 0; this.write_fm_data = 0; this.write_mode_address = 0;
      this.address = 0; this.data = 0;

      this.eg_counter_state = 0; this.eg_counter_state_prev = 0;
      this.eg_timer = 0; this.eg_timer_low_lock = 0; this.eg_timer_carry = 0;
      this.eg_timer_shift = 0; this.eg_timer_shift_lock = 0; this.eg_timer_shift_stop = 0;
      this.eg_kon = 0; this.eg_dokon = 0; this.eg_off = 0;
      this.eg_rate = 0; this.eg_maxrate = 0; this.eg_zerorate = 0;
      this.eg_inc_lo = 0; this.eg_inc_hi = 0; this.eg_rate_hi = 0;
      this.eg_sl = 0; this.eg_ksltl = 0; this.eg_out = 0x7f; this.eg_silent = 0;

      this.pg_fnum = 0; this.pg_block = 0; this.pg_out = 0; this.pg_inc = 0; this.pg_phase_next = 0;

      this.op_fbsum = 0; this.op_mod = 0; this.op_neg = 0;
      this.op_logsin = 0; this.op_exp_m = 0; this.op_exp_s = 0;

      this.ch_out = 0; this.ch_out_hh = 0; this.ch_out_tm = 0;
      this.ch_out_bd = 0; this.ch_out_sd = 0; this.ch_out_tc = 0;

      this.lfo_counter = 0; this.lfo_vib_counter = 0; this.lfo_am_counter = 0;
      this.lfo_am_step = 0; this.lfo_am_dir = 0; this.lfo_am_car = 0; this.lfo_am_out = 0;

      this.rhythm = 0; this.testmode = 0;
      this.c_instr = 0; this.c_op = 0; this.c_tl = 0; this.c_dc = 0; this.c_dm = 0; this.c_fb = 0;
      this.c_am = 0; this.c_vib = 0; this.c_et = 0; this.c_ksr = 0;
      this.c_ksr_freq = 0; this.c_ksl_freq = 0; this.c_ksl_block = 0;
      this.c_multi = 0; this.c_ksl = 0;
      this.c_adrr = [0, 0, 0];
      this.c_sl = 0; this.c_fnum = 0; this.c_block = 0;

      this.rm_enable = 0; this.rm_noise = 0; this.rm_select = RM_TC + 1;
      this.rm_hh_bit2 = 0; this.rm_hh_bit3 = 0; this.rm_hh_bit7 = 0; this.rm_hh_bit8 = 0;
      this.rm_tc_bit3 = 0; this.rm_tc_bit5 = 0;

      this.output_m = 0; this.output_r = 0;

      this.eg_state.fill(EG_RELEASE);
      this.eg_level.fill(0x7f);
      this._rhythmPeak.fill(0x7f);
      this.pg_phase.fill(0);
      this.op_fb1.fill(0); this.op_fb2.fill(0);
      this.fnum.fill(0); this.block.fill(0); this.kon.fill(0); this.son.fill(0);
      this.regVol.fill(0); this.inst.fill(0);
      this.regShadow.fill(0);
      const p = this.patch;
      p.tl = p.dc = p.dm = p.fb = 0;
      for (let i = 0; i < 2; i++) {
        p.am[i] = p.vib[i] = p.et[i] = p.ksr[i] = 0;
        p.multi[i] = p.ksl[i] = p.ar[i] = p.dr[i] = p.sl[i] = p.rr[i] = 0;
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      this._addrLatch = 0;
      this._writePhase = 0;

      if (this.isDs1001) { // VRC7はリズムモードが常時ON扱い
        this.rhythm = 0x20;
        this.rm_enable = s8(0x80);
      }

      this.hostAccum = 0;
      this.sampleAccum = 0;
      this.sampleCycles = 0;
      this.lastSample = 0;
      this.dcX = 0; this.dcY = 0; this.dcPrimed = 0;
    }

    // ────────── OPLL_DoIO ──────────
    _doIO() {
      this.write_a_en = ((this.write_a & 0x03) === 0x01) ? 1 : 0;
      this.write_d_en = ((this.write_d & 0x03) === 0x01) ? 1 : 0;
      this.write_a = (this.write_a << 1) & 0xff;
      this.write_d = (this.write_d << 1) & 0xff;
    }

    // ────────── OPLL_DoModeWrite ──────────
    _doModeWrite() {
      if (!((this.write_mode_address & 0x10) && this.write_d_en)) return;
      const slot = this.write_mode_address & 0x01;
      const d = this.write_data;
      const p = this.patch;
      switch (this.write_mode_address & 0x0f) {
        case 0x00: case 0x01:
          p.multi[slot] = d & 0x0f;
          p.ksr[slot] = (d >> 4) & 0x01;
          p.et[slot] = (d >> 5) & 0x01;
          p.vib[slot] = (d >> 6) & 0x01;
          p.am[slot] = (d >> 7) & 0x01;
          break;
        case 0x02: p.ksl[0] = (d >> 6) & 0x03; p.tl = d & 0x3f; break;
        case 0x03:
          p.ksl[1] = (d >> 6) & 0x03;
          p.dc = (d >> 4) & 0x01; p.dm = (d >> 3) & 0x01; p.fb = d & 0x07;
          break;
        case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
        case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        case 0x0e:
          this.rhythm = d & 0x3f;
          if (this.isDs1001) this.rhythm |= 0x20;
          this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
          break;
        case 0x0f: this.testmode = d & 0x0f; break;
      }
    }

    // ────────── OPLL_DoRegWrite ──────────
    _doRegWrite() {
      if (this.write_a_en) {
        if ((this.write_data & 0xc0) === 0x00) {
          this.write_fm_address = 1;
          this.address = this.write_data;
        } else {
          this.write_fm_address = 0;
        }
      }
      if (this.write_fm_address && this.write_d_en) this.data = this.write_data;

      if (this.write_fm_data && !this.write_a_en) {
        if ((this.address & 0x0f) === this.cycles && this.cycles < 16) {
          const channel = this.cycles % 9;
          switch (this.address & 0xf0) {
            case 0x10:
              this.fnum[channel] = (this.fnum[channel] & 0x100) | this.data;
              break;
            case 0x20:
              this.fnum[channel] = (this.fnum[channel] & 0xff) | ((this.data & 0x01) << 8);
              this.block[channel] = (this.data >> 1) & 0x07;
              this.kon[channel] = (this.data >> 4) & 0x01;
              this.son[channel] = (this.data >> 5) & 0x01;
              break;
            case 0x30:
              this.regVol[channel] = this.data & 0x0f;
              this.inst[channel] = (this.data >> 4) & 0x0f;
              break;
          }
        }
      }

      if (this.write_a_en) this.write_fm_data = 0;
      if (this.write_fm_address && this.write_d_en) this.write_fm_data = 1;
      if (this.write_a_en) {
        this.write_mode_address = ((this.write_data & 0xf0) === 0x00)
          ? (0x10 | (this.write_data & 0x0f)) : 0x00;
      }
    }

    // ────────── OPLL_PreparePatch1 / 2 ──────────
    _selectPatch(mcsel) {
      const ch = CH_OFFSET[this.cycles];
      const instr = this.inst[ch];
      if (this.rm_select <= RM_TC) return this.patchrom[PATCH_DRUM_0 + this.rm_select];
      if (instr > 0) return this.patchrom[instr - 1];
      return this.patch;
    }

    _preparePatch1() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      if (this.rm_select === RM_HH || this.rm_select === RM_TOM) this.c_tl = this.inst[ch] << 2;
      else if (mcsel === 1) this.c_tl = this.regVol[ch] << 2;
      else this.c_tl = patch.tl;

      this.c_adrr[0] = patch.ar[mcsel];
      this.c_adrr[1] = patch.dr[mcsel];
      this.c_adrr[2] = patch.rr[mcsel];
      this.c_et = patch.et[mcsel];
      this.c_ksr = patch.ksr[mcsel];
      this.c_ksl = patch.ksl[mcsel];
      this.c_ksr_freq = (this.block[ch] << 1) | (this.fnum[ch] >> 8);
      this.c_ksl_freq = this.fnum[ch] >> 5;
      this.c_ksl_block = this.block[ch];
    }

    _preparePatch2() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      this.c_fnum = this.fnum[ch];
      this.c_block = this.block[ch];
      this.c_multi = patch.multi[mcsel];
      this.c_sl = patch.sl[mcsel];
      this.c_fb = patch.fb;
      this.c_vib = patch.vib[mcsel];
      this.c_am = patch.am[mcsel];
      this.c_dc = ((this.c_dc << 1) | patch.dc) & 0xff;
      this.c_dm = ((this.c_dm << 1) | patch.dm) & 0xff;
    }

    // ────────── OPLL_PhaseGenerate ──────────
    _phaseGenerate() {
      this.pg_phase[(this.cycles + 17) % 18] = (this.pg_phase_next + this.pg_inc) >>> 0;

      let ismod;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod = 0;
      else ismod = (((this.cycles + 3) / 3) | 0) & 1;

      const phase = this.pg_phase[this.cycles];
      if ((this.testmode & 0x04)
        || (ismod && (this.eg_dokon & 0x8000)) || (!ismod && (this.eg_dokon & 0x01))) {
        this.pg_phase_next = 0;
      } else {
        this.pg_phase_next = phase;
      }

      if (this.cycles === 13) {
        this.rm_hh_bit2 = (phase >>> (2 + 9)) & 1;
        this.rm_hh_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_hh_bit7 = (phase >>> (7 + 9)) & 1;
        this.rm_hh_bit8 = (phase >>> (8 + 9)) & 1;
      } else if (this.cycles === 17 && (this.rm_enable & 0x80)) {
        this.rm_tc_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_tc_bit5 = (phase >>> (5 + 9)) & 1;
      }

      let pg_out;
      if (this.rm_enable & 0x80) {
        let rm_bit;
        switch (this.cycles) {
          case 13: // HH
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = rm_bit << 9;
            pg_out |= (rm_bit ^ (this.rm_noise & 1)) ? 0xd0 : 0x34;
            break;
          case 16: // SD
            pg_out = (this.rm_hh_bit8 << 9)
                   | ((this.rm_hh_bit8 ^ (this.rm_noise & 1)) << 8);
            break;
          case 17: // TC
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = (rm_bit << 9) | 0x100;
            break;
          default:
            pg_out = phase >>> 9;
        }
      } else {
        pg_out = phase >>> 9;
      }
      this.pg_out = pg_out & 0xffff;
    }

    // ────────── OPLL_PhaseCalcIncrement ──────────
    _phaseCalcIncrement() {
      let freq = this.c_fnum << 1;
      const block = this.c_block;
      if (this.c_vib) {
        switch (this.lfo_vib_counter) {
          case 0: case 4: break;
          case 1: case 3: freq += freq >> 8; break;
          case 2: freq += freq >> 7; break;
          case 5: case 7: freq -= freq >> 8; break;
          case 6: freq -= freq >> 7; break;
        }
      }
      freq = (freq << block) >> 1;
      this.pg_inc = (freq * PG_MULTI[this.c_multi]) >>> 1;
    }

    // ────────── OPLL_EnvelopeKSLTL ──────────
    _envelopeKSLTL() {
      let ksl = EG_KSLTABLE[this.c_ksl_freq] - ((8 - this.c_ksl_block) << 3);
      if (ksl < 0) ksl = 0;
      ksl <<= 1;
      ksl = this.c_ksl ? (ksl >> (3 - this.c_ksl)) : 0;
      this.eg_ksltl = ksl + (this.c_tl << 1);
    }

    // ────────── OPLL_EnvelopeOutput ──────────
    _envelopeOutput() {
      let level = this.eg_level[(this.cycles + 17) % 18];
      level += this.eg_ksltl;
      if (this.c_am) level += this.lfo_am_out;
      if (level >= 128) level = 127;
      if (this.testmode & 0x01) level = 0;
      this.eg_out = level;
    }

    // ────────── OPLL_EnvelopeGenerate ──────────
    _envelopeGenerate() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;

      // --- EGタイマ ---
      let timer_inc;
      if ((this.eg_counter_state & 3) !== 3) timer_inc = 0;
      else if (this.cycles === 0) timer_inc = 1;
      else timer_inc = this.eg_timer_carry;

      const timer_low = this.eg_timer & 3;
      let timer_bit = (this.eg_timer & 1) + timer_inc;
      this.eg_timer_carry = timer_bit >> 1;
      this.eg_timer = (((timer_bit & 1) << 17) | (this.eg_timer >>> 1)) >>> 0;
      if (this.testmode & 0x08) {
        this.eg_timer &= 0x2ffff;
        this.eg_timer |= (this.write_data << (16 - 2)) & 0x10000;
      }
      if (!this.eg_timer_shift_stop && ((this.eg_timer >>> 16) & 1)) {
        this.eg_timer_shift = this.cycles;
      }
      if (this.cycles === 0 && (this.eg_counter_state_prev & 1) === 1) {
        this.eg_timer_low_lock = timer_low;
        this.eg_timer_shift_lock = this.eg_timer_shift;
        if (this.eg_timer_shift_lock > 13) this.eg_timer_shift_lock = 0;
        this.eg_timer_shift = 0;
      }
      this.eg_timer_shift_stop |= (this.eg_timer >>> 16) & 1;
      if (this.cycles === 0) this.eg_timer_shift_stop = 0;
      this.eg_counter_state_prev = this.eg_counter_state;
      if (this.cycles === 17) this.eg_counter_state = (this.eg_counter_state + 1) & 0xff;

      // --- レベル更新 ---
      const idx = (this.cycles + 16) % 18;
      const level = this.eg_level[idx];
      let next_level = level;
      const zero = (level === 0);
      this.eg_silent = (level === 0x7f) ? 1 : 0;

      if (this.eg_state[idx] !== EG_ATTACK && (this.eg_off & 2) && !(this.eg_dokon & 2)) {
        next_level = 0x7f;
      }
      if (this.eg_maxrate && (this.eg_dokon & 2)) next_level = 0x00;

      const state = this.eg_state[idx];
      let next_state = EG_ATTACK;
      let step = 0;
      const sl = this.eg_sl;

      switch (state) {
        case EG_ATTACK:
          if (!this.eg_maxrate && (this.eg_kon & 2) && !zero) {
            const shift = (this.eg_rate_hi < 12) ? this.eg_inc_lo : (this.eg_rate_hi - 11 + this.eg_inc_hi);
            if (shift > 0) step = (~level) >> (5 - shift);
          }
          next_state = zero ? EG_DECAY : EG_ATTACK;
          break;
        case EG_DECAY:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2) && (level >> 3) !== sl) {
            step = this._egStep();
          }
          next_state = ((level >> 3) === sl) ? EG_SUSTAIN : EG_DECAY;
          break;
        case EG_SUSTAIN:
        case EG_RELEASE:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2)) step = this._egStep();
          next_state = state;
          break;
      }

      if (!(this.eg_kon & 2)) next_state = EG_RELEASE;
      if (this.eg_dokon & 2) next_state = EG_ATTACK;

      this.eg_level[idx] = (next_level + step) & 0xff;
      this.eg_state[idx] = next_state;

      // --- 次サイクルぶんのレート計算 ---
      const rate_hi = this.eg_rate >> 2;
      const rate_lo = this.eg_rate & 3;
      this.eg_inc_hi = EG_STEPHI[rate_lo][this.eg_timer_low_lock];
      const sum = (this.eg_timer_shift_lock + rate_hi) & 0x0f;
      this.eg_inc_lo = 0;
      if (rate_hi < 12 && !this.eg_zerorate) {
        switch (sum) {
          case 12: this.eg_inc_lo = 1; break;
          case 13: this.eg_inc_lo = (rate_lo >> 1) & 1; break;
          case 14: this.eg_inc_lo = rate_lo & 1; break;
        }
      }
      this.eg_maxrate = (rate_hi === 0x0f) ? 1 : 0;
      this.eg_rate_hi = rate_hi;

      this.eg_kon = ((this.eg_kon << 1) | this.kon[CH_OFFSET[this.cycles]]) & 0xff;
      this.eg_off = ((this.eg_off << 1) | (((this.eg_level[this.cycles] >> 2) === 0x1f) ? 1 : 0)) & 0xff;

      switch (this.rm_select) {
        case RM_BD0: case RM_BD1: this.eg_kon |= (this.rhythm >> 4) & 1; break;
        case RM_SD:  this.eg_kon |= (this.rhythm >> 3) & 1; break;
        case RM_TOM: this.eg_kon |= (this.rhythm >> 2) & 1; break;
        case RM_TC:  this.eg_kon |= (this.rhythm >> 1) & 1; break;
        case RM_HH:  this.eg_kon |= this.rhythm & 1; break;
      }

      let rate = 0;
      this.eg_dokon = (this.eg_dokon << 1) & 0xffff;
      let state_rate = this.eg_state[this.cycles];
      if (state_rate === EG_RELEASE && (this.eg_kon & 1) && (this.eg_off & 1)) {
        state_rate = EG_ATTACK;
        this.eg_dokon |= 1;
      }
      switch (state_rate) {
        case EG_ATTACK: rate = this.c_adrr[0]; break;
        case EG_DECAY: rate = this.c_adrr[1]; break;
        case EG_SUSTAIN: if (!this.c_et) rate = this.c_adrr[2]; break;
        case EG_RELEASE: rate = this.son[CH_OFFSET[this.cycles]] ? 5 : this.c_adrr[2]; break;
      }
      if (!(this.eg_kon & 1) && !mcsel && this.rm_select !== RM_TOM && this.rm_select !== RM_HH) rate = 0;
      if ((this.eg_kon & 1) && this.eg_state[this.cycles] === EG_RELEASE && !(this.eg_off & 1)) rate = 12;
      if (!(this.eg_kon & 1) && !this.son[CH_OFFSET[this.cycles]] && mcsel === 1 && !this.c_et) rate = 7;

      this.eg_zerorate = (rate === 0) ? 1 : 0;
      let ksr = this.c_ksr_freq;
      if (!this.c_ksr) ksr >>= 2;
      this.eg_rate = (rate << 2) + ksr;
      if (this.eg_rate & 0x40) this.eg_rate = 0x3c | (ksr & 3);
      this.eg_sl = this.c_sl;
    }

    // DECAY/SUSTAIN/RELEASE共通の増分(opll.cで同じ式が2箇所に展開されているもの)
    _egStep() {
      const rh = this.eg_rate_hi, ih = this.eg_inc_hi, il = this.eg_inc_lo;
      const cs = this.eg_counter_state_prev;
      const i0 = (rh === 15 || (rh === 14 && ih)) ? 1 : 0;
      const i1 = ((rh === 14 && !ih) || (rh === 13 && ih)
        || (rh === 13 && !ih && (cs & 1))
        || (rh === 12 && ih && (cs & 1))
        || (rh === 12 && !ih && ((cs & 3) === 3))
        || (il && ((cs & 3) === 3))) ? 1 : 0;
      return (i0 << 1) | i1;
    }

    // ────────── OPLL_Channel ──────────
    _channel() {
      let ch_out = this.ch_out;
      const ismod = ((this.cycles / 3) | 0) & 1;
      const mute_m = ismod || ((this.rm_enable & 0x40) && (this.cycles + 15) % 18 >= 12);

      if (this.isDs1001) {
        this.output_m = ch_out;
        if (this.output_m >= 0) this.output_m++;
        if (mute_m) this.output_m = 0;
        this.output_r = 0;
      } else {
        let mute_r = 1;
        if (this.rm_enable & 0x40) {
          switch (this.cycles) {
            case 16: case 17: case 0: case 1: case 2:
            case 3: case 4: case 5: case 9: case 10:
              mute_r = 0; break;
          }
        }
        const sign0 = ch_out >> 8;
        let sign = sign0;
        if (ch_out >= 0) { ch_out++; sign++; }
        this.output_m = mute_m ? sign : ch_out;
        this.output_r = mute_r ? sign : ch_out;
      }

      // ── ch別ミュート/音量(実機には無い機能) ──
      // output_m / output_r は最終DAC出力なので、ここで倍率を掛けても合成には一切影響しない。
      const cm = CARRIER_CH[this.cycles];
      if (cm >= 0) {
        if (this.mute[cm]) this.output_m = 0;
        else if (this.vol[cm] !== 1) this.output_m = this.output_m * this.vol[cm];
      }
      const cr = RHYTHM_CH[this.cycles];
      if (cr >= 0 && this.output_r !== 0) {
        if (this.mute[cr]) this.output_r = 0;
        else if (this.vol[cr] !== 1) this.output_r = this.output_r * this.vol[cr];
      }
    }

    // ────────── OPLL_Operator ──────────
    _operator() {
      let ismod1, ismod2, ismod3;
      if ((this.rm_enable & 0x80) && (this.cycles === 15 || this.cycles === 16)) ismod1 = 0;
      else ismod1 = (((this.cycles + 1) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod2 = 0;
      else ismod2 = (((this.cycles + 3) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 16 || this.cycles === 17)) ismod3 = 0;
      else ismod3 = ((this.cycles / 3) | 0) & 1;

      let op_mod = 0;
      if (ismod3) op_mod |= this.op_mod << 1;
      if (ismod2 && this.c_fb) op_mod |= this.op_fbsum >> (7 - this.c_fb);

      let exp_shift = this.op_exp_s;
      if (this.eg_silent || ((this.op_neg & 2) && (ismod1 ? (this.c_dm & 4) : (this.c_dc & 4)))) {
        exp_shift |= 12;
      }

      let output = this.op_exp_m >> exp_shift;
      if (!this.eg_silent && (this.op_neg & 2)) output = ~output;

      let level = this.op_logsin + (this.eg_out << 4);
      if (level >= 4096) level = 4095;
      this.op_exp_m = EXPROM[level & 0xff];
      this.op_exp_s = level >> 8;

      let phase = (op_mod + this.pg_out) & 0x3ff;
      if (phase & 0x100) phase ^= 0xff;
      this.op_logsin = LOGSIN[phase & 0xff];
      this.op_neg = ((this.op_neg << 1) | (phase >> 9)) & 0xff;
      this.op_fbsum = (this.op_fb1[(this.cycles + 3) % 9] + this.op_fb2[(this.cycles + 3) % 9]) >> 1;

      if (ismod1) {
        this.op_fb2[this.cycles % 9] = this.op_fb1[this.cycles % 9];
        this.op_fb1[this.cycles % 9] = output;
      }
      this.op_mod = output & 0x1ff;

      let routput = 0;
      if (!this.isDs1001) {
        switch (this.cycles) {
          case 2: routput = this.ch_out_hh; break;
          case 3: routput = this.ch_out_tm; break;
          case 4: routput = this.ch_out_bd; break;
          case 8: routput = this.ch_out_sd; break;
          case 9: routput = this.ch_out_tc; break;
        }
        switch (this.cycles) {
          case 15: this.ch_out_hh = output >> 3; break;
          case 16: this.ch_out_tm = output >> 3; break;
          case 17: this.ch_out_bd = output >> 3; break;
          case 0: this.ch_out_sd = output >> 3; break;
          case 1: this.ch_out_tc = output >> 3; break;
        }
      }
      if (!(this.rm_enable & 0x80)) routput = 0;

      this.ch_out = ismod1 ? routput : (output >> 3);
    }

    // ────────── OPLL_DoRhythm / OPLL_DoLFO ──────────
    _doRhythm() {
      let nbit = (this.rm_noise ^ (this.rm_noise >>> 14)) & 0x01;
      nbit |= ((this.rm_noise === 0x00) ? 1 : 0) | ((this.testmode >> 1) & 0x01);
      this.rm_noise = ((nbit << 22) | (this.rm_noise >>> 1)) >>> 0;
    }

    _doLFO() {
      let am_inc = 0;
      if (this.cycles === 17) {
        let vib_step = (((this.lfo_counter & 0x3ff) + 1) >> 10);
        this.lfo_am_step = ((this.lfo_counter & 0x3f) + 1) >> 6;
        vib_step |= (this.testmode >> 3) & 0x01;
        this.lfo_vib_counter = (this.lfo_vib_counter + vib_step) & 0x07;
        this.lfo_counter = (this.lfo_counter + 1) & 0xffff;
      }
      if ((this.lfo_am_step || (this.testmode & 0x08)) && this.cycles < 9) {
        am_inc = this.lfo_am_dir | ((this.cycles === 0) ? 1 : 0);
      }
      if (this.cycles >= 9) this.lfo_am_car = 0;
      if (this.cycles === 0) {
        if (this.lfo_am_dir && (this.lfo_am_counter & 0x7f) === 0) this.lfo_am_dir = 0;
        else if (!this.lfo_am_dir && (this.lfo_am_counter & 0x69) === 0x69) this.lfo_am_dir = 1;
      }
      let am_bit = (this.lfo_am_counter & 0x01) + am_inc + this.lfo_am_car;
      this.lfo_am_car = am_bit >> 1;
      am_bit &= 0x01;
      this.lfo_am_counter = ((am_bit << 8) | (this.lfo_am_counter >>> 1)) & 0x1ff;

      if (this.testmode & 0x02) {
        this.lfo_vib_counter = 0;
        this.lfo_counter = 0;
        this.lfo_am_dir = 0;
        this.lfo_am_counter &= 0xff;
      }
    }

    // ────────── OPLL_Clock 1回ぶん ──────────
    _stepOpll() {
      // buffer[0]/[1] 相当。前サイクルの OPLL_Channel が確定させた値を取り込む
      this.sampleAccum += this.output_m + this.output_r;

      if (this.cycles === 0) this.lfo_am_out = (this.lfo_am_counter >> 3) & 0x0f;
      this.rm_enable = s8(this.rm_enable) >> 1;
      this._doModeWrite();
      this.rm_select++;
      if (this.rm_select > RM_TC) this.rm_select = RM_TC + 1;
      if (this.cycles === 11 && (this.rm_enable & 0x80) === 0x80) this.rm_select = RM_BD0;

      this._preparePatch1();
      this._channel();
      this._phaseGenerate();
      this._operator();
      this._phaseCalcIncrement();
      this._envelopeOutput();
      this._envelopeKSLTL();
      this._envelopeGenerate();
      this._doLFO();
      this._doRhythm();
      this._preparePatch2();
      this._doRegWrite();
      this._doIO();

      this.cycles = (this.cycles + 1) % 18;

      if (++this.sampleCycles >= CYCLES_PER_SAMPLE) {
        this.sampleCycles = 0;
        // 打楽器のピークホールド更新(1サンプルごとで十分。減衰は最短でも数千サンプル続く)
        for (let i = 0; i < 5; i++) {
          const lv = this.eg_level[RHYTHM_SLOT[i]];
          if (lv < this._rhythmPeak[i]) this._rhythmPeak[i] = lv;
        }
        // 実チップの時分割DACは無音時も基準レベル(OPLL_Channelのsign)を出し続けるため
        // 出力にDC成分が乗る。実機ではAC結合で落ちるぶんなので1次ハイパスで除去する。
        // カットオフ約5Hz。[[hes-dda-gain-clipping-fix]]の教訓で立ち上がりのオーバー
        // シュートを避けるため十分低く取っている。
        const x = this.sampleAccum;
        if (this.dcPrimed === 0) { this.dcX = x; this.dcPrimed = 1; } // 初回は段差を作らない
        this.dcY = x - this.dcX + DC_BLOCK_R * this.dcY;
        this.dcX = x;
        this.lastSample = this.dcY;
        this.sampleAccum = 0;
      }
    }

    // ────────── 書き込み ──────────
    // アドレス/データは実機同様「別々のタイミング」で入らないと取りこぼす(write_dataが共用の
    // 1バイトラッチのため)。バス経由(nsfBus/kssBus)は元々CPUサイクルが空くので問題ないが、
    // writeReg()のような即時2連書きのために最小間隔を空けるキューを通す。
    // ★キューの単位は「レジスタ書き込み1件(アドレス+データの対)」。エントリ形式は
    // reg | (data << 8)。実チップは2フェーズ(アドレスポート→データポート)だが、
    // **キュー上で対を分割してはいけない**。
    // 以前はアドレスとデータを別エントリにしていたため、「アドレスだけ先に取り出されて
    // パイプラインへ入り、データがまだキューに居るときに溢れて _drainDirect() が走る」と
    // 宙に浮いたアドレスが捨てられ、直後のデータが**アドレス無しのデータ書き込み**として
    // パイプラインに入り、そのレジスタ書き込みが丸ごと消えていた。
    // (Illusion City KSS 1曲目で実測: カスタム音色の $00 が一度も適用されず multi[0] が
    //  0 のままになり、@0 を多用する FM2/FM4 の音色が変わっていた。VGMは書き込み密度が
    //  低くて溢れないため無傷で、同じ曲なのに KSS と VGM で聞こえ方が違う原因だった)
    _pushWrite(reg, data) {
      this.writebuf.push((reg & 0x3f) | ((data & 0xff) << 8));
      // ★clock()を呼ばずに書き込みだけ流し込む経路(無音先読みスキャンの早送り
      // stream-player.js/_resetScan、kss-stream-player.js/_resetScan など)への保険。
      // 実チップ相当のウェイト間隔でしか掃けないキューに数十万件積まれると、
      // shift()がO(n)化して主スレッドごと焼き付く。上限を超えたらパイプラインを
      // 介さずレジスタへ直接反映する(そもそもclock()が無い=時間が進まない経路なので
      // サイクル精度に意味が無く、旧コアの「即時反映」と同じ挙動になる)。
      if (this.writebuf.length - this.writeHead > WRITE_QUEUE_MAX) this._drainDirect();
    }

    /** 溜まった書き込みをパイプラインを介さずレジスタへ直接反映してキューを空にする */
    _drainDirect() {
      for (let i = this.writeHead; i < this.writebuf.length; i++) {
        const w = this.writebuf[i];
        this._applyRegDirect(w & 0x3f, (w >> 8) & 0xff);
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      // 対の途中(アドレスだけ出した状態)なら先頭から出し直す。宙に浮いたアドレスは
      // 次の対が自分のアドレスを出し直すので害が無い。
      this._writePhase = 0;
    }

    /** レジスタ1本を即時反映(_doModeWrite / _doRegWrite と同じデコード) */
    _applyRegDirect(reg, d) {
      reg &= 0x3f; d &= 0xff;
      const p = this.patch;
      if (reg <= 0x07) {
        const slot = reg & 0x01;
        switch (reg) {
          case 0x00: case 0x01:
            p.multi[slot] = d & 0x0f; p.ksr[slot] = (d >> 4) & 1;
            p.et[slot] = (d >> 5) & 1; p.vib[slot] = (d >> 6) & 1; p.am[slot] = (d >> 7) & 1;
            break;
          case 0x02: p.ksl[0] = (d >> 6) & 3; p.tl = d & 0x3f; break;
          case 0x03: p.ksl[1] = (d >> 6) & 3; p.dc = (d >> 4) & 1; p.dm = (d >> 3) & 1; p.fb = d & 7; break;
          case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
          case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        }
        return;
      }
      if (reg === 0x0e) {
        this.rhythm = d & 0x3f;
        if (this.isDs1001) this.rhythm |= 0x20;
        this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
        return;
      }
      if (reg === 0x0f) { this.testmode = d & 0x0f; return; }
      const ch = reg & 0x0f;
      if (ch > 8) return;
      switch (reg & 0xf0) {
        case 0x10: this.fnum[ch] = (this.fnum[ch] & 0x100) | d; break;
        case 0x20:
          this.fnum[ch] = (this.fnum[ch] & 0xff) | ((d & 1) << 8);
          this.block[ch] = (d >> 1) & 7;
          this.kon[ch] = (d >> 4) & 1;
          this.son[ch] = (d >> 5) & 1;
          break;
        case 0x30: this.regVol[ch] = d & 0x0f; this.inst[ch] = (d >> 4) & 0x0f; break;
      }
    }

    // 先頭の1件を実チップと同じ2フェーズ(アドレス→データ)へ展開して流す。
    // _writePhase が対の途中を表すので、キューから取り出すのはデータを出す時だけ。
    _pumpWrites() {
      if (this.writeHead >= this.writebuf.length) return;
      if (this.writeDelay > 0) { this.writeDelay--; return; }
      const w = this.writebuf[this.writeHead];
      if (this._writePhase === 0) {
        this.write_data = w & 0x3f;   // アドレスフェーズ
        this.write_a |= 1;
        this._writePhase = 1;
        this.writeDelay = WRITE_GAP_ADDR;
      } else {
        this.write_data = (w >> 8) & 0xff; // データフェーズ
        this.write_d |= 1;
        this._writePhase = 0;
        this.writeHead++;
        if (this.writeHead > 1024 && this.writeHead * 2 > this.writebuf.length) {
          this.writebuf = this.writebuf.slice(this.writeHead); this.writeHead = 0; // たまに詰める
        }
        this.writeDelay = WRITE_GAP_DATA;
      }
    }

    /** レジスタ番号を直接指定して書く(VGM / テスト用) */
    writeReg(reg, data) {
      reg &= 0x3f; data &= 0xff;
      this.regShadow[reg] = data;
      this._addrLatch = reg;
      this._pushWrite(reg, data);
    }

    /** VRC7のNSFバス: $9010=アドレス, $9030=データ */
    writeRegister(addr, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (addr === 0x9010) { this._addrLatch = value & 0x3f; }
      else if (addr === 0x9030) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** FMPACのMSX I/Oポート: 0x7C=アドレス, 0x7D=データ */
    ioWrite(port, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (port === 0x7C) { this._addrLatch = value & 0x3f; }
      else if (port === 0x7D) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** ホストクロック1サイクル。hostPerOpll個で内部1サイクル進む */
    clock() {
      if (++this.hostAccum < this.hostPerOpll) return;
      this.hostAccum = 0;
      this._pumpWrites();
      this._stepOpll();
    }

    /**
     * clock()を回さない経路(regsOnlyキャプチャ等)で溜まった書き込みを反映させる。
     * [[capture-worker-plan]] のym2612Nuked.flushWrites()と同じ用途。
     */
    flushWrites() {
      let guard = 0;
      while (this.writeHead < this.writebuf.length && guard++ < 1000000) this.clock();
      for (let i = 0; i < this.hostPerOpll * CYCLES_PER_SAMPLE * 2; i++) this.clock();
    }

    mixSample() { return this.lastSample * OUTPUT_GAIN; }

    get rhythmMode() { return !this.isDs1001 && !!(this.rhythm & 0x20); }

    // ────────── 鍵盤表示用スナップショット ──────────
    // 実機のレジスタ影から音色パラメータを取り出し、波形は「今のパラメータでの概形」を
    // 再合成する(時分割パイプラインは模擬しない)。ym2612Nuked.js の nukedSynthWave と同方針。
    _patchOf(ch) {
      const instr = this.inst[ch];
      return instr > 0 ? this.patchrom[instr - 1] : this.patch;
    }

    _dumpPatch(ch) {
      const p = this._patchOf(ch);
      return {
        type: 'opll', inst: this.inst[ch],
        mod: { AM: p.am[0], PM: p.vib[0], EG: p.et[0], KR: p.ksr[0], ML: p.multi[0],
               KL: p.ksl[0], TL: p.tl, FB: p.fb, WF: p.dm,
               AR: p.ar[0], DR: p.dr[0], SL: p.sl[0], RR: p.rr[0] },
        car: { AM: p.am[1], PM: p.vib[1], EG: p.et[1], KR: p.ksr[1], ML: p.multi[1],
               KL: p.ksl[1], TL: 0, FB: 0, WF: p.dc,
               AR: p.ar[1], DR: p.dr[1], SL: p.sl[1], RR: p.rr[1] }
      };
    }

    /** 1周期ぶんのFM波形(-1..1, N点)。egは現在値を使う */
    _synthWave(ch, N) {
      const p = this._patchOf(ch);
      const modEg = this.eg_level[SLOT_MOD[ch]] + (p.tl << 1);
      const carEg = this.eg_level[SLOT_CAR[ch]] + (this.regVol[ch] << 3);
      const ratio = PG_MULTI[p.multi[0]] / (PG_MULTI[p.multi[1]] || 1);
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const mp = Math.round((k / N) * ratio * 1024) & 0x3ff;
        const mo = opOut(mp, modEg, p.dm);
        const cp = (Math.round((k / N) * 1024) + (mo >> 0)) & 0x3ff;
        const co = opOut(cp, carEg, p.dc);
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      return wave;
    }

    _melodySnapshot(ch, N) {
      const fnum = this.fnum[ch], block = this.block[ch];
      const carLevel = this.eg_level[SLOT_CAR[ch]];
      const active = !!this.kon[ch] && carLevel < 0x7f;
      return {
        freq: (this.kon[ch] && fnum > 0) ? SAMPLE_RATE * fnum / Math.pow(2, 19 - block) : 0,
        vol: (15 - this.regVol[ch]) / 15,
        rawVol: this.regVol[ch],
        instrument: this.inst[ch],
        active,
        waveData: active ? this._synthWave(ch, N) : new Array(N).fill(0),
        patch: this._dumpPatch(ch)
      };
    }

    // ★2026-08-22: 打楽器はピークホールドで返す。
    // 鍵盤表示はrAF(約16ms間隔)でスナップショットを読むが、チップはオーディオバッファ単位
    // (ScriptProcessorNodeで50〜90ms)にまとめて進むため、瞬時値だけ見ると短い打楽器の
    // 減衰がサンプリングの隙間に丸ごと落ちる。実測: Aleste Gaiden 7曲目のBDは約50msで
    // 減衰しきり(eg_level 16→33→96→127)、鍵盤のBD行が一度も点灯しなかった
    // (SDは減衰が緩いので見えていた)。前回読んだ時点以降の最小レベル(=最大音量)を保持する。
    _rhythmSlotInfo(peakIdx, slotIdx, freq) {
      const now = this.eg_level[slotIdx];
      const level = Math.min(this._rhythmPeak[peakIdx], now);
      this._rhythmPeak[peakIdx] = now; // 次の窓は現在値から測り直す
      return { freq, active: level < 0x7f, vol: (0x7f - level) / 0x7f };
    }

    snapshot() {
      const N = 128;
      if (this.isDs1001) {
        const out = [];
        for (let i = 0; i < 6; i++) out.push(this._melodySnapshot(i, N));
        return out;
      }
      // ★2026-08-22: melody は常に9本、rhythm も常に付けて返す。
      // リズムモードのビット($0E bit5)を「打つ瞬間だけ立てて即降ろす」ドライバが実在し
      // (SMS版After Burnerは毎秒10〜16回トグル)、返す形をビットに追随させると鍵盤の
      // 行構成が激しく入れ替わって読めなくなる。どちらを表示するかは表示側(keyboard.js)が
      // 「一度リズムを見たら以後保持」する単調な運用で決める。
      const rhythmMode = this.rhythmMode;
      const melody = [];
      for (let i = 0; i < 9; i++) melody.push(this._melodySnapshot(i, N));

      const f = (ch) => this.fnum[ch] > 0 ? SAMPLE_RATE * this.fnum[ch] / Math.pow(2, 19 - this.block[ch]) : 0;
      return {
        rhythmMode,
        melody,
        rhythm: {
          bd:  this._rhythmSlotInfo(0, RHYTHM_SLOT[0], f(6)),
          sd:  this._rhythmSlotInfo(1, RHYTHM_SLOT[1], 0),
          tom: this._rhythmSlotInfo(2, RHYTHM_SLOT[2], f(8)),
          cym: this._rhythmSlotInfo(3, RHYTHM_SLOT[3], 0),
          hh:  this._rhythmSlotInfo(4, RHYTHM_SLOT[4], 0)
        }
      };
    }
  }

  // 書き込みキューの最小間隔(内部サイクル)。実チップのウェイト仕様に対応する。
  //  - アドレス書き込み後: write_dataラッチを取り合わないよう数サイクル空ければよい。
  //  - データ書き込み後  : ★18以上必須。FMレジスタ($10/$20/$30系)は _doRegWrite が
  //    「(address&0x0f) == cycles」の1サイクルでしか反映しないため、次のアドレス書き込みが
  //    write_fm_data を落とす前に18サイクル(全cycles値)を一巡させないと書き込みが消える。
  //    実機YM2413のデータ書き込み後ウェイト84マスタサイクル(=21内部サイクル)とも符合する。
  // キュー上限。超えたら直接反映へ切り替える(_pushWrite のコメント参照)
  // ★キュー上限は「実ドライバの通常の書き込みバーストでは絶対に届かない」値にすること。
  // 32では実測でIllusion City(KSS)の通常再生中に80フレームで95回も直接反映が発動し、
  // 実チップのウェイトを踏んだ書き込みタイミングが壊れてFM2の音が変わっていた
  // (直接反映を止めるとVGM経路と完全一致した)。KSSのOPLL書き込みは最大74件/フレーム。
  // 取り出しは writeHead 方式(shift不使用)なので、キューが長くても取り出しコストは一定。
  // ここが効くのは clock() が呼ばれない早送り経路だけで、そこは数万〜数十万件積まれる。
  const WRITE_QUEUE_MAX = 4096;
  const WRITE_GAP_ADDR = 4;
  const WRITE_GAP_DATA = 20;

  // 出力ゲイン。旧コア(emu2413移植)とラウドネスを揃えるための実測較正値。
  // 新コアの生の出力は「18サイクルぶんの時分割DAC出力の総和」。@1/@4/@8/@12/@15
  // を単音で鳴らしてRMSを旧コアと突き合わせ、平均比が1.0になるよう決めた(音色ごとの比は
  // 0.4〜1.2とばらつく。コアが違えばEG/出力段が違うので一致はしない)
  // ([[emu-loudness-balance-and-master-volume]] のフォーマット間バランスを崩さないため)。
  const OUTPUT_GAIN = 1 / 2000;

  // DC遮断フィルタ係数(1 - 2π*5Hz/49716)
  const DC_BLOCK_R = 0.99937;

  // 波形プレビュー用の1オペレータ出力(実機と同じ対数sin→exp経路)
  function opOut(phase10, egLevel, halfWave) {
    let phase = phase10 & 0x3ff;
    const neg = (phase >> 9) & 1;
    if (phase & 0x100) phase ^= 0xff;
    let level = LOGSIN[phase & 0xff] + (Math.min(127, egLevel) << 4);
    if (level >= 4096) level = 4095;
    const out = EXPROM[level & 0xff] >> (level >> 8);
    if (halfWave && neg) return 0;
    return neg ? ~out : out;
  }

  // 音色エディタの逆算(src/ui/vrc7ToneSolver.js)が定常状態の1周期を実機と同じ演算で
  // 作るために使う。LOGSIN/EXPROM表そのものは外へ出さない(表を持ち出すと写しがずれる)
  OPLLNuked.opOut = opOut;

  // 内蔵音色ROMをレジスタ$00-$07と同じ8バイト並びで返す(type: 'ym2413' | 'ds1001'(VRC7)、inst 1-15)。
  // 変換側(src/convert/toneDerive.js)が「YM2413のプリセット音色の波形」をN163等へ写すときに使う。
  // ★VRC7(ds1001)側の写しは src/convert/vrc7Tone.js PRESETS にもある(Workerバンドル都合の複製)
  OPLLNuked.presetBytes = function (type, inst) {
    const rom = type === 'ds1001' ? PATCH_DS1001 : PATCH_YM2413;
    const p = rom[(inst | 0) - 1];
    if (!p) return null;
    const b20 = (i) => (p.am[i] << 7) | (p.vib[i] << 6) | (p.et[i] << 5) | (p.ksr[i] << 4) | (p.multi[i] & 15);
    return [
      b20(0), b20(1),
      ((p.ksl[0] & 3) << 6) | (p.tl & 63),
      ((p.ksl[1] & 3) << 6) | ((p.dc & 1) << 4) | ((p.dm & 1) << 3) | (p.fb & 7),
      (p.ar[0] << 4) | p.dr[0], (p.ar[1] << 4) | p.dr[1],
      (p.sl[0] << 4) | p.rr[0], (p.sl[1] << 4) | p.rr[1]
    ];
  };

  Emu.OPLLNuked = OPLLNuked;
})(globalThis);

/*
 * FMPAC(MSX-MUSIC) 拡張音源エミュレータ (OPLL / YM2413)
 * MML.Emu.OPLLAudio
 *
 * ★2026-08-22: 既定の再生コアは opllNuked.js (Nuked-OPLL移植) に移行した。このファイルの
 * 実装は MML.Emu.OPLL_CORE = 'emu2413' を指定したときのA/B比較用として残してある。
 *
 * src/emulator/expansion/vrc7.js のOPLLコア(Mitsutaka Okazaki emu2413移植)をそのまま
 * 流用し、バス面のみMSX実機のFMPAC I/Oポート(0x7C=アドレス, 0x7D=データ)に置き換えている。
 * VRC7とFMPACはハードウェア的に同一のYM2413(OPLL)であるため、DSPコアは変更していない。
 * 出力49716Hz。clock()はOPLLマスタクロック(=MSXでは3.579545MHz、Z80と同一)基準で
 * 呼ばれるため分周は72(3579545/72=49716)。★VRC7(vrc7.js)はNES CPUクロック1.79MHz
 * =マスタの半分を渡される設計なので分周36。両者で定数が違うのは正しい。
 *
 * ノイズ合成(short_noise)アルゴリズムは digital-sound-antiques/emu2413
 * (MIT License, Copyright (c) 2001-2019 Mitsutaka Okazaki) の emu2413.c を参照して移植。
 * 音色ROM(メロディ15音色・リズム3音色)は nukeykt/Nuked-OPLL (GPLv2) の patch_ym2413
 * = YM2413実チップの die shot 読み出し値。本リポジトリもGPLv2。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // FMPAC(YM2413)は9メロディチャンネル。リズムモード時はch6-8が
  // BD(ch6両slot)/HH+SD(ch7 mod+car)/TOM+CYM(ch8 mod+car)に化ける。
  // VRC7(6ch専用・リズムモード無し)から移植したコアをここで9ch+リズム対応に拡張している。
  const NUM_CH = 9;
  // ミュート/音量の添字: 0-8=メロディch, 9-13=リズム(BD,SD,TOM,CYM,HH)。
  // SDとHH(TOMとCYM)は実機では同じchだが鍵盤には別行で出るため、実ch単位の添字だと
  // getMuteConfig()の書き込み順で片方が無視される(opllNuked.js RHYTHM_CH のコメント参照)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14;
  const CYCLES_PER_SAMPLE = 72; // ★2026-08-22: 36は誤り(1オクターブ高かった)。ファイル冒頭コメント参照
  const SAMPLE_RATE = 49716;

  const PG_BITS = 10, PG_WIDTH = 1 << PG_BITS; // emu2413本家に合わせて9→10bit化
  const DP_BITS = 19, DP_WIDTH = 1 << DP_BITS, DP_BASE_BITS = DP_BITS - PG_BITS;
  const DB_STEP = 0.375, DB_BITS = 7, DB_MUTE = 1 << DB_BITS;
  const EG_STEP = 0.375, EG_BITS = 7;
  const EG2DB = 1;
  const TL2EG = 2;
  const DB2LIN_AMP_BITS = 10, SLOT_AMP_BITS = DB2LIN_AMP_BITS;
  const EG_DP_BITS = 22, EG_DP_WIDTH = 1 << EG_DP_BITS;
  const PM_PG_BITS = 8, PM_PG_WIDTH = 1 << PM_PG_BITS;
  const PM_DP_BITS = 16, PM_DP_WIDTH = 1 << PM_DP_BITS;
  const AM_PG_BITS = 8, AM_PG_WIDTH = 1 << AM_PG_BITS;
  const AM_DP_BITS = 16, AM_DP_WIDTH = 1 << AM_DP_BITS;
  const PM_AMP_BITS = 8, PM_AMP = 1 << PM_AMP_BITS;
  const PM_SPEED = 6.4, PM_DEPTH = 13.75, AM_SPEED = 3.7, AM_DEPTH = 4.8;

  const SETTLE = 0, ATTACK = 1, DECAY = 2, SUSHOLD = 3, SUSTINE = 4, RELEASE = 5, FINISH = 6;

  // 音色ROM(YM2413本来の内蔵15音色)。
  // ★2026-08-22: emu2413本家(2413tone.h)の値から、nukeykt/Nuked-OPLL の patch_ym2413 へ
  // 差し替え。emu2413のROM値は本家Wikiが "Estimated ROM Instruments" と明記している通り
  // YM2413B実機録音からの耳コピ推定だが、Nuked-OPLL のものは decap/die shot
  // (siliconpr0n: digshadow, John McMaster)から読み出したROM内容そのもの。
  // 同じ経緯で vrc7.js の VRC7(DS1001)側テーブルも patch_ds1001 へ差し替え済み。
  // ★2026-08-02(履歴): それ以前はVirtuaNESのvrc7tone.h(=VRC7固有ROM)を「FMPAC/YM2413も
  // 同一ROM」という誤った前提で流用していた。VRC7とYM2413のROMは別物。
  const OPLL_INST = [
    [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // 0: ユーザー音色枠(@0所定値なし)
    [0x71,0x61,0x1e,0x17,0xd0,0x78,0x00,0x17], // 1: Violin
    [0x13,0x41,0x1a,0x0d,0xd8,0xf7,0x23,0x13], // 2: Guitar
    [0x13,0x01,0x99,0x00,0xf2,0xc4,0x11,0x23], // 3: Piano
    [0x31,0x61,0x0e,0x07,0xa8,0x64,0x70,0x27], // 4: Flute
    [0x32,0x21,0x1e,0x06,0xe0,0x76,0x00,0x28], // 5: Clarinet
    [0x31,0x22,0x16,0x05,0xe0,0x71,0x00,0x18], // 6: Oboe
    [0x21,0x61,0x1d,0x07,0x82,0x81,0x10,0x07], // 7: Trumpet
    [0x23,0x21,0x2d,0x14,0xa2,0x72,0x00,0x07], // 8: Organ
    [0x61,0x61,0x1b,0x06,0x64,0x65,0x10,0x17], // 9: Horn
    [0x41,0x61,0x0b,0x18,0x85,0xf7,0x71,0x07], // 10: Synthesizer
    [0x13,0x01,0x83,0x11,0xfa,0xe4,0x10,0x04], // 11: Harpsichord
    [0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12], // 12: Vibraphone
    [0x61,0x50,0x0c,0x05,0xc2,0xf5,0x20,0x42], // 13: Synth Bass
    [0x01,0x01,0x55,0x03,0xc9,0x95,0x03,0x02], // 14: Acoustic Bass
    [0x61,0x41,0x89,0x03,0xf1,0xe4,0x40,0x13]  // 15: Electric Guitar
  ];

  function dump2patch(d) {
    return {
      mod: { AM:(d[0]>>7)&1, PM:(d[0]>>6)&1, EG:(d[0]>>5)&1, KR:(d[0]>>4)&1, ML:d[0]&15,
             KL:(d[2]>>6)&3, TL:d[2]&63, FB:d[3]&7, WF:(d[3]>>3)&1,
             AR:(d[4]>>4)&15, DR:d[4]&15, SL:(d[6]>>4)&15, RR:d[6]&15 },
      car: { AM:(d[1]>>7)&1, PM:(d[1]>>6)&1, EG:(d[1]>>5)&1, KR:(d[1]>>4)&1, ML:d[1]&15,
             KL:(d[3]>>6)&3, TL:0, FB:0, WF:(d[3]>>4)&1,
             AR:(d[5]>>4)&15, DR:d[5]&15, SL:(d[7]>>4)&15, RR:d[7]&15 }
    };
  }
  const PATCH = OPLL_INST.map(dump2patch);

  // リズム音色。★2026-08-22: メロディ音色と同じく Nuked-OPLL の patch_ym2413 由来の
  // die shot 読み出し値へ差し替え。Nuked側はドラムをmod半分(drum_0..2)とcar半分
  // (drum_3..5)に分けて持つので、$00-$07 の8バイト形式へは対になる2エントリをORして復元
  // (BDの結果 01 01 18 0F DF F8 6A 6D は NESdev Wiki "VRC7 audio" のドラム表とも一致)。
  const RHYTHM_PATCH_BD  = dump2patch([0x01, 0x01, 0x18, 0x0f, 0xdf, 0xf8, 0x6a, 0x6d]);
  const RHYTHM_PATCH_HHSD = dump2patch([0x01, 0x01, 0x00, 0x00, 0xc8, 0xd8, 0xa7, 0x48]);
  const RHYTHM_PATCH_TOMCYM = dump2patch([0x05, 0x01, 0x00, 0x00, 0xf8, 0xaa, 0x59, 0x55]);

  function Min(a, b) { return a < b ? a : b; }

  const AR_ADJUST = new Uint32Array(1 << EG_BITS);
  AR_ADJUST[0] = 1 << EG_BITS;
  for (let i = 1; i < 128; i++)
    AR_ADJUST[i] = ((1 << EG_BITS) - 1 - (1 << EG_BITS) * Math.log(i) / Math.log(128)) | 0;

  const DB2LIN = new Int32Array((DB_MUTE + DB_MUTE) * 2);
  for (let i = 0; i < DB_MUTE + DB_MUTE; i++) {
    let v = (((1 << DB2LIN_AMP_BITS) - 1) * Math.pow(10, -i * DB_STEP / 20)) | 0;
    if (i >= DB_MUTE) v = 0;
    DB2LIN[i] = v;
    DB2LIN[i + DB_MUTE + DB_MUTE] = -v;
  }

  function lin2db(d) {
    if (d === 0) return DB_MUTE - 1;
    return Min(-(((20.0 * Math.log10(d)) / DB_STEP) | 0), DB_MUTE - 1);
  }

  const fullsin = new Uint32Array(PG_WIDTH);
  const halfsin = new Uint32Array(PG_WIDTH);
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[i] = lin2db(Math.sin(2.0 * Math.PI * i / PG_WIDTH));
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[PG_WIDTH / 2 - 1 - i] = fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) fullsin[PG_WIDTH / 2 + i] = DB_MUTE + DB_MUTE + fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) halfsin[i] = fullsin[i];
  for (let i = PG_WIDTH / 2; i < PG_WIDTH; i++) halfsin[i] = fullsin[0];
  const WAVEFORM = [fullsin, halfsin];

  const pmtable = new Int32Array(PM_PG_WIDTH);
  for (let i = 0; i < PM_PG_WIDTH; i++)
    pmtable[i] = (PM_AMP * Math.pow(2, PM_DEPTH * Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH) / 1200)) | 0;
  const amtable = new Int32Array(AM_PG_WIDTH);
  for (let i = 0; i < AM_PG_WIDTH; i++)
    amtable[i] = (AM_DEPTH / 2 / DB_STEP * (1.0 + Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH))) | 0;

  const MLT = [1, 1*2, 2*2, 3*2, 4*2, 5*2, 6*2, 7*2, 8*2, 9*2, 10*2, 10*2, 12*2, 12*2, 15*2, 15*2];
  const dphaseTable = [];
  for (let fnum = 0; fnum < 512; fnum++) {
    const a = []; dphaseTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Uint32Array(16); a.push(b);
      for (let ML = 0; ML < 16; ML++)
        b[ML] = (((fnum * MLT[ML]) << block) >> (20 - DP_BITS)) >>> 0;
    }
  }

  const KL_DB2 = [0.000,9.000,12.000,13.875,15.000,16.125,16.875,17.625,18.000,18.750,19.125,19.500,19.875,20.250,20.625,21.000].map(x => (x * 2) | 0);
  const tllTable = [];
  for (let fnum = 0; fnum < 16; fnum++) {
    const a = []; tllTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = []; a.push(b);
      for (let TL = 0; TL < 64; TL++) {
        const c = new Uint32Array(4); b.push(c);
        for (let KL = 0; KL < 4; KL++) {
          if (KL === 0) c[KL] = (TL2EG * TL) >>> 0;
          else {
            const tmp = KL_DB2[fnum] - (3 * 2) * (7 - block);
            if (tmp <= 0) c[KL] = (TL2EG * TL) >>> 0;
            else c[KL] = (((tmp >> (3 - KL)) / EG_STEP) | 0) + TL2EG * TL;
          }
        }
      }
    }
  }

  const rksTable = [];
  for (let f8 = 0; f8 < 2; f8++) {
    const a = []; rksTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Int32Array(2); a.push(b);
      b[0] = block >> 1;
      b[1] = (block << 1) + f8;
    }
  }

  const dphaseARTable = [], dphaseDRTable = [];
  for (let AR = 0; AR < 16; AR++) {
    const a = new Uint32Array(16); dphaseARTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = AR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (AR === 0) a[Rks] = 0;
      else if (AR === 15) a[Rks] = EG_DP_WIDTH;
      else a[Rks] = ((3 * (RL + 4)) << (RM + 1)) >>> 0;
    }
  }
  for (let DR = 0; DR < 16; DR++) {
    const a = new Uint32Array(16); dphaseDRTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = DR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (DR === 0) a[Rks] = 0;
      else a[Rks] = ((RL + 4) << (RM - 1)) >>> 0;
    }
  }

  const SL_DB = [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,48];
  const SL = new Uint32Array(16);
  for (let i = 0; i < 16; i++) SL[i] = ((((SL_DB[i] / 3.0) * 8) | 0) << (EG_DP_BITS - EG_BITS)) >>> 0;

  const pm_dphase = ((PM_SPEED * PM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;
  const am_dphase = ((AM_SPEED * AM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;

  class Slot {
    constructor(type) {
      this.type = type;
      this.patch = PATCH[0].mod;
      this.reset();
    }
    reset() {
      this.sintbl = WAVEFORM[0];
      this.phase = 0; this.dphase = 0; this.pgout = 0;
      this.output = [0, 0]; this.feedback = 0;
      this.eg_mode = SETTLE; this.eg_phase = EG_DP_WIDTH; this.eg_dphase = 0; this.egout = 0;
      this.fnum = 0; this.block = 0; this.volume = 0; this.sustine = 0;
      this.tll = 0; this.rks = 0;
    }
    calcEgDphase() {
      const p = this.patch;
      switch (this.eg_mode) {
        case ATTACK: return dphaseARTable[p.AR][this.rks];
        case DECAY: return dphaseDRTable[p.DR][this.rks];
        case SUSHOLD: return 0;
        case SUSTINE: return dphaseDRTable[p.RR][this.rks];
        case RELEASE:
          if (this.sustine) return dphaseDRTable[5][this.rks];
          else if (p.EG) return dphaseDRTable[p.RR][this.rks];
          else return dphaseDRTable[7][this.rks];
        default: return 0;
      }
    }
    updatePG() { this.dphase = dphaseTable[this.fnum][this.block][this.patch.ML]; }
    updateTLL() {
      this.tll = (this.type === 0)
        ? tllTable[this.fnum >> 5][this.block][this.patch.TL][this.patch.KL]
        : tllTable[this.fnum >> 5][this.block][this.volume][this.patch.KL];
    }
    updateRKS() { this.rks = rksTable[this.fnum >> 8][this.block][this.patch.KR]; }
    updateWF() { this.sintbl = WAVEFORM[this.patch.WF]; }
    updateEG() { this.eg_dphase = this.calcEgDphase(); }
    updateAll() { this.updatePG(); this.updateTLL(); this.updateRKS(); this.updateWF(); this.updateEG(); }
    slotOn() { this.eg_mode = ATTACK; this.phase = 0; this.eg_phase = 0; }
    slotOff() {
      if (this.eg_mode === ATTACK)
        this.eg_phase = (AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F] << (EG_DP_BITS - EG_BITS)) >>> 0;
      this.eg_mode = RELEASE;
    }
    calcPhase(lfo_pm) {
      if (this.patch.PM) this.phase = (this.phase + (((this.dphase * lfo_pm) >> PM_AMP_BITS) >>> 0)) >>> 0;
      else this.phase = (this.phase + this.dphase) >>> 0;
      this.phase &= (DP_WIDTH - 1);
      this.pgout = this.phase >>> DP_BASE_BITS;
      return this.pgout;
    }
    calcEnvelope(lfo_am) {
      let egout;
      switch (this.eg_mode) {
        case ATTACK:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          if (this.eg_phase & EG_DP_WIDTH) { egout = 0; this.eg_phase = 0; this.eg_mode = DECAY; this.updateEG(); }
          else egout = AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F];
          break;
        case DECAY:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.eg_phase >= SL[this.patch.SL]) {
            this.eg_phase = SL[this.patch.SL];
            this.eg_mode = this.patch.EG ? SUSHOLD : SUSTINE;
            this.updateEG();
            egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          }
          break;
        case SUSHOLD:
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.patch.EG === 0) { this.eg_mode = SUSTINE; this.updateEG(); }
          break;
        case SUSTINE:
        case RELEASE:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (egout >= (1 << EG_BITS)) { this.eg_mode = FINISH; egout = (1 << EG_BITS) - 1; }
          break;
        case FINISH: default:
          egout = (1 << EG_BITS) - 1;
          break;
      }
      egout = this.patch.AM ? (EG2DB * (egout + this.tll) + lfo_am) : (EG2DB * (egout + this.tll));
      if (egout >= DB_MUTE) egout = DB_MUTE - 1;
      this.egout = egout;
      return egout;
    }
  }

  // emu2413本家 calc_slot_car: modOut = 2*(fm>>1) (fmのLSBを切り捨てるだけで倍化はしない)
  function modToCarPhase(fm) { return 2 * (fm >> 1); }

  // emu2413.c の _PD マクロ: リズム位相定数は10bit(PG_BITS=10)テーブル基準の値。
  // 自前のPG_BITSも10なので通常は恒等変換だが、将来PG_BITSを変える場合に備え式のまま残す。
  function PD(phase) {
    return ((PG_BITS < 10 ? phase >> (10 - PG_BITS) : phase << (PG_BITS - 10)) & (PG_WIDTH - 1));
  }

  function rhythmOut(slot, egout, pgout) {
    if (egout >= DB_MUTE - 1) return 0;
    return DB2LIN[slot.sintbl[pgout] + egout];
  }

  class OpllChannel {
    constructor() {
      this.mod = new Slot(0);
      this.car = new Slot(1);
      this.patchNumber = 0;
      this.keyStatus = 0;
    }
    reset() { this.mod.reset(); this.car.reset(); this.keyStatus = 0; }

    calcModulator(lfo_am, lfo_pm) {
      const s = this.mod;
      s.output[1] = s.output[0];
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) s.output[0] = 0;
      else if (s.patch.FB !== 0) {
        // emu2413本家: fm = (output[1]+output[0]) >> (9-FB)。s.feedbackは(output[1]+output[0])>>1で
        // 既に1bitシフト済みのため、ここでのシフト量は(9-FB)-1 = (8-FB)。
        const fm = (s.feedback) >> (8 - s.patch.FB);
        s.output[0] = DB2LIN[s.sintbl[(pgout + fm) & (PG_WIDTH - 1)] + egout];
      } else {
        s.output[0] = DB2LIN[s.sintbl[pgout] + egout];
      }
      // s.feedbackは自己変調(次回calcModulator呼び出し時のfm計算)専用。キャリアへ渡すのは
      // emu2413本家同様、平均化前の生のoutput[0]。
      s.feedback = (s.output[1] + s.output[0]) >> 1;
      return s.output[0];
    }
    calcCarrier(fm, lfo_am, lfo_pm) {
      const s = this.car;
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) return 0;
      return DB2LIN[s.sintbl[(pgout + modToCarPhase(fm)) & (PG_WIDTH - 1)] + egout];
    }
  }

  class OPLLAudio {
    constructor(opts) {
      // ★2026-08-22: 既定ではNuked-OPLLコア(opllNuked.js)へ委譲する。
      // MML.Emu.OPLL_CORE = 'emu2413' を指定するとこの下の旧コア(emu2413 0.6x系移植)に戻る。
      // opts.core === 'legacy' でもこの下の旧コアになる。無音自動送りの先読みスキャンのように
      // 「音が鳴っているかどうかしか見ない」用途では、サイクルアキュレートである必要が無い一方
      // 主スレッドを食うため軽い方を明示的に選ぶ(kss-stream-player.js _scanBuildChips参照)。
      const useNuked = !(opts && opts.core === 'legacy') && Emu.OPLL_CORE !== 'emu2413' && Emu.OPLLNuked;
      if (useNuked) return new Emu.OPLLNuked({ chipType: 'ym2413' });
      this._init(); this.mute = new Array(NUM_MUTE_SLOTS).fill(false); this.vol = new Array(NUM_MUTE_SLOTS).fill(1); }
    _init() {
      this.addr = 0;
      this.reg = new Uint8Array(0x40);
      this.patches = [];
      for (let i = 0; i < 16; i++) this.patches.push({ mod: Object.assign({}, PATCH[i].mod), car: Object.assign({}, PATCH[i].car) });
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) { const c = new OpllChannel(); this.channels.push(c); this._setPatch(i, 0); }
      this.pm_phase = 0; this.am_phase = 0; this.lfo_pm = 0; this.lfo_am = 0;
      this.cyc = 0; this.lastSample = 0;
      this.rhythmMode = false;
      this.noiseLfsr = 1;
    }
    reset() { this._init(); }

    _setPatch(i, num) {
      const c = this.channels[i];
      c.patchNumber = num;
      c.mod.patch = this.patches[num].mod;
      c.car.patch = this.patches[num].car;
    }

    // port: 0x7C=アドレス, 0x7D=データ (FMPAC/MSX-MUSIC)
    ioWrite(port, value) {
      value &= 0xFF;
      if (port === 0x7C) this.addr = value & 0x3F;
      else if (port === 0x7D) this.writeReg(this.addr, value);
    }

    writeReg(reg, data) {
      reg &= 0x3F; data &= 0xFF;
      const cust = this.patches[0];
      if (reg <= 0x07) {
        switch (reg) {
          case 0x00: cust.mod.AM=(data>>7)&1; cust.mod.PM=(data>>6)&1; cust.mod.EG=(data>>5)&1; cust.mod.KR=(data>>4)&1; cust.mod.ML=data&15; break;
          case 0x01: cust.car.AM=(data>>7)&1; cust.car.PM=(data>>6)&1; cust.car.EG=(data>>5)&1; cust.car.KR=(data>>4)&1; cust.car.ML=data&15; break;
          case 0x02: cust.mod.KL=(data>>6)&3; cust.mod.TL=data&63; break;
          case 0x03: cust.car.KL=(data>>6)&3; cust.car.WF=(data>>4)&1; cust.mod.WF=(data>>3)&1; cust.mod.FB=data&7; break;
          case 0x04: cust.mod.AR=(data>>4)&15; cust.mod.DR=data&15; break;
          case 0x05: cust.car.AR=(data>>4)&15; cust.car.DR=data&15; break;
          case 0x06: cust.mod.SL=(data>>4)&15; cust.mod.RR=data&15; break;
          case 0x07: cust.car.SL=(data>>4)&15; cust.car.RR=data&15; break;
        }
        for (let i = 0; i < NUM_CH; i++) if (this.channels[i].patchNumber === 0) { this.channels[i].mod.updateAll(); this.channels[i].car.updateAll(); }
      } else if (reg === 0x0E) {
        this._writeRhythmReg(data);
      } else if (reg >= 0x10 && reg <= 0x18) {
        const ch = reg - 0x10, c = this.channels[ch];
        const fnum = data + ((this.reg[0x20 + ch] & 1) << 8);
        c.mod.fnum = c.car.fnum = fnum;
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x20 && reg <= 0x28) {
        const ch = reg - 0x20, c = this.channels[ch];
        const fnum = ((data & 1) << 8) + this.reg[0x10 + ch];
        const block = (data >> 1) & 7;
        c.mod.fnum = c.car.fnum = fnum; c.mod.block = c.car.block = block;
        if ((this.reg[reg] ^ data) & 0x20) { c.car.sustine = (data >> 5) & 1; }
        // リズムモード中のch6-8はキーオン/オフを0x0Eのビットで行うため、ここでは無視する
        // (周波数/ブロックの更新自体はBD/TOM等のピッチに使うので常に行う)。
        if (!(this.rhythmMode && ch >= 6)) {
          const key = (data & 0x10) !== 0;
          if (key) { if (!c.keyStatus) { c.mod.slotOn(); c.car.slotOn(); } c.keyStatus = 1; }
          else { if (c.keyStatus) c.car.slotOff(); c.keyStatus = 0; }
        }
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x30 && reg <= 0x38) {
        // emu2413.c OPLL_writeReg(): リズムモード中のch7/8上位ニブルはHH/TOMの音量(mod側の
        // TLLをTLでなくvolumeから引く、cf. mod.type=1切替はrhythmMode切替時)。
        // 下位ニブルはBD/SD/CYMも含め常にCAR側の音量として通常のTLLパスに乗る。
        const ch = reg - 0x30, c = this.channels[ch];
        if (this.rhythmMode && ch >= 6) {
          if (reg === 0x37 || reg === 0x38) { c.mod.volume = ((data >> 4) & 15) << 2; c.mod.updateTLL(); }
          c.car.volume = (data & 15) << 2;
          c.car.updateTLL();
        } else {
          this._setPatch(ch, (data >> 4) & 15);
          c.car.volume = (data & 15) << 2;
          c.mod.updateAll(); c.car.updateAll();
        }
      }
      this.reg[reg] = data;
    }

    // レジスタ0x0E: bit5=リズムモード有効, bit4-0=BD/SD/TOM/CYM/HHのキーオン
    _writeRhythmReg(data) {
      const old = this.reg[0x0E] || 0;
      const wasRhythm = this.rhythmMode;
      const newRhythm = !!(data & 0x20);
      if (newRhythm && !wasRhythm) {
        // ch6-8を専用リズム音色に切替。HH(ch7.mod)/TOM(ch8.mod)は本来モジュレータだが
        // リズムモードでは独立した音声出力になり、TLLもTL固定でなくvolumeレジスタ由来に
        // なる(emu2413 commit_slot_update: type&1==0以外はvolumeを参照)ためtypeを1にする。
        this.channels[6].mod.patch = RHYTHM_PATCH_BD.mod; this.channels[6].car.patch = RHYTHM_PATCH_BD.car;
        this.channels[7].mod.patch = RHYTHM_PATCH_HHSD.mod; this.channels[7].car.patch = RHYTHM_PATCH_HHSD.car;
        this.channels[8].mod.patch = RHYTHM_PATCH_TOMCYM.mod; this.channels[8].car.patch = RHYTHM_PATCH_TOMCYM.car;
        this.channels[7].mod.type = 1; this.channels[8].mod.type = 1;
        // 0x37/0x38の上位ニブルはレジスタとして常に保持されているため、直前の値を反映する
        this.channels[7].mod.volume = ((this.reg[0x37] >> 4) & 15) << 2;
        this.channels[8].mod.volume = ((this.reg[0x38] >> 4) & 15) << 2;
        for (const ch of [6, 7, 8]) { this.channels[ch].mod.updateAll(); this.channels[ch].car.updateAll(); }
      } else if (!newRhythm && wasRhythm) {
        // 通常モードに戻す: mod側のtypeを戻し、直前の0x36-38値で音色/音量を再設定
        this.channels[7].mod.type = 0; this.channels[8].mod.type = 0;
        for (const ch of [6, 7, 8]) {
          const rv = this.reg[0x30 + ch] || 0;
          this._setPatch(ch, (rv >> 4) & 15);
          this.channels[ch].car.volume = (rv & 15) << 2;
          this.channels[ch].mod.updateAll(); this.channels[ch].car.updateAll();
        }
      }
      this.rhythmMode = newRhythm;
      // slotOn/slotOffはeg_modeを変えるだけでeg_dphaseを再計算しないため、通常チャンネルの
      // キーオン(reg 0x20-0x28ハンドラ)同様にupdateEG()で追従させる必要がある。
      const trig = (bit, slots) => {
        if (!this.rhythmMode) return;
        const on = !!(data & bit), wasOn = !!(old & bit);
        if (on && !wasOn) for (const s of slots) { s.slotOn(); s.updateEG(); }
        else if (!on && wasOn) for (const s of slots) { s.slotOff(); s.updateEG(); }
      };
      trig(0x10, [this.channels[6].mod, this.channels[6].car]); // BD
      trig(0x08, [this.channels[7].car]); // SD
      trig(0x04, [this.channels[8].mod]); // TOM
      trig(0x02, [this.channels[8].car]); // CYM
      trig(0x01, [this.channels[7].mod]); // HH
    }

    _updateAMPM() {
      this.pm_phase = (this.pm_phase + pm_dphase) & (PM_DP_WIDTH - 1);
      this.am_phase = (this.am_phase + am_dphase) & (AM_DP_WIDTH - 1);
      this.lfo_am = amtable[this.am_phase >>> (AM_DP_BITS - AM_PG_BITS)];
      this.lfo_pm = pmtable[this.pm_phase >>> (PM_DP_BITS - PM_PG_BITS)];
    }

    _calc() {
      this._updateAMPM();
      // ノイズLFSR(HH/SD/CYMの疑似ノイズ合成用)を1サンプルにつき1回進める
      if (this.noiseLfsr & 1) this.noiseLfsr ^= 0x800200;
      this.noiseLfsr = (this.noiseLfsr >>> 1) || 1;
      const noiseBit = this.noiseLfsr & 1;

      let inst = 0;
      const lastCh = this.rhythmMode ? 6 : NUM_CH;
      for (let i = 0; i < lastCh; i++) {
        const c = this.channels[i];
        if (c.car.eg_mode === FINISH) continue;
        const fm = c.calcModulator(this.lfo_am, this.lfo_pm);
        const out = c.calcCarrier(fm, this.lfo_am, this.lfo_pm);
        if (!this.mute[i]) inst += out * this.vol[i];
      }
      if (this.rhythmMode) {
        const ch6 = this.channels[6], ch7 = this.channels[7], ch8 = this.channels[8];
        // BD: 通常チャンネルと同じmod→car 2opFM接続(emu2413はcalc_slot_mod/carをch6にも
        // そのまま流用している)。
        if (ch6.car.eg_mode !== FINISH) {
          const fm = ch6.calcModulator(this.lfo_am, this.lfo_pm);
          const out = ch6.calcCarrier(fm, this.lfo_am, this.lfo_pm);
          if (!this.mute[MUTE_BD]) inst += out * this.vol[MUTE_BD];
        }

        // HH/SD/TOM/CYM: 先に位相を進めてからshort_noiseを計算し(emu2413 update_short_noise)、
        // それを使って各スロットの出力サイン位相を選ぶ。音量はEG/TLL経由(rhythmOut内でegout
        // が既にvolumeレジスタ由来のTLLを反映済み)。
        const hh = ch7.mod, sd = ch7.car, tom = ch8.mod, cym = ch8.car;
        const hhPg = hh.calcPhase(this.lfo_pm);
        const sdPg = sd.calcPhase(this.lfo_pm);
        const tomPg = tom.calcPhase(this.lfo_pm);
        const cymPg = cym.calcPhase(this.lfo_pm);
        // emu2413 update_short_noise: BIT位置はPG_BITS基準の相対式のままにしておく
        const h_bit2 = (hhPg >> (PG_BITS - 8)) & 1;
        const h_bit7 = (hhPg >> (PG_BITS - 3)) & 1;
        const h_bit3 = (hhPg >> (PG_BITS - 7)) & 1;
        const c_bit3 = (cymPg >> (PG_BITS - 7)) & 1;
        const c_bit5 = (cymPg >> (PG_BITS - 5)) & 1;
        const shortNoise = (h_bit2 ^ h_bit7) | (h_bit3 ^ c_bit5) | (c_bit3 ^ c_bit5);

        const hhEg = hh.calcEnvelope(this.lfo_am);
        const sdEg = sd.calcEnvelope(this.lfo_am);
        const tomEg = tom.calcEnvelope(this.lfo_am);
        const cymEg = cym.calcEnvelope(this.lfo_am);

        if (tom.eg_mode !== FINISH && !this.mute[MUTE_TOM]) inst += rhythmOut(tom, tomEg, tomPg) * this.vol[MUTE_TOM];
        if (hh.eg_mode !== FINISH && !this.mute[MUTE_HH]) {
          const ph = shortNoise ? (noiseBit ? PD(0x2d0) : PD(0x234)) : (noiseBit ? PD(0x34) : PD(0xd0));
          inst += rhythmOut(hh, hhEg, ph) * this.vol[MUTE_HH];
        }
        if (sd.eg_mode !== FINISH && !this.mute[MUTE_SD]) {
          const sdOwnBit = (sdPg >> (PG_BITS - 2)) & 1;
          const ph = sdOwnBit ? (noiseBit ? PD(0x300) : PD(0x200)) : (noiseBit ? PD(0x0) : PD(0x100));
          inst += rhythmOut(sd, sdEg, ph) * this.vol[MUTE_SD];
        }
        if (cym.eg_mode !== FINISH && !this.mute[MUTE_CYM]) {
          const ph = shortNoise ? PD(0x300) : PD(0x100);
          inst += rhythmOut(cym, cymEg, ph) * this.vol[MUTE_CYM];
        }
      }
      return inst;
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this.lastSample = this._calc();
    }

    mixSample() {
      return (this.lastSample / 4096) * 0.5;
    }
  }

  function melodySnapshot(c, N) {
    const mod = c.mod, car = c.car;
    const freq = (c.keyStatus && car.fnum > 0) ? SAMPLE_RATE * car.fnum / Math.pow(2, 19 - car.block) : 0;
    const active = c.keyStatus && car.eg_mode !== FINISH && car.eg_mode !== SETTLE;
    const modEg = mod.egout, carEg = car.egout;
    const ratio = car.dphase > 0 ? mod.dphase / car.dphase : 1;
    const wave = new Array(N);
    let mx = 1e-6;
    for (let k = 0; k < N; k++) {
      const cp = Math.round((k / N) * PG_WIDTH) & (PG_WIDTH - 1);
      const mp = Math.round((k / N) * ratio * PG_WIDTH) & (PG_WIDTH - 1);
      const mo = DB2LIN[mod.sintbl[mp] + Math.min(DB_MUTE - 1, modEg)];
      const co = (carEg >= DB_MUTE - 1) ? 0 : DB2LIN[car.sintbl[(cp + (mo << 1)) & (PG_WIDTH - 1)] + carEg];
      wave[k] = co;
      if (Math.abs(co) > mx) mx = Math.abs(co);
    }
    for (let k = 0; k < N; k++) wave[k] /= mx;
    return {
      freq,
      vol: (15 - (c.car.volume >> 2)) / 15,
      rawVol: c.car.volume >> 2,
      instrument: c.patchNumber,
      active,
      waveData: active ? wave : new Array(N).fill(0),
      // patch: 鍵盤の大波形表示の下に音色データ(@OT形式)を出すためのパラメータ
      // (現在選択中の音色のスロット {mod,car}。emu2413のpatch構造体そのまま)
      patch: { type: 'opll', inst: c.patchNumber, mod: mod.patch, car: car.patch }
    };
  }

  function rhythmSlotInfo(slot, keyOn, freq) {
    const active = keyOn && slot.eg_mode !== FINISH;
    return { freq: active ? freq : 0, vol: active ? 1 : 0, active };
  }

  // 通常モード: 9メロディチャンネル分を返す({rhythmMode:false, melody:[9]})。
  // リズムモード: melodyは0-5chの6要素のみ、加えてrhythm{bd,sd,tom,cym,hh}を返す
  // (ch6-8の8スロットが5種の打楽器に化けるため、鍵盤表示側は6melody+5rhythmの
  // 11行として描画する)。
  Emu.snapshotOPLL = function (chip) {
    if (typeof chip.snapshot === 'function') return chip.snapshot(); // Nukedコア
    const N = 128;
    const melodyCount = chip.rhythmMode ? 6 : NUM_CH;
    const melody = [];
    for (let i = 0; i < melodyCount; i++) melody.push(melodySnapshot(chip.channels[i], N));

    if (!chip.rhythmMode) return { rhythmMode: false, melody };

    const ch6 = chip.channels[6], ch7 = chip.channels[7], ch8 = chip.channels[8];
    const bdFreq = ch6.car.fnum > 0 ? SAMPLE_RATE * ch6.car.fnum / Math.pow(2, 19 - ch6.car.block) : 0;
    const tomFreq = ch8.mod.fnum > 0 ? SAMPLE_RATE * ch8.mod.fnum / Math.pow(2, 19 - ch8.mod.block) : 0;
    const rhythm = {
      bd: rhythmSlotInfo(ch6.car, true, bdFreq),
      sd: rhythmSlotInfo(ch7.car, true, 0),
      tom: rhythmSlotInfo(ch8.mod, true, tomFreq),
      cym: rhythmSlotInfo(ch8.car, true, 0),
      hh: rhythmSlotInfo(ch7.mod, true, 0),
    };
    return { rhythmMode: true, melody, rhythm };
  };

  Emu.OPLLAudio = OPLLAudio;
})(globalThis);

/*
 * YM2610 (OPNB) 音源エミュレータ — FM + ADPCM-A + ADPCM-B (Neo Geo / VGM)
 * MML.Emu.YM2610Audio
 *
 * YM2610は SSG(AY-3-8910互換,3ch) + FM(4ch) + ADPCM-A(6ch) + ADPCM-B(1ch) を1チップに
 * 内蔵する。このファイルは FM と ADPCM-A/B を扱う(SSGはEmu.AY8910Audioをそのまま再利用)。
 * VGM上は 0x58(ポート0)/0x59(ポート1) のレジスタ書込みでまとめて叩かれるので、SSG/FMの
 * 振り分けは呼び出し側(vgmPlayer.js)が行う(SSGはここに来ても弾くだけ)。
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植)の薄いラッパー。
 * 理由: YM2610のFMレジスタ配置はYM2612と完全に同一(0x30 DT/MUL … 0xB4 L/R/AMS/PMS、0x22 LFO、
 * 0x27 ch3モード、0x28 キーオン、サンプルレート=clock/144、周波数式も同じ)で、違いは
 *   (1) 6chぶんのアドレス空間のうち実チャンネルが各ポートのオフセット1,2だけ
 *       (オフセット0,3は結線されていないダミー。ymfm(aaronsgiles/ymfm, BSD-3)の
 *       ym2610 channel_mask=0x36=YM2612番号でch1,2,4,5 と一致。YM2610Bは6ch全部が実チャンネル)、
 *   (2) ch6 DAC(0x2A/0x2B、YM2612固有)が無い、
 *   (3) SSG/ADPCM-A/ADPCM-Bのレジスタ領域(port0 0x00-0x1F, port1 0x00-0x2F)が挟まる、
 * の3点だけなので、YM2612コアを6chのまま動かしてダミーch/DACを常時ミュートし、
 * 該当領域の書込みを弾くだけで済む。ch3特殊モード(0x27上位ビット、YM2612のch3=port0
 * オフセット2=YM2610のFM2に相当。MAME fm.cppのym2610もCH[2]に適用)もそのまま効く。
 * キーオン0x28の値1,2,5,6 → YM2612コアのch1,2,4,5 = 本クラスのFM1-4。
 *
 * コアは chipType:'ym3438' で使う: FMオペレータ本体(PG/EG/log-sin・exp ROM/LFO/SSG-EG)は
 * OPNファミリ共通設計だが、YM2612固有の9bit DACラダー効果はYM2610には無い
 * (OPNA/OPNBは内部加算して16bit出力)ため、ラダー無しモードが正しい。
 *
 * ★ADPCM-A/B は ymfm(ymfm_adpcm.cpp / ymfm_opn.cpp ym2610)の関数単位の移植:
 *   ADPCM-A: 6ch、4bit ADPCM(MSM5205系、12bit累算器はラップ)、アドレスは 開始/終了レジスタ<<8、
 *            終了比較は下位20bitのみ(twinspri等の実挙動)、FMサンプル3回に1回クロック
 *            (=EGサイクル、Neo Geo 8MHz で 18518Hz)。音量=(IL^0x1f)+(TL^0x3f) を乗数15-(v&7)と
 *            シフト5+(v>>3)へ。パンL/R。
 *   ADPCM-B: 1ch、4bit ADPCM(累算器16bitクランプ、ステップ127〜24576を0.9〜2.4倍)、
 *            Δ-N(16bit位相累算、fs=ΔN×55555/65536)、線形補間、レベル(0-255)、リピート、
 *            リミット/終了アドレス(<<8)、YM2610では常に外部メモリ(ROM)モード。
 *   ROMは VGM データブロック 0x82(ADPCM-A)/0x83(ADPCM-B=DELTA-T) を loadRom() で受け取る。
 *   出力尺度: ymfmでは FMチャンネルのフルスケール=4096(13bit>>1)、ADPCM-A最大≒15360、
 *   ADPCM-B最大≒16320(レベル255、YM2610はrshift=1)。本クラスのFMコアはフルスケール0.2
 *   (実測)なのでADPCM出力は ×0.2/4096 で同じ比率に合わせる(ADPCM_SCALE)。
 *
 * ★表示専用のサンプルピッチ解析(samplePitch / decodeAdpcmA・B / detectCps): 音程レジスタの無い
 *   ADPCM-Aと、Δ-Nしか無いADPCM-Bに絶対音名を出すため、ROM上のサンプルを1回だけデコードして
 *   基本周期(cps=1入力サンプルあたりの周期数)を求めキャッシュする(詳細は同関数群のコメント)。
 *
 *   手動キャリブレーション(setSampleTuning: cps上書き、localStorage 'ym2610AdpcmTuning' にサンプル内容の
 *   ハッシュをキーで永続化)と、波形アイコン用の1周期/概形波形(makeSampleWave)もここで作る。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample() / loadRom(kind,...) /
 * samplePitch(kind,start,end) / setSampleTuning(kind,start,end,cps|null) /
 * mute[fmCh] / vol[fmCh] / muteAdpcm[7](A1-6,B) / volAdpcm[7](書き換えたら syncMuteVol()) /
 * core / numFm(4 or 6) / flushWrites() / Emu.snapshotYM2610(chip)。
 * Neo Geo: 8000000Hz → 55555Hz。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CYCLES_PER_SAMPLE = 144;
  const ADPCM_SCALE = 0.2 / 4096; // ymfm出力単位 → 本クラスのFM尺度(FMチャンネルのフルスケール0.2)

  // ── ADPCM-A (ymfm adpcm_a_channel/engine) ──
  const ADPCMA_STEPS = [
    16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552
  ];
  const ADPCMA_STEP_INC = [-1, -1, -1, -1, 2, 5, 7, 9];
  const ADPCMA_ADDR_SHIFT = 8;

  class AdpcmA {
    /**
     * @param {object} owner - romA / sampleRate を持つチップ本体
     * @param {{fixedAddr?: Array<{start:number,end:number}>}} [opts]
     *   fixedAddr: サンプルの開始/終了(バイト、endは実機表と同じinclusive)を固定する。
     *   YM2608の内蔵リズム(6サンプルのアドレスがROM固定でレジスタが無い)用。
     *   省略時は従来どおり開始/終了レジスタ(YM2610 ADPCM-A)。
     */
    constructor(owner, opts) {
      this.owner = owner;
      this.fixedAddr = (opts && opts.fixedAddr) || null;
      this.regs = new Uint8Array(0x30);
      this.ch = [];
      // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
      for (let i = 0; i < 6; i++) this.ch.push({ playing: false, curnibble: 0, curbyte: 0, curaddress: 0, acc: 0, stepIndex: 0, seq: 0 });
      this.reset();
    }
    // ch i の開始バイトアドレス(fixedAddr優先)
    _startAddr(i) {
      if (this.fixedAddr) return this.fixedAddr[i].start;
      return (this.regs[0x10 + i] | (this.regs[0x18 + i] << 8)) << ADPCMA_ADDR_SHIFT;
    }
    // ch i の終了バイトアドレス(exclusive、fixedAddr優先)
    _endAddr(i) {
      if (this.fixedAddr) return this.fixedAddr[i].end + 1;
      return ((this.regs[0x20 + i] | (this.regs[0x28 + i] << 8)) + 1) << ADPCMA_ADDR_SHIFT;
    }
    // ch i の現在の開始/終了レジスタから求めたサンプル長(秒)。ADPCM-Aは18518Hz(=FMサンプルレート/3)固定
    lengthSeconds(i) {
      const bytes = Math.max(0, this._endAddr(i) - this._startAddr(i));
      return bytes * 2 / (this.owner.sampleRate / 3);
    }
    reset() {
      this.regs.fill(0);
      // パンは両方ON・音色レベル最大が既定(Neo Geoホームブリュー(ffeast等)が依存する。ymfmと同じ)
      for (let i = 0x08; i <= 0x0D; i++) this.regs[i] = 0xDF;
      for (const c of this.ch) { c.playing = false; c.curnibble = 0; c.curbyte = 0; c.curaddress = 0; c.acc = 0; c.stepIndex = 0; }
    }
    write(reg, data) {
      this.regs[reg] = data;
      if (reg === 0x00) {
        const on = !(data & 0x80); // bit7=1 dump(停止)、0=キーオン
        for (let i = 0; i < 6; i++) if (data & (1 << i)) this._keyonoff(i, on);
      }
    }
    _keyonoff(i, on) {
      const c = this.ch[i];
      c.playing = on;
      if (on) {
        c.curaddress = this._startAddr(i);
        c.curnibble = 0; c.curbyte = 0; c.acc = 0; c.stepIndex = 0;
        c.seq++;
        // 鳴っているサンプルの範囲(バイト)。ドライバがキーオン後に次の音のレジスタを先書きしても
        // 表示側(ピッチ解析)が正しいサンプルを見られるようキーオン時点で確定させる
        c.smpStart = c.curaddress;
        c.smpEnd = this._endAddr(i);
      }
    }
    // FMサンプル3回に1回。
    clock() {
      const rom = this.owner.romA;
      for (let i = 0; i < 6; i++) {
        const c = this.ch[i];
        if (!c.playing) { c.acc = 0; continue; }
        let data;
        if (c.curnibble === 0) {
          // 終了アドレス(inclusive)の次のバイトを読もうとした時点で停止。比較は下位20bitのみ
          const end = this._endAddr(i);
          if (((c.curaddress ^ end) & 0xFFFFF) === 0) { c.playing = false; c.acc = 0; continue; }
          c.curbyte = rom && c.curaddress < rom.length ? rom[c.curaddress] : 0;
          c.curaddress = (c.curaddress + 1) & 0xFFFFFF;
          data = c.curbyte >> 4; c.curnibble = 1;
        } else {
          data = c.curbyte & 0x0F; c.curnibble = 0;
        }
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[c.stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        c.acc = (c.acc + delta) & 0xFFF; // 12bit累算器はラップ(MSM5205と同じ)
        c.stepIndex = Math.max(0, Math.min(48, c.stepIndex + ADPCMA_STEP_INC[data & 7]));
      }
    }
    // ch i の現在出力(ymfm単位、パン適用前)。0=無音
    value(i) {
      const c = this.ch[i];
      const vol = ((this.regs[0x08 + i] & 0x1F) ^ 0x1F) + ((this.regs[0x01] & 0x3F) ^ 0x3F);
      if (vol >= 63) return 0;
      const mul = 15 - (vol & 7);
      const shift = 4 + 1 + (vol >> 3);
      let a = c.acc & 0xFFF; if (a & 0x800) a -= 0x1000; // 12bit符号拡張
      return (((a << 4) * mul) >> shift) & ~3;
    }
    panL(i) { return !!(this.regs[0x08 + i] & 0x80); }
    panR(i) { return !!(this.regs[0x08 + i] & 0x40); }
  }

  // ── ADPCM-B (ymfm adpcm_b_channel/engine、YM2610=外部メモリ固定・addrshift 8) ──
  const ADPCMB_STEP_MIN = 127, ADPCMB_STEP_MAX = 24576;
  const ADPCMB_STEP_SCALE = [57, 57, 57, 57, 77, 102, 128, 153];
  const ADPCMB_ADDR_SHIFT = 8;

  class AdpcmB {
    /**
     * @param {object} owner - romB / sampleRate を持つチップ本体
     * @param {{addrShift?: number, forceExternal?: boolean}} [opts]
     *   addrShift: 開始/終了/リミットレジスタ値→バイトアドレスのシフト。
     *   YM2610=8(256バイト単位、既定)、YM2608/Y8950=5(32バイト単位。MAME ymdeltat portshift)。
     *   forceExternal: control1へ外部メモリ・録音無効を強制(YM2610の実機挙動、既定true)。
     *   Y8950はCPU書込み(REC|MEMDATA)を使うので false にする(書込み自体は呼び出し側が実装)。
     */
    constructor(owner, opts) {
      this.owner = owner;
      this.addrShift = (opts && opts.addrShift) || ADPCMB_ADDR_SHIFT;
      this.forceExternal = !opts || opts.forceExternal !== false;
      this.regs = new Uint8Array(0x11);
      this.reset();
    }
    reset() {
      this.regs.fill(0);
      this.regs[0x0C] = this.regs[0x0D] = 0xFF; // リミット既定=全開
      this._resetChannel();
    }
    _resetChannel() {
      this.playing = false; this.curnibble = 0; this.curbyte = 0; this.position = 0; this.curaddress = 0;
      this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      if (this.seq === undefined) this.seq = 0; // 開始通番(先読みキャプチャ用、AdpcmA.ch[].seqと同じ役割)。リセットでは戻さない
    }
    // 現在の開始/終了/Δ-Nから求めたサンプル長(秒)。リピート時は無限(Infinity)
    lengthSeconds() {
      const start = (this.regs[0x02] | (this.regs[0x03] << 8)) << this.addrShift;
      const end = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift;
      const rate = this.rate();
      if (this.regs[0x00] & 0x10) return Infinity;
      return rate > 0 ? Math.max(0, end - start) * 2 / rate : 0;
    }
    // reg = port0 アドレス - 0x10 (0x00-0x0B)
    write(reg, data) {
      // YM2610は外部モード強制・録音無効(ymfm ym2610::write_data)
      if (reg === 0x00 && this.forceExternal) data = (data | 0x20) & ~0x40;
      this.regs[reg] = data;
      if (reg === 0x00) {
        if (data & 0x80) this._loadStart(); // start
        if (data & 0x01) this._resetChannel(); // reset
      }
    }
    _loadStart() {
      this.playing = true;
      this.curaddress = (this.regs[0x02] | (this.regs[0x03] << 8)) << this.addrShift;
      this.curnibble = 0; this.curbyte = 0; this.position = 0; this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      this.seq++;
      this.smpStart = this.curaddress; // 鳴っているサンプルの範囲(AdpcmA.ch[].smpStart/Endと同じ用途)
      this.smpEnd = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift;
    }
    _atEnd() { return this.curaddress === ((((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << this.addrShift) - 1); }
    _atLimit() { return this.curaddress === ((((this.regs[0x0C] | (this.regs[0x0D] << 8)) + 1) << this.addrShift) - 1); }
    // FMサンプル毎
    clock() {
      if (!(this.regs[0x00] & 0x80) || !this.playing) { this.playing = false; return; }
      const deltaN = this.regs[0x09] | (this.regs[0x0A] << 8);
      const position = this.position + deltaN;
      this.position = position & 0xFFFF;
      if (position < 0x10000) return;
      const rom = this.owner.romB;
      if (this.curnibble === 0) this.curbyte = rom && this.curaddress < rom.length ? rom[this.curaddress] : 0;
      const data = ((this.curbyte << (4 * this.curnibble)) & 0xFF) >> 4;
      this.curnibble ^= 1;
      if (this.curnibble === 0) {
        if (this._atEnd()) {
          if (this.regs[0x00] & 0x10) this._loadStart(); // repeat
          else { this.acc = 0; this.prevAcc = 0; this.playing = false; return; }
        } else if (this._atLimit()) {
          this.curaddress = 0;
        } else {
          this.curaddress = (this.curaddress + 1) & 0xFFFFFF;
        }
      }
      this.prevAcc = this.acc;
      let delta = ((2 * (data & 7) + 1) * this.step) >> 3;
      if (data & 8) delta = -delta;
      this.acc = Math.max(-32768, Math.min(32767, this.acc + delta));
      this.step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((this.step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
    }
    // 現在出力(ymfm単位、パン適用前)。線形補間×レベル(/256)、さらにYM2610では>>1
    // (ymfm ym2610::clock_fm_and_adpcm の m_adpcm_b.output(…, rshift=1))
    value() {
      const r = ((this.prevAcc * ((this.position ^ 0xFFFF) + 1) + this.acc * this.position) >> 16);
      return (r * this.regs[0x0B]) >> 9;
    }
    panL() { return !!(this.regs[0x01] & 0x80); }
    panR() { return !!(this.regs[0x01] & 0x40); }
    // 表示用: 現在の再生レート(Hz)
    rate() { return (this.regs[0x09] | (this.regs[0x0A] << 8)) * this.owner.sampleRate / 65536; }
  }

  // ── サンプルのピッチ解析(鍵盤/ロールの音程表示用。再生には一切関与しない) ──
  // ADPCM-A/B のサンプルは ROM 上の固定データなので、同じ範囲(開始/終了アドレス)は毎回同じ波形。
  // 初めて見たサンプルを1回だけ丸ごとデコードして基本周期を求め、「1入力サンプルあたりの周期数
  // cps」(再生レート非依存)としてキャッシュする。表示周波数 = cps × 現在の再生レート
  // (ADPCM-A: 固定18518Hz、ADPCM-B: Δ-N由来)。ADPCM-Bは「1つのサンプルをΔ-Nで音階演奏」が
  // 典型なので、Δ-Nの比で正確な音程差 + 解析で正確な基準、の組み合わせで絶対音名まで出せる。
  // ADPCM-Aは「音程ごとに別サンプル」の場合にサンプルごとの検出値がそのまま絶対音になる。
  // ドラム/ノイズ系は検出信頼度(conf)が低くなるので、表示側はしきい値で音程なし表示に落とす。
  //
  // 検出は McLeod の NSDF(正規化二乗差関数、実体は正規化自己相関)。アタック部(先頭15%)を避けて
  // 最大 PITCH_FRAMES 個の窓を等間隔に取り、各窓で「最初の主要ピーク」(グローバル最大の90%以上で
  // 最初に現れる正の山、放物線補間)を周期とする。窓ごとの結果の中央値を採用し、中央値±3%以内で
  // 一致した窓の割合を conf(0-1)にする(オクターブ誤りや非周期部分があると下がる)。
  // コスト: 窓1600×ラグ800×6窓≒8M積和/サンプル、ユニークなサンプルごとに1回だけ(数ms〜十数ms)。
  // PITCH_MIN_LAG: 検出上限周波数=レート/16(ADPCM-A 18518Hz→1157Hz、ADPCM-B 55kHz→3.4kHz)。
  // 小さくするとハイハット等の高域ノイズが最小ラグ境界に偽ピークを作る(初版は8で 18518/8=2314.8Hz
  // が実曲のハイハットに出た)。境界(τ==PITCH_MIN_LAG)で最大となる山も真の極大でないので捨てる。
  const PITCH_WIN = 1600, PITCH_MAX_LAG = 800, PITCH_MIN_LAG = 16, PITCH_FRAMES = 6, PITCH_CLARITY = 0.85;

  function decodeAdpcmA(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, stepIndex = 0, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        acc = (acc + delta) & 0xFFF;
        stepIndex = Math.max(0, Math.min(48, stepIndex + ADPCMA_STEP_INC[data & 7]));
        let s = acc; if (s & 0x800) s -= 0x1000;
        out[k++] = s / 2048;
      }
    }
    return out;
  }
  function decodeAdpcmB(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, step = ADPCMB_STEP_MIN, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * step) >> 3;
        if (data & 8) delta = -delta;
        acc = Math.max(-32768, Math.min(32767, acc + delta));
        step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
        out[k++] = acc / 32768;
      }
    }
    return out;
  }

  // 1窓のNSDFから周期(ラグ、小数)と明瞭度(0-1)を返す
  function nsdfPeriod(pcm, off, W, maxLag) {
    let mean = 0;
    for (let i = 0; i < W; i++) mean += pcm[off + i];
    mean /= W;
    const x = new Float32Array(W);
    for (let i = 0; i < W; i++) x[i] = pcm[off + i] - mean;
    const nsdf = new Float32Array(maxLag + 1);
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      let acf = 0, m = 0;
      for (let i = 0; i + tau < W; i++) { const a = x[i], b = x[i + tau]; acf += a * b; m += a * a + b * b; }
      nsdf[tau] = m > 0 ? 2 * acf / m : 0;
    }
    // 正の山ごとの最大値を集める(負→正の交差から次の負への交差まで)
    const peaks = [];
    let inPos = false, best = -1, bestTau = 0;
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (!inPos) { inPos = true; best = -1; }
        if (v > best) { best = v; bestTau = tau; }
      } else if (inPos) {
        inPos = false;
        if (bestTau > PITCH_MIN_LAG) peaks.push({ tau: bestTau, v: best }); // 境界の偽ピークは捨てる
      }
    }
    if (inPos && best > 0 && bestTau > PITCH_MIN_LAG && bestTau < maxLag) peaks.push({ tau: bestTau, v: best });
    if (!peaks.length) return null;
    let gmax = 0;
    for (const p of peaks) if (p.v > gmax) gmax = p.v;
    const p = peaks.find(q => q.v >= gmax * 0.9);
    // 放物線補間
    let tau = p.tau;
    if (tau > PITCH_MIN_LAG && tau < maxLag) {
      const y0 = nsdf[tau - 1], y1 = nsdf[tau], y2 = nsdf[tau + 1];
      const d = y0 - 2 * y1 + y2;
      if (d < 0) tau += 0.5 * (y0 - y2) / d;
    }
    return { lag: tau, clarity: p.v };
  }

  // pcm(Float32Array)から {cps, conf}。conf<0.5 は表示側で「音程なし」扱い
  function detectCps(pcm) {
    const len = pcm.length;
    if (len < 256) return { cps: 0, conf: 0 };
    const W = Math.min(PITCH_WIN, Math.floor(len * 0.6));
    const maxLag = Math.min(PITCH_MAX_LAG, Math.floor(W / 2));
    if (maxLag <= PITCH_MIN_LAG + 2) return { cps: 0, conf: 0 };
    const first = Math.floor(len * 0.15);
    const span = len - first - W;
    const frames = span <= 0 ? 1 : Math.min(PITCH_FRAMES, Math.floor(span / (W / 2)) + 1);
    const lags = [];
    for (let f = 0; f < frames; f++) {
      const off = span <= 0 ? Math.max(0, len - W) : first + Math.floor(span * f / Math.max(1, frames - 1));
      const r = nsdfPeriod(pcm, off, W, maxLag);
      if (r && r.clarity >= PITCH_CLARITY) lags.push(r.lag);
    }
    if (!lags.length) return { cps: 0, conf: 0 };
    lags.sort((a, b) => a - b);
    const med = lags[lags.length >> 1];
    let agree = 0;
    for (const l of lags) if (Math.abs(l - med) / med <= 0.03) agree++;
    return { cps: 1 / med, conf: agree / frames };
  }

  // サンプル内容のハッシュ(FNV-1a、先頭4KB+長さ)。手動キャリブレーションのキー。ROM上のアドレスは
  // ゲームごと/ダンプごとに違いうるが、サンプル内容が同じなら同じ音なので内容で同定する。
  function sampleHash(rom, start, end) {
    let h = 0x811c9dc5;
    const n = Math.min(end, rom.length) - start;
    const lim = Math.min(n, 4096);
    for (let i = 0; i < lim; i++) { h ^= rom[start + i]; h = Math.imul(h, 0x01000193); }
    h ^= n; h = Math.imul(h, 0x01000193);
    return (h >>> 0).toString(16) + '-' + n.toString(16);
  }
  const TUNING_KEY = 'ym2610AdpcmTuning'; // localStorage: { [sampleHash]: cps }
  // 毎回localStorageから読む(サンプル初出時とキャリブレーション時だけなので頻度は低い。
  // メモリキャッシュにすると開発者ツール等で消した設定が残り続けて紛らわしい)
  function getTuningMap() {
    try { return JSON.parse(global.localStorage.getItem(TUNING_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveTuningMap(map) {
    try { global.localStorage.setItem(TUNING_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  // ── 打楽器/音階の手動上書き ────────────────────────────────────────────
  // 「このサンプルは打楽器か、音階楽器か」はピッチ解析の信頼度(conf>=0.5)で自動判定して
  // いるが、外れる曲がある。ユーザーが耳で決めた指定をここへ集約する。
  // ★applyKindOverride を samplePitch() の中で conf に反映させることで、
  //   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換の4箇所が
  //   すべて自動的に追随する(判定の分岐を増やさない)。
  // キーはサンプル内容のハッシュ(チューニングと同じ)。ROM上のアドレスと違い、
  // 別のゲーム/別のリビジョンでも同じ音なら同じ指定が効く。
  const KIND_KEY = 'samplePitchKind'; // localStorage: { [sampleHash]: 'drum' | 'pitch' }
  function getKindMap() {
    try { return JSON.parse(global.localStorage.getItem(KIND_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveKindMap(map) {
    try { global.localStorage.setItem(KIND_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }
  /** samplePitch() の結果 r に手動指定を反映する(r.kindManual に指定内容を残す) */
  function applyKindOverride(r) {
    if (!r || !r.hash) return r;
    const k = getKindMap()[r.hash];
    if (k === 'drum') { r.conf = 0; r.kindManual = 'drum'; }
    else if (k === 'pitch' && r.cps > 0) { r.conf = 1; r.kindManual = 'pitch'; }
    else r.kindManual = null;
    return r;
  }
  /** 手動指定の設定/解除。kind: 'drum' | 'pitch' | null(=自動へ戻す) */
  function setKindOverride(hash, kind) {
    if (!hash) return;
    const map = getKindMap();
    if (kind === 'drum' || kind === 'pitch') map[hash] = kind; else delete map[hash];
    saveKindMap(map);
  }

  // 波形アイコン用の128点。cps>0(音程あり)なら持続部(先頭40%位置)から1周期を線形補間で切り出し、
  // 音程なし(ドラム等)ならサンプル全体を128区間に分け各区間の絶対値最大(符号付き)=概形。
  // どちらも最大絶対値で正規化(±1)。
  function makeSampleWave(pcm, cps) {
    const N = 128;
    const len = pcm.length;
    if (len < 8) return null;
    const out = new Float32Array(N);
    let mx = 1e-9;
    if (cps > 0) {
      const period = 1 / cps;
      let off = Math.floor(len * 0.4);
      if (off + period + 1 >= len) off = Math.max(0, len - period - 2);
      for (let k = 0; k < N; k++) {
        const pos = off + period * k / N;
        const i = Math.floor(pos), f = pos - i;
        const v = pcm[i] * (1 - f) + (pcm[Math.min(len - 1, i + 1)] || 0) * f;
        out[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
      }
    } else {
      for (let k = 0; k < N; k++) {
        const a = Math.floor(len * k / N), b = Math.max(a + 1, Math.floor(len * (k + 1) / N));
        let best = 0;
        for (let i = a; i < b; i++) if (Math.abs(pcm[i]) > Math.abs(best)) best = pcm[i];
        out[k] = best; if (Math.abs(best) > mx) mx = Math.abs(best);
      }
    }
    for (let k = 0; k < N; k++) out[k] /= mx;
    return out;
  }

  class YM2610Audio {
    /**
     * @param {number} [clock=8000000] - マスタークロック(サンプルレート=clock/144)
     * @param {{ym2610b?: boolean}} [opts] - ym2610b: YM2610B(FM 6ch全部が実チャンネル)
     */
    constructor(clock, opts) {
      this.clockHz = clock || 8000000;
      this.core = new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' });
      this.sampleRate = this.core.sampleRate;
      this.isB = !!(opts && opts.ym2610b);
      // 本クラスのFM1-n → YM2612コア(6ch)上のチャンネル番号
      this.coreCh = this.isB ? [0, 1, 2, 3, 4, 5] : [1, 2, 4, 5];
      this.numFm = this.coreCh.length;
      this.mute = new Array(this.numFm).fill(false);
      this.vol = new Array(this.numFm).fill(1);
      this.muteAdpcm = new Array(7).fill(false); // 0-5=ADPCM-A ch1-6, 6=ADPCM-B
      this.volAdpcm = new Array(7).fill(1);
      this.romA = null; this.romB = null;
      this._pitchCache = new Map(); // 'a:start:end' / 'b:start:end' → {cps, conf}(samplePitch)
      this.adpcmA = new AdpcmA(this);
      this.adpcmB = new AdpcmB(this);
      this.cyc = 0; this.cycA = 0;
      this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    // mute[]/vol[]をコアの6要素へ写す。ダミーch(YM2610の0,3)とDAC(6)は常時ミュート。
    syncMuteVol() {
      const c = this.core;
      for (let i = 0; i < 7; i++) c.mute[i] = true;
      for (let i = 0; i < this.numFm; i++) { c.mute[this.coreCh[i]] = !!this.mute[i]; c.vol[this.coreCh[i]] = this.vol[i]; }
    }

    reset() {
      this.core.reset(); this.adpcmA.reset(); this.adpcmB.reset();
      this.cyc = 0; this.cycA = 0; this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    /**
     * VGMデータブロック 0x82(ADPCM-A ROM)/0x83(ADPCM-B ROM)。
     * @param {'a'|'b'} kind  @param {number} romSize  @param {number} start  @param {Uint8Array} data
     */
    loadRom(kind, romSize, start, data) {
      const key = kind === 'b' ? 'romB' : 'romA';
      let rom = this[key];
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this[key] = n; }
      rom.set(data, start);
      this._pitchCache.clear(); // ROMが変わったら解析結果は無効
    }

    /**
     * サンプル(ROM上のstart..end-1バイト)の基本周期解析結果(キャッシュ)。表示専用。
     * @param {'a'|'b'} kind
     * @returns {{cps:number, conf:number, cpsAuto:number, confAuto:number, manual:boolean, hash:string, wave:Float32Array|null}|null}
     *   cps=1入力サンプルあたりの周期数(手動補正があればその値、conf=1)。cpsAuto/confAutoは自動検出値。
     *   wave=波形アイコン用128点(音程あり: 持続部の1周期 / 無し: サンプル全体の概形)
     */
    samplePitch(kind, start, end) {
      if (start === undefined || end === undefined || !(end > start)) return null;
      const key = kind + ':' + start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const rom = kind === 'b' ? this.romB : this.romA;
      if (!rom) return null;
      const pcm = this._decodeSample(kind, start, end);
      const auto = detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: sampleHash(rom, start, end), wave: null };
      // 手動キャリブレーション(localStorage、サンプル内容のハッシュがキーなので同じゲームの他トラックでも効く)
      const t = getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      // 打楽器/音階の手動上書きをconfへ反映(ロール/鍵盤/変換の4箇所がこの1点で追随する)
      applyKindOverride(r);
      r.wave = makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(kind, start, end) {
      const rom = kind === 'b' ? this.romB : this.romA;
      // 極端に長いサンプル(ADPCM-Bのループ曲データ等)は先頭部分だけ見る(解析コスト上限)
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES);
      return kind === 'b' ? decodeAdpcmB(rom, start, e) : decodeAdpcmA(rom, start, e);
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.kind + ':' + sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.kind, sample.start, sample.end);
    }

    /**
     * サンプルの手動ピッチ補正(表示専用)。cps=null で解除。localStorage に永続化し、
     * 同じ内容のサンプル(ハッシュ一致)なら別トラック/別セッションでも効く。
     */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const map = getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      saveTuningMap(map);
      r.wave = makeSampleWave(this._decodeSample(kind, start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }

    // レジスタ書込み(port 0/1)。SSG(port0 0x00-0x0F)は呼び出し側がAY8910Audioへ振り分ける前提
    // (渡ってきても弾く)。
    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      if (port === 0) {
        if (reg < 0x10) return;                              // SSG / I/Oポート
        if (reg < 0x1C) { this.adpcmB.write(reg - 0x10, val); return; } // ADPCM-B
        if (reg === 0x1C) return;                            // EOSフラグ制御(再生には無関係)
        if (reg < 0x20) return;
        if (reg === 0x2A || reg === 0x2B) return;            // YM2612のDAC。YM2610には無い
      } else if (reg < 0x30) {
        this.adpcmA.write(reg, val); return;                 // ADPCM-A
      }
      this.core.writeReg(port, reg, val);
    }

    clock() {
      this.core.clock();
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      // FMサンプル毎: ADPCM-B。3回に1回(EGサイクル): ADPCM-A
      this.adpcmB.clock();
      if (++this.cycA >= 3) { this.cycA = 0; this.adpcmA.clock(); }
      let l = 0, r = 0;
      const A = this.adpcmA;
      for (let i = 0; i < 6; i++) {
        if (this.muteAdpcm[i] || !A.ch[i].playing) continue;
        const v = A.value(i) * this.volAdpcm[i];
        if (A.panL(i)) l += v;
        if (A.panR(i)) r += v;
      }
      if (!this.muteAdpcm[6] && this.adpcmB.playing) {
        const v = this.adpcmB.value() * this.volAdpcm[6];
        if (this.adpcmB.panL()) l += v;
        if (this.adpcmB.panR()) r += v;
      }
      this.adpcmL = l * ADPCM_SCALE; this.adpcmR = r * ADPCM_SCALE;
    }
    mixSample() {
      const s = this.core.mixSample();
      return { left: s.left + this.adpcmL, right: s.right + this.adpcmR };
    }
    // 書込みキュー適用(clock()を回さない先読み/シーク経路用)
    flushWrites(collapse) { if (this.core.flushWrites) this.core.flushWrites(collapse); }
  }

  // 鍵盤表示用スナップショット: FMはYM2612版の6chから実チャンネルを抜き出す(形は同じ)。
  // adpcmA[6]/adpcmB: {active, vol(0-1), rawVol, rawVolMax, panL, panR, rate, pitchHz, pitchConf, ...}
  //   pitchHz/pitchConf: 鳴っているサンプルのピッチ解析(samplePitch)結果 × 現在の再生レート。
  //   conf<0.5 は表示側で音程なし扱い(ドラム等)。ADPCM-Aは音程レジスタが無いのでこれが唯一の音程情報、
  //   ADPCM-Bは refRate ベースの仮基準(下記)より優先して使う。
  Emu.snapshotYM2610 = function (chip, opt) {
    const s = Emu.snapshotYM2612(chip.core, opt);
    const A = chip.adpcmA, B = chip.adpcmB;
    const tl = (A.regs[0x01] & 0x3F);
    const adpcmA = [];
    const rateA = chip.sampleRate / 3;
    for (let i = 0; i < 6; i++) {
      const il = A.regs[0x08 + i] & 0x1F;
      const att = (il ^ 0x1F) + (tl ^ 0x3F); // 0=最大
      const vol = att >= 63 ? 0 : Math.max(0, 1 - att / 63);
      const c = A.ch[i];
      const p = c.seq ? chip.samplePitch('a', c.smpStart, c.smpEnd) : null;
      // seq/lenSec: clock()を回さない先読みキャプチャ(vgmPlayer.js captureVgmSongAsync)が、キーオン通番の
      // 変化とサンプル長から「鳴っている区間」を推定するために使う(ライブ表示は playing で足りる)
      adpcmA.push({ active: c.playing && vol > 0, vol, rawVol: il, rawVolMax: 31, panL: A.panL(i) ? 1 : 0, panR: A.panR(i) ? 1 : 0,
        rate: rateA, seq: c.seq, lenSec: A.lengthSeconds(i),
        pitchHz: p ? p.cps * rateA : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'a', start: c.smpStart, end: c.smpEnd } : null }); // 手動キャリブレーション用の同定情報
    }
    const lvl = B.regs[0x0B];
    const rateB = B.rate();
    const pb = B.seq ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
    const adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
      panL: B.panL() ? 1 : 0, panR: B.panR() ? 1 : 0, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
      pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual), sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
      waveData: pb ? pb.wave : null,
      sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
      // refRate: ピッチ解析が信頼できない時のフォールバック用。ADPCM-Bの再生レート(Delta-N由来)を
      // 鍵盤/ロールで疑似音程表示する際の基準(=C4扱い)。ADPCM-Bには「これが基準ピッチ」という
      // レジスタは無いので、同チップのADPCM-A固定レート(chip.sampleRate/3)を基準に採用した
      // (keyboard.js側の相対表示。絶対音名は目安)
      refRate: rateA };
    return { channels: chip.coreCh.map(i => s.channels[i]), adpcmA, adpcmB };
  };

  Emu.YM2610Audio = YM2610Audio;

  // サンプルピッチ解析ユーティリティの共有(GA20等、他のPCMチップからの流用。抽出器を複製しない)。
  // getTuningMap/saveTuningMap の localStorage キーはYM2610と共通('ym2610AdpcmTuning')だが、
  // キーはサンプル内容ハッシュなのでチップをまたいで共有しても衝突しない(むしろ同じサンプルなら
  // 同じ補正が効くのが望ましい)。
  // ループ区間の基本周期推定(qsound.jsで実証した「ループ因数分解方式」の共有版)。
  // ハードウェアループは継ぎ目なく繋がる=ループ長は基本周期の整数倍。k=2..64の lag=N/k で
  // 巡回自己相関(補間つき)を測り、最大相関の90%以上の中で最大のk(=最高周波数解釈)を採る。
  // 汎用detectCpsは探索上限(PITCH_MAX_LAG)を長周期ベースが超えるが、この方式は上限なし。
  // どのkも通らなければ「ループ全体=1周期」(単一周期シンセ波形。≤1024サンプルに限る)。
  // 返り値は detectCps 互換 {cps, conf} または null。
  function loopCps(one) {
    const N = one.length;
    if (N < 16) return null;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += one[i];
    mean /= N;
    const x = new Float32Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) { x[i] = one[i] - mean; e += x[i] * x[i]; }
    if (e < 1e-9) return null;
    let bestK = 0, bestCorr = 0;
    const cands = [];
    for (let k = 2; k <= 64; k++) {
      const lag = N / k;
      if (lag < 8) break;
      let acf = 0;
      for (let i = 0; i < N; i++) {
        const pos = (i + lag) % N;
        const j = Math.floor(pos), f = pos - j;
        const v = x[j] * (1 - f) + x[(j + 1) % N] * f;
        acf += x[i] * v;
      }
      const corr = acf / e;
      cands.push([k, corr]);
      if (corr > bestCorr) { bestCorr = corr; bestK = k; }
    }
    if (bestCorr >= 0.85) {
      for (const [k, corr] of cands) if (corr >= bestCorr * 0.9 && k > bestK) bestK = k;
      return { cps: bestK / N, conf: Math.min(1, bestCorr) };
    }
    if (N <= 1024) return { cps: 1 / N, conf: 0.75 };
    return null;
  }

  Emu.SamplePitchUtil = { detectCps, makeSampleWave, sampleHash, getTuningMap, saveTuningMap, loopCps,
                          getKindMap, saveKindMap, applyKindOverride, setKindOverride };

  // ── OPNファミリ共有(YM2608=ym2608.jsが流用) ─────────────────────────
  // AdpcmA(fixedAddr指定でYM2608内蔵リズムに使える)/AdpcmB(addrShift=5でYM2608 DELTA-T)/
  // デコーダ、そして表示用サンプルピッチ解析API一式。
  // attachSampleApi: YM2610Audioのピッチ解析メソッド群(this.romA/romB/_pitchCacheしか
  // 参照しない)を別チップのprototypeへそのまま移植する(実装の複製を作らない)。
  Emu.OpnAdpcm = {
    AdpcmA, AdpcmB, decodeAdpcmA, decodeAdpcmB, ADPCM_SCALE,
    attachSampleApi(proto) {
      proto.loadRom = YM2610Audio.prototype.loadRom;
      proto.samplePitch = YM2610Audio.prototype.samplePitch;
      proto._decodeSample = YM2610Audio.prototype._decodeSample;
      proto.samplePcm = YM2610Audio.prototype.samplePcm;
      proto.setSampleTuning = YM2610Audio.prototype.setSampleTuning;
      proto.setSampleKind = YM2610Audio.prototype.setSampleKind;
    }
  };
})(globalThis);

/*
 * OPL系FM音源エミュレータ — YM3526(OPL) / YM3812(OPL2) / Y8950(MSX-AUDIO) (VGM / KSS)
 * MML.Emu.OPLAudio
 *
 * 2オペレータFM×9ch、またはリズムモード(6メロディ+5打楽器)。EG(AR/DR/SL/RR、EGT=サステイン
 * 保持ビット、KSR)、KSL(キースケールレベル)、固定LFO(AM≈3.7Hz/VIB≈6.1Hz、深度は0xBDの
 * グローバルビット)、フィードバック、接続(CNT: 0=FM直列 1=加算)。モノラル出力。
 *  - YM3812(OPL2)のみ: 波形選択(WS 0-3: サイン/半サイン/絶対値/四半パルス、0x01 bit5で有効化)
 *  - Y8950のみ: ADPCM-B(DELTA-T 1ch)。ym2610.jsの共有クラス(Emu.OpnAdpcm.AdpcmB)を
 *    addrShift=5(YM2608と同じ32バイト単位)で流用し、Y8950レジスタ(0x07-0x12)を
 *    共有クラスのOPNA配置へ写像する。メモリはVGMデータブロック0x88、またはKSS(MSX-AUDIO)の
 *    データレジスタ(0x0F)経由のCPU書込み(REC|MEMDATAモード)で埋まる。
 *
 * 設計は ym2151.js(OPM)と同じ「dB単位のログサイン+EG」方式(EGレベル0..1023、1単位=
 * 0.09375dB、TL=6bit×8単位、振幅=2^(-att/64)、オペレータ出力±8192)。EG増分表/レート選択も
 * 同じOPNファミリ共通表(OPLのレート値は rate=4*R+RKS、EGクロックは毎サンプル=OPNの3倍速。
 * MAME fmopl.cと同じ時間スケール)。
 *
 * ★変調量の尺度(2026-09-07修正): モジュレータ→キャリアは出力>>1(±8192→±4096=サイン表
 *   1024点の4周期ぶん。MAME fmopl/Nuked-OPLLの「12bit出力をそのまま位相へ」と同じ深さ)、
 *   帰還は(直前2出力の和)>>(10-FB)(FB=7で±2048=2周期。Nuked-OPLLの「2出力の平均>>(7-FB)」
 *   =11bit出力で2周期、MAME fmopl の out<<(FB+7)>>16 と同じ)。以前は帰還が >>(9-FB) で
 *   実機の2倍の深さになっており、FB=7の音色(Bubble Bobble FM8等)が実機よりずっと
 *   ノイジーに崩れていた。ym2151.js(OPM)の >>(10-FB) と同じ値に揃えた。
 *
 * ★リズム(HH/SD/CYM)の位相ビット細工とノイズLFSRは、die解析済みの opllNuked.js
 *   (Nuked-OPLL。OPLLのリズム回路はOPL由来で同一)から式を移植:
 *     HH: サイン索引 = rm_bit<<9 | ((rm_bit^noise) ? 0xd0 : 0x34)
 *     SD: hh_bit8<<9 | ((hh_bit8^noise)<<8) / CYM: rm_bit<<9 | 0x100 / TOM,BD: 通常
 *     rm_bit = (hh2^hh7)|(hh3^tc5)|(tc3^tc5)、ノイズ=23bit LFSR(タップ14)
 *   ビブラートの8ステップ表(±f>>7/±f>>8)も同じ(OPLは0xBD bit6=深度で半減)。
 *   KSLも同じ回路(KSLTABLE - (8-block)*8)で、OPL2/OPL3系のビット解釈
 *   {0:off, 1:3dB/oct, 2:1.5dB/oct, 3:6dB/oct} を使う。
 *
 * 音程: F-Number(10bit)+Block。freq = fnum × 2^(block-1) × fs / 2^19、fs = clock/72
 * (3579545Hz → 49716Hz。OPLLと同じ)。A4=440Hz ≒ fnum 577 / block 4。
 *
 * ミュート添字(mute[]/vol[]): 0-8=メロディch、9-13=BD,SD,TOM,CYM,HH(opllNuked.jsの
 * MUTE_*と同じ並び)、14=ADPCM-B(Y8950)。リズムモード中のch7/ch8はスロット単位で
 * SD/HH/TOM/CYMに分離してミュートできる。
 *
 * 外部I/F: writeReg(reg,val) / readStatus()(Y8950: KSSのポート0xC0読出し用) /
 * clock()(マスタークロック毎、/72で1サンプル) / mixSample()(モノラル、数値) /
 * loadRom(romSize,start,data)(Y8950 DELTA-T、VGMデータブロック0x88) /
 * mute[15] / vol[15] / Emu.snapshotOPL(chip)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 9;
  const CYCLES_PER_SAMPLE = 72;
  const EG_MAX = 1023;
  const SIN_LEN = 1024;
  const SIN_MASK = SIN_LEN - 1;
  const PHASE_BITS = 20;
  const PHASE_MASK = (1 << PHASE_BITS) - 1;
  const PHASE_TO_SIN = PHASE_BITS - 10;

  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13, MUTE_ADPCM = 14;
  const NUM_MUTE = 15;

  // ── テーブル(ym2151.jsと同型) ──
  const SIN_ATT = new Uint16Array(SIN_LEN);
  const SIN_SIGN = new Int8Array(SIN_LEN);
  for (let i = 0; i < SIN_LEN; i++) {
    const s = Math.sin((i + 0.5) * 2 * Math.PI / SIN_LEN);
    SIN_SIGN[i] = s < 0 ? -1 : 1;
    const a = Math.abs(s);
    SIN_ATT[i] = a < 1e-6 ? EG_MAX : Math.min(EG_MAX, Math.round(-20 * Math.log10(a) / 0.09375));
  }
  const EXP_LEN = 4096;
  const EXP_TAB = new Float32Array(EXP_LEN);
  for (let i = 0; i < EXP_LEN; i++) EXP_TAB[i] = i >= EG_MAX ? 0 : 8192 * Math.pow(2, -i / 64);

  const MUL_TAB = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]; // ×2表現(0→0.5、11=10,13=12,14=15,15=15はOPL実機の丸め)
  const SL_TAB = new Uint16Array(16);
  for (let i = 0; i < 16; i++) SL_TAB[i] = i < 15 ? i * 32 : 992; // 3dB/step、15=93dB

  // KSL基礎表(opllNuked.js EG_KSLTABLEと同じ die 由来値)。索引=F-Number上位4bit
  const KSL_TAB = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
  // KSL設定 → 右シフト量(OPL2/OPL3系: 1=3dB/oct, 2=1.5dB/oct, 3=6dB/oct)
  const KSL_SHIFT = [31, 1, 2, 0];

  // EG増分表(OPN/OPM/OPL共通の一般値。ym2151.jsと同一)
  // ★値は MAME fmopl.cpp の eg_inc と同じ(GPL-2.0+, Copyright Jarek Burczynski, Tatsuyuki Satoh)。THIRD-PARTY-NOTICES.md 参照
  const EG_INC = [
    0,1,0,1,0,1,0,1,  0,1,0,1,1,1,0,1,  0,1,1,1,0,1,1,1,  0,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,  1,1,1,2,1,1,1,2,  1,2,1,2,1,2,1,2,  1,2,2,2,1,2,2,2,
    2,2,2,2,2,2,2,2,  2,2,2,4,2,2,2,4,  2,4,2,4,2,4,2,4,  2,4,4,4,2,4,4,4,
    4,4,4,4,4,4,4,4,  4,4,4,8,4,4,4,8,  4,8,4,8,4,8,4,8,  4,8,8,8,4,8,8,8,
    8,8,8,8,8,8,8,8,  16,16,16,16,16,16,16,16,  0,0,0,0,0,0,0,0
  ];
  const EG_SEL = new Uint8Array(64);
  const EG_SHIFT = new Uint8Array(64);
  for (let r = 0; r < 64; r++) {
    const rn = r >> 2, sub = r & 3;
    if (rn === 0) { EG_SEL[r] = sub < 2 ? 18 : 0; EG_SHIFT[r] = 11; continue; }
    if (rn === 1) { EG_SEL[r] = sub < 2 ? 0 : 2; EG_SHIFT[r] = 10; continue; }
    if (rn <= 11) { EG_SEL[r] = sub; EG_SHIFT[r] = 11 - rn; continue; }
    if (rn <= 14) { EG_SEL[r] = 4 + (rn - 12) * 4 + sub; EG_SHIFT[r] = 0; continue; }
    EG_SEL[r] = 16; EG_SHIFT[r] = 0;
  }

  // スロットレジスタオフセット(0x00-0x15、グループ8個中6個有効) → (ch, op)
  const SLOT_CH = new Int8Array(32).fill(-1);
  const SLOT_OP = new Int8Array(32);
  for (let s = 0; s < 0x16; s++) {
    const k = s & 7;
    if (k >= 6) continue;
    SLOT_CH[s] = (s >> 3) * 3 + (k % 3);
    SLOT_OP[s] = k < 3 ? 0 : 1;
  }

  const EG_OFF = 0, EG_REL = 1, EG_SUS = 2, EG_DEC = 3, EG_ATT = 4;

  class Slot {
    constructor() { this.reset(); }
    reset() {
      this.am = false; this.vib = false; this.egt = false; this.ksrFlag = false; this.mul = 2;
      this.ksl = 0; this.tl = 0;
      this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0;
      this.ws = 0;
      this.state = EG_OFF; this.volume = EG_MAX;
      this.phase = 0; this.inc = 0; this.rks = 0; this.kslAtt = 0;
      this.keySrc = 0; // bit0=メロディKON(0xB0 bit5) / bit1=リズム(0xBD)
      this.prev = [0, 0];
    }
    rate(r) { return r === 0 ? 0 : Math.min(63, 4 * r + this.rks); }
  }

  class Channel {
    constructor(idx) { this.idx = idx; this.slots = [new Slot(), new Slot()]; this.reset(); }
    reset() {
      for (const s of this.slots) s.reset();
      this.fnum = 0; this.block = 0; this.kcode = 0; this.fb = 0; this.cnt = 0; this.kon = false;
    }
  }

  // Y8950 ADPCMレジスタ → 共有AdpcmB(OPNA配置)のレジスタ番号
  const Y8950_DT_MAP = { 0x07: 0x00, 0x08: 0x01, 0x09: 0x02, 0x0A: 0x03, 0x0B: 0x04, 0x0C: 0x05, 0x10: 0x09, 0x11: 0x0A, 0x12: 0x0B };
  const Y8950_RAM_SIZE = 256 * 1024; // 仕様上の最大(MSX-AUDIOカートは32KB/256KB)

  class OPLAudio {
    /**
     * @param {number} [clock=3579545] - マスタークロック(サンプルレート=clock/72)
     * @param {{type?: 'ym3526'|'ym3812'|'y8950'}} [opts]
     */
    constructor(clock, opts) {
      this.clockHz = clock || 3579545;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.type = (opts && opts.type) || 'ym3812';
      this.hasWave = this.type === 'ym3812';
      this.hasAdpcm = this.type === 'y8950';
      this.mute = new Array(NUM_MUTE).fill(false);
      this.vol = new Array(NUM_MUTE).fill(1);
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) this.channels.push(new Channel(i));
      if (this.hasAdpcm) {
        this.romB = null; // DELTA-Tメモリ(VGM: ROMブロック / KSS: CPU書込みRAM)
        this._pitchCache = new Map();
        this.adpcmB = new Emu.OpnAdpcm.AdpcmB(this, { addrShift: 5, forceExternal: false });
        this._dtWriteAddr = 0;
      }
      this._init();
    }
    _init() {
      for (const c of this.channels) c.reset();
      this.regs = new Uint8Array(256);
      this.cyc = 0;
      this.egCnt = 0;
      this.wse = false;       // 0x01 bit5(OPL2波形選択有効)
      this.nts = false;       // 0x08 bit6(キーボードスプリット)
      this.rhythm = 0;        // 0xBD生値(bit5=リズムモード, bit4-0=BD,SD,TOM,TC,HH)
      this.amDeep = false; this.vibDeep = false;
      this.lfoCnt = 0;        // サンプルカウンタ(vib=>>10で8ステップ、am=>>6で210ステップ三角)
      this.amStep = 0; this.amDir = 0; this.amVal = 0;
      this.noise = 1;         // 23bit LFSR
      this.adpcmOut = 0;
      this.last = 0;
      this._latch = 0;
      if (this.hasAdpcm) { this.adpcmB.reset(); this._dtWriteAddr = 0; }
    }
    reset() { this._init(); }

    /** Y8950 DELTA-Tメモリ(VGMデータブロック0x88) */
    loadRom(romSize, start, data) {
      if (!this.hasAdpcm) return;
      let rom = this.romB;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.romB = n; }
      rom.set(data, start);
      if (this._pitchCache) this._pitchCache.clear();
    }

    /** ステータス読出し(Y8950/KSSのポート0xC0)。BUF_RDY(bit3)常時セット、EOS(bit4)=再生終了 */
    readStatus() {
      if (!this.hasAdpcm) return 0x06; // OPL: タイマフラグ無し(未実装)、bit1-2は常に1を返す実装が多い
      const eos = this.adpcmB.seq > 0 && !this.adpcmB.playing;
      return 0x08 | (eos ? 0x10 : 0);
    }

    // ── KSS(MSX-AUDIO)用のI/Oポートインターフェース(kssBus.js chips.opl) ──
    /** port 0xC0=アドレスラッチ / 0xC1=データ */
    ioWrite(port, value) {
      if ((port & 1) === 0) this._latch = value & 0xFF;
      else this.writeReg(this._latch || 0, value);
    }
    /** データポート読出し(レジスタ影を返す。ADPCMメモリ読出しモードは未実装) */
    readData() { return this.regs[this._latch || 0]; }

    writeReg(reg, val) {
      reg &= 0xFF; val &= 0xFF;
      this.regs[reg] = val;
      if (reg < 0x20) {
        if (reg === 0x01) { this.wse = this.hasWave && !!(val & 0x20); return; }
        if (reg === 0x08) { this.nts = !!(val & 0x40); return; } // CSMは未実装(実曲で未使用)
        if (this.hasAdpcm) {
          if (reg === 0x0F) { this._dtWriteData(val); return; }
          const m = Y8950_DT_MAP[reg];
          if (m !== undefined) {
            // 0x08(control2)はY8950にパンが無いので両ch ONを強制(共有クラスのビット位置合わせ)
            if (m === 0x01) val = (val & 0x3F) | 0xC0;
            if (m === 0x00) {
              // REC|MEMDATA=CPU書込みモード: 再生を止めて書込みポインタを開始アドレスへ
              if ((val & 0x60) === 0x60) {
                this.adpcmB.regs[0x00] = val;
                this.adpcmB.playing = false;
                this._dtWriteAddr = (this.adpcmB.regs[0x02] | (this.adpcmB.regs[0x03] << 8)) << 5;
                return;
              }
            }
            this.adpcmB.write(m, val);
            return;
          }
          if (reg <= 0x19) return; // プリスケール/DAC/IOポートは未実装
        }
        return;
      }
      if (reg === 0xBD) {
        const prev = this.rhythm;
        this.rhythm = val;
        this.amDeep = !!(val & 0x80); this.vibDeep = !!(val & 0x40);
        this._rhythmKeys(prev, val);
        return;
      }
      if (reg >= 0xA0 && reg <= 0xA8) { const c = this.channels[reg - 0xA0]; c.fnum = (c.fnum & 0x300) | val; this._refreshCh(c); return; }
      if (reg >= 0xB0 && reg <= 0xB8) {
        const c = this.channels[reg - 0xB0];
        c.fnum = (c.fnum & 0xFF) | ((val & 3) << 8);
        c.block = (val >> 2) & 7;
        this._refreshCh(c);
        const on = !!(val & 0x20);
        if (on !== c.kon) {
          c.kon = on;
          this._key(c.slots[0], 1, on);
          this._key(c.slots[1], 1, on);
        }
        return;
      }
      if (reg >= 0xC0 && reg <= 0xC8) { const c = this.channels[reg - 0xC0]; c.fb = (val >> 1) & 7; c.cnt = val & 1; return; }
      const si = reg & 0x1F;
      const ch = SLOT_CH[si];
      if (ch < 0) return;
      const s = this.channels[ch].slots[SLOT_OP[si]];
      switch (reg & 0xE0) {
        case 0x20:
          s.am = !!(val & 0x80); s.vib = !!(val & 0x40); s.egt = !!(val & 0x20); s.ksrFlag = !!(val & 0x10);
          s.mul = MUL_TAB[val & 0x0F];
          this._refreshCh(this.channels[ch]);
          break;
        case 0x40: s.ksl = (val >> 6) & 3; s.tl = (val & 0x3F) << 3; this._refreshCh(this.channels[ch]); break;
        case 0x60: s.ar = (val >> 4) & 15; s.dr = val & 15; break;
        case 0x80: s.sl = SL_TAB[(val >> 4) & 15]; s.rr = val & 15; break;
        case 0xE0: if (this.hasWave) s.ws = val & 3; break;
      }
    }

    // 位相増分・キースケールレート・KSL減衰を再計算
    _refreshCh(c) {
      c.kcode = (c.block << 1) | (this.nts ? (c.fnum >> 8) & 1 : (c.fnum >> 9) & 1);
      const kslBase = Math.max(0, KSL_TAB[c.fnum >> 6] - ((8 - c.block) << 3)); // 0..64(0.375dB×2単位)
      for (const s of c.slots) {
        s.rks = s.ksrFlag ? c.kcode : (c.kcode >> 2);
        // (kslBase<<1)>>shift は0.375dB単位 → 家内単位(0.09375dB)へ×4
        s.kslAtt = s.ksl ? (((kslBase << 1) >> KSL_SHIFT[s.ksl]) << 2) : 0;
        // incはビブラート適用込みで毎サンプル計算する(_slotInc)ので、素の値だけ持つ
      }
    }

    // ビブラート込みの位相増分。f2 = fnum<<1 の領域で8ステップ表(opllNukedと同じ)を適用
    _slotInc(c, s) {
      let f2 = c.fnum << 1;
      if (s.vib) {
        const step = (this.lfoCnt >> 10) & 7;
        const d = this.vibDeep ? 0 : 1; // 浅い時は半分
        switch (step) {
          case 1: case 3: f2 += f2 >> (8 + d); break;
          case 2: f2 += f2 >> (7 + d); break;
          case 5: case 7: f2 -= f2 >> (8 + d); break;
          case 6: f2 -= f2 >> (7 + d); break;
        }
      }
      return ((((f2 << c.block) >> 1) * s.mul) >> 1) & PHASE_MASK;
    }

    // キーオン/オフ(src: 1=メロディKON, 2=リズム)
    _key(s, src, on) {
      const before = s.keySrc;
      if (on) s.keySrc |= src; else s.keySrc &= ~src;
      if (before === 0 && s.keySrc) {
        s.phase = 0;
        if (s.rate(s.ar) >= 62) { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
        else { s.state = EG_ATT; }
      } else if (before && s.keySrc === 0) {
        if (s.state > EG_REL) s.state = EG_REL;
      }
    }

    // 0xBDのリズムキービット変化を各スロットへ(BD=ch6両op、HH=ch7 mod、SD=ch7 car、
    // TOM=ch8 mod、CYM(TC)=ch8 car)
    _rhythmKeys(prev, val) {
      const en = !!(val & 0x20);
      const key = (bit, slots) => {
        const on = en && !!(val & bit);
        for (const s of slots) this._key(s, 2, on);
      };
      key(0x10, [this.channels[6].slots[0], this.channels[6].slots[1]]); // BD
      key(0x01, [this.channels[7].slots[0]]);                            // HH
      key(0x08, [this.channels[7].slots[1]]);                            // SD
      key(0x04, [this.channels[8].slots[0]]);                            // TOM
      key(0x02, [this.channels[8].slots[1]]);                            // CYM
    }

    // Y8950: データレジスタ(0x0F)へのCPU書込み(REC|MEMDATAモードでメモリへ格納)
    _dtWriteData(v) {
      if ((this.adpcmB.regs[0x00] & 0x60) !== 0x60) return;
      if (!this.romB || !(this.romB instanceof Uint8Array) || this.romB.length < Y8950_RAM_SIZE) {
        const n = new Uint8Array(Y8950_RAM_SIZE);
        if (this.romB) n.set(this.romB.subarray(0, Math.min(this.romB.length, n.length)), 0);
        this.romB = n;
      }
      this.romB[this._dtWriteAddr & (Y8950_RAM_SIZE - 1)] = v;
      this._dtWriteAddr++;
      if (this._pitchCache) this._pitchCache.clear();
    }

    // ── EG(毎サンプル。OPLのEGクロックはfs) ──
    _advanceEg() {
      const cnt = ++this.egCnt;
      for (const c of this.channels) {
        for (const s of c.slots) {
          switch (s.state) {
            case EG_ATT: {
              const r = s.rate(s.ar);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                const inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                s.volume += (~s.volume * inc) >> 3;
                if (s.volume <= 0) { s.volume = 0; s.state = (s.sl === 0 && s.egt) ? EG_SUS : EG_DEC; }
              }
              break;
            }
            case EG_DEC: {
              const r = s.rate(s.dr);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= s.sl) {
                  s.volume = Math.min(s.volume, EG_MAX);
                  // EGT=1: SLで保持(キーオフでEG_RELへ) / EGT=0: SL以降もRRレートで減衰(打楽器型。
                  // EG_RELはキーオン状態と無関係に進むのでそのまま流用できる)
                  s.state = s.egt ? EG_SUS : EG_REL;
                }
              }
              break;
            }
            case EG_SUS:
              break; // EGT=1はキーオフまで保持
            case EG_REL: {
              const r = s.rate(s.rr);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= EG_MAX) { s.volume = EG_MAX; s.state = EG_OFF; }
              }
              break;
            }
          }
        }
      }
    }

    // ── LFO(AM: 210ステップ三角×64サンプル≈3.7Hz / VIB: 8ステップ×1024サンプル≈6.1Hz) ──
    _advanceLfo() {
      this.lfoCnt = (this.lfoCnt + 1) & 0xFFFF;
      if ((this.lfoCnt & 63) === 0) {
        // 三角波 0..26(0.1875dB単位、MAME fmopl同様)を0.5ずつ上下(105ステップ×2)
        if (this.amDir === 0) { if (++this.amStep >= 105) this.amDir = 1; }
        else { if (--this.amStep <= 0) this.amDir = 0; }
        this.amVal = (this.amStep * 26 / 105) | 0;
      }
      // ノイズLFSR(23bit、タップ14。opllNuked/実チップと同型)。毎サンプル1シフト
      let nbit = (this.noise ^ (this.noise >>> 14)) & 1;
      nbit |= this.noise === 0 ? 1 : 0;
      this.noise = ((nbit << 22) | (this.noise >>> 1)) >>> 0;
    }
    _amAtt() { // 家内単位(0.09375dB)
      const v = this.amDeep ? this.amVal : (this.amVal >> 2);
      return v << 1; // 0.1875dB → ×2
    }

    // ── オペレータ出力(波形選択込み) ──
    _opOut(s, att, modIndex) {
      const idx = ((s.phase >> PHASE_TO_SIN) + modIndex) & SIN_MASK;
      return this._wave(s.ws, idx, att);
    }
    _wave(ws, idx, att) {
      if (!this.wse || ws === 0) {
        const a = att + SIN_ATT[idx];
        return a >= EXP_LEN ? 0 : SIN_SIGN[idx] * EXP_TAB[a];
      }
      switch (ws) {
        case 1: { // 半サイン(後半無音)
          if (idx & 512) return 0;
          const a = att + SIN_ATT[idx];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
        case 2: { // 絶対値サイン
          const a = att + SIN_ATT[idx & 511];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
        default: { // 四半パルス(各半周期の前半のみ)
          if (idx & 256) return 0;
          const a = att + SIN_ATT[idx & 255];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
      }
    }
    _egOut(s) { return Math.min(EG_MAX, s.volume + s.tl + s.kslAtt + (s.am ? this._amAtt() : 0)); }

    // リズム用: スロットの位相からサイン索引(HH/SD/CYMは実機の位相ビット細工)
    _rhythmIndex(kind, hhPhase, tcPhase) {
      const hh2 = (hhPhase >> (2 + PHASE_TO_SIN)) & 1, hh3 = (hhPhase >> (3 + PHASE_TO_SIN)) & 1;
      const hh7 = (hhPhase >> (7 + PHASE_TO_SIN)) & 1, hh8 = (hhPhase >> (8 + PHASE_TO_SIN)) & 1;
      const tc3 = (tcPhase >> (3 + PHASE_TO_SIN)) & 1, tc5 = (tcPhase >> (5 + PHASE_TO_SIN)) & 1;
      const rmBit = (hh2 ^ hh7) | (hh3 ^ tc5) | (tc3 ^ tc5);
      const nz = this.noise & 1;
      if (kind === 'hh') return ((rmBit << 9) | ((rmBit ^ nz) ? 0xd0 : 0x34)) & SIN_MASK;
      if (kind === 'sd') return ((hh8 << 9) | ((hh8 ^ nz) << 8)) & SIN_MASK;
      return ((rmBit << 9) | 0x100) & SIN_MASK; // cym(TC)
    }

    _calcSample() {
      this._advanceEg();
      this._advanceLfo();
      const rhythmOn = !!(this.rhythm & 0x20);
      let out = 0;
      // 位相を全スロット進める(進める前の値で今サンプルを計算)
      const phases = [];
      for (const c of this.channels) {
        for (const s of c.slots) {
          phases.push(s.phase);
          s.phase = (s.phase + this._slotInc(c, s)) & PHASE_MASK;
        }
      }
      const melodyN = rhythmOn ? 6 : 9;
      for (let i = 0; i < melodyN; i++) {
        const c = this.channels[i];
        const [m, cr] = c.slots;
        const fbIn = c.fb ? ((m.prev[0] + m.prev[1]) >> (10 - c.fb)) : 0;
        const om = this._opOut(m, this._egOut(m), fbIn);
        m.prev[0] = m.prev[1]; m.prev[1] = om;
        let o;
        if (c.cnt) o = om + this._opOut(cr, this._egOut(cr), 0);
        else o = this._opOut(cr, this._egOut(cr), om >> 1);
        if (!this.mute[i]) out += o * this.vol[i];
      }
      if (rhythmOn) {
        const ch6 = this.channels[6], ch7 = this.channels[7], ch8 = this.channels[8];
        const hhPhase = phases[7 * 2], tcPhase = phases[8 * 2 + 1];
        // BD: 通常の2op FM(×2)
        {
          const [m, cr] = ch6.slots;
          const fbIn = ch6.fb ? ((m.prev[0] + m.prev[1]) >> (10 - ch6.fb)) : 0;
          const om = this._opOut(m, this._egOut(m), fbIn);
          m.prev[0] = m.prev[1]; m.prev[1] = om;
          const o = ch6.cnt ? this._opOut(cr, this._egOut(cr), 0) : this._opOut(cr, this._egOut(cr), om >> 1);
          if (!this.mute[MUTE_BD]) out += 2 * o * this.vol[MUTE_BD];
        }
        // HH(ch7 mod) / SD(ch7 car) / TOM(ch8 mod) / CYM(ch8 car): 単オペ×2
        const one = (s, idx) => { const a = this._egOut(s); return this._wave(0, idx, a); };
        {
          const s = ch7.slots[0];
          const o = one(s, this._rhythmIndex('hh', hhPhase, tcPhase));
          if (!this.mute[MUTE_HH]) out += 2 * o * this.vol[MUTE_HH];
        }
        {
          const s = ch7.slots[1];
          const o = one(s, this._rhythmIndex('sd', hhPhase, tcPhase));
          if (!this.mute[MUTE_SD]) out += 2 * o * this.vol[MUTE_SD];
        }
        {
          const s = ch8.slots[0];
          const o = one(s, (phases[8 * 2] >> PHASE_TO_SIN) & SIN_MASK);
          if (!this.mute[MUTE_TOM]) out += 2 * o * this.vol[MUTE_TOM];
        }
        {
          const s = ch8.slots[1];
          const o = one(s, this._rhythmIndex('cym', hhPhase, tcPhase));
          if (!this.mute[MUTE_CYM]) out += 2 * o * this.vol[MUTE_CYM];
        }
      }
      // ADPCM-B(Y8950): FMサンプルと同レートでクロック
      if (this.hasAdpcm) {
        this.adpcmB.clock();
        this.adpcmOut = (!this.mute[MUTE_ADPCM] && this.adpcmB.playing)
          ? this.adpcmB.value() * this.vol[MUTE_ADPCM] * (8192 / 16384) : 0;
      }
      // 9ch合算を±1.0程度へ(ym2151の按分と同じ感覚)
      this.last = (out + this.adpcmOut) / (8192 * 6);
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return this.last; }
  }

  // 鍵盤表示の波形列/大波形用: いまのEG状態・波形選択(WS)・接続・帰還で2opを定常状態として
  // 1周期(キャリア基準128点)合成する(ym2151.js snapshot の簡易合成と同じ考え方)。
  // ★これが無いと鍵盤の波形アイコンが汎用FMアイコン(=サイン波)になり、YM3812の波形選択も
  //   モジュレーションも見えず「波形が全部サイン波」に見える(2026-09-07)
  function synthOplWave(chip, c) {
    const N = 128;
    const [m, cr] = c.slots;
    const wave = new Array(N).fill(0);
    const ratio = (m.mul || 1) / (cr.mul || 1);
    const attM = chip._egOut(m), attC = chip._egOut(cr);
    let p0 = 0, p1 = 0, mx = 1e-6;
    // 帰還を定常化するため2周期回して後半だけ採る
    for (let n = 0; n < 2 * N; n++) {
      const k = n % N;
      const phm = Math.round(k / N * SIN_LEN * ratio) & SIN_MASK;
      const phc = Math.round(k / N * SIN_LEN) & SIN_MASK;
      const fbIn = c.fb ? ((p0 + p1) >> (10 - c.fb)) : 0;
      const om = chip._wave(m.ws, (phm + fbIn) & SIN_MASK, attM);
      p0 = p1; p1 = om;
      const v = c.cnt ? om + chip._wave(cr.ws, phc, attC) : chip._wave(cr.ws, (phc + (om >> 1)) & SIN_MASK, attC);
      if (n >= N) { wave[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v); }
    }
    for (let k = 0; k < N; k++) wave[k] /= mx;
    return wave;
  }

  // ── 鍵盤表示用スナップショット ──
  // channels[9]: { freq, vol, rawVol, active, keyOn, tlVol, patch, waveData } + rhythm行(rhythmOn時):
  // rhythm: { on, bd:{...}, sd, tom, cym, hh } 各 { keyOn, vol, freq(TOM/HH/SDはch7/8のfnum由来) }
  // opt.skipWave=true で waveData(表示専用の合成波形128点)を作らない(先読みキャプチャ向け)
  Emu.snapshotOPL = function (chip, opt) {
    const skipWave = !!(opt && opt.skipWave);
    const out = { channels: [], rhythm: null };
    const rhythmOn = !!(chip.rhythm & 0x20);
    const melodyN = rhythmOn ? 6 : 9;
    const freqOf = (c, s) => c.fnum > 0 ? c.fnum * Math.pow(2, c.block - 1) * chip.sampleRate / (1 << 19) * (s.mul / 2) : 0;
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.channels[i];
      const cr = c.slots[1];
      const inMelody = i < melodyN;
      const carAtt = Math.min(EG_MAX, cr.volume + cr.tl);
      const modS = c.slots[0];
      const anyOn = inMelody && (cr.state !== EG_OFF || (c.cnt === 1 && modS.state !== EG_OFF));
      const vol = anyOn ? Math.max(0, 1 - carAtt / EG_MAX) : 0;
      const tlVol = Math.max(0, 1 - Math.min(504, cr.tl) / 504);
      const freq = freqOf(c, cr);
      const active = anyOn && vol > 0.02 && freq > 0;
      out.channels.push({
        freq, vol, rawVol: Math.round(vol * 15), active, keyOn: inMelody && c.kon, tlVol,
        panL: 1, panR: 1,
        waveData: (active && !skipWave) ? synthOplWave(chip, c) : null,
        patch: Emu.decodeOplPatch(chip.regs, i, chip.hasWave)
      });
    }
    if (rhythmOn) {
      const r = chip.rhythm;
      // freqSlot: 音程表示に使うスロット(BD=ch6キャリア、TOM=ch8モジュレータ)。SD/CYM/HHは音程なし
      const drum = (slots, bit, c, freqSlot) => {
        let att = EG_MAX;
        let on = false;
        for (const s of slots) { if (s.state !== EG_OFF) { on = true; att = Math.min(att, Math.min(EG_MAX, s.volume + s.tl)); } }
        return { keyOn: !!(r & bit), active: on && att < EG_MAX - 16, vol: on ? Math.max(0, 1 - att / EG_MAX) : 0,
                 freq: c ? freqOf(c, freqSlot) : 0 };
      };
      const ch6 = chip.channels[6], ch7 = chip.channels[7], ch8 = chip.channels[8];
      out.rhythm = {
        on: true,
        bd: drum(ch6.slots, 0x10, ch6, ch6.slots[1]),
        hh: drum([ch7.slots[0]], 0x01, null, null),
        sd: drum([ch7.slots[1]], 0x08, null, null),
        tom: drum([ch8.slots[0]], 0x04, ch8, ch8.slots[0]),
        cym: drum([ch8.slots[1]], 0x02, null, null)
      };
    }
    if (chip.hasAdpcm) {
      const B = chip.adpcmB;
      const lvl = B.regs[0x0B];
      const rateB = B.rate();
      const pb = (B.seq && chip.samplePitch) ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
      out.adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
        panL: 1, panR: 1, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
        pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual),
        sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
        waveData: pb ? pb.wave : null,
        sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
        refRate: chip.sampleRate / 3 };
    }
    return out;
  };

  // レジスタ影から2op音色を取り出す。鍵盤の音色表示は既存のOPLL書式(formatOpllPatch)を
  // 流用するため type:'opll' 互換の形で返す(PM=VIB, EG=EGT, KR=KSR, KL=KSL, WF=半波近似
  // (OPL2のWS1-3を1bitへ落とす)。CNT=1(加算接続)とWSの2bit値はOPLLに表現が無いので
  // 表示上は落ちる。inst=0は「ユーザー音色」表示のため)。
  Emu.decodeOplPatch = function (regs, ch, hasWave) {
    const so = [(ch % 3) + ((ch / 3) | 0) * 8, (ch % 3) + 3 + ((ch / 3) | 0) * 8];
    const wse = hasWave && !!(regs[0x01] & 0x20);
    const op = (s) => ({
      AM: (regs[0x20 + s] >> 7) & 1, PM: (regs[0x20 + s] >> 6) & 1, EG: (regs[0x20 + s] >> 5) & 1,
      KR: (regs[0x20 + s] >> 4) & 1, ML: regs[0x20 + s] & 15,
      KL: (regs[0x40 + s] >> 6) & 3, TL: regs[0x40 + s] & 0x3F,
      AR: (regs[0x60 + s] >> 4) & 15, DR: regs[0x60 + s] & 15,
      SL: (regs[0x80 + s] >> 4) & 15, RR: regs[0x80 + s] & 15,
      WF: (wse && (regs[0xE0 + s] & 3) >= 1) ? 1 : 0,
      FB: (regs[0xC0 + ch] >> 1) & 7
    });
    return { type: 'opll', inst: 0, cnt: regs[0xC0 + ch] & 1, mod: op(so[0]), car: op(so[1]) };
  };

  // 表示用サンプルピッチ解析API(Y8950 ADPCM-B、romB/_pitchCacheのみ参照)
  if (Emu.OpnAdpcm && Emu.OpnAdpcm.attachSampleApi) Emu.OpnAdpcm.attachSampleApi(OPLAudio.prototype);

  Emu.OPL_MUTE = { BD: MUTE_BD, SD: MUTE_SD, TOM: MUTE_TOM, CYM: MUTE_CYM, HH: MUTE_HH, ADPCM: MUTE_ADPCM, NUM: NUM_MUTE };
  Emu.OPLAudio = OPLAudio;
})(globalThis);

/*
 * KSS(MSX)実行用メモリ/IOバス
 * MML.Emu.KssBus
 *
 * libkss (digital-sound-antiques) の src/vm/vm.c + src/vm/mmap.c を参照実装として移植。
 * MSX実機と同じく 8KB×8ページのページマップ方式でメモリを構成し、
 * 各ページの読み/書き先を「メインRAM」または「拡張バンクROM」へ張り替える。
 * 旧実装のように bank データを mem へコピーすると、16Kバンクモードで
 * 0x8000-0xBFFF のメインRAM内容が破壊されてバンクを戻せなくなるため、
 * 必ずページ参照の張り替えで表現すること。
 *
 * バンク切替(KSS仕様):
 *   - 8Kバンクモード : メモリ書込 0x9000(→page4=0x8000-0x9FFF) / 0xB000(→page5=0xA000-0xBFFF)
 *   - 16Kバンクモード: I/Oポート 0xFE 書込 (→page4-5=0x8000-0xBFFF、バンクサイズ0x4000)
 *   16Kモードは「メモリ書込によるバンク切替」を一切持たない。ここを取り違えると
 *   16Kバンク型タイトル(Xak/Ys/F1 Spirit 3D/Final Fantasy 等)が全く鳴らない。
 *
 * SCC: libkss VM_SCC_AUTO 相当。sccBase(既定0x9000、0xBFFEへの書込で0xB000へ移動)を基準に
 *   +0x000 = 有効化/モードレジスタ、+0x800-0x8FF = 音源レジスタ。
 *   読み出しはSCCへ向けない(実バンクROM/RAMの内容を返す)。libkssも同様で、
 *   バンク切替後の 0x9800-0x9FFF から曲データを読むタイトルを壊さないために必要。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PAGE_SIZE = 0x2000;
  const NUM_PAGES = 8;

  // 実BIOS ROMを積んでいないため、libkssと同じく 0x0000-0x3FFF を 0xC9(RET) で
  // 埋めておく。どのBIOSエントリへCALLされても即RETするので、ゼロ埋めメモリを
  // コードとして暴走実行する事故が起きない(旧実装のJSトラップテーブルと違い、
  // KSS本体のデータが同アドレスへロードされた場合は上書きされて正しく無効化される)。
  const WRTPSG_STUB = [0xD3, 0xA0, 0xF5, 0x7B, 0xD3, 0xA1, 0xF1, 0xC9]; // 0x0001: OUT(A0),A / LD A,E / OUT(A1),A / RET
  const RDPSG_STUB = [0xD3, 0xA0, 0xDB, 0xA2, 0xC9];                    // 0x0009: OUT(A0),A / IN A,(A2) / RET
  const BIOS_JUMPS = [0xC3, 0x01, 0x00, 0xC3, 0x09, 0x00];              // 0x0093: JP 0001 (WRTPSG) / 0x0096: JP 0009 (RDPSG)

  class KssBus {
    /**
     * @param {object} header - KSS.parseHeader() の結果
     * @param {Uint8Array} songData - ヘッダを除いた曲データ(header.dataOffset以降)
     */
    constructor(header, songData) {
      this.header = header;
      this.songData = songData;
      this.mem = new Uint8Array(0x10000);
      this.chips = {}; // 'psg' | 'scc' | 'opll' | (将来)'opl'
      this.onWrite = null; // (addr, value) => void
      this.onIoWrite = null; // (port, value) => void

      this.bankMode = header.bankMode; // '8K' | '16K'
      this.bankNum = header.bankNum;
      this.bankOffset = header.bankOffset;
      this.bankSize = this.bankMode === '8K' ? 0x2000 : 0x4000;
      this.hasBanking = this.bankNum > 0;
      this.ramMode = !!(header.device && header.device.ramMode);

      // libkss: scc_disable = (bank_mode == 16K) ? ram_mode : 0
      // 16Kバンクモード + RAMモードのタイトル(F1 Spirit 3D / Final Fantasy / Ys 等)は
      // SCCを積んでおらず、0x9800台をただのRAMとして使うためSCCデコードを止める必要がある。
      this.sccDisable = this.bankMode === '16K' ? this.ramMode : false;

      // 拡張バンク(初期データの直後に連結されている)を bankSize 単位で切り出す。
      // ヘッダのバンク数に対しファイルが短いことは実在するので0埋めで補う。
      this.banks = [];
      if (this.hasBanking) {
        const base = Math.min(header.dataLength, songData.length);
        for (let i = 0; i < this.bankNum; i++) {
          const bank = new Uint8Array(this.bankSize);
          const from = base + i * this.bankSize;
          if (from < songData.length) {
            bank.set(songData.subarray(from, Math.min(from + this.bankSize, songData.length)));
          }
          this.banks.push(bank);
        }
      }

      // ページマップ: readPage[p] は必ず Uint8Array(0x2000)、
      // writePage[p] が null のページは書込無効(ROM/読出専用領域)。
      this.mainPage = [];
      for (let p = 0; p < NUM_PAGES; p++) {
        this.mainPage.push(this.mem.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE));
      }
      this.dummyRead = new Uint8Array(PAGE_SIZE); // 未定義バンクは0を返す(libkss dummy_read_map)
      this.readPage = new Array(NUM_PAGES);
      this.writePage = new Array(NUM_PAGES);

      this.reset();
    }

    /** メインメモリ・ページマップ・SCC状態を初期状態へ戻す(曲切替時にも呼ぶ) */
    reset() {
      const header = this.header;
      const songData = this.songData;

      // libkssと同じ順序: 全域0xC9 → 0x4000以降を0クリア → BIOSスタブ → 曲データロード
      this.mem.fill(0xC9);
      this.mem.fill(0x00, 0x4000);
      this.mem.set(WRTPSG_STUB, 0x0001);
      this.mem.set(RDPSG_STUB, 0x0009);
      this.mem.set(BIOS_JUMPS, 0x0093);

      const loadAddr = header.loadAddr & 0xFFFF;
      let len = Math.min(header.dataLength, songData.length);
      if (loadAddr + len > 0x10000) len = 0x10000 - loadAddr;
      if (len > 0) this.mem.set(songData.subarray(0, len), loadAddr);

      for (let p = 0; p < NUM_PAGES; p++) {
        this.readPage[p] = this.mainPage[p];
        this.writePage[p] = this.mainPage[p];
      }
      // RAMモードでなければ 0x8000-0xBFFF は読出専用(バンクROMが差し変わる領域)
      this.selectMainBankPage();

      this.sccBase = 0x9000;  // 0xBFFEへの書込で0xB000(SCC+窓)へ移動
      this.sccActive = true;  // libkss VM_SCC_AUTO は初期状態から有効
      this.sccMode = 0;       // 0=classic(SCC) 1=SCC+
      this.bankSelect = [0, 0];
    }

    registerChip(name, chip) {
      this.chips[name] = chip;
    }

    /** 0x8000-0xBFFF をメインメモリへ戻す(16Kバンク範囲外の値が書かれたとき) */
    selectMainBankPage() {
      this.readPage[4] = this.mainPage[4];
      this.readPage[5] = this.mainPage[5];
      this.writePage[4] = this.ramMode ? this.mainPage[4] : null;
      this.writePage[5] = this.ramMode ? this.mainPage[5] : null;
    }

    /** 16Kバンクモード: 0x8000-0xBFFF へ 0x4000 バイトのバンクを割り当てる */
    selectBank16(bankNumber) {
      const idx = bankNumber - this.bankOffset;
      if (idx < 0 || idx >= this.banks.length) { this.selectMainBankPage(); return; }
      const bank = this.banks[idx];
      this.readPage[4] = bank.subarray(0, PAGE_SIZE);
      this.readPage[5] = bank.subarray(PAGE_SIZE, PAGE_SIZE * 2);
      this.writePage[4] = null; // 拡張バンクはROM(書込は捨てる)
      this.writePage[5] = null;
    }

    /** 8Kバンクモード: page(4=0x8000 / 5=0xA000) へ 0x2000 バイトのバンクを割り当てる */
    selectBank8(page, bankNumber) {
      const idx = bankNumber - this.bankOffset;
      this.readPage[page] = (idx >= 0 && idx < this.banks.length) ? this.banks[idx] : this.dummyRead;
      this.writePage[page] = null;
    }

    // --- CPUバス(メモリ) ---
    read(addr) {
      addr &= 0xFFFF;
      return this.readPage[addr >>> 13][addr & 0x1FFF];
    }

    write(addr, value) {
      addr &= 0xFFFF;
      value &= 0xFF;
      if (this.onWrite) this.onWrite(addr, value);

      if (!this.sccDisable && this.chips.scc) this._sccWrite(addr, value);

      // 8Kバンクモードのバンク切替レジスタ(Konami SCCマッパー)。
      // 実機は 0x9000-0x97FF / 0xB000-0xB7FF の全域でデコードする。
      if (this.hasBanking && this.bankMode === '8K') {
        if (addr >= 0x9000 && addr <= 0x97FF) { this.bankSelect[0] = value; this.selectBank8(4, value); }
        else if (addr >= 0xB000 && addr <= 0xB7FF) { this.bankSelect[1] = value; this.selectBank8(5, value); }
      }

      const page = this.writePage[addr >>> 13];
      if (page) page[addr & 0x1FFF] = value;
    }

    // libkss vm.c memwrite + emu2212 SCC_write 相当のSCCアドレスデコード
    _sccWrite(addr, value) {
      const scc = this.chips.scc;
      // SCC+モードレジスタ: アクセス窓を 0x9000(SCC) / 0xB000(SCC+) へ切り替える
      if ((addr & 0xFFFE) === 0xBFFE) { this.sccBase = 0x9000 | ((value & 0x20) << 8); return; }
      // VM_SCC_AUTO: 0x9000への非ゼロ書込(=Konamiマッパーのバンク選択)でもSCCを有効扱いにする。
      // 0x3Fトリックを踏まずに 0x9800台へ直接書くタイトル(Space Manbow等)を鳴らすために必要。
      if (addr === 0x9000 && value !== 0) value = 0x3F;

      if (addr < this.sccBase) return;
      const off = addr - this.sccBase;
      if (off === 0) {
        if (value === 0x3F) { this.sccMode = 0; this.sccActive = true; }
        else if (value & 0x80) { this.sccMode = 1; this.sccActive = true; }
        else { this.sccMode = 0; this.sccActive = false; }
        return;
      }
      if (!this.sccActive || off < 0x800 || off > 0x8FF) return;
      if (this.sccMode) scc.writePlus(off - 0x800, value);
      else scc.writeClassic(off - 0x800, value);
    }

    // --- CPUバス(IOポート、下位8bitのみデコード。実MSXハードウェアと同じ簡略化) ---
    ioRead(port) {
      port &= 0xFF;
      if (this.chips.psg && port === 0xA2) return this.chips.psg.readData();
      if (this.chips.opl) {
        if (port === 0xC1) return this.chips.opl.readData();
        if (port === 0xC0) return this.chips.opl.readStatus();
      }
      return 0xFF;
    }

    ioWrite(port, value) {
      port &= 0xFF;
      value &= 0xFF;
      if (this.onIoWrite) this.onIoWrite(port, value);

      if (this.chips.psg && (port === 0xA0 || port === 0xA1)) {
        this.chips.psg.ioWrite(port, value);
      } else if (this.chips.opll && (port === 0x7C || port === 0x7D || port === 0xF0 || port === 0xF1)) {
        // 0xF0/0xF1 は FM-PAC の別名ポート(libkss vm.c iowrite と同じく両方受ける)
        this.chips.opll.ioWrite(port === 0xF0 ? 0x7C : port === 0xF1 ? 0x7D : port, value);
      } else if (this.chips.opl && (port === 0xC0 || port === 0xC1)) {
        this.chips.opl.ioWrite(port, value);
      }

      // 16Kバンクモードのバンク切替はポート0xFEのみ(メモリ書込では切り替わらない)
      if (this.bankMode === '16K' && port === 0xFE) {
        this.bankSelect[0] = value;
        this.selectBank16(value);
      }
    }
  }

  Emu.KssBus = KssBus;
})(globalThis);

/*
 * KSSプレイヤー (Z80 CPU + KssBus + PSG/SCC/OPLL の統合)
 * MML.Emu.KssPlayer
 *
 * - initSong(index): INITルーチンを呼び出して曲を初期化(A=曲番号、libkss準拠)
 * - renderFrame(sampleRate): PLAYルーチンを1回呼び出し、1フレーム分の音声サンプルを生成
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * writeLogの1書込みを1つの整数へ詰める(2026-09-04)。
   *   bit0-15 = addr(メモリアドレス or I/Oポート) / bit16-23 = value / bit24 = io(1ならI/O)
   * 定義の実体は src/emulator/capture.js の Emu.kssPackWrite(KSS/VGM両方のWorkerバンドルに
   * 入る共通ファイル)。ここでは遅延参照だけ持つ(バンドル内の読み込み順に依存しないため)。
   * VGM側(vgmPlayer.js data.kss.writeLog)も同じ詰め方で作る。
   */
  const packWrite = (addr, value, io, frac) => Emu.kssPackWrite(addr, value, io, frac);

  // INIT/PLAY呼び出し時のスタックポインタ初期値(libkss exec_setup の 0xF380 と同じ。
  // MSX BIOSワークエリアの直下で、実機ドライバが LD SP,0F380h とするのと同じ位置)
  const STACK_TOP = 0xF380;

  class KssPlayer {
    /**
     * @param {Uint8Array} kssBytes - KSSファイルの完全なバイナリ
     */
    constructor(kssBytes) {
      this.header = MML.KSS.parseHeader(kssBytes);
      const songData = kssBytes.slice(this.header.dataOffset);

      this.bus = new Emu.KssBus(this.header, songData);

      // チップは常にPSG+SCCを用意する(SCCはヘッダフラグに現れないため、
      // バンク切替ありのKSSでは常時バスに配線しておくのが安全)。
      // FMPACはヘッダのdevice_flagで判定。OPL(未対応)は将来 this.bus.chips.opl として追加可能。
      this.psg = new Emu.AY8910Audio();
      this.scc = new Emu.SCCAudio();
      this.bus.registerChip('psg', this.psg);
      this.bus.registerChip('scc', this.scc);
      if (this.header.device.mode === 'MSX' && this.header.device.fmpac) {
        this.opll = new Emu.OPLLAudio();
        this.bus.registerChip('opll', this.opll);
      }
      // MSX-AUDIO(Y8950): ポート0xC0/0xC1(kssBus.js chips.opl)。3.58MHz駆動でclock/72=49716Hz
      if (this.header.device.mode === 'MSX' && this.header.device.msxAudio && Emu.OPLAudio) {
        this.opl = new Emu.OPLAudio(MML.KSS.Z80_CLOCK, { type: 'y8950' });
        this.bus.registerChip('opl', this.opl);
      }

      this.cpu = new Emu.CPUZ80(this.bus);

      // 音源チップは常にMSX標準の3.58MHzで駆動する。一方Z80は、FMPAC/MSX-AUDIO搭載曲では
      // libkss(getclk)と同じく倍速(7.16MHz)で回す。FM系ドライバは1フレームの処理が重く、
      // 3.58MHz相当のサイクル数ではPLAYが1フレーム内に終わらずテンポが崩れるため。
      this.clockHz = MML.KSS.Z80_CLOCK;
      const d = this.header.device;
      this.cpuClockHz = (d.mode === 'MSX' && (d.fmpac || d.msxAudio)) ? MML.KSS.Z80_CLOCK * 2 : MML.KSS.Z80_CLOCK;
      this.cpuCyclesPerChipCycle = this.cpuClockHz / this.clockHz;
      this.frameRate = this.header.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this.speedFactor = 1;
      this._playFrameAccum = 0;
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     */
    initSong(songIndex) {
      this.bus.reset(); // メインメモリ・バンクマップを再ロード(曲切替でも初期状態から始める)
      this.cpu.reset();
      this.psg.reset();
      this.scc.reset();
      if (this.opll) this.opll.reset();
      if (this.opl) this.opl.reset();
      this.cpu.a = songIndex & 0xFF;
      this.cpu.iff1 = false;
      this.cpu.iff2 = false;
      this.cpu.im = 1;

      // INITはlibkssと同じく「最大1秒相当のCPUサイクル」を上限に実行する。
      // ステップ数上限だと重いINIT(バンクからのデータ展開等)が途中で打ち切られる。
      this.cpu.sp = STACK_TOP;
      this.cpu.beginCall(this.header.initAddr);
      let cycles = 0;
      while (this.cpu.callActive && cycles < this.cpuClockHz) cycles += this.cpu.stepCall();
      this.cpu.callActive = false;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this._playFrameAccum = 0;
    }

    /**
     * 1フレーム分の音声サンプルを生成する。PLAYが1フレーム内に終わらない場合は
     * renderFrameを跨いで継続する(NsfPlayer.renderFrameと同じ設計)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - trueならmixSample()による波形合成を省略し、
     *   PLAY呼び出しタイミング・レジスタ書込ログに関わる部分(CPU実行・チップのclock())
     *   だけを実行する(鍵盤表示/ピアノロールの先読みキャプチャ用の軽量モード)。
     * @returns {Float32Array|null} regsOnly時はnull
     */
    renderFrame(sampleRate, regsOnly) {
      const cyclesPerSample = this.clockHz / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / this.frameRate);
      const out = regsOnly ? null : new Float32Array(samplesThisFrame);

      const cpu = this.cpu, psg = this.psg, scc = this.scc, opll = this.opll, opl = this.opl;

      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          // libkss exec_setup と同じく、PLAY呼び出しごとにSPを既定値へ戻す
          // (ドライバがINIT中に積んだ分でスタックが延々ドリフトするのを防ぐ)。
          cpu.sp = STACK_TOP;
          cpu.beginCall(this.header.playAddr);
        }
      }

      // cycleAccum/チップのclock()は常に3.58MHz基準。CPUだけ cpuCyclesPerChipCycle 倍で進める。
      const cpuPerChip = this.cpuCyclesPerChipCycle;
      for (let i = 0; i < samplesThisFrame; i++) {
        this.frameSampleFrac = i / samplesThisFrame; // 書込みログの分数フレーム時刻(captureKssSongAsync 参照)
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          if (this.cpuDebt <= 0) {
            if (cpu.callActive) this.cpuDebt += cpu.stepCall();
            else this.cpuDebt = cpuPerChip;
          }
          this.cpuDebt -= cpuPerChip;
          psg.clock();
          scc.clock();
          if (opll) opll.clock();
          if (opl) opl.clock();
          this.cycleAccum -= 1;
        }
        if (!regsOnly) {
          let sample = psg.mixSample() + scc.mixSample();
          if (opll) sample += opll.mixSample();
          // 0.7 = VGM側の較正比(CHIP_GAIN.opl 1.4 / ym2413 1.99)をKSSの素通しミックスへ写す
          if (opl) sample += opl.mixSample() * 0.7;
          out[i] = sample;
        }
      }
      return out;
    }
  }

  /**
   * KSSを指定秒数分オフラインレンダリングし、音声とフレーム毎のレジスタ書込ログを返す。
   * WAV書き出し・kss2mml変換・ピアノロールの先読みキャプチャで使う共通キャプチャ関数。
   * opt.regsOnly=true時は波形合成(renderFrameのmixSample呼び出し)を省略し、音声バッファも
   * 確保しない(ピアノロールはレジスタ書込ログだけで足りるため、実再生とメインスレッドを
   * 共有してもCPU負荷を抑えられる)。regsOnly時はより細かくyieldし、onProgressにはその時点
   * までの writeLog(同一配列参照、伸びていく)も渡すので途中経過で段階的に更新できる。
   * @param {Uint8Array} kssBytes
   * @param {object} opt - {songIndex, durationSeconds, sampleRate, mute, regsOnly}
   * @param {(done:number,total:number,writeLog:Array)=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, writeLog:Array<Array<{addr:number,value:number,io:boolean}>>, player:KssPlayer, frameRate:number}>}
   */
  Emu.captureKssSongAsync = async function (kssBytes, opt, onProgress) {
    const player = new KssPlayer(kssBytes);
    // INIT中の書込みも記録し、フレーム0の先頭に含める。
    // INITで一度だけ設定されPLAY中は二度と書かれないレジスタが実在するため
    // (SCC-I(SCC+)のモードレジスタ0xBFFEが代表例。これを取りこぼすと、writeLogを
    //  読むピアノロール/MML変換側はSCCのレジスタ窓が0xB800へ移ったことを知らず、
    //  スナッチャー系のSCCパートが「音符ゼロ」になる)。NSF側のinitWritesと同じ考え方。
    const initWrites = [];
    player.bus.onWrite = (addr, value) => initWrites.push(packWrite(addr, value, 0));
    player.bus.onIoWrite = (port, value) => initWrites.push(packWrite(port, value, 1));
    player.initSong(opt.songIndex || 0);
    player.bus.onWrite = null;
    player.bus.onIoWrite = null;
    if (opt.mute) {
      if (opt.mute.psg) Emu.applyMute(player.psg.mute, opt.mute.psg);
      if (opt.mute.scc) Emu.applyMute(player.scc.mute, opt.mute.scc);
      if (opt.mute.opll && player.opll) Emu.applyMute(player.opll.mute, opt.mute.opll);
      if (opt.mute.opl && player.opl) Emu.applyMute(player.opl.mute, opt.mute.opl);
    }
    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = new Float32Array(totalOutSamples);
    const writeLog = [];
    let outPos = 0;
    // ★2026-08-20 スライスを「フレーム数固定」から「時間予算固定」へ変更(NSFの
    // capture.js captureSongAsyncと同じ方式・同じ理由。端末速度差の自動吸収)。
    // Worker実行時(src/audio/capture-worker-client.js)はopt.yieldFn/sliceBudgetMsで
    // 上書きされる。f===0で必ず一度onProgressを発火するのも同様(最初のonProgressで
    // 実再生のplayer.load()が走るため)。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      const frameWrites = f === 0 ? initWrites : []; // フレーム0はINIT中の書込みから続ける
      player.bus.onWrite = (addr, value) => frameWrites.push(packWrite(addr, value, 0, player.frameSampleFrac));
      player.bus.onIoWrite = (port, value) => frameWrites.push(packWrite(port, value, 1, player.frameSampleFrac));
      const frameBuf = player.renderFrame(sampleRate, regsOnly);
      player.bus.onWrite = null;
      player.bus.onIoWrite = null;
      writeLog.push(Int32Array.from(frameWrites)); // 詰めた整数の型付き配列で持つ(packWrite参照)
      if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, writeLog);
        await yieldFn();
        // 曲切替/停止の連打で先読みキャプチャが何本も積み上がりCPUを食い合うのを防ぐため、
        // 呼び出し元から「もう不要」と言われたらここでループ自体を打ち切る(onProgress側だけ
        // 無視してもエミュレーション自体は最後まで回り続けてしまうため不十分だった)。
        if (opt.shouldCancel && opt.shouldCancel()) return { audio, writeLog, player, frameRate: player.frameRate };
        sliceStart = performance.now();
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, writeLog);
    return { audio, writeLog, player, frameRate: player.frameRate };
  };

  Emu.KssPlayer = KssPlayer;
})(globalThis);

/*
 * 再生ログ一括キャプチャ（プリレンダー）
 * MML.Emu.captureSong / MML.Emu.dcBlock
 *
 * INIT実行後、指定秒数分のPLAYルーチンを毎フレーム実行し、
 * - 全レジスタ書き込みのタイムラインログ
 * - 全フレーム分の音声波形（DCブロック済み）
 * を一括生成する。生成後はシーク・早送り・巻き戻しが
 * 音声バッファへのアクセスのみで完結する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * KSS形式writeLogの1書込みを1つの整数へ詰める(2026-09-04)。
   *   bit0-15 = addr(メモリアドレス or I/Oポート) / bit16-23 = value / bit24 = io(1ならI/O)
   *
   * {addr,value,io}のJSオブジェクトは実測75〜90B/件で、KSSは1フレーム平均84〜152件書くため
   * 60秒で27〜41MB(実RSS)を占めていた。詰めればフレームごとの Int32Array で4B/件になる
   * (実測 xak.kss 60秒: 27MB → 1.2MB)。型付き配列なので構造化クローン(キャプチャWorkerの
   * 差分送信)もそのまま通る。読む側は kss2mml/expansion/*.js と kss-stream-player.js と
   * roll-builders.js。
   *
   * ★定義場所はここ(capture.js)。KSS(kssPlayer.js)とVGM(vgmPlayer.js: AY/SSG/SCC/OPLL/OPLの
   *   書込みをKSS形式で積む)の両方が使い、両方のWorkerバンドルに入る唯一の共通ファイルのため。
   *   以前は kssPlayer.js にあり、VGMのWorkerバンドル(kssPlayer.jsを含まない)で
   *   「Emu.kssPackWrite is not a function」で落ちて、AY/SSG/OPLを使うVGMのロールが空になる
   *   (途中で落ちると取得済み範囲で打ち切られる)不具合の原因になっていた(2026-09-07)。
   */
  // frac: フレーム内の書込み時刻(0〜1、省略時0)を bit25-30 に 1/64 フレーム刻みで詰める(2026-09-08)。
  // kss2mml の AY/SCC 抽出器がソフトエンベロープの位相エイリアシング対策(hes2mml/expansion/wave.js
  // resampleSeq)に使う。writeLog の形(Int32Array のフレーム配列)は変えないので Worker プロトコルと
  // ロール構築(addr/value/io だけを見る)はそのまま。旧ログ(frac 無し)は 0 として扱われ従来どおり
  Emu.kssPackWrite = (addr, value, io, frac) => (addr & 0xFFFF) | ((value & 0xFF) << 16) | (io ? 0x1000000 : 0) |
    ((frac > 0 ? Math.min(63, Math.round(frac * 64)) : 0) << 25);
  Emu.kssUnpackFrac = (pw) => ((pw >>> 25) & 0x3F) / 64;

  /**
   * チャンネルごとのミュート設定をチップの mute プロパティへ反映する。
   * target がオブジェクトならキー一致、配列ならインデックス一致で上書きする。
   */
  Emu.applyMute = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = !!source[i];
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = !!source[k];
      }
    }
  };

  /**
   * チャンネルごとの音量(0〜2、1=100%で2まではブースト)設定をチップの vol プロパティへ
   * 反映する。applyMuteと同じkey/index一致方式(未指定のチャンネルは既存値=通常1のまま
   * 変更しない)。
   */
  Emu.applyVolume = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = Math.max(0, Math.min(2, source[i]));
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = Math.max(0, Math.min(2, source[k]));
      }
    }
  };

  // NESの非線形ミキサー出力(DCオフセット付き)をAC成分に変換するDCブロッカー
  Emu.dcBlock = function (samples) {
    const out = new Float32Array(samples.length);
    let prevX = 0, prevY = 0;
    const R = 0.999;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = x - prevX + R * prevY;
      out[i] = y;
      prevX = x;
      prevY = y;
    }
    return out;
  };

  /**
   * 楽曲キャプチャの共通セットアップ。player・バッファ・ログ配列を返す。
   * @private
   */
  function _setupCapture(nsfBytes, opt) {
    const songIndex = opt.songIndex || 0;
    const durationSeconds = opt.durationSeconds || 10;
    const sampleRate = opt.sampleRate || 44100;

    const player = new Emu.NsfPlayer(nsfBytes);
    // initSong の書き込みを runningRegs に先取りしてスナップショットの初期状態とする。
    // initWrites は同じ書き込みを順序付きで(重複アドレスも全て)記録したもの。
    // $F800/$4800(N163)・$C000/$E000(FME7)・$9010/$9030(VRC7)のようなラッチ+データ間接
    // アドレッシングのチップは、runningRegsの最終値スナップショットだけでは内部レジスタ
    // 全体を復元できない(同じ2アドレスに何度も書き込むため)ので、拡張音源の
    // buildTimeline側で書き込みシーケンスをそのまま再生できるようにこちらも保持する。
    const runningRegs = {};
    const initWrites = [];
    // NsfPlayer.initSong()は$4017(フレームカウンタリセット)・$4015(全チャンネル有効化)を
    // bus.write()を経由せずAPU.writeRegister()へ直接書き込むため、onWriteフックを
    // 通らずinitWritesに記録されない。NSF自体のINITルーチンがこれらを書き直さない曲
    // (例: アルマナの軌跡のようなFDS曲で2A03パルス/三角/ノイズ側を$4015再設定しない
    // ドライバ)だと、initWritesの再生だけで音源を組み立てるNsfReplayStreamPlayerでは
    // $4015が一度も有効化されず2A03が全チャンネル無音になる不具合があった。
    // initSong()内部の書き込み順序と同じ順で先に記録しておく(曲のINITが実際に
    // 書き直した場合は後続の通常記録で上書きされるので問題ない)。
    runningRegs[0x4017] = 0x40; initWrites.push({ addr: 0x4017, value: 0x40 });
    runningRegs[0x4015] = 0x0F; initWrites.push({ addr: 0x4015, value: 0x0F });
    player.bus.onWrite = (a, val) => { runningRegs[a] = val; initWrites.push({ addr: a, value: val }); };
    player.initSong(songIndex, !!opt.pal);
    player.bus.onWrite = null;

    if (opt.mute) {
      if (opt.mute.apu) Emu.applyMute(player.apu.mute, opt.mute.apu);
      if (opt.mute.expansion) {
        for (const [name, chip] of Object.entries(player.bus.expansion)) {
          if (opt.mute.expansion[name]) Emu.applyMute(chip.mute, opt.mute.expansion[name]);
        }
      }
    }

    const frameRate = opt.pal ? (1000000 / 19997) : Emu.FRAME_RATE_NTSC;
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * frameRate));
    const samplesPerFrame = sampleRate / frameRate;
    // regsOnly モードでは音声バッファ不要（巨大配列の確保・dcBlock をスキップ）
    const regsOnly = !!opt.regsOnly;
    const totalSamples = regsOnly ? 0 : Math.ceil(totalFrames * samplesPerFrame);

    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(totalFrames);
    const regSnapshots = new Array(totalFrames);
    const cpuSnapshots = new Array(totalFrames);
    const memSnapshots = new Array(totalFrames);
    const apuEnvSnapshots = new Array(totalFrames);
    // N163内部128byte RAMのフレームごとスナップショット。N163は$F800(アドレスラッチ)+$4800
    // (データ)の間接アドレッシングで、しかもドライバは位相バイトを「読み飛ばし」でスキップする
    // (読み出しもオートインクリメントを進める)。writeLogは書き込みしか記録しないため、
    // ログの再生だけではアドレスポインタがズレて内部RAMを正しく復元できない。ライブチップの
    // RAMを直接採取して nsf2mml抽出/ピアノロールへ渡す(この不一致がN163変換崩れの根因)。
    const n163Snapshots = new Array(totalFrames);

    let pendingWrites = [];
    player.bus.onWrite = (addr, value) => pendingWrites.push({ addr, value });

    // INIT後・PLAY前の初期レジスタ状態をスナップショット
    const initRegs = Object.assign({}, runningRegs);

    return { player, sampleRate, frameRate, totalFrames, samplesPerFrame, totalSamples,
             raw, writeLog, regSnapshots, cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, initRegs, initWrites,
             pendingWritesRef: { get current() { return pendingWrites; }, set(v) { pendingWrites = v; player.bus.onWrite = (a, val) => pendingWrites.push({ addr: a, value: val }); } } };
  }

  /**
   * APU矩形波1/2・ノイズの「実際に出力中の音量レベル」を取得する。
   * ハードウェアエンベロープ(減衰)使用時、レジスタの下位4bitは音量ではなく減衰速度なので、
   * 内部の decay 値(0-15)を読む必要がある。env=true なら減衰モード。
   * envelope.output() は constant時=設定音量 / 減衰時=現在のdecay値 を返す。
   */
  // DPCMサンプルのデルタ復号キャッシュ（(addr,len)が変わった時だけ再復号）
  let _dmcCache = { key: '' };
  function _dmcSample(bus, addr, len) {
    if (!bus || !len) return null;
    const key = addr + ':' + len;
    if (_dmcCache.key !== key) {
      const n = len * 8;
      const samples = new Float32Array(n);
      let level = 64; // 7bit DAC の中央から delta(+2/-2, 0..127クランプ) で再構成
      let k = 0;
      for (let b = 0; b < len; b++) {
        const byte = bus.read((addr + b) & 0xFFFF) & 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          if (byte & (1 << bit)) { if (level <= 125) level += 2; }
          else { if (level >= 2) level -= 2; }
          samples[k++] = (level - 64) / 64; // -1..1
        }
      }
      _dmcCache = { key, addr, len, samples };
    }
    return { addr, len, samples: _dmcCache.samples };
  }

  Emu.snapshotApuEnv = function (apu, fds, bus) {
    // level/env=音量エンベロープの実出力。len/period/mutedは「レジスタ値だけでは分からない
    // 実状態」で、長さカウンタによる自然消音・スイープユニットが書き換えた実周期・スイープ
    // 強制ミュートを鍵盤/ピアノロールの発音判定と音程表示に使う(nsf2mml/converter.jsの
    // extractPulseEvents/extractNoiseEventsが行うシミュレーションと同じ情報)。
    const rd = (ch) => ({ level: ch.envelope.output(), env: !ch.envelope.constant,
      len: ch.lengthCounter, period: ch.timerPeriod,
      muted: typeof ch.isMuted === 'function' ? ch.isMuted() : false });
    const out = { pulse1: rd(apu.pulse1), pulse2: rd(apu.pulse2), noise: rd(apu.noise) };
    // 三角波は音量レジスタが無く、長さカウンタ+線形カウンタだけで発音が止まる
    // seq: シーケンサ位置。三角波は消音中も最後の値をDCとして保持し、そのDCが
    // 非線形tndミキサー経由でノイズ/DPCMの聞こえ方に効くため、見かけ音量の計算に要る
    if (apu.triangle) out.triangle = { len: apu.triangle.lengthCounter, linear: apu.triangle.linearCounter,
                                       seq: apu.triangle.seqStep };
    // FDS $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を採取。
    // effectiveFreq: モジュレーション適用後の実ピッチ(内部単位)。鍵盤表示でMH<n>使用中の
    // 実際に揺れているピッチをHz換算する用途(生の$4082/4083周期だけでは変調前の値になる)。
    // modEnabled: モジュレーションユニットの実際の有効状態。$4087が一度も書かれていない
    // (曲がMH<n>を全く使わない)場合、生レジスタは既定値0のままでbit7=0=有効に見えて
    // しまう(実際は一度も有効化されていないのに鍵盤表示が常時ON扱いになるバグの原因)。
    // fds.modEnabled(インスタンスの実状態、既定false)を使えばこの誤検出を避けられる。
    if (fds) out.fds = { gain: fds.volGain, env: !!fds.volEnvEnabled, effectiveFreq: fds.effectiveFreq, modEnabled: !!fds.modEnabled };
    // DPCM: 実出力レベル(outputLevel 0-127)と、メモリ上のサンプルをデルタ復号した波形
    if (apu.dmc) {
      // playing: 実際にサンプルを読み進めている最中か($4015 bit4 の書込み値ではなく実状態。
      // 鍵盤/ロールの発声判定用。鳴り終わると bytesRemaining=0 かつ shiftReg を出し切る)
      // amp: 直近1フレームのDAC振幅(0〜127)=DPCMの体感音量。level(現在値)は波形の
      // 位置でしかなく音量にならないため、鍵盤表示の音量数値はこちらを使う
      const dmc = { level: apu.dmc.outputLevel, amp: apu.dmc.takeAmplitude(), seq: apu.dmc.seq || 0,
                    playing: apu.dmc.bytesRemaining > 0 || (apu.dmc.bitsRemaining > 0 && !apu.dmc.silence) };
      if (bus) {
        const s = _dmcSample(bus, apu.dmc.sampleAddr, apu.dmc.sampleLength);
        if (s) { dmc.addr = s.addr; dmc.len = s.len; dmc.samples = s.samples; }
      }
      out.dmc = dmc;
    }
    return out;
  };

  /** 1フレーム分を処理してバッファ・ログを更新する。posを返す。 */
  function _processFrame(ctx, f, pos) {
    const { player, sampleRate, totalSamples, raw, writeLog, regSnapshots,
            cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, pendingWritesRef } = ctx;
    pendingWritesRef.set([]);
    const frame = player.renderFrame(sampleRate);
    writeLog[f] = pendingWritesRef.current;
    for (const w of pendingWritesRef.current) runningRegs[w.addr] = w.value;
    // 書き込みが1件も無かったフレームは前フレームとスナップショットが同一なので、
    // オブジェクトを共有してアロケーション(=GC圧)を減らす。消費側(ピアノロール/
    // モニタ/nsf2mml)はいずれも読み取り専用アクセスのため共有しても安全。
    regSnapshots[f] = (f > 0 && pendingWritesRef.current.length === 0)
      ? regSnapshots[f - 1] : Object.assign({}, runningRegs);
    const n163 = player.bus.expansion && player.bus.expansion.n163;
    if (n163) n163Snapshots[f] = n163.ram.slice();
    cpuSnapshots[f] = {
      A: player.cpu.A, X: player.cpu.X, Y: player.cpu.Y,
      P: player.cpu.P, S: player.cpu.S, PC: player.cpu.PC
    };
    memSnapshots[f] = player.bus.mem.slice(0, 0x100);
    apuEnvSnapshots[f] = Emu.snapshotApuEnv(player.apu, player.bus.expansion && player.bus.expansion.fds, player.bus);
    for (let i = 0; i < frame.length && pos < totalSamples; i++, pos++) {
      raw[pos] = frame[i];
    }
    return pos;
  }

  function _buildResult(ctx) {
    return {
      audio: ctx.raw.length > 0 ? Emu.dcBlock(ctx.raw) : ctx.raw,
      sampleRate: ctx.sampleRate,
      totalFrames: ctx.totalFrames,
      samplesPerFrame: ctx.samplesPerFrame,
      writeLog: ctx.writeLog,
      regSnapshots: ctx.regSnapshots,
      cpuSnapshots: ctx.cpuSnapshots,
      memSnapshots: ctx.memSnapshots,
      apuEnvSnapshots: ctx.apuEnvSnapshots,
      n163Snapshots: ctx.n163Snapshots,
      initRegs: ctx.initRegs,
      initWrites: ctx.initWrites
    };
  }

  /**
   * 楽曲を一括キャプチャする（同期版・後方互換）
   * @param {Uint8Array} nsfBytes - 完全なNSFバイナリ（128バイトヘッダ含む）
   * @param {object} opt
   * @param {number} [opt.songIndex=0]
   * @param {number} [opt.durationSeconds=10]
   * @param {number} [opt.sampleRate=44100]
   * @param {boolean} [opt.pal=false]
   */
  Emu.captureSong = function (nsfBytes, opt = {}) {
    const ctx = _setupCapture(nsfBytes, opt);
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      pos = _processFrame(ctx, f, pos);
    }
    return _buildResult(ctx);
  };

  /**
   * 楽曲を非同期でキャプチャする（UI をブロックしない）
   * CHUNK_FRAMES フレームごとにブラウザへ制御を返すため、長尺でも UI がフリーズしない。
   * regsOnly時はチャンクを細かくし(ピアノロールの先読み用途で使われ、実再生と
   * メインスレッドを共有するため)、onProgressにはその時点までのregSnapshots/writeLog
   * (末尾は未確定=空のまま伸びていく同一配列参照)も渡すので、キャプチャ完了を待たずに
   * 途中経過だけでピアノロールを段階的に埋めていける。
   * @param {Uint8Array} nsfBytes
   * @param {object} opt - captureSong と同じオプション
   * @param {function(done:number, total:number, regSnapshots:Array, writeLog:Array, n163Snapshots:Array):void} [onProgress] - 進捗コールバック
   * @returns {Promise<object>} captureSong と同じ戻り値
   */
  Emu.captureSongAsync = async function (nsfBytes, opt = {}, onProgress = null) {
    const ctx = _setupCapture(nsfBytes, opt);
    const regsOnly = !!opt.regsOnly;
    // ★2026-08-20 スライス制御を「フレーム数固定(CHUNK_FRAMES)」から「時間予算固定」へ変更。
    // 端末の速度差(同じフレーム数でも掛かる時間はバラバラ)を自動吸収し、メインスレッド
    // 実行時は1スライスあたり最大~sliceBudgetMsしかブロックしない。Worker実行時
    // (src/audio/capture-worker-client.js経由)はUIをブロックしないため、呼び出し側が
    // 大きい予算とsetTimeoutより高速なyield(opt.yieldFn、4msクランプ回避)を渡して
    // スループット優先にできる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();
    let pos = 0;
    // regsOnly専用: 1フレーム=CPUサイクルCYCLES_PER_FRAME分、というサイクル駆動で
    // PLAYを刻む(NsfPlayer.renderFrame()と全く同じサイクル会計方式・クロック呼び出し)。
    // 省略するのはaudio.mixSample()と出力バッファへの書き込みだけ(regsOnlyの目的である
    // 「音声波形は要らない」を満たすのに必要十分)。
    // ★当初はapu.clock()/expansion.clock()自体も丸ごと省略していたが、これは誤りだった。
    // FDSの$4090(エンベロープ実測値読み出し)のように、ドライバがチップの内部状態を
    // 読み戻して「エンベロープが既定値まで減衰したら次の命令へ分岐する」種類の楽器
    // マクロを使う曲(Ai Senshi Nicol(FDS)等)では、clock()を呼ばないとエンベロープが
    // 初期値のまま一切減衰しないため、この分岐条件が実際のプレイとは異なる結果になり
    // (常に「まだ減衰していない」ため)、本来発生するはずの命令分岐先の書き込みが
    // 丸ごとwriteLogから欠落する不具合があった。clock()自体はmixSample()に比べて
    // 十分軽い(波形合成をしないだけ)ため、追加しても速度上のメリットはほぼ失われない。
    // cpuDebtは端数サイクルを次のフレームへ確実に持ち越す必要があるため、
    // renderFrame()と同じく「+=」で加算する(「=」で上書きすると端数が失われる)。
    const CYCLES_PER_FRAME = Emu.CPU_CLOCK_NTSC / Emu.FRAME_RATE_NTSC;
    let regsOnlyCycleAccum = 0;
    let regsOnlyCpuDebt = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      if (regsOnly) {
        // CPU実行 + チップのクロック(エンベロープ等の内部状態更新)のみ。
        // 音声波形合成(mixSample())と出力バッファ書き込みだけを省略する。
        ctx.pendingWritesRef.set([]);
        if (!ctx.player.cpu.callActive) ctx.player.cpu.beginCall(ctx.player.header.playAddr);
        const regsOnlyExpansion = Object.values(ctx.player.bus.expansion);
        regsOnlyCycleAccum += CYCLES_PER_FRAME;
        while (regsOnlyCycleAccum >= 1) {
          if (regsOnlyCpuDebt <= 0) {
            if (ctx.player.cpu.callActive) regsOnlyCpuDebt += ctx.player.cpu.stepCall();
            else regsOnlyCpuDebt = 1;
          }
          regsOnlyCpuDebt--;
          ctx.player.apu.clock();
          for (let e = 0; e < regsOnlyExpansion.length; e++) regsOnlyExpansion[e].clock();
          regsOnlyCycleAccum -= 1;
        }
        ctx.writeLog[f] = ctx.pendingWritesRef.current;
        for (const w of ctx.pendingWritesRef.current) ctx.runningRegs[w.addr] = w.value;
        // 書き込み無しフレームは前フレームとスナップショット同一なのでオブジェクトを共有
        // (_processFrame側の同名コメント参照)
        ctx.regSnapshots[f] = (f > 0 && ctx.pendingWritesRef.current.length === 0)
          ? ctx.regSnapshots[f - 1] : Object.assign({}, ctx.runningRegs);
        const n163 = ctx.player.bus.expansion && ctx.player.bus.expansion.n163;
        if (n163) ctx.n163Snapshots[f] = n163.ram.slice();
      } else {
        pos = _processFrame(ctx, f, pos);
      }
      // f===0でも必ず一度onProgressを発火する(最初のonProgressで実再生のplayer.load()が
      // 走るため、時間予算いっぱいまで溜めると再生開始が遅れる)。以降は時間予算を
      // 超えたときだけスライス境界にする。
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        // initRegs/initWritesは末尾に追加(既存呼び出し元は無視するだけで後方互換)。
        // NSF実再生をこのwriteLogから直接合成する新エンジン(NsfReplayStreamPlayer)が
        // INIT時点の初期状態を再生開始前に必要とするため、完了(Promise解決)を待たずに
        // 最初のonProgressの時点で渡せるようにした。
        if (onProgress) onProgress(f + 1, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
        await yieldFn();
        sliceStart = performance.now();
        // 呼び出し元が「もう不要」と判断したら(曲切替/停止の連打で先読みが積み上がるのを防ぐ)
        // ここで即座に打ち切る。onProgress側だけをトークンで無視する方式だと、キャプチャ
        // ループ自体(重いCPUエミュレーション)は最後まで回り続けてしまい、連打するたびに
        // 積み重なって実再生と競合しUIが重くなる不具合があったため。
        if (opt.shouldCancel && opt.shouldCancel()) return _buildResult(ctx);
      }
    }
    if (onProgress) onProgress(ctx.totalFrames, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
    return _buildResult(ctx);
  };
})(globalThis);

/*
 * *2MML 変換設定(コマンド使用/不使用・譜面整形)の共通定義
 *
 * 目的(2026-08-24): 熟練者が「ほぼ音階だけのプレーンな譜面」から自分で編曲を始められる
 * ように、各 *2mml がセント単位の補正コマンド(D/EP/MP/PT/EN)や音量エンベロープ(@v等)を
 * 出す/出さないを選べるようにする。全6形式(nsf/spc/kss/gbs/hes/vgm)で共通の1つの
 * オブジェクト options.cmd を受け取り、
 *   (1) 割当層(EnvelopeRegistry/PitchEnvelopeRegistry/NoteEnvelopeRegistry/detune.js)で
 *       登録自体を止める(→ ヘッダの @v/@EP/@MP/@EN テーブル定義も自然に消える)
 *   (2) 出力層(mmlEmit.js emitScore/emitChannel)でチャンネルフラグをANDマスクする(安全網)
 *   (3) 譜面整形(短い休符の吸収)を emitScore 手前のイベント整形で行う
 * の3段で効かせる。
 * これとは別に、音符の区切り方(NOTE_END、下記)は各 *2mml が emitScore の直前に
 * MML.Convert.applyNoteEnd(src/convert/envelope.js)を呼んで効かせる
 * (エンベロープ表の登録先が要るため emitScore 内では行えない)。
 *
 * cmd の各キー(全て boolean。省略時は true = 従来通り忠実再現):
 *   D      … D<n>(チャンネル/チップ間デチューン、detune.js)
 *   EP     … EP<n>(ピッチエンベロープ。MP/PT の受け皿でもある)
 *   MP     … MP<n>(ビブラート)。falseで EP が true なら周期EPテーブルへ落ちる
 *   PT     … PT<n>(ポルタメント)。falseで EP が true なら非ループEPテーブルへ落ちる
 *   EN     … EN<n>(高速アルペジオのノートエンベロープ)。false時はアルペジオ統合
 *            (mergeRapidArpeggio)自体は行い、基音1音として出す(音符連打には戻さない。
 *            編曲の出発点としては1音の方が読みやすいため)
 *   ENV    … @v/@vr(ソフト/ハード音量エンベロープ)と FME7 の S/M。false時は各イベントの
 *            音量列のピーク値を v<n> として出す(MML.Convert.plainVolume)
 *   V      … v<n>(音量そのもの)。false なら v も出さず既定音量
 *   SWEEP  … s<speed>,<depth>(2A03ハードウェアスイープ)
 *   INST   … @<n>(音色/デューティ)、OP<n>(VRC7音色)、MH<n>(FDS変調)、N<n>(FME7ノイズ周期)
 *   DRUM   … VGMのサンプルPCM(C140/C352/QSound/MultiPCM/SegaPCM/GA20/OKIM6295/YM2610
 *            ADPCM-A)で音程が取れなかった発音=打楽器を、1本のドラムパートとして音符化する
 *            (サンプルごとに疑似音程を割り当てる。src/convert/drumMap.js)。falseなら従来
 *            どおり休符(ドラムはMMLに出ない)
 *
 * 譜面整形(既定 false = 従来通り。★近似=音が変わりうる整形はここに集める):
 *   GATE_APPROX … ゲートを揃える(2026-09-08、既定 true)。NOTE_END='next' のゲート候補に、キーオフ位置の
 *                 ずれが GATE_TOL フレーム以内の q<n> も許し、切り替えを重くしてチャンネルの大半を1つの
 *                 q で書く(休符や k<len> の細切れを出さない)。レガートと長い無音は切らない。false なら
 *                 厳密一致のゲートだけ(以前の挙動)
 *   GATE_TOL    … その許容フレーム数(0〜8、既定2)
 *   PART_ORDER/BARS_PER_LINE/BAR_ALIGN/CHANNEL_ORDER … 出力の書式(2026-09-08、本ファイル LAYOUT_DEFAULTS
 *                 参照。プリセット外)。CHANNEL_ORDER='letter' はアルファベット順(既定)、'source' は
 *                 変換元の割り当て順(各 *2mml が積んだ順=元の音源のチャンネル順)
 *   LEN_SNAP    … 音長を丸める(2026-09-08、既定2フレーム、0=厳密)。音符/休符の長さがこのフレーム数以内で
 *                 大きな音価に乗るならタイの列(4&2&8..&64.&192)にせず 1 個で書き、余りは次の音符へ持ち越す
 *                 (src/convert/duration.js framesToLengths の slackFrames。持ち越しは ±許容に収め、一致は持ち越し込みで
 *                 許容の2倍以内の最も近い音価。小節線から許容以内の音符は小節線で割らない)。ドライバのテンポが小数で音符長が
 *                 ±1〜2 フレーム揺れる曲(ppmck の t71 等)の譜面を素直にする。境界のずれは最大このフレーム数
 *   LEN_DP      … 音長をチャンネル全体で最適化する(2026-09-09、忠実再現=ON / プレーン譜面=OFF)。音符ごとに
 *                 直前の余りだけ見て最も近い音価を選ぶ greedy(framesToLengths)の代わりに、チャンネルの全イベント
 *                 列を見渡して「音価の書きにくさ+境界の位置ずれ(フレーム)²」の合計が最小の割り当てを動的計画法で
 *                 選ぶ(duration.js quantizeSeq)。速いテンポで 5,5,5,6 フレームと揺れる16分が `24..` に化ける、
 *                 3連8分の隣で持ち越しが逆向きに溜まり `16.` になる、を直す。境界のずれは常に LEN_SNAP 以内に
 *                 収める(greedy は持ち越しの超過を捨てて黙ってずれる)ので、格子に乗らない音符の多い実曲では
 *                 3連系やタイが少し増える。合成曲の往復テストで音長一致 91%→97%
 *   DPCM_EXACT  … 分割したDPCMの音長は丸めない(2026-09-09、既定 true)。DMC 1本の上限(4080バイト)を超える
 *                 打点は src/convert/drumHits.js がフレーム整数の区間へ分割し、区間ごとに @DPCM 定義と打点を
 *                 立てて連続再生する(ストリーム再生)。その区間の音長を LEN_SNAP/LEN_DP の丸めから外して
 *                 厳密に書く。丸めると区間の継ぎ目に空白/食い込みが出るため。false なら普通の音符と同じ扱い
 *   ENV_MERGE   … 似た @v 表を統合する(2026-09-08)。値の並び(段の値列)が同じで各段の長さが±1・全体長も
 *                 ±1以内の表を、最も多くの音符が参照する変種へ寄せる(EnvelopeRegistry.mergeSimilar)。
 *                 ドライバのエンベロープが自走タイマー(2.33フレーム周期等)で進む曲では段の位置が音符の
 *                 開始位相ごとに違い、同じ楽器でも 3,2,2 / 2,3,2 / 2,2,3 の変種が量産される。ppmck の
 *                 @v はフレーム毎の絶対値なので正確に1本にはできず、これは段の境目が最大1フレーム動く
 *                 近似(ハードウェア減衰表・exact 表は対象外)
 *   SHAPE_REST  … 音符の直後の短い休符(1/32未満)を音符に吸収(ゲートタイムの隙間除去)。
 *                 伸ばした区間は最後の音量のまま鳴るので近似
 *   FOLD_DOUBLES … 合成ch(プール式PCMの論理レーン。PSF/VGMのMultiPCM等)の複製パートを省く(2026-09-14、
 *                 忠実再現=OFF / プレーン譜面=ON)。ドライバが同じ旋律を別ボイスで重ねたデチューン二重化や
 *                 数フレーム遅れのエコーを src/convert/poolDoubles.js が検出し、複製側のノートを変換から外す
 *                 (ヘッダに何を省いたか書く)。OFF でも、N163 等の枠へ自動で載せるレーンを選ぶときは複製を後回しにする
 *   (旧 SHAPE_QUANT「16分音符格子へ丸める」は 2026-09-07 に廃止。キーオン自体が格子から
 *    外れている曲にしか効かず、丸めれば必ずタイミングが崩れるため。保存済み設定に残って
 *    いても読み捨てる)
 *
 * 音符の区切り(2026-09-07。細かい音長 `@v156 d+4&d+64.&d+192 r…` 対策):
 *   NOTE_END … 'next'(既定) | 'zero'
 *     抽出器は音量レジスタが0になった瞬間に音符を閉じるため、音長が「減衰が0に達した
 *     フレーム」というテンポ格子と無関係な値になる(同じ情報は @v 表にもあり二重表現)。
 *     'next' … 音符の直後の休符を音符に吸収して次の音符の頭まで伸ばす(音長=キーオン間隔)。
 *              無音区間は、減衰が自然に0へ到達した@v付き音符なら @v表の末尾に 0 を1つ足して
 *              (コンパイラ stepEnvelope も NSF ドライバも末尾値を保持する)、それ以外は
 *              ゲートタイム q<n>/@q<n>(コンパイラはゲートオフを休符と同じに書く)で表す。
 *              どちらも再生結果は完全に同じ(タイミング不変の厳密な変形)
 *     'zero' … 従来どおり音量0で区切る(最も細かく、そのままの姿)
 *     詳細・対象外は envelope.js applyNoteEnd 冒頭コメント。
 *
 * 値キー(booleanでない設定。2026-08-26):
 *   PITCH_SA … N163出力のSA<num>(ピッチシフト量)自動選択。'octave' | 'note' | 'off'
 *     EP/MP/Dテーブル値のbyte幅とN163周波数レジスタ18bitの桁差を埋める(選び方の詳細は
 *     src/convert/pitch.js n163SaForBase冒頭コメント参照)。既定'octave'(オクターブ連動、
 *     セント精度がオクターブ非依存でテーブル共有も効く)。'note'=音符ごと最高精度、
 *     'off'=SA不使用(従来互換、深い変調は割当失敗して落ちる)。
 *   N163_CH … N163の実効チャンネル数(#EX-N163 <n> に書く値。'fixed8' | 'used')。
 *     実機N163は8chを時間多重するので、有効ch数を減らすと1chあたりの取り分が増える。
 *     ★1つ動かすと3つ同時に動く:
 *       波形RAM  … 128-8*ch数 バイト(1ch=120 / 8ch=64)。減らすほど大きい波形を置ける
 *       音量     … 出力は有効ch数で平均されるので、減らすほど同じ v が大きく鳴る(1chは5chの5倍)
 *       周波数   … freqReg ∝ ch数。減らすほどレジスタ値が小さくなり、音程の刻みは粗く、
 *                  出せる最高音は上がる(32サンプル波形で 8ch=1864Hz / 1ch=14915Hz)
 *     'fixed8'(既定) … 常に8ch。ch数で変わる値を固定で扱えるので、曲によって音量や音域が
 *       変わらない。波形RAMは64バイトに固定され、高い音は出しにくい。
 *     'used' … 割り当てたスロットのうち一番大きい番号を使う(ch1+ch8なら8、ch2+ch6なら6)。
 *       大きい波形を使いたい・音量を出したい・高い音を出したいときはこちら。
 *     ★nsf2mmlだけは対象外。元がN163のネイティブ変換で、実効ch数は元の曲が決めているため。
 *   N163_WAVE … 波形長を自動で縮めるかどうか。縮めると2つの制約が同時にゆるむ。
 *     (a) 内蔵RAM … 波形に使えるのは 128-8*有効ch数 バイトだけ
 *     (b) 音域   … freqReg = freq*15*65536*波形長*ch数/CPU が18bitを超える音は鳴らない
 *                  (32サンプル・8chなら a+6 が上限。波形を半分にすれば上限は1オクターブ上がる)
 *     'both'(既定) … (a)と(b)の両方に収まるように縮める。音域の詰め直しは「音域外の音符が
 *       実際に使っている @N」だけを対象にする(曲全体を一律に落とさない)。
 *     'fit' … (a)のRAMだけ見る(従来の既定)。音域外の音符はコンパイル時に警告付きで無音になる。
 *     'keep' … 何も縮めない。RAMに収まらない曲はコンパイルエラーで再生も書き出しもできないが、
 *       本家ppmckへ持って行って手で詰め直したい場合はこちら。
 *     ★どの場合も「あふれた瞬間に居る波形」を大きい順に必要な数だけ縮め、縮めたぶんは
 *       ヘッダコメントに明記する。同じ @N を他のチャンネルが使っていればそちらの音色も鈍くなる。
 *
 * DPCM(打楽器)キー(2026-09-05、変換設定ダイアログからドラム(DPCM)パネル最下段へ移動):
 *   DMC_RATE  … サンプルごとのDMCレート指定が「自動」のときに使うレート。DMCレート表
 *     (MML.Dpcm.DMC_RATE_TABLE_NTSC)のindex 0..15、既定15(33.1kHz)。1bitデルタ変調は
 *     1bitあたり±2/127しか動けないため、レートが追従能力(アタックのなまり)とアイドルトーン
 *     (平坦部で乗るレート/2のキーン音)を直接決める。音質とデータ量はレートに比例する。
 *     ★旧 PCM_RATE('max'|8|4|2|1=ソースレートの倍率方式)は廃止。サンプルPCMは再生レートが
 *       DMC上限以上のことが多く倍率方式が効かなかった。旧キーは読み捨てる(数値が衝突するため
 *       キー名を変えた)
 *   RATE_MIX  … 同時に鳴った打点のDMCレート指定が食い違うとき、'quality'=高い方 / 'size'=低い方
 *   DRUM_POLY … 打点が重なったとき 'mix'=その瞬間の音をミックスして1クリップ / 'mono'=直近1音
 *   これらはプリセット(忠実再現/プレーン譜面)の一致判定に含めない(パネル側の独立した設定)。
 *   全形式のドラム(DPCM)経路(src/convert/drumHits.js)が見る。
 *
 * 基準ピッチ(全体オフセット、2026-09-07。下の MML.Convert.detectTuning 冒頭コメント参照):
 *   TUNING     … 'auto'(既定) = 曲全体の音程偏差の中央値を測り、その分ずらした基準で音符へ丸めて
 *                `#TUNING <cent>` をヘッダに出す / 'a440' = 従来どおり A4=440Hz の12平均律固定
 *   TUNING_MIN … 'auto' のとき、測った偏差の絶対値がこのセント数未満なら何もしない(既定5、0〜50)。
 *                閾値未満の曲の出力は 'a440' と完全に同じ
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  MML.Convert = MML.Convert || {};

  const CMD_KEYS = ['D', 'EP', 'MP', 'PT', 'EN', 'ENV', 'V', 'SWEEP', 'INST', 'DRUM'];
  const SHAPE_KEYS = ['SHAPE_REST', 'ENV_MERGE', 'GATE_APPROX', 'FOLD_DOUBLES'];
  // GATE_TOL: ゲートを揃える(GATE_APPROX)ときに許すキーオフ位置のずれ(フレーム、0〜8、既定2)
  const GATE_TOL_DEFAULT = 2, GATE_TOL_MAX = 8;
  MML.Convert.GATE_TOL_DEFAULT = GATE_TOL_DEFAULT;
  MML.Convert.GATE_TOL_MAX = GATE_TOL_MAX;
  // LEN_SNAP: 音長を丸める許容フレーム数(0=厳密(192分)、1〜4、既定2。src/convert/duration.js framesToLengths)
  const LEN_SNAP_DEFAULT = 2, LEN_SNAP_MAX = 4;
  MML.Convert.LEN_SNAP_DEFAULT = LEN_SNAP_DEFAULT;
  MML.Convert.LEN_SNAP_MAX = LEN_SNAP_MAX;
  MML.Convert.lenSnapOf = (cmd) => (cmd && cmd.LEN_SNAP > 0) ? Math.min(LEN_SNAP_MAX, cmd.LEN_SNAP) : 0;
  // LEN_DP: 音長をチャンネル全体で最適化する(2026-09-09、src/convert/duration.js quantizeSeq)。
  // 忠実再現プリセットは ON、プレーン譜面は OFF(格子に乗らない実曲では 3連系やタイが増えるため)
  MML.Convert.lenDpOf = (cmd) => !!(cmd && cmd.LEN_DP);
  // DPCM_EXACT: 分割したDPCM(ストリーム再生の区間、src/convert/drumHits.js)の音長を LEN_SNAP/LEN_DP の
  // 丸めから外して厳密に書く(2026-09-09、既定ON。省略時もON=未指定の古い設定と互換)。
  // 区間の長さがずれると継ぎ目に空白/食い込みが出るため
  MML.Convert.dpcmExactOf = (cmd) => !(cmd && cmd.DPCM_EXACT === false);

  // ── チャンネルの並び順(2026-09-09) ──────────────────────────────────────
  // 各 *2mml は scoreChannels へ「元の音源のチャンネル順」で積み、最後にレター順へ並べ替える。
  // その並べ替えで元の順を失わないよう、積んだ順を srcIndex として刻んでおく(CHANNEL_ORDER='source')。
  //   stampChannelSource … まだ刻まれていないものだけ現在の並びで採番(後から足した ch は末尾に続く)
  //   sortChannelsByLetter … 刻んでからレター順(各 *2mml の従来の sort を置き換える)
  //   orderChannels … 出力直前の並べ替え。配列は作り直すので呼び元の並びは変えない
  MML.Convert.stampChannelSource = function (channels) {
    let next = 0;
    for (const ch of channels || []) if (ch && ch.srcIndex != null && ch.srcIndex >= next) next = ch.srcIndex + 1;
    for (const ch of channels || []) if (ch && ch.srcIndex == null) ch.srcIndex = next++;
    return channels;
  };
  // チャンネル文字の比較は必ずコードポイント順(A-Z のあとに a,b)。
  // ★localeCompare は 'a' < 'B' と判定するので使わない: 実機ppmckの文字順は大文字A-Zのあとに
  //   小文字a,b(拡張音源のE-Zab)なのに、出力が aAbBCDEFG と大小交互に並んで音源ごとの
  //   まとまりが崩れていた(2026-09-10 ユーザー指摘)。同じ理由の前例が
  //   src/convert/channelPlan.js sortByLetter にある
  const byLetter = (a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0);
  MML.Convert.compareChannelLetter = byLetter;
  MML.Convert.sortChannelsByLetter = function (channels) {
    MML.Convert.stampChannelSource(channels);
    channels.sort(byLetter);
    return channels;
  };
  MML.Convert.orderChannels = function (channels, order) {
    const out = (channels || []).slice();
    MML.Convert.stampChannelSource(out);
    if (order === 'source') out.sort((a, b) => (a.srcIndex - b.srcIndex) || byLetter(a, b));
    else out.sort(byLetter);
    return out;
  };
  // 出力の書式(2026-09-08、src/convert/mmlEmit.js emitScore)。プリセットには含めない(内容でなく見た目)
  //   PART_ORDER    … 'block'=チャンネル順に BARS_PER_LINE 小節ずつ並べる / 'part'=パートごとに最後まで出してから次へ
  //   BARS_PER_LINE … 1行に入れる小節数(1〜16、既定4)
  //   BAR_ALIGN     … 小節の区切りを全パートで桁揃えする(false=スペース1つで区切る、既定)
  const PART_ORDER_VALUES = ['block', 'part'];
  const CHANNEL_ORDER_VALUES = ['letter', 'source'];
  const BARS_PER_LINE_MAX = 16;
  const LAYOUT_DEFAULTS = { PART_ORDER: 'block', BARS_PER_LINE: 4, BAR_ALIGN: false, CHANNEL_ORDER: 'letter' };
  const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS);
  MML.Convert.LAYOUT_DEFAULTS = LAYOUT_DEFAULTS;
  MML.Convert.LAYOUT_KEYS = LAYOUT_KEYS;
  MML.Convert.PART_ORDER_VALUES = PART_ORDER_VALUES;
  MML.Convert.CHANNEL_ORDER_VALUES = CHANNEL_ORDER_VALUES;
  MML.Convert.BARS_PER_LINE_MAX = BARS_PER_LINE_MAX;
  // 音符の区切り(冒頭コメント NOTE_END)
  const NOTE_END_VALUES = ['next', 'zero'];
  MML.Convert.NOTE_END_VALUES = NOTE_END_VALUES;
  const PITCH_SA_VALUES = ['octave', 'note', 'off'];
  // ── DPCM(打楽器)キー(冒頭コメント参照)。ドラム(DPCM)パネル最下段の設定 ──
  // DMC_RATE: DMCレート表のindex(0=4.2kHz … 15=33.1kHz)。「自動」のサンプルに使う
  const DMC_RATE_MAX = 15;
  // 同時発音をミックスして1サンプルに焼くときのDMCレートの決め方
  //   'quality' … 寄与するサンプルのうち高い方を採る(既定)
  //   'size'    … 低い方に合わせて容量を優先する
  const RATE_MIX_VALUES = ['quality', 'size'];
  MML.Convert.RATE_MIX_VALUES = RATE_MIX_VALUES;
  // 打楽器の同時発音の扱い(src/convert/drumHits.js poly)
  //   'mix'  … その瞬間に鳴っている打点をミックスして1クリップに焼く(既定、忠実)
  //   'mono' … ミックスしない。直近に叩かれた打点だけを鳴らす(定義がサンプル数までしか
  //            増えないので容量制御に使う。実測: NCS91002 はミックス54定義36KB→単音7定義)
  const DRUM_POLY_VALUES = ['mix', 'mono'];
  MML.Convert.DRUM_POLY_VALUES = DRUM_POLY_VALUES;
  // 基準ピッチ(冒頭コメント参照)
  const TUNING_VALUES = ['auto', 'a440'];
  MML.Convert.TUNING_VALUES = TUNING_VALUES;
  const TUNING_MIN_DEFAULT = 5, TUNING_MIN_MAX = 50;
  MML.Convert.TUNING_MIN_DEFAULT = TUNING_MIN_DEFAULT;
  MML.Convert.TUNING_MIN_MAX = TUNING_MIN_MAX;
  const DPCM_KEYS = ['DMC_RATE', 'RATE_MIX', 'DRUM_POLY'];
  const DPCM_DEFAULTS = { DMC_RATE: DMC_RATE_MAX, RATE_MIX: 'quality', DRUM_POLY: 'mix' };
  MML.Convert.DPCM_KEYS = DPCM_KEYS;
  MML.Convert.DPCM_DEFAULTS = DPCM_DEFAULTS;
  // N163内蔵RAMに波形が収まらないときの扱い(冒頭コメント参照)
  const N163_WAVE_VALUES = ['both', 'fit', 'keep'];
  MML.Convert.N163_WAVE_VALUES = N163_WAVE_VALUES;
  // N163の実効チャンネル数の決め方(冒頭コメント参照)
  const N163_CH_VALUES = ['fixed8', 'used'];
  MML.Convert.N163_CH_VALUES = N163_CH_VALUES;

  /**
   * 変換器が使うN163の実効チャンネル数。変換設定 N163_CH('fixed8' | 'used')で決まる。
   * 'used' は「使ったスロットのうち一番大きい番号+1」(ch1+ch8なら8、ch2+ch6なら6)。
   * ここで返した値を必ず (1) 周波数式 (2) n163Fitの波形RAM枠 (3) #EX-N163の宣言 の
   * 3か所すべてに使うこと。1つでも食い違うと音痴・音量差・波形あふれが起きる。
   * ★lexer.js ではなくここに置くのは、SPCの変換がキャプチャWorkerのバンドル内でも
   *   動くため(バンドルに入るのは src/convert/options.js。build-capture-workers.ps1 参照)。
   * @param {object} cmd normalizeCmd済みの変換設定
   * @param {number[]} usedIndexes 使ったN163スロット番号(0始まり)
   */
  MML.Convert.n163NumChFor = function (cmd, usedIndexes) {
    if (!cmd || cmd.N163_CH !== 'used') return 8;
    let n = 0;
    for (const i of (usedIndexes || [])) n = Math.max(n, (i | 0) + 1);
    return Math.max(1, Math.min(8, n));
  };

  MML.Convert.CMD_KEYS = CMD_KEYS;
  MML.Convert.SHAPE_KEYS = SHAPE_KEYS;
  MML.Convert.PITCH_SA_VALUES = PITCH_SA_VALUES;

  const PRESETS = {
    // 忠実再現(従来の既定)
    faithful: { D: true, EP: true, MP: true, PT: true, EN: true, ENV: true, V: true, SWEEP: true, INST: true, DRUM: true,
                SHAPE_REST: false, ENV_MERGE: false, FOLD_DOUBLES: false, GATE_APPROX: true, GATE_TOL: GATE_TOL_DEFAULT, LEN_SNAP: LEN_SNAP_DEFAULT, LEN_DP: true, DPCM_EXACT: true,
                NOTE_END: 'next', PITCH_SA: 'octave', N163_WAVE: 'both', N163_CH: 'fixed8',
                TUNING: 'auto', TUNING_MIN: TUNING_MIN_DEFAULT },
    // プレーン譜面: 音階+音色だけ。編曲の出発点用
    plain:    { D: false, EP: false, MP: false, PT: false, EN: false, ENV: false, V: false, SWEEP: false, INST: true, DRUM: true,
                SHAPE_REST: true, ENV_MERGE: false, FOLD_DOUBLES: true, GATE_APPROX: true, GATE_TOL: GATE_TOL_DEFAULT, LEN_SNAP: LEN_SNAP_DEFAULT, LEN_DP: false, DPCM_EXACT: true,
                NOTE_END: 'next', PITCH_SA: 'octave', N163_WAVE: 'both', N163_CH: 'fixed8',
                TUNING: 'auto', TUNING_MIN: TUNING_MIN_DEFAULT },
  };
  MML.Convert.CMD_PRESETS = PRESETS;

  // options.cmd(部分指定可)を全キー揃った正規形にする。省略キーは faithful 既定
  // (DPCMキーは DPCM_DEFAULTS)。
  MML.Convert.normalizeCmd = function (cmd) {
    const out = Object.assign({}, DPCM_DEFAULTS, LAYOUT_DEFAULTS, PRESETS.faithful);
    if (cmd && typeof cmd === 'object') {
      for (const k of [...CMD_KEYS, ...SHAPE_KEYS]) if (cmd[k] != null) out[k] = !!cmd[k];
      // 数値は文字列でも受ける(localStorage/JSON経由やUIのselect値が'14'等になるため)
      if (cmd.DMC_RATE != null) {
        const v = parseInt(cmd.DMC_RATE, 10);
        if (v >= 0 && v <= DMC_RATE_MAX) out.DMC_RATE = v;
      }
      if (cmd.PITCH_SA != null && PITCH_SA_VALUES.indexOf(cmd.PITCH_SA) >= 0) out.PITCH_SA = cmd.PITCH_SA;
      if (cmd.NOTE_END != null && NOTE_END_VALUES.indexOf(cmd.NOTE_END) >= 0) out.NOTE_END = cmd.NOTE_END;
      if (cmd.GATE_TOL != null) {
        const v = parseInt(cmd.GATE_TOL, 10);
        if (v >= 0 && v <= GATE_TOL_MAX) out.GATE_TOL = v;
      }
      if (cmd.LEN_SNAP != null) {
        const v = parseInt(cmd.LEN_SNAP, 10);
        if (v >= 0 && v <= LEN_SNAP_MAX) out.LEN_SNAP = v;
      }
      if (cmd.LEN_DP != null) out.LEN_DP = !!cmd.LEN_DP;
      if (cmd.DPCM_EXACT != null) out.DPCM_EXACT = !!cmd.DPCM_EXACT;
      if (cmd.PART_ORDER != null && PART_ORDER_VALUES.indexOf(cmd.PART_ORDER) >= 0) out.PART_ORDER = cmd.PART_ORDER;
      if (cmd.CHANNEL_ORDER != null && CHANNEL_ORDER_VALUES.indexOf(cmd.CHANNEL_ORDER) >= 0) out.CHANNEL_ORDER = cmd.CHANNEL_ORDER;
      if (cmd.BARS_PER_LINE != null) {
        const v = parseInt(cmd.BARS_PER_LINE, 10);
        if (v >= 1 && v <= BARS_PER_LINE_MAX) out.BARS_PER_LINE = v;
      }
      if (cmd.BAR_ALIGN != null) out.BAR_ALIGN = !!cmd.BAR_ALIGN;
      if (cmd.RATE_MIX != null && RATE_MIX_VALUES.indexOf(cmd.RATE_MIX) >= 0) out.RATE_MIX = cmd.RATE_MIX;
      if (cmd.DRUM_POLY != null && DRUM_POLY_VALUES.indexOf(cmd.DRUM_POLY) >= 0) out.DRUM_POLY = cmd.DRUM_POLY;
      if (cmd.N163_WAVE != null && N163_WAVE_VALUES.indexOf(cmd.N163_WAVE) >= 0) out.N163_WAVE = cmd.N163_WAVE;
      if (cmd.N163_CH != null && N163_CH_VALUES.indexOf(cmd.N163_CH) >= 0) out.N163_CH = cmd.N163_CH;
      if (cmd.TUNING != null && TUNING_VALUES.indexOf(cmd.TUNING) >= 0) out.TUNING = cmd.TUNING;
      if (cmd.TUNING_MIN != null) {
        const v = parseFloat(cmd.TUNING_MIN);
        if (v >= 0 && v <= TUNING_MIN_MAX) out.TUNING_MIN = v;
      }
    }
    return out;
  };

  // どれかがプリセットと完全一致すればその名前、無ければ 'custom'。
  // DPCMキー(DPCM_KEYS)はドラム(DPCM)パネル側の設定なので一致判定に含めない
  MML.Convert.cmdPresetName = function (cmd) {
    const n = MML.Convert.normalizeCmd(cmd);
    for (const name of Object.keys(PRESETS)) {
      const p = MML.Convert.normalizeCmd(PRESETS[name]);
      if ([...CMD_KEYS, ...SHAPE_KEYS, 'NOTE_END', 'GATE_TOL', 'LEN_SNAP', 'LEN_DP', 'DPCM_EXACT', 'PITCH_SA', 'N163_WAVE', 'N163_CH', 'TUNING', 'TUNING_MIN'].every(k => p[k] === n[k])) return name;
    }
    return 'custom';
  };

  // ── 基準ピッチ(全体オフセット、2026-09-07) ────────────────────────────
  // 「その曲は本当に A4=440Hz の12平均律で鳴っているのか」を先に測り、測った基準で音符へ丸める。
  // ゲーム曲は12平均律を狙って作られているが、ドライバ固有の音程表やクロック都合で曲全体が
  // 数十セントずれていることがある(実例: Gofer no Yabou II。kss2mml/converter.js の
  // detectChorusDetune 採用経緯を参照)。A440 基準のまま丸めると
  //   借用変換    : 全音符に無意味な D<n> が付く(applyPitchDetune の minCents=10 を常に超える)
  //   ネイティブ変換: 原曲より系統的にずれた音程で鳴る
  //   偏差±50付近 : 音符ごとに丸めの向きが変わり、同じ音が隣の半音へ転んだり戻ったりする
  // という壊れ方をする。対策は曲全体で1つのセント値(#TUNING)を持ち、抽出側の丸めと再生側
  // (compiler.js / ppmckDriver.js の周波数テーブル)の両方で同じ値を使うこと。音符の名前は
  // 変わらず(キー/トランスポーズとは別物)、鳴る周波数だけが全体にずれる。
  //
  //   tuningCents()          … 現在有効なオフセット(セント)。既定0。抽出器の丸め(freqToNote)と
  //                            detune.js / pitch.js の理論値計算が参照する
  //   withTuning(c, fn, info)… fn の間だけオフセットを c にする(同期処理専用。finally で戻す)
  //   freqToNote(freq)       … 周波数→ノート番号(o4a=57、0..119、範囲外は null)。全 *2mml 抽出器共通
  //   noteToFreq(note)       … 逆変換。オフセット込み=その音符が変換先で実際に鳴る周波数
  //   detectTuning(chs, o)   … 抽出結果(scoreChannels)から全体オフセットを推定
  //   autoTune(opts, run)    … 変換本体 run(opts) を走らせ、オフセットが閾値以上なら
  //                            そのオフセットで run をもう一度走らせて再量子化した結果を返す
  //   tuningHeaderLines()    … 出力MMLに入れる `#TUNING <cent>` 行(0なら空配列)
  //   tuningCommentLines()   … ヘッダコメント用の説明行(0なら空配列)
  //
  // ★抽出器(kss2mml/expansion 等)はキャプチャWorkerのバンドルにも入る。Worker 側では
  //   withTuning が呼ばれないので常に0=従来どおりの丸め(ロール表示は元ファイルの音程のまま)。
  let _tuning = { cents: 0, info: null };
  MML.Convert.tuningCents = function () { return _tuning.cents; };
  MML.Convert.withTuning = function (cents, fn, info) {
    const prev = _tuning;
    _tuning = { cents: +cents || 0, info: info || null };
    try { return fn(); } finally { _tuning = prev; }
  };
  MML.Convert.freqToNote = function (freq) {
    if (!(freq > 0)) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440) - _tuning.cents / 100);
    return (n >= 0 && n <= 119) ? n : null;
  };
  MML.Convert.noteToFreq = function (note) {
    return 440 * Math.pow(2, (note - 57) / 12 + _tuning.cents / 1200);
  };
  function fmtCents(c) {
    const s = (Math.round(c * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return (c > 0 ? '+' : '') + s;
  }
  MML.Convert.formatTuningCents = fmtCents;
  MML.Convert.tuningHeaderLines = function () {
    return _tuning.cents ? [`#TUNING ${fmtCents(_tuning.cents)}`] : [];
  };
  MML.Convert.tuningCommentLines = function () {
    if (!_tuning.cents) return [];
    const hz = (440 * Math.pow(2, _tuning.cents / 1200)).toFixed(1);
    const info = _tuning.info;
    const stat = info && info.count ? `、音符${info.count}個の偏差中央値、四分位範囲${fmtCents(info.iqr).replace(/^\+/, '')}` : '';
    return [
      `; 基準ピッチ: A4=${hz}Hz (12平均律から ${fmtCents(_tuning.cents)} cent。自動検出${stat})`,
      `;   → #TUNING で再生側/NSF書き出しの周波数テーブルも同じだけずれます(音名はそのまま)`,
    ];
  };

  // 全体オフセットの推定。channels は各 *2mml が emitScore/verifyPitch に渡す scoreChannels
  // ({ letter, events:[{ start, end, note, rawFreq|freqHz }] })。
  //   - 各音符の「最寄り半音からのセント偏差」を音符の長さで重み付けし、その中央値を採る。
  //     レジスタの整数丸めによる偏差は音符ごとに±どちらにも出るので大量に集めると打ち消し合い、
  //     ドライバ固有の全体ずれだけが残る。平均でなく中央値なのはベンド/ビブラート中の外れ値に
  //     引っ張られないため
  //   - ノイズ(D)/DPCM(E)/ドラム/ノート番号が周期そのもののイベントは音程の意味が違うので除外
  //   - 四分位範囲が広い(opts.maxIqr、既定30セント)=曲全体がピッチ操作だらけ、または区間/チップで
  //     基準が二極化していて「全体ずれ」とは言えない場合と、音符が少なすぎる場合(opts.minCount、
  //     既定8)は 0(適用しない)。実測: HES NC62001 は中央値-33で四分位範囲40、適用すると10セント超の
  //     ずれの音符(=D<n>が付く音符)が110→204個に増えた(二極化の典型)
  //   - 適用後に「±10セント以内に乗る音符の割合」(fitAfter)が適用前(fitBefore)より明らかに
  //     下がるなら 0(上の二極化を中央値だけでは見抜けない場合の安全網)
  //   - |中央値| < opts.minCents(既定 TUNING_MIN_DEFAULT)なら 0
  // 戻り値 { cents, median, iqr, count, fitBefore, fitAfter, reason, byGroup }
  //   cents は適用値(0=適用しない)。reason は不適用の理由 'few'|'iqr'|'fit'|'below'(適用時は null)。
  //   byGroup はチャンネル文字の群(A-C=2A03, G-L=VRC7, P-W=N163, X-Z=FME7 …)ごとの中央値/音符数で、
  //   「OPLL と PSG で基準が違う」ような二極化をユーザーが読み取るための内訳(main.js renderTuning)
  MML.Convert.detectTuning = function (channels, opts) {
    opts = opts || {};
    const minCents = opts.minCents != null ? +opts.minCents : TUNING_MIN_DEFAULT;
    const maxIqr = opts.maxIqr != null ? opts.maxIqr : 30;
    const minCount = opts.minCount != null ? opts.minCount : 8;
    const samples = [];
    const groups = {}; // 群名 → [dev, w][]
    const groupOf = (L) => {
      if (!L) return '?';
      if (/^[A-C]$/.test(L)) return 'A-C';
      if (L === 'F') return 'F';
      if (/^[G-L]$/.test(L)) return 'G-L';
      if (/^[M-O]$/.test(L)) return 'M-O';
      if (/^[P-W]$/.test(L)) return 'P-W';
      if (/^[X-Z]$/.test(L)) return 'X-Z';
      if (/^[ab]$/.test(L)) return 'a-b';
      return L;
    };
    for (const ch of channels || []) {
      if (!ch || !ch.events) continue;
      if (ch.letter === 'D' || ch.letter === 'E' || ch.noise || ch.isDrum || ch.drum) continue;
      const g = groupOf(ch.letter);
      for (const ev of ch.events) {
        if (ev.note == null || ev.verifySkip || ev.drum) continue;
        if (ev.fme7Noise !== undefined && ev.instrument === 2) continue;
        const freq = ev.rawFreq != null ? ev.rawFreq : ev.freqHz;
        if (!(freq > 0)) continue;
        let dev = (57 + 12 * Math.log2(freq / 440) - ev.note) * 100;
        dev -= 100 * Math.round(dev / 100); // 最寄り半音からの偏差(-50..50)へ畳む
        const w = Math.max(1, (ev.end - ev.start) || 1);
        samples.push([dev, w]);
        (groups[g] = groups[g] || []).push([dev, w]);
      }
    }
    const wmedian = (arr) => {
      const s = arr.slice().sort((a, b) => a[0] - b[0]);
      let tot = 0; for (const x of s) tot += x[1];
      let acc = 0; for (const x of s) { acc += x[1]; if (acc >= tot / 2) return x[0]; }
      return s.length ? s[s.length - 1][0] : 0;
    };
    const byGroup = Object.keys(groups).map((g) => ({ group: g, median: wmedian(groups[g]), count: groups[g].length }));
    const none = { cents: 0, median: 0, iqr: 0, count: samples.length, reason: 'few', byGroup };
    if (samples.length < minCount) return none;
    samples.sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (const s of samples) total += s[1];
    const quantile = (q) => {
      let acc = 0;
      for (const s of samples) { acc += s[1]; if (acc >= total * q) return s[0]; }
      return samples[samples.length - 1][0];
    };
    const median = quantile(0.5);
    const iqr = quantile(0.75) - quantile(0.25);
    const wrap = (d) => d - 100 * Math.round(d / 100);
    const fitOf = (shift) => { let acc = 0; for (const s of samples) if (Math.abs(wrap(s[0] - shift)) <= 10) acc += s[1]; return acc / total; };
    const fitBefore = fitOf(0), fitAfter = fitOf(median);
    const out = { cents: 0, median, iqr, count: samples.length, fitBefore, fitAfter, reason: null, byGroup };
    if (iqr > maxIqr) { out.reason = 'iqr'; return out; }
    if (fitAfter + 0.05 < fitBefore) { out.reason = 'fit'; return out; }
    if (Math.abs(median) < minCents) { out.reason = 'below'; return out; }
    out.cents = Math.round(median * 10) / 10;
    return out;
  };

  // 変換本体を必要なら2回走らせる(各 *2mml の入口が呼ぶ)。run(options) は変換結果
  // オブジェクトを返し、その中に scoreChannels(emitScore に渡した配列)を含めること
  // (検出に使ったあと結果からは外す。UI が保持する結果を肥大させないため)。
  // 1回目は必ず A440 基準(=従来の出力)。閾値未満ならそれをそのまま返すので、'a440' 指定や
  // 全体ずれの無い曲の出力・処理時間は従来と変わらない。
  // guard(省略可) { minCents, maxIqr }: 形式側の下限(ユーザーの TUNING_MIN より厳しい方を採る)。
  //   (2026-09-07 の一時期、SPC がサンプル原音推定の偏りを「全体ずれ」と誤検出するのを避けるため
  //    15セント/四分位範囲15 を渡していた。原音推定の修正(spc2mml/converter.js detectBrrFundamental)後は
  //    不要になり、現在はどの形式も渡していない)
  MML.Convert.autoTune = function (options, run, guard) {
    const cmd = MML.Convert.normalizeCmd(options && options.cmd);
    guard = guard || {};
    const finish = (res, info) => {
      if (res && typeof res === 'object') { res.tuning = info; delete res.scoreChannels; }
      return res;
    };
    const first = MML.Convert.withTuning(0, () => run(options));
    // 固定指定でも検出だけは行い、結果(適用していれば何セントだったか)をステータスへ出せるようにする
    const minCents = Math.max(cmd.TUNING_MIN, guard.minCents || 0);
    const det = MML.Convert.detectTuning(first && first.scoreChannels, {
      minCents, maxIqr: guard.maxIqr != null ? guard.maxIqr : undefined,
    });
    det.minCents = minCents;
    if (cmd.TUNING !== 'auto') { det.cents = 0; det.reason = 'fixed'; det.mode = 'a440'; return finish(first, det); }
    det.mode = 'auto';
    if (!det.cents) return finish(first, det);
    return finish(MML.Convert.withTuning(det.cents, () => run(options), det), det);
  };

  // ── チャンネル別の変換音量(2026-08-25) ──────────────────────────────
  // 規約: options.channelMap[ch].volPct = 0..100(既定100)。そのチャンネルの変換時
  // 音量を何%にするかの縮小専用の比率(v15等で頭打ちのため上げる方向は無い)。
  // パート(借用先)指定・音色指定と組で、SPC以外のフォーマットのチャンネル割当UIにも
  // 同じキー名・同じ意味で展開する予定の共通規約。計算はこのヘルパーに一本化する。
  MML.Convert.channelVolScale = function (cfg) {
    const p = cfg && cfg.volPct != null ? parseFloat(cfg.volPct) : 100;
    if (!isFinite(p)) return 1;
    return Math.max(0, Math.min(100, p)) / 100;
  };

  // エンベロープを出さない時の代表音量: 音量列(または{values}形状)のピーク値。
  // 先頭値だとアタック途中(0から立ち上がる音源)の値になることがあるため最大値を取る。
  MML.Convert.plainVolume = function (seqOrShape) {
    const seq = Array.isArray(seqOrShape) ? seqOrShape : (seqOrShape && seqOrShape.values) || [];
    let m = null;
    for (const v of seq) if (typeof v === 'number' && (m === null || v > m)) m = v;
    return m === null ? 0 : m;
  };

  // mmlEmit.js の per-channel フラグを cmd でANDマスクする(出力層の安全網)
  MML.Convert.maskEmitFlags = function (flags, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    const f = Object.assign({}, flags);
    if (!c.D)     f.hasDetune = false;
    if (!c.EP && !c.MP && !c.PT) f.hasPitchMod = false;
    if (!c.EN)    f.hasNoteEnv = false;
    if (!c.ENV)   { f.hasEnvelope = false; f.hasFme7Env = false; }
    if (!c.V)     f.hasVolume = false;
    if (!c.SWEEP) f.hasSweep = false;
    if (!c.INST)  { f.hasInstrument = false; f.hasVrc7Tone = false; f.hasFdsMod = false; f.hasFme7Noise = false; }
    return f;
  };

  // ── 譜面整形 ───────────────────────────────────────────────────────
  // events: mmlEmit.js と同じ { start, end, note, ... } の配列(フレーム単位、昇順前提)。
  // 新しい配列を返す(元は変更しない)。
  //   SHAPE_REST : 音符の直後の休符(または隙間)が restThreshold フレーム未満なら直前の
  //                音符を延ばして埋める(ゲートタイムの隙間除去)
  //   (SHAPE_QUANT=16分格子への丸めは 2026-09-07 に廃止。冒頭コメント参照)
  MML.Convert.shapeEvents = function (events, fpb, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    if (!c.SHAPE_REST) return events;
    let evs = (events || []).slice().sort((a, b) => a.start - b.start).map(e => Object.assign({}, e));

    if (c.SHAPE_REST) {
      const restThreshold = fpb / 8; // 1/32 音符未満
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const prev = out[out.length - 1];
        // リリース表(@vr)付きの音符の直後の休符はリリースが鳴る区間(mmlEmit が k<len> で出す)
        // なので吸収しない
        if (ev.note === null && prev && prev.note !== null && prev.envelopeVr == null && (ev.end - ev.start) < restThreshold) {
          prev.end = Math.max(prev.end, ev.end); // 休符を直前の音符へ吸収
          continue;
        }
        // 明示休符が無い単なる隙間も同じ扱い(fillGaps が後で休符化する前に埋める)
        if (prev && prev.note !== null && ev.start > prev.end && (ev.start - prev.end) < restThreshold) {
          prev.end = ev.start;
        }
        out.push(ev);
      }
      evs = out;
    }
    return evs;
  };
})(globalThis);

/*
 * ピッチ変調(ビブラート)検出 → { delay, values, loop? } 変換。
 * @EP<N> = { ... | ... } テーブル構文(src/mml/lexer.js PITCH_NOTE_ENVELOPE_DEF_RE)用の
 * データを作る。DESIGN-PITCH.md Phase 1(厳密周期ビブラート→ループEP)の実装。
 *
 * MML.Convert.classifyPitchMod(pitchSeq) ->
 *   { type:'periodic', delay, values } | { type:'literal'|'ramp', delay, values } | null
 *   pitchSeq: 1音符区間のフレーム毎の生ピッチレジスタ値(*2mmlのev.pitchSeq、Phase 0で追加)。
 *   戻り値 null … 変調が見つからない(フラット・短すぎ・範囲外)。
 *                 呼び出し側は従来通りD<n>(定数オフセット)のみを使うべき。
 *
 * 判定は基準値(pitchSeq[0]、detune.js/D<n>と同じ基準点)からの差分列に対して行う。
 * D<n>とEP<n>はcompiler.js側で加算される(pitchRegisterOffset: offset = detune +
 * stepEnvelope(ep) + ...)ため、基準点さえ揃っていれば両者は独立に正しく合成される。
 *
 * ★2026-08-11(DESIGN-PITCH.md 別プロジェクトA): `delay`はテーブル本体(values)とは
 * 別に返す独立フィールドになった。以前は「変調開始前の実測ゼロ区間」をテーブル先頭に
 * そのままゼロ値として焼き込んでいた(EP<n>,<delay>引数が未実装だったための代替、
 * P-1参照)が、`EP<n>,<delay>`引数拡張の実装によりMML側で明示的に指定できるようになった
 * ため、pitch.js側では常にゼロ区間をテーブルから分離してdelayとして返す
 * (`values`にゼロ埋めのpadding抜き)。呼び出し側(*2mml converter)は
 * `ev.pitchEp`(テーブル番号)と`ev.pitchEpDelay`(delayフレーム数)の両方を
 * mmlEmit.jsへ渡し、`EP<n>,<delay>`として出力する。利点: 同じLFO形状を遅延違いで
 * 使う曲でもテーブルが重複登録されずEnvelopeRegistryの重複排除が効く、NSF書き出しの
 * ROMサイズもゼロ埋めNバイトよりdelay1バイトの方が小さい(§4参照)。
 *
 * 周期探索パラメータはenvelope.js/retrigger.jsの前例に倣い、このモジュール専用に
 * 独立させる(共有しない。DESIGN-PITCH.md P-3参照)。envelope.jsが踏んだ2つのバグ
 * (loop食い違いの前方一致共有、固定窓による長周期の誤検出)は同じ形で回避する。
 *
 * MML.Convert.PitchEnvelopeRegistry … 曲全体で共有するEPテーブル登録先(重複排除)。
 * EnvelopeRegistryと同型・同ルール(0番から採番、loop食い違いは前方一致させない)。
 *
 * MML.Convert.rescalePitchSeqFromFreq(freqSeq, periodFn) -> number[]
 *   借用変換(DESIGN.md §5、変換元と変換先でチップ・クロックが異なる)用。ev.pitchSeq
 *   (変換元チップの生レジスタ値)をそのままEPへ使うと、変換元と変換先で周期レジスタの
 *   スケール(クロック比)が違うため変調の深さが誤って伸縮する(例: KSS PSG→FME7は
 *   クロック比≈2倍)。ev.freqSeq(Hz、Phase 0で追加済み)を変換先チップのperiodFn
 *   (detectChorusDetune/applyPitchDetuneが使うのと同じ生周期換算関数、例:
 *   fme7PeriodRaw/n163FreqRegRaw/pulsePeriodRaw)へ通してから分類する。
 *   detune.js冒頭コメントと同じ「差を取ってから1回だけ丸める」方針(基準フレームの
 *   連続値を保持し、各フレームは基準との差分を丸めてから整数化する。フレーム毎に
 *   独立で丸めてから引き算すると誤差が余分に乗る)。
 *   ネイティブ変換(変換元=変換先、NSF本体+拡張音源)はスケール変換が不要なので
 *   ev.pitchSeqをそのままPitchEnvelopeRegistry.assignへ渡せばよく、この関数は使わない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  // 非周期(こぶし/アタックベンド/ランプ、DESIGN-PITCH.md Phase 3)を非ループEPテーブルとして
  // 書き出すための閾値。周期判定用の定数(MIN_PERIOD等)とは独立させる(P-3参照)。
  // 非周期側は「同じ形が繰り返される」という裏付けが取れない(1回きりの観測)ため、
  // 周期判定のMIN_LOOP_RANGE(=2)よりやや厳しめにして丸め誤差ノイズの誤検出を避ける。
  const MIN_LITERAL_RANGE  = 3;
  const MIN_LITERAL_FRAMES = 4; // MIN_PERIODと同じ考え方(3フレーム以下は打鍵ジッタと区別できない)

  const MIN_PERIOD       = 4;  // 3フレーム以下の「周期」は単発の打鍵ジッタと区別できないため除外
  const MAX_PERIOD       = 64; // Phase 0実測(GBS周期12、SPC周期13-15)を踏まえた余裕のある上限
  // 誤検出防止の基準は「最低N周期分の一致」(envelope.jsの流儀)ではなく「一致確認に使った
  // 絶対フレーム数」で取る。★実データ(GBS Star Wars CH1)で実測した所、1音符が32フレーム
  // 程度と短くビブラート周期が15フレームに達する曲があり、「最低2周期分」要求だと
  // 30フレーム超が必要になり大半の実ノートで確認しきれず未検出になっていた
  // (envelope.jsの用途=音量は数百フレームの持続音が前提だが、ピッチのビブラートは
  // 1音符=数十フレームの中で完結することが多く前提が異なる)。決定的(ノイズ無し)な
  // エミュレーション値の完全一致比較であるため、MIN_CONFIRM_FRAMES分の一致さえあれば
  // 偶然の一致はほぼあり得ない(全区間フラットの場合はflatRunチェックで別途除外済み、
  // 周期が短いほど実質の確認周期数は増えるので短周期の検出精度は従来通り高いまま)。
  const MIN_CONFIRM_FRAMES = 8;
  const MIN_LOOP_RANGE = 2; // ループ内振幅(最大-最小)がこれ未満なら装飾として弾く(丸め誤差対策)
  const MAX_SEARCH_START = 64; // ループ開始位置(=delay相当)の探索上限
  const MAX_CHECK_WINDOW = 180; // 確認窓の下限(envelope.jsのMAX_ENV_FRAMESと同じ考え方)
  const EP_VALUE_MIN = -127, EP_VALUE_MAX = 126; // @EP<n>テーブル値は符号付きbyte(lexer.js参照)
  const MAX_EP_DELAY = 255; // EP<n>,<delay>のdelayは1byte(mckBytecode.js/ppmckDriver.js側)

  // 厳密周期チェック。確認窓は「MAX_CHECK_WINDOW」と「period+MIN_CONFIRM_FRAMES(呼び出し元の
  // maxPeriod計算が既に保証する下限)」の大きい方に取る(envelope.js:isPeriodicFromと同じ
  // 固定窓バグの回避策)。
  function isPeriodicFrom(seq, start, period) {
    const limit = Math.min(seq.length, start + Math.max(MAX_CHECK_WINDOW, period + MIN_CONFIRM_FRAMES));
    for (let i = start + period; i < limit; i++) {
      if (seq[i] !== seq[i - period]) return false;
    }
    return true;
  }

  // 末尾の「同一値が続く足踏み区間」だけを1個残してtrimする
  // ([[envelope-nonloop-tail-trim-fix]]と同じ考え方: 非ループの絶対オフセット列は末尾値を
  // 保持し続ける意味なので、末尾の重複はテーブル長を縮めるだけで再生結果に影響しない。
  // 実際の@EPテーブルは registerShape で差分列+末尾0へ変換される)。
  function trimTrailingHold(diff) {
    let end = diff.length;
    while (end > 1 && diff[end - 1] === diff[end - 2]) end--;
    return diff.slice(0, end);
  }

  // 先頭の連続ゼロ区間を切り出してdelayフレーム数として返す(残りがテーブル本体)。
  // classifyPitchModのperiodic/literal/ramp全パターンで共通利用(2026-08-11 別プロジェクトA)。
  function splitLeadingDelay(arr) {
    let i = 0;
    while (i < arr.length && arr[i] === 0) i++;
    return { delay: i, rest: arr.slice(i) };
  }

  function isMonotonic(arr) {
    let up = true, down = true;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] < arr[i - 1]) up = false;
      if (arr[i] > arr[i - 1]) down = false;
    }
    return up || down;
  }

  MML.Convert.classifyPitchMod = function (pitchSeq) {
    if (!pitchSeq || pitchSeq.length < MIN_LITERAL_FRAMES) return null;
    const base = pitchSeq[0];
    const diff = pitchSeq.map(p => p - base);
    const n = diff.length;

    let flatRun = 0;
    while (flatRun < n && diff[flatRun] === 0) flatRun++;
    if (flatRun === n) return null; // 全区間フラット。従来のD<n>のみで表現できる

    const maxStart = Math.min(flatRun, MAX_SEARCH_START);
    for (let start = 0; start <= maxStart; start++) {
      const remain = n - start;
      // 確認フレーム数(remain-period)がMIN_CONFIRM_FRAMES未満になる周期は試さない
      const maxPeriod = Math.min(MAX_PERIOD, remain - MIN_CONFIRM_FRAMES);
      for (let period = MIN_PERIOD; period <= maxPeriod; period++) {
        if (!isPeriodicFrom(diff, start, period)) continue;
        const loop = diff.slice(start, start + period);
        if (loop.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX)) continue; // この周期は範囲外、他を試す
        // 振幅が小さすぎる周期は却下し他を試す。特にKSS/GBS/HES/SPCの借用変換は
        // rescalePitchSeqFromFreq(Hz経由の丸め)を通すため、実際には無変調のノートでも
        // 境界値の丸め起因で1ステップだけ変化する区間がたまたま長い周期として
        // 「厳密に一致」してしまうことがある(実測: SPC Frog's Themeで振幅1のみの
        // 30フレーム超ループを誤検出)。ネイティブ変換(丸め無し)でも振幅1は
        // 装飾として意味を持ちにくいため、形式を問わず同じ基準で弾く。
        const loopMax = Math.max(...loop), loopMin = Math.min(...loop);
        if (loopMax - loopMin < MIN_LOOP_RANGE) continue;
        if (start > MAX_EP_DELAY) return null; // delayがbyte幅を超える異常値は安全側に倒す
        return { type: 'periodic', delay: start, values: loop };
      }
    }

    // 周期的でなければ、非周期だが意味のある変調(こぶし/アタックベンド/ランプ、
    // DESIGN-PITCH.md Phase 3)として非ループEPテーブル(literal、末尾は最終値を永久
    // ホールド)を試す。末尾の同一値足踏みをtrimしたのち、先頭の実測ゼロ区間も
    // delayとして切り出す(別プロジェクトA、pitch.js冒頭コメント参照)。
    const trimmed = trimTrailingHold(diff);
    const { delay: litDelay, rest } = splitLeadingDelay(trimmed);
    if (rest.length >= MIN_LITERAL_FRAMES) {
      const litMax = Math.max(...rest), litMin = Math.min(...rest);
      if (litMax - litMin >= MIN_LITERAL_RANGE &&
          !rest.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX) &&
          litDelay <= MAX_EP_DELAY) {
        return { type: isMonotonic(rest) ? 'ramp' : 'literal', delay: litDelay, values: rest };
      }
    }
    return null;
  };

  // cmd: src/convert/options.js の変換設定(省略可)。EP/MP/PT の個別ON/OFFを assign() で見る。
  MML.Convert.PitchEnvelopeRegistry = function (cmd) {
    this.cmd = MML.Convert.normalizeCmd(cmd);
    this.tables = new Map(); // index(@EP<N>の番号) -> { values, loop }
    this.keyToIndex = new Map();
    this.nextIndex = 0;
    // @MP<N>(ビブラート、{delay,speed,depth})用の独立した番号空間・重複排除マップ。
    // EPと違い、MPは本文側コマンド(MP<n>)がdelay引数を取れない(lexer.js参照。
    // EP<n>,<delay>のような拡張が無い)ため、delayもテーブル自体のキーに含める必要がある。
    this.vibratoTables = new Map(); // index(@MP<N>の番号) -> { delay, speed, depth }
    this.vibratoKeyToIndex = new Map();
    this.nextVibratoIndex = 0;
  };

  // {delay,speed,depth}が完全一致する@MP<n>を再利用し、無ければ新規登録する。
  MML.Convert.PitchEnvelopeRegistry.prototype.registerVibrato = function (mp) {
    const key = mp.delay + ',' + mp.speed + ',' + mp.depth;
    let idx = this.vibratoKeyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextVibratoIndex++;
      this.vibratoKeyToIndex.set(key, idx);
      this.vibratoTables.set(idx, mp);
    }
    return idx;
  };

  function shapeKey(shape) {
    return shape.values.join(',') + '|' + (shape.loop == null ? '-' : shape.loop);
  }

  // aがbの前方一致(prefix)かどうか(envelope.jsのisPrefixと同じ)。
  function isPrefix(a, b) {
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // pitchMod({type,delay,values})を{values,loop}テーブルへ変換して登録し、
  // {index, delay}を返す(2026-08-11 別プロジェクトA: delayはテーブルと独立管理する
  // ようになったため、登録先インデックスとは別に呼び出し元のpitchModが持つdelayを
  // そのまま素通しで返す。テーブル自体にdelayの概念は無い=同じ形なら異なるdelay値の
  // 呼び出し同士でも同じテーブル番号を共有できる)。
  //
  // ★@EPの値は本家ppmck準拠の「毎フレームの差分の累積」(2026-09-13修正、compiler.js
  // pitchEnvelopeValue参照。以前は各フレームの絶対オフセットをそのまま書いており、当ツール内では
  // 辻褄が合っていたが本家ppmckcでコンパイルすると別の動きになっていた)。classifyPitchModが
  // 返すvaluesは「基準からの絶対オフセット列」なので、ここで差分列へ変換して登録する
  // (toCumulativeDeltas)。this.tables に持つのは差分列:
  //  ・periodic: [a0 | a1-a0, ..., a(P-1)-a(P-2), a0-a(P-1)] loop=1。1周ぶんの差分の合計は
  //    必ず0(閉じた巡回)なので周回しても音程がドリフトしない(buildNoteEnvelopeDeltasと同じ理屈)
  //  ・literal/ramp: [a0, a1-a0, ..., a(n-1)-a(n-2)] loop=null。実機は「|」無しテーブルの末尾値を
  //    足し続けるので、defLines(書き出し時)で末尾に 0 を付けて止める(tablesには付けずに持つ:
  //    下記の前方一致共有を絶対オフセット時代と同じ条件で判定するため)
  // 差分がbyte幅(EP_VALUE_MIN..MAX)を超える形は登録せずnullを返す(→基準音のみ)。
  // ★loop有り同士(片方でもloop!=null)は前方一致していても共有・置き換えを一切行わない
  // (envelope.js EnvelopeRegistry.registerShapeと同じ理由・同じガード。
  // [[envelope-registry-loop-upgrade-bug]]参照。ループ有りのvaluesは「最小の繰り返し単位」に
  // 切り詰められており配列長が観測フレーム数を反映しないため、前方一致だけを根拠にした
  // 共有/差し替えは無関係な変調を混同する事故になる)。
  function toCumulativeDeltas(absValues, isPeriodic) {
    if (!absValues || absValues.length === 0) return null;
    const out = [absValues[0]];
    for (let k = 1; k < absValues.length; k++) out.push(absValues[k] - absValues[k - 1]);
    if (isPeriodic) out.push(absValues[0] - absValues[absValues.length - 1]);
    if (out.some(v => v < EP_VALUE_MIN || v > EP_VALUE_MAX)) return null;
    return { values: out, loop: isPeriodic ? 1 : null };
  }
  MML.Convert.toCumulativePitchDeltas = toCumulativeDeltas;

  MML.Convert.PitchEnvelopeRegistry.prototype.registerShape = function (pitchMod) {
    if (!pitchMod) return null;
    const isPeriodic = pitchMod.type === 'periodic';
    const shape = toCumulativeDeltas(pitchMod.values, isPeriodic);
    if (!shape) return null;
    for (const [idx, existing] of this.tables) {
      if (existing.loop != null || shape.loop != null) continue;
      if (isPrefix(existing.values, shape.values)) {
        if (shape.values.length > existing.values.length) this.tables.set(idx, shape);
        return { index: idx, delay: pitchMod.delay };
      }
      if (isPrefix(shape.values, existing.values)) return { index: idx, delay: pitchMod.delay };
    }
    const key = shapeKey(shape);
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextIndex++;
      this.keyToIndex.set(key, idx);
      this.tables.set(idx, shape);
    }
    return { index: idx, delay: pitchMod.delay };
  };

  // ── ポルタメントコマンド(DESIGN-PITCH.md 別プロジェクトC、2026-08-11) ──────
  // P-5「単調ランプ→ポルタメント(コマンドは将来)」の実装。検出側(classifyPitchMod)は
  // 無変更のまま、type:'ramp'の結果を後段(このファイル内)でさらに判定する:
  // 「MPの`warizan_start`(delay無し・反転無しの片道版)で寸分違わず再現できる、
  // 単純な一定ペースの直線グライドか」を検査し、再現できればPT<target>,<duration>
  // (2値だけの軽量コマンド、テーブル不要)へ、できなければ従来通り非ループEP
  // テーブル(literal、全フレーム値をそのまま保持)へ回す。
  // ★実機ppmck公式ドキュメント(doc/mck.txt)には専用のポルタメントコマンドが存在せず
  // 「ピッチエンベロープ(EP)で代用してください」と明記されている。したがってこの
  // PT<n>コマンドはppmck方言からの独自拡張であり(README.md方言対応表に明記、INV-2)、
  // EPは今後も可逆性チェックに失敗した場合のフォールバックとして必須(P-1「音の
  // 正しさ=軌跡保存」の非負妥協ライン。近似で妥協せず、再現できないものは安全側=EPへ)。
  // MMLの構文・バイトコード上(mckBytecode.js)のtargetは符号付き16bit(D<n>と同じ)まで
  // 表現できるが、6502ドライバ側のCEILDIV(MPと共有、ceilDivPpmck相当)がCDA/CDB共に
  // 1byteスクラッチのため|target|は255までしか正しく計算できない。この判定側でも
  // 同じ上限を掛けておく(判定と実装の上限がズレると「JS側は portamento と判定したのに
  // 6502側は8bit溢れで誤動作する」事故になるため、必ず両方揃えること)。
  const MAX_PORTAMENTO_TARGET = 255;
  const MAX_PORTAMENTO_DURATION = 255; // 6502側PTSTEPINT/duration格納は1byte

  // MPのwarizan_start(ceil除算によるBresenham風の一定ペース階段化)の片道版。
  // target(0からの目標オフセット)へduration フレームで到達する列をシミュレートする
  // (compiler.jsのvibratoSequence/ceilDivPpmckと同じアルゴリズムを反転無しで流用)。
  function simulatePortamento(target, duration) {
    const absTarget = Math.abs(target);
    const dir = target < 0 ? -1 : 1;
    let stepSize, stepInterval;
    if (duration === absTarget) { stepSize = 1; stepInterval = 1; }
    else if (duration > absTarget) { stepInterval = ceilDivPpmck(duration, absTarget); stepSize = 1; }
    else { stepSize = ceilDivPpmck(absTarget, duration); stepInterval = 1; }
    const seq = new Array(duration);
    let value = 0, counter = stepInterval;
    for (let t = 0; t < duration; t++) {
      if (counter === stepInterval) { counter = 0; value += dir * stepSize; }
      counter++;
      seq[t] = value;
    }
    return seq;
  }

  // ceilDiv(a,b): a>bの2値をwarizanと同じ規則(割り切れなければ+1、実測トレース済み。
  // src/mml/compiler.jsのceilDivPpmckと同一実装をここでも独立に持つ、共有しない
  // 理由はP-3参照)で割る。
  function ceilDivPpmck(a, b) {
    if (a === b) return 1;
    let q = 0, rem = a;
    while (rem > 0) { q++; rem -= b; }
    return q;
  }

  // valuesがsimulatePortamento(target,duration)と1バイトも違わず一致するかを確認し、
  // 一致すれば{target,duration}を、しなければnullを返す(rampだが直線でない=EPへ)。
  function fitPortamento(values) {
    const duration = values.length;
    const target = values[values.length - 1];
    if (target === 0 || duration < 1) return null;
    if (Math.abs(target) > MAX_PORTAMENTO_TARGET || duration > MAX_PORTAMENTO_DURATION) return null;
    const simulated = simulatePortamento(target, duration);
    for (let i = 0; i < duration; i++) if (simulated[i] !== values[i]) return null;
    return { target, duration };
  }

  // ── ビブラートコマンド(DESIGN-PITCH.md 別プロジェクトB、gate解除は2026-08-15) ──
  // P-5「周期的振動(三角形状)→MP<n>」の実装。別プロジェクトBでcompiler.jsのMPが
  // lfo_sub/warizan_startの厳密移植になった(2026-08-11)後も、抽出側(ここ)は
  // 「MPは近似実装だった名残」でしばらく常にループEP<n>を使い続けていた
  // (gateが実装完了後も外されないまま残っていた、2026-08-15にユーザー指摘で発覚・解消)。
  // 検出側(classifyPitchMod)は無変更のまま、type:'periodic'の結果を後段(このファイル内)
  // でさらに判定する: 「MPの`lfo_sub`(delay無しでオシレーション形状だけを見る)で
  // 寸分違わず再現できる、階段状の対称往復振動か」を検査し、再現できればMP<n>
  // (3パラメータだけの軽量コマンド、テーブルは{delay,speed,depth}の3値のみ)へ、
  // できなければ従来通りループEPテーブルへ回す(fitPortamentoと全く同じ「シミュレート
  // して安全に妥協しない」設計方針)。
  const MAX_MP_SPEED = 255, MAX_MP_DEPTH = 255; // @MP<n>={delay,speed,depth}は各値1byte幅
                                                 // (mckBytecode.js/ppmckDriver.js側、delay/speed/depth共通)

  // compiler.jsのvibratoSequence(lfo_sub厳密移植)と同一アルゴリズムをここでも独立に持つ
  // (ceilDivPpmckと同じ理由=P-3で共有しない)。delay=0固定(delayはpitchModが別途返すため、
  // ここでは純粋なオシレーション形状の照合だけを行う)。
  function simulateVibrato(quarter, rawDepth, dur, direction) {
    let stepSize, stepInterval;
    if (quarter === rawDepth) { stepSize = 1; stepInterval = 1; }
    else if (quarter > rawDepth) { stepInterval = ceilDivPpmck(quarter, rawDepth); stepSize = 1; }
    else { stepSize = ceilDivPpmck(rawDepth, quarter); stepInterval = 1; }
    const seq = new Array(dur);
    let reverseCounter = quarter, adcSbcCounter = stepInterval, dir = direction, value = 0;
    for (let t = 0; t < dur; t++) {
      if (reverseCounter === quarter * 2) { reverseCounter = 0; dir = -dir; }
      if (adcSbcCounter === stepInterval) { adcSbcCounter = 0; value += dir * stepSize; }
      reverseCounter++; adcSbcCounter++;
      seq[t] = value;
    }
    return seq;
  }

  // periodFn(freqを生レジスタへ写す関数)が増加関数か減少関数かを実測判定する
  // (compiler.jsのperiodFnIncreasingと全く同じ2点比較、独立に持つ=P-3)。
  function periodFnIncreasingLocal(periodFn) {
    return periodFn(2000) > periodFn(200);
  }

  // 周期的ビブラート(classifyPitchModのperiodic、1周期分のvalues)がMP<n>の
  // {speed,depth}パラメータ空間(lfo_sub、ceil除算の階段状LFO)で寸分違わず再現できるか
  // 検査する。再現できれば{speed,depth}を、できなければnullを返す(呼び出し側は
  // 従来通りループEPテーブルへフォールバックする)。
  //
  // directionUp: 出力先チップの周波数方向。true=周波数レジスタ(値が上がるほど音程が
  // 上がる: FDS/N163)、false=周期レジスタ(値が下がるほど音程が上がる: 2A03/VRC6/
  // MMC5/FME7)。compiler.jsのperiodFnIncreasing→vibratoSequence呼び出しと完全に同じ
  // 規則で、呼び出し元が出力先チャンネルのチップに合わせて渡す必要がある(渡し間違えると
  // 実際にMPで再コンパイルした時だけ逆位相になる=ここでのbit一致確認をすり抜けてしまう
  // 唯一のポイントなので注意)。VRC7はEP/MP対象外(fnum/blockの対数空間)なので
  // directionUpをundefinedのまま渡せば自動的にフィットを試みない。
  //
  // ★探索範囲: 観測周期period が4の倍数でなければ不採用(quarter=period/4が整数に
  // ならないと lfo_sub の基本周期4*quarterと噛み合わない。quarter>depthの場合は
  // ceil除算の噛み合わせで真の周期が4*quarterより長くなることがあるが、そのケースは
  // 下の「3周期ぶん完全一致」チェックで自然に弾かれる=安全側にEPへフォールバックする)。
  // quarterは上記でただ1通りに決まるため、depthだけを観測振幅(peak)近傍で総当たりする。
  //
  // ★位相はvalues[0]がそのままsim[0](オシレーション開始直後の最初のステップ済み値)と
  // 一致することを要求する(任意回転は許容しない)。理由: vibratoSequenceは「delay
  // フレームだけ0を保持し、その直後は必ず自前の初期状態(reverseCounter=quarter,
  // adcSbcCounter=stepInterval,value=0)から新規にオシレーションを開始する」実装であり、
  // ノート開始のたびに位相をリセットする(=途中の任意の位相から始めることはできない、
  // かつsim自体は最初の1フレーム目から必ずステップ済みの非0値になり、0そのものには
  // ならない)。
  //
  // ★ただし「values先頭の連続0」だけは特別扱いしてdelay側へ吸収する。classifyPitchModは
  // (EP用途では位相を気にする理由が無いため)観測データの0交差を「delay」側に含めるか
  // 「valuesの先頭」に含めるかを一意に決めない=前方一致で複数の(start,period)が同等に
  // 有効なため、実測で「valuesの先頭が0(オシレーション自身の自然な0交差)」という
  // 決定をしがちだと確認済み(delay=5で生成した合成データがdelay=4+values=[0,-2,...]と
  // 分類され、素朴にpitchMod.delayをそのまま使うと1フレームずれた誤った波形になる、
  // 実装時に発覚)。0は「delayホールド中の値」でもあるため、この曖昧さは
  // 「valuesの先頭の連続0をdelay側の延長とみなす」ことで一意に解消できる(0以外の
  // 値は延長候補になり得ない=sim自体が0を返さないため、この吸収は安全側の補正であり
  // 妥協ではない)。吸収した後の残りの列がsim[0..]と寸分違わず一致することを要求する
  // (先頭以外の回転は引き続き許容しない)。
  const MAX_VIBRATO_FIT_PERIOD = 64; // MAX_PERIODと同じ(classifyPitchModが返す周期の上限)
  const MAX_MP_DELAY = 255; // @MP<n>のdelayも1byte幅(mckBytecode.js/ppmckDriver.js側)

  function fitVibrato(values, baseDelay, directionUp) {
    if (directionUp == null) return null;
    const period = values.length;
    if (period < 4 || period % 4 !== 0 || period > MAX_VIBRATO_FIT_PERIOD) return null;
    let leadingZeros = 0;
    while (leadingZeros < period && values[leadingZeros] === 0) leadingZeros++;
    if (leadingZeros >= period) return null; // 全区間0(あり得ないはずだが念のため)
    const delay = baseDelay + leadingZeros;
    if (delay > MAX_MP_DELAY) return null;
    const quarter = period / 4;
    if (quarter > MAX_MP_SPEED) return null;
    const direction = directionUp ? 1 : -1;
    const peak = Math.max(...values.map(v => Math.abs(v)));
    const depthLo = Math.max(1, peak - quarter - 1);
    const depthHi = Math.min(MAX_MP_DEPTH, peak + quarter + 1);
    const simDur = period * 3; // 3周期ぶん確認し、真に無限に繰り返し可能なことを保証する
    for (let rawDepth = depthLo; rawDepth <= depthHi; rawDepth++) {
      const sim = simulateVibrato(quarter, rawDepth, simDur, direction);
      let ok = true;
      for (let i = 0; i < simDur; i++) {
        if (sim[i] !== values[(i + leadingZeros) % period]) { ok = false; break; }
      }
      if (ok) return { delay, speed: quarter, depth: rawDepth };
    }
    return null;
  }

  // pitchSeqを解析し、{kind:'portamento', target, duration, delay} |
  // {kind:'vibrato', index} | {kind:'ep', index, delay} | nullを返す(呼び出し側は
  // kindで分岐してev.portamento/ev.vibrato/ev.pitchEp+ev.pitchEpDelayを設定する)。
  // 変調が見つからなければnull(呼び出し側はD<n>のみを使うべき合図)。
  //
  // directionUp: 周期的ビブラート(periodic)をMP<n>へフィットする際に使う出力先チップの
  // 周波数方向(fitVibrato参照)。省略時(undefined)はMPへのフィットを試みず、
  // 従来通り常にループEPテーブルを使う(VRC7=EP/MP対象外チャンネルの既定動作と一致)。
  // ── SA<num>(ピッチシフト量、ppmckc公式・N163専用)の自動選択 ─────────────
  // EPテーブル値は符号付きbyte(EP_VALUE_MIN/MAX)・MP depthも1byteだが、N163の周波数
  // レジスタは18bitで1オクターブごとに値が2倍になる。深いビブラート等は生オフセットが
  // byte幅を大きく超えて割当が失敗するため(実測: HESの変調イベントの58〜98%が黙って
  // 破棄されていた)、SA<num>で値を<num>回左シフトして適用するようにし、テーブルには
  // 縮めた値(>>sa)を登録する。量子化は2^sa単位=変調深さの約1/127で、セント換算1〜2程度。
  //
  // saMode('PITCH_SA'変換設定、src/convert/options.js):
  //   'octave' … 基準レジスタ値のオクターブに連動(sa=floor(log2(base))-10、正規化後の
  //              基準値が1024〜2047になる位置)。同じセント形状のビブラートがオクターブを
  //              またいで同一のテーブル値になり、EnvelopeRegistryのdedupeが効く。
  //              量子化ステップはセント換算0.85〜1.7で一定(オクターブ非依存)。既定。
  //   'note'   … 音符ごとに必要最小のsa(最高精度、テーブル共有は減る)
  //   'off'    … SAを使わない(従来互換。byte幅を超える変調は従来どおり割当失敗)
  // どのモードもレンジに収まらない場合はsa+1のエスケープで引き上げる(上限8=本家仕様)。
  MML.Convert.n163SaForBase = function (baseReg) {
    if (!(baseReg > 0)) return 0;
    return Math.max(0, Math.min(8, Math.floor(Math.log2(baseReg)) - 10));
  };

  // pitchSeq(生レジスタ値列)に対する実際のsaを決める。baseSa(モードごとの基本値)から、
  // 最大偏差がEPのbyte幅に収まるまで引き上げる
  function resolveSa(pitchSeq, baseSa) {
    const base = pitchSeq[0];
    let maxAbs = 0;
    for (const v of pitchSeq) { const d = Math.abs(v - base); if (d > maxAbs) maxAbs = d; }
    let sa = Math.max(0, Math.min(8, baseSa || 0));
    while (sa < 8 && (maxAbs >> sa) > EP_VALUE_MAX) sa++;
    return sa;
  }

  // saOpts(省略可): { mode: 'octave'|'note'|'off', baseSa: number }。
  // N163が出力先のときだけ渡す(assignPitchEnvelopeのopts.saMode経由、または
  // nsf2mml/spc2mmlのN163パスから直接)。戻り値にsa(使用したシフト量)が付く。
  MML.Convert.PitchEnvelopeRegistry.prototype.assign = function (pitchSeq, directionUp, saOpts) {
    const cmd = this.cmd;
    if (!cmd.EP && !cmd.MP && !cmd.PT) return null; // 変換設定で全てOFF(基準音のみ)
    let sa = 0;
    let seq = pitchSeq;
    if (saOpts && saOpts.mode && saOpts.mode !== 'off') {
      sa = resolveSa(pitchSeq, saOpts.baseSa || 0);
      if (sa > 0) {
        const base = pitchSeq[0];
        seq = pitchSeq.map(v => base + Math.round((v - base) / (1 << sa)));
      }
    }
    // ★MMLのEP/PT値は全音源「正=音程が上がる」(2026-09-14統一、compiler.js pitchRegDir参照)。
    // pitchSeqはレジスタ空間なので、周期レジスタ系(directionUp=false: 音程が上がると値が減る)は
    // 基準値を軸に反転してからMML値として分類・登録する。MPのfitVibratoにも反転後の列を渡すので
    // 方向は常に「上向き=正」(true)で扱う
    if (directionUp === false) {
      const base0 = seq[0];
      seq = seq.map(v => 2 * base0 - v);
      directionUp = true;
    }
    const pitchMod = MML.Convert.classifyPitchMod(seq);
    if (!pitchMod) return null;
    if (pitchMod.type === 'ramp') {
      const fit = cmd.PT ? fitPortamento(pitchMod.values) : null;
      // PT(独自拡張)はSAのシフト対象外(compiler.js pitchRegisterOffset参照)のため、
      // targetを生スケールへ戻して返す
      if (fit) return { kind: 'portamento', target: fit.target * (1 << sa), duration: fit.duration, delay: pitchMod.delay, sa };
    } else if (pitchMod.type === 'periodic') {
      const fit = cmd.MP ? fitVibrato(pitchMod.values, pitchMod.delay, directionUp) : null;
      if (fit) {
        const idx = this.registerVibrato({ delay: fit.delay, speed: fit.speed, depth: fit.depth });
        return { kind: 'vibrato', index: idx, sa };
      }
    }
    if (!cmd.EP) return null; // EPが受け皿として使えなければ基準音のみ
    const registered = this.registerShape(pitchMod);
    return registered ? { kind: 'ep', index: registered.index, delay: registered.delay, sa } : null;
  };

  MML.Convert.PitchEnvelopeRegistry.prototype.defLines = function () {
    const epLines = Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      // 非ループは末尾0で止める(registerShapeのコメント参照。末尾が既に0なら付けない)
      else if (t.values[t.values.length - 1] !== 0) parts.push('0');
      return `@EP${i} = { ${parts.join(' ')} }`;
    });
    const mpLines = Array.from(this.vibratoTables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.vibratoTables.get(i);
      return `@MP${i} = { ${t.delay}, ${t.speed}, ${t.depth} }`;
    });
    return [...epLines, ...mpLines];
  };

  // periodFn(freq, ev): applyPitchDetune/detectChorusDetuneと同じ2引数版
  // 生周期換算関数(evはHESのn163PeriodRawのようにev.rawLength等を参照する場合に必要)。
  MML.Convert.rescalePitchSeqFromFreq = function (freqSeq, periodFn, ev) {
    const cont0 = periodFn(freqSeq[0], ev);
    const base = Math.round(cont0);
    return freqSeq.map(f => base + Math.round(periodFn(f, ev) - cont0));
  };

  // 借用変換(KSS/GBS/HES)向けのまとめ役: channels([{events}])の各イベントの
  // ev.freqSeqをperiodFn(detectChorusDetune/applyPitchDetuneと同じ生周期換算関数)で
  // 借用先チップの生レジスタ空間へ変換して分類・登録し、該当すればev.pitchEpを立てる
  // (MML出力側でのgetter用にイベントオブジェクトを直接書き換える。detectChorusDetuneが
  // ev.detuneを直接書き込むのと同じ流儀)。
  // opts.saMode('octave'|'note'|'off'): 出力先がN163のときだけ渡すSA<num>自動選択
  // (n163SaForBase冒頭コメント参照)。省略時はSA無し(従来動作)。
  MML.Convert.assignPitchEnvelope = function (channels, periodFn, pitchReg, opts) {
    // このperiodFn(=呼び出し元が渡す借用先チップの生周期換算関数)自体の増減方向を
    // 1回だけ調べ、fitVibratoへ渡す(compiler.jsのperiodFnIncreasingと同じ2点比較)。
    const directionUp = periodFnIncreasingLocal(periodFn);
    const saMode = opts && opts.saMode && opts.saMode !== 'off' ? opts.saMode : null;
    for (const ch of channels) {
      for (const ev of ch.events) {
        if (ev.note === null || !ev.freqSeq || ev.freqSeq.length === 0) continue;
        const rescaled = MML.Convert.rescalePitchSeqFromFreq(ev.freqSeq, periodFn, ev);
        const saOpts = saMode
          ? { mode: saMode, baseSa: saMode === 'octave' ? MML.Convert.n163SaForBase(rescaled[0]) : 0 }
          : undefined;
        const assigned = pitchReg.assign(rescaled, directionUp, saOpts);
        MML.Convert.applyPitchAssignment(ev, assigned);
        // SAはD<n>にも効く(compiler.js pitchRegisterOffset、本家freq_add_mcknumber参照)ため、
        // この音符のDも同じシフトで縮めて出力する(量子化2^sa単位≈1〜2セント)
        if (ev.pitchSa && ev.detune) ev.detune = Math.round(ev.detune / (1 << ev.pitchSa));
      }
      // スラー分割(別プロジェクトE、2026-08-12): pitchEp/portamentoが確定した直後に
      // まとめて行う(markSlurTiesの安全ガードが両方の値を参照するため)。KSS(ay/scc)・
      // GBS(pulse/wave)・HES(wave)は全てこの共通ヘルパーを経由するため、ここ1箇所で
      // 3形式に一括で効く(Project A/Cと同じ集約点の再利用)
      MML.Convert.markSlurTies(ch.events);
    }
  };

  // pitchReg.assign()の戻り値({kind:'portamento',...}|{kind:'vibrato',...}|{kind:'ep',...}|null)
  // をevへ適用する共通ヘルパー(2026-08-11 別プロジェクトC、2026-08-15 別プロジェクトB gate解除)。
  // 呼び出し元(assignPitchEnvelope・各*2mmlのtoPitchFields相当)で同じkind分岐を
  // 重複させないためにここへ集約する。
  MML.Convert.applyPitchAssignment = function (ev, assigned) {
    if (!assigned) return;
    // SA<num>(assign()のsaOpts参照): この音符のEP/MP値が>>saで登録されているため、
    // 再生時に同じsaで戻せるようイベントへ記録する(mmlEmitがSA<n>コマンドとして出力)
    if (assigned.sa != null && assigned.sa > 0) ev.pitchSa = assigned.sa;
    if (assigned.kind === 'portamento') {
      ev.portamento = { target: assigned.target, duration: assigned.duration, delay: assigned.delay };
    } else if (assigned.kind === 'vibrato') {
      ev.vibrato = assigned.index;
    } else {
      ev.pitchEp = assigned.index;
      ev.pitchEpDelay = assigned.delay;
    }
  };

  // ── 高速アルペジオ→ノートエンベロープ(EN)統合(2026-08-14) ──────────────
  // チップチューンでは、1chしか無い音源で和音を鳴らすため「フレーム単位で複数の
  // 音程を高速に切り替える」演奏方法(アルペジオ)が非常によく使われる。抽出ループ
  // 自体は「音程(半音丸め値)が変わったら即新イベント」という規則のため、これは
  // 1フレームだけの極短いイベントの連なりとして抽出される。従来はこれをEP(生
  // レジスタ差分のピッチエンベロープ)で表現しようとしていたが、EPは「基準ノート
  // からの生レジスタオフセット」空間のテーブルであり、本来「複数の異なる音程を
  // 正確に鳴らしている」という演奏意図を表すのに適さない(値がチップ・音域ごとに
  // 意味の変わる生レジスタ単位になり、可読性も低い)。ここでは、各ステップの実測
  // 周波数が最寄りの12平均律半音に十分近い(=本当にその音程を狙って鳴らしている)
  // 場合に限り、1つの音符+EN<n>(ノート番号空間の相対オフセット、ppmck仕様通り
  // 累積値)へ統合する。セント誤差が大きい(=半音に乗っていない生々しいピッチベンド/
  // ビブラート)場合は対象外とし、従来通りEP/個別音符のままにする(実測: GBS Robocop
  // CH2冒頭のアルペジオは誤差1〜3セントで綺麗に半音に乗っており、CH1のEP0/EP4等の
  // 浅いビブラートは22〜47セットとずれているため、この閾値で正しく判別できる)。
  const MAX_ARPEGGIO_STEP_FRAMES = 8; // 1ステップがこれ以下のフレーム数なら「高速」とみなす
  const MIN_ARPEGGIO_PERIOD = 2;
  const MAX_ARPEGGIO_PERIOD = 8; // 一般的な和音の構成音数を超える周期は誤検出とみなして除外
  const MIN_ARPEGGIO_CYCLES = 2; // 最低2周期分の反復確認(偶然の一致除け)
  const ARPEGGIO_CENTS_TOLERANCE = 25; // 半音の1/4以内なら「その半音に厳密に乗っている」とみなす
  // トリル判別(mergeAlternatingVibratoの形状ゲート、同所コメント参照)
  const TRILL_MIN_CENTS = 70;          // 方形でもこれ未満の浅い変調はビブラートとして統合を許す
  const TRILL_MIDDLE_FRAC_MAX = 0.15;  // 中間帯滞在サンプル比がこれ未満なら方形(2値切替)とみなす
  const EN_VALUE_MIN = -127, EN_VALUE_MAX = 126; // @EN<n>テーブル値は符号付きbyte(lexer.js参照、EPと共通)

  // freq(Hz)が最寄りの12平均律半音(o4a=57=440Hz基準、他の抽出コードと同じ規約)から
  // 何セントずれているかを返す(-50〜+50の範囲)。
  function centsFromNearestSemitone(freq) {
    if (!(freq > 0)) return Infinity;
    // 基準ピッチ(#TUNING、src/convert/options.js MML.Convert.tuningCents)込み。抽出器の丸め
    // (freqToNote)と同じ基準で「半音に乗っているか」を判定しないと、全体ずれのある曲で
    // 綺麗なアルペジオまで「半音に乗っていない」と誤判定して EN 統合から漏れる
    const cont = 57 + 12 * Math.log2(freq / 440) - MML.Convert.tuningCents() / 100;
    return (cont - Math.round(cont)) * 100;
  }

  // 実測周波数(Hz)を保持するフィールド名はフォーマットの抽出コードによって
  // rawFreq/freqHzのどちらか一方に揺れている(toCommon内で最終的にどちらも
  // rawFreqへ揃えて出力されるが、mergeRapidArpeggioはtoCommon実行前の生イベントを
  // 見るためこの時点では揺れが残っている)。両対応にしておくことで、呼び出し側
  // フォーマット毎の個別対応を増やさずに済む。
  function eventFreq(ev) {
    return ev.rawFreq != null ? ev.rawFreq : ev.freqHz;
  }

  // absorbed(短いイベントの連なり)のnote列から、周期的に繰り返す最小周期を探す
  // (classifyPitchModのperiodic探索と同じ「最小周期優先・最低2周期分確認」方針)。
  // 見つかれば{ period, matchLen }(matchLen=absorbed先頭から実際にその周期へ
  // 一致し続けた長さ、period以上でperiodの倍数とは限らない)を返す。無ければnull。
  function findArpeggioPeriod(notes) {
    const n = notes.length;
    const maxPeriod = Math.min(MAX_ARPEGGIO_PERIOD, Math.floor(n / MIN_ARPEGGIO_CYCLES));
    for (let period = MIN_ARPEGGIO_PERIOD; period <= maxPeriod; period++) {
      let matchLen = period;
      while (matchLen < n && notes[matchLen] === notes[matchLen - period]) matchLen++;
      if (matchLen >= period * MIN_ARPEGGIO_CYCLES) return { period, matchLen };
    }
    return null;
  }

  // 周期分のnote列(cycleNotes、最後の要素が「MML本文の音符として書き出す基準ノート」
  // になる。詳細は下記)から、@EN<n>用の累積差分テーブルを作る。
  //
  // cumulativeEnvelopeValue(compiler.js)は値を毎フレーム加算していく「累積」方式で、
  // @v(stepEnvelope)のような単純な周期的インデックス参照ではない(EPも2026-09-13以降は
  // 同じ累積方式、registerShape/toCumulativeDeltas参照)。そのため
  // ループ(loop=0)で正しく繰り返すには、1周期ぶんの差分の合計が必ず0になっている
  // 必要がある(そうでないと繰り返すたびに音程がドリフトしてしまう)。
  // 「周期内の最後のノート(cycleNotes末尾)」を基準(オフセット0)に選び、
  // 差分列を「基準→note[0]→note[1]→...→note[P-2]→基準(次周期の頭)」という
  // 閉じた巡回として構成すると、和音の回り方に関わらず合計は必ず0になる
  // (P角形を1周する経路の合計変位は常に0という単純な性質)。
  // durations(各ステップのフレーム数、通常は全て1)ぶん、2フレーム目以降は
  // 差分0(保持)を挟む。
  function buildNoteEnvelopeDeltas(cycleNotes, durations) {
    const period = cycleNotes.length;
    const refNote = cycleNotes[period - 1];
    let prevOffset = 0; // 基準ノート自身のオフセット
    const deltas = [];
    for (let k = 0; k < period; k++) {
      const offset = cycleNotes[k] - refNote;
      deltas.push(offset - prevOffset);
      for (let f = 1; f < durations[k]; f++) deltas.push(0);
      prevOffset = offset;
    }
    return { refNote, deltas };
  }

  // ★和音→アルペジオ(src/input/quantize.js)でも同じ符号化を使うので公開する。
  //   EN<n>の中身の作り方が2箇所に分かれると、片方だけ直して食い違う
  MML.Convert.buildNoteEnvelopeDeltas = buildNoteEnvelopeDeltas;

  // mergeAlternatingVibratoと同じ「隣接イベント列→統合後イベント列」形式。
  // 統合したイベントには ev.noteEnvOffsets(累積差分配列)を付与する(登録・EN<n>への
  // 割当ては呼び出し元のassignNoteEnvelopeが曲全体で共有するNoteEnvelopeRegistry経由で
  // 行う。envelope.js/pitch.jsの既存レジストリと同じ「検出はここ、登録は呼び出し元」
  // という役割分担)。mergeAlternatingVibratoより先に(=優先して)呼ぶこと
  // (セントの綺麗な高速アルペジオはこちらで、それ以外の2値往復ビブラートは
  // mergeAlternatingVibratoで、と役割を分けるため)。
  MML.Convert.mergeRapidArpeggio = function (events) {
    const result = [];
    let i = 0;
    const n = events.length;
    while (i < n) {
      const home = events[i];
      const homeFreq = eventFreq(home);
      if (home.note == null || homeFreq == null ||
          (home.end - home.start) > MAX_ARPEGGIO_STEP_FRAMES ||
          Math.abs(centsFromNearestSemitone(homeFreq)) > ARPEGGIO_CENTS_TOLERANCE) {
        result.push(home); i++; continue;
      }
      // 短く・セントの綺麗な・音色が揃っている連続イベントを貪欲に集める
      // (★直接連続する同ノートはretrigger等のハード境界とみなし跨がない、
      // mergeAlternatingVibratoと同じ安全策)
      const run = [home];
      let j = i + 1;
      while (j < n) {
        const seg = events[j];
        const segFreq = eventFreq(seg);
        if (seg.note == null || segFreq == null) break;
        if ((seg.end - seg.start) > MAX_ARPEGGIO_STEP_FRAMES) break;
        if (seg.note === run[run.length - 1].note) break;
        if (Math.abs(centsFromNearestSemitone(segFreq)) > ARPEGGIO_CENTS_TOLERANCE) break;
        if (!hysteresisCompatible(seg, home)) break;
        run.push(seg);
        j++;
      }
      const found = findArpeggioPeriod(run.map(e => e.note));
      if (found) {
        const used = run.slice(0, found.matchLen);
        const cycle = used.slice(0, found.period);
        const cycleNotes = cycle.map(e => e.note);
        const durations = cycle.map(e => e.end - e.start);
        const { refNote, deltas } = buildNoteEnvelopeDeltas(cycleNotes, durations);
        if (!deltas.some(v => v < EN_VALUE_MIN || v > EN_VALUE_MAX)) {
          const last = used[used.length - 1];
          // refNote(=cycle末尾のノート)を基準ノートとしてMML本文に書き出すため、
          // rawFreq/freqSeqもhome(周期先頭)ではなくrefNoteに対応する値へ揃える
          // (揃えないと、後段のapplyPitchDetune/detectChorusDetuneがnoteとrawFreqの
          // 食い違い=無関係な2音間の周波数比較からD<n>を誤計算してしまう)。
          // rawFreq/freqHzの両方を設定するのは、フォーマットごとにtoCommon()が
          // 参照するフィールド名が揺れているため(eventFreq()コメント参照)。
          const refEvent = cycle[cycle.length - 1];
          const refFreq = eventFreq(refEvent);
          result.push(Object.assign({}, home, {
            note: refNote,
            rawFreq: refFreq,
            freqHz: refFreq,
            end: last.end,
            volSeq: concatField(used, 'volSeq'),
            // 統合前の各音符が持っていた「ハード音量エンベロープの打ち直し」位置
            // (nsf2mml/converter.js begin()のhwEnvSeq参照)。1音符=1本の減衰カーブしか
            // 持てないため、統合先で実測レベル列を組み直せるようにフレーム毎の並びのまま繋ぐ
            hwEnvSeq: concatField(used, 'hwEnvSeq'),
            // pitchSeqはhome(周期先頭の1音符ぶん、通常は極短い)のまま残すと、各*2mmlの
            // toCommon()がev.pitchSeq.map(periodFn)からfreqSeqを組み立てる際にend-startと
            // 長さの合わないデータになる。空にしておけばfreqSeq=[]となり、後段の
            // assignPitchEnvelopeが「変調無し」として安全にスキップする
            // (noteEnvOffsetsで表現済みなのでEP側の変調検出はそもそも不要)。
            pitchSeq: [],
            noteEnvOffsets: deltas
          }));
          i += used.length;
          continue;
        }
      }
      result.push(home);
      i++;
    }
    return result;
  };

  // cmd: src/convert/options.js の変換設定(省略可)。cmd.EN===false なら登録せず null
  // (アルペジオ統合済みイベントは基音1音のまま出る)。
  MML.Convert.NoteEnvelopeRegistry = function (cmd) {
    this.cmd = MML.Convert.normalizeCmd(cmd);
    this.tables = new Map(); // index(@EN<N>の番号) -> { values, loop }
    this.keyToIndex = new Map();
    this.nextIndex = 0;
  };

  // 周期的アルペジオは常にloop=0(先頭からループ、buildNoteEnvelopeDeltasが1周期分の
  // 合計0の閉じた差分列を作るため)。EnvelopeRegistry/PitchEnvelopeRegistryと同じ
  // 「loop有無が食い違うテーブルは前方一致でも共有しない」規約([[envelope-registry-loop-upgrade-bug]]
  // 参照)は、EN側は現状ループ専用(非ループ生成経路が無い)ため該当しないが、将来
  // 非ループEN生成を追加する場合はここも同じガードを入れること。
  MML.Convert.NoteEnvelopeRegistry.prototype.registerShape = function (deltas) {
    if (!deltas || deltas.length === 0 || !this.cmd.EN) return null;
    const key = deltas.join(',');
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextIndex++;
      this.keyToIndex.set(key, idx);
      this.tables.set(idx, { values: deltas, loop: 0 });
    }
    return idx;
  };

  MML.Convert.NoteEnvelopeRegistry.prototype.defLines = function () {
    return Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      return `@EN${i} = { ${parts.join(' ')} }`;
    });
  };

  // assignPitchEnvelopeと対になる、mergeRapidArpeggioが付与したev.noteEnvOffsetsを
  // 曲全体で共有するNoteEnvelopeRegistryへ登録してev.noteEnvを確定する。
  // mergeRapidArpeggio自身が登録まで行わないのは、EnvelopeRegistry/PitchEnvelopeRegistry
  // と同じく複数チャンネルをまたいだ重複排除を1つの共有レジストリで行うため
  // (曲中の別チャンネル・別箇所で偶然同じ形のアルペジオが出れば1つのEN<n>にまとまる)。
  MML.Convert.assignNoteEnvelope = function (channels, noteEnvReg) {
    for (const ch of channels) {
      for (const ev of ch.events) {
        if (!ev.noteEnvOffsets) continue;
        const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
        if (idx != null) ev.noteEnv = idx;
        delete ev.noteEnvOffsets;
      }
    }
  };

  // extractEvents直後にどのフォーマットも呼んでいた「MML.Convert.mergeAlternatingVibrato(...)」
  // を置き換える統合ヘルパー。mergeRapidArpeggioを必ず先に(優先して)適用し、そこで
  // 統合されなかった残りのイベントにだけmergeAlternatingVibratoを適用する
  // (pitch.js冒頭のmergeRapidArpeggioコメント参照)。rawFreqを持たない抽出結果
  // (SPC/ノイズ/OPLL等)ではmergeRapidArpeggioは何もせず素通りするだけなので、
  // 呼び出し側を条件分岐させずに一律この関数へ差し替えて問題ない。
  // opts.maxAbsorbCents: mergeAlternatingVibratoの統合上限(同関数コメント参照)。省略時は無制限
  MML.Convert.mergeVibratoAndArpeggio = function (events, opts) {
    return MML.Convert.mergeAlternatingVibrato(MML.Convert.mergeRapidArpeggio(events), opts);
  };

  // ── 分節のヒステリシス化(DESIGN-PITCH.md Phase 2、§5手順3) ──────────────
  // 「半音丸め値が変わったら即分割」(note !== cur.note)のせいで、半音境界を跨ぐ
  // 深いビブラートが音符連打(note spam)に化ける問題を、抽出後の後処理パスとして
  // 修正する(各extractorの毎フレームループ自体は変更しない。既存のsplitRetriggers
  // と同じ「抽出→後処理パスで分割/統合」の型を踏襲)。
  //
  // 方式: 隣接するイベント列から「同じ2つの隣接ノート番号(home/alt)が交互に現れる
  // 連続区間」を貪欲に集め、連結したpitchSeqが実際に
  // MML.Convert.classifyPitchMod で周期的と判定できた場合にのみ1イベントへ統合する。
  // T(セント)/M(フレーム)の固定しきい値を新たに発明せず、Phase 1で既に実データ調整済みの
  // 周期検出(MIN_CONFIRM_FRAMES/MIN_LOOP_RANGE等)をそのまま「これは統合してよい
  // ビブラートか」の判定に流用する(判定基準を増やさずP-3の厳密周期性だけで揺れを
  // 判別する)。
  //
  // ★同じノート番号の隣接イベント(retrigger等、ハード境界由来)は絶対に跨がない
  // (実データで確認: KSSのYs1やGBSの一部曲では、ビブラートと無関係な音量打ち直しが
  // 同じ音程のまま複数イベントに分かれることがあり、これを跨いで統合すると打ち直しが
  // 消えてしまう。DMG-CVJ.gbsで実測)。「home,home」のような直接連続する同ノートは
  // 常にheam boundaryとみなし、そこで貪欲集めを打ち切る(集められた区間が短すぎれば
  // 何も統合しない=安全側)。
  //
  // ev.duty/waveKey/mode/noise/envUsed/envShape/envPeriod/modKey/constVol/envKeyの
  // いずれかが食い違う隣接イベントも統合しない(音色/エンベロープの変化は既存どおり
  // 独立した音符のまま)。
  const HYSTERESIS_HARD_KEYS = [
    'duty', 'constVol', 'envKey', 'waveKey', 'mode', 'noise',
    'envUsed', 'envShape', 'envPeriod', 'modKey',
    // FDS(nsf2mml/expansion/fds.js)専用: ハードウェア音量エンベロープの有効/無効が
    // 食い違う隣接イベントは統合しない(音量の扱いが根本的に変わるため)
    'envEnabled',
    // OPLL(kss2mml/expansion/opll.js)専用: 音色番号・VRC7カスタム音色が食い違う
    // 隣接イベントは統合しない(dutyに相当する「音色選択」がこのフィールド名のため)
    'instrument', 'vrc7Tone',
    // SPC(spc2mml/converter.js)専用: 楽器(サンプル/エンベロープ)が食い違う隣接イベントは
    // 統合しない。他形式のイベントにはこれらのキー自体が存在しないため素通りする。
    'srcn', 'adsr1', 'adsr2', 'gain'
  ];
  function hysteresisCompatible(a, b) {
    for (const k of HYSTERESIS_HARD_KEYS) {
      if ((k in a || k in b) && a[k] !== b[k]) return false;
    }
    return true;
  }
  function concatField(list, key) {
    if (!list[0] || !list[0][key]) return undefined;
    return list.reduce((acc, e) => acc.concat(e[key] || []), []);
  }

  MML.Convert.mergeAlternatingVibrato = function (events, opts) {
    const result = [];
    let i = 0;
    const n = events.length;
    while (i < n) {
      const home = events[i];
      if (home.note == null || !home.pitchSeq) { result.push(home); i++; continue; }
      let altNote = null;
      const absorbed = [home];
      let j = i + 1;
      while (j < n) {
        const seg = events[j];
        if (seg.note == null || !seg.pitchSeq) break;
        const prevNote = absorbed[absorbed.length - 1].note;
        if (seg.note === prevNote) break; // 直接連続する同ノート=ハード境界、跨がない
        if (seg.note !== home.note) {
          if (altNote === null) {
            if (Math.abs(seg.note - home.note) !== 1) break; // 隣接半音以外は対象外
            altNote = seg.note;
          } else if (seg.note !== altNote) {
            break; // 3値目が出たら対象外(こぶし・グリッサンド等はここで自然に除外される)
          }
        }
        if (!hysteresisCompatible(seg, home)) break;
        absorbed.push(seg);
        j++;
      }
      // home単体では判定しない(最低1往復=home,alt,homeの3イベント必要)
      if (absorbed.length >= 3 && altNote !== null) {
        const last = absorbed[absorbed.length - 1];
        const candidateSeq = concatField(absorbed, 'pitchSeq');
        // ★Phase 3でclassifyPitchModが非周期(literal/ramp)も返すようになったため、
        // ここは明示的に'periodic'型だけを統合の根拠とする(元々の意図どおり「規則的
        // 周期で2音を高速往復=ビブラート」だけを統合対象とし、非周期の2値往復
        // (トレモロ的な打ち直し等、周期性の裏付けが無いもの)を誤って1音化しない)。
        const classified = MML.Convert.classifyPitchMod(candidateSeq);
        // ★形状判別+統合上限(2026-08-26、DESIGN-PITCH.md §5「トリル判別」の実装):
        //
        // (1) トリル判別(形状、全フォーマット共通): LFOテーブル駆動のビブラートは中間値を
        //     通る三角/正弦状、トリル奏法は2値切替の方形状。正規化振幅の中間帯(25%〜75%)に
        //     滞在するサンプル比率(middleFrac)で判別し、方形かつ変調幅が奏法として意味を持つ
        //     深さ(TRILL_MIN_CENTS以上)なら統合せず音符の交互のまま残す。浅い2値切替
        //     (レジスタ分解能の都合で中間値を持てない境界ビブラート、数〜数十セント)は
        //     従来どおり統合する。実例: Final Fantasy(NSF)の96〜105セント方形=トリル、
        //     NX91002 idx34(HES)の149セント階段=三角ビブラート。
        //
        // (2) opts.maxAbsorbCents(フォーマット別の表現力上限): 統合された変調は後段の
        //     MP/EPテーブル(fitVibrato→ループEP→literal EPの3段構え)で再現される前提だが、
        //     テーブル値は符号付きbyte(EP_VALUE_MIN/MAX)・MP depthも1byteのため、表現可能な
        //     変調幅は借用先チップの周期単位に依存する。HES→N163借用は単位が大きく
        //     (半音≈1100周期単位)深い変調はレンジ外で割当が失敗し変調が丸ごと消えるため、
        //     フォーマット側が上限を渡して超えるものは音符の交互のまま残す(次善の近似)。
        //     省略時は無制限。
        let spanCents = 0, middleFrac = 0;
        {
          let mn = Infinity, mx = 0;
          for (const v of candidateSeq) if (v > 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
          if (mn < Infinity && mx > mn) {
            spanCents = 1200 * Math.log2(mx / mn);
            const lo = mn + (mx - mn) * 0.25, hi = mn + (mx - mn) * 0.75;
            let mid = 0, n = 0;
            for (const v of candidateSeq) if (v > 0) { n++; if (v > lo && v < hi) mid++; }
            middleFrac = n > 0 ? mid / n : 0;
          }
        }
        const isTrill = spanCents >= TRILL_MIN_CENTS && middleFrac < TRILL_MIDDLE_FRAC_MAX;
        const spanOk = !(opts && opts.maxAbsorbCents != null && spanCents >= opts.maxAbsorbCents);
        if (classified && classified.type === 'periodic' && !isTrill && spanOk) {
          result.push(Object.assign({}, home, {
            end: last.end,
            volSeq: concatField(absorbed, 'volSeq'),
            // mergeRapidArpeggio側と同じ理由でフレーム毎の並びのまま繋ぐ
            hwEnvSeq: concatField(absorbed, 'hwEnvSeq'),
            pitchSeq: candidateSeq
          }));
          i = j;
          continue;
        }
      }
      result.push(home);
      i++;
    }
    return result;
  };

  // ── スラー分割(DESIGN-PITCH.md §3「レガートA→G」「こぶし」、2026-08-12) ──────
  // 現状の抽出ループは「半音丸め値が変わったら即新イベント」という境界規則自体は
  // Phase 2でも変えていない(mergeAlternatingVibratoは周期的な2値往復だけを後から
  // 再統合するだけ)ため、非周期の音程クロス(1回きりのレガート/こぶし)は既に
  // 別々のイベントとして抽出済みである。このスラー分割は「新しいプラトー検出/分割
  // アルゴリズム」ではなく、隣接イベントの境界が(a)実アタック/デューティ/エンベロープ
  // 種別変化を伴わない**純粋な音程変化のみ**で、(b)両側とも十分な長さ(プラトー)を
  // 持ち、(c)どちらの側も自前の変調(EP/PT)が既に割り当てられていない、という
  // 3条件を満たす場合に限り、独立した再アタック音符ではなくタイ(&)で繋いだ
  // レガートとして出力する後処理パス。
  //
  // 呼び出し順序: 抽出(ev.tieCandidateを立てる。純粋な音程変化での分割だったかを
  // extractor自身が記録する。他の要因では立てない)→音量/ピッチ割当て(pitchEp/
  // portamentoの確定)→本関数、の順を必ず守ること(本関数はpitchEp/portamentoが
  // 未割当のイベントしかタイの対象にしない。理由: compiler.jsのタイ処理は「新しい
  // セグメントを作らず前のセグメントを延長する」設計のため、タイで繋いだ2音目以降が
  // 独自のD/EP/MP/PTを持つことはできない(仮に出力しても再生時に無視される)。
  // よって、タイに使うと自前の変調を握りつぶすことになる候補は安全側にスキップする)。
  //
  // 「不明瞭」な場合(短すぎる/自前の変調がある)は何もしない = 従来通りの独立した
  // 再アタック音符のまま(markSlurTiesが安全に判定できるペアだけを個別にタイで繋ぐ)。
  // P-5「プラトー明瞭→スラー分割、不明瞭→EPテーブル」の不明瞭側(非周期の複数プラトーを
  // 1音+EPへ統合する側)は`mergeUnclearPitchRuns`(下記)が別途担当する。
  const MIN_SLUR_PLATEAU_FRAMES = 4; // Phase 3のMIN_LITERAL_FRAMESと同じ考え方(打鍵ジッタ除外)

  function qualifiesForSlur(ev) {
    // ev.noteEnv(2026-08-14拡張): タイで繋いだ2音目以降が独自のD/EP/MP/PTを持てないのと
    // 同じ理由でEN<n>も持てない(RD_NOTEでのtick0/累積値0への再初期化が起きないため、
    // タイ側にEN<n>を出力しても再生時に無視される)。ここで除外しないと、
    // mergeRapidArpeggioが統合したEN持ちイベントがタイ候補と誤認されて
    // mmlEmit側のEN再送出(前回状態との差分判定)がスキップされ、テーブル定義だけが
    // 出力されて実際にどの音符もEN<n>を参照しないという「検出したのに黙って
    // 捨てられる」退行になる(実測: SPC変換で発覚)。
    return !!ev && ev.note != null && (ev.end - ev.start) >= MIN_SLUR_PLATEAU_FRAMES &&
      ev.pitchEp == null && ev.portamento == null && ev.noteEnv == null && ev.vibrato == null;
  }

  MML.Convert.markSlurTies = function (events) {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1], ev = events[i];
      // hysteresisCompatible(HYSTERESIS_HARD_KEYS、mergeAlternatingVibratoと共有)も
      // ここで再利用する: SPCのsrcn/adsr1/adsr2/gain(楽器/エンベロープ)等、tieCandidate
      // 計算だけでは拾いきれないチップ固有の「音色が変わったら別音符」制約を、
      // extractorごとに個別実装させず一箇所に集約するため
      if (ev.tieCandidate && prev.end === ev.start &&
          qualifiesForSlur(prev) && qualifiesForSlur(ev) && hysteresisCompatible(prev, ev)) {
        ev.slurTie = true;
      }
    }
    return events;
  };

  // ── P-5「不明瞭→EPテーブル」側(スラー分割の相方、2026-08-12) ──────────────
  // tieCandidateで繋がった隣接イベントの連なり(§3の「レガート/こぶし」候補)のうち、
  // 全メンバーが個々に十分な長さ(プラトー、MIN_SLUR_PLATEAU_FRAMES以上)を持つとは
  // 限らない場合(=markSlurTiesが安全側にスキップしうる「不明瞭」な連なり)、run全体を
  // 1つのイベントへ統合し、そのpitchSeqをclassifyPitchModで再分類できるか試す。
  // 再分類できれば(周期/非ループどちらでも良い)「1音+EPテーブル」表現(§3の
  // `EP4 a2`)に置き換わる。できなければ何もしない(=従来通り個々のイベントのまま。
  // markSlurTiesが安全に判定できるペアだけ個別にタイで繋ぐ、既存動作への後退)。
  // ★実際のEP登録(pitchReg.assign)はここでは行わない。統合後のpitchSeqを持つ1つの
  // イベントとして返すだけで、呼び出し元の通常のtoPitchFields相当が普段通り処理する
  // (mergeAlternatingVibratoと全く同じ「試し分類→統合、実登録は後段に委ねる」設計)。
  //
  // 呼び出し順序: 抽出(tieCandidate計算済み)→mergeAlternatingVibrato→本関数→
  // (pitchEp/portamento割当て)→markSlurTies、を必ず守ること(本関数は割当て前の
  // 生のpitchSeqを直接連結して再分類するため、割当て後には呼べない。呼び出し箇所は
  // mergeAlternatingVibratoと全く同じ12箇所、その直後に連結して呼ぶだけでよい)。
  // ★2026-08-14: 本関数は当面パススルー(無効化)する。実測(Last Bible DMG-M7J.gbs、
  // GBS波形ch→FDS借用)で2件の実害が確認された:
  //  ①上限の無いrun収集: tieCandidateの連鎖が続く限り無制限に伸び続け、短い装飾音
  //    (<4フレーム)混じりの本物のメロディ(約4秒=239フレーム)をまるごと1つのrunに
  //    飲み込んだ。EP<n>の生レジスタ差分が符号付きbyte範囲(EP_VALUE_MIN/MAX=-127〜126)を
  //    超えてpitchReg.assign()がnullを返し、mergeがそのまま握りつぶされてピッチ情報が
  //    完全に消失(pitchEp/pitchBreaksどちらにも登録されない)、音符が先頭ノートに
  //    凍りついたまま伸び続ける「音程が全く動かなくなる」不具合になっていた。
  //  ②run長に8*MIN_SLUR_PLATEAU_FRAMES(32フレーム)の上限を設けて①を塞いだ後も、
  //    E4→G4→B4→F#4のような明瞭な複数の実在ノート(E短調アルペジオ、各ノートは正確に
  //    半音上に乗っている)がclassifyPitchMod()に「ランプ/周期」として誤って連続ピッチ
  //    カーブに近似され、本来の離散音程と異なる音(実測: g/bが欠落しfが混入する等)に
  //    化ける「音を外す」不具合が発生した。classifyPitchMod()は本来「同じ音の中での
  //    こぶし/アタックベンド」のような連続的なピッチ揺れを想定した分類器であり、
  //    「複数の異なる実音符が短時間に並ぶ」ケース(本関数がmarkSlurTiesの補完として
  //    対象にしたかったはずの範囲)の判別に十分な精度が無いことが分かった。
  // 通常のタイ機構(markSlurTies→pushNoteのpitchBreaks)は十分な長さ(MIN_SLUR_PLATEAU_
  // FRAMES以上)を持つ音符同士なら正確にレガート表現できることを実測確認済みなので、
  // 「不明瞭(短すぎる)音符が混じる連なりは無理に1つへ統合せず、個々のイベントのまま
  // 独立した音符として出力する」という安全側(近似ゼロ、劣化なし)に倒す。
  MML.Convert.mergeUnclearPitchRuns = function (events) { return events; };

})(globalThis);

/*
 * AY-3-8910(PSG) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.ay(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0xA0=レジスタ選択, 0xA1=データ書込。reg0/1,2/3,4/5=ch0-2の12bit周期(lo/hi)、
 * reg8/9/10=ch0-2の音量(下位4bit、bit4=エンベロープ使用)。専用アタックレジスタが
 * 無いため音量0→非0の遷移をノートオンとして扱う(nsf2mml/expansion/fme7.jsと同型)。
 * reg6=ノイズ周期(5bit,全ch共有)、reg7=ミキサー(bit0-2=トーン有効/bit3-5=ノイズ有効、
 * どちらも0で有効のactive-low)。ミキサーはppmckの`@<n>`(0=ミュート/1=トーン/2=ノイズ/
 * 3=トーン+ノイズ)へ対応させ、`@2`ではノート番号自体がノイズ周期(0-31)になる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }
  function toneFreq(period, clock) { return period >= 1 ? clock / (32 * period) : 0; }

  // ノイズLFSRのシフトレート。トーンと同じ分周(ay8910Msx.js clock()内で1/16、2フリップで
  // 1シフト)なので式もトーンと同一。周期0は実機同様1として扱う。
  function noiseFreq(np, clock) { return clock / (32 * Math.max(1, np)); }

  // 2A03ノイズの実測16周期(NTSC。apu2a03.js / gbs2mml/expansion/noise.js と同じテーブル)。
  // ピアノロールのノイズ行は全チップこの16段階へ揃えてC1(24)〜D#2(39)に並べる約束なので
  // (keyboard.js noisePeriodIndexToMidi)、AYのノイズ周波数も対数距離で最寄りに写像する。
  // ★AYのノイズ周期(0-31)をそのままノート番号にすると midi = 周期+12 となり、
  //   周期が小さい曲では MIDI_MIN(24) を下回ってロールに描画されない。
  const NES_CPU_CLOCK = 1789772.5;
  const NES_NOISE_FREQS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068]
    .map(p => NES_CPU_CLOCK / p);
  function noiseFreqToRollIndex(freqHz) {
    if (!freqHz) return 0;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const d = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  }

  function buildTimeline(writeLog, clock) {
    let addrReg = 0;
    const regs = new Uint8Array(16);
    // ミキサー(reg7)を一度も書かない曲があるため、エミュレータ(ay8910Msx.js)と同じ
    // 既定値から始める。0のまま始めると全chがトーン+ノイズ有効として抽出されてしまう
    regs[7] = 0x38;
    // 書込み時刻付きトレース(位相エイリアシング対策、extractToneEvents 参照)。ch別の音量 [{t,v}] と
    // 周期 [{t,v}]。t は分数フレーム(kssPackWrite の frac、旧ログは全て .0 で hasFrac=false)
    const traces = { vol: [[], [], []], pitch: [[], [], []], hasFrac: false };
    const timeline = writeLog.map((writes, f) => {
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24 / frac=bit25-30
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (!io) continue;
        if (addr === 0xA0) addrReg = value & 0x0F;
        else if (addr === 0xA1) {
          regs[addrReg] = value;
          const frac = ((pw >>> 25) & 0x3F) / 64;
          if (frac > 0) traces.hasFrac = true;
          const t = f + frac;
          if (addrReg >= 8 && addrReg <= 10) traces.vol[addrReg - 8].push({ t, v: (value & 0x10) ? 15 : (value & 0x0F) });
          else if (addrReg <= 5) { const ch = addrReg >> 1; traces.pitch[ch].push({ t, v: regs[ch * 2] | ((regs[ch * 2 + 1] & 0x0F) << 8) }); }
        }
      }
      const periods = [
        regs[0] | ((regs[1] & 0x0F) << 8),
        regs[2] | ((regs[3] & 0x0F) << 8),
        regs[4] | ((regs[5] & 0x0F) << 8),
      ];
      const volumes = [0, 1, 2].map(ch => {
        const v = regs[8 + ch];
        return (v & 0x10) ? 15 : (v & 0x0F); // エンベロープ使用時は簡略化して最大音量扱い
      });
      // reg7(ミキサー)のbit0-2=トーン無効(1で無効/active-low)。ここが立っている間は
      // そのチャンネルのトーン周期レジスタが古い値を保持したままノイズ専用や無音に
      // 切り替わっていることがあり(打楽器的なノイズ音とメロディを同じチャンネルで
      // 高速に切り替えるMSXドライバでよくある手法、実ファイルで確認済み)、それを見ずに
      // 周期レジスタだけでノート判定すると、ノイズ区間なのに直前のトーン音程のまま
      // 音量だけ変化する偽ノート(ノイズの減衰エンベロープを別々の短いノートの連打と
      // 誤検出)になっていた。
      const modes = [0, 1, 2].map(ch =>
        (((regs[7] >> ch) & 1) ? 0 : 1) | (((regs[7] >> (3 + ch)) & 1) ? 0 : 2));
      return { periods, volumes, modes, noisePeriod: regs[6] & 0x1F };
    });
    timeline.traces = traces;
    return timeline;
  }
  // ソフトエンベロープ/ピッチ列の位相エイリアシング対策(hes2mml/expansion/wave.js buildVolTimeline
  // 冒頭コメント参照)。ドライバのタイマー周期がフレームと合わない曲(MSX の 60Hz/50Hz 混在、VGM の
  // VSYNC ドライバの揺らぎ)では、同じエンベロープでも段の位置が±1フレームずれた変種(11 11 11 10 10 …
  // と 11 11 10 10 10 …)が量産される。書込み時刻トレースがあれば、音符の開始書込みを原点にした
  // 相対時刻で音量列/周期列を読み直す。マージ処理より前に、イベント長を変えずに行う
  function resampleEvents(events, traces, ch) {
    const R = MML.Convert.TickResample;
    if (!R || !traces || !traces.hasFrac) return;
    const vt = traces.vol[ch], pt = traces.pitch[ch];
    const off = R.sampleOffsetFor([vt, pt]);
    for (const ev of events) {
      if (ev.note === null) continue;
      const a = R.noteAnchorT(ev.start, [vt, pt]);
      if (vt.length) ev.volSeq = R.resampleSeq(vt, ev.start, ev.end, ev.volSeq, a, off);
      if (pt.length) ev.pitchSeq = R.resampleSeq(pt, ev.start, ev.end, ev.pitchSeq, a, off);
    }
  }

  // ピッチ/トーン有効状態が同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/expansion/fme7.jsと同じ考え方)。
  // ただし音量がそれまでの減衰傾向から上向きに跳ね上がった(=エンベロープ再アタック)
  // 場合は、同じ音程・同じ音量のままの同音連打であっても必ず新イベントに区切る。
  // 【周期レジスタへの書込みそのものを合図にする案(periodTouched)は撤回】PSGにも
  // SCC同様キーオン信号が無いため当初は「周期レジスタへの書込み+音量上昇」の両方を
  // 要求していたが、F1 Spirit 64曲目のSCC(同じ手法を移植したscc.js)で「音程が同じ
  // ままの同音連打で周波数レジスタが書き直されない(値が変わらないので省略される)」
  // 曲があり、periodTouchedを必須にすると本来の再アタックを見逃すことが判明した。
  // 音量が上向きに跳ね上がること自体がソフトウェアエンベロープの再アタックを意味する
  // ため、これだけで十分な合図になる(Ys1 12曲目のperiodTouched=falseの偽陽性ケースは
  // 音量も変化しない継続ティックだったため、この条件だけで元々弾かれていた)。
  function extractToneEvents(timeline, chIndex, clock) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.periods[chIndex];
      const volume = t.volumes[chIndex];
      const mode = t.modes[chIndex];
      // ★2026-08-22: 「トーン有効だがトーン周期0」= トーン発生器は実質鳴っていないので、
      // ノイズが有効ならノイズ単独(@2)として扱う。実測でAleste Gaiden(MSX2)のch Aが
      // 全曲この状態(mode=3=トーン+ノイズ有効、period=0)で打楽器を鳴らしており、
      // 従来は mode===2 しかノイズ扱いしなかったため下の枝に落ちて period>=1 を満たさず
      // note=null(=休符)になり、ロールにもMMLにも一切出てこなかった。
      const toneUsable = (mode & 1) !== 0 && period >= 1;
      const effMode = toneUsable ? mode : ((mode & 2) ? 2 : 0);
      // @2(ノイズ単独)はノート番号=ノイズ周期。それ以外はトーン周期から音程を求める
      let note = null;
      let freqHz = null; // トーン発音時の実周波数(デチューン検出用、ノイズ単独時はnull)
      if (volume > 0 && effMode !== 0) {
        if (effMode === 2) note = t.noisePeriod;
        else if (toneUsable) { freqHz = toneFreq(period, clock); note = freqToNoteNumber(freqHz); }
      }
      const mode_ = effMode; // 以降(イベント分割・@<n>出力)は実効モードで判断する
      const noise = mode_ === 3 ? t.noisePeriod : null; // @3のみN<n>を出す
      if (!cur) { cur = { note, mode: mode_, noise, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note || mode_ !== cur.mode || noise !== cur.noise) {
        // 音量ジャンプ(再アタック推定)が無く、純粋に音程だけが変わった場合はスラー分割の
        // タイ候補とする(src/convert/pitch.js markSlurTies参照。AYには専用アタック
        // レジスタが無いためretrigger推定(音量上昇)を「実アタックの代用」として使う)
        const pureNoteChange = !retrigger && note !== cur.note && mode_ === cur.mode && noise === cur.noise;
        flush(f);
        cur = { note, mode: mode_, noise, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(timeline.length);
    resampleEvents(events, timeline.traces, chIndex);
    return events;
  }

  MML.Kss2MmlExpansion.ay = function (writeLog, totalFrames, clock, envReg) {
    const timeline = buildTimeline(writeLog, clock);
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
    }
    // pitchEp(EP<n>参照)は借用先(FME7)の生レジスタ空間への変換が必要なため、ここでは
    // 付けずev.freqSeq(Hz)だけ残し、呼び出し元のkss2mml/converter.jsが
    // MML.Convert.rescalePitchSeqFromFreqで変換してから登録する(DESIGN-PITCH.md Phase 1、
    // src/convert/pitch.js冒頭コメント参照)。
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.mode } : {},
      ev.note !== null && ev.noise !== null ? { fme7Noise: ev.noise } : {},
      // ピアノロール専用の疑似音程(0-15、C1〜D#2)。MML側のノート番号(=ノイズ周期、
      // ppmckのFME-7 @2仕様)はそのまま note に残し、表示だけこちらを使う
      // (src/audio/roll-builders.js の toNotes 参照)。MML変換はこのフィールドを見ない。
      ev.note !== null && ev.mode === 2
        ? { noiseRollIndex: noiseFreqToRollIndex(noiseFreq(ev.note, clock)) } : {},
      ev.note !== null && ev.freqHz != null
        ? { rawFreq: ev.freqHz, freqSeq: ev.pitchSeq.map(p => toneFreq(p, clock)) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    return {
      channels: [0, 1, 2].map(ch => ({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2): 半音境界を跨ぐビブラートが
        // 音符連打に化ける問題を、抽出後の後処理パスとして統合する(既存の毎フレーム
        // ループ自体は変えない)+高速アルペジオ→EN統合(2026-08-14)+P-5「不明瞭→EPテーブル」側(2026-08-12)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractToneEvents(timeline, ch, clock))).map(toCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true
      }))
    };
  };
})(globalThis);

/*
 * Konami SCC/SCC+ → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock, waveReg) → { channels: [...], n163Wave }
 *
 * レジスタ窓の位置(0x9800台 / 0xB800台)も配置もclassic(SCC)とSCC+(SCC-I)で異なるため、
 * kssBus.js の _sccWrite と同じ状態機械をwriteLogから再現してモードを追跡する
 * (配置の詳細は src/emulator/expansion/sccAudio.js のコメント参照)。
 *
 * このアプリのMMLプレイヤーはSCCへ直接対応しないため、波形はN163形式(符号無し4bit,16点)へ
 * リサンプリングしてwaveReg(WaveRegistry、曲全体で重複排除)に登録し、@<n>(instrument)で
 * チャンネルごと・曲中の切替も含めて選択する(nsf2mml/expansion/n163.jsと同じ考え方)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  // ★2026-08-02: 16(N163_WAVE_LEN既定)から32(SCCの実波形長そのもの)へ変更。N163Alloc
  // (src/mml/n163Alloc.js)は@N<n>定義の実際の配列長をそのまま読むので16固定である必要はなく、
  // 16へ間引くと波形が持つ倍音情報が失われる(音色の解像度劣化)。32にすると
  // resampleWave()のリサンプリングが恒等写像になり、ビット深度変換(8bit符号付き→4bit
  // 符号無し)だけの劣化で済む。ただしN163内蔵RAMの波形領域は128ニブル固定
  // (N163Alloc.MAX_BYTES=64byte、numCh混在時でも定数)なので、同時に4つを超える異なる
  // 32要素波形が使われる曲ではRAM不足のconflictが出る可能性がある(要検証)。
  MML.Kss2MmlExpansion.SCC_WAVE_LEN = 32;
  const OUT_WAVE_LEN = MML.Kss2MmlExpansion.SCC_WAVE_LEN;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }

  // classic(SCC)とSCC+(SCC-I)でレジスタ窓の位置も配置も異なるため、kssBus.js の
  // _sccWrite と同じ状態機械をwriteLogから再現してモードを追跡する。
  // ・0xBFFE/0xBFFF書込みのbit5でレジスタ窓を 0x9000 系 / 0xB000 系へ切替
  // ・窓先頭(0x9000 or 0xB000)への書込みが 0x3F ならclassic有効、bit7立ちならSCC+有効
  // これを見ずに0xB800台をclassic配置で解釈すると、SCC+タイトル(スナッチャー系)の
  // 周波数/音量を波形と取り違えて音符が一切抽出できない。
  function makeSccDecoder() {
    return { base: 0x9000, plus: false };
  }
  // 音源レジスタ窓内のオフセット(0x00-0xFF)を返す。窓外・モードレジスタ等は-1。
  function decodeAddr(state, addr, value) {
    if ((addr & 0xFFFE) === 0xBFFE) { state.base = 0x9000 | ((value & 0x20) << 8); return -1; }
    if (addr < state.base) return -1;
    const off = addr - state.base;
    if (off === 0) {
      if (value === 0x3F) state.plus = false;
      else if (value & 0x80) state.plus = true;
      return -1;
    }
    if (off < 0x800 || off > 0x8FF) return -1;
    return off - 0x800;
  }

  // SCCの符号付き8bit波形(32点)を N163形式(4bit符号無し, 16点)へ変換する。
  // N163エンコーダ経由でしか再生できないため(compiler.jsにSCCネイティブ経路が無い)、
  // 波形が完全一致するわけではないが近似として抽出する。
  function resampleWave(wave) {
    const out = new Array(OUT_WAVE_LEN);
    for (let i = 0; i < OUT_WAVE_LEN; i++) {
      const srcPos = Math.floor((i / OUT_WAVE_LEN) * 32) % 32;
      out[i] = Math.max(0, Math.min(15, (wave[srcPos] + 128) >> 4));
    }
    return out;
  }

  // 実チップが1フレーム(1/60秒)の間に取り得る書込み数の現実的な上限。5ch分の波形を
  // まるごと差し替えても 5*32=160byte 程度にしかならない。KSSはbankNum>0(Konami系
  // バンク切替マッパー)の曲であれば0x9800-9FFF/0xB800-BFFF窓を常時SCCとしてデコードする
  // (kssBus.js参照、Space Manbow等0x3Fトリックを使わないタイトル救済のため)が、この窓は
  // 実チップ非搭載時にはROM/ワークRAMとして通常のデータ用途にも使われうる。ある曲でその
  // 領域へ数百〜数千byte規模の一括書込み(LDIR等によるデータロード)が起きると、SCCレジスタ
  // 書込みと誤認識してデタラメな音程/音量の音符が延々鳴り続ける不具合になる
  // (Ys1 12曲目で実測: 1フレームで4096byte書込み)。閾値を超えるフレームはチップ操作とは
  // みなさず読み捨てる。
  const BULK_COPY_THRESHOLD_PER_FRAME = 256;

  function buildTimeline(writeLog) {
    const freq = new Uint16Array(5);
    const volume = new Uint8Array(5);
    let enable = 0x1F;
    const wave = [];
    for (let i = 0; i < 5; i++) wave.push(new Int8Array(32));
    const state = makeSccDecoder();
    // 書込み時刻付きトレース(位相エイリアシング対策。ay.js resampleEvents と同じ)
    const traces = { vol: [[], [], [], [], []], pitch: [[], [], [], [], []], hasFrac: false };
    const timeline = writeLog.map((writes, f) => {
      let rangeWriteCount = 0;
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite)
      for (const pw of writes) {
        const addr = pw & 0xFFFF, io = (pw >> 24) & 1;
        if (io) continue;
        if ((addr >= 0x9800 && addr <= 0x9FFF) || (addr >= 0xB800 && addr <= 0xBFFF)) rangeWriteCount++;
      }
      const isBulkCopy = rangeWriteCount > BULK_COPY_THRESHOLD_PER_FRAME;
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (io) continue;
        if (isBulkCopy && ((addr >= 0x9800 && addr <= 0x9FFF) || (addr >= 0xB800 && addr <= 0xBFFF))) continue;
        const off = decodeAddr(state, addr, value);
        if (off < 0) continue;
        const frac = ((pw >>> 25) & 0x3F) / 64;
        if (frac > 0) traces.hasFrac = true;
        const tWrite = f + frac;
        if (state.plus) {
          // SCC+: 0x00-0x9F=波形ch0-4 / 0xA0-0xA9=周波数 / 0xAA-0xAE=音量 / 0xAF=有効ビット
          if (off < 0xA0) { wave[off >> 5][off & 0x1F] = value; continue; }
          if (off <= 0xA9) {
            const ch = (off - 0xA0) >> 1;
            if (off & 1) freq[ch] = (freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
            else freq[ch] = (freq[ch] & 0x0F00) | value;
            traces.pitch[ch].push({ t: tWrite, v: freq[ch] });
          } else if (off <= 0xAE) {
            volume[off - 0xAA] = value & 0x0F;
            traces.vol[off - 0xAA].push({ t: tWrite, v: value & 0x0F });
          } else if (off === 0xAF) {
            enable = value & 0x1F;
          }
          continue;
        }
        // classic: 0x00-0x7F=波形ch0-3(ch3はch4と共有) / 0x80-0x89=周波数 / 0x8A-0x8E=音量 / 0x8F=有効ビット
        if (off < 0x80) {
          const ch = off >> 5;
          wave[ch][off & 0x1F] = value;
          if (ch === 3) wave[4][off & 0x1F] = value;
          continue;
        }
        if (off > 0x8F) continue;
        if (off <= 0x89) {
          const ch = (off - 0x80) >> 1;
          if (off & 1) freq[ch] = (freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
          else freq[ch] = (freq[ch] & 0x0F00) | value;
          traces.pitch[ch].push({ t: tWrite, v: freq[ch] });
        } else if (off <= 0x8E) {
          volume[off - 0x8A] = value & 0x0F;
          traces.vol[off - 0x8A].push({ t: tWrite, v: value & 0x0F });
        } else if (off === 0x8F) {
          enable = value & 0x1F;
        }
      }
      // wave はチャンネルごとに独立コピーして返す(以降の書込みで上書きされないよう)
      return { freq: Array.from(freq), volume: Array.from(volume), enable, wave: wave.map(w => w.slice()) };
    });
    timeline.traces = traces;
    return timeline;
  }
  // ay.js resampleEvents と同じ(位相エイリアシング対策)
  function resampleEvents(events, traces, ch) {
    const R = MML.Convert.TickResample;
    if (!R || !traces || !traces.hasFrac) return;
    const vt = traces.vol[ch], pt = traces.pitch[ch];
    const off = R.sampleOffsetFor([vt, pt]);
    for (const ev of events) {
      if (ev.note === null) continue;
      const a = R.noteAnchorT(ev.start, [vt, pt]);
      if (vt.length) ev.volSeq = R.resampleSeq(vt, ev.start, ev.end, ev.volSeq, a, off);
      if (pt.length) ev.pitchSeq = R.resampleSeq(pt, ev.start, ev.end, ev.pitchSeq, a, off);
    }
  }

  // ピッチが同じ間は音色(波形)切替だけでは区切らないが、音量がそれまでの減衰傾向から
  // 上向きに跳ね上がった(=ソフトウェアエンベロープの再アタック)場合は同音連打として
  // 必ず新イベントに区切る(kss2mml/expansion/ay.jsと同じ考え方)。
  // 【周波数レジスタへの書込みを合図に加える案(freqTouched)は撤回】F1 Spirit 64曲目の
  // Tチャンネルで「音程が同じままの同音連打で周波数レジスタが書き直されない(値が
  // 変わらないので省略される)」曲があり、freqTouchedを必須にすると本来の再アタック
  // (音量が2から5へ跳ね上がる箇所)を見逃すことが判明した。音量が上向きに跳ね上がる
  // こと自体が再アタックの十分な合図になる。
  // それ以外の音量変化は同じ音符内のvolSeqへ積み、toCommon側でenvReg(渡されていれば)
  // により@v<n>ソフトウェアエンベロープへ畳み込む。
  // waveRegへの登録は実際に鳴っている(note!==null)イベントに絞ってtoCommon側で行う
  // (ここで毎フレーム登録すると、波形テーブル書換え中の過渡状態や無音区間の値まで
  //  無関係な音色として大量に登録されてしまうため)。
  function extractChannelEvents(timeline, ch, clock) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.freq[ch];
      const volume = t.volume[ch];
      const enabled = !!((t.enable >> ch) & 1);
      const freqHz = period > 8 ? clock / (32 * (period + 1)) : 0;
      const note = (enabled && volume > 0 && freqHz > 0) ? freqToNoteNumber(freqHz) : null;
      const wave = resampleWave(t.wave[ch]);
      const waveKey = wave.join(',');
      // srcWave: 生の32バイト波形(音色の同定 src/convert/toneKey.js 用。鍵盤のライブ表示と同じ生値で
      // キーを作るため、4bitへ丸めた wave ではなくこちらを載せる)
      const srcWave = t.wave[ch];
      if (!cur) { cur = { note, wave, srcWave, waveKey, freqHz: note !== null ? freqHz : null, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // 音量ジャンプ(再アタック推定)・波形切替が無く、純粋に音程だけが変わった場合は
        // スラー分割のタイ候補とする(ay.jsと同じ考え方)
        const pureNoteChange = !retrigger && note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave, srcWave, waveKey, freqHz: note !== null ? freqHz : null, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(timeline.length);
    resampleEvents(events, timeline.traces, ch);
    return events;
  }

  // waveReg/envRegは省略可(MML変換時のみ渡される)。ピアノロール用タイムライン構築
  // (src/main.js buildKssRollTimeline)は音色番号/エンベロープを必要としないため渡してこない。
  // ここを無条件に waveReg.assign(...) していたため、SCCが実際に発音した瞬間だけ
  // TypeErrorで落ち、その例外がcaptureKssSongAsyncのonProgress経由でPromiseを
  // rejectさせ、ピアノロールの先読みが丸ごと死ぬ(=ロールが出ない/途中で止まる)
  // 不具合になっていた。ay.jsのenvRegと同じくnull許容にする。
  MML.Kss2MmlExpansion.scc = function (writeLog, totalFrames, clock, waveReg, envReg) {
    const timeline = buildTimeline(writeLog);
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
    }
    // pitchEpは呼び出し元(kss2mml/converter.js)がev.freqSeqから借用先(N163)の
    // 生レジスタ空間へ変換して付与する(ay.jsと同じ理由、DESIGN-PITCH.md Phase 1)。
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(ev.wave) } : {},
      (ev.note !== null && ev.srcWave) ? { srcWave: ev.srcWave } : {}, // 音色の同定(toneKey.js)
      ev.note !== null && ev.freqHz != null
        ? { rawFreq: ev.freqHz, freqSeq: ev.pitchSeq.map(p => p > 8 ? clock / (32 * (p + 1)) : 0) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    const finalFrame = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    return {
      channels: [0, 1, 2, 3, 4].map(ch => ({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
        // P-5「不明瞭→EPテーブル」側(2026-08-12)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, clock))).map(toCommon),
        hasVolume: true,
        hasEnvelope: true,
        hasInstrument: true
      })),
      n163Wave: finalFrame ? resampleWave(finalFrame.wave[0]) : new Array(OUT_WAVE_LEN).fill(0)
    };
  };
})(globalThis);

/*
 * FMPAC(OPLL/YM2413) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.opll(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0x7C=アドレスラッチ, 0x7D=データ書込。
 *   0x10+ch=fnum下位, 0x20+ch=bit0=fnum上位,bits1-3=block,bit4=キーオン,
 *   0x30+ch=bits4-7=音色番号,bits0-3=音量。
 * アタック合図: 0x20+ch書き込みのbit4(キーオン)。ネイティブ出力レート49716Hz
 * (src/emulator/expansion/opllMsx.js/vrc7.jsと同じ、VRC7=OPLLなので式も同一)。
 *
 * ★2026-08-22: メロディ9ch対応。それまで6chしか見ておらず($20-$25のみ)、YM2413本来の
 * 7-9ch目($26-$28)の音がピアノロールにもMML変換にも出てこなかった。VRC7(6ch固定)用に
 * 書いたものをFM-PACに流用したことによる取りこぼし。
 * リズムモード(レジスタ$0E bit5)中はch7-9がBD/HH+SD/TOM+CYMに化けてメロディではなく
 * なるため、曲中で一度でもリズムモードが使われたら6chとして返す(鍵盤表示側が
 * 6メロディ+5リズムの行構成になるのと一致させる。src/ui/keyboard.js の kssOpll 分岐参照)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }
  function opllFreq(fnum, block) { return (fnum * 49716 * Math.pow(2, block)) / 524288; }

  // YM2413のメロディch数。リズムモード中はch7-9が打楽器に化けるので6として扱う。
  const NUM_MELODY_MAX = 9;
  const NUM_MELODY_RHYTHM = 6;

  function buildTimeline(writeLog) {
    let latch = 0;
    const regs = new Uint8Array(0x40);
    // キーオンの立ち上がり(0→1)だけを打ち直しとみなす。$2xはビブラート/音程更新の
    // ために毎フレーム書き直すドライバが多く、「キーオンビットが立った書込み」を
    // 全部アタック扱いにすると、1つのロングトーンが毎フレーム打ち直しに見えて
    // イベントが1フレーム単位に分解されてしまう(ピアノロールが短冊だらけになる)。
    // 実機YM2413もキーオン中に再度キーオンを書いてもエンベロープは再スタートしない。
    const keyon = new Array(NUM_MELODY_MAX).fill(false);
    let rhythmUsed = false;
    const frames = writeLog.map(writes => {
      const attack = new Array(NUM_MELODY_MAX).fill(false);
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (!io) continue;
        // 0xF0/0xF1 は FM-PAC の別名ポート(src/emulator/kssBus.js ioWrite 参照)
        if (addr === 0x7C || addr === 0xF0) { latch = value & 0x3F; continue; }
        if (addr !== 0x7D && addr !== 0xF1) continue;
        regs[latch] = value;
        if (latch === 0x0E && (value & 0x20)) rhythmUsed = true; // リズムモード有効化
        if (latch >= 0x20 && latch <= 0x20 + NUM_MELODY_MAX - 1) {
          const ch = latch - 0x20;
          const on = !!(value & 0x10);
          if (on && !keyon[ch]) attack[ch] = true; // フレームを跨ぐ/跨がない両方の立ち上がりを拾う
          keyon[ch] = on;
        }
      }
      return { regs: regs.slice(), attack };
    });
    return { frames, rhythmUsed };
  }

  // instrument===0(ユーザー定義音色)のときだけ、その時点の0x00-0x07(全ch共有の
  // カスタム音色スロット)8バイトをtoneRegに登録してインデックスを付与する
  // (nsf2mml/expansion/vrc7.jsと同じ考え方。VRC7=OPLLなのでレジスタ配置も同一)。
  // toneRegが無い(呼び出し元が対応していない)場合はvrc7Toneを付けず従来通り。
  function extractChannelEvents(timeline, ch, toneReg) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, attack } = timeline[f];
      const fnumLo = regs[0x10 + ch];
      const reg20 = regs[0x20 + ch];
      const block = (reg20 >> 1) & 0x07;
      const keyon = !!(reg20 & 0x10);
      const fnum = fnumLo | ((reg20 & 0x01) << 8);
      const reg30 = regs[0x30 + ch];
      const instrument = (reg30 >> 4) & 0x0F;
      const volume = reg30 & 0x0F;
      const freqHz = (keyon && fnum > 0) ? opllFreq(fnum, block) : null;
      const note = freqHz != null ? freqToNoteNumber(freqHz) : null;
      const vrc7Tone = (toneReg && note !== null && instrument === 0)
        ? toneReg.assign(Array.from(regs.slice(0, 8))) : undefined;
      // srcTone: 自作音色の実体(音色の同定 src/convert/toneKey.js 用。toneReg 無しのロール構築でも載せる)
      const srcTone = (note !== null && instrument === 0) ? Array.from(regs.slice(0, 8)) : undefined;
      if (!cur) { cur = { note, volume, instrument, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: false }; continue; }
      if (attack[ch] || note !== cur.note || volume !== cur.volume || instrument !== cur.instrument ||
          vrc7Tone !== cur.vrc7Tone) {
        flush(f);
        // retrigger: このイベントが「キーオン(アタック)による打ち直し」で始まったか。
        // 音量エンベロープによる細切れ(1フレームごとの音量書換え)と区別するための印で、
        // ピアノロール側(src/main.js buildKssRollTimeline)が同音程の連結可否に使う。
        cur = { note, volume, instrument, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: !!attack[ch] };
      }
    }
    flush(timeline.length);
    return events;
  }

  // ---- リズム音源(リズムモード時のch6-8が化ける5打楽器)の打点抽出 ----
  // レジスタ$0E: bit5=リズムモード有効、bit4=BD/bit3=SD/bit2=TOM/bit1=CYM/bit0=HH のキーオン
  // (ビット割当は src/emulator/expansion/opllNuked.js の RM_* と同じ)。
  // 音量は ch6-8 の $36-$38 を上下ニブルで分け合う:
  //   $36 下位=BD / $37 上位=HH・下位=SD / $38 上位=TOM・下位=CYM
  // ★音程の扱い(鍵盤表示と必ず揃えること):
  //   BD(ch6)とTOM(ch8)は実際にfnum/blockの音程を持つ打楽器なので**実音程**で置く。
  //     鍵盤側もこの2つだけ freq を出しているので、両者のノートが一致する。
  //   SD/CYM/HHは音程を持たない(ノイズ由来)ので、疑似音程 rollIndex で3レーンに分ける
  //     (roll-builders.js の toNotes が midi = 24 + noiseRollIndex で置く。AYノイズ行と同じ
  //      仕組み。鍵盤側も同じindexを noiseIndex として渡すので鍵盤のキーとも一致する)。
  //   fnumRegの組(下位/上位+block)から音程を求める。fnum=0や描画範囲(MIDI_MIN=24)より
  //   低くなる場合は疑似音程へフォールバックする。
  const RHYTHM_DEFS = [
    { key: 'bd',  bit: 4, volReg: 0x36, volShift: 0, rollIndex: 0, fnumLo: 0x16, fnumHi: 0x26 },
    { key: 'sd',  bit: 3, volReg: 0x37, volShift: 0, rollIndex: 2, fnumLo: null, fnumHi: null },
    { key: 'tom', bit: 2, volReg: 0x38, volShift: 4, rollIndex: 4, fnumLo: 0x18, fnumHi: 0x28 },
    { key: 'cym', bit: 1, volReg: 0x38, volShift: 0, rollIndex: 6, fnumLo: null, fnumHi: null },
    { key: 'hh',  bit: 0, volReg: 0x37, volShift: 4, rollIndex: 8, fnumLo: null, fnumHi: null }
  ];

  function extractRhythmEvents(timeline, def) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const regs = timeline[f].regs;
      const rm = (regs[0x0E] & 0x20) !== 0;
      const on = rm && ((regs[0x0E] >> def.bit) & 1) !== 0;
      if (!on) { flush(f); continue; }
      const volume = (regs[def.volReg] >> def.volShift) & 0x0F;
      // BD/TOMは実音程。範囲外(MIDI_MIN=24未満)や無音程時は疑似音程へ落とす
      let note = def.rollIndex, useRollIndex = true;
      if (def.fnumLo !== null) {
        const fnum = regs[def.fnumLo] | ((regs[def.fnumHi] & 0x01) << 8);
        const block = (regs[def.fnumHi] >> 1) & 0x07;
        const n = fnum > 0 ? freqToNoteNumber(opllFreq(fnum, block)) : null;
        if (n !== null && n + 12 >= 24) { note = n; useRollIndex = false; }
      }
      const mk = (retrigger) => useRollIndex
        ? { note, noiseRollIndex: def.rollIndex, volume, start: f, end: f, retrigger }
        : { note, volume, start: f, end: f, retrigger };
      if (!cur) { cur = mk(true); continue; }
      if (volume !== cur.volume || note !== cur.note) {
        flush(f);
        cur = mk(false);
      } else {
        cur.end = f;
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.opll = function (writeLog, totalFrames, toneReg) {
    const { frames: timeline, rhythmUsed } = buildTimeline(writeLog);
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument, retrigger: ev.retrigger },
      ev.note !== null && ev.freqHz != null ? { rawFreq: ev.freqHz } : {},
      ev.vrc7Tone !== undefined ? { vrc7Tone: ev.vrc7Tone } : {},
      ev.srcTone ? { srcTone: ev.srcTone } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}
    );
    // ★返すチャンネル本数は常に NUM_MELODY_MAX で固定する。
    // ピアノロールは再生しながら writeLog が伸びるたびに再構築される(進捗配信)ので、
    // 「リズムモードが使われたか」で本数を変えると、リズムが有効化される前の配信は9本・
    // 後の配信は6本…とトラック集合が途中で変わってしまい、鍵盤の行との1対1対応が崩れる。
    // 本数は固定したまま、リズムモード中に打楽器へ化けるch7-9のイベントだけを空にする。
    // リズム打楽器の打点。リズムモードを使う曲でだけ返す(呼び出し元=roll-builders.jsが
    // 5トラック作る。MML変換側は channels しか見ないのでここは無視される)。
    const rhythm = rhythmUsed
      ? RHYTHM_DEFS.reduce((acc, def) => { acc[def.key] = extractRhythmEvents(timeline, def); return acc; }, {})
      : null;

    return {
      rhythmUsed,
      rhythm,
      channels: Array.from({ length: NUM_MELODY_MAX }, (_, ch) => ({
        // 高速アルペジオ→EN統合(2026-08-14拡張)。VRC7(=OPLL)はfnum/block対数空間の
        // ためD/EP/MPは使えないが、ENはノート番号→fnum/blockを都度再計算するだけなので
        // 使える(src/mml/compiler.js segmentsToWriteLogVrc7参照)
        events: (rhythmUsed && ch >= NUM_MELODY_RHYTHM)
          ? []
          : MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, toneReg)).map(toCommon),
        hasVolume: true,
        hasInstrument: true,
        hasVrc7Tone: !!toneReg
      }))
    };
  };
})(globalThis);

/*
 * OPL系(Y8950=MSX-AUDIO / YM3812 / YM3526) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.opl(writeLog, totalFrames, clock, toneReg) → { channels: [9], rhythm, adpcm }
 *
 * ポート0xC0=アドレスラッチ, 0xC1=データ書込(MSX-AUDIOの実I/Oポート。VGMのYM3812/YM3526/
 * Y8950も captureVgmSongAsync が同じ形でwriteLogへ流すので、KSS/VGMで本抽出器を共有する)。
 *   0xA0+ch=fnum下位8bit, 0xB0+ch=bit5キーオン/bit4-2ブロック/bit1-0 fnum上位,
 *   0xC0+ch=FB/CNT, スロット別 0x20/0x40/0x60/0x80/0xE0(+オフセット表)。
 *   0xBD: bit5=リズムモード, bit4-0=BD,SD,TOM,CYM,HH キーオン。
 * 音程: freq = fnum × 2^(block-1) × fs / 2^19、fs = clock/72(3.58MHzで49716Hz)。
 * 音量: キャリアTL(6bit×0.75dB)→ OPLL流の減衰値 v = TL>>2(0-15、3dB/step。値が大きいほど
 * 小さい音=OPLL/VRC7と同じ向き。roll側は attenuated=true で反転表示する)。
 *
 * ★音色はOPLLカスタム音色(@OP 8バイト)へ直接変換して vrc7Tone で出す(2op同士なので
 *   4op→2op変換より遥かに忠実。opllNuked.jsのPATCH_*と同じバイト並び):
 *     b0/b1 = AM|VIB|EGT|KSR|MULT (mod/car)
 *     b2    = KSL(mod)<<6 | TL(mod)   ※CNT=1(加算接続)はOPLLに無いのでTL=63(キャリアのみ)
 *     b3    = KSL(car)<<6 | DC<<4 | DM<<3 | FB  ※DC/DM=半波フラグ。OPL2のWS1(半サイン)を
 *             そのまま写像、WS2/WS3も半波で近似(YM3526はWS無し=常に0)
 *     b4-b7 = AR|DR(mod,car), SL|RR(mod,car)
 *
 * リズムモード: OPLLと同じ流儀(kss2mml/expansion/opll.js RHYTHM_DEFS)で、リズムを使う曲は
 * メロディ6ch+打楽器5種(BD/TOMは実音程、SD/CYM/HHは疑似音程レーン)。channelsは常に9本
 * 固定でリズム時のch7-9は空(ロールの進捗再構築でトラック集合が変わらないようにする)。
 *
 * ADPCM-B(Y8950): writeLogからはサンプル内容が見えない(CPUがデータポートへ流し込むため)
 * ので、音符化はせず打点だけを1レーンの疑似音程で出す(rhythmと同じ noiseRollIndex 方式、
 * ロール/鍵盤のOLB行用)。MML変換ではチャンネルにしない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  const NUM_MELODY_MAX = 9;
  const NUM_MELODY_RHYTHM = 6;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }

  // ch → (mod, car) スロットレジスタオフセット
  function slotOf(ch) {
    const g = (ch / 3) | 0, k = ch % 3;
    return [g * 8 + k, g * 8 + k + 3];
  }

  function buildTimeline(writeLog) {
    let latch = 0;
    const regs = new Uint8Array(256);
    const keyon = new Array(NUM_MELODY_MAX).fill(false);
    let rhythmKeys = 0;
    let rhythmUsed = false;
    let adpcmOn = false;
    const frames = writeLog.map(writes => {
      const attack = new Array(NUM_MELODY_MAX).fill(false);
      const rhythmAttack = { bd: false, sd: false, tom: false, cym: false, hh: false };
      let adpcmAttack = false;
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (!io) continue;
        if (addr === 0xC0) { latch = value & 0xFF; continue; }
        if (addr !== 0xC1) continue;
        regs[latch] = value;
        if (latch >= 0xB0 && latch <= 0xB8) {
          const ch = latch - 0xB0;
          const on = !!(value & 0x20);
          if (on && !keyon[ch]) attack[ch] = true;
          keyon[ch] = on;
        } else if (latch === 0xBD) {
          if (value & 0x20) {
            rhythmUsed = true;
            const rising = value & ~rhythmKeys;
            if (rising & 0x10) rhythmAttack.bd = true;
            if (rising & 0x08) rhythmAttack.sd = true;
            if (rising & 0x04) rhythmAttack.tom = true;
            if (rising & 0x02) rhythmAttack.cym = true;
            if (rising & 0x01) rhythmAttack.hh = true;
            rhythmKeys = value & 0x1F;
          } else {
            rhythmKeys = 0;
          }
        } else if (latch === 0x07) {
          // ADPCM-B(Y8950)制御: START(bit7)かつRECでない書込みを打点とする
          const on = (value & 0x80) !== 0 && (value & 0x40) === 0;
          if (on && !adpcmOn) adpcmAttack = true;
          adpcmOn = on;
        }
      }
      return { regs: regs.slice(), attack, rhythmAttack, adpcmAttack };
    });
    return { frames, rhythmUsed };
  }

  // 現在のレジスタ影から ch の音色をOPLLカスタム音色8バイトへ(冒頭コメント参照)
  function opllToneBytes(regs, ch) {
    const [m, c] = slotOf(ch);
    const wse = !!(regs[0x01] & 0x20);
    const half = (s) => (wse && (regs[0xE0 + s] & 3) >= 1) ? 1 : 0;
    const b20 = (s) => regs[0x20 + s] & 0xFF; // AM|VIB|EGT|KSR|MULT: OPLLと同じビット並び
    const cnt = regs[0xC0 + ch] & 1;
    const fb = (regs[0xC0 + ch] >> 1) & 7;
    const mTL = cnt ? 0x3F : (regs[0x40 + m] & 0x3F);
    return [
      b20(m), b20(c),
      ((regs[0x40 + m] >> 6) << 6) | mTL,
      ((regs[0x40 + c] >> 6) << 6) | (half(c) << 4) | (half(m) << 3) | fb,
      regs[0x60 + m], regs[0x60 + c],
      regs[0x80 + m], regs[0x80 + c]
    ];
  }

  function extractChannelEvents(timeline, ch, fs, toneReg) {
    const events = [];
    const [, car] = slotOf(ch);
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, attack } = timeline[f];
      const fnum = regs[0xA0 + ch] | ((regs[0xB0 + ch] & 3) << 8);
      const block = (regs[0xB0 + ch] >> 2) & 7;
      const keyon = !!(regs[0xB0 + ch] & 0x20);
      const volume = Math.min(15, (regs[0x40 + car] & 0x3F) >> 2); // 減衰値(0=最大、OPLL向き)
      const freqHz = (keyon && fnum > 0) ? fnum * Math.pow(2, block - 1) * fs / 524288 : null;
      const note = freqHz != null ? freqToNoteNumber(freqHz) : null;
      const srcTone = note !== null ? opllToneBytes(regs, ch) : undefined; // 音色の同定(src/convert/toneKey.js)
      const vrc7Tone = (toneReg && srcTone) ? toneReg.assign(srcTone) : undefined;
      if (!cur) { cur = { note, volume, instrument: 0, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: false }; continue; }
      if (attack[ch] || note !== cur.note || volume !== cur.volume || vrc7Tone !== cur.vrc7Tone) {
        flush(f);
        cur = { note, volume, instrument: 0, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: !!attack[ch] };
      }
    }
    flush(timeline.length);
    return events;
  }

  // リズム5種(OPLLのRHYTHM_DEFSと同じ流儀。BD/TOMは実音程、他は疑似音程レーン)。
  // 音量はスロットのTL>>2(BD=ch6car, SD=ch7car, TOM=ch8mod, CYM=ch8car, HH=ch7mod)
  const RHYTHM_DEFS = [
    { key: 'bd',  bit: 0x10, tlSlot: () => slotOf(6)[1], rollIndex: 0, fnumCh: 6 },
    { key: 'sd',  bit: 0x08, tlSlot: () => slotOf(7)[1], rollIndex: 2, fnumCh: null },
    { key: 'tom', bit: 0x04, tlSlot: () => slotOf(8)[0], rollIndex: 4, fnumCh: 8 },
    { key: 'cym', bit: 0x02, tlSlot: () => slotOf(8)[1], rollIndex: 6, fnumCh: null },
    { key: 'hh',  bit: 0x01, tlSlot: () => slotOf(7)[0], rollIndex: 8, fnumCh: null }
  ];

  function extractRhythmEvents(timeline, def, fs) {
    const events = [];
    const tlSlot = def.tlSlot();
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, rhythmAttack } = timeline[f];
      const on = (regs[0xBD] & 0x20) !== 0 && (regs[0xBD] & def.bit) !== 0;
      if (!on) { flush(f); continue; }
      const volume = Math.min(15, (regs[0x40 + tlSlot] & 0x3F) >> 2);
      let note = def.rollIndex, useRollIndex = true;
      if (def.fnumCh !== null) {
        const ch = def.fnumCh;
        const fnum = regs[0xA0 + ch] | ((regs[0xB0 + ch] & 3) << 8);
        const block = (regs[0xB0 + ch] >> 2) & 7;
        const n = fnum > 0 ? freqToNoteNumber(fnum * Math.pow(2, block - 1) * fs / 524288) : null;
        if (n !== null && n + 12 >= 24) { note = n; useRollIndex = false; }
      }
      const attack = !!rhythmAttack[def.key];
      const mk = (retrigger) => useRollIndex
        ? { note, noiseRollIndex: def.rollIndex, volume, start: f, end: f, retrigger }
        : { note, volume, start: f, end: f, retrigger };
      if (!cur) { cur = mk(true); continue; }
      if (attack || volume !== cur.volume || note !== cur.note) { flush(f); cur = mk(attack); }
      else cur.end = f;
    }
    flush(timeline.length);
    return events;
  }

  // ADPCM-B(Y8950)の打点(1レーンの疑似音程。ロール/鍵盤のOLB行用、MML変換対象外)
  function extractAdpcmEvents(timeline) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, adpcmAttack } = timeline[f];
      const on = (regs[0x07] & 0x80) !== 0 && (regs[0x07] & 0x40) === 0;
      if (!on) { flush(f); continue; }
      const volume = Math.min(15, 15 - (regs[0x12] >> 4)); // level(0-255)→減衰値の向きへ
      if (!cur) { cur = { note: 10, noiseRollIndex: 10, volume, start: f, end: f, retrigger: true }; continue; }
      if (adpcmAttack || volume !== cur.volume) { flush(f); cur = { note: 10, noiseRollIndex: 10, volume, start: f, end: f, retrigger: !!adpcmAttack }; }
      else cur.end = f;
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.opl = function (writeLog, totalFrames, clock, toneReg) {
    const fs = (clock || 3579545) / 72;
    const { frames: timeline, rhythmUsed } = buildTimeline(writeLog);
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument, retrigger: ev.retrigger },
      ev.note !== null && ev.freqHz != null ? { rawFreq: ev.freqHz } : {},
      ev.vrc7Tone !== undefined ? { vrc7Tone: ev.vrc7Tone } : {},
      ev.srcTone ? { srcTone: ev.srcTone } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}
    );
    const rhythm = rhythmUsed
      ? RHYTHM_DEFS.reduce((acc, def) => { acc[def.key] = extractRhythmEvents(timeline, def, fs); return acc; }, {})
      : null;
    const adpcm = extractAdpcmEvents(timeline);
    return {
      rhythmUsed,
      rhythm,
      adpcm: adpcm.length ? adpcm : null,
      channels: Array.from({ length: NUM_MELODY_MAX }, (_, ch) => ({
        events: (rhythmUsed && ch >= NUM_MELODY_RHYTHM)
          ? []
          : MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, fs, toneReg)).map(toCommon),
        hasVolume: true,
        hasInstrument: true,
        hasVrc7Tone: !!toneReg
      }))
    };
  };
})(globalThis);

/*
 * 音色の同定キー — MML.Convert.ToneKey (2026-09-09、音色別指定「音色一覧」の土台)
 *
 * 「変換元チャンネルの中で使われている音色(楽器)1つ」を、形式に依らない文字列キーで同定する。
 * 設定(src/convert/toneSettings.js)はこのキーで持つので、同じ音色が別チャンネルに出ても・
 * 同じゲームの別トラックでも同じ設定が効く(DPCMパッドの「サンプル内容ハッシュ」と同じ考え方。
 * src/convert/drumSamples.js 冒頭参照)。
 *
 * キーの形(先頭の種別で見分ける):
 *   'brr:<hash>'    SPCのBRRサンプル(MML.SPC2MML.brrHash と同じ値)
 *   'pcm:<hash>'    VGMのサンプルPCM(Emu.SamplePitchUtil.sampleHash)
 *   'opn:<hash>'    OPN/OPM系4op FM音色(キャリアのTLは音量なので除いて同定)
 *   'opll:<n>'      OPLL/VRC7の内蔵音色 @1-@15
 *   'opllc:<hash>'  OPLL/VRC7 自作音色(レジスタ$00-$07の8バイト)。OPL(2op)の音色はOPLL形式へ
 *                   変換済みのバイト列で同定する(抽出器 kss2mml/expansion/opl.js が変換する)
 *   'wave:<hash>'   波形メモリ(SCC/GB波形/HuC6280/N163/FDS)。32点・0..15へ正規化してから同定
 *   'duty:<n>'      デューティ矩形波(2A03/MMC5/GB=0-3、VRC6=0-7)
 *   'sq:<chip>'     デューティ固定の矩形波(AY/SN76489)。チップに1音色
 *   'tri' / 'saw' / 'noise' / 'sample'  音色の区別を持たない行
 *
 * ★同じ音色を「抽出器のイベント」(ofEvent)と「鍵盤/ロールのライブ状態」(ofLive)の両方から
 *   同じキーに落とせることが要件。ロールのノートに載せたキーで音色一覧を組み、変換側は
 *   イベントから引いた同じキーで設定を適用する。片方だけ変えるとキーが食い違って設定が効かなくなる。
 *
 * Worker(ロール構築 src/audio/roll-builders.js)でも動かすのでDOM/localStorageは触らない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const WAVE_LEN = 32;

  // FNV-1a 32bit(整数列)。sampleHash と同じ系のハッシュだが入力が整数配列なので別実装
  function fnv(values, seed) {
    let h = seed === undefined ? 0x811c9dc5 : seed;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] | 0;
      h ^= v & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  /** 任意長・任意値域の1周期波形 → 32点・0..15 の正規化波形(同定と表示に使う) */
  function normalizeWave(data) {
    if (!data || !data.length) return null;
    const n = data.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = +data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new Array(WAVE_LEN);
    if (!(hi > lo)) { out.fill(8); return out; }
    for (let i = 0; i < WAVE_LEN; i++) {
      const v = +data[Math.floor(i * n / WAVE_LEN)];
      out[i] = Math.max(0, Math.min(15, Math.round((v - lo) / (hi - lo) * 15)));
    }
    return out;
  }
  function waveKey(data) {
    const w = normalizeWave(data);
    return w ? 'wave:' + fnv(w) : null;
  }

  // ── OPN/OPM 4op ───────────────────────────────────────────────────
  // 各アルゴリズムのキャリア(出力に直結するop、論理op番号0-3)。キャリアのTLは音量なので同定から外す
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  const OP_FIELDS = ['DT', 'ML', 'TL', 'KS', 'AR', 'DR', 'SR', 'SL', 'RR', 'AM', 'SE', 'DT2'];
  function opnKey(p) {
    if (!p || !p.ops || !p.ops.length) return null;
    const alg = (p.AL || 0) & 7;
    const carriers = OPN_CARRIERS[alg];
    const vals = [alg, (p.FB || 0) & 7];
    for (let i = 0; i < p.ops.length; i++) {
      const o = p.ops[i] || {};
      for (const f of OP_FIELDS) {
        let v = o[f];
        if (v === undefined) v = 0;
        if (f === 'TL' && carriers.indexOf(i) >= 0) v = 0;
        vals.push(v);
      }
    }
    return 'opn:' + fnv(vals);
  }

  // ── OPLL/VRC7 ─────────────────────────────────────────────────────
  // {mod, car} 形式の音色 → レジスタ$00-$07の8バイト(src/ui/keyboard.js opllPatchBytes と同じ並び)
  function opllBytesOf(p) {
    const m = p && p.mod, c = p && p.car;
    if (!m || !c) return null;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15),
    ];
  }
  function opllCustomKey(bytes) {
    if (!bytes || bytes.length < 8) return null;
    return 'opllc:' + fnv(Array.from(bytes).slice(0, 8));
  }
  function opllKey(inst, bytes) {
    const n = inst | 0;
    if (n > 0 && n <= 15) return 'opll:' + n;
    return opllCustomKey(bytes);
  }

  // ── 抽出器イベント → キー ─────────────────────────────────────────
  // ctx: { chip, kind, brrSamples? }(borrow.js の source s をそのまま渡せる)
  // 抽出器がイベントに載せる同定情報:
  //   ev.srcn(SPC) / ev.sampleHash(VGM PCM) / ev.opnPatch(OPN系) / ev.srcTone(OPLL/OPL 8バイト) /
  //   ev.instrument(OPLLの内蔵音色番号・GB/2A03デューティ) / ev.srcWave(波形メモリの生波形)
  function ofEvent(ev, ctx) {
    if (!ev || ev.note === null) return null;
    const chip = ctx && ctx.chip;
    if (ev.srcn !== undefined && ctx && ctx.brrSamples) {
      const h = MML.SPC2MML && MML.SPC2MML.brrHash ? MML.SPC2MML.brrHash(ctx.brrSamples[ev.srcn]) : null;
      return h ? 'brr:' + h : 'brr:srcn' + ev.srcn;
    }
    if (ev.sampleHash) return 'pcm:' + ev.sampleHash;
    if (ev.opnPatch) return opnKey(ev.opnPatch);
    if (chip === 'ym2413' || chip === 'opl' || chip === 'vrc7') {
      if (ev.srcTone) return opllCustomKey(ev.srcTone);
      if (ev.instrument > 0) return 'opll:' + (ev.instrument & 15);
      return null;
    }
    if (ev.srcWave) return waveKey(ev.srcWave);
    if (chip === 'ay8910' || chip === 'sn76489') return 'sq:' + chip;
    if (chip === 'gb' && ctx.kind === 'square') return ev.instrument !== undefined ? 'duty:' + (ev.instrument & 3) : 'duty:2';
    return null;
  }

  // ── 鍵盤/ロールのライブ状態(extractChannels の1行) → キー ─────────────────
  // 同定に使うのは: ch.fmPatch(OPN/OPM/OPLL) / ch.sampleHash(サンプルPCM) / ch.wave(波形) / ch.duty
  const patchKeyCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ofLive(ch) {
    if (!ch) return null;
    if (ch.srcn !== undefined && ch.brrHash) return 'brr:' + ch.brrHash;
    if (ch.sampleHash) return 'pcm:' + ch.sampleHash;
    const p = ch.fmPatch;
    if (p) {
      if (patchKeyCache && typeof p === 'object') {
        const c = patchKeyCache.get(p);
        if (c !== undefined) return c;
      }
      let k = null;
      if (p.type === 'opll') k = opllKey(p.inst, opllBytesOf(p));
      else if (p.ops) k = opnKey(p);
      if (patchKeyCache && typeof p === 'object') patchKeyCache.set(p, k);
      return k;
    }
    const w = ch.wave;
    if (ch.noise) return 'noise';
    if (!w) return null;
    if (w.t === 'wave' && w.data && w.data.length) return waveKey(w.data);
    if (w.t === 'pulse') {
      if (ch.duty !== undefined && ch.duty !== null) return 'duty:' + ch.duty;
      if (/^(KP|SN)\d/.test(ch.id || '')) return 'sq:' + (/^SN/.test(ch.id) ? 'sn76489' : 'ay8910');
      return null;
    }
    if (w.t === 'tri') return 'tri';
    if (w.t === 'saw') return 'saw';
    if (w.t === 'sample') return 'sample';
    return null;
  }

  // ── 表示・試聴用の付随情報(キーだけでは音が作れないので、初出時に一緒に控える) ────
  //   { kind:'brr'|'pcm'|'opn'|'opll'|'wave'|'duty'|'sq'|'other', label, wave?(32点0..15), patch?, bytes?, inst?, duty? }
  function infoOfLive(ch, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    const p = ch.fmPatch;
    if (info.kind === 'opll' && p) {
      info.inst = p.inst | 0;
      info.bytes = opllBytesOf(p);
      info.label = info.inst > 0 ? '@' + info.inst : 'OP';
    } else if (info.kind === 'opn' && p) {
      info.patch = p;
      info.label = 'FM' + (p.AL !== undefined ? ' AL' + p.AL : '');
    } else if (info.kind === 'wave' && ch.wave && ch.wave.data) {
      info.wave = normalizeWave(ch.wave.data);
      info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ch.duty | 0;
      info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'pcm') {
      info.sample = ch.adpcmSample || null;
      info.label = 'PCM';
    }
    return info;
  }
  function infoOfEvent(ev, ctx, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    if (info.kind === 'opll') {
      if (ev.srcTone) { info.bytes = Array.from(ev.srcTone).slice(0, 8); info.inst = 0; info.label = 'OP'; }
      else { info.inst = ev.instrument | 0; info.label = '@' + info.inst; }
    } else if (info.kind === 'opn') {
      info.patch = ev.opnPatch; info.label = 'FM AL' + (ev.opnPatch.AL | 0);
    } else if (info.kind === 'wave') {
      info.wave = normalizeWave(ev.srcWave); info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ev.instrument | 0; info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'brr') {
      info.srcn = ev.srcn; info.label = 'srcn' + ev.srcn;
    } else if (info.kind === 'pcm') {
      info.label = 'PCM';
    }
    return info;
  }

  /** 設定を持てるキーか(音色の区別が無い 'tri'/'saw'/'noise'/'sample' は対象外) */
  function isAssignable(key) {
    return !!key && /^(brr|pcm|opn|opll|opllc|wave|duty|sq):/.test(key);
  }

  MML.Convert.ToneKey = {
    WAVE_LEN, fnv, normalizeWave, waveKey, opnKey, opllBytesOf, opllKey, opllCustomKey,
    ofEvent, ofLive, infoOfLive, infoOfEvent, isAssignable,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ピアノロール タイムライン構築(全フォーマット共通・純粋関数)
 * MML.RollBuild
 *
 * 元はmain.jsのbuildXxxRollTimeline群(+keyboard.jsのbuildRollTracksFromRegSnapshots)
 * としてメインスレッド専用だったが、キャプチャWorker化に伴い「1回あたりO(曲全体)の
 * タイムライン構築」がメインスレッドの長タスク(実測~90ms=オーディオバッファ級)として
 * 残ったため、構築そのものをキャプチャWorker内で実行できるようここへ分離した
 * (README-worker-build.txt参照)。メインスレッド(Workerフォールバック時)とWorker
 * バンドルの両方から同じコードが使われる。
 *
 * 依存(すべて実行時参照なので読み込み順は問わない。Workerバンドルには
 * tools/build-capture-workers.ps1が対応フォーマットぶんだけ同梱する):
 *   nsf/vgm: MML.UI.buildRollTracksFromRegSnapshots (src/ui/keyboard.js)
 *   kss/vgm: MML.Kss2MmlExpansion.ay/scc/opll (+MML.Convert: convert/pitch.js)
 *   gbs/vgm: MML.Gbs2MmlExpansion.pulse/noise/wave
 *   hes/vgm: MML.Hes2MmlExpansion.wave/noiseChannel/extractDdaClips
 *   spc:     MML.SPC2MML.extractVoiceEvents
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const RollBuild = MML.RollBuild = MML.RollBuild || {};

  // ── 高速アルペジオ(@EN)の展開 ────────────────────────────────────────
  // MML.Convert.mergeRapidArpeggio(src/convert/pitch.js)は、フレーム単位で音程が
  // 周期的に切り替わる高速アルペジオを「基準ノート1音 + ev.noteEnvOffsets(=@EN<n>、
  // フレーム毎の累積半音差分)」へ畳む。MML本文としてはそれが正しい表現だが、
  // ロールはそのイベントをそのまま描くため、基準ノート1本の長い帯になり、毎フレームの
  // 実レジスタ値を出している鍵盤表示と見た目が食い違う
  // (Space Manbow(MSX) 60曲目のSCC ch3=Rで実測。3.2秒以降のアルペジオ全域)。
  // @ENは「前フレームからの半音差分」なので基準ノートから順に足し込めば元の音程列が
  // 完全に復元でき、それは実レジスタ列とも(MMLを再生したときの実発音とも)一致する。
  // deltas省略時は分割せず元の1区間をそのまま返すので、呼び出し側は無条件に通してよい。
  RollBuild.expandNoteEnv = function (start, end, note, deltas) {
    if (!deltas || !deltas.length) return [{ start, end, note }];
    const out = [];
    let cur = note;
    let segStart = start;
    for (let f = start; f < end; f++) {
      const d = deltas[(f - start) % deltas.length];
      if (!d) continue;
      if (f > start) { out.push({ start: segStart, end: f, note: cur }); segStart = f; }
      cur += d;
    }
    out.push({ start: segStart, end, note: cur });
    return out;
  };

  // ── SPC ──────────────────────────────────────────────────────────────
  // drumKinds(省略可): srcn → 'drum' | 'pitch' の手動上書き(main.jsがBRR内容ハッシュで引く)。
  // 打楽器と判定したsrcnの発音は音程ノートではなく drumKey 付きノート(ドラム区画/パッド)に
  // する。判定はMML変換と同じ MML.SPC2MML.drumSrcns(ロール=MML変換デバッガの方針)。
  // 音色キー(src/convert/toneKey.js)をロールのノートに載せ、トラックの tones 表に表示/試聴用の
  // 付随情報を控える(音色一覧パネル src/ui/tonePanel.js の材料。main.js rebuildToneInventory)。
  // ★ノートに載せるのは文字列キーだけ(Workerからの構造化複製で運ぶ量を増やさない)。
  //   付随情報は音色ごとに1回、トラックオブジェクトのプロパティ tones に置く(配列に生やした
  //   プロパティは複製で消えるので、必ずトラック(オブジェクト)側に置く)
  RollBuild.toneOf = function (ev, ctx, tones) {
    const TK = MML.Convert && MML.Convert.ToneKey;
    if (!TK || !ctx) return undefined;
    const k = TK.ofEvent(ev, ctx);
    if (!k) return undefined;
    if (tones && !tones[k]) tones[k] = TK.infoOfEvent(ev, ctx, k);
    return k;
  };

  RollBuild.spc = function (log, frameRate, srcnFineTune, drumKinds) {
    const frameDur = 1 / frameRate;
    // MML変換と同じ原音チューニング補正を渡し、ロール表示の音程も実機発音に一致させる
    // (ロール=MML変換デバッガの方針。補正マップは再生開始時に一度だけ算出して使い回す)。
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    const drumSrcns = (drumKinds !== false && MML.SPC2MML.drumSrcns)
      ? MML.SPC2MML.drumSrcns(voiceEvents, srcnFineTune, drumKinds || null) : new Set();
    let drumSeq = 0;
    return voiceEvents.map((events, ch) => ({
      id: `V${ch}`,
      color: `hsl(${ch * 45},90%,65%)`,
      notes: events
        .filter(e => e.pitchSemi !== null)
        // 打楽器サンプルの発音: 音程軸ではなくドラム区画へ(midi無し、drumKey='brr:<srcn>')
        .map(e => (!e.non && drumSrcns.has(e.srcn))
          ? { drum: true, startSec: e.frame * frameDur, endSec: (e.frame + e.len) * frameDur, midi: null,
              drumKey: 'brr:' + e.srcn, drumSeq: ++drumSeq, vol: Math.max(0, Math.min(1, (e.vol || 0) / 127)), freqSeq: [] }
          : e)
        // 音量シェーディング用の簡易近似: ADSRモード(adsr1 bit7=1)ならサスティンレベル(adsr2 bit5-7、
        // 0-7)を目安の音量とする。GAINモード(直接指定)は減衰カーブを追わず常に最大音量扱い。
        // pitchSemi は note-number 空間(57=A4=MIDI69)なので MIDI へは +12。
        .reduce((acc, e) => {
          if (e.drum) { acc.push(e); return acc; } // ドラム区画のノートはそのまま
          // freqSeq(セント偏差オーバーレイ用): DSPピッチレジスタ(pitch=0x1000で原音32kHz)を
          // pitchToSemitone(src/spc2mml/converter.js)と同じ式でHzへ変換する。
          const tune = (srcnFineTune && srcnFineTune[e.srcn]) || 0;
          const tuneFactor = Math.pow(2, (tune + 3) / 12);
          const vol = (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1;
          const freqSeq = (e.pitchSeq || []).map(p => 440 * (p / 4096) * tuneFactor);
          // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
          // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)
          const steps = RollBuild.expandNoteEnv(e.frame, e.frame + e.len, e.pitchSemi + 12, e.noteEnvOffsets);
          for (let si = 0; si < steps.length; si++) {
            acc.push({
              startSec: steps[si].start * frameDur, endSec: steps[si].end * frameDur, midi: steps[si].note,
              vol, freqSeq: si === 0 ? freqSeq : [],
              // srcn: 借用先にE(DPCM)を選んだボイスをロール上でパッドへ置き換えるのに使う
              // (main.js applySynthDrumToRoll。ノートからBRRサンプルを特定できるのはこれだけ)
              srcn: e.srcn,
            });
          }
          return acc;
        }, []),
    }));
  };

  // ── KSS ──────────────────────────────────────────────────────────────
  // headerがSCCデコーダを持ちうる構成か(16Kバンク+RAMモードはバス側でSCCが殺される)
  RollBuild.kssHasSccDecoder = function (header) {
    return !!header && !(header.bankMode === '16K' && header.device.ramMode);
  };

  // writeLogのフレーム範囲[from,to)にSCC音源レジスタ(周波数/音量/有効ビット)への
  // 書込みがあるか。波形テーブルはクリア目的で0書きされることがあるため判定材料にせず、
  // 実際に発音に効くレジスタだけを見る。classic(SCC)は0x80-0x8F、SCC+(SCC-I)は
  // 0xA0-0xAF側も見る。
  RollBuild.kssWriteLogUsesScc = function (writeLog, from, to) {
    for (let f = from; f < to && f < writeLog.length; f++) {
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite)
      for (const pw of writeLog[f]) {
        if ((pw >> 24) & 1) continue;
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF;
        const off = (addr >= 0x9800 && addr <= 0x98FF) ? addr - 0x9800
          : (addr >= 0xB800 && addr <= 0xB8FF) ? addr - 0xB800 : -1;
        if (off < 0 || value === 0) continue;
        if ((off >= 0x80 && off <= 0x8F) || (off >= 0xA0 && off <= 0xAF)) return true;
      }
    }
    return false;
  };

  // PSG→KP/SCC→KS/FMPAC→KF は src/ui/keyboard.js の extractChannels() の色分けと揃える。
  // clockOverride(省略可): AY/SCC抽出器に渡すZ80相当クロック。KSSは常にMSXの3.58MHz、
  // VGMはチップごとに違う(vgmPlayer.js captureVgmSongAsync の kss.clock)ので呼び出し側が渡す。
  // oplOpts(省略可): { used, clock, adpcm } — OPL系(KSSのMSX-AUDIO / VGMのYM3812・YM3526・
  // Y8950)のOL行を作る。KSSは header.device.msxAudio から、VGMは data.kss.opl/oplClock から。
  RollBuild.kss = function (writeLog, totalFrames, frameRate, header, sccUsed, clockOverride, oplOpts) {
    const frameDur = 1 / frameRate;
    const clock = clockOverride || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // ★2026-08-22: ただし **OPLLだけ向きが逆**。AY/SCCの音量は「大きいほど大音量」だが、
    // OPLLのレジスタ$30下位4bitは減衰値で0が最大音量・15が無音(3dB/step)。
    // レジスタ生値の向きは変えられない(MML変換が v<n> をそのまま $30 のニブルへ書き戻す
    // 往復経路になっている。src/mml/compiler.js segmentsToWriteLogVrc7 の
    // `(instrument << 4) | seg.volume`、src/vgm2mml/converter.js の `ev.volume * 3` 参照)。
    // そのため反転はこの表示用正規化の中だけで行う。
    // note: Kss2MmlExpansionのfreqToNoteNumberはMML変換共通のノート番号体系(57=A4)で、
    // 標準MIDIより1オクターブ(12)低い。鍵盤描画に合わせるロール側でのみ+12補正する。
    // ★抽出イベントは「音量が1でも変わったら別イベント」に切れているため、音程が同じまま
    // 途切れず続いている区間を1本の音符に統合する(retriggerだけは区切りとして残す)。
    const toNotes = (events, attenuated, ctx, tones) => {
      const norm = (v) => {
        const n = Math.max(0, Math.min(15, v || 0));
        return (attenuated ? (15 - n) : n) / 15;
      };
      // ノイズ行(AYの@2)は note がノイズ周期そのもの(ppmckのFME-7仕様)なので、
      // そのまま +12 すると MIDI_MIN(24) を下回って描画されない。抽出器が付けてくれる
      // noiseRollIndex(0-15)を使い、他チップのノイズ行と同じ C1〜D#2 に並べる
      // (keyboard.js noisePeriodIndexToMidi と同じ 24+idx)。
      const midiOf = (e) => (e.noiseRollIndex !== undefined) ? 24 + e.noiseRollIndex : e.note + 12;
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
        // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)。
        // freqSeq(セント偏差オーバーレイ)と retrigger は元イベント先頭の区間にだけ効く。
        const steps = RollBuild.expandNoteEnv(e.start, e.end, midiOf(e), e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && !(e.retrigger && si === 0) && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, norm(e.volume));
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: norm(e.volume), freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    // 音色キー付きのトラック(ctx は toneKey.js ofEvent の文脈=チップと種別)
    const mk = (id, color, events, attenuated, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, attenuated, ctx, tones), tones }; };

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push(mk(`KP${i + 1}`, KP_COLS[i], ch.events, false, { chip: 'ay8910', kind: 'square' })));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push(mk(`KS${i + 1}`, `hsl(${(280 + i * 20) % 360},80%,60%)`, ch.events, false, { chip: 'k051649', kind: 'wave' })));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      // 第2引数true = OPLLの音量は減衰値なので表示用に反転する(toNotes冒頭のコメント参照)
      opllResult.channels.forEach((ch, i) => tracks.push(mk(`KF${i + 1}`, KF_COLS[i % KF_COLS.length], ch.events, true, { chip: 'ym2413', kind: 'fm' })));
      // リズムモードの打楽器5行。id/色/並び順は鍵盤側(keyboard.js の kssOpll 分岐、
      // RCOLS/RLABEL)と1対1で合わせる。音程を持たないので疑似音程(noiseRollIndex)で
      // 5レーンに分けている(kss2mml/expansion/opll.js の RHYTHM_DEFS 参照)。
      if (opllResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: `KF${RLABEL[key]}`, color: RCOLS[key],
            notes: toNotes(opllResult.rhythm[key] || [], true) });
        }
      }
    }

    // OPL系(MSX-AUDIO/YM3812/YM3526/Y8950): KF行と同じ流儀でOL行。音量はOPLL同様
    // 減衰値(attenuated=true)。リズムモード曲は打楽器5行、Y8950 ADPCM打点はOLB行。
    if (oplOpts && oplOpts.used && MML.Kss2MmlExpansion.opl) {
      const oplResult = MML.Kss2MmlExpansion.opl(writeLog, totalFrames, oplOpts.clock);
      const OL_COLS = ['#66ffcc', '#55eebb', '#44ddaa', '#33cc99', '#22bb88', '#11aa77', '#66e0d0', '#55d0c0', '#44c0b0'];
      oplResult.channels.forEach((ch, i) => tracks.push(mk(`OL${i + 1}`, OL_COLS[i % OL_COLS.length], ch.events, true, { chip: 'opl', kind: 'fm' })));
      if (oplResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RIDS = { bd: 'OLBD', sd: 'OLSD', tom: 'OLTM', cym: 'OLCY', hh: 'OLHH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: RIDS[key], color: RCOLS[key], notes: toNotes(oplResult.rhythm[key] || [], true) });
        }
      }
      if (oplResult.adpcm) tracks.push({ id: 'OLB', color: '#cc66ff', notes: toNotes(oplResult.adpcm, true) });
    }

    return tracks;
  };

  // ── GBS ──────────────────────────────────────────────────────────────
  RollBuild.gbs = function (snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // toNotes: 音程が同じまま途切れず続いている区間を1本の音符に統合する(GBは実トリガbitが
    // あるためretrigger判定はtriggerSeqの変化そのもの=抽出側で既にイベント境界として反映済み)。
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const mk = (id, color, events, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, ctx, tones), tones }; };
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになり無音扱いになる。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push(mk('GB1', '#66ddff', ch1.events, { chip: 'gb', kind: 'square' }));
    tracks.push(mk('GB2', '#0077dd', ch2.events, { chip: 'gb', kind: 'square' }));
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push(mk('GW', '#ffcc00', wave.events, { chip: 'gb', kind: 'wave' }));
    return tracks;
  };

  // ── HES ──────────────────────────────────────────────────────────────
  // dpcmTrace/controlTrace(省略可): 渡されると DDA(PCM)の打点を drumKey 付きノートとして
  // 該当chのトラックへ足す(ロールのドラム区画/パッドに出る。VGMのサンプルPCMと同じ形)。
  // 打点の同定は hes2mml/expansion/dpcm.js ddaHits(MML変換と同じ登録簿)なので、
  // ロールで見た太鼓と変換で出る @DPCM が一致する([[roll-as-mml-debugger]])。
  RollBuild.hes = function (snapshots, frameRate, dpcmTrace, controlTrace) {
    const frameDur = 1 / frameRate;
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots);
    // id/色はkeyboard.js extractChannels()のisHesブロック(PSG0-5, PCOLS)と揃える。
    const colors = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
    // ノイズはch4/5独自の発音で、行/鍵盤表示でも同じPSG4/PSG5の行がwave/noiseを兼ねる
    // (wave/noiseは同一chで排他なので時間的に重ならず、単純にマージしてよい)。
    waveResult.channels.forEach((ch, i) => {
      const tones = {};
      let notes = toNotes(ch.events, { chip: 'huc6280', kind: 'wave' }, tones);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes, tones });
    });
    // DDA(PCM)の打点 → ドラム区画のノート(midi無し、drumKey/drumSeq付き)。
    // 同じ太鼓の連打が1本に融合しないよう drumSeq に打点の通番を入れる
    if (dpcmTrace && controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.ddaHits) {
      try {
        const { hits } = MML.Hes2MmlExpansion.ddaHits(snapshots, dpcmTrace, controlTrace, frameRate);
        hits.forEach((h, i) => {
          const tr = tracks[h.ch];
          if (!tr) return;
          tr.notes.push({ startSec: h.startFrame * frameDur, endSec: h.endFrame * frameDur, midi: null,
                          drumKey: h.key, drumSeq: i + 1, vol: h.vol, freqSeq: [] });
        });
        for (const tr of tracks) tr.notes.sort((a, b) => a.startSec - b.startSec);
      } catch (e) { /* DDA抽出の失敗でロール全体を落とさない */ }
    }
    return tracks;
  };

  // ── NSF(keyboard.jsの共通抽出経路への橋渡し)──────────────────────────
  RollBuild.nsf = function (regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
    return MML.UI.buildRollTracksFromRegSnapshots(
      regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
  };

  // ── VGM(チップファミリごとに上の各ビルダー/共通抽出経路を連結)─────────
  // opts.poolMode: チャンネルプール式チップの表示モード({multipcm:'logical'|'phys'})。
  // 'logical'なら割当逆算済みスナップショット(data.multipcm.logical)でロールを組む
  RollBuild.vgm = function (data, done, opts) {
    const frameRate = data.frameRate;
    const sr = 44100;
    const buildTracks = MML.UI.buildRollTracksFromRegSnapshots;
    let tracks = [];
    if (data.nes) {
      const nesChips = ['nes'].concat(data.nes.fds ? ['fds'] : []);
      const t = buildTracks(data.nes.regSnapshots, data.nes.writeLog, done, sr / frameRate, sr, nesChips, null);
      if (t) tracks = tracks.concat(t);
    }
    if (data.gb) tracks = tracks.concat(RollBuild.gbs(data.gb.snapshots.slice(0, done), frameRate));
    if (data.hes) tracks = tracks.concat(RollBuild.hes(data.hes.snapshots.slice(0, done), frameRate));
    if (data.kss) {
      const wl = data.kss.writeLog.slice(0, done);
      const fakeHeader = { device: { mode: 'MSX', fmpac: data.kss.opll } };
      const kssTracks = RollBuild.kss(wl, done, frameRate, fakeHeader, data.kss.scc, data.kss.clock,
        data.kss.opl ? { used: true, clock: data.kss.oplClock } : null);
      // AY未使用(SCC/OPLLのみ)のVGMではKP行が鍵盤に無いのでロール側も落とす
      tracks = tracks.concat(data.kss.ay ? kssTracks : kssTracks.filter(t => !/^KP\d/.test(t.id)));
    }
    // 2個目のPSG(vgmPlayer.js captureVgmSongAsync の kss2): 同じKSS抽出器で作って KP4-6 へ付け替える
    if (data.kss2) {
      const wl2 = data.kss2.writeLog.slice(0, done);
      const t2 = RollBuild.kss(wl2, done, frameRate, { device: { mode: 'MSX', fmpac: false } }, false, data.kss2.clock, null)
        .filter(t => /^KP[1-3]$/.test(t.id))
        .map(t => Object.assign({}, t, { id: 'KP' + (+t.id.slice(2) + 3) }));
      tracks = tracks.concat(t2);
    }
    // スナップショット型チップ: extractChannels(keyboard.js)が読むextraSnapsに
    // フレーム毎スナップショット配列を渡して同じ抽出経路でトラック化する
    const snapChips = ['sn', 'ym2612', 'ym2610fm', 'ym2151', 'ym2203fm', 'ym2608fm', 'ga20', 'k007232', 'msm5205', 'segapcm', 'c140', 'c352', 'okim6258', 'qsound', 'okim6295', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
    const chipToken = { sn: 'sn76489' };
    const poolMode = (opts && opts.poolMode) || {};
    for (const key of snapChips) {
      if (!data[key]) continue;
      const token = chipToken[key] || key;
      const snaps = (poolMode[key] === 'logical') ? (RollBuild.poolLogical(data, key) || data[key].snapshots) : data[key].snapshots;
      const extra = {}; extra[key] = snaps;
      const t = buildTracks(snaps, [], done, sr / frameRate, sr, ['vgm', token], null, extra);
      if (t) tracks = tracks.concat(t);
    }
    return tracks;
  };

  // ── PSF(PlayStation SPU)────────────────────────────────────────────
  // キャプチャ(psfPlayer.js capturePsfSongAsync / Worker の鏡像)の Int32Array スナップショットを
  // Emu.snapshotPsx で C352 と同じ形のオブジェクトへ変換し、VGM の PCM チップと同じ抽出経路
  // (keyboard.js extractChannels の 'psx' 行)でトラック化する。変換済みのフレームは state に
  // 溜めて次回は続きだけ作る(ロールは曲が伸びるたびに何度も組み直すため)。
  // opts.poolMode.psx === 'phys' なら実機ボイス、それ以外は合成ch(Emu.PoolChannelRegrouper)。
  RollBuild.psfObjectSnapshots = function (cap, state) {
    const Emu = MML.Emu;
    if (!state.bank || state.bank.samples !== cap.samples) state.bank = new Emu.PsxSampleBank(cap.samples);
    if (!state.data) state.data = { psx: { snapshots: [] } };
    const out = state.data.psx.snapshots;
    const n = cap.snapshots.length;
    for (let i = out.length; i < n; i++) {
      if (!cap.snapshots[i]) break; // Worker の鏡像は穴が空かない想定だが、念のため途中で止める
      out.push(Emu.snapshotPsx(cap.snapshots[i], state.bank));
    }
    return state.data;
  };
  RollBuild.psf = function (cap, done, opts, state) {
    const frameRate = cap.frameRate || 60;
    const sr = 44100;
    const data = RollBuild.psfObjectSnapshots(cap, state || {});
    const poolMode = (opts && opts.poolMode) || {};
    const snaps = RollBuild.psxFrames(data, poolMode.psx);
    const n = Math.min(done, snaps.length);
    const t = MML.UI.buildRollTracksFromRegSnapshots(snaps, [], n, sr / frameRate, sr, ['vgm', 'psx'], null, { psx: snaps });
    return t || [];
  };

  // PSF の表示モード別のレーン列: 'phys'=実機ボイス / 'logical'=合成ch / 'track'(既定)=トラック×声部
  RollBuild.psxFrames = function (data, mode) {
    if (mode === 'phys') return data.psx.snapshots;
    if (mode === 'logical') return RollBuild.poolLogical(data, 'psx') || data.psx.snapshots;
    return RollBuild.psxTrackFrames(data) || data.psx.snapshots;
  };

  // ── PSF の「トラック」レーン(Emu.PsfTrackVoicer) ───────────────────────
  // poolLogical と同じく snapshots が伸びた分だけ続きから足す(声部の割り当ては状態を持つので同じインスタンスで続ける)。
  // d.__trackState.vc.lanes がレーン表(鍵盤の行名/変換のソース名)
  RollBuild.psxTrackFrames = function (data) {
    const d = data && data.psx;
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots) || !Emu.PsfTrackVoicer) return null;
    let S = d.__trackState;
    if (!S) {
      Object.defineProperty(d, '__trackState', { value: { vc: new Emu.PsfTrackVoicer(), out: [] }, configurable: true, writable: true });
      S = d.__trackState;
    }
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.vc.step(d.snapshots[i]));
    return S.out;
  };

  // ── プール式PCMチップの「合成ch」スナップショット ─────────────────────
  // logical は snapshots を Emu.PoolChannelRegrouper に先頭から順に通しただけの決定的なデータ。
  // キャプチャWorkerは通信量を減らすため logical を送らない(2026-09-13。c140 では progress の
  // 復元時間の約4割がこれだった)ので、画面側で合成ch表示が要るときだけここで作る。
  // snapshots が伸びていれば続きから足す(回帰器は状態を持つので同じインスタンスで続ける)。
  // メインスレッドで丸ごとキャプチャした data には logical が揃っているので、そのまま返す。
  RollBuild.poolLogical = function (data, key) {
    const d = data && data[key];
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots)) return null;
    const st = d.__logicalState;
    if (!st && Array.isArray(d.logical) && d.logical.length >= d.snapshots.length) return d.logical;
    const numCh = Emu && Emu.POOL_CHIP_CHANNELS && Emu.POOL_CHIP_CHANNELS[key];
    if (!numCh || !Emu.PoolChannelRegrouper) return null;
    if (!st || d.logical !== st.out) {
      // 列挙されない印にして、構造化複製やJSON化で運ばれないようにする
      Object.defineProperty(d, '__logicalState', { value: { rg: new Emu.PoolChannelRegrouper(numCh), out: [] }, configurable: true, writable: true });
      d.logical = d.__logicalState.out;
    }
    const S = d.__logicalState;
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.rg.step(d.snapshots[i]));
    return S.out;
  };

  // ── 構築スロットル ────────────────────────────────────────────────────
  // 壁時計ベース+直前の構築実測コスト×10を次回までの最小間隔にする適応制御
  // (構築のCPU占有率を~10%以下に自動制御。曲が進み1回の走査が重くなるほど自動的に
  // 間遠になる)。メインスレッドでは加えて非表示タブ中は最終回以外スキップする
  // (Worker内にはdocumentが無いので可視性チェックは自動的に無効=常時構築でよい。
  // Worker内の構築はメインスレッドをブロックしないため)。
  RollBuild.makeThrottle = function () {
    let lastBuildEnd = -Infinity;
    let minIntervalMs = 300;
    return {
      shouldBuild(done, total) {
        if (done >= total) return true; // 最終回は必ず構築(取りこぼし防止)
        if (typeof document !== 'undefined' && document.hidden) return false;
        return performance.now() - lastBuildEnd >= minIntervalMs;
      },
      didBuild(buildStartMs) {
        lastBuildEnd = performance.now();
        minIntervalMs = Math.max(300, Math.min(5000, (lastBuildEnd - buildStartMs) * 10));
      },
      force() { lastBuildEnd = -Infinity; }
    };
  };

  // ── ロール構築ジョブ(フォーマット差異の吸収)─────────────────────────
  // Worker実装(capture-worker-*-impl.js)とクライアントのフォールバック
  // (capture-worker-client.js)の両方から使う。build(data, done, total)は
  // {timeline, info} を返す(infoはフォーマット固有の副産物: KSSのsccUsed、
  // HESのddaChannel)。dataの形はフォーマットごとのキャプチャ進行データ:
  //   nsf: {regSnapshots, writeLog, n163Snapshots} / kss: {writeLog}
  //   gbs: {snapshots} / hes: {snapshots, dpcmTrace, controlTrace}
  //   spc: {frameLog} / vgm: captureVgmSongAsyncのdataそのもの
  //   psf: capturePsfSongAsync の cap({snapshots, samples, frameRate})
  RollBuild.createRollJob = function (format, params) {
    params = params || {};
    if (format === 'nsf') {
      return { build: (data, done) => ({
        timeline: RollBuild.nsf(data.regSnapshots, data.writeLog, done,
          params.samplesPerFrame, params.sampleRate, params.chips || [], data.n163Snapshots),
        info: {}
      }) };
    }
    if (format === 'kss') {
      const sccPossible = RollBuild.kssHasSccDecoder(params.header);
      let sccUsed = false;
      let scanned = 0;
      // MSX-AUDIO(Y8950)を積むKSSはOL行も作る(クロックはMSX固定3.58MHz)
      const oplOpts = (params.header && params.header.device && params.header.device.msxAudio)
        ? { used: true, clock: 3579545 } : null;
      return { build: (data, done) => {
        // SCCは「使われたと分かった時点で行を足す」単調運用(main.js playKssStream参照)
        if (sccPossible && !sccUsed && RollBuild.kssWriteLogUsesScc(data.writeLog, scanned, done)) sccUsed = true;
        scanned = done;
        return {
          timeline: RollBuild.kss(data.writeLog.slice(0, done), done, params.frameRate, params.header, sccUsed, null, oplOpts),
          info: { sccUsed }
        };
      } };
    }
    if (format === 'gbs') {
      return { build: (data, done) => ({
        timeline: RollBuild.gbs(data.snapshots.slice(0, done), params.frameRate), info: {}
      }) };
    }
    if (format === 'hes') {
      return { build: (data, done) => {
        const snaps = data.snapshots.slice(0, done);
        const out = { timeline: RollBuild.hes(snaps, params.frameRate, data.dpcmTrace, data.controlTrace), info: {} };
        // DDA(PCM)を担当するchの判定(曲全体でDDA区間が最も長い1ch)も同じ頻度で更新する。
        // 実際の再生に使う生のdpcmTrace列はメインスレッド側が保持しているので、
        // ここではチャンネル番号だけをinfoで返す(main.js側でsetDdaChannel)。
        if (data.dpcmTrace && data.controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.extractDdaClips) {
          out.info.ddaChannel = MML.Hes2MmlExpansion.extractDdaClips(
            snaps, data.dpcmTrace, data.controlTrace, params.frameRate).channel;
        }
        return out;
      } };
    }
    if (format === 'spc') {
      return { build: (data, done) => ({
        timeline: RollBuild.spc(data.frameLog.slice(0, done), params.frameRate, params.fineTune || null, params.drumKinds || null),
        info: {}
      }) };
    }
    if (format === 'psf') {
      const state = {};
      return { build: (data, done) => ({ timeline: RollBuild.psf(data, done, params, state), info: {} }) };
    }
    if (format === 'vgm') {
      // params.poolMode: プール式チップの表示モード(Worker実行時はopt.roll経由で届く)
      return { build: (data, done) => ({ timeline: RollBuild.vgm(data, done, params), info: {} }) };
    }
    return null;
  };
})(globalThis);

/*
 * KSS/GBS/VGM/SPC/HES regsOnlyキャプチャ Worker本体(汎用ディスパッチ)
 *
 * NSF用のnsf-capture-worker-impl.jsと同じ仕組み(README-worker-build.txt参照)だが、
 * こちらは1本で複数フォーマットを扱う。各フォーマットのバンドルにこのファイルを
 * 結合し、msg.formatで対応するcaptureXxxSongAsyncへディスパッチする(バンドルに
 * 入っていないフォーマットを要求されたらerrorを返す)。
 *
 * プロトコル(capture-worker-client.jsの汎用ランナーと対):
 *   受信 {cmd:'capture', format:'kss'|'gbs'|'vgm'|'spc'|'hes', bytes, opt}
 *   受信 {cmd:'cancel'}
 *   送信 {type:'progress', done, total, arrays:{path:差分slice}, [meta]}
 *        - onProgressが渡すペイロード(進行中に育つ配列を含む構造)を走査し、
 *          「トップレベルまたは1段ネストの配列」をフレーム配列として前回送信位置
 *          からの差分だけ送る。配列以外(スカラ・フラグ・headerオブジェクト)は
 *          初回のみmetaとして送る。
 *   送信 {type:'done', [finalMeta]} … finalMetaはキャプチャ完了後に追加された
 *        非配列プロパティ(VGMのnes.dpcmRom等)を拾うための最終メタ再送
 *   送信 {type:'error', message}
 *   送信 {type:'roll', done, total, timeline, info}
 *        … opt.rollが渡された場合のみ。ピアノロールのタイムライン構築(1回あたり
 *          O(done)の全走査。メインスレッドでは長タスク=カクつきの主因だった)を
 *          Worker内で行い、完成品だけを送る(src/audio/roll-builders.js参照)。
 *          infoはフォーマット固有の副産物(KSS:sccUsed / HES:ddaChannel)。
 *   送信 {type:'rollError', message} … ロール構築の失敗(以後この曲では送らない。
 *        クライアントはメインスレッド構築へ切り替える)。キャプチャ自体は継続する。
 *
 * ★HESも汎用差分プロトコルを使わない: dpcmTrace/controlTraceが「外側は固定長6(ch数)、
 * 中身のch別イベント配列が伸びる」二重配列で、汎用差分(トップレベル/1段ネスト配列の
 * 長さ基準)では外側6要素を初回に送ったきり以後更新されない。専用ハンドラ(_runHes)で
 * snapshotsは長さ基準、トレース2本はch別の長さ基準で差分送信する。
 *
 * ★SPCだけは汎用差分プロトコルを使わない: MML.SPC2MML.captureAsyncのframeLogは
 * 「全フレーム分を空配列で事前確保してから埋めていく」ため、配列長が最初から
 * total固定で、長さ基準の差分検出が機能しない(初回に空配列の山を全送信し、以後
 * 何も送らなくなる)。完了フレーム数done基準で {start, frames:[...]} を差分送信する
 * 専用ハンドラ(_runSpc)を使う。書き込み途中の未完了フレーム(frameLog[done])は
 * まだ伸びている最中なので送らない(次のスライス境界で完成後に送られる)。
 */
(function (global) {
  const MML = global.MML;
  const Emu = MML.Emu;

  // Worker内で解析を進める1スライスの長さ(ms)。1スライスごとに進捗(progress)を1通送る。
  // ★以前は30msだったが、30msぶんのデータ(VGMで3000〜5000件)をメインスレッドが受け取って復元するのに
  //   40〜95msかかり、再生開始直後の画面の止まりと音声コールバックの遅れの原因になっていた
  //   (2026-09-13 実Chromeで計測。Worker受信のうちロール(type:roll)は1〜2msで、重いのはprogressだった)。
  //   送る総量は変えずに1通を小さくして、受信を短い処理に分ける。cancel応答性の上限でもある。
  //   8msで1通の復元が最大32ms、4msで最大20〜25msになり、ワルキューレの伝説/レイブレーサーの開始直後の長いタスク(50ms超)が消えた。
  const WORKER_SLICE_MS = 30;     // 既定(SPC/HES/KSS/GBS。受信が軽いので細かく区切る必要が無い)
  const WORKER_SLICE_MS_VGM = 4;  // VGMだけ: PCMプール系で1通の復元が重いため細かく区切る
  // setTimeout(0)の4msクランプを回避するマクロタスクyield(nsf-capture-worker-impl.jsと同じ)
  function macroYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  // onProgressペイロードを「フレーム配列(差分送信)」と「メタ(初回/最終のみ送信)」に
  // 分解する。sentは path->送信済み件数 の記録(呼び出しをまたいで保持)。
  // 'header'キーはVGMのパース済みヘッダ(ネストした静的オブジェクト)なので、
  // 中身を配列走査せず丸ごとメタ扱いにする。
  function diffPayload(payload, sent, includeMeta) {
    const arrays = {};
    const meta = includeMeta ? {} : null;
    for (const key of Object.keys(payload)) {
      const v = payload[key];
      if (Array.isArray(v)) {
        const n = sent[key] || 0;
        if (v.length > n) { arrays[key] = v.slice(n); sent[key] = v.length; }
      } else if (v && typeof v === 'object' && key !== 'header' && !ArrayBuffer.isView(v)) {
        let subMeta = null;
        for (const k2 of Object.keys(v)) {
          const v2 = v[k2];
          // プール式PCMチップの logical(合成ch)は snapshots から画面側で作り直せるので送らない
          // (roll-builders.js RollBuild.poolLogical)。c140 で progress の復元時間の約4割を占めていた
          if (k2 === 'logical' && Array.isArray(v.snapshots)) continue;
          if (Array.isArray(v2)) {
            const path = key + '.' + k2;
            const n = sent[path] || 0;
            if (v2.length > n) { arrays[path] = v2.slice(n); sent[path] = v2.length; }
          } else if (meta) {
            (subMeta = subMeta || {})[k2] = v2;
          }
        }
        // 配列しか持たないファミリでも「存在する(nullではない)」ことをメタで伝える
        if (meta) meta[key] = subMeta || {};
      } else if (meta) {
        meta[key] = v; // スカラ / null / 型付き配列
      }
    }
    return { arrays, meta };
  }

  // 各フォーマットのキャプチャ呼び出し。onProgressの引数形状の違いをここで
  // 「ペイロードオブジェクト1個」に正規化する(client側で逆変換する)。
  const FORMATS = {
    kss: (bytes, opt, onP) =>
      Emu.captureKssSongAsync(bytes, opt, (done, total, writeLog) => onP(done, total, { writeLog })),
    gbs: (bytes, opt, onP) =>
      Emu.captureGbsSongAsync(bytes, opt, (done, total, data) => onP(done, total, data)),
    vgm: (bytes, opt, onP) =>
      Emu.captureVgmSongAsync(bytes, opt, (done, total, data) => onP(done, total, data))
  };

  let cancelled = false;

  // ロール構築・送信(opt.rollが無ければ無効)。スロットルはRollBuild.makeThrottleを流用
  // (Worker内にdocumentが無いため可視性チェックは自動的に素通り=常時構築。構築は
  // メインスレッドをブロックしないので問題なく、コストに応じた間隔制御だけが効く)。
  function makeRollSender(format, msg) {
    const RollBuild = MML.RollBuild;
    if (!RollBuild || !msg.opt || !msg.opt.roll) return null;
    let params;
    if (format === 'kss') params = { frameRate: msg.opt.roll.frameRate, header: MML.KSS.parseHeader(msg.bytes) };
    else if (format === 'spc') params = { frameRate: MML.SPC2MML.FRAME_RATE, fineTune: msg.opt.roll.fineTune || null, drumKinds: msg.opt.roll.drumKinds || null };
    else params = msg.opt.roll; // gbs/hes: {frameRate} / vgm: {}
    const job = RollBuild.createRollJob(format, params);
    if (!job) return null;
    const throttle = RollBuild.makeThrottle();
    let failed = false;
    return (data, done, total) => {
      if (failed || !throttle.shouldBuild(done, total)) return;
      const t0 = performance.now();
      try {
        const r = job.build(data, done, total);
        throttle.didBuild(t0);
        global.postMessage({ type: 'roll', done, total, timeline: r.timeline, info: r.info });
      } catch (err) {
        failed = true;
        global.postMessage({ type: 'rollError', message: String((err && err.stack) || err) });
      }
    };
  }

  // SPC専用(冒頭コメント参照)。opt.durationSecondsだけを使う。
  async function _runSpc(msg) {
    const sendRoll = makeRollSender('spc', msg);
    let lastSent = 0;
    const onProgress = (done, total, frameLog) => {
      if (done <= lastSent) return;
      global.postMessage({ type: 'progress', done, total, start: lastSent, frames: frameLog.slice(lastSent, done) });
      lastSent = done;
      if (sendRoll) sendRoll({ frameLog }, done, total);
    };
    await MML.SPC2MML.captureAsync(msg.bytes, msg.opt.durationSeconds, onProgress,
      () => cancelled, { yieldFn: macroYield, sliceBudgetMs: WORKER_SLICE_MS });
    global.postMessage({ type: 'done', cancelled });
  }

  // HES専用(冒頭コメント参照)。regsOnly前提(client側でperChannelAudio等は弾く)。
  async function _runHes(msg) {
    const sendRoll = makeRollSender('hes', msg);
    let sentSnap = 0;
    const sentDpcm = [0, 0, 0, 0, 0, 0];
    const sentCtl  = [0, 0, 0, 0, 0, 0];
    let metaSent = false;
    const onProgress = (done, total, data) => {
      const chunk = {
        type: 'progress', done, total,
        snapStart: sentSnap,
        snapshots: data.snapshots.slice(sentSnap),
        dpcmTrace: [], controlTrace: []
      };
      sentSnap = data.snapshots.length;
      for (let c = 0; c < 6; c++) {
        // dpcmTraceは列ごとの型付き配列(Emu.HesTraceBuf)なので、列ごとに差分を切って送る
        chunk.dpcmTrace.push(data.dpcmTrace[c].slicePlain(sentDpcm[c]));
        sentDpcm[c] = data.dpcmTrace[c].length;
        chunk.controlTrace.push(data.controlTrace[c].slice(sentCtl[c]));
        sentCtl[c] = data.controlTrace[c].length;
      }
      if (!metaSent) { metaSent = true; chunk.frameRate = data.frameRate; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(data, done, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: WORKER_SLICE_MS
    });
    await Emu.captureHesSongAsync(msg.bytes, opt, onProgress);
    global.postMessage({ type: 'done', cancelled });
  }

  // PSF専用。msg.info = MML.PSF.load() の結果(_lib 解決はメインスレッドで済ませてから渡す)。
  // 差分: frameLog/snapshots はフレーム数、ramLog/samples は件数で切って送る。
  async function _runPsf(msg) {
    const sendRoll = makeRollSender('psf', msg);
    let sentFrames = 0, sentRam = 0, sentSamples = 0;
    let metaSent = false;
    const onProgress = (done, total, cap) => {
      const n = cap.frameLog.length;
      const chunk = {
        type: 'progress', done, total,
        frameStart: sentFrames,
        frameLog: cap.frameLog.slice(sentFrames, n),
        snapshots: cap.snapshots.slice(sentFrames, n),
        ramStart: sentRam, ramLog: cap.ramLog.slice(sentRam),
        sampleStart: sentSamples, samples: cap.samples.slice(sentSamples),
      };
      sentFrames = n; sentRam = cap.ramLog.length; sentSamples = cap.samples.length;
      if (!metaSent) { metaSent = true; chunk.meta = { frameRate: cap.frameRate, samplesPerFrame: cap.samplesPerFrame, totalFrames: cap.totalFrames }; }
      global.postMessage(chunk);
      if (sendRoll) sendRoll(cap, n, total);
    };
    const opt = Object.assign({}, msg.opt, {
      regsOnly: true,
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: WORKER_SLICE_MS
    });
    const cap = await Emu.capturePsfSongAsync(msg.info, opt, onProgress);
    global.postMessage({ type: 'done', cancelled, bios: cap.bios });
  }

  global.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { cancelled = true; return; }
    if (msg.cmd !== 'capture') return;

    if (msg.format === 'hes') {
      if (typeof Emu.captureHesSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: hes' });
        return;
      }
      cancelled = false;
      try { await _runHes(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'psf') {
      if (typeof Emu.capturePsfSongAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: psf' });
        return;
      }
      cancelled = false;
      try { await _runPsf(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    if (msg.format === 'spc') {
      if (!MML.SPC2MML || typeof MML.SPC2MML.captureAsync !== 'function') {
        global.postMessage({ type: 'error', message: 'unsupported format in this bundle: spc' });
        return;
      }
      cancelled = false;
      try { await _runSpc(msg); }
      catch (err) { global.postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
      return;
    }

    const run = FORMATS[msg.format];
    if (!run || typeof (msg.format === 'kss' ? Emu.captureKssSongAsync
                       : msg.format === 'gbs' ? Emu.captureGbsSongAsync
                       : Emu.captureVgmSongAsync) !== 'function') {
      global.postMessage({ type: 'error', message: 'unsupported format in this bundle: ' + msg.format });
      return;
    }

    cancelled = false;
    const opt = Object.assign({}, msg.opt, {
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      sliceBudgetMs: msg.format === 'vgm' ? WORKER_SLICE_MS_VGM : WORKER_SLICE_MS
    });

    // VGMだけ、送ったデータの大きさに応じて次の解析を少し待つ。PCMプール系の曲は1通の複製が重く、
    // 解析が速すぎると画面側が受信の復元で埋まって、解析が終わるまで音と描画が詰まる(2026-09-13実測、
    // ワルキューレの伝説3曲目で最初の1秒に復元650ms)。postMessage に掛かった時間(=複製の手間の目安)の
    // PACE_RATIO 倍だけ待ち、画面側の受信を時間方向に薄める。軽い曲では待ち時間はほぼ0になる
    const PACE_RATIO = msg.format === 'vgm' ? 3 : 0;
    const PACE_MAX_MS = 120;
    let paceMs = 0;
    opt.yieldFn = () => {
      if (paceMs <= 0) return macroYield();
      const ms = paceMs; paceMs = 0;
      return new Promise((resolve) => setTimeout(resolve, ms));
    };
    const sendRoll = makeRollSender(msg.format, msg);
    const sent = {};
    let metaSent = false;
    let lastPayload = null;
    const onProgress = (done, total, payload) => {
      lastPayload = payload;
      const { arrays, meta } = diffPayload(payload, sent, !metaSent);
      const chunk = { type: 'progress', done, total, arrays };
      if (!metaSent) { metaSent = true; chunk.meta = meta; }
      const tPost = performance.now();
      global.postMessage(chunk);
      if (PACE_RATIO > 0 && done < total) paceMs = Math.min(PACE_MAX_MS, (performance.now() - tPost) * PACE_RATIO);
      if (sendRoll) sendRoll(payload, done, total);
    };

    try {
      await run(msg.bytes, opt, onProgress);
      // キャプチャ完了後に追加された非配列プロパティ(VGMのnes.dpcmRom等)を最終メタで拾う
      const doneMsg = { type: 'done', cancelled };
      if (lastPayload) doneMsg.finalMeta = diffPayload(lastPayload, sent, true).meta;
      global.postMessage(doneMsg);
    } catch (err) {
      global.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  };
})(globalThis);

  };
})(window);