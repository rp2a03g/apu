/*
 * NSFプレイヤー（CPU + APU + Bus の統合）
 * MML.Emu.NsfPlayer
 *
 * - initSong(index): INITルーチンを呼び出して曲を初期化
 * - renderFrame(sampleRate): PLAYルーチンを1回呼び出し、1/60秒分の音声サンプルを生成
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK_NTSC = 1789773;
  const FRAME_RATE_NTSC = 60.0988;

  class NsfPlayer {
    /**
     * @param {Uint8Array} nsfBytes - 128バイトヘッダを含む完全なNSFバイナリ
     */
    constructor(nsfBytes) {
      this.header = MML.NSF.parseHeader(nsfBytes);
      const program = nsfBytes.slice(128);

      this.bus = new Emu.NsfBus({
        program,
        loadAddr: this.header.loadAddr,
        bankswitch: this.header.bankswitch,
        extraChips: this.header.extraChips
      });
      this.apu = new Emu.APU2A03(this.bus);
      this.bus.setApu(this.apu);
      this.cpu = new Emu.CPU6502(this.bus);

      this.cycleAccum = 0;
      this.cpuDebt = 0; // CPUが先行実行したサイクル数(フレーム跨ぎで持ち越す)

      // 再生速度(1=等速 〜 1/8=低速)。PLAY呼び出し頻度のみを間引き、
      // APU/拡張音源のクロック(=音程)は常に実時間のまま進めるため、
      // 音程を保ったままテンポだけを落とせる。
      this.speedFactor = 1;
      this._playFrameAccum = 0;
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     * @param {boolean} [pal=false]
     */
    initSong(songIndex, pal = false) {
      this.apu.reset();
      this.cpu.reset();
      // NSF仕様: INIT呼び出し前に全チャンネルを有効化しておく。
      // これにより INIT/PLAY 中の $4003 書き込みで lengthCounter が正しく設定される。
      this.apu.writeRegister(0x4017, 0x40); // フレームカウンタリセット・IRQ禁止
      this.apu.writeRegister(0x4015, 0x0F); // 全チャンネル有効
      this.cpu.A = songIndex & 0xFF;
      this.cpu.X = pal ? 1 : 0;
      this.cpu.Y = 0;
      this.cpu.call(this.header.initAddr);
      this.cpu.callActive = false; // INITは完了。最初のrenderFrameでPLAYを開始する
      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this._playFrameAccum = 0;
    }

    /**
     * 1フレーム(1/60秒)分の音声サンプルを生成する。
     * 各フレームの先頭でPLAYを呼ぶが、PLAYが1フレーム内に終わらない
     * 「ブロッキング型」(例:水戸黄門/Sunsoftは1回のPLAYで約612フレーム=10秒ぶんの
     * $4011直書きPCMスピーチをストリーミングしてからRTSする)にも対応するため、
     * PLAYが実行中の間はrenderFrameを跨いで継続し、完了するまで再呼び出ししない。
     * @param {number} sampleRate
     * @returns {Float32Array} 0.0〜1.16程度の振幅の波形データ
     */
    renderFrame(sampleRate) {
      const cyclesPerSample = CPU_CLOCK_NTSC / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / FRAME_RATE_NTSC);
      const out = new Float32Array(samplesThisFrame);

      // 拡張音源は添字ループで回す(毎CPUサイクル呼ぶ内側ループなので for...of の
      // イテレータ確保を避ける)。拡張なし(2A03のみ)なら nExp=0 でループ自体スキップ。
      const expansion = Object.values(this.bus.expansion);
      const nExp = expansion.length;
      const apu = this.apu, cpu = this.cpu;

      // 前フレームでPLAYが完了していれば新たに呼び出す。まだ実行中(複数フレームに
      // 跨るブロッキングPLAY)ならその実行を継続する。
      // speedFactor<1のときはPLAY呼び出し自体を間引いてテンポだけを落とす。
      // APU/拡張音源のクロックは下のループで常に実時間のまま進むため音程は変わらない。
      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          cpu.beginCall(this.header.playAddr);
        }
      }

      // CPU実行とAPUクロックをインターリーブし、各出力サンプル時点のレジスタ状態
      // ($4011直書きPCM等)を正しく反映する。cpuDebt(CPUが先行実行したサイクル)は
      // フレーム境界を跨いで持ち越す。
      for (let i = 0; i < samplesThisFrame; i++) {
        // フレーム内の現在時刻(0〜1)。bus.onWrite(キャプチャのwriteLog)が各書き込みに
        // 時刻を添えるのに使う($4011直書きPCMのように1フレームに十数回書く曲を、
        // 書き込みログから再生するNsfReplayStreamPlayerがフレーム内の正しい位置で
        // 再現するため。以前はフレーム頭で一括適用され、水戸黄門の音声が潰れていた)
        this.frameFrac = i / samplesThisFrame;
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          if (this.cpuDebt <= 0) {
            if (cpu.callActive) this.cpuDebt += cpu.stepCall();
            else this.cpuDebt = 1; // PLAY完了後、次フレームまではCPUアイドルでAPUのみ進む
          }
          this.cpuDebt--;
          apu.clock();
          for (let e = 0; e < nExp; e++) expansion[e].clock();
          this.cycleAccum -= 1;
        }
        let sample = apu.mixSample();
        for (let e = 0; e < nExp; e++) sample += expansion[e].mixSample();
        out[i] = sample;
      }
      return out;
    }
  }

  Emu.NsfPlayer = NsfPlayer;
  Emu.CPU_CLOCK_NTSC = CPU_CLOCK_NTSC;
  Emu.FRAME_RATE_NTSC = FRAME_RATE_NTSC;
})(window);
