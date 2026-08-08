/*
 * 多言語表示の中核 (MML.I18n)
 *
 * 【方式】gettext式 — 「日本語の原文そのもの」を辞書キーにする。
 *   ビルドツールを導入できない(DESIGN.md INV-1)ため、キー名を人手で数百個維持する方式は
 *   同期が破綻する。原文をキーにすれば、キー表と原文の二重管理が発生しない。
 *   基準言語(ja)では辞書を引かずキーをそのまま返すので、日本語表示は常に無コストで正しい。
 *
 * 【文脈が衝突する場合】同じ日本語で訳し分けたいときだけ "原文|文脈" 形式のキーを使う。
 *   t() は '|' 以降を文脈ラベルとみなし、辞書に無ければ '|' より前を返す。
 *
 * 【層】DOM非依存(DESIGN.md INV-4)。辞書の登録・言語切替・文言取得だけを行う。
 *   DOMへの適用・localStorage・言語選択UIは UI層の src/ui/i18nDom.js が担当する。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};

  // 辞書の基準言語。キー = この言語の原文。未翻訳キーはこの言語にフォールバックする
  const BASE_LANG = 'ja';

  const dicts = {};      // code -> { key: 訳文 }
  const nativeNames = {}; // code -> その言語自身での言語名 ('日本語' / 'English')
  const listeners = [];
  let current = BASE_LANG;

  /*
   * 言語を登録する。言語追加は「このファイルを呼ぶ辞書ファイルを1つ足して
   * index.html に <script> を1行足す」だけで完結する(UIの言語選択肢も自動で増える)。
   */
  function register(code, nativeName, dict) {
    dicts[code] = dict || {};
    nativeNames[code] = nativeName;
  }

  function languages() {
    return Object.keys(dicts).map((code) => ({ code, name: nativeNames[code] }));
  }

  function getLang() { return current; }

  function setLang(code) {
    if (code !== BASE_LANG && !dicts[code]) return false;
    if (code === current) return true;
    current = code;
    for (const fn of listeners) {
      try { fn(code); } catch (e) { console.error('[i18n] リスナーで例外:', e); }
    }
    return true;
  }

  // 言語が切り替わったときに呼ばれるコールバックを登録する
  function onChange(fn) { listeners.push(fn); }

  /*
   * 文言取得。params を渡すと訳文中の {name} を置換する。
   *   t('停止')                          → 'Stop'
   *   t('{n}バイト読み込みました', {n:32}) → 'Loaded {n} bytes' → 'Loaded 32 bytes'
   */
  function t(key, params) {
    if (key === null || key === undefined) return '';
    let s;
    if (current !== BASE_LANG) {
      const d = dicts[current];
      if (d) s = d[key];
    }
    if (s === undefined) {
      // 未翻訳、または基準言語。"原文|文脈" のキーは文脈部分を落として原文に戻す
      const bar = key.lastIndexOf('|');
      s = (bar > 0) ? key.slice(0, bar) : key;
    }
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (m, name) =>
        (params[name] !== undefined && params[name] !== null) ? String(params[name]) : m);
    }
    return s;
  }

  /*
   * 翻訳漏れの一覧を返す(将来の言語追加・原文変更時の点検用)。
   * 使い方: コンソールで MML.I18n.missing('en')
   * 引数 extraKeys には、DOM走査で見つかった未知の原文などを渡せる。
   */
  function missing(code, extraKeys) {
    const d = dicts[code];
    if (!d) return { error: `未登録の言語: ${code}` };
    const seen = new Set(extraKeys || []);
    const notTranslated = [];
    for (const k of seen) if (d[k] === undefined) notTranslated.push(k);
    return {
      lang: code,
      translated: Object.keys(d).length,
      notTranslated: notTranslated.sort(),
    };
  }

  // 辞書に載っている原文かどうか(DOM走査側が未知文字列を集計するのに使う)
  function has(code, key) {
    return !!(dicts[code] && dicts[code][key] !== undefined);
  }

  MML.I18n = {
    BASE_LANG, register, languages, getLang, setLang, onChange, t, missing, has,
  };
})(typeof window !== 'undefined' ? window : globalThis);
