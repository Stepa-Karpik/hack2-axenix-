import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { panToNode, setTheme } from "./flowAssertions";

const source = readFileSync(
  new URL("../../../fixtures/resources/Main.java", import.meta.url),
  "utf8",
)
  .replace(/^\uFEFF/, "")
  .replace(/\r\n?/g, "\n");
const oracles = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/resources/oracles.json", import.meta.url),
    "utf8",
  ),
);

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
async function fixture(request: APIRequestContext) {
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Resource acceptance " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const projectId = (await made.json()).data.id;
  const base = "/api/v1/projects/" + projectId;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [{ path: "Main.java", content: source }],
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
  await finished(request, base, (await started.json()).data.id);
  const response = await request.get(
    base + "/revisions/" + original.id + "/analysis",
  );
  expect(response.ok()).toBe(true);
  const analysis = (await response.json()).data;
  expect(analysis.analyzerVersion).toBe("engine-0.13.0");
  return { base, projectId, original, analysis };
}
function methodNodes(graph: any, name: string) {
  const method = graph.methods.find((m: any) =>
    m.signature.startsWith(name + "("),
  );
  expect(method, name).toBeTruthy();
  return graph.nodes.filter((n: any) => n.methodId === method.id);
}
function reachable(graph: any, start: string, target: string) {
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(
      ...graph.edges
        .filter((edge: any) => edge.source === id)
        .map((edge: any) => edge.target),
    );
  }
  return false;
}

test("resource protocol preserves source bindings and displays cleanup", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(page.request);
  const graph = f.analysis.graph;
  for (const name of [
    "ordered",
    "nullable",
    "initializer",
    "primary",
    "returning",
    "jumping",
    "nested",
    "existing",
    "selfSuppression",
    "suppressionDisabled",
    "checked",
    "errorPrimary",
  ]) {
    const nodes = methodNodes(graph, name);
    expect(
      nodes.some((n: any) => n.kind === "opaque"),
      name,
    ).toBe(false);
    expect(
      nodes.some((n: any) => n.kind === "try_entry"),
      name,
    ).toBe(true);
  }
  const ordered = methodNodes(graph, "ordered");
  const byId = new Map<string, any>(graph.nodes.map((n: any) => [n.id, n]));
  const outgoing = (id: string) =>
    graph.edges.filter((e: any) => e.source === id);
  const resourceKinds = [
    "resource_init",
    "resource_primary",
    "resource_check",
    "resource_close",
    "resource_suppression_check",
    "resource_suppress",
    "resource_throw",
    "resource_resume",
  ];
  for (const kind of resourceKinds) {
    const nodes = graph.nodes.filter((n: any) => n.kind === kind);
    expect(nodes.length, kind).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.allowedOperations ?? [], kind + " must be read only").toEqual(
        [],
      );
      if (kind === "resource_init") {
        expect(
          node.sourceRange,
          "initializer binds to real source",
        ).toBeTruthy();
        expect(
          source
            .slice(node.sourceRange.startOffset, node.sourceRange.endOffset)
            .trim().length,
        ).toBeGreaterThan(0);
      } else {
        expect(
          node.sourceRange ?? null,
          kind + " must not pretend to be user source",
        ).toBeNull();
      }
    }
  }
  for (const node of graph.nodes.filter(
    (n: any) => n.kind === "resource_check",
  )) {
    const edges = outgoing(node.id);
    expect(
      edges.some(
        (e: any) =>
          e.kind === "true" && byId.get(e.target)?.kind === "resource_close",
      ),
    ).toBe(true);
    expect(edges.some((e: any) => e.kind === "false")).toBe(true);
  }
  for (const node of graph.nodes.filter(
    (n: any) => n.kind === "resource_close",
  )) {
    const edges = outgoing(node.id);
    expect(edges.some((e: any) => e.certainty === "exact")).toBe(true);
    expect(
      edges.some(
        (e: any) =>
          e.kind === "exception" &&
          e.certainty === "conservative" &&
          e.reason?.trim(),
      ),
    ).toBe(true);
  }
  for (const node of graph.nodes.filter(
    (n: any) => n.kind === "resource_suppression_check",
  )) {
    const edges = outgoing(node.id);
    expect(
      edges.some(
        (e: any) =>
          e.kind === "true" && byId.get(e.target)?.kind === "resource_throw",
      ),
    ).toBe(true);
    expect(
      edges.some(
        (e: any) =>
          e.kind === "false" &&
          byId.get(e.target)?.kind === "resource_suppress",
      ),
    ).toBe(true);
  }
  const cleanupEdges = graph.edges.filter(
    (e: any) =>
      byId.get(e.source)?.kind?.startsWith("resource_") && e.completionContext,
  );
  expect(cleanupEdges.length).toBeGreaterThan(0);
  expect(
    new Set(cleanupEdges.map((e: any) => e.completionContext)).size,
  ).toBeGreaterThan(1);
  const initializers = ordered
    .filter((n: any) => n.kind === "resource_init")
    .sort(
      (a: any, b: any) => a.sourceRange.startOffset - b.sourceRange.startOffset,
    );
  expect(initializers).toHaveLength(2);
  expect(
    source.slice(
      initializers[0].sourceRange.startOffset,
      initializers[0].sourceRange.endOffset,
    ),
  ).toContain('acquire("A"');
  expect(
    source.slice(
      initializers[1].sourceRange.startOffset,
      initializers[1].sourceRange.endOffset,
    ),
  ).toContain('acquire("B"');
  expect(reachable(graph, initializers[0].id, initializers[1].id)).toBe(true);
  expect(reachable(graph, initializers[1].id, initializers[0].id)).toBe(false);
  const closeA = ordered.filter(
    (n: any) => n.kind === "resource_close" && n.label === "a.close()",
  );
  const closeB = ordered.filter(
    (n: any) => n.kind === "resource_close" && n.label === "b.close()",
  );
  expect(closeA.length).toBeGreaterThan(0);
  expect(closeB.length).toBeGreaterThan(0);
  for (const b of closeB)
    expect(closeA.some((a: any) => reachable(graph, b.id, a.id))).toBe(true);
  for (const a of closeA)
    expect(closeB.some((b: any) => reachable(graph, a.id, b.id))).toBe(false);
  const body = ordered.find(
    (n: any) => n.label === 'System.out.print("body");' && n.sourceRange,
  );
  expect(body).toBeTruthy();
  expect(
    source.slice(body.sourceRange.startOffset, body.sourceRange.endOffset),
  ).toBe('System.out.print("body");');
  await info.attach("resource-graph", {
    body: JSON.stringify(graph),
    contentType: "application/json",
  });
  await page.goto("/projects/" + f.projectId);
  await page.locator(".method-item").filter({ hasText: "ordered(" }).click();
  const element = page.locator(
    `.react-flow__node[data-id="${body.id}"] .blueprint-node`,
  );
  await panToNode(page, element);
  await element.click();
  await expect(
    page.locator(".monaco-editor .code-binding").first(),
  ).toBeVisible();
  const synthetic = ordered.find((n: any) => n.kind === "resource_close");
  expect(synthetic).toBeTruthy();
  const cleanupElement = page.locator(
    `.react-flow__node[data-id="${synthetic.id}"] .blueprint-node`,
  );
  await panToNode(page, cleanupElement);
  await cleanupElement.click();
  await expect(page.locator(".inspector-selection")).toContainText(
    "Служебный узел",
  );
  await expect(page.locator(".expression-form")).toHaveCount(0);
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("resource-body-binding.png"),
    animations: "disabled",
  });
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});

test("Docker comparison checks eighteen independent resource oracles with three base and three candidate runs", async ({
  request,
}, info) => {
  test.setTimeout(540000);
  const capabilities = (
    await (await request.get("/api/v1/capabilities")).json()
  ).data;
  test.skip(
    !capabilities.runner.available,
    "Isolated Docker Java runner unavailable",
  );
  const f = await fixture(request);
  const ordered = methodNodes(f.analysis.graph, "ordered");
  const literal = '"body"';
  const node = ordered.find(
    (n: any) =>
      n.sourceRange &&
      source.slice(n.sourceRange.startOffset, n.sourceRange.endOffset) ===
        literal &&
      n.allowedOperations?.includes("replace_expression"),
  );
  expect(node, "Editable body expression inside resource scope").toBeTruthy();
  const response = await request.post(f.base + "/changes", {
    headers: await headers(request),
    data: {
      baseRevisionId: f.original.id,
      analysisId: f.analysis.id,
      methodId: node.methodId,
      nodeId: node.id,
      operation: "replace_expression",
      payload: { field: "expression", source: literal },
      intent: "semantic_edit",
    },
  });
  expect(response.status()).toBe(202);
  const pending = (await response.json()).data;
  await finished(request, f.base, pending.jobId);
  const proposal = (
    await (await request.get(f.base + "/changes/" + pending.id)).json()
  ).data;
  expect(proposal.checks.compileStatus).toBe("passed");
  const candidate = (
    await (
      await request.get(f.base + "/revisions/" + proposal.candidateRevisionId)
    ).json()
  ).data;
  expect(
    candidate.files.find((file: any) => file.path === "Main.java")
      .canonicalText,
  ).toBe(
    source.slice(0, node.sourceRange.startOffset) +
      "(" +
      literal +
      ")" +
      source.slice(node.sourceRange.endOffset),
  );
  const suiteResponse = await request.post(f.base + "/test-suites", {
    headers: await headers(request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: oracles.map((oracle: any) => ({
        ...oracle,
        stdinUtf8: "",
        expectedStderr: "",
        expectedExitCode: 0,
      })),
    },
  });
  expect(suiteResponse.status()).toBe(201);
  const suite = (await suiteResponse.json()).data;
  const comparison = await request.post(f.base + "/comparisons", {
    headers: await headers(request),
    data: {
      baseRevisionId: f.original.id,
      candidateRevisionId: candidate.id,
      suiteVersionId: suite.id,
      profileId: "java21-v1",
    },
  });
  expect(comparison.status()).toBe(202);
  const done = await finished(
    request,
    f.base,
    (await comparison.json()).data.id,
  );
  const report =
    done.result.report ??
    (
      await (
        await request.get(f.base + "/comparisons/" + done.result.comparisonId)
      ).json()
    ).data;
  await info.attach("independent-resource-oracles", {
    body: JSON.stringify({ oracles, report }),
    contentType: "application/json",
  });
  expect(report.outcome).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.testResults).toHaveLength(oracles.length);
  for (const result of report.testResults) {
    const oracle = oracles.find((item: any) => item.id === result.input.id);
    expect(oracle).toBeTruthy();
    expect(result.baseExecutions).toHaveLength(3);
    expect(result.candidateExecutions).toHaveLength(3);
    for (const execution of [
      ...result.baseExecutions,
      ...result.candidateExecutions,
    ]) {
      // Expected output is manually derived from Java 21 rules, never learned from a run.
      const runtime = execution.runtimeExecution ?? execution;
      expect(runtime.stdoutUtf8).toBe(oracle.expectedStdout);
      expect(runtime.stderrUtf8).toBe("");
      expect(runtime.exitCode).toBe(0);
    }
  }
  expect((await head(request, f.base)).id).toBe(f.original.id);
  expect(
    (await (await request.get(f.base + "/revisions/" + f.original.id)).json())
      .data.files[0].canonicalText,
  ).toBe(source);
});
