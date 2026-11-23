/*
 * MML.Emu.Es5505Audio — Ensoniq ES5505(OTIS)。32 声の波形メモリ音源(16bit PCM、直線補間、声ごとに 4 段のデジタルフィルタ、出力 4 組)。
 * MAME の src/devices/sound/es5506.cpp(es5505_device。Aaron Giles ほか、BSD-3-Clause)の写し。
 *
 * レジスタは 16 本(番地/2)で、ページ(レジスタ 15)で声と面を切り替える: ページ 0x00-0x1F = 声の設定、0x20-0x3F = フィルタの状態、0x40- = 試験用。
 * 波形は 16bit の語の列で渡す(rom: Int16Array)。声ごとのバンク(setBank)は基板側の回路で、語の番地の上位に足される。
 * 出力: clock() で 1 サンプル進め、out[0..7](4 組ぶんの左右、20bit の整数)に入る。レートは clock / (16 × (発音数 + 1))。
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const M = 0x7fffffff;
  // ES5510 とのつなぎ(MAME の taito_en.cpp / esqpump.cpp と同じ尺度): 入力 = 20bit の値 ÷ 2^19 × 0.18 × 1.3125 × 32768、出力はその逆
  const ESP_IN = 0.18 * 1.3125 * 32768 / 524288, ESP_OUT = 0.18 * 1.3125 * 32768;
  const VOL_TAB = new Int32Array(256);
  for (let i = 0; i < 256; i++) VOL_TAB[i] = (((i & 15) | 16) << 11) >>> (16 - (i >> 4));
  const lp = (out, cutoff, inp) => Math.trunc((cutoff >> 4) * (out - inp) / 4096) + inp;
  const hp = (out, cutoff, inp, prev) => out - prev + Math.trunc((cutoff >> 4) * inp / 8192) + Math.trunc(inp / 2);
  const s16 = (v) => v << 16 >> 16;

  class Es5505Audio {
    /** @param clock 音源に入るクロック(タイトーの基板は 15238090) @param rom 波形(Int16Array。語の番地で引く) */
    constructor(clock, rom) {
      this.clockHz = clock || 15238090;
      this.rom = rom || new Int16Array(0);
      this.romMask = this.rom.length ? (1 << Math.ceil(Math.log2(this.rom.length))) - 1 : 0;
      this.mute = new Array(32).fill(false);
      this.vol = new Array(32).fill(1);
      this.out = new Float64Array(8);
      this.captureOnly = false;          // true で音を作らない(位置と停止だけ進める)
      this.esp = null;                   // 後段の ES5510(attachEsp で付ける)。付いていれば、出力の組 1〜3 はここを通る
      this.espBypass = false;            // true で ES5510 を通さず、4 組を足すだけにする(聴き比べ用)
      this.reset();
    }
    reset() {
      this.v = [];
      for (let j = 0; j < 32; j++) this.v.push({ control: 3, freq: 0, start: 0, end: 0, accum: 0, lvol: 0x80, rvol: 0x80, k1: 0, k2: 0, o1n1: 0, o2n1: 0, o2n2: 0, o3n1: 0, o3n2: 0, o4n1: 0, bank: 0, seq: 0, kStart: 0, kEnd: 0, kLoop: 0 });   // seq 以降は表示用の控え(キーオンの通番、その時の波形の語の番地)
      this.page = 0; this.active = 31; this.irqv = 0x80; this.mode = 0; this.nat = 0;
      this.q = []; this.qHead = 0; this.outL = 0; this.outR = 0;
      if (!this._pitchCache) this._pitchCache = new Map();   // '開始:終了' → 波形の解析の控え
    }
    get sampleRate() { return this.clockHz / (16 * (this.active + 1)); }
    setRom(rom) { this.rom = rom; this.romMask = rom.length ? (1 << Math.ceil(Math.log2(rom.length))) - 1 : 0; }
    /** 声ごとの波形バンク(基板側の回路)。addWords = 語の番地に足す値 */
    setBank(voice, addWords) { this.v[voice & 31].bank = addWords >>> 0; }
    _sample(v, ia) { return this.rom[(v.bank + (ia & 0xfffff)) & this.romMask] | 0; }

    write(off, data, mask) {
      if (mask === undefined) mask = 0xffff;
      const lo = mask & 0x00ff, hi = mask & 0xff00;
      if (off === 0x0f) { if (lo) this.page = data & 0x7f; return; }
      if (off === 0x0d) { if (lo) this.active = data & 0x1f; return; }
      if (off === 0x0e) return;
      const v = this.v[this.page & 0x1f];
      // 16bit のうち書かれた側だけ入れ替える
      const part = (old, val, m) => (old & ~(mask & m)) | (val & mask & m);
      if (this.page < 0x20) {
        switch (off) {
          case 0x00: { const was = v.control; v.control = (v.control | 0xf000); if (lo) v.control = (v.control & ~0xff) | (data & 0xff); if (hi) v.control = (v.control & ~0x0f00) | (data & 0x0f00); if ((was & 3) && !(v.control & 3)) this._keyOn(v); break; }
          case 0x01: { const cur = (v.freq >>> 1) & 0xfffe; v.freq = (part(cur, data, 0xfffe) << 1) >>> 0; break; }
          case 0x02: { const cur = (v.start >>> 18) & 0x1fff; v.start = ((v.start & 0x0003ffff) | (part(cur, data, 0x1fff) << 18)) >>> 0; break; }
          case 0x03: { const cur = (v.start >>> 2) & 0xffe0; v.start = ((v.start & ~0x0003ff80) | (part(cur, data, 0xffe0) << 2)) >>> 0; break; }
          case 0x04: { const cur = (v.end >>> 18) & 0x1fff; v.end = ((v.end & 0x0003ffff) | (part(cur, data, 0x1fff) << 18)) >>> 0; break; }
          case 0x05: { const cur = (v.end >>> 2) & 0xffe0; v.end = ((v.end & ~0x0003ff80) | (part(cur, data, 0xffe0) << 2)) >>> 0; break; }
          case 0x06: v.k2 = part(v.k2, data, 0xfff0); break;
          case 0x07: v.k1 = part(v.k1, data, 0xfff0); break;
          case 0x08: if (hi) v.lvol = data >> 8 & 0xff; break;
          case 0x09: if (hi) v.rvol = data >> 8 & 0xff; break;
          case 0x0a: { const cur = (v.accum >>> 18) & 0x1fff; v.accum = ((v.accum & 0x0003ffff) | (part(cur, data, 0x1fff) << 18)) >>> 0; break; }
          case 0x0b: { const cur = (v.accum >>> 2) & 0xffff; v.accum = ((v.accum & ~0x0003fffc) | (part(cur, data, 0xffff) << 2)) >>> 0; break; }
        }
      } else if (this.page < 0x40) {
        switch (off) {
          case 0x00: v.control |= 0xf000; if (lo) v.control = (v.control & ~0xff) | (data & 0xff); if (hi) v.control = (v.control & ~0x0f00) | (data & 0x0f00); break;
          case 0x01: v.o4n1 = s16(part(v.o4n1 & 0xffff, data, 0xffff)); break;
          case 0x02: v.o3n1 = s16(part(v.o3n1 & 0xffff, data, 0xffff)); break;
          case 0x03: v.o3n2 = s16(part(v.o3n2 & 0xffff, data, 0xffff)); break;
          case 0x04: v.o2n1 = s16(part(v.o2n1 & 0xffff, data, 0xffff)); break;
          case 0x05: v.o2n2 = s16(part(v.o2n2 & 0xffff, data, 0xffff)); break;
          case 0x06: v.o1n1 = s16(part(v.o1n1 & 0xffff, data, 0xffff)); break;
        }
      } else if (off === 0x08) {
        this.mode |= 0x7f8;
        if (hi) this.mode = (this.mode & ~0xf800) | (data & 0xf800);
        if (lo) this.mode = (this.mode & ~0x0007) | (data & 0x0007);
      }
    }
    read(off) {
      if (off === 0x0f) return this.page;
      if (off === 0x0d) return this.active;
      if (off === 0x0e) { const r = this.irqv; this.irqv = 0x80; return r; }
      const v = this.v[this.page & 0x1f];
      if (this.page < 0x20) {
        switch (off) {
          case 0x00: return v.control | 0xf000;
          case 0x01: return (v.freq >>> 1) & 0xffff;
          case 0x02: return (v.start >>> 18) & 0xffff;
          case 0x03: return (v.start >>> 2) & 0xffff;
          case 0x04: return (v.end >>> 18) & 0xffff;
          case 0x05: return (v.end >>> 2) & 0xffff;
          case 0x06: return v.k2;
          case 0x07: return v.k1;
          case 0x08: return v.lvol << 8;
          case 0x09: return v.rvol << 8;
          case 0x0a: return (v.accum >>> 18) & 0xffff;
          case 0x0b: return (v.accum >>> 2) & 0xffff;
          default: return 0;
        }
      }
      if (this.page < 0x40) {
        switch (off) {
          case 0x00: return v.control | 0xf000;
          case 0x01: return v.o4n1 & 0xffff;
          case 0x02: return v.o3n1 & 0xffff;
          case 0x03: return v.o3n2 & 0xffff;
          case 0x04: return v.o2n1 & 0xffff;
          case 0x05: return v.o2n2 & 0xffff;
          case 0x06:
            // タイトー F3 のドライバは、止めた声のアキュムレータに番地を入れてここを読み、波形 ROM の中身を取り出す(MAME と同じ扱い)
            if (v.control & 3) v.o1n1 = this._sample(v, (v.accum & M) >>> 11);
            return v.o1n1 & 0xffff;
          default: return 0;
        }
      }
      if (off === 0x08) return this.mode;
      return 0;
    }
    // キーオン: 表示用に、その時の波形の範囲を控える。番地は語の番地(バンクつき)。鳴り始めはアキュムレータの位置、ループは開始〜終端
    _keyOn(v) {
      v.seq++;
      const m = this.romMask >>> 0, at = (v.accum & M) >>> 11, st = v.start >>> 11, en = (v.end >>> 11) + 1;
      v.kStart = ((v.bank + Math.min(at, st)) & m) >>> 0; v.kEnd = ((v.bank + en) & m) >>> 0; v.kLoop = ((v.bank + st) & m) >>> 0;
      if (v.kEnd <= v.kStart) v.kEnd = v.kStart;
    }
    // ── 鍵盤表示・ロール・変換が使う口(ZSG-2 / CPS3 / QSound と同じ形)──
    /** 再生レート(1 秒あたりの波形のサンプル数)。周波数レジスタは 1 サンプルに進む語数 × 2048 */
    playRate(i) { return this.v[i].freq / 2048 * (this.clockHz / 512); }
    // 語の区間 → -1..1 の波形(最大 65536 サンプル)
    _decodeSample(start, end) {
      const n = Math.max(0, Math.min(end, start + 65536, this.rom.length) - start), pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = this.rom[start + i] / 32768;
      return pcm;
    }
    /** 波形の基本周期の解析(控えつき)。音程が取れない時はループ長から周期を出す */
    samplePitch(kind, start, end, loop) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom.length) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      if (!U) return null;
      const pcm = this._decodeSample(start, end);
      let auto = U.detectCps(pcm), wavePcm = pcm;
      if (auto.conf < 0.5 && loop && loop >= start && loop < end) {
        const loopLen = end - loop;
        if (loopLen >= 16 && loopLen <= 16384) { const one = this._decodeSample(loop, end), r2 = U.loopCps(one); if (r2) { auto = r2; wavePcm = one; } }
      }
      const b = Math.min(this.rom.length, start + 65536, end), bytes = new Uint8Array(this.rom.buffer, this.rom.byteOffset + start * 2, Math.max(0, b - start) * 2);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: U.sampleHash(bytes, 0, bytes.length), wave: null, lenBytes: pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      U.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    /** 打楽器/音階の手動上書き(kind: 'drum' | 'pitch' | null) */
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
    /** 手動のピッチ補正 */
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

    /** 後段の ES5510 を付ける(タイトーの基板のつなぎ方: 組 0 はそのまま出力へ、組 1〜3 が ES5510 の入力 ser0〜2、ES5510 の ser3 が出力) */
    attachEsp() { if (!this.esp && Emu.createEs5510) { this.esp = Emu.createEs5510(); this._espIn = new Int16Array(6); } return this.esp; }
    // ── VGM(規格外 ENSX)と録音の「キー」での書き込み ──
    //   0x000-0x00F = レジスタ(16bit)、0x100+レジスタ = 上位バイトだけ、0x200+レジスタ = 下位バイトだけ、
    //   0x400+声 = 波形のバンク(語の番地の上位。値 × 0x100000 語)、0x2200 = 2 声の中身を入れ替える(上位/下位バイトが声の番号)、0x2201 = その声を止める
    //   0x1000+ = ES5510、0x2000 = ESPHALT、0x2100+ = 音量 IC(ここでは使わない)
    writeKey(key, value) {
      if (key < 0x10) this.write(key, value, 0xffff);
      else if (key >= 0x100 && key < 0x110) this.write(key & 15, value, 0xff00);
      else if (key >= 0x200 && key < 0x210) this.write(key & 15, value, 0x00ff);
      else if (key >= 0x400 && key < 0x420) this.setBank(key & 31, (value & 0xff) * 0x100000);
      else if (key === 0x2200) { const a = value >> 8 & 31, b = value & 31, t = this.v[a]; this.v[a] = this.v[b]; this.v[b] = t; }
      else if (key === 0x2201) this.v[value & 31].control |= 1;
      else if (key >= 0x1000 && key < 0x1100) { if (this.esp) this.esp.hostW(key - 0x1000, value); }
      else if (key === 0x2000) { if (this.esp) this.esp.halted = !!value; }
    }
    queueWrite(delay, key, value) {
      if (delay <= 0 && this.qHead >= this.q.length) { this.writeKey(key, value); return; }
      this.q.push(this.nat + Math.max(0, delay), key, value);
    }
    /** 通し番号 n のサンプルの前に効く書き込みを積む */
    queueWriteAt(n, key, value) {
      if (n <= this.nat && this.qHead >= this.q.length) { this.writeKey(key, value); return; }
      this.q.push(Math.max(n, this.nat), key, value);
    }
    _drain() {
      const q = this.q;
      while (this.qHead < q.length && q[this.qHead] <= this.nat) { this.writeKey(q[this.qHead + 1], q[this.qHead + 2]); this.qHead += 3; }
      if (this.qHead >= q.length) { q.length = 0; this.qHead = 0; }
    }
    flushWrites() { const q = this.q; for (let i = this.qHead; i < q.length; i += 3) this.writeKey(q[i + 1], q[i + 2]); q.length = 0; this.qHead = 0; }
    /** 8bit の波形を置く(語の上位バイトになる)。addr = 語の番地。飛び飛びに何度でも呼べる */
    loadRom8(addr, data) {
      if (!data || !data.length) return;
      if (addr + data.length > this.rom.length) { let n = 1; while (n < addr + data.length) n <<= 1; const g = new Int16Array(n); g.set(this.rom); this.rom = g; this.romMask = n - 1; }
      for (let i = 0; i < data.length; i++) this.rom[addr + i] = (data[i] << 8) << 16 >> 16;
      if (this._pitchCache) this._pitchCache.clear();
    }
    mixSample() { return { left: this.outL, right: this.outR }; }
    getState() {
      return { v: this.v.map((v) => Object.assign({}, v)), page: this.page, active: this.active, irqv: this.irqv, mode: this.mode, nat: this.nat, outL: this.outL, outR: this.outR, q: this.q.slice(this.qHead), esp: this.esp ? this.esp.getState() : null };
    }
    setState(s) {
      this.v = s.v.map((v) => Object.assign({}, v)); this.page = s.page; this.active = s.active; this.irqv = s.irqv; this.mode = s.mode; this.nat = s.nat;
      this.outL = s.outL; this.outR = s.outR; this.q = s.q.slice(); this.qHead = 0;
      if (this.esp && s.esp) this.esp.setState(s.esp);
    }
    clock() {
      if (this.qHead < this.q.length) this._drain();
      this.nat++;
      const out = this.out, quiet = this.captureOnly;
      out[0] = out[1] = out[2] = out[3] = out[4] = out[5] = out[6] = out[7] = 0;
      for (let n = 0; n <= this.active; n++) {
        const v = this.v[n];
        if (!(v.control & 3)) {
          let accum = v.accum & M;
          const rev = v.control & 0x40;
          if (!quiet) {
            const ia = accum >>> 11, fr = accum & 0x7ff;
            let s = (this._sample(v, ia) * (2048 - fr) + this._sample(v, ia + 1) * fr) >> 11;
            s = lp(s, v.k1, v.o1n1); v.o1n1 = s;
            s = lp(s, v.k1, v.o2n1); v.o2n2 = v.o2n1; v.o2n1 = s;
            switch (v.control >> 10 & 3) {
              case 0: s = hp(s, v.k2, v.o3n1, v.o2n2); v.o3n2 = v.o3n1; v.o3n1 = s; s = hp(s, v.k2, v.o4n1, v.o3n2); v.o4n1 = s; break;
              case 1: s = lp(s, v.k1, v.o3n1); v.o3n2 = v.o3n1; v.o3n1 = s; s = hp(s, v.k2, v.o4n1, v.o3n2); v.o4n1 = s; break;
              case 2: s = lp(s, v.k2, v.o3n1); v.o3n2 = v.o3n1; v.o3n1 = s; s = lp(s, v.k2, v.o4n1); v.o4n1 = s; break;
              default: s = lp(s, v.k1, v.o3n1); v.o3n2 = v.o3n1; v.o3n1 = s; s = lp(s, v.k2, v.o4n1); v.o4n1 = s; break;
            }
            if (!this.mute[n]) {
              const k = this.vol[n]; if (k !== 1) s = Math.round(s * k);
              const ch = (v.control >> 8 & 3) << 1;
              out[ch] += Math.floor(s * VOL_TAB[v.lvol] / 2048); out[ch + 1] += Math.floor(s * VOL_TAB[v.rvol] / 2048);
            }
          }
          accum = rev ? (accum - v.freq) & M : (accum + v.freq) & M;
          if (!rev) {
            if (accum > v.end) {
              if (v.control & 0x20) v.control |= 0x80;
              const m = v.control & 0x18;
              if (m === 0x08) accum = (v.start + (accum - v.end)) & M;
              else if (m === 0x18) { accum = (v.end - (accum - v.end)) & M; v.control ^= 0x40; }
              else v.control |= 1;
            }
          } else if (accum < v.start) {
            if (v.control & 0x20) v.control |= 0x80;
            const m = v.control & 0x18;
            if (m === 0x08) accum = (v.end - (v.start - accum)) & M;
            else if (m === 0x18) { accum = (v.start + (v.start - accum)) & M; v.control ^= 0x40; }
            else v.control |= 1;
          }
          v.accum = accum;
        }
        // 割り込みの印: ベクタが空いていれば声の番号を入れる
        if ((v.control & 0x80) && (this.irqv & 0x80)) { this.irqv = n & 0x1f; v.control &= ~0x80; }
      }
      // 左右(-1〜1 の目安。20bit を 1.0 とする)
      const esp = this.esp;
      if (esp && !quiet && !this.espBypass && !esp.halted) {
        // ES5510 の入力は 16bit。MAME のつなぎ方と同じ尺度(ES5505 の 20bit × 0.18 × 音量 IC 1.3125 を 16bit に)で渡し、出力を同じ比で戻す。
        // こうすると、ES5510 が素通しのプログラムなら「4 組を足しただけ」と同じ大きさになる
        const inp = this._espIn, k = ESP_IN;
        for (let i = 0; i < 6; i++) { const x = Math.trunc(out[i + 2] * k); inp[i] = x > 32767 ? 32767 : x < -32768 ? -32768 : x; }
        esp.run(inp);
        this.outL = out[0] / 524288 + esp.out[0] / ESP_OUT; this.outR = out[1] / 524288 + esp.out[1] / ESP_OUT;
      } else { this.outL = (out[0] + out[2] + out[4] + out[6]) / 524288; this.outR = (out[1] + out[3] + out[5] + out[7]) / 524288; }
    }
  }
  // 鍵盤表示用のスナップショット(CPS3 / QSound / ZSG-2 と同じ形の配列 32 要素)。
  //   音量 = 左右の大きい方(8bit の指数つきの値を振幅に直した比)。発音中 = 止まっておらず、音量が 0 でない(ドライバは音量でエンベロープを作る)
  Emu.snapshotEs5505 = function (chip) {
    const out = [];
    for (let i = 0; i < 32; i++) {
      const e = chip.v[i], seq = e.seq, rate = chip.playRate(i);
      const l = VOL_TAB[e.lvol], r = VOL_TAB[e.rvol], m = Math.max(l, r), loop = (e.control & 0x08) !== 0;
      const p = seq ? chip.samplePitch('es5505', e.kStart, e.kEnd, loop ? e.kLoop : 0) : null;
      const len = p ? p.lenBytes : Math.max(0, e.kEnd - e.kStart);
      // 音量レジスタは指数つき(上位 4bit が桁)なので、表示の音量は振幅ではなくレジスタの値の比で出す(振幅の比だと、ふつうの音量でも数 % にしかならない)
      const raw = Math.max(e.lvol, e.rvol);
      out.push({ active: !(e.control & 3) && rate > 0 && raw >= 0x10, vol: raw / 255, rawVol: raw, rawVolMax: 0xFF,
        panL: m ? Math.round(l / m * 15) : 0, panR: m ? Math.round(r / m * 15) : 0,
        rate, seq, loop, lenSec: loop ? Infinity : (rate > 0 ? len / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: seq ? { kind: 'es5505', start: e.kStart, end: e.kEnd } : null });
    }
    return out;
  };
  Emu.Es5505Audio = Es5505Audio;
})(typeof window !== 'undefined' ? window : globalThis);
