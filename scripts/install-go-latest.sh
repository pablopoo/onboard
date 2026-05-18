#!/usr/bin/env bash
set -euo pipefail

install_dir="/usr/local"
go_root="$install_dir/go"
tmp_dir="$(mktemp -d)"

cleanup() {
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

echo "Downloading $url"
fetch "$url" "$tarball"

echo "Installing $version to $go_root"
sudo rm -rf "$go_root"
sudo tar -C "$install_dir" -xzf "$tarball"

if [[ ":$PATH:" != *":$go_root/bin:"* ]]; then
  shell_profile="$HOME/.profile"
  path_line='export PATH=$PATH:/usr/local/go/bin'

  if [[ -f "$HOME/.bashrc" ]]; then
    shell_profile="$HOME/.bashrc"
  fi

  if ! grep -Fq "/usr/local/go/bin" "$shell_profile" 2>/dev/null; then
    echo "$path_line" >> "$shell_profile"
    echo "Added /usr/local/go/bin to $shell_profile"
  fi

  export PATH="$PATH:$go_root/bin"
fi

echo "Installed:"
go version

echo
echo "If your current shell cannot find go later, restart the terminal or run:"
echo "  export PATH=\$PATH:/usr/local/go/bin"

