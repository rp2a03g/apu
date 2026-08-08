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
})(window);
