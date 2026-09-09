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
 *   (3) 譜面整形(短い休符の吸収)を emitScore 手前のイベント整形で行う
 * の3段で効かせる。
 * これとは別に、音符の区切り方(NOTE_END、下記)は各 *2mml が emitScore の直前に
 * MML.Convert.applyNoteEnd(src/convert/envelope.js)を呼んで効かせる
 * (エンベロープ表の登録先が要るため emitScore 内では行えない)。
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
 * 譜面整形(既定 false = 従来通り。★近似=音が変わりうる整形はここに集める):
 *   GATE_APPROX … ゲートを揃える(2026-09-08、既定 true)。NOTE_END='next' のゲート候補に、キーオフ位置の
 *                 ずれが GATE_TOL フレーム以内の q<n> も許し、切り替えを重くしてチャンネルの大半を1つの
 *                 q で書く(休符や k<len> の細切れを出さない)。レガートと長い無音は切らない。false なら
 *                 厳密一致のゲートだけ(以前の挙動)
 *   GATE_TOL    … その許容フレーム数(0〜8、既定2)
 *   PART_ORDER/BARS_PER_LINE/BAR_ALIGN/CHANNEL_ORDER … 出力の書式(2026-09-08、本ファイル LAYOUT_DEFAULTS
 *                 参照。プリセット外)。CHANNEL_ORDER='letter' はアルファベット順(既定)、'source' は
 *                 変換元の割り当て順(各 *2mml が積んだ順=元の音源のチャンネル順)
 *   LEN_SNAP    … 音長を丸める(2026-09-08、既定2フレーム、0=厳密)。音符/休符の長さがこのフレーム数以内で
 *                 大きな音価に乗るならタイの列(4&2&8..&64.&192)にせず 1 個で書き、余りは次の音符へ持ち越す
 *                 (src/convert/duration.js framesToLengths の slackFrames。持ち越しは ±許容に収め、一致は持ち越し込みで
 *                 許容の2倍以内の最も近い音価。小節線から許容以内の音符は小節線で割らない)。ドライバのテンポが小数で音符長が
 *                 ±1〜2 フレーム揺れる曲(ppmck の t71 等)の譜面を素直にする。境界のずれは最大このフレーム数
 *   LEN_DP      … 音長をチャンネル全体で最適化する(2026-09-09、忠実再現=ON / プレーン譜面=OFF)。音符ごとに
 *                 直前の余りだけ見て最も近い音価を選ぶ greedy(framesToLengths)の代わりに、チャンネルの全イベント
 *                 列を見渡して「音価の書きにくさ+境界の位置ずれ(フレーム)²」の合計が最小の割り当てを動的計画法で
 *                 選ぶ(duration.js quantizeSeq)。速いテンポで 5,5,5,6 フレームと揺れる16分が `24..` に化ける、
 *                 3連8分の隣で持ち越しが逆向きに溜まり `16.` になる、を直す。境界のずれは常に LEN_SNAP 以内に
 *                 収める(greedy は持ち越しの超過を捨てて黙ってずれる)ので、格子に乗らない音符の多い実曲では
 *                 3連系やタイが少し増える。合成曲の往復テストで音長一致 91%→97%
 *   DPCM_EXACT  … 分割したDPCMの音長は丸めない(2026-09-09、既定 true)。DMC 1本の上限(4080バイト)を超える
 *                 打点は src/convert/drumHits.js がフレーム整数の区間へ分割し、区間ごとに @DPCM 定義と打点を
 *                 立てて連続再生する(ストリーム再生)。その区間の音長を LEN_SNAP/LEN_DP の丸めから外して
 *                 厳密に書く。丸めると区間の継ぎ目に空白/食い込みが出るため。false なら普通の音符と同じ扱い
 *   ENV_MERGE   … 似た @v 表を統合する(2026-09-08)。値の並び(段の値列)が同じで各段の長さが±1・全体長も
 *                 ±1以内の表を、最も多くの音符が参照する変種へ寄せる(EnvelopeRegistry.mergeSimilar)。
 *                 ドライバのエンベロープが自走タイマー(2.33フレーム周期等)で進む曲では段の位置が音符の
 *                 開始位相ごとに違い、同じ楽器でも 3,2,2 / 2,3,2 / 2,2,3 の変種が量産される。ppmck の
 *                 @v はフレーム毎の絶対値なので正確に1本にはできず、これは段の境目が最大1フレーム動く
 *                 近似(ハードウェア減衰表・exact 表は対象外)
 *   SHAPE_REST  … 音符の直後の短い休符(1/32未満)を音符に吸収(ゲートタイムの隙間除去)。
 *                 伸ばした区間は最後の音量のまま鳴るので近似
 *   (旧 SHAPE_QUANT「16分音符格子へ丸める」は 2026-09-07 に廃止。キーオン自体が格子から
 *    外れている曲にしか効かず、丸めれば必ずタイミングが崩れるため。保存済み設定に残って
 *    いても読み捨てる)
 *
 * 音符の区切り(2026-09-07。細かい音長 `@v156 d+4&d+64.&d+192 r…` 対策):
 *   NOTE_END … 'next'(既定) | 'zero'
 *     抽出器は音量レジスタが0になった瞬間に音符を閉じるため、音長が「減衰が0に達した
 *     フレーム」というテンポ格子と無関係な値になる(同じ情報は @v 表にもあり二重表現)。
 *     'next' … 音符の直後の休符を音符に吸収して次の音符の頭まで伸ばす(音長=キーオン間隔)。
 *              無音区間は、減衰が自然に0へ到達した@v付き音符なら @v表の末尾に 0 を1つ足して
 *              (コンパイラ stepEnvelope も NSF ドライバも末尾値を保持する)、それ以外は
 *              ゲートタイム q<n>/@q<n>(コンパイラはゲートオフを休符と同じに書く)で表す。
 *              どちらも再生結果は完全に同じ(タイミング不変の厳密な変形)
 *     'zero' … 従来どおり音量0で区切る(最も細かく、そのままの姿)
 *     詳細・対象外は envelope.js applyNoteEnd 冒頭コメント。
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
 *
 * 基準ピッチ(全体オフセット、2026-09-07。下の MML.Convert.detectTuning 冒頭コメント参照):
 *   TUNING     … 'auto'(既定) = 曲全体の音程偏差の中央値を測り、その分ずらした基準で音符へ丸めて
 *                `#TUNING <cent>` をヘッダに出す / 'a440' = 従来どおり A4=440Hz の12平均律固定
 *   TUNING_MIN … 'auto' のとき、測った偏差の絶対値がこのセント数未満なら何もしない(既定5、0〜50)。
 *                閾値未満の曲の出力は 'a440' と完全に同じ
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  MML.Convert = MML.Convert || {};

  const CMD_KEYS = ['D', 'EP', 'MP', 'PT', 'EN', 'ENV', 'V', 'SWEEP', 'INST', 'DRUM'];
  const SHAPE_KEYS = ['SHAPE_REST', 'ENV_MERGE', 'GATE_APPROX'];
  // GATE_TOL: ゲートを揃える(GATE_APPROX)ときに許すキーオフ位置のずれ(フレーム、0〜8、既定2)
  const GATE_TOL_DEFAULT = 2, GATE_TOL_MAX = 8;
  MML.Convert.GATE_TOL_DEFAULT = GATE_TOL_DEFAULT;
  MML.Convert.GATE_TOL_MAX = GATE_TOL_MAX;
  // LEN_SNAP: 音長を丸める許容フレーム数(0=厳密(192分)、1〜4、既定2。src/convert/duration.js framesToLengths)
  const LEN_SNAP_DEFAULT = 2, LEN_SNAP_MAX = 4;
  MML.Convert.LEN_SNAP_DEFAULT = LEN_SNAP_DEFAULT;
  MML.Convert.LEN_SNAP_MAX = LEN_SNAP_MAX;
  MML.Convert.lenSnapOf = (cmd) => (cmd && cmd.LEN_SNAP > 0) ? Math.min(LEN_SNAP_MAX, cmd.LEN_SNAP) : 0;
  // LEN_DP: 音長をチャンネル全体で最適化する(2026-09-09、src/convert/duration.js quantizeSeq)。
  // 忠実再現プリセットは ON、プレーン譜面は OFF(格子に乗らない実曲では 3連系やタイが増えるため)
  MML.Convert.lenDpOf = (cmd) => !!(cmd && cmd.LEN_DP);
  // DPCM_EXACT: 分割したDPCM(ストリーム再生の区間、src/convert/drumHits.js)の音長を LEN_SNAP/LEN_DP の
  // 丸めから外して厳密に書く(2026-09-09、既定ON。省略時もON=未指定の古い設定と互換)。
  // 区間の長さがずれると継ぎ目に空白/食い込みが出るため
  MML.Convert.dpcmExactOf = (cmd) => !(cmd && cmd.DPCM_EXACT === false);

  // ── チャンネルの並び順(2026-09-09) ──────────────────────────────────────
  // 各 *2mml は scoreChannels へ「元の音源のチャンネル順」で積み、最後にレター順へ並べ替える。
  // その並べ替えで元の順を失わないよう、積んだ順を srcIndex として刻んでおく(CHANNEL_ORDER='source')。
  //   stampChannelSource … まだ刻まれていないものだけ現在の並びで採番(後から足した ch は末尾に続く)
  //   sortChannelsByLetter … 刻んでからレター順(各 *2mml の従来の sort を置き換える)
  //   orderChannels … 出力直前の並べ替え。配列は作り直すので呼び元の並びは変えない
  MML.Convert.stampChannelSource = function (channels) {
    let next = 0;
    for (const ch of channels || []) if (ch && ch.srcIndex != null && ch.srcIndex >= next) next = ch.srcIndex + 1;
    for (const ch of channels || []) if (ch && ch.srcIndex == null) ch.srcIndex = next++;
    return channels;
  };
  MML.Convert.sortChannelsByLetter = function (channels) {
    MML.Convert.stampChannelSource(channels);
    channels.sort((a, b) => a.letter.localeCompare(b.letter));
    return channels;
  };
  MML.Convert.orderChannels = function (channels, order) {
    const out = (channels || []).slice();
    MML.Convert.stampChannelSource(out);
    if (order === 'source') out.sort((a, b) => (a.srcIndex - b.srcIndex) || a.letter.localeCompare(b.letter));
    else out.sort((a, b) => a.letter.localeCompare(b.letter));
    return out;
  };
  // 出力の書式(2026-09-08、src/convert/mmlEmit.js emitScore)。プリセットには含めない(内容でなく見た目)
  //   PART_ORDER    … 'block'=チャンネル順に BARS_PER_LINE 小節ずつ並べる / 'part'=パートごとに最後まで出してから次へ
  //   BARS_PER_LINE … 1行に入れる小節数(1〜16、既定4)
  //   BAR_ALIGN     … 小節の区切りを全パートで桁揃えする(false=スペース1つで区切る、既定)
  const PART_ORDER_VALUES = ['block', 'part'];
  const CHANNEL_ORDER_VALUES = ['letter', 'source'];
  const BARS_PER_LINE_MAX = 16;
  const LAYOUT_DEFAULTS = { PART_ORDER: 'block', BARS_PER_LINE: 4, BAR_ALIGN: false, CHANNEL_ORDER: 'letter' };
  const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS);
  MML.Convert.LAYOUT_DEFAULTS = LAYOUT_DEFAULTS;
  MML.Convert.LAYOUT_KEYS = LAYOUT_KEYS;
  MML.Convert.PART_ORDER_VALUES = PART_ORDER_VALUES;
  MML.Convert.CHANNEL_ORDER_VALUES = CHANNEL_ORDER_VALUES;
  MML.Convert.BARS_PER_LINE_MAX = BARS_PER_LINE_MAX;
  // 音符の区切り(冒頭コメント NOTE_END)
  const NOTE_END_VALUES = ['next', 'zero'];
  MML.Convert.NOTE_END_VALUES = NOTE_END_VALUES;
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
  // 基準ピッチ(冒頭コメント参照)
  const TUNING_VALUES = ['auto', 'a440'];
  MML.Convert.TUNING_VALUES = TUNING_VALUES;
  const TUNING_MIN_DEFAULT = 5, TUNING_MIN_MAX = 50;
  MML.Convert.TUNING_MIN_DEFAULT = TUNING_MIN_DEFAULT;
  MML.Convert.TUNING_MIN_MAX = TUNING_MIN_MAX;
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
                SHAPE_REST: false, ENV_MERGE: false, GATE_APPROX: true, GATE_TOL: GATE_TOL_DEFAULT, LEN_SNAP: LEN_SNAP_DEFAULT, LEN_DP: true, DPCM_EXACT: true,
                NOTE_END: 'next', PITCH_SA: 'octave', N163_WAVE: 'fit',
                TUNING: 'auto', TUNING_MIN: TUNING_MIN_DEFAULT },
    // プレーン譜面: 音階+音色だけ。編曲の出発点用
    plain:    { D: false, EP: false, MP: false, PT: false, EN: false, ENV: false, V: false, SWEEP: false, INST: true, DRUM: true,
                SHAPE_REST: true, ENV_MERGE: false, GATE_APPROX: true, GATE_TOL: GATE_TOL_DEFAULT, LEN_SNAP: LEN_SNAP_DEFAULT, LEN_DP: false, DPCM_EXACT: true,
                NOTE_END: 'next', PITCH_SA: 'octave', N163_WAVE: 'fit',
                TUNING: 'auto', TUNING_MIN: TUNING_MIN_DEFAULT },
  };
  MML.Convert.CMD_PRESETS = PRESETS;

  // options.cmd(部分指定可)を全キー揃った正規形にする。省略キーは faithful 既定
  // (DPCMキーは DPCM_DEFAULTS)。
  MML.Convert.normalizeCmd = function (cmd) {
    const out = Object.assign({}, DPCM_DEFAULTS, LAYOUT_DEFAULTS, PRESETS.faithful);
    if (cmd && typeof cmd === 'object') {
      for (const k of [...CMD_KEYS, ...SHAPE_KEYS]) if (cmd[k] != null) out[k] = !!cmd[k];
      // 数値は文字列でも受ける(localStorage/JSON経由やUIのselect値が'14'等になるため)
      if (cmd.DMC_RATE != null) {
        const v = parseInt(cmd.DMC_RATE, 10);
        if (v >= 0 && v <= DMC_RATE_MAX) out.DMC_RATE = v;
      }
      if (cmd.PITCH_SA != null && PITCH_SA_VALUES.indexOf(cmd.PITCH_SA) >= 0) out.PITCH_SA = cmd.PITCH_SA;
      if (cmd.NOTE_END != null && NOTE_END_VALUES.indexOf(cmd.NOTE_END) >= 0) out.NOTE_END = cmd.NOTE_END;
      if (cmd.GATE_TOL != null) {
        const v = parseInt(cmd.GATE_TOL, 10);
        if (v >= 0 && v <= GATE_TOL_MAX) out.GATE_TOL = v;
      }
      if (cmd.LEN_SNAP != null) {
        const v = parseInt(cmd.LEN_SNAP, 10);
        if (v >= 0 && v <= LEN_SNAP_MAX) out.LEN_SNAP = v;
      }
      if (cmd.LEN_DP != null) out.LEN_DP = !!cmd.LEN_DP;
      if (cmd.DPCM_EXACT != null) out.DPCM_EXACT = !!cmd.DPCM_EXACT;
      if (cmd.PART_ORDER != null && PART_ORDER_VALUES.indexOf(cmd.PART_ORDER) >= 0) out.PART_ORDER = cmd.PART_ORDER;
      if (cmd.CHANNEL_ORDER != null && CHANNEL_ORDER_VALUES.indexOf(cmd.CHANNEL_ORDER) >= 0) out.CHANNEL_ORDER = cmd.CHANNEL_ORDER;
      if (cmd.BARS_PER_LINE != null) {
        const v = parseInt(cmd.BARS_PER_LINE, 10);
        if (v >= 1 && v <= BARS_PER_LINE_MAX) out.BARS_PER_LINE = v;
      }
      if (cmd.BAR_ALIGN != null) out.BAR_ALIGN = !!cmd.BAR_ALIGN;
      if (cmd.RATE_MIX != null && RATE_MIX_VALUES.indexOf(cmd.RATE_MIX) >= 0) out.RATE_MIX = cmd.RATE_MIX;
      if (cmd.DRUM_POLY != null && DRUM_POLY_VALUES.indexOf(cmd.DRUM_POLY) >= 0) out.DRUM_POLY = cmd.DRUM_POLY;
      if (cmd.N163_WAVE != null && N163_WAVE_VALUES.indexOf(cmd.N163_WAVE) >= 0) out.N163_WAVE = cmd.N163_WAVE;
      if (cmd.TUNING != null && TUNING_VALUES.indexOf(cmd.TUNING) >= 0) out.TUNING = cmd.TUNING;
      if (cmd.TUNING_MIN != null) {
        const v = parseFloat(cmd.TUNING_MIN);
        if (v >= 0 && v <= TUNING_MIN_MAX) out.TUNING_MIN = v;
      }
    }
    return out;
  };

  // どれかがプリセットと完全一致すればその名前、無ければ 'custom'。
  // DPCMキー(DPCM_KEYS)はドラム(DPCM)パネル側の設定なので一致判定に含めない
  MML.Convert.cmdPresetName = function (cmd) {
    const n = MML.Convert.normalizeCmd(cmd);
    for (const name of Object.keys(PRESETS)) {
      const p = MML.Convert.normalizeCmd(PRESETS[name]);
      if ([...CMD_KEYS, ...SHAPE_KEYS, 'NOTE_END', 'GATE_TOL', 'LEN_SNAP', 'LEN_DP', 'DPCM_EXACT', 'PITCH_SA', 'N163_WAVE', 'TUNING', 'TUNING_MIN'].every(k => p[k] === n[k])) return name;
    }
    return 'custom';
  };

  // ── 基準ピッチ(全体オフセット、2026-09-07) ────────────────────────────
  // 「その曲は本当に A4=440Hz の12平均律で鳴っているのか」を先に測り、測った基準で音符へ丸める。
  // ゲーム曲は12平均律を狙って作られているが、ドライバ固有の音程表やクロック都合で曲全体が
  // 数十セントずれていることがある(実例: Gofer no Yabou II。kss2mml/converter.js の
  // detectChorusDetune 採用経緯を参照)。A440 基準のまま丸めると
  //   借用変換    : 全音符に無意味な D<n> が付く(applyPitchDetune の minCents=10 を常に超える)
  //   ネイティブ変換: 原曲より系統的にずれた音程で鳴る
  //   偏差±50付近 : 音符ごとに丸めの向きが変わり、同じ音が隣の半音へ転んだり戻ったりする
  // という壊れ方をする。対策は曲全体で1つのセント値(#TUNING)を持ち、抽出側の丸めと再生側
  // (compiler.js / ppmckDriver.js の周波数テーブル)の両方で同じ値を使うこと。音符の名前は
  // 変わらず(キー/トランスポーズとは別物)、鳴る周波数だけが全体にずれる。
  //
  //   tuningCents()          … 現在有効なオフセット(セント)。既定0。抽出器の丸め(freqToNote)と
  //                            detune.js / pitch.js の理論値計算が参照する
  //   withTuning(c, fn, info)… fn の間だけオフセットを c にする(同期処理専用。finally で戻す)
  //   freqToNote(freq)       … 周波数→ノート番号(o4a=57、0..119、範囲外は null)。全 *2mml 抽出器共通
  //   noteToFreq(note)       … 逆変換。オフセット込み=その音符が変換先で実際に鳴る周波数
  //   detectTuning(chs, o)   … 抽出結果(scoreChannels)から全体オフセットを推定
  //   autoTune(opts, run)    … 変換本体 run(opts) を走らせ、オフセットが閾値以上なら
  //                            そのオフセットで run をもう一度走らせて再量子化した結果を返す
  //   tuningHeaderLines()    … 出力MMLに入れる `#TUNING <cent>` 行(0なら空配列)
  //   tuningCommentLines()   … ヘッダコメント用の説明行(0なら空配列)
  //
  // ★抽出器(kss2mml/expansion 等)はキャプチャWorkerのバンドルにも入る。Worker 側では
  //   withTuning が呼ばれないので常に0=従来どおりの丸め(ロール表示は元ファイルの音程のまま)。
  let _tuning = { cents: 0, info: null };
  MML.Convert.tuningCents = function () { return _tuning.cents; };
  MML.Convert.withTuning = function (cents, fn, info) {
    const prev = _tuning;
    _tuning = { cents: +cents || 0, info: info || null };
    try { return fn(); } finally { _tuning = prev; }
  };
  MML.Convert.freqToNote = function (freq) {
    if (!(freq > 0)) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440) - _tuning.cents / 100);
    return (n >= 0 && n <= 119) ? n : null;
  };
  MML.Convert.noteToFreq = function (note) {
    return 440 * Math.pow(2, (note - 57) / 12 + _tuning.cents / 1200);
  };
  function fmtCents(c) {
    const s = (Math.round(c * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return (c > 0 ? '+' : '') + s;
  }
  MML.Convert.formatTuningCents = fmtCents;
  MML.Convert.tuningHeaderLines = function () {
    return _tuning.cents ? [`#TUNING ${fmtCents(_tuning.cents)}`] : [];
  };
  MML.Convert.tuningCommentLines = function () {
    if (!_tuning.cents) return [];
    const hz = (440 * Math.pow(2, _tuning.cents / 1200)).toFixed(1);
    const info = _tuning.info;
    const stat = info && info.count ? `、音符${info.count}個の偏差中央値、四分位範囲${fmtCents(info.iqr).replace(/^\+/, '')}` : '';
    return [
      `; 基準ピッチ: A4=${hz}Hz (12平均律から ${fmtCents(_tuning.cents)} cent。自動検出${stat})`,
      `;   → #TUNING で再生側/NSF書き出しの周波数テーブルも同じだけずれます(音名はそのまま)`,
    ];
  };

  // 全体オフセットの推定。channels は各 *2mml が emitScore/verifyPitch に渡す scoreChannels
  // ({ letter, events:[{ start, end, note, rawFreq|freqHz }] })。
  //   - 各音符の「最寄り半音からのセント偏差」を音符の長さで重み付けし、その中央値を採る。
  //     レジスタの整数丸めによる偏差は音符ごとに±どちらにも出るので大量に集めると打ち消し合い、
  //     ドライバ固有の全体ずれだけが残る。平均でなく中央値なのはベンド/ビブラート中の外れ値に
  //     引っ張られないため
  //   - ノイズ(D)/DPCM(E)/ドラム/ノート番号が周期そのもののイベントは音程の意味が違うので除外
  //   - 四分位範囲が広い(opts.maxIqr、既定30セント)=曲全体がピッチ操作だらけ、または区間/チップで
  //     基準が二極化していて「全体ずれ」とは言えない場合と、音符が少なすぎる場合(opts.minCount、
  //     既定8)は 0(適用しない)。実測: HES NC62001 は中央値-33で四分位範囲40、適用すると10セント超の
  //     ずれの音符(=D<n>が付く音符)が110→204個に増えた(二極化の典型)
  //   - 適用後に「±10セント以内に乗る音符の割合」(fitAfter)が適用前(fitBefore)より明らかに
  //     下がるなら 0(上の二極化を中央値だけでは見抜けない場合の安全網)
  //   - |中央値| < opts.minCents(既定 TUNING_MIN_DEFAULT)なら 0
  // 戻り値 { cents, median, iqr, count, fitBefore, fitAfter, reason, byGroup }
  //   cents は適用値(0=適用しない)。reason は不適用の理由 'few'|'iqr'|'fit'|'below'(適用時は null)。
  //   byGroup はチャンネル文字の群(A-C=2A03, G-L=VRC7, P-W=N163, X-Z=FME7 …)ごとの中央値/音符数で、
  //   「OPLL と PSG で基準が違う」ような二極化をユーザーが読み取るための内訳(main.js renderTuning)
  MML.Convert.detectTuning = function (channels, opts) {
    opts = opts || {};
    const minCents = opts.minCents != null ? +opts.minCents : TUNING_MIN_DEFAULT;
    const maxIqr = opts.maxIqr != null ? opts.maxIqr : 30;
    const minCount = opts.minCount != null ? opts.minCount : 8;
    const samples = [];
    const groups = {}; // 群名 → [dev, w][]
    const groupOf = (L) => {
      if (!L) return '?';
      if (/^[A-C]$/.test(L)) return 'A-C';
      if (L === 'F') return 'F';
      if (/^[G-L]$/.test(L)) return 'G-L';
      if (/^[M-O]$/.test(L)) return 'M-O';
      if (/^[P-W]$/.test(L)) return 'P-W';
      if (/^[X-Z]$/.test(L)) return 'X-Z';
      if (/^[ab]$/.test(L)) return 'a-b';
      return L;
    };
    for (const ch of channels || []) {
      if (!ch || !ch.events) continue;
      if (ch.letter === 'D' || ch.letter === 'E' || ch.noise || ch.isDrum || ch.drum) continue;
      const g = groupOf(ch.letter);
      for (const ev of ch.events) {
        if (ev.note == null || ev.verifySkip || ev.drum) continue;
        if (ev.fme7Noise !== undefined && ev.instrument === 2) continue;
        const freq = ev.rawFreq != null ? ev.rawFreq : ev.freqHz;
        if (!(freq > 0)) continue;
        let dev = (57 + 12 * Math.log2(freq / 440) - ev.note) * 100;
        dev -= 100 * Math.round(dev / 100); // 最寄り半音からの偏差(-50..50)へ畳む
        const w = Math.max(1, (ev.end - ev.start) || 1);
        samples.push([dev, w]);
        (groups[g] = groups[g] || []).push([dev, w]);
      }
    }
    const wmedian = (arr) => {
      const s = arr.slice().sort((a, b) => a[0] - b[0]);
      let tot = 0; for (const x of s) tot += x[1];
      let acc = 0; for (const x of s) { acc += x[1]; if (acc >= tot / 2) return x[0]; }
      return s.length ? s[s.length - 1][0] : 0;
    };
    const byGroup = Object.keys(groups).map((g) => ({ group: g, median: wmedian(groups[g]), count: groups[g].length }));
    const none = { cents: 0, median: 0, iqr: 0, count: samples.length, reason: 'few', byGroup };
    if (samples.length < minCount) return none;
    samples.sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (const s of samples) total += s[1];
    const quantile = (q) => {
      let acc = 0;
      for (const s of samples) { acc += s[1]; if (acc >= total * q) return s[0]; }
      return samples[samples.length - 1][0];
    };
    const median = quantile(0.5);
    const iqr = quantile(0.75) - quantile(0.25);
    const wrap = (d) => d - 100 * Math.round(d / 100);
    const fitOf = (shift) => { let acc = 0; for (const s of samples) if (Math.abs(wrap(s[0] - shift)) <= 10) acc += s[1]; return acc / total; };
    const fitBefore = fitOf(0), fitAfter = fitOf(median);
    const out = { cents: 0, median, iqr, count: samples.length, fitBefore, fitAfter, reason: null, byGroup };
    if (iqr > maxIqr) { out.reason = 'iqr'; return out; }
    if (fitAfter + 0.05 < fitBefore) { out.reason = 'fit'; return out; }
    if (Math.abs(median) < minCents) { out.reason = 'below'; return out; }
    out.cents = Math.round(median * 10) / 10;
    return out;
  };

  // 変換本体を必要なら2回走らせる(各 *2mml の入口が呼ぶ)。run(options) は変換結果
  // オブジェクトを返し、その中に scoreChannels(emitScore に渡した配列)を含めること
  // (検出に使ったあと結果からは外す。UI が保持する結果を肥大させないため)。
  // 1回目は必ず A440 基準(=従来の出力)。閾値未満ならそれをそのまま返すので、'a440' 指定や
  // 全体ずれの無い曲の出力・処理時間は従来と変わらない。
  // guard(省略可) { minCents, maxIqr }: 形式側の下限(ユーザーの TUNING_MIN より厳しい方を採る)。
  //   (2026-09-07 の一時期、SPC がサンプル原音推定の偏りを「全体ずれ」と誤検出するのを避けるため
  //    15セント/四分位範囲15 を渡していた。原音推定の修正(spc2mml/converter.js detectBrrFundamental)後は
  //    不要になり、現在はどの形式も渡していない)
  MML.Convert.autoTune = function (options, run, guard) {
    const cmd = MML.Convert.normalizeCmd(options && options.cmd);
    guard = guard || {};
    const finish = (res, info) => {
      if (res && typeof res === 'object') { res.tuning = info; delete res.scoreChannels; }
      return res;
    };
    const first = MML.Convert.withTuning(0, () => run(options));
    // 固定指定でも検出だけは行い、結果(適用していれば何セントだったか)をステータスへ出せるようにする
    const minCents = Math.max(cmd.TUNING_MIN, guard.minCents || 0);
    const det = MML.Convert.detectTuning(first && first.scoreChannels, {
      minCents, maxIqr: guard.maxIqr != null ? guard.maxIqr : undefined,
    });
    det.minCents = minCents;
    if (cmd.TUNING !== 'auto') { det.cents = 0; det.reason = 'fixed'; det.mode = 'a440'; return finish(first, det); }
    det.mode = 'auto';
    if (!det.cents) return finish(first, det);
    return finish(MML.Convert.withTuning(det.cents, () => run(options), det), det);
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
  //   (SHAPE_QUANT=16分格子への丸めは 2026-09-07 に廃止。冒頭コメント参照)
  MML.Convert.shapeEvents = function (events, fpb, cmd) {
    const c = MML.Convert.normalizeCmd(cmd);
    if (!c.SHAPE_REST) return events;
    let evs = (events || []).slice().sort((a, b) => a.start - b.start).map(e => Object.assign({}, e));

    if (c.SHAPE_REST) {
      const restThreshold = fpb / 8; // 1/32 音符未満
      const out = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const prev = out[out.length - 1];
        // リリース表(@vr)付きの音符の直後の休符はリリースが鳴る区間(mmlEmit が k<len> で出す)
        // なので吸収しない
        if (ev.note === null && prev && prev.note !== null && prev.envelopeVr == null && (ev.end - ev.start) < restThreshold) {
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
    return evs;
  };
})(window);
