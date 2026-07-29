#!/usr/bin/env bash
set -euo pipefail

install_dir="${INSTALL_DIR:-/usr/local}"
go_root="$install_dir/go"
profile_home="${PROFILE_HOME:-$HOME}"
tmp_dir="$(mktemp -d)"
backup_root="${go_root}.backup.$$"
backup_created=0
replacement_started=0
install_committed=0

cleanup() {
  if [[ "$replacement_started" == "1" && "$install_committed" != "1" ]]; then
    sudo rm -rf "$go_root"
    if [[ "$backup_created" == "1" ]]; then
      sudo mv "$backup_root" "$go_root"
    fi
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64)
      echo "amd64"
      ;;
    aarch64 | arm64)
      echo "arm64"
      ;;
    i386 | i686)
      echo "386"
      ;;
    armv6l | armv7l)
      echo "armv6l"
      ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

fetch() {
  local url="$1"
  local output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output"
    return
  fi

  echo "missing required command: curl or wget" >&2
  exit 1
}

need_cmd tar
need_cmd sudo

os="$(uname -s)"
if [[ "$os" != "Linux" ]]; then
  echo "this installer currently supports Linux only; detected: $os" >&2
  exit 1
fi

arch="$(detect_arch)"
version_file="$tmp_dir/go-version.txt"

fetch "https://go.dev/VERSION?m=text" "$version_file"
version="$(head -n 1 "$version_file")"

if [[ ! "$version" =~ ^go[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "unexpected Go version response: $version" >&2
  exit 1
fi

archive="$version.linux-$arch.tar.gz"
url="https://go.dev/dl/$archive"
tarball="$tmp_dir/$archive"
checksum_file="$tmp_dir/$archive.sha256"

echo "Downloading $url"
fetch "$url" "$tarball"
fetch "$url.sha256" "$checksum_file"

checksum="$(tr -d '[:space:]' <"$checksum_file")"
if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ ]]; then
  echo "unexpected checksum response for $archive" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$checksum" "$tarball" | sha256sum -c - >/dev/null
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$tarball" | awk '{print $1}')"
  if [[ "$actual_checksum" != "$checksum" ]]; then
    echo "$archive checksum mismatch" >&2
    exit 1
  fi
else
  echo "missing required command: sha256sum or shasum" >&2
  exit 1
fi

stage_dir="$tmp_dir/stage"
mkdir -p "$stage_dir"
tar -C "$stage_dir" -xzf "$tarball"
staged_go="$stage_dir/go/bin/go"
if [[ ! -x "$staged_go" ]]; then
  echo "archive does not contain an executable go/bin/go" >&2
  exit 1
fi
if ! "$staged_go" version | grep -Fq "go version $version linux/$arch"; then
  echo "staged Go binary does not report $version linux/$arch" >&2
  exit 1
fi

echo "Installing $version to $go_root"
if sudo test -e "$backup_root"; then
  echo "backup path already exists: $backup_root" >&2
  exit 1
fi
if sudo test -e "$go_root"; then
  sudo mv "$go_root" "$backup_root"
  backup_created=1
fi
replacement_started=1
sudo mv "$stage_dir/go" "$go_root"

if ! sudo "$go_root/bin/go" version | grep -Fq "go version $version linux/$arch"; then
  echo "installed Go binary failed final version validation" >&2
  exit 1
fi

install_committed=1
if [[ "$backup_created" == "1" ]]; then
  sudo rm -rf "$backup_root"
  backup_created=0
fi

if [[ ":$PATH:" != *":$go_root/bin:"* ]]; then
  shell_profile="$profile_home/.profile"
  path_line="export PATH=\$PATH:$go_root/bin"

  if [[ -f "$profile_home/.bashrc" ]]; then
    shell_profile="$profile_home/.bashrc"
  fi

  if ! grep -Fq "$go_root/bin" "$shell_profile" 2>/dev/null; then
    echo "$path_line" >> "$shell_profile"
    echo "Added /usr/local/go/bin to $shell_profile"
  fi

  export PATH="$PATH:$go_root/bin"
fi

echo "Installed:"
"$go_root/bin/go" version

echo
echo "If your current shell cannot find go later, restart the terminal or run:"
echo "  export PATH=\$PATH:/usr/local/go/bin"
