/*
 * SPC プレイヤー（SPC700 CPU + DSP + バス の統合）
 * MML.Emu.SpcPlayer
 *
 *   constructor(spcBytes)
 *   renderSample()    → { L, R }  — 1 DSP サンプル (32kHz ステレオ) を生成
 *   renderSeconds(sec, outSampleRate) → Float32Array  — 指定秒数分を指定レートで合成
 */
(function (global) {
  'use strict';
  const MML  = global.MML  = global.MML  || {};
  const Emu  = MML.Emu    = MML.Emu    || {};

  // SPC700 クロック (Hz)
  const SPC_CLOCK   = 1024000;
  // DSP サンプルレート (Hz) = SPC_CLOCK / 32
  const DSP_RATE    = 32000;
  // DSP クロックごとのCPUサイクル数
  const CYCLES_PER_DSP = SPC_CLOCK / DSP_RATE; // 32

  // ── バス ─────────────────────────────────────────────────────────
  class SpcBus {
    constructor(ram, dsp) {
      this.ram = ram;
      this.dsp = dsp;
      this.dspAddr = 0;

      // タイマー
      this.timers    = [0, 0, 0];  // ダウンカウンタ
      this.timerDiv  = [0, 0, 0];  // 分周器 ($FA-$FC)
      this.timerCnt  = [0, 0, 0];  // 4bit カウンタ ($FD-$FF, 読み出しでクリア)
      this.timerEn   = [false, false, false];
      this.timerClk  = [0, 0, 0];  // サイクルカウント

      // IPL ROM 制御
      this.romEnable = true;

      // I/O ポート（SNES CPU との通信、SPC 単体再生では外部からは使わない）
      this.ioPorts = new Uint8Array(4);

      // DSP 書き込み追跡コールバック
      this.onWrite = null;
      // バス読み取り追跡コールバック (addr, returnValue) → void
      this.onRead = null;
    }

    /** SPC700 サイクル経過に合わせてタイマーを進める */
    tickTimers(cycles) {
      for (let t = 0; t < 3; t++) {
        if (!this.timerEn[t]) continue;
        // Timer 0,1: 8kHz (128 SPC cycles/tick), Timer 2: 64kHz (16 SPC cycles/tick)
        const period = (t < 2) ? 128 : 16;
        this.timerClk[t] += cycles;
        while (this.timerClk[t] >= period) {
          this.timerClk[t] -= period;
          this.timers[t]++;
          const div = this.timerDiv[t] || 256;
          if (this.timers[t] >= div) {
            this.timers[t] = 0;
            this.timerCnt[t] = (this.timerCnt[t] + 1) & 0x0F;
          }
        }
      }
    }

    read(addr) {
      addr &= 0xFFFF;
      // IPL ROM ($FFC0-$FFFF)
      if (this.romEnable && addr >= 0xFFC0) {
        return Emu.SPC_IPL_ROM[addr - 0xFFC0];
      }
      switch (addr) {
        case 0x00F2: return this.dspAddr;
        case 0x00F3: return this.dsp.readReg(this.dspAddr);
        case 0x00F4: return this.ioPorts[0];
        case 0x00F5: return this.ioPorts[1];
        case 0x00F6: return this.ioPorts[2];
        case 0x00F7: return this.ioPorts[3];
        case 0x00FD: { const c=this.timerCnt[0]; this.timerCnt[0]=0; if(this.onRead) this.onRead(0xFD, c); return c; }
        case 0x00FE: { const c=this.timerCnt[1]; this.timerCnt[1]=0; if(this.onRead) this.onRead(0xFE, c); return c; }
        case 0x00FF: { const c=this.timerCnt[2]; this.timerCnt[2]=0; if(this.onRead) this.onRead(0xFF, c); return c; }
      }
      const v = this.ram[addr];
      if(this.onRead) this.onRead(addr, v);
      return v;
    }

    write(addr, val) {
      addr &= 0xFFFF; val &= 0xFF;
      if (this.onWrite) this.onWrite(addr, val);
      switch (addr) {
        case 0x00F1: // CONTROL
          this.romEnable = (val & 0x80) !== 0;
          for (let t = 0; t < 3; t++) {
            this.timerEn[t] = (val & (1 << t)) !== 0;
            if (!this.timerEn[t]) this.timerCnt[t] = 0;
          }
          // bit 4: ポート $F4/$F5 クリア, bit 5: $F6/$F7 クリア
          if (val & 0x10) { this.ioPorts[0] = 0; this.ioPorts[1] = 0; }
          if (val & 0x20) { this.ioPorts[2] = 0; this.ioPorts[3] = 0; }
          return;
        case 0x00F2: this.dspAddr = val & 0x7F; return;
        case 0x00F3: this.dsp.writeReg(this.dspAddr, val); return;
        case 0x00FA: this.timerDiv[0] = val; return;
        case 0x00FB: this.timerDiv[1] = val; return;
        case 0x00FC: this.timerDiv[2] = val; return;
      }
      // ROM 領域への書き込みは RAM に通す
      this.ram[addr] = val;
    }
  }

  // ── プレイヤー ────────────────────────────────────────────────────
  class SpcPlayer {
    /**
     * @param {Uint8Array} spcBytes - SPC ファイル全体
     */
    constructor(spcBytes) {
      this.spcBytes = spcBytes;
      this.header   = MML.SPC.parseHeader(spcBytes);

      // RAM コピー（DSP がエコー書き込みするので必ずコピーを使う）
      const ramSrc  = MML.SPC.getRam(spcBytes);
      this.ram      = new Uint8Array(65536);
      this.ram.set(ramSrc);

      // （旧「KON 蓄積バグ修正」パッチを削除。$0FDF の "09 48 5C" を書き換えて
      //  ドライバのコードを改変する対症療法だったが、真因は POP A/X/Y のフラグ
      //  誤更新（spc700.js で修正済み）だった。CPU がビット精度になった今、実機と
      //  同じコードをそのまま実行すべきで、ロード時のコード改変は実機と異なる
      //  挙動を生む有害物。現行の全SPCで発火しないことも確認済み。）

      // DSP レジスタ初期化
      this.dsp = new Emu.SpcDsp(this.ram);
      const dspRegs = MML.SPC.getDspRegs(spcBytes);
      for (let i = 0; i < 128; i++) this.dsp.writeReg(i, dspRegs[i]);
      this.dsp.onWrite = null; // ログは後から設定可能

      // BRR サンプル読み取り用の元 RAM コピー（エコーバッファ書き込みによる破壊を防ぐ）
      // エコーバッファと BRR サンプルが重複するゲームでも正しいサンプルデータを読める
      this.dsp.origRam = new Uint8Array(this.ram);

      // BRR ディレクトリをキャッシュしてからエコーバッファを完全クリア
      // エコーバッファと BRR ディレクトリが重複するゲームで FIR フィルターが
      // ディレクトリポインタ値を音声として解釈するアーティファクトを防ぐ。
      {
        const esa      = dspRegs[0x6D];
        const edl      = dspRegs[0x7D] & 0x0F;
        const dir      = dspRegs[0x5D];
        const echoBase = (esa << 8) & 0xFFFF;
        const dirBase  = (dir << 8) & 0xFFFF;
        // エコーバッファのバイトサイズ = EDL × 2KB（EDL=0 は最小 4 バイト）。
        // 以前は (edl+1)*512*4 = (edl+1)*2KB バイトをクリアしており、実サイズより
        // 大きく、かつ ESA が高位のゲーム（例: Unkai ESA=$D8/EDL=5 → 0xD800+）で
        // $FFFF を跨いでゼロページ($0000-)に回り込んでいた。その結果タイマー制御
        // レジスタ($F1/$FA)やドライバのゼロページ変数が 0 で破壊され、ドライバが
        // タイマー同期待ち（$FD ポーリング）で無限ループし「最初の音しか鳴らない/
        // 無音」状態になっていた。
        const echoBytes = edl ? edl * 2048 : 4;

        // ディレクトリ 256 エントリ × 4 バイト = 1024 バイトをキャッシュ
        this.dsp.brrDirCache = new Uint8Array(256 * 4);
        for (let i = 0; i < 256 * 4; i++) {
          this.dsp.brrDirCache[i] = this.ram[(dirBase + i) & 0xFFFF];
        }

        // エコー書き込みが無効（FLG bit5 = ECEN）のときは、その領域はエコー実体
        // ではなくドライバが曲データ等に流用している。実際 Final Fight の一部曲
        // （例 05/06/08、FLG=$20 で echo OFF・ESA=$0D）は $0D00-$14FF に曲データを
        // 置いており、ここをクリアするとトラックデータが 0 で潰れて全曲が同じ
        // 出鱈目（pitch=0→0x1F70…）に化けていた。echo 有効時のみクリアする。
        const echoOff = (dspRegs[0x6C] & 0x20) !== 0;
        if (!echoOff) {
          // エコーバッファをゼロクリア（ディレクトリ含む）。メモリマップド I/O
          // レジスタ領域 $00F0-$00FF は決してエコー実体ではないため保護する。
          for (let i = 0; i < echoBytes; i++) {
            const a = (echoBase + i) & 0xFFFF;
            if (a >= 0x00F0 && a <= 0x00FF) continue;
            this.ram[a] = 0;
          }
        }
      }

      // バス
      this.bus = new SpcBus(this.ram, this.dsp);

      // I/O ポートを RAM ダンプから初期化（ドライバが $F4-$F7 を読む前に正しい値を提供）
      // I/O ポートを RAM ダンプから初期化
      this.bus.ioPorts[0] = this.ram[0x00F4];
      this.bus.ioPorts[1] = this.ram[0x00F5];
      this.bus.ioPorts[2] = this.ram[0x00F6];
      this.bus.ioPorts[3] = this.ram[0x00F7];

      // ── タイマー状態を RAM ダンプから復元 ────────────────────────
      // SPC ダンプは演奏途中の状態なので $F1/$FA/$FB/$FC の値が有効
      const f1Init = this.ram[0x00F1];
      this.bus.romEnable    = (f1Init & 0x80) !== 0;
      this.bus.timerEn[0]   = (f1Init & 0x01) !== 0;
      this.bus.timerEn[1]   = (f1Init & 0x02) !== 0;
      this.bus.timerEn[2]   = (f1Init & 0x04) !== 0;
      this.bus.timerDiv[0]  = this.ram[0x00FA] || 256;
      this.bus.timerDiv[1]  = this.ram[0x00FB] || 256;
      this.bus.timerDiv[2]  = this.ram[0x00FC] || 256;
      // タイマーカウンタは 0 から開始（最大1周期後に最初のティック）
      this.bus.timerCnt[0]  = 0;
      this.bus.timerCnt[1]  = 0;
      this.bus.timerCnt[2]  = 0;

      // CPU
      this.cpu = new Emu.SPC700(this.bus);
      this.cpu.A   = this.header.a;
      this.cpu.X   = this.header.x;
      this.cpu.Y   = this.header.y;
      this.cpu.PSW = this.header.psw;
      this.cpu.SP  = this.header.sp;
      this.cpu.PC  = this.header.pc;

      // DSP クロックカウンタ
      this._dspCycleAcc = 0;

      // 再生速度(1=等速 〜 1/8=低速)。CPU/タイマーの実行頻度のみを間引き、
      // DSP(音声合成)は常に毎サンプル駆動するため音程は変わらずテンポだけ落ちる。
      this.speedFactor = 1;
      this._cpuAdvanceAccum = 0;

      // KON を DSP regs から取得して再発火（初期ボイス起動）
      const konInit = dspRegs[0x4C];
      if (konInit) {
        this.dsp.writeReg(0x4C, konInit);
        this.dsp.writeReg(0x4C, 0); // KON は 1 フレームだけ有効
      }
    }

    /** CPU が STOP/SLEEP でハルトしたか */
    get isHalted() { return this.cpu.halted; }

    /**
     * 1 DSP サンプル (32kHz) を生成。
     * 内部で CPU を 32 サイクル実行、DSP を 1 クロック駆動。
     * @returns {{ L: number, R: number }} -1.0〜+1.0
     */
    renderSample() {
      // speedFactor<1のときはCPU/タイマーの進行だけを間引く。DSPは常に
      // このメソッド呼び出し=実サンプルごとに1回クロックするため、サンプルの
      // 内部再生位置(音程)は変わらず、ノート/エンベロープの進行(テンポ)だけが遅くなる。
      this._cpuAdvanceAccum += this.speedFactor;
      if (this._cpuAdvanceAccum >= 1) {
        this._cpuAdvanceAccum -= 1;
        this.bus.tickTimers(CYCLES_PER_DSP);
        this.cpu.runCycles(CYCLES_PER_DSP);
      }
      this.dsp.clock();
      return { L: this.dsp.outL, R: this.dsp.outR };
    }

    /**
     * 指定秒数分の音声を出力サンプルレートで合成
     * @param {number} seconds
     * @param {number} outRate - 出力サンプルレート (例: 44100)
     * @returns {Float32Array} モノラル (L+R)/2
     */
    renderSeconds(seconds, outRate) {
      const outSamples  = Math.round(seconds * outRate);
      const result      = new Float32Array(outSamples);
      // 32kHz → outRate への変換比率
      let dspFrac       = 0;
      let lastL = 0, lastR = 0;

      for (let i = 0; i < outSamples; i++) {
        dspFrac += DSP_RATE / outRate;
        while (dspFrac >= 1.0) {
          const s = this.renderSample();
          lastL = s.L; lastR = s.R;
          dspFrac -= 1.0;
        }
        result[i] = (lastL + lastR) * 0.5;
      }
      return result;
    }
  }

  Emu.SpcPlayer = SpcPlayer;
  Emu.SpcBus    = SpcBus;
  Emu.DSP_RATE  = DSP_RATE;

})(window);
