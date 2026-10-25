import { chooseOption } from "./selectControl";
import { expect, type Page } from "@playwright/test";
export async function revealPanel(page: Page, id: string, label: string) {
  if (id === "graph") {
    await page
      .locator(".workspace-dock")
      .getByRole("button", { name: "Схема", exact: true })
      .click();
    await expect(page.locator(".graph-pane")).toBeVisible();
    await expect(page.locator(".react-flow__pane")).toBeVisible();
    return;
  }
  const chooser = page.getByRole("combobox", { name: "Открытая панель" });
  if (await chooser.isVisible()) await chooseOption(chooser, id);
  else {
    const tab = page.locator(`[data-panel-tab="${id}"]`);
    if (await tab.count()) await tab.click();
    else {
      const command = page.locator(".sidebar-command-menu");
      if ((await command.getAttribute("open")) === null)
        await command.locator(":scope > summary").click();
      const view = page
        .locator(".workspace-menu")
        .filter({ has: page.locator("summary").filter({ hasText: /^Вид$/ }) });
      if ((await view.getAttribute("open")) === null)
        await view.locator("summary").click();
      await view.getByRole("button", { name: new RegExp(label + "$") }).click();
      await page.keyboard.press("Escape");
    }
  }
  await expect(page.locator(`[data-panel-id="${id}"]`)).toBeVisible();
}
export async function panToNode(page: Page, node: ReturnType<Page["locator"]>) {
  if (!(await page.locator(".react-flow__pane").isVisible()))
    await revealPanel(page, "graph", "Схема");
  async function measuredBox(
    locator: ReturnType<Page["locator"]>,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    let box: Awaited<ReturnType<typeof locator.boundingBox>> = null;
    // Applying a revision replaces generated node IDs. An attached element can
    // disappear before its geometry is measured; resolve the locator again.
    await expect
      .poll(
        async () => {
          box = await locator.boundingBox();
          return box !== null && box.width > 0 && box.height > 0;
        },
        { message: "The current graph element must have measured geometry" },
      )
      .toBe(true);
    return box!;
  }
  for (let pass = 0; pass < 24; pass++) {
    const aperture = page.locator("[data-graph-aperture]");
    const area = await measuredBox(
      (await aperture.count()) ? aperture : page.locator(".react-flow__pane"),
    );
    const box = await measuredBox(node);
    const dx = area.x + area.width / 2 - box.x - box.width / 2;
    const dy = area.y + area.height / 2 - box.y - box.height / 2;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    let start: { x: number; y: number } | null = null;
    await expect
      .poll(
        async () =>
          (start = await page.locator(".react-flow__pane").evaluate((pane) => {
            const box =
              document
                .querySelector("[data-graph-aperture]")
                ?.getBoundingClientRect() ?? pane.getBoundingClientRect();
            for (let row = 1; row < 10; row++)
              for (let column = 1; column < 10; column++) {
                const x = box.x + (box.width * column) / 10,
                  y = box.y + (box.height * row) / 10;
                if (document.elementFromPoint(x, y) === pane) return { x, y };
              }
            return null;
          })),
      )
      .not.toBeNull();
    // Focus the canvas before Space: an editor selection must never receive it.
    await page.mouse.click(start!.x, start!.y);
    await page.keyboard.down("Space");
    await page.mouse.move(start!.x, start!.y);
    await page.mouse.down();
    await page.mouse.move(
      start!.x + Math.max(-area.width / 3, Math.min(area.width / 3, dx)),
      start!.y + Math.max(-area.height / 3, Math.min(area.height / 3, dy)),
      { steps: 5 },
    );
    await page.mouse.up();
    await page.keyboard.up("Space");
  }
  await expect(node).toBeInViewport();
}
export async function assertRoutes(page: Page) {
  expect(await page.locator("g[data-shortcut-source]").count()).toBeGreaterThan(
    0,
  );
  expect(await page.locator("g[data-shortcut-source]").count()).toBe(
    await page.locator(".react-flow__edge").count(),
  );
  await expect(page.locator("g[data-route-status=limited]")).toHaveCount(0);
  const crossings = await page
    .locator("g[data-shortcut-source]")
    .evaluateAll((groups) => {
      const boxes = Array.from(
        document.querySelectorAll(".react-flow__node-blueprint"),
      ).map((node) => ({
        id: node.getAttribute("data-id"),
        r: node.getBoundingClientRect(),
      }));
      return groups.flatMap((group) => {
        const path = group.querySelector(
          "path.react-flow__edge-path",
        ) as SVGPathElement;
        const numbers = path
          .getAttribute("d")!
          .match(/-?[0-9.]+/g)!
          .map(Number);
        const matrix = path.getScreenCTM()!;
        const points = [];
        for (let index = 0; index < numbers.length; index += 2)
          points.push(
            new DOMPoint(numbers[index], numbers[index + 1]).matrixTransform(
              matrix,
            ),
          );
        const source = group.getAttribute("data-shortcut-source"),
          target = group.getAttribute("data-shortcut-target");
        return boxes
          .filter(
            (box) =>
              box.id !== source &&
              box.id !== target &&
              points.slice(1).some((point, index) => {
                const previous = points[index],
                  r = box.r;
                return point.x === previous.x
                  ? point.x > r.left + 1 &&
                      point.x < r.right - 1 &&
                      Math.max(point.y, previous.y) > r.top + 1 &&
                      Math.min(point.y, previous.y) < r.bottom - 1
                  : point.y > r.top + 1 &&
                      point.y < r.bottom - 1 &&
                      Math.max(point.x, previous.x) > r.left + 1 &&
                      Math.min(point.x, previous.x) < r.right - 1;
              }),
          )
          .map((box) => box.id);
      });
    });
  expect(crossings).toEqual([]);
}
export async function assertDistinctFalseRoutes(
  page: Page,
  edges: { source: string; target: string }[],
) {
  const routes = [];
  for (const edge of edges) {
    const path = page.locator(
      `g[data-route-source="${edge.source}"][data-route-target="${edge.target}"] path.react-flow__edge-path`,
    );
    await expect(path).toHaveCount(1);
    const points = await path.evaluate((node) => {
      const numbers = node
        .getAttribute("d")!
        .match(/-?[0-9.]+/g)!
        .map(Number);
      return Array.from({ length: numbers.length / 2 }, (_, i) => ({
        x: numbers[i * 2],
        y: numbers[i * 2 + 1],
      }));
    });
    routes.push({ ...edge, points });
  }
  const overlaps = routes.flatMap((a, index) =>
    routes.slice(index + 1).flatMap((b) => {
      if (a.target === b.target) return [];
      return a.points.slice(1).flatMap((endA, i) =>
        b.points.slice(1).flatMap((endB, j) => {
          const startA = a.points[i],
            startB = b.points[j];
          const vertical =
            startA.x === endA.x &&
            startB.x === endB.x &&
            startA.x === startB.x &&
            Math.min(Math.max(startA.y, endA.y), Math.max(startB.y, endB.y)) -
              Math.max(Math.min(startA.y, endA.y), Math.min(startB.y, endB.y)) >
              1;
          const horizontal =
            startA.y === endA.y &&
            startB.y === endB.y &&
            startA.y === startB.y &&
            Math.min(Math.max(startA.x, endA.x), Math.max(startB.x, endB.x)) -
              Math.max(Math.min(startA.x, endA.x), Math.min(startB.x, endB.x)) >
              1;
          return vertical || horizontal
            ? [{ a: a.source, b: b.source, segmentA: i, segmentB: j }]
            : [];
        }),
      );
    }),
  );
  expect(overlaps).toEqual([]);
}

export async function setTheme(page: Page, theme: "light" | "dark") {
  if ((await page.locator("html").getAttribute("data-theme-preset")) === theme)
    return;
  const appearance = await page.context().newPage();
  try {
    await appearance.goto(new URL("/settings/appearance", page.url()).href);
    const preset = appearance.locator(".theme-options").getByRole("button", {
      name: theme === "dark" ? "Тёмная" : "Светлая",
      exact: true,
    });
    await expect(preset).toBeVisible();
    await preset.click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await expect(appearance.locator("html")).toHaveAttribute(
      "data-theme-preset",
      theme,
    );
    // The production provider receives the browser's native cross-tab storage
    // event. The original page and its in-flight proposal/editor stay mounted.
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preset",
      theme,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  } finally {
    await appearance.close();
    if (!page.isClosed()) await page.bringToFront();
  }
}
