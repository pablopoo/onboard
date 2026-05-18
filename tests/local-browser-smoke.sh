#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

server_log="$(mktemp "${TMPDIR:-/tmp}/onboard-smoke.XXXXXX.log")"
server_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/onboard-server.XXXXXX")"
server_bin="$server_work_dir/onboard"
pw_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/onboard-pw.XXXXXX")"
server_pid=""
pwcli=""
pw_session_started=0
session="onboard-smoke-$$"

print_server_log() {
  if [[ -s "$server_log" ]]; then
    echo "Go server log:" >&2
    sed 's/^/  /' "$server_log" >&2
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e

  if [[ "$pw_session_started" == "1" && -n "$pwcli" ]]; then
    (cd "$pw_work_dir" && "$pwcli" --session "$session" close >/dev/null 2>&1)
  fi

  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill -TERM "$server_pid" >/dev/null 2>&1
    for _ in {1..20}; do
      if ! kill -0 "$server_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$server_pid" >/dev/null 2>&1; then
      kill -KILL "$server_pid" >/dev/null 2>&1
    fi
    wait "$server_pid" >/dev/null 2>&1
  fi

  if (( exit_code != 0 )); then
    print_server_log
  fi

  rm -f "$server_log"
  rm -rf "$server_work_dir"
  rm -rf "$pw_work_dir"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

find_playwright_cli() {
  if command -v playwright-cli >/dev/null 2>&1; then
    command -v playwright-cli
    return 0
  fi

  local wrapper="${CODEX_HOME:-$HOME/.codex}/skills/playwright/scripts/playwright_cli.sh"
  if [[ -x "$wrapper" ]]; then
    printf '%s\n' "$wrapper"
    return 0
  fi

  return 1
}

start_server() {
  GOCACHE=/tmp/onboard-go-build-cache /usr/local/go/bin/go build -o "$server_bin" ./cmd/onboard
  ONBOARD_ADDR=127.0.0.1:0 "$server_bin" >"$server_log" 2>&1 &
  server_pid=$!
}

run_playwright() {
  local output
  if ! output="$(cd "$pw_work_dir" && "$pwcli" --session "$session" "$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi

  if grep -F "### Error" <<<"$output" >/dev/null; then
    printf '%s\n' "$output" >&2
    return 1
  fi

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

wait_for_urls() {
  local deadline=$((SECONDS + 15))
  local board_url=""
  local viewer_url=""

  while (( SECONDS < deadline )); do
    board_url="$(sed -n 's/^Board:[[:space:]]*//p' "$server_log" | tail -n 1)"
    viewer_url="$(sed -n 's/^Viewer:[[:space:]]*//p' "$server_log" | tail -n 1)"

    if [[ -n "$board_url" && -n "$viewer_url" ]]; then
      printf '%s\n%s\n' "$board_url" "$viewer_url"
      return 0
    fi

    if [[ -n "$server_pid" ]] && ! kill -0 "$server_pid" >/dev/null 2>&1; then
      echo "Go server exited before printing Board and Viewer URLs." >&2
      return 1
    fi

    sleep 0.1
  done

  echo "Timed out waiting for Board and Viewer URLs." >&2
  return 1
}

read -r -d '' CHECK_JS <<'JS' || true
async page => {
const boardUrl = "__ONBOARD_BOARD_URL__";
const viewerUrl = "__ONBOARD_VIEWER_URL__";

if (!boardUrl || !viewerUrl) {
  throw new Error("Board and Viewer URLs must be provided in the environment.");
}

await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));

async function checkWithoutConsoleErrors(label, fn) {
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === "error") {
      errors.push(`console error: ${message.text()}`);
    }
  };
  const onPageError = (error) => {
    errors.push(`page error: ${error.message}`);
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  try {
    await fn();
    await page.waitForTimeout(500);
    if (errors.length > 0) {
      throw new Error(`${label} emitted errors:\n${errors.join("\n")}`);
    }
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

function formatSize(width, height) {
  return `${Math.round(width)}x${Math.round(height)}`;
}

await checkWithoutConsoleErrors("Board", async () => {
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 5000 });

  const result = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    const requiredControls = [
      "surface",
      "pen",
      "eraser",
      "pointer",
      "ephemeral",
      "clear",
    ];

    return {
      hasCanvas: Boolean(canvas),
      canvasWidth: rect?.width ?? 0,
      canvasHeight: rect?.height ?? 0,
      hasToolbar: Boolean(
        document.querySelector(
          ".toolbar, [role='toolbar'], [aria-label='Presenter controls']",
        ),
      ),
      missingControls: requiredControls.filter(
        (control) => !document.querySelector(`[data-board-control="${control}"]`),
      ),
    };
  });

  if (!result.hasCanvas) {
    throw new Error("Board is missing a canvas.");
  }
  if (result.canvasWidth <= 0 || result.canvasHeight <= 0) {
    throw new Error(
      `Board canvas is not visible: ${formatSize(result.canvasWidth, result.canvasHeight)}.`,
    );
  }
  if (!result.hasToolbar) {
    throw new Error("Board is missing presenter toolbar markup.");
  }
  if (result.missingControls.length > 0) {
    throw new Error(`Board is missing controls: ${result.missingControls.join(", ")}.`);
  }
});

await checkWithoutConsoleErrors("Viewer", async () => {
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const status = document.querySelector("[data-viewer-status]")?.textContent?.trim();
      return status === "Connected";
    },
    { timeout: 5000 },
  );

  const result = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    const forbiddenSelectors = [
      "[data-board-control]",
      "button",
      "select",
      "input",
      ".toolbar",
      "[role='toolbar']",
      "[aria-label='Presenter controls']",
    ];
    const forbidden = forbiddenSelectors
      .map((selector) => ({
        selector,
        count: document.querySelectorAll(selector).length,
      }))
      .filter((entry) => entry.count > 0);

    return {
      hasCanvas: Boolean(canvas),
      canvasWidth: rect?.width ?? 0,
      canvasHeight: rect?.height ?? 0,
      forbidden,
      status: document.querySelector("[data-viewer-status]")?.textContent?.trim() ?? "",
    };
  });

  if (!result.hasCanvas) {
    throw new Error("Viewer is missing a canvas.");
  }
  if (result.canvasWidth <= 0 || result.canvasHeight <= 0) {
    throw new Error(
      `Viewer canvas is not visible: ${formatSize(result.canvasWidth, result.canvasHeight)}.`,
    );
  }
  if (result.forbidden.length > 0) {
    throw new Error(
      `Viewer contains presenter controls: ${result.forbidden
        .map((entry) => `${entry.selector}=${entry.count}`)
        .join(", ")}.`,
    );
  }
  if (result.status !== "Connected") {
    throw new Error(`Viewer did not connect to the local relay. Status: ${result.status}`);
  }
});

}
JS

pwcli="$(find_playwright_cli || true)"
if [[ -z "$pwcli" ]]; then
  echo "playwright-cli was not found, and the bundled wrapper is unavailable." >&2
  echo "Install playwright-cli or ensure \$HOME/.codex/skills/playwright/scripts/playwright_cli.sh exists." >&2
  exit 1
fi

echo "Starting Onboard local server..."
start_server
urls_output="$(wait_for_urls)"
mapfile -t urls <<<"$urls_output"
if (( ${#urls[@]} < 2 )); then
  echo "Failed to parse Board and Viewer URLs from server output." >&2
  print_server_log
  exit 1
fi
board_url="${urls[0]}"
viewer_url="${urls[1]}"

echo "Board URL:  $board_url"
echo "Viewer URL: $viewer_url"
echo "Playwright: $pwcli"

pw_session_started=1
run_playwright open about:blank >/dev/null
check_js="${CHECK_JS//__ONBOARD_BOARD_URL__/$board_url}"
check_js="${check_js//__ONBOARD_VIEWER_URL__/$viewer_url}"
run_playwright run-code "$check_js"

echo "Board smoke OK:  $board_url"
echo "Viewer smoke OK: $viewer_url"
echo "Local browser smoke checks passed."
