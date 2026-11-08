/*
 * MSX 巻き戻し (MML.Emu.MsxRewind) — nes/nesRewind.js と同じ作り(状態スナップショット+入力ログ+映像の輪)。違いは 3 つ:
 *   1. スナップショットは前回との差分に圧縮して控える(msxState.js の pack/unpack)。KEY_EVERY 個ごとに全量(キーフレーム)、
 *      間は直前からの XOR-RLE。読むときはキーフレームから順に展開する(最長 KEY_EVERY-1 回)。
 *   2. 入力はジョイスティック 2 口(joy[])に加えてキーボードの行(12 バイト)も毎フレーム控える(キー入力で進むゲームの再現に要る)
 *   3. 映像の輪は 8bit の索引(vdp.frameIdx、常に 256 幅。フレームの幅 512 のモードは 1 ドットおき)。表示色は paletteOf(frame)
 *      (パレット番号なら本体の vdp.palette 16 色、GRAPHIC7 のフレームなら GRB332 の 256 色表)。呼び手が rwframe に palette を添える
 * 使い方は NesRewind と同じ: onFrame()/rewindTo(frame)/beginReverse()/reverseStep()/regenStep(n)/endReverse()/clear()/oldest
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INTERVAL = 30;   // スナップショットの間隔(フレーム)。0.5 秒
  const KEEP = 240;      // 控える個数。2 分
  const KEY_EVERY = 16;  // キーフレーム(全量)の間隔。実測(テスト ROM、MSX2 128K+VRAM 128K): 全量 265KB、差分 2.6KB。240 個で 8 なら 13.8MB、16 なら約 8MB
  const RING = 600;      // 映像の輪の枚数(10 秒)
  const KB_ROWS = 12;

  class MsxRewind {
    constructor(msx) {
      this.msx = msx;
      this.snaps = [];          // [{ frame, state(packed or full), key }]
      this.inputs = [];         // inputs[frame - base] = Uint8Array(2 + KB_ROWS): joy0, joy1, 行 0-11
      this.base = 0;
      this.replaying = false;
      this.ring = null;
      this.frameBytes = (msx.frameIdxWidth || msx.frameWidth) * msx.frameHeight; // frameIdx は常に 256 幅(vdp.js)
      this.ringFrame = new Int32Array(RING).fill(-1);
      this.ringKind = new Uint8Array(RING); // そのフレームの frameIdx の種類(0=パレット番号、1=GRB332。GRAPHIC7)
      this.rv = null;
      this._lastFull = null;    // 直近に控えた全量のステート(次の差分の基準)
      this.bytes = 0;           // 控えている状態のおよその合計バイト数(容量の実測用)
    }
    clear() { this.snaps.length = 0; this.inputs.length = 0; this.base = this.msx.frameCount; this.ringFrame.fill(-1); this._lastFull = null; this.bytes = 0; }
    _capture(f) {
      if (!this.ring) this.ring = new Uint8Array(RING * this.frameBytes);
      const slot = f % RING;
      this.ring.set(this.msx.frameIdx, slot * this.frameBytes);
      this.ringFrame[slot] = f;
      this.ringKind[slot] = this.msx.frameIdxKind || 0;
    }
    frameAt(f) {
      const slot = f % RING;
      return this.ring && this.ringFrame[slot] === f ? this.ring.subarray(slot * this.frameBytes, (slot + 1) * this.frameBytes) : null;
    }
    get palette() { return this.msx.vdp.palette; }
    get idxWidth() { return this.msx.frameIdxWidth || this.msx.frameWidth; }
    // フレーム f の映像の輪の表示色(G7 のフレームは 256 色の GRB 表)
    paletteOf(f) { const slot = f % RING; return this.msx.idxPalette ? this.msx.idxPalette(this.ringFrame[slot] === f ? this.ringKind[slot] : 0) : this.msx.vdp.palette; }
    // i 番目のスナップショットを全量で返す(キーフレームから展開)
    _stateAt(i) {
      const S = Emu.MsxState;
      let k = i;
      while (k > 0 && !this.snaps[k].key) k--;
      let st = this.snaps[k].state;
      for (let j = k + 1; j <= i; j++) st = S.unpack(this.snaps[j].state, st);
      return st;
    }
    _inputNow() {
      const m = this.msx, u = new Uint8Array(2 + KB_ROWS);
      u[0] = m.joy[0]; u[1] = m.joy[1];
      u.set(m.keyboard.rows.subarray(0, KB_ROWS), 2);
      return u;
    }
    _applyInput(u) {
      const m = this.msx;
      if (!u) return;
      m.joy[0] = u[0]; m.joy[1] = u[1];
      m.keyboard.rows.set(u.subarray(2, 2 + KB_ROWS));
    }
    beginReverse() {
      if (this.rv || !this.snaps.length) return false;
      const m = this.msx;
      this.rv = { cur: m.frameCount, regen: null, moved: false, wasRec: !!m.rec };
      m.rec = null;
      return this.rv;
    }
    reverseStep() {
      const rv = this.rv;
      if (!rv) return false;
      const target = rv.cur - 1;
      if (target <= this.oldest) return false;
      const img = this.frameAt(target);
      if (img) { rv.cur = target; rv.moved = true; return img; }
      if (!rv.regen) {
        let si = -1;
        for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame < target) { si = i; break; }
        if (si < 0) return false;
        Emu.MsxState.load(this.msx, this._stateAt(si));
        rv.regen = { next: this.snaps[si].frame + 1, upto: target };
        this.replaying = true;
      }
      return null;
    }
    regenStep(n) {
      const rv = this.rv;
      if (!rv || !rv.regen) return;
      const m = this.msx, g = rv.regen;
      for (let k = 0; k < n && g.next <= g.upto; k++) {
        this._applyInput(this.inputs[g.next - this.base]);
        m.runFrame();
        this._capture(m.frameCount);
        g.next = m.frameCount + 1;
      }
      if (g.next > g.upto) { rv.regen = null; this.replaying = false; }
    }
    endReverse() {
      const rv = this.rv;
      if (!rv) return this.msx.frameCount;
      const m = this.msx;
      this.rv = null; this.replaying = false;
      const recNow = !!m.rec; m.rec = null;
      let got = m.frameCount;
      if (rv.moved || rv.regen) got = this.rewindTo(rv.cur, true);
      if (rv.wasRec || recNow) m.startRecording();
      return got;
    }
    get oldest() { return this.snaps.length ? this.snaps[0].frame : this.msx.frameCount; }
    onFrame() {
      if (this.replaying) return;
      const m = this.msx, f = m.frameCount;
      if (this.base > f) this.clear();
      this.inputs[f - this.base] = this._inputNow();
      this._capture(f);
      if (f % INTERVAL === 0) {
        const S = Emu.MsxState;
        const full = S.save(m);
        const key = !this._lastFull || (this.snaps.length % KEY_EVERY) === 0;
        const state = key ? full : S.pack(full, this._lastFull);
        this._lastFull = full;
        this.snaps.push({ frame: f, state, key });
        this.bytes += S.sizeOf(state);
        if (this.snaps.length > KEEP) {
          // 先頭を落とす。先頭は常にキーフレーム(全量)。次が差分なら、落とす物を基準に全量へ戻して新しい先頭をキーフレームにする
          const drop = this.snaps.shift();
          this.bytes -= S.sizeOf(drop.state);
          if (!this.snaps[0].key) {
            const full0 = S.unpack(this.snaps[0].state, drop.state);
            this.bytes -= S.sizeOf(this.snaps[0].state);
            this.snaps[0] = { frame: this.snaps[0].frame, state: full0, key: true };
            this.bytes += S.sizeOf(full0);
          }
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.inputs.splice(0, keepFrom - this.base); this.base = keepFrom; }
        }
      }
    }
    rewindTo(frame, force) {
      const m = this.msx;
      if (!this.snaps.length || (frame >= m.frameCount && !force)) return m.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const full = this._stateAt(si);
      Emu.MsxState.load(m, full);
      const held = [m.joyHeld[0], m.joyHeld[1]], turbo = [m.joyTurbo[0], m.joyTurbo[1]];
      const rowsNow = m.keyboard.rows.slice();
      this.replaying = true;
      try {
        while (m.frameCount < frame) {
          this._applyInput(this.inputs[m.frameCount + 1 - this.base]);
          m.runFrame();
          this._capture(m.frameCount);
        }
      } finally { this.replaying = false; }
      // 未来のスナップショットと入力記録は捨てる。差分の基準は今の状態(全量)に置き直す
      for (let i = si + 1; i < this.snaps.length; i++) this.bytes -= Emu.MsxState.sizeOf(this.snaps[i].state);
      this.snaps.length = si + 1;
      this._lastFull = full;
      if (!this.snaps[si].key) { this.bytes -= Emu.MsxState.sizeOf(this.snaps[si].state); this.snaps[si] = { frame: this.snaps[si].frame, state: full, key: true }; this.bytes += Emu.MsxState.sizeOf(full); }
      this.inputs.length = Math.max(0, m.frameCount + 1 - this.base);
      m.joyHeld[0] = held[0]; m.joyHeld[1] = held[1]; m.joyTurbo[0] = turbo[0]; m.joyTurbo[1] = turbo[1];
      m._applyJoy(0); m._applyJoy(1);
      m.keyboard.rows.set(rowsNow);
      return m.frameCount;
    }
  }
  MsxRewind.INTERVAL = INTERVAL;
  MsxRewind.KEEP = KEEP;
  MsxRewind.RING = RING;
  MsxRewind.KEY_EVERY = KEY_EVERY;
  Emu.MsxRewind = MsxRewind;
})(typeof window !== 'undefined' ? window : globalThis);
