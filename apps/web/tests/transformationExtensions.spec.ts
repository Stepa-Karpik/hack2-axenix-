import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// These source fixtures are compiled/executed exclusively by the isolated runner.
async function completed(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect.poll(async () => {
    job = (await (await request.get(base + "/jobs/" + id)).json()).data;
    return job.status;
  }, { timeout: 240000 }).toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}

async function verify(request: APIRequestContext, info: any, source: string, operation: string,
                      methodName: string, payload: object, cases: any[], expectedChanges: number,
                      target?: { anchor: string; expression: string }) {
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request), data: { name: "Transformation extension " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const base = "/api/v1/projects/" + (await created.json()).data.id;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: { files: [{ path: "Main.java", content: source }], intent: "semantic_edit" },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  const analysisRequest = await request.post(base + "/revisions/" + original.id + "/analysis", {
    headers: await headers(request), data: {},
  });
  expect(analysisRequest.status()).toBe(202);
  await completed(request, base, (await analysisRequest.json()).data.id);
  let analysis: any;
  await expect.poll(async () => {
    analysis = (await (await request.get(base + "/revisions/" + original.id + "/analysis")).json()).data;
    return analysis?.parseStatus;
  }).toBe("valid");
  const method = analysis.graph.methods.find((item: any) => item.signature.startsWith(methodName + "("));
  const targetStart = target ? source.indexOf(target.expression, source.indexOf(target.anchor)) : -1;
  const nodeId = target ? analysis.graph.nodes.find((node: any) => node.kind === "expression"
      && node.sourceRange.startOffset === targetStart && node.sourceRange.endOffset === targetStart + target.expression.length).id
    : operation === "optimize_membership" ? analysis.optimizations[0].nodeId : method.entryNodeId;
  const pending = await request.post(base + "/changes", {
    headers: await headers(request),
    data: { baseRevisionId: original.id, analysisId: analysis.id, methodId: method.id, nodeId,
      operation, payload, intent: "preserve_behavior" },
  });
  expect(pending.status()).toBe(202);
  const change = (await pending.json()).data;
  await completed(request, base, change.jobId);
  const proposal = (await (await request.get(base + "/changes/" + change.id)).json()).data;
  expect(proposal.checks.compileStatus).toBe("passed");
  expect(proposal.diff).toHaveLength(expectedChanges);
  expect((await head(request, base)).id).toBe(original.id);
  // Exact behavior approval remains unavailable until a matching independent suite exists.
  const premature = await request.post(base + "/head", {
    headers: await headers(request, original.id),
    data: { expectedHeadRevisionId: original.id, proposalId: change.id, candidateRevisionId: proposal.candidateRevisionId },
  });
  expect(premature.status()).toBeGreaterThanOrEqual(400);
  const suite = await request.post(base + "/test-suites", {
    headers: await headers(request),
    data: { mode: "console", entryPoint: "Main", comparisonPolicyId: "exact-v1",
      cases: cases.map((item, index) => ({ id: "extension-" + index, stdinUtf8: "", expectedStderr: "", expectedExitCode: 0, ...item })) },
  });
  expect(suite.status()).toBe(201);
  const comparison = await request.post(base + "/comparisons", {
    headers: await headers(request),
    data: { baseRevisionId: original.id, candidateRevisionId: proposal.candidateRevisionId,
      suiteVersionId: (await suite.json()).data.id, profileId: "java21-v1" },
  });
  expect(comparison.status()).toBe(202);
  const report = (await completed(request, base, (await comparison.json()).data.id)).result.report;
  expect(report).toMatchObject({ outcome: "matched_on_tests", coverageComplete: true, matched: cases.length });
  for (const row of report.testResults) {
    expect(row.baseExecutions).toHaveLength(3);
    expect(row.candidateExecutions).toHaveLength(3);
  }
  const applied = await request.post(base + "/head", {
    headers: await headers(request, original.id),
    data: { expectedHeadRevisionId: original.id, proposalId: change.id,
      candidateRevisionId: proposal.candidateRevisionId, verificationReportId: report.id },
  });
  expect(applied.ok()).toBe(true);
  expect((await head(request, base)).id).toBe(proposal.candidateRevisionId);
  await info.attach("extension-verification", { body: JSON.stringify({ operation, original: original.id, proposal, report }), contentType: "application/json" });
}

test("LinkedList interface integer membership preserves null duplicates bounds and query order", async ({ request }, info) => {
  test.setTimeout(420000);
  await verify(request, info, `public class Main {
    public static void main(String[] args) {
      java.util.List<Integer> allowed = new java.util.LinkedList<>();
      allowed.add(1); allowed.add(-2); allowed.add(null); allowed.add(1);
      for(String raw:args) {
        Integer query = raw.equals("null") ? null : Integer.valueOf(raw);
        System.out.println(query+":"+allowed.contains(query));
      }
    }
  }`, "optimize_membership", "main", {}, [
    { argv: [], expectedStdout: "" },
    { argv: ["1", "-2", "0"], expectedStdout: "1:true\n-2:true\n0:false\n" },
    { argv: ["null", "1", "null", "2147483647", "-2147483648"], expectedStdout: "null:true\n1:true\nnull:true\n2147483647:false\n-2147483648:false\n" },
  ], 1);
});

test("instance pricing responsibility moves transitive private helpers with original dispatch retained", async ({ request }, info) => {
  test.setTimeout(420000);
  await verify(request, info, `public class Main {
    int unrelatedState=91;
    public static void main(String[] args) { Main instance=new Main(); System.out.println(instance.total(Integer.parseInt(args[0]),Long.parseLong(args[1]))+":"+instance.unrelatedState); }
    public long total(int quantity,long price) { return subtotal(quantity,price)+fee(quantity); }
    private static long subtotal(int quantity,long price) { return clamp(quantity)*price; }
    private static int clamp(int quantity) { return quantity<0 ? 0 : quantity; }
    private static long fee(int quantity) { return clamp(quantity)>3 ? 2L : 0L; }
  }`, "decompose_class", "total", { className: "Pricing" }, [
    { argv: ["-3", "20"], expectedStdout: "0:91\n" },
    { argv: ["0", "7"], expectedStdout: "0:91\n" },
    { argv: ["3", "11"], expectedStdout: "33:91\n" },
    { argv: ["4", "11"], expectedStdout: "46:91\n" },
    { argv: ["4", "3000000000"], expectedStdout: "12000000002:91\n" },
  ], 5);
});

test("typed array-index edit preserves jagged aliases null and bounds exceptions", async ({ request }, info) => {
  test.setTimeout(420000);
  await verify(request, info, `public class Main {
    public static void main(String[] args) {
      int[][] values = args[0].equals("null") ? null : new int[][]{{3,4},{8}};
      try { System.out.println(at(values,Integer.parseInt(args[1]))); }
      catch(NullPointerException failure) { System.out.println("null"); }
      catch(ArrayIndexOutOfBoundsException failure) { System.out.println("bounds"); }
    }
    static int at(int[][] values,int index) { int[][] alias=values; return alias[index][0]; }
  }`, "replace_expression", "at", { field: "expression", source: "index + 0" }, [
    { argv: ["array", "0"], expectedStdout: "3\n" },
    { argv: ["array", "1"], expectedStdout: "8\n" },
    { argv: ["array", "-1"], expectedStdout: "bounds\n" },
    { argv: ["array", "2"], expectedStdout: "bounds\n" },
    { argv: ["null", "0"], expectedStdout: "null\n" },
  ], 1, { anchor: "return alias[", expression: "index" });
});

test("typed case literal edit rebuilds dispatch while preserving fallthrough and default", async ({ request }, info) => {
  test.setTimeout(420000);
  await verify(request, info, `public class Main {
    public static void main(String[] args) { System.out.println(select(Integer.parseInt(args[0]))); }
    static int select(int value) { int total=0; switch(value) { case 1:total++;case 2:total+=2;break;default:total=-1; } return total; }
  }`, "replace_expression", "select", { field: "expression", source: "0x1" }, [
    { argv: ["1"], expectedStdout: "3\n" },
    { argv: ["2"], expectedStdout: "2\n" },
    { argv: ["0"], expectedStdout: "-1\n" },
  ], 1, { anchor: "case ", expression: "1" });
});
