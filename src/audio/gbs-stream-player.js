/*
 * GBS ストリーミング再生プレイヤー (ScriptProcessorNode)
 * MML.Audio.GbsStreamPlayer / MML.Audio.GbsReplayStreamPlayer
 *
 * GbsStreamPlayerはKssStreamPlayer(実CPU駆動の直接再生版)と同じ設計。
 * GbsReplayStreamPlayerはKssReplayStreamPlayerに相当する「先読みキャプチャを再生に
 * 使い回す」版だが、KSSのようなwriteLog再生ではなく、captureGbsSongAsyncが積む
 * APUライブスナップショット(gbsPlayer.js参照)をそのままチャンネルへ書き戻す方式にした。
 * GBSはgbsPlayer.js側の設計変更(CH1スイープ・エンベロープが内部クロックのみで進行し
 * writeLog再生では追えないと判明)によりスナップショット方式へ統一済みで、こちらも
 * それに合わせるのが自然かつシンプル(レジスタ書込みの再現ロジックが一切不要になる)。
 * seek()もフレーム0から再生し直す必要が無く、対象フレームのスナップショットを
 * 直接適用するだけで済む(KssReplayStreamPlayer.seek()のようなwriteLog再生ループ不要)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE = 4096;

  class GbsStreamPlayer {
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
      this.gainNode.gain.value = 2.5;
      this.gainNode.connect(this.audioCtx.destination);

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

    load(gbsBytes, songIndex, totalFrames, mute) {
      this.stop();
      this.player = new MML.Emu.GbsPlayer(gbsBytes);
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

    // keyboardDisplay.getMuteConfig()と同じ{apu:{},expansion:{gb:{ch1,ch2,ch3,ch4}}}形式
    // (KssStreamPlayer.applyMuteと同じ読み方)
    applyMute(mute) {
      if (!mute || !this.player) return;
      const exp = mute.expansion || mute;
      if (exp.gb) Object.assign(this.player.apu.mute, exp.gb);
    }

    getPosition() {
      return this._samplePos / this.audioCtx.sampleRate;
    }

    getDuration() {
      return this.totalFrames / this.player.frameRate;
    }

    destroy() {
      this.isPlaying = false;
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      this.player = null;
      this.frameBuffer = null;
    }
  }

  // =========================================================
  // GbsReplayStreamPlayer
  // =========================================================
  class GbsReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx      = audioCtx;
      this.node          = null;
      this.gainNode      = null;
      this.apu           = null;
      this.player        = this; // liveGbsXxx系ヘルパーが player.apu 形状を前提にする場合に備えた自己参照
      this.header        = null;
      this.snapshots     = null; // captureGbsSongAsyncが進行中に育てる配列への参照
      this.totalFrames   = 0;
      this.frameRate     = 60;
      this.clockHz       = 0;
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this.cycleAccum    = 0;
      this.speedFactor   = 1;
      this._songFramePos = 0;
      this.dcPrevX       = 0;
      this.dcPrevY       = 0;
      this.isPlaying     = false;
      this.onEnded       = null;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 2.5;
      this.gainNode.connect(this.audioCtx.destination);

      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.connect(this.gainNode);

      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        if (!this.apu || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    _buildApu() {
      this.apu = new MML.Emu.APUGb();
      if (this._lastMute) this.applyMute(this._lastMute);
    }

    // capture: {snapshots}(captureGbsSongAsyncのonProgress由来。進行中配列への参照なので
    // 呼び出し後もキャプチャが進むにつれ自動的に埋まっていく)
    load(gbsBytes, songIndex, totalFrames, capture, mute) {
      this.stop();
      this.header = MML.GBS.parseHeader(gbsBytes);
      this.frameRate = this.header.playFps;
      this.clockHz = MML.GBS.CPU_CLOCK;
      this.snapshots = capture.snapshots;
      this.totalFrames = totalFrames;
      this._buildApu();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevX = this.dcPrevY = 0;
      if (mute) this.applyMute(mute);
    }

    _isFrameReady(f) {
      return !!(this.snapshots && this.snapshots[f]);
    }

    // スナップショットの値をライブAPUのチャンネルへ直接書き戻す(writeLog再生と違い
    // レジスタ解読が一切不要。timer/dutyStep/samplePos/lfsr等の連続位相はここでは
    // 触らず、clock()による自然な進行に任せる=音符境界での位相跳躍を避ける)。
    _applyFrame(f) {
      this.currentFrame = f;
      const s = this.snapshots[f];
      const apu = this.apu;
      apu.ch1.freq = s.ch1.freq; apu.ch1.duty = s.ch1.duty; apu.ch1.envelope.volume = s.ch1.vol; apu.ch1.enabled = s.ch1.enabled;
      apu.ch2.freq = s.ch2.freq; apu.ch2.duty = s.ch2.duty; apu.ch2.envelope.volume = s.ch2.vol; apu.ch2.enabled = s.ch2.enabled;
      apu.ch3.freq = s.ch3.freq; apu.ch3.volumeShift = s.ch3.volumeShift; apu.ch3.enabled = s.ch3.enabled; apu.ch3.dacOn = s.ch3.dacOn;
      for (let i = 0; i < 32; i++) apu.ch3.wave[i] = s.ch3.wave[i];
      apu.ch4.envelope.volume = s.ch4.vol; apu.ch4.enabled = s.ch4.enabled;
      apu.ch4.clockShift = s.ch4.clockShift; apu.ch4.widthMode = s.ch4.widthMode; apu.ch4.divisorCode = s.ch4.divisorCode;
    }

    _fill(out) {
      const sr = this.audioCtx.sampleRate;
      for (let i = 0; i < out.length; i++) {
        const nextSongFramePos = this._songFramePos + (this.frameRate / sr) * this.speedFactor;
        const f = Math.floor(nextSongFramePos);
        if (f >= this.totalFrames) {
          for (let j = i; j < out.length; j++) out[j] = 0;
          this.isPlaying = false;
          if (this.onEnded) this.onEnded();
          return;
        }
        if (!this._isFrameReady(f)) {
          // バックグラウンドキャプチャがまだこのフレームに追いついていない(KssReplayStreamPlayerと同じ理由)
          out[i] = 0;
          continue;
        }
        this._songFramePos = nextSongFramePos;
        if (f !== this.currentFrame) this._applyFrame(f);

        this.cycleAccum += this.clockHz / sr;
        while (this.cycleAccum >= 1) {
          this.apu.clock();
          this.cycleAccum -= 1;
        }
        const raw = this.apu.mixSample();
        const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
        this.dcPrevX = raw; this.dcPrevY = y;
        out[i] = y;
        this.samplePos++;
      }
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
      this.dcPrevX = this.dcPrevY = 0;
    }

    setSpeed(factor) { this.speedFactor = factor; }

    // 対象フレームのスナップショットを直接適用するだけで済む(writeLog再生と違い
    // フレーム0からの再生ループが不要。KssReplayStreamPlayer.seek()より単純)。
    seek(samplePos) {
      const sr = this.audioCtx.sampleRate;
      let songFramePos = (samplePos / sr) * this.frameRate * this.speedFactor;
      let targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      const snaps = this.snapshots || [];
      if (targetFrame >= 0 && !snaps[targetFrame]) {
        // 未キャプチャ範囲へのシーク: バッファ済み末尾にクランプする(NsfReplayStreamPlayerと同じ考え方)
        while (targetFrame > 0 && !snaps[targetFrame]) targetFrame--;
        songFramePos = targetFrame;
        samplePos = (songFramePos / this.frameRate / this.speedFactor) * sr;
      }
      this._buildApu();
      this.cycleAccum = 0;
      if (targetFrame >= 0 && snaps[targetFrame]) this._applyFrame(targetFrame);
      this.samplePos     = samplePos;
      this.currentFrame  = targetFrame;
      this._songFramePos = songFramePos;
      this.dcPrevX = this.dcPrevY = 0;
    }

    // {gb:{ch1,ch2,ch3,ch4}}形状(GbsStreamPlayer.applyMuteと同じ読み方)
    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute; // _buildChips()(シーク等でチップを作り直すたび)に再適用するため保持
      if (!this.apu) return;
      const exp = mute.expansion || mute;
      if (exp.gb) Object.assign(this.apu.mute, exp.gb);
    }

    getPosition() {
      return this.samplePos / this.audioCtx.sampleRate;
    }

    getDuration() {
      return this.totalFrames / this.frameRate / this.speedFactor;
    }

    getCurrentFrame() {
      return Math.max(0, this.currentFrame);
    }

    destroy() {
      this.isPlaying = false;
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      // snapshots(数分の曲の全フレーム分)を保持したままだと、ファイルを連続で開き直す
      // たびに解放されず蓄積してしまうため、破棄時に明示的に参照を切る。
      this.apu       = null;
      this.snapshots = null;
    }
  }

  MML.Audio.GbsStreamPlayer = GbsStreamPlayer;
  MML.Audio.GbsReplayStreamPlayer = GbsReplayStreamPlayer;
})(window);
