import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createBoardApp,
  createBoardController,
  createRelayURL,
  createSignalURL,
} from "./board.js";

function createFakeElement(properties = {}) {
  const listeners = new Map();

  return {
    disabled: false,
    hidden: false,
    textContent: "",
    value: "",
    checked: false,
    classList: createFakeClassList(),
    dataset: {},
    style: createFakeStyle(),
    ...properties,
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    querySelector(selector) {
      return this.children?.get(selector) ?? null;
    },
    append(...children) {
      this.childrenList ??= [];
      this.childrenList.push(...children);
    },
    replaceChildren(...children) {
      this.childrenList = [...children];
    },
    querySelectorAll(selector) {
      const result = this.children?.get(selector);
      if (Array.isArray(result)) {
        return result;
      }
      return result ? [result] : [];
    },
    closest(selector) {
      return this.closestMatches?.get(selector) ?? null;
    },
    setAttribute(name, value) {
      this.attributes ??= new Map();
      this.attributes.set(name, String(value));
    },
    removeAttribute(name) {
      this.attributes?.delete(name);
    },
    dispatch(type, properties = {}) {
      const event = createFakeEvent(type, this, properties);
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
      return event;
    },
  };
}

function createFakeStyle() {
  const values = new Map();

  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    getPropertyValue(name) {
      return values.get(name) ?? "";
    },
  };
}

function createFakeDocument(root, selector = "#board-app") {
  return {
    querySelector(requestedSelector) {
      return requestedSelector === selector ? root : null;
    },
    createElement(tagName) {
      return createFakeElement({ tagName });
    },
    createElementNS(_namespace, tagName) {
      return createFakeElement({ tagName });
    },
  };
}

function createFakeClassList() {
  const names = new Set();

  return {
    add(name) {
      names.add(name);
    },
    remove(name) {
      names.delete(name);
    },
    toggle(name, enabled) {
      if (enabled) {
        names.add(name);
      } else {
        names.delete(name);
      }
    },
    contains(name) {
      return names.has(name);
    },
  };
}

function createFakeEvent(type, target, properties) {
  return {
    type,
    target,
    currentTarget: target,
    button: 0,
    pointerId: 1,
    pressure: 0,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...properties,
  };
}

function createFakeCanvas(rect = { left: 10, top: 20, width: 200, height: 100 }) {
  const canvas = createFakeElement({
    width: rect.width,
    height: rect.height,
    capturedPointers: [],
    releasedPointers: [],
    getBoundingClientRect() {
      return rect;
    },
    getContext(type) {
      assert.equal(type, "2d");
      return createFakeCanvasContext();
    },
    setPointerCapture(pointerId) {
      this.capturedPointers.push(pointerId);
    },
    releasePointerCapture(pointerId) {
      this.releasedPointers.push(pointerId);
    },
  });

  return canvas;
}

function createFakeCanvasContext() {
  return {
    clearRect() {},
    save() {},
    restore() {},
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    stroke() {},
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createFakeTransport(options = {}) {
  const handlers = new Set();
  const statusHandlers = new Set();
  const connection = createDeferred();
  let open = Boolean(options.open);

  return {
    sent: [],
    connected: false,
    closed: false,
    connectCalls: 0,
    connect() {
      this.connectCalls += 1;
      if (options.deferConnect) {
        return connection.promise.then(() => {
          this.connected = true;
          open = true;
        });
      }

      if (options.rejectConnect) {
        return Promise.reject(new Error("connect failed"));
      }

      this.connected = true;
      open = true;
      return Promise.resolve();
    },
    resolveConnect() {
      connection.resolve();
    },
    rejectConnect(error = new Error("connect failed")) {
      connection.reject(error);
    },
    send(event) {
      if (options.throwOnSend) {
        throw new Error("send failed");
      }
      if (options.throwBeforeOpen && !open) {
        throw new Error("transport is not open");
      }
      this.sent.push(event);
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => {
        statusHandlers.delete(handler);
      };
    },
    emit(event) {
      for (const handler of handlers) {
        handler(event);
      }
    },
    emitStatus(status) {
      for (const handler of statusHandlers) {
        handler(status);
      }
    },
    close() {
      this.closed = true;
    },
  };
}

function createFakeSignalingClient(options = {}) {
  const handlers = new Set();
  const connection = createDeferred();

  return {
    connected: false,
    closed: false,
    connectCalls: 0,
    createdSessions: [],
    joinedSessions: [],
    sentSignals: [],
    connect() {
      this.connectCalls += 1;
      if (options.deferConnect) {
        return connection.promise.then(() => {
          this.connected = true;
        });
      }

      if (options.rejectConnect) {
        return Promise.reject(new Error("signaling connect failed"));
      }

      this.connected = true;
      return Promise.resolve();
    },
    resolveConnect() {
      connection.resolve();
    },
    createSession(peerId) {
      this.createdSessions.push(peerId);
    },
    joinSession(sessionId, peerId) {
      this.joinedSessions.push({ sessionId, peerId });
    },
    sendSignal(message) {
      this.sentSignals.push(message);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(message) {
      for (const handler of handlers) {
        handler(message);
      }
    },
    close() {
      this.closed = true;
    },
  };
}

function createFakeTimers() {
  const scheduled = [];

  return {
    scheduled,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = scheduled.indexOf(timer);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    },
  };
}

function createFakeResizeObserverClass() {
  const instances = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      instances.push(this);
    }

    observe(element) {
      this.observed.push(element);
    }

    disconnect() {
      this.disconnected = true;
    }

    trigger() {
      this.callback([]);
    }
  }

  FakeResizeObserver.instances = instances;
  return FakeResizeObserver;
}

function createFakeWindow(options = {}) {
  const listeners = new Map();
  const animationFrames = [];

  return {
    matchMedia(query) {
      return {
        media: query,
        matches:
          query === "(max-width: 640px)" && Boolean(options.compactMobile),
        addEventListener() {},
        removeEventListener() {},
      };
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return callback;
    },
    cancelAnimationFrame(callback) {
      const index = animationFrames.indexOf(callback);
      if (index >= 0) {
        animationFrames.splice(index, 1);
      }
    },
    flushAnimationFrame() {
      const callbacks = animationFrames.splice(0);
      for (const callback of callbacks) {
        callback();
      }
    },
    pendingAnimationFrameCount() {
      return animationFrames.length;
    },
  };
}

function createFixture(options = {}) {
  const transport = options.transport ?? createFakeTransport();
  const timers = createFakeTimers();
  const renders = [];
  const errors = [];
  const colorButtons = Array.from({ length: 4 }, (_value, index) =>
    createFakeElement({ dataset: { colorIndex: String(index) } }),
  );
  const mobileToolIcons = ["draw", "eraser", "pointer"].map((mode) =>
    createFakeElement({ dataset: { mobileToolIcon: mode } }),
  );
  const elements = {
    root: createFakeElement(),
    canvas: createFakeCanvas(),
    surfaceSelect: createFakeElement({ value: "whiteboard" }),
    penButton: createFakeElement(),
    eraserButton: createFakeElement(),
    pointerButton: createFakeElement(),
    ephemeralToggle: createFakeElement({ checked: false }),
    colorButtons,
    tipSizeInput: createFakeElement({ value: "6" }),
    tipSizeOutput: createFakeElement(),
    eraserSizeInput: createFakeElement({ value: "18" }),
    eraserSizeOutput: createFakeElement(),
    undoButton: createFakeElement(),
    quickUndoButton: createFakeElement(),
    moreButton: createFakeElement(),
    sharePanel: createFakeElement({ hidden: true }),
    shareViewerLink: createFakeElement(),
    shareViewerInput: createFakeElement(),
    shareViewerQR: createFakeElement({ ownerDocument: createFakeDocument(null) }),
    copyViewerButton: createFakeElement(),
    toolbarToggleButton: createFakeElement(),
    toolbarCloseButton: createFakeElement(),
    mobileToolLabel: createFakeElement(),
    mobileToolIcons,
    mobileColorDot: createFakeElement(),
    mobileFadeBadge: createFakeElement(),
    clearButton: createFakeElement(),
    sessionStatus: createFakeElement(),
  };

  const controller = createBoardController({
    elements,
    transport,
    now:
      typeof options.now === "function"
        ? options.now
        : () => options.now ?? 10_000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    window: options.window,
    ResizeObserverImpl: options.ResizeObserverImpl,
    maxQueuedEvents: options.maxQueuedEvents,
    manageSessionStatus: options.manageSessionStatus,
    viewerURL: options.viewerURL,
    copyText: options.copyText,
    resizeCanvasToDisplaySize:
      options.resizeCanvasToDisplaySize ?? (() => false),
    renderBoardState: (_ctx, snapshot) => renders.push(snapshot),
    reportError:
      options.reportError ??
      ((error) => {
        errors.push(error);
      }),
  });

  return { controller, elements, transport, timers, renders, errors };
}

function createBoardAppRoot() {
  const colorButtons = Array.from({ length: 4 }, (_value, index) =>
    createFakeElement({ dataset: { colorIndex: String(index) } }),
  );
  const mobileToolIcons = ["draw", "eraser", "pointer"].map((mode) =>
    createFakeElement({ dataset: { mobileToolIcon: mode } }),
  );
  const children = new Map([
    ["[data-board-canvas]", createFakeCanvas()],
    ["[data-board-control='surface']", createFakeElement({ value: "whiteboard" })],
    ["[data-board-control='pen']", createFakeElement()],
    ["[data-board-control='eraser']", createFakeElement()],
    ["[data-board-control='pointer']", createFakeElement()],
    [
      "[data-board-control='ephemeral']",
      createFakeElement({ checked: false }),
    ],
    ["[data-board-control='color']", colorButtons],
    ["[data-board-control='tip-size']", createFakeElement({ value: "6" })],
    ["[data-board-output='tip-size']", createFakeElement()],
    ["[data-board-control='eraser-size']", createFakeElement({ value: "18" })],
    ["[data-board-output='eraser-size']", createFakeElement()],
    ["[data-board-control='undo']", createFakeElement()],
    ["[data-board-control='quick-undo']", createFakeElement()],
    ["[data-board-control='more']", createFakeElement()],
    ["[data-board-share-panel]", createFakeElement({ hidden: true })],
    ["[data-board-share-link]", createFakeElement()],
    ["[data-board-share-input]", createFakeElement()],
    ["[data-board-share-qr]", createFakeElement({ ownerDocument: createFakeDocument(null) })],
    ["[data-board-control='copy-viewer']", createFakeElement()],
    ["[data-board-control='toolbar-toggle']", createFakeElement()],
    ["[data-board-control='toolbar-close']", createFakeElement()],
    ["[data-mobile-tool-label]", createFakeElement()],
    ["[data-mobile-tool-icon]", mobileToolIcons],
    ["[data-mobile-color-dot]", createFakeElement()],
    ["[data-mobile-fade-badge]", createFakeElement()],
    ["[data-board-control='clear']", createFakeElement()],
    ["[data-board-session]", createFakeElement()],
  ]);

  return createFakeElement({ children });
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function eventTypes(events) {
  return events.map((event) => event.type);
}

test("createRelayURL maps http and https locations to /ws/relay", () => {
  assert.equal(
    createRelayURL({ protocol: "http:", host: "local.test:8080" }),
    "ws://local.test:8080/ws/relay",
  );
  assert.equal(
    createRelayURL({ protocol: "https:", host: "board.test" }),
    "wss://board.test/ws/relay",
  );
  assert.equal(
    createRelayURL({ protocol: "http:", host: "local.test:8080" }, "board"),
    "ws://local.test:8080/ws/relay?role=board",
  );
});

test("createSignalURL maps http and https locations to /signal", () => {
  assert.equal(
    createSignalURL({ protocol: "http:", host: "local.test:8080" }),
    "ws://local.test:8080/signal",
  );
  assert.equal(
    createSignalURL({ protocol: "https:", host: "board.test" }),
    "wss://board.test/signal",
  );
});

test("board app defaults to relay transport", () => {
  const root = createBoardAppRoot();
  const relayTransport = createFakeTransport();
  const relayCalls = [];
  const signalingCalls = [];

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: { protocol: "http:", host: "local.test:8080", search: "" },
    WebSocketImpl: class FakeWebSocket {},
    createRelayTransport(options) {
      relayCalls.push(options);
      return relayTransport;
    },
    createSignalingClientImpl(options) {
      signalingCalls.push(options);
      return createFakeSignalingClient();
    },
  });

  assert.equal(controller.getSnapshot().surface, "whiteboard");
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, "ws://local.test:8080/ws/relay?role=board");
  assert.equal(relayTransport.connectCalls, 1);
  assert.deepEqual(signalingCalls, []);

  controller.close();
});

test("board app honors explicit relay transport mode", () => {
  const root = createBoardAppRoot();
  const relayTransport = createFakeTransport();
  const relayCalls = [];

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "board.test",
      search: "?transport=relay",
    },
    WebSocketImpl: class FakeWebSocket {},
    createRelayTransport(options) {
      relayCalls.push(options);
      return relayTransport;
    },
    createSignalingClientImpl() {
      throw new Error("signaling should not be used in relay mode");
    },
  });

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, "wss://board.test/ws/relay?role=board");
  assert.equal(relayTransport.connectCalls, 1);

  controller.close();
});

test("board app ignores expected close during a pending relay connection", async () => {
  const root = createBoardAppRoot();
  const relayTransport = createFakeTransport({ deferConnect: true });
  const errors = [];

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: { protocol: "http:", host: "local.test:8080", search: "" },
    WebSocketImpl: class FakeWebSocket {},
    createRelayTransport() {
      return relayTransport;
    },
    reportError(error) {
      errors.push(error);
    },
  });

  controller.close();
  relayTransport.resolveConnect();
  await flushAsyncWork();

  assert.deepEqual(errors, []);
});

test("webrtc board creates a session and waits for viewer ready before connecting data channel", async () => {
  const root = createBoardAppRoot();
  const signaling = createFakeSignalingClient();
  const webRTCTransport = createFakeTransport();
  const signalingCalls = [];
  const webRTCCalls = [];
  const errors = [];
  class FakeRTCPeerConnection {}

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "board.test",
      search: "?transport=webrtc",
    },
    WebSocketImpl: class FakeWebSocket {},
    RTCPeerConnectionImpl: FakeRTCPeerConnection,
    createPeerId: () => "board-peer",
    createRelayTransport() {
      throw new Error("relay should not be used in webrtc mode");
    },
    createSignalingClientImpl(options) {
      signalingCalls.push(options);
      return signaling;
    },
    createWebRTCTransport(options) {
      webRTCCalls.push(options);
      return webRTCTransport;
    },
    reportError(error) {
      errors.push(error);
    },
  });

  await flushAsyncWork();

  assert.equal(signalingCalls.length, 1);
  assert.equal(signalingCalls[0].url, "wss://board.test/signal");
  assert.equal(signaling.connectCalls, 1);
  assert.deepEqual(signaling.createdSessions, ["board-peer"]);
  assert.deepEqual(webRTCCalls, []);

  signaling.emit({
    type: "session:created",
    sessionId: "session-42",
    peerId: "board-peer",
    role: "board",
  });
  await flushAsyncWork();

  assert.match(
    root.querySelector("[data-board-session]").textContent,
    /session-42/,
  );
  assert.match(
    root.querySelector("[data-board-session]").textContent,
    /\/viewer\?transport=webrtc&sessionId=session-42/,
  );
  assert.deepEqual(webRTCCalls, []);

  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  assert.equal(webRTCCalls.length, 1);
  assert.equal(webRTCCalls[0].signaling, signaling);
  assert.equal(webRTCCalls[0].role, "board");
  assert.equal(webRTCCalls[0].sessionId, "session-42");
  assert.equal(webRTCCalls[0].peerId, "board-peer");
  assert.equal(webRTCCalls[0].RTCPeerConnectionImpl, FakeRTCPeerConnection);
  assert.equal(webRTCTransport.connectCalls, 1);
  assert.deepEqual(errors, []);

  webRTCTransport.emitStatus("disconnected");
  await flushAsyncWork();

  assert.equal(
    root.querySelector("[data-board-session]").textContent,
    "WebRTC reconnecting",
  );

  controller.close();
});

test("webrtc board does not expose an incomplete viewer share link before session creation", async () => {
  const root = createBoardAppRoot();
  const signaling = createFakeSignalingClient();
  const copied = [];
  class FakeRTCPeerConnection {}

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "board.test",
      search: "?transport=webrtc",
    },
    WebSocketImpl: class FakeWebSocket {},
    RTCPeerConnectionImpl: FakeRTCPeerConnection,
    createPeerId: () => "board-peer",
    createRelayTransport() {
      throw new Error("relay should not be used in webrtc mode");
    },
    createSignalingClientImpl() {
      return signaling;
    },
    createWebRTCTransport() {
      return createFakeTransport();
    },
    copyText(value) {
      copied.push(value);
      return Promise.resolve();
    },
  });
  await flushAsyncWork();

  const shareLink = root.querySelector("[data-board-share-link]");
  const shareInput = root.querySelector("[data-board-share-input]");
  const shareQR = root.querySelector("[data-board-share-qr]");
  const copyButton = root.querySelector("[data-board-control='copy-viewer']");

  assert.equal(shareLink.href, "");
  assert.equal(shareLink.attributes.get("aria-disabled"), "true");
  assert.equal(shareInput.value, "");
  assert.equal(shareInput.placeholder, "Waiting for viewer link");
  assert.equal(copyButton.disabled, true);
  assert.equal(shareQR.childrenList[0].textContent, "Waiting for link");

  copyButton.dispatch("click");
  await flushAsyncWork();
  assert.deepEqual(copied, []);

  signaling.emit({
    type: "session:created",
    sessionId: "session-42",
    peerId: "board-peer",
    role: "board",
  });
  await flushAsyncWork();

  const viewerURL =
    "https://board.test/viewer?transport=webrtc&sessionId=session-42";
  assert.equal(shareLink.href, viewerURL);
  assert.equal(shareLink.attributes.get("aria-disabled"), "false");
  assert.equal(shareInput.value, viewerURL);
  assert.equal(shareInput.placeholder, "");
  assert.equal(copyButton.disabled, false);

  copyButton.dispatch("click");
  await flushAsyncWork();
  assert.deepEqual(copied, [viewerURL]);

  controller.close();
});

test("webrtc board reconnects data channel after established disconnect", async () => {
  const root = createBoardAppRoot();
  const signaling = createFakeSignalingClient();
  const webRTCTransports = [createFakeTransport(), createFakeTransport()];
  const webRTCCalls = [];

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "board.test",
      search: "?transport=webrtc",
    },
    WebSocketImpl: class FakeWebSocket {},
    RTCPeerConnectionImpl: class FakeRTCPeerConnection {},
    createPeerId: () => "board-peer",
    createRelayTransport() {
      throw new Error("relay should not be used in webrtc mode");
    },
    createSignalingClientImpl() {
      return signaling;
    },
    createWebRTCTransport(options) {
      webRTCCalls.push(options);
      return webRTCTransports[webRTCCalls.length - 1];
    },
  });
  await flushAsyncWork();

  signaling.emit({
    type: "session:created",
    sessionId: "session-42",
    peerId: "board-peer",
    role: "board",
  });
  await flushAsyncWork();
  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  assert.equal(webRTCCalls.length, 1);
  assert.equal(webRTCTransports[0].connectCalls, 1);

  webRTCTransports[0].emitStatus("disconnected");
  await flushAsyncWork();

  assert.equal(
    root.querySelector("[data-board-session]").textContent,
    "WebRTC reconnecting",
  );

  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  assert.equal(webRTCCalls.length, 2);
  assert.equal(webRTCCalls[1].sessionId, "session-42");
  assert.equal(webRTCTransports[1].connectCalls, 1);
  assert.match(
    root.querySelector("[data-board-session]").textContent,
    /session-42/,
  );
  assert.match(
    root.querySelector("[data-board-session]").textContent,
    /\/viewer\?transport=webrtc&sessionId=session-42/,
  );

  controller.close();
});

test("webrtc board reconnects when signaling reports the viewer left", async () => {
  const root = createBoardAppRoot();
  const signaling = createFakeSignalingClient();
  const webRTCTransports = [createFakeTransport(), createFakeTransport()];
  const webRTCCalls = [];

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "board.test",
      search: "?transport=webrtc",
    },
    WebSocketImpl: class FakeWebSocket {},
    RTCPeerConnectionImpl: class FakeRTCPeerConnection {},
    createPeerId: () => "board-peer",
    createRelayTransport() {
      throw new Error("relay should not be used in webrtc mode");
    },
    createSignalingClientImpl() {
      return signaling;
    },
    createWebRTCTransport(options) {
      webRTCCalls.push(options);
      return webRTCTransports[webRTCCalls.length - 1];
    },
  });
  await flushAsyncWork();

  signaling.emit({
    type: "session:created",
    sessionId: "session-42",
    peerId: "board-peer",
    role: "board",
  });
  await flushAsyncWork();
  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  signaling.emit({
    type: "session:peer-left",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { role: "viewer" },
  });
  await flushAsyncWork();

  assert.equal(
    root.querySelector("[data-board-session]").textContent,
    "WebRTC reconnecting",
  );
  assert.equal(webRTCTransports[0].closed, true);

  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer-2",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  assert.equal(webRTCCalls.length, 2);
  assert.equal(webRTCCalls[1].sessionId, "session-42");
  assert.equal(webRTCTransports[1].connectCalls, 1);

  controller.close();
});

test("webrtc board reports data channel reconnect failures", async () => {
  const root = createBoardAppRoot();
  const signaling = createFakeSignalingClient();
  const webRTCTransports = [
    createFakeTransport(),
    createFakeTransport({ rejectConnect: true }),
  ];
  const errors = [];
  let transportIndex = 0;

  const controller = createBoardApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "board.test",
      search: "?transport=webrtc",
    },
    WebSocketImpl: class FakeWebSocket {},
    RTCPeerConnectionImpl: class FakeRTCPeerConnection {},
    createPeerId: () => "board-peer",
    createRelayTransport() {
      throw new Error("relay should not be used in webrtc mode");
    },
    createSignalingClientImpl() {
      return signaling;
    },
    createWebRTCTransport() {
      const transport = webRTCTransports[transportIndex];
      transportIndex += 1;
      return transport;
    },
    reportError(error) {
      errors.push(error);
    },
  });
  await flushAsyncWork();

  signaling.emit({
    type: "session:created",
    sessionId: "session-42",
    peerId: "board-peer",
    role: "board",
  });
  await flushAsyncWork();
  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  webRTCTransports[0].emitStatus("disconnected");
  await flushAsyncWork();
  signaling.emit({
    type: "signal:ice",
    sessionId: "session-42",
    peerId: "viewer-peer",
    payload: { onboardViewerReady: true },
  });
  await flushAsyncWork();

  assert.equal(
    root.querySelector("[data-board-session]").textContent,
    "WebRTC disconnected",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /connect failed/i);

  controller.close();
});

test("index HTML exposes relay and WebRTC flow links", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /href="\/board"/);
  assert.match(html, /href="\/viewer"/);
  assert.match(html, /href="\/board\?transport=webrtc"/);
  assert.match(html, /href="\/viewer\?transport=webrtc"/);
});

test("local publish uses a board-specific ID when relay snapshot already has evt_000001", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  transport.emit({
    id: "evt_000001",
    type: "board:set-surface",
    boardId: "default",
    at: 12345,
    payload: { surface: "blueboard" },
  });

  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");

  assert.equal(controller.getSnapshot().surface, "greenboard");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].type, "board:set-surface");
  assert.equal(transport.sent[0].payload.surface, "greenboard");
  assert.notEqual(transport.sent[0].id, "evt_000001");
  assert.match(transport.sent[0].id, /^evt_board_[a-z0-9]+_000001$/);
});

test("surface change sends board:set-surface and updates local state immediately", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].type, "board:set-surface");
  assert.deepEqual(transport.sent[0].payload, { surface: "greenboard" });
  assert.equal(controller.getSnapshot().surface, "greenboard");
  assert.equal(elements.penButton.textContent, "Chalk");
});

test("color swatches set the next stroke color for the current surface", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");
  elements.colorButtons[1].dispatch("click");
  transport.sent.length = 0;

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });

  assert.equal(transport.sent[0].type, "stroke:start");
  assert.equal(transport.sent[0].payload.surface, "greenboard");
  assert.equal(transport.sent[0].payload.tool, "chalk");
  assert.equal(transport.sent[0].payload.color, "#f8e08e");
});

test("tip size input sets marker and chalk stroke width", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.tipSizeInput.value = "10";
  elements.tipSizeInput.dispatch("input");
  elements.surfaceSelect.value = "blackboard";
  elements.surfaceSelect.dispatch("change");
  transport.sent.length = 0;

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });

  assert.equal(transport.sent[0].type, "stroke:start");
  assert.equal(transport.sent[0].payload.tool, "chalk");
  assert.equal(transport.sent[0].payload.width, 10);
  assert.equal(elements.tipSizeOutput.textContent, "10");
});

test("eraser size input sets eraser stroke width", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.eraserSizeInput.value = "34";
  elements.eraserSizeInput.dispatch("input");
  elements.eraserButton.dispatch("click");
  transport.sent.length = 0;

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });

  assert.equal(transport.sent[0].type, "stroke:start");
  assert.equal(transport.sent[0].payload.tool, "eraser");
  assert.equal(transport.sent[0].payload.width, 34);
  assert.equal(elements.eraserSizeOutput.textContent, "34");
});

test("rapid drawing events render once on the next animation frame", async () => {
  const fakeWindow = createFakeWindow();
  const { controller, elements, renders } = createFixture({
    window: fakeWindow,
  });
  const initialRenderCount = renders.length;

  await controller.connect();
  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 80,
    clientY: 75,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 100,
    clientY: 80,
    pointerId: 7,
  });

  assert.equal(renders.length, initialRenderCount);
  assert.equal(fakeWindow.pendingAnimationFrameCount(), 1);

  fakeWindow.flushAnimationFrame();

  assert.equal(renders.length, initialRenderCount + 1);
});

test("ResizeObserver resize rerenders the presenter board and is cleaned up", () => {
  const ResizeObserverImpl = createFakeResizeObserverClass();
  const { controller, elements, renders } = createFixture({
    ResizeObserverImpl,
  });
  const initialRenderCount = renders.length;

  assert.equal(ResizeObserverImpl.instances.length, 1);
  assert.deepEqual(ResizeObserverImpl.instances[0].observed, [elements.canvas]);

  ResizeObserverImpl.instances[0].trigger();

  assert.equal(renders.length, initialRenderCount + 1);

  controller.close();
  assert.equal(ResizeObserverImpl.instances[0].disconnected, true);
});

test("window resize fallback rerenders the presenter board and is cleaned up", () => {
  const fakeWindow = createFakeWindow();
  const { controller, renders } = createFixture({
    ResizeObserverImpl: null,
    window: fakeWindow,
  });
  const initialRenderCount = renders.length;

  assert.equal(fakeWindow.listenerCount("resize"), 1);

  fakeWindow.dispatch("resize");

  assert.equal(renders.length, initialRenderCount + 1);

  controller.close();
  assert.equal(fakeWindow.listenerCount("resize"), 0);
});

test("drawing gesture sends start, point, and end with normalized points and compatible tool", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.surfaceSelect.value = "blackboard";
  elements.surfaceSelect.dispatch("change");
  transport.sent.length = 0;

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pressure: 0.4,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 110,
    clientY: 45,
    pressure: 0.7,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 160,
    clientY: 95,
    pressure: 0.5,
    pointerId: 7,
  });

  assert.deepEqual(eventTypes(transport.sent), [
    "stroke:start",
    "stroke:point",
    "stroke:point",
    "stroke:end",
  ]);
  assert.equal(transport.sent[0].payload.surface, "blackboard");
  assert.equal(transport.sent[0].payload.tool, "chalk");
  assert.deepEqual(transport.sent[0].payload.point, {
    x: 0.21875,
    y: 0.5,
    pressure: 0.4,
  });
  assert.deepEqual(transport.sent[1].payload.point, {
    x: 0.5,
    y: 0.25,
    pressure: 0.7,
  });
  assert.deepEqual(transport.sent[2].payload.point, {
    x: 0.78125,
    y: 0.75,
    pressure: 0.5,
  });

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].complete, true);

  for (const event of transport.sent) {
    transport.emit(structuredClone(event));
  }

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].points.length, 3);
});

test("drawing gesture publishes coalesced pointer samples in order", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", {
    clientX: 20,
    clientY: 30,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    pointerId: 7,
    getCoalescedEvents() {
      return [
        createFakeEvent("pointermove", elements.canvas, {
          clientX: 40,
          clientY: 40,
          pointerId: 7,
          pressure: 0.2,
        }),
        createFakeEvent("pointermove", elements.canvas, {
          clientX: 70,
          clientY: 55,
          pointerId: 7,
          pressure: 0.5,
        }),
      ];
    },
  });

  const pointEvents = transport.sent.filter(
    (event) => event.type === "stroke:point",
  );

  assert.deepEqual(
    pointEvents.map((event) => event.payload.point),
    [
      { x: 0.10625, y: 0.2, pressure: 0.2 },
      { x: 0.275, y: 0.35, pressure: 0.5 },
    ],
  );
});

test("drawing gesture publishes final pointerup point before ending when it changed", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 110,
    clientY: 45,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 160,
    clientY: 95,
    pointerId: 7,
  });

  assert.deepEqual(eventTypes(transport.sent), [
    "stroke:start",
    "stroke:point",
    "stroke:point",
    "stroke:end",
  ]);
  assert.deepEqual(transport.sent.at(-2).payload.point, {
    x: 0.78125,
    y: 0.75,
    pressure: 0,
  });
});

test("drawing gesture does not duplicate the final point when pointerup did not move", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 110,
    clientY: 45,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 110,
    clientY: 45,
    pointerId: 7,
  });

  assert.deepEqual(eventTypes(transport.sent), [
    "stroke:start",
    "stroke:point",
    "stroke:end",
  ]);
});

test("pointer mode sends pointer events and no stroke events", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.pointerButton.dispatch("click");
  elements.canvas.dispatch("pointerdown", {
    clientX: 20,
    clientY: 30,
    pointerId: 3,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 70,
    clientY: 50,
    pointerId: 3,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 70,
    clientY: 50,
    pointerId: 3,
  });

  assert.deepEqual(eventTypes(transport.sent), [
    "pointer:show",
    "pointer:move",
    "pointer:hide",
  ]);
  assert.ok(transport.sent.every((event) => !event.type.startsWith("stroke:")));
  assert.deepEqual(transport.sent[0].payload.point, {
    x: 0,
    y: 0.1,
    pressure: 0,
  });
});

test("clear button requires confirmation before clearing local state", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });
  assert.equal(controller.getSnapshot().strokes.length, 1);

  elements.clearButton.dispatch("click");

  assert.notEqual(transport.sent.at(-1).type, "board:clear");
  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(elements.clearButton.textContent, "Confirm");
  assert.equal(elements.clearButton.classList.contains("is-armed"), true);
  assert.equal(
    elements.clearButton.attributes.get("aria-label"),
    "Confirm clear all",
  );

  elements.clearButton.dispatch("click");

  assert.equal(transport.sent.at(-1).type, "board:clear");
  assert.deepEqual(transport.sent.at(-1).payload, {});
  assert.deepEqual(controller.getSnapshot().strokes, []);
  assert.equal(elements.clearButton.textContent, "Clear");
  assert.equal(elements.clearButton.classList.contains("is-armed"), false);
});

test("clear confirmation expires without clearing the board", async () => {
  const { controller, elements, transport, timers } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });

  elements.clearButton.dispatch("click");
  assert.equal(elements.clearButton.classList.contains("is-armed"), true);
  timers.scheduled[0].callback();

  assert.equal(elements.clearButton.textContent, "Clear");
  assert.equal(elements.clearButton.classList.contains("is-armed"), false);
  assert.equal(controller.getSnapshot().strokes.length, 1);

  elements.clearButton.dispatch("click");

  assert.notEqual(transport.sent.at(-1).type, "board:clear");
  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(elements.clearButton.classList.contains("is-armed"), true);
});

test("failed confirmed clear keeps the previous undo action", async () => {
  const transportOptions = {};
  const transport = createFakeTransport(transportOptions);
  const { controller, elements, errors } = createFixture({
    transport,
    maxQueuedEvents: 0,
  });

  await controller.connect();
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });
  const strokeId = controller.getSnapshot().strokes[0].strokeId;

  transportOptions.throwOnSend = true;
  elements.clearButton.dispatch("click");
  elements.clearButton.dispatch("click");

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(errors.length, 2);

  transportOptions.throwOnSend = false;
  await controller.connect();
  elements.undoButton.dispatch("click");

  assert.equal(transport.sent.at(-1).type, "board:undo");
  assert.deepEqual(transport.sent.at(-1).payload, { strokeId });
});

test("undo after a completed stroke sends board:undo and removes it locally", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });

  const strokeId = controller.getSnapshot().strokes[0].strokeId;
  assert.equal(elements.undoButton.disabled, false);

  elements.undoButton.dispatch("click");

  assert.equal(transport.sent.at(-1).type, "board:undo");
  assert.deepEqual(transport.sent.at(-1).payload, { strokeId });
  assert.deepEqual(controller.getSnapshot().strokes, []);
  assert.equal(elements.undoButton.disabled, true);
});

test("mobile quick undo mirrors the main undo action", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });

  const strokeId = controller.getSnapshot().strokes[0].strokeId;
  assert.equal(elements.quickUndoButton.disabled, false);

  elements.quickUndoButton.dispatch("click");

  assert.equal(transport.sent.at(-1).type, "board:undo");
  assert.deepEqual(transport.sent.at(-1).payload, { strokeId });
  assert.deepEqual(controller.getSnapshot().strokes, []);
  assert.equal(elements.quickUndoButton.disabled, true);
});

test("more panel exposes and copies the viewer share link", async () => {
  const copied = [];
  const { controller, elements } = createFixture({
    viewerURL: "http://local.test:8080/viewer",
    copyText(value) {
      copied.push(value);
      return Promise.resolve();
    },
  });

  await controller.connect();

  assert.equal(elements.sharePanel.hidden, true);
  assert.equal(elements.shareViewerLink.href, "http://local.test:8080/viewer");
  assert.equal(elements.shareViewerInput.value, "http://local.test:8080/viewer");
  assert.equal(elements.shareViewerQR.childrenList.length, 1);
  assert.equal(elements.shareViewerQR.childrenList[0].attributes.get("class"), "share-qr board-share-qr");
  assert.equal(elements.shareViewerQR.childrenList[0].attributes.get("aria-label"), "QR code for Viewer");
  const firstQRPath = elements.shareViewerQR.childrenList[0].childrenList[1].attributes.get("d");
  assert.equal(
    elements.moreButton.attributes.get("aria-expanded"),
    "false",
  );

  elements.moreButton.dispatch("click");

  assert.equal(elements.sharePanel.hidden, false);
  assert.equal(
    elements.moreButton.attributes.get("aria-expanded"),
    "true",
  );

  elements.copyViewerButton.dispatch("click");
  await flushAsyncWork();

  assert.deepEqual(copied, ["http://local.test:8080/viewer"]);
  assert.equal(elements.copyViewerButton.textContent, "Copied");

  controller.setViewerURL("http://local.test:8080/viewer?transport=webrtc&sessionId=session-42");

  assert.equal(
    elements.shareViewerInput.value,
    "http://local.test:8080/viewer?transport=webrtc&sessionId=session-42",
  );
  assert.notEqual(
    elements.shareViewerQR.childrenList[0].childrenList[1].attributes.get("d"),
    firstQRPath,
  );

  elements.moreButton.dispatch("click");

  assert.equal(elements.sharePanel.hidden, true);
  assert.equal(
    elements.moreButton.attributes.get("aria-expanded"),
    "false",
  );
});

test("more panel keeps the viewer share URL when it is too long for a QR code", async () => {
  const { controller, elements } = createFixture({
    viewerURL: "http://local.test:8080/viewer",
  });
  await controller.connect();

  const longViewerURL = `https://hosted.example.test/viewer?transport=webrtc&sessionId=${"a".repeat(150)}`;

  controller.setViewerURL(longViewerURL);

  assert.equal(elements.shareViewerLink.href, longViewerURL);
  assert.equal(elements.shareViewerInput.value, longViewerURL);
  assert.equal(elements.shareViewerQR.childrenList.length, 1);
  assert.equal(
    elements.shareViewerQR.childrenList[0].className,
    "share-qr-fallback board-share-qr-fallback",
  );
  assert.equal(elements.shareViewerQR.childrenList[0].textContent, "QR unavailable");
});

test("more panel reports copy failure when fallback clipboard copy fails", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        value: "",
        className: "",
        select() {},
        remove() {},
      };
    },
    body: {
      append() {},
    },
    execCommand() {
      return false;
    },
  };

  try {
    const { controller, elements, errors, timers } = createFixture({
      viewerURL: "http://local.test:8080/viewer",
    });
    await controller.connect();

    elements.copyViewerButton.dispatch("click");
    await flushAsyncWork();

    assert.equal(elements.copyViewerButton.textContent, "Failed");
    assert.equal(timers.scheduled[0].delay, 1200);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /clipboard copy failed/i);

    timers.scheduled[0].callback();

    assert.equal(elements.copyViewerButton.textContent, "Copy");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("mobile toolbar collapses by default and updates compact status", async () => {
  const fakeWindow = createFakeWindow({ compactMobile: true });
  const { controller, elements } = createFixture({ window: fakeWindow });

  await controller.connect();

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "false",
  );
  assert.equal(elements.mobileToolLabel.textContent, "Marker");
  assert.equal(elements.mobileToolIcons[0].hidden, false);
  assert.equal(elements.mobileToolIcons[1].hidden, true);
  assert.equal(elements.mobileToolIcons[2].hidden, true);
  assert.equal(elements.quickUndoButton.disabled, true);

  elements.toolbarToggleButton.dispatch("click");

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), false);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "true",
  );

  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");

  assert.equal(elements.mobileToolLabel.textContent, "Chalk");
  assert.equal(
    elements.root.style.getPropertyValue("--surface-color"),
    "#22543d",
  );

  elements.eraserButton.dispatch("click");

  assert.equal(elements.mobileToolLabel.textContent, "Eraser");
  assert.equal(elements.mobileToolIcons[0].hidden, true);
  assert.equal(elements.mobileToolIcons[1].hidden, false);
  assert.equal(elements.mobileToolIcons[2].hidden, true);

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "false",
  );
});

test("mobile toolbar collapses after compact tool choices", async () => {
  const fakeWindow = createFakeWindow({ compactMobile: true });
  const { controller, elements } = createFixture({ window: fakeWindow });

  await controller.connect();

  elements.toolbarToggleButton.dispatch("click");
  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), false);

  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");
  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);

  elements.toolbarToggleButton.dispatch("click");
  elements.eraserButton.dispatch("click");
  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);

  elements.toolbarToggleButton.dispatch("click");
  elements.colorButtons[1].dispatch("click");
  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);

  elements.toolbarToggleButton.dispatch("click");
  elements.ephemeralToggle.checked = true;
  elements.ephemeralToggle.dispatch("change");
  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);
});

test("mobile collapsed dock shows current ink color and fade state", async () => {
  const fakeWindow = createFakeWindow({ compactMobile: true });
  const { controller, elements } = createFixture({ window: fakeWindow });

  await controller.connect();

  assert.equal(elements.mobileColorDot.hidden, false);
  assert.equal(
    elements.mobileColorDot.style.getPropertyValue("--mobile-ink-color"),
    "#111827",
  );
  assert.equal(elements.mobileFadeBadge.hidden, true);

  elements.surfaceSelect.value = "blueboard";
  elements.surfaceSelect.dispatch("change");
  elements.colorButtons[1].dispatch("click");

  assert.equal(elements.mobileColorDot.hidden, false);
  assert.equal(
    elements.mobileColorDot.style.getPropertyValue("--mobile-ink-color"),
    "#facc15",
  );

  elements.ephemeralToggle.checked = true;
  elements.ephemeralToggle.dispatch("change");

  assert.equal(elements.mobileFadeBadge.hidden, false);
  assert.equal(
    elements.mobileFadeBadge.attributes.get("aria-hidden"),
    "false",
  );

  elements.eraserButton.dispatch("click");

  assert.equal(elements.mobileColorDot.hidden, true);

  elements.ephemeralToggle.checked = false;
  elements.ephemeralToggle.dispatch("change");

  assert.equal(elements.mobileFadeBadge.hidden, true);
  assert.equal(elements.mobileFadeBadge.attributes.get("aria-hidden"), "true");
});

test("mobile toolbar close control minimizes the expanded sheet", async () => {
  const fakeWindow = createFakeWindow({ compactMobile: true });
  const { controller, elements } = createFixture({ window: fakeWindow });

  await controller.connect();

  elements.toolbarToggleButton.dispatch("click");
  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), false);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "true",
  );

  elements.toolbarCloseButton.dispatch("click");

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "false",
  );
});

test("toolbar adapts when the viewport crosses mobile width", async () => {
  const viewport = { compactMobile: false };
  const fakeWindow = createFakeWindow(viewport);
  const { controller, elements } = createFixture({ window: fakeWindow });

  await controller.connect();

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), false);

  viewport.compactMobile = true;
  fakeWindow.dispatch("resize");

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), true);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "false",
  );

  viewport.compactMobile = false;
  fakeWindow.dispatch("resize");

  assert.equal(elements.root.classList.contains("is-toolbar-collapsed"), false);
  assert.equal(
    elements.toolbarToggleButton.attributes.get("aria-expanded"),
    "true",
  );
});

test("board HTML includes an explicit mobile toolbar minimize control", async () => {
  const html = await readFile(new URL("../board.html", import.meta.url), "utf8");

  assert.match(html, /data-board-control="toolbar-close"/);
  assert.match(html, /aria-label="Minimize toolbar"/);
});

test("undo after clear restores the previous board snapshot", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });
  elements.clearButton.dispatch("click");
  elements.clearButton.dispatch("click");
  assert.deepEqual(controller.getSnapshot().strokes, []);

  elements.undoButton.dispatch("click");

  assert.equal(transport.sent.at(-1).type, "board:restore");
  assert.equal(transport.sent.at(-1).payload.surface, "greenboard");
  assert.equal(transport.sent.at(-1).payload.strokes.length, 1);
  assert.equal(controller.getSnapshot().surface, "greenboard");
  assert.equal(controller.getSnapshot().strokes.length, 1);
});

test("presenter conflict disables controls and prevents local publishing", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  transport.emit({
    type: "system:presenter-conflict",
    payload: { reason: "presenter-active" },
  });

  assert.equal(elements.sessionStatus.textContent, "Presenter active elsewhere");
  assert.equal(elements.surfaceSelect.disabled, true);
  assert.equal(elements.penButton.disabled, true);
  assert.equal(elements.eraserButton.disabled, true);
  assert.equal(elements.pointerButton.disabled, true);
  assert.equal(elements.clearButton.disabled, true);
  assert.equal(elements.undoButton.disabled, true);
  assert.equal(transport.closed, true);

  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });

  assert.deepEqual(transport.sent, []);
  assert.equal(controller.getSnapshot().surface, "whiteboard");
  assert.deepEqual(controller.getSnapshot().strokes, []);
});

test("relay board status shows compact connecting and connected states", async () => {
  const transport = createFakeTransport({ deferConnect: true });
  const { controller, elements } = createFixture({ transport });

  const connection = controller.connect();
  assert.equal(elements.sessionStatus.textContent, "Connecting");
  assert.equal(elements.sessionStatus.attributes.get("title"), "Relay connecting");

  transport.resolveConnect();
  await connection;

  assert.equal(elements.sessionStatus.textContent, "Relay");
  assert.equal(elements.sessionStatus.attributes.get("title"), "Relay connected");
});

test("relay board status follows transport reconnect lifecycle", async () => {
  const transport = createFakeTransport();
  const { controller, elements } = createFixture({ transport });

  await controller.connect();
  transport.emitStatus("reconnecting");

  assert.equal(elements.sessionStatus.textContent, "Reconnecting");
  assert.equal(elements.sessionStatus.attributes.get("title"), "Relay reconnecting");

  transport.emitStatus("connected");

  assert.equal(elements.sessionStatus.textContent, "Relay");
  assert.equal(elements.sessionStatus.attributes.get("title"), "Relay connected");
});

test("board queues and flushes input across reconnect when visible status is externally managed", async () => {
  const { controller, elements, transport } = createFixture({
    manageSessionStatus: false,
  });

  await controller.connect();

  transport.emitStatus("reconnecting");
  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 80,
    clientY: 90,
    pointerId: 7,
  });

  assert.equal(transport.sent.length, 0);

  transport.emitStatus("connected");

  assert.equal(transport.sent.length, 4);
  assert.deepEqual(
    transport.sent.map((event) => event.type),
    ["stroke:start", "stroke:point", "stroke:end", "board:restore"],
  );
});

test("board sends a restore snapshot when an externally managed transport reconnects", async () => {
  const { controller, elements, transport } = createFixture({
    manageSessionStatus: false,
  });

  await controller.connect();
  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 80,
    clientY: 90,
    pointerId: 7,
  });
  assert.deepEqual(
    transport.sent.map((event) => event.type),
    ["stroke:start", "stroke:point", "stroke:end"],
  );

  transport.emitStatus("reconnecting");
  transport.emitStatus("connected");

  assert.equal(transport.sent.at(-1).type, "board:restore");
  assert.equal(transport.sent.at(-1).payload.strokes.length, 1);
  assert.equal(transport.sent.at(-1).payload.strokes[0].complete, true);
});

test("relay board status reports connected viewer count", async () => {
  const transport = createFakeTransport();
  const { controller, elements } = createFixture({ transport });

  await controller.connect();

  transport.emit({
    type: "system:relay-presence",
    payload: { viewerCount: 0 },
  });

  assert.equal(elements.sessionStatus.textContent, "0 view");
  assert.equal(elements.sessionStatus.attributes.get("title"), "No viewers connected");

  transport.emit({
    type: "system:relay-presence",
    payload: { viewerCount: 1 },
  });

  assert.equal(elements.sessionStatus.textContent, "1 view");
  assert.equal(elements.sessionStatus.attributes.get("title"), "1 viewer connected");

  transport.emit({
    type: "system:relay-presence",
    payload: { viewerCount: 2 },
  });

  assert.equal(elements.sessionStatus.textContent, "2 views");
  assert.equal(elements.sessionStatus.attributes.get("title"), "2 viewers connected");
});

test("relay board status shows input pause when queued input is full", () => {
  const transport = createFakeTransport({
    deferConnect: true,
    throwBeforeOpen: true,
  });
  const { elements } = createFixture({
    transport,
    maxQueuedEvents: 0,
  });

  elements.surfaceSelect.value = "blueboard";
  elements.surfaceSelect.dispatch("change");

  assert.equal(elements.sessionStatus.textContent, "Paused");
  assert.equal(elements.sessionStatus.attributes.get("title"), "Input paused");
});

test("ephemeral drawing marks the stroke and later sends stroke:expire", async () => {
  const { controller, elements, transport, timers } = createFixture({
    now: 20_000,
  });

  await controller.connect();
  elements.ephemeralToggle.checked = true;
  elements.ephemeralToggle.dispatch("change");
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });

  const start = transport.sent.find((event) => event.type === "stroke:start");
  const end = transport.sent.find((event) => event.type === "stroke:end");

  assert.equal(start.payload.ephemeral, true);
  assert.equal(typeof start.payload.expiresAt, "number");
  assert.ok(start.payload.expiresAt > 20_000);
  assert.equal(end.payload.strokeId, start.payload.strokeId);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 4_000);

  timers.scheduled[0].callback();

  assert.equal(transport.sent.at(-1).type, "stroke:expire");
  assert.deepEqual(transport.sent.at(-1).payload, {
    strokeId: start.payload.strokeId,
  });
});

test("events before connect update local state and flush after connect resolves", async () => {
  const transport = createFakeTransport({
    deferConnect: true,
    throwBeforeOpen: true,
  });
  const { controller, elements } = createFixture({ transport });

  elements.surfaceSelect.value = "blueboard";
  assert.doesNotThrow(() => elements.surfaceSelect.dispatch("change"));
  assert.doesNotThrow(() => {
    elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
    elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });
  });

  assert.equal(controller.getSnapshot().surface, "blueboard");
  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].complete, true);
  assert.deepEqual(transport.sent, []);

  const connection = controller.connect();
  assert.deepEqual(transport.sent, []);
  transport.resolveConnect();
  await connection;

  assert.deepEqual(eventTypes(transport.sent), [
    "board:set-surface",
    "stroke:start",
    "stroke:end",
  ]);
});

test("events before connect stop updating local state when the queue is full", () => {
  const transport = createFakeTransport({
    deferConnect: true,
    throwBeforeOpen: true,
  });
  const { controller, elements, errors } = createFixture({
    transport,
    maxQueuedEvents: 1,
  });

  elements.surfaceSelect.value = "blueboard";
  elements.surfaceSelect.dispatch("change");
  assert.equal(controller.getSnapshot().surface, "blueboard");

  elements.surfaceSelect.value = "greenboard";
  elements.surfaceSelect.dispatch("change");

  assert.equal(controller.getSnapshot().surface, "blueboard");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /queue is full/i);
});

test("connected send failure does not update local state when the queue is full", async () => {
  const transport = createFakeTransport({ throwOnSend: true });
  const { controller, elements, errors } = createFixture({
    transport,
    maxQueuedEvents: 0,
  });

  await controller.connect();
  elements.surfaceSelect.value = "blueboard";
  elements.surfaceSelect.dispatch("change");

  assert.equal(controller.getSnapshot().surface, "whiteboard");
  assert.deepEqual(transport.sent, []);
  assert.equal(elements.sessionStatus.textContent, "Paused");
  assert.ok(errors.some((error) => /send failed/i.test(error.message)));
  assert.ok(errors.some((error) => /queue is full/i.test(error.message)));
});

test("drawing does not start when the offline queue is full", () => {
  const transport = createFakeTransport({
    deferConnect: true,
    throwBeforeOpen: true,
  });
  const { controller, elements, errors } = createFixture({
    transport,
    maxQueuedEvents: 0,
  });

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointermove", {
    clientX: 80,
    clientY: 90,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 80,
    clientY: 90,
    pointerId: 7,
  });

  assert.deepEqual(controller.getSnapshot().strokes, []);
  assert.deepEqual(transport.sent, []);
  assert.deepEqual(elements.canvas.releasedPointers, [7]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /queue is full/i);
});

test("stroke end failure does not create an undo action for an incomplete stroke", () => {
  const transport = createFakeTransport({
    deferConnect: true,
    throwBeforeOpen: true,
  });
  const { controller, elements, errors } = createFixture({
    transport,
    maxQueuedEvents: 1,
  });

  elements.canvas.dispatch("pointerdown", {
    clientX: 60,
    clientY: 70,
    pointerId: 7,
  });
  elements.canvas.dispatch("pointerup", {
    clientX: 80,
    clientY: 90,
    pointerId: 7,
  });

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].complete, false);
  assert.equal(elements.undoButton.disabled, true);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => /queue is full/i.test(error.message)));
});

test("close during pending connect rejects stale connection and does not flush queued events", async () => {
  const transport = createFakeTransport({
    deferConnect: true,
    throwBeforeOpen: true,
  });
  const { controller, elements } = createFixture({ transport });

  const connection = controller.connect();
  elements.surfaceSelect.value = "blueboard";
  elements.surfaceSelect.dispatch("change");
  assert.equal(controller.getSnapshot().surface, "blueboard");

  controller.close();
  transport.resolveConnect();

  await assert.rejects(connection, /board controller is closed/);
  assert.deepEqual(transport.sent, []);
});

test("connect after close rejects without reconnecting an unsubscribed board", async () => {
  const { controller, transport } = createFixture();

  controller.close();

  await assert.rejects(
    () => controller.connect(),
    /board controller is closed/,
  );
  assert.equal(transport.connectCalls, 0);
});

test("long ephemeral gesture schedules expiration at the stroke expiresAt deadline", async () => {
  let currentNow = 20_000;
  const { controller, elements, transport, timers } = createFixture({
    now: () => currentNow,
  });

  await controller.connect();
  elements.ephemeralToggle.checked = true;
  elements.ephemeralToggle.dispatch("change");
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });

  currentNow = 23_500;
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });

  const start = transport.sent.find((event) => event.type === "stroke:start");

  assert.equal(start.payload.expiresAt, 24_000);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 500);
});
