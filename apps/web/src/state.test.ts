// @ts-nocheck -- Node's built-in test runner, intentionally no browser dependency.
import test from "node:test";
import assert from "node:assert/strict";
import { hasChanges, canApply, nodeAtOffset, draftKey } from "./state.ts";
test("invalid Java drafts remain content changes", () => {
  assert.equal(
    hasChanges({ "Main.java": "class {" }, { "Main.java": "class Main {}" }),
    true,
  );
});
test("CAS blocks a compiled proposal after head changes", () => {
  assert.equal(
    canApply("ready", "base", "other", "semantic_edit", true),
    false,
  );
  assert.equal(
    canApply("ready", "base", "base", "preserve_behavior", false),
    false,
  );
  assert.equal(canApply("ready", "base", "base", "semantic_edit", false), true);
});
test("source navigation uses the tightest exact file range", () => {
  const nodes = [
    {
      id: "outer",
      sourceRange: { filePath: "A.java", startOffset: 0, endOffset: 30 },
    },
    {
      id: "inner",
      sourceRange: { filePath: "A.java", startOffset: 10, endOffset: 20 },
    },
  ];
  assert.equal(nodeAtOffset(nodes, "A.java", 15)?.id, "inner");
  assert.equal(nodeAtOffset(nodes, "B.java", 15), undefined);
});
test("draft namespace is project scoped", () =>
  assert.notEqual(draftKey("a"), draftKey("b")));
test("source ranges are half-open UTF16 offsets", () => {
  const n = {
    id: "a",
    sourceRange: { filePath: "A.java", startOffset: 2, endOffset: 5 },
  };
  assert.equal(nodeAtOffset([n], "A.java", 4), n);
  assert.equal(nodeAtOffset([n], "A.java", 5), undefined);
});

test("structural controls follow only explicit node capabilities", async () => {
  const { nodeOperations } = await import("./state.ts");
  assert.deepEqual(nodeOperations(null), []);
  assert.deepEqual(nodeOperations({ editableFields: ["expression"] }), []);
  assert.deepEqual(
    nodeOperations({
      allowedOperations: ["insert_statement", "delete_statement", "unknown"],
    }),
    ["insert_statement", "delete_statement"],
  );
});

test("pending, rejected and unavailable proposals cannot apply", () => {
  for (const status of [
    "queued",
    "running",
    "rejected",
    "unavailable",
    "compile_error",
  ])
    assert.equal(
      canApply(status, "base", "base", "semantic_edit", true),
      false,
    );
});

test("semantic references use exact scoped identities and bounded source navigation", async () => {
  const { referenceAt, scopedReferences, declarationTarget, currentBindings } =
    await import("./symbols.ts");
  const range = (file, start, end) => ({
    filePath: file,
    startOffset: start,
    endOffset: end,
    startLine: 1,
    startColumn: start + 1,
    endLine: 1,
    endColumn: end + 1,
  });
  const symbols = [
    {
      id: "field",
      kind: "field",
      name: "value",
      external: false,
      sourceRange: range("Data.java", 5, 10),
    },
    {
      id: "parameter",
      kind: "parameter",
      name: "value",
      external: false,
      sourceRange: range("Main.java", 20, 25),
    },
    {
      id: "local",
      kind: "local",
      name: "value",
      external: false,
      sourceRange: range("Main.java", 40, 45),
    },
    {
      id: "jdk",
      kind: "method",
      name: "println",
      external: true,
      sourceRange: null,
    },
  ];
  const refs = symbols.map((symbol, i) => ({
    id: "ref" + i,
    name: "value",
    sourceRange: range("Main.java", 100 + i * 10, 105 + i * 10),
    resolution: "exact",
    targetIds: [symbol.id],
  }));
  const files = { "Data.java": "source", "Main.java": "source" };
  assert.equal(
    declarationTarget(referenceAt(refs, "Main.java", 102), symbols, files, true)
      ?.id,
    "field",
  );
  assert.equal(
    declarationTarget(referenceAt(refs, "Main.java", 112), symbols, files, true)
      ?.id,
    "parameter",
  );
  assert.equal(
    declarationTarget(referenceAt(refs, "Main.java", 122), symbols, files, true)
      ?.id,
    "local",
  );
  assert.equal(referenceAt(refs, "Other.java", 102), undefined);
  assert.equal(referenceAt(refs, "Main.java", 105), undefined);
  assert.equal(declarationTarget(refs[3], symbols, files, true), undefined);
  assert.equal(
    declarationTarget(
      { ...refs[0], resolution: "unresolved" },
      symbols,
      files,
      true,
    ),
    undefined,
  );
  assert.equal(
    declarationTarget(
      { ...refs[0], resolution: "candidates", targetIds: ["field", "local"] },
      symbols,
      files,
      true,
    ),
    undefined,
  );
  assert.equal(declarationTarget(refs[0], symbols, files, false), undefined);
  const many = Array.from({ length: 10000 }, (_, i) => ({
    ...refs[0],
    id: String(i),
  }));
  assert.equal(scopedReferences(many, "Main.java").rows.length, 20);
  assert.equal(scopedReferences(many, "Main.java").total, 10000);
  assert.equal(
    scopedReferences(refs, "Main.java", range("Main.java", 110, 126)).rows
      .length,
    2,
  );
  const analysis = {
    revisionId: "r1",
    parseStatus: "valid",
    semantics: { symbols, references: refs },
  };
  assert.equal(currentBindings(analysis, "r1", false), true);
  assert.equal(currentBindings(analysis, "r1", true), false);
  assert.equal(currentBindings(analysis, "r2", false), false);
  assert.equal(
    currentBindings({ ...analysis, parseStatus: "invalid" }, "r1", false),
    false,
  );
  assert.equal(
    currentBindings({ ...analysis, semantics: undefined }, "r1", false),
    false,
  );
});

test("condition flow layout keeps branches disjoint without executing AST projections", async () => {
  const { executionNodes, arrangeFlow } = await import("./flowLayout.ts");
  const node = (id, role = "statement", kind = "ExpressionStmt") => ({
    id,
    executionRole: role,
    kind,
  });
  const nodes = [
    node("entry", "synthetic", "entry"),
    node("header", "structural", "IfStmt"),
    node("a", "condition_test", "condition_test"),
    node("b", "condition_test", "condition_test"),
    node("yes"),
    node("no"),
    node("join"),
    node("projection", "ast_projection"),
  ];
  const edge = (source, target, kind = "normal") => ({ source, target, kind });
  const edges = [
    edge("entry", "header"),
    edge("header", "a"),
    edge("a", "b", "true"),
    edge("a", "no", "false"),
    edge("b", "yes", "true"),
    edge("b", "no", "false"),
    edge("yes", "join"),
    edge("no", "join"),
    edge("join", "header", "loop"),
    edge("projection", "a"),
  ];
  const visible = executionNodes(nodes, edges);
  assert.equal(
    visible.some((n) => n.id === "projection"),
    false,
  );
  assert.equal(
    executionNodes([node("old", null), node("other")], [edge("old", "other")])
      .length,
    2,
  );
  const positions = arrangeFlow(visible, edges);
  assert.equal(positions.size, visible.length);
  // Node rectangles are 264x84; reserve another 56px horizontally and 44px
  // vertically for handles/labels instead of asserting the former rank145.
  const nodeWidth = 264,
    nodeHeight = 84;
  const horizontalClearance = 56,
    verticalClearance = 44;
  for (const [a, p] of positions)
    for (const [b, q] of positions)
      if (a !== b)
        assert.ok(
          Math.abs(p.y - q.y) >= nodeHeight + verticalClearance ||
            Math.abs(p.x - q.x) >= nodeWidth + horizontalClearance,
          a + " overlaps " + b,
        );
  assert.deepEqual(arrangeFlow(visible, edges), positions);
  assert.ok(positions.get("b").y > positions.get("a").y);
  assert.ok(positions.get("join").y > positions.get("no").y);
});

test("shortcut and loop lanes bypass every node column", async () => {
  const { routeFlowEdges } = await import("./flowLayout.ts");
  const nodes = [
    { id: "a", position: { x: 0, y: 0 } },
    { id: "b", position: { x: 0, y: 145 } },
    { id: "c", position: { x: 0, y: 290 } },
  ];
  const edges = [
    { id: "next", source: "a", target: "b", kind: "false" },
    { id: "skip", source: "a", target: "c", kind: "true" },
    { id: "back", source: "c", target: "a", kind: "loop" },
  ];
  const routes = routeFlowEdges(nodes, edges);
  assert.ok(routes.get("next") > Math.max(...nodes.map(node => node.position.x + 280)));
  assert.notEqual(routes.get("next"), routes.get("skip"));
  assert.ok(
    routes.get("skip") >
      Math.max(...nodes.map((node) => node.position.x + 280)),
  );
  assert.ok(
    routes.get("back") < Math.min(...nodes.map((node) => node.position.x)),
  );
});

test("dragged departure and approach obstacles are bypassed within router budget", async () => {
  const { routeOrthogonal, segmentHitsBox } = await import("./flowLayout.ts");
  for (const obstacleY of [80, 250]) {
    const boxes = [
      { id: "A", x: 320, y: 0, width: 280, height: 74 },
      { id: "C", x: 320, y: 290, width: 280, height: 74 },
      { id: "B", x: 0, y: obstacleY, width: 280, height: 74 },
    ];
    const result = routeOrthogonal(
      { x: 460, y: 74 },
      { x: 460, y: 290 },
      -40,
      boxes,
    );
    assert.equal(result.complete, true);
    assert.ok(
      result.points
        .slice(1)
        .every((point, index) =>
          boxes.every(
            (box) => !segmentHitsBox(result.points[index], point, box),
          ),
        ),
    );
  }
  const limited = routeOrthogonal({ x: 0, y: 0 }, { x: 0, y: 290 }, -40, [
    { id: "overlap", x: -100, y: -100, width: 1000, height: 1000 },
  ]);
  assert.equal(limited.complete, false);
  assert.deepEqual(limited.points[0], { x: 0, y: 0 });
  assert.deepEqual(limited.points.at(-1), { x: 0, y: 290 });
});

test("switch dispatch preserves raw captions and separates ten target labels", async () => {
  const { compactFlowLabel, routeFlowEdges, dispatchLabelPosition, flowLabelTitle } =
    await import("./flowLayout.ts");
  const raw = "1, /* colon: && || */ 2";
  assert.equal(compactFlowLabel(raw), raw);
  const fullRaw = raw.repeat(30);
  assert.equal(flowLabelTitle(fullRaw, true), fullRaw);
  assert.ok(flowLabelTitle(fullRaw, false).startsWith(fullRaw + "\n"));
  assert.ok(flowLabelTitle(fullRaw, false).includes("обход узлов не гарантирован"));
  const caption = compactFlowLabel('"😀'.repeat(30), 16);
  assert.equal(Array.from(caption).length, 16);
  assert.equal(caption.endsWith("…"), true);
  const targets = Array.from({ length: 10 }, (_, index) => ({
    id: "case" + index, position: { x: index * 320, y: 290 },
  }));
  const edges = targets.map((target, index) => ({
    id: "edge" + index, source: "selector", target: target.id,
    kind: index === 9 ? "default" : "case", label: index === 0 ? raw : String(index),
  }));
  const routes = routeFlowEdges([{ id: "selector", position: { x: 0, y: 0 } }, ...targets], edges);
  assert.equal(routes.size, 10);
  assert.equal(edges[0].label, raw);
  const labels = targets.map(target => dispatchLabelPosition(target.position));
  assert.equal(labels.length, 10);
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      assert.ok(Math.abs(labels[i].x - labels[j].x) >= 240 || Math.abs(labels[i].y - labels[j].y) >= 24);
});
