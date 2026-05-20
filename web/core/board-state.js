import { normalizePoint, validateBoardEvent } from "./protocol.js";

const RECENT_EVENT_ID_LIMIT = 8192;

export function createBoardState() {
  return {
    surface: "whiteboard",
    strokes: [],
    activeStrokes: new Map(),
    appliedEventIds: new Set(),
    appliedEventIdOrder: [],
    pointer: { visible: false, point: null },
  };
}

export function applyBoardEvent(state, event) {
  if (!validateBoardEvent(event).valid) {
    return state;
  }

  ensureEventIdTracking(state);

  if (state.appliedEventIds.has(event.id)) {
    return state;
  }

  const { payload } = event;

  if (event.type === "board:set-surface") {
    state.surface = payload.surface;
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:start") {
    const stroke = {
      strokeId: payload.strokeId,
      surface: payload.surface,
      tool: payload.tool,
      color: payload.color,
      width: payload.width,
      points: [normalizePoint(payload.point)],
      complete: false,
    };

    if (hasOwn(payload, "ephemeral")) {
      stroke.ephemeral = payload.ephemeral;
    }

    if (hasOwn(payload, "expiresAt")) {
      stroke.expiresAt = payload.expiresAt;
    }

    state.strokes.push(stroke);
    state.activeStrokes.set(payload.strokeId, stroke);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:point") {
    const stroke = state.activeStrokes.get(payload.strokeId);
    if (!stroke) {
      return state;
    }

    stroke.points.push(normalizePoint(payload.point));
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:end") {
    const stroke = state.activeStrokes.get(payload.strokeId);
    if (!stroke) {
      return state;
    }

    stroke.complete = true;
    state.activeStrokes.delete(payload.strokeId);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:expire") {
    const beforeCount = state.strokes.length;
    state.strokes = state.strokes.filter(
      (stroke) =>
        stroke.strokeId !== payload.strokeId || stroke.ephemeral !== true,
    );
    if (state.strokes.length === beforeCount) {
      return state;
    }

    const activeStroke = state.activeStrokes.get(payload.strokeId);
    if (activeStroke?.ephemeral === true) {
      state.activeStrokes.delete(payload.strokeId);
    }

    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:undo") {
    const beforeCount = state.strokes.length;
    state.strokes = state.strokes.filter(
      (stroke) => stroke.strokeId !== payload.strokeId,
    );
    if (state.strokes.length === beforeCount) {
      return state;
    }

    rebuildActiveStrokes(state);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:restore") {
    state.surface = payload.surface;
    state.strokes = payload.strokes.map(copyRestoredStroke);
    rebuildActiveStrokes(state);
    state.pointer = copyRestoredPointer(payload.pointer);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:clear") {
    state.strokes = [];
    state.activeStrokes.clear();
    state.pointer = { visible: false, point: null };
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "pointer:show" || event.type === "pointer:move") {
    state.pointer = {
      visible: true,
      point: normalizePoint(payload.point),
    };
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "pointer:hide") {
    state.pointer = { visible: false, point: null };
    rememberAppliedEventId(state, event.id);
    return state;
  }

  return state;
}

function ensureEventIdTracking(state) {
  if (!state.appliedEventIds) {
    state.appliedEventIds = new Set();
  }
  if (!Array.isArray(state.appliedEventIdOrder)) {
    state.appliedEventIdOrder = Array.from(state.appliedEventIds);
  }
}

function rememberAppliedEventId(state, id) {
  if (!id) {
    return;
  }
  ensureEventIdTracking(state);
  if (state.appliedEventIds.has(id)) {
    return;
  }

  state.appliedEventIds.add(id);
  state.appliedEventIdOrder.push(id);
  if (state.appliedEventIdOrder.length <= RECENT_EVENT_ID_LIMIT) {
    return;
  }

  const oldest = state.appliedEventIdOrder.shift();
  state.appliedEventIds.delete(oldest);
}

export function snapshotBoardState(state) {
  return {
    surface: state.surface,
    strokes: state.strokes.map(copyStroke),
    pointer: copyPointer(state.pointer),
  };
}

function copyStroke(stroke) {
  const copy = {
    strokeId: stroke.strokeId,
    surface: stroke.surface,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map(copyPoint),
    complete: stroke.complete,
  };

  if (hasOwn(stroke, "ephemeral")) {
    copy.ephemeral = stroke.ephemeral;
  }

  if (hasOwn(stroke, "expiresAt")) {
    copy.expiresAt = stroke.expiresAt;
  }

  return copy;
}

function copyRestoredStroke(stroke) {
  const copy = {
    strokeId: stroke.strokeId,
    surface: stroke.surface,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map(normalizePoint),
    complete: stroke.complete,
  };

  if (hasOwn(stroke, "ephemeral")) {
    copy.ephemeral = stroke.ephemeral;
  }

  if (hasOwn(stroke, "expiresAt")) {
    copy.expiresAt = stroke.expiresAt;
  }

  return copy;
}

function copyRestoredPointer(pointer) {
  return {
    visible: pointer.visible,
    point: pointer.point ? normalizePoint(pointer.point) : null,
  };
}

function copyPointer(pointer) {
  return {
    visible: pointer.visible,
    point: pointer.point ? copyPoint(pointer.point) : null,
  };
}

function copyPoint(point) {
  return {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
  };
}

function rebuildActiveStrokes(state) {
  state.activeStrokes.clear();

  for (const stroke of state.strokes) {
    if (stroke.complete === false) {
      state.activeStrokes.set(stroke.strokeId, stroke);
    }
  }
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}
