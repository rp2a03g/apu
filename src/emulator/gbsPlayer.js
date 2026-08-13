/*
 * GBSプレイヤー (SM83 CPU + GbsBus + APUGb の統合)
 * MML.Emu.GbsPlayer
 *
 * ★割込ディスパッチを実装しない簡略設計: 実機/実ゲームはPLAYをVBlank割込または
 *   タイマ割込のハンドラから呼び出すが、その経路(IE/IF・HALT・RETI)を丸ごと
 *   再現しなくても、「ヘッダのTMA/TACから求めた頻度でPLAYをサブルーチンとして
 *   直接beginCall/stepCallする」だけで音声出力上は同じ結果になる
 *   (INIT/PLAYが呼ばれる回数とタイミングさえ合っていれば、割込経由かサブルーチン
 *   直接呼出しかは音源レジスタへの書き込み内容に影響しない。KSS/NSFプレイヤーが
 *   INIT/PLAYを直接呼び出しているのと同じ考え方)。PLAYがRETIで終わっていても、
 *   CPUSm83のRETIはRETと同じスタック復帰をした上でime=trueにするだけなので、
 *   beginCall()が積んだ番兵アドレスへの復帰検出は問題なく機能する。
 *
 * - initSong(songIndex): INITルーチンを呼び出して曲を初期化(A=0始まり曲番号)
 * - renderFrame(sampleRate): PLAYルーチンをヘッダのTMA/TAC(またはVBlank既定)で
 *   求まる頻度で呼び出しつつ、1フレーム分の音声サンプルを生成する
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class GbsPlayer {
    /**
     * @param {Uint8Array} gbsBytes - GBSファイルの完全なバイナリ
     */
    constructor(gbsBytes) {
      this.header = MML.GBS.parseHeader(gbsBytes);
      const rom = gbsBytes.slice(this.header.dataOffset);

      this.bus = new Emu.GbsBus(this.header, rom);
      this.apu = new Emu.APUGb();
      this.bus.apu = this.apu;
      this.cpu = new Emu.CPUSm83(this.bus);

      this.clockHz = MML.GBS.CPU_CLOCK;
      this.frameRate = this.header.playFps;

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
      this.bus.reset();
      this.apu.reset();
      this.cpu.reset();
      this.cpu.a = songIndex & 0xFF;
      this.cpu.sp = this.header.stackPointer;
      this.cpu.beginCall(this.header.initAddr);
      let cycles = 0;
      const maxCycles = this.clockHz; // 最大1秒相当まで(KSSと同じ安全弁)
      while (this.cpu.callActive && cycles < maxCycles) cycles += this.cpu.stepCall();
      this.cpu.callActive = false;

      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this._playFrameAccum = 0;
    }

    /**
     * 1フレーム分の音声サンプルを生成する。PLAYが1フレーム内に終わらない場合は
     * renderFrameを跨いで継続する(NsfPlayer/KssPlayer.renderFrameと同じ設計)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - trueならmixSample()を省略し、CPU実行・APUのclock()
     *   だけを行う(鍵盤表示/ピアノロールの先読みキャプチャ用の軽量モード)
     * @param {boolean} [stereo] - trueならモノラルFloat32Arrayの代わりに
     *   {left, right}(各Float32Array)を返す(WAV書き出し用)
     * @returns {Float32Array|{left:Float32Array,right:Float32Array}|null}
     */
    renderFrame(sampleRate, regsOnly, stereo) {
      const cyclesPerSample = this.clockHz / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / this.frameRate);
      const outL = regsOnly ? null : new Float32Array(samplesThisFrame);
      const outR = (regsOnly || !stereo) ? null : new Float32Array(samplesThisFrame);

      const cpu = this.cpu, apu = this.apu;

      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          // ドライバがINIT/前回PLAY中に積んだ分でスタックが延々ドリフトするのを防ぐ
          // (kssPlayer.jsのexec_setupと同じ考え方)
          cpu.sp = this.header.stackPointer;
          cpu.beginCall(this.header.playAddr);
        }
      }

      // CPUとAPUは同一クロック(4194304Hz)なので、KSSのようなクロック比変換は不要。
      // cpuDebtは「今実行中の命令が消費し終えるまでの残りTステート数」を表す。
      for (let i = 0; i < samplesThisFrame; i++) {
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          this.cycleAccum -= 1;
          if (this.cpuDebt <= 0) {
            this.cpuDebt = cpu.callActive ? cpu.stepCall() : 1;
          }
          this.cpuDebt--;
          apu.clock();
        }
        if (!regsOnly) {
          const s = apu.mixSample();
          if (stereo) { outL[i] = s.left; outR[i] = s.right; }
          else outL[i] = (s.left + s.right) * 0.5;
        }
      }

      return stereo ? { left: outL, right: outR } : outL;
    }
  }

  // APUのライブ状態を1フレーム分スナップショットする(gbs2mml向け)。
  // GBはCH1の周波数スイープ・エンベロープの減衰/増加が「レジスタ再書込み無しに
  // 内部クロックだけで」進行するため、writeLogの再生(SCC方式)では追えない
  // (N163のRAMスナップショットが必要だった事情と同種。src/emulator/capture.js参照)。
  // ライブのAPUオブジェクトから直接値を読む方が単純かつ正確なので、GBSは
  // 全チャンネルをこの方式に統一する(波形メモリも書込み再生ではなくch3.waveを直接読む)。
  function snapshotApu(apu) {
    return {
      // envInitVol/envDir/envPeriod: NRx2の生値(トリガー時に固定される、実機の
      // エンベロープハードウェアパラメータそのもの)。gbs2mml側でこれを起点(anchor)に
      // 「64Hz固定クロック×period」で音量を解析的に計算し直すために必要
      // (src/gbs2mml/expansion/hwEnvelope.js参照。駆動フレーム境界(playFps、曲毎に
      // 可変)で単純にvolを読むと、実機の64Hzエンベロープクロックとの位相ズレにより
      // 同一形状のエンベロープでも観測される段数が変わってしまう問題への対処)。
      ch1: { freq: apu.ch1.freq, duty: apu.ch1.duty, vol: apu.ch1.envelope.volume, enabled: apu.ch1.enabled, triggerSeq: apu.ch1.triggerSeq,
             envInitVol: apu.ch1.envelope.initialVolume, envDir: apu.ch1.envelope.direction, envPeriod: apu.ch1.envelope.period },
      ch2: { freq: apu.ch2.freq, duty: apu.ch2.duty, vol: apu.ch2.envelope.volume, enabled: apu.ch2.enabled, triggerSeq: apu.ch2.triggerSeq,
             envInitVol: apu.ch2.envelope.initialVolume, envDir: apu.ch2.envelope.direction, envPeriod: apu.ch2.envelope.period },
      ch3: { freq: apu.ch3.freq, volumeShift: apu.ch3.volumeShift, wave: Array.from(apu.ch3.wave), enabled: apu.ch3.enabled, dacOn: apu.ch3.dacOn, triggerSeq: apu.ch3.triggerSeq },
      ch4: { vol: apu.ch4.envelope.volume, clockShift: apu.ch4.clockShift, widthMode: apu.ch4.widthMode, divisorCode: apu.ch4.divisorCode, enabled: apu.ch4.enabled, triggerSeq: apu.ch4.triggerSeq,
             envInitVol: apu.ch4.envelope.initialVolume, envDir: apu.ch4.envelope.direction, envPeriod: apu.ch4.envelope.period },
      // NR50(マスター音量/VIN)・NR51(パンニング)。以前はここに含まれておらず、
      // GbsReplayStreamPlayerが常にAPUGbコンストラクタのブート後既定値(nr50=$77,
      // nr51=$F3)のまま再生し続けていた(実際にゲームが書き込んだ値を無視)。
      // $F3はCH3/CH4の右chビットだけ0なので、曲を問わず常にCH3/CH4が左chにしか
      // 出力されないように聴こえる不具合の直接の原因だった。
      nr50: apu.nr50, nr51: apu.nr51
    };
  }

  /**
   * GBSを指定秒数分オフラインレンダリングし、音声・フレーム毎のレジスタ書込ログ・
   * フレーム毎のAPUライブスナップショットを返す。WAV書き出し・gbs2mml変換・
   * ピアノロールの先読みキャプチャで使う共通キャプチャ関数(captureKssSongAsyncと同型)。
   * @param {Uint8Array} gbsBytes
   * @param {object} opt - {songIndex, durationSeconds, sampleRate, mute, regsOnly}
   * @param {(done:number,total:number,data:{writeLog:Array,snapshots:Array})=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, writeLog:Array, snapshots:Array, player:GbsPlayer, frameRate:number}>}
   */
  Emu.captureGbsSongAsync = async function (gbsBytes, opt, onProgress) {
    const player = new GbsPlayer(gbsBytes);
    // INIT中の書込みもフレーム0の先頭に含める(NSF/KSSのinitWritesと同じ考え方。
    // INITで一度だけ設定されPLAY中は二度と書かれないレジスタの取りこぼし防止)。
    const initWrites = [];
    player.bus.onWrite = (addr, value) => initWrites.push({ addr, value });
    player.initSong(opt.songIndex || 0);
    player.bus.onWrite = null;
    if (opt.mute) Object.assign(player.apu.mute, opt.mute);

    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = new Float32Array(totalOutSamples);
    const writeLog = [];
    const snapshots = [];
    let outPos = 0;
    const CHUNK_FRAMES = regsOnly ? 10 : 60;

    for (let f = 0; f < totalFrames; f++) {
      const frameWrites = f === 0 ? initWrites : [];
      player.bus.onWrite = (addr, value) => frameWrites.push({ addr, value });
      const frameBuf = player.renderFrame(sampleRate, regsOnly);
      player.bus.onWrite = null;
      writeLog.push(frameWrites);
      snapshots.push(snapshotApu(player.apu));
      if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      if (f % CHUNK_FRAMES === 0) {
        if (onProgress) onProgress(f, totalFrames, { writeLog, snapshots });
        await new Promise(r => setTimeout(r, 0));
        if (opt.shouldCancel && opt.shouldCancel()) return { audio, writeLog, snapshots, player, frameRate: player.frameRate };
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, { writeLog, snapshots });
    return { audio, writeLog, snapshots, player, frameRate: player.frameRate };
  };

  Emu.GbsPlayer = GbsPlayer;
})(window);
