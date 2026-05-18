import assert from "node:assert/strict";
import test from "node:test";

import { assertTransport } from "./transport-contract.js";
import { createWebRTCDataChannelTransport } from "./webrtc-datachannel-transport.js";

function makeFakeRTCDataChannel(label = "onboard-events") {
  return {
    label,
    readyState: "connecting",
    sent: [],
    closed: false,
    listeners: new Map(),

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }

      this.listeners.get(type).add(listener);
    },

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    },

    send(data) {
      this.sent.push(data);
    },

    close() {
      this.closed = true;
      this.readyState = "closed";
      this.dispatch("close", {});
    },

    dispatchClose() {
      this.readyState = "closed";
      this.dispatch("close", {});
    },

    dispatchError(error = new Error("data channel failed")) {
      this.dispatch("error", { error });
    },

    dispatchOpen() {
      this.readyState = "open";
      this.dispatch("open", {});
    },

    dispatchMessage(data) {
      this.dispatch("message", { data });
    },

    dispatch(type, event) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }

      const propertyListener = this[`on${type}`];
      if (typeof propertyListener === "function") {
        propertyListener(event);
      }
    },
  };
}

function makeFakeRTCPeerConnectionClass(options = {}) {
  const instances = [];

  class FakeRTCPeerConnection {
    constructor() {
      this.channels = [];
      this.listeners = new Map();
      this.localDescription = null;
      this.remoteDescription = null;
      this.addedIceCandidates = [];
      this.closed = false;
      this.connectionState = "new";
      this.iceConnectionState = "new";
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

    createDataChannel(label) {
      const channel = makeFakeRTCDataChannel(label);
      this.channels.push(channel);
      return channel;
    }

    async createOffer() {
      const error = options.createOfferErrors?.shift();
      if (error) {
        throw error;
      }

      return { type: "offer", sdp: "offer-sdp" };
    }

    async createAnswer() {
      const error = options.createAnswerErrors?.shift();
      if (error) {
        throw error;
      }

      return { type: "answer", sdp: "answer-sdp" };
    }

    async setLocalDescription(description) {
      const error = options.setLocalDescriptionErrors?.shift();
      if (error) {
        throw error;
      }

      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      const deferred = options.setRemoteDescriptionDeferreds?.shift();
      if (deferred) {
        await deferred.promise;
      }

      const error = options.setRemoteDescriptionErrors?.shift();
      if (error) {
        throw error;
      }

      this.remoteDescription = description;
    }

    async addIceCandidate(candidate) {
      const error = options.addIceCandidateErrors?.shift();
      if (error) {
        throw error;
      }

      this.addedIceCandidates.push(candidate);
    }

    close() {
      this.closed = true;
    }

    dispatchIceCandidate(candidate) {
      this.dispatch("icecandidate", { candidate });
    }

    dispatchDataChannel(channel) {
      this.dispatch("datachannel", { channel });
    }

    dispatchConnectionState(state) {
      this.connectionState = state;
      this.dispatch("connectionstatechange", {});
    }

    dispatchIceConnectionState(state) {
      this.iceConnectionState = state;
      this.dispatch("iceconnectionstatechange", {});
    }

    dispatch(type, event) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }

      const propertyListener = this[`on${type}`];
      if (typeof propertyListener === "function") {
        propertyListener(event);
      }
    }
  }

  FakeRTCPeerConnection.instances = instances;
  return FakeRTCPeerConnection;
}

function makeFakeSignaling(options = {}) {
  const handlers = new Set();

  return {
    sent: [],
    closed: false,

    sendSignal(message) {
      const error = options.sendSignalErrors?.shift();
      if (error) {
        throw error;
      }

      this.sent.push(message);
    },

    onMessage(handler) {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },

    dispatch(message) {
      for (const handler of handlers) {
        handler(message);
      }
    },

    get handlerCount() {
      return handlers.size;
    },

    close() {
      this.closed = true;
    },
  };
}

function makeEvent(overrides = {}) {
  return {
    id: "evt_000001",
    type: "stroke:point",
    boardId: "default",
    at: 12345,
    payload: { x: 10, y: 20 },
    ...overrides,
  };
}

function makeConnectionIdFactory() {
  let nextConnectionNumber = 1;

  return () => `connection-${nextConnectionNumber++}`;
}

function withConnectionId(payload, connectionId = "connection-1") {
  return { ...payload, connectionId };
}

function makeTransport({
  role = "board",
  signaling = makeFakeSignaling(),
  RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass(),
  createConnectionId = makeConnectionIdFactory(),
} = {}) {
  const transport = createWebRTCDataChannelTransport({
    signaling,
    role,
    sessionId: "session-1",
    peerId: `${role}-1`,
    RTCPeerConnectionImpl,
    createConnectionId,
  });

  return { transport, signaling, RTCPeerConnectionImpl };
}

async function connectBoardAndOpen({ transport, RTCPeerConnectionImpl }) {
  const connection = transport.connect();
  const pc = RTCPeerConnectionImpl.instances[0];
  const channel = pc.channels[0];
  channel.dispatchOpen();
  await connection;
  return { pc, channel };
}

async function connectViewerAndOpen({ transport, signaling, RTCPeerConnectionImpl }) {
  const connection = transport.connect();
  const pc = RTCPeerConnectionImpl.instances[0];

  signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
  });
  await flushAsyncWork();

  const channel = makeFakeRTCDataChannel("onboard-events");
  pc.dispatchDataChannel(channel);
  channel.dispatchOpen();
  await connection;

  return { pc, channel };
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
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

async function assertBoardReconnectsAfterSetupFailure({
  RTCPeerConnectionImpl,
  signaling = makeFakeSignaling(),
  expectedError,
}) {
  const transport = createWebRTCDataChannelTransport({
    signaling,
    role: "board",
    sessionId: "session-1",
    peerId: "board-1",
    RTCPeerConnectionImpl,
    createConnectionId: makeConnectionIdFactory(),
  });

  const failedConnection = transport.connect();
  await assert.rejects(failedConnection, expectedError);

  const failedPeer = RTCPeerConnectionImpl.instances[0];
  assert.equal(failedPeer.closed, true);
  assert.equal(failedPeer.channels[0]?.closed, true);
  assert.equal(signaling.handlerCount, 0);

  const secondConnection = transport.connect();
  const secondPeer = RTCPeerConnectionImpl.instances[1];
  const secondChannel = secondPeer.channels[0];
  secondChannel.dispatchOpen();
  await secondConnection;

  assert.notEqual(secondPeer, failedPeer);
  assert.equal(RTCPeerConnectionImpl.instances.length, 2);
}

async function assertViewerReconnectsAfterSignalFailure({
  RTCPeerConnectionImpl,
  signaling = makeFakeSignaling(),
  triggerFailure,
  expectedError,
}) {
  const transport = createWebRTCDataChannelTransport({
    signaling,
    role: "viewer",
    sessionId: "session-1",
    peerId: "viewer-1",
    RTCPeerConnectionImpl,
    createConnectionId: makeConnectionIdFactory(),
  });

  const failedConnection = transport.connect();
  const failedPeer = RTCPeerConnectionImpl.instances[0];
  triggerFailure(signaling, failedPeer);
  await assert.rejects(failedConnection, expectedError);

  assert.equal(failedPeer.closed, true);
  assert.equal(signaling.handlerCount, 0);

  const secondConnection = transport.connect();
  const secondPeer = RTCPeerConnectionImpl.instances[1];
  signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
  });
  await flushAsyncWork();

  const secondChannel = makeFakeRTCDataChannel("onboard-events");
  secondPeer.dispatchDataChannel(secondChannel);
  secondChannel.dispatchOpen();
  await secondConnection;

  assert.notEqual(secondPeer, failedPeer);
  assert.equal(RTCPeerConnectionImpl.instances.length, 2);
}

test("board role creates data channel named onboard-events", async () => {
  const setup = makeTransport({ role: "board" });

  await connectBoardAndOpen(setup);

  const pc = setup.RTCPeerConnectionImpl.instances[0];
  assert.equal(pc.channels.length, 1);
  assert.equal(pc.channels[0].label, "onboard-events");
});

test("viewer role waits for data channel", async () => {
  const setup = makeTransport({ role: "viewer" });
  let connected = false;

  const connection = setup.transport.connect().then(() => {
    connected = true;
  });
  const pc = setup.RTCPeerConnectionImpl.instances[0];
  await Promise.resolve();

  assert.equal(pc.channels.length, 0);
  assert.equal(connected, false);

  setup.signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
  });
  await Promise.resolve();

  const channel = makeFakeRTCDataChannel("onboard-events");
  pc.dispatchDataChannel(channel);
  channel.dispatchOpen();
  await connection;

  assert.equal(connected, true);
});

test("created transport satisfies assertTransport", () => {
  const { transport } = makeTransport();

  assert.equal(assertTransport(transport), transport);
});

test("factory rejects unsupported roles", () => {
  assert.throws(
    () =>
      makeTransport({
        role: "presenter",
      }),
    {
      name: "TypeError",
      message: /role/i,
    },
  );
});

test("send serializes board events once data channel is open", async () => {
  const setup = makeTransport({ role: "board" });
  const event = makeEvent();

  const { channel } = await connectBoardAndOpen(setup);
  setup.transport.send(event);

  assert.deepEqual(channel.sent, [JSON.stringify(event)]);
});

test("send before data channel open throws clearly", () => {
  const setup = makeTransport({ role: "board" });

  setup.transport.connect();

  assert.throws(() => setup.transport.send(makeEvent()), /open/i);
});

test("incoming data channel messages parse events and notify handlers", async () => {
  const setup = makeTransport({ role: "board" });
  const received = [];
  const event = makeEvent({ id: "evt_000002" });

  setup.transport.onEvent((message) => received.push(message));
  const { channel } = await connectBoardAndOpen(setup);
  channel.dispatchMessage(JSON.stringify(event));

  assert.deepEqual(received, [event]);
});

test("malformed data channel JSON is ignored", async () => {
  const setup = makeTransport({ role: "board" });
  const received = [];

  setup.transport.onEvent((message) => received.push(message));
  const { channel } = await connectBoardAndOpen(setup);
  channel.dispatchMessage("{not-json");

  assert.deepEqual(received, []);
});

test("offer answer and ice messages flow through signaling client", async () => {
  const boardSetup = makeTransport({ role: "board" });
  const boardConnection = boardSetup.transport.connect();
  const boardPc = boardSetup.RTCPeerConnectionImpl.instances[0];

  await flushAsyncWork();
  const boardConnectionId = boardSetup.signaling.sent[0].payload.connectionId;
  assert.deepEqual(boardSetup.signaling.sent[0], {
    type: "offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { type: "offer", sdp: "offer-sdp" },
      boardConnectionId,
    ),
  });

  boardSetup.signaling.dispatch({
    type: "signal:answer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { type: "answer", sdp: "answer-sdp" },
      boardConnectionId,
    ),
  });
  await flushAsyncWork();
  assert.deepEqual(boardPc.remoteDescription, {
    type: "answer",
    sdp: "answer-sdp",
  });

  boardPc.dispatchIceCandidate({ candidate: "board-candidate" });
  assert.deepEqual(boardSetup.signaling.sent[1], {
    type: "ice",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { candidate: "board-candidate" },
      boardConnectionId,
    ),
  });

  boardSetup.signaling.dispatch({
    type: "signal:ice",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { candidate: "viewer-candidate" },
      boardConnectionId,
    ),
  });
  await flushAsyncWork();
  assert.deepEqual(boardPc.addedIceCandidates, [
    { candidate: "viewer-candidate" },
  ]);

  boardPc.channels[0].dispatchOpen();
  await boardConnection;

  const viewerSetup = makeTransport({ role: "viewer" });
  const viewerConnection = viewerSetup.transport.connect();
  const viewerPc = viewerSetup.RTCPeerConnectionImpl.instances[0];
  const viewerConnectionId = "viewer-connection-1";
  viewerSetup.signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { type: "offer", sdp: "offer-sdp" },
      viewerConnectionId,
    ),
  });
  await flushAsyncWork();

  assert.deepEqual(viewerPc.remoteDescription, {
    type: "offer",
    sdp: "offer-sdp",
  });
  assert.deepEqual(viewerSetup.signaling.sent[0], {
    type: "answer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { type: "answer", sdp: "answer-sdp" },
      viewerConnectionId,
    ),
  });

  viewerPc.dispatchIceCandidate({ candidate: "viewer-candidate" });
  assert.deepEqual(viewerSetup.signaling.sent[1], {
    type: "ice",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { candidate: "viewer-candidate" },
      viewerConnectionId,
    ),
  });

  viewerSetup.signaling.dispatch({
    type: "signal:ice",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { candidate: "board-candidate" },
      viewerConnectionId,
    ),
  });
  await flushAsyncWork();
  assert.deepEqual(viewerPc.addedIceCandidates, [
    { candidate: "board-candidate" },
  ]);

  const channel = makeFakeRTCDataChannel("onboard-events");
  viewerPc.dispatchDataChannel(channel);
  channel.dispatchOpen();
  await viewerConnection;
});

test("signaling messages for other sessions and self messages are ignored", async () => {
  const boardSetup = makeTransport({ role: "board" });
  boardSetup.transport.connect();
  const boardPc = boardSetup.RTCPeerConnectionImpl.instances[0];

  boardSetup.signaling.dispatch({
    type: "signal:answer",
    sessionId: "other-session",
    peerId: "viewer-1",
    payload: { type: "answer", sdp: "wrong-session-answer" },
  });
  boardSetup.signaling.dispatch({
    type: "signal:answer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: { type: "answer", sdp: "self-answer" },
  });
  await flushAsyncWork();

  assert.equal(boardPc.remoteDescription, null);

  const viewerSetup = makeTransport({ role: "viewer" });
  viewerSetup.transport.connect();
  const viewerPc = viewerSetup.RTCPeerConnectionImpl.instances[0];

  viewerSetup.signaling.dispatch({
    type: "signal:offer",
    sessionId: "other-session",
    peerId: "board-1",
    payload: { type: "offer", sdp: "wrong-session-offer" },
  });
  viewerSetup.signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: { type: "offer", sdp: "self-offer" },
  });
  await flushAsyncWork();

  assert.equal(viewerPc.remoteDescription, null);
  assert.deepEqual(viewerSetup.signaling.sent, []);
});

test("remote ice is queued until remote description is set", async () => {
  const setup = makeTransport({ role: "viewer" });
  setup.transport.connect();
  const pc = setup.RTCPeerConnectionImpl.instances[0];
  const connectionId = "queued-ice-connection";

  setup.signaling.dispatch({
    type: "signal:ice",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { candidate: "early-board-candidate" },
      connectionId,
    ),
  });
  await flushAsyncWork();

  assert.deepEqual(pc.addedIceCandidates, []);

  setup.signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { type: "offer", sdp: "offer-sdp" },
      connectionId,
    ),
  });
  await flushAsyncWork();

  assert.deepEqual(pc.addedIceCandidates, [
    { candidate: "early-board-candidate" },
  ]);
});

test("close before data channel open rejects pending connect", async () => {
  const setup = makeTransport({ role: "board" });

  const connection = setup.transport.connect();
  setup.transport.close();

  await assert.rejects(connection, /closed/i);
});

test("data channel close before open rejects pending connect", async () => {
  const setup = makeTransport({ role: "board" });

  const connection = setup.transport.connect();
  const pc = setup.RTCPeerConnectionImpl.instances[0];
  pc.channels[0].dispatchClose();

  await assert.rejects(connection, /DataChannel closed before open/i);
});

test("data channel error before open rejects pending connect", async () => {
  const setup = makeTransport({ role: "board" });

  const connection = setup.transport.connect();
  const pc = setup.RTCPeerConnectionImpl.instances[0];
  pc.channels[0].dispatchError();

  await assert.rejects(connection, /DataChannel failed before open/i);
});

test("peer connection failure before data channel open rejects pending connect", async () => {
  const setup = makeTransport({ role: "board" });

  const connection = setup.transport.connect();
  const pc = setup.RTCPeerConnectionImpl.instances[0];
  pc.dispatchConnectionState("failed");

  await assert.rejects(connection, /PeerConnection failed before open/i);
});

test("createOffer failure cleans up and reconnect creates a fresh peer", async () => {
  const RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass({
    createOfferErrors: [new Error("createOffer failed")],
  });

  await assertBoardReconnectsAfterSetupFailure({
    RTCPeerConnectionImpl,
    expectedError: /createOffer failed/,
  });
});

test("setLocalDescription failure while creating an offer cleans up and reconnects", async () => {
  const RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass({
    setLocalDescriptionErrors: [new Error("setLocalDescription failed")],
  });

  await assertBoardReconnectsAfterSetupFailure({
    RTCPeerConnectionImpl,
    expectedError: /setLocalDescription failed/,
  });
});

test("sendSignal failure while sending an offer cleans up and reconnects", async () => {
  const signaling = makeFakeSignaling({
    sendSignalErrors: [new Error("offer signaling failed")],
  });

  await assertBoardReconnectsAfterSetupFailure({
    RTCPeerConnectionImpl: makeFakeRTCPeerConnectionClass(),
    signaling,
    expectedError: /offer signaling failed/,
  });
});

test("setRemoteDescription failure while handling an offer cleans up and reconnects", async () => {
  const RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass({
    setRemoteDescriptionErrors: [new Error("setRemoteDescription failed")],
  });

  await assertViewerReconnectsAfterSignalFailure({
    RTCPeerConnectionImpl,
    expectedError: /setRemoteDescription failed/,
    triggerFailure(signaling) {
      signaling.dispatch({
        type: "signal:offer",
        sessionId: "session-1",
        peerId: "board-1",
        payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
      });
    },
  });
});

test("createAnswer failure while handling an offer cleans up and reconnects", async () => {
  const RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass({
    createAnswerErrors: [new Error("createAnswer failed")],
  });

  await assertViewerReconnectsAfterSignalFailure({
    RTCPeerConnectionImpl,
    expectedError: /createAnswer failed/,
    triggerFailure(signaling) {
      signaling.dispatch({
        type: "signal:offer",
        sessionId: "session-1",
        peerId: "board-1",
        payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
      });
    },
  });
});

test("setLocalDescription failure while handling an offer cleans up and reconnects", async () => {
  const RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass({
    setLocalDescriptionErrors: [new Error("answer local description failed")],
  });

  await assertViewerReconnectsAfterSignalFailure({
    RTCPeerConnectionImpl,
    expectedError: /answer local description failed/,
    triggerFailure(signaling) {
      signaling.dispatch({
        type: "signal:offer",
        sessionId: "session-1",
        peerId: "board-1",
        payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
      });
    },
  });
});

test("sendSignal failure while sending an answer cleans up and reconnects", async () => {
  const signaling = makeFakeSignaling({
    sendSignalErrors: [new Error("answer signaling failed")],
  });

  await assertViewerReconnectsAfterSignalFailure({
    RTCPeerConnectionImpl: makeFakeRTCPeerConnectionClass(),
    signaling,
    expectedError: /answer signaling failed/,
    triggerFailure(signaling) {
      signaling.dispatch({
        type: "signal:offer",
        sessionId: "session-1",
        peerId: "board-1",
        payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
      });
    },
  });
});

test("addIceCandidate failure after remote description cleans up and reconnects", async () => {
  const RTCPeerConnectionImpl = makeFakeRTCPeerConnectionClass({
    addIceCandidateErrors: [new Error("addIceCandidate failed")],
  });

  await assertViewerReconnectsAfterSignalFailure({
    RTCPeerConnectionImpl,
    expectedError: /addIceCandidate failed/,
    triggerFailure(signaling) {
      signaling.dispatch({
        type: "signal:offer",
        sessionId: "session-1",
        peerId: "board-1",
        payload: withConnectionId({ type: "offer", sdp: "offer-sdp" }),
      });
      signaling.dispatch({
        type: "signal:ice",
        sessionId: "session-1",
        peerId: "board-1",
        payload: withConnectionId({ candidate: "bad-candidate" }),
      });
    },
  });
});

test("stale async offer handling does not mutate a fresh peer after reconnect", async () => {
  const delayedRemoteDescription = createDeferred();
  const signaling = makeFakeSignaling();
  const setup = makeTransport({
    role: "viewer",
    signaling,
    RTCPeerConnectionImpl: makeFakeRTCPeerConnectionClass({
      setRemoteDescriptionDeferreds: [delayedRemoteDescription],
    }),
  });
  const oldConnectionId = "old-connection";
  const freshConnectionId = "fresh-connection";

  const firstConnection = setup.transport.connect();
  const firstPeer = setup.RTCPeerConnectionImpl.instances[0];
  signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { type: "offer", sdp: "old-offer-sdp" },
      oldConnectionId,
    ),
  });
  await flushAsyncWork();

  setup.transport.close();
  await assert.rejects(firstConnection, /closed/i);

  const secondConnection = setup.transport.connect();
  const secondPeer = setup.RTCPeerConnectionImpl.instances[1];
  delayedRemoteDescription.resolve();
  await flushAsyncWork();

  assert.equal(firstPeer.closed, true);
  assert.equal(secondPeer.localDescription, null);
  assert.equal(secondPeer.remoteDescription, null);
  assert.deepEqual(signaling.sent, []);

  signaling.dispatch({
    type: "signal:offer",
    sessionId: "session-1",
    peerId: "board-1",
    payload: withConnectionId(
      { type: "offer", sdp: "fresh-offer-sdp" },
      freshConnectionId,
    ),
  });
  await flushAsyncWork();

  assert.deepEqual(secondPeer.remoteDescription, {
    type: "offer",
    sdp: "fresh-offer-sdp",
  });
  assert.deepEqual(signaling.sent[0], {
    type: "answer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { type: "answer", sdp: "answer-sdp" },
      freshConnectionId,
    ),
  });

  const channel = makeFakeRTCDataChannel("onboard-events");
  secondPeer.dispatchDataChannel(channel);
  channel.dispatchOpen();
  await secondConnection;
});

test("stale answer and ice from old connection are ignored after reconnect", async () => {
  const setup = makeTransport({ role: "board" });

  const firstConnection = setup.transport.connect();
  await flushAsyncWork();
  const firstPeer = setup.RTCPeerConnectionImpl.instances[0];
  const oldConnectionId = setup.signaling.sent[0].payload.connectionId;

  setup.transport.close();
  await assert.rejects(firstConnection, /closed/i);

  const secondConnection = setup.transport.connect();
  await flushAsyncWork();
  const secondPeer = setup.RTCPeerConnectionImpl.instances[1];
  const freshConnectionId = setup.signaling.sent[1].payload.connectionId;
  assert.notEqual(freshConnectionId, oldConnectionId);

  setup.signaling.dispatch({
    type: "signal:answer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { type: "answer", sdp: "stale-answer-sdp" },
      oldConnectionId,
    ),
  });
  setup.signaling.dispatch({
    type: "signal:ice",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { candidate: "stale-viewer-candidate" },
      oldConnectionId,
    ),
  });
  await flushAsyncWork();

  assert.equal(firstPeer.closed, true);
  assert.equal(secondPeer.remoteDescription, null);
  assert.deepEqual(secondPeer.addedIceCandidates, []);

  setup.signaling.dispatch({
    type: "signal:answer",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { type: "answer", sdp: "fresh-answer-sdp" },
      freshConnectionId,
    ),
  });
  setup.signaling.dispatch({
    type: "signal:ice",
    sessionId: "session-1",
    peerId: "viewer-1",
    payload: withConnectionId(
      { candidate: "fresh-viewer-candidate" },
      freshConnectionId,
    ),
  });
  await flushAsyncWork();

  assert.deepEqual(secondPeer.remoteDescription, {
    type: "answer",
    sdp: "fresh-answer-sdp",
  });
  assert.deepEqual(secondPeer.addedIceCandidates, [
    { candidate: "fresh-viewer-candidate" },
  ]);

  secondPeer.channels[0].dispatchOpen();
  await secondConnection;
});

test("sendSignal failure while emitting local ice rejects and cleans up", async () => {
  const signaling = makeFakeSignaling({
    sendSignalErrors: [new Error("ice signaling failed")],
  });
  const setup = makeTransport({
    role: "board",
    signaling,
    RTCPeerConnectionImpl: makeFakeRTCPeerConnectionClass(),
  });

  const connection = setup.transport.connect();
  const peer = setup.RTCPeerConnectionImpl.instances[0];
  peer.dispatchIceCandidate({ candidate: "local-candidate" });

  await assert.rejects(connection, /ice signaling failed/);
  assert.equal(peer.closed, true);
  assert.equal(peer.channels[0].closed, true);
  assert.equal(signaling.handlerCount, 0);
});

test("data channel close after open cleans up peer connection and signaling", async () => {
  const setup = makeTransport({ role: "board" });

  const { pc, channel } = await connectBoardAndOpen(setup);
  assert.equal(setup.signaling.handlerCount, 1);

  channel.dispatchClose();

  assert.equal(pc.closed, true);
  assert.equal(setup.signaling.handlerCount, 0);
  assert.equal(setup.signaling.closed, true);
});

test("peer connection failure after open closes channel and signaling", async () => {
  const setup = makeTransport({ role: "board" });

  const { pc, channel } = await connectBoardAndOpen(setup);
  assert.equal(setup.signaling.handlerCount, 1);

  pc.dispatchConnectionState("failed");

  assert.equal(pc.closed, true);
  assert.equal(channel.closed, true);
  assert.equal(setup.signaling.handlerCount, 0);
  assert.equal(setup.signaling.closed, true);
});

test("close closes peer connection and channel", async () => {
  const setup = makeTransport({ role: "board" });

  const { pc, channel } = await connectBoardAndOpen(setup);
  setup.transport.close();

  assert.equal(pc.closed, true);
  assert.equal(channel.closed, true);
});
