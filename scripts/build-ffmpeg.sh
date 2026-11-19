#!/usr/bin/env bash
# Run in an MSYS2 UCRT64 shell. Build both tools against one set of media DLLs.
set -euo pipefail
[[ ${MSYSTEM:-} == UCRT64 ]] || { echo "Use the MSYS2 UCRT64 shell" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
tools="$root/build/tools"
version=8.1.2
archive="$tools/ffmpeg-$version.tar.xz"
prefix="$tools/ffmpeg-$version-mobiletv"
mkdir -p "$tools" "$root/build/media-build/objects"
if [[ ! -f "$archive" ]]; then curl -fL --retry 2 "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" -o "$archive"; fi
echo "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c  $archive" | sha256sum -c -
if [[ ! -f "$tools/ffmpeg-$version/configure" ]]; then tar -xf "$archive" -C "$tools"; fi
cd "$root/build/media-build/objects"
"$tools/ffmpeg-$version/configure" --prefix="$prefix" --target-os=mingw32 --arch=x86_64 \
  --enable-shared --disable-static --disable-debug --disable-doc --disable-ffplay \
  --disable-autodetect --enable-gpl --enable-libass --enable-libx264 --enable-libx265 \
  --enable-libdav1d --enable-schannel --enable-zlib --enable-bzlib --enable-lzma \
  --enable-d3d11va --enable-dxva2 --disable-indevs --enable-indev=lavfi --disable-outdevs \
  --disable-filters --enable-filter='aformat,format,scale,scale2ref,overlay,ass,subtitles,aresample,pan,volume,trim,atrim,setpts,asetpts,transpose,rotate,hflip,vflip,pad,crop,fps,split,asplit,null,anull,sine,color,testsrc,testsrc2,aevalsrc,anullsrc,drawbox' \
  --disable-encoders --enable-encoder='libx264,libx265,aac,ac3,eac3,flac,alac,pcm_*,rawvideo,wrapped_avframe,mjpeg,png,webvtt,subrip,srt,ass,movtext'
make -j"${JOBS:-8}"
make install
cp "$tools/ffmpeg-$version/COPYING.GPLv2" "$prefix/LICENSE"
cp "$tools/ffmpeg-$version/COPYING.GPLv3" "$prefix/COPYING.GPLv3"
mkdir -p "$prefix/licenses"
cp "$root/scripts/build-ffmpeg.sh" "$prefix/licenses/"

# Include transitive non-system imports and the package notices for those DLLs.
queue=("$prefix/bin/ffmpeg.exe" "$prefix/bin/ffprobe.exe")
declare -A seen owners
while read -r owner file; do
  owners[${file,,}]=$owner
done < <(pacman -Ql | awk -v dir="$MINGW_PREFIX/bin/" 'index($2,dir)==1 && tolower($2) ~ /\.dll$/ {print $1, $2}')
: > "$prefix/licenses/runtime-packages.tmp"
for ((i=0; i<${#queue[@]}; i++)); do
  while read -r dll; do
    [[ -n "$dll" && -z "${seen[${dll,,}]:-}" ]] || continue
    seen[${dll,,}]=1
    if [[ "$dll" =~ ^(av(codec|device|filter|format|util)|sw(resample|scale))-[0-9]+\.dll$ ]]; then
      test -f "$prefix/bin/$dll"
    elif [[ -f "$MINGW_PREFIX/bin/$dll" ]]; then
      cp "$MINGW_PREFIX/bin/$dll" "$prefix/bin/"
      owner=${owners[${MINGW_PREFIX,,}/bin/${dll,,}]}
      pacman -Q "$owner" >> "$prefix/licenses/runtime-packages.tmp"
      while read -r notice; do
        [[ -f "$notice" ]] || continue
        mkdir -p "$prefix/licenses/$owner"
        cp "$notice" "$prefix/licenses/$owner/"
      done < <(pacman -Qlq "$owner" | grep '/share/licenses/' || true)
    elif [[ ! -f "$(cygpath -u "$WINDIR")/System32/$dll" && "$dll" != api-ms-win-* ]]; then
      echo "Unresolved import: $dll" >&2; exit 1
    else
      continue
    fi
    queue+=("$prefix/bin/$dll")
  done < <(objdump -p "${queue[i]}" | awk '/DLL Name:/{print $3}' | tr -d '\r')
done
sort -u "$prefix/licenses/runtime-packages.tmp" > "$prefix/licenses/runtime-packages.txt"
rm "$prefix/licenses/runtime-packages.tmp"
cp "$prefix/COPYING.GPLv3" "$prefix/licenses/"
cat > "$prefix/README.txt" <<EOF
FFmpeg $version, shared Windows x64 build for MobileTV.
Source: https://ffmpeg.org/releases/ffmpeg-$version.tar.xz
Build recipe and dependency notices: licenses/FFmpeg-components/
MSYS2 dependency sources: https://github.com/msys2/MINGW-packages
Exact runtime package versions are in runtime-packages.txt.
EOF
"$prefix/bin/ffmpeg" -version
"$prefix/bin/ffprobe" -version
printf '%s\n' "${queue[@]##*/}" | sort -u > "$prefix/runtime-files.tmp"
mv "$prefix/runtime-files.tmp" "$prefix/runtime-files.txt"
