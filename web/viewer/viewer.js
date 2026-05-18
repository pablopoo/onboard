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

export function createRelayURL(location) {
  const base = `${location.protocol}//${location.host}`;
  const url = new URL("/ws/relay", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function createViewerController({
  elements,
  transport,
  now = () => Date.now(),
  renderBoardState = defaultRenderBoardState,
  resizeCanvasToDisplaySize = defaultResizeCanvasToDisplaySize,
  ResizeObserverImpl = globalThis.ResizeObserver,
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
  let closed = false;

  const unsubscribe = transport.onEvent((event) => {
    applyBoardEvent(state, event);
    render();
  });
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
      cleanupResizeRendering();
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

  function render() {
    if (closed) {
      return;
    }

    resizeCanvasToDisplaySize(canvas);
    renderBoardState(
      ctx,
      snapshotBoardState(state),
      {
        width: canvas.width,
        height: canvas.height,
      },
      { now: now() },
    );
  }

  function updateStatus(message) {
    if (elements.status) {
      elements.status.textContent = message;
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
  reportError = defaultReportError,
} = {}) {
  const root = document?.querySelector?.("#viewer-app");
  if (!root) {
    return null;
  }

  const transport = createWebSocketRelayTransport({
    url: createRelayURL(location),
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

function defaultReportError(error) {
  console.error("Viewer relay transport error", error);
}

if (
  typeof globalThis.document !== "undefined" &&
  globalThis.document.querySelector?.("#viewer-app")
) {
  createViewerApp();
}
