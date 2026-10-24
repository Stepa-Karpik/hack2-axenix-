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
