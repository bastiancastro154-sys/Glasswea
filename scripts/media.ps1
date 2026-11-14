# Lee la sesión multimedia actual de Windows (Spotify, navegador, etc.) y la emite como JSON por línea.
# Requiere Windows PowerShell 5.1 (powershell.exe), que trae la proyección de WinRT.
param([string]$Action = 'watch')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $null = $task.Wait(5000)
    $task.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

if ($Action -ne 'watch') {
    $s = $manager.GetCurrentSession()
    if ($s) {
        switch ($Action) {
            'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
            'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
            'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
        }
    }
    exit 0
}

function Get-Thumb($ref) {
    try {
        if (-not $ref) { return $null }
        $ras = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        try {
            $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ras)
        } catch {
            # PowerShell a veces no resuelve la sobrecarga con objetos WinRT: se invoca por reflexión.
            $m = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
            $net = $m.Invoke($null, @($ras))
        }
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        if ($ms.Length -eq 0) { throw 'la carátula llegó vacía' }
        $mime = 'image/png'
        try { if ($ras.ContentType) { $mime = [string]$ras.ContentType } } catch { }
        $script:thumbError = $null
        return "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray())
    } catch {
        $script:thumbError = [string]$_.Exception.Message
        return $null
    }
}

$lastKey = ''
$lastLine = ''
$thumbError = $null
$thumbTries = 0
$triedKey = ''
while ($true) {
    try {
        $s = $manager.GetCurrentSession()
        if (-not $s) {
            $out = @{ active = $false }
            $lastKey = ''
        } else {
            $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $pb = $s.GetPlaybackInfo()
            $tl = $s.GetTimelineProperties()
            $playing = ($pb.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)
            $pos = $tl.Position.TotalSeconds
            if ($playing -and $tl.LastUpdatedTime.Year -gt 2000) {
                $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
            }
            $dur = $tl.EndTime.TotalSeconds
            if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
            $out = @{
                active   = $true
                title    = [string]$p.Title
                artist   = [string]$p.Artist
                playing  = $playing
                position = [math]::Round($pos, 1)
                duration = [math]::Round($dur, 1)
            }
            $key = "$($p.Title)|$($p.Artist)"
            if ($key -ne $lastKey) {
                # La carátula solo se envía cuando cambia la canción.
                if ($key -ne $triedKey) { $triedKey = $key; $thumbTries = 0 }
                $thumbTries++
                $out.thumb = Get-Thumb $p.Thumbnail
                $out.trackChanged = $true
                # Algunas apps publican la carátula un poco después del título: se reintenta unas veces.
                if ($out.thumb -or -not $p.Title -or $thumbTries -ge 8) {
                    $lastKey = $key
                    if (-not $out.thumb -and $thumbError) { $out.thumbError = $thumbError }
                }
            }
        }
        $line = $out | ConvertTo-Json -Compress
        if ($line -ne $lastLine -or $out.playing) {
            [Console]::Out.WriteLine($line)
            [Console]::Out.Flush()
            $lastLine = $line
        }
    } catch { }
    Start-Sleep -Milliseconds 1000
}
