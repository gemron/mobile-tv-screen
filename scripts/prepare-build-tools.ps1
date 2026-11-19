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
    $mediaRoot = Join-Path $toolsRoot 'ffmpeg-8.1.2-mobiletv'
    $ffmpeg = Join-Path $mediaRoot 'bin\ffmpeg.exe'
    $recipe = Join-Path $PSScriptRoot 'build-ffmpeg.sh'
    $builtRecipe = Join-Path $mediaRoot 'licenses\build-ffmpeg.sh'
    $prepared = (Test-Path -LiteralPath (Join-Path $mediaRoot 'runtime-files.txt')) -and
        (Test-Path -LiteralPath $builtRecipe) -and
        ((Get-FileHash -LiteralPath $builtRecipe).Hash -eq (Get-FileHash -LiteralPath $recipe).Hash)
    if (-not $prepared) {
        $work = Join-Path $projectRoot 'build\media-build'
        $bash = Join-Path $work 'msys64\usr\bin\bash.exe'
        if (-not (Test-Path -LiteralPath $bash)) {
            $archive = Get-VerifiedDownload 'https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260927.sfx.exe' 'msys2-base-x86_64-20260927.sfx.exe' 'AD336CCCFDA47758B5E15CDA993FBBA421115CB0B126697DAEF1EE4DFE37209F'
            New-Item -ItemType Directory -Force -Path $work | Out-Null
            & $archive -y "-o$work" | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'MSYS2 extraction failed.' }
        }
        $env:MSYSTEM = 'UCRT64'
        & $bash -lc 'pacman -Sy --needed --noconfirm make nasm mingw-w64-ucrt-x86_64-{gcc,pkgconf,libass,libx264,x265,dav1d,zlib,xz,bzip2}'
        if ($LASTEXITCODE -ne 0) { throw 'MSYS2 build dependencies failed.' }
        & $bash --login ($recipe.Replace('\','/'))
        if ($LASTEXITCODE -ne 0) { throw 'Shared FFmpeg build failed.' }
    }
    $env:FFMPEG_PATH = $ffmpeg
    $env:PATH = (Split-Path -Parent $ffmpeg) + ';' + $env:PATH
    if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value (Split-Path -Parent $ffmpeg) -Encoding utf8 }
    if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('FFMPEG_PATH=' + $ffmpeg) -Encoding utf8 }
}
if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('ISCC_PATH=' + $compiler) -Encoding utf8 }
Write-Host "Inno Setup compiler: $compiler"
if ($env:FFMPEG_PATH) { Write-Host "FFmpeg: $env:FFMPEG_PATH" }
