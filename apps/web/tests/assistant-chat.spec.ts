import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "assistant-fixture",
  username: "assistant_fixture",
  displayName: "Assistant Fixture",
  emailVerified: true,
  authMethod: "password",
};
async function fixture(page: Page, signedIn = true) {
  const writes: { path: string; body: any }[] = [];
  let messages: any[] = [];
  const conversation = () => ({
    id: "conversation-fixture",
    title: "Проверка помощника",
    messages,
  });
  await page.addInitScript((id) => {
    for (const scope of ["home", "workspace", "profile", "settings"])
      localStorage.setItem(
        `java-blueprints:onboarding:v1:${id}:${scope}`,
        "done",
      );
  }, user.id);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET")
      writes.push({ path, body: request.postDataJSON() });
    let data: any = [];
    if (path === "/api/v1/session")
      data = {
        mode: signedIn ? "authenticated" : "local_guest",
        csrfToken: "fixture",
        user: signedIn ? user : null,
        capabilities: {
          registration: true,
          legacyGuestWorkspace: true,
          projectCreation: signedIn,
        },
      };
    else if (path === "/api/v1/profile") data = user;
    else if (path === "/api/v1/github/status")
      data = { configured: false, linked: null };
    else if (path === "/api/v1/assistant/status")
      data = { configured: true, model: "fixture" };
    else if (path === "/api/v1/assistant/conversations")
      data =
        request.method() === "POST"
          ? conversation()
          : messages.length
            ? [
                {
                  id: "conversation-fixture",
                  title: "Проверка помощника",
                  updatedAt: "2026-10-25T10:00:00Z",
                },
              ]
            : [];
    else if (path.endsWith("/messages")) {
      messages = [
        ...messages,
        {
          id: `u-${messages.length}`,
          role: "user",
          content: request.postDataJSON().content,
          createdAt: "2026-10-25T10:00:00Z",
        },
        {
          id: `a-${messages.length}`,
          role: "assistant",
          content: "Ответ <img src=x onerror=alert(1)>",
          createdAt: "2026-10-25T10:00:01Z",
          actions: [
            {
              id: "tests-confirm",
              type: "run_tests",
              args: {},
              risk: "confirm",
              label: "Запуск тестов",
              description: "Подтвердите запуск тестов выбранного проекта",
              status: "pending",
            },
            {
              id: "auto-panel",
              type: "show_panel",
              args: { panel: "tests" },
              risk: "none",
              label: "Открыть тесты",
              description: "Открыть панель выбранного проекта",
              status: "pending",
            },
            {
              id: "guide",
              type: "guide",
              args: {},
              risk: "confirm",
              label: "Как запустить тесты",
              description: "Пошаговая инструкция",
              status: "pending",
            },
            {
              id: "visibility",
              type: "set_visibility",
              args: { projectId: "fixture", visibility: "public" },
              risk: "typed",
              label: "Сделать проект fixture публичным",
              description: "Исходный код станет доступен другим пользователям",
              status: "pending",
            },
          ],
        },
      ];
      data = conversation();
    } else if (path.endsWith("/actions/tests-confirm/cancel")) {
      for (const message of messages)
        for (const action of message.actions ?? [])
          if (action.id === "tests-confirm") action.status = "cancelled";
      data = { action: { id: "tests-confirm", status: "cancelled" } };
    } else if (path.endsWith("/actions/auto-panel"))
      data = {
        action: { id: "auto-panel", status: "pending" },
        command: { type: "show_panel", args: { panel: "tests" } },
      };
    else if (path.endsWith("/actions/auto-panel/result"))
      data = { recorded: true };
    else if (path.endsWith("/actions/visibility"))
      data = { action: { id: "visibility", status: "completed" } };
    else if (path.endsWith("/actions/guide"))
      data = { action: { id: "guide", status: "completed" } };
    else if (path === "/api/v1/assistant/conversations/conversation-fixture") {
      if (request.method() === "DELETE") {
        messages = [];
        data = { deleted: true };
      } else data = conversation();
    } else if (path === "/api/v1/friend-requests")
      data = { incoming: [], outgoing: [] };
    else if (request.method() !== "GET")
      return route.fulfill({
        status: 409,
        json: { error: { code: "FIXTURE", message: "Unexpected write" } },
      });
    return route.fulfill({ json: { data } });
  });
  return writes;
}

test("assistant keeps draft/history through close, safely renders text and scopes typed confirmation", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.goto("/projects");
  await page
    .getByRole("button", { name: "Открыть беседу с помощником" })
    .click();
  const chat = page.getByRole("dialog", { name: "Помощник — беседа" });
  await expect(chat.getByText("Чем помочь?")).toBeVisible();
  await chat.getByLabel("Сообщение помощнику").fill("Черновик");
  await chat.getByRole("button", { name: "Закрыть беседу" }).click();
  await page
    .getByRole("button", { name: "Открыть беседу с помощником" })
    .click();
  await expect(chat.getByLabel("Сообщение помощнику")).toHaveValue("Черновик");
  await chat.getByRole("button", { name: "Отправить сообщение" }).click();
  await expect(
    chat.getByText("Ответ <img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await expect(chat.locator("img")).toHaveCount(0);
  await expect
    .poll(
      () =>
        writes.filter((w) => w.path.endsWith("/actions/auto-panel/result"))
          .length,
    )
    .toBe(1);
  expect(
    writes.find((w) => w.path.endsWith("/actions/auto-panel/result"))?.body.ok,
  ).toBe(false);
  await expect(
    chat.getByText("Сначала откройте проект и выберите файл.", { exact: true }),
  ).toBeVisible();
  expect(
    writes.filter(
      (w) =>
        w.path.endsWith("/actions/guide") ||
        w.path.endsWith("/actions/visibility"),
    ),
  ).toHaveLength(0);
  const testAction = chat
    .locator(".assistant-action")
    .filter({ hasText: "Подтвердите запуск тестов выбранного проекта" });
  await expect(
    testAction.getByRole("button", { name: "Да, запустить тесты" }),
  ).toBeVisible();
  await testAction.getByRole("button", { name: "Нет, уточнить" }).click();
  await expect(
    testAction.getByText("Отменено. Уточните, что нужно сделать.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(chat.getByLabel("Сообщение помощнику")).toHaveValue(
    "Уточню задачу: ",
  );
  expect(
    writes.filter((w) => w.path.endsWith("/actions/tests-confirm")),
  ).toHaveLength(0);
  const visibility = chat
    .locator(".assistant-action")
    .filter({ hasText: "Сделать проект fixture публичным" });
  const apply = visibility.getByRole("button", {
    name: "Сделать проект fixture публичным",
  });
  await expect(apply).toBeDisabled();
  await visibility.getByRole("textbox").fill("Да");
  await expect(apply).toBeDisabled();
  await visibility.getByRole("textbox").fill("да");
  await apply.click();
  await expect(
    visibility.getByText("Выполнено", { exact: true }),
  ).toBeVisible();
  expect(
    writes.find((w) => w.path.endsWith("/actions/visibility"))?.body,
  ).toEqual({ confirmation: "да" });
  await chat.getByRole("button", { name: "Показать", exact: true }).click();
  await expect
    .poll(() => writes.filter((w) => w.path.endsWith("/actions/guide")).length)
    .toBe(1);
  await chat.getByLabel("Сообщение помощнику").press("Escape");
  await expect(chat).toBeHidden();
  await page
    .getByRole("button", { name: "Открыть беседу с помощником" })
    .click();
  await chat
    .getByRole("button", { name: "Беседа", exact: false })
    .first()
    .click();
  await expect(
    chat.getByRole("navigation", { name: "История бесед" }),
  ).toContainText("Проверка помощника");
  expect(
    writes.filter((w) => w.path.endsWith("/actions/auto-panel")).length,
  ).toBe(1);
  await chat
    .getByRole("button", {
      name: "Удалить беседу «Проверка помощника»",
      exact: true,
    })
    .click();
  const confirm = chat.getByRole("group", {
    name: "Удаление беседы «Проверка помощника»",
  });
  await expect(confirm).toContainText("Проекты сохранятся.");
  expect(
    writes.filter((w) => w.path.endsWith("/conversation-fixture")),
  ).toHaveLength(0);
  await confirm
    .getByRole("button", { name: "Удалить беседу", exact: true })
    .click();
  await expect(
    chat.getByRole("navigation", { name: "История бесед" }),
  ).toContainText("Здесь появятся ваши беседы");
  await expect(chat.getByText("Чем помочь?", { exact: true })).toBeVisible();
  expect(
    writes.filter(
      (w) => w.path === "/api/v1/assistant/conversations/conversation-fixture",
    ),
  ).toHaveLength(1);
  expect(
    writes.filter((w) => w.path.startsWith("/api/v1/projects/")),
  ).toHaveLength(0);
});

test("assistant is absent for anonymous visitors", async ({ page }) => {
  await fixture(page, false);
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "Открыть беседу с помощником" }),
  ).toHaveCount(0);
});

test("assistant source context is opt-in and role access requires exact typed confirmation", async ({ page }) => {
  await fixture(page);
  const sent: any[] = [], confirmations: any[] = [];
  await page.route("**/api/v1/assistant/conversations/*/messages", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { data: { id: "conversation-fixture", title: "Доступ", messages: [
      { id: "request", role: "user", content: "Дай доступ friend", createdAt: "2026-10-25T10:00:00Z" },
      { id: "answer", role: "assistant", content: "Подтвердите точные изменения.", createdAt: "2026-10-25T10:00:01Z", actions: [
        { id: "role", type: "project_role", args: { projectId: "fixture-project", username: "friend", role: "editor" }, risk: "typed", label: "Изменить доступ к проекту", description: "Проект fixture-project: доступ @friend станет editor. Введите да.", status: "pending" },
        { id: "edit", type: "code_edit", args: { filePath: "Main.java", expectedText: "return 1;", replacement: "return 2;" }, risk: "confirm", label: "Подготовить правку кода", description: "Отдельный кандидат Main.java; исходная версия не изменится", status: "pending" },
      ] },
    ] } } });
  });
  await page.route("**/api/v1/assistant/conversations/*/actions/role", async (route) => {
    confirmations.push(route.request().postDataJSON());
    await route.fulfill({ json: { data: { action: { id: "role", type: "project_role", status: "completed" } } } });
  });
  await page.goto("/projects");
  await page.getByRole("button", { name: "Открыть беседу с помощником" }).click();
  const chat = page.getByRole("dialog", { name: "Помощник — беседа" });
  const consent=chat.getByRole("checkbox",{ name: /Передать DeepSeek/ });
  await expect(consent).not.toBeChecked();
  await chat.getByLabel("Сообщение помощнику").fill("Дай доступ friend");
  await chat.getByRole("button",{name:"Отправить сообщение"}).click();
  await expect.poll(()=>sent.length).toBe(1);
  expect(sent[0].context.includeSource).toBe(false);
  const role=chat.locator(".assistant-action").filter({hasText:"доступ @friend станет editor"});
  const confirm=role.getByRole("button",{name:"Изменить доступ к проекту",exact:true});
  await expect(confirm).toBeDisabled();
  await role.getByRole("textbox").fill("Да");
  await expect(confirm).toBeDisabled();
  await role.getByRole("textbox").fill("да ");
  await expect(confirm).toBeDisabled();
  expect(confirmations).toHaveLength(0);
  await role.getByRole("textbox").fill("да");
  await confirm.click();
  await expect.poll(()=>confirmations.length).toBe(1);
  expect(confirmations[0]).toEqual({confirmation:"да"});
  await expect(role.getByText("Выполнено",{exact:true})).toBeVisible();
  await chat.getByText("Предлагаемый фрагмент · Main.java",{exact:true}).click();
  await expect(chat.getByText("return 1;",{exact:true})).toBeVisible();
  await expect(chat.getByText("return 2;",{exact:true})).toBeVisible();
  await consent.check();
  await chat.getByLabel("Сообщение помощнику").fill("Подготовь правку");
  await chat.getByRole("button",{name:"Отправить сообщение"}).click();
  await expect.poll(()=>sent.length).toBe(2);
  expect(sent[1].context.includeSource).toBe(true);
});

test("assistant tracks unread replies and stop prevents a late reply from replacing the conversation", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  let processed!: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = new Promise<void>((resolve) => {
    processed = resolve;
  });
  let reply = "Ответ, пришедший в свёрнутую беседу";
  await page.route(
    "**/api/v1/assistant/conversations/*/messages",
    async (route) => {
      const pending = gate;
      const finish = processed;
      const text = reply;
      await pending;
      try {
        await route.fulfill({
          json: {
            data: {
              id: "conversation-fixture",
              title: "Проверка помощника",
              messages: [
                {
                  id: text,
                  role: "assistant",
                  content: text,
                  createdAt: "2026-10-25T10:00:00Z",
                },
              ],
            },
          },
        });
      } catch {
        /* The stop button aborts the browser request. */
      } finally {
        finish();
      }
    },
  );
  await page.goto("/projects");
  await page
    .getByRole("button", { name: "Открыть беседу с помощником" })
    .click();
  const chat = page.getByRole("dialog", { name: "Помощник — беседа" });
  await expect(chat.getByText("Чем помочь?")).toBeVisible();
  await chat.getByLabel("Сообщение помощнику").fill("Первый запрос");
  const firstRequest = page.waitForRequest(
    "**/assistant/conversations/*/messages",
  );
  await chat.getByRole("button", { name: "Отправить сообщение" }).click();
  await firstRequest;
  await chat.getByRole("button", { name: "Закрыть беседу" }).click();
  release();
  await settled;
  await page
    .getByRole("button", { name: "Открыть беседу — новый ответ" })
    .click();
  await expect(chat.getByText(reply, { exact: true })).toBeVisible();
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  settled = new Promise<void>((resolve) => {
    processed = resolve;
  });
  reply = "Поздний ответ остановленного запроса";
  await chat.getByLabel("Сообщение помощнику").fill("Второй запрос");
  const secondRequest = page.waitForRequest(
    "**/assistant/conversations/*/messages",
  );
  await chat.getByRole("button", { name: "Отправить сообщение" }).click();
  await secondRequest;
  await chat
    .getByRole("button", { name: "Остановить ожидание ответа" })
    .click();
  release();
  await settled;
  await expect(
    chat.getByText("Ожидание ответа остановлено.", { exact: false }),
  ).toBeVisible();
  await expect(chat.getByText(reply, { exact: true })).toHaveCount(0);
});

for (const visual of [
  { name: "dark", theme: "dark", width: 1512, height: 982 },
  { name: "light", theme: "light", width: 1512, height: 982 },
  { name: "mobile", theme: "dark", width: 390, height: 844 },
])
  test(`assistant visual ${visual.name} fits viewport and follows palette`, async ({
    page,
  }, testInfo) => {
    await fixture(page);
    await page.setViewportSize({ width: visual.width, height: visual.height });
    await page.addInitScript((theme) => {
      localStorage.removeItem("java-blueprints:appearance");
      localStorage.setItem("java-blueprints:theme", theme);
    }, visual.theme);
    await page.route("**/api/v1/assistant/conversations", (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: "visual",
              title: "Тесты проекта",
              updatedAt: "2026-10-25T10:00:00Z",
            },
          ],
        },
      }),
    );
    await page.route("**/api/v1/assistant/conversations/visual", (route) =>
      route.fulfill({
        json: {
          data: {
            id: "visual",
            title: "Тесты проекта",
            messages: [
              {
                id: "user",
                role: "user",
                content: "Как запустить тесты проекта?",
                createdAt: "2026-10-25T10:00:00Z",
              },
              {
                id: "assistant",
                role: "assistant",
                content:
                  "Могу показать, где находится панель тестов, или рассказать о порядке запуска. Выберите подходящий вариант.",
                createdAt: "2026-10-25T10:00:01Z",
                actions: [
                  {
                    id: "show",
                    type: "guide",
                    args: {},
                    risk: "confirm",
                    label: "Запуск тестов",
                    description: "Пройдём по интерфейсу шаг за шагом.",
                    status: "pending",
                  },
                  {
                    id: "explain",
                    type: "explain",
                    args: {},
                    risk: "confirm",
                    label: "Как устроены тесты",
                    description: "Объясню порядок действий в беседе.",
                    status: "pending",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    await page.goto("/projects");
    await page
      .getByRole("button", { name: "Открыть беседу с помощником" })
      .click();
    const chat = page.getByRole("dialog", { name: "Помощник — беседа" });
    await expect(
      chat.getByRole("button", { name: "Рассказать", exact: true }),
    ).toBeVisible();
    const bounds = await chat.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(visual.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(visual.height);
    expect(await chat.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
      "none",
    );
    await page.screenshot({
      path: testInfo.outputPath(`assistant-${visual.name}.png`),
      fullPage: true,
    });
  });

for (const width of [1440, 390]) {
  test(`assistant formats bold safely and changes actual size at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.route("**/api/v1/assistant/conversations", (r) =>
      r.fulfill({
        json: {
          data: [
            {
              id: "formatted",
              title: "Форматирование",
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      }),
    );
    await page.route("**/api/v1/assistant/conversations/formatted", (r) =>
      r.fulfill({
        json: {
          data: {
            id: "formatted",
            title: "Форматирование",
            messages: [
              {
                id: "u",
                role: "user",
                content: "**мой текст**",
                createdAt: new Date().toISOString(),
              },
              {
                id: "a",
                role: "assistant",
                content:
                  '- **Навигация**: откройте проекты.\n__Тема__: OLED.\n`**не жирный код**`\n```java\nString text = "**literal**";\n```\n<img src=x onerror=alert(1)>',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        },
      }),
    );
    await page.goto("/projects");
    await page
      .getByRole("button", { name: "Открыть беседу с помощником" })
      .click();
    const chat = page.getByRole("dialog", { name: "Помощник — беседа" });
    await expect(
      chat.locator(".assistant-message-assistant strong"),
    ).toHaveText(["Навигация", "Тема"]);
    await expect(chat.locator(".assistant-message-user strong")).toHaveCount(0);
    await expect(
      chat.locator(".assistant-message-assistant code").first(),
    ).toHaveText("**не жирный код**");
    await expect(chat.locator("pre code")).toContainText("**literal**");
    await expect(chat.locator("img")).toHaveCount(0);
    const before = (await chat.boundingBox())!;
    await chat
      .getByRole("button", { name: "Развернуть беседу", exact: true })
      .click();
    await expect(chat).toHaveClass(/is-expanded/);
    await expect
      .poll(async () => (await chat.boundingBox())!.height)
      .toBeGreaterThan(before.height + 100);
    const expanded = (await chat.boundingBox())!;
    expect(expanded.y).toBeGreaterThanOrEqual(0);
    expect(expanded.x + expanded.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath("formatted-expanded.png") });
    await chat.getByRole("button", { name: "Настройки беседы" }).click();
    await chat
      .getByRole("button", { name: "Компактный вид", exact: true })
      .click();
    await expect(chat).not.toHaveClass(/is-expanded/);
    await expect
      .poll(async () =>
        Math.abs((await chat.boundingBox())!.height - before.height),
      )
      .toBeLessThan(2);
  });
}
