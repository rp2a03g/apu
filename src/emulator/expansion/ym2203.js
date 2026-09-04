/*
 * YM2203 (OPN) 音源エミュレータ — FM 3ch + SSG(AY-3-8910互換 3ch) (PC-8801/PC-9801/アーケード, VGM)
 * MML.Emu.YM2203Audio
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植)の薄いラッパー(ym2610.jsと同じ発想)。
 * YM2203のFMレジスタ配置はYM2612のポート0と同一(0x30 DT/MUL … 0xB0-0xB2 FB/AL、0x24-0x27
 * タイマ/ch3モード、0x28 キーオン(値0-2)、0x90 SSG-EG、周波数式も同じ)で、違いは
 *   (1) チャンネルが3本だけ(ポート1が無い。コアのch3-5は常時ミュート)、
 *   (2) LFO(0x22)・ステレオ/AMS/PMS(0xB4-0xB6)・DAC(0x2A/0x2B)が存在しない(書込みを弾く。
 *       コアはreset()でpan L/R=1にするので、0xB4を一切書かなければ常に両ch出力=モノラルで正しい)、
 *   (3) プリスケーラ(0x2D/0x2E/0x2F)がある(下記)、
 * の3点だけ。コアは chipType 'ym3438'(ラダー無し、内部加算)で使う(OPN/OPNAはYM2612固有の
 * 9bit DACラダー効果を持たない)。
 *
 * ★プリスケーラ(MAME fm.cpp OPNPrescaler_w と同じ意味論):
 *   sel(2bit、リセット時2=1/6)を 0x2D で |=2、0x2E で |=1、0x2F で =0 に更新し、
 *     sel 0/1: FM=クロック/2(サンプルレート=clock/24)、SSG実クロック=clock×2
 *     sel 2  : FM=クロック/6(=clock/72、既定)、        SSG実クロック=clock/2
 *     sel 3  : FM=クロック/3(=clock/36)、              SSG実クロック=clock
 *   本クラスの clock() はマスタークロック毎に1回呼ばれ、内部でコアを fmMult回
 *   (=12/プリスケーラ: 2/4/6回)、SSGを ssgMult回(=SSG実クロック×2/クロック: 1/2/4回、
 *   AY8910Audioは「実クロックの2倍で叩く」既存規約)回す。全selで整数倍になるので誤差なし。
 *   コアの sampleRate はスナップショットの周波数換算にだけ使われるので直接書き換えて追随させる。
 *   ★実曲でも使われる: Avengers(カプコン、2xYM2203@1.5MHz)は 0x2D→0x2E で 1/3 を選ぶ。
 *
 * SSG部は Emu.AY8910Audio をそのまま内蔵する(YM2610のSSGと同じ流用。音色・エンベロープとも
 * AY-3-8910互換)。レジスタ0x00-0x0Fへの書込みは writeReg() が内部で振り分ける。
 * ミックスはアダプタ側(vgmPlayer.js)が FM と SSG を別ゲインで足す(chip.ssg を直接読む)。
 *
 * 外部I/F: writeReg(reg,val) / clock()(マスタークロック毎) / mixSample()(FMのみ) /
 * ssg(AY8910Audio) / ssgTickHz(SSGのclock()呼び出しレート=実クロック×2。表示用) /
 * mute[3] / vol[3](書き換えたら syncMuteVol()) / core / flushWrites() / Emu.snapshotYM2203(chip)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // sel → [fmMult(コアclock回数/マスタークロック), ssgMult(SSG clock回数/マスタークロック)]
  // fmMult = 12/プリスケーラ。コアは内部で/144するので サンプルレート=clock*fmMult/144=clock/(12*pres)
  const PRESCALE = [[6, 4], [6, 4], [2, 1], [4, 2]];

  class YM2203Audio {
    /**
     * @param {number} [clock=3993600] - マスタークロック(PC-88: 3993600 / アーケード: 3000000-4000000)
     */
    constructor(clock) {
      this.clockHz = clock || 3993600;
      this.mute = new Array(3).fill(false);
      this.vol = new Array(3).fill(1);
      this.ssg = new Emu.AY8910Audio();
      this._sel = 2; // プリスケーラ選択(リセット時 1/6)
      this._makeCore();
      this.syncMuteVol();
    }

    _makeCore() {
      const [fmMult, ssgMult] = PRESCALE[this._sel];
      this.fmMult = fmMult; this.ssgMult = ssgMult;
      if (!this.core) this.core = new Emu.YM2612Nuked(this.clockHz * fmMult, { chipType: 'ym3438' });
      // スナップショットの周波数換算用(コアのピッチ自体はclock()の呼び出し回数で決まる)
      this.core.sampleRate = this.clockHz * fmMult / 144;
    }

    /** SSGのclock()呼び出しレート(=AY実クロック×2)。鍵盤スナップショット/抽出器のclock引数用 */
    get ssgTickHz() { return this.clockHz * this.ssgMult; }

    // mute[]/vol[](3ch)をコアの7要素へ写す。ch3-5(存在しない)とDAC(6)は常時ミュート。
    syncMuteVol() {
      const c = this.core;
      for (let i = 0; i < 7; i++) c.mute[i] = true;
      for (let i = 0; i < 3; i++) { c.mute[i] = !!this.mute[i]; c.vol[i] = this.vol[i]; }
    }

    reset() {
      this.core.reset();
      this._sel = 2;
      this._makeCore();
      this.syncMuteVol();
    }

    /** レジスタ書込み(1ポート)。SSG領域(0x00-0x0F)は内蔵AYへ振り分ける。 */
    writeReg(reg, val) {
      reg &= 0xFF; val &= 0xFF;
      if (reg < 0x10) { this.ssg.writeInternal(reg & 0x0F, val); return; }
      if (reg === 0x22 || reg === 0x2A || reg === 0x2B) return; // LFO/DACはYM2203に無い
      if (reg >= 0x2D && reg <= 0x2F) { // プリスケーラ
        const sel = reg === 0x2D ? (this._sel | 2) : reg === 0x2E ? (this._sel | 1) : 0;
        if (sel !== this._sel) { this._sel = sel; this._makeCore(); }
        return;
      }
      if (reg >= 0xB4 && reg < 0xC0) return; // ステレオ/AMS/PMS無し(panを落とされないよう弾く)
      this.core.writeReg(0, reg, val);
    }

    clock() {
      for (let i = 0; i < this.fmMult; i++) this.core.clock();
      for (let i = 0; i < this.ssgMult; i++) this.ssg.clock();
    }
    /** FM部のみ。SSGはアダプタが this.ssg.mixSample() を別ゲインで足す */
    mixSample() { return this.core.mixSample(); }
    // 書込みキュー適用(clock()を回さない先読み/シーク経路用)
    flushWrites(collapse) { if (this.core.flushWrites) this.core.flushWrites(collapse); }
  }

  // 鍵盤表示用スナップショット: YM2612版の6chから実チャンネル(0-2)を抜き出す(形は同じ)。
  // SSGは Emu.snapshotAY8910(chip.ssg, chip.ssgTickHz) を呼び出し側が別途使う。
  Emu.snapshotYM2203 = function (chip, opt) {
    const s = Emu.snapshotYM2612(chip.core, opt);
    return { channels: s.channels.slice(0, 3) };
  };

  Emu.YM2203Audio = YM2203Audio;
})(window);
