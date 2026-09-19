/*
 * ノイズパッドのプリセット(2A03ノイズの「音色」) — MML.Convert.NoisePresets (2026-09-18)
 *
 * ドラム(DPCM)パネルのパッドで「載せ先: ノイズ(D)」を選んだとき、その打点を鳴らす2A03ノイズの
 * 設定一式。DPCMパッドが実サンプルを @DPCM へ焼くのに対し、こちらは周期index+音量+長短周期
 * (+任意で @EP/@EN/D)を組み合わせた MML の音符列(`@1 @v3 n2` 等)へ変換する。
 *
 * 音色(tone)の形(src/convert/drumSamples.js の noise.custom もこの形):
 *   idx    … 周期index 0-15(n0=最も速い/高いノイズ、n15=最も遅い/低い。compiler.js noisePeriodIndex)
 *   mode   … 0=長周期(ホワイトノイズ) / 1=短周期(93ステップの周期性ノイズ、@1)
 *   vol    … { type:'v', v:0-15 } 固定音量 | { type:'env', values:[0-15…], loop:null|n } @v表
 *   ep     … null | { values:[差分…], loop:null|n }  @EP表(ppmck準拠の累積差分。正=音程上=index−1)
 *   en     … null | { values:[差分…], loop:null|n }  @EN表(ノート空間の累積差分。正=index+1=音程下、16で巡回)
 *   detune … D<n>(0=無し。D16 n0 のように桁あふれで短周期にするppmckの技も書けるが、長短は mode で)
 *
 * プリセット { id, name, tone, builtin }。組み込み(BUILTIN)は id 固定で、ユーザーが編集すると
 * 同じ id の上書きが localStorage に保存される(「組み込みに戻す」で消せる)。追加分は id 'u<連番>'。
 * 変換器(src/convert/drumHits.js noise())は localStorage を直接見ず snapshot() の素のオブジェクトを
 * 受け取れる(ヘッドレスでも JSON を渡せる。渡されなければ自分で snapshot する)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const KEY = 'noisePresets'; // localStorage: { overrides: { [id]: preset }, removed: [id…], order: [id…] }
  const listeners = [];

  // 2A03の定石。index が小さいほど高い(速い)ノイズ。値は使いながら詰める前提(ユーザー合意 2026-09-18)
  const BUILTIN = [
    { id: 'hh_closed', name: 'ハイハット(閉)', tone: { idx: 1, mode: 0, vol: { type: 'env', values: [12, 8, 4, 0], loop: null }, ep: null, en: null, detune: 0 } },
    { id: 'hh_open',   name: 'ハイハット(開)', tone: { idx: 2, mode: 0, vol: { type: 'env', values: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], loop: null }, ep: null, en: null, detune: 0 } },
    { id: 'snare',     name: 'スネア',         tone: { idx: 6, mode: 0, vol: { type: 'env', values: [15, 13, 11, 9, 7, 5, 3, 1, 0], loop: null }, ep: null, en: null, detune: 0 } },
    { id: 'kick',      name: 'キック',         tone: { idx: 11, mode: 0, vol: { type: 'env', values: [15, 12, 8, 4, 0], loop: null }, ep: { values: [0, -1, -1, -1], loop: null }, en: null, detune: 0 } },
    { id: 'tom',       name: 'タム',           tone: { idx: 8, mode: 1, vol: { type: 'env', values: [15, 12, 9, 6, 3, 0], loop: null }, ep: { values: [0, -1, -1, -1], loop: null }, en: null, detune: 0 } },
    { id: 'cymbal',    name: 'シンバル',       tone: { idx: 0, mode: 0, vol: { type: 'env', values: [15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], loop: null }, ep: null, en: null, detune: 0 } },
    { id: 'crash',     name: 'クラッシュ',     tone: { idx: 3, mode: 0, vol: { type: 'env', values: [15, 15, 14, 14, 13, 13, 12, 12, 11, 11, 10, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], loop: null }, ep: null, en: null, detune: 0 } },
  ];
  const DEFAULT_TONE = { idx: 6, mode: 0, vol: { type: 'v', v: 12 }, ep: null, en: null, detune: 0 };

  function load() {
    try { return JSON.parse(global.localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(st) {
    try { global.localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ }
  }
  function notify() {
    for (const fn of listeners) { try { fn(); } catch (e) { console.error('[NoisePresets] onChange listener failed:', e); } }
  }

  const clampInt = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };

  /** 表 {values, loop} を整える(壊れていれば null)。values は整数、loop は範囲内か null */
  function sanitizeTable(t, lo, hi) {
    if (!t || !Array.isArray(t.values) || !t.values.length) return null;
    const values = t.values.map(v => clampInt(v, lo, hi, 0));
    const loop = (t.loop == null) ? null : clampInt(t.loop, 0, values.length - 1, null);
    return { values, loop };
  }
  /** 音色の形を整える(欠けは既定値で埋める) */
  function sanitizeTone(t) {
    const src = t || {};
    let vol;
    if (src.vol && src.vol.type === 'env') {
      const tbl = sanitizeTable(src.vol, 0, 15);
      vol = tbl ? { type: 'env', values: tbl.values, loop: tbl.loop } : { type: 'v', v: 12 };
    } else {
      vol = { type: 'v', v: clampInt(src.vol && src.vol.v != null ? src.vol.v : 12, 0, 15, 12) };
    }
    return {
      idx: clampInt(src.idx, 0, 15, 6),
      mode: src.mode ? 1 : 0,
      vol,
      ep: sanitizeTable(src.ep, -127, 126),
      en: sanitizeTable(src.en, -127, 126),
      detune: clampInt(src.detune, -127, 126, 0),
    };
  }

  /** 音色の同一性キー(変換時の表の登録・重複判定用) */
  function toneKey(t) {
    const s = sanitizeTone(t);
    const tbl = (x) => x ? x.values.join(',') + '|' + (x.loop == null ? '-' : x.loop) : '';
    return [s.idx, s.mode, s.vol.type === 'env' ? 'e:' + tbl(s.vol) : 'v:' + s.vol.v, tbl(s.ep), tbl(s.en), s.detune].join(';');
  }

  /** 全プリセット(組み込み→追加分の順。上書き/削除を反映) */
  function all() {
    const st = load();
    const overrides = st.overrides || {};
    const removed = new Set(st.removed || []);
    const out = [];
    for (const b of BUILTIN) {
      if (removed.has(b.id)) continue;
      const o = overrides[b.id];
      out.push({ id: b.id, name: (o && o.name) || b.name, tone: sanitizeTone(o && o.tone ? o.tone : b.tone), builtin: true, modified: !!o });
    }
    for (const id of (st.order || [])) {
      const o = overrides[id];
      if (!o || removed.has(id)) continue;
      out.push({ id, name: o.name || id, tone: sanitizeTone(o.tone), builtin: false, modified: false });
    }
    return out;
  }
  function get(id) { return all().find(p => p.id === id) || null; }

  /** 追加または上書き。id 省略で新規('u<n>')。戻り値は id */
  function set(id, name, tone) {
    const st = load();
    st.overrides = st.overrides || {};
    st.order = st.order || [];
    st.removed = (st.removed || []).filter(x => x !== id);
    if (!id) {
      let n = 1;
      while (st.overrides['u' + n] || st.order.indexOf('u' + n) >= 0) n++;
      id = 'u' + n;
    }
    st.overrides[id] = { name: String(name || id), tone: sanitizeTone(tone) };
    if (!BUILTIN.some(b => b.id === id) && st.order.indexOf(id) < 0) st.order.push(id);
    save(st);
    notify();
    return id;
  }
  /** 削除(組み込みは「削除済み」印だけ付けて隠す)。resetBuiltin で組み込みの上書き/削除を戻す */
  function remove(id) {
    const st = load();
    if (BUILTIN.some(b => b.id === id)) {
      st.removed = (st.removed || []).concat(st.removed && st.removed.indexOf(id) >= 0 ? [] : [id]);
    } else {
      st.order = (st.order || []).filter(x => x !== id);
    }
    if (st.overrides) delete st.overrides[id];
    save(st);
    notify();
  }
  function resetBuiltin(id) {
    const st = load();
    if (st.overrides) delete st.overrides[id];
    st.removed = (st.removed || []).filter(x => x !== id);
    save(st);
    notify();
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /** 変換器へ渡す素のオブジェクト { [id]: {name, tone} } */
  function snapshot() {
    const out = {};
    for (const p of all()) out[p.id] = { name: p.name, tone: p.tone };
    return out;
  }

  // 表の文字列化/読み取り(エディタと MML 定義の両方で使う。"15 12 8 | 4 0" の形、"|" がループ位置)
  function formatTable(t) {
    if (!t || !t.values || !t.values.length) return '';
    const parts = t.values.map(String);
    if (t.loop != null) parts.splice(t.loop, 0, '|');
    return parts.join(' ');
  }
  function parseTable(str, lo, hi) {
    const toks = String(str || '').replace(/[,{}]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    const values = []; let loop = null;
    for (const tk of toks) {
      if (tk === '|') { loop = values.length; continue; }
      const n = parseInt(tk, 10);
      if (!Number.isFinite(n)) return null;
      values.push(Math.max(lo, Math.min(hi, n)));
    }
    if (!values.length) return null;
    if (loop != null && loop >= values.length) loop = values.length - 1;
    return { values, loop };
  }

  /**
   * 試聴/確認用のMML。音色を1音鳴らす(D chのみ、t120 l4)。@v/@EP/@EN は 0 番に定義する
   * (MML.Mml.render で 2A03 エミュを通して鳴らせる。src/ui/noisePadEditor.js)
   */
  function toneToMml(tone, opt) {
    const t = sanitizeTone(tone);
    const len = (opt && opt.len) || 4;
    const head = ['#TITLE noise pad'];
    const cmds = [`@${t.mode}`];
    if (t.vol.type === 'env') { head.push(`@v0 = { ${formatTable(t.vol)} }`); cmds.push('@v0'); }
    else cmds.push(`v${t.vol.v}`);
    if (t.ep) { head.push(`@EP0 = { ${formatTable(t.ep)} }`); cmds.push('EP0'); }
    if (t.en) { head.push(`@EN0 = { ${formatTable(t.en)} }`); cmds.push('EN0'); }
    if (t.detune) cmds.push(`D${t.detune}`);
    return head.join('\n') + `\nD t120 l${len} ${cmds.join(' ')} n${t.idx} r\n`;
  }

  MML.Convert.NoisePresets = {
    BUILTIN, DEFAULT_TONE,
    all, get, set, remove, resetBuiltin, onChange, snapshot,
    sanitizeTone, toneKey, formatTable, parseTable, toneToMml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
