import { test, expect, type Page } from "@playwright/test";
import { fixture, head } from "./fileFixtures";
import { defaultLayout, hidePanel, layoutKey } from "../src/workspaceLayout";

// UI-only identity fixture; APIRequestContext retains its real guest session and CSRF.
// Fresh backend projects are real, with no register/login, mail, provider or Java execution.
async function account(page: Page) {
  const initialResponse = await page.request.get("/api/v1/session");
  expect(initialResponse.ok()).toBe(true);
  const initial = (await initialResponse.json()).data;
  const id = crypto.randomUUID();
  await page.route("**/api/v1/session", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          ...initial,
          mode: "authenticated",
          user: {
            id,
            username: "tour_ui_fixture",
            displayName: "Tour UI fixture",
            bio: "",
            emailVerified: true,
          },
        },
      }),
    });
  });
  return id;
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Знакомство с JavaBlueprints" });
async function aperture(page: Page, selector: string) {
  await expect(page.locator(".tour-aperture")).toHaveAttribute(
    "data-tour-target",
    selector,
  );
  await expect
    .poll(async () => {
      const target = await page.locator(selector).first().boundingBox();
      const ring = await page.locator(".tour-aperture").boundingBox();
      if (!target || !ring || target.width < 1 || target.height < 1)
        return false;
      return (
        Math.abs(ring.x - (target.x - 5)) < 2 &&
        Math.abs(ring.y - (target.y - 5)) < 2 &&
        Math.abs(ring.width - (target.width + 10)) < 2 &&
        Math.abs(ring.height - (target.height + 10)) < 2
      );
    })
    .toBe(true);
}
async function replay(page: Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("java-blueprints:tour")),
  );
  await expect(dialog(page)).toBeVisible();
}

test("first use, back/next, keyboard focus, skip persistence and settings replay", async ({
  page,
}) => {
  const user = await account(page);
  await page.goto("/");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toBeFocused();
  await aperture(page, ".project-heading");
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Далее" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Пропустить" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog(page).getByRole("heading")).toHaveText(
    "Рабочее пространство",
  );
  await aperture(page, ".project-list");
  await dialog(page).getByRole("button", { name: "Назад" }).click();
  await expect(dialog(page).getByRole("heading")).toHaveText(
    "Начните с проекта",
  );
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      (id) =>
        localStorage.getItem("java-blueprints:onboarding:v1:" + id + ":home"),
      user,
    ),
  ).toBe("done");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ваши проекты" }),
  ).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await page.goto("/settings/appearance");
  await dialog(page).getByRole("button", { name: "Пропустить" }).click();
  const trigger = page.getByRole("button", { name: "Повторить знакомство" });
  await trigger.click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("whole workspace tour reveals hidden panels and leaves project head and execution untouched", async ({
  page,
}) => {
  const user = await account(page);
  const own = await fixture(page.request);
  let layout = defaultLayout();
  for (const panel of ["project", "palette", "code", "tests"] as const)
    layout = hidePanel(layout, panel);
  await page.addInitScript(
    ({ id, key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem(
        "java-blueprints:window-state:" + id,
        JSON.stringify({
          maximized: "graph",
          focused: "graph",
          collapsedNavigation: true,
        }),
      );
    },
    { id: own.projectId, key: layoutKey(own.projectId), value: layout },
  );
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      // Lazy POST /revisions/{id}/analysis reads source; only exact revision creation writes it.
      /\/(runs|comparisons|commands)(\/|$)|\/revisions\/?$/.test(
        new URL(request.url()).pathname,
      )
    )
      mutations.push(request.url());
  });
  await page.goto("/projects/" + own.projectId);
  const steps = [
    ["Файлы проекта", '[data-tile-panel="project"]'],
    ["Найти в проекте", ".project-command-search"],
    ["Схема и код", "[data-graph-aperture]"],
    ["Добавить блок", '[data-tile-panel="palette"]'],
    ["Редактор", '[data-tile-panel="code"]'],
    ["Запуск", ".dock-run-control"],
    ["Проверить изменения", '[data-tile-panel="tests"]'],
    ["Ваше рабочее место", '.workspace-dock [title="Окна"]'],
    ["Профиль и настройки", ".local-presence"],
  ];
  for (const [title, target] of steps) {
    await expect(dialog(page).getByRole("heading")).toHaveText(title);
    await aperture(page, target);
    await expect(dialog(page).getByRole("status")).toHaveCount(0);
    await dialog(page)
      .getByRole("button", {
        name: title === steps.at(-1)![0] ? "Готово" : "Далее",
        exact: true,
      })
      .click();
  }
  await expect(dialog(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      (id) =>
        localStorage.getItem(
          "java-blueprints:onboarding:v1:" + id + ":workspace",
        ),
      user,
    ),
  ).toBe("done");
  expect((await head(page.request, own.base)).bundleHash).toBe(
    own.original.bundleHash,
  );
  expect((await head(page.request, own.base)).id).toBe(own.original.id);
  expect(mutations).toEqual([]);
  await replay(page);
  await expect(dialog(page).getByRole("heading")).toHaveText("Файлы проекта");
  await dialog(page).getByRole("button", { name: "Пропустить" }).click();
});

test("reduced motion, missing target and route scope change stay usable", async ({
  page,
}) => {
  await account(page);
  const own = await fixture(page.request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/projects/" + own.projectId);
  await expect(dialog(page)).toBeVisible();
  await aperture(page, '[data-tile-panel="project"]');
  expect(
    await page
      .locator(".tour-aperture")
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  for (let i = 0; i < 8; i++)
    await dialog(page)
      .getByRole("button", { name: "Далее", exact: true })
      .click();
  // Same-document route update exercises the preserved displayIndex clamp (workspace9 -> home3).
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(dialog(page).getByRole("heading")).toHaveText(
    "Начните с проекта",
  );
  await page.addStyleTag({
    content: ".project-heading { display: none !important }",
  });
  await replay(page);
  await expect(dialog(page).getByRole("status")).toContainText(
    "Элемент недоступен",
  );
  await expect(page.locator(".tour-aperture")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(dialog(page).getByRole("heading")).toHaveText(
    "Рабочее пространство",
  );
  await aperture(page, ".project-list");
  await dialog(page).getByRole("button", { name: "Пропустить" }).click();
});
