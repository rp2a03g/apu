/*
 * SegaPCM (315-5218) 16ch PCM 音源 (VGM: chip 'segapcm'。セガ体感筐体
 * OutRun / After Burner / Space Harrier(X Board/Y Board/System 16系)でYM2151とペア)
 * MML.Emu.SegaPCMAudio
 *
 * 8bit符号なしPCM×16ch、ステレオ(ch毎にL/R 7bit音量)。出力レート = clock/128
 * (4MHz → 31.25kHz)。挙動は MAME segapcm.cpp 準拠:
 *   レジスタはRAM配置。chベース=8*ch、相対オフセット:
 *     +0x02/+0x03 音量L/R(7bit) / +0x04/+0x05 ループアドレス(bit8-15/bit16-23) /
 *     +0x06 終了ページ(+1した値と addr>>16 を比較) / +0x07 アドレスデルタ(8bit、
 *     1出力サンプルごとに24bitアドレス(16.8固定小数)へ加算=再生レート) /
 *     +0x84/+0x85 現在アドレス(bit8-15/bit16-23) /
 *     +0x86 bit0=1でch停止(0で再生)、bit1=1でループ無効(終端で自動停止)、上位=バンク
 *   バンク: offset = (reg86 & bankmask) << bankshift。bankshift/bankmask はVGMヘッダ
 *   0x3Cの「Sega PCM interface register」(下位8bit=シフト、bit16-23=マスク。0なら
 *   既定シフト12/マスク0x70=MAMEのBANK_512/BANK_MASK7相当)。
 *   終端: (addr>>16)==end でループ有効ならループアドレスへ、無効なら reg86 bit0 を
 *   自分で立てて停止(実チップと同じ自己停止)。
 * VGM: コマンド 0xC0 bbaa dd(offset=aabb、bit15=デュアル2個目)、ROMはデータブロック
 * type 0x80(ROMサイズ+開始+データ)。
 *
 * ★デルタレジスタで1サンプルを音階演奏できる(GA20/YM2610 ADPCM-Bと同性質)ので、
 * ピッチは Emu.SamplePitchUtil(ym2610.js共有: 基本周期検出×再生レート)で得る。
 * 手動キャリブレーション(setSampleTuning)もYM2610/GA20と同じlocalStorageを共有。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 16;
  const CYCLES_PER_SAMPLE = 128;

  class SegaPCMAudio {
    /**
     * @param {number} [clock=4000000] - マスタークロック(出力レート=clock/128)
     * @param {number} [intf=0] - ヘッダ0x3Cのインターフェースレジスタ(バンク構成)
     */
    constructor(clock, intf) {
      this.clockHz = clock || 4000000;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.bankshift = (intf & 0xFF) || 12;        // 既定 BANK_512
      this._intfMask = (intf >> 16) & 0xFF;        // 0なら既定 0x70(BANK_MASK7)
      this.bankmask = 0;                           // ROMサイズ確定時(loadRom)に再計算
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // 'start:end' → {cps, conf, …}(samplePitch)
      this.reset();
    }
    reset() {
      this.ram = new Uint8Array(0x800);
      this.ch = [];
      // seq: キーオン通番(clock()を回さない先読みキャプチャ用)。smpStart/End: ピッチ解析用の
      // ROM上のサンプル範囲(キーオン時に確定)。loop: キーオン時のループ有効フラグ
      for (let i = 0; i < NUM_CH; i++) this.ch.push({ addr: 0, play: false, bankOffset: 0, seq: 0, smpStart: 0, smpEnd: 0, loop: false, addrDirty: false });
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    _updateBankmask() {
      let romMask = 1;
      const len = this.rom ? this.rom.length : 0;
      while (romMask < len) romMask <<= 1;
      romMask--;
      this.bankmask = (this._intfMask || 0x70) & (romMask >> this.bankshift);
    }

    /** VGMデータブロック 0x80(SegaPCM ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._updateBankmask();
      this._pitchCache.clear();
    }

    /** レジスタRAM書込み(VGM 0xC0 bbaa dd) */
    write(off, val) {
      off &= 0x7FF; val &= 0xFF;
      this.ram[off] = val;
      if (off >= 0x100) return; // chレジスタ域外(スクラッチRAM)
      const c = this.ch[(off >> 3) & 15];
      switch ((off & 0x80) | (off & 7)) {
        // addrDirty: 現在アドレスが書き換えられた印。OutRun等のドライバはワンショットの
        // 再打を「停止せずに +84/+85 を巻き戻して +86 へ同値を再書込み」で行う(実機は
        // 終端の自己停止でbit0が立っているので再始動になる)。regsOnlyキャプチャでは
        // 自己停止が起きずc.playが立ったままなので、「アドレス書換え後のbit0=0書込み」も
        // キーオン(seq++)として扱わないとロール/発音区間推定が最初の1打で止まる。
        case 0x84: c.addr = (c.addr & 0xFF00FF) | (val << 8); c.addrDirty = true; break;
        case 0x85: c.addr = (c.addr & 0x00FFFF) | (val << 16); c.addrDirty = true; break;
        case 0x86: {
          c.bankOffset = (val & this.bankmask) << this.bankshift;
          const on = !(val & 1);
          if (on && (!c.play || c.addrDirty)) { // キーオン/リトリガー: 小数部クリア、サンプル範囲を確定
            c.addr &= 0xFFFF00;
            c.seq++;
            c.loop = !(val & 2);
            c.addrDirty = false;
            const base = (off & 0x78);
            c.smpStart = c.bankOffset + (c.addr >> 8);
            c.smpEnd = c.bankOffset + ((this.ram[base + 6] + 1) << 8);
          }
          c.play = on;
          break;
        }
        default: break;
      }
    }

    // 再生レート(1秒あたりのROMバイト数)。デルタ=8bit、アドレスは8bit小数
    playRate(i) { return (this.ram[(i << 3) + 7] / 256) * this.sampleRate; }

    _calcSample() {
      let l = 0, r = 0;
      const rom = this.rom, ram = this.ram;
      if (rom) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.play) continue;
          const base = i << 3;
          const end = ram[base + 6] + 1;
          if ((c.addr >> 16) === end) {
            if (ram[base + 0x86] & 2) { ram[base + 0x86] |= 1; c.play = false; continue; } // 自己停止(実チップ挙動)
            c.addr = (ram[base + 5] << 16) | (ram[base + 4] << 8);
          }
          const v = (rom[c.bankOffset + (c.addr >> 8)] || 0) - 0x80;
          if (!this.mute[i]) {
            l += v * (ram[base + 2] & 0x7F) * this.vol[i];
            r += v * (ram[base + 3] & 0x7F) * this.vol[i];
          }
          c.addr = (c.addr + ram[base + 7]) & 0xFFFFFF;
        }
      }
      // 1chフルスケール = 127*127 ≒ 16129。16ch合算を±1.0程度へ
      this.lastL = l / 32768;
      this.lastR = r / 32768;
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** サンプル(ROM上のstart..end-1)の基本周期解析(キャッシュ)。ga20.jsと同じ設計。 */
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
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = (rom[start + i] - 0x80) / 128;
      return pcm;
    }
    /** 手動ピッチ補正(表示専用)。ga20.js/ym2610.jsと同じlocalStorage永続化。 */
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

  // 鍵盤表示用スナップショット(GA20と同じ形の配列16要素、+loop):
  // { active, vol(0-1), rawVol(L/R大きい方0-127), rawVolMax, panL/panR(0-15表示値),
  //   rate(再生バイトレートHz), seq, lenSec(ループ中はInfinity), loop,
  //   pitchHz, pitchConf, pitchManual, waveData, sample }
  Emu.snapshotSegaPCM = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const base = i << 3;
      const volL = chip.ram[base + 2] & 0x7F, volR = chip.ram[base + 3] & 0x7F;
      const vmax = Math.max(volL, volR);
      const rate = chip.playRate(i);
      const p = c.seq ? chip.samplePitch('segapcm', c.smpStart, c.smpEnd) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, c.smpEnd - c.smpStart);
      out.push({ active: c.play && vmax > 0 && rate > 0, vol: vmax / 127, rawVol: vmax, rawVolMax: 127,
        panL: volL >> 3, panR: volR >> 3,
        rate, seq: c.seq, loop: c.loop, lenSec: c.loop ? Infinity : (rate > 0 ? lenBytes / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual),
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'segapcm', start: c.smpStart, end: c.smpEnd } : null });
    }
    return out;
  };

  Emu.SegaPCMAudio = SegaPCMAudio;
})(window);
