import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

const source = `public class Main {
  public static void main(String[] args) { System.out.println(sumEven(Integer.parseInt(args[0]))); }
  static int sumEven(int count) {
    int total = 0;
    for (int next = 0; next <= count; next++) {
      if (next % 2 == 0) total += next;
    }
    return total;
  }
}\n`;
async function fixture(page: Page, text = source) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Class decomposition " + crypto.randomUUID() },
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
test("static method moves into a separate class with retained callers and mandatory 3+3 oracles", async ({
  page,
}, info) => {
  test.setTimeout(420000);
  const f = await fixture(page);
  await page
    .locator(".method-item")
    .filter({ hasText: /^sumEven\(/ })
    .click();
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.locator(".blueprint-node.entry").click();
  await revealPanel(page, "analysis", "Анализ");
  await page
    .getByLabel("Действие", { exact: true })
    .selectOption("decompose_class");
  await page.getByLabel("Имя нового класса").fill("EvenTotals");
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
  await expect(page.getByLabel("Новый класс")).toContainText(
    "EvenTotals.java",
    { timeout: 60000 },
  );
  const proposal = (
    await (await page.request.get(f.base + "/changes/" + p.id)).json()
  ).data;
  expect(proposal.status).toBe("ready");
  expect(proposal.decomposition).toEqual({
    filePath: "EvenTotals.java",
    className: "EvenTotals",
    originalMethodName: "sumEven",
  });
  expect(proposal.diff).toHaveLength(2);
  expect(proposal.diff.map((d: any) => d.filePath).sort()).toEqual([
    "EvenTotals.java",
    "Main.java",
  ]);
  const candidate = (
    await (
      await page.request.get(
        f.base + "/revisions/" + proposal.candidateRevisionId,
      )
    ).json()
  ).data;
  expect(candidate.files).toHaveLength(3);
  expect(
    candidate.files.find((file: any) => file.path === "Main.java")
      .canonicalText,
  ).toContain("return EvenTotals.sumEven(count);");
  expect(
    candidate.files.find((file: any) => file.path === "Main.java")
      .canonicalText,
  ).toContain("System.out.println(sumEven(Integer.parseInt(args[0])))");
  expect(
    candidate.files.find((file: any) => file.path === "EvenTotals.java")
      .canonicalText,
  ).toContain("total += next");
  expect(
    candidate.files.find((file: any) => file.path === "notes.txt")
      .canonicalText,
  ).toBe("keep café\n");
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("class-decomposition-diff.png"),
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
  const inputs = [-3, 0, 1, 2, 6, 7, 10],
    outputs = [0, 0, 0, 2, 12, 12, 30];
  await page
    .getByLabel("Входные данные · JSON cases")
    .fill(
      JSON.stringify(
        inputs.map((value, index) => ({
          id: "even-" + index,
          argv: [String(value)],
          stdinUtf8: "",
          expectedExitCode: 0,
          expectedStdout: outputs[index] + "\n",
        })),
      ),
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
    matched: 7,
    baseRevisionId: f.original.id,
    candidateRevisionId: proposal.candidateRevisionId,
  });
  for (const row of report.testResults) {
    expect(row.baseExecutions).toHaveLength(3);
    expect(row.candidateExecutions).toHaveLength(3);
  }
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
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
  let analysis: any;
  await expect
    .poll(async () => {
      analysis = (
        await (
          await page.request.get(
            f.base + "/revisions/" + proposal.candidateRevisionId + "/analysis",
          )
        ).json()
      ).data;
      return analysis?.parseStatus;
    })
    .toBe("valid");
  const symbols = new Map(
    analysis.semantics.symbols.map((symbol: any) => [symbol.id, symbol]),
  );
  expect(
    analysis.semantics.references.some(
      (ref: any) =>
        ref.name === "sumEven" &&
        ref.sourceRange.filePath === "Main.java" &&
        ref.resolution === "exact" &&
        ref.targetIds.some(
          (id: string) =>
            (symbols.get(id) as any)?.sourceRange?.filePath ===
            "EvenTotals.java",
        ),
    ),
  ).toBe(true);
  await info.attach("class-decomposition-report", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});

test("state-dependent method reports an explicit refusal and preserves source head", async ({
  page,
}) => {
  const f = await fixture(
    page,
    source
      .replace(
        "  static int sumEven",
        "  static int bias = 1;\n  static int sumEven",
      )
      .replace("int total = 0;", "int total = bias;"),
  );
  const method = f.analysis.graph.methods.find((m: any) =>
    m.signature.startsWith("sumEven("),
  );
  await page
    .locator(".method-item")
    .filter({ hasText: /^sumEven\(/ })
    .click();
  await page.locator(".blueprint-node.entry").click();
  await revealPanel(page, "analysis", "Анализ");
  await page
    .getByLabel("Действие", { exact: true })
    .selectOption("decompose_class");
  await page.getByLabel("Имя нового класса").fill("EvenTotals");
  const prepared = page.waitForResponse(
    (r) => r.url().endsWith("/changes") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  const response = await prepared;
  expect(response.status()).toBe(202);
  const p = (await response.json()).data;
  const terminal = await done(page.request, f.base, p.jobId);
  expect(terminal.status).toBe("failed");
  expect(terminal.error.message).toMatch(/field|state|closed|local|depend/i);
  await expect(
    page
      .locator('[role="alert"]')
      .filter({ hasText: /field|state|closed|local|depend/i })
      .first(),
  ).toBeVisible();
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  expect(method).toBeTruthy();
});
