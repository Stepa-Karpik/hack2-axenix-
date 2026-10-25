// @ts-nocheck -- Native Node test execution intentionally uses minimal API fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import {
  planFlowRoutes,
  BRANCH_BADGE,
  validOverviewPositions,
} from "./flowRouting.ts";

const crossesInterior = (a, b, r) =>
  a.x === b.x
    ? a.x > r.x + 0.5 &&
      a.x < r.x + r.width - 0.5 &&
      Math.max(a.y, b.y) > r.y + 0.5 &&
      Math.min(a.y, b.y) < r.y + r.height - 0.5
    : a.y === b.y &&
      a.y > r.y + 0.5 &&
      a.y < r.y + r.height - 0.5 &&
      Math.max(a.x, b.x) > r.x + 0.5 &&
      Math.min(a.x, b.x) < r.x + r.width - 0.5;
test("manual screenshot geometry stays fixed while short routes keep real endpoints and avoid bodies", () => {
  const boxes = [
    { id: "entry", x: 900, y: 20, width: 264, height: 84 },
    { id: "first", x: 40, y: 260, width: 264, height: 84 },
    { id: "second", x: 350, y: -80, width: 264, height: 84 },
    { id: "exit", x: 40, y: 530, width: 264, height: 84 },
  ];
  const edges = [
    { id: "a", source: "entry", target: "first", kind: "normal" },
    { id: "b", source: "first", target: "second", kind: "normal" },
    { id: "c", source: "second", target: "exit", kind: "normal" },
  ];
  const frozen = JSON.stringify({ boxes, edges }),
    result = planFlowRoutes(boxes, edges);
  assert.equal(result.routes.size, 3);
  for (const edge of edges) {
    const route = result.routes.get(edge.id);
    assert.equal(route.complete, true);
    const source = boxes.find((b) => b.id === edge.source),
      target = boxes.find((b) => b.id === edge.target);
    const start = route.points[0],
      end = route.points.at(-1);
    assert.ok(
      start.x >= source.x &&
        start.x <= source.x + source.width &&
        start.y >= source.y &&
        start.y <= source.y + source.height,
    );
    assert.ok(
      end.x >= target.x &&
        end.x <= target.x + target.width &&
        end.y >= target.y &&
        end.y <= target.y + target.height,
    );
    route.points
      .slice(1)
      .forEach((p, i) =>
        result.obstacles.forEach((r) =>
          assert.equal(crossesInterior(route.points[i], p, r), false),
        ),
      );
    assert.ok(route.points.every((p) => p.x >= -60 && p.x <= 1260));
  }
  assert.equal(JSON.stringify({ boxes, edges }), frozen);
});
test("branch badges are legible and the jointly rendered routes clear their full reserved rectangles", () => {
  const boxes = [
    { id: "check", x: 0, y: 0, width: 264, height: 84 },
    { id: "yes", x: -170, y: 170, width: 264, height: 84 },
    { id: "no", x: 180, y: 170, width: 264, height: 84 },
  ];
  const edges = [
    { id: "yesEdge", source: "check", target: "yes", kind: "true" },
    { id: "noEdge", source: "check", target: "no", kind: "false" },
  ];
  const result = planFlowRoutes(boxes, edges);
  assert.deepEqual(BRANCH_BADGE, { width: 44, height: 26 });
  for (const edge of edges) {
    const route = result.routes.get(edge.id);
    assert.equal(route.complete, true);
    assert.ok(route.label);
    assert.equal(route.label.width, 44);
    assert.equal(route.label.height, 26);
    assert.ok(edge.kind === "true" ? route.label.x < 0 : route.label.x > 264);
    route.points
      .slice(1)
      .forEach((p, i) =>
        result.obstacles.forEach((r) =>
          assert.equal(crossesInterior(route.points[i], p, r), false),
        ),
      );
  }
  assert.notDeepEqual(
    result.routes.get("yesEdge").points[1],
    result.routes.get("noEdge").points[1],
  );
});
test("blocked manual stem reports a limited route without relocating the source", () => {
  const boxes = [
    { id: "a", x: 0, y: 0, width: 264, height: 84 },
    { id: "b", x: 0, y: 150, width: 264, height: 84 },
    { id: "blocked", x: -20, y: 70, width: 310, height: 70 },
  ];
  const result = planFlowRoutes(boxes, [
    { id: "edge", source: "a", target: "b", kind: "normal" },
  ]);
  assert.equal(result.routes.get("edge").complete, false);
  assert.deepEqual(result.routes.get("edge").points[0], { x: 132, y: 84 });
});
test("overview snapshot requires all exact real bindings and finite unique final positions", () => {
  const binding = new Map([
    ["a", "one"],
    ["b", "two"],
    ["c", "two"],
  ]);
  const positions = [
    { nodeId: "a", methodId: "one", x: 10, y: 20 },
    { nodeId: "b", methodId: "two", x: 30, y: 40 },
    { nodeId: "c", methodId: "two", x: 50, y: 60 },
  ];
  assert.equal(validOverviewPositions(positions, binding), true);
  for (const bad of [
    positions.slice(1),
    [positions[0], positions[0], positions[2]],
    positions.map((p) => ({ ...p, methodId: "wrong" })),
    positions.map((p) => ({ ...p, x: NaN })),
    positions.map((p) => ({ ...p, nodeId: p.nodeId + "old" })),
  ])
    assert.equal(validOverviewPositions(bad, binding), false);
  const moved = positions.map((p) => ({ ...p, x: p.x + 17, y: p.y - 9 }));
  assert.equal(validOverviewPositions(moved, binding), true);
  assert.equal(moved[1].x - moved[0].x, positions[1].x - positions[0].x);
});
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
  methodViewKey,
  stableNodeKeys,
  placeManualFlow,
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

test("method camera identity survives analysis IDs and source shifts but isolates declarations and projects", () => {
  const method = {
    id: "old",
    sourceRange: { filePath: "Main.java", startOffset: 10 },
    fullyQualifiedName: "Main.answer",
    signature: "answer(boolean)",
  };
  const key = methodViewKey("project", method, method.id);
  assert.equal(
    methodViewKey(
      "project",
      {
        ...method,
        id: "new",
        sourceRange: { ...method.sourceRange, startOffset: 200 },
      },
      "new",
    ),
    key,
  );
  for (const changed of [
    { ...method, signature: "answer(int)" },
    { ...method, fullyQualifiedName: "Other.answer" },
    { ...method, sourceRange: { filePath: "Other.java" } },
  ])
    assert.notEqual(methodViewKey("project", changed, "other"), key);
  assert.notEqual(methodViewKey("other-project", method, method.id), key);
});

test("manual positions migrate only unambiguous node identities across regenerated IDs and block body changes", () => {
  const before = [
    { id: "entry", kind: "entry", label: "old method body", parentId: null },
    { id: "block", kind: "block", label: "old block body", parentId: "entry" },
    { id: "return", kind: "ReturnStmt", label: "return 1;", parentId: "block" },
  ];
  const after = before.map((node) => ({
    ...node,
    id: "new-" + node.id,
    parentId: node.parentId ? "new-" + node.parentId : null,
    label: node.kind === "ReturnStmt" ? node.label : "changed body",
  }));
  const oldKeys = stableNodeKeys(before),
    newKeys = stableNodeKeys(after);
  assert.equal(oldKeys.get("return"), newKeys.get("new-return"));
  const repeated = stableNodeKeys([
    ...before,
    { ...before[2], id: "other-return" },
  ]);
  assert.equal(repeated.has("return"), false);
  assert.equal(repeated.has("other-return"), false);
});

test("vertically aligned saved branch targets retain distinct side ports and labels", () => {
  const source = { id: "condition", x: 0, y: 0, width: 264, height: 84 };
  const target = { id: "return", x: 0, y: 180, width: 264, height: 84 };
  const yes = flowPorts(source, target, "true"),
    no = flowPorts(source, target, "false");
  assert.equal(yes.sourceSide, "left");
  assert.equal(no.sourceSide, "right");
  assert.notDeepEqual(
    branchLabelPosition(routePort(source, yes.sourceSide), yes.sourceSide),
    branchLabelPosition(routePort(source, no.sourceSide), no.sourceSide),
  );
  for (const ports of [yes, no]) {
    const route = routeOrthogonal(
      routePort(source, ports.sourceSide),
      routePort(target, ports.targetSide),
      400,
      [source, target],
      22,
      ports.sourceSide,
      22,
      ports.targetSide,
      true,
    );
    assert.equal(route.complete, true);
    for (let i = 1; i < route.points.length; i++)
      assert.ok(
        [source, target].every(
          (box) => !segmentHitsBox(route.points[i - 1], route.points[i], box),
        ),
      );
  }
});

test("resource protocol nodes preserve restrained operation categories", () => {
  for (const [kind, expected] of Object.entries({
    resource_init: "variable",
    resource_close: "call",
    resource_check: "condition",
    resource_suppression_check: "condition",
    resource_primary: "return",
    resource_suppress: "return",
    resource_throw: "return",
    resource_resume: "structure",
  }))
    assert.equal(visualKind({ kind }), expected);
});

test("structural reanalysis reflows automatic nodes and preserves only the dragged node", () => {
  const previous = new Map([
    ["entry", { x: 0, y: 0 }],
    ["markA", { x: 0, y: 128 }],
    ["ifFalse", { x: 0, y: 256 }],
    ["exit", { x: 0, y: 384 }],
  ]);
  const wrapped = new Map([
    ["entry", { x: 0, y: 0 }],
    ["markA", { x: 0, y: 128 }],
    ["newLoopCheck", { x: 0, y: 256 }],
    ["ifFalse", { x: 0, y: 384 }],
    ["exit", { x: 0, y: 512 }],
  ]);
  const manuallyMoved = new Map([["markA", { x: 100, y: 148 }]]);
  const placed = placeManualFlow(wrapped, manuallyMoved);
  assert.deepEqual(placed.get("markA"), { x: 100, y: 148 });
  assert.deepEqual(placed.get("ifFalse"), wrapped.get("ifFalse"));
  assert.notDeepEqual(placed.get("ifFalse"), previous.get("ifFalse"));
  assert.notDeepEqual(placed.get("ifFalse"), placed.get("newLoopCheck"));
  assert.deepEqual(previous.get("ifFalse"), { x: 0, y: 256 });
});

test("new automatic rows avoid retained manual nodes without moving the manual layout or reversing later ranks", () => {
  const automatic = new Map([
    ["entry", { x: 0, y: 0 }],
    ["moved", { x: 0, y: 128 }],
    ["newCheck", { x: 0, y: 256 }],
    ["ifFalse", { x: 0, y: 384 }],
    ["exit", { x: 0, y: 512 }],
  ]);
  const manual = new Map([
    ["moved", { x: 0, y: 256 }],
    ["removed", { x: 0, y: 640 }],
  ]);
  const snapshot = JSON.stringify([...automatic]);
  const placed = placeManualFlow(automatic, manual);
  assert.deepEqual(placed.get("moved"), { x: 0, y: 256 });
  assert.equal(placed.has("removed"), false);
  assert.ok(placed.get("newCheck").y > 256);
  assert.ok(placed.get("ifFalse").y > placed.get("newCheck").y);
  assert.ok(placed.get("exit").y > placed.get("ifFalse").y);
  const boxes = [...placed].map(([id, p]) => ({ id, ...p }));
  for (let i = 0; i < boxes.length; i++)
    for (const other of boxes.slice(i + 1))
      assert.ok(
        Math.abs(boxes[i].x - other.x) >= 264 ||
          Math.abs(boxes[i].y - other.y) >= 84,
      );
  assert.equal(JSON.stringify([...automatic]), snapshot);
});

// Disposable insertion scenes retain actual IDs/source bindings and immutable bases.
import { previewScene, baseNodeAt } from "./flowPreview.ts";
function previewFixture() {
  const sourceNodes = [
    {
      id: "entry",
      methodId: "m",
      kind: "entry",
      parentId: null,
      allowedOperations: ["insert_statement"],
      insertionPositions: ["body_start", "body_end"],
    },
    {
      id: "one",
      methodId: "m",
      kind: "ExpressionStmt",
      parentId: "entry",
      sourceRange: { startOffset: 10, endOffset: 20 },
      allowedOperations: ["insert_statement"],
      insertionPositions: ["before", "after"],
    },
    {
      id: "two",
      methodId: "m",
      kind: "ExpressionStmt",
      parentId: "entry",
      sourceRange: { startOffset: 21, endOffset: 30 },
    },
    { id: "exit", methodId: "m", kind: "normal_exit", parentId: null },
    { id: "foreign", methodId: "other", kind: "entry", parentId: null },
  ].map((n) => ({ ...n, revisionId: "r", analysisId: "a" }));
  const nodes = sourceNodes.map((n, i) => ({
    id: n.id,
    position: { x: i === 4 ? 900 : 40, y: i * 160 },
    data: { binding: n.id },
  }));
  return {
    nodes,
    graph: {
      nodes: sourceNodes,
      revisionId: "r",
      analysisId: "a",
      edges: [
        { id: "e1", source: "entry", target: "one" },
        { id: "e2", source: "one", target: "two" },
        { id: "e3", source: "two", target: "exit" },
      ],
    },
  };
}
test("preview inserts a display gap in one real method without changing input positions, IDs or source graph", () => {
  const f = previewFixture(),
    before = JSON.stringify(f);
  const result = previewScene(f.nodes, f.graph, {
    kind: "condition",
    anchorNodeId: "one",
    position: "before",
  });
  assert.ok(result);
  assert.deepEqual(
    result.nodes.map((n) => n.id),
    f.nodes.map((n) => n.id),
  );
  assert.ok(
    result.nodes.find((n) => n.id === "one").position.y > f.nodes[1].position.y,
  );
  assert.deepEqual(
    result.nodes.find((n) => n.id === "entry"),
    f.nodes[0],
  );
  assert.deepEqual(
    result.nodes.find((n) => n.id === "foreign"),
    f.nodes[4],
  );
  assert.ok(result.connectors.length === 2);
  assert.equal(JSON.stringify(f), before);
  assert.equal(previewScene(f.nodes, f.graph, null), null);
  assert.deepEqual(f.nodes[1].position, { x: 40, y: 160 });
});
test("preview resolves before/after and entry body slots while cancellation, invalid scope and unavailable edits return the base", () => {
  const f = previewFixture();
  for (const position of ["before", "after"]) {
    const s = previewScene(f.nodes, f.graph, {
      kind: "statement",
      anchorNodeId: "one",
      position,
    });
    assert.ok(s);
    assert.equal(s.shiftedIds.has("one"), position === "before");
    assert.equal(s.shiftedIds.has("two"), true);
  }
  for (const position of ["body_start", "body_end"]) {
    const s = previewScene(f.nodes, f.graph, {
      kind: "loop",
      anchorNodeId: "entry",
      position,
    });
    assert.ok(s);
    assert.equal(s.shiftedIds.has("one"), position === "body_start");
    assert.equal(s.shiftedIds.has("exit"), true);
  }
  const request = {
    kind: "statement",
    anchorNodeId: "one",
    position: "before",
  };
  assert.equal(previewScene(f.nodes, f.graph, request, true), null);
  assert.equal(
    previewScene(f.nodes, { ...f.graph, analysisId: "new" }, request),
    null,
  );
  assert.equal(
    previewScene(f.nodes, { ...f.graph, revisionId: "new" }, request),
    null,
  );
  assert.equal(
    previewScene(
      f.nodes.filter((n) => n.id === "foreign"),
      f.graph,
      request,
    ),
    null,
  );
  assert.equal(
    previewScene(f.nodes, f.graph, { ...request, position: "body_start" }),
    null,
  );
  assert.equal(
    previewScene(f.nodes, f.graph, { ...request, anchorNodeId: "two" }),
    null,
  );
});
test("hover hit testing remains on the immutable original node while its provisional DOM is displaced", () => {
  const f = previewFixture(),
    point = { x: 80, y: 180 };
  for (let i = 0; i < 5; i++) {
    assert.equal(baseNodeAt(f.nodes, point).id, "one");
    const display = previewScene(f.nodes, f.graph, {
      kind: "condition",
      anchorNodeId: baseNodeAt(f.nodes, point).id,
      position: "before",
    });
    assert.equal(baseNodeAt(display.nodes, point), undefined);
  }
});

test("preview omits ambiguous external branch connectors instead of attaching a nearby sibling", () => {
  const f = previewFixture();
  f.graph.nodes.push({ ...f.graph.nodes[1], id: "sibling", parentId: "entry" });
  f.nodes.push({
    id: "sibling",
    position: { x: 500, y: 250 },
    data: { binding: "sibling" },
  });
  f.graph.edges.push({ id: "ambiguous", source: "sibling", target: "one" });
  const frozen = JSON.stringify(f.graph.edges);
  const before = previewScene(f.nodes, f.graph, {
    kind: "condition",
    anchorNodeId: "one",
    position: "before",
  });
  assert.ok(before);
  assert.deepEqual(before.connectors, []);
  f.graph.edges.push({ id: "branch", source: "one", target: "sibling" });
  const after = previewScene(f.nodes, f.graph, {
    kind: "condition",
    anchorNodeId: "one",
    position: "after",
  });
  assert.ok(after);
  assert.deepEqual(after.connectors, []);
  assert.equal(frozen, JSON.stringify(f.graph.edges.slice(0, -1)));
});

import { previewFingerprint, dismissedPreviewKeys } from "./flowPreview.ts";
test("Escape dismisses both hover and existing draft until that draft or binding scope changes", () => {
  const hover = { kind: "condition", anchorNodeId: "one", position: "before" };
  const draft = {
    kind: "loop",
    anchorNodeId: "one",
    position: "after",
    source: "while (true) {}",
  };
  const keys = dismissedPreviewKeys("r/a/m", hover, draft);
  assert.ok(keys.includes(previewFingerprint("r/a/m", hover)));
  assert.ok(keys.includes(previewFingerprint("r/a/m", draft)));
  assert.equal(
    keys.includes(
      previewFingerprint("r/a/m", { ...draft, source: "while (false) {}" }),
    ),
    false,
  );
  assert.equal(keys.includes(previewFingerprint("r/new/m", draft)), false);
  assert.equal(
    keys.includes(previewFingerprint("r/a/m", { ...draft, request: 2 })),
    false,
  );
});

test("overview preview shifts intersecting whole method groups and cascades rows without mutating two-file manual bases", () => {
  const f = previewFixture();
  // A foreign method below the active method, then another lower row.
  f.nodes[4].position = { x: 40, y: 650 };
  f.graph.nodes.push({
    ...f.graph.nodes[4],
    id: "foreign2",
    methodId: "third",
    sourceRange: { filePath: "Third.java" },
  });
  f.nodes.push({
    id: "foreign2",
    position: { x: 40, y: 900 },
    data: { binding: "foreign2" },
  });
  f.graph.nodes[1].sourceRange.filePath = "Main.java";
  f.graph.nodes[4].sourceRange = { filePath: "Helper.java" };
  const frozen = JSON.stringify(f);
  const scene = previewScene(f.nodes, f.graph, {
    kind: "condition",
    anchorNodeId: "one",
    position: "before",
  });
  assert.ok(scene);
  const exit = scene.nodes.find((n) => n.id === "exit"),
    foreign = scene.nodes.find((n) => n.id === "foreign"),
    last = scene.nodes.find((n) => n.id === "foreign2");
  assert.ok(foreign.position.y > f.nodes[4].position.y);
  assert.ok(last.position.y > f.nodes[5].position.y);
  assert.ok(foreign.position.y - 24 >= exit.position.y + 84 + 24 + 80);
  assert.ok(last.position.y - 24 >= foreign.position.y + 84 + 24 + 80);
  assert.equal(JSON.stringify(f), frozen);
  assert.equal(previewScene(f.nodes, f.graph, null), null);
});

import { previewHitSnapshot } from "./flowPreview.ts";
test("native hover snapshots the already displaced draft card and keeps its hit box stable through subsequent template reflow", () => {
  const f = previewFixture(),
    frozen = JSON.stringify(f);
  const draft = previewScene(f.nodes, f.graph, {
    kind: "loop",
    anchorNodeId: "one",
    position: "before",
  });
  const hit = previewHitSnapshot(draft.nodes),
    card = hit.find((n) => n.id === "one"),
    point = { x: card.position.x + 20, y: card.position.y + 20 };
  assert.equal(baseNodeAt(hit, point).id, "one");
  assert.notEqual(baseNodeAt(f.nodes, point)?.id, "one");
  for (const kind of ["condition", "statement", "loop"]) {
    previewScene(f.nodes, f.graph, {
      kind,
      anchorNodeId: baseNodeAt(hit, point).id,
      position: "before",
    });
    assert.equal(baseNodeAt(hit, point).id, "one");
  }
  assert.equal(JSON.stringify(f), frozen);
  assert.notEqual(hit[1].position, draft.nodes[1].position);
});
