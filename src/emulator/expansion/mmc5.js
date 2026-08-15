/*
 * MMC5 拡張音源エミュレータ
 * MML.Emu.MMC5Audio
 *
 * パルス x2 ($5000-$5003 / $5004-$5007, 有効化は $5015)。
 * レジスタ形式は2A03のパルスチャンネルと同様だが、スイープユニットを持たない。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];
  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  class Mmc5Pulse {
    constructor() {
      this.enabled = false;
      this.duty = 0;
      this.lengthCounterHalt = false; // = エンベロープループフラグ
      this.constantVolume = true;
      this.volume = 0;                // 固定音量 or エンベロープ周期
      this.timerPeriod = 0;
      this.timer = 0;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      // エンベロープ(2A03パルスと同形式)
      this.envStart = false;
      this.envDivider = 0;
      this.envDecay = 0;
    }
    writeReg(index, value) {
      switch (index) {
        case 0: // $5000/$5004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.constantVolume = (value & 0x10) !== 0;
          this.volume = value & 0x0F;
          break;
        case 2: // $5002/$5006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $5003/$5007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envStart = true; // 書き込みでエンベロープ再スタート
          break;
      }
    }
    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }
    clock() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }
    // エンベロープ更新(240Hzでクロック)。2A03パルスと同一ロジック。
    clockEnvelope() {
      if (this.envStart) {
        this.envStart = false;
        this.envDecay = 15;
        this.envDivider = this.volume;
      } else if (this.envDivider === 0) {
        this.envDivider = this.volume;
        if (this.envDecay > 0) this.envDecay--;
        else if (this.lengthCounterHalt) this.envDecay = 15; // ループ
      } else {
        this.envDivider--;
      }
    }
    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }
    output() {
      // MMC5はスイープを持たないため 2A03 の「period<8で消音」は無い(超音波域も出力)。
      if (!this.enabled || this.lengthCounter === 0) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.constantVolume ? this.volume : this.envDecay;
    }
  }

  class MMC5Audio {
    constructor() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;   // $5011 8bit 生PCM DAC 出力
      this.pcmReadMode = false; // $5010 bit0
      this.mute = { pulse1: false, pulse2: false, pcm: false };
      this.vol = { pulse1: 1, pulse2: 1, pcm: 1 };
    }

    reset() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;
      this.pcmReadMode = false;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x5000 && addr <= 0x5003) {
        this.pulse1.writeReg(addr - 0x5000, value);
      } else if (addr >= 0x5004 && addr <= 0x5007) {
        this.pulse2.writeReg(addr - 0x5004, value);
      } else if (addr === 0x5010) {
        this.pcmReadMode = (value & 0x01) !== 0; // bit0: 0=writeモード, 1=readモード
      } else if (addr === 0x5011) {
        // 8bit 生PCM。writeモードのみ出力を更新($4011相当だが8bit)。
        if (!this.pcmReadMode) this.pcmLevel = value;
      } else if (addr === 0x5015) {
        this.pulse1.setEnabled((value & 0x01) !== 0);
        this.pulse2.setEnabled((value & 0x02) !== 0);
      }
    }

    clock() {
      // パルスタイマは 2A03 と同じくAPUサイクル(2 CPUサイクル)ごとに進める。
      // f = CPU/(16*(period+1))。毎CPUサイクルで進めると1オクターブ高くなる。
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clock();
        this.pulse2.clock();
      }
      // MMC5はエンベロープ・長さカウンタとも 240Hz 固定(APU長さカウンタの2倍速)。
      // 7457 CPUサイクル(≒240Hz)ごとに両方クロックする。
      this.frameCounter++;
      if (this.frameCounter >= 7457) {
        this.frameCounter = 0;
        this.pulse1.clockEnvelope();
        this.pulse2.clockEnvelope();
        this.pulse1.clockHalfFrame();
        this.pulse2.clockHalfFrame();
      }
    }

    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : (this.pulse1.output() / 15) * this.vol.pulse1;
      const p2 = this.mute.pulse2 ? 0 : (this.pulse2.output() / 15) * this.vol.pulse2;
      const pcm = this.mute.pcm ? 0 : (this.pcmLevel / 255) * this.vol.pcm;
      return (p1 + p2) * 0.25 + pcm * 0.30;
    }
  }

  // 鍵盤表示用: ライブチップから pulse1/pulse2/pcm のスナップショットを作る。
  // 音量はエンベロープ実出力(constantVolume=false時はenvDecay)を反映。
  Emu.snapshotMMC5 = function (chip) {
    const CPU = 1789773;
    const pulse = (p) => {
      const eff = p.constantVolume ? p.volume : p.envDecay; // 実効音量
      const freq = (p.timerPeriod >= 8) ? CPU / (16 * (p.timerPeriod + 1)) : 0;
      return {
        freq,
        vol: eff / 15,
        rawVol: eff,
        duty: p.duty,
        active: p.enabled && p.lengthCounter > 0 && eff > 0 && freq > 0
      };
    };
    return {
      pulse1: pulse(chip.pulse1),
      pulse2: pulse(chip.pulse2),
      pcm: { level: chip.pcmLevel, vol: chip.pcmLevel / 255, active: chip.pcmLevel > 0 }
    };
  };

  Emu.MMC5Audio = MMC5Audio;
})(window);
