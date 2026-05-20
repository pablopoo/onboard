import { assertTransport } from "./transport-contract.js";

export function createWebSocketRelayTransport({
  url,
  WebSocketImpl = WebSocket,
  reconnectDelayMs = 250,
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
  let started = false;
  let closed = false;
  let hasOpened = false;
  let lastStatus = null;
  const outbox = [];

  function handleMessage(message) {
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

  function isSocketOpen(currentSocket = socket) {
    return currentSocket?.readyState === openReadyState;
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
    while (outbox.length > 0 && isSocketOpen()) {
      socket.send(outbox.shift());
    }
  }

  function openSocket() {
    clearReconnectTimer();
    emitStatus(hasOpened ? "reconnecting" : "connecting");

    const currentSocket = new WebSocketImpl(url);
    socket = currentSocket;

    return new Promise((resolve, reject) => {
      function cleanupOpeningListeners() {
        currentSocket.removeEventListener?.("open", handleOpen);
        currentSocket.removeEventListener?.("error", handleErrorBeforeOpen);
        currentSocket.removeEventListener?.("close", handleCloseBeforeOpen);
      }

      function cleanupRuntimeListeners() {
        currentSocket.removeEventListener?.("message", handleMessage);
        currentSocket.removeEventListener?.("error", handleRuntimeFault);
        currentSocket.removeEventListener?.("close", handleRuntimeFault);
      }

      function rejectBeforeOpen(error) {
        cleanupOpeningListeners();
        if (socket === currentSocket) {
          socket = null;
        }
        connectPromise = null;
        reject(error);
      }

      function handleOpen() {
        cleanupOpeningListeners();
        hasOpened = true;
        connectPromise = null;

        currentSocket.addEventListener("message", handleMessage);
        currentSocket.addEventListener("error", handleRuntimeFault);
        currentSocket.addEventListener("close", handleRuntimeFault);

        flushOutbox();
        emitStatus("connected");
        resolve();
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
        cleanupRuntimeListeners();
        if (socket === currentSocket) {
          socket = null;
        }
        connectPromise = null;
        if (!closed && started) {
          emitStatus("reconnecting");
          scheduleReconnect();
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

      if (isSocketOpen()) {
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

      if (isSocketOpen()) {
        socket.send(data);
        return;
      }

      if (hasOpened && started && !closed) {
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
      outbox.length = 0;

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
