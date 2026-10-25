import { test, expect, type Page, type Locator } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { panToNode, revealPanel, assertRoutes } from "./flowAssertions";
import { chooseOption } from "./selectControl";

// Synthetic fixtures only; each test gets an isolated guest/browser context.
const source = `public class Main {
  static int answer(boolean ready) {
    int value = 2;
    if (ready) value = value + 1;
    return value;
  }
  static int other() { int value = 7; return value; }
}
`;
const helper = `class Helper { static int third() { return 9; } }\n`;
const node = (page: Page, id: string) =>
  page.locator(`.react-flow__node-blueprint[data-id="${id}"]`);
async function camera(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { x: m.e, y: m.f, zoom: m.a };
  });
}
async function position(target: Locator) {
  return target.evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { x: m.e, y: m.f };
  });
}
const nearPoint = (
  actual: { x: number; y: number },
  expected: { x: number; y: number },
) =>
  Math.abs(actual.x - expected.x) <= 0.01 &&
  Math.abs(actual.y - expected.y) <= 0.01;
const nearCamera = (
  actual: { x: number; y: number; zoom: number },
  expected: { x: number; y: number; zoom: number },
) =>
  nearPoint(actual, expected) &&
  Math.abs(actual.zoom - expected.zoom) <= 0.00001;
async function fixture(page: Page) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Graph workspace " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id as string,
    base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      intent: "semantic_edit",
      files: [
        { path: "Main.java", content: source },
        { path: "Helper.java", content: helper },
      ],
    },
  });
  expect(saved.status()).toBe(201);
  const revision = (await saved.json()).data;
  await page.goto("/projects/" + id);
  await expect(
    page.locator('.flow-area[data-graph-view="overview"]'),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".blueprint-node.entry").first()).toBeAttached({
    timeout: 30000,
  });
  let analysis: any;
  await expect
    .poll(
      async () => {
        const r = await page.request.get(
          base + "/revisions/" + revision.id + "/analysis",
        );
        if (r.status() === 404) {
          expect((await r.json()).error.code).toBe("ANALYSIS_NOT_READY");
          return false;
        }
        expect(r.ok()).toBe(true);
        analysis = (await r.json()).data;
        return analysis.revisionId === revision.id;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  expect(analysis.diagnostics).toEqual([]);
  await revealPanel(page, "project", "Проект");
  return { id, base, revision, graph: analysis.graph };
}
async function method(page: Page, name = "answer") {
  await revealPanel(page, "project", "Проект");
  await page
    .locator(".method-item")
    .filter({ hasText: new RegExp("^" + name + "\\(") })
    .click();
  await revealPanel(page, "graph", "Схема");
  await expect(
    page.locator('.flow-area[data-graph-view="method"]'),
  ).toBeVisible();
}
async function fit(page: Page) {
  await revealPanel(page, "graph", "Схема");
  await page
    .getByRole("button", { name: "Показать всю схему", exact: true })
    .click();
}
async function selectPair(page: Page, a: Locator, b: Locator) {
  await a.click({ modifiers: ["Control"] });
  await b.click({ modifiers: ["Control"] });
  await expect(a).toHaveClass(/selected/);
  await expect(b).toHaveClass(/selected/);
  await expect(page.locator(".graph-selection-note")).toContainText("2");
}
async function moveSelected(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 28,
    box.y + box.height / 2 + 18,
    { steps: 8 },
  );
  await page.mouse.up();
}
function selectedNodes(graph: any, methodName: string) {
  const m = graph.methods.find((m: any) =>
    m.signature.startsWith(methodName + "("),
  );
  return {
    method: m,
    entry: graph.nodes.find(
      (n: any) => n.methodId === m.id && n.kind === "entry",
    ),
    stmt: graph.nodes.find(
      (n: any) =>
        n.methodId === m.id &&
        n.kind === "ExpressionStmt" &&
        n.allowedOperations?.includes("insert_statement"),
    ),
  };
}

test("file overview keeps real method frames; cross-method Ctrl drag reloads one local snapshot and camera without source edits", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await method(page);
  await revealPanel(page, "project", "Проект");
  await page.locator(".file-item").filter({ hasText: "Main.java" }).click();
  await revealPanel(page, "graph", "Схема");
  await expect(
    page.locator('.flow-area[data-graph-view="overview"]'),
  ).toBeVisible();
  await fit(page);
  const a = selectedNodes(f.graph, "answer"),
    b = selectedNodes(f.graph, "other");
  await expect(page.locator("[data-method-frame]")).toHaveCount(3);
  await expect(page.locator(".graph-method-frame.active")).toHaveCount(1);
  await expect(page.locator(".graph-method-frame.active")).toHaveCSS(
    "border-top-style",
    "dashed",
  );
  const first = node(page, a.entry.id),
    second = node(page, b.entry.id);
  const beforeA = await position(first),
    beforeB = await position(second);
  const puts: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "PUT" &&
      r.url().includes(f.base) &&
      r.url().includes("/layout")
    )
      puts.push(r.url());
  });
  await selectPair(page, first, second);
  await expect(page.locator('[data-provisional-scene="true"]')).toHaveCount(0);
  const cameraBeforeHighlight = await camera(page);
  await moveSelected(page, first);
  const afterA = await position(first),
    afterB = await position(second);
  expect(afterA).not.toEqual(beforeA);
  expect(
    Math.abs(afterB.x - beforeB.x - (afterA.x - beforeA.x)),
  ).toBeLessThanOrEqual(0.01);
  expect(
    Math.abs(afterB.y - beforeB.y - (afterA.y - beforeA.y)),
  ).toBeLessThanOrEqual(0.01);
  const saved = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("java-blueprints:overview:v1:" + id)!),
    f.id,
  );
  expect(saved.revisionId).toBe(f.revision.id);
  expect(saved.analysisId).toBe(f.graph.analysisId);
  expect(saved.sourceMapVersion).toBe(f.graph.sourceMapVersion);
  const savedA = saved.positions.find((p: any) => p.nodeId === a.entry.id);
  const savedB = saved.positions.find((p: any) => p.nodeId === b.entry.id);
  expect(savedA).toMatchObject({ nodeId: a.entry.id, methodId: a.method.id });
  expect(savedB).toMatchObject({ nodeId: b.entry.id, methodId: b.method.id });
  expect(nearPoint(savedA, afterA)).toBe(true);
  expect(nearPoint(savedB, afterB)).toBe(true);
  expect(await camera(page)).toEqual(cameraBeforeHighlight);
  const previousZoom = (await camera(page)).zoom;
  await page.mouse.wheel(0, -80);
  await expect
    .poll(async () => (await camera(page)).zoom)
    .not.toBe(previousZoom);
  const savedCamera = await camera(page);
  await expect
    .poll(() =>
      page
        .evaluate(
          (id) =>
            JSON.parse(
              localStorage.getItem("java-blueprints:overview:v1:" + id)!,
            ).viewport,
          f.id,
        )
        .then((raw) => nearCamera(raw, savedCamera)),
    )
    .toBe(true);
  await page.reload();
  await expect(node(page, a.entry.id)).toBeAttached({ timeout: 30000 });
  await expect
    .poll(async () => nearPoint(await position(node(page, a.entry.id)), afterA))
    .toBe(true);
  await expect
    .poll(async () => nearPoint(await position(node(page, b.entry.id)), afterB))
    .toBe(true);
  await expect
    .poll(async () => nearCamera(await camera(page), savedCamera))
    .toBe(true);
  const restored = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("java-blueprints:overview:v1:" + id)!),
    f.id,
  );
  expect(restored.positions).toEqual(saved.positions);
  expect(restored).toMatchObject({
    revisionId: saved.revisionId,
    analysisId: saved.analysisId,
    sourceMapVersion: saved.sourceMapVersion,
  });
  expect(puts).toEqual([]);
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
  await page.screenshot({
    path: info.outputPath("overview-group-reload.png"),
    animations: "disabled",
  });
});

test("focused Ctrl group drag performs one complete CAS save and ordinary highlight keeps the camera", async ({
  page,
}) => {
  const f = await fixture(page);
  await method(page);
  await fit(page);
  const a = selectedNodes(f.graph, "answer"),
    first = node(page, a.entry.id),
    second = node(page, a.stmt.id);
  const layoutUrl = f.base + "/revisions/" + f.revision.id + "/layout";
  const current = await page.request.get(
    layoutUrl +
      "?analysisId=" +
      encodeURIComponent(f.graph.analysisId) +
      "&methodId=" +
      encodeURIComponent(a.method.id),
  );
  expect(current.ok()).toBe(true);
  const previous = (await current.json()).data;
  const requests: any[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes(layoutUrl))
      requests.push(r.postDataJSON());
  });
  await selectPair(page, first, second);
  await expect(page.locator('[data-provisional-scene="true"]')).toHaveCount(0);
  const beforeA = await position(first),
    beforeB = await position(second),
    view = await camera(page);
  const response = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().includes(layoutUrl),
  );
  await moveSelected(page, first);
  expect((await response).ok()).toBe(true);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    analysisId: f.graph.analysisId,
    methodId: a.method.id,
    layoutVersion: previous.layoutVersion,
  });
  const renderedIds = await page
    .locator(".react-flow__node-blueprint")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id")).sort());
  expect(requests[0].positions.map((p: any) => p.nodeId).sort()).toEqual(
    renderedIds,
  );
  const afterA = await position(first),
    afterB = await position(second);
  expect(afterA).not.toEqual(beforeA);
  expect(
    Math.abs(afterB.x - beforeB.x - (afterA.x - beforeA.x)),
  ).toBeLessThanOrEqual(0.01);
  expect(
    Math.abs(afterB.y - beforeB.y - (afterA.y - beforeA.y)),
  ).toBeLessThanOrEqual(0.01);
  await second.click();
  expect(await camera(page)).toEqual(view);
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
});

test("branch labels reserve readable geometry and compact routes have bounded paths", async ({
  page,
}, info) => {
  await fixture(page);
  await method(page);
  await fit(page);
  await expect(page.locator(".shortcut-label.branch-label")).toHaveCount(2);
  for (const label of await page
    .locator(".shortcut-label.branch-label")
    .all()) {
    await expect(label).toHaveCSS("font-size", "13px");
    await expect(label).toHaveCSS("width", "44px");
    await expect(label).toHaveCSS("height", "26px");
  }
  await assertRoutes(page);
  const excessive = await page
    .locator("g[data-shortcut-source] path.react-flow__edge-path")
    .evaluateAll((paths) => {
      const nodes = Array.from(
        document.querySelectorAll(".react-flow__node-blueprint"),
      ).map((el) => el.getBoundingClientRect());
      const bounds = {
        left: Math.min(...nodes.map((r) => r.left)) - 150,
        right: Math.max(...nodes.map((r) => r.right)) + 150,
      };
      return paths.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < bounds.left || r.right > bounds.right;
      }).length;
    });
  expect(excessive).toBe(0);
  await page.screenshot({
    path: info.outputPath("branch-routing.png"),
    animations: "disabled",
  });
});

test("palette template previews actual draft text without preparing or mutating project head", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const f = await fixture(page);
  await method(page);
  const target = node(page, selectedNodes(f.graph, "answer").stmt.id);
  await panToNode(page, target);
  const displayPositions = () =>
    page.locator(".react-flow__node-blueprint").evaluateAll((nodes) =>
      nodes.map((el) => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return { id: el.getAttribute("data-id"), x: m.e, y: m.f };
      }),
    );
  const layoutStorage = () =>
    page.evaluate(() =>
      Object.entries(localStorage)
        .filter(
          ([key]) =>
            key.startsWith("java-blueprints:positions:") ||
            key.startsWith("java-blueprints:overview:"),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const basePositions = await displayPositions(),
    baseStorage = await layoutStorage();
  await target.click();
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (
      r.url().includes(f.base) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(r.method())
    )
      mutations.push(r.method() + " " + new URL(r.url()).pathname);
  });
  await revealPanel(page, "palette", "Блоки");
  await page
    .locator('[data-panel-id="palette"]')
    .getByRole("button", { name: "Оператор", exact: false })
    .click();
  await revealPanel(page, "analysis", "Анализ");
  await page.locator("#statement-source").fill("int previewOnly = 12345;");
  await revealPanel(page, "graph", "Схема");
  await expect(page.locator('[data-flow-preview="true"]')).toContainText(
    "int previewOnly = 12345;",
  );
  await expect(page.locator(".graph-preview-shape.statement")).toBeVisible();
  await expect(
    page.locator('.flow-area[data-provisional-scene="true"]'),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await displayPositions()).some((p) => {
        const original = basePositions.find((n) => n.id === p.id);
        return original && Math.abs(p.y - original.y) > 100;
      }),
    )
    .toBe(true);
  await expect(
    page.locator(".react-flow__node-blueprint.draggable"),
  ).toHaveCount(0);
  for (const kind of ["condition", "loop"] as const) {
    await revealPanel(page, "analysis", "Анализ");
    await chooseOption(
      page.getByRole("combobox", { name: "Шаблон", exact: true }),
      kind,
    );
    await revealPanel(page, "graph", "Схема");
    await expect(page.locator(".graph-preview-shape." + kind)).toBeVisible();
    await expect(
      page.locator(
        kind === "condition"
          ? ".graph-preview-branches"
          : ".graph-preview-loop",
      ),
    ).toBeVisible();
  }
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
  expect(await layoutStorage()).toEqual(baseStorage);
  expect(mutations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("palette-preview-before-prepare.png"),
    animations: "disabled",
  });
  // Keep the existing loop draft open, hover a different real palette kind,
  // then cancel. Neither the hover nor the older draft may reappear on Escape.
  await revealPanel(page, "palette", "Блоки");
  await panToNode(page, target);
  const previewCamera = await camera(page);
  await expect
    .poll(() =>
      page
        .evaluate(
          ({ project, signature }) =>
            Object.entries(localStorage)
              .filter(
                ([key]) =>
                  key.startsWith("java-blueprints:camera:v3:") &&
                  key.includes(project) &&
                  key.includes(signature),
              )
              .map(([, value]) => JSON.parse(value)),
          { project: f.id, signature: "answer(boolean)" },
        )
        .then((cameras) =>
          cameras.some((raw) => nearCamera(raw, previewCamera)),
        ),
    )
    .toBe(true);
  const palette = (await page.locator(".palette-condition").boundingBox())!;
  const anchorBox = (await target.boundingBox())!;
  await page.evaluate(() => {
    const records: unknown[] = [];
    (window as any).__graphNativeDragEvents = records;
    for (const name of [
      "dragstart",
      "dragenter",
      "dragover",
      "dragleave",
      "drop",
      "dragend",
    ]) {
      window.addEventListener(name, (event) => {
        const e = event as DragEvent;
        if (records.length >= 200) return;
        const target = e.target instanceof Element ? e.target : null;
        records.push({
          type: e.type,
          x: e.clientX,
          y: e.clientY,
          types: [...(e.dataTransfer?.types ?? [])],
          dropEffect: e.dataTransfer?.dropEffect,
          defaultPrevented: e.defaultPrevented,
          targetClass: target?.getAttribute("class"),
          nodeId: target
            ?.closest(".react-flow__node-blueprint")
            ?.getAttribute("data-id"),
          previewKind: document
            .querySelector("[data-preview-kind]")
            ?.getAttribute("data-preview-kind"),
        });
      });
    }
  });
  try {
    await page.mouse.move(
      palette.x + palette.width / 2,
      palette.y + palette.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      palette.x + palette.width / 2 + 12,
      palette.y + palette.height / 2,
      { steps: 3 },
    );
    await page.mouse.move(
      anchorBox.x + anchorBox.width / 2,
      anchorBox.y + anchorBox.height * 0.75,
      { steps: 10 },
    );
    // A separate move inside the same visible hit box issues a native dragover
    // after dragenter in browsers that coalesce the first crossing.
    await page.mouse.move(
      anchorBox.x + anchorBox.width / 2 + 1,
      anchorBox.y + anchorBox.height * 0.75 + 1,
    );
    await expect(page.locator(".graph-preview-shape.condition")).toBeVisible();
    expect(pageErrors).toEqual([]);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator('[data-flow-preview="true"]')).toHaveCount(0);
    await expect.poll(() => displayPositions()).toEqual(basePositions);
    expect(await layoutStorage()).toEqual(baseStorage);
    expect((await head(page.request, f.base)).id).toBe(f.revision.id);
    expect(pageErrors).toEqual([]);
  } finally {
    await info.attach("native-preview-page-errors", {
      body: JSON.stringify(pageErrors, null, 2),
      contentType: "application/json",
    });
    await info.attach("native-drag-events", {
      body: JSON.stringify(
        await page.evaluate(() => (window as any).__graphNativeDragEvents),
        null,
        2,
      ),
      contentType: "application/json",
    });
    // A failed assertion must not leave an active native gesture for teardown.
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
});

test("Shift marquee selects actual nodes while Space drag pans without moving source nodes", async ({
  page,
}) => {
  const f = await fixture(page);
  await method(page);
  await fit(page);
  const pair = selectedNodes(f.graph, "answer"),
    a = node(page, pair.entry.id),
    b = node(page, pair.stmt.id);
  const beforeA = await position(a),
    beforeB = await position(b);
  const ra = (await a.boundingBox())!,
    rb = (await b.boundingBox())!;
  const start = { x: Math.min(ra.x, rb.x) - 10, y: Math.min(ra.y, rb.y) - 10 };
  const end = {
    x: Math.max(ra.x + ra.width, rb.x + rb.width) + 10,
    y: Math.max(ra.y + ra.height, rb.y + rb.height) + 10,
  };
  expect(
    await page.evaluate(
      (p) =>
        document
          .elementFromPoint(p.x, p.y)
          ?.classList.contains("react-flow__pane"),
      start,
    ),
  ).toBe(true);
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(a).toHaveClass(/selected/);
  await expect(b).toHaveClass(/selected/);
  const before = await camera(page);
  // Space temporarily makes even the selected node body a pan surface.
  await page.keyboard.down("Space");
  await page.mouse.move(ra.x + ra.width / 2, ra.y + ra.height / 2);
  await page.mouse.down();
  await page.mouse.move(ra.x + ra.width / 2 + 35, ra.y + ra.height / 2 + 22, {
    steps: 8,
  });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(() => camera(page)).not.toEqual(before);
  expect(await position(a)).toEqual(beforeA);
  expect(await position(b)).toEqual(beforeB);
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
});
