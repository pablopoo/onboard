import assert from "node:assert/strict";
import test from "node:test";

import {
  renderBoardState,
  resizeCanvasToDisplaySize,
} from "./canvas-renderer.js";

const SIZE = { width: 200, height: 100 };

function makeContext() {
  const calls = [];
  const stateStack = [];
  const ctx = {
    canvas: { width: SIZE.width, height: SIZE.height },
    fillStyle: undefined,
    strokeStyle: undefined,
    lineWidth: undefined,
    lineCap: undefined,
    lineJoin: undefined,
    globalAlpha: 1,
    calls,
    clearRect(...args) {
      calls.push({ name: "clearRect", args });
    },
    fillRect(...args) {
      calls.push({ name: "fillRect", args, fillStyle: this.fillStyle });
    },
    beginPath() {
      calls.push({ name: "beginPath" });
    },
    moveTo(...args) {
      calls.push({ name: "moveTo", args });
    },
    lineTo(...args) {
      calls.push({ name: "lineTo", args });
    },
    stroke() {
      calls.push({
        name: "stroke",
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        globalAlpha: this.globalAlpha,
      });
    },
    arc(...args) {
      calls.push({ name: "arc", args });
    },
    fill() {
      calls.push({
        name: "fill",
        fillStyle: this.fillStyle,
        globalAlpha: this.globalAlpha,
      });
    },
    save() {
      stateStack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        globalAlpha: this.globalAlpha,
      });
      calls.push({ name: "save" });
    },
    restore() {
      Object.assign(this, stateStack.pop());
      calls.push({ name: "restore" });
    },
  };

  return ctx;
}

function makeState(overrides = {}) {
  return {
    surface: "whiteboard",
    strokes: [],
    pointer: { visible: false, point: null },
    ...overrides,
  };
}

function makeStroke(overrides = {}) {
  return {
    strokeId: "stroke_1",
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 4,
    points: [
      { x: 0.25, y: 0.5, pressure: 0 },
      { x: 0.75, y: 0.25, pressure: 0 },
    ],
    complete: true,
    ...overrides,
  };
}

function findCalls(ctx, name) {
  return ctx.calls.filter((call) => call.name === name);
}

test("renderBoardState clears the canvas", () => {
  const ctx = makeContext();

  renderBoardState(ctx, makeState(), SIZE);

  assert.deepEqual(findCalls(ctx, "clearRect")[0].args, [0, 0, 200, 100]);
});

test("renderBoardState paints surface background for supported surfaces", () => {
  const backgrounds = new Map();

  for (const surface of [
    "whiteboard",
    "blackboard",
    "greenboard",
    "blueboard",
  ]) {
    const ctx = makeContext();

    renderBoardState(ctx, makeState({ surface }), SIZE);

    const fillRect = findCalls(ctx, "fillRect")[0];
    assert.deepEqual(fillRect.args, [0, 0, 200, 100]);
    assert.equal(typeof fillRect.fillStyle, "string");
    backgrounds.set(surface, fillRect.fillStyle);
  }

  assert.equal(new Set(backgrounds.values()).size, 4);
});

test("renderBoardState draws a completed marker stroke using normalized points", () => {
  const ctx = makeContext();

  renderBoardState(ctx, makeState({ strokes: [makeStroke()] }), SIZE);

  assert.deepEqual(findCalls(ctx, "moveTo")[0].args, [50, 50]);
  assert.deepEqual(findCalls(ctx, "lineTo")[0].args, [150, 25]);

  const stroke = findCalls(ctx, "stroke")[0];
  assert.equal(stroke.strokeStyle, "#111111");
  assert.equal(stroke.lineWidth, 4);
  assert.equal(stroke.lineCap, "round");
  assert.equal(stroke.lineJoin, "round");
  assert.equal(stroke.globalAlpha, 1);
});

test("renderBoardState draws a chalk stroke with distinguishable alpha and width from marker", () => {
  const markerCtx = makeContext();
  const chalkCtx = makeContext();

  renderBoardState(markerCtx, makeState({ strokes: [makeStroke()] }), SIZE);
  renderBoardState(
    chalkCtx,
    makeState({
      surface: "blackboard",
      strokes: [
        makeStroke({
          strokeId: "chalk_1",
          surface: "blackboard",
          tool: "chalk",
          color: "#eeeeee",
        }),
      ],
    }),
    SIZE,
  );

  const markerStroke = findCalls(markerCtx, "stroke")[0];
  const chalkStroke = findCalls(chalkCtx, "stroke")[0];

  assert.ok(chalkStroke.globalAlpha < markerStroke.globalAlpha);
  assert.ok(chalkStroke.lineWidth > markerStroke.lineWidth);
});

test("renderBoardState uses background-colored stroke for eraser", () => {
  const ctx = makeContext();

  renderBoardState(
    ctx,
    makeState({
      surface: "greenboard",
      strokes: [
        makeStroke({
          strokeId: "eraser_1",
          surface: "greenboard",
          tool: "eraser",
          color: "#ff00ff",
        }),
      ],
    }),
    SIZE,
  );

  const background = findCalls(ctx, "fillRect")[0].fillStyle;
  const eraserStroke = findCalls(ctx, "stroke")[0];

  assert.equal(eraserStroke.strokeStyle, background);
});

test("renderBoardState uses current surface background for eraser after surface changes", () => {
  const ctx = makeContext();

  renderBoardState(
    ctx,
    makeState({
      surface: "greenboard",
      strokes: [
        makeStroke({
          strokeId: "eraser_1",
          surface: "whiteboard",
          tool: "eraser",
          color: "#ff00ff",
        }),
      ],
    }),
    SIZE,
  );

  const background = findCalls(ctx, "fillRect")[0].fillStyle;
  const eraserStroke = findCalls(ctx, "stroke")[0];

  assert.equal(eraserStroke.strokeStyle, background);
});

test("renderBoardState draws a one-point stroke as an explicit dot", () => {
  const ctx = makeContext();

  renderBoardState(
    ctx,
    makeState({
      strokes: [
        makeStroke({
          points: [{ x: 0.25, y: 0.5, pressure: 0 }],
        }),
      ],
    }),
    SIZE,
  );

  assert.deepEqual(findCalls(ctx, "arc")[0].args.slice(0, 2), [50, 50]);
  assert.equal(findCalls(ctx, "fill").length, 1);
  assert.equal(findCalls(ctx, "lineTo").length, 0);
});

test("renderBoardState restores caller fillStyle and globalAlpha", () => {
  const ctx = makeContext();
  ctx.fillStyle = "#abc123";
  ctx.globalAlpha = 0.42;

  renderBoardState(ctx, makeState({ surface: "blueboard" }), SIZE);

  assert.equal(ctx.fillStyle, "#abc123");
  assert.equal(ctx.globalAlpha, 0.42);
  assert.equal(findCalls(ctx, "save").length, findCalls(ctx, "restore").length);
});

test("renderBoardState skips expired ephemeral strokes when options.now is past expiresAt", () => {
  const ctx = makeContext();

  renderBoardState(
    ctx,
    makeState({
      strokes: [
        makeStroke({
          strokeId: "expired_1",
          ephemeral: true,
          expiresAt: 1000,
        }),
        makeStroke({
          strokeId: "current_1",
          color: "#123456",
          ephemeral: true,
          expiresAt: 3000,
        }),
      ],
    }),
    SIZE,
    { now: 2000 },
  );

  const strokes = findCalls(ctx, "stroke");
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0].strokeStyle, "#123456");
});

test("renderBoardState draws pointer only when pointer.visible true", () => {
  const hiddenCtx = makeContext();
  const visibleCtx = makeContext();

  renderBoardState(
    hiddenCtx,
    makeState({ pointer: { visible: false, point: { x: 0.5, y: 0.5 } } }),
    SIZE,
  );
  renderBoardState(
    visibleCtx,
    makeState({ pointer: { visible: true, point: { x: 0.5, y: 0.25 } } }),
    SIZE,
  );

  assert.equal(findCalls(hiddenCtx, "arc").length, 0);
  assert.deepEqual(findCalls(visibleCtx, "arc")[0].args.slice(0, 2), [100, 25]);
  assert.equal(findCalls(visibleCtx, "fill").length, 1);
});

test("resizeCanvasToDisplaySize uses ratio and returns whether size changed", () => {
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect() {
      return { width: 100.4, height: 50.5 };
    },
  };

  assert.equal(resizeCanvasToDisplaySize(canvas, 2), true);
  assert.equal(canvas.width, 201);
  assert.equal(canvas.height, 101);
  assert.equal(resizeCanvasToDisplaySize(canvas, 2), false);
});

test("resizeCanvasToDisplaySize uses window.devicePixelRatio by default when available", () => {
  const originalWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 3 };

  try {
    const canvas = {
      width: 0,
      height: 0,
      getBoundingClientRect() {
        return { width: 10, height: 20 };
      },
    };

    assert.equal(resizeCanvasToDisplaySize(canvas), true);
    assert.equal(canvas.width, 30);
    assert.equal(canvas.height, 60);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});
