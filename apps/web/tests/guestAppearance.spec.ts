import { test, expect, type Page } from "@playwright/test";
const appearanceKey = "java-blueprints:appearance";
test.beforeEach(async ({ context }) => {
  await context.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        data: {
          user: null,
          mode: "local",
          csrfToken: "guest-theme-fixture",
          capabilities: {
            registration: true,
            emailDelivery: false,
            legacyGuestWorkspace: true,
          },
        },
      },
    }),
  );
});
test("guest can configure local appearance while all account settings still require sign in", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/") && r.method() !== "GET")
      writes.push(r.url());
  });
  await page.goto("/settings/appearance");
  await expect(
    page.getByRole("heading", { name: "Оформление", level: 1, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Войдите в аккаунт", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "OLED", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "oled",
  );
  await expect
    .poll(() =>
      page
        .locator(".product-page")
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    )
    .toBe("rgb(0, 0, 0)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "oled",
  );
  for (const section of ["profile", "security", "friends", "integrations"]) {
    await page.goto("/settings/" + section);
    await expect(
      page.getByRole("heading", { name: "Войдите в аккаунт", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Сохранить профиль", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Изменить пароль", exact: true }),
    ).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});
async function countStorageWrites(page: Page) {
  await page.evaluate(() => {
    const writes: string[] = [];
    (window as unknown as { themeWrites: string[] }).themeWrites = writes;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key === "java-blueprints:appearance" ||
        key === "java-blueprints:theme"
      )
        writes.push(key);
      return original.call(this, key, value);
    };
  });
}
async function writes(page: Page) {
  return page.evaluate(
    () => (window as unknown as { themeWrites: string[] }).themeWrites.length,
  );
}
test("valid theme and custom palette changes synchronize real tabs without storage echo loops", async ({
  page,
  context,
}) => {
  await page.goto("/settings/appearance");
  const other = await context.newPage();
  await other.goto("/settings/appearance");
  await countStorageWrites(page);
  await countStorageWrites(other);
  await page.getByRole("button", { name: "Синяя", exact: true }).click();
  await expect(other.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "blue",
  );
  await expect(
    other.getByRole("button", { name: "Синяя", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(other.getByLabel("Фон", { exact: true })).toHaveValue("#0b1220");
  expect(await writes(page)).toBe(2);
  expect(await writes(other)).toBe(0);
  await other.getByRole("button", { name: "Светлая", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "light",
  );
  expect(await writes(page)).toBe(2);
  expect(await writes(other)).toBe(2);
  await other.evaluate(() => {
    const state = window as unknown as { invalidThemeDelivered: boolean };
    state.invalidThemeDelivered = false;
    const listener = (event: StorageEvent) => {
      if (
        event.key === "java-blueprints:appearance" &&
        event.newValue === "invalid preference"
      ) {
        state.invalidThemeDelivered = true;
        window.removeEventListener("storage", listener);
      }
    };
    window.addEventListener("storage", listener);
  });
  await page.evaluate(
    (key) => localStorage.setItem(key, "invalid preference"),
    appearanceKey,
  );
  await expect
    .poll(() =>
      other.evaluate(
        () =>
          (window as unknown as { invalidThemeDelivered: boolean })
            .invalidThemeDelivered,
      ),
    )
    .toBe(true);
  await expect(other.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "light",
  );
  expect(await writes(other)).toBe(2);
  await page.getByRole("button", { name: "OLED", exact: true }).click();
  await page.getByLabel("Текст", { exact: true }).fill("#ffffff");
  await page
    .getByRole("button", { name: "Применить свою палитру", exact: true })
    .click();
  await expect(other.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "custom",
  );
  await expect(other.getByLabel("Текст", { exact: true })).toHaveValue(
    "#ffffff",
  );
  await expect
    .poll(() =>
      other
        .locator(".product-page")
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    )
    .toBe("rgb(0, 0, 0)");
  expect(await writes(other)).toBe(2);
  await other.reload();
  await expect(other.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "custom",
  );
  await other.close();
});
