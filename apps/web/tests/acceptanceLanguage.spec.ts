import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

type Oracle = {
  id: string;
  method: string;
  expression: string;
  argv: string[];
  stdinUtf8: string;
  expectedStdout: string;
};
const source = readFileSync(
  new URL("../../../fixtures/synthetic/acceptance/Main.java", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
// These contracts were hand derived before running either revision.
const oracles: Oracle[] = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/synthetic/acceptance/oracles.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const domains = [...new Set(oracles.map((oracle) => oracle.argv[0]))];
const companion =
  "independent language acceptance; preserve this file exactly\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect
    .poll(
      async () => {
        const response = await request.get(base + "/jobs/" + id);
        expect(response.ok()).toBe(true);
        job = (await response.json()).data;
        return job.status;
      },
      { timeout: 240000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}
async function analyze(
  request: APIRequestContext,
  base: string,
  revision: string,
) {
  const response = await request.post(
    base + "/revisions/" + revision + "/analysis",
    {
      headers: await headers(request),
      data: {},
    },
  );
  expect(response.status()).toBe(202);
  await finished(request, base, (await response.json()).data.id);
  const result = await request.get(
    base + "/revisions/" + revision + "/analysis",
  );
  expect(result.ok()).toBe(true);
  const analysis = (await result.json()).data;
  expect(analysis.parseStatus, JSON.stringify(analysis.diagnostics)).toBe(
    "valid",
  );
  expect(analysis.revisionId).toBe(revision);
  return analysis;
}
function editableNode(analysis: any, text: string, oracle: Oracle) {
  const candidates = analysis.graph.nodes.filter((node: any) => {
    const range = node.sourceRange;
    const method = analysis.graph.methods.find(
      (item: any) => item.id === node.methodId,
    );
    return (
      node.kind === "expression" &&
      range?.filePath === "Main.java" &&
      method?.signature.startsWith(oracle.method + "(") &&
      text.slice(range.startOffset, range.endOffset) === oracle.expression &&
      node.allowedOperations?.includes("replace_expression")
    );
  });
  expect(
    candidates,
    "One exact editable expression in its actual method",
  ).toHaveLength(1);
  const node = candidates[0];
  expect(node.analysisId).toBe(analysis.id);
  expect(node.revisionId).toBe(analysis.revisionId);
  expect(node.executionRole).toBe("ast_projection");
  expect(node.editableFieldRanges.expression).toEqual(node.sourceRange);
  const methodNodes = analysis.graph.nodes.filter(
    (item: any) => item.methodId === node.methodId,
  );
  expect(methodNodes.some((item: any) => item.kind === "opaque")).toBe(false);
  expect(methodNodes.some((item: any) => item.kind === "entry")).toBe(true);
  const method = analysis.graph.methods.find(
    (item: any) => item.id === node.methodId,
  );
  expect(node.sourceRange.startOffset).toBeGreaterThan(
    method.sourceRange.startOffset,
  );
  expect(node.sourceRange.endOffset).toBeLessThan(method.sourceRange.endOffset);
  return node;
}

for (const domain of domains) {
  test(`mandatory language ${domain}: bound construct edit and independent Docker oracles`, async ({
    request,
  }, info) => {
    test.setTimeout(480000);
    const cases = oracles.filter((oracle) => oracle.argv[0] === domain);
    const oracle = cases[0];
    await info.attach("pre-execution-contract", {
      body: JSON.stringify({
        sourceSha256: hash(source),
        oraclesSha256: hash(JSON.stringify(oracles)),
        cases,
        expectedStderr: "",
        expectedExitCode: 0,
        scope:
          "Concrete Java forms only; calls/library internals atomic; no organizer/full-group claim",
      }),
      contentType: "application/json",
    });
    const capabilities = (
      await (await request.get("/api/v1/capabilities")).json()
    ).data;
    expect(
      capabilities.runner.available,
      "Real isolated Docker runner required; unavailable is not accepted coverage",
    ).toBe(true);
    const made = await request.post("/api/v1/projects", {
      headers: await headers(request),
      data: {
        name: "Language acceptance " + domain + " " + crypto.randomUUID(),
      },
    });
    expect(made.status()).toBe(201);
    const base = "/api/v1/projects/" + (await made.json()).data.id;
    const saved = await request.post(base + "/revisions", {
      headers: await headers(request, "empty"),
      data: {
        files: [
          { path: "Main.java", content: source },
          { path: "contract.txt", content: companion },
        ],
        intent: "semantic_edit",
      },
    });
    expect(saved.status()).toBe(201);
    const original = (await saved.json()).data;
    const analysis = await analyze(request, base, original.id);
    const node = editableNode(analysis, source, oracle);
    const proposalResponse = await request.post(base + "/changes", {
      headers: await headers(request),
      data: {
        baseRevisionId: original.id,
        analysisId: analysis.id,
        methodId: node.methodId,
        nodeId: node.id,
        operation: "replace_expression",
        payload: { field: "expression", source: oracle.expression },
        intent: "preserve_behavior",
      },
    });
    expect(proposalResponse.status()).toBe(202);
    const pending = (await proposalResponse.json()).data;
    await finished(request, base, pending.jobId);
    const proposal = (
      await (await request.get(base + "/changes/" + pending.id)).json()
    ).data;
    expect(proposal.checks.compileStatus, JSON.stringify(proposal)).toBe(
      "passed",
    );
    const candidate = (
      await (
        await request.get(base + "/revisions/" + proposal.candidateRevisionId)
      ).json()
    ).data;
    const expectedSource =
      source.slice(0, node.sourceRange.startOffset) +
      "(" +
      oracle.expression +
      ")" +
      source.slice(node.sourceRange.endOffset);
    expect(expectedSource).not.toBe(source);
    expect(candidate.files).toHaveLength(2);
    expect(
      candidate.files.find((file: any) => file.path === "Main.java")
        .canonicalText,
    ).toBe(expectedSource);
    expect(
      candidate.files.find((file: any) => file.path === "contract.txt")
        .canonicalText,
    ).toBe(companion);
    const candidateAnalysis = await analyze(request, base, candidate.id);
    expect(candidateAnalysis.id).not.toBe(analysis.id);
    // The enclosed AST expression is still bound to this method in the newly emitted source.
    const candidateNode = editableNode(candidateAnalysis, expectedSource, {
      ...oracle,
      expression: "(" + oracle.expression + ")",
    });
    expect(candidateNode.id).not.toBe(node.id);
    expect((await head(request, base)).id).toBe(original.id);
    const suiteResponse = await request.post(base + "/test-suites", {
      headers: await headers(request),
      data: {
        mode: "console",
        entryPoint: "Main",
        comparisonPolicyId: "exact-v1",
        cases: cases.map((item) => ({
          id: item.id,
          name: item.id,
          argv: item.argv,
          stdinUtf8: item.stdinUtf8,
          expectedStdout: item.expectedStdout,
          expectedStderr: "",
          expectedExitCode: 0,
        })),
      },
    });
    expect(suiteResponse.status()).toBe(201);
    const suite = (await suiteResponse.json()).data;
    const started = await request.post(base + "/comparisons", {
      headers: await headers(request),
      data: {
        baseRevisionId: original.id,
        candidateRevisionId: candidate.id,
        suiteVersionId: suite.id,
        profileId: "java21-v1",
      },
    });
    expect(started.status()).toBe(202);
    const job = await finished(request, base, (await started.json()).data.id);
    const report =
      job.result.report ??
      (
        await (
          await request.get(base + "/comparisons/" + job.result.comparisonId)
        ).json()
      ).data;
    await info.attach("language-acceptance", {
      body: JSON.stringify({
        domain,
        cases,
        originalRevisionId: original.id,
        candidateRevisionId: candidate.id,
        analyzerVersion: analysis.analyzerVersion,
        analysisId: analysis.id,
        candidateAnalysisId: candidateAnalysis.id,
        node,
        candidateNode,
        sourceSha256: hash(source),
        candidateSha256: hash(expectedSource),
        before: source,
        after: expectedSource,
        proposal,
        report,
      }),
      contentType: "application/json",
    });
    expect(report.outcome, JSON.stringify(report)).toBe("matched_on_tests");
    expect(report.coverageComplete).toBe(true);
    expect(report.testResults).toHaveLength(cases.length);
    for (const result of report.testResults) {
      const expected = cases.find((item) => item.id === result.input.id)!;
      expect(expected).toBeTruthy();
      expect(result.baseExecutions).toHaveLength(3);
      expect(result.candidateExecutions).toHaveLength(3);
      for (const observation of [
        ...result.baseExecutions,
        ...result.candidateExecutions,
      ]) {
        const runtime = observation.runtimeExecution ?? observation;
        expect(runtime.stdoutUtf8).toBe(expected.expectedStdout);
        expect(runtime.stderrUtf8).toBe("");
        expect(runtime.exitCode).toBe(0);
      }
    }
    expect((await head(request, base)).id).toBe(original.id);
    const retained = (
      await (await request.get(base + "/revisions/" + original.id)).json()
    ).data;
    expect(
      retained.files.find((file: any) => file.path === "Main.java")
        .canonicalText,
    ).toBe(source);
    expect(
      retained.files.find((file: any) => file.path === "contract.txt")
        .canonicalText,
    ).toBe(companion);
  });
}
