import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel, panToNode, setTheme } from "./flowAssertions";

const source = `import java.util.ArrayList;
public class Main {
  public static void main(String[] args) {
    ArrayList<String> allowed = new ArrayList<>();
    allowed.add("Aa");
    allowed.add("BB");
    allowed.add("dup");
    allowed.add("dup");
    allowed.add(null);
    allowed.add("кириллица");
    for (String raw : args) {
      String query = raw.equals("<null>") ? null : raw;
      System.out.println(query + ":" + allowed.contains(query));
    }
  }
}\n`;
const cases = [
  {
    id: "empty",
    name: "Нет запросов",
    argv: [],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "",
  },
  {
    id: "one",
    name: "Один ключ",
    argv: ["Aa"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "Aa:true\n",
  },
  {
    id: "missing",
    name: "Нет совпадения",
    argv: ["missing"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "missing:false\n",
  },
  {
    id: "null",
    name: "Null",
    argv: ["<null>", "missing"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "null:true\nmissing:false\n",
  },
  {
    id: "duplicates",
    name: "Дубли и повторы",
    argv: ["dup", "dup", "Aa"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "dup:true\ndup:true\nAa:true\n",
  },
  {
    id: "collision",
    name: "Коллизии строк",
    argv: ["Aa", "BB", "AaAa", "BBBB"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "Aa:true\nBB:true\nAaAa:false\nBBBB:false\n",
  },
  {
    id: "unicode",
    name: "UTF-8",
    argv: ["кириллица", "кошка"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "кириллица:true\nкошка:false\n",
  },
  {
    id: "order",
    name: "Порядок вывода",
    argv: ["BB", "missing", "Aa", "<null>", "BB"],
    stdinUtf8: "",
    expectedExitCode: 0,
    expectedStdout: "BB:true\nmissing:false\nAa:true\nnull:true\nBB:true\n",
  },
];
async function fixture(page: Page, text = source) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Membership " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [
        { path: "Main.java", content: text },
        {
          path: "Helper.java",
          content: "class Helper { static int answer() { return 7; } }\n",
        },
        { path: "notes.txt", content: "unchanged companion\n" },
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
  expect(analysis.analyzerVersion).toBe("engine-0.10.0");
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

test("membership recommendation compiles a detached index and applies only after an independent real 3+3 suite", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  const f = await fixture(page);
  expect(f.analysis.optimizations).toHaveLength(1);
  await page.getByRole("button", { name: "Helper.java", exact: true }).click();
  await revealPanel(page, "analysis", "Анализ");
  const panel = page.locator('[data-panel-id="analysis"]');
  await panel.getByRole("tab", { name: /^Рекомендации/ }).click();
  await panel
    .locator('[data-optimization="OPT-MEMBERSHIP-001"]')
    .getByRole("button", { name: "Открыть изменение", exact: true })
    .click();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveValue(
    "optimize_membership",
  );
  await expect(page.getByLabel("Цель изменения")).toHaveValue(
    "preserve_behavior",
  );
  await expect(page.getByLabel("Цель изменения")).toBeDisabled();
  await expect(page.getByLabel("Условия оптимизации")).toContainText(
    "дополнительной памяти",
  );
  // A later drag must win over an already handled recommendation request.
  await page.getByLabel("Добавить блок", { exact: true }).click();
  const loop = page.locator('.blueprint-node[data-node-kind="ForEachStmt"]');
  await expect(loop).toBeVisible();
  await panToNode(page, loop);
  const loopBox = (await loop.boundingBox())!;
  await page.locator(".palette-statement").dragTo(loop, {
    targetPosition: {
      x: Math.min(30, loopBox.width / 2),
      y: Math.min(20, loopBox.height / 2),
    },
  });
  await expect(page.getByLabel("Действие", { exact: true })).toHaveValue(
    "insert_statement",
  );
  await panel.getByRole("tab", { name: /^Рекомендации/ }).click();
  await panel
    .locator('[data-optimization="OPT-MEMBERSHIP-001"]')
    .getByRole("button", { name: "Открыть изменение", exact: true })
    .click();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveValue(
    "optimize_membership",
  );
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("membership-assumptions-dark.png"),
    animations: "disabled",
  });
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
  expect(proposal.intent).toBe("preserve_behavior");
  const candidate = (
    await (
      await page.request.get(
        f.base + "/revisions/" + proposal.candidateRevisionId,
      )
    ).json()
  ).data;
  const code = candidate.files.find(
    (file: { path: string }) => file.path === "Main.java",
  ).canonicalText;
  expect(code).toContain("allowed.add(null)");
  expect(code).toContain("HashSet<java.lang.String> jbMembership");
  expect(code).toContain("jbMembership.contains(query)");
  expect(
    candidate.files.find((file: { path: string }) => file.path === "notes.txt")
      .canonicalText,
  ).toBe("unchanged companion\n");
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  const forged = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      analysisId: f.analysis.id,
      methodId: f.analysis.optimizations[0].methodId,
      nodeId: f.analysis.optimizations[0].nodeId,
      operation: "optimize_membership",
      payload: {},
      intent: "semantic_edit",
    },
  });
  expect(forged.status()).toBe(400);
  await page
    .getByRole("button", { name: "Проверить на тестах", exact: true })
    .click();
  await page.getByLabel("Класс с main").fill("Main");
  await page
    .getByLabel("Входные данные · JSON cases")
    .fill(JSON.stringify(cases));
  const comparisonResponse = page.waitForResponse(
    (r) => r.url().endsWith("/comparisons") && r.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сравнить", exact: true })
    .click();
  const started = await comparisonResponse;
  expect(started.status()).toBe(202);
  const job = (await started.json()).data;
  const terminal = await done(page.request, f.base, job.id);
  expect(terminal.status).toBe("succeeded");
  const report = terminal.result.report;
  expect(report.outcome).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.matched).toBe(8);
  expect(report.baseRevisionId).toBe(f.original.id);
  expect(report.candidateRevisionId).toBe(proposal.candidateRevisionId);
  for (const row of report.testResults) {
    expect(row.baseExecutions).toHaveLength(3);
    expect(row.candidateExecutions).toHaveLength(3);
  }
  await page.getByRole("button", { name: "К изменению", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(async () => (await head(page.request, f.base)).id)
    .toBe(proposal.candidateRevisionId);
  await expect(
    page.locator('.blueprint-node[title*="jbMembership"]').first(),
  ).toBeVisible({ timeout: 30000 });
  await info.attach("exact-membership-report", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
  await setTheme(page, "light");
  await page.screenshot({
    path: info.outputPath("membership-applied-light.png"),
    animations: "disabled",
  });
});

test("an empty collection stays correct and a mismatching oracle cannot authorize apply", async ({
  page,
}) => {
  test.setTimeout(180000);
  const empty = source.replace(/^    allowed.add\(.*\);\n/gm, "");
  const f = await fixture(page, empty);
  expect(f.analysis.optimizations).toHaveLength(1);
  const op = f.analysis.optimizations[0];
  const proposed = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      analysisId: f.analysis.id,
      methodId: op.methodId,
      nodeId: op.nodeId,
      operation: "optimize_membership",
      payload: {},
      intent: "preserve_behavior",
    },
  });
  expect(proposed.status()).toBe(202);
  const p = (await proposed.json()).data;
  expect((await done(page.request, f.base, p.jobId)).status).toBe("succeeded");
  const proposal = (
    await (await page.request.get(f.base + "/changes/" + p.id)).json()
  ).data;
  const suite = await page.request.post(f.base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: [
        {
          id: "empty-list",
          argv: ["Aa", "<null>"],
          stdinUtf8: "",
          expectedExitCode: 0,
          expectedStdout: "Aa:false\nnull:false\n",
        },
      ],
    },
  });
  expect(suite.status()).toBe(201);
  const suiteId = (await suite.json()).data.id;
  const comparison = await page.request.post(f.base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      candidateRevisionId: proposal.candidateRevisionId,
      suiteVersionId: suiteId,
      profileId: "java21-v1",
    },
  });
  const report = (
    await done(page.request, f.base, (await comparison.json()).data.id)
  ).result.report;
  expect(report.outcome).toBe("matched_on_tests");
  const badSuite = await page.request.post(f.base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: [
        {
          id: "wrong-oracle",
          argv: ["Aa"],
          stdinUtf8: "",
          expectedExitCode: 0,
          expectedStdout: "WRONG\n",
        },
      ],
    },
  });
  const bad = await page.request.post(f.base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      candidateRevisionId: proposal.candidateRevisionId,
      suiteVersionId: (await badSuite.json()).data.id,
      profileId: "java21-v1",
    },
  });
  const mismatched = (
    await done(page.request, f.base, (await bad.json()).data.id)
  ).result.report;
  expect(mismatched.outcome).toBe("mismatch");
  const apply = await page.request.post(f.base + "/head", {
    headers: await headers(page.request, f.original.id),
    data: {
      expectedHeadRevisionId: f.original.id,
      proposalId: p.id,
      candidateRevisionId: proposal.candidateRevisionId,
      verificationReportId: mismatched.id,
    },
  });
  expect(apply.status()).toBe(409);
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});
