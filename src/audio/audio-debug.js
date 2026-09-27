/*
 * 音の出口の診断(?debug=audio のときだけ有効。main.js が install() を呼ぶ)
 * MML.AudioDebug
 *
 * 目的: 「FILE に切り替えたら音痴になった(再現しない)」の切り分け(2026-09-28)。
 * 疑いは (1) 別のプレイヤーが止まらず重なって鳴っている、(2) SPC の再生が別の曲のデータと
 * 噛み合っている、の2系統。(1) を見るため、音を作るノード(ScriptProcessor と BufferSource)を
 * 作られた場所ごとに台帳へ載せ、実際に音を出しているか(出力の RMS)を毎回測る。
 * どの再生も同じ AudioContext のノードを通るので、プレイヤー側を1つずつ改造しなくても済む。
 *
 * install() は AudioContext のプロトタイプを差し替えるだけで、AudioContext 自体は作らない。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const AudioDebug = MML.AudioDebug = MML.AudioDebug || {};

  const entries = []; // { id, label, kind, createdAt, connected, calls, lastCallAt, rms, lastLoudAt, peakRms, ended }
  let nextId = 1;
  let installed = false;

  // 作った場所(呼び出し元の関数名とファイル:行)を名札にする
  function callerLabel() {
    // 共通の親クラスで作るプレイヤーもあるので、呼び出し元を2段まで並べる
    const stack = (new Error().stack || '').split('\n').slice(1);
    const out = [];
    for (const line of stack) {
      if (/audio-debug\.js/.test(line)) continue;
      const m = /at\s+(?:new\s+)?([^\s(]+)\s*\(?([^)]*)\)?/.exec(line.trim());
      if (!m) continue;
      const file = (m[2] || '').replace(/^.*\//, '').replace(/\?[^:]*/, '').replace(/:\d+$/, '');
      out.push(m[1] + (file ? '@' + file : ''));
      if (out.length >= 2) break;
    }
    return out.join(' ← ') || '?';
  }

  function rmsOf(buf) {
    let s = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i += 8) { s += d[i] * d[i]; n++; }
    }
    return n ? Math.sqrt(s / n) : 0;
  }

  AudioDebug.install = function () {
    if (installed) return;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    installed = true;
    const proto = AC.prototype;

    const origSP = proto.createScriptProcessor;
    if (origSP) {
      const spDesc = Object.getOwnPropertyDescriptor(global.ScriptProcessorNode.prototype, 'onaudioprocess');
      proto.createScriptProcessor = function () {
        const node = origSP.apply(this, arguments);
        const e = { id: nextId++, label: callerLabel(), kind: 'SP', createdAt: performance.now(), connected: false, calls: 0, lastCallAt: 0, rms: 0, lastLoudAt: 0, peakRms: 0, ended: false };
        entries.push(e);
        node.__dbg = e;
        let userFn = null;
        Object.defineProperty(node, 'onaudioprocess', {
          configurable: true,
          get() { return userFn; },
          set(fn) {
            userFn = fn;
            spDesc.set.call(node, fn ? function (ev) {
              fn.call(this, ev);
              e.calls++;
              e.lastCallAt = performance.now();
              e.rms = rmsOf(ev.outputBuffer);
              if (e.rms > 1e-4) { e.lastLoudAt = e.lastCallAt; if (e.rms > e.peakRms) e.peakRms = e.rms; }
            } : null);
          }
        });
        return node;
      };
    }

    const origBS = proto.createBufferSource;
    if (origBS) {
      proto.createBufferSource = function () {
        const node = origBS.apply(this, arguments);
        const e = { id: nextId++, label: callerLabel(), kind: 'BS', createdAt: performance.now(), connected: false, calls: 0, lastCallAt: 0, rms: 0, lastLoudAt: 0, peakRms: 0, ended: false, started: false };
        entries.push(e);
        node.__dbg = e;
        const st = node.start, sp = node.stop;
        node.start = function () { e.started = true; e.startedAt = performance.now(); return st.apply(node, arguments); };
        node.stop = function () { e.ended = true; return sp.apply(node, arguments); };
        node.addEventListener('ended', () => { e.ended = true; });
        return node;
      };
    }

    const AN = global.AudioNode && global.AudioNode.prototype;
    if (AN) {
      const oc = AN.connect, od = AN.disconnect;
      AN.connect = function () { if (this.__dbg) this.__dbg.connected = true; return oc.apply(this, arguments); };
      AN.disconnect = function () { if (this.__dbg && arguments.length === 0) this.__dbg.connected = false; return od.apply(this, arguments); };
    }
  };

  /** 直近 windowMs に音(RMS>1e-4)を出したノード。BufferSource は開始済みで未終了のもの。 */
  AudioDebug.audible = function (windowMs) {
    const now = performance.now();
    const w = windowMs || 1200;
    return entries.filter(e => e.kind === 'SP'
      ? (e.connected && e.lastLoudAt && now - e.lastLoudAt < w)
      : (e.started && !e.ended && e.connected));
  };

  /** 動いている(onaudioprocess が直近に呼ばれた)ノード。無音でも載る */
  AudioDebug.running = function (windowMs) {
    const now = performance.now();
    const w = windowMs || 1200;
    return entries.filter(e => e.kind === 'SP' ? (e.lastCallAt && now - e.lastCallAt < w) : (e.started && !e.ended));
  };

  AudioDebug.describe = function (e) {
    return '#' + e.id + ' ' + e.kind + ' ' + e.label + (e.kind === 'SP' ? ' rms=' + e.rms.toFixed(4) : '') + (e.connected ? '' : ' (切断)');
  };

  AudioDebug.entries = () => entries.slice();

  // ---- 小物 ----
  let crcTable = null;
  AudioDebug.crc32 = function (bytes) {
    if (!bytes) return null;
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
  };
})(typeof window !== 'undefined' ? window : globalThis);
