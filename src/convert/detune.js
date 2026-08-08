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

  function idealFreqOf(note) { return 440 * Math.pow(2, (note - 57) / 12); }

  MML.Convert.applyPitchDetune = function (channels, periodForFreq, opts) {
    opts = opts || {};
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
        const d = Math.round(periodForFreq(ev.rawFreq, ev) - idealPeriod);
        if (d === 0) continue;
        const maxAbsDetune = Math.abs(idealPeriod) * maxAbsDetuneRatio;
        ev.detune = Math.max(-maxAbsDetune, Math.min(maxAbsDetune, d));
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
   *   2. グループ内で理論値に一番近いメンバー(closest)を探す。
   *      - closest自身の理論値からのズレがminCents未満なら、各メンバーを個別に理論値へ
   *        補正する(closestは元々ズレが小さいため実質無補正になり、結果的に「closestは
   *        無補正・他だけ補正」と同じになる。メインを誤判定するリスクは無い)。
   *      - closestの理論値からのズレがminCents以上(=グループ全体がまとまって理論値から
   *        離れている)場合だけ、closestを無補正の基準点として強制固定し、残りをclosestの
   *        「実測値」との差で補正する(★2026-08-02修正: 以前はここも理論値との差で補正して
   *        いたが、それだとclosest自身の理論値からのズレ分だけ他メンバーとの相対差が
   *        水増しされてしまうバグだった。例: closest=+10セント、他方=+15セントの2音を
   *        理論値基準で補正すると、closestは無補正=0セントに飛び、他方は+15セントのまま
   *        →相対差が本来の5セントから15セントへ3倍に拡大する。F1 Spirit(MSX) index64の
   *        Q/Rチャンネル(コーラス幅が原曲1.6Hzのはずが変換後6.8Hzまで開いた)で実測発覚)。
   *        closestの実測値を基準にすれば、closestは理論値へ丸まったまま・他メンバーは
   *        closestとの相対差(=原曲の相対差そのもの)だけ動くので、コーラス幅は保たれる。
   *        こちらは旧detectChorusDetuneと同じ「一番近い方をメインとみなす」判定だが、発動
   *        するのは「グループ全員が理論値から十分離れている」稀なケースに限られるため、
   *        FF(MSX)のような誤判定が起こる場面自体が大きく減る。
   */
  MML.Convert.detectChorusDetune = function (channels, periodForFreq, opts) {
    opts = opts || {};
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
      // グループ全員が理論値から十分離れている場合だけ、closestを無補正の基準点に固定する
      const anchorClosest = Math.abs(closest.cents) >= minCents;

      for (const w of withCents) {
        if (anchorClosest && w === closest) continue; // 基準点として無補正のまま
        if (Math.abs(w.cents) < minCents) continue;
        const pf = pfFor(w.g.ci);
        const idealPeriod = pf(ideal, w.g.ev);
        // anchorClosest時はclosestの「実測値」を基準に相対差を取る(理論値基準だとclosest自身の
        // 理論値からのズレ分だけ相対差が水増しされるバグだったため、上のコメント参照)。
        const basePeriod = anchorClosest ? pf(closest.g.ev.rawFreq, w.g.ev) : idealPeriod;
        const d = Math.round(pf(w.g.ev.rawFreq, w.g.ev) - basePeriod);
        if (d === 0) continue;
        const maxAbsDetune = Math.abs(idealPeriod) * maxAbsDetuneRatio;
        w.g.ev.detune = Math.max(-maxAbsDetune, Math.min(maxAbsDetune, d));
      }
    }
  };
})(window);
