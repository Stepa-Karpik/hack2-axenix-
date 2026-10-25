// @ts-nocheck -- executed with native Node TypeScript stripping.
import test from "node:test";
import assert from "node:assert/strict";
import { GraphHistory, graphHistoryShortcut } from "./graphHistory.ts";
test("whole group undo/redo retains independent snapshots and new drag clears redo", () => {
  const h = new GraphHistory();
  const a = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 10 },
  ];
  const b = a.map((p) => ({ ...p, x: p.x + 30 }));
  h.commit(a, b);
  a[0].x = 999;
  assert.deepEqual(h.undo(b), [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 10 },
  ]);
  assert.deepEqual(
    h.redo([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 10 },
    ]),
    b,
  );
  const old = h.undo(b);
  h.commit(
    old,
    old.map((p) => ({ ...p, y: 50 })),
  );
  assert.equal(h.redo(old), null);
  h.clear();
  assert.equal(h.undo(b), null);
});
test("history no-op and bounded history, English/Russian physical shortcut", () => {
  const h = new GraphHistory(1),
    a = [{ id: "a", x: 0, y: 0 }],
    b = [{ id: "a", x: 1, y: 0 }],
    c = [{ id: "a", x: 2, y: 0 }];
  h.commit(a, a);
  assert.equal(h.undo(a), null);
  h.commit(a, b);
  h.commit(b, c);
  assert.deepEqual(h.undo(c), b);
  assert.equal(h.undo(b), null);
  const e = {
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    key: "я",
    code: "KeyZ",
  };
  assert.equal(graphHistoryShortcut(e), "undo");
  assert.equal(graphHistoryShortcut({ ...e, shiftKey: true }), "redo");
  assert.equal(graphHistoryShortcut({ ...e, altKey: true }), null);
});
