/*
 * チャンネル別鍵盤表示ウィジェット (ミュート統合版)
 * MML.UI.KeyboardDisplay
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  const CPU_CLOCK = 1789773;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // canvasはCSSを継承しないので、style.cssの --sans / --mono を実行時に読んでフォント指定に使う。
  // 総称ファミリ(sans-serif/monospace)任せだと日本語フォント未導入の環境で豆腐(□)になり、
  // 中国語ロケールでは漢字が簡体字の字形で描かれる(canvasにはlang属性が効かない)。
  let _fontStacks = null;
  function fontStack(kind) {
    if (!_fontStacks) {
      const cs = getComputedStyle(document.documentElement);
      const pick = (name, fallback) =>
        (cs.getPropertyValue(name) || '').replace(/\s+/g, ' ').trim() || fallback;
      _fontStacks = {
        sans: pick('--sans', 'sans-serif'),
        mono: pick('--mono', 'monospace'),
      };
    }
    return _fontStacks[kind];
  }

  const MIDI_MIN = 24;
  const MIDI_MAX = 108;
  const TOTAL_WHITE = 50;

  // ピアノロールの時間軸スケール(px/秒)。先読み時間幅(秒)は「時間軸の長さ(px)÷この値」で
  // 決まる(=ロールが長いほど遠い未来まで見える)。従来の固定値(高さ320px/4秒)と同じ80px/秒。
  const ROLL_PX_PER_SEC = 80;

  // ピアノロールcanvasの高さ(ロールを一覧の下に置く配置のとき)。style.cssの .kbd-roll { height }
  // と必ず一致させること(折りたたみ時にウィンドウ高さをこの値ぶん増減させるため、
  // ズレると鍵盤の位置がずれる)。
  const ROLL_CANVAS_HEIGHT = 320;
  const MIN_WINDOW_HEIGHT = 160;
  // 鍵盤canvasの「鍵の長さ」方向のpx数(縦向きロール=鍵盤の高さ、横向きロール=鍵盤の幅)。
  // style.cssの .kbd-piano-wrap { height } / .kbd-roll-wrap--horizontal .kbd-piano-wrap { width } と一致させること。
  const PIANO_KEY_LEN = 68;
  // SPCボイス一覧(mute/ch/L/R/vol/env/wave/PM/note/freq/echo)の全列が収まる一覧幅。
  // style.cssの .kbd-left.kbd-left--spc { width } と一致させること
  const SPC_LIST_MIN_WIDTH = 500;

  // ── 鍵盤表示レイアウト設定 ────────────────────────────────────
  // rollOrientation: 'vertical'  = Synthesia式(音程=横軸、音符が上から鍵盤へ降る。鍵盤は下)
  //                  'horizontal'= DAW式(音程=縦軸、音符が右から鍵盤へ流れる。鍵盤は左)
  // rollPlacement:   'bottom' = チャンネル一覧の下 / 'right' = 一覧の右 / 'window' = 別ウィンドウ
  // listColumns:     'single' = 1列 / 'auto' = 幅に応じて自動多段
  // rollLanes:       'all' = 全チャンネルを1つの鍵盤/ロールに重ねて表示
  //                  'perChannel' = 使用チャンネルごとに鍵盤+ロールのレーンを並べる(縦向き=横に並ぶ、
  //                                 横向き=縦に積む。収まらない分はスクロール)
  // 既定値は従来の見た目(縦・下・1列・まとめて)。localStorageに永続化する。
  const LAYOUT_STORAGE_KEY = 'mml_keyboardLayout_v1';
  const LAYOUT_DEFAULTS = Object.freeze({ rollOrientation: 'vertical', rollPlacement: 'bottom', listColumns: 'single', rollLanes: 'all' });
  const LAYOUT_CHOICES = Object.freeze({
    rollOrientation: ['vertical', 'horizontal'],
    rollPlacement: ['bottom', 'right', 'window'],
    listColumns: ['single', 'auto'],
    rollLanes: ['all', 'perChannel'],
  });
  // チャンネルごとのレーン: 鍵盤全体(50白鍵)ではなく、白鍵LANE_VISIBLE_WHITE個ぶん(≈1.4オクターブ)の
  // 音程窓だけを表示し、そのchの音符が窓からはみ出しそうなら音程方向に自動スクロールして追従する
  // (_updateLaneScroll参照)。LANE_MIN_PXはレーンの音程軸方向の最小px(縦向き=幅、横向き=高さ)で、
  // 1白鍵≈15px。style.cssの.kbd-laneの値と一致させること
  const LANE_VISIBLE_WHITE = 10;
  const LANE_MIN_PX = 150;
  // 自動スクロールの余白(白鍵単位)と追従の速さ(1フレームあたり残差のこの割合だけ寄せる)
  const LANE_SCROLL_MARGIN = 1;
  const LANE_SCROLL_EASE = 0.15;
  function loadLayoutSettings() {
    const out = Object.assign({}, LAYOUT_DEFAULTS);
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(LAYOUT_DEFAULTS)) {
          if (LAYOUT_CHOICES[k].includes(raw[k])) out[k] = raw[k];
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function saveLayoutSettings(s) {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // ── ロール/鍵盤の座標系 ───────────────────────────────────────
  // ロールと鍵盤は「音程軸(p)」と「時間軸(t)」の2軸で描き、向き(orientation)に応じて
  // canvasのx/yへ写像する。描画ルーチン側は向きを意識せずp/tだけで書けるようにするための抽象。
  //   p: 0(最低音側の端) → pitchLen(最高音側の端)。keyX()と同じ単位(白鍵1本=wk px)
  //   t: 0(現在=鍵盤に接する端) → timeLen(先読みの果て)
  //   vertical  : p→x(左→右)、t→y(下→上)   … 音符が上から降ってくる
  //   horizontal: p→y(下→上)、t→x(左→右)   … 音符が右から流れてくる
  // 縦向きの写像は従来実装と同じ式(H - t)になるよう書いてあり、丸めまで含めて描画結果は不変。
  // visibleWhite: 音程軸に収める白鍵の本数(省略=鍵盤全体TOTAL_WHITE。チャンネルごとのレーンは
  // LANE_VISIBLE_WHITEで、表示窓の左端(低音側)の白鍵位置offsetPxは呼び出し側がkeyX()の結果から引く)
  function makeRollGeom(orientation, W, H, visibleWhite) {
    const vertical = orientation !== 'horizontal';
    const pitchLen = vertical ? W : H;
    const timeLen = vertical ? H : W;
    const wk = pitchLen / (visibleWhite || TOTAL_WHITE);
    const bk = Math.max(3, wk * 0.60);
    // 先読み時間幅(秒)と、秒→時間軸pxの変換。時間軸320pxのとき従来通り4秒/80px/秒になる
    const windowSec = timeLen / ROLL_PX_PER_SEC;
    const tPx = (sec) => (sec / windowSec) * timeLen;
    return {
      vertical, W, H, pitchLen, timeLen, wk, bk, windowSec, tPx,
      // 音程軸[pLo, pLo+pSize) × 時間軸[tLo, tHi) の矩形をcanvas座標{x,y,w,h}へ。
      // minT: 時間軸方向の最小サイズ(px)。短い音符も見えるように下限を設ける用途
      rect(pLo, pSize, tLo, tHi, minT) {
        if (vertical) {
          const y0 = H - tHi, y1 = H - tLo;
          return { x: pLo, y: y0, w: pSize, h: Math.max(minT || 0, y1 - y0) };
        }
        return { x: tLo, y: H - pLo - pSize, w: Math.max(minT || 0, tHi - tLo), h: pSize };
      },
      // 点(p, t) → canvas座標
      point(p, t) { return vertical ? { x: p, y: H - t } : { x: t, y: H - p }; },
    };
  }

  const WHITE_IDX = [0,-1,1,-1,2,3,-1,4,-1,5,-1,6];
  const IS_BLACK   = [0, 1,0, 1,0,0, 1,0, 1,0, 1,0];

  // APU パルスのデューティ比 (High 区間の割合): 12.5% / 25% / 50% / 75%
  const APU_DUTY = [0.125, 0.25, 0.5, 0.75];

  // ノイズ周期テーブル（$400E bits0-3 → LFSRシフト間のCPU待機サイクル数, NTSC）
  // ノイズ周波数 = CPU_CLOCK / NOISE_PERIOD[index]（idx0≈447kHz … idx15≈440Hz）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // GBノイズの実測周波数(c.freq、256通りのclockShift×divisorCode)を、既存の2A03ノイズ
  // 16周期のうち対数距離で最も近いものにマッチさせた素のindex(0-15)に変換する
  // (gbs2mml/expansion/noise.jsのgbNoiseFreqToNote()と同じ考え方だが、MMLノート番号
  // ではなく鍵盤表示のnote列にそのまま出す周期indexが欲しいだけなので31-idxはしない)。
  function gbNoiseFreqToIndex(freqHz) {
    if (!freqHz) return 0;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NOISE_PERIOD.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / (CPU_CLOCK / NOISE_PERIOD[i])));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  // DMC(DPCM)レートテーブル（$4010 bits0-3 → サンプル1bitあたりのCPUサイクル数, NTSC）
  // 再生周波数 = CPU_CLOCK / DMC_RATE[index]（idx0≈4182Hz … idx15≈33144Hz）
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  // ── チャンネル色のユーザーカスタマイズ ────────────────────────
  // 鍵盤左上のチャンネル一覧の丸(kbd-dot)クリックで選べる色一覧、
  // および localStorage への保存/読込。ロール・鍵盤・波形表示すべてがこの
  // 上書き色を参照するため、変更は即座に全表示へ反映される。
  const CHANNEL_COLOR_STORAGE_KEY = 'mml_channelColors';

  function loadColorOverrides() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(CHANNEL_COLOR_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const id in obj) map.set(id, obj[id]);
      }
    } catch (e) { /* ignore */ }
    return map;
  }

  function saveColorOverrides(map) {
    try {
      const obj = {};
      for (const [id, color] of map) obj[id] = color;
      localStorage.setItem(CHANNEL_COLOR_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  // ── マスター音量 ──────────────────────────────────────────
  // src/audio/stream-player.js MML.Audio.getMasterGain() と同じキー/値域(0〜1)。
  // 音声グラフ側(getMasterGain)も新規AudioContext生成時にこの値を読むため、
  // どちらが先にロードされても一致する。
  const MASTER_VOLUME_STORAGE_KEY = 'mml_masterVolume';
  function loadMasterVolume() {
    try {
      const raw = parseFloat(localStorage.getItem(MASTER_VOLUME_STORAGE_KEY));
      if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
    } catch (e) { /* ignore */ }
    return 1;
  }
  function saveMasterVolume(vol) {
    try { localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, String(vol)); } catch (e) { /* ignore */ }
  }

  // ── ch別音量(通常フォーマット: channelId → 0〜1) ─────────────────
  // 色オーバーライドと同じ流儀(localStorage永続化、新規ファイルを開いても保持=
  // ミュートのようなファイル切替時クリアはしない。音量調整は「一度決めたら
  // ずっと使う」EQ的な設定なので、ファイルをまたいで残ってほしいという想定)。
  const CHANNEL_VOLUME_STORAGE_KEY = 'mml_channelVolumes';
  function loadChannelVolumes() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(CHANNEL_VOLUME_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const id in obj) {
          const v = parseFloat(obj[id]);
          if (Number.isFinite(v)) map.set(id, Math.max(0, Math.min(1, v)));
        }
      }
    } catch (e) { /* ignore */ }
    return map;
  }
  function saveChannelVolumes(map) {
    try {
      const obj = {};
      for (const [id, vol] of map) obj[id] = vol;
      localStorage.setItem(CHANNEL_VOLUME_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  // ── SPCボイス音量(V0〜V7、配列index=ボイス番号) ─────────────────
  const SPC_VOLUME_STORAGE_KEY = 'mml_spcVoiceVolumes';
  function loadSpcVoiceVolumes() {
    try {
      const raw = JSON.parse(localStorage.getItem(SPC_VOLUME_STORAGE_KEY) || 'null');
      if (Array.isArray(raw) && raw.length === 8) {
        return raw.map((v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; });
      }
    } catch (e) { /* ignore */ }
    return new Array(8).fill(1);
  }
  function saveSpcVoiceVolumes(arr) {
    try { localStorage.setItem(SPC_VOLUME_STORAGE_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }

  // ── 静的ミュートパス定義 ──────────────────────────────────────
  const MUTE_INFO_MAP = {
    P1:   { section: 'apu', key: 'pulse1' },
    P2:   { section: 'apu', key: 'pulse2' },
    TR:   { section: 'apu', key: 'triangle' },
    NO:   { section: 'apu', key: 'noise' },
    DM:   { section: 'apu', key: 'dmc' },
    V6P1: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'pulse1' },
    V6P2: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'pulse2' },
    V6SW: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'saw' },
    FDS:  { section: 'expansion', chip: 'fds',  type: 'object', key: 'wave' },
    M5P1: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pulse1' },
    M5P2: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pulse2' },
    M5PC: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pcm' },
    GB1:  { section: 'expansion', chip: 'gb', type: 'object', key: 'ch1' },
    GB2:  { section: 'expansion', chip: 'gb', type: 'object', key: 'ch2' },
    GN:   { section: 'expansion', chip: 'gb', type: 'object', key: 'ch4' },
    GW:   { section: 'expansion', chip: 'gb', type: 'object', key: 'ch3' },
    PSG0: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch0' },
    PSG1: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch1' },
    PSG2: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch2' },
    PSG3: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch3' },
    PSG4: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch4' },
    PSG5: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch5' },
  };

  // リズムch: BD=ch6, SD/HH=ch7, TOM/CYM=ch8 (chip.mute[]がch単位のため同chの打楽器は連動ミュート)
  const KF_RHYTHM_INDEX = { KFBD: 6, KFSD: 7, KFHH: 7, KFTOM: 8, KFCYM: 8 };

  function getMuteInfo(id) {
    if (MUTE_INFO_MAP[id]) return MUTE_INFO_MAP[id];
    const vrc7 = id.match(/^VR(\d+)$/);
    if (vrc7) return { section: 'expansion', chip: 'vrc7', type: 'array', index: +vrc7[1] - 1 };
    // N163: 表示 N{k} はハードウェアch (8-k)。N1=$78(ch7), N8=$40(ch0)。
    // chip.mute[] はハードch索引なので index にハードch番号を返す(表示行→muteの対応を一致させる)。
    const n163 = id.match(/^N(\d+)$/);
    if (n163) return { section: 'expansion', chip: 'n163', type: 'array', index: 8 - (+n163[1]) };
    const fme7 = id.match(/^FE(\d+)$/);
    if (fme7) return { section: 'expansion', chip: 'fme7', type: 'array', index: +fme7[1] - 1 };
    // KSS: PSG(KP1-3)/SCC(KS1-5)/FMPAC(KF1-9、リズムモード中はKFBD/KFSD/KFTOM/KFCYM/KFHH)
    const kp = id.match(/^KP(\d+)$/);
    if (kp) return { section: 'expansion', chip: 'psg', type: 'array', index: +kp[1] - 1 };
    const ks = id.match(/^KS(\d+)$/);
    if (ks) return { section: 'expansion', chip: 'scc', type: 'array', index: +ks[1] - 1 };
    const kf = id.match(/^KF(\d+)$/);
    if (kf) return { section: 'expansion', chip: 'opll', type: 'array', index: +kf[1] - 1 };
    // VGM: SN76489(SN1-3=トーン, SNN=ノイズ)。chip.mute[]はトーン0-2,ノイズ3の4要素
    // VGMのデュアルチップ(2個目)はSN4-6/SNN2=index 4-7(vgmPlayer.js側が2個目のch0-3として読む)
    const sn = id.match(/^SN(\d)$/);
    if (sn) return { section: 'expansion', chip: 'sn76489', type: 'array', index: +sn[1] <= 3 ? +sn[1] - 1 : +sn[1] };
    if (id === 'SNN') return { section: 'expansion', chip: 'sn76489', type: 'array', index: 3 };
    if (id === 'SNN2') return { section: 'expansion', chip: 'sn76489', type: 'array', index: 7 };
    // VGM: YM2612(YM1-6=FM ch、YMDA=DAC)。chip.mute[]はFM 0-5、DAC 6
    const ym = id.match(/^YM(\d)$/);
    if (ym) return { section: 'expansion', chip: 'ym2612', type: 'array', index: +ym[1] - 1 };
    if (id === 'YMDA') return { section: 'expansion', chip: 'ym2612', type: 'array', index: 6 };
    // VGM: 32X PWM(PWL/PWR)。chip.mute[]は L=0, R=1
    if (id === 'PWL') return { section: 'expansion', chip: 'pwm', type: 'array', index: 0 };
    if (id === 'PWR') return { section: 'expansion', chip: 'pwm', type: 'array', index: 1 };
    if (KF_RHYTHM_INDEX[id] !== undefined) return { section: 'expansion', chip: 'opll', type: 'array', index: KF_RHYTHM_INDEX[id] };
    return null;
  }

  // ── チップ名見出し + 短縮ch名 ──────────────────────────────────
  // ch.id(P1/VR3/N5など内部識別子)はチップごとに命名規則がバラバラで一覧性が
  // 低いため、表示上はチップ名を見出し行として挟み、行側は見出し配下で完結する
  // 短い名前(P1/FM3/W5など)にする。ch.id自体は変更しない(ミュート状態のキー・
  // getPartLetterのパターンマッチ・大波形選択などが全てch.id前提のため)。
  // 完全一致(ids)を先に見て、無ければ前方一致(prefix)にフォールバックする
  // (例: 'NO'は2A03グループの完全一致で先に拾われ、N163のprefix:'N'とは衝突しない)。
  const CHANNEL_DISPLAY_GROUPS = [
    { header: 'RP2A03 (Family Computer / Nintendo Entertainment System)', ids: { P1: 'P1', P2: 'P2', TR: 'Tri', NO: 'No', DM: 'DPCM' } },
    { header: 'RP2C33 (Family Computer Disk System)', ids: { FDS: 'FDS' } },
    { header: 'VRC6 (Virtual Rom Controller 6)', ids: { V6P1: 'P1', V6P2: 'P2', V6SW: 'Saw' } },
    { header: 'VRC7 (Virtual Rom Controller 7)', prefix: 'VR', name: (id) => 'FM' + id.slice(2) },
    { header: 'N163 (Namco 163)', prefix: 'N', name: (id) => 'W' + id.slice(1) },
    { header: 'SUNSOFT5B (FME-7 , YM2149)', ids: { FE1: 'P1', FE2: 'P2', FE3: 'P3' } },
    { header: 'MMC5 (Memory Management Controller 5)', ids: { M5P1: 'P1', M5P2: 'P2', M5PC: 'PCM' } },
    { header: 'YM2149 (Software controlled Sound Generator)', ids: { KP1: 'P1', KP2: 'P2', KP3: 'P3', KP4: 'P1(2)', KP5: 'P2(2)', KP6: 'P3(2)' } },
    { header: 'SCC (Sound Creative Chip)', prefix: 'KS', name: (id) => 'W' + id.slice(2) },
    { header: 'YM2413 (MSX-MUSIC , OPLL)', ids: { KFBD: 'BD', KFSD: 'SD', KFTOM: 'Tom', KFCYM: 'Cym', KFHH: 'HH' }, prefix: 'KF', name: (id) => 'FM' + id.slice(2) },
    { header: 'LR35902 (Game Boy)', ids: { GALL: 'ALL', GB1: 'P1', GB2: 'P2', GN: 'No', GW: 'Wave' } },
    { header: 'HuC6280(PC Engine / TurboGrafx-16)', ids: { HALL: 'ALL', PSG0: 'Ch0', PSG1: 'Ch1', PSG2: 'Ch2', PSG3: 'Ch3', PSG4: 'Ch4', PSG5: 'Ch5' } },
    { header: 'SN76489 (SG-1000 / Master System / Game Gear / Mega Drive PSG)', ids: { SN1: 'P1', SN2: 'P2', SN3: 'P3', SNN: 'No', SN4: 'P1(2)', SN5: 'P2(2)', SN6: 'P3(2)', SNN2: 'No(2)' } },
    { header: 'YM2612 (OPN2 , Mega Drive FM)', ids: { YMDA: 'DAC' }, prefix: 'YM', name: (id) => 'FM' + id.slice(2) },
    { header: 'PWM (Sega 32X)', ids: { PWL: 'L', PWR: 'R' } },
  ];
  function getChannelDisplay(id) {
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.ids && g.ids[id]) return { header: g.header, name: g.ids[id] };
    }
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.prefix && id.startsWith(g.prefix)) return { header: g.header, name: g.name(id) };
    }
    return { header: '', name: id };
  }

  // ── MMLパート文字(A-Z,a,b)の算出 ──────────────────────────────
  // 実際のMML変換(nsf2mml/kss2mml)が振るチャンネル文字を鍵盤表示にも出す。
  // 2A03固定4ch=A-D、DPCM=E(未使用でも常にこのスロット)、拡張音源以降は
  // src/mml/compiler.jsのassignExpansionLettersで機種に関わらず完全固定。
  // GB1/GB2/GNは2A03コア(自チップ、拡張音源宣言不要)を借用するのでA/B/Dに固定
  // (src/gbs2mml/converter.js参照。GBのCH1/CH2/CH4はそのままNESパルス1/2/ノイズへ乗る)。
  // SN76489(VGM)のノイズchも2A03ノイズ(D)へ借用する(vgm2mml、ROADMAP VGM節 段階3)。
  const APU_PART_LETTER = { P1: 'A', P2: 'B', TR: 'C', NO: 'D', DM: 'E', GB1: 'A', GB2: 'B', GN: 'D', SNN: 'D' };

  // chips(内部chip名の配列)をassignExpansionLettersが受け取る拡張音源名に変換する。
  // KSSはPSG→FME-7・SCC→N163・FMPAC→VRC7、GBSは波形ch→FDS(実機較正済みの音量バランスを
  // 持つため、当初のN163から変更した。src/gbs2mml/expansion/wave.js冒頭コメント参照)を
  // 借用して再生するため(src/kss2mml/converter.js・src/gbs2mml/converter.js参照)、
  // レター体系もそれらをそのまま流用する。
  const BORROWED_CHIP_TO_EXPANSION = { kssPsg: 'fme7', kssScc: 'n163', kssOpll: 'vrc7', gbs: 'fds', hes: 'n163', sn76489: 'fme7' };
  function chipsToExpansions(chips) {
    const priority = MML.Mml && MML.Mml.EXPANSION_PRIORITY;
    const set = new Set();
    for (const c of chips) {
      const exp = BORROWED_CHIP_TO_EXPANSION[c] || c;
      if (priority && priority.includes(exp)) set.add(exp);
    }
    return Array.from(set);
  }

  // ch.id → MMLパート文字。letterMapはassignExpansionLettersの戻り値
  // ({ チップ名: [割当文字...] })。該当なし(対応するMML文字を持たないチャンネル、
  // 例: MMC5の$5011直接PCM)は空文字を返す。
  function getPartLetter(id, letterMap, n163NumCh) {
    if (APU_PART_LETTER[id]) return APU_PART_LETTER[id];
    const lm = letterMap || {};
    let m;
    if (id === 'FDS') return (lm.fds || [])[0] || '';
    if ((m = id.match(/^V6(P1|P2|SW)$/))) return (lm.vrc6 || [])[{ P1: 0, P2: 1, SW: 2 }[m[1]]] || '';
    if ((m = id.match(/^M5(P1|P2)$/))) return (lm.mmc5 || [])[{ P1: 0, P2: 1 }[m[1]]] || '';
    if (id === 'M5PC') return ''; // $5011直接PCMはppmckのMML文字を持たない
    if ((m = id.match(/^VR(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^FE(\d+)$/))) return (lm.fme7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^N(\d+)$/))) {
      // 表示N{k}はハードウェアch(8-k)。MML文字は下位アドレス側(ch0)から順に振られる
      // (src/nsf2mml/expansion/n163.js参照)ため、曲全体の有効ch数numChに対し文字indexはnumCh-k。
      // numChは静的なletterMap.n163.length(常に8)ではなく、実際にこの曲で使われているch数
      // (extractChannelsのnumRows、呼び出し側から渡される)を使う必要がある。
      const letters = lm.n163 || [];
      const numCh = n163NumCh || letters.length || 8;
      return letters[numCh - (+m[1])] || '';
    }
    if ((m = id.match(/^KP(\d+)$/))) return (lm.fme7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^SN(\d)$/))) return (lm.fme7 || [])[+m[1] - 1] || ''; // SN76489トーン3本→FME7(vgm2mml)
    if ((m = id.match(/^KS(\d+)$/))) return (lm.n163 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^KF(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if (id === 'GW') return (lm.fds || [])[0] || ''; // GBの波形chはFDS(1ch)を借用(src/gbs2mml/converter.js参照)
    // HESのPSG ch0-5はN163へ直接(反転無し)の順で借用する(src/hes2mml/converter.js参照。
    // N163実機のアドレッシングに基づく反転(上のKS/N163ケース)とは異なる独自の割当規則)。
    if ((m = id.match(/^PSG(\d)$/))) return (lm.n163 || [])[+m[1]] || '';
    if (KF_RHYTHM_INDEX[id] !== undefined) return (lm.vrc7 || [])[KF_RHYTHM_INDEX[id]] || '';
    return '';
  }

  // ── 周波数 / MIDI 変換 ────────────────────────────────────────

  function freqToMidi(f) {
    if (!f || f <= 0) return null;
    const m = Math.round(69 + 12 * Math.log2(f / 440));
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
  }

  // ノイズchの周期index(ch.noiseIndex、0〜15。NSF/GBSどちらも同じ2A03の16段階スケールへ
  // 揃えている)を、そのままC1(MIDI 24)〜D#2(MIDI 39)の16音に1:1対応させる(ユーザー指定)。
  function noisePeriodIndexToMidi(idx) {
    if (idx === undefined || idx === null) return null;
    return 24 + Math.max(0, Math.min(15, idx)); // idx0=C1 〜 idx15=D#2
  }

  // DPCM($4010再生速度index、ch.dmcRateIdx、0〜15)もノイズと同じC1〜D#2に1:1対応させる
  // (ユーザー指定: ノイズchとバンドが重なってよい)。
  function dmcRateIndexToMidi(idx) {
    if (idx === undefined || idx === null) return null;
    return 24 + Math.max(0, Math.min(15, idx)); // idx0=C1 〜 idx15=D#2(ノイズと同じ)
  }

  // セント偏差オーバーレイ(DESIGN-PITCH.md Phase 0)用。丸め後のMIDIノート番号の
  // 理論周波数からのズレをセントで返す(detune.jsの cents=1200*log2(raw/ideal) と同じ式)。
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // セント偏差オーバーレイの線色をノート帯の色に合わせて自動で切り替えるための輝度計算。
  // チャンネル色はhex('#66ddff')/hsl(...)/ユーザーのカラーピッカー選択色など形式が混在するため、
  // 自前でパースせず1x1canvasにfillして実際に描画されるRGBを読み戻す(どんな形式でも
  // ブラウザ自身のCSS色パーサーに任せられる)。同じ色文字列を毎フレーム読み戻すのは
  // 無駄なのでキャッシュする(色は基本的にユーザーが変更した時だけ変わる)。
  const _lumCache = new Map();
  let _lumProbeCtx = null;
  function relativeLuminance(colorStr) {
    if (_lumCache.has(colorStr)) return _lumCache.get(colorStr);
    if (!_lumProbeCtx) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      _lumProbeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    _lumProbeCtx.fillStyle = colorStr;
    _lumProbeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = _lumProbeCtx.getImageData(0, 0, 1, 1).data;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    _lumCache.set(colorStr, lum);
    return lum;
  }
  // 明るい帯(輝度0.55超)には暗い線、暗い帯には白い線を重ねてコントラストを確保する。
  // ★暗い線側は純黒(0,0,0)にすると、偏差が帯からはみ出てロール背景(#14141a、
  // 輝度8%程度とほぼ黒)に重なった瞬間アルファ合成の結果もほぼ黒のまま=見えなくなる
  // (黒を黒に重ねてもアルファ値に関わらず黒のまま、という合成の性質による)。
  // ★中間グレーへ変更したところ、白鍵境界のグリッド線(#3d3d4a、無彩色の青灰色)と
  // 色味が近く紛らわしいとの指摘。無彩色同士の衝突を避けるため彩度のある暖色(赤系)にする。
  // 黄色/橙は明るい帯の既定色候補(黄色いチャンネル色等)と被って見えにくくなりうるため避け、
  // 赤系(色相環上で黄色から離れている)を選ぶ。
  function overlayLineColor(bgColorStr) {
    return relativeLuminance(bgColorStr) > 0.55 ? 'rgba(214,69,65,0.9)' : 'rgba(255,255,255,0.85)';
  }

  function midiToName(m) {
    return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  }

  // ── APU 2A03 周波数計算 ───────────────────────────────────────

  function pulseFreq(lo, hi3) {
    const p = lo | ((hi3 & 7) << 8);
    return p >= 8 ? CPU_CLOCK / (16 * (p + 1)) : 0;
  }

  function pulseVol(reg0) {
    return (reg0 & 0x10) ? (reg0 & 0xF) / 15 : ((reg0 & 0xF) > 0 ? 1 : 0);
  }

  function pulseActive(reg0) {
    if (reg0 & 0x10) return (reg0 & 0xF) > 0;
    return true;
  }

  // NESの非線形 tnd ミキサー近似 (apu2a03.js の mixSample() と同じ式)。
  // triangle/noise/dmc は単純加算ではなくこの共有ミキサーを通るため、
  // 一方の出力レベルが上がるともう一方の相対的な聞こえ方が変化する。
  function tndOut(tri, noi, dmc) {
    const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
    return tndSum > 0 ? 159.79 / (1 / tndSum + 100) : 0;
  }

  // ── チャンネル状態抽出 ────────────────────────────────────────

  function extractChannels(snap, extraSnaps, frameIdx, chips) {
    const channels = [];
    let n163NumRows = null; // MMLパート文字算出用(N163のnumChはgetPartLetterのフォールバックでは分からない)
    snap = snap || {};
    const status = snap[0x4015] || 0;
    // このフレームのAPUエンベロープ実出力。ライブ関数優先→静的配列→無ければレジスタ直読みにフォールバック。
    let apuEnv = null;
    if (extraSnaps) {
      if (extraSnaps.apuEnvLive) apuEnv = extraSnaps.apuEnvLive();
      if (!apuEnv && extraSnaps.apuEnv) apuEnv = extraSnaps.apuEnv[frameIdx];
    }

    // KSS(MSX)/GBS(Game Boy)/HES(PC Engine)再生中はNES内蔵チャンネル(2A03)を表示しない
    // (KSSはPSG/SCC/FMPACのみ、GBSはGB1/GB2/GN/GWのみ、HESはPSG0-5のみを表示する)。
    const isKss = chips.includes('kss');
    const isGbs = chips.includes('gbs');
    const isHes = chips.includes('hes');
    // VGMはヘッダで使うチップが決まる: NES APUを含まないVGM(MSX/GB/PCE系)では2A03行を出さない
    // (main.js側が chips に 'vgm' と、NES APU使用時のみ 'nes' を入れる)。
    const isVgmNoNes = chips.includes('vgm') && !chips.includes('nes');
    if (!isKss && !isGbs && !isHes && !isVgmNoNes) {
    // 2A03パルスのスイープユニット強制ミュート(emulator apu2a03.js PulseChannel.isMuted /
    // nsf2mml converter.js extractPulseEventsと同じ規則): 周期<8 または目標周期>$7FF
    // (特に$4001/$4005=$00のまま周期$400以上=o2a以下)は実際には鳴らないので非アクティブ表示
    const pulseSweepMuted = (sweepReg, period, isPulse1) => {
      const change = period >> (sweepReg & 7);
      const target = (sweepReg & 8) ? period - change - (isPulse1 ? 1 : 0) : period + change;
      return period < 8 || target > 0x7FF;
    };
    // APU Pulse 1
    {
      const r = snap[0x4000] || 0;
      const period = (snap[0x4002] || 0) | (((snap[0x4003] || 0) & 7) << 8);
      const freq = pulseFreq(snap[0x4002] || 0, snap[0x4003] || 0);
      const e = apuEnv ? apuEnv.pulse1 : null;
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P1', color: '#ff4466', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 1) && pulseActive(r) && freq > 0 && !pulseSweepMuted(snap[0x4001] || 0, period, true) });
    }
    // APU Pulse 2
    {
      const r = snap[0x4004] || 0;
      const period = (snap[0x4006] || 0) | (((snap[0x4007] || 0) & 7) << 8);
      const freq = pulseFreq(snap[0x4006] || 0, snap[0x4007] || 0);
      const e = apuEnv ? apuEnv.pulse2 : null;
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P2', color: '#ff8800', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 2) && pulseActive(r) && freq > 0 && !pulseSweepMuted(snap[0x4005] || 0, period, false) });
    }
    // Triangleの「見かけ音量」計算に使う Noise/DMC の現在値を先読みしておく
    // (NOブロック・DMブロックでも同じ値を使い回す)。
    const noiseRegPre = snap[0x400C] || 0;
    const eNoisePre = apuEnv ? apuEnv.noise : null;
    const noiseLevelPre = eNoisePre ? eNoisePre.level : (noiseRegPre & 0xF);
    const dmcRegPre = (snap[0x4011] || 0) & 0x7F; // $4011 レジスタ値（直接書き込み検出用）
    const dmcPre = apuEnv ? apuEnv.dmc : null;
    const dmcLevelPre = (dmcPre && dmcPre.level !== undefined) ? dmcPre.level : dmcRegPre;

    // APU Triangle (音量レジスタなし。ただし実機は非線形tndミキサーでnoise/dmcと
    // 混ざるため、片方の出力レベルが上がるとtriangleの相対的な聞こえ方が下がる。
    // tndOut()でtriangle単独の寄与分(masked時とmute時の差)を基準化し、
    // Stevensのべき法則(知覚音量≈振幅比^0.6, sone尺度)で聴感寄りの値に変換して
    // 「見かけ音量」として表示する。実レジスタ値ではないため envMode を流用し
    // 黄色表示にして区別する。
    {
      const lo = snap[0x400A] || 0, hi = snap[0x400B] || 0;
      const p = lo | ((hi & 7) << 8);
      const freq = p >= 4 ? CPU_CLOCK / (32 * (p + 1)) : 0;
      const triContribution = tndOut(15, noiseLevelPre, dmcLevelPre) - tndOut(0, noiseLevelPre, dmcLevelPre);
      const triContributionMax = tndOut(15, 0, 0);
      const ratio = triContributionMax > 0 ? Math.max(0, Math.min(1, triContribution / triContributionMax)) : 1;
      const vol = Math.pow(ratio, 0.6);
      const masked = noiseLevelPre > 0 || dmcLevelPre > 0;
      channels.push({ id: 'TR', color: '#00cc44', freq, vol, rawVol: masked ? Math.round(vol * 15) : null, rawVolMax: 15,
        envMode: masked,
        wave: { t: 'tri', nx: 32, ny: 16 },
        active: !!(status & 4) && freq > 0 });
    }
    // APU Noise
    {
      // $400E bit7=1 で短周期(93step)、0で長周期(32767step)。bit0-3 は周期テーブルのインデックス
      const noiseReg = snap[0x400E] || 0;
      const noiseShort = !!(noiseReg & 0x80);
      const noiseIndex = noiseReg & 0x0F;
      const e = eNoisePre;
      const rv = noiseLevelPre;
      const noiseFreq = CPU_CLOCK / NOISE_PERIOD[noiseIndex]; // LFSRシフトレート
      channels.push({ id: 'NO', color: '#888888', freq: 0, vol: e ? e.level / 15 : pulseVol(noiseRegPre), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'noise', short: noiseShort, nx: noiseShort ? 93 : 32767, ny: 2 },
        active: !!(status & 8) && pulseActive(noiseRegPre), noise: true, noiseShort, noiseIndex, noiseFreq });
    }
    // APU DMC
    {
      const dv = dmcRegPre;
      const dmcRateIdx = (snap[0x4010] || 0) & 0x0F;
      const dmcFreq = CPU_CLOCK / DMC_RATE[dmcRateIdx]; // DPCM再生周波数
      // DPCMサンプルをデルタ復号した波形（apuEnv.dmc 経由）。無ければ "固有波形なし" 扱い。
      const dmc = dmcPre;
      // 音量はライブの実出力レベル(outputLevel 0-127)を優先。無ければ $4011 レジスタ値。
      const level = dmcLevelPre;
      const wave = (dmc && dmc.len > 0)
        ? { t: 'wave', data: dmc.samples, nx: dmc.len * 8, ny: 128, sig: dmc.addr + ':' + dmc.len, pcm: true }
        : { t: 'sample', nx: 0, ny: 0 };
      channels.push({ id: 'DM', color: '#aa44ff', freq: 0, vol: level / 127, rawVol: level, rawVolMax: 127,
        wave, active: !!(status & 0x10), sample: true, dmcRateIdx, dmcFreq, dmcReg: dv });
    }
    } // !isKss && !isGbs

    if (chips.includes('fds')) {
      const lo = snap[0x4082] || 0, hi = snap[0x4083] || 0;
      const f12 = lo | ((hi & 0xF) << 8);
      const disabled = !!(hi & 0x80);
      // $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を優先し、
      // 無ければレジスタ直読み(直接ゲイン時のみ正しい)にフォールバック。
      const fe = apuEnv ? apuEnv.fds : null;
      const gain = fe ? fe.gain : ((snap[0x4080] || 0) & 0x3F);
      const gainMax = fe ? 32 : 63;
      const vol = Math.min(1, gain / gainMax);
      const freq = (!disabled && f12 > 0) ? f12 * CPU_CLOCK / (64 * 65536) : 0;
      // 波形メモリ $4040-$407F (6bit, 0-63) を -1..1 に正規化
      const fdsWave = new Array(64);
      for (let i = 0; i < 64; i++) fdsWave[i] = ((snap[0x4040 + i] || 0) & 0x3F) / 31.5 - 1;
      // $4087 bit7=0 でピッチモジュレーションユニットが有効(MH<n>使用中)。
      // 実機は明示的に$4087 bit7=1で停止するまで有効なままなので、gain(=$4084)が
      // 0でもここは別途チェックする(MHOF時は両方0/1になる。src/mml/compiler.jsの
      // resolveFdsModWriteを参照)。fe(apuEnv.fds)があれば実インスタンスの実状態
      // (既定false)を使う。$4087が曲中一度も書かれない場合、生レジスタスナップショットは
      // 未定義→0扱いになりbit7=0=有効に誤検出してしまう(MH<n>を全く使っていないのに
      // 鍵盤表示が常時ON扱いになるバグの原因だった)ため、レジスタ直読みは
      // feが取れない場合のフォールバックに留める
      const modActive = fe ? !!fe.modEnabled : !((snap[0x4087] || 0) & 0x80);
      // 実際に揺れている実ピッチ(Hz)。fe.effectiveFreq(src/emulator/expansion/fds.js
      // clock()で計算済み)はfreqと同じ内部単位(f12と同スケール)なので同じ式でHz換算する。
      // note(音名)は表示のちらつきを避けるため変調前のfreqのまま据え置き、freq列の
      // 数値表示だけをこちらに差し替える(モジュレーション無効時はfreqと同じ値になる)
      const modFreq = (fe && modActive && !disabled) ? fe.effectiveFreq * CPU_CLOCK / (64 * 65536) : freq;
      channels.push({ id: 'FDS', color: '#ff88aa', freq, modFreq, vol, rawVol: gain, rawVolMax: gainMax,
        envMode: fe ? fe.env : false, modActive,
        wave: { t: 'wave', data: fdsWave, nx: 64, ny: 64 },
        active: !disabled && vol > 0 && freq > 0 });
    }

    if (chips.includes('vrc6')) {
      for (const [id, color, b0, blo, bhi, div] of [
        ['V6P1', '#00ccff', 0x9000, 0x9001, 0x9002, 16],
        ['V6P2', '#0088ff', 0xA000, 0xA001, 0xA002, 16],
      ]) {
        const ctrl = snap[b0] || 0, lo = snap[blo] || 0, hi = snap[bhi] || 0;
        const period = lo | ((hi & 0xF) << 8);
        const en = !!(hi & 0x80);
        const rv = ctrl & 0xF;
        const vol = rv / 15;
        const duty = (ctrl >> 4) & 7; // VRC6 は High 区間 = (duty+1)/16
        const freq = (en && period > 0) ? CPU_CLOCK / (div * (period + 1)) : 0;
        channels.push({ id, color, freq, vol, rawVol: rv, rawVolMax: 15,
          wave: { t: 'pulse', hi: (duty + 1) / 16, nx: 16, ny: 2 },
          active: en && vol > 0 && freq > 0 });
      }
      {
        const ctrl = snap[0xB000] || 0, lo = snap[0xB001] || 0, hi = snap[0xB002] || 0;
        const period = lo | ((hi & 0xF) << 8);
        const en = !!(hi & 0x80);
        const rv = ctrl & 0x3F;
        const vol = Math.min(1, rv / 42);
        const freq = (en && period > 0) ? CPU_CLOCK / (14 * (period + 1)) : 0;
        channels.push({ id: 'V6SW', color: '#00ffcc', freq, vol, rawVol: rv, rawVolMax: 42,
          wave: { t: 'saw', nx: 7, ny: 32 },
          active: en && rv > 0 && freq > 0 });
      }
    }

    if (chips.includes('vrc7')) {
      // リアルタイムはライブVRC7(実FM波形付き)、事前キャプチャは writeLog由来。
      const live = extraSnaps && extraSnaps.vrc7Live;
      const snaps = live ? live() : (extraSnaps && extraSnaps.vrc7 ? extraSnaps.vrc7[frameIdx] : null);
      const COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc'];
      for (let ch = 0; ch < 6; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false, rawVol: 15 };
        // VRC7: rawVol は 0=最大, 15=無音 なので内部値をそのまま表示
        // FM合成波形があれば波形表示、無ければFMアイコン
        // VRC7はFM=連続波形なので smooth:true で線形補間(階段でなく曲線)表示
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `VR${ch+1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave, active: c.active });
      }
    }

    if (chips.includes('n163')) {
      // リアルタイム再生はライブN163関数、事前キャプチャは writeLog 由来の配列。
      const live = extraSnaps && extraSnaps.n163Live;
      const arr = extraSnaps && extraSnaps.n163;
      let snaps, numRows;
      if (live) {
        snaps = live(); // { channels, numCh, maxNumCh }
        numRows = snaps ? (snaps.maxNumCh || snaps.numCh || 1) : 1;
      } else {
        snaps = arr ? arr[frameIdx] : null;
        // 行数は曲全体の最大numChで固定（frame0=1chに縛られない・行が増減しない）
        numRows = (arr && arr.maxNumCh) ? arr.maxNumCh : 1;
      }
      n163NumRows = numRows;
      // 表示順は下位アドレス側(MML文字の若い方)を上段にするため i を降順で積む
      // (id自体はN{i+1}=ハードch(8-(i+1))のまま。getMuteInfo等の対応関係は変えない)。
      for (let i = numRows - 1; i >= 0; i--) {
        const c = snaps ? snaps.channels[i] : { freq: 0, vol: 0, active: false };
        const hue = (180 + i * 25) % 360;
        channels.push({ id: `N${i+1}`, color: `hsl(${hue},80%,60%)`, freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: { t: 'wave', data: c.waveData || [0, 0], nx: (c.waveData ? c.waveData.length : 0), ny: 16 },
          active: c.active });
      }
    }

    if (chips.includes('fme7')) {
      // リアルタイムはライブFME7関数(ラッチ式で復元不可)、事前キャプチャは writeLog由来配列。
      const live = extraSnaps && extraSnaps.fme7Live;
      const snaps = live ? live() : (extraSnaps && extraSnaps.fme7 ? extraSnaps.fme7[frameIdx] : null);
      const COLS = ['#88ff44','#55dd22','#33bb00'];
      for (let ch = 0; ch < 3; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        channels.push({ id: `FE${ch+1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          // ノイズ有効chはノイズ波形、それ以外は50%矩形波
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active });
      }
    }

    if (chips.includes('mmc5')) {
      // リアルタイムはライブMMC5(エンベロープ実出力・PCM反映)、事前キャプチャはレジスタ値。
      const ls = extraSnaps && extraSnaps.mmc5Live ? extraSnaps.mmc5Live() : null;
      const mst = snap[0x5015] || 0;
      for (const [i, base, bit] of [[0, 0x5000, 1], [1, 0x5004, 2]]) {
        const r = snap[base] || 0;
        let c;
        if (ls) {
          c = i === 0 ? ls.pulse1 : ls.pulse2;
        } else {
          const freq = pulseFreq(snap[base + 2] || 0, snap[base + 3] || 0);
          c = { freq, vol: pulseVol(r), rawVol: r & 0xF, duty: (r >> 6) & 3,
                active: !!(mst & bit) && pulseActive(r) && freq > 0 };
        }
        channels.push({ id: i === 0 ? 'M5P1' : 'M5P2',
          color: i === 0 ? '#ff6655' : '#ffaa44', freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'pulse', hi: APU_DUTY[c.duty !== undefined ? c.duty : ((r >> 6) & 3)], nx: 8, ny: 2 },
          active: c.active });
      }
      // $5011 生PCM チャンネル
      const pcm = ls ? ls.pcm : { level: snap[0x5011] || 0, vol: (snap[0x5011] || 0) / 255, active: (snap[0x5011] || 0) > 0 };
      channels.push({ id: 'M5PC', color: '#ff4488', freq: 0, vol: pcm.vol, rawVol: pcm.level, rawVolMax: 255,
        wave: { t: 'sample' }, active: pcm.active });
    }

    if (chips.includes('kssPsg')) {
      // PSG(AY-3-8910): 2A03のFME-7表示と同じ考え方(50%矩形波固定、noise有効chはノイズ波形)。
      const live = extraSnaps && extraSnaps.kssPsgLive;
      const snaps = live ? live() : null;
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      // VGMのデュアルAY8910(2個目)はスナップショットが6要素で返るのでKP4-6行も出す
      const nKp = snaps && snaps.length > 3 ? snaps.length : 3;
      for (let ch = 0; ch < nKp; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        channels.push({ id: `KP${ch + 1}`, color: COLS[ch % 3], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active });
      }
    }

    if (chips.includes('kssScc')) {
      // SCC: N163と同じ波形メモリ音源(要素数のみ異なる: SCCは32点符号付き8bit)。
      const live = extraSnaps && extraSnaps.kssSccLive;
      const snaps = live ? live() : null;
      for (let ch = 0; ch < 5; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        const hue = (280 + ch * 20) % 360;
        channels.push({ id: `KS${ch + 1}`, color: `hsl(${hue},80%,60%)`, freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: { t: 'wave', data: c.waveData || [0, 0], nx: (c.waveData ? c.waveData.length : 0), ny: 32 },
          active: c.active });
      }
    }

    if (chips.includes('kssOpll')) {
      // FMPAC(YM2413): VRC7と同じFM表示だが、9メロディモードとリズムモード(6melody+BD/SD/TOM/CYM/HH)
      // の両方に対応する(VRC7ハードウェアにはリズムモードが存在しないため6ch固定だった)。
      const live = extraSnaps && extraSnaps.kssOpllLive;
      const snap2 = live ? live() : null;
      const melody = snap2 ? snap2.melody : [];
      const MCOLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      for (let ch = 0; ch < (melody.length || (snap2 && snap2.rhythmMode ? 6 : 9)); ch++) {
        const c = melody[ch] || { freq: 0, vol: 0, active: false, rawVol: 15 };
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `KF${ch + 1}`, color: MCOLS[ch % MCOLS.length], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave, active: c.active });
      }
      if (snap2 && snap2.rhythmMode && snap2.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          const r = snap2.rhythm[key];
          channels.push({ id: `KF${RLABEL[key]}`, color: RCOLS[key], freq: r.freq, vol: r.vol,
            rawVol: null, rawVolMax: null,
            wave: r.freq > 0 ? { t: 'pulse', hi: 0.5, nx: 2, ny: 2 } : { t: 'noise', short: true, nx: 93, ny: 2 },
            active: r.active, drum: true });
        }
      }
    }

    if (chips.includes('sn76489')) {
      // SN76489(VGM: SMS/GG/SG-1000/MD PSG): 矩形3本(50%固定)+ノイズ1ch。ライブ関数優先、
      // 無ければ先読みスナップショット配列(extraSnaps.sn[frameIdx]、ロール構築用)。
      // L/R列はGame Gearのステレオレジスタ(他機種では常に1/1)。
      const live = extraSnaps && extraSnaps.snLive;
      const sAll = live ? live() : (extraSnaps && extraSnaps.sn ? extraSnaps.sn[frameIdx] : null);
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      // デュアルチップ(2個目)はスナップショットが8要素(4+4)で返る: 2組目はSN4-6/SNN2行
      const nGroups = sAll && sAll.length >= 8 ? 2 : 1;
      for (let g = 0; g < nGroups; g++) {
      const s = sAll ? sAll.slice(g * 4, g * 4 + 4) : null;
      for (let ch = 0; ch < 3; ch++) {
        const c = s ? s[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1 };
        channels.push({ id: `SN${g * 3 + ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'pulse', hi: 0.5, nx: 2, ny: 2 }, active: c.active, panL: c.panL, panR: c.panR });
      }
      {
        const c = s ? s[3] : { freq: 0, vol: 0, rawVol: 0, active: false, white: true, noiseFreq: 0, panL: 1, panR: 1 };
        // 周期性ノイズ(white=false)は短周期の繰り返し=2A03の短周期ノイズ表示に寄せる。
        // note列はシフトレートを2A03ノイズ16周期の最寄りindexに写像(GBのGN行と同じ考え方)。
        channels.push({ id: g === 0 ? 'SNN' : 'SNN2', color: '#888888', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'noise', short: !c.white, nx: c.white ? 65535 : 16, ny: 2 },
          active: c.active, noise: true, noiseIndex: gbNoiseFreqToIndex(c.noiseFreq), noiseFreq: c.noiseFreq, noiseShort: !c.white,
          panL: c.panL, panR: c.panR });
      }
      }
    }

    if (chips.includes('ym2612')) {
      // YM2612(VGM: メガドライブ): 4op FM×6ch(VRC7/OPLL行と同じFM波形表示)+DAC行。ライブ関数
      // 優先、無ければ先読みスナップショット配列(extraSnaps.ym2612[frameIdx]、ロール構築用)。
      const live = extraSnaps && extraSnaps.ymLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2612 ? extraSnaps.ym2612[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      for (let ch = 0; ch < 6; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `YM${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR });
      }
      {
        const d = s ? s.dac : { enabled: false, level: 0, vol: 0, active: false };
        channels.push({ id: 'YMDA', color: '#aa44ff', freq: 0, vol: d.vol, rawVol: d.enabled ? d.level : null, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!d.active, sample: true, dmcReg: d.level, dmcRateIdx: 15, dmcFreq: 0 });
      }
    }

    if (chips.includes('pwm')) {
      // 32X PWM(VGM): 左右2chのPCM DAC。DMC/YMDAと同じ「サンプル」行(音量=振幅)
      const live = extraSnaps && extraSnaps.pwmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.pwm ? extraSnaps.pwm[frameIdx] : null);
      for (const [id, key, color] of [['PWL', 'l', '#66ddff'], ['PWR', 'r', '#ff8866']]) {
        const c = s ? s[key] : { level: 0, vol: 0, active: false };
        channels.push({ id, color, freq: 0, vol: c.vol, rawVol: c.level, rawVolMax: s ? s.cycle : 4095,
          wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.level, dmcRateIdx: 15, dmcFreq: 0,
          panL: key === 'l' ? 1 : 0, panR: key === 'r' ? 1 : 0 });
      }
    }

    if (isGbs) {
      const live = extraSnaps && extraSnaps.gbsApuLive;
      const s = live ? live() : null;
      // NR50(マスター音量+VIN)/NR51(パンニング)。ライブでなければ全て0(無音扱い)。
      const nr50 = s ? s.nr50 : 0;
      const nr51 = s ? s.nr51 : 0;
      const volL = (nr50 >> 4) & 0x07, volR = nr50 & 0x07;
      const vinL = !!(nr50 & 0x80), vinR = !!(nr50 & 0x08);
      // ALL行($FF24、全体バランス。HESのALL行と同じ考え方): 実チャンネルではないので
      // L/R列(NR50のマスター音量0-7)だけを持つ。VINが有効な側は数字を黄色にする。
      channels.push({ id: 'GALL', color: '#888', isAllRow: true, panL: volL, panR: volR, vinL, vinR });
      // GB CH1/CH2(パルス+スイープ/パルス): 2A03パルス表示と同じ考え方(duty波形)。
      // エンベロープperiod=0(ハード任せでなく実質固定/ドライバ管理)は白、1-7(ハード自動増減)は黄。
      const PCOLS = [['GB1', '#66ddff'], ['GB2', '#0077dd']];
      for (let i = 0; i < 2; i++) {
        const c = s ? s['ch' + (i + 1)] : { freq: 0, vol: 0, rawVol: 0, duty: 2, envPeriod: 0, active: false };
        channels.push({ id: PCOLS[i][0], color: PCOLS[i][1], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          envMode: (c.envPeriod || 0) > 0,
          wave: { t: 'pulse', hi: APU_DUTY[c.duty], nx: 8, ny: 2 },
          active: c.active, panL: (nr51 >> (4 + i)) & 1, panR: (nr51 >> i) & 1 });
      }
      // GB CH4(ノイズ): 7bit/15bit幅モードで短周期/長周期のノイズ波形を切り替える。
      // note列は実測周波数を既存2A03ノイズ16周期の最寄りにマッチさせたindex(0-15)、
      // freq列はGB自体の実測再生速度(Hz)。note色は15bit=白/7bit=黄(ch.noiseShort)。
      {
        const c = s ? s.ch4 : { freq: 0, vol: 0, rawVol: 0, widthMode: 0, envPeriod: 0, active: false };
        channels.push({ id: 'GN', color: '#888888', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          envMode: (c.envPeriod || 0) > 0,
          wave: { t: 'noise', short: !!c.widthMode, nx: c.widthMode ? 127 : 32767, ny: 2 },
          active: c.active, noise: true, noiseIndex: gbNoiseFreqToIndex(c.freq), noiseFreq: c.freq, noiseShort: !!c.widthMode,
          panL: (nr51 >> 7) & 1, panR: (nr51 >> 3) & 1 });
      }
      // GB CH3(波形メモリ): N163と同じ波形メモリ表示(要素数のみ異なる: GBは32点符号無し4bit)。
      // CH3にはエンベロープが無いためvol色は変更しない(envMode未設定=通常色のまま)。
      {
        const c = s ? s.ch3 : { freq: 0, vol: 0, rawVol: 0, waveData: [0, 0], active: false };
        channels.push({ id: 'GW', color: '#ffcc00', freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 3,
          wave: { t: 'wave', data: c.waveData, nx: c.waveData.length, ny: 16 },
          active: c.active, panL: (nr51 >> 6) & 1, panR: (nr51 >> 2) & 1 });
      }
    }

    if (isHes) {
      // PSG(PC Engine) 6ch: 32サンプル5bit波形音源。ch4/5はノイズモード中のみノイズ波形表示に
      // 切り替わる(hesBus.js/apuHuC6280.js参照。物理的にノイズ生成回路を持つのはch4/5のみ)。
      const live = extraSnaps && extraSnaps.hesApuLive;
      const s = live ? live() : null;
      const PCOLS = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
      // ALL行($0801、全体バランス。SPCのALL行と同じ考え方): 実チャンネルではないので
      // active/wave/note/freqは無く、L/R列だけを持つ(_rebuildRows()のisAllRow参照)。
      channels.push({
        id: 'HALL', color: '#888', isAllRow: true,
        panL: s ? s.globalPanL : 15, panR: s ? s.globalPanR : 15
      });
      for (let i = 0; i < 6; i++) {
        const c = s ? s[i] : { freq: 0, vol: 0, rawVol: 0, wave: [0, 0], noiseOn: false, active: false, dda: false, panL: 15, panR: 15 };
        const wave = c.noiseOn
          ? { t: 'noise', short: false, nx: 131071, ny: 2 }
          : { t: 'wave', data: c.wave, nx: c.wave.length, ny: 32 };
        channels.push({ id: `PSG${i}`, color: PCOLS[i], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave, active: c.active, noise: c.noiseOn, noiseLabel: c.noiseOn ? 'noise' : undefined,
          dda: c.dda, panL: c.panL, panR: c.panR });
      }
    }

    const letterMap = (MML.Mml && MML.Mml.assignExpansionLetters) ? MML.Mml.assignExpansionLetters(chipsToExpansions(chips)) : {};
    for (const c of channels) c.letter = getPartLetter(c.id, letterMap, n163NumRows);

    return channels;
  }

  // 音量(0-1)を9段階(0-8)に量子化する。ピアノロールの音量シェーディングは連続値ではなく
  // 「段階的に暗く」なる見た目にするため、ノート区間の分割もこの量子化レベル単位で行う。
  const ROLL_VOL_LEVELS = 8;
  function quantizeVol(v) {
    return Math.max(0, Math.min(ROLL_VOL_LEVELS, Math.round((v || 0) * ROLL_VOL_LEVELS)));
  }

  // ── ピアノロール: フレーム単位のチャンネル状態からノート区間を抽出 ──
  // getChannelsAtFrame(frameIdx) は extractChannels() と同じ形の channels[] を返す関数。
  // 同じMIDIノート・同じ量子化音量レベルが連続する区間を1つのノートにまとめる
  // (ノイズ/サンプルチャンネルは対象外)。
  // freqSeq: DESIGN-PITCH.md Phase 0のセント偏差オーバーレイ用。ノート区間内フレーム毎の
  // 生周波数(Hz)をvolSeqと同じ「区切らず積む」考え方で保持する(丸め後のmidiは一定のまま、
  // 実際の周波数だけがビブラート等で揺れている様子を後で細線描画するため)。
  function buildNoteTimelineFromChannelFrames(getChannelsAtFrame, totalFrames, frameDur) {
    const tracks = new Map(); // id → { id, color, notes:[], cur:{startFrame,midi,volQ,freqs}|null }
    for (let f = 0; f < totalFrames; f++) {
      const channels = getChannelsAtFrame(f) || [];
      for (const ch of channels) {
        let track = tracks.get(ch.id);
        if (!track) { track = { id: ch.id, color: ch.color, notes: [], cur: null }; tracks.set(ch.id, track); }
        track.color = ch.color;
        // ノイズch/DPCM(サンプル)chはch.freqが常に0(実波形の「音程」ではないため)なので、
        // 代わりに周期選択レジスタのindex(0-15)をそのまま16音へ1:1対応させた疑似ノート番号
        // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)として使う。GBSのロール
        // (main.js buildGbsRollTimeline)は元々noise.jsの周期判定で音程付きで表示できていたが、
        // この共通経路(NSF/MML再生のロール、および全フォーマット共通の鍵盤ハイライトdrawPiano)は
        // ノイズ・DPCM双方を丸ごと除外していたため、NSFのノイズ/DPCMがロールにも鍵盤にも出ない・
        // GBSのノイズが鍵盤に出ない、という食い違いになっていた。
        let midi, pitchFreq;
        if (!ch.active) { midi = null; pitchFreq = 0; }
        else if (ch.noise) { midi = noisePeriodIndexToMidi(ch.noiseIndex); pitchFreq = ch.noiseFreq; }
        else if (ch.sample) { midi = dmcRateIndexToMidi(ch.dmcRateIdx); pitchFreq = ch.dmcFreq; }
        else { midi = ch.freq ? freqToMidi(ch.freq) : null; pitchFreq = ch.freq; }
        const volQ = midi !== null ? quantizeVol(ch.vol) : 0;
        if (track.cur && (midi === null || midi !== track.cur.midi || volQ !== track.cur.volQ)) {
          track.notes.push({ startSec: track.cur.startFrame * frameDur, endSec: f * frameDur, midi: track.cur.midi, vol: track.cur.volQ / ROLL_VOL_LEVELS, freqSeq: track.cur.freqs });
          track.cur = null;
        }
        if (midi !== null && !track.cur) track.cur = { startFrame: f, midi, volQ, freqs: [] };
        if (track.cur) track.cur.freqs.push(pitchFreq);
      }
    }
    const totalSec = totalFrames * frameDur;
    const result = [];
    for (const track of tracks.values()) {
      if (track.cur) track.notes.push({ startSec: track.cur.startFrame * frameDur, endSec: totalSec, midi: track.cur.midi, vol: track.cur.volQ / ROLL_VOL_LEVELS, freqSeq: track.cur.freqs });
      result.push({ id: track.id, color: track.color, notes: track.notes });
    }
    result.frameDur = frameDur; // セント偏差オーバーレイ描画時にfreqSeqのフレーム間隔を復元するため
    return result;
  }

  // ── 間接アクセス音源の内部状態再構築 ─────────────────────────

  function buildVrc7Snapshots(writeLog) {
    const regs = new Uint8Array(64);
    let latch = 0;
    return writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0x9010) latch = w.value & 0x3F;
        else if (w.addr === 0x9030) regs[latch] = w.value;
      }
      return Array.from({ length: 6 }, (_, ch) => {
        const fnumLo = regs[0x10 + ch];
        const b2 = regs[0x20 + ch];
        const keyOn = !!(b2 & 0x10);
        const block = (b2 >> 1) & 7;
        const fnum = fnumLo | ((b2 & 1) << 8);
        const rawVol = regs[0x30 + ch] & 0xF; // 0=最大, 15=無音
        const vol = (15 - rawVol) / 15;
        const freq = (keyOn && fnum > 0) ? fnum * Math.pow(2, block) * 49716 / 524288 : 0;
        return { freq, vol, rawVol, active: keyOn && rawVol < 15 };
      });
    });
  }

  // 事前キャプチャ経路: writeLog($F800/$4800)から128バイトRAMを復元し、
  // フレームごとに Emu.snapshotN163() でスナップショット化する。
  function buildN163Snapshots(writeLog) {
    const ram = new Uint8Array(128);
    let latch = 0, autoInc = false;
    let maxNumCh = 1;
    const frames = writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0xF800) { latch = w.value & 0x7F; autoInc = !!(w.value & 0x80); }
        else if (w.addr === 0x4800) { ram[latch] = w.value; if (autoInc) latch = (latch + 1) & 0x7F; }
      }
      const snap = MML.Emu.snapshotN163(ram);
      if (snap.numCh > maxNumCh) maxNumCh = snap.numCh;
      return snap;
    });
    frames.maxNumCh = maxNumCh;
    return frames;
  }

  // ライブキャプチャ経路: capture.jsがフレームごとに採取した実チップRAM(128byte)の配列から
  // 直接スナップショット化する(writeLog再生による間接アドレッシングのポインタずれが無い、
  // buildN163Snapshots()より正確な代替)。
  function buildN163SnapshotsFromLiveRam(n163Snapshots) {
    let maxNumCh = 1;
    const frames = n163Snapshots.map(ram => {
      const snap = MML.Emu.snapshotN163(ram || new Uint8Array(128));
      if (snap.numCh > maxNumCh) maxNumCh = snap.numCh;
      return snap;
    });
    frames.maxNumCh = maxNumCh;
    return frames;
  }

  function buildFme7Snapshots(writeLog) {
    const regs = new Uint8Array(16);
    let latch = 0;
    regs[7] = 0x38;
    return writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0xC000) latch = w.value & 0xF;
        else if (w.addr === 0xE000) regs[latch] = w.value;
      }
      return Array.from({ length: 3 }, (_, ch) => {
        const period = regs[ch * 2] | ((regs[ch * 2 + 1] & 0xF) << 8);
        const toneOn = !((regs[7] >> ch) & 1);
        const noiseOn = !((regs[7] >> (3 + ch)) & 1);
        const rawVol = regs[8 + ch] & 0xF;
        const vol = rawVol / 15;
        // 実機5B/AYは +1 しない。f = CPU/(32*period)。
        const freq = (toneOn && period > 0) ? CPU_CLOCK / (32 * period) : 0;
        // ノイズ単独(@2)はトーンが止まっていても発音中(Emu.snapshotFME7と同じ判定)
        return { freq, vol, rawVol, noise: noiseOn,
                 active: toneOn ? (vol > 0 && freq > 0) : (noiseOn && vol > 0) };
      });
    });
  }

  // ── 鍵盤描画 ────────────────────────────────────────────────

  function keyX(midi, wkW) {
    if (midi < MIDI_MIN || midi > MIDI_MAX) return null;
    const rel = midi - MIDI_MIN;
    const oct = Math.floor(rel / 12);
    const semi = rel % 12;
    if (!IS_BLACK[semi]) {
      return { x: (oct * 7 + WHITE_IDX[semi]) * wkW, isBlack: false };
    }
    const lw = oct * 7 + WHITE_IDX[semi - 1];
    return { x: (lw + 1) * wkW, isBlack: true };
  }

  // ── 素波形アイコン描画 ────────────────────────────────────────
  // ピッチ・音量を含まない、そのチャンネルの1周期ぶんの生波形を表示する。

  // 位相 phase(0..1) に対する正規化振幅 (-1..1)
  function waveSampleValue(wave, phase) {
    switch (wave.t) {
      case 'pulse': return phase < wave.hi ? 1 : -1;
      case 'tri': {
        // NES三角波: 32ステップ / 16段の階段波 (15→0→15)
        const step = Math.floor(phase * 32) % 32;
        const v = step < 16 ? (15 - step) : (step - 16); // 0..15
        return (v / 15) * 2 - 1;
      }
      case 'saw': {
        // VRC6のこぎり波: アキュムレータを7回加算してリセットする階段状
        const step = Math.floor(phase * 7) % 7;
        return (step / 6) * 2 - 1;
      }
      case 'fm':    return Math.sin(phase * Math.PI * 2);
      case 'wave': {
        const d = wave.data;
        if (!d.length) return 0;
        if (wave.smooth) {
          // FM等の連続波形: サンプル間を線形補間して滑らかな曲線にする
          const x = phase * d.length;
          const i0 = Math.floor(x) % d.length;
          const i1 = (i0 + 1) % d.length;
          const f = x - Math.floor(x);
          return d[i0] * (1 - f) + d[i1] * f;
        }
        // ウェーブテーブル(N163等)は本当に階段状なので最近傍
        return d[Math.floor(phase * d.length) % d.length];
      }
    }
    return 0;
  }

  // 波形クリップボード用: そのチャンネルの1周期ぶんを具体的な数値配列にして返す。
  // pulse/saw/tri等はwave.hi等のパラメータだけで実データ配列を持たないため
  // waveSampleValue()で一定解像度サンプリングして配列化する。noise(LFSR)/fm(実データ
  // 無しの代替アイコン)/sample(固有波形無し)はコピー対象外としてnullを返す
  function getCopyableWaveSamples(wave) {
    if (!wave) return null;
    if (wave.t === 'wave') {
      // SPCの多層波形は素のBRR値(層0)を代表として使う
      if (wave.layers && wave.layers.length && wave.layers[0].data && wave.layers[0].data.length) {
        return Array.from(wave.layers[0].data);
      }
      return (wave.data && wave.data.length) ? Array.from(wave.data) : null;
    }
    if (wave.t === 'pulse' || wave.t === 'saw' || wave.t === 'tri') {
      const resolution = Math.max(8, Math.min(256, wave.nx || 32));
      const arr = [];
      for (let i = 0; i < resolution; i++) arr.push(waveSampleValue(wave, i / resolution));
      return arr;
    }
    return null;
  }

  // 再描画要否判定用シグネチャ（形状 or 表示状態が変わった時だけ描き直す）
  function waveSig(wave, on) {
    if (!wave) return 'x';
    let s = wave.t + (on ? '1' : '0');
    if (wave.t === 'pulse') s += wave.hi.toFixed(3);
    else if (wave.t === 'noise') s += wave.short ? 'S' : 'L';
    else if (wave.t === 'wave') {
      if (wave.layers) {
        // SPCの多層波形(素/ガウス補間/PM変調後)は各レイヤーをまとめてハッシュ化
        for (const layer of wave.layers) {
          const d = layer.data;
          let h = d.length;
          for (let i = 0; i < d.length; i++) h = (h * 31 + Math.round(d[i] * 1000)) | 0;
          s += ':' + d.length + ':' + h;
        }
      } else if (wave.sig) {
        s += ':' + wave.sig; // DPCM等の大容量データはキャッシュキー(addr:len)で判定しハッシュ省略
      } else {
        const d = wave.data;
        let h = d.length;
        for (let i = 0; i < d.length; i++) h = (h * 31 + Math.round(d[i] * 100)) | 0;
        s += ':' + d.length + ':' + h;
      }
    }
    return s;
  }

  // ノイズを離散バー(階段)で描く。周期全体(短=93 / 長=32767)を表示幅ぶんに間引いて
  // 1周期を表現する（長周期は省略表示）。X軸 0..周期-1 と対応。
  function drawNoiseStairs(ctx, short, x0, w, mid, amp) {
    const period = short ? 93 : 32767;
    const maxBars = Math.max(8, Math.floor(w / 3)); // 1バー最低3px確保
    const bars = Math.min(period, maxBars);
    const barW = w / bars;
    let sr = 1, step = 0;
    ctx.beginPath();
    for (let k = 0; k < bars; k++) {
      const target = Math.round(k * (period - 1) / Math.max(1, bars - 1));
      while (step < target) { // LFSR を target ステップまで進める
        const b0 = sr & 1;
        const other = short ? ((sr >> 6) & 1) : ((sr >> 1) & 1);
        sr = (sr >> 1) | ((b0 ^ other) << 14);
        step++;
      }
      const y = mid - ((sr & 1) ? -1 : 1) * amp; // bit0=0→出力ON(上), 1→無音(下)
      const xa = x0 + k * barW, xb = x0 + (k + 1) * barW;
      if (k === 0) ctx.moveTo(xa, y); else ctx.lineTo(xa, y);
      ctx.lineTo(xb, y);
    }
    ctx.stroke();
  }

  function drawWaveIcon(canvas, wave, color, on) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!wave) return;
    const mid = H / 2, amp = H / 2 - 3;
    ctx.strokeStyle = on ? color : '#4a4a58';
    ctx.lineWidth = on ? 2 : 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    if (wave.t === 'sample') {
      // DMC/PCM: 固有波形なし。中央に破線を引く
      ctx.setLineDash([4, 4]);
      ctx.moveTo(3, mid); ctx.lineTo(W - 3, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (wave.t === 'noise') {
      // 1周期を表示幅ぶんに間引いた離散バーで描画（short/longで異なるパターン）
      drawNoiseStairs(ctx, wave.short, 0, W, mid, amp);
      return;
    }

    const PERIODS = 2; // 周期性が読み取れるよう2周期ぶん描く
    for (let x = 0; x <= W; x++) {
      const phase = ((x / W) * PERIODS) % 1;
      const y = mid - waveSampleValue(wave, phase) * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 波形タイプの表示名
  function waveTypeLabel(wave) {
    if (!wave) return '';
    switch (wave.t) {
      case 'pulse':  return 'Pulse';
      case 'tri':    return 'Triangle';
      case 'saw':    return 'Sawtooth';
      case 'noise':  return 'Noise (' + (wave.short ? 'short' : 'long') + ')';
      case 'wave':
        if (wave.layers) return wave.layers.length > 2
          ? T('BRR (素 + ガウス補間 + PM)') : T('BRR (素 + ガウス補間)');
        return wave.smooth ? 'FM' : (wave.pcm ? 'DPCM' : 'Wavetable');
      case 'fm':     return 'FM';
      case 'sample': return 'PCM (DMC)';
    }
    return wave.t;
  }

  // ── SPC エンベロープ(env列)アイコン描画 ─────────────────────────
  // ADSRモード限定: AR/DR/SL/SRの生値から模式的なエンベロープ形状(Attack→Decay→
  // Sustain→Release)を描く。レートが速いほど傾きが急峻になる簡易表現（時間軸は正確ではない）。
  function drawEnvIcon(canvas, env, color, on) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!env || env.mode !== 'adsr') return;
    const arT = env.ar / 15, drT = env.dr / 7;
    const slY = env.sl / 7; // サステインレベル 0-7 → 0-1
    const wA = 3 + (1 - arT) * (W * 0.30);
    const wD = 3 + (1 - drT) * (W * 0.24);
    const wS = W * 0.18;
    const wR = Math.max(3, W - wA - wD - wS - 2);
    const x0 = 1, yTop = 2, yBase = H - 2;
    const ySus = yBase - slY * (yBase - yTop);
    ctx.strokeStyle = on ? color : '#4a4a58';
    ctx.lineWidth = on ? 1.6 : 1.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, yBase);
    ctx.lineTo(x0 + wA, yTop);                  // Attack
    ctx.lineTo(x0 + wA + wD, ySus);              // Decay → Sustain level
    ctx.lineTo(x0 + wA + wD + wS, ySus);         // Sustain (簡易的に水平)
    ctx.lineTo(x0 + wA + wD + wS + wR, yBase);   // Release
    ctx.stroke();
  }

  // 再描画要否判定用シグネチャ（大波形用: 形状＋要素数）
  function bigWaveSig(wave) {
    if (!wave) return 'x';
    return waveSig(wave, true) + '|' + wave.nx + 'x' + wave.ny;
  }

  // 選択チャンネルの素波形を拡大表示する。表示サイズ固定・1周期ぶん。
  // 軸目盛りは0始まりで、原点0は左下1か所のみ、各軸の最大値(要素数-1)を端に表示する。
  function drawBigWave(canvas, wave, color) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    // 全ての余白・線幅・フォントサイズは基準解像度560px幅に対して調整済みの値を
    // Sでスケールする（キャンバス解像度を変えても比率を保ったまま拡大縮小できる）。
    const S = W / 560;
    // signed: SPC(BRR)のような符号付き16bit系列。桁数が多く("-32768"等)、
    // 既定の余白・フォントだと左端からはみ出すため余白を広げてフォントを一段階小さくする。
    const signed = !!(wave && wave.signed);
    // 軸ラベル用の余白（左=Y目盛り, 下=X目盛り）
    const mL = (signed ? 74 : 56) * S, mR = 18 * S, mT = 14 * S, mB = 38 * S;
    const x0 = mL, x1 = W - mR, y0 = mT, y1 = H - mB;
    const w = x1 - x0, mid = (y0 + y1) / 2, amp = (y1 - y0) / 2;
    const tickGap = 8 * S;

    // プロット枠・中心線
    ctx.strokeStyle = '#3a3a46';
    ctx.lineWidth = 1 * S;
    ctx.strokeRect(x0, y0, w, y1 - y0);
    ctx.beginPath();
    ctx.setLineDash([3 * S, 5 * S]);
    ctx.moveTo(x0, mid); ctx.lineTo(x1, mid);
    ctx.strokeStyle = '#4a4a58';
    ctx.stroke();
    ctx.setLineDash([]);

    if (!wave || wave.t === 'sample') {
      ctx.fillStyle = '#777788';
      ctx.font = Math.round(20 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(wave ? 'PCM (no fixed waveform)' : '—', (x0 + x1) / 2, mid);
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 * S;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (wave.t === 'noise') {
      // 1周期を間引いた離散バーで表示（短=93=実1周期 / 長=32767を省略表示）
      drawNoiseStairs(ctx, wave.short, x0, w, mid, amp);
    } else if (wave.t === 'wave' && wave.layers) {
      // SPC: 素のBRR値(階段状+ドット、他のウェーブテーブル表示と同じ最近傍表現)・
      // ガウス補間後の滑らかな波形(線)・PM変調後(破線)を重ね描き＋凡例
      for (const layer of wave.layers) {
        const d = layer.data;
        if (!d || !d.length) continue;
        ctx.strokeStyle = layer.color;
        ctx.fillStyle = layer.color;
        ctx.setLineDash((layer.dash || []).map(v => v * S));
        if (layer.mode === 'steps') {
          // 階段状(最近傍)表示。BRRデコード直後の生サンプル値をそのまま示す。
          ctx.lineWidth = 2 * S;
          ctx.beginPath();
          for (let i = 0; i <= w; i++) {
            const phase = (i / w) % 1;
            const idx = Math.floor(phase * d.length) % d.length;
            const y = mid - d[idx] * amp;
            const x = x0 + i;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          // サンプル点をドット表示（要素数が視覚的に分かる）
          for (let k = 0; k < d.length; k++) {
            const x = x0 + (k / d.length) * w;
            const y = mid - d[k] * amp;
            ctx.beginPath();
            ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // ガウス補間後・PM変調後: 連続的な線形補間曲線
          ctx.lineWidth = 2.2 * S;
          ctx.beginPath();
          for (let i = 0; i <= w; i++) {
            const phase = (i / w) % 1;
            const x2 = phase * d.length;
            const i0 = Math.floor(x2) % d.length;
            const i1 = (i0 + 1) % d.length;
            const f = x2 - Math.floor(x2);
            const val = d[i0] * (1 - f) + d[i1] * f;
            const y = mid - val * amp;
            const x = x0 + i;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      // 凡例（プロット左上に色見本＋ラベル）
      ctx.font = Math.round(13 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      let ly = y0 + 4 * S;
      for (const layer of wave.layers) {
        ctx.fillStyle = layer.color;
        ctx.fillRect(x0 + 4 * S, ly + 2 * S, 10 * S, 3 * S);
        ctx.fillText(layer.label, x0 + 18 * S, ly);
        ly += 15 * S;
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i <= w; i++) {
        const phase = (i / w) % 1; // 全音源1周期ぶん
        const y = mid - waveSampleValue(wave, phase) * amp;
        const x = x0 + i;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // ウェーブテーブルは各サンプル点をドット表示（要素数が視覚的に分かる）。
      // FM(smooth)の連続波形やDPCMのような大容量データはドットを省く（線のみ）。
      if (wave.t === 'wave' && !wave.smooth && wave.data && wave.data.length && wave.data.length <= 256) {
        const d = wave.data;
        ctx.fillStyle = color;
        for (let k = 0; k < d.length; k++) {
          const x = x0 + (k / d.length) * w;
          const y = mid - d[k] * amp;
          ctx.beginPath();
          ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (wave.smooth) {
      // FM等の連続波形: 要素数(描画解像度)や振幅は素の値が存在しない(音階/音量/EG依存)
      // ため数値目盛りは出さない。位相=1周期・中心0(相対波形)だけを示す。
      ctx.fillStyle = '#8a8a98';
      ctx.font = Math.round(17 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('0', x0 - tickGap, mid); // Y中心(ゼロ交差)のみ
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(T('1 周期 (相対波形)'), x0 + w / 2, y1 + tickGap);
    } else {
      // ウェーブテーブル等: 軸目盛り。signed=trueのPCM系(BRR等)は符号付きレンジ
      // (-ny 〜 0 〜 ny-1。例: ny=32768 なら -32768〜0〜32767)、それ以外は
      // 従来通り0始まり(0 〜 ny-1)で表示する。
      ctx.fillStyle = '#b6b6c6';
      // canvasは var() 非対応。実フォント名を指定
      ctx.font = Math.round((signed ? 18 : 22) * S) + 'px ' + fontStack('mono');
      const nxMax = wave.nx - 1, nyMax = wave.ny - 1;
      const nxMid = Math.floor(nxMax / 2);
      let yBottomLabel, yMidLabel;
      if (signed) {
        yBottomLabel = String(-wave.ny);
        yMidLabel = '0';
      } else {
        const nyMid = Math.floor(nyMax / 2);
        yBottomLabel = '0';
        yMidLabel = nyMid > 0 ? String(nyMid) : null;
      }
      // Y軸（左）: 下=yBottomLabel → 上=nyMax(signed時は符号付き最大値と一致)
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(yBottomLabel, x0 - tickGap, y1);                   // 原点/最小値 (左下)
      if (yMidLabel !== null) ctx.fillText(yMidLabel, x0 - tickGap, mid); // Y中間
      ctx.fillText(String(nyMax), x0 - tickGap, y0);                  // Y最大 (左上)
      // X軸（下）: 左=0 → 右=nxMax
      ctx.textBaseline = 'top';
      if (nxMid > 0) { ctx.textAlign = 'center'; ctx.fillText(String(nxMid), x0 + w / 2, y1 + tickGap); } // X中間
      ctx.textAlign = 'right'; ctx.fillText(String(nxMax), x1, y1 + tickGap); // X最大 (右下)
    }
  }

  // 鍵盤描画。orientation='vertical'(既定)は横並びの鍵盤(鍵の長さ=canvasの高さ、黒鍵は
  // 上=ロール側に付く)、'horizontal'は縦並びの鍵盤(鍵の長さ=canvasの幅、黒鍵は右=ロール側に
  // 付く、高音が上)。音程軸の座標はロール側と同じkeyX()を共有する。
  // visibleWhite/offsetWhite(省略可): 鍵盤全体でなく白鍵visibleWhite本ぶんの音程窓を、白鍵offsetWhite
  // (小数可)から表示する(チャンネルごとのレーン用。ロール側と同じ窓を使う)
  function drawPiano(canvas, channels, orientation, visibleWhite, offsetWhite) {
    const vertical = orientation !== 'horizontal';
    // 内部解像度は表示サイズ(CSS px、border除く)に合わせる。表示サイズは_cachedWidth/_cachedHeight
    // (ResizeObserverでキャッシュ)を優先し、毎フレームoffsetWidth/clientHeightを読んで
    // 強制レイアウトが走るのを避ける
    const newW = canvas._cachedWidth || canvas.clientWidth || (vertical ? 560 : PIANO_KEY_LEN);
    const newH = canvas._cachedHeight || canvas.clientHeight || (vertical ? PIANO_KEY_LEN : 560);
    if (newW === 0 || newH === 0) return;
    if (canvas.width !== newW) canvas.width = newW;   // サイズ変化時のみ再割り当て（毎フレームのリフロー防止）
    if (canvas.height !== newH) canvas.height = newH;
    const W = canvas.width, H = canvas.height;
    const pitchLen = vertical ? W : H;   // 音程軸の長さ
    const keyLen = vertical ? H : W;     // 鍵の長さ
    const wkW = pitchLen / (visibleWhite || TOTAL_WHITE);  // 白鍵1本の太さ(音程軸方向)
    const offPx = (offsetWhite || 0) * wkW;  // 表示窓の低音側の端(px)。keyX()の結果からこれを引く
    const bkW = Math.max(3, wkW * 0.60); // 黒鍵の太さ
    const bkH = Math.round(keyLen * 0.62); // 黒鍵の長さ
    const ctx = canvas.getContext('2d');

    const keyColors = {};
    for (const ch of channels) {
      if (!ch.active) continue;
      // ノイズch/DPCM(サンプル)chはそれぞれch.noiseIndex/ch.dmcRateIdxを疑似ノートとして使う
      // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)。
      const midi = ch.noise ? noisePeriodIndexToMidi(ch.noiseIndex)
        : ch.sample ? dmcRateIndexToMidi(ch.dmcRateIdx)
        : (ch.freq ? freqToMidi(ch.freq) : null);
      if (midi !== null && !keyColors[midi]) keyColors[midi] = ch.color;
    }

    ctx.clearRect(0, 0, W, H);

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x -= offPx;
      if (pos.x + wkW < 0 || pos.x > pitchLen) continue; // 表示窓の外
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#d4cfbc';
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      if (vertical) {
        ctx.fillRect(pos.x + 0.5, 0.5, wkW - 1, keyLen - 1);
        ctx.strokeRect(pos.x + 0.5, 0.5, wkW - 1, keyLen - 1);
        if (color) { // 発音中: 手前(下端)に濃い帯
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(pos.x + 0.5, keyLen - 8, wkW - 1, 7);
          ctx.globalAlpha = 1;
        }
      } else {
        const y = H - pos.x - wkW; // 高音が上: 音程軸pをcanvasの下から上へ
        ctx.fillRect(0.5, y + 0.5, keyLen - 1, wkW - 1);
        ctx.strokeRect(0.5, y + 0.5, keyLen - 1, wkW - 1);
        if (color) { // 発音中: 手前(左端)に濃い帯
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(1, y + 0.5, 7, wkW - 1);
          ctx.globalAlpha = 1;
        }
        // Cの音名は鍵の上(黒鍵に隠れない手前側)に書く(縦向きはロール側のレーン先頭に
        // 書いているが、横向きはレーンが薄くて文字が入らないため鍵に書く)。鍵が細すぎる
        // ときは省略する
        if (semi === 0 && wkW >= 8) {
          ctx.fillStyle = color ? '#1a1830' : '#6b6b7a';
          ctx.font = Math.min(9, Math.floor(wkW) - 1) + 'px ' + fontStack('sans');
          ctx.textBaseline = 'middle';
          ctx.fillText(midiToName(midi), 10, y + wkW / 2 + 0.5);
        }
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (!IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x -= offPx;
      if (pos.x + bkW < 0 || pos.x - bkW > pitchLen) continue; // 表示窓の外
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#1a1830';
      if (vertical) {
        ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH);
        if (color) {
          ctx.fillStyle = '#1a1830';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH * 0.65);
          ctx.globalAlpha = 1;
        }
      } else {
        const y = H - pos.x - bkW / 2;
        ctx.fillRect(keyLen - bkH, y, bkH, bkW); // 黒鍵はロール側(右端)に付く
        if (color) {
          ctx.fillStyle = '#1a1830';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(keyLen - bkH * 0.65, y, bkH * 0.65, bkW);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // ── KeyboardDisplay クラス ────────────────────────────────────

  class KeyboardDisplay {
    constructor(container) {
      this.container = container;
      container._kbdInstance = this; // 検証/デバッグ用の逆参照(DevToolsからインスタンスに触るため)
      this._state = null;
      this._extraSnaps = null;
      this._chips = [];
      this._rowEls = [];
      this._prevChannels = [];
      this._muteState = new Map(); // channelId → true(muted)
      this._spcVoices = [];       // SPC ボイス状態 [{label,freq,vol,active,color,wave,muted,rawVol,env,volL,volR,pmOn,noiseOn,echoOn}]
      this._spcRowEls = [];       // SPC 用行要素(V0-V7)
      this._spcAllRow = null;     // SPC ALL行(マスター音量/エコー/FIRフィルタ)要素
      this._prevSpcVoices = [];   // 大波形選択用の直近SPCボイス状態
      this._mode = 'nsf';         // 'nsf' | 'spc' — 再生中のファイル種別に応じて表示を排他切替
      this._lastDmc4011 = null;   // DMC $4011 直接書き込み検出用（前回のレジスタ値）
      this._speedDenom = 1;        // 再生速度分母(1〜8。実速度=1/_speedDenom)
      this._rollTimeline = null;  // ピアノロール用ノート区間 [{color, notes:[{startSec,endSec,midi}]}]
      this._rollCursor = {};      // track.id → 「もう画面上端より上に流れ去った」最初のnote index(_renderRollの走査起点キャッシュ)
      this._rollSongTimeBase = 0; // 最後に実測位置が更新された時点での「曲内基準の経過時間」(確定値)
      this._rollLastRawPos = null; // 直前に_renderRollへ渡された実時間(壁時計)位置
      this._rollBaseWallMs = null; // _rollSongTimeBase確定時点のperformance.now()(補間の起点)
      this.onMuteChange = null;
      this.onSpcMuteChange = null; // (voiceIndex:number, muted:bool) => void
      this.onSpeedChange = null;   // (factor:number) => void  曲切替をまたいで保持する
      this.onMasterVolumeChange = null; // (vol:0〜1) => void  曲切替をまたいで保持する
      this.onLayoutChange = null;       // (layout) => void  setLayout()で設定が変わった時
      this.onRollSeek = null;           // (seconds:実時間) => 実際にシークした秒|null  ロールのドラッグシーク(_attachRollSeekDrag)
      this._rollDrag = null;            // ドラッグシーク中の状態 {id,x,y,startPos,pos,moved}
      this._rollSeekBarEls = null;      // ロール見出し行に置くシークバー要素(setRollSeekBar)
      this._lanes = [];                 // チャンネルごとのレーン [{id, laneEl, rollCanvas, pianoCanvas}](_rebuildLanes)
      this._lanesEl = null;
      this._sizeObserver = null;
      this._sourceInfo = null;          // 表示中の再生ソース {kind, name}(setSourceInfo)。タイトル行のバッジに出す
      this._srcBadgeEl = null;
      this._titleEl = null;
      this._rollLastDrawnPos = 0;       // _renderRoll()が最後に描いた曲内秒(ドラッグ開始位置の基準)
      this._masterVolume = loadMasterVolume(); // localStorage永続化(mml_masterVolume)
      this.onVolumeChange = null;       // () => void  ch別音量バー操作時(getVolumeConfig()参照)
      this.onSpcVolumeChange = null;    // (volArray:number[8]) => void
      this._channelVolumes = loadChannelVolumes();   // channelId → 0〜1(localStorage永続化)
      this._spcVoiceVolumes = loadSpcVoiceVolumes(); // [V0..V7] → 0〜1(localStorage永続化)
      this._colorOverrides = loadColorOverrides(); // channelId → ユーザー指定色(localStorage永続化)
      this._layout = loadLayoutSettings();         // ロールの向き/置き場/一覧の多段(localStorage永続化)
      // 下配置でのロール高さ / 右配置での一覧幅(どちらもスプリッターで変更、localStorage永続化)
      this._rollHeight = ROLL_CANVAS_HEIGHT;
      this._listWidth = null;
      try {
        const h = parseInt(localStorage.getItem('mml_pianoRollHeight'), 10);
        if (Number.isFinite(h) && h >= 80) this._rollHeight = h;
        const w = parseInt(localStorage.getItem('mml_keyboardListWidth'), 10);
        if (Number.isFinite(w) && w >= 200) this._listWidth = w;
      } catch (e) { /* ignore */ }
      this._rollCollapsed = false;
      this._bigWaveCollapsed = false;
      this._build();

      /*
       * 言語切替時の作り直し。行のtitle等は "P1 ミュート" のようにチャンネル名を
       * 埋め込んだ文字列なので、i18nDom.js のDOM走査(辞書の完全一致で引く)では
       * 訳せない。T()を通す生成処理そのものを走らせ直す必要がある。
       */
      if (MML.I18n) {
        MML.I18n.onChange(() => {
          const mode = this._mode;
          this._build();               // ウィジェット枠(速度ラベル/ロール見出し/コピーボタン)を作り直す
          // _build() がコンテナを空にするので、行要素の参照も捨てて次のupdate()で作り直させる
          this._rowEls = [];
          this._spcRowEls = [];
          this._spcAllRow = null;
          if (this._prevChannels) this._rebuildRows(this._prevChannels);
          this.setMode(mode);
        });
      }
    }

    _build() {
      // ロールペインは別ウィンドウ(#pianoRollDisplay)に取り付けられていることがあり、
      // container.innerHTML=''では消えないので明示的に外す(言語切替時の作り直し用)
      if (this._rollPaneEl && this._rollPaneEl.parentNode) this._rollPaneEl.parentNode.removeChild(this._rollPaneEl);
      this.container.innerHTML = '';
      this._selectedId = null;   // 大波形表示にユーザーが選んだチャンネルID(ファイル読込でのみリセット)
      this._shownWaveId = null;  // 大波形に今表示しているチャンネルID(選択chが一覧に無い間は若いchを一時表示、_syncShownWave参照)
      this._bigWaveSig = '';     // 大波形の再描画要否判定用

      // 上段: 左=速度バー+チャンネル一覧(+大波形の詳細帯) / 右=選択波形の拡大表示 or ロールペイン
      // (置き場はレイアウト設定で決まる: _mountBigWave()/_mountRollPane()参照。
      //  SPCモードは列数が多いため setMode() で専用レイアウトに切り替える)
      const main = document.createElement('div');
      main.className = 'kbd-main';
      this._mainEl = main;

      const left = document.createElement('div');
      left.className = 'kbd-left';
      this._leftEl = left;

      // マスター音量バー(0〜100%)。フォーマットを問わず全ての音声出力に効く
      // (MML.Audio.getMasterGain、src/audio/stream-player.js参照)。速度バーの
      // すぐ左に置く。localStorageへ即保存し、次回起動時も値を維持する。
      const masterVolBar = document.createElement('div');
      masterVolBar.className = 'kbd-mastervol kbd-mastervol--header';
      const initialPct = Math.round((this._masterVolume != null ? this._masterVolume : 1) * 100);
      masterVolBar.innerHTML =
        `<span class="kbd-mastervol-label">${T('音量')}</span>` +
        `<input type="range" class="kbd-mastervol-range" min="0" max="100" step="1" value="${initialPct}">` +
        `<span class="kbd-mastervol-value">${initialPct}%</span>`;
      const masterVolRange = masterVolBar.querySelector('.kbd-mastervol-range');
      const masterVolValueEl = masterVolBar.querySelector('.kbd-mastervol-value');
      masterVolRange.addEventListener('input', () => {
        const pct = parseInt(masterVolRange.value, 10) || 0;
        const vol = pct / 100;
        this._masterVolume = vol;
        masterVolValueEl.textContent = `${pct}%`;
        saveMasterVolume(vol);
        if (this.onMasterVolumeChange) this.onMasterVolumeChange(vol);
      });

      // 再生速度バー(1/1〜1/8)。音程を保ったままテンポだけを落とす。
      // ウィンドウのタイトル行(タイトル文字の右)に置く。本体側は毎回_build()で
      // 作り直されるため、タイトル行に前回挿入した分を先に取り除いてから差し替える。
      const speedBar = document.createElement('div');
      speedBar.className = 'kbd-speed kbd-speed--header';
      speedBar.innerHTML =
        `<span class="kbd-speed-label">${T('速度')}</span>` +
        `<input type="range" class="kbd-speed-range" min="1" max="8" step="1" value="1">` +
        `<span class="kbd-speed-value">1/1</span>`;
      const speedRange = speedBar.querySelector('.kbd-speed-range');
      const speedValueEl = speedBar.querySelector('.kbd-speed-value');
      speedRange.value = String(this._speedDenom || 1);
      speedValueEl.textContent = `1/${this._speedDenom || 1}`;
      speedRange.addEventListener('input', () => {
        const denom = parseInt(speedRange.value, 10) || 1;
        this._speedDenom = denom;
        speedValueEl.textContent = `1/${denom}`;
        if (this.onSpeedChange) this.onSpeedChange(1 / denom);
      });
      // レイアウト設定ボタン(⚙)。クリックでポップオーバー(_openLayoutPopover)を開く。
      // 速度バーの右(閉じるボタンの手前)に置く
      const layoutBtn = document.createElement('button');
      layoutBtn.type = 'button';
      layoutBtn.className = 'kbd-layout-btn';
      layoutBtn.title = T('鍵盤表示のレイアウト設定');
      layoutBtn.setAttribute('aria-label', T('鍵盤表示のレイアウト設定'));
      layoutBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 12h14M9 3v9"/></svg>';
      layoutBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openLayoutPopover(layoutBtn); });

      const winEl = this.container.closest('.float-window');
      const headerEl = winEl && winEl.querySelector('.float-window-header');
      if (headerEl) {
        for (const sel of ['.kbd-mastervol', '.kbd-speed', '.kbd-layout-btn', '.kbd-src-badge']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        const closeBtn = headerEl.querySelector('.float-window-close');
        headerEl.insertBefore(layoutBtn, closeBtn || null);
        headerEl.insertBefore(speedBar, layoutBtn);
        headerEl.insertBefore(masterVolBar, speedBar);
        // タイトル: 「鍵盤表示」+ 何を表示しているかのバッジ(MML / NSF · ファイル名 等。
        // どちらを再生中なのか分かりづらいという要望から。setSourceInfo()で更新)
        const titleEl = headerEl.querySelector('span');
        if (titleEl && !titleEl.classList.contains('kbd-src-badge')) {
          titleEl.textContent = T('鍵盤表示');
          this._titleEl = titleEl;
        }
        this._srcBadgeEl = document.createElement('span');
        this._srcBadgeEl.className = 'kbd-src-badge';
        if (this._titleEl) this._titleEl.insertAdjacentElement('afterend', this._srcBadgeEl);
        else headerEl.insertBefore(this._srcBadgeEl, masterVolBar);
        this._renderSourceBadge();
      } else {
        left.appendChild(masterVolBar); // フォールバック(タイトル行が見つからない場合)
        left.appendChild(speedBar);
        left.appendChild(layoutBtn);
      }

      const header = document.createElement('div');
      header.className = 'kbd-header';
      header.innerHTML =
        `<span class="kbd-h-part">part</span>` +
        `<span class="kbd-h-mute-solo" title="mute">\u{1F507}</span>` +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        `<span class="kbd-h-vol">vol</span>` +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbd-h-freq">freq</span>`;
      // L/R列(SPCのステレオパン表示と同じクラスを流用)はHES(PSG)のみ値が入り、
      // 他フォーマットは空欄のまま(_rebuildRows参照)。
      // dot 列オフセット不要（kbd-h-part が dot+パート文字両方をカバー）
      this._headerEl = header;
      left.appendChild(header);

      this._rowsEl = document.createElement('div');
      this._rowsEl.className = 'kbd-rows';
      // 行本体は内側の要素に入れる(.kbd-rowsは縦スクロールの箱、.kbd-rows-innerが1列/多段の
      // 並べ方を担当。多段のとき高さauto=中身なりに伸びるので、はみ出しは横でなく縦スクロールになる)
      this._rowsInnerEl = document.createElement('div');
      this._rowsInnerEl.className = 'kbd-rows-inner';
      this._rowsEl.appendChild(this._rowsInnerEl);
      left.appendChild(this._rowsEl);

      // SPC ボイス用セクション（再生中のみ表示）。列数がNSFと異なるため専用ヘッダーを持つが、
      // NSF側と同じく left 直下に置く（left 側の幅は .kbd-left--spc で少し広げる）。
      // ボイス単位のレジスタが無いマスター値(エコー音量L/R、FIR係数C0-C7)は列にせず、
      // ALL行の下の1行(.kbds-master、updateSpcVoices参照)にまとめて表示する。
      this._spcHeaderEl = document.createElement('div');
      this._spcHeaderEl.className = 'kbd-header kbds-header';
      this._spcHeaderEl.style.display = 'none';
      this._spcHeaderEl.innerHTML =
        `<span class="kbd-h-mute">mute</span>` +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        `<span class="kbd-h-vol">vol</span>` +
        `<span class="kbds-h-env">env</span>` +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbds-h-pm">PM</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbds-h-freq">freq</span>` +
        `<span class="kbds-h-echo">echo</span>`;
      left.appendChild(this._spcHeaderEl);

      this._spcSectionEl = document.createElement('div');
      this._spcSectionEl.className = 'kbd-rows';
      this._spcSectionEl.style.display = 'none';
      left.appendChild(this._spcSectionEl);

      // 選択チャンネルの素波形を拡大表示（表示サイズ固定・要素数はX/Y数値で表現）。
      // 置き場は一覧の右(従来)または一覧の下の折りたたみ帯(_mountBigWave()参照)
      const big = document.createElement('div');
      big.className = 'kbd-bigwave';
      const bigHeader = document.createElement('div');
      bigHeader.className = 'kbd-bigwave-header';
      // 折りたたみトグル(一覧の下に置く配置でだけ表示。状態はlocalStorageに保存)。既定は畳んだ状態
      // (一覧の高さを優先)で、波形アイコンをクリックして選んだときに自動で開く(_selectWave参照)
      try { this._bigWaveCollapsed = localStorage.getItem('mml_bigWaveCollapsed') !== '0'; } catch (e) { this._bigWaveCollapsed = true; }
      this._bigToggleEl = document.createElement('span');
      this._bigToggleEl.className = 'kbd-bigwave-toggle';
      this._bigToggleEl.textContent = this._bigWaveCollapsed ? '▶' : '▼';
      this._bigToggleEl.title = T('大波形の表示/非表示');
      this._bigToggleEl.addEventListener('click', () => {
        this._bigWaveCollapsed = !this._bigWaveCollapsed;
        try { localStorage.setItem('mml_bigWaveCollapsed', this._bigWaveCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      });
      this._bigTitleEl = document.createElement('div');
      this._bigTitleEl.className = 'kbd-bigwave-title';
      this._bigTitleEl.textContent = 'Click a wave icon to enlarge';
      // 波形エディタ(FDS波形エディタ等)との相互コピペ用。実際の波形テーブルを
      // 持つ表示(t:'wave')のときだけ有効化する(ノイズ/PCM等は固有波形が無いため不可)
      this._bigCopyBtn = document.createElement('button');
      this._bigCopyBtn.className = 'kbd-bigwave-copy secondary';
      this._bigCopyBtn.textContent = T('📋コピー');
      this._bigCopyBtn.title = T('この波形データをクリップボードへコピー(他の波形エディタへ貼り付け可)');
      this._bigCopyBtn.disabled = true;
      this._bigWaveCopyData = null;
      this._bigCopyBtn.addEventListener('click', () => {
        if (!this._bigWaveCopyData || !(MML.UI && MML.UI.WaveClipboard)) return;
        MML.UI.WaveClipboard.copyValues(this._bigWaveCopyData).then((ok) => {
          const orig = T('📋コピー');
          this._bigCopyBtn.textContent = ok ? T('✓ コピー完了') : T('✗ 失敗');
          setTimeout(() => { this._bigCopyBtn.textContent = orig; }, 1000);
        });
      });
      bigHeader.appendChild(this._bigToggleEl);
      bigHeader.appendChild(this._bigTitleEl);
      bigHeader.appendChild(this._bigCopyBtn);
      this._bigCanvas = document.createElement('canvas');
      this._bigCanvas.className = 'kbd-bigwave-canvas';
      this._bigCanvas.width = 560;   // 内部解像度(表示の2倍)。表示サイズは.kbd-bigwave-canvasで指定
      this._bigCanvas.height = 280;
      // 表示サイズが変わったら(一覧の下に幅いっぱいで置く配置など)内部解像度を表示幅の2倍に
      // 合わせて描き直す(drawBigWave()は幅基準でスケールするので解像度が変わっても比率は保たれる)。
      // ★高さは表示高さから取らず常に幅の1/2にする: height:autoのcanvasは属性の縦横比で表示高さが
      // 決まるため、表示高さ→属性高さと決めると互いに追いかけて比率が崩れる
      new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cw = Math.round(entry.contentRect.width * 2), chh = Math.round(cw / 2);
          if (cw <= 0 || chh <= 0) continue;
          if (this._bigCanvas.width === cw && this._bigCanvas.height === chh) continue;
          this._bigCanvas.width = cw;
          this._bigCanvas.height = chh;
          this._bigWaveSig = '';
          if (this._shownWaveId) {
            const sel = (this._prevChannels || []).concat(this._prevSpcVoices || []).find(c => c.id === this._shownWaveId);
            if (sel) this._renderBigWave(sel);
          }
        }
      }).observe(this._bigCanvas);
      big.appendChild(bigHeader);
      big.appendChild(this._bigCanvas);
      this._bigWaveEl = big;

      // 一覧と右隣(大波形 or ロールペイン)の間のスプリッター(ロールを右に置く配置でのみ表示。
      // ドラッグで一覧の幅を変える。幅はlocalStorageに保存)
      this._listSplitterEl = this._makeSplitter('vertical', (delta, start) => {
        const w = Math.max(200, Math.round(start + delta));
        this._listWidth = w;
        left.style.width = w + 'px';
      }, () => left.offsetWidth, () => {
        try { localStorage.setItem('mml_keyboardListWidth', String(this._listWidth)); } catch (e) { /* ignore */ }
      });
      // 一覧(上段)とロールペイン(下段)の間のスプリッター(ロールを下に置く配置でのみ表示。
      // ドラッグでロールの高さを変える。高さはlocalStorageに保存)
      this._rollSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
        const h = Math.max(80, Math.round(start - delta)); // 上へドラッグ=ロールが高くなる
        this._setRollHeight(h);
      }, () => this._rollHeight, () => {
        try { localStorage.setItem('mml_pianoRollHeight', String(this._rollHeight)); } catch (e) { /* ignore */ }
      });

      main.appendChild(left);
      this.container.appendChild(main);

      // ピアノロール+鍵盤(ロールペイン)。自己完結したDOM塊として作り、レイアウト設定に
      // 応じた置き場(一覧の下/右/別ウィンドウ)へ_mountRollPane()で取り付ける。
      this._buildRollPane();
      this._mountRollPane();
      this._mountBigWave();
      this._applyLayoutClasses();
    }

    // ドラッグ可能な仕切り。orientation='vertical'は縦線(左右のペインを分ける、横ドラッグ)、
    // 'horizontal'は横線(上下のペインを分ける、縦ドラッグ)。
    // onDrag(delta, startSize): ドラッグ中に毎回、startSizeはgetStart()でドラッグ開始時に取得。
    // onEnd(): ドラッグ終了時(永続化用)。
    _makeSplitter(orientation, onDrag, getStart, onEnd) {
      const el = document.createElement('div');
      el.className = 'kbd-splitter kbd-splitter--' + orientation;
      let startPos = 0, startSize = 0, active = false;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        active = true;
        startPos = orientation === 'vertical' ? e.clientX : e.clientY;
        startSize = getStart();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => {
        if (!active) return;
        const cur = orientation === 'vertical' ? e.clientX : e.clientY;
        onDrag(cur - startPos, startSize);
      });
      const finish = (e) => {
        if (!active) return;
        active = false;
        el.classList.remove('dragging');
        try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (onEnd) onEnd();
      };
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
      return el;
    }

    // ロールを一覧の下に置く配置でのロールcanvasの高さ(px)を設定する(スプリッター/初期化から)
    _setRollHeight(h) {
      this._rollHeight = h;
      if (this._rollCanvas) this._applyLayoutClasses(); // ロールcanvas/レーン群の高さへ反映
    }

    // ── ロールペイン(ピアノロール見出し+ロールcanvas+鍵盤canvas)の構築 ─────────
    // ロールは未来の音符を鍵盤へ向かって流して表示する(向きは_layout.rollOrientation、
    // 座標系はmakeRollGeom()参照)。折りたたみ状態は localStorage に保存し次回起動時も維持する。
    _buildRollPane() {
      const rollWrap = document.createElement('div');
      rollWrap.className = 'kbd-roll-wrap';
      this._rollPaneEl = rollWrap;
      const rollHeader = document.createElement('div');
      rollHeader.className = 'kbd-roll-header';
      let rollCollapsed = false;
      try { rollCollapsed = localStorage.getItem('mml_pianoRollCollapsed') === '1'; } catch (e) { /* ignore */ }
      try { this._showCentsOverlay = localStorage.getItem('mml_pianoRollCentsOverlay') === '1'; } catch (e) { this._showCentsOverlay = false; }
      rollHeader.innerHTML =
        `<span class="kbd-roll-toggle">${rollCollapsed ? '▶' : '▼'}</span>` +
        `<span class="kbd-roll-label">${T('ピアノロール')}</span>` +
        `<span class="kbd-roll-seek-slot"></span>` + // main.jsから渡されるシークバー(setRollSeekBar)の置き場
        `<label class="kbd-roll-cents-toggle">` +
        `<input type="checkbox" class="kbd-roll-cents-checkbox"${this._showCentsOverlay ? ' checked' : ''}>` +
        `${T('セント偏差')}</label>`;
      // シークバー(range input/ハンドル)の操作でロールの折りたたみ(見出しclick)を起こさない
      const seekSlot = rollHeader.querySelector('.kbd-roll-seek-slot');
      seekSlot.addEventListener('click', (e) => e.stopPropagation());
      seekSlot.addEventListener('mousedown', (e) => e.stopPropagation());
      this._mountRollSeekBar(seekSlot);
      // オーバーレイのON/OFFはロール見出しクリック(折りたたみ)とは独立させるため、
      // クリックイベントの伝播をここで止める(bubbling先のrollHeaderハンドラを発火させない)。
      const centsCheckbox = rollHeader.querySelector('.kbd-roll-cents-checkbox');
      centsCheckbox.addEventListener('click', (e) => e.stopPropagation());
      centsCheckbox.addEventListener('change', () => {
        this._showCentsOverlay = centsCheckbox.checked;
        try { localStorage.setItem('mml_pianoRollCentsOverlay', this._showCentsOverlay ? '1' : '0'); } catch (e) { /* ignore */ }
      });
      this._rollCanvas = document.createElement('canvas');
      this._rollCanvas.className = 'kbd-roll';
      this._rollCanvas.height = ROLL_CANVAS_HEIGHT;
      // 折りたたみは「一覧の下」配置でのみ有効(右/別ウィンドウ配置ではロールがペインの
      // 主役なので畳む意味が薄く、別ウィンドウは閉じれば済む)。表示状態の反映は
      // _applyLayoutClasses()に集約する
      rollHeader.addEventListener('click', () => {
        if (this._effectivePlacement() !== 'bottom') return;
        const collapsed = !this._rollCollapsed;
        this._rollCollapsed = collapsed;
        try { localStorage.setItem('mml_pianoRollCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        // 畳んだらロールの高さぶんウィンドウ自体を縮め(=鍵盤が上へ詰まる)、
        // 開いたらロールの高さぶん広げる(=鍵盤がロールの下へ移動する)。
        // こうしないとチャンネル一覧(.kbd-main, flex:1 1 auto)が伸縮を全部吸収してしまい、
        // 折りたたんでも窓の高さが変わらず鍵盤の位置も動かない。増減量はペインの実測高さの
        // 差分(まとめ表示ならロール高さ、レーン表示ならレーン全体の高さ)。
        // 高さの永続化は floatingWindows.js の ResizeObserver → persist() が行う。
        const win = rollWrap.closest('.float-window');
        const before = rollWrap.offsetHeight;
        this._applyLayoutClasses();
        const after = rollWrap.offsetHeight;
        if (win) {
          const cur = parseInt(win.style.height, 10) || win.offsetHeight;
          win.style.height = Math.max(MIN_WINDOW_HEIGHT, cur + (after - before)) + 'px';
        }
      });
      this._rollCollapsed = rollCollapsed;
      this._rollHeaderEl = rollHeader;
      this._attachRollSeekDrag(this._rollCanvas);

      // 鍵盤canvas。ロールと同じペインに入れる(音符が鍵盤へ流れ着く一体表示のため、
      // ロールの置き場が変わっても必ず一緒に動く)
      this._canvas = document.createElement('canvas');
      this._canvas.className = 'kbd-piano';
      this._canvas.height = PIANO_KEY_LEN;
      // 鍵盤canvasはサイズ決め用のラッパー(.kbd-piano-wrap)の中に絶対配置で入れる。
      // canvas要素はwidth/height属性が「固有サイズ」としてレイアウトに効くため、横向きの
      // 横並びレイアウトで古い属性値(前の配置での高さ)が行の高さを押し広げてしまう。
      // 絶対配置ならレイアウトに寄与せず、常にラッパーのサイズに追随する
      const pianoWrap = document.createElement('div');
      pianoWrap.className = 'kbd-piano-wrap';
      pianoWrap.appendChild(this._canvas);
      this._pianoWrapEl = pianoWrap;

      // 本体(ロール+鍵盤)。縦向きは縦積み(ロールの下に鍵盤)、横向きは横並び(鍵盤の右にロール)。
      // 向きの切替はCSSクラス(.kbd-roll-wrap--horizontal)で行う(_applyLayoutClasses参照)
      const body = document.createElement('div');
      body.className = 'kbd-roll-body';
      body.appendChild(this._rollCanvas);
      body.appendChild(pianoWrap);
      this._rollBodyEl = body;

      // チャンネルごとのレーン表示(rollLanes='perChannel')用のコンテナ。中身(各レーンの
      // ロール+鍵盤canvas)は_rebuildLanes()が使用チャンネルに合わせて作り直す。
      // 縦向きはレーンが横に並び(横スクロール)、横向きは縦に積まれる(縦スクロール)
      const lanes = document.createElement('div');
      lanes.className = 'kbd-lanes';
      this._lanesEl = lanes;
      this._lanes = [];

      rollWrap.appendChild(rollHeader);
      rollWrap.appendChild(body);
      rollWrap.appendChild(lanes);

      // drawPiano()/_renderRoll()は毎フレーム(60fps)canvasの表示サイズを必要とするが、
      // canvas.offsetWidth/Heightを直接読むと毎回強制同期レイアウトが走る(要素のサイズ自体は
      // リサイズ時以外変わらないのに)。MML再生ハイライト機能の毎フレームDOM更新と
      // 同じフレーム内で両方が動くと、この強制レイアウトがお互いの保留中のDOM変更を
      // 巻き込んで重くなる(レイアウトスラッシング)。ResizeObserverで実際にリサイズ
      // された時だけ幅・高さをキャッシュし、毎フレームの読み取りをキャッシュ参照に置き換える
      // (レーンのcanvasも_rebuildLanes()で同じオブザーバに登録する)
      this._sizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          entry.target._cachedWidth = Math.round(entry.contentRect.width);
          entry.target._cachedHeight = Math.round(entry.contentRect.height);
        }
      });
      this._sizeObserver.observe(this._rollCanvas);
      this._sizeObserver.observe(this._canvas);
      this._rebuildLanes();
      this._applyLayoutClasses();
    }

    // チャンネルごとのレーン表示の中身を、現在の一覧(NSF等: _rowEls / SPC: _spcRowEls)に
    // 合わせて作り直す。各レーンは [ラベル(色丸+パート文字+ch名)] + [ロールcanvas+鍵盤canvas]。
    // 一覧が組み直された時(_rebuildRows/updateSpcVoices/setMode)と設定切替時に呼ぶ。
    // 'all'モードでは中身を空にしておく(描画コストをかけない)
    _rebuildLanes() {
      const lanesEl = this._lanesEl;
      if (!lanesEl) return;
      // 古いcanvasの監視解除
      for (const l of this._lanes) {
        try { this._sizeObserver.unobserve(l.rollCanvas); this._sizeObserver.unobserve(l.pianoCanvas); } catch (e) { /* ignore */ }
      }
      this._lanes = [];
      lanesEl.innerHTML = '';
      if (this._layout.rollLanes !== 'perChannel') return;
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.waveCanvas);
      for (const rowEl of rows) {
        const lane = document.createElement('div');
        lane.className = 'kbd-lane';
        const label = document.createElement('div');
        label.className = 'kbd-lane-label';
        const nameEl = rowEl.row.querySelector('.kbd-name');
        label.innerHTML = `<span class="kbd-lane-dot" style="background:${rowEl.color}"></span>` +
          `<span class="kbd-lane-text">${rowEl.letter ? rowEl.letter + ' ' : ''}${nameEl ? nameEl.textContent : rowEl.id}</span>`;
        label.title = rowEl.id;
        const rollCanvas = document.createElement('canvas');
        rollCanvas.className = 'kbd-roll';
        rollCanvas.height = ROLL_CANVAS_HEIGHT;
        this._attachRollSeekDrag(rollCanvas);
        const pianoCanvas = document.createElement('canvas');
        pianoCanvas.className = 'kbd-piano';
        pianoCanvas.height = PIANO_KEY_LEN;
        const pianoWrap = document.createElement('div');
        pianoWrap.className = 'kbd-piano-wrap';
        pianoWrap.appendChild(pianoCanvas);
        const body = document.createElement('div');
        body.className = 'kbd-roll-body kbd-lane-body';
        body.appendChild(rollCanvas);
        body.appendChild(pianoWrap);
        lane.appendChild(label);
        lane.appendChild(body);
        lanesEl.appendChild(lane);
        this._sizeObserver.observe(rollCanvas);
        this._sizeObserver.observe(pianoCanvas);
        this._lanes.push({ id: rowEl.id, laneEl: lane, rollCanvas, pianoCanvas, scrollWhite: null });
      }
    }

    // 鍵盤描画: 全チャンネルまとめ(1枚)か、レーンごと(そのchだけ)か
    _drawPianos(allChannels) {
      if (this._layout.rollLanes === 'perChannel' && this._lanes.length) {
        for (const l of this._lanes) {
          // 音程窓はロール側(_updateLaneScroll)が決めた位置に合わせる(未決定なら鍵盤全体の代わりにC4中心)
          const off = l.scrollWhite == null ? Math.max(0, keyX(60, 1).x - LANE_VISIBLE_WHITE / 2) : l.scrollWhite;
          drawPiano(l.pianoCanvas, allChannels.filter(c => c.id === l.id), this._layout.rollOrientation, LANE_VISIBLE_WHITE, off);
        }
        return;
      }
      drawPiano(this._canvas, allChannels, this._layout.rollOrientation);
    }

    // 表示中の再生ソースをタイトル行のバッジに出す。kind: 'mml' | 'nsf'|'spc'|'kss'|'gbs'|'hes'
    // (サウンドファイル) | null(未ロード)。name: ファイル名や曲名(省略可)。
    // main.js が MML再生の準備(prepareMmlStream)と各loadXxxFile()で呼ぶ。
    setSourceInfo(kind, name) {
      this._sourceInfo = kind ? { kind, name: name || '' } : null;
      this._renderSourceBadge();
    }
    _renderSourceBadge() {
      const el = this._srcBadgeEl;
      if (!el) return;
      const info = this._sourceInfo;
      el.classList.remove('kbd-src-badge--mml', 'kbd-src-badge--file');
      if (!info) { el.textContent = ''; el.title = ''; el.style.display = 'none'; return; }
      el.style.display = '';
      const isMml = info.kind === 'mml';
      el.classList.add(isMml ? 'kbd-src-badge--mml' : 'kbd-src-badge--file');
      const kindLabel = info.kind.toUpperCase();
      // 表示は「MML · タイトル」/「NSF · ファイル名」。長い名前は省略記号にしてtitleに全文
      const name = info.name || '';
      el.textContent = name ? `${kindLabel} · ${name}` : kindLabel;
      el.title = (isMml ? T('MML再生を表示中') : T('サウンドファイル再生を表示中')) + (name ? `: ${name}` : '');
    }

    // 大波形に「今表示するch」(_shownWaveId)を、表示中の一覧(rowEls)に合わせて決め直す。
    // ユーザーが選んだch(_selectedId)が一覧にあればそれ、無ければ一番若いch(波形アイコンを
    // 持つ最初の行)を一時的に表示する。_selectedId自体はここでは変えない(停止→再生や曲送りで
    // 一覧が一時的に2A03だけになっても、選択が勝手に若いchへ変わってしまわないように。
    // 選択を捨てて若いchへ戻すのはファイルの読み込み直し=reset()のときだけ)。
    // 一覧の下の折りたたみ帯は自動で開かない(ユーザーがクリックしたときだけ開く)
    _syncShownWave(rowEls) {
      const rows = (rowEls || []).filter(el => el.waveCanvas);
      const keep = rows.find(el => el.id === this._selectedId);
      const target = keep || rows[0];
      const id = target ? target.id : null;
      if (id !== this._shownWaveId) this._bigWaveSig = '';
      this._shownWaveId = id;
      for (const el of this._rowEls.concat(this._spcRowEls)) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === id);
      }
      if (!id) return;
      const ch = (this._prevChannels || []).find(c => c.id === id) ||
                 (this._prevSpcVoices || []).find(c => c.id === id);
      if (ch) this._renderBigWave(ch);
    }

    // ロール見出し行に置くシークバー(MMLエディタのトランスポート行と同じもの。DOMはmain.jsが
    // createSeekBarInstance()で作り位置/範囲/時間表示を同期し続けるので、ここでは置くだけ)。
    // 言語切替で見出しを作り直しても同じ要素を差し戻す(_buildRollPane→_mountRollSeekBar)。
    setRollSeekBar(wrapEl, timeEl) {
      this._rollSeekBarEls = wrapEl ? { wrapEl, timeEl } : null;
      const slot = this._rollHeaderEl && this._rollHeaderEl.querySelector('.kbd-roll-seek-slot');
      if (slot) this._mountRollSeekBar(slot);
    }
    _mountRollSeekBar(slot) {
      const els = this._rollSeekBarEls;
      slot.innerHTML = '';
      if (!els) return;
      slot.appendChild(els.wrapEl);
      if (els.timeEl) slot.appendChild(els.timeEl);
    }

    // ── ロールをドラッグしてシーク ─────────────────────────────────
    // ロール上でポインタを押して動かすと、音符の流れる方向に沿って再生位置を動かす
    // (縦向き=上下: 下へ引くと未来の音符が鍵盤へ近づく=進む / 横向き=左右: 左へ引くと進む)。
    // 1px = 1/ROLL_PX_PER_SEC 秒(ロールの時間軸スケールと同じなので、つかんだ音符が指に付いてくる)。
    // 実際のシークは onRollSeek(実時間の秒) に委ね(main.js: seekToSeconds)、ドラッグ中は
    // 間引いて呼び、離した時に最終位置で呼ぶ。返ってきた(クランプ後の)秒で表示位置を合わせる。
    // ドラッグ中の描画は _renderRoll() が _rollDrag.pos を優先する。
    _attachRollSeekDrag(canvas) {
      canvas.classList.add('kbd-roll--seekable');
      canvas.title = T('ドラッグでシーク(縦向きは上下、横向きは左右)');
      const SEEK_THROTTLE_MS = 60;
      let lastSeekMs = 0;
      const applySeek = (songSec, force) => {
        const nowMs = performance.now();
        if (!force && nowMs - lastSeekMs < SEEK_THROTTLE_MS) return;
        lastSeekMs = nowMs;
        if (!this.onRollSeek) return;
        // ロールの位置は曲内の絶対秒。プレイヤー/シークバーの秒は「現在の再生速度での実時間」
        // なので速度分母を掛けて渡す(逆変換は _renderRoll のrawPos*speedFactor参照)
        const denom = this._speedDenom || 1;
        const got = this.onRollSeek(songSec * denom);
        if (typeof got === 'number' && Number.isFinite(got)) this._rollDrag.pos = got / denom;
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this._rollTimeline) return;
        this._rollDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, startPos: this._rollLastDrawnPos || 0, pos: this._rollLastDrawnPos || 0, moved: false };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャ不可でも要素上のmoveで追従する */ }
        canvas.classList.add('dragging');
        e.preventDefault();
      });
      canvas.addEventListener('pointermove', (e) => {
        const d = this._rollDrag;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return; // クリック程度の揺れでは動かさない
        d.moved = true;
        const vertical = this._layout.rollOrientation !== 'horizontal';
        const deltaSec = (vertical ? dy : -dx) / ROLL_PX_PER_SEC;
        d.pos = Math.max(0, d.startPos + deltaSec);
        applySeek(d.pos, false);
        this._renderRoll(this._rollLastRawPosForDrag()); // 即座に追従して描く
      });
      const finish = (e) => {
        const d = this._rollDrag;
        if (!d || e.pointerId !== d.id) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        canvas.classList.remove('dragging');
        if (d.moved) applySeek(d.pos, true);
        this._rollDrag = null;
        // 次の実測位置から補間を組み直す(シーク後の位置に即座に揃える)
        this._rollLastRawPos = null;
        this._rollCursor = {};
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
    }
    // ドラッグ中に_renderRoll()を即時呼びするための「直前の実測位置」(無ければ0)。
    // _renderRoll()はドラッグ中は表示位置に_rollDrag.posを使うので値自体は補間の帳尻用
    _rollLastRawPosForDrag() { return this._rollLastRawPos == null ? 0 : this._rollLastRawPos; }

    // 実効的なロールの置き場。'window'は別ウィンドウのコンテナ(#pianoRollDisplay)が
    // 無いページでは'bottom'扱いにする
    _effectivePlacement() {
      const p = this._layout.rollPlacement;
      if (p === 'window' && !document.getElementById('pianoRollDisplay')) return 'bottom';
      return p;
    }

    // ロールペインをレイアウト設定(_layout.rollPlacement)に応じた親へ取り付ける。
    //   'bottom': チャンネル一覧(.kbd-main)の下(従来配置)。手前にロール高さ用スプリッター
    //   'right' : 一覧の右(.kbd-main内)。手前に一覧幅用スプリッター
    //   'window': 別ウィンドウ(#pianoRollDisplay)
    _mountRollPane() {
      const pane = this._rollPaneEl;
      if (!pane) return;
      if (pane.parentNode) pane.parentNode.removeChild(pane);
      for (const sp of [this._listSplitterEl, this._rollSplitterEl]) {
        if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
      }
      const placement = this._effectivePlacement();
      if (placement === 'right') {
        this._mainEl.appendChild(this._listSplitterEl);
        this._mainEl.appendChild(pane);
      } else if (placement === 'window') {
        document.getElementById('pianoRollDisplay').appendChild(pane);
      } else {
        this.container.appendChild(this._rollSplitterEl);
        this.container.appendChild(pane);
      }
    }

    // 大波形パネルの置き場。ロールが一覧の下で一覧が1列(従来レイアウト)のときは一覧の右、
    // それ以外(右側をロールが使う/一覧が幅いっぱいに広がる)は一覧の下の折りたたみ帯に置く
    _bigWaveBelow() {
      return this._effectivePlacement() !== 'bottom' || this._layout.listColumns === 'auto';
    }
    _mountBigWave() {
      const big = this._bigWaveEl;
      if (!big) return;
      if (big.parentNode) big.parentNode.removeChild(big);
      if (this._bigWaveBelow()) this._leftEl.appendChild(big);
      else this._mainEl.appendChild(big);
    }

    // レイアウト設定をCSSクラス/インラインサイズへ反映する(向き・置き場・多段・折りたたみ)
    _applyLayoutClasses() {
      const L = this._layout;
      const placement = this._effectivePlacement();
      const horizontal = L.rollOrientation === 'horizontal';
      const below = this._bigWaveBelow();
      const pane = this._rollPaneEl;
      if (pane) {
        pane.classList.toggle('kbd-roll-wrap--horizontal', horizontal);
        // 右/別ウィンドウ配置ではペインが親いっぱいに広がる(ロールがflex:1)。下配置は固定高さ
        pane.classList.toggle('kbd-roll-wrap--fill', placement !== 'bottom');
        pane.classList.toggle('kbd-roll-wrap--nocollapse', placement !== 'bottom');
        pane.classList.toggle('kbd-roll-wrap--window', placement === 'window'); // 窓のタイトルと二重になる見出しラベルを隠す
        // チャンネルごとのレーン表示: まとめ表示の本体(.kbd-roll-body)を隠してレーン群を出す
        const lanesMode = L.rollLanes === 'perChannel';
        pane.classList.toggle('kbd-roll-wrap--lanes', lanesMode);
        const collapsed = placement === 'bottom' && this._rollCollapsed;
        this._rollCanvas.style.display = collapsed ? 'none' : '';
        if (this._lanesEl) this._lanesEl.style.display = (collapsed || !lanesMode) ? 'none' : '';
        const toggle = this._rollHeaderEl && this._rollHeaderEl.querySelector('.kbd-roll-toggle');
        if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
        // 下配置は固定高さ(スプリッターで可変)。レーン表示のコンテナは各レーンに鍵盤も含むので、
        // 縦向きはロール高さ+鍵盤高さぶん確保して全体の高さをまとめ表示と揃える
        this._rollCanvas.style.height = placement === 'bottom' ? (this._rollHeight + 'px') : '';
        if (this._lanesEl) {
          this._lanesEl.style.height = placement === 'bottom'
            ? ((this._rollHeight + (horizontal ? 0 : PIANO_KEY_LEN)) + 'px') : '';
        }
      }
      const left = this._leftEl;
      if (left) {
        // 一覧の幅: 右配置=スプリッターで決めた固定幅 / 下配置で1列=CSS既定の固定幅(従来) /
        // それ以外(下配置で多段、別ウィンドウ配置)=幅いっぱい
        const flexible = placement === 'window' || (placement === 'bottom' && L.listColumns === 'auto');
        left.classList.toggle('kbd-left--flex', flexible);
        left.classList.toggle('kbd-left--multicol', L.listColumns === 'auto');
        // 大波形を一覧の下に置くときは、行一覧を伸ばして最下部に張り付けるのでなく
        // チャンネル行のすぐ下に続ける(行が少ないと間が空いて「左下」に見えるため)
        left.classList.toggle('kbd-left--wave-below', below);
        // 右配置の一覧幅。SPCモードは列が多いので全列が収まる幅(SPC_LIST_MIN_WIDTH)を下限にする
        let w = '';
        if (placement === 'right') {
          const min = this._mode === 'spc' ? SPC_LIST_MIN_WIDTH : 0;
          const want = Math.max(this._listWidth || 0, min);
          if (want > 0) w = want + 'px';
        }
        left.style.width = w;
      }
      const big = this._bigWaveEl;
      if (big) {
        big.classList.toggle('kbd-bigwave--below', below);
        big.classList.toggle('kbd-bigwave--collapsed', below && this._bigWaveCollapsed);
        this._bigToggleEl.textContent = this._bigWaveCollapsed ? '▶' : '▼';
      }
      if (this._mainEl) this._mainEl.classList.toggle('kbd-main--roll-right', placement === 'right');
    }

    // 現在のレイアウト設定(コピー)を返す
    getLayout() { return Object.assign({}, this._layout); }

    // レイアウト設定を部分的に変更して即反映・永続化する。
    // 例: setLayout({ rollOrientation: 'horizontal' })
    setLayout(partial) {
      let changed = false;
      for (const k of Object.keys(LAYOUT_DEFAULTS)) {
        if (partial && LAYOUT_CHOICES[k].includes(partial[k]) && partial[k] !== this._layout[k]) {
          this._layout[k] = partial[k];
          changed = true;
        }
      }
      if (!changed) return;
      saveLayoutSettings(this._layout);
      this._mountRollPane();
      this._mountBigWave();
      this._rebuildLanes();
      this._applyLayoutClasses();
      // canvasの内部解像度は次の描画でサイズキャッシュから決め直す。向きが変わると
      // 表示サイズも変わるので、古いキャッシュ値で1フレーム描かないよう捨てておく
      for (const c of [this._rollCanvas, this._canvas]) {
        if (!c) continue;
        delete c._cachedWidth;
        delete c._cachedHeight;
      }
      this._rollCursor = {};
      this._rollLastRawPos = null;
      if (this._shownWaveId) this._bigWaveSig = ''; // 置き場が変わった大波形は描き直す
      if (this.onLayoutChange) this.onLayoutChange(this.getLayout());
    }

    // レイアウト設定のポップオーバー(⚙ボタン直下)。ラジオ3組(向き/置き場/一覧)で即反映。
    // 外側クリック/Escで閉じる。既に開いていれば閉じる(トグル)。
    _openLayoutPopover(anchorEl) {
      if (this._layoutPopEl) { this._closeLayoutPopover(); return; }
      const groups = [
        { key: 'rollOrientation', label: T('ピアノロールの向き'), options: [
          ['vertical', T('縦 (音符が上から鍵盤へ降る)')],
          ['horizontal', T('横 (音符が右から鍵盤へ流れる)')],
        ] },
        { key: 'rollPlacement', label: T('ピアノロールの置き場'), options: [
          ['bottom', T('チャンネル一覧の下')],
          ['right', T('チャンネル一覧の右')],
          ['window', T('別ウィンドウ')],
        ] },
        { key: 'listColumns', label: T('チャンネル一覧'), options: [
          ['single', T('1列')],
          ['auto', T('幅に応じて自動で多段')],
        ] },
        { key: 'rollLanes', label: T('ピアノロールの鍵盤'), options: [
          ['all', T('全チャンネルを1つの鍵盤に')],
          ['perChannel', T('チャンネルごとに分割 (収まらない分はスクロール)')],
        ] },
      ];
      const pop = document.createElement('div');
      pop.className = 'kbd-layout-pop';
      pop.addEventListener('mousedown', (e) => e.stopPropagation()); // ウィンドウのドラッグ/前面化を起こさない
      pop.addEventListener('click', (e) => e.stopPropagation());
      for (const g of groups) {
        const sec = document.createElement('div');
        sec.className = 'kbd-layout-sec';
        const title = document.createElement('div');
        title.className = 'kbd-layout-sec-title';
        title.textContent = g.label;
        sec.appendChild(title);
        for (const [value, text] of g.options) {
          const lab = document.createElement('label');
          lab.className = 'kbd-layout-opt';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'kbd-layout-' + g.key;
          radio.value = value;
          radio.checked = this._layout[g.key] === value;
          radio.addEventListener('change', () => { if (radio.checked) this.setLayout({ [g.key]: value }); });
          lab.appendChild(radio);
          lab.appendChild(document.createTextNode(text));
          sec.appendChild(lab);
        }
        pop.appendChild(sec);
      }
      document.body.appendChild(pop);
      // アンカー(⚙)の直下、右端揃え。画面からはみ出す場合は左へ寄せる
      const r = anchorEl.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let left = r.right - pw, top = r.bottom + 4;
      if (left < 4) left = 4;
      if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      this._layoutPopEl = pop;
      this._layoutPopClose = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        if (e.type === 'mousedown' && (pop.contains(e.target) || anchorEl.contains(e.target))) return;
        this._closeLayoutPopover();
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this._layoutPopClose, true);
        document.addEventListener('keydown', this._layoutPopClose, true);
      }, 0);
    }
    _closeLayoutPopover() {
      if (!this._layoutPopEl) return;
      this._layoutPopEl.remove();
      this._layoutPopEl = null;
      document.removeEventListener('mousedown', this._layoutPopClose, true);
      document.removeEventListener('keydown', this._layoutPopClose, true);
      this._layoutPopClose = null;
    }

    setSource(result, chips) {
      this._chips = Array.isArray(chips) ? chips.filter(c => c && c !== 'none') : [];
      // L/R(ステレオパン)列はHES/GBSのみ意味を持つため、他フォーマットでは非表示にする
      // (表示/パネル幅はCSS側の.kbd-left--hes/.kbd-left--gbsで切り替え、詳細はstyle.css参照)。
      this._leftEl.classList.toggle('kbd-left--hes', this._chips.includes('hes'));
      // VGMのSN76489もGame Gearステレオ(L/R列)を持つのでGBS用のL/R列表示を流用する
      this._leftEl.classList.toggle('kbd-left--gbs', this._chips.includes('gbs') || this._chips.includes('sn76489'));
      this._extraSnaps = {};
      const wl = result.writeLog || [];
      if (this._chips.includes('vrc7')) this._extraSnaps.vrc7 = buildVrc7Snapshots(wl);
      if (this._chips.includes('n163')) this._extraSnaps.n163 = buildN163Snapshots(wl);
      if (this._chips.includes('fme7')) this._extraSnaps.fme7 = buildFme7Snapshots(wl);
      // APU矩形波1/2・ノイズのエンベロープ実出力レベル。
      // 事前キャプチャ経路は静的配列(apuEnv)、リアルタイム再生経路は毎回ライブAPUを読む関数(apuEnvLive)。
      this._extraSnaps.apuEnv = result.apuEnvSnapshots || null;
      this._extraSnaps.apuEnvLive = typeof result.getApuEnv === 'function' ? result.getApuEnv : null;
      this._extraSnaps.n163Live = typeof result.getN163 === 'function' ? result.getN163 : null;
      this._extraSnaps.fme7Live = typeof result.getFME7 === 'function' ? result.getFME7 : null;
      this._extraSnaps.mmc5Live = typeof result.getMmc5 === 'function' ? result.getMmc5 : null;
      this._extraSnaps.vrc7Live = typeof result.getVRC7 === 'function' ? result.getVRC7 : null;
      this._extraSnaps.kssPsgLive = typeof result.getKssPsg === 'function' ? result.getKssPsg : null;
      this._extraSnaps.kssSccLive = typeof result.getKssScc === 'function' ? result.getKssScc : null;
      this._extraSnaps.kssOpllLive = typeof result.getKssOpll === 'function' ? result.getKssOpll : null;
      this._extraSnaps.gbsApuLive = typeof result.getGbsApu === 'function' ? result.getGbsApu : null;
      this._extraSnaps.hesApuLive = typeof result.getHesApu === 'function' ? result.getHesApu : null;
      this._extraSnaps.snLive = typeof result.getSn76489 === 'function' ? result.getSn76489 : null;
      this._extraSnaps.ymLive = typeof result.getYm2612 === 'function' ? result.getYm2612 : null;
      this._extraSnaps.pwmLive = typeof result.getPwm === 'function' ? result.getPwm : null;
      this._lastDmc4011 = null; // 曲切替時にDMC書き込み検出をリセット
      this._rollSongTimeBase = 0; // 曲切替時にピアノロールの経過時間もリセット
      this._rollLastRawPos = null;
      this._rollBaseWallMs = null;
      this._state = {
        regSnapshots: result.regSnapshots || [],
        totalFrames: result.totalFrames || 0,
        samplesPerFrame: result.samplesPerFrame || 735,
        sampleRate: result.sampleRate || 44100,
      };

      const snap0 = this._state.regSnapshots[0] || {};
      this._prevChannels = extractChannels(snap0, this._extraSnaps, 0, this._chips);
      this._rebuildRows(this._prevChannels);
      this.setMode('nsf');

      // 全曲分のレジスタスナップショットが既にある場合(MML/事前キャプチャ済みNSF)は
      // ピアノロールを即座に構築できる。ライブ追跡のみ(totalFrames=1)の場合は
      // 未構築のままにし、setRollTimelineFromRegSnapshots()/setRollTimeline() による
      // 非同期の先読みキャプチャ結果を待つ。
      if (this._state.totalFrames > 1) {
        const frameDur = this._state.samplesPerFrame / this._state.sampleRate;
        // ロール構築はフレームfごとの「過去の履歴」を辿る必要があるが、n163Live/fme7Live/
        // vrc7Live/mmc5Liveは「今まさに再生中のライブチップの現在状態」を返す関数であり、
        // フレームに関わらず常に同じ値を返してしまう(全フレームがその場のスナップショットの
        // コピーになる=事実上ずっと無音として扱われる)。extractChannelsはchips.includes(...)の
        // 各分岐で「Live関数があれば無条件にそちらを優先」するため、setSource()をMML再生
        // (呼び出し時点ではまだ再生開始前でactivePlayerが無く、Live関数は必ずnullを返す)
        // から呼んだ場合にN163/FME7の音符がピアノロールに一切出ない不具合があった。
        // ロール構築専用にLive系を外し、writeLog由来の履歴配列(n163/fme7/vrc7)または
        // レジスタスナップショット直読み(mmc5)にフォールバックさせる
        // (setRollTimelineFromRegSnapshots()と同じ考え方)。
        const rollExtraSnaps = Object.assign({}, this._extraSnaps,
          { n163Live: null, fme7Live: null, vrc7Live: null, mmc5Live: null });
        this._rollTimeline = buildNoteTimelineFromChannelFrames(
          (f) => extractChannels(this._state.regSnapshots[f] || {}, rollExtraSnaps, f, this._chips),
          this._state.totalFrames, frameDur
        );
      } else {
        this._rollTimeline = null;
      }
    }

    // ピアノロール用タイムラインを直接差し替える(共通形状: [{color, notes:[{startSec,endSec,midi}]}])。
    // SPC/KSSのような完全リアルタイム合成フォーマットで、裏で走らせた先読みキャプチャの
    // 結果を非同期に反映する際に main.js から呼ばれる。
    setRollTimeline(timeline) {
      this._rollTimeline = timeline || null;
      this._rollCursor = {};
    }

    // regSnapshots形式(NSFのライブ再生を裏で先読みキャプチャした結果など)からピアノロールの
    // タイムラインを構築して差し替える。setSource()と同じ抽出ロジックをそのまま再利用する。
    // n163Snapshots(省略可): capture.jsが毎フレーム採取したN163チップの生RAM(128byte)配列。
    // 渡された場合はwriteLog再生によるbuildN163Snapshots()の代わりにこちらを使う。
    // N163は$F800(アドレスラッチ)+$4800(データ)の間接アドレッシングで、実機ドライバは
    // 位相バイトを「$4800の空読み」で読み飛ばす(読み出しもオートインクリメントを進める)ため、
    // writeLogの書き込みだけを再生するbuildN163Snapshots()はアドレスポインタがズレて
    // 誤ったチャンネル/周波数/波形を復元してしまう(Rolling Thunder等で顕著、
    // [[n163-capture-snapshot-and-numch]]参照)。ライブRAMスナップショットなら常に正しい。
    setRollTimelineFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
      this._rollCursor = {};
      this._rollTimeline = this.buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
    }

    // setRollTimelineFromRegSnapshots()のトラック構築部分。VGM(main.js playVgmStream)のように
    // NES APU由来のトラックと他チップ(GB/HuC6280/AY/SCC/OPLL)由来のトラックを1本の
    // タイムラインへ連結したい呼び出し側のために、差し替えず配列を返す版を分離した。
    // extra(省略可): extraSnapsへ追加でマージする先読み配列({sn: [...]}等。VGMのSN76489ロール用)。
    buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
      if (!regSnapshots || totalFrames <= 0) return null;
      const wl = writeLog || [];
      const extraSnaps = Object.assign({}, extra || {}, {
        vrc7: chips.includes('vrc7') ? buildVrc7Snapshots(wl) : null,
        n163: chips.includes('n163')
          ? (n163Snapshots && n163Snapshots.length ? buildN163SnapshotsFromLiveRam(n163Snapshots) : buildN163Snapshots(wl))
          : null,
        fme7: chips.includes('fme7') ? buildFme7Snapshots(wl) : null,
      });
      const frameDur = samplesPerFrame / sampleRate;
      return buildNoteTimelineFromChannelFrames(
        (f) => extractChannels(regSnapshots[f] || {}, extraSnaps, f, chips),
        totalFrames, frameDur
      );
    }

    // 新しいファイルを読み込んだ直後などに呼ぶ。前のファイルの発音色が鍵盤/ピアノロールに
    // 残ったまま次のファイルを読み込んだように見えてしまう問題(再生ボタンを押すまで
    // update()/updateSpcVoices()に新しいデータが渡らず、直前の描画がそのまま残る)を防ぐため、
    // 表示を無音状態に戻して即座に再描画する。
    // 新しいファイルを開いた時に呼ぶ(main.jsの各loadXxxFile()冒頭)。曲送り/トラック送り
    // (同一ファイル内での切替)ではミュート状態を保持したいため、ここでしかクリアしない。
    // _muteStateはチャンネルid('P1'等、フォーマット固有だがファイルをまたいで共通)をキーに
    // 永続化されており、以前は新しいファイルを開いてもクリアされなかった。結果、
    // 再生開始直後にgetChannelMuteConfig()が(_rebuildRows前の空/旧チャンネル一覧を反映した)
    // 「何もミュートされていない」設定を再生側へ渡してしまう一方、直後のロール/鍵盤再構築が
    // 古い_muteStateを見て該当chを再びミュート表示するため、表示は「ミュートのまま」なのに
    // 実際の再生は「全ch鳴る」という食い違いが起きていた。新規ファイルではミュートを
    // 引き継がない方針にして解消する。
    reset() {
      this._spcVoices = [];
      this._prevSpcVoices = [];
      this._muteState.clear();
      // 大波形の選択も前ファイルのchを引きずらず、一番若いchに戻す。選択を捨てるのはここ
      // (ファイルの読み込み直し)だけで、曲送りや停止→再生で一覧が一時的に変わっても
      // 選択は保つ(_syncShownWave参照)
      this._selectedId = null;
      this.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100, writeLog: [] }, []);
      this._selectedId = this._shownWaveId; // 一番若いchを新しい選択にする
      this.update(0);
    }

    // 表示モード切替: NSF/MMLチャンネル一覧 と SPCボイス一覧 は同時表示せず、
    // 再生中のファイル種別に応じて排他的に切り替える。
    setMode(mode) {
      if (this._mode === mode) return;
      this._mode = mode;
      const spc = mode === 'spc';
      this._headerEl.style.display = spc ? 'none' : '';
      this._rowsEl.style.display = spc ? 'none' : '';
      this._spcHeaderEl.style.display = spc ? '' : 'none';
      this._spcSectionEl.style.display = spc ? '' : 'none';
      // SPCはNSFより列が多い(L/R/env/PM/echo)ぶん一覧の幅を少し広げる(.kbd-left--spc)。
      // レイアウト(ロールの置き場/大波形の置き場)はNSF等と共通のまま(以前はSPC専用の
      // 1000px幅テーブル+大波形の重ね配置だったが、マスター値を1行にまとめて廃止した)
      this._leftEl.classList.toggle('kbd-left--spc', spc);
      this._applyLayoutClasses(); // 右配置の一覧幅(SPCは下限あり)を反映
      // 大波形に表示するchを表示中の一覧に合わせる(選択chが無ければ一番若いch/V0を一時表示)
      this._syncShownWave(spc ? this._spcRowEls : this._rowEls);
      this._rebuildLanes(); // チャンネルごとのレーン表示も表示中の一覧に合わせる

      // ウィンドウが狭くて一覧の全列が収まらない場合だけ、収まる幅まで自動拡張する
      // (縮小はしない。ユーザーが既に手動でそれ以上広げていればそのまま尊重する)
      if (spc) {
        const winEl = this.container.closest('.float-window');
        if (winEl && this._effectivePlacement() !== 'window') {
          const minW = this._effectivePlacement() === 'bottom' && this._layout.listColumns === 'single' ? 720 : 560;
          if (winEl.offsetWidth < minW) winEl.style.width = minW + 'px';
        }
      }
    }

    // 上書き色があればそれを、無ければ既定色をそのまま返す
    _getColor(id, defaultColor) {
      const ov = this._colorOverrides.get(id);
      return ov || defaultColor;
    }

    // kbd-dot に色ピッカーを割り当てる。defaultColor は「既定色に戻す」用に
    // そのチャンネルの本来の色(上書き適用前)を保持しておく必要がある。
    _attachColorPicker(dotEl, id, defaultColor) {
      dotEl.addEventListener('click', (e) => {
        e.stopPropagation();
        UI.ColorPicker.open(
          dotEl,
          this._getColor(id, defaultColor),
          (color) => this._setColorOverride(id, color),
          () => this._setColorOverride(id, null),
        );
      });
    }

    // 色の変更を反映: 上書きマップ更新→永続化→表示中の行/大波形/次フレームの
    // ロール・鍵盤描画すべてに反映されるようにする。
    _setColorOverride(id, color) {
      if (color) this._colorOverrides.set(id, color);
      else this._colorOverrides.delete(id);
      saveColorOverrides(this._colorOverrides);

      for (const el of this._rowEls.concat(this._spcRowEls)) {
        if (el.id !== id) continue;
        const newColor = this._getColor(id, el.defaultColor || el.color);
        el.color = newColor;
        const dot = el.row.querySelector('.kbd-dot');
        if (dot) dot.style.background = newColor;
      }

      if (this._shownWaveId === id) {
        this._bigWaveSig = ''; // 色はwave形状に含まれないため強制再描画
        const sel = (this._prevChannels || []).concat(this._prevSpcVoices || [])
          .find((c) => c.id === id);
        if (sel) this._renderBigWave(sel);
      }
    }

    _rebuildRows(channels) {
      this._rowsInnerEl.innerHTML = '';
      this._rowEls = [];
      let lastHeader = null;
      // チップごとに .kbd-chip-group で括る(多段表示のとき同じチップの行が列をまたいで
      // 千切れないようにするため。1列表示では見た目に影響しない)
      let group = null;
      for (const ch of channels) {
        const mi = getMuteInfo(ch.id);
        const muted = this._muteState.get(ch.id) || false;
        const disp = getChannelDisplay(ch.id);

        if (!group || (disp.header && disp.header !== lastHeader)) {
          group = document.createElement('div');
          group.className = 'kbd-chip-group';
          this._rowsInnerEl.appendChild(group);
          if (disp.header) {
            const headerRow = document.createElement('div');
            headerRow.className = 'kbd-chip-header';
            headerRow.textContent = disp.header;
            group.appendChild(headerRow);
          }
          lastHeader = disp.header;
        }

        const row = document.createElement('div');
        const rowColor = this._getColor(ch.id, ch.color);
        row.className = 'kbd-ch-row';
        // ALL行(ch.isAllRow、HESの$0801全体バランス用。SPCのALL行と同じ考え方)は
        // 実チャンネルではないのでミュートチェックボックスの代わりにプレースホルダを置き、
        // wave/note/freqは何も表示しない(空欄のまま)。
        row.innerHTML =
          `<span class="kbd-dot" style="background:${rowColor}"></span>` +
          `<span class="kbd-part">${ch.letter || ''}</span>` +
          (ch.isAllRow
            ? `<span class="kbd-mute-ph"></span>`
            : `<input type="checkbox" class="kbd-mute"${muted ? '' : ' checked'} title="${T('{ch} ミュート', { ch: ch.id })}">`) +
          `<span class="kbd-name">${disp.name}</span>` +
          `<span class="kbds-lr kbds-l"></span>` +
          `<span class="kbds-lr"></span>` +
          `<span class="kbd-vol-num">0</span>` +
          `<span class="kbd-vol-wrap">` +
            `<span class="kbd-vol-bar" style="background:transparent"></span>` +
            (ch.isAllRow ? '' :
              `<input type="range" class="kbd-vol-slider" min="0" max="100" step="1" value="${Math.round((this._channelVolumes.get(ch.id) ?? 1) * 100)}" title="${T('{ch} 音量', { ch: ch.id })}">` +
              `<span class="kbd-vol-tooltip"></span>`) +
          `</span>` +
          (ch.isAllRow ? `<span class="kbd-wave" style="visibility:hidden"></span>` : `<canvas class="kbd-wave" width="68" height="28"></canvas>`) +
          `<span class="kbd-note">${ch.isAllRow ? '' : '—'}</span>` +
          `<span class="kbd-freq"></span>`;

        let checkbox = null;
        if (!ch.isAllRow) {
          checkbox = row.querySelector('.kbd-mute');
          checkbox.addEventListener('change', () => {
            this._muteState.set(ch.id, !checkbox.checked);
            if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
          });
        }
        if (!ch.isAllRow) this._attachVolumeSlider(row, ch.id);

        // 波形アイコンをクリックで大波形表示に選択(ALL行には波形アイコン自体が無い)
        const waveCanvas = ch.isAllRow ? null : row.querySelector('.kbd-wave');
        const chId = ch.id;
        if (waveCanvas) {
          waveCanvas.classList.add('kbd-wave--clickable');
          if (chId === this._shownWaveId) waveCanvas.classList.add('kbd-wave--selected');
          waveCanvas.addEventListener('click', () => this._selectWave(chId));
        }

        // 丸のクリックで色ピッカーを開く(選んだ色は即localStorageへ保存され全表示に反映)
        this._attachColorPicker(row.querySelector('.kbd-dot'), ch.id, ch.color);

        const lrEls = row.querySelectorAll('.kbds-lr');

        group.appendChild(row);
        this._rowEls.push({
          row,
          id: ch.id,
          isAllRow: !!ch.isAllRow,
          volBar: row.querySelector('.kbd-vol-bar'),
          volNum: row.querySelector('.kbd-vol-num'),
          lEl: lrEls[0], rEl: lrEls[1],
          waveCanvas,
          waveSig: '',
          noteEl: row.querySelector('.kbd-note'),
          freqEl: row.querySelector('.kbd-freq'),
          checkbox,
          muteInfo: mi,
          color: rowColor,
          defaultColor: ch.color,
          letter: ch.letter,
        });
      }
      // 大波形に表示するchを新しい一覧に合わせる(SPCモード中はSPC側の一覧が表示中なので触らない)
      if (this._mode !== 'spc') {
        this._syncShownWave(this._rowEls);
        this._rebuildLanes(); // チャンネルごとのレーン表示も一覧に合わせる
      }
    }

    // ch別音量スライダー(音量バー領域に重ねる半透明オーバーレイ)を1行ぶん配線する。
    // 通常は薄く見えるだけで、ドラッグ中(またはホバー/フォーカス中)だけ数値ツールチップを
    // 出す。値は0〜100%のrange inputで、_channelVolumes(localStorage永続化)を直接操作する。
    // getVolumeConfig()の項参照: 適用先はこのMapを直接読むため、ここではUIの見た目の
    // 同期(初期値反映・スライダー操作時の即時保存)だけを担当すればよい。
    _attachVolumeSlider(row, id) {
      const slider = row.querySelector('.kbd-vol-slider');
      const tooltip = row.querySelector('.kbd-vol-tooltip');
      if (!slider) return;
      const showTooltip = () => {
        tooltip.textContent = `${slider.value}%`;
        tooltip.classList.add('visible');
      };
      const hideTooltip = () => tooltip.classList.remove('visible');
      slider.addEventListener('pointerdown', () => { slider.classList.add('dragging'); showTooltip(); });
      slider.addEventListener('pointerup', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('pointercancel', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('keydown', () => showTooltip()); // キーボード操作(矢印キー)にも対応
      slider.addEventListener('blur', hideTooltip);
      slider.addEventListener('input', () => {
        const vol = (parseInt(slider.value, 10) || 0) / 100;
        showTooltip();
        this._channelVolumes.set(id, vol);
        saveChannelVolumes(this._channelVolumes);
        if (this.onVolumeChange) this.onVolumeChange();
      });
    }

    // SPCボイス(V0〜V7)版。_spcVoiceVolumes(配列index=ボイス番号)を直接操作する点以外は
    // _attachVolumeSlider()と同じ(見た目・ツールチップ挙動を統一するため実装も揃えている)。
    _attachSpcVolumeSlider(row, idx) {
      const slider = row.querySelector('.kbd-vol-slider');
      const tooltip = row.querySelector('.kbd-vol-tooltip');
      if (!slider) return;
      const showTooltip = () => {
        tooltip.textContent = `${slider.value}%`;
        tooltip.classList.add('visible');
      };
      const hideTooltip = () => tooltip.classList.remove('visible');
      slider.addEventListener('pointerdown', () => { slider.classList.add('dragging'); showTooltip(); });
      slider.addEventListener('pointerup', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('pointercancel', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('keydown', () => showTooltip());
      slider.addEventListener('blur', hideTooltip);
      slider.addEventListener('input', () => {
        const vol = (parseInt(slider.value, 10) || 0) / 100;
        showTooltip();
        this._spcVoiceVolumes[idx] = vol;
        saveSpcVoiceVolumes(this._spcVoiceVolumes);
        if (this.onSpcVolumeChange) this.onSpcVolumeChange(this._spcVoiceVolumes.slice());
      });
    }

    // 波形アイコンのクリック: 選択チャンネルを切り替え、拡大表示を更新
    // NSF/SPC どちらの行がクリックされても対応できるよう両リストを見る（IDは重複しない）
    _selectWave(chId) {
      this._selectedId = chId;
      this._shownWaveId = chId;
      this._bigWaveSig = '';   // 強制再描画
      // 一覧の下の折りたたみ帯に置かれていて畳まれていたら、選んだ時点で開く
      if (this._bigWaveCollapsed && this._bigWaveBelow()) {
        this._bigWaveCollapsed = false;
        try { localStorage.setItem('mml_bigWaveCollapsed', '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      }
      // HESのALL行はwaveCanvasを持たない(el.waveCanvas===null)ため、他行を飛ばして
      // 例外にならないようガードする(ガード無しだとALL行で例外→以降の行のtoggleが
      // 一件も実行されず青枠が付かなくなる。大波形表示自体はupdate()側の毎フレーム
      // 再描画で別途追従するため気付かれにくい)。
      for (const el of this._rowEls) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      for (const el of this._spcRowEls) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      // 直近のチャンネル状態で即時描画
      const ch = (this._prevChannels || []).find(c => c.id === chId) ||
                 (this._prevSpcVoices || []).find(c => c.id === chId);
      if (ch) this._renderBigWave(ch);
    }

    // 選択チャンネルの素波形を右パネルへ描画（形状変化時のみ再描画）
    _renderBigWave(ch) {
      if (!ch || !ch.wave) return;
      // コピー可否は再描画をスキップする場合でも常に最新化する(表示形状のsigが
      // 同じでもチャンネル切替直後にボタン状態が古いままになるのを防ぐため)
      this._bigWaveCopyData = getCopyableWaveSamples(ch.wave);
      if (this._bigCopyBtn) this._bigCopyBtn.disabled = !this._bigWaveCopyData;

      const sig = bigWaveSig(ch.wave);
      if (sig === this._bigWaveSig) return;
      this._bigWaveSig = sig;
      const color = this._getColor(ch.id, ch.color);
      drawBigWave(this._bigCanvas, ch.wave, color);
      this._bigTitleEl.innerHTML =
        `<span class="kbd-bigwave-dot" style="background:${color}"></span>` +
        `${ch.id}　${waveTypeLabel(ch.wave)}`;
    }

    // 現在のチェックボックス状態からミュート設定を返す
    getMuteConfig() {
      const config = { apu: {}, expansion: {} };
      for (const el of this._rowEls) {
        const mi = el.muteInfo;
        if (!mi) continue;
        const muted = !el.checkbox.checked;
        if (mi.section === 'apu') {
          config.apu[mi.key] = muted;
        } else {
          if (!config.expansion[mi.chip]) {
            config.expansion[mi.chip] = mi.type === 'array' ? [] : {};
          }
          if (mi.type === 'array') {
            config.expansion[mi.chip][mi.index] = muted;
          } else {
            config.expansion[mi.chip][mi.key] = muted;
          }
        }
      }
      return config;
    }

    // 現在のch別音量設定を返す(getMuteConfig()と同じ形状、値は0〜1)。getMuteConfig()と
    // 違い_rowEls(現在表示中の行のDOM)ではなく永続化Map(_channelVolumes)から直接組み立てる
    // (getMuteInfo(id)はidの文字列だけから決まる純粋関数のため、行がまだ再構築されて
    // いない/別フォーマットの行のままでも正しく引ける。ミュートで「再生開始直後、行が
    // まだ古いままの状態でgetMuteConfig()を呼ぶと的外れな設定を返す」問題が起きていた
    // [[keyboard-mute-state-new-file-leak]]のと同じ穴を音量では踏まないための設計)。
    getVolumeConfig() {
      const config = { apu: {}, expansion: {} };
      for (const [id, vol] of this._channelVolumes) {
        const mi = getMuteInfo(id);
        if (!mi) continue;
        if (mi.section === 'apu') {
          config.apu[mi.key] = vol;
        } else {
          if (!config.expansion[mi.chip]) {
            config.expansion[mi.chip] = mi.type === 'array' ? [] : {};
          }
          if (mi.type === 'array') {
            config.expansion[mi.chip][mi.index] = vol;
          } else {
            config.expansion[mi.chip][mi.key] = vol;
          }
        }
      }
      return config;
    }

    // SPCボイス音量(配列、V0〜V7)。呼び出し側が書き換えても影響しないようコピーを返す
    getSpcVolumeConfig() {
      return this._spcVoiceVolumes.slice();
    }

    // MMLチャンネル文字(A,B,...拡張音源含む) → 現在ミュート中かどうか。
    // 再生ハイライト機能(main.js)がハイライト表示をミュート状態と連動させるために使う
    isChannelMuted(letter) {
      if (!letter) return false;
      for (const el of this._rowEls) {
        if (el.letter === letter) return !el.checkbox.checked;
      }
      return false;
    }

    update(posSeconds) {
      if (!this._state) return;
      const { regSnapshots, totalFrames, samplesPerFrame, sampleRate } = this._state;
      if (!regSnapshots || totalFrames === 0) return;

      const frameDur = samplesPerFrame / sampleRate;
      const fi = Math.max(0, Math.min(totalFrames - 1, Math.floor(posSeconds / frameDur)));

      const snap = regSnapshots[fi] || {};
      const channels = extractChannels(snap, this._extraSnaps, fi, this._chips);

      if (channels.length !== this._rowEls.length) {
        this._prevChannels = channels;
        this._rebuildRows(channels);
      }

      for (let i = 0; i < channels.length && i < this._rowEls.length; i++) {
        const ch = channels[i];
        const el = this._rowEls[i];

        // L/R列(SPCのステレオパン表示と同じ考え方、色もSPCの.kbds-lrに合わせグレー固定)。
        // panL/panRを持つch(HES: ALL行の$0801, 各chの$0805。GBS: ALL行のNR50, 各chのNR51)
        // だけ値を出し、他フォーマットは空欄のまま。GBSのALL行はVIN有効時だけ黄色にする。
        if (el.lEl) { el.lEl.textContent = ch.panL !== undefined ? String(ch.panL) : ''; el.lEl.style.color = ch.vinL ? '#ffcc44' : ''; }
        if (el.rEl) { el.rEl.textContent = ch.panR !== undefined ? String(ch.panR) : ''; el.rEl.style.color = ch.vinR ? '#ffcc44' : ''; }

        // ALL行(実チャンネルではない)はL/R以外に表示するものが無いので、以降のvol/wave/note/freq
        // 更新はスキップする(チェックボックスも無いためel.checkbox.checkedへのアクセスもできない)。
        if (el.isAllRow) continue;

        const muted = !el.checkbox.checked;

        // DMC: $4011 が書き込まれた瞬間だけ検出（レジスタ値の変化＝直接DAC書き込み）。
        // 直接PCM再生中は発声扱いにし、その瞬間だけ数値を黄色にする。
        let dmcWritten = false;
        if (ch.sample && ch.dmcReg !== undefined) {
          if (this._lastDmc4011 !== null && ch.dmcReg !== this._lastDmc4011) {
            dmcWritten = true;
            ch.active = true;
          }
          this._lastDmc4011 = ch.dmcReg;
        }

        const showVol = ch.active && !muted;
        const pct = showVol ? Math.round(ch.vol * 100) : 0;
        el.volBar.style.width = pct + '%';
        el.volBar.style.background = pct > 0 ? el.color : 'transparent';

        // 減衰エンベロープ、または DMC 直接書き込み時は音量数値を黄色にして示す。
        const rawStr = (showVol && ch.rawVol !== null && ch.rawVol !== undefined)
          ? String(ch.rawVol) : '';
        el.volNum.textContent = rawStr;
        el.volNum.style.color = !rawStr ? '#555566'
          : ((ch.envMode === true || dmcWritten) ? '#ffcc44' : '#e6e6ef');
        // Triangleの見かけ音量(黄色文字)はnoise/dmcとの非線形ミキサー干渉による推定値であり、
        // 実レジスタ値ではないことを示すツールチップを付ける。
        el.volNum.title = (ch.id === 'TR' && rawStr && ch.envMode === true) ? T('$4011制御') : '';

        // 素波形アイコン: 発声中のみ更新。使っていないチャンネルは更新しない
        // （発声→停止の遷移時に1回だけ暗色で描き、以後は据え置き＝波形データのハッシュ計算も省略）。
        const waveOn = ch.active && !muted;
        if (waveOn || el.waveOn !== waveOn) {
          const wsig = waveSig(ch.wave, waveOn);
          if (wsig !== el.waveSig) {
            el.waveSig = wsig;
            drawWaveIcon(el.waveCanvas, ch.wave, el.color, waveOn);
          }
          el.waveOn = waveOn;
        }

        if (!ch.active || muted) {
          // APUチャンネルが$4015で無効化されている場合は "-" を表示
          const apuIds = ['P1','P2','TR','NO','DM'];
          const isApuDisabled = apuIds.includes(ch.id) && !muted;
          el.noteEl.textContent = muted ? '(M)' : (isApuDisabled ? '-' : '—');
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else if (ch.dda) {
          // HES PSG: DDA(ソフトウェアPCM)モードで生DAC値を直接再生中
          el.noteEl.textContent = 'PCM';
          el.noteEl.style.color = '#e6e6ef';
          el.freqEl.textContent = '';
        } else if (ch.noise) {
          // note: 周期インデックス数値。長周期=白 / 短周期=黄。ch.noiseLabelがあれば
          // (HES: 固定文字列'noise'。ノイズ周期がindex化されていない音源向け)そちらを優先。
          el.noteEl.textContent = ch.noiseLabel !== undefined ? ch.noiseLabel : String(ch.noiseIndex);
          el.noteEl.style.color = ch.noiseShort ? '#ffcc44' : '#e6e6ef';
          // freq: ノイズ周波数 (Hz)。ノイズ周波数の実測値を持たない音源では空欄のまま。
          el.freqEl.textContent = (ch.noiseFreq !== undefined) ? (Math.round(ch.noiseFreq).toLocaleString() + ' Hz') : '';
        } else if (ch.sample) {
          // note: $4010 再生速度インデックス / freq: DPCM再生周波数
          el.noteEl.textContent = String(ch.dmcRateIdx);
          el.noteEl.style.color = '#e6e6ef';
          el.freqEl.textContent = Math.round(ch.dmcFreq).toLocaleString() + ' Hz';
        } else {
          el.noteEl.style.color = '#e6e6ef';
          const midi = freqToMidi(ch.freq);
          // freq列はFDSモジュレーション適用後の実ピッチ(ch.modFreq)があればそちらを表示する。
          // note(音名)は表示のちらつきを避けるため変調前のch.freqのまま判定する
          const dispFreq = ch.modFreq !== undefined ? ch.modFreq : ch.freq;
          if (midi !== null) {
            el.noteEl.textContent = midiToName(midi);
            el.freqEl.textContent = dispFreq.toFixed(1) + ' Hz';
          } else {
            el.noteEl.textContent = ch.freq > 0 ? '??' : '—';
            el.freqEl.textContent = ch.freq > 0 ? dispFreq.toFixed(1) + ' Hz' : '';
          }
          // FDSのピッチモジュレーション(MH<n>)有効中はfreq列を黄色で強調し、
          // どのレジスタ条件によるものかtitle属性(ツールチップ)で示す。
          // ★注意: title自体はfreqEl(モジュレーション中は毎フレームtextContentが
          // 変化する要素)ではなくrow(行全体、変調中でも中身が変わらない要素)に
          // 付ける。freqElに付けるとブラウザがtextContent変化のたびhoverタイマーを
          // リセットしてしまい、ネイティブツールチップが実質出せなくなる(SPCのADSR
          // ツールチップは値が音符の間ほぼ変化しないため同じ問題が起きなかっただけ)
          el.freqEl.style.color = ch.modActive ? '#ffcc44' : '';
          el.row.title = ch.modActive ? T('$4087 bit7=0 (モジュレーション有効)') : '';
        }
      }

      // 選択チャンネルの大波形を更新（FDS/N163 等は波形が変化するため毎フレーム判定）
      if (this._shownWaveId) {
        const sel = channels.find(c => c.id === this._shownWaveId);
        if (sel) this._renderBigWave(sel);
      }

      // SPC ボイスを合流させてピアノに反映(色はユーザー上書きを解決してから渡す)
      const allChannels = channels.map(c => ({ ...c, color: this._getColor(c.id, c.color) }))
        .concat(this._spcVoices.map(v => ({
          id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
          active: v.active, rawVol: null, rawVolMax: null,
        })));
      this._drawPianos(allChannels);

      // ピアノロールはSPCモード中は updateSpcVoices() 側が描画するため、ここでは
      // それ以外(NSF/MML/KSS)のときだけ描画する(同じcanvasへの二重描画を避ける)。
      if (this._mode !== 'spc') this._renderRoll(posSeconds);
    }

    // トラックid(NSF:'P1'等/SPC:'V0'-'V7'/KSS:'KP1'等)がミュート中かどうかを判定する。
    // SPCボイスは _muteState を経由しない専用のミュート機構(spc-row checkbox)を使うため、
    // _spcRowEls から直接読む。それ以外は通常のチャンネル一覧と共通の _muteState を使う。
    _isTrackMuted(id) {
      if (typeof id === 'string' && /^V\d+$/.test(id)) {
        const idx = parseInt(id.slice(1), 10);
        const el = this._spcRowEls[idx];
        if (el) return !el.checkbox.checked;
      }
      return this._muteState.get(id) || false;
    }

    // ピアノロール描画。音程軸は鍵盤とkeyX()で共有し、時間軸は「現在(鍵盤に接する端)→未来」
    // へ向かって音符を流す。向き(縦=上から降る/横=右から流れる)はmakeRollGeom()が吸収する。
    // _rollTimeline が無い間(先読みキャプチャ完了前など)は前回の描画内容をクリアするだけにする。
    // 描画先: 全チャンネルまとめ(rollLanes='all')なら_rollCanvas 1枚(フィルタ無し)、
    // チャンネルごと(rollLanes='perChannel')なら各レーンのcanvas(そのchのノートだけ)。
    _rollTargets() {
      if (this._layout.rollLanes === 'perChannel' && this._lanes && this._lanes.length) {
        return this._lanes.map(l => ({ canvas: l.rollCanvas, onlyId: l.id, lane: l }));
      }
      return [{ canvas: this._rollCanvas, onlyId: null, lane: null }];
    }

    _renderRoll(posSeconds) {
      const targets = this._rollTargets();
      if (!targets.length || !targets[0].canvas) return;
      // 折りたたみ中(表示要素がdisplay:none)は描かない
      const host = targets[0].onlyId === null ? this._rollCanvas : this._lanesEl;
      if (!host || host.style.display === 'none') return;

      // posSeconds(実プレイヤーのgetPosition())はオーディオコールバック単位(数十〜100ms程度)
      // でしか更新されないため、rAF(約16ms間隔)からは同じ値が何フレームも続いた後に一気に
      // 進む「カクつき」に見える。そこで「最後に実測位置が更新された時点の確定値」
      // (_rollSongTimeBase)は実測差分だけで進め(二重加算を避けるため補間分は加算しない)、
      // 描画に使うposはそこに「その後の壁時計経過分」をその場で足すだけにする(蓄積しない)。
      // 実測値が来るたびbaseが実測差分ぶんだけ更新され、補間分は自動的に上書きされる。
      // また、実測位置がしばらく(ROLL_INTERP_CAP_MS以上)更新されない=再生していない状態
      // とみなし、補間による経過をそこで頭打ちにして停止中はロールが動き続けないようにする。
      const ROLL_INTERP_CAP_MS = 400;
      const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const rawPos = posSeconds || 0;
      const speedFactor = 1 / (this._speedDenom || 1);
      if (this._rollLastRawPos === null || rawPos < this._rollLastRawPos - 0.001) {
        // 新規再生開始(rawPos=0)またはシークによる巻き戻り。rawPosは「現在の速度で
        // 曲頭から目標地点まで再生した場合の実時間」(stream-player.jsのseek()参照)
        // なので、rawPos*speedFactorが常に正しい曲内絶対秒になる(新規再生開始時は
        // rawPos=0なので特別扱い不要で0と一致する)。
        this._rollSongTimeBase = rawPos * speedFactor;
        this._rollBaseWallMs = nowMs;
        this._rollCursor = {}; // 巻き戻り時は各trackの走査起点キャッシュも巻き戻す
      } else if (rawPos > this._rollLastRawPos + 1e-6) {
        this._rollSongTimeBase += (rawPos - this._rollLastRawPos) * speedFactor; // 実測位置が更新された
        this._rollBaseWallMs = nowMs;
      }
      this._rollLastRawPos = rawPos;
      const elapsedSinceBaseMs = Math.min(ROLL_INTERP_CAP_MS, Math.max(0, nowMs - (this._rollBaseWallMs || nowMs)));
      let pos = this._rollSongTimeBase + (elapsedSinceBaseMs / 1000) * speedFactor;
      // ロールをドラッグしてシーク中は、実測位置でなくドラッグ位置を表示する(_attachRollSeekDrag参照)。
      // 巻き戻し方向にも動くので走査起点キャッシュは使わない
      if (this._rollDrag) {
        pos = this._rollDrag.pos;
        this._rollCursor = {};
      }
      this._rollLastDrawnPos = pos;
      for (const t of targets) this._drawRollCanvas(t.canvas, pos, t.onlyId, t.lane || null);
    }

    // チャンネルごとのレーンの音程窓(白鍵LANE_VISIBLE_WHITE本ぶん)を、そのchの「鳴っている音+
    // 先読み範囲[pos, pos+windowSec)内の音符」が収まるようにスクロールさせる。
    // 動かし方はデッドゾーン方式: 必要な音域が今の窓(余白LANE_SCROLL_MARGIN白鍵を除く)に
    // 収まっていれば動かさない。はみ出す側があればその側だけ必要最小限ずらし、音域が窓より
    // 広くて収まらないときは「今鳴っている音(無ければ一番近い未来の音)」を窓の中央に置く。
    // 目標へは毎フレーム残差の一部ずつ寄せる(LANE_SCROLL_EASE)ので滑らかに追従する。
    // 音符が1つも無い間は動かさない。lane.scrollWhite = 窓の低音側端の白鍵位置(小数)
    _updateLaneScroll(lane, pos, windowSec) {
      const maxOff = TOTAL_WHITE - LANE_VISIBLE_WHITE;
      const track = this._rollTimeline && this._rollTimeline.find(t => t.id === lane.id);
      if (lane.scrollWhite == null) lane.scrollWhite = Math.max(0, Math.min(maxOff, keyX(60, 1).x - LANE_VISIBLE_WHITE / 2)); // 初期値: C4中心
      if (!track || !track.notes.length) return;
      const winEnd = pos + windowSec;
      // 白鍵単位の位置(黒鍵は隣接白鍵の境界)。keyX(midi,1)は白鍵幅1としたときの座標
      let lo = Infinity, hi = -Infinity, focus = null, focusStart = Infinity;
      const notes = track.notes;
      // startSec昇順なので、終わった音を飛ばしつつ先読み範囲まで見る(ノート数は多くても
      // 範囲は数秒ぶんなので線形走査で十分。位置はレーンごとに独立なのでcursorは使わない)
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (n.endSec <= pos) continue;
        if (n.startSec >= winEnd) break;
        const kp = keyX(n.midi, 1);
        if (!kp) continue;
        const p0 = kp.isBlack ? kp.x - 0.3 : kp.x, p1 = kp.isBlack ? kp.x + 0.3 : kp.x + 1;
        if (p0 < lo) lo = p0;
        if (p1 > hi) hi = p1;
        // 注目音: 鳴っている音(startSec<=pos)があればそれ、無ければ最も近い未来の音
        const key = n.startSec <= pos ? -1 : n.startSec;
        if (key < focusStart) { focusStart = key; focus = (p0 + p1) / 2; }
      }
      if (lo === Infinity) return;
      const vis = LANE_VISIBLE_WHITE, m = LANE_SCROLL_MARGIN;
      let target = lane.scrollWhite;
      if (hi - lo + 2 * m <= vis) {
        if (lo - m < target) target = lo - m;
        else if (hi + m > target + vis) target = hi + m - vis;
      } else {
        target = focus - vis / 2;
      }
      target = Math.max(0, Math.min(maxOff, target));
      const diff = target - lane.scrollWhite;
      lane.scrollWhite = Math.abs(diff) < 0.005 ? target : lane.scrollWhite + diff * LANE_SCROLL_EASE;
    }

    // 1枚のロールcanvasを曲内秒posの状態で描く。onlyId!=nullならそのチャンネルのノートだけ描く
    // (チャンネルごとのレーン表示用。laneが渡されたら音程窓=白鍵LANE_VISIBLE_WHITE本ぶんを
    // lane.scrollWhiteから表示し、描画前に_updateLaneScroll()で窓を追従させる)。
    _drawRollCanvas(canvas, pos, onlyId, lane) {
      // 内部解像度は表示サイズ(CSS px)に追随させる(縦向き・一覧の下配置ではCSSの固定高さ
      // ROLL_CANVAS_HEIGHTと一致する)。フォールバックのclientHeightはborder-topを含まない値
      const newW = canvas._cachedWidth || canvas.offsetWidth || 560;
      const newH = canvas._cachedHeight || canvas.clientHeight || canvas.height;
      if (newW === 0 || newH === 0) return;
      if (canvas.width !== newW) canvas.width = newW;
      if (canvas.height !== newH) canvas.height = newH;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? LANE_VISIBLE_WHITE : 0);
      const { wk: wkW, bk: bkW, H } = g;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, H);
      const windowSec = g.windowSec;
      const winEnd = pos + windowSec;
      if (lane) this._updateLaneScroll(lane, pos, windowSec);
      const offPx = lane ? lane.scrollWhite * wkW : 0; // 音程窓の低音側端(px)。keyX()の結果から引く

      // 鍵盤ごとの音程グリッド(白鍵の境界線+黒鍵レーンの淡い網掛け)とCの音名ラベル。
      // グリッドは音程軸に直交する全時間帯の帯/線なので、時間軸[0, timeLen)いっぱいに引く。
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        const semi = rel % 12;
        const keyPos = keyX(midi, wkW);
        if (!keyPos) continue;
        keyPos.x -= offPx;
        if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
        if (IS_BLACK[semi]) {
          ctx.fillStyle = '#000000';
          ctx.globalAlpha = 0.25;
          const r = g.rect(keyPos.x - bkW / 2, bkW, 0, g.timeLen);
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = '#3d3d4a';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (g.vertical) {
            const x = Math.round(keyPos.x) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
          } else {
            const y = Math.round(H - keyPos.x) + 0.5;
            ctx.moveTo(0, y);
            ctx.lineTo(g.W, y);
          }
          ctx.stroke();
          // Cの音名ラベル(縦向きのみ。横向きはレーンが薄くて入らないので鍵盤側drawPiano()が
          // 鍵の上に書く)
          if (semi === 0 && g.vertical) {
            ctx.fillStyle = '#6b6b7a';
            ctx.font = '9px ' + fontStack('sans');
            ctx.textBaseline = 'top';
            ctx.fillText(midiToName(midi), keyPos.x + 2, 1);
          }
        }
      }

      // 時間軸: 曲内の絶対秒(0,1,2,3…)ごとに音程軸方向の線を引き、ノートと同じ式でスクロールさせる。
      // 再生が進むにつれて線が鍵盤側へ流れ、新しい秒の線が先読みの果て(縦向き=上端、横向き=右端)
      // から現れる(累積の経過時間)。
      ctx.strokeStyle = '#3d3d4a';
      ctx.fillStyle = '#6b6b7a';
      ctx.font = '9px ' + fontStack('sans');
      const firstSec = Math.ceil(pos);
      for (let s = firstSec; s < winEnd; s++) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        if (g.vertical) {
          const y = Math.round(H - g.tPx(s - pos)) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(g.W, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${s}s`, 2, y - 1);
        } else {
          const x = Math.round(g.tPx(s - pos)) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'top';
          ctx.fillText(`${s}s`, x + 2, 1);
        }
      }

      if (!this._rollTimeline || !this._rollTimeline.length) return;
      const frameDur = this._rollTimeline.frameDur || (1 / 60);

      // track.notesはstartSec昇順(buildNoteTimelineFromChannelFrames参照)なので、
      // 「もう鍵盤側へ流れ去った(endSec<=pos)」ノートを読み飛ばす起点を
      // trackごとにキャッシュし、次フレームはそこから再開する(巻き戻り時は上でリセット済み)。
      // 曲が長い/ノート数が多いほど毎フレーム全ノート走査のコストが線形に効いてくるため、
      // 未再生ノートだけを毎フレーム定数時間で拾えるようにする最適化(文字数の多いMMLで
      // ピアノロールがカクつく問題の対策)
      for (const track of this._rollTimeline) {
        if (onlyId !== null && track.id !== onlyId) continue; // レーン表示: このchのノートだけ
        if (this._isTrackMuted(track.id)) continue; // ミュート中のチャンネルは描画しない
        const notes = track.notes;
        let idx = this._rollCursor[track.id] || 0;
        if (idx > notes.length) idx = notes.length;
        while (idx < notes.length && notes[idx].endSec <= pos) idx++;
        this._rollCursor[track.id] = idx;
        for (let i = idx; i < notes.length; i++) {
          const note = notes[i];
          if (note.startSec >= winEnd) break; // 以降は全て未来のノート(startSec昇順のため打ち切れる)
          const keyPos = keyX(note.midi, wkW);
          if (!keyPos) continue;
          keyPos.x -= offPx;
          if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
          const relEnd = Math.min(windowSec, note.endSec - pos);
          const relStart = Math.max(0, note.startSec - pos);
          // 音程軸: 白鍵は境界線1px内側、黒鍵はレーン幅いっぱい。時間軸: 最低2pxは見えるようにする
          const pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
          const pSize = keyPos.isBlack ? bkW : (wkW - 1);
          const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
          // 音量による濃淡はやめ、常にチャンネル本来の色をそのまま(不透明・フィルタ無し)で描く。
          const noteColor = this._getColor(track.id, track.color);
          ctx.fillStyle = noteColor;
          ctx.fillRect(r.x, r.y, r.w, r.h);

          // セント偏差オーバーレイ(DESIGN-PITCH.md Phase 0): freqSeq(ノート区間内フレーム毎の
          // 生周波数)を丸め後noteの理論周波数と比較し、音程軸方向のズレとして細線描画する。
          // 「±100セント=±1鍵盤幅」を音程軸オフセット(wkW基準)として表現する。
          if (this._showCentsOverlay && note.freqSeq && note.freqSeq.length) {
            const idealFreq = midiToFreq(note.midi);
            const centerP = pLo + pSize / 2;
            ctx.beginPath();
            let started = false;
            for (let k = 0; k < note.freqSeq.length; k++) {
              const freq = note.freqSeq[k];
              if (!freq || freq <= 0) continue;
              const tAbs = note.startSec + k * frameDur;
              if (tAbs < pos || tAbs > winEnd) continue;
              const cents = 1200 * Math.log2(freq / idealFreq);
              const pt = g.point(centerP + (cents / 100) * wkW, g.tPx(tAbs - pos));
              if (!started) { ctx.moveTo(pt.x, pt.y); started = true; } else { ctx.lineTo(pt.x, pt.y); }
            }
            if (started) {
              ctx.strokeStyle = overlayLineColor(noteColor);
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
        }
      }
    }

    // ── SPC ボイス行 DOM構築 ─────────────────────────────────────
    // mute,ch,L,R,vol,env,wave,PM,note,freq,echo,echoL,echoR,C0-C7 の列を持つ。
    // echoL/echoR/C0-C7 はチャンネル単位のレジスタが存在しないため常に空欄
    // （ALL行のみそこにマスター値を表示する）。
    _buildSpcRow(v, idx) {
      const row = document.createElement('div');
      const rowColor = this._getColor(v.label, v.color);
      row.className = 'kbd-ch-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:${rowColor}"></span>` +
        `<input type="checkbox" class="kbd-mute" checked title="${T('{ch} ミュート', { ch: v.label })}">` +
        `<span class="kbd-name">${v.label}</span>` +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbd-vol-num">0</span>` +
        `<span class="kbd-vol-wrap">` +
          `<span class="kbd-vol-bar" style="background:transparent"></span>` +
          `<input type="range" class="kbd-vol-slider" min="0" max="100" step="1" value="${Math.round((this._spcVoiceVolumes[idx] ?? 1) * 100)}" title="${T('{ch} 音量', { ch: v.label })}">` +
          `<span class="kbd-vol-tooltip"></span>` +
        `</span>` +
        `<span class="kbds-env"><canvas class="kbds-env-canvas" width="34" height="16"></canvas><span class="kbds-env-text"></span></span>` +
        `<canvas class="kbd-wave" width="68" height="28"></canvas>` +
        `<span class="kbds-pm">-</span>` +
        `<span class="kbd-note">—</span>` +
        `<span class="kbds-freq"></span>` +
        `<span class="kbds-echo">-</span>`;

      const checkbox = row.querySelector('.kbd-mute');
      checkbox.addEventListener('change', () => {
        if (this.onSpcMuteChange) this.onSpcMuteChange(idx, !checkbox.checked);
      });
      this._attachSpcVolumeSlider(row, idx);

      // 波形アイコンをクリックで大波形表示に選択（NSF側と同じ挙動）
      const waveCanvas = row.querySelector('.kbd-wave');
      const chId = v.label;
      waveCanvas.classList.add('kbd-wave--clickable');
      if (chId === this._shownWaveId) waveCanvas.classList.add('kbd-wave--selected');
      waveCanvas.addEventListener('click', () => this._selectWave(chId));

      // 丸のクリックで色ピッカーを開く
      this._attachColorPicker(row.querySelector('.kbd-dot'), v.label, v.color);

      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        id: v.label,
        row,
        volBar: row.querySelector('.kbd-vol-bar'),
        volNum: row.querySelector('.kbd-vol-num'),
        lEl: lrEls[0], rEl: lrEls[1],
        envCanvas: row.querySelector('.kbds-env-canvas'),
        envText: row.querySelector('.kbds-env-text'),
        waveCanvas,
        waveSig: '',
        waveOn: false,
        pmEl: row.querySelector('.kbds-pm'),
        noteEl: row.querySelector('.kbd-note'),
        freqEl: row.querySelector('.kbds-freq'),
        echoEl: row.querySelector('.kbds-echo'),
        checkbox,
        color: rowColor,
        defaultColor: v.color,
      };
    }

    // ALL行: L・R にマスター音量($0C/$1C)。それより右(vol以降)はボイス単位の値が無いので、
    // 1つのセル(.kbds-master)にエコー音量L/R($2C/$3C)とFIRフィルタ係数C0-C7をまとめて表示する
    // (以前は echoL/echoR/C0-C7 を独立した列にしていたが、ALL行以外は常に空欄で幅ばかり
    // 食っていたため、一覧幅を他フォーマット並みに収める目的で1セルにした)。
    _buildSpcAllRow() {
      const row = document.createElement('div');
      row.className = 'kbd-ch-row kbds-all-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:#888"></span>` +
        `<span class="kbd-mute-ph"></span>` +
        `<span class="kbd-name">ALL</span>` +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbds-master" title="echo L/R = ${'$'}2C/${'$'}3C, FIR = C0..C7"></span>`;
      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        row,
        lEl: lrEls[0], rEl: lrEls[1],
        masterEl: row.querySelector('.kbds-master'),
      };
    }

    // ── SPC ボイス同期 ────────────────────────────────────────────
    // voices: [{label:'V0', freq:Hz, vol:0-1, rawVol:0-0x7FF, active:bool, muted:bool,
    //   color:'hsl(...)', wave:{t:'wave',data,layers,nx,ny}|null, env:{mode,...},
    //   volL, volR, pmOn, noiseOn, echoOn}] × 8
    // master: { volL, volR, echoL, echoR, fir:[C0..C7] } — ALL行用のマスター値。
    // posSeconds: 現在の再生位置(秒)。ピアノロールの先読み描画位置に使う。
    updateSpcVoices(voices, master, posSeconds) {
      this._spcVoices = voices || [];
      this._prevSpcVoices = this._spcVoices.map(v => ({
        id: v.label, color: v.color, freq: v.freq, vol: v.vol, active: v.active, wave: v.wave,
      }));
      const anyActive = this._spcVoices.some(v => v.active);

      // ALL行は初回のみ構築（内容は毎回更新）。見出しは理屈上はALL行含む全体に
      // かかるべきだが、見た目はALL行をヘッダ扱いにしたいのでALLとV0の間に置く。
      if (!this._spcAllRow) {
        this._spcSectionEl.innerHTML = '';
        this._spcAllRow = this._buildSpcAllRow();
        this._spcSectionEl.appendChild(this._spcAllRow.row);
        const chipHeader = document.createElement('div');
        chipHeader.className = 'kbd-chip-header';
        chipHeader.textContent = 'SPC700 (Super Famicom / Super Nintendo Entertainment System)';
        this._spcSectionEl.appendChild(chipHeader);
      }

      // 行数が変化した場合だけ per-voice 行を再構築（通常は初回の8行のみ。ALL行は保持）
      if (this._spcRowEls.length !== this._spcVoices.length) {
        for (const el of this._spcRowEls) el.row.remove();
        this._spcRowEls = this._spcVoices.map((v, idx) => {
          const el = this._buildSpcRow(v, idx);
          this._spcSectionEl.appendChild(el.row);
          return el;
        });
        // 大波形に表示するボイスを新しい一覧に合わせる(選択がSPCボイス以外ならV0を一時表示)
        if (this._mode === 'spc') {
          this._syncShownWave(this._spcRowEls);
          this._rebuildLanes(); // チャンネルごとのレーン表示もボイス一覧に合わせる
        }
      }

      // ALL行データ更新（マスター音量・エコー音量・FIRフィルタ、各 -128〜127）
      if (master && this._spcAllRow) {
        const a = this._spcAllRow;
        a.lEl.textContent = String(master.volL);
        a.rEl.textContent = String(master.volR);
        const fir = (master.fir || []).map(v => String(v)).join(' ');
        const txt = `echo ${master.echoL}/${master.echoR}  FIR ${fir}`;
        if (a.masterEl.textContent !== txt) a.masterEl.textContent = txt;
      }

      // 各ボイス行データ更新
      for (let i = 0; i < this._spcVoices.length && i < this._spcRowEls.length; i++) {
        const v  = this._spcVoices[i];
        const el = this._spcRowEls[i];
        const muted = v.muted !== undefined ? v.muted : !el.checkbox.checked;
        el.checkbox.checked = !muted; // ボイスモニター側のMUTEボタンとも同期

        // L/R: ステレオパンレジスタ（-128〜127、発声状態に関わらず常時表示）
        el.lEl.textContent = v.volL !== undefined ? String(v.volL) : '';
        el.rEl.textContent = v.volR !== undefined ? String(v.volR) : '';

        const showVol = v.active && !muted;
        const pct = showVol ? Math.round(v.vol * 100) : 0;
        el.volBar.style.width      = pct + '%';
        el.volBar.style.background = pct > 0 ? el.color : 'transparent';
        el.volNum.textContent = (showVol && v.rawVol !== null && v.rawVol !== undefined)
          ? String(v.rawVol) : '';
        el.volNum.style.color = showVol ? '#e6e6ef' : '#555566';

        // env列: ADSRモードは簡易グラフアイコン、GAINモードはモード名+数値のテキスト
        if (v.env && v.env.mode === 'adsr') {
          el.envCanvas.style.display = '';
          el.envText.style.display = 'none';
          el.envCanvas.title = `ADSR AR=${v.env.ar} DR=${v.env.dr} SL=${v.env.sl} SR=${v.env.sr}`;
          drawEnvIcon(el.envCanvas, v.env, el.color, showVol);
        } else if (v.env) {
          el.envCanvas.style.display = 'none';
          el.envText.style.display = '';
          // 表示は略号のみ（D/LD/E/LA/BA）、正式名はtitle属性のツールチップで示す
          const GAIN_KIND = {
            direct:  { abbr: 'D',  full: 'direct' },
            lindec:  { abbr: 'LD', full: 'linear decay' },
            exp:     { abbr: 'E',  full: 'exponential' },
            linatk:  { abbr: 'LA', full: 'linear attack' },
            bentatk: { abbr: 'BA', full: 'bent attack' },
          }[v.env.kind] || { abbr: v.env.kind, full: v.env.kind };
          el.envText.textContent = `${GAIN_KIND.abbr} ${v.env.value}`;
          el.envText.title = `${GAIN_KIND.full} ${v.env.value}`;
          el.envText.style.color = showVol ? '#cfcfe0' : '#555566';
        }

        // 素波形アイコン: 発声中のみ更新（NSF側と同じく発声→停止の遷移時のみ暗色で描き直す）
        const waveOn = v.active && !muted;
        if (waveOn || el.waveOn !== waveOn) {
          const wsig = waveSig(v.wave, waveOn);
          if (wsig !== el.waveSig) {
            el.waveSig = wsig;
            drawWaveIcon(el.waveCanvas, v.wave, el.color, waveOn);
          }
          el.waveOn = waveOn;
        }

        // PM列: $2Dのビットでon/off
        el.pmEl.textContent = v.pmOn ? 'on' : '-';
        el.pmEl.style.color = v.pmOn ? el.color : '#555566';

        // echo列: $4Dのビットが立っていれば $7D(EDL)下位4bitから求めたエコーディレイ時間を表示
        el.echoEl.textContent = v.echoOn ? `${v.echoDelayMs}ms` : '-';
        el.echoEl.style.color = v.echoOn ? '#e6e6ef' : '#555566';

        if (!showVol) {
          el.noteEl.textContent = muted ? '(M)' : '—';
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else {
          const midi = freqToMidi(v.freq);
          if (midi !== null) {
            el.noteEl.textContent = midiToName(midi);
            el.freqEl.textContent = v.freq.toFixed(1) + ' Hz';
          } else {
            el.noteEl.textContent = v.freq > 0 ? '??' : '—';
            el.freqEl.textContent = v.freq > 0 ? v.freq.toFixed(1) + ' Hz' : '';
          }
          // $3Dでノイズ発声中のchはnote列を黄色で強調
          el.noteEl.style.color = v.noiseOn ? '#ffcc44' : '#e6e6ef';
        }
      }

      // 選択チャンネルの大波形を更新
      if (this._shownWaveId) {
        const sel = this._prevSpcVoices.find(c => c.id === this._shownWaveId);
        if (sel) this._renderBigWave(sel);
      }

      // ピアノを即時再描画（SPC のみ再生中も更新）
      if (anyActive) {
        const snap = this._state && this._state.regSnapshots
          ? (this._state.regSnapshots[0] || {}) : {};
        const nesChannels = (this._state
          ? extractChannels(snap, this._extraSnaps, 0, this._chips)
          : []).map(c => ({ ...c, color: this._getColor(c.id, c.color) }));
        const allChannels = nesChannels.concat(this._spcVoices.map(v => ({
          id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
          active: v.active, rawVol: null, rawVolMax: null,
        })));
        this._drawPianos(allChannels);
      }

      if (this._mode === 'spc') this._renderRoll(posSeconds || 0);
    }

    // SPCはNSF/MML/KSSと違いupdate()(=rAFのmonitorLoopから毎フレーム呼ばれる)を経由せず、
    // updateSpcVoices()が専用の80ms setInterval(ボイス詳細UIの更新にはこれで十分)からしか
    // 呼ばれない設計のため、ロールの再描画までそれに引きずられて12.5fps相当になり、
    // NSF/KSS(rAF=約60fps)と比べて明らかにカクカクして見えていた(2026-07-18、ユーザー報告)。
    // ボイス詳細表示は変えずに、ロールの再描画だけ切り離してrAF頻度で呼べるようにする軽量メソッド。
    updateRollPosition(posSeconds) {
      this._renderRoll(posSeconds);
    }

  }

  UI.KeyboardDisplay = KeyboardDisplay;
})(window);
