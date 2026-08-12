param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,
    [string]$Language = "zh-Hans-CN"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Await-WinRt {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType
    )

    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq "AsTask" -and
            $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1
        } |
        Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

try {
    if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
        throw "The exported canvas image does not exist."
    }

    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

    $languageObject = New-Object Windows.Globalization.Language($Language)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languageObject)
    if ($null -eq $engine) {
        throw "The Windows OCR language pack is not installed: $Language"
    }

    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $ImagePath).Path)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @()
            foreach ($line in $result.Lines) {
                $minX = [double]::PositiveInfinity
                $minY = [double]::PositiveInfinity
                $maxX = 0.0
                $maxY = 0.0
                foreach ($word in $line.Words) {
                    $rect = $word.BoundingRect
                    if ($rect.X -lt $minX) { $minX = $rect.X }
                    if ($rect.Y -lt $minY) { $minY = $rect.Y }
                    if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
                    if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
                }
                if ($line.Words.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($line.Text)) {
                    $normalizedText = [regex]::Replace($line.Text, '(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])', '')
                    $normalizedText = [regex]::Replace($normalizedText, '(?<=[\u3400-\u9fff])\s+(?=\p{P})', '')
                    $normalizedText = [regex]::Replace($normalizedText, '(?<=\p{P})\s+(?=[\u3400-\u9fff])', '')
                    $lines += [ordered]@{
                        text = $normalizedText.Trim()
                        x = [math]::Round($minX, 2)
                        y = [math]::Round($minY, 2)
                        width = [math]::Round($maxX - $minX, 2)
                        height = [math]::Round($maxY - $minY, 2)
                    }
                }
            }

            [ordered]@{
                ok = $true
                language = $Language
                angle = $result.TextAngle
                lineCount = $lines.Count
                lines = $lines
            } | ConvertTo-Json -Depth 6 -Compress
        }
        finally {
            if ($null -ne $bitmap) { $bitmap.Dispose() }
        }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}
catch {
    [ordered]@{
        ok = $false
        error = $_.Exception.Message
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
