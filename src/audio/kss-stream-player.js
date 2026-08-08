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
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter) { this.limiter.disconnect(); this.limiter = null; }
      this.player = null;
      this.frameBuffer = null;
    }
  }

  // =========================================================
  // KssReplayStreamPlayer
  // =========================================================
  // KSS実ファイルを「Z80 CPUを実行しながら音声も生成する」KssStreamPlayerとは異なり、
  // バックグラウンドで先行実行された(regsOnly)Z80キャプチャ(kssPlayer.js
  // captureKssSongAsyncのwriteLog、フレームごとの{addr,value,io}[])を「実CPU抜きで」
  // チップへ再適用するだけで音声合成する。src/audio/stream-player.jsの
  // NsfReplayStreamPlayerと同じ設計(seek=0からの書き込み再適用、applyMute=チップの
  // mute配列をライブ書き換え)。
  // KSSはKssBus.write()がPLAYルーチンの通常メモリ書き込みも含めて全てonWriteへ渡す
  // ため(NsfBusと違い、$4000-4017のような「音源レジスタだけ」への絞り込みが無い)、
  // writeLogが既にバンク切替も含む完全な書き込み履歴になっており、追加のinitWrites
  // 概念は不要(captureKssSongAsyncはINIT中の書き込みをwriteLog[0]の先頭に含めて渡す)。
  // また、KssPlayer.renderFrame()自体がregsOnly時もpsg.clock()/scc.clock()/opll.clock()を
  // 省略しない設計になっている(NSFのcapture.js regsOnlyで見つかった「クロックごと省略」
  // バグと同じ穴がKSSには無い)ため、capture.js側の追加修正は不要だった。
  class KssReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx        = audioCtx;
      this.node            = null;
      this.gainNode        = null;
      this.bus             = null;
      // liveKssPsg/liveKssScc/liveKssOpll(main.js)は「kssActivePlayer.player.psg」の
      // ような形状を前提にしている。自己参照させることでこれらのヘルパーを一切
      // 変更せずに再利用できる(NsfReplayStreamPlayerと同じ手法)。
      this.player           = this;
      this.psg              = null;
      this.scc              = null;
      this.opll             = null;
      this._headerOpt       = null; // busOpt相当(header/songData)
      this.writeLog         = null; // captureKssSongAsyncが進行中に育てる配列への参照
      this.totalFrames      = 0;
      this.frameRate        = 60;
      this.clockHz          = 0;
      this.samplePos        = 0;
      this.currentFrame     = -1;
      this.cycleAccum       = 0;
      this.speedFactor      = 1;
      this._songFramePos    = 0;
      this.dcPrevX          = 0;
      this.dcPrevY          = 0;
      this.isPlaying        = false;
      this.onEnded          = null;
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
        if (!this.bus || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    // KssPlayerのコンストラクタと同じ手順でbus/チップを作り直す(load()時・seek()時両方から呼ぶ)
    _buildChips() {
      const { header, songData } = this._headerOpt;
      this.bus = new MML.Emu.KssBus(header, songData);
      this.psg = new MML.Emu.AY8910Audio();
      this.scc = new MML.Emu.SCCAudio();
      this.bus.registerChip('psg', this.psg);
      this.bus.registerChip('scc', this.scc);
      if (header.device.mode === 'MSX' && header.device.fmpac) {
        this.opll = new MML.Emu.OPLLAudio();
        this.bus.registerChip('opll', this.opll);
      } else {
        this.opll = null;
      }
      if (this._lastMute) this.applyMute(this._lastMute);
    }

    // capture: {writeLog}(captureKssSongAsyncのonProgress由来。進行中配列への参照なので
    // 呼び出し後もキャプチャが進むにつれ自動的に埋まっていく)
    load(kssBytes, songIndex, totalFrames, capture, mute) {
      this.stop();
      const header = MML.KSS.parseHeader(kssBytes);
      const songData = kssBytes.slice(header.dataOffset);
      this._headerOpt = { header, songData };
      this.frameRate = header.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;
      this.clockHz = MML.KSS.Z80_CLOCK;
      this.writeLog = capture.writeLog;
      this.totalFrames = totalFrames;
      this._buildChips();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevX = this.dcPrevY = 0;
      if (mute) this.applyMute(mute);
    }

    _isFrameReady(f) {
      return !!(this.writeLog && this.writeLog[f]);
    }

    _applyWrites(writes) {
      if (!writes) return;
      for (const w of writes) {
        if (w.io) this.bus.ioWrite(w.addr, w.value);
        else this.bus.write(w.addr, w.value);
      }
    }

    _applyFrame(f) {
      this.currentFrame = f;
      this._applyWrites(this.writeLog[f]);
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
          // バックグラウンドキャプチャがまだこのフレームに追いついていない。
          // 無音のまま位置を凍結し、次のコールバックで同じフレームを再試行する
          // (NsfReplayStreamPlayerと同じ理由: samplePosを進めるとgetPosition()が
          // 実際には再生していないのにdurationに到達したと誤認し自動停止してしまう)。
          out[i] = 0;
          continue;
        }
        this._songFramePos = nextSongFramePos;
        if (f !== this.currentFrame) this._applyFrame(f);

        this.cycleAccum += this.clockHz / sr;
        while (this.cycleAccum >= 1) {
          this.psg.clock();
          this.scc.clock();
          if (this.opll) this.opll.clock();
          this.cycleAccum -= 1;
        }
        let raw = this.psg.mixSample() + this.scc.mixSample();
        if (this.opll) raw += this.opll.mixSample();
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
      if (this._headerOpt) this._buildChips();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    setSpeed(factor) { this.speedFactor = factor; }

    // targetFrameの直前まで(0..targetFrame、キャプチャが追いついていなければその手前まで)の
    // 書き込みをbus/チップへ再適用してシークする(NsfReplayStreamPlayer.seek()と同じ考え方)。
    seek(samplePos) {
      const sr = this.audioCtx.sampleRate;
      let songFramePos = (samplePos / sr) * this.frameRate * this.speedFactor;
      let targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      const wl = this.writeLog || [];
      if (targetFrame >= 0 && !wl[targetFrame]) {
        // 未キャプチャ範囲へのシーク: バッファ済み末尾にクランプし、samplePos/
        // songFramePosも合わせて再計算する(そうしないとgetPosition()が矛盾した
        // 位置を報告し続け、_isFrameReady(f)==falseのスタール状態に陥る)。
        while (targetFrame > 0 && !wl[targetFrame]) targetFrame--;
        songFramePos = targetFrame;
        samplePos = (songFramePos / this.frameRate / this.speedFactor) * sr;
      }
      this._buildChips();
      this.cycleAccum = 0;
      for (let f = 0; f <= targetFrame; f++) {
        const writes = wl[f];
        if (!writes) break;
        this._applyWrites(writes);
      }
      this.samplePos     = samplePos;
      this.currentFrame  = targetFrame;
      this._songFramePos = songFramePos;
      this.dcPrevX = this.dcPrevY = 0;
    }

    // keyboardDisplay.getMuteConfig()と同じ{apu:{},expansion:{psg,scc,opll}}形式
    // (既存KssStreamPlayer.applyMuteと同じ読み方、{psg,scc,opll}直下形式も後方互換で受ける)
    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute; // _buildChips()(シーク等でチップを作り直すたび)に再適用するため保持
      if (!this.psg) return;
      const exp = mute.expansion || mute;
      if (exp.psg) MML.Emu.applyMute(this.psg.mute, exp.psg);
      if (exp.scc) MML.Emu.applyMute(this.scc.mute, exp.scc);
      if (exp.opll && this.opll) MML.Emu.applyMute(this.opll.mute, exp.opll);
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
      if (this.limiter)  { this.limiter.disconnect();  this.limiter = null; }
      // writeLog(数分の曲の全フレーム書き込みログ)を保持したままだと、ファイルを
      // 連続で開き直すたびに解放されず蓄積してしまうため、破棄時に明示的に参照を切る。
      this.bus      = null;
      this.psg      = null;
      this.scc      = null;
      this.opll     = null;
      this.writeLog = null;
    }
  }

  MML.Audio.KssStreamPlayer = KssStreamPlayer;
  MML.Audio.KssReplayStreamPlayer = KssReplayStreamPlayer;
})(window);
