/*
 * Konami K007232 2ch PCM 音源 (VGM: chip 'k007232'。コナミのアーケード基板。
 * 悪魔城ドラキュラ(Haunted Castle)/AJAX/Chequered Flag 等で YM3812+SCC とペアを組み、
 * 打楽器・ボイスを担当する)
 * MML.Emu.K007232Audio
 *
 * 7bit符号なしPCM×2ch・ステレオ(ch毎に左右の音量レジスタを持つ)。サンプルROMは
 * **bit7が終端マーカー**(値の下位7bitが波形、bit7が立っているバイトで終わり)。
 * ループ有効なら開始アドレスへ戻る。出力レート = clock/128(3579545Hz → 27965Hz)。
 * 挙動は libvgm emu/cores/k007232.c(MAME + cam900/Mao の改良版)準拠:
 *   レジスタ(ch = offset/6、reg_base = ch*6):
 *     +0/+1 ピッチ(+1のbit4-5がモード: 0/3=12bit値, 1=(256-lsb)<<4, 2=(16-nibble)<<8)
 *     +2/+3/+4 開始アドレス(17bit。+4はbit0のみ)
 *     +5 キーオン(**書込みでも読出しでもトリガ**。実チップは読み出しで発音する設計)
 *     0x0C 外部ポート(基板側の音量ラッチ。VGMログでは 0x10-0x13 に変換済みなので無視)
 *     0x0D ループ許可(bit0=ch0 / bit1=ch1)
 *     0x10-0x13 音量(ch0左/ch0右/ch1左/ch1右、各0-255)
 *     0x14/0x15 バンク(値<<17 を加算するベースアドレス)
 *   出力 = Σ ((rom[addr] & 0x7F) - 0x40) * vol。
 *   歩進: 出力1サンプルごとに counter -= 32、負になったら counter += 0x1000-step で addr++。
 *   → 再生レート(バイト/秒) = clock / (4 * (0x1000 - step))。
 * VGM: コマンド 0x41 aa dd(aaのbit7=デュアル2個目)。**aa=0x1F は「チップ読み出しの実行」**で、
 * ddが読み出しオフセット(=5か11ならキーオン)。ROMはデータブロック type 0x94
 * (ROMサイズ(4)+開始アドレス(4)+データ。GA20の0x93と同形式)。
 *
 * ★GA20/YM2610 ADPCM と同じく、鍵盤表示/vgm2mmlの音程は Emu.SamplePitchUtil の
 * サンプル基本周期解析 × 再生レートで得る(手動キャリブレーションのlocalStorageも共通)。
 * GA20と違って終端アドレスのレジスタが無いので、終端は ROM を bit7 まで走査して求める。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 2;
  const CLOCK_DIV = 128;
  const ADDR_MASK = 0x1FFFF;
  const COUNTER_TOP = 0x1000;
  const COUNTER_STEP = 32;
  // 1ch フルスケール = 64(波形の片振幅) * 255(音量) = 16320。2ch合算で ±32640 を ±1.0 へ
  const OUT_SCALE = 1 / 32768;
  const MAX_SAMPLE_BYTES = 64 * 1024; // 終端走査/解析のコスト上限

  class K007232Audio {
    /**
     * @param {number} [clock=3579545] - マスタークロック(出力レート=clock/128)
     */
    constructor(clock) {
      this.clockHz = clock || 3579545;
      this.sampleRate = this.clockHz / CLOCK_DIV;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this.rom = null;
      this._pitchCache = new Map(); // 'start:end' → samplePitch 結果
      this._endCache = new Map();   // start → 終端アドレス(bit7走査の結果)
      this.reset();
    }

    reset() {
      this.wreg = new Uint8Array(0x10);
      this.loopEn = 0;
      this.ch = [];
      for (let i = 0; i < NUM_CH; i++) {
        // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
        this.ch.push({ start: 0, addr: 0, counter: COUNTER_TOP, step: 0, bank: 0, play: false, seq: 0, volL: 255, volR: 255 });
      }
      // デバイスリセット時の既定パン(libvgm device_reset_k007232 と同じ: ch0=左, ch1=右)
      this.ch[0].volL = 255; this.ch[0].volR = 0;
      this.ch[1].volL = 0; this.ch[1].volR = 255;
      this.cyc = 0;
      this.lastL = 0;
      this.lastR = 0;
    }

    /** VGMデータブロック 0x94(K007232 ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear(); // ROMが変わったら解析結果は無効
      this._endCache.clear();
    }

    /** レジスタ書込み(VGM 0x41 aa dd、aa<0x1F) */
    write(reg, data) {
      reg &= 0x7F; data &= 0xFF;
      if (reg < this.wreg.length) this.wreg[reg] = data;
      const ci = (reg / 6) | 0;
      const base = ci * 6;
      const c = ci < NUM_CH ? this.ch[ci] : null;
      switch (reg) {
        case 0x00: case 0x06: // ピッチ下位
        case 0x01: case 0x07: { // ピッチ上位(bit4-5=モード)
          if (!c) break;
          const lsb = this.wreg[base + 0], msb = this.wreg[base + 1];
          switch ((msb >> 4) & 0x03) {
            case 0x01: c.step = (256 - lsb) << 4; break;
            case 0x02: c.step = (16 - (msb & 0x0F)) << 8; break;
            default: c.step = ((msb & 0x0F) << 8) | lsb; break; // 0/3: 12bit値
          }
          break;
        }
        case 0x02: case 0x08: // 開始アドレス 下位
        case 0x03: case 0x09: // 同 中位
        case 0x04: case 0x0A: // 同 上位(bit0のみ)
          if (c) c.start = ((this.wreg[base + 4] & 0x01) << 16) | (this.wreg[base + 3] << 8) | this.wreg[base + 2];
          break;
        case 0x05: case 0x0B: // キーオン(書込みトリガ)
          if (c) this._keyOn(ci);
          break;
        case 0x0C: break; // 外部ポート(VGMログでは0x10-0x13に変換済み。libvgm同様なにもしない)
        case 0x0D: this.loopEn = data; break;
        case 0x10: case 0x11: case 0x12: case 0x13: { // 音量(ch0左/ch0右/ch1左/ch1右)
          const v = this.ch[(reg >> 1) & 1];
          if (reg & 1) v.volR = data; else v.volL = data;
          break;
        }
        case 0x14: case 0x15: this.ch[reg & 1].bank = data << 17; break; // バンク
        default: break;
      }
    }

    /**
     * レジスタ読み出し(VGM 0x41 1F dd の dd)。実チップはオフセット5/11の読み出しで発音する
     * (Haunted Castle のドライバはこの経路だけでキーオンしている)。
     */
    read(offset) {
      if (offset === 0x05 || offset === 0x0B) this._keyOn(offset === 0x05 ? 0 : 1);
      return 0;
    }

    _keyOn(i) {
      const c = this.ch[i];
      c.play = true;
      c.addr = c.start;
      c.counter = COUNTER_TOP;
      c.seq++;
    }

    /** 再生レート(1秒あたりのROMバイト数) */
    playRate(c) { return this.sampleRate * COUNTER_STEP / (COUNTER_TOP - c.step); }

    _calcSample() {
      const rom = this.rom;
      let l = 0, r = 0;
      if (rom) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.play) continue;
          let pcmAddr = c.bank + (c.addr & ADDR_MASK);
          if (pcmAddr >= rom.length) continue;
          if (!this.mute[i]) {
            const out = (rom[pcmAddr] & 0x7F) - 0x40;
            l += out * c.volL * this.vol[i];
            r += out * c.volR * this.vol[i];
          }
          c.counter -= COUNTER_STEP;
          while (c.counter < 0 && c.play) {
            c.counter += COUNTER_TOP - c.step;
            c.addr++;
            pcmAddr = c.bank + (c.addr & ADDR_MASK);
            if (pcmAddr >= rom.length) { c.play = false; break; }
            if ((rom[pcmAddr] & 0x80) || c.addr > ADDR_MASK) {
              if (this.loopEn & (1 << i)) c.addr = c.start;
              else c.play = false;
            }
          }
        }
      }
      this.lastL = l * OUT_SCALE;
      this.lastR = r * OUT_SCALE;
    }

    clock() {
      if (++this.cyc < CLOCK_DIV) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /**
     * サンプル終端(bit7が立っているバイトの位置)。レジスタに終端アドレスが無いので
     * ROMを走査して求める(結果はキャッシュ。ROM差し替えで破棄)。
     */
    sampleEnd(start) {
      const rom = this.rom;
      if (!rom || start >= rom.length) return start;
      let e = this._endCache.get(start);
      if (e !== undefined) return e;
      const limit = Math.min(rom.length, start + MAX_SAMPLE_BYTES);
      let p = start;
      while (p < limit && !(rom[p] & 0x80)) p++;
      e = p;
      this._endCache.set(start, e);
      return e;
    }

    /**
     * サンプル(ROM上のstart..end-1)の基本周期解析(キャッシュ)。表示専用。
     * ga20.js samplePitch と同じ契約(Emu.SamplePitchUtil を共有)。
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
      U.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }

    _decodeSample(start, end) {
      const rom = this.rom;
      const e = Math.min(end, start + MAX_SAMPLE_BYTES, rom.length);
      const n = Math.max(0, e - start);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = ((rom[start + i] & 0x7F) - 0x40) / 64;
      return pcm;
    }

    /** スナップショットの sample({kind,start,end}) → デコード済みPCM(ga20.js samplePcm と同契約) */
    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.start, sample.end);
    }

    /** 打楽器/音階の手動上書き(ga20.js setSampleKind と同契約) */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end);
      return { kind: kind || null, needsTuning: needsTuning };
    }

    /** 手動ピッチ補正(表示専用。ga20.js setSampleTuning と同じ永続化) */
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

  // 鍵盤表示用スナップショット(snapshotGA20 と同じ形の配列2要素)
  Emu.snapshotK007232 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const rate = chip.playRate(c);
      // ★サンプルの同定/復号は必ず「バンク込みのROM絶対アドレス」で行う(2026-09-17)。
      //   開始アドレスレジスタ(0x02-0x04)は17bitしか無く、A17以上は外部バンク(VGMでは
      //   レジスタ0x14/0x15、単位0x20000)で決まる。再生(_calcSample)は c.bank を足して
      //   いるのに、ここだけ c.start のままだった。Haunted Castle はサンプルが全て
      //   0x20000 以降にあるため、解析側はゼロ埋めの領域を読み:
      //     ・終端マーカ(bit7)が見つからず 64KB まで走る
      //     ・復号したPCMが全点 -1.0(バイト0x00)の直流になる
      //   → ドラムパッドの原音も、そこから焼いた @DPCM も「直流=ほぼ無音」になっていた。
      //   バンクは外部ピン相当で再生中に変わるので、再生と同じく現在値をそのまま使う。
      const base = c.bank + c.start;
      const end = c.seq ? chip.sampleEnd(base) : base;
      const p = c.seq ? chip.samplePitch('k007232', base, end) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, end - base);
      // 左右の音量レジスタ(0-255)。片側0でも鳴っているので大きい方を発音量とみなす
      const vol = Math.max(c.volL, c.volR) / 255;
      // ★L/R列は0-15の整数が全チップ共通の表示規約(c140 と同じ volL>>4)。0..1の小数を入れると
      //   「0.2」のような別スケールの値が並んで読めない
      out.push({ active: c.play && vol > 0, vol, rawVol: Math.max(c.volL, c.volR), rawVolMax: 255,
        panL: c.volL >> 4, panR: c.volR >> 4,
        rate, seq: c.seq, lenSec: rate > 0 ? lenBytes / rate : 0,
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual),
        sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'k007232', start: base, end } : null });
    }
    return out;
  };

  Emu.K007232Audio = K007232Audio;
})(window);
