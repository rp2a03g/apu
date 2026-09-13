/*
 * Sega MultiPCM (315-5560 / YMW-258-F) 28ch PCM 音源 (VGM: chip 'multipcm'。
 * セガ Model 1(Virtua Racing/Virtua Fighter=デュアル構成)/Model 2(Daytona USA/Virtua Cop)/
 * System Multi 32(OutRunners)。Model 1系のリップは音楽全体がMultiPCMに載る)
 * MML.Emu.MultiPCMAudio
 *
 * 8bit符号付きPCM×28スロット、ADSRエンベロープ+TL+4bitパン内蔵。**全サンプルがループ**
 * (ワンショットはEGのディケイで無音化する方式=SPC/YMF278系の設計)。
 * MAME multipcm.cpp(ElSemiコア)準拠:
 *   サンプルレート = clock/180(8MHz → 44444Hz。分周の根拠はコンストラクタのコメント)
 *   ポート(VGMコマンド 0xB5 aa dd、aaのbit7=デュアル2個目):
 *     0=データ / 1=スロット選択(値0-31、7/15/23/31は無効=28ch) / 2=スロットレジスタ選択
 *   スロットレジスタ:
 *     r0=パン(上位4bit、0=中央/1-7=右寄せ/9-15=左寄せ/8=ミュート相当)
 *     r1=サンプル番号下位8bit(書込み時にROM先頭のサンプル表12バイトを読込む)
 *     r2=bit0:サンプル番号bit8、bit2-7:F-number下位6bit
 *     r3=bit0-3:F-number上位4bit、bit4-7:オクターブ(-1バイアス、8以上=負)
 *       再生ステップ = (1024+F)/1024 × 2^oct(F-number線形=OPL系と同じ)
 *     r4=bit7:キーオン(オフセット0からEGアタック開始)/0:キーオフ(リリースへ)
 *     r5=bit1-7:TL(0.375dB/step)、bit0=1:徐々に遷移/0:即時
 *     r6/r7=LFO(ビブラート/トレモロ)…未実装(本実装の割り切り)
 *   サンプル表(ROM先頭、番号×12バイト): +0-2=開始22bit(上位2bit=フォーマット、
 *   12bitサンプルは未実装=セガ系は8bit)、+3-4=ループ点、+5-6=0x10000-終了位置、
 *   +7=LFO、+8=AR/D1R、+9=DL/D2R、+10=KRS/RR、+11=AM
 *   EG: ATTACK→DECAY1→(DLで)DECAY2→(キーオフで)RELEASE。時間はElSemiのBaseTimes表
 *   (アタックms、ディケイ系は×14.32833)、レート=4×値+キースケール(RC≠15のとき2×RC+oct)。
 *   減衰ドメインは線形インデックス0-1023(=0〜-96dBを指数変換)、DLは3dB/段。
 * VGM: ROMはデータブロック0x89(デュアルはサイズbit31)、ヘッダ0x88。
 *   セガバンキング: コマンド **0xC3 cc bb aa**(値=aabb、ccのbit0/bit1=バンク2本、
 *   bit7=デュアル2個目)。アドレス0x100000-0x1FFFFFの窓に対し
 *   物理 = 1MBページ基底(値<<16) + (addr & 0xFFFFF)。bankWrite()のコメント参照。
 *
 * ★ピッチ: F-number/octレジスタで1サンプルを音階演奏(C140系)+全サンプルループなので、
 * 解析は detectCps → 失敗時 SamplePitchUtil.loopCps(ループ因数分解、QSoundで実証)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 28;
  // スロット選択値(0-31)→スロット番号(8個ごとに1つ無効)
  const VALUE_TO_SLOT = [];
  for (let i = 0; i < 32; i++) VALUE_TO_SLOT.push((i & 7) === 7 ? -1 : (i >> 3) * 7 + (i & 7));

  // EG時間表(ElSemi/MAME multipcm: アタックのフルスケール遷移ms。レート0-3は無限=保持)
  // ★値は MAME multipcm.cpp と同じ(BSD-3-Clause, Copyright Miguel Angel Horna)。THIRD-PARTY-NOTICES.md 参照
  const BASE_TIMES_MS = [
    0, 0, 0, 0, 6222.95, 4978.37, 4148.66, 3556.01, 3111.47, 2489.21, 2074.33, 1778.00,
    1555.74, 1244.63, 1037.19, 889.08, 777.87, 622.31, 518.59, 444.54, 388.93, 311.16,
    259.32, 222.27, 194.47, 155.60, 129.66, 111.16, 97.23, 77.82, 64.85, 55.60,
    48.62, 38.91, 32.43, 27.80, 24.31, 19.46, 16.24, 13.92, 12.15, 9.75, 8.12, 6.98,
    6.08, 4.90, 4.08, 3.49, 3.04, 2.49, 2.13, 1.90, 1.72, 1.41, 1.18, 1.04,
    0.91, 0.73, 0.59, 0.50, 0.45, 0.45, 0.45, 0.45];
  const AR2DR = 14.32833; // ディケイ系はアタックの約14.3倍遅い(ElSemi定数)
  const EG_MAX = 1023;    // 線形音量インデックス(1023=0dB、0=-96dB)
  const DB_RANGE = 96;

  // 状態: 0=off, 1=attack, 2=decay1, 3=decay2, 4=release
  const EG_OFF = 0, EG_ATTACK = 1, EG_DECAY1 = 2, EG_DECAY2 = 3, EG_RELEASE = 4;

  class MultiPCMAudio {
    /** @param {number} [clock=8000000] - クロック(サンプルレート=clock/180) */
    constructor(clock) {
      this.clockHz = clock || 8000000;
      // ★分周は180(ElSemi/VGMPlayのMULTIPCM_CLOCKDIV=180系譜。8MHz→44444Hz)。
      //   MAME現行のclock/224だと全サンプルが3/4速+約4半音フラットになる。
      //   OutRunners「Mega Driver」の実盤FLACとのクロマ(調)照合で確定:
      //   ÷180=相関0.998(ピークE一致)/÷224=0.969(調性拡散)/÷224×4/3=0.986(Fへ半音シャープ)。
      //   VGMリップのヘッダクロックは180分周前提で書かれている。
      this.cyclesPerSample = 180;
      this.sampleRate = this.clockHz / 180;
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // '物理start:len' → {cps, conf, …}
      this.reset();
    }
    reset() {
      this.ch = [];
      for (let i = 0; i < NUM_CH; i++) this.ch.push({
        regs: new Uint8Array(8),
        playing: false, pan: 0,
        smpNum: 0, start: 0, loop: 0, end: 0, fmt: 0,
        ar: 0, d1r: 0, dl: 0, d2r: 0, rr: 0, krs: 0,
        pos: 0, frac: 0, step: 0, octSigned: 0,
        tlIdx: 0, tlDestIdx: 0,
        egState: EG_OFF, egVol: 0, egRate: 0, egTarget: 0,
        seq: 0, physStart: 0, smpLen: 0, loopOff: 0, lenSecEst: 0 });
      this.curSlot = 0;
      this.curAddr = 0;
      this.bankL = 0; this.bankR = 0; this.bankPage = 0; this._sawBankR = false;
      this.bankingEnabled = false;
      this.bankFromCommand = false;
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    /** VGMデータブロック 0x89(MultiPCM ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear();
    }
    // ★リップ欠陥の救済(OutRunners等のMulti32): ブート時(ログ開始前)にバンクが設定済みで
    // 0xC3がVGMに1つも無いのに、サンプル表はバンク窓(0x100000-0x1FFFFF)経由のアドレスを指す。
    // トラックごとにバンクが違い(Mega Driver=0x380000/Splash Wave=0x180000等)、ROMデータ
    // ブロックは物理位置に置かれる。「窓が空なら〜」の事前判定はSplash Wave(物理0x180000台=
    // 窓の上半分と重なる位置にデータ)で誤爆したため、**キーオン時の遅延検証**にする:
    // マッピング先が空(先頭2KBが全ゼロ)のとき、データが実在する0x80000境界バンクを
    // 全候補から探して(非ゼロ密度最大)その窓半分に採用する。
    // 本物の0xC3が来た曲(Model 1/2等)は探索しない(空=本当に無音データかもしれないため)。
    _findAutoBank(start, len) {
      const rom = this.rom;
      const off = start & 0xFFFFF; // ページ基底からの相対(A19はアドレス側が供給)
      const density = (page) => {
        if (page + off >= rom.length) return -1;
        let nz = 0;
        const n = Math.min(len, 2048);
        for (let i = 0; i < n; i += 16) if (rom[page + off + i]) nz++;
        return nz;
      };
      let best = -1, bestPage = -1;
      for (let page = 0; page + 0x80000 <= rom.length; page += 0x80000) {
        const d = density(page);
        if (d > best) { best = d; bestPage = page; }
      }
      return best > 8 ? bestPage : -1; // それらしいデータが無ければ諦める
    }
    _autoBankAtKeyon(c) {
      if (this.bankFromCommand || !this.rom || this.rom.length <= 0x200000) return;
      if (c.start < 0x100000 || c.start >= 0x200000) return;
      // 現在のマッピング先にデータがあるなら何もしない
      let nz = 0;
      const n = Math.min(c.smpLen, 2048);
      for (let i = 0; i < n; i += 16) if (this.rom[c.physStart + i]) nz++;
      if (nz > 8) return;
      const page = this._findAutoBank(c.start, c.smpLen);
      if (page < 0) return;
      this.bankPage = page;
      this.bankingEnabled = true;
      c.physStart = this._mapAddr(c.start);
    }

    /*
     * セガバンキング(VGM 0xC3 cc bb aa)。cc の bit0/bit1 で2つのバンク値が来るが、
     * ★実ログでは両者は必ず「同じ1MBページの下半分/上半分」で、別ページを指すことはない
     * (手元コーパス175曲の内訳: cc3=1つの値を両方に 136曲、cc1=X+0x80000 & cc2=X 22曲、
     * cc1=0(=上半分を使わない) & cc2=X 17曲)。したがって窓(0x100000-0x1FFFFF)の写像は
     * **1MBページ基底 + アドレス下位20bit** が正しく、A19(どちらの半分か)はアドレス自身が供給する。
     * MAME/VGMPlay 式の「bit19でL/Rを選び bank|(addr&0x7FFFF)」にすると、cc3(Model 1/2)の曲で
     * 上半分のサンプルが全部下半分へ落ち、別の音が鳴る(Daytona USAで発覚)。
     * 実測: 窓内サンプル1279個のうち写像先にデータがあるのは本方式1279 / 旧方式841。
     * ページ基底は cc bit1(下半分側)の値を採り、bit1が一度も来ていない間だけ bit0 を使う。
     */
    bankWrite(sel, val) {
      const base = (val << 16) >>> 0;
      if (sel & 1) this.bankL = base;
      if (sel & 2) { this.bankR = base; this._sawBankR = true; }
      if ((sel & 2) || !this._sawBankR) this.bankPage = base;
      this.bankingEnabled = true;
      this.bankFromCommand = true; // 本物の0xC3がある曲では遅延自動バンク探索をしない
    }
    // 論理→物理アドレス。★バンキングは0xC3書込みがあった曲だけ有効(VGMPlayのSegaBanking
    // フラグ相当)。サンプルアドレスは22bit=4MB直接参照でき、OutRunners等はバンク無しで
    // 0x100000以上を直に指す。無条件適用するとbank=0の別領域を読んで無音/ゴミになる。
    // 窓は 0x100000-0x1FFFFF の1MBだけ(MAMEの &0x1FFFFF 相当。手元コーパスに
    // 0x200000以上を開始アドレスに持つサンプルは1つも無い)。
    _mapAddr(addr) {
      if (this.bankingEnabled && addr >= 0x100000 && addr < 0x200000) {
        return (this.bankPage + (addr & 0xFFFFF)) >>> 0;
      }
      return addr;
    }
    _read(addr) {
      const a = this._mapAddr(addr >>> 0);
      return this.rom && a < this.rom.length ? this.rom[a] : 0;
    }

    /** ポート書込み(VGM 0xB5 aa dd: aa=0データ/1スロット選択/2レジスタ選択) */
    write(port, val) {
      val &= 0xFF;
      switch (port & 7) {
        case 1: this.curSlot = VALUE_TO_SLOT[val & 0x1F]; break;
        case 2: this.curAddr = Math.min(7, val); break;
        case 0: {
          const i = this.curSlot;
          if (i < 0) break;
          this._writeSlot(this.ch[i], this.curAddr, val);
          break;
        }
      }
    }

    _writeSlot(c, reg, val) {
      c.regs[reg] = val;
      switch (reg) {
        case 0: c.pan = (val >> 4) & 0xF; break;
        case 1: { // サンプル番号下位。★発音中は即時反映しない(MAMEは即時だが、キーオン前の
          // 数サンプル間、旧ノートが新サンプルのアドレス空間を読んでフルスケールのゴミを
          // 出す=Virtua Racingのプチノイズ実測1.1の正体)。キーオン時に regs[1]/regs[2] から
          // 読み直すので、ここでは未発音スロットだけ即時ロード(表示用)。
          if (!c.playing) this._loadSample(c, val | ((c.regs[2] & 1) << 8));
          break;
        }
        case 2: case 3: { // ピッチ: F-number 10bit + oct 4bit(-1バイアス、線形F-number)
          const octRaw = ((c.regs[3] >> 4) - 1) & 0xF;
          c.octSigned = octRaw >= 8 ? octRaw - 16 : octRaw;
          const fnum = ((c.regs[3] & 0xF) << 6) | (c.regs[2] >> 2);
          c.step = (1024 + fnum) / 1024 * Math.pow(2, c.octSigned);
          break;
        }
        case 4: // キーオン/オフ
          if (val & 0x80) {
            this._loadSample(c, c.regs[1] | ((c.regs[2] & 1) << 8)); // サンプル情報はここでラッチ
            c.playing = true;
            c.pos = 0; c.frac = 0;
            c.egState = EG_ATTACK;
            // ★EGは現在レベルからアタック(0リセットすると、リリース途中のスロットへの
            //   再キーオンで振幅が一瞬0へ飛びプチノイズになる)
            c.egRate = this._egStep(c.ar, c, false);
            c.seq++;
            c.physStart = this._mapAddr(c.start);
            this._autoBankAtKeyon(c); // リップ欠陥の救済(マッピング先が空ならバンク探索)
            this._estimateLen(c);
          } else if (c.playing) {
            // RR=0xFも即時停止でなく最速リリース(ElSemi: rate 63=0.45ms)。即時0だと
            // 波形途中でフルスケール級のハードカット=プチノイズになる(Virtua Racing実測1.1)
            c.egState = EG_RELEASE;
            c.egRate = this._egStep(Math.max(1, c.rr), c, true);
          }
          break;
        case 5: { // TL(0.375dB/step)。★bit0=0が「徐々に遷移」、bit0=1が「即時」(MAME準拠。
          // 当初極性を逆にしていて、ドライバのフェード書込み(0xfe等)が即時-47dBカット=
          // フルスケール級プチノイズになっていた。Virtua Racing実測: TLだけをスロット5本へ
          // 一斉書込みするフェード手順)
          c.tlDestIdx = (val >> 1) & 0x7F;
          if (val & 1) c.tlIdx = c.tlDestIdx;
          break;
        }
        // r6/r7: LFO未実装
      }
    }

    _loadSample(c, num) {
      c.smpNum = num;
      const a = num * 12;
      const b = (o) => this._read(a + o);
      c.fmt = (b(0) >> 6) & 3; // 0=8bit(12bitは未実装。セガ系ROMは8bit)
      c.start = ((b(0) << 16) | (b(1) << 8) | b(2)) & 0x3FFFFF;
      c.loop = (b(3) << 8) | b(4);
      c.end = 0xFFFF - ((b(5) << 8) | b(6)); // 格納値は負の長さ(MAME: 0xFFFF - 値。off-by-oneでループ末尾に1バイト余分に入るとユニゾンベースのループ折返しが同時クリック化する)
      c.ar = b(8) >> 4; c.d1r = b(8) & 0xF;
      c.dl = b(9) >> 4; c.d2r = b(9) & 0xF;
      c.krs = b(10) >> 4; c.rr = b(10) & 0xF;
      if (c.end <= 0 || c.end > 0x10000) c.end = 0x10000;
      if (c.loop >= c.end) c.loop = 0;
      c.smpLen = c.end;
      c.loopOff = c.loop;
    }

    // EGレート(4×値+キースケール)→ 1出力サンプルあたりの線形インデックス増分
    _egStep(val, c, decay) {
      if (val <= 0) return 0; // 保持
      const ks = (c.krs === 0xF) ? 0 : Math.max(0, Math.min(15, 2 * c.krs + c.octSigned));
      const r = Math.max(0, Math.min(63, 4 * val + ks));
      let ms = BASE_TIMES_MS[r];
      if (ms <= 0) return 0;
      if (decay) ms *= AR2DR;
      return EG_MAX / (ms / 1000 * this.sampleRate);
    }
    // DL(3dB/段)→線形インデックスの目標値
    _dlTarget(c) {
      const db = c.dl >= 15 ? DB_RANGE : c.dl * 3;
      return Math.max(0, EG_MAX - db * EG_MAX / DB_RANGE);
    }
    // キーオン時のEG可聴時間の見積り(regsOnlyキャプチャの発音区間窓用。
    // 全サンプルループなので「終わり」はEGが決める。D2R=0(保持)ならInfinity)
    _estimateLen(c) {
      // ★Infinity×0=NaNに注意(D1R=0かつDL=0のサステイン音で発生し、キャプチャの
      //   発音窓が f < NaN=false で即死していた)。段ごとに有限性を確認して合算する。
      const t = (val, decay) => {
        const step = this._egStep(val, c, decay);
        return step > 0 ? EG_MAX / step / this.sampleRate : Infinity;
      };
      const dlDb = c.dl >= 15 ? DB_RANGE : c.dl * 3;
      const tA = t(c.ar, false);
      let sec = tA === Infinity ? 0 : tA; // AR保持は_egAdvance側で即時扱いなので0
      if (dlDb > 0) {
        const tD1 = t(c.d1r, true);
        if (tD1 === Infinity) { c.lenSecEst = Infinity; return; } // ディケイ1が進まない=持続
        sec += tD1 * (dlDb / DB_RANGE);
        if (dlDb >= DB_RANGE - 6) { c.lenSecEst = sec; return; } // DLでほぼ無音
      }
      const tD2 = t(c.d2r, true);
      c.lenSecEst = tD2 === Infinity ? Infinity : sec + tD2 * ((DB_RANGE - dlDb) / DB_RANGE);
      // loop=0のワンショットはサンプル終端でも終わる(EG見積りとの短い方)
      if (!c.loop && c.step > 0) {
        const smpSec = c.smpLen / (c.step * this.sampleRate);
        if (smpSec < c.lenSecEst) c.lenSecEst = smpSec;
      }
    }

    _egAdvance(c) {
      switch (c.egState) {
        case EG_ATTACK:
          c.egVol += c.egRate || EG_MAX; // レート0(保持)はアタックだけ即時扱い
          if (c.egVol >= EG_MAX) { c.egVol = EG_MAX; c.egState = EG_DECAY1; c.egRate = this._egStep(c.d1r, c, true); c.egTarget = this._dlTarget(c); }
          break;
        case EG_DECAY1:
          c.egVol -= c.egRate;
          if (c.egVol <= c.egTarget) { c.egVol = c.egTarget; c.egState = EG_DECAY2; c.egRate = this._egStep(c.d2r, c, true); }
          break;
        case EG_DECAY2:
        case EG_RELEASE:
          c.egVol -= c.egRate;
          if (c.egVol <= 0) { c.egVol = 0; c.playing = false; c.egState = EG_OFF; }
          break;
      }
    }
    // 線形インデックス→ゲイン(0〜-96dB指数変換)
    _egGain(c) {
      if (c.egVol >= EG_MAX) return 1;
      if (c.egVol <= 0) return 0;
      return Math.pow(10, -(EG_MAX - c.egVol) * DB_RANGE / EG_MAX / 20);
    }

    _calcSample() {
      let l = 0, r = 0;
      if (this.rom) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.playing) continue;
          // 位置進行。★loopオフセット0は「ループ」ではなく**ワンショット=終端で停止**
          // (OutRunners「Mega Driver」9秒のギターベンドで発覚: loop0のまま先頭へ巻き戻すと
          // 「切れてまた頭から再生」になる。実測: loop0ノートの中央値はキーオフが終端の
          // 少し前(p50 -0.1〜0秒)=ドライバはワンショット自然終了前提で、終端後キーオフも
          // 9%あるが実盤FLACにリスタート音は無い)。loop>0のみ末尾ループ。
          c.frac += c.step;
          const adv = c.frac | 0;
          if (adv) {
            c.frac -= adv;
            c.pos += adv;
            if (c.pos >= c.end) {
              if (!c.loop) { c.playing = false; c.egState = EG_OFF; continue; }
              while (c.pos >= c.end) c.pos -= c.end - c.loop;
            }
          }
          this._egAdvance(c);
          if (!c.playing) continue;
          // TL補間(MAME: 減衰減少=音量上げは78.2ms/フルレンジ、増加=下げは156.4ms)
          if (c.tlIdx !== c.tlDestIdx) {
            if (c.tlIdx > c.tlDestIdx) {
              c.tlIdx = Math.max(c.tlDestIdx, c.tlIdx - 128 / (0.0782 * this.sampleRate));
            } else {
              c.tlIdx = Math.min(c.tlDestIdx, c.tlIdx + 128 / (0.1564 * this.sampleRate));
            }
          }
          if (this.mute[i]) continue;
          const s0 = ((this._read(c.start + c.pos) << 24) >> 24);
          const s1 = ((this._read(c.start + (c.pos + 1 >= c.end ? c.loop : c.pos + 1)) << 24) >> 24);
          const s = (s0 + (s1 - s0) * c.frac) * 256; // 線形補間(MAME準拠)
          const g = this._egGain(c) * Math.pow(10, -c.tlIdx * 0.375 / 20) * this.vol[i];
          // パン: 0=中央、1-7=右寄せ(左を3dB/段減衰)、9-15=左寄せ、8=両ミュート相当
          const p = c.pan >= 8 ? c.pan - 16 : c.pan;
          const attL = p > 0 ? Math.pow(10, -p * 3 / 20) : (p === -8 ? 0 : 1);
          const attR = p < 0 ? Math.pow(10, p * 3 / 20) : 1;
          l += s * g * attL;
          r += s * g * attR;
        }
      }
      // 1chフルスケール≒32767。28ch合算を±1.0程度へ(実曲の同時発音を考慮した経験値)
      this.lastL = l / (32768 * 3);
      this.lastR = r / (32768 * 3);
    }

    clock() {
      if (++this.cyc < this.cyclesPerSample) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** 再生レート(1秒あたりのサンプルバイト数) */
    playRate(i) { return this.ch[i].step * this.sampleRate; }

    /** サンプル(物理[start,end)、ループ点=startからのオフセットloopOff)の基本周期解析
     *  (キャッシュ)。他チップと同じ(kind,start,end)署名=手動キャリブレーション互換。
     *  全サンプルループなので detectCps 失敗時は loopCps(ループ因数分解)へ。 */
    samplePitch(kind, start, end, loopOff) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const len = end - start;
      const pcm = this._decodeSample(start, end);
      let auto = U.detectCps(pcm);
      let wavePcm = pcm;
      if (auto.conf < 0.5 && loopOff > 0 && loopOff < len && (len - loopOff) >= 16 && (len - loopOff) <= 16384) {
        const one = this._decodeSample(start + loopOff, end);
        const r2 = U.loopCps(one);
        if (r2) { auto = r2; wavePcm = one; }
      }
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, wave: null,
        lenBytes: pcm.length,
        hash: U.sampleHash(this.rom, start, Math.min(end, start + 64 * 1024)) };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      // 打楽器/音階の手動上書きをconfへ反映(Emu.SamplePitchUtil。ロール/鍵盤/変換の
      // 4箇所がこの1点で追随する)。キャッシュへ入れる前に適用する
      Emu.SamplePitchUtil.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(start, end) {
      const rom = this.rom;
      const n = Math.max(0, Math.min(end - start, 64 * 1024, rom.length - start));
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = ((rom[start + i] << 24) >> 24) / 128;
      return pcm;
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.start, sample.end);
    }

    /** 手動ピッチ補正(表示専用)。他チップと同じlocalStorage永続化。 */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const U = Emu.SamplePitchUtil;
      const map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      U.saveTuningMap(map);
      r.wave = U.makeSampleWave(this._decodeSample(start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }
  }

  // 鍵盤表示用スナップショット(配列28要素、C352/QSoundと同じ3段階表示向け):
  // { active, vol(EG×TL)、rawVol、panL/panR(0-15)、rate、seq、loop(常にtrue=Infinity側は
  //   lenSecEstで判定)、lenSec(EG見積り)、pitchHz、pitchConf、pitchManual、waveData、sample }
  Emu.snapshotMultiPCM = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const rate = chip.playRate(i);
      // ライブはEG実値、regsOnlyキャプチャはEGが回らない(egVol=0のまま)のでTLのみで表示
      // regsOnlyキャプチャ(EGが回らない=egVolが0のまま)はエンベロープ1扱い。
      // ライブは実EGレベルをそのまま使う(★以前は床値0.05を敷いていて、リリース済み/
      // ほぼ無音のスロットまで常時アクティブ=鍵盤の同時発光行が28本に張り付き、
      // 描画負荷で表示/音声が追い付かなくなっていた。OutRunnersで発覚)。
      // TLはランプ途中値でなく目標値(tlDestIdx)を表示する(regsOnlyではランプが
      // 進まないため。78-156msの遷移は表示粒度では無視してよい)。
      const egG = c.egState === EG_ATTACK && c.egVol === 0 ? 1 : chip._egGain(c);
      const tlG = Math.pow(10, -c.tlDestIdx * 0.375 / 20);
      const vol = Math.min(1, (c.playing ? egG : 0) * tlG);
      const p = c.seq ? chip.samplePitch('multipcm', c.physStart, c.physStart + c.smpLen, c.loopOff) : null;
      const pan = c.pan >= 8 ? c.pan - 16 : c.pan;
      out.push({ active: c.playing && vol > 0.01 && rate > 0, vol, rawVol: Math.round(vol * 255), rawVolMax: 255,
        panL: pan > 0 ? Math.max(0, 15 - pan * 2) : 15, panR: pan < 0 ? Math.max(0, 15 + pan * 2) : 15,
        rate, seq: c.seq, loop: c.lenSecEst === Infinity, lenSec: c.lenSecEst,
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'multipcm', start: c.physStart, end: c.physStart + c.smpLen } : null });
    }
    return out;
  };

  Emu.MultiPCMAudio = MultiPCMAudio;

  // ───────────────────────────────────────────────────────────────────────
  // チャンネルプール式ドライバの割当逆算(ソフトウェアチャンネル合成)
  //
  // セガ系ドライバはスロットを共有プールとして扱い、ノートオンごとに次の空きスロットへ
  // 巡回割当する(実測: 発音行がPCM1→28へ行進)。物理スロット表示は実機に忠実だが、
  // 1本のメロディが行をまたいで散り、鍵盤/ロール/MML変換の可読性が壊れる。
  // このクラスはスナップショット列(フレーム×スロット)を受け取り、
  // 「音色(サンプル同定)が同じ・時間的に連続・音程が近い」ノートを同じ論理チャンネルへ
  // 束ね直した同型のスナップショット列を返す(=下流の鍵盤/ロール/変換がそのまま使える)。
  //
  // 使い方: フレームごとに step(physSnap) → 論理スナップショット(同じ形の配列)。
  // ライブ(rAF駆動)とキャプチャ(フレーム駆動)の両方から同じ実装を使う。
  // 割当規則:
  //  1) 発音中のノート(スロットi×キーオン通番seq)は同じ論理レーンに固定
  //  2) 新しいノートは「同じ音色のレーンのうち、空いていて音程が近く直近に使ったもの」
  //  3) 無ければ未使用レーン、それも無ければ最も昔に使ったレーンを奪う
  Emu.PoolChannelRegrouper = class {
    constructor(numCh) {
      this.numCh = numCh;
      this.lanes = [];
      for (let i = 0; i < numCh; i++) this.lanes.push({
        instKey: null, boundSlot: -1, boundSeq: -1, lastStep: -1e9, lastMidi: 0, outSeq: 0 });
      this.stepCount = 0;
      this._idle = { active: false, vol: 0, rawVol: 0, rawVolMax: 255, panL: 15, panR: 15,
        rate: 0, seq: 0, loop: false, lenSec: 0, pitchHz: 0, pitchConf: 0, pitchManual: false,
        waveData: null, sample: null };
    }
    step(snap) {
      this.stepCount++;
      const lanes = this.lanes;
      const out = new Array(this.numCh);
      const slotLane = new Array(snap.length).fill(-1);
      // 1) 既存バインドの継続判定
      for (let li = 0; li < lanes.length; li++) {
        const L = lanes[li];
        if (L.boundSlot < 0) continue;
        const c = snap[L.boundSlot];
        if (c && c.active && c.seq === L.boundSeq) {
          slotLane[L.boundSlot] = li;
        } else {
          if (c && c.pitchHz > 0) L.lastMidi = 69 + 12 * Math.log2(c.pitchHz / 440);
          L.lastStep = this.stepCount;
          L.boundSlot = -1; L.boundSeq = -1;
        }
      }
      // 2) 新規ノートの割当
      for (let s = 0; s < snap.length; s++) {
        const c = snap[s];
        if (!c || !c.active || slotLane[s] >= 0) continue;
        const instKey = c.sample ? (c.sample.start + ':' + c.sample.end) : 'x';
        const midi = c.pitchHz > 0 ? 69 + 12 * Math.log2(c.pitchHz / 440) : null;
        let best = -1, bestScore = -Infinity;
        let firstUnused = -1, oldest = -1, oldestStep = Infinity;
        for (let li = 0; li < lanes.length; li++) {
          const L = lanes[li];
          if (L.boundSlot >= 0) continue; // 発音中レーンは奪わない
          if (L.instKey === null) { if (firstUnused < 0) firstUnused = li; continue; }
          if (L.lastStep < oldestStep) { oldestStep = L.lastStep; oldest = li; }
          if (L.instKey !== instKey) continue;
          // 同音色: 直近使用ほど・音程が近いほど高得点(メロディの連続性を優先)
          const recency = -(this.stepCount - L.lastStep) * 0.05;
          const pitchDist = (midi !== null && L.lastMidi) ? -Math.abs(midi - L.lastMidi) : 0;
          const score = recency + pitchDist;
          if (score > bestScore) { bestScore = score; best = li; }
        }
        // マルチサンプル楽器(音程ごとに別サンプル=Outfoxiesのコーラス等)対策:
        // 同音色レーンが無くても、直近(30ステップ≒0.5秒)に空いたレーンで音程が近ければ
        // 同じ楽器の続きとみなして引き継ぐ(音程なしノート=ドラムは対象外なので
        // ドラムがメロディレーンへ混ざることはない)
        if (best < 0 && midi !== null) {
          let jScore = -Infinity;
          for (let li2 = 0; li2 < lanes.length; li2++) {
            const L2 = lanes[li2];
            if (L2.boundSlot >= 0 || L2.instKey === null || !L2.lastMidi) continue;
            const age = this.stepCount - L2.lastStep;
            if (age > 30) continue;
            const d = Math.abs(midi - L2.lastMidi);
            if (d > 7) continue;
            const sc = -age * 0.1 - d;
            if (sc > jScore) { jScore = sc; best = li2; }
          }
        }
        const li = best >= 0 ? best : (firstUnused >= 0 ? firstUnused : oldest);
        if (li < 0) continue; // 全レーン発音中(スロット数=レーン数なので通常起きない)
        const L = lanes[li];
        L.instKey = instKey;
        L.boundSlot = s; L.boundSeq = c.seq;
        if (midi !== null) L.lastMidi = midi;
        L.outSeq++;
        slotLane[s] = li;
      }
      // 3) 出力(論理seq=レーン内通番。ロールのリトリガー検出が正しく効くように)
      for (let li = 0; li < lanes.length; li++) {
        const L = lanes[li];
        if (L.boundSlot >= 0) {
          const c = snap[L.boundSlot];
          out[li] = Object.assign({}, c, { seq: L.outSeq });
        } else {
          out[li] = Object.assign({}, this._idle, { seq: L.outSeq });
        }
      }
      return out;
    }
  };
})(window);
