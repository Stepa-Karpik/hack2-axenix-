import { createHash } from "node:crypto";
import {
  test,
  expect,
  type APIRequestContext,
  type TestInfo,
} from "@playwright/test";
import { headers, head } from "./fileFixtures";

// Controlled probes of the fixed Docker profile. The test process never
// compiles or executes fixture Java, invokes a shell, or selects host fallback.
const programs = {
  policy: `import java.nio.file.*;
public class Main {
  public static void main(String[] args) throws Exception {
    String memory = Files.readString(Path.of("/sys/fs/cgroup/memory.max")).trim();
    String swap = Files.readString(Path.of("/sys/fs/cgroup/memory.swap.max")).trim();
    String pids = Files.readString(Path.of("/sys/fs/cgroup/pids.max")).trim();
    System.out.println(memory + ":" + swap + ":" + pids);
  }
}\n`,
  heap: `public class Main {
  public static void main(String[] args) {
    System.out.print(new byte[300 * 1024 * 1024].length);
  }
}\n`,
  output: `import java.util.Arrays;
public class Main {
  public static void main(String[] args) throws Exception {
    byte[] out = new byte[8192];
    byte[] err = new byte[8192];
    Arrays.fill(out, (byte) 'O');
    Arrays.fill(err, (byte) 'E');
    while (true) {
      System.out.write(out);
      System.err.write(err);
    }
  }
}\n`,
  nondeterministic: `public class Main {
  public static void main(String[] args) {
    System.out.println(System.nanoTime());
  }
}\n`,
  exit: `public class Main {
  public static void main(String[] args) {
    System.out.print("deliberate-output\\n");
    System.err.print("deliberate-error\\n");
    System.exit(2);
  }
}\n`,
};
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
      { timeout: 180000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}
async function ownPair(
  request: APIRequestContext,
  name: keyof typeof programs,
) {
  const capabilities = (
    await (await request.get("/api/v1/capabilities")).json()
  ).data;
  expect(
    capabilities.runner.available,
    "Real enforcing Docker runner required; unavailable is not accepted evidence",
  ).toBe(true);
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Runtime acceptance " + name + " " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const base = "/api/v1/projects/" + (await made.json()).data.id;
  const save = async (text: string, previous: string) => {
    const response = await request.post(base + "/revisions", {
      headers: await headers(request, previous),
      data: {
        files: [{ path: "Main.java", content: text }],
        intent: "semantic_edit",
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const source = programs[name];
  const original = await save(source, "empty");
  // Distinct immutable sources with identical executable behavior. This suite
  // tests runtime classification, not source/graph editing capability.
  const candidateSource = source + "// runtime comparison candidate\n";
  const candidate = await save(candidateSource, original.id);
  return { base, original, candidate, source, candidateSource };
}
async function compare(
  request: APIRequestContext,
  pair: Awaited<ReturnType<typeof ownPair>>,
  oracle: Record<string, unknown> = {},
) {
  const created = await request.post(pair.base + "/test-suites", {
    headers: await headers(request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: [
        {
          id: "probe",
          name: "Fixed-policy probe",
          stdinUtf8: "",
          argv: [],
          ...oracle,
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const suite = (await created.json()).data;
  const started = await request.post(pair.base + "/comparisons", {
    headers: await headers(request),
    data: {
      baseRevisionId: pair.original.id,
      candidateRevisionId: pair.candidate.id,
      suiteVersionId: suite.id,
      profileId: "java21-v1",
    },
  });
  expect(started.status()).toBe(202);
  const job = await finished(
    request,
    pair.base,
    (await started.json()).data.id,
  );
  const report =
    job.result.report ??
    (
      await (
        await request.get(pair.base + "/comparisons/" + job.result.comparisonId)
      ).json()
    ).data;
  expect(report.executionProfileId).toBe("java21-v1");
  expect(report.executionProfileHash).toMatch(/^[0-9a-f]{64}$/);
  expect(report.plannedRepeatCount).toBe(3);
  expect(report.observedRepeatCounts).toEqual({ base: 3, candidate: 3 });
  expect(report.testResults).toHaveLength(1);
  const result = report.testResults[0];
  expect(result.baseExecutions).toHaveLength(3);
  expect(result.candidateExecutions).toHaveLength(3);
  const observations = [
    ...result.baseExecutions,
    ...result.candidateExecutions,
  ].map((observation: any) => observation.runtimeExecution ?? observation);
  expect(
    new Set(observations.map((observation: any) => observation.id)).size,
  ).toBe(6);
  for (const observation of observations) {
    expect(observation.phase).toBe("runtime");
    expect(observation.cleanupPending).toBe(false);
    expect(observation.specHash).toMatch(/^[0-9a-f]{64}$/);
  }
  expect((await head(request, pair.base)).id).toBe(pair.candidate.id);
  const original = (
    await (
      await request.get(pair.base + "/revisions/" + pair.original.id)
    ).json()
  ).data;
  const candidate = (
    await (
      await request.get(pair.base + "/revisions/" + pair.candidate.id)
    ).json()
  ).data;
  expect(original.files[0].canonicalText).toBe(pair.source);
  expect(candidate.files[0].canonicalText).toBe(pair.candidateSource);
  const after = (await (await request.get("/api/v1/capabilities")).json()).data;
  expect(
    after.runner.available,
    "Controller remains available after probe cleanup",
  ).toBe(true);
  return { report, result, observations };
}
async function evidence(
  info: TestInfo,
  name: string,
  pair: Awaited<ReturnType<typeof ownPair>>,
  result: Awaited<ReturnType<typeof compare>>,
) {
  // Raw large streams remain in server artifacts. Retain references/hashes and
  // lengths here without duplicating six MiB of output-limit streams.
  const summarize = (observation: any) => {
    const { stdoutUtf8, stderrUtf8, ...metadata } = observation;
    return {
      ...metadata,
      stdoutBytes: Buffer.byteLength(stdoutUtf8 ?? "", "utf8"),
      stderrBytes: Buffer.byteLength(stderrUtf8 ?? "", "utf8"),
      stdoutSha256: hash(stdoutUtf8 ?? ""),
      stderrSha256: hash(stderrUtf8 ?? ""),
    };
  };
  await info.attach(name, {
    body: JSON.stringify({
      source: pair.source,
      sourceSha256: hash(pair.source),
      baseRevisionId: pair.original.id,
      candidateRevisionId: pair.candidate.id,
      executionProfileId: result.report.executionProfileId,
      executionProfileHash: result.report.executionProfileHash,
      outcome: result.report.outcome,
      coverageComplete: result.report.coverageComplete,
      inconclusiveReasons: result.report.inconclusiveReasons,
      plannedRepeatCount: result.report.plannedRepeatCount,
      observedRepeatCounts: result.report.observedRepeatCounts,
      observations: result.observations.map(summarize),
    }),
    contentType: "application/json",
  });
}

test("fixed Docker cgroup policy exposes memory, swap and PID ceilings without resource exhaustion", async ({
  request,
}, info) => {
  test.setTimeout(240000);
  const pair = await ownPair(request, "policy");
  // Independent expectation from fixed Docker template, read inside sandbox.
  const expected = "536870912:0:128\n";
  const result = await compare(request, pair, {
    expectedExitCode: 0,
    expectedStdout: expected,
    expectedStderr: "",
  });
  await evidence(info, "fixed-cgroup-policy", pair, result);
  expect(result.report.outcome).toBe("matched_on_tests");
  for (const observation of result.observations) {
    expect(observation.outcome).toBe("exited");
    expect(observation.exitCode).toBe(0);
    expect(observation.stdoutUtf8).toBe(expected);
    expect(observation.stderrUtf8).toBe("");
  }
});
test("oversized Java heap allocation is an ordinary nonzero JVM exit, not a fabricated cgroup OOM kill", async ({
  request,
}, info) => {
  test.setTimeout(240000);
  const pair = await ownPair(request, "heap");
  const result = await compare(request, pair);
  await evidence(info, "heap-error-distinct-from-cgroup-oom", pair, result);
  expect(result.report.outcome).toBe("inconclusive");
  expect(result.report.coverageComplete).toBe(false);
  expect(result.report.inconclusiveReasons).toContain("nonzero_without_oracle");
  expect(result.report.inconclusiveReasons).not.toContain("memory_limit");
  for (const observation of result.observations) {
    expect(observation.outcome).toBe("exited");
    expect(observation.exitCode).toBe(1);
    expect(observation.stdoutUtf8).toBe("");
    expect(observation.stderrUtf8).toContain(
      "java.lang.OutOfMemoryError: Java heap space",
    );
    expect(observation.truncated).toBe(false);
  }
  // Proves JVM heap ceiling/classifier, not cgroup OOM or PID exhaustion.
});
test("combined stdout and stderr without newlines stop at the fixed output ceiling and never match", async ({
  request,
}, info) => {
  test.setTimeout(240000);
  const pair = await ownPair(request, "output");
  const result = await compare(request, pair);
  await evidence(info, "bounded-no-newline-output", pair, result);
  expect(result.report.outcome).toBe("inconclusive");
  expect(result.report.coverageComplete).toBe(false);
  expect(result.report.inconclusiveReasons).toContain("output_limit");
  for (const observation of result.observations) {
    expect(observation.outcome).toBe("output_limit");
    expect(observation.exitCode).toBeNull();
    expect(observation.truncated).toBe(true);
    const out = Buffer.byteLength(observation.stdoutUtf8, "utf8");
    const err = Buffer.byteLength(observation.stderrUtf8, "utf8");
    expect(out).toBeGreaterThan(0);
    expect(err).toBeGreaterThan(0);
    expect(out + err).toBeLessThanOrEqual(1024 * 1024);
    expect(observation.stdoutUtf8).toMatch(/^O+$/);
    expect(observation.stderrUtf8).toMatch(/^E+$/);
  }
});
test("three real observations of nanoTime on each revision expose nondeterminism", async ({
  request,
}, info) => {
  test.setTimeout(240000);
  const pair = await ownPair(request, "nondeterministic");
  const result = await compare(request, pair);
  await evidence(info, "real-nanotime-nondeterminism", pair, result);
  expect(result.report.outcome).toBe("inconclusive");
  expect(result.report.coverageComplete).toBe(false);
  expect(result.report.inconclusiveReasons).toContain("nondeterministic");
  for (const side of [
    result.result.baseExecutions,
    result.result.candidateExecutions,
  ]) {
    expect(
      new Set(side.map((observation: any) => observation.stdoutUtf8)).size,
    ).toBeGreaterThan(1);
  }
  for (const observation of result.observations) {
    expect(observation.outcome).toBe("exited");
    expect(observation.exitCode).toBe(0);
    expect(observation.stdoutUtf8).toMatch(/^-?\d+\n$/);
    expect(observation.stderrUtf8).toBe("");
    expect(observation.truncated).toBe(false);
  }
});
test("deliberate exit two matches an exact error oracle and stays inconclusive without that oracle", async ({
  request,
}, info) => {
  test.setTimeout(360000);
  const pair = await ownPair(request, "exit");
  const expected = {
    expectedExitCode: 2,
    expectedStdout: "deliberate-output\n",
    expectedStderr: "deliberate-error\n",
  };
  const withOracle = await compare(request, pair, expected);
  await evidence(info, "exit-two-explicit-oracle", pair, withOracle);
  expect(withOracle.report.outcome).toBe("matched_on_tests");
  expect(withOracle.report.coverageComplete).toBe(true);
  const withoutOracle = await compare(request, pair);
  await evidence(info, "exit-two-no-oracle", pair, withoutOracle);
  expect(withoutOracle.report.outcome).toBe("inconclusive");
  expect(withoutOracle.report.coverageComplete).toBe(false);
  expect(withoutOracle.report.inconclusiveReasons).toContain(
    "nonzero_without_oracle",
  );
  for (const observation of [
    ...withOracle.observations,
    ...withoutOracle.observations,
  ]) {
    expect(observation.outcome).toBe("exited");
    expect(observation.exitCode).toBe(2);
    expect(observation.stdoutUtf8).toBe(expected.expectedStdout);
    expect(observation.stderrUtf8).toBe(expected.expectedStderr);
    expect(observation.truncated).toBe(false);
  }
});
