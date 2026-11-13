/*
 * NES 巻き戻し (MML.Emu.NesRewind) — 状態スナップショット+入力ログで任意のフレームへ戻る
 *
 * 仕組み: INTERVAL フレームごとに NesState.save で状態を控え(直近 KEEP 個)、毎フレームの終わりにパッドの値
 * (ゲームが $4016/$4017 で読む値。連射の ON/OFF 後)を記録する。rewindTo(frame) は目標以前の一番近い
 * スナップショットを読み込み、記録したパッド値を与えながら目標フレームまで進める(同じ入力なので同じ結果になる。
 * フレームの途中で変わった入力はそのフレームの終わりの値で代表させるので、そこだけ 1 フレーム以内の違いが出うる)。
 * 録音(rec)はスナップショットに入らないので、戻った後は像から取り直す(呼び出し側)。
 * 使い方: const rw = new NesRewind(nes); 毎フレーム rw.onFrame(); 戻るときは rw.rewindTo(frame)。
 * reset/ステート読込/ディスク交換の後は clear()(履歴が今の状態とつながらない)。
 *
 * 逆再生(押している間の滑らかな巻き戻し、段階 6h): 表示した画面をパレット番号 8bit(ppu.frameIdx、61KB/枚)で RING 枚
 * (10 秒)の輪に控えておき、beginReverse() の後は reverseStep() で 1 枚ずつ古い画面を返す(本体は止めたまま。音は無し)。
 * 輪より前へ戻るときは、その手前のスナップショットを読んで記録したパッドで進め直しながら輪を埋める(regenStep。
 * 1 回 1 フレームなので AudioWorklet の process() の予算に収まり、再生成 344 枚/秒 > 表示 60×速さ で追いつく)。
 * endReverse() で表示していたフレームへ本当に戻る(rewindTo と同じ: スナップショット読込+再生)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INTERVAL = 30;   // スナップショットの間隔(フレーム)。0.5 秒
  const KEEP = 240;      // 控える個数。2 分
  const RING = 600;      // 映像の輪の枚数(10 秒。61KB × 600 = 37MB)
  const FRAME_BYTES = 256 * 240;

  class NesRewind {
    // opt: { State, frameBytes }(GB の GbRewind が差し替える。既定は NES)
    constructor(nes, opt) {
      this.nes = nes;
      this.State = (opt && opt.State) || Emu.NesState;
      this.frameBytes = (opt && opt.frameBytes) || FRAME_BYTES;
      this.snaps = [];          // [{ frame, state }] frame = そのフレームが終わった時点の frameCount
      this.pads = [];           // pads[frameCount] = pad0 | pad1 << 8(そのフレーム終わりの値。フレーム番号は frameCount)
      this.base = 0;            // pads の先頭が指す frameCount(古い分は捨てる)
      this.replaying = false;
      this.ring = null;         // 映像の輪(Uint8Array RING×FRAME_BYTES。最初の capture で確保)
      this.ringFrame = new Int32Array(RING).fill(-1); // 各枠に入っているフレーム番号
      this.rv = null;           // 逆再生中 { cur: 表示しているフレーム, regen: {next, upto} | null, moved, wasRec }
    }
    clear() { this.snaps.length = 0; this.pads.length = 0; this.base = this.nes.frameCount; this.ringFrame.fill(-1); }
    // 今の画面(ppu.frameIdx)を輪に控える
    _capture(f) {
      const FB = this.frameBytes;
      if (!this.ring) this.ring = new Uint8Array(RING * FB);
      const slot = f % RING;
      this.ring.set(this.nes.ppu.frameIdx, slot * FB);
      this.ringFrame[slot] = f;
    }
    // 輪にあるフレーム f の画面(無ければ null)
    frameAt(f) {
      const slot = f % RING;
      return this.ring && this.ringFrame[slot] === f ? this.ring.subarray(slot * this.frameBytes, (slot + 1) * this.frameBytes) : null;
    }
    // 逆再生を始める(本体は止めたまま呼び手が reverseStep/regenStep を回す)。戻れる履歴が無ければ false
    beginReverse() {
      if (this.rv || !this.snaps.length) return false;
      const nes = this.nes;
      this.rv = { cur: nes.frameCount, regen: null, moved: false, wasRec: !!nes.rec };
      nes.rec = null;
      return this.rv;
    }
    // 1 枚戻る。戻れたら 8bit の画面(輪の中の subarray。すぐ写すこと)、まだ作っていなければ null(待つ)、これ以上戻れなければ false
    reverseStep() {
      const rv = this.rv;
      if (!rv) return false;
      const target = rv.cur - 1;
      if (target <= this.oldest) return false; // 一番古いスナップショットの画面は無い(そのフレームの終わりの状態しか無い)
      const img = this.frameAt(target);
      if (img) { rv.cur = target; rv.moved = true; return img; }
      if (!rv.regen) {
        let si = -1;
        for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame < target) { si = i; break; }
        if (si < 0) return false;
        this.State.load(this.nes, this.snaps[si].state);
        rv.regen = { next: this.snaps[si].frame + 1, upto: target };
        this.replaying = true;
      }
      return null;
    }
    // 再生成を n フレームぶん進める(逆再生中、毎 process/毎 rAF に呼ぶ)
    regenStep(n) {
      const rv = this.rv;
      if (!rv || !rv.regen) return;
      const nes = this.nes, g = rv.regen;
      for (let k = 0; k < n && g.next <= g.upto; k++) {
        const p = this.pads[g.next - this.base];
        if (p !== undefined) { nes.pad[0] = p & 0xFF; nes.pad[1] = (p >> 8) & 0xFF; }
        nes.runFrame();
        this._capture(nes.frameCount);
        g.next = nes.frameCount + 1;
      }
      if (g.next > g.upto) { rv.regen = null; this.replaying = false; }
    }
    // 逆再生を終え、表示していたフレームへ本当に戻る。戻った frameCount を返す
    endReverse() {
      const rv = this.rv;
      if (!rv) return this.nes.frameCount;
      const nes = this.nes;
      this.rv = null; this.replaying = false;
      const recNow = !!nes.rec; nes.rec = null;
      let got = nes.frameCount;
      if (rv.moved || rv.regen) got = this.rewindTo(rv.cur, true);
      if (rv.wasRec || recNow) nes.startRecording();
      return got;
    }
    // 戻れる一番古いフレーム(無ければ今のフレーム)
    get oldest() { return this.snaps.length ? this.snaps[0].frame : this.nes.frameCount; }
    // 毎フレーム(_frameEnd の後)に呼ぶ
    onFrame() {
      if (this.replaying) return;
      const nes = this.nes, f = nes.frameCount;
      if (this.base > f) this.clear();
      this.pads[f - this.base] = (nes.pad[0] & 0xFF) | ((nes.pad[1] & 0xFF) << 8);
      this._capture(f);
      if (f % INTERVAL === 0) {
        this.snaps.push({ frame: f, state: this.State.save(nes) });
        if (this.snaps.length > KEEP) {
          const drop = this.snaps.shift();
          // 捨てたスナップショットより前のパッド記録も要らない
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.pads.splice(0, keepFrom - this.base); this.base = keepFrom; }
          void drop;
        }
      }
    }
    // frame(frameCount)の終わりの状態へ戻す。戻れた frameCount を返す(目標が古すぎれば一番古い所、未来なら今のまま)。
    // force は本体が再生成で別のフレームにいる時(endReverse)用: 今の frameCount に関係なくスナップショットから作り直す
    rewindTo(frame, force) {
      const nes = this.nes;
      if (!this.snaps.length || (frame >= nes.frameCount && !force)) return nes.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const snap = this.snaps[si];
      // 今押している物は状態を読む「前」に控える(読んだ後に取ると、巻き戻した先で押していた物が残って押しっぱなしになった。2026-11-11)
      const held = [nes.padHeld[0], nes.padHeld[1]], turbo = [nes.padTurbo[0], nes.padTurbo[1]];
      this.State.load(nes, snap.state);
      // 控えていたパッドの値で進める(setController を通さず pad を直接。連射の位相も記録に含まれている)
      this.replaying = true;
      try {
        while (nes.frameCount < frame) {
          const p = this.pads[nes.frameCount + 1 - this.base];
          if (p !== undefined) { nes.pad[0] = p & 0xFF; nes.pad[1] = (p >> 8) & 0xFF; }
          nes.runFrame();
          this._capture(nes.frameCount); // 進め直した画面も輪へ(戻った直後の巻き戻しに使える)
        }
      } finally { this.replaying = false; }
      // 未来のスナップショットとパッド記録は捨てる
      this.snaps.length = si + 1;
      this.pads.length = Math.max(0, nes.frameCount + 1 - this.base);
      // 今押している物に戻す
      nes.padHeld[0] = held[0]; nes.padHeld[1] = held[1]; nes.padTurbo[0] = turbo[0]; nes.padTurbo[1] = turbo[1];
      nes._applyPad(0); nes._applyPad(1);
      return nes.frameCount;
    }
  }
  NesRewind.INTERVAL = INTERVAL;
  NesRewind.KEEP = KEEP;
  NesRewind.RING = RING;
  Emu.NesRewind = NesRewind;
})(typeof window !== 'undefined' ? window : globalThis);
