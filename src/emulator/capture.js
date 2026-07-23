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
    player.bus.onWrite = (a, val) => { runningRegs[a] = val; initWrites.push({ addr: a, value: val }); };
    player.initSong(songIndex, !!opt.pal);
    player.bus.onWrite = null;

    // initSong は bus.write を経由せず APU.writeRegister を直接呼ぶため
    // $4015 (チャンネル有効化) が onWrite を通らず regSnapshots に記録されない。
    // NSF の INIT が $4015 を書かなかった場合は initSong のデフォルト値 $0F を補完する。
    if (runningRegs[0x4015] === undefined) {
      runningRegs[0x4015] = 0x0F;
    }

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
    const rd = (ch) => ({ level: ch.envelope.output(), env: !ch.envelope.constant });
    const out = { pulse1: rd(apu.pulse1), pulse2: rd(apu.pulse2), noise: rd(apu.noise) };
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
      const dmc = { level: apu.dmc.outputLevel };
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
    regSnapshots[f] = Object.assign({}, runningRegs);
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
    const CHUNK_FRAMES = regsOnly ? 10 : 60; // regsOnly(先読み用)はより細かくyieldする
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      if (regsOnly) {
        // 音声生成を省略し CPU 実行のみ（鍵盤表示用の高速キャプチャ）
        ctx.pendingWritesRef.set([]);
        ctx.player.cpu.call(ctx.player.header.playAddr);
        ctx.writeLog[f] = ctx.pendingWritesRef.current;
        for (const w of ctx.pendingWritesRef.current) ctx.runningRegs[w.addr] = w.value;
        ctx.regSnapshots[f] = Object.assign({}, ctx.runningRegs);
        const n163 = ctx.player.bus.expansion && ctx.player.bus.expansion.n163;
        if (n163) ctx.n163Snapshots[f] = n163.ram.slice();
      } else {
        pos = _processFrame(ctx, f, pos);
      }
      if ((f + 1) % CHUNK_FRAMES === 0) {
        if (onProgress) onProgress(f + 1, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots);
        await new Promise(r => setTimeout(r, 0));
        // 呼び出し元が「もう不要」と判断したら(曲切替/停止の連打で先読みが積み上がるのを防ぐ)
        // ここで即座に打ち切る。onProgress側だけをトークンで無視する方式だと、キャプチャ
        // ループ自体(重いCPUエミュレーション)は最後まで回り続けてしまい、連打するたびに
        // 積み重なって実再生と競合しUIが重くなる不具合があったため。
        if (opt.shouldCancel && opt.shouldCancel()) return _buildResult(ctx);
      }
    }
    if (onProgress) onProgress(ctx.totalFrames, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots);
    return _buildResult(ctx);
  };
})(window);
