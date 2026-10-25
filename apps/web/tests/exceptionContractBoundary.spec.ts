import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// This is an explicit console adapter around Java method results/exceptions.
// It is NOT a native semantic method harness. Fixture Java runs only in Docker.
const source = `public class Main {
  static final StringBuilder trace = new StringBuilder();
  static int choose(int value) { return 10; }
  static int choose(long value) { return 20; }
  static int action(int mode) throws Exception {
    try (Resource first = new Resource("A"); Resource second = new Resource("B")) {
      if (mode == 1) throw new Exception("body", new IllegalArgumentException("root"));
      return choose(7) + choose(7L);
    } finally {
      trace.append("F;");
      if (mode == 3) throw new IllegalStateException("finally", new Exception("replacement"));
    }
  }
  public static void main(String[] args) {
    System.out.print("overloads=" + choose(7) + ":" + choose(7L) + "|");
    try { System.out.print("value=" + action(Integer.parseInt(args[0]))); }
    catch (Exception failure) {
      System.out.print(trace + "exception=" + describe(failure));
      System.out.print(";cause=" + (failure.getCause() == null ? "none" : describe(failure.getCause())));
      System.out.print(";suppressed=");
      Throwable[] suppressed = failure.getSuppressed();
      for (int i = 0; i < suppressed.length; i++) {
        if (i != 0) System.out.print(",");
        System.out.print(describe(suppressed[i]));
      }
      System.out.println();
    }
  }
  static String describe(Throwable failure) {
    return failure.getClass().getSimpleName() + ":" + failure.getMessage();
  }
}
class Resource implements AutoCloseable {
  final String label;
  Resource(String label) { this.label = label; }
  public void close() throws Exception {
    Main.trace.append(label).append(";");
    throw new Exception("close-" + label);
  }
}
`;
// Derived from JLS resource closing / finally rules, before either revision runs:
// body failure suppresses B then A; return is superseded by B, which suppresses A;
// finally failure replaces the resource failure and has no automatically inherited suppressed list.
const cases = [
  { id: "body-cause-two-suppressed", argv: ["1"], expectedStdout: "overloads=10:20|B;A;F;exception=Exception:body;cause=IllegalArgumentException:root;suppressed=Exception:close-B,Exception:close-A\n" },
  { id: "return-replaced-by-close", argv: ["2"], expectedStdout: "overloads=10:20|B;A;F;exception=Exception:close-B;cause=none;suppressed=Exception:close-A\n" },
  { id: "finally-replaces-resource-error", argv: ["3"], expectedStdout: "overloads=10:20|B;A;F;exception=IllegalStateException:finally;cause=Exception:replacement;suppressed=\n" },
].map(item => ({ ...item, stdinUtf8: "", expectedStderr: "", expectedExitCode: 0 }));

async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect.poll(async () => {
    job = (await (await request.get(base + "/jobs/" + id)).json()).data;
    return job.status;
  }, { timeout: 300000 }).toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}

test("a console-policy payload cannot claim method mode while its explicit console adapter preserves exception behavior", async ({ request }, info) => {
  test.setTimeout(540000);
  await info.attach("independent-console-exception-contract", { body: JSON.stringify({ source, cases, adapter: "Explicit user Java catch adapter; this fixture tests console exact-v1 only", nativeMethodHarness: "Separate bounded method-v1 mode exists; this console adapter does not substitute for its native channel" }), contentType: "application/json" });
  const capabilities = (await (await request.get("/api/v1/capabilities")).json()).data;
  expect(capabilities.method_harness).toMatchObject({status:"partial",mode:"method",comparisonPolicyId:"method-v1"});
  expect(capabilities.runner.available).toBe(true);
  const made = await request.post("/api/v1/projects", { headers: await headers(request), data: { name: "Exception contract boundary " + crypto.randomUUID() } });
  expect(made.status()).toBe(201);
  const base = "/api/v1/projects/" + (await made.json()).data.id;
  const saved = await request.post(base + "/revisions", { headers: await headers(request, "empty"), data: { files: [{ path: "Main.java", content: source }], intent: "semantic_edit" } });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  const unsupported = await request.post(base + "/test-suites", { headers: await headers(request), data: { mode: "method", entryPoint: "Main", comparisonPolicyId: "exact-v1", cases } });
  expect(unsupported.status()).toBe(422);
  expect((await unsupported.json()).error.code).toBe("UNSUPPORTED_CONSTRUCT");
  expect((await head(request, base)).id).toBe(original.id);
  const analyzing = await request.post(base + "/revisions/" + original.id + "/analysis", { headers: await headers(request), data: {} });
  expect(analyzing.status()).toBe(202);
  await finished(request, base, (await analyzing.json()).data.id);
  const analysis = (await (await request.get(base + "/revisions/" + original.id + "/analysis")).json()).data;
  expect(analysis.parseStatus).toBe("valid");
  const nodes = analysis.graph.nodes.filter((node: any) => node.kind === "expression" && node.sourceRange?.filePath === "Main.java" && source.slice(node.sourceRange.startOffset, node.sourceRange.endOffset) === "10");
  expect(nodes).toHaveLength(1);
  const node = nodes[0];
  expect(node.allowedOperations).toContain("replace_expression");
  const pending = await request.post(base + "/changes", { headers: await headers(request), data: {
    baseRevisionId: original.id, analysisId: analysis.id, methodId: node.methodId, nodeId: node.id,
    operation: "replace_expression", payload: { field: "expression", source: "5 + 5" }, intent: "preserve_behavior",
  } });
  expect(pending.status()).toBe(202);
  const queued = (await pending.json()).data;
  await finished(request, base, queued.jobId);
  const proposal = (await (await request.get(base + "/changes/" + queued.id)).json()).data;
  expect(proposal.checks.compileStatus, JSON.stringify(proposal)).toBe("passed");
  expect(proposal.diff).toHaveLength(1);
  const candidate = (await (await request.get(base + "/revisions/" + proposal.candidateRevisionId)).json()).data;
  expect(candidate.files[0].canonicalText).toBe(source.slice(0, node.sourceRange.startOffset) + "(5 + 5)" + source.slice(node.sourceRange.endOffset));
  const suite = await request.post(base + "/test-suites", { headers: await headers(request), data: { mode: "console", entryPoint: "Main", comparisonPolicyId: "exact-v1", cases } });
  expect(suite.status()).toBe(201);
  const submitted = await request.post(base + "/comparisons", { headers: await headers(request), data: {
    baseRevisionId: original.id, candidateRevisionId: candidate.id, suiteVersionId: (await suite.json()).data.id, profileId: "java21-v1",
  } });
  expect(submitted.status()).toBe(202);
  const job = await finished(request, base, (await submitted.json()).data.id);
  const report = job.result.report ?? (await (await request.get(base + "/comparisons/" + job.result.comparisonId)).json()).data;
  await info.attach("actual-console-exception-report", { body: JSON.stringify({ original, candidate, analysis, proposal, report, methodModeHttpStatus: unsupported.status(), scope: "Console adapter only; exact-v1 cannot be relabeled method-v1" }), contentType: "application/json" });
  expect(report.outcome, JSON.stringify(report)).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.observedRepeatCounts).toEqual({ base: 9, candidate: 9 });
  expect(report.testResults).toHaveLength(3);
  for (const result of report.testResults) {
    const oracle = cases.find(item => item.id === result.input.id)!;
    expect(oracle).toBeTruthy();
    expect(result.baseExecutions).toHaveLength(3);
    expect(result.candidateExecutions).toHaveLength(3);
    for (const observed of [...result.baseExecutions, ...result.candidateExecutions]) {
      const runtime = observed.runtimeExecution ?? observed;
      expect(runtime).toMatchObject({ outcome: "exited", exitCode: 0, stdoutUtf8: oracle.expectedStdout, stderrUtf8: "", cleanupPending: false });
    }
  }
  expect((await head(request, base)).id).toBe(original.id);
  expect((await (await request.get(base + "/revisions/" + original.id)).json()).data).toEqual(original);
});
