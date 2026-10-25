import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// Instance targets: a fresh receiver per case through the accessible no-arg constructor.
// All compilation/invocation happens in the isolated Linux runner, never on the host.
const source = `public class Counter {
  static { System.out.print("static;"); }
  private int n = log("field;", 5);
  { System.out.print("block;"); }
  public Counter() { System.out.print("ctor;"); }
  static int log(String text, int value) { System.out.print(text); return value; }
  public int add(int x) { n += x; return n; }
  public void fill(int[] values) { for (int i = 0; i < values.length; i++) values[i] = n + i; }
}
`;
const broken = `public class Broken {
  public Broken() { throw new IllegalStateException("ctor"); }
  public int value() { return 1; }
}
`;
const oracle = (returnValue: unknown, argumentsAfter: unknown[]) => ({
  complete: true,
  completion: "return",
  returnValue,
  exception: null,
  argumentsAfter,
});
async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect
    .poll(async () => {
      job = (await (await request.get(base + "/jobs/" + id)).json()).data;
      return job.status;
    }, { timeout: 300000 })
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}
async function fixture(request: APIRequestContext) {
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Native instance methods " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const base = "/api/v1/projects/" + (await made.json()).data.id;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [
        { path: "Counter.java", content: source },
        { path: "Broken.java", content: broken },
      ],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  return { base, revision: (await saved.json()).data };
}
async function compare(
  request: APIRequestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  ownerType: string,
  methodName: string,
  parameterTypes: string[],
  cases: any[],
) {
  const created = await request.post(f.base + "/test-suites", {
    headers: await headers(request),
    data: {
      mode: "method",
      comparisonPolicyId: "method-v1",
      revisionId: f.revision.id,
      target: { ownerType, methodName, parameterTypes },
      cases: cases.map((row) => ({ expectedStderr: "", ...row })),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const suite = (await created.json()).data;
  const submitted = await request.post(f.base + "/comparisons", {
    headers: await headers(request),
    data: {
      baseRevisionId: f.revision.id,
      candidateRevisionId: f.revision.id,
      suiteVersionId: suite.id,
      profileId: "java21-v1",
    },
  });
  expect(submitted.status()).toBe(202);
  const job = await finished(request, f.base, (await submitted.json()).data.id);
  return job.result.report;
}

test("instance methods run on a fresh receiver per case with declared initialization output", async ({ request }, info) => {
  test.setTimeout(420000);
  const f = await fixture(request);
  const discovery = await request.get(f.base + "/revisions/" + f.revision.id + "/method-targets");
  const targets = (await discovery.json()).data.targets;
  expect(targets.find((t: any) => t.methodName === "add")).toMatchObject({ supported: true, receiver: "fresh_no_arg_instance" });
  // Each JVM: static init once, then field initializer, instance block, constructor body.
  const init = "static;field;block;ctor;";
  const cases = [
    { id: "add-3", arguments: [3], expectedStdout: init, expectedMethodResult: oracle(8, [3]) },
    // A shared receiver would return 12; a fresh one returns 9.
    { id: "add-4", arguments: [4], expectedStdout: init, expectedMethodResult: oracle(9, [4]) },
  ];
  await info.attach("pre-execution-instance-contract", { body: JSON.stringify({ source, cases }), contentType: "application/json" });
  const report = await compare(request, f, "Counter", "add", ["int"], cases);
  await info.attach("actual-instance-report", { body: JSON.stringify(report), contentType: "application/json" });
  if (report.outcome !== "matched_on_tests")
    console.log("instance report", JSON.stringify({ ...report, testResults: undefined }).slice(0, 3000));
  expect(report).toMatchObject({ mode: "method", outcome: "matched_on_tests", coverageComplete: true, observedRepeatCounts: { base: 6, candidate: 6 } });
  for (const row of report.testResults) {
    const contract = cases.find((c) => c.id === row.caseId)!;
    for (const observed of [...row.baseExecutions, ...row.candidateExecutions])
      expect(observed).toMatchObject({ outcome: "exited", exitCode: 0, stdoutUtf8: contract.expectedStdout, stderrUtf8: "", methodResult: contract.expectedMethodResult });
  }
  const filled = await compare(request, f, "Counter", "fill", ["int[]"], [
    { id: "fill", arguments: [[0, 0, 0]], expectedStdout: init, expectedMethodResult: oracle(null, [[5, 6, 7]]) },
  ]);
  expect(filled.outcome).toBe("matched_on_tests");
  expect((await head(request, f.base)).id).toBe(f.revision.id);
});

test("a throwing receiver constructor is incomplete, never a matched method result", async ({ request }, info) => {
  test.setTimeout(420000);
  const f = await fixture(request);
  const report = await compare(request, f, "Broken", "value", [], [{ id: "ctor-fails", arguments: [], expectedStdout: "" }]);
  await info.attach("actual-constructor-failure-report", { body: JSON.stringify(report), contentType: "application/json" });
  expect(report.outcome).toBe("inconclusive");
  expect(report.coverageComplete).toBe(false);
  expect(report.inconclusiveReasons).toContain("method_result_missing_or_incomplete");
});
