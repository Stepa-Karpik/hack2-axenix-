import { test, expect, type Page } from "@playwright/test";

// Provider and account traffic are fixtures: no real account, registration, OAuth or mail is used.
const user = {
  id: "8a2d14c9-21e6-49b7-9832-62713d706f10",
  username: "github_ui_fixture",
  displayName: "GitHub fixture",
  bio: "",
  email: "fixture@example.invalid",
  emailVerified: true,
};
const commit = "b".repeat(40);
async function mockApi(
  page: Page,
  status: Record<string, unknown>,
  authenticated = true,
  authMethod = "password",
) {
  const starts: unknown[] = [],
    previews: unknown[] = [],
    projectWrites: string[] = [],
    disconnects: string[] = [];
  await page.route("https://github.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>OAuth provider fixture</h1>",
    }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/v1/session")
      data = {
        mode: authenticated ? "authenticated" : "local_guest",
        csrfToken: "fixture-csrf",
        user: authenticated ? { ...user, authMethod } : null,
        capabilities: {
          registration: true,
          emailDelivery: false,
          legacyGuestWorkspace: true,
        },
      };
    else if (path === "/api/v1/github/status") data = status;
    else if (path === "/api/v1/github/link" && request.method() === "DELETE") {
      disconnects.push(path);
      status = {
        ...status,
        linked: null,
        repositoryAccess: false,
        expiresAt: null,
      };
      data = { disconnected: true };
    } else if (path === "/api/v1/github/oauth/start") {
      starts.push(request.postDataJSON());
      data = {
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=fixture&state=fixture&code_challenge=fixture&code_challenge_method=S256",
      };
    } else if (path === "/api/v1/github/repositories")
      data = {
        items: [
          {
            id: "7",
            owner: "owner",
            name: "demo",
            private: true,
            defaultBranch: "main",
          },
        ],
        nextPage: null,
      };
    else if (path === "/api/v1/github/snapshots") {
      expect(request.postDataJSON()).toEqual({
        repositoryId: "7",
        ref: "main",
      });
      data = {
        snapshotId: "snapshot-fixture",
        commitSha: commit,
        rootTreeSha: "a".repeat(40),
        repository: "owner/demo",
        ref: "main",
        expiresAt: "2099-01-01T00:00:00Z",
      };
    } else if (path === "/api/v1/github/snapshots/snapshot-fixture/tree")
      data = {
        entries: [
          {
            path: "Main.java",
            type: "blob",
            size: 14,
            selectable: true,
            reason: null,
          },
        ],
        complete: true,
        commitSha: commit,
      };
    else if (path === "/api/v1/github/import-previews") {
      previews.push(request.postDataJSON());
      data = {
        files: [{ path: "Main.java", content: "class Main {}\n" }],
        directories: [],
        provenance: {
          provider: "github",
          repositoryId: "7",
          repository: "owner/demo",
          commitSha: commit,
        },
      };
    } else if (request.method() === "GET") data = [];
    else {
      projectWrites.push(path);
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "FIXTURE_UNEXPECTED_WRITE",
            message: "Unexpected project mutation",
          },
        }),
      });
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data, meta: { requestId: "fixture" } }),
    });
  });
  return { starts, previews, projectWrites, disconnects };
}
async function skipTour(page: Page) {
  const tour = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  await expect(tour).toBeVisible();
  await tour
    .getByRole("button", { name: "Закрыть обучение", exact: true })
    .click();
  await expect(tour).not.toBeVisible();
}

test("unconfigured GitHub login is visibly unavailable and never starts OAuth", async ({
  page,
}) => {
  const fixture = await mockApi(
    page,
    {
      configured: false,
      unavailableReason:
        "GitHub не настроен: укажите OAuth App и ключ шифрования.",
      linked: null,
      repositoryAccess: false,
      expiresAt: null,
    },
    false,
  );
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "Продолжить с GitHub", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("GitHub не настроен: укажите OAuth App и ключ шифрования.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.starts).toEqual([]);
  expect(fixture.projectWrites).toEqual([]);
});

test("linked account requests missing repository access through the compact action", async ({
  page,
}) => {
  const fixture = await mockApi(page, {
    configured: true,
    unavailableReason: null,
    linked: { login: "linked-user", githubId: "42" },
    repositoryAccess: false,
    expiresAt: null,
  });
  await page.goto("/settings/integrations");
  await skipTour(page);
  const connect = page.getByRole("button", {
    name: "Обновить доступ",
    exact: true,
  });
  await expect(page.locator(".integration-status")).toHaveText("Нужен доступ");
  await expect(
    page.locator(".github-settings input[type=checkbox]"),
  ).toHaveCount(0);
  await expect(page.locator(".github-settings")).not.toContainText("githubId");
  await expect(page.locator(".github-settings")).not.toContainText("Истекает");
  await expect(connect).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath("github-needs-access.png"),
    fullPage: true,
  });
  await connect.click();
  await expect(
    page.getByRole("heading", { name: "OAuth provider fixture" }),
  ).toBeVisible();
  expect(fixture.starts).toEqual([{ purpose: "repositories" }]);
  expect(fixture.projectWrites).toEqual([]);
});

test("repository selection is pinned to a commit and preview waits for explicit project confirmation", async ({
  page,
}) => {
  const fixture = await mockApi(page, {
    configured: true,
    unavailableReason: null,
    linked: { login: "linked-user", githubId: "42" },
    repositoryAccess: true,
    expiresAt: null,
  });
  await page.goto("/projects");
  await skipTour(page);
  await page
    .getByRole("button", { name: "Импорт из GitHub", exact: true })
    .click();
  const importer = page.locator(".github-import");
  await importer
    .getByRole("combobox", { name: "Репозиторий", exact: true })
    .click();
  await page
    .getByRole("option", { name: "owner/demo · приватный", exact: true })
    .click();
  await expect(
    importer.getByLabel("Ветка, тег или commit SHA", { exact: true }),
  ).toHaveValue("main");
  await importer
    .getByRole("button", { name: "Зафиксировать версию", exact: true })
    .click();
  await expect(
    importer.getByText("Commit: " + commit, { exact: true }),
  ).toBeVisible();
  await importer
    .getByRole("checkbox", { name: "Файл Main.java", exact: true })
    .check();
  for (const box of await importer.getByRole("checkbox").all()) {
    await expect(box).toHaveCSS("appearance", "none");
    await expect(box).toHaveCSS("width", "22px");
  }

  const checkbox = importer.getByRole("checkbox", {
    name: "Файл Main.java",
    exact: true,
  });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath("github-checkboxes.png"),
  });
  expect(fixture.projectWrites).toEqual([]);
  await importer
    .getByRole("button", {
      name: "Просмотреть выбранные исходники",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Создать проект из выбранного",
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.previews).toEqual([
    {
      snapshotId: "snapshot-fixture",
      paths: ["Main.java"],
      folders: [],
      allText: false,
    },
  ]);
  expect(fixture.projectWrites).toEqual([]);
  expect(fixture.starts).toEqual([]);
});

test("unlinked integration uses link authorization without an extra consent control", async ({
  page,
}) => {
  const fixture = await mockApi(page, {
    configured: true,
    linked: null,
    repositoryAccess: false,
    expiresAt: null,
  });
  await page.goto("/settings/integrations");
  await skipTour(page);
  const card = page.locator(".github-settings");
  await expect(card.locator(".integration-logo svg")).toBeVisible();
  await expect(card.locator(".integration-status")).toHaveText("Не подключено");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("github-unlinked.png"),
    fullPage: true,
  });
  await card
    .getByRole("button", { name: "Подключить GitHub", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "OAuth provider fixture" }),
  ).toBeVisible();
  expect(fixture.starts).toEqual([{ purpose: "link" }]);
  expect(fixture.projectWrites).toEqual([]);
});

test("connected password account opens projects and disconnects only after confirmation", async ({
  page,
}) => {
  const fixture = await mockApi(page, {
    configured: true,
    linked: { login: "linked-user", githubId: "42" },
    repositoryAccess: true,
    expiresAt: "2099-01-01T00:00:00Z",
  });
  await page.goto("/settings/integrations");
  await skipTour(page);
  const card = page.locator(".github-settings");
  await expect(card.locator(".integration-status")).toHaveText("Подключено");
  await expect(
    card.getByRole("link", { name: "Открыть проекты" }),
  ).toHaveAttribute("href", "/projects");
  await expect(card).toContainText("@linked-user");
  await expect(card).not.toContainText("42");
  await expect(card).not.toContainText("2099");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await card
    .getByRole("button", { name: "Отключить GitHub", exact: true })
    .click();
  expect(fixture.disconnects).toEqual([]);
  await expect(
    card.getByText("Отключить GitHub?", { exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(fixture.disconnects).toEqual([]);
  await card
    .getByRole("button", { name: "Отключить GitHub", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Да, отключить", exact: true })
    .click();
  await expect(card.locator(".integration-status")).toHaveText("Не подключено");
  await expect(card.getByRole("status")).toContainText("GitHub отключён.");
  expect(fixture.disconnects).toHaveLength(1);
  expect(fixture.starts).toEqual([]);
  expect(fixture.projectWrites).toEqual([]);
});

test("GitHub-only identity keeps its sign-in connection without a disconnect action", async ({
  page,
}) => {
  const fixture = await mockApi(
    page,
    {
      configured: true,
      linked: { login: "linked-user", githubId: "42" },
      repositoryAccess: true,
      expiresAt: null,
    },
    true,
    "github",
  );
  await page.goto("/settings/integrations");
  await skipTour(page);
  const card = page.locator(".github-settings");
  await expect(
    card.getByText("Используется для входа", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Отключить GitHub", exact: true }),
  ).toHaveCount(0);
  expect(fixture.disconnects).toEqual([]);
  expect(fixture.projectWrites).toEqual([]);
});

for (const appearance of [
  { name: "dark", theme: "dark", width: 1512, height: 982 },
  { name: "light", theme: "light", width: 1512, height: 982 },
  { name: "mobile", theme: "dark", width: 390, height: 844 },
]) {
  test(`compact GitHub integration fits ${appearance.name}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width: appearance.width,
      height: appearance.height,
    });
    await page.addInitScript(
      (theme) => localStorage.setItem("java-blueprints:theme", theme),
      appearance.theme,
    );
    const fixture = await mockApi(page, {
      configured: true,
      linked: { login: "linked-user", githubId: "42" },
      repositoryAccess: true,
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await page.goto("/settings/integrations");
    await skipTour(page);
    await expect(page.locator(".integration-status")).toHaveText("Подключено");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      appearance.theme,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`github-integration-${appearance.name}.png`),
      fullPage: true,
    });
    expect(fixture.starts).toEqual([]);
    expect(fixture.projectWrites).toEqual([]);
  });
}
