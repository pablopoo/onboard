import { assertTransport } from "./transport-contract.js";

const DATA_CHANNEL_LABEL = "onboard-events";
const VALID_ROLES = new Set(["board", "viewer"]);

export function createWebRTCDataChannelTransport({
  signaling,
  role,
  sessionId,
  peerId,
  RTCPeerConnectionImpl = RTCPeerConnection,
  createConnectionId = defaultCreateConnectionId,
  closeSignalingOnClose = true,
}) {
  if (!VALID_ROLES.has(role)) {
    throw new TypeError("role must be either board or viewer");
  }

  const handlers = new Set();
  const statusHandlers = new Set();
  let peerConnection = null;
  let dataChannel = null;
  let unsubscribeSignals = null;
  let cleanupListeners = [];
  let connectPromise = null;
  let resolveConnect = null;
  let rejectConnect = null;
  let connectResolved = false;
  let remoteDescriptionSet = false;
  let pendingRemoteIceCandidates = [];
  let localConnectionId = null;
  let remoteConnectionId = null;
  let lastStatus = null;

  function emitStatus(status) {
    if (status === lastStatus) {
      return;
    }

    lastStatus = status;
    for (const handler of statusHandlers) {
      handler(status);
    }
  }

  function attachDataChannel(channel) {
    dataChannel = channel;
    trackListener(channel, "message", handleDataChannelMessage);
    trackListener(channel, "open", handleDataChannelOpen);
    trackListener(channel, "close", handleDataChannelClose);
    trackListener(channel, "error", handleDataChannelError);

    if (channel.readyState === "open") {
      handleDataChannelOpen();
    }
  }

  function handleDataChannelOpen() {
    connectResolved = true;
    emitStatus("connected");
    resolveConnect?.();
    resolveConnect = null;
    rejectConnect = null;
  }

  function handleDataChannelMessage(message) {
    let event;

    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  }

  function handleDataChannelClose() {
    if (!connectResolved) {
      closeWithPendingError(new Error("DataChannel closed before open"));
      return;
    }

    closeResources();
  }

  function handleDataChannelError() {
    if (!connectResolved) {
      closeWithPendingError(new Error("DataChannel failed before open"));
      return;
    }

    closeResources();
  }

  function handleIceCandidate(message, currentPeerConnection) {
    if (!message.candidate) {
      return;
    }

    const connectionId = activeSignalConnectionId();
    if (!connectionId) {
      return;
    }

    try {
      signaling.sendSignal({
        type: "ice",
        sessionId,
        peerId,
        payload: withSignalConnectionId(message.candidate, connectionId),
      });
    } catch (error) {
      closeWithPendingErrorFor(currentPeerConnection, error);
    }
  }

  async function handleSignal(message, currentPeerConnection) {
    if (
      !peerConnection ||
      peerConnection !== currentPeerConnection ||
      !shouldHandleSignal(message)
    ) {
      return;
    }

    const type = normalizeSignalType(message.type);
    const connectionId = signalConnectionId(message);

    if (role === "viewer" && type === "offer") {
      if (!connectionId) {
        return;
      }

      if (remoteConnectionId && remoteConnectionId !== connectionId) {
        return;
      }

      remoteConnectionId = connectionId;
      const didSetRemoteDescription = await setRemoteDescription(
        currentPeerConnection,
        withoutSignalConnectionId(message.payload),
        connectionId,
      );
      if (!didSetRemoteDescription) {
        return;
      }

      const answer = await currentPeerConnection.createAnswer();
      if (peerConnection !== currentPeerConnection) {
        return;
      }

      await currentPeerConnection.setLocalDescription(answer);
      if (peerConnection !== currentPeerConnection) {
        return;
      }

      signaling.sendSignal({
        type: "answer",
        sessionId,
        peerId,
        payload: withSignalConnectionId(answer, connectionId),
      });
      return;
    }

    if (role === "board" && type === "answer") {
      if (!matchesActiveSignalConnection(message)) {
        return;
      }

      await setRemoteDescription(
        currentPeerConnection,
        withoutSignalConnectionId(message.payload),
        connectionId,
      );
      return;
    }

    if (type === "ice") {
      if (!shouldAcceptRemoteIce(connectionId)) {
        return;
      }

      await addRemoteIceCandidate(
        currentPeerConnection,
        withoutSignalConnectionId(message.payload),
        connectionId,
      );
    }
  }

  async function setRemoteDescription(
    currentPeerConnection,
    description,
    connectionId,
  ) {
    await currentPeerConnection.setRemoteDescription(description);
    if (!isCurrentSignalConnection(currentPeerConnection, connectionId)) {
      return false;
    }

    remoteDescriptionSet = true;
    await flushRemoteIceCandidates(currentPeerConnection, connectionId);
    return isCurrentSignalConnection(currentPeerConnection, connectionId);
  }

  async function addRemoteIceCandidate(
    currentPeerConnection,
    candidate,
    connectionId,
  ) {
    if (!isCurrentPeerConnection(currentPeerConnection)) {
      return;
    }

    if (!remoteDescriptionSet) {
      pendingRemoteIceCandidates.push({ candidate, connectionId });
      return;
    }

    if (!matchesCurrentConnectionId(connectionId)) {
      return;
    }

    await currentPeerConnection.addIceCandidate(candidate);
  }

  async function flushRemoteIceCandidates(currentPeerConnection, connectionId) {
    const pendingCandidates = pendingRemoteIceCandidates;
    pendingRemoteIceCandidates = [];

    for (const pendingCandidate of pendingCandidates) {
      if (!isCurrentSignalConnection(currentPeerConnection, connectionId)) {
        return;
      }

      if (pendingCandidate.connectionId !== connectionId) {
        continue;
      }

      await currentPeerConnection.addIceCandidate(pendingCandidate.candidate);
    }
  }

  function isCurrentPeerConnection(currentPeerConnection) {
    return peerConnection === currentPeerConnection;
  }

  function isCurrentSignalConnection(currentPeerConnection, connectionId) {
    return (
      isCurrentPeerConnection(currentPeerConnection) &&
      matchesCurrentConnectionId(connectionId)
    );
  }

  function matchesActiveSignalConnection(message) {
    return matchesCurrentConnectionId(signalConnectionId(message));
  }

  function matchesCurrentConnectionId(connectionId) {
    return connectionId !== null && activeSignalConnectionId() === connectionId;
  }

  function shouldAcceptRemoteIce(connectionId) {
    if (!connectionId) {
      return false;
    }

    if (role === "viewer" && !remoteConnectionId) {
      return true;
    }

    return matchesCurrentConnectionId(connectionId);
  }

  function activeSignalConnectionId() {
    return role === "board" ? localConnectionId : remoteConnectionId;
  }

  function withSignalConnectionId(payload, connectionId) {
    return {
      ...payloadToObject(payload),
      connectionId,
    };
  }

  function signalConnectionId(message) {
    const connectionId = message?.payload?.connectionId;
    return typeof connectionId === "string" && connectionId.length > 0
      ? connectionId
      : null;
  }

  function withoutSignalConnectionId(payload) {
    const { connectionId: _connectionId, ...rest } = payloadToObject(payload);
    return rest;
  }

  function payloadToObject(payload) {
    if (typeof payload?.toJSON === "function") {
      return payload.toJSON();
    }

    return payload ?? {};
  }

  function handlePeerConnectionStateChange() {
    if (!peerConnection) {
      return;
    }

    if (peerConnection.connectionState === "failed") {
      if (!connectResolved) {
        closeWithPendingError(new Error("PeerConnection failed before open"));
      } else {
        closeResources();
      }
      return;
    }

    if (peerConnection.connectionState === "closed") {
      if (!connectResolved) {
        closeWithPendingError(new Error("PeerConnection closed before open"));
      } else {
        closeResources();
      }
    }
  }

  function handleIceConnectionStateChange() {
    if (!peerConnection) {
      return;
    }

    if (peerConnection.iceConnectionState === "failed") {
      if (!connectResolved) {
        closeWithPendingError(new Error("PeerConnection failed before open"));
      } else {
        closeResources();
      }
      return;
    }

    if (peerConnection.iceConnectionState === "closed") {
      if (!connectResolved) {
        closeWithPendingError(new Error("PeerConnection closed before open"));
      } else {
        closeResources();
      }
    }
  }

  function startBoardConnection() {
    const currentPeerConnection = peerConnection;
    attachDataChannel(currentPeerConnection.createDataChannel(DATA_CHANNEL_LABEL));

    currentPeerConnection
      .createOffer()
      .then(async (offer) => {
        if (peerConnection !== currentPeerConnection) {
          return;
        }

        await currentPeerConnection.setLocalDescription(offer);

        if (peerConnection !== currentPeerConnection) {
          return;
        }

        signaling.sendSignal({
          type: "offer",
          sessionId,
          peerId,
          payload: withSignalConnectionId(offer, localConnectionId),
        });
      })
      .catch((error) => {
        closeWithPendingErrorFor(currentPeerConnection, error);
      });
  }

  function shouldHandleSignal(message) {
    return message?.sessionId === sessionId && message.peerId !== peerId;
  }

  function rejectPendingConnect(error) {
    if (connectPromise && !connectResolved) {
      rejectConnect?.(error);
    }

    resolveConnect = null;
    rejectConnect = null;
  }

  function closeWithPendingError(error) {
    rejectPendingConnect(error);
    closeResources();
  }

  function closeWithPendingErrorFor(currentPeerConnection, error) {
    if (peerConnection !== currentPeerConnection) {
      return;
    }

    closeWithPendingError(error);
  }

  function closeResources() {
    for (const cleanup of cleanupListeners.splice(0)) {
      cleanup();
    }

    unsubscribeSignals?.();
    unsubscribeSignals = null;
    if (closeSignalingOnClose) {
      signaling.close?.();
    }

    const channel = dataChannel;
    dataChannel = null;
    if (channel && channel.readyState !== "closed") {
      channel.close();
    }

    const connection = peerConnection;
    peerConnection = null;
    connection?.close();

    connectPromise = null;
    connectResolved = false;
    remoteDescriptionSet = false;
    pendingRemoteIceCandidates = [];
    localConnectionId = null;
    remoteConnectionId = null;
    emitStatus("disconnected");
  }

  function trackListener(target, type, listener) {
    cleanupListeners.push(addListener(target, type, listener));
  }

  const transport = {
    connect() {
      if (connectPromise) {
        return connectPromise;
      }

      emitStatus("connecting");
      peerConnection = new RTCPeerConnectionImpl();
      connectResolved = false;
      remoteDescriptionSet = false;
      pendingRemoteIceCandidates = [];
      localConnectionId = createConnectionId();
      remoteConnectionId = null;

      const currentPeerConnection = peerConnection;
      trackListener(currentPeerConnection, "icecandidate", (event) => {
        handleIceCandidate(event, currentPeerConnection);
      });
      trackListener(peerConnection, "connectionstatechange", handlePeerConnectionStateChange);
      trackListener(
        peerConnection,
        "iceconnectionstatechange",
        handleIceConnectionStateChange,
      );
      trackListener(peerConnection, "datachannel", (event) => {
        if (event.channel?.label === DATA_CHANNEL_LABEL) {
          attachDataChannel(event.channel);
        }
      });
      unsubscribeSignals = signaling.onMessage((message) => {
        const currentPeerConnection = peerConnection;
        if (message?.type === "error") {
          closeWithPendingErrorFor(
            currentPeerConnection,
            new Error(`WebRTC signaling error: ${message.error ?? "unknown error"}`),
          );
          return;
        }

        handleSignal(message, currentPeerConnection).catch((error) => {
          closeWithPendingErrorFor(currentPeerConnection, error);
        });
      });

      connectPromise = new Promise((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = reject;
      });

      if (role === "board") {
        startBoardConnection();
      }

      return connectPromise;
    },

    send(event) {
      if (!dataChannel || dataChannel.readyState !== "open") {
        throw new Error("DataChannel must be open before sending events");
      }

      dataChannel.send(JSON.stringify(event));
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

    close() {
      rejectPendingConnect(new Error("WebRTC transport closed before open"));
      closeResources();
    },
  };

  return assertTransport(transport);
}

function addListener(target, type, listener) {
  if (typeof target.addEventListener === "function") {
    target.addEventListener(type, listener);
    return () => {
      target.removeEventListener?.(type, listener);
    };
  }

  target[`on${type}`] = listener;
  return () => {
    if (target[`on${type}`] === listener) {
      target[`on${type}`] = null;
    }
  };
}

function normalizeSignalType(type) {
  return typeof type === "string" && type.startsWith("signal:")
    ? type.slice("signal:".length)
    : type;
}

function defaultCreateConnectionId() {
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
