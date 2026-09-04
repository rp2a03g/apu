/*
 * regsOnlyキャプチャのWorker実行クライアント
 *   MML.Emu.captureSongWorkerAsync     (NSF)
 *   MML.Emu.captureKssSongWorkerAsync  (KSS)
 *   MML.Emu.captureGbsSongWorkerAsync  (GBS)
 *   MML.Emu.captureVgmSongWorkerAsync  (VGM)
 *
 * 各captureXxxSongAsyncと同一シグネチャ・同一のonProgress契約(進行中に育つ同一
 * 配列/オブジェクト参照を渡す)で、実際のエミュレーションだけをWeb Workerへ逃がす。
 * これによりメインスレッド(ScriptProcessorNodeのオーディオコールバック・
 * ピアノロールのrAF描画)とキャプチャがCPUを取り合ってカクつく問題を解消する。
 *
 * Workerが使えない/バンドルが無い・古い/起動に失敗した場合は、従来どおり
 * メインスレッドのcaptureXxxSongAsync(時間予算スライス版)へ自動フォールバック
 * するため、呼び出し側は関数を置き換えるだけでよい。
 *
 * バンドルの仕組み(file://直開き対応)は src/audio/README-worker-build.txt 参照。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ---- バンドル準備(Blob URL化)と鮮度チェック --------------------------------
  // バンドルはソース連結の生成物なので、メインスレッドに読み込まれている現行ソース
  // (各クラス/関数のtoString=ソース原文そのまま)がバンドル文字列に含まれているかで
  // 「再ビルド忘れ」を機械的に検出できる。古いバンドルのWorkerは現行エミュレータと
  // 異なる結果を吐き、「音が微妙に違う」という最悪の形で現れるため、古い場合は
  // Workerを使わない(正しさ優先)。probesは「Workerが実際に実行する」関数を選ぶこと。
  const _bundles = {}; // bundleKey -> { url: string|null }(null=使用不可で確定)

  function _prepareBundle(bundleKey, probes) {
    let b = _bundles[bundleKey];
    if (b) return b.url;
    b = _bundles[bundleKey] = { url: null };
    try {
      if (typeof Worker === 'undefined') return null;
      const fn = MML.WorkerBundles && MML.WorkerBundles[bundleKey];
      if (typeof fn !== 'function') {
        console.warn(`[capture-worker] バンドル ${bundleKey} が読み込まれていません。メインスレッドでキャプチャします`);
        return null;
      }
      const src = fn.toString();
      for (const p of probes) {
        if (typeof p !== 'function' || src.indexOf(p.toString()) < 0) {
          console.warn(`[capture-worker] バンドル ${bundleKey} がソースより古い(再ビルド忘れ)ため使用しません。` +
            'tools/build-capture-workers.ps1 で再ビルドしてください。メインスレッドでキャプチャします');
          return null;
        }
      }
      // toString結果は "function () { ...バンドル本体... }" なので括って即時実行形にする
      const blob = new Blob(['(', src, ')();'], { type: 'application/javascript' });
      b.url = URL.createObjectURL(blob);
    } catch (e) {
      console.warn('[capture-worker] Worker準備に失敗。メインスレッドでキャプチャします:', e);
      b.url = null;
    }
    return b.url;
  }

  function _markUnusable(bundleKey) {
    if (_bundles[bundleKey]) _bundles[bundleKey].url = null;
  }

  // optから構造化クローン可能な値だけを明示的に抜き出す(shouldCancel等の関数は不可)
  // ym2608RhythmRom: YM2608内蔵リズムROM(Uint8Array。WorkerにlocalStorageが無いためバイト列で渡す)
  const OPT_KEYS = ['songIndex', 'durationSeconds', 'sampleRate', 'pal', 'regsOnly', 'mute', 'track', 'ym2608RhythmRom'];
  function _cloneableOpt(opt) {
    const out = {};
    for (const k of OPT_KEYS) if (opt[k] !== undefined) out[k] = opt[k];
    return out;
  }

  // ---- ピアノロール構築の配信 ------------------------------------------------
  // opt.roll = {onRoll(timeline, info), frameRate?, samplesPerFrame?, sampleRate?,
  //             chips?, fineTune?, header?} を渡すと、タイムライン構築(1回あたり
  // O(done)の全走査。メインスレッドでは長タスク=カクつきの主因だった)をWorker内で
  // 行い、完成品だけをonRollへ届ける。Workerフォールバック時・Worker側のロール構築が
  // 失敗した時(rollError)は、同じ構築コード(MML.RollBuild)をメインスレッドで
  // スロットル付き実行して契約を維持する。
  function _cloneableRoll(roll) {
    if (!roll) return undefined;
    const out = {};
    for (const k of ['frameRate', 'samplesPerFrame', 'sampleRate', 'chips', 'fineTune', 'poolMode', 'drumKinds']) {
      if (roll[k] !== undefined) out[k] = roll[k];
    }
    return out;
  }

  // メインスレッド構築ドライバ(フォールバック/救済用)。(done, total, data)で呼ぶ。
  function _makeLocalRollDriver(format, roll) {
    if (!roll || typeof roll.onRoll !== 'function' || !MML.RollBuild) return null;
    let params;
    if (format === 'kss') params = { frameRate: roll.frameRate, header: roll.header };
    else if (format === 'spc') params = { frameRate: MML.SPC2MML.FRAME_RATE, fineTune: roll.fineTune || null, drumKinds: roll.drumKinds || null };
    else params = roll;
    const job = MML.RollBuild.createRollJob(format, params);
    if (!job) return null;
    const throttle = MML.RollBuild.makeThrottle();
    return (done, total, data) => {
      if (!throttle.shouldBuild(done, total)) return;
      const t0 = performance.now();
      try {
        const r = job.build(data, done, total);
        throttle.didBuild(t0);
        roll.onRoll(r.timeline, r.info || {});
      } catch (e) {
        console.warn(`[capture-worker] ロール構築に失敗(${format}):`, e);
      }
    };
  }

  // =========================================================================
  // NSF (nsf-capture-worker-impl.js の専用プロトコル)
  // =========================================================================
  // ロール構築系の共通プローブ(roll-builders.jsと、そこから呼ぶ依存の再ビルド忘れ検出)
  function _rollProbes() {
    const RB = MML.RollBuild || {};
    return [RB.createRollJob, RB.makeThrottle];
  }

  function _nsfProbes() {
    return [
      MML.NSF && MML.NSF.parseHeader,
      Emu.CPU6502, Emu.APU2A03, Emu.NsfBus, Emu.NsfPlayer,
      Emu.VRC6Audio, Emu.VRC7Audio, Emu.OPLLNuked, Emu.FDSAudio,
      Emu.MMC5Audio, Emu.N163Audio, Emu.FME7Audio,
      Emu.captureSongAsync,
      MML.UI && MML.UI.buildRollTracksFromRegSnapshots
    ].concat(_rollProbes());
  }

  /**
   * captureSongAsync と同一シグネチャ(regsOnly用途専用)。
   * 戻り値のresultオブジェクトも同じキー構成(ただしaudioは常に空、cpu/mem/apuEnv
   * スナップショットはregsOnlyでは元々未使用なので空配列)。
   */
  Emu.captureSongWorkerAsync = function (nsfBytes, opt = {}, onProgress = null) {
    // フォールバック時もロール配信契約(opt.roll.onRoll)を維持する(_runMultiCaptureと同じ)
    const runFallback = () => {
      const localRoll = _makeLocalRollDriver('nsf', opt.roll);
      if (!localRoll) return Emu.captureSongAsync(nsfBytes, opt, onProgress);
      return Emu.captureSongAsync(nsfBytes, opt, (done, total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites) => {
        if (onProgress) onProgress(done, total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites);
        localRoll(done, total, { regSnapshots, writeLog, n163Snapshots });
      });
    };
    const url = opt.regsOnly ? _prepareBundle('nsfCapture', _nsfProbes()) : null;
    if (!url) return opt.regsOnly ? runFallback() : Emu.captureSongAsync(nsfBytes, opt, onProgress);

    return new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        // CSP(worker-src)等で起動自体が拒否された環境。以後も無理なので判定を固定する
        console.warn('[capture-worker] Worker起動失敗。メインスレッドへフォールバック:', e);
        _markUnusable('nsfCapture');
        resolve(runFallback());
        return;
      }

      // メインスレッド側の「進行中に育つ配列」。既存のonProgress契約(同一配列参照が
      // キャプチャの進行につれ埋まっていき、プレイヤー/ロールはその参照を保持する)を
      // 維持するため、Workerからの差分チャンクをここへ詰めてから通知する。
      let writeLog = null, regSnapshots = null, n163Snapshots = null;
      let initRegs = {}, initWrites = [];
      let totalFrames = 0;
      let settled = false;
      let sawProgress = false;
      let rescueRoll = null; // Worker内ロール構築失敗時の救済(_runMultiCaptureと同じ)

      const buildResult = () => ({
        audio: new Float32Array(0),
        sampleRate: opt.sampleRate || 44100,
        totalFrames,
        samplesPerFrame: (opt.sampleRate || 44100) / Emu.FRAME_RATE_NTSC,
        writeLog: writeLog || [],
        regSnapshots: regSnapshots || [],
        cpuSnapshots: [],
        memSnapshots: [],
        apuEnvSnapshots: [],
        n163Snapshots: n163Snapshots || [],
        initRegs,
        initWrites
      });

      const finish = () => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        resolve(buildResult());
      };

      const failover = (message) => {
        if (settled) return;
        if (!sawProgress) {
          // 1フレームも進む前の失敗(バンドル不整合など)は丸ごとやり直せる
          console.warn('[capture-worker] Workerエラー。メインスレッドへフォールバック:', message);
          settled = true;
          try { worker.terminate(); } catch (e) { /* ignore */ }
          resolve(runFallback());
        } else {
          // 途中失敗: プレイヤーは既にこちらの配列参照を掴んでいるため、別配列で
          // 走り直すフォールバックは再生と食い違う。取得済み範囲で打ち切る
          console.warn('[capture-worker] Workerが途中で失敗。取得済み範囲で打ち切ります:', message);
          finish();
        }
      };

      worker.onmessage = (e) => {
        if (settled) return;
        const m = e.data || {};
        if (m.type === 'progress') {
          sawProgress = true;
          totalFrames = m.total;
          if (!writeLog) {
            writeLog = new Array(m.total);
            regSnapshots = new Array(m.total);
            n163Snapshots = new Array(m.total);
          }
          if (m.initRegs) initRegs = m.initRegs;
          if (m.initWrites) initWrites = m.initWrites;
          for (let i = 0; i < m.writeLog.length; i++) {
            writeLog[m.start + i] = m.writeLog[i];
            regSnapshots[m.start + i] = m.regSnapshots[i];
            if (m.n163Snapshots[i] !== undefined) n163Snapshots[m.start + i] = m.n163Snapshots[i];
          }
          // キャンセル判定は既存API同様スライス境界で行う(曲切替/停止の連打対策。
          // terminate()なのでWorker側のエミュレーションも即座に止まる)
          if (opt.shouldCancel && opt.shouldCancel()) { finish(); return; }
          if (onProgress) onProgress(m.done, m.total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites);
          if (rescueRoll) rescueRoll(m.done, m.total, { regSnapshots, writeLog, n163Snapshots });
        } else if (m.type === 'roll') {
          if (opt.roll && typeof opt.roll.onRoll === 'function' && !rescueRoll) {
            if (opt.shouldCancel && opt.shouldCancel()) { finish(); return; }
            opt.roll.onRoll(m.timeline, m.info || {});
          }
        } else if (m.type === 'rollError') {
          console.warn('[capture-worker] Worker内ロール構築が失敗(nsf)。メインスレッド構築へ切替:', m.message);
          rescueRoll = _makeLocalRollDriver('nsf', opt.roll);
        } else if (m.type === 'done') {
          finish();
        } else if (m.type === 'error') {
          failover(m.message);
        }
      };
      worker.onerror = (e) => failover(e.message || e);

      worker.postMessage({ cmd: 'capture', nsfBytes,
        opt: Object.assign(_cloneableOpt(opt), { regsOnly: true, roll: _cloneableRoll(opt.roll) }) });
    });
  };

  // =========================================================================
  // KSS / GBS / VGM (capture-worker-multi-impl.js の汎用プロトコル)
  // =========================================================================
  // Workerはペイロード(onProgressが渡す構造)内の配列を差分送信してくる。こちらでは
  // 安定した「鏡像」オブジェクトを育て、呼び出し元へは既存APIと同じ引数形状で渡す。

  function _applyMeta(mirror, meta) {
    for (const key of Object.keys(meta)) {
      const v = meta[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && key !== 'header') {
        mirror[key] = Object.assign(mirror[key] || {}, v); // ファミリ: 既存の配列プロパティは保持
      } else {
        mirror[key] = v; // スカラ / null / header / 型付き配列
      }
    }
  }

  function _applyArrays(mirror, arrays) {
    for (const path of Object.keys(arrays)) {
      const items = arrays[path];
      const dot = path.indexOf('.');
      let container = mirror, prop = path;
      if (dot >= 0) {
        const k = path.slice(0, dot);
        prop = path.slice(dot + 1);
        container = mirror[k] = mirror[k] || {};
      }
      const arr = container[prop] = container[prop] || [];
      for (let i = 0; i < items.length; i++) arr.push(items[i]);
    }
  }

  /**
   * 汎用ランナー。
   * @param {string} format - Worker側FORMATSのキー('kss'|'gbs'|'vgm'|'hes')
   * @param {string} bundleKey - MML.WorkerBundlesのプロパティ名
   * @param {function():Array} probesFn - 鮮度チェック対象(遅延評価)
   * @param {function} fallbackFn - メインスレッド版captureXxxSongAsync
   * @param {object} seedMirror - 鏡像の初期形状(既存APIが初回から期待する配列など)
   * @param {function(mirror):Array} progressArgs - onProgressへ渡す第3引数以降を作る
   * @param {function(mirror):object} resultOf - resolve値を作る
   * @param {function(...rest):object} fallbackRollData - フォールバック時、onProgressの
   *        第3引数以降からロールジョブ用のdata形状を作る(kss: writeLog→{writeLog}等)
   */
  function _runMultiCapture(format, bundleKey, probesFn, fallbackFn, bytes, opt, onProgress,
                            seedMirror, progressArgs, resultOf, fallbackRollData) {
    // フォールバック(メインスレッドキャプチャ)時は、ロール構築も同じコードを
    // メインスレッドでスロットル付き実行して配信契約を維持する
    const runFallback = () => {
      const localRoll = fallbackRollData ? _makeLocalRollDriver(format, opt.roll) : null;
      if (!localRoll) return fallbackFn(bytes, opt, onProgress);
      return fallbackFn(bytes, opt, (done, total, ...rest) => {
        if (onProgress) onProgress(done, total, ...rest);
        localRoll(done, total, fallbackRollData(...rest));
      });
    };

    const url = _prepareBundle(bundleKey, probesFn());
    if (!url) return runFallback();

    return new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        console.warn('[capture-worker] Worker起動失敗。メインスレッドへフォールバック:', e);
        _markUnusable(bundleKey);
        resolve(runFallback());
        return;
      }

      const mirror = seedMirror;
      let settled = false;
      let sawProgress = false;
      // Worker側のロール構築が失敗した(rollError)場合の救済: 鏡像データから
      // メインスレッドで構築を続ける(鏡像はジョブのdata形状と同じ)
      let rescueRoll = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        resolve(resultOf(mirror));
      };

      const failover = (message) => {
        if (settled) return;
        if (!sawProgress) {
          console.warn(`[capture-worker] Workerエラー(${format})。メインスレッドへフォールバック:`, message);
          settled = true;
          try { worker.terminate(); } catch (e) { /* ignore */ }
          resolve(runFallback());
        } else {
          console.warn(`[capture-worker] Workerが途中で失敗(${format})。取得済み範囲で打ち切ります:`, message);
          finish();
        }
      };

      worker.onmessage = (e) => {
        if (settled) return;
        const m = e.data || {};
        if (m.type === 'progress') {
          sawProgress = true;
          if (m.meta) _applyMeta(mirror, m.meta);
          _applyArrays(mirror, m.arrays);
          if (opt.shouldCancel && opt.shouldCancel()) { finish(); return; }
          if (onProgress) onProgress(m.done, m.total, ...progressArgs(mirror));
          if (rescueRoll) rescueRoll(m.done, m.total, mirror);
        } else if (m.type === 'roll') {
          if (opt.roll && typeof opt.roll.onRoll === 'function' && !rescueRoll) {
            if (opt.shouldCancel && opt.shouldCancel()) { finish(); return; }
            opt.roll.onRoll(m.timeline, m.info || {});
          }
        } else if (m.type === 'rollError') {
          console.warn(`[capture-worker] Worker内ロール構築が失敗(${format})。メインスレッド構築へ切替:`, m.message);
          rescueRoll = _makeLocalRollDriver(format, opt.roll);
        } else if (m.type === 'done') {
          if (m.finalMeta) _applyMeta(mirror, m.finalMeta); // 完了後に追加されたVGMのdpcmRom等
          finish();
        } else if (m.type === 'error') {
          failover(m.message);
        }
      };
      worker.onerror = (e) => failover(e.message || e);

      worker.postMessage({ cmd: 'capture', format, bytes,
        opt: Object.assign(_cloneableOpt(opt), { roll: _cloneableRoll(opt.roll) }) });
    });
  }

  /** captureKssSongAsync と同一シグネチャ(regsOnly用途専用) */
  Emu.captureKssSongWorkerAsync = function (kssBytes, opt = {}, onProgress = null) {
    if (!opt.regsOnly) return Emu.captureKssSongAsync(kssBytes, opt, onProgress);
    return _runMultiCapture('kss', 'kssCapture',
      () => [MML.KSS && MML.KSS.parseHeader, Emu.CPUZ80, Emu.KssBus, Emu.KssPlayer,
             Emu.AY8910Audio, Emu.SCCAudio, Emu.OPLLAudio, Emu.OPLLNuked, Emu.OPLAudio, Emu.captureKssSongAsync,
             MML.RollBuild && MML.RollBuild.kss,
             MML.Kss2MmlExpansion && MML.Kss2MmlExpansion.ay,
             MML.Kss2MmlExpansion && MML.Kss2MmlExpansion.scc,
             MML.Kss2MmlExpansion && MML.Kss2MmlExpansion.opll,
             MML.Kss2MmlExpansion && MML.Kss2MmlExpansion.opl].concat(_rollProbes()),
      Emu.captureKssSongAsync, kssBytes, opt, onProgress,
      { writeLog: [] },
      (mirror) => [mirror.writeLog],
      (mirror) => ({ audio: new Float32Array(0), writeLog: mirror.writeLog, player: null, frameRate: null }),
      (writeLog) => ({ writeLog }));
  };

  /** captureGbsSongAsync と同一シグネチャ(regsOnly用途専用) */
  Emu.captureGbsSongWorkerAsync = function (gbsBytes, opt = {}, onProgress = null) {
    if (!opt.regsOnly) return Emu.captureGbsSongAsync(gbsBytes, opt, onProgress);
    return _runMultiCapture('gbs', 'gbsCapture',
      () => [MML.GBS && MML.GBS.parseHeader, Emu.CPUSm83, Emu.GbsBus, Emu.APUGb,
             Emu.GbsPlayer, Emu.snapshotGbApuForCapture, Emu.captureGbsSongAsync,
             MML.RollBuild && MML.RollBuild.gbs,
             MML.Gbs2MmlExpansion && MML.Gbs2MmlExpansion.pulse,
             MML.Gbs2MmlExpansion && MML.Gbs2MmlExpansion.noise,
             MML.Gbs2MmlExpansion && MML.Gbs2MmlExpansion.wave].concat(_rollProbes()),
      Emu.captureGbsSongAsync, gbsBytes, opt, onProgress,
      { writeLog: [], snapshots: [] },
      (mirror) => [mirror],
      (mirror) => ({ audio: new Float32Array(0), writeLog: mirror.writeLog,
                     snapshots: mirror.snapshots, player: null, frameRate: null }),
      (data) => data);
  };

  /** captureVgmSongAsync と同一シグネチャ */
  Emu.captureVgmSongWorkerAsync = function (vgmBytes, opt = {}, onProgress = null) {
    return _runMultiCapture('vgm', 'vgmCapture',
      () => [MML.VGM && MML.VGM.parseHeader, Emu.VgmPlayer, Emu.captureVgmSongAsync,
             Emu.APU2A03, Emu.FDSAudio, Emu.APUGb, Emu.APUHuC6280,
             Emu.AY8910Audio, Emu.SCCAudio, Emu.OPLLAudio, Emu.OPLLNuked, Emu.SN76489Audio,
             Emu.YM2612Nuked, Emu.YM2610Audio, Emu.YM2151Audio, Emu.YM2203Audio, Emu.YM2608Audio, Emu.OPLAudio,
             MML.Kss2MmlExpansion && MML.Kss2MmlExpansion.opl,
             Emu.GA20Audio, Emu.SegaPCMAudio, Emu.C140Audio, Emu.C352Audio, Emu.OKIM6258Audio, Emu.QSoundAudio, Emu.OKIM6295Audio, Emu.MultiPCMAudio, Emu.PWM32XAudio, Emu.RF5C164Audio,
             Emu.snapshotGbApuForCapture, Emu.snapshotHesApuForCapture,
             MML.RollBuild && MML.RollBuild.vgm,
             MML.UI && MML.UI.buildRollTracksFromRegSnapshots,
             MML.Kss2MmlExpansion && MML.Kss2MmlExpansion.ay,
             MML.Gbs2MmlExpansion && MML.Gbs2MmlExpansion.pulse,
             MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.wave].concat(_rollProbes()),
      Emu.captureVgmSongAsync, vgmBytes, opt, onProgress,
      {},
      (mirror) => [mirror],
      (mirror) => mirror,
      (data) => data);
  };

  // =========================================================================
  // HES (capture-worker-multi-impl.js のHES専用差分プロトコル)
  // =========================================================================
  // captureHesSongAsync と同一シグネチャ(regsOnly用途専用: perChannelAudio等の
  // 音声レンダリング用途は呼び出し側の事前確保配列へ直接書き込む参照共有契約のため
  // Worker化せず、メインスレッド版へそのまま流す)。dpcmTrace/controlTraceは
  // 「外側固定長6・中身が伸びる」二重配列なので、ch別に差分を受けて追記する。
  Emu.captureHesSongWorkerAsync = function (hesBytes, opt = {}, onProgress = null) {
    if (!opt.regsOnly || opt.perChannelAudio) return Emu.captureHesSongAsync(hesBytes, opt, onProgress);
    const probes = () => [
      MML.HES && MML.HES.parseHeader, Emu.CPUHuC6280, Emu.HesBus, Emu.APUHuC6280,
      Emu.HesPlayer, Emu.snapshotHesApuForCapture, Emu.captureHesSongAsync,
      MML.RollBuild && MML.RollBuild.hes,
      MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.wave,
      MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.noiseChannel,
      MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.extractDdaClips
    ].concat(_rollProbes());
    const runFallback = () => {
      const localRoll = _makeLocalRollDriver('hes', opt.roll);
      if (!localRoll) return Emu.captureHesSongAsync(hesBytes, opt, onProgress);
      return Emu.captureHesSongAsync(hesBytes, opt, (done, total, data) => {
        if (onProgress) onProgress(done, total, data);
        localRoll(done, total, data);
      });
    };
    const url = _prepareBundle('hesCapture', probes());
    if (!url) return runFallback();

    return new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        console.warn('[capture-worker] Worker起動失敗。メインスレッドへフォールバック:', e);
        _markUnusable('hesCapture');
        resolve(runFallback());
        return;
      }

      // 進行中に育つ鏡像(既存onProgress契約と同形状)
      const mirror = {
        snapshots: [],
        dpcmTrace: [[], [], [], [], [], []],
        controlTrace: [[], [], [], [], [], []],
        samplesReady: 0,
        frameRate: undefined
      };
      let settled = false;
      let sawProgress = false;
      let rescueRoll = null; // Worker内ロール構築失敗時の救済(_runMultiCaptureと同じ)

      const finish = () => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        resolve({ audio: new Float32Array(0), channelAudio: null,
                  snapshots: mirror.snapshots, dpcmTrace: mirror.dpcmTrace,
                  controlTrace: mirror.controlTrace, player: null, frameRate: mirror.frameRate });
      };

      const failover = (message) => {
        if (settled) return;
        if (!sawProgress) {
          console.warn('[capture-worker] Workerエラー(hes)。メインスレッドへフォールバック:', message);
          settled = true;
          try { worker.terminate(); } catch (e) { /* ignore */ }
          resolve(runFallback());
        } else {
          console.warn('[capture-worker] Workerが途中で失敗(hes)。取得済み範囲で打ち切ります:', message);
          finish();
        }
      };

      worker.onmessage = (e) => {
        if (settled) return;
        const m = e.data || {};
        if (m.type === 'progress') {
          sawProgress = true;
          if (m.frameRate !== undefined) mirror.frameRate = m.frameRate;
          for (let i = 0; i < m.snapshots.length; i++) mirror.snapshots[m.snapStart + i] = m.snapshots[i];
          for (let c = 0; c < 6; c++) {
            for (let i = 0; i < m.dpcmTrace[c].length; i++) mirror.dpcmTrace[c].push(m.dpcmTrace[c][i]);
            for (let i = 0; i < m.controlTrace[c].length; i++) mirror.controlTrace[c].push(m.controlTrace[c][i]);
          }
          if (opt.shouldCancel && opt.shouldCancel()) { finish(); return; }
          if (onProgress) onProgress(m.done, m.total, mirror);
          if (rescueRoll) rescueRoll(m.done, m.total, mirror);
        } else if (m.type === 'roll') {
          if (opt.roll && typeof opt.roll.onRoll === 'function' && !rescueRoll) {
            if (opt.shouldCancel && opt.shouldCancel()) { finish(); return; }
            opt.roll.onRoll(m.timeline, m.info || {});
          }
        } else if (m.type === 'rollError') {
          console.warn('[capture-worker] Worker内ロール構築が失敗(hes)。メインスレッド構築へ切替:', m.message);
          rescueRoll = _makeLocalRollDriver('hes', opt.roll);
        } else if (m.type === 'done') {
          finish();
        } else if (m.type === 'error') {
          failover(m.message);
        }
      };
      worker.onerror = (e) => failover(e.message || e);

      worker.postMessage({ cmd: 'capture', format: 'hes', bytes: hesBytes,
        opt: Object.assign(_cloneableOpt(opt), { roll: _cloneableRoll(opt.roll) }) });
    });
  };

  // =========================================================================
  // SPC (capture-worker-multi-impl.js の done基準差分プロトコル)
  // =========================================================================
  // MML.SPC2MML.captureAsync と同一シグネチャ。frameLogは本家と同じく全フレーム分を
  // 空配列で事前確保し(SpcReplayStreamPlayerが未キャプチャ添字を空配列として読む
  // 前提のため)、Workerから届いた完成フレームで順次上書きする。
  // 戻り値のbrrSamplesは空({}): 再生+ロール経路はframeLogしか使わず、brrSamplesが
  // 必要なspc2mml変換は従来どおり同期版MML.SPC2MML.capture()を直接使うため。
  Emu.captureSpcSongWorkerAsync = function (spcBytes, durationSec, onProgress, shouldCancel, roll) {
    const probes = () => [
      MML.SPC && MML.SPC.parseHeader, MML.SPC && MML.SPC.getDspRegs,
      Emu.SPC700, Emu.SpcDsp, Emu.SpcPlayer,
      MML.SPC2MML && MML.SPC2MML.captureAsync,
      MML.SPC2MML && MML.SPC2MML.extractVoiceEvents,
      MML.RollBuild && MML.RollBuild.spc
    ].concat(_rollProbes());
    const runFallback = () => {
      const localRoll = _makeLocalRollDriver('spc', roll);
      if (!localRoll) return MML.SPC2MML.captureAsync(spcBytes, durationSec, onProgress, shouldCancel);
      return MML.SPC2MML.captureAsync(spcBytes, durationSec, (frame, frames, frameLog) => {
        if (onProgress) onProgress(frame, frames, frameLog);
        localRoll(frame, frames, { frameLog });
      }, shouldCancel);
    };
    const url = _prepareBundle('spcCapture', probes());
    if (!url) return runFallback();

    return new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        console.warn('[capture-worker] Worker起動失敗。メインスレッドへフォールバック:', e);
        _markUnusable('spcCapture');
        resolve(runFallback());
        return;
      }

      let log = null;
      let settled = false;
      let sawProgress = false;
      let rescueRoll = null; // Worker内ロール構築失敗時の救済(_runMultiCaptureと同じ)

      const finish = () => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        resolve({ log: log || [], brrSamples: {}, frameRate: MML.SPC2MML.FRAME_RATE });
      };

      const failover = (message) => {
        if (settled) return;
        if (!sawProgress) {
          console.warn('[capture-worker] Workerエラー(spc)。メインスレッドへフォールバック:', message);
          settled = true;
          try { worker.terminate(); } catch (e) { /* ignore */ }
          resolve(runFallback());
        } else {
          console.warn('[capture-worker] Workerが途中で失敗(spc)。取得済み範囲で打ち切ります:', message);
          finish();
        }
      };

      worker.onmessage = (e) => {
        if (settled) return;
        const m = e.data || {};
        if (m.type === 'progress') {
          sawProgress = true;
          if (!log) log = Array.from({ length: m.total }, () => []);
          for (let i = 0; i < m.frames.length; i++) log[m.start + i] = m.frames[i];
          if (shouldCancel && shouldCancel()) { finish(); return; }
          if (onProgress) onProgress(m.done, m.total, log);
          if (rescueRoll) rescueRoll(m.done, m.total, { frameLog: log });
        } else if (m.type === 'roll') {
          if (roll && typeof roll.onRoll === 'function' && !rescueRoll) {
            if (shouldCancel && shouldCancel()) { finish(); return; }
            roll.onRoll(m.timeline, m.info || {});
          }
        } else if (m.type === 'rollError') {
          console.warn('[capture-worker] Worker内ロール構築が失敗(spc)。メインスレッド構築へ切替:', m.message);
          rescueRoll = _makeLocalRollDriver('spc', roll);
        } else if (m.type === 'done') {
          finish();
        } else if (m.type === 'error') {
          failover(m.message);
        }
      };
      worker.onerror = (e) => failover(e.message || e);

      worker.postMessage({ cmd: 'capture', format: 'spc', bytes: spcBytes,
        opt: { durationSeconds: durationSec, roll: _cloneableRoll(roll) } });
    });
  };
})(window);
