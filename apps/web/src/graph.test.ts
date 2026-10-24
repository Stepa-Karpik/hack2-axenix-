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
  flowPorts,
  routePort,
  branchLabelPosition,
} from "./flowLayout.ts";

test("short condition branches leave toward their real targets without an exterior detour", () => {
  const source = { id: "check", x: 0, y: 0, width: 264, height: 84 };
  const targets = [
    { id: "return", x: -160, y: 128, width: 264, height: 84 },
    { id: "action", x: 160, y: 128, width: 264, height: 84 },
  ];
  const boxes = [source, ...targets];
  const original = JSON.stringify(boxes);
  targets.forEach((target, index) => {
    // Reversing yes/no never reverses geometry or changes edge provenance.
    for (const kind of ["true", "false"]) {
      const ports = flowPorts(source, target, kind);
      assert.equal(ports.sourceSide, index === 0 ? "left" : "right");
      const start = routePort(source, ports.sourceSide);
      const end = routePort(target, ports.targetSide);
      const label = branchLabelPosition(start, ports.sourceSide);
      const obstacles = [
        ...boxes,
        { id: "label", x: label.x - 15, y: label.y - 9, width: 30, height: 18 },
      ];
      const route = routeOrthogonal(
        start,
        end,
        2000,
        obstacles,
        22,
        ports.sourceSide,
        22,
        ports.targetSide,
        true,
      );
      assert.equal(route.complete, true);
      assert.deepEqual(route.points[1], {
        x: start.x + (index === 0 ? -22 : 22),
        y: start.y,
      });
      assert.ok(Math.max(...route.points.map((p) => p.x)) <= 424);
      assert.ok(Math.min(...route.points.map((p) => p.x)) >= -28);
      route.points
        .slice(1)
        .forEach((p, i) =>
          assert.ok(
            obstacles.every((box) => !segmentHitsBox(route.points[i], p, box)),
          ),
        );
    }
  });
  assert.equal(JSON.stringify(boxes), original);
});

test("same-level nodes accept side entry and upward loops keep an exterior corridor", () => {
  const source = { id: "source", x: 0, y: 0, width: 264, height: 84 };
  const target = { id: "target", x: 360, y: 0, width: 264, height: 84 };
  const ports = flowPorts(source, target, "normal");
  assert.deepEqual(ports, { sourceSide: "right", targetSide: "left" });
  const route = routeOrthogonal(
    routePort(source, ports.sourceSide),
    routePort(target, ports.targetSide),
    2000,
    [source, target],
    22,
    ports.sourceSide,
    22,
    ports.targetSide,
    true,
  );
  assert.equal(route.complete, true);
  assert.deepEqual(route.points.at(-2), { x: 338, y: 42 });
  assert.ok(route.points.every((p) => p.y === 42));
  assert.deepEqual(flowPorts({ ...source, y: 320 }, source, "loop"), {
    sourceSide: "left",
    targetSide: "left",
  });
});

test("compact obstacle routing minimizes canvas distance rather than grid hops", () => {
  const source = { id: "source", x: 0, y: 0, width: 264, height: 84 };
  const target = { id: "target", x: 500, y: 200, width: 264, height: 84 };
  const boxes = [
    source,
    target,
    { id: "across", x: 310, y: 10, width: 70, height: 100 },
    { id: "below", x: 260, y: 130, width: 100, height: 30 },
  ];
  const route = routeOrthogonal(
    { x: 264, y: 42 },
    { x: 632, y: 200 },
    2000,
    boxes,
    22,
    "right",
    22,
    "top",
    true,
  );
  assert.equal(route.complete, true);
  const length = route.points
    .slice(1)
    .reduce(
      (sum, p, i) =>
        sum +
        Math.abs(p.x - route.points[i].x) +
        Math.abs(p.y - route.points[i].y),
      0,
    );
  assert.ok(length <= 550, `Unnecessary route length: ${length}`);
  route.points
    .slice(1)
    .forEach((p, i) =>
      assert.ok(boxes.every((box) => !segmentHitsBox(route.points[i], p, box))),
    );
});

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

test("sibling branches follow their real true and false ports regardless of node order", () => {
  const nodes = [
    { id: "entry", kind: "entry" },
    { id: "check", kind: "condition_test" },
    { id: "falseReturn", kind: "ReturnStmt" },
    { id: "trueReturn", kind: "ReturnStmt" },
    { id: "exit", kind: "normal_exit" },
  ];
  const edges = [
    { source: "entry", target: "check", kind: "normal" },
    { source: "check", target: "falseReturn", kind: "false" },
    { source: "check", target: "trueReturn", kind: "true" },
    { source: "trueReturn", target: "exit", kind: "normal" },
    { source: "falseReturn", target: "exit", kind: "normal" },
  ];
  const before = JSON.stringify(edges);
  const positions = arrangeFlow(nodes, edges);
  assert.ok(positions.get("trueReturn").x < positions.get("falseReturn").x);
  assert.equal(positions.get("trueReturn").y, positions.get("falseReturn").y);
  assert.equal(JSON.stringify(edges), before);
});

test("separate forward guards reuse local corridors without drifting across the canvas", () => {
  const nodes = [],
    edges = [];
  for (let i = 0; i < 40; i++) {
    nodes.push(
      { id: "check" + i, position: { x: 0, y: i * 320 } },
      { id: "next" + i, position: { x: 320, y: i * 320 + 128 } },
    );
    edges.push({
      id: "false" + i,
      source: "check" + i,
      target: "next" + i,
      kind: "false",
    });
  }
  const routes = [...routeFlowEdges(nodes, edges).values()];
  assert.equal(routes.length, 40);
  assert.equal(new Set(routes).size, 1);
  assert.ok(routes[0] >= 286 && routes[0] <= 500);
});

test("adjacent return branches merge directly into their real shared exit", () => {
  const nodes = [
    { id: "left", position: { x: -160, y: 0 }, data: { kind: "ReturnStmt" } },
    { id: "right", position: { x: 160, y: 0 }, data: { kind: "ReturnStmt" } },
    { id: "exit", position: { x: 0, y: 128 } },
  ];
  assert.equal(
    routeFlowEdges(nodes, [
      { id: "a", source: "left", target: "exit", kind: "normal" },
      { id: "b", source: "right", target: "exit", kind: "normal" },
    ]).size,
    0,
  );
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
    assert.ok(lanes.get(edge.id) > source.x + source.width);
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

test("rounded routes preserve endpoints and bound corner radii", async () => {
  const { roundedRoute } = await import("./flowLayout.ts");
  assert.equal(roundedRoute([]), "");
  assert.equal(
    roundedRoute([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]),
    "M 0 0 L 100 0",
  );
  assert.equal(
    roundedRoute(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      20,
    ),
    "M 0 0 L 80 0 Q 100 0 100 20 L 100 100",
  );
  assert.equal(
    roundedRoute([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]),
    "M 0 0 L 10 10",
  );
});

test("smoothing never cuts a clear route's tangent obstacle corner", async () => {
  const { roundedRoute } = await import("./flowLayout.ts");
  const points = [
    { x: 20, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 20 },
  ];
  assert.equal(
    roundedRoute(points, 16, [
      { id: "block", x: 0, y: 0, width: 20, height: 20 },
    ]),
    "M 20 0 L 0 0 L 0 20",
  );
});

test("sequential steps retain one readable top-to-bottom lane", () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    kind: i === 0 ? "entry" : "ExpressionStmt",
    executionRole: i === 0 ? "structural" : "statement",
    parentId: null,
  }));
  const edges = nodes
    .slice(1)
    .map((n, i) => ({ source: String(i), target: n.id, kind: "normal" }));
  const positions = arrangeFlow(nodes, edges);
  const points = nodes.map((n) => positions.get(n.id)!);
  assert.equal(new Set(points.map((p) => p.x)).size, 1);
  for (let i = 1; i < points.length; i++)
    assert.ok(points[i].y - points[i - 1].y >= 128);
});
