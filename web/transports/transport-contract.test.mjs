import assert from "node:assert/strict";
import test from "node:test";

import { assertTransport } from "./transport-contract.js";

function makeTransport(overrides = {}) {
  return {
    connect() {},
    send() {},
    onEvent() {},
    close() {},
    ...overrides,
  };
}

test("assertTransport accepts a transport with required methods", () => {
  const transport = makeTransport();

  assert.equal(assertTransport(transport), transport);
});

test("assertTransport throws TypeError with missing method name", () => {
  for (const method of ["connect", "send", "onEvent", "close"]) {
    const transport = makeTransport();
    delete transport[method];

    assert.throws(() => assertTransport(transport), {
      name: "TypeError",
      message: new RegExp(method),
    });
  }
});
