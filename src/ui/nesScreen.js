/*
 * NES 画面 (MML.UI.NesScreen) — 自前 NES エミュレータ(src/emulator/nes/)の表示・操作・録音
 * (DESIGN-CAPTURE.md §6/§7。段階 6a=映像と入力、6b=AudioWorklet の実時間ループ・音・録音)
 *
 * ■ 実行の置き場
 *   AudioWorklet が使えるとき: エミュレータ本体は AudioWorklet(src/audio/nes-worklet-impl.js を
 *   tools/build-capture-workers.ps1 が nes-worklet.js に束ねた物)の中で動く。音の時刻でフレームが刻まれ、
 *   画面(256×240 の ArrayBuffer)が 1 枚ずつ届くので主スレッドは描くだけ。バンドルは data: URL で addModule する
 *   (file:// 直開きでも動く。Blob URL は file:// で addModule できない)。
 *   使えないとき(古いブラウザ、バンドル未ビルド、AudioContext 不可): 主スレッドの rAF で回す(音なし)。
 * ■ 録音(●)
 *   本体(NesConsole.startRecording)が音源レジスタの書き込みを積み、フレームごとに届く。止めると
 *   MML.VGM.encodeNesRecording で VGM(2A03 は標準、拡張音源 VRC6/VRC7/MMC5/N163/5B は NESX ブロック、DPCM は本体つき)にし、
 *   [VGM を保存](ダウンロード)と [変換へ](本体の VGM 経路で開いて鍵盤表示/MML 変換へ)を出す。
 * ■ 入力
 *   十字=矢印、A=X、B=Z、Start=Enter、Select=Shift。canvas にフォーカスがあるときだけ(エディタの矢印を奪わない)。
 *   ゲームパッドは標準配置(0=A、1/2=B、8=Select、9=Start、12-15=十字、左スティック)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const FRAME_MS = 1000 / 60.0988;
  const NSF_GAIN = 1.56; // stream-player.js と同じ実測 RMS 校正値
  const KEYS = { ArrowUp: 16, ArrowDown: 32, ArrowLeft: 64, ArrowRight: 128, KeyX: 1, KeyZ: 2, Enter: 8, ShiftLeft: 4, ShiftRight: 4 };

  let win = null, canvas = null, ctx2d = null, statusEl = null, nameEl = null, pauseBtn = null, recBtn = null, saveBtn = null, convBtn = null, recInfoEl = null;
  let romName = '', romBytes = null;
  let image = null, imageBuf = null;
  let keyBits = 0, lastPad = -1;
  let fpsCount = 0, fpsMs = 0, fps = 0, frameSeq = 0, underruns = 0; // frameSeq/underruns: Worklet からの通算フレーム数と音切れ回数
  let paused = false;
  // 主スレッド実行(音なし)
  let nes = null, raf = 0, lastMs = 0, acc = 0;
  // AudioWorklet 実行
  let actx = null, node = null, gain = null, limiter = null, workletState = null; // null | 'loading' | 'ok' | 'failed'
  let gpRaf = 0;
  // 録音
  let recording = false, recFrames = null, recStartMs = 0, recVgm = null, recExtBits = 0;
  // FDS(段階 6d): BIOS は利用者が用意する(disksys.rom、8K)。localStorage に base64 で控える
  const BIOS_KEY = 'nes.fdsBios';
  let fdsBios = null, biosBtn = null, biosInput = null, sideBtn = null, fdsSides = 0, fdsSide = 0, pendingFds = null, sideTimer = 0;

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
    sideBtn.textContent = sideLabel() + ' ▸';
    sideBtn.title = T('クリックで次の面に入れ替える(取り出してから入れる)');
  }
  // 面の入れ替え: 取り出し → 少し待って次の面を入れる(ゲームの BIOS が「ディスクなし」を見てから入れ直す)
  function switchSide(next) {
    fdsSide = ((next % fdsSides) + fdsSides) % fdsSides;
    const send = (side) => { if (node) node.port.postMessage({ type: 'disk', side }); else if (nes) { if (side < 0) nes.ejectDisk(); else nes.insertDisk(side); } };
    send(-1);
    if (sideTimer) clearTimeout(sideTimer);
    sideTimer = setTimeout(() => { sideTimer = 0; send(fdsSide); updateDiskUi(); }, 1500);
    sideBtn.textContent = T('入れ替え中…');
  }

  function ensureDom() {
    if (win) return true;
    win = document.getElementById('win-nes');
    if (!win) return false;
    const body = win.querySelector('.float-window-body');
    body.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'nes-screen';
    canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 240; canvas.className = 'nes-canvas'; canvas.tabIndex = 0;
    canvas.title = T('クリックしてキー入力(十字=矢印、A=X、B=Z、Start=Enter、Select=Shift)');
    ctx2d = canvas.getContext('2d');
    imageBuf = new Uint8ClampedArray(256 * 240 * 4);
    image = new ImageData(imageBuf, 256, 240);
    const bar = document.createElement('div'); bar.className = 'nes-bar';
    nameEl = document.createElement('span'); nameEl.className = 'nes-name';
    pauseBtn = document.createElement('button'); pauseBtn.type = 'button'; pauseBtn.className = 'nes-btn'; pauseBtn.textContent = T('一時停止');
    pauseBtn.addEventListener('click', () => { setPaused(!paused); canvas.focus(); });
    const resetBtn = document.createElement('button'); resetBtn.type = 'button'; resetBtn.className = 'nes-btn'; resetBtn.textContent = T('リセット');
    resetBtn.addEventListener('click', () => { if (node) node.port.postMessage({ type: 'reset' }); else if (nes) nes.reset(); canvas.focus(); });
    recBtn = document.createElement('button'); recBtn.type = 'button'; recBtn.className = 'nes-btn nes-rec';
    recBtn.addEventListener('click', () => { toggleRecord(); canvas.focus(); });
    statusEl = document.createElement('span'); statusEl.className = 'nes-status';
    sideBtn = document.createElement('button'); sideBtn.type = 'button'; sideBtn.className = 'nes-btn'; sideBtn.hidden = true;
    sideBtn.addEventListener('click', () => { if (fdsSides > 1 && !sideTimer) switchSide(fdsSide + 1); canvas.focus(); });
    biosBtn = document.createElement('button'); biosBtn.type = 'button'; biosBtn.className = 'nes-btn'; biosBtn.textContent = T('FDS BIOS…'); biosBtn.hidden = true;
    biosBtn.title = T('ディスクシステムの BIOS(disksys.rom、8KB)を選ぶ。このブラウザに控えて次回も使います');
    biosInput = document.createElement('input'); biosInput.type = 'file'; biosInput.accept = '.rom,.bin,.nes'; biosInput.style.display = 'none';
    biosBtn.addEventListener('click', () => biosInput.click());
    biosInput.addEventListener('change', async () => {
      const f = biosInput.files && biosInput.files[0]; biosInput.value = '';
      if (!f) return;
      const b = new Uint8Array(await f.arrayBuffer());
      if (b.length < 0x2000) { alert(T('BIOS は 8KB 以上のファイルです: {name}', { name: f.name })); return; }
      storeBios(b.length === 0x2000 ? b : b.subarray(b.length - 0x2000));
      if (pendingFds) { const p = pendingFds; pendingFds = null; NesScreen.open(p.bytes, p.name).catch((e) => { statusEl.textContent = T('エラー: {msg}', { msg: e && e.message ? e.message : String(e) }); }); }
    });
    bar.appendChild(nameEl); bar.appendChild(pauseBtn); bar.appendChild(resetBtn); bar.appendChild(recBtn); bar.appendChild(sideBtn); bar.appendChild(biosBtn); bar.appendChild(biosInput); bar.appendChild(statusEl);
    const bar2 = document.createElement('div'); bar2.className = 'nes-bar';
    recInfoEl = document.createElement('span'); recInfoEl.className = 'nes-name';
    saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'nes-btn'; saveBtn.textContent = T('VGM を保存'); saveBtn.hidden = true;
    saveBtn.addEventListener('click', saveRecording);
    convBtn = document.createElement('button'); convBtn.type = 'button'; convBtn.className = 'nes-btn'; convBtn.textContent = T('変換へ'); convBtn.hidden = true;
    convBtn.addEventListener('click', () => { if (recVgm && NesScreen.onOpenRecording) { setPaused(true); NesScreen.onOpenRecording(recVgm, recFileName()); } });
    bar2.appendChild(recInfoEl); bar2.appendChild(saveBtn); bar2.appendChild(convBtn);
    wrap.appendChild(canvas); wrap.appendChild(bar); wrap.appendChild(bar2);
    const help = document.createElement('div'); help.className = 'nes-help';
    help.textContent = T('十字=矢印キー、A=X、B=Z、Start=Enter、Select=Shift(画面をクリックしてから)。ゲームパッドも使えます。● で音源レジスタの書き込みを録音し、VGM として保存/変換できます');
    wrap.appendChild(help);
    body.appendChild(wrap);
    canvas.addEventListener('keydown', (e) => { const b = KEYS[e.code]; if (b) { keyBits |= b; e.preventDefault(); pushPad(); } });
    canvas.addEventListener('keyup', (e) => { const b = KEYS[e.code]; if (b) { keyBits &= ~b; e.preventDefault(); pushPad(); } });
    canvas.addEventListener('blur', () => { keyBits = 0; pushPad(); });
    canvas.addEventListener('pointerdown', () => { canvas.focus(); resumeAudio(); });
    // 閉じたら止める、開いたら続ける(表示の切替は FloatingWindows が style.display で行う)
    new MutationObserver(() => { if (win.style.display === 'none') suspend(); else resume(); }).observe(win, { attributes: true, attributeFilter: ['style'] });
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else if (win.style.display !== 'none') resume(); });
    updateRecUi();
    return true;
  }

  // ── 入力 ──
  function gamepadBits() {
    let bits = 0;
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const b = gp.buttons, on = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
      if (on(0)) bits |= 1; if (on(1) || on(2)) bits |= 2; if (on(8)) bits |= 4; if (on(9)) bits |= 8;
      if (on(12)) bits |= 16; if (on(13)) bits |= 32; if (on(14)) bits |= 64; if (on(15)) bits |= 128;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (ax < -0.5) bits |= 64; if (ax > 0.5) bits |= 128; if (ay < -0.5) bits |= 16; if (ay > 0.5) bits |= 32;
      break;
    }
    return bits;
  }
  function pushPad() {
    const bits = keyBits | gamepadBits();
    if (bits === lastPad) return;
    lastPad = bits;
    if (node) node.port.postMessage({ type: 'pad', port: 0, bits });
    else if (nes) nes.setController(0, bits);
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
    if (!statusEl) return;
    const mode = node ? T('音: AudioWorklet') : T('音なし(主スレッド)');
    statusEl.textContent = `${fps} fps · ${mode}` + (underruns ? ' · ' + T('音切れ {n} 回', { n: underruns }) : '') + (hasBattery ? ' · ' + T('セーブ') : '');
    if (pendingFds) return; // BIOS 待ちの案内を消さない
    const chips = ['VRC6', 'VRC7', 'FDS', 'MMC5', 'N163', 'SUNSOFT 5B'].filter((_, i) => recExtBits & (1 << i)).join('+');
    statusEl.title = (chips ? chips + ' ' : '') + (workletState === 'failed' ? T('AudioWorklet が使えないので主スレッドで実行しています(音は出ません)') : '') +
      (hasBattery ? ' ' + T('セーブデータはこのブラウザ(IndexedDB)に自動保存します(1 秒ごと・閉じる時)。キー: {key}', { key: batteryKey }) : '');
  }

  // ── AudioWorklet 実行 ──
  function bundleDataUrl() {
    const fn = MML.WorkerBundles && MML.WorkerBundles.nesWorklet;
    if (typeof fn !== 'function') return null;
    const src = fn.toString();
    // 再ビルド忘れの検出(capture-worker-client.js と同じ考え方): 主スレッドの現行ソースがバンドルに含まれているか
    const probes = [MML.Emu.NesConsole, MML.Emu.PPU, MML.Emu.NesMappers && MML.Emu.NesMappers.MMC3, MML.Emu.NesMappers && MML.Emu.NesMappers.MMC5, MML.Emu.NesMappers && MML.Emu.NesMappers.VRC7, MML.Emu.FdsDisk && MML.Emu.FdsDisk.Mapper];
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
      lastPad = -1; pushPad();
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
        if (m.writes && recFrames) for (const fr of m.writes) recFrames.push(fr);
        tickFps(performance.now());
        break;
      }
      case 'loaded': nameEl.title = m.info; recExtBits = m.extBits || 0; fdsSides = m.disks || 0; fdsSide = 0; hasBattery = !!m.battery; updateDiskUi(); updateStatus(); break;
      case 'battery': onBatteryMessage(m); break;
      case 'recordEnd': for (const fr of (m.frames || [])) recFrames.push(fr); finishRecording(); break;
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
    while (acc >= FRAME_MS && n < 3) { nes.runFrame(); acc -= FRAME_MS; n++; }
    if (n) {
      blitFrame(nes.frame);
      if (recFrames && nes.rec) for (const fr of nes.rec.frames.splice(0)) recFrames.push(fr);
      if (hasBattery && nes.batteryDirty && (++mainFrames % 60) === 0) { saveBattery(batteryKey, nes.getBattery()); nes.clearBatteryDirty(); }
    }
    tickFps(now);
    raf = requestAnimationFrame(tick);
  }
  let mainFrames = 0;
  function startMain() { if (!raf) { lastMs = 0; raf = requestAnimationFrame(tick); } }
  function stopMain() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function setPaused(on) {
    paused = on;
    pauseBtn.textContent = paused ? T('再開') : T('一時停止');
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

  // ── 録音 ──
  function recFileName() { return (romName || 'nes').replace(/\.(nes|fds)$/i, '') + '-rec.vgm'; }
  function toggleRecord() {
    if (recording) {
      recording = false;
      if (node) node.port.postMessage({ type: 'record', on: false });
      else if (nes) { for (const fr of nes.stopRecording()) recFrames.push(fr); finishRecording(); }
    } else {
      recording = true; recFrames = []; recVgm = null; recStartMs = performance.now();
      if (node) node.port.postMessage({ type: 'record', on: true });
      else if (nes) nes.startRecording();
    }
    updateRecUi();
  }
  function finishRecording() {
    const frames = recFrames || [];
    recFrames = null;
    const r = MML.VGM.encodeNesRecording({ frames, extBits: recExtBits, name: (romName || 'NES').replace(/\.nes$/i, ''), creator: 'Sound Emulation Foundry (NES)' });
    recVgm = r.vgm;
    recInfoEl.textContent = T('録音: {sec} 秒({frames} フレーム、{kb} KB)', { sec: (frames.length / 60.0988).toFixed(1), frames: frames.length, kb: (r.vgm.length / 1024).toFixed(1) });
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
    recBtn.textContent = recording ? T('■ 録音を止める') : T('● 録音');
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
        statusEl.textContent = T('FDS の BIOS(disksys.rom)を [FDS BIOS…] で指定してください');
        return null;
      }
      pendingFds = null;
      // ヘッダとマッパーの検査は主スレッドで先に(未対応なら例外で知らせる)
      const probe = new MML.Emu.NesConsole(bytes, { bios: isFds ? fdsBios : null });
      await flushBattery(); // 前の ROM のセーブを受け取ってから止める
      romBytes = bytes; romName = name || '';
      hasBattery = probe.hasBattery; batteryKey = hasBattery ? romKey(bytes) : '';
      const battery = hasBattery ? await loadBattery(batteryKey) : null;
      if (battery && probe.setBattery(battery)) console.log('[nes]', T('セーブデータを読み込みました({n} バイト)', { n: battery.length }));
      nameEl.textContent = romName;
      nameEl.title = MML.Emu.INES.describe(probe.rom);
      recExtBits = probe.extBits();
      fdsSides = probe.diskCount; fdsSide = 0; if (sideTimer) { clearTimeout(sideTimer); sideTimer = 0; } updateDiskUi();
      stopMain(); nes = null;
      if (recording) { recording = false; recFrames = null; }
      recVgm = null; updateRecUi();
      paused = false; pauseBtn.textContent = T('一時停止'); acc = 0; fpsCount = 0; fpsMs = 0;
      win.style.display = 'flex';
      if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
      const btn = document.querySelector('.toggle-btn[data-target="win-nes"]');
      if (btn) btn.classList.add('active');
      blitFrame(probe.frame);
      const ok = await startWorklet(bytes, battery);
      if (!ok) { nes = probe; lastPad = -1; mainFrames = 0; startMain(); }
      updateStatus();
      canvas.focus();
      return ok ? null : nes;
    },
    async close() {
      if (nes && hasBattery && nes.batteryDirty) { saveBattery(batteryKey, nes.getBattery()); nes.clearBatteryDirty(); }
      await flushBattery();
      stopMain(); stopWorkletNode(); nes = null;
    },
    get console() { return nes; },
    get running() { return !!(node || (nes && raf)); },
    get usingWorklet() { return !!node; },
    get stats() { return { frameSeq, underruns, fps }; },
    get audioNodes() { return { ctx: actx, node, gain, limiter }; }, // 検証用(音が出ているかを外から測る)
  };
  UI.NesScreen = NesScreen;
})(typeof window !== 'undefined' ? window : globalThis);
