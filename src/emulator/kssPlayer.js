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

      this.cpu = new Emu.CPUZ80(this.bus);
      this._setupBiosTraps();

      this.clockHz = MML.KSS.Z80_CLOCK;
      this.frameRate = this.header.device.palMode ? MML.KSS.PAL_FPS : MML.KSS.NTSC_FPS;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this.speedFactor = 1;
      this._playFrameAccum = 0;
    }

    // 実BIOS ROMを積んでいないため、標準MSX BIOSの固定アドレス(0x0000-0x01xx台)へ
    // CALLされた場合にゼロ埋めメモリをコードとして暴走実行してしまう
    // (多くの実機ゲーム由来ドライバはPSGへ直接OUTせずWRTPSG等のBIOSコールを使うため必須)。
    // PSG関連の3ルーチンは実際に効果を持たせ、それ以外は安全なダミー値を返すだけの
    // RETスタブ(VDP/スロット/キーボード等、KSS再生には無関係だが暴走防止のため用意)。
    _setupBiosTraps() {
      const psg = this.psg;
      const ret = (c) => { c.pc = c.pop16(); return 20; };
      this.cpu.traps = {
        0x0090: (c) => { // GICINI: PSGレジスタ7-13を無音初期化
          for (let r = 7; r <= 13; r++) { c.ioWrite(0xA0, r); c.ioWrite(0xA1, r === 7 ? 0x3F : 0); }
          return ret(c);
        },
        0x0093: (c) => { c.ioWrite(0xA0, c.a); c.ioWrite(0xA1, c.e); return ret(c); }, // WRTPSG A=reg,E=data
        0x0096: (c) => { c.ioWrite(0xA0, c.a); c.a = psg.readData(); return ret(c); }, // RDPSG A=reg->A=data
        // VDP/スロット/キーボード系: KSS再生には無関係だが、呼ばれても暴走しないようダミーRETにする
        0x001C: ret, 0x0024: ret, 0x0030: ret, // CALSLT/ENASLT/CALLF
        0x0047: ret, 0x004D: ret, 0x0050: ret, 0x0053: ret, 0x0056: ret, 0x0059: ret, 0x005C: ret, // VDP書込系
        0x004A: (c) => { c.a = 0; return ret(c); }, // RDVRM
        0x00D5: (c) => { c.a = 0; return ret(c); }, // GTSTCK
        0x00D8: (c) => { c.a = 0; return ret(c); }, // GTTRIG
        0x00DB: (c) => { c.a = 0; return ret(c); }, // GTPAD
        0x0132: ret, 0x0135: ret, // CHGCAP/CHGSND
        0x0138: (c) => { c.a = 0; return ret(c); }, // RSLREG
        0x013B: ret, // WSLREG
        0x013E: (c) => { c.a = 0; return ret(c); }, // RDVDP
        0x0141: (c) => { c.a = 0xFF; return ret(c); }, // SNSMAT(キー未押下扱い)
        0x0156: ret, // KILBUF
      };
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     */
    initSong(songIndex) {
      this.cpu.reset();
      this.psg.reset();
      this.scc.reset();
      if (this.opll) this.opll.reset();
      this.cpu.a = songIndex & 0xFF;
      this.cpu.iff1 = false;
      this.cpu.iff2 = false;
      this.cpu.im = 1;
      this.cpu.call(this.header.initAddr);
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

      const cpu = this.cpu, psg = this.psg, scc = this.scc, opll = this.opll;

      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          cpu.beginCall(this.header.playAddr);
        }
      }

      for (let i = 0; i < samplesThisFrame; i++) {
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          if (this.cpuDebt <= 0) {
            if (cpu.callActive) this.cpuDebt += cpu.stepCall();
            else this.cpuDebt = 1;
          }
          this.cpuDebt--;
          psg.clock();
          scc.clock();
          if (opll) opll.clock();
          this.cycleAccum -= 1;
        }
        if (!regsOnly) {
          let sample = psg.mixSample() + scc.mixSample();
          if (opll) sample += opll.mixSample();
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
    player.initSong(opt.songIndex || 0);
    if (opt.mute) {
      if (opt.mute.psg) Emu.applyMute(player.psg.mute, opt.mute.psg);
      if (opt.mute.scc) Emu.applyMute(player.scc.mute, opt.mute.scc);
      if (opt.mute.opll && player.opll) Emu.applyMute(player.opll.mute, opt.mute.opll);
    }
    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = new Float32Array(totalOutSamples);
    const writeLog = [];
    let outPos = 0;
    const CHUNK_FRAMES = regsOnly ? 10 : 60; // regsOnly(先読み用)はより細かくyieldする

    for (let f = 0; f < totalFrames; f++) {
      const frameWrites = [];
      player.bus.onWrite = (addr, value) => frameWrites.push({ addr, value, io: false });
      player.bus.onIoWrite = (port, value) => frameWrites.push({ addr: port, value, io: true });
      const frameBuf = player.renderFrame(sampleRate, regsOnly);
      player.bus.onWrite = null;
      player.bus.onIoWrite = null;
      writeLog.push(frameWrites);
      if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      if (f % CHUNK_FRAMES === 0) {
        if (onProgress) onProgress(f, totalFrames, writeLog);
        await new Promise(r => setTimeout(r, 0));
        // 曲切替/停止の連打で先読みキャプチャが何本も積み上がりCPUを食い合うのを防ぐため、
        // 呼び出し元から「もう不要」と言われたらここでループ自体を打ち切る(onProgress側だけ
        // 無視してもエミュレーション自体は最後まで回り続けてしまうため不十分だった)。
        if (opt.shouldCancel && opt.shouldCancel()) return { audio, writeLog, player, frameRate: player.frameRate };
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, writeLog);
    return { audio, writeLog, player, frameRate: player.frameRate };
  };

  Emu.KssPlayer = KssPlayer;
})(window);
