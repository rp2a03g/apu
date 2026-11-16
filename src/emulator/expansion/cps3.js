/*
 * カプコン CP システム III の音源(16 ボイス、符号付き 8bit PCM)
 * MML.Emu.Cps3Audio
 *
 * 動作は MAME src/mame/capcom/cps3_a.cpp(BSD-3-Clause、THIRD-PARTY-NOTICES.md)の写し。DESIGN-CPS3-CAPTURE.md §2.1。
 *   出力レート = クロック/384(14.318181MHz → 37286.93Hz)。clock() 1 回 = 1 サンプル
 *   レジスタは 32bit × 8 本 × 16 ボイス。ここでは 16bit 単位(番号 = 番地/2、上位が偶数)で受ける:
 *     reg1 = 開始、reg5 = 終了(上下 16bit が入れ替わった形)、reg2 bit0 = ループ有効、
 *     reg3 上位 = ピッチ(小数 12bit、0x1000 で等速)、reg3 下位+reg4 下位 = ループ位置、
 *     reg7 = 音量(下位 = 出力 0、上位 = 出力 1、符号付き 16bit)
 *   キー = 番号 0x100(番地 0x200 の上位)。0→1 で再生位置を 0 に戻す。エンベロープは無い。終端に来てもキーは落ちない
 *   波形は番地そのまま(0x400000 始まり)で届く。読み順は音源が読む順(VGM の CP3X ブロックがその順で持つ)
 *
 * ★鳴らされる波形の約半分は、2 バイトずつ入れ替えた並びのほうが滑らかに見えるが、正しいのはこの読み順
 *   (市販の移植版に同梱の公式の音と単体で突き合わせて確認。DESIGN-CPS3-CAPTURE.md §2.2)。「直す」と公式の音から離れる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 16;
  const SCALE = 1 / (32768 * 256); // MAME の add_int と同じ尺度(サンプル × 音量 ÷ これ)

  class Cps3Audio {
    /** @param {number} [clock=14318182] - 音源に入るクロック(出力レート = clock/384) */
    constructor(clock) {
      this.clockHz = clock || 14318182;
      this.sampleRate = this.clockHz / 384;
      this.out1Left = true;              // MAME の配線(出力 1 を左スピーカーへ)。CP3X のヘッダのフラグで決まる
      this.rom = new Uint8Array(0);      // 波形(romBase 番地が rom[0])
      this.romBase = 0;
      this.romXor = 0;                   // 1 にすると 2 バイトずつ入れ替えて読む(CD の並びのままの波形を、写しを作らずに使う時)
      this.touched = null;               // Uint8Array を置くと、読んだ所(rom 内の位置 ÷ 256)に 1 を立てる(録音に入れる波形の範囲を決める)
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map();      // '開始:終了' → { cps, conf, … }(鍵盤表示の音程。波形が入れ替わったら捨てる)
      this.reset();
    }
    reset() {
      this.regs = new Uint16Array(0x180); // 16bit 単位。ボイス v の reg r の上位 = v*16 + r*2、下位 = +1
      this.pos = new Uint32Array(NUM_CH);
      this.frac = new Uint32Array(NUM_CH);
      this.seq = new Uint32Array(NUM_CH); // キーオンの通番(鍵盤表示とロールが打ち直しを見分ける)
      this.ended = new Uint8Array(NUM_CH); // ループ無しで終端に来た(キーは立ったまま音は出ない)
      // キーオンの時点の開始/終了/ループ位置(番地)。鍵盤表示と変換が「どの波形か」を見分けるのに使う。
      // 音を出す側は MAME と同じくレジスタを毎サンプル読むので、こちらは表示用の控え
      this.smpStart = new Uint32Array(NUM_CH); this.smpEnd = new Uint32Array(NUM_CH); this.smpLoop = new Uint32Array(NUM_CH);
      this.key = 0;
      this.outL = 0; this.outR = 0;
      this.nat = 0;      // これまでに出したサンプル数
      this.q = [];       // 待っている書き込み(効かせるサンプル番号、レジスタ番号、値 の 3 つ組)。届いた順に効かせる
      this.qHead = 0;
    }
    /** delay サンプル後に効く書き込みを積む(CP3X の書き込みブロックはフレーム内の時刻つきで届く) */
    queueWrite(delay, reg, value) {
      if (delay <= 0 && this.qHead >= this.q.length) { this.write(reg, value); return; }
      this.q.push(this.nat + Math.max(0, delay), reg, value);
    }
    _drain() {
      const q = this.q;
      while (this.qHead < q.length && q[this.qHead] <= this.nat) { this.write(q[this.qHead + 1], q[this.qHead + 2]); this.qHead += 3; }
      if (this.qHead >= q.length) { q.length = 0; this.qHead = 0; }
    }
    /** 待っている書き込みを全部効かせる(シークの早送りの終わりなど、時間経過を再現しない所から呼ぶ) */
    flushWrites() { const q = this.q; for (let i = this.qHead; i < q.length; i += 3) this.write(q[i + 1], q[i + 2]); q.length = 0; this.qHead = 0; }
    /** 波形を置く。addr = レジスタに書かれる番地そのまま。飛び飛びに何度でも呼べる */
    loadRom(addr, data) {
      if (!data || !data.length) return;
      const lo = this.rom.length ? Math.min(this.romBase, addr) : addr;
      const hi = Math.max(this.rom.length ? this.romBase + this.rom.length : 0, addr + data.length);
      if (lo !== this.romBase || hi - lo !== this.rom.length) {
        const grown = new Uint8Array(hi - lo);
        grown.set(this.rom, this.rom.length ? this.romBase - lo : 0);
        this.rom = grown; this.romBase = lo;
      }
      this.rom.set(data, addr - this.romBase);
      this._pitchCache.clear();
    }
    /** 16bit 単位の書き込み(reg = 番地/2) */
    write(reg, value) {
      value &= 0xFFFF;
      if (reg < 0x100) { this.regs[reg] = value; return; }
      if (reg === 0x100) {
        for (let i = 0; i < NUM_CH; i++) if ((value >> i & 1) && !(this.key >> i & 1)) {
          this.frac[i] = 0; this.pos[i] = 0; this.ended[i] = 0; this.seq[i]++;
          this.smpStart[i] = this.startOf(i); this.smpEnd[i] = this.endOf(i); this.smpLoop[i] = this.loopOn(i) ? this.loopOf(i) : 0;
        }
        this.key = value;
      }
    }
    // ボイス v の番地類(レジスタの生値から。MAME と同じく毎サンプル読み直す)
    startOf(v) { const r = v * 16; return ((this.regs[r + 3] << 16) | this.regs[r + 2]) >>> 0; }   // reg1: 下位 16bit が番地の上位
    endOf(v) { const r = v * 16; return ((this.regs[r + 11] << 16) | this.regs[r + 10]) >>> 0; }   // reg5
    loopOf(v) { const r = v * 16; return ((this.regs[r + 9] << 16) | this.regs[r + 7]) >>> 0; }    // reg4 下位 : reg3 下位
    stepOf(v) { return this.regs[v * 16 + 6]; }                                                     // reg3 上位
    loopOn(v) { return (this.regs[v * 16 + 5] & 1) !== 0; }                                         // reg2 下位 bit0
    volOf(v, out) { const x = this.regs[v * 16 + (out ? 14 : 15)]; return (x << 16) >> 16; }        // reg7: 上位 = 出力 1、下位 = 出力 0

    clock() {
      if (this.qHead < this.q.length) this._drain();
      this.nat++;
      let o0 = 0, o1 = 0;
      const rom = this.rom, base = this.romBase, n = rom.length;
      for (let i = 0; i < NUM_CH; i++) {
        if (!(this.key >> i & 1)) continue;
        const start = this.startOf(i), end = this.endOf(i);
        let p = this.pos[i] + (this.frac[i] >>> 12), fr = this.frac[i] & 0xFFF;
        if (start + p >= end) {
          if (this.loopOn(i)) p = (p + this.loopOf(i) - end) >>> 0;
          else { this.pos[i] = p; this.frac[i] = fr; this.ended[i] = 1; continue; } // MAME は break(この更新でこのボイスは進まない)。次も同じ判定に落ちるので位置は動かさなくてよい
        }
        const a = (start + p - base) ^ this.romXor;
        const s = a >= 0 && a < n ? (rom[a] << 24) >> 24 : 0;
        if (this.touched && a >= 0 && a < n) this.touched[a >>> 8] = 1;
        this.pos[i] = p; this.frac[i] = fr + this.stepOf(i);
        if (this.mute[i]) continue;
        const g = this.vol[i];
        o0 += s * this.volOf(i, 0) * g; o1 += s * this.volOf(i, 1) * g;
      }
      if (this.out1Left) { this.outL = o1 * SCALE; this.outR = o0 * SCALE; } else { this.outL = o0 * SCALE; this.outR = o1 * SCALE; }
    }
    mixSample() { return { left: this.outL, right: this.outR }; }

    // シークの控え(波形は含めない。波形はストリームの先頭で入り、控えから戻す時にはもう入っている)
    // ── 鍵盤表示・ロール・変換が使う口(QSound と同じ形。src/emulator/expansion/qsound.js)──
    /** 再生レート(1 秒あたりの波形のバイト数)。ピッチ 0x1000 = 等速(出力レート) */
    playRate(v) { return this.stepOf(v) / 4096 * this.sampleRate; }
    // 番地の区間 → -1..1 の波形(最大 64KB)。番地はレジスタの値そのまま(romBase を引いて、必要なら 2 バイトずつ入れ替えて読む)
    _decodeSample(start, end) {
      const rom = this.rom, base = this.romBase, x = this.romXor;
      const n = Math.max(0, Math.min(end, start + 64 * 1024) - start), pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) { const a = (start + i - base) ^ x; pcm[i] = a >= 0 && a < rom.length ? ((rom[a] << 24) >> 24) / 128 : 0; }
      return pcm;
    }
    /** 波形の基本周期の解析(控えつき)。ループ区間は継ぎ目なく繋がるので、音程が取れない時はループ長から周期を出す(QSound と同じ) */
    samplePitch(kind, start, end, loop) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom.length) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._decodeSample(start, end);
      let auto = U.detectCps(pcm), wavePcm = pcm;
      if (auto.conf < 0.5 && loop && loop >= start && loop < end) {
        const loopLen = end - loop;
        if (loopLen >= 16 && loopLen <= 16384) { const one = this._decodeSample(loop, end), r2 = U.loopCps(one); if (r2) { auto = r2; wavePcm = one; } }
      }
      // 中身のハッシュは「音源が読む順のバイト列」で取る(本体の録音中と VGM の再生とで波形の持ち方が違っても同じ値になるように)
      const n = Math.min(end - start, 64 * 1024), bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const a = (start + i - this.romBase) ^ this.romXor; bytes[i] = a >= 0 && a < this.rom.length ? this.rom[a] : 0; }
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: U.sampleHash(bytes, 0, n), wave: null, lenBytes: pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      U.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    /** 打楽器/音階の手動上書き(kind: 'drum' | 'pitch' | null)。QSound と同じ */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end);
      return { kind: kind || null, needsTuning };
    }
    samplePcm(sample) { return sample ? this._decodeSample(sample.start, sample.end) : null; }
    /** 手動のピッチ補正。QSound と同じ */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const U = Emu.SamplePitchUtil, map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      U.saveTuningMap(map);
      r.wave = U.makeSampleWave(this._decodeSample(start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }

    getState() { return { smpStart: this.smpStart.slice(), smpEnd: this.smpEnd.slice(), smpLoop: this.smpLoop.slice(), regs: this.regs.slice(), pos: this.pos.slice(), frac: this.frac.slice(), seq: this.seq.slice(), ended: this.ended.slice(), key: this.key, outL: this.outL, outR: this.outR, nat: this.nat, q: this.q.slice(this.qHead) }; }
    setState(s) { if (s.smpStart) { this.smpStart.set(s.smpStart); this.smpEnd.set(s.smpEnd); this.smpLoop.set(s.smpLoop); } this.regs.set(s.regs); this.pos.set(s.pos); this.frac.set(s.frac); this.seq.set(s.seq); this.ended.set(s.ended); this.key = s.key; this.outL = s.outL; this.outR = s.outR; this.nat = s.nat; this.q = s.q.slice(); this.qHead = 0; }
  }

  // 鍵盤表示用のスナップショット(QSound と同じ形の配列 16 要素)。
  //   音量は 16bit 符号付きが 2 つ(出力 0 と出力 1)。大きいほうの絶対値を音量、左右はその比で出す(左右の配線は out1Left)
  //   発音中 = キーが立っていて、終端に来ておらず、ピッチと音量が 0 でない(この音源はキーが立ったまま終端で黙る)
  Emu.snapshotCps3 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const v0 = chip.volOf(i, 0), v1 = chip.volOf(i, 1), a0 = Math.abs(v0), a1 = Math.abs(v1), raw = Math.max(a0, a1);
      const rate = chip.playRate(i), seq = chip.seq[i];
      const start = chip.smpStart[i], end = chip.smpEnd[i], loopAt = chip.smpLoop[i];
      const p = seq ? chip.samplePitch('cps3', start, end, loopAt) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, end - start), loop = loopAt > 0;
      const l = chip.out1Left ? a1 : a0, r = chip.out1Left ? a0 : a1;
      out.push({ active: !!(chip.key >> i & 1) && !chip.ended[i] && rate > 0 && raw > 0, vol: Math.min(1, raw / 0x8000), rawVol: raw, rawVolMax: 0x7FFF, lrWide: true,
        panL: raw ? Math.round(l / raw * 15) : 0, panR: raw ? Math.round(r / raw * 15) : 0,
        rate, seq, loop, lenSec: loop ? Infinity : (rate > 0 ? lenBytes / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: seq ? { kind: 'cps3', start, end } : null });
    }
    return out;
  };

  Emu.Cps3Audio = Cps3Audio;
})(window);
