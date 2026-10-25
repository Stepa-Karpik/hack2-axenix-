// @ts-nocheck -- Native Node test runner with small source fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { searchProject } from "./searchIndex.ts";
const range = {
  filePath: "Main.java",
  startOffset: 20,
  endOffset: 55,
  startLine: 2,
  endLine: 2,
  startColumn: 1,
  endColumn: 36,
};
const graph = {
  methods: [{ id: "m", signature: "int classify(int n)", sourceRange: range }],
  nodes: [
    {
      id: "if",
      methodId: "m",
      kind: "condition",
      label: "n > 0",
      sourceRange: range,
      executionRole: "condition_test",
    },
  ],
};
test("project search covers semantic Russian aliases and exact source bindings", () => {
  const files = {
    "Main.java":
      "class Main {\nint classify(int n) {if(n > 0) return 1;return 0;}\n}",
  };
  assert.equal(searchProject(files, graph, "условие")[0].nodeId, "if");
  assert.equal(searchProject(files, graph, "метод")[0].methodId, "m");
  assert.equal(
    searchProject(files, graph, "n > 0")[0].range.filePath,
    "Main.java",
  );
  assert.equal(searchProject(files, graph, "Main.java")[0].kind, "file");
});
test("source search remains available without valid analysis, limits results and excludes removed files", () => {
  assert.equal(
    searchProject({ "readme.txt": "Привет\nнужный текст" }, null, "нужный")[0]
      .range.startLine,
    2,
  );
  assert.equal(searchProject({}, graph, "условие").length, 0);
  assert.equal(
    searchProject(
      { "a.txt": Array(1000).fill("query").join("\n") },
      null,
      "query",
    ).length,
    50,
  );
  assert.deepEqual(searchProject({}, null, " "), []);
});

test("Russian loop search recognizes actual Java AST node kinds rather than only synthetic loop names", () => {
  for (const kind of [
    "ForStmt",
    "ForEachStmt",
    "WhileStmt",
    "DoStmt",
    "foreach_check",
    "for_init",
  ]) {
    const g = {
      ...graph,
      methods: [],
      nodes: [{ ...graph.nodes[0], id: kind, kind, label: "source predicate" }],
    };
    const hit = searchProject({ "Main.java": "class Main {}" }, g, "цикл")[0];
    assert.equal(hit?.nodeId, kind);
    assert.equal(hit?.methodId, "m");
  }
});
