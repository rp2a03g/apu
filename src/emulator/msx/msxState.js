/*
 * MSX 本体のステート(状態の保存・復元) MML.Emu.MsxState — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md §4、段階 7a)
 *
 * 作り: NES と同じく本体のオブジェクト木を汎用に写す(nes/nesState.js の Emu.StateTree)。除外するキー:
 *   rom(カートリッジ/BIOS の ROM 本体)、banks/pages/pageDev/slot/list(ROM への参照の張り替えだけの物。復元後に afterRestore() で作り直す)、
 *   rec/ring/frame/frameIdx/lineBuf/sprBuf/onFrame/onWrite/onInt/bus/opts/bios/keyboard.map。
 *   palette(表示色)は paletteRaw から作れるが小さいので写す。
 * 形: { v: 1, machine, romLen, tree }
 *
 * 差分圧縮(巻き戻しの控え用、2026-11-08 決定): pack(state, prevState) は木を辿り、2048 バイト以上の型付き配列で
 * 前回と同じ長さ・型の物を「前回との XOR をランレングスで」{ __xd: Uint8Array } に置き換える。VRAM 128K+RAM 128K〜 でも
 * ゲーム中に 1 スナップショット(0.5 秒)で変わる領域は狭いので数 KB になる。unpack(packed, prevUnpacked) で戻す。
 * 連鎖の長さは呼び手(msxRewind.js)がキーフレーム間隔で切る。
 *   XOR-RLE の形: [ゼロ連長 u16][非ゼロ連長 u16][非ゼロの XOR バイト列] の繰り返し(連長は 0xFFFF で分割)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SKIP_KEYS = new Set(['rom', 'banks', 'pages', 'pageDev', 'slot', 'list', 'rec', 'ring', 'frame', 'frameIdx', 'lineBuf', 'sprBuf',
    'onFrame', 'onWrite', 'onInt', 'bus', 'opts', 'bios', 'map', 'traps',
    'owner', '_pitchCache', 'patchrom', 'sintbl', '_sramMirror', '_sprOwner', 'img', 'images', 'image']); // img/images/image: ディスク画像(大きい。本体に残る) // _sramMirror/_sprOwner: 作業用(復元後に作り直す) // owner: Y8950 の ADPCM が親を指す(循環)、_pitchCache: Map(復元後に消す)、patchrom/sintbl: 定数表
  const DIFF_MIN = 2048;

  function xorRle(cur, prev) {
    const n = cur.length, out = [];
    let i = 0;
    while (i < n) {
      let z = 0; while (i + z < n && cur[i + z] === prev[i + z] && z < 0xFFFF) z++;
      i += z;
      let nz = 0; while (i + nz < n && cur[i + nz] !== prev[i + nz] && nz < 0xFFFF) nz++;
      out.push(z & 0xFF, z >> 8, nz & 0xFF, nz >> 8);
      for (let k = 0; k < nz; k++) out.push((cur[i + k] ^ prev[i + k]) & 0xFF);
      i += nz;
    }
    return Uint8Array.from(out);
  }
  function unXorRle(rle, prev, Ctor) {
    const n = prev.length, out = new Uint8Array(n);
    out.set(prev);
    let p = 0, i = 0;
    while (p + 4 <= rle.length) {
      const z = rle[p] | (rle[p + 1] << 8), nz = rle[p + 2] | (rle[p + 3] << 8); p += 4;
      i += z;
      for (let k = 0; k < nz; k++) out[i + k] ^= rle[p + k];
      p += nz; i += nz;
    }
    return Ctor === Uint8Array ? out : new Ctor(out.buffer);
  }
  const isTyped = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);
  // 型付き配列はバイト列として比較/差分する(Uint16/Uint32 も)
  const bytesOf = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

  function pack(node, prev) {
    if (node === null || typeof node !== 'object') return node;
    if (isTyped(node)) {
      if (prev && isTyped(prev) && prev.constructor === node.constructor && prev.length === node.length && node.byteLength >= DIFF_MIN) {
        return { __xd: xorRle(bytesOf(node), bytesOf(prev)), __ct: node.constructor.name };
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((x, i) => pack(x, prev && Array.isArray(prev) ? prev[i] : undefined));
    const out = {};
    for (const k of Object.keys(node)) out[k] = pack(node[k], prev && typeof prev === 'object' && !isTyped(prev) ? prev[k] : undefined);
    return out;
  }
  function unpack(node, prev) {
    if (node === null || typeof node !== 'object') return node;
    if (isTyped(node)) return node;
    if (node.__xd) {
      const Ctor = global[node.__ct] || Uint8Array;
      return unXorRle(node.__xd, bytesOf(prev), Ctor);
    }
    if (Array.isArray(node)) return node.map((x, i) => unpack(x, prev && Array.isArray(prev) ? prev[i] : undefined));
    const out = {};
    for (const k of Object.keys(node)) out[k] = unpack(node[k], prev && typeof prev === 'object' ? prev[k] : undefined);
    return out;
  }
  // 木のおよその大きさ(バイト)。容量の実測用
  function sizeOf(node) {
    if (node === null || typeof node !== 'object') return 8;
    if (isTyped(node)) return node.byteLength;
    if (node.__xd) return node.__xd.byteLength + 16;
    let n = 16;
    if (Array.isArray(node)) { for (const x of node) n += sizeOf(x); return n; }
    for (const k of Object.keys(node)) n += k.length + sizeOf(node[k]);
    return n;
  }

  const MsxState = {
    save(msx) {
      const T = Emu.StateTree;
      return { v: 1, machine: msx.machine, romLen: msx.cart ? msx.cart.rom.length : 0, tree: T.snapshot(msx, [], SKIP_KEYS) };
    },
    load(msx, state) {
      if (!state || state.v !== 1 || !state.tree) return false;
      if (state.machine !== msx.machine || state.romLen !== (msx.cart ? msx.cart.rom.length : 0)) return false;
      const rec = msx.rec;
      Emu.StateTree.restore(msx, state.tree);
      msx.rec = rec;
      msx.ringHead = 0; msx.ringLen = 0;
      msx._frameFlag = false;
      msx.afterRestore();
      return true;
    },
    // 巻き戻しの控え用: 前のステート(展開済み)との差分に圧縮 / 展開
    pack(state, prevState) { return Object.assign({}, state, { tree: pack(state.tree, prevState ? prevState.tree : undefined), packed: true }); },
    unpack(packed, prevState) { return Object.assign({}, packed, { tree: unpack(packed.tree, prevState ? prevState.tree : undefined), packed: false }); },
    sizeOf(state) { return sizeOf(state.tree); },
    SKIP_KEYS,
  };
  Emu.MsxState = MsxState;
})(typeof window !== 'undefined' ? window : globalThis);
