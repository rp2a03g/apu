/*
 * SN76489 PSG エミュレータ (Texas Instruments系。Sega SG-1000/Master System/Game Gear/
 * Mega Driveの内蔵PSG、ColecoVision、BBC Micro等)
 * MML.Emu.SN76489Audio
 *
 * ★AY-3-8910系(ay8910Msx.js/fme7.js)とは別系統のチップ。ハードウェアエンベロープ・
 *   アドレスラッチ・I/Oポートを持たない代わりに、書込み専用1ポートのLATCH/DATA方式で
 *   10bit周期×3 + ノイズ1ch + 4bit減衰(2dB/step)を持つ。
 *
 * 書込みバイト:
 *   bit7=1 LATCH/DATA: bit6-5=ch(0-3), bit4=0:周期(下位4bit)/1:音量, bit3-0=データ
 *   bit7=0 DATA      : bit5-0=直前にラッチしたレジスタへの上位6bit(周期)/下位4bit(音量・ノイズ)
 * トーン: 内部/16分周後、周期カウンタが0になるたび出力反転+再装填。f = clock/(32*period)。
 *   周期が小さすぎる(<6、VGMPlay/Maxim核のPSG_CUTOFF既定)値は「反転せず常に+1」(=DC)。
 *   実機の「音量だけ書き換えてPCM再生する」技法がこの挙動に依存する。
 *   周期0はSega VDP版では上と同じ扱い(VGMヘッダ0x2B bit0が立っている時だけ0x400扱い)。
 * ノイズ: bit2=0:周期性(periodic)/1:白色(white)、bit1-0=シフトレート 0:clock/512,
 *   1:clock/1024, 2:clock/2048, 3:トーンch2の周期に追従。LFSRの幅/帰還パターンは
 *   Sega版=16bit/0x0009、TI版=15bit/0x0003(VGMヘッダ0x28/0x2Aから受け取る)。
 *   ノイズレジスタ書込みでLFSRは初期値(最上位bitのみ1)へリセット。
 * 音量: 0=最大, 0xF=無音、10^(-2n/20)。
 * Game Gearステレオ(ポート$06): bit3-0=右ch(bit0=tone0..bit3=noise), bit7-4=左ch。既定0xFF。
 *
 * clock() はチップの実クロック(3579545Hz等)ごとに1回呼ぶ(apu2a03.js等と同じ設計)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 4;
  const VOL_TABLE = new Float32Array(16);
  for (let i = 0; i < 15; i++) VOL_TABLE[i] = Math.pow(10, -2 * i / 20);
  VOL_TABLE[15] = 0;

  const PSG_CUTOFF = 6; // これ未満の周期は反転させず+1固定(VGMPlay/Maxim SN76489核と同じ)

  class SN76489Audio {
    /**
     * @param {object} [opt] - { feedback: 0x0009, shiftWidth: 16, freq0Is0x400: false, clockDiv8: false }
     */
    constructor(opt) {
      opt = opt || {};
      this.feedback = opt.feedback || 0x0009;
      this.shiftWidth = opt.shiftWidth || 16;
      this.freq0Is0x400 = !!opt.freq0Is0x400;
      // 一部の派生品(VGMヘッダ0x2B bit3)は内部分周が/8。既定/16。
      this.clockDiv = opt.clockDiv8 ? 8 : 16;
      this.mute = [false, false, false, false];
      this.vol = [1, 1, 1, 1];
      this.reset();
    }

    reset() {
      this.period = new Uint16Array(3);   // 10bit
      this.att = new Uint8Array(NUM_CH).fill(0xF); // 4bit減衰(0xF=無音)
      this.counter = new Int32Array(3);
      this.level = new Uint8Array(3);     // トーン出力(0/1)
      this.noiseReg = 0;                  // bit2=white, bit1-0=rate
      this.noiseCounter = 0;
      this.noiseFlip = 0;                 // ノイズ用フリップフロップ(立ち上がりでシフト)
      this.lfsr = 1 << (this.shiftWidth - 1);
      this.noiseOut = 0;
      this.latch = 0;                     // bit2-1=ch, bit0=type(0=tone/1=vol)
      this.stereo = 0xFF;                 // GG: 上位=左, 下位=右
      this._div = 0;
    }

    // ── シーク用の状態保存/復元(2026-09-04、VgmPlayerのチェックポイント) ──────────
    // SN76489はレジスタ影と内部カウンタが全部小さい素の値なので、そのまま丸ごと持てる。
    // ★ここに無いフィールドは復元されない。フィールドを足したらここも足すこと
    //   (VgmPlayer側は「全チップがgetState/setStateを持つ曲」でしかチェックポイントを使わない)。
    getState() {
      return { period: this.period.slice(), att: this.att.slice(), counter: this.counter.slice(),
               level: this.level.slice(), noiseReg: this.noiseReg, noiseCounter: this.noiseCounter,
               noiseFlip: this.noiseFlip, lfsr: this.lfsr, noiseOut: this.noiseOut,
               latch: this.latch, stereo: this.stereo, _div: this._div };
    }
    setState(s) {
      if (!s) return;
      this.period.set(s.period); this.att.set(s.att); this.counter.set(s.counter); this.level.set(s.level);
      this.noiseReg = s.noiseReg; this.noiseCounter = s.noiseCounter; this.noiseFlip = s.noiseFlip;
      this.lfsr = s.lfsr; this.noiseOut = s.noiseOut; this.latch = s.latch; this.stereo = s.stereo;
      this._div = s._div;
    }

    /** データポート書込み */
    write(value) {
      value &= 0xFF;
      if (value & 0x80) {
        this.latch = (value >> 4) & 0x07;
        this._applyLatched(value & 0x0F, true);
      } else {
        this._applyLatched(value & 0x3F, false);
      }
    }

    _applyLatched(data, isLatch) {
      const ch = (this.latch >> 1) & 3;
      const isVol = this.latch & 1;
      if (isVol) {
        this.att[ch] = data & 0x0F;
      } else if (ch < 3) {
        if (isLatch) this.period[ch] = (this.period[ch] & 0x3F0) | (data & 0x0F);
        else this.period[ch] = (this.period[ch] & 0x00F) | ((data & 0x3F) << 4);
      } else {
        // ノイズ制御。書込みのたびにLFSRをリセット(実機挙動、Maxim核と同じ)
        this.noiseReg = data & 0x07;
        this.lfsr = 1 << (this.shiftWidth - 1);
      }
    }

    /** Game Gear ステレオレジスタ(ポート$06) */
    writeStereo(value) { this.stereo = value & 0xFF; }

    _effectivePeriod(ch) {
      const p = this.period[ch];
      return (p === 0 && this.freq0Is0x400) ? 0x400 : p;
    }

    _noisePeriod() {
      switch (this.noiseReg & 3) {
        case 0: return 0x10;
        case 1: return 0x20;
        case 2: return 0x40;
        default: return this._effectivePeriod(2);
      }
    }

    clock() {
      if (++this._div < this.clockDiv) return;
      this._div = 0;
      // トーン
      for (let i = 0; i < 3; i++) {
        if (--this.counter[i] <= 0) {
          const p = this._effectivePeriod(i);
          if (p >= PSG_CUTOFF) this.level[i] ^= 1;
          else this.level[i] = 1; // 周期が小さすぎる=反転せず+1固定(DC。PCM技法用)
          this.counter[i] += p; // 0や小さい値は次のティックでも即座に再評価される
          if (this.counter[i] <= 0) this.counter[i] = 1;
        }
      }
      // ノイズ: 周期カウンタ→フリップフロップ→立ち上がりでLFSRシフト
      if (--this.noiseCounter <= 0) {
        const np = this._noisePeriod();
        this.noiseCounter += np > 0 ? np : 1;
        if (this.noiseCounter <= 0) this.noiseCounter = 1;
        this.noiseFlip ^= 1;
        if (this.noiseFlip) {
          const white = (this.noiseReg & 4) !== 0;
          let fb;
          if (white) {
            // 帰還パターンのタップのパリティ
            let x = this.lfsr & this.feedback;
            x ^= x >> 8; x ^= x >> 4; x ^= x >> 2; x ^= x >> 1;
            fb = x & 1;
          } else {
            fb = this.lfsr & 1;
          }
          this.lfsr = (this.lfsr >> 1) | (fb << (this.shiftWidth - 1));
          this.noiseOut = this.lfsr & 1;
        }
      }
    }

    // チャンネルの現在出力(0/1)
    channelLevel(ch) { return ch < 3 ? this.level[ch] : this.noiseOut; }

    /**
     * {left, right}(各0〜約1.0)。GGステレオを反映(SMS/MDでは常に両側)。
     * 4ch合計が1.0程度になるようスケール。
     */
    mixSample() {
      let l = 0, r = 0;
      for (let i = 0; i < NUM_CH; i++) {
        if (this.mute[i]) continue;
        const lv = this.channelLevel(i);
        if (!lv) continue;
        const v = VOL_TABLE[this.att[i]] * this.vol[i];
        if ((this.stereo >> (4 + i)) & 1) l += v;
        if ((this.stereo >> i) & 1) r += v;
      }
      return { left: l * 0.25, right: r * 0.25 };
    }
  }

  // 鍵盤表示用スナップショット。clockはチップの実クロック。
  // rawVol: 0-15(音量。減衰の逆、15=最大)。noiseIndex/noiseFreqはノイズ行用。
  Emu.snapshotSN76489 = function (chip, clock) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const p = chip._effectivePeriod(i);
      const vol = 15 - chip.att[i];
      const audible = p >= PSG_CUTOFF;
      const freq = audible && p > 0 ? clock / (32 * p) : 0;
      out.push({ freq, vol: VOL_TABLE[chip.att[i]], rawVol: vol, active: vol > 0 && audible && freq > 0, period: p,
        panL: (chip.stereo >> (4 + i)) & 1, panR: (chip.stereo >> i) & 1 });
    }
    {
      const vol = 15 - chip.att[3];
      const np = chip._noisePeriod();
      // LFSRシフトレート = clock / (32 * np)(np=0x10→clock/512)
      const shiftHz = np > 0 ? clock / (32 * np) : 0;
      out.push({ freq: 0, vol: VOL_TABLE[chip.att[3]], rawVol: vol, active: vol > 0 && shiftHz > 0,
        noise: true, white: (chip.noiseReg & 4) !== 0, noiseRate: chip.noiseReg & 3, noiseFreq: shiftHz,
        panL: (chip.stereo >> 7) & 1, panR: (chip.stereo >> 3) & 1 });
    }
    out.stereo = chip.stereo;
    return out;
  };

  Emu.SN76489Audio = SN76489Audio;
  Emu.SN76489_VOL_TABLE = VOL_TABLE;
})(window);
