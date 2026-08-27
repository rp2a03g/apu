/*
 * HESプレイヤー (HuC6280 CPU + HesBus + APUHuC6280 の統合)
 * MML.Emu.HesPlayer
 *
 * ★GBS/NSF/KSSと異なり「INITを呼んで完了を待ち、以後PLAYを一定間隔で直接呼ぶ」という
 *   簡略設計は使えない(HESヘッダにPLAYアドレスが無い。hesBus.js冒頭コメント参照)。
 *   代わりに「INITアドレスへPCをセットして、あとは実時間どおりCPUを自由継続実行し、
 *   バス側のタイマ/垂直帰線割込を本物のIRQとしてディスパッチする」方式を取る
 *   (実機の動作そのもの)。INITが最終的にRTS/無限ループのどちらへ転んでも、
 *   周期的なIRQがPLAY相当の処理を呼び続ける限り再生は問題なく進む。
 *
 * - initSong(track): CPU/バス/APUをリセットし、PC=initAddr・A=track・SP=0xFDにセットする
 *   (Hes_Core.start_trackと同じ考え方の初期化。call/beginCallでRTSを待つのではなく、
 *   その場で以後の連続実行に委ねる)。
 * - renderFrame(sampleRate): マスタークロック(HES.CPU_CLOCK_HIGH=7159090Hz)を基準に
 *   CPU/バス/APUを1サンプル分ずつ同期実行する。CPUの消費サイクル数はCSH/CSLの状態で
 *   マスタークロックへの換算比が変わる(cpu.speedHigh: true→1倍, false→4倍)。
 *   APUクロック(PSG_CLOCK=3579545Hz=マスタークロックの半分)はマスタークロック2tickに
 *   つき1回進める。★CPU/バス用とAPU用でクロックのアキュムレータを分離しており、
 *   speedFactor(再生速度)はCPU/バス側にのみ掛かる(音程を変えずにテンポだけ変える。
 *   renderFrame()内のコメント参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class HesPlayer {
    /**
     * @param {Uint8Array} hesBytes - HESファイルの完全なバイナリ
     */
    constructor(hesBytes) {
      this.header = MML.HES.parseHeader(hesBytes);
      const start = this.header.dataOffset;
      const end = Math.min(hesBytes.length, start + this.header.dataSize);
      const rom = hesBytes.slice(start, Math.max(start, end));

      this.bus = new Emu.HesBus(this.header, rom);
      this.apu = new Emu.APUHuC6280();
      this.bus.apu = this.apu;
      this.cpu = new Emu.CPUHuC6280(this.bus);

      this.clockHz = MML.HES.CPU_CLOCK_HIGH;
      this.frameRate = MML.HES.VBLANK_FPS; // 抽出/描画用の名目フレームレート(実際のPLAY頻度とは独立)

      this.cpuCycleAccum = 0;
      this.apuCycleAccum = 0;
      this.cpuDebt = 0;
      this.psgTickAccum = 0;
      this.speedFactor = 1;
    }

    /**
     * 指定したトラック番号でINITを開始する。番号の意味はゲーム依存の任意値
     * (header.firstTrackが既定、M3U等で個別に案内される。hesHeader.js冒頭コメント参照)。
     * @param {number} track
     */
    initSong(track) {
      this.bus.reset();
      this.apu.reset();
      this.cpu.reset();

      // INITは実機同様RTSで戻ってくることが多い(GBS/NSF等と違い稀なケースではないと実測で
      // 判明)。cpu.beginCall()が積む番兵(CALL_SENTINEL=$FFFF)を戻り先にしておくことで、
      // RTS後にPCがそこへ到達してもcpuHuC6280.js側のstep()が実フェッチをせずアイドルする
      // (詳細はcpuHuC6280.js step()冒頭コメント参照。以前は$3FFFという「たまたまRAMだから
      // 安全なはず」の地点へ落としていたが、そこへ到達した後の命令フェッチが本来無関係な
      // ROMバイト列を実行してしまいスタック破壊→IRQ永久停止という不具合の原因になっていた)。
      this.cpu.A = track & 0xFF;
      this.cpu.beginCall(this.header.initAddr); // S=0xFF→0xFD(Hes_Core.start_trackと同じ値)
      // 実機はRESET直後Iフラグ=1(割込禁止)。INITが自分でCLIするまでIRQは発生しない
      // (cpu.reset()が既にP=F_Iにしている)。

      this.cpuCycleAccum = 0;
      this.apuCycleAccum = 0;
      this.cpuDebt = 0;
      this.psgTickAccum = 0;
    }

    /**
     * 1フレーム分の音声サンプルを生成する。
     * ★speedFactor(再生速度スライダー)はCPU/バス(タイマ・垂直帰線割込)の進行速度だけに
     *   掛け、PSGのクロック(apu.clock())は常に実時間のまま進める。これによりCPUが
     *   音符を書き換える頻度(テンポ)だけが変わり、実際に鳴っている音の周波数(音程)は
     *   変化しない。当初はCPU/PSG共通の1つのアキュムレータにspeedFactorを掛けていたため、
     *   速度を落とすとPSGの発振自体も遅くなり音程が下がってしまっていた
     *   (ユーザー報告で発覚。GBS/NSF/KSSはPLAY呼び出し頻度だけをspeedFactorで変える設計
     *   のため元々この問題が無かった。HESはPLAYを明示的に呼ばずCPU/バスを連続実行する
     *   設計のため、CPU用とAPU用でアキュムレータを分離する必要があった)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - trueならmixSample()を省略(先読みキャプチャ用軽量モード)
     * @param {Float32Array[]} [channelOut] - 渡された場合、mixSample()(6ch合算)の代わりに
     *   apu.mixChannelSamples()でchごとの値をchannelOut[0..5]へ書き込む(各要素は
     *   samplesThisFrame長のFloat32Arrayを呼び出し側で事前確保しておくこと)。
     *   HesBufferedPlayer(hes-stream-player.js)がリアルタイムミュート対応のため
     *   チャンネルごとに別々のAudioBufferチャンネルへレンダリングする用途で使う。
     * @param {boolean} [stereo] - trueならモノラルFloat32Arrayの代わりに
     *   {left, right}(各Float32Array)を返す(WAV書き出し用。channelOut指定時は無視)
     * @returns {Float32Array|{left:Float32Array,right:Float32Array}|null} channelOut指定時・regsOnly指定時はnull
     */
    renderFrame(sampleRate, regsOnly, channelOut, stereo) {
      const masterTicksPerSample = this.clockHz / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / this.frameRate);
      const outL = (regsOnly || channelOut) ? null : new Float32Array(samplesThisFrame);
      const outR = (regsOnly || channelOut || !stereo) ? null : new Float32Array(samplesThisFrame);

      const cpu = this.cpu, bus = this.bus, apu = this.apu;

      // キャプチャ(captureHesSongAsync)がDDA書込みのフレーム内時刻を分数フレームとして
      // 記録できるように、現在のサンプル位置を公開する(代入1回/サンプルなのでコストは無視できる)。
      this.frameSampleCount = samplesThisFrame;

      for (let i = 0; i < samplesThisFrame; i++) {
        this.frameSamplePos = i;
        // PSG: 常に実時間のクロックで進める(音程を変えないため)。
        // ★2026-08: 以前はマスタークロック1tickごとにapu.clock()を呼んでおり
        // (1サンプルあたり約162tick=マスタークロック7.16MHz÷44.1kHz)、リアルタイム
        // 再生(hes-stream-player.js)でこの関数呼出し回数の多さ自体がボトルネックになって
        // 音声スレッドの処理が間に合わず「がくがく」になっていた(ユーザー実測)。
        // 1サンプル分の整数tick数をまとめてapu.clockBy()へ渡す(結果はtickごとに
        // 呼んだ場合と数学的に同値、詳細はapuHuC6280.js PsgChannel.clockBy参照)。
        this.apuCycleAccum += masterTicksPerSample;
        const masterTicks = Math.floor(this.apuCycleAccum);
        this.apuCycleAccum -= masterTicks;
        const totalPsgAcc = this.psgTickAccum + masterTicks;
        const psgTicks = totalPsgAcc >> 1;      // PSGクロックはマスターの半分(2tickに1回)
        this.psgTickAccum = totalPsgAcc & 1;
        if (psgTicks > 0) apu.clockBy(psgTicks);

        // CPU/バス(タイマ・垂直帰線): speedFactorで進行速度を変える(テンポ変化のため)。
        // 命令境界(cpu.step())の間はバス側のカウンタをまとめて進めても、IRQ判定
        // (pollIrq、step()冒頭でしか見ない)の観測結果はtickごとに呼んだ場合と完全に
        // 同じになる(hesBus.js clockBy()冒頭コメント参照)。
        this.cpuCycleAccum += masterTicksPerSample * this.speedFactor;
        let cpuTicks = Math.floor(this.cpuCycleAccum);
        this.cpuCycleAccum -= cpuTicks;
        while (cpuTicks > 0) {
          if (this.cpuDebt <= 0) {
            const opCycles = cpu.step();
            this.cpuDebt = opCycles * (cpu.speedHigh ? 1 : 4);
          }
          const advance = Math.max(1, Math.min(cpuTicks, this.cpuDebt));
          bus.clockBy(advance);
          this.cpuDebt -= advance;
          cpuTicks -= advance;
        }
        if (channelOut) {
          const samples = apu.mixChannelSamples();
          for (let c = 0; c < samples.length; c++) channelOut[c][i] = samples[c];
        } else if (!regsOnly) {
          const s = apu.mixSample();
          if (stereo) { outL[i] = s.left; outR[i] = s.right; }
          else outL[i] = (s.left + s.right) * 0.5;
        }
      }

      return stereo ? { left: outL, right: outR } : outL;
    }
  }

  // 鍵盤表示/ロール用: APUのライブ状態を1フレーム分スナップショットする(gbsPlayer.jsの
  // snapshotApuと同じ考え方。HES PSGは波形/ノイズ位相が内部クロックのみで進行するため
  // writeLog再生では追えず、ライブAPUから直接読む方式に統一する)。
  // ★noiseCtrl(生の$0807値)はon/off(bit7)だけでなく下位5bitに周期選択値も持つ。
  // 以前はnoiseOn(on/offの真偽値)しか記録していなかったため、この値を消費する側
  // (hes2mml/expansion/noise.jsのpsgNoiseFreq()、main.js buildHesRollTimeline経由の
  // noiseChannel()、hes-stream-player.js _applyFrame())が軒並みnoiseCtrl=undefinedを
  // 受け取り、~undefined→-1→&0x1F=31という「常に最遅固定周期」にすり替わっていた
  // (実測: TP03018.hes index77でノイズの音程が常に同じに聞こえる不具合の真因)。
  // noiseOn自体は活性判定の簡易フラグとして他箇所で使われ続けるためそのまま残し、
  // 生のnoiseCtrlを別フィールドとして追加する。
  function snapshotApu(apu) {
    const arr = apu.ch.map(c => ({
      on: c.on, dda: c.dda, noiseOn: c.hasNoise && (c.noiseCtrl & 0x80) !== 0,
      noiseCtrl: c.noiseCtrl,
      freq: c.freq, vol: c.volume, balance: c.balance,
      wave: Array.from(c.wave), dac: c.dac
    }));
    // $0801(全体バランス)。従来はチャンネル別の$0805(c.balance)しか記録しておらず、
    // 全体バランスだけで片方の出力バスへ振り切って無音化するケースを抽出側が検知
    // できなかった(apuHuC6280.js snapshotHuC6280ApuのglobalモPanL/PanRと同じ考え方、
    // ライブ鍵盤表示側には既にあったがregsOnly抽出側には無かった)。
    arr.globalBalance = apu.balance;
    return arr;
  }

  /**
   * HESを指定秒数分オフラインレンダリングし、音声・フレーム毎のAPUライブスナップショット・
   * DDA(PCM)書込みトレースを返す(captureGbsSongAsyncと同型)。
   *
   * ★GBS/NSF/KSSのwriteLog(フレーム毎の全レジスタ書込みをそのまま保持する配列)は
   * ここでは持たない。HESはGbsPlayer.js冒頭コメントの通りwriteLog再生方式を使わず
   * 常にライブAPUスナップショット方式なので、そもそもwriteLogの利用箇所が無い
   * (hes2mml側もsnapshots/dpcmTraceだけを使う)。にもかかわらず初期実装では
   * GBS由来の設計をそのままコピーして全フレーム分のwriteLogを蓄積し続けていたため、
   * CPUの通常実行だけで1フレームあたり数千件(ゼロページ/スタック書込み込み)、
   * DDA(PCM)を多用する曲では1フレームあたり数千〜1万件規模に達し、180秒の曲では
   * 総レコード数が2000万件を超えて未使用のまま保持され続け、V8のGCが著しく劣化して
   * 「変換が事実上終わらない」不具合になっていた(ユーザー報告で発覚。フレームが進むに
   * つれ1フレームの処理時間が実測10ms→100ms超まで悪化する挙動から特定)。使われない
   * データを丸ごと削除することで直接解消する。
   * @param {Uint8Array} hesBytes
   * @param {object} opt - {track, durationSeconds, sampleRate, mute, regsOnly, speedFactor, perChannelAudio}
   * @param {(done:number,total:number,data:{snapshots:Array})=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, channelAudio:Float32Array[]|null, snapshots:Array, dpcmTrace:Array, controlTrace:Array, player:HesPlayer, frameRate:number}>}
   */
  Emu.captureHesSongAsync = async function (hesBytes, opt, onProgress) {
    const player = new HesPlayer(hesBytes);
    player.initSong(opt.track != null ? opt.track : player.header.firstTrack);
    if (opt.mute) Object.assign(player.apu.mute, opt.mute);
    // speedFactor: オフライン一括レンダリング(hes-stream-player.js HesBufferedPlayer)が
    // 再生速度スライダーの値をここへ渡す。renderFrame()側で既にCPU/APUのクロックを
    // 分離済み(音程を変えずテンポだけ変わる)なので、そのままplayer.speedFactorへ
    // 反映するだけでよい。
    if (opt.speedFactor != null) player.speedFactor = opt.speedFactor;

    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    // perChannelAudio: 6chぶんを合算済みの1本(audio)ではなく、chごとに独立したFloat32Array
    // (channelAudio[0..5])で受け取る。HesBufferedPlayerがこれを使い、再生時にGainNode経由で
    // 各chを即座にミュートできるようにする(録音後のバッファへミュートを焼き込む方式だと
    // 再生中のミュート切替のたびに再レンダリングが必要になってしまうため。ファイル冒頭の
    // 経緯コメント参照)。ミュート(opt.mute)はこのモードでは意味を持たない
    // (呼び出し側がGainNodeで適用する)。
    const perChannel = !!opt.perChannelAudio;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = (regsOnly || perChannel) ? new Float32Array(0) : new Float32Array(totalOutSamples);
    // channelAudioOut: 呼び出し側(HesBufferedPlayer)が事前確保した配列をそのまま渡せる。
    // レンダリング完了を待たず「今埋まっている範囲まで」を同じ配列参照から直接読みながら
    // 再生を始められるようにするため(このキャプチャの結果を受け取ってからコピーするのでは
    // 再生開始がレンダリング完了まで遅れてしまう。main.js playHesStream()冒頭コメント参照)。
    const channelAudio = perChannel
      ? (opt.channelAudioOut || Array.from({ length: MML.Emu.APUHuC6280_CH_COUNT }, () => new Float32Array(totalOutSamples)))
      : null;
    const samplesThisFrame = Math.round(sampleRate / player.frameRate);
    const channelScratch = perChannel
      ? Array.from({ length: MML.Emu.APUHuC6280_CH_COUNT }, () => new Float32Array(samplesThisFrame))
      : null;
    const snapshots = [];
    // DDA(直接D/A、PCM)モード中の$0806書込みをch別に記録する(hes2mml/expansion/dpcm.js向け)。
    // 1フレームに数十〜百回書かれるため、フレーム単位のsnapshotsだけでは波形を再現できない
    // (詳細はplayHesStream()冒頭コメント参照)。フックはループの外で1回だけ設定し、
    // 現在フレーム番号はクロージャではなく可変変数currentFrameで渡す(毎フレーム新しい
    // クロージャを作らないための最適化。上のコメントのGC劣化対策の一環)。
    // ★2026-08: 各エントリにフレーム番号(frame)に加えて以下を持たせる:
    //   t   … 分数フレーム時刻(frame + フレーム内サンプル位置/フレーム内サンプル数)。
    //         クリップの実再生レートをフレーム量子化誤差なしで推定するため。
    //   seq … controlTrace/dpcmTraceで共通の単調増加連番。同じドラムの「off→次のon」が
    //         ほぼ常に同一フレーム内で起きるため(NX91002.hes実測で打点の254/255)、frameだけでは
    //         書込み順を復元できず、前クリップの尾(平均約80サンプル≒12ms)が次クリップの頭に
    //         混入して「同じドラムなのに毎回別波形」になり重複排除が全滅していた。連番により
    //         区切りを書込み1件単位で正確に復元する(hes2mml/expansion/dpcm.js冒頭コメント参照)。
    //   src … (dpcmTraceのみ)そのサンプル値の読出し元ROM物理オフセット。読出し元が
    //         ROM以外(RAM経由・加工あり)のときは-1。cpuHuC6280.js fetchOperandが記録する
    //         lastDataAddr(直近のデータ読出し論理アドレス)を物理へ換算し、さらに
    //         「ROMバイト==書込み値」の一致検証を通ったものだけ採用する。
    //         同一ドラム=同一ROM開始アドレスなので重複排除が確定的になる。
    const dpcmTrace = [[], [], [], [], [], []]; // ch毎: [{frame, t, seq, value, src}]
    // $0804(chの on/DDA 制御レジスタ)書込みをch別・書込み順に記録する(hes2mml/expansion/
    // dpcm.js向け)。DDA(PCM)で打楽器を鳴らす曲は1音ごとに on/dda を素早くon/offし直すことが
    // 多く、その切替がフレーム(1/60秒)より短い間隔で起きうる。snapshots(フレーム単位の
    // 状態サンプリング)だけでは切替を取りこぼし、複数の打点が「1本の連続音」として
    // 誤って結合されてしまう(ユーザー実測: NX91002.hesで全打楽器が1音に繋がる不具合)。
    // dpcmTraceと同じ理由でここも書込みイベントをそのまま記録する。
    const controlTrace = [[], [], [], [], [], []]; // ch毎: [{frame, t, seq, on, dda, vol}]
    // $0802/$0803(12bit周期)書込み列。音量(controlTraceのvol)と同じ理由で、ピッチ列
    // (ビブラート/EPテーブル・音程判定)の位相エイリアシング対策のノート相対時刻リサンプル
    // (hes2mml/expansion/wave.js)に使う。freqは書込み適用後の12bit値
    // (apuHuC6280.js writeDataの$0802/$0803と同じ合成式をシャドウで再現。onWriteは
    // APU側への適用より先に呼ばれるためAPUの値は読めない)。
    const pitchTrace = [[], [], [], [], [], []]; // ch毎: [{t, freq}]
    const freqShadow = new Uint16Array(6);
    for (let i = 0; i < 6; i++) freqShadow[i] = player.apu.ch[i] ? player.apu.ch[i].freq : 0;
    let currentFrame = 0;
    let traceSeq = 0; // controlTrace/dpcmTrace共通の書込み順連番(上のコメント参照)
    player.bus.onWrite = (addr, value) => {
      const sel = player.apu.selected;
      // $0800は3bit(0-7)なのでch6/7が選ばれうるが、実機にそのchは無い。
      // apuHuC6280側も「selected >= CH_COUNT なら書込み無視」としているので、
      // トレースも同じ規則で捨てる。ここを守らないと6ch分しかないtrace配列が
      // 範囲外アクセスになり変換ごと落ちる(HC63015.hes等6曲で実際に発生)。
      // $0801(全体バランス)は全chの実効音量に効く(bal/gbalのコメント参照)ため、
      // チャンネル選択($0800)とは無関係に全chのタイムラインへ変化点を積む
      if (addr === 0x0801) {
        const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
        for (let ch = 0; ch < controlTrace.length; ch++) {
          const c = player.apu.ch[ch];
          if (!c) continue;
          controlTrace[ch].push({ frame: currentFrame, t, seq: traceSeq++, on: c.on, dda: c.dda, vol: c.volume, bal: c.balance, gbal: value });
        }
        return;
      }
      if (sel >= controlTrace.length) return;
      if (addr === 0x0804) {
        const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
        // vol(下位5bit): HESのソフトウェア音量エンベロープはゲーム内蔵タイマー駆動で、
        // 周期がキャプチャフレームレートと一致しない(実測: NX91002は約54.9Hz)。フレーム境界の
        // スナップショットで音量をサンプリングすると位相エイリアシングで「同じエンベロープの
        // 1フレーム違い列」が量産されるため、hes2mml/expansion/wave.jsが書込みイベント列から
        // ノート相対時刻でリサンプルできるよう生値も残す(同expansion冒頭コメント参照)。
        // bal/gbal($0805のch別バランス・$0801の全体バランス): これらは「パン」ではなく
        // 音量レジスタと同じインデックスへ合流する減衰器で、実質的に第2の音量レジスタ
        // (実測でbalanceだけで減衰エンベロープを作る曲がある。hes2mml/expansion/wave.js
        // effectiveVolIndex冒頭コメント参照)。抽出側が実効音量を復元できるよう
        // 書込み時点のシャドウ値を添える(onWriteはAPUへの適用前に呼ばれるが、
        // 別レジスタである$0805/$0801の値は既に反映済みなのでそのまま読んでよい)。
        const c = player.apu.ch[sel];
        controlTrace[sel].push({ frame: currentFrame, t, seq: traceSeq++, on: (value & 0x80) !== 0, dda: (value & 0x40) !== 0, vol: value & 0x1F, bal: c ? c.balance : 0xFF, gbal: player.apu.balance });
      } else if (addr === 0x0805) {
        // ch別バランス変更も実効音量の変化点(上記コメント参照)。on/ddaは現在の
        // シャドウをそのまま載せるのでbuildChannelRuns(状態遷移のみ見る)には影響しない
        const c = player.apu.ch[sel];
        if (c) {
          const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
          controlTrace[sel].push({ frame: currentFrame, t, seq: traceSeq++, on: c.on, dda: c.dda, vol: c.volume, bal: value, gbal: player.apu.balance });
        }
      } else if (addr === 0x0802 || addr === 0x0803) {
        freqShadow[sel] = addr === 0x0802
          ? (freqShadow[sel] & 0xF00) | value
          : (freqShadow[sel] & 0x0FF) | ((value & 0x0F) << 8);
        const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
        pitchTrace[sel].push({ t, freq: freqShadow[sel] });
      } else if (addr === 0x0806) {
        const ch = player.apu.ch[sel];
        if (ch && ch.dda && ch.on) {
          const t = currentFrame + (player.frameSamplePos || 0) / (player.frameSampleCount || 1);
          // 読出し元ROM物理オフセット(dpcmTrace冒頭コメント参照)。lastDataAddrは
          // 論理アドレスなのでMPRで物理バンクへ換算し、実際にそのROMバイトが
          // 書込み値と一致する(下位5bit、無加工ストリーミング)場合だけ採用する。
          // 音量テーブル加工やRAMバッファ経由のROMではここが-1になり、抽出側は
          // バイト列一致の重複排除へフォールバックする。
          let src = -1;
          const la = player.cpu.lastDataAddr;
          if (la >= 0) {
            const bank = player.bus.mpr[(la & 0xFFFF) >>> 13];
            if (bank < 0x80) {
              const off = bank * 0x2000 + (la & 0x1FFF) - player.bus.romBase;
              if (off >= 0 && off < player.bus.rom.length && (player.bus.rom[off] & 0x1F) === (value & 0x1F)) src = off;
            }
          }
          dpcmTrace[sel].push({ frame: currentFrame, t, seq: traceSeq++, value: value & 0x1F, src });
        }
      }
    };

    let outPos = 0;
    // ★2026-08: 以前は経過実時間ベース(100msごと)でyieldしていたが、これはKSS/GBS等の
    // 「固定フレーム数(CHUNK_FRAMES)ごとにyield」という確立済みの方式より縮小方向の
    // 最適化を狙ったものの、副作用として「通常曲(1フレーム1ms未満)だと100ms間に
    // 100フレーム以上をyield無しで連続実行してしまい、その間ずっとメインスレッドを
    // 占有してリアルタイム再生側(ScriptProcessorNodeコールバック)を飢餓状態にする」
    // という、まさにKSSで過去に踏んだのと同種の不具合(captureKssSongAsync冒頭の
    // 教訓: 「曲切替連打でキャプチャが何本も積み上がりCPUを食い合う」問題とは別だが、
    // 根は同じ「重いキャプチャループが実時間の再生を圧迫する」)を再生読み込み中ずっと
    // 起こしていた(ユーザー指摘・実測で発覚)。KSSと同じ固定フレーム数方式に戻し、
    // yieldの上限間隔を短く保つことでメインスレッドを定期的に手放す(DDA多用曲は
    // 1フレームが重いぶんチャンクの実時間は長くなるが、それ自体は元々避けられない)。
    // ★2026-08-20 スライスを「フレーム数固定(CHUNK_FRAMES)」から「時間予算固定」へ変更
    // (capture.js captureSongAsyncと同じ方式)。上の経緯コメントの「経過実時間ベース
    // (100msごと)yield」の失敗と向きが逆である点に注意: あれは「100ms連続でメイン
    // スレッドを占有してからyield」でスライスが長すぎたのが問題。こちらは「5ms使ったら
    // 必ずyield」でスライス上限を従来のCHUNK_FRAMES方式より短く保証する(DDA多用曲の
    // 重い1フレームでも超過は1フレーム分だけ)。Worker実行時(capture-worker-client.js)は
    // opt.yieldFn/sliceBudgetMsで上書きされる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      currentFrame = f;
      if (perChannel) {
        player.renderFrame(sampleRate, false, channelScratch);
        const n = Math.min(samplesThisFrame, totalOutSamples - outPos);
        for (let c = 0; c < channelAudio.length; c++) {
          channelAudio[c].set(n === samplesThisFrame ? channelScratch[c] : channelScratch[c].subarray(0, n), outPos);
        }
        outPos += n;
      } else {
        const frameBuf = player.renderFrame(sampleRate, regsOnly);
        if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      }
      snapshots.push(snapshotApu(player.apu));
      if (f === 0 || f === totalFrames - 1 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, { snapshots, samplesReady: outPos, frameRate: player.frameRate, dpcmTrace, controlTrace, pitchTrace });
        await yieldFn();
        if (opt.shouldCancel && opt.shouldCancel()) {
          return { audio, channelAudio, snapshots, dpcmTrace, controlTrace, pitchTrace, player, frameRate: player.frameRate };
        }
        sliceStart = performance.now();
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, { snapshots, samplesReady: outPos, frameRate: player.frameRate, dpcmTrace, controlTrace, pitchTrace });
    return { audio, channelAudio, snapshots, dpcmTrace, controlTrace, pitchTrace, player, frameRate: player.frameRate };
  };

  Emu.HesPlayer = HesPlayer;
  // VGM(vgmPlayer.js captureVgmSongAsync)がHuC6280チップのフレームスナップショットを
  // hes2mml抽出器と同じ形で積むために公開する(gbsPlayer.jsのsnapshotGbApuForCaptureと同じ)。
  Emu.snapshotHesApuForCapture = snapshotApu;
})(window);
