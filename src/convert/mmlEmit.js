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
  // VRC7(ch G-L)の音量(2026-09-20): 変換イベント空間では VRC7 へ載せる ev.volume を
  //   **レジスタの値($30+ch下位4bit=減衰値、0=最大・15=最小)** で持つ(nsf2mml expansion/vrc7.js・kss2mml opll/opl・
  //   borrow.js VOL_FROM_DB.vrc7/volTableFor・vgm2mml adaptEvents・drumHits・spc2mml が全てこの約束)。
  //   MML の v は全音源共通で v15 が最大(コンパイラが 15-v にしてレジスタへ書く。compiler.js vrc7VolReg)なので、
  //   書く時だけここで反転する(ノイズの noiseNoteToIndex と同じ「出力の瞬間だけ直す」作り)。
  //   @v 表は VRC7 へは出さない(各変換器が hasEnvelope を落としている)
  const VRC7_LETTER = /^[G-L]$/;
  function vrc7MmlVolume(att) { return 15 - Math.max(0, Math.min(15, Math.round(att))); }
  MML.Convert.vrc7MmlVolume = vrc7MmlVolume;
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
    // 鳴っている音符(短い音符の長さの相対誤差にもコスト、duration.js quantizeSeq の soundMask)
    const sound = events.map(e => e.note !== null && e.note !== undefined);
    const plan = MML.Convert.quantizeSeq(durs, fpb, lenSnap, exact, sound);
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
      // ループ自動検出(emitScore): ループ開始位置の最初のイベントの前に L を置き、状態を出し直させる
      if (flags.loopStart != null && !state.loopEmitted && ev.start >= flags.loopStart) {
        emit(flags.loopMark || 'L'); // emitScore は目印(LOOP_MARK)で受けて「DXYZ L」の独立した行にする
        state.loopEmitted = true;
        forceReemit(state, flags);
      }
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
          let rq = MML.Convert.framesToLengths(dur - kFrames, fpb, kq.carryOut, flags.lenSnap);
          // ループ自動検出中は計画済みの音長(planned)の合計tickを必ず保つ(k と r に分けても、このイベントの
          // 合計が変わるとループ開始/終端の位置がチャンネルごとにずれる)。r 側を「合計 − k」の厳密分解にする
          if (planned && flags.loopStart != null) {
            const rTicks = MML.Convert.lengthsTicks(planned) - MML.Convert.lengthsTicks(kq.lengths);
            const exactR = rTicks >= MML.Convert.LENGTH_QUANTUM ? MML.Convert.ticksToLengthsExact(rTicks) : null;
            if (exactR) rq = { lengths: exactR, carryOut: 0 };
            else { emit(fmtLens('k', planned), true); state.prevRestWasK = true; state.prevEv = ev; continue; }
          }
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
          // FME-7: ノイズ周期 R6 は3ch共有で、@2 の音符(ノート番号=周期)が書き換える。NSFドライバは N<n> を
          // 読んだ瞬間にしか R6 を書かないので、ミキサーを切り替えたら次の @3 で N<n> を出し直す
          // (2026-09-19: 「@3 N0 … @2 e @3」で N0 を省いたため、NSF では @3 が @2 の周期のまま鳴っていた)
          if (flags.hasFme7Noise) state.curFme7Noise = -1;
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
            // ★FME-7 のハードウェアエンベロープ(S<n>)は @v では解除されない(コンパイラ/ドライバとも
            //   「S<n> > @v > v」の優先順で、解除は v<n> だけ)。S<n> の音符の後に @v の音符が来ると
            //   @v が効かずエンベロープのまま鳴るので、先に v で抜ける(2026-09-19、KSS の PSG ドラムで実測)
            if (state.curVolMode === 'fme7env') { emit('v15'); state.curVol = 15; }
            emit(`@v${ev.envelopeV}`); state.curEnvV = ev.envelopeV;
          }
          state.curVolMode = 'env';
        } else if (flags.hasVolume && ev.volume !== undefined) {
          // 同様に、直前が@v<n>だった場合はコンパイラのstate.volumeが古いままなので、
          // 値が前回のv<n>と同じでも必ず出し直してエンベロープを解除する。
          if (ev.volume !== state.curVol || state.curVolMode !== 'plain') {
            emit(`v${flags.vrc7Vol ? vrc7MmlVolume(ev.volume) : ev.volume}`); state.curVol = ev.volume;
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
      lastWasNote: false, hasEmitted: false,
      loopEmitted: false // ループ自動検出: このチャンネルに L をもう出したか(renderEvents)
    };
  }

  // ── L(ループ地点)の直後で状態コマンドを出し直させる ──────────────────────────
  // ループで L へ戻ったとき、チャンネルの状態(音量/音色/オクターブ/ゲート/EP/MP/EN/PT/D…)は「ループ末尾の
  // 状態」のままなので、L の直後の音符は必要なコマンドを全部書き直していないと1周目と違う音になる。
  // 出力は「前回との差分だけ出す」作りなので、L のところで「前回の状態」をどの値とも一致しない値にして
  // 全部出し直させる。OFF 系(EPOF/MPOF/ENOF/PTOF/@vr255/D0/s0 …)も同じ仕組みで出る。
  // ★そのチャンネルで一度も使わないコマンドは出し直さない: SA<n> は N163 以外、@@r<n> はノイズ等で
  //   コンパイルエラーになる(使っていなければ状態は既定値のまま動かないので、出し直す必要も無い)
  const UNKNOWN = '?';
  function forceReemit(state, flags) {
    state.curOct = -1; state.curVol = -1; state.curInst = -1; state.curEnvV = -1; state.curVolMode = null;
    state.curEnvVr = UNKNOWN; state.curToneEnv = UNKNOWN;
    if (flags.usesRelTone) state.curRelTone = UNKNOWN;
    state.curFme7Shape = -1; state.curFme7Period = -1; state.curFme7Noise = -1;
    state.curVrc7Tone = -1; state.curFdsMod = UNKNOWN; state.curDetune = UNKNOWN;
    if (flags.usesSa) state.curPitchSa = UNKNOWN;
    state.curPitchEp = UNKNOWN; state.curPitchEpDelay = UNKNOWN; state.curNoteEnv = UNKNOWN; state.curVibrato = UNKNOWN;
    state.curSweep = UNKNOWN; state.curGateQ = UNKNOWN; state.curGateK = -1;
    state.curPortamentoTarget = UNKNOWN; state.curPortamentoDuration = UNKNOWN; state.curPortamentoDelay = UNKNOWN;
    state.durCarry = 0; state.exactCarry = 0;
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
      vrc7Vol: VRC7_LETTER.test(letter), // VRC7: 内部の音量(レジスタの減衰値)を v=15-値 で書く(vrc7MmlVolume参照)
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

  // ── ループ自動検出(変換設定 LOOP_DETECT、2026-09-19) ──────────────────────────
  // 全チャンネルの音符列をフレームごとの署名(音程+その音符の頭か)にして、「T フレーム後ろへずらしても
  // 一致する区間」が末尾から最も長く続く周期 T を探す。戻り値 { start, period, span } か null。
  //   start  … 周期性が成り立ち始めるフレーム(=イントロの終わり)
  //   period … ループ1周のフレーム数
  //   span   … 一致を確認できた長さ(フレーム)。1周ぶん以上確認できたものだけ採用する
  // ・キャプチャが「イントロ+2周」より短いと確認できないので検出しない(変換する長さを伸ばす)
  // ・曲が終わって無音が続くだけの末尾は「どの T でも一致」するので、ループ区間に音符が無ければ捨てる
  // ・T の倍数も候補になるが、確認できた長さ(span)が最大の T を選ぶので基本周期が勝つ
  // ・キャプチャの末尾 LOOP_TAIL_GUARD フレームの食い違いは数えない(下の tailGuard)
  // opt(省略可):
  //   hint … 元データが持つループ情報 { start, period }(フレーム、小数可)。VGMヘッダのループ位置/ループ長など、
  //           再生側が実際にそこへ戻る「正解」。あれば音符列の探索より優先し、キャプチャは「イントロ+1周」で足りる
  //   why  … 見つからなかったときの理由を why.reason に入れて返す('short' / 'none' / 'silent' / 'tail' /
  //           'hintShort'=hint はあるがキャプチャが「イントロ+1周」に足りない。why.needFrames に必要な長さ)。
  //           emitScore が MML のヘッダコメントに書く(黙って通常出力に戻ると、なぜループしないのか分からない)
  const LOOP_MIN_PERIOD = 240;        // 4秒未満の周期はリフの繰り返しと区別できないので見ない
  const LOOP_MISMATCH_RATE = 0.003;   // 一致区間に許す食い違いの割合(キャプチャの1フレーム揺れを許す)
  const LOOP_MIN_ONSETS = 8;          // ループ1周に最低これだけ音符の頭が無ければループと見なさない
  // キャプチャ末尾の切れ端は信用しない: 減衰して消えた音符は「次の音符の頭まで」の長さで来るので、キャプチャの
  // 終わりで次の音符が無いと1周目より短く切れる(Power Strike II(SMS)曲3のノイズ: 1周目 2278-2313 / 2周目 4538-4545。
  // 末尾から数えて最初の9フレームで食い違いが上限 8 を超え、真の周期 2260 が即座に棄却されていた)
  const LOOP_TAIL_GUARD = 120;
  MML.Convert.detectLoop = function (channelsData, totalFrames, opt) {
    opt = opt || {};
    const why = opt.why || {};
    const N = totalFrames | 0;
    const hint = opt.hint && opt.hint.period > 0 ? opt.hint : null;
    if (N < LOOP_MIN_PERIOD * 2 && !hint) { why.reason = 'short'; return null; }
    const sig = new Int32Array(N);
    const busy = new Uint8Array(N);
    const onset = new Uint8Array(N); // そのフレームでどれかのチャンネルの音符が始まる
    for (const chan of channelsData || []) {
      const lane = new Int32Array(N); // 0=休符
      for (const ev of chan.events || []) {
        if (ev.note == null) continue;
        const a = Math.max(0, ev.start | 0), b = Math.min(N, ev.end | 0);
        const v = (Math.round(ev.note) + 4) * 2;
        for (let f = a; f < b; f++) { lane[f] = v + (f === a ? 1 : 0); busy[f] = 1; }
        if (a < N) onset[a] = 1;
      }
      for (let f = 0; f < N; f++) sig[f] = (Math.imul(sig[f], 1000003) + lane[f] + 7) | 0;
    }
    const soundCheck = (b, minOnsets) => {
      let sounding = 0, onsets = 0;
      for (let f = b.start; f < b.start + b.period && f < N; f++) { sounding += busy[f]; onsets += onset[f]; }
      if (sounding < b.period * 0.05) { why.reason = 'silent'; return false; } // ほぼ無音の区間=曲が終わっているだけ
      // 曲が終わったあと1音が鳴りっぱなし(または消え残り)の末尾も「どの T でも一致」する。ループ1周の中に
      // 音符の頭がほとんど無ければ曲ではないので捨てる(Batman (Prototype) 曲1 の末尾で誤検出した)
      if (onsets < minOnsets) { why.reason = 'tail'; return false; }
      return true;
    };
    // 元データのループ情報(VGMヘッダ等)があればそれを使う。再生側がそこへ戻るのは確定しているので、
    // 音符列での確認は要らない(キャプチャの揺れやノイズの減衰の違いで棄却されることもない)。
    // ★周期はフレームへ丸める。ループ長がフレームの整数倍でない曲は、NSFでは1周ごとに端数ぶんずれる
    //   (元のフレーム格子で取ったキャプチャに合わせる以上、避けられない)
    if (hint) {
      const T = Math.round(hint.period), s = Math.max(0, Math.round(hint.start || 0));
      if (T >= 30 && s + T <= N) {
        const b = { start: s, period: T, span: 0, hinted: true };
        return soundCheck(b, 1) ? b : null;
      }
      // キャプチャが「イントロ+1周」に満たない: 下の探索にも回すが、見つからなければ理由は「長さ不足」
      if (T >= 30 && s + T > N) why.needFrames = s + T;
    }
    let best = null;
    for (let T = LOOP_MIN_PERIOD; T * 2 <= N; T++) {
      // 末尾 tailGuard フレームの食い違いは数えない(LOOP_TAIL_GUARD のコメント)。その区間で最も手前の
      // 食い違いの直前から照合を始める。確認できた長さ span には読み飛ばした末尾も含める
      const tailGuard = Math.min(LOOP_TAIL_GUARD, T >> 2);
      let f0 = N - T - 1;
      for (let f = N - T - 1; f >= N - T - tailGuard && f >= 0; f--) if (sig[f] !== sig[f + T]) f0 = f - 1;
      // 早期棄却: 最後の1周ぶんを粗く見て、明らかに合わない T は飛ばす
      let quick = 0;
      const step = Math.max(1, (T / 48) | 0);
      for (let f = f0, k = 0; k < 48 && f >= N - 2 * T; f -= step, k++) if (sig[f] !== sig[f + T]) quick++;
      if (quick > 3) continue;
      let mism = 0, start = N - T;
      for (let f = f0; f >= 0; f--) {
        if (sig[f] !== sig[f + T]) mism++;
        const len = f0 + 1 - f;
        if (mism > LOOP_MISMATCH_RATE * len + 8) break;
        if (sig[f] === sig[f + T] && mism <= Math.max(2, LOOP_MISMATCH_RATE * len)) start = f;
      }
      const span = N - T - start;
      if (span < T) continue; // 1周ぶん確認できていない
      if (!best || span > best.span) best = { start, period: T, span };
    }
    if (!best) { why.reason = why.needFrames ? 'hintShort' : N < LOOP_MIN_PERIOD * 2 ? 'short' : 'none'; return null; }
    return soundCheck(best, LOOP_MIN_ONSETS) ? best : null;
  };
  // detectLoop の why.reason → MML ヘッダコメントの文(emitScore)
  const LOOP_FAIL_TEXT = {
    short: '変換した長さが短すぎて周期を確かめられませんでした',
    none: '全チャンネルで一致する周期が見つかりませんでした(ループしない曲か、変換した長さが「イントロ+2周」に足りない)',
    silent: '周期的なのは無音の末尾だけでした(ループしない曲と判断)',
    tail: '周期的なのは音符の頭がほとんど無い末尾(鳴りっぱなし/消え残り)だけでした(ループしない曲と判断)'
  };

  // frame(ループ開始位置)をまたぐイベントを必ず2つに割る。
  // ・音符は後半をタイにしない(continued を付けない=打ち直す)。タイの途中には L を置けないため
  //   (emitScore の L 位置選びのコメント参照)。休符は割るだけ
  // ・またぎが tol フレーム以内の切れ端になるなら割らず、音符の端を frame へ寄せる(1〜2フレームの
  //   切れ端を打ち直すと耳障りなうえ、192分音符の列になる。寄せ幅は音長の丸めの許容と同じ)
  function splitAtFrame(events, frame, tol) {
    const out = [];
    tol = Math.max(0, tol | 0);
    for (const ev of events) {
      if (ev.start < frame && ev.end > frame) {
        if (frame - ev.start <= tol) { out.push(Object.assign({}, ev, { start: frame })); continue; }
        if (ev.end - frame <= tol) { out.push(Object.assign({}, ev, { end: frame })); continue; }
        out.push(Object.assign({}, ev, { end: frame }));
        const tail = Object.assign({}, ev, { start: frame });
        if (ev.note === null) tail.continued = true; else { delete tail.continued; delete tail.slurTie; }
        out.push(tail);
      } else out.push(ev);
    }
    return out;
  }

  // LEN_DP が OFF のときの音長の計画(renderEvents が音符ごとに framesToLengths+持ち越しで決めるのと同じ結果を
  // 先に作る)。ループ自動検出のピン留めは「イベントごとの音価トークン列」が手元に無いとできないため
  function buildGreedyPlan(events, fpb, lenSnap, cmd) {
    const map = new Map();
    const exactOn = MML.Convert.dpcmExactOf(cmd);
    let carry = 0;
    for (const e of events) {
      const dur = e.end - e.start;
      if (!(dur > 0)) continue;
      const q = MML.Convert.framesToLengths(dur, fpb, carry, (exactOn && e.exact) ? 0 : lenSnap);
      carry = q.carryOut;
      map.set(e, q.lengths);
    }
    return map;
  }

  // ── ピン留め: pins(フレーム位置)までに書いた音長の合計を、全チャンネル共通の tick 値に合わせる ──
  // ★なぜ要るか(ユーザー指摘 2026-09-19): イントロの長さとループ1周の長さがチャンネルごとに1フレームでも違うと、
  //   NSFは各チャンネルが自分の L へ独立に戻るので、周回のたびにチャンネル間がずれていく。
  //   音長の量子化はチャンネルごとに独立(境界のずれは許容内)なので、何もしないと合計は一致しない。
  // ・コンパイラは端数を持ち越して丸める(framesForLength の carry)ので、先頭からの tick の合計が同じなら
  //   そこまでのフレーム数も同じになる。よって tick を一致させれば十分
  // ・目標 tick は元のフレーム位置を 192分音符(10tick)の格子へ丸めた値。コンパイル後のフレーム位置が
  //   丸めの境目(x.5)に近いと浮動小数の足し順で1フレーム転びうるので、境目から遠い格子点を選ぶ
  // ・ピン直前のイベントの音長を差分だけ伸縮する。足りなければ手前のイベントからも借りる
  // ピンの目標 tick = 元のフレーム位置を 192分音符(10tick)の格子へ丸めた値。
  // (最初は「コンパイル後のフレーム位置が丸めの境目 x.5 に近い格子点を避ける」ために最大±30tick ずらして
  //  いたが、フレーム基準のピン留め(pinPlan)にした今は不要。ずらしたぶん(最大1.5フレーム)がループ区間の
  //  全音符に持ち越され、2〜6フレームの音符が続くパートで元曲との食い違いが目立った)
  function pinTickFor(frame, fpb) {
    const Q = MML.Convert.LENGTH_QUANTUM;
    return Math.round(frame * (MML.Convert.TPQN / fpb) / Q) * Q;
  }
  // ★本当に一致させたいのは「コンパイル後のフレーム数」(NSFのバイトコードは音符ごとのフレーム数を焼き込むので、
  //   イントロとループ1周のフレーム数がチャンネル間で同じなら何周しても揃ったまま)。tick の合計を揃えるのは
  //   その手段だが、コンパイラは1トークンを最低1フレームにするので、192分音符(テンポ150で0.5フレーム)のような
  //   極小トークンが境界の手前に並ぶチャンネルは、tick が同じでも1フレーム長くなる(Crisis Force のパルス1で実測)。
  //   そこで tick で合わせたあと、コンパイラと同じ丸め(duration.js simulateCompiledFrames)で数え、
  //   全チャンネル共通の目標フレーム数 round(pinTick × フレーム/tick) になるまで、境界直前のイベントの音長を
  //   192分音符単位で伸縮する(足りなければ2つ3つ手前のイベントでも試す)
  function pinPlan(events, plan, fpb, pins, tempoBpm) {
    if (!(tempoBpm > 0)) return false; // テンポが分からないとフレーム数を数えられない=一致を保証できない
    if (!pinPlanTicks(events, plan, fpb, pins, tempoBpm)) return false;
    const Q = MML.Convert.LENGTH_QUANTUM;
    const framesPerTick = (240 / Math.round(tempoBpm)) * 60.0988 / (MML.Convert.TPQN * 4);
    const sim = (toks, carry) => MML.Convert.simulateCompiledFrames(toks, tempoBpm, carry);
    const list = events.filter(e => e.end - e.start > 0);
    const carryIn = [], cumIn = [];
    let cum = 0, carry = 0, lastPinIdx = -1;
    for (let i = 0; i < list.length; i++) {
      carryIn[i] = carry; cumIn[i] = cum;
      const r = sim(plan.get(list[i]), carry);
      cum += r.frames; carry = r.carry;
      if (pins.indexOf(list[i].end) < 0 || list[i].end === 0) continue;
      const target = Math.round(pinTickFor(list[i].end, fpb, tempoBpm) * framesPerTick);
      let ok = cum === target;
      for (let j = i; !ok && j > lastPinIdx && j >= i - 3; j--) {
        const curTicks = MML.Convert.lengthsTicks(plan.get(list[j]));
        const saved = plan.get(list[j]);
        for (const k of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8]) {
          const nt = curTicks + k * Q;
          if (nt < Q) continue;
          const toks = MML.Convert.ticksToLengthsExact(nt);
          if (!toks) continue;
          plan.set(list[j], toks);
          let c2 = carryIn[j], f2 = cumIn[j];
          for (let m = j; m <= i; m++) { const rr = sim(plan.get(list[m]), c2); f2 += rr.frames; c2 = rr.carry; }
          if (f2 === target) { ok = true; cum = f2; carry = c2; break; }
          plan.set(list[j], saved);
        }
      }
      if (!ok) return false;
      lastPinIdx = i;
    }
    return lastPinIdx >= 0 || pins.every(p => p === 0);
  }
  function pinPlanTicks(events, plan, fpb, pins, tempoBpm) {
    const Q = MML.Convert.LENGTH_QUANTUM;
    let written = 0, lastPinIdx = -1;
    const list = events.filter(e => e.end - e.start > 0);
    for (let i = 0; i < list.length; i++) {
      const toks = plan.get(list[i]);
      if (!toks) return false;
      written += MML.Convert.lengthsTicks(toks);
      if (pins.indexOf(list[i].end) < 0) continue;
      if (list[i].end === 0) continue;
      let need = pinTickFor(list[i].end, fpb, tempoBpm) - written;
      for (let j = i; need !== 0 && j > lastPinIdx; j--) {
        const cur = MML.Convert.lengthsTicks(plan.get(list[j]));
        let nt = cur + need;
        if (nt < Q) { need = nt - Q; nt = Q; } else need = 0;
        const exact = MML.Convert.ticksToLengthsExact(nt);
        if (!exact) return false;
        plan.set(list[j], exact);
      }
      if (need !== 0) return false;
      written = pinTickFor(list[i].end, fpb, tempoBpm);
      lastPinIdx = i;
    }
    return lastPinIdx >= 0 || pins.every(p => p === 0);
  }

  // ── 全チャンネルを小節単位で縦に揃えたスコア形式 ────────────────────
  // channelsData: [{ letter, events, hasVolume?, hasInstrument?, hasEnvelope? }]
  // opts:
  //   totalFrames, beatsPerMeasure(既定4), measuresPerLine(既定4),
  //   tempoBpm(指定すると先頭に "<使用チャンネル文字列> t<bpm>" 行を1本だけ出す),
  //   headerLines(スコア全体の先頭に足す生テキスト行)
  MML.Convert.emitScore = function (channelsData, fpb, opts) {
    opts = opts || {};
    let totalFrames       = opts.totalFrames || 0;
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

    // ── ループ自動検出(変換設定 LOOP_DETECT、2026-09-19) ──────────────────────────
    // 元曲のループ周期を検出し、イントロ+1周ぶん [0, loop.end) だけを書き出して L を置く。
    // ループ開始は可能なら直後の小節線へ寄せる(周期性は loop.start 以降ずっと成り立つので、後ろへずらしても
    // 同じ長さの1周が取れる。L が小節の頭に来て譜面が読みやすい)。
    let loop = null;
    let loopFailLine = null;
    if (layout.LOOP_DETECT && totalFrames > 0) {
      const why = {};
      const found = MML.Convert.detectLoop(channelsData, totalFrames, { hint: opts.loopHint, why });
      if (!found) {
        loopFailLine = why.reason === 'hintShort'
          ? `; ループ自動検出: 元データのループ(イントロ+1周=${why.needFrames}フレーム)に対して変換した長さ ${totalFrames}フレームが足りないため、通常の出力にしました(変換する長さを伸ばしてください)`
          : `; ループ自動検出: ${LOOP_FAIL_TEXT[why.reason] || 'ループは見つかりませんでした'}。変換した長さ ${totalFrames}フレーム。通常の出力にしました`;
      }
      if (found) {
        // ★L は「どのチャンネルの音符もまたがない位置」に置く。タイで繋がった音符の途中には L を置けない
        //   (コンパイラはタイを1つの音符にまとめるので L が音符の境界に来ず、NSFではそのチャンネルの
        //   ループ先が登録されずに止まる。キャプテン翼II/Crisis Force で実測)。
        //   候補は「検出した開始位置」と、そこから1周ぶんの間にある小節線。またぐ音符が最も少ない候補を選び、
        //   同数なら小節線を優先、それでも同じなら早いほう。残ったまたぎは splitAtFrame が打ち直しにする
        const tol = Math.max(1, MML.Convert.lenSnapOf(opts.cmd) | 0);
        const crossings = (p) => channelsData.reduce((n, c) => n + ((c.events || []).some(ev =>
          ev.note != null && p - ev.start > tol && ev.end - p > tol) ? 1 : 0), 0);
        const cands = [{ p: found.start, bar: found.start === 0 }];
        for (let k = Math.ceil(found.start / framesPerMeasure - 1e-9); ; k++) {
          const p = Math.round(k * framesPerMeasure);
          if (p >= found.start + found.period || p + found.period > totalFrames) break;
          if (p > found.start) cands.push({ p, bar: true });
        }
        let pick = null;
        for (const c of cands) {
          c.x = crossings(c.p);
          if (!pick || c.x < pick.x || (c.x === pick.x && c.bar && !pick.bar)) pick = c;
        }
        loop = { start: pick.p, end: pick.p + found.period, period: found.period, span: found.span, crossings: pick.x, hinted: !!found.hinted };
      }
    }
    const fullFrames = totalFrames;
    const savedEvents = channelsData.map(c => c.events); // ピン留めに失敗したら元へ戻して通常出力する(下)
    if (loop) {
      totalFrames = loop.end;
      // ループ終端より先のイベントを捨てる(呼び出し側の scoreChannels も同じ配列を見ているので、あとの
      // 音程検証 verifyPitch も書き出した範囲だけを比べるようになる)
      for (const chan of channelsData) {
        chan.events = (chan.events || []).filter(ev => ev.start < loop.end)
          .map(ev => ev.end > loop.end ? Object.assign({}, ev, { end: loop.end }) : ev);
      }
    }
    // 最後の音より後ろは書かない(2026-09-19、ユーザー指示): 曲が終わったあとの無音(ジングルを30秒ぶん
    // キャプチャした残り等)を休符で埋めると、再生もNSFも「無音を最後まで演奏してから」終わる。全チャンネルで
    // 最後に音が鳴り終わる位置を曲の終わりにし、各チャンネルの末尾の休符も落とす(下の trimTail)。
    // ループ化するときは全チャンネルの全長を揃える必要があるので対象外
    // ★DPCM(E)の音符は「次の一打まで」の長さで来る(サンプルの実際の長さではない)ので、最後の一打は
    //   キャプチャの終わりまで伸びている。音の長さとしては数えず、TAIL フレームだけ鳴らして切る
    // ★リリース(@vr)つきの音符は、音符の終わり(キーオフ)のあとも余韻が鳴る。その余韻を鳴らしているのは後ろの
    //   休符(k)なので、余韻ぶんは「音が鳴っている」と数えて落とさない(落とすとトラックが終わって余韻が切れる。
    //   魍魎戦記MADARA のパルスBが14フレーム早く切れて発覚)。余韻の長さは releaseEnd、無ければ RELEASE_TAIL まで
    const DPCM_TAIL = 60, RELEASE_TAIL = 120;
    const chanSoundEnd = (chan) => {
      const isDpcm = chan.letter === 'E';
      const evs = chan.events || [];
      let end = 0;
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.note == null) continue;
        let e = isDpcm ? Math.min(ev.end || 0, (ev.start || 0) + DPCM_TAIL) : (ev.end || 0);
        if (ev.releaseEnd != null) e = Math.max(e, ev.releaseEnd);
        else if (ev.envelopeVr != null && ev.envelopeVr !== 255) {
          let next = Infinity;
          for (let j = i + 1; j < evs.length; j++) if (evs[j].note != null) { next = evs[j].start; break; }
          e = Math.max(e, Math.min(next, (ev.end || 0) + RELEASE_TAIL));
        }
        if (e > end) end = e;
      }
      return end;
    };
    if (!loop) {
      let songEnd = 0;
      for (const chan of channelsData) songEnd = Math.max(songEnd, chanSoundEnd(chan));
      songEnd = Math.min(songEnd, totalFrames);
      if (songEnd > 0 && songEnd < totalFrames) {
        totalFrames = songEnd;
        for (const chan of channelsData) {
          if (!(chan.events || []).some(ev => ev.end > songEnd)) continue;
          chan.events = chan.events.filter(ev => ev.start < songEnd)
            .map(ev => ev.end > songEnd ? Object.assign({}, ev, { end: songEnd }) : ev);
        }
      }
    }
    const trimTail = (evs, soundEnd) => { let n = evs.length; while (n > 0 && evs[n - 1].note == null && evs[n - 1].start >= soundEnd) n--; return n === evs.length ? evs : evs.slice(0, n); };
    const measureCount = Math.max(1, Math.ceil(totalFrames / framesPerMeasure));

    // 小節境界(整数フレームに丸める)
    const boundaries = [];
    for (let m = 1; m < measureCount; m++) boundaries.push(Math.round(m * framesPerMeasure));

    const lines = [];
    // 定義行には「どのチャンネルで使っているか」のコメントを付けて並べ替える(annotateDefinitions)。
    // 本文ができてからでないと使っているチャンネルが分からないので、ここでは位置だけ控えて後で差し替える
    const headerAt = lines.length, headerCount = opts.headerLines ? opts.headerLines.length : 0;
    if (opts.headerLines) lines.push(...opts.headerLines);
    if (loop) {
      lines.push(`; ループ自動検出: ${loop.start}フレーム目から ${loop.period}フレーム周期(` +
        (loop.hinted ? `元データのループ情報による。変換した長さは ${fullFrames}フレーム` : `元の ${fullFrames}フレームのうち ${loop.span}フレームで周期を確認`) + `)。` +
        `イントロ+1周ぶんだけを書き出し、各チャンネルのループ開始位置に L を置いています`);
    } else if (loopFailLine) lines.push(loopFailLine);
    // ★チャンネルが1本も無い(音符が1つも取れなかった曲)ときはテンポ行を出さない。文字の無い " t120" は
    //   コンパイルエラーになり、再生も書き出しもできないMMLになる(PSF の Gran Turismo arcade.psf で発覚)
    if (opts.tempoBpm != null && channelsData.length) {
      const letters = channelsData.map(c => c.letter).join('');
      lines.push(`${letters} t${Math.round(opts.tempoBpm)}`);
    }

    // チャンネルごとに: ギャップ補完 → 小節境界で分割 → 小節バケツへ → テキスト化
    let loopPinFailed = false;
    let loopFrameCheck = null; // 最初のチャンネルの { L までのフレーム数, 全長 }。以降のチャンネルと突き合わせる
    const perChannelMeasureTexts = channelsData.map(chan => {
      // 変換設定(src/convert/options.js opts.cmd): 譜面整形(短い休符吸収)を
      // ギャップ補完の前に掛け、コマンドフラグは下でANDマスクする(割当層で止め切れ
      // なかった分の安全網)
      const filled  = fillGaps(MML.Convert.shapeEvents(chan.events, fpb, opts.cmd), totalFrames);
      let split     = splitAtBoundaries(filled, boundaries, MML.Convert.lenSnapOf(opts.cmd));
      if (!loop) split = trimTail(split, chanSoundEnd(chan));
      // ループ開始位置では必ず割る(L をイベントの頭に置くため)。端を寄せた結果できた隙間は休符で埋め直す
      if (loop) split = fillGaps(splitAtFrame(split, loop.start, MML.Convert.lenSnapOf(opts.cmd)).filter(e => e.note !== null || e.end > e.start), totalFrames);
      // L の直後の音符は必ず打ち直しにする: 小節線の分割(continued)やスラー(slurTie)で前の音符とタイに
      // なっていると「タイの途中の L」になり、NSFでそのチャンネルのループ先が登録されない
      if (loop) split = split.map(e => (e.start === loop.start && e.note !== null && (e.continued || e.slurTie))
        ? Object.assign({}, e, { continued: false, slurTie: false }) : e);
      let plan      = loop ? null : buildLengthPlan(split, fpb, MML.Convert.lenSnapOf(opts.cmd), opts.cmd);
      if (loop) {
        // 音長の計画はイントロ部分とループ部分で別々に立てる。通しで立てると、L の位置で音長を調整した
        // ずれがループ区間の全音符へ持ち越される。ループ部分は L を起点に誤差ゼロから量子化し直す
        const planFor = (evs) => buildLengthPlan(evs, fpb, MML.Convert.lenSnapOf(opts.cmd), opts.cmd) ||
          buildGreedyPlan(evs, fpb, MML.Convert.lenSnapOf(opts.cmd), opts.cmd);
        plan = new Map([...planFor(split.filter(e => e.end <= loop.start)), ...planFor(split.filter(e => e.start >= loop.start))]);
        // ピン留め: ループ開始/終端までのフレーム数を、全チャンネル共通の値にぴったり合わせる
        const ok = pinPlan(split, plan, fpb, [loop.start, loop.end], opts.tempoBpm);
        if (!ok) loopPinFailed = true;
        // 最終検査: コンパイラと同じ丸めで数えた「L までのフレーム数」と「全長」が、全チャンネルで同じか。
        // tick の合計を揃えてあっても、最低1フレームの切り上げが境界の直前に残ると1フレームずれる
        if (ok && opts.tempoBpm > 0) {
          let carry = 0, frames = 0, atLoop = null;
          for (const e of split) {
            if (!(e.end - e.start > 0)) continue;
            if (atLoop === null && e.start >= loop.start) atLoop = frames;
            const r = MML.Convert.simulateCompiledFrames(plan.get(e), opts.tempoBpm, carry);
            frames += r.frames; carry = r.carry;
          }
          if (atLoop === null) atLoop = frames;
          if (loopFrameCheck === null) loopFrameCheck = { atLoop, frames };
          else if (loopFrameCheck.atLoop !== atLoop || loopFrameCheck.frames !== frames) loopPinFailed = true;
        }
      }
      const buckets = bucketByMeasure(split, framesPerMeasure, measureCount);
      const flags = MML.Convert.maskEmitFlags({
        hasVolume: !!chan.hasVolume, hasInstrument: !!chan.hasInstrument,
        hasEnvelope: !!chan.hasEnvelope, hasFme7Env: !!chan.hasFme7Env, hasVrc7Tone: !!chan.hasVrc7Tone,
        hasFdsMod: !!chan.hasFdsMod, hasFme7Noise: !!chan.hasFme7Noise, hasDetune: !!chan.hasDetune,
        hasSweep: !!chan.hasSweep,
        noiseIndexNotes: chan.letter === 'D', // 2A03ノイズ: 音符を n<周期index> で書く(noiseNoteToIndex参照)
        vrc7Vol: VRC7_LETTER.test(chan.letter), // VRC7: 内部の音量(レジスタの減衰値)を v=15-値 で書く(vrc7MmlVolume参照)
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
      if (loop) {
        flags.loopStart = loop.start;
        flags.loopMark = LOOP_MARK;
        flags.usesSa = split.some(e => !!e.pitchSa);
        flags.usesRelTone = split.some(e => e.releaseTone != null && e.releaseTone !== 255);
      }
      const state = newState();
      let first = true;
      return buckets.map(bucketEvents => {
        let text = '';
        if (first) { text += `l${flags.defaultLen}`; state.hasEmitted = true; first = false; }
        renderEvents(bucketEvents, fpb, flags, state, tok => { text += tok; });
        return text;
      });
    });
    // ピン留めできなかったチャンネルがある(極端に短いイベントしか無い等): イントロ/ループの長さを全チャンネルで
    // 一致させられないので、ずれていくループを出すよりループ化そのものをやめて通常の出力へ戻す
    if (loop && loopPinFailed) {
      channelsData.forEach((c, i) => { c.events = savedEvents[i]; });
      return MML.Convert.emitScore(channelsData, fpb, Object.assign({}, opts, {
        cmd: Object.assign({}, opts.cmd, { LOOP_DETECT: false }),
        headerLines: (opts.headerLines || []).concat(['; ループ自動検出: ループは見つかりましたが、全チャンネルの長さを一致させられなかったため通常の出力にしました'])
      }));
    }

    if (headerCount) {
      const bodies = perChannelMeasureTexts.map(texts => texts.join(' '));
      lines.splice(headerAt, headerCount, ...annotateDefinitions(opts.headerLines, channelsData.map(c => c.letter), bodies));
    }

    // ── ループ位置で譜面を前後に分ける(2026-09-19、ユーザー指示「L が見落としやすい」) ──
    // renderEvents は L の代わりに目印 LOOP_MARK を出している。全チャンネルで目印が同じ小節にあれば、
    // その小節を目印の前後で割り、「イントロ | DXYZ L の1行 | ループ部分」の順に並べる
    // (ppmck はチャンネル行を順に連結するので、独立した「DXYZ L」行は各チャンネルのその位置の L と同じ)。
    // 小節がそろわない等で割れないときは、目印をその場の L に戻して従来どおり行の途中に置く
    let segments = [perChannelMeasureTexts];
    if (loop) {
      const at = perChannelMeasureTexts.map(texts => texts.findIndex(t => t.indexOf(LOOP_MARK) >= 0));
      if (at.every(m => m >= 0 && m === at[0])) {
        const mi = at[0];
        const pre = [], post = [];
        perChannelMeasureTexts.forEach(texts => {
          const k = texts[mi].indexOf(LOOP_MARK);
          const a = texts[mi].slice(0, k), b = texts[mi].slice(k + LOOP_MARK.length);
          pre.push(texts.slice(0, mi).concat(a.trim() ? [a] : []));
          post.push([b].concat(texts.slice(mi + 1)));
        });
        segments = [pre, null, post]; // null = 「DXYZ L」の行
      } else {
        segments = [perChannelMeasureTexts.map(texts => texts.map(t => t.split(LOOP_MARK).join('L')))];
      }
    }
    const loopLineOf = (ciList) => `${ciList.map(ci => channelsData[ci].letter).join('')} L`;
    const allCi = channelsData.map((c, i) => i);

    // 小節揃え(BAR_ALIGN): 小節ごとに全チャンネル中の最大幅で列を揃える。OFF ならスペース1つで区切る
    const layoutSegment = (segTexts) => {
      const count = Math.max(0, ...segTexts.map(t => t.length));
      const colWidth = [];
      for (let m = 0; m < count; m++) {
        let w = 0;
        if (barAlign) for (const texts of segTexts) w = Math.max(w, (texts[m] || '').trimStart().length);
        colWidth.push(w);
      }
      const lineOf = (ci, blockStart, blockEnd) => {
        let line = `${channelsData[ci].letter} `;
        for (let m = blockStart; m < blockEnd; m++) {
          const t = (segTexts[ci][m] || '').trimStart(); // 小節頭がコマンドだと先頭に区切り空白が付くので落とす
          if (barAlign) line += t.padEnd(colWidth[m]) + ' ';
          else if (t) line += t + ' '; // 空の小節(音符が続いているだけ)は詰める
        }
        return line.trimEnd();
      };
      return { count, lineOf };
    };
    const laid = segments.map(seg => (seg ? layoutSegment(seg) : null));

    if (partOrder === 'part') {
      // パートごとにまとめる: A を最後まで出してから B へ(パートの間は空行)。ループはパートごとに「A L」の行
      for (let ci = 0; ci < channelsData.length; ci++) {
        if (ci > 0) lines.push('');
        for (const seg of laid) {
          if (!seg) { lines.push(loopLineOf([ci])); continue; }
          for (let blockStart = 0; blockStart < seg.count; blockStart += measuresPerLine) {
            const l = seg.lineOf(ci, blockStart, Math.min(seg.count, blockStart + measuresPerLine));
            if (l !== channelsData[ci].letter) lines.push(l);
          }
        }
      }
      return lines.join('\n');
    }
    // チャンネル順に小節ブロックで並べる(既定): 全パートを BARS_PER_LINE 小節ずつ縦に揃える
    laid.forEach((seg, si) => {
      if (!seg) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); lines.push(loopLineOf(allCi), ''); return; }
      for (let blockStart = 0; blockStart < seg.count; blockStart += measuresPerLine) {
        const blockEnd = Math.min(seg.count, blockStart + measuresPerLine);
        const block = allCi.map(ci => seg.lineOf(ci, blockStart, blockEnd));
        if (block.every((l, ci) => l === channelsData[ci].letter)) continue; // 中身の無いブロック(ループ位置の直前など)
        lines.push(...block);
        if (blockEnd < seg.count) lines.push('');
      }
      if (si < laid.length - 1 && lines[lines.length - 1] !== '') lines.push('');
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();

    return lines.join('\n');
  };
  // ── 定義行の「使っているチャンネル」コメントとグループ分け(2026-09-19、ユーザー要望) ──
  // ヘッダの定義行(@v/@vr/@EP/@EN/@MP/@@<n>={}/@N/@FM/@OP/@OT/@MH/@MW/@DPCM)ごとに、本文でその番号を
  // 使っているチャンネルを数える。種類ごとの塊(各レジストリが続けて出す)の中で「同じチャンネルの組」の定義を
  // 集め、組が変わる所にだけ「; ── A B X で使用 ──」を1行置く(組の中は番号順)。どこにも使われていない定義は
  // 「未使用」の組。定義の直前のコメント行(N163 で縮めた波形の元の定義など)はその定義に付いて一緒に動く。
  // 定義はMMLのどこに書いても同じ(番号で引く)ので、並べ替えても再生・NSFは変わらない
  const DEF_RE = /^(@vr|@v|@EP|@EN|@MP|@OP|@OT|@N|@FM|@MW|@MH|@DPCM|@)(\d+)\s*=/;
  function usageTokens(kind, n) {
    switch (kind) {
      case '@v': return [new RegExp(`@v${n}(?!\\d)`)];
      case '@vr': return [new RegExp(`@vr${n}(?!\\d)`)];
      case '@EP': return [new RegExp(`(^|[^@A-Z])EP${n}(?!\\d)`)];
      case '@EN': return [new RegExp(`(^|[^@A-Z])EN${n}(?!\\d)`)];
      case '@MP': return [new RegExp(`(^|[^@A-Z])MP${n}(?!\\d)`)];
      case '@MH': return [new RegExp(`(^|[^@A-Z])MH${n}(?!\\d)`)];
      case '@OP': case '@OT': return [new RegExp(`(^|[^@A-Z])OP${n}(?!\\d)`)];
      case '@': return [new RegExp(`@@r?${n}(?!\\d)`)]; // @@<n>(音色エンベロープ)と @@r<n>(リリース音色)
      default: return null;
    }
  }
  function annotateDefinitions(headerLines, letters, bodies) {
    const items = []; // { kind, n, lines: [付随コメント…, 定義行] } | { raw: 行 }
    let pending = [];
    for (const line of headerLines) {
      const m = DEF_RE.exec(line);
      if (m) { items.push({ kind: m[1], n: +m[2], line, lines: pending.concat([line]) }); pending = []; continue; }
      if (/^;/.test(line) && !/^; ?(──|=)/.test(line)) { pending.push(line); continue; }
      items.push(...pending.map(l => ({ raw: l }))); pending = [];
      items.push({ raw: line });
    }
    items.push(...pending.map(l => ({ raw: l })));
    // 使っているチャンネル
    const usedBy = (kind, n) => {
      if (kind === '@DPCM') return letters.filter(L => L === 'E');
      if (kind === '@N' || kind === '@FM') {
        const want = kind === '@N' ? /^[P-W]$/ : /^F$/;
        const re = new RegExp(`(^|[^@\\w])@${n}(?!\\d)|@@r${n}(?!\\d)`); // @<n> と @@r<n>(リリース時の波形)
        return letters.filter((L, i) => want.test(L) && re.test(bodies[i]));
      }
      const res = usageTokens(kind, n);
      if (!res) return [];
      return letters.filter((L, i) => res.some(re => re.test(bodies[i])));
    };
    for (const it of items) if (it.kind && it.kind !== '@MW') it.chs = usedBy(it.kind, it.n);
    // @MW は @MH の4番目の値(波形番号)から引く
    for (const it of items) {
      if (it.kind !== '@MW') continue;
      const set = new Set();
      for (const h of items) {
        if (h.kind !== '@MH') continue;
        const p = /\{([^}]*)\}/.exec(h.line);
        const w = p ? p[1].split(/[\s,]+/).filter(Boolean)[3] : null;
        if (w != null && +w === it.n) for (const L of h.chs) set.add(L);
      }
      it.chs = letters.filter(L => set.has(L));
    }
    // 種類ごとの連続した塊の中で、チャンネルの組ごとにまとめる
    const out = [];
    for (let i = 0; i < items.length;) {
      if (!items[i].kind) { out.push(items[i].raw); i++; continue; }
      let j = i;
      while (j < items.length && items[j].kind === items[i].kind) j++;
      const block = items.slice(i, j);
      if (!block.some(it => it.chs.length)) { i = j; continue; } // 全部未使用の種類は見出しごと出さない
      // 種類ごとの見出し(前に空行)
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`; ==== ${items[i].kind === '@' ? '@<n>' : items[i].kind} ${DEF_TITLE[items[i].kind] || ''} ====`);
      const keyOf = (it) => it.chs.length ? it.chs.join(' ') : '';
      const order = (it) => it.chs.length ? letters.indexOf(it.chs[0]) : 1e9; // 未使用は最後
      block.sort((a, b) => (order(a) - order(b)) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0) || (a.n - b.n));
      let prev = null;
      for (const it of block) {
        // どのチャンネルも使っていない定義は出さない(2026-09-19、ユーザー指示)。付随コメントも一緒に落とす
        if (!it.chs.length) continue;
        const key = keyOf(it);
        if (key !== prev) {
          out.push(key ? `; ── ${key} で使用 ──` : '; ── 未使用 ──');
          prev = key;
        }
        out.push(...it.lines);
      }
      i = j;
    }
    if (out.length && out[out.length - 1] !== '' && items.some(it => it.kind && it.chs && it.chs.length)) out.push('');
    return out;
  }
  const DEF_TITLE = {
    '@v': '音量エンベロープ', '@vr': 'リリースエンベロープ', '@EP': 'ピッチエンベロープ', '@EN': 'ノートエンベロープ',
    '@MP': 'ビブラート', '@': 'デューティエンベロープ', '@N': 'N163波形', '@FM': 'FDS波形', '@MW': 'FDS変調テーブル',
    '@MH': 'FDS変調', '@OP': 'VRC7音色', '@OT': 'VRC7音色', '@DPCM': 'DPCMサンプル',
  };

  // L の位置の目印(renderEvents → emitScore)。MML に出てこない制御文字で挟む
  const LOOP_MARK = '\u0001L\u0001';

})(window);
