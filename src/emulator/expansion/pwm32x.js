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
    }
    _scale(d) {
      const c = this.cycle > 0 ? this.cycle : 1;
      if (d > c) d = c;
      return (d - c / 2) / (c / 2);
    }
    write(reg, data) {
      data &= 0xFFF;
      switch (reg & 0x0F) {
        case 0x01: this.cycle = ((data - 1) & 0xFFF) || 1; this.outL = this._scale(this.dataL); this.outR = this._scale(this.dataR); break;
        case 0x02: this.dataL = data; this.outL = this._scale(data); break;
        case 0x03: this.dataR = data; this.outR = this._scale(data); break;
        case 0x04: this.dataL = this.dataR = data; this.outL = this.outR = this._scale(data); break;
        default: break; // 0=制御 等は無視
      }
    }
    clock() { /* 発振無し(ゼロ次ホールド) */ }
    mixSample() {
      return {
        left: this.mute[0] ? 0 : this.outL * this.vol[0],
        right: this.mute[1] ? 0 : this.outR * this.vol[1]
      };
    }
  }

  // 鍵盤表示用スナップショット: 左右のPCMレベル(0-1)と生値
  Emu.snapshotPWM32X = function (chip) {
    return {
      cycle: chip.cycle,
      l: { level: chip.dataL, vol: Math.min(1, Math.abs(chip.outL)), active: chip.dataL > 0 && Math.abs(chip.outL) > 0.02 },
      r: { level: chip.dataR, vol: Math.min(1, Math.abs(chip.outR)), active: chip.dataR > 0 && Math.abs(chip.outR) > 0.02 }
    };
  };

  Emu.PWM32XAudio = PWM32XAudio;
})(window);
