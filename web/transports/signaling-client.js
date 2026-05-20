const SIGNAL_TYPES = new Set(["offer", "answer", "ice"]);
const INBOUND_SIGNAL_TYPES = new Set([
  "signal:offer",
  "signal:answer",
  "signal:ice",
  "session:peer-left",
]);

export function createSignalingClient({
  url = "/signal",
  WebSocketImpl = WebSocket,
} = {}) {
  const handlers = new Set();
  const openReadyState = WebSocketImpl.OPEN ?? 1;
  let socket = null;
  let socketMessageHandler = null;
  let socketErrorHandler = null;
  let socketCloseHandler = null;
  let connectionPromise = null;

  function notifyHandlers(message) {
    for (const handler of handlers) {
      handler(message);
    }
  }

  function handleMessage(currentSocket, message) {
    if (socket !== currentSocket || currentSocket.readyState !== openReadyState) {
      return;
    }

    let parsed;

    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }

    if (!isInboundMessage(parsed)) {
      return;
    }

    notifyHandlers(parsed);
  }

  function detachSocket(currentSocket) {
    if (socketMessageHandler) {
      currentSocket.removeEventListener?.("message", socketMessageHandler);
    }
    if (socketErrorHandler) {
      currentSocket.removeEventListener?.("error", socketErrorHandler);
    }
    if (socketCloseHandler) {
      currentSocket.removeEventListener?.("close", socketCloseHandler);
    }

    if (socket === currentSocket) {
      socket = null;
      socketMessageHandler = null;
      socketErrorHandler = null;
      socketCloseHandler = null;
      connectionPromise = null;
    }
  }

  function handleRuntimeFailure(currentSocket, error) {
    if (socket !== currentSocket) {
      return;
    }

    detachSocket(currentSocket);
    notifyHandlers({
      type: "error",
      error,
    });
  }

  function sendMessage(message) {
    if (!socket) {
      throw new Error("connect before sending signaling messages");
    }

    if (socket.readyState !== openReadyState) {
      throw new Error("WebSocket must be open before sending signaling messages");
    }

    socket.send(JSON.stringify(message));
  }

  return {
    connect() {
      if (socket?.readyState === openReadyState) {
        return Promise.resolve();
      }

      if (connectionPromise) {
        return connectionPromise;
      }

      const currentSocket = new WebSocketImpl(url);
      const currentMessageHandler = (message) => {
        handleMessage(currentSocket, message);
      };
      socket = currentSocket;
      socketMessageHandler = currentMessageHandler;
      currentSocket.addEventListener("message", currentMessageHandler);

      connectionPromise = new Promise((resolve, reject) => {
        function cleanup() {
          currentSocket.removeEventListener?.("open", handleOpen);
          currentSocket.removeEventListener?.("error", handleError);
          currentSocket.removeEventListener?.("close", handleClose);
        }

        function handleOpen() {
          cleanup();
          if (socket === currentSocket) {
            connectionPromise = null;
            socketErrorHandler = () => {
              handleRuntimeFailure(
                currentSocket,
                "WebSocket signaling error",
              );
            };
            socketCloseHandler = () => {
              handleRuntimeFailure(
                currentSocket,
                "WebSocket signaling closed",
              );
            };
            currentSocket.addEventListener("error", socketErrorHandler);
            currentSocket.addEventListener("close", socketCloseHandler);
          }
          resolve();
        }

        function handleError() {
          cleanup();
          detachSocket(currentSocket);
          reject(new Error("WebSocket failed before open"));
        }

        function handleClose() {
          cleanup();
          detachSocket(currentSocket);
          reject(new Error("WebSocket closed before open"));
        }

        currentSocket.addEventListener("open", handleOpen);
        currentSocket.addEventListener("error", handleError);
        currentSocket.addEventListener("close", handleClose);

        if (currentSocket.readyState === openReadyState) {
          handleOpen();
        }
      });

      return connectionPromise;
    },

    createSession(peerId) {
      sendMessage({
        type: "session:create",
        peerId,
      });
    },

    joinSession(sessionId, peerId) {
      sendMessage({
        type: "session:join",
        sessionId,
        peerId,
      });
    },

    sendSignal({ type, sessionId, peerId, payload }) {
      const signalType = normalizeSignalType(type);
      sendMessage({
        type: `signal:${signalType}`,
        sessionId,
        peerId,
        payload,
      });
    },

    onMessage(handler) {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },

    close() {
      if (!socket) {
        return;
      }

      const currentSocket = socket;
      detachSocket(currentSocket);
      currentSocket.close();
    },
  };
}

function isInboundMessage(message) {
  if (!isObject(message)) {
    return false;
  }

  if (INBOUND_SIGNAL_TYPES.has(message.type)) {
    return (
      hasString(message.sessionId) &&
      hasString(message.peerId) &&
      isObject(message.payload)
    );
  }

  switch (message.type) {
    case "session:created":
    case "session:joined":
      return (
        hasString(message.sessionId) &&
        hasString(message.peerId) &&
        hasString(message.role)
      );

    case "error":
      return hasString(message.error);

    default:
      return false;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeSignalType(type) {
  const signalType =
    typeof type === "string" && type.startsWith("signal:")
      ? type.slice("signal:".length)
      : type;

  if (!SIGNAL_TYPES.has(signalType)) {
    throw new Error(`unknown signal type: ${type}`);
  }

  return signalType;
}
