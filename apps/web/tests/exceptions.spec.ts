import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { assertRoutes, panToNode, setTheme } from "./flowAssertions";

const source = readFileSync(
  new URL("../../../fixtures/exceptions/Main.java", import.meta.url),
  "utf8",
)
  .replace(/^\uFEFF/, "")
  .replace(/\r\n?/g, "\n");
const oracles = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/exceptions/oracles.json", import.meta.url),
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
async function fixture(request: APIRequestContext, text = source) {
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Exception acceptance " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const projectId = (await made.json()).data.id;
  const base = "/api/v1/projects/" + projectId;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [{ path: "Main.java", content: text }],
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
  const analysis = (
    await (
      await request.get(base + "/revisions/" + original.id + "/analysis")
    ).json()
  ).data;
  expect(analysis.analyzerVersion).toBe("engine-0.13.1");
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
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(
      ...graph.edges
        .filter((e: any) => e.source === id)
        .map((e: any) => e.target),
    );
  }
  return false;
}

test("ordered catches and completion-specific finally preserve source bindings and outer dispatch", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(page.request);
  const graph = f.analysis.graph;
  const byId = new Map<string, any>(graph.nodes.map((n: any) => [n.id, n]));
  const outgoing = (id: string) =>
    graph.edges.filter((e: any) => e.source === id);
  for (const name of [
    "ordered",
    "nested",
    "handler",
    "jumps",
    "shortCircuit",
  ]) {
    const nodes = methodNodes(graph, name);
    expect(nodes.some((n: any) => n.kind === "opaque")).toBe(false);
    expect(nodes.some((n: any) => n.kind === "try_entry")).toBe(true);
    expect(nodes.some((n: any) => n.kind === "finally_entry")).toBe(true);
  }
  const finalizerEdges = graph.edges.filter(
    (e: any) => e.kind === "finally" || e.kind === "resume",
  );
  expect(finalizerEdges.length).toBeGreaterThan(0);
  for (const edge of finalizerEdges)
    expect(edge.completionContext).toMatch(/\S/);
  const ordered = methodNodes(graph, "ordered");
  const first = ordered.find(
    (n: any) =>
      n.kind === "catch_test" && n.label.includes("IllegalArgumentException"),
  );
  const later = ordered.find(
    (n: any) => n.kind === "catch_test" && n.label.includes("RuntimeException"),
  );
  expect(first).toBeTruthy();
  expect(later).toBeTruthy();
  expect(
    outgoing(first.id).some(
      (e: any) =>
        e.kind === "true" && byId.get(e.target).kind === "catch_entry",
    ),
  ).toBe(true);
  expect(
    outgoing(first.id).some(
      (e: any) => e.kind === "false" && e.target === later.id,
    ),
  ).toBe(true);
  // Runtime type matching is an ordered predicate; these assertions do not
  // claim static call/constructor exception resolution is exact.
  const nested = methodNodes(graph, "nested");
  for (const node of nested.filter((n: any) => n.kind === "ReturnStmt")) {
    expect(outgoing(node.id).length).toBeGreaterThan(0);
    expect(
      outgoing(node.id).every(
        (e: any) => byId.get(e.target).kind !== "normal_exit",
      ),
    ).toBe(true);
    expect(outgoing(node.id).some((e: any) => e.kind === "return" && byId.get(e.target).kind === "finally_entry")).toBe(true);
  }
  const contexts = new Set(finalizerEdges.map((e: any) => e.completionContext));
  expect(contexts.size).toBeGreaterThan(1);
  const handler = methodNodes(graph, "handler");
  const rethrow = handler.find(
    (n: any) =>
      n.kind === "ThrowStmt" && n.label.includes("IllegalStateException"),
  );
  const sibling = handler.find(
    (n: any) => n.kind === "catch_test" && n.label.includes("RuntimeException"),
  );
  const outer = handler.find(
    (n: any) =>
      n.kind === "catch_test" && n.label.includes("IllegalStateException"),
  );
  expect(rethrow).toBeTruthy();
  expect(sibling).toBeTruthy();
  expect(outer).toBeTruthy();
  expect(reachable(graph, rethrow.id, outer.id)).toBe(true);
  expect(reachable(graph, rethrow.id, sibling.id)).toBe(false);
  const atoms = methodNodes(graph, "shortCircuit").filter(
    (n: any) => n.kind === "condition_test",
  );
  const left = atoms.find((n: any) => n.label === "left");
  const right = atoms.find((n: any) => n.label === "explode()");
  expect(left).toBeTruthy();
  expect(right).toBeTruthy();
  expect(
    outgoing(left.id).some(
      (e: any) => e.kind === "true" && e.target === right.id,
    ),
  ).toBe(true);
  expect(
    outgoing(left.id).some(
      (e: any) => e.kind === "false" && e.target !== right.id,
    ),
  ).toBe(true);
  expect(
    outgoing(right.id).some(
      (e: any) =>
        e.kind === "exception" &&
        e.certainty === "conservative" &&
        typeof e.reason === "string" &&
        e.reason.length > 0,
    ),
  ).toBe(true);
  await info.attach("exception-graph", {
    body: JSON.stringify(graph),
    contentType: "application/json",
  });
  await page.goto("/projects/" + f.projectId);
  await page.locator(".method-item").filter({ hasText: "ordered(" }).click();
  await expect(page.locator(".blueprint-node.catch_test").first()).toBeVisible({
    timeout: 30000,
  });
  const bound = ordered.find(
    (n: any) => n.label === 'System.out.print("M");' && n.sourceRange,
  );
  expect(bound).toBeTruthy();
  expect(
    source.slice(bound.sourceRange.startOffset, bound.sourceRange.endOffset),
  ).toBe('System.out.print("M");');
  const element = page.locator(
    `.react-flow__node[data-id="${bound.id}"] .blueprint-node`,
  );
  await panToNode(page, element);
  await element.click();
  await expect(
    page.locator(".monaco-editor .code-binding").first(),
  ).toBeVisible();
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("exception-catch-binding.png"),
    animations: "disabled",
  });
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});

test("Docker comparison checks sixteen independent exception oracles and compiles edits inside catch and finally", async ({
  request,
}, info) => {
  test.setTimeout(480000);
  const capabilities = (
    await (await request.get("/api/v1/capabilities")).json()
  ).data;
  test.skip(
    !capabilities.runner.available,
    "Isolated Docker Java runner unavailable",
  );
  const f = await fixture(request);
  const ordered = methodNodes(f.analysis.graph, "ordered");
  const candidates = [];
  for (const literal of ['"M"', '"F"']) {
    const node = ordered.find(
      (n: any) =>
        n.sourceRange &&
        source.slice(n.sourceRange.startOffset, n.sourceRange.endOffset) ===
          literal &&
        n.allowedOperations?.includes("replace_expression"),
    );
    expect(
      node,
      "Editable literal inside " + (literal === '"M"' ? "catch" : "finally"),
    ).toBeTruthy();
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
    const expectedSource =
      source.slice(0, node.sourceRange.startOffset) +
      "(" +
      literal +
      ")" +
      source.slice(node.sourceRange.endOffset);
    expect(
      candidate.files.find((file: any) => file.path === "Main.java")
        .canonicalText,
    ).toBe(expectedSource);
    candidates.push(proposal.candidateRevisionId);
  }
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
      candidateRevisionId: candidates[1],
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
  await info.attach("independent-exception-oracles", {
    body: JSON.stringify({ oracles, report }),
    contentType: "application/json",
  });
  expect(report.outcome).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.testResults).toHaveLength(oracles.length);
  for (const result of report.testResults) {
    const oracle = oracles.find((item: any) => item.id === result.input.id);
    expect(oracle).toBeTruthy();
    for (const execution of [
      ...result.baseExecutions,
      ...result.candidateExecutions,
    ]) {
      // The oracle is hand derived from Java completion rules, not copied
      // from a baseline execution or inferred from the analyzer graph.
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

test("compact condition routes turn toward left return and right action with readable side labels", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const text = `public class Main {
    static int choose(boolean stop) {
      int result = 0;
      if (stop) { return -1; } else { result = 2; }
      return result;
    }
  }\n`;
  const f = await fixture(page.request, text);
  await page.goto("/projects/" + f.projectId);
  await expect(page.locator(".blueprint-node.condition_test")).toBeVisible({
    timeout: 30000,
  });
  await page.locator(".react-flow__controls-fitview").click();
  await assertRoutes(page);
  const check = methodNodes(f.analysis.graph, "choose").find(
    (n: any) => n.kind === "condition_test",
  );
  const sourceElement = page.locator(
    `.react-flow__node[data-id="${check.id}"]`,
  );
  const sourceBounds = (await sourceElement.boundingBox())!;
  for (const kind of ["true", "false"]) {
    const edge = f.analysis.graph.edges.find(
      (e: any) => e.source === check.id && e.kind === kind,
    );
    const path = page.locator(
      `g[data-route-source="${edge.source}"][data-route-target="${edge.target}"] path.react-flow__edge-path`,
    );
    const geometry = await path.evaluate((element) => {
      const path = element as SVGPathElement;
      const start = path.getPointAtLength(0),
        end = path.getPointAtLength(path.getTotalLength());
      const screen = new DOMPoint(start.x, start.y).matrixTransform(
        path.getScreenCTM()!,
      );
      return {
        startX: screen.x,
        length: path.getTotalLength(),
        minimum: Math.abs(end.x - start.x) + Math.abs(end.y - start.y),
        marker: path.getAttribute("marker-end"),
      };
    });
    expect(
      Math.abs(
        geometry.startX -
          (kind === "true"
            ? sourceBounds.x
            : sourceBounds.x + sourceBounds.width),
      ),
    ).toBeLessThan(5);
    expect(geometry.length).toBeLessThanOrEqual(geometry.minimum + 100);
    expect(geometry.marker).toBeTruthy();
  }
  await expect(
    page.locator(".branch-label").filter({ hasText: /^да$/ }),
  ).toBeVisible();
  await expect(
    page.locator(".branch-label").filter({ hasText: /^нет$/ }),
  ).toBeVisible();
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("compact-return-action-routes.png"),
    animations: "disabled",
  });
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});
