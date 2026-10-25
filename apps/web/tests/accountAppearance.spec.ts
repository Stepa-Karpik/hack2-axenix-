import { test, expect } from "@playwright/test";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "appearance_fixture",
  displayName: "Appearance fixture",
  bio: "",
  email: "fixture@example.invalid",
  emailVerified: true,
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        data: {
          user,
          mode: "account",
          csrfToken: "fixture",
          capabilities: {
            registration: true,
            emailDelivery: false,
            legacyGuestWorkspace: true,
          },
        },
      },
    }),
  );
  await page.goto("/settings/appearance");
  const intro = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "Пропустить", exact: true }).click();
  await expect(intro).toHaveCount(0);
});
test("seven appearance presets persist with real palette attributes and custom contrast gate", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  await expect(
    page.getByRole("heading", { name: "Оформление", exact: true, level: 1 }),
  ).toBeVisible();
  const presets = [
    ["OLED", "oled", "rgb(0, 0, 0)"],
    ["Тёмная", "dark", "rgb(20, 20, 20)"],
    ["Светлая", "light", "rgb(245, 247, 245)"],
    ["Жемчужная", "pearl", "rgb(244, 240, 233)"],
    ["Синяя", "blue", "rgb(11, 18, 32)"],
    ["Янтарная", "amber", "rgb(23, 17, 9)"],
    ["Сланцевая", "slate", "rgb(23, 25, 29)"],
  ];
  for (const [name, id, background] of presets) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-preset", id);
    await expect
      .poll(() =>
        page
          .locator(".product-page")
          .evaluate((e) => getComputedStyle(e).backgroundColor),
      )
      .toBe(background);
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "slate",
  );
  await page.getByRole("button", { name: "OLED", exact: true }).click();
  expect(
    await page
      .locator(".product-page")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
  ).toBe("rgb(0, 0, 0)");
  await page.getByLabel("Текст", { exact: true }).fill("#000000");
  await expect(
    page.getByRole("button", { name: "Применить свою палитру" }),
  ).toBeDisabled();
  await page.getByLabel("Текст", { exact: true }).fill("#ffffff");
  await page.getByRole("button", { name: "Применить свою палитру" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "custom",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "custom",
  );
  await page
    .getByRole("button", { name: "Повторить знакомство", exact: true })
    .click();
  const intro = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "Пропустить", exact: true }).click();
  await expect(intro).toHaveCount(0);
});
test("settings sections survive direct navigation and expose one shared navigation", async ({
  page,
}) => {
  for (const [path, title] of [
    ["profile", "Профиль"],
    ["security", "Безопасность"],
    ["appearance", "Оформление"],
  ]) {
    await page.goto("/settings/" + path);
    await expect(
      page.getByRole("heading", { name: title, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Разделы приложения" }),
    ).toBeVisible();
    await expect(page.getByText("АККАУНТ", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Переключить тему", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: title, exact: true, level: 1 }),
    ).toBeVisible();
  }
  await page
    .getByRole("navigation", { name: "Разделы приложения" })
    .getByRole("link", { name: "Безопасность", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/security$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
});

test("active workspace tour handles forced same-document history/popstate transitions to shorter scopes without a render crash", async ({
  page,
}) => {
  const projectId = "77777777-7777-4777-8777-777777777777";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/projects**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === `/api/v1/projects/${projectId}`
        ? {
            id: projectId,
            name: "Tour scope fixture",
            headRevisionId: null,
            originalRevisionId: null,
            updatedAt: "2026-10-25T00:00:00Z",
            role: "owner",
            ownerId: user.id,
            visibility: "private",
            canEdit: true,
          }
        : [];
    await route.fulfill({ json: { data } });
  });
  await page.route("**/api/v1/capabilities", (route) =>
    route.fulfill({ json: { data: { runner: { available: false } } } }),
  );
  const tour = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  async function stepSix() {
    await page.goto("/projects/" + projectId);
    await expect(tour).toBeVisible();
    for (let i = 0; i < 5; i++)
      await tour.getByRole("button", { name: "Далее", exact: true }).click();
    await expect(
      tour.getByRole("heading", { name: "Запуск", exact: true }),
    ).toBeVisible();
    await expect(tour.locator("small")).toHaveText("6 / 9");
  }
  await stepSix();
  // Browser/history navigation can change scope while the modal tour is active.
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: /Ваши проекты/ }),
  ).toBeVisible();
  await expect(tour).toBeVisible();
  await expect(tour.locator("small")).toHaveText("1 / 3");
  await tour.getByRole("button", { name: "Пропустить", exact: true }).click();
  expect(errors).toEqual([]);
  await stepSix();
  await page.evaluate(() => {
    history.pushState({}, "", "/settings/profile");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(
    page.getByRole("heading", { name: "Профиль", level: 1, exact: true }),
  ).toBeVisible();
  await expect(tour).toHaveCount(0);
  expect(errors).toEqual([]);
});
