const QR_VERSION = 5;
const QR_SIZE = 17 + QR_VERSION * 4;
const QR_DATA_CODEWORDS = 108;
const QR_ECC_CODEWORDS = 26;
const QR_MASK_PATTERN = 0;
const QR_FORMAT_L_MASK_0 = 0b111011111000100;
const QR_MARGIN = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

let gfTables = null;

export function createQRCodeMatrix(value) {
  const data = encodeDataCodewords(String(value ?? ""));
  const codewords = [...data, ...reedSolomonRemainder(data, QR_ECC_CODEWORDS)];
  const modules = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
  const reserved = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));

  drawFunctionPatterns(modules, reserved);
  drawCodewords(modules, reserved, codewords);
  drawFormatBits(modules, reserved);

  return { size: QR_SIZE, modules };
}

export function createQRCodeSVG(document, value, label = "link") {
  const matrix = createQRCodeMatrix(value);
  const viewBoxSize = matrix.size + QR_MARGIN * 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "share-qr");
  svg.setAttribute("viewBox", `0 0 ${viewBoxSize} ${viewBoxSize}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR code for ${label}`);
  svg.setAttribute("focusable", "false");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(viewBoxSize));
  background.setAttribute("height", String(viewBoxSize));
  background.setAttribute("rx", "2");
  background.setAttribute("fill", "white");

  const modules = document.createElementNS(SVG_NS, "path");
  modules.setAttribute("fill", "currentColor");
  modules.setAttribute("shape-rendering", "crispEdges");
  modules.setAttribute("d", modulePath(matrix.modules, QR_MARGIN));

  svg.append(background, modules);
  return svg;
}

export function createShareQRCodeElement(
  document,
  value,
  label = "link",
  {
    className = "share-qr",
    fallbackClassName = "share-qr-fallback",
  } = {},
) {
  try {
    const qr = createQRCodeSVG(document, value, label);
    qr.setAttribute("class", className);
    return qr;
  } catch {
    const fallback = document.createElement("span");
    fallback.className = fallbackClassName;
    fallback.textContent = "QR unavailable";
    fallback.setAttribute("role", "note");
    fallback.setAttribute(
      "aria-label",
      `QR code unavailable for ${label}; use the visible link instead`,
    );
    return fallback;
  }
}

function encodeDataCodewords(value) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 106) {
    throw new Error("QR value is too long for the local share QR size");
  }

  const bits = new BitBuffer();
  bits.append(0b0100, 4);
  bits.append(bytes.length, 8);
  for (const byte of bytes) {
    bits.append(byte, 8);
  }

  const capacityBits = QR_DATA_CODEWORDS * 8;
  bits.append(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.append(0, 1);
  }

  const codewords = bits.toCodewords();
  for (let pad = 0xec; codewords.length < QR_DATA_CODEWORDS; pad = pad === 0xec ? 0x11 : 0xec) {
    codewords.push(pad);
  }
  return codewords;
}

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  get length() {
    return this.bits.length;
  }

  append(value, bitCount) {
    if (bitCount < 0 || this.bits.length + bitCount > QR_DATA_CODEWORDS * 8) {
      throw new Error("QR value is too long for the local share QR size");
    }

    for (let bit = bitCount - 1; bit >= 0; bit -= 1) {
      this.bits.push((value >>> bit) & 1);
    }
  }

  toCodewords() {
    const codewords = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      let codeword = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        codeword = (codeword << 1) | (this.bits[index + bit] ?? 0);
      }
      codewords.push(codeword);
    }
    return codewords;
  }
}

function drawFunctionPatterns(modules, reserved) {
  drawFinder(modules, reserved, 0, 0);
  drawFinder(modules, reserved, QR_SIZE - 7, 0);
  drawFinder(modules, reserved, 0, QR_SIZE - 7);
  drawAlignment(modules, reserved, 30, 30);
  drawTimingPatterns(modules, reserved);
  reserveFormatAreas(reserved);
  setFunctionModule(modules, reserved, 8, QR_VERSION * 4 + 9, true);
}

function drawFinder(modules, reserved, left, top) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const xx = left + x;
      const yy = top + y;
      if (!inBounds(xx, yy)) {
        continue;
      }

      const dark =
        x >= 0 &&
        x <= 6 &&
        y >= 0 &&
        y <= 6 &&
        (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      setFunctionModule(modules, reserved, xx, yy, dark);
    }
  }
}

function drawAlignment(modules, reserved, centerX, centerY) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const dark = Math.max(Math.abs(x), Math.abs(y)) !== 1;
      setFunctionModule(modules, reserved, centerX + x, centerY + y, dark);
    }
  }
}

function drawTimingPatterns(modules, reserved) {
  for (let offset = 8; offset < QR_SIZE - 8; offset += 1) {
    const dark = offset % 2 === 0;
    setFunctionModule(modules, reserved, offset, 6, dark);
    setFunctionModule(modules, reserved, 6, offset, dark);
  }
}

function reserveFormatAreas(reserved) {
  for (let index = 0; index <= 5; index += 1) {
    reserved[8][index] = true;
    reserved[index][8] = true;
  }
  reserved[8][7] = true;
  reserved[8][8] = true;
  reserved[7][8] = true;

  for (let index = 0; index < 8; index += 1) {
    reserved[8][QR_SIZE - 1 - index] = true;
  }
  for (let index = 8; index < 15; index += 1) {
    reserved[QR_SIZE - 15 + index][8] = true;
  }
}

function drawCodewords(modules, reserved, codewords) {
  const bits = codewords.flatMap((codeword) => {
    const value = [];
    for (let bit = 7; bit >= 0; bit -= 1) {
      value.push((codeword >>> bit) & 1);
    }
    return value;
  });

  let bitIndex = 0;
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

        let dark = (bits[bitIndex] ?? 0) === 1;
        if ((x + y) % 2 === 0) {
          dark = !dark;
        }
        modules[y][x] = dark;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function drawFormatBits(modules, reserved) {
  for (let bit = 0; bit < 15; bit += 1) {
    const dark = ((QR_FORMAT_L_MASK_0 >>> bit) & 1) === 1;

    if (bit < 6) {
      setFunctionModule(modules, reserved, 8, bit, dark);
    } else if (bit === 6) {
      setFunctionModule(modules, reserved, 8, 7, dark);
    } else if (bit === 7) {
      setFunctionModule(modules, reserved, 8, 8, dark);
    } else if (bit === 8) {
      setFunctionModule(modules, reserved, 7, 8, dark);
    } else {
      setFunctionModule(modules, reserved, 14 - bit, 8, dark);
    }

    if (bit < 8) {
      setFunctionModule(modules, reserved, QR_SIZE - 1 - bit, 8, dark);
    } else {
      setFunctionModule(modules, reserved, 8, QR_SIZE - 15 + bit, dark);
    }
  }
}

function setFunctionModule(modules, reserved, x, y, dark) {
  if (!inBounds(x, y)) {
    return;
  }
  modules[y][x] = dark;
  reserved[y][x] = true;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < QR_SIZE && y < QR_SIZE;
}

function reedSolomonRemainder(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const remainder = Array(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    for (let index = 0; index < degree - 1; index += 1) {
      remainder[index] = remainder[index + 1] ^ gfMultiply(generator[index + 1], factor);
    }
    remainder[degree - 1] = gfMultiply(generator[degree], factor);
  }

  return remainder;
}

function reedSolomonGenerator(degree) {
  let generator = [1];
  for (let index = 0; index < degree; index += 1) {
    generator = multiplyPolynomials(generator, [1, gfExp(index)]);
  }
  return generator;
}

function multiplyPolynomials(left, right) {
  const product = Array(left.length + right.length - 1).fill(0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      product[leftIndex + rightIndex] ^= gfMultiply(left[leftIndex], right[rightIndex]);
    }
  }
  return product;
}

function gfMultiply(left, right) {
  if (left === 0 || right === 0) {
    return 0;
  }
  const { exp, log } = gf();
  return exp[log[left] + log[right]];
}

function gfExp(value) {
  return gf().exp[value];
}

function gf() {
  if (gfTables) {
    return gfTables;
  }

  const exp = Array(512).fill(0);
  const log = Array(256).fill(0);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    log[value] = index;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  for (let index = 255; index < exp.length; index += 1) {
    exp[index] = exp[index - 255];
  }

  gfTables = { exp, log };
  return gfTables;
}

function modulePath(modules, margin) {
  const commands = [];
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules[y].length; x += 1) {
      if (modules[y][x]) {
        commands.push(`M${x + margin},${y + margin}h1v1h-1z`);
      }
    }
  }
  return commands.join("");
}
