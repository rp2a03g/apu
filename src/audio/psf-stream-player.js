/*
 * PSF ストリーミング再生プレイヤー (ScriptProcessorNode)
 * MML.Audio.PsfReplayStreamPlayer
 *
 * バックグラウンドのキャプチャ(Worker、psfPlayer.js capturePsfSongAsync)が記録した
 * SPU レジスタ書き込み+SPU RAM 転送を、メインスレッドの SPU 単独エミュ(MML.Emu.PsfReplay)へ
 * サンプル位置どおりに流し直す。CPU/BIOS は動かさないので軽い(Node 実測で実時間の約30倍)。
 * 速度1ではキャプチャ元のエミュレーションとサンプル単位で一致する(tools/headless/psf-replay-check.js)。
 *
 * インターフェースは SpcReplayStreamPlayer / HesReplayStreamPlayer と揃える:
 *   load(cap, totalFrames, mute) / play() / pause() / stop() / setSpeed(f) / seek(samplePos)
 *   applyMute(mute) / applyVolume(vol) / getPosition() / getDuration() / getCurrentFrame() / destroy()
 *   isPlaying, onEnded, onSilenceTimeout, preview(割当プレビュー), player(=this)
 *   spu … ライブ鍵盤表示が読む現在の SPU(MML.Emu.SpuPsx)
 * mute/vol はボイス番号 0..23 の配列(true=ミュート / 0..2)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE = 4096;
  const SPU_RATE = 44100;
  // 無音自動送り(他形式の Replay プレイヤーと同じ定数)
  const SILENCE_SEC = 10;
  const SILENCE_EPS = 1e-4;
  // 生の SPU 出力(-1..1)に掛ける係数。SPC(2.0)基準の体感音量に合わせて実測で決めた
  // (tools/headless/psf-loudness.js。emu-loudness-balance の手法)。2026-09-14 実測:
  //   SPC 12曲 生RMS平均 0.0343×2.0=0.0686 / PSF 30曲 生RMS平均 0.1143 → 0.60
  const OUTPUT_GAIN = 0.60;

  function createLimiter(audioCtx) {
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

  class PsfReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.player = this;         // main.js の「player.player.xxx」形状の前提に合わせる自己参照
      this.replay = null;         // MML.Emu.PsfReplay
      this.cap = null;
      this.totalFrames = 0;
      this.samplePos = 0;         // 出力サンプル(audioCtx.sampleRate)の経過数
      this.speedFactor = 1;
      this.isPlaying = false;
      this.onEnded = null;
      this.onSilenceTimeout = null;
      this.preview = null;
      this._mute = new Array(24).fill(false);
      this._vol = new Array(24).fill(1);
      this._frac = 0;             // 出力1サンプルあたりの SPU サンプル端数
      this._prevL = 0; this._prevR = 0; this._curL = 0; this._curR = 0;
      this._silentSamples = 0;
      this._previewFrame = -1;
      this._createNode();
    }

    get spu() { return this.replay ? this.replay.spu : null; }

    _createNode() {
      const ctx = this.audioCtx;
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = OUTPUT_GAIN;
      this.limiter = createLimiter(ctx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(ctx));
      this.node = ctx.createScriptProcessor(BUFFER_SIZE, 0, 2);
      this.node.connect(this.gainNode);
      this.node.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        if (!this.replay || !this.isPlaying) { outL.fill(0); outR.fill(0); return; }
        this._fill(outL, outR);
      };
    }

    /**
     * @param {object} cap  キャプチャ(進行中でよい。frameLog/ramLog が育っていく同じ参照)
     * @param {number} totalFrames キャプチャ予定の全フレーム数(60fps)
     * @param {Array<boolean>} [mute]
     */
    load(cap, totalFrames, mute) {
      this.stop();
      this.cap = cap;
      this.totalFrames = totalFrames;
      this.replay = new MML.Emu.PsfReplay(cap);
      this.replay.speed = this.speedFactor;
      this._applyChannelSettings();
      if (mute) this.applyMute(mute);
    }

    _applyChannelSettings() {
      const spu = this.spu;
      if (!spu) return;
      if (this._laneFrames) { this._maskFrame = -1; this._applyLaneMask(this.replay ? this.replay.frame : 0); return; }
      for (let i = 0; i < 24; i++) { spu.mute[i] = !!this._mute[i]; spu.vol[i] = this._vol[i]; }
    }

    /**
     * 合成ch/トラックモードの行単位ミュート・音量(main.js)。fn(frame) → そのフレームのレーン配列(各要素の slot=物理ボイス)、
     * null を返すと実機スロット扱い(mute/vol の添字=ボイス番号)。行(レーン)が使うボイスは発音のたびに変わるので、
     * フレームが変わるたびにボイス単位のミュートへ写し直す。
     */
    setLaneFrames(fn) {
      this._laneFrames = fn || null;
      this._maskFrame = -1;
      this._applyChannelSettings();
    }

    _applyLaneMask(frame) {
      const spu = this.spu;
      if (!spu) return;
      const lanes = this._laneFrames ? this._laneFrames(frame) : null;
      if (!lanes) { for (let i = 0; i < 24; i++) { spu.mute[i] = !!this._mute[i]; spu.vol[i] = this._vol[i]; } return; }
      for (let i = 0; i < 24; i++) { spu.mute[i] = false; spu.vol[i] = 1; }
      for (let li = 0; li < lanes.length; li++) {
        const c = lanes[li];
        if (!c || !(c.slot >= 0)) continue;
        if (this._mute[li]) spu.mute[c.slot] = true;
        if (this._vol[li] !== undefined) spu.vol[c.slot] = this._vol[li];
      }
    }

    _fill(outL, outR) {
      const replay = this.replay;
      const spu = replay.spu;
      const step = SPU_RATE / this.audioCtx.sampleRate;
      for (let i = 0; i < outL.length; i++) {
        this._frac += step;
        let stalled = false;
        while (this._frac >= 1) {
          if (replay.ended(this.totalFrames)) {
            for (let j = i; j < outL.length; j++) { outL[j] = 0; outR[j] = 0; }
            this.isPlaying = false;
            if (this.onEnded) this.onEnded();
            return;
          }
          if (!replay.ready()) { stalled = true; this._frac = Math.min(this._frac, 1); break; }
          if (this._laneFrames) { const lf = replay.frame; if (lf !== this._maskFrame) { this._maskFrame = lf; this._applyLaneMask(lf); } }
          replay.step();
          this._prevL = this._curL; this._prevR = this._curR;
          this._curL = spu.outL / 32768; this._curR = spu.outR / 32768;
          this._frac -= 1;
        }
        if (stalled) { outL[i] = 0; outR[i] = 0; continue; }
        // 44.1kHz → 出力レートの線形補間(_frac は次の SPU サンプルまでの進み具合)
        const t = this._frac;
        let l = this._prevL + (this._curL - this._prevL) * t;
        let r = this._prevR + (this._curR - this._prevR) * t;
        // 割当プレビュー(src/audio/assign-preview.js)
        const pv = this.preview && this.preview.enabled ? this.preview : null;
        if (pv) {
          const f = replay.frame;
          if (f !== this._previewFrame) { this._previewFrame = f; pv.onFrame(f); }
          const ps = pv.render();
          l += ps; r += ps;
        }
        outL[i] = l; outR[i] = r;
        this.samplePos++;
        if (Math.abs(l) < SILENCE_EPS && Math.abs(r) < SILENCE_EPS) {
          if (++this._silentSamples === Math.round(SILENCE_SEC * this.audioCtx.sampleRate) && this.onSilenceTimeout) this.onSilenceTimeout();
        } else {
          this._silentSamples = 0;
        }
      }
    }

    play() { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    stop() {
      this.isPlaying = false;
      if (this.replay) { this.replay.reset(); this._applyChannelSettings(); }
      this.samplePos = 0;
      this._frac = 0;
      this._prevL = this._prevR = this._curL = this._curR = 0;
      this._silentSamples = 0;
      this._previewFrame = -1;
    }

    setSpeed(factor) {
      this.speedFactor = factor;
      if (this.replay) this.replay.speed = factor;
    }

    /** samplePos: 出力レートでの位置(速度込みの実時間) */
    seek(samplePos) {
      if (!this.replay) return;
      const outRate = this.audioCtx.sampleRate;
      let frame = Math.floor((samplePos / outRate) * 60 * this.speedFactor);
      const avail = this.cap.frameLog.length;
      if (frame >= avail) {
        // 未キャプチャ範囲へのシーク: 記録済みの末尾へ寄せる(SpcReplayStreamPlayer と同じ理由)
        frame = Math.max(0, avail - 1);
        samplePos = (frame / 60 / this.speedFactor) * outRate;
      }
      frame = Math.min(frame, this.totalFrames - 1);
      this.replay.seekFrame(frame);
      this._applyChannelSettings();
      this.samplePos = samplePos;
      this._frac = 0;
      this._prevL = this._prevR = this._curL = this._curR = 0;
      this._silentSamples = 0;
      this._previewFrame = -1;
    }

    // mute/vol: ボイス配列、または main.js の getChannelMuteConfig() 形({expansion:{psx:[...]}})
    applyMute(mute) {
      if (mute && mute.expansion) mute = mute.expansion.psx;
      if (!mute) return;
      // 添字は行(実機スロットならボイス、合成ch/トラックならレーン)。レーンは24本を超えることがある
      for (let i = 0; i < Math.max(24, mute.length); i++) if (mute[i] !== undefined) this._mute[i] = !!mute[i];
      this._applyChannelSettings();
    }

    applyVolume(vol) {
      if (vol && vol.expansion) vol = vol.expansion.psx;
      if (!vol) return;
      for (let i = 0; i < Math.max(24, vol.length); i++) if (vol[i] !== undefined) this._vol[i] = Math.max(0, Math.min(2, vol[i]));
      this._applyChannelSettings();
    }

    getPosition() { return this.samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.totalFrames / 60 / this.speedFactor; }
    getCurrentFrame() { return this.replay ? Math.min(this.replay.frame, Math.max(0, this.totalFrames - 1)) : 0; }

    destroy() {
      this.isPlaying = false;
      // onaudioprocess のクロージャがキャプチャ(数MB)を掴んだままにしない(SpcReplayStreamPlayer と同じ理由)
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter) { this.limiter.disconnect(); this.limiter = null; }
      this.replay = null;
      this.cap = null;
    }
  }

  PsfReplayStreamPlayer.OUTPUT_GAIN = OUTPUT_GAIN;
  MML.Audio.PsfReplayStreamPlayer = PsfReplayStreamPlayer;
})(window);
