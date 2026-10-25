import { ENGINE_VERSION } from "./engineVersion";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { revealPanel, panToNode } from "./flowAssertions";

// UI-only owned mock: all API requests are intercepted. This proves canvas
// history/persistence behavior, not engine analysis or server CAS behavior.
const projectId = "d1111111-1111-4111-8111-111111111111";
const revisionId = "d2222222-2222-4222-8222-222222222222";
const analysisId = "d3333333-3333-4333-8333-333333333333";
const userId = "d4444444-4444-4444-8444-444444444444";
const methodId = "history-method";
const source =
  "class Main {\n  static int answer() {\n    int total = 1;\n    total += 2;\n    return total;\n  }\n}\n";

function range(text: string) {
  const startOffset = source.indexOf(text),
    endOffset = startOffset + text.length;
  const position = (offset: number) => {
    const before = source.slice(0, offset);
    return {
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n"),
    };
  };
  const start = position(startOffset),
    end = position(endOffset);
  return {
    filePath: "Main.java",
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

async function fixture(page: Page) {
  const writes: { method: string; path: string; body: any }[] = [];
  const layoutWrites: any[] = [];
  const user = {
    id: userId,
    username: "history_fixture",
    displayName: "History Fixture",
    authMethod: "password",
    emailVerified: true,
  };
  const project = {
    id: projectId,
    name: "Owned graph history mock",
    ownerId: userId,
    role: "owner",
    canEdit: true,
    visibility: "private",
    headRevisionId: revisionId,
    originalRevisionId: revisionId,
    updatedAt: "2026-10-25T07:00:00Z",
  };
  const revision = {
    id: revisionId,
    projectId,
    parentRevisionId: null,
    createdAt: project.updatedAt,
    origin: "manual",
    bundleHash: "owned-history-source",
    directories: [],
    files: [
      {
        path: "Main.java",
        canonicalText: source,
        sourceHash: "owned-history-source",
      },
    ],
  };
  const method = {
    id: methodId,
    declarationId: "history-declaration",
    fullyQualifiedName: "Main.answer",
    signature: "answer()",
    sourceRange: range(
      source.slice(source.indexOf("static int"), source.lastIndexOf("}")),
    ),
    entryNodeId: "history-entry",
    exitNodeIds: ["history-exit"],
  };
  const realNodes = [
    {
      id: "history-entry",
      kind: "entry",
      label: "entry",
      sourceRange: method.sourceRange,
      executionRole: "structural",
    },
    {
      id: "history-first",
      kind: "ExpressionStmt",
      label: "int total = 1;",
      sourceRange: range("int total = 1;"),
      executionRole: "statement",
    },
    {
      id: "history-second",
      kind: "ExpressionStmt",
      label: "total += 2;",
      sourceRange: range("total += 2;"),
      executionRole: "statement",
    },
    {
      id: "history-return",
      kind: "ReturnStmt",
      label: "return total;",
      sourceRange: range("return total;"),
      executionRole: "statement",
    },
    {
      id: "history-exit",
      kind: "exit",
      label: "exit",
      sourceRange: null,
      executionRole: "synthetic",
    },
  ].map((node) => ({
    ...node,
    revisionId,
    analysisId,
    methodId,
    astBinding: node.id,
    parentId: node.id === "history-entry" ? null : "history-entry",
    synthetic: node.sourceRange === null,
    editableFields: [],
    allowedOperations: [],
    insertionPositions: [],
    editableFieldRanges: {},
  }));
  const graph = {
    revisionId,
    analysisId,
    sourceMapVersion: "utf16-token-v1",
    methods: [method],
    nodes: realNodes,
    initializerContexts: [],
    edges: realNodes.slice(1).map((node, i) => ({
      id: "history-edge-" + i,
      source: realNodes[i].id,
      target: node.id,
      kind: "normal",
      label: null,
    })),
  };
  const analysis = {
    id: analysisId,
    revisionId,
    bundleHash: revision.bundleHash,
    analyzerVersion: ENGINE_VERSION,
    parseStatus: "valid",
    compileStatus: "not_requested",
    symbolStatus: "partial",
    sourceMapVersion: graph.sourceMapVersion,
    diagnostics: [],
    coverage: [],
    declarations: [],
    graph,
    semantics: {
      schemaVersion: "semantic-v1",
      symbols: [],
      references: [],
      limitations: [],
    },
    quality: {
      schemaVersion: "quality-v1",
      methods: [],
      findings: [],
      findingsTruncated: false,
    },
    optimizations: [],
  };
  let layout: any = {
    analysisId,
    methodId,
    sourceMapVersion: graph.sourceMapVersion,
    layoutVersion: 0,
    positions: [],
    collapsedNodeIds: [],
    viewport: null,
  };
  await page.addInitScript((id) => {
    for (const scope of ["home", "workspace", "profile", "settings"])
      localStorage.setItem(
        `java-blueprints:onboarding:v1:${id}:${scope}`,
        "done",
      );
  }, userId);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let data: any = [];
    if (request.method() !== "GET") {
      const body = request.postDataJSON();
      writes.push({ method: request.method(), path, body });
      if (request.method() === "PUT" && path.endsWith("/layout")) {
        layoutWrites.push(body);
        layout = { ...body, layoutVersion: layout.layoutVersion + 1 };
        return route.fulfill({ json: { data: layout } });
      }
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "UNEXPECTED_HISTORY_FIXTURE_WRITE",
            message: "Only owned mock layout writes are allowed",
          },
        },
      });
    }
    if (path === "/api/v1/session")
      data = {
        mode: "authenticated",
        user,
        csrfToken: "history-fixture-csrf",
        capabilities: {
          projectCreation: true,
          registration: true,
          emailDelivery: false,
        },
      };
    else if (path === "/api/v1/profile") data = user;
    else if (path === "/api/v1/capabilities")
      data = { runner: { available: false }, features: {} };
    else if (path === "/api/v1/projects") data = [project];
    else if (path === "/api/v1/projects/" + projectId) data = project;
    else if (path.endsWith("/analysis")) data = analysis;
    else if (path.endsWith("/layout")) data = layout;
    else if (path.endsWith("/revisions/" + revisionId)) data = revision;
    else if (path.endsWith("/revisions")) data = [revision];
    else if (path === "/api/v1/github/status")
      data = { configured: false, linked: null };
    else if (path === "/api/v1/assistant/status") data = { configured: false };
    return route.fulfill({
      json: { data, meta: { requestId: "owned-history-mock" } },
    });
  });
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry").first()).toBeAttached();
  await revealPanel(page, "project", "Проект");
  await page
    .locator(".method-item")
    .filter({ hasText: /^answer\(/ })
    .click();
  await revealPanel(page, "graph", "Схема");
  await expect(page.locator(".flow-area")).toHaveAttribute(
    "aria-label",
    "Полотно схемы. Ctrl+Z — отменить, Ctrl+Shift+Z — повторить",
  );
  return { writes, layoutWrites, layout: () => layout };
}

async function position(page: Page, id: string) {
  return page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .evaluate((element) => {
      const transform = new DOMMatrix(getComputedStyle(element).transform);
      return { x: transform.e, y: transform.f };
    });
}

async function keyAndSave(page: Page, key: string) {
  await page.locator(".flow-area").focus();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/layout"),
  );
  await page.keyboard.press(key);
  expect((await saved).ok()).toBe(true);
}

test("canvas drag undo redo uses physical KeyZ with Russian key and persists mock layout without semantic writes", async ({
  page,
}, info) => {
  const state = await fixture(page);
  const node = page.locator('.react-flow__node[data-id="history-first"]');
  await panToNode(page, node);
  const before = await position(page, "history-first");
  const box = (await node.boundingBox())!;
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/layout"),
  );
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 92, box.y + 42, { steps: 8 });
  await page.mouse.up();
  expect((await saved).ok()).toBe(true);
  const moved = await position(page, "history-first");
  expect(moved).not.toEqual(before);
  await keyAndSave(page, "Control+z");
  await expect.poll(() => position(page, "history-first")).toEqual(before);
  await keyAndSave(page, "Control+Shift+z");
  await expect.poll(() => position(page, "history-first")).toEqual(moved);
  await page.locator(".flow-area").focus();
  const russianUndo = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/layout"),
  );
  await page.locator(".flow-area").dispatchEvent("keydown", {
    key: "я",
    code: "KeyZ",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  expect((await russianUndo).ok()).toBe(true);
  await expect.poll(() => position(page, "history-first")).toEqual(before);
  const russianRedo = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/layout"),
  );
  await page.locator(".flow-area").dispatchEvent("keydown", {
    key: "Я",
    code: "KeyZ",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  expect((await russianRedo).ok()).toBe(true);
  await expect.poll(() => position(page, "history-first")).toEqual(moved);
  expect(state.layoutWrites).toHaveLength(5);
  const persisted = state
    .layout()
    .positions.find((point: any) => point.nodeId === "history-first");
  // Computed CSS matrices round floating coordinates; the request keeps their full precision.
  expect(persisted.x).toBeCloseTo(moved.x, 3);
  expect(persisted.y).toBeCloseTo(moved.y, 3);
  expect(
    state.writes.every(
      (write) => write.method === "PUT" && write.path.endsWith("/layout"),
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("graph-history-redo.png"),
    animations: "disabled",
  });
  await page.reload();
  await expect(page.locator(".blueprint-node.entry").first()).toBeAttached();
  await expect.poll(() => position(page, "history-first")).toEqual(moved);
  expect(state.layoutWrites).toHaveLength(5);
  await info.attach("graph-history-positions", {
    body: JSON.stringify({
      fixture: "owned mocked API",
      before,
      moved,
      layoutWrites: state.layoutWrites,
    }),
    contentType: "application/json",
  });
});

test("Monaco Ctrl+Z stays in the editor and does not consume graph layout history", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await revealPanel(page, "code", "Код Java");
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("X");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "Xclass",
  );
  await page.keyboard.press("Control+z");
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText(
    "Xclass",
  );
  expect(state.layoutWrites).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
  await expect
    .poll(() =>
      page.evaluate(
        (id) => localStorage.getItem("java-blueprints:draft:" + id),
        projectId,
      ),
    )
    .toBeNull();
  const editorEvidence = JSON.stringify(
    await page.evaluate(
      (id) => ({
        draft: JSON.parse(
          localStorage.getItem("java-blueprints:draft:" + id) ?? "null",
        ),
      }),
      projectId,
    ),
  );
  await writeFile(
    info.outputPath("editor-after-local-undo.json"),
    editorEvidence,
  );
  await info.attach("editor-after-local-undo", {
    path: info.outputPath("editor-after-local-undo.json"),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("graph-history-editor-undo.png"),
    animations: "disabled",
  });
});

test("selected-node group drag is one undoable layout gesture", async ({
  page,
}, info) => {
  const state = await fixture(page);
  const first = page.locator('.react-flow__node[data-id="history-first"]');
  const second = page.locator('.react-flow__node[data-id="history-second"]');
  await page
    .getByRole("button", { name: "Показать всю схему", exact: true })
    .click();
  await first.click();
  await second.click({ modifiers: ["Control"] });
  await expect(first).toHaveClass(/selected/);
  await expect(second).toHaveClass(/selected/);
  const before = [
    await position(page, "history-first"),
    await position(page, "history-second"),
  ];
  const box = (await first.boundingBox())!;
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/layout"),
  );
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 62, box.y + 37, { steps: 8 });
  await page.mouse.up();
  expect((await saved).ok()).toBe(true);
  const moved = [
    await position(page, "history-first"),
    await position(page, "history-second"),
  ];
  expect(moved[0]).not.toEqual(before[0]);
  expect(moved[1]).not.toEqual(before[1]);
  expect(moved[0].x - before[0].x).toBeCloseTo(moved[1].x - before[1].x, 5);
  expect(moved[0].y - before[0].y).toBeCloseTo(moved[1].y - before[1].y, 5);
  await keyAndSave(page, "Control+z");
  await expect
    .poll(async () => [
      await position(page, "history-first"),
      await position(page, "history-second"),
    ])
    .toEqual(before);
  await keyAndSave(page, "Control+Shift+z");
  await expect
    .poll(async () => [
      await position(page, "history-first"),
      await position(page, "history-second"),
    ])
    .toEqual(moved);
  expect(state.layoutWrites).toHaveLength(3);
  await page.screenshot({
    path: info.outputPath("graph-history-group-redo.png"),
    animations: "disabled",
  });
});
