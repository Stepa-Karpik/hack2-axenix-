import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

const source = `public class Main {
  public static void main(String[] args) {
    int seed = args.length == 0 ? 0 : Integer.parseInt(args[0]);
    int doubled = seed * 2;
    int result = doubled + 1;
    System.out.println(result);
  }
}\n`;
async function fixture(page: Page, text = source) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Extract method " + crypto.randomUUID() },
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
async function selectStatements(page: Page) {
  await revealPanel(page, "code", "Код");
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  for (let line = 0; line < 3; line++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
}

test("selected statements infer a helper and require exact 3+3 oracle comparison before apply", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  const f = await fixture(page);
  await selectStatements(page);
  await expect(page.getByLabel("Действие", { exact: true })).toHaveValue(
    "extract_method",
  );
  await expect(page.getByLabel("Цель изменения")).toHaveValue(
    "preserve_behavior",
  );
  await expect(page.getByLabel("Цель изменения")).toBeDisabled();
  await page.getByLabel("Имя нового метода").fill("calculateResult");
  const prepared = page.waitForResponse(
    (r) => r.url().endsWith("/changes") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  const response = await prepared;
  expect(response.status()).toBe(202);
  const p = (await response.json()).data;
  await expect(page.getByLabel("Извлечённый метод")).toContainText(
    "calculateResult",
    { timeout: 60000 },
  );
  const proposal = (
    await (await page.request.get(f.base + "/changes/" + p.id)).json()
  ).data;
  expect(proposal.status).toBe("ready");
  expect(proposal.extraction).toMatchObject({
    methodName: "calculateResult",
    returnType: "int",
    returnedVariable: "result",
    isStatic: true,
    parameters: [{ name: "seed", type: "int" }],
  });
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  const blocked = await page.request.post(f.base + "/head", {
    headers: await headers(page.request, f.original.id),
    data: {
      expectedHeadRevisionId: f.original.id,
      proposalId: p.id,
      candidateRevisionId: proposal.candidateRevisionId,
    },
  });
  expect(blocked.status()).toBe(400);
  await page.screenshot({
    path: info.outputPath("extraction-diff.png"),
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
        argv: [],
        stdinUtf8: "",
        expectedExitCode: 0,
        expectedStdout: "1\n",
      },
      {
        id: "positive",
        argv: ["7"],
        stdinUtf8: "",
        expectedExitCode: 0,
        expectedStdout: "15\n",
      },
      {
        id: "negative",
        argv: ["-3"],
        stdinUtf8: "",
        expectedExitCode: 0,
        expectedStdout: "-5\n",
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
  await expect(page.getByLabel("Извлечённый метод")).toContainText(
    "calculateResult",
  );
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(async () => (await head(page.request, f.base)).id)
    .toBe(proposal.candidateRevisionId);
  const final = await head(page.request, f.base);
  expect(
    final.files.find((file) => file.path === "notes.txt")?.canonicalText,
  ).toBe("keep café\n");
  expect(
    final.files.find((file) => file.path === "Main.java")?.canonicalText,
  ).toContain("calculateResult(seed)");
  await info.attach("extraction-report", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});

test("method extraction API refuses semantic intent, raw offsets and foreign endpoint IDs", async ({
  page,
}) => {
  const f = await fixture(page);
  const start = f.analysis.graph.nodes.find(
    (node: any) =>
      node.sourceRange?.startOffset === source.indexOf("int doubled"),
  );
  const command = {
    baseRevisionId: f.original.id,
    analysisId: f.analysis.id,
    methodId: start.methodId,
    nodeId: start.id,
    operation: "extract_method",
    intent: "preserve_behavior",
    payload: { methodName: "calculate", endNodeId: start.id },
  };
  for (const bad of [
    { ...command, intent: "semantic_edit" },
    { ...command, payload: { ...command.payload, startOffset: 1 } },
  ]) {
    const rejected = await page.request.post(f.base + "/changes", {
      headers: await headers(page.request),
      data: bad,
    });
    expect(rejected.status()).toBe(400);
  }
  const badEnd = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: {
      ...command,
      payload: { ...command.payload, endNodeId: "foreign-end" },
    },
  });
  expect(badEnd.status()).toBe(202);
  const queued = (await badEnd.json()).data;
  expect((await done(page.request, f.base, queued.jobId)).status).toBe(
    "failed",
  );
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});

test("loop backedge output remains live and matches independent stdout in three observations per side", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  const text = `public class Main {
  public static void main(String[] args) {
    int limit = Integer.parseInt(args[0]);
    int value = 0;
    while (value < limit) {
      System.out.print(value + ",");
      value++;
    }
    System.out.println("done");
  }
}\n`;
  // Fixed before creating either candidate or observations. The mutated local is read
  // only at source positions before the selected increment, including the backedge.
  const cases = [
    {
      id: "zero",
      name: "No iteration",
      argv: ["0"],
      stdinUtf8: "",
      expectedExitCode: 0,
      expectedStdout: "done\n",
      expectedStderr: "",
    },
    {
      id: "one",
      name: "One iteration",
      argv: ["1"],
      stdinUtf8: "",
      expectedExitCode: 0,
      expectedStdout: "0,done\n",
      expectedStderr: "",
    },
    {
      id: "four",
      name: "Four iterations",
      argv: ["4"],
      stdinUtf8: "",
      expectedExitCode: 0,
      expectedStdout: "0,1,2,3,done\n",
      expectedStderr: "",
    },
  ];
  const f = await fixture(page, text);
  const node = f.analysis.graph.nodes.find(
    (n: any) =>
      n.label === "value++;" && n.allowedOperations.includes("extract_method"),
  );
  expect(node).toBeTruthy();
  const started = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      analysisId: f.analysis.id,
      methodId: node.methodId,
      nodeId: node.id,
      operation: "extract_method",
      intent: "preserve_behavior",
      payload: { methodName: "advanceValue", endNodeId: node.id },
    },
  });
  expect(started.status()).toBe(202);
  const pending = (await started.json()).data;
  expect((await done(page.request, f.base, pending.jobId)).status).toBe(
    "succeeded",
  );
  const proposal = (
    await (await page.request.get(f.base + "/changes/" + pending.id)).json()
  ).data;
  expect(proposal.status).toBe("ready");
  expect(proposal.extraction).toMatchObject({
    returnedVariable: "value",
    returnType: "int",
    parameters: [{ name: "value", type: "int" }],
  });
  const candidate = (
    await (
      await page.request.get(
        f.base + "/revisions/" + proposal.candidateRevisionId,
      )
    ).json()
  ).data;
  expect(
    candidate.files.find((file: any) => file.path === "Main.java")
      .canonicalText,
  ).toContain("value = advanceValue(value);");
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  const suite = await page.request.post(f.base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases,
    },
  });
  expect(suite.status()).toBe(201);
  const compare = await page.request.post(f.base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      candidateRevisionId: proposal.candidateRevisionId,
      suiteVersionId: (await suite.json()).data.id,
      profileId: "java21-v1",
    },
  });
  expect(compare.status()).toBe(202);
  const job = await done(page.request, f.base, (await compare.json()).data.id);
  expect(job.status).toBe("succeeded");
  const report = job.result.report;
  expect(report).toMatchObject({
    outcome: "matched_on_tests",
    coverageComplete: true,
    matched: 3,
  });
  for (const row of report.testResults) {
    const oracle = cases.find((c) => c.id === row.caseId)!;
    expect(row.baseExecutions).toHaveLength(3);
    expect(row.candidateExecutions).toHaveLength(3);
    for (const execution of [
      ...row.baseExecutions,
      ...row.candidateExecutions,
    ]) {
      expect(execution.outcome).toBe("exited");
      expect(execution.exitCode).toBe(oracle.expectedExitCode);
      expect(execution.stdoutUtf8).toBe(oracle.expectedStdout);
      expect(execution.stderrUtf8).toBe(oracle.expectedStderr);
      expect(execution.truncated).toBe(false);
    }
  }
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  await info.attach("backedge-independent-oracle-report", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});
