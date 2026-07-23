/*
 * KSS(MSX)実行用メモリ/IOバス
 * MML.Emu.KssBus
 *
 * 64KBフラットメモリ + Z80 IN/OUTポート空間を提供する。
 * ロード直後のプログラムイメージをそのまま配置し、Konami SCCマッパー(16Kモード)
 * または簡易8Kマッパーによるバンク切替、SCC/SCC+のメモリマップオーバーレイに対応する。
 * PSG(AY-3-8910)・SCC・FMPAC(OPLL)を this.chips にキー名で保持し、
 * IN/OUTポートディスパッチする。将来のOPL(Y8950)追加は this.chips.opl の
 * 分岐を1つ足すだけで済むように設計している。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const BANK16_SIZE = 0x2000; // 16Kマッパー(Konami SCC)の各ウィンドウは8KB単位
  const BANK8_SIZE = 0x2000;  // 8Kマッパーも同じく8KB単位

  class KssBus {
    /**
     * @param {object} header - KSS.parseHeader() の結果
     * @param {Uint8Array} songData - ヘッダを除いた曲データ(header.dataOffset以降)
     */
    constructor(header, songData) {
      this.header = header;
      this.mem = new Uint8Array(0x10000);
      this.chips = {}; // 'psg' | 'scc' | 'opll' | (将来)'opl'
      this.onWrite = null; // (addr, value) => void
      this.onIoWrite = null; // (port, value) => void

      this.bankMode = header.bankMode; // '8K' | '16K'
      this.bankNum = header.bankNum;
      this.hasBanking = this.bankNum > 0;

      // 初期データをそのままロードアドレスへ配置
      const loadAddr = header.loadAddr;
      const len = Math.min(header.dataLength, songData.length);
      for (let i = 0; i < len; i++) {
        this.mem[(loadAddr + i) & 0xFFFF] = songData[i];
      }

      // バンク切替用の追加データ(初期データの直後に連結されている)
      if (this.hasBanking) {
        const extra = songData.subarray(Math.min(header.dataLength, songData.length));
        this.extraBanks = extra;
        const bankSize = this.bankMode === '8K' ? BANK8_SIZE : BANK16_SIZE;
        this.bankSize = bankSize;
        this.bankCount = Math.max(1, Math.ceil(extra.length / bankSize));
      }

      // Konami SCCマッパー(16K)の4ウィンドウ、または8Kマッパーの2ウィンドウの現在バンク番号
      this.bankSelect = [0, 0, 0, 0];
      this.sccEnabled = false;    // 0x9800-0x9FFF に SCC レジスタをオーバーレイ中か
      this.sccPlusEnabled = false; // 0xB800-0xBFFF に SCC+ レジスタをオーバーレイ中か
    }

    registerChip(name, chip) {
      this.chips[name] = chip;
    }

    // extraBanksのbankIndex番目のブロックをdstBase(8KB)へコピーする。
    // Z80プログラムが書き込むバンク番号はROM全体でのグローバル番号であり、
    // ヘッダのbankOffset(先頭バンク番号、実データの先頭バンクが何番かを示す)を
    // 引いてextraBanks配列内の0始まりインデックスへ変換する必要がある
    // (これを忘れるとバンク切替の物理データが全くズレて実行が破綻する)。
    mapBank(dstBase, bankIndex) {
      if (!this.hasBanking) return;
      const physIndex = bankIndex - this.header.bankOffset;
      const src = (((physIndex % this.bankCount) + this.bankCount) % this.bankCount) * this.bankSize;
      for (let i = 0; i < this.bankSize; i++) {
        const v = this.extraBanks[src + i];
        this.mem[(dstBase + i) & 0xFFFF] = v !== undefined ? v : 0;
      }
    }

    // --- CPUバス(メモリ) ---
    read(addr) {
      addr &= 0xFFFF;
      if ((this.sccEnabled || this.hasBanking) && this.chips.scc && addr >= 0x9800 && addr <= 0x9FFF) {
        return this.chips.scc.readClassic(addr - 0x9800);
      }
      if (this.sccPlusEnabled && this.chips.scc && addr >= 0xB800 && addr <= 0xBFFF) {
        return this.chips.scc.readPlus(addr - 0xB800);
      }
      return this.mem[addr];
    }

    write(addr, value) {
      addr &= 0xFFFF;
      value &= 0xFF;

      // SCC/SCC+のイネーブルトリック(0x9000-97FF/0xB000-B7FFへの書込)は
      // 実機のKonami SCCマッパー固有の挙動であり、KSSヘッダのbankMode('8K'/'16K'、
      // ripper側のバンク粒度表現の違いにすぎない)に関わらず同じアドレスで機能する。
      // 0x4000-5FFF/0x6000-7FFF の2ウィンドウは16Kマッパー(Konami標準4ウィンドウ)
      // 表現のときだけ存在する。
      if (this.hasBanking && this.bankMode === '16K') {
        if (addr >= 0x5000 && addr <= 0x57FF) { this.bankSelect[0] = value; this.mapBank(0x4000, value); if (this.onWrite) this.onWrite(addr, value); return; }
        if (addr >= 0x7000 && addr <= 0x77FF) { this.bankSelect[1] = value; this.mapBank(0x6000, value); if (this.onWrite) this.onWrite(addr, value); return; }
      }
      // SCC有効化トリック自体はhasBanking(=追加バンクデータブロックの有無)に関わらず
      // 常時判定する(mapBank側がhasBanking=falseなら自分でno-opするので安全)。
      // bankNum=0のファイル(例:Salamander)でもSCC自体は使われるため、ここを
      // hasBankingで無条件にスキップしていた旧実装は、0x3F書込みを素通りさせてしまい
      // SCCが永久に有効化されないバグの原因だった。
      if (addr >= 0x9000 && addr <= 0x97FF) {
        if ((value & 0x3F) === 0x3F) { this.sccEnabled = true; }
        else { this.sccEnabled = false; this.bankSelect[2] = value; this.mapBank(0x8000, value); }
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (addr >= 0xB000 && addr <= 0xB7FF) {
        if (value & 0x80) { this.sccPlusEnabled = true; }
        else { this.sccPlusEnabled = false; this.bankSelect[3] = value; this.mapBank(0xA000, value); }
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      // 実測(Space Manbow)では0x9000に0x3Fを書かず(=通常のバンク選択のみ)に
      // 0x9800-988Fへ直接SCCレジスタを書き込むタイトルが存在した。0x3Fトリックを
      // 必須とする厳密なゲートだと無音化するため、hasBanking(=Konami系マッパー使用)
      // であれば0x9800-9FFFは常時SCCとしてデコードする(sccEnabledは診断用に維持するのみ)。
      if ((this.sccEnabled || this.hasBanking) && this.chips.scc && addr >= 0x9800 && addr <= 0x9FFF) {
        this.chips.scc.writeClassic(addr - 0x9800, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (this.sccPlusEnabled && this.chips.scc && addr >= 0xB800 && addr <= 0xBFFF) {
        this.chips.scc.writePlus(addr - 0xB800, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      this.mem[addr] = value;
      if (this.onWrite) this.onWrite(addr, value);
    }

    // --- CPUバス(IOポート、下位8bitのみデコード。実MSXハードウェアと同じ簡略化) ---
    ioRead(port) {
      port &= 0xFF;
      if (this.chips.psg && (port === 0xA2)) return this.chips.psg.readData();
      if (this.chips.opl && port === 0xC2) return this.chips.opl.readStatus();
      return 0xFF;
    }

    ioWrite(port, value) {
      port &= 0xFF;
      value &= 0xFF;
      if (this.chips.psg && (port === 0xA0 || port === 0xA1)) {
        this.chips.psg.ioWrite(port, value);
        if (this.onIoWrite) this.onIoWrite(port, value);
        return;
      }
      if (this.chips.opll && (port === 0x7C || port === 0x7D)) {
        this.chips.opll.ioWrite(port, value);
        if (this.onIoWrite) this.onIoWrite(port, value);
        return;
      }
      if (this.chips.opl && (port === 0xC0 || port === 0xC1)) {
        this.chips.opl.ioWrite(port, value);
        if (this.onIoWrite) this.onIoWrite(port, value);
        return;
      }
      if (this.onIoWrite) this.onIoWrite(port, value);
    }
  }

  Emu.KssBus = KssBus;
})(window);
