import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

const main =
  "public class Main {public static void main(String[] args){System.out.println(2 + 3);}}\n";
const other =
  'public class TaskForge {public static void main(String[] args){System.out.println("old");}}\n';
async function fixture(request: APIRequestContext, historicalBad = false) {
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Compile preflight " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id;
  const base = "/api/v1/projects/" + id;
  const create = async (
    previous: string,
    files: { path: string; content: string }[],
  ) => {
    const response = await request.post(base + "/revisions", {
      headers: await headers(request, previous),
      data: {
        expectedHeadRevisionId: previous,
        intent: "semantic_edit",
        files,
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const first = await create(
    "empty",
    historicalBad
      ? [{ path: "abc.java", content: main }]
      : [{ path: "TaskForge.java", content: other }],
  );
  const second = await create(
    first.id,
    historicalBad
      ? [{ path: "Main.java", content: main }]
      : [
          { path: "TaskForge.java", content: other },
          { path: "abc.java", content: main },
          { path: "abc", content: "" },
        ],
  );
  return { id, base, first, second };
}
async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect
    .poll(
      async () => {
        job = (await (await request.get(base + "/jobs/" + id)).json()).data;
        return job.status;
      },
      { timeout: 90000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status).toBe("succeeded");
  return job;
}

test("filename failure is actionable, repair preserves source and rerun tests the active new Main with an independent oracle", async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await fixture(page.request);
  // Exercise a real truncated history page, as with an original revision older
  // than the latest100. The response is still served unchanged by the real API.
  await page.route(
    (url) =>
      url.pathname === f.base + "/revisions" &&
      url.searchParams.get("limit") === "100",
    (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("limit", "1");
      return route.continue({ url: String(url) });
    },
  );
  await page.goto("/projects/" + f.id);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.locator('[data-file-path="abc.java"]').click();
  await revealPanel(page, "tests", "Тесты");
  await page
    .getByRole("button", { name: "Сравнить версии", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Класс с main")).toHaveValue("Main");
  await expect(dialog.getByLabel("Базовая версия")).toHaveValue(f.second.id);
  await expect(
    dialog
      .getByLabel("Базовая версия")
      .locator(`option[value="${f.first.id}"]`),
  ).toHaveCount(1);
  await expect(dialog.getByRole("alert")).toContainText("abc.java");
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Открыть abc.java", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);

  // Reproduce the old report through the actual API/compiler; the UI correctly
  // blocks this known filename failure before submitting a new job.
  const suite = await page.request.post(f.base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "TaskForge",
      comparisonPolicyId: "exact-v1",
      cases: [{ id: "one", name: "one", stdinUtf8: "", argv: [] }],
    },
  });
  expect(suite.status()).toBe(201);
  const started = await page.request.post(f.base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.first.id,
      candidateRevisionId: f.second.id,
      suiteVersionId: (await suite.json()).data.id,
      profileId: "java21-v1",
    },
  });
  expect(started.status()).toBe(202);
  const oldJob = (await started.json()).data;
  const failed = await finished(page.request, f.base, oldJob.id);
  expect(failed.result.report.outcome).toBe("compile_error");
  expect(failed.progress.completed).toBe(0);
  expect(failed.result.report.candidateCompile.stderrUtf8).toContain(
    "abc.java:1",
  );
  const reportId = failed.result.comparisonId;
  const oldReport = (
    await (await page.request.get(f.base + "/comparisons/" + reportId)).json()
  ).data;
  await page.goto(`/projects/${f.id}/runs/${oldJob.id}`);
  await revealPanel(page, "tests", "Тесты");
  await page.locator('[data-file-path="TaskForge.java"]').click();
  const panel = page.locator('[data-panel-id="tests"]');
  await expect(panel.getByTestId("result-file-context")).toContainText(
    "TaskForge",
  );
  await expect(
    panel.getByRole("region", { name: "Почему тесты не запущены" }),
  ).toContainText("Тесты не запускались");
  await panel
    .getByRole("button", { name: "Открыть abc.java", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Переименовать в Main.java", exact: true })
    .click();
  await expect
    .poll(async () => (await head(page.request, f.base)).id)
    .not.toBe(f.second.id);
  const fixed = await head(page.request, f.base);
  expect(
    fixed.files.find((file) => file.path === "Main.java")?.canonicalText,
  ).toBe(main);
  expect(
    fixed.files.find((file) => file.path === "TaskForge.java")?.canonicalText,
  ).toBe(other);
  expect(fixed.files.some((file) => file.path === "abc.java")).toBe(false);
  await expect(
    panel.getByRole("region", { name: "Почему тесты не запущены" }),
  ).toHaveCount(0);
  await page.locator('[data-file-path="TaskForge.java"]').click();
  await expect(panel.getByTestId("test-source-provenance")).toContainText(
    "предыдущей версии",
  );
  await expect(page.locator(".local-label")).toHaveText("Сохранено");
  await panel.locator(".dock-content").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: test.info().outputPath("project-compile-error.png"),
    animations: "disabled",
  });
  await page.locator('[data-file-path="Main.java"]').click();
  await panel
    .getByRole("button", { name: "Сравнить версии", exact: true })
    .click();
  await expect(dialog.getByLabel("Класс с main")).toHaveValue("Main");
  await expect(dialog.getByLabel("Базовая версия")).toHaveValue(fixed.id);
  await expect(dialog.getByLabel("Кандидат")).toHaveValue(fixed.id);
  await dialog.getByRole("button", { name: "JSON", exact: true }).click();
  await dialog.getByLabel("Входные данные · JSON cases").fill(
    JSON.stringify([
      {
        id: "five",
        name: "2 + 3",
        stdinUtf8: "",
        argv: [],
        expectedStdout: "5\n",
        expectedStderr: "",
        expectedExitCode: 0,
      },
    ]),
  );
  const compared = page.waitForResponse(
    (response) =>
      response.url().endsWith(f.base + "/comparisons") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Сравнить", exact: true }).click();
  const done = await finished(
    page.request,
    f.base,
    (await (await compared).json()).data.id,
  );
  expect(done.result.report.outcome).toBe("matched_on_tests");
  const result = done.result.report.testResults[0];
  expect(result.baseExecutions).toHaveLength(3);
  expect(result.candidateExecutions).toHaveLength(3);
  for (const observation of [
    ...result.baseExecutions,
    ...result.candidateExecutions,
  ])
    expect((observation.runtimeExecution ?? observation).stdoutUtf8).toBe(
      "5\n",
    );
  expect((await head(page.request, f.base)).id).toBe(fixed.id);
  expect(
    (await (await page.request.get(f.base + "/comparisons/" + reportId)).json())
      .data,
  ).toEqual(oldReport);
});

test("historical base filename errors stay read-only and changing selected versions clears stale validation", async ({
  page,
}) => {
  const f = await fixture(page.request, true);
  await page.goto("/projects/" + f.id);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await revealPanel(page, "tests", "Тесты");
  await page
    .getByRole("button", { name: "Сравнить версии", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("База · abc.java");
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Базовая версия").selectOption(f.second.id);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeEnabled();
  await dialog.getByLabel("Базовая версия").selectOption(f.first.id);
  await expect(dialog.getByRole("alert")).toContainText("abc.java");
  await dialog
    .getByRole("button", { name: "Открыть abc.java", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Переименовать в Main.java",
      exact: true,
    }),
  ).toBeDisabled();
  expect((await head(page.request, f.base)).id).toBe(f.second.id);
});
