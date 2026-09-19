/*
 * Sega 32X PWM 音源 (VGM: chip 'pwm'、コマンド 0xB2)
 * MML.Emu.PWM32XAudio
 *
 * 32XのSH-2が駆動するPWM DAC(左右2ch)。VGMには「PWMレジスタ書込み」としてサンプル値が
 * そのまま(通常22kHz前後、0x70-0x72の1〜3サンプル待ちを挟んで)記録されている
 * (After Burner Complete (32X) 実測: 2MB中に0xB2が97万回、データブロック無し)。
 * 発振器を持たないので clock() は何もせず、最後に書かれた値をゼロ次ホールドで出力する
 * (VGMPlay/Gens の pwm.c と同じ考え方)。
 *
 * レジスタ(0xB2 ad dd: a=レジスタ、d=12bit値):
 *   0=制御(無視), 1=サイクル(周期。値-1が実効サイクル), 2=左データ, 3=右データ, 4=左右同時(モノ)
 * 出力 = (min(data, cycle) - cycle/2) / (cycle/2)  → ±1.0
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 鍵盤表示のwave列に出す「直近に流れたサンプル」の長さ。PWMは22kHz前後なので
  // 128点=約6ms、1フレーム(1/60秒=約370点)の一部を切り出した眺めになる。
  // 複数の音を32X側で合成してから流している(=1本のミックス済みストリーム)ので、
  // 波形から音色を読み取れるわけではないが、鳴っている/止まっているは一目で分かる
  const PWM_WAVE_LEN = 128;

  class PWM32XAudio {
    constructor() {
      this.mute = [false, false]; // L, R
      this.vol = [1, 1];
      this.reset();
    }
    reset() {
      this.cycle = 0x1000 - 1;
      this.dataL = 0; this.dataR = 0;
      this.outL = 0; this.outR = 0;
      // 直近の出力サンプルのリングバッファ(L/R別。書き込みのたびに1点進む)
      this.histL = new Float32Array(PWM_WAVE_LEN);
      this.histR = new Float32Array(PWM_WAVE_LEN);
      this.histLPos = 0; this.histRPos = 0;
    }
    _scale(d) {
      const c = this.cycle > 0 ? this.cycle : 1;
      if (d > c) d = c;
      return (d - c / 2) / (c / 2);
    }
    _pushL(v) { this.histL[this.histLPos] = v; this.histLPos = (this.histLPos + 1) % PWM_WAVE_LEN; }
    _pushR(v) { this.histR[this.histRPos] = v; this.histRPos = (this.histRPos + 1) % PWM_WAVE_LEN; }
    write(reg, data) {
      data &= 0xFFF;
      switch (reg & 0x0F) {
        case 0x01: this.cycle = ((data - 1) & 0xFFF) || 1; this.outL = this._scale(this.dataL); this.outR = this._scale(this.dataR); break;
        case 0x02: this.dataL = data; this.outL = this._scale(data); this._pushL(this.outL); break;
        case 0x03: this.dataR = data; this.outR = this._scale(data); this._pushR(this.outR); break;
        case 0x04: this.dataL = this.dataR = data; this.outL = this.outR = this._scale(data); this._pushL(this.outL); this._pushR(this.outR); break;
        default: break; // 0=制御 等は無視
      }
    }
    /** リングバッファを「古い→新しい」の順に並べ直した波形(鍵盤表示のwave列用) */
    waveOf(ch) {
      const src = ch ? this.histR : this.histL;
      const pos = ch ? this.histRPos : this.histLPos;
      const out = new Float32Array(PWM_WAVE_LEN);
      for (let i = 0; i < PWM_WAVE_LEN; i++) out[i] = src[(pos + i) % PWM_WAVE_LEN];
      return out;
    }
    clock() { /* 発振無し(ゼロ次ホールド) */ }
    mixSample() {
      return {
        left: this.mute[0] ? 0 : this.outL * this.vol[0],
        right: this.mute[1] ? 0 : this.outR * this.vol[1]
      };
    }
  }

  // 鍵盤表示用スナップショット: 左右のPCMレベル(0-1)と生値。
  // withWave=true のときだけ直近128点の波形を積む(ライブ再生の鍵盤表示用)。
  // 先読みキャプチャ側では付けない: 毎フレーム128点×2chの新しい配列を保持すると
  // 3分の曲で10MB超になり、得られる物(数ms前の眺め)に見合わない。
  Emu.snapshotPWM32X = function (chip, withWave) {
    return {
      cycle: chip.cycle,
      l: { level: chip.dataL, vol: Math.min(1, Math.abs(chip.outL)), active: chip.dataL > 0 && Math.abs(chip.outL) > 0.02,
           waveData: withWave ? chip.waveOf(0) : null },
      r: { level: chip.dataR, vol: Math.min(1, Math.abs(chip.outR)), active: chip.dataR > 0 && Math.abs(chip.outR) > 0.02,
           waveData: withWave ? chip.waveOf(1) : null }
    };
  };

  Emu.PWM32XAudio = PWM32XAudio;
})(window);
