/*
 * KSSプレイヤー (Z80 CPU + KssBus + PSG/SCC/OPLL の統合)
 * MML.Emu.KssPlayer
 *
 * - initSong(index): INITルーチンを呼び出して曲を初期化(A=曲番号、libkss準拠)
 * - renderFrame(sampleRate): PLAYルーチンを1回呼び出し、1フレーム分の音声サンプルを生成
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * writeLogの1書込みを1つの整数へ詰める(2026-09-04)。
   *   bit0-15 = addr(メモリアドレス or I/Oポート) / bit16-23 = value / bit24 = io(1ならI/O)
   *
   * {addr,value,io}のJSオブジェクトは**実測75〜90B/件**で、KSSは1フレーム平均84〜152件
   * 書くため60秒で27〜41MB(実RSS)を占めていた。詰めればフレームごとの Int32Array で
   * 4B/件になる(実測 xak.kss 60秒: 27MB → 1.2MB)。
   * ★型付き配列なので構造化クローン(キャプチャWorkerの差分送信)もそのまま通る。
   * ★VGM側(vgmPlayer.js data.kss.writeLog)も同じ詰め方で作ること。読む側は
   *   kss2mml/expansion/*.js と kss-stream-player.js と roll-builders.js。
   */
  const packWrite = (addr, value, io) => (addr & 0xFFFF) | ((value & 0xFF) << 16) | (io ? 0x1000000 : 0);
  Emu.kssPackWrite = packWrite;

  // INIT/PLAY呼び出し時のスタックポインタ初期値(libkss exec_setup の 0xF380 と同じ。
  // MSX BIOSワークエリアの直下で、実機ドライバが LD SP,0F380h とするのと同じ位置)
  const STACK_TOP = 0xF380;

  class KssPlayer {
    /**
     * @param {Uint8Array} kssBytes - KSSファイルの完全なバイナリ
     */
    constructor(kssBytes) {
      this.header = MML.KSS.parseHeader(kssBytes);
      const songData = kssBytes.slice(this.header.dataOffset);

      this.bus = new Emu.KssBus(this.header, songData);

      // チップは常にPSG+SCCを用意する(SCCはヘッダフラグに現れないため、
      // バンク切替ありのKSSでは常時バスに配線しておくのが安全)。
      // FMPACはヘッダのdevice_flagで判定。OPL(未対応)は将来 this.bus.chips.opl として追加可能。
      this.psg = new Emu.AY8910Audio();
      this.scc = new Emu.SCCAudio();
      this.bus.registerChip('psg', this.psg);
      this.bus.registerChip('scc', this.scc);
      if (this.header.device.mode === 'MSX' && this.header.device.fmpac) {
        this.opll = new Emu.OPLLAudio();
        this.bus.registerChip('opll', this.opll);
      }
      // MSX-AUDIO(Y8950): ポート0xC0/0xC1(kssBus.js chips.opl)。3.58MHz駆動でclock/72=49716Hz
      if (this.header.device.mode === 'MSX' && this.header.device.msxAudio && Emu.OPLAudio) {
        this.opl = new Emu.OPLAudio(MML.KSS.Z80_CLOCK, { type: 'y8950' });
        this.bus.registerChip('opl', this.opl);
      }

      this.cpu = new Emu.CPUZ80(this.bus);

      // 音源チップは常にMSX標準の3.58MHzで駆動する。一方Z80は、FMPAC/MSX-AUDIO搭載曲では
      // libkss(getclk)と同じく倍速(7.16MHz)で回す。FM系ドライバは1フレームの処理が重く、
      // 3.58MHz相当のサイクル数ではPLAYが1フレーム内に終わらずテンポが崩れるため。
      this.clockHz = MML.KSS.Z80_CLOCK;
      const d = this.header.device;
      this.cpuClockHz = (d.mode === 'MSX' && (d.fmpac || d.msxAudio)) ? MML.KSS.Z80_CLOCK * 2 : MML.KSS.Z80_CLOCK;
      this.cpuCyclesPerChipCycle = this.cpuClockHz / this.clockHz;
      this.frameRate = this.header.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this.speedFactor = 1;
      this._playFrameAccum = 0;
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     */
    initSong(songIndex) {
      this.bus.reset(); // メインメモリ・バンクマップを再ロード(曲切替でも初期状態から始める)
      this.cpu.reset();
      this.psg.reset();
      this.scc.reset();
      if (this.opll) this.opll.reset();
      if (this.opl) this.opl.reset();
      this.cpu.a = songIndex & 0xFF;
      this.cpu.iff1 = false;
      this.cpu.iff2 = false;
      this.cpu.im = 1;

      // INITはlibkssと同じく「最大1秒相当のCPUサイクル」を上限に実行する。
      // ステップ数上限だと重いINIT(バンクからのデータ展開等)が途中で打ち切られる。
      this.cpu.sp = STACK_TOP;
      this.cpu.beginCall(this.header.initAddr);
      let cycles = 0;
      while (this.cpu.callActive && cycles < this.cpuClockHz) cycles += this.cpu.stepCall();
      this.cpu.callActive = false;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this._playFrameAccum = 0;
    }

    /**
     * 1フレーム分の音声サンプルを生成する。PLAYが1フレーム内に終わらない場合は
     * renderFrameを跨いで継続する(NsfPlayer.renderFrameと同じ設計)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - trueならmixSample()による波形合成を省略し、
     *   PLAY呼び出しタイミング・レジスタ書込ログに関わる部分(CPU実行・チップのclock())
     *   だけを実行する(鍵盤表示/ピアノロールの先読みキャプチャ用の軽量モード)。
     * @returns {Float32Array|null} regsOnly時はnull
     */
    renderFrame(sampleRate, regsOnly) {
      const cyclesPerSample = this.clockHz / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / this.frameRate);
      const out = regsOnly ? null : new Float32Array(samplesThisFrame);

      const cpu = this.cpu, psg = this.psg, scc = this.scc, opll = this.opll, opl = this.opl;

      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          // libkss exec_setup と同じく、PLAY呼び出しごとにSPを既定値へ戻す
          // (ドライバがINIT中に積んだ分でスタックが延々ドリフトするのを防ぐ)。
          cpu.sp = STACK_TOP;
          cpu.beginCall(this.header.playAddr);
        }
      }

      // cycleAccum/チップのclock()は常に3.58MHz基準。CPUだけ cpuCyclesPerChipCycle 倍で進める。
      const cpuPerChip = this.cpuCyclesPerChipCycle;
      for (let i = 0; i < samplesThisFrame; i++) {
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          if (this.cpuDebt <= 0) {
            if (cpu.callActive) this.cpuDebt += cpu.stepCall();
            else this.cpuDebt = cpuPerChip;
          }
          this.cpuDebt -= cpuPerChip;
          psg.clock();
          scc.clock();
          if (opll) opll.clock();
          if (opl) opl.clock();
          this.cycleAccum -= 1;
        }
        if (!regsOnly) {
          let sample = psg.mixSample() + scc.mixSample();
          if (opll) sample += opll.mixSample();
          // 0.7 = VGM側の較正比(CHIP_GAIN.opl 1.4 / ym2413 1.99)をKSSの素通しミックスへ写す
          if (opl) sample += opl.mixSample() * 0.7;
          out[i] = sample;
        }
      }
      return out;
    }
  }

  /**
   * KSSを指定秒数分オフラインレンダリングし、音声とフレーム毎のレジスタ書込ログを返す。
   * WAV書き出し・kss2mml変換・ピアノロールの先読みキャプチャで使う共通キャプチャ関数。
   * opt.regsOnly=true時は波形合成(renderFrameのmixSample呼び出し)を省略し、音声バッファも
   * 確保しない(ピアノロールはレジスタ書込ログだけで足りるため、実再生とメインスレッドを
   * 共有してもCPU負荷を抑えられる)。regsOnly時はより細かくyieldし、onProgressにはその時点
   * までの writeLog(同一配列参照、伸びていく)も渡すので途中経過で段階的に更新できる。
   * @param {Uint8Array} kssBytes
   * @param {object} opt - {songIndex, durationSeconds, sampleRate, mute, regsOnly}
   * @param {(done:number,total:number,writeLog:Array)=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, writeLog:Array<Array<{addr:number,value:number,io:boolean}>>, player:KssPlayer, frameRate:number}>}
   */
  Emu.captureKssSongAsync = async function (kssBytes, opt, onProgress) {
    const player = new KssPlayer(kssBytes);
    // INIT中の書込みも記録し、フレーム0の先頭に含める。
    // INITで一度だけ設定されPLAY中は二度と書かれないレジスタが実在するため
    // (SCC-I(SCC+)のモードレジスタ0xBFFEが代表例。これを取りこぼすと、writeLogを
    //  読むピアノロール/MML変換側はSCCのレジスタ窓が0xB800へ移ったことを知らず、
    //  スナッチャー系のSCCパートが「音符ゼロ」になる)。NSF側のinitWritesと同じ考え方。
    const initWrites = [];
    player.bus.onWrite = (addr, value) => initWrites.push(packWrite(addr, value, 0));
    player.bus.onIoWrite = (port, value) => initWrites.push(packWrite(port, value, 1));
    player.initSong(opt.songIndex || 0);
    player.bus.onWrite = null;
    player.bus.onIoWrite = null;
    if (opt.mute) {
      if (opt.mute.psg) Emu.applyMute(player.psg.mute, opt.mute.psg);
      if (opt.mute.scc) Emu.applyMute(player.scc.mute, opt.mute.scc);
      if (opt.mute.opll && player.opll) Emu.applyMute(player.opll.mute, opt.mute.opll);
      if (opt.mute.opl && player.opl) Emu.applyMute(player.opl.mute, opt.mute.opl);
    }
    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = new Float32Array(totalOutSamples);
    const writeLog = [];
    let outPos = 0;
    // ★2026-08-20 スライスを「フレーム数固定」から「時間予算固定」へ変更(NSFの
    // capture.js captureSongAsyncと同じ方式・同じ理由。端末速度差の自動吸収)。
    // Worker実行時(src/audio/capture-worker-client.js)はopt.yieldFn/sliceBudgetMsで
    // 上書きされる。f===0で必ず一度onProgressを発火するのも同様(最初のonProgressで
    // 実再生のplayer.load()が走るため)。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      const frameWrites = f === 0 ? initWrites : []; // フレーム0はINIT中の書込みから続ける
      player.bus.onWrite = (addr, value) => frameWrites.push(packWrite(addr, value, 0));
      player.bus.onIoWrite = (port, value) => frameWrites.push(packWrite(port, value, 1));
      const frameBuf = player.renderFrame(sampleRate, regsOnly);
      player.bus.onWrite = null;
      player.bus.onIoWrite = null;
      writeLog.push(Int32Array.from(frameWrites)); // 詰めた整数の型付き配列で持つ(packWrite参照)
      if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, writeLog);
        await yieldFn();
        // 曲切替/停止の連打で先読みキャプチャが何本も積み上がりCPUを食い合うのを防ぐため、
        // 呼び出し元から「もう不要」と言われたらここでループ自体を打ち切る(onProgress側だけ
        // 無視してもエミュレーション自体は最後まで回り続けてしまうため不十分だった)。
        if (opt.shouldCancel && opt.shouldCancel()) return { audio, writeLog, player, frameRate: player.frameRate };
        sliceStart = performance.now();
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, writeLog);
    return { audio, writeLog, player, frameRate: player.frameRate };
  };

  Emu.KssPlayer = KssPlayer;
})(window);
