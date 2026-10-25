import { expect, test, type Page } from "@playwright/test";
import { presets } from "../src/themePalette";

// Every account/provider/project request is intercepted. These tests never touch
// real accounts, SMTP, provider consent, or stored projects.
const user = {
  id: "a1111111-1111-4111-8111-111111111111",
  username: "auth_fixture",
  displayName: "Auth fixture",
  bio: "",
  email: "fixture@example.invalid",
  emailVerified: true,
  authMethod: "password",
};
async function fixture(
  page: Page,
  options: {
    signedIn?: boolean;
    githubOnly?: boolean;
    signupError?: string;
    signupReadError?: string;
    sessionGate?: Promise<void>;
  } = {},
) {
  let signedIn = options.signedIn ?? false;
  const writes: { path: string; body: unknown }[] = [];
  const reads: string[] = [];
  const session = () => ({
    mode: signedIn ? "authenticated" : "local_guest",
    csrfToken: "fixture-csrf",
    user: signedIn
      ? { ...user, authMethod: options.githubOnly ? "github" : "password" }
      : null,
    capabilities: {
      registration: true,
      emailDelivery: false,
      legacyGuestWorkspace: true,
      projectCreation: signedIn,
      projectExport: signedIn,
    },
  });
  await page.route("https://github.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>OAuth fixture</h1>" }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const post = request.method() !== "GET";
    if (post) writes.push({ path, body: request.postDataJSON() });
    else reads.push(path);
    let data: unknown;
    if (path === "/api/v1/session") {
      await options.sessionGate;
      data = session();
    } else if (path === "/api/v1/github/status")
      data = {
        configured: true,
        unavailableReason: null,
        linked: options.githubOnly
          ? { login: "provider-fixture", githubId: "42" }
          : null,
        repositoryAccess: false,
        expiresAt: null,
      };
    else if (path === "/api/v1/github/signup") {
      if (!post && options.signupReadError)
        return route.fulfill({
          status: 401,
          json: {
            error: {
              code: options.signupReadError,
              message: "Pending signup expired",
            },
          },
        });
      if (post && options.signupError)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: options.signupError,
              message: "Fixture signup error",
            },
          },
        });
      if (post) {
        signedIn = true;
        data = session();
      } else
        data = {
          githubLogin: "provider-fixture",
          suggestedUsername: "provider_fixture",
          expiresAt: "2099-01-01T00:00:00Z",
        };
    } else if (path === "/api/v1/auth/login") {
      signedIn = true;
      data = session();
    } else if (path === "/api/v1/github/oauth/start")
      data = {
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=fixture&state=fixture",
      };
    else if (post)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "FIXTURE_UNEXPECTED_WRITE",
            message: "Unexpected fixture mutation",
          },
        },
      });
    else data = [];
    await route.fulfill({
      json: { data, meta: { requestId: "auth-fixture" } },
    });
  });
  return { writes, reads };
}
async function noWorkspace(page: Page) {
  await expect(
    page.locator(".product-sidebar, .workspace-dock, .react-flow"),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ваши проекты" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("dialog", { name: "Знакомство с JavaBlueprints" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", {
      name: "Открыть рабочее пространство",
      exact: true,
    }),
  ).toHaveCount(0);
}
async function login(page: Page) {
  await page.getByLabel("Почта или имя пользователя").fill(user.username);
  await page.getByLabel("Пароль", { exact: true }).fill("Fixture!password123");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}

for (const target of [
  "/projects",
  "/projects/fixture-private",
  "/settings",
  "/settings/security",
  "/friends",
]) {
  test(`anonymous ${target} waits for session then redirects without workspace flash`, async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await fixture(page, { sessionGate: gate });
    await page.addInitScript(() => {
      const flashes: string[] = [];
      Object.assign(window, { authWorkspaceFlashes: flashes });
      new MutationObserver(() => {
        for (const e of document.querySelectorAll(
          ".product-sidebar, .workspace-dock, .react-flow, .tour-overlay",
        ))
          if (e.getClientRects().length) flashes.push(e.className.toString());
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(target);
    await noWorkspace(page);
    release();
    await expect(page).toHaveURL(
      new RegExp(
        "/login\\?next=" +
          encodeURIComponent(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "$",
      ),
    );
    await expect(page.getByLabel("Почта или имя пользователя")).toBeVisible();
    await noWorkspace(page);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { authWorkspaceFlashes: string[] })
            .authWorkspaceFlashes,
      ),
    ).toEqual([]);
    expect(api.reads.some((path) => path === "/api/v1/projects")).toBe(false);
    expect(api.writes).toEqual([]);
  });
}

for (const preset of [...presets.map((p) => p.id), "custom"]) {
  test(`auth stays OLED and legible with saved ${preset} appearance`, async ({
    page,
  }) => {
    await fixture(page);
    await page.addInitScript(
      ({ preset, custom }) => {
        localStorage.setItem(
          "java-blueprints:appearance",
          JSON.stringify({ preset, custom }),
        );
      },
      {
        preset,
        custom: {
          background: "#ffffff",
          surface: "#f8f8f8",
          text: "#111111",
          muted: "#333333",
          accent: "#005500",
        },
      },
    );
    for (const route of ["/login", "/register"]) {
      await page.goto(route);
      await expect(page.locator(".auth-page")).toBeVisible();
      await expect(page.locator(".auth-page")).toHaveCSS(
        "background-color",
        "rgb(0, 0, 0)",
      );
      await expect(
        page.getByRole("button", { name: "Продолжить с GitHub", exact: true }),
      ).toBeEnabled();
      const appearance = await page
        .locator(".auth-form-panel")
        .evaluate((panel) => {
          const rgb = (value: string) =>
            (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const luma = (value: string) =>
            rgb(value)
              .map((v) => {
                const n = v / 255;
                return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
              })
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          return [
            ...panel.querySelectorAll(
              "label, input, button, a, h2, .product-muted",
            ),
          ]
            .filter((el) => el.getClientRects().length)
            .map((el) => {
              const style = getComputedStyle(el);
              let background = "rgb(0, 0, 0)";
              for (
                let parent: Element | null = el;
                parent;
                parent = parent.parentElement
              ) {
                const color = getComputedStyle(parent).backgroundColor;
                if (
                  color.startsWith("rgb(") ||
                  (color.startsWith("rgba(") && color.endsWith(", 1)"))
                ) {
                  background = color;
                  break;
                }
              }
              const a = luma(style.color),
                b = luma(background);
              return {
                text: el.textContent,
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                font: Number.parseFloat(style.fontSize),
              };
            });
        });
      expect(appearance.length).toBeGreaterThan(5);
      expect(
        appearance.every((entry) => entry.font >= 12 && entry.contrast >= 4.5),
      ).toBe(true);
      const github = page.getByRole("button", {
        name: "Продолжить с GitHub",
        exact: true,
      });
      const submit = page.locator('form button[type="submit"]');
      await expect(github).toBeVisible();
      await expect(github.locator("svg")).toHaveCount(1);
      expect((await github.boundingBox())!.y).toBeGreaterThan(
        (await submit.boundingBox())!.y,
      );
      await noWorkspace(page);
    }
  });
}

test("login and registration footers are reciprocal and keyboard accessible on mobile", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/login");
  await expect(page.locator(".auth-footer")).toContainText("Нет аккаунта?");
  await page
    .getByRole("link", { name: "Зарегистрироваться", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.locator(".auth-footer")).toContainText("Уже есть аккаунт?");
  await expect(page.locator(".auth-footer").getByRole("link")).toHaveCount(1);
  await page.locator(".auth-footer").getByRole("link").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Почта или имя пользователя").focus();
  await expect(page.getByLabel("Почта или имя пользователя")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Пароль", { exact: true })).toBeFocused();
  for (const path of [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password?token=fixture",
    "/verify-email?token=fixture",
    "/github/complete",
  ]) {
    await page.goto(path);
    await expect(page.locator(".auth-page")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await noWorkspace(page);
  }
  expect(api.writes).toEqual([]);
});

for (const next of [
  "https://example.invalid/steal",
  "//example.invalid/steal",
  "/\\example.invalid/steal",
  "/login",
  "/register",
  "/github/complete",
]) {
  test(`login rejects unsafe or recursive next ${next}`, async ({ page }) => {
    await fixture(page);
    await page.goto("/login?next=" + encodeURIComponent(next));
    await login(page);
    await expect(page).toHaveURL("http://127.0.0.1:5174/projects");
  });
}
test("login restores an internal destination after account refresh", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/login?next=" + encodeURIComponent("/settings/security"));
  await login(page);
  await expect(page).toHaveURL(/\/settings\/security$/);
});

test("GitHub signup loads identity and commits only a chosen username", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.addInitScript(() =>
    sessionStorage.setItem("java-blueprints:auth-return", "/settings/security"),
  );
  await page.goto("/github/complete");
  await expect(
    page.getByLabel("Имя пользователя", { exact: true }),
  ).toHaveValue("provider_fixture");
  await expect(page.getByText(/provider-fixture/)).toBeVisible();
  await expect(
    page.locator('input[type="password"], input[type="email"]'),
  ).toHaveCount(0);
  await noWorkspace(page);
  expect(api.writes).toEqual([]);
  await page
    .getByLabel("Имя пользователя", { exact: true })
    .fill("chosen_fixture");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/settings\/security$/);
  expect(api.writes).toEqual([
    { path: "/api/v1/github/signup", body: { username: "chosen_fixture" } },
  ]);
});
test("GitHub signup conflict retains chosen name without entering workspace", async ({
  page,
}) => {
  const api = await fixture(page, { signupError: "ACCOUNT_CONFLICT" });
  await page.goto("/github/complete");
  await page
    .getByLabel("Имя пользователя", { exact: true })
    .fill("taken_fixture");
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByLabel("Имя пользователя", { exact: true }),
  ).toHaveValue("taken_fixture");
  await expect(page).toHaveURL(/\/github\/complete$/);
  await noWorkspace(page);
  expect(api.writes).toHaveLength(1);
});
test("provider-only account security omits password and unlink controls", async ({
  page,
}) => {
  const api = await fixture(page, { signedIn: true, githubOnly: true });
  await page.goto("/settings/security");
  const tour = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  if (await tour.isVisible())
    await tour.getByRole("button", { name: "Пропустить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Безопасность", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Изменить пароль|Отвязать|Отключить GitHub/,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: /парол/i })).toHaveCount(0);
  await page.goto("/settings/integrations");
  await expect(page.getByText(/provider-fixture/)).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Отвязать|Отключить GitHub|Да, отключить/,
    }),
  ).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

for (const path of ["/login", "/register"]) {
  test(`${path} starts only fixture GitHub login after explicit button activation`, async ({
    page,
  }) => {
    const api = await fixture(page);
    await page.goto(path + "?next=" + encodeURIComponent("/settings/security"));
    const github = page.getByRole("button", {
      name: "Продолжить с GitHub",
      exact: true,
    });
    await expect(github).toBeEnabled();
    expect(api.writes).toEqual([]);
    await github.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "OAuth fixture", exact: true }),
    ).toBeVisible();
    expect(api.writes).toEqual([
      { path: "/api/v1/github/oauth/start", body: { purpose: "login" } },
    ]);
  });
}

test("expired GitHub pending signup offers login without an editable completion form", async ({
  page,
}) => {
  const api = await fixture(page, { signupReadError: "GITHUB_SIGNUP_INVALID" });
  await page.goto("/github/complete");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByLabel("Имя пользователя", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Вернуться ко входу", exact: true }),
  ).toHaveAttribute("href", "/login");
  await noWorkspace(page);
  expect(api.writes).toEqual([]);
});

for (const signedIn of [false, true]) {
  for (const mobile of [false, true]) {
    test(`root remains static landing for ${signedIn ? "account" : "anonymous"} visitor on ${mobile ? "mobile" : "desktop"}`, async ({
      page,
    }) => {
      const api = await fixture(page, { signedIn });
      if (mobile) await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/");
      await expect(page).toHaveURL("http://127.0.0.1:5174/");
      await expect(
        page.getByRole("heading", {
          name: /У кода есть.*другая сторона\./,
          level: 1,
        }),
      ).toBeVisible();
      await expect(page.locator(".auth-page")).toHaveCount(0);
      await noWorkspace(page);
      const loginLink = page.locator('[data-action="login"]');
      await expect(loginLink).toHaveText(signedIn ? "Мои проекты" : "Войти");
      await expect(loginLink).toHaveAttribute(
        "href",
        signedIn ? "/projects" : "/login",
      );
      const workspace = page
        .getByRole("link", { name: "Открыть пространство", exact: true })
        .first();
      await expect(workspace).toHaveAttribute("href", "/projects");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(api.reads).not.toContain("/api/v1/projects");
      await page.screenshot({
        path: test.info().outputPath("landing.png"),
        fullPage: true,
      });
      if (!signedIn) {
        await workspace.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/);
        await noWorkspace(page);
        await page.goto("/");
        await page.getByRole("link", { name: "Войти", exact: true }).click();
        await expect(page).toHaveURL(/\/login$/);
      }
      expect(api.writes).toEqual([]);
    });
  }
}

test("anonymous public project opens read only without account navigation or write requests", async ({
  page,
}) => {
  const api = await fixture(page);
  const projectId = "99999999-9999-4999-8999-999999999999";
  await page.route("**/api/v1/projects/" + projectId, (route) =>
    route.fulfill({
      json: {
        data: {
          id: projectId,
          name: "Public read only fixture",
          headRevisionId: null,
          originalRevisionId: null,
          ownerId: user.id,
          role: "viewer",
          visibility: "public",
          canEdit: false,
          updatedAt: "2026-10-25T00:00:00Z",
        },
      },
    }),
  );
  await page.route("**/api/v1/capabilities", (route) =>
    route.fulfill({ json: { data: { runner: { available: false } } } }),
  );
  await page.goto("/projects/" + projectId);
  await expect(page.locator('.workbench[data-readonly="true"]')).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:5174/projects/" + projectId);
  await expect(page.locator(".product-sidebar")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Запуск", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать файл", exact: true }),
  ).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("auth visual evidence covers desktop and mobile form layout", async ({
  page,
}) => {
  const api = await fixture(page);
  for (const mobile of [false, true]) {
    await page.setViewportSize(
      mobile ? { width: 360, height: 800 } : { width: 1512, height: 982 },
    );
    for (const route of ["login", "register"]) {
      await page.goto("/" + route);
      await expect(
        page.getByRole("button", { name: "Продолжить с GitHub", exact: true }),
      ).toBeEnabled();
      await expect(page.locator(".auth-page")).toHaveCSS(
        "background-color",
        "rgb(0, 0, 0)",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`${route}-${mobile ? "mobile" : "desktop"}.png`),
        fullPage: true,
      });
    }
  }
  expect(api.writes).toEqual([]);
});

test("signed in dark projects visual evidence has real empty collection state", async ({
  page,
}) => {
  const api = await fixture(page, { signedIn: true });
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Ваши проекты", exact: true }),
  ).toBeVisible();
  const tour = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: "Пропустить", exact: true }).click();
  await expect(tour).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("projects-dark-desktop.png"),
    fullPage: true,
  });
  expect(api.writes).toEqual([]);
});

test("landing loads local images and supports feature focus, hover and image viewer", async ({
  page,
}) => {
  const api = await fixture(page);
  const errors: string[] = [],
    missing: string[] = [],
    external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() === 404) missing.push(response.url());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:5174")
      external.push(request.url());
  });
  await page.goto("/");
  for (const image of await page.locator(".page img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate(
          (element) =>
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth > 0,
        ),
      )
      .toBe(true);
  }
  const cards = page.locator(".depth-card");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    await card.scrollIntoViewIfNeeded();
    await page.keyboard.press("Tab");
    await card.focus();
    await expect(card).toBeFocused();
    await expect(card).toHaveClass(/\bis-active\b/);
    await page.locator(".preview-open").focus();
    await expect(card).not.toHaveClass(/\bis-active\b/);
    await card.hover();
    await expect(card).toHaveClass(/\bis-active\b/);
    await page.mouse.move(1, 1);
    await expect(card).not.toHaveClass(/\bis-active\b/);
  }
  await page.getByRole("button", { name: "Рассмотреть", exact: true }).click();
  const viewer = page.getByRole("dialog", {
    name: "Рабочее пространство JavaBlueprints",
    exact: true,
  });
  await expect(viewer).toBeVisible();
  await expect
    .poll(() =>
      viewer
        .locator("img")
        .evaluate(
          (element) =>
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth > 0,
        ),
    )
    .toBe(true);
  await viewer.getByRole("button", { name: "Увеличить", exact: true }).click();
  await expect(
    viewer.getByRole("button", { name: "Вписать", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await viewer.getByRole("button", { name: "Вписать", exact: true }).click();
  await expect(
    viewer.getByRole("button", { name: "Увеличить", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await page.locator(".primary-action").first().focus();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: test.info().outputPath("landing-loaded-desktop.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(missing).toEqual([]);
  expect(external).toEqual([]);
  expect(api.writes).toEqual([]);
});

for (const result of ["login_success", "signup_success"]) {
  test(`GitHub ${result} consumes safe callback destination while root stays landing`, async ({
    page,
  }) => {
    const api = await fixture(page, { signedIn: true, githubOnly: true });
    await page.addInitScript(() =>
      sessionStorage.setItem(
        "java-blueprints:auth-return",
        "/settings/security",
      ),
    );
    await page.goto("/projects?github=" + result);
    await expect(page).toHaveURL("http://127.0.0.1:5174/settings/security");
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("java-blueprints:auth-return"),
      ),
    ).toBeNull();
    await expect(
      page.getByRole("heading", {
        name: "Безопасность",
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: /У кода есть.*другая сторона\./,
        level: 1,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL("http://127.0.0.1:5174/");
    await noWorkspace(page);
    expect(api.writes).toEqual([]);
  });
}
