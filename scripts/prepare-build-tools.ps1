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
    $archive = Get-VerifiedDownload 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z' 'ffmpeg-8.1.2-essentials_build.7z' 'E25B682664025D49034C981AFB4BAE36238A40F29A3CC1C713AD9A8B5B3528F6'
    $ffmpeg = Join-Path $toolsRoot 'ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe'
    if (-not (Test-Path -LiteralPath $ffmpeg)) {
        & tar.exe -xf $archive -C $toolsRoot 'ffmpeg-8.1.2-essentials_build/bin' 'ffmpeg-8.1.2-essentials_build/LICENSE' 'ffmpeg-8.1.2-essentials_build/README.txt'
        if ($LASTEXITCODE -ne 0) { throw 'FFmpeg archive extraction failed.' }
    }
    $env:FFMPEG_PATH = $ffmpeg
    $env:PATH = (Split-Path -Parent $ffmpeg) + ';' + $env:PATH
    if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value (Split-Path -Parent $ffmpeg) -Encoding utf8 }
    if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('FFMPEG_PATH=' + $ffmpeg) -Encoding utf8 }
}
if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('ISCC_PATH=' + $compiler) -Encoding utf8 }
Write-Host "Inno Setup compiler: $compiler"
if ($env:FFMPEG_PATH) { Write-Host "FFmpeg: $env:FFMPEG_PATH" }
