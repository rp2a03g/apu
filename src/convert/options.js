/*
 * *2MML 変換設定(コマンド使用/不使用・譜面整形)の共通定義
 *
 * 目的(2026-08-24): 熟練者が「ほぼ音階だけのプレーンな譜面」から自分で編曲を始められる
 * ように、各 *2mml がセント単位の補正コマンド(D/EP/MP/PT/EN)や音量エンベロープ(@v等)を
 * 出す/出さないを選べるようにする。全6形式(nsf/spc/kss/gbs/hes/vgm)で共通の1つの
 * オブジェクト options.cmd を受け取り、
 *   (1) 割当層(EnvelopeRegistry/PitchEnvelopeRegistry/NoteEnvelopeRegistry/detune.js)で
 *       登録自体を止める(→ ヘッダの @v/@EP/@MP/@EN テーブル定義も自然に消える)
 *   (2) 出力層(mmlEmit.js emitScore/emitChannel)でチャンネルフラグをANDマスクする(安全網)
 *   (3) 譜面整形(短い休符の吸収・音長の格子量子化)を emitScore 手前のイベント整形で行う
 * の3段で効かせる。
 *
 * cmd の各キー(全て boolean。省略時は true = 従来通り忠実再現):
 *   D      … D<n>(チャンネル/チップ間デチューン、detune.js)
 *   EP     … EP<n>(ピッチエンベロープ。MP/PT の受け皿でもある)
 *   MP     … MP<n>(ビブラート)。falseで EP が true なら周期EPテーブルへ落ちる
 *   PT     … PT<n>(ポルタメント)。falseで EP が true なら非ループEPテーブルへ落ちる
 *   EN     … EN<n>(高速アルペジオのノートエンベロープ)。false時はアルペジオ統合
 *            (mergeRapidArpeggio)自体は行い、基音1音として出す(音符連打には戻さない。
 *            編曲の出発点としては1音の方が読みやすいため)
 *   ENV    … @v/@vr(ソフト/ハード音量エンベロープ)と FME7 の S/M。false時は各イベントの
 *            音量列のピーク値を v<n> として出す(MML.Convert.plainVolume)
 *   V      … v<n>(音量そのもの)。false なら v も出さず既定音量
 *   SWEEP  … s<speed>,<depth>(2A03ハードウェアスイープ)
 *   INST   … @<n>(音色/デューティ)、OP<n>(VRC7音色)、MH<n>(FDS変調)、N<n>(FME7ノイズ周期)
 *   DRUM   … VGMのサンプルPCM(C140/C352/QSound/MultiPCM/SegaPCM/GA20/OKIM6295/YM2610
 *            ADPCM-A)で音程が取れなかった発音=打楽器を、1本のドラムパートとして音符化する
 *            (サンプルごとに疑似音程を割り当てる。src/convert/drumMap.js)。falseなら従来
 *            どおり休符(ドラムはMMLに出ない)
 *
 * 譜面整形(既定 false = 従来通り):
 *   SHAPE_REST  … 音符の直後の短い休符(1/32未満)を音符に吸収(ゲートタイムの隙間除去)
 *   SHAPE_QUANT … イベント境界を16分音符格子へ丸める
 *
 * 値キー(booleanでない設定。2026-08-26):
 *   PITCH_SA … N163出力のSA<num>(ピッチシフト量)自動選択。'octave' | 'note' | 'off'
 *     EP/MP/Dテーブル値のbyte幅とN163周波数レジスタ18bitの桁差を埋める(選び方の詳細は
 *     src/convert/pitch.js n163SaForBase冒頭コメント参照)。既定'octave'(オクターブ連動、
 *     セント精度がオクターブ非依存でテーブル共有も効く)。'note'=音符ごと最高精度、
 *     'off'=SA不使用(従来互換、深い変調は割当失敗して落ちる)。
 *   N163_WAVE … N163内蔵RAM(波形に使えるのは 128-8*有効ch数 バイト)に波形が収まらないときの扱い。
 *     'fit'(既定) … 収まるまで波形長を半分ずつ落とす(32→16→8→4サンプル)。★曲全体を一律に
 *       落とすのではなく「あふれた瞬間に居る波形」を大きい順に、必要な数だけ縮める。縮めた
 *       ぶんはヘッダコメントに明記する。8ch使う曲(1chあたり8バイト=16サンプルが上限)の
 *       アーケード系VGMなど、実機のN163曲でも普通に行う詰め方。
 *     'keep' … 元の波形長のまま出す。収まらない曲はコンパイルエラーで再生も書き出しも
 *       できないが、本家ppmckへ持って行って手で詰め直したい場合はこちら。
 *
 * DPCM(打楽器)キー(2026-09-05、変換設定ダイアログからドラム(DPCM)パネル最下段へ移動):
 *   DMC_RATE  … サンプルごとのDMCレート指定が「自動」のときに使うレート。DMCレート表
 *     (MML.Dpcm.DMC_RATE_TABLE_NTSC)のindex 0..15、既定15(33.1kHz)。1bitデルタ変調は
 *     1bitあたり±2/127しか動けないため、レートが追従能力(アタックのなまり)とアイドルトーン
 *     (平坦部で乗るレート/2のキーン音)を直接決める。音質とデータ量はレートに比例する。
 *     ★旧 PCM_RATE('max'|8|4|2|1=ソースレートの倍率方式)は廃止。サンプルPCMは再生レートが
 *       DMC上限以上のことが多く倍率方式が効かなかった。旧キーは読み捨てる(数値が衝突するため
 *       キー名を変えた)
 *   RATE_MIX  … 同時に鳴った打点のDMCレート指定が食い違うとき、'quality'=高い方 / 'size'=低い方
 *   DRUM_POLY … 打点が重なったとき 'mix'=その瞬間の音をミックスして1クリップ / 'mono'=直近1音
 *   これらはプリセット(忠実再現/プレーン譜面)の一致判定に含めない(パネル側の独立した設定)。
 *   全形式のドラム(DPCM)経路(src/convert/drumHits.js)が見る。
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  MML.Convert = MML.Convert || {};

  const CMD_KEYS = ['D', 'EP', 'MP', 'PT', 'EN', 'ENV', 'V', 'SWEEP', 'INST', 'DRUM'];
  const SHAPE_KEYS = ['SHAPE_REST', 'SHAPE_QUANT'];
  const PITCH_SA_VALUES = ['octave', 'note', 'off'];
  // ── DPCM(打楽器)キー(冒頭コメント参照)。ドラム(DPCM)パネル最下段の設定 ──
  // DMC_RATE: DMCレート表のindex(0=4.2kHz … 15=33.1kHz)。「自動」のサンプルに使う
  const DMC_RATE_MAX = 15;
  // 同時発音をミックスして1サンプルに焼くときのDMCレートの決め方
  //   'quality' … 寄与するサンプルのうち高い方を採る(既定)
  //   'size'    … 低い方に合わせて容量を優先する
  const RATE_MIX_VALUES = ['quality', 'size'];
  MML.Convert.RATE_MIX_VALUES = RATE_MIX_VALUES;
  // 打楽器の同時発音の扱い(src/convert/drumHits.js poly)
  //   'mix'  … その瞬間に鳴っている打点をミックスして1クリップに焼く(既定、忠実)
  //   'mono' … ミックスしない。直近に叩かれた打点だけを鳴らす(定義がサンプル数までしか
  //            増えないので容量制御に使う。実測: NCS91002 はミックス54定義36KB→単音7定義)
  const DRUM_POLY_VALUES = ['mix', 'mono'];
  MML.Convert.DRUM_POLY_VALUES = DRUM_POLY_VALUES;
  const DPCM_KEYS = ['DMC_RATE', 'RATE_MIX', 'DRUM_POLY'];
  const DPCM_DEFAULTS = { DMC_RATE: DMC_RATE_MAX, RATE_MIX: 'quality', DRUM_POLY: 'mix' };
  MML.Convert.DPCM_KEYS = DPCM_KEYS;
  MML.Convert.DPCM_DEFAULTS = DPCM_DEFAULTS;
  // N163内蔵RAMに波形が収まらないときの扱い(冒頭コメント参照)
  const N163_WAVE_VALUES = ['fit', 'keep'];
  MML.Convert.N163_WAVE_VALUES = N163_WAVE_VALUES;
  MML.Convert.CMD_KEYS = CMD_KEYS;
  MML.Convert.SHAPE_KEYS = SHAPE_KEYS;
  MML.Convert.PITCH_SA_VALUES = PITCH_SA_VALUES;

  const PRESETS = {
    // 忠実再現(従来の既定)
    faithful: { D: true, EP: true, MP: true, PT: true, EN: true, ENV: true, V: true, SWEEP: true, INST: true, DRUM: true,
                SHAPE_REST: false, SHAPE_QUANT: false, PITCH_SA: 'octave', N163_WAVE: 'fit' },
    // プレーン譜面: 音階+音色だけ。編曲の出発点用
    plain:    { D: false, EP: false, MP: false, PT: false, EN: false, ENV: false, V: false, SWEEP: false, INST: true, DRUM: true,
                SHAPE_REST: true, SHAPE_QUANT: true, PITCH_SA: 'octave', N163_WAVE: 'fit' },
  };
  MML.Convert.CMD_PRESETS = PRESETS;

  // options.cmd(部分指定可)を全キー揃った正規形にする。省略キーは faithful 既定
  // (DPCMキーは DPCM_DEFAULTS)。
  MML.Convert.normalizeCmd = function (cmd) {
    const out = Object.assign({}, DPCM_DEFAULTS, PRESETS.faithful);
    if (cmd && typeof cmd === 'object') {
      for (const k of [...CMD_KEYS, ...SHAPE_KEYS]) if (cmd[k] != null) out[k] = !!cmd[k];
      // 数値は文字列でも受ける(localStorage/JSON経由やUIのselect値が'14'等になるため)
      if (cmd.DMC_RATE != null) {
        const v = parseInt(cmd.DMC_RATE, 10);
        if (v >= 0 && v <= DMC_RATE_MAX) out.DMC_RATE = v;
      }
      if (cmd.PITCH_SA != null && PITCH_SA_VALUES.indexOf(cmd.PITCH_SA) >= 0) out.PITCH_SA = cmd.PITCH_SA;
      if (cmd.RATE_MIX != null && RATE_MIX_VALUES.indexOf(cmd.RATE_MIX) >= 0) out.RATE_MIX = cmd.RATE_MIX;
      if (cmd.DRUM_POLY != null && DRUM_POLY_VALUES.indexOf(cmd.DRUM_POLY) >= 0) out.DRUM_POLY = cmd.DRUM_POLY;
      if (cmd.N163_WAVE != null && N163_WAVE_VALUES.indexOf(cmd.N163_WAVE) >= 0) out.N163_WAVE = cmd.N163_WAVE;
    }
    return out;
  };

  // どれかがプリセットと完全一致すればその名前、無ければ 'custom'。
  // DPCMキー(DPCM_KEYS)はドラム(DPCM)パネル側の設定なので一致判定に含めない
  MML.Convert.cmdPresetName = function (cmd) {
    const n = MML.Convert.normalizeCmd(cmd);
    for (const name of Object.keys(PRESETS)) {
      const p = MML.Convert.normalizeCmd(PRESETS[name]);
      if ([...CMD_KEYS, ...SHAPE_KEYS, 'PITCH_SA', 'N163_WAVE'].every(k => p[k] === n[k])) return name;
    }
    return 'custom';
  };

  // ── チャンネル別の変換音量(2026-08-25) ──────────────────────────────
  // 規約: options.channelMap[ch].volPct = 0..100(既定100)。そのチャンネルの変換時
  // 音量を何%にするかの縮小専用の比率(v15等で頭打ちのため上げる方向は無い)。
  // パート(借用先)指定・音色指定と組で、SPC以外のフォーマットのチャンネル割当UIにも
  // 同じキー名・同じ意味で展開する予定の共通規約。計算はこのヘルパーに一本化する。
  MML.Convert.channelVolScale = function (cfg) {
    const p = cfg && cfg.volPct != null ? parseFloat(cfg.volPct) : 100;
    if (!isFinite(p)) return 1;
    return Math.max(0, Math.min(100, p)) / 100;
  };

  // エンベロープを出さない時の代表音量: 音量列(または{values}形状)のピーク値。
  // 先頭値だとアタック途中(0から立ち上がる音源)の値になることがあるため最大値を取る。
  MML.Convert.plainVolume = function (seqOrShape) {
    const seq = Array.isArray(seqOrShape) ? seqOrShape : (seqOrShape && seqOrShape.values) || [];
    let m = null;
    for (const v of seq) if (typeof v === 'number' && (m === null || v > m)) m = v;
    return m === null ? 0 : m;
  };

  // mmlEmit.js の per-channel フラグを cmd でANDマスクする(出力層の安全網)
  MML.Convert.maskEmitFlags = function (flags, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    const f = Object.assign({}, flags);
    if (!c.D)     f.hasDetune = false;
    if (!c.EP && !c.MP && !c.PT) f.hasPitchMod = false;
    if (!c.EN)    f.hasNoteEnv = false;
    if (!c.ENV)   { f.hasEnvelope = false; f.hasFme7Env = false; }
    if (!c.V)     f.hasVolume = false;
    if (!c.SWEEP) f.hasSweep = false;
    if (!c.INST)  { f.hasInstrument = false; f.hasVrc7Tone = false; f.hasFdsMod = false; f.hasFme7Noise = false; }
    return f;
  };

  // ── 譜面整形 ───────────────────────────────────────────────────────
  // events: mmlEmit.js と同じ { start, end, note, ... } の配列(フレーム単位、昇順前提)。
  // 新しい配列を返す(元は変更しない)。
  //   SHAPE_REST : 音符の直後の休符(または隙間)が restThreshold フレーム未満なら直前の
  //                音符を延ばして埋める(ゲートタイムの隙間除去)
  //   SHAPE_QUANT: 各イベントの start を grid フレーム格子へ丸め、end は次イベントの start
  //                (最後は元の end を丸めた値)。長さ0になったイベントは捨てる
  MML.Convert.shapeEvents = function (events, fpb, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    if (!c.SHAPE_REST && !c.SHAPE_QUANT) return events;
    let evs = (events || []).slice().sort((a, b) => a.start - b.start).map(e => Object.assign({}, e));

    if (c.SHAPE_REST) {
      const restThreshold = fpb / 8; // 1/32 音符未満
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const prev = out[out.length - 1];
        if (ev.note === null && prev && prev.note !== null && (ev.end - ev.start) < restThreshold) {
          prev.end = Math.max(prev.end, ev.end); // 休符を直前の音符へ吸収
          continue;
        }
        // 明示休符が無い単なる隙間も同じ扱い(fillGaps が後で休符化する前に埋める)
        if (prev && prev.note !== null && ev.start > prev.end && (ev.start - prev.end) < restThreshold) {
          prev.end = ev.start;
        }
        out.push(ev);
      }
      evs = out;
    }

    if (c.SHAPE_QUANT) {
      const grid = fpb / 4; // 16分音符
      const snap = (f) => Math.round(f / grid) * grid;
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const s = snap(ev.start);
        const e = (i + 1 < evs.length && evs[i + 1].start <= ev.end) ? snap(evs[i + 1].start) : snap(ev.end);
        if (e <= s) continue;
        const prev = out[out.length - 1];
        if (prev && prev.end > s) prev.end = s;
        if (prev && prev.end <= prev.start) out.pop();
        out.push(Object.assign(ev, { start: s, end: e }));
      }
      evs = out;
    }
    return evs;
  };
})(window);
