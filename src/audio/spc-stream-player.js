/*
 * SPC ストリーミング再生プレイヤー (ScriptProcessorNode)
 * MML.Audio.SpcStreamPlayer
 *
 * NSFStreamPlayer と同じインターフェースを提供する。
 *   load(spcBytes)
 *   play() / pause() / stop()
 *   getPosition() → seconds
 *   destroy()
 *   isPlaying, onEnded
 */
(function (global) {
  'use strict';
  const MML   = global.MML  = global.MML  || {};
  MML.Audio   = MML.Audio  || {};

  const DSP_RATE   = 32000;     // SPC DSP サンプルレート
  const BUFFER_SIZE = 4096;     // ScriptProcessorNode バッファサイズ
  const FADE_SEC   = 3;         // 指定時間経過後にフェードアウトする長さ(秒)

  class SpcStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx  = audioCtx;
      this.node      = null;
      this.gainNode  = null;
      this.player    = null;      // MML.Emu.SpcPlayer
      this.isPlaying = false;
      this.onEnded   = null;
      this._position = 0;        // 経過サンプル数 (outRate)
      this._totalSamples = 0;
      this._dspFrac  = 0;
      this._spcBytes = null;     // 再起動用に保持
      this._lastL    = 0; this._lastR = 0;
      this._mute     = {};
      this._dspPos          = 0;        // 経過 DSP サンプル数
      this._totalDspSamples = Infinity; // 指定時間(フェード開始位置, DSP サンプル単位)
      this._fadeDspSamples  = 0;        // フェードアウトの長さ(DSP サンプル単位)
    }

    /**
     * SPC バイト列を読み込んで再生準備
     * @param {Uint8Array} spcBytes
     * @param {number} durationFrames - 再生フレーム数 (1/60s 単位)。この時間が経過すると
     *   FADE_SEC 秒かけてフェードアウトし、停止する。未指定なら時間無制限。
     * @param {object} [mute] - チャンネルミュート設定 (未使用, 互換)
     */
    load(spcBytes, durationFrames, mute) {
      this.destroy();
      this._mute = mute || {};
      this._spcBytes = spcBytes;
      this.player = new MML.Emu.SpcPlayer(spcBytes);

      const ctx  = this.audioCtx;
      const rate = ctx.sampleRate;

      this.gainNode = ctx.createGain();
      // ガウシアン補間の修正(spcDsp.js)で DSP 出力が本来のレベル(約1.7倍)に戻ったため、
      // 旧テーブルの減衰を補償していたゲイン 3.0 では音割れ(クリップ)する。2.0 に下げて
      // 旧来と同等のラウドネスを保ちつつピークを 1.0 未満に収める。
      this.gainNode.gain.value = 2.0;
      this.gainNode.connect(MML.Audio.getMasterGain(ctx));

      // ScriptProcessorNode
      this.node = ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.onaudioprocess = (e) => this._process(e, rate);
      this.node.connect(this.gainNode);

      this._position     = 0;
      this._totalSamples = 0;
      this._dspFrac      = 0;
      this._lastL        = 0; this._lastR = 0;

      this._dspPos          = 0;
      this._totalDspSamples = durationFrames
        ? (durationFrames / 60) * DSP_RATE
        : Infinity;
      this._fadeDspSamples  = FADE_SEC * DSP_RATE;
    }

    _process(e, outRate) {
      const out = e.outputBuffer.getChannelData(0);
      const n   = out.length;
      if (!this.isPlaying || !this.player) {
        out.fill(0);
        return;
      }
      const step = DSP_RATE / outRate;
      let ended = false;

      for (let i = 0; i < n; i++) {
        if (ended) { out[i] = 0; continue; }
        this._dspFrac += step;
        while (this._dspFrac >= 1.0) {
          // 指定時間+フェード秒数を経過したら再生終了
          if (this._dspPos >= this._totalDspSamples + this._fadeDspSamples) {
            ended = true;
            this._lastL = 0; this._lastR = 0;
            break;
          }
          // STOP/SLEEP でハルトしたら SPC を最初から再起動（ループ）
          if (this.player.isHalted && this._spcBytes) {
            const prevMuted = this.player.dsp.mutedVoices;
            const prevSpeed = this.player.speedFactor;
            this.player = new MML.Emu.SpcPlayer(this._spcBytes);
            this.player.dsp.mutedVoices = prevMuted; // ミュート設定を引き継ぐ
            this.player.speedFactor = prevSpeed;     // 再生速度を引き継ぐ
          }
          const s = this.player.renderSample();
          this._dspPos++;
          // 指定時間を過ぎたらフェードアウトゲインを掛ける
          let gain = 1.0;
          const fadeElapsed = this._dspPos - this._totalDspSamples;
          if (fadeElapsed > 0 && this._fadeDspSamples > 0) {
            gain = Math.max(0, 1 - fadeElapsed / this._fadeDspSamples);
          }
          this._lastL = s.L * gain;
          this._lastR = s.R * gain;
          this._dspFrac -= 1.0;
        }
        out[i] = (this._lastL + this._lastR) * 0.5;
      }
      this._position += n;

      if (ended) {
        this.isPlaying = false;
        if (this.onEnded) this.onEnded();
      }
    }

    play() {
      if (this.isPlaying) return;
      this.isPlaying = true;
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    }

    // 再生速度を変更する(1=等速 〜 1/8=低速)。SPC700/タイマーの実行頻度のみ
    // 間引かれ、DSPは常に等速で駆動されるため音程は変わらずテンポだけ落ちる。
    setSpeed(factor) {
      if (this.player) this.player.speedFactor = factor;
    }

    pause() {
      this.isPlaying = false;
    }

    stop() {
      this.isPlaying = false;
      this._position = 0;
      this._dspPos   = 0;
      this._dspFrac  = 0;
      this._lastL = 0; this._lastR = 0;
    }

    getPosition() {
      return this._position / this.audioCtx.sampleRate;
    }

    destroy() {
      this.isPlaying = false;
      if (this.node) {
        this.node.disconnect();
        this.node.onaudioprocess = null;
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      this.player = null;
    }

    // ミュート変更（ボイス単位、DSP 側では現時点では非対応: no-op）
    applyMute() {}
  }

  // =========================================================
  // SpcReplayStreamPlayer
  // =========================================================
  // SPCは「SPC700 CPUを実行しながらDSPで音声も生成する」SpcStreamPlayerとは異なり、
  // バックグラウンドで先行実行されたMML.SPC2MML.captureAsyncのframeLog(フレームごとの
  // DSPレジスタ書込み{reg,val}[]、dsp.onWriteをフックして取得。$F2/$F3のバス間接
  // アドレッシングは既にデコード済みの生レジスタ番号で記録されている)を「CPU抜きで」
  // DSPへ再適用するだけで音声合成する。NsfReplayStreamPlayer/KssReplayStreamPlayerと
  // 同じ設計だが、SPCならではの特性が2つある:
  //  (1) .spcファイルは64KB RAM全体(BRRサンプル本体を含む)の完全なスナップショットであり、
  //      NSF/KSSのように「ROM+INITルーチン」から実行してRAMを組み立てる必要が無い。
  //      MML.Emu.SpcPlayerのコンストラクタが、エコーバッファのクリア・BRRディレクトリの
  //      キャッシュ・KON再発火(ダンプ時点で鳴っていたボイスのアタックを正しく再現する
  //      補正)を含めて既に正しく行っているため、そのコンストラクタを丸ごと再利用し
  //      CPU/バスだけを使わない(dspだけを取り出す)。
  //  (2) captureAsyncのframeLog[0]の先頭128個は_seedInitialFrameが注入した「生の
  //      DSPレジスタダンプ」で、上記(1)のコンストラクタが適用する内容と重複する
  //      (特にKONレジスタは生の値をそのまま2回書くとアタックが再トリガーされてしまう)。
  //      このため頭128個は必ずスキップし、それより後(実際のPLAY開始直後に発生した
  //      書き込み)だけを適用する。
  const SPC_FRAME_SAMPLES = Math.round(DSP_RATE / 60);
  const SPC_FRAME_RATE    = DSP_RATE / SPC_FRAME_SAMPLES;
  const SEEDED_FRAME0_LEN = 128; // _seedInitialFrame(spc2mml/converter.js)が注入する固定数

  class SpcReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx      = audioCtx;
      this.node          = null;
      this.gainNode      = null;
      // main.jsはspcActivePlayer.player.dsp.mutedVoices等「player.player.dsp」形状を
      // 前提にしている。自己参照させることでこれらのヘルパーを一切変更せずに再利用できる
      // (NsfReplayStreamPlayer/KssReplayStreamPlayerと同じ手法)。
      this.player        = this;
      this.dsp           = null;
      this.spcBytes      = null;
      this.writeLog      = null; // captureAsyncが進行中に育てる配列への参照
      this.totalFrames   = 0;
      this.samplePos     = 0;    // 出力サンプル(audioCtx.sampleRate基準の実時間)経過数
      this.currentFrame  = -1;
      this._dspFrac      = 0;    // 出力レート→DSPレート(32kHz)変換の端数
      this._songFramePos = 0;    // ログフレーム位置(speedFactor込みの実数値)
      this.speedFactor   = 1;
      this._lastL = 0; this._lastR = 0;
      this.isPlaying = false;
      this.onEnded   = null;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 2.0;
      this.gainNode.connect(MML.Audio.getMasterGain(this.audioCtx));
      // VOL_L/VOL_R($x2/$x3)を反映するため2ch(ステレオ)出力にする
      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 2);
      this.node.connect(this.gainNode);
      this.node.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        if (!this.dsp || !this.isPlaying) { outL.fill(0); outR.fill(0); return; }
        this._fill(outL, outR);
      };
    }

    // MML.Emu.SpcPlayerのコンストラクタを丸ごと再利用してRAM/エコー/BRRキャッシュ/KON
    // 再発火を正しい状態にし、そこからdspだけを取り出す(CPU/バスは使わない)。
    _buildChips() {
      const base = new MML.Emu.SpcPlayer(this.spcBytes);
      this.dsp = base.dsp;
      if (this._lastMuted !== undefined) this.dsp.mutedVoices = this._lastMuted;
      if (this._lastVoiceVol) this.dsp.voiceVol = this._lastVoiceVol.slice();
    }

    // frameLog: MML.SPC2MML.captureAsyncのonProgressが渡すframeLogそのもの(進行中配列への
    // 参照なので、呼び出し後もキャプチャが進むにつれ自動的に埋まっていく)
    load(spcBytes, totalFrames, frameLog, mute) {
      this.stop();
      this.spcBytes    = spcBytes;
      this.writeLog    = frameLog;
      this.totalFrames = totalFrames;
      this._buildChips();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._dspFrac      = 0;
      this._songFramePos = 0;
      this._lastL = this._lastR = 0;
      if (mute !== undefined && mute !== null) this.applyMute(mute);
    }

    _isFrameReady(f) {
      return !!(this.writeLog && this.writeLog[f]);
    }

    _applyWrites(writes, skipSeeded) {
      if (!writes) return;
      const start = skipSeeded ? SEEDED_FRAME0_LEN : 0;
      for (let i = start; i < writes.length; i++) {
        const w = writes[i];
        this.dsp.writeReg(w.reg, w.val);
      }
    }

    _applyFrame(f) {
      this.currentFrame = f;
      this._applyWrites(this.writeLog[f], f === 0);
    }

    // DSPを1サンプル(32kHz)分進める。フレーム境界を跨ぐ場合は先にwriteLogを適用する。
    // 'ended' = 曲末に到達、false = キャプチャがまだ追いついていない、true = 進行できた。
    _stepDsp() {
      // どのログフレームを適用すべきかはspeedFactorで間引く独立したアキュムレータ
      // (NsfReplayStreamPlayerの_songFramePosと同じ考え方)。DSPクロック自体は
      // _stepDsp()が呼ばれるたび常に等速で駆動する(音程を保つ)。
      const nextSongFramePos = this._songFramePos + (SPC_FRAME_RATE / DSP_RATE) * this.speedFactor;
      const f = Math.floor(nextSongFramePos);
      if (f >= this.totalFrames) return 'ended';
      if (!this._isFrameReady(f)) return false;
      this._songFramePos = nextSongFramePos;
      if (f !== this.currentFrame) this._applyFrame(f);
      this.dsp.clock();
      this._lastL = this.dsp.outL; this._lastR = this.dsp.outR;
      return true;
    }

    _fill(outL, outR) {
      const outRate = this.audioCtx.sampleRate;
      const step = DSP_RATE / outRate;
      for (let i = 0; i < outL.length; i++) {
        this._dspFrac += step;
        let stalled = false, ended = false;
        while (this._dspFrac >= 1.0) {
          const r = this._stepDsp();
          if (r === 'ended') { ended = true; break; }
          if (r === false) {
            // バックグラウンドキャプチャがまだこのフレームに追いついていない。
            // 無音のまま位置を凍結し、次のコールバックで同じフレームを再試行する
            // (NsfReplayStreamPlayerと同じ理由: samplePosを進めるとgetPosition()が
            // 実際には再生していないのにdurationに到達したと誤認し自動停止してしまう)。
            stalled = true;
            break;
          }
          this._dspFrac -= 1.0;
        }
        if (ended) {
          for (let j = i; j < outL.length; j++) { outL[j] = 0; outR[j] = 0; }
          this.isPlaying = false;
          if (this.onEnded) this.onEnded();
          return;
        }
        outL[i] = stalled ? 0 : this._lastL;
        outR[i] = stalled ? 0 : this._lastR;
        if (!stalled) this.samplePos++;
      }
    }

    play()  { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    stop() {
      this.isPlaying = false;
      if (this.spcBytes) this._buildChips();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._dspFrac      = 0;
      this._songFramePos = 0;
      this._lastL = this._lastR = 0;
    }

    setSpeed(factor) { this.speedFactor = factor; }

    // targetFrameの直前まで(0..targetFrame、キャプチャが追いついていなければその手前まで)の
    // 書き込みをdspへ再適用してシークする(NsfReplayStreamPlayer.seek()と同じ考え方。
    // エンベロープ/BRR再生位置の内部クロック位相までは復元されない既知の割り切り)。
    seek(samplePos) {
      const outRate = this.audioCtx.sampleRate;
      let songFramePos = (samplePos / outRate) * SPC_FRAME_RATE * this.speedFactor;
      let targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      const wl = this.writeLog || [];
      if (targetFrame >= 0 && !wl[targetFrame]) {
        // 未キャプチャ範囲へのシーク: バッファ済み末尾にクランプする。samplePos/
        // songFramePosも合わせて再計算する(そうしないとgetPosition()が矛盾した
        // 位置を報告し続け、_isFrameReady(f)==falseのスタール状態に陥る)。
        while (targetFrame > 0 && !wl[targetFrame]) targetFrame--;
        songFramePos = targetFrame;
        samplePos = (songFramePos / SPC_FRAME_RATE / this.speedFactor) * outRate;
      }
      this._buildChips();
      this._dspFrac = 0;
      for (let f = 0; f <= targetFrame; f++) {
        const writes = wl[f];
        if (!writes) break;
        this._applyWrites(writes, f === 0);
      }
      this.samplePos     = samplePos;
      this.currentFrame  = targetFrame;
      this._songFramePos = songFramePos;
      this._lastL = this._lastR = 0;
    }

    // mute: mutedVoicesと同じ8bitビットマスク(bit0=Voice0...bit7=Voice7)。
    // main.jsは既存のkeyboardDisplay/鍵盤UIの都合上ビットマスクをそのまま渡す。
    applyMute(mute) {
      if (mute === undefined || mute === null) return;
      this._lastMuted = mute; // _buildChips()(シーク等でdspを作り直すたび)に再適用するため保持
      if (this.dsp) this.dsp.mutedVoices = mute;
    }

    // volume: ボイスごとの音量配列(V0〜V7、値0〜1)。他フォーマットのapplyMuteと違い
    // SPCのミュートは元々ビットマスクなので、音量もオブジェクト形状ではなく配列で揃える。
    applyVolume(volume) {
      if (!volume) return;
      this._lastVoiceVol = volume;
      if (this.dsp) this.dsp.voiceVol = volume.slice();
    }

    getPosition() {
      return this.samplePos / this.audioCtx.sampleRate;
    }

    getDuration() {
      return this.totalFrames / SPC_FRAME_RATE / this.speedFactor;
    }

    getCurrentFrame() {
      return Math.max(0, this.currentFrame);
    }

    destroy() {
      this.isPlaying = false;
      // onaudioprocessのクロージャがthis(ひいてはwriteLog=数分の曲の全DSPレジスタ
      // 書込みログ)を掴んだままだと、disconnect()後もScriptProcessorNodeがGCされる
      // まで保持され続ける(ScriptProcessorNodeはdeprecated APIで、ブラウザによっては
      // disconnect済みでも即座には回収されないため、ハンドラを明示的に外して参照を断つ)。
      // ファイルを連続で開き直すたびにこれが解放されないとメモリ不足でブラウザが落ちる。
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      this.dsp      = null;
      this.writeLog = null;
      this.spcBytes = null;
    }
  }

  MML.Audio.SpcStreamPlayer = SpcStreamPlayer;
  MML.Audio.SpcReplayStreamPlayer = SpcReplayStreamPlayer;

})(window);
