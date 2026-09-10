/*
 * ヘッドレス実行用の最小 DOM/ブラウザAPI シム
 *   Node には document も AudioContext も無いが、src/ui/* や main.js は
 *   読み込み時点(トップレベル)で getElementById 等を呼ぶ。
 *   「何をしても壊れない偽要素」を返すことで、DOM非依存のコア層
 *   (emulator / *2mml / convert / mml) だけを実際に動かせるようにする。
 *
 * 注意: これはテスト用の張りぼてであって DOM の実装ではない。
 *       UIの挙動を検証する用途には使えない(それはブラウザでやること)。
 */
'use strict';

// 偽要素: 未知のプロパティは「呼べる・辿れる」偽物を返し、代入は覚える。
// undefined を返さねばならない特殊キーだけ除外する(await や for-of が壊れるため)。
const PASSTHRU_UNDEFINED = new Set(['then', 'toJSON', 'inspect', 'constructor']);

function makeFakeElement(tag = 'div') {
  const store = new Map();
  const target = function () {};
  const fake = new Proxy(target, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined;
      if (PASSTHRU_UNDEFINED.has(key)) return undefined;
      if (store.has(key)) return store.get(key);
      switch (key) {
        case 'tagName': return tag.toUpperCase();
        case 'nodeType': return 1;
        case 'nodeName': return tag.toUpperCase();
        case 'textContent': case 'innerHTML': case 'innerText':
        case 'value': case 'id': case 'className': case 'title': return '';
        case 'checked': case 'disabled': case 'hidden': return false;
        // 子/兄弟ノードは「無い」と答える(nullを返さないと while(el.firstChild) が無限ループになる。
        // keyboard.js _renderFileInfo で実際に起きた、2026-09-10)
        case 'firstChild': case 'lastChild': case 'firstElementChild': case 'lastElementChild':
        case 'nextSibling': case 'previousSibling':
        case 'nextElementSibling': case 'previousElementSibling': return null;
        case 'length': case 'offsetWidth': case 'offsetHeight':
        case 'clientWidth': case 'clientHeight':
        case 'scrollTop': case 'scrollLeft':
        case 'selectionStart': case 'selectionEnd': return 0;
        case 'children': case 'childNodes': case 'options': case 'files': return [];
        case 'dataset': return store.set(key, {}).get(key);
        case 'style': return store.set(key, makeFakeStyle()).get(key);
        case 'classList': return {
          add() {}, remove() {}, toggle() {}, contains() { return false; },
        };
        case 'getBoundingClientRect':
          return () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
        case 'getContext': return () => makeFakeCanvasContext();
        case 'appendChild': case 'insertBefore': return (child) => child;
        case 'cloneNode': return () => makeFakeElement(tag);
        case 'querySelector': case 'closest': return () => makeFakeElement();
        case 'querySelectorAll': case 'getElementsByTagName':
        case 'getElementsByClassName': return () => [];
        default: {
          const child = makeFakeElement(tag);
          store.set(key, child);
          return child;
        }
      }
    },
    set(_t, key, val) { store.set(key, val); return true; },
    has() { return true; },
    apply() { return undefined; },
    construct() { return makeFakeElement(); },
  });
  return fake;
}

// CSSStyleDeclaration 相当。任意プロパティの代入も setProperty も受ける。
function makeFakeStyle() {
  const props = new Map();
  return {
    setProperty(k, v) { props.set(String(k), String(v)); },
    getPropertyValue(k) { return props.get(String(k)) ?? ''; },
    removeProperty(k) { const v = props.get(String(k)) ?? ''; props.delete(String(k)); return v; },
    get cssText() { return Array.from(props, ([k, v]) => `${k}:${v}`).join(';'); },
  };
}

function makeFakeCanvasContext() {
  const ctx = makeFakeElement('canvas-2d');
  ctx.measureText = () => ({ width: 0 });
  ctx.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h });
  ctx.createImageData = (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h });
  ctx.canvas = makeFakeElement('canvas');
  return ctx;
}

function makeDocument() {
  const byId = new Map();
  const doc = makeFakeElement('document');
  doc.getElementById = (id) => {
    if (!byId.has(id)) byId.set(id, makeFakeElement('div'));
    return byId.get(id);
  };
  doc.createElement = (tag) => makeFakeElement(tag);
  doc.createElementNS = (_ns, tag) => makeFakeElement(tag);
  doc.createTextNode = () => makeFakeElement('#text');
  doc.createDocumentFragment = () => makeFakeElement('#fragment');
  doc.querySelector = () => makeFakeElement();
  doc.querySelectorAll = () => [];
  doc.getElementsByTagName = () => [];
  doc.getElementsByClassName = () => [];
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.body = makeFakeElement('body');
  doc.head = makeFakeElement('head');
  doc.documentElement = makeFakeElement('html');
  doc.createTreeWalker = () => ({ currentNode: null, nextNode: () => null, previousNode: () => null });
  doc.readyState = 'complete';
  doc.hidden = false;
  doc.title = '';
  doc.cookie = '';
  return doc;
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

// AudioContext / Worker はヘッドレスでは使わない。
// 「読み込み時に new されても落ちない」ことだけを保証する張りぼて。
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = makeFakeElement('audio-node');
    this.audioWorklet = { addModule: async () => {} };
  }
  createGain() { return makeFakeElement('gain'); }
  createBuffer(ch, len, rate) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: (i) => data[i] };
  }
  createBufferSource() { return makeFakeElement('buffer-source'); }
  createScriptProcessor() { return makeFakeElement('script-processor'); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}

class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; }
  postMessage() { throw new Error('FakeWorker: ヘッドレスでは Worker 経路は使えない(コア関数を直接呼ぶこと)'); }
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}

/** globalThis にブラウザ相当のグローバルを生やす(既存があれば尊重する) */
function installShim() {
  const g = globalThis;
  if (g.__mmlShimInstalled) return g;

  g.window = g;
  g.self = g;
  g.document = makeDocument();
  // Node 24 の navigator は getter のみ(代入不可)。language が無ければ足す。
  if (!g.navigator || typeof g.navigator.language !== 'string') {
    const base = g.navigator || {};
    const fake = { language: 'ja', languages: ['ja'], userAgent: 'headless-node', platform: 'win32' };
    for (const k of Object.keys(base)) { try { fake[k] = base[k]; } catch { /* 触れないプロパティは無視 */ } }
    Object.defineProperty(g, 'navigator', { value: fake, configurable: true, writable: true });
  }
  g.location = { href: 'file:///headless/index.html', protocol: 'file:', search: '', hash: '', hostname: '', pathname: '/headless/index.html' };
  g.localStorage = makeStorage();
  g.sessionStorage = makeStorage();
  g.AudioContext = FakeAudioContext;
  g.webkitAudioContext = FakeAudioContext;
  g.OfflineAudioContext = FakeAudioContext;
  g.Worker = FakeWorker;
  // 意図的に「コールバックを一度も呼ばない」。main.js の monitorLoop 等が
  // rAF で自己再登録し続けるため、実装するとプロセスが永久に終わらなくなる。
  // ヘッドレスに描画は要らないので、握って捨てるのが正しい。
  let rafId = 0;
  g.requestAnimationFrame = () => ++rafId;
  g.cancelAnimationFrame = () => {};
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  // 未知のCSSプロパティは '' 、getPropertyValue 等のメソッドは本物を返す
  g.getComputedStyle = () => {
    const style = makeFakeStyle();
    return new Proxy(style, { get: (t, k) => (k in t ? t[k] : '') });
  };
  g.alert = () => {};
  g.confirm = () => false;
  g.prompt = () => null;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.scrollTo = () => {};
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.MutationObserver = g.MutationObserver || class { observe() {} disconnect() {} takeRecords() { return []; } };
  g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.NodeFilter = {
    SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_COMMENT: 128,
    FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
  };
  g.devicePixelRatio = 1;
  g.innerWidth = 1280;
  g.innerHeight = 800;
  if (typeof g.URL.createObjectURL !== 'function') {
    g.URL.createObjectURL = () => 'blob:headless/0';
    g.URL.revokeObjectURL = () => {};
  }

  g.__mmlShimInstalled = true;
  return g;
}

module.exports = { installShim, makeFakeElement, makeDocument };
