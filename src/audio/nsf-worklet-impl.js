/*
 * NSF AudioWorklet プロセッサ実装
 * worklet-loader.js によって emulator コードと連結されて Blob URL として読み込まれる。
 * globalThis.MML.Emu.NsfPlayer が使用可能な前提。
 */

class NsfProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player       = null;
    this._songIndex   = 0;
    this.frameBuffer  = null;
    this.frameOffset  = 0;
    this.totalFrames  = 0; // 0 = ループ無限
    this.currentFrame = 0;
    this.dcPrevX      = 0;
    this.dcPrevY      = 0;
    this.playing      = false;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'load':
        this._load(msg);
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        this.port.postMessage({ type: 'paused', frame: this.currentFrame });
        break;
      case 'stop':
        this.playing = false;
        if (this.player) this.player.initSong(this._songIndex);
        this.frameBuffer  = null;
        this.frameOffset  = 0;
        this.currentFrame = 0;
        this.dcPrevX = this.dcPrevY = 0;
        break;
      case 'mute':
        this._applyMute(msg.mute);
        break;
    }
  }

  _load(data) {
    const Emu = globalThis.MML.Emu;
    this._songIndex   = data.songIndex || 0;
    this.player       = new Emu.NsfPlayer(new Uint8Array(data.nsfBytes));
    this.player.initSong(this._songIndex);
    this.totalFrames  = data.totalFrames || 0;
    this.currentFrame = 0;
    this.frameBuffer  = null;
    this.frameOffset  = 0;
    this.dcPrevX = this.dcPrevY = 0;
    this.playing      = false;
    if (data.mute) this._applyMute(data.mute);
  }

  _applyMute(mute) {
    if (!mute || !this.player) return;
    const Emu = globalThis.MML.Emu;
    if (mute.apu) Emu.applyMute(this.player.apu.mute, mute.apu);
    if (mute.expansion) {
      for (const [name, chip] of Object.entries(this.player.bus.expansion)) {
        if (mute.expansion[name]) Emu.applyMute(chip.mute, mute.expansion[name]);
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.player || !this.playing) { out.fill(0); return true; }

    let outPos = 0;
    while (outPos < out.length) {
      // フレームバッファが尽きたら次のフレームをレンダリング
      if (!this.frameBuffer || this.frameOffset >= this.frameBuffer.length) {
        if (this.totalFrames > 0 && this.currentFrame >= this.totalFrames) {
          for (let i = outPos; i < out.length; i++) out[i] = 0;
          this.playing = false;
          this.port.postMessage({ type: 'ended' });
          return true;
        }
        this.frameBuffer  = this.player.renderFrame(sampleRate);
        this.frameOffset  = 0;
        this.currentFrame++;
        // 定期的にフレーム番号を通知（モニタ用）
        if (this.currentFrame % 60 === 0) {
          this.port.postMessage({ type: 'frame', frame: this.currentFrame });
        }
      }

      const toCopy = Math.min(this.frameBuffer.length - this.frameOffset, out.length - outPos);
      for (let i = 0; i < toCopy; i++) {
        const raw = this.frameBuffer[this.frameOffset + i];
        // DCブロック（サンプル単位のIIR）
        const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
        this.dcPrevX = raw;
        this.dcPrevY = y;
        out[outPos + i] = y;
      }
      outPos          += toCopy;
      this.frameOffset += toCopy;
    }

    return true;
  }
}

registerProcessor('nsf-processor', NsfProcessor);
