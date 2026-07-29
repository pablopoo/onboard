import { assertTransport } from "./transport-contract.js";

export function createWebSocketRelayTransport({
  url,
  WebSocketImpl = WebSocket,
  reconnectDelayMs = 250,
  readyTimeoutMs = 5_000,
  maxQueuedEvents = 1_000,
  setTimeout: setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout?.bind(globalThis),
}) {
  const handlers = new Set();
  const statusHandlers = new Set();
  const openReadyState = WebSocketImpl.OPEN ?? 1;
  let socket = null;
  let connectPromise = null;
  let reconnectTimer = null;
  let readyTimer = null;
  let started = false;
  let closed = false;
  let hasOpened = false;
  let relayReady = false;
  let lastStatus = null;
  const outbox = [];

  function parseMessage(message) {
    let event;

    try {
      event = JSON.parse(message.data);
    } catch {
      return null;
    }

    return event;
  }

  function isSocketOpen(currentSocket = socket) {
    return currentSocket?.readyState === openReadyState;
  }

  function isRelayReady() {
    return relayReady && isSocketOpen();
  }

  function emitStatus(status) {
    if (status === lastStatus) {
      return;
    }

    lastStatus = status;
    for (const handler of statusHandlers) {
      handler(status);
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimer?.(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(delayMs = reconnectDelayMs) {
    if (
      closed ||
      !started ||
      reconnectTimer !== null ||
      connectPromise ||
      typeof setTimer !== "function"
    ) {
      return;
    }

    emitStatus("reconnecting");
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      transport.connect().catch(() => {
        scheduleReconnect();
      });
    }, delayMs);
  }

  function flushOutbox() {
    while (outbox.length > 0 && isRelayReady()) {
      socket.send(outbox.shift());
    }
  }

  function openSocket() {
    clearReconnectTimer();
    emitStatus(hasOpened ? "reconnecting" : "connecting");

    const currentSocket = new WebSocketImpl(url);
    socket = currentSocket;
    relayReady = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      function cleanupOpeningListeners() {
        currentSocket.removeEventListener?.("open", handleOpen);
        currentSocket.removeEventListener?.("error", handleErrorBeforeOpen);
        currentSocket.removeEventListener?.("close", handleCloseBeforeOpen);
      }

      function cleanupRuntimeListeners() {
        currentSocket.removeEventListener?.("message", handleRuntimeMessage);
        currentSocket.removeEventListener?.("error", handleRuntimeFault);
        currentSocket.removeEventListener?.("close", handleRuntimeFault);
        if (readyTimer !== null) {
          clearTimer?.(readyTimer);
          readyTimer = null;
        }
      }

      function rejectBeforeOpen(error) {
        if (settled) {
          return;
        }
        settled = true;
        cleanupOpeningListeners();
        cleanupRuntimeListeners();
        if (socket === currentSocket) {
          socket = null;
        }
        relayReady = false;
        connectPromise = null;
        reject(error);
        scheduleReconnect();
      }

      function handleOpen() {
        cleanupOpeningListeners();
        currentSocket.addEventListener("message", handleRuntimeMessage);
        currentSocket.addEventListener("error", handleRuntimeFault);
        currentSocket.addEventListener("close", handleRuntimeFault);
        if (typeof setTimer === "function") {
          readyTimer = setTimer(() => {
            readyTimer = null;
            rejectBeforeOpen(new Error("WebSocket relay ready timeout"));
            currentSocket.close();
          }, readyTimeoutMs);
        }
      }

      function handleErrorBeforeOpen() {
        emitStatus(hasOpened ? "reconnecting" : "disconnected");
        rejectBeforeOpen(new Error("WebSocket failed before open"));
      }

      function handleCloseBeforeOpen() {
        emitStatus(hasOpened ? "reconnecting" : "disconnected");
        rejectBeforeOpen(new Error("WebSocket closed before open"));
      }

      function handleRuntimeFault() {
        if (!relayReady && !settled) {
          emitStatus(hasOpened ? "reconnecting" : "disconnected");
          rejectBeforeOpen(new Error("WebSocket failed before relay ready"));
          return;
        }
        cleanupRuntimeListeners();
        if (socket === currentSocket) {
          socket = null;
        }
        relayReady = false;
        connectPromise = null;
        if (!closed && started) {
          emitStatus("reconnecting");
          scheduleReconnect();
        }
      }

      function handleRuntimeMessage(message) {
        const event = parseMessage(message);
        if (!event) {
          return;
        }
        if (event.type === "system:relay-ready") {
          if (settled) {
            return;
          }
          settled = true;
          if (readyTimer !== null) {
            clearTimer?.(readyTimer);
            readyTimer = null;
          }
          relayReady = true;
          hasOpened = true;
          connectPromise = null;
          flushOutbox();
          emitStatus("connected");
          resolve();
          return;
        }
        for (const handler of handlers) {
          handler(event);
        }
      }

      currentSocket.addEventListener("open", handleOpen);
      currentSocket.addEventListener("error", handleErrorBeforeOpen);
      currentSocket.addEventListener("close", handleCloseBeforeOpen);

      if (isSocketOpen(currentSocket)) {
        handleOpen();
      }
    });
  }

  const transport = {
    connect() {
      started = true;
      closed = false;

      if (isRelayReady()) {
        return Promise.resolve();
      }

      if (connectPromise) {
        return connectPromise;
      }

      connectPromise = openSocket();
      return connectPromise;
    },

    send(event) {
      const data = JSON.stringify(event);

      if (isRelayReady()) {
        socket.send(data);
        return;
      }

      if (started && !closed) {
        if (outbox.length >= maxQueuedEvents) {
          throw new Error("WebSocket reconnect queue is full");
        }

        outbox.push(data);
        scheduleReconnect(0);
        return;
      }

      if (!started) {
        throw new Error("connect before sending events");
      }

      throw new Error("WebSocket must be open before sending events");
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
      closed = true;
      started = false;
      clearReconnectTimer();
      if (readyTimer !== null) {
        clearTimer?.(readyTimer);
        readyTimer = null;
      }
      outbox.length = 0;
      relayReady = false;

      if (!socket) {
        return;
      }

      const currentSocket = socket;
      socket = null;
      connectPromise = null;
      currentSocket.close();
    },
  };

  return assertTransport(transport);
}
