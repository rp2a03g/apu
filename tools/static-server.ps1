param(
    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 }),
    [string]$Root = (Resolve-Path "$PSScriptRoot\..").Path
)

Add-Type -AssemblyName System.Net.HttpListener -ErrorAction SilentlyContinue

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root on http://localhost:$Port/"

$mime = @{
    '.html' = 'text/html'
    '.js'   = 'application/javascript'
    '.css'  = 'text/css'
    '.spc'  = 'application/octet-stream'
    '.json' = 'application/json'
    '.wav'  = 'audio/wav'
}

$SaveDir = "C:\Users\user\AppData\Local\Temp\claude\C--Users-user-Desktop-mml\cfac7993-fcb0-40b6-bc90-512c384a608d\scratchpad"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    try {
        $rawPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
        $relPath = $rawPath.TrimStart('/')

        if ($request.HttpMethod -eq 'POST' -and $relPath -like 'save/*') {
            $saveName = [System.IO.Path]::GetFileName($relPath.Substring(5))
            if (-not (Test-Path $SaveDir)) { New-Item -ItemType Directory -Path $SaveDir -Force | Out-Null }
            $savePath = Join-Path $SaveDir $saveName
            $ms = New-Object System.IO.MemoryStream
            $request.InputStream.CopyTo($ms)
            [System.IO.File]::WriteAllBytes($savePath, $ms.ToArray())
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.StatusCode = 200
            $okMsg = [System.Text.Encoding]::UTF8.GetBytes("saved: $savePath")
            $response.OutputStream.Write($okMsg, 0, $okMsg.Length)
            $response.OutputStream.Close()
            continue
        }

        if ([string]::IsNullOrEmpty($relPath)) { $relPath = 'index.html' }
        $fullPath = Join-Path $Root $relPath

        if (Test-Path $fullPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
            $contentType = $mime[$ext]
            if (-not $contentType) { $contentType = 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            # 開発中にJSを編集してもブラウザに古いキャッシュを返さないよう常に無効化する
            # (HttpListenerはCache-Control/ExpiresをHeaders.Add()経由だと無視することがあるため
            # AppendHeaderで明示的に追加する)
            $response.AppendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            $response.AppendHeader("Pragma", "no-cache")
            $response.AppendHeader("Expires", "0")
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $relPath")
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch {
        $response.StatusCode = 500
        $errMsg = [System.Text.Encoding]::UTF8.GetBytes("500: $($_.Exception.Message)")
        $response.OutputStream.Write($errMsg, 0, $errMsg.Length)
    } finally {
        $response.OutputStream.Close()
    }
}
