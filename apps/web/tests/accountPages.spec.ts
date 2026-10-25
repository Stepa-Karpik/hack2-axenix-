import { chooseOption } from "./selectControl";
import { test, expect } from "@playwright/test";
import { headers } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

test.beforeEach(async ({ page }) => {
  const session = (await (await page.request.get("/api/v1/session")).json())
    .data;
  test.skip(
    session.capabilities.emailDelivery,
    "Synthetic account tests require SMTP delivery disabled",
  );
});

test("real account login, profile save, friendship and explicit local workspace", async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const username = "pages_" + suffix;
  const peer = "friend_" + suffix;
  const password = "Blueprints!secure_" + suffix;
  for (const name of [username, peer]) {
    const response = await page.request.post("/api/v1/auth/register", {
      headers: await headers(page.request),
      data: { username: name, email: name + "@example.com", password },
    });
    expect(response.status()).toBe(201);
    const registration = (await response.json()).data;
    expect(registration.user.username).toBe(name);
    expect(typeof registration.emailDelivery).toBe("boolean");
  }
  await page.goto("/login");
  await page.getByLabel("Почта или имя пользователя").fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваши проекты" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Локальное пространство", exact: true })
    .click();
  await expect(page.getByText("Прежние проекты этого сервера")).toBeVisible();
  await page.goto("/settings");
  await page.getByLabel("Имя", { exact: true }).fill("Profile " + suffix);
  await page.getByLabel("О себе").fill("Real API profile update");
  await page.getByRole("button", { name: "Сохранить профиль" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Профиль сохранён на сервере.",
  );
  await page.getByRole("link", { name: "Открыть профиль" }).click();
  await expect(
    page.getByRole("heading", { name: "Profile " + suffix }),
  ).toBeVisible();
  await expect(page.getByText("Real API profile update")).toBeVisible();
  await page.goto("/u/" + peer);
  await page.getByRole("button", { name: "Добавить в друзья" }).click();
  await expect(
    page.getByRole("button", { name: "Отменить заявку" }),
  ).toBeVisible();
  const second = await browser.newContext({ baseURL: "http://127.0.0.1:5174" });
  try {
    const secondPage = await second.newPage();
    await secondPage.goto("/login");
    await secondPage.getByLabel("Почта или имя пользователя").fill(peer);
    await secondPage.getByLabel("Пароль", { exact: true }).fill(password);
    await secondPage
      .getByRole("button", { name: "Войти", exact: true })
      .click();
    await expect(
      secondPage.getByRole("heading", { name: "Ваши проекты" }),
    ).toBeVisible();
    await secondPage.goto("/friends");
    await secondPage
      .getByRole("button", { name: "Принять", exact: true })
      .click();
    await expect(
      secondPage.getByRole("button", { name: "Удалить", exact: true }),
    ).toBeVisible();
    await page.goto("/friends");
    await expect(
      page.locator(".person-details").filter({ hasText: "@" + peer }),
    ).toBeVisible();
    const created = await page.request.post("/api/v1/projects", {
      headers: await headers(page.request),
      data: { name: "Shared " + suffix },
    });
    expect(created.status()).toBe(201);
    const project = (await created.json()).data;
    let revisionId = "empty";
    for (const value of [1, 2]) {
      const revision = await page.request.post(
        "/api/v1/projects/" + project.id + "/revisions",
        {
          headers: { ...(await headers(page.request)), "If-Match": revisionId },
          data: {
            files: [
              {
                path: "Main.java",
                content:
                  "public class Main { public static int value() { return " +
                  value +
                  "; } }",
              },
            ],
            directories: [],
            intent: "semantic_edit",
            expectedHeadRevisionId: revisionId,
          },
        },
      );
      expect(revision.ok()).toBeTruthy();
      revisionId = (await revision.json()).data.id;
    }
    await page.goto("/projects/" + project.id);
    await expect(
      page.locator(".react-flow__node-blueprint").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Поделиться", exact: true }).click();
    const access = page.getByRole("dialog", { name: "Доступ к проекту" });
    await expect(access).toBeVisible();
    await chooseOption(
      access.getByRole("combobox", { name: "Видимость проекта" }),
      "public",
    );
    await expect(
      access.getByRole("combobox", { name: "Видимость проекта" }),
    ).toBeEnabled();
    const beforeInvite = (
      await (await secondPage.request.get("/api/v1/projects")).json()
    ).data;
    expect(beforeInvite.map((p: { id: string }) => p.id)).not.toContain(
      project.id,
    );
    await chooseOption(
      access.getByRole("combobox", { name: "Друг для приглашения" }),
      peer,
    );
    await chooseOption(
      access.getByRole("combobox", { name: "Роль участника" }),
      "editor",
    );
    await access
      .getByRole("button", { name: "Пригласить", exact: true })
      .click();
    await expect(
      access.getByText("@" + peer + " · Редактирование"),
    ).toBeVisible();
    const afterInvite = (
      await (await secondPage.request.get("/api/v1/projects")).json()
    ).data;
    expect(afterInvite.map((p: { id: string }) => p.id)).toContain(project.id);
    await secondPage.goto("/projects/" + project.id);
    await secondPage
      .getByRole("button", { name: "Поделиться", exact: true })
      .click();
    await expect(
      secondPage.getByText(
        "Вам доступно редактирование. Доступом управляет владелец.",
      ),
    ).toBeVisible();
    await expect(
      secondPage.getByRole("combobox", { name: "Видимость проекта" }),
    ).toHaveCount(0);
    await access
      .getByRole("button", { name: "Убрать доступ", exact: true })
      .click();
    await chooseOption(
      access.getByRole("combobox", { name: "Друг для приглашения" }),
      peer,
    );
    await chooseOption(
      access.getByRole("combobox", { name: "Роль участника" }),
      "viewer",
    );
    await access
      .getByRole("button", { name: "Пригласить", exact: true })
      .click();
    await expect(access.getByText("@" + peer + " · Просмотр")).toBeVisible();
    await secondPage.goto("/projects/" + project.id);
    await expect(
      secondPage.getByText("Проект открыт для просмотра.", { exact: true }),
    ).toBeVisible();
    await expect(
      secondPage.getByRole("button", { name: "Запуск", exact: true }),
    ).toBeHidden();
    await expect(
      secondPage.locator('.explorer-tools button[aria-label="Создать файл"]'),
    ).toBeHidden();
    const mutations: string[] = [];
    secondPage.on("request", (request) => {
      if (
        (request.method() === "PUT" && request.url().includes("/layout")) ||
        (request.method() === "POST" && request.url().endsWith("/restore"))
      )
        mutations.push(request.url());
    });
    await revealPanel(secondPage, "history", "История");
    const restore = secondPage
      .getByRole("button", { name: /^Восстановить версию/ })
      .first();
    await expect(restore).toBeDisabled();
    const node = secondPage.locator(".react-flow__node-blueprint").first();
    await expect(node).toBeVisible();
    await expect(node).not.toHaveClass(/\bdraggable\b/);
    await node.click();
    const bounds = await node.boundingBox();
    if (!bounds) throw new Error("Missing graph node bounds");
    await secondPage.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await secondPage.mouse.down();
    await secondPage.mouse.move(
      bounds.x + bounds.width / 2 + 40,
      bounds.y + bounds.height / 2 + 40,
      { steps: 8 },
    );
    await secondPage.mouse.up();
    expect(mutations).toEqual([]);
  } finally {
    await second.close();
  }
});

test("invalid verification token reports server failure without a success message", async ({
  page,
}) => {
  await page.goto("/verify-email?token=invalid");
  await page
    .getByRole("button", { name: "Подтвердить почту", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Ссылка недействительна или срок её действия истёк.",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("registration and recovery explain unavailable mail truthfully", async ({
  page,
}) => {
  const session = (await (await page.request.get("/api/v1/session")).json())
    .data;
  test.skip(
    session.capabilities.emailDelivery,
    "Requires server without SMTP configuration",
  );
  const username =
    "delivery_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  await page.goto("/register");
  await page.getByLabel("Имя пользователя").fill(username);
  await page.getByLabel("Электронная почта").fill(username + "@example.com");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("Blueprints!secure_" + username);
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "письмо подтверждения не отправлено",
  );
  await page.goto("/forgot-password");
  await page.getByLabel("Электронная почта").fill(username + "@example.com");
  await page
    .getByRole("button", { name: "Отправить ссылку", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Отправка писем пока недоступна. Попробуйте позже.",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("password confirmation blocks mismatches and real password changes preserve failed input", async ({
  page,
}) => {
  const username =
    "password_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const oldPassword = "Original!secure_" + username;
  const newPassword = "Changed!secure_" + username;
  const registered = await page.request.post("/api/v1/auth/register", {
    headers: await headers(page.request),
    data: { username, email: username + "@example.com", password: oldPassword },
  });
  expect(registered.status()).toBe(201);
  await page.goto("/login");
  await page.getByLabel("Почта или имя пользователя").fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваши проекты" }),
  ).toBeVisible();
  await page.goto("/settings");
  const current = page.getByLabel("Текущий пароль", { exact: true });
  const next = page.getByLabel("Новый пароль", { exact: true });
  const confirm = page.getByLabel("Повторите пароль", { exact: true });
  let passwordPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/auth/change-password")
    )
      passwordPosts++;
  });
  await current.fill("Wrong!current_password");
  await next.fill(newPassword);
  await confirm.fill(newPassword + "mismatch");
  await page
    .getByRole("button", { name: "Изменить пароль", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Новые пароли не совпадают.",
  );
  expect(passwordPosts).toBe(0);
  await confirm.fill(newPassword);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const failed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/auth/change-password") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Изменить пароль", exact: true })
    .click();
  expect((await failed).status()).toBe(401);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(current).toHaveValue("Wrong!current_password");
  await expect(next).toHaveValue(newPassword);
  await expect(confirm).toHaveValue(newPassword);
  await current.fill(oldPassword);
  await page
    .getByRole("button", { name: "Изменить пароль", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Пароль изменён");
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");
  await expect(confirm).toHaveValue("");
  await page
    .getByRole("button", { name: "Выйти из аккаунта", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Вы вышли из аккаунта.");
  await page.goto("/login");
  await page.getByLabel("Почта или имя пользователя").fill(username);
  await page.getByLabel("Пароль", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Пароль", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваши проекты" }),
  ).toBeVisible();
});
