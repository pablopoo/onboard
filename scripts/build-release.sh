#!/usr/bin/env bash
set -euo pipefail

GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"

mkdir -p dist

outputs=(
  onboard-linux-amd64
  onboard-linux-arm64
  onboard-windows-amd64.exe
  onboard-windows-arm64.exe
  onboard-macos-amd64
  onboard-macos-arm64
)

build_target() {
  local goos="$1"
  local goarch="$2"
  local output="$3"

  echo "building ${goos}/${goarch} -> ${output}"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" "$GO_BIN" build -o "$output" ./cmd/onboard
}

write_checksums() {
  local checksum_file="checksums.txt"

  rm -f "dist/${checksum_file}"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd dist && sha256sum "${outputs[@]}" >"$checksum_file")
  elif command -v shasum >/dev/null 2>&1; then
    (cd dist && shasum -a 256 "${outputs[@]}" >"$checksum_file")
  else
    echo "warning: sha256sum or shasum not found; checksums skipped" >&2
    return 0
  fi

  echo "wrote dist/${checksum_file}"
}

build_target linux amd64 dist/onboard-linux-amd64
build_target linux arm64 dist/onboard-linux-arm64
build_target windows amd64 dist/onboard-windows-amd64.exe
build_target windows arm64 dist/onboard-windows-arm64.exe
build_target darwin amd64 dist/onboard-macos-amd64
build_target darwin arm64 dist/onboard-macos-arm64

write_checksums
