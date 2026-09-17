/*
 * OKI MSM6295 (OKIM6295) 4ch ADPCM 音源 (VGM: chip 'okim6295'。東亜プラン2/ライジング/
 * NMK/データイースト/アイレム等、90年代アーケードの定番PCM。YM2151等とペアが多い。
 * Battle Garegga / Armed Police Batrider / Truxton II / Batsugun 等)
 * MML.Emu.OKIM6295Audio
 *
 * 4bit OKI ADPCM×4ch・12bit内部信号(OKIM6258と同じ折れ線テーブル)、モノラル出力。
 * ROM先頭にフレーズ表(128フレーズ×8バイト: +0-2=開始/+3-5=終了(24bit BE)、inclusive)。
 * MAME okim6295.cpp 準拠:
 *   サンプルレート = masterClock/divider(divider=132(pin7=H)/165(pin7=L)。
 *   例: 1.056MHz/132=8kHz)。1出力サンプル=1ニブル消費、**上位→下位ニブルの順**
 *   (MAME okiadpcm: shift=((sample&1)<<2)^4)。ループ機能は無い(全てワンショット)。
 *   コマンド(1ポート): 0x80|フレーズ → 2バイト目 上位4bit=ボイス選択マスク/下位4bit=音量
 *   (減衰表 volume_table、0=0dB〜8=-24dB、9以降=無音)。bit7=0の書込み=停止
 *   (bit3-6がボイスマスク)。キーオンで signal=-2, step=0 リセット。
 * VGM: コマンド 0xB8 aa dd(aaのbit7=デュアル2個目)。aa=仮想レジスタ(VGMPlay拡張):
 *   0x00=コマンド / 0x08-0x0B=マスタークロック実行時変更(LE) / 0x0C=pin7(分周切替) /
 *   0x0E=NMK112バンクモード / 0x0F=通常バンク(値×0x40000) / 0x10-0x13=NMK112バンク0-3。
 *   ROMはデータブロック0x8B、ヘッダ0x98(クロック。bit31=pin7)。
 * バンク(VGMPlay memory_raw_read準拠):
 *   通常: bankOffs|offset(バンク=256KB単位)
 *   NMK112(ライジング/NMK系): 64KB×4窓。nmkMode bit7=フレーズ表(先頭0x400)も
 *   0x100単位でバンク窓0-3に従う。
 *
 * ★ピッチ解析: 音程レジスタは無い(固定レート)が、YM2610 ADPCM-Aと同じ
 * 「音程ごとに別サンプル」方式の曲があるので、フレーズをADPCMデコードして
 * SamplePitchUtil で解析(取れた区間だけ絶対音名)。アドレスはキーオン時の
 * バンク状態で絶対化してラッチする。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 4;

  // OKI ADPCM差分表(okim6258.jsと同じMAME compute_tables)
  const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];
  const DIFF = new Int16Array(49 * 16);
  for (let step = 0; step < 49; step++) {
    const sv = Math.floor(16 * Math.pow(11 / 10, step));
    for (let n = 0; n < 16; n++) {
      const d = ((n >> 2) & 1) * sv + ((n >> 1) & 1) * (sv >> 1) + (n & 1) * (sv >> 2) + (sv >> 3);
      DIFF[step * 16 + n] = (n & 8) ? -d : d;
    }
  }
  // 音量減衰表(MAME s_volume_table: 0x20=0dB、約-3dB/段、9以降は無音)
  const VOL_TBL = [0x20, 0x16, 0x10, 0x0B, 0x08, 0x06, 0x04, 0x03, 0x02, 0, 0, 0, 0, 0, 0, 0];

  class OKIM6295Audio {
    /**
     * @param {number} [clock=1056000] - マスタークロック(clock()の呼び出しレート)
     * @param {boolean} [pin7=false] - ヘッダ0x98 bit31。分周=pin7?132:165
     */
    constructor(clock, pin7) {
      this.clockHz = clock || 1056000;
      this.masterClock = this.clockHz; // 0x08-0x0Bで実行時変更されうる
      this.divider = pin7 ? 132 : 165;
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // 'start:end'(絶対バイトアドレス) → {cps, conf, …}
      this.reset();
    }
    reset() {
      this.ch = [];
      // sample: ニブル位置 / count: 総ニブル数 / chVol: 減衰表の値(0-0x20)
      // seq: キーオン通番 / smpStart/End: ピッチ解析用の絶対バイトアドレス(キーオン時ラッチ)
      for (let i = 0; i < NUM_CH; i++) this.ch.push({
        playing: false, base: 0, sample: 0, count: 0, chVol: 0,
        signal: -2, step: 0, seq: 0, smpStart: 0, smpEnd: 0, phrase: -1 });
      this.pendingPhrase = -1;
      this.bankOffs = 0;
      this.nmkMode = 0;
      this.nmkBank = [0, 0, 0, 0];
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    /** VGMデータブロック 0x8B(OKIM6295 ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear();
    }

    // バンク適用済みの絶対ROMアドレス(MAME nmk112.cpp準拠)
    _mapAddr(offset) {
      if (!this.nmkMode) return this.bankOffs | offset;
      if (offset < 0x400 && (this.nmkMode & 0x80)) {
        // NMK112のフレーズ表バンク(0x100単位ページ、ページN=窓Nのバンクに従う)。
        // ★マッピングは「バンクだけ差し替えてオフセットは丸ごと維持」= bank<<16 | offset。
        //   MAME nmk112の memcpy(&rom[N*0x100], &rom[bankaddr + N*0x100], 0x100) と等価。
        //   当初 (offset&0xFF)|bank<<16 と下位1バイトだけ残す誤実装で、ページ1-3のフレーズ表
        //   (フレーズ0x20以降=ガレッガのコーラス/ボイス)が別領域を読みプチノイズ化していた
        //   (ページ0のドラムだけ偶然正しく鳴る)。実測: フレーズ0x21-24が正しい読みだと
        //   連続サンプルチェーン(10400→13f2c→17a5a→1b587→1f0b3)になる。
        return offset | (this.nmkBank[(offset >> 8) & 3] << 16);
      }
      return (offset & 0xFFFF) | (this.nmkBank[(offset >> 16) & 3] << 16);
    }
    _read(offset) {
      const a = this._mapAddr(offset);
      return this.rom && a < this.rom.length ? this.rom[a] : 0;
    }

    /** レジスタ書込み(VGM 0xB8 aa dd) */
    write(reg, val) {
      switch (reg & 0x1F) {
        case 0x00: this._command(val & 0xFF); break;
        case 0x08: case 0x09: case 0x0A: case 0x0B: { // マスタークロック変更(LE 4バイト)
          const sh = (reg & 3) * 8;
          this.masterClock = ((this.masterClock & ~(0xFF << sh)) | ((val & 0xFF) << sh)) >>> 0;
          break;
        }
        case 0x0C: this.divider = (val & 1) ? 132 : 165; break; // pin7
        case 0x0E: this.nmkMode = val & 0xFF; break;
        case 0x0F: this.bankOffs = (val & 0xFF) * 0x40000; break;
        case 0x10: case 0x11: case 0x12: case 0x13: this.nmkBank[reg & 3] = val & 0xFF; break;
      }
    }

    _command(data) {
      if (this.pendingPhrase >= 0) {
        // 2バイト目: 上位4bit=ボイスマスク、下位4bit=音量
        const phrase = this.pendingPhrase;
        this.pendingPhrase = -1;
        const mask = (data >> 4) & 0x0F;
        const volume = VOL_TBL[data & 0x0F];
        for (let i = 0; i < NUM_CH; i++) {
          if (!(mask & (1 << i))) continue;
          const c = this.ch[i];
          const base = phrase * 8;
          const start = ((this._read(base) << 16) | (this._read(base + 1) << 8) | this._read(base + 2)) & 0x3FFFF;
          const stop = ((this._read(base + 3) << 16) | (this._read(base + 4) << 8) | this._read(base + 5)) & 0x3FFFF;
          if (start >= stop) { c.playing = false; continue; } // 不正フレーズは無視(MAME準拠)
          c.playing = true;
          c.base = start;
          c.sample = 0;
          c.count = 2 * (stop - start + 1);
          c.chVol = volume;
          c.volReg = data & 0x0F; // 鍵盤表示用の実レジスタ(減衰表のindexではなく書かれた値)
          c.signal = -2; c.step = 0;
          c.phrase = phrase;
          c.seq++;
          // ピッチ解析用: キーオン時のバンク状態で絶対化(以降バンクが変わっても解析対象は固定)
          c.smpStart = this._mapAddr(start);
          c.smpEnd = c.smpStart + (stop - start + 1);
        }
        return;
      }
      if (data & 0x80) { this.pendingPhrase = data & 0x7F; return; }
      // 停止コマンド: bit3-6がボイスマスク
      const stopMask = (data >> 3) & 0x0F;
      for (let i = 0; i < NUM_CH; i++) if (stopMask & (1 << i)) this.ch[i].playing = false;
    }

    // 再生レート(ニブル/秒=サンプル/秒。音程レジスタは無く固定)
    playRate() { return this.masterClock / this.divider; }

    _calcSample() {
      let out = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.ch[i];
        if (!c.playing) continue;
        const byte = this._read(c.base + (c.sample >> 1));
        const nib = (c.sample & 1) ? (byte & 15) : (byte >> 4) & 15; // 上位→下位
        c.signal += DIFF[c.step * 16 + nib];
        if (c.signal > 2047) c.signal = 2047; else if (c.signal < -2048) c.signal = -2048;
        c.step += INDEX_SHIFT[nib & 7];
        if (c.step > 48) c.step = 48; else if (c.step < 0) c.step = 0;
        if (++c.sample >= c.count) c.playing = false;
        if (this.mute[i]) continue;
        out += (c.signal / 2048) * (c.chVol / 0x20) * this.vol[i];
      }
      // 4ch合算(1chフルスケール=1.0)。モノラルなのでL/R同値
      this.lastL = this.lastR = out / 2;
    }

    clock() {
      this.cyc += this.masterClock / this.clockHz;
      if (this.cyc < this.divider) return;
      this.cyc -= this.divider;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** フレーズ(ROM絶対アドレス[start,end))のADPCMデコード+基本周期解析(キャッシュ)。
     *  ループが無いチップなのでタイル・フォールバックは不要。 */
    samplePitch(kind, start, end) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._decodeSample(start, end);
      // cpsは「1ニブル=1サンプル」のデコード列で検出した値。playRate()もニブル/秒なので
      // pitchHz = cps × rate がそのまま成り立つ(バイト基準への換算はしない)
      const auto = U.detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, wave: null,
        lenBytes: Math.min(end - start, 64 * 1024), lenNibbles: pcm.length,
        hash: U.sampleHash(this.rom, start, Math.min(end, start + 64 * 1024)) };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      // 打楽器/音階の手動上書きをconfへ反映(Emu.SamplePitchUtil。ロール/鍵盤/変換の
      // 4箇所がこの1点で追随する)。キャッシュへ入れる前に適用する
      Emu.SamplePitchUtil.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(start, end) {
      const rom = this.rom;
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES, rom.length);
      const nBytes = Math.max(0, e - start);
      const pcm = new Float32Array(nBytes * 2);
      let sig = -2, st = 0;
      let o = 0;
      for (let i = 0; i < nBytes; i++) {
        const b = rom[start + i];
        for (const nib of [(b >> 4) & 15, b & 15]) { // 上位→下位(再生と同順)
          sig += DIFF[st * 16 + nib];
          if (sig > 2047) sig = 2047; else if (sig < -2048) sig = -2048;
          st += INDEX_SHIFT[nib & 7];
          if (st > 48) st = 48; else if (st < 0) st = 0;
          pcm[o++] = sig / 2048;
        }
      }
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

  // 鍵盤表示用スナップショット(配列4要素、YM2610 ADPCM-Aと同じ「音程ごとに別サンプル」型):
  // { active, vol(0-1)、rawVol(減衰表値0-0x20)、panL/panR(モノ=15固定)、rate、seq、
  //   loop(常にfalse)、lenSec、pitchHz、pitchConf、pitchManual、waveData、sample }
  Emu.snapshotOKIM6295 = function (chip) {
    const out = [];
    const rate = chip.playRate();
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const p = c.seq ? chip.samplePitch('okim6295', c.smpStart, c.smpEnd) : null;
      const lenNib = c.count || (p ? p.lenNibbles : 0);
      // ★表示規約(2026-09-17): 数値は**実レジスタ**(キーオンコマンドの下位ニブル、0が最大)。
      //   従来は内部の減衰表のindex(0-0x20)を出していた。パン機能は無いので L/R は '—'。
      out.push({ active: c.playing && c.chVol > 0, vol: c.chVol / 0x20, rawVol: c.volReg || 0, rawVolMax: 15, volZeroMax: true,
        panNone: true,
        rate, seq: c.seq, loop: false, lenSec: rate > 0 ? lenNib / rate : 0,
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'okim6295', start: c.smpStart, end: c.smpEnd } : null });
    }
    return out;
  };

  Emu.OKIM6295Audio = OKIM6295Audio;
})(window);
