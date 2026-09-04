/*
 * YM2608 (OPNA) 音源エミュレータ — FM 6ch + SSG + 内蔵リズム6ch + ADPCM-B (PC-8801/PC-9801, VGM)
 * MML.Emu.YM2608Audio
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植)の薄いラッパー(ym2610/ym2203と同じ発想)。
 * OPNAのFMはOPN2(YM2612)の元になった設計で、レジスタ配置(0x30-0xB6 両ポート6ch、0x22 LFO、
 * 0x24-0x28 タイマ/ch3モード/キーオン、0xB4-B6 ステレオ/AMS/PMS、SSG-EG)は完全に同一。違いは
 *   (1) ch6 DAC(0x2A/0x2B、YM2612固有)が無い(書込みを弾く)、
 *   (2) SSG(port0 0x00-0x0F)・リズム(port0 0x10-0x1D)・ADPCM-B(port1 0x00-0x10)が挟まる、
 *   (3) プリスケーラ(0x2D-0x2F)がある、
 *   (4) 0x29=IRQ許可+SCH(3ch/6chモード)。実VGM(Snatcher)は冒頭で0x9F(6ch)を書く。
 *       3chモードのゲートは未実装(6chモード前提。3chモード曲はch4-6を書かないので実害なし)。
 * コアは chipType 'ym3438'(ラダー無し、内部加算)。
 *
 * ★プリスケーラ(MAME fm.cpp OPNPrescaler_w、pre_divider=2): sel既定2=1/6。
 *   sel2: FMサンプル=clock/144(コアをマスタークロック毎に1回)、SSG実クロック=clock/4
 *   sel3: FM=clock/72(コア2回)、SSG=clock/2
 *   sel0/1: FM=clock/48(コア3回)、SSG=clock
 *   SSGはAY8910Audioの「実クロックの2倍で叩く」規約に合わせ、1マスタークロックあたり
 *   ssgStep(0.5/1/2)ティックを小数アキュムレータで進める。
 *   PC-88 SB2: 7987200Hz → FM 55.5kHz / SSG 1.9968MHz(YM2203の3.9936MHz/2と同じ実クロック)。
 *
 * ★内蔵リズム: ADPCM-A 6ch(BD/SD/TOP CYM/HH/TOM/RIM)。デコーダ/音量/パンはYM2610の
 *   ADPCM-Aと同一で、サンプルは**チップ内蔵の8KBマスクROM**・アドレス固定(レジスタ無し)。
 *   ym2610.jsの共有クラス Emu.OpnAdpcm.AdpcmA を fixedAddr(MAME fm.cのアドレス表)で流用し、
 *   レジスタは port0 0x10-0x1D → -0x10 でYM2610と同配置(0x00キー/0x01 RTL/0x08-0x0D IL+パン)。
 *   ★ROMデータ(ym2608_adpcm_rom.bin、8192バイト)は著作物のため同梱しない。
 *   Emu.setYm2608RhythmRom(bytes) で外部から与える(main.jsがlocalStorageから復元+
 *   ファイル読込UIを出す)。無ければリズムのみ無音(キーオン検出=鍵盤/ロール表示は動く)。
 *
 * ★ADPCM-B(DELTA-T): YM2610と同じ共有クラス(Emu.OpnAdpcm.AdpcmB)を addrShift=5
 *   (32バイト単位。MAME ymdeltat: YM2608/Y8950=5、YM2610=8)で流用。メモリはVGMデータブロック
 *   0x81(DELTA-T ROM)→ loadRom('b',...)。x1bit DRAM等のメモリタイプ差は未実装(shift5固定)。
 *
 * 表示用サンプルピッチ解析はYM2610の実装(samplePitch等)を Emu.OpnAdpcm.attachSampleApi で
 * そのままprototypeへ移植(kind 'a'=リズムROM、'b'=DELTA-Tメモリ)。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample()(FM+リズム+ADPCM-B。
 * SSGは .ssg をアダプタが別ゲインで加算) / ssg / ssgTickHz / loadRom('b',...) / loadRhythmRom(bytes) /
 * mute[6] / vol[6] / muteAdpcm[7](リズム1-6, B) / volAdpcm[7] / syncMuteVol() / flushWrites() /
 * Emu.snapshotYM2608(chip)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CYCLES_PER_SAMPLE = 144;

  // 内蔵リズムROM上の固定アドレス(inclusive。MAME fm.c YM2608_ADPCM_ROM_addr)
  const RHYTHM_ADDR = [
    { start: 0x0000, end: 0x01BF }, // BD (bass drum)
    { start: 0x01C0, end: 0x043F }, // SD (snare drum)
    { start: 0x0440, end: 0x1B7F }, // TOP (cymbal)
    { start: 0x1B80, end: 0x1CFF }, // HH (hi-hat)
    { start: 0x1D00, end: 0x1F7F }, // TOM (tom tom)
    { start: 0x1F80, end: 0x1FFF }  // RIM (rim shot)
  ];
  Emu.YM2608_RHYTHM_ADDR = RHYTHM_ADDR;

  // 内蔵リズムROM(8192バイト)。著作物のため同梱せず、アプリ側(main.js)がユーザーの
  // ym2608_adpcm_rom.bin を読み込んで設定する。Worker側へは captureVgmSongAsync の
  // opt.ym2608RhythmRom で渡る(workerにlocalStorageは無い)。
  let RHYTHM_ROM = null;
  Emu.setYm2608RhythmRom = function (bytes) {
    RHYTHM_ROM = bytes && bytes.length ? new Uint8Array(bytes) : null;
  };
  Emu.getYm2608RhythmRom = function () { return RHYTHM_ROM; };

  // sel → [fmMult(コアclock回数/マスタークロック), ssgStep(SSGティック数/マスタークロック)]
  // fmMult: FMサンプルレート=clock*fmMult/144。ssgStep=SSG実クロック×2/clock。
  const PRESCALE = [[3, 2], [3, 2], [1, 0.5], [2, 1]];

  class YM2608Audio {
    /**
     * @param {number} [clock=7987200] - マスタークロック(PC-88 SB2/PC-98: 7987200)
     */
    constructor(clock) {
      this.clockHz = clock || 7987200;
      this.core = new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' });
      this.ssg = new Emu.AY8910Audio();
      this.mute = new Array(6).fill(false);
      this.vol = new Array(6).fill(1);
      this.muteAdpcm = new Array(7).fill(false); // 0-5=リズムBD/SD/TOP/HH/TOM/RIM, 6=ADPCM-B
      this.volAdpcm = new Array(7).fill(1);
      this.romA = RHYTHM_ROM;  // リズムROM(attachSampleApiのkind 'a'が読む)
      this.romB = null;        // DELTA-Tメモリ(VGMデータブロック0x81)
      this._pitchCache = new Map();
      this.adpcmA = new Emu.OpnAdpcm.AdpcmA(this, { fixedAddr: RHYTHM_ADDR });
      this.adpcmB = new Emu.OpnAdpcm.AdpcmB(this, { addrShift: 5 });
      this._sel = 2;
      this._applyPrescale();
      this.cyc = 0; this.cycA = 0; this.ssgAcc = 0;
      this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    _applyPrescale() {
      const [fmMult, ssgStep] = PRESCALE[this._sel];
      this.fmMult = fmMult; this.ssgStep = ssgStep;
      // sampleRateはスナップショットの周波数換算とADPCMのレート計算に使う
      // (コアのピッチ自体はclock()の呼び出し回数で決まる)
      this.sampleRate = this.core.sampleRate = this.clockHz * fmMult / CYCLES_PER_SAMPLE;
    }

    /** SSGのclock()呼び出しレート(=AY実クロック×2)。鍵盤スナップショット/抽出器のclock引数用 */
    get ssgTickHz() { return this.clockHz * this.ssgStep; }

    // mute[]/vol[](FM 6ch)をコアの7要素へ写す。DAC(6)は常時ミュート(YM2608に無い)。
    syncMuteVol() {
      const c = this.core;
      c.mute[6] = true;
      for (let i = 0; i < 6; i++) { c.mute[i] = !!this.mute[i]; c.vol[i] = this.vol[i]; }
    }

    reset() {
      this.core.reset(); this.adpcmA.reset(); this.adpcmB.reset();
      this._sel = 2; this._applyPrescale();
      this.cyc = 0; this.cycA = 0; this.ssgAcc = 0; this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    /** 内蔵リズムROM(8192バイト)。ピッチ解析キャッシュも破棄する */
    loadRhythmRom(bytes) {
      this.romA = bytes && bytes.length ? new Uint8Array(bytes) : null;
      this._pitchCache.clear();
    }

    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      if (port === 0) {
        if (reg < 0x10) { this.ssg.writeInternal(reg & 0x0F, val); return; }
        if (reg < 0x1E) { this.adpcmA.write(reg - 0x10, val); return; }  // リズム(YM2610と同配置へ)
        if (reg < 0x20) return;
        if (reg === 0x29) return;                       // IRQ許可+SCH(6chモード前提。冒頭コメント参照)
        if (reg === 0x2A || reg === 0x2B) return;       // YM2612のDAC。YM2608には無い
        if (reg >= 0x2D && reg <= 0x2F) {               // プリスケーラ
          const sel = reg === 0x2D ? (this._sel | 2) : reg === 0x2E ? (this._sel | 1) : 0;
          if (sel !== this._sel) { this._sel = sel; this._applyPrescale(); }
          return;
        }
      } else if (reg <= 0x10) {                          // ADPCM-B(DELTA-T)
        this.adpcmB.write(reg, val); return;
      } else if (reg < 0x30) {
        return;
      }
      this.core.writeReg(port, reg, val);
    }

    clock() {
      for (let k = 0; k < this.fmMult; k++) {
        this.core.clock();
        if (++this.cyc < CYCLES_PER_SAMPLE) continue;
        this.cyc = 0;
        // FMサンプル毎: ADPCM-B。3回に1回: リズム(ADPCM-A。18.5kHz@7.987MHz)
        this.adpcmB.clock();
        if (++this.cycA >= 3) { this.cycA = 0; this.adpcmA.clock(); }
        let l = 0, r = 0;
        const A = this.adpcmA;
        for (let i = 0; i < 6; i++) {
          if (this.muteAdpcm[i] || !A.ch[i].playing) continue;
          const v = A.value(i) * this.volAdpcm[i];
          if (A.panL(i)) l += v;
          if (A.panR(i)) r += v;
        }
        if (!this.muteAdpcm[6] && this.adpcmB.playing) {
          const v = this.adpcmB.value() * this.volAdpcm[6];
          if (this.adpcmB.panL()) l += v;
          if (this.adpcmB.panR()) r += v;
        }
        this.adpcmL = l * Emu.OpnAdpcm.ADPCM_SCALE; this.adpcmR = r * Emu.OpnAdpcm.ADPCM_SCALE;
      }
      this.ssgAcc += this.ssgStep;
      while (this.ssgAcc >= 1) { this.ssgAcc -= 1; this.ssg.clock(); }
    }
    /** FM+リズム+ADPCM-B。SSGはアダプタが this.ssg.mixSample() を別ゲインで足す */
    mixSample() {
      const s = this.core.mixSample();
      return { left: s.left + this.adpcmL, right: s.right + this.adpcmR };
    }
    // 書込みキュー適用(clock()を回さない先読み/シーク経路用)
    flushWrites(collapse) { if (this.core.flushWrites) this.core.flushWrites(collapse); }
  }

  // 表示用サンプルピッチ解析API(loadRom/samplePitch/samplePcm/setSampleTuning/setSampleKind)を
  // YM2610の実装からそのまま移植(this.romA/romB/_pitchCacheしか参照しない)
  Emu.OpnAdpcm.attachSampleApi(YM2608Audio.prototype);

  // 鍵盤表示用スナップショット: FM 6ch(YM2612版そのまま)+リズム(adpcmA[6])+adpcmB。
  // 形は Emu.snapshotYM2610 と同一(キャプチャ/ロール/変換の adpcmA/adpcmB 経路を全部流用する)。
  Emu.snapshotYM2608 = function (chip, opt) {
    const s = Emu.snapshotYM2612(chip.core, opt);
    const A = chip.adpcmA, B = chip.adpcmB;
    const tl = (A.regs[0x01] & 0x3F);
    const adpcmA = [];
    const rateA = chip.sampleRate / 3;
    for (let i = 0; i < 6; i++) {
      const il = A.regs[0x08 + i] & 0x1F;
      const att = (il ^ 0x1F) + (tl ^ 0x3F);
      const vol = att >= 63 ? 0 : Math.max(0, 1 - att / 63);
      const c = A.ch[i];
      const p = c.seq ? chip.samplePitch('a', c.smpStart, c.smpEnd) : null;
      adpcmA.push({ active: c.playing && vol > 0, vol, rawVol: il, rawVolMax: 31, panL: A.panL(i) ? 1 : 0, panR: A.panR(i) ? 1 : 0,
        rate: rateA, seq: c.seq, lenSec: A.lengthSeconds(i),
        pitchHz: p ? p.cps * rateA : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'a', start: c.smpStart, end: c.smpEnd } : null });
    }
    const lvl = B.regs[0x0B];
    const rateB = B.rate();
    const pb = B.seq ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
    const adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
      panL: B.panL() ? 1 : 0, panR: B.panR() ? 1 : 0, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
      pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual), sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
      waveData: pb ? pb.wave : null,
      sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
      refRate: rateA };  // ピッチ解析が通らない時の疑似音程基準(YM2610のNB行と同じ考え方)
    return { channels: s.channels, adpcmA, adpcmB };
  };

  Emu.YM2608Audio = YM2608Audio;
})(window);
