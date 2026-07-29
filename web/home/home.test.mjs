import assert from "node:assert/strict";
import test from "node:test";

import { createHomeApp } from "./home.js";

function createFakeElement(properties = {}) {
  const listeners = new Map();

  return {
    textContent: "",
    className: "",
    childrenList: [],
    attributes: new Map(),
    ...properties,
    append(...children) {
      this.childrenList.push(...children);
    },
    replaceChildren(...children) {
      this.childrenList = [...children];
    },
    querySelector(selector) {
      return this.children?.get(selector) ?? null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(listener);
    },
    async dispatch(type, properties = {}) {
      const event = {
        type,
        target: this,
        currentTarget: this,
        preventDefault() {},
        ...properties,
      };
      await Promise.all(
        (listeners.get(type) ?? []).map((listener) => listener(event)),
      );
    },
  };
}

function createFakeDocument(root) {
  return {
    querySelector(selector) {
      return selector === "#home-app" ? root : null;
    },
    createElement(tagName) {
      return createFakeElement({ tagName });
    },
    createElementNS(_namespace, tagName) {
      return createFakeElement({ tagName });
    },
  };
}

function createHomeRoot() {
  const list = createFakeElement();
  const status = createFakeElement();
  const children = new Map([
    ["[data-share-list]", list],
    ["[data-share-status]", status],
  ]);

  return {
    root: createFakeElement({ children }),
    list,
    status,
  };
}

function shareRowsForGroup(group) {
  return group.childrenList.filter((child) => child.className === "share-row");
}

test("home app renders share URLs from the Go share endpoint contract", async () => {
  const { root, list, status } = createHomeRoot();
  const fetchCalls = [];

  const app = await createHomeApp({
    document: createFakeDocument(root),
    location: { origin: "http://localhost:1234" },
    fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            baseUrls: ["http://localhost:1234", "http://192.168.1.20:1234"],
            paths: { board: "/board", viewer: "/viewer" },
          });
        },
      });
    },
  });

  assert.deepEqual(fetchCalls, [
    { url: "/api/share", options: { cache: "no-store" } },
  ]);
  assert.deepEqual(
    app.bases.map((base) => base.baseURL),
    ["http://localhost:1234", "http://192.168.1.20:1234"],
  );
  assert.equal(status.textContent, "LAN ready");
  assert.equal(list.childrenList.length, 2);

  const localRows = shareRowsForGroup(list.childrenList[0]);
  assert.equal(list.childrenList[0].childrenList[0].textContent, "This browser");
  assert.equal(localRows[0].childrenList[1].value, "http://localhost:1234/board");
  assert.equal(localRows[1].childrenList[1].value, "http://localhost:1234/viewer");
  assert.equal(localRows[0].childrenList[3].attributes.get("aria-label"), "QR code for Board");
  assert.equal(localRows[1].childrenList[3].attributes.get("aria-label"), "QR code for Viewer");

  const lanRows = shareRowsForGroup(list.childrenList[1]);
  assert.equal(list.childrenList[1].childrenList[0].textContent, "LAN");
  assert.equal(lanRows[0].childrenList[1].value, "http://192.168.1.20:1234/board");
  assert.equal(lanRows[1].childrenList[1].value, "http://192.168.1.20:1234/viewer");
});

test("home stores presenter fragment and adds it only to Board links", async () => {
  const capability = "A".repeat(43);
  const { root, list } = createHomeRoot();
  const stored = new Map();
  const replacements = [];

  await createHomeApp({
    document: createFakeDocument(root),
    location: {
      origin: "http://localhost:1234",
      hash: `#presenter=${capability}`,
      pathname: "/",
      search: "",
    },
    history: {
      replaceState(...args) {
        replacements.push(args);
      },
    },
    storage: {
      getItem(key) {
        return stored.get(key) ?? null;
      },
      setItem(key, value) {
        stored.set(key, value);
      },
    },
    fetchImpl() {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          baseUrls: ["http://localhost:1234"],
          paths: { board: "/board", viewer: "/viewer" },
        }),
      });
    },
  });

  const rows = shareRowsForGroup(list.childrenList[0]);
  assert.equal(stored.get("onboard.presenterCapability"), capability);
  assert.deepEqual(replacements, [[null, "", "/"]]);
  assert.equal(
    rows[0].childrenList[1].value,
    `http://localhost:1234/board#presenter=${capability}`,
  );
  assert.equal(rows[1].childrenList[1].value, "http://localhost:1234/viewer");
});

test("home app falls back to the current browser origin when share loading fails", async () => {
  const { root, list, status } = createHomeRoot();

  const app = await createHomeApp({
    document: createFakeDocument(root),
    location: { origin: "http://localhost:4321" },
    fetchImpl() {
      return Promise.resolve({ ok: false, status: 500 });
    },
  });

  assert.deepEqual(app.bases, [
    { label: "This browser", baseURL: "http://localhost:4321" },
  ]);
  assert.equal(status.textContent, "Use the LAN address from the terminal for other devices");
  assert.equal(list.childrenList.length, 1);
});

test("home app keeps share links usable when a QR URL is too long", async () => {
  const { root, list } = createHomeRoot();
  const longBaseURL = `https://${"a".repeat(110)}.example.test`;

  const app = await createHomeApp({
    document: createFakeDocument(root),
    location: { origin: "https://example.test" },
    fetchImpl() {
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            baseUrls: [longBaseURL],
            paths: { board: "/board", viewer: "/viewer" },
          });
        },
      });
    },
  });

  assert.deepEqual(app.bases.map((base) => base.baseURL), [
    "https://example.test",
    longBaseURL,
  ]);

  const rows = shareRowsForGroup(list.childrenList[1]);
  assert.equal(rows[0].childrenList[1].value, `${longBaseURL}/board`);
  assert.equal(rows[0].childrenList[3].className, "share-qr-fallback");
  assert.equal(rows[0].childrenList[3].textContent, "QR unavailable");
});

test("home copy button reports failure and resets without breaking the share row", async () => {
  const { root, list } = createHomeRoot();
  const timers = [];

  await createHomeApp({
    document: createFakeDocument(root),
    location: { origin: "http://localhost:1234" },
    fetchImpl() {
      return Promise.resolve({
        ok: true,
        json() {
          return Promise.resolve({
            baseUrls: ["http://localhost:1234"],
            paths: { board: "/board", viewer: "/viewer" },
          });
        },
      });
    },
    copyText() {
      return Promise.reject(new Error("clipboard blocked"));
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
  });

  const rows = shareRowsForGroup(list.childrenList[0]);
  const copyButton = rows[0].childrenList[2];

  await copyButton.dispatch("click");

  assert.equal(rows[0].childrenList[1].value, "http://localhost:1234/board");
  assert.equal(copyButton.textContent, "Copy failed");
  assert.equal(timers[0].delay, 1200);

  timers[0].callback();

  assert.equal(copyButton.textContent, "Copy");
});
