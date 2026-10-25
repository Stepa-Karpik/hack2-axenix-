import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// Untrusted fixture Java executes exclusively in the isolated application runner.
const source = 'public class Main {\n  public static void main(String[] args) {\n    throw new IllegalStateException("Контракт");\n  }\n}\n';
const shifted = source.replace('    throw', '\n    throw');
const stderr = (line: number) => 'Exception in thread "main" java.lang.IllegalStateException: Контракт\n\tat Main.main(Main.java:' + line + ')\n';

async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect.poll(async () => {
    job = (await (await request.get(base + "/jobs/" + id)).json()).data;
    return job.status;
  }, { timeout: 240000 }).toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}

test("uncaught shifted stack traces remain exact stderr mismatches with an oracle and inconclusive without one", async ({ request }, info) => {
  test.setTimeout(480000);
  await info.attach("pre-execution-contract", { body: JSON.stringify({ source, shifted, baseExpectedStderr: stderr(3), candidateExpectedStderr: stderr(4), expectedExitCode: 1, expectedStdout: "" }), contentType: "application/json" });
  expect((await (await request.get("/api/v1/capabilities")).json()).data.runner.available).toBe(true);
  const made = await request.post("/api/v1/projects", { headers: await headers(request), data: { name: "Strict exception contract " + crypto.randomUUID() } });
  expect(made.status()).toBe(201);
  const base = "/api/v1/projects/" + (await made.json()).data.id;
  const save = async (text: string, previous: string) => {
    const response = await request.post(base + "/revisions", { headers: await headers(request, previous), data: { files: [{ path: "Main.java", content: text }], intent: "semantic_edit" } });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const original = await save(source, "empty");
  const candidate = await save(shifted, original.id);
  for (const explicitOracle of [true, false]) {
    const created = await request.post(base + "/test-suites", { headers: await headers(request), data: {
      mode: "console", entryPoint: "Main", comparisonPolicyId: "exact-v1",
      cases: [{ id: "uncaught", argv: [], stdinUtf8: "", ...(explicitOracle ? { expectedExitCode: 1, expectedStdout: "", expectedStderr: stderr(3) } : {}) }],
    } });
    expect(created.status()).toBe(201);
    const submitted = await request.post(base + "/comparisons", { headers: await headers(request), data: {
      baseRevisionId: original.id, candidateRevisionId: candidate.id, suiteVersionId: (await created.json()).data.id, profileId: "java21-v1",
    } });
    expect(submitted.status()).toBe(202);
    const job = await finished(request, base, (await submitted.json()).data.id);
    const report = job.result.report ?? (await (await request.get(base + "/comparisons/" + job.result.comparisonId)).json()).data;
    await info.attach(explicitOracle ? "strict-stacktrace-oracle" : "strict-stacktrace-no-oracle", { body: JSON.stringify({ original, candidate, report }), contentType: "application/json" });
    expect(report.outcome, JSON.stringify(report)).toBe(explicitOracle ? "mismatch" : "inconclusive");
    if (!explicitOracle) expect(report.inconclusiveReasons).toContain("nonzero_without_oracle");
    expect(report.observedRepeatCounts).toEqual({ base: 3, candidate: 3 });
    const result = report.testResults[0];
    for (const [observations, line] of [[result.baseExecutions, 3], [result.candidateExecutions, 4]] as const) {
      expect(observations).toHaveLength(3);
      for (const observed of observations) {
        const runtime = observed.runtimeExecution ?? observed;
        expect(runtime).toMatchObject({ outcome: "exited", exitCode: 1, stdoutUtf8: "", stderrUtf8: stderr(line), cleanupPending: false });
      }
    }
    expect((await head(request, base)).id).toBe(candidate.id);
    expect((await (await request.get(base + "/revisions/" + original.id)).json()).data).toEqual(original);
  }
});
