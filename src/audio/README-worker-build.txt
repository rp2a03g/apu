regsOnlyキャプチャ Worker バンドルについて
==========================================

src/audio/{nsf,kss,gbs,vgm,spc,hes,psf}-capture-worker.js は、各フォーマットのregsOnly
バックグラウンドキャプチャ(captureSongAsync / captureKssSongAsync /
captureGbsSongAsync / captureVgmSongAsync / SPC2MML.captureAsync /
captureHesSongAsync / capturePsfSongAsync)をWeb Workerで実行するための自己完結ビルド済みファイルです
(生成物なので直接編集しないこと)。

仕組み(file://直開き対応):
  - バンドルは「メインスレッドでは実行されない関数」MML.WorkerBundles.{nsf,kss,
    gbs,vgm}Capture として通常の<script>タグで読み込まれる
  - src/audio/capture-worker-client.js が Function.prototype.toString でソース
    文字列を取り出し、Blob URL経由で new Worker() する(fetch()不使用。
    file://のnull origin制約を避けるための回避策)
  - クライアントは起動時に鮮度チェック(メインスレッドに読み込まれている現行
    ソースのtoStringがバンドル文字列に含まれるか)を行い、再ビルド忘れの古い
    バンドルを検出したらconsole警告してメインスレッド版へフォールバックする
    (古いエミュレータのWorkerは現行と違う結果を吐くため、正しさ優先)
  - ★Workerが実行時に呼ぶ共通関数(例: Emu.kssPackWrite=src/emulator/capture.js)を
    新しく使い始めたら、定義ファイルがそのバンドルのFilesに入っているかを確認し、
    capture-worker-client.js のプローブにもその関数を足すこと。鮮度チェックは
    「バンドルに無い関数」を検出できない(2026-09-07: vgmバンドルに kssPackWrite が
    無く、AY/SSG/OPLを使うVGMのWorkerが途中で落ちてロールが空になっていた)

  - ★src/convert/toneKey.js(音色キー)は全バンドル(2026-09-14 から psf を含む7本)に入れる(2026-09-09)。roll-builders.js の
    RollBuild.toneOf と keyboard.js の buildNoteTimelineFromChannelFrames がノートに音色キーを
    載せる。無いとWorker経由のロールだけ音色一覧が空になる(プローブは _rollProbes の TK.ofEvent/ofLive)

  - psfバンドル(2026-09-14)はPSF本体(CPU/SPU/HLE BIOS)に加え、ロール構築用に keyboard.js /
    ym2610.js(Emu.SamplePitchUtil)/ multipcm.js(Emu.PoolChannelRegrouper)/ psxSampleBank.js を同梱する。
    Workerへは bytes ではなく MML.PSF.load() 済みの info(_lib 解決済み)を渡す。

ピアノロールのタイムライン構築もWorker内で行う(2026-08-21):
  - 構築ロジックは src/audio/roll-builders.js (MML.RollBuild、メインスレッドと共有)。
    NSF/VGMの共通抽出経路は src/ui/keyboard.js の純粋関数
    UI.buildRollTracksFromRegSnapshots を使うため、keyboard.jsもnsf/vgmバンドルに
    同梱される(トップレベルはDOM非依存なのでWorkerで読み込み可能。DOMを触るのは
    KeyboardDisplayクラスのメソッド内のみで、Workerからは呼ばない)
  - opt.roll={onRoll,...}が渡された場合のみ {type:'roll', done, total, timeline, info}
    を送信。構築失敗時は {type:'rollError'} を送り、クライアントがメインスレッド構築へ
    切り替える(フォールバック時も同じRollBuildコードをメインスレッドで実行)

Workerプロトコル:
  - NSF: src/audio/nsf-capture-worker-impl.js (専用プロトコル)
  - KSS/GBS/VGM: src/audio/capture-worker-multi-impl.js (汎用差分プロトコル)
  - SPC: 同multi-impl内の専用ハンドラ(frameLogが全長事前確保のため、配列長でなく
    完了フレーム数done基準の差分。multi-impl冒頭コメント参照)
  - HES: 同multi-impl内の専用ハンドラ(dpcmTrace/controlTraceが「外側固定長6・中身が
    伸びる」二重配列のため、ch別の長さ基準差分。regsOnly用途のみWorker化し、
    perChannelAudio等の音声レンダリング用途はメインスレッド版のまま)

以下のソースファイルを編集した場合は PowerShell で再ビルドしてください
(どのファイルがどのバンドルに入るかは tools/build-capture-workers.ps1 の
 $bundles 定義が正典):
  - src/{nsf,kss,gbs,vgm}/*Header.js
  - src/emulator/cpu6502.js, cpuZ80.js, cpuSm83.js
  - src/emulator/apu2a03.js, apuGb.js, apuHuC6280.js
  - src/emulator/nsfBus.js, kssBus.js, gbsBus.js
  - src/emulator/nsfPlayer.js, kssPlayer.js, gbsPlayer.js, hesPlayer.js, vgmPlayer.js
  - src/emulator/capture.js
  - src/emulator/expansion/*.js (vrc6/vrc7/fds/mmc5/n163/fme7/ay8910Msx/sccAudio/
    opllNuked/opllMsx/sn76489/ym2612Nuked/ym2612/ym2610/ym2151/ym2203/ym2608/ga20/segapcm/c140/c352/okim6258/qsound/okim6295/multipcm/pwm32x/rf5c164)
  - src/audio/nsf-capture-worker-impl.js, capture-worker-multi-impl.js

--- 再ビルドコマンド (PowerShell) ---

powershell -ExecutionPolicy Bypass -File tools\build-capture-workers.ps1
