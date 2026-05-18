import { assertTransport } from "./transport-contract.js";

export function createWebSocketRelayTransport({
  url,
  WebSocketImpl = WebSocket,
}) {
  const handlers = new Set();
  const openReadyState = WebSocketImpl.OPEN ?? 1;
  let socket = null;

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

  const transport = {
    connect() {
      const currentSocket = new WebSocketImpl(url);
      socket = currentSocket;
      currentSocket.addEventListener("message", handleMessage);

      return new Promise((resolve, reject) => {
        function cleanup() {
          currentSocket.removeEventListener?.("open", handleOpen);
          currentSocket.removeEventListener?.("error", handleError);
          currentSocket.removeEventListener?.("close", handleClose);
        }

        function handleOpen() {
          cleanup();
          resolve();
        }

        function handleError() {
          cleanup();
          if (socket === currentSocket) {
            socket = null;
          }
          reject(new Error("WebSocket failed before open"));
        }

        function handleClose() {
          cleanup();
          if (socket === currentSocket) {
            socket = null;
          }
          reject(new Error("WebSocket closed before open"));
        }

        currentSocket.addEventListener("open", handleOpen);
        currentSocket.addEventListener("error", handleError);
        currentSocket.addEventListener("close", handleClose);

        if (currentSocket.readyState === openReadyState) {
          handleOpen();
        }
      });
    },

    send(event) {
      if (!socket) {
        throw new Error("connect before sending events");
      }

      if (socket.readyState !== openReadyState) {
        throw new Error("WebSocket must be open before sending events");
      }

      socket.send(JSON.stringify(event));
    },

    onEvent(handler) {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },

    close() {
      if (!socket) {
        return;
      }

      socket.close();
      socket = null;
    },
  };

  return assertTransport(transport);
}
