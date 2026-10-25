import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { assertRoutes, panToNode, revealPanel } from "./flowAssertions";

// Every test owns a fresh browser context and guest projects. Requests go to the
// real production app/API; no registration, email, mocked graph or Vite imports.
const source = `public class Main {
  static int answer(boolean ready) {
    if (ready) return 1;
    return 0;
  }
  static int other() { return 7; }
}
`;
async function fixture(page: Page) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Canvas stability " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id as string;
  const base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      intent: "semantic_edit",
      files: [{ path: "Main.java", content: source }],
    },
  });
  expect(saved.status()).toBe(201);
  return { id, base, revision: (await saved.json()).data };
}
async function open(page: Page, id: string) {
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 30000,
  });
  await revealPanel(page, "project", "Проект");
  await page
    .locator(".method-item")
    .filter({ hasText: /^answer\(/ })
    .click();
  await revealPanel(page, "code", "Код");
  await expect(page.locator(".monaco-editor textarea.inputarea")).toBeVisible();
  await expect(page.locator(".blueprint-node.ReturnStmt")).toHaveCount(2);
}
async function camera(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}
async function position(page: Page, id: string) {
  return page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f };
    });
}
async function analysis(page: Page, base: string, revision: string) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const response = await page.request.get(
      base + "/revisions/" + revision + "/analysis",
    );
    const body = await response.json();
    if (response.ok()) {
      expect(body.data.revisionId).toBe(revision);
      return body.data;
    }
    // Saving advances head before the asynchronous analysis is available. Only
    // this documented transient response is retryable; surface all other HTTP
    // failures immediately instead of masking auth, network or server errors.
    if (
      response.status() !== 404 ||
      body.error?.code !== "ANALYSIS_NOT_READY"
    ) {
      throw new Error(
        "Analysis request failed: HTTP " +
          response.status() +
          " " +
          JSON.stringify(body),
      );
    }
    if (Date.now() >= deadline)
      throw new Error(
        "Analysis not ready for saved revision " +
          revision +
          " after 30 seconds",
      );
    await page.waitForTimeout(200);
  }
}
function answerNodes(data: any) {
  const method = data.graph.methods.find((m: any) =>
    m.signature.startsWith("answer("),
  );
  const nodes = data.graph.nodes.filter((n: any) => n.methodId === method.id);
  return {
    method,
    nodes,
    yes: nodes.find(
      (n: any) => n.kind === "ReturnStmt" && n.label.includes("return 1"),
    ),
    check: nodes.find((n: any) => n.kind === "condition_test"),
  };
}
async function panAndZoom(page: Page) {
  const point = await page.locator(".react-flow__pane").evaluate((pane) => {
    const area =
      document
        .querySelector("[data-graph-aperture]")
        ?.getBoundingClientRect() ?? pane.getBoundingClientRect();
    for (let row = 1; row < 10; row++)
      for (let column = 1; column < 10; column++) {
        const x = area.x + (area.width * column) / 10,
          y = area.y + (area.height * row) / 10;
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    return null;
  });
  expect(point).not.toBeNull();
  const zoomBefore = (await camera(page)).zoom;
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(zoomBefore);
  await page.mouse.down();
  await page.mouse.move(point!.x - 45, point!.y + 25, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

test("real source save and late layout keep camera/manual coordinates across regenerated IDs; method and project cameras are separate", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const a = await fixture(page),
    b = await fixture(page);
  await open(page, a.id);
  const beforeAnalysis = await analysis(page, a.base, a.revision.id);
  const before = answerNodes(beforeAnalysis);
  const yes = page.locator(`.react-flow__node[data-id="${before.yes.id}"]`);
  await panToNode(page, yes);
  const startPosition = await position(page, before.yes.id);
  const box = (await yes.boundingBox())!;
  const layoutSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response
        .url()
        .includes(a.base + "/revisions/" + a.revision.id + "/layout"),
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 - 35,
    box.y + box.height / 2 + 12,
    { steps: 6 },
  );
  await page.mouse.up();
  expect((await layoutSaved).ok()).toBe(true);
  const movedPosition = await position(page, before.yes.id);
  expect(movedPosition).not.toEqual(startPosition);
  await panAndZoom(page);
  const savedCamera = await camera(page);
  const delayedLayouts: string[] = [];
  await page.route(
    "**/api/v1/projects/" + a.id + "/revisions/*/layout*",
    async (route) => {
      if (
        route.request().method() === "GET" &&
        !route.request().url().includes(a.revision.id)
      ) {
        delayedLayouts.push(route.request().url());
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      await route.continue();
    },
  );
  const newLayout = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes(a.base + "/revisions/") &&
      response.url().includes("/layout?") &&
      !response.url().includes(a.revision.id),
  );
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("// source save shifts every source range\n");
  await page.keyboard.press("Control+s");
  await expect
    .poll(async () => (await head(page.request, a.base)).id)
    .not.toBe(a.revision.id);
  const current = await head(page.request, a.base);
  expect(current.files[0].canonicalText).toBe(
    "// source save shifts every source range\n" + source,
  );
  const afterAnalysis = await analysis(page, a.base, current.id),
    after = answerNodes(afterAnalysis);
  expect(afterAnalysis.id).not.toBe(beforeAnalysis.id);
  expect(after.method.id).not.toBe(before.method.id);
  expect(after.yes.id).not.toBe(before.yes.id);
  await expect(
    page.locator(`.react-flow__node[data-id="${after.yes.id}"]`),
  ).toHaveCount(1);
  expect(await camera(page)).toEqual(savedCamera);
  expect((await newLayout).ok()).toBe(true);
  expect(delayedLayouts.length).toBeGreaterThan(0);
  await page.waitForTimeout(150);
  expect(await camera(page)).toEqual(savedCamera);
  expect(await position(page, after.yes.id)).toEqual(movedPosition);
  await page.screenshot({
    path: testInfo.outputPath("same-method-after-real-save.png"),
    animations: "disabled",
  });

  await page
    .locator(".method-item")
    .filter({ hasText: /^other\(/ })
    .click();
  await expect.poll(() => camera(page)).not.toEqual(savedCamera);
  await panAndZoom(page);
  const otherCamera = await camera(page);
  await page
    .locator(".method-item")
    .filter({ hasText: /^answer\(/ })
    .click();
  await expect.poll(() => camera(page)).toEqual(savedCamera);
  await page
    .locator(".method-item")
    .filter({ hasText: /^other\(/ })
    .click();
  await expect.poll(() => camera(page)).toEqual(otherCamera);
  await page
    .locator(".method-item")
    .filter({ hasText: /^answer\(/ })
    .click();
  await expect.poll(() => camera(page)).toEqual(savedCamera);
  await open(page, b.id);
  await expect.poll(() => camera(page)).not.toEqual(savedCamera);
  await open(page, a.id);
  await expect.poll(() => camera(page)).toEqual(savedCamera);
  expect(await position(page, after.yes.id)).toEqual(movedPosition);
  expect((await head(page.request, b.base)).id).toBe(b.revision.id);
});

test("actual if-return yes/no edges leave separate sides and do not cross nodes, labels or each other", async ({
  page,
}, testInfo) => {
  const fixtureData = await fixture(page);
  await open(page, fixtureData.id);
  const data = await analysis(page, fixtureData.base, fixtureData.revision.id),
    { check } = answerNodes(data);
  await assertRoutes(page);
  const edges = data.graph.edges.filter(
    (edge: any) =>
      edge.source === check.id && ["true", "false"].includes(edge.kind),
  );
  expect(edges).toHaveLength(2);
  const geometry = await page.evaluate(
    ({ edges }) =>
      edges.map((edge: any) => {
        const path = document.querySelector(
          `g[data-route-source="${edge.source}"][data-route-target="${edge.target}"] path`,
        ) as SVGPathElement;
        const matrix = path.getScreenCTM()!;
        const samples = Array.from({ length: 251 }, (_, i) => {
          const point = path.getPointAtLength(
            (path.getTotalLength() * i) / 250,
          );
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          return { x: screen.x, y: screen.y };
        });
        const otherLabels = Array.from(
          document.querySelectorAll(".branch-label"),
        )
          .filter(
            (label) =>
              label.textContent !== (edge.kind === "true" ? "да" : "нет"),
          )
          .map((label) => {
            const r = label.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          });
        return { kind: edge.kind, samples, otherLabels };
      }),
    { edges },
  );
  const yes = geometry.find((path) => path.kind === "true")!,
    no = geometry.find((path) => path.kind === "false")!;
  expect(yes.samples[1].x).toBeLessThan(yes.samples[0].x);
  expect(no.samples[1].x).toBeGreaterThan(no.samples[0].x);
  const minimumSeparation = Math.min(
    ...yes.samples.flatMap((a) =>
      no.samples.map((b) => Math.hypot(a.x - b.x, a.y - b.y)),
    ),
  );
  expect(minimumSeparation).toBeGreaterThan(2);
  for (const path of geometry)
    for (const point of path.samples)
      for (const label of path.otherLabels)
        expect(
          point.x > label.left + 1 &&
            point.x < label.right - 1 &&
            point.y > label.top + 1 &&
            point.y < label.bottom - 1,
        ).toBe(false);
  await expect(
    page.locator(".branch-label").filter({ hasText: /^да$/ }),
  ).toHaveCount(1);
  await expect(
    page.locator(".branch-label").filter({ hasText: /^нет$/ }),
  ).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("actual-if-return-routes.png"),
    animations: "disabled",
  });
});
