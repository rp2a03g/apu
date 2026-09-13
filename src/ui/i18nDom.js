/*
 * 多言語表示のDOM適用 (MML.I18nDom) — UI層
 *
 * index.html に data-i18n 属性を約300個書き足す代わりに、DOMを走査して
 * 「辞書に載っている日本語」を自動的に置き換える(gettext式。src/i18n/i18n.js 参照)。
 * これにより静的HTML側は一切の変更なしで多言語化でき、原文を書き換えても
 * HTMLと辞書の二重管理が発生しない。
 *
 * 走査対象: テキストノード / title / placeholder / aria-label / value(ボタン系)
 * 走査除外: ユーザーの入力内容とJS生成の出力(下の SKIP_SELECTOR)。
 *   JSが動的に作る文言は MML.I18n.t() を通す側で翻訳済みなので、ここでは触らない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const I18n = MML.I18n;

  const STORAGE_KEY = 'mml.lang';

  // ユーザーが打ったMML・JSが埋める出力欄は翻訳してはいけない
  const SKIP_SELECTOR = 'textarea, script, style, .output, .mml-highlight, [data-i18n-skip]';

  const ATTRS = ['title', 'placeholder', 'aria-label'];

  /*
   * 各ノードの「原文(日本語)」を覚えておく。翻訳済みテキストを再翻訳すると
   * 英語→英語の引き直しになって元に戻せなくなるため、必ず原文から引き直す。
   */
  const originalText = new WeakMap();  // textNode -> 原文
  const originalAttr = new WeakMap();  // element  -> { attr: 原文 }
  // 最後にここで書き込んだ値。ノードの現在値がこれと違えば、その後JSが書き換えた(=新しい原文)とみなす。
  // 覚えた原文を無条件に使うと、状態で変わる文言(再生⇔一時停止のツールチップ等)が言語切替のたびに古い値へ戻る
  const writtenText = new WeakMap();   // textNode -> 最後に書いた値
  const writtenAttr = new WeakMap();   // element  -> { attr: 最後に書いた値 }

  const HAS_JA = /[ぁ-ゖァ-ヺ一-鿿]/;

  /*
   * 辞書キーの正規化。HTMLの説明文はインデント付きで複数行に折り返されているので、
   * 改行+インデントを空白1個に畳んでからキーにする(辞書側は1行で書ける)。
   * HTMLの通常要素では空白の連続は元々1個に描画されるため、見た目は変わらない。
   */
  function normalizeKey(s) {
    return s.trim().replace(/\s+/g, ' ');
  }

  function shouldSkip(el) {
    return !!(el && el.closest && el.closest(SKIP_SELECTOR));
  }

  function translateTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkip(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

    for (const node of nodes) {
      let src = originalText.get(node);
      const written = writtenText.get(node);
      if (src === undefined || (written !== undefined && node.nodeValue !== written)) {
        src = node.nodeValue;
        originalText.set(node, src);
      }
      // 前後の空白・改行(インデント)は保ったまま中身だけ差し替える
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(src);
      const lead = m[1], tail = m[3];
      const body = normalizeKey(m[2]);
      if (!body) continue;
      const key = keyFor(body);
      const out = I18n.t(key);
      // 訳が無い・基準言語のままなら元の文字列(改行や字下げも保つ)。英語で作られた文言は原文へ戻して訳し直す
      const next = (key === body && out === body) ? src : lead + out + tail;
      if (node.nodeValue !== next) node.nodeValue = next;
      writtenText.set(node, next);
    }
  }

  // DOM上の文字列 → 辞書キー。日本語ならそのまま、英語表示中にJSが組み立てた訳文なら原文キーへ逆引きする
  function keyFor(text) {
    if (HAS_JA.test(text) || !I18n.keyOf) return text;
    return I18n.keyOf(text) || text;
  }

  function translateAttributes(root) {
    const els = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const el of els) {
      if (!el.getAttribute || shouldSkip(el)) continue;
      let saved = originalAttr.get(el);
      let written = writtenAttr.get(el);
      for (const attr of ATTRS) {
        const cur = el.getAttribute(attr);
        if (cur === null) continue;
        if (!saved) { saved = {}; originalAttr.set(el, saved); }
        if (!written) { written = {}; writtenAttr.set(el, written); }
        if (saved[attr] === undefined || (written[attr] !== undefined && cur !== written[attr])) saved[attr] = cur;
        const src = normalizeKey(saved[attr]);
        if (!src) continue;
        const out = I18n.t(keyFor(src));
        if (out !== cur) el.setAttribute(attr, out);
        written[attr] = out;
      }
    }
  }

  // 指定した要素以下を現在の言語で翻訳し直す。JSがDOMを組み立てた後にも呼べる
  function apply(root) {
    const target = root || document.body;
    translateTextNodes(target);
    translateAttributes(target);
  }

  function applyAll() {
    document.documentElement.lang = I18n.getLang();
    apply(document.body);
    // <title> はテキストノード走査の対象外(head配下)なので個別に扱う
    if (!originalText.has(document.head)) originalText.set(document.head, document.title);
    document.title = I18n.t(originalText.get(document.head));
  }

  function setLang(code) {
    if (!I18n.setLang(code)) return false;
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* プライベートモード等では保存しない */ }
    return true;
  }

  // 起動時の言語決定: 保存値 > ブラウザの言語設定 > 基準言語
  function initialLang() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* noop */ }
    const codes = I18n.languages().map((l) => l.code);
    if (saved && (saved === I18n.BASE_LANG || codes.includes(saved))) return saved;
    const navLangs = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || ''];
    for (const raw of navLangs) {
      const primary = String(raw).toLowerCase().split('-')[0];
      if (primary === I18n.BASE_LANG) return I18n.BASE_LANG;
      if (codes.includes(primary)) return primary;
    }
    return I18n.BASE_LANG;
  }

  // ヘッダーに言語選択を作る。選択肢は登録済み辞書から自動生成する
  function buildPicker() {
    const header = document.querySelector('header');
    if (!header) return;
    const wrap = document.createElement('div');
    wrap.className = 'lang-picker';
    wrap.setAttribute('data-i18n-skip', '');  // 言語名は翻訳しない(各言語の自称表記のまま出す)

    const sel = document.createElement('select');
    sel.id = 'langSelect';
    sel.setAttribute('aria-label', 'Language');
    const langs = I18n.languages();
    if (!langs.some((l) => l.code === I18n.BASE_LANG)) langs.unshift({ code: 'ja', name: '日本語' });
    for (const l of langs) {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      sel.appendChild(opt);
    }
    sel.value = I18n.getLang();
    sel.addEventListener('change', () => setLang(sel.value));
    wrap.appendChild(sel);
    header.appendChild(wrap);
  }

  function init() {
    if (!I18n) { console.error('[i18n] src/i18n/i18n.js が読み込まれていません'); return; }
    I18n.onChange(applyAll);
    I18n.setLang(initialLang());
    buildPicker();
    applyAll();
  }

  /*
   * 翻訳漏れの点検: 「今この瞬間に画面へ出ている日本語」を実走査して返す。
   * 翻訳適用時に集めるのではなく呼び出し時に数え直すのが要点 — 他モジュール
   * (keyboard.js等)は I18n.onChange で自分のDOMを作り直すので、適用時点の
   * スナップショットでは作り直し前の古い文字列を拾って誤検知になる。
   * 使い方: 目的の言語へ切り替え、確認したいウィンドウを開いた状態で呼ぶ。
   */
  function untranslated() {
    const found = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = normalizeKey(n.nodeValue || '');
      if (s && HAS_JA.test(s) && !shouldSkip(n.parentElement)) found.add(s);
    }
    for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
      if (shouldSkip(el)) continue;
      for (const attr of ATTRS) {
        const v = el.getAttribute(attr);
        if (v && HAS_JA.test(v)) found.add(normalizeKey(v));
      }
    }
    return Array.from(found).sort();
  }

  UI.I18nDom = { init, apply, applyAll, setLang, untranslated };

  /*
   * main.js より前に言語を確定させる必要がある(main.js は起動時に t() で文言を書き込むため)。
   * このスクリプトは全マークアップの後・main.js の前に読み込まれるので、その場で初期化する。
   */
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})(window);
