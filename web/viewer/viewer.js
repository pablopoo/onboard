import {
  applyBoardEvent,
  createBoardState,
  snapshotBoardState,
} from "../core/board-state.js";
import {
  renderBoardState as defaultRenderBoardState,
  resizeCanvasToDisplaySize as defaultResizeCanvasToDisplaySize,
} from "../core/canvas-renderer.js";
import { createSignalingClient } from "../transports/signaling-client.js";
import { createWebRTCDataChannelTransport } from "../transports/webrtc-datachannel-transport.js";
import { createWebSocketRelayTransport } from "../transports/websocket-relay-transport.js";

const VIEWER_READY_SIGNAL_PAYLOAD = { onboardViewerReady: true };

export function createRelayURL(location, role = "") {
  const base = `${location.protocol}//${location.host}`;
  const url = new URL("/ws/relay", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (role) {
    url.searchParams.set("role", role);
  }
  return url.href;
}

export function createSignalURL(location) {
  const base = `${location.protocol}//${location.host}`;
  const url = new URL("/signal", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function createPeerId(prefix = "peer") {
  return `${prefix}-${createIdPart()}`;
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
      if (elements.status.dataset) {
        elements.status.dataset.viewerConnection = message;
      }
      elements.status.setAttribute?.("data-viewer-connection", message);
      elements.status.hidden = message === "Connected";
      elements.status.textContent = message === "Connected" ? "" : message;
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
  WebSocketImpl = globalThis.WebSocket,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  createRelayTransport = createWebSocketRelayTransport,
  createSignalingClientImpl = createSignalingClient,
  createWebRTCTransport = createWebRTCDataChannelTransport,
  createPeerId: createPeerIdImpl = createPeerId,
  reportError = defaultReportError,
} = {}) {
  const root = document?.querySelector?.("#viewer-app");
  if (!root) {
    return null;
  }

  const mode = transportModeForLocation(location);
  const transport =
    mode === "webrtc"
      ? createViewerWebRTCSetupTransport({
          location,
          WebSocketImpl,
          RTCPeerConnectionImpl,
          createSignalingClientImpl,
          createWebRTCTransport,
          sessionId: sessionIdForLocation(location),
          peerId: createPeerIdImpl("viewer"),
          reportError,
        })
      : createRelayTransport({
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

  return controller;
}

function createViewerWebRTCSetupTransport({
  location,
  WebSocketImpl,
  RTCPeerConnectionImpl,
  createSignalingClientImpl,
  createWebRTCTransport,
  sessionId,
  peerId,
  reportError,
}) {
  const handlers = new Set();
  const statusHandlers = new Set();
  const realUnsubscribers = new Map();
  const pendingRejects = new Set();
  let signaling = null;
  let realTransport = null;
  let unsubscribeRealStatus = null;
  let connectPromise = null;
  let reconnectPromise = null;
  let closed = false;
  let lastStatus = null;

  return {
    connect() {
      if (closed) {
        return Promise.reject(new Error("WebRTC viewer transport is closed"));
      }

      if (!sessionId) {
        return Promise.reject(
          new Error("WebRTC viewer mode requires sessionId in the URL"),
        );
      }

      if (connectPromise) {
        return connectPromise;
      }

      connectPromise = connectWebRTC().catch((error) => {
        connectPromise = null;
        if (!closed) {
          closeResources();
        }
        throw error;
      });
      return connectPromise;
    },
    send(event) {
      if (!realTransport) {
        throw new Error("WebRTC transport must be open before sending events");
      }
      realTransport.send(event);
    },
    onEvent(handler) {
      handlers.add(handler);
      attachHandler(handler);

      return () => {
        handlers.delete(handler);
        const unsubscribe = realUnsubscribers.get(handler);
        unsubscribe?.();
        realUnsubscribers.delete(handler);
      };
    },
    onStatus(handler) {
      statusHandlers.add(handler);

      return () => {
        statusHandlers.delete(handler);
      };
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      rejectPendingWaits(new Error("WebRTC viewer transport closed before open"));
      closeResources();
    },
  };

  async function connectWebRTC() {
    emitStatus("connecting");
    signaling = createSignalingClientImpl({
      url: createSignalURL(location),
      WebSocketImpl,
    });
    await signaling.connect();
    throwIfClosed();

    const sessionJoined = waitForSignalingMessage((message) => {
      return (
        message.type === "session:joined" &&
        message.sessionId === sessionId &&
        message.peerId === peerId &&
        message.role === "viewer"
      );
    });
    signaling.joinSession(sessionId, peerId);
    await sessionJoined;
    throwIfClosed();

    await connectRealTransport();
  }

  async function connectRealTransport() {
    realTransport = createWebRTCTransport({
      signaling,
      role: "viewer",
      sessionId,
      peerId,
      RTCPeerConnectionImpl,
      closeSignalingOnClose: false,
    });
    attachHandlers();
    attachStatusHandler();
    const realConnection = realTransport.connect();
    signaling.sendSignal({
      type: "ice",
      sessionId,
      peerId,
      payload: VIEWER_READY_SIGNAL_PAYLOAD,
    });
    await realConnection;
    emitStatus("connected");
  }

  function waitForSignalingMessage(predicate) {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};

      function cleanup() {
        unsubscribe();
        pendingRejects.delete(rejectWithCleanup);
      }

      function rejectWithCleanup(error) {
        cleanup();
        reject(error);
      }

      pendingRejects.add(rejectWithCleanup);
      unsubscribe = signaling.onMessage((message) => {
        if (message.type === "error") {
          rejectWithCleanup(
            new Error(`WebRTC signaling error: ${message.error}`),
          );
          return;
        }

        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      });
    });
  }

  function attachHandlers() {
    for (const handler of handlers) {
      attachHandler(handler);
    }
  }

  function attachStatusHandler() {
    if (
      unsubscribeRealStatus ||
      !realTransport ||
      typeof realTransport.onStatus !== "function"
    ) {
      return;
    }

    unsubscribeRealStatus = realTransport.onStatus(handleRealTransportStatus);
  }

  function handleRealTransportStatus(status) {
    if (status === "disconnected" || status === "closed") {
      startReconnect();
      return;
    }

    emitStatus(status);
  }

  function attachHandler(handler) {
    if (!realTransport || realUnsubscribers.has(handler)) {
      return;
    }

    realUnsubscribers.set(handler, realTransport.onEvent(handler));
  }

  function rejectPendingWaits(error) {
    for (const rejectPending of Array.from(pendingRejects)) {
      rejectPending(error);
    }
    pendingRejects.clear();
  }

  function closeResources() {
    reconnectPromise = null;
    cleanupRealTransport();

    signaling?.close();
    signaling = null;
  }

  function cleanupRealTransport({ close = true } = {}) {
    unsubscribeRealStatus?.();
    unsubscribeRealStatus = null;

    for (const unsubscribe of realUnsubscribers.values()) {
      unsubscribe();
    }
    realUnsubscribers.clear();

    if (close) {
      realTransport?.close();
    }
    realTransport = null;
  }

  function throwIfClosed() {
    if (closed) {
      throw new Error("WebRTC viewer transport is closed");
    }
  }

  function emitStatus(status) {
    if (status === lastStatus) {
      return;
    }

    lastStatus = status;
    for (const handler of statusHandlers) {
      handler(status);
    }
  }

  function startReconnect() {
    if (closed || reconnectPromise || !signaling) {
      return;
    }

    emitStatus("reconnecting");
    cleanupRealTransport({ close: false });

    reconnectPromise = connectRealTransport()
      .catch((error) => {
        if (!closed) {
          emitStatus("disconnected");
          reportError?.(error);
        }
        throw error;
      })
      .catch(() => {})
      .finally(() => {
        reconnectPromise = null;
      });
  }
}

function transportModeForLocation(location) {
  const searchParams = new URLSearchParams(location?.search ?? "");
  return searchParams.get("transport") === "webrtc" ? "webrtc" : "relay";
}

function sessionIdForLocation(location) {
  const searchParams = new URLSearchParams(location?.search ?? "");
  return searchParams.get("sessionId")?.trim() ?? "";
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
