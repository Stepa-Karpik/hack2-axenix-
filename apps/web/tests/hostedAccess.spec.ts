import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fixture, headers, head, source } from "./fileFixtures";

// Frontend capability fixtures only; PostgreSQL/MVC and deployment smoke cover server policy.
const user = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  username: "hosted_ui_fixture",
  displayName: "Hosted fixture",
  bio: "",
  emailVerified: true,
};
async function session(
  page: Page,
  authenticated: boolean,
  csrf = "hosted-ui-fixture",
) {
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        data: {
          mode: authenticated ? "authenticated" : "anonymous",
          user: authenticated ? user : null,
          localOwnerId: null,
          csrfToken: csrf,
          capabilities: {
            registration: true,
            emailDelivery: false,
            legacyGuestWorkspace: false,
            projectCreation: authenticated,
            projectExport: authenticated,
          },
        },
      },
    }),
  );
  await page.addInitScript((id) => {
    for (const scope of ["home", "workspace", "settings", "profile"])
      localStorage.setItem(
        "java-blueprints:onboarding:v1:" + id + ":" + scope,
        "done",
      );
  }, user.id);
}

test("hosted guest gets a sign-in entry without querying or creating a legacy workspace", async ({
  page,
}) => {
  await session(page, false);
  const projectRequests: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/v1\/projects(?:\?|$)/.test(r.url()))
      projectRequests.push(r.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваше рабочее пространство", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Создать проект" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Локальное пространство" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Оформление", exact: true }).click();
  await page.getByRole("button", { name: "OLED", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preset",
    "oled",
  );
  expect(projectRequests).toEqual([]);
});

test("hosted account loads its own collection and never offers legacy scope", async ({
  page,
}) => {
  await session(page, true);
  const queries: string[] = [];
  await page.route("**/api/v1/projects?**", (route) => {
    queries.push(new URL(route.request().url()).search);
    return route.fulfill({
      json: {
        data: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            name: "Owned hosted fixture",
            updatedAt: "2026-10-25T00:00:00Z",
            headRevisionId: null,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Owned hosted fixture/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Создать проект", exact: false }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Локальное пространство", exact: true }),
  ).toHaveCount(0);
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((q) => !new URLSearchParams(q).has("scope"))).toBe(true);
});

test("anonymous public-view UI permits exact file GET but disables ZIP/archive materialization", async ({
  page,
}) => {
  const own = await fixture(page.request);
  const started = await page.request.post(
    own.base + "/revisions/" + own.original.id + "/analysis",
    { headers: await headers(page.request) },
  );
  expect(started.ok()).toBe(true);
  const job = (await started.json()).data;
  await expect
    .poll(
      async () =>
        (await (await page.request.get(own.base + "/jobs/" + job.id)).json())
          .data.status,
      { timeout: 30000 },
    )
    .toBe("succeeded");
  const actual = (await (await page.request.get("/api/v1/session")).json())
    .data;
  await session(page, false, actual.csrfToken);
  await page.route("**/api/v1/projects/" + own.projectId, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = {
      ...body.data,
      ownerId: user.id,
      visibility: "public",
      role: "viewer",
      canEdit: false,
    };
    await route.fulfill({ response, json: body });
  });
  const materializations: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      /\/(?:exports|archives|archive-previews)(?:\?|$)/.test(r.url())
    )
      materializations.push(r.url());
  });
  await page.goto("/projects/" + own.projectId);
  await expect(page.locator('.workbench[data-readonly="true"]')).toBeVisible();
  await page
    .locator(".global-command-menu .workspace-menu > summary")
    .filter({ hasText: /^Файл$/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Экспорт версии", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Скачать архив проекта", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Открыть архив проекта…", exact: true }),
  ).toBeDisabled();
  await page
    .locator(".global-command-menu .workspace-menu > summary")
    .filter({ hasText: /^Файл$/ })
    .click();
  await page.locator('[data-file-path="Main.java"]').click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать выбранный путь", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Main.java");
  expect(await readFile((await download.path())!, "utf8")).toBe(source);
  expect(materializations).toEqual([]);
  expect((await head(page.request, own.base)).id).toBe(own.original.id);
});
