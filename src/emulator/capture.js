/*
 * 再生ログ一括キャプチャ（プリレンダー）
 * MML.Emu.captureSong / MML.Emu.dcBlock
 *
 * INIT実行後、指定秒数分のPLAYルーチンを毎フレーム実行し、
 * - 全レジスタ書き込みのタイムラインログ
 * - 全フレーム分の音声波形（DCブロック済み）
 * を一括生成する。生成後はシーク・早送り・巻き戻しが
 * 音声バッファへのアクセスのみで完結する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * KSS形式writeLogの1書込みを1つの整数へ詰める(2026-09-04)。
   *   bit0-15 = addr(メモリアドレス or I/Oポート) / bit16-23 = value / bit24 = io(1ならI/O)
   *
   * {addr,value,io}のJSオブジェクトは実測75〜90B/件で、KSSは1フレーム平均84〜152件書くため
   * 60秒で27〜41MB(実RSS)を占めていた。詰めればフレームごとの Int32Array で4B/件になる
   * (実測 xak.kss 60秒: 27MB → 1.2MB)。型付き配列なので構造化クローン(キャプチャWorkerの
   * 差分送信)もそのまま通る。読む側は kss2mml/expansion/*.js と kss-stream-player.js と
   * roll-builders.js。
   *
   * ★定義場所はここ(capture.js)。KSS(kssPlayer.js)とVGM(vgmPlayer.js: AY/SSG/SCC/OPLL/OPLの
   *   書込みをKSS形式で積む)の両方が使い、両方のWorkerバンドルに入る唯一の共通ファイルのため。
   *   以前は kssPlayer.js にあり、VGMのWorkerバンドル(kssPlayer.jsを含まない)で
   *   「Emu.kssPackWrite is not a function」で落ちて、AY/SSG/OPLを使うVGMのロールが空になる
   *   (途中で落ちると取得済み範囲で打ち切られる)不具合の原因になっていた(2026-09-07)。
   */
  Emu.kssPackWrite = (addr, value, io) => (addr & 0xFFFF) | ((value & 0xFF) << 16) | (io ? 0x1000000 : 0);

  /**
   * チャンネルごとのミュート設定をチップの mute プロパティへ反映する。
   * target がオブジェクトならキー一致、配列ならインデックス一致で上書きする。
   */
  Emu.applyMute = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = !!source[i];
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = !!source[k];
      }
    }
  };

  /**
   * チャンネルごとの音量(0〜2、1=100%で2まではブースト)設定をチップの vol プロパティへ
   * 反映する。applyMuteと同じkey/index一致方式(未指定のチャンネルは既存値=通常1のまま
   * 変更しない)。
   */
  Emu.applyVolume = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = Math.max(0, Math.min(2, source[i]));
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = Math.max(0, Math.min(2, source[k]));
      }
    }
  };

  // NESの非線形ミキサー出力(DCオフセット付き)をAC成分に変換するDCブロッカー
  Emu.dcBlock = function (samples) {
    const out = new Float32Array(samples.length);
    let prevX = 0, prevY = 0;
    const R = 0.999;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = x - prevX + R * prevY;
      out[i] = y;
      prevX = x;
      prevY = y;
    }
    return out;
  };

  /**
   * 楽曲キャプチャの共通セットアップ。player・バッファ・ログ配列を返す。
   * @private
   */
  function _setupCapture(nsfBytes, opt) {
    const songIndex = opt.songIndex || 0;
    const durationSeconds = opt.durationSeconds || 10;
    const sampleRate = opt.sampleRate || 44100;

    const player = new Emu.NsfPlayer(nsfBytes);
    // initSong の書き込みを runningRegs に先取りしてスナップショットの初期状態とする。
    // initWrites は同じ書き込みを順序付きで(重複アドレスも全て)記録したもの。
    // $F800/$4800(N163)・$C000/$E000(FME7)・$9010/$9030(VRC7)のようなラッチ+データ間接
    // アドレッシングのチップは、runningRegsの最終値スナップショットだけでは内部レジスタ
    // 全体を復元できない(同じ2アドレスに何度も書き込むため)ので、拡張音源の
    // buildTimeline側で書き込みシーケンスをそのまま再生できるようにこちらも保持する。
    const runningRegs = {};
    const initWrites = [];
    // NsfPlayer.initSong()は$4017(フレームカウンタリセット)・$4015(全チャンネル有効化)を
    // bus.write()を経由せずAPU.writeRegister()へ直接書き込むため、onWriteフックを
    // 通らずinitWritesに記録されない。NSF自体のINITルーチンがこれらを書き直さない曲
    // (例: アルマナの軌跡のようなFDS曲で2A03パルス/三角/ノイズ側を$4015再設定しない
    // ドライバ)だと、initWritesの再生だけで音源を組み立てるNsfReplayStreamPlayerでは
    // $4015が一度も有効化されず2A03が全チャンネル無音になる不具合があった。
    // initSong()内部の書き込み順序と同じ順で先に記録しておく(曲のINITが実際に
    // 書き直した場合は後続の通常記録で上書きされるので問題ない)。
    runningRegs[0x4017] = 0x40; initWrites.push({ addr: 0x4017, value: 0x40 });
    runningRegs[0x4015] = 0x0F; initWrites.push({ addr: 0x4015, value: 0x0F });
    player.bus.onWrite = (a, val) => { runningRegs[a] = val; initWrites.push({ addr: a, value: val }); };
    player.initSong(songIndex, !!opt.pal);
    player.bus.onWrite = null;

    if (opt.mute) {
      if (opt.mute.apu) Emu.applyMute(player.apu.mute, opt.mute.apu);
      if (opt.mute.expansion) {
        for (const [name, chip] of Object.entries(player.bus.expansion)) {
          if (opt.mute.expansion[name]) Emu.applyMute(chip.mute, opt.mute.expansion[name]);
        }
      }
    }

    const frameRate = opt.pal ? (1000000 / 19997) : Emu.FRAME_RATE_NTSC;
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * frameRate));
    const samplesPerFrame = sampleRate / frameRate;
    // regsOnly モードでは音声バッファ不要（巨大配列の確保・dcBlock をスキップ）
    const regsOnly = !!opt.regsOnly;
    const totalSamples = regsOnly ? 0 : Math.ceil(totalFrames * samplesPerFrame);

    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(totalFrames);
    const regSnapshots = new Array(totalFrames);
    const cpuSnapshots = new Array(totalFrames);
    const memSnapshots = new Array(totalFrames);
    const apuEnvSnapshots = new Array(totalFrames);
    // N163内部128byte RAMのフレームごとスナップショット。N163は$F800(アドレスラッチ)+$4800
    // (データ)の間接アドレッシングで、しかもドライバは位相バイトを「読み飛ばし」でスキップする
    // (読み出しもオートインクリメントを進める)。writeLogは書き込みしか記録しないため、
    // ログの再生だけではアドレスポインタがズレて内部RAMを正しく復元できない。ライブチップの
    // RAMを直接採取して nsf2mml抽出/ピアノロールへ渡す(この不一致がN163変換崩れの根因)。
    const n163Snapshots = new Array(totalFrames);

    let pendingWrites = [];
    player.bus.onWrite = (addr, value) => pendingWrites.push({ addr, value });

    // INIT後・PLAY前の初期レジスタ状態をスナップショット
    const initRegs = Object.assign({}, runningRegs);

    return { player, sampleRate, frameRate, totalFrames, samplesPerFrame, totalSamples,
             raw, writeLog, regSnapshots, cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, initRegs, initWrites,
             pendingWritesRef: { get current() { return pendingWrites; }, set(v) { pendingWrites = v; player.bus.onWrite = (a, val) => pendingWrites.push({ addr: a, value: val }); } } };
  }

  /**
   * APU矩形波1/2・ノイズの「実際に出力中の音量レベル」を取得する。
   * ハードウェアエンベロープ(減衰)使用時、レジスタの下位4bitは音量ではなく減衰速度なので、
   * 内部の decay 値(0-15)を読む必要がある。env=true なら減衰モード。
   * envelope.output() は constant時=設定音量 / 減衰時=現在のdecay値 を返す。
   */
  // DPCMサンプルのデルタ復号キャッシュ（(addr,len)が変わった時だけ再復号）
  let _dmcCache = { key: '' };
  function _dmcSample(bus, addr, len) {
    if (!bus || !len) return null;
    const key = addr + ':' + len;
    if (_dmcCache.key !== key) {
      const n = len * 8;
      const samples = new Float32Array(n);
      let level = 64; // 7bit DAC の中央から delta(+2/-2, 0..127クランプ) で再構成
      let k = 0;
      for (let b = 0; b < len; b++) {
        const byte = bus.read((addr + b) & 0xFFFF) & 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          if (byte & (1 << bit)) { if (level <= 125) level += 2; }
          else { if (level >= 2) level -= 2; }
          samples[k++] = (level - 64) / 64; // -1..1
        }
      }
      _dmcCache = { key, addr, len, samples };
    }
    return { addr, len, samples: _dmcCache.samples };
  }

  Emu.snapshotApuEnv = function (apu, fds, bus) {
    // level/env=音量エンベロープの実出力。len/period/mutedは「レジスタ値だけでは分からない
    // 実状態」で、長さカウンタによる自然消音・スイープユニットが書き換えた実周期・スイープ
    // 強制ミュートを鍵盤/ピアノロールの発音判定と音程表示に使う(nsf2mml/converter.jsの
    // extractPulseEvents/extractNoiseEventsが行うシミュレーションと同じ情報)。
    const rd = (ch) => ({ level: ch.envelope.output(), env: !ch.envelope.constant,
      len: ch.lengthCounter, period: ch.timerPeriod,
      muted: typeof ch.isMuted === 'function' ? ch.isMuted() : false });
    const out = { pulse1: rd(apu.pulse1), pulse2: rd(apu.pulse2), noise: rd(apu.noise) };
    // 三角波は音量レジスタが無く、長さカウンタ+線形カウンタだけで発音が止まる
    if (apu.triangle) out.triangle = { len: apu.triangle.lengthCounter, linear: apu.triangle.linearCounter };
    // FDS $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を採取。
    // effectiveFreq: モジュレーション適用後の実ピッチ(内部単位)。鍵盤表示でMH<n>使用中の
    // 実際に揺れているピッチをHz換算する用途(生の$4082/4083周期だけでは変調前の値になる)。
    // modEnabled: モジュレーションユニットの実際の有効状態。$4087が一度も書かれていない
    // (曲がMH<n>を全く使わない)場合、生レジスタは既定値0のままでbit7=0=有効に見えて
    // しまう(実際は一度も有効化されていないのに鍵盤表示が常時ON扱いになるバグの原因)。
    // fds.modEnabled(インスタンスの実状態、既定false)を使えばこの誤検出を避けられる。
    if (fds) out.fds = { gain: fds.volGain, env: !!fds.volEnvEnabled, effectiveFreq: fds.effectiveFreq, modEnabled: !!fds.modEnabled };
    // DPCM: 実出力レベル(outputLevel 0-127)と、メモリ上のサンプルをデルタ復号した波形
    if (apu.dmc) {
      // playing: 実際にサンプルを読み進めている最中か($4015 bit4 の書込み値ではなく実状態。
      // 鍵盤/ロールの発声判定用。鳴り終わると bytesRemaining=0 かつ shiftReg を出し切る)
      const dmc = { level: apu.dmc.outputLevel, seq: apu.dmc.seq || 0,
                    playing: apu.dmc.bytesRemaining > 0 || (apu.dmc.bitsRemaining > 0 && !apu.dmc.silence) };
      if (bus) {
        const s = _dmcSample(bus, apu.dmc.sampleAddr, apu.dmc.sampleLength);
        if (s) { dmc.addr = s.addr; dmc.len = s.len; dmc.samples = s.samples; }
      }
      out.dmc = dmc;
    }
    return out;
  };

  /** 1フレーム分を処理してバッファ・ログを更新する。posを返す。 */
  function _processFrame(ctx, f, pos) {
    const { player, sampleRate, totalSamples, raw, writeLog, regSnapshots,
            cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, pendingWritesRef } = ctx;
    pendingWritesRef.set([]);
    const frame = player.renderFrame(sampleRate);
    writeLog[f] = pendingWritesRef.current;
    for (const w of pendingWritesRef.current) runningRegs[w.addr] = w.value;
    // 書き込みが1件も無かったフレームは前フレームとスナップショットが同一なので、
    // オブジェクトを共有してアロケーション(=GC圧)を減らす。消費側(ピアノロール/
    // モニタ/nsf2mml)はいずれも読み取り専用アクセスのため共有しても安全。
    regSnapshots[f] = (f > 0 && pendingWritesRef.current.length === 0)
      ? regSnapshots[f - 1] : Object.assign({}, runningRegs);
    const n163 = player.bus.expansion && player.bus.expansion.n163;
    if (n163) n163Snapshots[f] = n163.ram.slice();
    cpuSnapshots[f] = {
      A: player.cpu.A, X: player.cpu.X, Y: player.cpu.Y,
      P: player.cpu.P, S: player.cpu.S, PC: player.cpu.PC
    };
    memSnapshots[f] = player.bus.mem.slice(0, 0x100);
    apuEnvSnapshots[f] = Emu.snapshotApuEnv(player.apu, player.bus.expansion && player.bus.expansion.fds, player.bus);
    for (let i = 0; i < frame.length && pos < totalSamples; i++, pos++) {
      raw[pos] = frame[i];
    }
    return pos;
  }

  function _buildResult(ctx) {
    return {
      audio: ctx.raw.length > 0 ? Emu.dcBlock(ctx.raw) : ctx.raw,
      sampleRate: ctx.sampleRate,
      totalFrames: ctx.totalFrames,
      samplesPerFrame: ctx.samplesPerFrame,
      writeLog: ctx.writeLog,
      regSnapshots: ctx.regSnapshots,
      cpuSnapshots: ctx.cpuSnapshots,
      memSnapshots: ctx.memSnapshots,
      apuEnvSnapshots: ctx.apuEnvSnapshots,
      n163Snapshots: ctx.n163Snapshots,
      initRegs: ctx.initRegs,
      initWrites: ctx.initWrites
    };
  }

  /**
   * 楽曲を一括キャプチャする（同期版・後方互換）
   * @param {Uint8Array} nsfBytes - 完全なNSFバイナリ（128バイトヘッダ含む）
   * @param {object} opt
   * @param {number} [opt.songIndex=0]
   * @param {number} [opt.durationSeconds=10]
   * @param {number} [opt.sampleRate=44100]
   * @param {boolean} [opt.pal=false]
   */
  Emu.captureSong = function (nsfBytes, opt = {}) {
    const ctx = _setupCapture(nsfBytes, opt);
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      pos = _processFrame(ctx, f, pos);
    }
    return _buildResult(ctx);
  };

  /**
   * 楽曲を非同期でキャプチャする（UI をブロックしない）
   * CHUNK_FRAMES フレームごとにブラウザへ制御を返すため、長尺でも UI がフリーズしない。
   * regsOnly時はチャンクを細かくし(ピアノロールの先読み用途で使われ、実再生と
   * メインスレッドを共有するため)、onProgressにはその時点までのregSnapshots/writeLog
   * (末尾は未確定=空のまま伸びていく同一配列参照)も渡すので、キャプチャ完了を待たずに
   * 途中経過だけでピアノロールを段階的に埋めていける。
   * @param {Uint8Array} nsfBytes
   * @param {object} opt - captureSong と同じオプション
   * @param {function(done:number, total:number, regSnapshots:Array, writeLog:Array, n163Snapshots:Array):void} [onProgress] - 進捗コールバック
   * @returns {Promise<object>} captureSong と同じ戻り値
   */
  Emu.captureSongAsync = async function (nsfBytes, opt = {}, onProgress = null) {
    const ctx = _setupCapture(nsfBytes, opt);
    const regsOnly = !!opt.regsOnly;
    // ★2026-08-20 スライス制御を「フレーム数固定(CHUNK_FRAMES)」から「時間予算固定」へ変更。
    // 端末の速度差(同じフレーム数でも掛かる時間はバラバラ)を自動吸収し、メインスレッド
    // 実行時は1スライスあたり最大~sliceBudgetMsしかブロックしない。Worker実行時
    // (src/audio/capture-worker-client.js経由)はUIをブロックしないため、呼び出し側が
    // 大きい予算とsetTimeoutより高速なyield(opt.yieldFn、4msクランプ回避)を渡して
    // スループット優先にできる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();
    let pos = 0;
    // regsOnly専用: 1フレーム=CPUサイクルCYCLES_PER_FRAME分、というサイクル駆動で
    // PLAYを刻む(NsfPlayer.renderFrame()と全く同じサイクル会計方式・クロック呼び出し)。
    // 省略するのはaudio.mixSample()と出力バッファへの書き込みだけ(regsOnlyの目的である
    // 「音声波形は要らない」を満たすのに必要十分)。
    // ★当初はapu.clock()/expansion.clock()自体も丸ごと省略していたが、これは誤りだった。
    // FDSの$4090(エンベロープ実測値読み出し)のように、ドライバがチップの内部状態を
    // 読み戻して「エンベロープが既定値まで減衰したら次の命令へ分岐する」種類の楽器
    // マクロを使う曲(Ai Senshi Nicol(FDS)等)では、clock()を呼ばないとエンベロープが
    // 初期値のまま一切減衰しないため、この分岐条件が実際のプレイとは異なる結果になり
    // (常に「まだ減衰していない」ため)、本来発生するはずの命令分岐先の書き込みが
    // 丸ごとwriteLogから欠落する不具合があった。clock()自体はmixSample()に比べて
    // 十分軽い(波形合成をしないだけ)ため、追加しても速度上のメリットはほぼ失われない。
    // cpuDebtは端数サイクルを次のフレームへ確実に持ち越す必要があるため、
    // renderFrame()と同じく「+=」で加算する(「=」で上書きすると端数が失われる)。
    const CYCLES_PER_FRAME = Emu.CPU_CLOCK_NTSC / Emu.FRAME_RATE_NTSC;
    let regsOnlyCycleAccum = 0;
    let regsOnlyCpuDebt = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      if (regsOnly) {
        // CPU実行 + チップのクロック(エンベロープ等の内部状態更新)のみ。
        // 音声波形合成(mixSample())と出力バッファ書き込みだけを省略する。
        ctx.pendingWritesRef.set([]);
        if (!ctx.player.cpu.callActive) ctx.player.cpu.beginCall(ctx.player.header.playAddr);
        const regsOnlyExpansion = Object.values(ctx.player.bus.expansion);
        regsOnlyCycleAccum += CYCLES_PER_FRAME;
        while (regsOnlyCycleAccum >= 1) {
          if (regsOnlyCpuDebt <= 0) {
            if (ctx.player.cpu.callActive) regsOnlyCpuDebt += ctx.player.cpu.stepCall();
            else regsOnlyCpuDebt = 1;
          }
          regsOnlyCpuDebt--;
          ctx.player.apu.clock();
          for (let e = 0; e < regsOnlyExpansion.length; e++) regsOnlyExpansion[e].clock();
          regsOnlyCycleAccum -= 1;
        }
        ctx.writeLog[f] = ctx.pendingWritesRef.current;
        for (const w of ctx.pendingWritesRef.current) ctx.runningRegs[w.addr] = w.value;
        // 書き込み無しフレームは前フレームとスナップショット同一なのでオブジェクトを共有
        // (_processFrame側の同名コメント参照)
        ctx.regSnapshots[f] = (f > 0 && ctx.pendingWritesRef.current.length === 0)
          ? ctx.regSnapshots[f - 1] : Object.assign({}, ctx.runningRegs);
        const n163 = ctx.player.bus.expansion && ctx.player.bus.expansion.n163;
        if (n163) ctx.n163Snapshots[f] = n163.ram.slice();
      } else {
        pos = _processFrame(ctx, f, pos);
      }
      // f===0でも必ず一度onProgressを発火する(最初のonProgressで実再生のplayer.load()が
      // 走るため、時間予算いっぱいまで溜めると再生開始が遅れる)。以降は時間予算を
      // 超えたときだけスライス境界にする。
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        // initRegs/initWritesは末尾に追加(既存呼び出し元は無視するだけで後方互換)。
        // NSF実再生をこのwriteLogから直接合成する新エンジン(NsfReplayStreamPlayer)が
        // INIT時点の初期状態を再生開始前に必要とするため、完了(Promise解決)を待たずに
        // 最初のonProgressの時点で渡せるようにした。
        if (onProgress) onProgress(f + 1, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
        await yieldFn();
        sliceStart = performance.now();
        // 呼び出し元が「もう不要」と判断したら(曲切替/停止の連打で先読みが積み上がるのを防ぐ)
        // ここで即座に打ち切る。onProgress側だけをトークンで無視する方式だと、キャプチャ
        // ループ自体(重いCPUエミュレーション)は最後まで回り続けてしまい、連打するたびに
        // 積み重なって実再生と競合しUIが重くなる不具合があったため。
        if (opt.shouldCancel && opt.shouldCancel()) return _buildResult(ctx);
      }
    }
    if (onProgress) onProgress(ctx.totalFrames, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
    return _buildResult(ctx);
  };
})(window);
