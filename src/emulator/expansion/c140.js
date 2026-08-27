/*
 * Namco C140 24ch PCM 音源 (VGM: chip 'c140'。ナムコ System 2/21 でYM2151とペア。
 * Assault / Dragon Saber / Burning Force / Metal Hawk / Starblade 等)
 * MML.Emu.C140Audio
 *
 * 8bit符号付き または 8bit μ-law(モードbit3)のPCM×24ch、ステレオ(ch毎L/R 8bit音量)。
 * 出力レート = clock/576(System 2: 12.288MHz → 21333Hz。旧VGMがレート直値(~21390)を
 * 入れている場合はそのまま使う)。挙動は MAME c140.cpp 準拠:
 *   レジスタ 0x000-0x1FF、chベース=ch*16:
 *     +0 音量R / +1 音量L(順序注意: RightがLeftより先) / +2/+3 周波数(16bit。
 *     1出力サンプルごとに16bit小数アカムへ加算=再生レート fs*freq/65536 バイト/秒) /
 *     +4 バンク / +5 モード(bit7=キーオン、bit4=ループ、bit3=μ-law) /
 *     +6/+7 開始 / +8/+9 終了 / +10/+11 ループ(いずれも16bitバイトアドレス)
 *   キーオン(+5書込み bit7=1)でバンク/モード/開始/終了/ループをラッチし pos=0 から再生。
 *   bit7=0書込みで即キーオフ。終端でループ無効なら自動キーオフ。
 *   バンキング(find_sample、adrs=(bank<<16)+アドレス):
 *     System 2 : ((adrs & 0x200000) >> 2) | (adrs & 0x7ffff)
 *     System 21: ((adrs & 0x300000) >> 1) | (adrs & 0x7ffff)
 *     C219(NA-1/2): (REG[{0x1f7,0x1f1,0x1f3,0x1f5}[voice/4]] & 3) * 0x20000 + (adrs & 0x1ffff)
 *       (C219はノイズ/反転等の追加モードを持つが未実装=ベストエフォート。手元の
 *        System 2/21 のVGMが主対象)
 * VGM: コマンド 0xD4 pp aa dd(レジスタ=ppaa、ppのbit7=デュアル2個目)、
 * ROMはデータブロック0x8D、チップタイプはヘッダ0x96(0=System2, 1=System21, 2=C219)。
 *
 * ★周波数レジスタで1サンプルを音階演奏するチップ(GA20/SegaPCMと同性質)なので、
 * ピッチは Emu.SamplePitchUtil(ym2610.js共有)で得る。System 2の曲はメロディも
 * C140で弾くことが多く、周波数レジスタのピッチベンドも rate 経由で snapshot に反映される。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 24;

  // μ-law展開表(libvgm c140.c準拠=superctrの実チップ解析。指数=下位3bit、仮数=上位5bit)。
  // ★当初MAME旧版の累積テーブルを使っていたが式が全く違う(libvgmがVGMの参照実装)
  const PCM_TBL = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const s1 = i & 7;
    const s2 = Math.abs((i << 24) >> 27) & 0x1F;
    let v = (0x80 << s1) & 0xFF00;
    v += s2 << (s1 ? (s1 + 3) : 4);
    PCM_TBL[i] = (i & 0x80) ? -v : v;
  }
  const ASIC219_BANK_REGS = [0x1F7, 0x1F1, 0x1F3, 0x1F5];

  class C140Audio {
    /**
     * @param {number} [clock=12288000] - マスタークロック(出力レート=clock/576)。
     *   1MHz未満ならサンプルレート直値とみなす(旧VGM互換)。
     * @param {number} [type=0] - 0=System2, 1=System21, 2=C219(ヘッダ0x96)
     */
    constructor(clock, type) {
      this.clockHz = clock || 12288000;
      // ★baseRate = 実チップの出力レート = clock/288(libvgm c140.c=superctrの実チップ解析。
      //   System 2: 12.288MHz → 42667Hz)。当初 clock/576=21333Hz と誤実装しており
      //   **全ボイスが正確に1オクターブ低く**鳴っていた(ユーザーの実聴指摘+CD照合で発覚)。
      //   周波数レジスタの意味は bytes/sec = baseRate*freq/65536。
      // 旧VGM互換: 1MHz未満はレート直値(旧仕様の~21390)とみなし、旧値=半レート慣習として2倍する。
      // 内部ティックは cyclesPerSample=288 → 42667Hz。この時点で44.1kHz出力段ZOHの折り返しは
      // 42.6k±fの不可聴域なので追加オーバーサンプルは不要(_freqScale=baseRate/実ティックレート)。
      const legacy = this.clockHz < 1000000;
      this.baseRate = legacy ? this.clockHz * 2 : this.clockHz / 288;
      this.cyclesPerSample = legacy ? 1 : 288;
      this._freqScale = this.baseRate / (this.clockHz / this.cyclesPerSample); // legacy=2, 通常=1
      this.sampleRate = this.baseRate; // playRate/スナップショットの周波数基準
      this.type = type || 0;
      // 出力LPF(基板のDAC後段アナログ再構成フィルタ相当、2次バターワース ~7kHz)。
      // CD音源(実基板ライン録音)とのスペクトル比較で、ZOH化後の6.3k/10k/16kHz帯が
      // CD比+3/+5/+12dB過剰(=DACイメージング成分)だったのを実機同様に丸める。
      // RBJ biquad lowpass(チップレートで動作)
      {
        const fc = 10000, Q = 0.707; // 基板出力のアナログ再構成フィルタ相当(CD照合で調整。8kは10k帯が-5.5dB不足)
        const w0 = 2 * Math.PI * fc / (this.clockHz / this.cyclesPerSample); // LPFは内部ティックレートで動く
        const alpha = Math.sin(w0) / (2 * Q);
        const cosw = Math.cos(w0);
        const a0 = 1 + alpha;
        this._lpB0 = (1 - cosw) / 2 / a0;
        this._lpB1 = (1 - cosw) / a0;
        this._lpB2 = (1 - cosw) / 2 / a0;
        this._lpA1 = -2 * cosw / a0;
        this._lpA2 = (1 - alpha) / a0;
      }
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // 'start:end' → {cps, conf, …}
      this._muFlags = new Map();    // 'start:end' → μ-lawサンプルか(キーオン時に記録、解析のデコード切替用)
      this.reset();
    }
    reset() {
      this.regs = new Uint8Array(0x200);
      this.ch = [];
      // seq: キーオン通番(先読みキャプチャ用)。st/ed/loop/bank/mode: キーオン時ラッチ。
      // smpStart/End: ピッチ解析用のROM上絶対アドレス(バンキング適用済み)
      for (let i = 0; i < NUM_CH; i++) this.ch.push({ key: false, pos: 0, frac: 0, prevdt: 0, lastdt: 0,
        st: 0, ed: 0, loop: 0, bank: 0, mode: 0, seq: 0, smpStart: 0, smpEnd: 0 });
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
      // 出力LPFの状態(biquad Direct Form 1、L/R各: 入力x1,x2 / 出力y1,y2)
      this._lp = { lx1: 0, lx2: 0, ly1: 0, ly2: 0, rx1: 0, rx2: 0, ry1: 0, ry2: 0 };
    }

    /** VGMデータブロック 0x8D(C140 ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear();
    }

    // バンキング: 16bitアドレス+バンク → ROM上の絶対アドレス
    findSample(adr16, bank, voice) {
      const adrs = ((bank << 16) + adr16) >>> 0;
      switch (this.type) {
        case 1: return ((adrs & 0x300000) >> 1) | (adrs & 0x7FFFF);            // System 21
        case 2: return ((this.regs[ASIC219_BANK_REGS[voice >> 2]] & 3) * 0x20000) + (adrs & 0x1FFFF); // C219
        default: return ((adrs & 0x200000) >> 2) | (adrs & 0x7FFFF);           // System 2
      }
    }

    /** レジスタ書込み(VGM 0xD4 ppaa dd) */
    write(reg, val) {
      reg &= 0x1FF; val &= 0xFF;
      this.regs[reg] = val;
      if (reg >= 0x180) return; // ボイス域外(C219のバンクレジスタ等はregs参照で効く)
      if ((reg & 0x0F) !== 0x05) return;
      const i = reg >> 4;
      const c = this.ch[i];
      if (val & 0x80) { // キーオン: バンク/モード/開始/終了/ループをラッチ
        const b = reg & 0x1F0;
        c.bank = this.regs[b + 4];
        c.mode = val;
        c.st = (this.regs[b + 6] << 8) | this.regs[b + 7];
        c.ed = (this.regs[b + 8] << 8) | this.regs[b + 9];
        c.loop = (this.regs[b + 10] << 8) | this.regs[b + 11];
        c.pos = 0; c.frac = 0; c.prevdt = 0; c.lastdt = 0;
        c.key = true;
        c.seq++;
        c.smpStart = this.findSample(c.st, c.bank, i);
        c.smpEnd = this.findSample(c.ed, c.bank, i);
      } else {
        c.key = false;
      }
    }

    // 再生レート(1秒あたりのROMバイト数)
    playRate(i) {
      const b = i << 4;
      return ((this.regs[b + 2] << 8) | this.regs[b + 3]) / 65536 * this.sampleRate;
    }

    _fetch(c, i) {
      const addr = this.findSample((c.st + c.pos) & 0xFFFF, c.bank, i);
      const v = this.rom[addr] || 0;
      return (c.mode & 0x08) ? PCM_TBL[v] : (((v << 24) >> 24) << 8); // μ-law / 8bit符号付き<<8
    }

    _calcSample() {
      let l = 0, r = 0;
      const rom = this.rom, regs = this.regs;
      if (rom) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.key) continue;
          const b = i << 4;
          const freq = (regs[b + 2] << 8) | regs[b + 3];
          if (!freq) continue;
          // 1ティックの進み = freq * _freqScale(通常1。旧VGM互換時のみ2)
          c.frac += freq * this._freqScale;
          const cnt = c.frac >= 65536 ? Math.floor(c.frac / 65536) : 0;
          c.frac -= cnt * 65536;
          if (cnt) {
            c.pos += cnt;
            const sz = c.ed - c.st;
            if (c.pos >= sz) { // 終端
              if (!(c.mode & 0x10)) { c.key = false; continue; }
              c.pos = Math.max(0, c.loop - c.st);
            }
            c.prevdt = c.lastdt;
            c.lastdt = this._fetch(c, i);
          }
          if (this.mute[i]) continue;
          // ★既定は補間なし(ZOH=次のサンプルまで値を保持)。MAMEコアはprevdt/dltdtの線形補間を
          //   入れているが、実チップは保持のみで、C140の実曲は再生レートが低い(3〜7kBytes/s)ため
          //   直線補間だと高域が大きく削れて「ぼやけた」音になる(ユーザー実聴指摘。CD音源との
          //   スペクトル比較にも使えるよう this.interp=true でMAME流補間へ切替可能)。
          const sdt = this.interp ? c.prevdt + (c.lastdt - c.prevdt) * c.frac / 65536 : c.lastdt;
          l += sdt * regs[b + 1] * this.vol[i]; // +1=音量L
          r += sdt * regs[b + 0] * this.vol[i]; // +0=音量R
        }
      }
      // 1chフルスケール ≒ 32767*255。24ch合算を±1.0程度へ
      const rawL = l / (32768 * 255 * 2);
      const rawR = r / (32768 * 255 * 2);
      // 出力LPF(コンストラクタのコメント参照)
      const s = this._lp;
      const yl = this._lpB0 * rawL + this._lpB1 * s.lx1 + this._lpB2 * s.lx2 - this._lpA1 * s.ly1 - this._lpA2 * s.ly2;
      s.lx2 = s.lx1; s.lx1 = rawL; s.ly2 = s.ly1; s.ly1 = yl;
      const yr = this._lpB0 * rawR + this._lpB1 * s.rx1 + this._lpB2 * s.rx2 - this._lpA1 * s.ry1 - this._lpA2 * s.ry2;
      s.rx2 = s.rx1; s.rx1 = rawR; s.ry2 = s.ry1; s.ry1 = yr;
      this.lastL = yl;
      this.lastR = yr;
    }

    clock() {
      if (++this.cyc < this.cyclesPerSample) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** サンプル(ROM上のstart..end-1)の基本周期解析(キャッシュ)。ga20/segapcmと同じ設計。
     *  μ-lawかどうかはキーオン時に _muFlags へ記録した値でデコードを切り替える。 */
    samplePitch(kind, start, end) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._decodeSample(start, end);
      const auto = U.detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false,
        hash: U.sampleHash(this.rom, start, Math.min(end, start + pcm.length)), wave: null, lenBytes: pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(start, end) {
      const rom = this.rom;
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES, rom.length);
      const n = Math.max(0, e - start);
      const mu = !!this._muFlags.get(start + ':' + end);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = rom[start + i];
        pcm[i] = (mu ? PCM_TBL[v] : (((v << 24) >> 24) << 8)) / 32768;
      }
      return pcm;
    }
    /** 手動ピッチ補正(表示専用)。ga20/segapcm/ym2610と同じlocalStorage永続化。 */
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

  // 鍵盤表示用スナップショット(SegaPCMと同じ形の配列24要素):
  // { active, vol(0-1)、rawVol(L/R大きい方0-255)、panL/panR(0-15表示値)、rate、seq、
  //   loop、lenSec(ループ中はInfinity)、pitchHz、pitchConf、pitchManual、waveData、sample }
  Emu.snapshotC140 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const b = i << 4;
      const volL = chip.regs[b + 1], volR = chip.regs[b + 0];
      const vmax = Math.max(volL, volR);
      const rate = chip.playRate(i);
      if (c.seq) chip._muFlags.set(c.smpStart + ':' + c.smpEnd, !!(c.mode & 0x08));
      const p = c.seq ? chip.samplePitch('c140', c.smpStart, c.smpEnd) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, c.smpEnd - c.smpStart);
      const loop = !!(c.mode & 0x10);
      out.push({ active: c.key && vmax > 0 && rate > 0, vol: vmax / 255, rawVol: vmax, rawVolMax: 255,
        panL: volL >> 4, panR: volR >> 4,
        rate, seq: c.seq, loop, lenSec: loop ? Infinity : (rate > 0 ? lenBytes / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual),
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'c140', start: c.smpStart, end: c.smpEnd } : null });
    }
    return out;
  };

  Emu.C140Audio = C140Audio;
})(window);
