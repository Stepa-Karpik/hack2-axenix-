import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { panToNode, revealPanel } from "./flowAssertions";
import { presets, defaultPreference } from "../src/themePalette";

// Opt-in read-only visual acceptance: use an actual parser analysis captured from
// the documented, source-verified OrderService showcase. All browser API traffic
// is intercepted; neither Java execution nor persistent project writes occur.
const fixturePath = process.env.JB_THEME_FIXTURE_PATH;
const sample = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8").replace(/^\uFEFF/, "")) : null;
test.skip(!sample, "Set JB_THEME_FIXTURE_PATH to the source-verified OrderService analysis snapshot");
const user = { id: "d1111111-1111-4111-8111-111111111111", username: "showcase", displayName: "Showcase", bio: "", authMethod: "password", emailVerified: true };
const custom = { background: "#eef4fb", surface: "#ffffff", text: "#182332", muted: "#47576a", accent: "#205ea3" };
async function fixture(page: Page, preset: string) {
  expect(sample.verifiedAgainst).toBe("docs/work/phase26/showcase/showcase.spec.ts");
  expect(sample.fetchedReadOnly).toBe(true);
  expect(sample.revision.files).toHaveLength(3);
  expect(sample.revision.files.find((f: any) => f.path === "src/OrderService.java").canonicalText).toContain("total += order.amount();");
  expect(sample.analysis.parseStatus).toBe("valid");
  expect(sample.analysis.graph.nodes.length).toBeGreaterThan(20);
  const project = { ...sample.project, ownerId: user.id, role: "owner", canEdit: true };
  const writes: string[] = [];
  await page.addInitScript(({ id, preset, palette }) => {
    if (!localStorage.getItem("java-blueprints:appearance")) localStorage.setItem("java-blueprints:appearance", JSON.stringify({ preset, custom: palette }));
    for (const scope of ["settings", "profile", "home", "workspace"]) localStorage.setItem(`java-blueprints:onboarding:v1:${id}:${scope}`, "done");
  }, { id: user.id, preset, palette: preset === "custom" ? custom : defaultPreference.custom });
  await page.context().route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: { code: "FIXTURE_UNEXPECTED_WRITE", message: "Read-only visual fixture" } } });
    }
    let data: unknown;
    if (path === "/api/v1/session") data = { mode: "authenticated", csrfToken: "fixture-csrf", user, capabilities: { registration: true, emailDelivery: false, legacyGuestWorkspace: false, projectCreation: true, projectExport: true } };
    else if (path === "/api/v1/capabilities") data = sample.capabilities;
    else if (path === `/api/v1/projects/${project.id}`) data = project;
    else if (path.endsWith(`/revisions/${sample.revision.id}/analysis`)) data = sample.analysis;
    else if (path.endsWith(`/revisions/${sample.revision.id}/layout`)) {
      const methodId = new URL(request.url()).searchParams.get("methodId");
      data = { analysisId: sample.analysis.id, methodId, positions: [], viewport: null, layoutVersion: 0 };
    } else if (path.endsWith(`/revisions/${sample.revision.id}`)) data = sample.revision;
    else if (path.endsWith("/revisions")) data = [sample.revision];
    else if (path === "/api/v1/profile") data = user;
    else if (path === "/api/v1/projects") data = [project];
    else if (path === "/api/v1/github/status") data = { configured: false, linked: null, repositoryAccess: false };
    else data = [];
    return route.fulfill({ json: { data, meta: { requestId: "theme-fixture" } } });
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator(".blueprint-node").first()).toBeAttached();
  await revealPanel(page, "project", "Проект");
  await page.locator('[data-file-path="src/OrderService.java"]').click();
  await page.locator(".method-item").filter({ hasText: /^calculateTotal\(/ }).click();
  await revealPanel(page, "graph", "Схема");
  await page.getByRole("button", { name: "Показать всю схему", exact: true }).click();
  await expect(page.locator('.flow-area[data-graph-view="method"]')).toBeVisible();
  return { writes, project };
}

async function contrastOf(target: Locator) {
  return target.evaluate(element => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (value: string) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, pixel[3] / 255];
    };
    const over = (fg: number[], bg: number[]) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    let bg = [1, 1, 1, 1];
    for (const node of ancestors) bg = over(rgba(getComputedStyle(node).backgroundColor), bg);
    const style = getComputedStyle(element), fg = over(rgba(style.color), bg);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const a = luminance(fg), b = luminance(bg);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), color: style.color, background: style.backgroundColor, text: element.textContent?.slice(0, 100) };
  });
}
async function contrast(page: Page, selector: string, minimum = 4.5) {
  const elements = page.locator(selector).filter({ visible: true });
  expect(await elements.count(), `Visible sample: ${selector}`).toBeGreaterThan(0);
  for (const element of await elements.all()) {
    await expect.poll(async () => (await contrastOf(element)).ratio, { message: `Settled theme contrast: ${selector}` }).toBeGreaterThanOrEqual(minimum);
  }
}
async function canvas(page: Page, preset: string) {
  const theme = preset === "custom" ? custom : presets.find(p => p.id === preset)!;
  const dark = !["light", "pearl", "custom"].includes(preset);
  await expect(page.locator("html")).toHaveAttribute("data-theme", dark ? "dark" : "light");
  const expected = await page.evaluate(hex => {
    const node = document.createElement("div"); node.style.color = hex; document.body.append(node);
    const value = getComputedStyle(node).color; node.remove(); return value;
  }, theme.background);
  for (const selector of [".workbench", ".workspace-canvas-background", ".graph-pane", ".flow-area", ".flow-area .react-flow", ".react-flow__background"]) {
    await expect(page.locator(selector).first(), selector).toHaveCSS("background-color", expected);
  }
  await expect(page.locator(".react-flow__renderer")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".react-flow__background pattern circle")).toBeAttached();
  if (!dark) {
    await contrast(page, ".canvas-heading h1, .canvas-heading p, .canvas-breadcrumb");
    await contrast(page, ".blueprint-node .node-label, .blueprint-node .node-meta span");
    await contrast(page, ".workspace-panel-tabs > button");
    await contrast(page, ".workspace-dock button");
    await contrast(page, ".shortcut-label.branch-label");
  }
}

async function readableFrame(page: Page) {
  await page.getByRole("button", { name: "Показать всю схему", exact: true }).click();
  for (let i = 0; i < 7; i++) await page.locator(".react-flow__controls-zoomin").click();
  const entry = page.locator(".blueprint-node.entry").first();
  await panToNode(page, entry);
  const point = await page.locator(".react-flow__pane").evaluate(pane => {
    const area = document.querySelector("[data-graph-aperture]")!.getBoundingClientRect();
    for (let row = 2; row < 8; row++) for (let column = 2; column < 8; column++) {
      const x = area.x + area.width * column / 10, y = area.y + area.height * row / 10;
      if (document.elementFromPoint(x, y) === pane) return { x, y };
    }
    throw new Error("No empty canvas pan target");
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.down("Space");
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x, point.y - 170, { steps: 8 });
  await page.mouse.up(); await page.keyboard.up("Space");
  await expect(entry).toBeInViewport();
  expect(await page.locator(".react-flow__viewport").evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeGreaterThan(.65);
}

for (const preset of ["light", "pearl", "custom", "dark", "oled"]) {
  test(`real OrderService canvas and controls follow ${preset} palette`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1536, height: 1024 });
    const state = await fixture(page, preset);
    await canvas(page, preset);
    const condition = page.locator(".blueprint-node.condition_test").filter({ hasText: "orders == null" });
    await panToNode(page, condition);
    await condition.click();
    await revealPanel(page, "analysis", "Анализ");
    await expect(page.locator(".inspector-selection")).toContainText("orders == null");
    if (preset !== "dark") await contrast(page, ".inspector-selection h2, .inspector-selection .quiet, .inspector-selection .eyebrow");
    await page.getByRole("button", { name: "Показать всю схему", exact: true }).click();
    await page.screenshot({ path: info.outputPath(`workbench-${preset}.png`), animations: "disabled" });
    if (preset === "light") {
      await readableFrame(page);
      await expect(page.getByText(/Запуск недоступен: runner/)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("workbench-light-readable.png"), animations: "disabled" });
      if (process.env.JB_THEME_README_PATH) await page.screenshot({ path: process.env.JB_THEME_README_PATH, animations: "disabled" });
    }
    const menu = page.locator(".global-command-menu .workspace-menu").filter({ has: page.locator("summary").filter({ hasText: /^Вид$/ }) });
    await menu.locator(":scope > summary").click();
    await expect(menu.locator(".workspace-menu-popup")).toBeVisible();
    if (preset !== "dark") await contrast(page, ".workspace-menu-popup button:not(:disabled)");
    await page.screenshot({ path: info.outputPath(`workbench-${preset}-menu.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator(".blueprint-node").first()).toBeAttached();
    await canvas(page, preset);
    expect(state.writes).toEqual([]);
  });
}

test("appearance switching reaches mounted canvas and survives reload", async ({ page }) => {
  const state = await fixture(page, "dark");
  await canvas(page, "dark");
  const appearance = await page.context().newPage();
  await appearance.goto("/settings/appearance");
  await appearance.locator(".theme-options").getByRole("button", { name: "Светлая", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "light");
  await canvas(page, "light");
  await appearance.close();
  await page.reload();
  await expect(page.locator(".blueprint-node").first()).toBeAttached();
  await canvas(page, "light");
  expect(state.writes).toEqual([]);
});
