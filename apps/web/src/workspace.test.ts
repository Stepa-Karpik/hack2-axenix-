// @ts-nocheck -- Native Node test runner.
import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultLayout,
  groups,
  hidePanel,
  movePanel,
  panelIds,
  resizeSplit,
  revealPanel,
  validateLayout,
  visiblePanels,
  visibleRoot,
  readLayout,
  layoutKey,
} from "./workspaceLayout.ts";
import { tileGeometry, tileDrop } from "./tileGeometry.ts";
const all = (l) =>
  groups(l.root)
    .flatMap((g) => g.tabs)
    .sort();
test("presets retain every panel exactly once, including hidden slots", () => {
  for (const name of ["default", "code", "review"]) {
    const l = defaultLayout(name);
    assert.ok(validateLayout(JSON.parse(JSON.stringify(l))));
    assert.deepEqual(all(l), [...panelIds].sort());
  }
});
test("canvas cannot be hidden, dragged or merged into an output tile", () => {
  const l = defaultLayout();
  assert.deepEqual(hidePanel(l, "graph"), l);
  for (const edge of ["center", "left", "right", "top", "bottom", "tabs"])
    assert.deepEqual(movePanel(l, "graph", "output", edge), l);
});
test("center drop swaps ordinary windows and preserves hidden tab slots", () => {
  const l = defaultLayout(),
    moved = movePanel(l, "code", "analysis", "center");
  assert.equal(
    groups(moved.root).find((g) => g.id === "analysis").active,
    "code",
  );
  assert.equal(
    groups(moved.root).find((g) => g.id === "code").active,
    "analysis",
  );
  assert.deepEqual(all(moved), all(l));
  assert.deepEqual(moved.hidden, l.hidden);
  assert.deepEqual(l, defaultLayout());
});
test("edge docking, tab merge and self split preserve source identities", () => {
  for (const edge of ["left", "right", "top", "bottom", "tabs"]) {
    const moved = movePanel(defaultLayout(), "code", "graph", edge);
    assert.ok(validateLayout(moved));
    assert.deepEqual(all(moved), [...panelIds].sort());
  }
  const tab = movePanel(
    revealPanel(defaultLayout(), "tests"),
    "tests",
    "output",
    "left",
  );
  assert.equal(
    groups(tab.root).find((g) => g.tabs.includes("tests")).tabs.length,
    1,
  );
  assert.deepEqual(
    movePanel(defaultLayout(), "code", "missing", "left"),
    defaultLayout(),
  );
});
test("hide and reveal preserve the exact slot, split ratios and active tab after JSON reload", () => {
  let l = resizeSplit(defaultLayout(), "bottom", 0.47);
  l = movePanel(l, "analysis", "code", "center");
  const root = structuredClone(l.root);
  const hidden = hidePanel(l, "analysis");
  assert.deepEqual(hidden.root, root);
  assert.ok(!visiblePanels(hidden).includes("analysis"));
  const restored = revealPanel(JSON.parse(JSON.stringify(hidden)), "analysis");
  assert.deepEqual(restored.root, root);
  assert.deepEqual(restored.hidden, l.hidden);
});
test("all tools may be hidden while perpetual canvas remains and restoring any tool uses its original slot", () => {
  let l = defaultLayout();
  for (const p of panelIds) l = hidePanel(l, p);
  assert.deepEqual(visiblePanels(l), ["graph"]);
  assert.equal(visibleRoot(l).active, "graph");
  const shown = revealPanel(l, "code");
  assert.deepEqual(visiblePanels(shown), ["graph", "code"]);
  assert.equal(
    groups(shown.root).find((g) => g.tabs.includes("code")).id,
    "code",
  );
});
test("resize clamps hostile inputs and hidden ratios remain reserved", () => {
  const l = hidePanel(defaultLayout(), "code");
  for (const ratio of [-1, 0, 0.4, 1, 100]) {
    const a = resizeSplit(l, "root", ratio);
    assert.ok(validateLayout(a));
    assert.equal(a.root.ratio, Math.max(0.15, Math.min(0.85, ratio)));
    assert.deepEqual(a.hidden, l.hidden);
  }
  assert.deepEqual(resizeSplit(l, "root", NaN), l);
});
test("validation rejects corrupt hidden state, unknown panels, repeated IDs and deep data", () => {
  const l = defaultLayout();
  for (const value of [
    null,
    {},
    { ...l, version: 2 },
    { ...l, hidden: ["graph"] },
    { ...l, hidden: ["code", "code"] },
    { ...l, hidden: ["alien"] },
    { ...l, root: { ...l.root, ratio: 0.99 } },
    {
      ...l,
      root: { type: "group", id: "x", tabs: ["code", "code"], active: "code" },
    },
  ])
    assert.equal(validateLayout(value), false);
});
test("tiling geometry remains inside its reserved area and never overlaps after moves or hide/reveal", () => {
  const bounds = { x: 12, y: 78, width: 1512, height: 864 };
  const variants = [
    defaultLayout(),
    ...["left", "right", "top", "bottom", "center", "tabs"].map((e) =>
      movePanel(defaultLayout(), "code", "analysis", e),
    ),
    hidePanel(defaultLayout(), "analysis"),
  ];
  for (const l of variants) {
    const tiles = tileGeometry(visibleRoot(l), bounds).tiles;
    for (let i = 0; i < tiles.length; i++) {
      const a = tiles[i].rect;
      assert.ok(
        a.x >= bounds.x &&
          a.y >= bounds.y &&
          a.x + a.width <= bounds.x + bounds.width + 0.001 &&
          a.y + a.height <= bounds.y + bounds.height + 0.001,
      );
      for (let j = i + 1; j < tiles.length; j++) {
        const b = tiles[j].rect;
        assert.ok(
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <=
            0.001 ||
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <=
              0.001,
        );
      }
    }
  }
});
test("drop intent uses nearby edges and leaves a calm center swap region", () => {
  const r = { x: 50, y: 50, width: 500, height: 400 };
  assert.equal(tileDrop(r, 55, 250), "left");
  assert.equal(tileDrop(r, 545, 250), "right");
  assert.equal(tileDrop(r, 250, 55), "top");
  assert.equal(tileDrop(r, 250, 445), "bottom");
  assert.equal(tileDrop(r, 250, 250), "center");
});
test("project scoped persistence migrates v1 and survives unavailable or corrupted storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k) => values.get(k) ?? null },
  });
  try {
    assert.notEqual(layoutKey("one"), layoutKey("two"));
    const custom = hidePanel(
      resizeSplit(defaultLayout(), "root", 0.3),
      "console",
    );
    values.set(layoutKey("one"), JSON.stringify(custom));
    assert.deepEqual(readLayout("one"), custom);
    assert.deepEqual(readLayout("two"), defaultLayout());
    values.set("java-blueprints:workspace:v1:old", JSON.stringify(custom));
    assert.deepEqual(readLayout("old"), custom);
    values.set(layoutKey("one"), "{bad");
    assert.deepEqual(readLayout("one"), defaultLayout());
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw Error("disabled");
      },
    });
    assert.deepEqual(readLayout("one"), defaultLayout());
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("swap uses the visible tab rather than a hidden remembered active tab", () => {
  let l = revealPanel(defaultLayout(), "tests");
  l = hidePanel(l, "tests");
  const moved = movePanel(l, "code", "output", "center");
  assert.equal(
    groups(visibleRoot(moved)).find((g) => g.id === "code").active,
    "console",
  );
  assert.equal(
    groups(visibleRoot(moved)).find((g) => g.id === "output").active,
    "code",
  );
});
test("dock activation distinguishes inactive tabs from shown windows", async () => {
  const { activePanels } = await import("./workspaceLayout.ts");
  const l = revealPanel(defaultLayout(), "tests");
  assert.ok(visiblePanels(l).includes("console"));
  assert.ok(!activePanels(l).includes("console"));
  assert.ok(activePanels(l).includes("tests"));
});

test("both pointer and keyboard docking reject a split that cannot hold two usable panes", async () => {
  const { canDockTile } = await import("./tileGeometry.ts");
  const rect = { x: 0, y: 0, width: 300, height: 200 };
  assert.equal(canDockTile(rect, "left"), false);
  assert.equal(canDockTile(rect, "bottom"), false);
  assert.equal(canDockTile(rect, "center"), true);
  assert.equal(
    canDockTile({ ...rect, width: 368, height: 248 }, "right"),
    true,
  );
});
