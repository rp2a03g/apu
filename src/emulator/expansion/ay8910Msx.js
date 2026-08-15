/*
 * AY-3-8910 PSG エミュレータ (MSX標準音源)
 * MML.Emu.AY8910Audio
 *
 * コア(トーン/ノイズ/エンベロープ/DAC)は src/emulator/expansion/fme7.js と共通設計
 * (FME-7=Sunsoft 5B は AY-3-8910/YM2149 とレジスタ・DSP的に実質同一のため)。
 * バス面のみMSX実機に合わせてポート0xA0(レジスタ選択)/0xA1(データ書込)/0xA2(データ読出)、
 * レジスタ14/15(I/Oポート A/B、未接続なので読み出しは既定0xFF)に置き換えている。
 *
 * トーン: f = Z80クロック/(32*period)。ノイズ: f = clock/(32*period)。
 * エンベロープ: 5bit(0-31)、1ステップ = clock/(16*period)。
 * 音量DAC: 5bit対数(1.5dB/step)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const AY_DAC = new Float32Array(32);
  for (let i = 0; i < 32; i++) AY_DAC[i] = i < 2 ? 0 : Math.pow(10, (i - 31) * 1.5 / 20);

  const NUM_CH = 3;

  class AyTone {
    constructor() { this.period = 1; this.timer = 0; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.level = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.level ^= 1;
      } else {
        this.timer--;
      }
    }
  }

  class AyNoise {
    constructor() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    reset() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.flip ^= 1;
        if (this.flip) {
          const fb = (this.lfsr ^ (this.lfsr >> 3)) & 1;
          this.lfsr = ((this.lfsr >> 1) | (fb << 16)) & 0x1FFFF;
        }
        this.out = this.lfsr & 1;
      } else {
        this.timer--;
      }
    }
  }

  class AyEnvelope {
    constructor() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.cont = false; this.alt = false; this.hold = false; this.holding = false; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.holding = false; this.level = 0; }
    writeShape(s) {
      this.hold = (s & 1) !== 0;
      this.alt = (s & 2) !== 0;
      this.att = (s & 4) !== 0;
      this.cont = (s & 8) !== 0;
      this.step = 0;
      this.holding = false;
      this.timer = 0;
      this.level = this.att ? 0 : 31;
    }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this._step();
      } else {
        this.timer--;
      }
    }
    _step() {
      if (this.holding) return;
      this.step++;
      if (this.step > 31) {
        this.step = 0;
        if (!this.cont) { this.holding = true; this.level = 0; return; }
        if (this.hold) { this.holding = true; this.level = this.alt ? (this.att ? 0 : 31) : (this.att ? 31 : 0); return; }
        if (this.alt) this.att = !this.att;
      }
      this.level = this.att ? this.step : (31 - this.step);
    }
  }

  class AY8910Audio {
    constructor() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38; // 既定: トーンON・ノイズOFF、I/Oポートは入力扱い
      this.regs[14] = 0xFF;
      this.regs[15] = 0xFF;
      this.tones = [new AyTone(), new AyTone(), new AyTone()];
      this.noise = new AyNoise();
      this.env = new AyEnvelope();
      this._div = 0;
      this.mute = [false, false, false];
      this.vol = [1, 1, 1];
    }

    reset() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38;
      this.regs[14] = 0xFF;
      this.regs[15] = 0xFF;
      for (const t of this.tones) t.reset();
      this.noise.reset();
      this.env.reset();
      this._div = 0;
    }

    // port: 0xA0=レジスタ選択, 0xA1=データ書込
    ioWrite(port, value) {
      value &= 0xFF;
      if (port === 0xA0) {
        this.addr = value & 0x0F;
      } else if (port === 0xA1) {
        this.writeInternal(this.addr, value);
      }
    }

    // port 0xA2=データ読出
    readData() {
      return this.regs[this.addr];
    }

    writeInternal(reg, value) {
      this.regs[reg] = value;
      switch (reg) {
        case 0: case 1: this.tones[0].period = this.regs[0] | ((this.regs[1] & 0x0F) << 8); break;
        case 2: case 3: this.tones[1].period = this.regs[2] | ((this.regs[3] & 0x0F) << 8); break;
        case 4: case 5: this.tones[2].period = this.regs[4] | ((this.regs[5] & 0x0F) << 8); break;
        case 6: this.noise.period = value & 0x1F; break;
        case 11: case 12: this.env.period = this.regs[11] | (this.regs[12] << 8); break;
        case 13: this.env.writeShape(value); break;
      }
    }

    clock() {
      if (++this._div >= 16) {
        this._div = 0;
        this.tones[0].clock();
        this.tones[1].clock();
        this.tones[2].clock();
        this.noise.clock();
        this.env.clock();
      }
    }

    channelLevel(ch) {
      const volReg = this.regs[8 + ch];
      if (volReg & 0x10) return this.env.level;
      return ((volReg & 0x0F) * 2) + 1;
    }

    mixSample() {
      const mix = this.regs[7];
      let sum = 0;
      for (let i = 0; i < NUM_CH; i++) {
        if (this.mute[i]) continue;
        const toneOn = ((mix >> i) & 1) === 0;
        const noiseOn = ((mix >> (i + 3)) & 1) === 0;
        const t = toneOn ? this.tones[i].level : 1;
        const n = noiseOn ? this.noise.out : 1;
        if (t && n) sum += AY_DAC[this.channelLevel(i)] * this.vol[i];
      }
      return sum * 0.35;
    }
  }

  // 鍵盤表示用スナップショット(MSX Z80クロック基準)
  Emu.snapshotAY8910 = function (chip) {
    const CLOCK = MML.KSS ? MML.KSS.Z80_CLOCK : 3579545;
    const mix = chip.regs[7];
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const period = chip.tones[i].period;
      const toneOn = ((mix >> i) & 1) === 0;
      const noiseOn = ((mix >> (i + 3)) & 1) === 0;
      const level = chip.channelLevel(i);
      const envMode = (chip.regs[8 + i] & 0x10) !== 0;
      const freq = (toneOn && period > 0) ? CLOCK / (32 * period) : 0;
      out.push({
        freq,
        vol: level / 31,
        rawVol: Math.round(level / 2),
        active: (toneOn ? (level > 0 && freq > 0) : (noiseOn && level > 0)),
        noise: noiseOn,
        envMode
      });
    }
    return out;
  };

  Emu.AY8910Audio = AY8910Audio;
})(window);
