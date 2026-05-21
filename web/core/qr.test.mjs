import assert from "node:assert/strict";
import test from "node:test";

import {
  createQRCodeMatrix,
  createQRCodeSVG,
  createShareQRCodeElement,
} from "./qr.js";

const QR_VERSION = 5;
const QR_SIZE = 17 + QR_VERSION * 4;
const QR_FORMAT_L_MASK_0 = 0b111011111000100;

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

test("createQRCodeMatrix encodes a decodable viewer URL", () => {
  const value = "http://192.168.1.20:8080/viewer";

  assert.equal(decodeByteModeQRCode(createQRCodeMatrix(value)), value);
});

test("createQRCodeMatrix reserves both format info copies before data placement", () => {
  const matrix = createQRCodeMatrix("http://192.168.1.20:8080/viewer");

  for (let bit = 0; bit < 15; bit += 1) {
    const dark = ((QR_FORMAT_L_MASK_0 >>> bit) & 1) === 1;

    if (bit < 8) {
      assert.equal(matrix.modules[8][QR_SIZE - 1 - bit], dark);
    } else {
      assert.equal(matrix.modules[QR_SIZE - 15 + bit][8], dark);
    }
  }
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

function decodeByteModeQRCode(matrix) {
  const bits = readCodewordBits(matrix);
  let cursor = 0;
  const mode = readBits(bits, cursor, 4);
  cursor += 4;
  assert.equal(mode, 0b0100);

  const byteLength = readBits(bits, cursor, 8);
  cursor += 8;

  const bytes = [];
  for (let index = 0; index < byteLength; index += 1) {
    bytes.push(readBits(bits, cursor, 8));
    cursor += 8;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function readCodewordBits(matrix) {
  const reserved = createReservedModuleMap();
  const bits = [];
  let upward = true;

  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1;
    }

    for (let row = 0; row < QR_SIZE; row += 1) {
      const y = upward ? QR_SIZE - 1 - row : row;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (reserved[y][x]) {
          continue;
        }

        let dark = matrix.modules[y][x];
        if ((x + y) % 2 === 0) {
          dark = !dark;
        }
        bits.push(dark ? 1 : 0);
      }
    }
    upward = !upward;
  }

  return bits;
}

function readBits(bits, cursor, bitCount) {
  let value = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    value = (value << 1) | (bits[cursor + bit] ?? 0);
  }
  return value;
}

function createReservedModuleMap() {
  const reserved = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));

  reserveFinder(reserved, 0, 0);
  reserveFinder(reserved, QR_SIZE - 7, 0);
  reserveFinder(reserved, 0, QR_SIZE - 7);
  reserveAlignment(reserved, 30, 30);
  for (let offset = 8; offset < QR_SIZE - 8; offset += 1) {
    reserve(reserved, offset, 6);
    reserve(reserved, 6, offset);
  }
  for (let index = 0; index <= 5; index += 1) {
    reserve(reserved, 8, index);
    reserve(reserved, index, 8);
  }
  reserve(reserved, 8, 7);
  reserve(reserved, 8, 8);
  reserve(reserved, 7, 8);
  for (let index = 0; index < 8; index += 1) {
    reserve(reserved, QR_SIZE - 1 - index, 8);
  }
  for (let index = 8; index < 15; index += 1) {
    reserve(reserved, 8, QR_SIZE - 15 + index);
  }
  reserve(reserved, 8, QR_VERSION * 4 + 9);

  return reserved;
}

function reserveFinder(reserved, left, top) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      reserve(reserved, left + x, top + y);
    }
  }
}

function reserveAlignment(reserved, centerX, centerY) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      reserve(reserved, centerX + x, centerY + y);
    }
  }
}

function reserve(reserved, x, y) {
  if (x >= 0 && y >= 0 && x < QR_SIZE && y < QR_SIZE) {
    reserved[y][x] = true;
  }
}
