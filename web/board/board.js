import {
  createBoardEvent,
  isToolAllowedForSurface,
  normalizePoint,
  validateBoardEvent,
} from "../core/protocol.js";
import {
  applyBoardEvent,
  createBoardState,
  snapshotBoardState,
} from "../core/board-state.js";
import {
  boardViewportForSize,
  renderBoardState as defaultRenderBoardState,
  resizeCanvasToDisplaySize as defaultResizeCanvasToDisplaySize,
} from "../core/canvas-renderer.js";
import { copyText as defaultCopyText } from "../core/clipboard.js";
import { createShareQRCodeElement } from "../core/qr.js";
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
const SURFACE_SHORT_LABELS = {
  whiteboard: "White",
  blueboard: "Blue",
  blackboard: "Black",
  greenboard: "Green",
};
const SURFACE_COLORS = {
  whiteboard: "#f8fafc",
  blueboard: "#174a7c",
  blackboard: "#1f2521",
  greenboard: "#22543d",
};
const COLOR_OPTIONS_BY_SURFACE = {
  whiteboard: [
    { label: "Black marker", color: "#111827" },
    { label: "Blue marker", color: "#1d4ed8" },
    { label: "Red marker", color: "#dc2626" },
    { label: "Green marker", color: "#15803d" },
  ],
  blueboard: [
    { label: "White marker", color: "#f8fafc" },
    { label: "Yellow marker", color: "#facc15" },
    { label: "Cyan marker", color: "#67e8f9" },
    { label: "Pink marker", color: "#f9a8d4" },
  ],
  blackboard: [
    { label: "White chalk", color: "#f8fafc" },
    { label: "Yellow chalk", color: "#f8e08e" },
    { label: "Rose chalk", color: "#f5b6c8" },
    { label: "Blue chalk", color: "#b7d7f0" },
  ],
  greenboard: [
    { label: "White chalk", color: "#f8fafc" },
    { label: "Yellow chalk", color: "#f8e08e" },
    { label: "Rose chalk", color: "#f5b6c8" },
    { label: "Blue chalk", color: "#b7d7f0" },
  ],
};
const TOOL_LABELS = {
  marker: "Marker",
  chalk: "Chalk",
  eraser: "Eraser",
  pointer: "Pointer",
};
const ERASER_STYLE = { color: "#000000", width: 18 };
const DEFAULT_TIP_WIDTH = 6;
const TIP_WIDTH_RANGE = { min: 2, max: 16 };
const ERASER_WIDTH_RANGE = { min: 8, max: 48 };
const EPHEMERAL_DELAY_MS = 4_000;
const CLEAR_CONFIRM_MS = 3_000;
const FINAL_POINT_EPSILON = 0.000001;
const BACKGROUND_MAX_WIDTH = 1920;
const BACKGROUND_MAX_HEIGHT = 1080;
const BACKGROUND_JPEG_QUALITY = 0.88;
const DEFAULT_MAX_QUEUED_EVENT_BYTES = 8_000_000;
const DEFAULT_MAX_UNDO_BYTES = 8_000_000;
const SESSION_STATUS_LABELS = {
  "Relay connecting": "Connecting",
  "Relay connected": "Relay",
  "Relay reconnecting": "Reconnecting",
  "Relay disconnected": "Offline",
  "Input paused": "Paused",
};

let nextStrokeNumber = 1;

export function createRelayURL(location, role = "") {
  const base = `${location.protocol}//${location.host}`;
  const url = new URL("/ws/relay", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (role) {
    url.searchParams.set("role", role);
  }
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
  readBackgroundFile = defaultReadBackgroundFile,
  captureDisplayBackground = defaultCaptureDisplayBackground,
  screenCaptureSupported = defaultScreenCaptureSupported,
  ResizeObserverImpl = globalThis.ResizeObserver,
  window = globalThis.window,
  maxQueuedEvents = 1_000,
  maxQueuedEventBytes = DEFAULT_MAX_QUEUED_EVENT_BYTES,
  maxUndoBytes = DEFAULT_MAX_UNDO_BYTES,
  manageSessionStatus = true,
  viewerURL = "/viewer",
  copyText = defaultCopyText,
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
  let clearConfirmTimer = null;
  let clearArmed = false;
  let mode = "draw";
  let ephemeralEnabled = Boolean(elements.ephemeralToggle?.checked);
  let tipWidth = clampNumber(
    elements.tipSizeInput?.value,
    TIP_WIDTH_RANGE.min,
    TIP_WIDTH_RANGE.max,
    DEFAULT_TIP_WIDTH,
  );
  let eraserWidth = clampNumber(
    elements.eraserSizeInput?.value,
    ERASER_WIDTH_RANGE.min,
    ERASER_WIDTH_RANGE.max,
    ERASER_STYLE.width,
  );
  const selectedColors = new Map(
    Array.from(SURFACES, (surface) => [
      surface,
      colorOptionsForSurface(surface)[0].color,
    ]),
  );
  let activeStroke = null;
  let activePointerId = null;
  let connectionState = "idle";
  let connectionPromise = null;
  let connectionGeneration = 0;
  let relayViewerCount = null;
  let morePanelExpanded = false;
  let currentViewerURL = viewerURL;
  let pendingRenderFrame = null;
  let presenterLocked = false;
  let closed = false;
  let nextEventNumber = 1;
  let compactViewport = isCompactMobileViewport();
  let toolbarExpanded = !compactViewport;
  const eventSessionId = createEventSessionId();
  const queuedEvents = [];
  let queuedEventBytes = 0;
  const undoStack = [];
  let undoBytes = 0;

  const unsubscribe = transport.onEvent((event) => {
    if (event?.type === "system:presenter-conflict") {
      lockPresenterControls();
      return;
    }
    if (event?.type === "system:relay-presence") {
      handleRelayPresence(event);
      return;
    }

    applyBoardEvent(state, event);
    scheduleRender();
    updateControls();
  });
  const unsubscribeStatus =
    typeof transport.onStatus === "function"
      ? transport.onStatus(handleTransportStatus)
      : () => {};
  const cleanupResizeRendering = setupResizeRendering();
  const cleanupPasteHandling = setupPasteHandling();

  updateViewerShareElements(elements, currentViewerURL);
  updateMorePanel();
  bindControls();
  render();
  updateControls();

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
      cleanupPasteHandling();
      clearExpirationTimers();
      resetClearConfirmation();
      cancelScheduledRender();
      connectionState = "closed";
      connectionPromise = null;
      clearQueuedEvents();
      setSessionStatus("Relay disconnected");
      transport.close();
    },
    getSnapshot() {
      return snapshotBoardState(state);
    },
    setViewerURL(url) {
      currentViewerURL = String(url ?? "");
      updateViewerShareElements(elements, currentViewerURL);
      updateControls();
    },
  };

  function bindControls() {
    elements.surfaceSelect?.addEventListener("change", handleSurfaceChange);
    elements.penButton?.addEventListener("click", () => setMode("draw"));
    elements.eraserButton?.addEventListener("click", () => setMode("eraser"));
    elements.pointerButton?.addEventListener("click", () => setMode("pointer"));
    for (const colorButton of elements.colorButtons ?? []) {
      colorButton.addEventListener("click", handleColorChange);
    }
    elements.tipSizeInput?.addEventListener("input", handleTipSizeChange);
    elements.eraserSizeInput?.addEventListener("input", handleEraserSizeChange);
    elements.ephemeralToggle?.addEventListener("change", () => {
      ephemeralEnabled = Boolean(elements.ephemeralToggle.checked);
      collapseToolbarAfterCompactChoice();
      updateControls();
    });
    elements.clearButton?.addEventListener("click", handleClear);
    elements.undoButton?.addEventListener("click", handleUndo);
    elements.quickUndoButton?.addEventListener("click", handleUndo);
    elements.moreButton?.addEventListener("click", handleMoreToggle);
    elements.copyViewerButton?.addEventListener("click", handleCopyViewerLink);
    elements.backgroundUploadButton?.addEventListener(
      "click",
      handleBackgroundUpload,
    );
    elements.backgroundFileInput?.addEventListener(
      "change",
      handleBackgroundFileChange,
    );
    elements.backgroundCaptureButton?.addEventListener(
      "click",
      handleBackgroundCapture,
    );
    elements.backgroundRemoveButton?.addEventListener(
      "click",
      handleBackgroundRemove,
    );
    elements.toolbarToggleButton?.addEventListener("click", handleToolbarToggle);
    elements.toolbarCloseButton?.addEventListener("click", handleToolbarClose);

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerEnd);
    canvas.addEventListener("pointercancel", handlePointerEnd);
    canvas.addEventListener("pointerleave", handlePointerEnd);
  }

  function handleSurfaceChange(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    const surface = surfaceName(elements.surfaceSelect.value);
    publish("board:set-surface", { surface });
    collapseToolbarAfterCompactChoice();
    updateControls();
  }

  function handleColorChange(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    const index = Number(event.currentTarget?.dataset?.colorIndex);
    const colorOption = colorOptionsForSurface(state.surface)[index];
    if (!colorOption) {
      return;
    }

    selectedColors.set(state.surface, colorOption.color);
    collapseToolbarAfterCompactChoice();
    updateControls();
  }

  function handleTipSizeChange(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    tipWidth = clampNumber(
      elements.tipSizeInput.value,
      TIP_WIDTH_RANGE.min,
      TIP_WIDTH_RANGE.max,
      DEFAULT_TIP_WIDTH,
    );
    updateControls();
  }

  function handleEraserSizeChange(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    eraserWidth = clampNumber(
      elements.eraserSizeInput.value,
      ERASER_WIDTH_RANGE.min,
      ERASER_WIDTH_RANGE.max,
      ERASER_STYLE.width,
    );
    updateControls();
  }

  function handleClear(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    const snapshot = snapshotBoardState(state);
    if (
      snapshot.strokes.length === 0 &&
      !snapshot.pointer.visible &&
      !snapshot.background
    ) {
      resetClearConfirmation();
      return;
    }

    if (!clearArmed) {
      armClearConfirmation();
      return;
    }

    resetClearConfirmation();
    if (publish("board:clear", {})) {
      pushUndoAction({ type: "restore", snapshot });
      clearExpirationTimers();
      updateControls();
    }
  }

  function handleToolbarToggle(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    setToolbarExpanded(!toolbarExpanded);
  }

  function handleToolbarClose(event) {
    event.preventDefault?.();
    setToolbarExpanded(false);
  }

  function handleMoreToggle(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    morePanelExpanded = !morePanelExpanded;
    updateMorePanel();
  }

  async function handleCopyViewerLink(event) {
    event.preventDefault?.();
    if (presenterLocked || !currentViewerURL) {
      return;
    }

    try {
      await copyText(currentViewerURL);
      setCopyViewerButtonLabel("Copied");
    } catch (error) {
      reportError(error);
      setCopyViewerButtonLabel("Failed");
    }
    setTimer?.(() => {
      setCopyViewerButtonLabel("Copy");
    }, 1200);
  }

  function handleBackgroundUpload(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    elements.backgroundFileInput?.click?.();
  }

  async function handleBackgroundFileChange(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    const file = firstImageFile(elements.backgroundFileInput?.files);
    if (!file) {
      return;
    }

    await setBackgroundFromFile(file);
    if (elements.backgroundFileInput) {
      elements.backgroundFileInput.value = "";
    }
  }

  async function handleBackgroundCapture(event) {
    event.preventDefault?.();
    if (presenterLocked || !screenCaptureSupported()) {
      return;
    }

    try {
      setBackgroundStatus("Capturing");
      const background = await captureDisplayBackground();
      publishBackground(background, "Image set");
    } catch (error) {
      reportError(error);
      setBackgroundStatus("Capture failed");
    }
  }

  function handleBackgroundRemove(event) {
    event.preventDefault?.();
    if (presenterLocked || !state.background) {
      return;
    }

    publishBackground(null, "Image removed");
  }

  function handleUndo(event) {
    event.preventDefault?.();
    if (presenterLocked) {
      return;
    }

    const action = popUndoAction();
    if (!action) {
      updateControls();
      return;
    }

    if (action.type === "stroke") {
      publish("board:undo", { strokeId: action.strokeId });
      return;
    }

    if (action.type === "restore") {
      publish("board:restore", action.snapshot);
    }
  }

  function handlePointerDown(event) {
    if (presenterLocked) {
      return;
    }
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    event.preventDefault?.();
    resetClearConfirmation();
    collapseToolbarForCanvasInput();
    canvas.setPointerCapture?.(event.pointerId);

    const point = pointFromEvent(event);

    if (mode === "pointer") {
      if (publish("pointer:show", { point })) {
        activePointerId = event.pointerId;
      } else {
        canvas.releasePointerCapture?.(event.pointerId);
      }
      return;
    }

    const surface = state.surface;
    const tool = currentTool(surface);
    const style = styleForTool(tool, surface, {
      color: selectedColorForSurface(surface),
      tipWidth,
      eraserWidth,
    });
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

    const startEvent = publish("stroke:start", payload);
    if (!startEvent) {
      canvas.releasePointerCapture?.(event.pointerId);
      return;
    }

    activeStroke = {
      pointerId: event.pointerId,
      strokeId,
      ephemeral: ephemeralEnabled,
      expiresAt: payload.expiresAt,
      lastPoint: point,
    };
  }

  function handlePointerMove(event) {
    if (presenterLocked) {
      return;
    }

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
    for (const sample of coalescedPointerEvents(event)) {
      publishStrokePoint(activeStroke, pointFromEvent(sample));
    }
  }

  function handlePointerEnd(event) {
    if (presenterLocked) {
      return;
    }

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
    publishFinalPointIfChanged(stroke, pointFromEvent(event));
    activeStroke = null;
    canvas.releasePointerCapture?.(event.pointerId);
    const endEvent = publish("stroke:end", { strokeId: stroke.strokeId });
    if (!endEvent) {
      updateControls();
      return;
    }

    if (stroke.ephemeral) {
      scheduleExpiration(stroke.strokeId, stroke.expiresAt);
    } else {
      pushUndoAction({ type: "stroke", strokeId: stroke.strokeId });
      updateControls();
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

  function clearExpirationTimers() {
    for (const timer of expirationTimers.values()) {
      clearTimer?.(timer);
    }
    expirationTimers.clear();
  }

  function armClearConfirmation() {
    resetClearConfirmation();
    setClearConfirmation(true);
    clearConfirmTimer = setTimer?.(() => {
      clearConfirmTimer = null;
      setClearConfirmation(false);
    }, CLEAR_CONFIRM_MS);
  }

  function resetClearConfirmation() {
    if (clearConfirmTimer !== null) {
      clearTimer?.(clearConfirmTimer);
      clearConfirmTimer = null;
    }
    setClearConfirmation(false);
  }

  function setClearConfirmation(armed) {
    clearArmed = Boolean(armed);
    elements.clearButton?.classList?.toggle("is-armed", clearArmed);
    elements.clearButton?.setAttribute?.(
      "aria-label",
      clearArmed ? "Confirm clear all" : "Clear all",
    );
    if (elements.clearButton) {
      elements.clearButton.title = clearArmed ? "Confirm clear all" : "Clear all";
    }
    setClearButtonLabel(clearArmed ? "Clear?" : "Clear");
  }

  function setClearButtonLabel(label) {
    const labelElement = elements.clearButton?.querySelector?.(
      "[data-clear-label]",
    );
    if (labelElement) {
      labelElement.textContent = label;
      return;
    }

    if (elements.clearButton) {
      elements.clearButton.textContent = label;
    }
  }

  function publish(type, payload) {
    if (presenterLocked) {
      return null;
    }
    if (!canAcceptEvent()) {
      return null;
    }

    const event = createBoardEvent(type, payload, boardId);
    event.id = nextBoardEventId();
    const validation = validateBoardEvent(event);
    if (!validation.valid) {
      reportError(new Error(`Invalid board event: ${validation.reason}`));
      return null;
    }

    if (!deliverEvent(event)) {
      return null;
    }

    applyBoardEvent(state, event);
    scheduleRender();
    updateControls();
    return event;
  }

  async function setBackgroundFromFile(file) {
    try {
      setBackgroundStatus("Loading");
      const background = await readBackgroundFile(file);
      publishBackground(background, "Image set");
    } catch (error) {
      reportError(error);
      setBackgroundStatus("Image failed");
    }
  }

  function publishBackground(background, statusMessage) {
    const snapshot = snapshotBoardState(state);
    const event = publish("board:set-background", { background });
    if (!event) {
      setBackgroundStatus("Image failed");
      return null;
    }

    pushUndoAction({ type: "restore", snapshot });
    setBackgroundStatus(statusMessage);
    updateControls();
    return event;
  }

  function setupPasteHandling() {
    if (
      !window ||
      typeof window.addEventListener !== "function" ||
      typeof window.removeEventListener !== "function"
    ) {
      return () => {};
    }

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }

  function handlePaste(event) {
    if (presenterLocked) {
      return;
    }

    const file = imageFileFromClipboard(event?.clipboardData);
    if (!file) {
      return;
    }

    event.preventDefault?.();
    void setBackgroundFromFile(file);
  }

  function canAcceptEvent() {
    if (connectionState === "open") {
      return true;
    }

    if (queuedEvents.length < maxQueuedEvents) {
      return true;
    }

    reportQueueFull();
    return false;
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
    if (closed) {
      return Promise.reject(new Error("board controller is closed"));
    }

    if (connectionState === "open") {
      return Promise.resolve();
    }

    if (connectionState === "connecting" && connectionPromise) {
      return connectionPromise;
    }

    connectionState = "connecting";
    setSessionStatus("Relay connecting");
    const generation = connectionGeneration + 1;
    connectionGeneration = generation;
    connectionPromise = transport
      .connect()
      .then(() => {
        if (closed || generation !== connectionGeneration) {
          throw new Error("board controller is closed");
        }

        connectionState = "open";
        flushQueuedEvents();
        if (connectionState === "open") {
          setConnectedSessionStatus();
        }
      })
      .catch((error) => {
        if (closed || generation !== connectionGeneration) {
          throw new Error("board controller is closed");
        }

        connectionState = "failed";
        connectionPromise = null;
        setSessionStatus("Relay disconnected");
        throw error;
      });

    return connectionPromise;
  }

  function handleTransportStatus(status) {
    if (closed || presenterLocked) {
      return;
    }

    if (status === "connecting") {
      connectionState = "connecting";
      setSessionStatus("Relay connecting");
      return;
    }

    if (status === "reconnecting") {
      connectionState = "connecting";
      connectionPromise = null;
      setSessionStatus("Relay reconnecting");
      return;
    }

    if (status === "connected") {
      connectionState = "open";
      connectionPromise = null;
      flushQueuedEvents();
      syncExternallyManagedSnapshot();
      if (connectionState === "open") {
        setConnectedSessionStatus();
      }
      return;
    }

    if (status === "disconnected" || status === "closed") {
      connectionState = "failed";
      connectionPromise = null;
      setSessionStatus("Relay disconnected");
    }
  }

  function deliverEvent(event) {
    if (connectionState !== "open") {
      return enqueueEvent(event);
    }

    try {
      transport.send(event);
      return true;
    } catch (error) {
      const queued = enqueueEvent(event);
      connectionState = "failed";
      connectionPromise = null;
      setSessionStatus("Input paused");
      reportError(error);
      return queued;
    }
  }

  function syncExternallyManagedSnapshot() {
    if (manageSessionStatus || connectionState !== "open") {
      return;
    }

    const event = createBoardEvent(
      "board:restore",
      snapshotBoardState(state),
      boardId,
    );
    event.id = nextBoardEventId();
    deliverEvent(event);
  }

  function enqueueEvent(event) {
    const size = serializedSize(event);
    const shouldReplaceBackground = event.type === "board:set-background";
    const replaced = shouldReplaceBackground
      ? queuedEventStats((queued) => queued.event.type === "board:set-background")
      : { count: 0, bytes: 0 };
    const nextEventCount = queuedEvents.length - replaced.count;
    const nextEventBytes = queuedEventBytes - replaced.bytes;

    if (nextEventCount >= maxQueuedEvents) {
      reportQueueFull();
      return false;
    }
    if (nextEventBytes + size > maxQueuedEventBytes) {
      reportQueueFull();
      return false;
    }

    if (shouldReplaceBackground) {
      removeQueuedEvents((queued) => queued.event.type === "board:set-background");
    }
    queuedEvents.push({ event, size });
    queuedEventBytes += size;
    return true;
  }

  function flushQueuedEvents() {
    while (queuedEvents.length > 0 && connectionState === "open") {
      const queued = queuedEvents.shift();
      queuedEventBytes -= queued.size;
      const event = queued.event;

      try {
        transport.send(event);
      } catch (error) {
        queuedEvents.unshift(queued);
        queuedEventBytes += queued.size;
        connectionState = "failed";
        connectionPromise = null;
        setSessionStatus("Input paused");
        reportError(error);
      }
    }
  }

  function queuedEventStats(predicate) {
    let count = 0;
    let bytes = 0;
    for (const queued of queuedEvents) {
      if (!predicate(queued)) {
        continue;
      }

      count += 1;
      bytes += queued.size;
    }
    return { count, bytes };
  }

  function removeQueuedEvents(predicate) {
    for (let index = queuedEvents.length - 1; index >= 0; index -= 1) {
      const queued = queuedEvents[index];
      if (!predicate(queued)) {
        continue;
      }

      queuedEvents.splice(index, 1);
      queuedEventBytes -= queued.size;
    }
  }

  function clearQueuedEvents() {
    queuedEvents.length = 0;
    queuedEventBytes = 0;
  }

  function pushUndoAction(action) {
    const size = serializedSize(action);
    if (size > maxUndoBytes) {
      return false;
    }

    undoStack.push({ action, size });
    undoBytes += size;
    while (undoBytes > maxUndoBytes && undoStack.length > 0) {
      const dropped = undoStack.shift();
      undoBytes -= dropped.size;
    }
    return true;
  }

  function popUndoAction() {
    const entry = undoStack.pop();
    if (!entry) {
      return null;
    }

    undoBytes -= entry.size;
    return entry.action;
  }

  function serializedSize(value) {
    try {
      return JSON.stringify(value).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function reportQueueFull() {
    setSessionStatus("Input paused");
    reportError(new Error("Board event queue is full"));
  }

  function render() {
    pendingRenderFrame = null;
    resizeCanvasToDisplaySize(canvas);
    renderBoardState(
      ctx,
      snapshotBoardState(state),
      {
        width: canvas.width,
        height: canvas.height,
      },
      { onBackgroundLoad: scheduleRender },
    );
  }

  function scheduleRender() {
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
      window.addEventListener("resize", handleWindowResize);
      cleanup.push(() => {
        window.removeEventListener("resize", handleWindowResize);
      });
    }

    return () => {
      for (const cleanupResize of cleanup) {
        cleanupResize();
      }
    };
  }

  function updateControls() {
    if (elements.surfaceSelect) {
      elements.surfaceSelect.value = state.surface;
      setSurfaceIndicator(elements.surfaceSelect, state.surface);
    }

    const pen = compatiblePen(state.surface);
    if (elements.penButton) {
      setButtonLabel(elements.penButton, TOOL_LABELS[pen]);
      elements.penButton.title = `${TOOL_LABELS[pen]} for ${
        SURFACE_LABELS[state.surface]
      }`;
    }

    setPressed(elements.penButton, mode === "draw");
    setPressed(elements.eraserButton, mode === "eraser");
    setPressed(elements.pointerButton, mode === "pointer");
    setPressed(elements.ephemeralToggle, ephemeralEnabled);
    setPresenterControlsDisabled();
    updateMorePanel();
    updateColorControls();
    updateSizeControls();
    updateMobileToolbar();
  }

  function setMode(nextMode) {
    if (presenterLocked) {
      return;
    }
    mode = nextMode;
    collapseToolbarAfterCompactChoice();
    updateControls();
  }

  function setToolbarExpanded(expanded) {
    toolbarExpanded = Boolean(expanded);
    updateMobileToolbar();
  }

  function handleRelayPresence(event) {
    const count = viewerCountFromPresenceEvent(event);
    if (count === null) {
      return;
    }

    relayViewerCount = count;
    if (connectionState === "open") {
      setConnectedSessionStatus();
    }
  }

  function viewerCountFromPresenceEvent(event) {
    const count = event?.payload?.viewerCount;
    if (!Number.isFinite(count) || count < 0) {
      return null;
    }
    return Math.floor(count);
  }

  function setConnectedSessionStatus() {
    if (relayViewerCount === null) {
      setSessionStatus("Relay connected");
      return;
    }

    if (relayViewerCount === 0) {
      setSessionStatus("No viewers connected", { label: "0 view" });
      return;
    }

    if (relayViewerCount === 1) {
      setSessionStatus("1 viewer connected", { label: "1 view" });
      return;
    }

    setSessionStatus(`${relayViewerCount} viewers connected`, {
      label: `${relayViewerCount} views`,
    });
  }

  function handleWindowResize() {
    render();
    syncToolbarForViewport();
  }

  function syncToolbarForViewport() {
    const nextCompactViewport = isCompactMobileViewport();
    if (nextCompactViewport === compactViewport) {
      return;
    }

    compactViewport = nextCompactViewport;
    toolbarExpanded = !compactViewport;
    updateMobileToolbar();
  }

  function collapseToolbarForCanvasInput() {
    if (isCompactMobileViewport()) {
      setToolbarExpanded(false);
    }
  }

  function collapseToolbarAfterCompactChoice() {
    if (isCompactMobileViewport()) {
      toolbarExpanded = false;
    }
  }

  function updateMobileToolbar() {
    const surfaceColor =
      SURFACE_COLORS[state.surface] ?? SURFACE_COLORS.whiteboard;
    elements.root?.style?.setProperty?.("--surface-color", surfaceColor);
    elements.root?.classList?.toggle("is-toolbar-collapsed", !toolbarExpanded);
    elements.toolbarToggleButton?.setAttribute?.(
      "aria-expanded",
      String(toolbarExpanded),
    );

    const visibleMode = mode === "draw" ? "draw" : mode;
    for (const icon of elements.mobileToolIcons ?? []) {
      icon.hidden = icon.dataset?.mobileToolIcon !== visibleMode;
    }

    const label =
      mode === "draw"
        ? TOOL_LABELS[currentTool(state.surface)]
        : TOOL_LABELS[mode];
    setText(elements.mobileToolLabel, label);

    if (elements.mobileColorDot) {
      elements.mobileColorDot.hidden = mode !== "draw";
      elements.mobileColorDot.style?.setProperty?.(
        "--mobile-ink-color",
        selectedColorForSurface(state.surface),
      );
      elements.mobileColorDot.setAttribute?.(
        "aria-hidden",
        String(mode !== "draw"),
      );
    }

    if (elements.mobileFadeBadge) {
      elements.mobileFadeBadge.hidden = !ephemeralEnabled;
      elements.mobileFadeBadge.setAttribute?.(
        "aria-hidden",
        String(!ephemeralEnabled),
      );
    }
  }

  function isCompactMobileViewport() {
    try {
      return Boolean(window?.matchMedia?.("(max-width: 640px)")?.matches);
    } catch {
      return false;
    }
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
    const viewport = boardViewportForSize({ width, height });

    return roundPoint(normalizePoint({
      x: (event.clientX - rect.left - viewport.x) / (viewport.width || width),
      y: (event.clientY - rect.top - viewport.y) / (viewport.height || height),
      pressure: event.pressure,
    }));
  }

  function publishStrokePoint(stroke, point) {
    const event = publish("stroke:point", {
      strokeId: stroke.strokeId,
      point,
    });
    if (event) {
      stroke.lastPoint = point;
    }
    return event;
  }

  function publishFinalPointIfChanged(stroke, point) {
    if (!hasPointMoved(stroke.lastPoint, point)) {
      return true;
    }

    return Boolean(publishStrokePoint(stroke, point));
  }

  function selectedColorForSurface(surface) {
    const selected = selectedColors.get(surface);
    const options = colorOptionsForSurface(surface);
    return options.some((option) => option.color === selected)
      ? selected
      : options[0].color;
  }

  function updateColorControls() {
    const options = colorOptionsForSurface(state.surface);
    const selected = selectedColorForSurface(state.surface);

    for (const [index, colorButton] of (elements.colorButtons ?? []).entries()) {
      const option = options[index];
      colorButton.hidden = !option;
      if (!option) {
        continue;
      }

      colorButton.style?.setProperty?.("--swatch-color", option.color);
      colorButton.title = option.label;
      colorButton.setAttribute?.("aria-label", option.label);
      colorButton.dataset.color = option.color;
      colorButton.classList?.toggle("is-active", option.color === selected);
      colorButton.disabled = presenterLocked;
    }
  }

  function updateSizeControls() {
    if (elements.tipSizeInput) {
      elements.tipSizeInput.value = String(tipWidth);
    }
    if (elements.tipSizeOutput) {
      elements.tipSizeOutput.textContent = String(tipWidth);
    }
    if (elements.eraserSizeInput) {
      elements.eraserSizeInput.value = String(eraserWidth);
    }
    if (elements.eraserSizeOutput) {
      elements.eraserSizeOutput.textContent = String(eraserWidth);
    }
  }

  function setPresenterControlsDisabled() {
    for (const control of controlElements()) {
      if (control) {
        control.disabled = presenterLocked;
      }
    }

    if (elements.undoButton) {
      elements.undoButton.disabled = presenterLocked || undoStack.length === 0;
    }
    if (elements.quickUndoButton) {
      elements.quickUndoButton.disabled =
        presenterLocked || undoStack.length === 0;
    }
    if (elements.toolbarToggleButton) {
      elements.toolbarToggleButton.disabled = presenterLocked;
    }
    if (elements.copyViewerButton) {
      elements.copyViewerButton.disabled =
        presenterLocked || !currentViewerURL;
    }
    if (elements.backgroundFileInput) {
      elements.backgroundFileInput.disabled = presenterLocked;
    }
    if (elements.backgroundUploadButton) {
      elements.backgroundUploadButton.disabled = presenterLocked;
    }
    if (elements.backgroundCaptureButton) {
      const captureDisabled = presenterLocked || !screenCaptureSupported();
      elements.backgroundCaptureButton.disabled = captureDisabled;
      elements.backgroundCaptureButton.setAttribute?.(
        "aria-disabled",
        String(captureDisabled),
      );
      elements.backgroundCaptureButton.title = captureDisabled
        ? "Capture requires HTTPS or localhost"
        : "Capture window";
    }
    if (elements.backgroundRemoveButton) {
      elements.backgroundRemoveButton.disabled =
        presenterLocked || !state.background;
    }
  }

  function controlElements() {
    return [
      elements.surfaceSelect,
      elements.penButton,
      elements.eraserButton,
      elements.pointerButton,
      elements.ephemeralToggle,
      elements.tipSizeInput,
      elements.eraserSizeInput,
      elements.clearButton,
      elements.moreButton,
      elements.copyViewerButton,
      elements.quickUndoButton,
      elements.backgroundFileInput,
      elements.backgroundUploadButton,
      elements.backgroundRemoveButton,
      ...(elements.colorButtons ?? []),
    ];
  }

  function lockPresenterControls() {
    presenterLocked = true;
    activeStroke = null;
    activePointerId = null;
    connectionState = "closed";
    connectionPromise = null;
    connectionGeneration += 1;
    clearQueuedEvents();
    transport.close();
    setText(elements.sessionStatus, "Presenter active elsewhere");
    updateControls();
  }

  function setSessionStatus(message, options = {}) {
    if (manageSessionStatus) {
      setText(
        elements.sessionStatus,
        options.label ?? SESSION_STATUS_LABELS[message] ?? message,
      );
      elements.sessionStatus?.setAttribute?.("title", options.title ?? message);
      elements.sessionStatus?.setAttribute?.("aria-label", message);
    }
  }

  function updateMorePanel() {
    if (elements.sharePanel) {
      elements.sharePanel.hidden = !morePanelExpanded;
    }
    elements.moreButton?.setAttribute?.(
      "aria-expanded",
      String(morePanelExpanded),
    );
  }

  function setCopyViewerButtonLabel(label) {
    if (elements.copyViewerButton) {
      elements.copyViewerButton.textContent = label;
    }
  }

  function setBackgroundStatus(message) {
    setText(elements.backgroundStatus, message);
  }
}

export function createBoardApp({
  document = globalThis.document,
  location = globalThis.location,
  WebSocketImpl = globalThis.WebSocket,
  createRelayTransport = createWebSocketRelayTransport,
  copyText = defaultCopyText,
  reportError = defaultReportError,
} = {}) {
  const root = document?.querySelector?.("#board-app");
  if (!root) {
    return null;
  }

  const sessionStatus = root.querySelector("[data-board-session]");
  setText(sessionStatus, "Relay");

  const transport = createRelayTransport({
    url: createRelayURL(location, "board"),
    WebSocketImpl,
  });
  const controller = createBoardController({
    elements: {
      root,
      canvas: root.querySelector("[data-board-canvas]"),
      surfaceSelect: root.querySelector("[data-board-control='surface']"),
      penButton: root.querySelector("[data-board-control='pen']"),
      eraserButton: root.querySelector("[data-board-control='eraser']"),
      pointerButton: root.querySelector("[data-board-control='pointer']"),
      colorButtons: Array.from(
        root.querySelectorAll?.("[data-board-control='color']") ?? [],
      ),
      tipSizeInput: root.querySelector("[data-board-control='tip-size']"),
      tipSizeOutput: root.querySelector("[data-board-output='tip-size']"),
      eraserSizeInput: root.querySelector("[data-board-control='eraser-size']"),
      eraserSizeOutput: root.querySelector("[data-board-output='eraser-size']"),
      ephemeralToggle: root.querySelector("[data-board-control='ephemeral']"),
      undoButton: root.querySelector("[data-board-control='undo']"),
      quickUndoButton: root.querySelector("[data-board-control='quick-undo']"),
      moreButton: root.querySelector("[data-board-control='more']"),
      sharePanel: root.querySelector("[data-board-share-panel]"),
      shareViewerLink: root.querySelector("[data-board-share-link]"),
      shareViewerInput: root.querySelector("[data-board-share-input]"),
      shareViewerQR: root.querySelector("[data-board-share-qr]"),
      copyViewerButton: root.querySelector("[data-board-control='copy-viewer']"),
      backgroundFileInput: root.querySelector(
        "[data-board-control='background-file']",
      ),
      backgroundUploadButton: root.querySelector(
        "[data-board-control='background-upload']",
      ),
      backgroundCaptureButton: root.querySelector(
        "[data-board-control='background-capture']",
      ),
      backgroundRemoveButton: root.querySelector(
        "[data-board-control='background-remove']",
      ),
      backgroundStatus: root.querySelector("[data-board-background-status]"),
      toolbarToggleButton: root.querySelector(
        "[data-board-control='toolbar-toggle']",
      ),
      toolbarCloseButton: root.querySelector(
        "[data-board-control='toolbar-close']",
      ),
      mobileToolLabel: root.querySelector("[data-mobile-tool-label]"),
      mobileToolIcons: Array.from(
        root.querySelectorAll?.("[data-mobile-tool-icon]") ?? [],
      ),
      mobileColorDot: root.querySelector("[data-mobile-color-dot]"),
      mobileFadeBadge: root.querySelector("[data-mobile-fade-badge]"),
      clearButton: root.querySelector("[data-board-control='clear']"),
      sessionStatus,
    },
    transport,
    reportError,
    copyText,
    manageSessionStatus: true,
    viewerURL: createViewerRelayURL(location),
  });

  controller.connect().catch((error) => {
    if (isBoardControllerClosedError(error)) {
      return;
    }

    reportError(error);
  });

  return controller;
}

function defaultScreenCaptureSupported() {
  return Boolean(
    globalThis.isSecureContext &&
      globalThis.navigator?.mediaDevices?.getDisplayMedia,
  );
}

async function defaultReadBackgroundFile(file) {
  if (!isImageFile(file)) {
    throw new TypeError("background file must be an image");
  }

  return backgroundFromDataUrl(await readFileAsDataURL(file));
}

async function defaultCaptureDisplayBackground() {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (typeof mediaDevices?.getDisplayMedia !== "function") {
    throw new Error("display capture is unavailable");
  }

  const stream = await mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });

  try {
    return await backgroundFromMediaStream(stream);
  } finally {
    for (const track of stream.getTracks?.() ?? []) {
      track.stop?.();
    }
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(String(reader.result ?? ""));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("image read failed"));
    });
    reader.readAsDataURL(file);
  });
}

async function backgroundFromDataUrl(dataUrl) {
  const image = await loadImage(dataUrl);
  return backgroundFromDrawable(
    image,
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("image decode failed")),
      { once: true },
    );
    image.src = dataUrl;
  });
}

async function backgroundFromMediaStream(stream) {
  const document = globalThis.document;
  if (!document?.createElement) {
    throw new Error("document is unavailable for capture");
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  await waitForVideoReady(video);
  return backgroundFromDrawable(
    video,
    video.videoWidth || BACKGROUND_MAX_WIDTH,
    video.videoHeight || BACKGROUND_MAX_HEIGHT,
  );
}

async function waitForVideoReady(video) {
  if (typeof video.play === "function") {
    await video.play();
  }

  if (video.readyState < 2) {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("capture video failed")),
        { once: true },
      );
    });
  }

  await new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => resolve());
      return;
    }

    globalThis.setTimeout?.(resolve, 100);
  });
}

function backgroundFromDrawable(drawable, sourceWidth, sourceHeight) {
  const document = globalThis.document;
  if (!document?.createElement) {
    throw new Error("document is unavailable for image processing");
  }

  const size = fitInside(
    sourceWidth,
    sourceHeight,
    BACKGROUND_MAX_WIDTH,
    BACKGROUND_MAX_HEIGHT,
  );
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);

  return {
    kind: "image",
    dataUrl: canvas.toDataURL("image/jpeg", BACKGROUND_JPEG_QUALITY),
    width: canvas.width,
    height: canvas.height,
  };
}

function fitInside(width, height, maxWidth, maxHeight) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : maxWidth;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : maxHeight;
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);

  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function imageFileFromClipboard(clipboardData) {
  const directFile = firstImageFile(clipboardData?.files);
  if (directFile) {
    return directFile;
  }

  for (const item of Array.from(clipboardData?.items ?? [])) {
    if (String(item?.type ?? "").startsWith("image/")) {
      const file = item.getAsFile?.();
      if (file) {
        return file;
      }
    }
  }

  return null;
}

function firstImageFile(files) {
  return Array.from(files ?? []).find(isImageFile) ?? null;
}

function isImageFile(file) {
  return String(file?.type ?? "").startsWith("image/");
}

function surfaceName(value) {
  const surface = String(value ?? "").toLowerCase();
  return SURFACES.has(surface) ? surface : "whiteboard";
}

function compatiblePen(surface) {
  return PEN_BY_SURFACE[surface] ?? "marker";
}

function styleForTool(tool, _surface, options = {}) {
  if (tool === "eraser") {
    return {
      color: ERASER_STYLE.color,
      width: options.eraserWidth ?? ERASER_STYLE.width,
    };
  }

  return {
    color: options.color ?? COLOR_OPTIONS_BY_SURFACE.whiteboard[0].color,
    width: options.tipWidth ?? DEFAULT_TIP_WIDTH,
  };
}

function setPressed(element, pressed) {
  element?.classList?.toggle("is-active", pressed);
  element?.setAttribute?.("aria-pressed", String(pressed));
}

function setButtonLabel(button, label) {
  const labelElement = button?.querySelector?.("[data-tool-label]");
  if (labelElement) {
    labelElement.textContent = label;
    return;
  }

  if (button) {
    button.textContent = label;
  }
}

function setSurfaceIndicator(surfaceSelect, surface) {
  const toolbar = surfaceSelect?.closest?.(".toolbar");
  toolbar?.style?.setProperty?.(
    "--surface-color",
    SURFACE_COLORS[surface] ?? SURFACE_COLORS.whiteboard,
  );
  toolbar?.setAttribute?.("data-surface", surface);

  const label = toolbar?.querySelector?.("[data-surface-label]");
  if (label) {
    label.textContent =
      SURFACE_SHORT_LABELS[surface] ?? SURFACE_SHORT_LABELS.whiteboard;
  }
}

function colorOptionsForSurface(surface) {
  return COLOR_OPTIONS_BY_SURFACE[surface] ?? COLOR_OPTIONS_BY_SURFACE.whiteboard;
}

function coalescedPointerEvents(event) {
  try {
    const events = event.getCoalescedEvents?.();
    return events?.length ? events : [event];
  } catch {
    return [event];
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function roundPoint(point) {
  return {
    x: roundCoordinate(point.x),
    y: roundCoordinate(point.y),
    pressure: roundCoordinate(point.pressure),
  };
}

function roundCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function hasPointMoved(previous, next) {
  if (!previous || !next) {
    return true;
  }

  const dx = previous.x - next.x;
  const dy = previous.y - next.y;
  return dx * dx + dy * dy > FINAL_POINT_EPSILON;
}

function createViewerRelayURL(location) {
  const base = `${location.protocol}//${location.host}`;
  return new URL("/viewer", base).href;
}

function updateViewerShareElements(elements, viewerURL) {
  const url = String(viewerURL ?? "");
  const hasURL = url.length > 0;
  if (elements.shareViewerLink) {
    if (hasURL) {
      elements.shareViewerLink.href = url;
      elements.shareViewerLink.setAttribute?.("href", url);
    } else {
      elements.shareViewerLink.href = "";
      elements.shareViewerLink.removeAttribute?.("href");
    }
    elements.shareViewerLink.setAttribute?.(
      "aria-disabled",
      String(!hasURL),
    );
  }
  if (elements.shareViewerInput) {
    elements.shareViewerInput.value = url;
    elements.shareViewerInput.placeholder = hasURL
      ? ""
      : "Waiting for viewer link";
  }
  if (elements.shareViewerQR) {
    const document = elements.shareViewerQR.ownerDocument ?? globalThis.document;
    if (document?.createElementNS && document?.createElement) {
      elements.shareViewerQR.replaceChildren?.(
        hasURL
          ? createShareQRCodeElement(document, url, "Viewer", {
              className: "share-qr board-share-qr",
              fallbackClassName: "share-qr-fallback board-share-qr-fallback",
            })
          : createWaitingViewerLinkElement(document),
      );
    }
  }
}

function createWaitingViewerLinkElement(document) {
  const element = document.createElement("span");
  element.className = "share-qr-fallback board-share-qr-fallback";
  element.textContent = "Waiting for link";
  return element;
}

function setText(element, message) {
  if (element) {
    element.textContent = message;
  }
}

function defaultReportError(error) {
  console.error("Board transport error", error);
}

function isBoardControllerClosedError(error) {
  return error instanceof Error && error.message === "board controller is closed";
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
