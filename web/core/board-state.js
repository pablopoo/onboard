import {
  normalizePoint,
  RELAY_LIMITS,
  utf8ByteLength,
  validateBoardEvent,
} from "./protocol.js";

const RECENT_EVENT_ID_LIMIT = 8192;

export function createBoardState() {
  const state = {
    surface: "whiteboard",
    background: null,
    strokes: [],
    activeStrokes: new Map(),
    appliedEventIds: new Set(),
    appliedEventIdOrder: [],
    pointer: { visible: false, point: null },
  };
  rebuildStateAccounting(state);
  return state;
}

export function applyBoardEvent(state, event) {
  if (!validateBoardEvent(event).valid) {
    return state;
  }

  ensureEventIdTracking(state);
  ensureStateAccounting(state);

  if (state.appliedEventIds.has(event.id)) {
    return state;
  }

  const { payload } = event;

  if (event.type === "board:set-surface") {
    const retainedBytes =
      state.retainedBytes - serializedBytes(state.surface) +
      serializedBytes(payload.surface);
    if (retainedBytes > RELAY_LIMITS.maxStateBytes) {
      return state;
    }
    state.surface = payload.surface;
    state.retainedBytes = retainedBytes;
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:set-background") {
    const background = copyBackground(payload.background);
    const retainedBytes =
      state.retainedBytes - serializedBytes(state.background) +
      serializedBytes(background);
    if (retainedBytes > RELAY_LIMITS.maxStateBytes) {
      return state;
    }
    state.background = background;
    state.retainedBytes = retainedBytes;
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:start") {
    if (
      state.strokeIds.has(payload.strokeId) ||
      state.strokes.length >= RELAY_LIMITS.maxStrokes ||
      state.totalPoints >= RELAY_LIMITS.maxTotalPoints
    ) {
      return state;
    }

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

    const strokeByteLength = serializedBytes(stroke);
    const retainedBytes =
      state.retainedBytes + strokeByteLength + (state.strokes.length > 0 ? 1 : 0);
    if (retainedBytes > RELAY_LIMITS.maxStateBytes) {
      return state;
    }

    state.strokes.push(stroke);
    state.activeStrokes.set(payload.strokeId, stroke);
    state.strokeIds.add(payload.strokeId);
    state.strokeBytes.set(payload.strokeId, strokeByteLength);
    state.totalPoints += 1;
    state.retainedBytes = retainedBytes;
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:point") {
    const stroke = state.activeStrokes.get(payload.strokeId);
    if (!stroke) {
      return state;
    }

    if (
      stroke.points.length >= RELAY_LIMITS.maxPointsPerStroke ||
      state.totalPoints >= RELAY_LIMITS.maxTotalPoints
    ) {
      return state;
    }

    const point = normalizePoint(payload.point);
    const pointByteLength = serializedBytes(point) + 1;
    if (
      state.retainedBytes + pointByteLength > RELAY_LIMITS.maxStateBytes
    ) {
      return state;
    }

    stroke.points.push(point);
    state.strokeBytes.set(
      payload.strokeId,
      state.strokeBytes.get(payload.strokeId) + pointByteLength,
    );
    state.totalPoints += 1;
    state.retainedBytes += pointByteLength;
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:end") {
    const stroke = state.activeStrokes.get(payload.strokeId);
    if (!stroke) {
      return state;
    }

    const oldStrokeBytes = state.strokeBytes.get(payload.strokeId);
    stroke.complete = true;
    const newStrokeBytes = serializedBytes(stroke);
    state.strokeBytes.set(payload.strokeId, newStrokeBytes);
    state.retainedBytes += newStrokeBytes - oldStrokeBytes;
    state.activeStrokes.delete(payload.strokeId);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "stroke:expire") {
    const stroke = state.strokes.find(
      (candidate) => candidate.strokeId === payload.strokeId,
    );
    if (!stroke || stroke.ephemeral !== true) {
      return state;
    }

    removeStroke(state, stroke);

    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:undo") {
    const stroke = state.strokes.find(
      (candidate) => candidate.strokeId === payload.strokeId,
    );
    if (!stroke) {
      return state;
    }

    removeStroke(state, stroke);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:restore") {
    const background = copyBackground(payload.background ?? null);
    const strokes = payload.strokes.map(copyRestoredStroke);
    const pointer = copyRestoredPointer(payload.pointer);
    const snapshot = {
      surface: payload.surface,
      background,
      strokes,
      pointer,
    };
    if (serializedBytes(snapshot) > RELAY_LIMITS.maxStateBytes) {
      return state;
    }

    state.surface = payload.surface;
    state.background = background;
    state.strokes = strokes;
    rebuildActiveStrokes(state);
    state.pointer = pointer;
    rebuildStateAccounting(state);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "board:clear") {
    state.background = null;
    state.strokes = [];
    state.activeStrokes.clear();
    state.pointer = { visible: false, point: null };
    rebuildStateAccounting(state);
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "pointer:show" || event.type === "pointer:move") {
    const pointer = {
      visible: true,
      point: normalizePoint(payload.point),
    };
    const retainedBytes =
      state.retainedBytes - serializedBytes(state.pointer) +
      serializedBytes(pointer);
    if (retainedBytes > RELAY_LIMITS.maxStateBytes) {
      return state;
    }
    state.pointer = pointer;
    state.retainedBytes = retainedBytes;
    rememberAppliedEventId(state, event.id);
    return state;
  }

  if (event.type === "pointer:hide") {
    const pointer = { visible: false, point: null };
    state.retainedBytes =
      state.retainedBytes - serializedBytes(state.pointer) +
      serializedBytes(pointer);
    state.pointer = pointer;
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

function ensureStateAccounting(state) {
  if (
    !(state.strokeIds instanceof Set) ||
    !(state.strokeBytes instanceof Map) ||
    !Number.isFinite(state.totalPoints) ||
    !Number.isFinite(state.retainedBytes)
  ) {
    rebuildStateAccounting(state);
  }
}

function rebuildStateAccounting(state) {
  state.strokeIds = new Set();
  state.strokeBytes = new Map();
  state.totalPoints = 0;

  for (const stroke of state.strokes) {
    state.strokeIds.add(stroke.strokeId);
    state.strokeBytes.set(stroke.strokeId, serializedBytes(stroke));
    state.totalPoints += stroke.points.length;
  }

  state.retainedBytes = serializedBytes(snapshotBoardState(state));
}

function removeStroke(state, stroke) {
  const separatorBytes = state.strokes.length > 1 ? 1 : 0;
  state.retainedBytes -=
    state.strokeBytes.get(stroke.strokeId) + separatorBytes;
  state.totalPoints -= stroke.points.length;
  state.strokeIds.delete(stroke.strokeId);
  state.strokeBytes.delete(stroke.strokeId);
  state.activeStrokes.delete(stroke.strokeId);
  state.strokes = state.strokes.filter(
    (candidate) => candidate.strokeId !== stroke.strokeId,
  );
}

function serializedBytes(value) {
  return utf8ByteLength(JSON.stringify(value));
}

export function snapshotBoardState(state) {
  return {
    surface: state.surface,
    background: copyBackground(state.background),
    strokes: state.strokes.map(copyStroke),
    pointer: copyPointer(state.pointer),
  };
}

function copyBackground(background) {
  if (background === null || background === undefined) {
    return null;
  }

  return {
    kind: background.kind,
    dataUrl: background.dataUrl,
    width: background.width,
    height: background.height,
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
