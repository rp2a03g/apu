/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-09-05 06:15:35
 *
 * regsOnly capture worker bundle (gbsCapture). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.gbsCapture is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.gbsCaptureBuiltAt = '2026-09-05 06:15:35';
  MML.WorkerBundles.gbsCapture = function () {
/*
 * GBS (Game Boy Sound) ヘッダ解析
 * MML.GBS
 *
 * 参考: OverClocked ReMix "GBS Format Specification"(gbsplayのGBS.txt準拠)、
 *       gbsplay(https://github.com/mmitch/gbsplay) gbs.c、
 *       Game_Music_Emu Gbs_Emu.cpp
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const GBS = MML.GBS = MML.GBS || {};

  GBS.CPU_CLOCK = 4194304; // DMG CPU/APU共通クロック(Hz)
  GBS.VBLANK_FPS = GBS.CPU_CLOCK / 70224; // ≒59.7275Hz(TAC無効時、VBlank駆動でPLAYを呼ぶ頻度)

  // TACビット1-0(クロック選択)ごとの入力クロック分周(Tステート単位、TIMAが1進むごとの周期)
  const TAC_DIVIDER = [1024, 16, 64, 256];

  function decodeAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[offset + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /**
   * GBSファイルのバイト列を解析する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  GBS.parseHeader = function (bytes) {
    if (bytes.length < 0x70) throw new Error('GBSヘッダは最低0x70バイト必要です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    const magicOk = magic === 'GBS';
    const version = bytes[3];
    const numSongs = bytes[4];
    const firstSong = bytes[5]; // 1始まり(INIT呼出時は呼び出し側で0始まりに変換する)
    const loadAddr = view.getUint16(0x06, true);
    const initAddr = view.getUint16(0x08, true);
    const playAddr = view.getUint16(0x0A, true);
    const stackPointer = view.getUint16(0x0C, true);
    const tma = bytes[0x0E];
    const tac = bytes[0x0F];
    const title = decodeAscii(bytes, 0x10, 32);
    const author = decodeAscii(bytes, 0x30, 32);
    const copyright = decodeAscii(bytes, 0x50, 32);

    // TACビット2=タイマ有効。有効ならTMA/TACから求まる周期でPLAYを呼ぶ(タイマ割込駆動)、
    // 無効ならVBlank駆動(約59.7275Hz)。実機の「どちらの割込ベクタからPLAYを呼ぶか」の
    // 判定をそのままPLAY呼び出し頻度の計算に置き換えている
    // (本エミュレータはCPU割込ディスパッチを実装せず、gbsPlayer.jsがこの頻度で
    // PLAYをサブルーチンとして直接呼び出す簡略設計。詳細はgbsPlayer.js冒頭コメント参照)。
    const timerEnabled = (tac & 0x04) !== 0;
    let playFps;
    if (timerEnabled) {
      const divider = TAC_DIVIDER[tac & 0x03];
      const framesTCycles = divider * (256 - tma);
      playFps = GBS.CPU_CLOCK / framesTCycles;
    } else {
      playFps = GBS.VBLANK_FPS;
    }

    return {
      magic, magicOk, version, numSongs, firstSong,
      loadAddr, initAddr, playAddr, stackPointer,
      tma, tac, timerEnabled, playFps,
      title, author, copyright,
      dataOffset: 0x70
    };
  };
})(globalThis);

/*
 * SM83 (LR35902 / Game Boy CPU) コア
 * MML.Emu.CPUSm83
 *
 * Z80と命令セットは似ているが別物であり、cpuZ80.js は流用できない
 * (参考: Pan Docs https://gbdev.io/pandocs/ 、
 *  NESdev BBS "Game Boy CPU isn't a Z80. What is it?" https://forums.nesdev.org/viewtopic.php?t=18335)。
 * 主な相違点:
 *   - IX/IY・裏レジスタ(BC'/DE'/HL'/AF')・ブロック命令(LDIR等)・IN/OUT・IM0-2・NMI が無い
 *   - フラグはZ/N/H/Cの4bitのみ(Z80のS・P/V・未定義X/Yビットは無い。下位4bitは常に0)
 *   - GB固有命令: LD (HL+/-),A / LD A,(HL+/-) / LDH (n),A / LDH A,(n) / LDH (C),A / LDH A,(C) /
 *     ADD SP,r8 / LD HL,SP+r8 / STOP
 *   - RLCA/RRCA/RLA/RRA はZ80と異なり常にZフラグをクリアする(CB接頭辞のRLC A等はZ80同様
 *     結果に応じてZが立つ。ここが取り違えやすい既知の相違点)
 *   - CB接頭辞のビット演算はZ80とほぼ同一だが、y=6のスロットがZ80の非公式SLLではなく
 *     正式命令SWAP(上下ニブル交換)になっている
 *   - DAAの補正アルゴリズムはZ80と異なる専用式(下記daa()参照)
 *   - RETIはRETと違い、戻った直後ではなく即座に割込を許可する(EIのような1命令遅延が無い)
 *
 * bus.read(addr)/bus.write(addr,value) のみを介してアクセスする(I/Oポートは無く、
 * 全てメモリマップド。IE($FFFF)/IF($FF0F)もこのバス経由の通常アドレスとして扱う)。
 * call(addr)/beginCall(addr)/stepCall() は cpu6502.js/cpuZ80.js と同じ設計
 * (呼び出し先アドレスをCALLし、番兵アドレスへのRETで終了を検知する)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const F_C = 0x10;
  const F_H = 0x20;
  const F_N = 0x40;
  const F_Z = 0x80;

  // CALL終了検知用の番兵リターンアドレス(cpuZ80.js/cpu6502.jsと同じ手法)
  const CALL_SENTINEL = 0xFFFF;

  class CPUSm83 {
    /**
     * @param {{read:(addr:number)=>number, write:(addr:number,value:number)=>void}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.a = 0; this.f = 0;
      this.b = 0; this.c = 0;
      this.d = 0; this.e = 0;
      this.h = 0; this.l = 0;
      this.sp = 0xFFFF;
      this.pc = 0;
      this.ime = false;
      this.imePending = 0; // EI発行後の遅延カウンタ(2で発行、0でime=true確定)
      this.halted = false;
      this.stopped = false;
      this.callActive = false;
    }

    // --- メモリアクセス ---
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }

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

    // --- フラグ(下位4bitは常に0) ---
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
    setAF(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xF0; } // Fの下位4bitは実機同様常に0

    // 8bitレジスタコード(0=B,1=C,2=D,3=E,4=H,5=L,6=(HL),7=A)。Z80と同じ並び。
    getR8(code) {
      switch (code) {
        case 0: return this.b;
        case 1: return this.c;
        case 2: return this.d;
        case 3: return this.e;
        case 4: return this.h;
        case 5: return this.l;
        case 6: return this.read(this.getHL());
        case 7: return this.a;
      }
    }
    setR8(code, value) {
      value &= 0xFF;
      switch (code) {
        case 0: this.b = value; break;
        case 1: this.c = value; break;
        case 2: this.d = value; break;
        case 3: this.e = value; break;
        case 4: this.h = value; break;
        case 5: this.l = value; break;
        case 6: this.write(this.getHL(), value); break;
        case 7: this.a = value; break;
      }
    }

    // --- 8bit ALU ---
    add8(value, carryIn) {
      const a = this.a;
      const sum = a + value + carryIn;
      const result = sum & 0xFF;
      this.setFlag(F_H, ((a & 0xF) + (value & 0xF) + carryIn) > 0xF);
      this.setFlag(F_C, sum > 0xFF);
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      this.a = result;
    }
    sub8(value, carryIn, storeResult) {
      const a = this.a;
      const diff = a - value - carryIn;
      const result = diff & 0xFF;
      this.setFlag(F_H, ((a & 0xF) - (value & 0xF) - carryIn) < 0);
      this.setFlag(F_C, diff < 0);
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0);
      if (storeResult) this.a = result;
    }
    and8(value) {
      this.a &= value;
      this.setFlag(F_H, true); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, this.a === 0);
    }
    or8(value) {
      this.a |= value;
      this.setFlag(F_H, false); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, this.a === 0);
    }
    xor8(value) {
      this.a ^= value;
      this.setFlag(F_H, false); this.setFlag(F_C, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, this.a === 0);
    }
    inc8(v) {
      const result = (v + 1) & 0xFF;
      this.setFlag(F_H, (v & 0xF) === 0xF);
      this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      return result;
    }
    dec8(v) {
      const result = (v - 1) & 0xFF;
      this.setFlag(F_H, (v & 0xF) === 0x0);
      this.setFlag(F_N, true);
      this.setFlag(F_Z, result === 0);
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

    // --- 16bit ---
    addHL(rpVal) {
      const hl = this.getHL();
      const sum = hl + rpVal;
      const result = sum & 0xFFFF;
      this.setFlag(F_H, ((hl & 0xFFF) + (rpVal & 0xFFF)) > 0xFFF);
      this.setFlag(F_C, sum > 0xFFFF);
      this.setFlag(F_N, false);
      this.setHL(result); // Zは変化しない(実機仕様)
    }
    // ADD SP,r8 と LD HL,SP+r8 で共用。r8をフェッチし、フラグはSPの下位バイト+符号無し
    // 表現の加算で計算する(実機の既知仕様。符号拡張した実際の加算結果とは別に判定する)。
    addSpR8() {
      const r8 = this.fetchSigned();
      const raw = r8 & 0xFF;
      const result = (this.sp + r8) & 0xFFFF;
      this.setFlag(F_H, ((this.sp & 0xF) + (raw & 0xF)) > 0xF);
      this.setFlag(F_C, ((this.sp & 0xFF) + raw) > 0xFF);
      this.setFlag(F_Z, false);
      this.setFlag(F_N, false);
      return result;
    }

    // RLCA/RRCA/RLA/RRA: CB接頭辞版と異なり常にZをクリアする(GB固有、取り違え注意)
    rlca() { const c = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }
    rrca() { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }
    rla() { const c = (this.a >> 7) & 1; const oldC = this.getFlag(F_C) ? 1 : 0; this.a = ((this.a << 1) | oldC) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }
    rra() { const c = this.a & 1; const oldC = this.getFlag(F_C) ? 0x80 : 0; this.a = ((this.a >> 1) | oldC) & 0xFF; this.setFlag(F_C, c !== 0); this.setFlag(F_H, false); this.setFlag(F_N, false); this.setFlag(F_Z, false); }

    // GB固有のDAA補正式(Z80とは別物。Pan Docs "DAA" 参照)
    daa() {
      let a = this.a;
      let corr = 0;
      let setC = false;
      const n = this.getFlag(F_N), c = this.getFlag(F_C), h = this.getFlag(F_H);
      if (!n) {
        if (h || (a & 0x0F) > 0x09) corr |= 0x06;
        if (c || a > 0x99) { corr |= 0x60; setC = true; }
        a = (a + corr) & 0xFF;
      } else {
        if (h) corr |= 0x06;
        if (c) corr |= 0x60;
        a = (a - corr) & 0xFF;
        setC = c;
      }
      this.a = a;
      this.setFlag(F_C, setC);
      this.setFlag(F_H, false);
      this.setFlag(F_Z, a === 0);
    }

    // --- CB接頭辞の回転/シフト共通処理。y=6はZ80の非公式SLLではなく正式命令SWAP ---
    rotOp(y, v) {
      let carry, result;
      switch (y) {
        case 0: carry = (v >> 7) & 1; result = ((v << 1) | carry) & 0xFF; break; // RLC
        case 1: carry = v & 1; result = ((v >> 1) | (carry << 7)) & 0xFF; break; // RRC
        case 2: carry = (v >> 7) & 1; result = ((v << 1) | (this.getFlag(F_C) ? 1 : 0)) & 0xFF; break; // RL
        case 3: carry = v & 1; result = ((v >> 1) | (this.getFlag(F_C) ? 0x80 : 0)) & 0xFF; break; // RR
        case 4: carry = (v >> 7) & 1; result = (v << 1) & 0xFF; break; // SLA
        case 5: carry = v & 1; result = ((v >> 1) | (v & 0x80)) & 0xFF; break; // SRA
        case 6: carry = 0; result = (((v & 0x0F) << 4) | ((v & 0xF0) >> 4)) & 0xFF; break; // SWAP
        case 7: carry = v & 1; result = (v >> 1) & 0xFF; break; // SRL
      }
      this.setFlag(F_C, carry !== 0);
      this.setFlag(F_H, false); this.setFlag(F_N, false);
      this.setFlag(F_Z, result === 0);
      return result;
    }

    // --- メイン実行ループ ---
    step() {
      // EI発行から1命令分遅延させてimeを立てる(EI自身の命令実行中はまだ有効化しない)。
      // RETIはこの経路を通さず即座にthis.ime=trueにする(GB固有、Pan Docs "Interrupts"参照)。
      if (this.imePending > 0) {
        this.imePending--;
        if (this.imePending === 0) this.ime = true;
      }
      const opcode = this.fetchByte();
      if (opcode === 0xCB) return this.execCB();
      return this.execMain(opcode);
    }

    execMain(opcode) {
      switch (opcode) {
        case 0x00: return 4; // NOP
        case 0x01: this.setBC(this.fetch16()); return 12;
        case 0x02: this.write(this.getBC(), this.a); return 8;
        case 0x03: this.setBC((this.getBC() + 1) & 0xFFFF); return 8;
        case 0x04: this.b = this.inc8(this.b); return 4;
        case 0x05: this.b = this.dec8(this.b); return 4;
        case 0x06: this.b = this.fetchByte(); return 8;
        case 0x07: this.rlca(); return 4;
        case 0x08: { const nn = this.fetch16(); this.write(nn, this.sp & 0xFF); this.write((nn + 1) & 0xFFFF, (this.sp >> 8) & 0xFF); return 20; }
        case 0x09: this.addHL(this.getBC()); return 8;
        case 0x0A: this.a = this.read(this.getBC()); return 8;
        case 0x0B: this.setBC((this.getBC() - 1) & 0xFFFF); return 8;
        case 0x0C: this.c = this.inc8(this.c); return 4;
        case 0x0D: this.c = this.dec8(this.c); return 4;
        case 0x0E: this.c = this.fetchByte(); return 8;
        case 0x0F: this.rrca(); return 4;

        // STOP 0: SingleStepTests実測では2バイト目を実際には読まず(bus読出し無しの内部
        // サイクルのみ)、PCは1しか進まないが所要時間は3Mサイクル(12T)。
        case 0x10: this.stopped = true; return 12;
        case 0x11: this.setDE(this.fetch16()); return 12;
        case 0x12: this.write(this.getDE(), this.a); return 8;
        case 0x13: this.setDE((this.getDE() + 1) & 0xFFFF); return 8;
        case 0x14: this.d = this.inc8(this.d); return 4;
        case 0x15: this.d = this.dec8(this.d); return 4;
        case 0x16: this.d = this.fetchByte(); return 8;
        case 0x17: this.rla(); return 4;
        case 0x18: { const d = this.fetchSigned(); this.pc = (this.pc + d) & 0xFFFF; return 12; }
        case 0x19: this.addHL(this.getDE()); return 8;
        case 0x1A: this.a = this.read(this.getDE()); return 8;
        case 0x1B: this.setDE((this.getDE() - 1) & 0xFFFF); return 8;
        case 0x1C: this.e = this.inc8(this.e); return 4;
        case 0x1D: this.e = this.dec8(this.e); return 4;
        case 0x1E: this.e = this.fetchByte(); return 8;
        case 0x1F: this.rra(); return 4;

        case 0x20: { const d = this.fetchSigned(); if (!this.getFlag(F_Z)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x21: this.setHL(this.fetch16()); return 12;
        case 0x22: this.write(this.getHL(), this.a); this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x23: this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x24: this.h = this.inc8(this.h); return 4;
        case 0x25: this.h = this.dec8(this.h); return 4;
        case 0x26: this.h = this.fetchByte(); return 8;
        case 0x27: this.daa(); return 4;
        case 0x28: { const d = this.fetchSigned(); if (this.getFlag(F_Z)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x29: this.addHL(this.getHL()); return 8;
        case 0x2A: this.a = this.read(this.getHL()); this.setHL((this.getHL() + 1) & 0xFFFF); return 8;
        case 0x2B: this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x2C: this.l = this.inc8(this.l); return 4;
        case 0x2D: this.l = this.dec8(this.l); return 4;
        case 0x2E: this.l = this.fetchByte(); return 8;
        case 0x2F: this.a = (~this.a) & 0xFF; this.setFlag(F_N, true); this.setFlag(F_H, true); return 4; // CPL

        case 0x30: { const d = this.fetchSigned(); if (!this.getFlag(F_C)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x31: this.sp = this.fetch16(); return 12;
        case 0x32: this.write(this.getHL(), this.a); this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x33: this.sp = (this.sp + 1) & 0xFFFF; return 8;
        case 0x34: { const hl = this.getHL(); this.write(hl, this.inc8(this.read(hl))); return 12; }
        case 0x35: { const hl = this.getHL(); this.write(hl, this.dec8(this.read(hl))); return 12; }
        case 0x36: this.write(this.getHL(), this.fetchByte()); return 12;
        case 0x37: this.setFlag(F_C, true); this.setFlag(F_N, false); this.setFlag(F_H, false); return 4; // SCF
        case 0x38: { const d = this.fetchSigned(); if (this.getFlag(F_C)) { this.pc = (this.pc + d) & 0xFFFF; return 12; } return 8; }
        case 0x39: this.addHL(this.sp); return 8;
        case 0x3A: this.a = this.read(this.getHL()); this.setHL((this.getHL() - 1) & 0xFFFF); return 8;
        case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; return 8;
        case 0x3C: this.a = this.inc8(this.a); return 4;
        case 0x3D: this.a = this.dec8(this.a); return 4;
        case 0x3E: this.a = this.fetchByte(); return 8;
        case 0x3F: { const c = this.getFlag(F_C); this.setFlag(F_C, !c); this.setFlag(F_N, false); this.setFlag(F_H, false); return 4; } // CCF
      }

      if (opcode >= 0x40 && opcode <= 0x7F) {
        if (opcode === 0x76) { this.halted = true; return 12; } // HALT(SingleStepTests実測で3Mサイクル=12T)
        const y = (opcode >> 3) & 7, z = opcode & 7;
        this.setR8(y, this.getR8(z));
        return (y === 6 || z === 6) ? 8 : 4;
      }

      if (opcode >= 0x80 && opcode <= 0xBF) {
        const y = (opcode >> 3) & 7, z = opcode & 7;
        this.aluOp(y, this.getR8(z));
        return z === 6 ? 8 : 4;
      }

      switch (opcode) {
        case 0xC0: if (!this.getFlag(F_Z)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xC1: this.setBC(this.pop16()); return 12;
        case 0xC2: { const nn = this.fetch16(); if (!this.getFlag(F_Z)) { this.pc = nn; return 16; } return 12; }
        case 0xC3: this.pc = this.fetch16(); return 16;
        case 0xC4: { const nn = this.fetch16(); if (!this.getFlag(F_Z)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xC5: this.push16(this.getBC()); return 16;
        case 0xC6: this.add8(this.fetchByte(), 0); return 8;
        case 0xC7: this.push16(this.pc); this.pc = 0x00; return 16;
        case 0xC8: if (this.getFlag(F_Z)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xC9: this.pc = this.pop16(); return 16;
        case 0xCA: { const nn = this.fetch16(); if (this.getFlag(F_Z)) { this.pc = nn; return 16; } return 12; }
        case 0xCC: { const nn = this.fetch16(); if (this.getFlag(F_Z)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xCD: { const nn = this.fetch16(); this.push16(this.pc); this.pc = nn; return 24; }
        case 0xCE: this.add8(this.fetchByte(), this.getFlag(F_C) ? 1 : 0); return 8;
        case 0xCF: this.push16(this.pc); this.pc = 0x08; return 16;

        case 0xD0: if (!this.getFlag(F_C)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xD1: this.setDE(this.pop16()); return 12;
        case 0xD2: { const nn = this.fetch16(); if (!this.getFlag(F_C)) { this.pc = nn; return 16; } return 12; }
        case 0xD4: { const nn = this.fetch16(); if (!this.getFlag(F_C)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xD5: this.push16(this.getDE()); return 16;
        case 0xD6: this.sub8(this.fetchByte(), 0, true); return 8;
        case 0xD7: this.push16(this.pc); this.pc = 0x10; return 16;
        case 0xD8: if (this.getFlag(F_C)) { this.pc = this.pop16(); return 20; } return 8;
        case 0xD9: this.pc = this.pop16(); this.ime = true; this.imePending = 0; return 16; // RETI(EIと違い即時)
        case 0xDA: { const nn = this.fetch16(); if (this.getFlag(F_C)) { this.pc = nn; return 16; } return 12; }
        case 0xDC: { const nn = this.fetch16(); if (this.getFlag(F_C)) { this.push16(this.pc); this.pc = nn; return 24; } return 12; }
        case 0xDE: this.sub8(this.fetchByte(), this.getFlag(F_C) ? 1 : 0, true); return 8;
        case 0xDF: this.push16(this.pc); this.pc = 0x18; return 16;

        case 0xE0: { const n = this.fetchByte(); this.write(0xFF00 + n, this.a); return 12; } // LDH (n),A
        case 0xE1: this.setHL(this.pop16()); return 12;
        case 0xE2: this.write(0xFF00 + this.c, this.a); return 8; // LDH (C),A
        case 0xE5: this.push16(this.getHL()); return 16;
        case 0xE6: this.and8(this.fetchByte()); return 8;
        case 0xE7: this.push16(this.pc); this.pc = 0x20; return 16;
        case 0xE8: this.sp = this.addSpR8(); return 16;
        case 0xE9: this.pc = this.getHL(); return 4; // JP HL(間接読出しではなくPC=HL)
        case 0xEA: { const nn = this.fetch16(); this.write(nn, this.a); return 16; }
        case 0xEE: this.xor8(this.fetchByte()); return 8;
        case 0xEF: this.push16(this.pc); this.pc = 0x28; return 16;

        case 0xF0: { const n = this.fetchByte(); this.a = this.read(0xFF00 + n); return 12; } // LDH A,(n)
        case 0xF1: this.setAF(this.pop16()); return 12;
        case 0xF2: this.a = this.read(0xFF00 + this.c); return 8; // LDH A,(C)
        case 0xF3: this.ime = false; this.imePending = 0; return 4; // DI
        case 0xF5: this.push16(this.getAF()); return 16;
        case 0xF6: this.or8(this.fetchByte()); return 8;
        case 0xF7: this.push16(this.pc); this.pc = 0x30; return 16;
        case 0xF8: this.setHL(this.addSpR8()); return 12;
        case 0xF9: this.sp = this.getHL(); return 8;
        case 0xFA: { const nn = this.fetch16(); this.a = this.read(nn); return 16; }
        case 0xFB: this.imePending = 2; return 4; // EI(1命令分遅延して有効化)
        case 0xFE: this.sub8(this.fetchByte(), 0, false); return 8;
        case 0xFF: this.push16(this.pc); this.pc = 0x38; return 16;
      }
      // 未定義オペコード(D3/DB/DD/E3/E4/EB/EC/ED/F4/FC/FD): 実機はCPU停止(フリーズ)するが、
      // GBSの曲データがこれらを使うことは無い想定のためNOP相当として扱い暴走を防ぐ
      return 4;
    }

    execCB() {
      const opcode = this.fetchByte();
      const x = (opcode >> 6) & 3, y = (opcode >> 3) & 7, z = opcode & 7;
      const hasMem = z === 6;
      const v = this.getR8(z);
      if (x === 1) { // BIT b,r
        const bit = (v >> y) & 1;
        this.setFlag(F_Z, bit === 0);
        this.setFlag(F_N, false);
        this.setFlag(F_H, true);
        return hasMem ? 12 : 8;
      }
      let result;
      if (x === 0) result = this.rotOp(y, v);
      else if (x === 2) result = v & ~(1 << y); // RES
      else result = v | (1 << y); // SET
      this.setR8(z, result);
      return hasMem ? 16 : 8;
    }

    /**
     * addr のサブルーチンを呼び出し、RET で戻るまで実行する(GBSのINIT/PLAY呼び出しに使用)
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

  Emu.CPUSm83 = CPUSm83;
  Emu.SM83_FLAGS = { C: F_C, H: F_H, N: F_N, Z: F_Z };
})(globalThis);

/*
 * Game Boy (DMG) 内蔵音源エミュレータ
 * MML.Emu.APUGb
 *
 * CH1(パルス+周波数スイープ), CH2(パルス), CH3(波形メモリ32サンプル×4bit),
 * CH4(ノイズ) の4チャンネルを実装。レジスタは $FF10-$FF26(NR10-NR52) + $FF30-$FF3F(波形RAM)。
 * clock() を1 Tステート(CPUクロック4194304Hz)ごとに呼び出す設計
 * (gbsPlayer.jsがCPUの消費サイクル数だけ呼ぶ想定。apu2a03.jsのclock()と同じ考え方)。
 *
 * 参考: Pan Docs "Audio Details" https://gbdev.io/pandocs/Audio_details.html
 *       gbdev.gg8.se wiki "Gameboy sound hardware"
 *
 * ★CH3(波形メモリ)は32サンプル×4bit・音量はグローバル4段階シフトのみで、
 *   FDSのような変調機能もN163のような可変長波形も無い(GB実機の素の仕様どおり実装する)。
 *   このCH3をgbs2mml変換でN163に借用する話(MML出力側の話)とは別問題。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
    [1, 0, 0, 0, 0, 0, 0, 1], // 25%
    [1, 0, 0, 0, 0, 1, 1, 1], // 50%
    [0, 1, 1, 1, 1, 1, 1, 0]  // 75%
  ];

  // ノイズの分周値テーブル(Pan Docs記載の8値)。周期(Tステート) = 16 * NOISE_DIVISOR[r] * 2^shift
  // (f = 524288 / divisor / 2^(shift+1) Hz、CPUクロック4194304Hz = 524288*8 から導出)
  const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];

  // $FF10オフセット基準の「読み出し不能ビットは1で返す」ORマスク(Pan Docs準拠)
  const READ_OR_MASK = {
    0x00: 0x80, 0x01: 0x3F, 0x02: 0x00, 0x03: 0xFF, 0x04: 0xBF,
    0x06: 0x3F, 0x07: 0x00, 0x08: 0xFF, 0x09: 0xBF,
    0x0A: 0x7F, 0x0B: 0xFF, 0x0C: 0x9F, 0x0D: 0xFF, 0x0E: 0xBF,
    0x10: 0xFF, 0x11: 0x00, 0x12: 0x00, 0x13: 0xBF
  };

  // CH1(スイープ有)/CH2(スイープ無)共用の音量エンベロープ(NRx2)
  class Envelope {
    constructor() {
      this.initialVolume = 0;
      this.direction = 0; // 0=減衰,1=増加
      this.period = 0;
      this.volume = 0;
      this.timer = 0;
    }
    write(value) {
      this.initialVolume = (value >> 4) & 0x0F;
      this.direction = (value & 0x08) ? 1 : 0;
      this.period = value & 0x07;
    }
    dacOn() { return this.initialVolume !== 0 || this.direction !== 0; } // NRx2上位5bitが非0
    trigger() {
      this.volume = this.initialVolume;
      this.timer = this.period === 0 ? 8 : this.period;
    }
    clock() {
      if (this.period === 0) return; // period=0はエンベロープ無効(実機仕様)
      if (this.timer > 0) this.timer--;
      if (this.timer === 0) {
        this.timer = this.period;
        if (this.direction === 1 && this.volume < 15) this.volume++;
        else if (this.direction === 0 && this.volume > 0) this.volume--;
      }
    }
  }

  class PulseChannel {
    constructor(hasSweep) {
      this.hasSweep = !!hasSweep;
      this.enabled = false;
      this.duty = 2;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0; // 11bit
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ(CH1のみ意味を持つ)
      this.sweepPeriod = 0;
      this.sweepDirection = 0; // 0=増加,1=減少
      this.sweepShift = 0;
      this.sweepTimer = 0;
      this.sweepEnabled = false;
      this.shadowFreq = 0;
      // トリガ(音符アタック)のたびに増える通し番号。gbs2mmlのキャプチャがwriteLog
      // replayなしで「このフレームでアタックがあったか」を判定するのに使う
      // (nsf2mml/converter.jsのt.attack[chKey]に相当。GBは実際のトリガbitを持つため
      // ay.js/scc.jsの音量上昇ヒューリスティックより確実に判定できる)。
      this.triggerSeq = 0;
    }

    writeNRx0(value) { // NR10(CH1のみ)
      this.sweepPeriod = (value >> 4) & 0x07;
      this.sweepDirection = (value & 0x08) ? 1 : 0;
      this.sweepShift = value & 0x07;
    }
    writeNRx1(value) { // NR11/NR21
      this.duty = (value >> 6) & 0x03;
      this.lengthCounter = 64 - (value & 0x3F);
    }
    writeNRx2(value) { // NR12/NR22
      this.envelope.write(value);
      if (!this.envelope.dacOn()) this.enabled = false;
    }
    writeNRx3(value) { // NR13/NR23
      this.freq = (this.freq & 0x700) | value;
    }
    writeNRx4(value) { // NR14/NR24
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      this.lengthEnabled = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }

    trigger() {
      this.triggerSeq++;
      if (this.envelope.dacOn()) this.enabled = true;
      if (this.lengthCounter === 0) this.lengthCounter = 64;
      this.timer = (2048 - this.freq) * 4;
      this.dutyStep = 0;
      this.envelope.trigger();
      if (this.hasSweep) {
        this.shadowFreq = this.freq;
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
        if (this.sweepShift !== 0) this.sweepCalc(); // トリガ時の即時オーバーフロー確認(実機仕様)
      }
    }

    // シャドウ周波数からスイープ後の値を計算し、オーバーフローならチャンネルを止める
    sweepCalc() {
      const delta = this.shadowFreq >> this.sweepShift;
      const newFreq = this.sweepDirection === 1 ? (this.shadowFreq - delta) : (this.shadowFreq + delta);
      if (newFreq > 0x7FF) this.enabled = false;
      return newFreq;
    }

    clockSweep() {
      if (!this.hasSweep || !this.sweepEnabled) return;
      if (this.sweepTimer > 0) this.sweepTimer--;
      if (this.sweepTimer === 0) {
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        if (this.sweepPeriod !== 0) {
          const newFreq = this.sweepCalc();
          if (newFreq <= 0x7FF && this.sweepShift !== 0) {
            this.shadowFreq = newFreq;
            this.freq = newFreq;
            this.sweepCalc(); // 反映後の2度目のオーバーフロー確認(実機仕様)
          }
        }
      }
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0) {
        this.lengthCounter--;
        if (this.lengthCounter === 0) this.enabled = false;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = (2048 - this.freq) * 4;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }

    output() {
      // lengthCounter===0自体はここでは見ない。実機はlengthEnabled時のみカウントダウンし、
      // 0到達時にclockLength()がenabledをfalseにする(このifは実質lengthEnabled=falseなら
      // 常に無評価)。ここでも重ねてlengthCounterを見ると、GbsReplayStreamPlayerのように
      // trigger()/clockLength()のライフサイクルを経由せずenabledだけをスナップショットから
      // 直接書き戻す再生経路で、初期値0のままのlengthCounterに引っかかり常時無音化する
      // バグになっていた(ユーザー報告: パルス/ノイズが鳴らずwaveのみ鳴る)。
      if (!this.enabled) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.envelope.volume;
    }
  }

  class WaveChannel {
    constructor() {
      this.enabled = false;
      this.dacOn = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.freq = 0;
      this.timer = 0;
      this.volumeShift = 0; // 0=ミュート,1=100%,2=50%(>>1),3=25%(>>2)
      // 展開済み4bitサンプル(0-15)。実機は電源投入時に波形RAMへ$00,$FF,$00,$FF...という
      // 固定パターンが入っている(DMG A-C/MGB/CGB共通、DMG0のみ別パターンだが極めて稀な
      // 初期リビジョンのため無視)。波形RAMを一度も書き込まず初期状態のまま再生する曲が
      // 実在する(例: R-Type/Irem)ため、全0初期化だと実機と異なり無音になってしまう。
      // ニブル展開すると[0,0,15,15]の4個パターンが8回繰り返す形になる。
      this.wave = new Uint8Array([0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15, 0,0,15,15]);
      this.samplePos = 0;
      this.triggerSeq = 0; // PulseChannelと同じ用途(gbs2mml向け)
    }

    writeNR30(value) {
      this.dacOn = (value & 0x80) !== 0;
      if (!this.dacOn) this.enabled = false;
    }
    writeNR31(value) { this.lengthCounter = 256 - value; }
    writeNR32(value) { this.volumeShift = (value >> 5) & 0x03; }
    writeNR33(value) { this.freq = (this.freq & 0x700) | value; }
    writeNR34(value) {
      this.freq = (this.freq & 0xFF) | ((value & 0x07) << 8);
      this.lengthEnabled = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }
    // $FF30-$FF3F: 1byte=2サンプル(上位ニブル=先, 下位ニブル=後)
    writeWaveRam(offset, value) {
      this.wave[offset * 2] = (value >> 4) & 0x0F;
      this.wave[offset * 2 + 1] = value & 0x0F;
    }
    readWaveRam(offset) {
      return (this.wave[offset * 2] << 4) | this.wave[offset * 2 + 1];
    }

    trigger() {
      this.triggerSeq++;
      if (this.dacOn) this.enabled = true;
      if (this.lengthCounter === 0) this.lengthCounter = 256;
      this.timer = (2048 - this.freq) * 2;
      this.samplePos = 0;
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0) {
        this.lengthCounter--;
        if (this.lengthCounter === 0) this.enabled = false;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = (2048 - this.freq) * 2;
        this.samplePos = (this.samplePos + 1) & 31;
      } else {
        this.timer--;
      }
    }

    output() {
      if (!this.enabled || !this.dacOn || this.volumeShift === 0) return 0;
      return this.wave[this.samplePos] >> (this.volumeShift - 1);
    }
  }

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounter = 0;
      this.lengthEnabled = false;
      this.envelope = new Envelope();
      this.clockShift = 0;
      this.widthMode = 0; // 0=15bit, 1=7bit
      this.divisorCode = 0;
      this.timer = 0;
      this.lfsr = 0x7FFF;
      // PulseChannel/WaveChannelと同じ用途(gbs2mml向けトリガ検出、apuGb.js冒頭コメント参照)。
      // ★これが未初期化(undefined)のままだとtrigger()の`this.triggerSeq++`が
      // undefined+1=NaNを生み、以後ずっとNaNのまま(NaN+1もNaN)。NaNはNaN自身とも
      // !==で「不一致」判定されるため、抽出側のtriggerSeq変化検出が「毎フレーム
      // トリガーされた」と誤判定し、休符が1フレームずつバラバラに分断されて
      // MML再生時のノイズ(ドラム)パートの発音位置が実機と大きくズレる原因になっていた。
      this.triggerSeq = 0;
    }

    writeNR41(value) { this.lengthCounter = 64 - (value & 0x3F); }
    writeNR42(value) {
      this.envelope.write(value);
      if (!this.envelope.dacOn()) this.enabled = false;
    }
    writeNR43(value) {
      this.clockShift = (value >> 4) & 0x0F;
      this.widthMode = (value & 0x08) ? 1 : 0;
      this.divisorCode = value & 0x07;
    }
    writeNR44(value) {
      this.lengthEnabled = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }

    periodT() { return 16 * NOISE_DIVISOR[this.divisorCode] * (1 << this.clockShift); }

    trigger() {
      this.triggerSeq++;
      if (this.envelope.dacOn()) this.enabled = true;
      if (this.lengthCounter === 0) this.lengthCounter = 64;
      this.timer = this.periodT();
      this.lfsr = 0x7FFF;
      this.envelope.trigger();
    }

    clockLength() {
      if (this.lengthEnabled && this.lengthCounter > 0) {
        this.lengthCounter--;
        if (this.lengthCounter === 0) this.enabled = false;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.periodT();
        const bit = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
        this.lfsr = (this.lfsr >> 1) | (bit << 14);
        if (this.widthMode) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
      } else {
        this.timer--;
      }
    }

    output() {
      // lengthCounter===0自体はここでは見ない。実機はlengthEnabled時のみカウントダウンし、
      // 0到達時にclockLength()がenabledをfalseにする(このifは実質lengthEnabled=falseなら
      // 常に無評価)。ここでも重ねてlengthCounterを見ると、GbsReplayStreamPlayerのように
      // trigger()/clockLength()のライフサイクルを経由せずenabledだけをスナップショットから
      // 直接書き戻す再生経路で、初期値0のままのlengthCounterに引っかかり常時無音化する
      // バグになっていた(ユーザー報告: パルス/ノイズが鳴らずwaveのみ鳴る)。
      if (!this.enabled) return 0;
      return (this.lfsr & 1) === 0 ? this.envelope.volume : 0; // LFSR bit0=0で"高い"(実機の反転規約)
    }
  }

  class APUGb {
    constructor() {
      this.ch1 = new PulseChannel(true);
      this.ch2 = new PulseChannel(false);
      this.ch3 = new WaveChannel();
      this.ch4 = new NoiseChannel();
      this.powerOn = true;
      // NR50/NR51は実機ブートROMがINIT実行前に書き込む post-boot 値で初期化する
      // (Pan Docs "Power Up Sequence"参照)。GBSプレイヤーはブートROM自体を実行せず
      // 直接INITを呼ぶため、多くの市販曲のようにNR50/NR51をINITが明示的に書き換えない
      // 曲では、ここが0のままだと(実機なら$77で鳴る所を)不自然に無音/小音量になる。
      this.nr50 = 0x77; // VIN無効、L/R音量とも最大(7)
      this.nr51 = 0xF3; // CH1-4→L全ON、CH1/2→R ON、CH3/4→R OFF(ブートチャイム由来の値そのまま)
      this.frameSeqStep = 0;
      this.frameSeqCounter = 0;
      this.regRaw = new Uint8Array(0x17); // $FF10-$FF26分(オフセット0=$FF10)
      this.mute = { ch1: false, ch2: false, ch3: false, ch4: false };
      this.vol = { ch1: 1, ch2: 1, ch3: 1, ch4: 1 };
    }

    reset() {
      this.ch1 = new PulseChannel(true);
      this.ch2 = new PulseChannel(false);
      this.ch3 = new WaveChannel();
      this.ch4 = new NoiseChannel();
      this.powerOn = true;
      this.nr50 = 0x77;
      this.nr51 = 0xF3;
      this.frameSeqStep = 0;
      this.frameSeqCounter = 0;
      this.regRaw.fill(0);
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0xFF30 && addr <= 0xFF3F) { this.ch3.writeWaveRam(addr - 0xFF30, value); return; }
      if (addr < 0xFF10 || addr > 0xFF26) return;
      this.regRaw[addr - 0xFF10] = value;
      switch (addr) {
        case 0xFF10: this.ch1.writeNRx0(value); break;
        case 0xFF11: this.ch1.writeNRx1(value); break;
        case 0xFF12: this.ch1.writeNRx2(value); break;
        case 0xFF13: this.ch1.writeNRx3(value); break;
        case 0xFF14: this.ch1.writeNRx4(value); break;
        case 0xFF16: this.ch2.writeNRx1(value); break;
        case 0xFF17: this.ch2.writeNRx2(value); break;
        case 0xFF18: this.ch2.writeNRx3(value); break;
        case 0xFF19: this.ch2.writeNRx4(value); break;
        case 0xFF1A: this.ch3.writeNR30(value); break;
        case 0xFF1B: this.ch3.writeNR31(value); break;
        case 0xFF1C: this.ch3.writeNR32(value); break;
        case 0xFF1D: this.ch3.writeNR33(value); break;
        case 0xFF1E: this.ch3.writeNR34(value); break;
        case 0xFF20: this.ch4.writeNR41(value); break;
        case 0xFF21: this.ch4.writeNR42(value); break;
        case 0xFF22: this.ch4.writeNR43(value); break;
        case 0xFF23: this.ch4.writeNR44(value); break;
        case 0xFF24: this.nr50 = value; break;
        case 0xFF25: this.nr51 = value; break;
        case 0xFF26:
          this.powerOn = (value & 0x80) !== 0;
          if (!this.powerOn) {
            this.ch1.enabled = false; this.ch2.enabled = false;
            this.ch3.enabled = false; this.ch4.enabled = false;
          }
          break;
      }
    }

    readRegister(addr) {
      if (addr >= 0xFF30 && addr <= 0xFF3F) return this.ch3.readWaveRam(addr - 0xFF30);
      if (addr < 0xFF10 || addr > 0xFF26) return 0xFF;
      if (addr === 0xFF26) {
        let v = this.powerOn ? 0x80 : 0x00;
        if (this.ch1.enabled) v |= 0x01;
        if (this.ch2.enabled) v |= 0x02;
        if (this.ch3.enabled) v |= 0x04;
        if (this.ch4.enabled) v |= 0x08;
        return v | 0x70;
      }
      const off = addr - 0xFF10;
      return this.regRaw[off] | (READ_OR_MASK[off] || 0);
    }

    clockLength() { this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength(); }
    clockSweep() { this.ch1.clockSweep(); }
    clockEnvelope() { this.ch1.envelope.clock(); this.ch2.envelope.clock(); this.ch4.envelope.clock(); }

    // 1 Tステート(4194304Hz)分進める
    clock() {
      this.ch1.clockTimer();
      this.ch2.clockTimer();
      this.ch3.clockTimer();
      this.ch4.clockTimer();

      // フレームシーケンサ: 512Hz(8192Tステートごと)の8ステップ。
      // step 0/2/4/6=長さカウンタ(256Hz)、2/6=スイープ(128Hz)、7=エンベロープ(64Hz)。
      this.frameSeqCounter++;
      if (this.frameSeqCounter >= 8192) {
        this.frameSeqCounter -= 8192;
        this.frameSeqStep = (this.frameSeqStep + 1) & 7;
        switch (this.frameSeqStep) {
          case 0: case 4: this.clockLength(); break;
          case 2: case 6: this.clockLength(); this.clockSweep(); break;
          case 7: this.clockEnvelope(); break;
        }
      }
    }

    /**
     * 現在の出力レベルを {left, right} で取得する(各-1.0〜1.0程度)。
     * GBのDACはNESの非線形ミキサーと異なりほぼ線形。NR51(パンニング)で各chをL/Rバスへ
     * 振り分け、NR50(マスター音量、0-7を実機同様+1して1-8倍のスケール)をバス毎に掛ける。
     * どちらのバスにも振られていないch(パン両ビット0)はここで正しく無音になる。
     * ★旧実装は最後にL/Rバスを平均してモノラル化していた(/2)。センター定位(両バスに
     * 乗っているch)ではleft=rightとなり平均しても値が変わらないため、単純にその/2を
     * 外すだけでモノラル時と同じ音量感を保ったままステレオ分離できる(片側のみに振られた
     * chは平均で半減していたのが、本来の片側フル音量に戻る形)。
     */
    mixSample() {
      const c1 = this.mute.ch1 ? 0 : this.ch1.output() * this.vol.ch1;
      const c2 = this.mute.ch2 ? 0 : this.ch2.output() * this.vol.ch2;
      const c3 = this.mute.ch3 ? 0 : this.ch3.output() * this.vol.ch3;
      const c4 = this.mute.ch4 ? 0 : this.ch4.output() * this.vol.ch4;
      const chans = [c1, c2, c3, c4];
      let left = 0, right = 0;
      for (let i = 0; i < 4; i++) {
        if ((this.nr51 >> (4 + i)) & 1) left += chans[i];
        if ((this.nr51 >> i) & 1) right += chans[i];
      }
      const volL = ((this.nr50 >> 4) & 0x07) + 1; // 1-8
      const volR = (this.nr50 & 0x07) + 1;
      return { left: (left * volL) / 8 / 60, right: (right * volR) / 8 / 60 };
    }
  }

  // NR51($FF25)の対応するchビットがL/R両方とも0なら、音量が非0でも実際は無音
  // (gbs2mml/expansion/pulse.js panAudible()と全く同じ式。ch=0-3がCH1-4)。
  function nr51Audible(nr51, ch) {
    return (((nr51 >> (4 + ch)) & 1) !== 0) || (((nr51 >> ch) & 1) !== 0);
  }

  // リアルタイム鍵盤表示用のライブスナップショット(snapshotAY8910/snapshotSCCと同じ考え方)。
  Emu.snapshotGbApu = function (apu) {
    const p = (ch, chIndex) => {
      const freq = ch.enabled ? 131072 / (2048 - ch.freq) : 0;
      return {
        freq, vol: ch.envelope.volume / 15, rawVol: ch.envelope.volume,
        duty: ch.duty, envPeriod: ch.envelope.period,
        active: ch.enabled && ch.envelope.volume > 0 && freq > 0 && nr51Audible(apu.nr51, chIndex)
      };
    };
    const w = apu.ch3;
    const wVol = { 0: 0, 1: 1, 2: 0.5, 3: 0.25 }[w.volumeShift] || 0;
    const wFreq = (w.enabled && w.dacOn) ? 65536 / (2048 - w.freq) : 0;
    const n = apu.ch4;
    const nFreq = n.enabled ? 4194304 / (16 * NOISE_DIVISOR[n.divisorCode] * (1 << n.clockShift)) : 0;
    return {
      ch1: p(apu.ch1, 0),
      ch2: p(apu.ch2, 1),
      ch3: {
        freq: wFreq, vol: wVol, rawVol: w.volumeShift,
        waveData: Array.from(w.wave, v => v / 7.5 - 1), // 0-15(4bit符号無し) → -1..1
        active: w.enabled && w.dacOn && wVol > 0 && wFreq > 0 && nr51Audible(apu.nr51, 2)
      },
      ch4: {
        freq: nFreq, vol: n.envelope.volume / 15, rawVol: n.envelope.volume,
        widthMode: n.widthMode, envPeriod: n.envelope.period,
        active: n.enabled && n.envelope.volume > 0 && nr51Audible(apu.nr51, 3)
      },
      nr50: apu.nr50, nr51: apu.nr51
    };
  };

  Emu.APUGb = APUGb;
})(globalThis);

/*
 * GBS(Game Boy)実行用メモリバス
 * MML.Emu.GbsBus
 *
 * GBSはMBC1風の単一バンクレジスタ($2000-$3FFF書込、下位5bit、0は1として扱う)を
 * 前提にする(Game_Music_Emu等の実装に合わせた簡略MBC1)。$0000-$3FFFは常に固定
 * (loadAddr未満は未使用領域として0を返す)、$4000-$7FFFが切替バンク窓。
 * データストリームは「loadAddrから$8000まで」を固定+バンク1の内容とみなし、
 * それ以降を$4000バイト単位のバンク2,3,...として連結する設計
 * (ヘッダにバンク数やデータ長のフィールドが無いため、ファイルサイズから逆算する)。
 *
 * $FF10-$FF3Fの音源レジスタはapu(MML.Emu.APUGb)へ委譲する。
 * VRAM/SRAM/OAM/その他I/Oレジスタ(タイマ・LCD等)は実際には機能をエミュレートせず、
 * ドライバコードが暴走・クラッシュしないための単純な読み書き可能領域として確保するのみ
 * (gbsPlayer.jsがPLAYをサブルーチン直接呼び出しする簡略設計のため、実タイマ/割込
 * ハードウェアの精密な動作は不要。詳細はgbsPlayer.js冒頭コメント参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class GbsBus {
    /**
     * @param {object} header - GBS.parseHeader() の結果
     * @param {Uint8Array} rom - ヘッダを除いた曲データ(header.dataOffset以降)
     */
    constructor(header, rom) {
      this.header = header;
      this.rom = rom;
      this.loadAddr = header.loadAddr;
      this.bankNum = 1; // 選択中バンク(実機同様5bit、0は1として扱う)
      this.apu = null; // gbsPlayer.jsが構築後にセットする
      this.onWrite = null; // (addr, value) => void。write-logキャプチャ用(gbs2mml向け)

      this.vram = new Uint8Array(0x2000); // $8000-$9FFF
      this.sram = new Uint8Array(0x2000); // $A000-$BFFF
      this.wram = new Uint8Array(0x2000); // $C000-$DFFF(エコー$E000-$FDFFも共有)
      this.oam = new Uint8Array(0xA0);    // $FE00-$FE9F
      this.io = new Uint8Array(0x80);     // $FF00-$FF7F(APU領域以外の雑多レジスタの下書き)
      this.hram = new Uint8Array(0x80);   // $FF80-$FFFE
      this.ie = 0;                        // $FFFF

      // RSTベクタ($0000-$0038、8バイト間隔で8個)パッチ。GBSファイルは実機のブートROM/
      // カートリッジヘッダを経由しないため、$0000-$(loadAddr-1)は本来ROMに存在しない
      // (romByte()がaddr<loadAddrで0を返す=常にNOP)。ドライバコードが`RST n`命令
      // (1バイトの省略呼出し、GBコードで多用される)を使うと、パッチが無いままではNOPの
      // 連続を空回りしながらloadAddr地点へ迷い込み、本来の呼び出し先とは無関係な
      // コードを誤実行してしまう(実測: CGB-BFTJ-JPN.gbsのRST $28[opcode 0xEF]が
      // PLAY中に複数回発行され、これが原因で音量計算が常に0になり無音化していた)。
      // Mesen2(GbsCart.h InitPlayback())と同じ方式で、各RSTベクタを
      // `JP loadAddr+i`(3バイト: 0xC3, lo, hi)へジャンプさせるコードで上書きする。
      this.vectorPatch = new Uint8Array(0x40);
      for (let i = 0; i <= 0x38; i += 8) {
        const target = (this.loadAddr + i) & 0xFFFF;
        this.vectorPatch[i]     = 0xC3; // JP nn
        this.vectorPatch[i + 1] = target & 0xFF;
        this.vectorPatch[i + 2] = (target >> 8) & 0xFF;
      }
    }

    reset() {
      this.bankNum = 1;
      this.vram.fill(0);
      this.sram.fill(0);
      this.wram.fill(0);
      this.oam.fill(0);
      this.io.fill(0);
      this.hram.fill(0);
      this.ie = 0;
    }

    romByte(addr) {
      if (addr < 0x40) return this.vectorPatch[addr]; // RSTベクタパッチ(コンストラクタ冒頭コメント参照)
      const L = this.loadAddr;
      if (addr < L) return 0; // loadAddr未満はROMデータの対象外
      if (addr < 0x4000) {
        const off = addr - L;
        return off < this.rom.length ? this.rom[off] : 0;
      }
      // $4000-$7FFF: bankNum=1は固定領域の直後(=バンク切替が無い曲の自然な続き)、
      // bankNum>=2はそれ以降を$4000バイト単位で連結したもの。
      const fixedLen = 0x4000 - L;
      const off = fixedLen + (this.bankNum - 1) * 0x4000 + (addr - 0x4000);
      return off < this.rom.length ? this.rom[off] : 0;
    }

    read(addr) {
      addr &= 0xFFFF;
      if (addr < 0x8000) return this.romByte(addr);
      if (addr < 0xA000) return this.vram[addr - 0x8000];
      if (addr < 0xC000) return this.sram[addr - 0xA000];
      if (addr < 0xE000) return this.wram[addr - 0xC000];
      if (addr < 0xFE00) return this.wram[addr - 0xE000]; // エコーRAM
      if (addr < 0xFEA0) return this.oam[addr - 0xFE00];
      if (addr < 0xFF00) return 0xFF; // 未使用領域
      if (addr < 0xFF80) {
        if (addr >= 0xFF10 && addr <= 0xFF3F && this.apu) return this.apu.readRegister(addr);
        return this.io[addr - 0xFF00];
      }
      if (addr < 0xFFFF) return this.hram[addr - 0xFF80];
      return this.ie;
    }

    write(addr, value) {
      addr &= 0xFFFF; value &= 0xFF;
      if (this.onWrite) this.onWrite(addr, value);
      if (addr >= 0x2000 && addr < 0x4000) {
        let n = value & 0x1F;
        if (n === 0) n = 1;
        this.bankNum = n;
        return;
      }
      if (addr < 0x8000) return; // その他のROM領域書込は無視(GBSは単純MBC1のみ対象)
      if (addr < 0xA000) { this.vram[addr - 0x8000] = value; return; }
      if (addr < 0xC000) { this.sram[addr - 0xA000] = value; return; }
      if (addr < 0xE000) { this.wram[addr - 0xC000] = value; return; }
      if (addr < 0xFE00) { this.wram[addr - 0xE000] = value; return; }
      if (addr < 0xFEA0) { this.oam[addr - 0xFE00] = value; return; }
      if (addr < 0xFF00) return;
      if (addr < 0xFF80) {
        if (addr >= 0xFF10 && addr <= 0xFF3F && this.apu) { this.apu.writeRegister(addr, value); return; }
        this.io[addr - 0xFF00] = value;
        return;
      }
      if (addr < 0xFFFF) { this.hram[addr - 0xFF80] = value; return; }
      this.ie = value;
    }
  }

  Emu.GbsBus = GbsBus;
})(globalThis);

/*
 * GBSプレイヤー (SM83 CPU + GbsBus + APUGb の統合)
 * MML.Emu.GbsPlayer
 *
 * ★割込ディスパッチを実装しない簡略設計: 実機/実ゲームはPLAYをVBlank割込または
 *   タイマ割込のハンドラから呼び出すが、その経路(IE/IF・HALT・RETI)を丸ごと
 *   再現しなくても、「ヘッダのTMA/TACから求めた頻度でPLAYをサブルーチンとして
 *   直接beginCall/stepCallする」だけで音声出力上は同じ結果になる
 *   (INIT/PLAYが呼ばれる回数とタイミングさえ合っていれば、割込経由かサブルーチン
 *   直接呼出しかは音源レジスタへの書き込み内容に影響しない。KSS/NSFプレイヤーが
 *   INIT/PLAYを直接呼び出しているのと同じ考え方)。PLAYがRETIで終わっていても、
 *   CPUSm83のRETIはRETと同じスタック復帰をした上でime=trueにするだけなので、
 *   beginCall()が積んだ番兵アドレスへの復帰検出は問題なく機能する。
 *
 * - initSong(songIndex): INITルーチンを呼び出して曲を初期化(A=0始まり曲番号)
 * - renderFrame(sampleRate): PLAYルーチンをヘッダのTMA/TAC(またはVBlank既定)で
 *   求まる頻度で呼び出しつつ、1フレーム分の音声サンプルを生成する
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class GbsPlayer {
    /**
     * @param {Uint8Array} gbsBytes - GBSファイルの完全なバイナリ
     */
    constructor(gbsBytes) {
      this.header = MML.GBS.parseHeader(gbsBytes);
      const rom = gbsBytes.slice(this.header.dataOffset);

      this.bus = new Emu.GbsBus(this.header, rom);
      this.apu = new Emu.APUGb();
      this.bus.apu = this.apu;
      this.cpu = new Emu.CPUSm83(this.bus);

      this.clockHz = MML.GBS.CPU_CLOCK;
      this.frameRate = this.header.playFps;

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
      this.bus.reset();
      this.apu.reset();
      this.cpu.reset();
      this.cpu.a = songIndex & 0xFF;
      this.cpu.sp = this.header.stackPointer;
      this.cpu.beginCall(this.header.initAddr);
      let cycles = 0;
      const maxCycles = this.clockHz; // 最大1秒相当まで(KSSと同じ安全弁)
      while (this.cpu.callActive && cycles < maxCycles) cycles += this.cpu.stepCall();
      this.cpu.callActive = false;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this._playFrameAccum = 0;
    }

    /**
     * 1フレーム分の音声サンプルを生成する。PLAYが1フレーム内に終わらない場合は
     * renderFrameを跨いで継続する(NsfPlayer/KssPlayer.renderFrameと同じ設計)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - trueならmixSample()を省略し、CPU実行・APUのclock()
     *   だけを行う(鍵盤表示/ピアノロールの先読みキャプチャ用の軽量モード)
     * @param {boolean} [stereo] - trueならモノラルFloat32Arrayの代わりに
     *   {left, right}(各Float32Array)を返す(WAV書き出し用)
     * @returns {Float32Array|{left:Float32Array,right:Float32Array}|null}
     */
    renderFrame(sampleRate, regsOnly, stereo) {
      const cyclesPerSample = this.clockHz / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / this.frameRate);
      const outL = regsOnly ? null : new Float32Array(samplesThisFrame);
      const outR = (regsOnly || !stereo) ? null : new Float32Array(samplesThisFrame);

      const cpu = this.cpu, apu = this.apu;

      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          // ドライバがINIT/前回PLAY中に積んだ分でスタックが延々ドリフトするのを防ぐ
          // (kssPlayer.jsのexec_setupと同じ考え方)
          cpu.sp = this.header.stackPointer;
          cpu.beginCall(this.header.playAddr);
        }
      }

      // CPUとAPUは同一クロック(4194304Hz)なので、KSSのようなクロック比変換は不要。
      // cpuDebtは「今実行中の命令が消費し終えるまでの残りTステート数」を表す。
      for (let i = 0; i < samplesThisFrame; i++) {
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          this.cycleAccum -= 1;
          if (this.cpuDebt <= 0) {
            this.cpuDebt = cpu.callActive ? cpu.stepCall() : 1;
          }
          this.cpuDebt--;
          apu.clock();
        }
        if (!regsOnly) {
          const s = apu.mixSample();
          if (stereo) { outL[i] = s.left; outR[i] = s.right; }
          else outL[i] = (s.left + s.right) * 0.5;
        }
      }

      return stereo ? { left: outL, right: outR } : outL;
    }
  }

  // APUのライブ状態を1フレーム分スナップショットする(gbs2mml向け)。
  // GBはCH1の周波数スイープ・エンベロープの減衰/増加が「レジスタ再書込み無しに
  // 内部クロックだけで」進行するため、writeLogの再生(SCC方式)では追えない
  // (N163のRAMスナップショットが必要だった事情と同種。src/emulator/capture.js参照)。
  // ライブのAPUオブジェクトから直接値を読む方が単純かつ正確なので、GBSは
  // 全チャンネルをこの方式に統一する(波形メモリも書込み再生ではなくch3.waveを直接読む)。
  function snapshotApu(apu) {
    return {
      // envInitVol/envDir/envPeriod: NRx2の生値(トリガー時に固定される、実機の
      // エンベロープハードウェアパラメータそのもの)。gbs2mml側でこれを起点(anchor)に
      // 「64Hz固定クロック×period」で音量を解析的に計算し直すために必要
      // (src/gbs2mml/expansion/hwEnvelope.js参照。駆動フレーム境界(playFps、曲毎に
      // 可変)で単純にvolを読むと、実機の64Hzエンベロープクロックとの位相ズレにより
      // 同一形状のエンベロープでも観測される段数が変わってしまう問題への対処)。
      ch1: { freq: apu.ch1.freq, duty: apu.ch1.duty, vol: apu.ch1.envelope.volume, enabled: apu.ch1.enabled, triggerSeq: apu.ch1.triggerSeq,
             envInitVol: apu.ch1.envelope.initialVolume, envDir: apu.ch1.envelope.direction, envPeriod: apu.ch1.envelope.period },
      ch2: { freq: apu.ch2.freq, duty: apu.ch2.duty, vol: apu.ch2.envelope.volume, enabled: apu.ch2.enabled, triggerSeq: apu.ch2.triggerSeq,
             envInitVol: apu.ch2.envelope.initialVolume, envDir: apu.ch2.envelope.direction, envPeriod: apu.ch2.envelope.period },
      ch3: { freq: apu.ch3.freq, volumeShift: apu.ch3.volumeShift, wave: Array.from(apu.ch3.wave), enabled: apu.ch3.enabled, dacOn: apu.ch3.dacOn, triggerSeq: apu.ch3.triggerSeq },
      ch4: { vol: apu.ch4.envelope.volume, clockShift: apu.ch4.clockShift, widthMode: apu.ch4.widthMode, divisorCode: apu.ch4.divisorCode, enabled: apu.ch4.enabled, triggerSeq: apu.ch4.triggerSeq,
             envInitVol: apu.ch4.envelope.initialVolume, envDir: apu.ch4.envelope.direction, envPeriod: apu.ch4.envelope.period },
      // NR50(マスター音量/VIN)・NR51(パンニング)。以前はここに含まれておらず、
      // GbsReplayStreamPlayerが常にAPUGbコンストラクタのブート後既定値(nr50=$77,
      // nr51=$F3)のまま再生し続けていた(実際にゲームが書き込んだ値を無視)。
      // $F3はCH3/CH4の右chビットだけ0なので、曲を問わず常にCH3/CH4が左chにしか
      // 出力されないように聴こえる不具合の直接の原因だった。
      nr50: apu.nr50, nr51: apu.nr51
    };
  }

  /**
   * GBSを指定秒数分オフラインレンダリングし、音声・フレーム毎のレジスタ書込ログ・
   * フレーム毎のAPUライブスナップショットを返す。WAV書き出し・gbs2mml変換・
   * ピアノロールの先読みキャプチャで使う共通キャプチャ関数(captureKssSongAsyncと同型)。
   * @param {Uint8Array} gbsBytes
   * @param {object} opt - {songIndex, durationSeconds, sampleRate, mute, regsOnly}
   * @param {(done:number,total:number,data:{writeLog:Array,snapshots:Array})=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, writeLog:Array, snapshots:Array, player:GbsPlayer, frameRate:number}>}
   */
  Emu.captureGbsSongAsync = async function (gbsBytes, opt, onProgress) {
    const player = new GbsPlayer(gbsBytes);
    // INIT中の書込みもフレーム0の先頭に含める(NSF/KSSのinitWritesと同じ考え方。
    // INITで一度だけ設定されPLAY中は二度と書かれないレジスタの取りこぼし防止)。
    const initWrites = [];
    player.bus.onWrite = (addr, value) => initWrites.push({ addr, value });
    player.initSong(opt.songIndex || 0);
    player.bus.onWrite = null;
    if (opt.mute) Object.assign(player.apu.mute, opt.mute);

    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = new Float32Array(totalOutSamples);
    const writeLog = [];
    const snapshots = [];
    let outPos = 0;
    // ★2026-08-20 スライスを「フレーム数固定」から「時間予算固定」へ変更(NSFの
    // capture.js captureSongAsync・captureKssSongAsyncと同じ方式・同じ理由)。
    // Worker実行時はopt.yieldFn/sliceBudgetMsで上書きされる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      const frameWrites = f === 0 ? initWrites : [];
      player.bus.onWrite = (addr, value) => frameWrites.push({ addr, value });
      const frameBuf = player.renderFrame(sampleRate, regsOnly);
      player.bus.onWrite = null;
      writeLog.push(frameWrites);
      snapshots.push(snapshotApu(player.apu));
      if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, { writeLog, snapshots });
        await yieldFn();
        if (opt.shouldCancel && opt.shouldCancel()) return { audio, writeLog, snapshots, player, frameRate: player.frameRate };
        sliceStart = performance.now();
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, { writeLog, snapshots });
    return { audio, writeLog, snapshots, player, frameRate: player.frameRate };
  };

  Emu.GbsPlayer = GbsPlayer;
  // VGM(vgmPlayer.js captureVgmSongAsync)がGB DMGチップのフレームスナップショットを
  // gbs2mml抽出器と同じ形で積むために公開する(GBS自身はモジュール内で直接呼ぶ)。
  Emu.snapshotGbApuForCapture = snapshotApu;
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
    if (apu.triangle) out.triangle = { len: apu.triangle.lengthCounter, linear: apu.triangle.linearCounter };
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
      const dmc = { level: apu.dmc.outputLevel, seq: apu.dmc.seq || 0,
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
 *   (3) 譜面整形(短い休符の吸収・音長の格子量子化)を emitScore 手前のイベント整形で行う
 * の3段で効かせる。
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
 * 譜面整形(既定 false = 従来通り):
 *   SHAPE_REST  … 音符の直後の短い休符(1/32未満)を音符に吸収(ゲートタイムの隙間除去)
 *   SHAPE_QUANT … イベント境界を16分音符格子へ丸める
 *
 * 値キー(booleanでない設定。2026-08-26):
 *   PITCH_SA … N163出力のSA<num>(ピッチシフト量)自動選択。'octave' | 'note' | 'off'
 *     EP/MP/Dテーブル値のbyte幅とN163周波数レジスタ18bitの桁差を埋める(選び方の詳細は
 *     src/convert/pitch.js n163SaForBase冒頭コメント参照)。既定'octave'(オクターブ連動、
 *     セント精度がオクターブ非依存でテーブル共有も効く)。'note'=音符ごと最高精度、
 *     'off'=SA不使用(従来互換、深い変調は割当失敗して落ちる)。
 *   PCM_RATE … PCM→DPCM変換の品質(DMCレートの選び方)。'max' | 8 | 4 | 2 | 1
 *     1bitデルタ変調は1bitあたり±2/127しか動けないため、ソースのバイトレートに対して
 *     何倍のDMCレートを使うかが追従能力(アタックのなまり)とアイドルトーン
 *     (平坦部で乗るレート/2のキーン音)を直接決める。倍率が上がるほど高音質・データ大。
 *     'max'=常に最高レート33.1kHz(既定) / 8,4,2=ソースレートのn倍以上の最小レート /
 *     1=従来互換(最も近いレート、データ最小)。現状の消費者はhes2mml/expansion/dpcm.js
 *     (HES DDA抽出)のみ。SPCのBRR→DPCMはDSPレート32kHz≒テーブル上限のため対象外。
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  MML.Convert = MML.Convert || {};

  const CMD_KEYS = ['D', 'EP', 'MP', 'PT', 'EN', 'ENV', 'V', 'SWEEP', 'INST', 'DRUM'];
  const SHAPE_KEYS = ['SHAPE_REST', 'SHAPE_QUANT'];
  // PCM品質(冒頭コメント参照)。boolean群とは別に許容値で正規化する
  const PCM_RATE_VALUES = ['max', 8, 4, 2, 1];
  const PITCH_SA_VALUES = ['octave', 'note', 'off'];
  // 同時発音をミックスして1サンプルに焼くときのDMCレートの決め方
  //   'quality' … 寄与するサンプルのうち最高音質を採る(既定)
  //   'size'    … 最低に合わせて容量を優先する
  const RATE_MIX_VALUES = ['quality', 'size'];
  MML.Convert.RATE_MIX_VALUES = RATE_MIX_VALUES;
  // 打楽器の同時発音の扱い(src/convert/drumHits.js poly)
  //   'mix'  … その瞬間に鳴っている打点をミックスして1クリップに焼く(既定、忠実)
  //   'mono' … ミックスしない。直近に叩かれた打点だけを鳴らす(定義がサンプル数までしか
  //            増えないので容量制御に使う。実測: NCS91002 はミックス54定義36KB→単音7定義)
  const DRUM_POLY_VALUES = ['mix', 'mono'];
  MML.Convert.DRUM_POLY_VALUES = DRUM_POLY_VALUES;
  MML.Convert.CMD_KEYS = CMD_KEYS;
  MML.Convert.SHAPE_KEYS = SHAPE_KEYS;
  MML.Convert.PCM_RATE_VALUES = PCM_RATE_VALUES;
  MML.Convert.PITCH_SA_VALUES = PITCH_SA_VALUES;

  const PRESETS = {
    // 忠実再現(従来の既定)
    faithful: { D: true, EP: true, MP: true, PT: true, EN: true, ENV: true, V: true, SWEEP: true, INST: true, DRUM: true,
                SHAPE_REST: false, SHAPE_QUANT: false, PCM_RATE: 'max', PITCH_SA: 'octave', RATE_MIX: 'quality', DRUM_POLY: 'mix' },
    // プレーン譜面: 音階+音色だけ。編曲の出発点用
    plain:    { D: false, EP: false, MP: false, PT: false, EN: false, ENV: false, V: false, SWEEP: false, INST: true, DRUM: true,
                SHAPE_REST: true, SHAPE_QUANT: true, PCM_RATE: 'max', PITCH_SA: 'octave', RATE_MIX: 'quality', DRUM_POLY: 'mix' },
  };
  MML.Convert.CMD_PRESETS = PRESETS;

  // options.cmd(部分指定可)を全キー揃った正規形にする。省略キーは faithful 既定。
  MML.Convert.normalizeCmd = function (cmd) {
    const out = Object.assign({}, PRESETS.faithful);
    if (cmd && typeof cmd === 'object') {
      for (const k of [...CMD_KEYS, ...SHAPE_KEYS]) if (cmd[k] != null) out[k] = !!cmd[k];
      // 数値は文字列でも受ける(localStorage/JSON経由やUIのselect値が'4'等になるため)
      if (cmd.PCM_RATE != null) {
        const v = cmd.PCM_RATE === 'max' ? 'max' : parseInt(cmd.PCM_RATE, 10);
        if (PCM_RATE_VALUES.indexOf(v) >= 0) out.PCM_RATE = v;
      }
      if (cmd.PITCH_SA != null && PITCH_SA_VALUES.indexOf(cmd.PITCH_SA) >= 0) out.PITCH_SA = cmd.PITCH_SA;
      if (cmd.RATE_MIX != null && RATE_MIX_VALUES.indexOf(cmd.RATE_MIX) >= 0) out.RATE_MIX = cmd.RATE_MIX;
      if (cmd.DRUM_POLY != null && DRUM_POLY_VALUES.indexOf(cmd.DRUM_POLY) >= 0) out.DRUM_POLY = cmd.DRUM_POLY;
    }
    return out;
  };

  // どれかがプリセットと完全一致すればその名前、無ければ 'custom'
  MML.Convert.cmdPresetName = function (cmd) {
    const n = MML.Convert.normalizeCmd(cmd);
    for (const name of Object.keys(PRESETS)) {
      const p = PRESETS[name];
      if ([...CMD_KEYS, ...SHAPE_KEYS, 'PCM_RATE', 'PITCH_SA', 'RATE_MIX', 'DRUM_POLY'].every(k => p[k] === n[k])) return name;
    }
    return 'custom';
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
  //   SHAPE_QUANT: 各イベントの start を grid フレーム格子へ丸め、end は次イベントの start
  //                (最後は元の end を丸めた値)。長さ0になったイベントは捨てる
  MML.Convert.shapeEvents = function (events, fpb, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    if (!c.SHAPE_REST && !c.SHAPE_QUANT) return events;
    let evs = (events || []).slice().sort((a, b) => a.start - b.start).map(e => Object.assign({}, e));

    if (c.SHAPE_REST) {
      const restThreshold = fpb / 8; // 1/32 音符未満
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const prev = out[out.length - 1];
        if (ev.note === null && prev && prev.note !== null && (ev.end - ev.start) < restThreshold) {
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

    if (c.SHAPE_QUANT) {
      const grid = fpb / 4; // 16分音符
      const snap = (f) => Math.round(f / grid) * grid;
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const s = snap(ev.start);
        const e = (i + 1 < evs.length && evs[i + 1].start <= ev.end) ? snap(evs[i + 1].start) : snap(ev.end);
        if (e <= s) continue;
        const prev = out[out.length - 1];
        if (prev && prev.end > s) prev.end = s;
        if (prev && prev.end <= prev.start) out.pop();
        out.push(Object.assign(ev, { start: s, end: e }));
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
  // ([[envelope-nonloop-tail-trim-fix]]と同じ考え方: 非ループテーブルは末尾値を
  // 永久ホールドする(compiler.js stepEnvelope参照)ため、末尾の重複はテーブル長を
  // 縮めるだけで再生結果に影響しない)。
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
  // periodic: loop=0(テーブル全体が繰り返し単位、headの概念が無くなったため常に先頭から
  // ループする)。literal/ramp: loop=null(非ループ、末尾を永久ホールド)。
  // ★loop有り同士(片方でもloop!=null)は前方一致していても共有・置き換えを一切行わない
  // (envelope.js EnvelopeRegistry.registerShapeと同じ理由・同じガード。
  // [[envelope-registry-loop-upgrade-bug]]参照。ループ有りのvaluesは「最小の繰り返し単位」に
  // 切り詰められており配列長が観測フレーム数を反映しないため、前方一致だけを根拠にした
  // 共有/差し替えは無関係な変調を混同する事故になる)。
  MML.Convert.PitchEnvelopeRegistry.prototype.registerShape = function (pitchMod) {
    if (!pitchMod) return null;
    const isPeriodic = pitchMod.type === 'periodic';
    const shape = { values: pitchMod.values, loop: isPeriodic ? 0 : null };
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
    const cont = 57 + 12 * Math.log2(freq / 440);
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
  // stepEnvelope(EPで使用)のような単純な周期的インデックス参照ではない。そのため
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
 * GB音量エンベロープ(NRx2)の解析的シミュレーション
 * MML.Gbs2MmlExpansion.hwEnvelope = { volumeAt, updateAnchor }
 *
 * GB実機のエンベロープはフレームシーケンサ由来の固定64Hzクロックで、period(NRx2下位3bit)
 * クロックごとに1段階だけ増減する(src/emulator/apuGb.jsのEnvelope.clock()と同じ仕様)。
 * このクロックはドライバのPLAY呼び出し頻度(playFps、GBSリップ毎に可変。59.7275Hz等)とは
 * 完全に独立している。
 *
 * 従来の実装は「駆動フレーム境界(playFps)でスナップショットしたvolをそのまま読む」方式
 * だったが、各スナップショット自体は正確でも、64HzとplayFpsが単純な整数比にならないため
 * (例: 64/59.7275≈1.0719)、同一形状のエンベロープでもトリガーされた絶対位置によって
 * 64Hzクロックとの位相がずれ、駆動フレーム境界から観測される段数が変わってしまっていた
 * (ある音符では15段のうち14段しか観測されない、等)。これが@v<n>テーブルの
 * 「本来同じ形状のはずなのに微妙に違う」大量重複の直接原因だった(実測・原因調査は
 * gbs-envelope-64hz-aliasing-bugメモリ参照)。
 *
 * 対策として、トリガー時点(またはまれにトリガー無しのNRx2書換え時点)を起点(anchor)に、
 * 「経過ドライバフレーム数 → 経過秒数 → 64Hzクロック数 → floor(クロック数/period)段階」
 * を解析式で直接計算し直す。これなら同一の(initVol,dir,period)形状は絶対位置に関係なく
 * 常に同一の数値列を生成する(位相非依存)ため、位相ズレによる疑似重複が解消される。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};

  // anchor.frame起点からのドライバフレームオフセットにおける音量(0-15)。
  // frame(整数、driverフレーム番号)とplayFps(曲固有のPLAY呼び出し頻度、非整数)から
  // 経過秒数→経過64Hzクロック数を求め、period個ごとに1段階増減する実機の式を適用する。
  function volumeAt(anchor, frame, playFps) {
    if (anchor.period === 0) return anchor.initVol; // period=0はエンベロープ無効(実機仕様)
    const k = frame - anchor.frame; // anchor起点からの経過driverフレーム数(>=0)
    const steps = Math.floor((k * 64) / (playFps * anchor.period));
    const v = anchor.initVol + (anchor.dir === 1 ? steps : -steps);
    return Math.max(0, Math.min(15, v));
  }

  // 新しいanchorが必要か判定して返す(変化が無ければ既存anchorをそのまま返す)。
  // - トリガー発生時(triggered=true): 実機のEnvelope.trigger()と同じくvolume=initVolへ
  //   リセットされるため、initVol/dir/periodが前回と同じ値でも必ず起点を更新する。
  // - トリガー無しでNRx2が書き換わった場合(period/direction/initVolのいずれかが変化):
  //   ごくまれなケースだが、音符が継続中のまま音量の減衰形状だけ変わる可能性があるため
  //   その時点を新たな起点として扱う。
  function updateAnchor(anchor, c, frame, triggered) {
    if (triggered || !anchor || c.envInitVol !== anchor.initVol || c.envDir !== anchor.dir || c.envPeriod !== anchor.period) {
      return { frame, initVol: c.envInitVol, dir: c.envDir, period: c.envPeriod };
    }
    return anchor;
  }

  MML.Gbs2MmlExpansion.hwEnvelope = { volumeAt, updateAnchor };
})(globalThis);

/*
 * GB パルスch(CH1/CH2) → MML共通イベント形式 抽出
 * MML.Gbs2MmlExpansion.pulse(snapshots, chKey, envReg, playFps) → { events }
 *
 * writeLogの再生ではなく、captureGbsSongAsyncが積んだ「APUライブスナップショット」を
 * そのまま読む(gbsPlayer.js冒頭コメント参照。CH1の周波数スイープはレジスタ再書込み無しに
 * 内部クロックだけで進行するため、writeLog再生では追えない)。
 * GBは実際のトリガbit(NRx4 bit7)を持つため、triggerSeq(apuGb.js)の変化を見るだけで
 * 音符の頭を確実に検出できる(ay.js/scc.jsが使う「音量が上向きに跳ね上がったら再アタック」
 * というヒューリスティックより確実)。
 *
 * 音量エンベロープの値はスナップショットの生volを使わず、hwEnvelope.jsの解析式で
 * 起点(トリガー時点)から計算し直す(64Hz実機クロックとplayFpsの位相ズレによる
 * 疑似重複対策、hwEnvelope.js冒頭コメント参照)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};
  const { volumeAt, updateAnchor } = MML.Gbs2MmlExpansion.hwEnvelope;

  // NR51($FF25、パンニング)の対応するchビットがL/R両方とも0なら、音量レジスタが
  // 非0でも実際にはどちらの出力バスにも混ざらず無音になる(Pan Docs: bit(4+ch)=L出力へ
  // ミックス、bit(ch)=R出力へミックス。ch=0-3がCH1-4に対応)。従来の抽出は音量レジスタ
  // だけを見ていたため、作曲側がパンニングだけで消音するケース(Last Bible DMG-M7J.gbs
  // 実測で発覚)を無音として検出できていなかった。電源投入時の既定値$F3(全ch L ON、
  // CH1/2のみR ON)ではどのchも無音にならないため、明示的にNR51を書き換えた曲でのみ影響する。
  function panAudible(nr51, chIndex) {
    return (((nr51 >> (4 + chIndex)) & 1) !== 0) || (((nr51 >> chIndex) & 1) !== 0);
  }
  MML.Gbs2MmlExpansion._panAudible = panAudible; // wave.js/noise.jsから共用

  // f = 131072 / (2048 - freqReg) (Pan Docs、apuGb.jsのPulseChannel.clockTimer()と同じ式)
  function pulseFreq(freqReg) { return freqReg < 2048 ? 131072 / (2048 - freqReg) : 0; }

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  const CH_INDEX = { ch1: 0, ch2: 1 };

  function extractEvents(snapshots, chKey, playFps) {
    const chIndex = CH_INDEX[chKey];
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    let anchor = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chKey];
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      anchor = updateAnchor(anchor, c, f, triggered);
      const vol = volumeAt(anchor, f, playFps);
      const freqHz = (c.enabled && vol > 0 && panAudible(snapshots[f].nr51, chIndex)) ? pulseFreq(c.freq) : 0;
      const note = freqHz > 0 ? freqToNoteNumber(freqHz) : null;
      if (!cur) {
        cur = { note, duty: c.duty, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: false };
        continue;
      }
      if (triggered || note !== cur.note || c.duty !== cur.duty) {
        // トリガbit変化が無く、純粋に音程だけが変わった場合はスラー分割のタイ候補
        const pureNoteChange = !triggered && note !== cur.note && c.duty === cur.duty;
        flush(f);
        cur = { note, duty: c.duty, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.pulse = function (snapshots, chKey, envReg, playFps) {
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)。mergeUnclearPitchRunsは
    // mergeVibratoAndArpeggio(mergeRapidArpeggio+mergeAlternatingVibrato)の直後に
    // 呼ぶ既存の呼び出し規約通り(pitch.js mergeUnclearPitchRuns冒頭コメント参照)。
    const events = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractEvents(snapshots, chKey, playFps)));
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.duty, rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(pulseFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    return { events: events.map(toCommon), hasVolume: true, hasEnvelope: true, hasInstrument: true };
  };
})(globalThis);

/*
 * GB ノイズch(CH4) → MML共通イベント形式 抽出(2A03ノイズchへの借用を前提)
 * MML.Gbs2MmlExpansion.noise(snapshots) → { events }
 *
 * GBのノイズは(クロックシフト4bit×幅モード1bit×分周コード3bit)=256通りの設定を持つが、
 * 借用先の2A03ノイズは固定16周期しか持たない(src/mml/compiler.jsのnoisePeriodIndex、
 * ノート番号31-nでperiodIndex nを表す ppmck 準拠の固定対応)。このため実測周波数に
 * 一番近い2A03周期を探して割り当てる近似変換になる(音程は近似できるが、GBのLFSR幅
 * モード(7bit/15bit)によるノイズの質感の違いまでは2A03側で再現できない)。
 * ネイティブ変換(NSF→2A03自身)のノイズがそもそも音程補正(D<n>)を行っていないのと同じ
 * 理由(離散的な周期の入れ替えであり連続量の微調整という概念が無い)で、ここでも
 * detune補正は行わない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};
  const { volumeAt, updateAnchor } = MML.Gbs2MmlExpansion.hwEnvelope;

  // GBノイズ周期(Tステート) = 16 * divisor * 2^shift (apuGb.jsのNoiseChannel.periodT()と同じ式)
  const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];
  const GB_CLOCK = 4194304;
  function gbNoiseFreq(divisorCode, clockShift) {
    const periodT = 16 * NOISE_DIVISOR[divisorCode] * (1 << clockShift);
    return GB_CLOCK / periodT;
  }

  // 2A03ノイズの実測16周期(NTSC、apu2a03.jsのNOISE_PERIODと同じテーブル)
  const NES_CPU_CLOCK = 1789773;
  const NES_NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  const NES_NOISE_FREQS = NES_NOISE_PERIOD.map(p => NES_CPU_CLOCK / p);

  // 実測周波数(対数距離)に一番近い2A03周期indexを探し、noisePeriodIndexの逆写像
  // (31-idx)でノート番号にする(src/mml/compiler.jsのnoisePeriodIndexと正確に対応する)。
  function gbNoiseFreqToNote(freqHz) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return 31 - best;
  }

  function extractEvents(snapshots, playFps) {
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    let anchor = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f].ch4;
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      anchor = updateAnchor(anchor, c, f, triggered);
      const vol = volumeAt(anchor, f, playFps);
      // NR51パンニングの両出力バスとも0ならch4無音扱い(pulse.jsのpanAudible冒頭コメント
      // 参照)。CH4はNR51上のch index=3。
      const on = c.enabled && vol > 0 && MML.Gbs2MmlExpansion._panAudible(snapshots[f].nr51, 3);
      const note = on ? gbNoiseFreqToNote(gbNoiseFreq(c.divisorCode, c.clockShift)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [vol] }; continue; }
      if (triggered || note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [vol] };
      } else {
        cur.volSeq.push(vol);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.noise = function (snapshots, envReg, playFps) {
    const events = extractEvents(snapshots, playFps);
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      toVolumeFields(ev.volSeq)
    );
    return { events: events.map(toCommon), hasVolume: true, hasEnvelope: true };
  };
})(globalThis);

/*
 * GB 波形ch(CH3) → MML共通イベント形式 抽出(FDSへの借用を前提)
 * MML.Gbs2MmlExpansion.wave(snapshots, waveReg, envReg) → { events, fdsWave }
 *
 * ★当初はN163(4bitニブル詰めでビット深度が完全一致、リサンプリング不要)を採用していたが、
 * 実測でN163⇔2A03間の音量バランスがどうしても安定しなかったため、ユーザー確認の上でFDSへ
 * 変更した。理由: FDSの出力式(src/emulator/expansion/fds.js mixSample())は
 * `(センタリング済みサンプル/32) * (volGain/32) * masterScale * 0.20` で、この0.20が
 * **実機NESの抵抗網(FDS=47Ω直列・2A03=100Ω直列・負荷=39Ω)から算出した実測較正値**。
 * N163はこの手の実機較正が無い純粋な乗算式(sample-8)*volumeで、GBの波形chが
 * ほぼ常に「100%(レジスタ最大)」でしか鳴らない特性と組み合わさると、波形の中身
 * (振れ幅)次第でバランスが大きくブレた(2A03パルスの非線形ミキサーは音量を上げても
 * 頭打ちになるが、N163の式には圧縮が無いため)。FDSなら実機較正済みの0.20に乗っかれる。
 *
 * GBの波形(4bit,32点)→FDSの波形(6bit,64点)はビット拡張(ビット複製 (v<<2)|(v>>2) で
 * 0-15を0-63へ均等に対応させる、情報を捨てない)。音量はFDSがMML側では他chと同じv0-15
 * (compiler.js側で内部0-32ゲインへ2倍される、src/mml/compiler.js参照)なので、GBの実比率
 * (100:50:25=4:2:1)をそのまま余裕を持って{0,15,8,4}へ対応させる(N163のときのような
 * 解像度の潰れが起きない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(FDS)のクロック。src/mml/compiler.js・nsf2mml/expansion/fds.jsと同じ値

  // f = 65536 / (2048 - freqReg) (Pan Docs、apuGb.jsのWaveChannel.clockTimer()と同じ式)
  function waveFreq(freqReg) { return freqReg < 2048 ? 65536 / (2048 - freqReg) : 0; }

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  // FDS周波数レジスタ(12bit、period)の連続値換算。fdsFreq(period)=period*CLOCK/(65536*64)
  // (src/nsf2mml/expansion/fds.jsと同じ式)の逆関数。detune計算用に丸めない生の値を返す
  // (src/convert/detune.js冒頭コメント: 差を取ってから1回だけ丸めること)。
  function fdsPeriodRaw(freq) { return (freq * 65536 * 64) / CPU_CLOCK_NTSC; }
  MML.Gbs2MmlExpansion._fdsPeriodRaw = fdsPeriodRaw; // converter.jsのapplyPitchDetune呼び出しで使う

  // GBの波形ch(32サンプル/周期)をFDSの波形ch(64サンプル/周期)へ変換する。
  // ①各サンプルを2回ずつ複製してサンプル数を32→64へ引き伸ばす(1周期の長さを合わせる。
  //   これをやらないとcompiler.js側が64個中の後半32個を未定義値=0で埋めてしまい、
  //   波形の後半が無音になった状態でFDSの1周期(64サンプル)を読み切ってしまう。
  //   結果、実際に鳴る波形は「前半だけ本来の形・後半は無音」という別物になり、
  //   fdsPeriodRaw()が前提とする「64サンプル=元のGB波形1周期分」ともズレて音程も狂う)。
  // ②4bit(0-15)を6bit(0-63)へビット複製で均等拡大する(情報を捨てない拡張)。
  function expandTo6bit(wave) {
    const upsampled = new Array(64);
    for (let i = 0; i < 32; i++) { upsampled[i * 2] = wave[i]; upsampled[i * 2 + 1] = wave[i]; }
    return upsampled.map(v => ((v << 2) | (v >> 2)) & 0x3F);
  }

  // GBの音量シフト(0=mute,1=100%,2=50%,3=25%)をFDSの音量(MML側0-15スケール、
  // compiler.js側で内部0-32ゲインへ2倍される)へ対応させる。GBの実比率(4:2:1)をそのまま
  // ラダーで表現する(N163のときのような解像度の潰れが起きない)。
  // ★2026-08-07: ユーザー実測で「まだ少し大きい」との指摘を都度反映し段階的に引き下げ
  // (15,8,4 → 12,6,3 → 10,5,2 → ユーザー指定で8,4,2に決定。ちょうど4:2:1の整数比)。
  const VOLUME_SHIFT_TO_FDS = { 0: 0, 1: 8, 2: 4, 3: 2 };

  function extractEvents(snapshots) {
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f].ch3;
      const vol = VOLUME_SHIFT_TO_FDS[c.volumeShift] || 0;
      // NR51パンニングの両出力バスとも0ならch3(音量シフトは非0でも)無音扱い
      // (pulse.jsのpanAudible冒頭コメント参照)。CH3はNR51上のch index=2。
      const audible = c.enabled && c.dacOn && vol > 0 && MML.Gbs2MmlExpansion._panAudible(snapshots[f].nr51, 2);
      const freqHz = audible ? waveFreq(c.freq) : 0;
      const note = freqHz > 0 ? freqToNoteNumber(freqHz) : null;
      const wave = c.wave; // 元の4bit値(waveKey判定・スケーリング前の保持用)
      const waveKey = wave.join(',');
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      if (!cur) {
        cur = { note, wave, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: false };
        continue;
      }
      if (triggered || note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // トリガbit変化・波形切替が無く、純粋に音程だけが変わった場合はスラー分割のタイ候補
        const pureNoteChange = !triggered && note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.wave = function (snapshots, waveReg, envReg) {
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)
    const events = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractEvents(snapshots)));
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(expandTo6bit(ev.wave)) } : {},
      ev.note !== null && ev.rawFreq != null ? { rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(waveFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    const finalSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1].ch3 : null;
    return {
      events: events.map(toCommon),
      hasVolume: true, hasEnvelope: true, hasInstrument: true,
      fdsWave: finalSnap ? expandTo6bit(finalSnap.wave) : new Array(64).fill(0)
    };
  };
})(globalThis);

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
    const toNotes = (events, attenuated) => {
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
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && !(e.retrigger && si === 0) && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, norm(e.volume));
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
          } else {
            out.push({ startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: norm(e.volume), freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] });
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push({ id: `KP${i + 1}`, color: KP_COLS[i], notes: toNotes(ch.events) }));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push({ id: `KS${i + 1}`, color: `hsl(${(280 + i * 20) % 360},80%,60%)`, notes: toNotes(ch.events) }));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      // 第2引数true = OPLLの音量は減衰値なので表示用に反転する(toNotes冒頭のコメント参照)
      opllResult.channels.forEach((ch, i) => tracks.push({ id: `KF${i + 1}`, color: KF_COLS[i % KF_COLS.length], notes: toNotes(ch.events, true) }));
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
      oplResult.channels.forEach((ch, i) => tracks.push({ id: `OL${i + 1}`, color: OL_COLS[i % OL_COLS.length], notes: toNotes(ch.events, true) }));
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
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
          } else {
            out.push({ startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] });
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになり無音扱いになる。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push({ id: 'GB1', color: '#66ddff', notes: toNotes(ch1.events) });
    tracks.push({ id: 'GB2', color: '#0077dd', notes: toNotes(ch2.events) });
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push({ id: 'GW', color: '#ffcc00', notes: toNotes(wave.events) });
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
    const toNotes = (events) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
          } else {
            out.push({ startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] });
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
      let notes = toNotes(ch.events);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes });
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
    // スナップショット型チップ: extractChannels(keyboard.js)が読むextraSnapsに
    // フレーム毎スナップショット配列を渡して同じ抽出経路でトラック化する
    const snapChips = ['sn', 'ym2612', 'ym2610fm', 'ym2151', 'ym2203fm', 'ym2608fm', 'ga20', 'segapcm', 'c140', 'c352', 'okim6258', 'qsound', 'okim6295', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
    const chipToken = { sn: 'sn76489' };
    const poolMode = (opts && opts.poolMode) || {};
    for (const key of snapChips) {
      if (!data[key]) continue;
      const token = chipToken[key] || key;
      const snaps = (poolMode[key] === 'logical' && data[key].logical) ? data[key].logical : data[key].snapshots;
      const extra = {}; extra[key] = snaps;
      const t = buildTracks(snaps, [], done, sr / frameRate, sr, ['vgm', token], null, extra);
      if (t) tracks = tracks.concat(t);
    }
    return tracks;
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
      () => cancelled, { yieldFn: macroYield, sliceBudgetMs: 30 });
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
      sliceBudgetMs: 30
    });
    await Emu.captureHesSongAsync(msg.bytes, opt, onProgress);
    global.postMessage({ type: 'done', cancelled });
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
      sliceBudgetMs: 30 // Worker内はUI非ブロックなので大きめ(=cancel応答性の上限)
    });

    const sendRoll = makeRollSender(msg.format, msg);
    const sent = {};
    let metaSent = false;
    let lastPayload = null;
    const onProgress = (done, total, payload) => {
      lastPayload = payload;
      const { arrays, meta } = diffPayload(payload, sent, !metaSent);
      const chunk = { type: 'progress', done, total, arrays };
      if (!metaSent) { metaSent = true; chunk.meta = meta; }
      global.postMessage(chunk);
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