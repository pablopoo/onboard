import assert from "node:assert/strict";
import test from "node:test";

import {
  createQRCodeMatrix,
  createQRCodeSVG,
  createShareQRCodeElement,
} from "./qr.js";

function createFakeElement(tagName) {
  return {
    tagName,
    attributes: new Map(),
    childrenList: [],
    textContent: "",
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    append(...children) {
      this.childrenList.push(...children);
    },
  };
}

function createFakeDocument() {
  return {
    createElement(tagName) {
      return createFakeElement(tagName);
    },
    createElementNS(_namespace, tagName) {
      return createFakeElement(tagName);
    },
  };
}

test("createQRCodeMatrix returns a fixed local QR matrix for share URLs", () => {
  const matrix = createQRCodeMatrix("http://192.168.1.20:8080/viewer");

  assert.equal(matrix.size, 37);
  assert.equal(matrix.modules.length, 37);
  assert.equal(matrix.modules[0].length, 37);
  assert.equal(matrix.modules[0][0], true);
  assert.equal(matrix.modules[6][6], true);
  assert.equal(matrix.modules[29][8], true);
  assert.equal(matrix.modules[30][30], true);
});

test("createQRCodeMatrix rejects URLs that do not fit the local share QR size", () => {
  assert.throws(
    () => createQRCodeMatrix("https://example.test/" + "a".repeat(160)),
    /too long/i,
  );
});

test("createQRCodeSVG renders one accessible SVG path for the QR modules", () => {
  const svg = createQRCodeSVG(createFakeDocument(), "http://localhost:8080/board", "Board");

  assert.equal(svg.tagName, "svg");
  assert.equal(svg.attributes.get("class"), "share-qr");
  assert.equal(svg.attributes.get("role"), "img");
  assert.equal(svg.attributes.get("aria-label"), "QR code for Board");
  assert.match(svg.attributes.get("viewBox"), /^0 0 /);
  assert.equal(svg.childrenList.length, 2);
  assert.equal(svg.childrenList[1].tagName, "path");
  assert.match(svg.childrenList[1].attributes.get("d"), /M/);
});

test("createShareQRCodeElement returns a fallback note when the value is too long", () => {
  const fallback = createShareQRCodeElement(
    createFakeDocument(),
    "https://example.test/" + "a".repeat(160),
    "Viewer",
    { fallbackClassName: "qr-fallback" },
  );

  assert.equal(fallback.tagName, "span");
  assert.equal(fallback.className, "qr-fallback");
  assert.equal(fallback.textContent, "QR unavailable");
  assert.equal(fallback.attributes.get("role"), "note");
  assert.match(fallback.attributes.get("aria-label"), /Viewer/);
});
