import { test, expect } from "@playwright/test";

test("structural edits and historical restore use explicit compiled proposals", async ({
  page,
}, testInfo) => {
  test.setTimeout(240000);
  await page.goto("/");
  const caps = (await (await page.request.get("/api/v1/capabilities")).json())
    .data;
  test.skip(!caps.runner.available, "Docker runner is unavailable");
  await page.getByLabel("Название проекта").fill("Structural UI " + Date.now());
  const source =
    "public class Main { public static void main(String[] args) {} }\n";
  await page.locator("input[type=file]").setInputFiles({
    name: "Main.java",
    mimeType: "text/x-java-source",
    buffer: Buffer.from(source),
  });
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  const base = "/api/v1/projects/" + page.url().split("/projects/")[1];
  const initial = (await (await page.request.get(base)).json()).data
    .headRevisionId;
  const readHead = async () =>
    (await (await page.request.get(base)).json()).data.headRevisionId;
  const revision = async (id: string) =>
    (await (await page.request.get(base + "/revisions/" + id)).json()).data;
  await page.locator(".blueprint-node.entry").click();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveValue(
    "insert_statement",
  );
  await expect(page.getByLabel("Позиция")).toHaveValue("body_start");
  await expect(
    page.getByLabel("Действие", { exact: true }).locator("option"),
  ).toHaveCount(1);
  await page.getByLabel("Шаблон").selectOption("condition");
  await expect(page.getByLabel("Java оператор")).toHaveValue(
    'if (true) {\n    System.out.println("value");\n}',
  );
  await page.getByLabel("Шаблон").selectOption("loop");
  await expect(page.getByLabel("Java оператор")).toHaveValue(/for/);
  await page.getByLabel("Шаблон").selectOption("statement");
  await page
    .getByLabel("Java оператор")
    .fill('System.out.println("inserted");');
  await page.getByRole("button", { name: "Подготовить изменение" }).click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  expect(await readHead()).toBe(initial);
  await expect(page.locator(".diff .added")).toContainText("inserted");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect.poll(readHead).not.toBe(initial);
  const inserted = await readHead();
  await expect(page.locator(".blueprint-node.ExpressionStmt")).toBeVisible();
  await page.reload();
  await expect(page.locator(".monaco-editor")).toContainText("inserted");
  await page.locator(".blueprint-node.ExpressionStmt").click();
  await page
    .getByLabel("Действие", { exact: true })
    .selectOption("delete_statement");
  await expect(
    page.getByText("Удаление выбранного оператора", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Java оператор")).toHaveCount(0);
  await page.getByRole("button", { name: "Подготовить изменение" }).click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  expect(await readHead()).toBe(inserted);
  await expect(page.locator(".diff .removed")).toContainText("inserted");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect.poll(readHead).not.toBe(inserted);
  const deleted = await readHead();
  await page.reload();
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await expect(page.locator(".monaco-editor")).not.toContainText("inserted");
  await page.locator(".blueprint-node.normal_exit").click();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Нет доступных действий", { exact: true }),
  ).toBeVisible();
  const restore = page.getByRole("button", {
    name: "Восстановить версию " + inserted.slice(0, 8),
    exact: true,
  });
  const restoreRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/restore") && request.method() === "POST",
  );
  await restore.click();
  const sentRestore = await restoreRequest;
  expect(sentRestore.headers()["if-match"]).toBe(deleted);
  expect(sentRestore.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(sentRestore.postDataJSON()).toEqual({
    expectedHeadRevisionId: deleted,
  });
  await expect.poll(readHead).not.toBe(deleted);
  const restored = await readHead();
  expect(restored).not.toBe(inserted);
  const restoredRevision = await revision(restored);
  expect(restoredRevision.sourceRevisionId).toBe(inserted);
  expect(restoredRevision.parentRevisionId).toBe(deleted);
  const sourceRevision = await revision(inserted);
  expect(restoredRevision.bundleHash).toBe(sourceRevision.bundleHash);
  expect(restoredRevision.files).toEqual(sourceRevision.files);
  await expect(page.locator(".monaco-editor")).toContainText("inserted");
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".monaco-editor")).toContainText("inserted");
  for (const theme of ["dark", "light"]) {
    const toggle = page.getByRole("button", {
      name: theme === "dark" ? "Включить тёмную тему" : "Включить светлую тему",
    });
    if (await toggle.count()) await toggle.click();
    await page.locator(".blueprint-node.entry").click();
    await expect(page.getByLabel("Java оператор")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bounds = await page
      .getByRole("button", { name: "Подготовить изменение" })
      .boundingBox();
    const panel = await page.locator(".inspector").boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      panel!.x + panel!.width,
    );
    await page.screenshot({
      path: testInfo.outputPath("structural-" + theme + ".png"),
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Переключить инспектор" }).click();
  await expect(page.getByLabel("Java оператор")).toBeVisible();
  await page
    .getByRole("button", { name: "Подготовить изменение" })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("structural-narrow.png") });
  await page.setViewportSize({ width: 1512, height: 982 });
  // Local edits block restore before the autosave debounce can replace the draft.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// local draft\n");
  await expect(restore).toBeDisabled();
  await expect(page.locator(".stale-banner")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Подготовить изменение" }),
  ).toBeDisabled();
  const draft = await page.evaluate(
    () =>
      Object.entries(localStorage).find(([k]) =>
        k.startsWith("java-blueprints:draft:"),
      )?.[1],
  );
  expect(draft).toContain("local draft");
});

test("persisted analysis without capabilities exposes no structural actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.route("**/revisions/*/analysis", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.data?.graph?.nodes) {
      for (const node of json.data.graph.nodes) {
        delete node.allowedOperations;
        delete node.insertionPositions;
      }
    }
    await route.fulfill({ response, json });
  });
  await page
    .getByLabel("Название проекта")
    .fill("Legacy capability UI " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  await page.locator(".blueprint-node.entry").click();
  await expect(
    page.getByText("Нет доступных действий", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Подготовить изменение" }),
  ).toHaveCount(0);
  await page.unroute("**/revisions/*/analysis");
  await page.reload();
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.locator(".blueprint-node.entry").click();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveValue(
    "insert_statement",
  );
});
