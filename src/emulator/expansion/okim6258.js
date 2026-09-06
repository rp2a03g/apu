/*
 * OKI MSM6258 (OKIM6258) ADPCM音声 (VGM: chip 'okim6258'。Sharp X68000の内蔵ADPCM。
 * YM2151とペアでドラム/ボイスを担当。Namachuukei 68 / グラディウス各種 / コーエー作品等)
 * MML.Emu.OKIM6258Audio
 *
 * 4bit OKI(Dialogic系)ADPCM×1ch・12bit内部信号。ROMを持たず、CPUがデータレジスタへ
 * 1バイトずつ流し込むストリーミング方式(VGMではDACストリーム制御0x90-0x95のchipType 0x17、
 * またはコマンド0xB7の直書き)。チップは masterClock/divider のレートで
 * **上位→下位ニブルの順**に1サンプル1ニブル消費する。
 * ★ニブル順は実データで検証済み: 実VGM(信長の野望・音声サンプル)のデータバンクを両順で
 *   デコードすると高域エネルギー比が上位先行0.12/下位先行0.71で、上位先行だけが音声になる。
 * MAME okim6258.cpp + VGMPlay okim6258.c(Valley Bell)準拠:
 *   レジスタ(VGM 0xB7 aa dd、aaのbit7=デュアル2個目):
 *     0x00 制御: bit0=停止 / bit1=再生開始(開始時 signal=-2, step=0, ニブル位相/FIFOリセット)。
 *                bit0もbit1も無い書込みは停止(MAME準拠)
 *     0x01 データ: ADPCM 1バイト(8段FIFO。VGMPlayと同じくストリームの粒度ズレを吸収)
 *     0x02 パン: bit1=左ミュート / bit0=右ミュート(X68000は8255ポートCのL/Rゲート相当)
 *     0x08-0x0B マスタークロック実行時変更(リトルエンディアン4バイト) / 0x0C 分周変更
 *   分周表 {1024, 768, 512, 512}(初期値はVGMヘッダ0x94 flags bit0-1)。
 *   4MHz/512=7813Hz、8MHz時は15.6kHz等。X68000はレート切替を分周/クロック変更で行う。
 *   flags bit2=3bit ADPCMモード(未実装: X68000は4bit固定。使用VGMは未確認)、
 *   bit3=DAC 10bit/12bit(10bit時は下位2bit切り捨て=振幅は変えない解釈。
 *   VGMPlayの±511クランプ解釈だと音量が1/4になり実機比で明らかに小さいため採らない)
 *
 * データ枯渇時は信号を保持し、枯渇が続いたら緩やかに0へ減衰(ストリーム粒度ズレでの
 * プチノイズ/DC張り付き防止)。regsOnlyキャプチャ(clock()無し)ではFIFOが消費されないが、
 * 満杯時は捨てるだけなので安全。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DIVIDERS = [1024, 768, 512, 512];

  // OKI ADPCM差分表(MAME compute_tables: 49ステップ×16ニブル)
  const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];
  const DIFF = new Int16Array(49 * 16);
  for (let step = 0; step < 49; step++) {
    const sv = Math.floor(16 * Math.pow(11 / 10, step));
    for (let n = 0; n < 16; n++) {
      const d = ((n >> 2) & 1) * sv + ((n >> 1) & 1) * (sv >> 1) + (n & 1) * (sv >> 2) + (sv >> 3);
      DIFF[step * 16 + n] = (n & 8) ? -d : d;
    }
  }

  class OKIM6258Audio {
    /**
     * @param {number} [clock=4000000] - マスタークロック(ヘッダ0x90。clock()の呼び出しレート)
     * @param {number} [flags=0] - ヘッダ0x94: bit0-1=分周、bit2=3bit ADPCM、bit3=12bit DAC
     */
    constructor(clock, flags) {
      this.clockHz = clock || 4000000;
      this.masterClock = this.clockHz; // 0x08-0x0Bで実行時変更されうる
      this.initDivider = DIVIDERS[flags & 3];
      this.out12bit = !!(flags & 8);
      this.mute = [false];
      this.vol = [1];
      this.reset();
    }
    reset() {
      this.divider = this.initDivider;
      this.playing = false;
      this.signal = -2;
      this.step = 0;
      this.nibbleLow = false; // false=次は上位ニブル(=新バイトが要る)。上位→下位の順(冒頭コメント)
      this.fifo = new Uint8Array(8);
      this.fifoR = 0; this.fifoW = 0; this.fifoLen = 0;
      this.curByte = 0; this.haveByte = false;
      this.emptyCount = 0;
      this.pan = 0;
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
      this.seq = 0; // 再生開始通番(ロール/キャプチャ用)
      this.bytesIn = 0;       // データレジスタ受信総量
      this._lastBytesIn = 0;  // スナップショット間の流量差分用
      // いま流し込まれているサンプル(DACストリームの開始アドレス=同定キー)。鍵盤表示の
      // 波形アイコン用で、音の生成には使わない。setStreamSample() が vgmPlayer から呼ぶ
      this.streamSample = null;     // { data: Uint8Array, start, len }
      this._sampleCache = new Map(); // 'start:len' → { wave: Float32Array|null, hash, cps, conf }
    }

    /**
     * DACストリームが流し始めたサンプルを教える(vgmPlayer.js _streamStart、chipType 0x17)。
     * チップ自身はROMを持たない(CPUが1バイトずつ流す)ので、他のPCMチップの「ROM上の
     * サンプル」に当たるものは「バンク上の開始アドレス〜バイト数」。鍵盤行の波形アイコンを
     * YM2610 ADPCM等と同じ makeSampleWave(音程あり=1周期/無し=全体の概形)で出すために持つ。
     */
    setStreamSample(data, start, len) {
      this.streamSample = (data && len > 0) ? { data, start, len } : null;
    }
    /** streamSample の表示用解析(キャッシュ)。復号は decodeOKIM6258Adpcm と同じ */
    _sampleInfo() {
      const s = this.streamSample;
      if (!s) return null;
      const key = s.start + ':' + s.len;
      let r = this._sampleCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const MAX_BYTES = 32 * 1024; // 長いボイス(ADPCMの読み上げ等)は先頭だけ見る(解析コスト上限)
      const len = Math.min(s.len, MAX_BYTES);
      const pcm = Emu.decodeOKIM6258Adpcm(s.data, s.start, len);
      r = { wave: null, hash: null, cps: 0, conf: 0 };
      if (U && pcm.length >= 8) {
        const auto = U.detectCps(pcm);
        r.cps = auto.cps; r.conf = auto.conf;
        r.hash = U.sampleHash(s.data, s.start, s.start + len);
        r.wave = U.makeSampleWave(pcm, auto.conf >= 0.5 ? auto.cps : 0);
      }
      // キャッシュは同じ Float32Array を毎フレーム使い回す(キャプチャ保持メモリを増やさない)
      this._sampleCache.set(key, r);
      return r;
    }

    /** レジスタ書込み(VGM 0xB7 / DACストリームのデータ配送) */
    write(reg, val) {
      switch (reg & 0x0F) {
        case 0x00: // 制御
          if (val & 0x01) { this.playing = false; break; }
          if (val & 0x02) {
            if (!this.playing) {
              this.playing = true;
              this.signal = -2; this.step = 0;
              this.nibbleLow = false; this.haveByte = false;
              this.fifoR = 0; this.fifoW = 0; this.fifoLen = 0;
              this.emptyCount = 0;
              this.seq++;
            }
          } else this.playing = false;
          break;
        case 0x01: // データ(FIFOへ。満杯なら捨てる=regsOnlyキャプチャの防波堤)
          if (this.fifoLen < 8) { this.fifo[this.fifoW] = val & 0xFF; this.fifoW = (this.fifoW + 1) & 7; this.fifoLen++; }
          this.emptyCount = 0;
          this.bytesIn++; // 発音区間推定用(スナップショットが流量差分を見る)
          break;
        case 0x02: this.pan = val & 0xFF; break;
        case 0x08: case 0x09: case 0x0A: case 0x0B: { // マスタークロック変更(LE 4バイト)
          const sh = (reg & 3) * 8;
          this.masterClock = ((this.masterClock & ~(0xFF << sh)) | ((val & 0xFF) << sh)) >>> 0;
          break;
        }
        case 0x0C: this.divider = DIVIDERS[val & 3]; break;
      }
    }

    _sample() {
      if (!this.playing) {
        // 停止中: 残留信号を緩やかに0へ(ハードステップのクリック防止)
        if (this.signal) { this.signal = Math.trunc(this.signal * 0.9); this._out(); }
        return;
      }
      if (!this.nibbleLow) {
        // 新しいバイトが要る
        if (this.fifoLen > 0) {
          this.curByte = this.fifo[this.fifoR]; this.fifoR = (this.fifoR + 1) & 7; this.fifoLen--;
          this.haveByte = true; this.emptyCount = 0;
        } else {
          this.haveByte = false;
          if (this.emptyCount < 1000) this.emptyCount++;
        }
      }
      if (this.haveByte) {
        const nib = this.nibbleLow ? (this.curByte & 15) : (this.curByte >> 4) & 15;
        this.nibbleLow = !this.nibbleLow;
        this.signal += DIFF[this.step * 16 + nib];
        if (this.signal > 2047) this.signal = 2047; else if (this.signal < -2048) this.signal = -2048;
        this.step += INDEX_SHIFT[nib & 7];
        if (this.step > 48) this.step = 48; else if (this.step < 0) this.step = 0;
      } else if (this.emptyCount > 4) {
        // データ枯渇が続く: 信号を減衰(短い枯渇はそのまま保持)
        this.signal = Math.trunc(this.signal * 0.95);
      }
      this._out();
    }
    _out() {
      let s = this.signal;
      if (!this.out12bit) s &= ~3; // 10bit DAC: 下位2bit切り捨て
      const v = this.mute[0] ? 0 : (s / 2048) * this.vol[0];
      this.lastL = (this.pan & 0x02) ? 0 : v;
      this.lastR = (this.pan & 0x01) ? 0 : v;
    }

    clock() {
      // アダプタはヘッダクロックで叩く。実行時クロック変更(0x08-0x0B)は進み係数で反映
      this.cyc += this.masterClock / this.clockHz;
      if (this.cyc < this.divider) return;
      this.cyc -= this.divider;
      this._sample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** 現在のADPCM出力レート(サンプル/秒) */
    playRate() { return this.masterClock / this.divider; }
  }

  // 鍵盤表示用スナップショット(配列1要素。YMDA/PWM/RF5Cと同じ「サンプル」行向け):
  // { active, vol, rawVol(現在振幅0-255)、panL/panR(0-15)、rate、seq }
  // 発音判定は「再生中かつデータが流れている(前回スナップショットからの流量差分>0)」。
  // X68000のドライバは再生ビットを立てっぱなしでDACストリームだけon/offする曲が多く
  // (悪魔城ドラキュラ実測: 15秒間play1回・ストリーム断続)、playing単独だと点きっぱなしになる。
  // 流量はregsOnlyキャプチャ(clock()無し)でもストリームエンジンが配送するので正確。
  // vol はライブ時=現在振幅、キャプチャ時(振幅が出ない)=下限0.3を保証。
  // waveData は流れているサンプル(DACストリーム)の128点波形(他のADPCM行と同じ makeSampleWave)。
  // 同じサンプルなら同じ Float32Array を返す(キャプチャ側で毎フレーム複製しないため)。
  Emu.snapshotOKIM6258 = function (chip) {
    const amp = Math.min(1, Math.abs(chip.signal) / 2048);
    const flow = chip.bytesIn - chip._lastBytesIn;
    chip._lastBytesIn = chip.bytesIn;
    const active = chip.playing && (flow > 0 || amp > 0.005);
    const info = chip._sampleInfo ? chip._sampleInfo() : null;
    const ss = chip.streamSample;
    return [{
      active,
      vol: active ? Math.max(0.3, amp) : 0,
      rawVol: Math.round(amp * 255), rawVolMax: 255,
      panL: (chip.pan & 0x02) ? 0 : 15, panR: (chip.pan & 0x01) ? 0 : 15,
      rate: chip.playRate(), seq: chip.seq,
      waveData: info ? info.wave : null,
      sample: ss ? { kind: 'oki', start: ss.start, end: ss.start + ss.len } : null,
      sampleHash: info ? info.hash : null
    }];
  };

  /**
   * ADPCMバイト列 → Float32(-1..1)(ドラムパッドの原音取り出し用。main.js vgmDacDrumFor)
   * チップの再生開始(制御レジスタbit1)と同じ初期状態(signal=-2, step=0)から、
   * 上位→下位ニブルの順に _sample() と同じ差分表で復号する。1バイト=2サンプル。
   * @param {Uint8Array} bytes  データバンク
   * @param {number} start      開始オフセット(DACストリームの開始アドレス=サンプル同定キー)
   * @param {number} len        バイト数
   */
  Emu.decodeOKIM6258Adpcm = function (bytes, start, len) {
    const n = Math.max(0, Math.min(len | 0, bytes.length - start));
    const out = new Float32Array(n * 2);
    let signal = -2, step = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[start + i];
      for (let k = 0; k < 2; k++) {
        const nib = k === 0 ? (b >> 4) & 15 : b & 15;
        signal += DIFF[step * 16 + nib];
        if (signal > 2047) signal = 2047; else if (signal < -2048) signal = -2048;
        step += INDEX_SHIFT[nib & 7];
        if (step > 48) step = 48; else if (step < 0) step = 0;
        out[i * 2 + k] = signal / 2048;
      }
    }
    return out;
  };

  Emu.OKIM6258Audio = OKIM6258Audio;
})(window);
