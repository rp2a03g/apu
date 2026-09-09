/*
 * 音色ごとの変換設定 — MML.Convert.ToneSettings (2026-09-09、「音色一覧」パネルの実体)
 *
 * 設定の単位は「チャンネル」ではなく「音色」(src/convert/toneKey.js のキー)。理由は
 * DPCMパッドが「サンプル」単位にしたのと同じ(src/convert/drumSamples.js 冒頭):
 *   ・同じ音色は複数チャンネルに出る(SPCの同じsrcn、FMの同じ音色での和音、プール式PCM)。
 *     音色単位なら一度の指定が全チャンネルに効き、「設定をコピー」が要らない
 *   ・キーが内容ハッシュなので、同じゲームの別トラックでも指定が生きる(localStorageに保存)
 *
 * 設定内容(既定と同じ項目は保存しない):
 *   name    … 一覧に出す表示名
 *   tone    … 借用先の音色種別(channelPlan.js toneKindFor: 'duty4'|'duty8'|'wave'|'vrc7'|'noisePeriod')
 *              ごとの音色指定 { duty4:'1', wave:'sin', vrc7:'3', … }。チャンネルの借用先が変わっても、
 *              該当する種別の欄が使われるだけで指定は消えない
 *   target  … この音色だけ別の借用先へ載せる(channelPlan.js の target 語彙。null=チャンネルに従う)
 *
 * 優先順位は「音色の設定 > チャンネルの音色指定 > 既定」。モード切替は無い(設定があれば効く)。
 * 変換器はlocalStorageを直接見ず、main.js が snapshot() で作った素のオブジェクトを
 * options.toneSettings で受け取り lookup() で引く(ヘッドレス実行でもJSONを渡せる)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const KEY = 'toneSettings';
  const DEFAULTS = { name: null, tone: null, target: null };
  const listeners = [];

  function load() {
    try { return JSON.parse(global.localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(map) {
    try { global.localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }
  function notify() {
    for (const fn of listeners) { try { fn(); } catch (e) { console.error('[ToneSettings] onChange listener failed:', e); } }
  }
  function normalize(ent) {
    const out = Object.assign({}, DEFAULTS, ent || {});
    if (out.tone && typeof out.tone === 'object') {
      const t = {};
      for (const k of Object.keys(out.tone)) if (out.tone[k] !== null && out.tone[k] !== undefined && out.tone[k] !== '') t[k] = String(out.tone[k]);
      out.tone = Object.keys(t).length ? t : null;
    } else out.tone = null;
    if (!out.target) out.target = null;
    if (!out.name) out.name = null;
    return out;
  }
  function isEmpty(ent) { return !ent.name && !ent.tone && !ent.target; }

  /** その音色の設定(未設定は既定値) */
  function get(key) {
    if (!key) return normalize(null);
    return normalize(load()[key]);
  }
  /** 部分更新。patch.tone は { 種別: 値|null } で種別ごとに足し引きする */
  function set(key, patch) {
    if (!key) return;
    const map = load();
    const cur = normalize(map[key]);
    const next = Object.assign({}, cur);
    if (patch) {
      if ('name' in patch) next.name = patch.name || null;
      if ('target' in patch) next.target = patch.target || null;
      if ('tone' in patch) {
        const t = Object.assign({}, cur.tone || {});
        for (const k of Object.keys(patch.tone || {})) {
          const v = patch.tone[k];
          if (v === null || v === undefined || v === '') delete t[k]; else t[k] = String(v);
        }
        next.tone = Object.keys(t).length ? t : null;
      }
    }
    const n = normalize(next);
    if (isEmpty(n)) delete map[key];
    else {
      const keep = {};
      if (n.name) keep.name = n.name;
      if (n.tone) keep.tone = n.tone;
      if (n.target) keep.target = n.target;
      map[key] = keep;
    }
    save(map);
    notify();
  }
  function setTone(key, toneKind, value) { set(key, { tone: { [toneKind]: value } }); }
  function clear(key) { if (!key) return; const map = load(); if (map[key]) { delete map[key]; save(map); notify(); } }
  function toneFor(key, toneKind) {
    const e = get(key);
    return (e.tone && toneKind && e.tone[toneKind] !== undefined) ? e.tone[toneKind] : undefined;
  }
  function targetFor(key) { return get(key).target || undefined; }

  /** 変換器へ渡す素のオブジェクト。keys を渡すとその音色ぶんだけ(この曲に関係ない設定を運ばない) */
  function snapshot(keys) {
    const map = load();
    if (!keys) return JSON.parse(JSON.stringify(map));
    const out = {};
    for (const k of keys) if (k && map[k]) out[k] = JSON.parse(JSON.stringify(map[k]));
    return out;
  }
  /** keys のどれかに「変換に効く設定」(tone か target)があるか */
  function hasAny(keys) {
    const map = load();
    for (const k of keys || []) { const e = k && map[k]; if (e && (e.tone || e.target)) return true; }
    return false;
  }
  /** 変換器側: options.toneSettings(snapshotの結果) → 引き当て関数 */
  function lookup(obj) {
    const map = obj || {};
    return {
      toneFor: (key, toneKind) => {
        const e = key && map[key];
        return (e && e.tone && toneKind && e.tone[toneKind] !== undefined) ? String(e.tone[toneKind]) : undefined;
      },
      targetFor: (key) => { const e = key && map[key]; return (e && e.target) || undefined; },
      nameOf: (key) => { const e = key && map[key]; return (e && e.name) || null; },
      isEmpty: () => !Object.keys(map).length,
    };
  }
  function all() { return load(); }
  function onChange(fn) { listeners.push(fn); }

  MML.Convert.ToneSettings = { get, set, setTone, clear, toneFor, targetFor, snapshot, hasAny, lookup, all, onChange };
})(typeof window !== 'undefined' ? window : globalThis);
