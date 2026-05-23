const EVENT_TYPES = new Set([
  "board:set-surface",
  "board:set-background",
  "stroke:start",
  "stroke:point",
  "stroke:end",
  "stroke:expire",
  "board:clear",
  "board:undo",
  "board:restore",
  "pointer:show",
  "pointer:move",
  "pointer:hide",
]);

const SURFACES = new Set([
  "whiteboard",
  "blueboard",
  "blackboard",
  "greenboard",
]);

const MARKER_SURFACES = new Set(["whiteboard", "blueboard"]);
const CHALK_SURFACES = new Set(["blackboard", "greenboard"]);
const MAX_STROKE_WIDTH = 128;
const MAX_BACKGROUND_DATA_URL_LENGTH = 6_000_000;
const MAX_BACKGROUND_DIMENSION = 8192;

let nextEventNumber = 1;

export function createBoardEvent(type, payload = {}, boardId = "default") {
  const id = `evt_${String(nextEventNumber).padStart(6, "0")}`;
  nextEventNumber += 1;

  return {
    id,
    type,
    boardId,
    at: Date.now(),
    payload,
  };
}

export function normalizePoint(point) {
  return {
    x: clampUnit(point?.x),
    y: clampUnit(point?.y),
    pressure: clampUnit(point?.pressure),
  };
}

export function validateBoardEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return invalid("event must be an object");
  }

  if (!isNonEmptyString(event.id)) {
    return invalid("missing id");
  }

  if (!isNonEmptyString(event.boardId)) {
    return invalid("missing boardId");
  }

  if (!Number.isFinite(event.at)) {
    return invalid("missing at");
  }

  if (!isPlainObject(event.payload)) {
    return invalid("missing object payload");
  }

  if (!EVENT_TYPES.has(event.type)) {
    return invalid(`unknown event type: ${event.type}`);
  }

  if (event.type === "board:set-surface") {
    return validateSurfacePayload(event.payload);
  }

  if (event.type === "board:set-background") {
    return validateSetBackgroundPayload(event.payload);
  }

  if (event.type === "stroke:start") {
    return validateStrokeStartPayload(event.payload);
  }

  if (event.type === "stroke:point") {
    return validateStrokePointPayload(event.payload);
  }

  if (
    event.type === "stroke:end" ||
    event.type === "stroke:expire" ||
    event.type === "board:undo"
  ) {
    return validateStrokeIdPayload(event.payload);
  }

  if (event.type === "board:restore") {
    return validateRestorePayload(event.payload);
  }

  if (event.type === "pointer:show" || event.type === "pointer:move") {
    return validatePointPayload(event.payload);
  }

  if (event.type === "pointer:hide" || event.type === "board:clear") {
    return validateEmptyPayload(event.payload);
  }

  return { valid: true };
}

export function isToolAllowedForSurface(tool, surface) {
  if (tool === "eraser") {
    return SURFACES.has(surface);
  }

  if (tool === "marker") {
    return MARKER_SURFACES.has(surface);
  }

  if (tool === "chalk") {
    return CHALK_SURFACES.has(surface);
  }

  return false;
}

function validateSurfacePayload(payload) {
  if (!SURFACES.has(payload.surface)) {
    return invalid("invalid surface");
  }

  return { valid: true };
}

function validateSetBackgroundPayload(payload) {
  if (!hasOwn(payload, "background")) {
    return invalid("missing background");
  }

  return validateBackgroundSnapshot(payload.background);
}

function validateBackgroundSnapshot(background) {
  if (background === null) {
    return { valid: true };
  }

  if (!isPlainObject(background)) {
    return invalid("background must be an object or null");
  }

  if (background.kind !== "image") {
    return invalid("background kind must be image");
  }

  if (
    !isNonEmptyString(background.dataUrl) ||
    !background.dataUrl.startsWith("data:image/") ||
    background.dataUrl.length > MAX_BACKGROUND_DATA_URL_LENGTH
  ) {
    return invalid("background dataUrl must be a data:image URL");
  }

  if (!isValidBackgroundDimension(background.width)) {
    return invalid("background width must be positive");
  }

  if (!isValidBackgroundDimension(background.height)) {
    return invalid("background height must be positive");
  }

  return { valid: true };
}

function validateStrokeStartPayload(payload) {
  const strokeIdResult = validateStrokeIdPayload(payload);
  if (!strokeIdResult.valid) {
    return strokeIdResult;
  }

  if (!SURFACES.has(payload.surface)) {
    return invalid("invalid surface");
  }

  if (!isToolAllowedForSurface(payload.tool, payload.surface)) {
    return invalid("tool is not allowed for surface");
  }

  if (!isNonEmptyString(payload.color)) {
    return invalid("missing color");
  }

  if (
    !Number.isFinite(payload.width) ||
    payload.width <= 0 ||
    payload.width > MAX_STROKE_WIDTH
  ) {
    return invalid("missing width");
  }

  const pointResult = validatePointPayload(payload);
  if (!pointResult.valid) {
    return pointResult;
  }

  if (hasOwn(payload, "ephemeral") && typeof payload.ephemeral !== "boolean") {
    return invalid("invalid ephemeral");
  }

  if (payload.ephemeral === true && !Number.isFinite(payload.expiresAt)) {
    return invalid("ephemeral strokes require numeric expiresAt");
  }

  if (payload.ephemeral !== true && hasOwn(payload, "expiresAt")) {
    return invalid("expiresAt requires ephemeral true");
  }

  if (hasOwn(payload, "expiresAt") && !Number.isFinite(payload.expiresAt)) {
    return invalid("invalid expiresAt");
  }

  return { valid: true };
}

function validateStrokePointPayload(payload) {
  const strokeIdResult = validateStrokeIdPayload(payload);
  if (!strokeIdResult.valid) {
    return strokeIdResult;
  }

  return validatePointPayload(payload);
}

function validateStrokeIdPayload(payload) {
  if (!isNonEmptyString(payload.strokeId)) {
    return invalid("missing strokeId");
  }

  return { valid: true };
}

function validateRestorePayload(payload) {
  const surfaceResult = validateSurfacePayload(payload);
  if (!surfaceResult.valid) {
    return surfaceResult;
  }

  if (!Array.isArray(payload.strokes)) {
    return invalid("strokes must be an array");
  }

  if (hasOwn(payload, "background")) {
    const backgroundResult = validateBackgroundSnapshot(payload.background);
    if (!backgroundResult.valid) {
      return backgroundResult;
    }
  }

  for (const stroke of payload.strokes) {
    const strokeResult = validateRestoredStroke(stroke);
    if (!strokeResult.valid) {
      return strokeResult;
    }
  }

  return validatePointerSnapshot(payload.pointer);
}

function validateRestoredStroke(stroke) {
  if (!isPlainObject(stroke)) {
    return invalid("stroke must be an object");
  }

  const strokeIdResult = validateStrokeIdPayload(stroke);
  if (!strokeIdResult.valid) {
    return strokeIdResult;
  }

  if (!SURFACES.has(stroke.surface)) {
    return invalid("invalid stroke surface");
  }

  if (!isToolAllowedForSurface(stroke.tool, stroke.surface)) {
    return invalid("tool is not allowed for stroke surface");
  }

  if (!isNonEmptyString(stroke.color)) {
    return invalid("missing stroke color");
  }

  if (
    !Number.isFinite(stroke.width) ||
    stroke.width <= 0 ||
    stroke.width > MAX_STROKE_WIDTH
  ) {
    return invalid("missing stroke width");
  }

  if (!Array.isArray(stroke.points) || stroke.points.length === 0) {
    return invalid("stroke points must be a non-empty array");
  }

  for (const point of stroke.points) {
    const pointResult = validatePointPayload({ point });
    if (!pointResult.valid) {
      return pointResult;
    }
  }

  if (typeof stroke.complete !== "boolean") {
    return invalid("stroke complete must be boolean");
  }

  if (hasOwn(stroke, "ephemeral") && typeof stroke.ephemeral !== "boolean") {
    return invalid("invalid stroke ephemeral");
  }

  if (stroke.ephemeral === true && !Number.isFinite(stroke.expiresAt)) {
    return invalid("ephemeral strokes require numeric expiresAt");
  }

  if (stroke.ephemeral !== true && hasOwn(stroke, "expiresAt")) {
    return invalid("expiresAt requires ephemeral true");
  }

  if (hasOwn(stroke, "expiresAt") && !Number.isFinite(stroke.expiresAt)) {
    return invalid("invalid stroke expiresAt");
  }

  return { valid: true };
}

function validatePointerSnapshot(pointer) {
  if (!isPlainObject(pointer)) {
    return invalid("pointer must be an object");
  }

  if (typeof pointer.visible !== "boolean") {
    return invalid("pointer visible must be boolean");
  }

  if (pointer.visible === false) {
    if (pointer.point !== null) {
      return invalid("hidden pointer point must be null");
    }

    return { valid: true };
  }

  return validatePointPayload(pointer);
}

function validatePointPayload(payload) {
  if (!isPlainObject(payload.point)) {
    return invalid("missing point");
  }

  if (!isUnitNumber(payload.point.x)) {
    return invalid("point x must be in 0..1");
  }

  if (!isUnitNumber(payload.point.y)) {
    return invalid("point y must be in 0..1");
  }

  if (
    hasOwn(payload.point, "pressure") &&
    !isUnitNumber(payload.point.pressure)
  ) {
    return invalid("point pressure must be in 0..1");
  }

  return { valid: true };
}

function validateEmptyPayload(payload) {
  if (Object.keys(payload).length !== 0) {
    return invalid("expected empty payload");
  }

  return { valid: true };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUnitNumber(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidBackgroundDimension(value) {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_BACKGROUND_DIMENSION
  );
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function clampUnit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.min(1, Math.max(0, numericValue));
}

function invalid(reason) {
  return { valid: false, reason };
}
