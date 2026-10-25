import { chooseOption } from "./selectControl";
import { setTheme } from "./flowAssertions";
import { test, expect } from "@playwright/test";
import { panToNode } from "./flowAssertions";
test("expired browser session reacquires CSRF once and saves with the original idempotency key", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Session smoke " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  await context.clearCookies();
  const attempts: { status: number; key: string | undefined }[] = [];
  page.on("response", (response) => {
    if (
      response.url().endsWith("/revisions") &&
      response.request().method() === "POST"
    )
      attempts.push({
        status: response.status(),
        key: response.request().headers()["idempotency-key"],
      });
  });
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    "public class Main { static int recovered = 7; }\n",
  );
  await page.keyboard.press("Control+s");
  await expect(page.locator(".local-label")).toHaveText("Сохранено", {
    timeout: 30000,
  });
  await expect(page.locator(".monaco-editor")).toContainText("recovered = 7");
  expect(attempts.map((a) => a.status)).toEqual([403, 201]);
  expect(attempts[0].key).toBe(attempts[1].key);
});
test("concurrent head conflict preserves draft and requires explicit save after rebasing", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Название проекта")
    .fill("Conflict smoke " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  const id = page.url().split("/projects/")[1];
  const base = "/api/v1/projects/" + id;
  const project = (await (await page.request.get(base)).json()).data;
  const revision = (
    await (
      await page.request.get(base + "/revisions/" + project.headRevisionId)
    ).json()
  ).data;
  const csrf = (await (await page.request.get("/api/v1/session")).json()).data
    .csrfToken;
  const external = await page.request.post(base + "/revisions", {
    headers: {
      Origin: "http://127.0.0.1:5174",
      "X-CSRF-Token": csrf,
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": project.headRevisionId,
    },
    data: {
      files: revision.files.map(
        (f: { path: string; canonicalText: string }) => ({
          path: f.path,
          content: f.canonicalText + "\n// external change\n",
        }),
      ),
      intent: "semantic_edit",
    },
  });
  expect(external.status()).toBe(201);
  const other = (await external.json()).data;
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    "public class Main { static int local = 42; }\n",
  );
  await page.keyboard.press("Control+s");
  await expect(
    page.getByText("Конфликт версий", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".monaco-editor")).toContainText("local = 42");
  await expect(
    page.getByText("Конфликт версий", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Выбрать актуальную основу" }).click();
  await expect(page.locator(".local-diff")).toBeVisible();
  // Observe the full autosave debounce window: rebasing must not submit local text.
  await page.waitForTimeout(2300);
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(other.id);
  await page.getByRole("button", { name: "Сохранить новую версию" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base)).json()).data.headRevisionId,
    )
    .not.toBe(other.id);
  await expect(page.locator(".monaco-editor")).toContainText("local = 42");
});
test("real API sample → graph/code selection → invalid persisted draft → reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваши проекты", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Название проекта").fill("UI smoke " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await page.locator(".method-item").filter({ hasText: "find(" }).click();
  await expect(page.locator(".blueprint-node").first()).toBeVisible();
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  await expect(page.getByLabel("Условие", { exact: true })).toHaveValue(
    "values[i] == target",
  );
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 23; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Выражение", { exact: true })).toHaveValue("i");
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  const width = page.getByRole("separator", { name: "Ширина панелей" }).first();
  const previousWidth = Number(await width.getAttribute("aria-valuenow"));
  await width.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => Number(await width.getAttribute("aria-valuenow")))
    .toBeCloseTo(previousWidth + 3, 3);
  const height = page
    .getByRole("separator", { name: "Высота панелей" })
    .first();
  const previousHeight = Number(await height.getAttribute("aria-valuenow"));
  await height.focus();
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => Number(await height.getAttribute("aria-valuenow")))
    .toBeCloseTo(previousHeight - 3, 3);
  await page.screenshot({
    path: testInfo.outputPath("workbench-desktop.png"),
  });
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/revisions") &&
      r.request().method() === "POST" &&
      r.status() === 201,
  );
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("public class Main {\n  invalid !\n}\n");
  await page.keyboard.press("Control+s");
  await saved;
  await expect(
    page.getByText("Исходник сохранён · ошибка разбора"),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".stale-banner")).toBeVisible();
  await page.reload();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(
    page.getByText("Исходник сохранён · ошибка разбора"),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".monaco-editor")).toContainText("invalid");
  await expect(page.locator(".stale-banner")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Подготовить изменение" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseOption(
    page.getByRole("combobox", { name: "Открытая панель" }),
    "code",
  );
  await expect(page.locator(".inspector")).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("workbench-narrow.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("theme follows explicit choice across reload without losing source", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await setTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Название проекта").fill("Dark smoke " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator(".monaco-editor")).toHaveClass(/vs-dark/);
  await page.screenshot({
    path: testInfo.outputPath("workbench-dark.png"),
  });
  await setTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
test("real API empty project, import, run availability and keyboard dialog", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Run smoke " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Класс с main")).toHaveValue("Main");
  const caps = await page.request.get("/api/v1/capabilities");
  const { data } = await caps.json();
  await page.getByLabel("Стандартный ввод").fill("7\n");
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  const runResponse = await submitted;
  if (!data.runner.available) {
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      /runner|unavailable|недоступен/i,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    await expect(page).toHaveURL(/\/runs\/[\w-]+$/);
    const started = (await runResponse.json()).data;
    const requested = runResponse.request().postDataJSON();
    const runUrl = page.url();
    // Polling and its immutable inputs belong to Workbench, independently of panels.
    await page
      .getByRole("button", { name: "Скрыть Консоль", exact: true })
      .click();
    if ((await page.locator(".global-command-menu").getAttribute("open")) === null) await page.locator(".sidebar-command-menu > summary").click();
    const view = page
      .locator(".workspace-menu")
      .filter({ has: page.locator("summary").filter({ hasText: /^Вид$/ }) });
    await view.locator("summary").click();
    await view
      .getByRole("button", { name: "Работа с кодом", exact: true })
      .click();
    await page.getByRole("tab", { name: "Консоль", exact: true }).click();
    expect(page.url()).toBe(runUrl);
    expect(runUrl.endsWith("/runs/" + started.id)).toBe(true);
    await expect(
      page.getByRole("region", { name: "Результат запуска" }),
    ).toBeVisible({ timeout: 60000 });
    await expect(page.locator(".run-result-heading")).toContainText(
      "Завершено",
    );
    const result = (
      await (
        await page.request.get(
          new URL(runUrl).pathname.replace("/projects/", "/api/v1/projects/"),
        )
      ).json()
    ).data;
    expect(result.id).toBe(started.id);
    expect(result.result.report.revisionId).toBe(requested.revisionId);
    expect(result.result.report.stdinUtf8).toBe("7\n");
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Результат запуска" }),
    ).toBeVisible();
  }
});
test("real candidate compile → mismatch report → explicit semantic apply", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto("/");
  const caps = await page.request.get("/api/v1/capabilities");
  const { data } = await caps.json();
  test.skip(
    !data.runner.available,
    "Real runner is unavailable; candidate compilation cannot be verified.",
  );
  await page
    .getByLabel("Название проекта")
    .fill("Candidate smoke " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  const projectId = page.url().split("/projects/")[1];
  const before = (
    await (await page.request.get("/api/v1/projects/" + projectId)).json()
  ).data;
  await page.locator(".method-item").filter({ hasText: "find(" }).click();
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  await page.getByLabel("Условие", { exact: true }).fill("values[i] != target");
  await page.getByRole("button", { name: "Подготовить изменение" }).click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  const afterCompile = (
    await (await page.request.get("/api/v1/projects/" + projectId)).json()
  ).data;
  expect(afterCompile.headRevisionId).toBe(before.headRevisionId);
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "JSON", exact: true })
    .click();
  await page.getByLabel("Входные данные · JSON cases").fill(
    JSON.stringify([
      {
        id: "different",
        name: "Различающий вход",
        stdinUtf8: "7\n",
        argv: [],
      },
    ]),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сравнить", exact: true })
    .click();
  await expect(
    page.locator('[data-panel-id="tests"] .report-outcome'),
  ).toContainText("Найдено расхождение", { timeout: 120000 });
  await expect(
    page.locator('[data-panel-id="tests"] .test-result summary'),
  ).toContainText("3 + 3 наблюдений");
  await page.getByRole("tab", { name: "Изменения", exact: true }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/projects/" + projectId)).json())
          .data.headRevisionId,
    )
    .not.toBe(before.headRevisionId);
  await expect(page.locator(".monaco-editor")).toContainText("!=");
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  const exportRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/exports") && request.method() === "POST",
  );
  if ((await page.locator(".global-command-menu").getAttribute("open")) === null) await page.locator(".sidebar-command-menu > summary").click();
  const fileMenu = page
    .locator(".workspace-menu")
    .filter({ has: page.locator("summary").filter({ hasText: /^Файл$/ }) });
  await fileMenu.locator("summary").click();
  await fileMenu
    .getByRole("button", { name: "Экспорт версии", exact: true })
    .click();
  const comparisonJob = (
    await (
      await page.request.get(
        "/api/v1/projects/" +
          projectId +
          "/runs/" +
          page.url().split("/runs/")[1],
      )
    ).json()
  ).data;
  expect(comparisonJob.result.comparisonId).toBeTruthy();
  expect((await exportRequest).postDataJSON().includeReportIds).toEqual([
    comparisonJob.result.comparisonId,
  ]);
});
