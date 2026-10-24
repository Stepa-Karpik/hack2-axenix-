// @ts-nocheck -- Node's built-in test runner, intentionally no browser dependency.
import test from "node:test";
import assert from "node:assert/strict";
import { blockEditPayload, moveTargets, movePositions } from "./blockEdits.ts";
import { nodeOperations } from "./state.ts";

const node = (id, offset, patch = {}) => ({
  id,
  revisionId: "r",
  analysisId: "a",
  methodId: "m",
  parentId: "body",
  kind: "ExpressionStmt",
  label: id,
  synthetic: false,
  sourceRange: {
    filePath: "Main.java",
    startOffset: offset,
    endOffset: offset + 5,
    startLine: offset,
  },
  allowedOperations: [
    "insert_statement",
    "move_statement",
    "wrap_if",
    "wrap_while",
    "add_else",
    "remove_else",
  ],
  insertionPositions: ["before", "after"],
  editableFields: [],
  ...patch,
});
const fields = {
  position: "after",
  statement: "x();",
  expression: "x()",
  condition: "ready",
  elseSource: "{\n x();\n}",
  targetNodeId: "c",
  movePosition: "after",
};
const a = node("a", 10),
  b = node("b", 20),
  c = node("c", 30);
const graph = { revisionId: "r", analysisId: "a", nodes: [a, b, c] };

test("membership action needs an advertised exact graph binding and carries no source payload", () => {
  const loop = node("loop", 40, { allowedOperations: ["optimize_membership"] });
  const bound = { ...graph, nodes: [loop] };
  assert.deepEqual(nodeOperations(loop), ["optimize_membership"]);
  assert.deepEqual(
    blockEditPayload(loop, bound, "optimize_membership", fields),
    {},
  );
  assert.equal(
    blockEditPayload(
      loop,
      { ...bound, analysisId: "old" },
      "optimize_membership",
      fields,
    ),
    null,
  );
  assert.equal(blockEditPayload(a, graph, "optimize_membership", fields), null);
});

test("move destinations require advertised sibling anchors in the exact source context", () => {
  const invalid = [
    node("nested", 40, { parentId: "nestedBody" }),
    node("otherMethod", 50, { methodId: "other" }),
    node("otherRevision", 60, { revisionId: "old" }),
    node("otherAnalysis", 70, { analysisId: "old" }),
    node("otherFile", 80, {
      sourceRange: { ...a.sourceRange, filePath: "Other.java" },
    }),
    node("synthetic", 90, { synthetic: true }),
    node("readonly", 100, { allowedOperations: ["insert_statement"] }),
  ];
  assert.deepEqual(
    moveTargets(a, { ...graph, nodes: [...graph.nodes, ...invalid] }).map(
      (n) => n.id,
    ),
    ["b", "c"],
  );
  assert.deepEqual(moveTargets(a, { ...graph, analysisId: "old" }), []);
  assert.deepEqual(moveTargets(null, graph), []);
});

test("move excludes self and existing-order no-ops while retaining reorder directions", () => {
  assert.deepEqual(movePositions(a, b, graph), ["after"]);
  assert.deepEqual(movePositions(b, a, graph), ["before"]);
  assert.deepEqual(movePositions(a, c, graph), ["before", "after"]);
  assert.equal(
    blockEditPayload(a, graph, "move_statement", {
      ...fields,
      targetNodeId: "a",
    }),
    null,
  );
  assert.equal(
    blockEditPayload(a, graph, "move_statement", {
      ...fields,
      targetNodeId: "b",
      movePosition: "before",
    }),
    null,
  );
  assert.deepEqual(blockEditPayload(a, graph, "move_statement", fields), {
    targetNodeId: "c",
    position: "after",
  });
});

test("expanded operations preserve strict payload shapes and explicit capabilities", () => {
  assert.deepEqual(blockEditPayload(a, graph, "wrap_if", fields), {
    condition: "ready",
  });
  assert.deepEqual(blockEditPayload(a, graph, "wrap_while", fields), {
    condition: "ready",
  });
  assert.deepEqual(blockEditPayload(a, graph, "add_else", fields), {
    source: fields.elseSource,
  });
  assert.deepEqual(blockEditPayload(a, graph, "remove_else", fields), {});
  assert.equal(
    blockEditPayload(a, graph, "wrap_if", { ...fields, condition: "  " }),
    null,
  );
  assert.equal(
    blockEditPayload(a, graph, "add_else", { ...fields, elseSource: "x();" }),
    null,
  );
  assert.equal(
    blockEditPayload({ ...a, allowedOperations: [] }, graph, "wrap_if", fields),
    null,
  );
  assert.equal(
    blockEditPayload(a, { ...graph, revisionId: "old" }, "remove_else", fields),
    null,
  );
  assert.equal(blockEditPayload(a, graph, "future_operation", fields), null);
  assert.deepEqual(nodeOperations(a), a.allowedOperations);
});

test("existing insert/delete/expression requests use the same guarded payload path", () => {
  const editable = node("e", 40, {
    editableFields: ["expression"],
    allowedOperations: [
      "insert_statement",
      "delete_statement",
      "replace_expression",
    ],
  });
  const editableGraph = { ...graph, nodes: [editable] };
  assert.deepEqual(
    blockEditPayload(editable, editableGraph, "insert_statement", fields),
    { position: "after", source: "x();" },
  );
  assert.deepEqual(
    blockEditPayload(editable, editableGraph, "replace_expression", fields),
    { field: "expression", source: "x()" },
  );
  assert.deepEqual(
    blockEditPayload(editable, editableGraph, "delete_statement", fields),
    {},
  );
  assert.equal(
    blockEditPayload(editable, editableGraph, "insert_statement", {
      ...fields,
      position: "body_end",
    }),
    null,
  );
});
