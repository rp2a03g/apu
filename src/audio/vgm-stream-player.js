/*
 * VGM ストリーミング再生プレイヤー (ScriptProcessorNode)
 * MML.Audio.VgmStreamPlayer
 *
 * VGMはCPUを持たないレジスタログで、コマンド消化のコストがごく小さいため、
 * GBS/KSSのような「先読みキャプチャを再生に使い回す(Replay)」二重構造にはせず、
 * VgmPlayer(src/emulator/vgmPlayer.js)をそのまま直接駆動する。
 * - シーク: チップを作り直して曲頭から目的サンプルまでコマンドだけ再走(fastForward)。
 *   チップのclock()は回さないので一瞬で終わる(レジスタ状態は正しく、エンベロープ等の
 *   時間経過状態だけは進んでいない=KSSのwriteLog再生シークと同じ割り切り)。
 * - 無音自動送り: 先読みスキャンは持たず、実出力が10秒連続で無音なら発火する
 *   (VGMは非ループ曲ならヘッダの総サンプル数で自然終了(player.ended)するので、
 *   無音送りが要るのは「終端まで待ちだけが続く」ような特殊なファイルに限られる)。
 * - 音量: 各チップに由来フォーマットの校正済みgainをVgmPlayer側で掛けてあるので
 *   ここは1.0。複数チップ合算のクリップ対策にリミッタを挟む(gbs-stream-player.jsと同じ)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE = 4096;
  const SILENCE_SEC = 10;
  const SILENCE_EPS = 1e-4;
  const VGM_RATE = 44100;

  function createLimiter(audioCtx) {
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

  class VgmStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.node = null;
      this.gainNode = null;
      this.limiter = null;
      this.player = null;      // MML.Emu.VgmPlayer
      this.bytes = null;
      this.frameBuffer = null; // {left,right}
      this.frameOffset = 0;
      this.totalFrames = 0;
      this.currentFrame = 0;   // 出力済みフレーム数(VgmPlayer.renderFrame呼出し回数)
      this.frameRate = MML.Emu.VGM_FRAME_RATE || 60;
      this.speedFactor = 1;
      this._samplePos = 0;
      this.dcPrevXL = 0; this.dcPrevYL = 0;
      this.dcPrevXR = 0; this.dcPrevYR = 0;
      this.isPlaying = false;
      this.onEnded = null;
      this.onSilenceTimeout = null;
      this._silentRun = 0;
      this._silenceFired = false;
      this._lastMute = null;
      this._lastVolume = null;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.0;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(this.audioCtx));

      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 2);
      this.node.connect(this.gainNode);
      this.node.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        if (!this.player || !this.isPlaying) { outL.fill(0); outR.fill(0); return; }
        this._fill(outL, outR);
      };
    }

    _fill(outL, outR) {
      const sr = this.audioCtx.sampleRate;
      let outPos = 0;
      while (outPos < outL.length) {
        if (!this.frameBuffer || this.frameOffset >= this.frameBuffer.left.length) {
          if ((this.totalFrames > 0 && this.currentFrame >= this.totalFrames) || this.player.ended) {
            outL.fill(0, outPos); outR.fill(0, outPos);
            this.isPlaying = false;
            if (this.onEnded) this.onEnded();
            return;
          }
          this.frameBuffer = this.player.renderFrame(sr, false, true);
          this.frameOffset = 0;
          this.currentFrame++;
        }
        const fb = this.frameBuffer;
        const toCopy = Math.min(fb.left.length - this.frameOffset, outL.length - outPos);
        for (let i = 0; i < toCopy; i++) {
          const rl = fb.left[this.frameOffset + i];
          const rr = fb.right[this.frameOffset + i];
          const yL = rl - this.dcPrevXL + 0.999 * this.dcPrevYL;
          const yR = rr - this.dcPrevXR + 0.999 * this.dcPrevYR;
          this.dcPrevXL = rl; this.dcPrevYL = yL;
          this.dcPrevXR = rr; this.dcPrevYR = yR;
          outL[outPos + i] = yL; outR[outPos + i] = yR;
          if (Math.abs(yL) < SILENCE_EPS && Math.abs(yR) < SILENCE_EPS) {
            this._silentRun++;
            if (!this._silenceFired && this._silentRun >= sr * SILENCE_SEC) {
              this._silenceFired = true;
              if (this.onSilenceTimeout) this.onSilenceTimeout();
            }
          } else {
            this._silentRun = 0;
          }
        }
        outPos += toCopy;
        this.frameOffset += toCopy;
        this._samplePos += toCopy;
      }
    }

    /**
     * @param {Uint8Array} vgmBytes - 解凍済みVGM
     * @param {number} totalFrames - 再生する最大フレーム数(1/60秒単位、VGM時間)
     * @param {object} [mute] - keyboardDisplay.getMuteConfig()形式
     */
    load(vgmBytes, totalFrames, mute) {
      this.stop();
      this.bytes = vgmBytes;
      this.player = new MML.Emu.VgmPlayer(vgmBytes);
      this.player.speedFactor = this.speedFactor;
      this.totalFrames = totalFrames;
      this._resetState();
      if (mute) this.applyMute(mute);
      if (this._lastVolume) this.applyVolume(this._lastVolume);
    }

    _resetState() {
      this.frameBuffer = null;
      this.frameOffset = 0;
      this.currentFrame = 0;
      this._samplePos = 0;
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      this._silentRun = 0;
      this._silenceFired = false;
    }

    play() { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    stop() {
      this.isPlaying = false;
      if (this.player) {
        this.player.reset();
        this.player.speedFactor = this.speedFactor;
        if (this._lastMute) this.player.applyMute(this._lastMute);
        if (this._lastVolume) this.player.applyVolume(this._lastVolume);
      }
      this._resetState();
    }

    setSpeed(factor) {
      this.speedFactor = factor;
      if (this.player) this.player.speedFactor = factor;
    }

    // 実時間(出力サンプル)位置へのシーク。VGM時間 = 実時間 × speedFactor。
    seek(samplePos) {
      if (!this.player) return;
      const sr = this.audioCtx.sampleRate;
      const targetVgmSample = Math.max(0, Math.floor((samplePos / sr) * this.speedFactor * VGM_RATE));
      this.player.reset();
      this.player.speedFactor = this.speedFactor;
      if (this._lastMute) this.player.applyMute(this._lastMute);
      if (this._lastVolume) this.player.applyVolume(this._lastVolume);
      this.player.fastForward(targetVgmSample);
      this._resetState();
      this._samplePos = samplePos;
      this.currentFrame = Math.floor(targetVgmSample / (VGM_RATE / this.frameRate));
    }

    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute;
      if (this.player) this.player.applyMute(mute);
    }

    applyVolume(volume) {
      if (!volume) return;
      this._lastVolume = volume;
      if (this.player) this.player.applyVolume(volume);
    }

    getPosition() { return this._samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.totalFrames / this.frameRate / this.speedFactor; }
    getCurrentFrame() {
      return this.player ? Math.floor(this.player.samplePos / (VGM_RATE / this.frameRate)) : 0;
    }

    destroy() {
      this.isPlaying = false;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter) { this.limiter.disconnect(); this.limiter = null; }
      this.player = null;
      this.frameBuffer = null;
      this.bytes = null;
    }
  }

  MML.Audio.VgmStreamPlayer = VgmStreamPlayer;
})(window);
