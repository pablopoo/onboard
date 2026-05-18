const SURFACE_BACKGROUNDS = {
  whiteboard: "#f8fafc",
  blackboard: "#1f2521",
  greenboard: "#254f3a",
  blueboard: "#174a7c",
};

const DEFAULT_SURFACE = "whiteboard";

export function renderBoardState(ctx, state, size, options = {}) {
  const surface = surfaceName(state?.surface);
  const background = surfaceBackground(surface);
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  ctx.clearRect(0, 0, size.width, size.height);
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.width, size.height);

  for (const stroke of state?.strokes ?? []) {
    if (isExpired(stroke, now)) {
      continue;
    }

    drawStroke(ctx, stroke, size, background);
  }

  drawPointer(ctx, state?.pointer, size);
  ctx.restore();
}

export function resizeCanvasToDisplaySize(
  canvas,
  ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);

  if (canvas.width === width && canvas.height === height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;
  return true;
}

function drawStroke(ctx, stroke, size, background) {
  const points = stroke?.points ?? [];
  if (points.length === 0) {
    return;
  }

  const style = strokeStyle(stroke, background);

  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = style.alpha;

  const first = scalePoint(points[0], size);

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, style.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);

    for (const point of points.slice(1)) {
      const scaled = scalePoint(point, size);
      ctx.lineTo(scaled.x, scaled.y);
    }

    ctx.stroke();
  }

  ctx.restore();
}

function drawPointer(ctx, pointer, size) {
  if (pointer?.visible !== true || !pointer.point) {
    return;
  }

  const point = scalePoint(pointer.point, size);
  const radius = Math.max(8, Math.min(size.width, size.height) * 0.025);

  ctx.save();
  ctx.fillStyle = "rgba(245, 158, 11, 0.85)";
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function strokeStyle(stroke, background) {
  if (stroke.tool === "eraser") {
    return {
      color: background,
      width: stroke.width,
      alpha: 1,
    };
  }

  if (stroke.tool === "chalk") {
    return {
      color: stroke.color,
      width: stroke.width * 1.35,
      alpha: 0.72,
    };
  }

  return {
    color: stroke.color,
    width: stroke.width,
    alpha: 1,
  };
}

function isExpired(stroke, now) {
  return stroke?.ephemeral === true && Number.isFinite(stroke.expiresAt)
    ? now >= stroke.expiresAt
    : false;
}

function scalePoint(point, size) {
  return {
    x: point.x * size.width,
    y: point.y * size.height,
  };
}

function surfaceName(surface) {
  return hasOwn(SURFACE_BACKGROUNDS, surface) ? surface : DEFAULT_SURFACE;
}

function surfaceBackground(surface) {
  return SURFACE_BACKGROUNDS[surfaceName(surface)];
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}
