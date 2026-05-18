#!/usr/bin/env bash
set -euo pipefail

GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"

mkdir -p dist

build_target() {
  local goos="$1"
  local goarch="$2"
  local output="$3"

  echo "building ${goos}/${goarch} -> ${output}"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" "$GO_BIN" build -o "$output" ./cmd/onboard
}

build_target linux amd64 dist/onboard-linux-amd64
build_target windows amd64 dist/onboard-windows-amd64.exe
build_target darwin amd64 dist/onboard-macos-amd64
build_target darwin arm64 dist/onboard-macos-arm64
