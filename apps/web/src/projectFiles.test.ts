// @ts-nocheck -- Runs with Node without browser or Monaco.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addPath,
  movePath,
  directoryPaths,
  languageFor,
  methodIdentity,
  matchingMethod,
  remapModels,
  publicJavaType,
  javaFilenameIssues,
  javaEntryHint,
} from "./projectFiles.ts";
test("Java filename checks cover the whole snapshot, packages and occupied rename targets", () => {
  const files = [
    {
      path: "src/abc.java",
      canonicalText: "package app; public class Main {}",
    },
    {
      path: "src/Main.java",
      canonicalText: "package app; public class Main {}",
    },
    { path: "notes.txt", canonicalText: "public class Ignore {}" },
    {
      path: "Nested.java",
      canonicalText: "class Outer {public class Nested {}}",
    },
  ];
  assert.deepEqual(javaFilenameIssues(files), [
    {
      path: "src/abc.java",
      type: "Main",
      target: "src/Main.java",
      targetOccupied: true,
    },
  ]);
  assert.equal(
    javaFilenameIssues([files[0]], ["src/Main.java/empty"])[0].targetOccupied,
    true,
  );
  assert.equal(javaFilenameIssues([files[0]])[0].targetOccupied, false);
});
test("entry hints use the declared public name rather than a mismatched filename", () => {
  assert.equal(
    javaEntryHint({
      path: "Main.java",
      canonicalText:
        'public class Main {public static void main(String[] args){System.out.println("\\u007b");}}',
    }),
    "Main",
  );
  assert.equal(
    javaEntryHint({
      path: "Main.java",
      canonicalText:
        "// package wrong;\npackage app; public class Main {public static void main(String[] args){}}",
    }),
    "app.Main",
  );
  assert.equal(
    javaEntryHint({
      path: "abc.java",
      canonicalText:
        "package app; public class Main {public static void main(String[] args){}}",
    }),
    "app.Main",
  );
  assert.equal(
    javaEntryHint({
      path: "TaskForge.java",
      canonicalText:
        "public class TaskForge { public static void helper() {} }",
    }),
    undefined,
  );
  assert.equal(
    javaEntryHint({
      path: "notes.txt",
      canonicalText:
        "public class Main {public static void main(String[] args){}}",
    }),
    undefined,
  );
});
test("filename hint detects only a real top-level public type", () => {
  assert.equal(
    publicJavaType(
      "// public class Fake {}\n/* public class Other {} */ public final class Main { public class Nested {} }",
    ),
    "Main",
  );
  assert.equal(
    publicJavaType("class Outer { public class Nested {} }"),
    undefined,
  );
  assert.equal(
    publicJavaType(
      "public @Example(value=Other.class) record Order(int id) {}",
    ),
    "Order",
  );
  assert.equal(publicJavaType("public @interface Label {}"), "Label");
  assert.equal(
    publicJavaType(
      'class Outer { String s = "}"; String t = """\n public class Fake {}\n """; public class Nested {} }',
    ),
    undefined,
  );
  assert.equal(
    publicJavaType('public class Main { String escaped = "\\u007b"; }'),
    undefined,
  );
});
test("nested and empty directories survive subtree moves with unsaved text", () => {
  const before = {
    files: { "src/Main.java": "unsaved", "notes.txt": "memo" },
    directories: ["src/empty"],
  };
  const after = movePath(before, "src", "app/code");
  assert.equal(after.files["app/code/Main.java"], "unsaved");
  assert.equal(after.files["notes.txt"], "memo");
  assert.ok(
    directoryPaths(after.files, after.directories).includes("app/code/empty"),
  );
  assert.equal(before.files["src/Main.java"], "unsaved");
});
test("conflicting tree mutations fail before changing any buffer", () => {
  const before = {
    files: { "src/A.java": "A", "dest.txt": "B" },
    directories: ["empty"],
  };
  for (const [a, b] of [
    ["src", "src/child"],
    ["src", "dest.txt/nested"],
    ["src/A.java", "empty"],
    ["src", "dest.txt"],
  ])
    assert.throws(() => movePath(before, a, b));
  for (const p of [
    "../x",
    "/x",
    "a//b",
    "a\\b",
    "a/../b",
    "dest.txt/child",
    "empty",
  ])
    assert.throws(() => addPath(before, p, false));
  assert.deepEqual(before.files, { "src/A.java": "A", "dest.txt": "B" });
});
test("filename determines language with text fallback and empty file contents", () => {
  assert.equal(languageFor("src/Main.java"), "java");
  assert.equal(languageFor("tools/main.py"), "python");
  assert.equal(languageFor("README"), "plaintext");
  assert.deepEqual(
    addPath({ files: {}, directories: [] }, "docs/read me.txt", false).files,
    { "docs/read me.txt": "" },
  );
});
test("method continuity requires current file, callable identity and signature", () => {
  const method = {
    id: "old-scoped-id",
    signature: "answer()",
    fullyQualifiedName: "Main.answer",
    sourceRange: { filePath: "Main.java" },
  };
  const identity = methodIdentity(method);
  const next = { ...method, id: "new-scoped-id" };
  assert.equal(
    matchingMethod([{ ...next, signature: "first()" }, next], identity)?.id,
    "new-scoped-id",
  );
  assert.equal(
    matchingMethod(
      [{ ...next, sourceRange: { filePath: "Other.java" } }],
      identity,
    ),
    undefined,
  );
  assert.equal(
    matchingMethod([{ ...next, signature: "answer(int)" }], identity),
    undefined,
  );
});
test("model IDs retain undo identity through folder rename without crossing projects", () => {
  const models = {
    "src/Main.java": "project-a/models/1",
    "src/notes.txt": "project-a/models/2",
    "Other.java": "project-a/models/3",
  };
  assert.deepEqual(remapModels(models, "src", "lib"), {
    "lib/Main.java": "project-a/models/1",
    "lib/notes.txt": "project-a/models/2",
    "Other.java": "project-a/models/3",
  });
  assert.deepEqual(
    remapModels(models, "src/Main.java", "src/Renamed.java")[
      "src/Renamed.java"
    ],
    "project-a/models/1",
  );
});
