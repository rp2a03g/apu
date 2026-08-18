/*
 * Ricoh RF5C68 / RF5C164 8ch PCM 音源 (VGM: chip 'rf5c68'(X68000/FM TOWNS等) / 'rf5c164'(メガCD))
 * MML.Emu.RF5C164Audio
 *
 * 64KBの波形RAMを 8ch が独立したアドレス/ステップ(16bit、0x0800=等速)で読み出す PCM 音源。
 * サンプルは符号+絶対値の8bit(bit7=符号、0xFF=ループマーカー)。ch毎に音量(8bit)とパン
 * (左右各4bit)。サンプルレート = clock/384(RF5C164@12.5MHz≒32552Hz、RF5C68@8MHz≒20833Hz)。
 * レジスタ(0x00-0x08、書込み先chはreg7で選択):
 *   0 音量 / 1 パン(下位=左,上位=右) / 2,3 ステップ(FDL,FDH) / 4,5 ループ先頭(LSL,LSH) /
 *   6 スタート(上位8bit) / 7 制御(bit7=1動作,bit6=1: bit0-2=ch選択, bit6=0: bit0-3=波形バンク(4KB窓)) /
 *   8 chオン/オフ(bit n=1でchオフ、オフ→オンでスタート位置から再生)
 * 波形RAMへの書込み: VGM 0xC1/0xC2 aaaa dd = 選択中バンク(4KB窓)内オフセット、
 *   データブロック 0xC0/0xC1 = 絶対アドレス(先頭2バイト)+データ。
 * 挙動は MAME rf5c68.cpp と同じ: addr(16.11固定小数)の整数部でRAMを読み、0xFFなら
 *   ループ先頭へ戻して読み直す(それも0xFFならそのchは無音)。出力=(sample&0x7F)*音量*パン>>5。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 8;
  const CYCLES_PER_SAMPLE = 384;

  class RF5C164Audio {
    /**
     * @param {number} [clock=12500000]
     */
    constructor(clock) {
      this.clockHz = clock || 12500000;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this.reset();
    }
    reset() {
      this.ram = new Uint8Array(0x10000);
      this.ch = [];
      for (let i = 0; i < NUM_CH; i++) this.ch.push({ enable: false, env: 0, pan: 0, step: 0, loopst: 0, start: 0, addr: 0 });
      this.enable = false; this.cbank = 0; this.wbank = 0;
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    /** レジスタ書込み(VGM 0xB0/0xB1 aa dd) */
    write(reg, data) {
      data &= 0xFF;
      const c = this.ch[this.cbank];
      switch (reg & 0x0F) {
        case 0x00: c.env = data; break;
        case 0x01: c.pan = data; break;
        case 0x02: c.step = (c.step & 0xFF00) | data; break;
        case 0x03: c.step = (c.step & 0x00FF) | (data << 8); break;
        case 0x04: c.loopst = (c.loopst & 0xFF00) | data; break;
        case 0x05: c.loopst = (c.loopst & 0x00FF) | (data << 8); break;
        case 0x06: c.start = data; break;
        case 0x07:
          this.enable = !!(data & 0x80);
          if (data & 0x40) this.cbank = data & 0x07; else this.wbank = data & 0x0F;
          break;
        case 0x08:
          for (let i = 0; i < NUM_CH; i++) {
            const ch = this.ch[i];
            const on = !(data & (1 << i));
            if (on && !ch.enable) ch.addr = ch.start << (8 + 11); // オフ→オン: スタート位置から
            ch.enable = on;
          }
          break;
        default: break;
      }
    }
    /** 波形RAM書込み(VGM 0xC1/0xC2 aaaa dd: 選択中バンクの4KB窓内オフセット) */
    memWrite(offset, data) {
      this.ram[((this.wbank << 12) | (offset & 0x0FFF)) & 0xFFFF] = data & 0xFF;
    }
    /** 波形RAMへの絶対アドレス書込み(データブロック 0xC0/0xC1) */
    ramWrite(start, bytes) {
      for (let i = 0; i < bytes.length && start + i < 0x10000; i++) this.ram[start + i] = bytes[i];
    }

    _calcSample() {
      let l = 0, r = 0;
      if (this.enable) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.enable) continue;
          const lv = c.env * (c.pan & 0x0F);
          const rv = c.env * (c.pan >> 4);
          let sample = this.ram[(c.addr >> 11) & 0xFFFF];
          if (sample === 0xFF) {
            c.addr = c.loopst << 11;
            sample = this.ram[(c.addr >> 11) & 0xFFFF];
            if (sample === 0xFF) continue; // ループ先頭もマーカー: 無音
          }
          c.addr = (c.addr + c.step) & 0x7FFFFFF; // 16.11
          if (this.mute[i]) continue;
          const mag = sample & 0x7F;
          const sgn = (sample & 0x80) ? 1 : -1;
          l += sgn * ((mag * lv) >> 5) * this.vol[i];
          r += sgn * ((mag * rv) >> 5) * this.vol[i];
        }
      }
      // 1chフルスケール = 127*255*15>>5 ≒ 15176。8ch合算を±1.0程度へ
      this.lastL = l / 32768;
      this.lastR = r / 32768;
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }
  }

  // 鍵盤表示用スナップショット: ch毎の音量(env×パン)、再生レート、活性
  Emu.snapshotRF5C164 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const panL = c.pan & 0x0F, panR = c.pan >> 4;
      const gain = (c.env / 255) * Math.max(panL, panR) / 15;
      const rate = c.step / 2048 * chip.sampleRate; // 再生サンプルレート(Hz)
      const active = chip.enable && c.enable && c.env > 0 && (panL | panR) !== 0 && c.step > 0;
      out.push({ vol: gain, rawVol: c.env, active, panL, panR, rate, step: c.step, start: c.start, addr: c.addr >> 11 });
    }
    return out;
  };

  Emu.RF5C164Audio = RF5C164Audio;
})(window);
