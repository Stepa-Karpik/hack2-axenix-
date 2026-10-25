import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

const alpha = `public class Alpha {
 static int alphaOnly(int n) {
  int sum=0;
  for(int i=0;i<n;i++){for(int j=0;j<n;j++){sum++;}}
  return sum;
 }
 public static void main(String[] args) throws Exception { Thread.sleep(250); System.out.println("ALPHA-OUTPUT"); }
}\n`;
const beta = `public class Beta {
 static int betaOnly(){return 42;}
 public static void main(String[] args){System.out.println("BETA-OUTPUT");}
}\n`;
async function fixture(page: Page) {
  const response = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "File context " + crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).data.id,
    base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      intent: "semantic_edit",
      files: [
        { path: "Alpha.java", content: alpha },
        { path: "Beta.java", content: beta },
        { path: "note.txt", content: "notes" },
      ],
    },
  });
  expect(saved.status()).toBe(201);
  const revision = (await saved.json()).data.id;
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
  return { id, base, revision };
}
async function open(page: Page, path: string) {
  await page.locator(`[data-file-path="${path}"]`).click();
  await expect(
    page.getByRole("tab", { name: path, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
}
async function finished(page: Page, base: string, id: string) {
  let job: any;
  await expect
    .poll(
      async () => {
        job = (await (await page.request.get(base + "/runs/" + id)).json())
          .data;
        return job.status;
      },
      { timeout: 90000 },
    )
    .toBe("succeeded");
  return job;
}

test("file selection binds graph, selected node and analysis through explorer, tabs and reload", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await revealPanel(page, "analysis", "Анализ");
  await page
    .getByRole("button", { name: "alphaOnly(int)", exact: true })
    .click();
  const graph = page.getByRole("region", { name: "Схема метода" });
  await page.locator(".blueprint-node.entry").click();
  const panel = page.locator('[data-panel-id="analysis"]');
  await panel.getByRole("tab", { name: /^Рекомендации/ }).click();
  await expect(panel.locator('[data-finding-code="NESTED_LOOPS"]')).toHaveCount(
    1,
  );
  await open(page, "Beta.java");
  await expect(graph).toHaveAttribute("data-source-file", "Beta.java");
  await expect(graph).toContainText("betaOnly()");
  await expect(panel.locator(".insight-finding")).toHaveCount(0);
  await panel.getByRole("tab", { name: "Узел", exact: true }).click();
  await expect(panel.locator("#expression")).toHaveCount(0);
  await panel.getByRole("tab", { name: "Метрики", exact: true }).click();
  await expect(
    panel.getByRole("region", { name: "Метрики метода" }),
  ).toContainText("Beta.java");
  await expect(panel).not.toContainText("alphaOnly");
  await open(page, "note.txt");
  await expect(graph).toHaveAttribute("data-source-file", "note.txt");
  await expect(
    page.locator('.flow-area[data-graph-view="overview"]'),
  ).toBeVisible();
  const response = await page.request.get(
    f.base + "/revisions/" + f.revision + "/analysis",
  );
  expect(response.ok()).toBe(true);
  const current = (await response.json()).data;
  expect(current.revisionId).toBe(f.revision);
  const frameIds = await page
    .locator("[data-method-frame]")
    .evaluateAll((frames) =>
      frames.map((frame) => frame.getAttribute("data-method-frame")).sort(),
    );
  expect(frameIds).toEqual(
    current.graph.methods.map((method: any) => method.id).sort(),
  );
  await expect(page.locator(".graph-method-frame.active")).toHaveCount(0);
  const visibleIds = await page
    .locator(".react-flow__node-blueprint")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  expect(visibleIds.length).toBeGreaterThan(0);
  const actualIds = new Set(current.graph.nodes.map((node: any) => node.id));
  for (const id of visibleIds) expect(actualIds.has(id)).toBe(true);
  await expect(
    panel.getByRole("region", { name: "Метрики метода" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Beta.java", exact: true }).click();
  await page.reload();
  await expect(graph).toHaveAttribute("data-source-file", "Beta.java");
  await expect(graph).toContainText("betaOnly()");
  await page.screenshot({
    path: info.outputPath("active-beta.png"),
    animations: "disabled",
  });
  expect((await head(page.request, f.base)).id).toBe(f.revision);
});

test("console histories follow the launch source through file switches and reload", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(page);
  const started = await page.request.post(f.base + "/runs", {
    headers: await headers(page.request),
    data: {
      revisionId: f.revision,
      entryPoint: "Alpha",
      profileId: "java21-v1",
      stdinUtf8: "",
      argv: [],
    },
  });
  expect(started.status()).toBe(202);
  const a = (await started.json()).data;
  await page.goto(`/projects/${f.id}/runs/${a.id}`);
  await revealPanel(page, "console", "Консоль");
  const consolePanel = page.locator('[data-panel-id="console"]');
  await finished(page, f.base, a.id);
  await expect(consolePanel.locator(".program-output")).toHaveText(
    "ALPHA-OUTPUT\n",
  );
  await open(page, "Beta.java");
  await expect(consolePanel.locator(".program-output")).toHaveCount(0);
  await expect(consolePanel.getByTestId("other-file-result")).toContainText(
    "Alpha.java",
  );
  await page.getByRole("button", { name: "Запуск", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Класс с main")).toHaveValue("Beta");
  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith(f.base + "/runs") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Запустить", exact: true }).click();
  const b = (await (await submitted).json()).data;
  await finished(page, f.base, b.id);
  await expect(consolePanel.locator(".program-output")).toHaveText(
    "BETA-OUTPUT\n",
  );
  await page.getByRole("tab", { name: "Alpha.java", exact: true }).click();
  await expect(consolePanel.locator(".program-output")).toHaveText(
    "ALPHA-OUTPUT\n",
  );
  await expect(consolePanel.getByTestId("other-file-result")).toHaveCount(0);
  await page.reload();
  await expect(consolePanel.locator(".program-output")).toHaveText(
    "ALPHA-OUTPUT\n",
  );
  await open(page, "Beta.java");
  await expect(consolePanel.locator(".program-output")).toHaveText(
    "BETA-OUTPUT\n",
  );
  await page.screenshot({
    path: info.outputPath("beta-console.png"),
    animations: "disabled",
  });
  // Browser cache cannot relabel Alpha's output as Beta's result.
  await page.evaluate(
    ({ id, job }) =>
      localStorage.setItem(
        "java-blueprints:file-runs:" + id,
        JSON.stringify({ "Beta.java": { run: job } }),
      ),
    { id: f.id, job: a.id },
  );
  await page.goto("/projects/" + f.id);
  await expect(consolePanel).toContainText(
    "Результат относится к другому файлу",
  );
  await expect(consolePanel.locator(".program-output")).toHaveCount(0);
  expect((await head(page.request, f.base)).id).toBe(f.revision);
});

test("background test progress belongs to its launch file and completed results restore after switching and reload", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(page);
  const compare = async (entryPoint: string) => {
    const suite = await page.request.post(f.base + "/test-suites", {
      headers: await headers(page.request),
      data: {
        mode: "console",
        entryPoint,
        comparisonPolicyId: "exact-v1",
        cases: [
          {
            id: entryPoint,
            name: entryPoint + " expected",
            stdinUtf8: "",
            argv: [],
            expectedStdout: entryPoint.toUpperCase() + "-OUTPUT\n",
            expectedExitCode: 0,
          },
        ],
      },
    });
    expect(suite.status()).toBe(201);
    const response = await page.request.post(f.base + "/comparisons", {
      headers: await headers(page.request),
      data: {
        baseRevisionId: f.revision,
        candidateRevisionId: f.revision,
        suiteVersionId: (await suite.json()).data.id,
        profileId: "java21-v1",
      },
    });
    expect(response.status()).toBe(202);
    return (await response.json()).data;
  };
  const run = await page.request.post(f.base + "/runs", {
    headers: await headers(page.request),
    data: {
      revisionId: f.revision,
      entryPoint: "Alpha",
      profileId: "java21-v1",
      argv: [],
      stdinUtf8: "",
    },
  });
  expect(run.status()).toBe(202);
  const runId = (await run.json()).data.id;
  await page.goto(`/projects/${f.id}/runs/${runId}`);
  await revealPanel(page, "console", "Консоль");
  await finished(page, f.base, runId);
  await expect(
    page.locator('[data-panel-id="console"] .program-output'),
  ).toHaveText("ALPHA-OUTPUT\n");
  const a = await compare("Alpha");
  expect(a.entryPoint).toBe("Alpha");
  await page.goto(`/projects/${f.id}/runs/${a.id}`);
  await revealPanel(page, "tests", "Тесты");
  const panel = page.locator('[data-panel-id="tests"]');
  await expect(
    panel.getByRole("region", { name: "Прогресс тестов" }),
  ).toBeVisible();
  await open(page, "Beta.java");
  await expect(
    panel.getByRole("region", { name: "Прогресс тестов" }),
  ).toHaveCount(0);
  await expect(panel.getByTestId("other-file-result")).toContainText(
    "Alpha.java",
  );
  expect((await finished(page, f.base, a.id)).result.report.outcome).toBe(
    "matched_on_tests",
  );
  await open(page, "Alpha.java");
  await expect(panel).toContainText("Alpha expected");
  const b = await compare("Beta");
  await page.goto(`/projects/${f.id}/runs/${b.id}`);
  await open(page, "Beta.java");
  expect((await finished(page, f.base, b.id)).result.report.outcome).toBe(
    "matched_on_tests",
  );
  await expect(panel).toContainText("Beta expected");
  await open(page, "Alpha.java");
  await expect(panel).toContainText("Alpha expected");
  await expect(panel).not.toContainText("Beta expected");
  await expect(panel.getByTestId("other-file-result")).toHaveCount(0);
  await page.reload();
  await expect(panel).toContainText("Alpha expected");
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
  await expect(page.locator(".local-label")).toHaveText("Сохранено");
  await revealPanel(page, "console", "Консоль");
  await expect(
    page.locator('[data-panel-id="console"] .program-output'),
  ).toHaveText("ALPHA-OUTPUT\n");
  await revealPanel(page, "tests", "Тесты");
  await panel.locator(".dock-content").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: info.outputPath("alpha-tests.png"),
    animations: "disabled",
  });
  expect((await head(page.request, f.base)).id).toBe(f.revision);
});

test("an unresolved launch class exposes its actual error without attaching it to the open file", async ({
  page,
}) => {
  const f = await fixture(page);
  const response = await page.request.post(f.base + "/runs", {
    headers: await headers(page.request),
    data: {
      revisionId: f.revision,
      entryPoint: "Missing",
      profileId: "java21-v1",
      argv: [],
      stdinUtf8: "",
    },
  });
  expect(response.status()).toBe(202);
  const job = (await response.json()).data;
  await finished(page, f.base, job.id);
  await page.goto(`/projects/${f.id}/runs/${job.id}`);
  await revealPanel(page, "console", "Консоль");
  const panel = page.locator('[data-panel-id="console"]');
  await expect(panel).toContainText(
    "Файл класса запуска не определён однозначно",
  );
  await panel
    .locator("summary")
    .filter({ hasText: "Результат класса Missing" })
    .click();
  await expect(panel.locator(".console-stderr")).toContainText("Missing");
  await expect(panel.getByTestId("result-file-context")).not.toContainText(
    "Missing",
  );
  expect((await head(page.request, f.base)).id).toBe(f.revision);
});
