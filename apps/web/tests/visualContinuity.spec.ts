import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

const source = `public class Main {
  static int choose(int value) { if (value > 0) return 1; return 0; }
  static int guarded(Object lock) { synchronized (lock) { return 2; } }
}\n`;
async function fixture(page: Page) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Visual continuity " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id,
    base = "/api/v1/projects/" + id;
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

test("all seven rendered themes retain black canvas, flat glass, distinct borders and an unobstructed dock", async ({
  page,
  context,
}, info) => {
  const f = await fixture(page);
  await page.goto("/projects/" + f.id);
  await expect(
    page.getByRole("button", { name: "choose(int)", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page.getByRole("button", { name: "choose(int)", exact: true }).click();
  const appearance = await context.newPage();
  await appearance.goto("/settings/appearance");
  for (const [preset, label] of [
    ["oled", "OLED"],
    ["dark", "Тёмная"],
    ["light", "Светлая"],
    ["pearl", "Жемчужная"],
    ["blue", "Синяя"],
    ["amber", "Янтарная"],
    ["slate", "Сланцевая"],
  ]) {
    await appearance.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preset",
      preset,
    );
    await page.bringToFront();
    await expect(page.locator(".flow-area")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await expect(page.locator(".workbench")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    const material = await page
      .locator('[data-tile-panel="code"]')
      .evaluate((element) => {
        const style = getComputedStyle(element),
          pixel = document.createElement("canvas").getContext("2d")!;
        const rgba = (color: string) => {
          pixel.clearRect(0, 0, 1, 1);
          pixel.fillStyle = color;
          pixel.fillRect(0, 0, 1, 1);
          return [...pixel.getImageData(0, 0, 1, 1).data];
        };
        return {
          fill: rgba(style.backgroundColor),
          border: rgba(style.borderTopColor),
          blur: style.backdropFilter,
          shadow: style.boxShadow,
        };
      });
    expect(material.fill[3]).toBe(224);
    expect(material.border[3]).toBeGreaterThanOrEqual(56);
    expect(material.blur).toBe("blur(24px) saturate(1.1)");
    expect(material.shadow).toBe("none");
    if (preset === "oled" || preset === "dark")
      expect(material.fill.slice(0, 3)).toEqual([5, 5, 5]);
    const dock = (await page.locator(".workspace-dock-row").boundingBox())!;
    for (const panel of await page.locator("[data-tile-panel]").all()) {
      const box = await panel.boundingBox();
      if (box) expect(box.y + box.height).toBeLessThanOrEqual(dock.y + 1);
    }
    await page.screenshot({
      path: info.outputPath("theme-" + preset + ".png"),
      animations: "disabled",
    });
  }
  await appearance.close();
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
});

test("loading remains black and opaque/read-only notices occupy layout instead of covering controls", async ({
  page,
}, info) => {
  const f = await fixture(page);
  // A viewer reads the owner's existing analysis; it must not acquire write
  // permissions merely to populate this rendered viewer-state fixture.
  const analysisPath = f.base + "/revisions/" + f.revision.id + "/analysis";
  const started = await page.request.post(analysisPath, {
    headers: await headers(page.request),
    data: {},
  });
  expect(started.status()).toBe(202);
  let analysis: any;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(analysisPath);
        expect([200, 404]).toContain(response.status());
        if (response.status() !== 200) return false;
        analysis = (await response.json()).data;
        return analysis.revisionId === f.revision.id;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  expect(analysis.graph.nodes.some((node: any) => node.kind === "opaque")).toBe(
    true,
  );
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/revisions/*/analysis", async (route) => {
    await loading;
    await route.continue();
  });
  await page.route("**/api/v1/projects/" + f.id, async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    // A rendered viewer state; backend permission behavior is tested separately.
    await route.fulfill({
      response,
      json: { ...body, data: { ...body.data, canEdit: false, role: "viewer" } },
    });
  });
  await page.goto("/projects/" + f.id);
  try {
    await expect(page.locator(".workspace-canvas-background")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await expect(page.locator(".workspace-notices")).toContainText(
      "Проект открыт для просмотра",
    );
    const notices = (await page.locator(".workspace-notices").boundingBox())!,
      workspace = (await page
        .locator(".configurable-workspace")
        .boundingBox())!,
      header = (await page.locator(".glass-topbar").boundingBox())!;
    expect(notices.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(notices.y + notices.height).toBeLessThanOrEqual(workspace.y + 1);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "guarded(Object)", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page
    .getByRole("button", { name: "guarded(Object)", exact: true })
    .click();
  await revealPanel(page, "analysis", "Анализ");
  const notice = page.getByTestId("opaque-method-notice");
  await expect(notice).toBeVisible();
  const rect = (await notice.boundingBox())!,
    controls = (await page.locator(".insight-tabs").boundingBox())!;
  expect(rect.y + rect.height).toBeLessThanOrEqual(controls.y + 1);
  expect(await notice.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await page.getByRole("tab", { name: "Проблемы", exact: false }).click();
  await expect(page.locator(".analysis-diagnostics")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("opaque-viewer-layout.png"),
    animations: "disabled",
  });
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
});
