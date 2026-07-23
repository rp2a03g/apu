/*
 * KSS ストリーミング再生プレイヤー (ScriptProcessorNode)
 * MML.Audio.KssStreamPlayer
 *
 * NsfStreamPlayer と同じ設計(player.renderFrame(sampleRate)をフレーム単位で呼び出し、
 * DCブロッカ+リミッタを通す)。PSG+SCC+OPLL合成時のクリップを防ぐためリミッタを使用する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE = 4096;

  function createLimiter(audioCtx) {
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

  class KssStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.node = null;
      this.gainNode = null;
      this.limiter = null;
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
      this.gainNode.gain.value = 2.5;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(this.audioCtx.destination);

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

    load(kssBytes, songIndex, totalFrames, mute) {
      this.stop();
      this.player = new MML.Emu.KssPlayer(kssBytes);
      this._songIndex = songIndex;
      this.player.initSong(songIndex);
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

    setSpeed(factor) {
      if (this.player) this.player.speedFactor = factor;
    }

    stop() {
      this.isPlaying = false;
      if (this.player) this.player.initSong(this._songIndex || 0);
      this.frameBuffer = null;
      this.frameOffset = 0;
      this.currentFrame = 0;
      this._samplePos = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    // keyboardDisplay.getMuteConfig()と同じ{apu:{},expansion:{psg,scc,opll}}形式
    // (NsfStreamPlayer.applyMuteと同じ読み方)。従来の{psg,scc,opll}直下形式も後方互換で受ける。
    applyMute(mute) {
      if (!mute || !this.player) return;
      const exp = mute.expansion || mute;
      if (exp.psg) MML.Emu.applyMute(this.player.psg.mute, exp.psg);
      if (exp.scc) MML.Emu.applyMute(this.player.scc.mute, exp.scc);
      if (exp.opll && this.player.opll) MML.Emu.applyMute(this.player.opll.mute, exp.opll);
    }

    getPosition() {
      return this._samplePos / this.audioCtx.sampleRate;
    }

    getDuration() {
      return this.totalFrames / this.player.frameRate;
    }

    destroy() {
      this.isPlaying = false;
      if (this.node) { this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter) { this.limiter.disconnect(); this.limiter = null; }
    }
  }

  MML.Audio.KssStreamPlayer = KssStreamPlayer;
})(window);
