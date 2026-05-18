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
  await connection;
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
  await connection;

  assert.equal(connected, true);
});

test("send throws clearly before connect", () => {
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl: makeFakeWebSocketClass(),
  });

  assert.throws(() => transport.send(makeEvent()), /connect/i);
});

test("send throws clearly before the WebSocket is open", () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });

  transport.connect();

  assert.throws(() => transport.send(makeEvent()), /open/i);
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
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl,
  });

  await connectAndOpen(transport, WebSocketImpl);
  transport.close();

  assert.equal(WebSocketImpl.instances[0].closed, true);
});

test("created transport satisfies assertTransport", () => {
  const transport = createWebSocketRelayTransport({
    url: "ws://localhost:8080/ws/relay",
    WebSocketImpl: makeFakeWebSocketClass(),
  });

  assert.equal(assertTransport(transport), transport);
});
