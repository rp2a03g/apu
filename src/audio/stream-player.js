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

  // マスター音量(全フォーマット共通の最終段ゲイン)。各プレイヤーは自分のgainNode/limiterの
  // 出力先をaudioCtx.destinationへ直接つなぐ代わりにこのノードへつなぐことで、フォーマットを
  // 問わず1箇所でまとめて音量調整できる(src/ui/keyboard.jsのマスター音量バー参照)。
  // audioCtxはページ内で使い回される(main.js: `if (!audioCtx) audioCtx = new AudioContext()`)が、
  // 念のためWeakMapでインスタンスごとにキャッシュする(audioCtxが再生成された場合も安全)。
  // 0〜1のみ(減衰専用)にしておけば、各プレイヤーのリミッタで既に抑えたピークを再び
  // 押し上げてクリップさせる心配がない。
  // src/ui/keyboard.js のマスター音量バーと同じキー(値は0〜1)。生成タイミングに
  // 依存せず常に直近の保存値から始まるよう、ノード新規作成時にここで読む。
  const MASTER_VOLUME_STORAGE_KEY = 'mml_masterVolume';
  function loadMasterVolume() {
    try {
      const raw = parseFloat(localStorage.getItem(MASTER_VOLUME_STORAGE_KEY));
      if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
    } catch (e) { /* ignore */ }
    return 1;
  }
  const masterGainNodes = new WeakMap();
  function getMasterGain(audioCtx) {
    let node = masterGainNodes.get(audioCtx);
    if (!node) {
      node = audioCtx.createGain();
      node.gain.value = loadMasterVolume();
      node.connect(audioCtx.destination);
      masterGainNodes.set(audioCtx, node);
    }
    return node;
  }
  MML.Audio.getMasterGain = getMasterGain;

  // 無音自動送り(NsfReplayStreamPlayer)用。SILENCE_SEC秒連続でほぼ無音(|y|<SILENCE_EPS)の
  // 出力が続いたらonSilenceTimeoutを一度だけ呼ぶ(main.js playNsfStream参照)。バックグラウンド
  // キャプチャ未到達によるスタール出力(_isFrameReady()==false)はここに含めない
  // (実際の無音と区別するため、呼び出し側で判定済みのフレームだけをカウント対象にする)。
  const SILENCE_SEC = 10;
  const SILENCE_EPS = 1e-4;

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
      // ★2026-08 NSF実ファイル再生(NsfReplayStreamPlayer)と同じ音量バランスに揃える
      // (ユーザー要望: MML作曲プレビューはNSF実ファイル再生と同じ2A03+拡張音源チップを
      // 使っており、聴感上も同じ音量であるべき。NsfReplayStreamPlayer冒頭コメント参照の
      // 実測RMS校正結果をそのまま流用する。旧値3.0は単一拡張音源チャンネル基準の値)。
      this.gainNode.gain.value = 1.56;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(getMasterGain(this.audioCtx));

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

    // 現在の曲フレーム位置(_songFramePosをオーディオサンプル単位で毎サンプル進めた
    // 結果、speedFactor込みで既に正確)。getPosition()(実時間)をframeDurationで
    // 単純に割ると再生速度が等速でない場合に曲の進行と食い違うため、frameIndexが
    // 必要な箇所(MML再生ハイライト・CPU/サウンドレジスタモニタ)はこちらを使うこと。
    getCurrentFrame() {
      return Math.max(0, this.currentFrame);
    }

    destroy() {
      this.isPlaying = false;
      // onaudioprocessのクロージャがthis(ひいてはtracks等の大きな配列)を掴んだままだと、
      // disconnect()後もScriptProcessorNodeがGCされるまでメモリを保持し続けてしまう
      // (ScriptProcessorNodeはdeprecated APIで、ブラウザによってはdisconnect済みでも
      // 即座には回収されないため、ハンドラを明示的に外して参照を断つ必要がある)。
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter)  { this.limiter.disconnect();  this.limiter = null; }
      this.tracks = null;
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
      // ★2026-08 SPCを基準に全フォーマットの体感音量を実測揃え(RMS計測、他4フォーマットの
      // 同種コメント参照)。3.0(旧値)は単一拡張音源前提でNSFが他フォーマットよりだいぶ
      // 大きく聴こえていた。
      this.gainNode.gain.value = 1.56;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(getMasterGain(this.audioCtx));

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
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
        this.node = null;
      }
      if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
      if (this.limiter)  { this.limiter.disconnect();  this.limiter = null; }
      this.player      = null;
      this.frameBuffer  = null;
    }
  }

  // N163は$F800(アドレスラッチ)+$4800(データ)の間接アドレッシングで、実機ドライバは
  // 位相バイトを「$4800の空読み」で読み飛ばす(読み出しもオートインクリメントを進める)。
  // writeLogは書き込みしか記録していないため、書き込みだけを再生するとその「読み飛ばし」分
  // ポインタがドリフトし、以降の書き込みが誤ったオフセットへ着地して波形/レジスタが
  // 破壊される([[n163-capture-snapshot-and-numch]]と同種の問題)。
  // capture.js(regsOnly)が採取するn163Snapshots[f]は毎フレームのライブRAM実測なので
  // ポインタドリフトの影響を受けず、周波数/波形/音量バイトは常に正しい。ただし
  // regsOnlyはN163.clock()を呼ばない(音声合成をスキップする高速モードのため)ので、
  // 位相バイト(+1/+3/+5、_updateChannel()だけが更新する)はスナップショット内では
  // 進行していない(参考にならない)。そのため位相バイトだけは対象外にし、実際に毎
  // サンプルclock()している自分のN163インスタンスの位相をそのまま使う。
  const N163_PHASE_BYTES = (() => {
    const s = new Set();
    for (let ch = 0; ch < 8; ch++) {
      const base = 0x40 + ch * 8;
      s.add(base + 1); s.add(base + 3); s.add(base + 5);
    }
    return s;
  })();
  function applyN163RamSnapshot(n163, snapshotRam) {
    if (!n163 || !snapshotRam) return;
    const dst = n163.ram;
    for (let i = 0; i < 128; i++) {
      if (!N163_PHASE_BYTES.has(i)) dst[i] = snapshotRam[i];
    }
  }

  // =========================================================
  // NsfReplayStreamPlayer
  // =========================================================
  // NSF実ファイルを「6502 CPUを実行しながら音声も生成する」NsfStreamPlayerとは異なり、
  // バックグラウンドで先行実行された6502キャプチャ(src/emulator/capture.js captureSongAsync
  // のwriteLog、フレームごとの{addr,value}[])を「実CPU抜きで」チップへ再適用するだけで
  // 音声合成する。MmlStreamPlayer(MMLコンパイル済みtracksを同じ方式で再生)とほぼ同型の設計で、
  // その結果MmlStreamPlayerと同じ仕組み(seek=0からの書き込み再適用、applyMute=チップの
  // mute配列をライブ書き換え)がNSF実ファイルでもそのまま使える。
  // CPUを持たないため、曲送り連打時などにNsfStreamPlayer+先読みキャプチャの「2本の6502
  // エミュレーションが同時に走ってCPUを食い合う」問題も構造的に起きない。
  // ★2026-08 SPCを基準に全フォーマットの体感音量を実測(RMS)揃え: 各フォーマットの
  // 実ファイルを数本、実際のチップミックス(gain適用前の生波形)でRMSを計測し、
  // SPC(gain 2.0時点の実効音量)に一致するようgainを再計算した。3.0(旧値)は単一
  // 拡張音源チャンネル基準の値で、NSFは他フォーマットよりだいぶ大きく聴こえていた。
  class NsfReplayStreamPlayer {
    constructor(audioCtx) {
      this.audioCtx       = audioCtx;
      this.node           = null;
      this.gainNode       = null;
      this.bus            = null;
      this.apu            = null;
      // liveApuEnv/liveN163/liveFME7/liveMMC5/liveVRC7(main.js)はNsfStreamPlayer/
      // KssStreamPlayerの「p.player.apu」「p.player.bus」形状を前提にしている。
      // 自己参照させることでこれらのヘルパーを一切変更せずに再利用できる。
      this.player          = this;
      this.busOpt          = null;
      this.writeLog        = null;   // captureSongAsyncが進行中に育てる配列への参照(未キャプチャの添字はundefined)
      this.initWrites      = [];
      this.initRegs        = {};
      this.totalFrames     = 0;
      this.frameRate       = MML.Emu.FRAME_RATE_NTSC;
      this.samplesPerFrame = 0;
      this.samplePos       = 0;
      this.currentFrame    = -1;
      this.cycleAccum      = 0;
      this.speedFactor     = 1;
      this._songFramePos   = 0;
      this.dcPrevX         = 0;
      this.dcPrevY         = 0;
      this.isPlaying       = false;
      this.onEnded         = null;
      this.onSilenceTimeout = null;
      // 無音自動送り用の先読みスキャン状態(scanSilenceStep/_resetScan参照)。
      // 実再生用のbus/apuとは別に、使い捨てのチップインスタンス(_scanBus/_scanApu)で
      // writeLogを先回り再生し、実際に無音が来るより前に検出できるようにする。
      this._silenceFired    = false;   // このロードで既にonSilenceTimeoutを発火済みか
      this._silenceScanFrame = -1;     // 先読みで見つかった無音区間の開始フレーム(-1=未検出)
      this._scanDone         = false;  // 曲末までスキャンし終えた(無音は無かった)
      this._scanBus = null; this._scanApu = null;
      this._scanFrame = -1;
      this._scanSongFramePos = 0;
      this._scanCycleAccum = 0;
      this._scanDcPrevX = 0; this._scanDcPrevY = 0;
      this._scanSilentRun = 0;
      this._createNode();
    }

    _createNode() {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.56;
      this.limiter = createLimiter(this.audioCtx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(getMasterGain(this.audioCtx));

      this.node = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.connect(this.gainNode);

      this.node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        if (!this.bus || !this.isPlaying) { out.fill(0); return; }
        this._fill(out);
      };
    }

    // bus/apu/拡張音源を作り直し、initWrites(INIT実行直後の初期レジスタ状態)を適用する。
    // load()時と、シーク時(0から再適用するため)の両方から呼ばれる。
    _buildChips() {
      this.bus = new MML.Emu.NsfBus(this.busOpt);
      this.apu = new MML.Emu.APU2A03(this.bus);
      this.bus.setApu(this.apu);
      for (const w of this.initWrites) this.bus.write(w.addr, w.value);
      // seek()等でbusが作り直されてもライブ鍵盤モニタ用フックが失われないよう保持しておく
      if (this._onWriteHook) this.bus.onWrite = this._onWriteHook;
      // 同様にミュート設定もbus/apu/拡張音源を作り直すたびに失われる(新しいチップ
      // インスタンスのmuteは既定で全解除状態のため)。直近に適用されたミュート設定を
      // 再適用して、シーク後にチャンネルが勝手にミュート解除されないようにする。
      if (this._lastMute) this.applyMute(this._lastMute);
      // ch別音量(vol)も同じ理由で再適用が必要(applyMuteと同じ流儀)
      if (this._lastVolume) this.applyVolume(this._lastVolume);
    }

    // ライブ鍵盤モニタ用のbus.onWriteフックを設定する。_buildChips()(load/seek/stop時に
    // busを毎回作り直す)を経ても引き継がれるよう、素の`bus.onWrite = fn`ではなくこちらを使う。
    setOnWrite(fn) {
      this._onWriteHook = fn;
      if (this.bus) this.bus.onWrite = fn;
    }

    // capture: {writeLog, initWrites, initRegs, n163Snapshots}(captureSongAsyncのonProgress由来。
    // writeLog/n163Snapshotsは進行中配列への参照で、呼び出し後もキャプチャが進むにつれ自動的に埋まっていく)
    load(nsfBytes, songIndex, totalFrames, capture, mute) {
      this.stop();
      const header = MML.NSF.parseHeader(nsfBytes);
      this.busOpt = {
        program: nsfBytes.slice(128),
        loadAddr: header.loadAddr,
        bankswitch: header.bankswitch,
        extraChips: header.extraChips
      };
      this.writeLog      = capture.writeLog;
      this.initWrites    = capture.initWrites || [];
      this.initRegs      = capture.initRegs || {};
      this.n163Snapshots = capture.n163Snapshots || null;
      this.totalFrames = totalFrames;
      this.samplesPerFrame = this.audioCtx.sampleRate / this.frameRate;
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

    _applyFrame(f) {
      this.currentFrame = f;
      const writes = this.writeLog[f];
      if (writes) for (const w of writes) this.bus.write(w.addr, w.value);
      // N163は書き込み再生だけだとポインタドリフトで破壊されるため、ライブRAM
      // スナップショットで(位相バイトを除き)上書きして正しい状態に補正する
      if (this.n163Snapshots && this.bus.expansion.n163) {
        applyN163RamSnapshot(this.bus.expansion.n163, this.n163Snapshots[f]);
      }
    }

    // ===== 無音自動送り: 先読みスキャン(scanSilenceStep)=====
    // 実再生用のbus/apuとは別の使い捨てチップインスタンスを用意し、writeLogを
    // 実再生より先回りして音声合成(clock+mixSample)だけ行うことで、実際にその
    // 無音区間を聴く前にSILENCE_SEC秒以上の無音が来ることを検出する。
    _scanBuildChips() {
      this._scanBus = new MML.Emu.NsfBus(this.busOpt);
      this._scanApu = new MML.Emu.APU2A03(this._scanBus);
      this._scanBus.setApu(this._scanApu);
      for (const w of this.initWrites) this._scanBus.write(w.addr, w.value);
      // ミュート中のchは実際に聴こえないので、スキャンにも同じミュート設定を反映する
      // (実再生と無音判定基準を揃える。_lastMuteはapplyMute()参照)。
      if (this._lastMute) {
        if (this._lastMute.apu) MML.Emu.applyMute(this._scanApu.mute, this._lastMute.apu);
        if (this._lastMute.expansion) {
          for (const [name, chip] of Object.entries(this._scanBus.expansion)) {
            if (this._lastMute.expansion[name]) MML.Emu.applyMute(chip.mute, this._lastMute.expansion[name]);
          }
        }
      }
      // ch別音量も無音判定基準に含めるため、ミュートと同様スキャン側にも反映する
      if (this._lastVolume) {
        if (this._lastVolume.apu) MML.Emu.applyVolume(this._scanApu.vol, this._lastVolume.apu);
        if (this._lastVolume.expansion) {
          for (const [name, chip] of Object.entries(this._scanBus.expansion)) {
            if (this._lastVolume.expansion[name]) MML.Emu.applyVolume(chip.vol, this._lastVolume.expansion[name]);
          }
        }
      }
    }

    _scanApplyFrame(f) {
      this._scanFrame = f;
      const writes = this.writeLog[f];
      if (writes) for (const w of writes) this._scanBus.write(w.addr, w.value);
      if (this.n163Snapshots && this._scanBus.expansion.n163) {
        applyN163RamSnapshot(this._scanBus.expansion.n163, this.n163Snapshots[f]);
      }
    }

    // fromFrame(実再生の現在地に相当)からスキャンをやり直す。load/stop/seekから呼ぶ。
    _resetScan(fromFrame) {
      if (!this.busOpt) return;
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
        if (!wl[f]) break; // 先読みキャプチャがまだここまで届いていない
        this._scanApplyFrame(f);
      }
      this._scanSongFramePos = Math.min(f, fromFrame + 1);
    }

    // budgetSongSeconds分(曲内の時間、実時間ではない)だけスキャンを進める。
    // main.jsのmonitorLoop()(rAF、~60fps)から毎フレーム少しずつ呼ばれる想定。
    // 曲末に達する/writeLogの先読みがまだ届いていない/既に無音区間を発見済み、の
    // いずれかで自動的に止まる(呼び続けても無駄な仕事はしない)。
    scanSilenceStep(budgetSongSeconds) {
      if (this._scanDone || this._silenceScanFrame >= 0 || !this._scanBus) return;
      const sr = this.audioCtx.sampleRate;
      const budgetSamples = Math.max(1, Math.round(budgetSongSeconds * sr));
      for (let i = 0; i < budgetSamples; i++) {
        const nextSongFramePos = this._scanSongFramePos + (this.frameRate / sr);
        const f = Math.floor(nextSongFramePos);
        if (f >= this.totalFrames) { this._scanDone = true; return; }
        if (!this._isFrameReady(f)) return; // 先読みキャプチャがここまでまだ届いていない
        this._scanSongFramePos = nextSongFramePos;
        if (f !== this._scanFrame) this._scanApplyFrame(f);

        this._scanCycleAccum += CPU_CLOCK_NTSC / sr;
        while (this._scanCycleAccum >= 1) {
          this._scanApu.clock();
          for (const name in this._scanBus.expansion) this._scanBus.expansion[name].clock();
          this._scanCycleAccum -= 1;
        }
        let raw = this._scanApu.mixSample();
        for (const name in this._scanBus.expansion) raw += this._scanBus.expansion[name].mixSample();
        const y = raw - this._scanDcPrevX + 0.999 * this._scanDcPrevY;
        this._scanDcPrevX = raw; this._scanDcPrevY = y;

        if (Math.abs(y) < SILENCE_EPS) {
          this._scanSilentRun++;
          if (this._scanSilentRun >= sr * SILENCE_SEC) {
            // 無音区間の開始フレーム = 現在地からSILENCE_SEC秒ぶん遡った地点
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
          // バックグラウンドキャプチャがまだこのフレームに追いついていない
          // (再生開始直後や、先読みの先端付近へのシーク直後などに起こりうる)。
          // samplePosは進めない: 進めてしまうと(スタール中も実時間で位置が進み続け)
          // getPosition()が「実際には再生していない」のに duration に到達したと
          // 誤認し、updateTransportUI()の「pos>=durationならtransportStop()」に
          // よってスタールしたまま再生が停止してしまう不具合があった(King of Kings
          // 実測で発覚)。無音のまま位置を凍結し、次のコールバックで同じフレームを再試行する。
          out[i] = 0;
          continue;
        }
        this._songFramePos = nextSongFramePos;
        if (f !== this.currentFrame) this._applyFrame(f);

        this.cycleAccum += CPU_CLOCK_NTSC / sr;
        while (this.cycleAccum >= 1) {
          this.apu.clock();
          for (const name in this.bus.expansion) this.bus.expansion[name].clock();
          this.cycleAccum -= 1;
        }
        let raw = this.apu.mixSample();
        for (const name in this.bus.expansion) raw += this.bus.expansion[name].mixSample();
        const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
        this.dcPrevX = raw; this.dcPrevY = y;
        out[i] = y;
        this.samplePos++;
        // 先読みスキャン(scanSilenceStep)が見つけておいた無音区間の開始フレームに
        // 実再生が到達したら通知する。実際に10秒待つ必要はない(既に先読みで
        // SILENCE_SEC秒以上無音が続くと確認済みのため)。
        if (this._silenceScanFrame >= 0 && !this._silenceFired && f >= this._silenceScanFrame) {
          this._silenceFired = true;
          if (this.onSilenceTimeout) this.onSilenceTimeout();
        }
      }
    }

    play()  { this.isPlaying = true; }
    pause() { this.isPlaying = false; }

    stop() {
      this.isPlaying = false;
      if (this.busOpt) this._buildChips();
      this.samplePos     = 0;
      this.currentFrame  = -1;
      this._songFramePos = 0;
      this.cycleAccum    = 0;
      this.dcPrevX = this.dcPrevY = 0;
      this._resetScan(0);
    }

    setSpeed(factor) { this.speedFactor = factor; }

    // targetFrameの直前まで(0..targetFrame、キャプチャが追いついていなければその手前まで)の
    // 書き込みをbus/apuへ再適用してシークする(MmlStreamPlayer.seek()と同じ考え方)。
    // エンベロープ/スイープの内部クロック位相までは復元されない(同じ既知の割り切り)。
    seek(samplePos) {
      const sr = this.audioCtx.sampleRate;
      let songFramePos = (samplePos / sr) * this.frameRate * this.speedFactor;
      let targetFrame = Math.min(Math.floor(songFramePos), this.totalFrames - 1);
      const wl = this.writeLog || [];
      if (targetFrame >= 0 && !wl[targetFrame]) {
        // 未キャプチャ範囲へのシーク: バッファ済み末尾にクランプする。samplePos/
        // songFramePosも合わせて再計算しないと、getPosition()が「要求された(まだ
        // 存在しない)位置」を報告し続け、次の_fill()でcurrentFrameとsongFramePosが
        // 食い違ってしまう(_isFrameReady(f)==falseのスタール状態に陥る)。
        while (targetFrame > 0 && !wl[targetFrame]) targetFrame--;
        songFramePos = targetFrame;
        samplePos = (songFramePos / this.frameRate / this.speedFactor) * sr;
      }
      this._buildChips();
      this.cycleAccum = 0;
      for (let f = 0; f <= targetFrame; f++) {
        const writes = wl[f];
        if (!writes) break;
        for (const w of writes) this.bus.write(w.addr, w.value);
      }
      // N163はポインタドリフトの影響を受けるため、シーク先フレームのライブRAM
      // スナップショットで(位相バイトを除き)最終的に上書きして補正する
      if (this.n163Snapshots && this.bus.expansion.n163) {
        applyN163RamSnapshot(this.bus.expansion.n163, this.n163Snapshots[targetFrame]);
      }
      this.samplePos     = samplePos;
      this.currentFrame  = targetFrame;
      this._songFramePos = songFramePos;
      this.dcPrevX = this.dcPrevY = 0;
      this._resetScan(targetFrame);
    }

    applyMute(mute) {
      if (!mute) return;
      this._lastMute = mute; // _buildChips()(シーク等でチップを作り直すたび)に再適用するため保持
      if (!this.apu) return;
      if (mute.apu) MML.Emu.applyMute(this.apu.mute, mute.apu);
      if (mute.expansion) {
        for (const [name, chip] of Object.entries(this.bus.expansion)) {
          if (mute.expansion[name]) MML.Emu.applyMute(chip.mute, mute.expansion[name]);
        }
      }
      // 再生中にミュートを切り替えた場合、無音先読みスキャンも現在地からやり直す
      // (ミュート状態が無音判定の基準に含まれるため、古いスキャン結果は無効になりうる)
      if (this.busOpt) this._resetScan(Math.max(0, this.currentFrame));
    }

    // volume: getMuteConfig()と同じ{apu:{},expansion:{}}形状だが値は0〜1(applyMuteの
    // 真偽値と違い数値)。keyboardDisplayのch別音量バー(src/ui/keyboard.js)用。
    applyVolume(volume) {
      if (!volume) return;
      this._lastVolume = volume; // _buildChips()(シーク等でチップを作り直すたび)に再適用するため保持
      if (!this.apu) return;
      if (volume.apu) MML.Emu.applyVolume(this.apu.vol, volume.apu);
      if (volume.expansion) {
        for (const [name, chip] of Object.entries(this.bus.expansion)) {
          if (volume.expansion[name]) MML.Emu.applyVolume(chip.vol, volume.expansion[name]);
        }
      }
      if (this.busOpt) this._resetScan(Math.max(0, this.currentFrame));
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
      // writeLog等はキャプチャ済み全曲分の書き込みログ(数分の曲では数十MB規模になりうる)を
      // 保持している。ファイルを連続で開き直すたびにこれが解放されないと蓄積してブラウザが
      // メモリ不足で落ちるため、破棄時に明示的に参照を切る。
      this.bus           = null;
      this.apu           = null;
      this._scanBus       = null;
      this._scanApu       = null;
      this.writeLog       = null;
      this.initWrites     = [];
      this.n163Snapshots  = null;
    }
  }

  MML.Audio.MmlStreamPlayer = MmlStreamPlayer;
  MML.Audio.NsfStreamPlayer = NsfStreamPlayer;
  MML.Audio.NsfReplayStreamPlayer = NsfReplayStreamPlayer;
})(window);
