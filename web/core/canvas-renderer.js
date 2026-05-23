const SURFACE_BACKGROUNDS = {
  whiteboard: "#f8fafc",
  blackboard: "#1f2521",
  greenboard: "#254f3a",
  blueboard: "#174a7c",
};

const DEFAULT_SURFACE = "whiteboard";
const DEFAULT_BOARD_ASPECT_RATIO = 16 / 9;
const RENDER_CACHES = new WeakMap();
const CHALK_PARTICLES_PER_STAMP = 9;
const BACKGROUND_IMAGE_CACHE = new Map();
const BACKGROUND_IMAGE_CACHE_LIMIT = 8;

export function boardViewportForSize(size, aspectRatio = DEFAULT_BOARD_ASPECT_RATIO) {
  const width = Math.max(0, size?.width ?? 0);
  const height = Math.max(0, size?.height ?? 0);
  const targetAspectRatio =
    Number.isFinite(aspectRatio) && aspectRatio > 0
      ? aspectRatio
      : DEFAULT_BOARD_ASPECT_RATIO;

  if (width === 0 || height === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const canvasAspectRatio = width / height;

  if (canvasAspectRatio > targetAspectRatio) {
    const frameWidth = height * targetAspectRatio;
    return {
      x: (width - frameWidth) / 2,
      y: 0,
      width: frameWidth,
      height,
    };
  }

  const frameHeight = width / targetAspectRatio;
  return {
    x: 0,
    y: (height - frameHeight) / 2,
    width,
    height: frameHeight,
  };
}

export function renderBoardState(ctx, state, size, options = {}) {
  const surface = surfaceName(state?.surface);
  const background = surfaceBackground(surface);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const viewport = boardViewportForSize(size, options.aspectRatio);
  const backgroundImage = backgroundImageForState(state, options);
  const cache = backgroundImage ? null : getRenderCache(ctx, size, surface);

  if (cache) {
    renderBoardStateWithCache(ctx, cache, state, size, viewport, background, now);
    return;
  }

  ctx.clearRect(0, 0, size.width, size.height);
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
  drawBackgroundImage(ctx, backgroundImage, state?.background, viewport);

  for (const stroke of state?.strokes ?? []) {
    if (isExpired(stroke, now)) {
      continue;
    }

    drawStroke(ctx, stroke, viewport, background);
  }

  drawPointer(ctx, state?.pointer, viewport);
  ctx.restore();
}

function backgroundImageForState(state, options) {
  const background = state?.background;
  if (background?.kind !== "image" || typeof background.dataUrl !== "string") {
    return null;
  }

  const entry = imageCacheEntry(background.dataUrl, options);
  const image = entry?.image;
  const loaded =
    entry?.loaded === true ||
    (image?.complete === true && Number(image.naturalWidth) > 0);

  return loaded ? image : null;
}

function imageCacheEntry(dataUrl, options) {
  let entry = BACKGROUND_IMAGE_CACHE.get(dataUrl);
  if (entry) {
    return entry;
  }

  const createImage = options.createImage ?? defaultCreateImage;
  const image = createImage?.();
  if (!image) {
    return null;
  }

  entry = { image, loaded: false };
  BACKGROUND_IMAGE_CACHE.set(dataUrl, entry);
  trimBackgroundImageCache();

  const handleLoad = () => {
    entry.loaded = true;
    options.onBackgroundLoad?.();
  };

  if (typeof image.addEventListener === "function") {
    image.addEventListener("load", handleLoad, { once: true });
    image.addEventListener(
      "error",
      () => {
        BACKGROUND_IMAGE_CACHE.delete(dataUrl);
      },
      { once: true },
    );
  } else {
    image.onload = handleLoad;
    image.onerror = () => {
      BACKGROUND_IMAGE_CACHE.delete(dataUrl);
    };
  }

  image.src = dataUrl;
  if (image.complete === true && Number(image.naturalWidth) > 0) {
    entry.loaded = true;
  }

  return entry;
}

function defaultCreateImage() {
  if (typeof Image === "function") {
    return new Image();
  }

  return null;
}

function trimBackgroundImageCache() {
  while (BACKGROUND_IMAGE_CACHE.size > BACKGROUND_IMAGE_CACHE_LIMIT) {
    const oldestKey = BACKGROUND_IMAGE_CACHE.keys().next().value;
    BACKGROUND_IMAGE_CACHE.delete(oldestKey);
  }
}

function drawBackgroundImage(ctx, image, background, viewport) {
  if (!image || typeof ctx.drawImage !== "function") {
    return;
  }

  const rect = containRect(
    viewport,
    background?.width || image.naturalWidth,
    background?.height || image.naturalHeight,
  );
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
}

function containRect(viewport, sourceWidth, sourceHeight) {
  const imageAspect =
    Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) && sourceHeight > 0
      ? sourceWidth / sourceHeight
      : viewport.width / viewport.height;
  const viewportAspect = viewport.width / viewport.height;

  if (imageAspect > viewportAspect) {
    const height = viewport.width / imageAspect;
    return {
      x: viewport.x,
      y: viewport.y + (viewport.height - height) / 2,
      width: viewport.width,
      height,
    };
  }

  const width = viewport.height * imageAspect;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y,
    width,
    height: viewport.height,
  };
}

function renderBoardStateWithCache(ctx, cache, state, size, viewport, background, now) {
  const cachedStrokeIds = updateStaticLayer(
    cache,
    state?.strokes ?? [],
    size,
    viewport,
    background,
    now,
  );

  ctx.clearRect(0, 0, size.width, size.height);
  ctx.save();
  ctx.drawImage(cache.canvas, 0, 0);

  for (const stroke of state?.strokes ?? []) {
    if (cachedStrokeIds.has(stroke.strokeId) || isExpired(stroke, now)) {
      continue;
    }

    drawStroke(ctx, stroke, viewport, background);
  }

  drawPointer(ctx, state?.pointer, viewport);
  ctx.restore();
}

function updateStaticLayer(cache, strokes, size, viewport, background, now) {
  const cacheableStrokes = strokes.filter((stroke) =>
    isCacheableStroke(stroke, now),
  );
  const cacheableIds = cacheableStrokes.map((stroke) => stroke.strokeId);
  const canAppend =
    cache.valid === true && isIdPrefix(cache.cachedStrokeIds, cacheableIds);
  const startIndex = canAppend ? cache.cachedStrokeIds.length : 0;

  if (!canAppend) {
    cache.ctx.clearRect(0, 0, size.width, size.height);
    cache.ctx.save();
    cache.ctx.fillStyle = background;
    cache.ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
    cache.ctx.restore();
  }

  for (const stroke of cacheableStrokes.slice(startIndex)) {
    drawStroke(cache.ctx, stroke, viewport, background);
  }

  cache.cachedStrokeIds = cacheableIds;
  cache.valid = true;
  return new Set(cacheableIds);
}

function getRenderCache(ctx, size, surface) {
  if (typeof ctx.drawImage !== "function") {
    return null;
  }

  let cache = RENDER_CACHES.get(ctx);

  if (!cache) {
    const canvas = createLayerCanvas(ctx.canvas);
    const layerContext = canvas?.getContext?.("2d");
    if (!canvas || !layerContext) {
      return null;
    }

    cache = {
      canvas,
      ctx: layerContext,
      surface: null,
      width: 0,
      height: 0,
      cachedStrokeIds: [],
      valid: false,
    };
    RENDER_CACHES.set(ctx, cache);
  }

  if (
    cache.width !== size.width ||
    cache.height !== size.height ||
    cache.surface !== surface
  ) {
    cache.canvas.width = size.width;
    cache.canvas.height = size.height;
    cache.width = size.width;
    cache.height = size.height;
    cache.surface = surface;
    cache.cachedStrokeIds = [];
    cache.valid = false;
  }

  return cache;
}

function createLayerCanvas(sourceCanvas) {
  if (sourceCanvas?.ownerDocument?.createElement) {
    return sourceCanvas.ownerDocument.createElement("canvas");
  }

  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(1, 1);
  }

  return null;
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

function drawStroke(ctx, stroke, viewport, background) {
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

  if (style.texture === "chalk") {
    drawChalkStroke(ctx, stroke, points, viewport, style);
    ctx.restore();
    return;
  }

  const first = scalePoint(points[0], viewport);

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, style.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);

    drawSmoothStrokePath(ctx, points, viewport);

    ctx.stroke();
  }

  ctx.restore();
}

function drawChalkStroke(ctx, stroke, points, viewport, style) {
  ctx.globalAlpha = 0.12;
  ctx.lineWidth = style.width * 1.18;
  drawStrokePath(ctx, points, viewport);

  ctx.globalAlpha = 0.46;
  ctx.lineWidth = style.width * 0.82;
  drawStrokePath(ctx, points, viewport);

  ctx.globalAlpha = 0.18;
  ctx.lineWidth = style.width * 0.3;
  drawStrokePath(ctx, points, viewport);

  drawChalkParticles(ctx, stroke, points, viewport, style);
  drawChalkDust(ctx, stroke, points, viewport, style);
}

function drawStrokePath(ctx, points, viewport, mapPoint = null) {
  const resolvePoint = mapPoint ?? ((point) => scalePoint(point, viewport));
  const first = resolvePoint(points[0], 0);

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  drawSmoothStrokePath(ctx, points, viewport, resolvePoint);
  ctx.stroke();
}

function drawSmoothStrokePath(ctx, points, viewport, mapPoint = null) {
  const resolvePoint = mapPoint ?? ((point) => scalePoint(point, viewport));

  if (points.length === 2) {
    const end = resolvePoint(points[1], 1);
    ctx.lineTo(end.x, end.y);
    return;
  }

  for (let index = 1; index < points.length - 1; index += 1) {
    const current = resolvePoint(points[index], index);
    const next = resolvePoint(points[index + 1], index + 1);
    const midpoint = {
      x: (current.x + next.x) / 2,
      y: (current.y + next.y) / 2,
    };

    ctx.quadraticCurveTo(current.x, current.y, midpoint.x, midpoint.y);
  }

  const last = resolvePoint(points.at(-1), points.length - 1);
  ctx.lineTo(last.x, last.y);
}

function drawChalkDust(ctx, stroke, points, viewport, style) {
  const step = Math.max(1, Math.ceil(points.length / 24));

  ctx.save();
  ctx.fillStyle = style.color;
  ctx.globalAlpha = 0.08;

  for (let index = 0; index < points.length; index += step) {
    const point = scalePoint(points[index], viewport);
    const spread = style.width * 0.55;
    const offsetX = seededUnit(stroke.strokeId, "dust-x", index) * spread;
    const offsetY = seededUnit(stroke.strokeId, "dust-y", index) * spread;
    const radius =
      Math.max(0.35, style.width * 0.025) +
      Math.abs(seededUnit(stroke.strokeId, "dust-r", index)) * style.width * 0.025;

    ctx.beginPath();
    ctx.arc(point.x + offsetX, point.y + offsetY, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawChalkParticles(ctx, stroke, points, viewport, style) {
  ctx.save();
  ctx.fillStyle = style.color;

  if (points.length === 1) {
    stampChalkParticles(ctx, stroke, scalePoint(points[0], viewport), {
      normalX: 0,
      normalY: 1,
      pressure: normalizePressure(points[0].pressure),
      sampleIndex: 0,
      spacing: style.width,
      style,
    });
    ctx.restore();
    return;
  }

  let sampleIndex = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = scalePoint(points[index], viewport);
    const end = scalePoint(points[index + 1], viewport);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);

    if (length < 0.5) {
      continue;
    }

    const normalX = -dy / length;
    const normalY = dx / length;
    const sampleCount = Math.max(1, Math.ceil(length / Math.max(1.4, style.width * 0.13)));
    const pressure = averagePressure(points[index], points[index + 1]);
    const spacing = length / sampleCount;

    for (let segmentSample = 0; segmentSample <= sampleCount; segmentSample += 1) {
      const t = segmentSample / sampleCount;
      sampleIndex += 1;

      stampChalkParticles(ctx, stroke, {
        x: start.x + dx * t,
        y: start.y + dy * t,
      }, {
        normalX,
        normalY,
        pressure,
        sampleIndex,
        spacing,
        style,
      });
    }
  }

  ctx.restore();
}

function stampChalkParticles(ctx, stroke, center, options) {
  const {
    normalX,
    normalY,
    pressure,
    sampleIndex,
    spacing,
    style,
  } = options;
  const density = CHALK_PARTICLES_PER_STAMP + Math.round(pressure * 2);

  for (let grainIndex = 0; grainIndex < density; grainIndex += 1) {
    const seedIndex = sampleIndex * 17 + grainIndex;
    const tangentX = -normalY;
    const tangentY = normalX;
    const crossOffset =
      seededUnit(stroke.strokeId, "chalk-cross", seedIndex) * style.width * 0.44;
    const tangentOffset =
      seededUnit(stroke.strokeId, "chalk-along", seedIndex) * spacing * 0.48;
    const radius =
      style.width *
      (0.006 + Math.abs(seededUnit(stroke.strokeId, "chalk-radius", seedIndex)) * 0.03);
    const alpha =
      0.05 +
      pressure * 0.05 +
      Math.abs(seededUnit(stroke.strokeId, "chalk-alpha", seedIndex)) * 0.24;

    ctx.globalAlpha = Math.min(0.34, alpha);
    ctx.beginPath();
    ctx.arc(
      center.x + normalX * crossOffset + tangentX * tangentOffset,
      center.y + normalY * crossOffset + tangentY * tangentOffset,
      Math.max(0.35, radius),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

function averagePressure(start, end) {
  return (normalizePressure(start.pressure) + normalizePressure(end.pressure)) / 2;
}

function normalizePressure(pressure) {
  return Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0;
}

function drawPointer(ctx, pointer, viewport) {
  if (pointer?.visible !== true || !pointer.point) {
    return;
  }

  const point = scalePoint(pointer.point, viewport);
  const radius = Math.max(8, Math.min(viewport.width, viewport.height) * 0.025);

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
      width: stroke.width * 1.3,
      alpha: 0.42,
      texture: "chalk",
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

function isCacheableStroke(stroke, now) {
  return stroke?.complete === true && stroke.ephemeral !== true && !isExpired(stroke, now);
}

function isIdPrefix(prefix, values) {
  if (prefix.length > values.length) {
    return false;
  }

  return prefix.every((id, index) => id === values[index]);
}

function scalePoint(point, viewport) {
  return {
    x: viewport.x + point.x * viewport.width,
    y: viewport.y + point.y * viewport.height,
  };
}

function seededUnit(strokeId, salt, index) {
  const hash = hashString(`${strokeId}:${salt}:${index}`);
  return (hash / 0xffffffff) * 2 - 1;
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
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
