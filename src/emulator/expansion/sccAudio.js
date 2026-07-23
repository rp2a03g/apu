/*
 * Konami SCC/SCC+ 波形メモリ音源エミュレータ
 * MML.Emu.SCCAudio
 *
 * 5ch、各32byte符号付き波形テーブル。classicモード(0x9800-9FFF相当)ではch3/ch4が
 * 波形テーブルを共有し、SCC+モード(0xB800-BFFF相当)ではch4が独立波形を持つ。
 * kssBus.js が sccEnabled/sccPlusEnabled のオーバーレイ判定をした上で
 * readClassic/writeClassic (0x9800起点オフセット) または readPlus/writePlus
 * (0xB800起点オフセット) を呼び出す。内部発振はオーバーレイの有無に関わらず常時動作する
 * (実チップはメモリデコードと無関係に発振し続けるため)。
 *
 * レジスタ配置(オフセットは各ベースアドレスからの相対値):
 *   0x00-0x1F/0x20-0x3F/0x40-0x5F/0x60-0x7F : 波形 ch0-3 (32byte、classicではch3=ch4共有)
 *   0x80-0x89 : 周波数(12bit、ch0-4、各2byte 下位byte+上位nibble)
 *   0x8A-0x8E : 音量(4bit、ch0-4)
 *   0x8F      : 有効ビット(bit0-4、1で発音)
 *   0xA0-0xBF : 波形ch4 (classicは読出専用でch3と同一、SCC+は独立して読み書き可)
 *   0xE0-0xFF(classic) / 0xC0-0xDF(SCC+) : deformレジスタ(周波数レジスタのマスク方式)
 *   0xFE/0xFF(SCC+のみ) : モードレジスタ
 *
 * 周波数式: f = Z80クロック / (32 * (period+1))。period<=8で発振停止(実機の既知の仕様)。
 * 出力: 符号付き8bit波形サンプル × 4bit音量 >> 4。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 5;

  class SCCAudio {
    constructor() {
      this.wave = [];
      for (let i = 0; i < NUM_CH; i++) this.wave.push(new Int8Array(32));
      this.freq = new Uint16Array(NUM_CH);
      this.volume = new Uint8Array(NUM_CH);
      this.enable = 0x1F;
      this.deformClassic = 0;
      this.deformPlus = 0;
      this.modeReg = 0;
      this.counter = new Uint32Array(NUM_CH);
      this.pos = new Uint8Array(NUM_CH);
      this.mute = [false, false, false, false, false];
    }

    reset() {
      for (const w of this.wave) w.fill(0);
      this.freq.fill(0);
      this.volume.fill(0);
      this.enable = 0x1F;
      this.deformClassic = 0;
      this.deformPlus = 0;
      this.modeReg = 0;
      this.counter.fill(0);
      this.pos.fill(0);
    }

    // --- classicモード(0x9800基準オフセット) ---
    readClassic(off) {
      off &= 0x7FF;
      if (off < 0x80) return this.wave[off >> 5][off & 0x1F] & 0xFF;
      if (off <= 0x89) { const ch = (off - 0x80) >> 1; return (off & 1) ? ((this.freq[ch] >> 8) & 0x0F) : (this.freq[ch] & 0xFF); }
      if (off <= 0x8E) return this.volume[off - 0x8A] & 0x0F;
      if (off === 0x8F) return this.enable & 0x1F;
      if (off >= 0xA0 && off <= 0xBF) return this.wave[3][off & 0x1F] & 0xFF; // ch4=ch3共有(読出のみ)
      return 0xFF;
    }

    writeClassic(off, value) {
      off &= 0x7FF;
      value &= 0xFF;
      if (off < 0x80) {
        const ch = off >> 5;
        this.wave[ch][off & 0x1F] = value;
        if (ch === 3) this.wave[4][off & 0x1F] = value; // ch3書込みはch4にも反映(共有波形)
        return;
      }
      if (off <= 0x89) {
        const ch = (off - 0x80) >> 1;
        if (off & 1) this.freq[ch] = (this.freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
        else this.freq[ch] = (this.freq[ch] & 0x0F00) | value;
        return;
      }
      if (off <= 0x8E) { this.volume[off - 0x8A] = value & 0x0F; return; }
      if (off === 0x8F) { this.enable = value & 0x1F; return; }
      if (off >= 0xE0) { this.deformClassic = value; return; }
      // 0xA0-0xBF (ch4波形) はclassicモードでは書込不可
    }

    // --- SCC+モード(0xB800基準オフセット) ---
    readPlus(off) {
      off &= 0x7FF;
      if (off < 0x80) return this.wave[off >> 5][off & 0x1F] & 0xFF;
      if (off <= 0x89) { const ch = (off - 0x80) >> 1; return (off & 1) ? ((this.freq[ch] >> 8) & 0x0F) : (this.freq[ch] & 0xFF); }
      if (off <= 0x8E) return this.volume[off - 0x8A] & 0x0F;
      if (off === 0x8F) return this.enable & 0x1F;
      if (off >= 0xA0 && off <= 0xBF) return this.wave[4][off & 0x1F] & 0xFF; // ch4独立波形
      if (off === 0xFE || off === 0xFF) return this.modeReg;
      return 0xFF;
    }

    writePlus(off, value) {
      off &= 0x7FF;
      value &= 0xFF;
      if (off < 0x80) { this.wave[off >> 5][off & 0x1F] = value; return; }
      if (off <= 0x89) {
        const ch = (off - 0x80) >> 1;
        if (off & 1) this.freq[ch] = (this.freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
        else this.freq[ch] = (this.freq[ch] & 0x0F00) | value;
        return;
      }
      if (off <= 0x8E) { this.volume[off - 0x8A] = value & 0x0F; return; }
      if (off === 0x8F) { this.enable = value & 0x1F; return; }
      if (off >= 0xA0 && off <= 0xBF) { this.wave[4][off & 0x1F] = value; return; }
      if (off >= 0xC0 && off <= 0xDF) { this.deformPlus = value; return; }
      if (off === 0xFE || off === 0xFF) { this.modeReg = value; return; }
    }

    // 1 Z80サイクル分クロック
    // (deformレジスタによる周波数マスクは、実運用でほぼ使われない特殊効果のため
    //  常時ゲームが使う生のfreqレジスタで発振させる。deformレジスタ自体の読み書きは
    //  read/writeClassic・read/writePlus で保持している)
    clock() {
      for (let ch = 0; ch < NUM_CH; ch++) {
        const period = this.freq[ch];
        if (period <= 8) continue; // 実機の既知の仕様: 低周期で発振停止(DC出力)
        this.counter[ch]++;
        if (this.counter[ch] >= period + 1) {
          this.counter[ch] = 0;
          this.pos[ch] = (this.pos[ch] + 1) & 0x1F;
        }
      }
    }

    mixSample() {
      let sum = 0;
      for (let ch = 0; ch < NUM_CH; ch++) {
        if (this.mute[ch]) continue;
        if (!((this.enable >> ch) & 1)) continue;
        const sample = this.wave[ch][this.pos[ch]]; // 符号付き -128..127
        const vol = this.volume[ch];
        sum += (sample * vol) >> 4;
      }
      return sum * (0.2 / 128);
    }
  }

  // 鍵盤表示用スナップショット
  Emu.snapshotSCC = function (chip) {
    const CLOCK = MML.KSS ? MML.KSS.Z80_CLOCK : 3579545;
    const out = [];
    for (let ch = 0; ch < NUM_CH; ch++) {
      const period = chip.freq[ch];
      const enabled = !!((chip.enable >> ch) & 1);
      const freq = period > 8 ? CLOCK / (32 * (period + 1)) : 0;
      const waveData = new Array(32);
      for (let i = 0; i < 32; i++) waveData[i] = chip.wave[ch][i] / 128;
      out.push({
        freq,
        vol: chip.volume[ch] / 15,
        rawVol: chip.volume[ch],
        waveData,
        active: enabled && chip.volume[ch] > 0 && freq > 0
      });
    }
    return out;
  };

  Emu.SCCAudio = SCCAudio;
})(window);
