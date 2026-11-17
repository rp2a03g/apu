/*
 * CP システム III 本体のステート(状態の保存・復元)と巻き戻し
 * MML.Emu.Cps3State / MML.Emu.Cps3Rewind(DESIGN-CPS3-CAPTURE.md §12)
 *
 *   - ステート: 他の機種のような「オブジェクトの木を汎用に写す」方式ではなく、本体(cps3Machine.js saveState)が項目を並べて作る
 *     (本体は DataView や暗号を解いた ROM の写しを持っていて、木ごと写すと数十 MB になるため)。ROM は入れない。
 *     大きい配列は 64KB のページに分け、前回の状態と同じページは前回の物を指す(巻き戻しの控えを小さくする)
 *   - 巻き戻し: nes/nesRewind.js の仕組み(0.5 秒ごとのステート+毎フレームのパッド値+逆再生用の画面の輪)をそのまま使う。
 *     違うのはパッドの値が 8bit に収まらない所(ショット 3〜6、テスト、サービスが上位にある)で、控え方と進め直しだけ書き直している
 * 形: { v: 1, machine: 'cps3', game, m, chip, nextSample, outAt, pad }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const Cps3State = {
    /** prev: 前回の状態(同じページを共有する。省略可) */
    save(c, prev) {
      return { v: 1, machine: 'cps3', game: c.game, m: c.machine.saveState(prev && prev.m), chip: c.chip.getState(),
        nextSample: c.nextSample, outAt: c.outAt, pad: [c.pad[0], c.pad[1]] };
    },
    // 同じゲームで作ったステートを書き戻す。合わなければ false
    load(c, state) {
      if (!state || state.v !== 1 || state.machine !== 'cps3' || !state.m || state.game !== c.game) return false;
      c.machine.loadState(state.m);
      c.chip.setState(state.chip);
      c.nextSample = state.nextSample; c.outAt = state.outAt;
      c.pad[0] = state.pad[0] | 0; c.pad[1] = state.pad[1] | 0;
      c.frameCount = c.machine.frame;
      c._applyPad();
      c.machine.renderScreen(c._rgba); c.frameWidth = c.machine.screenWidth;
      return true;
    },
  };

  const RW_W = 384, RW_H = 224;
  class Cps3Rewind extends (Emu.NesRewind || class {}) {
    constructor(c) {
      super(c, { State: null, frameBytes: RW_W * RW_H, keep: 60 });   // 30 秒ぶん
      this._last = null;
      // 状態は前回の物とページを共有させる
      this.State = { save: (x) => { const s = Cps3State.save(x, this._last); this._last = s; return s; }, load: (x, s) => Cps3State.load(x, s) };
      this.idxWidth = RW_W;
      this._pal = new Uint32Array(256);
    }
    clear() { super.clear(); this._last = null; }
    get palette() { return this._pal.slice(); }
    // 今の画面(RGBA)を「色の番号 8bit+その画面の色表」にして輪に控える。輪は常に 384 幅(496 幅の画面は横を間引く)。
    // 256 色に収まる画面(テストモードなど)はそのままの色、超える画面は赤 3bit・緑 3bit・青 2bit に丸める(逆再生の間だけの絵なので粗くてよい)
    _capture(f) {
      const RING = Emu.NesRewind.RING, FB = this.frameBytes, src = this.nes.frame;
      if (!this.ring) this.ring = new Uint8Array(RING * FB);
      if (!this.palRing) this.palRing = new Uint32Array(RING * 256);
      const slot = f % RING, out = this.ring.subarray(slot * FB, slot * FB + FB), pal = this._pal, map = new Map();
      const SW = this.nes.frameWidth || RW_W, step = SW / RW_W;
      let n = 0, over = false;
      for (let y = 0, i = 0; y < RW_H && !over; y++) {
        const row = y * SW;
        for (let x = 0; x < RW_W; x++, i++) {
          const col = src[row + ((x * step) | 0)];
          let k = map.get(col);
          if (k === undefined) { if (n >= 256) { over = true; break; } k = n; pal[n++] = col; map.set(col, k); }
          out[i] = k;
        }
      }
      if (over) {
        // 色は ABGR(下位が赤)。5bit ずつしか無いので、上位 3bit・3bit・2bit を取る
        for (let y = 0, i = 0; y < RW_H; y++) {
          const row = y * SW;
          for (let x = 0; x < RW_W; x++, i++) { const col = src[row + ((x * step) | 0)]; out[i] = ((col >> 5) & 7) | (((col >> 13) & 7) << 3) | (((col >> 22) & 3) << 6); }
        }
        for (let k = 0; k < 256; k++) pal[k] = (0xFF000000 | (((k & 7) * 255 / 7) | 0) | ((((k >> 3) & 7) * 255 / 7 | 0) << 8) | (((k >> 6) * 85) << 16)) >>> 0;
        n = 256;
      }
      for (let k = n; k < 256; k++) pal[k] = 0xFF000000;
      this.palRing.set(pal, slot * 256);
      this.ringFrame[slot] = f;
    }
    paletteOf(f) {
      const RING = Emu.NesRewind.RING, slot = f % RING;
      if (!this.palRing || this.ringFrame[slot] !== f) return this.palette;
      return this.palRing.slice(slot * 256, slot * 256 + 256);
    }
    // ── ここから下は nesRewind.js と同じ流れで、パッドの値を 16bit × 2 で控える所だけが違う ──
    _packPads() { const c = this.nes; return (c.pad[0] & 0xFFFF) + (c.pad[1] & 0xFFFF) * 65536; }
    _unpackPads(p) { const c = this.nes; c.pad[0] = p % 65536; c.pad[1] = Math.floor(p / 65536); c._applyPad(); }
    onFrame() {
      if (this.replaying) return;
      const c = this.nes, f = c.frameCount;
      if (this.base > f) this.clear();
      this.pads[f - this.base] = this._packPads();
      this._capture(f);
      if (f % this.interval === 0) {
        this.snaps.push({ frame: f, state: this.State.save(c) });
        if (this.snaps.length > this.keep) {
          this.snaps.shift();
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.pads.splice(0, keepFrom - this.base); this.base = keepFrom; }
        }
      }
    }
    regenStep(n) {
      const rv = this.rv;
      if (!rv || !rv.regen) return;
      const c = this.nes, g = rv.regen;
      for (let k = 0; k < n && g.next <= g.upto; k++) {
        const p = this.pads[g.next - this.base];
        if (p !== undefined) this._unpackPads(p);
        c.runFrame();
        this._capture(c.frameCount);
        g.next = c.frameCount + 1;
      }
      if (g.next > g.upto) { rv.regen = null; this.replaying = false; }
    }
    rewindTo(frame, force) {
      const c = this.nes;
      if (!this.snaps.length || (frame >= c.frameCount && !force)) return c.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const snap = this.snaps[si];
      const held = [c.padHeld[0], c.padHeld[1]];   // 今押している物は、状態を読む前に控える(nesRewind.js と同じ理由)
      this.State.load(c, snap.state);
      this.replaying = true;
      try {
        while (c.frameCount < frame) {
          const p = this.pads[c.frameCount + 1 - this.base];
          if (p !== undefined) this._unpackPads(p);
          c.runFrame();
          this._capture(c.frameCount);
        }
      } finally { this.replaying = false; }
      this.snaps.length = si + 1;
      this._last = this.snaps[si].state;
      this.pads.length = Math.max(0, c.frameCount + 1 - this.base);
      c.pad[0] = held[0]; c.pad[1] = held[1]; c.padHeld[0] = held[0]; c.padHeld[1] = held[1];
      c._applyPad();
      return c.frameCount;
    }
  }

  Emu.Cps3State = Cps3State;
  Emu.Cps3Rewind = Cps3Rewind;
})(typeof window !== 'undefined' ? window : globalThis);
