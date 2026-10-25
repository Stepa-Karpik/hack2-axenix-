import { chooseOption } from "./selectControl";
import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel, setTheme } from "./flowAssertions";

const source = `import java.util.Scanner;
public class Main {
  public static void main(String[] args) throws Exception {
    int delay = new Scanner(System.in).nextInt();
    Thread.sleep(delay);
    System.out.print(delay);
  }
}\n`;

async function fixture(
  page: Page,
  candidate = source + "// candidate\n",
  delays = [100, 1200, 100],
) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Test progress " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id;
  const base = "/api/v1/projects/" + id;
  const save = async (content: string, previous: string) => {
    const response = await page.request.post(base + "/revisions", {
      headers: await headers(page.request, previous),
      data: {
        files: [{ path: "Main.java", content }],
        intent: "semantic_edit",
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const original = await save(source, "empty");
  const changed = await save(candidate, original.id);
  const suiteResponse = await page.request.post(base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: delays.map((delay, i) => ({
        id: "case-" + i,
        name: ["Быстрый", "Длительный", "Последний"][i] ?? "Тест " + i,
        stdinUtf8: delay + "\n",
        argv: [],
        expectedExitCode: 0,
        expectedStdout: String(delay),
      })),
    },
  });
  expect(suiteResponse.status()).toBe(201);
  const suite = (await suiteResponse.json()).data;
  const response = await page.request.post(base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: original.id,
      candidateRevisionId: changed.id,
      suiteVersionId: suite.id,
      profileId: "java21-v1",
    },
  });
  expect(response.status()).toBe(202);
  const job = (await response.json()).data;
  await page.goto(`/projects/${id}/runs/${job.id}`);
  await revealPanel(page, "tests", "Тесты");
  const read = async () =>
    (await (await page.request.get(base + "/jobs/" + job.id)).json()).data;
  return { id, base, original, changed, suite, job, read };
}

test("real case progress, measured timing, reload and hidden-panel completion stay bound to immutable inputs", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const fixtureData = await fixture(page);
  const panel = page.getByRole("region", { name: "Прогресс тестов" });
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-test-status="running"]')).toHaveCount(1, {
    timeout: 30000,
  });
  await expect
    .poll(async () => (await fixtureData.read()).progress?.completed ?? 0, {
      timeout: 60000,
    })
    .toBeGreaterThanOrEqual(1);
  const first = await fixtureData.read();
  expect(first.progress.binding.baseRevisionId).toBe(fixtureData.original.id);
  expect(first.progress.binding.candidateRevisionId).toBe(
    fixtureData.changed.id,
  );
  expect(first.progress.binding.suiteVersionId).toBe(fixtureData.suite.id);
  expect(first.progress.cases[0].elapsedMs).toBeGreaterThan(0);
  expect(first.progress.cases[0].baseObserved).toBe(3);
  expect(first.progress.cases[0].candidateObserved).toBe(3);
  const elapsed = first.progress.cases[0].elapsedMs;
  await page.reload();
  await expect(page.locator('[data-test-case="case-0"]')).toHaveAttribute(
    "data-test-status",
    "matched",
    { timeout: 30000 },
  );
  expect((await fixtureData.read()).progress.cases[0].elapsedMs).toBe(elapsed);
  await expect
    .poll(async () =>
      page.locator('[data-test-status="running"]').evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const list = row.parentElement!.getBoundingClientRect();
        return bounds.top >= list.top - 1 && bounds.bottom <= list.bottom + 1;
      }),
    )
    .toBe(true);
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("tests-progress-dark.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Тесты", exact: true }).click();
  await expect(page.locator('[data-panel-id="tests"]')).not.toBeVisible();
  await expect
    .poll(async () => (await fixtureData.read()).status, { timeout: 120000 })
    .toBe("succeeded");
  await expect(page.locator('[data-panel-id="tests"]')).not.toBeVisible();
  await page.getByRole("button", { name: "Тесты", exact: true }).click();
  await expect(
    page.locator('[data-panel-id="tests"] .test-result'),
  ).toHaveCount(3);
  const result = await fixtureData.read();
  expect(result.progress.completed).toBe(3);
  expect(result.progress.matched).toBe(3);
  expect(result.result.report.completed).toBe(3);
  expect(result.result.report.matched).toBe(3);
  expect(
    result.result.report.testResults.every(
      (row: { elapsedMs: number }) => row.elapsedMs > 0,
    ),
  ).toBe(true);
  expect(result.result.report.wallTimeMs).toBeGreaterThan(
    result.result.report.testResults.reduce(
      (sum: number, row: { elapsedMs: number }) => sum + row.elapsedMs,
      0,
    ),
  );
  expect((await head(page.request, fixtureData.base)).id).toBe(
    fixtureData.changed.id,
  );
  await page.reload();
  await expect(
    page.locator('[data-panel-id="tests"] .test-result'),
  ).toHaveCount(3);
  await setTheme(page, "light");
  await page.screenshot({
    path: info.outputPath("tests-results-light.png"),
    animations: "disabled",
  });
  await info.attach("comparison-progress", {
    body: JSON.stringify(result.progress),
    contentType: "application/json",
  });
});

test("stop retains finished case verdicts and partial counts across reload without publishing verification", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const fixtureData = await fixture(
    page,
    source + "// cancelled candidate\n",
    [100, 2000, 100],
  );
  await expect(page.locator('[data-test-case="case-0"]')).toHaveAttribute(
    "data-test-status",
    "matched",
    { timeout: 60000 },
  );
  await expect(page.locator('[data-test-case="case-1"]')).toHaveAttribute(
    "data-test-status",
    "running",
  );
  await page
    .getByRole("button", { name: "Остановить выполнение", exact: true })
    .click();
  await expect
    .poll(async () => (await fixtureData.read()).status, { timeout: 30000 })
    .toBe("cancelled");
  await expect(
    page.getByText("Проверка остановлена", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Выполнено тестов" }),
  ).toHaveAttribute("value", "1");
  await expect(page.locator('[data-test-case="case-1"]')).toHaveAttribute(
    "data-test-status",
    "cancelled",
  );
  await expect(page.locator('[data-test-case="case-2"]')).toHaveAttribute(
    "data-test-status",
    "not_run",
  );
  const stopped = await fixtureData.read();
  expect(stopped.result).toBeNull();
  expect(stopped.progress.completed).toBe(1);
  expect(stopped.progress.matched).toBe(1);
  expect(stopped.progress.finished).toBe(true);
  expect((await head(page.request, fixtureData.base)).id).toBe(
    fixtureData.changed.id,
  );
  await page.reload();
  await expect(
    page.getByText("Проверка остановлена", { exact: true }),
  ).toBeVisible();
  expect((await fixtureData.read()).progress).toEqual(stopped.progress);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseOption(
    page.getByRole("combobox", { name: "Открытая панель" }),
    "tests",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("tests-cancelled-narrow.png"),
    animations: "disabled",
  });
});

test("a finished mismatch is distinct from a successful comparison", async ({
  page,
}) => {
  test.setTimeout(90000);
  const fixtureData = await fixture(
    page,
    source.replace("System.out.print(delay)", "System.out.print(delay + 1)"),
    [0],
  );
  await expect
    .poll(async () => (await fixtureData.read()).status, { timeout: 60000 })
    .toBe("succeeded");
  const result = await fixtureData.read();
  expect(result.progress.completed).toBe(1);
  expect(result.progress.matched).toBe(0);
  expect(result.progress.cases[0].status).toBe("mismatch");
  expect(result.result.report.outcome).toBe("mismatch");
  const panel = page.locator('[data-panel-id="tests"]');
  await expect(panel.locator(".test-result")).toHaveCount(1);
  await expect(panel.getByText("Расхождение", { exact: true })).toBeVisible();
  await expect(panel.locator(".test-result-duration")).not.toHaveText("—");
});

test("runtime timeouts finish observations without becoming a matched comparison", async ({
  page,
}) => {
  test.setTimeout(180000);
  const fixtureData = await fixture(
    page,
    source + "// timeout candidate\n",
    [5500],
  );
  await expect
    .poll(async () => (await fixtureData.read()).status, { timeout: 120000 })
    .toBe("succeeded");
  const result = await fixtureData.read();
  expect(result.progress.completed).toBe(1);
  expect(result.progress.matched).toBe(0);
  expect(result.progress.cases[0].status).toBe("inconclusive");
  expect(result.progress.cases[0].elapsedMs).toBeGreaterThanOrEqual(30000);
  expect(result.result.report.outcome).toBe("inconclusive");
  expect(result.result.report.coverageComplete).toBe(false);
  expect(result.result.report.inconclusiveReasons).toContain("timeout");
  const panel = page.locator('[data-panel-id="tests"]');
  await expect(panel).toContainText("Недостаточно данных");
  await expect(panel.locator(".test-result")).toContainText("Неопределённо");
  await panel.locator(".test-result > summary").click();
  await expect(panel.locator(".test-result")).toContainText("Лимит времени");
});

test("compiler failure leaves test cases unrun with no invented durations or successes", async ({
  page,
}) => {
  const fixtureData = await fixture(
    page,
    source.replace("Thread.sleep(delay)", "Thread.sleep(missing)"),
    [0],
  );
  await expect
    .poll(async () => (await fixtureData.read()).status, { timeout: 60000 })
    .toBe("succeeded");
  const result = await fixtureData.read();
  expect(result.progress.phase).toBe("compile_error");
  expect(result.progress.completed).toBe(0);
  expect(result.progress.matched).toBe(0);
  expect(result.progress.cases[0].status).toBe("not_run");
  expect(result.progress.cases[0].elapsedMs).toBeNull();
  expect(result.result.report.outcome).toBe("compile_error");
  await expect(
    page
      .locator('[data-panel-id="tests"]')
      .locator("strong")
      .filter({ hasText: /^Ошибка компиляции$/ }),
  ).toBeVisible();
  await expect(page.locator('[data-panel-id="tests"]')).toContainText(
    "missing",
  );
  expect((await head(page.request, fixtureData.base)).id).toBe(
    fixtureData.changed.id,
  );
});
