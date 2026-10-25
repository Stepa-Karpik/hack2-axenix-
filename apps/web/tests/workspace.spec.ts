import { chooseOption } from "./selectControl";
import { test, expect, type Page } from "@playwright/test";
import { panToNode } from "./flowAssertions";
const key = (id: string) => "java-blueprints:workspace:v2:" + id;
const stored = (page: Page, id: string) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), key(id));
async function create(page: Page) {
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Workspace " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.locator(".monaco-editor textarea.inputarea"),
  ).toBeAttached();
  await page.waitForTimeout(350);
  return page.url().split("/projects/")[1];
}
async function drag(
  page: Page,
  source: string,
  target: string,
  edge = "center",
  release = true,
) {
  const grip = page.locator(`[data-tile-panel="${source}"] .tile-grip`),
    destination = page.locator(
      target === "graph"
        ? "[data-graph-aperture]"
        : `[data-tile-panel="${target}"]`,
    );
  const a = (await grip.boundingBox())!,
    b = (await destination.boundingBox())!;
  const x =
    edge === "left"
      ? b.x + 10
      : edge === "right"
        ? b.x + b.width - 10
        : b.x + b.width / 2;
  const y =
    edge === "top"
      ? b.y + 10
      : edge === "bottom"
        ? b.y + b.height - 10
        : b.y + b.height / 2;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await expect(page.locator('[data-workspace-dragging="true"]')).toHaveCount(1);
  if (release) {
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
}
test("live tile preview, swap, cancel and resize preserve source and persistent canvas", async ({
  page,
}) => {
  const id = await create(page),
    base = "/api/v1/projects/" + id;
  const original = (await (await page.request.get(base)).json()).data;
  const initial = await stored(page, id);
  const canvas = await page.locator(".react-flow__viewport").elementHandle();
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (
      r.url().includes(base) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(r.method())
    )
      mutations.push(r.method() + " " + new URL(r.url()).pathname);
  });
  const before = (await page
    .locator('[data-tile-panel="analysis"]')
    .boundingBox())!;
  await drag(page, "code", "analysis", "center", false);
  await page.waitForTimeout(150);
  const moving = (await page
    .locator('[data-tile-panel="analysis"]')
    .boundingBox())!;
  expect(Math.abs(moving.y - before.y)).toBeGreaterThan(20);
  expect(await stored(page, id)).toEqual(initial);
  await page.screenshot({ path: test.info().outputPath("tile-preview.png") });
  await page.mouse.up();
  await page.waitForTimeout(320);
  const changed = await stored(page, id);
  expect(changed).not.toEqual(initial);
  expect(
    await canvas!.evaluate(
      (el) => el === document.querySelector(".react-flow__viewport"),
    ),
  ).toBe(true);
  await drag(page, "code", "analysis", "center", false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await stored(page, id)).toEqual(changed);
  const separator = page
    .getByRole("separator", { name: "Ширина панелей" })
    .first();
  const ratio = Number(await separator.getAttribute("aria-valuenow"));
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
    .toBeCloseTo(ratio + 3, 2);
  expect(mutations).toEqual([]);
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(original.headRevisionId);
});
test("all four edge docks and keyboard move preserve every panel slot", async ({
  page,
}) => {
  const id = await create(page),
    initial = await stored(page, id);
  for (const edge of ["left", "right", "top", "bottom"]) {
    await page.evaluate(
      ({ k, l }) => localStorage.setItem(k, JSON.stringify(l)),
      { k: key(id), l: initial },
    );
    await page.reload();
    await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
    await page.waitForTimeout(300);
    await drag(page, "code", "graph", edge);
    expect(await stored(page, id)).not.toEqual(initial);
    const overlap = await page
      .locator(".workspace-group")
      .evaluateAll((elements) =>
        elements.some((a, i) =>
          elements.slice(i + 1).some((b) => {
            const x = a.getBoundingClientRect(),
              y = b.getBoundingClientRect();
            return (
              Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 &&
              Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1
            );
          }),
        ),
      );
    expect(overlap).toBe(false);
  }
  const handle = page.getByLabel("Переместить Код Java", { exact: true });
  await handle.focus();
  await page.keyboard.press("Enter");
  const popup = page.locator(".workspace-move-menu[open]");
  await chooseOption(
    popup.getByRole("combobox", { name: "Панель назначения" }),
    {
      label: "Консоль",
    },
  );
  await chooseOption(
    popup.getByRole("combobox", { name: "Способ перемещения" }),
    "tabs",
  );
  await popup.getByRole("button", { name: "Переместить", exact: true }).click();
  const l = await stored(page, id);
  expect(JSON.stringify(l)).toContain("code");
});
test("hidden editor keeps its slot, caret and undo and restores visibility after reload", async ({
  page,
}) => {
  const id = await create(page);
  const initial = await stored(page, id);
  const editor = page.locator(".monaco-editor textarea.inputarea");
  const identity = await editor.elementHandle();
  const canvas = await page.locator(".react-flow__viewport").elementHandle();
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// window-state-marker");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  const toggle = page
    .locator(".workspace-dock")
    .getByRole("button", { name: "Код", exact: true });
  await toggle.click();
  await expect(page.locator('[data-panel-id="code"]')).not.toBeVisible();
  await expect(page.locator('[data-panel-id="code"]')).toHaveAttribute(
    "inert",
    "",
  );
  const hidden = await stored(page, id);
  expect(hidden.root).toEqual(initial.root);
  expect(hidden.hidden).toContain("code");
  await toggle.click();
  await expect(page.locator('[data-panel-id="code"]')).toBeVisible();
  expect(
    await identity!.evaluate(
      (el) =>
        el === document.querySelector(".monaco-editor textarea.inputarea"),
    ),
  ).toBe(true);
  expect(
    await canvas!.evaluate(
      (el) => el === document.querySelector(".react-flow__viewport"),
    ),
  ).toBe(true);
  await editor.focus();
  await page.keyboard.insertText("selection_kept");
  await expect(page.locator(".monaco-editor")).toContainText(
    "window-state-selection_kept",
  );
  await page.keyboard.press("Control+z");
  await expect(page.locator(".monaco-editor")).toContainText(
    "window-state-marker",
  );
  await toggle.click();
  await page.reload();
  await expect(page.locator('[data-panel-id="code"]')).not.toBeVisible();
  expect((await stored(page, id)).hidden).toContain("code");
  await page
    .locator(".workspace-dock")
    .getByRole("button", { name: "Код", exact: true })
    .click();
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+End");
  await expect(page.locator(".monaco-editor")).toContainText(
    "window-state-marker",
  );
});
test("project isolation, corrupt storage recovery, narrow mode and reduced motion", async ({
  page,
}) => {
  const first = await create(page);
  const initial = await stored(page, first);
  await page
    .locator(".workspace-dock")
    .getByRole("button", { name: "Консоль", exact: true })
    .click();
  const hidden = await stored(page, first);
  const second = await create(page);
  expect(await stored(page, second)).toEqual(initial);
  await page.goto("/projects/" + first);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
  expect(await stored(page, first)).toEqual(hidden);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".workspace-group")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  await page.setViewportSize({ width: 390, height: 844 });
  const chooser = page.getByRole("combobox", { name: "Открытая панель" });
  await expect(chooser).toBeVisible();
  for (const panel of ["code", "analysis", "console", "graph"]) {
    await chooseOption(chooser, panel);
    await expect(page.locator(`[data-panel-id="${panel}"]`)).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath("glass-narrow.png") });
  await page.setViewportSize({ width: 1536, height: 1024 });
  expect((await stored(page, first)).root).toEqual(hidden.root);
  await page.evaluate((k) => localStorage.setItem(k, "{invalid"), key(first));
  await page.reload();
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
  expect(await stored(page, first)).toEqual(initial);
});
