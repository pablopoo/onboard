import { normalizePoint, validateBoardEvent } from "./protocol.js";

export function createBoardState() {
  return {
    surface: "whiteboard",
    strokes: [],
    activeStrokes: new Map(),
    appliedEventIds: new Set(),
    pointer: { visible: false, point: null },
  };
}

export function applyBoardEvent(state, event) {
  if (!validateBoardEvent(event).valid) {
    return state;
  }

  if (!state.appliedEventIds) {
    state.appliedEventIds = new Set();
  }

  if (state.appliedEventIds.has(event.id)) {
    return state;
  }

  state.appliedEventIds.add(event.id);

  const { payload } = event;

  if (event.type === "board:set-surface") {
    state.surface = payload.surface;
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
    return state;
  }

  if (event.type === "stroke:point") {
    const stroke = state.activeStrokes.get(payload.strokeId);
    if (stroke) {
      stroke.points.push(normalizePoint(payload.point));
    }
    return state;
  }

  if (event.type === "stroke:end") {
    const stroke = state.activeStrokes.get(payload.strokeId);
    if (stroke) {
      stroke.complete = true;
      state.activeStrokes.delete(payload.strokeId);
    }
    return state;
  }

  if (event.type === "stroke:expire") {
    state.strokes = state.strokes.filter(
      (stroke) =>
        stroke.strokeId !== payload.strokeId || stroke.ephemeral !== true,
    );

    const activeStroke = state.activeStrokes.get(payload.strokeId);
    if (activeStroke?.ephemeral === true) {
      state.activeStrokes.delete(payload.strokeId);
    }

    return state;
  }

  if (event.type === "board:clear") {
    state.strokes = [];
    state.activeStrokes.clear();
    state.pointer = { visible: false, point: null };
    return state;
  }

  if (event.type === "pointer:show" || event.type === "pointer:move") {
    state.pointer = {
      visible: true,
      point: normalizePoint(payload.point),
    };
    return state;
  }

  if (event.type === "pointer:hide") {
    state.pointer = { visible: false, point: null };
    return state;
  }

  return state;
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

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}
