/*
 * NES 本体のステート(状態の保存・復元) MML.Emu.NesState — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7、段階 6e-6)
 *
 * 作り: 本体(NesConsole)のオブジェクト木を汎用に深く写す。CPU/PPU/APU/マッパー/拡張音源のクラスごとに直列化を書かない。
 *   - 数値・真偽・文字列・null はそのまま、型付き配列は複製、配列と普通のオブジェクト(クラスのインスタンス含む)は再帰。
 *   - 除外: 関数、ROM データ(rom と、rom.prg / rom.chr と同じ実体の配列=CHR ROM)、録音中の列(rec)、音のリング(ring)、
 *     画面(frame。復元後の最初のフレームで描き直る)、コールバック(onFrame/onWrite)、本体自身への逆参照(cpu.bus、
 *     apu.dmc.bus)。2 度目に出会ったオブジェクト(ppu.mapper と console.mapper など)は参照の印だけ置く。
 *   - 復元は「同じ順で木を辿って、既存のインスタンスへ値を書き戻す」。型付き配列は長さが同じなら set、違えば置き換え。
 *     プロトタイプ(メソッド)はそのまま残るので、どの音源クラスでも動く。保存と復元で木の形が同じことが前提
 *     (同じ ROM、同じ BIOS)。
 * 形: { v: 1, mapper, prgLen, chrLen, tree }。postMessage / IndexedDB の構造化複製で運べる(JSON にはしない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SKIP_KEYS = new Set(['rom', 'rec', 'ring', 'frame', 'frameIdx', 'onFrame', 'onWrite', 'bus']);
  const REF = '__ref';

  function isTyped(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); }

  function snapshot(root, skipArrays) {
    const seen = new Map();
    let nextId = 1;
    function walk(obj, top) {
      if (obj === null || typeof obj !== 'object') return typeof obj === 'function' ? undefined : obj;
      if (isTyped(obj)) { for (const a of skipArrays) if (a === obj) return undefined; return obj.slice(); }
      if (obj === root && !top) return undefined; // 本体への逆参照(cpu.bus など)
      if (seen.has(obj)) return { [REF]: seen.get(obj) };
      const id = nextId++; seen.set(obj, id);
      if (Array.isArray(obj)) return obj.map((x) => { const w = walk(x); return w === undefined ? null : w; });
      const out = {};
      for (const k of Object.keys(obj)) {
        if (SKIP_KEYS.has(k)) continue;
        const w = walk(obj[k]);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return walk(root, true);
  }

  function restore(live, snap) {
    function apply(target, s) {
      for (const k of Object.keys(s)) {
        const v = s[k], cur = target[k];
        if (v === null || typeof v !== 'object') { target[k] = v; continue; }
        if (v[REF] !== undefined && Object.keys(v).length === 1) continue; // 参照の印: 主経路で復元済み
        if (isTyped(v)) { if (isTyped(cur) && cur.length === v.length && cur.constructor === v.constructor) cur.set(v); else target[k] = v.slice(); continue; }
        if (Array.isArray(v)) {
          if (Array.isArray(cur) && cur.length === v.length) {
            for (let i = 0; i < v.length; i++) {
              const x = v[i];
              if (x === null || typeof x !== 'object') cur[i] = x;
              else if (x[REF] !== undefined && Object.keys(x).length === 1) continue;
              else if (isTyped(x)) { if (isTyped(cur[i]) && cur[i].length === x.length && cur[i].constructor === x.constructor) cur[i].set(x); else cur[i] = x.slice(); }
              else if (cur[i] && typeof cur[i] === 'object') apply(cur[i], x);
              else cur[i] = x;
            }
          } else target[k] = v.map((x) => (isTyped(x) ? x.slice() : x));
          continue;
        }
        if (cur && typeof cur === 'object') apply(cur, v); else target[k] = v;
      }
    }
    apply(live, snap);
  }

  const NesState = {
    // 本体 nes の状態を写して返す(nes は走らせたまま呼んでよい。rec は含めない)
    save(nes) {
      const rom = nes.rom;
      const skip = [rom.prg, rom.chr].filter(Boolean);
      return { v: 1, mapper: rom.mapper, prgLen: rom.prg ? rom.prg.length : 0, chrLen: rom.chr ? rom.chr.length : 0, tree: snapshot(nes, skip) };
    },
    // 同じ ROM で作ったステートを nes に書き戻す。合わなければ false
    load(nes, state) {
      if (!state || state.v !== 1 || !state.tree) return false;
      const rom = nes.rom;
      if (state.mapper !== rom.mapper || state.prgLen !== (rom.prg ? rom.prg.length : 0) || state.chrLen !== (rom.chr ? rom.chr.length : 0)) return false;
      const rec = nes.rec;
      restore(nes, state.tree);
      nes.rec = rec;                       // 録音中ならそのまま続ける
      nes.ringHead = 0; nes.ringLen = 0;   // 音のリングは捨てる
      nes._frameFlag = false;
      return true;
    },
  };
  Emu.NesState = NesState;
})(typeof window !== 'undefined' ? window : globalThis);
