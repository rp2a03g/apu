/*
 * Konami K054539 8ch PCM 音源 (VGM: chip 'k054539'。コナミのアーケード基板。
 * Xexex(YM2151とペア) / サラマンダー2(2個使い) / リーサルエンフォーサーズ 等)
 * MML.Emu.K054539Audio
 *
 * 8ch・ステレオ・出力レート = clock/384(18432000Hz → 48000Hz)。
 * 1chにつき3種のサンプル形式を持つ(ch毎のレジスタ 0x200+2*ch の bit2-3 で選ぶ):
 *   0x0 = 8bit PCM    (ROM 1バイト = 1サンプル。0x80 が終端)
 *   0x4 = 16bit PCM   (リトルエンディアン2バイト = 1サンプル。0x8000 が終端)
 *   0x8 = 4bit DPCM   (1バイト2サンプル。0x88 が終端。差分表は下の DPCM_DELTA)
 * ループ許可は 0x200+2*ch+1 の bit0。終端に当たるとループ先(+0x08-0x0a)へ戻るか、キーオフ。
 * 挙動は libvgm emu/cores/k054539.c(MAME、Olivier Galibert)準拠:
 *   ch毎レジスタ(base = 0x20*ch):
 *     +0x00-02 ピッチ(24bit delta。1出力サンプルごとに pfrac += delta、桁上がりで1サンプル進む)
 *     +0x03 音量(0=最大, 0x40=-36dB。voltab = 10^(-36*i/0x40/20)/4)
 *     +0x04 リバーブ音量 / +0x06-07 リバーブ遅延
 *     +0x05 パン(0x11-0x1f、DJ Main系は0x81-0x8f。範囲外は中央)
 *     +0x08-0a ループ先 / +0x0c-0e 開始位置(再生中は現在位置も兼ねる)
 *   共通レジスタ: 0x214 キーオン / 0x215 キーオフ / 0x22c 発音中マスク /
 *                 0x22e ROM/RAM選択 / 0x22f 全体制御(bit0=PCM有効, bit7=レジスタ更新禁止)
 *   パン表 pantab[i] = sqrt(i)/sqrt(0xe)(左右の二乗和が一定=定パワー)。左=pantab[pan]、右=pantab[0xe-pan]。
 *   ★音量は「上4chを持ち上げないと実機の釣り合いにならない」とMAME側のコメントにあるが、
 *     libvgm も含め補正はしていない(gain[]は全ch 1.0)。ここも同じにする。
 * VGM: コマンド 0xD3 pp aa dd(オフセット=(pp<<8)|aa、ppのbit7=デュアル2個目)、
 * ROMはデータブロック type 0x8C。ヘッダのクロックは **48000 のような「実はサンプルレート」の
 * 古いログがある**ので、1MHz未満なら×384 して実クロックに直す(vgmHeader.js が処理済み)。
 * ヘッダ0x95 = フラグ(bit0=左右反転, bit1=リバーブ無効, bit2=キーオン時に位置を確定)。
 *
 * ★GA20/K007232 と同じく、鍵盤表示/vgm2mmlの音程は Emu.SamplePitchUtil のサンプル基本周期解析
 * × 再生レートで得る(手動キャリブレーションのlocalStorageも共通)。終端レジスタが無いので
 * 終端は形式ごとの終端マーカーまでROMを走査して求める。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 8;
  const CLOCK_DIV = 384;
  const VOL_CAP = 1.80;
  const REVERB_MASK = 0x1FFF; // リバーブRAMのリングバッファ長(Int16で8192)
  const MAX_SAMPLE_BYTES = 256 * 1024; // 終端走査/解析のコスト上限

  // 4bit DPCM の差分表(libvgm k054539_update の dpcm[])
  const DPCM_DELTA = new Int16Array([
    0 * 0x100, 1 * 0x100, 2 * 0x100, 4 * 0x100, 8 * 0x100, 16 * 0x100, 32 * 0x100, 64 * 0x100,
    0 * 0x100, -64 * 0x100, -32 * 0x100, -16 * 0x100, -8 * 0x100, -4 * 0x100, -2 * 0x100, -1 * 0x100
  ]);

  // 音量/パンの換算表(libvgm device_start_k054539 と同じ式)
  const VOLTAB = new Float64Array(256);
  for (let i = 0; i < 256; i++) VOLTAB[i] = Math.pow(10, (-36 * i / 0x40) / 20) / 4;
  const PANTAB = new Float64Array(0xF);
  for (let i = 0; i < 0xF; i++) PANTAB[i] = Math.sqrt(i) / Math.sqrt(0xE);

  class K054539Audio {
    /**
     * @param {number} [clock=18432000] - マスタークロック(出力レート=clock/384)
     * @param {number} [flags=0] - ヘッダ0x95: bit0=左右反転, bit1=リバーブ無効, bit2=キーオン時確定
     */
    constructor(clock, flags) {
      this.clockHz = clock || 18432000;
      this.sampleRate = this.clockHz / CLOCK_DIV;
      this.flags = flags || 0;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this.rom = null;
      this.romMask = 0;
      this._pitchCache = new Map(); // 'start:end:type' → samplePitch 結果
      this._endCache = new Map();   // 'start:type' → 終端アドレス
      this.reset();
    }

    reset() {
      this.regs = new Uint8Array(0x230);
      this.posLatch = [];
      this.ch = [];
      for (let i = 0; i < NUM_CH; i++) {
        this.posLatch.push(new Uint8Array(3));
        // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
        this.ch.push({ pos: 0, pfrac: 0, val: 0, pval: 0, seq: 0, startAddr: 0 });
      }
      this.reverb = new Int16Array(REVERB_MASK + 1);
      this.reverbPos = 0;
      this.curPtr = 0;
      this.romAddr = 0;
      this.cyc = 0;
      this.lastL = 0;
      this.lastR = 0;
    }

    /** VGMデータブロック 0x8C(K054539 ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      // libvgm rom_mask = pow2_mask(memsize)(2の冪へ切り上げてから -1)
      let m = 1;
      while (m < rom.length) m <<= 1;
      this.romMask = m - 1;
      this._pitchCache.clear();
      this._endCache.clear();
    }

    _regUpdate() { return !(this.regs[0x22F] & 0x80); }
    _keyOn(ch) {
      if (!this._regUpdate()) return;
      this.regs[0x22C] |= (1 << ch);
      const c = this.ch[ch];
      const b = 0x20 * ch;
      c.startAddr = this.regs[b + 0x0C] | (this.regs[b + 0x0D] << 8) | (this.regs[b + 0x0E] << 16);
      c.seq++;
    }
    _keyOff(ch) { if (this._regUpdate()) this.regs[0x22C] &= ~(1 << ch); }

    /** レジスタ書込み(VGM 0xD3 pp aa dd、offset=(pp<<8)|aa) */
    write(offset, data) {
      offset &= 0xFFFF; data &= 0xFF;
      if (offset >= this.regs.length) return;
      // キーオン時に位置を確定するモード(ヘッダ0x95 bit2): 0x0c-0x0e への書込みはラッチに溜める
      const latch = (this.flags & 0x04) && (this.regs[0x22F] & 0x01);
      if (latch && offset < 0x100) {
        const offs = (offset & 0x1F) - 0x0C;
        if (offs >= 0 && offs <= 2) { this.posLatch[offset >> 5][offs] = data; return; }
      }
      switch (offset) {
        case 0x214: // キーオン
          for (let ch = 0; ch < NUM_CH; ch++) {
            if (!(data & (1 << ch))) continue;
            if (latch) {
              const b = (ch << 5) + 0x0C, p = this.posLatch[ch];
              this.regs[b] = p[0]; this.regs[b + 1] = p[1]; this.regs[b + 2] = p[2];
            }
            this._keyOn(ch);
          }
          break;
        case 0x215: // キーオフ
          for (let ch = 0; ch < NUM_CH; ch++) if (data & (1 << ch)) this._keyOff(ch);
          break;
        case 0x22D: // データポート(リバーブRAM書込み)
          if (this.romAddr === 0x80) {
            const addr = (this.curPtr & 0x3FFF) | ((this.curPtr & 0x10000) >> 2);
            if (addr < this.reverb.length * 2) {
              // ram は byte 単位。Int16 のリバーブバッファへバイト単位で書く
              const i = addr >> 1;
              if (addr & 1) this.reverb[i] = (this.reverb[i] & 0x00FF) | (data << 8);
              else this.reverb[i] = (this.reverb[i] & ~0x00FF) | data;
            }
          }
          this.curPtr = (this.curPtr + 1) & 0x1FFFF;
          break;
        case 0x22E: this.romAddr = data; this.curPtr = 0; break;
        default: break;
      }
      this.regs[offset] = data;
    }

    /** ch の再生レート(1秒あたりのサンプル数)。deltaは24bitで 0x10000 = 等速 */
    playRate(ch) {
      const b = 0x20 * ch;
      const delta = this.regs[b] | (this.regs[b + 1] << 8) | (this.regs[b + 2] << 16);
      return this.sampleRate * delta / 0x10000;
    }
    /** ch のサンプル形式(0=8bit PCM, 4=16bit PCM, 8=4bit DPCM) */
    sampleType(ch) { return this.regs[0x200 + 2 * ch] & 0x0C; }
    /** ch の音量(0-1。0=最大音量のレジスタ値なので反転している) */
    chVol(ch) { return Math.min(1, VOLTAB[this.regs[0x20 * ch + 0x03]] * 4); }

    _calcSample() {
      const rom = this.rom;
      if (!rom || !(this.regs[0x22F] & 0x01)) { this.lastL = 0; this.lastR = 0; return; }
      const noReverb = !!(this.flags & 0x02);
      let l = 0, r = 0;
      if (!noReverb) { l = r = this.reverb[this.reverbPos]; }
      this.reverb[this.reverbPos] = 0;
      const mask = this.romMask;
      for (let ch = 0; ch < NUM_CH; ch++) {
        if (!(this.regs[0x22C] & (1 << ch)) || this.mute[ch]) continue;
        const b1 = 0x20 * ch, b2 = 0x200 + 2 * ch;
        const c = this.ch[ch];
        let delta = this.regs[b1] | (this.regs[b1 + 1] << 8) | (this.regs[b1 + 2] << 16);
        const vol = this.regs[b1 + 3];
        let bval = vol + this.regs[b1 + 4]; if (bval > 255) bval = 255;
        let pan = this.regs[b1 + 5];
        if (pan >= 0x81 && pan <= 0x8F) pan -= 0x81;
        else if (pan >= 0x11 && pan <= 0x1F) pan -= 0x11;
        else pan = 0x18 - 0x11;
        const g = this.vol[ch];
        let lvol = VOLTAB[vol] * PANTAB[pan] * g; if (lvol > VOL_CAP) lvol = VOL_CAP;
        let rvol = VOLTAB[vol] * PANTAB[0xE - pan] * g; if (rvol > VOL_CAP) rvol = VOL_CAP;
        let rbvol = VOLTAB[bval] * g / 2; if (rbvol > VOL_CAP) rbvol = VOL_CAP;
        const rdelta = (((this.regs[b1 + 6] | (this.regs[b1 + 7] << 8)) >> 3) + this.reverbPos) & 0x3FFF;

        let curPos = this.regs[b1 + 0x0C] | (this.regs[b1 + 0x0D] << 8) | (this.regs[b1 + 0x0E] << 16);
        let fdelta, pdelta;
        if (this.regs[b2] & 0x20) { delta = -delta; fdelta = 0x10000; pdelta = -1; }
        else { fdelta = -0x10000; pdelta = 1; }

        let curPfrac, curVal, curPval;
        if (curPos !== c.pos) { c.pos = curPos; curPfrac = 0; curVal = 0; curPval = 0; }
        else { curPfrac = c.pfrac; curVal = c.val; curPval = c.pval; }

        const loopAddr = () => this.regs[b1 + 0x08] | (this.regs[b1 + 0x09] << 8) | (this.regs[b1 + 0x0A] << 16);
        const looping = !!(this.regs[b2 + 1] & 1);
        switch (this.regs[b2] & 0x0C) {
          case 0x0: { // 8bit PCM
            curPfrac += delta;
            while (curPfrac & ~0xFFFF) {
              curPfrac += fdelta; curPos += pdelta;
              curPval = curVal;
              curVal = (rom[curPos & mask] << 8) << 16 >> 16;
              if (curVal === -32768 && looping) { curPos = loopAddr(); curVal = (rom[curPos & mask] << 8) << 16 >> 16; }
              if (curVal === -32768) { this._keyOff(ch); curVal = 0; break; }
            }
            break;
          }
          case 0x4: { // 16bit PCM(リトルエンディアン)
            const pd = pdelta * 2;
            curPfrac += delta;
            while (curPfrac & ~0xFFFF) {
              curPfrac += fdelta; curPos += pd;
              curPval = curVal;
              curVal = (rom[curPos & mask] | (rom[(curPos + 1) & mask] << 8)) << 16 >> 16;
              if (curVal === -32768 && looping) { curPos = loopAddr(); curVal = (rom[curPos & mask] | (rom[(curPos + 1) & mask] << 8)) << 16 >> 16; }
              if (curVal === -32768) { this._keyOff(ch); curVal = 0; break; }
            }
            break;
          }
          case 0x8: { // 4bit DPCM(1バイト2サンプル)
            curPos <<= 1;
            curPfrac <<= 1;
            if (curPfrac & 0x10000) { curPfrac &= 0xFFFF; curPos |= 1; }
            curPfrac += delta;
            while (curPfrac & ~0xFFFF) {
              curPfrac += fdelta; curPos += pdelta;
              curPval = curVal;
              let v = rom[(curPos >> 1) & mask];
              if (v === 0x88 && looping) { curPos = loopAddr() << 1; v = rom[(curPos >> 1) & mask]; }
              if (v === 0x88) { this._keyOff(ch); curVal = 0; break; }
              v = (curPos & 1) ? (v >> 4) : (v & 15);
              curVal = curPval + DPCM_DELTA[v];
              if (curVal < -32768) curVal = -32768; else if (curVal > 32767) curVal = 32767;
            }
            curPfrac >>= 1;
            if (curPos & 1) curPfrac |= 0x8000;
            curPos >>= 1;
            break;
          }
          default: // 未定義の形式。ログを吐き続けないようchを止める(libvgm同様)
            this.regs[0x22C] &= ~(1 << ch);
            break;
        }

        l += curVal * lvol;
        r += curVal * rvol;
        if (!noReverb) {
          const ri = (rdelta + this.reverbPos) & REVERB_MASK;
          this.reverb[ri] = Math.max(-32768, Math.min(32767, this.reverb[ri] + (curVal * rbvol) | 0));
        }
        c.pos = curPos; c.pfrac = curPfrac; c.pval = curPval; c.val = curVal;
        if (this._regUpdate()) {
          this.regs[b1 + 0x0C] = curPos & 0xFF;
          this.regs[b1 + 0x0D] = (curPos >> 8) & 0xFF;
          this.regs[b1 + 0x0E] = (curPos >> 16) & 0xFF;
        }
      }
      this.reverbPos = (this.reverbPos + 1) & REVERB_MASK;
      // 8ch合算の実効フルスケール。voltab が既に 1/4 を含むので 32768 で割れば概ね ±1
      const sl = l / 32768, sr = r / 32768;
      if (this.flags & 0x01) { this.lastL = sr; this.lastR = sl; } // bit0: 左右反転
      else { this.lastL = sl; this.lastR = sr; }
    }

    clock() {
      if (++this.cyc < CLOCK_DIV) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /**
     * サンプル終端(形式ごとの終端マーカーの位置)。レジスタに終端が無いのでROMを走査する。
     * 8bit=0x80 / 16bit=0x8000(LE) / DPCM=0x88。戻り値はバイト位置。
     */
    sampleEnd(start, type) {
      const rom = this.rom;
      if (!rom || start >= rom.length) return start;
      const key = start + ':' + type;
      let e = this._endCache.get(key);
      if (e !== undefined) return e;
      const limit = Math.min(rom.length, start + MAX_SAMPLE_BYTES);
      let p = start;
      if (type === 0x4) { while (p + 1 < limit && !(rom[p] === 0x00 && rom[p + 1] === 0x80)) p += 2; }
      else if (type === 0x8) { while (p < limit && rom[p] !== 0x88) p++; }
      else { while (p < limit && rom[p] !== 0x80) p++; }
      e = p;
      this._endCache.set(key, e);
      return e;
    }

    /** ROM の start..end を形式に応じて復号 → Float32(-1..1) */
    _decodeSample(start, end, type) {
      const rom = this.rom;
      const e = Math.min(end, start + MAX_SAMPLE_BYTES, rom.length);
      if (type === 0x4) {
        const n = Math.max(0, (e - start) >> 1);
        const pcm = new Float32Array(n);
        for (let i = 0; i < n; i++) pcm[i] = ((rom[start + i * 2] | (rom[start + i * 2 + 1] << 8)) << 16 >> 16) / 32768;
        return pcm;
      }
      if (type === 0x8) {
        const n = Math.max(0, (e - start) * 2);
        const pcm = new Float32Array(n);
        let v = 0;
        for (let i = 0; i < n; i++) {
          const byte = rom[start + (i >> 1)];
          const nib = (i & 1) ? (byte >> 4) : (byte & 15);
          v += DPCM_DELTA[nib];
          if (v < -32768) v = -32768; else if (v > 32767) v = 32767;
          pcm[i] = v / 32768;
        }
        return pcm;
      }
      const n = Math.max(0, e - start);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = ((rom[start + i] << 8) << 16 >> 16) / 32768;
      return pcm;
    }

    /**
     * サンプルの基本周期解析(キャッシュ)。表示専用。ga20.js samplePitch と同じ契約。
     * @returns {{cps, conf, cpsAuto, confAuto, manual, hash, wave, lenBytes}|null}
     */
    samplePitch(kind, start, end, type) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      const key = start + ':' + end + ':' + (type || 0);
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._decodeSample(start, end, type || 0);
      const auto = U.detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false,
        hash: U.sampleHash(this.rom, start, Math.min(end, start + MAX_SAMPLE_BYTES)), wave: null, lenBytes: pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      U.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }

    /** スナップショットの sample({kind,start,end,type}) → デコード済みPCM */
    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.start, sample.end, sample.type || 0);
    }

    /** 打楽器/音階の手動上書き(ga20.js setSampleKind と同契約) */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end, sample.type);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end + ':' + (sample.type || 0));
      return { kind: kind || null, needsTuning: needsTuning };
    }

    /** 手動ピッチ補正(表示専用。ga20.js setSampleTuning と同じ永続化) */
    setSampleTuning(kind, start, end, cps, type) {
      const r = this.samplePitch(kind, start, end, type);
      if (!r) return null;
      const U = Emu.SamplePitchUtil;
      const map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      U.saveTuningMap(map);
      r.wave = U.makeSampleWave(this._decodeSample(start, end, type || 0), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }
  }

  // 鍵盤表示用スナップショット(snapshotGA20 と同じ形の配列8要素)
  Emu.snapshotK054539 = function (chip) {
    const out = [];
    const active = chip.regs[0x22C];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const b = 0x20 * i;
      const type = chip.sampleType(i);
      const rate = chip.playRate(i);
      const start = c.seq ? c.startAddr : 0;
      const end = c.seq ? chip.sampleEnd(start, type) : start;
      const p = c.seq ? chip.samplePitch('k054539', start, end, type) : null;
      // 8bit=1byte/サンプル、16bit=2byte/サンプル、DPCM=0.5byte/サンプル
      const lenSamples = p ? p.lenBytes : 0;
      const vol = chip.chVol(i);
      let pan = chip.regs[b + 5];
      if (pan >= 0x81 && pan <= 0x8F) pan -= 0x81; else if (pan >= 0x11 && pan <= 0x1F) pan -= 0x11; else pan = 0x07;
      // ★L/R列は**0-15の整数**が全チップ共通の表示規約(segapcm=volL>>3、c140=volL>>4 等)。
      //   定パワーのパン表(0..1の小数)をそのまま入れると「0.7071067811865475」と出てしまう。
      // ★音量の数値(rawVol)も0-15と同じ理由でバー(vol)と 食い違わせない: レジスタ0x03は
      //   「0=最大の減衰値」なので生値や 255-生値 を出すと、7%のバーの隣に213と並んで意味が読めない。
      // ★音量バーは volApparent(表示専用)を使う。vol は**線形振幅**で、これは vgm2mml が
      //   attDb = -20log10(vol) で減衰dBに戻すための値なので意味を変えられない。ところが
      //   このチップのレジスタは**対数の減衰値**(0x40 = -36dB)で、実曲は 0x12-0x2A 付近しか
      //   使わないため、振幅のままバーに出すと 7〜32% しか動かず読めない(ユーザー報告)。
      //   他の対数レジスタのチップ(HES/AY/FME7/VRC7)はバーに**レジスタ位置**を出しており、
      //   ここも合わせる: 1 - reg/0x40(= 1 - 減衰dB/36)。
      const barPos = Math.max(0, Math.min(1, 1 - chip.regs[b + 3] / 0x40));
      // ★表示規約(2026-09-17): 音量は**0が最大**の減衰レジスタ(0x03、0-0x40)、
      //   パンは実レジスタ(0x05、0x11-0x1f、中央0x18)。上の pan は 0-14 へ正規化済みなので戻す。
      out.push({ active: !!(active & (1 << i)) && vol > 0, vol, volApparent: barPos,
        rawVol: chip.regs[b + 3], rawVolMax: 0x40, volZeroMax: true,
        panReg: 0x11 + pan, panCenter: 0x18, panDir: 1, panHex: true,
        rate, seq: c.seq, lenSec: rate > 0 ? lenSamples / rate : 0,
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual),
        sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'k054539', start, end, type } : null });
    }
    return out;
  };

  // デュアル(沙羅曼蛇2)の連結スナップショット。2個目のチャンネルは **kind を分ける**:
  //  ・サンプル同定キー(DrumMap.key = kind + ':' + start)が2つのROMで衝突しない
  //  ・原音の復号でどちらのROMから読むかを chip2 で選ぶ(vgmPlayer.js collectUsedSamples)
  // ★キャプチャ(vgmPlayer.js)とライブ(main.js の鍵盤ゲッター)の**両方**がこれを通ること。
  //   片方だけ素の snapshotK054539 を連結すると kind が食い違い、鍵盤のノート列が
  //   ドラムのレーン名(ROMアドレス)へ解決できず 15(dmcRateIdx の固定値)に落ちる。
  Emu.snapshotK054539Dual = function (chipA, chipB) {
    const s1 = Emu.snapshotK054539(chipA);
    if (!chipB) return s1;
    const s2 = Emu.snapshotK054539(chipB);
    for (const c of s2) if (c.sample) { c.sample.chip2 = true; c.sample.kind = 'k054539#2'; }
    return s1.concat(s2);
  };
  Emu.K054539Audio = K054539Audio;
})(window);
