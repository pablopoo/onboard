import {
  createBoardEvent,
  isToolAllowedForSurface,
  normalizePoint,
} from "../core/protocol.js";
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

const SURFACES = new Set([
  "whiteboard",
  "blueboard",
  "blackboard",
  "greenboard",
]);
const PEN_BY_SURFACE = {
  whiteboard: "marker",
  blueboard: "marker",
  blackboard: "chalk",
  greenboard: "chalk",
};
const SURFACE_LABELS = {
  whiteboard: "Whiteboard",
  blueboard: "Blueboard",
  blackboard: "Blackboard",
  greenboard: "Greenboard",
};
const TOOL_LABELS = {
  marker: "Marker",
  chalk: "Chalk",
  eraser: "Eraser",
  pointer: "Pointer",
};
const PEN_STYLES = {
  whiteboard: { color: "#111827", width: 5 },
  blueboard: { color: "#f8fafc", width: 5 },
  blackboard: { color: "#f8fafc", width: 6 },
  greenboard: { color: "#f8fafc", width: 6 },
};
const ERASER_STYLE = { color: "#000000", width: 18 };
const EPHEMERAL_DELAY_MS = 4_000;

let nextStrokeNumber = 1;

export function createRelayURL(location) {
  const base = `${location.protocol}//${location.host}`;
  const url = new URL("/ws/relay", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function createBoardController({
  elements,
  transport,
  boardId = "default",
  now = () => Date.now(),
  setTimeout: setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout?.bind(globalThis),
  reportError = defaultReportError,
  renderBoardState = defaultRenderBoardState,
  resizeCanvasToDisplaySize = defaultResizeCanvasToDisplaySize,
} = {}) {
  if (!elements?.canvas) {
    throw new TypeError("board controller requires a canvas element");
  }
  if (!transport) {
    throw new TypeError("board controller requires a transport");
  }

  const { canvas } = elements;
  const ctx = canvas.getContext("2d");
  const state = createBoardState();
  const expirationTimers = new Map();
  let mode = "draw";
  let ephemeralEnabled = Boolean(elements.ephemeralToggle?.checked);
  let activeStroke = null;
  let activePointerId = null;
  let connectionState = "idle";
  let connectionPromise = null;
  let nextEventNumber = 1;
  const eventSessionId = createEventSessionId();
  const queuedEvents = [];

  const unsubscribe = transport.onEvent((event) => {
    applyBoardEvent(state, event);
    render();
    updateControls();
  });

  bindControls();
  render();
  updateControls();

  return {
    connect() {
      return connectTransport();
    },
    close() {
      unsubscribe();
      for (const timer of expirationTimers.values()) {
        clearTimer?.(timer);
      }
      expirationTimers.clear();
      connectionState = "closed";
      connectionPromise = null;
      transport.close();
    },
    getSnapshot() {
      return snapshotBoardState(state);
    },
  };

  function bindControls() {
    elements.surfaceSelect?.addEventListener("change", handleSurfaceChange);
    elements.penButton?.addEventListener("click", () => setMode("draw"));
    elements.eraserButton?.addEventListener("click", () => setMode("eraser"));
    elements.pointerButton?.addEventListener("click", () => setMode("pointer"));
    elements.ephemeralToggle?.addEventListener("change", () => {
      ephemeralEnabled = Boolean(elements.ephemeralToggle.checked);
      updateControls();
    });
    elements.clearButton?.addEventListener("click", handleClear);

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerEnd);
    canvas.addEventListener("pointercancel", handlePointerEnd);
    canvas.addEventListener("pointerleave", handlePointerEnd);
  }

  function handleSurfaceChange(event) {
    event.preventDefault?.();
    const surface = surfaceName(elements.surfaceSelect.value);
    publish("board:set-surface", { surface });
    updateControls();
  }

  function handleClear(event) {
    event.preventDefault?.();
    publish("board:clear", {});
  }

  function handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    event.preventDefault?.();
    canvas.setPointerCapture?.(event.pointerId);

    const point = pointFromEvent(event);

    if (mode === "pointer") {
      activePointerId = event.pointerId;
      publish("pointer:show", { point });
      return;
    }

    const surface = state.surface;
    const tool = currentTool(surface);
    const style = styleForTool(tool, surface);
    const strokeId = nextStrokeId();
    const payload = {
      strokeId,
      surface,
      tool,
      color: style.color,
      width: style.width,
      point,
    };

    if (ephemeralEnabled) {
      payload.ephemeral = true;
      payload.expiresAt = now() + EPHEMERAL_DELAY_MS;
    }

    activeStroke = {
      pointerId: event.pointerId,
      strokeId,
      ephemeral: ephemeralEnabled,
      expiresAt: payload.expiresAt,
    };
    publish("stroke:start", payload);
  }

  function handlePointerMove(event) {
    if (mode === "pointer") {
      if (activePointerId !== event.pointerId) {
        return;
      }
      event.preventDefault?.();
      publish("pointer:move", { point: pointFromEvent(event) });
      return;
    }

    if (!activeStroke || activeStroke.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault?.();
    publish("stroke:point", {
      strokeId: activeStroke.strokeId,
      point: pointFromEvent(event),
    });
  }

  function handlePointerEnd(event) {
    if (mode === "pointer") {
      if (activePointerId !== event.pointerId) {
        return;
      }
      event.preventDefault?.();
      activePointerId = null;
      canvas.releasePointerCapture?.(event.pointerId);
      publish("pointer:hide", {});
      return;
    }

    if (!activeStroke || activeStroke.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault?.();
    const stroke = activeStroke;
    activeStroke = null;
    canvas.releasePointerCapture?.(event.pointerId);
    publish("stroke:end", { strokeId: stroke.strokeId });

    if (stroke.ephemeral) {
      scheduleExpiration(stroke.strokeId, stroke.expiresAt);
    }
  }

  function scheduleExpiration(strokeId, expiresAt) {
    const delay = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - now())
      : EPHEMERAL_DELAY_MS;
    const timer = setTimer?.(() => {
      expirationTimers.delete(strokeId);
      publish("stroke:expire", { strokeId });
    }, delay);

    if (timer !== undefined) {
      expirationTimers.set(strokeId, timer);
    }
  }

  function publish(type, payload) {
    const event = createBoardEvent(type, payload, boardId);
    event.id = nextBoardEventId();
    applyBoardEvent(state, event);
    render();
    updateControls();
    deliverEvent(event);
    return event;
  }

  function nextBoardEventId() {
    const id = `evt_board_${eventSessionId}_${String(nextEventNumber).padStart(
      6,
      "0",
    )}`;
    nextEventNumber += 1;
    return id;
  }

  function connectTransport() {
    if (connectionState === "open") {
      return Promise.resolve();
    }

    if (connectionState === "connecting" && connectionPromise) {
      return connectionPromise;
    }

    connectionState = "connecting";
    connectionPromise = transport
      .connect()
      .then(() => {
        connectionState = "open";
        flushQueuedEvents();
      })
      .catch((error) => {
        connectionState = "failed";
        connectionPromise = null;
        throw error;
      });

    return connectionPromise;
  }

  function deliverEvent(event) {
    if (connectionState !== "open") {
      queuedEvents.push(event);
      return;
    }

    try {
      transport.send(event);
    } catch (error) {
      queuedEvents.push(event);
      connectionState = "failed";
      connectionPromise = null;
      reportError(error);
    }
  }

  function flushQueuedEvents() {
    while (queuedEvents.length > 0 && connectionState === "open") {
      const event = queuedEvents.shift();

      try {
        transport.send(event);
      } catch (error) {
        queuedEvents.unshift(event);
        connectionState = "failed";
        connectionPromise = null;
        reportError(error);
      }
    }
  }

  function render() {
    resizeCanvasToDisplaySize(canvas);
    renderBoardState(ctx, snapshotBoardState(state), {
      width: canvas.width,
      height: canvas.height,
    });
  }

  function updateControls() {
    if (elements.surfaceSelect) {
      elements.surfaceSelect.value = state.surface;
    }

    const pen = compatiblePen(state.surface);
    if (elements.penButton) {
      elements.penButton.textContent = TOOL_LABELS[pen];
      elements.penButton.title = `${TOOL_LABELS[pen]} for ${
        SURFACE_LABELS[state.surface]
      }`;
    }

    setPressed(elements.penButton, mode === "draw");
    setPressed(elements.eraserButton, mode === "eraser");
    setPressed(elements.pointerButton, mode === "pointer");
    setPressed(elements.ephemeralToggle, ephemeralEnabled);
  }

  function setMode(nextMode) {
    mode = nextMode;
    updateControls();
  }

  function currentTool(surface) {
    if (mode === "eraser") {
      return "eraser";
    }

    const tool = compatiblePen(surface);
    return isToolAllowedForSurface(tool, surface) ? tool : "marker";
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.width || 1;
    const height = rect.height || canvas.height || 1;

    return normalizePoint({
      x: (event.clientX - rect.left) / width,
      y: (event.clientY - rect.top) / height,
      pressure: event.pressure,
    });
  }
}

export function createBoardApp({
  document = globalThis.document,
  location = globalThis.location,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const root = document?.querySelector?.("#board-app");
  if (!root) {
    return null;
  }

  const transport = createWebSocketRelayTransport({
    url: createRelayURL(location),
    WebSocketImpl,
  });
  const controller = createBoardController({
    elements: {
      canvas: root.querySelector("[data-board-canvas]"),
      surfaceSelect: root.querySelector("[data-board-control='surface']"),
      penButton: root.querySelector("[data-board-control='pen']"),
      eraserButton: root.querySelector("[data-board-control='eraser']"),
      pointerButton: root.querySelector("[data-board-control='pointer']"),
      ephemeralToggle: root.querySelector("[data-board-control='ephemeral']"),
      clearButton: root.querySelector("[data-board-control='clear']"),
    },
    transport,
  });

  controller.connect().catch((error) => {
    console.error("Failed to connect board relay", error);
  });

  return controller;
}

function surfaceName(value) {
  const surface = String(value ?? "").toLowerCase();
  return SURFACES.has(surface) ? surface : "whiteboard";
}

function compatiblePen(surface) {
  return PEN_BY_SURFACE[surface] ?? "marker";
}

function styleForTool(tool, surface) {
  if (tool === "eraser") {
    return ERASER_STYLE;
  }

  return PEN_STYLES[surface] ?? PEN_STYLES.whiteboard;
}

function setPressed(element, pressed) {
  element?.classList?.toggle("is-active", pressed);
  element?.setAttribute?.("aria-pressed", String(pressed));
}

function defaultReportError(error) {
  console.error("Board relay transport error", error);
}

function createEventSessionId() {
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

function nextStrokeId() {
  const id = `stroke_${String(nextStrokeNumber).padStart(6, "0")}`;
  nextStrokeNumber += 1;
  return id;
}

if (typeof globalThis.document !== "undefined") {
  createBoardApp();
}
