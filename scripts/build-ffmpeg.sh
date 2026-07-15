#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="8.1"
ARCHIVE="ffmpeg-${VERSION}.tar.xz"
URL="https://ffmpeg.org/releases/${ARCHIVE}"
SHA256="b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a"
WORK="$ROOT/.vendor-build/ffmpeg-${VERSION}"
SOURCE="$WORK/source"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
JOBS="$(sysctl -n hw.logicalcpu)"

mkdir -p "$WORK" "$ROOT/licenses" "$ROOT/vendor/bin/darwin-x64" "$ROOT/vendor/bin/darwin-arm64"

if [[ ! -f "$WORK/$ARCHIVE" ]]; then
  curl -fL "$URL" -o "$WORK/$ARCHIVE"
fi
ACTUAL="$(shasum -a 256 "$WORK/$ARCHIVE" | cut -d ' ' -f 1)"
[[ "$ACTUAL" == "$SHA256" ]] || { echo "FFmpeg SHA-256 不匹配: $ACTUAL" >&2; exit 1; }

if [[ ! -d "$SOURCE" ]]; then
  mkdir -p "$SOURCE"
  tar -xJf "$WORK/$ARCHIVE" --strip-components=1 -C "$SOURCE"
fi

build_arch() {
  local arch="$1"
  local output_dir="$2"
  local build="$WORK/build-$arch"
  local prefix="$WORK/install-$arch"
  local binary="$ROOT/vendor/bin/$output_dir/ffmpeg"
  [[ -x "$binary" && "${FORCE_FFMPEG_BUILD:-0}" != "1" ]] && return

  rm -rf "$build" "$prefix"
  mkdir -p "$build" "$prefix"
  local args=(
    "--prefix=$prefix"
    "--target-os=darwin"
    "--arch=$arch"
    "--cc=clang"
    "--sysroot=$SDK"
    "--extra-cflags=-arch $arch -mmacosx-version-min=12.0"
    "--extra-ldflags=-arch $arch -mmacosx-version-min=12.0"
    "--disable-autodetect"
    "--disable-doc"
    "--disable-debug"
    "--disable-ffplay"
    "--disable-ffprobe"
    "--disable-shared"
    "--enable-static"
    "--enable-small"
    "--disable-iconv"
    "--disable-bzlib"
    "--disable-lzma"
    "--disable-zlib"
    "--disable-securetransport"
    "--extra-version=video-checker"
  )
  [[ "$arch" == "x86_64" ]] && args+=("--disable-x86asm")
  [[ "$(uname -m)" != "$arch" ]] && args+=("--enable-cross-compile")

  (
    cd "$build"
    MACOSX_DEPLOYMENT_TARGET=12.0 "$SOURCE/configure" "${args[@]}"
    make -j"$JOBS"
    make install
  )

  cp "$prefix/bin/ffmpeg" "$binary"
  chmod 755 "$binary"
  strip -x "$binary"
  codesign --force --sign - "$binary"
  file "$binary" | grep -q "$arch"
}

build_arch x86_64 darwin-x64
build_arch arm64 darwin-arm64

cp "$WORK/$ARCHIVE" "$ROOT/licenses/ffmpeg-${VERSION}-source.tar.xz"
cp "$SOURCE/COPYING.LGPLv2.1" "$ROOT/licenses/ffmpeg-LGPL-2.1.txt"
cat > "$ROOT/licenses/ffmpeg-build-config.txt" <<EOF
FFmpeg ${VERSION}
Source: ${URL}
SHA-256: ${SHA256}
Deployment target: macOS 12.0
License profile: LGPL-only; --enable-gpl and --enable-nonfree are not used
Architectures: x86_64, arm64
Purpose: local thumbnail extraction only
EOF

HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" == "x86_64" ]]; then
  "$ROOT/vendor/bin/darwin-x64/ffmpeg" -version | sed -n '1,3p'
elif [[ "$HOST_ARCH" == "arm64" ]]; then
  "$ROOT/vendor/bin/darwin-arm64/ffmpeg" -version | sed -n '1,3p'
fi

echo "FFmpeg ${VERSION} 双架构资源已准备完成"
