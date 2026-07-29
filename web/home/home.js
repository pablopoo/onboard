import { copyText as defaultCopyText } from "../core/clipboard.js";
import { createShareQRCodeElement } from "../core/qr.js";

const DEFAULT_SHARE_TARGETS = [
  { label: "Board", path: "/board" },
  { label: "Viewer", path: "/viewer" },
];
const PRESENTER_CAPABILITY_KEY = "onboard.presenterCapability";
const PRESENTER_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function createShareURL(baseURL, path, presenterCapability = "") {
  const url = new URL(path, baseURL);
  if (presenterCapability) {
    url.hash = `presenter=${presenterCapability}`;
  }
  return url.href;
}

async function loadShareConfig(location = globalThis.location, fetchImpl = globalThis.fetch) {
  const currentBase = normalizeBaseURL(location?.origin ?? "");

  if (typeof fetchImpl !== "function") {
    return {
      bases: [{ label: "This browser", baseURL: currentBase }],
      targets: DEFAULT_SHARE_TARGETS,
    };
  }

  try {
    const response = await fetchImpl("/api/share", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`share endpoint returned ${response.status}`);
    }

    const payload = await response.json();
    const bases = Array.isArray(payload?.baseUrls) ? payload.baseUrls : [];
    return {
      bases: normalizeShareBases(bases, currentBase),
      targets: shareTargetsForPaths(payload?.paths),
    };
  } catch {
    return {
      bases: [{ label: "This browser", baseURL: currentBase }],
      targets: DEFAULT_SHARE_TARGETS,
    };
  }
}

function normalizeShareBases(bases, currentBase) {
  const seen = new Set();
  const normalized = [];

  for (const base of bases) {
    const baseURL = normalizeBaseURL(base);
    if (!baseURL || seen.has(baseURL)) {
      continue;
    }

    seen.add(baseURL);
    normalized.push({
      label: labelForBaseURL(baseURL, currentBase),
      baseURL,
    });
  }

  if (currentBase && !seen.has(currentBase)) {
    normalized.unshift({ label: "This browser", baseURL: currentBase });
  }

  return normalized.length > 0
    ? normalized
    : [{ label: "This browser", baseURL: currentBase }];
}

function renderShareList(document, container, bases, targets, options = {}) {
  container.replaceChildren();

  for (const base of bases) {
    const group = document.createElement("section");
    group.className = "share-group";

    const title = document.createElement("h3");
    title.textContent = base.label;
    group.append(title);

    for (const target of targets) {
      group.append(
        createShareRow(
          document,
          target.label,
          createShareURL(
            base.baseURL,
            target.path,
            target.label === "Board" ? options.presenterCapability : "",
          ),
          options,
        ),
      );
    }

    container.append(group);
  }
}

function createShareRow(document, label, url, options = {}) {
  const copy = options.copyText ?? defaultCopyText;
  const setTimer = options.setTimeout ?? globalThis.setTimeout?.bind(globalThis);
  const row = document.createElement("div");
  row.className = "share-row";

  const link = document.createElement("a");
  link.href = url;
  link.textContent = label;

  const value = document.createElement("input");
  value.type = "text";
  value.readOnly = true;
  value.value = url;
  value.setAttribute("aria-label", `${label} URL`);

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    try {
      await copy(url);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimer?.(() => {
      button.textContent = "Copy";
    }, 1200);
  });

  row.append(link, value, button, createShareQRCodeElement(document, url, label));
  return row;
}

export async function createHomeApp({
  document = globalThis.document,
  location = globalThis.location,
  fetchImpl = globalThis.fetch,
  copyText: copyTextImpl = defaultCopyText,
  setTimeout: setTimer = globalThis.setTimeout?.bind(globalThis),
  storage = globalThis.localStorage,
  history = globalThis.history,
} = {}) {
  const root = document?.querySelector?.("#home-app");
  if (!root) {
    return null;
  }

  const list = root.querySelector("[data-share-list]");
  const status = root.querySelector("[data-share-status]");
  if (!list) {
    return null;
  }

  const presenterCapability = loadPresenterCapability(location, storage, history);
  const { bases, targets } = await loadShareConfig(location, fetchImpl);
  renderShareList(document, list, bases, targets, {
    copyText: copyTextImpl,
    setTimeout: setTimer,
    presenterCapability,
  });
  if (status) {
    status.textContent = bases.some((base) => isLANBaseURL(base.baseURL))
      ? "LAN ready"
      : "Use the LAN address from the terminal for other devices";
  }

  return { bases, targets };
}

function loadPresenterCapability(location, storage, history) {
  const fragment = new URLSearchParams(String(location?.hash ?? "").replace(/^#/, ""));
  const supplied = fragment.get("presenter") ?? "";
  if (PRESENTER_CAPABILITY_PATTERN.test(supplied)) {
    try {
      storage?.setItem?.(PRESENTER_CAPABILITY_KEY, supplied);
    } catch {
      // Storage can be unavailable in hardened browser modes.
    }
    history?.replaceState?.(
      null,
      "",
      `${location?.pathname || "/"}${location?.search || ""}`,
    );
    return supplied;
  }

  try {
    const stored = storage?.getItem?.(PRESENTER_CAPABILITY_KEY) ?? "";
    return PRESENTER_CAPABILITY_PATTERN.test(stored) ? stored : "";
  } catch {
    return "";
  }
}

function shareTargetsForPaths(paths) {
  return [
    { label: "Board", path: normalizePath(paths?.board, "/board") },
    { label: "Viewer", path: normalizePath(paths?.viewer, "/viewer") },
  ];
}

function normalizePath(value, fallback) {
  const path = String(value ?? "").trim();
  return path.startsWith("/") ? path : fallback;
}

function normalizeBaseURL(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function labelForBaseURL(baseURL, currentBase) {
  if (baseURL === currentBase) {
    return "This browser";
  }

  return isLANBaseURL(baseURL) ? "LAN" : "Local";
}

function isLANBaseURL(baseURL) {
  try {
    const hostname = new URL(baseURL).hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
  } catch {
    return false;
  }
}

if (typeof globalThis.document !== "undefined") {
  createHomeApp();
}
