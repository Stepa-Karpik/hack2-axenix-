import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { headers, head, type Snapshot } from "./fileFixtures";
import { panToNode, revealPanel } from "./flowAssertions";

const source = `public class Main {
  static void mark(String value) { System.out.print(value); }
  public static void main(String[] args) {
    int count = 0;
    // соседний комментарий 😀
    mark("A");
    mark("B"); // keep trailing
    if (false) { mark("C"); }
  }
}
`;
const raw = "\uFEFFkeep café\r\n";
type Node = {
  id: string;
  methodId: string;
  label: string;
  kind: string;
  parentId?: string;
  allowedOperations: string[];
};
type Analysis = {
  id: string;
  analyzerVersion: string;
  graph: { nodes: Node[] };
};
type Proposal = {
  id: string;
  jobId: string;
  candidateRevisionId: string;
  status: string;
  checks: { compileStatus: string };
};

async function setup(request: APIRequestContext, content = source) {
  const capabilities = (
    await (await request.get("/api/v1/capabilities")).json()
  ).data;
  test.skip(
    !capabilities.runner.available,
    "Real isolated compiler unavailable",
  );
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Block acceptance " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).data.id as string;
  const base = "/api/v1/projects/" + projectId;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [
        { path: "Main.java", content },
        { path: "notes.txt", content: raw },
        { path: "Other.java", content: "/* untouched */ class Other {}\n" },
      ],
      directories: ["empty/deep"],
      importedPaths: ["notes.txt"],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data as Snapshot;
  const analyzing = await request.post(
    base + "/revisions/" + original.id + "/analysis",
    { headers: await headers(request), data: {} },
  );
  expect(analyzing.status()).toBe(202);
  expect(
    (await job(request, base, (await analyzing.json()).data.id)).status,
  ).toBe("succeeded");
  await test.info().attach("synthetic-project", {
    body: JSON.stringify({ projectId, base, original }),
    contentType: "application/json",
  });
  return { base, projectId, original };
}
async function analysis(
  request: APIRequestContext,
  base: string,
  revision: string,
): Promise<Analysis> {
  let result: Analysis | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          base + "/revisions/" + revision + "/analysis",
        );
        if (!response.ok()) return false;
        result = (await response.json()).data;
        return result?.analyzerVersion === "engine-0.7.0";
      },
      { timeout: 30000 },
    )
    .toBe(true);
  return result!;
}
function find(a: Analysis, label: string) {
  const selected = a.graph.nodes.find((n) => n.label === label);
  expect(selected, label).toBeTruthy();
  return selected!;
}
async function job(request: APIRequestContext, base: string, id: string) {
  await expect
    .poll(
      async () =>
        (await (await request.get(base + "/jobs/" + id)).json()).data.status,
      { timeout: 120000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return (await (await request.get(base + "/jobs/" + id)).json()).data;
}
async function propose(
  request: APIRequestContext,
  base: string,
  revision: string,
  a: Analysis,
  node: Node,
  operation: string,
  payload: object,
  intent = "semantic_edit",
) {
  const command = {
    baseRevisionId: revision,
    analysisId: a.id,
    methodId: node.methodId,
    nodeId: node.id,
    operation,
    payload,
    intent,
  };
  const response = await request.post(base + "/changes", {
    headers: await headers(request),
    data: command,
  });
  expect(response.status(), JSON.stringify(await response.json())).toBe(202);
  const pending = (await response.json()).data;
  expect((await job(request, base, pending.jobId)).status).toBe("succeeded");
  return (await (await request.get(base + "/changes/" + pending.id)).json())
    .data as Proposal;
}
async function apply(
  request: APIRequestContext,
  base: string,
  revision: string,
  p: Proposal,
  report?: string,
) {
  return request.post(base + "/head", {
    headers: await headers(request, revision),
    data: {
      expectedHeadRevisionId: revision,
      candidateRevisionId: p.candidateRevisionId,
      proposalId: p.id,
      ...(report ? { verificationReportId: report } : {}),
    },
  });
}
async function output(
  request: APIRequestContext,
  base: string,
  revision: string,
) {
  const response = await request.post(base + "/runs", {
    headers: await headers(request),
    data: {
      revisionId: revision,
      entryPoint: "Main",
      argv: [],
      stdinUtf8: "",
      profileId: "java21-v1",
    },
  });
  expect(response.status()).toBe(202);
  const finished = await job(request, base, (await response.json()).data.id);
  expect(finished.status).toBe("succeeded");
  await test.info().attach("isolated-run", {
    body: JSON.stringify(finished),
    contentType: "application/json",
  });
  const report = finished.result.report;
  expect(report.revisionId).toBe(revision);
  expect(report.compileExecution.exitCode).toBe(0);
  expect(report.runtimeExecution.exitCode).toBe(0);
  return report.runtimeExecution.stdoutUtf8 as string;
}
async function select(page: Page, label: string) {
  const node = page
    .locator(".blueprint-node")
    .filter({ has: page.locator(".node-label", { hasText: label }) });
  await panToNode(page, node);
  await node.click();
}
async function companion(
  request: APIRequestContext,
  base: string,
  original: Snapshot,
  current: Snapshot,
) {
  expect(current.directories).toEqual(original.directories);
  for (const path of ["notes.txt", "Other.java"])
    expect(current.files.find((f) => f.path === path)).toEqual(
      original.files.find((f) => f.path === path),
    );
  const notes = current.files.find(
    (f) => f.path === "notes.txt",
  ) as unknown as { rawArtifactRef: string };
  expect(
    await (
      await request.get(base + "/artifacts/" + notes.rawArtifactRef)
    ).body(),
  ).toEqual(Buffer.from(raw));
  expect(
    (await (await request.get(base + "/revisions/" + original.id)).json()).data,
  ).toEqual(original);
}

test("explicit move, loop wrap and else actions preserve full tree and show detached proposals", async ({
  page,
}, testInfo) => {
  test.setTimeout(360000);
  const { base, projectId, original } = await setup(page.request);
  await page.goto("/projects/" + projectId);
  await testInfo.attach("runtime-assets", {
    body: JSON.stringify(
      await page.evaluate(() => ({
        scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
        styles: [
          ...document.querySelectorAll<HTMLLinkElement>(
            'link[rel="stylesheet"]',
          ),
        ].map((s) => s.href),
      })),
    ),
    contentType: "application/json",
  });
  const initialLayout = page.waitForResponse(
    (r) => r.url().includes("/layout?") && r.request().method() === "GET",
  );
  await page.locator(".method-item").filter({ hasText: "main(" }).click();
  await initialLayout;
  await select(page, 'mark("A");');
  const semanticRequests: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /\/(changes|head|revisions)$/.test(r.url()))
      semanticRequests.push(r.url());
  });
  const draggable = page
    .locator(".react-flow__node")
    .filter({ has: page.locator(".node-label", { hasText: 'mark("A");' }) });
  const bounds = (await draggable.boundingBox())!;
  await testInfo.attach("drag-before", {
    body: JSON.stringify(
      await draggable.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return {
          class: el.className,
          style: el.getAttribute("style"),
          hit: document.elementFromPoint(b.x + 12, b.y + 12)?.outerHTML,
          bounds: b.toJSON(),
        };
      }),
    ),
    contentType: "application/json",
  });
  await page.waitForTimeout(300);
  const layoutSaved = page.waitForResponse(
    (r) => r.url().includes("/layout") && r.request().method() === "PUT",
  );
  await page.mouse.move(bounds.x + 12, bounds.y + 12);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 112, bounds.y + 32, { steps: 8 });
  await page.mouse.up();
  await testInfo.attach("drag-after", {
    body: JSON.stringify(
      await draggable.evaluate((el) => ({
        class: el.className,
        style: el.getAttribute("style"),
      })),
    ),
    contentType: "application/json",
  });
  await layoutSaved;
  expect(semanticRequests).toEqual([]);
  expect((await head(page.request, base)).id).toBe(original.id);
  await page
    .getByLabel("Действие", { exact: true })
    .selectOption("move_statement");
  const a = await analysis(page.request, base, original.id);
  const target = find(a, 'mark("B");');
  await page.getByLabel("Относительно оператора").selectOption(target.id);
  await page.getByLabel("Позиция перемещения").selectOption("after");
  await page
    .getByRole("button", { name: "Подготовить изменение" })
    .scrollIntoViewIfNeeded();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"] as const) {
    const toggle = page.getByRole("button", {
      name: theme === "dark" ? "Включить тёмную тему" : "Включить светлую тему",
    });
    if (await toggle.count()) await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: testInfo.outputPath("blocks-controls-" + theme + ".png"),
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await revealPanel(page, "analysis", "Инспектор");
  await page
    .getByRole("button", { name: "Подготовить изменение" })
    .scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Относительно оператора")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("blocks-controls-narrow.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1512, height: 982 });
  const actions = [
    { operation: "move_statement", expected: "BA" },
    { operation: "wrap_while", expected: "BAA" },
    { operation: "add_else", expected: "BAAD" },
    { operation: "remove_else", expected: "BAA" },
  ];
  for (const action of actions) {
    const before = await head(page.request, base);
    if (action.operation !== "move_statement") {
      if (action.operation === "wrap_while") await select(page, 'mark("A");');
      else {
        await panToNode(page, page.locator(".blueprint-node.IfStmt"));
        await page.locator(".blueprint-node.IfStmt").click();
      }
      await page
        .getByLabel("Действие", { exact: true })
        .selectOption(action.operation);
      if (action.operation === "wrap_while")
        await page.getByLabel("Условие", { exact: true }).fill("count++ < 2");
      if (action.operation === "add_else")
        await page.getByLabel("Тело ветки else").fill('{ mark("D"); }');
    }
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith("/changes") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Подготовить изменение" }).click();
    const proposalId = (await (await submitted).json()).data.id;
    await expect(
      page.getByRole("button", { name: "Применить", exact: true }),
    ).toBeEnabled({ timeout: 60000 });
    expect((await head(page.request, base)).id).toBe(before.id);
    const proposal = (
      await (await page.request.get(base + "/changes/" + proposalId)).json()
    ).data;
    const detached = (
      await (
        await page.request.get(
          base + "/revisions/" + proposal.candidateRevisionId,
        )
      ).json()
    ).data;
    await companion(page.request, base, original, detached);
    await expect(page.locator(".diff")).toBeVisible();
    if (action.operation === "move_statement")
      await page.screenshot({
        path: testInfo.outputPath("blocks-proposal-diff.png"),
        animations: "disabled",
      });
    await page.getByRole("button", { name: "Применить", exact: true }).click();
    await expect
      .poll(async () => (await head(page.request, base)).id)
      .not.toBe(before.id);
    const current = await head(page.request, base);
    await testInfo.attach(action.operation, {
      body: JSON.stringify({
        projectId,
        base: before.id,
        proposal,
        candidateRevisionId: detached.id,
        appliedHead: current.id,
      }),
      contentType: "application/json",
    });
    await companion(page.request, base, original, current);
    expect(
      current.files.find((f) => f.path === "Main.java")!.canonicalText,
    ).toContain("// соседний комментарий 😀");
    expect(
      current.files.find((f) => f.path === "Main.java")!.canonicalText,
    ).toContain("// keep trailing");
    expect(await output(page.request, base, current.id)).toBe(action.expected);
    await page.reload();
    await page.locator(".method-item").filter({ hasText: "main(" }).click();
    await page.locator(".monaco-editor .native-edit-context").focus();
    await page.keyboard.press("Control+End");
    await expect(page.locator(".monaco-editor")).toContainText("keep trailing");
  }
  expect(await output(page.request, base, original.id)).toBe("AB");
  await page.keyboard.press("Control+Home");
  await page.screenshot({ path: testInfo.outputPath("blocks-applied.png") });
});

test("scope-invalid wrap is rejected by the isolated compiler without apply or head changes", async ({
  request,
}) => {
  test.setTimeout(180000);
  const { base, original } = await setup(
    request,
    "public class Main { public static void main(String[] args) { int value = 1; System.out.print(value); } }\n",
  );
  const a = await analysis(request, base, original.id);
  for (const [operation, payload] of [
    ["wrap_if", { condition: "true" }],
    [
      "move_statement",
      {
        targetNodeId: find(a, "System.out.print(value);").id,
        position: "after",
      },
    ],
  ] as const) {
    const p = await propose(
      request,
      base,
      original.id,
      a,
      find(a, "int value = 1;"),
      operation,
      payload,
    );
    expect(p.status).toBe("rejected");
    expect(p.checks.compileStatus).toBe("failed");
    expect((await apply(request, base, original.id, p)).status()).toBe(409);
    expect((await head(request, base)).id).toBe(original.id);
  }
  expect(await output(request, base, original.id)).toBe("1");
});

test("preserving wrap needs an exact repeated matched report; stale IDs and CAS cannot apply", async ({
  request,
}) => {
  test.setTimeout(300000);
  const { base, original } = await setup(request);
  const a = await analysis(request, base, original.id);
  const node = find(a, 'mark("A");');
  const p = await propose(
    request,
    base,
    original.id,
    a,
    node,
    "wrap_if",
    { condition: "true" },
    "preserve_behavior",
  );
  expect(p.status).toBe("ready");
  const staleCandidate = await propose(
    request,
    base,
    original.id,
    a,
    node,
    "wrap_if",
    { condition: "true" },
  );
  expect((await apply(request, base, original.id, p)).ok()).toBe(false);
  expect((await head(request, base)).id).toBe(original.id);
  const suiteResponse = await request.post(base + "/test-suites", {
    headers: await headers(request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: [{ id: "order", stdinUtf8: "", argv: [] }],
    },
  });
  expect(suiteResponse.status()).toBe(201);
  const suite = (await suiteResponse.json()).data;
  const compare = async (candidateRevisionId: string) => {
    const response = await request.post(base + "/comparisons", {
      headers: await headers(request),
      data: {
        baseRevisionId: original.id,
        candidateRevisionId,
        suiteVersionId: suite.id,
        profileId: "java21-v1",
      },
    });
    expect(response.status()).toBe(202);
    const finished = await job(request, base, (await response.json()).data.id);
    expect(finished.status).toBe("succeeded");
    return (
      await (
        await request.get(base + "/comparisons/" + finished.result.comparisonId)
      ).json()
    ).data;
  };
  const different = await propose(
    request,
    base,
    original.id,
    a,
    node,
    "move_statement",
    { targetNodeId: find(a, 'mark("B");').id, position: "after" },
    "preserve_behavior",
  );
  const mismatch = await compare(different.candidateRevisionId);
  expect(mismatch.outcome).toBe("mismatch");
  expect(
    (await apply(request, base, original.id, different, mismatch.id)).status(),
  ).toBe(409);
  const report = await compare(p.candidateRevisionId);
  await test.info().attach("exact-comparison", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
  expect(report.outcome).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.plannedRepeatCount).toBe(3);
  expect(report.observedRepeatCounts).toEqual({ base: 3, candidate: 3 });
  expect(report.testResults[0].baseExecutions).toHaveLength(3);
  expect(report.testResults[0].candidateExecutions).toHaveLength(3);
  expect(report.baseRevisionId).toBe(original.id);
  expect(report.candidateRevisionId).toBe(p.candidateRevisionId);
  expect(
    (await apply(request, base, original.id, different, report.id)).status(),
  ).toBe(409);
  expect((await apply(request, base, original.id, p, report.id)).status()).toBe(
    200,
  );
  const current = await head(request, base);
  await companion(request, base, original, current);
  const stale = await request.post(base + "/changes", {
    headers: await headers(request),
    data: {
      baseRevisionId: current.id,
      analysisId: a.id,
      methodId: node.methodId,
      nodeId: node.id,
      operation: "wrap_if",
      payload: { condition: "true" },
      intent: "semantic_edit",
    },
  });
  expect(stale.status()).toBe(409);
  const staleApply = await apply(request, base, original.id, staleCandidate);
  expect(staleApply.status()).toBe(409);
  expect((await staleApply.json()).error.code).toBe("REVISION_CONFLICT");
  expect((await head(request, base)).id).toBe(current.id);
});

test("commented else removal and loop jump capture are unavailable; cross-block moves fail safely", async ({
  request,
}) => {
  test.setTimeout(180000);
  const content = `public class Main { public static void main(String[] args) {
    System.out.print("outer");
    while (true) { if (true) { break; } }
    if (true) { System.out.print("then"); } else { /* keep */ System.out.print("else"); }
  } }\n`;
  const { base, original } = await setup(request, content);
  const a = await analysis(request, base, original.id);
  const branches = a.graph.nodes.filter((n) => n.kind === "IfStmt");
  expect(branches).toHaveLength(2);
  expect(
    branches.every((n) => !n.allowedOperations.includes("remove_else")),
  ).toBe(true);
  const capture = branches.find(
    (n) =>
      n.allowedOperations.includes("wrap_if") &&
      !n.allowedOperations.includes("wrap_while"),
  )!;
  expect(capture).toBeTruthy();
  expect(capture.allowedOperations).not.toContain("wrap_while");
  const outside = find(a, 'System.out.print("outer");');
  const inside = find(a, 'System.out.print("then");');
  const response = await request.post(base + "/changes", {
    headers: await headers(request),
    data: {
      baseRevisionId: original.id,
      analysisId: a.id,
      methodId: outside.methodId,
      nodeId: outside.id,
      operation: "move_statement",
      payload: { targetNodeId: inside.id, position: "before" },
      intent: "semantic_edit",
    },
  });
  expect(response.status()).toBe(202);
  const pending = (await response.json()).data;
  expect((await job(request, base, pending.jobId)).status).toBe("failed");
  expect((await head(request, base)).id).toBe(original.id);
});
