#!/usr/bin/env bash
set -euo pipefail

GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
dist_dir="${DIST_DIR:-dist}"

mkdir -p "$dist_dir"

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
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" "$GO_BIN" build -buildvcs=false -trimpath -ldflags='-s -w' -o "$output" ./cmd/onboard
}

write_checksums() {
  local checksum_file="checksums.txt"

  rm -f "${dist_dir}/${checksum_file}"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dist_dir" && sha256sum "${outputs[@]}" LICENSE THIRD_PARTY_NOTICES.md >"$checksum_file")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$dist_dir" && shasum -a 256 "${outputs[@]}" LICENSE THIRD_PARTY_NOTICES.md >"$checksum_file")
  else
    echo "sha256sum or shasum is required to build a release" >&2
    return 1
  fi

  echo "wrote ${dist_dir}/${checksum_file}"
}

build_target linux amd64 "${dist_dir}/onboard-linux-amd64"
build_target linux arm64 "${dist_dir}/onboard-linux-arm64"
build_target windows amd64 "${dist_dir}/onboard-windows-amd64.exe"
build_target windows arm64 "${dist_dir}/onboard-windows-arm64.exe"
build_target darwin amd64 "${dist_dir}/onboard-macos-amd64"
build_target darwin arm64 "${dist_dir}/onboard-macos-arm64"

cp LICENSE THIRD_PARTY_NOTICES.md "$dist_dir/"

write_checksums
