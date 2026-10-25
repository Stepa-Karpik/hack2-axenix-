import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

async function done(request: APIRequestContext, base: string, id: string) {
  let value: any;
  await expect
    .poll(
      async () => {
        const response = await request.get(base + "/jobs/" + id);
        expect(response.ok()).toBe(true);
        value = (await response.json()).data;
        return value.status;
      },
      { timeout: 240000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(value.status, JSON.stringify(value)).toBe("succeeded");
  return value;
}

const closeSource = `public class Main {
  public static void main(String[] args) {
    R.mode = Integer.parseInt(args[0]);
    try {
      try (R resource = new R()) { System.out.print("body;"); }
    } catch (java.io.IOException error) { System.out.print("catch=" + error.getMessage() + ";"); }
    System.out.println("end");
  }
}
class R implements AutoCloseable {
  static int mode;
  R() { System.out.print("open;"); }
  public void close() throws java.io.IOException {
    System.out.print("close;");
    if (mode != 0) throw new java.io.IOException("close" + mode);
  }
}\n`;
const acquireSource = `public class Main {
  public static void main(String[] args) {
    R.mode = Integer.parseInt(args[0]);
    try (R first = new R("A"); R second = new R("B")) {
      System.out.print("body;");
    } catch (java.io.IOException error) { System.out.print("catch=" + error.getMessage() + ";"); }
    System.out.println("end");
  }
}
class R implements AutoCloseable {
  static int mode;
  final String label;
  R(String label) throws java.io.IOException {
    System.out.print("open" + label + ";");
    if ((mode == 1 && label.equals("A")) || (mode == 2 && label.equals("B")))
      throw new java.io.IOException("acquire" + label);
    this.label = label;
  }
  public void close() { System.out.print("close" + label + ";"); }
}\n`;

// All expected traces are fixed before proposal/runner results. In the first fixture
// only implicit close carries IOException, so an unrelated explicit throw cannot mask
// the missing inference. The second checks partial acquisition cleanup and reverse close.
const scenarios = [
  {
    name: "implicit checked close escapes to the caller catch",
    source: closeSource,
    marker: "try (R resource",
    throwsIOException: true,
    stdout: [
      "open;body;close;end\n",
      "open;body;close;catch=close1;end\n",
      "open;body;close;catch=close2;end\n",
    ],
  },
  {
    name: "whole resource try handles acquisition exceptions internally",
    source: acquireSource,
    marker: "try (R first",
    throwsIOException: false,
    stdout: [
      "openA;openB;body;closeB;closeA;end\n",
      "openA;catch=acquireA;end\n",
      "openA;openB;closeA;catch=acquireB;end\n",
    ],
  },
];

for (const scenario of scenarios)
  test(scenario.name, async ({ request }, info) => {
    test.setTimeout(300000);
    const cases = scenario.stdout.map((expectedStdout, index) => ({
      id: "mode-" + index,
      name: "Mode " + index,
      argv: [String(index)],
      stdinUtf8: "",
      expectedExitCode: 0,
      expectedStdout,
      expectedStderr: "",
    }));
    const made = await request.post("/api/v1/projects", {
      headers: await headers(request),
      data: { name: "Resource extraction " + crypto.randomUUID() },
    });
    expect(made.status()).toBe(201);
    const projectId = (await made.json()).data.id,
      base = "/api/v1/projects/" + projectId;
    const saved = await request.post(base + "/revisions", {
      headers: await headers(request, "empty"),
      data: {
        files: [
          { path: "Main.java", content: scenario.source },
          { path: "notes.txt", content: "keep café\n" },
        ],
        intent: "semantic_edit",
      },
    });
    expect(saved.status()).toBe(201);
    const original = (await saved.json()).data;
    const started = await request.post(
      base + "/revisions/" + original.id + "/analysis",
      {
        headers: await headers(request),
        data: {},
      },
    );
    expect(started.status()).toBe(202);
    await done(request, base, (await started.json()).data.id);
    const analyzed = await request.get(
      base + "/revisions/" + original.id + "/analysis",
    );
    expect(analyzed.ok()).toBe(true);
    const analysis = (await analyzed.json()).data;
    const node = analysis.graph.nodes.find(
      (n: any) =>
        n.kind === "try_entry" &&
        n.sourceRange?.filePath === "Main.java" &&
        n.sourceRange?.startOffset === scenario.source.indexOf(scenario.marker),
    );
    expect(node).toBeTruthy();
    expect(node.allowedOperations).toContain("extract_method");
    const changed = await request.post(base + "/changes", {
      headers: await headers(request),
      data: {
        baseRevisionId: original.id,
        analysisId: analysis.id,
        methodId: node.methodId,
        nodeId: node.id,
        operation: "extract_method",
        intent: "preserve_behavior",
        payload: { methodName: "extractResources", endNodeId: node.id },
      },
    });
    expect(changed.status()).toBe(202);
    const pending = (await changed.json()).data;
    await done(request, base, pending.jobId);
    const proposal = (
      await (await request.get(base + "/changes/" + pending.id)).json()
    ).data;
    expect(proposal.status, JSON.stringify(proposal)).toBe("ready");
    expect(proposal.checks.compileStatus).toBe("passed");
    expect(proposal.compileExecution.exitCode).toBe(0);
    expect(proposal.compileExecution.stderrUtf8).toBe("");
    const candidate = (
      await (
        await request.get(base + "/revisions/" + proposal.candidateRevisionId)
      ).json()
    ).data;
    const text = candidate.files.find(
      (file: any) => file.path === "Main.java",
    ).canonicalText;
    expect(text).toContain(
      scenario.throwsIOException
        ? "private static void extractResources() throws java.io.IOException"
        : "private static void extractResources() {",
    );
    expect(
      candidate.files.find((file: any) => file.path === "notes.txt")
        .canonicalText,
    ).toBe("keep café\n");
    expect((await head(request, base)).id).toBe(original.id);
    const suite = await request.post(base + "/test-suites", {
      headers: await headers(request),
      data: {
        mode: "console",
        entryPoint: "Main",
        comparisonPolicyId: "exact-v1",
        cases,
      },
    });
    expect(suite.status()).toBe(201);
    const compared = await request.post(base + "/comparisons", {
      headers: await headers(request),
      data: {
        baseRevisionId: original.id,
        candidateRevisionId: proposal.candidateRevisionId,
        suiteVersionId: (await suite.json()).data.id,
        profileId: "java21-v1",
      },
    });
    expect(compared.status()).toBe(202);
    const completed = await done(
      request,
      base,
      (await compared.json()).data.id,
    );
    const report = completed.result.report;
    expect(report).toMatchObject({
      outcome: "matched_on_tests",
      coverageComplete: true,
      matched: 3,
      baseRevisionId: original.id,
      candidateRevisionId: proposal.candidateRevisionId,
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
        expect(execution.exitCode).toBe(0);
        expect(execution.stdoutUtf8).toBe(oracle.expectedStdout);
        expect(execution.stderrUtf8).toBe("");
        expect(execution.truncated).toBe(false);
      }
    }
    expect((await head(request, base)).id).toBe(original.id);
    await info.attach("resource-extraction-independent-oracles", {
      body: JSON.stringify({
        projectId,
        analysisId: analysis.id,
        originalRevisionId: original.id,
        candidateRevisionId: proposal.candidateRevisionId,
        cases,
        report,
      }),
      contentType: "application/json",
    });
  });
