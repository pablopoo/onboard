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
    textContent: "",
    value: "",
    checked: false,
    classList: createFakeClassList(),
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
    dispatch(type, properties = {}) {
      const event = createFakeEvent(type, this, properties);
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
      return event;
    },
  };
}

function createFakeDocument(root, selector = "#board-app") {
  return {
    querySelector(requestedSelector) {
      return requestedSelector === selector ? root : null;
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
    emit(event) {
      for (const handler of handlers) {
        handler(event);
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

function createFixture(options = {}) {
  const transport = options.transport ?? createFakeTransport();
  const timers = createFakeTimers();
  const renders = [];
  const elements = {
    canvas: createFakeCanvas(),
    surfaceSelect: createFakeElement({ value: "whiteboard" }),
    penButton: createFakeElement(),
    eraserButton: createFakeElement(),
    pointerButton: createFakeElement(),
    ephemeralToggle: createFakeElement({ checked: false }),
    clearButton: createFakeElement(),
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
    resizeCanvasToDisplaySize: () => false,
    renderBoardState: (_ctx, snapshot) => renders.push(snapshot),
  });

  return { controller, elements, transport, timers, renders };
}

function createBoardAppRoot() {
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
  assert.equal(relayCalls[0].url, "ws://local.test:8080/ws/relay");
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
  assert.equal(relayCalls[0].url, "wss://board.test/ws/relay");
  assert.equal(relayTransport.connectCalls, 1);

  controller.close();
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
    "stroke:end",
  ]);
  assert.equal(transport.sent[0].payload.surface, "blackboard");
  assert.equal(transport.sent[0].payload.tool, "chalk");
  assert.deepEqual(transport.sent[0].payload.point, {
    x: 0.25,
    y: 0.5,
    pressure: 0.4,
  });
  assert.deepEqual(transport.sent[1].payload.point, {
    x: 0.5,
    y: 0.25,
    pressure: 0.7,
  });

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].complete, true);

  for (const event of transport.sent) {
    transport.emit(structuredClone(event));
  }

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].points.length, 2);
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
    x: 0.05,
    y: 0.1,
    pressure: 0,
  });
});

test("clear button sends board:clear and clears local state", async () => {
  const { controller, elements, transport } = createFixture();

  await controller.connect();
  elements.canvas.dispatch("pointerdown", { clientX: 60, clientY: 70 });
  elements.canvas.dispatch("pointerup", { clientX: 60, clientY: 70 });
  assert.equal(controller.getSnapshot().strokes.length, 1);

  elements.clearButton.dispatch("click");

  assert.equal(transport.sent.at(-1).type, "board:clear");
  assert.deepEqual(transport.sent.at(-1).payload, {});
  assert.deepEqual(controller.getSnapshot().strokes, []);
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
