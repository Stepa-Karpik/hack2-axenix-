import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mount } from "./polishFixtures";
const samplePath = process.env.JB_THEME_FIXTURE_PATH;
const sample = () =>
  JSON.parse(readFileSync(samplePath!, "utf8").replace(/^\uFEFF/, ""));
async function step(page: Page, id: string) {
  await expect(page.locator(".guided-tour")).toHaveAttribute(
    "data-tour-step",
    id,
  );
  await expect(page.locator(".tour-aperture")).toBeVisible();
  await expect
    .poll(async () => {
      const a = await page.locator(".tour-aperture").boundingBox(),
        b = await page.locator(".tour-card").boundingBox();
      if (!a || !b) return false;
      return (
        Math.max(
          0,
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
        ) *
          Math.max(
            0,
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
          ) ===
        0
      );
    })
    .toBe(true);
}
test.beforeEach(() => test.skip(!samplePath, "Captured analysis required"));
test("editor tutorial waits for actions, downloads file, opens dialogs and saves layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const state = await mount(page, sample());
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("java-blueprints:tour")),
  );
  await step(page, "file");
  await page.keyboard.press("ArrowRight");
  await step(page, "file");
  await page
    .locator("[data-file-path]:not([data-directory-path])")
    .first()
    .click();
  await step(page, "method");
  await page.locator(".method-item").first().click();
  await step(page, "node");
  await page
    .locator('.blueprint-node[data-node-kind="ExpressionStmt"]')
    .first()
    .click();
  await step(page, "download");
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  expect((await download).suggestedFilename()).toMatch(/\.java$/);
  await step(page, "template");
  await page.locator(".palette-condition").click();
  await step(page, "preview");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await step(page, "run");
  await page.locator(".dock-run").click();
  await step(page, "run-options");
  await page
    .getByRole("button", { name: "Закрыть диалог", exact: true })
    .click();
  await step(page, "compare");
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  await step(page, "compare-options");
  await page
    .getByRole("button", { name: "Закрыть диалог", exact: true })
    .click();
  await step(page, "view");
  await page.locator('[data-tour="workspace-view"]').click();
  await step(page, "layout");
  await page.locator('[data-tour="save-layout"]').click();
  await expect(page.locator(".guided-tour")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test("full replay navigates from projects; account training targets individual controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await mount(page, sample());
  await page.goto("/settings/profile");
  await page.locator(".product-sidebar .tour-launcher").click();
  await expect(page).toHaveURL(/\/projects$/);
  await step(page, "open-project");
  await page.keyboard.press("Escape");
  await expect(page.locator(".guided-tour")).toHaveCount(0);
  await page.goto("/settings/profile");
  await expect(page.locator(".product-sidebar .tour-launcher")).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("java-blueprints:tour")),
  );
  await step(page, "settings");
  await page.locator('.account-nav a[href="/settings/profile"]').click();
  await step(page, "name");
  await page.locator('[data-tour="profile-name"]').click();
  await step(page, "photo");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await step(page, "public-profile");
  await page.locator('.account-nav a[href^="/u/"]').click();
  await step(page, "edit-profile");
  await page.locator('.profile-summary a[href="/settings/profile"]').click();
  await step(page, "security");
  await page.locator('.product-sidebar a[href="/settings/security"]').click();
  await step(page, "security-method");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await step(page, "appearance");
  await page.locator('.product-sidebar a[href="/settings/appearance"]').click();
  await step(page, "theme");
  await page.getByRole("button", { name: "OLED", exact: true }).click();
  await step(page, "palette");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await step(page, "friends");
  await page.locator('.product-sidebar a[href="/settings/friends"]').click();
  await step(page, "people");
  await page.getByRole("textbox", { name: "Поиск пользователей" }).fill("show");
  await step(page, "integrations");
  await page
    .locator('.product-sidebar a[href="/settings/integrations"]')
    .click();
  await step(page, "github");
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.locator(".guided-tour")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("first project visit starts training once; landing remains untouched and replay is visible", async ({
  page,
}) => {
  await mount(page, sample());
  await page.addInitScript(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("java-blueprints:onboarding:"))
        localStorage.removeItem(key);
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "У кода есть другая сторона.",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator(".guided-tour")).toHaveCount(0);
  await page.goto("/projects");
  await step(page, "open-project");
  await page.locator(".project-row").first().click();
  await step(page, "file");
  await page.keyboard.press("Escape");
  await expect(page.locator(".guided-tour")).toHaveCount(0);
  await page
    .getByRole("button", { name: "JavaBlueprints — навигация" })
    .click();
  await page
    .getByRole("button", { name: "Обучение редактору", exact: true })
    .click();
  await step(page, "file");
  await page.screenshot({
    path: test.info().outputPath("interactive-guide.png"),
  });
});
test("narrow settings keep brand, aligned swatches and an unobstructed tutorial", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, sample());
  await page.goto("/settings/appearance");
  await expect(page.locator(".product-sidebar .product-brand")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.locator(".product-sidebar .tour-launcher").click();
  await step(page, "open-project");
  await page.keyboard.press("Escape");
  await page.goto("/settings/profile");
  await expect(page.locator(".product-sidebar .tour-launcher")).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("java-blueprints:tour")),
  );
  await step(page, "settings");
  await page.locator('.product-sidebar a[href="/settings/profile"]').click();
  await step(page, "name");
  await page.locator('[data-tour="profile-name"]').click();
  await step(page, "photo");
  await page.screenshot({ path: test.info().outputPath("mobile-guide.png") });
});
