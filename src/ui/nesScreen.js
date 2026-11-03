/*
 * ゲーム画面 (MML.UI.NesScreen) — 自前 NES エミュレータ(src/emulator/nes/)の表示・操作・録音
 * (DESIGN-CAPTURE.md §6/§7。段階 6a=映像と入力、6b=AudioWorklet の実時間ループ・音・録音)
 *
 * ■ 実行の置き場
 *   AudioWorklet が使えるとき: エミュレータ本体は AudioWorklet(src/audio/nes-worklet-impl.js を
 *   tools/build-capture-workers.ps1 が nes-worklet.js に束ねた物)の中で動く。音の時刻でフレームが刻まれ、
 *   画面(256×240 の ArrayBuffer)が 1 枚ずつ届くので主スレッドは描くだけ。バンドルは data: URL で addModule する
 *   (file:// 直開きでも動く。Blob URL は file:// で addModule できない)。
 *   使えないとき(古いブラウザ、バンドル未ビルド、AudioContext 不可): 主スレッドの rAF で回す(音なし)。
 * ■ 窓の見出し
 *   見出しの文字は無く、アイコンのボタン列が見出し: [開く][リセット][早送り][状態保存][状態読込]([ディスク面][BIOS])[設定]
 *   … 右寄せで [一時停止][巻き戻し][録音]。本体はファイル名/状態/録音結果の行、画面、(タッチ端末では)操作キー。
 * ■ 録音(●)
 *   本体(NesConsole.startRecording)が音源レジスタの書き込みを積み、フレームごとに届く。止めると
 *   MML.VGM.encodeNesRecording で VGM(2A03 は標準、拡張音源 VRC6/VRC7/MMC5/N163/5B は NESX ブロック、DPCM は本体つき)にし、
 *   [VGM を保存](ダウンロード)と [変換へ](本体の VGM 経路で開いて鍵盤表示/MML 変換へ)を出す。
 * ■ ライブ表示(鍵盤表示のロールへ流す)
 *   同じ録音(書き込み列)を毎フレーム onLiveFrame で main.js へ渡し、main.js が鍵盤表示の追記モード
 *   (LiveRollSession → KeyboardDisplay.liveRollBegin/liveAppendFrame)につなぐ。VGM 録音とライブ表示は本体の録音を共有し、
 *   どちらかが始まる時は Worklet の record on(溜まった分を writes で先に返してから像を取り直す)、VGM を止める時は
 *   record off+keep(ライブが続くなら像を取り直して続ける)で切り替える。設定の「ロールへ流す」で ON/OFF。
 *   鍵盤表示のミュート/ch 別音量はそのままゲームの音に効く(applyMix → Worklet の mix)。
 * ■ 巻き戻し
 *   本体側(NesRewind: 0.5 秒ごとの状態スナップショット+毎フレームのパッド記録、2 分ぶん)が任意のフレームへ戻る。
 *   フレーム番号は本体の frameCount(Worklet の frame メッセージの seq)。ライブ表示のフレーム k は seq = liveBase + k なので、
 *   ロールのドラッグシーク(onRollSeek → rewindTo 秒)も、ボタン/キー/パッドの巻き戻し(1 秒ずつ)も同じ rewind メッセージで戻り、
 *   戻ったら鍵盤表示のロールを onLiveTruncate で切り詰める(戻った先の像は録音の取り直しで届く)。VGM 録音中なら録音も切り詰める。
 * ■ 入力
 *   キー割り当て・ゲームパッドのボタン割り当て・連射(A/B)は ⚙ 設定で変えられ、localStorage(nes.cfg)に残る。
 *   既定: 十字=矢印、A=X、B=Z、連射 A=S、連射 B=A、Start=Enter、Select=Shift、F=早送り、R=巻き戻し、P=一時停止、
 *   F5/F7=状態保存/読込。canvas にフォーカスがあるときだけ(エディタの矢印を奪わない)。
 *   ゲームパッドは標準配置(0=A、1=B、2=連射 B、3=連射 A、4=巻き戻し、5=早送り、8=Select、9=Start、12-15=十字、左スティック)。
 *   つながっている順に 1P(キーボードと合成)、2P(2 台目)。連射は本体(NesConsole.setController の turbo)が turboRate フレームごとに
 *   押す/離す。タッチ端末では画面の下に十字/A/B/連射/Select/Start を出す(複数指対応、指を滑らせても追う)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const FPS = 60.0988;
  const FRAME_MS = 1000 / FPS;
  const NSF_GAIN = 1.56; // stream-player.js と同じ実測 RMS 校正値
  const REWIND_STEP = 60;      // 巻き戻しボタン/キー/パッド 1 回で戻るフレーム数(1 秒)
  const REWIND_REPEAT_MS = 250; // 押している間の繰り返し(1 秒を 0.25 秒ごと = 4 倍速で戻る)

  // ── 設定(localStorage nes.cfg)──
  const CFG_KEY = 'nes.cfg';
  const PAD_BITS = { A: 1, B: 2, Select: 4, Start: 8, Up: 16, Down: 32, Left: 64, Right: 128 };
  const KEY_ACTIONS = ['A', 'B', 'TurboA', 'TurboB', 'Select', 'Start', 'Up', 'Down', 'Left', 'Right', 'FF', 'Rewind', 'Pause', 'SaveState', 'LoadState'];
  const PAD_ACTIONS = ['A', 'B', 'TurboA', 'TurboB', 'Select', 'Start', 'FF', 'Rewind', 'Pause', 'SaveState', 'LoadState'];
  const TURBO_RATES = [1, 2, 3, 4]; // 押す/離すの長さ(フレーム)。1=30 回/秒、2=15、3=10、4=7.5
  const SPEEDS = [1, 2, 4, 8];
  const DEFAULT_CFG = {
    keys: { A: 'KeyX', B: 'KeyZ', TurboA: 'KeyS', TurboB: 'KeyA', Select: 'ShiftLeft', Start: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
      FF: 'KeyF', Rewind: 'KeyR', Pause: 'KeyP', SaveState: 'F5', LoadState: 'F7' },
    pad: { A: 0, B: 1, TurboA: 3, TurboB: 2, Select: 8, Start: 9, FF: 5, Rewind: 4, Pause: -1, SaveState: -1, LoadState: -1 },
    turboRate: 2,
    liveRoll: true,
  };
  function loadCfg() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { /* localStorage 不可 */ }
    c = c && typeof c === 'object' ? c : {};
    return {
      keys: Object.assign({}, DEFAULT_CFG.keys, c.keys && typeof c.keys === 'object' ? c.keys : null),
      pad: Object.assign({}, DEFAULT_CFG.pad, c.pad && typeof c.pad === 'object' ? c.pad : null),
      turboRate: TURBO_RATES.includes(c.turboRate) ? c.turboRate : DEFAULT_CFG.turboRate,
      liveRoll: typeof c.liveRoll === 'boolean' ? c.liveRoll : DEFAULT_CFG.liveRoll,
    };
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }
  let cfg = loadCfg();
  function keyActionOf(code) { for (const a of KEY_ACTIONS) if (cfg.keys[a] === code) return a; return null; }
  function actionLabel(a) {
    return { A: 'A', B: 'B', TurboA: T('連射 A'), TurboB: T('連射 B'), Select: 'Select', Start: 'Start', Up: T('上'), Down: T('下'), Left: T('左'), Right: T('右'),
      FF: T('早送り(押している間)'), Rewind: T('巻き戻し(押している間)'), Pause: T('一時停止'), SaveState: T('状態保存'), LoadState: T('状態読込') }[a] || a;
  }
  // KeyboardEvent.code → 表示名
  function keyLabel(code) {
    if (!code) return T('(なし)');
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(.+)$/.exec(code))) return T('テンキー {k}', { k: m[1] });
    const names = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: T('左 Shift'), ShiftRight: T('右 Shift'), ControlLeft: T('左 Ctrl'), ControlRight: T('右 Ctrl'),
      AltLeft: T('左 Alt'), AltRight: T('右 Alt'), Space: T('スペース'), Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Esc' };
    return names[code] || code;
  }

  let win = null, canvas = null, ctx2d = null, statusEl = null, nameEl = null, pauseBtn = null, recBtn = null, saveBtn = null, convBtn = null, recInfoEl = null, rewindBtn = null;
  let romName = '', romBytes = null;
  let image = null, imageBuf = null;
  let keyBits = 0, keyTurbo = 0, touchBits = 0, touchTurbo = 0, lastPad = -1;
  let fpsCount = 0, fpsMs = 0, fps = 0, frameSeq = 0, underruns = 0; // frameSeq: 本体の frameCount(最後に届いたフレーム)、underruns: 音切れ回数
  let paused = false;
  // 主スレッド実行(音なし)
  let nes = null, raf = 0, lastMs = 0, acc = 0, rewindBuf = null;
  // AudioWorklet 実行
  let actx = null, node = null, gain = null, limiter = null, workletState = null; // null | 'loading' | 'ok' | 'failed'
  let gpRaf = 0;
  // 録音
  let recording = false, recFrames = null, recStartMs = 0, recVgm = null, recExtBits = 0, recBase = null;
  // FDS(段階 6d): BIOS は利用者が用意する(disksys.rom、8K)。localStorage に base64 で控える
  const BIOS_KEY = 'nes.fdsBios';
  let fdsBios = null, biosBtn = null, biosInput = null, sideBtn = null, fdsSides = 0, fdsSide = 0, pendingFds = null, sideTimer = 0;
  let romInput = null, cfgBtn = null, speedBtn = null, stateBtnS = null, stateBtnL = null;

  // ── セーブ(バッテリ RAM / FDS ディスク)──
  // ROM の内容のハッシュをキーに IndexedDB(nes-battery/sram)へ。本体(Worklet 内)が 1 秒ごとに「変わっていれば」送ってくる
  // (battery メッセージ)。別の ROM を開く時と閉じる時は unload を送って最後の分を待つ。主スレッド実行時は tick が見る。
  const BAT_DB = 'nes-battery', BAT_STORE = 'sram';
  let batteryKey = '', batteryWait = null, hasBattery = false;
  function romKey(bytes) {
    // FNV-1a 32bit を 2 系統(種を変える)+長さ。暗号用途ではなく同じ ROM を見分けるだけ
    let a = 0x811C9DC5, b = 0x050C5D1F;
    for (let i = 0; i < bytes.length; i++) { a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0; b = Math.imul(b ^ bytes[i], 0x01000193) >>> 0; }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + ':' + bytes.length;
  }
  function idb(fn, mode) {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      let req;
      try { req = indexedDB.open(BAT_DB, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(BAT_STORE)) db.createObjectStore(BAT_STORE); };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(BAT_STORE, mode || 'readonly');
          const r = fn(tx.objectStore(BAT_STORE));
          tx.oncomplete = () => { db.close(); resolve(r && r.result !== undefined ? r.result : true); };
          tx.onerror = () => { db.close(); resolve(null); };
        } catch (e) { db.close(); resolve(null); }
      };
    });
  }
  async function loadBattery(key) {
    const rec = await idb((st) => st.get(key));
    return rec && rec.data instanceof Uint8Array ? rec.data : null;
  }
  async function saveBattery(key, data) {
    if (!key || !data) return;
    await idb((st) => st.put({ data, name: romName, time: Date.now() }, key), 'readwrite');
  }
  // Worklet 内の最後の分を受け取る(battery final=true を待つ。300ms で諦める)
  function flushBattery() {
    if (!node || !hasBattery) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { batteryWait = null; resolve(); }, 300);
      batteryWait = () => { clearTimeout(t); batteryWait = null; resolve(); };
      try { node.port.postMessage({ type: 'unload' }); } catch (e) { batteryWait(); }
    });
  }
  function onBatteryMessage(m) {
    if (m.data) saveBattery(batteryKey, new Uint8Array(m.data));
    if (m.final && batteryWait) batteryWait();
  }
  window.addEventListener('pagehide', () => { if (node && hasBattery) { try { node.port.postMessage({ type: 'unload' }); } catch (e) { /* ignore */ } } });

  // ── ステート(状態の保存・読込。ROM ごとに 1 つ。IndexedDB の state ストア、キーは ROM 内容のハッシュ)──
  const STATE_STORE = 'state';
  let stateKey = '', flashTimer = 0;
  function idbState(fn, mode) {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      let req;
      try { req = indexedDB.open(BAT_DB, 2); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(BAT_STORE)) db.createObjectStore(BAT_STORE); if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE); };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(STATE_STORE, mode || 'readonly');
          const r = fn(tx.objectStore(STATE_STORE));
          tx.oncomplete = () => { db.close(); resolve(r && r.result !== undefined ? r.result : true); };
          tx.onerror = () => { db.close(); resolve(null); };
        } catch (e) { db.close(); resolve(null); }
      };
    });
  }
  function flashStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashTimer = 0; updateStatus(); }, 2500);
  }
  async function saveStateRecord(state) {
    if (!state || !stateKey) return;
    await idbState((st) => st.put({ state, name: romName, time: Date.now() }, stateKey), 'readwrite');
    flashStatus(T('ステートを保存しました'));
  }
  function requestSaveState() {
    if (node) node.port.postMessage({ type: 'saveState' });
    else if (nes) saveStateRecord(MML.Emu.NesState.save(nes));
  }
  async function requestLoadState() {
    if (!stateKey) return;
    const rec = await idbState((st) => st.get(stateKey));
    if (!rec || !rec.state) { flashStatus(T('この ROM のステートはまだありません')); return; }
    if (node) node.port.postMessage({ type: 'loadState', state: rec.state });
    else if (nes) {
      const ok = MML.Emu.NesState.load(nes, rec.state);
      flashStatus(ok ? T('ステートを読み込みました') : T('ステートを読み込めません(別の ROM の物か、形式が違います)'));
      if (ok) { if (rewindBuf) rewindBuf.clear(); liveRestart(); }
    }
  }

  function loadBios() {
    if (fdsBios) return fdsBios;
    try {
      const s = localStorage.getItem(BIOS_KEY);
      if (s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i); fdsBios = b; }
    } catch (e) { /* localStorage 不可 */ }
    return fdsBios;
  }
  function storeBios(bytes) {
    fdsBios = bytes;
    try { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); localStorage.setItem(BIOS_KEY, btoa(s)); } catch (e) { /* 控えられなくても今回は使える */ }
  }
  function sideLabel() { return T('ディスク {side} 面', { side: String.fromCharCode(65 + (fdsSide % 26)) }); }
  function updateDiskUi() {
    if (!sideBtn) return;
    sideBtn.hidden = fdsSides < 2;
    sideBtn.querySelector('.nes-ib-lbl').textContent = String.fromCharCode(65 + (fdsSide % 26));
    sideBtn.title = sideLabel() + ' — ' + T('クリックで次の面に入れ替える(取り出してから入れる)');
  }
  // 面の入れ替え: 取り出し → 少し待って次の面を入れる(ゲームの BIOS が「ディスクなし」を見てから入れ直す)
  function switchSide(next) {
    fdsSide = ((next % fdsSides) + fdsSides) % fdsSides;
    const send = (side) => { if (node) node.port.postMessage({ type: 'disk', side }); else if (nes) { if (side < 0) nes.ejectDisk(); else nes.insertDisk(side); if (rewindBuf) rewindBuf.clear(); } };
    send(-1);
    if (sideTimer) clearTimeout(sideTimer);
    sideTimer = setTimeout(() => { sideTimer = 0; send(fdsSide); updateDiskUi(); }, 1500);
    sideBtn.title = T('入れ替え中…');
  }

  // ── アイコン(見出しのボタン)──
  const ICON = {
    open: '<path d="M2.5 5.5h5l1.5 1.5H17.5v8.5h-15z"/>',
    reset: '<path d="M4.6 10a5.6 5.6 0 1 0 1.7-4"/><path d="M4.2 3.6v3.4h3.4"/>',
    ff: '<path d="M3 5.5v9l6-4.5zM10.5 5.5v9l6-4.5z" fill="currentColor" stroke="none"/>',
    rewind: '<path d="M17 5.5v9l-6-4.5zM9.5 5.5v9l-6-4.5z" fill="currentColor" stroke="none"/>',
    saveState: '<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5"/><path d="M3.5 13.5v3h13v-3"/>',
    loadState: '<path d="M10 12V3M6.5 6.5 10 3l3.5 3.5"/><path d="M3.5 13.5v3h13v-3"/>',
    gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2.1M10 15.3v2.1M17.4 10h-2.1M4.7 10H2.6M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5M15.1 15.1l-1.5-1.5M6.4 6.4 4.9 4.9"/>',
    pause: '<path d="M6.5 4.5v11M13.5 4.5v11" stroke-width="2.4"/>',
    play: '<path d="M6 4.5v11l9-5.5z" fill="currentColor" stroke="none"/>',
    rec: '<circle cx="10" cy="10" r="5" fill="currentColor" stroke="none"/>',
    stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>',
    disk: '<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><circle cx="10" cy="10" r="2.5"/>',
    chip: '<rect x="4.5" y="4.5" width="11" height="11" rx="1"/><path d="M7.5 2v2.5M10 2v2.5M12.5 2v2.5M7.5 15.5V18M10 15.5V18M12.5 15.5V18M2 7.5h2.5M2 10h2.5M2 12.5h2.5M15.5 7.5H18M15.5 10H18M15.5 12.5H18"/>',
  };
  function svgOf(name) { return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>'; }
  function setIcon(btn, name) { btn.querySelector('svg').outerHTML = svgOf(name); }
  function mkIcon(name, title, onClick, label) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'nes-ib';
    b.innerHTML = svgOf(name) + (label !== undefined ? '<span class="nes-ib-lbl">' + label + '</span>' : '');
    b.title = title; b.setAttribute('aria-label', title);
    if (onClick) b.addEventListener('click', () => { onClick(); if (canvas) canvas.focus(); });
    return b;
  }
  function mkBtn(text, title, onClick, cls) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'nes-btn' + (cls ? ' ' + cls : '');
    if (text) b.textContent = text;
    if (title) b.title = title;
    b.addEventListener('click', () => { onClick(); if (canvas) canvas.focus(); });
    return b;
  }
  function openRomFile(f) {
    if (!f) return;
    f.arrayBuffer().then((buf) => NesScreen.open(new Uint8Array(buf), f.name)).catch((e) => { alert(T('この ROM は開けません: {msg}', { msg: e && e.message ? e.message : String(e) })); });
  }
  function ensureDom() {
    if (win) return true;
    win = document.getElementById('win-nes');
    if (!win) return false;
    const body = win.querySelector('.float-window-body');
    body.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'nes-screen';
    canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 240; canvas.className = 'nes-canvas'; canvas.tabIndex = 0;
    ctx2d = canvas.getContext('2d');
    imageBuf = new Uint8ClampedArray(256 * 240 * 4);
    image = new ImageData(imageBuf, 256, 240);
    // 見出し(タイトル行)はアイコンのボタン列。FloatingWindows は button/input を押してもドラッグを始めない
    const header = win.querySelector('.float-window-header');
    let hdr = header.querySelector('.fw-header-extra');
    if (!hdr) { hdr = document.createElement('span'); hdr.className = 'fw-header-extra nes-hdr'; header.insertBefore(hdr, header.querySelector('.float-window-close')); }
    hdr.innerHTML = '';
    romInput = document.createElement('input'); romInput.type = 'file'; romInput.accept = '.nes,.fds'; romInput.style.display = 'none';
    romInput.addEventListener('change', () => { const f = romInput.files && romInput.files[0]; romInput.value = ''; openRomFile(f); });
    const openBtn = mkIcon('open', T('開く(.nes/.fds。ウィンドウへのドロップでも開けます)'), () => romInput.click());
    const resetBtn = mkIcon('reset', T('リセット'), () => { if (node) node.port.postMessage({ type: 'reset' }); else if (nes) { nes.reset(); if (rewindBuf) rewindBuf.clear(); } liveRestart(); });
    speedBtn = mkIcon('ff', '', () => { speedSel = SPEEDS[(SPEEDS.indexOf(speedSel) + 1) % SPEEDS.length]; pushSpeed(); }, '');
    stateBtnS = mkIcon('saveState', '', requestSaveState);
    stateBtnL = mkIcon('loadState', '', requestLoadState);
    sideBtn = mkIcon('disk', '', () => { if (fdsSides > 1 && !sideTimer) switchSide(fdsSide + 1); }, 'A'); sideBtn.hidden = true;
    biosBtn = mkIcon('chip', T('ディスクシステムの BIOS(disksys.rom、8KB)を選ぶ。このブラウザに控えて次回も使います'), () => biosInput.click(), 'BIOS'); biosBtn.hidden = true;
    biosInput = document.createElement('input'); biosInput.type = 'file'; biosInput.accept = '.rom,.bin,.nes'; biosInput.style.display = 'none';
    biosInput.addEventListener('change', async () => {
      const f = biosInput.files && biosInput.files[0]; biosInput.value = '';
      if (!f) return;
      const b = new Uint8Array(await f.arrayBuffer());
      if (b.length < 0x2000) { alert(T('BIOS は 8KB 以上のファイルです: {name}', { name: f.name })); return; }
      storeBios(b.length === 0x2000 ? b : b.subarray(b.length - 0x2000));
      if (pendingFds) { const p = pendingFds; pendingFds = null; NesScreen.open(p.bytes, p.name).catch((e) => { statusEl.textContent = T('エラー: {msg}', { msg: e && e.message ? e.message : String(e) }); }); }
    });
    cfgBtn = mkIcon('gear', T('設定(キー/ゲームパッドの割り当て、連射、ロールへ流す)'), () => toggleCfgPopover(cfgBtn));
    const sp = document.createElement('span'); sp.className = 'nes-hdr-sp';
    pauseBtn = mkIcon('pause', T('一時停止'), () => setPaused(!paused));
    rewindBtn = mkIcon('rewind', '', null);
    attachHold(rewindBtn, () => rewindHoldStart(), () => rewindHoldEnd());
    recBtn = mkIcon('rec', '', toggleRecord); recBtn.classList.add('nes-rec');
    const right = document.createElement('span'); right.className = 'nes-hdr-r';
    for (const el of [pauseBtn, rewindBtn, recBtn]) right.appendChild(el);
    for (const el of [romInput, openBtn, resetBtn, speedBtn, stateBtnS, stateBtnL, sideBtn, biosBtn, biosInput, cfgBtn, sp, right]) hdr.appendChild(el);
    // 本体: 上にファイル名+状態+録音結果、画面、タッチ操作キー
    const bar = document.createElement('div'); bar.className = 'nes-bar';
    nameEl = document.createElement('span'); nameEl.className = 'nes-name';
    statusEl = document.createElement('span'); statusEl.className = 'nes-status';
    recInfoEl = document.createElement('span'); recInfoEl.className = 'nes-recinfo';
    saveBtn = mkBtn(T('VGM を保存'), '', saveRecording); saveBtn.hidden = true;
    convBtn = mkBtn(T('変換へ'), '', () => { if (recVgm && NesScreen.onOpenRecording) { setPaused(true); NesScreen.onOpenRecording(recVgm, recFileName()); } }); convBtn.hidden = true;
    bar.appendChild(nameEl); bar.appendChild(statusEl); bar.appendChild(recInfoEl); bar.appendChild(saveBtn); bar.appendChild(convBtn);
    wrap.appendChild(bar); wrap.appendChild(canvas);
    if (MML.Device && MML.Device.isTouch && MML.Device.isTouch()) wrap.appendChild(buildTouchPad());
    body.appendChild(wrap);
    applyCfgLabels();
    canvas.addEventListener('keydown', (e) => {
      const a = keyActionOf(e.code);
      if (!a) return;
      e.preventDefault();
      if (PAD_BITS[a]) { keyBits |= PAD_BITS[a]; pushPad(); }
      else if (a === 'TurboA') { keyTurbo |= 1; pushPad(); }
      else if (a === 'TurboB') { keyTurbo |= 2; pushPad(); }
      else if (a === 'FF') { if (!ffHold) { ffHold = true; pushSpeed(); } }
      else if (a === 'Rewind') { if (!e.repeat) rewindHoldStart(); }
      else if (a === 'Pause') { if (!e.repeat) setPaused(!paused); }
      else if (a === 'SaveState') { if (!e.repeat) requestSaveState(); }
      else if (a === 'LoadState') { if (!e.repeat) requestLoadState(); }
    });
    canvas.addEventListener('keyup', (e) => {
      const a = keyActionOf(e.code);
      if (!a) return;
      e.preventDefault();
      if (PAD_BITS[a]) { keyBits &= ~PAD_BITS[a]; pushPad(); }
      else if (a === 'TurboA') { keyTurbo &= ~1; pushPad(); }
      else if (a === 'TurboB') { keyTurbo &= ~2; pushPad(); }
      else if (a === 'FF') { ffHold = false; pushSpeed(); }
      else if (a === 'Rewind') rewindHoldEnd();
    });
    canvas.addEventListener('blur', () => { if (ffHold) { ffHold = false; pushSpeed(); } rewindHoldEnd(); keyBits = 0; keyTurbo = 0; pushPad(); });
    pushSpeed();
    canvas.addEventListener('pointerdown', () => { canvas.focus(); resumeAudio(); });
    // ROM のドロップ(窓のどこでも)
    win.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } });
    win.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && Array.from(e.dataTransfer.files).find((x) => /\.(nes|fds)$/i.test(x.name));
      if (!f) return; // ROM 以外は本体のドロップ処理に任せる
      e.preventDefault(); e.stopPropagation();
      openRomFile(f);
    });
    // 閉じたら止める、開いたら続ける(表示の切替は FloatingWindows が style.display で行う)
    new MutationObserver(() => { if (win.style.display === 'none') suspend(); else resume(); }).observe(win, { attributes: true, attributeFilter: ['style'] });
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else if (win.style.display !== 'none') resume(); });
    updateRecUi();
    return true;
  }
  // 押している間だけ(ボタン): pointerdown で始め、pointerup/離脱/キャンセルで終える
  function attachHold(btn, start, end) {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } start(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, () => end());
    btn.addEventListener('keydown', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!e.repeat) start(); } });
    btn.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.code === 'Enter') end(); });
    btn.addEventListener('blur', () => end());
  }
  // 設定が変わった時に、キー名を含む表示を取り直す
  function applyCfgLabels() {
    if (!canvas) return;
    const k = (a) => keyLabel(cfg.keys[a]);
    canvas.title = T('クリックしてキー入力(十字=矢印、A={a}、B={b}、連射 A={ta}、連射 B={tb}、Start={st}、Select={se}、{ff}=早送り、{rw}=巻き戻し、{pa}=一時停止)',
      { a: k('A'), b: k('B'), ta: k('TurboA'), tb: k('TurboB'), st: k('Start'), se: k('Select'), ff: k('FF'), rw: k('Rewind'), pa: k('Pause') });
    speedBtn.title = T('早送り。クリックで ×1→×2→×4→×8。{key} キーを押している間は ×4', { key: k('FF') });
    stateBtnS.title = T('今の状態をこのブラウザに保存(ROM ごとに 1 つ。{key})', { key: k('SaveState') });
    stateBtnL.title = T('保存した状態に戻す({key})', { key: k('LoadState') });
    rewindBtn.title = T('巻き戻し(押している間 1 秒ずつ戻る。{key} キー。鍵盤表示のロールをドラッグしても戻れます)', { key: k('Rewind') });
    for (const b of [speedBtn, stateBtnS, stateBtnL, rewindBtn]) b.setAttribute('aria-label', b.title);
  }

  // ── タッチ操作キー(タッチ端末だけ。画面の下)──
  // 十字/A/B/連射 A/B/Select/Start。複数の指を別々に追い(pointerId ごとに押しているボタン)、指を滑らせても下のボタンへ移る
  function buildTouchPad() {
    const pad = document.createElement('div'); pad.className = 'nes-tpad';
    const key = (cls, label, bits, turbo) => {
      const b = document.createElement('div'); b.className = 'nes-tkey ' + cls; b.textContent = label;
      if (bits) b.dataset.bits = String(bits);
      if (turbo) b.dataset.turbo = String(turbo);
      return b;
    };
    const dpad = document.createElement('div'); dpad.className = 'nes-tdpad';
    dpad.appendChild(key('nes-tk-up', '▲', PAD_BITS.Up)); dpad.appendChild(key('nes-tk-left', '◀', PAD_BITS.Left));
    dpad.appendChild(key('nes-tk-right', '▶', PAD_BITS.Right)); dpad.appendChild(key('nes-tk-down', '▼', PAD_BITS.Down));
    const mid = document.createElement('div'); mid.className = 'nes-tmid';
    mid.appendChild(key('nes-tk-small', 'SELECT', PAD_BITS.Select)); mid.appendChild(key('nes-tk-small', 'START', PAD_BITS.Start));
    const ab = document.createElement('div'); ab.className = 'nes-tab';
    const row1 = document.createElement('div'); row1.className = 'nes-trow';
    row1.appendChild(key('nes-tk-turbo', T('連射 B'), 0, 2)); row1.appendChild(key('nes-tk-turbo', T('連射 A'), 0, 1));
    const row2 = document.createElement('div'); row2.className = 'nes-trow';
    row2.appendChild(key('nes-tk-ab', 'B', PAD_BITS.B)); row2.appendChild(key('nes-tk-ab', 'A', PAD_BITS.A));
    ab.appendChild(row1); ab.appendChild(row2);
    pad.appendChild(dpad); pad.appendChild(mid); pad.appendChild(ab);
    const held = new Map(); // pointerId → 押しているキー要素
    const recompute = () => {
      let bits = 0, turbo = 0;
      const on = new Set(held.values());
      for (const el of on) { bits |= +(el.dataset.bits || 0); turbo |= +(el.dataset.turbo || 0); }
      for (const el of pad.querySelectorAll('.nes-tkey')) el.classList.toggle('is-on', on.has(el));
      touchBits = bits; touchTurbo = turbo;
      pushPad();
    };
    const keyAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.classList && el.classList.contains('nes-tkey') && pad.contains(el) ? el : null; };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault(); resumeAudio();
      try { pad.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      const k = keyAt(e.clientX, e.clientY);
      if (k) held.set(e.pointerId, k); else held.delete(e.pointerId);
      recompute();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!held.has(e.pointerId) && !(e.buttons & 1) && e.pointerType === 'mouse') return;
      const k = keyAt(e.clientX, e.clientY);
      const cur = held.get(e.pointerId) || null;
      if (k !== cur) { if (k) held.set(e.pointerId, k); else held.delete(e.pointerId); recompute(); }
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, (e) => { if (held.delete(e.pointerId)) recompute(); });
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    return pad;
  }

  // ── 設定ポップオーバー(⚙)──
  let popEl = null, popClose = null, captureCancel = null;
  function closeCfgPopover() {
    if (captureCancel) { captureCancel(); captureCancel = null; }
    if (!popEl) return;
    popEl.remove(); popEl = null;
    if (popClose) { document.removeEventListener('mousedown', popClose, true); document.removeEventListener('keydown', popClose, true); popClose = null; }
  }
  function toggleCfgPopover(anchorEl) {
    if (popEl) { closeCfgPopover(); return; }
    const pop = document.createElement('div');
    pop.className = 'kbd-layout-pop nes-cfg-pop';
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());
    const sec = (title) => {
      const d = document.createElement('div'); d.className = 'kbd-layout-sec';
      if (title) { const t = document.createElement('div'); t.className = 'kbd-layout-sec-title'; t.textContent = title; d.appendChild(t); }
      pop.appendChild(d); return d;
    };
    const note = (parent, text) => { const d = document.createElement('div'); d.className = 'nes-cfg-note'; d.textContent = text; parent.appendChild(d); return d; };
    // ロールへ流す
    const s0 = sec(T('鍵盤表示'));
    const lbl = document.createElement('label'); lbl.className = 'nes-cfg-check';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!cfg.liveRoll;
    chk.addEventListener('change', () => { cfg.liveRoll = chk.checked; saveCfg(); if (cfg.liveRoll) liveBegin(); else liveEnd('end'); });
    lbl.appendChild(chk); lbl.appendChild(document.createTextNode(' ' + T('鳴っている音をロールへ流す(ライブ表示)')));
    s0.appendChild(lbl);
    note(s0, T('鍵盤表示を開いておくと、音源レジスタの書き込みがその場で追記モードのロールに出ます(未来は無いので、鳴った音符が縁から生えて遠ざかる表示)。鍵盤表示のミュートと ch 別音量はゲームの音にも効き、ロールをドラッグするとゲームもそこまで巻き戻ります'));
    // 連射
    const s1 = sec(T('連射'));
    const row = document.createElement('div'); row.className = 'nes-cfg-row';
    const rl = document.createElement('span'); rl.textContent = T('速さ');
    const sel = document.createElement('select');
    for (const r of TURBO_RATES) { const o = document.createElement('option'); o.value = String(r); o.textContent = T('{n} 回/秒', { n: (30 / r) % 1 ? (30 / r).toFixed(1) : String(30 / r) }); sel.appendChild(o); }
    sel.value = String(cfg.turboRate);
    sel.addEventListener('change', () => { cfg.turboRate = +sel.value; saveCfg(); pushTurboRate(); });
    row.appendChild(rl); row.appendChild(sel); s1.appendChild(row);
    // キー割り当て
    const s2 = sec(T('キーボード(1P)'));
    const tbl = document.createElement('table'); tbl.className = 'nes-cfg-table';
    const keyBtns = {};
    for (const a of KEY_ACTIONS) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = actionLabel(a);
      const td2 = document.createElement('td');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nes-cfg-key secondary';
      b.addEventListener('click', () => captureKey(b, a));
      td2.appendChild(b); tr.appendChild(td1); tr.appendChild(td2); tbl.appendChild(tr);
      keyBtns[a] = b;
    }
    s2.appendChild(tbl);
    // ゲームパッド
    const s3 = sec(T('ゲームパッド(1P/2P 共通)'));
    const tbl2 = document.createElement('table'); tbl2.className = 'nes-cfg-table';
    const padBtns = {};
    for (const a of PAD_ACTIONS) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = actionLabel(a);
      const td2 = document.createElement('td');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nes-cfg-key secondary';
      b.addEventListener('click', () => capturePadButton(b, a));
      const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'nes-cfg-clear secondary'; clr.textContent = '×'; clr.title = T('割り当てを外す');
      clr.addEventListener('click', () => { cfg.pad[a] = -1; saveCfg(); refresh(); });
      td2.appendChild(b); td2.appendChild(clr); tr.appendChild(td1); tr.appendChild(td2); tbl2.appendChild(tr);
      padBtns[a] = b;
    }
    s3.appendChild(tbl2);
    note(s3, T('十字は 12-15 番のボタンと左スティック(固定)。つながっている順に 1P、2P。早送り/巻き戻しは押している間、一時停止/状態保存/読込は押した時'));
    const s4 = sec('');
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'nes-btn'; reset.textContent = T('既定に戻す');
    reset.addEventListener('click', () => { cfg = loadCfgDefaults(); saveCfg(); pushTurboRate(); sel.value = String(cfg.turboRate); chk.checked = cfg.liveRoll; refresh(); });
    s4.appendChild(reset);
    const refresh = () => {
      for (const a of KEY_ACTIONS) keyBtns[a].textContent = keyLabel(cfg.keys[a]);
      for (const a of PAD_ACTIONS) padBtns[a].textContent = cfg.pad[a] >= 0 ? T('ボタン {n}', { n: cfg.pad[a] }) : T('(なし)');
      applyCfgLabels();
    };
    // キーを 1 つ受け取る(Esc で取り消し)
    function captureKey(btn, action) {
      if (captureCancel) captureCancel();
      btn.textContent = T('キーを押してください…'); btn.classList.add('nes-cfg-key--wait');
      const h = (e) => {
        e.preventDefault(); e.stopPropagation();
        done();
        if (e.code !== 'Escape') {
          for (const o of KEY_ACTIONS) if (o !== action && cfg.keys[o] === e.code) cfg.keys[o] = ''; // 同じキーは 1 つの操作にだけ
          cfg.keys[action] = e.code; saveCfg();
        }
        refresh();
      };
      const done = () => { document.removeEventListener('keydown', h, true); btn.classList.remove('nes-cfg-key--wait'); captureCancel = null; };
      captureCancel = () => { done(); refresh(); };
      document.addEventListener('keydown', h, true);
    }
    // ゲームパッドのボタンを 1 つ受け取る(5 秒で取り消し)
    function capturePadButton(btn, action) {
      if (captureCancel) captureCancel();
      btn.textContent = T('パッドのボタンを押してください…'); btn.classList.add('nes-cfg-key--wait');
      const pressed = () => {
        const out = new Set();
        for (const gp of (navigator.getGamepads && navigator.getGamepads()) || []) {
          if (!gp || !gp.connected) continue;
          gp.buttons.forEach((x, i) => { if (x && (x.pressed || x.value > 0.5)) out.add(i); });
        }
        return out;
      };
      const before = pressed();
      const t0 = performance.now();
      let r = 0;
      const done = () => { if (r) cancelAnimationFrame(r); r = 0; btn.classList.remove('nes-cfg-key--wait'); captureCancel = null; };
      captureCancel = () => { done(); refresh(); };
      const poll = () => {
        r = 0;
        const now = pressed();
        for (const i of now) {
          if (before.has(i)) continue;
          done();
          for (const o of PAD_ACTIONS) if (o !== action && cfg.pad[o] === i) cfg.pad[o] = -1;
          cfg.pad[action] = i; saveCfg(); refresh();
          return;
        }
        for (const i of before) if (!now.has(i)) before.delete(i);
        if (performance.now() - t0 > 5000) { done(); refresh(); return; }
        r = requestAnimationFrame(poll);
      };
      r = requestAnimationFrame(poll);
    }
    refresh();
    document.body.appendChild(pop);
    popEl = pop;
    const rc = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = rc.right - pw, top = rc.bottom + 4;
    if (left < 4) left = 4;
    if (top + ph > window.innerHeight - 4) top = Math.max(4, Math.min(top, window.innerHeight - ph - 4));
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    popClose = (e) => {
      if (e.type === 'keydown') { if (e.key !== 'Escape' || captureCancel) return; }
      if (e.type === 'mousedown' && (pop.contains(e.target) || anchorEl.contains(e.target))) return;
      closeCfgPopover();
    };
    document.addEventListener('mousedown', popClose, true);
    document.addEventListener('keydown', popClose, true);
  }
  function loadCfgDefaults() { return { keys: Object.assign({}, DEFAULT_CFG.keys), pad: Object.assign({}, DEFAULT_CFG.pad), turboRate: DEFAULT_CFG.turboRate, liveRoll: cfg.liveRoll }; }

  // ── 入力 ──
  // ゲームパッド: つながっている順に 1P(キーボードと合成)、2P。戻り値は [[1P のビット, 連射ビット, 操作の集合], [2P ...]]
  function gamepadBits() {
    const out = [[0, 0, 0], [0, 0, 0]];
    let n = 0;
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      let bits = 0, turbo = 0, acts = 0;
      const b = gp.buttons, on = (i) => !!(i >= 0 && b[i] && (b[i].pressed || b[i].value > 0.5));
      for (let ai = 0; ai < PAD_ACTIONS.length; ai++) {
        const a = PAD_ACTIONS[ai];
        if (!on(cfg.pad[a])) continue;
        if (a === 'TurboA') turbo |= 1; else if (a === 'TurboB') turbo |= 2; else if (PAD_BITS[a]) bits |= PAD_BITS[a]; else acts |= 1 << ai;
      }
      if (on(12)) bits |= 16; if (on(13)) bits |= 32; if (on(14)) bits |= 64; if (on(15)) bits |= 128;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (ax < -0.5) bits |= 64; if (ax > 0.5) bits |= 128; if (ay < -0.5) bits |= 16; if (ay > 0.5) bits |= 32;
      out[n][0] = bits; out[n][1] = turbo; out[n][2] = acts; n++;
      if (n >= 2) break;
    }
    return out;
  }
  let lastPad2 = -1, lastPadActs = 0, padFF = false;
  function sendPad(port, bits, turbo) {
    if (node) node.port.postMessage({ type: 'pad', port, bits, turbo });
    else if (nes) nes.setController(port, bits, turbo);
  }
  function pushPad() {
    const gp = gamepadBits();
    const bits = keyBits | touchBits | gp[0][0], turbo = keyTurbo | touchTurbo | gp[0][1];
    const k1 = bits | (turbo << 8), k2 = gp[1][0] | (gp[1][1] << 8);
    if (k1 !== lastPad) { lastPad = k1; sendPad(0, bits, turbo); }
    if (k2 !== lastPad2) { lastPad2 = k2; sendPad(1, gp[1][0], gp[1][1]); }
    // パッドの操作(早送り/巻き戻し=押している間、一時停止/状態保存/読込=押した瞬間)。どちらのパッドでも
    const acts = gp[0][2] | gp[1][2];
    if (acts !== lastPadActs) {
      const down = acts & ~lastPadActs, up = lastPadActs & ~acts;
      lastPadActs = acts;
      const bit = (a) => 1 << PAD_ACTIONS.indexOf(a);
      if ((down | up) & bit('FF')) { padFF = !!(acts & bit('FF')); pushSpeed(); }
      if (down & bit('Rewind')) rewindHoldStart();
      if (up & bit('Rewind')) rewindHoldEnd();
      if (down & bit('Pause')) setPaused(!paused);
      if (down & bit('SaveState')) requestSaveState();
      if (down & bit('LoadState')) requestLoadState();
    }
  }
  function pushTurboRate() {
    if (node) node.port.postMessage({ type: 'turboRate', frames: cfg.turboRate });
    else if (nes) nes.setTurboRate(cfg.turboRate);
  }

  // ── 描画 ──
  function blitFrame(u32) {
    imageBuf.set(new Uint8ClampedArray(u32.buffer, u32.byteOffset, u32.byteLength));
    ctx2d.putImageData(image, 0, 0);
    fpsCount++;
  }
  function tickFps(now) {
    if (now - fpsMs >= 1000) { fps = fpsCount; fpsCount = 0; fpsMs = now; updateStatus(); }
  }
  function updateStatus() {
    if (!statusEl || flashTimer) return; // 一時表示(ステート保存/読込の結果)の間は上書きしない
    const mode = node ? T('音: AudioWorklet') : T('音なし(主スレッド)');
    statusEl.textContent = `${fps} fps · ${mode}` + (underruns ? ' · ' + T('音切れ {n} 回', { n: underruns }) : '') + (hasBattery ? ' · ' + T('セーブ') : '') + (liveActive ? ' · ' + T('ロール') : '');
    if (pendingFds) return; // BIOS 待ちの案内を消さない
    const chips = ['VRC6', 'VRC7', 'FDS', 'MMC5', 'N163', 'SUNSOFT 5B'].filter((_, i) => recExtBits & (1 << i)).join('+');
    statusEl.title = (chips ? chips + ' ' : '') + (workletState === 'failed' ? T('AudioWorklet が使えないので主スレッドで実行しています(音は出ません)') : '') +
      (hasBattery ? ' ' + T('セーブデータはこのブラウザ(IndexedDB)に自動保存します(1 秒ごと・閉じる時)。キー: {key}', { key: batteryKey }) : '') +
      (liveActive ? ' ' + T('鍵盤表示のロールへ流しています') : '');
  }

  // ── AudioWorklet 実行 ──
  function bundleDataUrl() {
    const fn = MML.WorkerBundles && MML.WorkerBundles.nesWorklet;
    if (typeof fn !== 'function') return null;
    const src = fn.toString();
    // 再ビルド忘れの検出(capture-worker-client.js と同じ考え方): 主スレッドの現行ソースがバンドルに含まれているか
    const probes = [MML.Emu.NesConsole, MML.Emu.PPU, MML.Emu.NesMappers && MML.Emu.NesMappers.MMC3, MML.Emu.NesMappers && MML.Emu.NesMappers.MMC5, MML.Emu.NesMappers && MML.Emu.NesMappers.VRC7, MML.Emu.FdsDisk && MML.Emu.FdsDisk.Mapper, MML.Emu.NesRewind];
    for (const p of probes) {
      if (typeof p !== 'function' || src.indexOf(p.toString()) < 0) {
        console.warn('[nes] nes-worklet.js がソースより古い(再ビルド忘れ)ため使いません。tools/build-capture-workers.ps1 で再ビルドしてください');
        return null;
      }
    }
    const code = '(' + src + ')();';
    return 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(code)));
  }
  async function startWorklet(bytes, battery) {
    if (workletState === 'failed') return false;
    try {
      if (!actx) actx = (NesScreen.getAudioContext && NesScreen.getAudioContext()) || new (window.AudioContext || window.webkitAudioContext)();
      if (!actx.audioWorklet) throw new Error('AudioWorklet unavailable');
      if (workletState !== 'ok') {
        const url = bundleDataUrl();
        if (!url) throw new Error('bundle unavailable');
        workletState = 'loading';
        await actx.audioWorklet.addModule(url);
        workletState = 'ok';
      }
      stopWorkletNode();
      node = new AudioWorkletNode(actx, 'nes-console', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => onWorkletMessage(e.data || {});
      gain = actx.createGain(); gain.gain.value = NSF_GAIN;
      limiter = actx.createDynamicsCompressor();
      limiter.threshold.value = -3.0; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.05;
      node.connect(gain); gain.connect(limiter);
      limiter.connect(MML.Audio && MML.Audio.getMasterGain ? MML.Audio.getMasterGain(actx) : actx.destination);
      const rom = bytes.slice().buffer;
      const bios = fdsBios ? fdsBios.slice().buffer : null;
      const bat = battery ? battery.slice().buffer : null;
      node.port.postMessage({ type: 'load', rom, bios, battery: bat }, [rom, bios, bat].filter(Boolean));
      resumeAudio();
      lastPad = -1; lastPad2 = -1; pushPad(); pushSpeed(); pushTurboRate();
      if (!gpRaf) gpRaf = requestAnimationFrame(gpLoop);
      return true;
    } catch (e) {
      console.warn('[nes] AudioWorklet で動かせないので主スレッドで動かします(音なし):', e && e.message);
      workletState = 'failed';
      stopWorkletNode();
      return false;
    }
  }
  function stopWorkletNode() {
    if (node) { try { node.port.onmessage = null; node.disconnect(); } catch (e) { /* ignore */ } node = null; }
    if (gain) { try { gain.disconnect(); } catch (e) { /* ignore */ } gain = null; }
    if (limiter) { try { limiter.disconnect(); } catch (e) { /* ignore */ } limiter = null; }
  }
  function resumeAudio() { if (actx && actx.state === 'suspended' && actx.resume) actx.resume().catch(() => {}); }
  function onWorkletMessage(m) {
    switch (m.type) {
      case 'frame': {
        blitFrame(new Uint32Array(m.frame));
        frameSeq = m.seq; underruns = m.underruns || 0;
        if (m.writes) takeFrames(m.writes, m.seq);
        tickFps(performance.now());
        break;
      }
      case 'writes': takeFrames(m.frames || [], frameSeq); break; // record on で像を取り直す前に溜まっていた分(最後は今の途中フレーム)
      case 'rewound': blitFrame(new Uint32Array(m.frame)); onRewound(m.seq); break;
      case 'loaded': nameEl.title = m.info; recExtBits = m.extBits || 0; fdsSides = m.disks || 0; fdsSide = 0; hasBattery = !!m.battery; updateDiskUi(); updateStatus(); break;
      case 'battery': onBatteryMessage(m); break;
      case 'state': saveStateRecord(m.state); break;
      case 'stateLoaded': flashStatus(m.ok ? T('ステートを読み込みました') : T('ステートを読み込めません(別の ROM の物か、形式が違います)')); if (m.ok) liveRestart(); break;
      case 'recordEnd': takeFrames(m.frames || [], frameSeq); finishRecording(); break;
      case 'error': console.error('[nes worklet]', m.message); statusEl.textContent = T('エラー: {msg}', { msg: String(m.message).split('\n')[0] }); break;
    }
  }
  // ゲームパッドはイベントが無いので rAF で見る(Worklet 実行時。主スレッド実行時は tick が見る)
  function gpLoop() {
    gpRaf = 0;
    if (!node) return;
    pushPad();
    gpRaf = requestAnimationFrame(gpLoop);
  }

  // ── 主スレッド実行(音なし) ──
  function tick(now) {
    raf = 0;
    if (!nes || paused) return;
    if (!lastMs) lastMs = now;
    acc += Math.min(100, now - lastMs);
    lastMs = now;
    let n = 0;
    pushPad();
    const sp = curSpeed(), fms = FRAME_MS / sp;
    while (acc >= fms && n < 3 * sp) { nes.runFrame(); if (rewindBuf) rewindBuf.onFrame(); acc -= fms; n++; }
    if (n) {
      blitFrame(nes.frame);
      frameSeq = nes.frameCount;
      if (nes.rec) takeFrames(nes.rec.frames.splice(0), frameSeq);
      if (hasBattery && nes.batteryDirty && (++mainFrames % 60) === 0) { saveBattery(batteryKey, nes.getBattery()); nes.clearBatteryDirty(); }
    }
    tickFps(now);
    raf = requestAnimationFrame(tick);
  }
  let mainFrames = 0;
  // 早送り: ボタンで ×1/×2/×4/×8、F キー(またはパッドの早送り)を押している間は ×4。Worklet には speed メッセージ、主スレッド実行は tick が倍の枚数を回す
  let speedSel = 1, ffHold = false;
  function curSpeed() { return (ffHold || padFF) ? Math.max(4, speedSel) : speedSel; }
  function pushSpeed() {
    const n = curSpeed();
    if (speedBtn) { speedBtn.querySelector('.nes-ib-lbl').textContent = n > 1 ? '×' + n : ''; speedBtn.classList.toggle('nes-ff', n > 1); }
    if (node) node.port.postMessage({ type: 'speed', n });
  }
  function startMain() { if (!raf) { lastMs = 0; raf = requestAnimationFrame(tick); } }
  function stopMain() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function setPaused(on) {
    paused = on;
    setIcon(pauseBtn, paused ? 'play' : 'pause');
    pauseBtn.title = paused ? T('再開') : T('一時停止'); pauseBtn.setAttribute('aria-label', pauseBtn.title);
    pauseBtn.classList.toggle('nes-paused', paused);
    if (node) node.port.postMessage({ type: 'pause', on: paused });
    else if (!paused) startMain();
  }
  function suspend() {
    if (node) node.port.postMessage({ type: 'pause', on: true });
    stopMain();
  }
  function resume() {
    if (paused) return;
    if (node) node.port.postMessage({ type: 'pause', on: false });
    else if (nes) startMain();
  }

  // ── 巻き戻し ──
  let rewindTimer = 0, rewindPending = 0, rewindDebounce = 0;
  function sendRewind(absFrame) {
    if (node) node.port.postMessage({ type: 'rewind', frame: absFrame });
    else if (nes && rewindBuf) {
      const wasRec = !!nes.rec;
      nes.rec = null;
      const got = rewindBuf.rewindTo(absFrame);
      if (wasRec) nes.startRecording();
      blitFrame(nes.frame);
      onRewound(got);
    }
  }
  // 戻った後: フレーム番号を合わせ、ロールと VGM 録音を切り詰める(像は録音の取り直しで次のフレームに届く)
  function onRewound(seq) {
    frameSeq = seq;
    if (liveActive) {
      const keep = liveBase === null ? -1 : seq - liveBase + 1;
      if (keep >= 0 && NesScreen.onLiveTruncate) NesScreen.onLiveTruncate(keep);
      else liveRestart();
    }
    if (recording && recFrames) {
      const keep = recBase === null ? -1 : seq - recBase + 1;
      if (keep >= 0) recFrames.length = Math.min(recFrames.length, keep);
      else { recFrames.length = 0; recBase = null; }
    }
  }
  function rewindStep() { if (!(node || nes)) return; sendRewind(Math.max(0, frameSeq - REWIND_STEP)); }
  function rewindHoldStart() {
    if (rewindTimer) return;
    rewindBtn.classList.add('nes-rewinding');
    rewindStep();
    rewindTimer = setInterval(rewindStep, REWIND_REPEAT_MS);
  }
  function rewindHoldEnd() {
    if (!rewindTimer) return;
    clearInterval(rewindTimer); rewindTimer = 0;
    rewindBtn.classList.remove('nes-rewinding');
  }
  // ロールのドラッグシーク(曲の秒 = ライブ表示のフレーム×フレーム長)から。戻せる範囲に丸めた秒を返す。
  // ドラッグ中は間引いて何度も来るので、少し待って最後の 1 回だけ戻す(戻るたびに状態の読込+再生が要るため)
  function rewindTo(sec) {
    if (!liveActive || liveBase === null || !(node || nes)) return null;
    const cur = frameSeq - liveBase + 1; // 今のライブ表示のフレーム数
    const target = Math.max(0, Math.min(cur, Math.floor(sec * FPS)));
    rewindPending = liveBase + target - 1; // 「ライブ表示のフレーム target まで残す」= seq がこの値まで
    if (rewindDebounce) clearTimeout(rewindDebounce);
    rewindDebounce = setTimeout(() => { rewindDebounce = 0; if (rewindPending < frameSeq) sendRewind(rewindPending); }, 120);
    return target / FPS;
  }

  // ── 録音(VGM)とライブ表示(ロール)。本体の録音を共有する ──
  // 届いたフレームごとの書き込み列を、VGM 録音中なら recFrames へ、ライブ表示中なら鍵盤表示へ。
  // lastSeq は frames の最後のフレームの番号(本体の frameCount)。最初の 1 回でライブ/録音のフレーム 0 ↔ seq の対応(base)を覚える
  function takeFrames(frames, lastSeq) {
    if (!frames.length) return;
    const first = lastSeq - frames.length + 1;
    if (recFrames && recBase === null) recBase = first;
    if (liveActive && liveBase === null) liveBase = first;
    for (const fr of frames) {
      if (recFrames) recFrames.push(fr);
      if (liveActive && NesScreen.onLiveFrame) NesScreen.onLiveFrame(toLiveWrites(fr));
    }
  }
  // 録音の 1 フレーム → ライブ表示の書き込み列 [{addr,value,read?}](DPCM 本体 {dmc} は落とす)
  function toLiveWrites(fr) {
    const out = [];
    for (const w of fr) if (w.addr !== undefined) out.push(w.read ? { addr: w.addr, value: 0, read: true } : { addr: w.addr, value: w.value });
    return out;
  }
  // 本体の録音の開始/停止。on: 溜まった分を先に受け取ってから像を取り直す。off: keep なら像を取り直して続ける、discard なら結果を捨てる
  function sendRecord(on, opt) {
    opt = opt || {};
    if (node) node.port.postMessage({ type: 'record', on, keep: !!opt.keep, discard: !!opt.discard });
    else if (nes) {
      if (on) { if (nes.rec) takeFrames(nes.stopRecording(), nes.frameCount); nes.startRecording(); }
      else {
        const frames = nes.stopRecording();
        if (!opt.discard) { takeFrames(frames, nes.frameCount); finishRecording(); }
        if (opt.keep) nes.startRecording();
      }
    }
  }
  let liveActive = false, liveBase = null;
  function chipNames() { return ['vrc6', 'vrc7', 'fds', 'mmc5', 'n163', 'fme7'].filter((_, i) => recExtBits & (1 << i)); }
  // ライブ表示を始める(設定 ON、main.js がつないでいる、本体が動いている時)。像つきで録音を回す
  function liveBegin() {
    if (!cfg.liveRoll || !NesScreen.onLiveBegin || !(node || nes)) return;
    if (liveActive) liveEnd('restart');
    liveActive = true; liveBase = null;
    NesScreen.onLiveBegin({ chips: chipNames(), fps: FPS, name: romName || 'NES' });
    sendRecord(true);
    applyMix();
    updateStatus();
  }
  // リセット/ステート読込: 書き込み無しにレジスタが変わり、フレーム番号もつながらないので、ロールを取り直す
  function liveRestart() { if (liveActive) liveBegin(); }
  function liveEnd(reason) {
    if (!liveActive) return;
    liveActive = false; liveBase = null;
    if (NesScreen.onLiveEnd) NesScreen.onLiveEnd(reason || 'end');
    if (!recording) sendRecord(false, { discard: true });
    updateStatus();
  }
  // 鍵盤表示側で終わった(別の曲を開いた、LIVE の切断など)
  function liveStopped() {
    if (!liveActive) return;
    liveActive = false; liveBase = null;
    if (!recording) sendRecord(false, { discard: true });
    updateStatus();
  }
  // 鍵盤表示のミュート/ch 別音量をゲームの音へ(main.js が getMuteConfig/getVolumeConfig の形で渡す。拡張音源は 1 つなので名前で引く)
  let lastMix = null;
  function applyMix(mute, volume) {
    if (mute || volume) lastMix = { mute: mute || (lastMix && lastMix.mute) || null, volume: volume || (lastMix && lastMix.volume) || null };
    if (!lastMix || !(node || nes)) return;
    const name = chipNames()[0];
    const pick = (cfgObj) => cfgObj ? { apu: cfgObj.apu || null, ext: (name && cfgObj.expansion && cfgObj.expansion[name]) || null } : null;
    const msg = { type: 'mix', mute: pick(lastMix.mute), volume: pick(lastMix.volume) };
    if (node) node.port.postMessage(msg);
    else if (nes) {
      const a = nes.mapper.audio;
      if (msg.mute) { if (msg.mute.apu) MML.Emu.applyMute(nes.apu.mute, msg.mute.apu); if (a && a.mute && msg.mute.ext) MML.Emu.applyMute(a.mute, msg.mute.ext); }
      if (msg.volume) { if (msg.volume.apu) MML.Emu.applyVolume(nes.apu.vol, msg.volume.apu); if (a && a.vol && msg.volume.ext) MML.Emu.applyVolume(a.vol, msg.volume.ext); }
    }
  }
  function recFileName() { return (romName || 'nes').replace(/\.(nes|fds)$/i, '') + '-rec.vgm'; }
  function toggleRecord() {
    if (recording) {
      recording = false;
      sendRecord(false, { keep: liveActive });
    } else {
      recording = true; recFrames = []; recBase = null; recVgm = null; recStartMs = performance.now();
      sendRecord(true);
    }
    updateRecUi();
  }
  function finishRecording() {
    const frames = recFrames || [];
    recFrames = null; recBase = null;
    const r = MML.VGM.encodeNesRecording({ frames, extBits: recExtBits, name: (romName || 'NES').replace(/\.nes$/i, ''), creator: 'Sound Emulation Foundry (NES)' });
    recVgm = r.vgm;
    recInfoEl.textContent = T('録音: {sec} 秒({frames} フレーム、{kb} KB)', { sec: (frames.length / FPS).toFixed(1), frames: frames.length, kb: (r.vgm.length / 1024).toFixed(1) });
    updateRecUi();
  }
  function saveRecording() {
    if (!recVgm) return;
    const blob = new Blob([recVgm], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = recFileName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function updateRecUi() {
    if (!recBtn) return;
    setIcon(recBtn, recording ? 'stop' : 'rec');
    recBtn.title = recording ? T('録音を止める(VGM にする)') : T('録音(音源レジスタの書き込みを VGM に)'); recBtn.setAttribute('aria-label', recBtn.title);
    recBtn.classList.toggle('nes-rec--on', recording);
    saveBtn.hidden = convBtn.hidden = !recVgm;
    if (recording) recInfoEl.textContent = T('録音中…');
    if (!recording && !recVgm) recInfoEl.textContent = '';
    if (recording && !recTimer) recTimer = setInterval(() => { if (!recording) { clearInterval(recTimer); recTimer = 0; return; } recInfoEl.textContent = T('録音中: {sec} 秒', { sec: ((performance.now() - recStartMs) / 1000).toFixed(0) }); }, 500);
  }
  let recTimer = 0;

  const NesScreen = {
    getAudioContext: null,   // () => AudioContext(main.js が共用の物を渡す)。無ければ自前で作る
    onOpenRecording: null,   // (vgmBytes, fileName) 録音を本体の VGM 経路で開く(main.js)
    onLiveBegin: null,       // ({chips, fps, name}) ライブ表示の開始(main.js が LiveRollSession につなぐ)
    onLiveFrame: null,       // (writes) 1 フレームぶんの書き込み列
    onLiveTruncate: null,    // (frames) 巻き戻し: ロールをこのフレーム数に切り詰める
    onLiveEnd: null,         // (reason) ライブ表示の終了
    liveStopped,             // 鍵盤表示側から「終わった」と知らせる
    rewindTo,                // (曲の秒) ロールのドラッグシークから。戻せる秒を返す(ライブ表示中でなければ null)
    applyMix,                // (muteConfig, volumeConfig) 鍵盤表示のミュート/音量
    // ROM(iNES のバイト列)を読み込んで表示・開始する。失敗は例外(マッパー未対応など)
    async open(bytes, name) {
      if (!ensureDom()) throw new Error('win-nes がありません');
      const isFds = !!(MML.Emu.FdsDisk && MML.Emu.FdsDisk.isFds(bytes));
      biosBtn.hidden = !isFds;
      if (isFds && !loadBios()) {
        // BIOS が無い: 窓を開いて選ばせ、選ばれたら開き直す
        pendingFds = { bytes, name };
        romName = name || ''; nameEl.textContent = romName; nameEl.title = '';
        win.style.display = 'flex';
        if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
        statusEl.textContent = T('FDS の BIOS(disksys.rom)を [BIOS] で指定してください');
        return null;
      }
      pendingFds = null;
      // ヘッダとマッパーの検査は主スレッドで先に(未対応なら例外で知らせる)
      const probe = new MML.Emu.NesConsole(bytes, { bios: isFds ? fdsBios : null });
      liveEnd('restart');
      rewindHoldEnd();
      await flushBattery(); // 前の ROM のセーブを受け取ってから止める
      romBytes = bytes; romName = name || '';
      stateKey = romKey(bytes);
      hasBattery = probe.hasBattery; batteryKey = hasBattery ? stateKey : '';
      const battery = hasBattery ? await loadBattery(batteryKey) : null;
      if (battery && probe.setBattery(battery)) console.log('[nes]', T('セーブデータを読み込みました({n} バイト)', { n: battery.length }));
      nameEl.textContent = romName;
      nameEl.title = MML.Emu.INES.describe(probe.rom);
      recExtBits = probe.extBits();
      fdsSides = probe.diskCount; fdsSide = 0; if (sideTimer) { clearTimeout(sideTimer); sideTimer = 0; } updateDiskUi();
      stopMain(); nes = null; rewindBuf = null;
      if (recording) { recording = false; recFrames = null; recBase = null; }
      recVgm = null; updateRecUi();
      paused = false; setIcon(pauseBtn, 'pause'); pauseBtn.classList.remove('nes-paused'); acc = 0; fpsCount = 0; fpsMs = 0; frameSeq = 0;
      win.style.display = 'flex';
      if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
      const btn = document.querySelector('.toggle-btn[data-target="win-nes"]');
      if (btn) btn.classList.add('active');
      blitFrame(probe.frame);
      const ok = await startWorklet(bytes, battery);
      if (!ok) { nes = probe; rewindBuf = MML.Emu.NesRewind ? new MML.Emu.NesRewind(nes) : null; lastPad = -1; lastPad2 = -1; mainFrames = 0; nes.setTurboRate(cfg.turboRate); startMain(); }
      liveBegin();
      updateStatus();
      canvas.focus();
      return ok ? null : nes;
    },
    async close() {
      liveEnd('end');
      rewindHoldEnd();
      if (nes && hasBattery && nes.batteryDirty) { saveBattery(batteryKey, nes.getBattery()); nes.clearBatteryDirty(); }
      await flushBattery();
      stopMain(); stopWorkletNode(); nes = null; rewindBuf = null;
    },
    get console() { return nes; },
    get running() { return !!(node || (nes && raf)); },
    get usingWorklet() { return !!node; },
    get stats() { return { frameSeq, underruns, fps, liveBase }; },
    get audioNodes() { return { ctx: actx, node, gain, limiter }; }, // 検証用(音が出ているかを外から測る)
    get live() { return liveActive; },
    get config() { return cfg; },
  };
  UI.NesScreen = NesScreen;
})(typeof window !== 'undefined' ? window : globalThis);
