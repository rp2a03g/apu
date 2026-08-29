/*
 * HES ストリーミング再生プレイヤー
 * MML.Audio.HesStreamPlayer / MML.Audio.HesReplayStreamPlayer / MML.Audio.HesBufferedPlayer
 *
 * ★現在の結論(2026-08): HesReplayStreamPlayer(GBS/KSSと同じ、バックグラウンドの
 * regsOnlyキャプチャ[hesPlayer.js captureHesSongAsync]が先読みで作るスナップショットを
 * 再生時にAPUへ書き戻すだけの軽量方式)を使う。他の2クラス(HesStreamPlayer=CPU駆動の
 * リアルタイム合成、HesBufferedPlayer=事前一括レンダリング)は定義だけ残しているが未使用。
 * どちらも「重い」「鍵盤表示に出ない」等の問題を解消しきれず不採用になった経緯がある
 * (詳しくはgit履歴参照。要点: HESは他フォーマットと違いPLAYが無くCPU命令列を実時間で
 * 回し続ける設計のため、CPU駆動のリアルタイム合成は構造的に重い。事前一括レンダリングは
 * 軽いが「レンダリング完了まで再生できない」トレードオフが許容されなかった)。
 * HesReplayStreamPlayerはGBS/KSSと同じく、先読みが埋めた範囲まで再生開始を待たずに
 * 進められ(NsfReplayStreamPlayer/main.js playNsfStream()と同じ「バックグラウンド
 * キャプチャの配列を再生側と共有し、埋まった分だけ再生する」設計)、メインスレッドの
 * 負荷もAPUクロックのみで軽い。
 *
 * ★PCM(DDA)対応について: DDA(PSGの直接D/A書込み、$0806への高頻度な生値書込みで
 * ソフトウェアPCMを実現するモード)は、フレーム単位のスナップショットだけでは
 * 高頻度書込みを取りこぼす。クリップ検出+重複排除+DMCエンコード/デコードを挟む方式も
 * 試したが、これは「CPU駆動でライブ再生していた時の音」とは別物になってしまう
 * (不可逆変換を経由するため)。最終的に、hesPlayer.js captureHesSongAsyncが記録する
 * 生のdpcmTrace(ch別・書込み順の$0806書込み値そのもの)を、クリップ化せず
 * そのままのタイミングでAPUのdacへ再生時に書き戻す方式にした(HesReplayStreamPlayer
 * 内のコメント参照)。CPU再実行は不要なまま、書込まれた生の値の並びを忠実に再現できる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE = 4096;
  const DDA_HIST_LEN = 512; // 鍵盤表示のPCM周期検出用の履歴バッファ長(HesReplayStreamPlayer参照)

  // 無音自動送り(HesReplayStreamPlayer)用。src/audio/stream-player.jsの同名定数と同じ考え方。
  const SILENCE_SEC = 10;
  const SILENCE_EPS = 1e-4;

  // gainNode(4.0)の後段にリミッタ(DynamicsCompressorNode)を挟み、DDA(PCM)chの
  // on/off切替のような急激な信号の段差でDCブロッキングフィルタ(y=raw-dcPrevX+0.999*dcPrevY)
  // が過渡的にオーバーシュートし、そこへgain4.0が掛かって±1.0を超えハードクリップする
  // のを防ぐ(src/audio/stream-player.js createLimiter()と同じ考え方・同じ設計)。
  // ★実測(TP03018.hes index77): ch4の波形表示が「崩れて聴こえる」というユーザー報告の
  // 実体はch4自体のバグではなく、ch5がDDA(190000回超の$0806書込み)とトーンを頻繁に
  // 切り替える曲でのクリップ歪みだった。実際にHesReplayStreamPlayerの出力サンプルを
  // 測定したところ、ch5のDDA on/off遷移の直後のフレームでgain適用後|y|>1.0となる
  // クリップが124フレーム分(3604フレーム中)発生しており、遷移フレームと1対1に近い形で
  // 一致していた。ユーザーが「変化の際ノイズ出てる」と報告した内容と一致する。
  function createLimiter(audioCtx) {
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0; // dB: 出力段が0dBFSに達する手前から効かせる
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

  // 直近の値変化履歴(circular buffer、古い→新しい順に並べ替え済みの配列を渡す)から
  // 自己相関で基本周期を検出し、その1周期ぶんの値配列を返す。周期が見つからない
  // (無音・打楽器的な過渡音等)場合はnullを返す(呼び出し側でフォールバックする)。
  // 波形メモリ(N163/FDS等、固定長)と違いPCMには決まった長さが無いため、検出できた
  // 周期の長さをそのまま可変長で返す設計にしている(ユーザー指摘: 固定32要素は
  // 波形メモリ表示の流用に過ぎず、PCMの実態に合っていなかった)。
  // ★しきい値は実際の(多少ノイズの乗った)PCMでも「だいたい周期的」なら拾えるよう
  // 緩めにしてある(2026-08、ユーザー実測: 元の厳しい閾値では実ファイルのほとんどが
  // 周期無し判定になりフォールバック表示ばかりになっていた)。
  function detectPcmPeriod(buf) {
    const n = buf.length;
    const minLag = 2, maxLag = Math.min(160, Math.floor(n / 3));
    if (maxLag <= minLag) return null;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    // ほぼ無音(振幅が無い)なら周期性を主張しない
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (buf[i] - mean) * (buf[i] - mean);
    variance /= n;
    if (variance < 0.5) return null;

    // 正規化二乗差分(YIN法に近い考え方): 値が小さいほど「lagだけずらしても波形が
    // よく似ている」= その長さが周期の可能性が高い。最初の極小(最初にある閾値を
    // 下回った点)を採用することで、周期の整数倍を誤検出しにくくする。
    let bestLag = -1, bestScore = Infinity;
    const scores = new Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      const count = n - lag;
      for (let i = lag; i < n; i++) { const d = buf[i] - buf[i - lag]; sum += d * d; }
      const normalized = sum / count / variance; // 0に近いほど良い一致
      scores[lag] = normalized;
      if (normalized < bestScore) { bestScore = normalized; bestLag = lag; }
    }
    // 最良の一致が十分に良くなければ(過渡音・打楽器等、真に周期性が無い)周期無しとする
    if (bestLag < 0 || bestScore > 0.45) return null;
    return bestLag;
  }

  // 表示用の軽い平滑化(3タップ移動平均、両端は縮退)。PCMは離散値が変化するたびに
  // そのまま次の値へ直線で繋ぐと角ばった階段状に見える(NSFのDMC表示はデルタ変調
  // [1ビットあたり最大±2/127]のなだらかな追従カーブなので滑らかに見える、との比較で
  // ユーザー指摘)。実機のRCフィルタ的な追従を簡易的に模し、見た目を滑らかにする。
  function smoothWave(arr) {
    if (arr.length < 3) return arr;
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const prev = arr[(i - 1 + arr.length) % arr.length];
      const next = arr[(i + 1) % arr.length];
      out[i] = (prev + arr[i] * 2 + next) / 4;
    }
    return out;
  }

  class HesStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.node = null;
      this.gainNode = null;
      this.player = null;
      this.frameBuffer = null;
      this.frameOffset = 0;
      this.totalFrames = 0;
      this.currentFrame = 0;
      this.dcPrevX = 0;
      this.dcPrevY = 0;
      this.isPlaying = false;
      this.onEnded = null;
      this._samplePos = 0;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 4.0;
      this.gainNode.connect(MML.Audio.getMasterGain(this.audioCtx));

      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.connect(this.gainNode);

      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        if (!this.player || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    _fill(out) {
      let outPos = 0;
      while (outPos < out.length) {
        if (!this.frameBuffer || this.frameOffset >= this.frameBuffer.length) {
          if (this.totalFrames > 0 && this.currentFrame >= this.totalFrames) {
            out.fill(0, outPos);
            this.isPlaying = false;
            if (this.onEnded) this.onEnded();
            return;
          }
          this.frameBuffer = this.player.renderFrame(this.audioCtx.sampleRate);
          this.frameOffset = 0;
          this.currentFrame++;
        }
        const toCopy = Math.min(this.frameBuffer.length - this.frameOffset, out.length - outPos);
        for (let i = 0; i < toCopy; i++) {
          const raw = this.frameBuffer[this.frameOffset + i];
          const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
          this.dcPrevX = raw; this.dcPrevY = y;
          out[outPos + i] = y;
        }
        outPos += toCopy;
        this.frameOffset += toCopy;
        this._samplePos += toCopy;
      }
    }

    load(hesBytes, track, totalFrames, mute) {
      this.stop();
      this.player = new MML.Emu.HesPlayer(hesBytes);
      this._track = track;
      this.player.initSong(track);
      this.totalFrames = totalFrames;
      this.currentFrame = 0;
      this.frameBuffer = null;
      this.frameOffset = 0;
      this._samplePos = 0;
      this.dcPrevX = this.dcPrevY = 0;
      if (mute) this.applyMute(mute);
    }

    play() { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    setSpeed(factor) { if (this.player) this.player.speedFactor = factor; }

    stop() {
      this.isPlaying = false;
      if (this.player) this.player.initSong(this._track || 0);
      this.frameBuffer = null;
      this.frameOffset = 0;
      this.currentFrame = 0;
      this._samplePos = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    // keyboardDisplay.getMuteConfig()と同じ{apu:{},expansion:{hes:{ch0..ch5}}}形式
    applyMute(mute) {
      if (!mute || !this.player) return;
      const exp = mute.expansion || mute;
      if (exp.hes) Object.assign(this.player.apu.mute, exp.hes);
    }

    getPosition() { return this._samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.totalFrames / this.player.frameRate; }

    destroy() {
      this.isPlaying = false;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      this.player = null;
      this.frameBuffer = null;
    }
  }

  // =========================================================
  // HesReplayStreamPlayer
  // =========================================================
  class HesReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx      = audioCtx;
      this.node          = null;
      this.gainNode      = null;
      this.apu           = null;
      this.player        = this; // liveHesXxx系ヘルパーが player.apu 形状を前提にする場合に備えた自己参照
      this.header        = null;
      this.snapshots     = null;
      this.totalFrames   = 0;
      this.frameRate     = 60;
      this.clockHz       = 0;
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this.cycleAccum    = 0;
      this.speedFactor   = 1;
      this._songFramePos = 0;
      // DCブロッキングフィルタの状態はL/Rで混ざるとクロストークになるためチャンネル毎に分離する
      this.dcPrevXL      = 0; this.dcPrevYL = 0;
      this.dcPrevXR      = 0; this.dcPrevYR = 0;
      this.isPlaying     = false;
      this.onEnded       = null;
      this.onSilenceTimeout = null;
      // 無音自動送り用の先読みスキャン状態(NsfReplayStreamPlayerと同じ設計、
      // src/audio/stream-player.js scanSilenceStep冒頭コメント参照)。DDAの生トレース
      // (ddaTrace、下記コメント参照)はフレーム単位のスナップショットへ既に反映済みの
      // dac値をそのまま使う簡略版とし、_fill()側のサンプル単位上書きまでは複製しない
      // (無音判定にはこれで十分。DDA発音中はスナップショットのdacがフレームごとに
      // 変化し続けるため、単純な近似でも「無音ではない」とは正しく判定できる)。
      this._silenceFired    = false;
      this._silenceScanFrame = -1;
      this._scanDone         = false;
      this._scanApu = null;
      this._scanFrame = -1;
      this._scanSongFramePos = 0;
      this._scanCycleAccum = 0;
      this._scanDcPrevXL = 0; this._scanDcPrevYL = 0;
      this._scanDcPrevXR = 0; this._scanDcPrevYR = 0;
      this._scanSilentRun = 0;
      // ★2026-08 PCM(DDA)対応、3度目の設計。
      // 第1版: 生の5bitサンプルを自作の簡易ゲイン式で直接再生 → 音が違う。
      // 第2版: hes2mml変換と同じ@DPCM<n>抽出(クリップへ重複排除→MML.Dpcm.encode()で
      //   NSF実機DMC形式へエンコード→decode()で復号して再生)を再利用 → これも「以前
      //   (CPU駆動のHesStreamPlayerでライブ再生していた時)の音」とは別物だった
      //   (ユーザー実測)。加えてDDAchを常時off扱いにしてapu.mixSample()から外していた
      //   ため、ライブAPU状態を見る鍵盤表示にも一切現れなくなっていた。
      // 根本原因: クリップ検出・重複排除・DMC(1bitデルタ変調)エンコードはどれも
      //   「元の生波形からの不可逆な変換」であり、CPU駆動再生(=書込まれた生の値を
      //   その場でそのまま出力するだけ)とは原理的に別の音になる。MML変換(@DPCM<n>)は
      //   NSF実機のDMCハードウェアという別チップに載せ替えるための変換なので不可逆で
      //   構わないが、ネイティブ再生はHES実機そのものの音を目指すべきで、変換を挟む
      //   理由が無い。
      // 第3版(今回): dpcmTrace(hesPlayer.js captureHesSongAsync が記録する、ch別・
      //   書込み順の生の$0806書込み値)を「クリップ」に加工せず、そのままのタイミングで
      //   ライブAPUのdacへ再生時に書き戻す。1フレーム(1/60秒)内に複数件あるトレースは
      //   フレーム内の経過割合に応じて均等に割り振る(正確な書込みタイミングまでは
      //   記録していないための近似だが、CPU再実行が不要なままCPU駆動再生とほぼ同じ
      //   生値の並びを再現できる)。DDAchも他ch同様に毎フレームスナップショットから
      //   通常通り状態復元するため、鍵盤表示にも普通に反映される。
      this.ddaChannel      = -1;   // DDAとして扱うPSG ch番号(-1=未検出/PCM無し曲)
      this.ddaTrace        = null; // [{frame, value}](書込み順、hesPlayer.js dpcmTrace[ch]そのまま)
      this._ddaTracePos    = 0;    // ddaTrace内の消費済み位置
      this._ddaFrameEntries = null; // 現在フレーム分の値配列
      // 鍵盤表示用: DDAchはc.wave(波形メモリ)がDDA突入前の内容で固まったまま更新されず
      // 実際のPCM波形と無関係になってしまう(PsgChannel.writeData()参照、DDAモード中は
      // wavePos/waveへは一切書かずdacだけを更新するため)。実際に鳴っている波形を
      // 見せるため、直近のdac値(変化した時だけ)を独立したリングバッファに記録する。
      // ★ユーザー指摘: 波形メモリ表示(N163/FDS等)を無批判に流用して固定32要素に
      // していたが、PCMには波形メモリのような固定長という概念が無い。実際の音の
      // 周期性を自己相関で検出し、その1周期ぶんだけを可変長で返す(getDdaWave参照)。
      // 履歴バッファ(DDA_HIST_LEN)は検出可能な周期の上限を確保するため32よりだいぶ大きく取る。
      this._ddaWaveBuf = new Uint8Array(DDA_HIST_LEN).fill(16); // 16=中央値(無音相当)で初期化
      this._ddaWavePos = 0;
      this._ddaWaveCount = 0; // これまでに記録した総件数(DDA_HIST_LENに達するまでの充填判定用)
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      // ★4.0のままだと、リミッタを足してもDDA(PCM) on/off遷移直後のDCブロッキング
      // フィルタのオーバーシュートがリミッタの追従(attack=0.001s)を振り切って
      // ±1.0を超えることがある(実測: TP03018.hes index77で60秒中131サンプルがクリップ)。
      // 2.5まで下げるとリミッタと合わせて同じ60秒間で一度もクリップしなかった
      // (実測: maxAbs=0.966)。DDAを使わない曲の体感音量はリミッタの底上げでほぼ保たれる。
      // ★2026-08 SPCを基準に全フォーマットの体感音量を実測(RMS)揃え、1.65へさらに調整
      // (src/audio/stream-player.js NsfReplayStreamPlayer冒頭コメント参照。クリップ耐性は
      // 2.5より下げるほど有利になる方向なので上記の対策と両立する)。
      this.gainNode.gain.value = 1.65;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(this.audioCtx));

      // $0805(chバランス)/$0801(全体バランス)を反映するため2ch(ステレオ)出力にする
      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 2);
      this.node.connect(this.gainNode);

      this.node.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        if (!this.apu || !this.isPlaying) { outL.fill(0); outR.fill(0); return; }
        this._fill(outL, outR);
      };
    }

    _buildApu() {
      this.apu = new MML.Emu.APUHuC6280();
      if (this._lastMute) this.applyMute(this._lastMute);
      if (this._lastVolume) this.applyVolume(this._lastVolume);
    }

    load(hesBytes, track, totalFrames, capture, mute) {
      this.stop();
      this.header = MML.HES.parseHeader(hesBytes);
      this.frameRate = MML.HES.VBLANK_FPS;
      this.clockHz = MML.HES.PSG_CLOCK; // APUクロック基準(hesPlayer.jsのpsgTickAccumと同じ比)
      this.snapshots = capture.snapshots;
      this.totalFrames = totalFrames;
      this._buildApu();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      this.ddaChannel = -1; this.ddaTrace = null; this._ddaTracePos = 0; this._ddaFrameEntries = null;
      if (mute) this.applyMute(mute);
      this._resetScan(0);
    }

    // main.jsがバックグラウンドキャプチャの進捗ごと(ロール再構築と同じタイミング)に
    // hesPlayer.js captureHesSongAsync が記録した生のdpcmTrace/controlTraceから
    // 「どのchがDDA(PCM)か」「そのchの生の書込み値列」を渡し直す(冒頭コメント参照)。
    // チャンネル選定だけはMML.Hes2MmlExpansion.extractDdaClips()のロジックを流用する
    // (曲全体でDDA区間が最も長い1chを選ぶ、という判定自体はhes2mml変換と共通でよいため)。
    setDdaChannel(channel, trace) {
      this.ddaChannel = channel != null ? channel : -1;
      this.ddaTrace = trace || null;
      this._ddaTracePos = 0;
      this._ddaFrameEntries = null;
      // 現在の再生位置より前のトレースはスキップする(再トリガー/巻き戻り防止)
      if (this.ddaTrace) {
        while (this._ddaTracePos < this.ddaTrace.length && this.ddaTrace[this._ddaTracePos].frame < this.currentFrame) this._ddaTracePos++;
      }
    }

    _isFrameReady(f) { return !!(this.snapshots && this.snapshots[f]); }

    // スナップショットの値をライブAPUのチャンネルへ直接書き戻す(wavePos/lfsr等の位相は
    // ここでは触らずclock()の自然な進行に任せる。gbs-stream-player.jsと同じ考え方)。
    // DDAchも他ch同様に通常通り復元する(鍵盤表示にも普通に反映されるようにするため。
    // 冒頭コメント参照)。dacの値だけは、この後_fill()側でこのフレーム分の生トレースを
    // 使ってサンプル単位に細かく上書きする(フレーム単位のsc.dacは1フレームに1回しか
    // 変化を捉えられず粗すぎるため)。
    _applyFrame(f) {
      this.currentFrame = f;
      this._applySnapshotTo(this.apu, this.snapshots[f]);
      this._prepDdaFrame(f);
    }

    // apu(ライブ/スキャンどちらのAPUHuC6280インスタンスでも可)へスナップショットsを
    // 書き戻す共通処理(DDAの生トレース上書きは含まない。呼び出し側で必要なら別途行う)。
    _applySnapshotTo(apu, s) {
      for (let i = 0; i < s.length; i++) {
        const c = apu.ch[i], sc = s[i];
        c.control = (sc.on ? 0x80 : 0) | (sc.dda ? 0x40 : 0) | (sc.vol & 0x1F);
        c.freq = sc.freq;
        c.balance = sc.balance;
        c.dac = sc.dac;
        // 生のnoiseCtrl(下位5bitに周期選択値)をそのまま復元する。以前はnoiseOn(真偽値)
        // からon/offビットだけ再構成しており、周期選択値が常に0(=invVal31=最遅固定)に
        // すり替わっていた(hesPlayer.js snapshotApu()冒頭コメント参照)。sc.noiseCtrlが
        // 無い古いキャプチャ結果(念のためのフォールバック)ではnoiseOnから復元する。
        c.noiseCtrl = sc.noiseCtrl !== undefined ? sc.noiseCtrl : (sc.noiseOn ? 0x80 : 0);
        for (let j = 0; j < sc.wave.length; j++) c.wave[j] = sc.wave[j];
      }
    }

    // ===== 無音自動送り: 先読みスキャン(NsfReplayStreamPlayerと同じ設計) =====
    _scanBuildApu() {
      this._scanApu = new MML.Emu.APUHuC6280();
      if (this._lastMute) {
        const exp = this._lastMute.expansion || this._lastMute;
        // ★ミュートはスキャンへ反映しない(聴き方の設定であって曲の内容ではないため。
        //   全chミュートで「曲が終わった」と誤判定して次の曲へ飛ぶのを防ぐ)
      }
      if (this._lastVolume) {
        const exp = this._lastVolume.expansion || this._lastVolume;
        if (exp.hes) MML.Emu.applyVolume(this._scanApu.vol, exp.hes);
      }
    }

    _scanApplyFrame(f) {
      this._scanFrame = f;
      this._applySnapshotTo(this._scanApu, this.snapshots[f]);
    }

    _resetScan(fromFrame) {
      if (!this.header) return;
      this._scanBuildApu();
      this._scanCycleAccum = 0;
      this._scanDcPrevXL = this._scanDcPrevYL = this._scanDcPrevXR = this._scanDcPrevYR = 0;
      this._scanSilentRun = 0;
      this._silenceScanFrame = -1;
      this._silenceFired = false;
      this._scanDone = false;
      this._scanFrame = -1;
      const snaps = this.snapshots || [];
      let f = 0;
      for (; f <= fromFrame; f++) {
        if (!snaps[f]) break;
        this._scanApplyFrame(f);
      }
      this._scanSongFramePos = Math.min(f, fromFrame + 1);
    }

    scanSilenceStep(budgetSongSeconds) {
      if (this._scanDone || this._silenceScanFrame >= 0 || !this._scanApu) return;
      const sr = this.audioCtx.sampleRate;
      const budgetSamples = Math.max(1, Math.round(budgetSongSeconds * sr));
      for (let i = 0; i < budgetSamples; i++) {
        const nextSongFramePos = this._scanSongFramePos + (this.frameRate / sr);
        const f = Math.floor(nextSongFramePos);
        if (f >= this.totalFrames) { this._scanDone = true; return; }
        if (!this._isFrameReady(f)) return;
        this._scanSongFramePos = nextSongFramePos;
        if (f !== this._scanFrame) this._scanApplyFrame(f);

        this._scanCycleAccum += this.clockHz / sr;
        while (this._scanCycleAccum >= 1) { this._scanApu.clock(); this._scanCycleAccum -= 1; }
        const raw = this._scanApu.mixSample();
        const yL = raw.left  - this._scanDcPrevXL + 0.999 * this._scanDcPrevYL;
        const yR = raw.right - this._scanDcPrevXR + 0.999 * this._scanDcPrevYR;
        this._scanDcPrevXL = raw.left;  this._scanDcPrevYL = yL;
        this._scanDcPrevXR = raw.right; this._scanDcPrevYR = yR;

        if (Math.abs(yL) < SILENCE_EPS && Math.abs(yR) < SILENCE_EPS) {
          this._scanSilentRun++;
          if (this._scanSilentRun >= sr * SILENCE_SEC) {
            this._silenceScanFrame = Math.max(0, Math.floor(this._scanSongFramePos - SILENCE_SEC * this.frameRate));
            return;
          }
        } else {
          this._scanSilentRun = 0;
        }
      }
    }

    // このフレーム(f)分のDDA生トレース値を集めてキャッシュする(書込み順、ポインタは
    // 消費した分だけ進める)。実際の書込みタイミング(フレーム内のどの瞬間か)までは
    // 記録していないため、フレーム内で均等に割り振る近似で使う(_fill()参照)。
    _prepDdaFrame(f) {
      this._ddaFrameEntries = null;
      if (this.ddaChannel < 0 || !this.ddaTrace) return;
      const trace = this.ddaTrace;
      while (this._ddaTracePos < trace.length && trace[this._ddaTracePos].frame < f) this._ddaTracePos++;
      const entries = [];
      let p = this._ddaTracePos;
      while (p < trace.length && trace[p].frame === f) { entries.push(trace[p].value); p++; }
      this._ddaTracePos = p;
      if (entries.length > 0) this._ddaFrameEntries = entries;
    }

    _fill(outL, outR) {
      const sr = this.audioCtx.sampleRate;
      for (let i = 0; i < outL.length; i++) {
        const nextSongFramePos = this._songFramePos + (this.frameRate / sr) * this.speedFactor;
        const f = Math.floor(nextSongFramePos);
        if (f >= this.totalFrames) {
          for (let j = i; j < outL.length; j++) { outL[j] = 0; outR[j] = 0; }
          this.isPlaying = false;
          if (this.onEnded) this.onEnded();
          return;
        }
        if (!this._isFrameReady(f)) { outL[i] = 0; outR[i] = 0; continue; }
        this._songFramePos = nextSongFramePos;
        if (f !== this.currentFrame) this._applyFrame(f);

        // DDAchのdacを、このフレーム内の生トレース密度に応じてサンプル単位で更新する
        // (CPU駆動再生が実際に書き込んでいた生の値の並びを、記録済みの書込みタイミングの
        // 粒度[フレーム単位]の範囲でできるだけ忠実に再現する)。値が実際に変化した時だけ
        // 鍵盤表示用リングバッファへも記録する(毎サンプル記録すると同じ値の連続で
        // バッファがすぐ埋まり、直近のごく短い時間しか見えなくなるため。getDdaWave参照)。
        if (this.ddaChannel >= 0 && this._ddaFrameEntries) {
          const frac = this._songFramePos - f; // このフレーム内での経過割合(0..1)
          const idx = Math.min(this._ddaFrameEntries.length - 1, Math.floor(frac * this._ddaFrameEntries.length));
          const v = this._ddaFrameEntries[idx];
          const ch = this.apu.ch[this.ddaChannel];
          if (ch.dac !== v) {
            ch.dac = v;
            this._ddaWaveBuf[this._ddaWavePos] = v;
            this._ddaWavePos = (this._ddaWavePos + 1) % DDA_HIST_LEN;
            if (this._ddaWaveCount < DDA_HIST_LEN) this._ddaWaveCount++;
          }
        }

        this.cycleAccum += this.clockHz / sr;
        while (this.cycleAccum >= 1) { this.apu.clock(); this.cycleAccum -= 1; }
        const raw = this.apu.mixSample();
        const yL = raw.left  - this.dcPrevXL + 0.999 * this.dcPrevYL;
        const yR = raw.right - this.dcPrevXR + 0.999 * this.dcPrevYR;
        this.dcPrevXL = raw.left;  this.dcPrevYL = yL;
        this.dcPrevXR = raw.right; this.dcPrevYR = yR;
        outL[i] = yL; outR[i] = yR;
        this.samplePos++;
        if (this._silenceScanFrame >= 0 && !this._silenceFired && f >= this._silenceScanFrame) {
          // ★ミュート中は通知しない(main.js syncSilenceDetect)
          if (this.silenceDetectEnabled === false) continue;
          this._silenceFired = true;
          if (this.onSilenceTimeout) this.onSilenceTimeout();
        }
      }
    }

    // 直近のdac生値履歴(古い→新しい順、0-31)から自己相関で周期を検出し、その1周期ぶんの
    // 値配列(可変長)を返す(鍵盤表示用)。波形メモリ(N163/FDS等)は固定長のバッファ
    // そのものだが、PCMには「1周期」に相当する固定長の概念が無いため、実際の音の
    // 周期性から動的に長さを決める(ユーザー指摘)。周期が検出できない(無音・打楽器的な
    // 過渡音等、実際のPCMで多い)場合は、NSFのDMC表示(サンプル全体をそのまま見せる)に
    // 近い考え方で直近64件をフォールバックとして返す(以前は16件と狭すぎて、実質何も
    // 見えていないのと同じだった)。いずれの場合も軽く平滑化してから返す
    // (smoothWave冒頭コメント参照)。main.js liveHesApu()参照。
    getDdaWave() {
      const n = this._ddaWaveCount;
      if (n === 0) return [16, 16, 16];
      const hist = new Array(n);
      for (let i = 0; i < n; i++) hist[i] = this._ddaWaveBuf[(this._ddaWavePos - n + i + DDA_HIST_LEN * 2) % DDA_HIST_LEN];
      const period = detectPcmPeriod(hist);
      const slice = period != null ? hist.slice(hist.length - period) : hist.slice(Math.max(0, hist.length - 64));
      return smoothWave(slice);
    }

    play()  { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    stop() {
      this.isPlaying = false;
      if (this.header) this._buildApu();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      this._ddaTracePos = 0;
      this._ddaFrameEntries = null;
      this._ddaWaveBuf.fill(16);
      this._ddaWavePos = 0;
      this._ddaWaveCount = 0;
      this._resetScan(0);
    }

    setSpeed(factor) { this.speedFactor = factor; }

    seek(samplePos) {
      const sr = this.audioCtx.sampleRate;
      let songFramePos = (samplePos / sr) * this.frameRate * this.speedFactor;
      let targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      const snaps = this.snapshots || [];
      if (targetFrame >= 0 && !snaps[targetFrame]) {
        while (targetFrame > 0 && !snaps[targetFrame]) targetFrame--;
        songFramePos = targetFrame;
        samplePos = (songFramePos / this.frameRate / this.speedFactor) * sr;
      }
      this._buildApu();
      this.cycleAccum = 0;
      // DDAトレースのポインタは前後どちらへもシークしうるため、常に先頭から
      // 目標フレームの手前まで再走査する(_prepDdaFrameの前進のみの走査と違い、
      // シークは巻き戻る場合があるため)。
      this._ddaTracePos = 0;
      this._ddaFrameEntries = null;
      if (this.ddaTrace) {
        while (this._ddaTracePos < this.ddaTrace.length && this.ddaTrace[this._ddaTracePos].frame < targetFrame) this._ddaTracePos++;
      }
      if (targetFrame >= 0 && snaps[targetFrame]) this._applyFrame(targetFrame);
      this.samplePos     = samplePos;
      this.currentFrame  = targetFrame;
      this._songFramePos = songFramePos;
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      this._resetScan(targetFrame);
    }

    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute;
      if (!this.apu) return;
      const exp = mute.expansion || mute;
      if (exp.hes) Object.assign(this.apu.mute, exp.hes);
      // 再生中のミュート切替は無音判定の基準に影響するため先読みスキャンをやり直す
      if (this.header) this._resetScan(Math.max(0, this.currentFrame));
    }

    // {hes:{ch0..ch5}}形状(applyMuteと同じ)だが値は0〜1
    applyVolume(volume) {
      if (!volume) return;
      this._lastVolume = volume;
      if (!this.apu) return;
      const exp = volume.expansion || volume;
      if (exp.hes) MML.Emu.applyVolume(this.apu.vol, exp.hes);
      if (this.header) this._resetScan(Math.max(0, this.currentFrame));
    }

    getPosition() { return this.samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.totalFrames / this.frameRate / this.speedFactor; }
    getCurrentFrame() { return Math.max(0, this.currentFrame); }

    destroy() {
      this.isPlaying = false;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter) { this.limiter.disconnect(); this.limiter = null; }
      this.apu       = null;
      this._scanApu  = null;
      this.snapshots = null;
      // ddaTraceは曲全体のDDA(PCM)書込み値の生ログで、他フォーマットのwriteLog同様
      // 長いDDA多用曲では数十MB規模になりうる(他4フォーマットのdestroy()と同じ理由で
      // 明示的に参照を切る)。header/_ddaFrameEntriesも合わせて破棄する。
      this.header           = null;
      this.ddaTrace         = null;
      this._ddaFrameEntries = null;
    }
  }

  // =========================================================
  // HesBufferedPlayer (ファイル冒頭コメント参照)
  // =========================================================
  const HES_CH_COUNT = 6;

  class HesBufferedPlayer {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.gainNode = null;
      this.node = null;            // ScriptProcessorNode
      this.channelAudio = null;    // Float32Array[6](captureHesSongAsync()が直接書き込む先)
      this.totalSamples = 0;
      this.renderedSamples = 0;    // channelAudioのうち「まだ読んでも安全」な範囲(先頭からの累計)
      this.duration = 0;
      this.frameRate = 60;
      this.isPlaying = false;
      this.onEnded = null;
      this.lastCapture = null;     // レンダリング完了時のcaptureHesSongAsync()結果一式
      this.onError = null;         // load()のバックグラウンドレンダリングが失敗した時に呼ばれる(e)=>{}
      this._samplePos = 0;         // 現在の再生位置(サンプル、整数)
      this._speedFactor = 1;
      this._muteGain = [1, 1, 1, 1, 1, 1];   // 実際に掛かっているゲイン(徐々に追従)
      this._muteTarget = [1, 1, 1, 1, 1, 1]; // ミュート操作の目標値(0 or 1)
      this._dcPrevX = 0;
      this._dcPrevY = 0;
      this._loadArgs = null;
      this._renderToken = 0;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 4.0;
      this.gainNode.connect(MML.Audio.getMasterGain(this.audioCtx));
      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.connect(this.gainNode);
      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        if (!this.channelAudio || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    _fill(out) {
      const CH = this.channelAudio.length;
      for (let i = 0; i < out.length; i++) {
        const pos = this._samplePos;
        if (pos >= this.totalSamples) {
          out.fill(0, i);
          this.isPlaying = false;
          if (this.onEnded) this.onEnded();
          return;
        }
        if (pos >= this.renderedSamples) { out[i] = 0; continue; } // 先読み待ち(位置は進めない)
        let mix = 0;
        for (let c = 0; c < CH; c++) {
          this._muteGain[c] += (this._muteTarget[c] - this._muteGain[c]) * 0.01; // クリック防止のランプ
          mix += this.channelAudio[c][pos] * this._muteGain[c];
        }
        const y = mix - this._dcPrevX + 0.999 * this._dcPrevY;
        this._dcPrevX = mix; this._dcPrevY = y;
        out[i] = y;
        this._samplePos++;
      }
    }

    // レンダリング完了を待たず即座に返る(NsfReplayStreamPlayer/main.js playNsfStream()と
    // 同じ「バックグラウンドキャプチャと配列を共有し、埋まった分だけ再生する」設計。
    // ファイル冒頭コメント参照)。onProgress(done,total,data)は先読みの進捗ごとに
    // 呼ばれ、data.snapshotsはロール構築に使える。
    load(hesBytes, track, totalSeconds, mute, onProgress) {
      const token = ++this._renderToken;
      const sampleRate = this.audioCtx.sampleRate;
      this.totalSamples = Math.max(1, Math.round(totalSeconds * sampleRate));
      this.channelAudio = Array.from({ length: HES_CH_COUNT }, () => new Float32Array(this.totalSamples));
      this.renderedSamples = 0;
      this.duration = totalSeconds;
      this.lastCapture = null;
      this._dcPrevX = this._dcPrevY = 0;
      this._loadArgs = { hesBytes, track, totalSeconds, mute, onProgress };
      if (mute) this.applyMute(mute);

      MML.Emu.captureHesSongAsync(hesBytes, {
        track, durationSeconds: totalSeconds, sampleRate,
        regsOnly: false, perChannelAudio: true, speedFactor: this._speedFactor,
        channelAudioOut: this.channelAudio,
        shouldCancel: () => token !== this._renderToken
      }, (done, total, data) => {
        if (token !== this._renderToken) return; // 曲送り/速度変更等で追い越された
        if (data.frameRate) this.frameRate = data.frameRate;
        this.renderedSamples = data.samplesReady || 0;
        if (onProgress) onProgress(done, total, data);
      }).then((capture) => {
        if (token !== this._renderToken) return;
        this.lastCapture = capture;
        this.renderedSamples = this.totalSamples;
        this.frameRate = capture.frameRate;
      }).catch((e) => {
        console.error('HES音声レンダリングエラー:', e);
        if (token === this._renderToken && this.onError) this.onError(e);
      });
    }

    play() {
      if (this.isPlaying || !this.channelAudio) return;
      this.isPlaying = true;
    }

    pause() {
      this.isPlaying = false;
    }

    stop() {
      this.isPlaying = false;
      this._samplePos = 0;
    }

    // samplePos: 他プレイヤーのseek()と単位を揃える(audioCtx.sampleRate基準のサンプル位置)。
    // ScriptProcessorNode駆動でAudioBufferSourceNodeを使わないため、位置を直接書き換えるだけ
    // (stop/restartが不要)。renderedSamplesより先へシークしても、そこまで先読みが
    // 追いつくまで自動的に無音のまま待つ(_fill()参照。UI側はcurrentBufferedFraction()で
    // 先読み範囲を超えないようスナップバックする)。
    seek(samplePos) {
      this._samplePos = Math.max(0, Math.min(this.totalSamples, Math.round(samplePos)));
    }

    // 再生速度スライダー用。AudioBufferSourceNode.playbackRateは使わない
    // (ピッチも一緒に変わるテープ速度方式のため、音程を保ったままテンポだけ変える
    // 既存仕様と矛盾する)。常にload()をやり直してテンポだけを変えた新しいレンダリングへ
    // 切り替える(totalSamples自体はspeedFactorに関わらず一定なので、再生位置は
    // サンプル単位でそのまま引き継げる)。
    setSpeed(factor) {
      if (this._speedFactor === factor) return;
      this._speedFactor = factor;
      if (!this._loadArgs) return;
      const { hesBytes, track, totalSeconds, mute, onProgress } = this._loadArgs;
      const preservedPos = this._samplePos;
      const wasPlaying = this.isPlaying;
      this.load(hesBytes, track, totalSeconds, mute, onProgress);
      this._samplePos = Math.min(preservedPos, this.totalSamples - 1);
      this.isPlaying = wasPlaying;
    }

    // 再生中でも即座に反映される(_fill()内で毎サンプル目標値へ徐々に追従するだけで
    // 再レンダリング不要)。
    applyMute(mute) {
      if (!mute) return;
      const exp = mute.expansion || mute;
      const chMute = exp.hes || {};
      for (let c = 0; c < this._muteTarget.length; c++) this._muteTarget[c] = chMute['ch' + c] ? 0 : 1;
    }

    getPosition() { return this._samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.duration; }
    getCurrentFrame() { return Math.max(0, Math.floor(this.getPosition() * this.frameRate)); }
    // レンダリング済みの割合(0-1)。シークバーの先読みインジケータ用(main.js参照)。
    getBufferedFraction() { return this.totalSamples > 0 ? this.renderedSamples / this.totalSamples : 0; }

    destroy() {
      this.isPlaying = false;
      this._renderToken++; // 進行中のレンダリングがあれば(shouldCancel経由で)打ち切らせる
      this.channelAudio = null;
      this.lastCapture = null;
      this._loadArgs = null;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
    }
  }

  MML.Audio.HesStreamPlayer = HesStreamPlayer;
  MML.Audio.HesReplayStreamPlayer = HesReplayStreamPlayer;
  MML.Audio.HesBufferedPlayer = HesBufferedPlayer;
})(window);
