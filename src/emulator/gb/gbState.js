/*
 * ゲームボーイ本体のステート(状態の保存・復元)と巻き戻し
 * MML.Emu.GbState / MML.Emu.GbRewind
 *
 * どちらも NES の物(nes/nesState.js の StateTree、nes/nesRewind.js)をそのまま使う:
 *   - ステート: 本体(GbConsole)のオブジェクト木を汎用に写す。除外は ROM、録音、音のリング、画面、コールバック、シリアルの記録
 *   - 巻き戻し: 0.5 秒ごとのステート+毎フレームのパッド値。逆再生の映像は ppu.frameIdx(階調番号 8bit、160×144)
 * 形: { v: 1, machine: 'gb', title, romLen, tree }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SKIP_KEYS = new Set(['rom', 'rec', 'ring', 'ringR', 'frame', 'frameIdx', 'onFrame', 'onWrite', 'onSerial', 'serialDevice',
    'serialOut', 'serialSent', 'bus', 'divBit', 'con', 'shades', 'lineIdx', 'claimed', '_out', 'header', 'data', 'low']);

  const GbState = {
    save(gb) {
      const T = Emu.StateTree;
      return { v: 1, machine: 'gb', title: gb.cart.header.title || '', romLen: gb.cart.rom.length, tree: T.snapshot(gb, [gb.cart.rom], SKIP_KEYS) };
    },
    // 同じ ROM で作ったステートを書き戻す。合わなければ false
    load(gb, state) {
      if (!state || state.v !== 1 || state.machine !== 'gb' || !state.tree) return false;
      if (state.romLen !== gb.cart.rom.length || state.title !== (gb.cart.header.title || '')) return false;
      const rec = gb.rec;
      Emu.StateTree.restore(gb, state.tree);
      gb.rec = rec;                      // 録音中ならそのまま続ける
      gb.ringHead = 0; gb.ringLen = 0;   // 音のリングは捨てる
      gb._frameFlag = false;
      gb.cart._map();                    // バンクの参照位置を作り直す
      return true;
    },
  };

  // 逆再生の色: 階調番号 → 色(ppu.shades)。nesScreen.js の blitIndex / Worklet の rwframe が palette として使う
  class GbRewind extends (Emu.NesRewind || class {}) {
    constructor(gb) {
      super(gb, { State: GbState, frameBytes: 160 * 144 });
      this.idxWidth = 160;
    }
    get palette() { const p = new Uint32Array(256); const sh = this.nes.ppu.shades; for (let i = 0; i < sh.length; i++) p[i] = sh[i]; return p; }
  }

  Emu.GbState = GbState;
  Emu.GbRewind = GbRewind;
})(typeof window !== 'undefined' ? window : globalThis);
