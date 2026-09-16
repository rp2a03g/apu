/*
 * OKI MSM5205 / MSM6585 ADPCM音声 (VGM: chip 'msm5205'。PC Engine CD-ROM² の ADPCM、
 * および多数のアーケード基板のボイス/ドラム。スターパロジャー / ドラゴンスレイヤー英雄伝説 等)
 * MML.Emu.MSM5205Audio
 *
 * 4bit(または3bit)ADPCM×1ch・10bit内部信号・モノラル。ROMを持たず、CPUが
 * **1ニブルずつ**流し込むストリーミング方式(VGMコマンド 0x32 dd。上位ニブル=レジスタ、
 * 下位ニブル=値)。チップは masterClock/prescaler のレートで8段FIFOから1ニブル消費し、
 * FIFOが空の間は直前の信号を保持する(=データを流し込むテンポがそのまま再生ピッチになる)。
 * 挙動は libvgm emu/cores/msm5205.c(eito/cam900/Valley Bell)準拠:
 *   レジスタ(VGM 0x32 dd: reg=(dd>>4)&7, val=dd&0xF。ddのbit7=デュアル2個目):
 *     0 リセット(非0で停止。変化時に signal/step をクリア、リセット中はFIFOも空に)
 *     1 データ(ADPCM 1ニブル。8段FIFO。満杯なら捨てる)
 *     2 VCK(スレーブモード時だけ有効。立ち上がりで1ニブル消費)
 *     4 プリスケーラ(bit0=S1, bit1=S2) / 5 ビット幅(非0で4bit、0で3bit)
 *   プリスケーラ表: MSM5205 {96, 64, 48, 1(スレーブ)} / MSM6585 {160, 80, 40, 20}
 *   初期値はVGMヘッダ **0xD7**(bit0-1=プリスケーラ、bit2=4bit ADPCM)、
 *   0xF0のbit31=MSM6585。
 *   信号更新は加算ではなく**減衰付き**: signal = (diff<<8 + signal*245) >> 8 (≒0.957の漏れ積分)。
 *   差分表は OKI系と同一(49ステップ×16ニブル。okim6258.js と同じ式)。
 *
 * ★PC Engine CD の曲は DACストリーム(0x90-0x95)ではなく 0x32 の直書きで流れてくるので、
 * okim6258.js の streamSample のような「サンプルの同定キー」は存在しない。
 * ドラムパッドの原音取り出し([[vgm-dac-drums-from-log]] の方式)はこの経路には使えず、
 * 鍵盤表示/ロールでは「鳴っている1レーン」として出す。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PIN_S1 = 0x01;
  const PIN_S2 = 0x02;
  const FIFO_LEN = 8;

  // ADPCM差分表(libvgm compute_tables。okim6258.js の DIFF と同一式)
  const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];
  const DIFF = new Int16Array(49 * 16);
  for (let step = 0; step < 49; step++) {
    const sv = Math.floor(16 * Math.pow(11 / 10, step));
    for (let n = 0; n < 16; n++) {
      const d = ((n >> 2) & 1) * sv + ((n >> 1) & 1) * ((sv / 2) | 0) + (n & 1) * ((sv / 4) | 0) + ((sv / 8) | 0);
      DIFF[step * 16 + n] = (n & 8) ? -d : d;
    }
  }

  class MSM5205Audio {
    /**
     * @param {number} [clock=384000] - マスタークロック(ヘッダ0xF0)
     * @param {number} [flags=0]      - ヘッダ0xD7: bit0-1=プリスケーラ、bit2=4bit ADPCM
     * @param {boolean} [is6585=false]- ヘッダ0xF0のbit31(MSM6585)
     */
    constructor(clock, flags, is6585) {
      this.clockHz = clock || 384000;
      this.masterClock = this.clockHz;
      this.is6585 = !!is6585;
      this.initPrescaler = (flags || 0) & 0x03;
      this.initBitWidth = ((flags || 0) & 0x04) ? 4 : 3;
      this.mute = [false];
      this.vol = [1];
      this.reset();
    }

    reset() {
      this.signal = -2;
      this.step = 0;
      this.vclk = 0;
      this.resetFlag = 0;
      this.prescalerBits = this.initPrescaler;
      this.bitWidth = this.initBitWidth;
      this.fifo = new Uint8Array(FIFO_LEN);
      this.fifoR = 0; this.fifoW = 0;
      this.cyc = 0;
      this.last = 0;
      this.seq = 0;          // 再生開始通番(ロール/キャプチャ用)
      this.nibblesIn = 0;    // データレジスタ受信総量
      this._lastNibblesIn = 0; // スナップショット間の流量差分用
    }

    /** プリスケーラ(分周比)。1 はスレーブモード(VCK入力駆動) */
    prescaler() {
      const p = this.prescalerBits;
      if (this.is6585) return (p & PIN_S1) ? ((p & PIN_S2) ? 20 : 80) : ((p & PIN_S2) ? 40 : 160);
      return (p & PIN_S1) ? ((p & PIN_S2) ? 1 : 64) : ((p & PIN_S2) ? 48 : 96);
    }
    /** 現在のADPCM出力レート(サンプル/秒) */
    playRate() { const d = this.prescaler(); return d > 1 ? this.masterClock / d : 0; }

    _fifoEmpty() { return this.fifoR === this.fifoW; }

    /** レジスタ書込み(VGM 0x32: reg=(dd>>4)&7, val=dd&0xF) */
    write(reg, val) {
      switch (reg & 0x07) {
        case 0: { // リセット
          const old = this.resetFlag;
          this.resetFlag = val;
          if (old ^ val) { this.signal = 0; this.step = 0; }
          if (this.resetFlag) { this.fifoR = 0; this.fifoW = 0; }
          else if (old) this.seq++; // 停止→再生のエッジを発音区間の起点にする
          break;
        }
        case 1: { // データ(1ニブル)
          const next = (this.fifoW + 1) % FIFO_LEN;
          if (next === this.fifoR) break; // FIFOあふれ: 捨てる(libvgm同様)
          this.fifo[this.fifoW] = val & 0x0F;
          this.fifoW = next;
          this.nibblesIn++;
          break;
        }
        case 2: { // VCK(スレーブモードのみ)
          const old = this.vclk;
          this.vclk = val;
          if (this.prescaler() === 1 && ((old ^ val) & 1) && this.vclk) this._consume();
          break;
        }
        case 4: this.prescalerBits = val & 0x03; break;
        case 5: this.bitWidth = val ? 4 : 3; break;
        default: break;
      }
    }

    /** FIFOから1ニブル取り出して復号(libvgm clock_adpcm) */
    _consume() {
      if (this.mute[0] || this.resetFlag || this._fifoEmpty()) return;
      let data = this.fifo[this.fifoR];
      this.fifoR = (this.fifoR + 1) % FIFO_LEN;
      if (this.bitWidth === 3) data <<= 1;
      data &= 0x0F;
      const diff = DIFF[this.step * 16 + data];
      // ★加算ではなく減衰付き(libvgm: ((sample << 8) + (signal * 245)) >> 8)
      this.signal = ((diff << 8) + (this.signal * 245)) >> 8;
      if (this.signal > 2047) this.signal = 2047; else if (this.signal < -2048) this.signal = -2048;
      this.step += INDEX_SHIFT[data & 7];
      if (this.step > 48) this.step = 48; else if (this.step < 0) this.step = 0;
    }

    _out() {
      const s = (this.mute[0] || this.resetFlag) ? 0 : this.signal;
      this.last = (s / 2048) * this.vol[0];
    }

    clock() {
      const div = this.prescaler();
      if (div <= 1) { this._out(); return; } // スレーブモード: VCK書込みで進む
      this.cyc += this.masterClock / this.clockHz;
      if (this.cyc < div) return;
      this.cyc -= div;
      this._consume(); // FIFOが空なら直前の信号を保持(libvgm と同じ)
      this._out();
    }
    mixSample() { return { left: this.last, right: this.last }; }
  }

  // 鍵盤表示用スナップショット(配列1要素。okim6258 と同じ「サンプル」行向け)。
  // 発音判定は「リセットが解けていて、かつデータが流れている(前回からの流量差分>0)」。
  // ドライバは再生ビットを立てっぱなしでニブル供給だけ止める曲があるため、流量を見る。
  // 流量は regsOnly キャプチャ(clock()無し)でも書込みだけで積まれるので正確。
  Emu.snapshotMSM5205 = function (chip) {
    const amp = Math.min(1, Math.abs(chip.signal) / 2048);
    const flow = chip.nibblesIn - chip._lastNibblesIn;
    chip._lastNibblesIn = chip.nibblesIn;
    const active = !chip.resetFlag && (flow > 0 || amp > 0.005);
    return [{
      active,
      vol: active ? Math.max(0.3, amp) : 0,
      rawVol: Math.round(amp * 255), rawVolMax: 255,
      panL: 15, panR: 15,
      rate: chip.playRate(), seq: chip.seq,
      waveData: null, sample: null, sampleHash: null
    }];
  };

  // 差分表は先読みキャプチャ側(vgmPlayer.js msmRecWrite)でも使う。キャプチャは clock() を
  // 回さないのでチップ本体の signal は進まず、書込み列から同じ式で復号し直す必要がある。
  // ★ここを直したらキャプチャ側の復号も同じ式であることを確認すること(音が変わる)。
  Emu.MSM5205_DIFF = DIFF;
  Emu.MSM5205_INDEX_SHIFT = INDEX_SHIFT;

  Emu.MSM5205Audio = MSM5205Audio;
})(window);
