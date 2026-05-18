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
  rm -f dist/onboard-linux-amd64
  rm -f dist/onboard-windows-amd64.exe
  rm -f dist/onboard-macos-amd64
  rm -f dist/onboard-macos-arm64
}
trap cleanup EXIT

stub_go="$work_dir/go"
cat >"$stub_go" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${CGO_ENABLED:-}" != "0" ]]; then
  echo "CGO_ENABLED must be 0" >&2
  exit 1
fi

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

GO_BIN="$stub_go" "$script" >/dev/null

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

check_output dist/onboard-linux-amd64 linux/amd64
check_output dist/onboard-windows-amd64.exe windows/amd64
check_output dist/onboard-macos-amd64 darwin/amd64
check_output dist/onboard-macos-arm64 darwin/arm64
