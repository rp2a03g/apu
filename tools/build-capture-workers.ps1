# Builds the regsOnly-capture Web Worker bundles:
#   src/audio/nsf-capture-worker.js  (NSF)
#   src/audio/kss-capture-worker.js  (KSS)
#   src/audio/gbs-capture-worker.js  (GBS)
#   src/audio/vgm-capture-worker.js  (VGM)
#
# Each bundle wraps the concatenated emulator sources inside a function that is
# NOT executed on the main thread. src/audio/capture-worker-client.js turns it
# into a Worker via Function.prototype.toString + Blob URL, so no fetch() is
# needed and file:// direct-open keeps working.
#
# Re-run this script whenever any listed source file changes. The client
# verifies freshness at runtime (toString substring check) and falls back to
# the main-thread capture with a console warning if a bundle is stale.
#
# See also: src/audio/README-worker-build.txt

$root = Split-Path -Parent $PSScriptRoot

$bundles = @(
    @{
        Key = 'nsfCapture'
        Out = 'src\audio\nsf-capture-worker.js'
        Files = @(
            'src\nsf\nsfHeader.js',
            'src\emulator\cpu6502.js',
            'src\emulator\apu2a03.js',
            'src\emulator\expansion\vrc6.js',
            'src\emulator\expansion\opllNuked.js',
            'src\emulator\expansion\vrc7.js',
            'src\emulator\expansion\fds.js',
            'src\emulator\expansion\mmc5.js',
            'src\emulator\expansion\n163.js',
            'src\emulator\expansion\fme7.js',
            'src\emulator\nsfBus.js',
            'src\emulator\nsfPlayer.js',
            'src\emulator\capture.js',
            'src\ui\keyboard.js',
            'src\audio\roll-builders.js',
            'src\audio\nsf-capture-worker-impl.js'
        )
    },
    @{
        Key = 'kssCapture'
        Out = 'src\audio\kss-capture-worker.js'
        Files = @(
            'src\kss\kssHeader.js',
            'src\emulator\cpuZ80.js',
            'src\emulator\expansion\ay8910Msx.js',
            'src\emulator\expansion\sccAudio.js',
            'src\emulator\expansion\opllNuked.js',
            'src\emulator\expansion\opllMsx.js',
            'src\emulator\kssBus.js',
            'src\emulator\kssPlayer.js',
            'src\emulator\capture.js',
            'src\convert\options.js',
            'src\convert\pitch.js',
            'src\kss2mml\expansion\ay.js',
            'src\kss2mml\expansion\scc.js',
            'src\kss2mml\expansion\opll.js',
            'src\audio\roll-builders.js',
            'src\audio\capture-worker-multi-impl.js'
        )
    },
    @{
        Key = 'gbsCapture'
        Out = 'src\audio\gbs-capture-worker.js'
        Files = @(
            'src\gbs\gbsHeader.js',
            'src\emulator\cpuSm83.js',
            'src\emulator\apuGb.js',
            'src\emulator\gbsBus.js',
            'src\emulator\gbsPlayer.js',
            'src\emulator\capture.js',
            'src\convert\options.js',
            'src\convert\pitch.js',
            'src\gbs2mml\expansion\hwEnvelope.js',
            'src\gbs2mml\expansion\pulse.js',
            'src\gbs2mml\expansion\noise.js',
            'src\gbs2mml\expansion\wave.js',
            'src\audio\roll-builders.js',
            'src\audio\capture-worker-multi-impl.js'
        )
    },
    @{
        Key = 'vgmCapture'
        Out = 'src\audio\vgm-capture-worker.js'
        Files = @(
            'src\vgm\vgmHeader.js',
            'src\emulator\capture.js',
            'src\emulator\apu2a03.js',
            'src\emulator\expansion\fds.js',
            'src\emulator\apuGb.js',
            'src\emulator\gbsPlayer.js',
            'src\emulator\apuHuC6280.js',
            'src\emulator\hesPlayer.js',
            'src\emulator\expansion\ay8910Msx.js',
            'src\emulator\expansion\sccAudio.js',
            'src\emulator\expansion\opllNuked.js',
            'src\emulator\expansion\opllMsx.js',
            'src\emulator\expansion\sn76489.js',
            'src\emulator\expansion\ym2612Nuked.js',
            'src\emulator\expansion\ym2610.js',
            'src\emulator\expansion\ym2151.js',
            'src\emulator\expansion\ga20.js',
            'src\emulator\expansion\segapcm.js',
            'src\emulator\expansion\c140.js',
            'src\emulator\expansion\pwm32x.js',
            'src\emulator\expansion\rf5c164.js',
            'src\emulator\vgmPlayer.js',
            'src\hes\hesHeader.js',
            'src\ui\keyboard.js',
            'src\convert\options.js',
            'src\convert\pitch.js',
            'src\convert\retrigger.js',
            'src\dpcm\dpcmConverter.js',
            'src\kss2mml\expansion\ay.js',
            'src\kss2mml\expansion\scc.js',
            'src\kss2mml\expansion\opll.js',
            'src\gbs2mml\expansion\hwEnvelope.js',
            'src\gbs2mml\expansion\pulse.js',
            'src\gbs2mml\expansion\noise.js',
            'src\gbs2mml\expansion\wave.js',
            'src\hes2mml\expansion\wave.js',
            'src\hes2mml\expansion\noise.js',
            'src\hes2mml\expansion\dpcm.js',
            'src\audio\roll-builders.js',
            'src\audio\capture-worker-multi-impl.js'
        )
    },
    @{
        Key = 'spcCapture'
        Out = 'src\audio\spc-capture-worker.js'
        Files = @(
            'src\spc\spcHeader.js',
            'src\emulator\spc700.js',
            'src\emulator\spcDsp.js',
            'src\emulator\spcPlayer.js',
            'src\spc2mml\converter.js',
            'src\convert\options.js',
            'src\convert\pitch.js',
            'src\audio\roll-builders.js',
            'src\audio\capture-worker-multi-impl.js'
        )
    },
    @{
        Key = 'hesCapture'
        Out = 'src\audio\hes-capture-worker.js'
        Files = @(
            'src\hes\hesHeader.js',
            'src\emulator\cpuHuC6280.js',
            'src\emulator\apuHuC6280.js',
            'src\emulator\hesBus.js',
            'src\emulator\hesPlayer.js',
            'src\convert\options.js',
            'src\convert\pitch.js',
            'src\convert\retrigger.js',
            'src\dpcm\dpcmConverter.js',
            'src\hes2mml\expansion\wave.js',
            'src\hes2mml\expansion\noise.js',
            'src\hes2mml\expansion\dpcm.js',
            'src\audio\roll-builders.js',
            'src\audio\capture-worker-multi-impl.js'
        )
    }
)

$built = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

foreach ($b in $bundles) {
    $combined = ($b.Files | ForEach-Object {
        (Get-Content (Join-Path $root $_) -Raw -Encoding UTF8) -replace '\)\(window\)', ')(globalThis)'
    }) -join "`n"

    $key = $b.Key
    $header = @"
/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at $built
 *
 * regsOnly capture worker bundle ($key). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.$key is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.${key}BuiltAt = '$built';
  MML.WorkerBundles.$key = function () {
"@

    $footer = @"
  };
})(window);
"@

    $outPath = Join-Path $root $b.Out
    [System.IO.File]::WriteAllText($outPath, ($header + "`n" + $combined + "`n" + $footer), [System.Text.Encoding]::UTF8)
    Write-Host "Wrote $($b.Out) ($((Get-Item $outPath).Length) bytes)"
}
