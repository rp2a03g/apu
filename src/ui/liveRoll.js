/*
 * ライブ表示(ロール追記モード)の入力層 (MML.UI.LiveRoll) — DESIGN-CAPTURE.md §6
 *
 * 外で動いているエミュレータ(Mesen など)のサウンドレジスタ書き込みを 1 フレームずつ受け取り、
 * 鍵盤表示のロールへ追記する(KeyboardDisplay.liveRollBegin / liveAppendFrame / liveRollEnd)。
 * 音はここでは出さない(鳴らしているのは外のエミュレータ)。先読みも曲頭の解析も無い。
 *
 * 入口は 2 つ:
 *   1. WebSocket 受信(connectWs): `ws://localhost:<port>` に繋ぎ、下の形式のメッセージを受ける。
 *      エミュレータ側の Lua などから直接でも、小さな中継(tools/live/vgm-ws-relay.js のような物)経由でもよい。
 *      本ツールは file:// で開いていても ws://localhost へは繋げる。
 *   2. 写し再生(replay): 既に持っている writeLog(今再生中の NSF の先読みキャプチャなど)を、
 *      時計(再生位置のフレーム、無ければ壁時計)に合わせて 1 フレームずつ流す。ライブ入力の無い環境で
 *      追記モードの表示と速さを確かめるための物(tools/headless/live-roll-test.js と対)。
 *
 * ■ メッセージ形式(JSON テキスト、1 メッセージ = 1 オブジェクト)
 *   {"t":"hello", "chips":["vrc6"], "fps":60.0988, "init":[addr,val,...], "initw":[addr,val,...], "name":"..."}
 *       chips: NSF の拡張音源名(vrc6/vrc7/fds/mmc5/n163/fme7。2A03 は常に含む)。他機種はまだ受けない。
 *       init : 録音開始時点のレジスタ像(アドレス,値 の平たい列。省略可)
 *       initw: 録音開始前の書き込み列(順序つき。N163 の波形 RAM/ch 数のように像では運べない物。省略可)
 *   {"t":"f", "w":[addr,val,addr,val,...], "r":[addr,...]}
 *       1 フレームぶんの書き込み(平たい列)。r は副作用つき読み出し(N163 $4800 の読み飛ばし)。
 *       書き込みの無いフレームも必ず送る(フレームの数が時計になる)。
 *   {"t":"end"}
 *   アドレスは CPU アドレス(NSF の writeLog と同じ。$4000-$4017 が 2A03、拡張音源は各マッパのレジスタ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const DEFAULT_WS_URL = 'ws://localhost:8765';
  const WS_URL_KEY = 'mml_liveRollWsUrl';
  const DEFAULT_FPS = 60.0988;

  // 平たい [addr,val,addr,val,...] → writeLog の 1 フレーム [{addr,value}]。r(読み飛ばし)は read:true
  function framePairsToWrites(w, r) {
    const out = [];
    if (Array.isArray(w)) for (let i = 0; i + 1 < w.length; i += 2) out.push({ addr: w[i] | 0, value: w[i + 1] & 0xFF });
    if (Array.isArray(r)) for (const a of r) out.push({ addr: a | 0, value: 0, read: true });
    return out;
  }
  function pairsToRegs(init) {
    const regs = {};
    if (Array.isArray(init)) for (let i = 0; i + 1 < init.length; i += 2) regs[init[i] | 0] = init[i + 1] & 0xFF;
    return regs;
  }

  /*
   * 1 本のライブ入力。begin(info) → pushFrame(writes)×n → end(reason)。
   * 受け取り側(main.js)は onBegin/onFrame/onEnd で鍵盤表示へつなぐ。
   */
  class LiveRollSession {
    constructor(handlers) {
      this.h = handlers || {};
      this.active = false;
      this.frames = 0;
      this.info = null;
      this.closer = null; // 入口側の後始末(WebSocket の close / 写し再生の停止)
    }
    begin(info) {
      if (this.active) this.end('restart');
      this.active = true;
      this.frames = 0;
      this.info = Object.assign({ chips: [], fps: DEFAULT_FPS, initRegs: {}, initWrites: null, name: '' }, info || {});
      if (this.h.onBegin) this.h.onBegin(this.info);
      this._status(T('ライブ入力: 受信中'));
    }
    pushFrame(writes) {
      if (!this.active) return;
      this.frames++;
      if (this.h.onFrame) this.h.onFrame(writes || []);
    }
    end(reason) {
      if (!this.active) return;
      this.active = false;
      const c = this.closer; this.closer = null;
      if (c) { try { c(); } catch (e) { /* ignore */ } }
      if (this.h.onEnd) this.h.onEnd(reason || 'end', this.frames);
      this._status(reason === 'error' ? T('ライブ入力: 切断されました') : T('ライブ入力: 終了({frames} フレーム)', { frames: this.frames }));
    }
    _status(text) { if (this.h.onStatus) this.h.onStatus(text); }
  }

  // ── 入口 1: WebSocket ───────────────────────────────────────────────────
  // 返り値は close()。hello が来るまで begin しない(チップ構成が要る)。
  function connectWs(url, session) {
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { session._status(T('ライブ入力: 接続できません({url})', { url })); return () => {}; }
    let opened = false;
    session._status(T('ライブ入力: 接続中 {url}', { url }));
    ws.onopen = () => { opened = true; session._status(T('ライブ入力: 接続しました。hello を待っています')); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        session.begin({ chips: Array.isArray(m.chips) ? m.chips.filter(c => typeof c === 'string') : [],
                        fps: (+m.fps > 0) ? +m.fps : DEFAULT_FPS, initRegs: pairsToRegs(m.init),
                        initWrites: Array.isArray(m.initw) ? framePairsToWrites(m.initw) : null, name: String(m.name || url) });
        session.closer = () => { try { ws.close(); } catch (e) { /* ignore */ } };
      } else if (m.t === 'f') {
        if (session.active) session.pushFrame(framePairsToWrites(m.w, m.r));
      } else if (m.t === 'end') {
        session.end('end');
        try { ws.close(); } catch (e) { /* ignore */ }
      }
    };
    ws.onerror = () => { if (!opened) session._status(T('ライブ入力: 接続できません({url})', { url })); };
    ws.onclose = () => { if (session.active) session.end('error'); else if (!opened) session._status(T('ライブ入力: 接続できません({url})', { url })); };
    return () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }

  // ── 入口 2: 写し再生 ────────────────────────────────────────────────────
  // writeLog を clock() が返すフレーム番号まで積む(rAF 駆動)。clock 省略時は壁時計(fps で刻む)。
  // writeLog[f] が未定義(先読みがまだ届いていない)なら待つ。clock が null を返したら終わり。
  function replay(src, session) {
    const writeLog = src.writeLog || [];
    const fps = src.fps || DEFAULT_FPS;
    const t0 = performance.now();
    const clock = src.clock || (() => Math.floor((performance.now() - t0) / 1000 * fps));
    let raf = 0, stopped = false;
    session.begin({ chips: src.chips || [], fps, initRegs: src.initRegs || {}, initWrites: src.initWrites || null, name: src.name || T('写し再生') });
    session.closer = () => { stopped = true; if (raf) cancelAnimationFrame(raf); };
    const tick = () => {
      if (stopped || !session.active) return;
      const target = clock();
      if (target === null || target === undefined) { session.end('end'); return; }
      const upto = Math.min(target + 1, writeLog.length);
      while (session.frames < upto && writeLog[session.frames] !== undefined) session.pushFrame(writeLog[session.frames]);
      if (session.frames >= writeLog.length && !src.clock) { session.end('end'); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { stopped = true; if (raf) cancelAnimationFrame(raf); };
  }

  // ── ポップオーバー(鍵盤表示ヘッダの LIVE ボタン直下) ─────────────────────
  // api = { session, connect(url), disconnect(), canReplay(), replay() }
  let popEl = null, popClose = null;
  function closePopover() {
    if (!popEl) return;
    popEl.remove(); popEl = null;
    if (popClose) { document.removeEventListener('mousedown', popClose, true); document.removeEventListener('keydown', popClose, true); popClose = null; }
  }
  function togglePopover(anchorEl, api) {
    if (popEl) { closePopover(); return; }
    const pop = document.createElement('div');
    pop.className = 'kbd-layout-pop live-roll-pop';
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());
    const sec = (title) => {
      const d = document.createElement('div'); d.className = 'kbd-layout-sec';
      if (title) { const t = document.createElement('div'); t.className = 'kbd-layout-sec-title'; t.textContent = title; d.appendChild(t); }
      pop.appendChild(d); return d;
    };
    const s1 = sec(T('ライブ入力 (外のエミュレータの書き込みをロールへ追記)'));
    const row = document.createElement('div'); row.className = 'live-roll-row';
    const urlIn = document.createElement('input'); urlIn.type = 'text'; urlIn.spellcheck = false;
    let saved = DEFAULT_WS_URL;
    try { saved = localStorage.getItem(WS_URL_KEY) || DEFAULT_WS_URL; } catch (e) { /* ignore */ }
    urlIn.value = saved;
    urlIn.placeholder = DEFAULT_WS_URL;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'live-roll-btn';
    row.appendChild(urlIn); row.appendChild(btn); s1.appendChild(row);
    const status = document.createElement('div'); status.className = 'live-roll-status'; s1.appendChild(status);
    const help = document.createElement('div'); help.className = 'live-roll-help';
    help.textContent = T('1行1メッセージのJSON: {"t":"hello","chips":[...],"fps":60.0988} のあと毎フレーム {"t":"f","w":[addr,val,...]}。未来は無いので、鳴った音符が鍵盤の縁から生えて遠ざかる表示になります');
    s1.appendChild(help);
    const s2 = sec(T('試験'));
    const rp = document.createElement('button'); rp.type = 'button'; rp.className = 'live-roll-btn';
    rp.textContent = T('再生中の曲の書き込みをその場で流す');
    rp.title = T('先読み済みの writeLog を再生位置に合わせて1フレームずつ追記する(ライブ入力の無い環境で表示と速さを確かめる用)');
    s2.appendChild(rp);
    const refresh = () => {
      const on = api.session.active;
      btn.textContent = on ? T('切断') : T('接続');
      urlIn.disabled = on;
      rp.disabled = on || !api.canReplay();
      status.textContent = api.lastStatus || '';
    };
    btn.addEventListener('click', () => {
      if (api.session.active) { api.disconnect(); }
      else {
        const url = (urlIn.value || '').trim() || DEFAULT_WS_URL;
        try { localStorage.setItem(WS_URL_KEY, url); } catch (e) { /* ignore */ }
        api.connect(url);
      }
      refresh();
    });
    rp.addEventListener('click', () => { api.replay(); refresh(); });
    api.onStatusChange = refresh;
    refresh();
    document.body.appendChild(pop);
    popEl = pop;
    // アンカーの直下、右端揃え。画面からはみ出す場合は左へ寄せる
    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right - pw, top = r.bottom + 4;
    if (left < 4) left = 4;
    if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    popClose = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (pop.contains(e.target) || anchorEl.contains(e.target))) return;
      api.onStatusChange = null;
      closePopover();
    };
    document.addEventListener('mousedown', popClose, true);
    document.addEventListener('keydown', popClose, true);
  }

  UI.LiveRoll = { LiveRollSession, connectWs, replay, togglePopover, closePopover, framePairsToWrites, pairsToRegs, DEFAULT_WS_URL, DEFAULT_FPS };
})(typeof window !== 'undefined' ? window : globalThis);
