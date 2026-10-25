import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers } from "./fileFixtures";

// Independently authored regression: the user's imported file stays private.
const source = `public class Main {
  public static void main(String[] args) { System.out.println(score(6)); }
  static int score(int limit) {
    int total = 0;
    for (int next = 0; next <= limit; next++) {
      if (next % 2 != 0) continue;
      total += next;
    }
    return total;
  }
  static boolean evaluated(int value) {
    boolean result = value > 0 && gate(value);
    return result;
  }
  static boolean gate(int value) { return value != 4; }
}
`;

async function finished(request: APIRequestContext, base: string, id: string) {
  let result: any;
  await expect
    .poll(
      async () => {
        const response = await request.get(base + "/jobs/" + id);
        expect(response.ok()).toBe(true);
        result = (await response.json()).data;
        return result.status;
      },
      { timeout: 180000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(result.status, JSON.stringify(result)).toBe("succeeded");
  return result;
}

test("call-only entry keeps helper CFG separate and declares expression flow partial", async ({
  request,
}) => {
  test.setTimeout(240000);
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Method graph abstraction " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const base = "/api/v1/projects/" + (await created.json()).data.id;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [{ path: "Main.java", content: source }],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const revision = (await saved.json()).data;
  const started = await request.post(
    base + "/revisions/" + revision.id + "/analysis",
    { headers: await headers(request), data: {} },
  );
  expect(started.status()).toBe(202);
  await finished(request, base, (await started.json()).data.id);
  const response = await request.get(
    base + "/revisions/" + revision.id + "/analysis",
  );
  expect(response.ok()).toBe(true);
  const analysis = (await response.json()).data;
  expect(analysis.diagnostics).toEqual([]);
  const graph = analysis.graph;
  expect(graph.methods.map((method: any) => method.signature)).toEqual([
    "main(String[])",
    "score(int)",
    "evaluated(int)",
    "gate(int)",
  ]);
  const method = (name: string) =>
    graph.methods.find((value: any) => value.signature.startsWith(name + "("));
  const nodes = (name: string) =>
    graph.nodes.filter((node: any) => node.methodId === method(name).id);
  const edges = (name: string) => {
    const ids = new Set(nodes(name).map((node: any) => node.id));
    return graph.edges.filter((edge: any) => ids.has(edge.source));
  };
  expect(
    nodes("main").filter((node: any) => node.kind === "ExpressionStmt"),
  ).toHaveLength(1);
  expect(edges("main").every((edge: any) => edge.kind === "normal")).toBe(true);
  expect(
    nodes("main").some((node: any) => node.kind === "condition_test"),
  ).toBe(false);
  expect(
    nodes("score").filter((node: any) => node.kind === "condition_test"),
  ).toHaveLength(2);
  expect(edges("score").map((edge: any) => edge.kind)).toEqual(
    expect.arrayContaining(["true", "false", "continue", "loop", "return"]),
  );
  for (const name of ["main", "score", "evaluated", "gate"]) {
    expect(method(name).sourceRange.filePath).toBe("Main.java");
    expect(nodes(name).some((node: any) => node.kind === "opaque")).toBe(false);
  }
  expect(
    nodes("evaluated").some((node: any) => node.kind === "condition_test"),
  ).toBe(false);
  const flow = analysis.coverage.find(
    (entry: any) => entry.feature === "control_flow",
  );
  expect(flow.status).toBe("partial");
  expect(flow.reason).toMatch(/expressions.*atomic/i);
  const conditions = analysis.coverage.find(
    (entry: any) => entry.feature === "condition_flow",
  );
  expect(conditions.status).toBe("partial");
  expect(conditions.reason).toMatch(/if\/while\/do\/for conditions/);

  const run = await request.post(base + "/runs", {
    headers: await headers(request),
    data: {
      revisionId: revision.id,
      entryPoint: "Main",
      profileId: "java21-v1",
      stdinUtf8: "",
      argv: [],
    },
  });
  expect(run.status()).toBe(202);
  const result = await finished(request, base, (await run.json()).data.id);
  const execution = result.result.report.runtimeExecution;
  expect(execution.outcome).toBe("exited");
  expect(execution.exitCode).toBe(0);
  expect(execution.stdoutUtf8).toBe("12\n");
  expect(execution.stderrUtf8).toBe("");
  expect(execution.truncated).toBe(false);
});
