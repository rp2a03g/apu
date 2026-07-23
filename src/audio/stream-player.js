/*
 * MML / NSF ストリーミング再生プレイヤー
 *
 * AudioWorklet の代わりに ScriptProcessorNode を使用する。
 * file:// から直接開いても動作し、APU オブジェクトはメインスレッドで
 * 共有されるためポストメッセージ不要。
 *
 * MML.Audio.MmlStreamPlayer
 * MML.Audio.NsfStreamPlayer
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const CPU_CLOCK_NTSC = 1789773;
  const BUFFER_SIZE    = 4096; // ~93ms @44100Hz

  // ---- 共通ユーティリティ ----

  function createExpansionMap(expansions) {
    const Emu = MML.Emu;
    const map = {};
    for (const exp of expansions || []) {
      switch (exp) {
        case 'vrc6': map.vrc6 = new Emu.VRC6Audio(); break;
        case 'vrc7': map.vrc7 = new Emu.VRC7Audio(); break;
        case 'fds':  map.fds  = new Emu.FDSAudio(); break;
        case 'mmc5': map.mmc5 = new Emu.MMC5Audio(); break;
        case 'n163': map.n163 = new Emu.N163Audio(); break;
        case 'fme7': map.fme7 = new Emu.FME7Audio(); break;
      }
    }
    return map;
  }

  function isExpansionAddr(expansion, addr) {
    switch (expansion) {
      case 'vrc6': return (addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002);
      case 'vrc7': return addr === 0x9010 || addr === 0x9030;
      case 'fds':  return addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A);
      case 'mmc5': return addr >= 0x5000 && addr <= 0x5015;
      case 'n163': return addr === 0xF800 || addr === 0x4800;
      case 'fme7': return addr === 0xC000 || addr === 0xE000;
      default:     return false;
    }
  }

  // 書き込みアドレスがどの拡張チップに属するか、Map内から探す
  function findExpansionForAddr(expansionMap, addr) {
    for (const name in expansionMap) {
      if (isExpansionAddr(name, addr)) return expansionMap[name];
    }
    return null;
  }

  // DPCM(DMC)チャンネル用の仮想メモリバス。compile()が計算したdpcmLayout
  // ($C000-$FFFF内の配置)に従い実バイト列を配置し、APU2A03のDmcChannelが
  // 通常のbus.read(addr)経由でサンプルを読めるようにする
  // (src/mml/compiler.jsのlayoutDpcmSamples、src/mml/player.jsと同じロジック。
  // APU2A03(null)だとDMCは常に無音になる)
  function buildDpcmBus(dpcmLayout) {
    const mem = new Uint8Array(0x10000);
    for (const idx of Object.keys(dpcmLayout || {})) {
      mem.set(dpcmLayout[idx].bytes, dpcmLayout[idx].addr);
    }
    return { read: (addr) => mem[addr & 0xFFFF] };
  }

  // gain(3.0) はNSF拡張音源1つ分の音量を基準にチューニングされているため、
  // 複数拡張音源が同時発音する組み合わせNSF(例: VRC6+MMC5+N163+FME7)では
  // 合成波形のピークが3倍後に±1.0を大きく超え、WebAudioの出力段でハードクリップして
  // 「特定チャンネルが正常に聴こえない」「音がよれる」ように聴こえる歪みの原因になる。
  // gainNode の後段にリミッタ(DynamicsCompressorNode)を挟み、単一音源時の音量感は
  // 保ったままピークだけを抑えてクリップを防ぐ。
  function createLimiter(audioCtx) {
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0; // dB: 出力段が0dBFSに達する手前から効かせる
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

  // =========================================================
  // MmlStreamPlayer
  // =========================================================
  class MmlStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx       = audioCtx;
      this.node           = null;
      this.gainNode       = null;
      this.apu            = null;
      this.expansionMap   = {};
      this.tracks         = null;
      this.channelLetters = [];
      this.totalFrames    = 0;
      this.frameRate      = 60.0988;
      this.expansions     = [];
      this.statusAddr     = 0x4015;
      this.samplesPerFrame = 0;
      this.samplePos      = 0;
      this.currentFrame   = -1;
      this.cycleAccum     = 0;
      // 再生速度(1=等速 〜 1/8=低速)。APUクロックは常に実時間のまま進めて
      // 音程を保ちつつ、曲の進行(_songFramePosの歩幅)だけを間引いてテンポを落とす。
      this.speedFactor    = 1;
      this._songFramePos  = 0; // 曲フレーム位置(speedFactor込みの実数値)
      this.dcPrevX        = 0;
      this.dcPrevY        = 0;
      this.isPlaying      = false;
      this.onEnded        = null;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 3.0;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(this.audioCtx.destination);

      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.connect(this.gainNode);

      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        if (!this.tracks || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    _fill(out) {
      const sr = this.audioCtx.sampleRate;
      for (let i = 0; i < out.length; i++) {
        this._songFramePos += (this.frameRate / sr) * this.speedFactor;
        const f = Math.floor(this._songFramePos);
        if (f >= this.totalFrames) {
          for (let j = i; j < out.length; j++) out[j] = 0;
          this.isPlaying = false;
          if (this.onEnded) this.onEnded();
          return;
        }
        if (f !== this.currentFrame) {
          this.currentFrame = f;
          for (const ch of this.channelLetters) {
            for (const w of this.tracks[ch][f]) {
              const target = findExpansionForAddr(this.expansionMap, w.addr);
              if (target) {
                target.writeRegister(w.addr, w.value);
              } else {
                this.apu.writeRegister(w.addr, w.value);
              }
            }
          }
        }
        this.cycleAccum += CPU_CLOCK_NTSC / sr;
        while (this.cycleAccum >= 1) {
          this.apu.clock();
          for (const name in this.expansionMap) this.expansionMap[name].clock();
          this.cycleAccum -= 1;
        }
        let raw = this.apu.mixSample();
        for (const name in this.expansionMap) raw += this.expansionMap[name].mixSample();
        const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
        this.dcPrevX = raw; this.dcPrevY = y;
        out[i] = y;
        this.samplePos++;
      }
    }

    load(compiled, mute) {
      this.stop();
      const Emu = MML.Emu;
      // dpcmBusをプロパティとして保持しておく(鍵盤表示のliveApuEnv()がsnapshotApuEnv()に
      // busを渡してDMCサンプルをデルタ復号するために必要。保持していないとNSF実ファイル
      // 再生と違いMML再生時だけDPCM波形が表示されない)
      this.dpcmBus         = buildDpcmBus(compiled.dpcmLayout);
      this.apu             = new Emu.APU2A03(this.dpcmBus);
      this.expansions     = compiled.expansions || [];
      this.expansionMap   = createExpansionMap(this.expansions);
      this.statusAddr     = compiled.statusAddr;
      this.tracks         = compiled.tracks;
      this.channelLetters = compiled.channelLetters;
      this.totalFrames    = compiled.totalFrames;
      this.frameRate      = compiled.frameRate;
      this.samplesPerFrame = this.audioCtx.sampleRate / compiled.frameRate;
      this._resetApu();
      if (mute) this.applyMute(mute);
    }

    _resetApu() {
      if (this.apu) {
        this.apu.reset();
        this.apu.writeRegister(this.statusAddr, 0x0F);
      }
      this.samplePos    = 0;
      this.currentFrame = -1;
      this.cycleAccum   = 0;
      this._songFramePos = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    play()  { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    stop() {
      this.isPlaying = false;
      this._resetApu();
    }

    // 再生速度を変更する(1=等速 〜 1/8=低速)。以後の曲フレーム進行速度だけが
    // 変わり、経過位置(_songFramePos)はそのまま引き継がれるため再生中でも
    // 途切れなく切り替えられる。
    setSpeed(factor) {
      this.speedFactor = factor;
    }

    seek(samplePos) {
      const songFramePos = (samplePos / this.audioCtx.sampleRate) * this.frameRate * this.speedFactor;
      const targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      if (this.apu) { this.apu.reset(); this.apu.writeRegister(this.statusAddr, 0x0F); }
      for (const name in this.expansionMap) {
        if (this.expansionMap[name].reset) this.expansionMap[name].reset();
      }
      for (let f = 0; f <= targetFrame; f++) {
        for (const ch of this.channelLetters) {
          for (const w of this.tracks[ch][f]) {
            const target = findExpansionForAddr(this.expansionMap, w.addr);
            if (target) {
              target.writeRegister(w.addr, w.value);
            } else {
              this.apu.writeRegister(w.addr, w.value);
            }
          }
        }
      }
      this.samplePos     = samplePos;
      this.currentFrame  = targetFrame;
      this._songFramePos = songFramePos;
      this.cycleAccum    = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    applyMute(mute) {
      if (!mute || !this.apu) return;
      if (mute.apu) MML.Emu.applyMute(this.apu.mute, mute.apu);
      if (mute.expansion) {
        for (const name in this.expansionMap) {
          if (mute.expansion[name]) MML.Emu.applyMute(this.expansionMap[name].mute, mute.expansion[name]);
        }
      }
    }

    getPosition() {
      return this.samplePos / this.audioCtx.sampleRate;
    }

    getDuration() {
      return this.totalFrames / this.frameRate / this.speedFactor;
    }

    destroy() {
      this.isPlaying = false;
      if (this.node)     { this.node.disconnect();     this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter)  { this.limiter.disconnect();  this.limiter = null; }
    }
  }

  // =========================================================
  // NsfStreamPlayer
  // =========================================================
  class NsfStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx     = audioCtx;
      this.node         = null;
      this.gainNode     = null;
      this.player       = null;
      this.frameBuffer  = null;
      this.frameOffset  = 0;
      this.totalFrames  = 0;
      this.currentFrame = 0;
      this.dcPrevX      = 0;
      this.dcPrevY      = 0;
      this.isPlaying    = false;
      this.onEnded      = null;
      this._samplePos   = 0;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 3.0;
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
        outPos           += toCopy;
        this.frameOffset += toCopy;
        this._samplePos  += toCopy;
      }
    }

    load(nsfBytes, songIndex, totalFrames, mute) {
      this.stop();
      this.player       = new MML.Emu.NsfPlayer(nsfBytes);
      this._songIndex   = songIndex;
      // INIT時のレジスタ書き込み(FDS/N163の波形メモリ等、再生中に書き直されない値)を記録。
      // 鍵盤表示の liveSnap 初期値に使う。
      const initRegs = {};
      this.player.bus.onWrite = (a, v) => { initRegs[a] = v; };
      this.player.initSong(songIndex);
      this.player.bus.onWrite = null;
      this.initRegs = initRegs;
      this.totalFrames  = totalFrames;
      this.currentFrame = 0;
      this.frameBuffer  = null;
      this.frameOffset  = 0;
      this._samplePos   = 0;
      this.dcPrevX = this.dcPrevY = 0;
      if (mute) this.applyMute(mute);
    }

    play()  { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    // 再生速度を変更する(1=等速 〜 1/8=低速)。PLAY呼び出し頻度のみ間引かれ、
    // APUクロック(=音程)や録音の総フレーム数(totalFrames)には影響しない。
    setSpeed(factor) {
      if (this.player) this.player.speedFactor = factor;
    }

    stop() {
      this.isPlaying = false;
      if (this.player) this.player.initSong(this._songIndex || 0);
      this.frameBuffer  = null;
      this.frameOffset  = 0;
      this.currentFrame = 0;
      this._samplePos   = 0;
      this.dcPrevX = this.dcPrevY = 0;
    }

    applyMute(mute) {
      if (!mute || !this.player) return;
      if (mute.apu) MML.Emu.applyMute(this.player.apu.mute, mute.apu);
      if (mute.expansion) {
        for (const [name, chip] of Object.entries(this.player.bus.expansion)) {
          if (mute.expansion[name]) MML.Emu.applyMute(chip.mute, mute.expansion[name]);
        }
      }
    }

    getPosition() {
      return this._samplePos / this.audioCtx.sampleRate;
    }

    destroy() {
      this.isPlaying = false;
      if (this.node)     { this.node.disconnect();     this.node = null; }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter)  { this.limiter.disconnect();  this.limiter = null; }
    }
  }

  MML.Audio.MmlStreamPlayer = MmlStreamPlayer;
  MML.Audio.NsfStreamPlayer = NsfStreamPlayer;
})(window);
