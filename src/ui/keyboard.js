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
  // SPCボイス一覧(part/mute/ch/L/R/vol/env/wave/PM/note/freq/echo)の全列が収まる一覧幅。
  // style.cssの .kbd-left.kbd-left--spc { width } と一致させること
  const SPC_LIST_MIN_WIDTH = 512;
  // チャンネル割当の「借用先/音色」列(.kbd-h-assign/.kbd-assign の200px + gap)。
  // style.css の .kbd-left--assign の各幅(=各フォーマットの固定幅+この値)と一致させること
  const ASSIGN_COL_WIDTH = 206;
  // 一覧の固定幅(style.css の .kbd-left / --hes / --gbs / --spc と一致させること)
  const LIST_WIDTH_NSF = 320, LIST_WIDTH_PAN = 370;

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
  // スポットライト(案D): チャンネル一覧の行にホバー/クリックすると、ロール上でその行の
  // ノートだけを原色・最前面で描き、他chはこの不透明度まで減光する。ミュート(=音も消える)
  // とは別軸の「注目だけ」の仕組みで、PCM多chがドラムを叩いていて音符が重なるときに
  // 「今どの行を見ているか」を切り分けるために使う。
  const SPOTLIGHT_DIM_ALPHA = 0.16;
  // ── ドラム区画(音程ロールと同じcanvasの低音側に置く) ─────────────
  // 打楽器として鳴っているサンプルPCM(pcmSampleRow の drumKey)は音程軸に載せられないので、
  // 音程鍵盤(MIDI_MIN=C1)より低音側に「1レーン=1サンプル」の区画を作ってそこへ置く。
  // 音程軸の単位は白鍵1本ぶん(wk)で、ドラム1レーンは DRUM_LANE_WHITE 本ぶんの幅を持つ
  // (白鍵と同じ幅だとラベルが入らないので少し広くしてある)。ドラムが1つも無い曲では
  // レーン数0=区画の幅0になり、音程軸の座標は従来と完全に一致する。
  // レーン割当そのもの(どのサンプルが何番レーンか・上限・溢れの扱い)は
  // src/convert/drumMap.js に置いてある。vgm2mmlのドラム音符出力と同じ表を使うため。
  const DRUM_LANE_WHITE = 1.5;  // ドラム1レーンの幅(白鍵何本ぶんか)
  // レーンの色 = どの太鼓か。チャンネルの色(=どのスロットが鳴らしたか)とは別軸なので、
  // 打点は「塗り=このレーン色 / 枠線=チャンネル色」の二重符号化で描く。プール式チップ
  // (C140/C352/QSound/MultiPCM)は同じ太鼓が毎回別スロットへ移るため、色をchに割り当てると
  // 太鼓の色が踊ってしまう。塗りをサンプル側に固定するとその問題が出ない。
  const DRUM_LANE_COLORS = ['#e8564a', '#f0a232', '#4a9de8', '#9b6ef3', '#22b3a4', '#d94fa0',
                            '#7a8a99', '#c2a03a', '#5ac47a', '#ff7fa8', '#8ab4ff', '#d0703a',
                            '#59c2c9', '#b06ee0', '#9aa832', '#e06060'];
  const DRUM_OTHER_COLOR = '#8a93a1'; // 「その他」レーン

  // 曲が終わった後の挙動。ヘッダの1つのアイコンをクリックのたびに巡回して選ぶ
  // 複数の元chを1本にまとめて載せられる借用先(重複=競合ではない)。
  // DPCMは「選んだPCMチャンネルの打楽器を、同時発音ぶんはミックスして1本のサンプル列にする」
  // という作りなので、何本選んでもよい
  const MULTI_SOURCE_TARGETS = new Set(['dpcm']);

  const REPEAT_MODES = ['next', 'one', 'shuffle', 'stop'];
  const REPEAT_MODE_KEY = 'mml_repeatMode';
  const REPEAT_ICONS = {
    next: { label: () => T('曲が終わったら: 次の曲へ'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9.5M11.5 4.8 14 7l-2.5 2.2"/><path d="M16 13H6.5M8.5 10.8 6 13l2.5 2.2"/></svg>' },
    one: { label: () => T('曲が終わったら: 同じ曲を繰り返す'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8.5A4.5 4.5 0 0 1 10 4h5M12.5 1.8 15 4l-2.5 2.2"/><path d="M14.5 11.5A4.5 4.5 0 0 1 10 16H5M7.5 13.8 5 16l2.5 2.2"/><text x="10" y="12.6" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>' },
    shuffle: { label: () => T('曲が終わったら: ランダム再生'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h3l8 8h3M3 14h3l8-8h3"/><path d="M14.8 3.8 17 6l-2.2 2.2M14.8 11.8 17 14l-2.2 2.2"/></svg>' },
    stop: { label: () => T('曲が終わったら: 停止'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="10" height="10" rx="1.5"/></svg>' },
  };
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
  // nDrum: ドラム区画のレーン数(0=区画なし)。音程軸は [ドラム区画][音程鍵盤] の並びで、
  // 全体の長さは (nDrum * DRUM_LANE_WHITE + TOTAL_WHITE) 白鍵ぶん。keyX()が返す音程側の
  // 座標には drumOff(区画の幅px)を足して使う。
  function makeRollGeom(orientation, W, H, visibleWhite, nDrum) {
    const vertical = orientation !== 'horizontal';
    const pitchLen = vertical ? W : H;
    const timeLen = vertical ? H : W;
    const drumUnits = (nDrum || 0) * DRUM_LANE_WHITE;
    const wk = pitchLen / (visibleWhite || (TOTAL_WHITE + drumUnits));
    const bk = Math.max(3, wk * 0.60);
    // 先読み時間幅(秒)と、秒→時間軸pxの変換。時間軸320pxのとき従来通り4秒/80px/秒になる
    const windowSec = timeLen / ROLL_PX_PER_SEC;
    const tPx = (sec) => (sec / windowSec) * timeLen;
    return {
      vertical, W, H, pitchLen, timeLen, wk, bk, windowSec, tPx,
      nDrum: nDrum || 0, drumOff: drumUnits * wk, drumLaneW: DRUM_LANE_WHITE * wk,
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

  // ドラム区画のレーン lane の音程軸上の範囲(px)。sub/subN を渡すと、レーンをsubN分割した
  // うちの sub 番目(同時発音の横並び)の範囲を返す。
  // note列クリックで「打楽器/音階の指定」を出す行(サンプルPCM系のチャンネル)。
  // NA/NB=YM2610 ADPCM、GA=GA20、SP=SegaPCM、CN=C140、CS=C352、QS=QSound、
  // OK=OKIM6295、MP=MultiPCM
  const SAMPLE_ROW_RE = /^(N[AB]\d?|GA\d|SP\d+|CN\d+|CS\d+|QS\d+|OK\d|MP\d+)$/;

  function drumLaneX(lane, sub, subN, laneW) {
    const n = Math.max(1, subN || 1);
    const s = Math.min(n - 1, Math.max(0, sub || 0));
    const w = laneW / n;
    return { x: lane * laneW + s * w, size: w };
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
          if (Number.isFinite(v)) map.set(id, Math.max(0, Math.min(2, v)));
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
        return raw.map((v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; });
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

  // リズムchのミュート添字。★2026-08-22: 以前は実チャンネル(BD=6, SD/HH=7, TOM/CYM=8)を
  // そのまま使っていたが、SDとHH(およびTOMとCYM)が同じ添字を共有するため
  // getMuteConfig() が行順に config[index] = muted を書く際に**後の行が前の行を上書き**し、
  // 「SDをミュートしても消えず、鳴っていないHHをミュートすると消える」状態になっていた。
  // OPLLコア(opllNuked.js)は打楽器ごとに出力サイクルを識別できるので、5種に独立した
  // 添字(9-13)を与える。0-8はメロディch用なので衝突しない。
  const KF_RHYTHM_INDEX = { KFBD: 9, KFSD: 10, KFTOM: 11, KFCYM: 12, KFHH: 13 };

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
    // VGM: YM2151(OPM、OM1-8=FM ch)。chip.mute[]はch 0-7
    const om = id.match(/^OM(\d)$/);
    if (om) return { section: 'expansion', chip: 'ym2151', type: 'array', index: +om[1] - 1 };
    // VGM: GA20(Irem PCM、GA1-4)。chip.mute[]はch 0-3(GALLはGB行なので\dで区別される)
    const ga = id.match(/^GA(\d)$/);
    if (ga) return { section: 'expansion', chip: 'ga20', type: 'array', index: +ga[1] - 1 };
    // VGM: SegaPCM(SP1-16)。chip.mute[]はch 0-15
    const sp = id.match(/^SP(\d+)$/);
    if (sp) return { section: 'expansion', chip: 'segapcm', type: 'array', index: +sp[1] - 1 };
    // VGM: C140(CN1-24)。chip.mute[]はch 0-23
    const cn = id.match(/^CN(\d+)$/);
    if (cn) return { section: 'expansion', chip: 'c140', type: 'array', index: +cn[1] - 1 };
    // VGM: C352(CS1-32)。chip.mute[]はch 0-31
    const cs = id.match(/^CS(\d+)$/);
    if (cs) return { section: 'expansion', chip: 'c352', type: 'array', index: +cs[1] - 1 };
    // VGM: OKIM6258(X68000 ADPCM、1ch)。chip.mute[]は1要素
    if (id === 'OKI') return { section: 'expansion', chip: 'okim6258', type: 'array', index: 0 };
    // VGM: QSound(QS1-16)。chip.mute[]はch 0-15
    const qs = id.match(/^QS(\d+)$/);
    if (qs) return { section: 'expansion', chip: 'qsound', type: 'array', index: +qs[1] - 1 };
    // VGM: OKIM6295(OK1-4)。chip.mute[]はch 0-3('OKI'=OKIM6258は上の完全一致で先に拾われる)
    const ok = id.match(/^OK(\d)$/);
    if (ok) return { section: 'expansion', chip: 'okim6295', type: 'array', index: +ok[1] - 1 };
    // VGM: MultiPCM(MP1-28)。chip.mute[]はch 0-27('M5P1'等MMC5とは前方不一致)
    const mp = id.match(/^MP(\d+)$/);
    if (mp) return { section: 'expansion', chip: 'multipcm', type: 'array', index: +mp[1] - 1 };
    // VGM: YM2610(Neo Geo) FM(NF1-4)。内蔵SSGはKP1-3行(chip 'psg')を流用し、vgmPlayer.jsの
    // YM2610アダプタが e.psg を自分のSSGへ適用する
    const nf = id.match(/^NF(\d)$/);
    if (nf) return { section: 'expansion', chip: 'ym2610fm', type: 'array', index: +nf[1] - 1 };
    // YM2610 ADPCM-A(NA1-6)/ADPCM-B(NB)。chip.muteAdpcm[]は A=0-5, B=6
    const na = id.match(/^NA(\d)$/);
    if (na) return { section: 'expansion', chip: 'ym2610adpcm', type: 'array', index: +na[1] - 1 };
    if (id === 'NB') return { section: 'expansion', chip: 'ym2610adpcm', type: 'array', index: 6 };
    // VGM: 32X PWM(PWL/PWR)。chip.mute[]は L=0, R=1
    if (id === 'PWL') return { section: 'expansion', chip: 'pwm', type: 'array', index: 0 };
    if (id === 'PWR') return { section: 'expansion', chip: 'pwm', type: 'array', index: 1 };
    // VGM: RF5C164(メガCD PCM、RC1-8) / RF5C68(RB1-8)
    const rc = id.match(/^RC(\d)$/);
    if (rc) return { section: 'expansion', chip: 'rf5c164', type: 'array', index: +rc[1] - 1 };
    const rb = id.match(/^RB(\d)$/);
    if (rb) return { section: 'expansion', chip: 'rf5c68', type: 'array', index: +rb[1] - 1 };
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
    { header: 'YM2151 (OPM , X68000 / Arcade)', prefix: 'OM', name: (id) => 'FM' + id.slice(2) },
    // GA1-4は完全一致(ids)で拾う(GBの'GALL'と prefix 'GA' を衝突させない)
    { header: 'GA20 (Irem M92 / M107 PCM)', ids: { GA1: 'PCM1', GA2: 'PCM2', GA3: 'PCM3', GA4: 'PCM4' } },
    // pool: サンプルPCM系はドライバがスロットをペア交互/巡回割当する曲がある
    // (実測: SegaPCM 8-23%移動 / C140 37-100% / C352 74-79% / QSound 8-63% / MultiPCM 100%)。
    // ヘッダに「合成ch/実機スロット」トグルを出し、割当逆算した表示・変換と選べるようにする
    { header: 'SegaPCM (315-5218 , OutRun / After Burner)', prefix: 'SP', name: (id) => 'PCM' + id.slice(2), pool: 'segapcm' },
    { header: 'C140 (Namco System 2 / 21)', prefix: 'CN', name: (id) => 'PCM' + id.slice(2), pool: 'c140' },
    { header: 'C352 (Namco System 11 / 12 / 22)', prefix: 'CS', name: (id) => 'PCM' + id.slice(2), pool: 'c352' },
    { header: 'OKIM6258 (MSM6258 , Sharp X68000)', ids: { OKI: 'ADPCM' } },
    { header: 'QSound (DL-1425 , Capcom CPS2)', prefix: 'QS', name: (id) => 'PCM' + id.slice(2), pool: 'qsound' },
    // ★prefix 'OK' は 'OKI'(OKIM6258)にも前方一致するが、完全一致(ids)が全グループ横断で
    //   先に評価されるので衝突しない(getChannelDisplayの2段ループ参照)
    { header: 'OKIM6295 (MSM6295 , Toaplan / Raizing etc.)', prefix: 'OK', name: (id) => 'ADPCM' + id.slice(2) },
    // pool: チャンネルプール式(ドライバがボイスを巡回割当する)チップの印。ヘッダ行に
    // 「実機スロット/合成ch」の表示モード切替を出す(_rebuildRows参照)
    { header: 'MultiPCM (315-5560 , Sega Model 1 / 2)', prefix: 'MP', name: (id) => 'PCM' + id.slice(2), pool: 'multipcm' },
    // NF1-4は完全一致(ids)で先に拾う(N163のprefix 'N' と衝突させない)
    { header: 'YM2610 (OPNB , Neo Geo)', ids: { NF1: 'FM1', NF2: 'FM2', NF3: 'FM3', NF4: 'FM4', NF5: 'FM5', NF6: 'FM6',
        NA1: 'PCMA1', NA2: 'PCMA2', NA3: 'PCMA3', NA4: 'PCMA4', NA5: 'PCMA5', NA6: 'PCMA6', NB: 'PCMB' } }, // NA=ADPCM-A, NB=ADPCM-B
    { header: 'PWM (Sega 32X)', ids: { PWL: 'L', PWR: 'R' } },
    { header: 'RF5C164 (Mega-CD PCM)', prefix: 'RC', name: (id) => 'PCM' + id.slice(2) },
    { header: 'RF5C68 (PCM)', prefix: 'RB', name: (id) => 'PCM' + id.slice(2) },
  ];
  function getChannelDisplay(id) {
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.ids && g.ids[id]) return { header: g.header, name: g.ids[id], pool: g.pool };
    }
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.prefix && id.startsWith(g.prefix)) return { header: g.header, name: g.name(id), pool: g.pool };
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

  // チャンネル割当(変換元ch → NSF側の借用先パート)の共通モジュール。読み込み順の都合で
  // 未定義でも鍵盤表示は動く(その場合はpart列が従来どおりの固定表示になるだけ)。
  function channelPlan() { return (MML.Convert && MML.Convert.ChannelPlan) || null; }

  // part列(丸の隣のパート文字)。クリックで1行ぶんの割当ポップオーバーを開けるチップにする。
  // 割当を変更できないフォーマット(NSF等)では従来どおりただの文字表示のまま。
  function partChipHtml(ch) {
    const plan = channelPlan();
    const editable = !!plan && plan.editable() && !ch.isAllRow && ch.target !== undefined;
    const cls = 'kbd-part' + (editable ? ' kbd-part--editable' : '');
    return `<span class="${cls}" data-ch="${ch.id || ''}">${ch.letter || (editable ? '—' : '')}</span>`;
  }

  // 見出しの part 列に置くチャンネル割当トグル(案E)。ONで一覧に「借用先/音色」列が生える。
  // 「part」という文字の代わりにアイコンだけを置く(列の意味そのものがボタンになっている)。
  function headerAssignBtnHtml() {
    return `<button type="button" class="kbd-h-part kbd-assign-btn"` +
      ` aria-label="${T('チャンネル割当(変換元ch → NSF側のパート)を表示')}">` +
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 6h5M3 14h5"/><path d="M12 6h5M12 14h5"/><path d="M8 6c2.5 0 1.5 8 4 8"/><path d="M8 14c2.5 0 1.5-8 4-8"/></svg></button>';
  }
  // 見出しの mute 列に置く一括ミュートボタン。全chミュートでなければ全ミュート、
  // 全ミュート済みなら全解除(トグル)。
  function headerMuteAllBtnHtml() {
    return `<button type="button" class="kbd-h-mute-solo kbd-muteall-btn" aria-label="${T('全チャンネルをミュート')}">\u{1F507}</button>`;
  }
  // 見出しの vol 列に置く一括音量リセットボタン。押すと全chの音量スライダーを100%へ戻す
  // (行ごとのダブルクリックでの100%復帰と同じ動作を全chまとめて行う)。
  function headerVolResetBtnHtml() {
    return `<button type="button" class="kbd-h-vol kbd-volreset-btn" title="${T('全チャンネルの音量を100%に戻す')}">vol</button>`;
  }

  // 割当表示ONのときだけ現れる「借用先 / 音色」のセレクト2つ(案Eの列展開)
  function assignCellHtml(ch) {
    if (ch.isAllRow) return `<span class="kbd-assign"></span>`;
    return `<span class="kbd-assign">` +
      `<select class="kbd-assign-target"></select>` +
      `<select class="kbd-assign-tone"></select>` +
      `</span>`;
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

  // YM2610 ADPCM-A/B(ch.adpcmPitch、NA/NB行)の音程。
  //  - ch.adpcmExact: ym2610.js のサンプルピッチ解析(ROM上のサンプルをデコードして基本周期を検出)
  //    ×再生レートの実周波数が ch.freq に入っているので通常の freqToMidi。
  //  - それ以外(ADPCM-Bで解析が信頼できない時): Delta-Nは連続値の再生レートだが、実際の音程は
  //    元サンプルの収録内容に依存し絶対音名を保証するレジスタは無い。同チップのADPCM-A固定レート
  //    (refRate=chip.sampleRate/3)を基準ピッチ(C4=MIDI60)とみなしレートの比を半音数へ変換する
  //    (目安。ピッチベンド等の相対的な上下動は正しく追従する)。
  // 解析の信頼度しきい値(pitchConf、0-1: 窓ごとの検出周期が中央値±3%で一致した割合)
  const ADPCM_PITCH_CONF = 0.5;

  // サンプルPCM系チップ(GA20/SegaPCM/C140/C352/QSound/MultiPCM/OKIM6295/YM2610 ADPCM-A)の
  // 「ピッチ解析が信頼できなかった」行の共通形。音階演奏していない=打楽器/効果音なので、
  // ロールでは音程軸ではなくドラム区画(音程鍵盤より低音側のレーン群)へ置く。
  //  drumKey: どの太鼓かの同定キー。ドラム区画のレーンはこのキー単位で割り当てる。
  //           sample.start はサンプルROM上の開始アドレスで、同じ音なら曲中ずっと同じ値になる
  //           (vgm2mml/expansion/opn.js が既にリトリガー判定のキーに使っているのと同じ考え方)。
  //           サンプル同定情報を持たないチップ(OKIM6258/PWM/RF5C68/164 = ROMもアドレスも無い
  //           ストリーミングDAC)ではnullになり、従来どおり dmcRateIdx 経由の疑似音程に落ちる。
  //  drumSeq: キーオン通番。同じ太鼓を連打したとき区間が1本に融合しないよう区切りに使う。
  function pcmSampleRow(c) {
    return {
      sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
      drumKey: c.sample ? (c.sample.kind + ':' + c.sample.start) : null,
      drumSeq: c.seq || 0,
    };
  }
  function adpcmPitchToMidi(ch) {
    if (ch.adpcmExact) return ch.freq > 0 ? freqToMidi(ch.freq) : null;
    const rateHz = ch.freq, refRate = ch.adpcmRefRate;
    if (!rateHz || rateHz <= 0 || !refRate) return null;
    const m = Math.round(60 + 12 * Math.log2(rateHz / refRate));
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
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
    // ライブAPU状態(apuEnv)があるときは、レジスタ値では分からない実状態を優先する:
    //  ・period … スイープユニットが書き換えた実周期(レジスタは書いた瞬間の値のまま止まって
    //     見えるため、これが無いとスイープの上昇/下降が表示に一切出ない)
    //  ・muted … スイープ強制ミュート(上のpulseSweepMutedと同じ判定を実機側で行った結果)
    //  ・len … 長さカウンタ。halt=0の短い打楽器的な音は次の書込みを待たず自然消音する
    // (2026-08-19、FamicomBox「Game Select」。nsf2mml/converter.js側の同名シミュレーションと
    //  同じ情報で、ロール表示と変換MMLが食い違わないようにする)
    const pulseChannelState = (e, regPeriod, sweepReg, isPulse1) => {
      const period = (e && e.period != null) ? e.period : regPeriod;
      const muted = (e && e.muted !== undefined) ? e.muted : pulseSweepMuted(sweepReg, period, isPulse1);
      const lenOk = (e && e.len !== undefined) ? e.len > 0 : true;
      return { freq: period >= 8 ? CPU_CLOCK / (16 * (period + 1)) : 0, muted, lenOk };
    };
    // APU Pulse 1
    {
      const r = snap[0x4000] || 0;
      const regPeriod = (snap[0x4002] || 0) | (((snap[0x4003] || 0) & 7) << 8);
      const e = apuEnv ? apuEnv.pulse1 : null;
      const { freq, muted, lenOk } = pulseChannelState(e, regPeriod, snap[0x4001] || 0, true);
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P1', color: '#ff4466', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 1) && pulseActive(r) && freq > 0 && !muted && lenOk });
    }
    // APU Pulse 2
    {
      const r = snap[0x4004] || 0;
      const regPeriod = (snap[0x4006] || 0) | (((snap[0x4007] || 0) & 7) << 8);
      const e = apuEnv ? apuEnv.pulse2 : null;
      const { freq, muted, lenOk } = pulseChannelState(e, regPeriod, snap[0x4005] || 0, false);
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P2', color: '#ff8800', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 2) && pulseActive(r) && freq > 0 && !muted && lenOk });
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
        // 三角波は長さカウンタ/線形カウンタのどちらかが0になると消音する(レジスタ値は
        // 変わらないためライブ状態が無いと判定できない。nsf2mml側のtriangleAudibleFrames相当)
        active: !!(status & 4) && freq > 0 &&
          (!apuEnv || !apuEnv.triangle || (apuEnv.triangle.len > 0 && apuEnv.triangle.linear > 0)) });
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
        active: !!(status & 8) && pulseActive(noiseRegPre) && (!e || e.len === undefined || e.len > 0),
        noise: true, noiseShort, noiseIndex, noiseFreq });
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
      // dmcDirect: $4011 直接書込み(生PCM)の検出対象はこの行だけ(update()参照)
      channels.push({ id: 'DM', color: '#aa44ff', freq: 0, vol: level / 127, rawVol: level, rawVolMax: 127,
        wave, active: !!(status & 0x10), sample: true, dmcRateIdx, dmcFreq, dmcReg: dv, dmcDirect: true });
    }
    } // !isKss && !isGbs

    if (chips.includes('fds')) {
      const lo = snap[0x4082] || 0, hi = snap[0x4083] || 0;
      const f12 = lo | ((hi & 0xF) << 8);
      const disabled = !!(hi & 0x80);
      // $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を優先し、
      // 無ければレジスタ直読み(直接ゲイン時のみ正しい)にフォールバック。
      // 実効ゲインは32で頭打ち(v33-63を書いても32相当、src/emulator/expansion/fds.js mixSample)
      // なのでバーは32=100%固定。以前はレジスタ直読みフォールバック時だけ/63にしていたため
      // 同じ音量でもライブ時と半分の長さに見えていた(2026-08-24)
      const fe = apuEnv ? apuEnv.fds : null;
      const gain = fe ? fe.gain : ((snap[0x4080] || 0) & 0x3F);
      const gainMax = 32;
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
        // 波形表示にも蓄積レートを渡す(43以上は実機の8bit桁溢れで鋸波が崩れる。waveSampleValue参照)
        channels.push({ id: 'V6SW', color: '#00ffcc', freq, vol, rawVol: rv, rawVolMax: 42,
          wave: { t: 'saw', nx: 7, ny: 32, rate: rv },
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
          wave, active: c.active, fmPatch: c.patch || null });
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
        // ★2026-08-22: ノイズ専用ch(トーン無効 or トーン周期0でノイズだけ鳴らす打楽器)は
        // SN76489/GBSのノイズ行と同じ扱いにして、note列に周期indexを出す。
        // 従来は波形アイコンだけノイズにしていたため、note列が空のままで何のchか読めなかった。
        const noiseRow = { id: `KP${ch + 1}`, color: COLS[ch % 3], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active };
        if (c.noiseOnly) {
          noiseRow.noise = true;
          noiseRow.noiseFreq = c.noiseFreq;
          noiseRow.noiseIndex = gbNoiseFreqToIndex(c.noiseFreq);
          noiseRow.noiseShort = false;
          noiseRow.freq = 0; // 音程は持たない(古いトーン周期の残骸を出さない)
        }
        channels.push(noiseRow);
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
      // ★2026-08-22: リズムモード(レジスタ$0E bit5)は「打つ瞬間だけ立てて即降ろす」ドライバが
      // 実在する(SMS版After Burnerは毎秒10〜16回トグル)。生ビットに追随すると9ch表示と
      // 6ch+リズム表示が激しく入れ替わって読めないため、**一度でも見たら以後は保持する**
      // 単調な運用にする(SCC行を出したら消さないのと同じ考え方)。フラグはextraSnapsに
      // 持たせているのでsetSource()の this._extraSnaps = {} で曲ごとにリセットされる。
      if (snap2 && snap2.rhythmMode && extraSnaps) extraSnaps.opllRhythmSeen = true;
      const opllRhythm = !!(extraSnaps && extraSnaps.opllRhythmSeen);
      const melody = snap2 ? snap2.melody : [];
      const MCOLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      for (let ch = 0; ch < (opllRhythm ? 6 : (melody.length || 9)); ch++) {
        const c = melody[ch] || { freq: 0, vol: 0, active: false, rawVol: 15 };
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `KF${ch + 1}`, color: MCOLS[ch % MCOLS.length], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave, active: c.active, fmPatch: c.patch || null });
      }
      if (opllRhythm && snap2 && snap2.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        // ★ロールと同じ規則で音程を決める(ここを変えたら src/kss2mml/expansion/opll.js の
        // RHYTHM_DEFS / extractRhythmEvents も必ず同じに直すこと。両者がずれると
        // 「ロールと鍵盤で音符が違う」状態になる)。
        //   BD(ch6)/TOM(ch8) … fnum/blockの実音程を持つので、描画範囲(MIDI_MIN以上)なら実音程
        //   それ以外(音程なし=SD/CYM/HH、または実音程が低すぎて範囲外) … 疑似音程 index
        //     (ロールは midi = 24 + index に置く。鍵盤は noiseIndex 経由で同じキーになる)
        const RPSEUDO = { bd: 0, sd: 2, tom: 4, cym: 6, hh: 8 };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          const r = snap2.rhythm[key];
          const realMidi = freqToMidi(r.freq); // 範囲外はnullが返る
          const row = { id: `KF${RLABEL[key]}`, color: RCOLS[key], freq: realMidi !== null ? r.freq : 0, vol: r.vol,
            rawVol: null, rawVolMax: null,
            wave: realMidi !== null ? { t: 'pulse', hi: 0.5, nx: 2, ny: 2 } : { t: 'noise', short: true, nx: 93, ny: 2 },
            active: r.active, drum: true };
          if (realMidi === null) {
            row.noise = true;
            row.noiseIndex = RPSEUDO[key];
            row.noiseShort = true;
            row.noiseLabel = RLABEL[key]; // note列は周期indexでなく打楽器名を出す
          }
          channels.push(row);
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
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
      {
        const d = s ? s.dac : { enabled: false, level: 0, vol: 0, active: false };
        channels.push({ id: 'YMDA', color: '#aa44ff', freq: 0, vol: d.vol, rawVol: d.enabled ? d.level : null, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!d.active, sample: true, dmcReg: d.level, dmcRateIdx: 15, dmcFreq: 0 });
      }
    }

    if (chips.includes('ym2151')) {
      // YM2151(VGM: OPM、X68000/アーケード): 4op FM×8ch(YM2612と同じFM波形表示)。
      // ch8はノイズモード(c.noise)がありうるが表示は通常のFM行(ノイズ中はfreq=0で無音符扱い)。
      const live = extraSnaps && extraSnaps.ym2151Live;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2151 ? extraSnaps.ym2151[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffd422', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff6bb', '#fff8cc'];
      for (let ch = 0; ch < 8; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OM${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
    }

    if (chips.includes('ga20')) {
      // GA20(VGM: アイレムM92/M107 PCM): 4ch 8bit PCM。YM2610 ADPCM行(NA/NB)と同じ3段階表示:
      // サンプルピッチ解析(ga20.js samplePitch=Emu.SamplePitchUtil共有)が信頼できれば
      // 実周波数×再生レートの通常音名(adpcmExact)、できなければ「サンプル」行。
      // GA20はレートレジスタで1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // note列クリックの手動キャリブレーション(adpcmSample)もNA/NB行と共通(main.js onAdpcmCalibrate)。
      const live = extraSnaps && extraSnaps.ga20Live;
      const s = live ? live() : (extraSnaps && extraSnaps.ga20 ? extraSnaps.ga20[frameIdx] : null);
      const gaWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 4; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (170 + ch * 14) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `GA${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: gaWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('segapcm')) {
      // SegaPCM(VGM: OutRun/After Burner等): 16ch ステレオPCM。GA1-4行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。デルタレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列はch毎のL/R音量(7bit)を0-15へ丸めた値。手動キャリブレーションもGA/NA行と共通。
      const live = extraSnaps && extraSnaps.segapcmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.segapcm ? extraSnaps.segapcm[frameIdx] : null);
      const spWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 16; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (200 + ch * 9) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `SP${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 127,
          wave: spWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('c140')) {
      // C140(VGM: ナムコSystem 2/21): 24ch ステレオPCM。SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。System 2はメロディも
      // C140で弾く曲が多く、周波数レジスタ由来のrateがピッチベンドも追従する。
      const live = extraSnaps && extraSnaps.c140Live;
      const s = live ? live() : (extraSnaps && extraSnaps.c140 ? extraSnaps.c140[frameIdx] : null);
      const cnWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 24; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (330 + ch * 6) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `CN${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: cnWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('c352')) {
      // C352(VGM: ナムコSystem 11/12/22等): 32ch PCM。CN/SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。ノイズフラグの
      // ボイス(LFSR)はサンプルが無いのでピッチ解析対象外=「サンプル」行のまま。
      const live = extraSnaps && extraSnaps.c352Live;
      const s = live ? live() : (extraSnaps && extraSnaps.c352 ? extraSnaps.c352[frameIdx] : null);
      const csWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 32; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (30 + ch * 5) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `CS${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: csWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('ym2610fm')) {
      // YM2610(VGM: Neo Geo): 4op FM×4ch(YM2612と同じFM波形表示)。内蔵SSGは 'kssPsg' の
      // KP1-3行として別途出す(main.js vgmKeyboardChips)。ライブ関数優先、無ければ先読み
      // スナップショット配列(extraSnaps.ym2610fm[frameIdx]、ロール構築用)。
      const live = extraSnaps && extraSnaps.ym2610FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2610fm ? extraSnaps.ym2610fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      const nFm = s && s.channels ? s.channels.length : 4; // YM2610B は6ch
      for (let ch = 0; ch < nFm; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `NF${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
      // ADPCM-A(6ch)/ADPCM-B(1ch)の音程表示(3段階、adpcmPitchToMidi参照):
      //  (1) サンプルのピッチ解析(ym2610.js samplePitch: ROM上のサンプルを1回デコードして基本周期を
      //      検出、×再生レート)が信頼できる(pitchConf>=ADPCM_PITCH_CONF) → 実周波数として通常の
      //      音名表示(adpcmExact)。ADPCM-Aは「音程ごとに別サンプル」の場合、ADPCM-Bは
      //      「1サンプルをΔ-Nで音階演奏」の場合にこれで絶対音名が出る。
      //  (2) ADPCM-Bで解析が信頼できない → Δ-N由来レートを仮基準(refRate=C4)からの相対音程として
      //      表示(目安、noteに'?')。
      //  (3) ADPCM-Aで解析が信頼できない(ドラム/ノイズ等) → 音程レジスタが無い(再生レート固定
      //      18518Hz、開始/終了アドレスで別サンプルを選ぶだけ)ので DMC/RF5C164 と同じ「サンプル」行。
      // 音量=音色レベル(A)/レベル(B)、L/Rはパン。
      // 波形アイコン: ym2610.js がデコード済みサンプルから作った128点(音程あり=持続部の1周期、無し=
      // サンプル全体の概形)。無ければ従来の「サンプル」グリフ。
      // adpcmSample: 手動キャリブレーション(note列クリック→onAdpcmCalibrate)用のサンプル同定情報。
      const adpcmWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 6; ch++) {
        const c = s && s.adpcmA ? s.adpcmA[ch] : { vol: 0, rawVol: 0, rawVolMax: 31, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (20 + ch * 12) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `NA${ch + 1}`, color: `hsl(${hue},80%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave: adpcmWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
      {
        const c = s && s.adpcmB ? s.adpcmB : { vol: 0, rawVol: 0, rawVolMax: 255, active: false, panL: 1, panR: 1, rate: 0, refRate: 1, pitchHz: 0, pitchConf: 0 };
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'NB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: adpcmWave(c), active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          panL: c.panL, panR: c.panR });
      }
    }

    if (chips.includes('qsound')) {
      // QSound(VGM: カプコンCPS1ダッシュ/CPS2): 16ch PCM。CS/SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。
      const live = extraSnaps && extraSnaps.qsoundLive;
      const s = live ? live() : (extraSnaps && extraSnaps.qsound ? extraSnaps.qsound[frameIdx] : null);
      const qsWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 16; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (260 + ch * 7) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `QS${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: qsWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('multipcm')) {
      // MultiPCM(VGM: セガModel 1/2/Multi 32): 28ch PCM。CS/QS行と同じ3段階表示
      // (F-number/octで1サンプルを音階演奏するチップなのでピッチ解析が通れば絶対音名)。
      const live = extraSnaps && extraSnaps.multipcmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.multipcm ? extraSnaps.multipcm[frameIdx] : null);
      const mpWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 28; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (190 + ch * 6) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `MP${ch + 1}`, color: `hsl(${hue},72%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: mpWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('okim6295')) {
      // OKIM6295(VGM: 東亜プラン/ライジング等): 4ch ADPCM。音程レジスタは無い(固定レート)が
      // 「音程ごとに別サンプル」方式の曲があるので、NA/GA行と同じ3段階表示
      // (フレーズのピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。モノラル。
      const live = extraSnaps && extraSnaps.okim6295Live;
      const s = live ? live() : (extraSnaps && extraSnaps.okim6295 ? extraSnaps.okim6295[frameIdx] : null);
      const okWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 4; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (100 + ch * 15) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `OK${ch + 1}`, color: `hsl(${hue},70%,58%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 0x20,
          wave: okWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('okim6258')) {
      // OKIM6258(VGM: X68000 ADPCM): 1chストリーミングADPCM。ROMも音程レジスタも無いので
      // YMDA/PWMと同じ「サンプル」行(音量=現在振幅、キャプチャ時は再生中の下限0.3)。
      const live = extraSnaps && extraSnaps.okim6258Live;
      const s = live ? live() : (extraSnaps && extraSnaps.okim6258 ? extraSnaps.okim6258[frameIdx] : null);
      const c = s ? s[0] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0 };
      channels.push({ id: 'OKI', color: '#ff9944', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
        wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
        panL: c.panL, panR: c.panR });
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

    for (const [tok, prefix, liveKey] of [['rf5c164', 'RC', 'rf5c164Live'], ['rf5c68', 'RB', 'rf5c68Live']]) {
      if (!chips.includes(tok)) continue;
      // RF5C68/164(VGM): 8ch PCM。音程はサンプル依存で不明なのでDMCと同じ「サンプル」行、音量=env×パン
      const live = extraSnaps && extraSnaps[liveKey];
      const s = live ? live() : (extraSnaps && extraSnaps[tok] ? extraSnaps[tok][frameIdx] : null);
      for (let ch = 0; ch < 8; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 0, panR: 0 };
        const hue = (200 + ch * 18) % 360;
        channels.push({ id: `${prefix}${ch + 1}`, color: `hsl(${hue},70%,60%)`, freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
          panL: c.panL, panR: c.panR });
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
    // part列は元々「この元chはNSF側のどのパートになるか」の表示(=既に割当表だった)。
    // 既定はgetPartLetter()のハードコード規則(従来の変換結果と同一)のままで、チャンネル割当
    // (src/convert/channelPlan.js)でユーザーが変えた行だけ、その借用先のレターへ差し替える。
    const plan = channelPlan();
    for (const c of channels) {
      const hardLetter = getPartLetter(c.id, letterMap, n163NumRows);
      if (!plan || c.isAllRow) { c.letter = hardLetter; continue; }
      c.defaultTarget = plan.defaultTarget(c.id, plan.targetOfLetter(hardLetter));
      const ent = plan.get(c.id);
      c.target = (ent && ent.target) || c.defaultTarget;
      // 既定のままなら従来どおりgetPartLetter()の文字をそのまま使う(表示を変えない)
      c.letter = (ent && ent.target) ? plan.letterOfTarget(ent.target)
        : (hardLetter || plan.letterOfTarget(c.defaultTarget));
    }

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
    const tracks = new Map(); // id → { id, color, notes:[], cur:{startFrame,midi,drumKey,volQ,freqs}|null }
    // ドラム区画のレーン割当はここではやらない。RollBuild.vgm はチップごとに
    // この関数を別々に呼んでタイムラインを連結するので、ここで割り当てると
    // 2つのサンプルチップを積んだVGMで両方が「レーン0」から番号を振ってしまう。
    // noteにはdrumKeyだけ載せ、曲全体が揃った受け取り側で一括して割り当てる
    // (KeyboardDisplay._rebuildDrumLanes → MML.Convert.DrumMap.build)。
    const pushNote = (track, endSec) => {
      const c = track.cur;
      const note = { startSec: c.startFrame * frameDur, endSec, midi: c.midi,
                     vol: c.volQ / ROLL_VOL_LEVELS, freqSeq: c.freqs };
      if (c.drumKey) note.drumKey = c.drumKey;
      track.notes.push(note);
      track.cur = null;
    };
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
        //  drumKey付き(打楽器として鳴っているサンプルPCM)は音程を持たないので、midiではなく
        //  drumKeyの側で同一性を判断する。以降 midi と drumKey は排他(どちらか一方だけ非null)。
        let midi, pitchFreq, drumKey = null, drumSeq = 0;
        if (!ch.active) { midi = null; pitchFreq = 0; }
        else if (ch.drumKey) { midi = null; pitchFreq = 0; drumKey = ch.drumKey; drumSeq = ch.drumSeq || 0; }
        else if (ch.noise) { midi = noisePeriodIndexToMidi(ch.noiseIndex); pitchFreq = ch.noiseFreq; }
        else if (ch.adpcmPitch) { midi = adpcmPitchToMidi(ch); pitchFreq = ch.freq; }
        else if (ch.sample) { midi = dmcRateIndexToMidi(ch.dmcRateIdx); pitchFreq = ch.dmcFreq; }
        else { midi = ch.freq ? freqToMidi(ch.freq) : null; pitchFreq = ch.freq; }
        const sounding = midi !== null || drumKey !== null;
        const volQ = sounding ? quantizeVol(ch.vol) : 0;
        const cur = track.cur;
        // drumSeqはキーオン通番。同じ太鼓を同じ音量で連打したとき(16分のハイハット等)、
        // これを見ないと区間が1本の長い棒に融合してしまう
        if (cur && (!sounding || midi !== cur.midi || drumKey !== cur.drumKey || drumSeq !== cur.drumSeq || volQ !== cur.volQ)) {
          pushNote(track, f * frameDur);
        }
        if (sounding && !track.cur) track.cur = { startFrame: f, midi, drumKey, drumSeq, volQ, freqs: [] };
        if (track.cur) track.cur.freqs.push(pitchFreq);
      }
    }
    const totalSec = totalFrames * frameDur;
    const result = [];
    for (const track of tracks.values()) {
      if (track.cur) pushNote(track, totalSec);
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
        // VRC6のこぎり波: 8bitアキュムレータへ蓄積レートを6回加算→リセットの7段階段状。
        // 出力は上位5bit(0-31)。実機通り&0xFFで折り返すので、レート43以上は桁溢れで
        // 波形が崩れる(src/emulator/expansion/vrc6.js Vrc6Saw.clock()と同じ計算)。
        // rate未指定(ロール等の静的アイコン)は理想形(=レート42相当)
        const step = Math.floor(phase * 7) % 7;
        const rate = wave.rate == null ? 42 : wave.rate;
        const out = ((step * rate) & 0xFF) >> 3;
        return (out / 31) * 2 - 1;
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
    else if (wave.t === 'saw') s += wave.rate == null ? '' : wave.rate;
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

  // ── FM音色データのテキスト化(大波形表示の下に出す・コピー用) ──
  // 数値行は各値を width 桁に右寄せして sep で繋ぎ、見出し行(コメント)は同じ幅のラベルを " " で
  // 繋ぐので列が縦に揃う(ユーザー指定の書式:
  //   ; TL FB
  //     20, 0,
  //   ; AR DR SL RR KL ML AM VB EG KR DT
  //     15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0,
  //     15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0
  // )。表示は行ごとに「コメント(先頭が ; の行、または行中の ; 以降)」と「データ」を色分けする
  // (renderFmPatchHtml)。書式はドライバごとに選べる(FM_PATCH_FORMATS、localStorageに保存)。
  // 各書式の並びは公式ドキュメントで確認済み:
  //   PMD    : `; nm alg fbl` / `@nnn alg fbl` / `; ar dr sr rr sl tl ks ml dt ams` ×op1-4 (3桁ゼロ埋めが慣例)
  //   FMP7   : `'@ FA n` / `'@ AR,DR,SR,RR,SL,TL,KS,ML,DT,AM` ×4 / `'@ AL,FB` (' の無い行はコメント)
  //   MUCOM88: `  @n`(先頭空白2つ以上) / `FB,AL` / `AR,DR,SR,RR,SL,TL,KS,ML,DT ; opN` ×4
  //   op1..op4 はいずれも論理順(op2=レジスタ+8)。SSG-EGはPMD/FMP7/MUCOM88の書式に無いので、
  //   使われている時だけコメントで添える。
  //   OPLL系: @OT(このツール/mck、MGSDRV互換の並び)、@v(MGSDRV)、@OP(生8バイト、mck)。
  const FM_PATCH_FORMATS = {
    opn:  [{ id: 'pmd', label: 'PMD' }, { id: 'fmp7', label: 'FMP7' }, { id: 'mucom88', label: 'MUCOM88' }, { id: 'regs', label: 'レジスタ(バイナリ)' }],
    opll: [{ id: 'ot', label: '@OT (mck)' }, { id: 'mgs', label: '@v (MGSDRV)' }, { id: 'op', label: '@OP (バイナリ8バイト)' }]
  };
  const FM_PATCH_FMT_KEY = { opn: 'kbdFmPatchFmtOpn', opll: 'kbdFmPatchFmtOpll' };
  function getFmPatchFormat(type) {
    const list = FM_PATCH_FORMATS[type] || [];
    let id = null;
    try { id = localStorage.getItem(FM_PATCH_FMT_KEY[type]); } catch (e) { /* ignore */ }
    return list.some(f => f.id === id) ? id : (list[0] ? list[0].id : null);
  }
  function setFmPatchFormat(type, id) {
    try { localStorage.setItem(FM_PATCH_FMT_KEY[type], id); } catch (e) { /* ignore */ }
  }

  function fmtPatchRows(width, groups, sep, indent) {
    // groups: [{ labels:[...], rows:[[...],[...]], prefix?, tail?:[..] }, ...]
    sep = sep === undefined ? ',' : sep; indent = indent === undefined ? '  ' : indent;
    const lines = [];
    for (const g of groups) {
      if (g.labels) lines.push('; ' + g.labels.map(l => String(l).padStart(width)).join(' '));
      g.rows.forEach((row, i) => {
        const tail = g.tails && g.tails[i] ? g.tails[i] : '';
        lines.push((g.prefix !== undefined ? g.prefix : indent) + row.map(v => String(v).padStart(width)).join(sep) + (g.trailingComma === false ? '' : ',') + tail);
      });
    }
    // 最終行の末尾カンマだけ落とす(コメント末尾なら手前のデータ行)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*;/.test(lines[i])) continue;
      lines[i] = lines[i].replace(/,(\s*;.*)?$/, '$1');
      break;
    }
    return lines.join('\n');
  }

  // ---- OPLL / VRC7 (YM2413系) ----
  const opllOpRow = (o) => [o.AR, o.DR, o.SL, o.RR, o.KL, o.ML, o.AM, o.PM, o.EG, o.KR, o.WF];
  const OPLL_OP_LABELS = ['AR', 'DR', 'SL', 'RR', 'KL', 'ML', 'AM', 'VB', 'EG', 'KR', 'DT'];
  // {mod,car} → VRC7/OPLLのカスタム音色レジスタ8バイト(lexer.js parseVrc7ToneAltDef / vrc7.js dump2patch の逆)
  function opllPatchBytes(p) {
    const m = p.mod, c = p.car;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15)
    ];
  }
  function formatOpllPatch(p, fmt, ch) {
    const m = p.mod, c = p.car;
    const head = `; ${ch.id} inst ${p.inst}${p.inst === 0 ? ' (user)' : ' (ROM)'}`;
    if (fmt === 'op') {
      return head + '\n@OP0 = {\n  ' + opllPatchBytes(p).map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(',') + '\n}';
    }
    const body = fmtPatchRows(2, [
      { labels: ['TL', 'FB'], rows: [[m.TL, m.FB]] },
      { labels: OPLL_OP_LABELS, rows: [opllOpRow(m), opllOpRow(c)] }
    ]);
    if (fmt === 'mgs') return head + '\n@v0 = {\n' + body + '\n}';
    return head + '\n@OT0 = {\n' + body + '\n}';
  }

  // ---- OPN (YM2612 / YM2610) ----
  function opnExtraComments(p) {
    const lines = [];
    if (p.ops.some(o => o.SE)) lines.push('; ssg-eg ' + p.ops.map(o => o.SE).join(' ') + ' (op1..op4)');
    // OPM(YM2151)のみ: DT2(粗デチューン 0/+600/+781/+950セント)。OPNには無いフィールド
    if (p.ops.some(o => o.DT2)) lines.push('; dt2 ' + p.ops.map(o => o.DT2 || 0).join(' ') + ' (op1..op4)');
    lines.push(`; ams ${p.AMS} pms ${p.PMS} pan ${p.L ? 'L' : '-'}${p.R ? 'R' : '-'}`);
    return lines.join('\n');
  }
  function formatOpnPatch(p, fmt, ch) {
    const head = `; ${ch.id}`;
    const pmdRow = (o) => [o.AR, o.DR, o.SR, o.RR, o.SL, o.TL, o.KS, o.ML, o.DT, o.AM];
    if (fmt === 'fmp7') {
      const body = fmtPatchRows(3, [
        { labels: ['AR', 'DR', 'SR', 'RR', 'SL', 'TL', 'KS', 'ML', 'DT', 'AM'], rows: p.ops.map(pmdRow), prefix: "'@ ", trailingComma: false },
        { labels: ['AL', 'FB'], rows: [[p.AL, p.FB]], prefix: "'@ ", trailingComma: false }
      ]);
      return `${head}\n'@ FA 0\n` + body + '\n' + opnExtraComments(p);
    }
    if (fmt === 'mucom88') {
      const body = fmtPatchRows(3, [
        { labels: ['FB', 'AL'], rows: [[p.FB, p.AL]], prefix: '   ', trailingComma: false },
        { labels: ['AR', 'DR', 'SR', 'RR', 'SL', 'TL', 'KS', 'ML', 'DT'], rows: p.ops.map(o => [o.AR, o.DR, o.SR, o.RR, o.SL, o.TL, o.KS, o.ML, o.DT]),
          prefix: '  ', trailingComma: false, tails: [' ; op1', ' ; op2', ' ; op3', ' ; op4'] }
      ]);
      return `${head}\n  @0\n` + body + '\n' + opnExtraComments(p);
    }
    if (fmt === 'regs') {
      // レジスタ順(op1,op3,op2,op4)で $30〜$90 の各グループと $B0/$B4。ch1相当のオフセット0で表記
      const regOrder = [0, 2, 1, 3]; // 論理op → レジスタスロット順に並べ替え
      const hx = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
      const grp = (label, f) => `; ${label}\n  ` + regOrder.map(i => hx(f(p.ops[i]))).join(',');
      return [head + ' (register order op1,op3,op2,op4 = +0,+4,+8,+12)',
        grp('$30 DT/ML', o => (o.DT << 4) | o.ML),
        grp('$40 TL', o => o.TL),
        grp('$50 KS/AR', o => (o.KS << 6) | o.AR),
        grp('$60 AM/DR', o => (o.AM << 7) | o.DR),
        grp('$70 SR', o => o.SR),
        grp('$80 SL/RR', o => (o.SL << 4) | o.RR),
        grp('$90 SSG-EG', o => o.SE),
        '; $B0 FB/AL\n  ' + hx((p.FB << 3) | p.AL),
        '; $B4 L/R/AMS/PMS\n  ' + hx((p.L << 7) | (p.R << 6) | (p.AMS << 4) | p.PMS)
      ].join('\n');
    }
    // PMD(既定): 3桁ゼロ埋め・空白区切りが慣例
    const z3 = (v) => String(v).padStart(3, '0');
    const lines = [head, '; nm  alg fbl', `@000 ${z3(p.AL)} ${z3(p.FB)}`, ';  ar  dr  sr  rr  sl  tl  ks  ml  dt ams'];
    for (const o of p.ops) lines.push(' ' + pmdRow(o).map(z3).join(' '));
    lines.push(opnExtraComments(p));
    return lines.join('\n');
  }

  // ch.fmPatch → 表示テキスト(無ければnull)。fmt省略時は保存済み/既定の書式
  function formatFmPatch(ch, fmt) {
    const p = ch && ch.fmPatch;
    if (!p) return null;
    const f = fmt || getFmPatchFormat(p.type);
    if (p.type === 'opll') return formatOpllPatch(p, f, ch);
    if (p.type === 'opn') return formatOpnPatch(p, f, ch);
    return null;
  }
  // テキスト → 色分けHTML(コメント=先頭';'の行と行中の';'以降、それ以外=データ)
  function renderFmPatchHtml(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split('\n').map((line) => {
      const i = line.indexOf(';');
      if (i < 0) return `<span class="kbd-patch-data">${esc(line)}</span>`;
      if (/^\s*;/.test(line)) return `<span class="kbd-patch-comment">${esc(line)}</span>`;
      return `<span class="kbd-patch-data">${esc(line.slice(0, i))}</span><span class="kbd-patch-comment">${esc(line.slice(i))}</span>`;
    }).join('\n');
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
  // drums: {lanes:[{label,color}], laneOf:Map(drumKey→レーン番号)} ドラム区画のパッド。
  // 省略/空なら区画なし(音程軸の座標は従来と完全に一致する)。
  function drawPiano(canvas, channels, orientation, visibleWhite, offsetWhite, drums) {
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
    const drumLanes = (drums && drums.lanes) || [];
    const drumUnits = drumLanes.length * DRUM_LANE_WHITE;
    const wkW = pitchLen / (visibleWhite || (TOTAL_WHITE + drumUnits));  // 白鍵1本の太さ(音程軸方向)
    const offPx = (offsetWhite || 0) * wkW;  // 表示窓の低音側の端(px)。keyX()の結果からこれを引く
    const drumLaneW = DRUM_LANE_WHITE * wkW;
    const pitchOff = drumUnits * wkW - offPx; // 音程側の座標補正(ドラム区画ぶん右へ + 窓スクロール)
    const bkW = Math.max(3, wkW * 0.60); // 黒鍵の太さ
    const bkH = Math.round(keyLen * 0.62); // 黒鍵の長さ
    const ctx = canvas.getContext('2d');

    const keyColors = {};
    const laneColors = {}; // ドラム区画: レーン番号 → 今そこを鳴らしているchの色
    for (const ch of channels) {
      if (!ch.active) continue;
      // 打楽器として鳴っているサンプルPCMは音程を持たないのでドラム区画のパッドを光らせる
      if (ch.drumKey && drums && drums.laneOf) {
        const lane = drums.laneOf.get(ch.drumKey);
        if (lane !== undefined && laneColors[lane] === undefined) laneColors[lane] = ch.color;
        continue;
      }
      // ノイズch/DPCM(サンプル)chはそれぞれch.noiseIndex/ch.dmcRateIdxを疑似ノートとして使う
      // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)。YM2610 ADPCM-A/Bは
      // 解析済みピッチ(adpcmExact)またはDelta-N由来レートを adpcmPitchToMidi で音程へ。
      const midi = ch.noise ? noisePeriodIndexToMidi(ch.noiseIndex)
        : ch.adpcmPitch ? adpcmPitchToMidi(ch)
        : ch.sample ? dmcRateIndexToMidi(ch.dmcRateIdx)
        : (ch.freq ? freqToMidi(ch.freq) : null);
      if (midi !== null && !keyColors[midi]) keyColors[midi] = ch.color;
    }

    ctx.clearRect(0, 0, W, H);

    // ドラム区画のパッド(鍵盤の代わり)。1パッド=1サンプル。手前側(=ロールと反対の端)に
    // レーン色の帯とラベルを出し、鳴っている間は鍵と同じくchの色で点灯する。
    for (let i = 0; i < drumLanes.length; i++) {
      const x0 = i * drumLaneW - offPx;
      if (x0 + drumLaneW < 0 || x0 > pitchLen) continue; // 表示窓の外
      const laneColor = drumLanes[i].color || DRUM_OTHER_COLOR;
      const lit = laneColors[i];
      ctx.fillStyle = lit || '#2f2c3a';
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      if (vertical) {
        ctx.fillRect(x0 + 0.5, 0.5, drumLaneW - 1, keyLen - 1);
        ctx.strokeRect(x0 + 0.5, 0.5, drumLaneW - 1, keyLen - 1);
        ctx.fillStyle = laneColor; // ロール側(上端)にレーン色の帯 = ロールの打点の塗りと同じ色
        ctx.fillRect(x0 + 1.5, 1.5, drumLaneW - 3, 5);
        if (drumLaneW >= 9) { // ラベルは縦書き(90度回転)。レーンが細いときは省略
          ctx.save();
          ctx.translate(x0 + drumLaneW / 2, keyLen - 5);
          ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = lit ? '#1a1830' : '#a9a3bb';
          ctx.font = Math.min(9, Math.floor(drumLaneW) - 2) + 'px ' + fontStack('mono');
          ctx.textBaseline = 'middle';
          ctx.fillText(drumLanes[i].label, 0, 0);
          ctx.restore();
        }
      } else {
        const y = H - x0 - drumLaneW;
        ctx.fillRect(0.5, y + 0.5, keyLen - 1, drumLaneW - 1);
        ctx.strokeRect(0.5, y + 0.5, keyLen - 1, drumLaneW - 1);
        ctx.fillStyle = laneColor; // ロール側(右端)にレーン色の帯
        ctx.fillRect(keyLen - 6.5, y + 1.5, 5, drumLaneW - 3);
        if (drumLaneW >= 9) {
          ctx.fillStyle = lit ? '#1a1830' : '#a9a3bb';
          ctx.font = Math.min(9, Math.floor(drumLaneW) - 2) + 'px ' + fontStack('mono');
          ctx.textBaseline = 'middle';
          ctx.fillText(drumLanes[i].label, 4, y + drumLaneW / 2 + 0.5);
        }
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x += pitchOff;
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
        // Cの音名(横向きと同じく鍵に書く)。黒鍵に隠れない手前側=下端寄りへ
        if (semi === 0 && wkW >= 8) {
          ctx.fillStyle = color ? '#1a1830' : '#6b6b7a';
          ctx.font = Math.min(9, Math.floor(wkW) - 1) + 'px ' + fontStack('sans');
          ctx.textBaseline = 'bottom';
          ctx.fillText(midiToName(midi), pos.x + 2, keyLen - 9);
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
        // Cの音名は鍵の上(黒鍵に隠れない手前側)に書く。鍵が細すぎるときは省略する
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
      pos.x += pitchOff;
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
      this._drumLanes = [];       // ドラム区画のレーン表 [{key,label,color,subN}](_rebuildDrumLanes)
      this._drumLaneOf = new Map(); // drumKey → レーン番号(鍵盤のパッド点灯用)
      this._rollCursor = {};      // track.id → 「もう画面上端より上に流れ去った」最初のnote index(_renderRollの走査起点キャッシュ)
      this._rollSongTimeBase = 0; // 最後に実測位置が更新された時点での「曲内基準の経過時間」(確定値)
      this._rollLastRawPos = null; // 直前に_renderRollへ渡された実時間(壁時計)位置
      this._rollBaseWallMs = null; // _rollSongTimeBase確定時点のperformance.now()(補間の起点)
      this.onMuteChange = null;
      this._poolModes = {};             // チャンネルプール式チップの表示モード(chipToken → 'logical'|'phys')
      this.onPoolModeChange = null;     // (chipToken, mode) => void  ヘッダのモード切替
      this.onSpcMuteChange = null; // (voiceIndex:number, muted:bool) => void
      this.onSpeedChange = null;   // (factor:number) => void  曲切替をまたいで保持する
      this.onMasterVolumeChange = null; // (vol:0〜1) => void  曲切替をまたいで保持する
      this.onLayoutChange = null;       // (layout) => void  setLayout()で設定が変わった時
      this.onRollSeek = null;           // (seconds:実時間) => 実際にシークした秒|null  ロールのドラッグシーク(_attachRollSeekDrag)
      this._rollDrag = null;            // ドラッグシーク中の状態 {id,x,y,startPos,pos,moved}
      this._spotlightHoverId = null;    // スポットライト(案D): ホバー中の行のch.id(一時的)
      this._spotlightPinnedId = null;   // スポットライト(案D): ch名クリックで固定した行のch.id(ホバーより優先)
      this._rollSeekBarEls = null;      // ロール見出し行に置くシークバー要素(setRollSeekBar)
      this._lanes = [];                 // チャンネルごとのレーン [{id, laneEl, rollCanvas, pianoCanvas}](_rebuildLanes)
      this._lanesEl = null;
      this._sizeObserver = null;
      this._sourceInfo = null;          // 表示中の再生ソース {kind, name}(setSourceInfo)。タイトル行のバッジに出す
      this._srcBadgeEl = null;
      this._titleEl = null;
      this._transportEl = null;         // タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭)。バッジの右に置く
      this._transportBtns = null;       // { prev, play, stop, next }
      // 再生コントロールの状態(main.js が setTransportState() で更新する)。canPrevNext は
      // 「m3u/アーカイブを開いていればその曲送り、実ファイル単体なら曲番号送り」が可能か
      // どうかで、MML再生を表示中は常に false(=グレーアウト)。
      this._transportState = { playing: false, canPlay: false, canStop: false, canPrevNext: false, canToggleSource: false };
      this.onTransport = null;          // (action:'play'|'stop'|'prev'|'next') => void
      this.onSourceToggle = null;       // () => void  バッジ(ファイル名)クリックでMML↔サウンドファイル切替
      this._rollLastDrawnPos = 0;       // _renderRoll()が最後に描いた曲内秒(ドラッグ開始位置の基準)
      this._pendingSelectionReset = false; // reset()が立てるフラグ。次に実データでチャンネル一覧が
                                            // 判明した時(setSource()/updateSpcVoices())、大波形の選択
                                            // (_selectedId)がそこにも存在すれば維持・無ければ一番若い
                                            // chへ切替える一度きりの判定を行う(_consumePendingSelectionReset)
      this._masterVolume = loadMasterVolume(); // localStorage永続化(mml_masterVolume)
      this.onVolumeChange = null;       // () => void  ch別音量バー操作時(getVolumeConfig()参照)
      this.onAdpcmCalibrate = null;     // (ch) => void  YM2610 ADPCM行のnote列クリック(手動ピッチ補正。ch.adpcmSample={kind,start,end})
      // ドラム区画のパッドクリック試聴。(sampleKey, mode:'raw'|'dpcm') => void
      // ★PCM→DMCは必ず劣化するので、レートを耳で決められることが必須(ユーザー指示)。
      //   パッドは1枚=1サンプルなので「複数chが同時に鳴っていて何を聴いているか分からない」
      //   問題が原理的に起きない。
      this.onDrumAudition = null;
      this._drumAuditionMode = 'raw';
      this.onOpenFile = null;         // ヘッダの「ファイルを開く」
      this.onToMml = null;            // ヘッダの「to MML」
      this.onRepeatModeChange = null; // 曲が終わった後の挙動が変わったとき
      this._repeatBtnEl = null;
      this._repeatMode = 'next';
      try {
        const m = localStorage.getItem(REPEAT_MODE_KEY);
        if (m && REPEAT_MODES.indexOf(m) >= 0) this._repeatMode = m;
      } catch (e) { /* ignore */ }
      // (ch, kind:'drum'|'pitch'|null) => void  note列の小メニューでの打楽器/音階の手動指定
      this.onSampleKind = null;
      this._sampleMenuEl = null;
      this._sampleMenuOutside = null;
      this.onSpcVolumeChange = null;    // (volArray:number[8]) => void
      this._channelVolumes = loadChannelVolumes();   // channelId → 0〜2(1=100%、localStorage永続化)
      this._spcVoiceVolumes = loadSpcVoiceVolumes(); // [V0..V7] → 0〜2(1=100%、localStorage永続化)
      this._colorOverrides = loadColorOverrides(); // channelId → ユーザー指定色(localStorage永続化)
      // チャンネル割当(案E): 一覧に「借用先」列を出すか(トグル状態はlocalStorage永続化)。
      // 幅が足りないレイアウトでは列を隠し、part列チップ→ポップオーバー経由で編集する。
      try { this._assignMode = localStorage.getItem('mml_kbdAssignMode') === '1'; } catch (e) { this._assignMode = false; }
      this._assignPop = null;
      this._assignPopClose = null;
      this._layout = loadLayoutSettings();         // ロールの向き/置き場/一覧の多段(localStorage永続化)
      // 下配置でのロール高さ / 右配置での一覧幅(どちらもスプリッターで変更、localStorage永続化)
      this._rollHeight = ROLL_CANVAS_HEIGHT;
      // 一覧/大波形のサイズ(スプリッターで可変。0=未設定でCSS既定)
      this._listRowsHeight = 0;
      this._bigWaveWidth = 0;
      try {
        const rh = parseInt(localStorage.getItem('mml_keyboardRowsHeight'), 10);
        if (Number.isFinite(rh) && rh >= 60) this._listRowsHeight = rh;
        const ww = parseInt(localStorage.getItem('mml_keyboardWaveWidth'), 10);
        if (Number.isFinite(ww) && ww >= 120) this._bigWaveWidth = ww;
      } catch (e) { /* ignore */ }
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

      // 再生コントロール(⏮ ▶/⏸ ■ ⏭)。バッジ(=今どちらを表示中かのファイル名)の右に置き、
      // 「今鳴っている方(MML側 / サウンドファイル側)」をそのまま操作する。⏮⏭ は
      // アーカイブ(m3u)を開いていればその曲送り、実ファイル単体なら曲番号送りで、
      // MML再生を表示中は操作対象が無いのでグレーアウトする(setTransportState)。
      const transportBar = this._buildTransportBar();
      // 曲が終わった後の挙動(次の曲 / 1曲リピート / ランダム / 停止)。1つのアイコンが
      // クリックのたびに切り替わる。ファイル名バッジの左に置く
      const repeatBtn = this._buildRepeatBtn();
      // ファイルを開く / to MML。ヘッダ左端(旧「鍵盤表示」の文字の位置)へ移す。
      // 元のツールバー側のボタンをそのまま押す複製なので、動作の実体は1箇所のまま
      const openBtn = this._buildProxyBtn('kbd-open-btn', T('ファイルを開く'),
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5c0-.83.67-1.5 1.5-1.5h3.4l1.4 1.6H16c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5v-8.6Z"/></svg>',
        () => { if (this.onOpenFile) this.onOpenFile(); });
      const toMmlBtn = this._buildProxyBtn('kbd-tomml-btn', T('MMLへ変換'),
        '<span class="kbd-tomml-text">to MML</span>',
        () => { if (this.onToMml) this.onToMml(); });

      const winEl = this.container.closest('.float-window');
      const headerEl = winEl && winEl.querySelector('.float-window-header');
      if (headerEl) {
        for (const sel of ['.kbd-mastervol', '.kbd-speed', '.kbd-layout-btn', '.kbd-src-badge', '.kbd-transport']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        for (const sel of ['.kbd-open-btn', '.kbd-tomml-btn', '.kbd-repeat-btn']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        const closeBtn = headerEl.querySelector('.float-window-close');
        headerEl.insertBefore(speedBar, closeBtn || null);
        headerEl.insertBefore(masterVolBar, speedBar);
        // ★ヘッダ左端は「鍵盤表示」という文字ではなく[ファイルを開く][レイアウト][to MML]。
        //   タイトル文字はウィンドウの見出しとして自明なので置かない(ユーザー指示)
        const titleEl = headerEl.querySelector('span');
        if (titleEl && !titleEl.classList.contains('kbd-src-badge')) {
          titleEl.textContent = '';
          titleEl.style.display = 'none';
          this._titleEl = titleEl;
        }
        headerEl.insertBefore(openBtn, titleEl || masterVolBar);
        headerEl.insertBefore(layoutBtn, titleEl || masterVolBar);
        headerEl.insertBefore(toMmlBtn, titleEl || masterVolBar);
        this._srcBadgeEl = document.createElement('span');
        this._srcBadgeEl.className = 'kbd-src-badge';
        this._srcBadgeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!this._transportState.canToggleSource) return;
          if (this.onSourceToggle) this.onSourceToggle();
        });
        // ファイル名バッジの左に [再生コントロール][終了後の挙動] を置く(ユーザー指示)
        headerEl.insertBefore(this._srcBadgeEl, masterVolBar);
        headerEl.insertBefore(transportBar, this._srcBadgeEl);
        headerEl.insertBefore(repeatBtn, this._srcBadgeEl);
        this._renderSourceBadge();
        this._renderTransport();
      } else {
        left.appendChild(transportBar); // フォールバック(タイトル行が見つからない場合)
        left.appendChild(masterVolBar);
        left.appendChild(speedBar);

        left.appendChild(layoutBtn);
        this._renderTransport();
      }

      const header = document.createElement('div');
      header.className = 'kbd-header';
      header.innerHTML =
        headerAssignBtnHtml() +
        headerMuteAllBtnHtml() +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-assign">${T('借用先')}</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        headerVolResetBtnHtml() +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbd-h-freq">freq</span>`;
      // L/R列(SPCのステレオパン表示と同じクラスを流用)はHES(PSG)のみ値が入り、
      // 他フォーマットは空欄のまま(_rebuildRows参照)。
      // dot 列オフセット不要（kbd-h-part が dot+パート文字両方をカバー）
      this._headerEl = header;
      // DPCM(打楽器を実サンプルのまま焼く)の実コスト表示。借用先にDPCMを選んだ瞬間に
      // 「1本増やしたらROMが何KB増えるか」が見えないと選びようがないため、割当UIのすぐ下に出す
      // (ユーザー要望。実機ROMの容量を意識する方針 [[nsf-export-size-consciousness]])
      this._dpcmCostEl = document.createElement('div');
      this._dpcmCostEl.className = 'kbd-dpcm-cost';
      this._dpcmCostEl.style.display = 'none';
      left.appendChild(header);

      this._rowsEl = document.createElement('div');
      this._rowsEl.className = 'kbd-rows';
      // 行本体は内側の要素に入れる(.kbd-rowsは縦スクロールの箱、.kbd-rows-innerが1列/多段の
      // 並べ方を担当。多段のとき高さauto=中身なりに伸びるので、はみ出しは横でなく縦スクロールになる)
      left.appendChild(this._dpcmCostEl);
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
        headerAssignBtnHtml() +
        headerMuteAllBtnHtml() +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-assign">${T('借用先')}</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        headerVolResetBtnHtml() +
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

      // 見出しのボタン(part列=チャンネル割当トグル / mute列=一括ミュート)を配線する。
      // メイン一覧とSPC一覧で見出しが2つあるので、両方まとめて拾って同じ動作にする。
      this._assignBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-assign-btn'));
      for (const b of this._assignBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._setAssignMode(!this._assignMode); });
      }
      this._muteAllBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-muteall-btn'));
      for (const b of this._muteAllBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._toggleAllMute(); });
      }
      for (const b of left.querySelectorAll('.kbd-volreset-btn')) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._resetAllVolumes(); });
      }

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
      this._bigCopyBtn.textContent = T('📋波形');
      this._bigCopyBtn.title = T('この波形データをクリップボードへコピー(他の波形エディタへ貼り付け可)');
      this._bigCopyBtn.disabled = true;
      this._bigWaveCopyData = null;
      this._bigCopyBtn.addEventListener('click', () => {
        if (!this._bigWaveCopyData || !(MML.UI && MML.UI.WaveClipboard)) return;
        MML.UI.WaveClipboard.copyValues(this._bigWaveCopyData).then((ok) => {
          const orig = T('📋波形');
          this._bigCopyBtn.textContent = ok ? T('✓ コピー完了') : T('✗ 失敗');
          setTimeout(() => { this._bigCopyBtn.textContent = orig; }, 1000);
        });
      });
      // FM音色データ(OPLL/VRC7=@OT形式、YM2612/YM2610=OPN形式)のコピー。大波形の下の
      // テキスト(_bigPatchEl)と同じ内容をクリップボードへ(formatFmPatch参照)
      this._bigPatchCopyBtn = document.createElement('button');
      this._bigPatchCopyBtn.className = 'kbd-bigwave-copy secondary';
      this._bigPatchCopyBtn.textContent = T('📋音色');
      this._bigPatchCopyBtn.title = T('このFM音色データ(下のテキスト)をクリップボードへコピー');
      this._bigPatchCopyBtn.style.display = 'none';
      this._bigPatchText = null;
      this._bigPatchCopyBtn.addEventListener('click', () => {
        if (!this._bigPatchText) return;
        const orig = T('📋音色');
        navigator.clipboard.writeText(this._bigPatchText).then(
          () => { this._bigPatchCopyBtn.textContent = T('✓ コピー完了'); },
          () => { this._bigPatchCopyBtn.textContent = T('✗ 失敗'); }
        ).finally(() => setTimeout(() => { this._bigPatchCopyBtn.textContent = orig; }, 1000));
      });
      // 音色データの書式選択(FM_PATCH_FORMATS: OPN=PMD/FMP7/MUCOM88/レジスタ、OPLL=@OT/@v/@OP)。
      // FMチャンネル選択時だけ表示、選択は音源種別ごとにlocalStorageへ保存
      this._bigPatchFmtSel = document.createElement('select');
      this._bigPatchFmtSel.className = 'kbd-bigwave-fmt';
      this._bigPatchFmtSel.title = T('音色データの書式');
      this._bigPatchFmtSel.style.display = 'none';
      this._bigPatchFmtType = null; // 今optionを入れてある音源種別('opn'/'opll')
      this._bigPatchCh = null;      // 音色テキストを出している対象ch(書式変更時の再描画用)
      this._bigPatchFmtSel.addEventListener('change', () => {
        if (!this._bigPatchFmtType) return;
        setFmPatchFormat(this._bigPatchFmtType, this._bigPatchFmtSel.value);
        this._bigPatchText = null; // 強制更新
        if (this._bigPatchCh) this._renderBigWave(this._bigPatchCh);
      });
      bigHeader.appendChild(this._bigToggleEl);
      bigHeader.appendChild(this._bigTitleEl);
      bigHeader.appendChild(this._bigCopyBtn);
      bigHeader.appendChild(this._bigPatchFmtSel);
      bigHeader.appendChild(this._bigPatchCopyBtn);
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
      // 本体 = 大波形canvas + FM音色データ(FMチャンネル選択時のみ表示、_renderBigWave が更新)。
      // 音色データの箱は大波形と同じ大きさ(CSS .kbd-bigwave-patch)で、置き場は
      //  ・ロールが右(大波形が一覧の左下)      → 大波形の下(従来どおり)
      //  ・ロールが下で一覧が1列               → 大波形の下
      //  ・ロールが下/別窓で一覧が幅に応じて多段 → 大波形の右(.kbd-bigwave--patch-right、_applyLayoutClasses)
      const bigBody = document.createElement('div');
      bigBody.className = 'kbd-bigwave-body';
      bigBody.appendChild(this._bigCanvas);
      this._bigPatchEl = document.createElement('pre');
      this._bigPatchEl.className = 'kbd-bigwave-patch';
      this._bigPatchEl.style.display = 'none';
      bigBody.appendChild(this._bigPatchEl);
      big.appendChild(bigBody);
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
      // 一覧(音源ごとのCH表示)と大波形の間のスプリッター。大波形が一覧の下にあるとき(縦並び)
      // はCH一覧の高さを、右にあるとき(横並び)は大波形の幅を変える。ユーザー要望で
      // 「各表示の境目でサイズを変えられる」ようにするためのもの
      this._waveSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
        const h = Math.max(60, Math.round(start + delta));
        this._listRowsHeight = h;
        this._rowsEl.style.flex = 'none';
        this._rowsEl.style.height = h + 'px';
      }, () => this._rowsEl.offsetHeight, () => {
        try { localStorage.setItem('mml_keyboardRowsHeight', String(this._listRowsHeight)); } catch (e) { /* ignore */ }
      });
      this._waveSplitterVEl = this._makeSplitter('vertical', (delta, start) => {
        const w = Math.max(120, Math.round(start - delta)); // 左へドラッグ=大波形が広くなる
        this._bigWaveWidth = w;
        this._bigWaveEl.style.flex = 'none';
        this._bigWaveEl.style.width = w + 'px';
      }, () => this._bigWaveEl.offsetWidth, () => {
        try { localStorage.setItem('mml_keyboardWaveWidth', String(this._bigWaveWidth)); } catch (e) { /* ignore */ }
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
      this._leftEl.classList.toggle('kbd-left--assign', !!this._assignMode);
      this._applyLayoutClasses();
      // チャンネル割当が変わったら(この鍵盤表示のセレクト経由でも、他のUI経由でも)
      // part列の文字・スキップ減光・重複警告を貼り直す
      // ★_build()は言語切替のたびに走るので、購読は初回だけ(毎回足すとリスナーが増え続ける)
      const plan = channelPlan();
      if (plan && !this._planHooked) {
        this._planHooked = true;
        plan.onChange(() => this._refreshAssignUi());
      }
      this._renderAssignToggle();
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
        `<span class="kbd-roll-drum-audition" style="display:none">` +
          `<span class="kbd-roll-drum-label">${T('パッド試聴')}</span>` +
          `<button type="button" class="kbd-drum-aud-btn kbd-drum-aud-btn--on" data-mode="raw">${T('原音')}</button>` +
          `<button type="button" class="kbd-drum-aud-btn" data-mode="dpcm">DPCM</button>` +
        `</span>` +
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
      // ドラム区画のパッド試聴の切替(原音 / DPCM変換後)。区画があるときだけ出す
      this._drumAuditionEl = rollHeader.querySelector('.kbd-roll-drum-audition');
      for (const btn of rollHeader.querySelectorAll('.kbd-drum-aud-btn')) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._drumAuditionMode = btn.dataset.mode;
          for (const b of rollHeader.querySelectorAll('.kbd-drum-aud-btn')) {
            b.classList.toggle('kbd-drum-aud-btn--on', b.dataset.mode === this._drumAuditionMode);
          }
        });
      }

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
          drawPiano(l.pianoCanvas, allChannels.filter(c => c.id === l.id), this._layout.rollOrientation, LANE_VISIBLE_WHITE, off, this._drumsForPiano());
          if (this._drumLanes && this._drumLanes.length) this._attachDrumAudition(l.pianoCanvas);
        }
        return;
      }
      drawPiano(this._canvas, allChannels, this._layout.rollOrientation, 0, 0, this._drumsForPiano());
      // ドラム区画があるときだけパッド試聴を有効にする(区画=パッドが無ければ押す物が無い)
      const hasDrums = !!(this._drumLanes && this._drumLanes.length);
      if (hasDrums) this._attachDrumAudition(this._canvas);
      if (this._drumAuditionEl) this._drumAuditionEl.style.display = (hasDrums && this.onDrumAudition) ? '' : 'none';
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
      const base = (isMml ? T('MML再生を表示中') : T('サウンドファイル再生を表示中')) + (name ? `: ${name}` : '');
      el.title = this._transportState.canToggleSource
        ? base + '\n' + T('クリックでMML再生 / サウンドファイル再生を切り替え')
        : base;
      el.classList.toggle('kbd-src-badge--clickable', !!this._transportState.canToggleSource);
    }

    // ── タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭) ───────────────────
    // 操作対象は「今表示している方」(バッジと同じ = MML再生 or サウンドファイル再生)。
    // 実際の再生/停止/曲送りはmain.js側が持っているので、ここは押されたことを
    // onTransport(action)で伝えるだけにして、状態(有効/無効・再生中か)は
    // setTransportState()で外から流し込む。
    _buildTransportBar() {
      const ICONS = {
        prev: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.6 4.5v11h1.8v-11zM16 5.2c0-.8-.9-1.2-1.5-.8l-5.1 4.1a1 1 0 0 0 0 1.6l5.1 4.1c.6.5 1.5 0 1.5-.8z"/></svg>',
        play: '<svg class="icon-play" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.2v11.6c0 .8.9 1.3 1.6.9l9-5.8c.6-.4.6-1.4 0-1.8l-9-5.8c-.7-.4-1.6.1-1.6.9Z"/></svg>' +
              '<svg class="icon-pause" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3.4" height="12"/><rect x="11.6" y="4" width="3.4" height="12"/></svg>',
        stop: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.2"/></svg>',
        next: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.4 4.5v11h-1.8v-11zM4 5.2c0-.8.9-1.2 1.5-.8l5.1 4.1a1 1 0 0 1 0 1.6l-5.1 4.1c-.6.5-1.5 0-1.5-.8z"/></svg>'
      };
      const bar = document.createElement('div');
      bar.className = 'kbd-transport';
      this._transportBtns = {};
      for (const action of ['prev', 'play', 'stop', 'next']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kbd-tp-btn kbd-tp-btn--' + action;
        btn.innerHTML = ICONS[action];
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (btn.disabled) return;
          if (this.onTransport) this.onTransport(action);
        });
        bar.appendChild(btn);
        this._transportBtns[action] = btn;
      }
      return bar;
    }

    // ヘッダへ置く小さな代理ボタン(実体は別の場所のボタン/main.jsのコールバック)
    _buildProxyBtn(cls, title, innerHtml, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-hdr-btn ' + cls;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = innerHtml;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    }

    // 曲が終わった後の挙動。1つのアイコンをクリックのたびに次のモードへ回す
    _buildRepeatBtn() {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-hdr-btn kbd-repeat-btn';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = REPEAT_MODES.indexOf(this._repeatMode);
        this.setRepeatMode(REPEAT_MODES[(i + 1) % REPEAT_MODES.length]);
        if (this.onRepeatModeChange) this.onRepeatModeChange(this._repeatMode);
      });
      this._repeatBtnEl = b;
      this._renderRepeatBtn();
      return b;
    }

    setRepeatMode(mode) {
      if (REPEAT_MODES.indexOf(mode) < 0) mode = 'next';
      this._repeatMode = mode;
      try { localStorage.setItem(REPEAT_MODE_KEY, mode); } catch (e) { /* ignore */ }
      this._renderRepeatBtn();
    }
    getRepeatMode() { return this._repeatMode; }

    _renderRepeatBtn() {
      const b = this._repeatBtnEl;
      if (!b) return;
      const info = REPEAT_ICONS[this._repeatMode] || REPEAT_ICONS.next;
      b.innerHTML = info.svg;
      b.title = info.label();
      b.setAttribute('aria-label', info.label());
      b.classList.toggle('kbd-repeat-btn--stop', this._repeatMode === 'stop');
    }

    // main.js が再生状態の変化ごとに呼ぶ。state: { playing, canPlay, canStop, canPrevNext, canToggleSource }
    setTransportState(state) {
      const s = this._transportState;
      let changed = false;
      for (const k of ['playing', 'canPlay', 'canStop', 'canPrevNext', 'canToggleSource']) {
        const v = !!(state && state[k]);
        if (s[k] !== v) { s[k] = v; changed = true; }
      }
      if (!changed) return; // 毎フレーム呼ばれても実際に変わった時だけDOMを触る
      this._renderTransport();
      this._renderSourceBadge(); // バッジのクリック可否(カーソル/ツールチップ)も一緒に更新
    }

    _renderTransport() {
      const b = this._transportBtns;
      if (!b) return;
      const s = this._transportState;
      b.prev.disabled = !s.canPrevNext;
      b.next.disabled = !s.canPrevNext;
      b.play.disabled = !s.canPlay;
      b.stop.disabled = !s.canStop;
      b.play.classList.toggle('is-playing', s.playing);
      b.play.title = s.playing ? T('一時停止') : T('再生');
      b.stop.title = T('停止');
      b.prev.title = T('前の曲');
      b.next.title = T('次の曲');
    }

    // 大波形に「今表示するch」(_shownWaveId)を、表示中の一覧(rowEls)に合わせて決め直す。
    // ユーザーが選んだch(_selectedId)が一覧にあればそれ、無ければ一番若いch(波形アイコンを
    // 持つ最初の行)を一時的に表示する。_selectedId自体はここでは変えない(停止→再生や曲送りで
    // 一覧が一時的に2A03だけになっても、選択が勝手に若いchへ変わってしまわないように)。
    // ファイルの読み込み直しに伴う「選択を捨てて若いchへ戻すか、同じchが新ファイルにも
    // あるなら維持するか」の判定は_consumePendingSelectionReset()が別途行う(こちらを呼ぶ前に
    // 呼ばれる想定)。一覧の下の折りたたみ帯は自動で開かない(ユーザーがクリックしたときだけ開く)
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

    // reset()(ファイルの読み込み直し)が立てたフラグを、新ファイルの実際のチャンネル一覧
    // (waveIds: 波形を持つ行のid配列)が判明した最初の1回だけ消費して、大波形の選択
    // (_selectedId)を確定させる。同じch(id)が新ファイルにもあれば選択を維持(同じ音源構成の
    // 別ファイルを続けて開いた場合など)、無ければ一番若いchへ切り替える。
    // waveIdsが空(まだ実データが来ていない一覧)の間は消費せず次回に持ち越す。
    // 呼び出し側は結果を_syncShownWave()に反映させるため、この直後に必ず_syncShownWave()を呼ぶこと。
    _consumePendingSelectionReset(waveIds) {
      if (!this._pendingSelectionReset || !waveIds || !waveIds.length) return;
      this._pendingSelectionReset = false;
      if (!waveIds.includes(this._selectedId)) this._selectedId = waveIds[0];
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
    // ロール上の点(clientX/Y)にノートがあればそのトラックidを返す(無ければnull)。
    // 判定は _drawRollCanvas の描画と同じ座標計算を使う。
    //  ・ノートの上 → そのchを大波形へフォーカスする(ドラッグシークはしない)
    //  ・ノートの無いところ → 従来どおりドラッグでシーク
    _trackAtRollPoint(canvas, clientX, clientY, onlyId, lane) {
      if (!this._rollTimeline || !this._rollTimeline.length) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const nDrum = (this._drumLanes || []).length;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? LANE_VISIBLE_WHITE : 0, nDrum);
      // CSS表示サイズ → canvas内部解像度
      const cx = (clientX - r.left) * (canvas.width / r.width);
      const cy = (clientY - r.top) * (canvas.height / r.height);
      // canvas座標 → (音程軸p, 時間軸t)。makeRollGeom の point() の逆変換
      const p = g.vertical ? cx : (g.H - cy);
      const t = g.vertical ? (g.H - cy) : cx;
      if (t < 0 || t > g.timeLen) return null;
      const pos = this._rollLastDrawnPos || 0;
      const sec = pos + t / ROLL_PX_PER_SEC;
      const wkW = g.wk, bkW = g.bk;
      const offPx = lane ? lane.scrollWhite * wkW : 0;
      const pitchOff = g.drumOff - offPx;
      // 手前(描画順が後=最前面)から探したいので逆順に見る
      for (let ti = this._rollTimeline.length - 1; ti >= 0; ti--) {
        const track = this._rollTimeline[ti];
        if (onlyId !== null && track.id !== onlyId) continue;
        for (const note of track.notes) {
          if (note.startSec > sec || note.endSec <= sec) continue;
          let pLo, pSize;
          if (note.drumLane !== undefined) {
            if (note.drumLane >= nDrum) continue;
            const d = drumLaneX(note.drumLane, note.drumSub, note.drumSubN, g.drumLaneW);
            pLo = d.x - offPx + 1;
            pSize = Math.max(2, d.size - 2);
          } else {
            const kp = keyX(note.midi, wkW);
            if (!kp) continue;
            kp.x += pitchOff;
            pLo = kp.isBlack ? kp.x - bkW / 2 : kp.x + 0.5;
            pSize = kp.isBlack ? bkW : (wkW - 1);
          }
          if (p >= pLo && p < pLo + pSize) return track.id;
        }
      }
      return null;
    }

    _attachRollSeekDrag(canvas) {
      canvas.classList.add('kbd-roll--seekable');
      canvas.title = T('音符をクリックでそのchを波形表示へ / 音符の無いところをドラッグでシーク');
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
        // ノートの上で押した場合はシークせず、そのchを大波形へフォーカスする
        const hit = this._trackAtRollPoint(canvas, e.clientX, e.clientY, canvas._rollOnlyId != null ? canvas._rollOnlyId : null, canvas._rollLane || null);
        if (hit) { this._selectWave(hit); e.preventDefault(); return; }
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

    // ── スポットライト(案D) ────────────────────────────────────────
    // チャンネル一覧の行にホバー(一時)/ch名クリック(固定)で「注目ch」を決め、ロール描画で
    // そのchだけを原色・最前面に、他chをSPOTLIGHT_DIM_ALPHAまで減光する。
    // ★ホバー中はホバーが勝ち、マウスが一覧から離れたら固定へ戻る。固定は「マウスを離しても
    //   注目を失わない」ためのもので、他の行を覗く操作を殺すためのものではないため。
    _effectiveSpotlightId() { return this._spotlightHoverId || this._spotlightPinnedId; }

    // 停止中はrAFが回っていないので、注目chが変わったらその場で描き直す。
    // _renderRoll()は同じrawPosを渡しても位置を進めない(実測差分ぶんしか加算しない)ので安全。
    _redrawRollForSpotlight() {
      if (!this._rollTimeline) return;
      this._renderRoll(this._rollLastRawPosForDrag());
    }

    // ★ホバーでのピックアップは「その行の小波形が大波形として選択されている」ときだけ効かせる
    //   (ユーザー指示)。一覧の上をマウスが通るだけで次々ロールが切り替わるのを避け、
    //   「注目したいchを波形で選んでから、その行を指す」という操作に揃える。
    _setSpotlightHover(id) {
      if (id !== null && id !== this._shownWaveId) id = null;
      if (this._spotlightHoverId === id) return;
      this._spotlightHoverId = id;
      this._redrawRollForSpotlight();
    }

    // ch名クリックで固定のON/OFF。同じ行をもう一度クリックすると解除する
    _toggleSpotlightPin(id) {
      this._spotlightPinnedId = (this._spotlightPinnedId === id) ? null : id;
      this._applySpotlightClasses();
      this._redrawRollForSpotlight();
    }

    // 固定中の行に目印クラスを付ける(行の再構築後にも呼んで状態を復元する)
    _applySpotlightClasses() {
      for (const r of (this._rowEls || []).concat(this._spcRowEls || [])) {
        if (!r || !r.row) continue;
        r.row.classList.toggle('kbd-ch-row--spot', r.id === this._spotlightPinnedId);
      }
    }

    // 1行にスポットライトの操作を取り付ける(メイン一覧・SPCボイス行の両方から呼ぶ)。
    // ホバーは行全体、固定はch名セルのクリック(丸=色ピッカー/波形=大波形/note=キャリブレーションと
    // 衝突しない場所を選ぶ)
    _attachSpotlight(row, id) {
      row.addEventListener('mouseenter', () => this._setSpotlightHover(id));
      row.addEventListener('mouseleave', () => this._setSpotlightHover(null));
      const nameEl = row.querySelector('.kbd-name');
      if (!nameEl) return;
      nameEl.classList.add('kbd-name--clickable');
      nameEl.title = T('クリックでこのチャンネルに注目(他chを減光)。もう一度クリックで解除');
      nameEl.addEventListener('click', () => this._toggleSpotlightPin(id));
    }

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
      for (const sp of [this._waveSplitterEl, this._waveSplitterVEl]) {
        if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
      }
      // 置き場に応じて向きの合うスプリッターを一覧と大波形の間へ挟む。
      // 置き場が変わったらインラインサイズは捨てる(縦横で意味が変わるため)
      if (this._bigWaveBelow()) {
        this._bigWaveEl.style.flex = '';
        this._bigWaveEl.style.width = '';
        this._leftEl.appendChild(this._waveSplitterEl);
        this._leftEl.appendChild(big);
        if (this._listRowsHeight) {
          this._rowsEl.style.flex = 'none';
          this._rowsEl.style.height = this._listRowsHeight + 'px';
        }
      } else {
        this._rowsEl.style.flex = '';
        this._rowsEl.style.height = '';
        this._mainEl.appendChild(this._waveSplitterVEl);
        this._mainEl.appendChild(big);
        if (this._bigWaveWidth) {
          big.style.flex = 'none';
          big.style.width = this._bigWaveWidth + 'px';
        }
      }
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
          // 割当表示ONのときは「借用先/音色」列(ASSIGN_COL_WIDTH)が入る幅を下限にする
          // (スプリッターで狭めた幅のままだと右側の列が押し出されて見えなくなるため)
          const base = this._mode === 'spc' ? SPC_LIST_MIN_WIDTH
            : (left.classList.contains('kbd-left--hes') || left.classList.contains('kbd-left--gbs'))
              ? LIST_WIDTH_PAN : LIST_WIDTH_NSF;
          const min = this._assignMode ? base + ASSIGN_COL_WIDTH : (this._mode === 'spc' ? SPC_LIST_MIN_WIDTH : 0);
          const want = Math.max(this._listWidth || 0, min);
          if (want > 0) w = want + 'px';
        }
        left.style.width = w;
      }
      const big = this._bigWaveEl;
      if (big) {
        big.classList.toggle('kbd-bigwave--below', below);
        big.classList.toggle('kbd-bigwave--collapsed', below && this._bigWaveCollapsed);
        // FM音色データの箱: ロールが下/別窓で一覧が多段(幅いっぱい)のときだけ大波形の右、他は下
        big.classList.toggle('kbd-bigwave--patch-right', placement !== 'right' && L.listColumns === 'auto');
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
      // VGMのステレオ定位を持つチップ(SN76489=Game Gearステレオ、YM2612/YM2610=FM/ADPCMのL/R、
      // 32X PWM、RF5C68/164=パン)もGBS用のL/R列表示を流用する。
      // ★以前は gbs/sn76489 だけだったため、SN76489の無い Neo Geo(YM2610)では L/R 列が出ていなかった
      const PAN_CHIPS = ['gbs', 'sn76489', 'ym2612', 'ym2610fm', 'ym2151', 'segapcm', 'c140', 'c352', 'okim6258', 'qsound', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
      this._leftEl.classList.toggle('kbd-left--gbs', PAN_CHIPS.some(c => this._chips.includes(c)));
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
      this._extraSnaps.ym2610FmLive = typeof result.getYm2610Fm === 'function' ? result.getYm2610Fm : null;
      this._extraSnaps.ym2151Live = typeof result.getYm2151 === 'function' ? result.getYm2151 : null;
      this._extraSnaps.ga20Live = typeof result.getGa20 === 'function' ? result.getGa20 : null;
      this._extraSnaps.segapcmLive = typeof result.getSegaPcm === 'function' ? result.getSegaPcm : null;
      this._extraSnaps.c140Live = typeof result.getC140 === 'function' ? result.getC140 : null;
      this._extraSnaps.c352Live = typeof result.getC352 === 'function' ? result.getC352 : null;
      this._extraSnaps.okim6258Live = typeof result.getOkim6258 === 'function' ? result.getOkim6258 : null;
      this._extraSnaps.qsoundLive = typeof result.getQsound === 'function' ? result.getQsound : null;
      this._extraSnaps.okim6295Live = typeof result.getOkim6295 === 'function' ? result.getOkim6295 : null;
      this._extraSnaps.multipcmLive = typeof result.getMultiPcm === 'function' ? result.getMultiPcm : null;
      this._extraSnaps.pwmLive = typeof result.getPwm === 'function' ? result.getPwm : null;
      this._extraSnaps.rf5c164Live = typeof result.getRf5c164 === 'function' ? result.getRf5c164 : null;
      this._extraSnaps.rf5c68Live = typeof result.getRf5c68 === 'function' ? result.getRf5c68 : null;
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
      this._rebuildDrumLanes();
    }

    // ピアノロール用タイムラインを直接差し替える(共通形状: [{color, notes:[{startSec,endSec,midi}]}])。
    // SPC/KSSのような完全リアルタイム合成フォーマットで、裏で走らせた先読みキャプチャの
    // 結果を非同期に反映する際に main.js から呼ばれる。
    setRollTimeline(timeline) {
      this._rollTimeline = timeline || null;
      this._rollCursor = {};
      this._rebuildDrumLanes();
    }

    // ドラム区画のレーン表を、タイムラインのノートに書き込まれた drumLane/drumKey から組み直す。
    // ★配列に生やしたプロパティ(result.drumLanes のような形)はWorkerからのpostMessageの
    //   構造化複製で消えるため、レーン表そのものは渡さず「noteが持っている情報から復元する」
    //   方式にしてある(assignDrumLanes冒頭のコメント参照)。
    // this._drumLanes: [{key, label, color, subN}]  区画に出す順(=レーン番号順)
    // this._drumLaneOf: Map(drumKey → レーン番号)   鍵盤のパッド点灯(drawPiano)用
    // drawPiano()へ渡すドラム区画の情報。区画が無いときはundefinedを返し、鍵盤の描画を
    // 従来と完全に同じにする
    /**
     * DPCMの実コスト表示。cost = {clips, segments, bytes} | null(=DPCM未使用で非表示)。
     * 'pending' を渡すと計算中の表示にする。
     */
    setDpcmCost(cost) {
      if (!this._dpcmCostEl) return;
      if (!cost) { this._dpcmCostEl.style.display = 'none'; return; }
      this._dpcmCostEl.style.display = '';
      if (cost === 'pending') { this._dpcmCostEl.textContent = T('DPCM: 計算中…'); return; }
      const kb = (cost.bytes / 1024).toFixed(1);
      this._dpcmCostEl.innerHTML =
        `<span class="kbd-dpcm-cost-label">DPCM</span>` +
        T('定義 {clips} / 打点 {segments} / ROM {kb} KB', { clips: cost.clips, segments: cost.segments, kb });
      // ROMが大きいときは色で警告(NSFのバンク1本=8KB、実用の目安として32KB/64KB)
      this._dpcmCostEl.classList.toggle('kbd-dpcm-cost--warn', cost.bytes >= 32 * 1024);
      this._dpcmCostEl.classList.toggle('kbd-dpcm-cost--over', cost.bytes >= 64 * 1024);
    }

    // note列クリックの小メニュー。「このサンプルは打楽器か音階か」の手動指定と、
    // 既存の基準音キャリブレーションをまとめて出す。
    // ★指定はサンプル単位(chではない)。プール式チップは同じ太鼓が毎回別スロットへ移るので、
    //   ch単位で持つと指定が飛ぶ。
    _openSampleMenu(anchorEl, ch) {
      this._closeSampleMenu();
      const menu = document.createElement('div');
      menu.className = 'kbd-sample-menu';
      const cur = ch.sampleKind || 'auto'; // 'auto'|'drum'|'pitch'(extractChannelsが載せる)
      const items = [
        ['auto', T('自動判定にまかせる')],
        ['drum', T('打楽器として扱う')],
        ['pitch', T('音階として扱う')],
      ];
      for (const [kind, label] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kbd-sample-menu-item' + (kind === cur ? ' kbd-sample-menu-item--on' : '');
        b.textContent = label;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSampleMenu();
          if (this.onSampleKind) this.onSampleKind(ch, kind === 'auto' ? null : kind);
        });
        menu.appendChild(b);
      }
      if (this.onAdpcmCalibrate) {
        const sep = document.createElement('div');
        sep.className = 'kbd-sample-menu-sep';
        menu.appendChild(sep);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kbd-sample-menu-item';
        b.textContent = T('基準音を手動補正…');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSampleMenu();
          this.onAdpcmCalibrate(ch);
        });
        menu.appendChild(b);
      }
      document.body.appendChild(menu);
      const r = anchorEl.getBoundingClientRect();
      menu.style.left = Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.round(Math.min(r.bottom + 2, window.innerHeight - menu.offsetHeight - 8)) + 'px';
      this._sampleMenuEl = menu;
      // 次のクリックで閉じる(メニュー内のクリックは上でstopPropagation済み)
      this._sampleMenuOutside = () => this._closeSampleMenu();
      setTimeout(() => document.addEventListener('click', this._sampleMenuOutside, { once: true }), 0);
    }

    _closeSampleMenu() {
      if (this._sampleMenuOutside) {
        document.removeEventListener('click', this._sampleMenuOutside);
        this._sampleMenuOutside = null;
      }
      if (this._sampleMenuEl && this._sampleMenuEl.parentNode) this._sampleMenuEl.parentNode.removeChild(this._sampleMenuEl);
      this._sampleMenuEl = null;
    }

    _drumsForPiano() {
      if (!this._drumLanes || !this._drumLanes.length) return undefined;
      return { lanes: this._drumLanes, laneOf: this._drumLaneOf };
    }

    // 鍵盤canvasのクリック位置 → ドラム区画のレーン番号(区画の外なら-1)。
    // 座標系は drawPiano と同じ(音程軸は縦向き=x、横向き=下から上へのy)
    _drumLaneAtPoint(canvas, clientX, clientY) {
      const lanes = this._drumLanes || [];
      if (!lanes.length) return -1;
      const r = canvas.getBoundingClientRect();
      const vertical = this._layout.rollOrientation !== 'horizontal';
      const pitchLen = vertical ? r.width : r.height;
      const p = vertical ? (clientX - r.left) : (r.bottom - clientY);
      const wk = pitchLen / (TOTAL_WHITE + lanes.length * DRUM_LANE_WHITE);
      const lane = Math.floor(p / (DRUM_LANE_WHITE * wk));
      return (lane >= 0 && lane < lanes.length) ? lane : -1;
    }

    // 鍵盤canvasにパッド試聴のクリックを取り付ける(_buildRollPane / _rebuildLanes から)
    _attachDrumAudition(canvas) {
      if (!canvas || canvas._drumAuditionWired) return;
      canvas._drumAuditionWired = true;
      canvas.addEventListener('click', (e) => {
        const lane = this._drumLaneAtPoint(canvas, e.clientX, e.clientY);
        if (lane < 0 || !this.onDrumAudition) return;
        const info = this._drumLanes[lane];
        if (!info || !info.key || info.key === '*') return;
        this.onDrumAudition(info.key, this._drumAuditionMode);
      });
      canvas.addEventListener('mousemove', (e) => {
        const lane = this._drumLaneAtPoint(canvas, e.clientX, e.clientY);
        canvas.style.cursor = (lane >= 0 && this.onDrumAudition) ? 'pointer' : '';
      });
    }

    _rebuildDrumLanes() {
      this._drumLanes = [];
      this._drumLaneOf = new Map();
      const DrumMap = MML.Convert && MML.Convert.DrumMap;
      const tracks = this._rollTimeline || [];
      if (!DrumMap || !tracks.length) return;

      // 1) 曲全体の打点を集めてレーンを決める(vgm2mmlのドラム音符出力と同じ表)
      const obs = [];
      for (const track of tracks) {
        for (const n of track.notes) if (n.drumKey) obs.push({ key: n.drumKey, sec: n.startSec });
      }
      if (!obs.length) return;
      const map = DrumMap.build(obs);

      // 2) 各打点にレーン番号を書き戻し、レーンごとに集める
      const byLane = map.lanes.map(() => []);
      for (const track of tracks) {
        for (const n of track.notes) {
          if (!n.drumKey) continue;
          const lane = map.laneOf.has(n.drumKey) ? map.laneOf.get(n.drumKey) : map.otherLane;
          if (lane < 0 || lane >= byLane.length) { delete n.drumLane; continue; }
          n.drumLane = lane;
          byLane[lane].push(n);
        }
      }

      // 3) レーン内の同時発音をサブスロットへ振る(貪欲な区間彩色。開始時刻の昇順に、
      //    「まだ前の打点が終わっている」一番若いサブスロットへ入れる)。分割数は曲全体で
      //    決まるので、再生位置によって打点の幅が踊らない。
      const lanes = [];
      const labels = DrumMap.labels(map.lanes.map((l) => l.key));
      for (let i = 0; i < byLane.length; i++) {
        const notes = byLane[i];
        notes.sort((a, b) => a.startSec - b.startSec);
        const ends = [];
        for (const n of notes) {
          let s = 0;
          while (s < ends.length && ends[s] > n.startSec + 1e-9) s++;
          n.drumSub = s;
          ends[s] = n.endSec;
        }
        const subN = Math.max(1, ends.length);
        for (const n of notes) n.drumSubN = subN;
        const isOther = map.lanes[i].key === null;
        lanes.push({
          key: map.lanes[i].key,
          label: isOther ? T('他') : (labels[i] || ''),
          color: isOther ? DRUM_OTHER_COLOR : DRUM_LANE_COLORS[i % DRUM_LANE_COLORS.length],
          subN,
        });
      }
      this._drumLanes = lanes;
      this._drumLaneOf = map.laneOf;
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
      this._rebuildDrumLanes();
    }

    // setRollTimelineFromRegSnapshots()のトラック構築部分。VGM(main.js playVgmStream)のように
    // NES APU由来のトラックと他チップ(GB/HuC6280/AY/SCC/OPLL)由来のトラックを1本の
    // タイムラインへ連結したい呼び出し側のために、差し替えず配列を返す版を分離した。
    // extra(省略可): extraSnapsへ追加でマージする先読み配列({sn: [...]}等。VGMのSN76489ロール用)。
    buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
      // 実体はモジュールレベルの純粋関数(buildRollTracksFromRegSnapshotsPure)。
      // thisに依存しないため、キャプチャWorker(ロール構築のオフスレッド化、
      // src/audio/roll-builders.js)からも UI.buildRollTracksFromRegSnapshots 経由で
      // 同じコードを使えるよう分離した。
      return buildRollTracksFromRegSnapshotsPure(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra);
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
    // *2MML変換の音程検証(src/convert/verify.js)で見つかった不一致箇所。ロールに赤枠で
    // 重ね描きする({sec,endSec,expectedMidi,gotMidi,letter}の配列)。次のファイル/変換で更新。
    setConversionDiffs(diffs) {
      this._conversionDiffs = (diffs && diffs.length) ? diffs : null;
    }

    reset() {
      this._spcVoices = [];
      this._conversionDiffs = null;
      this._prevSpcVoices = [];
      this._muteState.clear();
      // スポットライト(案D)の固定も新ファイルへは持ち越さない(ミュート状態と同じ扱い。
      // 前の曲にしか無いch.idが固定されたまま残ると、注目が効かない見た目になるため)
      this._spotlightPinnedId = null;
      this._spotlightHoverId = null;
      // 大波形の選択(_selectedId)はここでは変えない。新ファイルの実際のチャンネル構成が
      // 判明した時点(次のsetSource()/updateSpcVoices()の実データ呼び出し)で、同じchが
      // 新ファイルにもあれば維持、無ければ一番若いchへ切り替える判定を1回だけ行う
      // (_pendingSelectionResetフラグ、_consumePendingSelectionReset参照)。曲送り/停止→再生
      // (同一ファイル内での切替)ではこのフラグは立てないため選択はそのまま保たれる。
      // ここより前に消費されていない古いフラグが残っていたら(短時間に連続でファイルを
      // 読み込み直した場合)、直後のダミーsetSource()呼び出しがその場で誤って消費してしまう
      // 前に破棄しておく。
      this._pendingSelectionReset = false;
      this.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100, writeLog: [] }, []);
      this._pendingSelectionReset = true;
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
      this._refreshAssignUi(); // 借用先の重複判定は「表示中の一覧」が対象なので切替のたびに計算し直す
      this._renderMuteAllBtn(); // 一括ミュートの状態も表示中の一覧が対象

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

    // ── チャンネル割当(案E: 鍵盤表示の行で借用先を決める) ────────────────
    // part列の文字とセレクトのラベル(「P: N163 ch1」)は channelPlan.js 側が持つ固定レター表
    // (assignExpansionLettersは他チップの有無に関わらず同じ文字を返す)から引くので、
    // ここで曲ごとのletterMapを作る必要はない。

    // 1行ぶんのpart列チップと「借用先/音色」セレクトを配線する。セレクトは割当表示ON
    // (_assignMode)のときだけ見えるが、DOMは常に作っておく(トグルのたびに行を組み直すと
    // 再生中の描画が途切れるため)。
    _wireAssign(row, ch) {
      const plan = channelPlan();
      if (!plan) return;
      const chId = ch.id;
      const editable = plan.editable();
      const partEl = row.querySelector('.kbd-part');
      const targetSel = row.querySelector('.kbd-assign-target');
      const toneSel = row.querySelector('.kbd-assign-tone');
      if (partEl) {
        if (editable) {
          partEl.title = T('クリックで借用先(NSF側のパート)を選ぶ');
          partEl.addEventListener('click', (e) => { e.stopPropagation(); this._openAssignPopover(partEl, chId); });
        } else {
          partEl.title = plan.lockReason() || '';
        }
      }
      if (!targetSel || !toneSel) return;
      targetSel.disabled = toneSel.disabled = !editable;
      if (!editable) targetSel.title = plan.lockReason() || '';
      targetSel.addEventListener('change', () => this._setAssignTarget(chId, targetSel.value));
      toneSel.addEventListener('change', () => {
        const cur = plan.get(chId) || {};
        const kind = plan.toneKindFor(cur.target || this._defaultTargetOf(chId));
        const def = kind ? plan.toneOptionsFor(kind, plan.channelKind(chId)).def : null;
        plan.set(chId, { tone: toneSel.value === def ? null : toneSel.value });
      });
      // クリックが行の他の操作(大波形選択・色ピッカー)に伝播しないようにする
      for (const el of [targetSel, toneSel]) el.addEventListener('click', (e) => e.stopPropagation());
    }

    // この曲に実在する借用先(表示中の各行の既定の借用先)。NSFのように「同じ音源の
    // 別チャンネルへ移す」しかできない形式で、存在しない枠を候補に出さないために使う。
    _availTargets() {
      const rows = this._mode === 'spc' ? this._spcRowEls : this._rowEls;
      return rows.map(el => el.defaultTarget).filter(Boolean);
    }

    _defaultTargetOf(chId) {
      const plan = channelPlan();
      if (!plan) return 'skip';
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      return (el && el.defaultTarget) || plan.defaultTarget(chId, 'skip');
    }

    // 借用先を選び直す。既定と同じ値を選んだらユーザー指定を消して「自動」に戻す
    // 借用先を1つの枠へ移すと、そこに先に居たchは行き場を失う(変換器は先に置かれた方を
    // 採り、後は「対象外」にする)。UI上は赤い重複表示が出るだけで、ユーザーは自分で
    // 前のchをスキップにし直す必要があった。★2A03ノイズのように枠が1つしか無い借用先では
    // これが「どちらを鳴らすか選ぶ」操作そのものなので、選んだ時点で前のchを自動でスキップへ
    // 落とし、ラジオボタンのように振る舞わせる(SN76489デュアルのノイズ2本、SNノイズと
    // サンプルPCMのドラムパートの取り合いが実例)。
    _setAssignTarget(chId, value) {
      const plan = channelPlan();
      if (!plan) return;
      const def = this._defaultTargetOf(chId);
      // ★DPCMだけは例外。複数のPCMチャンネルをまとめて1本のDPCMパートへ焼く設計
      //   (同時発音区間はミックスして1サンプルにする。src/vgm2mml/expansion/dpcmDrums.js)
      //   なので、ここで他chを追い出すとドラムを複数ch選べなくなる。
      if (value && value !== 'skip' && !MULTI_SOURCE_TARGETS.has(value)) {
        for (const el of this._rowEls) {
          if (el.id === chId) continue;
          const cur = (plan.get(el.id) || {}).target || el.defaultTarget || 'skip';
          if (cur !== value) continue;
          const otherDef = this._defaultTargetOf(el.id);
          plan.set(el.id, { target: otherDef === 'skip' ? null : 'skip' });
        }
      }
      plan.set(chId, { target: value === def ? null : value, tone: null });
    }

    // セレクトの中身を現在の割当に合わせて作り直す(借用先を変えると音色の選択肢も変わる)
    _syncAssignSelects(el) {
      const plan = channelPlan();
      if (!plan || !el.targetSel) return;
      const srcKind = plan.channelKind(el.id);
      const ent = plan.get(el.id) || {};
      const target = ent.target || el.defaultTarget || 'skip';
      const opts = plan.targetsForChannel(el.id, el.defaultTarget, this._availTargets());
      // 既定の借用先が候補に無い(種別判定と既定がずれている)場合も選べるように足す
      const list = opts.indexOf(target) >= 0 ? opts : opts.concat([target]);
      const sig = list.join(',') + '|' + target;
      if (el.targetSig !== sig) {
        el.targetSig = sig;
        el.targetSel.innerHTML = '';
        for (const t of list) {
          const o = document.createElement('option');
          o.value = t;
          // 行内のセレクトは幅が狭いので「(既定)」は付けない(既定から変えた行はpart列の
          // チップがアクセント色になるので区別はつく)。ポップオーバー側には付ける。
          o.textContent = plan.targetLabel(t);
          el.targetSel.appendChild(o);
        }
      }
      el.targetSel.value = target;

      const toneKind = plan.toneKindFor(target);
      if (!toneKind) { el.toneSel.style.display = 'none'; el.toneSig = ''; return; }
      el.toneSel.style.display = '';
      const to = plan.toneOptionsFor(toneKind, srcKind);
      const tsig = toneKind + '|' + srcKind;
      if (el.toneSig !== tsig) {
        el.toneSig = tsig;
        el.toneSel.innerHTML = '';
        for (const pair of to.opts) {
          const o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          el.toneSel.appendChild(o);
        }
      }
      el.toneSel.value = ent.tone !== undefined ? ent.tone : to.def;
    }

    // 割当が変わったとき(plan.onChange)に呼ぶ。part列の文字・スキップの減光・
    // 借用先の重複(赤)を表示中の全行へ反映する。
    _refreshAssignUi() {
      const plan = channelPlan();
      if (!plan) return;
      // ★対象は「今表示中の一覧」だけ。両方(_rowEls+_spcRowEls)を混ぜると、SPC表示中に
      //   隠れているNSF側の行(A/B/C/D…)まで数えてしまい、全行が重複警告になる
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls)
        .filter(el => !el.isAllRow && el.partEl);
      const count = {};
      for (const el of rows) {
        const ent = plan.get(el.id) || {};
        el.target = ent.target || el.defaultTarget || 'skip';
        if (el.target !== 'skip') count[el.target] = (count[el.target] || 0) + 1;
      }
      // スキップの減光と重複警告は「割当が意味を持つ形式」だけに出す。NSFのようにMMLパート文字を
      // 持たない行(MMC5の$5011直接PCM等)まで一律に減光すると、従来の見た目を壊してしまう
      const editable = plan.editable();
      for (const el of rows) {
        const custom = !!(plan.get(el.id) || {}).target;
        el.letter = el.target === 'skip' ? '' : plan.letterOfTarget(el.target);
        el.partEl.textContent = el.letter || (editable ? '—' : '');
        el.partEl.classList.toggle('kbd-part--custom', custom);
        el.row.classList.toggle('kbd-ch-row--skip', editable && el.target === 'skip');
        // DPCMは複数chをまとめて載せる先なので重複扱いにしない(上の MULTI_SOURCE_TARGETS 参照)
        const dup = editable && el.target !== 'skip' && !MULTI_SOURCE_TARGETS.has(el.target) && count[el.target] > 1;
        el.row.classList.toggle('kbd-ch-row--conflict', dup);
        if (el.partEl) {
          el.partEl.title = dup ? T('この借用先は他のチャンネルと重複しています')
            : plan.editable() ? T('クリックで借用先(NSF側のパート)を選ぶ') : (plan.lockReason() || '');
        }
        this._syncAssignSelects(el);
      }
      this._renderAssignToggle();
    }

    // part列チップのクリックで開く1行ぶんの割当ポップオーバー(縦置き・多段・別窓など
    // 幅が足りないレイアウトでも必ず使える経路。案Eの土台)
    _openAssignPopover(anchorEl, chId) {
      const plan = channelPlan();
      if (!plan || !plan.editable()) return;
      this._closeAssignPopover();
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      if (!el) return;
      const pop = document.createElement('div');
      pop.className = 'kbd-assign-pop';
      const srcKind = plan.channelKind(chId);
      const ent = plan.get(chId) || {};
      const target = ent.target || el.defaultTarget || 'skip';

      const rowOf = (labelText, control) => {
        const r = document.createElement('label');
        r.className = 'kbd-assign-pop-row';
        const s = document.createElement('span');
        s.textContent = labelText;
        r.appendChild(s); r.appendChild(control);
        return r;
      };
      const targetSel = document.createElement('select');
      const list = plan.targetsForChannel(chId, el.defaultTarget, this._availTargets());
      for (const t of (list.indexOf(target) >= 0 ? list : list.concat([target]))) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = plan.targetLabel(t) + (t === el.defaultTarget ? T('(既定)') : '');
        targetSel.appendChild(o);
      }
      targetSel.value = target;
      targetSel.addEventListener('change', () => { this._setAssignTarget(chId, targetSel.value); this._openAssignPopover(anchorEl, chId); });
      pop.appendChild(rowOf(T('借用先'), targetSel));

      const toneKind = plan.toneKindFor(target);
      if (toneKind) {
        const to = plan.toneOptionsFor(toneKind, srcKind);
        const toneSel = document.createElement('select');
        for (const pair of to.opts) {
          const o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          toneSel.appendChild(o);
        }
        toneSel.value = ent.tone !== undefined ? ent.tone : to.def;
        toneSel.addEventListener('change', () => plan.set(chId, { tone: toneSel.value === to.def ? null : toneSel.value }));
        pop.appendChild(rowOf(T('音色'), toneSel));
      }
      if (plan.hasVolSliderFor(target)) {
        const volWrap = document.createElement('span');
        volWrap.className = 'kbd-assign-pop-vol';
        const vol = document.createElement('input');
        vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5';
        vol.value = String(ent.volPct !== undefined ? ent.volPct : 100);
        const volNum = document.createElement('span');
        volNum.textContent = vol.value + '%';
        vol.addEventListener('input', () => { volNum.textContent = vol.value + '%'; });
        vol.addEventListener('change', () => plan.set(chId, { volPct: vol.value === '100' ? null : parseInt(vol.value, 10) }));
        volWrap.appendChild(vol); volWrap.appendChild(volNum);
        pop.appendChild(rowOf(T('変換音量'), volWrap));
      }
      const foot = document.createElement('div');
      foot.className = 'kbd-assign-pop-foot';
      const auto = document.createElement('button');
      auto.type = 'button';
      auto.textContent = T('自動に戻す');
      auto.addEventListener('click', () => { plan.clearChannel(chId); this._closeAssignPopover(); });
      foot.appendChild(auto);
      pop.appendChild(foot);

      document.body.appendChild(pop);
      const r = anchorEl.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(window.innerWidth - pop.offsetWidth - 4, r.left)) + 'px';
      pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 4, r.bottom + 2) + 'px';
      this._assignPop = pop;
      this._assignPopClose = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) this._closeAssignPopover(); };
      setTimeout(() => document.addEventListener('mousedown', this._assignPopClose), 0);
    }

    _closeAssignPopover() {
      if (this._assignPopClose) document.removeEventListener('mousedown', this._assignPopClose);
      this._assignPopClose = null;
      if (this._assignPop) { this._assignPop.remove(); this._assignPop = null; }
    }

    // 一覧の「割当」トグル(幅が足りるときだけ列展開する。案Eの2段目)
    _setAssignMode(on) {
      this._assignMode = !!on;
      try { localStorage.setItem('mml_kbdAssignMode', on ? '1' : '0'); } catch (e) { /* private browsing等 */ }
      this._leftEl.classList.toggle('kbd-left--assign', this._assignMode);
      this._applyLayoutClasses();
      this._refreshAssignUi();
      // 「借用先/音色」列(200px)が入りきらない幅のままだと右側の列(L/R・vol・wave)が
      // 押し出されて見えなくなるので、収まる幅まで自動拡張する(setMode()のSPC下限と同じ考え方。
      // 縮小はしない=ユーザーが既に広げていればそのまま尊重する)
      if (this._assignMode) {
        const winEl = this.container.closest('.float-window');
        const placement = this._effectivePlacement();
        if (winEl && placement !== 'window') {
          // 一覧の幅(CSSの.kbd-left--assignで広がった値)+ロールの最低限が収まる窓幅を確保する
          const need = this._leftEl.offsetWidth + (placement === 'right' ? 260 : 24);
          if (winEl.offsetWidth < need) winEl.style.width = need + 'px';
        }
      }
    }

    _renderAssignToggle() {
      const plan = channelPlan();
      if (!this._assignBtns) return;
      const editable = !!plan && plan.editable();
      for (const btn of this._assignBtns) {
        btn.classList.toggle('kbd-assign-btn--on', !!this._assignMode);
        btn.classList.toggle('kbd-assign-btn--custom', !!plan && plan.isCustom());
        btn.disabled = !editable;
        btn.title = editable ? T('チャンネル割当(変換元ch → NSF側のパート)を表示')
          : (plan ? plan.lockReason() : '');
      }
    }

    // ── 一括ミュート(見出しのミュート列のボタン) ──────────────────────
    // 表示中の一覧(SPCモードならボイス一覧)の実チャンネルだけを対象にする。
    // 全chミュートでなければ全ミュート、全ミュート済みなら全解除。
    _muteRows() {
      return (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.checkbox);
    }
    _allMuted() {
      const rows = this._muteRows();
      return rows.length > 0 && rows.every(el => !el.checkbox.checked);
    }
    _toggleAllMute() {
      const rows = this._muteRows();
      if (!rows.length) return;
      const muted = !this._allMuted(); // 全ミュートでなければ全ミュート、そうなら全解除
      if (this._mode === 'spc') {
        // SPCはボイス番号でミュート機構が別(main.js onSpcMuteChange → ビットマスク)
        rows.forEach((el, idx) => {
          el.checkbox.checked = !muted;
          if (this.onSpcMuteChange) this.onSpcMuteChange(idx, muted);
        });
      } else {
        for (const el of rows) {
          el.checkbox.checked = !muted;
          this._muteState.set(el.id, muted);
        }
        // 行ごとに呼ぶとその都度再生側へ設定が飛ぶので、まとめて1回だけ通知する
        if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
      }
      this._renderMuteAllBtn();
    }
    // 見出しの vol 列のボタン: 全chの音量スライダーを100%へ戻す(行ごとのダブルクリックの
    // 全ch版)。ミュートと違いトグルではなく常にリセット。
    _resetAllVolumes() {
      const spc = this._mode === 'spc';
      const rows = (spc ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow);
      if (!rows.length) return;
      for (const el of rows) {
        const slider = el.row.querySelector('.kbd-vol-slider');
        if (slider) slider.value = '100';
      }
      if (spc) {
        for (let i = 0; i < this._spcVoiceVolumes.length; i++) this._spcVoiceVolumes[i] = 1;
        saveSpcVoiceVolumes(this._spcVoiceVolumes);
        if (this.onSpcVolumeChange) this.onSpcVolumeChange(this._spcVoiceVolumes.slice());
      } else {
        for (const el of rows) this._channelVolumes.set(el.id, 1);
        saveChannelVolumes(this._channelVolumes);
        if (this.onVolumeChange) this.onVolumeChange();
      }
    }

    // ボタンの見た目: 全ミュート中は押し込み表示にして「もう一度押すと解除」だと分かるようにする
    _renderMuteAllBtn() {
      if (!this._muteAllBtns) return;
      const all = this._allMuted();
      for (const btn of this._muteAllBtns) {
        btn.classList.toggle('kbd-muteall-btn--on', all);
        btn.title = all ? T('全チャンネルのミュートを解除') : T('全チャンネルをミュート');
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
            // チャンネルプール/ペア交互割当のチップ: 表示モード切替(実機スロット=素材のまま /
            // 合成ch=割当逆算)。行構成は同じでデータ系列だけが替わる。見た目は2状態の
            // トグルスイッチ(クリックで切替、点灯側が現在モード)。
            if (disp.pool) {
              const sw = document.createElement('span');
              sw.className = 'kbd-pool-toggle';
              sw.dataset.pool = disp.pool;
              sw.style.cssText = 'display:inline-flex;margin-left:8px;font-size:9px;border:1px solid #444;border-radius:8px;overflow:hidden;cursor:pointer;user-select:none;vertical-align:middle;';
              sw.title = T('チャンネルプール式音源の表示モード: 実機スロット=ドライバの巡回割当そのまま / 合成ch=音色と音程の連続性でメロディを同じ行へ束ね直す');
              const mk = (label) => { const s = document.createElement('span'); s.textContent = label; s.style.cssText = 'padding:1px 6px;'; return s; };
              const segL = mk(T('合成ch')), segP = mk(T('実機スロット'));
              sw.appendChild(segL); sw.appendChild(segP);
              const paint = () => {
                const logical = (this._poolModes[disp.pool] || 'logical') === 'logical';
                segL.style.background = logical ? '#3a6ea5' : '#22242e';
                segL.style.color = logical ? '#fff' : '#667';
                segP.style.background = logical ? '#22242e' : '#3a6ea5';
                segP.style.color = logical ? '#667' : '#fff';
              };
              sw._paint = paint; // setPoolModes()からの再描画用
              paint();
              sw.addEventListener('click', () => {
                const mode = (this._poolModes[disp.pool] || 'logical') === 'logical' ? 'phys' : 'logical';
                this._poolModes[disp.pool] = mode;
                paint();
                if (this.onPoolModeChange) this.onPoolModeChange(disp.pool, mode);
              });
              headerRow.appendChild(sw);
            }
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
          partChipHtml(ch) +
          (ch.isAllRow
            ? `<span class="kbd-mute-ph"></span>`
            : `<input type="checkbox" class="kbd-mute"${muted ? '' : ' checked'} title="${T('{ch} ミュート', { ch: ch.id })}">`) +
          `<span class="kbd-name">${disp.name}</span>` +
          assignCellHtml(ch) +
          `<span class="kbds-lr kbds-l"></span>` +
          `<span class="kbds-lr"></span>` +
          `<span class="kbd-vol-num">0</span>` +
          `<span class="kbd-vol-wrap">` +
            `<span class="kbd-vol-bar" style="background:transparent"></span>` +
            (ch.isAllRow ? '' :
              `<input type="range" class="kbd-vol-slider" min="0" max="200" step="1" value="${Math.round((this._channelVolumes.get(ch.id) ?? 1) * 100)}" title="${T('{ch} 音量(中央100%・ダブルクリックで100%)', { ch: ch.id })}">` +
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
            this._renderMuteAllBtn(); // 見出しの一括ミュートボタンの状態を追随させる
            // ミュートはロールの見え方(減光)にも効くので、停止中でもその場で描き直す
            this._redrawRollForSpotlight();
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

        // YM2610 ADPCM行(NA1-6/NB): note列クリックで手動ピッチキャリブレーション(onAdpcmCalibrate、
        // main.jsがプロンプトを出してチップの setSampleTuning を呼ぶ)。対象は「今その行で鳴っている
        // サンプル」(ch.adpcmSample)なので、直近の update() の channels(_lastChannels)から引く
        // (_prevChannelsは行再構築時にしか更新されず古い)
        // note列クリック: サンプルPCM系の行(adpcmSampleを持つ行)なら「打楽器/音階の手動指定 +
        // 基準音の手動補正」の小メニューを出す。★どちらもサンプル単位の指定なので、
        // 「今その行で鳴っているサンプル」(_lastChannels)を対象にする
        if (SAMPLE_ROW_RE.test(ch.id)) {
          const noteElForClick = row.querySelector('.kbd-note');
          noteElForClick.classList.add('kbd-note--clickable');
          noteElForClick.title = T('クリックで打楽器/音階の指定と基準音の手動補正');
          noteElForClick.addEventListener('click', () => {
            const cur = (this._lastChannels || this._prevChannels || []).find(c => c.id === chId);
            if (cur && cur.adpcmSample) this._openSampleMenu(noteElForClick, cur);
          });
        }

        const lrEls = row.querySelectorAll('.kbds-lr');

        // チャンネル割当(part列のチップ + 割当表示ONのときのセレクト。案E)
        if (!ch.isAllRow) this._wireAssign(row, ch);
        // スポットライト(案D): 行ホバー=一時的に注目、ch名クリック=固定
        if (!ch.isAllRow) this._attachSpotlight(row, ch.id);

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
          // チャンネル割当(案E): part列チップとセレクトの参照+この行の既定の借用先
          partEl: row.querySelector('.kbd-part'),
          targetSel: row.querySelector('.kbd-assign-target'),
          toneSel: row.querySelector('.kbd-assign-tone'),
          defaultTarget: ch.defaultTarget,
          target: ch.target,
        });
      }
      // 大波形に表示するchを新しい一覧に合わせる(SPCモード中はSPC側の一覧が表示中なので触らない)
      if (this._mode !== 'spc') {
        this._consumePendingSelectionReset(this._rowEls.filter(el => el.waveCanvas).map(el => el.id));
        this._syncShownWave(this._rowEls);
        this._rebuildLanes(); // チャンネルごとのレーン表示も一覧に合わせる
      }
      this._refreshAssignUi(); // part列の文字・スキップ減光・重複警告を新しい行へ反映
      this._renderMuteAllBtn();
      this._applySpotlightClasses(); // 固定中のスポットライトの目印を新しい行へ復元
    }

    // ch別音量スライダー(音量バー領域に重ねる半透明オーバーレイ)を1行ぶん配線する。
    // 通常は薄く見えるだけで、ドラッグ中(またはホバー/フォーカス中)だけ数値ツールチップを
    // 出す。値は0〜200%(中央=100%)のrange inputで、_channelVolumes(localStorage永続化)を
    // 直接操作する。ダブルクリックで100%へ戻る。
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
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
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
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
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

      // FM音色データ(OPLL/VRC7/YM2612/YM2610)。波形の見た目(sig)が同じでもパラメータは
      // 変わりうるので、sig判定より前に毎回テキストを比較して更新する
      if (this._bigPatchEl) {
        const ptype = ch.fmPatch ? ch.fmPatch.type : null;
        this._bigPatchCh = ptype ? ch : null;
        // 書式selectのoptionを音源種別に合わせる(種別が変わった時だけ作り直す)
        if (ptype !== this._bigPatchFmtType) {
          this._bigPatchFmtType = ptype;
          this._bigPatchFmtSel.innerHTML = '';
          for (const f of (FM_PATCH_FORMATS[ptype] || [])) {
            const o = document.createElement('option'); o.value = f.id; o.textContent = T(f.label);
            this._bigPatchFmtSel.appendChild(o);
          }
          if (ptype) this._bigPatchFmtSel.value = getFmPatchFormat(ptype);
          this._bigPatchFmtSel.style.display = ptype ? '' : 'none';
        }
        const text = formatFmPatch(ch);
        if (text !== this._bigPatchText) {
          this._bigPatchText = text;
          this._bigPatchEl.innerHTML = text ? renderFmPatchHtml(text) : '';
          this._bigPatchEl.style.display = text ? '' : 'none';
          this._bigPatchCopyBtn.style.display = text ? '' : 'none';
        }
      }

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
    /** 1つでもミュートされている行があるか(無音自動送りの判定を止めるため。main.js参照) */
    hasAnyMute() {
      for (const el of this._rowEls) if (el.checkbox && !el.checkbox.checked) return true;
      for (const el of (this._spcRowEls || [])) if (el.checkbox && !el.checkbox.checked) return true;
      return false;
    }

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
      // 直近の抽出結果(_prevChannelsは行の再構築時にしか更新されない=行構成の基準用。
      // 「今この行で鳴っているもの」を要する処理(ADPCM手動キャリブレーションのクリック等)はこちらを見る)
      this._lastChannels = channels;

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
        // ★対象は 2A03 DM 行(ch.dmcDirect)だけ。以前は sample:true の全行(RF5C164/PWM/ADPCM等)で
        //   1つの _lastDmc4011 を共有していたため、サンプル行が複数あると隣の行の値と比較して
        //   常に「書き換わった」と判定され、PCM行の音量数値が意味なく黄色になり active も強制されていた
        let dmcWritten = false;
        if (ch.dmcDirect && ch.dmcReg !== undefined) {
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
        } else if (ch.adpcmPitch) {
          // YM2610 ADPCM-A/B: adpcmExact(サンプル解析ピッチ×再生レート)なら通常の音名+実周波数、
          // それ以外(ADPCM-Bの解析不能時)は目安の音名に'?'を付け、freq列にはDelta-N由来の
          // 再生レート(Hz、=元のPCMサンプリングレート)を出す
          const midi = adpcmPitchToMidi(ch);
          if (ch.adpcmExact) {
            el.noteEl.textContent = midi !== null ? midiToName(midi) : '??';
            el.noteEl.style.color = ch.adpcmManual ? '#ffcc44' : '#e6e6ef'; // 手動補正済みは黄色
            el.freqEl.textContent = ch.freq > 0 ? ch.freq.toFixed(1) + ' Hz' : '';
          } else {
            el.noteEl.textContent = midi !== null ? midiToName(midi) + '?' : '??';
            el.noteEl.style.color = midi !== null ? '#e6e6ef' : '#555566';
            el.freqEl.textContent = ch.freq > 0 ? Math.round(ch.freq).toLocaleString() + ' Hz' : '';
          }
        } else if (ch.drumKey && this._drumLaneOf && this._drumLaneOf.has(ch.drumKey)) {
          // 打楽器として鳴っているサンプルPCM: note列は「今このスロットが鳴らしている太鼓」
          // (ドラム区画のレーンのラベルと色)。プール式チップは同じ太鼓が毎回別スロットへ
          // 移るので、行を見ただけでどの音か分かるこの表示が効く。
          // (従来はdmcRateIdxを出していたが、この経路では常に固定値15で情報が無かった)
          const laneIdx = this._drumLaneOf.get(ch.drumKey);
          const laneInfo = this._drumLanes[laneIdx];
          el.noteEl.textContent = (laneInfo && laneInfo.label) || '?';
          el.noteEl.style.color = (laneInfo && laneInfo.color) || '#e6e6ef';
          el.freqEl.textContent = ch.dmcFreq > 0 ? Math.round(ch.dmcFreq).toLocaleString() + ' Hz' : '';
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

    /** チャンネルプール式チップの表示モード初期値(main.jsがlocalStorageから復元して渡す)。 */
    setPoolModes(modes) {
      Object.assign(this._poolModes, modes || {});
      for (const sw of this._rowsInnerEl.querySelectorAll('.kbd-pool-toggle')) {
        if (sw._paint) sw._paint(); // data-poolごとに自分のモードを塗り直す
      }
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
      for (const t of targets) {
        // ヒットテスト(_trackAtRollPoint)が同じ座標系を使えるよう、そのcanvasの表示条件を控える
        t.canvas._rollOnlyId = t.onlyId;
        t.canvas._rollLane = t.lane || null;
        this._drawRollCanvas(t.canvas, pos, t.onlyId, t.lane || null);
      }
    }

    // チャンネルごとのレーンの音程窓(白鍵LANE_VISIBLE_WHITE本ぶん)を、そのchの「鳴っている音+
    // 先読み範囲[pos, pos+windowSec)内の音符」が収まるようにスクロールさせる。
    // 動かし方はデッドゾーン方式: 必要な音域が今の窓(余白LANE_SCROLL_MARGIN白鍵を除く)に
    // 収まっていれば動かさない。はみ出す側があればその側だけ必要最小限ずらし、音域が窓より
    // 広くて収まらないときは「今鳴っている音(無ければ一番近い未来の音)」を窓の中央に置く。
    // 目標へは毎フレーム残差の一部ずつ寄せる(LANE_SCROLL_EASE)ので滑らかに追従する。
    // 音符が1つも無い間は動かさない。lane.scrollWhite = 窓の低音側端の白鍵位置(小数)
    _updateLaneScroll(lane, pos, windowSec) {
      // 音程軸の単位は白鍵1本。ドラム区画があるぶん全体の長さが伸び、音程側の座標も右へずれる
      const drumUnits = (this._drumLanes || []).length * DRUM_LANE_WHITE;
      const maxOff = TOTAL_WHITE + drumUnits - LANE_VISIBLE_WHITE;
      const track = this._rollTimeline && this._rollTimeline.find(t => t.id === lane.id);
      if (lane.scrollWhite == null) lane.scrollWhite = Math.max(0, Math.min(maxOff, drumUnits + keyX(60, 1).x - LANE_VISIBLE_WHITE / 2)); // 初期値: C4中心
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
        let p0, p1;
        if (n.drumLane !== undefined) {
          // ドラムの打点はレーン番号が音程軸上の位置(1レーン=DRUM_LANE_WHITE白鍵ぶん)
          const d = drumLaneX(n.drumLane, n.drumSub, n.drumSubN, DRUM_LANE_WHITE);
          p0 = d.x; p1 = d.x + d.size;
        } else {
          const kp = keyX(n.midi, 1);
          if (!kp) continue;
          p0 = (kp.isBlack ? kp.x - 0.3 : kp.x) + drumUnits;
          p1 = (kp.isBlack ? kp.x + 0.3 : kp.x + 1) + drumUnits;
        }
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
      const nDrum = (this._drumLanes || []).length;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? LANE_VISIBLE_WHITE : 0, nDrum);
      const { wk: wkW, bk: bkW, H } = g;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, H);
      const windowSec = g.windowSec;
      const winEnd = pos + windowSec;
      if (lane) this._updateLaneScroll(lane, pos, windowSec);
      const offPx = lane ? lane.scrollWhite * wkW : 0; // 音程窓の低音側端(px)。keyX()の結果から引く
      const pitchOff = g.drumOff - offPx; // 音程側の座標補正(ドラム区画ぶん右へ + 窓スクロール)

      // ドラム区画のレーングリッド(淡い下地+レーン境界)。音程鍵盤より低音側に置く。
      for (let i = 0; i < nDrum; i++) {
        const d = drumLaneX(i, 0, 1, g.drumLaneW);
        const x0 = d.x - offPx;
        if (x0 + d.size < 0 || x0 > g.pitchLen) continue;
        ctx.fillStyle = '#000000';
        ctx.globalAlpha = i % 2 ? 0.06 : 0.12; // 交互の縞でレーンの境目を分かりやすく(黒鍵の網掛けと同系)
        let r = g.rect(x0, d.size, 0, g.timeLen);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#3d3d4a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.vertical) { const x = Math.round(x0) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        else { const y = Math.round(H - x0) + 0.5; ctx.moveTo(0, y); ctx.lineTo(g.W, y); }
        ctx.stroke();
      }
      // ドラム区画と音程鍵盤の境目(区画があるときだけ)
      if (nDrum) {
        ctx.strokeStyle = '#7a86a8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.vertical) { const x = Math.round(g.drumOff - offPx) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        else { const y = Math.round(H - (g.drumOff - offPx)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(g.W, y); }
        ctx.stroke();
      }

      // 鍵盤ごとの音程グリッド(白鍵の境界線+黒鍵レーンの淡い網掛け)とCの音名ラベル。
      // グリッドは音程軸に直交する全時間帯の帯/線なので、時間軸[0, timeLen)いっぱいに引く。
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        const semi = rel % 12;
        const keyPos = keyX(midi, wkW);
        if (!keyPos) continue;
        keyPos.x += pitchOff;
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
          // ★音名ラベルはロールではなく鍵盤(drawPiano)に書く。以前は縦向きだけロールの
          //   上端に書いていたが、横向きは鍵に書いており置き場が食い違っていた(ユーザー指摘)。
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
      // スポットライト(案D): 注目chがあるときは他chを減光し、注目chは最後=最前面に描く
      // (ノートは不透明塗りなので、描画順が後のchが必ず勝つ。並べ替えないと注目chが
      // 他chに上書きされて「注目しているのに見えない」ことがある)。
      const spotId = this._effectiveSpotlightId();
      const spotActive = !!spotId && this._rollTimeline.some(t => t.id === spotId);
      const drawOrder = spotActive
        ? this._rollTimeline.filter(t => t.id !== spotId).concat(this._rollTimeline.filter(t => t.id === spotId))
        : this._rollTimeline;

      for (const track of drawOrder) {
        if (onlyId !== null && track.id !== onlyId) continue; // レーン表示: このchのノートだけ
        // ミュート中のchは「消す」のではなくスポットライトと同じ減光で描く。
        // 消してしまうと、そのchが元々何も鳴っていないのか消しているのか区別できない
        const muted = this._isTrackMuted(track.id);
        const dimAlpha = (muted || (spotActive && track.id !== spotId)) ? SPOTLIGHT_DIM_ALPHA : 1;
        const notes = track.notes;
        let idx = this._rollCursor[track.id] || 0;
        if (idx > notes.length) idx = notes.length;
        while (idx < notes.length && notes[idx].endSec <= pos) idx++;
        this._rollCursor[track.id] = idx;
        for (let i = idx; i < notes.length; i++) {
          const note = notes[i];
          if (note.startSec >= winEnd) break; // 以降は全て未来のノート(startSec昇順のため打ち切れる)
          // 音量による濃淡はやめ、常にチャンネル本来の色をそのまま(不透明・フィルタ無し)で描く。
          const noteColor = this._getColor(track.id, track.color);
          const isDrum = note.drumLane !== undefined;
          let pLo, pSize;
          if (isDrum) {
            // ドラム区画の打点。レーン=どのサンプルか、レーン内の分割=同時発音の横並び
            if (note.drumLane >= nDrum) continue; // レーン表より後に来たタイムライン(再構築待ち)
            const d = drumLaneX(note.drumLane, note.drumSub, note.drumSubN, g.drumLaneW);
            const x0 = d.x - offPx;
            if (x0 + d.size < 0 || x0 > g.pitchLen) continue;
            pLo = x0 + 1;
            pSize = Math.max(2, d.size - 2);
          } else {
            const keyPos = keyX(note.midi, wkW);
            if (!keyPos) continue;
            keyPos.x += pitchOff;
            if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
            // 音程軸: 白鍵は境界線1px内側、黒鍵はレーン幅いっぱい
            pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
            pSize = keyPos.isBlack ? bkW : (wkW - 1);
          }
          const relEnd = Math.min(windowSec, note.endSec - pos);
          const relStart = Math.max(0, note.startSec - pos);
          // 時間軸: 最低2pxは見えるようにする
          const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
          ctx.globalAlpha = dimAlpha;
          if (isDrum) {
            // 塗り=サンプル(どの太鼓か) / 枠線=チャンネル(どのスロットが鳴らしたか)の二重符号化。
            // プール式チップでは同じ太鼓が毎回別スロットへ移るので、色をchに割り当てると
            // 太鼓の色が踊る。塗りをサンプル側に固定するとその問題が出ない。
            const laneInfo = this._drumLanes[note.drumLane];
            ctx.fillStyle = (laneInfo && laneInfo.color) || DRUM_OTHER_COLOR;
            ctx.fillRect(r.x, r.y, r.w, r.h);
            if (r.w > 3 && r.h > 3) {
              ctx.strokeStyle = noteColor;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
            }
            ctx.globalAlpha = 1;
            continue; // ドラムの打点にセント偏差オーバーレイは無い(音程を持たないため)
          }
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
          ctx.globalAlpha = 1;
        }
      }

      // *2MML変換の音程検証で見つかった不一致箇所(setConversionDiffs)を赤枠で重ね描きする。
      // 塗り(gotMidi=実際に鳴る高さ)と枠(expectedMidi=元の高さ)の両方を示す。
      // 時間軸はソースの秒(ロールと同じ)なのでそのまま描ける。
      if (this._conversionDiffs && onlyId === null) {
        for (const d of this._conversionDiffs) {
          if (d.endSec <= pos || d.sec >= winEnd) continue;
          const relStart = Math.max(0, d.sec - pos);
          const relEnd = Math.min(windowSec, d.endSec - pos);
          for (const [midi, fill] of [[d.gotMidi, true], [d.expectedMidi, false]]) {
            const keyPos = keyX(midi, wkW);
            if (!keyPos) continue;
            keyPos.x += pitchOff;
            if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue;
            const pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
            const pSize = keyPos.isBlack ? bkW : (wkW - 1);
            const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
            if (fill) {
              ctx.fillStyle = 'rgba(255,40,40,0.35)';
              ctx.fillRect(r.x, r.y, r.w, r.h);
            }
            ctx.strokeStyle = '#ff2828';
            ctx.lineWidth = fill ? 2 : 1;
            if (!fill) ctx.setLineDash([3, 3]);
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
            ctx.setLineDash([]);
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
      const plan = channelPlan();
      // SPCのボイスは元々パート文字を持たない(getPartLetterが空を返す)。既定の借用先は
      // main.jsが setDefaults() で与える(V0→A、V1→B、V2→C、V3→D、V4-7→スキップ)。
      const defaultTarget = plan ? plan.defaultTarget(v.label, 'skip') : 'skip';
      const ent = plan ? (plan.get(v.label) || {}) : {};
      const target = ent.target || defaultTarget;
      const letter = plan ? plan.letterOfTarget(target) : '';
      row.className = 'kbd-ch-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:${rowColor}"></span>` +
        partChipHtml({ id: v.label, letter, target }) +
        `<input type="checkbox" class="kbd-mute" checked title="${T('{ch} ミュート', { ch: v.label })}">` +
        `<span class="kbd-name">${v.label}</span>` +
        assignCellHtml({ id: v.label }) +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbd-vol-num">0</span>` +
        `<span class="kbd-vol-wrap">` +
          `<span class="kbd-vol-bar" style="background:transparent"></span>` +
          `<input type="range" class="kbd-vol-slider" min="0" max="200" step="1" value="${Math.round((this._spcVoiceVolumes[idx] ?? 1) * 100)}" title="${T('{ch} 音量(中央100%・ダブルクリックで100%)', { ch: v.label })}">` +
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
        this._renderMuteAllBtn(); // 見出しの一括ミュートボタンの状態を追随させる
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
      // チャンネル割当(part列チップ + 割当表示ONのときのセレクト)
      this._wireAssign(row, { id: v.label, target: target });
      // スポットライト(案D): メイン一覧と同じ操作をSPCボイス行にも付ける
      this._attachSpotlight(row, v.label);

      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        id: v.label,
        row,
        partEl: row.querySelector('.kbd-part'),
        targetSel: row.querySelector('.kbd-assign-target'),
        toneSel: row.querySelector('.kbd-assign-tone'),
        defaultTarget,
        target,
        letter,
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
        `<span class="kbd-part"></span>` +
        `<span class="kbd-mute-ph"></span>` +
        `<span class="kbd-name">ALL</span>` +
        `<span class="kbd-assign"></span>` +
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
      const spcRowsChanged = this._spcRowEls.length !== this._spcVoices.length;
      if (spcRowsChanged) {
        for (const el of this._spcRowEls) el.row.remove();
        this._spcRowEls = this._spcVoices.map((v, idx) => {
          const el = this._buildSpcRow(v, idx);
          this._spcSectionEl.appendChild(el.row);
          return el;
        });
        this._refreshAssignUi(); // part列の文字・スキップ減光・重複警告を新しい行へ反映
        this._renderMuteAllBtn();
        this._applySpotlightClasses(); // 固定中のスポットライトの目印を新しい行へ復元
      }
      // 大波形に表示するボイスを新しい一覧に合わせる(選択がSPCボイス以外ならV0を一時表示)。
      // ★SPCのボイス数は常に8で固定のため、reset()でファイルを読み込み直しても行の再構築
      // (spcRowsChanged)自体は2回目以降起きない。ファイル読み込み直し直後の選択判定
      // (_consumePendingSelectionReset)は行の再構築有無に関わらずここで必ず試みる必要がある
      if (this._mode === 'spc' && this._spcVoices.length) {
        const hadPending = this._pendingSelectionReset;
        this._consumePendingSelectionReset(this._spcRowEls.filter(el => el.waveCanvas).map(el => el.id));
        if (spcRowsChanged || hadPending) {
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

  // regSnapshots形式からピアノロールのトラック配列を構築する(KeyboardDisplayの
  // 同名メソッドの実体。this非依存の純粋関数なので、キャプチャWorkerバンドル
  // (NSF/VGMのロール構築オフスレッド化)からも直接呼べるようモジュールレベルに置く。
  // 詳細コメントはKeyboardDisplay.setRollTimelineFromRegSnapshots参照)。
  function buildRollTracksFromRegSnapshotsPure(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
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

  UI.KeyboardDisplay = KeyboardDisplay;
  UI.buildRollTracksFromRegSnapshots = buildRollTracksFromRegSnapshotsPure; // roll-builders.js(Worker)用
  UI.midiToNoteName = midiToName; // main.js(ADPCM手動キャリブレーションのプロンプト表示)用
})(window);
