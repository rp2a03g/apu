/*
 * N163内蔵RAMに波形が収まらない曲を、変換の段階で収まる形へ落とす(変換設定 N163_WAVE)
 *
 *   MML.Convert.N163Fit.apply(channels, waveReg, cmd) → ["@N3 を32→16サンプルへ…", …]
 *
 * ■ 何のための処理か
 * N163は128byte内蔵RAMのうち **128-8×有効ch数** バイトしか波形に使えない
 * (レジスタが上から8byte×ch数を占める。src/mml/n163Alloc.js)。同時に鳴っている波形の
 * 合計がこれを超えると src/mml/compiler.js がコンパイルエラーにするため、変換はできるのに
 * 再生もNSF書き出しもできないMMLが出来上がる。
 *
 * 実測(2026-09-05、コーパス全曲): HES 119曲中11曲・VGM 661曲中14曲が該当。うち16曲は
 * アロケータ側が「常に8ch=64byte」と決め打ちしていたバグ(修正済み)で、本当に足りないのは
 * 残り9曲 —— 8chすべてを使うアーケード系VGM(32サンプル=16byte × 8ch = 128byte に対して
 * 枠は64byte)と、6chで96byte要る魔動王グランゾート。これらは実機でも収まらない。
 *
 * ■ 方針('fit'、既定)
 * 曲全体を一律に縮めるのではなく、**あふれた瞬間に居る波形だけ**を大きい順に、必要な数だけ
 * 半分にする(32→16→8→4サンプル)。実測では2〜8枚縮めれば収まり、残りは全長のまま保てる。
 * 判定には src/mml/n163Alloc.js の allocate() をそのまま使う(コンパイラと同じ配置規則・
 * 同じ断片化の結果を見る。ここで独自の見積りを書くと「変換では収めたつもりがコンパイルで
 * 落ちる」というズレが生まれる)。
 *
 * 'keep' を選ぶと何もしない(元の波形長のまま。収まらない曲は従来どおりコンパイルエラー)。
 *
 * ■ 呼んでいる経路と、呼ばなくてよい経路
 *   呼ぶ: hes2mml(既定=PSG 6ch→N163)/ vgm2mml / borrow.js(全形式のユーザー割当)
 *   不要: spc2mml … pcmToN163Waveが常に16サンプルへ揃えるので 8ch×8byte=64byte で必ず収まる
 *                   (周波数式 n163FreqRegRawSpc も waveLen=16 固定。ここで縮めると音程がずれる)
 *         kss2mml既定 … SCCは5chまで。32サンプル×5=80byte ≦ 5ch時の枠88byte
 *         nsf2mml … 元がN163なので実機RAMに収まっていたものしか出てこない
 *
 * ★呼ぶ位置: 波形とev.instrument/ev.rawLengthが確定した直後、かつ音程補正
 *   (applyPitchDetune/detectChorusDetune/assignPitchEnvelope)より前。N163の周波数式は
 *   f = CLOCK*freqReg/(15*65536*waveLen*numCh) と波形長を含むため、縮めた後の長さで
 *   生レジスタ値を計算しないと音程がずれる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};
  const F = MML.Convert.N163Fit = {};

  const MIN_LEN = 4;   // 実機のレジスタ丸め(4の倍数)の下限
  const MAX_ROUNDS = 64; // 無限ループ防止(1回で必ず1枚縮むので実際は波形数×3程度で終わる)

  /** 波形を半分の長さへ。隣り合う2点の平均を採る(単純な間引きより折り返しが軽い) */
  function halve(wave) {
    const n = Math.max(MIN_LEN, Math.floor(wave.length / 2));
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = wave[(i * 2) % wave.length];
      const b = wave[(i * 2 + 1) % wave.length];
      out[i] = Math.max(0, Math.min(15, Math.round((a + b) / 2)));
    }
    return out;
  }

  /**
   * 実機に設定される有効ch数(compiler.js / ppmckDriver.js と同じ「音符を持つ最上位
   * チャンネル位置+1」)。波形に使えるバイト数がこれで決まる。
   */
  F.numChOf = function (channels) {
    let n = 0;
    (channels || []).forEach((ch, i) => {
      if (ch && (ch.events || []).some(ev => ev.note !== null && ev.note !== undefined)) n = i + 1;
    });
    return Math.max(1, n);
  };

  // 変換イベント列 → allocate() が食えるセグメント列。
  // allocate は「seg.freq != null かつ instrument が変わった時点でロード」「休符では解放
  // しない」という規則で区間を作る(n163Alloc.js extractLoadIntervals)。イベントの
  // start/end をそのまま durationFrames に写せば同じ区間になる。
  function toSegments(ch) {
    const segs = [];
    let frame = 0;
    for (const ev of (ch.events || [])) {
      if (ev.start > frame) segs.push({ durationFrames: ev.start - frame, freq: null });
      segs.push({
        durationFrames: Math.max(0, ev.end - ev.start),
        freq: ev.note === null || ev.note === undefined ? null : 1,
        instrument: ev.instrument
      });
      frame = ev.end;
    }
    return segs;
  }

  /**
   * @param {Array} channels N163へ載せたチャンネル(スロット順。events は破壊的に更新)
   * @param {object} waveReg @N の WaveRegistry(waves を破壊的に更新)
   * @param {object} [cmd] 変換設定(normalizeCmd済み)。cmd.N163_WAVE === 'keep' なら何もしない
   * @returns {Array<string>} 縮めた波形の説明(0件なら何もしていない)
   */
  F.apply = function (channels, waveReg, cmd) {
    if (cmd && cmd.N163_WAVE === 'keep') return [];
    if (!waveReg || !waveReg.waves || !waveReg.waves.length) return [];
    const list = (channels || []).filter(ch => ch && ch.events);
    if (!list.length) return [];

    const numCh = F.numChOf(list);
    const letters = list.map((_, i) => 'ch' + i);
    const segmentsByChannel = {};
    list.forEach((ch, i) => { segmentsByChannel[letters[i]] = toSegments(ch); });
    let totalFrames = 0;
    for (const ch of list) for (const ev of ch.events) totalFrames = Math.max(totalFrames, ev.end || 0);

    const original = waveReg.waves.map(w => w.length);
    // 音符の境界は MML へ書き出す量子化で ±LEN_SNAP フレームずれる(src/convert/duration.js)。
    // 変換元の区間どおりに判定すると「変換では収まったのにコンパイルで落ちる」ので、
    // その分だけ常駐区間を広げて判定する(実測: Dimahoo 01、chP の @N5 がフレーム315で置けない)
    const margin = (MML.Convert.lenSnapOf ? MML.Convert.lenSnapOf(cmd) : 2) + 1;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const nMap = {};
      waveReg.waves.forEach((w, i) => { nMap[i] = w; });
      const res = MML.N163Alloc.allocate(letters, segmentsByChannel, nMap, totalFrames, numCh, { margin });
      if (!res.conflicts.length) break;

      // あふれた瞬間に載っている波形のうち、いちばん大きいものを半分にする。
      // 同点なら「その瞬間より後で使われる時間が短い方」=目立ちにくい方から削る。
      const frame = res.conflicts[0].frame;
      const resident = new Set();
      for (const L of letters) {
        for (const iv of MML.N163Alloc.extractLoadIntervals(segmentsByChannel[L], nMap, totalFrames)) {
          if (iv.startFrame - margin <= frame && frame < iv.endFrameExclusive + margin) resident.add(iv.instrument);
        }
      }
      resident.add(res.conflicts[0].instrument); // 置けなかった本人も候補に含める
      const holdOf = (inst) => {
        let t = 0;
        for (const L of letters) {
          for (const iv of MML.N163Alloc.extractLoadIntervals(segmentsByChannel[L], nMap, totalFrames)) {
            if (iv.instrument === inst) t += iv.endFrameExclusive - iv.startFrame;
          }
        }
        return t;
      };
      const cands = [...resident]
        .filter(i => waveReg.waves[i] && waveReg.waves[i].length > MIN_LEN)
        .sort((a, b) => (waveReg.waves[b].length - waveReg.waves[a].length) || (holdOf(a) - holdOf(b)) || (a - b));
      if (!cands.length) break; // これ以上縮められない(全部最小長)
      const pick = cands[0];
      waveReg.waves[pick] = halve(waveReg.waves[pick]);
      const newLen = waveReg.waves[pick].length;
      for (const ch of list) for (const ev of ch.events) if (ev.instrument === pick) ev.rawLength = newLen;
    }

    // 内容が変わったので同一波形の辞書を作り直す(この後 assign() が呼ばれても正しい番号になる)
    waveReg.keyToIndex = new Map(waveReg.waves.map((w, i) => [w.join(','), i]));

    // 縮めた波形は「32→16」のように変化ごとにまとめて1行で報告する
    // (全波形が縮む曲もあるので、1波形1行だとヘッダがそれだけで埋まってしまう)
    const groups = new Map();
    waveReg.waves.forEach((w, i) => {
      if (w.length === original[i]) return;
      const key = original[i] + '→' + w.length;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push('@N' + i);
    });
    if (!groups.size) return [];
    const parts = [...groups.entries()].map(([k, ids]) => `${k}サンプル: ${ids.join(' ')}`);
    return [`N163内蔵RAMに同時に載せられる波形は${numCh}ch使用時で${128 - 8 * numCh}バイト` +
      `(=${(128 - 8 * numCh) * 2}サンプル)しかないため、あふれたぶんの波形を縮めました —— ${parts.join(' / ')}。` +
      `変換設定の「N163波形」を「元の長さのまま」にすれば縮めませんが、その曲は再生も書き出しもできません`];
  };

})(window);
