# Lee todas las sesiones multimedia de Windows (Spotify, navegador, etc.) y las emite como JSON por línea.
# Con -Action toggle|next|prev actúa sobre la sesión indicada en -Target (o la actual si no se indica).
# Requiere Windows PowerShell 5.1 (powershell.exe), que trae la proyección de WinRT.
param([string]$Action = 'watch', [string]$Target = '')

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

# Cada reproductor es una sesión. Se identifica por su app; si una app tiene varias, se numeran.
function Get-Sessions {
    $list = @()
    $seen = @{}
    $all = @()
    try { $all = @($manager.GetSessions()) } catch { }
    if ($all.Count -eq 0) {
        $c = $manager.GetCurrentSession()
        if ($c) { $all = @($c) }
    }
    foreach ($s in $all) {
        if (-not $s) { continue }
        $src = [string]$s.SourceAppUserModelId
        if (-not $src) { $src = 'desconocido' }
        if ($seen.ContainsKey($src)) { $seen[$src]++; $id = "$src#$($seen[$src])" } else { $seen[$src] = 0; $id = $src }
        $list += @{ id = $id; source = $src; session = $s }
    }
    return ,$list
}

if ($Action -ne 'watch') {
    $s = $null
    if ($Target) {
        foreach ($e in (Get-Sessions)) { if ($e.id -eq $Target) { $s = $e.session; break } }
    }
    if (-not $s) { $s = $manager.GetCurrentSession() }
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

$lastLine = ''
$thumbError = $null
$track = @{}   # por sesión: última canción enviada con carátula e intentos de leerla
while ($true) {
    try {
        $sessions = @()
        $anyPlaying = $false
        $alive = @{}
        foreach ($e in (Get-Sessions)) {
            try {
                $s = $e.session
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
                $o = @{
                    id       = $e.id
                    source   = $e.source
                    title    = [string]$p.Title
                    artist   = [string]$p.Artist
                    playing  = $playing
                    position = [math]::Round($pos, 1)
                    duration = [math]::Round($dur, 1)
                }
                if ($playing) { $anyPlaying = $true }
                $alive[$e.id] = $true
                if (-not $track.ContainsKey($e.id)) { $track[$e.id] = @{ last = ''; tried = ''; tries = 0 } }
                $t = $track[$e.id]
                $key = "$($p.Title)|$($p.Artist)"
                if ($key -ne $t.last) {
                    # La carátula solo se envía cuando cambia la canción.
                    if ($key -ne $t.tried) { $t.tried = $key; $t.tries = 0 }
                    $t.tries++
                    $o.thumb = Get-Thumb $p.Thumbnail
                    $o.trackChanged = $true
                    # Algunas apps publican la carátula un poco después del título: se reintenta unas veces.
                    if ($o.thumb -or -not $p.Title -or $t.tries -ge 8) {
                        $t.last = $key
                        if (-not $o.thumb -and $thumbError) { $o.thumbError = $thumbError }
                    }
                }
                $sessions += $o
            } catch { }
        }
        foreach ($k in @($track.Keys)) { if (-not $alive.ContainsKey($k)) { $track.Remove($k) } }
        $current = ''
        try {
            $c = $manager.GetCurrentSession()
            if ($c) {
                $csrc = [string]$c.SourceAppUserModelId
                foreach ($o in $sessions) { if ($o.source -eq $csrc) { $current = $o.id; break } }
            }
        } catch { }
        $out = @{ sessions = @($sessions); current = $current }
        $line = $out | ConvertTo-Json -Compress -Depth 4
        if ($line -ne $lastLine -or $anyPlaying) {
            [Console]::Out.WriteLine($line)
            [Console]::Out.Flush()
            $lastLine = $line
        }
    } catch { }
    Start-Sleep -Milliseconds 1000
}
