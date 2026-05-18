const REQUIRED_METHODS = ["connect", "send", "onEvent", "close"];

export function assertTransport(transport) {
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    throw new TypeError("transport must be an object");
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof transport[method] !== "function") {
      throw new TypeError(`transport missing method: ${method}`);
    }
  }

  return transport;
}
