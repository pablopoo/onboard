#!/usr/bin/env bash
set -euo pipefail

script="scripts/install-go-latest.sh"

if [[ ! -f "$script" ]]; then
  echo "expected $script to exist" >&2
  exit 1
fi

if [[ ! -x "$script" ]]; then
  echo "expected $script to be executable" >&2
  exit 1
fi

bash -n "$script"

grep -Fq "https://go.dev/VERSION?m=text" "$script"
grep -Fq 'archive="$version.linux-$arch.tar.gz"' "$script"
grep -Fq "/usr/local/go/bin" "$script"
grep -Fq "go version" "$script"
