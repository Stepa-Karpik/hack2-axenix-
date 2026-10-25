import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {mount} from "./polishFixtures";
import { revealPanel } from "./flowAssertions";

const showcasePath = process.env.JB_THEME_FIXTURE_PATH;
const largePath = process.env.JB_LARGE_GRAPH_FIXTURE_PATH;
const load = (path: string) =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
async function viewMenu(page: Page) {
  const menu = page
    .locator(".global-command-menu .workspace-menu")
    .filter({ has: page.locator("summary").filter({ hasText: /^Вид$/ }) });
  if ((await menu.getAttribute("open")) === null)
    await menu.locator(":scope > summary").click();
  return menu;
}

test("layout save, restore, project reload and reusable default preserve hidden windows and navigation", async ({
  page,
}, info) => {
  test.skip(
    !showcasePath,
    "Set JB_THEME_FIXTURE_PATH to a captured real analysis",
  );
  const sample = load(showcasePath!);
  await page.addInitScript(id => localStorage.setItem(`java-blueprints:window-state:${id}`, JSON.stringify({ focused: "navigation", maximized: "navigation", collapsedNavigation: true })), sample.project.id);
  const { project, writes } = await mount(page, sample);
  const nav = page.getByRole("button", { name: "JavaBlueprints — навигация" });
  await expect(nav).toHaveAttribute("aria-expanded", "false");
  expect((await nav.boundingBox())!.x).toBeLessThan(25);
  const search = page.locator(".project-command-search");
  const before = (await search.boundingBox())!.x;
  await nav.click();
  await expect(nav).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(async () => (await search.boundingBox())!.x)
    .toBeGreaterThan(before + 40);
  await expect(page.locator(".topbar-navigation-body")).toBeVisible();
  await nav.click();
  let menu = await viewMenu(page);
  await menu.getByRole("button", { name: /Код Java$/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-tile-panel="code"]')).toHaveCount(0);
  menu = await viewMenu(page);
  await menu
    .getByRole("button", {
      name: "Сохранить расположение проекта",
      exact: true,
    })
    .click();
  const saved = await page.evaluate(
    (id) => localStorage.getItem(`java-blueprints:workspace-saved:v1:${id}`),
    project.id,
  );
  expect(JSON.parse(saved!).layout.hidden).toContain("code");
  menu = await viewMenu(page);
  await menu
    .getByRole("button", { name: "Сделать расположение базовым", exact: true })
    .click();
  await revealPanel(page, "code", "Код Java");
  menu = await viewMenu(page);
  await menu
    .getByRole("button", { name: "Сбросить расположение", exact: true })
    .click();
  await expect(page.locator('[data-tile-panel="code"]')).toHaveCount(0);
  await page.reload();
  await expect(nav).toBeVisible();
  await expect(page.locator('[data-tile-panel="code"]')).toHaveCount(0);
  const other = structuredClone(sample);
  other.project.id = "c1111111-1111-4111-8111-111111111111";
  await mount(page, other);
  await expect(page.locator('[data-tile-panel="code"]')).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("saved-workspace.png"),
    animations: "disabled",
  });
});

for (const key of ["s", "ы"])
  test(`Ctrl+S downloads active file and its unsaved text with ${key} physical key`, async ({
    page,
  }) => {
    test.skip(
      !showcasePath,
      "Set JB_THEME_FIXTURE_PATH to a captured real analysis",
    );
    const sample = load(showcasePath!);
    const { writes } = await mount(page, sample);
    await revealPanel(page, "project", "Проект");
    const file = sample.revision.files.find((f: any) =>
      f.path.endsWith("OrderService.java"),
    );
    await page.locator(`[data-file-path="${file.path}"]`).click();
    await revealPanel(page, "code", "Код Java");
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await editor.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\n// unsaved local download\n");
    const download = page.waitForEvent("download");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code: "KeyS",
      windowsVirtualKeyCode: 83,
      modifiers: 2,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: "KeyS",
      windowsVirtualKeyCode: 83,
      modifiers: 2,
    });
    const result = await download;
    expect(result.suggestedFilename()).toBe("OrderService.java");
    expect(readFileSync((await result.path())!, "utf8")).toBe(
      file.canonicalText + "\n// unsaved local download\n",
    );
    expect(writes).toEqual([]);
    await cdp.detach();
  });

test("project actions follow the chosen accent and Appearance omits contrast statistics", async ({
  page,
}) => {
  test.skip(
    !showcasePath,
    "Set JB_THEME_FIXTURE_PATH to a captured real analysis",
  );
  await mount(page, load(showcasePath!));
  await page.goto("/projects");
  await expect(page.locator(".sample-icon")).toHaveCSS(
    "color",
    "rgb(181, 138, 255)",
  );
  const appearance = await page.context().newPage();
  await appearance.goto("/settings/appearance");
  await expect(
    appearance.getByText("Контраст текста:", { exact: false }),
  ).toHaveCount(0);
  await appearance.getByLabel("Акцент", { exact: true }).fill("#9fc5ff");
  await appearance
    .getByRole("button", { name: "Применить свою палитру" })
    .click();
  await expect(page.locator(".sample-icon")).toHaveCSS(
    "color",
    "rgb(159, 197, 255)",
  );
  await expect(page.locator(".projects-page button.primary").first()).toHaveCSS(
    "background-color",
    "rgb(159, 197, 255)",
  );
  await appearance.close();
});

test("large real graph pans and zooms without blocking the editor thread", async ({
  page,
}, info) => {
  test.skip(
    !largePath,
    "Set JB_LARGE_GRAPH_FIXTURE_PATH to a captured real project analysis",
  );
  const sample = load(largePath!);
  expect(sample.analysis.graph.nodes.length).toBeGreaterThan(1000);
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  const opened = Date.now();
  const { writes } = await mount(page, sample);
  const firstPaintMs = Date.now() - opened;
  const area = page.locator(".flow-area");
  await expect(area).toHaveClass(/flow-large/);
  expect(firstPaintMs).toBeLessThan(5000);
  await page
    .getByRole("button", { name: "JavaBlueprints — навигация" })
    .click({ timeout: 1500 });
  await page
    .getByRole("button", { name: "JavaBlueprints — навигация" })
    .click({ timeout: 1500 });
  await expect(area).toHaveAttribute("data-routing-state", "ready", {
    timeout: 60000,
  });
  const routesReadyMs = Date.now() - opened;
  expect(workers.some((url) => /flowRoutes\.worker/.test(url))).toBe(true);
  await expect(page.locator(".blueprint-node").first()).toHaveCSS(
    "backdrop-filter",
    "none",
  );
  await page
    .getByRole("button", { name: "Показать всю схему", exact: true })
    .click();
  await page.evaluate(() => {
    const target = window as any;
    target.framesDuringPan = [];
    target.panFrame = performance.now();
    target.samplingPan = true;
    const frame = (now: number) => {
      target.framesDuringPan.push(now - target.panFrame);
      target.panFrame = now;
      if (target.samplingPan) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const box = await page.locator("[data-graph-aperture]").boundingBox();
  const panPoint = await page.evaluate(() => {
    const area = document.querySelector("[data-graph-aperture]")!.getBoundingClientRect();
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) {
      const point = { x: area.x + area.width * x / 10, y: area.y + area.height * y / 10 };
      if (document.elementFromPoint(point.x, point.y)?.classList.contains("react-flow__pane")) return point;
    }
    throw new Error("No unobstructed graph pan target");
  });
  await page.mouse.click(panPoint.x, panPoint.y);
  await page.keyboard.down("Space");
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down();
  await page.mouse.move(panPoint.x + 10, panPoint.y + 8, { steps: 2 });
  await expect(page.locator(".workbench")).toHaveAttribute("data-canvas-moving", "true");
  const duringPan = await page.evaluate(() => ({
    moving: document
      .querySelector(".workbench")
      ?.getAttribute("data-canvas-moving"),
    blur: getComputedStyle(
      document.querySelector(".workspace-group.glass-tile")!,
    ).backdropFilter,
    detail: document
      .querySelector(".flow-area")
      ?.getAttribute("data-detail-level"),
    mountedNodes: document.querySelectorAll(".react-flow__node-blueprint")
      .length,
  }));
  expect(duringPan.blur).toBe("none");
  await page.mouse.move(
    panPoint.x + 140,
    panPoint.y + 90,
    { steps: 35 },
  );
  await page.mouse.up();
  await page.keyboard.up("Space");
  await page.mouse.wheel(0, -180);
  await page
    .getByRole("button", { name: "JavaBlueprints — навигация" })
    .click({ timeout: 1500 });
  const timings = await page.evaluate(() => {
    const w = window as any;
    w.samplingPan = false;
    return w.framesDuringPan as number[];
  });
  expect(timings.length).toBeGreaterThan(10);
  expect(Math.max(...timings), JSON.stringify(timings)).toBeLessThan(1000);
  expect(timings.reduce((sum, value) => sum + value, 0) / timings.length).toBeLessThan(50);
  writeFileSync(
    info.outputPath("timings.json"),
    JSON.stringify(
      {
        firstPaintMs,
        routesReadyMs,
        maximumFrameMs: Math.max(...timings),
        duringPan,
        workers: workers.length,
        frames: timings,
      },
      null,
      2,
    ),
  );
  await info.attach("pan-frame-times", {
    body: JSON.stringify({
      rawNodes: sample.analysis.graph.nodes.length,
      edges: sample.analysis.graph.edges.length,
      maximumMs: Math.max(...timings),
      frames: timings,
    }),
    contentType: "application/json",
  });
  expect(writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("large-graph.png"),
    animations: "disabled",
  });
});
