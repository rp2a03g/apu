/*
 * VGM → MML コンバータ
 * MML.VGM2MML.fromVgm(vgmBytes, durationSeconds, options)
 *   → Promise<{ mml, bpm, chips, expansions, family, assignments, ... }>
 *
 * VGMはCPU無しのレジスタ書込みログで、使うチップはヘッダで決まる(src/vgm/vgmHeader.js)。
 * 抽出器は既存の *2mml のものを流用する(抽出器を複製しない、ROADMAP.md VGM節):
 *   NES APU(+FDS)      → MML.NSF2MML.convert         (nsf2mml、ネイティブ変換。丸ごと委譲)
 *   GB DMG             → MML.GBS2MML.convertCapture   (gbs2mml、2A03/FDS借用。丸ごと委譲)
 *   HuC6280            → MML.HES2MML.convertCapture   (hes2mml、N163/2A03ノイズ借用。丸ごと委譲)
 *   AY8910/SCC/YM2413/SN76489(複数チップ・デュアルチップの同居あり)
 *                      → 本ファイルの composePsgLike: kss2mml/expansion/{ay,scc,opll}.js と
 *                        vgm2mml/expansion/sn76489.js の抽出器を直接呼び、**構成に応じて借用先を
 *                        自動割当**してから1つのスコアに合成する(下記)。
 *
 * ── 借用先の割当(構成駆動の既定+ユーザー上書き) ─────────────────────────────
 * 変換元チャンネル一覧(sourceChannels)はヘッダだけから決まる。既定割当(defaultPlan)は
 * 「AY8910×1+SN76489×2(Exed Exes)なら AY→FME-7、SN×2→N163×6ch」のように種類と本数から
 * 機械的に決める(固定: AY→FME-7、YM2413→VRC7、SCC→N163。SN76489はFME-7の空き→N163へ
 * チップ単位。ノイズは最初の1本だけ2A03ノイズD)。ユーザーはVGMパネルの「チャンネル割当」で
 * ソースchごとに借用先(SPCのTARGET_OPTIONSと同じ語彙: A/B/C/D、FME-7、N163、MMC5、VRC6…)を
 * 変えられ(例: FME-7が高音で辛いchを2A03へ)、options.channelMap として渡る。借用先ファミリ
 * ごとにイベントを整形(adaptEvents: 矩形波/デューティ/音量の対数→線形換算/三角波は音程のみ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.VGM2MML = {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(FME-7/N163/2A03)のクロック。src/mml/compiler.jsと同じ値
  const N163_WAVE_LEN = 32;       // N163へ載せる矩形波の長さ(SCC近似と同じ32点で統一)
  // N163用の矩形波(50%デューティ、4bit)。@N<n>として登録し、矩形波チップの音色に使う
  const N163_SQUARE_WAVE = Array.from({ length: N163_WAVE_LEN }, (_, i) => (i < N163_WAVE_LEN / 2 ? 15 : 0));

  // FME-7: freq = CLOCK/(32*period)。kss2mml/converter.jsのfme7PeriodRawと同じ(丸めない)。
  function fme7PeriodRaw(freq) { return CPU_CLOCK_NTSC / (32 * freq); }
  // N163: freqReg = freq*15*65536*waveLen*numCh/CLOCK(kss2mml/converter.jsのn163FreqRegRawと同じ)。
  function n163FreqRegRaw(waveLen, numCh) { return freq => freq * 15 * 65536 * waveLen * numCh / CPU_CLOCK_NTSC; }
  // VRC7: kss2mml/converter.jsのvrc7FnumRawと同じ
  function vrc7FnumRaw(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }

  // 対数DAC(dbPerStep/段)の4bit音量値を線形4bit(N163)へ換算する表
  function logToLinearTable(dbPerStep) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = v === 0 ? 0 : Math.max(1, Math.round(15 * Math.pow(10, -dbPerStep * (15 - v) / 20)));
    return t;
  }
  // envReg.assign(volSeq) を写像テーブル経由にするプロキシ(抽出器はassignしか使わない)
  function mappedEnvReg(envReg, table) {
    return { assign: seq => envReg.assign(seq.map(v => table[Math.max(0, Math.min(15, v))])) };
  }
  // 抽出器が定数音量として残した ev.volume も同じ表で写像する
  function mapConstVolumes(events, table) {
    for (const ev of events) if (ev.volume !== undefined) ev.volume = table[Math.max(0, Math.min(15, ev.volume))];
  }

  function gd3Field(h, en, ja) {
    const g = h && h.gd3;
    if (!g) return '';
    return g[en] || g[ja] || '';
  }

  // ---------------------------------------------------------------------------
  // 借用先タイプ(SPCのTARGET_OPTIONSと同じ語彙、src/main.js参照)とチャンネル割当計画
  // ---------------------------------------------------------------------------
  // type → { chip(拡張音源名|null=2A03), index(チップ内ch番号), letter(2A03のみ固定) }
  const TARGET_TYPES = {
    skip:       { chip: null },
    pulse1:     { chip: '2a03', letter: 'A', family: 'pulse' },
    pulse2:     { chip: '2a03', letter: 'B', family: 'pulse' },
    triangle:   { chip: '2a03', letter: 'C', family: 'triangle' },
    noise:      { chip: '2a03', letter: 'D', family: 'noise' },
    fme7a:      { chip: 'fme7', index: 0, family: 'fme7' },
    fme7b:      { chip: 'fme7', index: 1, family: 'fme7' },
    fme7c:      { chip: 'fme7', index: 2, family: 'fme7' },
    mmc5pulse1: { chip: 'mmc5', index: 0, family: 'pulse' },
    mmc5pulse2: { chip: 'mmc5', index: 1, family: 'pulse' },
    vrc6pulse1: { chip: 'vrc6', index: 0, family: 'vrc6pulse' },
    vrc6pulse2: { chip: 'vrc6', index: 1, family: 'vrc6pulse' },
  };
  for (let i = 0; i < 8; i++) TARGET_TYPES['n163_' + i] = { chip: 'n163', index: i, family: 'n163' };
  for (let i = 0; i < 6; i++) TARGET_TYPES['vrc7_' + i] = { chip: 'vrc7', index: i, family: 'vrc7' };
  MML.VGM2MML.TARGET_TYPES = TARGET_TYPES;

  // ソース種別ごとに選べる借用先(UIのselect候補)。
  // square=矩形波チップ(AY/SN)、wave=SCC、fm=YM2413(2op FM、VRC7とネイティブ同一)、
  // fm4=OPN系4op FM(YM2612/YM2610)、pcm=YM2610 ADPCM-A/B(サンプル。ピッチ解析で音程を得たもの)、
  // noise=SNノイズ。VRC7はどの種別からも選べる(そのとき音色はプリセット番号をUIで選ぶ:
  // vrc7InstOptions / options.vrc7Inst)。
  const VRC7_TARGETS = Array.from({ length: 6 }, (_, i) => 'vrc7_' + i);
  const N163_TARGETS = Array.from({ length: 8 }, (_, i) => 'n163_' + i);
  const SQUARE_TARGETS = ['skip', 'fme7a', 'fme7b', 'fme7c', 'pulse1', 'pulse2', 'triangle', 'mmc5pulse1', 'mmc5pulse2', 'vrc6pulse1', 'vrc6pulse2']
    .concat(N163_TARGETS).concat(VRC7_TARGETS);
  const WAVE_TARGETS = ['skip'].concat(N163_TARGETS).concat(VRC7_TARGETS);
  const FM_TARGETS = ['skip'].concat(VRC7_TARGETS).concat(SQUARE_TARGETS.slice(1).filter(t => !VRC7_TARGETS.includes(t)));
  const NOISE_TARGETS = ['skip', 'noise'];
  MML.VGM2MML.targetOptionsFor = function (kind) {
    return kind === 'wave' ? WAVE_TARGETS : (kind === 'fm' || kind === 'fm4' || kind === 'pcm') ? FM_TARGETS : kind === 'noise' ? NOISE_TARGETS : SQUARE_TARGETS;
  };

  // VRC7を借用先に選んだときの音色プリセット(VRC7内蔵ROM音色1-15。名前はNESdev wikiのVRC7音色表)。
  // OPLL(YM2413)ソースは元の音色番号/カスタム音色をそのまま使う 'auto' が既定。
  const VRC7_PRESET_NAMES = ['', 'Buzzy Bell', 'Guitar', 'Wurly', 'Flute', 'Clarinet', 'Synth', 'Trumpet', 'Organ',
    'Bells', 'Vibes', 'Vibraphone', 'Tutti', 'Fretless', 'Synth Bass', 'Sweep'];
  MML.VGM2MML.VRC7_PRESET_NAMES = VRC7_PRESET_NAMES;
  MML.VGM2MML.vrc7InstOptions = function (kind) {
    const list = [];
    if (kind === 'fm') list.push({ value: 'auto', label: '元の音色' });
    for (let i = 1; i <= 15; i++) list.push({ value: String(i), label: `@${i} ${VRC7_PRESET_NAMES[i]}` });
    return list;
  };
  MML.VGM2MML.defaultVrc7Inst = function (kind) { return kind === 'fm' ? 'auto' : '1'; };

  /**
   * ヘッダから変換元チャンネル一覧を作る(キャプチャ不要。UIの割当表とcomposePsgLikeが共有)。
   * @returns {Array<{id, label, kind, chip, chipIndex, ch}>}
   */
  MML.VGM2MML.sourceChannels = function (h) {
    const out = [];
    const c = h.chips || {};
    if (c.ay8910) for (let i = 0; i < 3; i++) out.push({ id: `ay:${i}`, label: `AY8910 ch${i + 1}`, kind: 'square', chip: 'ay8910', chipIndex: 0, ch: i });
    // YM2610(Neo Geo)の内蔵SSG(AY互換): captureVgmSongAsyncがkss.writeLogへAY書込みとして流すので
    // 抽出はAY8910と同じ経路。ay8910と同居する構成は実在しないので同じ 'ay8910' chipキーで扱う
    if (c.ym2610 && !c.ay8910) for (let i = 0; i < 3; i++) out.push({ id: `ay:${i}`, label: `YM2610 SSG ch${i + 1}`, kind: 'square', chip: 'ay8910', chipIndex: 0, ch: i });
    if (c.k051649) for (let i = 0; i < 5; i++) out.push({ id: `scc:${i}`, label: `SCC ch${i + 1}`, kind: 'wave', chip: 'k051649', chipIndex: 0, ch: i });
    if (c.ym2413) for (let i = 0; i < 6; i++) out.push({ id: `opll:${i}`, label: `YM2413 ch${i + 1}`, kind: 'fm', chip: 'ym2413', chipIndex: 0, ch: i });
    // OPN系FM: YM2612(6ch。ch6のDAC(PCMストリーム)は音程情報が無いので対象外)、YM2610(4ch、Bは6ch)。
    // YM2610 ADPCM-A/B はサンプルのピッチ解析(ym2610.js samplePitch)で音程が取れたものだけ音符になる。
    if (c.ym2612) for (let i = 0; i < 6; i++) out.push({ id: `opn:${i}`, label: `YM2612 FM${i + 1}`, kind: 'fm4', chip: 'ym2612', chipIndex: 0, ch: i });
    if (c.ym2610) {
      const nFm = c.ym2610.ym2610b ? 6 : 4;
      for (let i = 0; i < nFm; i++) out.push({ id: `opnb:${i}`, label: `YM2610 FM${i + 1}`, kind: 'fm4', chip: 'ym2610', chipIndex: 0, ch: i });
      for (let i = 0; i < 6; i++) out.push({ id: `pcma:${i}`, label: `YM2610 ADPCM-A${i + 1}`, kind: 'pcm', chip: 'ym2610adpcm', chipIndex: 0, ch: i });
      out.push({ id: 'pcmb:0', label: 'YM2610 ADPCM-B', kind: 'pcm', chip: 'ym2610adpcm', chipIndex: 0, ch: 6 });
    }
    if (c.sn76489) {
      const n = c.sn76489.dual ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const nm = n > 1 ? `SN76489#${k + 1}` : 'SN76489';
        for (let i = 0; i < 3; i++) out.push({ id: `sn${k}:${i}`, label: `${nm} ch${i + 1}`, kind: 'square', chip: 'sn76489', chipIndex: k, ch: i });
        out.push({ id: `sn${k}:noise`, label: `${nm} noise`, kind: 'noise', chip: 'sn76489', chipIndex: k, ch: 3 });
      }
    }
    return out;
  };

  /**
   * 構成駆動の既定割当(ROADMAP.md VGM節 段階3): 固定=AY→FME-7、YM2413→VRC7、SCC→N163。
   * SN76489はFME-7の空き→N163の順にチップ単位で収め、ノイズは最初の1本だけ2A03ノイズ(D)。
   * @returns {Object<string,string>} sourceId → targetType
   */
  MML.VGM2MML.defaultPlan = function (h) {
    const plan = {};
    const src = MML.VGM2MML.sourceChannels(h);
    const used = { fme7: 0, n163: 0, vrc7: 0, noise: 0 };
    const cap = { fme7: 3, n163: 8, vrc7: 6, noise: 1 };
    const take = (chip) => { const i = used[chip]++; return i; };
    for (const s of src.filter(s => s.kind === 'wave')) plan[s.id] = used.n163 < cap.n163 ? `n163_${take('n163')}` : 'skip';
    // FM(OPLL 2op / OPN 4op)はVRC7へ(6ch)。YM2612は6chでちょうど埋まる
    for (const s of src.filter(s => s.kind === 'fm' || s.kind === 'fm4')) plan[s.id] = used.vrc7 < cap.vrc7 ? `vrc7_${take('vrc7')}` : 'skip';
    for (const s of src.filter(s => s.kind === 'square' && s.chip === 'ay8910')) plan[s.id] = used.fme7 < cap.fme7 ? ['fme7a', 'fme7b', 'fme7c'][take('fme7')] : 'skip';
    // YM2610 ADPCM: B(1ch、Δ-Nで音階演奏されることが多い)はVRC7の空き→2A03パルスA、
    // A(6ch、音程サンプルは音程ごとに別サンプル)はN163の空きへ。ドラム等音程なしのサンプルは
    // 抽出段階で休符になるので、割り当てても音符が無ければ空チャンネルになるだけ
    for (const s of src.filter(s => s.kind === 'pcm' && s.id === 'pcmb:0')) plan[s.id] = used.vrc7 < cap.vrc7 ? `vrc7_${take('vrc7')}` : 'pulse1';
    for (const s of src.filter(s => s.kind === 'pcm' && s.id !== 'pcmb:0')) plan[s.id] = used.n163 < cap.n163 ? `n163_${take('n163')}` : 'skip';
    // SN76489: チップ単位でまとまって入る所へ
    const snChips = [...new Set(src.filter(s => s.chip === 'sn76489').map(s => s.chipIndex))];
    for (const k of snChips) {
      const tones = src.filter(s => s.chip === 'sn76489' && s.chipIndex === k && s.kind === 'square');
      let target = null;
      if (cap.fme7 - used.fme7 >= tones.length) target = 'fme7';
      else if (cap.n163 - used.n163 >= tones.length) target = 'n163';
      for (const s of tones) {
        if (target === 'fme7') plan[s.id] = ['fme7a', 'fme7b', 'fme7c'][take('fme7')];
        else if (target === 'n163') plan[s.id] = `n163_${take('n163')}`;
        else plan[s.id] = 'skip';
      }
      const noise = src.find(s => s.chip === 'sn76489' && s.chipIndex === k && s.kind === 'noise');
      if (noise) plan[noise.id] = used.noise < cap.noise ? (take('noise'), 'noise') : 'skip';
    }
    return plan;
  };

  // 表示用: "AY8910 → FME-7(X-Z)" のように割当をまとめる
  MML.VGM2MML.describePlan = function (h, plan) {
    const src = MML.VGM2MML.sourceChannels(h);
    const groups = new Map();
    for (const s of src) {
      const t = plan[s.id] || 'skip';
      const tt = TARGET_TYPES[t] || TARGET_TYPES.skip;
      const key = s.label.replace(/ ch\d+$| noise$/, '').replace(/ (FM|ADPCM-A)\d+$/, ' $1') + (s.kind === 'noise' ? ' noise' : '');
      const dst = t === 'skip' ? null : (tt.chip === '2a03' ? `2A03 ${tt.letter}` : tt.chip.toUpperCase().replace('FME7', 'FME-7'));
      if (!groups.has(key)) groups.set(key, new Set());
      if (dst) groups.get(key).add(dst);
    }
    return Array.from(groups.entries()).map(([k, v]) => `${k} → ${v.size ? Array.from(v).join('/') : '(skip)'}`);
  };

  // 借用先ファミリごとの生周期換算(detune/EP用、丸めない)
  const pulsePeriodRaw = freq => CPU_CLOCK_NTSC / (16 * freq) - 1;   // 2A03/MMC5パルス
  const triPeriodRaw = freq => CPU_CLOCK_NTSC / (32 * freq) - 1;     // 2A03三角波
  const vrc6PulsePeriodRaw = freq => CPU_CLOCK_NTSC / (16 * freq) - 1;
  const LIN_TABLE = { ay8910: logToLinearTable(1.5), sn76489: logToLinearTable(2) };
  // 4bit対数音量 → VRC7の減衰値(v0=最大、3dB/段)。AY/SN の音量エンベロープ表(envReg経由)と定数音量の両方に使う
  function logToVrc7Table(dbPerStep) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = Math.max(0, Math.min(15, Math.round((15 - v) * dbPerStep / 3)));
    return t;
  }
  const VRC7_TABLE = { ay8910: logToVrc7Table(1.5), sn76489: logToVrc7Table(2) };

  // ---------------------------------------------------------------------------
  // PSG系(AY/SCC/OPLL/SN76489)の合成変換。plan(sourceId→targetType)は options.channelMap が
  // あればそれ、無ければ defaultPlan(構成駆動の自動割当)。
  // ---------------------------------------------------------------------------
  function composePsgLike(data, h, label, options, ignoredNote) {
    const frameRate = data.frameRate;
    const totalFrames = data.totalFrames;
    const c = h.chips;
    const src = MML.VGM2MML.sourceChannels(h);
    const plan = Object.assign({}, MML.VGM2MML.defaultPlan(h), options.channelMap || {});

    const envReg = new MML.Convert.EnvelopeRegistry();
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry();
    const n163WaveReg = new MML.Convert.WaveRegistry('@N', v => [0, ...v]);
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');
    const notes = ignoredNote ? [ignoredNote] : [];
    if (c.ay8910 && c.ay8910.dual) notes.push('2個目のAY8910(デュアルチップ)は変換対象外のため無視しました。');

    // 借用先ファミリに応じた音量写像プロキシ(対数DAC元→線形先のときだけ写像)
    const familyOf = t => (TARGET_TYPES[t] || TARGET_TYPES.skip).family || null;
    const needsLinear = fam => fam === 'n163' || fam === 'pulse' || fam === 'vrc6pulse';
    const regFor = (chip, fam) => (needsLinear(fam) && LIN_TABLE[chip]) ? mappedEnvReg(envReg, LIN_TABLE[chip])
      : (fam === 'vrc7' && VRC7_TABLE[chip]) ? mappedEnvReg(envReg, VRC7_TABLE[chip]) : envReg;

    // ── 抽出(ソースチップごと。同じチップ内でも借用先ファミリが違えば音量写像が違うので、
    //    ファミリごとに抽出し直して該当chだけ採る) ──
    // YM2610内蔵SSGの実クロックはチップクロック/4(ymfm裏取り)。AY抽出器はZ80(=AY実クロック×2)前提なので/2
    const kssClock = c.ay8910 ? c.ay8910.clock * 2 : c.ym2610 ? c.ym2610.clock / 2 : c.k051649 ? c.k051649.clock * 2 : (c.ym2413 ? c.ym2413.clock : 3579545);
    const hasAySource = !!(c.ay8910 || c.ym2610);
    const extracted = {}; // sourceId → channel(events+flags)
    function extractGroup(chipKey, extractFn) {
      const items = src.filter(s => s.chip === chipKey && s.kind !== 'noise' && plan[s.id] !== 'skip');
      const fams = [...new Set(items.map(s => familyOf(plan[s.id])))];
      for (const fam of fams) {
        const res = extractFn(regFor(chipKey, fam), fam);
        for (const s of items) if (familyOf(plan[s.id]) === fam) extracted[s.id] = res[s.ch];
      }
    }
    if (data.kss && data.kss.ay && hasAySource) {
      extractGroup('ay8910', (reg) => MML.Kss2MmlExpansion.ay(data.kss.writeLog, totalFrames, kssClock, reg).channels);
    }
    let sccResult = null, sccUsed = false;
    if (data.kss && data.kss.scc && c.k051649) {
      sccResult = MML.Kss2MmlExpansion.scc(data.kss.writeLog, totalFrames, kssClock, n163WaveReg, envReg);
      sccUsed = sccResult.channels.some(ch => ch.events.some(ev => ev.note !== null));
      if (sccUsed) for (const s of src) if (s.chip === 'k051649' && plan[s.id] !== 'skip') extracted[s.id] = sccResult.channels[s.ch];
    }
    if (data.kss && data.kss.opll && c.ym2413) {
      const r = MML.Kss2MmlExpansion.opll(data.kss.writeLog, totalFrames, vrc7ToneReg);
      for (const s of src) if (s.chip === 'ym2413' && plan[s.id] !== 'skip') extracted[s.id] = r.channels[s.ch];
    }
    // OPN系FM(YM2612/YM2610)と YM2610 ADPCM: イベントは借用先非依存(attDb)なので1回抽出して全部に使う
    if (data.ym2612 && c.ym2612) {
      const r = MML.Vgm2MmlExpansion.opn(data.ym2612.snapshots, 6);
      for (const s of src) if (s.chip === 'ym2612' && plan[s.id] !== 'skip') extracted[s.id] = r.channels[s.ch];
    }
    if (data.ym2610fm && c.ym2610) {
      const nFm = c.ym2610.ym2610b ? 6 : 4;
      const r = MML.Vgm2MmlExpansion.opn(data.ym2610fm.snapshots, nFm);
      for (const s of src) if (s.chip === 'ym2610' && plan[s.id] !== 'skip') extracted[s.id] = r.channels[s.ch];
      const ad = MML.Vgm2MmlExpansion.adpcm(data.ym2610fm.snapshots);
      for (const s of src) if (s.chip === 'ym2610adpcm' && plan[s.id] !== 'skip') extracted[s.id] = s.ch === 6 ? ad.b : ad.a[s.ch];
    }
    const vrc7InstOf = (s) => {
      const v = options.vrc7Inst && options.vrc7Inst[s.id];
      return v !== undefined && v !== null && v !== '' ? String(v) : MML.VGM2MML.defaultVrc7Inst(s.kind);
    };
    if (data.sn && c.sn76489) {
      const nChips = c.sn76489.dual ? 2 : 1;
      for (let k = 0; k < nChips; k++) {
        const items = src.filter(s => s.chip === 'sn76489' && s.chipIndex === k && plan[s.id] !== 'skip');
        const fams = [...new Set(items.filter(s => s.kind !== 'noise').map(s => familyOf(plan[s.id])))];
        let noiseDone = false;
        for (const fam of fams.length ? fams : [null]) {
          const r = MML.Vgm2MmlExpansion.sn76489(data.sn.snapshots, data.sn.clock, regFor('sn76489', fam), k);
          for (const s of items) {
            if (s.kind === 'noise') { if (!noiseDone) { extracted[s.id] = r.noise; noiseDone = true; } }
            else if (familyOf(plan[s.id]) === fam) extracted[s.id] = r.tones[s.ch];
          }
        }
      }
    }

    // ── 借用先ごとにイベントを整形して台帳へ ──
    // slotsByFamily: family → { index → {source, channel} }
    const placed = {}; // targetType → { source, channel }
    const conflicts = [];
    for (const s of src) {
      const t = plan[s.id];
      if (!t || t === 'skip' || !extracted[s.id]) continue;
      if (placed[t]) { conflicts.push(`${s.label} は ${t} が既に ${placed[t].source.label} に使われているため変換対象外です。`); continue; }
      const tt = TARGET_TYPES[t];
      if (!tt) continue;
      // 種別と借用先の相性(UI外から不正な組合せが来た時の防御)
      if ((s.kind === 'noise') !== (tt.family === 'noise')) { conflicts.push(`${s.label} → ${t} は種別が合わないため変換対象外です。`); continue; }
      if (s.kind === 'wave' && tt.family !== 'n163' && tt.family !== 'vrc7') { conflicts.push(`${s.label} → ${t} は波形音源/VRC7以外へ載せられないため変換対象外です。`); continue; }
      const ch = Object.assign({}, extracted[s.id], { events: extracted[s.id].events.map(ev => Object.assign({}, ev)) });
      adaptEvents(ch, s, tt.family, n163WaveReg, tt.family === 'vrc7' ? vrc7InstOf(s) : null);
      placed[t] = { source: s, channel: ch };
    }
    notes.push(...conflicts);

    // 借用先ファミリごとの後処理(音程補正・EN・EP)
    const byFamily = {};
    for (const [t, p] of Object.entries(placed)) { const f = TARGET_TYPES[t].family; (byFamily[f] = byFamily[f] || []).push({ type: t, ...p }); }
    const expansions = [];
    for (const t of Object.keys(placed)) { const chip = TARGET_TYPES[t].chip; if (chip !== '2a03' && !expansions.includes(chip)) expansions.push(chip); }
    const prio = MML.Mml.EXPANSION_PRIORITY || ['fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
    expansions.sort((a, b) => prio.indexOf(a) - prio.indexOf(b));
    const letterMap = expansions.length ? MML.Mml.assignExpansionLetters(expansions) : {};
    // N163のnumChはcompiler.js側の自動検出(音符を持つ最上位レター位置+1)と一致させる
    let n163NumCh = 1;
    for (const p of (byFamily.n163 || [])) if (p.channel.events.some(ev => ev.note !== null)) n163NumCh = Math.max(n163NumCh, TARGET_TYPES[p.type].index + 1);
    const periodFnFor = {
      fme7: fme7PeriodRaw, n163: n163FreqRegRaw(N163_WAVE_LEN, n163NumCh), pulse: pulsePeriodRaw,
      triangle: triPeriodRaw, vrc6pulse: vrc6PulsePeriodRaw, vrc7: vrc7FnumRaw, noise: null
    };
    const scoreChannels = [];
    for (const [fam, list] of Object.entries(byFamily)) {
      const chans = list.map(p => p.channel);
      const fn = periodFnFor[fam];
      if (fn) {
        // 音程補正: kss2mml(PSG→FME-7)と同じ detectChorusDetune 方針。EN→EPの順序はkss2mml参照
        MML.Convert.detectChorusDetune(chans, fn);
        MML.Convert.assignNoteEnvelope(chans, noteEnvReg);
        if (fam !== 'vrc7') MML.Convert.assignPitchEnvelope(chans, fn, pitchReg);
      }
      for (const p of list) {
        const tt = TARGET_TYPES[p.type];
        const letter = tt.chip === '2a03' ? tt.letter : (letterMap[tt.chip] || [])[tt.index];
        if (!letter) continue;
        const flags = fam === 'vrc7' ? { hasDetune: true, hasNoteEnv: true } : fam === 'noise' ? {} : { hasDetune: true, hasPitchMod: true };
        scoreChannels.push(Object.assign({}, p.channel, { letter }, flags));
      }
    }
    // N163: 途中の空きレターも空チャンネルとして出す(numCh検出をcompiler.jsと揃えるため)
    if (letterMap.n163) {
      const have = new Set(scoreChannels.map(ch => ch.letter));
      for (let i = 0; i < n163NumCh; i++) if (!have.has(letterMap.n163[i])) scoreChannels.push({ letter: letterMap.n163[i], events: [], hasVolume: true, hasInstrument: true });
    }
    scoreChannels.sort((a, b) => a.letter.localeCompare(b.letter));

    // ── テンポ・出力 ──
    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      for (const ev of sounding) noteDurations.push(ev.end - ev.start);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    const fpb = frameRate * 60 / Math.round(bpm); // t<n>整数丸めと揃える([[tempo-rounding-drift-future-issue]])

    const assignments = MML.VGM2MML.describePlan(h, plan);
    const chipList = h.usedChips.map(ch => ch.name + (ch.dual ? ' x2' : '')).join(', ');
    const chanDesc = Object.entries(placed).map(([t, p]) => {
      const tt = TARGET_TYPES[t];
      const letter = tt.chip === '2a03' ? tt.letter : (letterMap[tt.chip] || [])[tt.index];
      // VRC7へ載せたチャンネルは使ったプリセット音色も併記(OPLL元音色そのままなら書かない)
      let inst = '';
      if (tt.chip === 'vrc7') { const v = vrc7InstOf(p.source); if (v !== 'auto') inst = `(@${v} ${VRC7_PRESET_NAMES[parseInt(v, 10)] || ''})`; }
      return `${letter}=${p.source.label}${inst}`;
    }).join(' ');
    const isCustom = !!options.channelMap && Object.keys(options.channelMap).some(k => options.channelMap[k] !== MML.VGM2MML.defaultPlan(h)[k]);

    const headerComment = [
      `; =========================================================`,
      `; VGM → MML 変換 (${chipList})`,
      `; 曲名     : ${label || '-'}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: ${chanDesc}`,
      `; 借用先の割当(${isCustom ? 'ユーザー指定' : '構成から自動'}): ${assignments.join(', ') || '-'}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、AY8910→FME-7(互換)、YM2413→VRC7(同一)、`,
      `;    SCC→N163(波形近似)、SN76489等の矩形波はFME-7の空き→N163(矩形波@N)の順に、ノイズは`,
      `;    2A03ノイズ(D)へ載せています(割当はVGMパネルの「チャンネル割当」で変更できます)。`,
      `;    YM2612/YM2610のFMはVRC7へ(4op→2op、音色はプリセットから選択。音程・TL由来の音量のみ再現)、`,
      `;    YM2610 ADPCM-A/Bはサンプルのピッチ解析で得た音程と音量だけを載せています。`,
      `;    線形音量の借用先(N163/2A03/MMC5/VRC6)へ載せた音量は対数DAC→線形へ換算した値です。`,
      ...notes.map(n => `; ※ ${n}`),
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = expansions.map(chip => chip === 'n163'
      ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${(letterMap.n163 || []).length}`
      : MML.Mml.EX_CHIP_DIRECTIVE[chip]);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [
        ...directiveLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(expansions.includes('n163') ? n163WaveReg.defLines() : []),
        ...(expansions.includes('vrc7') ? vrc7ToneReg.defLines() : [])
      ]
    });
    return {
      mml: [headerComment, scoreText].join('\n'),
      bpm: Math.round(bpm),
      chips: h.usedChips.filter(ch => ['ay8910', 'k051649', 'ym2413', 'sn76489', 'ym2612', 'ym2610'].includes(ch.id)).map(ch => ch.name + (ch.dual ? ' x2' : '')),
      expansions,
      assignments,
      plan,
      n163Wave: sccUsed && sccResult ? sccResult.n163Wave : (expansions.includes('n163') ? N163_SQUARE_WAVE : null)
    };
  }

  // 音量の減衰量(dB)→借用先の音量値。VRC7は「v0が最大・v15が最小」(このコンパイラ/ppmckのVRC7は
  // レジスタの減衰値をそのまま v に取る)、FME-7は v15 最大の3dB/段、線形音源は振幅比。
  const VOL_FROM_DB = {
    vrc7: att => Math.max(0, Math.min(15, Math.round(att / 3))),
    fme7: att => Math.max(0, Math.min(15, 15 - Math.round(att / 3))),
    linear: att => (att >= 60 ? 0 : Math.max(1, Math.min(15, Math.round(15 * Math.pow(10, -att / 20)))))
  };
  // 4bit対数音量(AY=1.5dB/段(このコードベースの既定)、SN=2dB/段、OPLL/VRC7=3dB/段・反転)→減衰dB
  function sourceAttDb(s, ev) {
    if (ev.attDb !== undefined) return ev.attDb;
    if (ev.volume === undefined) return 0;
    if (s.chip === 'ym2413') return ev.volume * 3;
    const step = s.chip === 'sn76489' ? 2 : 1.5;
    return (15 - Math.max(0, Math.min(15, ev.volume))) * step;
  }

  // ソースチャンネルのイベントを借用先ファミリの語彙へ整形する(破壊的。呼び出し側でコピー済み)。
  // vrc7Inst: 借用先がVRC7のときの音色('auto'=OPLLソースの元音色/カスタム音色をそのまま、'1'-'15'=プリセット)
  function adaptEvents(ch, s, fam, n163WaveReg, vrc7Inst) {
    const events = ch.events;
    const isAy = s.chip === 'ay8910';
    const nativeVrc7 = s.kind === 'fm' && fam === 'vrc7' && (vrc7Inst === 'auto' || vrc7Inst == null);
    const nativeFme7 = s.kind === 'square' && fam === 'fme7';
    if (nativeVrc7 || nativeFme7 || fam === 'noise') return; // そのまま
    // AYのミキサー: ノイズ単独(mode 2)は矩形波系の借用先では鳴らせないので休符に、
    // トーン+ノイズ(mode 3)はトーンだけ残す。FME-7以外ではN<n>も出さない
    for (const ev of events) {
      if (isAy && ev.instrument === 2) { ev.note = null; }
      delete ev.fme7Noise;
    }
    ch.hasFme7Noise = false;
    // 音量: 借用先の尺度へ。AY/SN→線形は従来どおり LIN_TABLE(エンベロープ表も同じ表で写像済み)、
    // それ以外(attDbを持つOPN/ADPCM、OPLL→非VRC7、AY/SN→VRC7/FME-7以外の対数)は減衰dB経由
    const linearFam = fam === 'n163' || fam === 'pulse' || fam === 'vrc6pulse';
    if (linearFam && LIN_TABLE[s.chip] && s.kind === 'square') {
      mapConstVolumes(events, LIN_TABLE[s.chip]);
    } else if (fam === 'vrc7' && VRC7_TABLE[s.chip] && s.kind === 'square') {
      mapConstVolumes(events, VRC7_TABLE[s.chip]); // エンベロープ表は regFor(…,'vrc7') で同じ表に写像済み
    } else if (fam !== 'triangle') {
      const conv = fam === 'vrc7' ? VOL_FROM_DB.vrc7 : fam === 'fme7' ? VOL_FROM_DB.fme7 : VOL_FROM_DB.linear;
      for (const ev of events) if (ev.note !== null && (ev.attDb !== undefined || ev.volume !== undefined)) ev.volume = conv(sourceAttDb(s, ev));
    }
    for (const ev of events) delete ev.attDb;
    if (fam === 'vrc7') {
      // VRC7プリセット音色。OPLLソースの元音色/カスタム音色は捨てる
      const inst = Math.max(1, Math.min(15, parseInt(vrc7Inst, 10) || 1));
      for (const ev of events) { if (ev.note !== null) ev.instrument = inst; delete ev.vrc7Tone; delete ev.n163Wave; }
      ch.hasVrc7Tone = false; ch.hasInstrument = true;
    } else if (fam === 'n163') {
      // ADPCM(サンプル1周期の波形あり)はその波形を、他は矩形波を @N に登録して音色にする
      for (const ev of events) {
        if (ev.note === null) { delete ev.n163Wave; continue; }
        const wave = (ev.n163Wave && ev.n163Wave.length === N163_WAVE_LEN) ? ev.n163Wave : N163_SQUARE_WAVE;
        ev.instrument = n163WaveReg.assign(wave); ev.rawLength = N163_WAVE_LEN;
        delete ev.n163Wave; delete ev.vrc7Tone;
      }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'pulse') {
      // 2A03/MMC5パルス: @2=デューティ50%(矩形波)
      for (const ev of events) { if (ev.note !== null) ev.instrument = 2; delete ev.n163Wave; delete ev.vrc7Tone; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'vrc6pulse') {
      // VRC6パルス: @7=デューティ50%(8/16)
      for (const ev of events) { if (ev.note !== null) ev.instrument = 7; delete ev.n163Wave; delete ev.vrc7Tone; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'fme7') {
      // FME-7: @1=トーンのみ
      for (const ev of events) { if (ev.note !== null) ev.instrument = 1; delete ev.n163Wave; delete ev.vrc7Tone; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'triangle') {
      // 三角波: 音量・音色は無い。音程だけ
      for (const ev of events) { delete ev.volume; delete ev.envelopeV; delete ev.envelopeVr; delete ev.instrument; delete ev.n163Wave; delete ev.vrc7Tone; }
      ch.hasVolume = false; ch.hasEnvelope = false; ch.hasInstrument = false; ch.hasVrc7Tone = false;
    }
  }

  /**
   * @param {Uint8Array} vgmBytes - 解凍済みVGM
   * @param {number} durationSeconds
   * @param {object} [options] - { bpm }
   */
  MML.VGM2MML.fromVgm = async function (vgmBytes, durationSeconds, options) {
    options = options || {};
    const data = await MML.Emu.captureVgmSongAsync(vgmBytes, { durationSeconds: durationSeconds || 60 });
    const h = data.header;
    const title = gd3Field(h, 'trackEn', 'trackJa');
    const game = gd3Field(h, 'gameEn', 'gameJa');
    const author = gd3Field(h, 'authorEn', 'authorJa');
    const label = [game, title].filter(Boolean).join(' - ') || 'VGM';

    // 変換ファミリ: PSG系(AY/SCC/OPLL/SN、同居可) / NES / GB / HES。複数同居していれば先頭だけ。
    const families = [];
    if (data.kss || data.sn || data.ym2612 || data.ym2610fm) families.push('psg');
    if (data.nes) families.push('nes');
    if (data.gb) families.push('gb');
    if (data.hes) families.push('hes');
    if (families.length === 0) {
      const names = h.usedChips.map(ch => ch.name).join(', ') || '-';
      throw new Error(`MML変換に対応した音源がありません(${names})`);
    }
    const family = families[0];
    const famOf = { ay8910: 'psg', k051649: 'psg', ym2413: 'psg', sn76489: 'psg', ym2610: 'psg', ym2612: 'psg', nes: 'nes', gb: 'gb', huc6280: 'hes' };
    const ignoredChips = h.usedChips.filter(ch => !ch.impl || famOf[ch.id] !== family).map(ch => ch.name);
    const ignoredNotes = [];
    if (ignoredChips.length) ignoredNotes.push(`このVGMは複数の音源を含みます。${ignoredChips.join(', ')} はMML変換の対象外のため無視しました。`);
    // YM2612 ch6 DAC(PCMストリーム)は音程情報が無いので対象外
    if (h.chips.ym2612 && family === 'psg') ignoredNotes.push('YM2612 の ch6 DAC(PCM)は変換対象外です。');
    if (h.chips.ym2610 && family === 'psg') ignoredNotes.push('YM2610 ADPCM-A/B はサンプルのピッチ解析で音程が取れた区間だけ音符にしています(ドラム等の音程なしサンプルは休符)。');
    const ignoredNote = ignoredNotes.length ? ignoredNotes.join(' ') : null;

    let result;
    if (family === 'psg') {
      result = composePsgLike(data, h, label, options, ignoredNote);
    } else if (family === 'nes') {
      const header = {
        extraChips: data.nes.fds ? MML.NSF.CHIP_FLAGS.FDS : 0,
        songName: label, artist: author, copyright: '', totalSongs: 1
      };
      // $4015を一度も書かないVGMでもチャンネルが有効扱いになるよう既定値を補う
      const initRegs = { 0x4015: 0x0F };
      result = MML.NSF2MML.convert(data.nes.writeLog, null, header, 0, initRegs, null, options);
      result.chips = ['2A03'].concat(data.nes.fds ? ['FDS'] : []);
    } else if (family === 'gb') {
      result = MML.GBS2MML.convertCapture({
        snapshots: data.gb.snapshots, frameRate: data.frameRate, songLabel: label, sourceLabel: 'VGM'
      }, options);
    } else if (family === 'hes') {
      result = MML.HES2MML.convertCapture({
        snapshots: data.hes.snapshots, dpcmTrace: [], controlTrace: [],
        frameRate: data.frameRate, trackLabel: label, sourceLabel: 'VGM'
      }, options);
    }
    if (ignoredNote && family !== 'psg') {
      // 委譲先のヘッダコメントの直後に「無視した音源」の注記を差し込む
      result.mml = result.mml.replace(/\n(; =+\n)\n/, `\n; ※ ${ignoredNote}\n$1\n`);
    }
    result.family = family;
    result.ignoredChips = ignoredChips;
    return result;
  };
})(window);
