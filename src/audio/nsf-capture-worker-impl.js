/*
 * NSF regsOnlyキャプチャ Worker本体
 *
 * このファイル単体ではメインスレッドに読み込まれない。README-worker-build.txt の
 * PowerShellスクリプトがエミュレータ一式と結合して src/audio/nsf-capture-worker.js
 * (メインスレッドでは「実行されない関数」として定義されるバンドル)を生成し、
 * src/audio/capture-worker-client.js が Function.prototype.toString + Blob URL で
 * Web Worker として起動する(fetch()不使用、file://直開きでも動作)。
 *
 * プロトコル(capture-worker-client.jsと対):
 *   受信 {cmd:'capture', nsfBytes, opt}  … キャプチャ開始(optはstructured clone可能な値のみ)
 *   受信 {cmd:'cancel'}                  … 次のスライス境界で打ち切り
 *   送信 {type:'progress', done, total, start, writeLog, regSnapshots, n163Snapshots,
 *         [initRegs, initWrites]}        … start..done-1フレーム分の差分(初回のみinit*付き)
 *   送信 {type:'done'} / {type:'error', message}
 *   送信 {type:'roll', done, total, timeline, info} … opt.roll={samplesPerFrame,
 *         sampleRate, chips}が渡された場合のみ。ピアノロールのタイムライン構築
 *         (O(done)の全走査、メインスレッドの長タスク=カクつきの主因だった)を
 *         Worker内で行い完成品だけを送る(src/audio/roll-builders.js参照)
 *   送信 {type:'rollError', message} … ロール構築失敗(以後この曲では送らない)
 */
(function (global) {
  const MML = global.MML;

  // WorkerにはsetTimeout(0)の4msクランプ回避手段としてMessageChannelによる
  // マクロタスクyieldを使う(スライスごとの待ち時間を実質ゼロにしつつ、
  // 'cancel'メッセージの受信機会は確保する)。
  function macroYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  let cancelled = false;

  global.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { cancelled = true; return; }
    if (msg.cmd !== 'capture') return;

    cancelled = false;
    const opt = Object.assign({}, msg.opt, {
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      // Worker内はUIをブロックしないのでスライスを大きめに取り、メッセージ数を抑える。
      // 30ms = cancel応答性とprogress粒度の上限でもある。
      // (NSFの受信は軽いので細かく区切らない。細かく区切るのはVGMだけ: capture-worker-multi-impl.js WORKER_SLICE_MS_VGM)
      sliceBudgetMs: 30
    });

    // ロール構築(opt.rollが無ければ無効。capture-worker-multi-impl.jsのmakeRollSenderと
    // 同じ考え方: スロットルの可視性チェックはWorker内では自動的に素通り=常時構築)
    let sendRoll = null;
    if (MML.RollBuild && msg.opt.roll) {
      const job = MML.RollBuild.createRollJob('nsf', msg.opt.roll);
      const throttle = MML.RollBuild.makeThrottle();
      let rollFailed = false;
      if (job) sendRoll = (data, done, total) => {
        if (rollFailed || !throttle.shouldBuild(done, total)) return;
        const t0 = performance.now();
        try {
          const r = job.build(data, done, total);
          throttle.didBuild(t0);
          global.postMessage({ type: 'roll', done, total, timeline: r.timeline, info: r.info });
        } catch (err) {
          rollFailed = true;
          global.postMessage({ type: 'rollError', message: String((err && err.stack) || err) });
        }
      };
    }

    // onProgressは進行中配列(全体)への参照を渡してくるので、前回送信位置からの
    // 差分だけをpostMessageする(structured cloneのコストを送信ごとに一定に保つ)。
    let lastSent = 0;
    let initSent = false;
    const onProgress = (done, total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites) => {
      if (done <= lastSent) return;
      const chunk = {
        type: 'progress',
        done, total,
        start: lastSent,
        writeLog: writeLog.slice(lastSent, done),
        regSnapshots: regSnapshots.slice(lastSent, done),
        n163Snapshots: n163Snapshots.slice(lastSent, done)
      };
      if (!initSent) {
        initSent = true;
        chunk.initRegs = initRegs;
        chunk.initWrites = initWrites;
      }
      lastSent = done;
      global.postMessage(chunk);
      if (sendRoll) sendRoll({ regSnapshots, writeLog, n163Snapshots }, done, total);
    };

    try {
      await MML.Emu.captureSongAsync(msg.nsfBytes, opt, onProgress);
      global.postMessage({ type: 'done', cancelled });
    } catch (err) {
      global.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  };
})(window);
