AudioWorklet バンドルについて
==============================

※2026-08-22 現状: このバンドル群(worklet-loader.js / mml-worklet.js / mml-worklet-impl.js /
  nsf-worklet.js / nsf-worklet-impl.js)は index.html から一切参照されていない未使用コードです
  (MML再生はScriptProcessorNode = src/audio/stream-player.js に移行済み。ROADMAP.md 参照)。
  そのため下記のソースを編集しても再ビルドは不要です。動作確認が済み次第まとめて削除予定。
src/audio/mml-worklet.js と src/audio/nsf-worklet.js は
APU エミュレータコードを自己完結にまとめたビルド済みファイルです。
file:// から fetch() なしで動作するよう、ソースを手動で結合しています。

以下のソースファイルを編集した場合は PowerShell で再ビルドしてください:
  - src/emulator/apu2a03.js
  - src/emulator/expansion/*.js
  - src/emulator/cpu6502.js
  - src/emulator/nsfBus.js
  - src/emulator/nsfPlayer.js
  - src/emulator/capture.js
  - src/nsf/nsfHeader.js
  - src/audio/mml-worklet-impl.js  (MML Worklet プロセッサ本体)
  - src/audio/nsf-worklet-impl.js  (NSF Worklet プロセッサ本体)

--- 再ビルドコマンド (PowerShell) ---

Set-Location "C:\Users\user\Desktop\mml"

function Build-Worklet($outPath, $paths) {
    $combined = ($paths | ForEach-Object {
        (Get-Content $_ -Raw -Encoding UTF8) -replace '\)\(window\)', ')(globalThis)'
    }) -join "`n"
    [System.IO.File]::WriteAllText((Resolve-Path ".").Path + "\" + $outPath, $combined, [System.Text.Encoding]::UTF8)
}

Build-Worklet 'src\audio\mml-worklet.js' @(
    'src\emulator\apu2a03.js',
    'src\emulator\expansion\vrc6.js',
    'src\emulator\expansion\vrc7.js',
    'src\emulator\expansion\fds.js',
    'src\emulator\expansion\mmc5.js',
    'src\emulator\expansion\n163.js',
    'src\emulator\expansion\fme7.js',
    'src\emulator\capture.js',
    'src\audio\mml-worklet-impl.js'
)

Build-Worklet 'src\audio\nsf-worklet.js' @(
    'src\nsf\nsfHeader.js',
    'src\emulator\apu2a03.js',
    'src\emulator\expansion\vrc6.js',
    'src\emulator\expansion\vrc7.js',
    'src\emulator\expansion\fds.js',
    'src\emulator\expansion\mmc5.js',
    'src\emulator\expansion\n163.js',
    'src\emulator\expansion\fme7.js',
    'src\emulator\cpu6502.js',
    'src\emulator\nsfBus.js',
    'src\emulator\nsfPlayer.js',
    'src\emulator\capture.js',
    'src\audio\nsf-worklet-impl.js'
)
