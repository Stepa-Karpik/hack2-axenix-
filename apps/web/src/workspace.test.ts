// @ts-nocheck -- Native Node test runner; browser app has no Node type dependency.
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
} from "./workspaceLayout.ts";

test("all presets contain each stable panel once and serialize", () => {
  for (const preset of ["default", "code", "review"] as const) {
    const layout = defaultLayout(preset);
    assert.ok(validateLayout(JSON.parse(JSON.stringify(layout))));
    assert.deepEqual(visiblePanels(layout).sort(), [...panelIds].sort());
  }
});
test("center drop swaps panel identities without losing tabs", () => {
  const before = defaultLayout();
  const after = movePanel(before, "graph", "code", "center");
  assert.deepEqual(groups(after.root).find((g) => g.id === "code")?.tabs, [
    "graph",
  ]);
  assert.deepEqual(groups(after.root).find((g) => g.id === "graph")?.tabs, [
    "code",
  ]);
  assert.ok(validateLayout(after));
  assert.deepEqual(before, defaultLayout());
});
test("edge docking collapses empty source and preserves every panel", () => {
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    const after = movePanel(defaultLayout(), "project", "graph", edge);
    assert.ok(validateLayout(after));
    assert.deepEqual(visiblePanels(after).sort(), [...panelIds].sort());
    assert.equal(
      groups(after.root).filter((g) => g.tabs.includes("project")).length,
      1,
    );
  }
});
test("tab can be split away from its own group", () => {
  const after = movePanel(defaultLayout(), "tests", "output", "left");
  assert.ok(validateLayout(after));
  assert.equal(
    groups(after.root).find((g) => g.tabs.includes("tests"))?.tabs.length,
    1,
  );
  assert.deepEqual(groups(after.root).find((g) => g.id === "output")?.tabs, [
    "console",
    "changes",
  ]);
});
test("hide collapses branches, reveal restores hidden panel, last panel survives", () => {
  let layout = defaultLayout();
  for (const panel of panelIds.filter((p) => p !== "graph"))
    layout = hidePanel(layout, panel);
  assert.deepEqual(visiblePanels(layout), ["graph"]);
  assert.deepEqual(hidePanel(layout, "graph"), layout);
  const shown = revealPanel(layout, "code");
  assert.deepEqual(visiblePanels(shown), ["graph", "code"]);
  assert.equal(groups(shown.root)[0].active, "code");
  assert.ok(validateLayout(shown));
});
test("revealing an existing tab activates it without duplicates", () => {
  const after = revealPanel(defaultLayout(), "tests");
  assert.equal(
    groups(after.root).find((g) => g.id === "output")?.active,
    "tests",
  );
  assert.equal(visiblePanels(after).filter((p) => p === "tests").length, 1);
});
test("resize clamps ratios and rejects nonfinite inputs", () => {
  for (const ratio of [-1, 0, 0.4, 1, 100]) {
    const after = resizeSplit(defaultLayout(), "root", ratio);
    assert.ok(validateLayout(after));
    assert.equal(
      after.root.type === "split" && after.root.ratio,
      Math.max(0.15, Math.min(0.85, ratio)),
    );
  }
  assert.deepEqual(resizeSplit(defaultLayout(), "root", NaN), defaultLayout());
});
test("persisted data rejects unknown version, panel, duplicates, IDs, active tab and ratios", () => {
  const invalid = [
    null,
    {},
    { version: 2, root: defaultLayout().root },
    {
      version: 1,
      root: { type: "group", id: "g", tabs: ["bogus"], active: "bogus" },
    },
    {
      version: 1,
      root: { type: "group", id: "g", tabs: ["code", "code"], active: "code" },
    },
    { version: 1, root: { type: "group", id: "g", tabs: [], active: "code" } },
    {
      version: 1,
      root: { type: "group", id: "g", tabs: ["code"], active: "graph" },
    },
    { version: 1, root: { ...defaultLayout().root, ratio: Infinity } },
    { version: 1, root: { ...defaultLayout().root, ratio: 0.99 } },
  ];
  for (const value of invalid) assert.equal(validateLayout(value), false);
  const duplicated = defaultLayout();
  if (duplicated.root.type === "split")
    duplicated.root.second.id = duplicated.root.first.id;
  assert.equal(validateLayout(duplicated), false);
});
test("invalid targets and a one-panel self drop leave layout untouched", () => {
  const before = defaultLayout();
  assert.deepEqual(movePanel(before, "code", "missing", "left"), before);
  assert.deepEqual(movePanel(before, "code", "code", "left"), before);
});

test("tab merge removes empty source and keeps target tabs in order", () => {
  const after = movePanel(defaultLayout(), "graph", "output", "tabs");
  assert.ok(validateLayout(after));
  const target = groups(after.root).find((g) => g.id === "output");
  assert.deepEqual(target?.tabs, ["console", "tests", "changes", "graph"]);
  assert.equal(target?.active, "graph");
  assert.equal(
    groups(after.root).some((g) => g.id === "graph"),
    false,
  );
  assert.deepEqual(visiblePanels(after).sort(), [...panelIds].sort());
});
test("legacy preferences migrate but corrupt new layouts default safely", async () => {
  const { readLayout, layoutKey } = await import("./workspaceLayout.ts");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  try {
    values.set(
      "java-blueprints:view:p",
      JSON.stringify({ mode: "graph", inspector: false }),
    );
    const migrated = readLayout("p");
    assert.equal(visiblePanels(migrated).includes("code"), false);
    assert.equal(visiblePanels(migrated).includes("analysis"), false);
    assert.ok(validateLayout(migrated));
    values.set(layoutKey("p"), JSON.stringify(defaultLayout("review")));
    assert.deepEqual(readLayout("p"), defaultLayout("review"));
    values.set(layoutKey("p"), "{invalid");
    assert.deepEqual(readLayout("p"), defaultLayout());
    values.set(layoutKey("p"), '{"version":9}');
    assert.deepEqual(readLayout("p"), defaultLayout());
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
