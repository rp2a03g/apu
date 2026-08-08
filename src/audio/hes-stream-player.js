/*
 * HES ストリーミング再生プレイヤー
 * MML.Audio.HesStreamPlayer / MML.Audio.HesReplayStreamPlayer / MML.Audio.HesBufferedPlayer
 *
 * gbs-stream-player.js と同じ設計(HesStreamPlayer=実CPU駆動の直接再生版、
 * HesReplayStreamPlayer=先読みキャプチャのAPUライブスナップショットを再生に使い回す版)。
 * HESはPSGの波形/ノイズ位相が内部クロックのみで進行するため、writeLog再生ではなく
 * スナップショット方式に統一する(gbsPlayer.js/hesPlayer.jsと同じ理由)。
 *
 * ★2026-08: HesStreamPlayer(ScriptProcessorNode、onaudioprocess内でhesPlayer.js
 * renderFrame()を毎回呼びCPU/PSGを実時間で回す方式)はDDA(PCM)の高頻度書込みを正しく
 * 再現するために導入したが、HESは他フォーマット(NSF/GBS/KSS)と違い「PLAYを1回呼んで
 * 単純な音源更新をするだけ」では済まず、7.16MHz相当のCPU命令列を本当に実時間で回し
 * 続ける必要がある。hesBus.js/apuHuC6280.jsのclockBy()バッチ化で関数呼出しの
 * オーバーヘッド自体は削減したが、それでも「メインスレッド上のScriptProcessorNode
 * コールバック内でCPUエミュレーションを回す」という設計そのものが重く、UI更新等の
 * メインスレッド競合と相まって音切れ(ユーザー報告の「がくがく」)が解消しなかった。
 * 他フォーマットのストリーミング再生(NsfStreamPlayer等)がAPUクロックのみで
 * 済んでいるのに対し、HESだけCPU命令実行までリアルタイムで担っている点が根本的に
 * 割に合わない。captureHesSongAsync()は既にオフライン一括レンダリング(音声波形を
 * 事前に全部計算する)経路を持っており(hes2mml変換で使用、実測で実時間の1/10程度で
 * 完了する)、これをそのまま再生にも使い回すHesBufferedPlayerを追加した:
 * 事前に全波形をレンダリングしAudioBufferへ詰めてAudioBufferSourceNodeで再生する
 * ため、再生中は一切エミュレーションを行わず(ブラウザネイティブの再生パイプラインに
 * 任せるだけ)、メインスレッドが混雑していても音切れが起きない。
 * 代わりに「再生開始までにレンダリング待ちが発生する」「速度変更(再生速度スライダー)は
 * AudioBufferSourceNode.playbackRateではなく都度オフライン再レンダリングで対応する
 * (playbackRateはピッチも一緒に変わるテープ速度方式のため、既に対応済みの
 * 音程を変えないテンポ変更[hesPlayer.js renderFrame()冒頭コメント参照]と矛盾する)」
 * というトレードオフを払う。
 * ★ミュートについて: 当初は6ch合算済みの1本のAudioBufferにレンダリングしていたため、
 * 録音後に特定chだけをミュートすることができなかった(ユーザー指摘)。captureHesSongAsync()の
 * perChannelAudioオプション(hesPlayer.js)でchごとに独立したFloat32Arrayを受け取るようにし、
 * 後述のScriptProcessorNode側で毎サンプルch別ゲインを掛けてから合算する方式に変更、
 * 再生中でも即座にミュートを反映できるようにした。
 * ★2026-08 その2: 「レンダリング完了を待たず、他フォーマット(NSF/KSS/SPC)同様に
 * バックグラウンドキャプチャの先読みが追いついた範囲まで再生できるようにしてほしい」
 * 「レンダリング中に曲送りすると以後ボタンが一切反応しなくなる」という指摘を受け、
 * AudioBufferSourceNode(バッファ全体が揃うまでstart()できない)をやめ、
 * ScriptProcessorNodeでchごとの配列(channelAudio、captureHesSongAsync()のopt.channelAudioOutで
 * 渡した「今まさに埋まっていっている」配列そのもの)を直接読みながら再生する方式に変更した
 * (NsfReplayStreamPlayer/main.js playNsfStream()の「writeLog/regSnapshotsをバックグラウンド
 * キャプチャと共有し、埋まった分だけ再生する」設計と同じ考え方)。読み出し位置が
 * まだレンダリングの追いついていないサンプルに達したら無音を出しつつ位置を進めずに
 * 待つ(renderedSamplesで管理)。以前のバグ(曲送り後に無反応になる)は、
 * load()完了をawaitしてから一連の状態更新を行う設計だったため、待機中に別のload()で
 * 追い越されると"hesIsRendering"を戻し忘れる経路があったことが原因だった。load()を
 * 「即座に返り、進捗はonProgressコールバックで随時通知する」非同期即応型
 * (NSF/KSSと同じ設計)に変えたことで、この種のレース条件自体が構造的に起きなくなった。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE = 4096;

  class HesStreamPlayer {
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
      this.gainNode.gain.value = 4.0;
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

    load(hesBytes, track, totalFrames, mute) {
      this.stop();
      this.player = new MML.Emu.HesPlayer(hesBytes);
      this._track = track;
      this.player.initSong(track);
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

    setSpeed(factor) { if (this.player) this.player.speedFactor = factor; }

    stop() {
      this.isPlaying = false;
      if (this.player) this.player.initSong(this._track || 0);
      this.frameBuffer = null;
      this.frameOffset = 0;
      this.currentFrame = 0;
      this._samplePos = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    // keyboardDisplay.getMuteConfig()と同じ{apu:{},expansion:{hes:{ch0..ch5}}}形式
    applyMute(mute) {
      if (!mute || !this.player) return;
      const exp = mute.expansion || mute;
      if (exp.hes) Object.assign(this.player.apu.mute, exp.hes);
    }

    getPosition() { return this._samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.totalFrames / this.player.frameRate; }

    destroy() {
      this.isPlaying = false;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      this.player = null;
      this.frameBuffer = null;
    }
  }

  // =========================================================
  // HesReplayStreamPlayer
  // =========================================================
  class HesReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx      = audioCtx;
      this.node          = null;
      this.gainNode      = null;
      this.apu           = null;
      this.player        = this; // liveHesXxx系ヘルパーが player.apu 形状を前提にする場合に備えた自己参照
      this.header        = null;
      this.snapshots     = null;
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
      this.gainNode.gain.value = 4.0;
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
      this.apu = new MML.Emu.APUHuC6280();
      if (this._lastMute) this.applyMute(this._lastMute);
    }

    load(hesBytes, track, totalFrames, capture, mute) {
      this.stop();
      this.header = MML.HES.parseHeader(hesBytes);
      this.frameRate = MML.HES.VBLANK_FPS;
      this.clockHz = MML.HES.PSG_CLOCK; // APUクロック基準(hesPlayer.jsのpsgTickAccumと同じ比)
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

    _isFrameReady(f) { return !!(this.snapshots && this.snapshots[f]); }

    // スナップショットの値をライブAPUのチャンネルへ直接書き戻す(wavePos/lfsr等の位相は
    // ここでは触らずclock()の自然な進行に任せる。gbs-stream-player.jsと同じ考え方)。
    _applyFrame(f) {
      this.currentFrame = f;
      const s = this.snapshots[f];
      for (let i = 0; i < s.length; i++) {
        const c = this.apu.ch[i], sc = s[i];
        c.control = (sc.on ? 0x80 : 0) | (sc.dda ? 0x40 : 0) | (sc.vol & 0x1F);
        c.freq = sc.freq;
        c.balance = sc.balance;
        c.dac = sc.dac;
        c.noiseCtrl = sc.noiseOn ? 0x80 : 0;
        for (let j = 0; j < sc.wave.length; j++) c.wave[j] = sc.wave[j];
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
        if (!this._isFrameReady(f)) { out[i] = 0; continue; }
        this._songFramePos = nextSongFramePos;
        if (f !== this.currentFrame) this._applyFrame(f);

        this.cycleAccum += this.clockHz / sr;
        while (this.cycleAccum >= 1) { this.apu.clock(); this.cycleAccum -= 1; }
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

    seek(samplePos) {
      const sr = this.audioCtx.sampleRate;
      let songFramePos = (samplePos / sr) * this.frameRate * this.speedFactor;
      let targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      const snaps = this.snapshots || [];
      if (targetFrame >= 0 && !snaps[targetFrame]) {
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

    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute;
      if (!this.apu) return;
      const exp = mute.expansion || mute;
      if (exp.hes) Object.assign(this.apu.mute, exp.hes);
    }

    getPosition() { return this.samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.totalFrames / this.frameRate / this.speedFactor; }
    getCurrentFrame() { return Math.max(0, this.currentFrame); }

    destroy() {
      this.isPlaying = false;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      this.apu       = null;
      this.snapshots = null;
    }
  }

  // =========================================================
  // HesBufferedPlayer (ファイル冒頭コメント参照)
  // =========================================================
  const HES_CH_COUNT = 6;

  class HesBufferedPlayer {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.gainNode = null;
      this.node = null;            // ScriptProcessorNode
      this.channelAudio = null;    // Float32Array[6](captureHesSongAsync()が直接書き込む先)
      this.totalSamples = 0;
      this.renderedSamples = 0;    // channelAudioのうち「まだ読んでも安全」な範囲(先頭からの累計)
      this.duration = 0;
      this.frameRate = 60;
      this.isPlaying = false;
      this.onEnded = null;
      this.lastCapture = null;     // レンダリング完了時のcaptureHesSongAsync()結果一式
      this.onError = null;         // load()のバックグラウンドレンダリングが失敗した時に呼ばれる(e)=>{}
      this._samplePos = 0;         // 現在の再生位置(サンプル、整数)
      this._speedFactor = 1;
      this._muteGain = [1, 1, 1, 1, 1, 1];   // 実際に掛かっているゲイン(徐々に追従)
      this._muteTarget = [1, 1, 1, 1, 1, 1]; // ミュート操作の目標値(0 or 1)
      this._dcPrevX = 0;
      this._dcPrevY = 0;
      this._loadArgs = null;
      this._renderToken = 0;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 4.0;
      this.gainNode.connect(this.audioCtx.destination);
      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.connect(this.gainNode);
      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        if (!this.channelAudio || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    _fill(out) {
      const CH = this.channelAudio.length;
      for (let i = 0; i < out.length; i++) {
        const pos = this._samplePos;
        if (pos >= this.totalSamples) {
          out.fill(0, i);
          this.isPlaying = false;
          if (this.onEnded) this.onEnded();
          return;
        }
        if (pos >= this.renderedSamples) { out[i] = 0; continue; } // 先読み待ち(位置は進めない)
        let mix = 0;
        for (let c = 0; c < CH; c++) {
          this._muteGain[c] += (this._muteTarget[c] - this._muteGain[c]) * 0.01; // クリック防止のランプ
          mix += this.channelAudio[c][pos] * this._muteGain[c];
        }
        const y = mix - this._dcPrevX + 0.999 * this._dcPrevY;
        this._dcPrevX = mix; this._dcPrevY = y;
        out[i] = y;
        this._samplePos++;
      }
    }

    // レンダリング完了を待たず即座に返る(NsfReplayStreamPlayer/main.js playNsfStream()と
    // 同じ「バックグラウンドキャプチャと配列を共有し、埋まった分だけ再生する」設計。
    // ファイル冒頭コメント参照)。onProgress(done,total,data)は先読みの進捗ごとに
    // 呼ばれ、data.snapshotsはロール構築に使える。
    load(hesBytes, track, totalSeconds, mute, onProgress) {
      const token = ++this._renderToken;
      const sampleRate = this.audioCtx.sampleRate;
      this.totalSamples = Math.max(1, Math.round(totalSeconds * sampleRate));
      this.channelAudio = Array.from({ length: HES_CH_COUNT }, () => new Float32Array(this.totalSamples));
      this.renderedSamples = 0;
      this.duration = totalSeconds;
      this.lastCapture = null;
      this._dcPrevX = this._dcPrevY = 0;
      this._loadArgs = { hesBytes, track, totalSeconds, mute, onProgress };
      if (mute) this.applyMute(mute);

      MML.Emu.captureHesSongAsync(hesBytes, {
        track, durationSeconds: totalSeconds, sampleRate,
        regsOnly: false, perChannelAudio: true, speedFactor: this._speedFactor,
        channelAudioOut: this.channelAudio,
        shouldCancel: () => token !== this._renderToken
      }, (done, total, data) => {
        if (token !== this._renderToken) return; // 曲送り/速度変更等で追い越された
        if (data.frameRate) this.frameRate = data.frameRate;
        this.renderedSamples = data.samplesReady || 0;
        if (onProgress) onProgress(done, total, data);
      }).then((capture) => {
        if (token !== this._renderToken) return;
        this.lastCapture = capture;
        this.renderedSamples = this.totalSamples;
        this.frameRate = capture.frameRate;
      }).catch((e) => {
        console.error('HES音声レンダリングエラー:', e);
        if (token === this._renderToken && this.onError) this.onError(e);
      });
    }

    play() {
      if (this.isPlaying || !this.channelAudio) return;
      this.isPlaying = true;
    }

    pause() {
      this.isPlaying = false;
    }

    stop() {
      this.isPlaying = false;
      this._samplePos = 0;
    }

    // samplePos: 他プレイヤーのseek()と単位を揃える(audioCtx.sampleRate基準のサンプル位置)。
    // ScriptProcessorNode駆動でAudioBufferSourceNodeを使わないため、位置を直接書き換えるだけ
    // (stop/restartが不要)。renderedSamplesより先へシークしても、そこまで先読みが
    // 追いつくまで自動的に無音のまま待つ(_fill()参照。UI側はcurrentBufferedFraction()で
    // 先読み範囲を超えないようスナップバックする)。
    seek(samplePos) {
      this._samplePos = Math.max(0, Math.min(this.totalSamples, Math.round(samplePos)));
    }

    // 再生速度スライダー用。AudioBufferSourceNode.playbackRateは使わない
    // (ピッチも一緒に変わるテープ速度方式のため、音程を保ったままテンポだけ変える
    // 既存仕様と矛盾する)。常にload()をやり直してテンポだけを変えた新しいレンダリングへ
    // 切り替える(totalSamples自体はspeedFactorに関わらず一定なので、再生位置は
    // サンプル単位でそのまま引き継げる)。
    setSpeed(factor) {
      if (this._speedFactor === factor) return;
      this._speedFactor = factor;
      if (!this._loadArgs) return;
      const { hesBytes, track, totalSeconds, mute, onProgress } = this._loadArgs;
      const preservedPos = this._samplePos;
      const wasPlaying = this.isPlaying;
      this.load(hesBytes, track, totalSeconds, mute, onProgress);
      this._samplePos = Math.min(preservedPos, this.totalSamples - 1);
      this.isPlaying = wasPlaying;
    }

    // 再生中でも即座に反映される(_fill()内で毎サンプル目標値へ徐々に追従するだけで
    // 再レンダリング不要)。
    applyMute(mute) {
      if (!mute) return;
      const exp = mute.expansion || mute;
      const chMute = exp.hes || {};
      for (let c = 0; c < this._muteTarget.length; c++) this._muteTarget[c] = chMute['ch' + c] ? 0 : 1;
    }

    getPosition() { return this._samplePos / this.audioCtx.sampleRate; }
    getDuration() { return this.duration; }
    getCurrentFrame() { return Math.max(0, Math.floor(this.getPosition() * this.frameRate)); }
    // レンダリング済みの割合(0-1)。シークバーの先読みインジケータ用(main.js参照)。
    getBufferedFraction() { return this.totalSamples > 0 ? this.renderedSamples / this.totalSamples : 0; }

    destroy() {
      this.isPlaying = false;
      this._renderToken++; // 進行中のレンダリングがあれば(shouldCancel経由で)打ち切らせる
      this.channelAudio = null;
      this.lastCapture = null;
      this._loadArgs = null;
      if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
    }
  }

  MML.Audio.HesStreamPlayer = HesStreamPlayer;
  MML.Audio.HesReplayStreamPlayer = HesReplayStreamPlayer;
  MML.Audio.HesBufferedPlayer = HesBufferedPlayer;
})(window);
