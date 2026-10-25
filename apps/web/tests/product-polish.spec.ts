import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mount } from "./polishFixtures";
const path = process.env.JB_THEME_FIXTURE_PATH;
const sample = () =>
  JSON.parse(readFileSync(path!, "utf8").replace(/^\uFEFF/, ""));
test.beforeEach(() => test.skip(!path, "Captured analysis required"));
test("navigation returns by header button, panel button and drag, then survives reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const state = await mount(page, sample());
  const undock = async () => {
    await page
      .getByRole("button", { name: "JavaBlueprints — навигация" })
      .click();
    await page.getByRole("button", { name: "На полотно", exact: true }).click();
    await expect(page.locator("[data-return-navigation]")).toBeVisible();
  };
  await undock();
  await page.locator("[data-return-navigation]").click();
  await expect(
    page.getByRole("button", { name: "JavaBlueprints — навигация" }),
  ).toBeVisible();
  await undock();
  await page
    .getByRole("button", {
      name: "Закрепить JavaBlueprints наверху",
      exact: true,
    })
    .click();
  await undock();
  const from = await page
    .getByLabel("Переместить JavaBlueprints", { exact: true })
    .boundingBox();
  const to = await page.locator("[data-return-navigation]").boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, {
    steps: 15,
  });
  await expect(page.locator(".workbench")).toHaveAttribute(
    "data-navigation-dock-target",
    "",
  );
  await page.mouse.up();
  await expect(page.locator("[data-return-navigation]")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "JavaBlueprints — навигация" }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
});
test("OLED default, coherent header, sidebar brand and aligned rounded color swatches", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await mount(page, sample());
  await page.goto("/settings/appearance");
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "oled",
  );
  await expect(page.locator(".product-header")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(page.locator(".product-header .product-brand")).toHaveCount(0);
  await expect(page.locator(".product-sidebar .product-brand")).toBeVisible();
  await expect(page.locator(".account-nav a")).toHaveCount(3);
  const swatches = page.locator(".custom-colors input[type=color]");
  await expect(swatches).toHaveCount(5);
  const positions = [];
  for (const input of await swatches.all()) {
    await expect(input).toHaveCSS("appearance", "none");
    await expect(input).toHaveCSS("border-top-width", "0px");
    await expect(input).toHaveCSS("border-top-left-radius", "9px");
    positions.push((await input.boundingBox())!.x);
  }
  expect(new Set(positions).size).toBe(1);
  await page.screenshot({
    path: info.outputPath("appearance-oled.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await expect(page.locator(".product-header")).toHaveCSS(
    "background-color",
    "rgb(20, 20, 20)",
  );
  await page.goto("/projects");
  await expect(page.locator(".home-header")).toHaveCSS(
    "background-color",
    "rgb(20, 20, 20)",
  );
  await expect(page.locator(".home-header .brand")).toHaveCount(0);
  await expect(page.locator(".product-sidebar .product-brand")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("projects-dark.png"),
    fullPage: true,
  });
  expect(state.writes).toEqual([]);
});
