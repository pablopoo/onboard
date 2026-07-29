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
const homeUrl = boardUrl.replace(/\/board(?:[?#].*)?$/, "/");

if (!boardUrl || !viewerUrl) {
  throw new Error("Board and Viewer URLs must be provided in the environment.");
}
if (viewerUrl.includes("presenter=")) {
  throw new Error("Viewer URL leaked the presenter capability.");
}

await page.context().route("**/favicon.ico", (route) =>
  route.fulfill({ status: 204, body: "" }),
);

async function createBrowserContext(options = {}) {
  const browser = page.context().browser();
  if (!browser) {
    throw new Error("Browser object is unavailable for isolated context checks.");
  }

  const context = await browser.newContext(options);
  await context.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  return context;
}

async function checkPageWithoutConsoleErrors(targetPage, label, fn) {
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === "error") {
      errors.push(`console error: ${message.text()}`);
    }
  };
  const onPageError = (error) => {
    errors.push(`page error: ${error.message}`);
  };

  targetPage.on("console", onConsole);
  targetPage.on("pageerror", onPageError);

  try {
    await fn();
    await targetPage.waitForTimeout(500);
    if (errors.length > 0) {
      throw new Error(`${label} emitted errors:\n${errors.join("\n")}`);
    }
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`);
  } finally {
    targetPage.off("console", onConsole);
    targetPage.off("pageerror", onPageError);
  }
}

async function checkWithoutConsoleErrors(label, fn) {
  return checkPageWithoutConsoleErrors(page, label, fn);
}

function formatSize(width, height) {
  return `${Math.round(width)}x${Math.round(height)}`;
}

function countDarkInkPixelsInCanvas() {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    return 0;
  }

  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let pixels = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha > 0 && red < 90 && green < 100 && blue < 120) {
      pixels += 1;
    }
  }

  return pixels;
}

function darkInkBoundsInCanvas() {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    return null;
  }

  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minY = canvas.height;
  let maxY = -1;

  for (let index = 0; index < data.length; index += 4) {
    if (
      data[index + 3] > 0 &&
      data[index] < 90 &&
      data[index + 1] < 100 &&
      data[index + 2] < 120
    ) {
      const pixelIndex = index / 4;
      const y = Math.floor(pixelIndex / canvas.width);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxY < minY) {
    return null;
  }
  const rect = canvas.getBoundingClientRect();
  return {
    cssThickness: ((maxY - minY + 1) * rect.height) / canvas.height,
  };
}

function countPointerPixelsInCanvas() {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    return 0;
  }

  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let pixels = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha > 0 && red > 180 && green > 100 && green < 210 && blue < 120) {
      pixels += 1;
    }
  }

  return pixels;
}

function canvasCenterColor() {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    return null;
  }

  const ctx = canvas.getContext("2d");
  const x = Math.floor(canvas.width / 2);
  const y = Math.floor(canvas.height / 2);
  const [red, green, blue, alpha] = ctx.getImageData(x, y, 1, 1).data;
  return { red, green, blue, alpha };
}

async function darkInkPixels(targetPage) {
  return targetPage.evaluate(countDarkInkPixelsInCanvas);
}

async function darkInkThickness(targetPage) {
  return targetPage.evaluate(darkInkBoundsInCanvas);
}

async function pointerPixels(targetPage) {
  return targetPage.evaluate(countPointerPixelsInCanvas);
}

async function centerColor(targetPage) {
  return targetPage.evaluate(canvasCenterColor);
}

async function canvasBackstore(targetPage, selector) {
  return targetPage.evaluate((canvasSelector) => {
    const canvas = document.querySelector(canvasSelector);
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return null;
    }

    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      width: canvas.width,
      height: canvas.height,
      ratio: devicePixelRatio,
    };
  }, selector);
}

function isColorNear(actual, expected, tolerance = 8) {
  return (
    actual &&
    Math.abs(actual.red - expected.red) <= tolerance &&
    Math.abs(actual.green - expected.green) <= tolerance &&
    Math.abs(actual.blue - expected.blue) <= tolerance &&
    Math.abs(actual.alpha - expected.alpha) <= tolerance
  );
}

async function waitForCanvasBackstoreToMatchDisplay(
  targetPage,
  selector,
  label,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await canvasBackstore(targetPage, selector);

  while (Date.now() < deadline) {
    if (latest) {
      const expectedWidth = Math.round(latest.cssWidth * latest.ratio);
      const expectedHeight = Math.round(latest.cssHeight * latest.ratio);
      if (
        latest.ratio > 1 &&
        latest.width === expectedWidth &&
        latest.height === expectedHeight
      ) {
        return latest;
      }
    }

    await targetPage.waitForTimeout(100);
    latest = await canvasBackstore(targetPage, selector);
  }

  throw new Error(
    `${label} canvas backing store does not match display size: ` +
      `latest=${JSON.stringify(latest)}.`,
  );
}

async function waitForCenterColorNear(
  targetPage,
  expected,
  label,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await centerColor(targetPage);

  while (Date.now() < deadline) {
    if (isColorNear(latest, expected)) {
      return latest;
    }

    await targetPage.waitForTimeout(100);
    latest = await centerColor(targetPage);
  }

  throw new Error(
    `Canvas center color did not become ${label}: ` +
      `latest=${JSON.stringify(latest)}, expected=${JSON.stringify(expected)}.`,
  );
}

async function waitForDarkInkPixelsAbove(
  targetPage,
  beforePixels,
  minimumDelta = 50,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let latestPixels = await darkInkPixels(targetPage);

  while (Date.now() < deadline) {
    if (latestPixels > beforePixels + minimumDelta) {
      return latestPixels;
    }

    await targetPage.waitForTimeout(100);
    latestPixels = await darkInkPixels(targetPage);
  }

  throw new Error(
    `Canvas did not gain enough ink pixels: before=${beforePixels}, ` +
      `latest=${latestPixels}, required>${beforePixels + minimumDelta}.`,
  );
}

async function waitForPointerPixelsAbove(
  targetPage,
  beforePixels,
  minimumDelta = 50,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let latestPixels = await pointerPixels(targetPage);

  while (Date.now() < deadline) {
    if (latestPixels > beforePixels + minimumDelta) {
      return latestPixels;
    }

    await targetPage.waitForTimeout(100);
    latestPixels = await pointerPixels(targetPage);
  }

  throw new Error(
    `Canvas did not gain enough pointer pixels: before=${beforePixels}, ` +
      `latest=${latestPixels}, required>${beforePixels + minimumDelta}.`,
  );
}

async function waitForPointerPixelsAtMost(
  targetPage,
  maximumPixels,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let latestPixels = await pointerPixels(targetPage);

  while (Date.now() < deadline) {
    if (latestPixels <= maximumPixels) {
      return latestPixels;
    }

    await targetPage.waitForTimeout(100);
    latestPixels = await pointerPixels(targetPage);
  }

  throw new Error(
    `Canvas still has too many pointer pixels: latest=${latestPixels}, ` +
      `maximum=${maximumPixels}.`,
  );
}

async function waitForDarkInkPixelsAtMost(
  targetPage,
  maximumPixels,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let latestPixels = await darkInkPixels(targetPage);

  while (Date.now() < deadline) {
    if (latestPixels <= maximumPixels) {
      return latestPixels;
    }

    await targetPage.waitForTimeout(100);
    latestPixels = await darkInkPixels(targetPage);
  }

  throw new Error(
    `Canvas still has too many ink pixels: latest=${latestPixels}, ` +
      `maximum=${maximumPixels}.`,
  );
}

async function drawHorizontalBoardStroke(targetPage, yRatio = 0.5) {
  const boardCanvas = await targetPage.locator("[data-board-canvas]").boundingBox();
  if (!boardCanvas) {
    throw new Error("Board canvas box is unavailable for drawing.");
  }

  const startX = boardCanvas.x + boardCanvas.width * 0.35;
  const endX = boardCanvas.x + boardCanvas.width * 0.65;
  const y = boardCanvas.y + boardCanvas.height * yRatio;

  await targetPage.click('[data-board-control="pen"]');
  await targetPage.mouse.move(startX, y);
  await targetPage.mouse.down();
  await targetPage.mouse.move(endX, y, { steps: 24 });
  await targetPage.mouse.up();
}

async function drawRawBoardCanvasStroke(targetPage, yRatio = 0.5) {
  const boardCanvas = await targetPage.locator("[data-board-canvas]").boundingBox();
  if (!boardCanvas) {
    throw new Error("Board canvas box is unavailable for raw drawing.");
  }

  const startX = boardCanvas.x + boardCanvas.width * 0.35;
  const endX = boardCanvas.x + boardCanvas.width * 0.65;
  const y = boardCanvas.y + boardCanvas.height * yRatio;

  await targetPage.mouse.move(startX, y);
  await targetPage.mouse.down();
  await targetPage.mouse.move(endX, y, { steps: 24 });
  await targetPage.mouse.up();
}

async function eraseHorizontalBoardStroke(targetPage, yRatio = 0.5) {
  const boardCanvas = await targetPage.locator("[data-board-canvas]").boundingBox();
  if (!boardCanvas) {
    throw new Error("Board canvas box is unavailable for erasing.");
  }

  const startX = boardCanvas.x + boardCanvas.width * 0.32;
  const endX = boardCanvas.x + boardCanvas.width * 0.68;
  const y = boardCanvas.y + boardCanvas.height * yRatio;

  await targetPage.click('[data-board-control="eraser"]');
  await targetPage.mouse.move(startX, y);
  await targetPage.mouse.down();
  await targetPage.mouse.move(endX, y, { steps: 24 });
  await targetPage.mouse.up();
}

async function setBoardSurface(targetPage, surface) {
  await targetPage.selectOption('[data-board-control="surface"]', surface);
}

async function showPointerOnBoard(targetPage) {
  const boardCanvas = await targetPage.locator("[data-board-canvas]").boundingBox();
  if (!boardCanvas) {
    throw new Error("Board canvas box is unavailable for pointer mode.");
  }

  const x = boardCanvas.x + boardCanvas.width * 0.58;
  const y = boardCanvas.y + boardCanvas.height * 0.42;

  await targetPage.click('[data-board-control="pointer"]');
  await targetPage.mouse.move(x, y);
  await targetPage.mouse.down();
}

async function expandToolbarIfCompactCollapsed(targetPage) {
  const shouldExpand = await targetPage.evaluate(() => {
    const root = document.querySelector("#board-app");
    const toggle = document.querySelector('[data-board-control="toolbar-toggle"]');
    return Boolean(
      root &&
        toggle &&
        matchMedia("(max-width: 640px)").matches &&
        root.classList.contains("is-toolbar-collapsed"),
    );
  });

  if (!shouldExpand) {
    return;
  }

  await targetPage.click('[data-board-control="toolbar-toggle"]');
  await targetPage.waitForFunction(
    () => !document.querySelector("#board-app")?.classList.contains("is-toolbar-collapsed"),
  );
}

async function collapseToolbarIfCompactExpanded(targetPage) {
  const shouldCollapse = await targetPage.evaluate(() => {
    const root = document.querySelector("#board-app");
    const close = document.querySelector('[data-board-control="toolbar-close"]');
    return Boolean(
      root &&
        close &&
        matchMedia("(max-width: 640px)").matches &&
        !root.classList.contains("is-toolbar-collapsed"),
    );
  });

  if (!shouldCollapse) {
    return;
  }

  await targetPage.click('[data-board-control="toolbar-close"]');
  await targetPage.waitForFunction(() =>
    document.querySelector("#board-app")?.classList.contains("is-toolbar-collapsed"),
  );
}

async function setEphemeralInk(targetPage, enabled) {
  await expandToolbarIfCompactCollapsed(targetPage);
  await targetPage.click('[data-board-control="pen"]');

  const ephemeral = targetPage.locator('[data-board-control="ephemeral"]');
  if ((await ephemeral.isChecked()) !== enabled) {
    await targetPage
      .locator('label:has([data-board-control="ephemeral"])')
      .click();
  }
  await collapseToolbarIfCompactExpanded(targetPage);
}

async function enableEphemeralInk(targetPage) {
  await setEphemeralInk(targetPage, true);
}

async function disableEphemeralInk(targetPage) {
  await setEphemeralInk(targetPage, false);
}

async function clearBoardCanvas(targetPage) {
  await expandToolbarIfCompactCollapsed(targetPage);
  await targetPage.click('[data-board-control="clear"]');
  await targetPage.click('[data-board-control="clear"]');
  await waitForDarkInkPixelsAtMost(targetPage, 10);
  await collapseToolbarIfCompactExpanded(targetPage);
}

async function installRelaySocketProbe(targetPage) {
  await targetPage.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const relaySockets = [];

    function isRelayURL(url) {
      return String(url).includes("/ws/relay");
    }

    function trackRelaySocket(socket, url) {
      const entry = {
        socket,
        url: String(url),
        opened: false,
        closed: false,
        sent: 0,
      };
      relaySockets.push(entry);

      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        entry.sent += 1;
        return nativeSend(data);
      };

      socket.addEventListener("open", () => {
        entry.opened = true;
      });
      socket.addEventListener("close", () => {
        entry.closed = true;
      });
    }

    function ProbedWebSocket(url, protocols) {
      const socket =
        protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);

      if (isRelayURL(url)) {
        trackRelaySocket(socket, url);
      }

      return socket;
    }

    Object.setPrototypeOf(ProbedWebSocket, NativeWebSocket);
    ProbedWebSocket.prototype = NativeWebSocket.prototype;
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(ProbedWebSocket, name, {
        configurable: true,
        enumerable: true,
        value: NativeWebSocket[name],
      });
    }

    window.WebSocket = ProbedWebSocket;
    window.__onboardRelaySocketProbe = {
      closeOpenSockets() {
        let closed = 0;
        for (const entry of relaySockets) {
          if (entry.socket.readyState === NativeWebSocket.OPEN) {
            entry.socket.close(4000, "smoke reconnect");
            closed += 1;
          }
        }
        return closed;
      },
      totalCount() {
        return relaySockets.length;
      },
      openCount() {
        return relaySockets.filter(
          (entry) =>
            entry.opened &&
            !entry.closed &&
            entry.socket.readyState === NativeWebSocket.OPEN,
        ).length;
      },
      closedCount() {
        return relaySockets.filter((entry) => entry.closed).length;
      },
      sentCount() {
        return relaySockets.reduce((total, entry) => total + entry.sent, 0);
      },
    };
  });
}

await checkWithoutConsoleErrors("Home share links", async () => {
  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-share-list] .share-row", { timeout: 5000 });

  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-share-list] .share-row")];
    return {
      rows: rows.length,
      copyButtons: rows.filter((row) => row.querySelector("button")).length,
      qrCodes: rows.filter((row) => {
        const qr = row.querySelector(".share-qr");
        const path = qr?.querySelector("path");
        return (
          qr?.getAttribute("role") === "img" &&
          qr?.getAttribute("aria-label")?.startsWith("QR code for ") &&
          path?.getAttribute("d")?.includes("M")
        );
      }).length,
    };
  });

  if (result.rows < 2) {
    throw new Error(`Home share list has ${result.rows} rows, want at least Board and Viewer.`);
  }
  if (result.copyButtons !== result.rows) {
    throw new Error(`Home share list has ${result.copyButtons} copy buttons for ${result.rows} rows.`);
  }
  if (result.qrCodes !== result.rows) {
    throw new Error(`Home share list has ${result.qrCodes} QR codes for ${result.rows} rows.`);
  }
});

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
      "more",
      "copy-viewer",
      "background-file",
      "background-upload",
      "background-capture",
      "background-remove",
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
      hasViewerShareLink: Boolean(document.querySelector("[data-board-share-link]")),
      hasViewerShareInput: Boolean(document.querySelector("[data-board-share-input]")),
      hasViewerShareQR: Boolean(
        document.querySelector("[data-board-share-qr] .board-share-qr path[d*='M']"),
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
  if (!result.hasViewerShareLink || !result.hasViewerShareInput || !result.hasViewerShareQR) {
    throw new Error("Board is missing the Viewer share link panel.");
  }
});

await checkWithoutConsoleErrors("Wrong presenter capability is rejected", async () => {
  const wrongContext = await createBrowserContext({
    viewport: { width: 1000, height: 700 },
  });
  const wrongBoardPage = await wrongContext.newPage();
  try {
    const wrongBoardUrl = boardUrl.replace(
      /#presenter=[^&]*/,
      `#presenter=${"Z".repeat(43)}`,
    );
    await wrongBoardPage.goto(wrongBoardUrl, { waitUntil: "domcontentloaded" });
    await wrongBoardPage.waitForFunction(
      () =>
        document
          .querySelector("[data-board-session]")
          ?.textContent?.includes("Presenter link required"),
      undefined,
      { timeout: 5000 },
    );
    const enabledPresenterControls = await wrongBoardPage.evaluate(() => {
      const names = [
        "surface",
        "pen",
        "eraser",
        "pointer",
        "ephemeral",
        "tip-size",
        "eraser-size",
        "clear",
        "quick-undo",
        "toolbar-toggle",
        "background-file",
        "background-upload",
        "background-capture",
        "background-remove",
      ];
      return names.filter(
        (name) =>
          document.querySelector(`[data-board-control="${name}"]`)?.disabled !==
          true,
      );
    });
    if (enabledPresenterControls.length > 0) {
      throw new Error(
        `Wrong capability left presenter controls enabled: ` +
          enabledPresenterControls.join(", "),
      );
    }
  } finally {
    await wrongContext.close();
  }
});

await checkWithoutConsoleErrors("Mobile board toolbar", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 5000 });
  await page.waitForFunction(() => {
    const toggle = document.querySelector('[data-board-control="toolbar-toggle"]');
    return toggle && getComputedStyle(toggle).display !== "none";
  });

  const collapsed = await page.evaluate(() => {
    const root = document.querySelector("#board-app");
    const toggle = document.querySelector('[data-board-control="toolbar-toggle"]');
    const dock = document.querySelector(".mobile-toolbar-dock");
    const toolbar = document.querySelector("#presenter-toolbar");
    const dockRect = dock?.getBoundingClientRect();

    return {
      compactMedia: matchMedia("(max-width: 640px)").matches,
      collapsed: root?.classList.contains("is-toolbar-collapsed") ?? false,
      expanded: toggle?.getAttribute("aria-expanded") ?? "",
      dockVisible:
        Boolean(dock) &&
        getComputedStyle(dock).display !== "none" &&
        (dockRect?.width ?? 0) > 0 &&
        (dockRect?.height ?? 0) > 0,
      toolbarIgnoresPointer:
        Boolean(toolbar) && getComputedStyle(toolbar).pointerEvents === "none",
      toolbarInert: toolbar?.inert === true,
      toolbarAriaHidden: toolbar?.getAttribute("aria-hidden") === "true",
    };
  });

  if (!collapsed.compactMedia) {
    throw new Error("Mobile board did not match the compact viewport media query.");
  }
  if (!collapsed.collapsed || collapsed.expanded !== "false") {
    throw new Error("Mobile board toolbar did not start collapsed.");
  }
  if (!collapsed.dockVisible) {
    throw new Error("Mobile board dock is not visible while toolbar is collapsed.");
  }
  if (!collapsed.toolbarIgnoresPointer) {
    throw new Error("Collapsed mobile toolbar should not intercept canvas input.");
  }
  if (!collapsed.toolbarInert || !collapsed.toolbarAriaHidden) {
    throw new Error("Collapsed mobile toolbar remains exposed to keyboard focus.");
  }

  await page.click('[data-board-control="toolbar-toggle"]');
  await page.waitForFunction(
    () => !document.querySelector("#board-app")?.classList.contains("is-toolbar-collapsed"),
  );
  await page.waitForFunction(() => {
    const toolbar = document.querySelector("#presenter-toolbar");
    const rect = toolbar?.getBoundingClientRect();
    return (
      rect &&
      rect.left >= 0 &&
      rect.right <= innerWidth &&
      rect.bottom <= innerHeight
    );
  });

  const expanded = await page.evaluate(() => {
    const toolbar = document.querySelector("#presenter-toolbar");
    const close = document.querySelector('[data-board-control="toolbar-close"]');
    const rect = toolbar?.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();

    return {
      expanded:
        document
          .querySelector('[data-board-control="toolbar-toggle"]')
          ?.getAttribute("aria-expanded") ?? "",
      closeVisible:
        Boolean(close) &&
        getComputedStyle(close).display !== "none" &&
        (closeRect?.width ?? 0) > 0 &&
        (closeRect?.height ?? 0) > 0,
      left: rect?.left ?? -1,
      right: rect?.right ?? Number.POSITIVE_INFINITY,
      bottom: rect?.bottom ?? Number.POSITIVE_INFINITY,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });

  if (expanded.expanded !== "true") {
    throw new Error("Mobile board toolbar did not report expanded state.");
  }
  if (!expanded.closeVisible) {
    throw new Error("Expanded mobile toolbar is missing a visible minimize control.");
  }
  if (
    expanded.left < 0 ||
    expanded.right > expanded.viewportWidth ||
    expanded.bottom > expanded.viewportHeight
  ) {
    throw new Error(
      `Expanded mobile toolbar overflows viewport: left=${expanded.left}, ` +
        `right=${expanded.right}/${expanded.viewportWidth}, ` +
        `bottom=${expanded.bottom}/${expanded.viewportHeight}.`,
    );
  }

  await page.focus('[data-board-control="pen"]');
  await page.click('[data-board-control="toolbar-close"]');
  await page.waitForFunction(() =>
    document.querySelector("#board-app")?.classList.contains("is-toolbar-collapsed"),
  );

  const minimized = await page.evaluate(() => ({
    expanded:
      document
        .querySelector('[data-board-control="toolbar-toggle"]')
        ?.getAttribute("aria-expanded") ?? "",
    focusReturned:
      document.activeElement ===
      document.querySelector('[data-board-control="toolbar-toggle"]'),
  }));
  if (minimized.expanded !== "false") {
    throw new Error("Mobile board minimize control did not collapse the toolbar.");
  }
  if (!minimized.focusReturned) {
    throw new Error("Mobile board did not return focus to the toolbar toggle.");
  }
});

await checkWithoutConsoleErrors("Mobile board drawing sync", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await page.waitForFunction(() =>
    document.querySelector("#board-app")?.classList.contains("is-toolbar-collapsed"),
  );

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Mobile board relay viewer", async () => {
      await viewerPage.setViewportSize({ width: 390, height: 844 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const beforePixels = await darkInkPixels(viewerPage);
      await drawRawBoardCanvasStroke(page, 0.35);
      await waitForDarkInkPixelsAbove(viewerPage, beforePixels);
    });
  } finally {
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Mobile second pointer preserves owned stroke", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);

  const viewerPage = await page.context().newPage();
  try {
    await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
    await viewerPage.waitForFunction(
      () =>
        document.querySelector("[data-viewer-status]")?.dataset
          ?.viewerConnection === "Connected",
      undefined,
      { timeout: 5000 },
    );
    const beforePixels = await darkInkPixels(viewerPage);
    await page.evaluate(() => {
      const canvas = document.querySelector("[data-board-canvas]");
      const rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      const dispatch = (type, pointerId, xRatio) => {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId,
            pointerType: "touch",
            clientX: rect.left + rect.width * xRatio,
            clientY: rect.top + rect.height * 0.44,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      };
      dispatch("pointerdown", 1, 0.25);
      dispatch("pointermove", 1, 0.4);
      dispatch("pointerdown", 2, 0.55);
      dispatch("pointerup", 2, 0.55);
      dispatch("pointermove", 1, 0.7);
      dispatch("pointerup", 1, 0.75);
    });
    await waitForDarkInkPixelsAbove(viewerPage, beforePixels);
  } finally {
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("High DPR resize drawing sync", async () => {
  await page.goto("about:blank");
  await page.waitForTimeout(200);

  const highDPRContext = await createBrowserContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
  });
  const boardPage = await highDPRContext.newPage();
  const viewerPage = await highDPRContext.newPage();
  const standardDPRContext = await createBrowserContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 1,
  });
  const standardViewerPage = await standardDPRContext.newPage();

  try {
    await checkPageWithoutConsoleErrors(boardPage, "High DPR relay board", async () => {
      await checkPageWithoutConsoleErrors(
        viewerPage,
        "High DPR relay viewer",
        async () => {
          await boardPage.goto(boardUrl, { waitUntil: "domcontentloaded" });
          await boardPage.waitForSelector("[data-board-canvas]", { timeout: 5000 });
          await clearBoardCanvas(boardPage);
          await disableEphemeralInk(boardPage);

          await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
          await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
          await viewerPage.waitForFunction(
            () =>
              document.querySelector("[data-viewer-status]")?.dataset
                ?.viewerConnection === "Connected",
            undefined,
            { timeout: 5000 },
          );
          await standardViewerPage.goto(viewerUrl, {
            waitUntil: "domcontentloaded",
          });
          await standardViewerPage.waitForFunction(
            () =>
              document.querySelector("[data-viewer-status]")?.dataset
                ?.viewerConnection === "Connected",
            undefined,
            { timeout: 5000 },
          );

          await waitForCanvasBackstoreToMatchDisplay(
            boardPage,
            "[data-board-canvas]",
            "High DPR board",
          );
          await waitForCanvasBackstoreToMatchDisplay(
            viewerPage,
            "[data-viewer-canvas]",
            "High DPR viewer",
          );

          const phoneBeforePixels = await darkInkPixels(viewerPage);
          await drawRawBoardCanvasStroke(boardPage, 0.42);
          await waitForDarkInkPixelsAbove(viewerPage, phoneBeforePixels);
          await waitForDarkInkPixelsAbove(standardViewerPage, 0);
          const highDPRThickness = await darkInkThickness(viewerPage);
          const standardDPRThickness = await darkInkThickness(standardViewerPage);
          if (
            !highDPRThickness ||
            !standardDPRThickness ||
            Math.abs(
              highDPRThickness.cssThickness - standardDPRThickness.cssThickness,
            ) > 2
          ) {
            throw new Error(
              "Marker apparent width differs across DPR 1/2: " +
                `${JSON.stringify(standardDPRThickness)} vs ` +
                `${JSON.stringify(highDPRThickness)}.`,
            );
          }

          await clearBoardCanvas(boardPage);
          await waitForDarkInkPixelsAtMost(viewerPage, phoneBeforePixels + 10);

          await boardPage.setViewportSize({ width: 1024, height: 768 });
          await viewerPage.setViewportSize({ width: 1024, height: 768 });
          await waitForCanvasBackstoreToMatchDisplay(
            boardPage,
            "[data-board-canvas]",
            "Resized high DPR board",
          );
          await waitForCanvasBackstoreToMatchDisplay(
            viewerPage,
            "[data-viewer-canvas]",
            "Resized high DPR viewer",
          );

          const tabletBeforePixels = await darkInkPixels(viewerPage);
          await drawHorizontalBoardStroke(boardPage, 0.58);
          await waitForDarkInkPixelsAbove(viewerPage, tabletBeforePixels);
        },
      );
    });
  } finally {
    await highDPRContext.close();
    await standardDPRContext.close();
  }
});

await checkWithoutConsoleErrors("Image background upload sync", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Image background viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90">',
        '<rect width="160" height="90" fill="#ff0000"/>',
        '</svg>',
      ].join("");
      await page.evaluate((contents) => {
        const input = document.querySelector('[data-board-control="background-file"]');
        const file = new File([contents], "background.svg", {
          type: "image/svg+xml",
        });
        const files = new DataTransfer();
        files.items.add(file);
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, svg);

      await waitForCenterColorNear(
        viewerPage,
        { red: 254, green: 0, blue: 0, alpha: 255 },
        "uploaded image background",
      );
      await clearBoardCanvas(page);
      await waitForCenterColorNear(
        viewerPage,
        { red: 248, green: 250, blue: 252, alpha: 255 },
        "whiteboard after clearing image background",
      );
    });
  } finally {
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Surface relay sync", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Surface relay viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      await setBoardSurface(page, "greenboard");
      await waitForCenterColorNear(
        viewerPage,
        { red: 37, green: 79, blue: 58, alpha: 255 },
        "greenboard",
      );

      await setBoardSurface(page, "whiteboard");
      await waitForCenterColorNear(
        viewerPage,
        { red: 248, green: 250, blue: 252, alpha: 255 },
        "whiteboard",
      );
    });
  } finally {
    await setBoardSurface(page, "whiteboard").catch(() => {});
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Live relay drawing sync", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Live relay viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const beforePixels = await darkInkPixels(viewerPage);
      await drawHorizontalBoardStroke(page);
      await waitForDarkInkPixelsAbove(viewerPage, beforePixels);
      await clearBoardCanvas(page);
      await waitForDarkInkPixelsAtMost(viewerPage, beforePixels + 10);
    });
  } finally {
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Relay reconnect recovery", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);

  const viewerContext = await createBrowserContext({
    viewport: { width: 1000, height: 700 },
  });
  const viewerPage = await viewerContext.newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Relay reconnect viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const readyOrder = await viewerPage.evaluate(async () => {
        const url = new URL("/ws/relay?role=viewer", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return new Promise((resolve, reject) => {
          const socket = new WebSocket(url);
          const types = [];
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("timed out waiting for relay-ready"));
          }, 5000);
          socket.addEventListener("message", (message) => {
            const type = JSON.parse(String(message.data))?.type ?? "";
            types.push(type);
            if (type === "system:relay-ready") {
              clearTimeout(timer);
              socket.close();
              resolve(types);
            }
          });
          socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("relay ordering socket failed"));
          });
        });
      });
      if (readyOrder.at(-1) !== "system:relay-ready") {
        throw new Error(`Relay ready ordering was ${readyOrder.join(", ")}.`);
      }

      await viewerPage.reload({ waitUntil: "domcontentloaded" });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 10000 },
      );

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
      await page.waitForFunction(
        () => {
          const title =
            document.querySelector("[data-board-session]")?.getAttribute("title") ??
            "";
          return (
            title === "Relay connected" ||
            title === "1 viewer connected" ||
            /^\d+ viewers connected$/.test(title)
          );
        },
        undefined,
        { timeout: 10000 },
      );
      const beforePixels = await darkInkPixels(viewerPage);
      await drawHorizontalBoardStroke(page, 0.38);
      await waitForDarkInkPixelsAbove(viewerPage, beforePixels, 50, 10000);
    });
  } finally {
    await viewerContext.close();
  }
});

await checkWithoutConsoleErrors("Multiple viewers receive drawing sync", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);

  const firstViewerPage = await page.context().newPage();
  const secondViewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(
      firstViewerPage,
      "First simultaneous relay viewer",
      async () => {
        await checkPageWithoutConsoleErrors(
          secondViewerPage,
          "Second simultaneous relay viewer",
          async () => {
            for (const viewerPage of [firstViewerPage, secondViewerPage]) {
              await viewerPage.setViewportSize({ width: 1000, height: 700 });
              await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
              await viewerPage.waitForSelector("[data-viewer-canvas]", {
                timeout: 5000,
              });
              await viewerPage.waitForFunction(
                () =>
                  document.querySelector("[data-viewer-status]")?.dataset
                    ?.viewerConnection === "Connected",
                undefined,
                { timeout: 5000 },
              );
            }

            const firstBeforePixels = await darkInkPixels(firstViewerPage);
            const secondBeforePixels = await darkInkPixels(secondViewerPage);
            await drawHorizontalBoardStroke(page, 0.52);
            await waitForDarkInkPixelsAbove(firstViewerPage, firstBeforePixels);
            await waitForDarkInkPixelsAbove(secondViewerPage, secondBeforePixels);
          },
        );
      },
    );
  } finally {
    await firstViewerPage.close();
    await secondViewerPage.close();
  }
});

await checkWithoutConsoleErrors("Second board is locked out", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);

  const viewerPage = await page.context().newPage();
  const secondBoardPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Presenter lockout viewer", async () => {
      await checkPageWithoutConsoleErrors(
        secondBoardPage,
        "Second board presenter conflict",
        async () => {
          await viewerPage.setViewportSize({ width: 1000, height: 700 });
          await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
          await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
          await viewerPage.waitForFunction(
            () =>
              document.querySelector("[data-viewer-status]")?.dataset
                ?.viewerConnection === "Connected",
            undefined,
            { timeout: 5000 },
          );

          const beforePixels = await darkInkPixels(viewerPage);
          await drawHorizontalBoardStroke(page, 0.5);
          await waitForDarkInkPixelsAbove(
            viewerPage,
            beforePixels,
          );
          await viewerPage.waitForTimeout(600);

          await secondBoardPage.setViewportSize({ width: 1000, height: 700 });
          await installRelaySocketProbe(secondBoardPage);
          await secondBoardPage.goto(boardUrl, { waitUntil: "domcontentloaded" });
          await secondBoardPage.waitForSelector("[data-board-canvas]", {
            timeout: 5000,
          });
          await secondBoardPage.waitForFunction(
            () =>
              document
                .querySelector("[data-board-session]")
                ?.textContent?.includes("Presenter active elsewhere"),
            undefined,
            { timeout: 5000 },
          );

          const locked = await secondBoardPage.evaluate(() => {
            const controlNames = [
              "surface",
              "pen",
              "eraser",
              "pointer",
              "ephemeral",
              "tip-size",
              "eraser-size",
              "clear",
              "quick-undo",
              "toolbar-toggle",
            ];

            return {
              disabledControls: controlNames.filter(
                (name) =>
                  document.querySelector(`[data-board-control="${name}"]`)
                    ?.disabled === true,
              ),
              totalControls: controlNames.length,
            };
          });

          if (locked.disabledControls.length !== locked.totalControls) {
            throw new Error(
              "Second board did not disable all presenter controls: " +
                `${locked.disabledControls.length}/${locked.totalControls}.`,
            );
          }

          await drawRawBoardCanvasStroke(secondBoardPage, 0.62);
          await viewerPage.waitForTimeout(600);

          const secondBoardSent = await secondBoardPage.evaluate(
            () => window.__onboardRelaySocketProbe?.sentCount() ?? -1,
          );
          if (secondBoardSent !== 0) {
            throw new Error(
              `Second board sent ${secondBoardSent} relay messages after lockout.`,
            );
          }
        },
      );
    });
  } finally {
    await viewerPage.close();
    await secondBoardPage.close();
  }
});

await checkWithoutConsoleErrors("Eraser relay sync", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Eraser relay viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const beforePixels = await darkInkPixels(viewerPage);
      await drawHorizontalBoardStroke(page, 0.48);
      await waitForDarkInkPixelsAbove(viewerPage, beforePixels);
      await eraseHorizontalBoardStroke(page, 0.48);
      await waitForDarkInkPixelsAtMost(viewerPage, beforePixels + 10);
    });
  } finally {
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Pointer relay visibility", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Pointer relay viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const beforePixels = await pointerPixels(viewerPage);
      await showPointerOnBoard(page);
      await waitForPointerPixelsAbove(viewerPage, beforePixels);
      await page.mouse.up();
      await waitForPointerPixelsAtMost(viewerPage, beforePixels + 10);
    });
  } finally {
    await page.mouse.up().catch(() => {});
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Ephemeral ink expires in viewer", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await enableEphemeralInk(page);

  const viewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(viewerPage, "Ephemeral relay viewer", async () => {
      await viewerPage.setViewportSize({ width: 1000, height: 700 });
      await viewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await viewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await viewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );

      const beforePixels = await darkInkPixels(viewerPage);
      await drawHorizontalBoardStroke(page, 0.55);
      await waitForDarkInkPixelsAbove(viewerPage, beforePixels);
      await waitForDarkInkPixelsAtMost(viewerPage, beforePixels + 10, 7000);
    });
  } finally {
    await viewerPage.close();
  }
});

await checkWithoutConsoleErrors("Late viewer receives current board state", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-board-canvas]", { timeout: 5000 });
  await clearBoardCanvas(page);
  await disableEphemeralInk(page);
  await drawHorizontalBoardStroke(page, 0.45);
  await waitForDarkInkPixelsAbove(page, 0);

  const lateViewerPage = await page.context().newPage();
  try {
    await checkPageWithoutConsoleErrors(lateViewerPage, "Late relay viewer", async () => {
      await lateViewerPage.setViewportSize({ width: 1000, height: 700 });
      await lateViewerPage.goto(viewerUrl, { waitUntil: "domcontentloaded" });
      await lateViewerPage.waitForSelector("[data-viewer-canvas]", { timeout: 5000 });
      await lateViewerPage.waitForFunction(
        () =>
          document.querySelector("[data-viewer-status]")?.dataset
            ?.viewerConnection === "Connected",
        undefined,
        { timeout: 5000 },
      );
      await waitForDarkInkPixelsAbove(lateViewerPage, 0);
    });
  } finally {
    await lateViewerPage.close();
  }
});

await checkWithoutConsoleErrors("Viewer", async () => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const status = document.querySelector("[data-viewer-status]")?.dataset
        ?.viewerConnection;
      return status === "Connected";
    },
    undefined,
    { timeout: 5000 },
  );

  const result = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    const forbiddenSelectors = [
      "[data-board-control]",
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
      fullscreenButtons: document.querySelectorAll("[data-viewer-fullscreen]")
        .length,
      fullscreenLabel:
        document
          .querySelector("[data-viewer-fullscreen]")
          ?.getAttribute("aria-label") ?? "",
      forbidden,
      status:
        document.querySelector("[data-viewer-status]")?.dataset
          ?.viewerConnection ?? "",
      visibleStatus:
        document.querySelector("[data-viewer-status]")?.hidden === false
          ? document.querySelector("[data-viewer-status]")?.textContent?.trim() ?? ""
          : "",
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
  if (result.fullscreenButtons !== 1) {
    throw new Error(`Viewer has ${result.fullscreenButtons} fullscreen buttons.`);
  }
  if (!result.fullscreenLabel.toLowerCase().includes("fullscreen")) {
    throw new Error("Viewer fullscreen control has no accessible label.");
  }
  if (result.status !== "Connected") {
    throw new Error(`Viewer did not connect to the local relay. Status: ${result.status}`);
  }
  if (result.visibleStatus !== "" && result.visibleStatus !== "Connected") {
    throw new Error(`Viewer shows non-board status text: ${result.visibleStatus}`);
  }

  const fullscreenSupported = await page.evaluate(
    () => document.fullscreenEnabled === true,
  );
  if (fullscreenSupported) {
    await page.click("[data-viewer-fullscreen]");
    await page.waitForFunction(() => document.fullscreenElement !== null);
    await page.evaluate(() => document.exitFullscreen());
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
