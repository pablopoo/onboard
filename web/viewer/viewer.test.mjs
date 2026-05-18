import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadViewerModule() {
  return import("./viewer.js");
}

function createFakeElement(properties = {}) {
  return {
    textContent: "",
    ...properties,
    querySelector(selector) {
      return this.children?.get(selector) ?? null;
    },
  };
}

function createFakeDocument(root, selector = "#viewer-app") {
  return {
    querySelector(requestedSelector) {
      return requestedSelector === selector ? root : null;
    },
  };
}

function createFakeCanvas(rect = { left: 0, top: 0, width: 320, height: 180 }) {
  return createFakeElement({
    width: rect.width,
    height: rect.height,
    getBoundingClientRect() {
      return rect;
    },
    getContext(type) {
      assert.equal(type, "2d");
      return createFakeCanvasContext();
    },
  });
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

  return {
    connectCalls: 0,
    closed: false,
    connect() {
      this.connectCalls += 1;
      if (options.deferConnect) {
        return connection.promise;
      }

      if (options.rejectConnect) {
        return Promise.reject(new Error("connect failed"));
      }

      return Promise.resolve();
    },
    resolveConnect() {
      connection.resolve();
    },
    rejectConnect(error = new Error("connect failed")) {
      connection.reject(error);
    },
    send() {
      throw new Error("viewer transport must not send events");
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

function createFakeWindow() {
  const listeners = new Map();

  return {
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
  };
}

function createFixture(options = {}) {
  const transport = options.transport ?? createFakeTransport();
  const renders = [];
  const rect = options.rect ?? { left: 0, top: 0, width: 320, height: 180 };
  const elements = {
    canvas: createFakeCanvas(rect),
    status: createFakeElement(),
  };

  return loadViewerModule().then(({ createViewerController }) => {
    const controller = createViewerController({
      elements,
      transport,
      now:
        typeof options.now === "function"
          ? options.now
          : () => options.now ?? 10_000,
      resizeCanvasToDisplaySize:
        options.resizeCanvasToDisplaySize ?? (() => false),
      renderBoardState: (ctx, snapshot, size, renderOptions) => {
        renders.push({ ctx, snapshot, size, options: renderOptions });
      },
      ResizeObserverImpl: options.ResizeObserverImpl,
      window: options.window,
    });

    return { controller, elements, transport, renders, rect };
  });
}

function createViewerAppRoot() {
  const children = new Map([
    ["[data-viewer-canvas]", createFakeCanvas()],
    ["[data-viewer-status]", createFakeElement()],
  ]);

  return createFakeElement({ children });
}

function createResizeFixture(options = {}) {
  const rect = { left: 0, top: 0, width: 320, height: 180 };
  const resizeCanvasToDisplaySize = (canvas) => {
    const currentRect = canvas.getBoundingClientRect();
    canvas.width = currentRect.width;
    canvas.height = currentRect.height;
    return true;
  };

  return createFixture({
    ...options,
    rect,
    resizeCanvasToDisplaySize,
  });
}

let nextEventNumber = 1;

function makeEvent(type, payload = {}, overrides = {}) {
  return {
    id: `evt_viewer_${String(nextEventNumber++).padStart(6, "0")}`,
    type,
    boardId: "default",
    at: 12_345,
    payload,
    ...overrides,
  };
}

function makeStrokeStart(strokeId, payload = {}, overrides = {}) {
  return makeEvent(
    "stroke:start",
    {
      strokeId,
      surface: "whiteboard",
      tool: "marker",
      color: "#111827",
      width: 5,
      point: { x: 0.25, y: 0.5 },
      ...payload,
    },
    overrides,
  );
}

function latestRender(renders) {
  return renders.at(-1);
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

test("createRelayURL maps http and https locations to /ws/relay", async () => {
  const { createRelayURL } = await loadViewerModule();

  assert.equal(
    createRelayURL({ protocol: "http:", host: "local.test:8080" }),
    "ws://local.test:8080/ws/relay",
  );
  assert.equal(
    createRelayURL({ protocol: "https:", host: "board.test" }),
    "wss://board.test/ws/relay",
  );
});

test("createSignalURL maps http and https locations to /signal", async () => {
  const { createSignalURL } = await loadViewerModule();

  assert.equal(
    createSignalURL({ protocol: "http:", host: "local.test:8080" }),
    "ws://local.test:8080/signal",
  );
  assert.equal(
    createSignalURL({ protocol: "https:", host: "board.test" }),
    "wss://board.test/signal",
  );
});

test("viewer app defaults to relay transport", async () => {
  const { createViewerApp } = await loadViewerModule();
  const root = createViewerAppRoot();
  const relayTransport = createFakeTransport();
  const relayCalls = [];
  const signalingCalls = [];

  const controller = createViewerApp({
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
  await flushAsyncWork();

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, "ws://local.test:8080/ws/relay");
  assert.equal(relayTransport.connectCalls, 1);
  assert.deepEqual(signalingCalls, []);
  assert.equal(root.querySelector("[data-viewer-status]").textContent, "Connected");

  controller.close();
});

test("viewer app honors explicit relay transport mode", async () => {
  const { createViewerApp } = await loadViewerModule();
  const root = createViewerAppRoot();
  const relayTransport = createFakeTransport();
  const relayCalls = [];

  const controller = createViewerApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "viewer.test",
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
  await flushAsyncWork();

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, "wss://viewer.test/ws/relay");
  assert.equal(relayTransport.connectCalls, 1);

  controller.close();
});

test("webrtc viewer joins session, sends setup ready signal, and connects data channel", async () => {
  const { createViewerApp } = await loadViewerModule();
  const root = createViewerAppRoot();
  const signaling = createFakeSignalingClient();
  const webRTCTransport = createFakeTransport();
  const signalingCalls = [];
  const webRTCCalls = [];
  const setupOrder = [];
  const errors = [];
  class FakeRTCPeerConnection {}
  const sendSignal = signaling.sendSignal.bind(signaling);
  signaling.sendSignal = (message) => {
    setupOrder.push("ready-signal");
    sendSignal(message);
  };

  const controller = createViewerApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "viewer.test",
      search: "?transport=webrtc&sessionId=session-42",
    },
    WebSocketImpl: class FakeWebSocket {},
    RTCPeerConnectionImpl: FakeRTCPeerConnection,
    createPeerId: () => "viewer-peer",
    createRelayTransport() {
      throw new Error("relay should not be used in webrtc mode");
    },
    createSignalingClientImpl(options) {
      signalingCalls.push(options);
      return signaling;
    },
    createWebRTCTransport(options) {
      webRTCCalls.push(options);
      return {
        ...webRTCTransport,
        connect() {
          setupOrder.push("webrtc-connect");
          return webRTCTransport.connect();
        },
      };
    },
    reportError(error) {
      errors.push(error);
    },
  });
  await flushAsyncWork();

  assert.equal(signalingCalls.length, 1);
  assert.equal(signalingCalls[0].url, "wss://viewer.test/signal");
  assert.equal(signaling.connectCalls, 1);
  assert.deepEqual(signaling.joinedSessions, [
    { sessionId: "session-42", peerId: "viewer-peer" },
  ]);
  assert.deepEqual(signaling.sentSignals, []);
  assert.deepEqual(webRTCCalls, []);

  signaling.emit({
    type: "session:joined",
    sessionId: "session-42",
    peerId: "viewer-peer",
    role: "viewer",
  });
  await flushAsyncWork();

  assert.deepEqual(signaling.sentSignals, [
    {
      type: "ice",
      sessionId: "session-42",
      peerId: "viewer-peer",
      payload: { onboardViewerReady: true },
    },
  ]);
  assert.deepEqual(setupOrder, ["webrtc-connect", "ready-signal"]);
  assert.equal(webRTCCalls.length, 1);
  assert.equal(webRTCCalls[0].signaling, signaling);
  assert.equal(webRTCCalls[0].role, "viewer");
  assert.equal(webRTCCalls[0].sessionId, "session-42");
  assert.equal(webRTCCalls[0].peerId, "viewer-peer");
  assert.equal(webRTCCalls[0].RTCPeerConnectionImpl, FakeRTCPeerConnection);
  assert.equal(webRTCTransport.connectCalls, 1);
  assert.equal(root.querySelector("[data-viewer-status]").textContent, "Connected");
  assert.deepEqual(errors, []);

  controller.close();
});

test("webrtc viewer fails clearly without a sessionId URL parameter", async () => {
  const { createViewerApp } = await loadViewerModule();
  const root = createViewerAppRoot();
  const errors = [];
  const signalingCalls = [];

  const controller = createViewerApp({
    document: createFakeDocument(root),
    location: {
      protocol: "https:",
      host: "viewer.test",
      search: "?transport=webrtc",
    },
    createSignalingClientImpl(options) {
      signalingCalls.push(options);
      return createFakeSignalingClient();
    },
    reportError(error) {
      errors.push(error);
    },
  });
  await flushAsyncWork();

  assert.equal(root.querySelector("[data-viewer-status]").textContent, "Connection failed");
  assert.equal(signalingCalls.length, 0);
  assert.match(errors[0].message, /sessionId/i);

  controller.close();
});

test("viewer controller connects transport", async () => {
  const { controller, elements, transport } = await createFixture();

  await controller.connect();

  assert.equal(transport.connectCalls, 1);
  assert.equal(elements.status.textContent, "Connected");
});

test("incoming board:set-surface updates state and render snapshot", async () => {
  const { controller, transport, renders } = await createFixture();

  transport.emit(makeEvent("board:set-surface", { surface: "blueboard" }));

  assert.equal(controller.getSnapshot().surface, "blueboard");
  assert.equal(latestRender(renders).snapshot.surface, "blueboard");
  assert.deepEqual(latestRender(renders).size, { width: 320, height: 180 });
});

test("incoming stroke events render a completed stroke", async () => {
  const { controller, transport, renders } = await createFixture();

  transport.emit(makeStrokeStart("stroke_1"));
  transport.emit(
    makeEvent("stroke:point", {
      strokeId: "stroke_1",
      point: { x: 0.75, y: 0.25, pressure: 0.6 },
    }),
  );
  transport.emit(makeEvent("stroke:end", { strokeId: "stroke_1" }));

  assert.equal(controller.getSnapshot().strokes.length, 1);
  assert.equal(controller.getSnapshot().strokes[0].complete, true);
  assert.deepEqual(latestRender(renders).snapshot.strokes[0].points, [
    { x: 0.25, y: 0.5, pressure: 0 },
    { x: 0.75, y: 0.25, pressure: 0.6 },
  ]);
  assert.equal(latestRender(renders).snapshot.strokes[0].complete, true);
});

test("duplicate relay event IDs do not duplicate strokes", async () => {
  const { controller, transport } = await createFixture();
  const event = makeStrokeStart("stroke_duplicate", {}, { id: "evt_duplicate" });

  transport.emit(event);
  transport.emit(structuredClone(event));

  assert.equal(controller.getSnapshot().strokes.length, 1);
});

test("pointer events update pointer state", async () => {
  const { controller, transport, renders } = await createFixture();

  transport.emit(
    makeEvent("pointer:show", { point: { x: 0.1, y: 0.2 } }),
  );
  assert.deepEqual(controller.getSnapshot().pointer, {
    visible: true,
    point: { x: 0.1, y: 0.2, pressure: 0 },
  });

  transport.emit(
    makeEvent("pointer:move", {
      point: { x: 0.3, y: 0.4, pressure: 0.7 },
    }),
  );
  assert.deepEqual(latestRender(renders).snapshot.pointer, {
    visible: true,
    point: { x: 0.3, y: 0.4, pressure: 0.7 },
  });

  transport.emit(makeEvent("pointer:hide", {}));
  assert.deepEqual(controller.getSnapshot().pointer, {
    visible: false,
    point: null,
  });
});

test("viewer passes current time to renderer so expired ephemeral strokes are hidden", async () => {
  const { transport, renders } = await createFixture({ now: 5_000 });

  transport.emit(
    makeStrokeStart("stroke_expired", {
      ephemeral: true,
      expiresAt: 1_000,
    }),
  );

  assert.equal(latestRender(renders).options.now, 5_000);
  assert.equal(latestRender(renders).snapshot.strokes[0].ephemeral, true);
  assert.equal(latestRender(renders).snapshot.strokes[0].expiresAt, 1_000);
});

test("ResizeObserver resize rerenders with the new canvas size", async () => {
  const ResizeObserverImpl = createFakeResizeObserverClass();
  const { controller, elements, renders, rect } = await createResizeFixture({
    ResizeObserverImpl,
  });

  assert.equal(ResizeObserverImpl.instances.length, 1);
  assert.deepEqual(ResizeObserverImpl.instances[0].observed, [elements.canvas]);

  rect.width = 640;
  rect.height = 360;
  ResizeObserverImpl.instances[0].trigger();

  assert.deepEqual(latestRender(renders).size, { width: 640, height: 360 });

  controller.close();
  assert.equal(ResizeObserverImpl.instances[0].disconnected, true);
});

test("window resize rerenders even when ResizeObserver is available", async () => {
  const ResizeObserverImpl = createFakeResizeObserverClass();
  const fakeWindow = createFakeWindow();
  const { controller, renders, rect } = await createResizeFixture({
    ResizeObserverImpl,
    window: fakeWindow,
  });

  assert.equal(fakeWindow.listenerCount("resize"), 1);

  rect.width = 700;
  rect.height = 394;
  fakeWindow.dispatch("resize");

  assert.deepEqual(latestRender(renders).size, { width: 700, height: 394 });

  controller.close();
  assert.equal(fakeWindow.listenerCount("resize"), 0);
  assert.equal(ResizeObserverImpl.instances[0].disconnected, true);
});

test("window resize fallback rerenders with the new canvas size and is cleaned up", async () => {
  const fakeWindow = createFakeWindow();
  const { controller, renders, rect } = await createResizeFixture({
    ResizeObserverImpl: null,
    window: fakeWindow,
  });

  assert.equal(fakeWindow.listenerCount("resize"), 1);

  rect.width = 800;
  rect.height = 450;
  fakeWindow.dispatch("resize");

  assert.deepEqual(latestRender(renders).size, { width: 800, height: 450 });

  controller.close();
  assert.equal(fakeWindow.listenerCount("resize"), 0);
});

test("close during pending connect keeps the viewer disconnected after stale resolution", async () => {
  const transport = createFakeTransport({ deferConnect: true });
  const { controller, elements } = await createFixture({ transport });

  const connection = controller.connect();
  assert.equal(elements.status.textContent, "Connecting");

  controller.close();
  transport.resolveConnect();
  await assert.rejects(connection, /viewer controller is closed/);

  assert.equal(elements.status.textContent, "Disconnected");
});

test("connect after close rejects without reconnecting an unsubscribed controller", async () => {
  const { controller, transport, elements } = await createFixture();

  controller.close();
  await assert.rejects(
    () => controller.connect(),
    /viewer controller is closed/,
  );

  assert.equal(transport.connectCalls, 0);
  assert.equal(elements.status.textContent, "Disconnected");
});

test("viewer HTML has no board controls or toolbar controls", async () => {
  const html = await readFile(new URL("../viewer.html", import.meta.url), "utf8");

  assert.equal(html.includes("data-board-control"), false);
  assert.equal(html.includes("class=\"toolbar\""), false);
  assert.equal(/<button\b/i.test(html), false);
  assert.equal(/<select\b/i.test(html), false);
  assert.equal(/<input\b/i.test(html), false);
});
