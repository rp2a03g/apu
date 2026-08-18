/*
 * YM2610 (OPNB) FM音源エミュレータ — FM部のみ (Neo Geo / VGM)
 * MML.Emu.YM2610Audio
 *
 * YM2610は SSG(AY-3-8910互換,3ch) + FM(4ch) + ADPCM-A(6ch) + ADPCM-B(1ch) を1チップに
 * 内蔵する。このファイルはFM部のみを扱う(SSGはEmu.AY8910Audioをそのまま再利用、
 * ADPCM-A/Bは未実装=段階2)。VGM上は 0x58(ポート0)/0x59(ポート1) のレジスタ書込みで
 * まとめて叩かれるので、SSG/FMの振り分けは呼び出し側(vgmPlayer.js)が行う。
 *
 * ★実装は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植 または ym2612.js=高速近似)の薄いラッパー。
 * 理由: YM2610のFMレジスタ配置はYM2612と完全に同一(0x30 DT/MUL … 0xB4 L/R/AMS/PMS、0x22 LFO、
 * 0x27 ch3モード、0x28 キーオン、サンプルレート=clock/144、周波数式も同じ)で、違いは
 *   (1) 6chぶんのアドレス空間のうち実チャンネルが各ポートのオフセット1,2だけ
 *       (オフセット0,3は結線されていないダミー。ymfm(aaronsgiles/ymfm, BSD-3)の
 *       ym2610 channel_mask=0x36=YM2612番号でch1,2,4,5 と一致)、
 *   (2) ch6 DAC(0x2A/0x2B、YM2612固有)が無い、
 *   (3) SSG/ADPCM-A/ADPCM-Bのレジスタ領域(port0 0x00-0x1F, port1 0x00-0x2F)が挟まる、
 * の3点だけなので、YM2612コアを6chのまま動かしてch0/ch3/DACを常時ミュートし、
 * 該当領域の書込みを弾くだけで済む。ch3特殊モード(0x27上位ビット、YM2612のch3=port0
 * オフセット2=YM2610のFM2に相当。MAME fm.cppのym2610もCH[2]に適用)もそのまま効く。
 * キーオン0x28の値1,2,5,6 → YM2612コアのch1,2,4,5 = 本クラスのFM1-4。
 *
 * コアの選択は makeYm2612Adapter(vgmPlayer.js)と同じ Emu.ym2612CorePref: 既定=Nuked-OPN2
 * (実機準拠)、'fast'=高速近似。Nukedは chipType:'ym3438' で使う: FMオペレータ本体(PG/EG/
 * log-sin・exp ROM/LFO/SSG-EG)はOPNファミリ共通設計だが、YM2612固有の9bit DACラダー効果は
 * YM2610には無い(OPNA/OPNBは内部加算して16bit出力)ため、ラダー無しモードが正しい。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample() /
 * mute[4] / vol[4](書き換えたら syncMuteVol() を呼ぶ) / core(選択されたコア) / coreName /
 * Emu.snapshotYM2610(chip)。Neo Geo: 8000000Hz → 55555Hz。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 4;
  const CORE_CH = [1, 2, 4, 5]; // 本クラスのFM1-4 → YM2612コア(6ch)上のチャンネル番号

  class YM2610Audio {
    /**
     * @param {number} [clock=8000000] - マスタークロック(サンプルレート=clock/144)
     * @param {{core?: 'nuked'|'fast'}} [opts] - 省略時は Emu.ym2612CorePref('fast' 以外=Nuked)
     */
    constructor(clock, opts) {
      this.clockHz = clock || 8000000;
      const pref = (opts && opts.core) || Emu.ym2612CorePref;
      const useNuked = pref !== 'fast' && !!Emu.YM2612Nuked;
      this.coreName = useNuked ? 'nuked' : 'fast';
      this.core = useNuked ? new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' }) : new Emu.YM2612Audio(this.clockHz);
      this.sampleRate = this.core.sampleRate;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this.syncMuteVol();
    }

    // mute[]/vol[](4要素)をコアの6要素へ写す。ダミーch0/ch3とDAC(6)は常時ミュート。
    syncMuteVol() {
      const c = this.core;
      c.mute[0] = c.mute[3] = c.mute[6] = true;
      for (let i = 0; i < NUM_CH; i++) { c.mute[CORE_CH[i]] = !!this.mute[i]; c.vol[CORE_CH[i]] = this.vol[i]; }
    }

    reset() { this.core.reset(); this.syncMuteVol(); }

    // レジスタ書込み(port 0/1)。FM以外の領域は無視する(SSGは呼び出し側がAY8910Audioへ
    // 振り分ける前提だが、渡ってきても無害)。
    writeReg(port, reg, val) {
      reg &= 0xFF;
      if (port === 0 && reg < 0x20) return;                    // SSG(0x00-0x0F) / ADPCM-B(0x10-0x1C)
      if (port === 0 && (reg === 0x2A || reg === 0x2B)) return; // YM2612のDAC。YM2610には無い
      if (port === 1 && reg < 0x30) return;                    // ADPCM-A
      this.core.writeReg(port, reg, val);
    }

    clock() { this.core.clock(); }
    mixSample() { return this.core.mixSample(); }
    // Nukedコアの書込みキュー適用(clock()を回さない先読み/シーク経路用。高速コアでは不要)
    flushWrites() { if (this.core.flushWrites) this.core.flushWrites(); }
  }

  // 鍵盤表示用スナップショット: YM2612版の6chから実チャンネル4本を抜き出す(形は同じ)
  Emu.snapshotYM2610 = function (chip) {
    const s = Emu.snapshotYM2612(chip.core);
    return { channels: CORE_CH.map(i => s.channels[i]) };
  };

  Emu.YM2610Audio = YM2610Audio;
})(window);
