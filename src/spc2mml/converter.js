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
  };

  // type → そのチップ内でのチャンネル通し番号(0始まり)。
  // src/mml/compiler.jsのassignExpansionLettersが返す配列のインデックスに対応する。
  const TYPE_TO_CHIP_INDEX = {
    fds: 0,
    vrc6pulse1: 0, vrc6pulse2: 1, vrc6saw: 2,
    mmc5pulse1: 0, mmc5pulse2: 1,
    fme7a: 0, fme7b: 1, fme7c: 2,
    n163_0: 0, n163_1: 1, n163_2: 2, n163_3: 3,
  };

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
  function detectBrrFundamental(brrBytes) {
    const pcm = decodeBrrBytes(brrBytes);
    const L0 = pcm.length;
    if (L0 < 128) return null;
    // アタックの過渡を避けるため少し後ろから、かつ長すぎる場合は上限を設けて定常部を見る
    const start = Math.min(L0 >> 2, 512);
    const end   = Math.min(L0, start + 4000);
    const N = end - start;
    if (N < 128) return null;
    let mean = 0;
    for (let i = start; i < end; i++) mean += pcm[i];
    mean /= N;
    const s = new Float64Array(N);
    for (let i = 0; i < N; i++) s[i] = pcm[start + i] - mean;
    const minLag = 8, maxLag = Math.min(1600, N >> 1);
    let gMax = -Infinity;
    const vals = new Float64Array(maxLag);
    for (let lag = minLag; lag < maxLag; lag++) {
      let sum = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + lag < N; i++) { sum += s[i] * s[i + lag]; e1 += s[i] * s[i]; e2 += s[i + lag] * s[i + lag]; }
      const norm = sum / (Math.sqrt(e1 * e2) || 1);
      vals[lag] = norm;
      if (norm > gMax) gMax = norm;
    }
    if (gMax <= 0) return null;
    const thr = 0.9 * gMax;
    let period = -1;
    for (let lag = minLag + 1; lag < maxLag - 1; lag++) {
      if (vals[lag] > thr && vals[lag] >= vals[lag - 1] && vals[lag] >= vals[lag + 1]) { period = lag; break; }
    }
    if (period < 1) return null;
    return { freq: DSP_RATE / period, conf: gMax };
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
      const f = detectBrrFundamental(brr.bytes);
      if (f && f.conf >= FUNDAMENTAL_CONF_MIN && f.freq > 0) {
        tune[srcn] = 12 * Math.log2(f.freq / REFERENCE_HZ);
      }
    }
    return tune;
  }
  MML.SPC2MML.computeSrcnFineTune = computeSrcnFineTune;
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
      if (startAddr === 0) break;
      const brrBytes = [];
      let addr = startAddr;
      for (let blk = 0; blk < 4096; blk++) {
        const header = player.ram[addr & 0xFFFF];
        for (let b = 0; b < 9; b++) brrBytes.push(player.ram[(addr + b) & 0xFFFF]);
        if (header & 1) break;
        addr += 9;
      }
      brrSamples[srcn] = { startAddr, bytes: new Uint8Array(brrBytes) };
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

    let frame = 0, samplesInFrame = 0;
    player.dsp.onWrite = (reg, val) => {
      if (frame < frames) frameLog[frame].push({ reg: reg & 0x7F, val });
    };

    for (let s = 0; s < totalDspSamples; s++) {
      samplesInFrame++;
      player.renderSample();
      if (samplesInFrame >= SAMPLES_PER_FRAME) { samplesInFrame = 0; frame++; }
    }

    return { log: frameLog, brrSamples: _collectBrrSamples(player), frameRate: FPS_SPC };
  };

  // captureの非同期チャンク版。SPCは事前レンダリングを持たない完全リアルタイム合成
  // フォーマットのため、ピアノロールの先読み表示はこの関数で裏キャプチャした結果を使う
  // (src/emulator/kssPlayer.js の captureKssSongAsync と同じ「一定量ごとにイベント
  // ループへ制御を返す」パターン)。onProgressにはその時点までのframeLog(同一配列参照、
  // 伸びていく)も渡すので、キャプチャ完了を待たずに途中経過だけでピアノロールを段階的に
  // 埋めていける。戻り値はcapture()と同じ { log, brrSamples } 形。
  MML.SPC2MML.captureAsync = async function (spcBytes, durationSec, onProgress, shouldCancel) {
    const player  = new MML.Emu.SpcPlayer(spcBytes);
    const totalDspSamples = Math.round(durationSec * DSP_RATE);
    const frames  = Math.ceil(totalDspSamples / SAMPLES_PER_FRAME);
    const frameLog = Array.from({ length: frames }, () => []);
    _seedInitialFrame(frameLog, spcBytes);

    let frame = 0, samplesInFrame = 0;
    player.dsp.onWrite = (reg, val) => {
      if (frame < frames) frameLog[frame].push({ reg: reg & 0x7F, val });
    };

    const CHUNK_FRAMES = 10; // 実再生とメインスレッドを共有するため細かめにyieldする
    let framesSinceYield = 0;
    for (let s = 0; s < totalDspSamples; s++) {
      samplesInFrame++;
      player.renderSample();
      if (samplesInFrame >= SAMPLES_PER_FRAME) {
        samplesInFrame = 0;
        frame++;
        if (++framesSinceYield >= CHUNK_FRAMES) {
          framesSinceYield = 0;
          if (onProgress) onProgress(frame, frames, frameLog);
          await new Promise((resolve) => setTimeout(resolve, 0));
          // 曲切替/停止の連打で先読みキャプチャが何本も積み上がりCPUを食い合うのを防ぐため、
          // 呼び出し元から「もう不要」と言われたらここでループ自体を打ち切る(onProgress側だけ
          // 無視してもエミュレーション自体は最後まで回り続けてしまうため不十分だった)。
          if (shouldCancel && shouldCancel()) {
            return { log: frameLog, brrSamples: _collectBrrSamples(player), frameRate: FPS_SPC };
          }
        }
      }
    }
    if (onProgress) onProgress(frames, frames, frameLog);

    return { log: frameLog, brrSamples: _collectBrrSamples(player), frameRate: FPS_SPC };
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
      // pitchSeq(DESIGN-PITCH.md Phase 0): 確定済みセグメントのフレーム毎生ピッチレジスタ値。
      let activePitchSeq = [];
      // pendingTieCandidate(別プロジェクトE、2026-08-12): 次にpushされるイベントが
      // 「純粋な音程変化のみ」による区切りで始まったか(=スラー分割のタイ候補か)を
      // 一時保持する。KON(本物のアタック)/KOFF後の再開時はfalseにリセットする。
      let pendingTieCandidate = false;

      for (let f = 0; f < FRAMES; f++) {
        for (const { reg, val } of log[f]) {
          const vc = reg >> 4, r = reg & 0x0F;
          if (vc !== ch) continue;
          voiceDsp[r] = val;
        }
        const curPitch = voiceDsp[0x02] | ((voiceDsp[0x03] & 0x3F) << 8);
        // 音程比較・区切りは、現在鳴っているノートのサンプル(activeSrcn)の補正で統一する
        // (1音符の間 srcn は不変なので curPitch/activePitch とも同じ補正を使えばよい)。
        const curPitchSemi = pitchToSemitone(curPitch, tuneOf(activeSrcn));
        const activePitchSemi = pitchToSemitone(activePitch, tuneOf(activeSrcn));

        if (konLatched[f] & (1 << ch)) {
          if (activeStart >= 0) {
            voiceEvents[ch].push({ frame: activeStart, len: f - activeStart, pitch: activePitch, pitchSemi: activePitchSemi, srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
          }
          activePitch = curPitch;
          activeSrcn  = voiceDsp[0x04];
          activeAdsr1 = voiceDsp[0x05];
          activeAdsr2 = voiceDsp[0x06];
          activeGain  = voiceDsp[0x07];
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
          voiceEvents[ch].push({ frame: activeStart, len: f - activeStart, pitch: activePitch, pitchSemi: activePitchSemi, srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
          activePitch = curPitch;
          activeSrcn  = voiceDsp[0x04];
          activeAdsr1 = voiceDsp[0x05];
          activeAdsr2 = voiceDsp[0x06];
          activeGain  = voiceDsp[0x07];
          activeStart = f;
          activePitchSeq = [curPitch];
          pendingTieCandidate = true; // このイベントを閉じたのは純粋な音程変化 → 次のイベントはタイ候補
        } else if (activeStart >= 0) {
          activePitchSeq.push(curPitch);
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
            voiceEvents[ch].push({ frame: activeStart, len: Math.max(1, f - activeStart), pitch: activePitch, pitchSemi: pitchToSemitone(activePitch, tuneOf(activeSrcn)), srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
            activeStart = -1;
            activePitchSeq = [];
            pendingTieCandidate = false; // KOFF後、次に始まるノートは新規アタックなのでタイ候補ではない
          }
        }
      }
      if (activeStart >= 0) {
        voiceEvents[ch].push({ frame: activeStart, len: Math.max(1, FRAMES - activeStart), pitch: activePitch, pitchSemi: pitchToSemitone(activePitch, tuneOf(activeSrcn)), srcn: activeSrcn, adsr1: activeAdsr1, adsr2: activeAdsr2, gain: activeGain, pitchSeq: activePitchSeq, tieCandidate: pendingTieCandidate });
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
        pitchSeq: ev.pitchSeq, srcn: ev.srcn, adsr1: ev.adsr1, adsr2: ev.adsr2, gain: ev.gain,
        tieCandidate: ev.tieCandidate
      });
    }
    // 高速アルペジオ→EN統合(2026-08-14拡張)。登録(noteEnvReg.registerShape)は
    // 呼び出し元のfromSpcがpitchRegと同じタイミングで曲全体共有のnoteEnvRegを使って
    // 行う(ay.js/scc.js/opll.jsと同じ「検出はここ、登録は呼び出し元」の遅延登録方式)。
    return MML.Convert.mergeVibratoAndArpeggio(mapped)
      .filter(ev => ev.note != null)
      .map(ev => Object.assign({
        frame: ev.start, len: ev.end - ev.start, pitch: ev.pitch, pitchSemi: ev.note,
        srcn: ev.srcn, adsr1: ev.adsr1, adsr2: ev.adsr2, gain: ev.gain, pitchSeq: ev.pitchSeq,
        tieCandidate: ev.tieCandidate
      }, ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}));
  }

  // ── MML 生成 ─────────────────────────────────────────────────────────
  MML.SPC2MML.convert = function (log, brrSamples, options = {}) {
    const FRAMES = log.length;

    // デフォルトマップ: V0→A, V1→B ... V3→D, V4→スキップ
    const DEFAULT_TYPES = ['pulse1','pulse2','triangle','noise','skip','skip','skip','skip'];
    const channelMap = options.channelMap || DEFAULT_TYPES.map(t => ({ type: t }));

    // 各BRRサンプルの実測原音から音程補正マップを作り、ノート抽出に反映する
    // (これにより実機の発音音程=SPC再生と一致する)。
    const srcnFineTune = computeSrcnFineTune(brrSamples);
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    const tuneOf = (srcn) => srcnFineTune ? (srcnFineTune[srcn] || 0) : 0;
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14拡張)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry();

    // ── BPM (未指定ならマッピング済みチャンネルの有音イベントから自動検出、
    //         指定時もフレームグリッドへ吸着補正) ──
    // 音長(len)に加え、チャンネル毎の発音開始間隔(IOI)も検出材料にする。
    // IOIはゲートタイムで音符が短く切られてもグリッドに乗るため頑健。
    const noteDurations = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;
      const sounding = voiceEvents[ch].filter(ev => ev.pitchSemi !== null);
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

    // ── ADSR/GAIN → ppmck @v/@vr テーブル抽出 (2A03 pulse/noise のみ対象) ──
    // 同じ (adsr1,adsr2,gain) の組み合わせは同じ音色とみなし @vN を共有する。
    // リリースは実機的に音色非依存の固定カーブなので曲全体で @vr0 を1つだけ使う。
    const ENV_CAPABLE_TYPES = new Set(['pulse1', 'pulse2', 'noise']);
    const MAX_ENV_FRAMES = 180; // 約3秒分まで机上シミュレート
    const envelopeIndexByKey = new Map();
    const envelopeTables = [];
    let usesReleaseTable = false;

    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || !ENV_CAPABLE_TYPES.has(cfg.type)) continue;
      for (const ev of voiceEvents[ch]) {
        if (ev.pitchSemi === null) continue;
        const key = `${ev.adsr1},${ev.adsr2},${ev.gain}`;
        let idx = envelopeIndexByKey.get(key);
        if (idx === undefined) {
          idx = envelopeTables.length;
          envelopeIndexByKey.set(key, idx);
          envelopeTables.push({ index: idx, values: simulateSpcEnvelope(ev.adsr1, ev.adsr2, ev.gain, MAX_ENV_FRAMES) });
        }
        ev.envelopeIdx = idx;
        usesReleaseTable = true;
      }
    }
    const releaseTable = usesReleaseTable ? simulateSpcRelease(MAX_ENV_FRAMES) : null;

    // ── 拡張音源を確定 ───────────────────────────────────────────────
    let expansion = 'none';
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip' || cfg.type === 'dpcm') continue;
      const exp = TYPE_TO_EXPANSION[cfg.type];
      if (exp) { expansion = exp; break; } // 最初に見つかった拡張を使用
    }

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
    const dpcmSrcns = new Set();
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type !== 'dpcm') continue;
      for (const ev of voiceEvents[ch]) dpcmSrcns.add(ev.srcn);
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
    dpcmNoteEvents.sort((a, b) => a.start - b.start);

    // DPCM/拡張音源のチャンネル文字は、src/mml/compiler.jsのassignExpansionLettersを
    // そのまま再利用して決める(実機ppmck同様、各チップの文字範囲は他チップの有無に
    // 関わらず完全固定。EXPANSION_PRIORITY = dpcm,fds,vrc7,vrc6,n163,fme7,mmc5)。
    // これによりコンパイル時に実際に割り当てられる文字と一致する。
    const usesDpcm = dpcmNoteEvents.length > 0;
    const letterExpansions = [
      ...(usesDpcm ? ['dpcm'] : []),
      ...(expansion !== 'none' ? [expansion] : []),
    ];
    const expansionLetterMap = MML.Mml.assignExpansionLetters(letterExpansions);
    const dpcmLetter = usesDpcm ? expansionLetterMap.dpcm[0] : null;
    const expansionLetters = expansion !== 'none' ? expansionLetterMap[expansion] : null;

    // ── FDS/N163 波形をボイスごとに生成 ────────────────────────────
    // 同じ srcn でも複数ボイスが使う場合は先頭ボイスの波形を採用
    const waveCache = {}; // srcn → { fds: [], n163: [] }
    function getWave(srcn) {
      if (waveCache[srcn]) return waveCache[srcn];
      const brr = brrSamples[srcn];
      const pcm = brr && brr.bytes.length > 0 ? decodeBrrBytes(brr.bytes) : new Float32Array([0]);
      waveCache[srcn] = { fds: pcmToFdsWave(pcm), n163: pcmToN163Wave(pcm) };
      return waveCache[srcn];
    }

    // ── MML 生成 ─────────────────────────────────────────────────────
    let mml = `; SPC → MML 変換 (${Math.round(bpm)} BPM, ${FRAMES} フレーム, 分解能480TPQN)\n`;
    if (expansion !== 'none') mml += `; 拡張音源: ${expansion}\n`;
    // #EX-*(機能する本文ディレクティブ。上の`; `コメントとは別。これがないと
    // MML本文だけからは拡張音源が有効にならず、UI側の操作が必要になってしまう)
    if (expansion !== 'none') {
      mml += expansion === 'n163'
        ? `${MML.Mml.EX_CHIP_DIRECTIVE[expansion]} ${expansionLetters.length}\n`
        : `${MML.Mml.EX_CHIP_DIRECTIVE[expansion]}\n`;
    }

    // @DPCM<n>定義(実機ppmckcと同じ書式)。以後Eチャンネルの音符で@<n>により選択する
    for (let i = 0; i < dmcFiles.length; i++) {
      const f = dmcFiles[i];
      mml += `@DPCM${i} = { "${f.name}", ${f.rateIndex}, ${f.bytes.length}, 255, 0 }\n`;
    }

    // FDS/N163 波形コメント (波形データは別途コンパイラオプションで渡す)
    const waveVoices = []; // { ch, srcn, type }
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg) continue;
      const isFds  = cfg.type === 'fds';
      const isN163 = cfg.type && cfg.type.startsWith('n163');
      if (isFds || isN163) {
        const srcn = voiceEvents[ch][0]?.srcn ?? 0;
        waveVoices.push({ ch, srcn, type: cfg.type });
      }
    }

    // ADSR/GAIN由来の音量エンベロープ定義 (@vN / @vr0)
    for (const { index, values } of envelopeTables) {
      mml += `@v${index} = { ${values.join(' ')} }\n`;
    }
    if (releaseTable) {
      mml += `@vr0 = { ${releaseTable.join(' ')} }\n`;
    }

    mml += '\n';

    // チャンネルごとの共通イベント形式を組み立て、最後にまとめて
    // 小節揃えスコア形式(1曲まるごと1回のemitScore呼び出し)で出力する。
    const scoreChannels = [];
    for (let ch = 0; ch < 8; ch++) {
      const cfg = channelMap[ch];
      if (!cfg || cfg.type === 'skip') continue;

      const events = voiceEvents[ch];
      if (events.length === 0) continue;

      const targetType = cfg.type;

      // DPCMは全ボイス分をdpcmNoteEventsに一本化済みなのでここではスキップ
      // (ループの外で1回だけscoreChannelsに追加する)
      if (targetType === 'dpcm') continue;

      const chipIndex = TYPE_TO_CHIP_INDEX[targetType];
      const targetLetter = TYPE_TO_LETTER[targetType]
        || (expansionLetters && chipIndex !== undefined ? expansionLetters[chipIndex] : undefined);
      if (!targetLetter) continue;

      const hasEnvelope = ENV_CAPABLE_TYPES.has(targetType);
      // ピッチエンベロープ(厳密周期ビブラート、DESIGN-PITCH.md Phase 1)。ev.pitchSeq
      // (DSP生ピッチレジスタ、Phase 0で追加済み)をHz経由で借用先チップの生レジスタ
      // 空間へ変換してから分類・登録する(KSS/GBS/HESと同じ「差を取ってから1回だけ
      // 丸める」方針、MML.Convert.rescalePitchSeqFromFreq参照)。ノイズ/DPCMは
      // periodFnForTypeがnullを返すため自動的に対象外になる。
      const n163NumCh = expansion === 'n163' ? expansionLetters.length : undefined;
      const periodFn = periodFnForType(targetType, n163NumCh);
      const chEvents = events.map(ev => {
        const common = {
          start: ev.frame, end: ev.frame + ev.len, note: ev.pitchSemi,
          envelopeV: hasEnvelope && ev.envelopeIdx !== undefined ? ev.envelopeIdx : undefined,
          envelopeVr: hasEnvelope && ev.envelopeIdx !== undefined ? 0 : undefined,
          tieCandidate: ev.tieCandidate,
        };
        if (periodFn && ev.pitchSemi !== null && ev.pitchSeq && ev.pitchSeq.length > 0) {
          const tune = tuneOf(ev.srcn);
          const freqSeq = ev.pitchSeq.map(p => pitchRegToFreqHz(p, tune));
          const rescaled = MML.Convert.rescalePitchSeqFromFreq(freqSeq, periodFn);
          MML.Convert.applyPitchAssignment(common, pitchReg.assign(rescaled));
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
      scoreChannels.push({ letter: targetLetter, events: chEvents, hasEnvelope, hasPitchMod: !!periodFn, hasNoteEnv: !!periodFn });
    }

    if (dpcmLetter) {
      scoreChannels.push({ letter: dpcmLetter, events: dpcmNoteEvents, hasInstrument: true });
    }

    if (scoreChannels.length > 0) {
      mml += MML.Convert.emitScore(scoreChannels, fpb,
        { totalFrames: FRAMES, tempoBpm: bpm, headerLines: [...pitchReg.defLines(), ...noteEnvReg.defLines()] }) + '\n';
    }

    // ── 波形データを options に付加して返す ─────────────────────────
    // fdsWave / n163Wave: 最初に見つかったボイスの波形を採用
    let fdsWave  = null;
    let n163Wave = null;
    for (const { ch, srcn, type } of waveVoices) {
      const w = getWave(srcn);
      if (type === 'fds'  && !fdsWave)  fdsWave  = w.fds;
      if (type.startsWith('n163') && !n163Wave) n163Wave = w.n163;
    }

    return { mml, dmcFiles, bpm: Math.round(bpm), expansion, fdsWave, n163Wave };
  };

  MML.SPC2MML.fromSpc = function (spcBytes, durationSec, options) {
    const { log, brrSamples } = MML.SPC2MML.capture(spcBytes, durationSec);
    return MML.SPC2MML.convert(log, brrSamples, options);
  };

})(window);
