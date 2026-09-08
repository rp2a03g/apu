/*
 * NSF実行用メモリバス
 * MML.Emu.NsfBus
 *
 * 64KBのフラットメモリ空間を提供し、$4000-$4017 へのアクセスをAPUにルーティングする。
 * $5FF8-$5FFF へのバンクスイッチ書き込みにも対応（NSFバンクスイッチング方式）。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const BANK_SIZE = 0x1000; // 4KB

  class NsfBus {
    /**
     * @param {object} opt
     * @param {Uint8Array} opt.program - ロードするプログラムイメージ（ヘッダを除いたバイナリ）
     * @param {number} opt.loadAddr - プログラムのロード先アドレス
     * @param {Uint8Array} [opt.bankswitch] - ヘッダのバンクスイッチ初期値8バイト（全て0ならバンクスイッチ無効）
     */
    constructor(opt) {
      this.mem = new Uint8Array(0x10000);
      this.apu = null; // setApu() で後から設定
      this.onWrite = null; // (addr, value) => void のフック（レジスタ書き込みログ用）

      // 拡張音源 (NSF.CHIP_FLAGS の組み合わせ)
      this.expansion = {};
      const extraChips = opt.extraChips || 0;
      const FLAGS = MML.NSF.CHIP_FLAGS;
      if (extraChips & FLAGS.VRC6) this.expansion.vrc6 = new Emu.VRC6Audio();
      if (extraChips & FLAGS.VRC7) this.expansion.vrc7 = new Emu.VRC7Audio();
      if (extraChips & FLAGS.FDS) this.expansion.fds = new Emu.FDSAudio();
      if (extraChips & FLAGS.MMC5) this.expansion.mmc5 = new Emu.MMC5Audio();
      if (extraChips & FLAGS.N163) this.expansion.n163 = new Emu.N163Audio();
      if (extraChips & FLAGS.FME7) this.expansion.fme7 = new Emu.FME7Audio();
      // 旧ppmckドライバ(Famicompo mini 時代、N106波形長を32サンプル形式で書く)の判定。
      // opt.n163Legacy で明示指定がなければプログラム本体の機械語列から自動判定する
      // (NsfPlayer/NsfReplayStreamPlayer/キャプチャWorker/ヘッドレスの全経路がここを通る)。
      // 詳細は nsfHeader.js detectLegacyN163Driver と n163.js 冒頭コメント 注2。
      if (this.expansion.n163) {
        this.n163Legacy = opt.n163Legacy !== undefined
          ? !!opt.n163Legacy
          : !!(MML.NSF.detectLegacyN163Driver && MML.NSF.detectLegacyN163Driver(opt.program));
        this.expansion.n163.legacyWaveLen = this.n163Legacy;
      }

      this.loadAddr = opt.loadAddr;
      this.useBankswitch = (opt.bankswitch || []).some(b => b !== 0);

      if (this.useBankswitch) {
        // バンクスイッチ時: ロードアドレス下位12bit分だけ先頭をゼロパディングした
        // ROMイメージを作り、4KBバンク単位で $8000-$FFFF にマッピングする。
        // (NSF仕様: padding = loadAddr & 0x0FFF。これが無いとINIT/PLAYが別バイトを指す)
        const pad = this.loadAddr & 0x0FFF;
        this.romImage = new Uint8Array(pad + opt.program.length);
        this.romImage.set(opt.program, pad);
        this.bankCount = Math.max(1, Math.ceil(this.romImage.length / BANK_SIZE));
        this.banks = new Array(8).fill(0).map((_, i) => (opt.bankswitch[i] || 0) % this.bankCount);
        for (let slot = 0; slot < 8; slot++) this.mapBank(0x8000 + slot * BANK_SIZE, this.banks[slot]);
        // FDS NSF: バイト0x76/0x77 は $E000/$F000 に加え $6000/$7000 も初期化する
        if (this.expansion.fds) {
          this.mapBank(0x6000, this.banks[6]);
          this.mapBank(0x7000, this.banks[7]);
        }
      } else {
        // 通常: loadAddr から program をそのまま配置
        for (let i = 0; i < opt.program.length; i++) {
          const addr = (this.loadAddr + i) & 0xFFFF;
          this.mem[addr] = opt.program[i];
        }
      }

      // MMC5実機のPRGバンクレジスタ($5100=モード, $5113-$5117=8KBウィンドウ選択)。
      // NSF仕様の$5FF8-$5FFFバンクスイッチとは別に、実機ROMからそのまま抜き出した
      // ドライバはこちらの本物のMMC5レジスタで$8000-$FFFFを切り替えることがある
      // (Just Breed等)。これを無視すると初期バンクのまま固定され、曲の途中で
      // ドライバが本来別バンクにあるはずのデータ(0埋め)を読んで無限ループに陥る。
      if (this.expansion.mmc5) {
        if (!this.romImage) {
          const pad = this.loadAddr & 0x0FFF;
          this.romImage = new Uint8Array(pad + opt.program.length);
          this.romImage.set(opt.program, pad);
        }
        this.mmc5PrgMode = 3; // 実機の電源投入直後の挙動に合わせた既定値(最も細かい8KB×4分割)
        this.mmc5PrgReg = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; // $5113,5114,5115,5116,5117の生値
        // $5205/$5206: 実機の8bit×8bit=16bit符号なし乗算器。書き込みは被乗数/乗数だが
        // 読み出しは積の下位/上位バイトを返す(実機の二重機能レジスタ)。これが無いと
        // 読み出し側は直前に書き込んだ生値をそのまま読み返してしまい、乗算結果を使う
        // ポインタ計算(音楽データテーブルの索引など)が壊れる(Just Breed等)。
        this.mmc5MultOperand = [0, 0];
        this.mmc5MultProduct = 0;
      }
    }

    setApu(apu) { this.apu = apu; }

    // MMC5実機のPRGバンクレジスタ書き込みを $8000-$FFFF に反映する。
    // regIndex: 1=$5114 2=$5115 3=$5116 4=$5117 (書き込まれたレジスタのみ)、
    // regIndex省略時は$5100(モード)変更に伴う全ウィンドウ再計算。
    // NSFはドライバ本体の起動処理を経ずINIT/PLAYだけを叩くため、触れられていない
    // レジスタは実機のリセット直後値ではなくヘッダのバンクスイッチで既に正しく
    // 割り当て済みの内容を持っている。よって「書き込まれたレジスタが担当する
    // ウィンドウだけ」を差し替え、他のウィンドウは既存の内容(ヘッダ由来 or
    // 以前のMMC5書き込みの結果)をそのまま保持する。
    mmc5RemapPrg(regIndex) {
      const rom = this.romImage;
      const bankCount8k = Math.max(1, Math.floor(rom.length / 0x2000));
      const romBankNum = (regVal) => (regVal & 0x7F) % bankCount8k;
      const copyWindow = (dst, bank8k) => {
        const src = (((bank8k % bankCount8k) + bankCount8k) % bankCount8k) * 0x2000;
        for (let i = 0; i < 0x2000; i++) {
          this.mem[dst + i] = rom[src + i] !== undefined ? rom[src + i] : 0;
        }
      };
      const r = this.mmc5PrgReg; // [5113, 5114, 5115, 5116, 5117]
      const mode = this.mmc5PrgMode;

      const remap5114 = () => { if (mode === 3) copyWindow(0x8000, romBankNum(r[1])); };
      const remap5115 = () => {
        if (mode === 3) copyWindow(0xA000, romBankNum(r[2]));
        else if (mode === 1 || mode === 2) {
          const lo16 = ((r[2] & 0x7F) >> 1) * 2;
          copyWindow(0x8000, lo16);
          copyWindow(0xA000, lo16 + 1);
        }
      };
      const remap5116 = () => { if (mode === 2 || mode === 3) copyWindow(0xC000, romBankNum(r[3])); };
      const remap5117 = () => {
        if (mode === 0) {
          const base8k = ((r[4] & 0x7F) >> 2) * 4;
          for (let w = 0; w < 4; w++) copyWindow(0x8000 + w * 0x2000, base8k + w);
        } else if (mode === 1) {
          const hi16 = ((r[4] & 0x7F) >> 1) * 2;
          copyWindow(0xC000, hi16);
          copyWindow(0xE000, hi16 + 1);
        } else {
          copyWindow(0xE000, romBankNum(r[4]));
        }
      };

      if (regIndex === 1) remap5114();
      else if (regIndex === 2) remap5115();
      else if (regIndex === 3) remap5116();
      else if (regIndex === 4) remap5117();
      else { remap5114(); remap5115(); remap5116(); remap5117(); } // $5100モード変更時: 全ウィンドウ再計算
    }

    // ROMイメージの bankIndex 番目の4KBバンクを dstBase に配置する
    mapBank(dstBase, bankIndex) {
      const src = (bankIndex % this.bankCount) * BANK_SIZE;
      for (let i = 0; i < BANK_SIZE; i++) {
        this.mem[dstBase + i] = this.romImage[src + i] !== undefined ? this.romImage[src + i] : 0;
      }
    }

    read(addr) {
      addr &= 0xFFFF;
      if (addr === 0x4015 && this.apu) return this.apu.readStatus();
      // FDS レジスタ読み出し ($4090=ボリューム出力, $4092=モジュレータ出力)
      if (this.expansion.fds && (addr === 0x4090 || addr === 0x4092)) {
        return this.expansion.fds.readRegister(addr);
      }
      // N163 内部RAM読み出し ($4800)。ドライバが register の read-modify-write に使う。
      if (this.expansion.n163 && addr === 0x4800) {
        return this.expansion.n163.readData();
      }
      // MMC5乗算器: $5205=積の下位バイト, $5206=積の上位バイト
      if (this.expansion.mmc5 && addr === 0x5205) return this.mmc5MultProduct & 0xFF;
      if (this.expansion.mmc5 && addr === 0x5206) return (this.mmc5MultProduct >> 8) & 0xFF;
      return this.mem[addr];
    }

    write(addr, value) {
      addr &= 0xFFFF;
      value &= 0xFF;

      if (addr >= 0x4000 && addr <= 0x4017) {
        if (this.apu) this.apu.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      const exp = this.expansion;
      if (exp.vrc6 && ((addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002))) {
        exp.vrc6.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.vrc7 && (addr === 0x9010 || addr === 0x9030)) {
        exp.vrc7.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.fds && (addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A))) {
        exp.fds.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr >= 0x5000 && addr <= 0x5015) {
        exp.mmc5.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr === 0x5100) {
        this.mmc5PrgMode = value & 0x03;
        this.mmc5RemapPrg();
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr >= 0x5113 && addr <= 0x5117) {
        const regIndex = addr - 0x5113;
        this.mmc5PrgReg[regIndex] = value;
        if (regIndex > 0) this.mmc5RemapPrg(regIndex); // $5113($6000-7FFF RAM)は非対応・素通し
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && (addr === 0x5205 || addr === 0x5206)) {
        this.mmc5MultOperand[addr - 0x5205] = value;
        this.mmc5MultProduct = this.mmc5MultOperand[0] * this.mmc5MultOperand[1];
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.n163 && (addr === 0xF800 || addr === 0x4800)) {
        exp.n163.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.fme7 && (addr === 0xC000 || addr === 0xE000)) {
        exp.fme7.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      if (this.useBankswitch && addr >= 0x5FF8 && addr <= 0x5FFF) {
        const slot = addr - 0x5FF8;
        this.banks[slot] = value % this.bankCount;
        this.mapBank(0x8000 + slot * BANK_SIZE, this.banks[slot]);
        // バンクスイッチ書き込みもwriteLogに記録する。$4000-$4017の音源レジスタと
        // 違い元々onWriteを呼んでいなかったため、nsf2mml側でDPCMサンプルの実バイト列を
        // 再現する際に「その時点でどのバンクが$C000-$FFFF等にマップされていたか」を
        // 再現できなかった(常に初期状態のまま=最初のバンク切替以降がズレる)
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      // FDS NSF 専用: $5FF6/$5FF7 は $6000/$7000 へのバンクスイッチ
      if (this.useBankswitch && this.expansion.fds && (addr === 0x5FF6 || addr === 0x5FF7)) {
        this.mapBank(0x6000 + (addr - 0x5FF6) * BANK_SIZE, value % this.bankCount);
        return;
      }

      this.mem[addr] = value;
    }
  }

  Emu.NsfBus = NsfBus;
})(window);
