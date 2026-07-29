import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBoardEvent,
  createBoardState,
  snapshotBoardState,
} from "./board-state.js";
import { RELAY_LIMITS, utf8ByteLength } from "./protocol.js";

let nextEventNumber = 1;

function makeEvent(type, payload = {}, overrides = {}) {
  return {
    id: `evt_${String(nextEventNumber++).padStart(6, "0")}`,
    type,
    boardId: "default",
    at: Date.now(),
    payload,
    ...overrides,
  };
}

function makeStrokeStart(strokeId, payload = {}) {
  return makeEvent("stroke:start", {
    strokeId,
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 3,
    point: { x: 0.25, y: 0.5 },
    ...payload,
  });
}

test("default state uses whiteboard and empty strokes/map", () => {
  const state = createBoardState();

  assert.equal(state.surface, "whiteboard");
  assert.equal(state.background, null);
  assert.deepEqual(state.strokes, []);
  assert.ok(state.activeStrokes instanceof Map);
  assert.equal(state.activeStrokes.size, 0);
  assert.ok(state.appliedEventIds instanceof Set);
  assert.equal(state.appliedEventIds.size, 0);
  assert.deepEqual(state.appliedEventIdOrder, []);
  assert.deepEqual(state.pointer, { visible: false, point: null });
});

test("board:set-background updates the shared background image", () => {
  const state = createBoardState();
  const background = {
    kind: "image",
    dataUrl: "data:image/jpeg;base64,abc123",
    width: 1280,
    height: 720,
  };

  applyBoardEvent(state, makeEvent("board:set-background", { background }));
  background.width = 1;

  assert.deepEqual(state.background, {
    kind: "image",
    dataUrl: "data:image/jpeg;base64,abc123",
    width: 1280,
    height: 720,
  });

  applyBoardEvent(state, makeEvent("board:set-background", { background: null }));

  assert.equal(state.background, null);
});

test("board:set-surface changes board surface", () => {
  const state = createBoardState();

  applyBoardEvent(
    state,
    makeEvent("board:set-surface", { surface: "greenboard" }),
  );

  assert.equal(state.surface, "greenboard");
});

test("stroke:start creates a stroke with style, surface, first normalized point, and complete false", () => {
  const state = createBoardState();

  applyBoardEvent(
    state,
    makeStrokeStart("stroke_1", {
      surface: "blueboard",
      tool: "marker",
      color: "#0033ff",
      width: 7,
      point: { x: 0.2, y: 0.3 },
      ephemeral: true,
      expiresAt: 12345,
    }),
  );

  assert.deepEqual(state.strokes, [
    {
      strokeId: "stroke_1",
      surface: "blueboard",
      tool: "marker",
      color: "#0033ff",
      width: 7,
      points: [{ x: 0.2, y: 0.3, pressure: 0 }],
      complete: false,
      ephemeral: true,
      expiresAt: 12345,
    },
  ]);
  assert.equal(state.activeStrokes.get("stroke_1"), state.strokes[0]);
});

test("duplicate stroke IDs do not append or widen undo", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1", { color: "#111111" }));
  applyBoardEvent(state, makeEvent("stroke:end", { strokeId: "stroke_1" }));
  applyBoardEvent(state, makeStrokeStart("stroke_1", { color: "#222222" }));

  assert.equal(state.strokes.length, 1);
  assert.equal(state.strokes[0].color, "#111111");
  assert.equal(state.activeStrokes.has("stroke_1"), false);
});

test("stroke count budget rejects the 4,097th retained stroke", () => {
  const state = createBoardState();

  for (let index = 0; index < RELAY_LIMITS.maxStrokes; index += 1) {
    applyBoardEvent(state, makeStrokeStart(`stroke_budget_${index}`));
  }
  applyBoardEvent(state, makeStrokeStart("stroke_budget_overflow"));

  assert.equal(state.strokes.length, RELAY_LIMITS.maxStrokes);
  assert.equal(state.strokeIds.has("stroke_budget_overflow"), false);
});

test("per-stroke point budget rejects the 8,193rd point", () => {
  const state = createBoardState();
  applyBoardEvent(state, makeStrokeStart("stroke_point_budget"));

  for (let index = 1; index < RELAY_LIMITS.maxPointsPerStroke; index += 1) {
    applyBoardEvent(state, makeEvent("stroke:point", {
      strokeId: "stroke_point_budget",
      point: { x: 0.4, y: 0.6 },
    }));
  }
  applyBoardEvent(state, makeEvent("stroke:point", {
    strokeId: "stroke_point_budget",
    point: { x: 0.7, y: 0.8 },
  }));

  assert.equal(
    state.strokes[0].points.length,
    RELAY_LIMITS.maxPointsPerStroke,
  );
  assert.equal(state.totalPoints, RELAY_LIMITS.maxPointsPerStroke);
});

test("total point budget rejects the 65,537th retained point", () => {
  const state = createBoardState();
  const points = Array.from(
    { length: RELAY_LIMITS.maxPointsPerStroke - 1 },
    () => ({ x: 0.1, y: 0.2 }),
  );
  const strokes = Array.from({ length: 8 }, (_value, index) => ({
    strokeId: `restored_full_${index}`,
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 3,
    points,
    complete: true,
  }));
  strokes.push({
    ...strokes[0],
    strokeId: "restored_active",
    points: Array.from({ length: 7 }, () => ({ x: 0.2, y: 0.3 })),
    complete: false,
  });

  applyBoardEvent(state, makeEvent("board:restore", {
    surface: "whiteboard",
    strokes,
    pointer: { visible: false, point: null },
  }));
  applyBoardEvent(state, makeEvent("stroke:point", {
    strokeId: "restored_active",
    point: { x: 0.4, y: 0.5 },
  }));
  applyBoardEvent(state, makeEvent("stroke:point", {
    strokeId: "restored_active",
    point: { x: 0.6, y: 0.7 },
  }));

  assert.equal(state.totalPoints, RELAY_LIMITS.maxTotalPoints);
  assert.equal(state.strokes.at(-1).points.length, 8);
});

test("retained byte budget accepts the boundary and rejects the next byte growth", () => {
  const state = createBoardState();
  applyBoardEvent(state, makeStrokeStart("stroke_byte_budget"));
  const point = { x: 0.4, y: 0.6, pressure: 0 };
  const pointDelta = 1 + utf8ByteLength(JSON.stringify(point));
  state.retainedBytes = RELAY_LIMITS.maxStateBytes - pointDelta;

  applyBoardEvent(state, makeEvent("stroke:point", {
    strokeId: "stroke_byte_budget",
    point,
  }));
  applyBoardEvent(state, makeEvent("stroke:point", {
    strokeId: "stroke_byte_budget",
    point: { x: 0.7, y: 0.8, pressure: 0 },
  }));

  assert.equal(state.retainedBytes, RELAY_LIMITS.maxStateBytes);
  assert.equal(state.strokes[0].points.length, 2);
});

test("restore rejects duplicate IDs and rebuilds retained accounting", () => {
  const state = createBoardState();
  const restoredStroke = {
    strokeId: "restored_accounting",
    surface: "whiteboard",
    tool: "marker",
    color: "#111111",
    width: 3,
    points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }],
    complete: false,
  };
  const duplicateRestore = makeEvent("board:restore", {
    surface: "whiteboard",
    strokes: [restoredStroke, structuredClone(restoredStroke)],
    pointer: { visible: false, point: null },
  });
  const before = snapshotBoardState(state);

  applyBoardEvent(state, duplicateRestore);
  assert.deepEqual(snapshotBoardState(state), before);

  applyBoardEvent(state, makeEvent("board:restore", {
    surface: "whiteboard",
    strokes: [restoredStroke],
    pointer: { visible: false, point: null },
  }));

  assert.equal(state.strokeIds.size, 1);
  assert.equal(state.strokeBytes.size, 1);
  assert.equal(state.totalPoints, 2);
  assert.equal(
    state.retainedBytes,
    utf8ByteLength(JSON.stringify(snapshotBoardState(state))),
  );
});

test("applied event ID tracking is bounded for long sessions", () => {
  const state = createBoardState();
  const recentEventIdLimit = 8192;

  for (let index = 0; index < recentEventIdLimit + 100; index += 1) {
    applyBoardEvent(
      state,
      makeEvent(
        "board:set-surface",
        { surface: "whiteboard" },
        { id: `evt_bound_${index}` },
      ),
    );
  }

  assert.equal(state.appliedEventIds.size, recentEventIdLimit);
  assert.equal(state.appliedEventIdOrder.length, recentEventIdLimit);
  assert.equal(state.appliedEventIds.has("evt_bound_0"), false);
  assert.equal(
    state.appliedEventIds.has(`evt_bound_${recentEventIdLimit + 99}`),
    true,
  );
});

test("stroke:point appends normalized point and unknown stroke ID is ignored", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(
    state,
    makeEvent("stroke:point", {
      strokeId: "stroke_1",
      point: { x: 0.4, y: 0.6, pressure: 0.8 },
    }),
  );
  applyBoardEvent(
    state,
    makeEvent("stroke:point", {
      strokeId: "unknown",
      point: { x: 0.9, y: 0.9 },
    }),
  );

  assert.deepEqual(state.strokes[0].points, [
    { x: 0.25, y: 0.5, pressure: 0 },
    { x: 0.4, y: 0.6, pressure: 0.8 },
  ]);
});

test("unapplied stroke:point does not burn its event ID", () => {
  const state = createBoardState();
  const point = makeEvent(
    "stroke:point",
    {
      strokeId: "stroke_1",
      point: { x: 0.4, y: 0.6 },
    },
    { id: "evt_late_point" },
  );

  applyBoardEvent(state, point);
  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, structuredClone(point));

  assert.deepEqual(state.strokes[0].points, [
    { x: 0.25, y: 0.5, pressure: 0 },
    { x: 0.4, y: 0.6, pressure: 0 },
  ]);
});

test("no-op expire and undo events do not burn their event IDs", () => {
  const state = createBoardState();
  const expire = makeEvent(
    "stroke:expire",
    { strokeId: "late_ephemeral" },
    { id: "evt_late_expire" },
  );
  const undo = makeEvent(
    "board:undo",
    { strokeId: "late_undo" },
    { id: "evt_late_undo" },
  );

  applyBoardEvent(state, expire);
  applyBoardEvent(state, undo);

  applyBoardEvent(
    state,
    makeStrokeStart("late_ephemeral", {
      ephemeral: true,
      expiresAt: Date.now() + 1000,
    }),
  );
  applyBoardEvent(state, makeStrokeStart("late_undo"));

  applyBoardEvent(state, structuredClone(expire));
  applyBoardEvent(state, structuredClone(undo));

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    [],
  );
});

test("stroke:end marks complete and removes active stroke; unknown stroke ID is ignored", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, makeEvent("stroke:end", { strokeId: "stroke_1" }));
  applyBoardEvent(state, makeEvent("stroke:end", { strokeId: "unknown" }));

  assert.equal(state.strokes[0].complete, true);
  assert.equal(state.activeStrokes.has("stroke_1"), false);
  assert.equal(state.strokes.length, 1);
});

test("stroke:expire removes an ephemeral stroke by stroke ID", () => {
  const state = createBoardState();

  applyBoardEvent(
    state,
    makeStrokeStart("stroke_1", { ephemeral: true, expiresAt: 12345 }),
  );
  applyBoardEvent(state, makeStrokeStart("stroke_2"));
  applyBoardEvent(state, makeEvent("stroke:expire", { strokeId: "stroke_1" }));

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    ["stroke_2"],
  );
  assert.equal(state.activeStrokes.has("stroke_1"), false);
});

test("stroke:expire does not remove non-ephemeral strokes with a matching stroke ID", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, makeEvent("stroke:expire", { strokeId: "stroke_1" }));

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    ["stroke_1"],
  );
  assert.equal(state.activeStrokes.has("stroke_1"), true);
});

test("board:undo removes a stroke by stroke ID and rebuilds activeStrokes", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, makeStrokeStart("stroke_2"));
  applyBoardEvent(state, makeEvent("stroke:end", { strokeId: "stroke_2" }));
  applyBoardEvent(state, makeEvent("board:undo", { strokeId: "stroke_1" }));

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    ["stroke_2"],
  );
  assert.equal(state.activeStrokes.has("stroke_1"), false);
  assert.equal(state.activeStrokes.has("stroke_2"), false);
});

test("board:restore replaces snapshot state and rebuilds activeStrokes", () => {
  const state = createBoardState();
  const payload = {
    surface: "greenboard",
    background: {
      kind: "image",
      dataUrl: "data:image/jpeg;base64,restored",
      width: 640,
      height: 360,
    },
    strokes: [
      {
        strokeId: "restored_1",
        surface: "greenboard",
        tool: "chalk",
        color: "#ffffff",
        width: 5,
        points: [{ x: 0.2, y: 0.3 }],
        complete: true,
      },
      {
        strokeId: "restored_active",
        surface: "greenboard",
        tool: "chalk",
        color: "#ffffff",
        width: 5,
        points: [{ x: 0.4, y: 0.5 }],
        complete: false,
      },
    ],
    pointer: { visible: true, point: { x: 0.4, y: 0.5 } },
  };

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, makeEvent("board:restore", payload));
  payload.strokes[0].points[0].x = 0.99;
  payload.pointer.point.y = 0.88;

  assert.equal(state.surface, "greenboard");
  assert.deepEqual(state.background, {
    kind: "image",
    dataUrl: "data:image/jpeg;base64,restored",
    width: 640,
    height: 360,
  });
  assert.deepEqual(state.strokes, [
    {
      strokeId: "restored_1",
      surface: "greenboard",
      tool: "chalk",
      color: "#ffffff",
      width: 5,
      points: [{ x: 0.2, y: 0.3, pressure: 0 }],
      complete: true,
    },
    {
      strokeId: "restored_active",
      surface: "greenboard",
      tool: "chalk",
      color: "#ffffff",
      width: 5,
      points: [{ x: 0.4, y: 0.5, pressure: 0 }],
      complete: false,
    },
  ]);
  assert.equal(state.activeStrokes.size, 1);
  assert.equal(state.activeStrokes.get("restored_active"), state.strokes[1]);
  assert.deepEqual(state.pointer, {
    visible: true,
    point: { x: 0.4, y: 0.5, pressure: 0 },
  });
});

test("restored active stroke accepts subsequent stroke points and end events", () => {
  const state = createBoardState();

  applyBoardEvent(
    state,
    makeEvent("board:restore", {
      surface: "whiteboard",
      strokes: [
        {
          strokeId: "active_restore",
          surface: "whiteboard",
          tool: "marker",
          color: "#111111",
          width: 3,
          points: [{ x: 0.1, y: 0.2 }],
          complete: false,
        },
      ],
      pointer: { visible: false, point: null },
    }),
  );
  applyBoardEvent(
    state,
    makeEvent("stroke:point", {
      strokeId: "active_restore",
      point: { x: 0.3, y: 0.4 },
    }),
  );
  applyBoardEvent(state, makeEvent("stroke:end", { strokeId: "active_restore" }));

  assert.deepEqual(state.strokes[0].points, [
    { x: 0.1, y: 0.2, pressure: 0 },
    { x: 0.3, y: 0.4, pressure: 0 },
  ]);
  assert.equal(state.strokes[0].complete, true);
  assert.equal(state.activeStrokes.size, 0);
});

test("board:clear removes strokes, clears activeStrokes, and hides pointer", () => {
  const state = createBoardState();

  applyBoardEvent(
    state,
    makeEvent("board:set-background", {
      background: {
        kind: "image",
        dataUrl: "data:image/jpeg;base64,abc123",
        width: 1280,
        height: 720,
      },
    }),
  );
  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(
    state,
    makeEvent("pointer:show", { point: { x: 0.1, y: 0.2 } }),
  );
  applyBoardEvent(state, makeEvent("board:clear"));

  assert.equal(state.background, null);
  assert.deepEqual(state.strokes, []);
  assert.equal(state.activeStrokes.size, 0);
  assert.deepEqual(state.pointer, { visible: false, point: null });
});

test("pointer:show, pointer:move, and pointer:hide update pointer state", () => {
  const state = createBoardState();

  applyBoardEvent(
    state,
    makeEvent("pointer:show", { point: { x: 0.1, y: 0.2 } }),
  );
  assert.deepEqual(state.pointer, {
    visible: true,
    point: { x: 0.1, y: 0.2, pressure: 0 },
  });

  applyBoardEvent(
    state,
    makeEvent("pointer:move", { point: { x: 0.3, y: 0.4, pressure: 0.5 } }),
  );
  assert.deepEqual(state.pointer, {
    visible: true,
    point: { x: 0.3, y: 0.4, pressure: 0.5 },
  });

  applyBoardEvent(state, makeEvent("pointer:hide"));
  assert.deepEqual(state.pointer, { visible: false, point: null });
});

test("snapshotBoardState returns serializable object and no Map", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  const snapshot = snapshotBoardState(state);

  assert.deepEqual(snapshot, {
    surface: "whiteboard",
    background: null,
    strokes: [
      {
        strokeId: "stroke_1",
        surface: "whiteboard",
        tool: "marker",
        color: "#111111",
        width: 3,
        points: [{ x: 0.25, y: 0.5, pressure: 0 }],
        complete: false,
      },
    ],
    pointer: { visible: false, point: null },
  });
  assert.equal(Object.hasOwn(snapshot, "activeStrokes"), false);
  assert.equal(Object.hasOwn(snapshot, "appliedEventIds"), false);
  assert.equal(Object.hasOwn(snapshot, "appliedEventIdOrder"), false);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test("snapshotBoardState copies stroke points and pointer point away from live state", () => {
  const state = createBoardState();

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(
    state,
    makeEvent("pointer:show", { point: { x: 0.1, y: 0.2 } }),
  );

  const snapshot = snapshotBoardState(state);
  snapshot.strokes[0].points[0].x = 0.99;
  snapshot.pointer.point.y = 0.88;

  assert.deepEqual(state.strokes[0].points[0], {
    x: 0.25,
    y: 0.5,
    pressure: 0,
  });
  assert.deepEqual(state.pointer.point, { x: 0.1, y: 0.2, pressure: 0 });
});

test("invalid event leaves state unchanged", () => {
  const state = createBoardState();
  const before = snapshotBoardState(state);

  applyBoardEvent(state, makeEvent("unknown:event"));

  assert.deepEqual(snapshotBoardState(state), before);
});

test("applyBoardEvent does not mutate the event object", () => {
  const state = createBoardState();
  const event = makeStrokeStart("stroke_1", {
    point: { x: 0.2, y: 0.3 },
    ephemeral: true,
    expiresAt: 12345,
  });
  const before = structuredClone(event);

  applyBoardEvent(state, event);

  assert.deepEqual(event, before);
});

test("replaying the same stroke:start event ID does not create duplicate strokes", () => {
  const state = createBoardState();
  const event = makeStrokeStart("stroke_1", {}, { id: "evt_replay_start" });

  applyBoardEvent(state, event);
  applyBoardEvent(state, structuredClone(event));

  assert.equal(state.strokes.length, 1);
  assert.equal(state.activeStrokes.get("stroke_1"), state.strokes[0]);
});

test("replaying the same stroke:point event ID does not append duplicate points", () => {
  const state = createBoardState();
  const event = makeEvent(
    "stroke:point",
    { strokeId: "stroke_1", point: { x: 0.4, y: 0.6 } },
    { id: "evt_replay_point" },
  );

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, event);
  applyBoardEvent(state, structuredClone(event));

  assert.deepEqual(state.strokes[0].points, [
    { x: 0.25, y: 0.5, pressure: 0 },
    { x: 0.4, y: 0.6, pressure: 0 },
  ]);
});

test("replaying the same stroke:end event ID does not apply twice", () => {
  const state = createBoardState();
  const firstEnd = makeEvent(
    "stroke:end",
    { strokeId: "stroke_1" },
    { id: "evt_replay_end" },
  );
  const secondEnd = makeEvent(
    "stroke:end",
    { strokeId: "stroke_2" },
    { id: "evt_replay_end" },
  );

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, makeStrokeStart("stroke_2"));
  applyBoardEvent(state, firstEnd);
  applyBoardEvent(state, secondEnd);

  assert.equal(state.strokes[0].complete, true);
  assert.equal(state.strokes[1].complete, false);
  assert.equal(state.activeStrokes.has("stroke_1"), false);
  assert.equal(state.activeStrokes.has("stroke_2"), true);
});

test("replaying the same stroke:expire event ID does not remove a second stroke", () => {
  const state = createBoardState();
  const firstExpire = makeEvent(
    "stroke:expire",
    { strokeId: "stroke_1" },
    { id: "evt_replay_expire" },
  );
  const secondExpire = makeEvent(
    "stroke:expire",
    { strokeId: "stroke_2" },
    { id: "evt_replay_expire" },
  );

  applyBoardEvent(
    state,
    makeStrokeStart("stroke_1", { ephemeral: true, expiresAt: 12345 }),
  );
  applyBoardEvent(
    state,
    makeStrokeStart("stroke_2", { ephemeral: true, expiresAt: 12346 }),
  );
  applyBoardEvent(state, firstExpire);
  applyBoardEvent(state, secondExpire);

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    ["stroke_2"],
  );
});

test("replaying the same board:undo event ID does not remove a second stroke", () => {
  const state = createBoardState();
  const firstUndo = makeEvent(
    "board:undo",
    { strokeId: "stroke_1" },
    { id: "evt_replay_undo" },
  );
  const secondUndo = makeEvent(
    "board:undo",
    { strokeId: "stroke_2" },
    { id: "evt_replay_undo" },
  );

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, makeStrokeStart("stroke_2"));
  applyBoardEvent(state, firstUndo);
  applyBoardEvent(state, secondUndo);

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    ["stroke_2"],
  );
});

test("replaying the same board:restore event ID does not apply twice", () => {
  const state = createBoardState();
  const firstRestore = makeEvent(
    "board:restore",
    {
      surface: "whiteboard",
      strokes: [],
      pointer: { visible: false, point: null },
    },
    { id: "evt_replay_restore" },
  );
  const secondRestore = makeEvent(
    "board:restore",
    {
      surface: "greenboard",
      strokes: [],
      pointer: { visible: false, point: null },
    },
    { id: "evt_replay_restore" },
  );

  applyBoardEvent(state, makeEvent("board:set-surface", { surface: "blueboard" }));
  applyBoardEvent(state, firstRestore);
  applyBoardEvent(state, secondRestore);

  assert.equal(state.surface, "whiteboard");
});

test("replaying the same board:clear event ID does not apply twice", () => {
  const state = createBoardState();
  const event = makeEvent("board:clear", {}, { id: "evt_replay_clear" });

  applyBoardEvent(state, makeStrokeStart("stroke_1"));
  applyBoardEvent(state, event);
  applyBoardEvent(state, makeStrokeStart("stroke_2"));
  applyBoardEvent(state, structuredClone(event));

  assert.deepEqual(
    state.strokes.map((stroke) => stroke.strokeId),
    ["stroke_2"],
  );
});

test("replaying the same pointer:show event ID does not apply twice", () => {
  const state = createBoardState();
  const firstShow = makeEvent(
    "pointer:show",
    { point: { x: 0.1, y: 0.2 } },
    { id: "evt_replay_show" },
  );
  const secondShow = makeEvent(
    "pointer:show",
    { point: { x: 0.3, y: 0.4 } },
    { id: "evt_replay_show" },
  );

  applyBoardEvent(state, firstShow);
  applyBoardEvent(state, secondShow);

  assert.deepEqual(state.pointer, {
    visible: true,
    point: { x: 0.1, y: 0.2, pressure: 0 },
  });
});

test("replaying the same pointer:move event ID does not apply twice", () => {
  const state = createBoardState();
  const firstMove = makeEvent(
    "pointer:move",
    { point: { x: 0.1, y: 0.2 } },
    { id: "evt_replay_move" },
  );
  const secondMove = makeEvent(
    "pointer:move",
    { point: { x: 0.3, y: 0.4 } },
    { id: "evt_replay_move" },
  );

  applyBoardEvent(state, firstMove);
  applyBoardEvent(state, secondMove);

  assert.deepEqual(state.pointer, {
    visible: true,
    point: { x: 0.1, y: 0.2, pressure: 0 },
  });
});

test("replaying the same pointer:hide event ID does not apply twice", () => {
  const state = createBoardState();
  const hide = makeEvent("pointer:hide", {}, { id: "evt_replay_hide" });

  applyBoardEvent(
    state,
    makeEvent("pointer:show", { point: { x: 0.1, y: 0.2 } }),
  );
  applyBoardEvent(state, hide);
  applyBoardEvent(
    state,
    makeEvent("pointer:show", { point: { x: 0.3, y: 0.4 } }),
  );
  applyBoardEvent(state, structuredClone(hide));

  assert.deepEqual(state.pointer, {
    visible: true,
    point: { x: 0.3, y: 0.4, pressure: 0 },
  });
});
