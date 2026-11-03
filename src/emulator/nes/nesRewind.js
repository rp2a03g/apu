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
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INTERVAL = 30;   // スナップショットの間隔(フレーム)。0.5 秒
  const KEEP = 240;      // 控える個数。2 分

  class NesRewind {
    constructor(nes) {
      this.nes = nes;
      this.snaps = [];          // [{ frame, state }] frame = そのフレームが終わった時点の frameCount
      this.pads = [];           // pads[frameCount] = pad0 | pad1 << 8(そのフレーム終わりの値。フレーム番号は frameCount)
      this.base = 0;            // pads の先頭が指す frameCount(古い分は捨てる)
      this.replaying = false;
    }
    clear() { this.snaps.length = 0; this.pads.length = 0; this.base = this.nes.frameCount; }
    // 戻れる一番古いフレーム(無ければ今のフレーム)
    get oldest() { return this.snaps.length ? this.snaps[0].frame : this.nes.frameCount; }
    // 毎フレーム(_frameEnd の後)に呼ぶ
    onFrame() {
      if (this.replaying) return;
      const nes = this.nes, f = nes.frameCount;
      if (this.base > f) this.clear();
      this.pads[f - this.base] = (nes.pad[0] & 0xFF) | ((nes.pad[1] & 0xFF) << 8);
      if (f % INTERVAL === 0) {
        this.snaps.push({ frame: f, state: Emu.NesState.save(nes) });
        if (this.snaps.length > KEEP) {
          const drop = this.snaps.shift();
          // 捨てたスナップショットより前のパッド記録も要らない
          const keepFrom = this.snaps[0].frame;
          if (keepFrom > this.base) { this.pads.splice(0, keepFrom - this.base); this.base = keepFrom; }
          void drop;
        }
      }
    }
    // frame(frameCount)の終わりの状態へ戻す。戻れた frameCount を返す(目標が古すぎれば一番古い所、未来なら今のまま)
    rewindTo(frame) {
      const nes = this.nes;
      if (!this.snaps.length || frame >= nes.frameCount) return nes.frameCount;
      let si = -1;
      for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].frame <= frame) { si = i; break; }
      if (si < 0) { si = 0; frame = this.snaps[0].frame; }
      const snap = this.snaps[si];
      Emu.NesState.load(nes, snap.state);
      // 控えていたパッドの値で進める(setController を通さず pad を直接。連射の位相も記録に含まれている)
      const held = [nes.padHeld[0], nes.padHeld[1]], turbo = [nes.padTurbo[0], nes.padTurbo[1]];
      this.replaying = true;
      try {
        while (nes.frameCount < frame) {
          const p = this.pads[nes.frameCount + 1 - this.base];
          if (p !== undefined) { nes.pad[0] = p & 0xFF; nes.pad[1] = (p >> 8) & 0xFF; }
          nes.runFrame();
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
  Emu.NesRewind = NesRewind;
})(typeof window !== 'undefined' ? window : globalThis);
