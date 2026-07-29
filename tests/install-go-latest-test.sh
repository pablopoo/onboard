#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

script="scripts/install-go-latest.sh"
if [[ ! -x "$script" ]]; then
  echo "expected executable $script" >&2
  exit 1
fi
bash -n "$script"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/onboard-go-installer-test.XXXXXX")"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

write_go_binary() {
  local path="$1"
  local reported_version="$2"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    "printf '%s\\n' 'go version $reported_version linux/amd64'" >"$path"
  chmod +x "$path"
}

archive_fixture() {
  local fixture_dir="$1"
  local reported_version="$2"
  local archive_root="$fixture_dir/archive-root"
  mkdir -p "$archive_root"
  write_go_binary "$archive_root/go/bin/go" "$reported_version"
  tar -C "$archive_root" -czf "$fixture_dir/go1.26.5.linux-amd64.tar.gz" go
}

checksum_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

write_metadata() {
  local file="$1"
  local checksum="$2"
  printf '[{"version":"go1.26.5","files":[\n  {"filename": "go1.26.5.linux-amd64.tar.gz",\n   "sha256": "%s"}\n]}]\n' \
    "$checksum" >"$file"
}

write_command_stubs() {
  local fixture_dir="$1"
  local bin_dir="$fixture_dir/bin"
  mkdir -p "$bin_dir"

  cat >"$bin_dir/uname" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then printf 'Linux\n'; else printf 'x86_64\n'; fi
STUB

  cat >"$bin_dir/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while (($#)); do
  case "$1" in
    -o) shift; output="${1:-}" ;;
    http*) url="$1" ;;
  esac
  shift || true
done
case "$url" in
  *VERSION*) source_file="$FIXTURE_DIR/version.txt" ;;
  *mode=json*) source_file="$FIXTURE_DIR/downloads.json" ;;
  *) source_file="$FIXTURE_DIR/go1.26.5.linux-amd64.tar.gz" ;;
esac
cp "$source_file" "$output"
STUB

  cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAIL_INSTALL_MOVE:-0}" == "1" && "${1:-}" == "mv" ]]; then
  destination="${@: -1}"
  source="${2:-}"
  if [[ "$destination" == "$INSTALL_DIR/go" && "$source" == */stage/go ]]; then
    exit 73
  fi
fi
"$@"
STUB

  chmod +x "$bin_dir/uname" "$bin_dir/curl" "$bin_dir/sudo"
}

run_case() {
  local name="$1"
  local mode="$2"
  local want_success="$3"
  local fixture_dir="$work_dir/$name"
  local install_dir="$fixture_dir/install"
  local home_dir="$fixture_dir/home"
  mkdir -p "$install_dir/go" "$home_dir"
  printf 'old installation\n' >"$install_dir/go/old-marker"
  printf 'go1.26.5\ntime 2026-07-29T00:00:00Z\n' >"$fixture_dir/version.txt"
  archive_fixture "$fixture_dir" "go1.26.5"

  case "$mode" in
    malformed-checksum)
      write_metadata "$fixture_dir/downloads.json" "not-a-checksum"
      ;;
    mismatched-checksum)
      write_metadata "$fixture_dir/downloads.json" "$(printf '%064d' 0)"
      ;;
    invalid-staged-go)
      archive_fixture "$fixture_dir" "go1.25.0"
      write_metadata "$fixture_dir/downloads.json" \
        "$(checksum_file "$fixture_dir/go1.26.5.linux-amd64.tar.gz")"
      ;;
    failed-final-move | success)
      write_metadata "$fixture_dir/downloads.json" \
        "$(checksum_file "$fixture_dir/go1.26.5.linux-amd64.tar.gz")"
      ;;
  esac

  write_command_stubs "$fixture_dir"
  local status=0
  FAIL_INSTALL_MOVE="$([[ "$mode" == "failed-final-move" ]] && printf 1 || printf 0)" \
    FIXTURE_DIR="$fixture_dir" INSTALL_DIR="$install_dir" PROFILE_HOME="$home_dir" \
    PATH="$fixture_dir/bin:$PATH" "$script" >"$fixture_dir/output" 2>&1 || status=$?

  if [[ "$want_success" == "1" ]]; then
    if [[ "$status" != "0" ]]; then
      echo "$name unexpectedly failed" >&2
      cat "$fixture_dir/output" >&2
      exit 1
    fi
    if [[ -e "$install_dir/go/old-marker" ]]; then
      echo "$name left the old installation active" >&2
      exit 1
    fi
    if [[ "$($install_dir/go/bin/go version)" != "go version go1.26.5 linux/amd64" ]]; then
      echo "$name installed an invalid Go binary" >&2
      exit 1
    fi
  else
    if [[ "$status" == "0" ]]; then
      echo "$name unexpectedly succeeded" >&2
      exit 1
    fi
    if [[ "$(cat "$install_dir/go/old-marker")" != "old installation" ]]; then
      echo "$name did not preserve the old installation" >&2
      cat "$fixture_dir/output" >&2
      exit 1
    fi
  fi

  if find "$install_dir" -maxdepth 1 -name 'go.backup.*' -print -quit | grep -q .; then
    echo "$name left a backup directory behind" >&2
    exit 1
  fi
}

run_case malformed-checksum malformed-checksum 0
run_case mismatched-checksum mismatched-checksum 0
run_case invalid-staged-go invalid-staged-go 0
run_case failed-final-move failed-final-move 0
run_case success success 1
