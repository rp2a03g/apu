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
 * チップ単位。ノイズは最初の1本だけ2A03ノイズD)。ユーザーは鍵盤表示のチャンネル割当(part列チップ/「借用先」列)で
 * ソースchごとに借用先(共通語彙 src/convert/channelPlan.js: A/B/C/D、FME-7、N163、MMC5、VRC6…)を
 * 変えられ(例: FME-7が高音で辛いchを2A03へ)、options.channelMap として渡る。借用先ファミリ
 * ごとにイベントを整形(adaptEvents: 矩形波/デューティ/音量の対数→線形換算/三角波は音程のみ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.VGM2MML = {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。MML.I18n が無い環境(ヘッドレス等)では素通し
  const tr = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/{(w+)}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const CPU_CLOCK_NTSC = 1789773; // 借用先(FME-7/N163/2A03)のクロック。src/mml/compiler.jsと同じ値
  const N163_WAVE_LEN = 32;       // N163へ載せる矩形波の長さ(SCC近似と同じ32点で統一)
  // N163用の矩形波(50%デューティ、4bit)。@N<n>として登録し、矩形波チップの音色に使う
  const N163_SQUARE_WAVE = Array.from({ length: N163_WAVE_LEN }, (_, i) => (i < N163_WAVE_LEN / 2 ? 15 : 0));

  // FME-7: freq = CLOCK/(32*period)。kss2mml/converter.jsのfme7PeriodRawと同じ(丸めない)。
  function fme7PeriodRaw(freq) { return CPU_CLOCK_NTSC / (32 * freq); }
  // N163: freqReg = freq*15*65536*waveLen*numCh/CLOCK(kss2mml/converter.jsのn163FreqRegRawと同じ)。
  function n163FreqRegRaw(waveLen, numCh) { return freq => freq * 15 * 65536 * waveLen * numCh / CPU_CLOCK_NTSC; }
  // VRC7: src/convert/borrow.js に集約(block は音符の理論値側で固定、2026-09-07)
  function vrc7FnumRaw(freq, ev) { return MML.Convert.Borrow.vrc7FnumRaw(freq, ev); }

  // 対数DAC(dbPerStep/段)の4bit音量値を、借用先の音量レンジ(既定0-15)へ換算する表
  function logToLinearTable(dbPerStep, max) {
    const m = max == null ? 15 : max;
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = v === 0 ? 0 : Math.max(1, Math.min(m, Math.round(m * Math.pow(10, -dbPerStep * (15 - v) / 20))));
    return t;
  }
  // 借用先ファミリの音量レンジ(src/convert/borrow.js FAMILY_VOL_MAX が正典。読み込み順の都合で遅延参照)
  function famVolMax(fam) {
    const T = MML.Convert.Borrow && MML.Convert.Borrow.FAMILY_VOL_MAX;
    const m = T && T[fam];
    return m == null ? 15 : m;
  }
  // 対数DACのチップ → 1段あたりのdB。LIN_TABLE/VRC7_TABLE と同じ顔ぶれ
  const LIN_STEP = { ay8910: 1.5, sn76489: 2 };
  const linTableCache = new Map();
  // ★借用先ごとにレンジが違う(FDS=32/VRC6のこぎり=42)ので、表も借用先ごとに作る。
  //   以前は 0-15 の LIN_TABLE 固定で、@v(エンベロープ表)と v(定数音量)で尺度が食い違っていた
  function linTable(chip, fam) {
    const step = LIN_STEP[chip];
    if (!step) return null;
    const max = famVolMax(fam);
    const key = chip + '/' + max;
    if (!linTableCache.has(key)) linTableCache.set(key, logToLinearTable(step, max));
    return linTableCache.get(key);
  }
  // 対数DACの段数が分かっていないチップ(SCC等)向け: 生の0-15を借用先レンジへ比例配分するだけの表。
  // ★対数か線形かの解釈は変えない(SCCの音量レジスタが線形か対数かは未確定で、v側の
  //   sourceAttDb は既定1.5dB/段として扱っている)。ここで揃えるのは「天井」だけ:
  //   これが無いと FDS/VRC6のこぎりへ載せたとき @v の上限が15のまま v だけ32/42になり、
  //   同じチャンネルの中でエンベロープ付きの音だけ極端に小さくなる(2026-09-11)。
  //   max が 15 の借用先では恒等写像なので、既定割当(N163等)の出力は変わらない。
  function rangeTable(max) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = v === 0 ? 0 : Math.max(1, Math.min(max, Math.round(v * max / 15)));
    return t;
  }
  const rangeTableCache = new Map();
  function envTable(chip, fam) {
    const t = linTable(chip, fam);
    if (t) return t;
    const max = famVolMax(fam);
    if (max === 15) return null; // 恒等写像なので素通りでよい
    if (!rangeTableCache.has(max)) rangeTableCache.set(max, rangeTable(max));
    return rangeTableCache.get(max);
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
  // 借用先タイプ(共通語彙。src/convert/channelPlan.js の TARGETS と同じ)とチャンネル割当計画
  // ---------------------------------------------------------------------------
  // type → { chip(拡張音源名|null=2A03), index(チップ内ch番号), letter(2A03のみ固定) }
  const TARGET_TYPES = {
    skip:       { chip: null },
    pulse1:     { chip: '2a03', letter: 'A', family: 'pulse' },
    pulse2:     { chip: '2a03', letter: 'B', family: 'pulse' },
    triangle:   { chip: '2a03', letter: 'C', family: 'triangle' },
    noise:      { chip: '2a03', letter: 'D', family: 'noise' },
    // DPCM: サンプルPCMの打楽器を実サンプルのままDMCへ変換して載せる先(Eパート固定)。
    // 他の借用先と違い「1ch へ複数のソースchをまとめて載せる」ので、placed の重複判定や
    // adaptEvents の対象にはしない(dpcmDrums が事前に1本へ合成し終えている)
    dpcm:       { chip: '2a03', letter: 'E', family: 'dpcm' },
    fme7a:      { chip: 'fme7', index: 0, family: 'fme7' },
    fme7b:      { chip: 'fme7', index: 1, family: 'fme7' },
    fme7c:      { chip: 'fme7', index: 2, family: 'fme7' },
    mmc5pulse1: { chip: 'mmc5', index: 0, family: 'pulse' },
    mmc5pulse2: { chip: 'mmc5', index: 1, family: 'pulse' },
    vrc6pulse1: { chip: 'vrc6', index: 0, family: 'vrc6pulse' },
    vrc6pulse2: { chip: 'vrc6', index: 1, family: 'vrc6pulse' },
    // ★UI(src/convert/channelPlan.js TARGET_LIST)が出す借用先はここにも必ず載せること。
    //   無いと describePlan の tt.chip が null になり「Cannot read properties of null (reading 'toUpperCase')」
    //   で変換全体が落ちる(VRC6のこぎり波を選んで実際に起きた)
    vrc6saw:    { chip: 'vrc6', index: 2, family: 'vrc6saw' },
    fds:        { chip: 'fds',  index: 0, family: 'fds' },
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
  const VRC7_PRESET_NAMES = MML.Convert.Vrc7Tone.PRESET_NAMES;
  MML.VGM2MML.VRC7_PRESET_NAMES = VRC7_PRESET_NAMES;
  const presetListOf = MML.Convert.Vrc7Tone.presetListOf;
  MML.VGM2MML.vrc7InstOptions = function (kind) {
    const list = [];
    if (kind === 'fm') list.push({ value: 'auto', label: '元の音色' });
    // OPN 4op FM → '0'=自作音色(@OP、4op→2opの自動変換。opnToOpllBytes 参照)
    if (kind === 'fm4') list.push({ value: '0', label: '@0 自作音色(4op→2op自動変換)' });
    for (let i = 1; i <= 15; i++) list.push({ value: String(i), label: `@${i} ${VRC7_PRESET_NAMES[i]}` });
    return list;
  };
  MML.VGM2MML.defaultVrc7Inst = function (kind) { return kind === 'fm' ? 'auto' : kind === 'fm4' ? '0' : '1'; };

  // OPN(YM2612/YM2610)の4op音色 → OPLL/VRC7 の2op自作音色(レジスタ8バイト)。近似変換:
  //  - キャリア = アルゴリズムの最終段(キャリア)のうちTLが最小(いちばん鳴っている)op、
  //    モジュレータ = そのキャリアを直接変調するop(複数ならTL最小、無ければ無音のモジュレータ=TL63)。
  //  - ML: そのまま(両者とも0=½,1-15)。DT: OPLLに無いので捨てる。
  //  - TL(モジュレータ): 0.75dB/段どうし、6bitへ飽和(min(63,TL))。キャリアTLは音量(v)側で表現済みなので0。
  //  - AR/DR: 5bit→4bit。★単純な >>1 ではなく (r-3)>>1(opnRateToOpll。実測でオフセットが
  //    1.5段ずれており、>>1だと約4倍速い減衰になる)。SL: 3dB/段どうしでそのまま。
  //  - SR(D2R): OPLLには持続レートが無い → SR==0 なら EG=1(SLで持続、RR=OPNのRR=離鍵レート)、
  //    SR>0 なら EG=0(減衰音。SL到達後はRRで減衰し続けるので **RR:=SR>>1**。EG=0のキーオフは
  //    固定レート7なのでOPNのRRは表現できず捨てる)。★ここを max(RR,SR>>1) にすると、離鍵を
  //    速くするためRR=15にしてあるだけの普通の音色が「鳴った瞬間に消える」音になる(2026-09-05修正)。
  //  - KS(0-3)→KR(1bit): KS>=2 なら1。KL: OPNに無いので0。AM: op.AM かつ AMS>0。VB: PMS>0 なら両op。
  //  - FB: OPNではop1の自己帰還なので、モジュレータにop1を選んだときだけ引き継ぐ。波形(DC/DM): OPNは
  //    正弦のみなので0。SSG-EG: 表現できないので無視。
  // OPNの5bitレート(AR/DR/SR、0-31) → OPLLの4bitレート(0-15)。
  // ★単純な >>1 は誤り(2026-09-05修正)。傾きは合っている(OPNは+2で倍速、OPLLは+1で倍速)が
  //   オフセットが約1.5段ぶんずれており、>>1 だと**約4倍速い**減衰になる。
  //   両エミュレータで同じ「AR最速・SL=0・持続減衰レートR」を実際に鳴らして -20dB 到達時間を
  //   突き合わせた実測(2026-09-05):
  //     OPN DR/SR:  6→4120ms  8→2060ms 10→1030ms 12→520ms 14→260ms 16→140ms 20→40ms
  //     OPLL DR/RR: 1→5770ms  2→2890ms  3→1440ms  4→730ms  5→360ms  6→190ms  8→20ms
  //   → 一致するのは OPLL = OPN/2 - 1.5、整数へは切り捨て(= (r-3)>>1)。
  //   切り捨て(遅い側)に寄せるのは、速すぎると音が消えてしまい「鳴っていない」ことになるため。
  //   これを >>1 にしていたせいで、4op→2op変換した音色はアタックだけ鳴って即消えていた
  //   (実測: Virtua Racing Deluxe「Replay」のFM1が、同じ譜面のプリセット再生に対しRMSで1/2)。
  const opnRateToOpll = (r) => Math.max(0, Math.min(15, ((r | 0) - 3) >> 1));

  const OPN_MODULATORS = [ // アルゴリズムごとの「op i を直接変調するop」(論理op index)
    { 3: [2] }, { 3: [2] }, { 3: [0, 2] }, { 3: [1, 2] }, { 1: [0], 3: [2] }, { 1: [0], 2: [0], 3: [0] }, { 1: [0] }, {}
  ];
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  function opnToOpllBytes(p) {
    if (!p || !p.ops) return null;
    const alg = p.AL & 7;
    let car = OPN_CARRIERS[alg][0];
    for (const i of OPN_CARRIERS[alg]) if (p.ops[i].TL < p.ops[car].TL) car = i;
    const mods = (OPN_MODULATORS[alg][car] || []);
    let mod = mods.length ? mods[0] : -1;
    for (const i of mods) if (p.ops[i].TL < p.ops[mod].TL) mod = i;
    const C = p.ops[car];
    const M = mod >= 0 ? p.ops[mod] : { TL: 127, ML: 1, AR: 31, DR: 0, SR: 0, SL: 0, RR: 15, KS: 0, AM: 0 };
    const conv = (o) => {
      // ★EG=0(減衰音)のときのRRは「キーオン中の持続減衰レート」であって離鍵時の速さではない
      //   (src/emulator/expansion/vrc7.js updateEG: SUSTINE=RR、RELEASEはEG=0なら固定レート7)。
      //   ここに従来 max(RR, SR>>1) を入れていたため、離鍵を速くするつもりでRR=15にしてある
      //   ごく普通のOPN音色が「鳴った瞬間に消える」音になっていた(実測: Virtua Racing Deluxeの
      //   ロングトーンがピーク0.007=ほぼ無音)。EG=0ならOPNのD2R(SR)だけを写し、
      //   表現できないOPNのRRは捨てる。EG=1(持続音)のRRは離鍵レートとしてそのまま使える。
      const eg = o.SR === 0 ? 1 : 0;
      // EG=1(持続音)のRRは離鍵レート=OPNのRRをそのまま(どちらも4bit)。
      // EG=0(減衰音)のRRはキーオン中の持続減衰レートなので、OPNのSR(5bit)をレート換算する
      const rr = eg ? (o.RR & 15) : opnRateToOpll(o.SR);
      return { AM: (o.AM && p.AMS > 0) ? 1 : 0, PM: p.PMS > 0 ? 1 : 0, EG: eg, KR: o.KS >= 2 ? 1 : 0, ML: o.ML & 15,
        AR: opnRateToOpll(o.AR), DR: opnRateToOpll(o.DR), SL: o.SL & 15, RR: rr };
    };
    const m = conv(M), c = conv(C);
    // FBはOPNではop1の自己帰還。選んだモジュレータがop1のときだけ引き継ぐ(他のopに帰還は無い)
    const mTL = Math.min(63, M.TL), fb = mod === 0 ? (p.FB & 7) : 0;
    return [
      (m.AM << 7) | (m.PM << 6) | (m.EG << 5) | (m.KR << 4) | m.ML,
      (c.AM << 7) | (c.PM << 6) | (c.EG << 5) | (c.KR << 4) | c.ML,
      mTL,                       // KL(mod)=0
      fb,                        // KL(car)=0, DC=DM=0
      (m.AR << 4) | m.DR,
      (c.AR << 4) | c.DR,
      (m.SL << 4) | m.RR,
      (c.SL << 4) | c.RR
    ];
  }
  MML.VGM2MML.opnToOpllBytes = opnToOpllBytes;

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
    // YM2203(OPN)/YM2608(OPNA)の内蔵SSGも同じAY経路(captureVgmSongAsyncがkss.writeLogへ流す)。
    if (c.ym2203 && !c.ay8910 && !c.ym2610) for (let i = 0; i < 3; i++) out.push({ id: `ay:${i}`, label: `YM2203 SSG ch${i + 1}`, kind: 'square', chip: 'ay8910', chipIndex: 0, ch: i });
    if (c.ym2608 && !c.ay8910 && !c.ym2610 && !c.ym2203) for (let i = 0; i < 3; i++) out.push({ id: `ay:${i}`, label: `YM2608 SSG ch${i + 1}`, kind: 'square', chip: 'ay8910', chipIndex: 0, ch: i });
    // 2個目のPSG(デュアルAY8910 / 2個目のYM2203・YM2608・YM2610の内蔵SSG): 抽出は kss2.writeLog から同じAY経路。
    // chipIndex 1 で1個目と区別する(extractGroup がchipIndexで振り分ける)。鍵盤の行は KP4-6
    {
      const ayChip = c.ay8910 ? ['AY8910', c.ay8910] : c.ym2610 ? ['YM2610 SSG', c.ym2610]
        : c.ym2203 ? ['YM2203 SSG', c.ym2203] : c.ym2608 ? ['YM2608 SSG', c.ym2608] : null;
      if (ayChip && ayChip[1].dual) for (let i = 0; i < 3; i++) out.push({ id: `ay2:${i}`, label: `${ayChip[0]}(2) ch${i + 1}`, kind: 'square', chip: 'ay8910', chipIndex: 1, ch: i });
    }
    if (c.k051649) for (let i = 0; i < 5; i++) out.push({ id: `scc:${i}`, label: `SCC ch${i + 1}`, kind: 'wave', chip: 'k051649', chipIndex: 0, ch: i });
    // YM2413はメロディ9ch(★2026-08-22に6→9へ。リズムモード曲は抽出側が6chしか返さないので
    // ch7-9は空チャンネルとして扱われる。src/kss2mml/expansion/opll.js 参照)
    if (c.ym2413) for (let i = 0; i < 9; i++) out.push({ id: `opll:${i}`, label: `YM2413 ch${i + 1}`, kind: 'fm', chip: 'ym2413', chipIndex: 0, ch: i });
    // OPL系(YM3812/YM3526/Y8950): 2op FM×9ch(リズムモード曲は抽出側が7-9chを空にする=OPLLと
    // 同じ)。音色はOPLLカスタム音色へ直接変換(kss2mml/expansion/opl.js)するのでkind 'fm'。
    // Y8950のADPCM-BはwriteLogからサンプルが見えないため変換対象外(ロール/鍵盤の表示のみ)。
    if (c.ym3812 || c.ym3526 || c.y8950) {
      const nm = c.ym3812 ? 'YM3812' : c.ym3526 ? 'YM3526' : 'Y8950';
      for (let i = 0; i < 9; i++) out.push({ id: `opl:${i}`, label: `${nm} FM${i + 1}`, kind: 'fm', chip: 'opl', chipIndex: 0, ch: i });
    }
    // OPN系FM: YM2612(6ch。ch6のDAC(PCMストリーム)は音程情報が無いので対象外)、YM2610(4ch、Bは6ch)。
    // YM2610 ADPCM-A/B はサンプルのピッチ解析(ym2610.js samplePitch)で音程が取れたものだけ音符になる。
    if (c.ym2612) for (let i = 0; i < 6; i++) out.push({ id: `opn:${i}`, label: `YM2612 FM${i + 1}`, kind: 'fm4', chip: 'ym2612', chipIndex: 0, ch: i });
    // YM2151(OPM): 4op FM×8ch。音色パラメータはOPN互換の形(decodeOpmPatch)で snapshot に
    // 入っているので抽出・4op→2op変換(opnToOpllBytes)はOPNと同じ経路。VRC7は6chなので
    // 既定割当では7ch目以降がskipになる(ユーザーが割当UIで他の借用先へ逃がせる)。
    if (c.ym2151) for (let i = 0; i < 8; i++) out.push({ id: `opm:${i}`, label: `YM2151 FM${i + 1}`, kind: 'fm4', chip: 'ym2151', chipIndex: 0, ch: i });
    // YM2203(OPN): 4op FM×3ch。抽出・4op→2op変換はYM2612と同じ経路(snapshotの形が同一)
    // デュアル(クロックbit30)は2個目のFM3chを ch3-5 として続ける(スナップショットは6ch連結。鍵盤のOP4-6行と同じ)
    if (c.ym2203) for (let i = 0; i < (c.ym2203.dual ? 6 : 3); i++) out.push({ id: `opn3:${i}`, label: `YM2203 FM${(i % 3) + 1}${i >= 3 ? '(2)' : ''}`, kind: 'fm4', chip: 'ym2203', chipIndex: i >= 3 ? 1 : 0, ch: i });
    // YM2608(OPNA): 4op FM×6ch+ADPCM-B。内蔵リズム(6ch)はドラムパート(DRUM_CHIPS)のみ
    // (音程ごとのサンプルではなく固定ドラム音のため、スロット単位の音符化はしない)
    if (c.ym2608) {
      for (let i = 0; i < 6; i++) out.push({ id: `opna:${i}`, label: `YM2608 FM${i + 1}`, kind: 'fm4', chip: 'ym2608', chipIndex: 0, ch: i });
      out.push({ id: 'pcmb8:0', label: 'YM2608 ADPCM-B', kind: 'pcm', chip: 'ym2608adpcm', chipIndex: 0, ch: 6 });
    }
    if (c.ym2610) {
      const nFm = c.ym2610.ym2610b ? 6 : 4;
      for (let i = 0; i < nFm; i++) out.push({ id: `opnb:${i}`, label: `YM2610 FM${i + 1}`, kind: 'fm4', chip: 'ym2610', chipIndex: 0, ch: i });
      for (let i = 0; i < 6; i++) out.push({ id: `pcma:${i}`, label: `YM2610 ADPCM-A${i + 1}`, kind: 'pcm', chip: 'ym2610adpcm', chipIndex: 0, ch: i });
      out.push({ id: 'pcmb:0', label: 'YM2610 ADPCM-B', kind: 'pcm', chip: 'ym2610adpcm', chipIndex: 0, ch: 6 });
    }
    // GA20(Irem PCM 4ch)/SegaPCM(16ch): レート(デルタ)レジスタで音階演奏するPCM。
    // ピッチ解析で音程が取れた区間だけ音符になる
    if (c.ga20) for (let i = 0; i < 4; i++) out.push({ id: `ga20:${i}`, label: `GA20 PCM${i + 1}`, kind: 'pcm', chip: 'ga20', chipIndex: 0, ch: i });
    if (c.k007232) for (let i = 0; i < 2; i++) out.push({ id: `k7:${i}`, label: `K007232 PCM${i + 1}`, kind: 'pcm', chip: 'k007232', chipIndex: 0, ch: i });
    if (c.segapcm) for (let i = 0; i < 16; i++) out.push({ id: `spcm:${i}`, label: `SegaPCM PCM${i + 1}`, kind: 'pcm', chip: 'segapcm', chipIndex: 0, ch: i });
    if (c.c140) for (let i = 0; i < 24; i++) out.push({ id: `c140:${i}`, label: `C140 PCM${i + 1}`, kind: 'pcm', chip: 'c140', chipIndex: 0, ch: i });
    if (c.c352) for (let i = 0; i < 32; i++) out.push({ id: `c352:${i}`, label: `C352 PCM${i + 1}`, kind: 'pcm', chip: 'c352', chipIndex: 0, ch: i });
    if (c.qsound) for (let i = 0; i < 16; i++) out.push({ id: `qs:${i}`, label: `QSound PCM${i + 1}`, kind: 'pcm', chip: 'qsound', chipIndex: 0, ch: i });
    if (c.okim6295) for (let i = 0; i < 4; i++) out.push({ id: `oki:${i}`, label: `OKIM6295 ADPCM${i + 1}`, kind: 'pcm', chip: 'okim6295', chipIndex: 0, ch: i });
    if (c.multipcm) for (let i = 0; i < 28; i++) out.push({ id: `mp:${i}`, label: `MultiPCM PCM${i + 1}`, kind: 'pcm', chip: 'multipcm', chipIndex: 0, ch: i });
    // PSF(PlayStation SPU)。VGM には現れない仮想チップで、src/psf2mml/converter.js が header.chips.psx を立てて使う
    // 合成chは実機の24ボイスより多い32本(Emu.POOL_CHIP_CHANNELS.psx)。実機スロットでは24以降は空。
    // トラックモード(PSF2MML.captureData の poolMode 'track')はレーン数が曲で決まり、c.psx.lanes / c.psx.labels
    // (レーン番号順。'T17-2' 等)を持つ
    if (c.psx) {
      const n = c.psx.lanes || 32;
      for (let i = 0; i < n; i++) out.push({ id: `psx:${i}`, label: `SPU ${c.psx.labels ? c.psx.labels[i] : 'V' + i}`, kind: 'pcm', chip: 'psx', chipIndex: 0, ch: i });
    }
    // ドラムパート: 音程が取れなかったサンプル発音(打楽器/効果音)を、チップごとに1本へ束ねた
    // 合成チャンネル(src/vgm2mml/expansion/opn.js drumChannelOf)。プール式チップは1組の
    // キットが何本ものスロットへ散るので、スロット単位ではなくここで1パートにする。
    // kind:'noise' なのは借用先が2A03ノイズch(ノート番号=LFSR周期)だから。ドラムの無い曲では
    // 音符ゼロの空チャンネルになるだけ(YM2413のch7-9と同じ扱い)。
    for (const d of DRUM_CHIPS) {
      if (c[d.flag]) out.push({ id: `${d.key}:drum`, label: `${d.name} Drums`, kind: 'noise', chip: d.flag, chipIndex: 0, ch: -1 });
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
  // ドラムパートを持つサンプルPCMチップ。key=ソースIDの接頭辞 / n=ch数 / shape=スナップショット形
  const DRUM_CHIPS = [
    { flag: 'ga20',     key: 'ga20', name: 'GA20',            n: 4,  shape: 'pcm',    data: 'ga20' },
    { flag: 'k007232',  key: 'k7',   name: 'K007232',         n: 2,  shape: 'pcm',    data: 'k007232' },
    { flag: 'segapcm',  key: 'spcm', name: 'SegaPCM',         n: 16, shape: 'pcm',    data: 'segapcm' },
    { flag: 'c140',     key: 'c140', name: 'C140',            n: 24, shape: 'pcm',    data: 'c140' },
    { flag: 'c352',     key: 'c352', name: 'C352',            n: 32, shape: 'pcm',    data: 'c352' },
    { flag: 'qsound',   key: 'qs',   name: 'QSound',          n: 16, shape: 'pcm',    data: 'qsound' },
    { flag: 'okim6295', key: 'oki',  name: 'OKIM6295',        n: 4,  shape: 'pcm',    data: 'okim6295' },
    { flag: 'multipcm', key: 'mp',   name: 'MultiPCM',        n: 28, shape: 'pcm',    data: 'multipcm' },
    { flag: 'psx',      key: 'psx',  name: 'SPU',             n: 32, shape: 'pcm',    data: 'psx' },
    { flag: 'ym2610',   key: 'pcma', name: 'YM2610 ADPCM-A',  n: 6,  shape: 'adpcmA', data: 'ym2610fm' },
    // YM2608内蔵リズム(BD/SD/TOP/HH/TOM/RIM)。リズムROM未読込時はキーオンだけで実サンプルが
    // 無い=samplePitchがnull → sample無しでドラム観測にも入らず、自然に何も出ない
    { flag: 'ym2608',   key: 'rhy',  name: 'YM2608 Rhythm',   n: 6,  shape: 'adpcmA', data: 'ym2608fm' },
  ];
  MML.VGM2MML.DRUM_CHIPS = DRUM_CHIPS;
  // そのチップのスナップショットの横幅(ch数)。表の n が基本で、PSF のトラックモードのように曲でレーン数が決まるものは
  // 実データの最大幅を使う(pcm 形だけ。adpcmA 等は配列の中の配列なので表の値のまま)
  function drumChipWidth(d, data) {
    if (d.shape !== 'pcm') return d.n;
    const snaps = data[d.data] && data[d.data].snapshots;
    let w = d.n;
    if (Array.isArray(snaps)) for (const s of snaps) if (s && s.length > w) w = s.length;
    return w;
  }

  MML.VGM2MML.defaultPlan = function (h) {
    const plan = {};
    const src = MML.VGM2MML.sourceChannels(h);
    const used = { fme7: 0, n163: 0, vrc7: 0, noise: 0 };
    const cap = { fme7: 3, n163: 8, vrc7: 6, noise: 1 };
    const take = (chip) => { const i = used[chip]++; return i; };
    for (const s of src.filter(s => s.kind === 'wave')) plan[s.id] = used.n163 < cap.n163 ? `n163_${take('n163')}` : 'skip';
    // FM(OPLL 2op / OPN 4op)はVRC7へ(6ch)。YM2612は6chでちょうど埋まる。
    // VRC7からあふれたぶん(YM2151=8ch、YM2413のch7-9)は下で N163 の余りへ回す
    const fmOverflow = [];
    for (const s of src.filter(s => s.kind === 'fm' || s.kind === 'fm4')) {
      if (used.vrc7 < cap.vrc7) plan[s.id] = `vrc7_${take('vrc7')}`;
      else { plan[s.id] = 'skip'; fmOverflow.push(s); }
    }
    for (const s of src.filter(s => s.kind === 'square' && s.chip === 'ay8910' && s.chipIndex === 0)) plan[s.id] = used.fme7 < cap.fme7 ? ['fme7a', 'fme7b', 'fme7c'][take('fme7')] : 'skip';
    // 2個目のPSG(ay2)は 2A03 パルスA/B + MMC5 パルス1 へ(ユーザー指定 2026-09-06。FME-7は1個目で埋まる)
    for (const s of src.filter(s => s.kind === 'square' && s.chip === 'ay8910' && s.chipIndex === 1)) plan[s.id] = ['pulse1', 'pulse2', 'mmc5pulse1'][s.ch] || 'skip';
    // YM2610 ADPCM: B(1ch、Δ-Nで音階演奏されることが多い)はVRC7の空き→2A03パルスA、
    // A(6ch、音程サンプルは音程ごとに別サンプル)はN163の空きへ。ドラム等音程なしのサンプルは
    // 抽出段階で休符になるので、割り当てても音符が無ければ空チャンネルになるだけ
    // ★VRC7に空きが無いとき(YM2608=FM6ch、YM2610B)の落とし先は DPCM(E)。以前は 2A03 パルスA だったが、
    //   ADPCM-Bは実サンプルなので矩形波へ載せるより実サンプルのままDMCへ焼く方が近い(ユーザー指定 2026-09-06)
    for (const s of src.filter(s => s.kind === 'pcm' && /^pcmb/.test(s.id))) plan[s.id] = used.vrc7 < cap.vrc7 ? `vrc7_${take('vrc7')}` : 'dpcm';
    for (const s of src.filter(s => s.kind === 'pcm' && !/^pcmb/.test(s.id))) plan[s.id] = used.n163 < cap.n163 ? `n163_${take('n163')}` : 'skip';
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
    // ★VRC7(6ch)からあふれたFMは、他を全部置いた後に残った N163 の空きへ(ユーザー報告 2026-09-10:
    //   R-Type Leo 2曲目で YM2151 FM7 のバッキングが丸ごと消えていた)。YM2151は8chなので既定では
    //   必ず2本あふれる。N163を先に取りに行かないのは、SCC/PCM/SN76489 の従来の割当を1つも
    //   動かさないため(N163が埋まる C140/SegaPCM 構成では従来どおり skip のまま)
    for (const s of fmOverflow) { if (used.n163 < cap.n163) plan[s.id] = `n163_${take('n163')}`; }
    // ドラムパートは2A03ノイズchへ(1本だけ)。SN76489のノイズを先に評価しているのは、
    // SN+サンプルPCMの構成でSNノイズの割当が従来から変わらないようにするため
    for (const s of src.filter(s => s.kind === 'noise' && s.chip !== 'sn76489')) {
      plan[s.id] = used.noise < cap.noise ? (take('noise'), 'noise') : 'skip';
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
      // ドラムパート(合成ch)はラベルがそのまま1グループ("C140 Drums")
      const key = /:drum$/.test(s.id) ? s.label
        : s.label.replace(/ ch\d+$| noise$/, '').replace(/ (FM|ADPCM-A|PCM)\d+(\(2\))?$/, ' $1$2') + (s.kind === 'noise' ? ' noise' : '');
      const dst = (t === 'skip' || !tt.chip) ? null : (tt.chip === '2a03' ? `2A03 ${tt.letter}` : tt.chip.toUpperCase().replace('FME7', 'FME-7'));
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
    const defPlan = MML.VGM2MML.defaultPlan(h);
    const plan = Object.assign({}, defPlan, options.channelMap || {});
    // 既定割当がVRC7からあふれたFMをN163の空きへ回したぶん(defaultPlan参照)。音符が1つも
    // 無ければ載せない=空のN163チャンネルのために #EX-NAMCO106 を足さない
    // (NSF書き出しのROMを無駄に食うため。ユーザーが明示指定したものは指定どおり空でも載せる)
    const autoFmOnN163 = new Set(src.filter(s2 => (s2.kind === 'fm' || s2.kind === 'fm4')
      && /^n163_/.test(defPlan[s2.id] || '') && !(options.channelMap && options.channelMap[s2.id])).map(s2 => s2.id));
    // 変換設定(src/convert/options.js): コマンド使用/不使用・譜面整形(全レジストリ・
    // detune.js・emitScore へ同じ cmd を渡す)
    const cmd = MML.Convert.normalizeCmd(options.cmd);

    const envReg = new MML.Convert.EnvelopeRegistry(cmd);
    // OPN系FM・ADPCM・サンプルPCMの抽出オプション(src/vgm2mml/expansion/opn.js collect)。
    // envelope:true で「音量が動いても音符を切らず、フレームごとの音量/音程を列で持つ」。
    // その列が @v(音量エンベロープ)と EP/MP/PT(ピッチ変調)の材料になる。
    // ★VRC7へ載せるchは false にする。VRC7は@v非対応(compiler.jsのVRC7経路はENのみ)なので、
    //   列にまとめてしまうと音符の中の音量変化が1つの v<n> に潰れて消える。従来どおり
    //   音量が変わったところでイベントを切り、v<n>を並べて出す。
    //   変換設定でENVがOFFのときも同じ(列を作っても捨てるだけなので作らない)。
    const envFamOk = (fam) => fam !== 'vrc7';
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry(cmd);
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry(cmd);
    const n163WaveReg = MML.Convert.n163WaveRegistry();
    const fdsWaveReg = new MML.Convert.WaveRegistry('@FM'); // FDSへ載せた矩形波系ソースの波形(@FM<n>)
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');
    const notes = ignoredNote ? [ignoredNote] : [];
    if (c.ay8910 && c.ay8910.dual) notes.push('2個目のAY8910(デュアルチップ)は変換対象外のため無視しました。');
    // 既定割当が借用先不足でskipにしたFMチャンネル(YM2151 8ch > VRC7 6ch 等)はその旨を注記する
    // (ユーザーが明示的にskipへ変えたものは対象外)
    const autoSkippedFm = src.filter(s => (s.kind === 'fm4' || s.kind === 'fm') && plan[s.id] === 'skip'
      && !(options.channelMap && options.channelMap[s.id] === 'skip'));
    if (autoSkippedFm.length) notes.push(`${autoSkippedFm.map(s => s.label).join(', ')} は借用先(VRC7の6ch・N163の8ch)に空きが無いため変換対象外です(鍵盤表示のチャンネル割当で変更できます)。`);

    // 借用先ファミリに応じた音量写像プロキシ(対数DAC元→線形先のときだけ写像)
    const familyOf = t => (TARGET_TYPES[t] || TARGET_TYPES.skip).family || null;
    // ★vrc6saw/fds も線形音源(2026-09-11追加)。以前は外れていたため、これらへ載せると
    //   @v だけ元の対数値のまま素通りし、v(定数音量)と別の尺度になっていた
    const needsLinear = fam => fam === 'n163' || fam === 'pulse' || fam === 'vrc6pulse' || fam === 'vrc6saw' || fam === 'fds';
    const regFor = (chip, fam) => (needsLinear(fam) && envTable(chip, fam)) ? mappedEnvReg(envReg, envTable(chip, fam))
      : (fam === 'vrc7' && VRC7_TABLE[chip]) ? mappedEnvReg(envReg, VRC7_TABLE[chip]) : envReg;

    // ── 音色ごとの設定(src/convert/toneSettings.js、2026-09-09) ─────────────────────
    // options.toneSettings … main.js が ToneSettings.snapshot() で作った素のオブジェクト(無ければ従来どおり)
    // ★抽出のskipゲート(wantExtract)より前で決めること。音色一覧の「載せ先」は抽出済みの
    //   イベントから音色キーを引いて効かせるので、ここが後ろにあると借用先skipのchは
    //   そもそも抽出されず、音色一覧で載せ先を指定しても何も出なかった(ユーザー報告 2026-09-10)
    const TS = (MML.Convert.ToneSettings && options.toneSettings) ? MML.Convert.ToneSettings.lookup(options.toneSettings) : null;
    const TK = MML.Convert.ToneKey;
    const keyOf = (ev, s) => (TK ? TK.ofEvent(ev, s) : null);
    const useTone = !!(TS && !TS.isEmpty() && TK);
    // 抽出するか。借用先が skip でも、音色ごとの設定があるときは旋律chを抽出しておく
    // (音色一覧の「載せ先」で仮想ソースへ分割できるようにするため。分割されなければ
    //  下の配置ループが skip として捨てるだけなので出力は変わらない)
    const wantExtract = (s) => plan[s.id] !== 'skip' || (useTone && s.ch >= 0);

    // ── 抽出(ソースチップごと。同じチップ内でも借用先ファミリが違えば音量写像が違うので、
    //    ファミリごとに抽出し直して該当chだけ採る) ──
    // YM2610内蔵SSGの実クロックはチップクロック/4(ymfm裏取り)。AY抽出器はZ80(=AY実クロック×2)前提なので/2。
    // キャプチャ済みのdata.kss.clockがあれば最優先(YM2203はプリスケーラでSSG実クロックが
    // 変わりうるため、captureVgmSongAsyncが実際の値へ追随させている。他チップでは同値)。
    const kssClock = (data.kss && data.kss.clock)
      || (c.ay8910 ? c.ay8910.clock * 2 : c.ym2610 ? c.ym2610.clock / 2 : c.ym2203 ? c.ym2203.clock
        : c.ym2608 ? c.ym2608.clock / 2
        : c.k051649 ? c.k051649.clock * 2 : (c.ym2413 ? c.ym2413.clock : 3579545));
    const hasAySource = !!(c.ay8910 || c.ym2610 || c.ym2203 || c.ym2608);
    const extracted = {}; // sourceId → channel(events+flags)

    // ── PCMチップ(SegaPCM 16ch/C140 24ch等)のch数が既定割当の借用先枠(N163 8ch)より
    //    多い場合、既定割当のままだと「先頭8ch」に固定されメロディが別chにあると丸ごと
    //    skipされる。ユーザー指定(channelMap)が無いときは全chを先に抽出して
    //    **音符(ピッチ解析で音程が取れたイベント)の多いch上位**へ枠を割り当て直す。
    //    (describePlan/ヘッダの割当表示もこの並べ替え後のplanを反映する) ──
    if (!options.channelMap) {
      for (const chipKey of [...new Set(src.filter(s => s.kind === 'pcm' && s.chip !== 'ym2610adpcm').map(s => s.chip))]) {
        const items = src.filter(s => s.chip === chipKey && s.kind === 'pcm');
        const slots = items.map(s => plan[s.id]).filter(t => t && t !== 'skip');
        if (slots.length >= items.length) continue; // 全ch入るなら並べ替え不要
        if (!data[chipKey] || !MML.Vgm2MmlExpansion[chipKey]) continue;
        const r = MML.Vgm2MmlExpansion[chipKey](data[chipKey].snapshots, null, { envelope: false });
        // 合成chの複製パート(convertData 冒頭)を省かずに残した場合も、複製の音符は数えない(元のパートを先に枠へ載せる)
        const dbl = data[chipKey].doublesFolded ? null : data[chipKey].doubles;
        // ★数えるのは音符の頭(発音/音程の変わり目)。以前はイベント数を数えていて、ビブラートや音量の揺れで
        //   1音が数十イベントに割れるパッドが、キーオンの多いベースやアルペジオより上に来ていた
        //   (PSF babel14: パッド87音=1534イベント、ベース301音=322イベントでベースが枠から漏れた)
        const onsets = (evs) => { let n = 0, prev = null; for (const ev of evs) { if (ev.note !== null && (ev.retrigger || prev === null || prev !== ev.note)) n++; prev = ev.note; } return n; };
        // rank(並べ順)だけ複製の音符を差し引く。枠に空きがあれば複製しか無いレーンも載せる(notes>0)
        // ★差し引いた数で「載せるか」まで決めると、FF7 The Prelude で30フレーム遅れのエコーのレーンが空き枠があるのに落ちた
        const counts = items.map(s => { const n = onsets(r.channels[s.ch].events); return { s, notes: n, rank: n - (dbl ? (dbl.copyCount.get(s.ch) || 0) : 0) }; });
        counts.sort((a, b) => b.rank - a.rank || b.notes - a.notes);
        for (const it of items) plan[it.id] = 'skip';
        const picked = [];
        counts.slice(0, slots.length).forEach((cn, k) => {
          if (cn.notes > 0) { plan[cn.s.id] = slots[k]; picked.push(cn.s.label.match(/\d+$/)[0]); }
        });
        if (picked.length && counts.length > picked.length) {
          const chipName = items[0].label.replace(/ (PCM|V)\d+$/, ''); // 'SPU V0' → 'SPU'
          notes.push(`${chipName} は${items.length}chのうち音符の多いch(${picked.join(',')})を既定割当に自動選択しました(鍵盤表示のチャンネル割当で変更できます)。`);
        }
      }
    }

    // ── ドラムマップ(打楽器サンプル → 疑似音程)を曲全体で1つ組む ──────────────
    // 音程レジスタで音階演奏していないサンプル発音(ドラム/効果音)は、従来は丸ごと休符に
    // なっていた。ピアノロールのドラム区画と同じ表(src/convert/drumMap.js)でレーンを決め、
    // 「1サンプル=1音程」の音符として出す。★チップごとに別々に組むと、サンプルチップを
    // 2つ積んだVGMで両方が同じ音程に化けるため、必ず全チップぶんをまとめてから build する。
    // ── 打楽器を実サンプルのままDPCM(Eパート)へ焼く ──────────────────────
    // 借用先に 'dpcm' を選ばれたPCMソースchを集め、同時発音区間はその瞬間の音を
    // ミックスした1クリップにして @DPCM<n> 化する(src/vgm2mml/expansion/dpcmDrums.js)。
    // ★ここで拾ったchは、後段の「2A03ノイズへ疑似音程で出すドラムパート」から除外する
    //   (両方へ出すと同じ打点が二重に鳴る)。
    let dpcmResult = null;
    const dpcmChans = {}; // chipフラグ → [ch番号...]
    // ADPCMソース(sourceChannelsの chip は 'ym2610adpcm'/'ym2608adpcm' で DRUM_CHIPS のフラグと違う)。
    // ★以前はここで引けず、ADPCM-A/B を E(DPCM) に割り当てても何も焼かれていなかった。
    //   drumFlag は「ノイズ側ドラムパートから外すch」(dpcmChans)のキー。ADPCM-B(pcmb)は
    //   snapshot の adpcmB(1本)なので shape を分け、ch番号は使わない
    const ADPCM_DPCM_DATA = {
      ym2610adpcm: { data: 'ym2610fm', drumFlag: 'ym2610' },
      ym2608adpcm: { data: 'ym2608fm', drumFlag: 'ym2608' },
    };
    if (MML.Vgm2MmlExpansion.dpcmDrums && MML.Dpcm) {
      const bySrcChip = new Map();
      for (const s of src) {
        if (s.kind !== 'pcm' || s.ch < 0 || plan[s.id] !== 'dpcm') continue;
        const key = s.chip + (/^pcmb/.test(s.id) ? ':B' : '');
        if (!bySrcChip.has(key)) bySrcChip.set(key, []);
        bySrcChip.get(key).push(s);
      }
      const sources = [];
      for (const [key, items] of bySrcChip) {
        const chipFlag = items[0].chip;
        const isB = /:B$/.test(key);
        const d = DRUM_CHIPS.find(x => x.flag === chipFlag);
        const ad = ADPCM_DPCM_DATA[chipFlag];
        const entry = d ? data[d.data] : (ad ? data[ad.data] : null);
        if (!entry || !entry.samples) continue;
        const shape = isB ? 'adpcmB' : (d ? d.shape : 'adpcmA');
        const chans = items.map(s => s.ch);
        if (!isB) dpcmChans[d ? d.flag : ad.drumFlag] = chans;
        // ★DMCレート・変換する/しない・外部ファイルでの差し替えは、チャンネルではなく
        //   サンプル単位の設定(src/convert/drumSamples.js)。dpcmDrums が直接読む。
        sources.push({ chip: chipFlag, snapshots: entry.snapshots, chans, shape, samples: entry.samples });
      }
      // options.drumHits: 合成音ch(FM/PSG/SN等)をE(DPCM)へ載せた分の打点(main.js synthDrum、
      // 他chミュートの分離レンダリング)。サンプルPCMの打点と一緒に焼く
      const extraHits = cmd.DRUM !== false ? (options.drumHits || []) : [];
      if (sources.length || extraHits.length) {
        dpcmResult = MML.Vgm2MmlExpansion.dpcmDrums(sources, frameRate, {
          totalFrames, dmcRate: cmd.DMC_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY, extraHits });
        if (!dpcmResult.defs.length) dpcmResult = null;
      }
    }

    let drumMap = null;
    const drumChips = DRUM_CHIPS.filter(d => c[d.flag] && data[d.data]);
    if (cmd.DRUM !== false && MML.Convert.DrumMap && drumChips.length) {
      const frameDur = 1 / frameRate;
      const obs = [];
      for (const d of drumChips) {
        MML.Vgm2MmlExpansion.collectDrumObs(data[d.data].snapshots, drumChipWidth(d, data), frameDur, d.shape, obs);
      }
      if (obs.length) drumMap = MML.Convert.DrumMap.build(obs);
    }
    if (drumMap) {
      // ADPCM-A の音量は snapshot 側で 1-att/63 に正規化済みなので逆算する(adpcm()と同じ式)
      const attA = (ch) => Math.max(0, (1 - ch.vol) * 63 * 0.75);
      for (const d of drumChips) {
        const s = src.find(x => x.id === `${d.key}:drum`);
        if (!s || plan[s.id] === 'skip') continue;
        // DPCMへ載せたchはノイズ側のドラムパートから外す(二重発音の防止)
        const taken = dpcmChans[d.flag] || [];
        const width = drumChipWidth(d, data);
        const chans = Array.from({ length: width }, (_, i) => i).filter(i => taken.indexOf(i) < 0);
        if (!chans.length) continue;
        extracted[s.id] = MML.Vgm2MmlExpansion.drumChannel(
          data[d.data].snapshots, width, drumMap, d.shape, d.shape === 'adpcmA' ? attA : null, chans);
      }
      // どのノート番号がどのサンプルかは音を聴いても分からないので、ヘッダのコメントに残す
      const labels = MML.Convert.DrumMap.labels(drumMap.lanes.map(l => l.key));
      const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
      const rows = drumMap.lanes.map((l, i) => {
        const note = MML.Convert.DrumMap.noteOf(i);
        const name = NOTE_NAMES[note % 12] + Math.floor(note / 12);
        return `${name}=${l.key === null ? 'other' : labels[i]}`;
      });
      notes.push(`打楽器(音程の取れないサンプル)を1本のドラムパートにまとめ、サンプルごとに音程を割り当てました: ${rows.join(' ')} (アドレスはサンプルROM上の開始位置)。`);
    }

    // items(同じチップのソースch)を「@vを使える借用先か」で分け、必要なら2通り抽出する。
    // run(opts)が抽出結果、pick(r, s)がそのソースchのチャンネル
    function extractEnvModes(items, run, pick) {
      const modeOf = (s) => cmd.ENV !== false && envFamOk(familyOf(plan[s.id]));
      for (const m of [...new Set(items.map(modeOf))]) {
        const r = run({ envelope: m });
        for (const s of items) if (modeOf(s) === m) { const chn = pick(r, s); if (chn) extracted[s.id] = chn; }
      }
    }

    function extractGroup(chipKey, extractFn, chipIndex) {
      // 'dpcm'(合成音chの打楽器化)は分離レンダリングの打点で扱うので旋律の抽出からは外す。
      // chipIndex: 同じチップ種別の2個目(デュアルAY等)を別のwriteLogから抽出するときに 1 を渡す
      const ci = chipIndex || 0;
      const items = src.filter(s => s.chip === chipKey && (s.chipIndex || 0) === ci && s.kind !== 'noise' && wantExtract(s) && plan[s.id] !== 'dpcm');
      const fams = [...new Set(items.map(s => familyOf(plan[s.id])))];
      for (const fam of fams) {
        const res = extractFn(regFor(chipKey, fam), fam);
        for (const s of items) if (familyOf(plan[s.id]) === fam) extracted[s.id] = res[s.ch];
      }
    }
    if (data.kss && data.kss.ay && hasAySource) {
      extractGroup('ay8910', (reg) => MML.Kss2MmlExpansion.ay(data.kss.writeLog, totalFrames, kssClock, reg).channels);
    }
    if (data.kss2 && data.kss2.ay && src.some(s => s.chip === 'ay8910' && s.chipIndex === 1)) {
      extractGroup('ay8910', (reg) => MML.Kss2MmlExpansion.ay(data.kss2.writeLog, totalFrames, data.kss2.clock || kssClock, reg).channels, 1);
    }
    let sccResult = null, sccUsed = false;
    if (data.kss && data.kss.scc && c.k051649) {
      // ★借用先ファミリごとに抽出し直す(2026-09-11)。SCCだけ envReg を直接渡していたため、
      //   FDS/VRC6のこぎりへ載せても @v が 0-15 のまま素通りし、v(0-32/0-42)と天井が食い違っていた。
      //   波形(@N)は同じ内容なら WaveRegistry が同じ番号を返すので、複数回抽出しても定義は増えない。
      const items = src.filter(s => s.chip === 'k051649' && wantExtract(s));
      const fams = [...new Set(items.map(s => familyOf(plan[s.id])))];
      for (const fam of (fams.length ? fams : [null])) {
        const r = MML.Kss2MmlExpansion.scc(data.kss.writeLog, totalFrames, kssClock, n163WaveReg, regFor('k051649', fam));
        if (!sccResult) { sccResult = r; sccUsed = r.channels.some(ch => ch.events.some(ev => ev.note !== null)); }
        if (sccUsed) for (const s of items) if (familyOf(plan[s.id]) === fam) extracted[s.id] = r.channels[s.ch];
      }
    }
    if (data.kss && data.kss.opll && c.ym2413) {
      const r = MML.Kss2MmlExpansion.opll(data.kss.writeLog, totalFrames, vrc7ToneReg);
      // リズムモード曲は r.channels が6本しか無いので、ch7-9は未定義のまま置かない
      for (const s of src) if (s.chip === 'ym2413' && wantExtract(s) && r.channels[s.ch]) extracted[s.id] = r.channels[s.ch];
    }
    if (data.kss && data.kss.opl && (c.ym3812 || c.ym3526 || c.y8950)) {
      const r = MML.Kss2MmlExpansion.opl(data.kss.writeLog, totalFrames, data.kss.oplClock, vrc7ToneReg);
      for (const s of src) if (s.chip === 'opl' && wantExtract(s) && r.channels[s.ch]) extracted[s.id] = r.channels[s.ch];
    }
    // OPN系FM(YM2612/YM2610)と YM2610 ADPCM: イベントは借用先非依存(attDb)なので1回抽出して全部に使う
    if (data.ym2612 && c.ym2612) {
      extractEnvModes(src.filter(s => s.chip === 'ym2612' && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.opn(data.ym2612.snapshots, 6, o), (r, s) => r.channels[s.ch]);
    }
    if (data.ym2151 && c.ym2151) {
      extractEnvModes(src.filter(s => s.chip === 'ym2151' && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.opn(data.ym2151.snapshots, 8, o), (r, s) => r.channels[s.ch]);
    }
    if (data.ym2203fm && c.ym2203) {
      extractEnvModes(src.filter(s => s.chip === 'ym2203' && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.opn(data.ym2203fm.snapshots, c.ym2203.dual ? 6 : 3, o), (r, s) => r.channels[s.ch]);
    }
    if (data.ym2608fm && c.ym2608) {
      extractEnvModes(src.filter(s => s.chip === 'ym2608' && s.ch >= 0 && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.opn(data.ym2608fm.snapshots, 6, o), (r, s) => r.channels[s.ch]);
      // ADPCM-B(Δ-Nで音階演奏)はYM2610と同じ抽出器(スナップショット形状が同一)。
      // リズム(adpcmA)側はドラムパート(DRUM_CHIPS/drumChannel)が拾うのでここでは使わない
      extractEnvModes(src.filter(s => s.chip === 'ym2608adpcm' && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.adpcm(data.ym2608fm.snapshots, drumMap, o), (r) => r.b);
    }
    if (data.ga20 && c.ga20) {
      const pcmItems = src.filter(s => s.chip === 'ga20' && s.ch >= 0 && wantExtract(s));
      // ★ s.ch >= 0 は合成チャンネル(ドラムパート、ch:-1)を除くため。付け忘れると
      //   channels[-1]=undefined でドラムパートの抽出結果を上書きしてしまう
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.ga20(data.ga20.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.k007232 && c.k007232) {
      const pcmItems = src.filter(s => s.chip === 'k007232' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.k007232(data.k007232.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.segapcm && c.segapcm) {
      const pcmItems = src.filter(s => s.chip === 'segapcm' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.segapcm(data.segapcm.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.c140 && c.c140) {
      const pcmItems = src.filter(s => s.chip === 'c140' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.c140(data.c140.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.c352 && c.c352) {
      const pcmItems = src.filter(s => s.chip === 'c352' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.c352(data.c352.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.qsound && c.qsound) {
      const pcmItems = src.filter(s => s.chip === 'qsound' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.qsound(data.qsound.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.okim6295 && c.okim6295) {
      const pcmItems = src.filter(s => s.chip === 'okim6295' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.okim6295(data.okim6295.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.multipcm && c.multipcm) {
      const pcmItems = src.filter(s => s.chip === 'multipcm' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.multipcm(data.multipcm.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.psx && c.psx) {
      const pcmItems = src.filter(s => s.chip === 'psx' && s.ch >= 0 && wantExtract(s));
      extractEnvModes(pcmItems, (o) => MML.Vgm2MmlExpansion.psx(data.psx.snapshots, drumMap, o), (r, s) => r.channels[s.ch]);
    }
    if (data.ym2610fm && c.ym2610) {
      const nFm = c.ym2610.ym2610b ? 6 : 4;
      extractEnvModes(src.filter(s => s.chip === 'ym2610' && s.ch >= 0 && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.opn(data.ym2610fm.snapshots, nFm, o), (r, s) => r.channels[s.ch]);
      extractEnvModes(src.filter(s => s.chip === 'ym2610adpcm' && wantExtract(s)),
        (o) => MML.Vgm2MmlExpansion.adpcm(data.ym2610fm.snapshots, drumMap, o), (r, s) => s.ch === 6 ? r.b : r.a[s.ch]);
    }
    const vrc7InstOf = (s) => {
      const v = options.vrc7Inst && options.vrc7Inst[s.id];
      return v !== undefined && v !== null && v !== '' ? String(v) : MML.VGM2MML.defaultVrc7Inst(s.kind);
    };
    // 借用先ごとの音色(options.tone[ソースID]、channelPlan.js toneOptionsFor の語彙): デューティ/波形/ノイズ周期
    const toneOf = (s) => {
      const v = options.tone && options.tone[s.id];
      return v !== undefined && v !== null && v !== '' ? String(v) : undefined;
    };
    if (data.sn && c.sn76489) {
      const nChips = c.sn76489.dual ? 2 : 1;
      for (let k = 0; k < nChips; k++) {
        const items = src.filter(s => s.chip === 'sn76489' && s.chipIndex === k && wantExtract(s));
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

    // ── 音色ごとの設定(src/convert/toneSettings.js、2026-09-09) ─────────────────────
    const demotions = []; // VRC7自作音色があぶれてプリセットへ落ちた音色 [{key, preset, label}]
    // 音色ごとの載せ先で1本の元chを分割する(borrow.js compose と同じ考え方。仮想ソース id 'opn:2@triangle')。
    // 別ファミリでの抽出し直しが要るのは音量写像が抽出時に効く AY/SN だけ(他は attDb で借用先非依存)
    const extractForFam = (s, fam, base) => {
      if (s.chip === 'ay8910' && data.kss) {
        const wl = (s.chipIndex || 0) === 1 ? (data.kss2 && data.kss2.writeLog) : data.kss.writeLog;
        const clk = (s.chipIndex || 0) === 1 ? ((data.kss2 && data.kss2.clock) || kssClock) : kssClock;
        return wl ? MML.Kss2MmlExpansion.ay(wl, totalFrames, clk, regFor('ay8910', fam)).channels[s.ch] : null;
      }
      if (s.chip === 'sn76489' && data.sn) return MML.Vgm2MmlExpansion.sn76489(data.sn.snapshots, data.sn.clock, regFor('sn76489', fam), s.chipIndex || 0).tones[s.ch];
      return base || extracted[s.id];
    };
    const restOf = (ev) => ({ start: ev.start, end: ev.end, note: null });
    const splitSources = [];
    if (useTone) {
      for (const s of src) {
        const t = plan[s.id];
        const base = extracted[s.id];
        // t === 'skip' でも通す: 音色一覧で載せ先を指定した音色だけ仮想ソースへ分けて載せる
        // (チャンネル自体は skip のまま。指定の無い音色はどこにも出ない)
        if (!base || !t || t === 'dpcm' || s.ch < 0) continue;
        const overrides = new Map();
        for (const ev of base.events) {
          if (ev.note === null) continue;
          const k = keyOf(ev, s);
          const tt2 = k ? TS.targetFor(k) : undefined;
          if (tt2 && tt2 !== t) overrides.set(k, tt2);
        }
        if (!overrides.size) continue;
        extracted[s.id] = Object.assign({}, base, { events: base.events.map(ev => (ev.note !== null && overrides.has(keyOf(ev, s))) ? restOf(ev) : ev) });
        const byTarget = new Map();
        for (const [k, tt2] of overrides) { if (!byTarget.has(tt2)) byTarget.set(tt2, []); byTarget.get(tt2).push(k); }
        for (const [tt2, keys] of byTarget) {
          const names = keys.map(k => TS.nameOf(k) || k.replace(/^[a-z]+:/, '').slice(0, 6));
          if (tt2 === 'skip') { notes.push(`${s.label} の音色 ${names.join(', ')} はスキップ指定のため変換対象外です。`); continue; }
          if (tt2 === 'dpcm') { notes.push(`${s.label} の音色 ${names.join(', ')} → E(DPCM) は音色単位の打楽器化に未対応のため変換対象外です(チャンネル単位でEを選ぶか、サンプルの「扱い」で打楽器にしてください)。`); continue; }
          if (!TARGET_TYPES[tt2]) continue;
          const chFam = extractForFam(s, TARGET_TYPES[tt2].family, base);
          if (!chFam) continue;
          const keySet = new Set(keys);
          const vs = Object.assign({}, s, { id: `${s.id}@${tt2}`, label: `${s.label}[${names.join(',')}]`, splitFrom: s.id });
          extracted[vs.id] = Object.assign({}, chFam, { events: chFam.events.map(ev => (ev.note !== null && keySet.has(keyOf(ev, s))) ? ev : restOf(ev)) });
          plan[vs.id] = tt2;
          splitSources.push(vs);
        }
      }
    }
    const allSrc = src.concat(splitSources);

    // ── 借用先ごとにイベントを整形して台帳へ ──
    // slotsByFamily: family → { index → {source, channel} }
    const placed = {}; // targetType → { source, channel }
    const conflicts = [];
    for (const s of allSrc) {
      const t = plan[s.id];
      if (t === 'dpcm') continue; // DPCMは dpcmDrums が1本へ合成済み(下で直接scoreChannelsへ入れる)
      if (!t || t === 'skip' || !extracted[s.id]) continue;
      if (autoFmOnN163.has(s.id) && !extracted[s.id].events.some(ev => ev.note !== null)) { plan[s.id] = 'skip'; continue; }
      if (placed[t]) { conflicts.push(`${s.label} は ${t} が既に ${placed[t].source.label} に使われているため変換対象外です。`); continue; }
      const tt = TARGET_TYPES[t];
      if (!tt) continue;
      // 種別と借用先の相性(UI外から不正な組合せが来た時の防御)
      if (s.kind === 'noise' && tt.family !== 'noise') { conflicts.push(`${s.label} → ${t} は種別が合わないため変換対象外です。`); continue; }
      // ★波形音源(SCC)の借用先を n163/vrc7/fds に限る判定は撤去した(2026-09-10)。
      //   下の adaptEvents は矩形波系(pulse/vrc6/fme7/mmc5)も三角波もノイズも扱えるようになっており、
      //   同じ SCC を KSS 経由(src/convert/borrow.js compose、ガードは noise だけ)で変換すると通るのに
      //   VGM 経由だけ「変換対象外」で無音になっていた。UI(channelPlan.js WAVE_T)も矩形波系を出している。
      const ch = Object.assign({}, extracted[s.id], { events: extracted[s.id].events.map(ev => Object.assign({}, ev)) });
      if (s.ch < 0) ch.isDrum = true; // 合成chのドラムパート(テンポ推定から外す。下記コメント参照)
      // 音色ごとの音色指定(toneSettings[key].tone[種別])。チャンネルの指定を音色単位で上書きする
      const baseS = s.splitFrom ? (src.find(x => x.id === s.splitFrom) || s) : s;
      const toneKind = (MML.Convert.ChannelPlan && MML.Convert.ChannelPlan.toneKindOfTarget) ? MML.Convert.ChannelPlan.toneKindOfTarget(t, s.kind) : null;
      const toneIdxKey = {};
      const actx = { toneKeyOf: (ev) => keyOf(ev, s), toneIdxKey, envReg };
      if (useTone && toneKind) {
        actx.toneOfEvent = (ev) => {
          const v = TS.toneFor(keyOf(ev, s), toneKind);
          if (v === undefined) return null;
          return toneKind === 'vrc7' ? { vrc7Inst: v } : { tone: v };
        };
      }
      adaptEvents(ch, s, tt.family, n163WaveReg, tt.family === 'vrc7' ? vrc7InstOf(baseS) : null, vrc7ToneReg, toneOf(baseS), fdsWaveReg, actx);
      ch.toneIdxKey = toneIdxKey;
      // ★動かさないのはYM2413(OPLL)だけ。OPLLの自作音色はVRC7と同じく$00-$07の1組を
      //   全chで共有する設計なので、抽出結果は最初から1系統に収まっている(実機がそう鳴らしていた)。
      //   OPL(YM3812/YM3526/Y8950)はチャンネルごとに独立した音色レジスタを持ち、それを
      //   OPLLカスタム音色8バイトへ変換しているので、OPN 4op と同じく衝突しうる(下の resolveConflicts)
      if (tt.family === 'vrc7') ch.vrc7ToneFixed = (s.chip === 'ym2413');
      placed[t] = { source: s, channel: ch };
    }
    notes.push(...conflicts);
    // VRC7(6ch)からあふれてN163へ載ったFM(YM2151の7-8ch等)。音色は4op→2op変換した波形の
    // 近似になるので、そうと分かるように書いておく
    const fmOnN163 = allSrc.filter(s2 => autoFmOnN163.has(s2.id) && /^n163_/.test(plan[s2.id] || ''));
    if (fmOnN163.length) notes.push(`${fmOnN163.map(s2 => s2.label).join(', ')} は借用先のVRC7(6ch)に収まらないため、N163の空きチャンネルへ波形近似で載せました(鍵盤表示のチャンネル割当で変更できます)。`);

    // 借用先ファミリごとの後処理(音程補正・EN・EP)
    const byFamily = {};
    for (const [t, p] of Object.entries(placed)) { const f = TARGET_TYPES[t].family; (byFamily[f] = byFamily[f] || []).push({ type: t, ...p }); }

    // ── VRC7自作音色(@0)の同時使用を1系統へ解く ──────────────────────────
    // 実機の自作音色スロットは$00-$07の1組だけで全ch共有。OPN 4op→2op変換はチャンネル
    // ごとに別音色を作るので、そのままだと2ch以上が重なった瞬間に src/mml/compiler.js の
    // 同時使用チェックへ引っかかり、MMLがコンパイルできず全パート無音になっていた。
    // 同時に鳴るぶんが1音色に収まるようチャンネル単位で割り当て直し、あぶれたチャンネルは
    // いちばん近い内蔵プリセットへ落とす(src/convert/vrc7Tone.js)。
    MML.Convert.Vrc7Tone.resolveConflicts(
      (byFamily.vrc7 || []).map(p => p.channel), vrc7ToneReg,
      { onDemote: (ch, presetByTone) => {
        ch.vrc7Demoted = presetByTone;
        // 音色一覧パネルで「この音色は→@nへ落ちた」と示すため、登録番号→音色キーで控える
        const p = (byFamily.vrc7 || []).find(x => x.channel === ch);
        for (const idx of Object.keys(presetByTone || {})) {
          const key = ch.toneIdxKey && ch.toneIdxKey[idx];
          if (key) demotions.push({ key, preset: presetByTone[idx], label: p ? p.source.label : '' });
        }
      } });

    // ── N163内蔵RAMへ波形が収まらない曲を収まる形へ ──────────────────────
    // 波形に使えるのは 128-8*有効ch数 バイトだけ。あふれるとコンパイルエラーで再生も
    // 書き出しもできないため、変換設定 N163_WAVE='fit'(既定)ならあふれたぶんの波形を
    // 半分ずつ縮める(src/convert/n163Fit.js)。★下の音程補正より前に呼ぶこと
    // ★休符だけのN163チャンネルは出さない(ユーザー指示 2026-09-11)。実効ch数は
    //   #EX-N163 の数値で伝わるので、空チャンネルを並べて位置を示す必要がなくなった
    if (byFamily.n163) {
      const sounding = byFamily.n163.filter(p => p.channel.events.some(ev => ev.note !== null));
      for (const p of byFamily.n163) if (sounding.indexOf(p) < 0) delete placed[p.type];
      if (sounding.length) byFamily.n163 = sounding; else delete byFamily.n163;
    }
    // N163の実効チャンネス数(変換設定 N163_CH)。周波数式・波形RAM枠・#EX-N163の宣言の
    // 3か所すべてでこの値を使う(src/convert/options.js n163NumChFor 冒頭コメント)
    const n163NumCh = MML.Convert.n163NumChFor(cmd,
      (byFamily.n163 || []).map(p => TARGET_TYPES[p.type].index));
    if (byFamily.n163) {
      const slots = [];
      for (const p of byFamily.n163) slots[TARGET_TYPES[p.type].index] = p.channel;
      notes.push(...MML.Convert.N163Fit.apply(slots, n163WaveReg, cmd, n163NumCh, options.n163ExtraMargin || 0, options.n163ForceHalve || null));
    }
    const expansions = [];
    for (const t of Object.keys(placed)) { const chip = TARGET_TYPES[t].chip; if (chip !== '2a03' && !expansions.includes(chip)) expansions.push(chip); }
    const prio = MML.Mml.EXPANSION_PRIORITY || ['fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
    expansions.sort((a, b) => prio.indexOf(a) - prio.indexOf(b));
    const letterMap = expansions.length ? MML.Mml.assignExpansionLetters(expansions) : {};
    const periodFnFor = {
      fme7: fme7PeriodRaw, n163: n163FreqRegRaw(N163_WAVE_LEN, n163NumCh), pulse: pulsePeriodRaw,
      triangle: triPeriodRaw, vrc6pulse: vrc6PulsePeriodRaw, vrc6saw: MML.Convert.Borrow.vrc6SawPeriodRaw,
      vrc7: vrc7FnumRaw, fds: MML.Convert.Borrow.fdsPeriodRaw, noise: null
    };
    const scoreChannels = [];
    for (const [fam, list] of Object.entries(byFamily)) {
      const chans = list.map(p => p.channel);
      const fn = periodFnFor[fam];
      if (fn) {
        // 音程補正: kss2mml(PSG→FME-7)と同じ detectChorusDetune 方針。EN→EPの順序はkss2mml参照
        MML.Convert.detectChorusDetune(chans, fn, { cmd });
        MML.Convert.assignNoteEnvelope(chans, noteEnvReg);
        // n163出力先だけSA<num>自動選択を有効化(pitch.js n163SaForBase参照)
        if (fam !== 'vrc7') MML.Convert.assignPitchEnvelope(chans, fn, pitchReg, fam === 'n163' ? { saMode: cmd.PITCH_SA } : undefined);
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
    // DPCM(Eパート)。実機ppmck同様レター体系上Eは固定なので letterMap を経由しない
    // (hes2mml/converter.js と同じ扱い)。音符は常に o4c で @<n> だけがサンプルを選ぶ。
    if (dpcmResult) {
      scoreChannels.push({ letter: 'E', events: dpcmResult.events, hasInstrument: true });
      const st = dpcmResult.stats;
      notes.push(`打楽器のPCMを実サンプルのままDPCM(Eパート)へ変換しました: 定義${st.clips}件 / 打点${st.segments}個 / ROM ${(st.bytes / 1024).toFixed(1)}KB(同時発音区間はその瞬間の音をミックスした1サンプルとして焼いています)。`);
    }
    MML.Convert.sortChannelsByLetter(scoreChannels);

    // ── テンポ・出力 ──
    // ★ドラムパートはテンポ推定に混ぜない。イベントの切れ目が「演奏された音符の長さ」ではなく
    //   サンプルのリトリガー間隔で決まるため(実測: 6フレーム等間隔で延々続く曲がある)、
    //   混ぜると推定が半分のテンポへ引っ張られ、ドラムを足しただけの曲の譜面全体が
    //   別のテンポで書き直されてしまう(実測3曲: 133→64 BPM等)。
    const noteDurations = [];
    for (const ch of scoreChannels) {
      if (ch.isDrum) continue;
      const sounding = ch.events.filter(ev => ev.note !== null);
      noteDurations.push(...MML.Convert.tempoMaterial(sounding.map(ev => ev.start), sounding.map(ev => ev.end - ev.start)));
    }
    // 2倍/半分の決着は「実際に音価を書いてみて素直な方」(MML.Convert.chooseTempoOctave、src/convert/mmlEmit.js)
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.chooseTempoOctave(MML.Convert.detectBpm(noteDurations, frameRate), scoreChannels, frameRate, { totalFrames, cmd });
    const fpb = frameRate * 60 / Math.round(bpm); // t<n>整数丸めと揃える([[tempo-rounding-drift-future-issue]])

    const assignments = MML.VGM2MML.describePlan(h, plan);
    const chipList = h.usedChips.map(ch => ch.name + (ch.dual ? ' x2' : '')).join(', ');
    const chanDesc = Object.entries(placed).map(([t, p]) => {
      const tt = TARGET_TYPES[t];
      const letter = tt.chip === '2a03' ? tt.letter : (letterMap[tt.chip] || [])[tt.index];
      // VRC7へ載せたチャンネルは使ったプリセット音色も併記(OPLL元音色そのままなら書かない)
      let inst = '';
      if (tt.chip === 'vrc7') {
        const v = vrc7InstOf(p.source);
        const dem = p.channel.vrc7Demoted;
        if (dem) inst = `(${presetListOf(dem)}へ代替)`;
        else if (v === '0') inst = p.source.kind === 'fm4' ? '(@0 自作音色=4op→2op変換)' : '(@0 自作音色=元の波形から逆算)';
        else if (v !== 'auto') inst = `(@${v} ${VRC7_PRESET_NAMES[parseInt(v, 10)] || ''})`;
      }
      return `${letter}=${p.source.label}${inst}`;
    }).join(' ');
    // 自作音色から内蔵プリセットへ落としたチャンネルの説明(1系統制約の説明つき)
    const demotedDesc = Object.entries(placed)
      .filter(([, p]) => p.channel.vrc7Demoted)
      .map(([t, p]) => {
        const tt = TARGET_TYPES[t];
        const letter = (letterMap[tt.chip] || [])[tt.index];
        return `${letter}(${p.source.label})=${presetListOf(p.channel.vrc7Demoted)}`;
      });
    if (demotedDesc.length) {
      notes.push('VRC7の自作音色(@0)は実機の制約でチップ全体に1音色しか持てないため、同時に鳴る' +
        `ぶんに収まらなかった ${demotedDesc.length} チャンネルはいちばん近い内蔵音色へ置き換えました: ${demotedDesc.join(' ')}。` +
        '(鍵盤表示の「音色」列で好みのプリセットに変更できます)');
    }
    const isCustom = !!options.channelMap && Object.keys(options.channelMap).some(k => options.channelMap[k] !== MML.VGM2MML.defaultPlan(h)[k]);

    const headerComment = [
      `; =========================================================`,
      `; ${options.sourceLabel || 'VGM'} → MML 変換 (${chipList})`, // sourceLabel: PSF 等、VGM 以外から convertData を使うとき
      `; 曲名     : ${label || '-'}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: ${chanDesc}`,
      `; 借用先の割当(${isCustom ? 'ユーザー指定' : '構成から自動'}): ${assignments.join(', ') || '-'}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、AY8910→FME-7(互換)、YM2413→VRC7(同一)、`,
      `;    SCC→N163(波形近似)、SN76489等の矩形波はFME-7の空き→N163(矩形波@N)の順に、ノイズは`,
      `;    2A03ノイズ(D)へ載せています(割当は鍵盤表示のpart列/「借用先」列で変更できます)。`,
      `;    YM2612/YM2610/YM2151/YM2203/YM2608のFMはVRC7へ(4op→2op自動変換で@0自作音色に。ただし実機の自作音色`,
      `;    スロットは$00-$07の1組を全chで共有するため、同時に鳴るぶんに収まらないchはいちばん近い内蔵音色へ)、`,
      `;    YM2610 ADPCM-A/Bはサンプルのピッチ解析で得た音程と音量だけを載せています。`,
      `;    線形音量の借用先(N163/2A03/MMC5/VRC6)へ載せた音量は対数DAC→線形へ換算した値です。`,
      ...notes.map(n => `; ※ ${n}`),
      ...MML.Convert.tuningCommentLines(),
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = expansions.map(chip => chip === 'n163'
      ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${n163NumCh}`
      : MML.Mml.EX_CHIP_DIRECTIVE[chip]);
    // @DPCM<n> 定義(1個でもあればEチャンネルが自動的に有効になる。#EX-*宣言は不要)
    const dpcmDefLines = dpcmResult ? dpcmResult.defs.map(d =>
      `@DPCM${d.index} = { "${d.file}", ${d.freq}, ${d.size}, ${d.dac}, ${d.mode} }`) : [];
    // resolveConflicts でプリセットへ落としたぶんの @OP<n> 定義は誰も参照しなくなる。
    // NSF書き出しで音色テーブル+分岐コードとしてROMを食う([[nsf-export-size-consciousness]])ので
    // 捨てて番号を詰める(イベント側の vrc7Tone も同時に振り直される)
    MML.Convert.Vrc7Tone.compactRegistry(vrc7ToneReg, (byFamily.vrc7 || []).map(p => p.channel));
    // 音符の区切り(NOTE_END、src/convert/envelope.js)。@v表を書き換えるので defLines() より前
    MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb, frameRate);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, cmd,
      headerLines: [
        ...MML.Convert.tuningHeaderLines(), ...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(expansions.includes('n163') ? n163WaveReg.defLines() : []),
        ...(expansions.includes('fds') ? fdsWaveReg.defLines() : []),
        ...(expansions.includes('vrc7') ? vrc7ToneReg.defLines() : [])
      ]
    });
    const mml = [headerComment, scoreText].join('\n');
    // 変換結果の音程検証(src/convert/verify.js): 最終MMLを実コンパイルして
    // 「実際に鳴る音の高さ」を変換元イベントと突き合わせる(失敗しても変換は妨げない)
    const pitchCheck = MML.Convert.verifyPitch
      ? MML.Convert.verifyPitch(mml, scoreChannels, { frameRate: frameRate, totalFrames: totalFrames })
      : null;

    return {
      mml,
      bpm: Math.round(bpm),
      pitchCheck,
      scoreChannels,
      chips: h.usedChips.filter(ch => ['ay8910', 'k051649', 'ym2413', 'sn76489', 'ym2612', 'ym2610', 'ym2151', 'ym2203', 'ym2608', 'ym3812', 'ym3526', 'y8950', 'ga20', 'k007232', 'segapcm', 'c140', 'c352', 'qsound', 'okim6295', 'multipcm', 'psx'].includes(ch.id)).map(ch => ch.name + (ch.dual ? ' x2' : '')),
      expansions,
      assignments,
      plan,
      n163Wave: sccUsed && sccResult ? sccResult.n163Wave : (expansions.includes('n163') ? N163_SQUARE_WAVE : null),
      // @DPCM<n>の実バイト列(main.jsがdpcmSampleCacheへ入れて即再生/NSF書き出しできるようにする。
      // hes2mml/converter.js と同じ形)。ROM容量の目安も一緒に返す
      dpcmFiles: dpcmResult ? dpcmResult.files : [],
      dpcmStats: dpcmResult ? dpcmResult.stats : null,
      toneDemotions: demotions // 音色一覧パネル用(VRC7自作音色→プリセットへ落ちた音色)
    };
  }

  // 音量の減衰量(dB)→借用先の音量値。VRC7は「v0が最大・v15が最小」(このコンパイラ/ppmckのVRC7は
  // レジスタの減衰値をそのまま v に取る)、FME-7は v15 最大の3dB/段、線形音源は振幅比。
  // linear の max は借用先ごと(famVolMax)。borrow.js VOL_FROM_DB と同じ規約
  const VOL_FROM_DB = {
    vrc7: att => Math.max(0, Math.min(15, Math.round(att / 3))),
    fme7: att => Math.max(0, Math.min(15, 15 - Math.round(att / 3))),
    linear: (att, max) => { const m = max == null ? 15 : max; return att >= 60 ? 0 : Math.max(1, Math.min(m, Math.round(m * Math.pow(10, -att / 20)))); }
  };
  // 4bit対数音量(AY=1.5dB/段(このコードベースの既定)、SN=2dB/段、OPLL/VRC7=3dB/段・反転)→減衰dB
  function sourceAttDb(s, ev) {
    if (ev.attDb !== undefined) return ev.attDb;
    if (ev.volume === undefined) return 0;
    const v = Math.max(0, Math.min(15, ev.volume));
    // 音量則は src/convert/borrow.js CHIP_VOL_LAW が正典(SCCは線形、AYは3dB/段。2026-09-11)
    const law = (MML.Convert.Borrow && MML.Convert.Borrow.CHIP_VOL_LAW || {})[s.chip];
    if (law) {
      if (law.linear) return v <= 0 ? 96 : -20 * Math.log10(v / 15);
      if (law.attDb) return v * law.attDb;
      return (15 - v) * law.stepDb;
    }
    return (15 - v) * 1.5;
  }

  // ソースチャンネルのイベントを借用先ファミリの語彙へ整形する(破壊的。呼び出し側でコピー済み)。
  // 音色ごとの指定(2026-09-09、src/convert/toneSettings.js): ctx.toneOfEvent(ev) が音色(楽器)単位の
  // 指定 { vrc7Inst?, tone? } を返すときは、イベントを「効く指定」でグループに分けてグループごとに
  // adaptGroup を通す(borrow.js adaptEvents と同じ考え方。全イベント同じなら従来と同じ1回の処理)。
  function adaptEvents(ch, s, fam, n163WaveReg, vrc7Inst, vrc7ToneReg, tone, fdsWaveReg, ctx) {
    if (!ctx || typeof ctx.toneOfEvent !== 'function') { adaptGroup(ch, ch.events, s, fam, n163WaveReg, vrc7Inst, vrc7ToneReg, tone, fdsWaveReg, ctx); return; }
    const groups = new Map();
    for (const ev of ch.events) {
      const ov = ev.note === null ? null : ctx.toneOfEvent(ev);
      const vi = (ov && ov.vrc7Inst != null) ? String(ov.vrc7Inst) : vrc7Inst;
      const tn = (ov && ov.tone != null) ? String(ov.tone) : tone;
      const gk = (vi == null ? '' : vi) + '|' + (tn == null ? '' : tn);
      let g = groups.get(gk);
      if (!g) { g = { vi, tn, events: [] }; groups.set(gk, g); }
      g.events.push(ev);
    }
    if (groups.size <= 1) {
      const only = groups.values().next().value;
      adaptGroup(ch, ch.events, s, fam, n163WaveReg, only ? only.vi : vrc7Inst, vrc7ToneReg, only ? only.tn : tone, fdsWaveReg, ctx);
      return;
    }
    for (const g of groups.values()) adaptGroup(ch, g.events, s, fam, n163WaveReg, g.vi, vrc7ToneReg, g.tn, fdsWaveReg, ctx);
    ch.hasInstrument = ch.events.some(ev => ev.instrument !== undefined);
    ch.hasVrc7Tone = ch.events.some(ev => ev.vrc7Tone !== undefined);
  }
  // ソースチャンネルのイベントを借用先ファミリの語彙へ整形する(破壊的。呼び出し側でコピー済み)。
  // vrc7Inst: 借用先がVRC7のときの音色('auto'=OPLLソースの元音色/カスタム音色をそのまま、'1'-'15'=プリセット、
  //           '0'=OPN 4op音色を2op自作音色(@OP)へ自動変換して OP<n>+@0)
  // tone: 借用先ごとの音色(デューティ '0'-'3'/'0'-'7'、波形 'copy'|'pulse50'|…、ノイズ周期 'auto'|'0'-'15')
  function adaptGroup(ch, events, s, fam, n163WaveReg, vrc7Inst, vrc7ToneReg, tone, fdsWaveReg, ctx) {
    // VRC7自作音色の登録番号 → 音色キー(あぶれ報告用。borrow.js adaptGroup と同じ)
    const noteToneIdx = (ev, idx) => {
      if (!ctx || !ctx.toneIdxKey || typeof ctx.toneKeyOf !== 'function' || idx === undefined) return;
      const k = ctx.toneKeyOf(ev);
      if (k && ctx.toneIdxKey[idx] === undefined) ctx.toneIdxKey[idx] = k;
    };
    const isAy = s.chip === 'ay8910';
    const nativeVrc7 = s.kind === 'fm' && fam === 'vrc7' && (vrc7Inst === 'auto' || vrc7Inst == null);
    const nativeFme7 = s.kind === 'square' && fam === 'fme7';
    // SCC→N163: 抽出器(Kss2MmlExpansion.scc)が波形メモリを @N として n163WaveReg に登録済みなので、そのまま使う
    // (tone で固定波形を選んだときだけ下の n163 分岐で差し替える)。
    // ★以前はここで止まらず n163 分岐に落ち、ev.n163Wave が無いので全部 N163_SQUARE_WAVE に化けていた
    const nativeScc = s.kind === 'wave' && s.chip === 'k051649' && fam === 'n163' && !MML.Convert.Borrow.toneWave(tone);
    if (nativeScc) {
      // 周期式(デチューン/EP)が参照する波形長を @N の実長(SCCは32)にそろえる
      for (const ev of events) if (ev.note !== null && ev.instrument !== undefined && n163WaveReg.waves[ev.instrument]) ev.rawLength = n163WaveReg.waves[ev.instrument].length;
      return;
    }
    if (nativeVrc7 || nativeFme7 || (fam === 'noise' && s.kind === 'noise')) return; // そのまま(旋律→ノイズは下で周期へ写す)
    const dutyOf = (max, def) => { const n = parseInt(tone, 10); return (isFinite(n) && n >= 0 && n <= max) ? n : def; };
    // AYのミキサー: ノイズ単独(mode 2)は矩形波系の借用先では鳴らせないので休符に、
    // トーン+ノイズ(mode 3)はトーンだけ残す。FME-7以外ではN<n>も出さない
    for (const ev of events) {
      if (isAy && ev.instrument === 2) { ev.note = null; }
      delete ev.fme7Noise;
    }
    ch.hasFme7Noise = false;
    // 音量: 借用先の尺度へ。AY/SN→線形は従来どおり LIN_TABLE(エンベロープ表も同じ表で写像済み)、
    // それ以外(attDbを持つOPN/ADPCM、OPLL→非VRC7、AY/SN→VRC7/FME-7以外の対数)は減衰dB経由
    const linearFam = fam === 'n163' || fam === 'pulse' || fam === 'vrc6pulse' || fam === 'vrc6saw' || fam === 'fds';
    if (linearFam && linTable(s.chip, fam) && s.kind === 'square') {
      mapConstVolumes(events, linTable(s.chip, fam)); // @v も regFor(…,fam) で同じ表に写像済み
    } else if (fam === 'vrc7' && VRC7_TABLE[s.chip] && s.kind === 'square') {
      mapConstVolumes(events, VRC7_TABLE[s.chip]); // エンベロープ表は regFor(…,'vrc7') で同じ表に写像済み
    } else if (fam !== 'triangle') {
      const conv = fam === 'vrc7' ? VOL_FROM_DB.vrc7 : fam === 'fme7' ? VOL_FROM_DB.fme7
        : (att) => VOL_FROM_DB.linear(att, famVolMax(fam));
      // ev.attSeq(音符区間の減衰dB列、opn.js withSeq)を借用先の音量値へ写して @v にする。
      // ★VRC7は@v非対応(compiler.js のVRC7経路はENのみ。spc2mml envCapableType と同じ判断)なので
      //   従来どおり定数音量のまま。写像は定数音量と同じ conv を通す=vと@vの尺度が必ず揃う
      const envReg = (fam !== 'vrc7' && ctx) ? ctx.envReg : null;
      for (const ev of events) {
        if (ev.note === null || (ev.attDb === undefined && ev.volume === undefined)) continue;
        ev.volume = conv(sourceAttDb(s, ev));
        if (!envReg || !ev.attSeq || ev.attSeq.length < 2) continue;
        const fields = envReg.volumeFieldsWithRelease(ev.attSeq.map(a => conv(a)));
        if (fields.envelopeV != null || fields.envelopeVr != null) {
          delete ev.volume;
          Object.assign(ev, fields);
          ch.hasEnvelope = true;
        } else if (fields.volume != null) ev.volume = fields.volume;
      }
    }
    for (const ev of events) { delete ev.attDb; delete ev.attSeq; }
    const TD = MML.Convert.ToneDerive;
    const deriveRegs = { n163WaveReg, vrc7ToneReg };
    if (fam === 'noise') {
      MML.Convert.Borrow.pitchedToNoise(ch, tone, events);
    } else if (fam === 'vrc7' && vrc7Inst === '0' && s.kind === 'fm4' && vrc7ToneReg) {
      // OPN 4op → VRC7 2op 自作音色(opnToOpllBytes)。音色ごとに @OP<n> を登録し OP<n>+@0 で切り替える
      for (const ev of events) {
        delete ev.n163Wave;
        if (ev.note === null) { delete ev.vrc7Tone; delete ev.opnPatch; continue; }
        const bytes = opnToOpllBytes(ev.opnPatch);
        ev.instrument = 0;
        ev.vrc7Tone = bytes ? vrc7ToneReg.assign(bytes) : undefined;
        noteToneIdx(ev, ev.vrc7Tone);
        delete ev.opnPatch;
      }
      ch.hasVrc7Tone = true; ch.hasInstrument = true;
    } else if (fam === 'vrc7' && vrc7Inst === '0' && vrc7ToneReg && TD && s.kind !== 'fm') {
      // 矩形波(AY/SN)/波形(SCC)/PCMの1周期 → VRC7 2op 自作音色。元の音の波形から逆算する
      // (src/convert/toneDerive.js。音色エディタの「出力波形から逆算」と同じ探索)。
      // ★以前はこの分岐が無く、'0'を選んでも下のプリセット分岐で @1 に落ちていた(2026-09-07)
      let any = false;
      for (const ev of events) {
        if (ev.note === null) { delete ev.vrc7Tone; delete ev.n163Wave; delete ev.opnPatch; continue; }
        const bytes = TD.vrc7BytesForEvent(ev, s, deriveRegs);
        if (bytes) { ev.instrument = 0; ev.vrc7Tone = vrc7ToneReg.assign(bytes); noteToneIdx(ev, ev.vrc7Tone); any = true; }
        else { ev.instrument = 1; delete ev.vrc7Tone; }
        delete ev.n163Wave; delete ev.opnPatch;
      }
      ch.hasVrc7Tone = any; ch.hasInstrument = true;
    } else if (fam === 'vrc7') {
      // VRC7プリセット音色。OPLLソースの元音色/カスタム音色は捨てる
      const inst = Math.max(1, Math.min(15, parseInt(vrc7Inst, 10) || 1));
      for (const ev of events) { if (ev.note !== null) ev.instrument = inst; delete ev.vrc7Tone; delete ev.n163Wave; delete ev.opnPatch; }
      ch.hasVrc7Tone = false; ch.hasInstrument = true;
    } else if (fam === 'n163') {
      // 元の音の1周期(ADPCM/PCMのサンプル波形、FM音色の定常波形=src/convert/toneDerive.js、
      // SCC波形)を @N に登録して音色にする。波形が取れない矩形波系だけ矩形波。tone の固定波形が優先。
      // ★以前はFM(OPN/OPM/OPLL/OPL)→N163が常に矩形波だった(2026-09-07)
      const forcedWave = MML.Convert.Borrow.toneWave(tone);
      for (const ev of events) {
        if (ev.note === null) { delete ev.n163Wave; continue; }
        const derived = forcedWave ? null : (TD ? TD.n163WaveForEvent(ev, s, deriveRegs, N163_WAVE_LEN) : null);
        const wave = forcedWave || derived || N163_SQUARE_WAVE;
        ev.instrument = n163WaveReg.assign(wave); ev.rawLength = N163_WAVE_LEN;
        delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch;
      }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'pulse') {
      // 2A03/MMC5パルス: 既定@2=デューティ50%(矩形波)。tone で @0-@3
      const duty = dutyOf(3, 2);
      for (const ev of events) { if (ev.note !== null) ev.instrument = duty; delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'vrc6pulse') {
      // VRC6パルス: 既定@7=デューティ50%(8/16)。tone で @0-@7
      const duty = dutyOf(7, 7);
      for (const ev of events) { if (ev.note !== null) ev.instrument = duty; delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'fme7') {
      // FME-7: @1=トーンのみ
      for (const ev of events) { if (ev.note !== null) ev.instrument = 1; delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'vrc6saw') {
      // VRC6のこぎり波: 音色指定は無い(音量は0-63だが借用元の0-15をそのまま使う。src/convert/borrow.js と同じ)
      for (const ev of events) { delete ev.instrument; delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; }
      ch.hasInstrument = false; ch.hasVrc7Tone = false;
    } else if (fam === 'fds') {
      // FDS: 元が波形を持つ(SCC/PCM/FM音色の定常波形)ならそれを64サンプル/0-63へ引き伸ばし、
      // 無ければ矩形波を @FM に登録して音色にする
      const forced = MML.Convert.Borrow.toneWave(tone);
      for (const ev of events) {
        if (ev.note === null) { delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; continue; }
        const derived = forced ? null : (TD ? TD.n163WaveForEvent(ev, s, deriveRegs) : null);
        const src16 = forced || derived || ((ev.n163Wave && ev.n163Wave.length) ? ev.n163Wave : N163_SQUARE_WAVE);
        ev.instrument = fdsWaveReg.assign(toFdsWave(src16));
        delete ev.rawLength; delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch;
      }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'triangle') {
      // 三角波: 音量・音色は無い。音程だけ
      for (const ev of events) { delete ev.volume; delete ev.envelopeV; delete ev.envelopeVr; delete ev.instrument; delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; }
      ch.hasVolume = false; ch.hasEnvelope = false; ch.hasInstrument = false; ch.hasVrc7Tone = false;
    }
  }
  // 0-15/任意長の波形(N163形式)を FDS の 64サンプル/0-63 へ(最近傍で引き伸ばす)
  function toFdsWave(w) {
    const n = w.length, max = Math.max(1, ...w);
    const out = new Array(64);
    for (let i = 0; i < 64; i++) out[i] = Math.max(0, Math.min(63, Math.round(w[Math.floor(i * n / 64)] * 63 / max)));
    return out;
  }

  /**
   * @param {Uint8Array} vgmBytes - 解凍済みVGM
   * @param {number} durationSeconds
   * @param {object} [options] - { bpm }
   */
  MML.VGM2MML.fromVgm = async function (vgmBytes, durationSeconds, options) {
    options = options || {};
    let data = await MML.Emu.captureVgmSongAsync(vgmBytes, { durationSeconds: durationSeconds || 60 }, options.onProgress || null);
    // チャンネルプール/ペア交互割当チップの表示モード(鍵盤ヘッダの切替UIと同じ語彙)。
    // 'logical'=割当逆算(合成ch)で変換。既定はMultiPCMのみ合成(完全プール式で
    // 既定8枠カバー率45%→100%の劇的改善)、他は実機スロット(ペア交互でも音符
    // ストリームはほぼ安定で、マルチサンプル曲では合成が僅かに劣るケースもあるため)。
    const POOL_CONVERT_DEFAULTS = { multipcm: 'logical', c352: 'phys', qsound: 'phys', c140: 'phys', segapcm: 'phys' };
    const pm = options.poolMode || {};
    for (const key of Object.keys(POOL_CONVERT_DEFAULTS)) {
      const mode = pm[key] || POOL_CONVERT_DEFAULTS[key];
      if (mode === 'logical' && data[key] && data[key].logical) {
        // pooled: 合成chのレーン(convertData が複製パートを探す対象。src/convert/poolDoubles.js)
        data = Object.assign({}, data, { [key]: Object.assign({}, data[key], { snapshots: data[key].logical, pooled: true }) });
      }
    }
    return MML.VGM2MML.convertData(data, options);
  };

  /**
   * キャプチャ済みデータ(captureVgmSongAsync の data と同じ形)を MML へ変換する。
   * VGM 以外でも、同じ形のデータを作れば PCM チップ経路をそのまま使える(PSF: src/psf2mml/converter.js)。
   * data: { frameRate, totalFrames, header:{chips, usedChips, gd3}, <chip>:{snapshots, samples?} }
   */
  MML.VGM2MML.convertData = function (data, options) {
    options = options || {};
    const h = data.header;
    // 合成chの複製パート(デチューン二重化/エコー。src/convert/poolDoubles.js)。FOLD_DOUBLES なら複製ノートを外し、
    // そうでなくても検出結果(doubles)を持たせて、下の「音符の多いch上位への自動選択」で複製を後回しにする
    const doubleNotes = [];
    const PD = MML.Convert.PoolDoubles;
    if (PD) {
      const foldOn = MML.Convert.normalizeCmd(options.cmd).FOLD_DOUBLES;
      let srcList = null;
      for (const d of DRUM_CHIPS) {
        const cd = data[d.data];
        if (!cd || !cd.pooled || !Array.isArray(cd.snapshots) || d.shape !== 'pcm') continue;
        const found = PD.find(cd.snapshots);
        const next = Object.assign({}, cd, { doubles: found, doublesFolded: false });
        if (foldOn && found.groups.length) {
          next.snapshots = PD.fold(cd.snapshots, found);
          next.doublesFolded = true;
          srcList = srcList || MML.VGM2MML.sourceChannels(h);
          const labelOf = (li) => { const s = srcList.find(x => x.chip === d.flag && x.ch === li); return s ? s.label : `${d.name} ${li}`; };
          doubleNotes.push(`合成chの複製パートを省きました: ${PD.describe(found, labelOf).join('、')}。`);
        }
        data = Object.assign({}, data, { [d.data]: next });
      }
    }
    const title = gd3Field(h, 'trackEn', 'trackJa');
    const game = gd3Field(h, 'gameEn', 'gameJa');
    const author = gd3Field(h, 'authorEn', 'authorJa');
    const label = [game, title].filter(Boolean).join(' - ') || options.sourceLabel || 'VGM';

    // 変換ファミリ: PSG系(AY/SCC/OPLL/SN、同居可) / NES / GB / HES。複数同居していれば先頭だけ。
    const families = [];
    const msmDrum = !!(h.chips && h.chips.msm5205) && (options.drumHits || []).some(x => x.chId === 'M5');
    if (data.kss || data.sn || data.ym2612 || data.ym2610fm || data.ym2151 || data.ym2203fm || data.ym2608fm || data.ga20 || data.k007232 || data.segapcm || data.c140 || data.c352 || data.qsound || data.okim6295 || data.multipcm || data.psx) families.push('psg');
    if (data.nes) families.push('nes');
    if (data.gb) families.push('gb');
    if (data.hes) families.push('hes');
    if (families.length === 0) {
      const names = h.usedChips.map(ch => ch.name).join(', ') || '-';
      throw new Error(tr('MML変換に対応した音源がありません({chips})', { chips: names }));
    }
    const family = families[0];
    const famOf = { ay8910: 'psg', k051649: 'psg', ym2413: 'psg', sn76489: 'psg', ym2610: 'psg', ym2612: 'psg', ym2151: 'psg', ym2203: 'psg', ym2608: 'psg', ym3812: 'psg', ym3526: 'psg', y8950: 'psg', ga20: 'psg', k007232: 'psg', segapcm: 'psg', c140: 'psg', c352: 'psg', qsound: 'psg', okim6295: 'psg', multipcm: 'psg', psx: 'psg', nes: 'nes', gb: 'gb', huc6280: 'hes' };
    // ストリーミングDAC(YM2612 DAC / OKIM6258)は旋律の変換対象ではないが、main.js が
    // ログから打点を取って options.drumHits で渡してくると E(DPCM) へ焼かれる(2026-09-05)。
    // その場合は「無視した」と言わない(X68000曲は音源がYM2151+OKIM6258しか無いので目立つ)
    const dacDrumChip = { OKI: 'okim6258', YMDA: 'ym2612', PWL: 'pwm', M5: 'msm5205' };
    const dacDrumChips = new Set((options.drumHits || []).map(x => dacDrumChip[x.chId]).filter(Boolean));
    const ignoredChips = h.usedChips.filter(ch => (!ch.impl || famOf[ch.id] !== family) && !dacDrumChips.has(ch.id)).map(ch => ch.name);
    const ignoredNotes = doubleNotes.slice();
    if (dacDrumChips.has('okim6258')) ignoredNotes.push('OKIM6258(ADPCM)の打点は E(DPCM) へ変換しています(DACストリームの開始アドレスでサンプルを同定)。');
    if (dacDrumChips.has('pwm')) ignoredNotes.push('32X PWM のストリームは無音の切れ目でクリップに分けて E(DPCM) へ変換しています(長いクリップは区間に分割)。');
    if (dacDrumChips.has('msm5205')) ignoredNotes.push('MSM5205(ADPCM)のストリームは無音の切れ目でクリップに分けて E(DPCM) へ変換しています(長いクリップは区間に分割)。');
    // 音程が取れなかったサンプルの行方は options.cmd.DRUM で変わる(休符 / ドラムパートへ)
    const drumOn = MML.Convert.normalizeCmd(options.cmd).DRUM !== false;
    const noPitchNote = drumOn
      ? '(音程の取れないドラム/効果音は「Drums」パートへまとめました)'
      : '(ドラム/効果音等の音程なしサンプルは休符)';
    if (ignoredChips.length) ignoredNotes.push(`このVGMは複数の音源を含みます。${ignoredChips.join(', ')} はMML変換の対象外のため無視しました。`);
    // YM2612 ch6 DAC(PCMストリーム)は音程情報が無いので対象外
    if (h.chips.ym2612 && family === 'psg') ignoredNotes.push('YM2612 の ch6 DAC(PCM)は変換対象外です。');
    if (h.chips.ym2610 && family === 'psg') ignoredNotes.push(`YM2610 ADPCM-A/B はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.ym2608 && family === 'psg') ignoredNotes.push(`YM2608 の内蔵リズムはドラムパートへ、ADPCM-B はピッチ解析で音程が取れた区間だけ音符にしています(リズムROM未読込時はリズムの音符は出ません)。`);
    if ((h.chips.ym3812 || h.chips.ym3526 || h.chips.y8950) && family === 'psg') ignoredNotes.push(`OPLのリズムモード打楽器${h.chips.y8950 ? 'とY8950のADPCM' : ''}は変換対象外です(メロディchのみ。音色はOPLLカスタム音色へ変換)。`);
    if (h.chips.ga20 && family === 'psg') ignoredNotes.push(`GA20 PCM はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.k007232 && family === 'psg') ignoredNotes.push(`K007232 PCM はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.segapcm && family === 'psg') ignoredNotes.push(`SegaPCM はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.c140 && family === 'psg') ignoredNotes.push(`C140 はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.c352 && family === 'psg') ignoredNotes.push(`C352 はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.qsound && family === 'psg') ignoredNotes.push(`QSound はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.okim6295 && family === 'psg') ignoredNotes.push(`OKIM6295 はフレーズのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.multipcm && family === 'psg') ignoredNotes.push(`MultiPCM はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    if (h.chips.psx && family === 'psg') ignoredNotes.push(`PlayStation SPU はサンプルのピッチ解析で音程が取れた区間だけ音符にしています${noPitchNote}。`);
    const ignoredNote = ignoredNotes.length ? ignoredNotes.join(' ') : null;

    let result;
    if (family === 'psg') {
      // 基準ピッチ(#TUNING)の自動検出(src/convert/options.js autoTune)。nes/gb/hes ファミリは
      // 委譲先(NSF2MML.convert 等)の入口が同じ仕組みで包んでいる
      result = MML.Convert.autoTune(options, (o) => composePsgLike(data, h, label, o, ignoredNote));
      // ★N163 の波形 RAM: 変換時の見積り(N163Fit、LEN_SNAP 分の余裕つき)で収めても、書き出した MML の音長は
      //   量子化とテンポの丸めで曲の後半ほど大きくずれ、コンパイルで「空き不足」になることがある(PSF の 30 秒変換で
      //   Star Ixiom / Ogre Battle / Namco Anthology 2 が該当)。実際にコンパイルして不足が出たときだけ、
      //   常駐区間の余裕を広げて変換し直す。コンパイルできる曲の出力は変わらない。
      //   余裕を広げるだけでは足りない場合(同じバイト数でも断片化の仕方が見積りと違う)に備え、コンパイラが
      //   置けなかった波形はやり直しのたびに1段ずつ縮める。変換設定 N163_WAVE='keep' のときは何もしない
      const cmdN = MML.Convert.normalizeCmd(options.cmd);
      if (cmdN.N163_WAVE !== 'keep' && MML.Mml && MML.Mml.compile && (result.expansions || []).indexOf('n163') >= 0) {
        const ramErrors = (mml) => {
          try { return (MML.Mml.compile(mml, {}).errors || []).filter(e => e.kind === 'n163Ram'); }
          catch (e) { return []; }
        };
        const force = {};
        let extra = 0;
        for (let attempt = 0; attempt < 12; attempt++) {
          const errs = ramErrors(result.mml);
          if (!errs.length) break;
          extra = extra ? Math.min(extra * 2, 128) : 8;
          for (const er of errs) if (er.instrument != null) force[er.instrument] = (force[er.instrument] || 0) + 1;
          result = MML.Convert.autoTune(Object.assign({}, options, { n163ExtraMargin: extra, n163ForceHalve: Object.assign({}, force) }),
            (o) => composePsgLike(data, h, label, o, ignoredNote));
        }
      }
    } else if (family === 'nes') {
      const header = {
        extraChips: data.nes.fds ? MML.NSF.CHIP_FLAGS.FDS : 0,
        songName: label, artist: author, copyright: '', totalSongs: 1
      };
      // $4015を一度も書かないVGMでもチャンネルが有効扱いになるよう既定値を補う
      const initRegs = { 0x4015: 0x0F };
      // DPCMサンプル本体はNSFのようなファイル内ROMではなく、VGMのデータブロック
      // (0x67 type=0xC2)でエミュレータのメモリへ書き込まれた$C000-$FFFF(vgmPlayer.jsが
      // キャプチャ末尾で切り出したdata.nes.dpcmRom)から解決する
      const nesOptions = Object.assign({}, options,
        data.nes.dpcmRom ? { dpcmRom: { bytes: data.nes.dpcmRom, loadAddr: 0xC000 } } : {});
      result = MML.NSF2MML.convert(data.nes.writeLog, null, header, 0, initRegs, null, nesOptions);
      result.chips = ['2A03'].concat(data.nes.fds ? ['FDS'] : []);
    } else if (family === 'gb') {
      result = MML.GBS2MML.convertCapture({
        snapshots: data.gb.snapshots, frameRate: data.frameRate, songLabel: label, sourceLabel: 'VGM'
      }, options);
    } else if (family === 'hes') {
      // vgmPlayer.js は HuC6280 の書込みトレースを {ch,...} 付きの平坦な1本で積む
      // (Worker差分プロトコルの都合)。hes2mml が期待する ch別配列へ振り分ける。
      // 旧キャプチャ(ctlTrace無し)は空配列=従来のスナップショット列にフォールバック。
      const splitByCh = (flat) => {
        const per = Array.from({ length: MML.Hes2MmlExpansion.CH_COUNT }, () => []);
        for (const e of (flat || [])) if (per[e.ch]) per[e.ch].push(e);
        return per;
      };
      result = MML.HES2MML.convertCapture({
        snapshots: data.hes.snapshots, dpcmTrace: [],
        controlTrace: splitByCh(data.hes.ctlTrace), pitchTrace: splitByCh(data.hes.pitchTrace),
        frameRate: data.frameRate, trackLabel: label, sourceLabel: 'VGM'
        // PC Engine CD の E(DPCM) は HuC6280 の DDA ではなく MSM5205 の ADPCM が出どころなので、
        // hes2mml の見出し(既定「PSG DDA」)を差し替える
      }, Object.assign({}, options, msmDrum ? { dpcmLabel: 'MSM5205 ADPCM' } : null));
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
