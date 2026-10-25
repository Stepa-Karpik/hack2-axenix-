import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { headers, head, zip, unzip } from "./fileFixtures";
import { largeFixture, largeCases } from "./largeFixture";
import { revealPanel, panToNode, setTheme } from "./flowAssertions";
const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] +
        sorted[Math.floor(sorted.length / 2)]) /
      2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
async function done(page: Page, base: string, id: string) {
  let result: any;
  await expect
    .poll(
      async () => {
        result = (await (await page.request.get(base + "/jobs/" + id)).json())
          .data;
        return result.status;
      },
      { timeout: 480000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return result;
}
test("1100-line hierarchy imports without loss, remains navigable and verifies twenty independent real inputs", async ({
  page,
}, info) => {
  test.setTimeout(600000);
  const files = largeFixture(),
    cases = largeCases();
  expect(Object.keys(files)).toHaveLength(10);
  expect(
    Object.values(files).reduce(
      (n, text) => n + text.split("\n").length - 1,
      0,
    ),
  ).toBe(1100);
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Large project " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  await page.goto("/projects/" + id);
  await page
    .locator(".explorer-tools")
    .getByRole("button", { name: "Импорт", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Выбрать ZIP или файлы", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "large.zip",
    mimeType: "application/zip",
    buffer: zip(
      Object.entries(files).map(([path, text]) => ({
        path,
        text,
        deflate: true,
      })),
    ),
  });
  const dialog = page.getByRole("dialog", { name: "Импорт файлов" });
  await expect(
    dialog.getByRole("checkbox", {
      name: "demo/stages/Stage8.java",
      exact: true,
    }),
  ).toBeChecked();
  const importStarted = performance.now();
  await dialog
    .getByRole("button", { name: "Импортировать выбранное", exact: true })
    .click();
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 60000,
  });
  const importToGraphMs = performance.now() - importStarted;
  const original = await head(page.request, base);
  expect(original.files).toHaveLength(10);
  for (const file of original.files) {
    expect(file.canonicalText).toBe(files[file.path]);
    expect(file.sourceHash).toBe(
      createHash("sha256").update(files[file.path]).digest("hex"),
    );
  }
  const analysis = (
    await (
      await page.request.get(base + "/revisions/" + original.id + "/analysis")
    ).json()
  ).data;
  expect(analysis.parseStatus).toBe("valid");
  expect(analysis.graph.methods).toHaveLength(50);
  expect(analysis.quality.methods).toHaveLength(50);
  await page.locator('[data-file-path="demo/stages/Stage8.java"]').click();
  await page
    .locator(".method-item")
    .filter({ hasText: /^step4\(/ })
    .last()
    .click();
  await expect(page.locator(".blueprint-node.entry")).toContainText("step4");
  await revealPanel(page, "code", "Код");
  await expect(page.locator(".monaco-editor")).toContainText(
    "values[index] + 45",
  );
  await page.locator('[data-file-path="demo/Main.java"]').click();
  await page
    .locator(".method-item")
    .filter({ hasText: /^evaluate\(/ })
    .click();
  await expect(page.locator(".blueprint-node.entry")).toContainText("evaluate");
  await revealPanel(page, "analysis", "Анализ");
  const visibleNodes = await page.locator(".blueprint-node").count();
  expect(visibleNodes).toBeLessThan(analysis.graph.nodes.length);
  const evaluateMethod = analysis.graph.methods.find((method: any) =>
    method.signature.startsWith("evaluate("),
  );
  const targetIds = analysis.graph.nodes
    .filter(
      (node: any) =>
        node.methodId === evaluateMethod.id &&
        node.sourceRange &&
        node.allowedOperations.includes("replace_statement"),
    )
    .sort(
      (a: any, b: any) => a.sourceRange.startOffset - b.sourceRange.startOffset,
    )
    .slice(0, 2)
    .map((node: any) => node.id);
  expect(targetIds).toHaveLength(2);
  const selectionSamples: number[] = [];
  for (let i = 0; i < 35; i++) {
    const node = page.locator(
      `.react-flow__node[data-id="${targetIds[i % 2]}"] .blueprint-node`,
    );
    await panToNode(page, node);
    const started = performance.now();
    await node.click();
    await expect(node).toHaveClass(/selected/);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    if (i >= 5) selectionSamples.push(performance.now() - started);
  }
  const hardware = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as any).deviceMemory,
      renderer:
        gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("large-hierarchy-dark.png"),
    animations: "disabled",
  });
  const write = analysis.graph.nodes.find(
    (node: any) =>
      node.sourceRange?.filePath === "demo/Main.java" &&
      node.allowedOperations.includes("replace_statement") &&
      files["demo/Main.java"].slice(
        node.sourceRange.startOffset,
        node.sourceRange.endOffset,
      ) === "System.out.println(result);",
  );
  expect(write).toBeTruthy();
  const requested = await page.request.post(base + "/changes", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: original.id,
      analysisId: analysis.id,
      methodId: write.methodId,
      nodeId: write.id,
      operation: "replace_statement",
      payload: { source: 'System.out.print(result + "\\n");' },
      intent: "preserve_behavior",
    },
  });
  expect(requested.status()).toBe(202);
  const p = (await requested.json()).data;
  expect((await done(page, base, p.jobId)).status).toBe("succeeded");
  const proposal = (
    await (await page.request.get(base + "/changes/" + p.id)).json()
  ).data;
  expect(proposal.status).toBe("ready");
  const suite = await page.request.post(base + "/test-suites", {
    headers: await headers(page.request),
    data: {
      mode: "console",
      entryPoint: "demo.Main",
      comparisonPolicyId: "exact-v1",
      cases,
    },
  });
  expect(suite.status()).toBe(201);
  const started = await page.request.post(base + "/comparisons", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: original.id,
      candidateRevisionId: proposal.candidateRevisionId,
      suiteVersionId: (await suite.json()).data.id,
      profileId: "java21-v1",
    },
  });
  expect(started.status()).toBe(202);
  const job = (await started.json()).data;
  await page.goto("/projects/" + id + "/runs/" + job.id);
  await revealPanel(page, "tests", "Тесты");
  const finished = await done(page, base, job.id);
  expect(finished.status).toBe("succeeded");
  const report = finished.result.report;
  expect(report.outcome).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.matched).toBe(20);
  for (const result of report.testResults) {
    const expected = cases.find((c) => c.id === result.caseId)!;
    expect(result.baseExecutions).toHaveLength(3);
    expect(result.candidateExecutions).toHaveLength(3);
    for (const execution of [
      ...result.baseExecutions,
      ...result.candidateExecutions,
    ]) {
      expect(execution.outcome).toBe("exited");
      expect(execution.exitCode).toBe(0);
      expect(execution.stdoutUtf8).toBe(expected.expectedStdout);
      expect(execution.stderrUtf8).toBe("");
      expect(execution.truncated).toBe(false);
      expect(execution.metrics.executionWallMs).toBeGreaterThanOrEqual(0);
      expect(execution.metrics.containerPeakMemoryBytes).toBeGreaterThan(0);
      expect(execution.metrics.memoryScope).toBe(
        "cgroup-v2-container-lifetime-including-setup-and-probe",
      );
    }
  }
  expect((await head(page.request, base)).id).toBe(original.id);
  expect(finished.result.comparisonId).toBeTruthy();
  const exported = await page.request.post(base + "/exports", {
    headers: await headers(page.request),
    data: {
      revisionId: original.id,
      includeReportIds: [finished.result.comparisonId],
    },
  });
  expect(exported.status()).toBe(201);
  const download = await page.request.get(
    (await exported.json()).data.downloadUrl,
  );
  expect(download.ok()).toBe(true);
  const contents = unzip(await download.body());
  for (const [path, text] of Object.entries(files))
    expect(contents[path]).toBe(text);
  await writeFile(
    info.outputPath("large-project-evidence.json"),
    JSON.stringify(
      {
        projectId: id,
        originalRevisionId: original.id,
        candidateRevisionId: proposal.candidateRevisionId,
        bundleHash: analysis.bundleHash,
        files: 10,
        classes: 10,
        methods: 50,
        sourceLines: 1100,
        totalGraphNodes: analysis.graph.nodes.length,
        visibleNodes,
        importToGraphMs,
        selectionAutomationInclusiveMs: summarize(selectionSamples),
        executionWallMs: summarize(
          report.testResults.flatMap((r: any) =>
            [...r.baseExecutions, ...r.candidateExecutions].map(
              (e: any) => e.metrics.executionWallMs,
            ),
          ),
        ),
        containerPeakMemoryBytes: summarize(
          report.testResults.flatMap((r: any) =>
            [...r.baseExecutions, ...r.candidateExecutions].map(
              (e: any) => e.metrics.containerPeakMemoryBytes,
            ),
          ),
        ),
        hardware,
        cases,
        report,
        limitations: [
          "Single import sample includes queue/poll/layout; no cold/warm distribution claimed",
          "Selection includes automation and two animation frames; no bare application latency claim",
          "No pan FPS/edit latency measured here; execution wall includes docker exec and stream draining; cgroup peak includes container setup and the read probe, not isolated JVM heap",
          "This fixture does not cover every mandatory Java feature; T61-T63 remain partial",
        ],
      },
      null,
      2,
    ),
  );
});
