/*
 * NES 画面 (MML.UI.NesScreen) — 自前 NES エミュレータ(src/emulator/nes/)の表示と操作(DESIGN-CAPTURE.md §7、段階 6a)
 *
 * ウィンドウ #win-nes の canvas(256×240)へ毎フレーム描き、キー/ゲームパッドをコントローラ 1 に入れる。
 * エミュレータ本体は rAF で回す(実時間の経過ぶんだけ runFrame()。遅れても 1 回の rAF で最大 3 フレームまで)。
 * 音はまだ出さない(段階 6b: AudioWorklet 側でエミュを回して音の時刻でフレームを刻む)。
 *
 * キー: 十字=矢印、A=X、B=Z、Start=Enter、Select=Shift。キー入力は canvas にフォーカスがあるときだけ
 * (MML エディタの矢印キーを奪わない)。ゲームパッドは標準配置(0=A、1/2=B、8=Select、9=Start、12-15=十字、左スティック)。
 * ウィンドウを閉じる/タブが隠れると止まり、開くと続きから動く。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const FRAME_MS = 1000 / 60.0988;
  const KEYS = { ArrowUp: 16, ArrowDown: 32, ArrowLeft: 64, ArrowRight: 128, KeyX: 1, KeyZ: 2, Enter: 8, ShiftLeft: 4, ShiftRight: 4 };

  let win = null, canvas = null, ctx = null, statusEl = null, nameEl = null, pauseBtn = null;
  let nes = null, image = null, romName = '';
  let raf = 0, lastMs = 0, acc = 0, paused = false, keyBits = 0;
  let fpsCount = 0, fpsMs = 0, fps = 0;

  function ensureDom() {
    if (win) return true;
    win = document.getElementById('win-nes');
    if (!win) return false;
    const body = win.querySelector('.float-window-body');
    body.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'nes-screen';
    canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 240; canvas.className = 'nes-canvas'; canvas.tabIndex = 0;
    canvas.title = T('クリックしてキー入力(十字=矢印、A=X、B=Z、Start=Enter、Select=Shift)');
    ctx = canvas.getContext('2d');
    const bar = document.createElement('div'); bar.className = 'nes-bar';
    nameEl = document.createElement('span'); nameEl.className = 'nes-name';
    pauseBtn = document.createElement('button'); pauseBtn.type = 'button'; pauseBtn.className = 'nes-btn'; pauseBtn.textContent = T('一時停止');
    pauseBtn.addEventListener('click', () => { paused = !paused; pauseBtn.textContent = paused ? T('再開') : T('一時停止'); if (!paused) start(); canvas.focus(); });
    const resetBtn = document.createElement('button'); resetBtn.type = 'button'; resetBtn.className = 'nes-btn'; resetBtn.textContent = T('リセット');
    resetBtn.addEventListener('click', () => { if (nes) nes.reset(); canvas.focus(); });
    statusEl = document.createElement('span'); statusEl.className = 'nes-status';
    bar.appendChild(nameEl); bar.appendChild(pauseBtn); bar.appendChild(resetBtn); bar.appendChild(statusEl);
    wrap.appendChild(canvas); wrap.appendChild(bar);
    const help = document.createElement('div'); help.className = 'nes-help';
    help.textContent = T('十字=矢印キー、A=X、B=Z、Start=Enter、Select=Shift(画面をクリックしてから)。ゲームパッドも使えます。音は未対応(段階 6b)');
    wrap.appendChild(help);
    body.appendChild(wrap);
    canvas.addEventListener('keydown', (e) => { const b = KEYS[e.code]; if (b) { keyBits |= b; e.preventDefault(); } });
    canvas.addEventListener('keyup', (e) => { const b = KEYS[e.code]; if (b) { keyBits &= ~b; e.preventDefault(); } });
    canvas.addEventListener('blur', () => { keyBits = 0; });
    // 閉じたら止める、開いたら続ける(表示の切替は FloatingWindows が style.display で行う)
    new MutationObserver(() => { if (win.style.display === 'none') stop(); else if (nes && !paused) start(); }).observe(win, { attributes: true, attributeFilter: ['style'] });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (nes && !paused && win.style.display !== 'none') start(); });
    return true;
  }

  function padBits() {
    let bits = keyBits;
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

  function blit() {
    ctx.putImageData(image, 0, 0);
  }

  function tick(now) {
    raf = 0;
    if (!nes || paused) return;
    if (!lastMs) lastMs = now;
    acc += Math.min(100, now - lastMs);
    lastMs = now;
    let n = 0;
    nes.setController(0, padBits());
    while (acc >= FRAME_MS && n < 3) { nes.runFrame(); acc -= FRAME_MS; n++; fpsCount++; }
    if (n) blit();
    if (now - fpsMs >= 1000) { fps = fpsCount; fpsCount = 0; fpsMs = now; statusEl.textContent = `${fps} fps`; }
    raf = requestAnimationFrame(tick);
  }
  function start() { if (!raf) { lastMs = 0; raf = requestAnimationFrame(tick); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  const NesScreen = {
    // ROM(iNES のバイト列)を読み込んで表示・開始する。失敗は例外(マッパー未対応など)
    open(bytes, name) {
      if (!ensureDom()) throw new Error('win-nes がありません');
      stop();
      nes = new MML.Emu.NesConsole(bytes);
      image = new ImageData(new Uint8ClampedArray(nes.frame.buffer), 256, 240);
      romName = name || '';
      nameEl.textContent = romName;
      nameEl.title = MML.Emu.INES.describe(nes.rom);
      paused = false; pauseBtn.textContent = T('一時停止'); acc = 0; fpsCount = 0; fpsMs = 0;
      win.style.display = 'flex';
      if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
      const btn = document.querySelector('.toggle-btn[data-target="win-nes"]');
      if (btn) btn.classList.add('active');
      blit();
      start();
      canvas.focus();
      return nes;
    },
    close() { stop(); nes = null; },
    get console() { return nes; },
    get running() { return !!(nes && raf); },
  };
  UI.NesScreen = NesScreen;
})(typeof window !== 'undefined' ? window : globalThis);
