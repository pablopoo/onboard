import assert from "node:assert/strict";
import test from "node:test";

import { assertTransport } from "./transport-contract.js";
import { createWebSocketRelayTransport } from "./websocket-relay-transport.js";

function makeFakeWebSocketClass() {
  const instances = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }

      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.closed = true;
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch("close", {});
    }

    dispatchMessage(data) {
      this.dispatch("message", { data });
    }

    dispatchOpen() {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open", {});
    }

    dispatchError(error = new Error("socket failed")) {
      this.dispatch("error", { error });
    }

    dispatchClose() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch("close", {});
    }

    dispatch(type, event) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  FakeWebSocket.instances = instances;
  return FakeWebSocket;
}

async function connectAndOpen(transport, WebSocketImpl) {
  const connection = transport.connect();
  WebSocketImpl.instances[0].dispatchOpen();
  dispatchReady(WebSocketImpl.instances[0]);
  await connection;
}

function dispatchReady(socket) {
  socket.dispatchMessage(JSON.stringify({
    type: "system:relay-ready",
    payload: {},
  }));
}

function makeEvent(overrides = {}) {
  return {
    id: "evt_000001",
    type: "board:clear",
    boardId: "default",
    at: 12345,
    payload: {},
    ...overrides,
  };
}

function makeFakeTimers() {
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
    runNext() {
      const timer = scheduled.shift();
      timer?.callback();
      return timer;
    },
  };
}

test("connect constructs WebSocket with the configured URL", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });

  await connectAndOpen(transport, WebSocketImpl);

  assert.equal(WebSocketImpl.instances.length, 1);
  assert.equal(WebSocketImpl.instances[0].url, "ws://localhost:8080/ws/relay");
});

test("send serializes events with JSON.stringify", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const event = makeEvent();

  await connectAndOpen(transport, WebSocketImpl);
  transport.send(event);

  assert.deepEqual(WebSocketImpl.instances[0].sent, [JSON.stringify(event)]);
});

test("connect resolves only after the WebSocket opens", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  let connected = false;

  const connection = transport.connect().then(() => {
    connected = true;
  });
  await Promise.resolve();

  assert.equal(WebSocketImpl.instances[0].readyState, WebSocketImpl.CONNECTING);
  assert.equal(connected, false);

  WebSocketImpl.instances[0].dispatchOpen();
  dispatchReady(WebSocketImpl.instances[0]);
  await connection;

  assert.equal(connected, true);
});

test("connect waits for ready after delivering the snapshot", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const received = [];
  const statuses = [];
  let connected = false;
  transport.onEvent((event) => received.push(event));
  transport.onStatus((status) => statuses.push(status));

  const connection = transport.connect().then(() => {
    connected = true;
  });
  const socket = WebSocketImpl.instances[0];
  socket.dispatchOpen();
  socket.dispatchMessage(JSON.stringify(makeEvent({ type: "board:restore" })));
  await Promise.resolve();

  assert.equal(connected, false);
  assert.deepEqual(statuses, ["connecting"]);
  assert.equal(received.length, 1);

  dispatchReady(socket);
  await connection;

  assert.equal(connected, true);
  assert.deepEqual(statuses, ["connecting", "connected"]);
  assert.equal(received.length, 1);
});

test("ready flushes sends queued during initial synchronization", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const event = makeEvent({ id: "evt_before_ready" });
  const connection = transport.connect();
  const socket = WebSocketImpl.instances[0];
  socket.dispatchOpen();

  assert.doesNotThrow(() => transport.send(event));
  assert.deepEqual(socket.sent, []);

  dispatchReady(socket);
  await connection;
  assert.deepEqual(socket.sent, [JSON.stringify(event)]);
});

test("send throws clearly before connect", () => {
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl: makeFakeWebSocketClass(),
  });

  assert.throws(() => transport.send(makeEvent()), /connect/i);
});

test("send queues while the initial WebSocket is opening", () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });

  const event = makeEvent({ id: "evt_initial_open" });
  transport.connect();

  assert.doesNotThrow(() => transport.send(event));
  assert.deepEqual(WebSocketImpl.instances[0].sent, []);
});

test("connect rejects if the WebSocket errors before open", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });

  const connection = transport.connect();
  WebSocketImpl.instances[0].dispatchError();

  await assert.rejects(connection, /open/i);
});

test("connect rejects if the WebSocket closes before open", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });

  const connection = transport.connect();
  WebSocketImpl.instances[0].dispatchClose();

  await assert.rejects(connection, /open/i);
});

test("initial failure schedules a reconnect", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  const connection = transport.connect();
  WebSocketImpl.instances[0].dispatchError();
  await assert.rejects(connection, /open/i);

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 250);
  timers.runNext();
  assert.equal(WebSocketImpl.instances.length, 2);
});

test("open without ready rejects at the ready timeout", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    readyTimeoutMs: 5_000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  const connection = transport.connect();
  WebSocketImpl.instances[0].dispatchOpen();
  assert.equal(timers.scheduled[0].delay, 5_000);
  timers.runNext();

  await assert.rejects(connection, /ready timeout/i);
  assert.equal(WebSocketImpl.instances[0].closed, true);
});

test("message events parse JSON and call registered handlers", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const received = [];
  const event = makeEvent({ id: "evt_000002" });

  transport.onEvent((message) => received.push(message));
  await connectAndOpen(transport, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchMessage(JSON.stringify(event));

  assert.deepEqual(received, [event]);
});

test("malformed JSON messages are ignored", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const received = [];

  transport.onEvent((message) => received.push(message));
  await connectAndOpen(transport, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchMessage("{not-json");

  assert.deepEqual(received, []);
});

test("onEvent returns an unsubscribe function", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const received = [];
  const unsubscribe = transport.onEvent((message) => received.push(message));

  await connectAndOpen(transport, WebSocketImpl);
  unsubscribe();
  WebSocketImpl.instances[0].dispatchMessage(JSON.stringify(makeEvent()));

  assert.deepEqual(received, []);
});

test("close closes the socket", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  await connectAndOpen(transport, WebSocketImpl);
  transport.close();

  assert.equal(WebSocketImpl.instances[0].closed, true);
  assert.equal(timers.scheduled.length, 0);
});

test("unexpected close reconnects and keeps event handlers active", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const received = [];

  transport.onEvent((event) => received.push(event));
  await connectAndOpen(transport, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchClose();

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 250);

  timers.runNext();
  assert.equal(WebSocketImpl.instances.length, 2);
  const reconnect = transport.connect();
  WebSocketImpl.instances[1].dispatchOpen();
  dispatchReady(WebSocketImpl.instances[1]);
  await reconnect;

  const event = makeEvent({ id: "evt_after_reconnect" });
  WebSocketImpl.instances[1].dispatchMessage(JSON.stringify(event));

  assert.deepEqual(received, [event]);
});

test("status subscribers see reconnecting and connected around runtime reconnect", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const statuses = [];

  transport.onStatus((status) => statuses.push(status));
  await connectAndOpen(transport, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchClose();

  timers.runNext();
  const reconnect = transport.connect();
  WebSocketImpl.instances[1].dispatchOpen();
  dispatchReady(WebSocketImpl.instances[1]);
  await reconnect;

  assert.deepEqual(statuses, ["connecting", "connected", "reconnecting", "connected"]);
});

test("onStatus returns an unsubscribe function", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });
  const statuses = [];
  const unsubscribe = transport.onStatus((status) => statuses.push(status));

  unsubscribe();
  await connectAndOpen(transport, WebSocketImpl);

  assert.deepEqual(statuses, []);
});

test("send queues events while reconnecting and flushes after reopen", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const event = makeEvent({ id: "evt_queued_while_reconnecting" });

  await connectAndOpen(transport, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchClose();

  assert.doesNotThrow(() => transport.send(event));
  assert.deepEqual(WebSocketImpl.instances[0].sent, []);

  timers.runNext();
  const reconnect = transport.connect();
  WebSocketImpl.instances[1].dispatchOpen();
  dispatchReady(WebSocketImpl.instances[1]);
  await reconnect;

  assert.deepEqual(WebSocketImpl.instances[1].sent, [JSON.stringify(event)]);
});

test("send fails clearly when the reconnect queue is full", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const timers = makeFakeTimers();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
    maxQueuedEvents: 2,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const first = makeEvent({ id: "evt_queued_1" });
  const second = makeEvent({ id: "evt_queued_2" });
  const third = makeEvent({ id: "evt_queued_3" });

  await connectAndOpen(transport, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchClose();

  assert.doesNotThrow(() => transport.send(first));
  assert.doesNotThrow(() => transport.send(second));
  assert.throws(() => transport.send(third), /queue is full/i);

  timers.runNext();
  const reconnect = transport.connect();
  WebSocketImpl.instances[1].dispatchOpen();
  dispatchReady(WebSocketImpl.instances[1]);
  await reconnect;

  assert.deepEqual(WebSocketImpl.instances[1].sent, [
    JSON.stringify(first),
    JSON.stringify(second),
  ]);
});

test("created transport satisfies assertTransport", () => {
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl: makeFakeWebSocketClass(),
  });

  assert.equal(assertTransport(transport), transport);
});
