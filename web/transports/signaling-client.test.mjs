import assert from "node:assert/strict";
import test from "node:test";

import { createSignalingClient } from "./signaling-client.js";

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

async function connectAndOpen(client, WebSocketImpl) {
  const connection = client.connect();
  WebSocketImpl.instances[0].dispatchOpen();
  await connection;
}

function sentMessages(WebSocketImpl) {
  return WebSocketImpl.instances[0].sent.map((message) => JSON.parse(message));
}

test("connect opens /signal by default", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);

  assert.equal(WebSocketImpl.instances.length, 1);
  assert.equal(WebSocketImpl.instances[0].url, "/signal");
});

test("connect resolves only after the WebSocket opens", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  let connected = false;

  const connection = client.connect().then(() => {
    connected = true;
  });
  await Promise.resolve();

  assert.equal(WebSocketImpl.instances[0].readyState, WebSocketImpl.CONNECTING);
  assert.equal(connected, false);

  WebSocketImpl.instances[0].dispatchOpen();
  await connection;

  assert.equal(connected, true);
});

test("connect reuses an in-flight WebSocket connection", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  const firstConnection = client.connect();
  const secondConnection = client.connect();

  assert.equal(firstConnection, secondConnection);
  assert.equal(WebSocketImpl.instances.length, 1);

  WebSocketImpl.instances[0].dispatchOpen();
  await firstConnection;
});

test("connect reuses an open WebSocket connection", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);
  await client.connect();

  assert.equal(WebSocketImpl.instances.length, 1);
});

test("messages from a closed stale socket are ignored after reconnect", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  const received = [];

  client.onMessage((incoming) => received.push(incoming));
  await connectAndOpen(client, WebSocketImpl);
  const firstSocket = WebSocketImpl.instances[0];

  client.close();
  const reconnecting = client.connect();
  WebSocketImpl.instances[1].dispatchOpen();
  await reconnecting;

  firstSocket.dispatchMessage(
    JSON.stringify({
      type: "session:created",
      sessionId: "session-1",
      peerId: "board-1",
      role: "board",
    }),
  );
  WebSocketImpl.instances[1].dispatchMessage(
    JSON.stringify({
      type: "session:created",
      sessionId: "session-2",
      peerId: "board-2",
      role: "board",
    }),
  );

  assert.deepEqual(received, [
    {
      type: "session:created",
      sessionId: "session-2",
      peerId: "board-2",
      role: "board",
    },
  ]);
});

test("connect rejects if the WebSocket errors before open", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  const connection = client.connect();
  WebSocketImpl.instances[0].dispatchError();

  await assert.rejects(connection, /open/i);
});

test("connect rejects if the WebSocket closes before open", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  const connection = client.connect();
  WebSocketImpl.instances[0].dispatchClose();

  await assert.rejects(connection, /open/i);
});

test("post-open WebSocket close notifies handlers and allows reconnect", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  const received = [];

  client.onMessage((incoming) => received.push(incoming));
  await connectAndOpen(client, WebSocketImpl);

  WebSocketImpl.instances[0].dispatchClose();

  assert.deepEqual(received, [
    {
      type: "error",
      error: "WebSocket signaling closed",
    },
  ]);

  const connection = client.connect();
  WebSocketImpl.instances[1].dispatchOpen();
  await connection;

  assert.equal(WebSocketImpl.instances.length, 2);
});

test("createSession sends session:create with peerId", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);
  client.createSession("board-1");

  assert.deepEqual(sentMessages(WebSocketImpl), [
    { type: "session:create", peerId: "board-1" },
  ]);
});

test("joinSession sends session:join with sessionId and peerId", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);
  client.joinSession("session-1", "viewer-1");

  assert.deepEqual(sentMessages(WebSocketImpl), [
    {
      type: "session:join",
      sessionId: "session-1",
      peerId: "viewer-1",
    },
  ]);
});

test("sendSignal serializes offer, answer, and ice payloads", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);
  client.sendSignal({
    type: "offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: { sdp: "offer-sdp" },
  });
  client.sendSignal({
    type: "signal:answer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: { sdp: "answer-sdp" },
  });
  client.sendSignal({
    type: "ice",
    sessionId: "session-1",
    peerId: "board-1",
    payload: { candidate: "candidate-1" },
  });

  assert.deepEqual(sentMessages(WebSocketImpl), [
    {
      type: "signal:offer",
      sessionId: "session-1",
      peerId: "board-1",
      payload: { sdp: "offer-sdp" },
    },
    {
      type: "signal:answer",
      sessionId: "session-1",
      peerId: "viewer-1",
      payload: { sdp: "answer-sdp" },
    },
    {
      type: "signal:ice",
      sessionId: "session-1",
      peerId: "board-1",
      payload: { candidate: "candidate-1" },
    },
  ]);
});

test("sendSignal rejects unknown signal types", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);

  assert.throws(
    () =>
      client.sendSignal({
        type: "stroke:start",
        sessionId: "session-1",
        peerId: "board-1",
        payload: {},
      }),
    /signal type/i,
  );
});

test("sending throws clearly before connect", () => {
  const client = createSignalingClient({
    WebSocketImpl: makeFakeWebSocketClass(),
  });

  assert.throws(() => client.createSession("board-1"), /connect/i);
});

test("sending throws clearly before the WebSocket is open", () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  client.connect();

  assert.throws(() => client.createSession("board-1"), /open/i);
});

test("message events parse JSON and call registered handlers", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  const received = [];
  const messages = [
    {
      type: "session:created",
      sessionId: "session-1",
      peerId: "board-1",
      role: "board",
    },
    {
      type: "session:joined",
      sessionId: "session-1",
      peerId: "viewer-1",
      role: "viewer",
    },
    {
      type: "signal:offer",
      sessionId: "session-1",
      peerId: "board-1",
      payload: { sdp: "offer-sdp" },
    },
    {
      type: "signal:answer",
      sessionId: "session-1",
      peerId: "viewer-1",
      payload: { sdp: "answer-sdp" },
    },
    {
      type: "signal:ice",
      sessionId: "session-1",
      peerId: "board-1",
      payload: { candidate: "candidate-1" },
    },
    {
      type: "error",
      error: "unknown session",
    },
    {
      type: "session:peer-left",
      sessionId: "session-1",
      peerId: "viewer-1",
      payload: { role: "viewer" },
    },
  ];

  client.onMessage((incoming) => received.push(incoming));
  await connectAndOpen(client, WebSocketImpl);
  for (const message of messages) {
    WebSocketImpl.instances[0].dispatchMessage(JSON.stringify(message));
  }

  assert.deepEqual(received, messages);
});

test("malformed JSON messages are ignored", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  const received = [];

  client.onMessage((incoming) => received.push(incoming));
  await connectAndOpen(client, WebSocketImpl);
  WebSocketImpl.instances[0].dispatchMessage("{not-json");

  assert.deepEqual(received, []);
});

test("non-signaling JSON messages are ignored", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  const received = [];
  const ignoredMessages = [
    null,
    true,
    "session:created",
    123,
    [],
    {},
    { type: "stroke:start" },
    { type: "signal:unknown", sessionId: "session-1", peerId: "board-1" },
    { type: "session:created", sessionId: "", peerId: "board-1", role: "board" },
    { type: "session:created", sessionId: "session-1", peerId: "", role: "board" },
    { type: "session:created", sessionId: "session-1", peerId: "board-1", role: "" },
    {
      type: "session:joined",
      sessionId: "session-1",
      peerId: "viewer-1",
    },
    { type: "signal:offer", sessionId: "session-1", peerId: "board-1" },
    {
      type: "signal:answer",
      sessionId: "session-1",
      peerId: "viewer-1",
      payload: null,
    },
    {
      type: "signal:ice",
      sessionId: "session-1",
      peerId: "board-1",
      payload: [],
    },
    { type: "error" },
    { type: "error", error: "" },
  ];

  client.onMessage((incoming) => received.push(incoming));
  await connectAndOpen(client, WebSocketImpl);
  for (const message of ignoredMessages) {
    WebSocketImpl.instances[0].dispatchMessage(JSON.stringify(message));
  }

  assert.deepEqual(received, []);
});

test("onMessage returns an unsubscribe function", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });
  const received = [];
  const unsubscribe = client.onMessage((incoming) => received.push(incoming));

  await connectAndOpen(client, WebSocketImpl);
  unsubscribe();
  WebSocketImpl.instances[0].dispatchMessage(
    JSON.stringify({ type: "error", error: "unknown session" }),
  );

  assert.deepEqual(received, []);
});

test("close closes the socket", async () => {
  const WebSocketImpl = makeFakeWebSocketClass();
  const client = createSignalingClient({ WebSocketImpl });

  await connectAndOpen(client, WebSocketImpl);
  client.close();

  assert.equal(WebSocketImpl.instances[0].closed, true);
});
