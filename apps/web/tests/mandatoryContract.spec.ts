import { ENGINE_VERSION } from "./engineVersion";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// All Java below is submitted to the application's isolated Linux runner.
// The Windows test process only reads bytes and exercises HTTP contracts.
const source = readFileSync(new URL("../../../fixtures/mandatory/Main.java", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const oracleBytes = readFileSync(new URL("../../../fixtures/mandatory/oracles.json", import.meta.url), "utf8");
const oracles: any[] = JSON.parse(oracleBytes);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const companion = "Independent mandatory contract — сохранить 😀\n";

async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect.poll(async () => {
    const response = await request.get(base + "/jobs/" + id);
    expect(response.ok()).toBe(true);
    job = (await response.json()).data;
    return job.status;
  }, { timeout: 600000 }).toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}

test("1070 LOC mandatory contract survives a nonidentical overflow edit with 21 independent oracles and 126 sandbox observations", async ({ request }, info) => {
  test.setTimeout(900000);
  expect(source.split("\n").length).toBeGreaterThanOrEqual(1000);
  expect(oracles).toHaveLength(21);
  // Frozen, hand-derived contracts precede both source versions' execution.
  await info.attach("pre-execution-independent-contract", { body: JSON.stringify({
    sourceSha256: hash(source), oracleFileSha256: hash(oracleBytes), oracles,
    modification: "Integer.MAX_VALUE + 1 -> Integer.MAX_VALUE + 0 + 1; Java int overflow preserved",
    scope: "Concrete mandatory forms only; one typed numeric edit, not all constructs' edit axes",
  }), contentType: "application/json" });
  expect((await (await request.get("/api/v1/capabilities")).json()).data.runner.available).toBe(true);
  const created = await request.post("/api/v1/projects", { headers: await headers(request), data: { name: "Mandatory independent contract " + crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).data.id;
  const base = "/api/v1/projects/" + projectId;
  const saved = await request.post(base + "/revisions", { headers: await headers(request, "empty"), data: {
    files: [{ path: "Main.java", content: source }, { path: "contract.txt", content: companion }], intent: "semantic_edit",
  } });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  const analyzing = await request.post(base + "/revisions/" + original.id + "/analysis", { headers: await headers(request), data: {} });
  expect(analyzing.status()).toBe(202);
  await finished(request, base, (await analyzing.json()).data.id);
  const analysis = (await (await request.get(base + "/revisions/" + original.id + "/analysis")).json()).data;
  expect(analysis).toMatchObject({ parseStatus: "valid", revisionId: original.id, analyzerVersion: ENGINE_VERSION });
  // Source contexts stay separate from callable graphs; no invented class-lifecycle CFG.
  expect(analysis.graph.initializerContexts.length).toBeGreaterThan(0);
  for (const context of analysis.graph.initializerContexts) {
    expect(context.projectionKind).toBe("ast_source");
    expect(context.edges.every((edge: any) => edge.kind === "contains")).toBe(true);
  }
  const expression = "Integer.MAX_VALUE + 1";
  const nodes = analysis.graph.nodes.filter((node: any) => node.kind === "expression"
    && node.sourceRange?.filePath === "Main.java"
    && source.slice(node.sourceRange.startOffset, node.sourceRange.endOffset) === expression
    && analysis.graph.methods.find((method: any) => method.id === node.methodId)?.signature.startsWith("numeric("));
  expect(nodes).toHaveLength(1);
  const node = nodes[0];
  expect(node.allowedOperations).toContain("replace_expression");
  const replacement = "Integer.MAX_VALUE + 0 + 1";
  const pending = await request.post(base + "/changes", { headers: await headers(request), data: {
    baseRevisionId: original.id, analysisId: analysis.id, methodId: node.methodId, nodeId: node.id,
    operation: "replace_expression", payload: { field: "expression", source: replacement }, intent: "preserve_behavior",
  } });
  expect(pending.status()).toBe(202);
  const queued = (await pending.json()).data;
  await finished(request, base, queued.jobId);
  const proposal = (await (await request.get(base + "/changes/" + queued.id)).json()).data;
  expect(proposal.checks.compileStatus, JSON.stringify(proposal)).toBe("passed");
  expect(proposal.diff).toHaveLength(1);
  const candidate = (await (await request.get(base + "/revisions/" + proposal.candidateRevisionId)).json()).data;
  const expectedSource = source.slice(0, node.sourceRange.startOffset) + "(" + replacement + ")" + source.slice(node.sourceRange.endOffset);
  expect(expectedSource).not.toBe(source);
  expect(candidate.bundleHash).not.toBe(original.bundleHash);
  expect(candidate.files.find((file: any) => file.path === "Main.java").canonicalText).toBe(expectedSource);
  expect(candidate.files.find((file: any) => file.path === "contract.txt")).toEqual(original.files.find((file: any) => file.path === "contract.txt"));
  expect((await head(request, base)).id).toBe(original.id);
  const premature = await request.post(base + "/head", { headers: await headers(request, original.id), data: {
    expectedHeadRevisionId: original.id, proposalId: proposal.id, candidateRevisionId: candidate.id,
  } });
  expect(premature.ok()).toBe(false);
  expect((await head(request, base)).id).toBe(original.id);
  const madeSuite = await request.post(base + "/test-suites", { headers: await headers(request), data: {
    mode: "console", entryPoint: "Main", comparisonPolicyId: "exact-v1",
    cases: oracles.map(({ id, argv, stdinUtf8, expectedStdout, expectedStderr, expectedExitCode }) => ({
      id, argv, stdinUtf8, expectedStdout, expectedStderr, expectedExitCode,
    })),
  } });
  expect(madeSuite.status()).toBe(201);
  const suite = (await madeSuite.json()).data;
  const submitted = await request.post(base + "/comparisons", { headers: await headers(request), data: {
    baseRevisionId: original.id, candidateRevisionId: candidate.id, suiteVersionId: suite.id, profileId: "java21-v1",
  } });
  expect(submitted.status()).toBe(202);
  const completed = await finished(request, base, (await submitted.json()).data.id);
  const report = completed.result.report ?? (await (await request.get(base + "/comparisons/" + completed.result.comparisonId)).json()).data;
  // Attach failures as well as successful observations, including actual streams/resources.
  await info.attach("mandatory-independent-report", { body: JSON.stringify({ projectId, original, candidate, sourceSha256: hash(source), candidateSha256: hash(expectedSource), analysis, proposal, suite, report }), contentType: "application/json" });
  expect(report.outcome, JSON.stringify(report)).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.plannedRepeatCount).toBe(3);
  expect(report.observedRepeatCounts).toEqual({ base: 63, candidate: 63 });
  expect(report.executionProfileId).toBe("java21-v1");
  expect(report.executionProfileHash).toMatch(/^[0-9a-f]{64}$/);
  expect(report.testResults).toHaveLength(21);
  const executionIds = new Set<string>();
  for (const result of report.testResults) {
    const oracle = oracles.find((item: any) => item.id === result.input.id);
    expect(oracle).toBeTruthy();
    expect(result.baseExecutions).toHaveLength(3);
    expect(result.candidateExecutions).toHaveLength(3);
    for (const observed of [...result.baseExecutions, ...result.candidateExecutions]) {
      const runtime = observed.runtimeExecution ?? observed;
      executionIds.add(runtime.id);
      expect(runtime.outcome).toBe("exited");
      expect(runtime.stdoutUtf8).toBe(oracle.expectedStdout);
      expect(runtime.stderrUtf8).toBe(oracle.expectedStderr);
      expect(runtime.exitCode).toBe(oracle.expectedExitCode);
      expect(runtime.cleanupPending).toBe(false);
      expect(runtime.metrics.executionWallMs).toBeGreaterThanOrEqual(0);
      expect(runtime.metrics.containerPeakMemoryBytes).toBeGreaterThan(0);
      expect(runtime.metrics.memoryScope).toBe("cgroup-v2-container-lifetime-including-setup-and-probe");
    }
  }
  expect(executionIds.size).toBe(126);
  const applied = await request.post(base + "/head", { headers: await headers(request, original.id), data: {
    expectedHeadRevisionId: original.id, proposalId: proposal.id, candidateRevisionId: candidate.id, verificationReportId: report.id,
  } });
  expect(applied.ok()).toBe(true);
  expect((await head(request, base)).id).toBe(candidate.id);
  expect((await (await request.get(base + "/revisions/" + original.id)).json()).data).toEqual(original);
});
