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
