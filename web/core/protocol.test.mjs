import assert from "node:assert/strict";
import test from "node:test";

import {
  createBoardEvent,
  isToolAllowedForSurface,
  normalizePoint,
  validateBoardEvent,
} from "./protocol.js";

function makeEvent(type, payload = {}, overrides = {}) {
  return {
    id: "evt_test",
    type,
    boardId: "default",
    at: Date.now(),
    payload,
    ...overrides,
  };
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

test("createBoardEvent creates a valid stroke:start event", () => {
  const event = createBoardEvent("stroke:start", {
    strokeId: "stroke_1",
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 3,
    point: { x: 0.25, y: 0.5, pressure: 0.75 },
  });

  assert.equal(event.id, "evt_000001");
  assert.equal(event.type, "stroke:start");
  assert.equal(event.boardId, "default");
  assert.equal(typeof event.at, "number");
  assert.equal(hasOwn(event, "timestamp"), false);
  assert.deepEqual(validateBoardEvent(event), { valid: true });
});

test("normalizePoint clamps x, y, and pressure into 0..1", () => {
  assert.deepEqual(normalizePoint({ x: -1, y: 2, pressure: Number.NaN }), {
    x: 0,
    y: 1,
    pressure: 0,
  });
});

test("validateBoardEvent rejects an unknown event type", () => {
  const result = validateBoardEvent({
    id: "evt_999999",
    boardId: "default",
    at: Date.now(),
    type: "unknown:event",
    payload: {},
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /unknown event type/i);
});

test("validateBoardEvent accepts board:set-surface and stroke:expire", () => {
  assert.deepEqual(
    validateBoardEvent(
      createBoardEvent("board:set-surface", { surface: "greenboard" }),
    ),
    { valid: true },
  );

  assert.deepEqual(
    validateBoardEvent(createBoardEvent("stroke:expire", { strokeId: "s1" })),
    { valid: true },
  );
});

test("validateBoardEvent accepts board:set-background with image or null", () => {
  assert.deepEqual(
    validateBoardEvent(
      createBoardEvent("board:set-background", {
        background: {
          kind: "image",
          dataUrl: "data:image/jpeg;base64,abc123",
          width: 1280,
          height: 720,
        },
      }),
    ),
    { valid: true },
  );

  assert.deepEqual(
    validateBoardEvent(
      createBoardEvent("board:set-background", { background: null }),
    ),
    { valid: true },
  );
});

test("validateBoardEvent accepts board:undo with a stroke ID", () => {
  assert.deepEqual(
    validateBoardEvent(createBoardEvent("board:undo", { strokeId: "s1" })),
    { valid: true },
  );
});

test("validateBoardEvent accepts board:restore with a board snapshot payload", () => {
  const event = createBoardEvent("board:restore", {
    surface: "blackboard",
    background: {
      kind: "image",
      dataUrl: "data:image/png;base64,restored",
      width: 640,
      height: 360,
    },
    strokes: [
      {
        strokeId: "s1",
        surface: "blackboard",
        tool: "chalk",
        color: "#ffffff",
        width: 4,
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4, pressure: 0.5 },
        ],
        complete: true,
      },
    ],
    pointer: { visible: true, point: { x: 0.5, y: 0.6 } },
  });

  assert.deepEqual(validateBoardEvent(event), { valid: true });
});

test("board:set-background rejects malformed image payloads", () => {
  for (const background of [
    undefined,
    {},
    { kind: "video", dataUrl: "data:image/jpeg;base64,abc", width: 10, height: 10 },
    { kind: "image", dataUrl: "https://example.test/image.jpg", width: 10, height: 10 },
    { kind: "image", dataUrl: "data:text/plain;base64,abc", width: 10, height: 10 },
    { kind: "image", dataUrl: "data:image/jpeg;base64,abc", width: 0, height: 10 },
    { kind: "image", dataUrl: "data:image/jpeg;base64,abc", width: 10, height: Number.NaN },
  ]) {
    const result = validateBoardEvent(
      makeEvent("board:set-background", { background }),
    );

    assert.equal(result.valid, false);
    assert.match(result.reason, /background|image|dataUrl|width|height/i);
  }
});

test("validateBoardEvent accepts an ephemeral stroke:start with expiresAt", () => {
  const event = createBoardEvent("stroke:start", {
    strokeId: "stroke_2",
    surface: "blackboard",
    tool: "chalk",
    color: "#ffffff",
    width: 4,
    point: { x: 0.1, y: 0.2, pressure: 0.3 },
    ephemeral: true,
    expiresAt: Date.now() + 1000,
  });

  assert.deepEqual(validateBoardEvent(event), { valid: true });
});

test("validateBoardEvent rejects ephemeral stroke:start without numeric expiresAt", () => {
  const missingExpiresAt = validateBoardEvent(
    createBoardEvent("stroke:start", {
      strokeId: "stroke_3",
      surface: "blackboard",
      tool: "chalk",
      color: "#ffffff",
      width: 4,
      point: { x: 0.1, y: 0.2, pressure: 0.3 },
      ephemeral: true,
    }),
  );

  assert.equal(missingExpiresAt.valid, false);
  assert.match(missingExpiresAt.reason, /expiresAt/i);

  const nonNumericExpiresAt = validateBoardEvent(
    createBoardEvent("stroke:start", {
      strokeId: "stroke_4",
      surface: "whiteboard",
      tool: "marker",
      color: "#111111",
      width: 3,
      point: { x: 0.1, y: 0.2, pressure: 0.3 },
      ephemeral: true,
      expiresAt: "soon",
    }),
  );

  assert.equal(nonNumericExpiresAt.valid, false);
  assert.match(nonNumericExpiresAt.reason, /expiresAt/i);
});

test("stroke:start rejects missing, non-finite, and non-object points", () => {
  const basePayload = {
    strokeId: "stroke_point_start",
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 3,
  };

  for (const point of [
    undefined,
    null,
    [],
    "0,0",
    { y: 0.2 },
    { x: 0.1 },
    { x: Number.NaN, y: 0.2 },
    { x: 0.1, y: Number.POSITIVE_INFINITY },
    { x: 0.1, y: 0.2, pressure: Number.NEGATIVE_INFINITY },
  ]) {
    const result = validateBoardEvent(
      makeEvent("stroke:start", { ...basePayload, point }),
    );

    assert.equal(result.valid, false);
    assert.match(result.reason, /point|x|y|pressure/i);
  }
});

test("stroke:point rejects missing, non-finite, and non-object points", () => {
  for (const point of [
    undefined,
    null,
    [],
    "0,0",
    { y: 0.2 },
    { x: 0.1 },
    { x: Number.NaN, y: 0.2 },
    { x: 0.1, y: Number.POSITIVE_INFINITY },
    { x: 0.1, y: 0.2, pressure: Number.NEGATIVE_INFINITY },
  ]) {
    const result = validateBoardEvent(
      makeEvent("stroke:point", { strokeId: "stroke_point", point }),
    );

    assert.equal(result.valid, false);
    assert.match(result.reason, /point|x|y|pressure/i);
  }
});

test("validateBoardEvent rejects point coordinates and pressure outside 0..1", () => {
  for (const point of [
    { x: -0.01, y: 0.2 },
    { x: 1.01, y: 0.2 },
    { x: 0.1, y: -0.01 },
    { x: 0.1, y: 1.01 },
    { x: 0.1, y: 0.2, pressure: -0.01 },
    { x: 0.1, y: 0.2, pressure: 1.01 },
  ]) {
    const strokePoint = validateBoardEvent(
      makeEvent("stroke:point", { strokeId: "stroke_point_bounds", point }),
    );
    assert.equal(strokePoint.valid, false);
    assert.match(strokePoint.reason, /x|y|pressure/i);

    const pointerMove = validateBoardEvent(makeEvent("pointer:move", { point }));
    assert.equal(pointerMove.valid, false);
    assert.match(pointerMove.reason, /x|y|pressure/i);
  }

  assert.deepEqual(
    validateBoardEvent(
      makeEvent("stroke:point", {
        strokeId: "stroke_point_bounds",
        point: { x: 0, y: 1, pressure: 1 },
      }),
    ),
    { valid: true },
  );
});

test("stroke:start rejects missing or empty color", () => {
  for (const color of [undefined, "", "   ", null, 123]) {
    const result = validateBoardEvent(
      makeEvent("stroke:start", {
        strokeId: "stroke_color",
        surface: "whiteboard",
        tool: "marker",
        color,
        width: 3,
        point: { x: 0.1, y: 0.2 },
      }),
    );

    assert.equal(result.valid, false);
    assert.match(result.reason, /color/i);
  }
});

test("stroke:start rejects missing or non-finite width", () => {
  for (const width of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "3",
    null,
    0,
    -1,
    129,
  ]) {
    const result = validateBoardEvent(
      makeEvent("stroke:start", {
        strokeId: "stroke_width",
        surface: "whiteboard",
        tool: "marker",
        color: "#111111",
        width,
        point: { x: 0.1, y: 0.2 },
      }),
    );

    assert.equal(result.valid, false);
    assert.match(result.reason, /width/i);
  }
});

test("stroke:start accepts width boundaries greater than 0 through 128", () => {
  for (const width of [0.1, 128]) {
    assert.deepEqual(
      validateBoardEvent(
        makeEvent("stroke:start", {
          strokeId: `stroke_width_${width}`,
          surface: "whiteboard",
          tool: "marker",
          color: "#111111",
          width,
          point: { x: 0.1, y: 0.2 },
        }),
      ),
      { valid: true },
    );
  }
});

test("stroke:start rejects invalid ephemeral shape", () => {
  for (const ephemeral of ["true", 1]) {
    const result = validateBoardEvent(
      makeEvent("stroke:start", {
        strokeId: "stroke_bad_ephemeral",
        surface: "whiteboard",
        tool: "marker",
        color: "#111111",
        width: 3,
        point: { x: 0.1, y: 0.2 },
        ephemeral,
      }),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /ephemeral/i);
  }

  for (const payload of [
    {
      strokeId: "stroke_expiry_without_ephemeral",
      surface: "whiteboard",
      tool: "marker",
      color: "#111111",
      width: 3,
      point: { x: 0.1, y: 0.2 },
      expiresAt: Date.now() + 1000,
    },
    {
      strokeId: "stroke_expiry_false_ephemeral",
      surface: "whiteboard",
      tool: "marker",
      color: "#111111",
      width: 3,
      point: { x: 0.1, y: 0.2 },
      ephemeral: false,
      expiresAt: Date.now() + 1000,
    },
  ]) {
    const result = validateBoardEvent(makeEvent("stroke:start", payload));
    assert.equal(result.valid, false);
    assert.match(result.reason, /expiresAt|ephemeral/i);
  }
});

test("point payload rejects Date and class instances even with x and y", () => {
  class PointLike {
    constructor() {
      this.x = 0.1;
      this.y = 0.2;
    }
  }

  const datePoint = new Date();
  datePoint.x = 0.1;
  datePoint.y = 0.2;

  for (const point of [new PointLike(), datePoint]) {
    const strokePoint = validateBoardEvent(
      makeEvent("stroke:point", { strokeId: "stroke_point", point }),
    );
    assert.equal(strokePoint.valid, false);
    assert.match(strokePoint.reason, /point/i);

    const pointerMove = validateBoardEvent(makeEvent("pointer:move", { point }));
    assert.equal(pointerMove.valid, false);
    assert.match(pointerMove.reason, /point/i);
  }
});

test("pointer:show and pointer:move require valid points", () => {
  for (const type of ["pointer:show", "pointer:move"]) {
    assert.deepEqual(
      validateBoardEvent(makeEvent(type, { point: { x: 0.1, y: 0.2 } })),
      { valid: true },
    );

    const missingPoint = validateBoardEvent(makeEvent(type, {}));
    assert.equal(missingPoint.valid, false);
    assert.match(missingPoint.reason, /point/i);

    const invalidPoint = validateBoardEvent(
      makeEvent(type, { point: { x: 0.1, y: Number.NaN } }),
    );
    assert.equal(invalidPoint.valid, false);
    assert.match(invalidPoint.reason, /y/i);
  }
});

test("pointer:hide and board:clear reject non-empty payloads", () => {
  for (const type of ["pointer:hide", "board:clear"]) {
    assert.deepEqual(validateBoardEvent(makeEvent(type, {})), {
      valid: true,
    });

    const result = validateBoardEvent(makeEvent(type, { extra: true }));
    assert.equal(result.valid, false);
    assert.match(result.reason, /empty payload/i);
  }
});

test("board:restore rejects malformed snapshot payloads", () => {
  const validStroke = {
    strokeId: "s1",
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 3,
    points: [{ x: 0.1, y: 0.2 }],
    complete: true,
  };

  for (const payload of [
    {},
    { surface: "glassboard", strokes: [], pointer: { visible: false, point: null } },
    { surface: "whiteboard", background: { kind: "image" }, strokes: [], pointer: { visible: false, point: null } },
    { surface: "whiteboard", strokes: {}, pointer: { visible: false, point: null } },
    { surface: "whiteboard", strokes: [validStroke], pointer: null },
    { surface: "whiteboard", strokes: [validStroke], pointer: { visible: "no", point: null } },
    { surface: "whiteboard", strokes: [validStroke], pointer: { visible: true, point: null } },
    { surface: "whiteboard", strokes: [{ ...validStroke, complete: "yes" }], pointer: { visible: false, point: null } },
    { surface: "whiteboard", strokes: [{ ...validStroke, points: [] }], pointer: { visible: false, point: null } },
    { surface: "whiteboard", strokes: [{ ...validStroke, tool: "chalk" }], pointer: { visible: false, point: null } },
  ]) {
    const result = validateBoardEvent(makeEvent("board:restore", payload));
    assert.equal(result.valid, false);
    assert.match(result.reason, /surface|background|strokes|stroke|pointer|point|tool|complete/i);
  }
});

test("validateBoardEvent rejects invalid at, expiresAt, id, boardId, and strokeId values", () => {
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY, "123", null]) {
    const result = validateBoardEvent(makeEvent("board:clear", {}, { at }));
    assert.equal(result.valid, false);
    assert.match(result.reason, /at/i);
  }

  for (const id of ["", "   ", null, 123]) {
    const result = validateBoardEvent(makeEvent("board:clear", {}, { id }));
    assert.equal(result.valid, false);
    assert.match(result.reason, /id/i);
  }

  for (const boardId of ["", "   ", null, 123]) {
    const result = validateBoardEvent(makeEvent("board:clear", {}, { boardId }));
    assert.equal(result.valid, false);
    assert.match(result.reason, /boardId/i);
  }

  for (const strokeId of ["", "   ", null, 123]) {
    const result = validateBoardEvent(
      makeEvent("stroke:expire", { strokeId }),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /strokeId/i);
  }

  for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateBoardEvent(
      makeEvent("stroke:start", {
        strokeId: "stroke_bad_expiry",
        surface: "greenboard",
        tool: "chalk",
        color: "#ffffff",
        width: 4,
        point: { x: 0.1, y: 0.2 },
        ephemeral: true,
        expiresAt,
      }),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /expiresAt/i);
  }
});

test("validateBoardEvent rejects invalid tool and surface combinations", () => {
  for (const payload of [
    {
      strokeId: "stroke_bad_tool_1",
      surface: "whiteboard",
      tool: "chalk",
      color: "#111111",
      width: 3,
      point: { x: 0.1, y: 0.2 },
    },
    {
      strokeId: "stroke_bad_tool_2",
      surface: "greenboard",
      tool: "marker",
      color: "#111111",
      width: 3,
      point: { x: 0.1, y: 0.2 },
    },
    {
      strokeId: "stroke_bad_surface",
      surface: "glassboard",
      tool: "marker",
      color: "#111111",
      width: 3,
      point: { x: 0.1, y: 0.2 },
    },
  ]) {
    const result = validateBoardEvent(makeEvent("stroke:start", payload));
    assert.equal(result.valid, false);
    assert.match(result.reason, /surface|tool/i);
  }
});

test("isToolAllowedForSurface enforces marker/chalk/eraser rules", () => {
  assert.equal(isToolAllowedForSurface("marker", "whiteboard"), true);
  assert.equal(isToolAllowedForSurface("marker", "blueboard"), true);
  assert.equal(isToolAllowedForSurface("marker", "blackboard"), false);
  assert.equal(isToolAllowedForSurface("marker", "greenboard"), false);

  assert.equal(isToolAllowedForSurface("chalk", "blackboard"), true);
  assert.equal(isToolAllowedForSurface("chalk", "greenboard"), true);
  assert.equal(isToolAllowedForSurface("chalk", "whiteboard"), false);
  assert.equal(isToolAllowedForSurface("chalk", "blueboard"), false);

  assert.equal(isToolAllowedForSurface("eraser", "whiteboard"), true);
  assert.equal(isToolAllowedForSurface("eraser", "blueboard"), true);
  assert.equal(isToolAllowedForSurface("eraser", "blackboard"), true);
  assert.equal(isToolAllowedForSurface("eraser", "greenboard"), true);
});
