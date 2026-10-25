import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel, panToNode } from "./flowAssertions";

const source = `public class Main {
  static int value = 9;
  public static void main(String[] args) { System.out.println(calculate(Integer.parseInt(args[0]))); }
  static int calculate(int input) { int value = input * 2; return value + Main.value; }
  static int calculate() { int value = 3; return value; }
}\n`;
async function fixture(page: Page, text = source) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Local rename " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id,
    base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [
        { path: "Main.java", content: text },
        { path: "notes.txt", content: "keep café\n" },
      ],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  const analysis = (
    await (
      await page.request.get(base + "/revisions/" + original.id + "/analysis")
    ).json()
  ).data;
  return { id, base, original, analysis };
}
async function done(request: APIRequestContext, base: string, id: string) {
  let result: any;
  await expect
    .poll(
      async () => {
        result = (await (await request.get(base + "/jobs/" + id)).json()).data;
        return result.status;
      },
      { timeout: 240000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return result;
}
test("local rename changes only exact references and applies after independent oracle comparison", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  const f = await fixture(page);
  const method = f.analysis.graph.methods.find((m: any) =>
    m.signature.startsWith("calculate(int"),
  );
  const selected = f.analysis.graph.nodes.find(
    (node: any) =>
      node.methodId === method.id &&
      node.kind === "ExpressionStmt" &&
      node.sourceRange?.startOffset === source.indexOf("int value = input"),
  );
  await page
    .locator(".method-item")
    .filter({ hasText: /^calculate\(int/ })
    .click();
  const node = page.locator(
    `.react-flow__node[data-id="${selected.id}"] .blueprint-node`,
  );
  await panToNode(page, node);
  await node.click();
  await revealPanel(page, "analysis", "Анализ");
  await page
    .getByLabel("Действие", { exact: true })
    .selectOption("rename_local");
  await page.getByLabel("Новое имя переменной").fill("doubled");
  await expect(page.getByLabel("Цель изменения")).toHaveValue(
    "preserve_behavior",
  );
  await expect(page.getByLabel("Цель изменения")).toBeDisabled();
  const prepared = page.waitForResponse(
    (r) => r.url().endsWith("/changes") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  const response = await prepared;
  expect(response.status()).toBe(202);
  const p = (await response.json()).data;
  await expect(
    page.getByRole("button", { name: "Проверить на тестах", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  const proposal = (
    await (await page.request.get(f.base + "/changes/" + p.id)).json()
  ).data;
  expect(proposal.status).toBe("ready");
  expect(proposal.diff).toHaveLength(2);
  const candidate = (
    await (
      await page.request.get(
        f.base + "/revisions/" + proposal.candidateRevisionId,
      )
    ).json()
  ).data;
  const code = candidate.files.find(
    (file: any) => file.path === "Main.java",
  ).canonicalText;
  expect(code).toBe(
    source.replace(
      "int value = input * 2; return value + Main.value;",
      "int doubled = input * 2; return doubled + Main.value;",
    ),
  );
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  const command = {
    baseRevisionId: f.original.id,
    analysisId: f.analysis.id,
    methodId: method.id,
    nodeId: selected.id,
    operation: "rename_local",
    intent: "preserve_behavior",
    payload: { newName: "input" },
  };
  const collision = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: command,
  });
  expect(collision.status()).toBe(202);
  const failed = await done(
    page.request,
    f.base,
    (await collision.json()).data.jobId,
  );
  expect(failed.status).toBe("failed");
  expect(failed.error.message).toMatch(/collid|capture/i);
  const semantic = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: { ...command, intent: "semantic_edit" },
  });
  expect(semantic.status()).toBe(400);
  await page.screenshot({
    path: info.outputPath("local-rename-diff.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Проверить на тестах", exact: true })
    .click();
  await page.getByLabel("Класс с main").fill("Main");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "JSON", exact: true })
    .click();
  await page.getByLabel("Входные данные · JSON cases").fill(
    JSON.stringify([
      {
        id: "zero",
        argv: ["0"],
        stdinUtf8: "",
        expectedExitCode: 0,
        expectedStdout: "9\n",
      },
      {
        id: "positive",
        argv: ["7"],
        stdinUtf8: "",
        expectedExitCode: 0,
        expectedStdout: "23\n",
      },
      {
        id: "negative",
        argv: ["-3"],
        stdinUtf8: "",
        expectedExitCode: 0,
        expectedStdout: "3\n",
      },
    ]),
  );
  const comparisonResponse = page.waitForResponse(
    (r) => r.url().endsWith("/comparisons") && r.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сравнить", exact: true })
    .click();
  const comparison = await comparisonResponse;
  expect(comparison.status()).toBe(202);
  const terminal = await done(
    page.request,
    f.base,
    (await comparison.json()).data.id,
  );
  expect(terminal.status).toBe("succeeded");
  const report = terminal.result.report;
  expect(report).toMatchObject({
    outcome: "matched_on_tests",
    coverageComplete: true,
    matched: 3,
    baseRevisionId: f.original.id,
    candidateRevisionId: proposal.candidateRevisionId,
  });
  for (const row of report.testResults) {
    expect(row.baseExecutions).toHaveLength(3);
    expect(row.candidateExecutions).toHaveLength(3);
  }
  await page.reload();
  await expect(
    page.getByRole("button", { name: "К изменению", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "К изменению", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(async () => (await head(page.request, f.base)).id)
    .toBe(proposal.candidateRevisionId);
  expect(
    (await head(page.request, f.base)).files.find(
      (file) => file.path === "notes.txt",
    )?.canonicalText,
  ).toBe("keep café\n");
  await info.attach("local-rename-report", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});
