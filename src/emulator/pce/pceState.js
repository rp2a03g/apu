/*
 * PC エンジン本体のステート(状態の保存・復元)と巻き戻し
 * MML.Emu.PceState / MML.Emu.PceRewind(段階 9c)
 *
 * どちらも NES の物(nes/nesState.js の StateTree、nes/nesRewind.js)をそのまま使う(GB の gbState.js と同じ流儀):
 *   - ステート: 本体(PceConsole)のオブジェクト木を汎用に写す。除外はカードの ROM、録音、音のリング、出来上がった画面、コールバック。
 *     描きかけの 1 行(vdc.row)と VDC の内部状態は入るので、復元後は命令の途中の位置から同じに続く。
 *     出来上がった画面(vdc.out)は入れない(1 枚 330KB)。復元した直後の 1 フレームは、上半分が復元前の絵のままになる
 *   - 巻き戻し: 0.5 秒ごとのステート(1 分ぶん)+毎フレームのパッド値。逆再生の映像は、その時の画面を幅 292 に縮めて
 *     「色の番号 8bit+その画面の色表」で控える(PC エンジンは 512 色出せるので、1 画面に 256 色を超えた分は近い色に寄せる。逆再生の絵だけの話)
 * 形: { v: 1, machine: 'pce', romLen, romSum, sgx, tree }
 *   CD つきは cd(ディスクの見分け)と cdType も持つ。ディスクそのもの(disc)は入れない。CD 装置の RAM(64K+ADPCM 64K+Super の 192K)は入る
 *   本体の種類(SuperGrafx かどうか)が違うステートは読まない(VDC の数が違い、読むと落ちる)。パッドの種類は今の設定を保つ(ステートの物に戻さない)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 出来上がった画面(vdc.out)はキー名でなく配列そのもので外す(キー名 'out' で外すと、音源の ch の今の出力 out まで落ちる。見直しで分かった)
  const SKIP_KEYS = new Set(['rom', 'card', 'rec', 'ring', 'ringR', '_frame', '_frameIdx', 'onFrame', 'onFrameExact', 'onWrite', 'onIo', 'host', 'bus', 'disc', 'onCommand', 'onSample', 'onOp']);
  const romSum = (card) => {
    if (card._sum === undefined) { let h = 2166136261 | 0; const r = card.rom; for (let i = 0; i < r.length; i += 97) h = Math.imul(h ^ r[i], 16777619) | 0; card._sum = h >>> 0; }
    return card._sum;
  };

  const PceState = {
    save(pce) {
      // アーケードカードの RAM(2MB)は丸ごとは入れない。書いた所まで(64K 単位に切り上げ)を arcadeRam に入れる
      const ac = pce.arcade, acTop = ac ? Math.min(ac.ram.length, (ac.top + 0xFFFF) & ~0xFFFF) : 0;
      return { v: 1, machine: 'pce', arcadeRam: ac && acTop ? ac.ram.slice(0, acTop) : null, romLen: pce.card.rom.length, romSum: romSum(pce.card), sgx: !!pce.sgx, cd: pce.cdOn ? pce.disc.signature : 0, cdType: pce.cdType || '', tree: Emu.StateTree.snapshot(pce, [pce.card.rom, pce.vdc.out].concat(pce.vdc2 ? [pce.vdc2.out, pce.vdc2.rowDiv] : [], ac ? [ac.ram] : []), SKIP_KEYS) };
    },
    // 同じ ROM で作ったステートを書き戻す。合わなければ false
    load(pce, state) {
      if (!state || state.v !== 1 || state.machine !== 'pce' || !state.tree) return false;
      if (state.romLen !== pce.card.rom.length || state.romSum !== romSum(pce.card)) return false;
      if (!!state.tree.sgx !== !!pce.sgx) return false;                  // 本体の種類が違う
      if ((state.cd || 0) !== (pce.cdOn ? pce.disc.signature : 0) || (state.cdType || '') !== (pce.cdType || '')) return false; // CD の有無・ディスク・RAM の有無が違う
      if (state.tree.cd === undefined) pce._newCd();                     // 9d までのステート(CD 装置の中身を持っていない): 電源投入時の状態にする
      const rec = pce.rec, padType = pce.input.type;
      Emu.StateTree.restore(pce, state.tree);
      pce.input.type = padType;                                           // パッドの種類は今の設定が正
      // 9c のステート(パッドが 2 個ぶん、SEL/CLR を本体に持っていた形)を読んだ時の埋め合わせ
      for (const k of ['pad', 'padHeld', 'padTurbo']) { const a = pce[k]; while (a.length < 5) a.push(0); }
      if (state.tree.padSel !== undefined) { pce.input.sel = !!state.tree.padSel; pce.input.clr = !!state.tree.padClr; }
      pce.input.buttons = pce.pad;                                        // 同じ配列を指し直す
      if (pce.arcade) { const r = pce.arcade.ram; r.fill(0); if (state.arcadeRam) r.set(state.arcadeRam.subarray(0, r.length)); } // 控えに無い所は書かれていない=0
      pce.rec = rec;                       // 録音中ならそのまま続ける
      pce.ringHead = 0; pce.ringLen = 0;   // 音のリングは捨てる
      pce._frameFlag = false; pce._frameCb = false; pce._frameDirty = true;
      pce.card.select(pce.cardBank | 0);   // 1MB 超のカードの段(カードそのものはステートに入れていない)
      return true;
    },
  };

  const RW_W = 292, RW_H = 242;
  class PceRewind extends (Emu.NesRewind || class {}) {
    constructor(pce) {
      // アーケードカードつきは控え 1 個が最大 2MB 増えるので、持つ数を減らす(120 → 24。戻れる時間が短くなる)
      super(pce, { State: PceState, frameBytes: RW_W * RW_H, keep: pce.arcade ? 24 : 120 });
      this.idxWidth = RW_W;
      this._idx = new Uint8Array(RW_W * RW_H);
      this._pal = new Uint32Array(256);
      this._lut = new Int16Array(1024);
    }
    get palette() { return this._pal.slice(); }
    // 今の画面を「色の番号+色表」にして輪に控える
    _capture(f) {
      const pce = this.nes, RING = Emu.NesRewind.RING, FB = this.frameBytes;
      if (!this.ring) this.ring = new Uint8Array(RING * FB);
      if (!this.palRing) this.palRing = new Uint32Array(RING * 256);
      // 画面は色の番号(VCE の 9bit+白黒の印)で持っているので、番号 → その画面の中の通し番号(0-255)を表で引く
      const src = pce.frameIdx, w = pce.frameWidth, idx = this._idx, pal = this._pal, lut = this._lut, COLORS = Emu.PceConsole.COLORS;
      lut.fill(-1);
      let n = 0;
      const step = w / RW_W;
      for (let y = 0; y < RW_H; y++) {
        const row = y * w, out = y * RW_W;
        for (let x = 0; x < RW_W; x++) {
          const c = src[row + ((x * step) | 0)];
          let i = lut[c];
          if (i < 0) {
            if (n < 256) { i = n++; pal[i] = COLORS[c]; }
            else { // 257 色目から: 色表の中で一番近い色
              const col = COLORS[c], r = col & 0xFF, g = (col >> 8) & 0xFF, b = (col >> 16) & 0xFF;
              let best = 0, bd = 1e9;
              for (let k = 0; k < 256; k++) { const p = pal[k], d = Math.abs((p & 0xFF) - r) + Math.abs(((p >> 8) & 0xFF) - g) + Math.abs(((p >> 16) & 0xFF) - b); if (d < bd) { bd = d; best = k; } }
              i = best;
            }
            lut[c] = i;
          }
          idx[out + x] = i;
        }
      }
      for (let k = n; k < 256; k++) pal[k] = 0xFF000000;
      const slot = f % RING;
      this.ring.set(idx, slot * FB);
      this.palRing.set(pal, slot * 256);
      this.ringFrame[slot] = f;
    }
    paletteOf(f) {
      const RING = Emu.NesRewind.RING, slot = f % RING;
      if (!this.palRing || this.ringFrame[slot] !== f) return this.palette;
      return this.palRing.slice(slot * 256, slot * 256 + 256);
    }
  }

  Emu.PceState = PceState;
  Emu.PceRewind = PceRewind;
})(typeof window !== 'undefined' ? window : globalThis);
