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
      this.gainNode.connect(ctx.destination);

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

  MML.Audio.SpcStreamPlayer = SpcStreamPlayer;

})(window);
