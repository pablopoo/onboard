import assert from "node:assert/strict";
import test from "node:test";

import { copyText } from "./clipboard.js";

function createFakeDocument({ execResult = true } = {}) {
  const appended = [];
  const removed = [];
  const selected = [];

  return {
    appended,
    removed,
    selected,
    body: {
      append(element) {
        appended.push(element);
      },
    },
    createElement(tagName) {
      return {
        tagName,
        value: "",
        className: "",
        select() {
          selected.push(this);
        },
        remove() {
          removed.push(this);
        },
      };
    },
    execCommand(command) {
      assert.equal(command, "copy");
      return execResult;
    },
  };
}

test("copyText uses navigator clipboard when available", async () => {
  const writes = [];

  await copyText("http://local.test/viewer", {
    navigator: {
      clipboard: {
        writeText(value) {
          writes.push(value);
          return Promise.resolve();
        },
      },
    },
  });

  assert.deepEqual(writes, ["http://local.test/viewer"]);
});

test("copyText falls back to execCommand and cleans up the helper element", async () => {
  const document = createFakeDocument();

  await copyText("http://local.test/board", { document });

  assert.equal(document.appended.length, 1);
  assert.equal(document.appended[0].value, "http://local.test/board");
  assert.equal(document.appended[0].className, "sr-only");
  assert.deepEqual(document.selected, document.appended);
  assert.deepEqual(document.removed, document.appended);
});

test("copyText rejects when execCommand reports copy failure", async () => {
  const document = createFakeDocument({ execResult: false });

  await assert.rejects(
    copyText("http://local.test/board", { document }),
    /clipboard copy failed/i,
  );

  assert.deepEqual(document.removed, document.appended);
});

test("copyText rejects when no clipboard mechanism is available", async () => {
  await assert.rejects(
    copyText("http://local.test/board", { document: {} }),
    /clipboard copy unavailable/i,
  );
});
