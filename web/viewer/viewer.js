import {
  applyBoardEvent,
  createBoardState,
  snapshotBoardState,
} from "../core/board-state.js";
import {
  renderBoardState as defaultRenderBoardState,
  resizeCanvasToDisplaySize as defaultResizeCanvasToDisplaySize,
} from "../core/canvas-renderer.js";
import { createWebSocketRelayTransport } from "../transports/websocket-relay-transport.js";

const CONNECTED_STATUS_VISIBLE_MS = 12_000;

export function createRelayURL(location, role = "") {
  const base = `${location.protocol}//${location.host}`;
  const url = new URL("/ws/relay", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (role) {
    url.searchParams.set("role", role);
  }
  return url.href;
}

export function createViewerController({
  elements,
  transport,
  now = () => Date.now(),
  renderBoardState = defaultRenderBoardState,
  resizeCanvasToDisplaySize = defaultResizeCanvasToDisplaySize,
  ResizeObserverImpl = globalThis.ResizeObserver,
  setTimeout: setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout?.bind(globalThis),
  window = globalThis.window,
} = {}) {
  if (!elements?.canvas) {
    throw new TypeError("viewer controller requires a canvas element");
  }
  if (!transport) {
    throw new TypeError("viewer controller requires a transport");
  }

  const { canvas } = elements;
  const ctx = canvas.getContext("2d");
  const state = createBoardState();
  let connectionState = "idle";
  let connectionPromise = null;
  let connectionGeneration = 0;
  let pendingRenderFrame = null;
  let ephemeralRenderTimer = null;
  let statusHideTimer = null;
  let closed = false;

  const unsubscribe = transport.onEvent((event) => {
    applyBoardEvent(state, event);
    scheduleRender();
  });
  const unsubscribeStatus =
    typeof transport.onStatus === "function"
      ? transport.onStatus(handleTransportStatus)
      : () => {};
  const cleanupResizeRendering = setupResizeRendering();

  render();
  updateStatus("Disconnected");

  return {
    connect() {
      return connectTransport();
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      connectionGeneration += 1;
      unsubscribe();
      unsubscribeStatus();
      cleanupResizeRendering();
      cancelScheduledRender();
      clearEphemeralRenderTimer();
      clearStatusHideTimer();
      connectionState = "closed";
      connectionPromise = null;
      updateStatus("Disconnected");
      transport.close();
    },
    getSnapshot() {
      return snapshotBoardState(state);
    },
  };

  function connectTransport() {
    if (closed) {
      return Promise.reject(new Error("viewer controller is closed"));
    }

    if (connectionState === "open") {
      return Promise.resolve();
    }

    if (connectionState === "connecting" && connectionPromise) {
      return connectionPromise;
    }

    connectionState = "connecting";
    const generation = connectionGeneration + 1;
    connectionGeneration = generation;
    updateStatus("Connecting");
    connectionPromise = transport
      .connect()
      .then(() => {
        if (closed || generation !== connectionGeneration) {
          throw new Error("viewer controller is closed");
        }

        connectionState = "open";
        updateStatus("Connected");
      })
      .catch((error) => {
        if (closed || generation !== connectionGeneration) {
          throw new Error("viewer controller is closed");
        }

        connectionState = "failed";
        connectionPromise = null;
        updateStatus("Connection failed");
        throw error;
      });

    return connectionPromise;
  }

  function handleTransportStatus(status) {
    if (closed) {
      return;
    }

    if (status === "connecting") {
      connectionState = "connecting";
      updateStatus("Connecting");
      return;
    }

    if (status === "reconnecting") {
      connectionState = "connecting";
      connectionPromise = null;
      updateStatus("Reconnecting");
      return;
    }

    if (status === "connected") {
      connectionState = "open";
      connectionPromise = null;
      updateStatus("Connected");
      return;
    }

    if (status === "disconnected" || status === "closed") {
      connectionState = "failed";
      connectionPromise = null;
      updateStatus("Disconnected");
    }
  }

  function render() {
    pendingRenderFrame = null;
    if (closed) {
      return;
    }

    resizeCanvasToDisplaySize(canvas);
    const renderNow = now();
    const snapshot = snapshotBoardState(state);
    renderBoardState(
      ctx,
      snapshot,
      {
        width: canvas.width,
        height: canvas.height,
      },
      { now: renderNow },
    );
    scheduleNextEphemeralRender(snapshot, renderNow);
  }

  function scheduleRender() {
    if (closed) {
      return;
    }

    if (
      window &&
      typeof window.requestAnimationFrame === "function" &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      if (pendingRenderFrame !== null) {
        return;
      }

      pendingRenderFrame = window.requestAnimationFrame(render);
      return;
    }

    render();
  }

  function cancelScheduledRender() {
    if (
      pendingRenderFrame !== null &&
      window &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(pendingRenderFrame);
    }
    pendingRenderFrame = null;
  }

  function scheduleNextEphemeralRender(snapshot, currentNow) {
    clearEphemeralRenderTimer();

    if (closed || typeof setTimer !== "function") {
      return;
    }

    let nextExpiresAt = Number.POSITIVE_INFINITY;
    for (const stroke of snapshot.strokes) {
      if (
        stroke.ephemeral === true &&
        Number.isFinite(stroke.expiresAt) &&
        stroke.expiresAt > currentNow &&
        stroke.expiresAt < nextExpiresAt
      ) {
        nextExpiresAt = stroke.expiresAt;
      }
    }

    if (!Number.isFinite(nextExpiresAt)) {
      return;
    }

    ephemeralRenderTimer = setTimer(() => {
      ephemeralRenderTimer = null;
      scheduleRender();
    }, Math.max(0, nextExpiresAt - currentNow));
  }

  function clearEphemeralRenderTimer() {
    if (ephemeralRenderTimer !== null) {
      clearTimer?.(ephemeralRenderTimer);
      ephemeralRenderTimer = null;
    }
  }

  function updateStatus(message) {
    if (elements.status) {
      clearStatusHideTimer();
      if (elements.status.dataset) {
        elements.status.dataset.viewerConnection = message;
      }
      elements.status.setAttribute?.("data-viewer-connection", message);
      elements.status.hidden = false;
      elements.status.textContent = message;

      if (message === "Connected") {
        statusHideTimer = setTimer?.(() => {
          statusHideTimer = null;
          if (elements.status) {
            elements.status.hidden = true;
          }
        }, CONNECTED_STATUS_VISIBLE_MS) ?? null;
        statusHideTimer?.unref?.();
      }
    }
  }

  function clearStatusHideTimer() {
    if (statusHideTimer !== null) {
      clearTimer?.(statusHideTimer);
      statusHideTimer = null;
    }
  }

  function setupResizeRendering() {
    const cleanup = [];

    if (typeof ResizeObserverImpl === "function") {
      const observer = new ResizeObserverImpl(() => {
        render();
      });
      observer.observe(canvas);
      cleanup.push(() => {
        observer.disconnect();
      });
    }

    if (
      window &&
      typeof window.addEventListener === "function" &&
      typeof window.removeEventListener === "function"
    ) {
      window.addEventListener("resize", render);
      cleanup.push(() => {
        window.removeEventListener("resize", render);
      });
    }

    return () => {
      for (const cleanupResize of cleanup) {
        cleanupResize();
      }
    };
  }
}

export function createViewerApp({
  document = globalThis.document,
  location = globalThis.location,
  fullscreenDocument = globalThis.document,
  WebSocketImpl = globalThis.WebSocket,
  createRelayTransport = createWebSocketRelayTransport,
  wakeLockNavigator = globalThis.navigator,
  reportError = defaultReportError,
} = {}) {
  const root = document?.querySelector?.("#viewer-app");
  if (!root) {
    return null;
  }

  const transport = createRelayTransport({
    url: createRelayURL(location, "viewer"),
    WebSocketImpl,
  });
  const controller = createViewerController({
    elements: {
      canvas: root.querySelector("[data-viewer-canvas]"),
      status: root.querySelector("[data-viewer-status]"),
    },
    transport,
  });

  controller.connect().catch((error) => {
    reportError(error);
  });
  setupViewerFullscreenButton({
    root,
    button: root.querySelector("[data-viewer-fullscreen]"),
    installHint: root.querySelector("[data-viewer-install-hint]"),
    document: fullscreenDocument,
    navigator: wakeLockNavigator,
    reportError,
  });

  return controller;
}

function setupViewerFullscreenButton({
  root,
  button,
  installHint,
  document,
  navigator,
  reportError,
}) {
  if (!button) {
    return;
  }

  let wakeLock = null;
  const standaloneDisplay = isStandaloneDisplay(navigator);

  setupWakeLockLifecycle({
    requireFullscreen: !standaloneDisplay,
  });

  if (isStandaloneDisplay(navigator)) {
    button.hidden = true;
    requestScreenWakeLock({ requireFullscreen: false });
    return;
  }

  const fullscreenTarget =
    getFullscreenRequest(root) ? root : document?.documentElement;
  const canEnterFullscreen = Boolean(getFullscreenRequest(fullscreenTarget));
  if (!canEnterFullscreen) {
    button.hidden = false;
    button.dataset.viewerFullscreenUnsupported = "true";
    button.title = "Install from Safari to hide browser controls";
    button.setAttribute?.(
      "aria-label",
      "Show iPhone install instructions",
    );
    button.addEventListener?.("click", () => {
      showInstallHint();
    });
    return;
  }

  button.hidden = false;
  button.dataset.viewerFullscreenUnsupported = "false";

  button.addEventListener?.("click", () => {
    toggleFullscreen().catch((error) => {
      reportError(error);
      showInstallHint();
    });
  });

  async function toggleFullscreen() {
    if (isFullscreenActive()) {
      await exitFullscreen();
      await releaseScreenWakeLock();
      return;
    }

    const request = getFullscreenRequest(fullscreenTarget);
    await request.call(fullscreenTarget);
    await requestScreenWakeLock({ requireFullscreen: true });
  }

  async function exitFullscreen() {
    const exit =
      document?.exitFullscreen ?? document?.webkitExitFullscreen ?? null;
    if (typeof exit === "function") {
      await exit.call(document);
    }
  }

  function handleFullscreenChange() {
    if (isFullscreenActive()) {
      requestScreenWakeLock({ requireFullscreen: true });
      return;
    }

    releaseScreenWakeLock();
  }

  function isFullscreenActive() {
    return Boolean(
      document?.fullscreenElement ?? document?.webkitFullscreenElement ?? null,
    );
  }

  function setupWakeLockLifecycle({ requireFullscreen }) {
    document?.addEventListener?.("fullscreenchange", handleFullscreenChange);
    document?.addEventListener?.(
      "webkitfullscreenchange",
      handleFullscreenChange,
    );
    document?.addEventListener?.("visibilitychange", () => {
      if (document?.visibilityState === "hidden") {
        releaseScreenWakeLock();
        return;
      }

      requestScreenWakeLock({ requireFullscreen });
    });

    for (const eventName of ["pointerdown", "touchstart", "click"]) {
      root?.addEventListener?.(eventName, () => {
        requestScreenWakeLock({ requireFullscreen });
      });
    }
  }

  async function requestScreenWakeLock({ requireFullscreen } = {}) {
    if (
      wakeLock ||
      (requireFullscreen && !isFullscreenActive()) ||
      document?.visibilityState === "hidden"
    ) {
      return false;
    }

    const request = navigator?.wakeLock?.request;
    if (typeof request !== "function") {
      return false;
    }

    try {
      const sentinel = await request.call(navigator.wakeLock, "screen");
      wakeLock = sentinel;
      sentinel?.addEventListener?.("release", () => {
        if (wakeLock === sentinel) {
          wakeLock = null;
        }
      });
      return true;
    } catch {
      wakeLock = null;
      return false;
    }
  }

  async function releaseScreenWakeLock() {
    const sentinel = wakeLock;
    wakeLock = null;
    if (typeof sentinel?.release === "function") {
      try {
        await sentinel.release();
      } catch {
        // Browsers may auto-release wake locks when visibility changes.
      }
    }
  }

  function showInstallHint() {
    if (!installHint) {
      return;
    }

    installHint.hidden = false;
  }
}

function getFullscreenRequest(element) {
  return element?.requestFullscreen ?? element?.webkitRequestFullscreen ?? null;
}

function isStandaloneDisplay(navigator) {
  return (
    navigator?.standalone === true ||
    globalThis.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    globalThis.matchMedia?.("(display-mode: fullscreen)")?.matches === true
  );
}

function createIdPart() {
  const crypto = globalThis.crypto;
  const bytes = new Uint32Array(2);

  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    bytes[0] = Math.floor(Math.random() * 0xffffffff);
    bytes[1] = Date.now() & 0xffffffff;
  }

  return Array.from(bytes, (value) => value.toString(36)).join("");
}

function defaultReportError(error) {
  console.error("Viewer transport error", error);
}

if (
  typeof globalThis.document !== "undefined" &&
  globalThis.document.querySelector?.("#viewer-app")
) {
  createViewerApp();
}
