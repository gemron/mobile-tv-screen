param([switch]$SkipFFmpeg)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot 'build\tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null

function Get-VerifiedDownload([string]$Url, [string]$FileName, [string]$Checksum) {
    $destination = Join-Path $toolsRoot $FileName
    if (-not (Test-Path -LiteralPath $destination)) {
        Write-Host "Downloading $FileName ..."
        Invoke-WebRequest -Uri $Url -OutFile $destination -UseBasicParsing -TimeoutSec 180
    }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $Checksum) {
        throw "Checksum mismatch for $FileName. The existing file was retained for inspection."
    }
    return $destination
}

$innoInstaller = Get-VerifiedDownload 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_1/innosetup-7.1.1-x64.exe' 'innosetup-7.1.1-x64.exe' '8A5A6711C3766A6E5FB74F280BA0E3551E719CE94538D901FDBD1F8F9920B3F0'
$innoRoot = Join-Path $toolsRoot 'inno'
$compiler = Join-Path $innoRoot 'ISCC.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $setupProcess = Start-Process -FilePath $innoInstaller -ArgumentList @('/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART', ('/DIR="' + $innoRoot + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($setupProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $compiler)) { throw 'Inno Setup preparation failed.' }
}
$env:ISCC_PATH = $compiler
if (-not $SkipFFmpeg) {
    $archive = Get-VerifiedDownload 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-full_build.zip' 'ffmpeg-8.0.1-full_build.zip' '467CDE100A47ED4B03A897988AEB4A296890C1E2B2D2864204657D002BC5FB90'
    $ffmpeg = Join-Path $toolsRoot 'ffmpeg-8.0.1-full_build\bin\ffmpeg.exe'
    if (-not (Test-Path -LiteralPath $ffmpeg)) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $toolsRoot)
    }
    $env:FFMPEG_PATH = $ffmpeg
    $env:PATH = (Split-Path -Parent $ffmpeg) + ';' + $env:PATH
    if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value (Split-Path -Parent $ffmpeg) -Encoding utf8 }
    if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('FFMPEG_PATH=' + $ffmpeg) -Encoding utf8 }
}
if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('ISCC_PATH=' + $compiler) -Encoding utf8 }
Write-Host "Inno Setup compiler: $compiler"
if ($env:FFMPEG_PATH) { Write-Host "FFmpeg: $env:FFMPEG_PATH" }
