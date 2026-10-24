import { expect, test, type Page } from "@playwright/test";
import { assertDistinctFalseRoutes, panToNode } from "./flowAssertions";

type LayoutNode = { type: "group"; id: string; tabs: string[]; active: string } | {
  type: "split"; id: string; axis: string; ratio: number; first: LayoutNode; second: LayoutNode;
};
type Layout = { version: number; root: LayoutNode };
const ids = ["project", "palette", "graph", "code", "analysis", "console", "tests", "changes"];
const key = (projectId: string) => "java-blueprints:workspace:v1:" + projectId;
const panels = (node: LayoutNode): string[] => node.type === "group" ? node.tabs : [...panels(node.first), ...panels(node.second)];
const groups = (node: LayoutNode): Extract<LayoutNode, { type: "group" }>[] => node.type === "group" ? [node] : [...groups(node.first), ...groups(node.second)];
async function layout(page: Page, projectId: string): Promise<Layout> {
  return page.evaluate(k => JSON.parse(localStorage.getItem(k)!), key(projectId));
}
async function createProject(page: Page) {
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Workspace acceptance " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".monaco-editor .native-edit-context")).toBeAttached();
  return page.url().split("/projects/")[1];
}
async function viewMenu(page: Page) {
  const menu = page.locator(".workspace-menu").filter({ has: page.locator("summary").filter({ hasText: /^Вид$/ }) });
  if ((await menu.getAttribute("open")) === null) await menu.locator("summary").click();
  return menu;
}
async function reset(page: Page, initial: Layout) {
  await (await viewMenu(page)).getByRole("button", { name: "Сбросить расположение", exact: true }).click();
  await expect(page.locator('[data-group-id="code"] [data-panel-header="code"]')).toHaveCount(1);
  await expect(page.locator(".workspace-group")).toHaveCount(6);
  await expect.poll(() => layout(page, page.url().split("/projects/")[1].split("/")[0])).toEqual(initial);
}
async function dragPanel(page: Page, source: string, target: string, edge: string) {
  const projectId = page.url().split("/projects/")[1].split("/")[0];
  const before = await layout(page, projectId);
  const from = page.locator(`[data-panel-tab="${source}"]`);
  const destination = page.locator(".workspace-group").filter({ has: page.locator(`[data-panel-header="${target}"]`) });
  const box = (await from.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 5 });
  const zone = destination.locator(`[data-drop-zone="${edge}"]`);
  await expect(zone).toBeVisible();
  const drop = (await zone.boundingBox())!;
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 12 });
  // A second move is needed by Chromium to deliver dragover before drop.
  await page.mouse.move(drop.x + drop.width / 2 + 1, drop.y + drop.height / 2);
  await page.mouse.up();
  await expect(page.locator(".workspace-drop-targets")).toHaveCount(0);
  await expect.poll(() => layout(page, projectId)).not.toEqual(before);
}

test("real panel drag swaps and docks on every edge; resizing and reset never mutate source", async ({ page }) => {
  const projectId = await createProject(page);
  await page.locator(".method-item").filter({ hasText: "find(" }).click();
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  await page.getByLabel("Условие", { exact: true }).fill("values[i] != target");
  const base = "/api/v1/projects/" + projectId;
  const head = (await (await page.request.get(base)).json()).data.headRevisionId;
  const original = (await (await page.request.get(base + "/revisions/" + head)).json()).data;
  const analysis = (await (await page.request.get(base + "/revisions/" + head + "/analysis")).json()).data;
  const method = analysis.graph.methods.find((m: { signature: string }) => m.signature.startsWith("find("));
  const methodNodes = new Set(analysis.graph.nodes.filter((node: { methodId: string }) => node.methodId === method.id).map((node: { id: string }) => node.id));
  const falseEdges = analysis.graph.edges.filter((edge: { kind: string; source: string }) => edge.kind === "false" && methodNodes.has(edge.source));
  expect(falseEdges).toHaveLength(2);
  expect(new Set(falseEdges.map((edge: { target: string }) => edge.target)).size).toBe(2);
  await assertDistinctFalseRoutes(page, falseEdges);
  const initial = await layout(page, projectId);
  const flowViewport = await page.locator(".react-flow__viewport").elementHandle();
  await page.locator(".react-flow__controls-zoomin").click();
  await page.waitForTimeout(350);
  const blank = await page.locator(".react-flow__pane").evaluate(pane => {
    const box = pane.getBoundingClientRect();
    for (let row = 1; row < 10; row++) for (let column = 1; column < 10; column++) {
      const x = box.x + box.width * column / 10, y = box.y + box.height * row / 10;
      if (document.elementFromPoint(x, y) === pane) return { x, y };
    }
    throw new Error("No blank graph point");
  });
  await page.keyboard.down("Space");
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x + 31, blank.y + 27, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const viewport = await page.locator(".react-flow__viewport").evaluate(node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return [matrix.a, matrix.d, matrix.e, matrix.f];
  });
  const mutations: string[] = [];
  page.on("request", request => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && request.url().includes(base))
      mutations.push(request.method() + " " + new URL(request.url()).pathname);
  });
  await page.getByRole("button", { name: "Расположение", exact: true }).click();
  await dragPanel(page, "code", "graph", "center");
  let stored = await layout(page, projectId);
  expect(groups(stored.root).find(g => g.id === "graph")?.active).toBe("code");
  expect(groups(stored.root).find(g => g.id === "code")?.active).toBe("graph");
  expect(panels(stored.root).sort()).toEqual([...ids].sort());
  for (const edge of ["left", "right", "top", "bottom"]) {
    await reset(page, initial);
    await dragPanel(page, "code", "graph", edge);
    stored = await layout(page, projectId);
    expect(panels(stored.root).sort()).toEqual([...ids].sort());
    const findDock = (n: LayoutNode): Extract<LayoutNode, { type: "split" }> | undefined => {
      if (n.type !== "split") return;
      if (panels(n).length === 2 && panels(n).includes("code") && panels(n).includes("graph")) return n;
      return findDock(n.first) ?? findDock(n.second);
    };
    const split = findDock(stored.root)!;
    expect(split).toBeTruthy();
    expect(split.axis).toBe(["left", "right"].includes(edge) ? "horizontal" : "vertical");
    expect(panels(["left", "top"].includes(edge) ? split.first : split.second)).toEqual(["code"]);
  }
  await reset(page, initial);
  await dragPanel(page, "code", "graph", "tabs");
  stored = await layout(page, projectId);
  expect(groups(stored.root).find(g => g.tabs.includes("graph"))?.tabs).toEqual(["graph", "code"]);
  expect(panels(stored.root).sort()).toEqual([...ids].sort());
  await reset(page, initial);
  const beforeCancelledDrag = await layout(page, projectId);
  const source = (await page.locator('[data-panel-tab="code"]').boundingBox())!;
  await page.mouse.move(source.x + 10, source.y + 10);
  await page.mouse.down();
  await page.mouse.move(source.x + 25, source.y + 10, { steps: 5 });
  await expect(page.locator(".workspace-drop-targets").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await layout(page, projectId)).toEqual(beforeCancelledDrag);
  const separator = page.getByRole("separator", { name: "Ширина панелей" }).first();
  const before = Number(await separator.getAttribute("aria-valuenow"));
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await separator.getAttribute("aria-valuenow"))).toBeCloseTo(before + 3, 3);
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(before + 3);
  await separator.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
  expect(Number(await separator.getAttribute("aria-valuenow"))).toBeCloseTo(Number(await separator.getAttribute("aria-valuemin")), 3);
  await reset(page, initial);
  expect(await layout(page, projectId)).toEqual(initial);
  expect(await flowViewport!.evaluate(node => node === document.querySelector(".react-flow__viewport"))).toBe(true);
  const restoredViewport = await page.locator(".react-flow__viewport").evaluate(node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return [matrix.a, matrix.d, matrix.e, matrix.f];
  });
  restoredViewport.forEach((value, index) => expect(value).toBeCloseTo(viewport[index], 2));
  await expect(page.locator(".method-item.active")).toContainText("find(");
  await expect(page.locator(".blueprint-node.IfStmt")).toHaveClass(/selected/);
  await expect(page.getByLabel("Условие", { exact: true })).toHaveValue("values[i] != target");
  expect(mutations).toEqual([]);
  expect((await (await page.request.get(base)).json()).data.headRevisionId).toBe(head);
  expect((await (await page.request.get(base + "/revisions/" + head)).json()).data).toEqual(original);
});

test("persistent editor, selection and undo survive keyboard moves, hide/reveal and maximize", async ({ page }) => {
  const projectId = await createProject(page);
  await page.locator(".method-item").filter({ hasText: "find(" }).click();
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  await expect(page.getByLabel("Условие", { exact: true })).toHaveValue("values[i] == target");
  const editor = await page.locator(".monaco-editor .native-edit-context").elementHandle();
  const host = await page.locator('[data-panel-id="code"]').elementHandle();
  await page.locator(".monaco-editor .native-edit-context").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// workspace draft marker");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect(page.locator(".monaco-editor")).toContainText("workspace draft marker");
  await page.getByRole("button", { name: "Расположение", exact: true }).click();
  await page.getByLabel("Переместить Код", { exact: true }).focus();
  await page.keyboard.press("Enter");
  const popup = page.locator(".workspace-move-menu[open]");
  await popup.getByLabel("Панель назначения").selectOption({ label: "Схема" });
  await popup.getByLabel("Способ перемещения").selectOption("center");
  await popup.getByRole("button", { name: "Переместить", exact: true }).click();
  await page.getByRole("button", { name: "Развернуть Код", exact: true }).click();
  await expect(page.locator('[data-panel-id="code"]')).toBeVisible();
  await page.getByRole("button", { name: "Восстановить панель", exact: true }).click();
  await page.getByRole("button", { name: "Скрыть Код", exact: true }).click();
  await expect(page.locator('[data-panel-id="code"]')).not.toBeVisible();
  await expect(page.locator('[data-panel-id="code"]')).toHaveAttribute("inert", "");
  await (await viewMenu(page)).getByRole("button", { name: /Код/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-panel-id="code"]')).toBeVisible();
  expect(await host!.evaluate(node => node === document.querySelector('[data-panel-id="code"]'))).toBe(true);
  expect(await editor!.evaluate(node => node === document.querySelector(".monaco-editor .native-edit-context"))).toBe(true);
  await expect(page.locator(".monaco-editor")).toContainText("workspace draft marker");
  await page.locator(".monaco-editor .native-edit-context").focus();
  // Replacing the selected final word verifies the actual caret/selection survives.
  await page.keyboard.insertText("selection_kept");
  await expect(page.locator(".monaco-editor")).toContainText("workspace draft selection_kept");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".monaco-editor")).toContainText("workspace draft marker");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".monaco-editor")).not.toContainText("workspace draft marker");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".monaco-editor")).toContainText("workspace draft marker");
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    for (const [command, present] of [["Отменить", false], ["Повторить", true]] as const) {
      await page.getByRole("button", { name: "Скрыть Код", exact: true }).click();
      await expect(page.locator('[data-panel-id="code"]')).not.toBeVisible();
      const editMenu = page.locator(".workspace-menu").filter({ has: page.locator("summary").filter({ hasText: /^Правка$/ }) });
      await editMenu.locator("summary").click();
      await editMenu.getByRole("button", { name: command, exact: false }).click();
      await expect(page.locator('[data-panel-id="code"]')).toBeVisible();
      if (present) await expect(page.locator(".monaco-editor")).toContainText("workspace draft marker");
      else await expect(page.locator(".monaco-editor")).not.toContainText("workspace draft marker");
      await expect(page.locator(".monaco-editor .native-edit-context")).toBeFocused();
    }
  }
  expect(groups((await layout(page, projectId)).root).some(g => g.tabs.includes("code"))).toBe(true);
});

test("layout persists per project, invalid preferences recover, and narrow chooser preserves desktop tree", async ({ page }) => {
  const first = await createProject(page);
  const initial = await layout(page, first);
  await (await viewMenu(page)).getByRole("button", { name: "Работа с кодом", exact: true }).click();
  await expect.poll(() => layout(page, first)).not.toEqual(initial);
  const changed = await layout(page, first);
  expect(changed).not.toEqual(initial);
  await page.reload();
  await expect(page.locator('[data-panel-id="code"]')).toBeVisible();
  expect(await layout(page, first)).toEqual(changed);
  const second = await createProject(page);
  expect(await layout(page, second)).toEqual(initial);
  await page.goto("/projects/" + first);
  await expect(page.locator('[data-panel-id="code"]')).toBeVisible();
  expect(await layout(page, first)).toEqual(changed);
  await page.setViewportSize({ width: 390, height: 844 });
  const chooser = page.getByLabel("Открытая панель");
  await expect(chooser).toBeVisible();
  for (const id of ids) {
    await chooser.selectOption(id);
    await expect(page.locator(`[data-panel-id="${id}"]`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  // Choosing a tab can change active tabs; split topology and dimensions remain intact.
  const shape = (n: LayoutNode): unknown => n.type === "group" ? { id: n.id, tabs: n.tabs } : { id: n.id, axis: n.axis, ratio: n.ratio, first: shape(n.first), second: shape(n.second) };
  expect(shape((await layout(page, first)).root)).toEqual(shape(changed.root));
  for (const invalid of ["{bad-json", JSON.stringify({ version: 99, root: initial.root }), JSON.stringify({ version: 1, root: { ...initial.root, ratio: 400 } }), JSON.stringify({ version: 1, root: { type: "group", id: "bad", active: "code", tabs: ["code", "code"] } }), JSON.stringify({ version: 1, root: { type: "group", id: "bad", active: "unknown", tabs: ["unknown"] } })]) {
    await page.evaluate(({ k, value }) => localStorage.setItem(k, value), { k: key(first), value: invalid });
    await page.reload();
    await expect(page.locator('[data-panel-id="graph"]')).toBeVisible();
    expect(await layout(page, first)).toEqual(initial);
  }
});
