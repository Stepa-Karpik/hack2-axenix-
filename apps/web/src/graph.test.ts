// @ts-nocheck -- Native Node test execution intentionally uses minimal API fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import {
  loopAreas,
  routeFlowEdges,
  routeOrthogonal,
  segmentHitsBox,
  visualKind,
  arrangeFlow,
} from "./flowLayout.ts";

test("loop exits lay out below repeated descendants without fabricating execution edges", () => {
  const node = (id, kind, parentId = null) => ({ id, kind, parentId });
  const nodes = [
    node("entry", "entry"),
    node("loop", "WhileStmt"),
    node("check", "condition_test", "loop"),
    node("body", "ExpressionStmt", "hidden"),
    node("back", "loop_back", "loop"),
    node("after", "ReturnStmt"),
  ];
  const edges = [
    { source: "entry", target: "loop", kind: "normal" },
    { source: "loop", target: "check", kind: "normal" },
    { source: "check", target: "body", kind: "true" },
    { source: "check", target: "after", kind: "false" },
    { source: "body", target: "back", kind: "normal" },
    { source: "back", target: "loop", kind: "loop" },
  ];
  const snapshot = JSON.stringify(edges);
  const positions = arrangeFlow(nodes, edges, [
    ...nodes,
    node("hidden", "block", "loop"),
  ]);
  assert.ok(positions.get("after").y > positions.get("back").y);
  assert.equal(JSON.stringify(edges), snapshot);
});

test("nested loop areas follow parent identities through hidden blocks", () => {
  const node = (id, kind, parentId = null) => ({ id, kind, parentId });
  const nodes = [
    node("outer", "ForEachStmt"),
    node("source", "foreach_source", "outer"),
    node("check", "foreach_check", "outer"),
    node("block", "block", "outer"),
    node("inner", "WhileStmt", "block"),
    node("body", "ExpressionStmt", "inner"),
  ];
  const box = (id, y) => ({ id, x: 0, y, width: 264, height: 60 });
  const areas = loopAreas(nodes, [
    box("outer", 0),
    box("source", 160),
    box("check", 320),
    box("inner", 480),
    box("body", 640),
  ]);
  assert.equal(areas.length, 2);
  assert.deepEqual(
    areas.find((area) => area.id === "loop-area:outer").members,
    ["check", "inner", "body"],
  );
  assert.deepEqual(
    areas.find((area) => area.id === "loop-area:inner").members,
    ["inner", "body"],
  );
  assert.equal(areas[0].members.includes("source"), false);
});

test("foreign nodes prevent misleading loop containment", () => {
  const nodes = [
    { id: "loop", kind: "WhileStmt", parentId: null },
    { id: "body", kind: "ExpressionStmt", parentId: "loop" },
    { id: "foreign", kind: "ReturnStmt", parentId: null },
  ];
  assert.deepEqual(
    loopAreas(nodes, [
      { id: "loop", x: 0, y: 0, width: 264, height: 60 },
      { id: "body", x: 0, y: 320, width: 264, height: 60 },
      { id: "foreign", x: 0, y: 160, width: 264, height: 60 },
    ]),
    [],
  );
});

test("unrelated returns receive distinct exterior lanes without changing edges", () => {
  const nodes = ["a", "b", "c"].map((id, index) => ({
    id,
    position: { x: 0, y: index * 160 },
  }));
  const edges = [
    { id: "inner", source: "c", target: "b", kind: "loop" },
    { id: "outer", source: "c", target: "a", kind: "loop" },
  ];
  const snapshot = JSON.stringify(edges);
  const routes = routeFlowEdges(nodes, edges);
  assert.notEqual(routes.get("inner"), routes.get("outer"));
  assert.ok(routes.get("outer") < routes.get("inner"));
  assert.equal(JSON.stringify(edges), snapshot);
});

test("right branch departures and target approaches retain their true ports", () => {
  const boxes = [
    { id: "source", x: 0, y: 0, width: 264, height: 84 },
    { id: "target", x: 320, y: 320, width: 264, height: 84 },
    { id: "obstacle", x: 320, y: 80, width: 264, height: 84 },
  ];
  const result = routeOrthogonal(
    { x: 264, y: 42 },
    { x: 452, y: 320 },
    640,
    boxes,
    22,
    "right",
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.points[1], { x: 286, y: 42 });
  assert.deepEqual(result.points.at(-2), { x: 452, y: 298 });
  for (let i = 1; i < result.points.length; i++)
    assert.ok(
      boxes.every(
        (box) => !segmentHitsBox(result.points[i - 1], result.points[i], box),
      ),
    );
});

test("semantic categories require unambiguous exact source containment", () => {
  const range = (startOffset, endOffset) => ({
    filePath: "Main.java",
    startOffset,
    endOffset,
  });
  const node = { kind: "ExpressionStmt", sourceRange: range(10, 20) };
  const semantics = {
    symbols: [],
    references: [{ kind: "call", sourceRange: range(10, 19) }],
  };
  assert.equal(visualKind(node, semantics), "call");
  assert.equal(
    visualKind(node, {
      ...semantics,
      references: [{ kind: "call", sourceRange: range(14, 19) }],
    }),
    "operation",
  );
  assert.equal(
    visualKind(node, {
      ...semantics,
      references: [...semantics.references, ...semantics.references],
    }),
    "operation",
  );
  assert.equal(
    visualKind(node, {
      symbols: [{ kind: "local", sourceRange: range(14, 16), external: false }],
      references: [],
    }),
    "variable",
  );
  assert.equal(visualKind({ ...node, label: "int x = call();" }), "operation");
});

test("ordinary find loop false paths have distinct corridors and no false join", () => {
  // Actual curated find topology: loop-test false exits to return -1; nested
  // if-test false goes to for_update. Different targets must not share a line.
  const box = (id, x, y, height = 84) => ({ id, x, y, width: 264, height });
  const boxes = [
    box("loopTest", 0, 384),
    box("ifHeader", 0, 512, 56),
    box("ifTest", 0, 640),
    box("update", -160, 768),
    box("returnFound", 160, 768),
    box("back", -160, 896, 56),
    box("returnMissing", 0, 1024),
  ];
  const nodes = boxes.map((b) => ({ id: b.id, position: { x: b.x, y: b.y } }));
  const edges = [
    {
      id: "outerFalse",
      source: "loopTest",
      target: "returnMissing",
      kind: "false",
    },
    { id: "innerFalse", source: "ifTest", target: "update", kind: "false" },
  ];
  const original = JSON.stringify(edges);
  const lanes = routeFlowEdges(nodes, edges);
  const paths = edges.map((edge) => {
    const source = boxes.find((b) => b.id === edge.source),
      target = boxes.find((b) => b.id === edge.target);
    const route = routeOrthogonal(
      { x: source.x + source.width, y: source.y + source.height / 2 },
      { x: target.x + target.width / 2, y: target.y },
      lanes.get(edge.id),
      boxes,
      22,
      "right",
    );
    assert.equal(route.complete, true);
    assert.ok(
      lanes.get(edge.id) > Math.max(...boxes.map((b) => b.x + b.width)),
    );
    route.points.slice(1).forEach((point, i) => {
      assert.ok(boxes.every((b) => !segmentHitsBox(route.points[i], point, b)));
    });
    return route.points.slice(1).map((point, i) => [route.points[i], point]);
  });
  const overlap = (a, b, c, d) => {
    const shared = (a1, a2, b1, b2) =>
      Math.min(Math.max(a1, a2), Math.max(b1, b2)) -
        Math.max(Math.min(a1, a2), Math.min(b1, b2)) >
      0.5;
    if (
      Math.abs(a.x - b.x) < 0.5 &&
      Math.abs(c.x - d.x) < 0.5 &&
      Math.abs(a.x - c.x) < 0.5
    )
      return shared(a.y, b.y, c.y, d.y);
    if (
      Math.abs(a.y - b.y) < 0.5 &&
      Math.abs(c.y - d.y) < 0.5 &&
      Math.abs(a.y - c.y) < 0.5
    )
      return shared(a.x, b.x, c.x, d.x);
    return false;
  };
  for (const [a, b] of paths[0])
    for (const [c, d] of paths[1])
      assert.equal(
        overlap(a, b, c, d),
        false,
        "Different false targets visually merge",
      );
  assert.equal(JSON.stringify(edges), original);
});
