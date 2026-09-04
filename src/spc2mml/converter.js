/*
 * SPC → MML コンバータ
 * MML.SPC2MML.fromSpc(spcBytes, durationSec, options) → { mml, dmcFiles, bpm, expansion }
 *
 * options.channelMap  : 長さ8の配列。各要素は { type: string } または null(スキップ)
 *   type の値:
 *     'skip'
 *     'pulse1'|'pulse2'|'triangle'|'noise'   … 2A03
 *     'dpcm'                                  … 2A03 DMC (BRR→DPCM変換)
 *     'fds'                                   … FDS 波形
 *     'vrc6pulse1'|'vrc6pulse2'|'vrc6saw'     … VRC6
 *     'mmc5pulse1'|'mmc5pulse2'               … MMC5
 *     'fme7a'|'fme7b'|'fme7c'                 … FME7
 *     'n163_0'|'n163_1'|'n163_2'|'n163_3'    … N163
 * options.bpm         : BPM (省略時はマッピング済みチャンネルの音長から自動検出)
 */
(function (global) {
  'use strict';
  const MML    = global.MML    = global.MML    || {};
  MML.SPC2MML  = MML.SPC2MML  || {};

  const DSP_RATE        = 32000;
  const SAMPLES_PER_FRAME = Math.round(DSP_RATE / 60);
  const FPS_SPC          = DSP_RATE / SAMPLES_PER_FRAME; // 実効フレームレート
  MML.SPC2MML.FRAME_RATE = FPS_SPC; // capture()完了を待たずにフレームレートだけ知りたい呼び出し元向け

  // ── type → 2A03固定チャンネル文字(拡張音源分はassignExpansionLettersで決定) ──
  const TYPE_TO_LETTER = {
    pulse1: 'A', pulse2: 'B', triangle: 'C', noise: 'D',
  };

  // type → 拡張音源名
  const TYPE_TO_EXPANSION = {
    fds:       'fds',
    vrc6pulse1:'vrc6', vrc6pulse2:'vrc6', vrc6saw:'vrc6',
    mmc5pulse1:'mmc5', mmc5pulse2:'mmc5',
    fme7a:     'fme7', fme7b:'fme7', fme7c:'fme7',
    n163_0:    'n163', n163_1:'n163', n163_2:'n163', n163_3:'n163',
    n163_4:    'n163', n163_5:'n163', n163_6:'n163', n163_7:'n163',
    vrc7_0:    'vrc7', vrc7_1:'vrc7', vrc7_2:'vrc7',
    vrc7_3:    'vrc7', vrc7_4:'vrc7', vrc7_5:'vrc7',
  };

  // type → そのチップ内でのチャンネル通し番号(0始まり)。
  // src/mml/compiler.jsのassignExpansionLettersが返す配列のインデックスに対応する。
  const TYPE_TO_CHIP_INDEX = {
    fds: 0,
    vrc6pulse1: 0, vrc6pulse2: 1, vrc6saw: 2,
    mmc5pulse1: 0, mmc5pulse2: 1,
    fme7a: 0, fme7b: 1, fme7c: 2,
    n163_0: 0, n163_1: 1, n163_2: 2, n163_3: 3,
    n163_4: 4, n163_5: 5, n163_6: 6, n163_7: 7,
    vrc7_0: 0, vrc7_1: 1, vrc7_2: 2, vrc7_3: 3, vrc7_4: 4, vrc7_5: 5,
  };

  // VRC7のfnum換算(kss2mml/converter.js vrc7FnumRawと同じ式)。fnum/blockの対数表現のため
  // EP/MP/PT(生レジスタ加算のピッチ変調)は使えないが、D<n>はfnumが同一block内で周波数に
  // 比例するため使える(compiler.js segmentsToWriteLogVrc7参照)。detectChorusDetune専用。
  function vrc7FnumRawSpc(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }

  // ── SPCノイズ→2A03ノイズ周期idx変換 ─────────────────────────────────
  // SPCのノイズはFLG($6C)下位5bitのレートでLFSRを進める(spcDsp.js _updateNoise、
  // 更新周波数=32000/RATE_TABLE[rate])。2A03ノイズの16通りの周期(NTSC)のうち聴感上
  // 最も近いものへ対数距離で丸め、nsf2mml converter.jsのnoisePeriodToNoteNumと同じ
  // 規則(noteNumber = 31 - periodIdx)でノート番号にする。
  const SPC_RATE_TABLE = [
    0,2048,1536,1280,1024,768,640,512,384,320,256,192,160,128,96,80,
    64,48,40,32,24,20,16,12,10,8,6,5,4,3,2,1,
  ];
  const NES_NOISE_PERIODS = [4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068];
  function spcNoiseNoteNum(rate) {
    const div = SPC_RATE_TABLE[rate & 0x1F];
    if (!div) return null; // rate=0はLFSR停止(無音扱い)
    const freq = DSP_RATE / div;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < NES_NOISE_PERIODS.length; i++) {
      const d = Math.abs(Math.log((1789773 / NES_NOISE_PERIODS[i]) / freq));
      if (d < bestD) { bestD = d; best = i; }
    }
    return 31 - best;
  }

  // ── ピッチ変換 ───────────────────────────────────────────────────────
  // pitch: DSP 14bit ピッチ値。tune: そのボイスが使うBRRサンプルの原音チューニング
  // 補正(半音, 実数)。tune=0 は「原音=C5(約523Hz)で pitch=0x1000 のとき note 60」
  // という従来の固定仮定に一致する(後方互換)。
  //
  // SNESの各楽器サンプルは固有のチューニングを持ち、ピッチレジスタだけでは絶対音程が
  // 決まらない(pitch=0x1000 は「サンプルを原音のまま32kHzで鳴らす」という意味でしか
  // なく、その原音が何Hzかはサンプル次第)。原音がC5からずれるサンプルでは、この固定
  // 仮定のままだと実機と数半音ズレる(例: HyperZone「Old Capital」の主旋律サンプルは
  // 原音≈333Hz=E4付近で、C5仮定だと約8半音高く出てしまっていた)。computeSrcnFineTune
  // が実測した基本周波数から算出した tune を渡すことで実機の発音音程に一致させる。
  function pitchToSemitone(pitch, tune = 0) {
    if (pitch <= 0) return null;
    const semi = Math.round(12 * Math.log2(pitch / 0x1000) + tune) + 60;
    return (semi >= 0 && semi <= 119) ? semi : null;
  }

  // pitchToSemitoneの丸めない連続版をHzへ変換する(DESIGN-PITCH.md Phase 1、
  // ev.pitchSeqを借用先チップの生レジスタ空間へ変換する前段としてHzを経由する)。
  // continuousSemi(57基準)=12*log2(pitch/0x1000)+tune+60 → freq=440*2^((continuousSemi-57)/12)
  // = 440*(pitch/4096)*2^((tune+3)/12)
  function pitchRegToFreqHz(pitch, tune) {
    return pitch > 0 ? 440 * (pitch / 4096) * Math.pow(2, ((tune || 0) + 3) / 12) : 0;
  }

  // ── 借用先チップの生レジスタ空間への変換式(compiler.js/nsf2mml/converter.jsの
  // 各periodFnと同じ、丸めない連続値。DESIGN-PITCH.md Phase 1、EP<n>用) ──────
  const CPU_CLOCK_NTSC = 1789773; // 借用先(2A03/VRC6/MMC5/FME7/FDS/N163)のクロック
  function pulsePeriodRaw(freq)   { return CPU_CLOCK_NTSC / (16 * freq) - 1; }   // 2A03/MMC5パルス
  function triPeriodRaw(freq)     { return CPU_CLOCK_NTSC / (32 * freq) - 1; }   // 2A03三角波
  function vrc6PulsePeriodRaw(freq) { return CPU_CLOCK_NTSC / (16 * freq) - 1; } // VRC6パルス
  function vrc6SawPeriodRaw(freq) { return CPU_CLOCK_NTSC / (14 * freq) - 1; }   // VRC6サウ
  function fme7ToneRaw(freq)      { return CPU_CLOCK_NTSC / (32 * freq); }       // FME7
  function fdsPeriodRawSpc(freq)  { return freq * 65536 * 64 / CPU_CLOCK_NTSC; } // FDS
  // N163: pcmToN163Wave()が常に16サンプルへリサンプリングするためwaveLen固定16。
  // numChはSPC変換で実際に確保されるN163ch数(expansionLetters.length)を呼び出し側から渡す。
  function n163FreqRegRawSpc(freq, numCh) { return freq * 15 * 65536 * 16 * numCh / CPU_CLOCK_NTSC; }

  // type文字列(options.channelMap[ch].type)→借用先の生周期変換関数。ノイズ/DPCM/skipは
  // 対象外(null)。VRC7/OPLLはこのアプリのSPC変換先候補に無いため定義不要。
  function periodFnForType(type, n163NumCh) {
    switch (type) {
      case 'pulse1': case 'pulse2': case 'mmc5pulse1': case 'mmc5pulse2': return pulsePeriodRaw;
      case 'triangle': return triPeriodRaw;
      case 'vrc6pulse1': case 'vrc6pulse2': return vrc6PulsePeriodRaw;
      case 'vrc6saw': return vrc6SawPeriodRaw;
      case 'fme7a': case 'fme7b': case 'fme7c': return fme7ToneRaw;
      case 'fds': return fdsPeriodRawSpc;
      case 'n163_0': case 'n163_1': case 'n163_2': case 'n163_3':
      case 'n163_4': case 'n163_5': case 'n163_6': case 'n163_7':
        return (freq) => n163FreqRegRawSpc(freq, n163NumCh);
      default: return null;
    }
  }

  // ── BRR サンプルの原音(基本周波数)検出 ───────────────────────────
  // pitch=0x1000(原音・32kHz再生)で鳴らした時の基本周波数[Hz]を自己相関で推定する。
  // 旋律楽器のように明確な周期を持つ波形では高い信頼度で検出できる。打楽器/ノイズは
  // 周期が不明瞭で信頼度が低くなるため、呼び出し側(computeSrcnFineTune)で閾値により
  // フォールバックする。倍音/低調波の取り違えを避けるため、自己相関のピーク(全体最大の
  // 90%超)のうち最短ラグ=基本波を採用する。
  // brrBytes: BRRサンプル全体。loopByteOffset(省略可): DIRのループ開始アドレスの
  // サンプル先頭からのバイトオフセット(_collectBrrSamplesが採取)。あればループ以降=
  // 完全な定常部を解析窓にする(アタック過渡による誤検出を避ける)。
  //
  // ★2026-08-25 自己相関の「最初の0.9maxピーク」方式からYIN(CMNDF)方式へ全面差し替え。
  // 旧方式は倍音の強いサンプル(FF4のブラス系srcn65等)で第2〜4倍音のラグを掴み、原音推定が
  // 丸ごと1〜2オクターブずれて全ノートのオクターブが崩壊していた(実測: V2の実出力280Hzに
  // 対し変換はo6=1109Hz)。YINは累積平均正規化差分d'(τ)が「最初に閾値を下回る谷」を採る
  // 標準的なオクターブ頑健化で、倍音ラグでは谷が浅くならないため誤爆しない。
  // 谷は放物線補間でサブサンプル化(整数ラグだと高音サンプルほど±数十セント粗くなるため)。
  function detectBrrFundamental(brrBytes, loopByteOffset) {
    const pcm = decodeBrrBytes(brrBytes);
    const L0 = pcm.length;
    if (L0 < 256) return null;
    const W = 1024;                       // 差分積分の窓幅
    const maxTau = Math.min(1200, L0 >> 1); // 最低約27Hzまで
    // 解析開始点: ループ開始(=定常部)が分かればそこ、無ければ従来の「少し後ろ」。
    // 窓+最大ラグが収まらない場合は後ろから詰める
    let start = loopByteOffset != null && loopByteOffset >= 0
      ? Math.floor(loopByteOffset / 9) * 16
      : Math.min(L0 >> 2, 512);
    if (start + W + maxTau > L0) start = Math.max(0, L0 - W - maxTau);
    if (maxTau < 32) return null;
    const x = pcm;
    // d(τ) = Σ_{i<W} (x[i]-x[i+τ])^2 → d'(τ) = d(τ)·τ / Σ_{u≤τ} d(u)
    const d = new Float64Array(maxTau);
    for (let tau = 1; tau < maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) { const diff = x[start + i] - x[start + i + tau]; sum += diff * diff; }
      d[tau] = sum;
    }
    const dn = new Float64Array(maxTau);
    dn[0] = 1;
    let cum = 0;
    for (let tau = 1; tau < maxTau; tau++) { cum += d[tau]; dn[tau] = cum > 0 ? d[tau] * tau / cum : 1; }
    // 最初に閾値を下回る局所最小を採る(YIN本来の手順)。見つからなければ全体最小
    const THRESHOLD = 0.15;
    let period = -1;
    for (let tau = 2; tau < maxTau - 1; tau++) {
      if (dn[tau] < THRESHOLD && dn[tau] <= dn[tau + 1]) { period = tau; break; }
    }
    if (period < 0) {
      let mn = Infinity;
      for (let tau = 2; tau < maxTau - 1; tau++) if (dn[tau] < mn) { mn = dn[tau]; period = tau; }
      if (period < 0) return null;
    }
    // 谷の放物線補間(サブサンプル精度)
    let refined = period;
    const y0 = dn[period - 1], y1 = dn[period], y2 = dn[period + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom > 0) {
      const delta = 0.5 * (y0 - y2) / denom;
      if (delta > -1 && delta < 1) refined = period + delta;
    }
    // 信頼度: 1 - d'(谷)。周期が明瞭なほど1に近づく(打楽器/ノイズは低くなり補正対象外へ)
    return { freq: DSP_RATE / refined, conf: 1 - Math.min(1, y1) };
  }

  // ── srcn ごとの原音チューニング補正(半音)を算出 ─────────────────
  // 各BRRサンプルの実測基本周波数を、pitchToSemitoneの+60が暗黙に仮定する原音 C5
  // (REFERENCE_HZ)と比較した半音差として返す。旋律的で信頼度の高いサンプルのみ補正し、
  // 打楽器/ノイズなど周期が不明瞭なもの(信頼度が閾値未満)は補正せず(=従来動作)に
  // フォールバックする。これによりドラム等の退行を避けつつ、音階の合っていた曲
  // (原音がC5付近のサンプル→補正≈0)も従来どおりの結果を保つ。
  const REFERENCE_HZ = 440 * Math.pow(2, 3 / 12); // ≈523.25Hz(C5)
  const FUNDAMENTAL_CONF_MIN = 0.8;
  function computeSrcnFineTune(brrSamples) {
    const tune = {};
    if (!brrSamples) return tune;
    for (const srcn in brrSamples) {
      const brr = brrSamples[srcn];
      if (!brr || !brr.bytes || brr.bytes.length === 0) continue;
      const f = detectBrrFundamental(brr.bytes, brr.loopByteOffset);
      if (f && f.conf >= FUNDAMENTAL_CONF_MIN && f.freq > 0) {
        tune[srcn] = 12 * Math.log2(f.freq / REFERENCE_HZ);
      }
    }
    return tune;
  }
  MML.SPC2MML.computeSrcnFineTune = computeSrcnFineTune;
  MML.SPC2MML.decodeBrrBytes = (bytes) => decodeBrrBytes(bytes);
  MML.SPC2MML.DSP_RATE = DSP_RATE;

  // ── 打楽器サンプルの判定と打点リスト(2026-09-03、ドラムパッド全形式展開) ──────────
  // 「どのsrcnが打楽器か」を決める。優先順:
  //   1. 手動上書き drumKinds[srcn] ('drum' | 'pitch')。鍵盤/パッドからの指定
  //      (Emu.SamplePitchUtil のkind上書きをBRR内容ハッシュで引いたもの。main.js参照)
  //   2. 自動: 原音周期が検出できず(computeSrcnFineTuneの補正が無い=conf<0.8)、かつ
  //      曲中で使われたピッチが DRUM_MAX_PITCHES 種以下(タムの高低程度まで。旋律楽器は
  //      周期が取れなくても多数のピッチで弾かれるので除外される)
  // ノイズ(NON)で鳴っているイベントはサンプルではないので対象外(ノイズ借用先へ行く)。
  const DRUM_MAX_PITCHES = 3;
  MML.SPC2MML.brrHash = function (brr) {
    const U = (global.Emu && global.Emu.SamplePitchUtil) || (MML.Emu && MML.Emu.SamplePitchUtil) || null;
    if (!brr || !brr.bytes || !brr.bytes.length || !U || !U.sampleHash) return null;
    return 'brr-' + U.sampleHash(brr.bytes, 0, brr.bytes.length);
  };
  MML.SPC2MML.drumSrcns = function (voiceEvents, srcnFineTune, drumKinds) {
    const stat = new Map(); // srcn → Set(pitch)
    for (const evs of voiceEvents || []) {
      for (const ev of evs) {
        if (ev.pitchSemi === null || ev.non) continue;
        let s = stat.get(ev.srcn);
        if (!s) { s = new Set(); stat.set(ev.srcn, s); }
        s.add(ev.pitch);
      }
    }
    const out = new Set();
    for (const [srcn, pitches] of stat) {
      const k = drumKinds && drumKinds[srcn];
      if (k === 'drum') { out.add(srcn); continue; }
      if (k === 'pitch') continue;
      const untuned = !srcnFineTune || srcnFineTune[srcn] === undefined;
      if (untuned && pitches.size <= DRUM_MAX_PITCHES) out.add(srcn);
    }
    return out;
  };
  /**
   * 打楽器srcnの発音 → 打点リスト(src/convert/drumHits.js の hit 形)+パッド台帳用サンプル表。
   * chans: 自動判定(drumSrcns)を適用する対象ボイス番号の配列(省略時は全8ボイス)。
   * opt.dpcmChans: 借用先にE(DPCM)を選んだボイス。そのボイスの発音は drumSrcns の判定に
   *   関わらず全部が打点(パッド)になる。opt.pitchSrcns にあるsrcnだけは除外して
   *   音程付きDPCM経路へ残す(2026-09-04、複数chをDPCM1本へまとめる使い方への対応)。
   *   hits:    [{ key:'brr:<srcn>', hash, pcm, rate(実際に鳴った速さ), vol(0..1), startFrame, endFrame, ch }]
   *   samples: { key → { key, pcm, rate(初出の打点の速さ), hash, label } }
   */
  MML.SPC2MML.drumHits = function (voiceEvents, brrSamples, drumSrcns, chans, opt) {
    const hits = [], samples = {};
    const dpcmChans = (opt && opt.dpcmChans) || [];
    const pitchSrcns = (opt && opt.pitchSrcns) || null;
    const list = Array.from(new Set((chans || (dpcmChans.length ? [] : [0, 1, 2, 3, 4, 5, 6, 7])).concat(dpcmChans)));
    const isDrumEvent = (ch, ev) => (dpcmChans.indexOf(ch) >= 0)
      ? !(pitchSrcns && pitchSrcns.has(ev.srcn))   // Eボイス: 音階指定以外は全部パッド
      : drumSrcns.has(ev.srcn);                    // それ以外: 自動判定に当たったsrcnだけ
    for (const ch of list) {
      for (const ev of (voiceEvents[ch] || [])) {
        if (ev.pitchSemi === null || ev.non || !isDrumEvent(ch, ev)) continue;
        const brr = brrSamples && brrSamples[ev.srcn];
        if (!brr || !brr.bytes || !brr.bytes.length) continue;
        const key = 'brr:' + ev.srcn;
        const rate = DSP_RATE * (ev.pitch || 0x1000) / 0x1000; // pitch=0x1000 で原音32kHz
        let s = samples[key];
        if (!s) {
          s = { key, pcm: decodeBrrBytes(brr.bytes), rate, hash: MML.SPC2MML.brrHash(brr), label: 'srcn' + ev.srcn };
          samples[key] = s;
        }
        hits.push({ key, sampleKey: key, hash: s.hash, pcm: s.pcm, rate, label: s.label,
                    vol: Math.max(0, Math.min(1, (ev.vol || 0) / 127)),
                    startFrame: ev.frame, endFrame: ev.frame + ev.len, ch });
      }
    }
    hits.sort((a, b) => a.startFrame - b.startFrame);
    return { hits, samples };
  };
  // BPM検出・音長量子化・チャンネルMML生成は共通モジュール
  // (src/convert/bpm.js, duration.js, mmlEmit.js) に切り出し済み。

  // ── ADSR/GAINエンベロープ → ppmck @v/@vr テーブル抽出 ───────────────
  // src/emulator/spcDsp.js の _updateEnvelope と同じレート表・計算式を
  // 1DSPサンプル(32kHz)刻みで再現し、1フレーム(約533サンプル)ごとに
  // サンプリングして 0-15 に量子化する。実際にDSPを鳴らすのではなく、
  // 与えられたADSR1/ADSR2/GAINからカーブを机上シミュレートするだけ。
  const ENV_RATE_TABLE = [
    0,2048,1536,1280,1024,768,640,512,
    384,320,256,192,160,128,96,80,
    64,48,40,32,24,20,16,12,
    10,8,6,5,4,3,2,1,
  ];

  // 末尾が一定値に収束していたら切り詰める(ppmckの「|省略時は末尾値を保持」仕様に委ねる)
  function trimConstantTail(values) {
    while (values.length > 1 && values[values.length - 1] === values[values.length - 2]) values.pop();
    if (values.length === 0) values.push(0);
    return values;
  }

  // KON時点のADSR1/ADSR2/GAINから、アタック〜サステインのエンベロープを
  // maxFrames分シミュレートし、1フレーム1値(0-15)の配列にする。
  // ★2026-08-25 実測エンベロープ方式(capture envLog)への移行で本体からは未使用になった。
  // Workerバンドル互換とデバッグ用に残置(削除する場合はspc-capture-worker再生成も忘れずに)。
  // eslint-disable-next-line no-unused-vars
  function simulateSpcEnvelope(adsr1, adsr2, gain, maxFrames) {
    const adsrEn = adsr1 & 0x80;
    let env = 0, envMode = 'attack', envRate = 0;
    const perFrame = [];
    const totalTicks = maxFrames * SAMPLES_PER_FRAME;

    for (let tick = 0; tick < totalTicks; tick++) {
      if (envMode !== 'off') {
        if (!adsrEn) {
          const mode = (gain >> 5) & 3;
          const rate = gain & 0x1F;
          if (gain & 0x80) {
            // rate=0は周期無限=エンベロープ変化なし(実機仕様。spcDsp.js _updateEnvelopeの
            // 同修正と必ず対で保つこと。FF4等のAKAOがGAIN $A0を「現レベル保持」に使う)
            if (rate === 0) { /* 変化なし */ } else {
            envRate++;
            if (envRate >= ENV_RATE_TABLE[rate]) {
              envRate = 0;
              switch (mode) {
                case 0: env -= 32; break;
                case 1: env -= ((env - 1) >> 8) + 1; break;
                case 2: env += 32; break;
                case 3: env += (env < 0x600) ? 32 : 8; break;
              }
            }
            }
          } else {
            env = (gain & 0x7F) << 4;
          }
        } else if (envMode === 'attack') {
          const ar = adsr1 & 0x0F;
          const rate = ar === 15 ? 31 : ar * 2 + 1;
          envRate++;
          if (envRate >= ENV_RATE_TABLE[rate]) {
            envRate = 0;
            env += (ar === 15) ? 1024 : 32;
            if (env >= 0x7E0) { env = 0x7E0; envMode = 'decay'; }
          }
        } else if (envMode === 'decay') {
          const dr = (adsr1 >> 4) & 0x07;
          const rate = 8 + dr * 2;
          envRate++;
          if (envRate >= ENV_RATE_TABLE[rate]) {
            envRate = 0;
            env -= ((env - 1) >> 8) + 1;
            const sl = (adsr2 >> 5) & 0x07;
            const sustLevel = (sl + 1) << 8;
            if (env <= sustLevel) { env = sustLevel; envMode = 'sustain'; }
          }
        } else if (envMode === 'sustain') {
          const sr = adsr2 & 0x1F;
          if (sr !== 0) {
            envRate++;
            if (envRate >= ENV_RATE_TABLE[sr]) {
              envRate = 0;
              env -= ((env - 1) >> 8) + 1;
              if (env <= 0) { env = 0; envMode = 'off'; }
            }
          }
        }
        env = Math.max(0, Math.min(0x7FF, env));
      }
      if ((tick + 1) % SAMPLES_PER_FRAME === 0) {
        perFrame.push(Math.round((env / 0x7FF) * 15));
      }
    }
    return trimConstantTail(perFrame);
  }

  // キーオフ後のリリースカーブをシミュレートする。実機ではADSR/GAINの設定に
  // 関係なく常に固定の指数減衰レートなので、曲全体で1つだけ生成すればよい。
  // (どの音量から離鍵されたかは考慮せず、フル音量からの減衰で近似する)
  function simulateSpcRelease(maxFrames) {
    let env = 0x7E0;
    const perFrame = [];
    const totalTicks = maxFrames * SAMPLES_PER_FRAME;

    for (let tick = 0; tick < totalTicks; tick++) {
      if (env > 0) {
        env -= ((env - 1) >> 8) + 1;
        if (env < 0) env = 0;
      }
      if ((tick + 1) % SAMPLES_PER_FRAME === 0) {
        perFrame.push(Math.round((env / 0x7FF) * 15));
      }
    }
    return trimConstantTail(perFrame);
  }

  // ── BRR バイト列 → PCM (Float32Array, -1..1) ────────────────────────
  function decodeBrrBytes(brrBytes) {
    const pcm = [];
    let prev1 = 0, prev2 = 0;
    for (let blk = 0; blk + 8 < brrBytes.length; blk += 9) {
      const header = brrBytes[blk];
      const shift  = header >> 4;
      const filter = (header >> 2) & 3;
      const end    = header & 1;

      for (let i = 0; i < 8; i++) {
        const byte = brrBytes[blk + 1 + i];
        for (let nib = 0; nib < 2; nib++) {
          const raw = nib === 0 ? (byte >> 4) : (byte & 0xF);
          let s = (raw & 8) ? (raw | 0xFFFFFFF0) : raw;
          if (shift <= 12) { s = (s << shift) >> 1; }
          else             { s = (s >> 3) & ~1; }
          switch (filter) {
            case 1: s += prev1 - (prev1 >> 4); break;
            case 2: s += (prev1 << 1) - ((prev1 * 3) >> 5) - prev2 + (prev2 >> 4); break;
            case 3: s += (prev1 << 1) - ((prev1 * 13) >> 6) - prev2 + ((prev2 * 3) >> 4); break;
          }
          s = Math.max(-32768, Math.min(32767, s));
          s = (s << 1) >> 1;
          pcm.push(s / 32768);
          prev2 = prev1;
          prev1 = s;
        }
      }
      if (end) break;
    }
    return new Float32Array(pcm);
  }

  // ── PCM 1周期 → FDS 波形 (64点 0-63) ───────────────────────────────
  function pcmToFdsWave(pcm) {
    const wave = new Array(64);
    for (let i = 0; i < 64; i++) {
      const srcPos = (i / 64) * pcm.length;
      const i0 = Math.floor(srcPos) % pcm.length;
      const v  = pcm[i0];
      wave[i] = Math.max(0, Math.min(63, Math.round((v * 0.5 + 0.5) * 63)));
    }
    return wave;
  }

  // ── PCM 1周期 → N163 波形 (16点 0-15) ──────────────────────────────
  function pcmToN163Wave(pcm) {
    const wave = new Array(16);
    for (let i = 0; i < 16; i++) {
      const srcPos = (i / 16) * pcm.length;
      const i0 = Math.floor(srcPos) % pcm.length;
      const v  = pcm[i0];
      wave[i] = Math.max(0, Math.min(15, Math.round((v * 0.5 + 0.5) * 15)));
    }
    return wave;
  }

  // ── PCM → DPCM エンコード (MML.Dpcm.encode を利用) ─────────────────
  function brrToDpcm(brrBytes, rateIndex) {
    const pcm = decodeBrrBytes(brrBytes);
    return MML.Dpcm.encode(pcm, DSP_RATE, rateIndex != null ? rateIndex : 15);
  }

  // ── SPC キャプチャ ───────────────────────────────────────────────────
  // ディレクトリ($5D)を辿ってROM上の全BRRサンプルを収集する(capture/captureAsync共通)。
  function _collectBrrSamples(player) {
    const brrSamples = {};
    const dir = player.dsp.regs[0x5D];
    for (let srcn = 0; srcn < 256; srcn++) {
      const dirAddr  = ((dir << 8) + srcn * 4) & 0xFFFF;
      const startAddr = player.ram[dirAddr] | (player.ram[(dirAddr+1) & 0xFFFF] << 8);
      // DIRは疎なことがある(未使用エントリ=0のまま先頭に混ざる。Chrono Trigger等で実測)。
      // 以前はここで break していたため、最初の空エントリ以降の全サンプルが収集されず、
      // 波形/@DPCM/チューニング補正が全て空振りしていた。空エントリは飛ばして続行する。
      if (startAddr === 0 || startAddr === 0xFFFF) continue;
      const brrBytes = [];
      let addr = startAddr;
      for (let blk = 0; blk < 4096; blk++) {
        const header = player.ram[addr & 0xFFFF];
        for (let b = 0; b < 9; b++) brrBytes.push(player.ram[(addr + b) & 0xFFFF]);
        if (header & 1) break;
        addr += 9;
      }
      // ループ開始アドレス(DIRエントリ+2)。サンプル範囲内ならバイトオフセットとして持つ
      // (基音検出の解析窓を完全な定常部=ループ以降に置くため。範囲外/未ループはnull)
      const loopAddr = player.ram[(dirAddr + 2) & 0xFFFF] | (player.ram[(dirAddr + 3) & 0xFFFF] << 8);
      const loopByteOffset = (loopAddr >= startAddr && loopAddr < startAddr + brrBytes.length)
        ? loopAddr - startAddr : null;
      brrSamples[srcn] = { startAddr, loopByteOffset, bytes: new Uint8Array(brrBytes) };
    }
    return brrSamples;
  }

  // .spcファイルは「曲の演奏途中の瞬間」をダンプしたスナップショットであることが多く、
  // 保存されたDSPレジスタ自体が既にKON済み(アタック中)のボイスを含んでいることがある。
  // この初期状態はSpcPlayerのコンストラクタ内(ログ記録を始める前)に一度だけ適用されて
  // しまうため、onWriteフックでは一切観測できず、extractVoiceEvents側は「そのボイスの
  // KONが来るまで無音」として扱ってしまい、実際には曲の最初から鳴っている音がロール/MML
  // 変換のどちらにも一切現れない不具合になっていた(実SPCで確認)。そこで、SpcPlayerが
  // 内部で読み込むのと同じ生のDSPレジスタ値(MML.SPC.getDspRegs、player.dsp.regsではない
  // ―― KONレジスタは_keyOn発火後クリアされてしまうため必ずファイルの生バイトを使う)を
  // frame0の先頭に疑似的な書き込みとして注入し、フレーム0時点で既に鳴っているボイスを
  // 正しく認識できるようにする。
  function _seedInitialFrame(frameLog, spcBytes) {
    const dspRegs = MML.SPC.getDspRegs(spcBytes);
    for (let reg = 0; reg < 128; reg++) frameLog[0].push({ reg, val: dspRegs[reg] });
  }

  MML.SPC2MML.capture = function (spcBytes, durationSec) {
    const player  = new MML.Emu.SpcPlayer(spcBytes);
    const totalDspSamples = Math.round(durationSec * DSP_RATE);
    const frames  = Math.ceil(totalDspSamples / SAMPLES_PER_FRAME);
    const frameLog = Array.from({ length: frames }, () => []);
    _seedInitialFrame(frameLog, spcBytes);

    // envLog[f] = フレーム末尾時点の各ボイスの実エンベロープ値(ENVX相当、0..127)。
    // AKAO系ドライバはKON後にGAIN直値やADSR書き換えで音量を作るため、KON時点の
    // レジスタから机上シミュレートする方式では音量が取れない(FF4で実測)。実測値を
    // そのまま@v化する(NSFのhwEnvSeqと同じ思想)
    const envLog = Array.from({ length: frames }, () => null);
    const snapEnv = () => { const e = new Uint8Array(8); for (let c = 0; c < 8; c++) e[c] = player.dsp.voices[c].env >> 4; return e; };
    let frame = 0, samplesInFrame = 0;
    // off: そのフレーム内での書き込みサンプル位置(0..SAMPLES_PER_FRAME-1)。
    // ★2026-08-25: 再生(SpcReplayStreamPlayer)がフレーム先頭で全書き込みを一括適用して
    // いたため、同一フレーム内のKON→KOFFが同じサンプルへ潰れて音が丸ごと消え、AKAO系の
    // GAIN連続書き込みによる減衰カーブも崩れていた(FF4実測: 音量比0.72・欠落26フレーム)。
    // 位置を持たせて再生側で実タイミングを再現すると正解と完全一致(比1.000/欠落0)する。
    player.dsp.onWrite = (reg, val) => {
      if (frame < frames) frameLog[frame].push({ reg: reg & 0x7F, val, off: samplesInFrame });
    };

    for (let s = 0; s < totalDspSamples; s++) {
      samplesInFrame++;
      player.renderSample();
      if (samplesInFrame >= SAMPLES_PER_FRAME) {
        if (frame < frames) envLog[frame] = snapEnv();
        samplesInFrame = 0; frame++;
      }
    }

    return { log: frameLog, brrSamples: _collectBrrSamples(player), envLog, frameRate: FPS_SPC };
  };

  // captureの非同期チャンク版。SPCは事前レンダリングを持たない完全リアルタイム合成
  // フォーマットのため、ピアノロールの先読み表示はこの関数で裏キャプチャした結果を使う
  // (src/emulator/kssPlayer.js の captureKssSongAsync と同じ「一定量ごとにイベント
  // ループへ制御を返す」パターン)。onProgressにはその時点までのframeLog(同一配列参照、
  // 伸びていく)も渡すので、キャプチャ完了を待たずに途中経過だけでピアノロールを段階的に
  // 埋めていける。戻り値はcapture()と同じ { log, brrSamples } 形。
  MML.SPC2MML.captureAsync = async function (spcBytes, durationSec, onProgress, shouldCancel, opt = {}) {
    const player  = new MML.Emu.SpcPlayer(spcBytes);
    const totalDspSamples = Math.round(durationSec * DSP_RATE);
    const frames  = Math.ceil(totalDspSamples / SAMPLES_PER_FRAME);
    const frameLog = Array.from({ length: frames }, () => []);
    _seedInitialFrame(frameLog, spcBytes);

    // envLog: capture()と同じ実測エンベロープ採取(コメントはそちらを参照)
    const envLog = Array.from({ length: frames }, () => null);
    const snapEnv = () => { const e = new Uint8Array(8); for (let c = 0; c < 8; c++) e[c] = player.dsp.voices[c].env >> 4; return e; };
    let frame = 0, samplesInFrame = 0;
    // off: そのフレーム内での書き込みサンプル位置(0..SAMPLES_PER_FRAME-1)。
    // ★2026-08-25: 再生(SpcReplayStreamPlayer)がフレーム先頭で全書き込みを一括適用して
    // いたため、同一フレーム内のKON→KOFFが同じサンプルへ潰れて音が丸ごと消え、AKAO系の
    // GAIN連続書き込みによる減衰カーブも崩れていた(FF4実測: 音量比0.72・欠落26フレーム)。
    // 位置を持たせて再生側で実タイミングを再現すると正解と完全一致(比1.000/欠落0)する。
    player.dsp.onWrite = (reg, val) => {
      if (frame < frames) frameLog[frame].push({ reg: reg & 0x7F, val, off: samplesInFrame });
    };

    // ★2026-08-20 スライスを「フレーム数固定(CHUNK_FRAMES=10)」から「時間予算固定」へ変更
    // (capture.js captureSongAsyncと同じ方式・同じ理由。端末速度差の自動吸収)。
    // Worker実行時(src/audio/capture-worker-client.js)はopt.yieldFn/sliceBudgetMsで
    // 上書きされる。frame===1で必ず一度onProgressを発火するのも同様(最初のonProgressで
    // 実再生のplayer.load()が走るため。SPCはフレームレンダリングが重く、旧来の
    // 10フレーム待ちは再生開始遅延としてそのまま効いていた)。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : 5;
    const yieldFn = opt.yieldFn || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    let sliceStart = performance.now();
    for (let s = 0; s < totalDspSamples; s++) {
      samplesInFrame++;
      player.renderSample();
      if (samplesInFrame >= SAMPLES_PER_FRAME) {
        if (frame < frames) envLog[frame] = snapEnv();
        samplesInFrame = 0;
        frame++;
        if (frame === 1 || performance.now() - sliceStart >= sliceBudgetMs) {
          if (onProgress) onProgress(frame, frames, frameLog);
          await yieldFn();
          // 曲切替/停止の連打で先読みキャプチャが何本も積み上がりCPUを食い合うのを防ぐため、
          // 呼び出し元から「もう不要」と言われたらここでループ自体を打ち切る(onProgress側だけ
          // 無視してもエミュレーション自体は最後まで回り続けてしまうため不十分だった)。
          if (shouldCancel && shouldCancel()) {
            return { log: frameLog, brrSamples: _collectBrrSamples(player), envLog, frameRate: FPS_SPC };
          }
          sliceStart = performance.now();
        }
      }
    }
    if (onProgress) onProgress(frames, frames, frameLog);

    return { log: frameLog, brrSamples: _collectBrrSamples(player), envLog, frameRate: FPS_SPC };
  };

  // ── DSPログ(フレーム単位のreg/val書き込み列)からボイスごとのノートイベントを抽出 ──
  // 戻り値: 長さ8の配列、各要素は {frame, len, pitchSemi, srcn, adsr1, adsr2, gain} の配列。
  // MML変換(convert)とピアノロールの先読みタイムライン構築の両方から使う共通ロジック。
  //
  // KON(キーオン)だけでなく、ノート途中のピッチレジスタ変化(KONを送り直さずピッチだけ
  // 書き換えて音を滑らかに繋ぐ「ポルタメント/レガート」。ゲーム音楽のSPCドライバでは
  // 一般的な手法)でもイベントを区切り直す。KONを再送しない限り音程が変わったことを検知
  // できず、実際には音程が動いているのに1つの固定ピッチのノートとして出力されてしまう
  // 問題があったため(ロールで発見、実SPCで確認済み)。
  //
  // ★ただし「新しいピッチに変わった瞬間」を無条件に区切ると、ビブラート(音を伸ばしながら
  // 半音境界をまたいで細かく音程を揺らす奏法。ギター/リードパートで非常によく使われる)まで
  // 1フレームごとに別々の新しい音符として誤検出し、極薄(1フレーム程度)の音符の連続に
  // 化けて描画も崩れる不具合があった(実SPCのピクセル単位検証で確認)。
  // ★2026-08-10(DESIGN-PITCH.md Phase 2): 以前はここで独自のPITCH_CONFIRM_FRAMES
  // デバウンス(候補ピッチがNフレーム続くまで確定しない)を行っていたが、他形式と同じ
  // 「即座に分割してから後段でmergeAlternatingVibratoにより統合する」方式に統一した
  // (境界判定そのものは変えず、統合だけを共有ロジックに委ねるINV-3の原則)。
  // 分割直後の配列はmergeSpcVoiceEvents()で後処理する。

  MML.SPC2MML.extractVoiceEvents = function (log, options = {}) {
    const FRAMES = log.length;
    // envLog(capture()/captureAsync()が採取): フレーム毎の実エンベロープ値(0..127)。
    // あればVOL L/Rとの積を実測音量列(volSeq、0..127)として各イベントに載せる
    const envLog = options.envLog || null;
    // srcn → 原音チューニング補正(半音)。未指定なら全サンプル補正0(=従来動作)。
    // ピッチ→ノート変換は、その音符を鳴らしているサンプル(activeSrcn)固有の補正を使う。
    const srcnFineTune = options.srcnFineTune || null;
    const tuneOf = (srcn) => srcnFineTune ? (srcnFineTune[srcn] || 0) : 0;

    // ── DSP ログをフレームごとに追跡 ────────────────────────────────
    const dspState   = new Uint8Array(128);
    const konLatched  = new Uint8Array(FRAMES);
    const koffLatched = new Uint8Array(FRAMES);

    for (let f = 0; f < FRAMES; f++) {
      for (const { reg, val } of log[f]) {
        dspState[reg] = val;
        if (reg === 0x4C) konLatched[f]  |= val;
        if (reg === 0x5C) koffLatched[f] |= val;
      }
    }

    // ── ボイスごとのピッチ履歴 (KONタイミング時点のdspStateから取得) ─
    // dspState は上のループで最終状態になっているので、
    // ボイスイベント抽出は別パスで行う。
    const voiceEvents = Array.from({ length: 8 }, () => []);

    for (let ch = 0; ch < 8; ch++) {
      const voiceDsp = new Uint8Array(8); // このボイスのレジスタ追跡用
      let activePitch = 0, activeSrcn = 0, activeStart = -1;
      let activeAdsr1 = 0, activeAdsr2 = 0, activeGain = 0;
      // NON(ノイズ有効ビット、$3D)とFLG($6C)下位5bitのノイズレート。KON/音程分割の
      // 時点の値をイベントへ焼き込む(2A03ノイズchへの借用時にレート→周期idx変換で使う)
      let nonReg = 0, flgReg = 0, activeNon = 0, activeNoiseRate = 0;
      let activeVolSeq = []; // 実測音量列(ENVX×VOL、0..127)。pitchSeqと同じ区切りで積む
      // vol: ボイス音量(VOL L/R、符号付き8bit)の絶対値の大きい方の、ノート中のピーク値。
      // 変換設定ENV=OFF(ADSR→@vテーブルを出さない)時の v<n> の材料(src/convert/options.js)
      let activeVol = 0;
      const s8 = (b) => (b << 24) >> 24;
      // pitchSeq(DESIGN-PITCH.md Phase 0): 確定済みセグメントのフレーム毎生ピッチレジスタ値。
      let activePitchSeq = [];
      // pendingTieCandidate(別プロジェクトE、2026-08-12): 次にpushされるイベントが
      // 「純粋な音程変化のみ」による区切りで始まったか(=スラー分割のタイ候補か)を
      // 一時保持する。KON(本物のアタック)/KOFF後の再開時はfalseにリセットする。
      let pendingTieCandidate = false;

      for (let f = 0; f < FRAMES; f++) {
        for (const { reg, val } of log[f]) {
          if (reg === 0x3D) nonReg = val;
          else if (reg === 0x6C) flgReg = val;
          const vc = reg >> 4, r = reg & 0x0F;
          if (vc !== ch || r > 0x09) continue;
          voiceDsp[r] = val;
        }
        const curPitch = voiceDsp[0x02] | ((voiceDsp[0x03] & 0x3F) << 8);
        const frameVol = Math.max(Math.abs(s8(voiceDsp[0x00])), Math.abs(s8(voiceDsp[0x01])));
        if (activeStart >= 0) activeVol = Math.max(activeVol, frameVol);
        // このフレームの実測音量(エンベロープ×ボイス音量)。envLog無し(ロール等)ではVOLのみ
        const envx = envLog && envLog[f] ? envLog[f][ch] : null;
        const lvlNow = envx == null ? frameVol : Math.round(envx * frameVol / 127);
        // 音程比較・区切りは、現在鳴っているノートのサンプル(activeSrcn)の補正で統一する
        // (1音符の間 srcn は不変なので curPitch/activePitch とも同じ補正を使えばよい)。
        const curPitchSemi = pitchToSemitone(curPitch, tuneOf(activeSrcn));
        const activePitchSemi = pitchToSemitone(activePitch, tuneOf(activeSrcn));

        if (konLatched[f] & (1 << ch)) {
          if (activeStart >= 0) {
            voiceEvents[ch].push({ frame: activeStart, len: f - activeStart, pitch: activePitch, pitchSemi: activePitchSemi, srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, vol: activeVolSeq.length ? activeVolSeq.reduce((mx, v) => (v > mx ? v : mx), 0) : activeVol, volSeq: activeVolSeq, non: activeNon, noiseRate: activeNoiseRate, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
          }
          activePitch = curPitch;
          activeSrcn  = voiceDsp[0x04];
          activeAdsr1 = voiceDsp[0x05];
          activeAdsr2 = voiceDsp[0x06];
          activeGain  = voiceDsp[0x07];
          activeVol   = frameVol;
          activeNon   = (nonReg >> ch) & 1;
          activeNoiseRate = flgReg & 0x1F;
          activeVolSeq = [lvlNow];
          activeStart = f;
          activePitchSeq = [curPitch];
          pendingTieCandidate = false; // KON=本物のアタックなので次のイベントはタイ候補ではない
        } else if (activeStart >= 0 && curPitchSemi !== activePitchSemi) {
          // ポルタメント/レガート: KONを送り直さない音程変化はここで即座に区切る
          // (ビブラートによる細切れ化はmergeSpcVoiceEvents()の共有ロジックで後統合する、
          // DESIGN-PITCH.md Phase 2)。KONが無い=まさに「純粋な音程変化のみによる区切り」
          // なので、次に始まるイベント(=今まさに開始するイベント。まだ未pushで、
          // このelse if節の中でactiveStart=fに更新される)をスラー分割のタイ候補とする
          // (pendingTieCandidateに立てておき、そのイベントが実際にpushされる時に読む。
          // 別プロジェクトE、2026-08-12)
          voiceEvents[ch].push({ frame: activeStart, len: f - activeStart, pitch: activePitch, pitchSemi: activePitchSemi, srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, vol: activeVolSeq.length ? activeVolSeq.reduce((mx, v) => (v > mx ? v : mx), 0) : activeVol, volSeq: activeVolSeq, non: activeNon, noiseRate: activeNoiseRate, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
          activePitch = curPitch;
          activeSrcn  = voiceDsp[0x04];
          activeAdsr1 = voiceDsp[0x05];
          activeAdsr2 = voiceDsp[0x06];
          activeGain  = voiceDsp[0x07];
          activeVol   = frameVol;
          activeNon   = (nonReg >> ch) & 1;
          activeNoiseRate = flgReg & 0x1F;
          activeVolSeq = [lvlNow];
          activeStart = f;
          activePitchSeq = [curPitch];
          pendingTieCandidate = true; // このイベントを閉じたのは純粋な音程変化 → 次のイベントはタイ候補
        } else if (activeStart >= 0) {
          activePitchSeq.push(curPitch);
          activeVolSeq.push(lvlNow);
        }
        // 同じフレーム内にこのボイスのKONも来ている場合、そのKOFFは無視する。
        // 実機のDSPはKON/KOFFが同一タイミングで競合するとKON側が優先され、
        // ノートは途切れずクリーンに継続/再始動する(音が鳴ったまま次に繋がる)。
        // ここでKOFFを適用してしまうと、KONで開いたばかりのノートを同フレームで
        // 即座に閉じてしまい、幅1フレームの偽ノートが生成され、かつその直後の
        // 本物のピッチ変化(レガート)が「無音状態からの変化」として完全に無視
        // されてしまう不具合があった(実SPCのV5パートで確認、ノート脱落の原因)。
        if ((koffLatched[f] & (1 << ch)) && !(konLatched[f] & (1 << ch))) {
          if (activeStart >= 0) {
            voiceEvents[ch].push({ frame: activeStart, len: Math.max(1, f - activeStart), pitch: activePitch, pitchSemi: pitchToSemitone(activePitch, tuneOf(activeSrcn)), srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, vol: activeVolSeq.length ? activeVolSeq.reduce((mx, v) => (v > mx ? v : mx), 0) : activeVol, volSeq: activeVolSeq, non: activeNon, noiseRate: activeNoiseRate, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
            activeStart = -1;
            activePitchSeq = [];
            pendingTieCandidate = false; // KOFF後、次に始まるノートは新規アタックなのでタイ候補ではない
          }
        }
      }
      if (activeStart >= 0) {
        voiceEvents[ch].push({ frame: activeStart, len: Math.max(1, FRAMES - activeStart), pitch: activePitch, pitchSemi: pitchToSemitone(activePitch, tuneOf(activeSrcn)), srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, vol: activeVolSeq.length ? activeVolSeq.reduce((mx, v) => (v > mx ? v : mx), 0) : activeVol, volSeq: activeVolSeq, non: activeNon, noiseRate: activeNoiseRate, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
      }
      // rawFreq(高速アルペジオ→EN統合のセント判定用、2026-08-14拡張): mergeSpcVoiceEvents
      // (外側のIIFEスコープの関数でtuneOfへ直接アクセスできない)へ渡す前にここで計算して
      // 各イベントへ付与しておく(DESIGN-PITCH.md Phase 1のpitchRegToFreqHzを流用)。
      for (const ev of voiceEvents[ch]) ev.rawFreq = pitchRegToFreqHz(ev.pitch, tuneOf(ev.srcn));
      voiceEvents[ch] = mergeSpcVoiceEvents(voiceEvents[ch]);
    }

    return voiceEvents;
  };

  // 即座に分割されたvoiceEvents(frame/len/pitchSemi/pitchSeq/srcn/adsr/gain形式)を
  // 共有のMML.Convert.mergeAlternatingVibrato(start/end/note形式)へ橋渡しするアダプタ。
  // KOFFで打ち切られた休符区間はvoiceEvents自体に含まれない(=配列内で隣接しない)ため、
  // 休符ぶんのダミー区切り(note:null)を挟んでから渡すことで、休符を跨いだ誤統合を防ぐ
  // (他形式は休符も1イベントとして持つため自然に区切られるが、SPCの配列表現には無い)。
  function mergeSpcVoiceEvents(events) {
    const mapped = [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (i > 0) {
        const prevEnd = events[i - 1].frame + events[i - 1].len;
        if (ev.frame !== prevEnd) mapped.push({ start: prevEnd, end: ev.frame, note: null });
      }
      mapped.push({
        start: ev.frame, end: ev.frame + ev.len, note: ev.pitchSemi, pitch: ev.pitch,
        rawFreq: ev.rawFreq,
        pitchSeq: ev.pitchSeq, srcn: ev.srcn, adsr1: ev.adsr1, adsr2: ev.adsr2, gain: ev.gain, vol: ev.vol,
        volSeq: ev.volSeq, non: ev.non, noiseRate: ev.noiseRate,
        tieCandidate: ev.tieCandidate
      });
    }
    // 高速アルペジオ→EN統合(2026-08-14拡張)。登録(noteEnvReg.registerShape)は
    // 呼び出し元のfromSpcがpitchRegと同じタイミングで曲全体共有のnoteEnvRegを使って
    // 行う(ay.js/scc.js/opll.jsと同じ「検出はここ、登録は呼び出し元」の遅延登録方式)。
    // その後にP-5「不明瞭→EPテーブル」側(スラー分割の相方、2026-08-12)。
    return MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(mapped))
      .filter(ev => ev.note != null)
      .map(ev => Object.assign({
        frame: ev.start, len: ev.end - ev.start, pitch: ev.pitch, pitchSemi: ev.note,
        srcn: ev.srcn, adsr1: ev.adsr1, adsr2: ev.adsr2, gain: ev.gain, vol: ev.vol, pitchSeq: ev.pitchSeq,
        volSeq: ev.volSeq, rawFreq: ev.rawFreq, non: ev.non, noiseRate: ev.noiseRate,
        tieCandidate: ev.tieCandidate
      }, ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}));
  }

  // ── MML 生成 ─────────────────────────────────────────────────────────
  MML.SPC2MML.convert = function (log, brrSamples, options = {}) {
    const FRAMES = log.length;

    // デフォルトマップ: V0→A, V1→B ... V3→D, V4→スキップ
    const DEFAULT_TYPES = ['pulse1','pulse2','triangle','noise','skip','skip','skip','skip'];
    const channelMap = options.channelMap || DEFAULT_TYPES.map(t => ({ type: t }));
    // 変換設定(src/convert/options.js): コマンド使用/不使用・譜面整形
    const cmd = MML.Convert.normalizeCmd(options.cmd);

    // 各BRRサンプルの実測原音から音程補正マップを作り、ノート抽出に反映する
    // (これにより実機の発音音程=SPC再生と一致する)。
    const srcnFineTune = computeSrcnFineTune(brrSamples);
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune, envLog: options.envLog });
    const tuneOf = (srcn) => srcnFineTune ? (srcnFineTune[srcn] || 0) : 0;

    // ── 打楽器サンプルの打点を旋律から切り出す(2026-09-03、2026-09-04にE指定を追加) ────
    // 打楽器の発音は、そのボイスの借用先ではなく「実サンプルのままDPCM(E)」へ行く
    // (src/convert/drumHits.js。打点が重なればその瞬間の音をミックスした1クリップになる)。
    // 打楽器とみなす条件はボイスの借用先で変わる:
    //   ・E(dpcm)以外のボイス … drumSrcns の自動判定に当たったsrcnだけ
    //   ・E(dpcm)のボイス     … そのボイスが鳴らした **全srcn**(パッド化。ユーザー合意 2026-09-04)。
    //                            ただしパッドで「音階として扱う」と指定したsrcnだけは従来どおり
    //                            音程付きDPCM(BRR丸ごと@DPCM+音符で音程)へ回す
    // 複数ボイスをEにすると、打点は全部この1本のDPCMへまとまる(同時に鳴った分は
    // DrumHits.dpcm がミックスして1クリップにする)。切り出した分は旋律側では休符。
    // cmd.DRUM=false なら従来どおり(打楽器も音程ノートのまま)。
    const drumOn = cmd.DRUM !== false && !!(MML.Convert.DrumHits && MML.Dpcm);
    const drumSrcnSet = drumOn ? MML.SPC2MML.drumSrcns(voiceEvents, srcnFineTune, options.drumKinds || null) : new Set();
    // 「音階として扱う」の手動指定(srcn → 'pitch')。Eボイスの中でここに載ったsrcnだけ音程付きDPCM
    const pitchSrcnSet = new Set();
    for (const k of Object.keys(options.drumKinds || {})) {
      if (options.drumKinds[k] === 'pitch') pitchSrcnSet.add(parseInt(k, 10));
    }
    const dpcmChans = [];   // E(dpcm)を選んだボイス
    const meloChans = [];   // それ以外(skip以外)のボイス
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;
      (cfg.type === 'dpcm' ? dpcmChans : meloChans).push(ch);
    }
    let drumHitsAll = [];
    if (drumOn && (drumSrcnSet.size || dpcmChans.length)) {
      const r = MML.SPC2MML.drumHits(voiceEvents, brrSamples, drumSrcnSet, meloChans,
        { dpcmChans, pitchSrcns: pitchSrcnSet });
      drumHitsAll = r.hits;
      // 旋律側からは切り出す(Eボイスは元々旋律を出さないので meloChans だけでよい)
      for (const ch of meloChans) {
        voiceEvents[ch] = voiceEvents[ch].filter(ev => !(ev.pitchSemi !== null && !ev.non && drumSrcnSet.has(ev.srcn)));
      }
    }
    // options.drumHits: 外から渡された打点(合成音chの分離レンダリング。SPCでは通常空)
    if (drumOn && options.drumHits && options.drumHits.length) drumHitsAll = drumHitsAll.concat(options.drumHits);
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry(cmd);
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14拡張)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry(cmd);

    // ── BPM (未指定ならマッピング済みチャンネルの有音イベントから自動検出、
    //         指定時もフレームグリッドへ吸着補正) ──
    // 音長(len)に加え、チャンネル毎の発音開始間隔(IOI)も検出材料にする。
    // IOIはゲートタイムで音符が短く切られてもグリッドに乗るため頑健。
    // 打楽器の打点(Eへ切り出した分)もテンポ推定の材料に戻す(音長+発音開始間隔を、切り出す前の
    // ボイスイベント列と同じ並びで)。SPCは従来から打楽器のボイスイベントを含めて推定しており、
    // 推定入力を同じにしておかないとテンポが変わる(実測: 打点を外すと2333曲中320曲、IOIだけ
    // 戻しても250曲が2〜3倍/1/2〜1/3に振れた)。vgm2mmlは逆にドラムを外しているが、あちらは
    // サンプルPCMのリトリガー間隔が音符長として混ざる問題があったため。SPCの打点は元々ノート長そのもの
    const noteDurations = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;
      const sounding = voiceEvents[ch].filter(ev => ev.pitchSemi !== null)
        .map(ev => ({ frame: ev.frame, len: ev.len }))
        .concat(drumHitsAll.filter(h => h.ch === ch).map(h => ({ frame: h.startFrame, len: h.endFrame - h.startFrame })))
        .sort((a, b) => a.frame - b.frame);
      for (const ev of sounding) noteDurations.push(ev.len);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.frame)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, FPS_SPC)
      : MML.Convert.detectBpm(noteDurations, FPS_SPC);
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパートで誤差が蓄積してドリフトする
    // ([[tempo-rounding-drift-future-issue]]参照)。
    const fpb = FPS_SPC * 60 / Math.round(bpm);

    // ── 実測エンベロープ → ppmck @v/@vr テーブル抽出 ──
    // ★2026-08-25 全面変更: 従来はKON時点の(adsr1,adsr2,gain)から机上シミュレートしていたが、
    // FF4等のAKAO系ドライバは「KON後にGAIN直値やADSR書き換えを連発して音量を作る」ため
    // KONスナップショットでは原理的に音量が取れない(@v={0}が量産され大半のノートが無音化)。
    // capture()が毎フレーム採取した実エンベロープ値×VOL(ev.volSeq、0..127)を
    // analyzeVolumeShape+共有EnvelopeRegistryで@v化する(NSF/KSS/GBS/HESと同じ方式)。
    // リリース(@vr0)は従来通り実機固定カーブのシミュレート値を使う。
    // 三角波(音量制御なし)とDPCMは対象外。
    const envCapableType = (type) => type && type !== 'skip' && type !== 'dpcm' && type !== 'triangle' &&
      !type.startsWith('vrc7'); // VRC7は@v非対応(compiler segmentsToWriteLogVrc7はENのみ)。v<n>で出す
    // ボイス音量の正規化基準(2026-08-24): SPCのVOL L/Rは絶対値が小さい曲が多く(実測:
    // 最大37/127等)、0..127→0..15の絶対マッピングでは全chが v1〜2 に潰れて比率も丸めで
    // 消える。「音量制御を持つ借用先」に割り当てたボイス全体の最大値を15へ正規化し、
    // チャンネル間の音量比を0..15レンジへ引き延ばす。音量が固定のDPCM割当ボイスと
    // スキップは基準に含めない(含めるとN163等が上限を使い切れない)。
    let songMaxVol = 0;
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || !envCapableType(cfg.type)) continue;
      for (const ev of voiceEvents[ch]) songMaxVol = Math.max(songMaxVol, ev.vol || 0);
    }
    if (!songMaxVol) songMaxVol = 127;
    // 借用先ごとの音量上限(2026-08-24): 本家ppmck同様、FDSは$4080ゲイン生値(実効32で
    // 頭打ち)、VRC6のこぎり波は$B000蓄積レート生値(実質42が最大。43以上は8bit桁溢れで
    // 音が崩れるだけ)。他は0-15。src/mml/compiler.js volMax(v<n>の上限63)のコメント参照。
    // 一律0-15にするとFDSは実効半分・のこぎりは1/3の音量しか出ず「音が小さい」となる。
    const TARGET_VOL_MAX = { fds: 32, vrc6saw: 42 };
    const volStepOf = (vol, type) => {
      const m = TARGET_VOL_MAX[type] || 15;
      return Math.max(1, Math.round((vol || 0) * m / songMaxVol)); // 0でも1(発音はしている)
    };
    const MAX_ENV_FRAMES = 180; // @vr0(リリース)のシミュレート長
    const envReg = new MML.Convert.EnvelopeRegistry(cmd);
    let usesReleaseTable = false;

    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || !envCapableType(cfg.type)) continue;
      if (!cmd.ENV) continue; // 変換設定ENV=OFF: @v/@vrテーブルを作らずボイス音量のv<n>で代替
      // チャンネル別の変換音量(volPct、src/convert/options.js)。songMaxVolは縮小前の
      // 生値から計算済みなので、ここで乗算すれば「曲中最大=targetMax」の正規化基準に対する
      // 相対的な減衰になる(他chとのバランス指定がそのまま効く)
      const chVolScale = MML.Convert.channelVolScale(cfg);
      const targetMax = TARGET_VOL_MAX[cfg.type] || 15;
      const k = chVolScale === 0 ? 0 : (targetMax * chVolScale) / songMaxVol;
      for (const ev of voiceEvents[ch]) {
        if (ev.pitchSemi === null && !(cfg.type === 'noise' && ev.non)) continue;
        if (!ev.volSeq || ev.volSeq.length === 0) continue; // envLog無し(旧経路)はv<n>へ
        const seq = ev.volSeq.map(v => Math.max(0, Math.min(targetMax, Math.round(v * k))));
        const idx = envReg.assign(seq);
        if (idx == null) {
          // フラット(エンベロープ不要)なノート: ピーク値をv<n>で出す
          ev.plainVol = MML.Convert.plainVolume(seq);
        } else {
          ev.envelopeIdx = idx;
          usesReleaseTable = true;
        }
      }
    }
    const releaseTable = usesReleaseTable ? simulateSpcRelease(MAX_ENV_FRAMES) : null;

    // ── 拡張音源を確定(複数同居可、2026-08-24) ─────────────────────────
    // 従来は「最初に見つかった1種類だけ」だったため、FDS+N163のような組み合わせを
    // 選んでも片方が無音になっていた。使われている拡張を全部集め、チャンネル文字は
    // assignExpansionLettersの完全固定範囲(dpcm=E, fds=F, vrc6=M-O, n163=P-W, fme7=X-Z,
    // mmc5=a-b)から引く。
    const usedExpansions = [];
    let n163MaxIndex = -1;
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip' || cfg.type === 'dpcm') continue;
      const exp = TYPE_TO_EXPANSION[cfg.type];
      if (!exp) continue;
      if (!usedExpansions.includes(exp)) usedExpansions.push(exp);
      if (exp === 'n163') n163MaxIndex = Math.max(n163MaxIndex, TYPE_TO_CHIP_INDEX[cfg.type]);
    }
    // #EX-NAMCO106 <n> と周波数式(n163FreqRegRawSpc)が使う実効ch数。実機N163は有効ch数で
    // 各chの更新レートが変わる=同じ周波数レジスタ値でも音程が変わるため、宣言と式は必ず
    // 一致させること
    const n163UsedCount = n163MaxIndex + 1;
    const expansion = usedExpansions[0] || 'none'; // 後方互換(result.expansion)用

    // ── DPCM 変換 (全ボイス中で DPCM 指定されたものの srcn を収集) ──
    // SNESのBRRサンプルは元々ノートごとにピッチシフトして鳴らす前提の楽器なので、
    // 実機ppmckc(音符バイト=dpcm_dataテーブルの行選択、ピッチの動的変換は無い)を
    // そのまま真似るのではなく、このツール独自の連続ピッチ量子化
    // (compiler.jsのdpcmRateIndexForNote)を使う設計にする。@DPCM<n>定義は
    // 基準ピッチ(pitchSemi=60、SNESのPitch=0x1000=原音)での再生レートとして
    // 固定レート15(最高音質)を使い、実際に弾かれた音は基準からの半音差で
    // 最寄りのハードウェアレートへ量子化される(NSF側のような複数レート定義の
    // 使い分けはしない。BRRサンプルにNES実機のような固定サンプルテーブルの
    // 概念が無いため)。
    // ★2026-09-04: Eボイスの発音は既定でパッド(打楽器)へ回るようになったので、ここに来るのは
    //   パッドで「音階として扱う」と指定したsrcnだけ(pitchSrcnSet)。打楽器化そのものを切って
    //   いる(cmd.DRUM=false)ときは従来どおり全srcnがこちら。
    const dpcmSrcns = new Set();
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type !== 'dpcm') continue;
      for (const ev of voiceEvents[ch]) {
        if (drumOn && !pitchSrcnSet.has(ev.srcn)) continue;
        dpcmSrcns.add(ev.srcn);
      }
    }

    // srcn → DPCM インデックス (@N) の対応表
    const srcnToDpcmIdx = {};
    const dmcFiles = [];
    let dpcmIdx = 0;
    for (const srcn of dpcmSrcns) {
      const brr = brrSamples[srcn];
      if (!brr || brr.bytes.length === 0) continue;
      const result = brrToDpcm(brr.bytes, 15);
      srcnToDpcmIdx[srcn] = dpcmIdx;
      dmcFiles.push({ name: `dpcm_srcn${String(srcn).padStart(3,'0')}.dmc`, bytes: result.bytes, rateIndex: result.rateIndex });
      dpcmIdx++;
    }

    // DPCM(物理的に1系統しか無いDMCチャンネル)は全dpcm指定ボイスのノートを
    // 時系列で1本にまとめる。複数ボイスが同時にdpcmを使った場合、後から
    // 鳴った方が先の再生を上書きする実機同様の制約になる(開始フレーム順に
    // 並べるだけで自然にそうなる)。
    const dpcmNoteEvents = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type !== 'dpcm') continue;
      for (const ev of voiceEvents[ch]) {
        if (ev.pitchSemi === null || srcnToDpcmIdx[ev.srcn] === undefined) continue;
        // DPCMはBRRサンプルそのものを再生レートを変えて鳴らす方式で、@DPCM定義は
        // 原音(pitch=0x1000)をレート15で収録している。サンプルには実音程が既に焼き込まれて
        // いるため、必要なのは原音レートからの相対比(pitch/0x1000)だけで、サンプル固有の
        // 原音チューニング補正(tune)は加えてはならない(加えると二重補正になる)。そのため
        // 音源発振型(パルス/FDS/N163等)で使う補正済み pitchSemi ではなく、生ピッチから
        // 補正0で算出したノートを使う。基準ピッチ(pitch=0x1000)→60→DPCM_BASE_NOTE(48)へ-12。
        const rawSemi = pitchToSemitone(ev.pitch, 0);
        if (rawSemi === null) continue;
        dpcmNoteEvents.push({
          start: ev.frame, end: ev.frame + ev.len,
          note: Math.max(0, Math.min(95, rawSemi - 12)),
          instrument: srcnToDpcmIdx[ev.srcn]
        });
      }
    }
    // ── 打楽器サンプルの打点 → @DPCM(共通コア)。定義は音程付きDPCMの後ろへ連番で足す ──
    let drumDpcm = null;
    if (drumHitsAll.length) {
      drumDpcm = MML.Convert.DrumHits.dpcm(drumHitsAll, FPS_SPC, {
        totalFrames: FRAMES, pcmRate: cmd.PCM_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY, prefix: 'spc_drum',
        maxClipSec: 10, // BRRは有限長。VGMのROM歯止め1.5秒は外す
      });
      const base = dmcFiles.length;
      for (const d of drumDpcm.defs) {
        dmcFiles.push({ name: d.file, bytes: drumDpcm.files[d.index].bytes, rateIndex: d.freq, dac: d.dac, mode: d.mode });
      }
      for (const ev of drumDpcm.events) dpcmNoteEvents.push({ start: ev.start, end: ev.end, note: 48, instrument: base + ev.instrument });
    }
    dpcmNoteEvents.sort((a, b) => a.start - b.start);

    // DPCM/拡張音源のチャンネル文字は、src/mml/compiler.jsのassignExpansionLettersを
    // そのまま再利用して決める(実機ppmck同様、各チップの文字範囲は他チップの有無に
    // 関わらず完全固定。EXPANSION_PRIORITY = dpcm,fds,vrc7,vrc6,n163,fme7,mmc5)。
    // これによりコンパイル時に実際に割り当てられる文字と一致する。
    const usesDpcm = dpcmNoteEvents.length > 0;
    const letterExpansions = [
      ...(usesDpcm ? ['dpcm'] : []),
      ...usedExpansions,
    ];
    const expansionLetterMap = MML.Mml.assignExpansionLetters(letterExpansions);
    const dpcmLetter = usesDpcm ? expansionLetterMap.dpcm[0] : null;
    // type → 出力チャンネル文字(2A03はTYPE_TO_LETTER、拡張はチップ固定範囲のchipIndex番目)
    const letterForType = (type) => TYPE_TO_LETTER[type]
      || ((expansionLetterMap[TYPE_TO_EXPANSION[type]] || [])[TYPE_TO_CHIP_INDEX[type]]);

    // ── FDS/N163 波形をsrcnごとに生成 ────────────────────────────────
    // BRRサンプルの定常部から基本周期1周期分を切り出して波形メモリ化する(検出は
    // detectBrrFundamentalを流用)。周期が取れない打楽器/ノイズ系は従来通りサンプル全体を
    // リサンプリング(それらしい倍音構成にはならないが無音よりまし)。振幅は最大値で正規化。
    const waveCache = {}; // srcn → { fds: [], n163: [] }
    function extractCyclePcm(brrBytes) {
      const pcm = decodeBrrBytes(brrBytes);
      if (pcm.length === 0) return new Float32Array([0]);
      const fund = detectBrrFundamental(brrBytes);
      let cycle = pcm;
      if (fund && fund.conf >= FUNDAMENTAL_CONF_MIN && fund.freq > 0) {
        const period = Math.max(2, Math.round(DSP_RATE / fund.freq));
        const start = Math.min(pcm.length >> 2, 512); // detectBrrFundamentalと同じ定常部開始
        if (start + period <= pcm.length) cycle = pcm.slice(start, start + period);
      }
      let peak = 0;
      for (const v of cycle) peak = Math.max(peak, Math.abs(v));
      if (peak > 0 && peak < 1) {
        const scaled = new Float32Array(cycle.length);
        for (let i = 0; i < cycle.length; i++) scaled[i] = cycle[i] / peak;
        cycle = scaled;
      }
      return cycle;
    }
    function getWave(srcn) {
      if (waveCache[srcn]) return waveCache[srcn];
      const brr = brrSamples[srcn];
      const cycle = brr && brr.bytes.length > 0 ? extractCyclePcm(brr.bytes) : new Float32Array([0]);
      waveCache[srcn] = { fds: pcmToFdsWave(cycle), n163: pcmToN163Wave(cycle) };
      return waveCache[srcn];
    }
    // 波形はKSS/NSFと同じ共有レジストリで曲全体の重複を排除し、@FM<n>/@N<n>として
    // MML本文のヘッダに定義、音符側は@<n>(instrument)で切り替える
    const fdsWaveReg = new MML.Convert.WaveRegistry('@FM');
    const n163WaveReg = MML.Convert.n163WaveRegistry();
    // VRC7自作音色(@0 + OP<n>)。BRRサンプルの1周期から2op FMパッチを推定して@OP<n>に登録する
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');

    // ── BRR1周期 → OPLL(2op FM)自作音色の推定 ──────────────────────────
    // サンプル波形をFMで厳密再現するのは不可能なので、倍音構成の「明るさ」を耳コピ近似で
    // 2opパッチへ写像する:
    //  - 基本波に対する高調波エネルギー比R → モジュレータTL(変調深度。倍音豊富ほど深く)
    //  - 倍音が多く奇数次優勢(矩形/ノコギリ系) → フィードバックを増やす
    //  - 2次倍音が基本波より強い → モジュレータMULT=2(オクターブ上変調)
    //  - エンベロープはサステイン型(EG-TYP=1, AR=15, SL=0)にして音量変化は v/@v 側に任せる
    // バイト列はOPLLレジスタ$00-$07の生値(@OP<n>定義、lexer.js parseVrc7ToneDefと同形式)。
    function pcmToOpllPatch(cycle) {
      const N = cycle.length;
      const H = 8;
      const amp = new Array(H + 1).fill(0);
      for (let k = 1; k <= H; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) {
          const ph = 2 * Math.PI * k * n / N;
          re += cycle[n] * Math.cos(ph); im += cycle[n] * Math.sin(ph);
        }
        amp[k] = Math.hypot(re, im) / N;
      }
      const h1 = amp[1] || 1e-9;
      let hi = 0, odd = 0, even = 0;
      for (let k = 2; k <= H; k++) { hi += amp[k] * amp[k]; if (k % 2) odd += amp[k]; else even += amp[k]; }
      const R = Math.sqrt(hi) / h1; // 0=正弦波 〜 1.5以上=矩形/ノコギリ級
      const tl = Math.max(2, Math.min(45, Math.round(40 - 26 * Math.min(1.5, R))));
      const fb = (R > 1.0 && odd > even) ? 3 : R > 0.6 ? 2 : R > 0.25 ? 1 : 0;
      const mult = amp[2] > amp[1] * 1.2 ? 2 : 1;
      return [
        0x20 | (mult & 0x0F), // mod: EG-TYP=1(sustained) MULT
        0x21,                 // car: EG-TYP=1 MULT=1
        tl & 0x3F,            // KSL=0 / TL(mod)
        fb & 7,               // KSL=0 DC=0 DM=0 / FB
        0xF0,                 // mod AR=15 DR=0
        0xF0,                 // car AR=15 DR=0
        0x0F,                 // mod SL=0 RR=15
        0x0F,                 // car SL=0 RR=15
      ];
    }
    // FDS/N163の音色選択(cfg.tone): 'copy'=サンプル1周期コピー(既定)、または固定波形。
    // 固定波形はサンプルに周期が無い(打楽器等)場合や、あえて素直な音色で編曲したい場合用。
    const fixedWaveCache = {};
    function fixedWave(kind, mode) {
      const key = kind + ':' + mode;
      if (fixedWaveCache[key]) return fixedWaveCache[key];
      const len = kind === 'fds' ? 64 : 16;
      const max = kind === 'fds' ? 63 : 15;
      const w = new Array(len);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        let v;
        if (mode === 'pulse50') v = t < 0.5 ? 1 : -1;
        else if (mode === 'sin') v = Math.sin(2 * Math.PI * t);
        else if (mode === 'triangle') v = t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
        else v = 2 * t - 1; // saw
        w[i] = Math.max(0, Math.min(max, Math.round((v * 0.5 + 0.5) * max)));
      }
      fixedWaveCache[key] = w;
      return w;
    }

    const opllPatchCache = {}; // srcn → @OP<n>登録番号
    function getOpllToneIdx(srcn) {
      if (opllPatchCache[srcn] !== undefined) return opllPatchCache[srcn];
      const brr = brrSamples[srcn];
      const cycle = brr && brr.bytes.length > 0 ? extractCyclePcm(brr.bytes) : new Float32Array([0]);
      const idx = vrc7ToneReg.assign(pcmToOpllPatch(Array.from(cycle)));
      opllPatchCache[srcn] = idx;
      return idx;
    }

    // ── MML 生成 ─────────────────────────────────────────────────────
    let mml = `; SPC → MML 変換 (${Math.round(bpm)} BPM, ${FRAMES} フレーム, 分解能480TPQN)\n`;
    if (usedExpansions.length) mml += `; 拡張音源: ${usedExpansions.join(', ')}\n`;
    // #EX-*(機能する本文ディレクティブ。上の`; `コメントとは別。これがないと
    // MML本文だけからは拡張音源が有効にならず、UI側の操作が必要になってしまう)
    for (const exp of usedExpansions) {
      mml += exp === 'n163'
        ? `${MML.Mml.EX_CHIP_DIRECTIVE[exp]} ${n163UsedCount}\n`
        : `${MML.Mml.EX_CHIP_DIRECTIVE[exp]}\n`;
    }

    // @DPCM<n>定義(実機ppmckcと同じ書式)。以後Eチャンネルの音符で@<n>により選択する
    for (let i = 0; i < dmcFiles.length; i++) {
      const f = dmcFiles[i];
      // 音程付きDPCM(BRR全体)はdac=255(初期DAC書込み省略)、打楽器クリップは先頭値のdac
      mml += `@DPCM${i} = { "${f.name}", ${f.rateIndex}, ${f.bytes.length}, ${f.dac != null ? f.dac : 255}, ${f.mode || 0} }\n`;
    }
    if (drumDpcm) {
      const st = drumDpcm.stats;
      mml += `; 打楽器サンプル(srcn ${Array.from(drumSrcnSet).sort((a, b) => a - b).join(',')})を実サンプルのままDPCM(E)へ: `
           + `定義${st.clips}件 / 打点${st.segments}個 / ROM ${(st.bytes / 1024).toFixed(1)}KB\n`;
    }

    // 実測エンベロープ由来の音量テーブル定義 (@vN / @vr0)
    for (const line of envReg.defLines()) mml += line + '\n';
    if (releaseTable) {
      mml += `@vr0 = { ${releaseTable.join(' ')} }\n`;
    }

    mml += '\n';

    // チャンネルごとの共通イベント形式を組み立て、最後にまとめて
    // 小節揃えスコア形式(1曲まるごと1回のemitScore呼び出し)で出力する。
    const scoreChannels = [];
    const detuneEntries = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;

      const events = voiceEvents[ch];
      if (events.length === 0) continue;

      const targetType = cfg.type;

      // DPCMは全ボイス分をdpcmNoteEventsに一本化済みなのでここではスキップ
      // (ループの外で1回だけscoreChannelsに追加する)
      if (targetType === 'dpcm') continue;

      const targetLetter = letterForType(targetType);
      if (!targetLetter) continue;

      const hasEnvelope = envCapableType(targetType) && cmd.ENV;
      // FDS/N163はsrcnごとの自作波形を@<n>(instrument)で切り替える
      const isFdsTarget = targetType === 'fds';
      const isN163Target = targetType.startsWith('n163');
      const isVrc7Target = targetType.startsWith('vrc7');
      // 音量制御を持つ借用先は常にv<n>可(NSFのA/B同様、@vとv併用。フラットなノートはv、
      // エンベロープのあるノートは@v)。VRC7は@v非対応なので常にv<n>
      const hasVolume = envCapableType(targetType) || isVrc7Target;
      // パルス系のデューティ選択(cfg.tone): 2A03/MMC5=@0-@3(既定@2=50%)、VRC6=@0-@7(既定@7=50%)
      const isPulseTarget = targetType === 'pulse1' || targetType === 'pulse2' ||
        targetType === 'mmc5pulse1' || targetType === 'mmc5pulse2';
      const isVrc6PulseTarget = targetType === 'vrc6pulse1' || targetType === 'vrc6pulse2';
      const dutyIdx = isPulseTarget
        ? Math.max(0, Math.min(3, Number.isInteger(parseInt(cfg.tone, 10)) ? parseInt(cfg.tone, 10) : 2))
        : isVrc6PulseTarget
          ? Math.max(0, Math.min(7, Number.isInteger(parseInt(cfg.tone, 10)) ? parseInt(cfg.tone, 10) : 7))
          : null;
      // FDS/N163の波形モード(cfg.tone): 'copy'(既定)/'pulse50'/'sin'/'triangle'/'saw'
      const waveMode = (isFdsTarget || isN163Target) ? (cfg.tone || 'copy') : null;
      const hasInstrument = isFdsTarget || isN163Target || isVrc7Target || dutyIdx !== null;
      const isNoiseTarget = targetType === 'noise';
      // チャンネル別の変換音量(volPct)。v<n>直接出力(ENV OFF時と VRC7)用
      const chVolScale = MML.Convert.channelVolScale(cfg);
      // VRC7の音色: ボイスモニターで選んだプリセット(@1-@15)。'0'は自作音色=BRRサンプル
      // から推定した@OP<n>をOP<n>+@0で使う(cfg.vrc7Inst。既定@1)
      const vrc7Sel = cfg.vrc7Inst != null ? cfg.vrc7Inst : cfg.tone;
      const vrc7Custom = isVrc7Target && String(vrc7Sel) === '0';
      const vrc7Preset = (isVrc7Target && !vrc7Custom)
        ? Math.max(1, Math.min(15, parseInt(vrc7Sel, 10) || 1)) : null;
      // ピッチエンベロープ(厳密周期ビブラート、DESIGN-PITCH.md Phase 1)。ev.pitchSeq
      // (DSP生ピッチレジスタ、Phase 0で追加済み)をHz経由で借用先チップの生レジスタ
      // 空間へ変換してから分類・登録する(KSS/GBS/HESと同じ「差を取ってから1回だけ
      // 丸める」方針、MML.Convert.rescalePitchSeqFromFreq参照)。ノイズ/DPCMは
      // periodFnForTypeがnullを返すため自動的に対象外になる。
      const n163NumCh = n163UsedCount > 0 ? n163UsedCount : undefined;
      const periodFn = periodFnForType(targetType, n163NumCh);
      // 借用先チップの生周期換算関数(periodFn)自体の増減方向をfitVibratoへ渡す
      // (compiler.jsのperiodFnIncreasingと同じ2点比較、src/convert/pitch.js fitVibrato参照)。
      const directionUp = periodFn ? periodFn(2000) > periodFn(200) : undefined;
      const chEvents = events.map(ev => {
        // ノイズ借用先: NON(ノイズ有効)ボイスはFLGレート→2A03ノイズ周期idxのノートへ。
        // NONでないボイス(旋律サンプルをノイズchへ割り当てた場合)は従来通りpitchSemi。
        const note = (isNoiseTarget && ev.non) ? spcNoiseNoteNum(ev.noiseRate) : ev.pitchSemi;
        const common = {
          start: ev.frame, end: ev.frame + ev.len, note,
          rawFreq: ev.rawFreq,
          envelopeV: hasEnvelope && ev.envelopeIdx !== undefined ? ev.envelopeIdx : undefined,
          envelopeVr: hasEnvelope && ev.envelopeIdx !== undefined ? 0 : undefined,
          volume: !hasVolume ? undefined
            : (cmd.ENV && envCapableType(targetType))
              ? (ev.envelopeIdx !== undefined ? undefined : ev.plainVol)
              : (chVolScale === 0 ? 0 : volStepOf(ev.vol * chVolScale, targetType)),
          // volPct=0のチャンネルは無音なので音程検証(src/convert/verify.js)の対象外にする
          verifySkip: chVolScale === 0 || undefined,
          instrument: (hasInstrument && note !== null && cmd.INST)
            ? (isFdsTarget
                ? fdsWaveReg.assign(waveMode === 'copy' ? getWave(ev.srcn).fds : fixedWave('fds', waveMode))
              : isN163Target
                ? n163WaveReg.assign(waveMode === 'copy' ? getWave(ev.srcn).n163 : fixedWave('n163', waveMode))
              : isVrc7Target ? (vrc7Custom ? 0 : vrc7Preset)
              : dutyIdx)
            : undefined,
          vrc7Tone: (vrc7Custom && note !== null && cmd.INST) ? getOpllToneIdx(ev.srcn) : undefined,
          tieCandidate: ev.tieCandidate,
        };
        if (periodFn && !(isNoiseTarget && ev.non) && ev.pitchSemi !== null && ev.pitchSeq && ev.pitchSeq.length > 0) {
          const tune = tuneOf(ev.srcn);
          const freqSeq = ev.pitchSeq.map(p => pitchRegToFreqHz(p, tune));
          const rescaled = MML.Convert.rescalePitchSeqFromFreq(freqSeq, periodFn);
          // 出力先N163のときだけSA<num>自動選択(pitch.js n163SaForBase参照)。
          // D<n>への同時シフトは後段のdetectChorusDetuneがev.pitchSaを見て行う
          const saOpts = isN163Target && cmd.PITCH_SA !== 'off'
            ? { mode: cmd.PITCH_SA, baseSa: cmd.PITCH_SA === 'octave' ? MML.Convert.n163SaForBase(rescaled[0]) : 0 }
            : undefined;
          MML.Convert.applyPitchAssignment(common, pitchReg.assign(rescaled, directionUp, saOpts));
        }
        // 高速アルペジオ→EN統合(2026-08-14拡張)。mergeSpcVoiceEvents側で検出済みの
        // ev.noteEnvOffsetsを、曲全体で共有するnoteEnvRegへ登録する
        if (ev.noteEnvOffsets) {
          const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
          if (idx != null) common.noteEnv = idx;
        }
        return common;
      });
      // スラー分割(別プロジェクトE、2026-08-12): pitchEp/portamentoが確定した直後に行う
      MML.Convert.markSlurTies(chEvents);
      // デチューン(2026-08-24): 借用先の生周期レジスタ空間でのコーラス検知+D<n>補正。
      // KSSと同じdetectChorusDetune方式(単独ノートの残差は補正せず、複数chの同音同時
      // 発音だけを意図的なデチューンとみなす)。ノイズはperiodFn無しで自動的に対象外。
      // VRC7はEP/MP/PT非対応(periodFn=null)だがD<n>とEN<n>は使える(kss2mmlのopllと同じ)。
      const detuneFn = periodFn || (isVrc7Target ? vrc7FnumRawSpc : null);
      if (detuneFn) detuneEntries.push({ events: chEvents, periodFn: detuneFn });
      scoreChannels.push({ letter: targetLetter, events: chEvents, hasEnvelope, hasVolume,
        hasInstrument, hasVrc7Tone: vrc7Custom, hasDetune: !!detuneFn, hasPitchMod: !!periodFn,
        hasNoteEnv: !!periodFn || isVrc7Target });
    }
    // 全チャンネル横断でコーラス検知+D<n>補正(nsf2mmlと同じ「1回だけまとめて」方式)
    MML.Convert.detectChorusDetune(detuneEntries, detuneEntries.map(e => e.periodFn), { cmd });

    if (dpcmLetter) {
      scoreChannels.push({ letter: dpcmLetter, events: dpcmNoteEvents, hasInstrument: true });
    }

    if (scoreChannels.length > 0) {
      mml += MML.Convert.emitScore(scoreChannels, fpb,
        { totalFrames: FRAMES, tempoBpm: bpm, cmd,
          headerLines: [...fdsWaveReg.defLines(), ...n163WaveReg.defLines(), ...vrc7ToneReg.defLines(),
            ...pitchReg.defLines(), ...noteEnvReg.defLines()] }) + '\n';
    }

    // ── 波形データを options に付加して返す ─────────────────────────
    // fdsWave / n163Wave: 最初に見つかったボイスの波形を採用
    // 波形エディタ表示用に先頭の波形を返す(本文には全波形が@FM/@N定義済み)
    const fdsWave  = fdsWaveReg.waves[0]  || null;
    const n163Wave = n163WaveReg.waves[0] ? n163WaveReg.waves[0].slice() : null;

    // 変換結果の音程検証(src/convert/verify.js): 最終MMLを実コンパイルして
    // 「実際に鳴る音の高さ」を変換元イベントと突き合わせる(失敗しても変換は妨げない)
    const pitchCheck = MML.Convert.verifyPitch
      ? MML.Convert.verifyPitch(mml, scoreChannels, { frameRate: FPS_SPC, totalFrames: FRAMES,
          compileOpts: { dpcmSamples: Object.fromEntries(dmcFiles.map(f => [f.name, f.bytes])) } })
      : null;

    return { mml, dmcFiles, bpm: Math.round(bpm), expansion, expansions: usedExpansions, fdsWave, n163Wave, pitchCheck };
  };

  MML.SPC2MML.fromSpc = function (spcBytes, durationSec, options) {
    const { log, brrSamples, envLog } = MML.SPC2MML.capture(spcBytes, durationSec);
    return MML.SPC2MML.convert(log, brrSamples, Object.assign({ envLog }, options));
  };

})(window);
