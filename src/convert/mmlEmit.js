/*
 * フォーマット非依存 MML テキスト生成
 * MML.Convert.emitChannel(letter, events, fpb, opts) → string (1チャンネル分、80桁折り返し)
 * MML.Convert.emitScore(channelsData, fpb, opts) → string (全チャンネルを小節単位で
 *   縦に揃えたスコア形式。数小節ごとに改行してパート譜のように読める形にする)
 *
 * events: [{ start, end, note: number|null, volume?, instrument?, envelopeV?, envelopeVr?,
 *            fme7EnvShape?, fme7EnvPeriod?, fme7Noise? }]
 *   note=null は休符。start/endはフレーム単位で、隙間があっても良い(内部で休符補完する)。
 * 共通opts:
 *   hasVolume    … true の場合のみ v トークンを出す
 *   hasInstrument… true の場合のみ @ トークンを出す
 *   hasEnvelope  … true の場合、envelopeV が設定されているイベントは
 *                   v の代わりに @v<N>/@vr<N> トークンを出す。hasVolumeと併用可能で、
 *                   その場合 envelopeV が無い(フラットな)イベントだけ通常の v<N> を出す
 *   hasFme7Env   … true の場合、fme7EnvShape が設定されているイベントは
 *                   S<N>(+周期が変わればM<N>)を出す。hasVolumeと併用可能
 *   hasSweep     … true の場合、sweep({speed,depth}|null)が前回と変わったイベントで
 *                   s<speed>,<depth>(解除は s0)を出す。2A03パルス(A/B)専用の
 *                   ハードウェアスイープ(src/mml/compiler.js sweepRegisterByte)
 *   hasFme7Noise … true の場合、fme7Noise が前回と変わったイベントで N<N>(ノイズ周期)を出す。
 *                   FME7/PSGはミキサー指定が @<n> (0=ミュート/1=トーン/2=ノイズ/
 *                   3=トーン+ノイズ)なので hasInstrument と併用する
 *   hasPitchMod  … true の場合、pitchEp が設定されているイベントは EP<N>(未設定なら
 *                   EPOF)、portamento が設定されているイベントは PT<target>,<duration>
 *                   (未設定なら PTOF)、vibrato が設定されているイベントは MP<N>
 *                   (未設定なら MPOF)を出す(いずれもD<n>と同型の独立プレフィックス
 *                   コマンドで排他的。src/convert/pitch.js PitchEnvelopeRegistry参照)
 *   (v<N>/@v<N>/S<N>の切替時は値が前回と同じ番号でも必ずトークンを出し直す。
 *    コンパイラ側は明示的なv<n>でstate.envelopeV/fme7EnvShapeをnullにクリアするため)
 *   totalFrames  … 末尾休符を補うための曲全体のフレーム数
 *   cmd          … 変換設定(src/convert/options.js)。上記フラグをANDマスクし、譜面整形
 *                   (SHAPE_REST)をギャップ補完前に掛ける。音符の区切り(NOTE_END)は
 *                   ここでは扱わない(呼び出し側が emitScore の前に MML.Convert.applyNoteEnd で
 *                   済ませておく。同関数が付ける ev.gate('q6'/'@q3'/'q8')はここで状態
 *                   コマンドとして出す。初期状態は q8=コンパイラの既定)
 *
 * 音価の継続(タイ)は必ず & (note/rest名を繰り返す) で行う。
 * 字句解析器 (src/mml/lexer.js) は & のみを tie として認識し、^ は無視される
 * ため、^ は使わない。
 */
(function (global) {
  'use strict';
  const MML     = global.MML     = global.MML     || {};
  MML.Convert   = MML.Convert   || {};

  const NOTE_NAMES = ['c','c+','d','d+','e','f','f+','g','g+','a','a+','b'];

  MML.Convert.noteNumberToMmlParts = function (n) {
    if (n === null || n === undefined) return null;
    return { oct: Math.floor(n / 12), name: NOTE_NAMES[((n % 12) + 12) % 12] };
  };

  // ── 2A03ノイズ(ch D)の音程 ────────────────────────────────────────────
  // 変換イベント空間ではノイズの「音程」を ev.note = 31 − 周期index で持つ(nsf2mml/gbs2mml/vgm2mml
  // sn76489/spc2mml/borrow.js/drumMap.js が全てこの約束。周期index 0-15 ⇔ note 31-16、index が小さい
  // ほど高い音なので note が大きいほど高い=他chの音程と同じ向き。ロール表示や音域判定はこの空間のまま)。
  // MMLへ書く時だけここで周期index に戻し `n<idx>` で出す(本家ppmck準拠: ノイズchの n<num> は
  // 周期index の直値、音符 c〜b は半音番号=index でオクターブ無視。compiler.js noisePeriodIndex)。
  // ★2026-09-18まで音符+オクターブで書いていた(旧コンパイラは index=15−(note%16) と反転写像していた
  //   ため o1〜o2 の音符になっていた)。本家ppmckでは別の音になるので n<idx> へ切り替えた
  MML.Convert.noiseNoteToIndex = function (note) { return ((31 - Math.round(note)) % 16 + 16) % 16; };
  MML.Convert.noiseIndexToNote = function (idx) { return 31 - (((idx % 16) + 16) % 16); };
  // DPCM(ch E): 音符は「どの @DPCM<n> を鳴らすか」の番号で音高ではない(本家ppmck準拠 2026-09-19)。
  //   イベントの note は compiler.js と同じ noteNumber = DPCM_NOTE_BASE(24=o2 c) + 番号 で持ち、
  //   出力は n<番号> の直値(本家ppmckcは音名だと「オクターブ×16+音名」の飛び番になるので使わない)。
  //   E には v/@/@v/D/EP/EN/MP/K が無い(compiler.js がエラーにする)ので、出力フラグも全部落とす(DPCM_FLAGS_OFF)
  MML.Convert.DPCM_NOTE_BASE = 24;
  MML.Convert.dpcmNoteToIndex = function (note) { return Math.max(0, Math.round(note) - MML.Convert.DPCM_NOTE_BASE); };
  MML.Convert.dpcmIndexToNote = function (idx) { return MML.Convert.DPCM_NOTE_BASE + Math.max(0, idx | 0); };
  const DPCM_FLAGS_OFF = { hasVolume: false, hasInstrument: false, hasEnvelope: false, hasDetune: false, hasPitchMod: false, hasNoteEnv: false, hasSweep: false, dpcmIndexNotes: true };

  // ── ギャップ・末尾を休符イベントで補完してギャップレス化 ──────────────
  function fillGaps(events, totalFrames) {
    const filled = [];
    let cursor = 0;
    const sorted = (events || []).slice().sort((a, b) => a.start - b.start);
    for (const ev of sorted) {
      if (ev.start > cursor) filled.push({ start: cursor, end: ev.start, note: null });
      filled.push(ev);
      cursor = Math.max(cursor, ev.end);
    }
    if (cursor < totalFrames) filled.push({ start: cursor, end: totalFrames, note: null });
    return filled;
  }

  // 音価文字列("8"/"4."/"16.."等)の数値部分がdefaultLenと一致すれば省略する
  // (l<n>宣言済みの前提。一致しなければ変更なしでそのまま返す)。付点はl<n>自体には
  // 乗せられないため常に明示するが、数値だけ省略しても曲全体で defaultLen が有効な
  // 限りコンパイラ側は同じ音価として正しく再現できる(src/mml/compiler.js
  // framesForLength: n = len || defaultLength)。
  function omitDefaultLen(lenStr, defaultLen) {
    const m = /^(\d+)(\.*)$/.exec(lenStr);
    if (!m) return lenStr;
    return parseInt(m[1], 10) === defaultLen ? m[2] : lenStr;
  }

  // ── 音長の計画(LEN_DP「音長をチャンネル全体で最適化」、src/convert/duration.js quantizeSeq) ──
  // events(隙間補完・小節分割済み)ごとの音価トークン列を Map で返す。OFF なら null
  // (renderEvents は従来どおり framesToLengths を音符ごとに呼ぶ)
  function buildLengthPlan(events, fpb, lenSnap, cmd) {
    if (!MML.Convert.lenDpOf(cmd) || !MML.Convert.quantizeSeq) return null;
    const durs = events.map(e => e.end - e.start);
    // 分割DPCM(ストリーム)の区間は長さを厳密に(DPCM_EXACT、duration.js quantizeSeq の exactMask)
    const exact = MML.Convert.dpcmExactOf(cmd) ? events.map(e => !!e.exact) : null;
    const plan = MML.Convert.quantizeSeq(durs, fpb, lenSnap, exact);
    const map = new Map();
    events.forEach((e, i) => { if (durs[i] > 0) map.set(e, plan[i]); });
    return map;
  }

  // ── テンポの2倍/半分の決定(2026-09-09、src/convert/bpm.js 冒頭コメント(4)) ──────────
  // detectBpm が返した bpm と、その半分・2倍のうち [50,300] に入る候補それぞれで実際に音価を
  // 書いてみて(隙間補完 → 量子化、小節分割はしない)、「音符1個あたりの音価トークンの書きにくさ
  // (duration.js lengthTokenCost、タイ1個 +0.2)+テンポ事前分布(tempoPrior)」が最小の候補を返す。
  // 2倍/半分は IOI だけでは決まらない(8分⇔16分の記譜違い)が、長い音符が多ければ遅い側、
  // 32分だらけになるなら速い側が譜面として素直で、それは書いてみれば分かる。
  // 小節線で割らないのは、割るとタイが小節の長い(遅い)テンポほど減って不公平になるため。
  // channels: [{ events, isDrum? }](ドラムは除外)。fps: 元曲のフレームレート。opts: { totalFrames, cmd }
  MML.Convert.chooseTempoOctave = function (bpm, channels, fps, opts) {
    opts = opts || {};
    if (!(bpm > 0) || !fps) return bpm;
    const cmd = opts.cmd;
    const snap = MML.Convert.lenSnapOf(cmd);
    const dp = MML.Convert.lenDpOf(cmd) && !!MML.Convert.quantizeSeq;
    const cands = [bpm / 2, bpm, bpm * 2].filter(b => b >= 50 && b <= 300);
    if (cands.length <= 1) return bpm;
    let best = null;
    for (const cand of cands) {
      const fpb = fps * 60 / Math.round(cand); // 各 *2mml と同じ丸め(t<n> 整数)で書く
      let cost = 0, notes = 0;
      for (const ch of channels || []) {
        if (!ch || ch.isDrum || !ch.events || !ch.events.length) continue;
        const filled = fillGaps(MML.Convert.shapeEvents(ch.events, fpb, cmd), opts.totalFrames || 0);
        const durs = filled.map(e => e.end - e.start);
        const exact = MML.Convert.dpcmExactOf(cmd) ? filled.map(e => !!e.exact) : null;
        const plan = dp ? MML.Convert.quantizeSeq(durs, fpb, snap, exact) : null;
        let carry = 0;
        for (let i = 0; i < filled.length; i++) {
          if (!(durs[i] > 0)) continue;
          let lengths;
          if (plan) lengths = plan[i];
          else { const q = MML.Convert.framesToLengths(durs[i], fpb, carry, snap); carry = q.carryOut; lengths = q.lengths; }
          if (filled[i].note === null) continue;
          notes++;
          cost += lengths.reduce((a, l) => a + MML.Convert.lengthTokenCost(l), 0) + 0.2 * (lengths.length - 1);
        }
      }
      if (!notes) return bpm;
      const score = cost / notes + MML.Convert.tempoPrior(cand);
      if (!best || score < best.score) best = { cand, score };
    }
    return best.cand;
  };

  // ── イベント配列 → トークン列 (共通コア) ────────────────────────────
  // state (curOct/curVol/curInst/curEnvV/curEnvVr) は呼び出しをまたいで
  // 共有できるようにする(小節ごとに分けて呼んでも変化検出が継続するため)。
  // ev.continued=true の音符は小節境界で分割された継続音として、音色/音量/
  // オクターブを再指定せずタイ(&)だけで繋げる(休符は繋げても繋げなくても
  // 音的に同じなので continued を見る必要がない)。
  //
  // トークン間の区切り空白は音符/休符(タイ継続・オクターブ変更含む)同士の間だけ
  // 省く(実際のMMLではa+8a+4のように書けば読める。字句解析器はi++で位置を進めながら
  // 貪欲に数字を読むため空白区切りを必要としない)。@<n>やv<n>等の設定コマンドは
  // 従来通り前後に空白を入れて視認性を保つ。
  function renderEvents(events, fpb, flags, state, appendToken) {
    function emit(tok, isNoteToken) {
      const needsSpace = state.hasEmitted && !(isNoteToken && state.lastWasNote);
      appendToken(needsSpace ? ' ' + tok : tok);
      state.lastWasNote = !!isNoteToken;
      state.hasEmitted = true;
    }
    const defaultLen = flags.defaultLen || 4;
    // ノイズchの @<n> は 0=長周期/1=短周期(コンパイラの既定は@0)。長周期だけの曲に @0 を出さずに済むよう、
    // 初回だけ「@0 は既出」扱いで始める(短周期が出てきた時点で @1、戻る時に @0 が出る)
    if (flags.noiseIndexNotes && state.curInst < 0) state.curInst = 0;
    const fmtLens = (name, lengths) =>
      name + omitDefaultLen(lengths[0], defaultLen) +
      lengths.slice(1).map(l => `&${name}${omitDefaultLen(l, defaultLen)}`).join('');

    for (let evIdx = 0; evIdx < events.length; evIdx++) {
      const ev = events[evIdx];
      const dur = ev.end - ev.start;
      if (dur <= 0) continue;
      state.durCarryBefore = state.durCarry;
      // 分割DPCMのチェーンの直前のイベント: 位置を厳密に(持ち越しをここで吸収し、丸めは 192 分の半分まで)。
      // チェーンの頭がフレーム整数からずれて入ると、区間の長さは厳密でも境界のフレーム丸めが
      // 区間ごとに違う向きへ転び、継ぎ目が±1フレーム揺れる(duration.js quantizeSeq の strictPos と同じ理由)
      const beforeChain = flags.dpcmExact && !ev.exact && evIdx + 1 < events.length && !!events[evIdx + 1].exact;
      // flags.plan(LEN_DP、buildLengthPlan): チャンネル全体で決めた音価があればそれを使う(持ち越しは無し)
      const planned = flags.plan ? flags.plan.get(ev) : null;
      let lengths, carryOut;
      if (planned) { lengths = planned; carryOut = 0; }
      else if (flags.dpcmExact && ev.exact) {
        // 分割DPCM(ストリーム再生の区間、src/convert/drumHits.js): 長さを厳密に書く。
        //   ・チェーンに入る前の持ち越し(durCarry)は吸収せず素通しにする(吸収すると先頭区間が
        //     短くなり継ぎ目で音が切れる。そのずれはチェーンの後の普通の音符が吸収する)
        //   ・区間ごとの端数(192分の半分以内)はチェーン内だけの持ち越し(exactCarry)で次の区間へ渡す。
        //     区間の頭は元曲でフレーム整数なので、チェーン内の累積ずれを ±5tick(0.3フレーム未満)に
        //     抑えれば、コンパイラが丸めた後のトリガー位置は必ず元のフレームに乗る
        const q = MML.Convert.framesToLengths(dur, fpb, state.exactCarry, 0);
        lengths = q.lengths; state.exactCarry = q.carryOut; carryOut = state.durCarry;
      } else if (beforeChain) {
        // チェーンの直前: 位置を厳密に合わせ、残った端数(±5tick)はチェーン内の持ち越しとして渡す
        const q = MML.Convert.framesToLengths(dur, fpb, state.durCarry + state.exactCarry, 0);
        state.exactCarry = q.carryOut;
        lengths = q.lengths; carryOut = 0;
      } else {
        // チェーンを抜けたら、チェーン内の端数を普通の持ち越しへ合流させる
        const q = MML.Convert.framesToLengths(dur, fpb, state.durCarry + state.exactCarry, flags.lenSnap);
        state.exactCarry = 0;
        lengths = q.lengths; carryOut = q.carryOut;
      }
      state.durCarry = carryOut;

      if (ev.note === null) {
        // リリース表(@vr)付きの音符に直接続く休符は k<len>(実機ppmckの「リリースエンベロープが
        // 発動する休符」)で出す。r で出すとゲートオフ=音符終端でリリースが鳴らず音が変わる。
        // 小節境界で分割された続き(continued)も k のまま繋ぐ
        const prevEv = state.prevEv;
        const useK = (prevEv && prevEv.note !== null && prevEv.envelopeVr != null && prevEv.envelopeVr !== 255 && prevEv.end === ev.start) ||
                     (ev.continued && state.prevRestWasK);
        // リリース表が 0 に達しないまま無音になる音符(prevEv.releaseEnd、nsf2mml toVolumeFields 参照)は
        // releaseEnd までを k、以降を r で出す(r で音量 0 になる)。framesToLengths は上で dur 全体に
        // 対して呼び済みなので、直前の carry から k と r に分け直す
        const relEnd = useK && !ev.continued && prevEv.releaseEnd != null ? prevEv.releaseEnd : null;
        if (relEnd != null && relEnd < ev.end) {
          const kFrames = relEnd - ev.start;
          const kq = MML.Convert.framesToLengths(kFrames, fpb, state.durCarryBefore, flags.lenSnap);
          const rq = MML.Convert.framesToLengths(dur - kFrames, fpb, kq.carryOut, flags.lenSnap);
          state.durCarry = rq.carryOut;
          emit(fmtLens('k', kq.lengths), true);
          emit(fmtLens('r', rq.lengths), true);
          state.prevRestWasK = false;
          state.prevEv = ev;
          continue;
        }
        // r は従来どおり & で繋がない(音的に同じ)。k は繋ぐ(実機ppmckは k のたびにリリース効果を
        // 出し直すので、小節をまたぐ続きは k8&k4 のようにタイで1つの k にする)
        emit((useK && ev.continued ? '&' : '') + fmtLens(useK ? 'k' : 'r', lengths), true);
        state.prevRestWasK = useK;
        state.prevEv = ev;
        continue;
      }
      state.prevRestWasK = false;
      state.prevEv = ev;

      // ev.slurTie(スラー分割、2026-08-12): 純粋な音程変化だけで区切られた隣接イベントを
      // 独立した再アタックではなくタイ(&)で繋ぐ(src/convert/pitch.js markSlurTies参照)。
      // ev.continuedと全く同じ「音色/音量/エンベロープ等は再指定せずタイだけで繋げる」
      // 扱いをする(compiler.js側のタイ処理はタイで繋いだ2音目以降が独自のD/EP/MP/PTを
      // 持てない設計のため、どのみち出力しても再生時に無視される)。
      if (!ev.continued && !ev.slurTie) {
        // ゲートタイム(src/convert/envelope.js applyNoteEnd が連鎖の先頭に付ける)。他の状態
        // コマンドと同じく前回と違うときだけ出す。付いていない音符は前の状態を引き継ぐ
        // (applyNoteEnd は状態が変わる音符にだけ付ける)。
        // コンパイラ側は q/@q(curGateQ)と @k(curGateK、q/@q より優先)の2つの状態を持つので、
        // '@k<n>' 以外へ戻るときは先に @k0 で解除してから q/@q を出す
        if (ev.gate !== undefined) {
          if (ev.gate.slice(0, 2) === '@k') {
            const n = parseInt(ev.gate.slice(2), 10) || 0;
            if (n !== state.curGateK) { emit(ev.gate); state.curGateK = n; }
          } else {
            if (state.curGateK !== 0) { emit('@k0'); state.curGateK = 0; }
            if (ev.gate !== state.curGateQ) { emit(ev.gate); state.curGateQ = ev.gate; }
          }
        }
        if (flags.hasVrc7Tone && ev.vrc7Tone !== undefined && ev.vrc7Tone !== state.curVrc7Tone) {
          emit(`OP${ev.vrc7Tone}`); state.curVrc7Tone = ev.vrc7Tone;
        }
        if (flags.hasFdsMod && ev.fdsMod !== undefined && ev.fdsMod !== state.curFdsMod) {
          emit(ev.fdsMod === 'off' ? 'MHOF' : `MH${ev.fdsMod}`); state.curFdsMod = ev.fdsMod;
        }
        // 音色: ev.toneEnv(デューティ=音色エンベロープ番号、@<n>={...} を @@<n> で選ぶ)があれば
        // そちらを優先。コンパイラは @<n>(固定音色)で @@ を解除するので、@@ の後に同じ番号の
        // @<n> を出す必要があるときは curInst を忘れる
        if (flags.hasInstrument && ev.toneEnv != null) {
          if (ev.toneEnv !== state.curToneEnv) { emit(`@@${ev.toneEnv}`); state.curToneEnv = ev.toneEnv; state.curInst = -1; }
        } else if (flags.hasInstrument && ev.instrument !== undefined && (ev.instrument !== state.curInst || state.curToneEnv != null)) {
          emit(`@${ev.instrument}`); state.curInst = ev.instrument; state.curToneEnv = null;
        }
        // ハードウェアスイープ(2A03パルスのみ)。D<n>等と同じく未指定イベントはOFF扱いに
        // して、前回との差分があるときだけ出す(直前の音符のスイープを引きずらないため)
        if (flags.hasSweep) {
          const sw = ev.sweep ? `s${ev.sweep.speed},${ev.sweep.depth}` : 's0';
          if (sw !== state.curSweep) { emit(sw); state.curSweep = sw; }
        }
        // SA<num>(N163ピッチシフト量、ppmckc公式): この音符のD/EP/MP値が>>saで縮めて
        // 登録されている場合に、再生側が同じシフトで戻すための状態コマンド。D<n>より
        // 先に出す(同じ音符のDにも効くため)。未指定イベントは0扱いで明示的に戻す
        if (flags.hasDetune || flags.hasPitchMod) {
          const saVal = ev.pitchSa || 0;
          if (saVal !== (state.curPitchSa || 0)) { emit(`SA${saVal}`); state.curPitchSa = saVal; }
        }
        // コーラス(デチューン)効果。未指定イベントは0扱い(直前の音符のデチューンを
        // 引きずらないよう、hasDetune指定チャンネルでは毎回0との差分を見て明示的に戻す)
        if (flags.hasDetune) {
          const detuneVal = ev.detune || 0;
          if (detuneVal !== state.curDetune) { emit(`D${detuneVal}`); state.curDetune = detuneVal; }
        }
        // ピッチエンベロープ(厳密周期ビブラート、DESIGN-PITCH.md Phase 1)。D<n>と同じく
        // 未指定イベントはoff扱いにし、hasPitchMod指定チャンネルでは毎回前回状態との差分を
        // 見て明示的にEPOFへ戻す(直前の音符のビブラートを引きずらないため)。
        // ★2026-08-11(別プロジェクトA): delay引数`EP<n>,<delay>`に対応。同じテーブル番号
        // でもdelayが前回と違えば出し直す(delayも音符ごとの状態なので、番号だけの比較では
        // 変化を見逃す)。delay=0(既定)なら従来通りカンマ無しの`EP<n>`のまま出す。
        if (flags.hasPitchMod) {
          const epVal = (ev.pitchEp != null) ? ev.pitchEp : null;
          const epDelay = epVal !== null ? (ev.pitchEpDelay || 0) : 0;
          if (epVal !== state.curPitchEp || epDelay !== state.curPitchEpDelay) {
            if (epVal === null) emit('EPOF');
            else emit(epDelay > 0 ? `EP${epVal},${epDelay}` : `EP${epVal}`);
            state.curPitchEp = epVal;
            state.curPitchEpDelay = epDelay;
          }
        }
        // ビブラートコマンド(周期的振動の軽量な階段状LFO表現、DESIGN-PITCH.md
        // 別プロジェクトB、gate解除は2026-08-15)。D<n>/EP<n>と全く同じ「毎回前回状態との
        // 差分を見て明示的にMPOFへ戻す」設計の独立プレフィックスコマンド。
        // pitchReg.assign()はEP/PT/MPのいずれか1つだけを返す(検出結果は同じpitchMod
        // 由来の排他的な出力形式の選択)ため、対応チャンネルの範囲も同じhasPitchModフラグを
        // 共有する。
        if (flags.hasPitchMod) {
          const mpVal = (ev.vibrato != null) ? ev.vibrato : null;
          if (mpVal !== state.curVibrato) {
            emit(mpVal === null ? 'MPOF' : `MP${mpVal}`);
            state.curVibrato = mpVal;
          }
        }
        // ノートエンベロープ(高速アルペジオ、2026-08-14)。D<n>/EP<n>と同じく未指定
        // イベントはoff扱いにし、hasNoteEnv指定チャンネルでは毎回前回状態との差分を
        // 見て明示的にENOFへ戻す(直前の音符のアルペジオを引きずらないため)。
        // ★VRC7拡張(2026-08-14): ENはノート番号→fnum/blockを都度再計算するだけで
        // D<n>/EP<n>のような「生レジスタ空間への単純加算」を必要としないため、
        // fnum/blockの対数表現によりD/EP/MPが使えないVRC7でも問題なく使える
        // (src/mml/compiler.js segmentsToWriteLogVrc7参照)。そのためhasPitchModとは
        // 独立したhasNoteEnvフラグを使う(hasPitchModはVRC7だけfalseになるため)。
        if (flags.hasNoteEnv) {
          const enVal = (ev.noteEnv != null) ? ev.noteEnv : null;
          if (enVal !== state.curNoteEnv) {
            emit(enVal === null ? 'ENOF' : `EN${enVal}`);
            state.curNoteEnv = enVal;
          }
        }
        // ポルタメントコマンド(単調ランプの軽量な直線グライド表現、DESIGN-PITCH.md
        // 別プロジェクトC)。D<n>/EP<n>と全く同じ「毎回前回状態との差分を見て明示的に
        // PTOFへ戻す」設計の独立プレフィックスコマンド。pitchReg.assign()はEP/PT/MPの
        // いずれか1つだけを返す(検出結果は同じpitchMod由来の排他的な出力形式の選択)
        // ため、対応チャンネルの範囲も同じhasPitchModフラグを共有する。
        if (flags.hasPitchMod) {
          const pt = ev.portamento || null;
          const ptTarget = pt ? pt.target : null;
          const ptDuration = pt ? pt.duration : 0;
          const ptDelay = pt ? (pt.delay || 0) : 0;
          if (ptTarget !== state.curPortamentoTarget || ptDuration !== state.curPortamentoDuration ||
              ptDelay !== state.curPortamentoDelay) {
            if (ptTarget === null) emit('PTOF');
            else emit(ptDelay > 0 ? `PT${ptTarget},${ptDuration},${ptDelay}` : `PT${ptTarget},${ptDuration}`);
            state.curPortamentoTarget = ptTarget;
            state.curPortamentoDuration = ptDuration;
            state.curPortamentoDelay = ptDelay;
          }
        }
        // FME7/PSGのノイズ周期(R6、3ch共有)。@2(ノイズ単独)ではノート番号自体が周期に
        // なるためN<n>は出さない(ppmck仕様で@2の時のNは無効)
        if (flags.hasFme7Noise && ev.fme7Noise !== undefined && ev.fme7Noise !== state.curFme7Noise) {
          emit(`N${ev.fme7Noise}`); state.curFme7Noise = ev.fme7Noise;
        }
        // リリース表 @vr<n>(ゲートオフの瞬間から鳴る)。@v の有無に関わらず効くので v<n> の音符でも
        // 出す。無い音符では @vr255(解除、コンパイラの既定)へ戻す。初期状態は 255
        // リリースは「ゲートオフ(q/@q/@k)」か「k<len>」でしか発動しない。ゲートが音長いっぱい
        // (q8 かつ @k0)の音符では、リリース無しの音符でも直前の @vr/@@r を残したままで音は変わらない
        // (k は mmlEmit がリリース付きの音符の直後にしか出さない)ので、@vr255/@@r255 への解除を
        // 出さずに済ませ、音符ごとの @vr0 @@r0 / @vr255 @@r255 の往復を避ける
        const gateFull = state.curGateQ === 'q8' && state.curGateK === 0;
        if (flags.hasEnvelope) {
          const vr = (ev.envelopeVr !== undefined && ev.envelopeVr !== null) ? ev.envelopeVr : 255;
          if (vr !== state.curEnvVr && !(vr === 255 && gateFull)) { emit(`@vr${vr}`); state.curEnvVr = vr; }
        }
        // リリース音色 @@r<n>(ゲートオフの瞬間にデューティ(音色)エンベロープ表 n へ差し替える。
        // 無い音符では @@r255=解除へ戻す(上と同じくゲートが音長いっぱいなら残す)。初期状態は 255)
        if (flags.hasInstrument) {
          const rt = (ev.releaseTone !== undefined && ev.releaseTone !== null) ? ev.releaseTone : 255;
          if (rt !== state.curRelTone && !(rt === 255 && gateFull)) { emit(`@@r${rt}`); state.curRelTone = rt; }
        }
        if (flags.hasFme7Env && ev.fme7EnvShape !== undefined) {
          if (ev.fme7EnvPeriod !== undefined && ev.fme7EnvPeriod !== state.curFme7Period) {
            emit(`M${ev.fme7EnvPeriod}`); state.curFme7Period = ev.fme7EnvPeriod;
          }
          // S<n>には解除コマンドが無く一度出すと残り続けるため(compiler.js側もv<n>でしか
          // クリアできない)、v<n>経由でモードを抜けていた場合は番号が同じでも出し直す。
          if (ev.fme7EnvShape !== state.curFme7Shape || state.curVolMode !== 'fme7env') {
            emit(`S${ev.fme7EnvShape}`); state.curFme7Shape = ev.fme7EnvShape;
          }
          state.curVolMode = 'fme7env';
        } else if (flags.hasEnvelope && ev.envelopeV !== undefined) {
          // v<n>とhasEnvelopeを併用するチャンネル(NSF/KSSの帯域)では、直前がv<n>だった
          // 場合コンパイラ側のstate.envelopeVがnullにクリアされているため、値が前回の
          // @v<n>と同じ番号でも必ずトークンを出し直して再セットする(state.curVolMode参照)。
          if (ev.envelopeV !== state.curEnvV || state.curVolMode !== 'env') {
            emit(`@v${ev.envelopeV}`); state.curEnvV = ev.envelopeV;
          }
          state.curVolMode = 'env';
        } else if (flags.hasVolume && ev.volume !== undefined) {
          // 同様に、直前が@v<n>だった場合はコンパイラのstate.volumeが古いままなので、
          // 値が前回のv<n>と同じでも必ず出し直してエンベロープを解除する。
          if (ev.volume !== state.curVol || state.curVolMode !== 'plain') {
            emit(`v${ev.volume}`); state.curVol = ev.volume;
          }
          state.curVolMode = 'plain';
        }
      }

      if (flags.dpcmIndexNotes) {
        // DPCM(ch E): @DPCM番号の直値 n<idx>[,<len>](本家ppmck準拠、DPCM_NOTE_BASE 冒頭コメント)。オクターブ・音色は出さない
        const idx = MML.Convert.dpcmNoteToIndex(ev.note);
        const nTok = (l) => { const s = omitDefaultLen(l, defaultLen); return `n${idx}` + (s ? (s[0] === '.' ? s : ',' + s) : ''); };
        const tie = (ev.continued || ev.slurTie) ? '&' : '';
        emit(tie + nTok(lengths[0]) + lengths.slice(1).map(l => '&' + nTok(l)).join(''), true);
        continue;
      }
      if (flags.noiseIndexNotes) {
        // 2A03ノイズ(ch D): 周期index の直値 n<idx>[,<len>] で出す(noiseNoteToIndex 冒頭コメント)。
        // オクターブは無意味なので o<n>/>/< は出さない。短/長周期は ev.instrument(@0/@1)で上に出ている
        const idx = MML.Convert.noiseNoteToIndex(ev.note);
        // 音長が付点だけ(既定音長の付点)なら `n11.`、数値があれば `n11,16.`(lexer.js 'n' は両方受ける)
        const nTok = (l) => { const s = omitDefaultLen(l, defaultLen); return `n${idx}` + (s ? (s[0] === '.' ? s : ',' + s) : ''); };
        const tie = (ev.continued || ev.slurTie) ? '&' : '';
        emit(tie + nTok(lengths[0]) + lengths.slice(1).map(l => '&' + nTok(l)).join(''), true);
        continue;
      }
      const { oct, name } = MML.Convert.noteNumberToMmlParts(ev.note);
      // ★2026-08-12: 従来はここも!ev.continuedで無条件にガードしていた(継続音は常に
      // 同じ音程=オクターブも不変という前提)。ev.slurTie(タイで異なる音程へレガート)は
      // オクターブを跨ぐ場合があるため、oct!==state.curOctという実際の変化判定だけに
      // 一本化した(continued/slurTieどちらでもoctが変わらなければ何も出さない点は
      // 従来と同じ、continued側の挙動に退行なし)。
      if (oct !== state.curOct) {
        // >/<(相対オクターブ移動)は直後の音符と一体で書く伝統的なMML表記(o<n>は
        // 独立した設定コマンドとして扱い空白を空ける)ため、note扱い(isNoteToken=true)
        // にして音符側との間の空白も詰める。
        if      (state.curOct >= 0 && oct === state.curOct + 1) emit('>', true);
        else if (state.curOct >= 0 && oct === state.curOct - 1) emit('<', true);
        else                                                    emit(`o${oct}`);
        state.curOct = oct;
      }

      const tie = (ev.continued || ev.slurTie) ? '&' : '';
      emit(tie + fmtLens(name, lengths), true);
    }
  }

  function newState() {
    return {
      curOct: -1, curVol: -1, curInst: -1, curEnvV: -1, curEnvVr: 255, curToneEnv: null, curRelTone: 255,
      prevEv: null, prevRestWasK: false,
      curFme7Shape: -1, curFme7Period: -1, curFme7Noise: -1, curVolMode: null, durCarry: 0,
      exactCarry: 0, // 分割DPCM(ストリーム)の区間チェーン内だけで閉じる持ち越し(下 renderEvents 参照)
      curVrc7Tone: -1, curFdsMod: 'off', curDetune: 0, curPitchSa: 0, curPitchEp: null, curPitchEpDelay: 0,
      curNoteEnv: null, curVibrato: null, curSweep: 's0', curGateQ: 'q8', curGateK: 0,
      curPortamentoTarget: null, curPortamentoDuration: 0, curPortamentoDelay: 0,
      lastWasNote: false, hasEmitted: false
    };
  }

  // ── 1チャンネル分の連続テキスト (80桁折り返し) ──────────────────────
  MML.Convert.emitChannel = function (letter, events, fpb, opts) {
    opts = opts || {};
    const totalFrames = opts.totalFrames || 0;
    const wrapCol      = opts.wrapCol || 80;
    const flags = {
      hasVolume: !!opts.hasVolume, hasInstrument: !!opts.hasInstrument,
      hasEnvelope: !!opts.hasEnvelope, hasFme7Env: !!opts.hasFme7Env, hasVrc7Tone: !!opts.hasVrc7Tone,
      hasFdsMod: !!opts.hasFdsMod, hasFme7Noise: !!opts.hasFme7Noise, hasDetune: !!opts.hasDetune,
      hasSweep: !!opts.hasSweep,
      noiseIndexNotes: letter === 'D', // 2A03ノイズ: 音符を n<周期index> で書く(noiseNoteToIndex参照)
      hasPitchMod: !!opts.hasPitchMod,
      // hasNoteEnvはhasPitchModと独立(VRC7はfnum/block対数空間のためD/EP/MPは使えないが
      // ENは使える、mergeRapidArpeggio冒頭コメント参照)。opts.hasNoteEnvが省略された場合は
      // hasPitchModを既定値として使う(既存の全チャンネル定義を書き換えずに済む後方互換)。
      hasNoteEnv: opts.hasNoteEnv != null ? !!opts.hasNoteEnv : !!opts.hasPitchMod
    };
    const tempoPrefix = opts.tempoPrefix || '';
    // 変換設定(src/convert/options.js): コマンドマスク+譜面整形
    const maskedFlags = MML.Convert.maskEmitFlags(flags, opts.cmd);
    Object.assign(flags, maskedFlags);
    if (letter === 'E') Object.assign(flags, DPCM_FLAGS_OFF); // DPCM: 音符=番号だけ(DPCM_NOTE_BASE 冒頭コメント)
    flags.lenSnap = MML.Convert.lenSnapOf(opts.cmd); // 音長を丸める(LEN_SNAP、duration.js framesToLengths)
    flags.dpcmExact = MML.Convert.dpcmExactOf(opts.cmd); // 分割DPCMの音長は丸めない(DPCM_EXACT)

    const lines = [];
    if (opts.headerLines) lines.push(...opts.headerLines);

    const filled = fillGaps(MML.Convert.shapeEvents(events, fpb, opts.cmd), totalFrames);

    if (filled.length === 0) {
      lines.push(`${letter} ${tempoPrefix}r1`.trimEnd());
      if (opts.footerLines) lines.push(...opts.footerLines);
      return lines.join('\n');
    }

    // 曲(このチャンネル)で最も多い音価をl<n>としてチャンネル先頭で宣言し、以後
    // 一致する音符/休符は数値部分を省略する(renderEvents内のomitDefaultLen参照)。
    // ★opts.noDefaultLen: l<n> を宣言せず、全ての音符に音価を明示する。
    //   既存MMLのカーソル位置へ断片を差し込む用途(src/ui/recordPanel.js)向け。
    //   l<n> はそれ以降の既定音価を変えてしまうので、差し込んだ後ろに元からあった
    //   音符の意味まで書き換わってしまう(INV-6: 既存MMLを黙って変えない)。
    //   -1 はどの音価とも一致しないので omitDefaultLen が常に素通しになる。
    flags.plan = buildLengthPlan(filled, fpb, flags.lenSnap, opts.cmd);
    flags.defaultLen = opts.noDefaultLen ? -1 : MML.Convert.detectDefaultLength(filled, fpb, flags.lenSnap, flags.plan);

    let line = `${letter} ${tempoPrefix}`;
    let col  = line.length;

    function appendToken(tok) {
      if (col + tok.length > wrapCol) {
        lines.push(line.trimEnd());
        line = `${letter} `;
        col = line.length;
        tok = tok.replace(/^ /, ''); // 改行直後は区切り空白不要
      }
      line += tok;
      col += tok.length;
    }

    const state = newState();
    if (!opts.noDefaultLen) {
      appendToken(`l${flags.defaultLen}`);
      state.hasEmitted = true;
    }
    renderEvents(filled, fpb, flags, state, appendToken);

    lines.push(line.trimEnd());
    if (opts.footerLines) lines.push(...opts.footerLines);
    return lines.join('\n');
  };

  // ── 小節境界での分割 ─────────────────────────────────────────────────
  // boundaries(昇順のフレーム位置配列)をまたぐイベントを2つに割り、
  // 後半に continued:true を付与する。
  // tol(フレーム、LEN_SNAP「音長を丸める」): 小節線が音符の始点/終点からこのフレーム数未満しか離れて
  // いなければそこでは割らない。小数テンポの曲は音符が小節線から少しずつずれるので、2tick 手前で始まる
  // 4分音符が a192&a8..&a64. のように小節線で千切れていた。割らない側の小節には音符が無いままになる
  // (縦の並びは小節番号で揃うので、その小節は空欄)
  function splitAtBoundaries(events, boundaries, tol) {
    const result = [];
    let bi = 0;
    tol = tol || 0;
    for (const ev of events) {
      while (bi < boundaries.length && boundaries[bi] <= ev.start) bi++;
      let segStart = ev.start;
      let continued = false;
      while (bi < boundaries.length && boundaries[bi] < ev.end) {
        if (boundaries[bi] - segStart > tol && ev.end - boundaries[bi] > tol) { // 小節線は整数に丸めてあるので tol ちょうども切れ端扱い
          result.push(Object.assign({}, ev, { start: segStart, end: boundaries[bi], continued }));
          segStart = boundaries[bi];
          continued = true;
        }
        bi++;
      }
      result.push(Object.assign({}, ev, { start: segStart, end: ev.end, continued }));
    }
    return result;
  }

  function bucketByMeasure(events, framesPerMeasure, measureCount) {
    const buckets = Array.from({ length: measureCount }, () => []);
    for (const ev of events) {
      const m = Math.max(0, Math.min(measureCount - 1, Math.floor(ev.start / framesPerMeasure)));
      buckets[m].push(ev);
    }
    return buckets;
  }

  // ── 全チャンネルを小節単位で縦に揃えたスコア形式 ────────────────────
  // channelsData: [{ letter, events, hasVolume?, hasInstrument?, hasEnvelope? }]
  // opts:
  //   totalFrames, beatsPerMeasure(既定4), measuresPerLine(既定4),
  //   tempoBpm(指定すると先頭に "<使用チャンネル文字列> t<bpm>" 行を1本だけ出す),
  //   headerLines(スコア全体の先頭に足す生テキスト行)
  MML.Convert.emitScore = function (channelsData, fpb, opts) {
    opts = opts || {};
    const totalFrames     = opts.totalFrames || 0;
    const beatsPerMeasure = opts.beatsPerMeasure || 4;
    // 出力の書式(変換設定 src/convert/options.js LAYOUT_DEFAULTS): 1行の小節数 / パートの並び / 小節揃え
    const layout = Object.assign({}, MML.Convert.LAYOUT_DEFAULTS || {}, opts.cmd || {});
    const measuresPerLine = opts.measuresPerLine || Math.max(1, layout.BARS_PER_LINE | 0) || 4;
    const partOrder = layout.PART_ORDER === 'part' ? 'part' : 'block';
    const barAlign = !!layout.BAR_ALIGN;
    // チャンネルの並び順(CHANNEL_ORDER): アルファベット順(既定)/変換元の割り当て順。
    // 配列を作り直すので呼び元(各 *2mml の scoreChannels)の並びは変わらない
    channelsData = MML.Convert.orderChannels(channelsData, layout.CHANNEL_ORDER);
    const framesPerMeasure = fpb * beatsPerMeasure;
    const measureCount = Math.max(1, Math.ceil(totalFrames / framesPerMeasure));

    // 小節境界(整数フレームに丸める)
    const boundaries = [];
    for (let m = 1; m < measureCount; m++) boundaries.push(Math.round(m * framesPerMeasure));

    const lines = [];
    if (opts.headerLines) lines.push(...opts.headerLines);
    // ★チャンネルが1本も無い(音符が1つも取れなかった曲)ときはテンポ行を出さない。文字の無い " t120" は
    //   コンパイルエラーになり、再生も書き出しもできないMMLになる(PSF の Gran Turismo arcade.psf で発覚)
    if (opts.tempoBpm != null && channelsData.length) {
      const letters = channelsData.map(c => c.letter).join('');
      lines.push(`${letters} t${Math.round(opts.tempoBpm)}`);
    }

    // チャンネルごとに: ギャップ補完 → 小節境界で分割 → 小節バケツへ → テキスト化
    const perChannelMeasureTexts = channelsData.map(chan => {
      // 変換設定(src/convert/options.js opts.cmd): 譜面整形(短い休符吸収)を
      // ギャップ補完の前に掛け、コマンドフラグは下でANDマスクする(割当層で止め切れ
      // なかった分の安全網)
      const filled  = fillGaps(MML.Convert.shapeEvents(chan.events, fpb, opts.cmd), totalFrames);
      const split   = splitAtBoundaries(filled, boundaries, MML.Convert.lenSnapOf(opts.cmd));
      const plan    = buildLengthPlan(split, fpb, MML.Convert.lenSnapOf(opts.cmd), opts.cmd);
      const buckets = bucketByMeasure(split, framesPerMeasure, measureCount);
      const flags = MML.Convert.maskEmitFlags({
        hasVolume: !!chan.hasVolume, hasInstrument: !!chan.hasInstrument,
        hasEnvelope: !!chan.hasEnvelope, hasFme7Env: !!chan.hasFme7Env, hasVrc7Tone: !!chan.hasVrc7Tone,
        hasFdsMod: !!chan.hasFdsMod, hasFme7Noise: !!chan.hasFme7Noise, hasDetune: !!chan.hasDetune,
        hasSweep: !!chan.hasSweep,
        noiseIndexNotes: chan.letter === 'D', // 2A03ノイズ: 音符を n<周期index> で書く(noiseNoteToIndex参照)
        hasPitchMod: !!chan.hasPitchMod,
        // ★2026-08-14修正: emitChannelのflags構築(このファイル冒頭)と同じ
        // hasNoteEnvフォールバックが、emitScore側のこの独立したflags構築には
        // 欠けていた。全フォーマットはemitChannelでなくemitScoreを使うため、
        // これが無いとEN<n>検出自体は正しく動いていても出力段で常に黙って
        // 落とされる(VRC7対応でhasPitchModから分離した際に見落とした箇所、
        // SPC変換の実測で発覚)。
        hasNoteEnv: chan.hasNoteEnv != null ? !!chan.hasNoteEnv : !!chan.hasPitchMod,
        // 曲(このチャンネル)で最も多い音価をl<n>としてチャンネル先頭で宣言し、以後
        // 一致する音符/休符は数値部分を省略する(renderEvents内のomitDefaultLen参照)。
        defaultLen: MML.Convert.detectDefaultLength(plan ? split : filled, fpb, MML.Convert.lenSnapOf(opts.cmd), plan),
        lenSnap: MML.Convert.lenSnapOf(opts.cmd), // 音長を丸める(LEN_SNAP、duration.js framesToLengths)
        dpcmExact: MML.Convert.dpcmExactOf(opts.cmd), // 分割DPCMの音長は丸めない(DPCM_EXACT)
        plan // 音長をチャンネル全体で最適化(LEN_DP、buildLengthPlan)
      }, opts.cmd);
      if (chan.letter === 'E') Object.assign(flags, DPCM_FLAGS_OFF); // DPCM: 音符=番号だけ(DPCM_NOTE_BASE 冒頭コメント)
      const state = newState();
      let first = true;
      return buckets.map(bucketEvents => {
        let text = '';
        if (first) { text += `l${flags.defaultLen}`; state.hasEmitted = true; first = false; }
        renderEvents(bucketEvents, fpb, flags, state, tok => { text += tok; });
        return text;
      });
    });

    // 小節揃え(BAR_ALIGN): 小節ごとに全チャンネル中の最大幅で列を揃える。OFF ならスペース1つで区切る
    const colWidth = [];
    for (let m = 0; m < measureCount; m++) {
      let w = 0;
      if (barAlign) for (const texts of perChannelMeasureTexts) w = Math.max(w, texts[m].trimStart().length);
      colWidth.push(w);
    }
    const lineOf = (ci, blockStart, blockEnd) => {
      let line = `${channelsData[ci].letter} `;
      for (let m = blockStart; m < blockEnd; m++) {
        const t = perChannelMeasureTexts[ci][m].trimStart(); // 小節頭がコマンドだと先頭に区切り空白が付くので落とす
        if (barAlign) line += t.padEnd(colWidth[m]) + ' ';
        else if (t) line += t + ' '; // 空の小節(音符が続いているだけ)は詰める
      }
      return line.trimEnd();
    };

    if (partOrder === 'part') {
      // パートごとにまとめる: A を最後まで出してから B へ(パートの間は空行)
      for (let ci = 0; ci < channelsData.length; ci++) {
        if (ci > 0) lines.push('');
        for (let blockStart = 0; blockStart < measureCount; blockStart += measuresPerLine) {
          lines.push(lineOf(ci, blockStart, Math.min(measureCount, blockStart + measuresPerLine)));
        }
      }
      return lines.join('\n');
    }
    // チャンネル順に小節ブロックで並べる(既定): 全パートを BARS_PER_LINE 小節ずつ縦に揃える
    for (let blockStart = 0; blockStart < measureCount; blockStart += measuresPerLine) {
      const blockEnd = Math.min(measureCount, blockStart + measuresPerLine);
      for (let ci = 0; ci < channelsData.length; ci++) lines.push(lineOf(ci, blockStart, blockEnd));
      if (blockEnd < measureCount) lines.push('');
    }

    return lines.join('\n');
  };

})(window);
