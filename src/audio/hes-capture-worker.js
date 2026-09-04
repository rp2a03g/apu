/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-09-05 04:37:46
 *
 * regsOnly capture worker bundle (hesCapture). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.hesCapture is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.hesCaptureBuiltAt = '2026-09-05 04:37:46';
  MML.WorkerBundles.hesCapture = function () {
/*
 * HES (Hudson Entertainment Sound / PC Engine) ヘッダ解析
 * MML.HES
 *
 * 参考: Game_Music_Emu(kode54/Game_Music_Emu) gme/Hes_Core.h の header_t 構造体
 *       (フィールドのオフセット・意味を実装から直接確認。本体コードは移植せず、
 *       構造体レイアウトという事実のみをクリーンルームで再実装している)。
 *
 * HESヘッダは32byte固定:
 *   0x00 tag[4]        "HESM"
 *   0x04 vers           バージョン(通常0)
 *   0x05 firstTrack     既定トラック番号(INIT呼出時にAレジスタへそのまま渡す値。
 *                       0始まり/1始まりの規約は無く、ゲームのプログラムが直接解釈する
 *                       任意の8bit値。NSF/GBSと違い「曲数」フィールドは存在しない
 *                       ─ 有効なトラック番号の集合はゲーム依存で、通常M3Uで個別に案内される)
 *   0x06 initAddr[2]    LE、INITルーチンの開始アドレス(CPU論理アドレス)
 *   0x08 banks[8]       MPR0-7の初期バンク番号(8bit×8。TAM/TMAでアクセスする
 *                       8KBページのバンク割当をそのまま初期値として書き込む)
 *   0x10 dataTag[4]     "DATA"(無くても警告のみで続行)
 *   0x14 dataSize[4]    LE、DATAブロックのバイト数
 *   0x18 addr[4]        LE、DATAブロックが物理アドレス空間(21bit、最大1MB)上で
 *                       開始する位置。banks[i]*0x2000 がこの範囲内に入っているページだけ
 *                       ROMデータとして読める(それ以外は0xFF=未マップ)
 *   0x1C unused[4]
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const HES = MML.HES = MML.HES || {};

  HES.HEADER_SIZE = 0x20;
  HES.PAGE_SIZE = 0x2000; // 8KB
  HES.PAGE_COUNT = 8;     // MPR0-7
  HES.ROM_MAX = 0x100000; // 21bit物理アドレス空間(1MB)

  // PC Engine高速クロック(21477270/3。GME Hes_Emu.cppのsetup_buffer(7159091)相当、
  // ここでは colorburst*6/3 から誤差の無い整数で導出する)。
  HES.CPU_CLOCK_HIGH = 7159090; // 21477270 / 3
  HES.CPU_CLOCK_LOW = HES.CPU_CLOCK_HIGH / 4; // CSL時(/12)。CSHとの比は12/3=4倍。
  HES.PSG_CLOCK = 3579545; // colorburst(NTSC)、CPU_CLOCK_HIGH/2相当。PSG周波数式の基準クロック
  HES.VBLANK_FPS = HES.CPU_CLOCK_HIGH / (262 * 455); // ≒60.05Hz(走査線262本×455クロック)

  function decodeAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[offset + i];
      if (c === undefined || c === 0) break;
      if (c < 0x20 || c > 0x7E) return ''; // 非テキストは無視(GME copy_field と同じ考え方)
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /**
   * HESファイルのバイト列を解析する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  HES.parseHeader = function (bytes) {
    if (bytes.length < HES.HEADER_SIZE) throw new Error('HESヘッダは最低0x20バイト必要です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const magicOk = tag === 'HESM';
    const vers = bytes[4];
    const firstTrack = bytes[5];
    const initAddr = view.getUint16(0x06, true);
    const banks = Array.from(bytes.slice(0x08, 0x10));
    const dataTag = String.fromCharCode(bytes[0x10], bytes[0x11], bytes[0x12], bytes[0x13]);
    const dataTagOk = dataTag === 'DATA';
    const dataSize = view.getUint32(0x14, true);
    const addr = view.getUint32(0x18, true) & (HES.ROM_MAX - 1);

    // タイトル/作者/著作権は正式なヘッダフィールドではなく、一部のリップツールが
    // DATAブロックの直後(header+0x20の位置、NSFの32byteテキストフィールドと同じ発想)に
    // 追加で書き出すことがある「おまけ」情報(GME Hes_Emu.cpp copy_hes_fields 相当)。
    // 無い曲がほとんどなので読めなくてもエラーにしない。
    let title = '', author = '', copyright = '';
    const infoOffset = HES.HEADER_SIZE + dataSize;
    if (infoOffset + 0x60 <= bytes.length) {
      title = decodeAscii(bytes, infoOffset, 0x20);
      author = decodeAscii(bytes, infoOffset + 0x20, 0x20);
      copyright = decodeAscii(bytes, infoOffset + 0x40, 0x20);
    }

    return {
      tag, magicOk, vers, firstTrack, initAddr, banks,
      dataTag, dataTagOk, dataSize, addr,
      title, author, copyright,
      dataOffset: HES.HEADER_SIZE
    };
  };
})(globalThis);

/*
 * HuC6280 (PC Engine / TurboGrafx-16 CPU) コア
 * MML.Emu.CPUHuC6280
 *
 * 65C02をベースに、PCEハードウェア固有の拡張命令を追加したチップ。cpu6502.js(NES用、
 * NMOS 6502・151正規命令のみ・デコード無効)とは別物として新規実装する
 * (参考: HuC6280 CMOS 8-bit Microprocessor Software Manual、
 *  HuC6280 opcode matrix https://taotao54321.github.io/appsouko/work/PCE/6280op.html 、
 *  PC Engine Hardware Docs 各種。GME(Game_Music_Emu)等の実装は参照せず、公開ドキュメントの
 *  レジスタ/命令仕様という事実のみをクリーンルームで再実装している)。
 *
 * 6502からの主な相違点:
 *   - 65C02系の追加: BRA, PHX/PHY/PLX/PLY, STZ, TRB/TSB, (zp)間接アドレッシング,
 *     JMP (abs,X), BBRi/BBSi/RMBi/SMBi(ゼロページビット演算+分岐), 未定義オペコード無し
 *     (全256通りに何らかの意味がある)。JMP (abs) のページ境界バグは無い(65C02で修正済み)。
 *   - 6280固有拡張: TAM/TMA(MMU、8x8KBページのバンク切替)、ST0/ST1/ST2(HuC6270向け
 *     固定アドレスストア)、TII/TDD/TIA/TAI/TIN(ブロック転送)、SXY/SAX/SAY(レジスタ交換)、
 *     CLA/CLX/CLY(レジスタクリア)、BSR(相対サブルーチン呼出)、CSH/CSL(CPU速度切替)、
 *     SET(次の1命令だけゼロページ,X/Yのラップアラウンドを無効化するTフラグ)、
 *     TST(ゼロページ/絶対アドレスへの即値AND、BITの拡張版)。
 *   - IRQディスパッチを本実装で唯一実装している(GBS/NSF/KSSは簡略化してPLAYを直接呼ぶ設計
 *     だが、HESはヘッダにPLAYアドレスが無く、曲データ自身のIRQベクタ経由でしかPLAY相当の
 *     処理を起動できないため、本物の割込停止/分岐/RTIを実装する必要がある)。
 *     bus.pollIrq() が現在有効な割込のベクタアドレス(無ければ-1)を返す前提
 *     (優先度・個別マスクの判断はhesBus.js側の責務、CPUはIフラグの成否だけを見る)。
 *   - 10進(BCD)モードはHuC6280でも機能する(NESの2A03と違いここは無効化されない)。
 *     ADC/SBCのBCD補正はCMOS 65C02方式(N/V/ZフラグもBCD結果から正しく再計算される)を
 *     採用しているが、実チップでの実測検証はしていない(HES曲データの範囲では
 *     オーディオドライバがSEDを使うことは通常無く、実害の想定は低いという判断)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const F_C = 0x01, F_Z = 0x02, F_I = 0x04, F_D = 0x08, F_B = 0x10, F_T = 0x20, F_V = 0x40, F_N = 0x80;

  const CALL_SENTINEL = 0xFFFF;

  class CPUHuC6280 {
    /**
     * @param {{read:(a:number)=>number, write:(a:number,v:number)=>void, pollIrq?:()=>number}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.A = 0; this.X = 0; this.Y = 0;
      this.S = 0xFF;
      this.P = F_I; // T/D/V/N/Z/Cはクリア、Iはセット(実機はRESET直後IRQ禁止)
      this.PC = 0;
      this.halted = false;
      this.callActive = false;
      this.speedHigh = true; // CSH(既定)/CSL。master clockに対するCPUサイクルの重み換算に使う
      this.lastDataAddr = -1;
    }

    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }
    fetchByte() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    fetchSigned() { const v = this.fetchByte(); return v < 0x80 ? v : v - 0x100; }
    read16(addr) { return this.read(addr) | (this.read((addr + 1) & 0xFFFF) << 8); }

    getFlag(mask) { return (this.P & mask) !== 0; }
    setFlag(mask, on) { this.P = on ? (this.P | mask) : (this.P & ~mask); }
    setZN(v) { v &= 0xFF; this.setFlag(F_Z, v === 0); this.setFlag(F_N, (v & 0x80) !== 0); }

    push(value) { this.write(0x2100 + this.S, value); this.S = (this.S - 1) & 0xFF; }
    pop() { this.S = (this.S + 1) & 0xFF; return this.read(0x2100 + this.S); }

    // ゼロページは実機で $2000-$20FF に固定配置されている(6280固有、通常の6502の
    // $0000-$00FFとは異なる。cc65 issue #317 等で確認済みの既知のハードウェア仕様。
    // PCE本体のI/Oは物理バンク$FFが割り当てられたMPRウィンドウにのみ現れ、通常
    // MPR1(論理$2000-$3FFF)はワークRAM(バンク$F8)に固定されるため、ゼロページ/スタックは
    // 素直にRAMへ到達する)。zpToAddr() で一括してこの+$2000オフセットを付与する。
    zpToAddr(zp) { return 0x2000 + (zp & 0xFF); }

    // ゼロページ,X/Y のインデックス計算(オフセット、0-255の枠内)。SET直後(Tフラグ立)の
    // 1命令だけ0xFFでラップしない(6280固有、マニュアル記載の"T=1のときのゼロページ,X"挙動。
    // ラップしない場合そのまま$20FFを超えて$21xx(スタックページ)側まで伸びうる)。
    zpIndexOffset(base, idx) {
      if (this.getFlag(F_T)) return (base + idx) & 0x1FF;
      return (base + idx) & 0xFF;
    }

    // --- オペランド取得(cpu6502.js と同じ設計。zpindを追加、zp系は$2000オフセット付き) ---
    fetchOperand(mode, skipRead = false) {
      let addr = null, value = 0, pageCrossed = false;
      switch (mode) {
        case 'imm': value = this.fetchByte(); break;
        case 'acc': value = this.A; break;
        case 'impl': break;
        case 'zp': addr = this.zpToAddr(this.fetchByte()); if (!skipRead) value = this.read(addr); break;
        case 'zpx': addr = 0x2000 + this.zpIndexOffset(this.fetchByte(), this.X); if (!skipRead) value = this.read(addr); break;
        case 'zpy': addr = 0x2000 + this.zpIndexOffset(this.fetchByte(), this.Y); if (!skipRead) value = this.read(addr); break;
        case 'zpind': { const zp = this.fetchByte(); addr = this.read(this.zpToAddr(zp)) | (this.read(this.zpToAddr((zp + 1) & 0xFF)) << 8); if (!skipRead) value = this.read(addr); break; }
        case 'abs': addr = this.read16(this.PC); this.PC = (this.PC + 2) & 0xFFFF; if (!skipRead) value = this.read(addr); break;
        case 'absx': {
          const base = this.read16(this.PC); this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.X) & 0xFFFF; pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr); break;
        }
        case 'absy': {
          const base = this.read16(this.PC); this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.Y) & 0xFFFF; pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr); break;
        }
        case 'indx': { const zp = (this.fetchByte() + this.X) & 0xFF; addr = this.read(this.zpToAddr(zp)) | (this.read(this.zpToAddr((zp + 1) & 0xFF)) << 8); if (!skipRead) value = this.read(addr); break; }
        case 'indy': {
          const zp = this.fetchByte();
          const base = this.read(this.zpToAddr(zp)) | (this.read(this.zpToAddr((zp + 1) & 0xFF)) << 8);
          addr = (base + this.Y) & 0xFFFF; pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr); break;
        }
        case 'rel': addr = this.fetchByte(); break;
        default: throw new Error(`未知のアドレッシングモード: ${mode}`);
      }
      // 直近の「メモリからのデータ読出し」の論理アドレス。DDA(PCM)キャプチャ
      // (hesPlayer.js captureHesSongAsync)が「$0806へ書かれたサンプル値はROMのどこから
      // 読まれたか」を突き止めるために参照する(hes2mml/expansion/dpcm.js冒頭コメント参照)。
      // skipRead(STA/STZ等のストア系。書込み先アドレスは読出しではない)とrel(分岐オフセット)
      // は除外する。実測(NX91002.hes)ではストリーミングループのLDA (zp)がここに残り、
      // 43142/43142件でROMバイトと書込み値が一致した。
      if (!skipRead && addr !== null && mode !== 'rel') this.lastDataAddr = addr;
      return { addr, value, pageCrossed };
    }

    writeOperand(mode, addr, value) {
      if (mode === 'acc') this.A = value & 0xFF; else this.write(addr, value);
    }

    // SETのTフラグは「直後の1命令」だけ有効(命令実行後に必ずクリアする)
    clearSetFlagIfNeeded(wasSet) { if (wasSet) this.setFlag(F_T, false); }

    step() {
      // 割込ディスパッチ: Iフラグがクリアで、busが未処理の割込ベクタを返せば分岐する。
      // BRKと違いBフラグは立てずに積む(標準65C02仕様)。
      if (!this.getFlag(F_I) && this.bus.pollIrq) {
        const vector = this.bus.pollIrq();
        if (vector >= 0) {
          this.push((this.PC >> 8) & 0xFF);
          this.push(this.PC & 0xFF);
          this.push(this.P & ~F_B);
          this.setFlag(F_I, true);
          this.setFlag(F_T, false); // 実機挙動未確認だが、割込を跨いでTフラグを持ち越す意味は無い
          this.PC = this.read16(vector);
          return 7; // 割込受付にかかる概算サイクル数
        }
      }
      // 番兵アドレス到達時は実フェッチを一切行わずアイドルする(HuC6280にWAI相当命令が無いための
      // 代替措置)。★重要な経緯: 当初は「INITがRTSで戻ってきたら$3FFF(ゼロ初期化RAM=BRK)へ
      // 落とし、BRK→IRQ2ベクタ→ゲーム側のスタブへ」という設計だったが、実測でHESのINITは
      // 本当にRTSで返ってくることが判明し(GBS/NSF等と違い稀なケースではなかった)、そのたびに
      // $4000番地以降の「たまたまBRKの戻り先計算で踏んでしまった、本来無関係なROMバイト列」を
      // 本物の命令として実行してしまっていた。これが実在の命令列に偶然似た(特に$FF=BBS7が
      // 0除算ならぬ「無限に0xFFを読み進むだけの安定した徘徊」を生む)ため一見動いているように
      // 見えるが、最終的に対応しないRTS(スタックアンダーフロー)を踏んでスタックが破壊され、
      // Iフラグが立ちっぱなしで割込が二度と発生しなくなる(音が1音で固まる/やがて完全に
      // ハングする)不具合の直接原因だった(NAPH-1011.hes/NX91002.hesの実測で確認)。
      // beginCall()が積む番兵($FFFF、cpu.js等の他CPUコアと同じCALL_SENTINEL)へPCが到達したら、
      // メモリ上の中身に関わらず「割込待ちでアイドル」させることで、この種の暴走を根治する。
      if (this.PC === CALL_SENTINEL) return 2;
      const wasSet = this.getFlag(F_T);
      const opcode = this.fetchByte();
      const def = OPS[opcode];
      let cycles;
      if (!def) {
        cycles = 2; // 6280は未定義オペコードが無いはずだが、防御的にNOP扱い
      } else {
        const extra = def.exec(this, def.mode);
        cycles = def.cycles + (extra || 0);
      }
      // TSTのようにmode自体がゼロページ,Xを内部で使う命令もzpIndexed経由でTを消費する。
      // ここで一括してクリアすることで「SET直後の命令」以外に影響が及ばないようにする。
      this.clearSetFlagIfNeeded(wasSet);
      return cycles;
    }

    call(addr, maxSteps = 500000) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF); this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      let steps = 0;
      while (this.PC !== CALL_SENTINEL && steps < maxSteps) { this.step(); steps++; }
      return steps;
    }

    beginCall(addr) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF); this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      this.callActive = true;
    }

    stepCall() {
      const c = this.step();
      if (this.PC === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  // --- 命令ハンドラ ---

  function binAdd(cpu, value, carryIn) {
    const sum = cpu.A + value + carryIn;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
  }
  // CMOS(65C02系)方式のBCD補正。Zは2進加算の結果から、N/Vは下位ニブル補正後の値から
  // 求める(WDC 65C02仕様。冒頭コメントの通り実機未検証の近似)。
  function decAdd(cpu, value, carryIn) {
    const a = cpu.A;
    let al = (a & 0x0F) + (value & 0x0F) + carryIn;
    let ah = (a >> 4) + (value >> 4);
    if (al > 9) { al += 6; }
    if (al > 0x0F) ah++;
    const preClampResult = ((ah & 0x0F) << 4) | (al & 0x0F);
    cpu.setFlag(F_Z, ((a + value + carryIn) & 0xFF) === 0);
    cpu.setFlag(F_N, (preClampResult & 0x80) !== 0);
    cpu.setFlag(F_V, (((a ^ value) & 0x80) === 0) && (((a ^ preClampResult) & 0x80) !== 0));
    if (ah > 9) ah += 6;
    cpu.setFlag(F_C, ah > 15);
    cpu.A = ((ah & 0x0F) << 4) | (al & 0x0F);
  }
  function ADC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    if (cpu.getFlag(F_D)) decAdd(cpu, op.value, c); else binAdd(cpu, op.value, c);
    return op.pageCrossed ? 1 : 0;
  }
  function decSub(cpu, value, carryIn) {
    const a = cpu.A;
    const binResult = (a - value - (1 - carryIn)) & 0xFF;
    let al = (a & 0x0F) - (value & 0x0F) - (1 - carryIn);
    let ah = (a >> 4) - (value >> 4);
    if (al < 0) { al -= 6; ah--; }
    if (ah < 0) ah -= 6;
    const sum = a - value - (1 - carryIn);
    cpu.setFlag(F_C, sum >= 0);
    cpu.setFlag(F_V, (((a ^ value) & 0x80) !== 0) && (((a ^ binResult) & 0x80) !== 0));
    cpu.setFlag(F_Z, binResult === 0);
    cpu.setFlag(F_N, (binResult & 0x80) !== 0);
    cpu.A = ((ah & 0x0F) << 4) | (al & 0x0F);
  }
  function SBC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    if (cpu.getFlag(F_D)) decSub(cpu, op.value, c);
    else binAdd(cpu, op.value ^ 0xFF, c);
    return op.pageCrossed ? 1 : 0;
  }

  function AND(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A &= op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function ORA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A |= op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function EOR(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A ^= op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }

  function ASL(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = (op.value << 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function LSR(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_C, (op.value & 0x01) !== 0); const r = (op.value >> 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function ROL(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 0x80) !== 0); const r = ((op.value << 1) | c) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function ROR(cpu, mode) { const op = cpu.fetchOperand(mode); const c = cpu.getFlag(F_C) ? 1 : 0; cpu.setFlag(F_C, (op.value & 0x01) !== 0); const r = ((op.value >> 1) | (c << 7)) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function INC(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value + 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }
  function DEC(cpu, mode) { const op = cpu.fetchOperand(mode); const r = (op.value - 1) & 0xFF; cpu.setZN(r); cpu.writeOperand(mode, op.addr, r); return 0; }

  function compare(cpu, reg, value) { const r = (reg - value) & 0x1FF; cpu.setFlag(F_C, reg >= value); cpu.setZN(r & 0xFF); }
  function CMP(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.A, op.value); return op.pageCrossed ? 1 : 0; }
  function CPX(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.X, op.value); return 0; }
  function CPY(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.Y, op.value); return 0; }

  function BIT(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_Z, (cpu.A & op.value) === 0);
    if (mode !== 'imm') { cpu.setFlag(F_V, (op.value & 0x40) !== 0); cpu.setFlag(F_N, (op.value & 0x80) !== 0); }
    return 0;
  }
  // TRB/TSB: メモリのZフラグ判定はBITと同じ(A&Mが0か)。TRBはMからAのビットを取り除き、
  // TSBはMへAのビットを立てる(いずれもN/Vは変化しない、65C02仕様)。
  function TSB(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_Z, (cpu.A & op.value) === 0); cpu.writeOperand(mode, op.addr, op.value | cpu.A); return 0; }
  function TRB(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.setFlag(F_Z, (cpu.A & op.value) === 0); cpu.writeOperand(mode, op.addr, op.value & ~cpu.A); return 0; }
  function STZ(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, 0); return 0; }

  function branch(cpu, mode, cond) {
    const op = cpu.fetchOperand(mode);
    if (!cond) return 0;
    const offset = op.addr < 0x80 ? op.addr : op.addr - 0x100;
    const oldPC = cpu.PC;
    cpu.PC = (cpu.PC + offset) & 0xFFFF;
    return (oldPC & 0xFF00) !== (cpu.PC & 0xFF00) ? 2 : 1;
  }

  function LDA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function LDX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.X = op.value; cpu.setZN(cpu.X); return op.pageCrossed ? 1 : 0; }
  function LDY(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.Y = op.value; cpu.setZN(cpu.Y); return op.pageCrossed ? 1 : 0; }
  function STA(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A); return 0; }
  function STX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.X); return 0; }
  function STY(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.Y); return 0; }

  function JMP(cpu, mode) {
    if (mode === 'abs') { cpu.PC = cpu.read16(cpu.PC); }
    else if (mode === 'abind') { const ptr = cpu.read16(cpu.PC); cpu.PC = cpu.read16(ptr); } // 65C02: ページ境界バグ無し
    else { const base = cpu.read16(cpu.PC); const ptr = (base + cpu.X) & 0xFFFF; cpu.PC = cpu.read16(ptr); } // abindx
    return 0;
  }
  function JSR(cpu) {
    const target = cpu.read16(cpu.PC);
    const ret = (cpu.PC + 1) & 0xFFFF;
    cpu.push((ret >> 8) & 0xFF); cpu.push(ret & 0xFF);
    cpu.PC = target;
    return 0;
  }
  function RTS(cpu) { const lo = cpu.pop(); const hi = cpu.pop(); cpu.PC = (((hi << 8) | lo) + 1) & 0xFFFF; return 0; }
  function BSR(cpu) {
    // BSR rel: 相対サブルーチン呼出(絶対番地ではなく符号付き8bitオフセット指定のJSR)。
    // JSRと同じく「命令末尾のアドレス」を積み、RTSが+1して次命令へ戻る。
    const d = cpu.fetchSigned();
    const retM1 = (cpu.PC - 1) & 0xFFFF;
    cpu.push((retM1 >> 8) & 0xFF); cpu.push(retM1 & 0xFF);
    cpu.PC = (cpu.PC + d) & 0xFFFF;
    return 0;
  }
  function BRK(cpu) {
    cpu.PC = (cpu.PC + 1) & 0xFFFF;
    cpu.push((cpu.PC >> 8) & 0xFF); cpu.push(cpu.PC & 0xFF);
    cpu.push(cpu.P | F_B);
    cpu.setFlag(F_I, true);
    cpu.setFlag(F_D, false); // 65C02はBRK/IRQでDフラグを自動クリアする
    cpu.PC = cpu.read16(0xFFF6); // HES: BRK/IRQ2ベクタ
    return 0;
  }
  function RTI(cpu) {
    cpu.P = cpu.pop() & ~F_B;
    const lo = cpu.pop(); const hi = cpu.pop();
    cpu.PC = (hi << 8) | lo;
    return 0;
  }

  function PHA(cpu) { cpu.push(cpu.A); return 0; }
  function PHX(cpu) { cpu.push(cpu.X); return 0; }
  function PHY(cpu) { cpu.push(cpu.Y); return 0; }
  function PHP(cpu) { cpu.push(cpu.P | F_B); return 0; }
  function PLA(cpu) { cpu.A = cpu.pop(); cpu.setZN(cpu.A); return 0; }
  function PLX(cpu) { cpu.X = cpu.pop(); cpu.setZN(cpu.X); return 0; }
  function PLY(cpu) { cpu.Y = cpu.pop(); cpu.setZN(cpu.Y); return 0; }
  function PLP(cpu) { cpu.P = cpu.pop() & ~F_B; return 0; }

  function TAX(cpu) { cpu.X = cpu.A; cpu.setZN(cpu.X); return 0; }
  function TAY(cpu) { cpu.Y = cpu.A; cpu.setZN(cpu.Y); return 0; }
  function TXA(cpu) { cpu.A = cpu.X; cpu.setZN(cpu.A); return 0; }
  function TYA(cpu) { cpu.A = cpu.Y; cpu.setZN(cpu.A); return 0; }
  function TSX(cpu) { cpu.X = cpu.S; cpu.setZN(cpu.X); return 0; }
  function TXS(cpu) { cpu.S = cpu.X; return 0; } // Zフラグ等は変化しない(標準6502仕様)
  // 6280固有のレジスタ交換/クリア命令
  function SXY(cpu) { const t = cpu.X; cpu.X = cpu.Y; cpu.Y = t; return 0; }
  function SAX(cpu) { const t = cpu.A; cpu.A = cpu.X; cpu.X = t; return 0; }
  function SAY(cpu) { const t = cpu.A; cpu.A = cpu.Y; cpu.Y = t; return 0; }
  function CLA(cpu) { cpu.A = 0; return 0; }
  function CLX(cpu) { cpu.X = 0; return 0; }
  function CLY(cpu) { cpu.Y = 0; return 0; }

  function INX(cpu) { cpu.X = (cpu.X + 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function INY(cpu) { cpu.Y = (cpu.Y + 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function DEX(cpu) { cpu.X = (cpu.X - 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function DEY(cpu) { cpu.Y = (cpu.Y - 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function INC_A(cpu) { cpu.A = (cpu.A + 1) & 0xFF; cpu.setZN(cpu.A); return 0; }
  function DEC_A(cpu) { cpu.A = (cpu.A - 1) & 0xFF; cpu.setZN(cpu.A); return 0; }

  function SEC(cpu) { cpu.setFlag(F_C, true); return 0; }
  function CLC(cpu) { cpu.setFlag(F_C, false); return 0; }
  function SEI(cpu) { cpu.setFlag(F_I, true); return 0; }
  function CLI(cpu) { cpu.setFlag(F_I, false); return 0; }
  function SED(cpu) { cpu.setFlag(F_D, true); return 0; }
  function CLD(cpu) { cpu.setFlag(F_D, false); return 0; }
  function CLV(cpu) { cpu.setFlag(F_V, false); return 0; }
  function SET(cpu) { cpu.setFlag(F_T, true); return 0; }
  // CSH/CSL: CPU速度切替(High=7.16MHz相当/Low=1.79MHz相当)。命令自体の効果はフラグ切替のみ
  // (hesPlayer.js側がcpu.speedHighを見てCPUサイクル→マスタークロックティックの換算比を変える)。
  function CSH(cpu) { cpu.speedHigh = true; return 0; }
  function CSL(cpu) { cpu.speedHigh = false; return 0; }

  function NOP(cpu, mode) { if (mode !== 'impl') cpu.fetchOperand(mode); return 0; }

  // ST0/ST1/ST2: 即値1byteをそれぞれ $0000/$0002/$0003 (HuC6270 VDCポート) へ直接ストアする
  // 専用命令(通常のSTAより1byte短い・高速)。bus経由で書くのでMMU/I/O分岐は自然に効く。
  function ST0(cpu) { const v = cpu.fetchByte(); cpu.write(0x0000, v); return 0; }
  function ST1(cpu) { const v = cpu.fetchByte(); cpu.write(0x0002, v); return 0; }
  function ST2(cpu) { const v = cpu.fetchByte(); cpu.write(0x0003, v); return 0; }

  // TAMi/TMAi: オペランドはビットマスク(bit0=MPR0 .. bit7=MPR7)。セットされている全bitに
  // 対しAを書き込む/読み出す(複数bit同時指定可、TMAは該当する最初のMPRを返す)。
  function TAMi(cpu) {
    const mask = cpu.fetchByte();
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) cpu.bus.setMpr(i, cpu.A);
    return 0;
  }
  function TMAi(cpu) {
    const mask = cpu.fetchByte();
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) { cpu.A = cpu.bus.getMpr(i); break; }
    return 0;
  }

  // TST #nn,target: target(zp/zpx/abs/absx)の値と即値nnをANDしてN/Zを更新する(Aは変化しない)。
  // Vフラグは変化しない(BITと違い、この命令の対象はメモリ即値マスクでしかない)。
  function TST(cpu, mode) {
    const imm = cpu.fetchByte();
    const op = cpu.fetchOperand(mode);
    const r = imm & op.value;
    cpu.setFlag(F_Z, r === 0);
    cpu.setFlag(F_N, (imm & 0x80) !== 0); // 65C02系実装の通例(即値のbit7をNへ反映)
    return 0;
  }

  // RMBi/SMBi: ゼロページのbit iをクリア/セットする。BBRi/BBSi: 同bitが0/1なら分岐する
  // (65C02標準、opcodeのy=bit3-5相当が命令テーブル生成時にbitIndexとして渡される)。
  function RMB(cpu, bit) { const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); cpu.write(zp, v & ~(1 << bit)); return 0; }
  function SMB(cpu, bit) { const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); cpu.write(zp, v | (1 << bit)); return 0; }
  function BBR(cpu, bit) {
    const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); const d = cpu.fetchSigned();
    if (((v >> bit) & 1) === 0) { cpu.PC = (cpu.PC + d) & 0xFFFF; return 2; }
    return 0;
  }
  function BBS(cpu, bit) {
    const zp = cpu.zpToAddr(cpu.fetchByte()); const v = cpu.read(zp); const d = cpu.fetchSigned();
    if (((v >> bit) & 1) === 1) { cpu.PC = (cpu.PC + d) & 0xFFFF; return 2; }
    return 0;
  }

  // TII/TDD/TIA/TAI/TIN: 7byte命令(opcode,SL,SH,DL,DH,LL,LH)。srcMode/dstModeはそれぞれ
  // 'inc'|'dec'|'alt'|'fix'。lengthが0なら65536byte転送。cycles=17+6*count(マニュアル値)。
  function blockTransfer(cpu, srcMode, dstMode) {
    let src = cpu.fetchByte() | (cpu.fetchByte() << 8);
    let dst = cpu.fetchByte() | (cpu.fetchByte() << 8);
    let len = cpu.fetchByte() | (cpu.fetchByte() << 8);
    const count = len === 0 ? 0x10000 : len;
    let altToggle = 0; // TIA/TAIの"alternate"側で使う+1/-1の交互パターン
    for (let i = 0; i < count; i++) {
      const value = cpu.read(src);
      cpu.write(dst, value);
      if (srcMode === 'inc') src = (src + 1) & 0xFFFF;
      else if (srcMode === 'dec') src = (src - 1) & 0xFFFF;
      else if (srcMode === 'alt') { src = (src + (altToggle === 0 ? 1 : -1)) & 0xFFFF; }
      if (dstMode === 'inc') dst = (dst + 1) & 0xFFFF;
      else if (dstMode === 'dec') dst = (dst - 1) & 0xFFFF;
      else if (dstMode === 'alt') { dst = (dst + (altToggle === 0 ? 1 : -1)) & 0xFFFF; }
      // 'fix'は据え置き
      altToggle ^= 1;
    }
    cpu.setFlag(F_Z, true); // マニュアル: 転送後Z=1固定 (T列以外は"-"だがZだけ明示的に0扱いの記述あり、安全側でZ=1にしておく)
    return 6 * count; // 基本17サイクルはOPS側cyclesに含める。追加分のみここで返す
  }
  function TII(cpu) { return blockTransfer(cpu, 'inc', 'inc'); }
  function TDD(cpu) { return blockTransfer(cpu, 'dec', 'dec'); }
  function TIA(cpu) { return blockTransfer(cpu, 'inc', 'alt'); }
  function TAI(cpu) { return blockTransfer(cpu, 'alt', 'inc'); }
  function TIN(cpu) { return blockTransfer(cpu, 'inc', 'fix'); }

  // mnemonic -> {mode: [opcodeByte, cycles]}
  const TABLE = {
    ADC: { fn: ADC, modes: { imm: [0x69, 2], zp: [0x65, 4], zpx: [0x75, 4], zpind: [0x72, 7], abs: [0x6D, 5], absx: [0x7D, 5], absy: [0x79, 5], indx: [0x61, 7], indy: [0x71, 7] } },
    AND: { fn: AND, modes: { imm: [0x29, 2], zp: [0x25, 4], zpx: [0x35, 4], zpind: [0x32, 7], abs: [0x2D, 5], absx: [0x3D, 5], absy: [0x39, 5], indx: [0x21, 7], indy: [0x31, 7] } },
    ASL: { fn: ASL, modes: { acc: [0x0A, 2], zp: [0x06, 6], zpx: [0x16, 6], abs: [0x0E, 6], absx: [0x1E, 7] } },
    BCC: { fn: (c, m) => branch(c, m, !c.getFlag(F_C)), modes: { rel: [0x90, 2] } },
    BCS: { fn: (c, m) => branch(c, m, c.getFlag(F_C)), modes: { rel: [0xB0, 2] } },
    BEQ: { fn: (c, m) => branch(c, m, c.getFlag(F_Z)), modes: { rel: [0xF0, 2] } },
    BMI: { fn: (c, m) => branch(c, m, c.getFlag(F_N)), modes: { rel: [0x30, 2] } },
    BNE: { fn: (c, m) => branch(c, m, !c.getFlag(F_Z)), modes: { rel: [0xD0, 2] } },
    BPL: { fn: (c, m) => branch(c, m, !c.getFlag(F_N)), modes: { rel: [0x10, 2] } },
    BVC: { fn: (c, m) => branch(c, m, !c.getFlag(F_V)), modes: { rel: [0x50, 2] } },
    BVS: { fn: (c, m) => branch(c, m, c.getFlag(F_V)), modes: { rel: [0x70, 2] } },
    BRA: { fn: (c, m) => branch(c, m, true), modes: { rel: [0x80, 4] } },
    BIT: { fn: BIT, modes: { imm: [0x89, 2], zp: [0x24, 4], zpx: [0x34, 4], abs: [0x2C, 5], absx: [0x3C, 5] } },
    BRK: { fn: BRK, modes: { impl: [0x00, 8] } },
    BSR: { fn: BSR, modes: { rel: [0x44, 8] } },
    CLC: { fn: CLC, modes: { impl: [0x18, 2] } },
    CLD: { fn: CLD, modes: { impl: [0xD8, 2] } },
    CLI: { fn: CLI, modes: { impl: [0x58, 2] } },
    CLV: { fn: CLV, modes: { impl: [0xB8, 2] } },
    CLA: { fn: CLA, modes: { impl: [0x62, 2] } },
    CLX: { fn: CLX, modes: { impl: [0x82, 2] } },
    CLY: { fn: CLY, modes: { impl: [0xC2, 2] } },
    CSH: { fn: CSH, modes: { impl: [0xD4, 3] } },
    CSL: { fn: CSL, modes: { impl: [0x54, 3] } },
    CMP: { fn: CMP, modes: { imm: [0xC9, 2], zp: [0xC5, 4], zpx: [0xD5, 4], zpind: [0xD2, 7], abs: [0xCD, 5], absx: [0xDD, 5], absy: [0xD9, 5], indx: [0xC1, 7], indy: [0xD1, 7] } },
    CPX: { fn: CPX, modes: { imm: [0xE0, 2], zp: [0xE4, 4], abs: [0xEC, 5] } },
    CPY: { fn: CPY, modes: { imm: [0xC0, 2], zp: [0xC4, 4], abs: [0xCC, 5] } },
    DEC: { fn: DEC, modes: { acc: [0x3A, 2], zp: [0xC6, 6], zpx: [0xD6, 6], abs: [0xCE, 6], absx: [0xDE, 7] } },
    DEX: { fn: DEX, modes: { impl: [0xCA, 2] } },
    DEY: { fn: DEY, modes: { impl: [0x88, 2] } },
    EOR: { fn: EOR, modes: { imm: [0x49, 2], zp: [0x45, 4], zpx: [0x55, 4], zpind: [0x52, 7], abs: [0x4D, 5], absx: [0x5D, 5], absy: [0x59, 5], indx: [0x41, 7], indy: [0x51, 7] } },
    INC: { fn: INC, modes: { acc: [0x1A, 2], zp: [0xE6, 6], zpx: [0xF6, 6], abs: [0xEE, 6], absx: [0xFE, 7] } },
    INX: { fn: INX, modes: { impl: [0xE8, 2] } },
    INY: { fn: INY, modes: { impl: [0xC8, 2] } },
    JMP: { fn: JMP, modes: { abs: [0x4C, 4], abind: [0x6C, 7], abindx: [0x7C, 7] } },
    JSR: { fn: JSR, modes: { abs: [0x20, 7] } },
    LDA: { fn: LDA, modes: { imm: [0xA9, 2], zp: [0xA5, 4], zpx: [0xB5, 4], zpind: [0xB2, 7], abs: [0xAD, 5], absx: [0xBD, 5], absy: [0xB9, 5], indx: [0xA1, 7], indy: [0xB1, 7] } },
    LDX: { fn: LDX, modes: { imm: [0xA2, 2], zp: [0xA6, 4], zpy: [0xB6, 4], abs: [0xAE, 5], absy: [0xBE, 5] } },
    LDY: { fn: LDY, modes: { imm: [0xA0, 2], zp: [0xA4, 4], zpx: [0xB4, 4], abs: [0xAC, 5], absx: [0xBC, 5] } },
    LSR: { fn: LSR, modes: { acc: [0x4A, 2], zp: [0x46, 6], zpx: [0x56, 6], abs: [0x4E, 6], absx: [0x5E, 7] } },
    NOP: { fn: NOP, modes: { impl: [0xEA, 2] } },
    ORA: { fn: ORA, modes: { imm: [0x09, 2], zp: [0x05, 4], zpx: [0x15, 4], zpind: [0x12, 7], abs: [0x0D, 5], absx: [0x1D, 5], absy: [0x19, 5], indx: [0x01, 7], indy: [0x11, 7] } },
    PHA: { fn: PHA, modes: { impl: [0x48, 3] } },
    PHX: { fn: PHX, modes: { impl: [0xDA, 3] } },
    PHY: { fn: PHY, modes: { impl: [0x5A, 3] } },
    PHP: { fn: PHP, modes: { impl: [0x08, 3] } },
    PLA: { fn: PLA, modes: { impl: [0x68, 4] } },
    PLX: { fn: PLX, modes: { impl: [0xFA, 4] } },
    PLY: { fn: PLY, modes: { impl: [0x7A, 4] } },
    PLP: { fn: PLP, modes: { impl: [0x28, 4] } },
    ROL: { fn: ROL, modes: { acc: [0x2A, 2], zp: [0x26, 6], zpx: [0x36, 6], abs: [0x2E, 6], absx: [0x3E, 7] } },
    ROR: { fn: ROR, modes: { acc: [0x6A, 2], zp: [0x66, 6], zpx: [0x76, 6], abs: [0x6E, 6], absx: [0x7E, 7] } },
    RTI: { fn: RTI, modes: { impl: [0x40, 7] } },
    RTS: { fn: RTS, modes: { impl: [0x60, 7] } },
    SAX: { fn: SAX, modes: { impl: [0x22, 3] } },
    SAY: { fn: SAY, modes: { impl: [0x42, 3] } },
    SBC: { fn: SBC, modes: { imm: [0xE9, 2], zp: [0xE5, 4], zpx: [0xF5, 4], zpind: [0xF2, 7], abs: [0xED, 5], absx: [0xFD, 5], absy: [0xF9, 5], indx: [0xE1, 7], indy: [0xF1, 7] } },
    SEC: { fn: SEC, modes: { impl: [0x38, 2] } },
    SED: { fn: SED, modes: { impl: [0xF8, 2] } },
    SEI: { fn: SEI, modes: { impl: [0x78, 2] } },
    SET: { fn: SET, modes: { impl: [0xF4, 2] } },
    STA: { fn: STA, modes: { zp: [0x85, 4], zpx: [0x95, 4], zpind: [0x92, 7], abs: [0x8D, 5], absx: [0x9D, 5], absy: [0x99, 5], indx: [0x81, 7], indy: [0x91, 7] } },
    STX: { fn: STX, modes: { zp: [0x86, 4], zpy: [0x96, 4], abs: [0x8E, 5] } },
    STY: { fn: STY, modes: { zp: [0x84, 4], zpx: [0x94, 4], abs: [0x8C, 5] } },
    STZ: { fn: STZ, modes: { zp: [0x64, 4], zpx: [0x74, 4], abs: [0x9C, 5], absx: [0x9E, 5] } },
    SXY: { fn: SXY, modes: { impl: [0x02, 3] } },
    TAX: { fn: TAX, modes: { impl: [0xAA, 2] } },
    TAY: { fn: TAY, modes: { impl: [0xA8, 2] } },
    TSX: { fn: TSX, modes: { impl: [0xBA, 2] } },
    TXA: { fn: TXA, modes: { impl: [0x8A, 2] } },
    TXS: { fn: TXS, modes: { impl: [0x9A, 2] } },
    TYA: { fn: TYA, modes: { impl: [0x98, 2] } },
    TRB: { fn: TRB, modes: { zp: [0x14, 6], abs: [0x1C, 7] } },
    TSB: { fn: TSB, modes: { zp: [0x04, 6], abs: [0x0C, 7] } },
    ST0: { fn: ST0, modes: { impl: [0x03, 4] } },
    ST1: { fn: ST1, modes: { impl: [0x13, 4] } },
    ST2: { fn: ST2, modes: { impl: [0x23, 4] } },
    TAM: { fn: TAMi, modes: { impl: [0x53, 5] } },
    TMA: { fn: TMAi, modes: { impl: [0x43, 4] } },
    TII: { fn: TII, modes: { impl: [0x73, 17] } },
    TDD: { fn: TDD, modes: { impl: [0xC3, 17] } },
    TIA: { fn: TIA, modes: { impl: [0xE3, 17] } },
    TAI: { fn: TAI, modes: { impl: [0xF3, 17] } },
    TIN: { fn: TIN, modes: { impl: [0xD3, 17] } }
  };

  const OPS = new Array(256).fill(null);
  for (const mnemonic in TABLE) {
    const { fn, modes } = TABLE[mnemonic];
    for (const mode in modes) {
      const [byte, cycles] = modes[mode];
      OPS[byte] = { mnemonic, mode, exec: fn, cycles };
    }
  }
  // TST: y(row)ごとにアドレッシングモードが異なる特殊系列(imm+target二重オペランド)
  OPS[0x83] = { mnemonic: 'TST', mode: 'zp', exec: TST, cycles: 7 };
  OPS[0x93] = { mnemonic: 'TST', mode: 'abs', exec: TST, cycles: 8 };
  OPS[0xA3] = { mnemonic: 'TST', mode: 'zpx', exec: TST, cycles: 7 };
  OPS[0xB3] = { mnemonic: 'TST', mode: 'absx', exec: TST, cycles: 8 };
  // RMBi/SMBi/BBRi/BBSi: 8本ずつ、opcode下位ニブルは固定(x7/xF)、上位ニブルがbit index
  for (let bit = 0; bit < 8; bit++) {
    OPS[bit * 0x10 + 0x07] = { mnemonic: `RMB${bit}`, mode: 'impl', exec: (c) => RMB(c, bit), cycles: 7 };
    OPS[bit * 0x10 + 0x87] = { mnemonic: `SMB${bit}`, mode: 'impl', exec: (c) => SMB(c, bit), cycles: 7 };
    OPS[bit * 0x10 + 0x0F] = { mnemonic: `BBR${bit}`, mode: 'impl', exec: (c) => BBR(c, bit), cycles: 6 };
    OPS[bit * 0x10 + 0x8F] = { mnemonic: `BBS${bit}`, mode: 'impl', exec: (c) => BBS(c, bit), cycles: 6 };
  }

  Emu.CPUHuC6280 = CPUHuC6280;
  Emu.HUC6280_FLAGS = { C: F_C, Z: F_Z, I: F_I, D: F_D, B: F_B, T: F_T, V: F_V, N: F_N };
  Emu.HUC6280_OPS = OPS;
})(globalThis);

/*
 * HuC6280内蔵PSG (PC Engine/TurboGrafx-16 プログラマブルサウンドジェネレータ) エミュレータ
 * MML.Emu.APUHuC6280
 *
 * 6チャンネル、各chが32サンプル・5bit符号無しの波形メモリを持つ(waveform playback)。
 * ch4/5のみノイズ生成機能を追加で持つ(bit7=noise on/offでch毎に波形出力とノイズ出力が
 * 排他)。各chは「Direct D/A」モードに切替可能(波形メモリ経由せず書込み値を直接出力、
 * 音声ストリーミング再生に使う)。LFO(周波数変調、ch0をch1のFM変調)は実機に存在するが
 * 音楽ドライバでの利用例が乏しく、参考実装(Game_Music_Emu)も自ら「未対応」と明記している
 * 機能のため本実装でも対象外とする。
 *
 * 参考: "PC Engine Hardware: PSG" by Paul Clifford (magicengine.com/mkit) — レジスタ配置・
 *   周波数換算式($0802/0803, $0807)の一次資料。ボリューム/バランスの対数合成式は実測に
 *   基づく独自導出(32段・約1.5dB/stepの減衰特性という文献記載の"事実"から関数化した
 *   ものであり、既存実装のテーブルを転記したものではない。詳細はgainFromIndex参照)。
 *
 * clock() を PSGクロック(3579545Hz。NTSCカラーバースト、HES.PSG_CLOCK)ごとに1回呼び出す
 * 設計(apu2a03.js/apuGb.jsと同じ考え方)。マスタークロック(7159090Hz)側のCPUと同期させる
 * hesPlayer.js は、CPU 2サイクルにつきPSG clock()を1回、という比で駆動する
 * (7159090 / 3579545 = 2ちょうど)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const WAVE_LEN = 32;
  const CH_COUNT = 6;

  // 32段(0-31)の対数ゲインテーブル。文献記載の「~1.5dB/step、31=1.0倍、0=無音」という
  // 減衰特性から作る(2^((n-31)/4) は 4step=6dB=電圧半減 の等比数列。1step≒1.505dB相当で
  // 文献の記述と整合する)。
  function gainFromIndex(n) {
    n = Math.max(0, Math.min(31, n | 0));
    return n === 0 ? 0 : Math.pow(2, (n - 31) / 4);
  }

  class PsgChannel {
    constructor(hasNoise) {
      this.hasNoise = !!hasNoise;
      this.wave = new Uint8Array(WAVE_LEN);
      this.wavePos = 0;    // 読出/書込 共有ポインタ(実機仕様、wavePlayback.js冒頭コメント参照)
      this.freq = 0;       // 12bit周期レジスタ($0802/$0803)
      this.control = 0;    // $0804: bit7=ch on, bit6=DDA, bit4-0=volume
      this.balance = 0xFF; // $0805: bit7-4=left, bit3-0=right
      this.dac = 0;        // DDAモード時の直接出力値(0-31)
      this.noiseCtrl = 0;  // $0807 (ch4/5のみ有効): bit7=on, bit4-0=noise period select
      this.lfsr = this.hasNoise ? 1 : 0;
      this.wavePhaseAcc = 0;  // PSGクロック単位の波形読出しタイマ(小数を持たず整数カウントダウン)
      this.noisePhaseAcc = 0;
      this.noiseOut = 0; // ノイズLFSRの現在ビット(0/1)由来の出力値(0 or 31)
    }

    reset() {
      this.wave.fill(0);
      this.wavePos = 0;
      this.freq = 0;
      this.control = 0;
      this.balance = 0xFF;
      this.dac = 0;
      this.noiseCtrl = 0;
      this.lfsr = this.hasNoise ? 1 : 0;
      this.wavePhaseAcc = 0;
      this.noisePhaseAcc = 0;
      this.noiseOut = 0;
    }

    get on() { return (this.control & 0x80) !== 0; }
    get dda() { return (this.control & 0x40) !== 0; }
    get volume() { return this.control & 0x1F; }

    writeControl(value) {
      // DDAモードが1→0へ落ちた瞬間、波形の読出/書込ポインタが先頭へリセットされる
      // (実機仕様。$0806での波形テーブル再ロードを先頭から行うための挙動)。
      if ((this.control & 0x40) && !(value & 0x40)) this.wavePos = 0;
      this.control = value;
    }

    writeData(value) {
      value &= 0x1F;
      if (!this.dda) {
        this.wave[this.wavePos] = value;
        this.wavePos = (this.wavePos + 1) & (WAVE_LEN - 1);
      } else if (this.on) {
        this.dac = value;
      }
    }

    // PSGクロック1tickぶん波形読出し位相・ノイズ位相を進める。HesReplayStreamPlayer
    // (src/audio/hes-stream-player.js)のリアルタイム再生が1サンプルあたり数十回
    // 直接呼ぶホットパスのため、clockBy(1)経由(関数呼出しが1段増える)にはせず
    // 従来通りその場で計算する(clockBy()と結果は数学的に同一)。
    clock() {
      if (this.on && !this.dda && this.freq > 0) {
        this.wavePhaseAcc++;
        if (this.wavePhaseAcc >= this.freq) {
          this.wavePhaseAcc = 0;
          this.wavePos = (this.wavePos + 1) & (WAVE_LEN - 1);
        }
      }
      if (this.hasNoise && this.on && (this.noiseCtrl & 0x80)) {
        const invVal = Math.max(1, (~this.noiseCtrl) & 0x1F);
        const periodTicks = invVal * 64;
        this.noisePhaseAcc++;
        if (this.noisePhaseAcc >= periodTicks) {
          this.noisePhaseAcc -= periodTicks;
          const bit = (this.lfsr & 1) ^ ((this.lfsr >> 3) & 1);
          this.lfsr = ((this.lfsr >> 1) | (bit << 16)) & 0x1FFFF;
          this.noiseOut = (this.lfsr & 1) ? 31 : 0;
        }
      }
    }

    // clock()のnティック分バッチ版(数学的にclock()をn回呼ぶのと同値)。
    // リアルタイム再生時の「がくがく」対策(hesBus.js clockBy()と同じ理由。
    // hesPlayer.js renderFrame()冒頭コメント参照)。波形位相(wavePhaseAcc)は単純な
    // 折り返しカウンタなので割り算でO(1)に飛ばせる。ノイズのLFSRは1tickごとの
    // シフト演算(状態遷移)そのものが出力なので数学的に一括計算はできないが、
    // 1オーディオサンプルあたりの折り返し回数は周期が最速でも64tickなので
    // (n≈162tick/サンプルに対し)たかだか数回で済み、単純ループのままで十分軽い。
    clockBy(n) {
      if (n <= 0) return;
      if (this.on && !this.dda && this.freq > 0) {
        // period=0は「無限に長い周期」= 実質フリーズ(0除算回避、聴感上ほぼ無音相当)。
        const period = this.freq;
        let acc = this.wavePhaseAcc + n;
        if (acc >= period) {
          const steps = Math.floor(acc / period);
          acc -= steps * period;
          this.wavePos = (this.wavePos + steps) & (WAVE_LEN - 1);
        }
        this.wavePhaseAcc = acc;
      }
      if (this.hasNoise && this.on && (this.noiseCtrl & 0x80)) {
        // 周波数式(文献): freq = PSG_CLOCK / (64 * (5bit値 XOR 31))。生値31(XOR後0)は
        // 0除算になるため最小周期1として扱う(実機は最高速のはず、という近似)。
        const invVal = Math.max(1, (~this.noiseCtrl) & 0x1F);
        const periodTicks = invVal * 64;
        let acc = this.noisePhaseAcc + n;
        if (acc >= periodTicks) {
          const steps = Math.floor(acc / periodTicks);
          acc -= steps * periodTicks;
          // 1bit LFSR(周期性が明確な単純フィボナッチ型)。実機の正確なタップ位置は資料が
          // 無いため、聴感上の「ホワイトノイズらしさ」を優先した17bit LFSR(タップ0,3)を採用
          // (2A03/GBのノイズと同種の近似。正確な多項式はハードウェア未公開)。
          for (let s = 0; s < steps; s++) {
            const bit = (this.lfsr & 1) ^ ((this.lfsr >> 3) & 1);
            this.lfsr = ((this.lfsr >> 1) | (bit << 16)) & 0x1FFFF;
          }
          this.noiseOut = (this.lfsr & 1) ? 31 : 0;
        }
        this.noisePhaseAcc = acc;
      }
    }

    // 現在の生サンプル値(0-31)
    rawSample() {
      if (!this.on) return 0;
      if (this.dda) return this.dac;
      if (this.hasNoise && (this.noiseCtrl & 0x80)) return this.noiseOut;
      return this.wave[this.wavePos];
    }

    // (left, right) の実効ゲイン(0.0-1.0)を返す。$0805(ch balance)と全体balanceを
    // 減算合成する(文献の"vol = chVol - 60、L = vol + chL*2 + gL*2"という式を再構成)。
    gainLR(globalBalance) {
      const vol = this.volume - 0x1E * 2;
      const lPan = (this.balance >> 4) & 0x0F, rPan = this.balance & 0x0F;
      const gL = (globalBalance >> 4) & 0x0F, gR = globalBalance & 0x0F;
      const left = Math.max(0, vol + lPan * 2 + gL * 2);
      const right = Math.max(0, vol + rPan * 2 + gR * 2);
      return { left: gainFromIndex(left), right: gainFromIndex(right) };
    }
  }

  class APUHuC6280 {
    constructor() {
      this.ch = [];
      for (let i = 0; i < CH_COUNT; i++) this.ch.push(new PsgChannel(i >= 4));
      this.selected = 0;   // $0800: 操作対象ch(bit2-0)
      this.balance = 0xFF; // $0801: 全体バランス
      this.mute = { ch0: false, ch1: false, ch2: false, ch3: false, ch4: false, ch5: false };
      this.vol = { ch0: 1, ch1: 1, ch2: 1, ch3: 1, ch4: 1, ch5: 1 };
    }

    reset() {
      for (const c of this.ch) c.reset();
      this.selected = 0;
      this.balance = 0xFF;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x0800: this.selected = value & 0x07; return;
        case 0x0801: this.balance = value; return;
      }
      if (this.selected >= CH_COUNT) return; // ch6/7は存在しない(書込みは無視)
      const c = this.ch[this.selected];
      switch (addr) {
        case 0x0802: c.freq = (c.freq & 0xF00) | value; return;
        case 0x0803: c.freq = (c.freq & 0x0FF) | ((value & 0x0F) << 8); return;
        case 0x0804: c.writeControl(value); return;
        case 0x0805: c.balance = value; return;
        case 0x0806: c.writeData(value); return;
        case 0x0807: c.noiseCtrl = value; return;
        // 0x0808/0x0809 = LFO周波数/制御。冒頭コメントの通り本実装では対象外(無視のみ)。
        default: return;
      }
    }

    readRegister(addr) {
      // PSGは基本ライトオンリー(実機もリードは未定義動作に近い)。読み出し依存の曲は
      // 想定しないため0を返す(hesBus.js側で他I/Oと衝突しないよう明示的にここへ来る)。
      return 0;
    }

    // PSGクロック(3579545Hz)ごとに1回呼ぶ
    clock() {
      for (const c of this.ch) c.clock();
    }

    // clock()のnティック分バッチ版。hesPlayer.js renderFrame()から使う(冒頭コメント参照)。
    clockBy(n) {
      for (const c of this.ch) c.clockBy(n);
    }

    /**
     * 現在の出力レベルを {left, right}(概ね-1.0〜1.0)で返す。6ch分のL/Rゲイン付き
     * サンプルをそれぞれのバスへ合算して正規化する。基準は「0-31を中心±15.5とみなした
     * 振幅×ゲイン」の合計を6ch分見込んだスケール。
     * ★旧実装は(left+right)*0.5でモノラル化していた。センター定位(gainLRがleft=rightを
     * 返すch)では平均してもモノラル値と一致するため、L/Rを別々に積むだけでモノラル時と
     * 同じ音量感を保ったままステレオ分離できる。
     */
    mixSample() {
      let sumL = 0, sumR = 0;
      for (let i = 0; i < CH_COUNT; i++) {
        if (this.mute['ch' + i]) continue;
        const c = this.ch[i];
        const raw = (c.rawSample() - 16) * this.vol['ch' + i]; // 0-31を中心0付近へ(±16相当)
        const { left, right } = c.gainLR(this.balance);
        sumL += raw * left;
        sumR += raw * right;
      }
      return { left: sumL / (16 * CH_COUNT), right: sumR / (16 * CH_COUNT) };
    }

    /**
     * mixSample()と同じ正規化(6ch分を単純合算するとmixSample()の返す値に一致する)で、
     * 6chぶんを合算せず個別の配列で返す。hes-stream-player.js HesBufferedPlayerが
     * 「chごとに別々のAudioBufferチャンネルへ書き出し、再生をリアルタイムミュート
     * できるようにする」ために使う(mixSample()は合算済みで後からミュートできないため)。
     * mute(this.mute)はここでは見ない — ミュートは録音後にGainNodeで即時に効かせる設計
     * (録音時にミュートを焼き込むと、再生中のミュート切替に再レンダリングが必要になり
     * 本末転倒なため)。
     */
    mixChannelSamples() {
      const result = new Array(CH_COUNT);
      for (let i = 0; i < CH_COUNT; i++) {
        const c = this.ch[i];
        const raw = c.rawSample() - 16;
        const { left, right } = c.gainLR(this.balance);
        result[i] = (raw * (left + right) * 0.5) / (16 * CH_COUNT);
      }
      return result;
    }
  }

  // 鍵盤表示/ロール用ライブスナップショット(snapshotGbApu等と同じ考え方)。
  // panL/panR: $0805(chバランス)の上位/下位ニブル(0-15、鍵盤表示のL/R列用)。
  // 戻り値の配列自体にglobalPanL/globalPanR($0801、全体バランス)も生やしておく
  // (main.js liveHesApu()参照。ch単位ではないため配列要素にはせず配列のプロパティとして持たせる)。
  Emu.snapshotHuC6280Apu = function (apu) {
    const arr = apu.ch.map((c, i) => {
      const freqHz = (c.on && !c.dda && c.freq > 0) ? MML.HES.PSG_CLOCK / (32 * c.freq) : 0;
      const noiseOn = c.hasNoise && c.on && (c.noiseCtrl & 0x80) !== 0;
      return {
        on: c.on, dda: c.dda, noiseOn,
        freq: freqHz, vol: c.volume / 31, rawVol: c.volume,
        wave: Array.from(c.wave, v => v / 15.5 - 1),
        active: c.on && c.volume > 0 && (c.dda || noiseOn || freqHz > 0),
        panL: (c.balance >> 4) & 0x0F, panR: c.balance & 0x0F
      };
    });
    arr.globalPanL = (apu.balance >> 4) & 0x0F;
    arr.globalPanR = apu.balance & 0x0F;
    return arr;
  };

  Emu.APUHuC6280 = APUHuC6280;
  Emu.APUHuC6280_CH_COUNT = CH_COUNT;
  Emu.APUHuC6280_WAVE_LEN = WAVE_LEN;
})(globalThis);

/*
 * HES(PC Engine)実行用メモリバス + 最小限のハードウェア(MMU/タイマ/割込コントローラ/VDC)
 * MML.Emu.HesBus
 *
 * HuC6280のMMU: 8個のMPR(Memory Page Register、TAM/TMAで読み書き)が論理アドレス空間
 * $0000-$FFFF を8KB単位8ページに分割し、各ページに物理バンク番号(0-255、1バンク=8KB、
 * 256バンク=2MB)を割り当てる。物理バンク $00-$7F がDATAブロック(HESヘッダのaddr以降)、
 * $F8=ワークRAM、$F9-$FB=SuperGrafx拡張RAM、$FF=I/O空間(PSG/タイマ/割込コントローラ/VDC等)、
 * それ以外($80-$F7、$FC-$FE)は未マップ(0xFF固定)。
 *
 * ★GBS/NSF/KSSと異なり、HESヘッダにはPLAYアドレスが存在しない(INITアドレスのみ)。
 * 実機は「タイマ割込またはVDCの垂直帰線割込のハンドラ」としてPLAY相当の処理を呼ぶ設計で、
 * そのハンドラのアドレスはヘッダにもDATAブロックの固定位置にも存在せず、ゲーム本体の
 * 割込ベクタテーブル($FFF6-$FFFF、DATAブロックの一部としてROMに含まれる)経由でしか
 * わからない。そのため本ツールは(GBS等の簡略化と違い)本物のIRQディスパッチ
 * (Iフラグ・BRK/IRQ/RTI)をcpuHuC6280.js側に実装し、このバスはタイマ/VDC垂直帰線の
 * 実際のハードウェア挙動(割込要求の発生・マスク・確認)を再現する。
 *
 * 参考: Hes_Core.h/.cpp(Game_Music_Emu, kode54/Game_Music_Emu)のレジスタ挙動を実装から
 *   直接確認した上で、コードは移植せずクリーンルームで再実装(vector値$FFF6/$FFF8/$FFFAは
 *   HuC6280 CMOS Software Manual のBRK命令の記述($FFF6/$FFF7)から確認、IRQ1/TIQは
 *   cpu_done()が返す"reason code"(0x08/0x0A)が$FFF0起点のベクタ下位byteだったことから
 *   逆算して確認した)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PAGE_SIZE = 0x2000;
  const SCANLINE_PERIOD = 262 * 455; // マスタークロック単位(60.05Hz相当)、hesHeader.jsのVBLANK_FPSと同じ根拠

  const IRQ_VECTOR_IRQ2 = 0xFFF6; // BRKもここを共有(HuC6280仕様)
  const IRQ_VECTOR_IRQ1 = 0xFFF8; // VDC(垂直帰線)
  const IRQ_VECTOR_TIQ  = 0xFFFA; // 内蔵タイマ

  class HesBus {
    /**
     * @param {object} header - HES.parseHeader() の結果
     * @param {Uint8Array} rom - DATAブロックの生バイト列(header.dataOffset以降、dataSizeぶん)
     */
    constructor(header, rom) {
      this.header = header;
      this.rom = rom;
      this.romBase = header.addr;
      this.mpr = new Uint8Array(8);
      this.ram = new Uint8Array(PAGE_SIZE);       // 物理バンク$F8
      this.sgx = [new Uint8Array(PAGE_SIZE), new Uint8Array(PAGE_SIZE), new Uint8Array(PAGE_SIZE)]; // $F9-$FB
      this.apu = null;    // hesPlayer.js が構築後にセットする
      this.onWrite = null; // write-logキャプチャ用(hes2mml向け)
      this.reset();
    }

    reset() {
      for (let i = 0; i < 8; i++) this.mpr[i] = this.header.banks[i] || 0;
      this.ram.fill(0);
      for (const p of this.sgx) p.fill(0);

      this.timerReload = 0;      // $0C00 書込み値(7bit)
      this.timerCounter = 1024;  // マスタークロック単位の残りカウント
      this.timerEnabled = false;
      this.timerFired = false;

      // IRQディセーブルレジスタ($1402)。実機/HES規約とも起動直後はタイマ・VDC割込を
      // マスクした状態で始まる(ゲーム側が明示的にCLIおよびマスク解除する前提)。
      this.irqDisable = 0x06; // bit2=timer, bit1=vdp を disable

      this.vdcLatch = 0;
      this.vdcCr = 0;         // レジスタ5(CR)の下位byte。bit3=垂直帰線割込許可
      this.vblankCounter = SCANLINE_PERIOD;
      this.vblankPending = false;
    }

    setMpr(i, bank) { this.mpr[i & 7] = bank & 0xFF; }
    getMpr(i) { return this.mpr[i & 7]; }

    read(addr) {
      addr &= 0xFFFF;
      const bank = this.mpr[addr >>> 13];
      if (bank === 0xFF) return this.readIo(addr & 0x1FFF);
      if (bank === 0xF8) return this.ram[addr & 0x1FFF];
      if (bank >= 0xF9 && bank <= 0xFB) return this.sgx[bank - 0xF9][addr & 0x1FFF];
      if (bank >= 0x80) return 0xFF; // 未実装の特殊バンク
      const off = bank * PAGE_SIZE + (addr & 0x1FFF) - this.romBase;
      return (off >= 0 && off < this.rom.length) ? this.rom[off] : 0xFF;
    }

    write(addr, value) {
      addr &= 0xFFFF; value &= 0xFF;
      if (this.onWrite) this.onWrite(addr, value);
      const bank = this.mpr[addr >>> 13];
      if (bank === 0xFF) { this.writeIo(addr & 0x1FFF, value); return; }
      if (bank === 0xF8) { this.ram[addr & 0x1FFF] = value; return; }
      if (bank >= 0xF9 && bank <= 0xFB) { this.sgx[bank - 0xF9][addr & 0x1FFF] = value; return; }
      // ROM(bank<0x80)・未実装特殊バンク(bank>=0x80)への書込みは無視
    }

    readIo(off) {
      if (off >= 0x0800 && off <= 0x0809 && this.apu) return this.apu.readRegister(off);
      switch (off) {
        case 0x0000: { // VDC ステータスレジスタ: 読み出しで垂直帰線割込フラグをack
          const v = this.vblankPending ? 0x20 : 0x00;
          this.vblankPending = false;
          return v;
        }
        case 0x0C00:
          return this.timerEnabled ? Math.max(0, Math.floor((this.timerCounter - 1) / 1024)) : 0;
        case 0x1402:
          return this.irqDisable;
        case 0x1403: {
          let s = 0;
          if (this.timerFired) s |= 0x04;
          if (this.vblankPending && (this.vdcCr & 0x08)) s |= 0x02;
          return s;
        }
      }
      return 0xFF; // 未実装I/O(ジョイパッド・CD/ADPCM等)は安全側の既定値
    }

    writeIo(off, value) {
      if (off >= 0x0800 && off <= 0x0809 && this.apu) { this.apu.writeRegister(off, value); return; }
      switch (off) {
        case 0x0000: this.vdcLatch = value & 0x1F; return;
        case 0x0002: if (this.vdcLatch === 5) this.vdcCr = value; return;
        case 0x0003: return; // CR上位byte。本stubでは未使用(bit3は下位byte側)
        case 0x0C00: this.timerReload = value & 0x7F; return;
        case 0x0C01:
          this.timerEnabled = (value & 1) !== 0;
          if (this.timerEnabled) this.timerCounter = (this.timerReload + 1) * 1024;
          return;
        case 0x1402: this.irqDisable = value; return;
        case 0x1403:
          this.timerFired = false;
          if (this.timerEnabled) this.timerCounter = (this.timerReload + 1) * 1024;
          return;
      }
      // ジョイパッド($1000台)・CD/ADPCM($1800台)等は未実装、書込みは無視
    }

    // マスタークロック(hesHeader.js HES.CPU_CLOCK_HIGH)1tickごとに1回呼ぶ。
    // タイマの減算・垂直帰線周期のカウントダウンを進める(CPU速度(CSH/CSL)に関わらず
    // 一定レートで進む、実機のPSG/タイマがCPU速度と独立した固定クロックである仕様通り)。
    clock() { this.clockBy(1); }

    // clock()のnティック分バッチ版(数学的にclock()をn回呼ぶのと同値)。リアルタイム
    // 再生(hes-stream-player.js経由)では1オーディオサンプルあたり約162回もこの関数を
    // 呼ぶ必要があり(マスタークロック7.16MHz ÷ 44.1kHz)、tickごとの関数呼出しオーバー
    // ヘッドの累積がユーザー実測で「がくがく」(音声スレッドが間に合わずアンダーラン)
    // になるほど重かった。timerCounter/vblankCounterはどちらも「しきい値まで減算して
    // 折り返す」単純なカウンタなので、n減算してからしきい値超過分だけwhileで折り返す
    // ことでO(1)(ならし)にできる。hesPlayer.js renderFrame()から呼ぶ場合、命令境界
    // (cpu.step())の間だけをまとめて渡すため、IRQ判定(pollIrq、命令境界でしか
    // 見ない)の観測結果は1tickずつ呼んでいた場合と完全に同じになる。
    clockBy(n) {
      if (n <= 0) return;
      if (this.timerEnabled) {
        this.timerCounter -= n;
        while (this.timerCounter <= 0) {
          this.timerFired = true;
          this.timerCounter += (this.timerReload + 1) * 1024;
        }
      }
      this.vblankCounter -= n;
      while (this.vblankCounter <= 0) {
        this.vblankCounter += SCANLINE_PERIOD;
        this.vblankPending = true;
      }
    }

    // cpuHuC6280.js の step() が毎命令境界で呼ぶ。優先度はタイマ>VDC(Hes_Core.cpuの
    // cpu_done()チェック順と同じ)。マスク済み(irqDisableの対応bitが立っている)なら無視。
    pollIrq() {
      if (this.timerFired && !(this.irqDisable & 0x04)) return IRQ_VECTOR_TIQ;
      if (this.vblankPending && (this.vdcCr & 0x08) && !(this.irqDisable & 0x02)) return IRQ_VECTOR_IRQ1;
      return -1;
    }
  }

  Emu.HesBus = HesBus;
  Emu.HES_IRQ_VECTOR = { IRQ2: IRQ_VECTOR_IRQ2, IRQ1: IRQ_VECTOR_IRQ1, TIQ: IRQ_VECTOR_TIQ };
})(globalThis);

/*
 * HESプレイヤー (HuC6280 CPU + HesBus + APUHuC6280 の統合)
 * MML.Emu.HesPlayer
 *
 * ★GBS/NSF/KSSと異なり「INITを呼んで完了を待ち、以後PLAYを一定間隔で直接呼ぶ」という
 *   簡略設計は使えない(HESヘッダにPLAYアドレスが無い。hesBus.js冒頭コメント参照)。
 *   代わりに「INITアドレスへPCをセットして、あとは実時間どおりCPUを自由継続実行し、
 *   バス側のタイマ/垂直帰線割込を本物のIRQとしてディスパッチする」方式を取る
 *   (実機の動作そのもの)。INITが最終的にRTS/無限ループのどちらへ転んでも、
 *   周期的なIRQがPLAY相当の処理を呼び続ける限り再生は問題なく進む。
 *
 * - initSong(track): CPU/バス/APUをリセットし、PC=initAddr・A=track・SP=0xFDにセットする
 *   (Hes_Core.start_trackと同じ考え方の初期化。call/beginCallでRTSを待つのではなく、
 *   その場で以後の連続実行に委ねる)。
 * - renderFrame(sampleRate): マスタークロック(HES.CPU_CLOCK_HIGH=7159090Hz)を基準に
 *   CPU/バス/APUを1サンプル分ずつ同期実行する。CPUの消費サイクル数はCSH/CSLの状態で
 *   マスタークロックへの換算比が変わる(cpu.speedHigh: true→1倍, false→4倍)。
 *   APUクロック(PSG_CLOCK=3579545Hz=マスタークロックの半分)はマスタークロック2tickに
 *   つき1回進める。★CPU/バス用とAPU用でクロックのアキュムレータを分離しており、
 *   speedFactor(再生速度)はCPU/バス側にのみ掛かる(音程を変えずにテンポだけ変える。
 *   renderFrame()内のコメント参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * DDA(PCM)書込み列を列ごとの型付き配列で持つ入れ物(2026-09-04)。
   *
   * DDAは「PCM 1サンプルにつき1件」積むので件数が桁違いに多い(実測: NCS91002.hes
   * 60秒で672,906件)。1件を {frame,t,seq,value,src} のJSオブジェクトにすると
   * **実測181B/件=116MB**(RSSで確認)になり、キャプチャWorkerとメインで2部持つと
   * 1曲で数百MBに達していた。列持ちなら 4+4+4+1+4 = 17B/件で1/10以下になる。
   *
   * 参照側は `trace[i].frame` ではなく `trace.frame[i]` で読む。
   *   length … 件数(配列の確保量ではない)
   *   frame  … 書込み時のフレーム番号
   *   t      … 分数フレーム時刻(frame + フレーム内位置)
   *   seq    … controlTraceと共通の書込み順連番
   *   value  … $0806へ書かれた5bit値
   *   src    … 読出し元ROM物理オフセット(不明なら-1)
   */
  class HesTraceBuf {
    constructor(cap) {
      this.length = 0;
      this._alloc(Math.max(1024, cap | 0));
    }
    _alloc(cap) {
      const old = this.length;
      const frame = new Int32Array(cap), t = new Float32Array(cap), seq = new Int32Array(cap);
      const value = new Uint8Array(cap), src = new Int32Array(cap);
      if (old) {
        frame.set(this.frame.subarray(0, old)); t.set(this.t.subarray(0, old));
        seq.set(this.seq.subarray(0, old)); value.set(this.value.subarray(0, old));
        src.set(this.src.subarray(0, old));
      }
      this.frame = frame; this.t = t; this.seq = seq; this.value = value; this.src = src;
      this._cap = cap;
    }
    push(frame, t, seq, value, src) {
      if (this.length >= this._cap) this._alloc(this._cap * 2);
      const i = this.length++;
      this.frame[i] = frame; this.t[i] = t; this.seq[i] = seq; this.value[i] = value; this.src[i] = src;
    }
    /** 確保量を実件数まで切り詰める(キャプチャ完了時。倍々確保の余りを返す) */
    trim() { if (this._cap > this.length) this._alloc(Math.max(1, this.length)); }
    /** [from, length) を列ごとのコピーで取り出す(Workerの差分送信用) */
    slicePlain(from) {
      const n = this.length - from;
      return { n, frame: this.frame.slice(from, this.length), t: this.t.slice(from, this.length),
               seq: this.seq.slice(from, this.length), value: this.value.slice(from, this.length),
               src: this.src.slice(from, this.length) };
    }
    /** slicePlain() で作った塊を末尾へ足す(Worker受信側) */
    appendPlain(c) {
      if (!c || !c.n) return;
      while (this.length + c.n > this._cap) this._alloc(this._cap * 2);
      const i = this.length;
      this.frame.set(c.frame, i); this.t.set(c.t, i); this.seq.set(c.seq, i);
      this.value.set(c.value, i); this.src.set(c.src, i);
      this.length += c.n;
    }
  }
  Emu.HesTraceBuf = HesTraceBuf;

  class HesPlayer {
    /**
     * @param {Uint8Array} hesBytes - HESファイルの完全なバイナリ
     */
    constructor(hesBytes) {
      this.header = MML.HES.parseHeader(hesBytes);
      const start = this.header.dataOffset;
      const end = Math.min(hesBytes.length, start + this.header.dataSize);
      const rom = hesBytes.slice(start, Math.max(start, end));

      this.bus = new Emu.HesBus(this.header, rom);
      this.apu = new Emu.APUHuC6280();
      this.bus.apu = this.apu;
      this.cpu = new Emu.CPUHuC6280(this.bus);

      this.clockHz = MML.HES.CPU_CLOCK_HIGH;
      this.frameRate = MML.HES.VBLANK_FPS; // 抽出/描画用の名目フレームレート(実際のPLAY頻度とは独立)

      this.cpuCycleAccum = 0;
      this.apuCycleAccum = 0;
      this.cpuDebt = 0;
      this.psgTickAccum = 0;
      this.speedFactor = 1;
    }

    /**
     * 指定したトラック番号でINITを開始する。番号の意味はゲーム依存の任意値
     * (header.firstTrackが既定、M3U等で個別に案内される。hesHeader.js冒頭コメント参照)。
     * @param {number} track
     */
    initSong(track) {
      this.bus.reset();
      this.apu.reset();
      this.cpu.reset();

      // INITは実機同様RTSで戻ってくることが多い(GBS/NSF等と違い稀なケースではないと実測で
      // 判明)。cpu.beginCall()が積む番兵(CALL_SENTINEL=$FFFF)を戻り先にしておくことで、
      // RTS後にPCがそこへ到達してもcpuHuC6280.js側のstep()が実フェッチをせずアイドルする
      // (詳細はcpuHuC6280.js step()冒頭コメント参照。以前は$3FFFという「たまたまRAMだから
      // 安全なはず」の地点へ落としていたが、そこへ到達した後の命令フェッチが本来無関係な
      // ROMバイト列を実行してしまいスタック破壊→IRQ永久停止という不具合の原因になっていた)。
      this.cpu.A = track & 0xFF;
      this.cpu.beginCall(this.header.initAddr); // S=0xFF→0xFD(Hes_Core.start_trackと同じ値)
      // 実機はRESET直後Iフラグ=1(割込禁止)。INITが自分でCLIするまでIRQは発生しない
      // (cpu.reset()が既にP=F_Iにしている)。

      this.cpuCycleAccum = 0;
      this.apuCycleAccum = 0;
      this.cpuDebt = 0;
      this.psgTickAccum = 0;
    }

    /**
     * 1フレーム分の音声サンプルを生成する。
     * ★speedFactor(再生速度スライダー)はCPU/バス(タイマ・垂直帰線割込)の進行速度だけに
     *   掛け、PSGのクロック(apu.clock())は常に実時間のまま進める。これによりCPUが
     *   音符を書き換える頻度(テンポ)だけが変わり、実際に鳴っている音の周波数(音程)は
     *   変化しない。当初はCPU/PSG共通の1つのアキュムレータにspeedFactorを掛けていたため、
     *   速度を落とすとPSGの発振自体も遅くなり音程が下がってしまっていた
     *   (ユーザー報告で発覚。GBS/NSF/KSSはPLAY呼び出し頻度だけをspeedFactorで変える設計
     *   のため元々この問題が無かった。HESはPLAYを明示的に呼ばずCPU/バスを連続実行する
     *   設計のため、CPU用とAPU用でアキュムレータを分離する必要があった)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - trueならmixSample()を省略(先読みキャプチャ用軽量モード)
     * @param {Float32Array[]} [channelOut] - 渡された場合、mixSample()(6ch合算)の代わりに
     *   apu.mixChannelSamples()でchごとの値をchannelOut[0..5]へ書き込む(各要素は
     *   samplesThisFrame長のFloat32Arrayを呼び出し側で事前確保しておくこと)。
     *   HesBufferedPlayer(hes-stream-player.js)がリアルタイムミュート対応のため
     *   チャンネルごとに別々のAudioBufferチャンネルへレンダリングする用途で使う。
     * @param {boolean} [stereo] - trueならモノラルFloat32Arrayの代わりに
     *   {left, right}(各Float32Array)を返す(WAV書き出し用。channelOut指定時は無視)
     * @returns {Float32Array|{left:Float32Array,right:Float32Array}|null} channelOut指定時・regsOnly指定時はnull
     */
    renderFrame(sampleRate, regsOnly, channelOut, stereo) {
      const masterTicksPerSample = this.clockHz / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / this.frameRate);
      const outL = (regsOnly || channelOut) ? null : new Float32Array(samplesThisFrame);
      const outR = (regsOnly || channelOut || !stereo) ? null : new Float32Array(samplesThisFrame);

      const cpu = this.cpu, bus = this.bus, apu = this.apu;

      // キャプチャ(captureHesSongAsync)がDDA書込みのフレーム内時刻を分数フレームとして
      // 記録できるように、現在のサンプル位置を公開する(代入1回/サンプルなのでコストは無視できる)。
      this.frameSampleCount = samplesThisFrame;

      for (let i = 0; i < samplesThisFrame; i++) {
        this.frameSamplePos = i;
        // PSG: 常に実時間のクロックで進める(音程を変えないため)。
        // ★2026-08: 以前はマスタークロック1tickごとにapu.clock()を呼んでおり
        // (1サンプルあたり約162tick=マスタークロック7.16MHz÷44.1kHz)、リアルタイム
        // 再生(hes-stream-player.js)でこの関数呼出し回数の多さ自体がボトルネックになって
        // 音声スレッドの処理が間に合わず「がくがく」になっていた(ユーザー実測)。
        // 1サンプル分の整数tick数をまとめてapu.clockBy()へ渡す(結果はtickごとに
        // 呼んだ場合と数学的に同値、詳細はapuHuC6280.js PsgChannel.clockBy参照)。
        this.apuCycleAccum += masterTicksPerSample;
        const masterTicks = Math.floor(this.apuCycleAccum);
        this.apuCycleAccum -= masterTicks;
        const totalPsgAcc = this.psgTickAccum + masterTicks;
        const psgTicks = totalPsgAcc >> 1;      // PSGクロックはマスターの半分(2tickに1回)
        this.psgTickAccum = totalPsgAcc & 1;
        if (psgTicks > 0) apu.clockBy(psgTicks);

        // CPU/バス(タイマ・垂直帰線): speedFactorで進行速度を変える(テンポ変化のため)。
        // 命令境界(cpu.step())の間はバス側のカウンタをまとめて進めても、IRQ判定
        // (pollIrq、step()冒頭でしか見ない)の観測結果はtickごとに呼んだ場合と完全に
        // 同じになる(hesBus.js clockBy()冒頭コメント参照)。
        this.cpuCycleAccum += masterTicksPerSample * this.speedFactor;
        let cpuTicks = Math.floor(this.cpuCycleAccum);
        this.cpuCycleAccum -= cpuTicks;
        while (cpuTicks > 0) {
          if (this.cpuDebt <= 0) {
            const opCycles = cpu.step();
            this.cpuDebt = opCycles * (cpu.speedHigh ? 1 : 4);
          }
          const advance = Math.max(1, Math.min(cpuTicks, this.cpuDebt));
          bus.clockBy(advance);
          this.cpuDebt -= advance;
          cpuTicks -= advance;
        }
        if (channelOut) {
          const samples = apu.mixChannelSamples();
          for (let c = 0; c < samples.length; c++) channelOut[c][i] = samples[c];
        } else if (!regsOnly) {
          const s = apu.mixSample();
          if (stereo) { outL[i] = s.left; outR[i] = s.right; }
          else outL[i] = (s.left + s.right) * 0.5;
        }
      }

      return stereo ? { left: outL, right: outR } : outL;
    }
  }

  // 鍵盤表示/ロール用: APUのライブ状態を1フレーム分スナップショットする(gbsPlayer.jsの
  // snapshotApuと同じ考え方。HES PSGは波形/ノイズ位相が内部クロックのみで進行するため
  // writeLog再生では追えず、ライブAPUから直接読む方式に統一する)。
  // ★noiseCtrl(生の$0807値)はon/off(bit7)だけでなく下位5bitに周期選択値も持つ。
  // 以前はnoiseOn(on/offの真偽値)しか記録していなかったため、この値を消費する側
  // (hes2mml/expansion/noise.jsのpsgNoiseFreq()、main.js buildHesRollTimeline経由の
  // noiseChannel()、hes-stream-player.js _applyFrame())が軒並みnoiseCtrl=undefinedを
  // 受け取り、~undefined→-1→&0x1F=31という「常に最遅固定周期」にすり替わっていた
  // (実測: TP03018.hes index77でノイズの音程が常に同じに聞こえる不具合の真因)。
  // noiseOn自体は活性判定の簡易フラグとして他箇所で使われ続けるためそのまま残し、
  // 生のnoiseCtrlを別フィールドとして追加する。
  // 波形(32要素)は書き換えられたときしか変わらないので、内容が同じなら前フレームの
  // 配列をそのまま使い回す(2026-09-04)。毎フレーム・全chぶん Array.from すると
  // スナップショットの約1/3を占めるが、実測では21,624個作って**変わったのは200回=0.9%**
  // (NCS91002・60秒)。★受け取り側(hes2mml/expansion/wave.js、ロール構築)は
  // 読むだけで書き換えないので共有して安全。
  const waveCache = [];
  function waveOf(c, i) {
    let e = waveCache[i];
    if (!e) e = waveCache[i] = { raw: new Uint8Array(c.wave.length), arr: null };
    let same = e.arr !== null;
    for (let k = 0; k < c.wave.length; k++) { if (e.raw[k] !== c.wave[k]) { e.raw[k] = c.wave[k]; same = false; } }
    if (!same) e.arr = Array.from(c.wave);
    return e.arr;
  }
  function snapshotApu(apu) {
    const arr = apu.ch.map((c, i) => ({
      on: c.on, dda: c.dda, noiseOn: c.hasNoise && (c.noiseCtrl & 0x80) !== 0,
      noiseCtrl: c.noiseCtrl,
      freq: c.freq, vol: c.volume, balance: c.balance,
      wave: waveOf(c, i), dac: c.dac
    }));
    // $0801(全体バランス)。従来はチャンネル別の$0805(c.balance)しか記録しておらず、
    // 全体バランスだけで片方の出力バスへ振り切って無音化するケースを抽出側が検知
    // できなかった(apuHuC6280.js snapshotHuC6280ApuのglobalモPanL/PanRと同じ考え方、
    // ライブ鍵盤表示側には既にあったがregsOnly抽出側には無かった)。
    arr.globalBalance = apu.balance;
    return arr;
  }

  /**
   * HESを指定秒数分オフラインレンダリングし、音声・フレーム毎のAPUライブスナップショット・
   * DDA(PCM)書込みトレースを返す(captureGbsSongAsyncと同型)。
   *
   * ★GBS/NSF/KSSのwriteLog(フレーム毎の全レジスタ書込みをそのまま保持する配列)は
   * ここでは持たない。HESはGbsPlayer.js冒頭コメントの通りwriteLog再生方式を使わず
   * 常にライブAPUスナップショット方式なので、そもそもwriteLogの利用箇所が無い
   * (hes2mml側もsnapshots/dpcmTraceだけを使う)。にもかかわらず初期実装では
   * GBS由来の設計をそのままコピーして全フレーム分のwriteLogを蓄積し続けていたため、
   * CPUの通常実行だけで1フレームあたり数千件(ゼロページ/スタック書込み込み)、
   * DDA(PCM)を多用する曲では1フレームあたり数千〜1万件規模に達し、180秒の曲では
   * 総レコード数が2000万件を超えて未使用のまま保持され続け、V8のGCが著しく劣化して
   * 「変換が事実上終わらない」不具合になっていた(ユーザー報告で発覚。フレームが進むに
   * つれ1フレームの処理時間が実測10ms→100ms超まで悪化する挙動から特定)。使われない
   * データを丸ごと削除することで直接解消する。
   * @param {Uint8Array} hesBytes
   * @param {object} opt - {track, durationSeconds, sampleRate, mute, regsOnly, speedFactor, perChannelAudio}
   * @param {(done:number,total:number,data:{snapshots:Array})=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, channelAudio:Float32Array[]|null, snapshots:Array, dpcmTrace:Array, controlTrace:Array, player:HesPlayer, frameRate:number}>}
   */
  Emu.captureHesSongAsync = async function (hesBytes, opt, onProgress) {
    const player = new HesPlayer(hesBytes);
    player.initSong(opt.track != null ? opt.track : player.header.firstTrack);
    if (opt.mute) Object.assign(player.apu.mute, opt.mute);
    // speedFactor: オフライン一括レンダリング(hes-stream-player.js HesBufferedPlayer)が
    // 再生速度スライダーの値をここへ渡す。renderFrame()側で既にCPU/APUのクロックを
    // 分離済み(音程を変えずテンポだけ変わる)なので、そのままplayer.speedFactorへ
    // 反映するだけでよい。
    if (opt.speedFactor != null) player.speedFactor = opt.speedFactor;

    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    // perChannelAudio: 6chぶんを合算済みの1本(audio)ではなく、chごとに独立したFloat32Array
    // (channelAudio[0..5])で受け取る。HesBufferedPlayerがこれを使い、再生時にGainNode経由で
    // 各chを即座にミュートできるようにする(録音後のバッファへミュートを焼き込む方式だと
    // 再生中のミュート切替のたびに再レンダリングが必要になってしまうため。ファイル冒頭の
    // 経緯コメント参照)。ミュート(opt.mute)はこのモードでは意味を持たない
    // (呼び出し側がGainNodeで適用する)。
    const perChannel = !!opt.perChannelAudio;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = (regsOnly || perChannel) ? new Float32Array(0) : new Float32Array(totalOutSamples);
    // channelAudioOut: 呼び出し側(HesBufferedPlayer)が事前確保した配列をそのまま渡せる。
    // レンダリング完了を待たず「今埋まっている範囲まで」を同じ配列参照から直接読みながら
    // 再生を始められるようにするため(このキャプチャの結果を受け取ってからコピーするのでは
    // 再生開始がレンダリング完了まで遅れてしまう。main.js playHesStream()冒頭コメント参照)。
    const channelAudio = perChannel
      ? (opt.channelAudioOut || Array.from({ length: MML.Emu.APUHuC6280_CH_COUNT }, () => new Float32Array(totalOutSamples)))
      : null;
    const samplesThisFrame = Math.round(sampleRate / player.frameRate);
    const channelScratch = perChannel
      ? Array.from({ length: MML.Emu.APUHuC6280_CH_COUNT }, () => new Float32Array(samplesThisFrame))
      : null;
    const snapshots = [];
    // DDA(直接D/A、PCM)モード中の$0806書込みをch別に記録する(hes2mml/expansion/dpcm.js向け)。
    // 1フレームに数十〜百回書かれるため、フレーム単位のsnapshotsだけでは波形を再現できない
    // (詳細はplayHesStream()冒頭コメント参照)。フックはループの外で1回だけ設定し、
    // 現在フレーム番号はクロージャではなく可変変数currentFrameで渡す(毎フレーム新しい
    // クロージャを作らないための最適化。上のコメントのGC劣化対策の一環)。
    // ★2026-08: 各エントリにフレーム番号(frame)に加えて以下を持たせる:
    //   t   … 分数フレーム時刻(frame + フレーム内サンプル位置/フレーム内サンプル数)。
    //         クリップの実再生レートをフレーム量子化誤差なしで推定するため。
    //   seq … controlTrace/dpcmTraceで共通の単調増加連番。同じドラムの「off→次のon」が
    //         ほぼ常に同一フレーム内で起きるため(NX91002.hes実測で打点の254/255)、frameだけでは
    //         書込み順を復元できず、前クリップの尾(平均約80サンプル≒12ms)が次クリップの頭に
    //         混入して「同じドラムなのに毎回別波形」になり重複排除が全滅していた。連番により
    //         区切りを書込み1件単位で正確に復元する(hes2mml/expansion/dpcm.js冒頭コメント参照)。
    //   src … (dpcmTraceのみ)そのサンプル値の読出し元ROM物理オフセット。読出し元が
    //         ROM以外(RAM経由・加工あり)のときは-1。cpuHuC6280.js fetchOperandが記録する
    //         lastDataAddr(直近のデータ読出し論理アドレス)を物理へ換算し、さらに
    //         「ROMバイト==書込み値」の一致検証を通ったものだけ採用する。
    //         同一ドラム=同一ROM開始アドレスなので重複排除が確定的になる。
    // ★列ごとの型付き配列で持つ(2026-09-04)。DDAは「PCM 1サンプルごとに1件」積むので、
    //   1件を {frame,t,seq,value,src} のJSオブジェクトにすると実測181B/件になり、
    //   60秒・67万件で116MB(実RSSで確認)を占めていた。列持ちなら17B/件。
    //   参照側は trace[i].frame ではなく trace.frame[i] で読む(Emu.HesTraceBuf)。
    const dpcmTrace = [0, 1, 2, 3, 4, 5].map(() => new HesTraceBuf());
    // $0804(chの on/DDA 制御レジスタ)書込みをch別・書込み順に記録する(hes2mml/expansion/
    // dpcm.js向け)。DDA(PCM)で打楽器を鳴らす曲は1音ごとに on/dda を素早くon/offし直すことが
    // 多く、その切替がフレーム(1/60秒)より短い間隔で起きうる。snapshots(フレーム単位の
    // 状態サンプリング)だけでは切替を取りこぼし、複数の打点が「1本の連続音」として
    // 誤って結合されてしまう(ユーザー実測: NX91002.hesで全打楽器が1音に繋がる不具合)。
    // dpcmTraceと同じ理由でここも書込みイベントをそのまま記録する。
    const controlTrace = [[], [], [], [], [], []]; // ch毎: [{frame, t, seq, on, dda, vol}]
    // $0802/$0803(12bit周期)書込み列。音量(controlTraceのvol)と同じ理由で、ピッチ列
    // (ビブラート/EPテーブル・音程判定)の位相エイリアシング対策のノート相対時刻リサンプル
    // (hes2mml/expansion/wave.js)に使う。freqは書込み適用後の12bit値
    // (apuHuC6280.js writeDataの$0802/$0803と同じ合成式をシャドウで再現。onWriteは
    // APU側への適用より先に呼ばれるためAPUの値は読めない)。
    const pitchTrace = [[], [], [], [], [], []]; // ch毎: [{t, freq}]
    const freqShadow = new Uint16Array(6);
    for (let i = 0; i < 6; i++) freqShadow[i] = player.apu.ch[i] ? player.apu.ch[i].freq : 0;
    let currentFrame = 0;
    let traceSeq = 0; // controlTrace/dpcmTrace共通の書込み順連番(上のコメント参照)
    player.bus.onWrite = (addr, value) => {
      const sel = player.apu.selected;
      // $0800は3bit(0-7)なのでch6/7が選ばれうるが、実機にそのchは無い。
      // apuHuC6280側も「selected >= CH_COUNT なら書込み無視」としているので、
      // トレースも同じ規則で捨てる。ここを守らないと6ch分しかないtrace配列が
      // 範囲外アクセスになり変換ごと落ちる(HC63015.hes等6曲で実際に発生)。
      // $0801(全体バランス)は全chの実効音量に効く(bal/gbalのコメント参照)ため、
      // チャンネル選択($0800)とは無関係に全chのタイムラインへ変化点を積む
      if (addr === 0x0801) {
        const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
        for (let ch = 0; ch < controlTrace.length; ch++) {
          const c = player.apu.ch[ch];
          if (!c) continue;
          controlTrace[ch].push({ frame: currentFrame, t, seq: traceSeq++, on: c.on, dda: c.dda, vol: c.volume, bal: c.balance, gbal: value });
        }
        return;
      }
      if (sel >= controlTrace.length) return;
      if (addr === 0x0804) {
        const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
        // vol(下位5bit): HESのソフトウェア音量エンベロープはゲーム内蔵タイマー駆動で、
        // 周期がキャプチャフレームレートと一致しない(実測: NX91002は約54.9Hz)。フレーム境界の
        // スナップショットで音量をサンプリングすると位相エイリアシングで「同じエンベロープの
        // 1フレーム違い列」が量産されるため、hes2mml/expansion/wave.jsが書込みイベント列から
        // ノート相対時刻でリサンプルできるよう生値も残す(同expansion冒頭コメント参照)。
        // bal/gbal($0805のch別バランス・$0801の全体バランス): これらは「パン」ではなく
        // 音量レジスタと同じインデックスへ合流する減衰器で、実質的に第2の音量レジスタ
        // (実測でbalanceだけで減衰エンベロープを作る曲がある。hes2mml/expansion/wave.js
        // effectiveVolIndex冒頭コメント参照)。抽出側が実効音量を復元できるよう
        // 書込み時点のシャドウ値を添える(onWriteはAPUへの適用前に呼ばれるが、
        // 別レジスタである$0805/$0801の値は既に反映済みなのでそのまま読んでよい)。
        const c = player.apu.ch[sel];
        controlTrace[sel].push({ frame: currentFrame, t, seq: traceSeq++, on: (value & 0x80) !== 0, dda: (value & 0x40) !== 0, vol: value & 0x1F, bal: c ? c.balance : 0xFF, gbal: player.apu.balance });
      } else if (addr === 0x0805) {
        // ch別バランス変更も実効音量の変化点(上記コメント参照)。on/ddaは現在の
        // シャドウをそのまま載せるのでbuildChannelRuns(状態遷移のみ見る)には影響しない
        const c = player.apu.ch[sel];
        if (c) {
          const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
          controlTrace[sel].push({ frame: currentFrame, t, seq: traceSeq++, on: c.on, dda: c.dda, vol: c.volume, bal: value, gbal: player.apu.balance });
        }
      } else if (addr === 0x0802 || addr === 0x0803) {
        freqShadow[sel] = addr === 0x0802
          ? (freqShadow[sel] & 0xF00) | value
          : (freqShadow[sel] & 0x0FF) | ((value & 0x0F) << 8);
        const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
        pitchTrace[sel].push({ t, freq: freqShadow[sel] });
      } else if (addr === 0x0806) {
        const ch = player.apu.ch[sel];
        if (ch && ch.dda && ch.on) {
          const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
          // 読出し元ROM物理オフセット(dpcmTrace冒頭コメント参照)。lastDataAddrは
          // 論理アドレスなのでMPRで物理バンクへ換算し、実際にそのROMバイトが
          // 書込み値と一致する(下位5bit、無加工ストリーミング)場合だけ採用する。
          // 音量テーブル加工やRAMバッファ経由のROMではここが-1になり、抽出側は
          // バイト列一致の重複排除へフォールバックする。
          let src = -1;
          const la = player.cpu.lastDataAddr;
          if (la >= 0) {
            const bank = player.bus.mpr[(la & 0xFFFF) >>> 13];
            if (bank < 0x80) {
              const off = bank * 0x2000 + (la & 0x1FFF) - player.bus.romBase;
              if (off >= 0 && off < player.bus.rom.length && (player.bus.rom[off] & 0x1F) === (value & 0x1F)) src = off;
            }
          }
          dpcmTrace[sel].push(currentFrame, t, traceSeq++, value & 0x1F, src);
        }
      }
    };

    let outPos = 0;
    // ★2026-08: 以前は経過実時間ベース(100msごと)でyieldしていたが、これはKSS/GBS等の
    // 「固定フレーム数(CHUNK_FRAMES)ごとにyield」という確立済みの方式より縮小方向の
    // 最適化を狙ったものの、副作用として「通常曲(1フレーム1ms未満)だと100ms間に
    // 100フレーム以上をyield無しで連続実行してしまい、その間ずっとメインスレッドを
    // 占有してリアルタイム再生側(ScriptProcessorNodeコールバック)を飢餓状態にする」
    // という、まさにKSSで過去に踏んだのと同種の不具合(captureKssSongAsync冒頭の
    // 教訓: 「曲切替連打でキャプチャが何本も積み上がりCPUを食い合う」問題とは別だが、
    // 根は同じ「重いキャプチャループが実時間の再生を圧迫する」)を再生読み込み中ずっと
    // 起こしていた(ユーザー指摘・実測で発覚)。KSSと同じ固定フレーム数方式に戻し、
    // yieldの上限間隔を短く保つことでメインスレッドを定期的に手放す(DDA多用曲は
    // 1フレームが重いぶんチャンクの実時間は長くなるが、それ自体は元々避けられない)。
    // ★2026-08-20 スライスを「フレーム数固定(CHUNK_FRAMES)」から「時間予算固定」へ変更
    // (capture.js captureSongAsyncと同じ方式)。上の経緯コメントの「経過実時間ベース
    // (100msごと)yield」の失敗と向きが逆である点に注意: あれは「100ms連続でメイン
    // スレッドを占有してからyield」でスライスが長すぎたのが問題。こちらは「5ms使ったら
    // 必ずyield」でスライス上限を従来のCHUNK_FRAMES方式より短く保証する(DDA多用曲の
    // 重い1フレームでも超過は1フレーム分だけ)。Worker実行時(capture-worker-client.js)は
    // opt.yieldFn/sliceBudgetMsで上書きされる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      currentFrame = f;
      if (perChannel) {
        player.renderFrame(sampleRate, false, channelScratch);
        const n = Math.min(samplesThisFrame, totalOutSamples - outPos);
        for (let c = 0; c < channelAudio.length; c++) {
          channelAudio[c].set(n === samplesThisFrame ? channelScratch[c] : channelScratch[c].subarray(0, n), outPos);
        }
        outPos += n;
      } else {
        const frameBuf = player.renderFrame(sampleRate, regsOnly);
        if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      }
      snapshots.push(snapshotApu(player.apu));
      if (f === 0 || f === totalFrames - 1 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, { snapshots, samplesReady: outPos, frameRate: player.frameRate, dpcmTrace, controlTrace, pitchTrace });
        await yieldFn();
        if (opt.shouldCancel && opt.shouldCancel()) {
          for (const b of dpcmTrace) b.trim(); // 倍々確保の余りを返す
          return { audio, channelAudio, snapshots, dpcmTrace, controlTrace, pitchTrace, player, frameRate: player.frameRate };
        }
        sliceStart = performance.now();
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, { snapshots, samplesReady: outPos, frameRate: player.frameRate, dpcmTrace, controlTrace, pitchTrace });
    for (const b of dpcmTrace) b.trim(); // 倍々確保の余りを返す
    return { audio, channelAudio, snapshots, dpcmTrace, controlTrace, pitchTrace, player, frameRate: player.frameRate };
  };

  Emu.HesPlayer = HesPlayer;
  // VGM(vgmPlayer.js captureVgmSongAsync)がHuC6280チップのフレームスナップショットを
  // hes2mml抽出器と同じ形で積むために公開する(gbsPlayer.jsのsnapshotGbApuForCaptureと同じ)。
  Emu.snapshotHesApuForCapture = snapshotApu;
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
 * 音源非依存: 専用アタックレジスタを持たないチップ(N163, FME7等)向けの、
 * 同一ピッチ内での「打ち直し(ロール奏法)」検出。
 *
 * N163やFME7(AY-3-8910互換)は2A03/VRC6/MMC5の長さカウンタ+アタック専用書込みや、
 * VRC7のキーオン、FDSの音量エンベロープ回路のような「ノートオン」のハードウェア概念を
 * 持たず、CPUが直接音量レジスタを書き換えるだけの素朴な発振器である。そのため
 * 「同じ音程・同じ波形/モードのまま音量だけリセットして音符を打ち直す」ロール奏法と、
 * 「同じ音程のまま音量が緩やかに上下するトレモロ」を、ピッチ/波形の変化だけを見る
 * 抽出処理では区別できず、ロールを1本の長い音符に誤結合してしまう
 * (女神転生II 25曲目、N163 Sパートで実測・報告。11曲目のN163ベースも当初トレモロと
 * 誤解釈していたが実際はロールだったとユーザー確認済み)。
 *
 * 判定方針(ユーザーとの設計検討の結論):
 *   A. 単フレームのジャンプ量: 前フレームよりopts.jumpThreshold以上音量が増えたら
 *      打ち直しの合図とする(周期性が無くても機能する。単発の打ち直しにも対応できる
 *      唯一の手段)。
 *   B. 周期の起伏+振幅: 音量列に繰り返し周期がある場合、1周期の中で「山から谷まで
 *      (立ち下がり)」「谷から次の山まで(立ち上がり、周期をまたぐ)」何フレームか、
 *      振幅(山-谷)がどれだけかを見る。トレモロは立ち上がり・立ち下がりが同程度の
 *      時間をかける(対称)のに対し、ロールは立ち下がりだけゆっくりで立ち上がりは
 *      ほぼ一瞬(非対称)、かつ振幅もその音符全体の最大音量付近まで戻る。
 *
 *   AとBは同じ判定を別の方法でやっているのではなく守備範囲が違う: Bは周期が
 *   検出できて初めて使える(最低3周期分の一致が必要、envelope.jsのループ判定と同じ
 *   考え方)。周期が見つかりBで「ロールらしい」と判定できた区間はBの結果(周期ごとの
 *   機械的な分割)を採用し、それ以外(周期が見つからない、または見つかったが
 *   トレモロと判定された)はAに任せる。両者を突き合わせて多数決するのではなく、
 *   担当領域を分けることで「判定が食い違ったらどうするか」という問題自体を無くしている。
 *
 * MML.Convert.splitRetriggers(volSeq, opts) -> [{start, end}, ...]
 *   volSeq: 同一ピッチ・同一波形/モードの区間のフレーム毎の生音量値(0始まりのローカル配列)
 *   opts.jumpThreshold (既定2): Aの閾値
 *   opts.minPeriod/maxPeriod/minRepeats/maxSearchStart: Bの周期探索パラメータ。
 *     envelope.jsのループ探索と考え方は同じだが、この用途向けに別定数として独立させて
 *     いる(ロール奏法とトレモロ効果の実測される周期長の傾向が異なりうるため、
 *     チューニングを混ぜない)。
 *   戻り値: volSeq を start/end (半開区間、volSeq自身のインデックス基準) に分割した配列。
 *     呼び出し側はこの範囲ごとにvolSeqをスライスして別々の音符イベントとして扱うこと。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const DEFAULT_JUMP_THRESHOLD = 2;
  // ★抽出パス1(音程変化の境界)からも同じ基準を使うために公開する(2026-08-26)。
  // アタックレジスタを持たないチップ(N163・HES PSG)は「音量の跳ね上がり」だけが
  // 打ち直しの手がかりだが、splitRetriggersは同一音程ラン内(パス2)しか走らないため、
  // 音程が変わる境界での再アタックは各extractorのpureNoteChange判定側で見る必要がある
  // (見落とすと、実際は打ち直している音程変化をレガートと誤認してタイ(&)で繋いでしまい、
  // タイ側では@v等を再指定しない仕様のため音量エンベロープが減衰し続ける。
  // 実測: 女神転生II 12曲目のN163 Q/Rパートで発覚)。
  MML.Convert.RETRIGGER_JUMP_THRESHOLD = DEFAULT_JUMP_THRESHOLD;
  const DEFAULT_MIN_PERIOD = 2;
  const DEFAULT_MAX_PERIOD = 48;
  const DEFAULT_MIN_REPEATS = 3;
  const DEFAULT_MAX_SEARCH_START = 96;
  const RISE_RATIO_DIVISOR = 3;       // 立ち上がりが周期の1/3以下ならロールらしいとみなす
  const MIN_AMPLITUDE = 2;            // 振幅がこれ未満ならロールとはみなさない
  const PEAK_NEAR_MAX_TOLERANCE = 1;  // 山がこの範囲内で全体最大値に近ければ「フルで戻った」とみなす

  // envelope.jsのisPeriodicFromと同じ考え方だが、この用途向けにパラメータを独立させて
  // 別途持つ(意図的に共有しない。用途によってチューニングしたい値が変わりうるため)。
  function findRepeatingPeriod(seq, minPeriod, maxPeriod, minRepeats, maxSearchStart) {
    const n = seq.length;
    const searchLimit = Math.min(n, maxSearchStart);
    for (let start = 0; start < searchLimit; start++) {
      const remain = n - start;
      const maxP = Math.min(maxPeriod, Math.floor(remain / minRepeats));
      for (let period = minPeriod; period <= maxP; period++) {
        let ok = true;
        for (let i = start + period; i < n; i++) {
          if (seq[i] !== seq[i - period]) { ok = false; break; }
        }
        if (ok) return { start, period };
      }
    }
    return null;
  }

  // 1周期分の値(cycle)を見て「ロール(アタックの繰り返し)らしいか」を判定する(Method B)。
  // 山(peak)は周期の先頭側、谷(trough)は周期の末尾側にあるという実測パターン
  // (例: 5,5,5,4,3,3,3,3,2,2)を前提に、立ち下がり(peak→trough)と立ち上がり
  // (trough→次周期のpeak、周期をまたぐ分)のフレーム数を比較する。
  function isAttackLikeCycle(cycle, overallMax) {
    const period = cycle.length;
    const peakVal = Math.max(...cycle);
    const peakIdx = cycle.indexOf(peakVal);
    const troughVal = Math.min(...cycle);
    const troughIdx = cycle.lastIndexOf(troughVal);
    const fallFrames = Math.max(0, troughIdx - peakIdx);
    const riseFrames = period - fallFrames;
    const amplitude = peakVal - troughVal;
    return riseFrames * RISE_RATIO_DIVISOR <= period &&
      amplitude >= MIN_AMPLITUDE &&
      peakVal >= overallMax - PEAK_NEAR_MAX_TOLERANCE;
  }

  // Method A: 前フレームよりthreshold以上音量が増えた地点で区切る
  function splitByJump(seq, threshold, offset) {
    const ranges = [];
    let segStart = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] - seq[i - 1] >= threshold) {
        ranges.push({ start: offset + segStart, end: offset + i });
        segStart = i;
      }
    }
    ranges.push({ start: offset + segStart, end: offset + seq.length });
    return ranges;
  }

  MML.Convert.splitRetriggers = function (volSeq, opts) {
    opts = opts || {};
    const jumpThreshold = opts.jumpThreshold != null ? opts.jumpThreshold : DEFAULT_JUMP_THRESHOLD;
    const n = volSeq.length;
    if (n <= 1) return [{ start: 0, end: n }];

    const period = findRepeatingPeriod(
      volSeq,
      opts.minPeriod || DEFAULT_MIN_PERIOD,
      opts.maxPeriod || DEFAULT_MAX_PERIOD,
      opts.minRepeats || DEFAULT_MIN_REPEATS,
      opts.maxSearchStart || DEFAULT_MAX_SEARCH_START
    );

    if (period) {
      const cycle = volSeq.slice(period.start, period.start + period.period);
      const overallMax = Math.max(...volSeq);
      if (isAttackLikeCycle(cycle, overallMax)) {
        // 周期部分は機械的に1周期=1音符として分割。その手前(リード部分)だけMethod Aを適用
        const ranges = period.start > 0 ? splitByJump(volSeq.slice(0, period.start), jumpThreshold, 0) : [];
        let i = period.start;
        while (i < n) {
          const end = Math.min(i + period.period, n);
          ranges.push({ start: i, end });
          i = end;
        }
        return ranges.filter(r => r.end > r.start);
      }
      // トレモロ判定: 分割せず1つの音符のまま(周期はanalyzeVolumeShape側で改めて検出される)
      return [{ start: 0, end: n }];
    }

    // 周期が見つからない: 全区間をMethod A(単フレームジャンプ)だけで判定
    return splitByJump(volSeq, jumpThreshold, 0);
  };
})(globalThis);

/*
 * DPCMコンバータ
 * MML.Dpcm
 *
 * PCM音声(WAV等、ブラウザのdecodeAudioDataが対応する形式)を
 * 2A03 DMCチャンネル用の1bit デルタ変調(DPCM)データへ変換する。
 *
 * - DMC_RATE_TABLE_NTSC: $4010 のレート値(0-15)に対応する再生周波数(Hz)
 * - encode(samples, sourceRate, rateIndex) -> { bytes: Uint8Array, rateIndex, rateHz, sampleCount }
 * - decode(bytes, sampleCount) -> Float32Array (-1..1, プレビュー用)
 */
(function (global) {
  const MML = global.MML = global.MML || {};

  // NTSC版 2A03 DMCレートテーブル ($4010 下位4bit -> 再生周波数Hz)
  const DMC_RATE_TABLE_NTSC = [
    4181.71, 4709.93, 5264.04, 5593.04, 6257.95, 7046.35, 7919.35, 8363.42,
    9419.86, 11186.10, 12604.00, 13982.64, 16884.6, 21306.8, 24858.0, 33143.9
  ];

  // 線形補間によるリサンプリング
  function resample(samples, srcRate, dstRate) {
    if (srcRate === dstRate) return samples.slice();
    const dstLength = Math.max(1, Math.round((samples.length * dstRate) / srcRate));
    const out = new Float32Array(dstLength);
    for (let i = 0; i < dstLength; i++) {
      const srcPos = (i * (samples.length - 1)) / Math.max(1, dstLength - 1);
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const frac = srcPos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  // ── 1bit列の生成 ──────────────────────────────────────────────────
  // DACカウンタの遷移は実機DMC(およびsrc/emulator/apu2a03.js clockOutput())と同じ:
  //   bit=1: counter<=125 なら +2、それ以外は変化なし
  //   bit=0: counter>=2   なら -2、それ以外は変化なし
  // (以前は0/127でclampしていたが、実機は125/2で頭打ちし±1の飛び越えは起きない=
  //  カウンタの偶奇は初期値のまま保存される。エンコーダの想定と再生側の実挙動を
  //  完全一致させるためこちらへ統一した)
  function stepUp(c) { return c <= 125 ? c + 2 : c; }
  function stepDown(c) { return c >= 2 ? c - 2 : c; }

  // 貪欲法(旧方式): その場その場で目標に近づく方だけを選ぶ。O(N)で省メモリ。
  // Viterbiのメモリ上限を超える長大入力のフォールバック用に残す。
  function encodeBitsGreedy(targets, startCounter) {
    const bits = new Uint8Array(targets.length);
    let counter = startCounter;
    for (let i = 0; i < targets.length; i++) {
      const bit = targets[i] >= counter ? 1 : 0;
      counter = bit ? stepUp(counter) : stepDown(counter);
      bits[i] = bit;
    }
    return bits;
  }

  // Viterbi(動的計画法): カウンタ128状態×サンプル数の格子で二乗誤差合計が最小になる
  // bit列を選ぶ(2026-08、貪欲法からの品質改善)。貪欲法は「今」最善のbitしか選べないため、
  //   ・平坦部で目標の上下どちらに張り付くかの位相が最適にならない(アイドルトーン悪化)
  //   ・大きなジャンプの直前に「助走」できない(スロープ過負荷の増幅)
  // が起きる。DPは全体最適なのでどちらも自動的に解決する。計算量O(64N)
  // (±2遷移で偶奇が保存されるため実際に到達しうる状態は64個)。
  // バックポインタは1状態あたり2bit(採用bit+自己ループか)をパックして持つ
  // (N*32バイト。上限VITERBI_MAX_SAMPLESを超える入力は貪欲法へフォールバック)。
  const VITERBI_MAX_SAMPLES = 2000000; // バックポインタ約64MBまで許容
  function encodeBitsViterbi(targets, startCounter) {
    const N = targets.length;
    if (N > VITERBI_MAX_SAMPLES) return encodeBitsGreedy(targets, startCounter);
    const par = startCounter & 1; // 偶奇は保存される(上のコメント参照)
    let prev = new Float64Array(128).fill(Infinity);
    let next = new Float64Array(128);
    prev[startCounter] = 0;
    const bp = new Uint8Array((N * 128 + 3) >> 2); // (i,状態)ごとに2bit
    for (let i = 0; i < N; i++) {
      next.fill(Infinity);
      const t = targets[i];
      const base = i * 128;
      for (let c = par; c < 128; c += 2) {
        const pc = prev[c];
        if (pc === Infinity) continue;
        const n1 = stepUp(c);
        const e1 = n1 - t;
        const c1 = pc + e1 * e1;
        if (c1 < next[n1]) {
          next[n1] = c1;
          const idx = base + n1, code = 1 | (n1 === c ? 2 : 0);
          bp[idx >> 2] = (bp[idx >> 2] & ~(3 << ((idx & 3) * 2))) | (code << ((idx & 3) * 2));
        }
        const n0 = stepDown(c);
        const e0 = n0 - t;
        const c0 = pc + e0 * e0;
        if (c0 < next[n0]) {
          next[n0] = c0;
          const idx = base + n0, code = (n0 === c ? 2 : 0);
          bp[idx >> 2] = (bp[idx >> 2] & ~(3 << ((idx & 3) * 2))) | (code << ((idx & 3) * 2));
        }
      }
      const tmp = prev; prev = next; next = tmp;
    }
    // 終端: 最小コストの状態から逆順にbitと前状態を復元する
    let best = par, bestCost = Infinity;
    for (let c = par; c < 128; c += 2) if (prev[c] < bestCost) { bestCost = prev[c]; best = c; }
    const bits = new Uint8Array(N);
    let s = best;
    for (let i = N - 1; i >= 0; i--) {
      const idx = i * 128 + s;
      const code = (bp[idx >> 2] >> ((idx & 3) * 2)) & 3;
      const bit = code & 1;
      bits[i] = bit;
      if (!(code & 2)) s = bit ? s - 2 : s + 2; // 自己ループでなければ遷移を巻き戻す
    }
    return bits;
  }

  /**
   * PCMサンプル(-1..1, srcRate Hz)をDPCMバイト列にエンコードする
   * @param {Float32Array} samples
   * @param {number} srcRate - 入力サンプルレート(Hz)
   * @param {number} rateIndex - DMCレートインデックス(0-15)
   * @param {{startCounter?:number}} [opt] - startCounter: DACカウンタの開始値(0-127、既定64)。
   *   再生側が@DPCM定義のdac値($4011初期書込み)で同じ値から開始する前提で、先頭サンプル値を
   *   渡すと頭の追従ランプ(クリック)が消える(hes2mml/expansion/dpcm.js参照)。
   * @returns {{bytes: Uint8Array, rateIndex: number, rateHz: number, sampleCount: number, startCounter: number}}
   */
  function encode(samples, srcRate, rateIndex, opt) {
    rateIndex = Math.max(0, Math.min(15, rateIndex | 0));
    const rateHz = DMC_RATE_TABLE_NTSC[rateIndex];
    const resampled = resample(samples, srcRate, rateHz);
    const startCounter = Math.max(0, Math.min(127, (opt && opt.startCounter != null) ? opt.startCounter | 0 : 64));

    const targets = new Float64Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) targets[i] = (resampled[i] * 0.5 + 0.5) * 127; // 0-127
    const bits = encodeBitsViterbi(targets, startCounter);

    // DMCサンプルはバイト単位(8サンプル/byte, LSBが先頭)で、
    // 長さは16バイト境界に揃える必要がある。
    // ★パディングは0bit詰めではなく+2/-2交互の「ホールド」で埋める。実機DMCは
    // 16バイト境界までの全bitを再生するため、0詰めだと末尾でDACが-2/bitで滑り落ちて
    // プチッと鳴る(プレビューのdecode()はsampleCountで止まるため気づけない)。
    const sampleCount = bits.length;
    const byteCount = Math.ceil(sampleCount / 8 / 16) * 16 || 16;
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < sampleCount; i++) {
      if (bits[i]) bytes[i >> 3] |= (1 << (i & 7));
    }
    for (let i = sampleCount; i < byteCount * 8; i++) {
      // 最後のデータbitと逆から始めて交互に(±2の往復=値を保持)
      const bit = ((i - sampleCount) & 1) === 0 ? (sampleCount > 0 ? 1 - bits[sampleCount - 1] : 1) : (sampleCount > 0 ? bits[sampleCount - 1] : 0);
      if (bit) bytes[i >> 3] |= (1 << (i & 7));
    }

    return { bytes, rateIndex, rateHz, sampleCount, startCounter };
  }

  /**
   * DPCMバイト列をプレビュー用PCM波形(-1..1)に復号する
   * @param {Uint8Array} bytes
   * @param {number} sampleCount
   * @param {number} [startCounter] - encode時のstartCounterと同じ値(既定64)
   * @returns {Float32Array}
   */
  function decode(bytes, sampleCount, startCounter) {
    const out = new Float32Array(sampleCount);
    let counter = (startCounter != null) ? Math.max(0, Math.min(127, startCounter | 0)) : 64;
    for (let i = 0; i < sampleCount; i++) {
      const bit = (bytes[i >> 3] >> (i & 7)) & 1;
      counter = bit ? stepUp(counter) : stepDown(counter); // 実機DMC/エンコーダと同一遷移
      out[i] = (counter / 127) * 2 - 1;
    }
    return out;
  }

  /**
   * 16進数文字列ダンプ
   */
  function hexDump(bytes, perLine) {
    perLine = perLine || 16;
    const lines = [];
    for (let i = 0; i < bytes.length; i += perLine) {
      const chunk = Array.from(bytes.slice(i, i + perLine));
      lines.push(chunk.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    }
    return lines.join('\n');
  }

  MML.Dpcm = {
    DMC_RATE_TABLE_NTSC,
    resample,
    encode,
    decode,
    hexDump
  };
})(globalThis);

/*
 * HES PSG 波形ch(0-5) → MML共通イベント形式 抽出(N163への借用を前提)
 * MML.Hes2MmlExpansion.wave(snapshots, waveReg, envReg) → { channels: [ch0..ch5], n163Wave }
 *
 * PC EngineのPSGは6ch全てが同種の32サンプル5bit波形音源で、N163(最大8ch、可変長波形)への
 * 借用が最も自然(DESIGN.md §5)。kss2mml/expansion/scc.js(32サンプル波形チップ→N163)と
 * 同じ設計を踏襲する。5bit(0-31)→N163の4bit(0-31を0-15へ、単純に1bit右シフト)で
 * ビット深度のみ落とす(情報量を最小限の劣化で移す)。
 *
 * PSGには専用アタックレジスタが無い(on/off・音量書換えだけの素朴な発振器)ため、
 * 打ち直し(ロール奏法)の検出はsrc/convert/retrigger.jsの共通ヒューリスティックに委ねる
 * (nsf2mml/expansion/n163.jsと同じ2パス構成: パス1でピッチ/波形が同じ区間をまとめ、
 * パス2でsplitRetriggersにより音量の跳ね上がりを打ち直しとして分割する)。
 *
 * ch4/5はノイズモード(noiseOn)の間、この波形chとしては「休符」として扱う
 * (ノイズ側の抽出はhes2mml/expansion/noise.js が別途担当し、2A03ノイズchへ借用する)。
 * DDAモード(直接D/A、音声ストリーミング用)は@DPCM(hes2mml/expansion/dpcm.js)が担当する。
 *
 * ★巡回シフト(rotation)の正規化について: PSGの波形バッファは「読み出し位相」と
 * 「$0806書込み位相」が同一のカウンタを共有する実機仕様を持つ(ユーザーとの調査で判明。
 * DDAが1→0に落ちた瞬間だけ位相が0にリセットされ、単なる$0806書込みや音符のon/off
 * 切替では0に戻らない)。そのため、多くの曲は演奏中のchに対しDDAを経由せず波形を
 * 再アップロードしており、毎回「前回どこまで読み出しが進んでいたか」という位相から
 * 書込みが始まる。結果、ドライバが送っているのは実質同じ波形データでも、バッファの
 * 中身は送るたびに開始オフセットが違う「巡回シフトしたコピー」になる
 * (聴感上は「音色が切り替わっている」のではなく「同じ波形がスライドして見える」)。
 * これを生の配列比較(完全一致)のまま音符分割・WaveRegistry登録に使うと、1サンプルでも
 * 巡回位置がずれるたびに別音符・別@N<n>として扱われ、音色定義と音符数が異常に
 * 膨れ上がる(ユーザー報告で発覚)。canonicalRotation()で「32通りの巡回シフトのうち
 * 辞書順最小のもの」に正規化してから音符分割・登録の両方に使うことで、巡回シフトだけの
 * 違いを同一波形とみなす。定常音では巡回シフトしても倍音構成(聴感上の音色)は変わらない
 * ため、音楽的忠実度への影響は無視できる(1周期未満、最大でも数ミリ秒の位相ズレのみ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  MML.Hes2MmlExpansion.CH_COUNT = 6;
  const WAVE_LEN = 32;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  // f = PSG_CLOCK / (32 * period) (hesHeader.js HES.PSG_CLOCK、apuHuC6280.jsのclock()と同じ式)
  function waveFreq(periodReg) { return periodReg > 0 ? MML.HES.PSG_CLOCK / (32 * periodReg) : 0; }
  MML.Hes2MmlExpansion._waveFreq = waveFreq; // converter.jsのapplyPitchDetuneから使う

  // ch別バランス($0805)・全体バランス($0801)まで込みの実効音量インデックス(0-31)を返す
  // (apuHuC6280.js PsgChannel.gainLR()と全く同じ式。vol(0-31)は音量レジスタの生値)。
  //
  // ★重要(2026-08-26): $0805は「パン」専用ではなく、音量レジスタと同じインデックスへ
  // 合流する同一スケール(1step≒1.5dB)の減衰器=事実上の第2の音量レジスタである。
  // 実測(NX91002.hes)ではbalance値が左右対称($99/$88/$77…)の曲が多く、パンではなく
  // 純粋なチャンネル別の音量調整として使われている(idx34はch毎に$ee/$cc/$88/$bbで、
  // $88のchは$eeのchより14段=21dB下)。さらにidx34 ch3は音量レジスタを31に固定したまま
  // balanceを$99→$33へ掃引する「balanceだけで作った減衰エンベロープ」だった。
  // 以前はこの関数の代わりにpanSilent()(L/R両方が厳密に0か)を無音判定にだけ使い、
  // 減衰量そのものを完全に無視していたため、チャンネル間のミックスバランスが
  // 平均14.8dB崩れ、balance駆動のフェードは平坦な持続音に化けていた。
  // 実効インデックスを音量として使うことで両方が同時に解決し、無音判定も
  // 「実効インデックス0」として自然に吸収される(panSilentは廃止)。
  //
  // L/Rの扱い: 借用先(N163)にパンの概念が無いため、大きい方の側を採用して
  // 「その音がミックス上どれだけ大きいか」を保つ(SPC(spc2mml/converter.js frameVol)が
  // ボイス音量のVOL L/Rに対して max(|L|,|R|) を採るのと同じ方針)。
  function effectiveVolIndex(vol, balance, globalBalance) {
    const v = vol - 0x1E * 2;
    const lPan = (balance >> 4) & 0x0F, rPan = balance & 0x0F;
    const gL = (globalBalance >> 4) & 0x0F, gR = globalBalance & 0x0F;
    const left = Math.max(0, v + lPan * 2 + gL * 2);
    const right = Math.max(0, v + rPan * 2 + gR * 2);
    return Math.min(31, Math.max(left, right));
  }
  MML.Hes2MmlExpansion._effectiveVolIndex = effectiveVolIndex; // noise.jsから共用

  // ── ソフトウェア音量エンベロープの位相エイリアシング対策(2026-08-26) ──────────
  // HESにはNSF/KSS/GBSのような「PLAYルーチンをフレームレートで呼ぶ」規約が無く、
  // ゲームが内蔵タイマー(TIQ)を自前の周期で回して音量を1段ずつ書く(実測: NX91002は
  // 約54.9Hz=1.094フレーム間隔)。フレーム境界のスナップショットで音量列を作ると、
  // どのステップが2フレームに見えるかがノート開始の位相で毎回変わり、同じエンベロープが
  // 「各段±1フレーム違いの列」として数百種類の@v<n>に化ける(ユーザー実測: NX91002
  // idx34/180秒で@v252個。GBSの64Hzハードエンベロープクロック位相エイリアシングと同類だが、
  // HESはソフトエンベロープなのでレジスタパラメータからの決定論的再現はできない)。
  // 対策: captureHesSongAsyncのcontrolTrace($0804書込み列、音量の生値と分数フレーム時刻t
  // 付き)から volume(t) を区分定数関数として復元し、「ノートの開始書込みを原点にした
  // 相対時刻 t0+k (kフレーム目)」でリサンプルする。位相の基準がグローバルなフレーム格子
  // ではなくノート自身のアタック書込みになるため、同じエンベロープは駆動レートが何Hzでも
  // 必ず同一の列になり、EnvelopeRegistryの完全一致dedupeがそのまま効く。
  // 列の長さ(=ノートのフレーム数)と実時間の対応は変えないので、再生タイミングは不変。

  // controlTraceの1ch分から音量タイムライン[{t, v}](v=4bit音量)を作る。旧形式トレース
  // (vol/tフィールド無し)やVGM経由(トレース自体が空)はnullを返し、呼び出し側は
  // 従来のスナップショット列をそのまま使う。
  // ★bal/gbal(ch別バランス$0805・全体バランス$0801)が記録されているトレースでは、
  // 生の音量レジスタではなく実効音量インデックス(effectiveVolIndex参照)から作る。
  // これらは実質的に第2の音量レジスタで、balanceだけで減衰エンベロープを作る曲もあるため
  // (キャプチャ側hesPlayer.jsは$0805/$0801の書込みも変化点としてこのトレースへ積む)。
  // 旧形式(bal無し)は従来どおり生の音量レジスタで代替する。
  function buildVolTimeline(trace) {
    if (!trace || trace.length === 0 || trace[0].vol === undefined || trace[0].t === undefined) return null;
    const hasBal = trace[0].bal !== undefined;
    return trace.map((e) => ({
      t: e.t,
      v: Math.max(0, Math.min(15, (hasBal ? effectiveVolIndex(e.vol, e.bal, e.gbal) : e.vol) >> 1))
    }));
  }
  MML.Hes2MmlExpansion._buildVolTimeline = buildVolTimeline; // noise.jsから共用

  // pitchTrace($0802/$0803書込み列、hesPlayer.js参照)の1ch分から周期タイムライン
  // [{t, v}](v=12bit周期生値)を作る。音量と同じ位相エイリアシングがビブラート等の
  // ピッチ列(pitchSeq→EP/MPテーブル・音程判定)にも乗るため、同じ仕組みで正規化する。
  function buildPitchTimeline(trace) {
    if (!trace || trace.length === 0 || trace[0].t === undefined) return null;
    return trace.map((e) => ({ t: e.t, v: e.freq }));
  }

  // [startFrame, endFrame)のノートの音量列(長さendFrame-startFrame)を、ノート相対時刻で
  // リサンプルして返す(冒頭コメント参照)。原点t0は「開始フレーム内の最後の書込み」
  // (スナップショットが見るアタック値と同じ書込み。駆動tickは1フレームより長いのが普通で
  // 同一フレーム内に複数書込みがある場合は直前ノートの残りが先行しているだけ)。
  // 開始フレーム内に書込みが無い(音量変化を伴わないノート境界)場合はフレーム原点に
  // フォールバックし、書込みがまだ一度も無い区間はfallbackSeq(スナップショット列)を使う。
  function resampleSeq(timeline, startFrame, endFrame, fallbackSeq) {
    if (!timeline || timeline.length === 0) return fallbackSeq;
    let lo = 0, hi = timeline.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (timeline[m].t < startFrame) lo = m + 1; else hi = m; }
    let anchor = -1;
    for (let i = lo; i < timeline.length && timeline[i].t < startFrame + 1; i++) anchor = i;
    const t0 = anchor >= 0 ? timeline[anchor].t : startFrame;
    const len = endFrame - startFrame;
    const out = new Array(len);
    let j = lo - 1;
    for (let k = 0; k < len; k++) {
      const sampleT = t0 + k;
      while (j + 1 < timeline.length && timeline[j + 1].t <= sampleT) j++;
      out[k] = j >= 0 ? timeline[j].v : (fallbackSeq ? fallbackSeq[k] : 0);
    }
    return out;
  }
  MML.Hes2MmlExpansion._resampleSeq = resampleSeq; // noise.jsから共用

  // PSGの5bit(0-31)波形をN163の4bit(0-15)へビット深度変換する(単純な1bit右シフト、
  // 0-31を0-15へ均等対応。情報量の損失は最小限)。
  function resampleTo4bit(wave) {
    const out = new Array(WAVE_LEN);
    for (let i = 0; i < WAVE_LEN; i++) out[i] = Math.max(0, Math.min(15, wave[i] >> 1));
    return out;
  }

  // wave(長さWAVE_LENの配列)の32通りの巡回シフトのうち、要素を","結合した文字列が
  // 辞書順最小になるものを返す(冒頭コメント参照)。WAVE_LEN=32程度なのでO(n^2)の
  // 素朴な全探索で十分高速。
  function canonicalRotation(wave) {
    const n = wave.length;
    let best = wave;
    let bestKey = wave.join(',');
    for (let r = 1; r < n; r++) {
      const rotated = wave.slice(r).concat(wave.slice(0, r));
      const key = rotated.join(',');
      if (key < bestKey) { bestKey = key; best = rotated; }
    }
    return best;
  }

  // useCanonicalRotation: false(既定)だとcanonicalRotation()(32要素のO(n^2)巡回シフト探索)を
  // 省略し、素の4bitリサンプルだけを使う。実際のMML変換(@N<n>の重複排除)ではtrueにして
  // 必ず正規化するが、main.js buildHesRollTimeline()(ネイティブ再生中に先読み進捗のたび
  // 全snapshotsを最初から処理し直すピアノロール表示用)は音符境界の見た目が多少荒くても
  // 実害が無く、フレーム数×6ch分この演算が積み重なると再生中の音声コールバックと
  // メインスレッドを奪い合って「がくがく」の一因になっていた(ユーザー実測。この関数は
  // hes2mml変換とロール表示の両方から共有されているため、変換専用のはずのコストが
  // 意図せずロール表示側にも波及していた)。
  function extractChannelEvents(snapshots, chIndex, useCanonicalRotation) {
    const runs = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) runs.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chIndex];
      // 実効音量(balance込み。effectiveVolIndex冒頭コメント参照)。0=無音なので、
      // 以前のpanSilent判定はこの値が0かどうかに吸収されている
      const effVol = effectiveVolIndex(c.vol, c.balance, snapshots[f].globalBalance);
      const activeWave = c.on && !c.dda && !c.noiseOn && effVol > 0;
      const vol4 = Math.max(0, Math.min(15, effVol >> 1));
      const freqHz = activeWave ? waveFreq(c.freq) : 0;
      const note = (activeWave && vol4 > 0 && freqHz > 0) ? freqToNoteNumber(freqHz) : null;
      // 巡回シフトの正規化(冒頭コメント参照): 音符分割にも@N<n>登録にも常にこの
      // 正規化後の配列を使うことで、位相がズレただけの再アップロードを同一波形とみなす
      // (useCanonicalRotation=falseの場合は上記コメントの理由で省略する)。
      const resampled = resampleTo4bit(c.wave);
      const wave4 = useCanonicalRotation ? canonicalRotation(resampled) : resampled;
      const waveKey = wave4.join(',');
      if (!cur) { cur = { note, wave: wave4, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol4], pitchSeq: [c.freq], tieCandidate: false }; continue; }
      if (note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // 「純粋な音程変化」(=タイで繋いでよいレガート)の判定。波形切替を伴わないことに加え、
        // ★この境界で音量が跳ね上がっていない(=打ち直しでない)ことも要る(2026-08-26修正)。
        // PSGには専用アタックレジスタが無いため打ち直しの手がかりは音量の跳ね上がりだけだが、
        // それを見るパス2のsplitRetriggersは同一音程ラン内しか走らず、音程が変わる境界は
        // 素通りしていた。結果、実際は再アタックしている音程変化までタイ候補になり、タイ側は
        // @v等を再指定しない仕様のため音量エンベロープが減衰し続けていた(nsf2mml/expansion/
        // n163.jsと同じ穴。女神転生II 12曲目のN163で発覚した同一原因)。
        const prevVol = cur.volSeq[cur.volSeq.length - 1];
        const reattack = prevVol != null && (vol4 - prevVol) >= MML.Convert.RETRIGGER_JUMP_THRESHOLD;
        const pureNoteChange = !reattack && note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave: wave4, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol4], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol4);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);

    // パス2: 打ち直し(ロール)検出(retrigger.js参照)。休符ランは対象外。
    // tieCandidateはrun先頭のパス1判定をそのまま引き継ぐが、runの途中で打ち直しにより
    // 新設された区間(r.start>0、実際に音量ジャンプで区切られた=本物の再アタック)は
    // 常にfalseにする(パス1では見えていなかった打ち直しがここで確定するため)
    const events = [];
    for (const run of runs) {
      if (run.note == null) { events.push(run); continue; }
      const ranges = MML.Convert.splitRetriggers(run.volSeq);
      for (const r of ranges) {
        events.push({
          note: run.note, wave: run.wave, waveKey: run.waveKey, rawFreq: run.rawFreq,
          start: run.start + r.start, end: run.start + r.end,
          volSeq: run.volSeq.slice(r.start, r.end),
          pitchSeq: run.pitchSeq.slice(r.start, r.end),
          tieCandidate: r.start === 0 ? run.tieCandidate : false
        });
      }
    }
    return events;
  }

  // waveReg/envRegは省略可(ピアノロール用タイムライン構築時は渡されない、
  // kss2mml/expansion/scc.jsと同じ理由)。waveRegが無い(=ロール表示専用)呼び出しでは
  // canonicalRotationを省略し、再生中のメインスレッド負荷を抑える(extractChannelEvents
  // 冒頭コメント参照)。
  // opts.maxAbsorbCents: mergeAlternatingVibratoの統合上限(pitch.js参照)。SA<num>導入後は
  // 深い変調もEP/MPで表現できるため既定は無制限。SA不使用(変換設定PITCH_SA='off')のときだけ
  // 呼び出し元が70を渡し、表現不能な深い統合を音符の交互のまま残す(従来動作)。
  MML.Hes2MmlExpansion.wave = function (snapshots, waveReg, envReg, controlTrace, pitchTrace, opts) {
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(ev.wave) } : {},
      ev.note !== null && ev.rawFreq != null ? { rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(waveFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );

    const channels = [];
    for (let i = 0; i < MML.Hes2MmlExpansion.CH_COUNT; i++) {
      const rawEvents = extractChannelEvents(snapshots, i, !!waveReg);
      // ソフトエンベロープの位相エイリアシング対策(buildVolTimeline冒頭コメント参照):
      // 音符イベントのvolSeq(音量列)とpitchSeq(周期生値列、ビブラート/EP検出の入力)を
      // ノート相対時刻リサンプル列へ差し替える。マージ(mergeVibratoAndArpeggio等)より
      // 前に行い、以後の利用は全て正規化済み列を見る。
      const volTimeline = controlTrace ? buildVolTimeline(controlTrace[i]) : null;
      const pitchTimeline = pitchTrace ? buildPitchTimeline(pitchTrace[i]) : null;
      for (const ev of rawEvents) {
        if (ev.note === null) continue;
        if (volTimeline) ev.volSeq = resampleSeq(volTimeline, ev.start, ev.end, ev.volSeq);
        if (pitchTimeline) ev.pitchSeq = resampleSeq(pitchTimeline, ev.start, ev.end, ev.pitchSeq);
      }
      channels.push({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
        // P-5「不明瞭→EPテーブル」側(2026-08-12)。統合上限はopts経由(関数冒頭コメント参照)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(rawEvents,
          { maxAbsorbCents: opts && opts.maxAbsorbCents != null ? opts.maxAbsorbCents : null })).map(toCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true
      });
    }

    const finalSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1][0] : null;
    return {
      channels,
      n163Wave: finalSnap ? resampleTo4bit(finalSnap.wave) : new Array(WAVE_LEN).fill(0)
    };
  };
})(globalThis);

/*
 * HES PSG ノイズ(ch4/5のnoiseOnモード) → MML共通イベント形式 抽出(2A03ノイズchへの借用)
 * MML.Hes2MmlExpansion.noise(snapshots) → { events }
 *
 * ノイズ生成回路を持つのはPSGのch4/5の2chのみ(hesBus.js/apuHuC6280.js参照)だが、
 * 借用先の2A03ノイズは物理的に1chしか無い。両方が同時にノイズモードになるケースは稀と
 * 見込み、両方アクティブな場合はch5を優先する(単純な優先順位、gbs2mml/expansion/noise.js
 * のGB(元々1ch)と違いここは近似が必要な箇所として明記しておく)。
 *
 * 周波数式(文献): freq = PSG_CLOCK / (64 * (5bit値 XOR 31))。借用先の2A03ノイズは固定16
 * 周期しか持たないため、実測周波数に一番近い2A03周期を選ぶ近似変換になる
 * (gbs2mml/expansion/noise.jsと同じ考え方。detune補正の対象外である理由も同じ:
 * 離散的な周期の入れ替えであり連続量の微調整という概念が無い)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  const NES_CPU_CLOCK = 1789773;
  const NES_NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  const NES_NOISE_FREQS = NES_NOISE_PERIOD.map(p => NES_CPU_CLOCK / p);

  function psgNoiseFreq(noiseCtrl) {
    const invVal = Math.max(1, (~noiseCtrl) & 0x1F);
    return MML.HES.PSG_CLOCK / (64 * invVal);
  }

  function psgNoiseFreqToNote(freqHz) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return 31 - best;
  }

  // 物理ch(4 or 5)単独のノイズイベント列(マージ無し)。noise()はMML書き出し用に
  // 2A03への借用(物理1chしか無い)を前提としてch5優先でch4/5をマージするが、
  // ピアノロール/鍵盤表示はch4・ch5を別々の行として独立に持つため、マージせず
  // 物理chごとのイベント列が必要(main.js buildHesRollTimeline参照。
  // 「ないチャンネルの表示がロールにある」バグ調査で発覚: 従来はnoise()のマージ結果を
  // どの行にも属さない別idのゴースト行として表示していたため、ミュートが効かず色も
  // 一致しなかった)。
  function extractChannelNoiseEvents(snapshots, chIndex) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chIndex];
      // 実効音量(balance込み。wave.js effectiveVolIndex冒頭コメント参照)
      const effVol = MML.Hes2MmlExpansion._effectiveVolIndex(c.vol, c.balance, snapshots[f].globalBalance);
      const active = c.on && c.noiseOn && effVol > 0;
      const vol4 = active ? Math.max(0, Math.min(15, effVol >> 1)) : 0;
      const note = (active && vol4 > 0) ? psgNoiseFreqToNote(psgNoiseFreq(c.noiseCtrl)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [vol4] }; continue; }
      if (note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [vol4] };
      } else {
        cur.volSeq.push(vol4);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Hes2MmlExpansion.noiseChannel = function (snapshots, chIndex) {
    const events = extractChannelNoiseEvents(snapshots, chIndex)
      .map(ev => ({ note: ev.note, start: ev.start, end: ev.end, volume: ev.volSeq[0] }));
    return { events };
  };

  function pickSource(snapFrame) {
    const c5 = snapFrame[5], c4 = snapFrame[4];
    const audible = c => MML.Hes2MmlExpansion._effectiveVolIndex(c.vol, c.balance, snapFrame.globalBalance) > 0;
    if (c5.on && c5.noiseOn && audible(c5)) return c5;
    if (c4.on && c4.noiseOn && audible(c4)) return c4;
    return null;
  }

  // pickSourceと同じ優先順位でchインデックス(5/4/null)だけ返す(音量リサンプルが
  // どのchの$0804書込みタイムラインを参照すべきかを知るため。wave.js冒頭の
  // 位相エイリアシング対策コメント参照)
  function pickSourceIndex(snapFrame) {
    const c5 = snapFrame[5], c4 = snapFrame[4];
    const audible = c => MML.Hes2MmlExpansion._effectiveVolIndex(c.vol, c.balance, snapFrame.globalBalance) > 0;
    if (c5.on && c5.noiseOn && audible(c5)) return 5;
    if (c4.on && c4.noiseOn && audible(c4)) return 4;
    return null;
  }

  function extractEvents(snapshots) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const src = pickSource(snapshots[f]);
      // 実効音量(balance込み。wave.js effectiveVolIndex冒頭コメント参照)
      const vol4 = src
        ? Math.max(0, Math.min(15, MML.Hes2MmlExpansion._effectiveVolIndex(src.vol, src.balance, snapshots[f].globalBalance) >> 1))
        : 0;
      const note = (src && vol4 > 0) ? psgNoiseFreqToNote(psgNoiseFreq(src.noiseCtrl)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [vol4], srcCh: pickSourceIndex(snapshots[f]) }; continue; }
      if (note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [vol4], srcCh: pickSourceIndex(snapshots[f]) };
      } else {
        cur.volSeq.push(vol4);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Hes2MmlExpansion.noise = function (snapshots, envReg, controlTrace) {
    const events = extractEvents(snapshots);
    // ソフト音量エンベロープの位相エイリアシング対策(wave.js buildVolTimeline冒頭コメント
    // 参照)。ノイズはch4/5どちらかを借りるため、イベント開始時点の担当chのタイムラインで
    // リサンプルする(イベント途中でchが移る曲は稀で、その場合もエンベロープ形状はほぼ
    // 同一のため開始chで代表させる)。
    const timelines = controlTrace
      ? [null, null, null, null,
         MML.Hes2MmlExpansion._buildVolTimeline(controlTrace[4]),
         MML.Hes2MmlExpansion._buildVolTimeline(controlTrace[5])]
      : null;
    if (timelines) {
      for (const ev of events) {
        const tl = ev.srcCh != null ? timelines[ev.srcCh] : null;
        if (ev.note !== null && tl) ev.volSeq = MML.Hes2MmlExpansion._resampleSeq(tl, ev.start, ev.end, ev.volSeq);
      }
    }
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
 * HES PSG DDA(直接D/A、PCM/音声サンプル再生)モード → @DPCM<n> 抽出
 * MML.Hes2MmlExpansion.dpcm(snapshots, dpcmTrace, controlTrace, frameRate) → { defs, files, events }
 *
 * PSGはどのch(0-5)もDDAモードに切替可能だが、実機DMC(NES)と同じくこのアプリの
 * @DPCM<n>チャンネル文字は1つしか存在しない(src/mml/compiler.js CHIP_CHANNEL_COUNTS.dpcm=1、
 * 実機ppmck準拠)。曲全体でDDA区間の合計が最も長い1chだけを採用し、他chは無視する
 * (実測ではPCM/音声は特定の1ch(例: NX91002.hesのch5)に集約されることが多く、
 * 実用上の影響は小さいと判断)。
 *
 * DDAは実機DMCと違い「トリガー時に固定レート・固定長のサンプルを鳴らす」ハードウェアが
 * 無く、CPUが$0806へ生の5bitサンプル値を直接・高頻度(1フレームあたり数十〜百回)に
 * 書き込み続けることで音を作る(ソフトウェアPCM)。そのためNSFのDMCトリガー抽出
 * (nsf2mml/converter.js extractDmcTriggers)のような「レジスタから直接読める固定パラメータ」
 * が無く、hesPlayer.js captureHesSongAsync が記録する dpcmTrace($0806書込み列)から
 * 実際の再生レートを逆算し、MML.Dpcm.encode()でこのアプリのDPCM(2A03 DMC形式)へ変換する。
 *
 * ★2026-08-26 全面改修(それまでの経緯は下の「旧方式」も参照):
 * NX91002.hes idx33等で「実音は10種以下なのに@DPCM定義が数百件」+打点の頭に
 * キーン系ノイズが乗る問題の真因を実測で特定した:
 *   1. 打点の区切り($0804のoff→次のon)がほぼ常に同一フレーム内で起きる(実測254/255)。
 *      旧トレースはフレーム番号しか持たないため書込み順を復元できず、境界フレームの
 *      $0806書込み(平均約80サンプル≒12ms)が丸ごと次クリップの頭に混入していた。
 *      直前に鳴っていた音の尾は毎回違うので、同じドラムでも頭が毎回異なり、
 *      完全一致/あいまい判定の両方が外れて全打点が別定義になっていた。
 *      混入した異物がクリック/キーン系ノイズの実体でもある。
 *   2. あいまい判定が固定閾値(長さ差≤2サンプル・先頭固定アラインMAD≤1.0)で厳しすぎた。
 *   3. 同じドラムを途中でブツ切りして鳴らす打点(長い定義の前方一致)が全部別定義になっていた。
 *
 * 対策として、キャプチャ(hesPlayer.js)がトレースへ追加した3情報を使う:
 *   seq … controlTrace/dpcmTrace共通の書込み順連番。区切りを書込み1件単位で正確に復元する。
 *   t   … 分数フレーム時刻。クリップの再生レートをフレーム量子化誤差なしで推定する。
 *   src … サンプル値の読出し元ROM物理オフセット(ROM直読み・無加工と検証済みのときだけ、
 *         それ以外は-1)。cpuHuC6280.js fetchOperandのlastDataAddr由来。
 * srcが使えるクリップは「ROM開始アドレス=ドラムのID」として確定的に重複排除でき、
 * アドレスジャンプ=サンプル境界なので$0804トグルより正確な区切りにもなる
 * (実測: NX91002.hesはストリーミングループ LDA (zp) がROMを+1連続で直読みし、
 * 43142/43142件でROMバイトと書込み値が一致。書込みの残り29%はZP保持値の
 * ホールド書きでサンプル内容ではない=srcで自然に除外される)。
 * srcが使えない(RAMバッファ経由・音量テーブル加工などの)ROMは、seq精密区切りで
 * バイト列がほぼ完全一致になるため、完全一致+前方一致+緩和あいまい判定で潰す。
 * ※同じHuC6280曲でもVGM形式はCPU実行が無くこのトレース自体を作れない(空配列が渡る)ので、
 *   HES形式のほうがDPCM抽出精度は原理的に高い。
 *
 * 旧方式(seq/t/srcが無いトレースへのフォールバックとして保持):
 * snapshotsのon&&dda継続で区切る→controlTrace書込み順で区切る、と改善してきた
 * (フレーム未満のon/off切替の取りこぼし対策)。重複排除はWaveRegistry
 * (src/convert/waveRegistry.js)と同じ発想の完全一致+あいまい判定。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  const MIN_CLIP_SAMPLES = 4; // これ未満のクリップはノイズ的単発書込みとみなし無視する
  // run内の書込みのうちROM連続読みセグメントが占める割合がこれ以上なら
  // 「アドレス同定モード」(セグメント=クリップ、開始アドレス=ID)を使う。
  // 下回るROM(バッファ経由等)はバイト列一致モードへフォールバックする。
  const ADDR_COVERAGE_RATIO = 0.7;
  // アドレス同定モードで「1つのサンプル」とみなすROM連続セグメントの最小長(extractBySeq
  // 内のガード参照)。実測のドラム/ボイスは200〜2700サンプルなので十分に安全な下限
  const MIN_ADDR_SEG_SAMPLES = 32;

  // 実測レート(Hz)に対数距離で最も近いDMCレートインデックス(0-15)を選ぶ
  function bestDmcRateIndex(rateHz) {
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < table.length; i++) {
      const diff = Math.abs(Math.log2(rateHz / table[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  // PCM品質設定(cmd.PCM_RATE、src/convert/options.js冒頭コメント参照)に従って
  // DMCレートを選ぶ。1bitデルタ変調は1bitあたり±2/127しか動けないため、ソースの
  // バイトレートと同程度のDMCレート(旧来の「最も近いレート」)では
  //   (a) 5bitの1LSB遷移にすら2bit必要でアタックが盛大になまる(スロープ過負荷)
  //   (b) 平坦部の+2/-2交互トグルがレート/2の可聴キーン音になる(実測4.4kHz運用で約2.2kHz)
  // の両方を踏む。倍率を上げるほど追従が効きアイドルトーンも高域へ逃げるが、
  // データ量はレートに比例して増える(ユーザー判断でサイズと品質を選ぶ)。
  //   'max' … 常に最高レート33.1kHz(既定)
  //   8/4/2 … ソースレートのn倍以上となる最小レート(テーブル上限で頭打ち)
  //   1     … 従来互換(最も近いレート、データ最小)
  function dmcRateIndexFor(rateHz, pcmRate) {
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    if (pcmRate === 'max' || pcmRate == null) return table.length - 1;
    const mult = typeof pcmRate === 'number' ? pcmRate : parseInt(pcmRate, 10) || 4;
    if (mult <= 1) return bestDmcRateIndex(rateHz);
    for (let i = 0; i < table.length; i++) if (table[i] >= rateHz * mult) return i;
    return table.length - 1;
  }

  // controlTrace(書込み順の{frame,on,dda}イベント列)から、on&&ddaが連続している
  // 区間列を作る。書込み順に状態遷移を追うため、1フレーム内で複数回on/offが
  // 切り替わっても取りこぼさない。曲末尾でonのまま終わった場合はtotalFramesまで。
  // seq有りトレースでは{startSeq,endSeq,startFrame,endFrame}、無しでは{start,end}(フレーム)。
  function buildChannelRuns(trace, totalFrames) {
    const runs = [];
    let active = false, runStart = null;
    for (const ev of trace) {
      const newActive = ev.on && ev.dda;
      if (newActive === active) continue;
      if (newActive) {
        runStart = ev;
      } else if (runStart != null) {
        if (ev.frame > runStart.frame || (ev.seq !== undefined && ev.seq > runStart.seq)) {
          runs.push({ start: runStart.frame, end: ev.frame, startSeq: runStart.seq, endSeq: ev.seq, startFrame: runStart.frame, endFrame: ev.frame, vol: runStart.vol });
        }
        runStart = null;
      }
      active = newActive;
    }
    if (runStart != null && totalFrames > runStart.frame) {
      runs.push({ start: runStart.frame, end: totalFrames, startSeq: runStart.seq, endSeq: Infinity, startFrame: runStart.frame, endFrame: totalFrames, vol: runStart.vol });
    }
    return runs;
  }

  // ---- クリップ登録簿(アドレス同定/バイト列一致の両モード共用) --------------------
  // clips: [{samples:number[](0-31), rateHz}] を蓄積し、同じ音は1つのindexへまとめる。
  // 「同じ音の短いブツ切り打点」(次の打点で切られたハイハット等)は長い方の定義を共有し、
  // 打点の長さは音符長側で表現する(実機DMCの「途中で切る=次のトリガー/停止」と同じ意味論。
  // EnvelopeRegistryの前方一致共有と同じ発想)。逆に既存より長い打点が来たら定義を延長する。
  class ClipRegistry {
    constructor() {
      this.clips = [];
      this.byAddr = new Map();  // ROM開始オフセット -> clipIndex(アドレス同定モード)
      this.exact = new Map();   // samples.join(',') -> clipIndex(バイト列一致の高速パス)
    }

    _register(samples, rateHz) {
      const index = this.clips.length;
      this.clips.push({ samples, rateHz });
      this.exact.set(samples.join(','), index);
      return index;
    }

    // 既存clipのsamplesを長い版へ差し替える(前方一致で内容は同じ、末尾が伸びるだけ)
    _extend(index, samples, rateHz) {
      const clip = this.clips[index];
      this.exact.delete(clip.samples.join(','));
      clip.samples = samples;
      clip.rateHz = rateHz;
      this.exact.set(samples.join(','), index);
    }

    // アドレス同定モード: ROM開始オフセットがIDそのもの
    addByAddr(startAddr, samples, rateHz) {
      const hit = this.byAddr.get(startAddr);
      if (hit !== undefined) {
        if (samples.length > this.clips[hit].samples.length) this._extend(hit, samples, rateHz);
        return hit;
      }
      const index = this._register(samples, rateHz);
      this.clips[index].addr = startAddr; // ドラムのID(パッド/打点のキーに使う)
      this.byAddr.set(startAddr, index);
      return index;
    }

    // バイト列一致モード: 完全一致 → 前方一致 → 緩和あいまい判定の順で既存を探す。
    // seq精密区切り後はバイト列がほぼ完全一致になるため大半は最初の2つで決まる。
    // あいまい判定は保険: 長さ許容は相対(2%+2サンプル)、±4サンプルのオフセット探索付きで
    // 平均絶対誤差≤1.0(0-31スケール)・重なり90%以上を要求する(旧固定閾値は
    // 「長さ差≤2・先頭固定アライン」で実データの揺れに対して厳しすぎた)。
    addBySamples(samples, rateHz) {
      const exact = this.exact.get(samples.join(','));
      if (exact !== undefined) return exact;
      for (let i = 0; i < this.clips.length; i++) {
        const u = this.clips[i].samples;
        // 前方一致(短い方が長い方の先頭と完全一致)
        const common = Math.min(u.length, samples.length);
        if (common >= MIN_CLIP_SAMPLES) {
          let prefix = true;
          for (let k = 0; k < common; k++) if (u[k] !== samples[k]) { prefix = false; break; }
          if (prefix) {
            if (samples.length > u.length) this._extend(i, samples, rateHz);
            return i;
          }
        }
        // あいまい判定(長さが近いものだけ)
        if (Math.abs(u.length - samples.length) > Math.max(u.length, samples.length) * 0.02 + 2) continue;
        for (let off = -4; off <= 4; off++) {
          let sum = 0, n = 0;
          for (let k = 0; k < samples.length; k++) {
            const j = k + off;
            if (j < 0 || j >= u.length) continue;
            sum += Math.abs(samples[k] - u[j]); n++;
          }
          if (n >= samples.length * 0.9 && sum / n <= 1.0) return i;
        }
      }
      return this._register(samples, rateHz);
    }
  }

  // フォーマット非依存の共通抽出処理。「同じドラム/ボイス音の別打点」を重複排除した
  // 生クリップ(5bit、0-31の生サンプル値。DMCエンコード等の変換は一切していない)と、
  // どのクリップがいつ(何フレーム目〜何フレーム目に)トリガーされたかを返す。
  // MML.Hes2MmlExpansion.dpcm()(hes2mml変換、@DPCM<n>としてDMCエンコードする)と
  // src/audio/hes-stream-player.js HesReplayStreamPlayer(ネイティブ再生、生サンプルを
  // そのままAudioBufferとして再生する)の両方がこの1箇所を共有する(2026-08、
  // ユーザー提案: 「PCMは種類が少ないので最初に軽くバッファして呼び出すだけにすればいい」
  // という方針をネイティブ再生側にも展開)。
  // 戻り値: { channel, clips: [{samples:number[](0-31), rateHz}], events: [{start,end,clipIndex}] }
  MML.Hes2MmlExpansion.extractDdaClips = function (snapshots, dpcmTrace, controlTrace, frameRate) {
    const totalFrames = snapshots.length;

    // @DPCM<n>チャンネルは1つしか無いため(hes2mml側の制約。ネイティブ再生では制約は
    // 無いが、実測上ほぼ常に特定の1chへ集約されるため同じ選び方を踏襲する)、6ch中
    // もっとも実際にDDA区間の合計が長いchを1つだけ選ぶ。
    let bestCh = -1, bestTotal = 0, bestRuns = null;
    for (let ch = 0; ch < 6; ch++) {
      const runs = buildChannelRuns(controlTrace[ch] || [], totalFrames);
      const total = runs.reduce((a, r) => a + (r.end - r.start), 0);
      if (total > bestTotal) { bestTotal = total; bestCh = ch; bestRuns = runs; }
    }
    if (bestCh < 0) return { channel: -1, clips: [], events: [] };

    const trace = dpcmTrace[bestCh] || [];
    const hasSeq = trHasSeq(trace) && bestRuns.length > 0 && bestRuns[0].startSeq !== undefined;
    return hasSeq
      ? extractBySeq(bestCh, trace, bestRuns, frameRate)
      : extractByFrames(bestCh, trace, bestRuns, frameRate);
  };

  // ── dpcmTraceの読み出しアダプタ(2026-09-04) ──────────────────────────────
  // dpcmTraceは列ごとの型付き配列(Emu.HesTraceBuf)になった。1件=JSオブジェクトだと
  // 実測181B/件で、DDAは1PCMサンプルごとに1件積むため60秒で116MBを占めていたため。
  // ★ここから下の抽出ロジックは1件を {frame,t,seq,value,src} のオブジェクトとして
  //   読む前提で書かれているので、必要になった時だけ組み立てて渡す(一時オブジェクトなので
  //   run単位で捨てられ、曲全体を抱え込まない)。古い形(オブジェクト配列)もそのまま読める。
  const trIsArr = (tr) => Array.isArray(tr);
  const trLen = (tr) => (tr ? tr.length : 0);
  const trSeqAt = (tr, i) => (trIsArr(tr) ? tr[i].seq : tr.seq[i]);
  const trFrameAt = (tr, i) => (trIsArr(tr) ? tr[i].frame : tr.frame[i]);
  const trValueAt = (tr, i) => (trIsArr(tr) ? tr[i].value : tr.value[i]);
  const trAt = (tr, i) => (trIsArr(tr) ? tr[i]
    : { frame: tr.frame[i], t: tr.t[i], seq: tr.seq[i], value: tr.value[i], src: tr.src[i] });
  const trHasSeq = (tr) => (trLen(tr) > 0 && (trIsArr(tr) ? tr[0].seq !== undefined : true));

  // クリップのレート推定: 書込みの分数フレーム時刻tが使えるなら
  // 「サンプル間隔の実測平均」= (件数-1) ÷ (最後と最初のtの差の秒数)。
  // t無し(旧トレース)はrun全長ベース(境界がフレーム量子化されるため誤差±10%程度)。
  function estimateRate(writes, from, to, fallbackFrames, frameRate) {
    const n = to - from;
    const first = writes[from], last = writes[to - 1];
    if (n >= 2 && first.t !== undefined && last.t > first.t) {
      return (n - 1) / ((last.t - first.t) / frameRate);
    }
    const seconds = fallbackFrames / frameRate;
    return seconds > 0 ? n / seconds : MML.Dpcm.DMC_RATE_TABLE_NTSC[7];
  }

  // ---- seq/t/src有りトレースの精密抽出(2026-08-26、冒頭コメント参照) ----------------
  // regOpt: 複数chで1つの登録簿を共有するとき(extractDdaClipsAll)に渡す。同じドラムが別chで
  // 鳴っても1定義にまとまる
  function extractBySeq(channel, trace, runs, frameRate, regOpt) {
    const reg = regOpt || new ClipRegistry();
    const events = [];
    let pos = 0;

    for (const run of runs) {
      while (pos < trLen(trace) && trSeqAt(trace, pos) < run.startSeq) pos++;
      const ws = [];
      while (pos < trLen(trace) && trSeqAt(trace, pos) < run.endSeq) { ws.push(trAt(trace, pos)); pos++; }
      if (ws.length < MIN_CLIP_SAMPLES) continue;

      // run内の書込みを3種に分類しつつ、ROM読出しアドレスの連続セグメントに分ける:
      //   ROM内容   … src>=0。サンプル本体。前のROM書込みのsrc+1なら同一セグメント継続。
      //   ホールド  … src<0 かつ 直前の書込みと同じ値。DACの値を保持し直しているだけで
      //               波形情報を持たない(実測: NX91002.hesは書込みの29%がZP保持値の
      //               ホールド書きで、ROMストリームの合間に挟まる。これをセグメントの
      //               切れ目とみなすと1つのドラムが数十セグメントに細切れになる)。
      //               セグメントを切らず、サンプルにも入れない(透過)。
      //   異物内容  … src<0 かつ 値が変化している。出所不明の波形情報(音量加工や
      //               RAMバッファ経由)。これが多いrunはアドレス同定を信用しない。
      const segs = []; // {items:[wsインデックス...](ROM内容のみ)}
      let cur = null, lastSrc = -1;
      let romCount = 0, foreignCount = 0;
      for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        if (w.src >= 0) {
          romCount++;
          if (!cur || w.src !== lastSrc + 1) { cur = { items: [] }; segs.push(cur); }
          cur.items.push(i);
          lastSrc = w.src;
        } else if (i > 0 && w.value === ws[i - 1].value) {
          // ホールド: 透過(セグメント継続)
        } else {
          foreignCount++;
          cur = null; lastSrc = -1;
        }
      }
      // ★アドレス同定を採用する条件(2026-08-26追加のガード): 「十分に長いROM連続
      // セグメントが支配的」であること。アドレスが数サンプルおきに跳ぶ曲
      // (連続ストリーミングPCMや複数サンプルのソフトミキシング)では、セグメントが
      // MIN_ADDR_SEG_SAMPLES未満に砕けて「1打点=4サンプル」の微細イベントが数千個でき、
      // @DPCM定義も打点も爆発する(実測: SS90002.hesで86定義2902打点、MML 8倍に肥大)。
      // 実際のドラム/ボイスは数十ms=数百サンプルあるので、この閾値を下回るセグメントは
      // 「サンプルの切れ目」ではないと判断し、run全体を1クリップとして扱うストリーム
      // モードへ落とす(音の始まりは$0804のon/offが与えるので情報は失われない)。
      const bigSegs = segs.filter((sg) => sg.items.length >= MIN_ADDR_SEG_SAMPLES);
      const addrCoverage = bigSegs.reduce((a, sg) => a + sg.items.length, 0);

      if (romCount >= MIN_CLIP_SAMPLES && romCount >= (romCount + foreignCount) * ADDR_COVERAGE_RATIO &&
          addrCoverage >= ws.length * ADDR_COVERAGE_RATIO) {
        // アドレス同定モード: セグメントごとに1打点(runの途中でアドレスが跳んだら
        // 別サンプルの連続再生とみなして分割する=$0804トグル無しの垂れ流しにも耐える)。
        for (const sg of bigSegs) {
          const items = sg.items;
          const samples = items.map((i) => ws[i].value);
          const first = ws[items[0]], last = ws[items[items.length - 1]];
          const rateHz = (samples.length >= 2 && first.t !== undefined && last.t > first.t)
            ? (samples.length - 1) / ((last.t - first.t) / frameRate)
            : estimateRate(ws, 0, ws.length, run.endFrame - run.startFrame, frameRate);
          const clipIndex = reg.addByAddr(first.src, samples, rateHz);
          events.push({ start: first.frame, end: last.frame + 1, clipIndex, vol: run.vol });
        }
      } else {
        // バイト列一致モード: run全体を1クリップとして扱う(seq精密区切りにより
        // 同じ音はバイト列がほぼ完全一致する)
        const samples = ws.map((w) => w.value);
        const rateHz = estimateRate(ws, 0, ws.length, run.endFrame - run.startFrame, frameRate);
        const clipIndex = reg.addBySamples(samples, rateHz);
        events.push({ start: ws[0].frame, end: ws[ws.length - 1].frame + 1, clipIndex, vol: run.vol });
      }
    }

    // ★イベントendのクランプ(2026-08-26): endは「最終書込みフレーム+1」だが、次の打点が
    // 同一フレーム内で始まる(off→on同一フレームがこの種の曲では常態)と ev[i].end が
    // ev[i+1].start を1フレーム追い越して重複する。MML出力(mmlEmit)は各イベントの
    // dur=end-start を直列に並べるため、重複分がそのままDPCMチャンネルの尺に上乗せされ、
    // 曲が進むほど累積遅延になっていた(実測: NX91002 idx33/60秒で重複103件=+103フレーム
    // =終盤+1.7秒遅れ。PSG各chは3607フレームなのにEだけ3710フレーム)。
    // 発音タイミング(start)は変えず、endだけ次イベントのstartへ切り詰める。
    for (let i = 0; i + 1 < events.length; i++) {
      if (events[i].end > events[i + 1].start) {
        events[i].end = Math.max(events[i].start + 1, events[i + 1].start);
      }
    }

    return { channel, clips: reg.clips, events };
  }

  // ---- 旧トレース(seq無し)のフォールバック抽出(従来ロジック) ------------------------
  // 境界フレームの混入(冒頭コメントの真因1)は原理的に避けられないが、緩和済みの
  // ClipRegistry.addBySamples(前方一致+相対長さ許容+オフセット探索)で旧実装よりは潰せる。
  function extractByFrames(channel, trace, runs, frameRate, regOpt) {
    const reg = regOpt || new ClipRegistry();
    const events = [];
    let tracePos = 0;

    for (const run of runs) {
      const samples = [];
      while (tracePos < trLen(trace) && trFrameAt(trace, tracePos) < run.end) {
        if (trFrameAt(trace, tracePos) >= run.start) samples.push(trValueAt(trace, tracePos));
        tracePos++;
      }
      if (samples.length < MIN_CLIP_SAMPLES) continue;

      const seconds = (run.end - run.start) / frameRate;
      const rateHz = seconds > 0 ? samples.length / seconds : MML.Dpcm.DMC_RATE_TABLE_NTSC[7];
      const clipIndex = reg.addBySamples(samples, rateHz);
      events.push({ start: run.start, end: run.end, clipIndex, vol: run.vol });
    }

    return { channel, clips: reg.clips, events };
  }

  // channel/defs/files/eventsを返す。defsの各要素にsampleCount(実際のPCMサンプル数。
  // sizeはNSF側配置用のバイト数で16byte境界に切り上げ済みのため別物)も含める。
  // ネイティブ再生(src/audio/hes-stream-player.js HesReplayStreamPlayer)がMML.Dpcm.decode()で
  // 復号する際、この正確なサンプル数が必要(2026-08、ユーザー指摘: ネイティブ再生も
  // 自作の簡略再生ではなく、MML変換と同じencode→decode往復を必ず経由させる)。
  // ---- 全6ch版(2026-09-03) ---------------------------------------------------------
  // extractDdaClips は「最長の1ch」だけを返す(ネイティブ再生 hes-stream-player.js の
  // ch選定用に残す)。MML変換とロール/パッドは、DDAを使う全chの打点を1つの登録簿で
  // 集めたこちらを使う。同時に鳴った打点は src/convert/drumHits.js が1クリップへミックス
  // するので、DPCM 1本の制約は変換側で吸収される(実測: NCS91002 は3chでDDAを使い、
  // 旧方式は書込みの51%を捨てていた)。
  // 戻り値: { channels:[DDAを使うch...], clips:[{samples, rateHz, addr?}], events:[{ch, start, end, clipIndex, vol}] }
  MML.Hes2MmlExpansion.extractDdaClipsAll = function (snapshots, dpcmTrace, controlTrace, frameRate) {
    const totalFrames = snapshots.length;
    const reg = new ClipRegistry();
    const events = [];
    const channels = [];
    for (let ch = 0; ch < 6; ch++) {
      const runs = buildChannelRuns(controlTrace[ch] || [], totalFrames);
      if (!runs.length) continue;
      const trace = dpcmTrace[ch] || [];
      const hasSeq = trHasSeq(trace) && runs[0].startSeq !== undefined;
      const r = hasSeq ? extractBySeq(ch, trace, runs, frameRate, reg) : extractByFrames(ch, trace, runs, frameRate, reg);
      if (!r.events.length) continue;
      channels.push(ch);
      for (const ev of r.events) events.push(Object.assign({ ch }, ev));
    }
    events.sort((a, b) => a.start - b.start || a.ch - b.ch);
    return { channels, clips: reg.clips, events };
  };

  // クリップ → パッド/打点のキー。アドレス同定できたクリップはROMオフセット(=ドラムのID)、
  // バイト列同定はクリップ番号(接頭辞を変えて衝突を避ける。DrumMap.labels は ':' の後ろの
  // 10進を16進表示にするので、どちらも短いラベルになる)
  function clipKey(clip, index) {
    return clip.addr != null ? ('dda:' + clip.addr) : ('ddab:' + index);
  }

  /**
   * DDAの打点リスト(src/convert/drumHits.js の hit 形)+サンプル表。
   * ロール/パッド/変換の3者がこれを共有する。
   *   hits:    [{ key, sampleKey, hash, pcm, rate, vol, startFrame, endFrame, ch }]
   *   samples: { key → { pcm, rate, hash } }  パッド台帳(main.js drumSampleStore)用
   *   channels: DDAを使ったch
   * vol は「そのrunの$0804音量 ÷ 曲中のDDA最大音量」。単chで音量一定の曲は常に1.0
   * (=旧実装と同じ振幅で焼く)。複数chの相対音量はミックス時に効く。
   */
  MML.Hes2MmlExpansion.ddaHits = function (snapshots, dpcmTrace, controlTrace, frameRate) {
    const all = MML.Hes2MmlExpansion.extractDdaClipsAll(snapshots, dpcmTrace, controlTrace, frameRate);
    const U = (global.Emu && global.Emu.SamplePitchUtil) || (MML.Emu && MML.Emu.SamplePitchUtil) || null;
    const samples = {};
    const byIndex = all.clips.map((clip, i) => {
      const pcm = new Float32Array(clip.samples.length);
      for (let k = 0; k < clip.samples.length; k++) pcm[k] = (clip.samples[k] / 31) * 2 - 1;
      let hash = null;
      if (U && U.sampleHash) {
        const u8 = Uint8Array.from(clip.samples, (v) => v & 0x1F);
        hash = 'dda-' + U.sampleHash(u8, 0, u8.length);
      }
      const key = clipKey(clip, i);
      // .dmc/パッドの既定ラベル: ROMオフセットの16進、バイト列同定は clip<n>
      const label = clip.addr != null ? clip.addr.toString(16).toUpperCase() : ('clip' + i);
      const s = { key, pcm, rate: clip.rateHz, hash, label };
      samples[key] = s;
      return s;
    });
    let maxVol = 0;
    for (const ev of all.events) if (ev.vol > maxVol) maxVol = ev.vol;
    if (!(maxVol > 0)) maxVol = 31;
    const hits = all.events.map((ev) => {
      const s = byIndex[ev.clipIndex];
      return { key: s.key, sampleKey: s.key, hash: s.hash, pcm: s.pcm, rate: s.rate, label: s.label,
               vol: (ev.vol != null ? ev.vol : maxVol) / maxVol,
               startFrame: ev.start, endFrame: ev.end, ch: ev.ch,
               // 鳴り止みはCPUの書込み範囲(end)そのもの。サンプル長÷推定レートで切らない
               exactEnd: true };
    });
    return { hits, samples, channels: all.channels };
  };

  // channel/defs/files/eventsを返す。defsの各要素にsampleCount(実際のPCMサンプル数。
  // sizeはNSF側配置用のバイト数で16byte境界に切り上げ済みのため別物)も含める。
  // 2026-09-03: DMC化は src/convert/drumHits.js(全形式共通)へ。ここは打点リストを渡すだけ。
  //   ・全DDAchを対象にし、同時発音はミックスした1クリップになる
  //   ・サンプル単位の設定(パッド: 変換しない/レート/音量/名前/差し替え)が効く
  //   ・.dmc の名前はパッド名、無ければROMオフセットの16進
  // 旧実装との差(単chの曲): 定義内容は同じ(dac=先頭値、レート選択も同じ関数)で、
  // ファイル名だけ hes_dpcm_<n>.dmc → <ROMオフセット16進>.dmc に変わる。
  // extraHits(省略可): 合成音ch(PSGの波形ch)を打楽器化した打点(main.js synthDrum、
  // options.drumHits)。DDAの打点と一緒にE(DPCM)へ焼く
  MML.Hes2MmlExpansion.dpcm = function (snapshots, dpcmTrace, controlTrace, frameRate, cmd, extraHits) {
    const dda = MML.Hes2MmlExpansion.ddaHits(snapshots, dpcmTrace, controlTrace, frameRate);
    const channels = dda.channels;
    const hits = dda.hits.concat(extraHits || []);
    const empty = { channel: -1, channels: [], defs: [], files: [], events: [], stats: null };
    if (!hits.length || !MML.Convert.DrumHits) return empty;
    const r = MML.Convert.DrumHits.dpcm(hits, frameRate, {
      totalFrames: snapshots.length,
      pcmRate: cmd && cmd.PCM_RATE != null ? cmd.PCM_RATE : 'max',
      rateMix: cmd && cmd.RATE_MIX,
      poly: cmd && cmd.DRUM_POLY,
      prefix: 'hes_dpcm',
      maxClipSec: 10, // DDAはCPUが書いた分しか無い(=有限)ので、VGMのROM歯止め1.5秒は外す
      volQuant: 2,    // $0804音量の微差(1dB未満)で定義を増やさない(実測: HC92056で5→6定義)
    });
    return { channel: channels.length ? channels[0] : -1, channels, defs: r.defs, files: r.files, events: r.events, stats: r.stats };
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
      for (const w of writeLog[f]) {
        if (w.io) continue;
        const off = (w.addr >= 0x9800 && w.addr <= 0x98FF) ? w.addr - 0x9800
          : (w.addr >= 0xB800 && w.addr <= 0xB8FF) ? w.addr - 0xB800 : -1;
        if (off < 0 || w.value === 0) continue;
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