import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";
import { readFile } from "node:fs/promises";
async function fixture(page: Page, source: string) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Usability followup " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const save = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [{ path: "Main.java", content: source }],
      intent: "semantic_edit",
    },
  });
  expect(save.status()).toBe(201);
  const revision = (await save.json()).data;
  return { id, base, revision };
}
async function waitJob(page: Page, base: string, id: string, timeout = 60000) {
  let job: any;
  await expect
    .poll(
      async () => {
        job = (await (await page.request.get(base + "/runs/" + id)).json())
          .data;
        return job.status;
      },
      { timeout },
    )
    .not.toMatch(/queued|running/);
  return job;
}
test("rerun uses the same immutable source/parameters after the project head changes", async ({
  page,
}) => {
  const f = await fixture(
    page,
    'public class Main {public static void main(String[] args){System.out.println("old:"+args[0]);}}',
  );
  const launched = await page.request.post(f.base + "/runs", {
    headers: await headers(page.request),
    data: {
      revisionId: f.revision.id,
      entryPoint: "Main",
      argv: ["same"],
      stdinUtf8: "",
      profileId: "java21-v1",
    },
  });
  expect(launched.status()).toBe(202);
  const original = (await launched.json()).data;
  await waitJob(page, f.base, original.id);
  const edited = await page.request.post(f.base + "/revisions", {
    headers: await headers(page.request, f.revision.id),
    data: {
      files: [
        {
          path: "Main.java",
          content:
            'public class Main {public static void main(String[] args){System.out.println("new");}}',
        },
      ],
      intent: "semantic_edit",
    },
  });
  expect(edited.status()).toBe(201);
  const latest = (await edited.json()).data;
  await page.goto("/projects/" + f.id + "/runs/" + original.id);
  await revealPanel(page, "console", "Консоль");
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "old:same",
  );
  const repeated = page.waitForResponse(
    (r) => r.url().endsWith("/repeat") && r.request().method() === "POST",
  );
  await page
    .locator('[data-panel-id="console"]')
    .getByRole("button", { name: /Запустить снова/ })
    .click();
  const response = await repeated;
  expect(response.status()).toBe(202);
  const next = (await response.json()).data;
  expect(next.revisionId).toBe(f.revision.id);
  expect(next.id).not.toBe(original.id);
  const result = await waitJob(page, f.base, next.id);
  expect(result.result.report.runtimeExecution.stdoutUtf8).toBe("old:same\n");
  expect(result.result.report.argv).toEqual(["same"]);
  expect((await head(page.request, f.base)).id).toBe(latest.id);
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "old:same",
  );
});
test("comparison rerun keeps the exact revision pair and suite, without opening a dialog", async ({
  page,
}) => {
  const f = await fixture(
    page,
    'public class Main {public static void main(String[] args){System.out.println("same");}}',
  );
  const suite = await page.request.post(f.base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: [
        {
          id: "fixed",
          name: "Fixed",
          stdinUtf8: "",
          argv: [],
          expectedStdout: "same\n",
          expectedExitCode: 0,
        },
      ],
    },
  });
  expect(suite.status()).toBe(201);
  const suiteId = (await suite.json()).data.id;
  const run = await page.request.post(f.base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.revision.id,
      candidateRevisionId: f.revision.id,
      suiteVersionId: suiteId,
      profileId: "java21-v1",
    },
  });
  expect(run.status()).toBe(202);
  const previous = (await run.json()).data;
  await waitJob(page, f.base, previous.id);
  await page.goto("/projects/" + f.id + "/runs/" + previous.id);
  await revealPanel(page, "tests", "Тесты");
  const repeat = page.waitForResponse(
    (r) => r.url().endsWith("/repeat") && r.request().method() === "POST",
  );
  await page
    .locator('[data-panel-id="tests"]')
    .getByRole("button", { name: /Запустить снова/ })
    .click();
  const next = (await (await repeat).json()).data;
  const result = await waitJob(page, f.base, next.id);
  expect(result.result.report.outcome).toBe("matched_on_tests");
  expect(result.result.report.baseRevisionId).toBe(f.revision.id);
  expect(result.result.report.candidateRevisionId).toBe(f.revision.id);
  expect(result.result.report.suiteVersionId).toBe(suiteId);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("infinite output leaves waiting state and reaches the real output limit", async ({
  page,
}) => {
  const f = await fixture(
    page,
    'public class Main {public static void main(String[] args){while(true)System.out.println("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");}}',
  );
  const started = await page.request.post(f.base + "/runs", {
    headers: await headers(page.request),
    data: {
      revisionId: f.revision.id,
      entryPoint: "Main",
      argv: [],
      stdinUtf8: "",
      profileId: "java21-v1",
      interactive: true,
    },
  });
  expect(started.status()).toBe(202);
  const job = (await started.json()).data;
  await page.goto("/projects/" + f.id + "/runs/" + job.id);
  await revealPanel(page, "console", "Консоль");
  const result = await waitJob(page, f.base, job.id);
  expect(result.result.report.runtimeExecution.outcome).toBe("output_limit");
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "Достигнут лимит вывода",
  );
  await expect(
    page.getByText("Ожидание запуска…", { exact: true }),
  ).toHaveCount(0);
});
test("bare method diagnostic stays concise and points to the source", async ({
  page,
}) => {
  const f = await fixture(page, "static int test(int n) { return n+1; }");
  await page.goto("/projects/" + f.id);
  await revealPanel(page, "analysis", "Анализ");
  const problem = page
    .locator(".diagnostic")
    .filter({ hasText: "внутри класса" });
  await expect(problem).toBeVisible({ timeout: 30000 });
  await problem.click();
  await expect(page.locator(".code-binding")).not.toHaveCount(0);
  await page.getByText("Технические подробности", { exact: true }).click();
  await expect(page.locator(".diagnostic-details pre")).toBeVisible();
});
test("project search covers block aliases and content and restores a separate history tile", async ({
  page,
}) => {
  const f = await fixture(
    page,
    "public class Main {static int choose(int n){if(n>0)return 1;return 0;}static int repeat(int n){while(n>1){n--;}return n;}}",
  );
  await page.goto("/projects/" + f.id);
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  const search = page.getByRole("combobox", { name: "Поиск по проекту" });
  await search.fill("условие");
  await expect(
    page.getByRole("listbox", { name: "Результаты поиска" }),
  ).toContainText("n>0");
  await search.press("Enter");
  await expect(
    page.locator(".blueprint-node").filter({ hasText: "n>0" }),
  ).toBeVisible();
  await expect(page.locator(".target-spotlight")).toBeVisible();
  await page.keyboard.press("Escape");
  await search.fill("цикл");
  await expect(
    page.getByRole("listbox", { name: "Результаты поиска" }),
  ).toContainText("WhileStmt");
  await search.press("Enter");
  await expect(page.locator(".target-spotlight")).toBeVisible();
  await page.keyboard.press("Escape");
  await revealPanel(page, "history", "История");
  await expect(page.locator('[data-tile-panel="history"]')).toBeVisible();
  await expect(page.locator('[data-panel-id="history"]')).toContainText(
    f.revision.id.slice(0, 8),
  );
  await page.reload();
  await expect(page.locator('[data-tile-panel="history"]')).toBeVisible();
});
test("file download retains its name and bytes; collapsed navigation survives reload", async ({
  page,
}) => {
  const source = "public class Main {static int answer(){return 7;}}\n";
  const f = await fixture(page, source);
  await page.goto("/projects/" + f.id);
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  await revealPanel(page, "project", "Проект");
  await page.locator(".file-item").filter({ hasText: "Main.java" }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать выбранный путь", exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("Main.java");
  expect(await readFile((await download.path())!, "utf8")).toBe(source);
  await page
    .getByRole("button", { name: "Свернуть навигацию", exact: true })
    .click();
  await expect(page.locator('[data-tile-panel="navigation"]')).toHaveClass(
    /navigation-collapsed/,
  );
  await expect(page.locator('[data-tile-panel="navigation"]')).toHaveCSS(
    "height",
    "40px",
  );
  await page.reload();
  await expect(page.locator('[data-tile-panel="navigation"]')).toHaveClass(
    /navigation-collapsed/,
  );
  await page
    .getByRole("button", { name: "Развернуть навигацию", exact: true })
    .click();
  await expect(page.locator('[data-tile-panel="navigation"]')).not.toHaveClass(
    /navigation-collapsed/,
  );
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
});
