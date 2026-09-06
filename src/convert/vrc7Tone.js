/*
 * VRC7/OPLL 自作音色(@0)の共通処理 —— 「チップ全体で1系統」制約の解決
 *
 *   MML.Convert.Vrc7Tone.nearestPreset(bytes)              → 1-15(いちばん近い内蔵音色)
 *   MML.Convert.Vrc7Tone.resolveConflicts(channels, toneReg, opt)
 *   MML.Convert.Vrc7Tone.compactRegistry(toneReg, channels)
 *
 * ■ 何のための処理か
 * 実機VRC7/OPLLの自作音色スロットはレジスタ $00-$07 の1組しかなく、チップ全体で共有される。
 * 2ch以上が「同時に、違う自作音色で」鳴ることは物理的に不可能で、src/mml/compiler.js の
 * 同時使用チェックはこれをコンパイルエラーにする(実機どおり)。
 *
 * ところが vgm2mml の OPN 4op → VRC7 2op 変換(converter.js opnToOpllBytes)は
 * FMチャンネルごとに別々の @OP<n> を割り当てるため、FMが2ch以上重なった瞬間に必ず違反した。
 * 結果、メガドライブ/X68000/アーケードのVGMは変換結果がコンパイルできず完全な無音になっていた
 * (実測: MD 19/19、X68000 29/30)。ここはその後始末をする層。
 *
 * ■ 方針(チャンネル単位の貪欲割当)
 * 「同時に鳴っているぶんが1音色に収まっていれば定義は何個でもよい」という制約なので、
 *   - 音の詰まっているチャンネルから順に「自作音色のまま」を試す
 *   - 既に確定したチャンネルと重なる区間で音色番号が食い違うチャンネルだけ、
 *     いちばん近い内蔵プリセット(@1-@15)へ落とす
 * とする。音符ごとでなくチャンネル単位で決めるのは、1本の旋律の中で音色の出所が
 * 混ざると聴感上ちぐはぐになるため。時間帯が重ならないチャンネル同士や、同じ音色を
 * 重ねているだけのユニゾンは、そのまま両方とも自作音色で残る。
 *
 * ■ プリセット距離
 * 完全な代替は原理的に無理(実測57曲中56曲が2種類以上の音色を使う)ので、
 * 「潰れ方をなるべく目立たなくする」ための重み付き距離。倍音比(ML)・変調の深さ(mod TL)・
 * 持続音か減衰音か(EG)・波形(WF)を重く、キースケール等を軽く見ている。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};
  const V = MML.Convert.Vrc7Tone = {};

  // VRC7内蔵音色ROM($00-$07の8バイト × 16)。index 0 は自作音色枠なので比較対象外。
  // ★src/emulator/expansion/vrc7.js の VRC7_INST(Nuked-OPLL patch_ds1001 = 実チップの
  //   die shot 読み出し値)の写し。Workerバンドル(spc-capture-worker)へエミュレータを
  //   同梱せずに済ませるための複製で、食い違いは tools/headless/check-all.js が検出する。
  const PRESETS = [
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // 0: ユーザー音色枠
    [0x03, 0x21, 0x05, 0x06, 0xe8, 0x81, 0x42, 0x27], // 1: Buzzy Bell
    [0x13, 0x41, 0x14, 0x0d, 0xd8, 0xf6, 0x23, 0x12], // 2: Guitar
    [0x11, 0x11, 0x08, 0x08, 0xfa, 0xb2, 0x20, 0x12], // 3: Wurly
    [0x31, 0x61, 0x0c, 0x07, 0xa8, 0x64, 0x61, 0x27], // 4: Flute
    [0x32, 0x21, 0x1e, 0x06, 0xe1, 0x76, 0x01, 0x28], // 5: Clarinet
    [0x02, 0x01, 0x06, 0x00, 0xa3, 0xe2, 0xf4, 0xf4], // 6: Synth
    [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x11, 0x07], // 7: Trumpet
    [0x23, 0x21, 0x22, 0x17, 0xa2, 0x72, 0x01, 0x17], // 8: Organ
    [0x35, 0x11, 0x25, 0x00, 0x40, 0x73, 0x72, 0x01], // 9: Bells
    [0xb5, 0x01, 0x0f, 0x0f, 0xa8, 0xa5, 0x51, 0x02], // 10: Vibes
    [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12], // 11: Vibraphone
    [0x71, 0x23, 0x11, 0x06, 0x65, 0x74, 0x18, 0x16], // 12: Tutti
    [0x01, 0x02, 0xd3, 0x05, 0xc9, 0x95, 0x03, 0x02], // 13: Fretless
    [0x61, 0x63, 0x0c, 0x00, 0x94, 0xc0, 0x33, 0xf6], // 14: Synth Bass
    [0x21, 0x72, 0x0d, 0x00, 0xc1, 0xd5, 0x56, 0x06]  // 15: Sweep
  ];
  V.PRESETS = PRESETS;

  // 内蔵音色の名前(NESdev Wiki "VRC7 audio" の音色表準拠)
  V.PRESET_NAMES = ['', 'Buzzy Bell', 'Guitar', 'Wurly', 'Flute', 'Clarinet', 'Synth', 'Trumpet', 'Organ',
    'Bells', 'Vibes', 'Vibraphone', 'Tutti', 'Fretless', 'Synth Bass', 'Sweep'];

  /** resolveConflicts が返す {音色番号: プリセット番号} → "@4 Flute/@7 Trumpet" */
  // ゲームの自作音色(音色エディタの「内蔵音色から…」に載せる)。実機のレジスタ書き込みから採取:
  // 全曲を120秒ずつ鳴らし、キーオン時に有効だった$00-$07の8バイトを重複排除して使用曲数順に並べた。
  // songs は0始まりの曲番号。ラグランジュポイント(コナミ 1991, VRC7)は31曲で49種(2026-09-06)
  V.GAME_TONES = [
    { game: 'ラグランジュポイント', tones: [
      { bytes: [0xb9, 0x01, 0x15, 0x17, 0xa8, 0xa5, 0x51, 0x02], songs: [6, 9, 23, 27, 30] },
      { bytes: [0x61, 0xa1, 0x0a, 0x21, 0x76, 0x52, 0x12, 0x23], songs: [3, 20, 21, 26, 28] },
      { bytes: [0x23, 0x61, 0x1b, 0x06, 0x64, 0x91, 0x51, 0x06], songs: [1, 2, 14] },
      { bytes: [0x13, 0x41, 0x0a, 0x0d, 0xd8, 0xf6, 0x22, 0x12], songs: [5, 12, 15] },
      { bytes: [0x88, 0x81, 0x25, 0x1d, 0xf0, 0xc2, 0x10, 0x23], songs: [8, 14, 16] },
      { bytes: [0x21, 0x61, 0x1b, 0x07, 0x93, 0x81, 0x12, 0x06], songs: [14, 18, 21] },
      { bytes: [0x31, 0xa1, 0x0c, 0x00, 0x76, 0x70, 0x41, 0x04], songs: [3, 4, 14] },
      { bytes: [0x03, 0x21, 0x0a, 0x07, 0xe7, 0x84, 0x32, 0x37], songs: [18, 20] },
      { bytes: [0x33, 0x25, 0x17, 0x00, 0x43, 0x83, 0x14, 0x17], songs: [11, 21] },
      { bytes: [0x25, 0xa1, 0x23, 0x17, 0x65, 0x81, 0x25, 0x25], songs: [0, 21] },
      { bytes: [0x13, 0x41, 0x08, 0x0d, 0xd6, 0xf6, 0x31, 0x00], songs: [5, 21] },
      { bytes: [0x21, 0x04, 0x0c, 0x00, 0x73, 0x74, 0x41, 0x43], songs: [1, 19] },
      { bytes: [0xa1, 0x04, 0x13, 0x03, 0x54, 0xb9, 0x11, 0x02], songs: [10, 19] },
      { bytes: [0x31, 0x34, 0x18, 0x07, 0x63, 0x46, 0x1a, 0x16], songs: [3, 19] },
      { bytes: [0x61, 0x63, 0x02, 0x01, 0x92, 0x90, 0x74, 0x45], songs: [5, 21] },
      { bytes: [0x23, 0x61, 0x16, 0x35, 0x64, 0x81, 0x21, 0x06], songs: [2, 4] },
      { bytes: [0x21, 0x26, 0x0e, 0x06, 0x42, 0x84, 0x62, 0x15], songs: [22] },
      { bytes: [0x01, 0x05, 0x0c, 0x02, 0x80, 0xd2, 0x02, 0x33], songs: [17] },
      { bytes: [0x01, 0x25, 0x0c, 0x03, 0x23, 0x62, 0x42, 0x37], songs: [18] },
      { bytes: [0x02, 0x08, 0xd3, 0x05, 0xc4, 0xc4, 0x23, 0x26], songs: [7] },
      { bytes: [0x01, 0x01, 0x06, 0x08, 0xfa, 0xb4, 0x30, 0x63], songs: [25] },
      { bytes: [0x03, 0x21, 0x0c, 0x06, 0xe8, 0xe1, 0x32, 0x25], songs: [8] },
      { bytes: [0x01, 0x02, 0xcf, 0x04, 0xc3, 0x86, 0x11, 0x12], songs: [13] },
      { bytes: [0x21, 0x26, 0x14, 0x02, 0x42, 0x88, 0x30, 0x14], songs: [12] },
      { bytes: [0x01, 0x06, 0x04, 0x14, 0x86, 0xa3, 0x42, 0x34], songs: [20] },
      { bytes: [0xb9, 0x01, 0x20, 0x17, 0xa8, 0xa5, 0x51, 0x02], songs: [16] },
      { bytes: [0x11, 0x51, 0x0a, 0x0d, 0xd8, 0xf4, 0x23, 0x46], songs: [4] },
      { bytes: [0xa5, 0x42, 0x07, 0x08, 0x54, 0xe9, 0x31, 0x02], songs: [10] },
      { bytes: [0x21, 0x61, 0x1a, 0x07, 0x74, 0xa3, 0x42, 0x17], songs: [1] },
      { bytes: [0x21, 0x21, 0x15, 0x04, 0x12, 0x31, 0x52, 0x23], songs: [6] },
      { bytes: [0x63, 0x21, 0x18, 0x27, 0x34, 0x52, 0x32, 0x23], songs: [26] },
      { bytes: [0x01, 0x06, 0x04, 0x14, 0x86, 0xa3, 0x23, 0x32], songs: [20] },
      { bytes: [0x32, 0x61, 0x1a, 0x06, 0x91, 0x66, 0x01, 0x26], songs: [4] },
      { bytes: [0x23, 0x28, 0x16, 0x03, 0x92, 0x84, 0x50, 0x36], songs: [14] },
      { bytes: [0x21, 0x23, 0x0e, 0x03, 0x93, 0x79, 0x66, 0x07], songs: [14] },
      { bytes: [0x0b, 0x01, 0x0e, 0x05, 0xc6, 0xa3, 0x32, 0x14], songs: [6] },
      { bytes: [0x01, 0x06, 0x14, 0x04, 0x92, 0x94, 0x43, 0x34], songs: [4] },
      { bytes: [0x21, 0x67, 0x0a, 0x02, 0x93, 0x90, 0x74, 0x45], songs: [0] },
      { bytes: [0x61, 0xa3, 0x08, 0x22, 0x82, 0x42, 0x43, 0x04], songs: [4] },
      { bytes: [0x61, 0xa2, 0x10, 0x04, 0x76, 0x62, 0x12, 0x25], songs: [14] },
      { bytes: [0x1a, 0x81, 0x4b, 0x05, 0xc6, 0xa4, 0x23, 0x23], songs: [23] },
      { bytes: [0x61, 0xa1, 0x0a, 0x21, 0x76, 0x51, 0x12, 0x33], songs: [0] },
      { bytes: [0x0d, 0x81, 0x4e, 0x07, 0xc6, 0xa4, 0x23, 0x23], songs: [23] },
      { bytes: [0x03, 0x21, 0x0c, 0x04, 0x86, 0x93, 0x33, 0x15], songs: [24] },
      { bytes: [0x21, 0x04, 0x0c, 0x00, 0x73, 0x74, 0x0f, 0x0f], songs: [19] },
      { bytes: [0xb9, 0x01, 0x15, 0x17, 0xa8, 0xa5, 0x0f, 0x0f], songs: [23] },
      { bytes: [0x03, 0x21, 0x0a, 0x07, 0xe7, 0x84, 0x0f, 0x0f], songs: [20] },
      { bytes: [0x03, 0x61, 0x0b, 0x07, 0xe8, 0x81, 0x42, 0x47], songs: [29] },
      { bytes: [0x21, 0x21, 0x15, 0x04, 0x12, 0x31, 0x0f, 0x0f], songs: [6] }
    ] }
  ];
  V.presetListOf = function (presetByTone) {
    const nums = [...new Set(Object.keys(presetByTone).map(k => presetByTone[k]))].sort((a, b) => a - b);
    return nums.map(n => `@${n} ${V.PRESET_NAMES[n] || ''}`.trim()).join('/');
  };

  // 8バイトダンプ → 比較用フィールド(src/emulator/expansion/vrc7.js dump2patch と同じ切り出し)。
  // キャリアTLは音量(v)側で表現するので音色比較には含めない。
  function fieldsOf(d) {
    return {
      mAM: (d[0] >> 7) & 1, mPM: (d[0] >> 6) & 1, mEG: (d[0] >> 5) & 1, mKR: (d[0] >> 4) & 1, mML: d[0] & 15,
      cAM: (d[1] >> 7) & 1, cPM: (d[1] >> 6) & 1, cEG: (d[1] >> 5) & 1, cKR: (d[1] >> 4) & 1, cML: d[1] & 15,
      mKL: (d[2] >> 6) & 3, mTL: d[2] & 63,
      cKL: (d[3] >> 6) & 3, mWF: (d[3] >> 3) & 1, cWF: (d[3] >> 4) & 1, FB: d[3] & 7,
      mAR: (d[4] >> 4) & 15, mDR: d[4] & 15,
      cAR: (d[5] >> 4) & 15, cDR: d[5] & 15,
      mSL: (d[6] >> 4) & 15, mRR: d[6] & 15,
      cSL: (d[7] >> 4) & 15, cRR: d[7] & 15
    };
  }

  // 重み。単位が揃っていないので「1段ずれたときの気になり方」で付けた経験値。
  //   ML …… 倍音比そのもの。ここがずれると別の楽器になるので最重量
  //   mTL … 変調の深さ(0.75dB/段)。63段フルスケールなので1段あたりは軽め
  //   EG … 持続音/減衰音の別。1bitで音の性格が変わるので重い
  //   WF … 半波整流波形の有無。同上
  //   AR/DR/SL/RR … エンベロープ。キャリア側を1.5倍重く見る
  const W = {
    mML: 3.0, cML: 4.0, mTL: 0.5, FB: 2.0,
    mEG: 5.0, cEG: 6.0, mWF: 3.0, cWF: 4.0,
    mAM: 2.0, cAM: 2.0, mPM: 2.0, cPM: 2.0, mKR: 0.8, cKR: 0.8, mKL: 0.8, cKL: 0.8,
    mAR: 1.0, mDR: 1.0, mSL: 0.7, mRR: 0.7,
    cAR: 1.5, cDR: 1.5, cSL: 1.0, cRR: 1.0
  };

  /** 8バイト同士の音色距離(小さいほど似ている) */
  V.distance = function (a, b) {
    const fa = fieldsOf(a), fb = fieldsOf(b);
    let d = 0;
    for (const k in W) d += W[k] * Math.abs(fa[k] - fb[k]);
    return d;
  };

  /** 8バイトの自作音色 → いちばん近い内蔵プリセット番号(1-15) */
  V.nearestPreset = function (bytes) {
    if (!bytes || bytes.length < 8) return 1;
    let best = 1, bestD = Infinity;
    for (let i = 1; i <= 15; i++) {
      const d = V.distance(bytes, PRESETS[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  // チャンネルの「自作音色で鳴っている区間」を [{s, e, tone}] で取り出す。
  // ★OP<n>を出さずに@0で鳴る音符は、そのチャンネルが最後にロードした音色で鳴る
  //   (compiler.jsの同時使用チェックの toneAt() と同じ解釈)。ここでも直前の音色を
  //   引き継がせないと、その区間だけ「誰も使っていない」ことになって取りこぼす。
  function customIntervals(ch) {
    const out = [];
    let last = null;
    for (const ev of ch.events || []) {
      if (ev.vrc7Tone !== undefined) last = ev.vrc7Tone;
      if (ev.note === null || last === null) continue;
      if ((ev.instrument || 0) !== 0) continue; // @0以外はプリセット指定なので無関係
      if (ev.end > ev.start) out.push({ s: ev.start, e: ev.end, tone: last });
    }
    return out;
  }

  /**
   * 自作音色(@0)の同時使用が1系統に収まるようチャンネル単位で割当を解く。
   *
   * @param {Array} channels VRC7へ載せる全チャンネル(events を破壊的に書き換える)。
   *   ch.vrc7ToneFixed が真のチャンネル(元がYM2413で、$00-$07を全ch共有する実機と同じ
   *   条件で抽出できているもの)を先に確定させ、変換で作った音色の側から譲らせる。
   *   ★ただし「絶対に落とさない」ではない: 実測では元がOPLLの曲でもchごとに違う音色が
   *   出ることがある(ドライバが音符ごとに$00-$07を書き直していて、フレーム単位の
   *   スナップショットではchごとに別の瞬間の値を拾うため)。落とさないと結局
   *   コンパイルできず全パート無音になるので、収まらなければネイティブ側も譲る。
   * @param {object} toneReg 登録済み8バイトを引くための WaveRegistry(@OP)
   * @param {object} [opt] { onDemote(ch, presetByTone) } 落としたチャンネルの通知
   * @returns {{kept: Array, demoted: Array}} チャンネル配列(呼び出し元のヘッダコメント用)
   */
  V.resolveConflicts = function (channels, toneReg, opt) {
    opt = opt || {};
    const list = (channels || []).filter(ch => ch && ch.events && customIntervals(ch).length);
    if (list.length < 2) return { kept: list.slice(), demoted: [] };

    // ★時間軸のズレに対する余裕(PAD)と「音色が変わるチャンネルは独占」の2点が要る。
    //   ここで見ているのは抽出時点(1フレーム=1/60秒)の発音区間だが、実際にコンパイラが
    //   突き合わせるのは**音長へ量子化したあとの**区間で、OP<n>を出す位置も数フレームずれる。
    //   そのため「抽出時点では同じ瞬間に切り替えている2ch」でも、量子化後は片方だけ先に
    //   切り替わって食い違いうる(実測: Double Dragon(Neo Geo)でH/Jが同じOP0→OP1→OP0の
    //   並びなのに2.3秒でずれた)。曲中で音色が変わらないチャンネル同士が同じ番号を使う
    //   場合だけは、切り替えの瞬間が無いのでどうずれても安全に共存できる。
    const PAD = 8; // 量子化ズレの見込み(フレーム)
    let totalFrames = 0;
    for (const ch of list) for (const iv of customIntervals(ch)) totalFrames = Math.max(totalFrames, iv.e);
    totalFrames += PAD;
    const committed = new Int32Array(totalFrames).fill(-1); // フレーム→確定した音色番号(-1=空き)
    const exclusive = new Uint8Array(totalFrames);          // 曲中で音色が変わるchが押さえた区間

    const padS = (iv) => Math.max(0, iv.s - PAD);
    const padE = (iv) => Math.min(totalFrames, iv.e + PAD);
    const isMultiTone = (ivs) => new Set(ivs.map(iv => iv.tone)).size > 1;

    const fits = (ivs) => {
      const multi = isMultiTone(ivs);
      for (const iv of ivs) for (let f = padS(iv); f < padE(iv); f++) {
        if (committed[f] === -1) continue;
        if (multi) return false;                      // 切り替えのあるchは重なりを一切許さない
        if (exclusive[f] || committed[f] !== iv.tone) return false;
      }
      return true;
    };
    const commit = (ivs) => {
      const multi = isMultiTone(ivs);
      for (const iv of ivs) for (let f = padS(iv); f < padE(iv); f++) {
        committed[f] = iv.tone;
        if (multi) exclusive[f] = 1;
      }
    };

    // 優先順位は「プリセットへ落としたときに失われる量」= 発音フレーム数 × プリセットとの距離。
    // 単純な発音時間順だと、たまたま内蔵音色にそっくりな音色のチャンネルが枠を取ってしまい、
    // 代わりのきかない音色の方が落ちる。損失の大きい順に残す方が結果が目立たない。
    const lossCache = new Map(); // 音色番号 → いちばん近いプリセットとの距離
    const lossOf = (tone) => {
      if (!lossCache.has(tone)) {
        const bytes = toneReg.waves[tone];
        lossCache.set(tone, bytes ? V.distance(bytes, PRESETS[V.nearestPreset(bytes)]) : 0);
      }
      return lossCache.get(tone);
    };
    const scoreOf = (ch) => customIntervals(ch).reduce((t, iv) => t + (iv.e - iv.s) * lossOf(iv.tone), 0);
    const scores = new Map(list.map(ch => [ch, scoreOf(ch)]));

    // ★順番は「チャンネル単体」ではなく「同じ音色を使うチャンネルの組」で決める。
    //   同じ音色番号どうしは同時に鳴っても衝突しないので、枠は実質その組が取り合う。
    //   単体順にすると、同じ音色を分け合う主役2本(合計は大きい)より、単体で少し上回る
    //   脇役1本が先に枠を取ってしまう(実測: Virtua Racing Deluxe「Replay」で、
    //   OP0を使う主役のG+K=書込み1134/1116回を差し置いて、OP1のH=156回が枠を取り、
    //   いちばん鳴っているパートがプリセットへ落ちていた)。
    //   曲中で音色が変わるチャンネルは他と共存できないので、それ自身が1つの組になる。
    const groupKey = (ch) => {
      const tones = new Set(customIntervals(ch).map(iv => iv.tone));
      return tones.size === 1 ? 'tone:' + [...tones][0] : 'ch:' + list.indexOf(ch);
    };
    const groupScore = new Map();
    for (const ch of list) {
      const k = groupKey(ch);
      groupScore.set(k, (groupScore.get(k) || 0) + scores.get(ch));
    }
    // ネイティブ(動かせない)→ 組の損失が大きい順 → 組の中では単体の損失が大きい順
    const order = list.slice().sort((a, b) => {
      const na = a.vrc7ToneFixed ? 1 : 0, nb = b.vrc7ToneFixed ? 1 : 0;
      if (na !== nb) return nb - na;
      const ga = groupScore.get(groupKey(a)), gb = groupScore.get(groupKey(b));
      if (ga !== gb) return gb - ga;
      if (scores.get(a) !== scores.get(b)) return scores.get(b) - scores.get(a);
      return list.indexOf(a) - list.indexOf(b);
    });

    const kept = [], demoted = [];
    for (const ch of order) {
      const ivs = customIntervals(ch);
      if (fits(ivs)) { commit(ivs); kept.push(ch); continue; }
      // 落選: このチャンネルの自作音色を全部「いちばん近い内蔵プリセット」へ置き換える
      // (OP<n>を持たない@0の音符も、直前にロードしていた音色の代替へ揃える)
      const presetByTone = {};
      let last = null;
      for (const ev of ch.events) {
        if (ev.vrc7Tone !== undefined) {
          last = ev.vrc7Tone;
          if (presetByTone[last] === undefined) presetByTone[last] = V.nearestPreset(toneReg.waves[last]);
          delete ev.vrc7Tone;
        }
        if (ev.note !== null && (ev.instrument || 0) === 0 && last !== null) ev.instrument = presetByTone[last];
      }
      ch.hasVrc7Tone = false;
      ch.hasInstrument = true;
      demoted.push(ch);
      if (opt.onDemote) opt.onDemote(ch, presetByTone);
    }
    return { kept, demoted };
  };

  /**
   * 出力直前のスコアに対して resolveConflicts + compactRegistry をまとめて掛ける。
   * (借用層を通らないネイティブ変換 —— kss2mml/nsf2mml/spc2mml の既定経路 —— 用の入口。
   *  衝突が無ければ何もしないので、既に借用層で解決済みの経路から呼んでも安全)
   * @returns {Array<string>} ヘッダコメントに足す説明(0件なら衝突無し)
   */
  V.resolveForScore = function (scoreChannels, toneReg) {
    const notes = [];
    V.resolveConflicts(scoreChannels, toneReg, {
      onDemote: (ch, presetByTone) => {
        notes.push(`${ch.letter ? ch.letter + ': ' : ''}VRC7の自作音色(@0)は実機の制約でチップ全体に` +
          `1音色しか持てないため、同時に鳴るぶんに収まらないこのチャンネルは` +
          `いちばん近い内蔵音色(${V.presetListOf(presetByTone)})へ置き換えました。`);
      }
    });
    V.compactRegistry(toneReg, scoreChannels);
    return notes;
  };

  /**
   * 誰にも使われなくなった @OP<n> 定義を捨てて番号を詰め直す。
   * (定義はNSF書き出し時に音色テーブル8バイト+分岐コードとしてROMを食うため、
   *  resolveConflicts で大量に不要化したぶんをそのまま残さない)
   * @param {object} toneReg WaveRegistry(@OP) —— waves を差し替える
   * @param {Array} channels vrc7Tone を持ちうる全チャンネル(番号を振り直す)
   */
  V.compactRegistry = function (toneReg, channels) {
    if (!toneReg || !toneReg.waves || !toneReg.waves.length) return;
    const used = new Set();
    for (const ch of channels || []) for (const ev of (ch && ch.events) || []) {
      if (ev.vrc7Tone !== undefined) used.add(ev.vrc7Tone);
    }
    if (used.size === toneReg.waves.length) return;
    const remap = new Map();
    const waves = [];
    for (let i = 0; i < toneReg.waves.length; i++) {
      if (!used.has(i)) continue;
      remap.set(i, waves.length);
      waves.push(toneReg.waves[i]);
    }
    for (const ch of channels || []) for (const ev of (ch && ch.events) || []) {
      if (ev.vrc7Tone !== undefined) ev.vrc7Tone = remap.get(ev.vrc7Tone);
    }
    toneReg.waves = waves;
    toneReg.keyToIndex = new Map(waves.map((w, i) => [w.join(','), i]));
  };

})(window);
