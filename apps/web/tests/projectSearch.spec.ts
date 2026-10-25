import { setTheme } from "./flowAssertions";
import { test, expect, type Page } from "@playwright/test";
import { headers } from "./fileFixtures";
async function create(page: Page, name: string) {
  const response = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data;
}
test("project search reaches older pages and opens an exact selected project", async ({
  page,
}, info) => {
  const prefix = "Project search " + crypto.randomUUID();
  const projects = [];
  for (let i = 0; i < 25; i++)
    projects.push(
      await create(page, prefix + " " + String(i).padStart(2, "0")),
    );
  await page.goto("/");
  await page.getByLabel("Поиск проектов", { exact: true }).fill(prefix);
  await expect(page.locator(".project-row")).toHaveCount(20);
  await expect(page.locator(".project-row").first()).toContainText(
    prefix + " 24",
  );
  await page.getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect(page.locator(".project-row")).toHaveCount(25);
  expect(
    new Set(await page.locator(".project-row strong").allTextContents()).size,
  ).toBe(25);
  await expect(
    page.getByRole("button", { name: "Показать ещё", exact: true }),
  ).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath("projects-search-dark.png"),
    animations: "disabled",
  });
  await page
    .locator(".project-row")
    .filter({ hasText: prefix + " 00" })
    .click();
  await expect(page).toHaveURL(new RegExp("/projects/" + projects[0].id + "$"));
  expect(
    (
      await (
        await page.request.get("/api/v1/projects/" + projects[0].id)
      ).json()
    ).data.headRevisionId,
  ).toBeNull();
});
test("a delayed result for an older search cannot replace the current query", async ({
  page,
}) => {
  const prefix = "Query race " + crypto.randomUUID(),
    a = await create(page, prefix + " A"),
    b = await create(page, prefix + " B");
  await page.goto("/");
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    arrived = new Promise<void>((r) => (seen = r));
  await page.route(
    (url) =>
      url.pathname === "/api/v1/projects" &&
      url.searchParams.get("q") === a.name,
    async (route) => {
      const response = await route.fetch();
      seen();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    },
  );
  try {
    await page.getByLabel("Поиск проектов", { exact: true }).fill(a.name);
    await arrived;
    await page.getByLabel("Поиск проектов", { exact: true }).fill(b.name);
    await expect(page.locator(".project-row")).toHaveCount(1);
    await expect(page.locator(".project-row")).toContainText(b.name);
    release();
    await page.waitForTimeout(600);
    await expect(page.locator(".project-row")).toHaveCount(1);
    await expect(page.locator(".project-row")).toContainText(b.name);
    await expect(
      page.getByLabel("Поиск проектов", { exact: true }),
    ).toHaveValue(b.name);
  } finally {
    release();
  }
});
test("literal UTF8 names, clear and empty results stay usable in narrow light and dark layouts", async ({
  page,
}, info) => {
  const name = "Name " + crypto.randomUUID() + " Смета %_\\O'Reilly";
  await create(page, name);
  await page.goto("/");
  const search = page.getByLabel("Поиск проектов", { exact: true });
  await search.fill(name.toLowerCase());
  await expect(page.locator(".project-row")).toHaveCount(1);
  await expect(page.locator(".project-row")).toContainText(name);
  await setTheme(page, "light");
  await page.screenshot({
    path: info.outputPath("projects-search-light.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await search.fill("missing-" + crypto.randomUUID());
  await expect(
    page.getByText("Ничего не найдено", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Очистить поиск проектов", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await expect(page.locator(".project-row")).toHaveCount(20);
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("projects-search-narrow-dark.png"),
    animations: "disabled",
  });
});
