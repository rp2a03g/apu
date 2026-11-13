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
    'serialOut', 'serialSent', 'bus', 'divBit', 'con', 'shades', 'palRing', 'lineIdx', 'claimed', '_out', 'header', 'data', 'low']);

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
    // DMG は階調 4 色、CGB はパレット 64 色(BG 0-31、OBJ 32-63)
    get palette() { const p = new Uint32Array(256), ppu = this.nes.ppu; if (ppu.cgb) p.set(ppu.colors); else for (let i = 0; i < ppu.shades.length; i++) p[i] = ppu.shades[i]; return p; }
    // CGB はフレームごとに色表も控える(逆再生の画面をその時の色で出す。行の途中の色替えまでは追わない)
    _capture(f) {
      super._capture(f);
      const ppu = this.nes.ppu;
      if (!ppu.cgb) return;
      const RING = Emu.NesRewind.RING;
      if (!this.palRing) this.palRing = new Uint32Array(RING * 64);
      this.palRing.set(ppu.colors, (f % RING) * 64);
    }
    paletteOf(f) {
      const RING = Emu.NesRewind.RING;
      if (!this.palRing || this.ringFrame[f % RING] !== f) return this.palette;
      const p = new Uint32Array(256); p.set(this.palRing.subarray((f % RING) * 64, (f % RING) * 64 + 64)); return p;
    }
  }

  Emu.GbState = GbState;
  Emu.GbRewind = GbRewind;
})(typeof window !== 'undefined' ? window : globalThis);
