/*
 * ゲーム画面 (MML.UI.NesScreen) — 自前 NES エミュレータ(src/emulator/nes/)と自前 MSX エミュレータ(src/emulator/msx/)の表示・操作・録音
 * (DESIGN-CAPTURE.md §6/§7。段階 6a=映像と入力、6b=AudioWorklet の実時間ループ・音・録音。MSX は DESIGN-MSX-CAPTURE.md §6 段階 7a)
 *
 * ■ 機種(窓は NES と MSX で共用。名前は NES 時代のまま)
 *   open(bytes, name) がファイルで判別する: .nes/.fds → NES、.rom/.mx1/.mx2(iNES でない物)→ MSX(MsxConsole.isMsxFile)。
 *   本体の API は同形(runSamples/frame/setController/startRecording/State/Rewind)なので、Worklet(load の machine)も主スレッド実行も
 *   同じ経路で回し、違う所だけ machine で分ける: 入力(MSX はキーボードが主入力。設定の操作キー以外は key メッセージで本体へ)、
 *   BIOS(MSX は機種別に localStorage msx.bios.<machine>.main/sub/logo。無ければ同梱 C-BIOS、それも無ければ [BIOS] を案内)、
 *   逆再生の 8bit 画面の色(NES は PPU.PALETTE、MSX は rwframe の palette)、画面の大きさ(frame の w/h)、録音の符号化
 *   (MSX の VGM 化は 7b。encodeMsxRecording が無ければ案内だけ)、ライブ表示(MSX は 7b まで始めない)。
 *   設定(nes.cfg)は MSX の節 cfg.msx を持つ: 操作キー(F9/F10/F11/F12/Pause。F1〜F5 は MSX のキー)、機種、カーソル+スペースのジョイスティック兼用。
 *   マッパーの手動指定は ROM 内容のハッシュ別に localStorage msx.mapper。
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
 *   録音の補正(効果音除去/処理落ち補正、src/vgm/vgmClean.js)はその横のチェックで、生の録音から掛け直す(保存にも変換にも効く)。
 *   初期値は設定の「録音の補正」。補正済み VGM は GD3 の notes に印("cleaned: sfx lag")を持ち、変換側は同じ補正を重ねない。
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
  const REWIND_SPEEDS = [1, 2, 4]; // 巻き戻し(逆再生)の速さ(1 秒に何秒ぶん戻るか)
  const REWIND_ROLL_EVERY = 6;     // 逆再生中、ロールを何フレームごとに切り詰めるか(毎フレームは重い)

  // ── 設定(localStorage nes.cfg)──
  const CFG_KEY = 'nes.cfg';
  const PAD_BITS = { A: 1, B: 2, Select: 4, Start: 8, Up: 16, Down: 32, Left: 64, Right: 128 };
  const KEY_ACTIONS = ['A', 'B', 'TurboA', 'TurboB', 'Select', 'Start', 'Up', 'Down', 'Left', 'Right', 'FF', 'Rewind', 'Pause', 'SaveState', 'LoadState'];
  const PAD_ACTIONS = ['A', 'B', 'TurboA', 'TurboB', 'Select', 'Start', 'FF', 'Rewind', 'Pause', 'SaveState', 'LoadState'];
  // MSX: キーボードがゲームの主入力なので、キー割り当ては操作キーだけ(他のキーはそのまま MSX のキーボードへ)。既定は F1〜F5(MSX のファンクションキー)を避ける
  const MSX_KEY_ACTIONS = ['FF', 'Rewind', 'Pause', 'SaveState', 'LoadState'];
  const MSX_MACHINES = ['auto', 'msx1', 'msx2', 'msx2plus', 'turbor'];
  const MSX_MAPPERS = ['auto', 'plain', 'konami', 'konamiScc', 'konamiSccI', 'konamiDac', 'ascii8', 'ascii16', 'ascii8Sram', 'ascii16Sram', 'gameMaster2', 'koei'];
  const MSX_CART_B = ['none', 'fmpac', 'msxaudio', 'scci']; // カートリッジ 2(ゲームと一緒に挿す音源。7b)
  const MSX_FDC = ['wd2793', 'tc8566af']; // ディスクの FDC(ディスク ROM が叩く方。7d)
  const MSX_JOY_KEYS = { ArrowUp: 16, ArrowDown: 32, ArrowLeft: 64, ArrowRight: 128, Space: 1 }; // 「カーソルキーとスペースをジョイスティック 1 にも使う」
  const TURBO_RATES = [1, 2, 3, 4]; // 押す/離すの長さ(フレーム)。1=30 回/秒、2=15、3=10、4=7.5
  const SPEEDS = [1, 2, 4, 8];
  const DEFAULT_CFG = {
    keys: { A: 'KeyX', B: 'KeyZ', TurboA: 'KeyS', TurboB: 'KeyA', Select: 'ShiftLeft', Start: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
      FF: 'KeyF', Rewind: 'KeyR', Pause: 'KeyP', SaveState: 'F5', LoadState: 'F7' },
    pad: { A: 0, B: 1, TurboA: 3, TurboB: 2, Select: 8, Start: 9, FF: 5, Rewind: 4, Pause: -1, SaveState: -1, LoadState: -1 },
    turboRate: 2,
    rewindSpeed: 2,
    liveRoll: true,
    sfxRemove: false, // 録音の補正の初期値(録音ごとに保存/変換への横のチェックで変えられる)
    lagFix: false,
    msx: { keys: { FF: 'F11', Rewind: 'F12', Pause: 'Pause', SaveState: 'F9', LoadState: 'F10' }, machine: 'auto', joyFromKeys: false, cartB: 'none', fdc: 'wd2793', softKbd: false, writeBack: false },
  };
  function loadMsxCfg(c) {
    c = c && typeof c === 'object' ? c : {};
    return {
      keys: Object.assign({}, DEFAULT_CFG.msx.keys, c.keys && typeof c.keys === 'object' ? c.keys : null),
      machine: MSX_MACHINES.includes(c.machine) ? c.machine : DEFAULT_CFG.msx.machine,
      joyFromKeys: typeof c.joyFromKeys === 'boolean' ? c.joyFromKeys : DEFAULT_CFG.msx.joyFromKeys,
      cartB: MSX_CART_B.includes(c.cartB) ? c.cartB : DEFAULT_CFG.msx.cartB,
      fdc: MSX_FDC.includes(c.fdc) ? c.fdc : DEFAULT_CFG.msx.fdc,
      softKbd: typeof c.softKbd === 'boolean' ? c.softKbd : false, // ソフトキーボード(⌨)を出しておく(タッチ端末は設定に関係なく出る)
      writeBack: typeof c.writeBack === 'boolean' ? c.writeBack : false, // ディスクの書き込みを元の .dsk へ書き戻す(既定 OFF。フォルダを選び .bak を 1 回作る)
    };
  }
  function loadCfg() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { /* localStorage 不可 */ }
    c = c && typeof c === 'object' ? c : {};
    return {
      keys: Object.assign({}, DEFAULT_CFG.keys, c.keys && typeof c.keys === 'object' ? c.keys : null),
      pad: Object.assign({}, DEFAULT_CFG.pad, c.pad && typeof c.pad === 'object' ? c.pad : null),
      turboRate: TURBO_RATES.includes(c.turboRate) ? c.turboRate : DEFAULT_CFG.turboRate,
      rewindSpeed: REWIND_SPEEDS.includes(c.rewindSpeed) ? c.rewindSpeed : DEFAULT_CFG.rewindSpeed,
      liveRoll: typeof c.liveRoll === 'boolean' ? c.liveRoll : DEFAULT_CFG.liveRoll,
      sfxRemove: typeof c.sfxRemove === 'boolean' ? c.sfxRemove : DEFAULT_CFG.sfxRemove,
      lagFix: typeof c.lagFix === 'boolean' ? c.lagFix : DEFAULT_CFG.lagFix,
      msx: loadMsxCfg(c.msx),
    };
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }
  let cfg = loadCfg();
  // 今の機種のキー割り当て表と操作の一覧(NES: 十字/A/B…+操作キー、MSX: 操作キーだけ)
  function curKeys() { return machine === 'msx' ? cfg.msx.keys : cfg.keys; }
  function curKeyActions() { return machine === 'msx' ? MSX_KEY_ACTIONS : KEY_ACTIONS; }
  function keyActionOf(code) { const keys = curKeys(); for (const a of curKeyActions()) if (keys[a] === code) return a; return null; }
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
  let image = null, imageBuf = null, frameW = 256, frameH = 240; // 画面の大きさ(frame メッセージの w/h。今は NES/MSX とも 256×240)
  let machine = 'nes';        // 'nes' | 'msx'(open がファイルで決める)
  let msxChips = [], msxMachine = '', pendingMsx = null, msxFps = 60, msxDisk = false; // msxDisk: 今の MSX はディスクで起動している(次の .dsk は入れ替え) // MSX: 載っている音源名(psg/scc/opll/opl/dac)、起動した機種、BIOS 待ちの ROM、本体のフレームレート(50Hz 中は 50)
  let keyBits = 0, keyTurbo = 0, touchBits = 0, touchTurbo = 0, lastPad = -1;
  let kbdBtn = null, softKbdEl = null, touchPadEl = null; // MSX のソフトキーボード(7f)とタッチ操作キー
  let machineEl = null, ilBadgeEl = null; // 左上の機種表示、右上の「インターレース」の印
  let fpsCount = 0, fpsMs = 0, fps = 0, frameSeq = 0, underruns = 0; // frameSeq: 本体の frameCount(最後に届いたフレーム)、underruns: 音切れ回数
  let paused = false;
  // 主スレッド実行(音なし)
  let nes = null, raf = 0, lastMs = 0, acc = 0, rewindBuf = null;
  // AudioWorklet 実行
  let actx = null, node = null, gain = null, limiter = null, workletState = null; // null | 'loading' | 'ok' | 'failed'
  let gpRaf = 0;
  // 録音
  let recording = false, recFrames = null, recStartMs = 0, recVgm = null, recExtBits = 0, recBase = null;
  let recRaw = null, recSfxChk = null, recLagChk = null; // 生の録音(補正はここから掛け直す)と、保存/変換への横のチェック
  // FDS(段階 6d): BIOS は利用者が用意する(disksys.rom、8K)。localStorage に base64 で控える
  const BIOS_KEY = 'nes.fdsBios';
  let fdsBios = null, biosBtn = null, biosInput = null, sideBtn = null, fdsSides = 0, fdsSide = 0, pendingFds = null, sideTimer = 0;
  let diskNames = [], fdsSideInfo = null, diskPopEl = null, diskPopClose = null; // [disk] のポップオーバー用: 入っている画像の名前(MSX)、FDS の面ごとの枚数/面(ヘッダ)
  // MSX のディスク書き込み(2026-11-09 決定: ブラウザ内保存は従来どおり + 書き出し(複製) + 書き戻しモードは既定 OFF で .bak を作る)
  let diskImages = [];          // 入っている画像の今の中身(書き込み反映後。バッテリーの tag 5 で更新)
  let diskDirty = new Set();    // 書き込みがあって、まだ書き戻していない番号
  let diskDirHandle = null;     // 書き戻し先のフォルダ(showDirectoryPicker。このセッションだけ)
  let diskWbBusy = false, diskBadgeEl = null;
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
  function handleBatteryBlob(data) {
    saveBattery(batteryKey, data);
    if (machine === 'msx' && MML.Emu.MsxConsole && MML.Emu.MsxConsole.batteryDisks) {
      for (const d of MML.Emu.MsxConsole.batteryDisks(data)) {
        const cur = diskImages[d.index];
        if (cur && cur.length === d.image.length && cur.every((v, i) => v === d.image[i])) continue; // 変わっていない(前回の書き込みぶんを毎回送ってくる)
        diskImages[d.index] = d.image.slice(); diskDirty.add(d.index);
      }
      updateDiskBadge();
      if (cfg.msx.writeBack && diskDirty.size) writeBackDirty();
    }
  }
  function onBatteryMessage(m) {
    if (m.data) handleBatteryBlob(new Uint8Array(m.data));
    if (m.final && batteryWait) batteryWait();
  }
  // 「書き込みあり」のバッジ(見出し下の行)。クリックで [disk] のポップオーバー(書き出し/書き戻し)
  function updateDiskBadge() {
    if (!diskBadgeEl) return;
    const n = machine === 'msx' ? diskDirty.size : 0;
    diskBadgeEl.hidden = n === 0;
    if (!n) return;
    const needDir = cfg.msx.writeBack && !diskDirHandle;
    diskBadgeEl.textContent = cfg.msx.writeBack ? (needDir ? T('ディスク書き込みあり: 書き戻し先のフォルダを選ぶ') : T('ディスク書き込みあり: 書き戻し中…')) : T('ディスク書き込みあり({n} 枚、このブラウザに保存)', { n });
    diskBadgeEl.title = T('書き込みのあったディスク画像はこのブラウザに保存されます(次に同じ .dsk を開くと戻る)。[disk] から .dsk として書き出せます。⚙ の「元の .dsk へ書き戻す」を ON にするとフォルダ内の元ファイルへ書きます(.bak を 1 回作る)');
  }
  // 画像の今の中身を取り出す(Worklet 内の最後の書き込みを受け取ってから)
  async function currentDiskImage(i) {
    if (node && hasBattery) await flushBattery();
    return diskImages[i] || null;
  }
  function downloadBytes(name, bytes) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // 書き出し(複製): 保存ダイアログ(FSA)、無ければダウンロード。元ファイルは触らない
  async function exportDisk(i) {
    const img = await currentDiskImage(i);
    if (!img) return;
    const name = diskNames[i] || ('disk' + (i + 1) + '.dsk');
    if (window.showSaveFilePicker) {
      let h = null;
      try { h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'MSX disk image', accept: { 'application/octet-stream': ['.dsk'] } }] }); }
      catch (e) { if (e && e.name === 'AbortError') return; h = null; }
      if (h) { try { const w = await h.createWritable(); await w.write(img); await w.close(); flashStatus(T('ディスクを書き出しました: {name}', { name: h.name })); return; } catch (e) { /* 下のダウンロードへ */ } }
    }
    downloadBytes(name, img);
    flashStatus(T('ディスクを書き出しました: {name}', { name }));
  }
  // 書き戻し先のフォルダ(★クリックの中から呼ぶ: showDirectoryPicker はユーザー操作が要る)
  async function pickDiskDir() {
    if (typeof window.showDirectoryPicker !== 'function') { flashStatus(T('このブラウザはフォルダへの書き込みに対応していません(書き出しを使ってください)')); return null; }
    try { diskDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return null; }
    updateDiskBadge();
    if (diskDirty.size) writeBackDirty();
    return diskDirHandle;
  }
  // 書き戻し: 選んだフォルダの同名ファイルへ。初回は元ファイルの複製 <name>.bak を作る(無ければ)。元ファイルが無い(アーカイブ由来など)なら新規に書く
  async function writeBackDirty() {
    if (!diskDirHandle || diskWbBusy || machine !== 'msx') return;
    diskWbBusy = true;
    try {
      for (const i of Array.from(diskDirty)) {
        const name = diskNames[i], img = diskImages[i];
        if (!name || !img) { diskDirty.delete(i); continue; }
        try {
          let orig = null;
          try { const fh = await diskDirHandle.getFileHandle(name); orig = fh; } catch (e) { orig = null; }
          if (orig) {
            let bakExists = true;
            try { await diskDirHandle.getFileHandle(name + '.bak'); } catch (e) { bakExists = false; }
            if (!bakExists) { const src = new Uint8Array(await (await orig.getFile()).arrayBuffer()); const bh = await diskDirHandle.getFileHandle(name + '.bak', { create: true }); const bw = await bh.createWritable(); await bw.write(src); await bw.close(); }
          }
          const fh = await diskDirHandle.getFileHandle(name, { create: true });
          const w = await fh.createWritable(); await w.write(img); await w.close();
          diskDirty.delete(i);
          flashStatus(T('ディスクを書き戻しました: {name}', { name }));
        } catch (e) { flashStatus(T('ディスクを書き戻せませんでした: {msg}', { msg: e && e.message ? e.message : String(e) })); break; }
      }
    } finally { diskWbBusy = false; updateDiskBadge(); }
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
    else if (nes) saveStateRecord(stateApi().save(nes));
  }
  async function requestLoadState() {
    if (!stateKey) return;
    const rec = await idbState((st) => st.get(stateKey));
    if (!rec || !rec.state) { flashStatus(T('この ROM のステートはまだありません')); return; }
    if (node) node.port.postMessage({ type: 'loadState', state: rec.state });
    else if (nes) {
      const ok = stateApi().load(nes, rec.state);
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
  // FDS の BIOS を控えて知らせる(ドロップ/[BIOS] の両方から)。.fds を開いて BIOS 待ちなら、そのまま開き直す
  function storeFdsBiosFile(bytes, name) {
    storeBios(bytes);
    flashStatus(T('ディスクシステムの BIOS を控えました: {name}', { name: name || 'disksys.rom' }));
    if (pendingFds) { const p = pendingFds; pendingFds = null; NesScreen.open(p.bytes, p.name).catch((e) => { statusEl.textContent = T('エラー: {msg}', { msg: e && e.message ? e.message : String(e) }); }); }
  }
  function storeBios(bytes) {
    fdsBios = bytes;
    try { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); localStorage.setItem(BIOS_KEY, btoa(s)); } catch (e) { /* 控えられなくても今回は使える */ }
  }
  // ── MSX の BIOS(機種別に localStorage msx.bios.<machine>.main/sub/logo、base64)とマッパーの手動指定(msx.mapper、ROM ハッシュ別)──
  // 控えが無ければ同梱の C-BIOS(MsxConsole.defaultBios。cbiosData.js があるとき)、それも無ければ [BIOS] を案内する
  const MSX_BIOS_KEY = 'msx.bios.', MSX_MAPPER_KEY = 'msx.mapper';
  const MSX_MACHINE_LABEL = { msx1: 'MSX1', msx2: 'MSX2', msx2plus: 'MSX2+', turbor: 'MSX turbo R' };
  const msxBiosCache = {};
  function b64enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function b64dec(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function loadMsxBios(mach) {
    if (msxBiosCache[mach]) return msxBiosCache[mach]; // 無かった時は控えない(後から入る)
    let out = null;
    try {
      // 控えた物を種類ごとに(メインが無くても漢字/ディスク ROM だけ控えてあることがある: 同梱 C-BIOS に足して使う)
      for (const k of ['main', 'sub', 'logo', 'kanji', 'disk', 'kdr', 'music']) {
        const v = localStorage.getItem(MSX_BIOS_KEY + mach + '.' + k);
        if (!v) continue;
        if (!out) out = { main: null, sub: null, logo: null, kanji: null, disk: null, kdr: null, music: null, name: T('控えた BIOS') };
        out[k] = b64dec(v);
      }
    } catch (e) { /* localStorage 不可 */ }
    if (out) msxBiosCache[mach] = out;
    return out;
  }
  function storeMsxBios(mach, kind, bytes) {
    try { localStorage.setItem(MSX_BIOS_KEY + mach + '.' + kind, b64enc(bytes)); } catch (e) { /* 控えられなくても今回は使える */ }
    const cur = msxBiosCache[mach] || (msxBiosCache[mach] = { main: null, sub: null, logo: null, kanji: null, disk: null, kdr: null, music: null, name: T('控えた BIOS') });
    cur[kind] = bytes;
  }
  // 機種に使える BIOS: 控え(メインあり) → 同梱 C-BIOS(+控えた漢字/ディスク ROM) → null
  function msxBiosFor(mach) {
    const stored = loadMsxBios(mach);
    if (stored && stored.main) return stored;
    const C = MML.Emu.MsxConsole;
    const def = C && C.hasDefaultBios && C.hasDefaultBios(mach) ? C.defaultBios(mach) : null;
    if (def && stored && stored.kanji) def.kanji = stored.kanji; // C-BIOS に足すのは漢字 ROM だけ(ディスク ROM/漢字ドライバは実 BIOS の BASIC/DOS が前提で、C-BIOS だと起動が止まる)
    return def;
  }
  // 設定のカートリッジ 2 を本体の opts.cartB の形に。fmpac の ROM は同梱 C-BIOS の MSX-MUSIC(控えた実 BIOS には無いので明示する)
  function msxCartB() {
    const k = cfg.msx.cartB;
    if (!k || k === 'none') return null;
    if (k === 'fmpac') { const st = loadMsxBios(resolveMsxMachine() || 'msx2'); const rom = (st && st.music) || (MML.Emu.MsxConsole.defaultMusicRom ? MML.Emu.MsxConsole.defaultMusicRom() : null); return rom ? { kind: 'fmpac', rom } : { kind: 'fmpac' }; }
    return { kind: k };
  }
  // 設定の機種。自動 = BIOS のある機種のうち MSX2 を優先、無ければ MSX1(→ MSX2+ → turbo R)。どれも無ければ null(BIOS 待ち)
  function resolveMsxMachine() {
    if (cfg.msx.machine !== 'auto') return cfg.msx.machine;
    for (const m of ['msx2', 'msx1', 'msx2plus', 'turbor']) if (msxBiosFor(m)) return m;
    return null;
  }
  function msxMapperFor(key) { try { const m = JSON.parse(localStorage.getItem(MSX_MAPPER_KEY) || 'null'); const v = m && m[key]; return MSX_MAPPERS.includes(v) && v !== 'auto' ? v : null; } catch (e) { return null; } }
  function setMsxMapper(key, type) {
    try {
      const m = JSON.parse(localStorage.getItem(MSX_MAPPER_KEY) || 'null') || {};
      if (!type || type === 'auto') delete m[key]; else m[key] = type;
      localStorage.setItem(MSX_MAPPER_KEY, JSON.stringify(m));
    } catch (e) { /* ignore */ }
  }
  // [BIOS] で選ばれたファイル(複数可): 32K=メイン、16K=名前に logo を含めばロゴ、それ以外はサブ。控える機種は設定の機種(自動なら今使える機種、
  // 無ければ 16K が一緒に選ばれていれば MSX2、そうでなければ MSX1)
  async function storeMsxBiosFiles(files, targetMach) {
    const list = [];
    for (const f of files) {
      const b = new Uint8Array(await f.arrayBuffer());
      const ab = b[0] === 0x41 && b[1] === 0x42, opll = ab && b[0x1C] === 0x4F && b[0x1D] === 0x50 && b[0x1E] === 0x4C && b[0x1F] === 0x4C; // $401C-$401F = "OPLL"(APRLOPLL=内蔵 MSX-MUSIC / PAC2OPLL=FM-PAC)
      if (opll && (b.length === 0x4000 || b.length === 0x10000)) list.push({ kind: 'music', bytes: b });
      else if (b.length === 0x8000) list.push({ kind: ab ? 'kdr' : 'main', bytes: b }); // 32K で 'AB' ヘッダ=漢字ドライバ(2+/turboR の内蔵 ROM。メイン BIOS は DI/JP で始まる)
      else if (b.length === 0x4000) list.push({ kind: ab ? 'disk' : /logo/i.test(f.name) ? 'logo' : 'sub', bytes: b }); // 16K で 'AB' ヘッダ=ディスク ROM(サブ/ロゴ ROM に AB は無い)
      else if (b.length === 0x20000 || b.length === 0x40000) list.push({ kind: 'kanji', bytes: b }); // 漢字 ROM(第一水準 128K / 第一+第二 256K)
      else alert(T('MSX の BIOS は 32K(メイン/漢字ドライバ)、16K(サブ/ロゴ/ディスク)、128K/256K(漢字 ROM)のファイルです: {name}', { name: f.name }));
    }
    if (!list.length) return;
    const target = targetMach || (cfg.msx.machine !== 'auto' ? cfg.msx.machine : (resolveMsxMachine() || (list.some((x) => x.kind !== 'main') ? 'msx2' : 'msx1')));
    for (const x of list) storeMsxBios(target, x.kind, x.bytes);
    flashStatus(T('BIOS を控えました({machine}: {kinds})', { machine: MSX_MACHINE_LABEL[target] || target, kinds: list.map((x) => x.kind).join('/') }));
    if (pendingMsx) { const p = pendingMsx; pendingMsx = null; NesScreen.open(p.bytes, p.name).catch((e) => { statusEl.textContent = T('エラー: {msg}', { msg: e && e.message ? e.message : String(e) }); }); }
  }
  function updateBiosBtn() {
    if (!biosBtn) return;
    biosBtn.title = T('BIOS を選ぶ(複数選択可。中身で振り分けてこのブラウザに控え、次回も使います)') + '\n' +
      T('ディスクシステム: disksys.rom(8K)') + '\n' +
      T('MSX: メイン 32K、サブ/ロゴ/ディスク ROM 16K、漢字 128K/256K、漢字ドライバ 32K(⚙ の機種の控えに。自動なら MSX2)。ディスクの起動にはメイン+サブ+ディスク ROM の 3 つが要ります');
    biosBtn.setAttribute('aria-label', biosBtn.title);
  }
  // MSX のキー: 設定の操作キー以外は本体のキーボードへ(Worklet なら key メッセージ)。兼用 ON ならカーソル/スペースをジョイスティック 1 にも
  function msxKey(code, down) {
    if (node) node.port.postMessage({ type: 'key', code, down });
    else if (nes && typeof nes.setKey === 'function') nes.setKey(code, down);
    const jb = cfg.msx.joyFromKeys ? (MSX_JOY_KEYS[code] || 0) : 0;
    if (jb) { if (down) keyBits |= jb; else keyBits &= ~jb; pushPad(); }
  }
  function msxKeyReleaseAll() {
    if (node) node.port.postMessage({ type: 'keyReleaseAll' });
    else if (nes && nes.keyboard && nes.keyboard.releaseAll) nes.keyboard.releaseAll();
  }
  // 機種別のステート API
  function stateApi() { return machine === 'msx' ? MML.Emu.MsxState : MML.Emu.NesState; }
  // 設定(機種/マッパー)が変わった: 開いている MSX の ROM を開き直す(BIOS 待ちなら待っている ROM で再試行)
  function reopenMsx() {
    const onErr = (e) => { statusEl.textContent = T('エラー: {msg}', { msg: e && e.message ? e.message : String(e) }); };
    if (pendingMsx) { const p = pendingMsx; pendingMsx = null; NesScreen.open(p.bytes, p.name).catch(onErr); return; }
    if (machine !== 'msx') return;
    // ディスクで動いていれば、入っている組ごと開き直す(open() に渡すと「同じディスクを足す」入れ替えになってしまう)
    if (msxDisk && diskImages.length) { openMsx(diskImages[0], diskNames[0] || romName, { disk: true, extraDisks: diskImages.slice(1), extraNames: diskNames.slice(1) }).catch(onErr); return; }
    if (romBytes) NesScreen.open(romBytes, romName).catch(onErr);
  }

  // [disk] の一覧: 枚数 × 面。MSX は 1 枚 1 行(名前つき)、FDS はヘッダの枚数/面でまとめる(値が妥当でなければ 2 面ずつ 1 枚と見なす)
  function diskRows() {
    const rows = [];
    if (machine === 'msx') { for (let i = 0; i < fdsSides; i++) rows.push({ num: i + 1, label: T('ディスク {n}', { n: i + 1 }), name: diskNames[i] || '', sides: [{ index: i, label: '', code: '' }] }); return rows; }
    const info = fdsSideInfo && fdsSideInfo.length === fdsSides && fdsSideInfo.every((x) => x.disk < 16 && x.side < 2) ? fdsSideInfo : null;
    const byDisk = new Map();
    for (let i = 0; i < fdsSides; i++) {
      const d = info ? info[i].disk : (i >> 1), sd = info ? info[i].side : (i & 1);
      if (!byDisk.has(d)) byDisk.set(d, []);
      byDisk.get(d).push({ index: i, label: sd ? T('B 面') : T('A 面'), code: sd ? 'B' : 'A' });
    }
    for (const [d, sides] of [...byDisk.entries()].sort((a, b) => a[0] - b[0])) rows.push({ num: d + 1, label: T('ディスク {n}', { n: d + 1 }), name: '', sides });
    return rows;
  }
  function diskButtonLabel() { for (const r of diskRows()) for (const sd of r.sides) if (sd.index === fdsSide) return r.num + sd.code; return String(fdsSide + 1); }
  function sideLabel() { return T('ディスク {label}', { label: diskButtonLabel() }); }
  function updateDiskUi() {
    if (!sideBtn) return;
    sideBtn.hidden = fdsSides < 2;
    sideBtn.querySelector('.nes-ib-lbl').textContent = diskButtonLabel();
    sideBtn.title = sideLabel() + ' — ' + T('クリックで枚数と面を選ぶ(取り出してから入れる)。別の .dsk を開くと足して入れ替わります');
  }
  function closeDiskPopover() {
    if (!diskPopEl) return;
    diskPopEl.remove(); diskPopEl = null;
    if (diskPopClose) { document.removeEventListener('mousedown', diskPopClose, true); document.removeEventListener('keydown', diskPopClose, true); diskPopClose = null; }
  }
  function toggleDiskPopover(anchorEl) {
    if (diskPopEl) { closeDiskPopover(); return; }
    const pop = document.createElement('div');
    pop.className = 'kbd-layout-pop nes-cfg-pop nes-disk-pop';
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    const title = document.createElement('div'); title.className = 'kbd-layout-sec-title'; title.textContent = T('ディスクを選ぶ'); pop.appendChild(title);
    for (const r of diskRows()) {
      const row = document.createElement('div'); row.className = 'nes-disk-row';
      const lbl = document.createElement('span'); lbl.className = 'nes-disk-lbl'; lbl.textContent = r.label + (r.name ? ' ' + r.name : ''); lbl.title = r.name || r.label; row.appendChild(lbl);
      for (const sd of r.sides) {
        const b = mkBtn(sd.label || T('入れる'), '', () => { closeDiskPopover(); if (sd.index !== fdsSide && !sideTimer) switchSide(sd.index); });
        if (sd.index === fdsSide) b.classList.add('is-on');
        row.appendChild(b);
        if (machine === 'msx') {
          if (diskDirty.has(sd.index)) { const m = document.createElement('span'); m.className = 'nes-disk-dirty'; m.textContent = '●'; m.title = T('書き込みあり(まだ書き戻していない)'); row.appendChild(m); }
          row.appendChild(mkBtn(T('書き出す'), T('今の中身を .dsk として保存する(元のファイルは触らない)'), () => { closeDiskPopover(); exportDisk(sd.index); }));
        }
      }
      pop.appendChild(row);
    }
    if (machine === 'msx' && cfg.msx.writeBack) {
      const row = document.createElement('div'); row.className = 'nes-disk-row';
      const lbl = document.createElement('span'); lbl.className = 'nes-disk-lbl'; lbl.textContent = diskDirHandle ? T('書き戻し先: {dir}', { dir: diskDirHandle.name }) : T('書き戻し先のフォルダが未選択'); row.appendChild(lbl);
      row.appendChild(mkBtn(T('フォルダを選ぶ'), '', () => { closeDiskPopover(); pickDiskDir(); }));
      pop.appendChild(row);
    }
    document.body.appendChild(pop);
    diskPopEl = pop;
    const rc = anchorEl.getBoundingClientRect();
    let left = rc.left, top = rc.bottom + 4;
    if (left + pop.offsetWidth > window.innerWidth - 4) left = Math.max(4, window.innerWidth - pop.offsetWidth - 4);
    if (top + pop.offsetHeight > window.innerHeight - 4) top = Math.max(4, rc.top - pop.offsetHeight - 4);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    diskPopClose = (e) => { if (e.type === 'keydown' && e.key !== 'Escape') return; if (e.type === 'mousedown' && (pop.contains(e.target) || anchorEl.contains(e.target))) return; closeDiskPopover(); };
    document.addEventListener('mousedown', diskPopClose, true);
    document.addEventListener('keydown', diskPopClose, true);
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
    ff: '<path d="M17 5.5v9l-6-4.5zM9.5 5.5v9l-6-4.5z" fill="currentColor" stroke="none"/>', // 向きは 2026-11-04 に入れ替え
    rewind: '<path d="M3 5.5v9l6-4.5zM10.5 5.5v9l6-4.5z" fill="currentColor" stroke="none"/>',
    saveState: '<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5"/><path d="M3.5 13.5v3h13v-3"/>',
    loadState: '<path d="M10 12V3M6.5 6.5 10 3l3.5 3.5"/><path d="M3.5 13.5v3h13v-3"/>',
    gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2.1M10 15.3v2.1M17.4 10h-2.1M4.7 10H2.6M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5M15.1 15.1l-1.5-1.5M6.4 6.4 4.9 4.9"/>',
    pause: '<path d="M6.5 4.5v11M13.5 4.5v11" stroke-width="2.4"/>',
    play: '<path d="M6 4.5v11l9-5.5z" fill="currentColor" stroke="none"/>',
    rec: '<circle cx="10" cy="10" r="5" fill="currentColor" stroke="none"/>',
    stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>',
    disk: '<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><circle cx="10" cy="10" r="2.5"/>',
    keyboard: '<rect x="2.5" y="5.5" width="15" height="9" rx="1.5"/><path d="M5 8.5h1M8 8.5h1M11 8.5h1M14 8.5h1M5 11.5h1M7.5 11.5h5M14 11.5h1"/>',
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
    romInput = document.createElement('input'); romInput.type = 'file'; romInput.accept = '.nes,.fds,.rom,.mx1,.mx2'; romInput.style.display = 'none';
    romInput.addEventListener('change', () => { const f = romInput.files && romInput.files[0]; romInput.value = ''; openRomFile(f); });
    const openBtn = mkIcon('open', T('開く(.nes/.fds/.rom。ウィンドウへのドロップでも開けます)'), () => romInput.click());
    const resetBtn = mkIcon('reset', T('リセット'), () => { if (node) node.port.postMessage({ type: 'reset' }); else if (nes) { nes.reset(); if (rewindBuf) rewindBuf.clear(); } liveRestart(); });
    speedBtn = mkIcon('ff', '', () => { speedSel = SPEEDS[(SPEEDS.indexOf(speedSel) + 1) % SPEEDS.length]; pushSpeed(); }, '');
    stateBtnS = mkIcon('saveState', '', requestSaveState);
    stateBtnL = mkIcon('loadState', '', requestLoadState);
    sideBtn = mkIcon('disk', '', () => { if (fdsSides >= 1) toggleDiskPopover(sideBtn); }, 'A'); sideBtn.hidden = true;
    biosBtn = mkIcon('chip', T('ディスクシステムの BIOS(disksys.rom、8KB)を選ぶ。このブラウザに控えて次回も使います'), () => biosInput.click(), 'BIOS'); biosBtn.hidden = true; // BIOS の選択は ⚙ の機種タブへ(2026-11-10)。入力欄は共用
    biosInput = document.createElement('input'); biosInput.type = 'file'; biosInput.accept = '.rom,.bin,.nes'; biosInput.multiple = true; biosInput.style.display = 'none';
    biosInput.addEventListener('change', async () => {
      const files = Array.from(biosInput.files || []); biosInput.value = '';
      const target = biosTarget; biosTarget = null;
      if (!files.length) return;
      const fdsFiles = [];
      for (const f of files) { const b = new Uint8Array(await f.arrayBuffer()); if (MML.Emu.FdsDisk && MML.Emu.FdsDisk.isFdsBios(b)) fdsFiles.push({ f, b }); }
      if (fdsFiles.length) { storeFdsBiosFile(fdsFiles[0].b, fdsFiles[0].f.name); if (files.length === fdsFiles.length) { if (cfgBiosRefresh) cfgBiosRefresh(); return; } } // disksys.rom は機種に関係なく FDS 側へ
      const rest = files.filter((f) => !fdsFiles.some((x) => x.f === f));
      if (!rest.length) return;
      // 残りは MSX の BIOS として大きさで振り分ける(16K/32K/128K/256K)。それ以外の大きさは案内
      const sizes = await Promise.all(rest.map((f) => f.arrayBuffer().then((b) => b.byteLength)));
      const msxFiles = rest.filter((f, i) => [0x4000, 0x8000, 0x10000, 0x20000, 0x40000].includes(sizes[i]));
      const odd = rest.filter((f, i) => ![0x4000, 0x8000, 0x10000, 0x20000, 0x40000].includes(sizes[i]));
      if (odd.length) alert(T('BIOS として扱えないファイルです(ディスクシステムは 8K、MSX は 16K/32K/128K/256K): {name}', { name: odd.map((f) => f.name).join(', ') }));
      if (msxFiles.length) await storeMsxBiosFiles(msxFiles, target && target.kind === 'msx' ? target.mach : null);
      if (cfgBiosRefresh) cfgBiosRefresh();
    });
    kbdBtn = mkIcon('keyboard', T('MSX のソフトキーボードを表示/隠す(タッチ端末では常に表示)'), () => { cfg.msx.softKbd = !cfg.msx.softKbd; saveCfg(); updateSoftKbd(); }); kbdBtn.hidden = true;
    updateBiosBtn(); // 空の窓でも説明(FDS/MSX 両方)を出す
    cfgBtn = mkIcon('gear', T('設定(キー/ゲームパッドの割り当て、連射、ロールへ流す)'), () => toggleCfgPopover(cfgBtn));
    pauseBtn = mkIcon('pause', T('一時停止'), () => setPaused(!paused));
    rewindBtn = mkIcon('rewind', '', null);
    attachHold(rewindBtn, () => rewindHoldStart(), () => rewindHoldEnd());
    recBtn = mkIcon('rec', '', toggleRecord); recBtn.classList.add('nes-rec');
    // 並び: [開く][リセット][状態保存][状態読込]([面][BIOS]) 間 [早送り] 間 [一時停止] 間 [巻き戻し] 間 [録音] 間 [設定]
    const gap = () => { const g = document.createElement('span'); g.className = 'nes-hdr-g'; return g; };
    for (const el of [romInput, openBtn, resetBtn, stateBtnS, stateBtnL, sideBtn, biosBtn, kbdBtn, biosInput, gap(), speedBtn, gap(), pauseBtn, gap(), rewindBtn, gap(), recBtn, gap(), cfgBtn]) hdr.appendChild(el);
    // 本体: 上にファイル名+状態+録音結果、画面、タッチ操作キー
    const bar = document.createElement('div'); bar.className = 'nes-bar';
    machineEl = document.createElement('span'); machineEl.className = 'nes-machine';
    nameEl = document.createElement('span'); nameEl.className = 'nes-name';
    ilBadgeEl = document.createElement('span'); ilBadgeEl.className = 'nes-ilbadge'; ilBadgeEl.textContent = T('インターレース'); ilBadgeEl.title = T('インターレース表示中(偶奇フィールドを交互の行に描いた 480 行)'); ilBadgeEl.hidden = true;
    statusEl = document.createElement('span'); statusEl.className = 'nes-status';
    recInfoEl = document.createElement('span'); recInfoEl.className = 'nes-recinfo';
    const recOpt = (key) => {
      const lbl = document.createElement('label'); lbl.className = 'nes-cfg-check nes-rec-opt';
      const c = document.createElement('input'); c.type = 'checkbox';
      c.addEventListener('change', () => { applyRecClean(); if (canvas) canvas.focus(); });
      lbl.appendChild(c); lbl.appendChild(document.createTextNode(' ' + T(key === 'sfx' ? '効果音を除く' : '処理落ちを詰める')));
      lbl.title = T(key === 'sfx' ? '曲が 3 周以上入った録音を周期で重ね、周回ごとに違う書き込みを多数決で置き換えます(保存にも変換にも効く)' : '音楽の定期書き込みが無いフレームを処理落ちとみなして詰めます(保存にも変換にも効く)');
      lbl.hidden = true;
      return { lbl, c };
    };
    const so = recOpt('sfx'), lo = recOpt('lag');
    recSfxChk = so.c; recLagChk = lo.c;
    saveBtn = mkBtn(T('VGM を保存'), '', saveRecording); saveBtn.hidden = true;
    convBtn = mkBtn(T('変換へ'), '', () => { if (recVgm && NesScreen.onOpenRecording) { setPaused(true); NesScreen.onOpenRecording(recVgm, recFileName()); } }); convBtn.hidden = true;
    diskBadgeEl = document.createElement('button'); diskBadgeEl.type = 'button'; diskBadgeEl.className = 'nes-diskbadge'; diskBadgeEl.hidden = true;
    diskBadgeEl.addEventListener('click', () => { if (cfg.msx.writeBack && !diskDirHandle) pickDiskDir(); else toggleDiskPopover(sideBtn.hidden ? diskBadgeEl : sideBtn); });
    bar.appendChild(machineEl); bar.appendChild(nameEl); bar.appendChild(statusEl); bar.appendChild(diskBadgeEl); bar.appendChild(recInfoEl); bar.appendChild(so.lbl); bar.appendChild(lo.lbl); bar.appendChild(saveBtn); bar.appendChild(convBtn); bar.appendChild(ilBadgeEl);
    statusEl.textContent = '';
    wrap.appendChild(bar); wrap.appendChild(canvas);
    if (MML.Device && MML.Device.isTouch && MML.Device.isTouch()) wrap.appendChild(buildTouchPad());
    softKbdEl = buildSoftKeyboard(); softKbdEl.hidden = true; wrap.appendChild(softKbdEl);
    body.appendChild(wrap);
    applyCfgLabels();
    canvas.addEventListener('keydown', (e) => {
      const a = keyActionOf(e.code);
      if (!a) { if (machine === 'msx') { e.preventDefault(); msxKey(e.code, true); } return; } // MSX: 操作キー以外はそのまま MSX のキーボードへ
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
      if (!a) { if (machine === 'msx') { e.preventDefault(); msxKey(e.code, false); } return; }
      e.preventDefault();
      if (PAD_BITS[a]) { keyBits &= ~PAD_BITS[a]; pushPad(); }
      else if (a === 'TurboA') { keyTurbo &= ~1; pushPad(); }
      else if (a === 'TurboB') { keyTurbo &= ~2; pushPad(); }
      else if (a === 'FF') { ffHold = false; pushSpeed(); }
      else if (a === 'Rewind') rewindHoldEnd();
    });
    canvas.addEventListener('blur', () => { if (ffHold) { ffHold = false; pushSpeed(); } rewindHoldEnd(); keyBits = 0; keyTurbo = 0; pushPad(); if (machine === 'msx') msxKeyReleaseAll(); });
    pushSpeed();
    canvas.addEventListener('pointerdown', () => { canvas.focus(); resumeAudio(); });
    // ROM のドロップ(窓のどこでも)
    win.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } });
    win.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && Array.from(e.dataTransfer.files).find((x) => /\.(nes|fds|rom|mx1|mx2|dsk)$/i.test(x.name));
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
    const keys = curKeys(), k = (a) => keyLabel(keys[a]);
    if (machine === 'msx') canvas.title = T('クリックしてキー入力(PC のキーがそのまま MSX のキーボードに。{ff}=早送り、{rw}=巻き戻し、{pa}=一時停止、{ss}/{ls}=状態保存/読込)',
      { ff: k('FF'), rw: k('Rewind'), pa: k('Pause'), ss: k('SaveState'), ls: k('LoadState') });
    else canvas.title = T('クリックしてキー入力(十字=矢印、A={a}、B={b}、連射 A={ta}、連射 B={tb}、Start={st}、Select={se}、{ff}=早送り、{rw}=巻き戻し、{pa}=一時停止)',
      { a: k('A'), b: k('B'), ta: k('TurboA'), tb: k('TurboB'), st: k('Start'), se: k('Select'), ff: k('FF'), rw: k('Rewind'), pa: k('Pause') });
    speedBtn.title = T('早送り。クリックで ×1→×2→×4→×8。{key} キーを押している間は ×4', { key: k('FF') });
    stateBtnS.title = T('今の状態をこのブラウザに保存(ROM ごとに 1 つ。{key})', { key: k('SaveState') });
    stateBtnL.title = T('保存した状態に戻す({key})', { key: k('LoadState') });
    rewindBtn.title = T('巻き戻し(押している間 逆再生で戻る。{key} キー。鍵盤表示のロールをドラッグしても戻れます)', { key: k('Rewind') });
    for (const b of [speedBtn, stateBtnS, stateBtnL, rewindBtn]) b.setAttribute('aria-label', b.title);
  }

  // ── MSX のソフトキーボード(7f): タッチ端末では MSX のとき常に、PC では ⌨ で出す。日本語配列。Shift/Ctrl/Graph はタップで掛かり、次のキーを離すと外れる ──
  const SOFT_ROWS = [
    [['F1', 'F1', 1.5], ['F2', 'F2', 1.5], ['F3', 'F3', 1.5], ['F4', 'F4', 1.5], ['F5', 'F5', 1.5], null, ['Esc', 'ESC'], ['Tab', 'TAB'], ['Stop', 'STOP'], ['Select', 'SEL'], ['BS', 'BS'], ['Home', 'HOME'], ['Ins', 'INS'], ['Del', 'DEL']],
    [['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'], ['Caret', '^'], ['Yen', '¥']],
    [['Q', 'Q'], ['W', 'W'], ['E', 'E'], ['R', 'R'], ['T', 'T'], ['Y', 'Y'], ['U', 'U'], ['I', 'I'], ['O', 'O'], ['P', 'P'], ['At', '@'], ['BracketLeft', '['], ['Return', 'RET', 1.6]],
    [['Ctrl', 'CTRL', 1.4, 'mod'], ['A', 'A'], ['S', 'S'], ['D', 'D'], ['F', 'F'], ['G', 'G'], ['H', 'H'], ['J', 'J'], ['K', 'K'], ['L', 'L'], ['Semicolon', ';'], ['Colon', ':'], ['BracketRight', ']']],
    [['Shift', 'SHIFT', 1.8, 'mod'], ['Z', 'Z'], ['X', 'X'], ['C', 'C'], ['V', 'V'], ['B', 'B'], ['N', 'N'], ['M', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['Underscore', '_'], ['Graph', 'GRPH', 1.4, 'mod']],
    [['Caps', 'CAPS', 1.4], ['Kana', 'かな', 1.4], ['Space', '', 5], ['Left', '←'], ['Up', '↑'], ['Down', '↓'], ['Right', '→']],
  ];
  function buildSoftKeyboard() {
    const kb = document.createElement('div'); kb.className = 'nes-skbd';
    const latched = new Set(); // 掛かっている修飾キー
    const els = new Map();     // キー名 → 要素
    for (const row of SOFT_ROWS) {
      const r = document.createElement('div'); r.className = 'nes-skrow';
      for (const k of row) {
        if (!k) { const g = document.createElement('span'); g.className = 'nes-skgap'; r.appendChild(g); continue; }
        const [name, label, w, mod] = k;
        const el = document.createElement('div'); el.className = 'nes-skey' + (mod ? ' nes-skey-mod' : ''); el.textContent = label; el.dataset.key = name;
        if (w) el.style.flexGrow = String(w);
        els.set(name, el);
        r.appendChild(el);
      }
      kb.appendChild(r);
    }
    const downPointers = new Map(); // pointerId → キー名
    const press = (name) => { msxKey(name, true); els.get(name).classList.add('is-on'); };
    const release = (name) => { msxKey(name, false); els.get(name).classList.remove('is-on'); };
    kb.addEventListener('pointerdown', (e) => {
      const el = e.target.closest ? e.target.closest('.nes-skey') : null;
      if (!el || !kb.contains(el)) return;
      e.preventDefault(); resumeAudio();
      const name = el.dataset.key;
      if (el.classList.contains('nes-skey-mod')) { // 修飾キー: タップで掛け外し
        if (latched.has(name)) { latched.delete(name); release(name); } else { latched.add(name); press(name); }
        return;
      }
      try { kb.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      downPointers.set(e.pointerId, name); press(name);
    });
    const up = (e) => {
      const name = downPointers.get(e.pointerId);
      if (!name) return;
      downPointers.delete(e.pointerId); release(name);
      if (!downPointers.size) { for (const m of latched) release(m); latched.clear(); } // 修飾キーは次のキーを離したら外す
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) kb.addEventListener(ev, up);
    kb.addEventListener('contextmenu', (e) => e.preventDefault());
    kb.releaseAll = () => { for (const n of downPointers.values()) release(n); downPointers.clear(); for (const m of latched) release(m); latched.clear(); };
    return kb;
  }
  // 表示の更新: MSX のときだけ ⌨ を出し、タッチ端末か設定 ON ならソフトキーボードを出す。タッチ操作キーの SELECT/START のラベルも機種で変える
  function updateSoftKbd() {
    const msx = machine === 'msx';
    if (kbdBtn) { kbdBtn.hidden = !msx; kbdBtn.classList.toggle('nes-ib--on', msx && !!cfg.msx.softKbd); }
    const touch = !!(MML.Device && MML.Device.isTouch && MML.Device.isTouch());
    if (softKbdEl) { const show = msx && (touch || cfg.msx.softKbd); if (!show && !softKbdEl.hidden && softKbdEl.releaseAll) softKbdEl.releaseAll(); softKbdEl.hidden = !show; }
    if (touchPadEl && touchPadEl.relabel) touchPadEl.relabel();
    updateDiskBadge();
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
    const selK = key('nes-tk-small', 'SELECT', PAD_BITS.Select), startK = key('nes-tk-small', 'START', PAD_BITS.Start);
    selK.dataset.nesLabel = 'SELECT'; selK.dataset.msxKey = 'Space'; selK.dataset.msxLabel = 'SPACE'; startK.dataset.nesLabel = 'START'; startK.dataset.msxKey = 'Return'; startK.dataset.msxLabel = 'RETURN'; // MSX では SPACE/RETURN(MSX のキー)に
    mid.appendChild(selK); mid.appendChild(startK);
    const ab = document.createElement('div'); ab.className = 'nes-tab';
    const row1 = document.createElement('div'); row1.className = 'nes-trow';
    row1.appendChild(key('nes-tk-turbo', T('連射 B'), 0, 2)); row1.appendChild(key('nes-tk-turbo', T('連射 A'), 0, 1));
    const row2 = document.createElement('div'); row2.className = 'nes-trow';
    row2.appendChild(key('nes-tk-ab', 'B', PAD_BITS.B)); row2.appendChild(key('nes-tk-ab', 'A', PAD_BITS.A));
    ab.appendChild(row1); ab.appendChild(row2);
    pad.appendChild(dpad); pad.appendChild(mid); pad.appendChild(ab);
    const held = new Map(); // pointerId → 押しているキー要素
    let msxDown = new Set(); // MSX で押している MSX キー名(SPACE/RETURN)
    const recompute = () => {
      let bits = 0, turbo = 0;
      const on = new Set(held.values());
      const msx = machine === 'msx', names = new Set();
      for (const el of on) { if (msx && el.dataset.msxKey) { names.add(el.dataset.msxKey); continue; } bits |= +(el.dataset.bits || 0); turbo |= +(el.dataset.turbo || 0); }
      for (const el of pad.querySelectorAll('.nes-tkey')) el.classList.toggle('is-on', on.has(el));
      touchBits = bits; touchTurbo = turbo;
      pushPad();
      if (msx) { for (const n of msxDown) if (!names.has(n)) msxKey(n, false); for (const n of names) if (!msxDown.has(n)) msxKey(n, true); }
      msxDown = names;
    };
    pad.relabel = () => { for (const el of [selK, startK]) el.textContent = machine === 'msx' ? el.dataset.msxLabel : el.dataset.nesLabel; };
    touchPadEl = pad;
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
    popEl.remove(); popEl = null; cfgBiosRefresh = null;
    if (popClose) { document.removeEventListener('mousedown', popClose, true); document.removeEventListener('keydown', popClose, true); popClose = null; }
  }
  let cfgTab = null;          // 開いているタブ('common' | 'nes' | 'msx')。閉じても覚える
  let cfgBiosRefresh = null;  // 開いている設定の BIOS 表を描き直す(BIOS を控えた/消した後)
  let biosTarget = null;      // [選ぶ…] を押した機種({ kind: 'nes' } | { kind: 'msx', mach })
  const MSX_BIOS_KINDS = [['main', 'メイン 32K'], ['sub', 'サブ 16K'], ['disk', 'ディスク ROM 16K'], ['kanji', '漢字 ROM'], ['kdr', '漢字ドライバ 32K'], ['logo', 'ロゴ 16K'], ['music', 'MSX-MUSIC/FM-PAC ROM']];
  function clearMsxBios(mach) {
    try { for (const [k] of MSX_BIOS_KINDS) localStorage.removeItem(MSX_BIOS_KEY + mach + '.' + k); } catch (e) { /* ignore */ }
    delete msxBiosCache[mach];
  }
  function clearFdsBios() { try { localStorage.removeItem(BIOS_KEY); } catch (e) { /* ignore */ } fdsBios = null; }
  function toggleCfgPopover(anchorEl) {
    if (popEl) { closeCfgPopover(); return; }
    const pop = document.createElement('div');
    pop.className = 'kbd-layout-pop nes-cfg-pop';
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());
    // タブ: 共通 / ファミコン / MSX(機種の設定は機種のタブに、どの機種にも効く物は共通に)
    const TABS = [['common', T('共通')], ['nes', T('ファミコン / FDS')], ['msx', 'MSX']];
    if (!cfgTab) cfgTab = machine === 'msx' ? 'msx' : (romBytes ? 'nes' : 'common');
    const tabBar = document.createElement('div'); tabBar.className = 'nes-cfg-tabs';
    const panes = {}, tabBtns = {};
    const selectTab = (id) => { cfgTab = id; for (const k of Object.keys(panes)) { panes[k].hidden = k !== id; tabBtns[k].classList.toggle('is-on', k === id); } };
    for (const [id, label] of TABS) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nes-cfg-tab'; b.textContent = label; b.addEventListener('click', () => selectTab(id));
      tabBar.appendChild(b); tabBtns[id] = b;
      const p = document.createElement('div'); p.className = 'nes-cfg-pane'; panes[id] = p;
    }
    pop.appendChild(tabBar); for (const id of Object.keys(panes)) pop.appendChild(panes[id]);
    const sec = (title, tab) => {
      const d = document.createElement('div'); d.className = 'kbd-layout-sec';
      if (title) { const t = document.createElement('div'); t.className = 'kbd-layout-sec-title'; t.textContent = title; d.appendChild(t); }
      panes[tab || 'common'].appendChild(d); return d;
    };
    const note = (parent, text) => { const d = document.createElement('div'); d.className = 'nes-cfg-note'; d.textContent = text; parent.appendChild(d); return d; };
    const selRow = (label) => { const r = document.createElement('div'); r.className = 'nes-cfg-row'; const l = document.createElement('span'); l.textContent = label; const s = document.createElement('select'); r.appendChild(l); r.appendChild(s); return { r, s }; };
    const check = (parent, checked, label, onChange) => {
      const l = document.createElement('label'); l.className = 'nes-cfg-check';
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!checked;
      c.addEventListener('change', () => onChange(c.checked));
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + label)); parent.appendChild(l); return c;
    };

    // ── 共通 ──
    const s0 = sec(T('鍵盤表示'), 'common');
    check(s0, cfg.liveRoll, T('鳴っている音をロールへ流す(ライブ表示)'), (v) => { cfg.liveRoll = v; saveCfg(); if (cfg.liveRoll) liveBegin(); else liveEnd('end'); });
    note(s0, T('鍵盤表示を開いておくと、音源レジスタの書き込みがその場で追記モードのロールに出ます(未来は無いので、鳴った音符が縁から生えて遠ざかる表示)。鍵盤表示のミュートと ch 別音量もゲームの音に効きます'));
    const s1 = sec(T('連射'), 'common');
    const row = document.createElement('div'); row.className = 'nes-cfg-row';
    const rl = document.createElement('span'); rl.textContent = T('速さ');
    const sel = document.createElement('select');
    for (const r of TURBO_RATES) { const o = document.createElement('option'); o.value = String(r); o.textContent = T('{n} 回/秒', { n: (30 / r) % 1 ? (30 / r).toFixed(1) : String(30 / r) }); sel.appendChild(o); }
    sel.value = String(cfg.turboRate);
    sel.addEventListener('change', () => { cfg.turboRate = +sel.value; saveCfg(); pushTurboRate(); });
    row.appendChild(rl); row.appendChild(sel); s1.appendChild(row);
    const s1b = sec(T('巻き戻し'), 'common');
    const row2 = document.createElement('div'); row2.className = 'nes-cfg-row';
    const rl2 = document.createElement('span'); rl2.textContent = T('速さ');
    const sel2 = document.createElement('select');
    for (const r of REWIND_SPEEDS) { const o = document.createElement('option'); o.value = String(r); o.textContent = '×' + r; sel2.appendChild(o); }
    sel2.value = String(cfg.rewindSpeed);
    sel2.addEventListener('change', () => { cfg.rewindSpeed = +sel2.value; saveCfg(); if (node && rwActive) node.port.postMessage({ type: 'rewindSpeed', speed: cfg.rewindSpeed }); });
    row2.appendChild(rl2); row2.appendChild(sel2); s1b.appendChild(row2);
    note(s1b, T('押している間、直前 2 分の映像を逆再生で戻ります(音は止まります)。離した所からゲームが続きます'));
    const s1c = sec(T('録音の補正'), 'common');
    check(s1c, cfg.sfxRemove, T('効果音を除く'), (v) => { cfg.sfxRemove = v; saveCfg(); });
    check(s1c, cfg.lagFix, T('処理落ちを詰める'), (v) => { cfg.lagFix = v; saveCfg(); });
    note(s1c, T('録音が終わった時の初期値です。録音ごとの ON/OFF は [VGM を保存][変換へ] の横のチェックで変えられ、保存する VGM と変換に進む VGM の両方に効きます。効果音除去は曲が 3 周以上入っている録音で効きます(周回の多数決)'));
    // ゲームパッド(共通)
    const s3 = sec(T('ゲームパッド(1P/2P 共通)'), 'common');
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
    const s4 = sec('', 'common');
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'nes-btn'; reset.textContent = T('既定に戻す');
    reset.addEventListener('click', () => { cfg = loadCfgDefaults(); saveCfg(); pushTurboRate(); applyCfgLabels(); updateSoftKbd(); updateDiskBadge(); const a = anchorEl; closeCfgPopover(); toggleCfgPopover(a); });
    s4.appendChild(reset);
    note(s4, T('キー/パッドの割り当て、連射、巻き戻し、録音の補正、MSX のカートリッジ 2/FDC/書き戻しを既定に戻します(BIOS の控えと機種は残ります)'));

    // ── BIOS(ファミコン / MSX)──
    const biosNote = (parent, text) => note(parent, text);
    const ok = (v) => { const sp = document.createElement('span'); sp.className = v ? 'nes-bios-ok' : 'nes-bios-ng'; sp.textContent = v ? '✔' : '–'; return sp; };
    const sn = sec(T('BIOS'), 'nes');
    const fdsBox = document.createElement('div'); sn.appendChild(fdsBox);
    biosNote(sn, T('ディスクシステム(.fds)の起動に disksys.rom(8K)が要ります。このブラウザに控えて次回も使います。.nes のカートリッジには要りません'));
    const sb = sec(T('BIOS(機種ごとの控え)'), 'msx');
    const msxBox = document.createElement('div'); sb.appendChild(msxBox);
    biosNote(sb, T('メインを控えていない機種は同梱 C-BIOS で動きます(BASIC・ディスク・漢字は無し)。ディスクの起動にはメイン+サブ+ディスク ROM の 3 つ、turbo R はメイン+サブ(+漢字ドライバ)が要ります。ファイルは中身で振り分けるので名前は問いません(複数選択可)。機種「自動」は控えのある機種のうち MSX2 を優先します。MUSIC は MSX-MUSIC/FM-PAC の ROM(16K/64K)で、カートリッジ 2 の FM-PAC と 2+/turbo R の内蔵 FM に使います(無ければ同梱 C-BIOS の物)'));
    const renderBios = () => {
      // FDS
      fdsBox.innerHTML = '';
      const r = document.createElement('div'); r.className = 'nes-cfg-row';
      const have = !!loadBios();
      const lab = document.createElement('span'); lab.className = 'nes-disk-lbl'; lab.appendChild(ok(have)); lab.appendChild(document.createTextNode(' disksys.rom ' + (have ? T('(控え済み)') : T('(未)')))); r.appendChild(lab);
      r.appendChild(mkBtn(T('選ぶ…'), T('disksys.rom(8K)を選ぶ'), () => { biosTarget = { kind: 'nes' }; biosInput.click(); }));
      if (have) r.appendChild(mkBtn(T('消す'), T('控えを消す'), () => { clearFdsBios(); renderBios(); }));
      fdsBox.appendChild(r);
      // MSX: 機種 × 種類の表
      msxBox.innerHTML = '';
      const t = document.createElement('table'); t.className = 'nes-cfg-table nes-bios-table';
      const th = document.createElement('tr');
      for (const h of [T('機種'), T('メイン'), T('サブ'), T('ディスク'), 'MUSIC', T('漢字'), T('漢字ドライバ'), T('ロゴ'), T('同梱'), '']) { const c = document.createElement('th'); c.textContent = h; th.appendChild(c); }
      t.appendChild(th);
      const C = MML.Emu.MsxConsole;
      for (const m of ['msx1', 'msx2', 'msx2plus', 'turbor']) {
        const st = loadMsxBios(m) || {};
        const tr = document.createElement('tr');
        const c0 = document.createElement('td'); c0.textContent = MSX_MACHINE_LABEL[m]; tr.appendChild(c0);
        for (const k of ['main', 'sub', 'disk', 'music', 'kanji', 'kdr', 'logo']) { const c = document.createElement('td'); c.appendChild(ok(!!st[k])); tr.appendChild(c); }
        const cb = document.createElement('td'); cb.textContent = C && C.hasDefaultBios && C.hasDefaultBios(m) ? 'C-BIOS' : '–'; cb.className = 'nes-bios-ng'; tr.appendChild(cb);
        const ca = document.createElement('td');
        ca.appendChild(mkBtn(T('選ぶ…'), T('この機種の BIOS を選ぶ(複数選択可)'), () => { biosTarget = { kind: 'msx', mach: m }; biosInput.click(); }));
        if (Object.keys(st).some((k) => k !== 'name' && st[k])) ca.appendChild(mkBtn(T('消す'), T('この機種の控えを全部消す'), () => { clearMsxBios(m); renderBios(); }));
        tr.appendChild(ca);
        t.appendChild(tr);
      }
      msxBox.appendChild(t);
    };
    renderBios();
    cfgBiosRefresh = renderBios;

    // ── MSX の本体設定 ──
    const sm = sec(T('本体'), 'msx');
    const mr = selRow(T('機種'));
    for (const m of MSX_MACHINES) { const o = document.createElement('option'); o.value = m; o.textContent = m === 'auto' ? T('自動') : MSX_MACHINE_LABEL[m]; mr.s.appendChild(o); }
    mr.s.value = cfg.msx.machine;
    mr.s.addEventListener('change', () => { cfg.msx.machine = MSX_MACHINES.includes(mr.s.value) ? mr.s.value : 'auto'; saveCfg(); reopenMsx(); });
    sm.appendChild(mr.r);
    const pr = selRow(T('マッパー'));
    for (const m of MSX_MAPPERS) { const o = document.createElement('option'); o.value = m; o.textContent = m === 'auto' ? T('自動(判別)') : m; pr.s.appendChild(o); }
    const msxRomOpen = machine === 'msx' && !!romBytes && !pendingMsx;
    pr.s.value = msxRomOpen ? (msxMapperFor(stateKey) || 'auto') : 'auto';
    pr.s.disabled = !msxRomOpen; // ROM ごとに覚えるので、MSX の ROM を開いている時だけ
    pr.s.addEventListener('change', () => { if (!msxRomOpen) return; setMsxMapper(stateKey, pr.s.value); reopenMsx(); });
    sm.appendChild(pr.r);
    const cr = selRow(T('カートリッジ 2'));
    const CART_B_LABEL = { none: T('無し'), fmpac: 'FM-PAC (MSX-MUSIC)', msxaudio: 'MSX-AUDIO (Y8950)', scci: 'SCC-I (SCC+)' };
    for (const k of MSX_CART_B) { const o = document.createElement('option'); o.value = k; o.textContent = CART_B_LABEL[k]; cr.s.appendChild(o); }
    cr.s.value = cfg.msx.cartB;
    cr.s.addEventListener('change', () => { cfg.msx.cartB = MSX_CART_B.includes(cr.s.value) ? cr.s.value : 'none'; saveCfg(); reopenMsx(); });
    sm.appendChild(cr.r);
    const fr = selRow(T('ディスクの FDC'));
    const FDC_LABEL = { wd2793: 'WD2793 (Philips / Sony)', tc8566af: 'TC8566AF (Panasonic / turbo R)' };
    for (const k of MSX_FDC) { const o = document.createElement('option'); o.value = k; o.textContent = FDC_LABEL[k]; fr.s.appendChild(o); }
    fr.s.value = cfg.msx.fdc;
    fr.s.addEventListener('change', () => { cfg.msx.fdc = MSX_FDC.includes(fr.s.value) ? fr.s.value : 'wd2793'; saveCfg(); if (msxDisk) reopenMsx(); });
    sm.appendChild(fr.r);
    check(sm, cfg.msx.joyFromKeys, T('カーソルキーとスペースをジョイスティック 1 にも使う'), (v) => { cfg.msx.joyFromKeys = v; saveCfg(); });
    note(sm, T('マッパーは ROM ごとに覚え、変えると開き直します。カートリッジ 2 はゲームと一緒に挿す音源です。FM 版の曲を持つゲームは FM-PAC を挿すと FM で鳴り、録音にも載ります(MSX2+/turbo R は内蔵 MSX-MUSIC が常にあります)。変えると開き直します'));
    note(sm, T('ディスク(.dsk)の FDC はディスク ROM の機種に合わせます(Philips/Sony=WD2793、Panasonic/turbo R=TC8566AF。合わないと「ディスクがありません」のまま)。動作中に別の .dsk を開くと足して入れ替わり、[disk] で選べます'));
    note(sm, T('turbo R は同梱 C-BIOS に無いので実 BIOS が要ります。内蔵ソフト(512K)は載せません。R800 は S1990 の切り替えに従い、命令時間は近似です。PCM は録音に載り DAC の行で見えます'));
    const sw = sec(T('ディスクの書き込み'), 'msx');
    check(sw, cfg.msx.writeBack, T('ディスクの書き込みを元の .dsk へ書き戻す(フォルダを選ぶ。初回に <名前>.bak を作る)'), (v) => { cfg.msx.writeBack = v; saveCfg(); updateDiskBadge(); if (v && !diskDirHandle && machine === 'msx' && fdsSides > 0) pickDiskDir(); });
    note(sw, T('OFF(既定)でも書き込みはこのブラウザに保存され、同じ .dsk を開くと戻ります。[disk] の「書き出す」でいつでも .dsk として保存できます。ON にすると選んだフォルダの同名ファイルへ書きます(無ければ新規)。フォルダの選択はこのセッションだけ覚えます'));
    // 同梱 C-BIOS(cbiosData.js)の版とライセンス表示(BSD 2 条項は再配布時の著作権表示を求める)。実 BIOS を控えた機種はそちらが優先
    const CB = MML.Emu.CBIOS;
    if (CB && CB.license) {
      const dt = document.createElement('details'); dt.className = 'nes-cfg-note';
      const su = document.createElement('summary');
      const have = ['msx1', 'msx2', 'msx2plus'].filter((m) => CB[m] && CB[m].main).map((m) => MSX_MACHINE_LABEL[m]).join('/');
      su.textContent = T('同梱 BIOS: C-BIOS {ver}({machines})。控えた BIOS の無い機種で使います(BASIC/ディスク/漢字は無し)。ライセンス表示', { ver: CB.version || '', machines: have });
      const pre = document.createElement('pre'); pre.className = 'nes-cfg-license'; pre.textContent = CB.license;
      dt.appendChild(su); dt.appendChild(pre); sb.appendChild(dt);
    }

    // ── キー割り当て(機種のタブに。NES は 1P の全操作、MSX は操作キーだけで他のキーは MSX のキーボードへ)──
    const keyBtns = {};
    const keyTable = (parent, acts, getMap, id) => {
      const tbl = document.createElement('table'); tbl.className = 'nes-cfg-table';
      for (const a of acts) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = actionLabel(a);
        const td2 = document.createElement('td');
        const b = document.createElement('button'); b.type = 'button'; b.className = 'nes-cfg-key secondary';
        b.addEventListener('click', () => captureKey(b, a, acts, getMap));
        td2.appendChild(b); tr.appendChild(td1); tr.appendChild(td2); tbl.appendChild(tr);
        keyBtns[id + ':' + a] = { b, getMap };
      }
      parent.appendChild(tbl);
    };
    const s2 = sec(T('キーボード(1P)'), 'nes');
    keyTable(s2, KEY_ACTIONS, () => cfg.keys, 'nes');
    const s2m = sec(T('キーボード(操作キー。他のキーはそのまま MSX のキーボードへ)'), 'msx');
    keyTable(s2m, MSX_KEY_ACTIONS, () => cfg.msx.keys, 'msx');
    const refresh = () => {
      for (const k of Object.keys(keyBtns)) { const { b, getMap } = keyBtns[k]; b.textContent = keyLabel(getMap()[k.split(':')[1]]); }
      for (const a of PAD_ACTIONS) padBtns[a].textContent = cfg.pad[a] >= 0 ? T('ボタン {n}', { n: cfg.pad[a] }) : T('(なし)');
      applyCfgLabels();
    };
    // キーを 1 つ受け取る(Esc で取り消し)
    function captureKey(btn, action, acts, getMap) {
      if (captureCancel) captureCancel();
      btn.textContent = T('キーを押してください…'); btn.classList.add('nes-cfg-key--wait');
      const h = (e) => {
        e.preventDefault(); e.stopPropagation();
        done();
        if (e.code !== 'Escape') {
          const km = getMap();
          for (const o of acts) if (o !== action && km[o] === e.code) km[o] = ''; // 同じキーは 1 つの操作にだけ
          km[action] = e.code; saveCfg();
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
    selectTab(cfgTab);
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
  function loadCfgDefaults() { return { keys: Object.assign({}, DEFAULT_CFG.keys), pad: Object.assign({}, DEFAULT_CFG.pad), turboRate: DEFAULT_CFG.turboRate, rewindSpeed: DEFAULT_CFG.rewindSpeed, liveRoll: cfg.liveRoll, sfxRemove: DEFAULT_CFG.sfxRemove, lagFix: DEFAULT_CFG.lagFix,
    msx: { keys: Object.assign({}, DEFAULT_CFG.msx.keys), machine: cfg.msx.machine, joyFromKeys: DEFAULT_CFG.msx.joyFromKeys, cartB: cfg.msx.cartB, fdc: cfg.msx.fdc } }; } // 機種は BIOS の控えに結びつくので残す

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
  // 画面の大きさ(本体の frameWidth/frameHeight、frame メッセージの w/h)。変われば canvas と ImageData を作り直す
  function ensureCanvasSize(w, h) {
    w = w || frameW; h = h || frameH;
    if (canvas.width === w && canvas.height === h && imageBuf) return;
    canvas.width = w; canvas.height = h; frameW = w; frameH = h;
    canvas.style.aspectRatio = '256 / 240'; // 画面の形は幅/行数のモードによらず同じ(幅 512 は横半分のドット、インターレースの 480 行は縦半分の行。実機のテレビと同じ)
    if (ilBadgeEl) ilBadgeEl.hidden = h < 480;
    imageBuf = new Uint8ClampedArray(w * h * 4);
    image = new ImageData(imageBuf, w, h);
    idxScratch = null;
  }
  function blitFrame(u32, w, h) {
    ensureCanvasSize(w, h);
    if (u32.length !== frameW * frameH) return; // 大きさの合わない古い画面(機種を切り替えた直後)は捨てる
    imageBuf.set(new Uint8ClampedArray(u32.buffer, u32.byteOffset, u32.byteLength));
    ctx2d.putImageData(image, 0, 0);
    fpsCount++;
  }
  let idxScratch = null;
  function blitIndex(u8, pal, w, h) { // 逆再生の画面(パレット番号 8bit) → RGBA。pal: NES は PPU.PALETTE、MSX は VDP のパレット(rwframe の palette)
    ensureCanvasSize(w, h);
    pal = pal || MML.Emu.PPU.PALETTE;
    if (!idxScratch) idxScratch = new Uint32Array(frameW * frameH);
    for (let i = 0; i < idxScratch.length; i++) idxScratch[i] = pal[u8[i]];
    blitFrame(idxScratch);
  }
  function rewindPalette(seq) { if (machine !== 'msx' || !rewindBuf) return null; return rewindBuf.paletteOf ? rewindBuf.paletteOf(seq) : rewindBuf.palette; } // 主スレッド実行の逆再生の色(フレームごと: パレット/GRAPHIC7 の 256 色)
  function tickFps(now) {
    if (now - fpsMs >= 1000) { fps = fpsCount; fpsCount = 0; fpsMs = now; updateStatus(); }
  }
  function updateStatus() {
    if (!statusEl || flashTimer) return; // 一時表示(ステート保存/読込の結果)の間は上書きしない
    const mode = node ? T('音: AudioWorklet') : T('音なし(主スレッド)');
    statusEl.textContent = `${fps} fps · ${mode}` + (underruns ? ' · ' + T('音切れ {n} 回', { n: underruns }) : '') + (hasBattery ? ' · ' + T('セーブ') : '') + (liveActive ? ' · ' + T('ロール') : '');
    if (pendingFds || pendingMsx) return; // BIOS 待ちの案内を消さない
    const chips = machine === 'msx' ? msxChips.map((c) => c.toUpperCase()).join('+') : ['VRC6', 'VRC7', 'FDS', 'MMC5', 'N163', 'SUNSOFT 5B'].filter((_, i) => recExtBits & (1 << i)).join('+');
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
    // MSX 本体(同じバンドルに入る)。ページが MSX の script を読んでいない時は比べる物が無いので飛ばす
    for (const p of [MML.Emu.MsxConsole, MML.Emu.MsxVdp]) if (p) probes.push(p);
    for (const p of probes) {
      if (typeof p !== 'function' || src.indexOf(p.toString()) < 0) {
        console.warn('[nes] nes-worklet.js がソースより古い(再ビルド忘れ)ため使いません。tools/build-capture-workers.ps1 で再ビルドしてください');
        return null;
      }
    }
    const code = '(' + src + ')();';
    return 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(code)));
  }
  // loadMsg: Worklet への load メッセージ(NES: { rom, bios, battery }、MSX: { machine:'msx', rom, msx:{ machine, mapperType, bios } })、transfers: 移す ArrayBuffer
  async function startWorklet(loadMsg, transfers) {
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
      node.port.postMessage(loadMsg, transfers);
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
        blitFrame(new Uint32Array(m.frame), m.w, m.h);
        frameSeq = m.seq; underruns = m.underruns || 0;
        if (m.writes) takeFrames(m.writes, m.seq);
        tickFps(performance.now());
        break;
      }
      case 'writes': takeFrames(m.frames || [], frameSeq); break; // record on で像を取り直す前に溜まっていた分(最後は今の途中フレーム)
      case 'rewound': blitFrame(new Uint32Array(m.frame), m.w, m.h); onRewound(m.seq); break;
      case 'rwframe': blitIndex(new Uint8Array(m.idx), m.palette ? new Uint32Array(m.palette) : null, m.w, m.h); onReverseFrame(m.seq); break;
      case 'loaded': nameEl.title = m.info; recExtBits = m.extBits || 0; if (m.chips) msxChips = m.chips.slice(); if (m.fps > 0) msxFps = m.fps; fdsSides = m.disks || 0; fdsSide = 0; hasBattery = !!m.battery; updateDiskUi(); updateStatus(); break;
      case 'battery': onBatteryMessage(m); break;
      case 'diskAdded': fdsSides = m.count | 0; fdsSide = m.index | 0; updateDiskUi(); break;
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
    if (!nes) return;
    if (rwActive && rewindBuf) { // 逆再生(主スレッド実行): 再生成を少し進め、速さぶん戻す
      rewindBuf.regenStep(3);
      let last = null, seq = 0;
      for (let n = 0; n < cfg.rewindSpeed; n++) { const r = rewindBuf.reverseStep(); if (!r) break; last = r; seq = rewindBuf.rv.cur; }
      if (last) { blitIndex(last, rewindPalette(seq), rewindBuf && rewindBuf.idxWidth ? rewindBuf.idxWidth : undefined); onReverseFrame(seq); }
      raf = requestAnimationFrame(tick);
      return;
    }
    if (paused) return;
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
      if (hasBattery && nes.batteryDirty && (++mainFrames % 60) === 0) { handleBatteryBlob(nes.getBattery()); nes.clearBatteryDirty(); }
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
  let rewindPending = 0, rewindDebounce = 0;
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
  // 押している間: 逆再生(Worklet は rewindStart/rewindEnd、主スレッド実行は tick が回す)。離したらそのフレームへ本当に戻る
  let rwActive = false, rwCount = 0;
  function rewindHoldStart() {
    if (rwActive || !(node || nes)) return;
    rwActive = true; rwCount = 0;
    rewindBtn.classList.add('nes-rewinding');
    if (node) node.port.postMessage({ type: 'rewindStart', speed: cfg.rewindSpeed });
    else if (rewindBuf) { if (!rewindBuf.beginReverse()) { rwActive = false; rewindBtn.classList.remove('nes-rewinding'); return; } lastMs = 0; startMain(); }
  }
  function rewindHoldEnd() {
    if (!rwActive) return;
    rwActive = false;
    rewindBtn.classList.remove('nes-rewinding');
    if (node) node.port.postMessage({ type: 'rewindEnd' });
    else if (nes && rewindBuf) { const got = rewindBuf.endReverse(); blitFrame(nes.frame); onRewound(got); lastMs = 0; if (paused) stopMain(); }
  }
  // 逆再生中の 1 枚: ロールは数フレームごとに切り詰めて追わせる(最後に rewound で正確に切り詰める)
  function onReverseFrame(seq) {
    if (!liveActive || liveBase === null || !NesScreen.onLiveTruncate) return;
    if ((++rwCount % REWIND_ROLL_EVERY) !== 0) return;
    const keep = seq - liveBase + 1;
    if (keep >= 0) NesScreen.onLiveTruncate(keep);
  }
  // ロールのドラッグシーク(曲の秒 = ライブ表示のフレーム×フレーム長)から。戻せる範囲に丸めた秒を返す。
  // ドラッグ中は間引いて何度も来るので、少し待って最後の 1 回だけ戻す(戻るたびに状態の読込+再生が要るため)
  function rewindTo(sec) {
    if (!liveActive || liveBase === null || !(node || nes) || rwActive) return null;
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
  // 録音の 1 フレーム → ライブ表示の書き込み列。NES: [{addr,value,read?}](DPCM 本体 {dmc} は落とす)。
  // MSX: KSS 形式 [{addr,value,io}](psg=I/O $A0/$A1、opll=$7C/$7D、opl=$C0/$C1、scc/dac=メモリ番地。鍵盤表示の kss* 行が読む形)
  function toLiveWrites(fr) {
    const out = [];
    if (machine === 'msx') {
      for (const w of fr) {
        switch (w.chip) {
          case 'psg': out.push({ addr: 0xA0, value: w.addr, io: true }, { addr: 0xA1, value: w.value, io: true }); break;
          case 'opll': out.push({ addr: 0x7C, value: w.addr, io: true }, { addr: 0x7D, value: w.value, io: true }); break;
          case 'opl': if (w.addr !== 0x0F) out.push({ addr: 0xC0, value: w.addr, io: true }, { addr: 0xC1, value: w.value, io: true }); break;
          case 'scc': case 'dac': out.push({ addr: w.addr, value: w.value, io: false }); break;
          case 'pcm': if (w.addr === 0xA4) out.push({ addr: 0x5000, value: w.value, io: false }); break; // turboR PCM: KSS の D/A($5000)として KDA 行へ
          default: break;
        }
      }
      return out;
    }
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
  // MSX のライブ表示の行構成(鍵盤表示の KSS 系の行名。'kss' で 2A03 の行を消す)
  function msxLiveChips() {
    const out = ['kss', 'kssPsg'];
    if (msxChips.includes('scc')) out.push('kssScc');
    if (msxChips.includes('opll')) out.push('kssOpll');
    if (msxChips.includes('opl')) out.push('opl');
    if (msxChips.includes('dac') || msxChips.includes('pcm')) out.push('kssDac'); // コナミ DAC と turboR PCM は同じ行(KDA)
    return out;
  }
  // ライブ表示を始める(設定 ON、main.js がつないでいる、本体が動いている時)。像つきで録音を回す
  function liveBegin() {
    if (!cfg.liveRoll || !NesScreen.onLiveBegin || !(node || nes)) return;
    if (liveActive) liveEnd('restart');
    liveActive = true; liveBase = null;
    if (machine === 'msx') NesScreen.onLiveBegin({ chips: msxLiveChips(), fps: msxFps || 60, name: romName || 'MSX' });
    else NesScreen.onLiveBegin({ chips: chipNames(), fps: FPS, name: romName || 'NES' });
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
    if (machine === 'msx') {
      // 鍵盤表示の expansion の psg/scc/opll/opl/dac をそのまま本体へ(msxConsole.applyMix)
      const pickMsx = (cfgObj) => { if (!cfgObj || !cfgObj.expansion) return null; const e = cfgObj.expansion, o = {}; for (const k of ['psg', 'scc', 'opll', 'opl', 'dac']) if (e[k]) o[k] = e[k]; return o; };
      const mm = { type: 'mix', mute: pickMsx(lastMix.mute), volume: pickMsx(lastMix.volume) };
      if (node) node.port.postMessage(mm);
      else if (nes && typeof nes.applyMix === 'function') nes.applyMix(mm.mute, mm.volume);
      return;
    }
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
  function recFileName() { return (romName || machine).replace(/\.(nes|fds|rom|mx1|mx2|dsk)$/i, '') + '-rec.vgm'; }
  function toggleRecord() {
    if (recording) {
      recording = false;
      sendRecord(false, { keep: liveActive });
    } else {
      recording = true; recFrames = []; recBase = null; recVgm = null; recRaw = null; recStartMs = performance.now();
      sendRecord(true);
    }
    updateRecUi();
  }
  function finishRecording() {
    const frames = recFrames || [];
    recFrames = null; recBase = null;
    if (machine === 'msx') {
      // MSX の VGM 符号化(PSG 0xA0 / SCC 0xD2、50Hz の 882 サンプル wait、DESIGN-MSX-CAPTURE.md §5)は 7b。無ければ案内だけ出して保存/変換は出さない
      if (typeof MML.VGM.encodeMsxRecording !== 'function') {
        recRaw = null; recVgm = null; updateRecUi();
        recInfoEl.textContent = T('MSX の VGM 書き出しは次の段階(7b)'); recInfoEl.title = T('録音した {n} フレームの書き込み列は捨てました', { n: frames.length });
        return;
      }
      const r = MML.VGM.encodeMsxRecording({ frames, chips: msxChips, machine: msxMachine, name: (romName || 'MSX').replace(/\.(rom|mx1|mx2|dsk)$/i, ''), creator: 'Sound Emulation Foundry (MSX)' });
      recRaw = r.vgm; recVgm = r.vgm;
      recSfxChk.checked = !!cfg.sfxRemove; recLagChk.checked = !!cfg.lagFix;
      applyRecClean();
      updateRecUi();
      return;
    }
    const r = MML.VGM.encodeNesRecording({ frames, extBits: recExtBits, name: (romName || 'NES').replace(/\.nes$/i, ''), creator: 'Sound Emulation Foundry (NES)' });
    recRaw = r.vgm; recVgm = r.vgm;
    recSfxChk.checked = !!cfg.sfxRemove; recLagChk.checked = !!cfg.lagFix;
    applyRecClean();
    updateRecUi();
  }
  // 録音の補正: 生の録音に [効果音を除く][処理落ちを詰める] のチェックどおりの補正を掛け直す(保存と変換への両方がこの recVgm を使う)。
  // 補正した VGM には GD3 の notes に印を付け、MML 変換設定の同じ補正が重ねて掛からないようにする
  function applyRecClean() {
    if (!recRaw) return;
    const flags = { sfx: !!(recSfxChk && recSfxChk.checked), lag: !!(recLagChk && recLagChk.checked) };
    const rh = MML.VGM.parseHeader(recRaw), rspf = rh.rate === 50 ? 882 : 735; // MSX の 50Hz 録音は 882 サンプル/フレーム
    const frames = Math.round(rh.totalSamples / rspf);
    let text = T('録音: {sec} 秒({frames} フレーム、{kb} KB)', { sec: (frames * rspf / 44100).toFixed(1), frames, kb: (recRaw.length / 1024).toFixed(1) });
    let title = '';
    if ((flags.sfx || flags.lag) && MML.VGM.cleanCapture) {
      const marked = MML.VGM.setGd3Notes(recRaw, MML.VGM.cleanNoteOf(flags));
      const r = MML.VGM.cleanCapture(marked, flags);
      recVgm = r.bytes;
      const S = r.report.sfx, L = r.report.lag, parts = [];
      if (flags.sfx) parts.push(S && S.applied ? T('効果音 {n} フレーム置換', { n: S.replaced }) : T('効果音: 周期が見つからず何もせず'));
      if (flags.lag) parts.push(L && L.applied ? T('処理落ち {n} フレーム', { n: (L.removedRegular || 0) + (L.removedAlign || 0) }) : T('処理落ち: なし'));
      if (r.report.error) parts.push(T('補正できませんでした({msg})', { msg: r.report.error }));
      text += ' · ' + parts.join('、');
      title = MML.VGM.describeClean ? MML.VGM.describeClean(r.report).join('\n') : '';
    } else recVgm = recRaw;
    recInfoEl.textContent = text; recInfoEl.title = title;
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
    saveBtn.hidden = convBtn.hidden = recSfxChk.parentNode.hidden = recLagChk.parentNode.hidden = !recVgm;
    if (recording) recInfoEl.textContent = T('録音中…');
    if (!recording && !recVgm) recInfoEl.textContent = '';
    if (recording && !recTimer) recTimer = setInterval(() => { if (!recording) { clearInterval(recTimer); recTimer = 0; return; } recInfoEl.textContent = T('録音中: {sec} 秒', { sec: ((performance.now() - recStartMs) / 1000).toFixed(0) }); }, 500);
  }
  let recTimer = 0;

  // MSX の ROM を開く(open から。流れは NES と同じ: BIOS → 主スレッドで本体を作って検査 → Worklet(無理なら主スレッド実行))
  // ディスクで動いている MSX へ別の .dsk を入れる: 取り出し → 少し待って入れる(ゲームが「ディスクなし」を見てから)
  function swapMsxDisk(bytes, name) {
    const send = (side) => { if (node) node.port.postMessage({ type: 'disk', side }); else if (nes) { if (side < 0) nes.ejectDisk(); else nes.insertDisk(side); } };
    send(-1);
    if (sideTimer) clearTimeout(sideTimer);
    sideBtn.title = T('入れ替え中…');
    sideTimer = setTimeout(() => {
      sideTimer = 0;
      diskNames.push(name || ''); diskImages.push(bytes.slice());
      if (node) { const buf = bytes.slice().buffer; node.port.postMessage({ type: 'diskAdd', image: buf }, [buf]); }
      else if (nes) { const n = nes.addDisk(bytes); if (n >= 0) nes.insertDisk(n); fdsSides = nes.diskCount; fdsSide = n; if (rewindBuf) rewindBuf.clear(); updateDiskUi(); }
      flashStatus(T('ディスクを入れ替えました: {name}', { name }));
    }, 1500);
    return Promise.resolve(null);
  }
  async function openMsx(bytes, name, opt) {
    opt = opt || {};
    machine = 'msx'; pendingFds = null;
    updateBiosBtn(); updateSoftKbd();
    const mach = resolveMsxMachine();
    let bios = mach ? msxBiosFor(mach) : null;
    if (bios && opt.disk && !bios.disk) bios = null; // ディスクにはディスク ROM(16K、[BIOS] で控える)が要る
    if (!bios) {
      // BIOS が無い: 窓を開いて [BIOS] で選ばせ、選ばれたら開き直す(FDS と同じ)
      pendingMsx = { bytes, name };
      romName = name || ''; nameEl.textContent = romName; nameEl.title = ''; machineEl.textContent = '';
      win.style.display = 'flex';
      if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
      if (opt.disk) {
        // 何が控えてあって何が足りないかを出す(C-BIOS はディスクを起動できないので、実 BIOS のメイン+サブ+ディスク ROM の 3 つが要る)
        const st = loadMsxBios(mach || cfg.msx.machine || 'msx2') || {};
        const kinds = [['main', T('メイン 32K')], ['sub', T('サブ 16K')], ['disk', T('ディスク ROM 16K')]];
        const have = kinds.filter(([k]) => st[k]).map(([, l]) => l), miss = kinds.filter(([k]) => !st[k]).map(([, l]) => l);
        statusEl.textContent = T('ディスクの起動には実 BIOS が要ります(同梱 C-BIOS では起動できません)。⚙ の MSX タブで足りない物を選んでください: {miss}', { miss: miss.join(' / ') }) + (have.length ? ' ' + T('(控え済み: {have})', { have: have.join(' / ') }) : '');
      } else statusEl.textContent = T('⚙ の MSX タブで BIOS(メイン ROM 32K)を控えてください');
      return null;
    }
    pendingMsx = null;
    msxDisk = !!opt.disk;
    const key = romKey(bytes);
    const mapperType = opt.disk ? null : msxMapperFor(key); // null = 本体の判別に任せる
    const cartB = msxCartB();
    const romA = opt.disk ? null : bytes, disks = opt.disk ? [bytes].concat(opt.extraDisks || []) : []; // extraDisks: 同じ組の 2 枚目以降([disk] で選ぶ)
    diskNames = opt.disk ? [name || ''].concat(opt.extraNames || []) : []; fdsSideInfo = null;
    diskImages = disks.map((d) => d.slice()); diskDirty = new Set();
    const probe = new MML.Emu.MsxConsole(romA, { machine: mach, bios, mapperType: mapperType || undefined, cartB, disks, fdc: cfg.msx.fdc }); // マッパー未対応等は例外で知らせる
    liveEnd('restart');
    rewindHoldEnd();
    await flushBattery(); // 前の ROM(NES)のセーブを受け取ってから止める
    romBytes = bytes; romName = name || '';
    stateKey = key; msxMachine = mach;
    hasBattery = probe.hasBattery; batteryKey = hasBattery ? stateKey : ''; // SRAM/FM-PAC/RTC(7c)。NES と同じく IndexedDB に ROM のハッシュ別
    const battery = hasBattery ? await loadBattery(batteryKey) : null;
    if (battery && probe.setBattery(battery)) console.log('[msx]', T('セーブデータを読み込みました({n} バイト)', { n: battery.length }));
    // ブラウザ内保存から戻した画像は「書き込みあり(未書き戻し)」として扱う
    if (battery && probe.disk) probe.disk.images.forEach((im, i) => { const o = disks[i]; if (o && !(im.img.length === o.length && im.img.every((v, k) => v === o[k]))) { diskImages[i] = im.img.slice(); diskDirty.add(i); } });
    updateDiskBadge();
    nameEl.textContent = romName;
    nameEl.title = MML.Emu.MsxConsole.describe(probe); machineEl.textContent = (MSX_MACHINE_LABEL[mach] || 'MSX') + (probe.r800Active ? ' (R800)' : '') + (bios && bios.name && /C-BIOS/.test(bios.name) ? ' (C-BIOS)' : '');
    recExtBits = 0; msxChips = probe.chips(); msxFps = probe.frameRate || 60;
    fdsSides = probe.diskCount; fdsSide = 0; if (sideTimer) { clearTimeout(sideTimer); sideTimer = 0; } updateDiskUi();
    stopMain(); nes = null; rewindBuf = null;
    if (recording) { recording = false; recFrames = null; recBase = null; }
    recVgm = null; recRaw = null; updateRecUi();
    paused = false; setIcon(pauseBtn, 'pause'); pauseBtn.classList.remove('nes-paused'); acc = 0; fpsCount = 0; fpsMs = 0; frameSeq = 0;
    win.style.display = 'flex';
    if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
    const btn = document.querySelector('.toggle-btn[data-target="win-nes"]');
    if (btn) btn.classList.add('active');
    ensureCanvasSize(probe.frameWidth, probe.frameHeight);
    blitFrame(probe.frame);
    applyCfgLabels();
    const rom = romA ? romA.slice().buffer : null, tr = rom ? [rom] : [];
    const dmsg = disks.map((d) => d.slice().buffer); for (const b of dmsg) tr.push(b);
    const bmsg = { name: bios.name || null };
    for (const k of ['main', 'sub', 'logo', 'kanji', 'disk', 'kdr', 'music']) if (bios[k]) { bmsg[k] = bios[k].slice().buffer; tr.push(bmsg[k]); }
    const cbMsg = cartB ? { kind: cartB.kind, rom: cartB.rom ? cartB.rom.slice().buffer : null } : null;
    if (cbMsg && cbMsg.rom) tr.push(cbMsg.rom);
    const batMsg = battery ? battery.slice().buffer : null; if (batMsg) tr.push(batMsg);
    const ok = await startWorklet({ type: 'load', machine: 'msx', rom, battery: batMsg, msx: { machine: mach, mapperType: mapperType || null, bios: bmsg, cartB: cbMsg, disks: dmsg, fdc: cfg.msx.fdc } }, tr);
    if (!ok) { nes = probe; rewindBuf = MML.Emu.MsxRewind ? new MML.Emu.MsxRewind(nes) : null; lastPad = -1; lastPad2 = -1; mainFrames = 0; nes.setTurboRate(cfg.turboRate); startMain(); }
    liveBegin(); // ライブ表示(設定 ON なら。MSX は PSG/SCC/OPLL/Y8950/DAC の書き込み列を KSS 形式で鍵盤表示へ)
    updateStatus();
    canvas.focus();
    return ok ? null : nes;
  }

  // 中身の種類(imageDetect.js の kind)→ 開き方。iNES/FDS は open() の本体(NES)で開く
  const OPENERS = {
    'fds-bios': (bytes, name) => { storeFdsBiosFile(bytes, name); return null; }, // disksys.rom: 控えるだけ(.rom でも MSX にしない)
    'msx-rom': (bytes, name) => openMsx(bytes, name),
    'msx-dsk': (bytes, name) => (machine === 'msx' && msxDisk && !pendingMsx && (node || nes)) ? swapMsxDisk(bytes, name) : openMsx(bytes, name, { disk: true }), // 動いている MSX には足して入れ替え
  };
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
    // ROM を開く前でも窓の中身(開くアイコン等のヘッダ、案内)を組んでおく(main.js が起動時に呼ぶ)。ヘッドレス(main.js を読む)には canvas が無いので何もしない
    mount: () => (typeof ImageData === 'function' ? ensureDom() : false),
    // 機種の開き方を足す(kind は imageDetect.js の detect が返す物。将来の機種はここに登録すれば全経路に乗る)
    registerOpener(kind, fn) { OPENERS[kind] = fn; },
    _debug: { setDiskDir: (h) => { diskDirHandle = h; updateDiskBadge(); }, injectBattery: (blob) => handleBatteryBlob(blob), diskImage: (i) => currentDiskImage(i), dirty: () => Array.from(diskDirty), writeBack: () => writeBackDirty() },
    // 複数の画像をひとまとめに開く(zip の中のディスク組など): MSX の .dsk は全部同じドライブの組にして [disk] で選ぶ、
    // FDS の .fds が複数なら面を順に並べて 1 本に、それ以外は最初の 1 本
    async openSet(items, setName) {
      if (!ensureDom()) throw new Error('win-nes がありません');
      const I = MML.Emu.Image;
      const typed = items.map((it) => ({ bytes: it.bytes, name: it.name, img: I ? I.detect(it.bytes, it.name) : null }));
      const dsks = typed.filter((t) => t.img && t.img.kind === 'msx-dsk');
      if (dsks.length) return openMsx(dsks[0].bytes, dsks[0].name, { disk: true, extraDisks: dsks.slice(1).map((t) => t.bytes), extraNames: dsks.slice(1).map((t) => t.name) });
      const fds = typed.filter((t) => t.img && t.img.kind === 'fds');
      if (fds.length >= 2 && I) return NesScreen.open(I.combineFds(fds.map((t) => t.bytes)), setName || fds[0].name);
      const first = typed.find((t) => t.img && t.img.kind !== 'fds-bios') || typed[0];
      return first ? NesScreen.open(first.bytes, first.name) : null;
    },
    // ROM(iNES のバイト列)を読み込んで表示・開始する。失敗は例外(マッパー未対応など)
    async open(bytes, name) {
      if (!ensureDom()) throw new Error('win-nes がありません');
      // 中身で見分けて(MML.Emu.Image、imageDetect.js)、開き方の表で振り分ける。表に無い物(iNES/FDS/不明)はこの下の NES の経路
      const img = MML.Emu.Image && MML.Emu.Image.detect ? MML.Emu.Image.detect(bytes, name) : null;
      if (img && OPENERS[img.kind]) return OPENERS[img.kind](bytes, name, img);
      machine = 'nes'; pendingMsx = null; msxChips = []; msxDisk = false;
      const isFds = !!(MML.Emu.FdsDisk && MML.Emu.FdsDisk.isFds(bytes));
      updateBiosBtn(); updateSoftKbd();
      if (isFds && !loadBios()) {
        // BIOS が無い: 窓を開いて選ばせ、選ばれたら開き直す
        pendingFds = { bytes, name };
        romName = name || ''; nameEl.textContent = romName; nameEl.title = ''; machineEl.textContent = '';
        win.style.display = 'flex';
        if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
        statusEl.textContent = T('⚙ のファミコンタブで FDS の BIOS(disksys.rom)を控えてください');
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
      machineEl.textContent = isFds ? T('ディスクシステム') : T('ファミコン');
      nameEl.textContent = romName;
      nameEl.title = MML.Emu.INES.describe(probe.rom);
      recExtBits = probe.extBits();
      fdsSideInfo = probe.rom && probe.rom.fds && probe.rom.headers ? probe.rom.headers.map((h) => ({ side: h[0x14], disk: h[0x15] })) : null; diskNames = []; // FDS のヘッダ: $15 面(0=A)、$16 枚数(0 始まり)。headers は $01 から
      fdsSides = probe.diskCount; fdsSide = 0; if (sideTimer) { clearTimeout(sideTimer); sideTimer = 0; } updateDiskUi();
      stopMain(); nes = null; rewindBuf = null;
      if (recording) { recording = false; recFrames = null; recBase = null; }
      recVgm = null; recRaw = null; updateRecUi();
      paused = false; setIcon(pauseBtn, 'pause'); pauseBtn.classList.remove('nes-paused'); acc = 0; fpsCount = 0; fpsMs = 0; frameSeq = 0;
      win.style.display = 'flex';
      if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-nes');
      const btn = document.querySelector('.toggle-btn[data-target="win-nes"]');
      if (btn) btn.classList.add('active');
      ensureCanvasSize(256, 240);
      blitFrame(probe.frame);
      applyCfgLabels();
      const rom = bytes.slice().buffer;
      const bios = fdsBios ? fdsBios.slice().buffer : null;
      const bat = battery ? battery.slice().buffer : null;
      const ok = await startWorklet({ type: 'load', rom, bios, battery: bat }, [rom, bios, bat].filter(Boolean));
      if (!ok) { nes = probe; rewindBuf = MML.Emu.NesRewind ? new MML.Emu.NesRewind(nes) : null; lastPad = -1; lastPad2 = -1; mainFrames = 0; nes.setTurboRate(cfg.turboRate); startMain(); }
      liveBegin();
      updateStatus();
      canvas.focus();
      return ok ? null : nes;
    },
    async close() {
      liveEnd('end');
      rewindHoldEnd();
      if (nes && hasBattery && nes.batteryDirty) { handleBatteryBlob(nes.getBattery()); nes.clearBatteryDirty(); }
      await flushBattery();
      stopMain(); stopWorkletNode(); nes = null; rewindBuf = null;
    },
    get console() { return nes; },
    get machine() { return machine; },   // 'nes' | 'msx'
    get running() { return !!(node || (nes && raf)); },
    get usingWorklet() { return !!node; },
    get stats() { return { frameSeq, underruns, fps, liveBase, machine, frameW, frameH }; },
    get audioNodes() { return { ctx: actx, node, gain, limiter }; }, // 検証用(音が出ているかを外から測る)
    get live() { return liveActive; },
    get config() { return cfg; },
  };
  UI.NesScreen = NesScreen;
})(typeof window !== 'undefined' ? window : globalThis);
