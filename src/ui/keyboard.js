/*
 * チャンネル別鍵盤表示ウィジェット (ミュート統合版)
 * MML.UI.KeyboardDisplay
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  const CPU_CLOCK = 1789773;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  const MIDI_MIN = 24;
  const MIDI_MAX = 108;
  const TOTAL_WHITE = 50;

  // ピアノロールが先読み表示する時間幅(秒)。この秒数分だけ「未来」を上から降らせる。
  const ROLL_WINDOW_SEC = 4;

  const WHITE_IDX = [0,-1,1,-1,2,3,-1,4,-1,5,-1,6];
  const IS_BLACK   = [0, 1,0, 1,0,0, 1,0, 1,0, 1,0];

  // APU パルスのデューティ比 (High 区間の割合): 12.5% / 25% / 50% / 75%
  const APU_DUTY = [0.125, 0.25, 0.5, 0.75];

  // ノイズ周期テーブル（$400E bits0-3 → LFSRシフト間のCPU待機サイクル数, NTSC）
  // ノイズ周波数 = CPU_CLOCK / NOISE_PERIOD[index]（idx0≈447kHz … idx15≈440Hz）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // DMC(DPCM)レートテーブル（$4010 bits0-3 → サンプル1bitあたりのCPUサイクル数, NTSC）
  // 再生周波数 = CPU_CLOCK / DMC_RATE[index]（idx0≈4182Hz … idx15≈33144Hz）
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  // ── チャンネル色のユーザーカスタマイズ ────────────────────────
  // 鍵盤左上のチャンネル一覧の丸(kbd-dot)クリックで選べる色一覧、
  // および localStorage への保存/読込。ロール・鍵盤・波形表示すべてがこの
  // 上書き色を参照するため、変更は即座に全表示へ反映される。
  const CHANNEL_COLOR_STORAGE_KEY = 'mml_channelColors';
  const COLOR_PICKER_PALETTE = [
    '#ff4466', '#ff8800', '#ffcc00', '#aaff33', '#33dd66', '#00cc99',
    '#00ccff', '#3388ff', '#7755ff', '#cc55ff', '#ff55aa', '#ffffff',
    '#ff8888', '#ffbb66', '#eedd55', '#88dd88', '#66cccc', '#88bbff',
    '#aaaacc', '#dd8899', '#886644', '#888888', '#444455', '#000000',
  ];

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
    if (KF_RHYTHM_INDEX[id] !== undefined) return { section: 'expansion', chip: 'opll', type: 'array', index: KF_RHYTHM_INDEX[id] };
    return null;
  }

  // ── MMLパート文字(A-Z,a,b)の算出 ──────────────────────────────
  // 実際のMML変換(nsf2mml/kss2mml)が振るチャンネル文字を鍵盤表示にも出す。
  // 2A03固定4ch=A-D、DPCM=E(未使用でも常にこのスロット)、拡張音源以降は
  // src/mml/compiler.jsのassignExpansionLettersで機種に関わらず完全固定。
  const APU_PART_LETTER = { P1: 'A', P2: 'B', TR: 'C', NO: 'D', DM: 'E' };

  // chips(内部chip名の配列)をassignExpansionLettersが受け取る拡張音源名に変換する。
  // KSSはPSG→FME-7・SCC→N163・FMPAC→VRC7のレジスタ互換チップを借用して再生するため
  // (src/kss2mml/converter.js参照)、レター体系もそれらをそのまま流用する。
  const KSS_CHIP_TO_EXPANSION = { kssPsg: 'fme7', kssScc: 'n163', kssOpll: 'vrc7' };
  function chipsToExpansions(chips) {
    const priority = MML.Mml && MML.Mml.EXPANSION_PRIORITY;
    const set = new Set();
    for (const c of chips) {
      const exp = KSS_CHIP_TO_EXPANSION[c] || c;
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
    if ((m = id.match(/^KS(\d+)$/))) return (lm.n163 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^KF(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if (KF_RHYTHM_INDEX[id] !== undefined) return (lm.vrc7 || [])[KF_RHYTHM_INDEX[id]] || '';
    return '';
  }

  // ── 周波数 / MIDI 変換 ────────────────────────────────────────

  function freqToMidi(f) {
    if (!f || f <= 0) return null;
    const m = Math.round(69 + 12 * Math.log2(f / 440));
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
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

    // KSS(MSX)再生中はNES内蔵チャンネル(2A03)を表示しない。PSG/SCC/FMPACのみ表示する。
    const isKss = chips.includes('kss');
    if (!isKss) {
    // APU Pulse 1
    {
      const r = snap[0x4000] || 0;
      const freq = pulseFreq(snap[0x4002] || 0, snap[0x4003] || 0);
      const e = apuEnv ? apuEnv.pulse1 : null;
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P1', color: '#ff4466', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 1) && pulseActive(r) && freq > 0 });
    }
    // APU Pulse 2
    {
      const r = snap[0x4004] || 0;
      const freq = pulseFreq(snap[0x4006] || 0, snap[0x4007] || 0);
      const e = apuEnv ? apuEnv.pulse2 : null;
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P2', color: '#ff8800', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 2) && pulseActive(r) && freq > 0 });
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
    } // !isKss

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
      for (let i = 0; i < numRows; i++) {
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

    if (chips.includes('kssPsg')) {
      // PSG(AY-3-8910): 2A03のFME-7表示と同じ考え方(50%矩形波固定、noise有効chはノイズ波形)。
      const live = extraSnaps && extraSnaps.kssPsgLive;
      const snaps = live ? live() : null;
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      for (let ch = 0; ch < 3; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        channels.push({ id: `KP${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
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
  function buildNoteTimelineFromChannelFrames(getChannelsAtFrame, totalFrames, frameDur) {
    const tracks = new Map(); // id → { id, color, notes:[], cur:{startFrame,midi,volQ}|null }
    for (let f = 0; f < totalFrames; f++) {
      const channels = getChannelsAtFrame(f) || [];
      for (const ch of channels) {
        if (ch.noise || ch.sample) continue;
        let track = tracks.get(ch.id);
        if (!track) { track = { id: ch.id, color: ch.color, notes: [], cur: null }; tracks.set(ch.id, track); }
        track.color = ch.color;
        const midi = (ch.active && ch.freq) ? freqToMidi(ch.freq) : null;
        const volQ = midi !== null ? quantizeVol(ch.vol) : 0;
        if (track.cur && (midi === null || midi !== track.cur.midi || volQ !== track.cur.volQ)) {
          track.notes.push({ startSec: track.cur.startFrame * frameDur, endSec: f * frameDur, midi: track.cur.midi, vol: track.cur.volQ / ROLL_VOL_LEVELS });
          track.cur = null;
        }
        if (midi !== null && !track.cur) track.cur = { startFrame: f, midi, volQ };
      }
    }
    const totalSec = totalFrames * frameDur;
    const result = [];
    for (const track of tracks.values()) {
      if (track.cur) track.notes.push({ startSec: track.cur.startFrame * frameDur, endSec: totalSec, midi: track.cur.midi, vol: track.cur.volQ / ROLL_VOL_LEVELS });
      result.push({ id: track.id, color: track.color, notes: track.notes });
    }
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
        const rawVol = regs[8 + ch] & 0xF;
        const vol = rawVol / 15;
        // 実機5B/AYは +1 しない。f = CPU/(32*period)。
        const freq = (toneOn && period > 0) ? CPU_CLOCK / (32 * period) : 0;
        return { freq, vol, rawVol, active: toneOn && vol > 0 && freq > 0 };
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
        if (wave.layers) return 'BRR (素 + ガウス補間' + (wave.layers.length > 2 ? ' + PM' : '') + ')';
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
      ctx.font = Math.round(20 * S) + 'px sans-serif';
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
      ctx.font = Math.round(13 * S) + 'px sans-serif';
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
      ctx.font = Math.round(17 * S) + 'px sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('0', x0 - tickGap, mid); // Y中心(ゼロ交差)のみ
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('1 周期 (相対波形)', x0 + w / 2, y1 + tickGap);
    } else {
      // ウェーブテーブル等: 軸目盛り。signed=trueのPCM系(BRR等)は符号付きレンジ
      // (-ny 〜 0 〜 ny-1。例: ny=32768 なら -32768〜0〜32767)、それ以外は
      // 従来通り0始まり(0 〜 ny-1)で表示する。
      ctx.fillStyle = '#b6b6c6';
      // canvasは var() 非対応。実フォント名を指定
      ctx.font = Math.round((signed ? 18 : 22) * S) + 'px monospace';
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

  // ── チャンネル色ピッカー(ポップオーバー) ──────────────────────
  // kbd-dot クリックで開く色一覧。1インスタンスのみ存在するシングルトンとして
  // document.body 直下に配置する(親要素のoverflow/z-indexに影響されないため)。
  let _colorPickerEl = null;
  let _colorPickerOutsideHandler = null;
  function closeColorPicker() {
    if (_colorPickerEl) { _colorPickerEl.remove(); _colorPickerEl = null; }
    if (_colorPickerOutsideHandler) {
      document.removeEventListener('mousedown', _colorPickerOutsideHandler, true);
      _colorPickerOutsideHandler = null;
    }
  }
  function openColorPicker(anchorEl, currentColor, onPick, onReset) {
    closeColorPicker();
    const pop = document.createElement('div');
    pop.className = 'kbd-color-picker';
    const cur = (currentColor || '').toLowerCase();
    pop.innerHTML = COLOR_PICKER_PALETTE.map(c =>
      `<span class="kbd-color-swatch${c.toLowerCase() === cur ? ' kbd-color-swatch--selected' : ''}" ` +
      `style="background:${c}" data-color="${c}" title="${c}"></span>`
    ).join('') +
      // プリセット一覧を広げる代わりに、OSネイティブのカラーピッカー(無段階スペクトラム)を
      // 呼び出す小さな1マスを追加する。画面を圧迫せずに「もっと多くの色」を選べるようにする。
      `<span class="kbd-color-swatch kbd-color-more" title="もっと選ぶ...">` +
      `<input type="color" class="kbd-color-native" value="${/^#[0-9a-f]{6}$/i.test(currentColor || '') ? currentColor : '#ffffff'}"></span>` +
      `<button type="button" class="kbd-color-reset">既定色に戻す</button>`;
    document.body.appendChild(pop);

    const rect = anchorEl.getBoundingClientRect();
    pop.style.left = Math.round(rect.left) + 'px';
    pop.style.top = Math.round(rect.bottom + 4) + 'px';
    const pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth) pop.style.left = Math.max(0, window.innerWidth - pr.width - 4) + 'px';
    if (pr.bottom > window.innerHeight) pop.style.top = Math.max(0, rect.top - pr.height - 4) + 'px';

    pop.querySelectorAll('.kbd-color-swatch[data-color]').forEach((sw) => {
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(sw.getAttribute('data-color'));
        closeColorPicker();
      });
    });
    pop.querySelector('.kbd-color-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      onReset();
      closeColorPicker();
    });

    // 「もっと選ぶ」マス: OSネイティブのカラーピッカーを開く。ドラッグ中は
    // input イベントでリアルタイムに反映し、確定(change)でポップオーバーを閉じる。
    const nativeInput = pop.querySelector('.kbd-color-native');
    nativeInput.addEventListener('input', () => onPick(nativeInput.value));
    nativeInput.addEventListener('change', (e) => {
      e.stopPropagation();
      onPick(nativeInput.value);
      closeColorPicker();
    });

    _colorPickerEl = pop;
    _colorPickerOutsideHandler = (e) => { if (!pop.contains(e.target)) closeColorPicker(); };
    // 開いたクリック自体で即座に閉じてしまわないよう、次のイベントループで登録する
    setTimeout(() => document.addEventListener('mousedown', _colorPickerOutsideHandler, true), 0);
  }

  function drawPiano(canvas, channels) {
    const newW = canvas.offsetWidth || 560;
    if (newW === 0) return;
    if (canvas.width !== newW) canvas.width = newW; // サイズ変化時のみ再割り当て（毎フレームのリフロー防止）
    const wkW = canvas.width / TOTAL_WHITE;
    const bkW = Math.max(3, wkW * 0.60);
    const wkH = canvas.height;
    const bkH = Math.round(wkH * 0.62);
    const ctx = canvas.getContext('2d');

    const keyColors = {};
    for (const ch of channels) {
      if (!ch.active || ch.noise || ch.sample || !ch.freq) continue;
      const midi = freqToMidi(ch.freq);
      if (midi !== null && !keyColors[midi]) keyColors[midi] = ch.color;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#d4cfbc';
      ctx.fillRect(pos.x + 0.5, 0.5, wkW - 1, wkH - 1);
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(pos.x + 0.5, 0.5, wkW - 1, wkH - 1);
      if (color) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(pos.x + 0.5, wkH - 8, wkW - 1, 7);
        ctx.globalAlpha = 1;
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (!IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#1a1830';
      ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH);
      if (color) {
        ctx.fillStyle = '#1a1830';
        ctx.globalAlpha = 0.35;
        ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH * 0.65);
        ctx.globalAlpha = 1;
      }
    }
  }

  // ── KeyboardDisplay クラス ────────────────────────────────────

  class KeyboardDisplay {
    constructor(container) {
      this.container = container;
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
      this._rollSongTimeBase = 0; // 最後に実測位置が更新された時点での「曲内基準の経過時間」(確定値)
      this._rollLastRawPos = null; // 直前に_renderRollへ渡された実時間(壁時計)位置
      this._rollBaseWallMs = null; // _rollSongTimeBase確定時点のperformance.now()(補間の起点)
      this.onMuteChange = null;
      this.onSpcMuteChange = null; // (voiceIndex:number, muted:bool) => void
      this.onSpeedChange = null;   // (factor:number) => void  曲切替をまたいで保持する
      this._colorOverrides = loadColorOverrides(); // channelId → ユーザー指定色(localStorage永続化)
      this._build();
    }

    _build() {
      this.container.innerHTML = '';
      this._selectedId = null;   // 大波形表示に選択中のチャンネルID
      this._bigWaveSig = '';     // 大波形の再描画要否判定用

      // 上段: 左=速度バー+チャンネル一覧 / 右=選択波形の拡大表示
      // （SPCモードは列数が多いため setMode() で縦積みレイアウトに切り替える）
      const main = document.createElement('div');
      main.className = 'kbd-main';
      this._mainEl = main;

      const left = document.createElement('div');
      left.className = 'kbd-left';
      this._leftEl = left;

      // 再生速度バー(1/1〜1/8)。音程を保ったままテンポだけを落とす。
      // 見出し・行と同じ left 内に置くことで幅が自動的に揃う（別枠に見えないように）。
      const speedBar = document.createElement('div');
      speedBar.className = 'kbd-speed';
      speedBar.innerHTML =
        `<span class="kbd-speed-label">速度</span>` +
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
      left.appendChild(speedBar);

      const header = document.createElement('div');
      header.className = 'kbd-header';
      header.innerHTML =
        `<span class="kbd-h-part">part</span>` +
        `<span class="kbd-h-mute-solo" title="mute">\u{1F507}</span>` +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-vol">vol</span>` +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbd-h-freq">freq</span>`;
      // dot 列オフセット不要（kbd-h-part が dot+パート文字両方をカバー）
      this._headerEl = header;
      left.appendChild(header);

      this._rowsEl = document.createElement('div');
      this._rowsEl.className = 'kbd-rows';
      left.appendChild(this._rowsEl);

      // SPC ボイス用セクション（再生中のみ表示）。列数がNSFと大きく異なるため
      // 専用ヘッダーを持つが、NSF側と同じく left 直下に置いて横スクロール無しで
      // 全列表示する（left 側の幅は setMode() で SPC モード時に拡張する）。
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
        `<span class="kbds-h-echo">echo</span>` +
        `<span class="kbds-h-echolr">echoL</span>` +
        `<span class="kbds-h-echolr">echoR</span>` +
        Array.from({ length: 8 }, (_, i) => `<span class="kbds-h-fir">C${i}</span>`).join('');
      left.appendChild(this._spcHeaderEl);

      this._spcSectionEl = document.createElement('div');
      this._spcSectionEl.className = 'kbd-rows';
      this._spcSectionEl.style.display = 'none';
      left.appendChild(this._spcSectionEl);

      // 右: 選択チャンネルの素波形を拡大表示（表示サイズ固定・要素数はX/Y数値で表現）
      const big = document.createElement('div');
      big.className = 'kbd-bigwave';
      this._bigTitleEl = document.createElement('div');
      this._bigTitleEl.className = 'kbd-bigwave-title';
      this._bigTitleEl.textContent = 'Click a wave icon to enlarge';
      this._bigCanvas = document.createElement('canvas');
      this._bigCanvas.className = 'kbd-bigwave-canvas';
      this._bigCanvas.width = 560;   // 内部解像度(表示の2倍)。表示サイズは.kbd-bigwave-canvasで指定
      this._bigCanvas.height = 280;
      big.appendChild(this._bigTitleEl);
      big.appendChild(this._bigCanvas);
      this._bigWaveEl = big;

      main.appendChild(left);
      main.appendChild(big);
      this.container.appendChild(main);

      // ピアノロール: 鍵盤のすぐ上に配置し、未来の音符を上から降らせて表示する。
      // 折りたたみ状態は localStorage に保存し次回起動時も維持する。
      const rollWrap = document.createElement('div');
      rollWrap.className = 'kbd-roll-wrap';
      const rollHeader = document.createElement('div');
      rollHeader.className = 'kbd-roll-header';
      let rollCollapsed = false;
      try { rollCollapsed = localStorage.getItem('mml_pianoRollCollapsed') === '1'; } catch (e) { /* ignore */ }
      rollHeader.innerHTML =
        `<span class="kbd-roll-toggle">${rollCollapsed ? '▶' : '▼'}</span>` +
        `<span class="kbd-roll-label">ピアノロール</span>`;
      this._rollCanvas = document.createElement('canvas');
      this._rollCanvas.className = 'kbd-roll';
      this._rollCanvas.height = 320;
      this._rollCanvas.style.display = rollCollapsed ? 'none' : '';
      rollHeader.addEventListener('click', () => {
        const collapsed = this._rollCanvas.style.display !== 'none';
        this._rollCanvas.style.display = collapsed ? 'none' : '';
        rollHeader.querySelector('.kbd-roll-toggle').textContent = collapsed ? '▶' : '▼';
        try { localStorage.setItem('mml_pianoRollCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      });
      rollWrap.appendChild(rollHeader);
      rollWrap.appendChild(this._rollCanvas);
      this.container.appendChild(rollWrap);

      this._canvas = document.createElement('canvas');
      this._canvas.className = 'kbd-piano';
      this._canvas.height = 68;
      this.container.appendChild(this._canvas);
    }

    setSource(result, chips) {
      this._chips = Array.isArray(chips) ? chips.filter(c => c && c !== 'none') : [];
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
      if (!regSnapshots || totalFrames <= 0) { this._rollTimeline = null; return; }
      const wl = writeLog || [];
      const extraSnaps = {
        vrc7: chips.includes('vrc7') ? buildVrc7Snapshots(wl) : null,
        n163: chips.includes('n163')
          ? (n163Snapshots && n163Snapshots.length ? buildN163SnapshotsFromLiveRam(n163Snapshots) : buildN163Snapshots(wl))
          : null,
        fme7: chips.includes('fme7') ? buildFme7Snapshots(wl) : null,
      };
      const frameDur = samplesPerFrame / sampleRate;
      this._rollTimeline = buildNoteTimelineFromChannelFrames(
        (f) => extractChannels(regSnapshots[f] || {}, extraSnaps, f, chips),
        totalFrames, frameDur
      );
    }

    // 新しいファイルを読み込んだ直後などに呼ぶ。前のファイルの発音色が鍵盤/ピアノロールに
    // 残ったまま次のファイルを読み込んだように見えてしまう問題(再生ボタンを押すまで
    // update()/updateSpcVoices()に新しいデータが渡らず、直前の描画がそのまま残る)を防ぐため、
    // 表示を無音状態に戻して即座に再描画する。
    reset() {
      this._spcVoices = [];
      this._prevSpcVoices = [];
      this.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100, writeLog: [] }, []);
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
      // SPCは列数が多いため、横スクロールなしで全列収まるよう左パネル幅を拡張する。
      // 大波形パネルはecho列より右（echoL〜C7、ALL行以外は常に空欄）の領域にちょうど
      // 収まるサイズに縮小して重ね、note/freq/echo列の実データを隠さないようにする
      // （サイズ・位置は _positionSpcBigWave() で echoL〜C7 の実測幅から都度計算する）。
      this._leftEl.classList.toggle('kbd-left--spc', spc);
      this._mainEl.classList.toggle('kbd-main--spc', spc);

      if (!spc) {
        // NSF/MMLモードでは常に固定の既定サイズに戻す
        this._bigCanvas.style.width = '';
        this._bigCanvas.style.height = '';
        if (this._bigCanvas.width !== 560) {
          this._bigCanvas.width = 560;
          this._bigCanvas.height = 280;
          this._bigWaveSig = '';
          if (this._selectedId) {
            const sel = (this._prevChannels || []).find(c => c.id === this._selectedId);
            if (sel) this._renderBigWave(sel);
          }
        }
      }

      // ウィンドウが狭い場合のみ、全列が収まる最小サイズまで自動拡張する
      // （縮小はしない。ユーザーが既に手動でそれ以上広げていればそのまま尊重する）
      if (spc) {
        const winEl = this.container.closest('.float-window');
        if (winEl) {
          const minW = 1030, minH = 560;
          if (winEl.offsetWidth < minW) winEl.style.width = minW + 'px';
          if (winEl.offsetHeight < minH) winEl.style.height = minH + 'px';
        }
        this._positionSpcBigWave();
      }
    }

    // 大波形パネルをALL行のすぐ下（ALL行の値を隠さない位置）に実測で配置し、
    // 幅もecho列より右（echoL列左端〜C7列右端）にちょうど収まるよう実測して
    // 縮小する（縦横比は保つ）。列幅はCSS側の調整で変わりうるため、固定px値ではなく
    // 都度DOMから実測する。
    _positionSpcBigWave() {
      if (this._mode !== 'spc' || !this._spcAllRow) return;
      const row = this._spcAllRow.row;
      this._bigWaveEl.style.top = (row.offsetTop + row.offsetHeight + 4) + 'px';

      const echoLEl = this._spcHeaderEl.querySelector('.kbds-h-echolr');
      const firEls = this._spcHeaderEl.querySelectorAll('.kbds-h-fir');
      const c7El = firEls[firEls.length - 1];
      if (!echoLEl || !c7El) return;
      // echoL列の左端 〜 C7列の右端に厳密に揃える。offsetLeftはどちらも同じ
      // 位置決め祖先(position:relativeのkbd-main)基準なので、right指定ではなく
      // left指定にする（kbd-leftは横スクロール回避のため列合計より広いことがあり、
      // right基準だとkbd-leftの右端＝C7の右端にならず揃わない）。
      const leftPx = echoLEl.offsetLeft;
      const span = (c7El.offsetLeft + c7El.offsetWidth) - leftPx;

      const cs = getComputedStyle(this._bigWaveEl);
      const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const borderH = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const cssW = Math.max(120, Math.round(span - padH - borderH));
      const cssH = Math.round(cssW * (560 / 1120)); // 元の縦横比(2:1)を維持

      this._bigWaveEl.style.left = leftPx + 'px';
      this._bigWaveEl.style.right = 'auto';

      if (this._bigCanvas.clientWidth === cssW) return; // 未変化なら何もしない
      this._bigCanvas.style.width = cssW + 'px';
      this._bigCanvas.style.height = cssH + 'px';
      this._bigCanvas.width = cssW * 2;   // 内部解像度はCSS表示サイズの2倍(シャープさ維持)
      this._bigCanvas.height = cssH * 2;
      this._bigWaveSig = ''; // サイズ変更のため強制再描画
      if (this._selectedId) {
        const sel = (this._prevChannels || []).concat(this._prevSpcVoices || [])
          .find(c => c.id === this._selectedId);
        if (sel) this._renderBigWave(sel);
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
        openColorPicker(
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

      if (this._selectedId === id) {
        this._bigWaveSig = ''; // 色はwave形状に含まれないため強制再描画
        const sel = (this._prevChannels || []).concat(this._prevSpcVoices || [])
          .find((c) => c.id === id);
        if (sel) this._renderBigWave(sel);
      }
    }

    _rebuildRows(channels) {
      this._rowsEl.innerHTML = '';
      this._rowEls = [];
      for (const ch of channels) {
        const mi = getMuteInfo(ch.id);
        const muted = this._muteState.get(ch.id) || false;

        const row = document.createElement('div');
        const rowColor = this._getColor(ch.id, ch.color);
        row.className = 'kbd-ch-row';
        row.innerHTML =
          `<span class="kbd-dot" style="background:${rowColor}"></span>` +
          `<span class="kbd-part">${ch.letter || ''}</span>` +
          `<input type="checkbox" class="kbd-mute"${muted ? '' : ' checked'} title="${ch.id} ミュート">` +
          `<span class="kbd-name">${ch.id}</span>` +
          `<span class="kbd-vol-num">0</span>` +
          `<span class="kbd-vol-wrap"><span class="kbd-vol-bar" style="background:transparent"></span></span>` +
          `<canvas class="kbd-wave" width="68" height="28"></canvas>` +
          `<span class="kbd-note">—</span>` +
          `<span class="kbd-freq"></span>`;

        const checkbox = row.querySelector('.kbd-mute');
        checkbox.addEventListener('change', () => {
          this._muteState.set(ch.id, !checkbox.checked);
          if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
        });

        // 波形アイコンをクリックで大波形表示に選択
        const waveCanvas = row.querySelector('.kbd-wave');
        const chId = ch.id;
        waveCanvas.classList.add('kbd-wave--clickable');
        if (chId === this._selectedId) waveCanvas.classList.add('kbd-wave--selected');
        waveCanvas.addEventListener('click', () => this._selectWave(chId));

        // 丸のクリックで色ピッカーを開く(選んだ色は即localStorageへ保存され全表示に反映)
        this._attachColorPicker(row.querySelector('.kbd-dot'), ch.id, ch.color);

        this._rowsEl.appendChild(row);
        this._rowEls.push({
          row,
          id: ch.id,
          volBar: row.querySelector('.kbd-vol-bar'),
          volNum: row.querySelector('.kbd-vol-num'),
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
    }

    // 波形アイコンのクリック: 選択チャンネルを切り替え、拡大表示を更新
    // NSF/SPC どちらの行がクリックされても対応できるよう両リストを見る（IDは重複しない）
    _selectWave(chId) {
      this._selectedId = chId;
      this._bigWaveSig = '';   // 強制再描画
      for (const el of this._rowEls) {
        el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      for (const el of this._spcRowEls) {
        el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      // 直近のチャンネル状態で即時描画
      const ch = (this._prevChannels || []).find(c => c.id === chId) ||
                 (this._prevSpcVoices || []).find(c => c.id === chId);
      if (ch) this._renderBigWave(ch);
    }

    // 選択チャンネルの素波形を右パネルへ描画（形状変化時のみ再描画）
    _renderBigWave(ch) {
      if (!ch || !ch.wave) return;
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
        el.volNum.title = (ch.id === 'TR' && rawStr && ch.envMode === true) ? '$4011制御' : '';

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
        } else if (ch.noise) {
          // note: 周期インデックス数値。長周期=白 / 短周期=黄
          el.noteEl.textContent = String(ch.noiseIndex);
          el.noteEl.style.color = ch.noiseShort ? '#ffcc44' : '#e6e6ef';
          // freq: ノイズ周波数 (Hz)
          el.freqEl.textContent = Math.round(ch.noiseFreq).toLocaleString() + ' Hz';
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
          el.row.title = ch.modActive ? '$4087 bit7=0 (モジュレーション有効)' : '';
        }
      }

      // 選択チャンネルの大波形を更新（FDS/N163 等は波形が変化するため毎フレーム判定）
      if (this._selectedId) {
        const sel = channels.find(c => c.id === this._selectedId);
        if (sel) this._renderBigWave(sel);
      }

      // SPC ボイスを合流させてピアノに反映(色はユーザー上書きを解決してから渡す)
      const allChannels = channels.map(c => ({ ...c, color: this._getColor(c.id, c.color) }))
        .concat(this._spcVoices.map(v => ({
          id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
          active: v.active, rawVol: null, rawVolMax: null,
        })));
      drawPiano(this._canvas, allChannels);

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

    // ピアノロール描画(Synthesia式: ピッチ=X軸を鍵盤とkeyX()で共有、時間=Y軸で
    // 上から下(=鍵盤に接する現在地)へ降ってくる)。_rollTimeline が無い間(先読み
    // キャプチャ完了前など)は前回の描画内容をクリアするだけにする。
    _renderRoll(posSeconds) {
      const canvas = this._rollCanvas;
      if (!canvas || canvas.style.display === 'none') return;
      const newW = canvas.offsetWidth || 560;
      if (newW === 0) return;
      if (canvas.width !== newW) canvas.width = newW;
      const wkW = canvas.width / TOTAL_WHITE;
      const bkW = Math.max(3, wkW * 0.60);
      const h = canvas.height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, h);

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
        this._rollSongTimeBase = 0; // 新規再生開始 or シークによる巻き戻り
        this._rollBaseWallMs = nowMs;
      } else if (rawPos > this._rollLastRawPos + 1e-6) {
        this._rollSongTimeBase += (rawPos - this._rollLastRawPos) * speedFactor; // 実測位置が更新された
        this._rollBaseWallMs = nowMs;
      }
      this._rollLastRawPos = rawPos;
      const elapsedSinceBaseMs = Math.min(ROLL_INTERP_CAP_MS, Math.max(0, nowMs - (this._rollBaseWallMs || nowMs)));
      const pos = this._rollSongTimeBase + (elapsedSinceBaseMs / 1000) * speedFactor;
      const winEnd = pos + ROLL_WINDOW_SEC;

      // 鍵盤ごとの縦グリッド線(白鍵の境界線+黒鍵カラムの淡い網掛け)とCの音名ラベル。
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        const semi = rel % 12;
        const keyPos = keyX(midi, wkW);
        if (!keyPos) continue;
        if (IS_BLACK[semi]) {
          ctx.fillStyle = '#000000';
          ctx.globalAlpha = 0.25;
          ctx.fillRect(keyPos.x - bkW / 2, 0, bkW, h);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = '#3d3d4a';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(keyPos.x) + 0.5, 0);
          ctx.lineTo(Math.round(keyPos.x) + 0.5, h);
          ctx.stroke();
          if (semi === 0) { // C
            ctx.fillStyle = '#6b6b7a';
            ctx.font = '9px sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(midiToName(midi), keyPos.x + 2, 1);
          }
        }
      }

      // 時間軸: 曲内の絶対秒(0,1,2,3…)ごとに横線を引き、ノートと同じ式でスクロールさせる。
      // 再生が進むにつれて線が下から上へ流れ、新しい秒の線が上端から現れる(累積の経過時間)。
      ctx.strokeStyle = '#3d3d4a';
      ctx.fillStyle = '#6b6b7a';
      ctx.font = '9px sans-serif';
      ctx.textBaseline = 'bottom';
      const firstSec = Math.ceil(pos);
      for (let s = firstSec; s < winEnd; s++) {
        const y = Math.round(h - ((s - pos) / ROLL_WINDOW_SEC) * h) + 0.5;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(`${s}s`, 2, y - 1);
      }

      if (!this._rollTimeline || !this._rollTimeline.length) return;

      for (const track of this._rollTimeline) {
        if (this._isTrackMuted(track.id)) continue; // ミュート中のチャンネルは描画しない
        for (const note of track.notes) {
          if (note.endSec <= pos || note.startSec >= winEnd) continue;
          const keyPos = keyX(note.midi, wkW);
          if (!keyPos) continue;
          const relEnd = Math.min(ROLL_WINDOW_SEC, note.endSec - pos);
          const relStart = Math.max(0, note.startSec - pos);
          const top = Math.max(0, h - (relEnd / ROLL_WINDOW_SEC) * h);
          const bottom = Math.min(h, h - (relStart / ROLL_WINDOW_SEC) * h);
          const rectH = Math.max(2, bottom - top);
          const x = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
          const w = keyPos.isBlack ? bkW : (wkW - 1);
          // 音量による濃淡はやめ、常にチャンネル本来の色をそのまま(不透明・フィルタ無し)で描く。
          ctx.fillStyle = this._getColor(track.id, track.color);
          ctx.fillRect(x, top, w, rectH);
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
        `<input type="checkbox" class="kbd-mute" checked title="${v.label} ミュート">` +
        `<span class="kbd-name">${v.label}</span>` +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbd-vol-num">0</span>` +
        `<span class="kbd-vol-wrap"><span class="kbd-vol-bar" style="background:transparent"></span></span>` +
        `<span class="kbds-env"><canvas class="kbds-env-canvas" width="34" height="16"></canvas><span class="kbds-env-text"></span></span>` +
        `<canvas class="kbd-wave" width="68" height="28"></canvas>` +
        `<span class="kbds-pm">-</span>` +
        `<span class="kbd-note">—</span>` +
        `<span class="kbds-freq"></span>` +
        `<span class="kbds-echo">-</span>` +
        `<span class="kbds-echolr"></span>` +
        `<span class="kbds-echolr"></span>` +
        Array.from({ length: 8 }, () => `<span class="kbds-fir"></span>`).join('');

      const checkbox = row.querySelector('.kbd-mute');
      checkbox.addEventListener('change', () => {
        if (this.onSpcMuteChange) this.onSpcMuteChange(idx, !checkbox.checked);
      });

      // 波形アイコンをクリックで大波形表示に選択（NSF側と同じ挙動）
      const waveCanvas = row.querySelector('.kbd-wave');
      const chId = v.label;
      waveCanvas.classList.add('kbd-wave--clickable');
      if (chId === this._selectedId) waveCanvas.classList.add('kbd-wave--selected');
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

    // ALL行: mute/vol/env/wave/PM/note/freq/echo は空欄。L・R にマスター音量
    // ($0C/$1C)、echoL・echoRにエコー音量($2C/$3C)、C0-C7にFIRフィルタ係数を表示。
    _buildSpcAllRow() {
      const row = document.createElement('div');
      row.className = 'kbd-ch-row kbds-all-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:#888"></span>` +
        `<span class="kbd-mute-ph"></span>` +
        `<span class="kbd-name">ALL</span>` +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbd-vol-num"></span>` +
        `<span class="kbd-vol-wrap"></span>` +
        `<span class="kbds-env"></span>` +
        `<span class="kbd-wave" style="visibility:hidden"></span>` +
        `<span class="kbds-pm"></span>` +
        `<span class="kbd-note"></span>` +
        `<span class="kbds-freq"></span>` +
        `<span class="kbds-echo"></span>` +
        `<span class="kbds-echolr"></span>` +
        `<span class="kbds-echolr"></span>` +
        Array.from({ length: 8 }, () => `<span class="kbds-fir"></span>`).join('');
      const lrEls = row.querySelectorAll('.kbds-lr');
      const echolrEls = row.querySelectorAll('.kbds-echolr');
      return {
        row,
        lEl: lrEls[0], rEl: lrEls[1],
        echoLEl: echolrEls[0], echoREl: echolrEls[1],
        firEls: Array.from(row.querySelectorAll('.kbds-fir')),
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

      // ALL行は初回のみ構築（内容は毎回更新）
      if (!this._spcAllRow) {
        this._spcSectionEl.innerHTML = '';
        this._spcAllRow = this._buildSpcAllRow();
        this._spcSectionEl.appendChild(this._spcAllRow.row);
      }

      // 行数が変化した場合だけ per-voice 行を再構築（通常は初回の8行のみ。ALL行は保持）
      if (this._spcRowEls.length !== this._spcVoices.length) {
        for (const el of this._spcRowEls) el.row.remove();
        this._spcRowEls = this._spcVoices.map((v, idx) => {
          const el = this._buildSpcRow(v, idx);
          this._spcSectionEl.appendChild(el.row);
          return el;
        });
      }

      // ALL行データ更新（マスター音量・エコー音量・FIRフィルタ、各 -128〜127）
      if (master && this._spcAllRow) {
        const a = this._spcAllRow;
        a.lEl.textContent = String(master.volL);
        a.rEl.textContent = String(master.volR);
        a.echoLEl.textContent = String(master.echoL);
        a.echoREl.textContent = String(master.echoR);
        (master.fir || []).forEach((val, i) => { if (a.firEls[i]) a.firEls[i].textContent = String(val); });
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
      if (this._selectedId) {
        const sel = this._prevSpcVoices.find(c => c.id === this._selectedId);
        if (sel) this._renderBigWave(sel);
      }

      this._positionSpcBigWave();

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
        drawPiano(this._canvas, allChannels);
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
