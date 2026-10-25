import { test, expect, type Page } from "@playwright/test";
const projectId = "99999999-9999-4999-8999-999999999999";
async function ratio(page: Page, foreground: string, background: string) {
  return page.evaluate(
    ({ foreground, background }) => {
      const pixel = document.createElement("canvas").getContext("2d")!;
      function rgba(css: string) {
        pixel.clearRect(0, 0, 1, 1);
        pixel.fillStyle = css;
        pixel.fillRect(0, 0, 1, 1);
        return Array.from(pixel.getImageData(0, 0, 1, 1).data);
      }
      const alpha = (front: number[], back: number[]) =>
        front
          .slice(0, 3)
          .map((c, i) => (c * front[3]) / 255 + back[i] * (1 - front[3] / 255));
      const black = [0, 0, 0, 255];
      const bg = alpha(rgba(background), black),
        fg = alpha(rgba(foreground), [...bg, 255]);
      const lum = (rgb: number[]) =>
        rgb
          .map((c) => c / 255)
          .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
      return (
        (Math.max(lum(fg), lum(bg)) + 0.05) /
        (Math.min(lum(fg), lum(bg)) + 0.05)
      );
    },
    { foreground, background },
  );
}
test("every preset keeps canvas-only chrome readable and preserves popup and panel foreground contrast", async ({
  page,
  context,
}) => {
  await context.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    let data: unknown;
    if (path === "/session")
      data = {
        user: null,
        mode: "local",
        csrfToken: "contrast-fixture",
        capabilities: {
          registration: true,
          emailDelivery: false,
          legacyGuestWorkspace: true,
        },
      };
    else if (path === "/capabilities") data = { runner: { available: false } };
    else if (path === `/projects/${projectId}`)
      data = {
        id: projectId,
        name: "Canvas contrast fixture",
        headRevisionId: null,
        originalRevisionId: null,
        ownerId: null,
        role: "local_guest",
        visibility: "legacy_local",
        canEdit: true,
        updatedAt: "2026-10-25T00:00:00Z",
      };
    else if (path === `/projects/${projectId}/revisions`) data = [];
    else {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Unexpected fixture endpoint",
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/projects/" + projectId);
  const appearance = await context.newPage();
  await appearance.goto("/settings/appearance");
  const summaries =
    ".glass-workbench .global-command-menu > .workspace-menubar > .workspace-menu > summary";
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
    const canvas = await page
      .locator(".workspace-canvas-background")
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(canvas).toBe("rgb(0, 0, 0)");
    for (const selector of [
      ".canvas-heading h1",
      ".canvas-breadcrumb",
      ".canvas-heading p",
      summaries,
    ]) {
      const targets = page.locator(selector);
      expect(await targets.count()).toBeGreaterThan(0);
      for (const target of await targets.all()) {
        await expect(target).toBeVisible();
        const foreground = await target.evaluate(
          (e) => getComputedStyle(e).color,
        );
        expect(
          await ratio(page, foreground, canvas),
          `${preset}: ${selector} on black`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    const file = page.locator(summaries).filter({ hasText: /^Файл$/ });
    await file.click();
    const popup = page.locator(
      ".global-command-menu .workspace-menu[open] > .workspace-menu-popup",
    );
    await expect(popup).toBeVisible();
    const item = popup.getByRole("button", {
      name: "Все проекты",
      exact: true,
    });
    const popupColors = await popup.evaluate((e) => ({
      background: getComputedStyle(e).backgroundColor,
      theme: getComputedStyle(e).getPropertyValue("--theme-text").trim(),
    }));
    const itemColor = await item.evaluate((e) => getComputedStyle(e).color);
    expect(
      await ratio(page, itemColor, popupColors.background),
      `${preset}: popup item on own surface`,
    ).toBeGreaterThanOrEqual(4.5);
    if (preset === "light" || preset === "pearl")
      expect(await ratio(page, itemColor, "#000000")).toBeLessThan(2);
    await file.click();
    const panel = page.locator('[data-tile-panel="project"]');
    const panelColor = await panel
      .locator('[data-panel-tab="project"]')
      .evaluate((e) => getComputedStyle(e).color);
    const panelBackground = await panel.evaluate(
      (e) => getComputedStyle(e).backgroundColor,
    );
    expect(
      await ratio(page, panelColor, panelBackground),
      `${preset}: panel tab on composited glass`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  await appearance.close();
});
