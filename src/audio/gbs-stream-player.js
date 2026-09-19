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

  // 無音自動送り(GbsReplayStreamPlayer)用。src/audio/stream-player.jsの同名定数と同じ考え方。
  const SILENCE_SEC = 10;
  const SILENCE_EPS = 1e-4;

  // gainNode(2.5)の後段にリミッタ(DynamicsCompressorNode)を挟み、複数チャンネル
  // (特にCH4ノイズ+他ch)が同時に鳴る密度の高い箇所でピークが±1.0を超えハードクリップ
  // するのを防ぐ(src/audio/stream-player.js・hes-stream-player.js createLimiter()と同じ
  // 考え方・同じ設計。GBSだけこの対策が漏れていた)。★実測: DMG-CWJ.gbs(Castlevania II)
  // で全chミックス時に瞬間ピークが±1.5前後(gain 2.5適用後)まで達し、密度の高い区間では
  // 全サンプルの6〜13%がハードクリップしていた。ノイズchはブロードバンドで瞬間ピークが
  // 相対的に大きいため、ハードクリップの影響を最も強く受けて元の"サー"というホワイト
  // ノイズが潰れ"プチプチ"というクラックリング音に変質して聴こえていた
  // (不具合の真因。CH4ノイズの音源自体・レジスタ値・パン処理はすべて正常だった)。
  function createLimiter(audioCtx) {
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0; // dB: 出力段が0dBFSに達する手前から効かせる
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

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

    // ★2026-08 SPCを基準に全フォーマットの体感音量を実測(RMS)揃え
    // (src/audio/stream-player.js NsfReplayStreamPlayer冒頭コメント参照)。
    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.35;
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
      // DCブロッキングフィルタの状態はL/Rで混ざるとクロストークになるためチャンネル毎に分離する
      this.dcPrevXL      = 0; this.dcPrevYL = 0;
      this.dcPrevXR      = 0; this.dcPrevYR = 0;
      this.isPlaying     = false;
      this.onEnded       = null;
      this.onSilenceTimeout = null;
      // 無音自動送り用の先読みスキャン状態(NsfReplayStreamPlayerと同じ設計、
      // src/audio/stream-player.js scanSilenceStep冒頭コメント参照)
      this._silenceFired    = false;
      this._silenceScanFrame = -1;
      this._scanDone         = false;
      this._scanApu = null;
      this._scanLastCh4TriggerSeq = -1;
      this._scanFrame = -1;
      this._scanSongFramePos = 0;
      this._scanCycleAccum = 0;
      this._scanDcPrevXL = 0; this._scanDcPrevYL = 0;
      this._scanDcPrevXR = 0; this._scanDcPrevYR = 0;
      this._scanSilentRun = 0;
      this._createNode();
    }

    // ★2026-08 SPCを基準に全フォーマットの体感音量を実測(RMS)揃え
    // (src/audio/stream-player.js NsfReplayStreamPlayer冒頭コメント参照)。
    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.35;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(this.audioCtx));

      // NR51(パンレジスタ)を反映するため2ch(ステレオ)出力にする
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
      this.apu = new MML.Emu.APUGb();
      // CH4(ノイズ)のLFSRロックアップ対策(_applyFrame冒頭コメント参照)用の
      // トリガ検出基準値。新品のAPUGbはlfsr=$7FFF(コンストラクタ既定値)なので
      // ここでは-1にしておけば良い(最初のトリガ検出で単に同じ$7FFFへ再設定されるだけで無害)。
      this._lastCh4TriggerSeq = -1;
      if (this._lastMute) this.applyMute(this._lastMute);
      if (this._lastVolume) this.applyVolume(this._lastVolume);
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
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      if (mute) this.applyMute(mute);
      this._resetScan(0);
    }

    _isFrameReady(f) {
      return !!(this.snapshots && this.snapshots[f]);
    }

    // スナップショットの値をライブAPUのチャンネルへ直接書き戻す(writeLog再生と違い
    // レジスタ解読が一切不要。timer/dutyStep/samplePos/lfsr等の連続位相はここでは
    // 触らず、clock()による自然な進行に任せる=音符境界での位相跳躍を避ける)。
    _applyFrame(f) {
      this.currentFrame = f;
      this._applySnapshotTo(this.apu, this.snapshots[f], 'lastCh4TriggerSeq');
    }

    // apu(ライブ/スキャンどちらのAPUGbインスタンスでも可)へスナップショットsを書き戻す
    // 共通処理。triggerSeqKeyは呼び出し側インスタンス上でtriggerSeq基準値を覚えておく
    // プロパティ名(ライブは_lastCh4TriggerSeq、スキャンは_scanLastCh4TriggerSeq)。
    _applySnapshotTo(apu, s, triggerSeqKey) {
      apu.ch1.freq = s.ch1.freq; apu.ch1.duty = s.ch1.duty; apu.ch1.envelope.volume = s.ch1.vol; apu.ch1.enabled = s.ch1.enabled;
      apu.ch2.freq = s.ch2.freq; apu.ch2.duty = s.ch2.duty; apu.ch2.envelope.volume = s.ch2.vol; apu.ch2.enabled = s.ch2.enabled;
      apu.ch3.freq = s.ch3.freq; apu.ch3.volumeShift = s.ch3.volumeShift; apu.ch3.enabled = s.ch3.enabled; apu.ch3.dacOn = s.ch3.dacOn;
      for (let i = 0; i < 32; i++) apu.ch3.wave[i] = s.ch3.wave[i];
      apu.ch4.envelope.volume = s.ch4.vol; apu.ch4.enabled = s.ch4.enabled;
      apu.ch4.clockShift = s.ch4.clockShift; apu.ch4.widthMode = s.ch4.widthMode; apu.ch4.divisorCode = s.ch4.divisorCode;
      // CH4のLFSRロックアップ対策: lfsr/timerは上記の方針どおり通常は触らないが、
      // LFSR(線形帰還シフトレジスタ)は数学的な性質上$0000へ到達すると以後ずっと$0000の
      // ままになる不動点を持つ(ビット0とビット1のXORが0のまま右シフトし続けるだけの
      // 状態に収束するため、自然には二度と抜け出せない)。実機はノート再トリガの
      // たびにlfsr=$7FFFへ強制リセットするためこの状態には陥らないが、このリプレイ
      // 経路はtriggerSeqを見ていないため、長時間再生しているとまれに$0000へ迷い込み
      // 「ホワイトノイズがプチノイズに変質したまま戻らない」不具合になっていた
      // (実測: DMG-CWJ.gbs index9で約52秒経過時にlfsr=0で固着、シーク[=APU再構築で
      // lfsr=$7FFFへ復帰]すると直る、という症状から特定)。triggerSeqの変化(=このフレームで
      // 新しくトリガされた)を検出した時だけ、実機のtrigger()と同じくlfsr/timerを
      // リセットする(triggerSeq自体はgbs2mml用に既にスナップショットへ入っている)。
      if (s.ch4.triggerSeq !== undefined && s.ch4.triggerSeq !== this[triggerSeqKey]) {
        this[triggerSeqKey] = s.ch4.triggerSeq;
        apu.ch4.lfsr = 0x7FFF;
        apu.ch4.timer = apu.ch4.periodT();
      }
      // NR50/NR51(古いキャプチャ結果には無いフィールドなのでフォールバックはAPUGbの
      // ブート後既定値と同じにしておく)。gbsPlayer.js snapshotApu()冒頭コメント参照。
      apu.nr50 = s.nr50 !== undefined ? s.nr50 : 0x77;
      apu.nr51 = s.nr51 !== undefined ? s.nr51 : 0xF3;
    }

    // ===== 無音自動送り: 先読みスキャン(NsfReplayStreamPlayerと同じ設計) =====
    _scanBuildApu() {
      this._scanApu = new MML.Emu.APUGb();
      this._scanLastCh4TriggerSeq = -1;
      if (this._lastMute) {
        const exp = this._lastMute.expansion || this._lastMute;
        // ★ミュートはスキャンへ反映しない(聴き方の設定であって曲の内容ではないため。
        //   全chミュートで「曲が終わった」と誤判定して次の曲へ飛ぶのを防ぐ)
      }
      if (this._lastVolume) {
        const exp = this._lastVolume.expansion || this._lastVolume;
        if (exp.gb) MML.Emu.applyVolume(this._scanApu.vol, exp.gb);
      }
    }

    _scanApplyFrame(f) {
      this._scanFrame = f;
      this._applySnapshotTo(this._scanApu, this.snapshots[f], '_scanLastCh4TriggerSeq');
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
        while (this._scanCycleAccum >= 1) {
          this._scanApu.clock();
          this._scanCycleAccum -= 1;
        }
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
        if (!this._isFrameReady(f)) {
          // バックグラウンドキャプチャがまだこのフレームに追いついていない(KssReplayStreamPlayerと同じ理由)
          outL[i] = 0; outR[i] = 0;
          continue;
        }
        this._songFramePos = nextSongFramePos;
        const pv = this.preview && this.preview.enabled ? this.preview : null; // 割当プレビュー(src/audio/assign-preview.js)
        if (f !== this.currentFrame) { this._applyFrame(f); if (pv) pv.onFrame(f); }

        this.cycleAccum += this.clockHz / sr;
        while (this.cycleAccum >= 1) {
          this.apu.clock();
          this.cycleAccum -= 1;
        }
        const raw = this.apu.mixSample();
        const yL = raw.left  - this.dcPrevXL + 0.999 * this.dcPrevYL;
        const yR = raw.right - this.dcPrevXR + 0.999 * this.dcPrevYR;
        this.dcPrevXL = raw.left;  this.dcPrevYL = yL;
        this.dcPrevXR = raw.right; this.dcPrevYR = yR;
        if (pv) { const s = pv.render(); outL[i] = yL + s; outR[i] = yR + s; } else { outL[i] = yL; outR[i] = yR; }
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
      if (this.header) this._buildApu();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      this._resetScan(0);
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
      this.dcPrevXL = this.dcPrevYL = this.dcPrevXR = this.dcPrevYR = 0;
      this._resetScan(targetFrame);
    }

    // {gb:{ch1,ch2,ch3,ch4}}形状(GbsStreamPlayer.applyMuteと同じ読み方)
    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute; // _buildChips()(シーク等でチップを作り直すたび)に再適用するため保持
      if (!this.apu) return;
      const exp = mute.expansion || mute;
      if (exp.gb) Object.assign(this.apu.mute, exp.gb);
      // 再生中のミュート切替は無音判定の基準に影響するため先読みスキャンをやり直す
      if (this.header) this._resetScan(Math.max(0, this.currentFrame));
    }

    // {gb:{ch1,ch2,ch3,ch4}}形状(applyMuteと同じ)だが値は0〜1
    applyVolume(volume) {
      if (!volume) return;
      this._lastVolume = volume;
      if (!this.apu) return;
      const exp = volume.expansion || volume;
      if (exp.gb) MML.Emu.applyVolume(this.apu.vol, exp.gb);
      if (this.header) this._resetScan(Math.max(0, this.currentFrame));
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
      // snapshots(数分の曲の全フレーム分)を保持したままだと、ファイルを連続で開き直す
      // たびに解放されず蓄積してしまうため、破棄時に明示的に参照を切る。
      this.apu       = null;
      this._scanApu  = null;
      this.snapshots = null;
    }
  }

  MML.Audio.GbsStreamPlayer = GbsStreamPlayer;
  MML.Audio.GbsReplayStreamPlayer = GbsReplayStreamPlayer;
})(window);
