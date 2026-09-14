/*
 * 実測周波数への音程補正: MML化の際に音符を12平均律の最寄りノート番号へ丸めると、
 * その時点で元の正確な周波数の情報が失われる。さらに変換先チップ(FME-7/N163/VRC7)は
 * 元のMSXチップ(PSG/SCC/FMPAC)と入力クロックが異なるため、同じノート番号でも
 * コンパイラが選ぶ周期/周波数レジスタ値の格子がもう一段粗い(特に高音域で顕著、
 * 例: FME-7はPSGの半分のクロックしか無いため同じ周波数でも使える周期値が約半分に
 * なり、格子の1目盛りが約2倍の音程幅になる)。この「MML化時の丸め」+「別チップでの
 * 再量子化」という二重の丸めにより、原曲より音程がズレて聞こえることがある
 * (KSS→MML変換の高音域で顕著、Final Fantasy(MSX)で実測)。
 *
 * これを避けるため、量子化前の実測周波数(ev.rawFreq)を保持しているノートすべてに対し、
 * 「12平均律の理論値」ではなく「実測周波数に一番近い変換先チップの周期/周波数レジスタ値」
 * を使うよう、D<n>(src/mml/lexer.js 'detune'トークン、生レジスタオフセット)で補正する。
 * 複数チャンネルが同じ音程・同じ楽器で実際にはわずかに周波数が違う(コーラス/デチューン
 * 効果)場合も、各チャンネルが独立に自分の実測周波数へ補正されるため、自然に元の
 * 周波数差(コーラス幅)が再現される。
 *
 * 【この関数を使うべき場面】変換元と変換先でチップ/クロックが異なり、変換先の方が
 * レジスタ格子が粗い「借用変換」(KSSのPSG→FME-7、SCC→N163、FMPAC→VRC7等)。単独の
 * ノートでも二重量子化により実際にズレるため、単独ノートも含めて全て補正する必要がある。
 * 一方、同一チップ・同一クロックのネイティブ変換(例: NSF→2A03自身)ではこの格子ズレが
 * 存在せず、単独ノートの実測誤差はほぼノイズなので、この関数を使わず
 * MML.Convert.detectChorusDetune (下記) を使うこと。
 *
 * MML.Convert.applyPitchDetune(channels, periodForFreq, opts)
 *   channels: [{ letter, events }] … 同じ物理チップ/同じ再生経路を共有するチャンネル群
 *     (例: kss2mmlのPSG→FME7化した3ch)。
 *   periodForFreq(freqHz) -> number … 再生先チップの「周波数→周期/周波数レジスタ値」
 *     変換関数(src/mml/compiler.jsの各チップ用period関数と同じ式だが、丸め・クランプは
 *     入れない生の連続値を返すこと)。D<n>は2つの周期値の差を最後に1回だけ丸めて求める
 *     ため、呼び出し側で先に整数化してしまうと、特に高音域(1周期あたりのHz幅が広い)で
 *     両方が同じ整数へ丸め込まれて本来必要な補正が消えてしまう。
 *   opts.maxAbsDetuneRatio (既定0.5) … 異常値対策のクランプ幅を「そのノートの理論値
 *     レジスタの絶対値に対する比率」で指定する。周期レジスタ(period∝1/freq、FME-7等)
 *     と位相加算レジスタ(freqReg∝freq、N163等)ではスケールが全く異なる(同じ数Hzの
 *     ずれでも生レジスタ値の変化量が数桁違う)ため、固定の絶対値では一方のチップで
 *     緩すぎ他方で厳しすぎになる。理論値そのものを基準にすることでチップ非依存にする。
 *   opts.minCents (既定10) … 実測周波数が理論値からこのセント数未満しかズレていなければ
 *     補正しない(D<n>を付けない)。変換先チップの格子は音域によって粗さが大きく異なる
 *     (例: FME-7は低音域で約4.5セント/1周期、高音域(g6付近)で約48セント/1周期。実測)。
 *     格子が細かい低音域では、無補正でも誤差は数セント程度(=人間の音程弁別閾値
 *     (JND、通常の音楽的文脈で10〜25セント程度)未満)にしかならず、そこにまでD<n>を
 *     付けるとMMLが無意味に見づらくなる。10セントは一般的なJNDの目安・電子チューナーの
 *     「合っている」判定幅と同程度で、低音域(最大でも格子の半分=2〜3セント程度の誤差)を
 *     確実に除外しつつ、高音域(無補正なら最大20セント超の誤差)は確実に補正対象にする
 *     境目として選んだ(この閾値自体はセント=聴感上の量なのでチップ非依存で共通に使える)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  // 「そのノート番号が変換先で実際に鳴る周波数」。基準ピッチ(#TUNING)込み(options.js noteToFreq)。
  // #TUNING は再生側の周波数テーブルごとずらすので、D<n> の理論値もずらした基準で取らないと
  // 全体ずれのぶんまで D<n> に二重計上される
  function idealFreqOf(note) { return MML.Convert.noteToFreq(note); }

  // opts.cmd(src/convert/options.js)の D===false なら何もしない(最寄り半音のまま)
  // ★MMLのD<n>は全音源「正=音程が上がる」(2026-09-14統一、compiler.js pitchRegDir参照)。
  // ここで求める d はレジスタ空間の差(周期レジスタ系は音程が上がると値が減る)なので、
  // periodFnの増減方向で符号を付けてMML値にする(periodFnIncreasingと同じ2点比較)
  function mmlDetuneSign(pf, ev) { return pf(2000, ev) > pf(200, ev) ? 1 : -1; }

  MML.Convert.applyPitchDetune = function (channels, periodForFreq, opts) {
    opts = opts || {};
    if (opts.cmd && MML.Convert.normalizeCmd(opts.cmd).D === false) return;
    const maxAbsDetuneRatio = opts.maxAbsDetuneRatio || 0.5;
    const minCents = opts.minCents != null ? opts.minCents : 10;

    for (const ch of channels) {
      for (const ev of ch.events) {
        if (ev.note == null || ev.rawFreq == null) continue;
        const ideal = idealFreqOf(ev.note);
        // 無補正のまま(理論値通りに)鳴らした時の聴感上のズレがminCents未満なら、
        // そもそも人間に聞き分けられないレベルなので補正しない(D<n>を付けない)。
        const cents = 1200 * Math.log2(ev.rawFreq / ideal);
        if (Math.abs(cents) < minCents) continue;
        const idealPeriod = periodForFreq(ideal, ev);
        // 再生側(compiler.js/ppmckDriver.js)は「テーブルの整数値 round(idealPeriod) + D」を鳴らす。
        // したがって D は「実測値を格子へ丸めた整数 − テーブルの整数」で求める(=実測に一番近い
        // 格子点に必ず着地する)。★2026-09-07修正: 以前は round(raw − idealUnrounded) だったため、
        // テーブル側の丸めと逆向きに出ると1格子ぶん(FME-7 の o6 では約48セント=ほぼ半音)ずれた
        const d = (Math.round(periodForFreq(ev.rawFreq, ev)) - Math.round(idealPeriod)) * mmlDetuneSign(periodForFreq, ev);
        if (d === 0) continue;
        // 上限は整数に落とす(D<n>は整数。VRC7のfnum等、理論値が非整数のチップで上限に張り付くと
        // D129.18… のような小数が出ていた。2026-09-07)
        const maxAbsDetune = Math.floor(Math.abs(idealPeriod) * maxAbsDetuneRatio);
        ev.detune = Math.max(-maxAbsDetune, Math.min(maxAbsDetune, d));
        // SA<num>(N163、pitch.js n163SaForBase参照): この音符のEP/MPが>>saで登録済みの
        // 場合、再生側はDにも同じシフトを掛けるため、Dも縮めて出力する。
        // (assignPitchEnvelopeより後にこの関数が走るNSF/SPC経路向け。HES/KSS/VGMの
        //  「detune先・assign後」順ではassignPitchEnvelope側が同じ縮小を行う)
        if (ev.pitchSa) ev.detune = Math.round(ev.detune / (1 << ev.pitchSa));
      }
    }
  };

  /*
   * MML.Convert.detectChorusDetune(channels, periodForFreq, opts)
   *
   * applyPitchDetuneは「変換先チップの格子が変換元より粗い」二重量子化(KSS→FME7等の借用
   * 変換)向け。同一チップ・同一クロックのネイティブ変換(例: NSF→2A03自身)にはこの格子ズレが
   * 存在しないため、単独ノートの実測誤差はほとんどがノイズであり補正すべきではない。
   * この関数は「複数チャンネルが同じ音程を同時に鳴らしている(コーラス)場合に限り、実測
   * 周波数のわずかな違いを意図的なデチューン効果とみなして補正する」方式(旧detectChorusDetune
   * の考え方を復活させたもの)。
   *
   *   channels: [{ events }] … 複数チャンネルをまとめて渡す(例: NSFのA/B/C)。各evは
   *     start/end(フレーム単位、半開区間)とnote/rawFreqを持つこと。
   *   periodForFreq: function(freqHz, ev)->number、またはchannelsと同じ長さのfunction配列
   *     (チャンネルごとに周期/周波数レジスタの式が異なる場合。例: NSFのパルスと三角波は式が違う)。
   *     第2引数evは呼び出し元がevに積んでおいた追加パラメータ(例: N163の波形長/有効ch数のように
   *     音符ごとに変わりレジスタ換算式に必要な値)を使いたい場合のためのもの。不要なら無視してよい。
   *   opts.maxAbsDetuneRatio: applyPitchDetuneと同じ(既定0.5)。
   *   opts.minCents (既定0): applyPitchDetuneのminCents(既定10)とは別物で、意図的に
   *     ずっと小さい値にしてある。applyPitchDetuneのminCentsは「単独の音を12平均律の
   *     理論値のまま鳴らした時、聴感上ズレて聞こえるか」という絶対音程の話だが、こちらは
   *     「既にコーラスと確定した2音の相対的な音程差(うなり/デチューン感)を再現するか」
   *     という別の問題であり、同じ閾値を使うべきではない。2音が同時に鳴っている時の
   *     うなり(ビート)は数セント程度の差でも明瞭に聞こえるため、単独音のJND(10セント程度)を
   *     そのまま流用すると本来聞こえるはずのコーラス幅まで無補正になってしまう(女神転生II
   *     11曲目のP/Qチャンネル、-8セント程度の差が無補正でユニゾンに潰れた実例で発覚)。
   *     実質的な下限は`d===0`(補正後もレジスタ値が変わらない)のみで十分。
   *
   * アルゴリズム:
   *   1. 「異なるチャンネル」×「同じノート番号」×「時間区間(start/end)が重なる」もの同士を
   *      1グループにまとめる(Union-Findで推移的に連結)。単独(グループサイズ1)のノートは
   *      コーラスではないので一切補正しない。
   *   2. グループ内で理論値に一番近いメンバー(closest)を探し、各メンバー w について(w のチップの
   *      レジスタ空間で) T=round(理論値)、rc=round(closest実測)、rw=round(w実測) を取り、
   *        D_w = (rw − rc) + common、 common = (rc≠T かつ その音域の1格子 ≥ 10セント) ? rc − T : 0
   *      とする(0 なら付けない)。再生側は「テーブルの整数値 T + D」を鳴らすので、
   *        - コーラス幅(rw − rc)は丸めた実測値同士の整数差としてそのまま保たれる(二重丸め無し)
   *        - グループ全体がテーブルから1格子ずれている(rc≠T)とき、closest をテーブル値に固定すると
   *          全員が1格子ぶん実測からずれる。その1格子が聴こえる(10セント以上=JND、applyPitchDetune
   *          の minCents と同じ基準。FME-7 の o6 では1格子≈48セントで半音転ぶ)なら common で全員を
   *          実測の格子へ乗せ、聴こえない(2A03 中音域の1格子≈7セント等)なら固定したままにして
   *          ネイティブ変換で意味の無い D±1 を量産しない
   *        ★判定は closest のセント偏差ではなく「1格子の大きさ」で行う。偏差が10セント未満でも
   *          rc≠T になり得る(高音域で理論値が .5 付近)が、そのとき相対差 rw−rc を T 基準で鳴らすと
   *          w が1格子ずれる(FF(MSX) 1曲目で実測: この判定の取り違えで不一致が6件残った)
   *      ★履歴: 2026-08-02 版は「理論値に一番近いメンバー(closest)を無補正の基準に固定し、他を
   *        closest の実測値との相対差 round(raw − raw_closest) で補正」していた(F1 Spirit index64 の
   *        Q/R でコーラス幅が 1.6Hz→6.8Hz に開いた「水増し」対策)。しかし基準側が鳴らすのは
   *        raw_closest ではなくテーブルの整数値なので、相対差の丸めがテーブル側の丸めと逆向きに
   *        出ると1格子ぶんずれる。Final Fantasy(MSX2, PSG) 1曲目の g6/a6 で実測: 基準 35.50・他 36.00
   *        (テーブル 36)に対し D=round(0.5)=1 → 37 で鳴り、約48セント低い f+6 に転んだ(2026-09-07)。
   *        絶対値方式なら基準 36(D0)・他 36(D0) で両方とも最寄り格子に乗り、F1 Spirit の相対差も
   *        「丸めた実測値同士の差」で保たれるので水増しは起きない。
   */
  MML.Convert.detectChorusDetune = function (channels, periodForFreq, opts) {
    opts = opts || {};
    if (opts.cmd && MML.Convert.normalizeCmd(opts.cmd).D === false) return;
    const maxAbsDetuneRatio = opts.maxAbsDetuneRatio || 0.5;
    // applyPitchDetuneの既定10とは別物(理由は上のコメント参照)。既定0にし、実質的な下限は
    // 呼び出し先のd===0チェック(レジスタ値換算で本当に差が無い場合のみ無補正)に委ねる。
    const minCents = opts.minCents != null ? opts.minCents : 0;
    const pfFor = Array.isArray(periodForFreq) ? (ci => periodForFreq[ci]) : (() => periodForFreq);

    const entries = [];
    channels.forEach((ch, ci) => {
      for (const ev of ch.events) {
        if (ev.note == null || ev.rawFreq == null) continue;
        entries.push({ ev, ci });
      }
    });

    // Union-Find: 異なるチャンネル×同じノート×時間区間重複を1グループに連結する
    const parent = entries.map((_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j];
        if (a.ci === b.ci) continue; // 同一チャンネル内の連続ノートは対象外(和音/コーラスではない)
        if (a.ev.note !== b.ev.note) continue;
        if (a.ev.start < b.ev.end && b.ev.start < a.ev.end) union(i, j); // 時間区間が重なる
      }
    }

    const groups = new Map();
    entries.forEach((e, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(e);
    });

    for (const group of groups.values()) {
      if (group.length < 2) continue; // 単独ノート(コーラスでない)は補正しない

      const ideal = idealFreqOf(group[0].ev.note);
      const withCents = group.map(g => ({
        g, cents: 1200 * Math.log2(g.ev.rawFreq / ideal)
      }));

      let closest = withCents[0];
      for (const w of withCents) if (Math.abs(w.cents) < Math.abs(closest.cents)) closest = w;
      // グループ全体のテーブルからの1格子ずれ(common)を付けるのは、その1格子が聴こえる(10セント以上)音域だけ
      const COMMON_MIN_CENTS = 10;

      for (const w of withCents) {
        if (Math.abs(w.cents) < minCents) continue;
        const pf = pfFor(w.g.ci);
        const idealPeriod = pf(ideal, w.g.ev);
        // 冒頭コメントのアルゴリズム 2。全て w のチップのレジスタ空間で整数に丸めてから差を取る
        // (再生側が鳴らすのは「テーブルの整数値 T + D」なので、丸めは各値に1回ずつ、差は整数同士)
        const T = Math.round(idealPeriod);
        const rc = Math.round(pf(closest.g.ev.rawFreq, w.g.ev));
        const rw = Math.round(pf(w.g.ev.rawFreq, w.g.ev));
        // 1格子の大きさ(セント)。周期型(period∝1/f)も位相加算型(freqReg∝f)も |T|→|T|+1 の比で近似できる
        const unitCents = T !== 0 ? 1200 * Math.log2(1 + 1 / Math.abs(T)) : 0;
        const common = (rc !== T && unitCents >= COMMON_MIN_CENTS) ? rc - T : 0;
        const d = ((rw - rc) + common) * mmlDetuneSign(pf, w.g.ev);
        if (d === 0) continue;
        const maxAbsDetune = Math.floor(Math.abs(idealPeriod) * maxAbsDetuneRatio); // 整数上限(applyPitchDetune参照)
        w.g.ev.detune = Math.max(-maxAbsDetune, Math.min(maxAbsDetune, d));
        // SA<num>: applyPitchDetune側と同じ理由(同上コメント参照)
        if (w.g.ev.pitchSa) w.g.ev.detune = Math.round(w.g.ev.detune / (1 << w.g.ev.pitchSa));
      }
    }
  };
})(window);
