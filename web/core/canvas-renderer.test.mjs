import assert from "node:assert/strict";
import test from "node:test";

import {
  boardViewportForSize,
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
    lineDash: [],
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
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
    quadraticCurveTo(...args) {
      calls.push({ name: "quadraticCurveTo", args });
    },
    stroke() {
      calls.push({
        name: "stroke",
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        lineDash: this.lineDash,
        globalAlpha: this.globalAlpha,
        globalCompositeOperation: this.globalCompositeOperation,
      });
    },
    setLineDash(value) {
      this.lineDash = [...value];
      calls.push({ name: "setLineDash", args: [value] });
    },
    arc(...args) {
      calls.push({ name: "arc", args });
    },
    fill() {
      calls.push({
        name: "fill",
        fillStyle: this.fillStyle,
        globalAlpha: this.globalAlpha,
        globalCompositeOperation: this.globalCompositeOperation,
      });
    },
    drawImage(...args) {
      calls.push({ name: "drawImage", args });
    },
    save() {
      stateStack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        lineDash: this.lineDash,
        globalAlpha: this.globalAlpha,
        globalCompositeOperation: this.globalCompositeOperation,
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

function makeCacheableContext() {
  const ctx = makeContext();
  const layerContexts = [];

  ctx.drawImage = (...args) => {
    ctx.calls.push({ name: "drawImage", args });
  };
  ctx.canvas.ownerDocument = {
    createElement(name) {
      assert.equal(name, "canvas");
      const layerCanvas = {
        width: 0,
        height: 0,
        getContext(type) {
          assert.equal(type, "2d");
          const layerContext = makeContext();
          layerContext.canvas = layerCanvas;
          layerContexts.push(layerContext);
          return layerContext;
        },
      };
      return layerCanvas;
    },
  };
  ctx.layerContexts = layerContexts;

  return ctx;
}

function clearCalls(ctx) {
  ctx.calls.length = 0;
  for (const layerContext of ctx.layerContexts ?? []) {
    layerContext.calls.length = 0;
  }
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

function assertNearlyEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function assertViewport(actual, expected) {
  assertNearlyEqual(actual.x, expected.x);
  assertNearlyEqual(actual.y, expected.y);
  assertNearlyEqual(actual.width, expected.width);
  assertNearlyEqual(actual.height, expected.height);
}

function assertPoint(actual, expected) {
  assertNearlyEqual(actual[0], expected[0]);
  assertNearlyEqual(actual[1], expected[1]);
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
    assertViewport(
      {
        x: fillRect.args[0],
        y: fillRect.args[1],
        width: fillRect.args[2],
        height: fillRect.args[3],
      },
      { x: 100 / 9, y: 0, width: 1600 / 9, height: 100 },
    );
    assert.equal(typeof fillRect.fillStyle, "string");
    backgrounds.set(surface, fillRect.fillStyle);
  }

  assert.equal(new Set(backgrounds.values()).size, 4);
});

test("renderBoardState draws image background inside the board viewport before strokes", () => {
  const ctx = makeContext();
  const image = {
    complete: true,
    naturalWidth: 1280,
    naturalHeight: 720,
  };

  renderBoardState(
    ctx,
    makeState({
      background: {
        kind: "image",
        dataUrl: "data:image/jpeg;base64,abc123",
        width: 1280,
        height: 720,
      },
      strokes: [makeStroke()],
    }),
    SIZE,
    {
      createImage() {
        return image;
      },
    },
  );

  const drawImage = findCalls(ctx, "drawImage")[0];
  assert.equal(drawImage.args[0], image);
  assertViewport(
    {
      x: drawImage.args[1],
      y: drawImage.args[2],
      width: drawImage.args[3],
      height: drawImage.args[4],
    },
    { x: 100 / 9, y: 0, width: 1600 / 9, height: 100 },
  );

  const drawImageIndex = ctx.calls.findIndex((call) => call.name === "drawImage");
  const strokeIndex = ctx.calls.findIndex((call) => call.name === "stroke");
  assert.ok(drawImageIndex > -1);
  assert.ok(strokeIndex > drawImageIndex);
});

test("boardViewportForSize centers a 16:9 frame in wide canvases", () => {
  assertViewport(boardViewportForSize({ width: 200, height: 100 }), {
    x: 100 / 9,
    y: 0,
    width: 1600 / 9,
    height: 100,
  });
});

test("boardViewportForSize centers a 16:9 frame in tall canvases", () => {
  assertViewport(boardViewportForSize({ width: 100, height: 100 }), {
    x: 0,
    y: 175 / 8,
    width: 100,
    height: 225 / 4,
  });
});

test("boardViewportForSize accepts a custom aspect ratio", () => {
  assertViewport(boardViewportForSize({ width: 100, height: 100 }, 1), {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
});

test("renderBoardState draws a completed marker stroke using normalized points inside the board viewport", () => {
  const ctx = makeContext();

  renderBoardState(ctx, makeState({ strokes: [makeStroke()] }), SIZE);

  assertPoint(findCalls(ctx, "moveTo")[0].args, [500 / 9, 50]);
  assertPoint(findCalls(ctx, "lineTo")[0].args, [1300 / 9, 25]);

  const stroke = findCalls(ctx, "stroke")[0];
  assert.equal(stroke.strokeStyle, "#111111");
  assert.equal(stroke.lineWidth, 4);
  assert.equal(stroke.lineCap, "round");
  assert.equal(stroke.lineJoin, "round");
  assert.equal(stroke.globalAlpha, 1);
});

test("renderBoardState caches completed non-ephemeral strokes between renders", () => {
  const ctx = makeCacheableContext();
  const completedStroke = makeStroke({ strokeId: "completed_1" });
  const activeStroke = makeStroke({
    strokeId: "active_1",
    complete: false,
    points: [
      { x: 0.1, y: 0.2, pressure: 0 },
      { x: 0.2, y: 0.3, pressure: 0 },
    ],
  });

  renderBoardState(ctx, makeState({ strokes: [completedStroke] }), SIZE);

  assert.equal(ctx.layerContexts.length, 1);
  assert.equal(findCalls(ctx.layerContexts[0], "stroke").length, 1);

  clearCalls(ctx);

  renderBoardState(
    ctx,
    makeState({ strokes: [completedStroke, activeStroke] }),
    SIZE,
  );

  assert.equal(findCalls(ctx.layerContexts[0], "stroke").length, 0);
  assert.equal(findCalls(ctx, "drawImage").length, 1);
  assert.equal(findCalls(ctx, "stroke").length, 1);
});

test("renderBoardState smooths multi-point strokes with quadratic curves", () => {
  const ctx = makeContext();

  renderBoardState(
    ctx,
    makeState({
      strokes: [
        makeStroke({
          points: [
            { x: 0.1, y: 0.2, pressure: 0 },
            { x: 0.4, y: 0.8, pressure: 0 },
            { x: 0.8, y: 0.3, pressure: 0 },
          ],
        }),
      ],
    }),
    SIZE,
  );

  assertPoint(findCalls(ctx, "moveTo")[0].args, [260 / 9, 20]);
  const curve = findCalls(ctx, "quadraticCurveTo")[0].args;
  assertPoint(curve.slice(0, 2), [740 / 9, 80]);
  assertPoint(curve.slice(2), [1060 / 9, 55]);
  assertPoint(findCalls(ctx, "lineTo").at(-1).args, [1380 / 9, 30]);
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
  const chalkStrokes = findCalls(chalkCtx, "stroke");
  const chalkStroke = chalkStrokes[0];

  assert.ok(chalkStroke.globalAlpha < markerStroke.globalAlpha);
  assert.ok(chalkStrokes.some((call) => call.lineWidth > markerStroke.lineWidth));
});

test("renderBoardState renders chalk as particle stamps instead of dashed gaps", () => {
  const ctx = makeContext();

  renderBoardState(
    ctx,
    makeState({
      surface: "greenboard",
      strokes: [
        makeStroke({
          strokeId: "chalk_texture_1",
          surface: "greenboard",
          tool: "chalk",
          color: "#eeeeee",
          points: [
            { x: 0.1, y: 0.2, pressure: 0 },
            { x: 0.24, y: 0.42, pressure: 0.2 },
            { x: 0.42, y: 0.3, pressure: 0.4 },
            { x: 0.66, y: 0.62, pressure: 0.3 },
            { x: 0.86, y: 0.46, pressure: 0.1 },
          ],
        }),
      ],
    }),
    SIZE,
  );

  const chalkStrokes = findCalls(ctx, "stroke");
  const chalkFills = findCalls(ctx, "fill").filter(
    (call) => call.fillStyle === "#eeeeee",
  );
  const backgroundFills = findCalls(ctx, "fill").filter(
    (call) => call.fillStyle === "#254f3a",
  );

  assert.equal(findCalls(ctx, "setLineDash").length, 0);
  assert.equal(backgroundFills.length, 0);
  assert.ok(chalkFills.length >= 30);
  assert.ok(chalkFills.some((call) => call.globalAlpha < 0.18));
  assert.ok(chalkFills.some((call) => call.globalAlpha > 0.22));
  assert.ok(chalkFills.every((call) => call.globalAlpha <= 0.34));
  assert.ok(chalkStrokes.some((call) => call.globalAlpha >= 0.44));
  assert.ok(chalkStrokes.some((call) => call.globalAlpha < 0.2));
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

test("renderBoardState erases ink over image backgrounds without painting the surface color", () => {
  const ctx = makeCacheableContext();
  const image = {
    complete: true,
    naturalWidth: 1280,
    naturalHeight: 720,
  };

  renderBoardState(
    ctx,
    makeState({
      background: {
        kind: "image",
        dataUrl: "data:image/jpeg;base64,erase-test",
        width: 1280,
        height: 720,
      },
      strokes: [
        makeStroke({ strokeId: "marker_before_eraser" }),
        makeStroke({
          strokeId: "eraser_over_image",
          tool: "eraser",
          color: "#ff00ff",
        }),
      ],
    }),
    SIZE,
    {
      createImage() {
        return image;
      },
    },
  );

  assert.equal(findCalls(ctx, "stroke").length, 0);
  assert.equal(ctx.layerContexts.length, 1);

  const layerStrokes = findCalls(ctx.layerContexts[0], "stroke");
  assert.equal(layerStrokes.length, 2);
  assert.equal(layerStrokes[0].globalCompositeOperation, "source-over");
  assert.equal(layerStrokes[1].globalCompositeOperation, "destination-out");
  assert.equal(findCalls(ctx, "drawImage").length, 2);
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

  assertPoint(findCalls(ctx, "arc")[0].args.slice(0, 2), [500 / 9, 50]);
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

test("renderBoardState draws pointer only when pointer.visible true and maps it through the board viewport", () => {
  const hiddenCtx = makeContext();
  const visibleCtx = makeContext();
  const tallSize = { width: 100, height: 100 };

  renderBoardState(
    hiddenCtx,
    makeState({ pointer: { visible: false, point: { x: 0.5, y: 0.5 } } }),
    tallSize,
  );
  renderBoardState(
    visibleCtx,
    makeState({ pointer: { visible: true, point: { x: 0.5, y: 0.25 } } }),
    tallSize,
  );

  assert.equal(findCalls(hiddenCtx, "arc").length, 0);
  assertPoint(findCalls(visibleCtx, "arc")[0].args.slice(0, 2), [50, 575 / 16]);
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
