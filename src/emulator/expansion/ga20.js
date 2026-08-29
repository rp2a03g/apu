/*
 * Irem GA20 4ch PCM 音源 (VGM: chip 'ga20'。アイレム M92/M107 基板、YM2151とペア)
 * MML.Emu.GA20Audio
 *
 * 8bit符号なしPCM×4ch、モノラル出力。サンプルROMは 0x00 バイトが終端マーカー
 * (または終了アドレス到達で停止)。出力レート = clock/4(3579545Hz → 894886Hz)。
 * 挙動は MAME iremga20.cpp 準拠:
 *   レジスタ(0x00-0x1F、ch = (reg>>3)&3):
 *     +0/+1 開始アドレス(値<<4 / 値<<12 の20bit) / +2/+3 終了アドレス(同) /
 *     +4 レート(再生周波数 = clock/4/(0x100-値)) /
 *     +5 音量(vol = 値*256/(値+10) のソフトニーカーブ、最大246/256) /
 *     +6 制御(非0でキーオン: pos=start。0で停止)
 *   出力 = Σ (sample-0x80) * vol(ch毎)。
 * VGM: コマンド 0xBF aa dd(aaのbit7=デュアル2個目)、ROMはデータブロック type 0x93
 * (ROMサイズ(4)+開始アドレス(4)+データ。YM2610の0x82/0x83と同形式)。
 *
 * ★GA20はレートレジスタで1サンプルを音階演奏できる(YM2610 ADPCM-Bと同じ性質)ので、
 * 鍵盤表示/vgm2mmlの音程は ym2610.js と共通のサンプルピッチ解析(Emu.SamplePitchUtil:
 * ROM上のサンプルの基本周期検出 × 再生レート)で得る。手動キャリブレーション
 * (setSampleTuning)もYM2610と同じ localStorage(内容ハッシュキー)を共有する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 4;
  const CYCLES_PER_SAMPLE = 4;
  const MAX_VOL = 256; // MAME iremga20 と同じ音量カーブの分母

  class GA20Audio {
    /**
     * @param {number} [clock=3579545] - マスタークロック(出力レート=clock/4)
     */
    constructor(clock) {
      this.clockHz = clock || 3579545;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this.rom = null;
      this._pitchCache = new Map(); // 'start:end' → {cps, conf, …, lenBytes}(samplePitch)
      this.reset();
    }
    reset() {
      this.ch = [];
      // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
      for (let i = 0; i < NUM_CH; i++) this.ch.push({ start: 0, end: 0, rate: 0, volume: 0, rawVol: 0, play: false, pos: 0, frac: 0, seq: 0 });
      this.cyc = 0;
      this.last = 0;
    }

    /** VGMデータブロック 0x93(GA20 ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear(); // ROMが変わったら解析結果は無効
    }

    /** レジスタ書込み(VGM 0xBF aa dd) */
    write(reg, data) {
      reg &= 0x1F; data &= 0xFF;
      const c = this.ch[(reg >> 3) & 3];
      switch (reg & 0x07) {
        case 0: c.start = (c.start & 0xFF000) | (data << 4); break;
        case 1: c.start = (c.start & 0x00FF0) | (data << 12); break;
        case 2: c.end = (c.end & 0xFF000) | (data << 4); break;
        case 3: c.end = (c.end & 0x00FF0) | (data << 12); break;
        case 4: c.rate = data; break;
        case 5: c.rawVol = data; c.volume = (data * MAX_VOL) / (data + 10); break;
        case 6:
          if (data) { c.play = true; c.pos = c.start; c.frac = 0; c.seq++; }
          else c.play = false;
          break;
        default: break;
      }
    }

    // 再生レート(1秒あたりのROMバイト数)
    playRate(c) { return this.sampleRate / (0x100 - c.rate); }

    _calcSample() {
      let out = 0;
      const rom = this.rom;
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.ch[i];
        if (!c.play || !rom) continue;
        const sample = rom[c.pos] || 0;
        if (sample === 0x00 || c.pos >= c.end || c.pos >= rom.length) { c.play = false; continue; }
        if (!this.mute[i]) out += (sample - 0x80) * c.volume * this.vol[i];
        c.frac += 1 / (0x100 - c.rate);
        if (c.frac >= 1) { c.pos += c.frac | 0; c.frac -= c.frac | 0; }
      }
      // 1chフルスケール = 128*246 ≒ 31488。4ch合算を±1.0程度へ(MAMEの >>2 相当の按分)
      this.last = out / 131072;
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.last, right: this.last }; }

    /**
     * サンプル(ROM上のstart..end-1、0x00終端で短縮)の基本周期解析(キャッシュ)。表示専用。
     * kind引数は手動キャリブレーション経路(main.js onAdpcmCalibrate)とのインターフェース互換用。
     * @returns {{cps, conf, cpsAuto, confAuto, manual, hash, wave, lenBytes}|null}
     */
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
      // 打楽器/音階の手動上書きをconfへ反映(Emu.SamplePitchUtil。ロール/鍵盤/変換の
      // 4箇所がこの1点で追随する)。キャッシュへ入れる前に適用する
      Emu.SamplePitchUtil.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(start, end) {
      const rom = this.rom;
      const MAX_BYTES = 64 * 1024; // 解析コスト上限(長いサンプルは先頭部分だけ)
      const e = Math.min(end, start + MAX_BYTES, rom.length);
      let n = 0;
      while (start + n < e && rom[start + n] !== 0x00) n++; // 0x00終端
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = (rom[start + i] - 0x80) / 128;
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

    /** 手動ピッチ補正(表示専用)。cps=null で解除。ym2610.js setSampleTuning と同じ永続化。 */
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

  // 鍵盤表示用スナップショット(YM2610 ADPCM-A/Bと同じ形の配列4要素):
  // { active, vol(0-1), rawVol, rawVolMax, panL/R(モノなので常に1), rate(再生バイトレートHz),
  //   seq, lenSec, pitchHz, pitchConf, pitchManual, waveData, sample }
  Emu.snapshotGA20 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const rate = chip.playRate(c);
      const p = c.seq ? chip.samplePitch('ga20', c.start, c.end) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, c.end - c.start);
      const vol = c.volume / 246; // 音量カーブ適用後の振幅比(最大値246で正規化)
      out.push({ active: c.play && vol > 0, vol, rawVol: c.rawVol, rawVolMax: 255, panL: 1, panR: 1,
        rate, seq: c.seq, lenSec: rate > 0 ? lenBytes / rate : 0,
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto',
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'ga20', start: c.start, end: c.end } : null });
    }
    return out;
  };

  Emu.GA20Audio = GA20Audio;
})(window);
