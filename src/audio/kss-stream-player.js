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

  // 無音自動送り(KssReplayStreamPlayer)用。src/audio/stream-player.jsの同名定数と同じ考え方。
  const SILENCE_SEC = 10;
  const SILENCE_EPS = 1e-4;

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

    // ★2026-08 SPCを基準に全フォーマットの体感音量を実測(RMS)揃え
    // (src/audio/stream-player.js NsfReplayStreamPlayer冒頭コメント参照)。
    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.99;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(this.audioCtx));

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
      if (exp.opl && this.player.opl) MML.Emu.applyMute(this.player.opl.mute, exp.opl);
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
      this.opl              = null; // MSX-AUDIO(Y8950)
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
      this.onSilenceTimeout = null;
      // 無音自動送り用の先読みスキャン状態(NsfReplayStreamPlayerと同じ設計、
      // src/audio/stream-player.js scanSilenceStep冒頭コメント参照)
      this._silenceFired    = false;
      this._silenceScanFrame = -1;
      this._scanDone         = false;
      this._scanBus = null; this._scanPsg = null; this._scanScc = null; this._scanOpll = null; this._scanOpl = null;
      this._scanFrame = -1;
      this._scanSongFramePos = 0;
      this._scanCycleAccum = 0;
      this._scanDcPrevX = 0; this._scanDcPrevY = 0;
      this._scanSilentRun = 0;
      this._createNode();
    }

    // ★2026-08 SPCを基準に全フォーマットの体感音量を実測(RMS)揃え
    // (src/audio/stream-player.js NsfReplayStreamPlayer冒頭コメント参照)。
    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.99;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(this.audioCtx));

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
      // MSX-AUDIO(Y8950): kssPlayer.jsと同じ配線(3.58MHz、ポート0xC0/0xC1はバスが振り分ける)
      if (header.device.mode === 'MSX' && header.device.msxAudio && MML.Emu.OPLAudio) {
        this.opl = new MML.Emu.OPLAudio(MML.KSS.Z80_CLOCK, { type: 'y8950' });
        this.bus.registerChip('opl', this.opl);
      } else {
        this.opl = null;
      }
      if (this._lastMute) this.applyMute(this._lastMute);
      if (this._lastVolume) this.applyVolume(this._lastVolume);
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
      this._resetScan(0);
    }

    _isFrameReady(f) {
      return !!(this.writeLog && this.writeLog[f]);
    }

    // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24
    _applyWrites(writes) {
      if (!writes) return;
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF;
        if ((pw >> 24) & 1) this.bus.ioWrite(addr, value);
        else this.bus.write(addr, value);
      }
    }

    _applyFrame(f) {
      this.currentFrame = f;
      this._applyWrites(this.writeLog[f]);
    }

    // ===== 無音自動送り: 先読みスキャン(NsfReplayStreamPlayerと同じ設計) =====
    _scanBuildChips() {
      const { header, songData } = this._headerOpt;
      this._scanBus = new MML.Emu.KssBus(header, songData);
      this._scanPsg = new MML.Emu.AY8910Audio();
      this._scanScc = new MML.Emu.SCCAudio();
      this._scanBus.registerChip('psg', this._scanPsg);
      this._scanBus.registerChip('scc', this._scanScc);
      if (header.device.mode === 'MSX' && header.device.fmpac) {
        // ★2026-08-22: スキャンは「無音が10秒続いたか」しか見ないのでサイクル精度は不要。
        // Nukedコアは実測で旧コアの約3倍重く、しかもこのスキャンは主スレッド(rAF)で回るため
        // 実再生のScriptProcessorNodeと食い合ってカクつきの原因になる。ここは軽い旧コア固定。
        this._scanOpll = new MML.Emu.OPLLAudio({ core: 'legacy' });
        this._scanBus.registerChip('opll', this._scanOpll);
      } else {
        this._scanOpll = null;
      }
      if (header.device.mode === 'MSX' && header.device.msxAudio && MML.Emu.OPLAudio) {
        this._scanOpl = new MML.Emu.OPLAudio(MML.KSS.Z80_CLOCK, { type: 'y8950' });
        this._scanBus.registerChip('opl', this._scanOpl);
      } else {
        this._scanOpl = null;
      }
      // ★ミュート/ch別音量はスキャンへ反映しない。これらは「聴き方」の設定であって曲の
      // 内容ではないため、全chミュートすると曲が終わったと誤判定して次の曲へ飛んでしまう
      // (ユーザー報告。以前は「実再生と無音判定基準を揃える」ため反映していた)。
      if (this._lastVolume) {
        const exp = this._lastVolume.expansion || this._lastVolume;
        if (exp.psg) MML.Emu.applyVolume(this._scanPsg.vol, exp.psg);
        if (exp.scc) MML.Emu.applyVolume(this._scanScc.vol, exp.scc);
        if (exp.opll && this._scanOpll) MML.Emu.applyVolume(this._scanOpll.vol, exp.opll);
        if (exp.opl && this._scanOpl) MML.Emu.applyVolume(this._scanOpl.vol, exp.opl);
      }
    }

    _scanApplyWrites(writes) {
      if (!writes) return;
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF;
        if ((pw >> 24) & 1) this._scanBus.ioWrite(addr, value);
        else this._scanBus.write(addr, value);
      }
    }

    _scanApplyFrame(f) {
      this._scanFrame = f;
      this._scanApplyWrites(this.writeLog[f]);
    }

    _resetScan(fromFrame) {
      if (!this._headerOpt) return;
      this._scanBuildChips();
      this._scanCycleAccum = 0;
      this._scanDcPrevX = this._scanDcPrevY = 0;
      this._scanSilentRun = 0;
      this._silenceScanFrame = -1;
      this._silenceFired = false;
      this._scanDone = false;
      this._scanFrame = -1;
      const wl = this.writeLog || [];
      let f = 0;
      for (; f <= fromFrame; f++) {
        if (!wl[f]) break;
        this._scanApplyFrame(f);
      }
      this._scanSongFramePos = Math.min(f, fromFrame + 1);
    }

    scanSilenceStep(budgetSongSeconds) {
      if (this._scanDone || this._silenceScanFrame >= 0 || !this._scanBus) return;
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
        while (this._scanCycleAccum >= 1) {
          this._scanPsg.clock();
          this._scanScc.clock();
          if (this._scanOpll) this._scanOpll.clock();
          if (this._scanOpl) this._scanOpl.clock();
          this._scanCycleAccum -= 1;
        }
        let raw = this._scanPsg.mixSample() + this._scanScc.mixSample();
        if (this._scanOpll) raw += this._scanOpll.mixSample();
        if (this._scanOpl) raw += this._scanOpl.mixSample() * 0.7;
        const y = raw - this._scanDcPrevX + 0.999 * this._scanDcPrevY;
        this._scanDcPrevX = raw; this._scanDcPrevY = y;

        if (Math.abs(y) < SILENCE_EPS) {
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
        const pv = this.preview && this.preview.enabled ? this.preview : null; // 割当プレビュー(src/audio/assign-preview.js)
        if (f !== this.currentFrame) { this._applyFrame(f); if (pv) pv.onFrame(f); }

        this.cycleAccum += this.clockHz / sr;
        while (this.cycleAccum >= 1) {
          this.psg.clock();
          this.scc.clock();
          if (this.opll) this.opll.clock();
          if (this.opl) this.opl.clock();
          this.cycleAccum -= 1;
        }
        let raw = this.psg.mixSample() + this.scc.mixSample();
        if (this.opll) raw += this.opll.mixSample();
        if (this.opl) raw += this.opl.mixSample() * 0.7; // 0.7=VGM較正比(opl 1.4/ym2413 1.99)
        const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
        this.dcPrevX = raw; this.dcPrevY = y;
        out[i] = pv ? y + pv.render() : y;
        this.samplePos++;
        if (this._silenceScanFrame >= 0 && !this._silenceFired && f >= this._silenceScanFrame) {
          // ★ミュート中は通知しない(main.js syncSilenceDetect)
          if (this.silenceDetectEnabled === false) continue;
          this._silenceFired = true;
          if (this.onSilenceTimeout) this.onSilenceTimeout();
        }
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
      this._resetScan(0);
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
      this._resetScan(targetFrame);
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
      if (exp.opl && this.opl) MML.Emu.applyMute(this.opl.mute, exp.opl);
      // 再生中のミュート切替は無音判定の基準に影響するため先読みスキャンをやり直す
      if (this._headerOpt) this._resetScan(Math.max(0, this.currentFrame));
    }

    // {apu:{},expansion:{psg,scc,opll}}形式(applyMuteと同じ)だが値は0〜1
    applyVolume(volume) {
      if (!volume) return;
      this._lastVolume = volume;
      if (!this.psg) return;
      const exp = volume.expansion || volume;
      if (exp.psg) MML.Emu.applyVolume(this.psg.vol, exp.psg);
      if (exp.scc) MML.Emu.applyVolume(this.scc.vol, exp.scc);
      if (exp.opll && this.opll) MML.Emu.applyVolume(this.opll.vol, exp.opll);
      if (exp.opl && this.opl) MML.Emu.applyVolume(this.opl.vol, exp.opl);
      if (this._headerOpt) this._resetScan(Math.max(0, this.currentFrame));
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
      this._scanBus  = null;
      this._scanPsg  = null;
      this._scanScc  = null;
      this._scanOpll = null;
      this.writeLog = null;
    }
  }

  MML.Audio.KssStreamPlayer = KssStreamPlayer;
  MML.Audio.KssReplayStreamPlayer = KssReplayStreamPlayer;
})(window);
