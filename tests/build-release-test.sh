#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

script="scripts/build-release.sh"

if [[ ! -f "$script" ]]; then
  echo "expected $script to exist" >&2
  exit 1
fi

if [[ ! -x "$script" ]]; then
  echo "expected $script to be executable" >&2
  exit 1
fi

bash -n "$script"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/onboard-release-test.XXXXXX")"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

release_dir="$work_dir/release"
args_log="$work_dir/go-args"
mkdir -p dist
printf 'preserve me\n' >dist/keep-me

stub_go="$work_dir/go"
cat >"$stub_go" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${CGO_ENABLED:-}" != "0" ]]; then
  echo "CGO_ENABLED must be 0" >&2
  exit 1
fi

printf '%s\n' "$*" >>"${GO_ARGS_LOG:?}"

output=""
while (($#)); do
  case "$1" in
    -o)
      shift
      output="${1:-}"
      ;;
  esac
  shift || true
done

if [[ -z "$output" ]]; then
  echo "missing -o output" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
printf '%s/%s\n' "${GOOS:-}" "${GOARCH:-}" >"$output"
STUB
chmod +x "$stub_go"

GO_BIN="$stub_go" GO_ARGS_LOG="$args_log" DIST_DIR="$release_dir" "$script" >/dev/null

if [[ "$(cat dist/keep-me)" != "preserve me" ]]; then
  echo "release build modified unrelated dist content" >&2
  exit 1
fi

if [[ "$(grep -c -- '-trimpath' "$args_log")" != "6" ]]; then
  echo "expected every Go build to use -trimpath" >&2
  exit 1
fi

if [[ "$(grep -c -- '-buildvcs=false' "$args_log")" != "6" ]]; then
  echo "expected every Go build to exclude local VCS metadata" >&2
  exit 1
fi

if [[ "$(grep -c -- '-ldflags=-s -w' "$args_log")" != "6" ]]; then
  echo "expected every Go build to strip symbols reproducibly" >&2
  exit 1
fi

check_output() {
  local output="$1"
  local expected="$2"

  if [[ ! -f "$output" ]]; then
    echo "expected $output to be created" >&2
    exit 1
  fi

  if [[ "$(cat "$output")" != "$expected" ]]; then
    echo "expected $output to contain $expected" >&2
    exit 1
  fi
}

check_output "$release_dir/onboard-linux-amd64" linux/amd64
check_output "$release_dir/onboard-linux-arm64" linux/arm64
check_output "$release_dir/onboard-windows-amd64.exe" windows/amd64
check_output "$release_dir/onboard-windows-arm64.exe" windows/arm64
check_output "$release_dir/onboard-macos-amd64" darwin/amd64
check_output "$release_dir/onboard-macos-arm64" darwin/arm64

if [[ ! -f "$release_dir/checksums.txt" ]]; then
  echo "expected checksums.txt to be created" >&2
  exit 1
fi

for notice in LICENSE THIRD_PARTY_NOTICES.md; do
  if [[ ! -f "$release_dir/$notice" ]]; then
    echo "expected release to include $notice" >&2
    exit 1
  fi
done

for output in \
  onboard-linux-amd64 \
  onboard-linux-arm64 \
  onboard-windows-amd64.exe \
  onboard-windows-arm64.exe \
  onboard-macos-amd64 \
  onboard-macos-arm64 \
  LICENSE \
  THIRD_PARTY_NOTICES.md; do
  if ! grep -q " ${output}$" "$release_dir/checksums.txt"; then
    echo "expected checksums.txt to include $output" >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$release_dir" && sha256sum -c checksums.txt >/dev/null)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$release_dir" && shasum -a 256 -c checksums.txt >/dev/null)
fi

real_go="${REAL_GO_BIN:-/usr/local/go/bin/go}"
if [[ ! -x "$real_go" ]]; then
  echo "expected executable Go tool at $real_go" >&2
  exit 1
fi

for checkout in "$work_dir/checkout-a" "$work_dir/a-different-checkout-path"; do
  mkdir -p "$checkout"
  cp go.mod go.sum "$checkout/"
  cp -R cmd internal web "$checkout/"
  (
    cd "$checkout"
    GOCACHE="$work_dir/go-cache" CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      "$real_go" build -buildvcs=false -trimpath -ldflags='-s -w' -o onboard ./cmd/onboard
  )
done

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

hash_a="$(checksum "$work_dir/checkout-a/onboard")"
hash_b="$(checksum "$work_dir/a-different-checkout-path/onboard")"
if [[ "$hash_a" != "$hash_b" ]]; then
  echo "release binary changed across absolute checkout paths" >&2
  exit 1
fi
