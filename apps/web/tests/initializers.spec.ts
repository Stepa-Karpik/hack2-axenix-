import { ENGINE_VERSION } from "./engineVersion";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

// Fixture Java is compiled only by the application's isolated runner, never on the Windows host.
const source = `// Сохранить 😀
public class Main {
  static int field = 1, sibling = 9;
  static { field += 2; }
  int instance = 3;
  { instance += 4; }
  Main() { super(); }
  public static void main(String[] args) { System.out.println(field + ":" + new Main().instance); }
}
`;
const companion =
  "// untouched companion 😀\nclass Other { static int other = 77; }\n";

async function completed(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect
    .poll(
      async () => {
        job = (await (await request.get(base + "/jobs/" + id)).json()).data;
        return job.status;
      },
      { timeout: 180000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return job;
}

async function fixture(request: APIRequestContext) {
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Initializer acceptance " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).data.id;
  const base = "/api/v1/projects/" + projectId;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [
        { path: "Main.java", content: source },
        { path: "Other.java", content: companion },
        { path: "notes.txt", content: "Keep this exact café\n" },
      ],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  const analyzing = await request.post(
    base + "/revisions/" + original.id + "/analysis",
    {
      headers: await headers(request),
      data: {},
    },
  );
  expect(analyzing.status()).toBe(202);
  expect(
    (await completed(request, base, (await analyzing.json()).data.id)).status,
  ).toBe("succeeded");
  const analysis = (
    await (
      await request.get(base + "/revisions/" + original.id + "/analysis")
    ).json()
  ).data;
  expect(analysis.parseStatus).toBe("valid");
  expect(analysis.analyzerVersion).toBe(ENGINE_VERSION);
  return { projectId, base, original, analysis };
}

test("initializer source contexts select exact expressions and prepare compiled detached semantic edits through UI", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  const f = await fixture(page.request);
  const contexts = f.analysis.graph.initializerContexts.filter(
    (context: any) => context.sourceRange.filePath === "Main.java",
  );
  expect(contexts.map((context: any) => context.label)).toEqual([
    "field",
    "sibling",
    "static block #1",
    "instance",
    "instance block #1",
  ]);
  expect(contexts.map((context: any) => context.streamIndex)).toEqual([
    0, 1, 2, 0, 1,
  ]);
  expect(f.analysis.graph.methods).toHaveLength(2); // Real constructor and main; initializer views are not methods.
  expect(f.analysis.quality.methods).toHaveLength(2);
  for (const context of contexts) {
    expect(context.projectionKind).toBe("ast_source");
    expect(context.constantStatus).toBe("unknown");
    expect(context.edges.every((edge: any) => edge.kind === "contains")).toBe(
      true,
    );
    expect(context.nodes.every((node: any) => !("methodId" in node))).toBe(
      true,
    );
  }

  await page.goto("/projects/" + f.projectId);
  const list = page.getByRole("region", { name: "Инициализаторы файла" });
  await expect(list).toBeVisible({ timeout: 30000 });
  await expect(list.locator("[data-initializer-id]")).toHaveCount(5);
  await expect(list.getByRole("button", { name: /other/ })).toHaveCount(0);
  for (const label of ["static block #1", "instance block #1"]) {
    const context = contexts.find((item: any) => item.label === label);
    await list.locator(`[data-initializer-id="${context.id}"]`).click();
    await expect(
      page.locator(`[data-initializer-context="${context.id}"]`),
    ).toBeVisible();
    await expect(page.locator(".initializer-caption")).toContainText(
      "Это не порядок исполнения класса",
    );
    await expect(page.locator(".initializer-caption")).toContainText(
      context.effectiveStatic ? "статическая" : "экземпляра",
    );
    await page.screenshot({
      path: info.outputPath(
        context.effectiveStatic
          ? "initializer-static-block.png"
          : "initializer-instance-block.png",
      ),
      animations: "disabled",
    });
  }

  const field = contexts.find((context: any) => context.label === "field");
  const node = field.nodes.find((item: any) => item.label === "1");
  expect(
    source.slice(node.sourceRange.startOffset, node.sourceRange.endOffset),
  ).toBe("1");
  expect(node.sourceRange.startOffset).toBe(
    source.indexOf("field = 1") + "field = ".length,
  );
  await list.locator(`[data-initializer-id="${field.id}"]`).click();
  await page
    .locator(
      `[data-initializer-context="${field.id}"] .react-flow__node[data-id="${node.id}"]`,
    )
    .click();
  const inspector = page.getByRole("region", {
    name: "Редактирование инициализатора",
  });
  await expect(inspector.getByLabel("Выражение Java")).toHaveValue("1");
  await inspector.getByRole("button", { name: "Перейти к коду" }).click();
  await revealPanel(page, "code", "Код Java");
  await expect(page.locator(".code-binding").first()).toBeVisible();
  // Monaco decorations are empty overlay rectangles. Compare the rectangle to
  // the rendered source glyph instead of inventing text content on the overlay.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const line = [
            ...document.querySelectorAll(".monaco-editor .view-line"),
          ].find((element) =>
            element.textContent
              ?.replaceAll("\u00a0", " ")
              .includes("static int field = 1, sibling = 9;"),
          );
          const binding = document.querySelector(
            ".monaco-editor .code-binding",
          );
          if (!line || !binding) return false;
          const text = (line.textContent ?? "").replaceAll("\u00a0", " ");
          const target = text.indexOf("1, sibling");
          if (target < 0) return false;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let offset = 0;
          for (
            let child = walker.nextNode();
            child;
            child = walker.nextNode()
          ) {
            const length = child.textContent?.length ?? 0;
            if (target >= offset && target < offset + length) {
              const range = document.createRange();
              range.setStart(child, target - offset);
              range.setEnd(child, target - offset + 1);
              const glyph = range.getBoundingClientRect(),
                highlight = binding.getBoundingClientRect();
              return (
                glyph.left >= highlight.left - 2 &&
                glyph.right <= highlight.right + 2 &&
                highlight.width <= glyph.width + 3 &&
                glyph.top < highlight.bottom &&
                glyph.bottom > highlight.top
              );
            }
            offset += length;
          }
          return false;
        }),
      {
        message:
          "Exact field initializer glyph is covered by its source-range highlight",
      },
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath("initializer-exact-expression.png"),
    animations: "disabled",
  });
  await revealPanel(page, "analysis", "Инспектор");
  await inspector.getByLabel("Выражение Java").fill("5");
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/changes") &&
      response.request().method() === "POST",
  );
  await inspector
    .getByRole("button", { name: "Подготовить изменение" })
    .click();
  const response = await submitted;
  expect(response.status()).toBe(202);
  const command = response.request().postDataJSON();
  expect(command).toMatchObject({
    initializerContextId: field.id,
    nodeId: node.id,
    operation: "replace_expression",
    intent: "semantic_edit",
  });
  expect(command).not.toHaveProperty("methodId");
  const queued = (await response.json()).data;
  const job = await completed(page.request, f.base, queued.jobId);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  await revealPanel(page, "changes", "Изменения");
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  const proposal = (
    await (await page.request.get(f.base + "/changes/" + queued.id)).json()
  ).data;
  expect(proposal.status).toBe("ready");
  expect(proposal.checks).toMatchObject({
    parseStatus: "valid",
    compileStatus: "passed",
  });
  expect(proposal.compileExecution).toMatchObject({
    phase: "compile",
    outcome: "exited",
    exitCode: 0,
  });
  expect(proposal.diff).toHaveLength(1);
  expect(proposal.diff[0]).toMatchObject({
    filePath: "Main.java",
    startOffset: node.sourceRange.startOffset,
    endOffset: node.sourceRange.endOffset,
    before: "1",
    after: "(5)",
  });
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  const detached = (
    await (
      await page.request.get(
        f.base + "/revisions/" + proposal.candidateRevisionId,
      )
    ).json()
  ).data;
  expect(
    detached.files.find((file: any) => file.path === "Main.java").canonicalText,
  ).toBe(source.replace("field = 1", "field = (5)"));
  for (const path of ["Other.java", "notes.txt"])
    expect(detached.files.find((file: any) => file.path === path)).toEqual(
      f.original.files.find((file: any) => file.path === path),
    );
  await expect(page.locator(".proposal")).toContainText("Изменение логики");
  await expect(page.locator(".diff .removed")).toContainText("1");
  await expect(page.locator(".diff .added")).toContainText("(5)");
  await page.screenshot({
    path: info.outputPath("initializer-compiled-detached-diff.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(async () => (await head(page.request, f.base)).id)
    .toBe(proposal.candidateRevisionId);
  expect(
    (
      await (
        await page.request.get(f.base + "/revisions/" + f.original.id)
      ).json()
    ).data,
  ).toEqual(f.original);
  await page.screenshot({
    path: info.outputPath("initializer-applied-semantic.png"),
    animations: "disabled",
  });
  // The graph has no position gesture here: its history fallback must undo the
  // actual applied source edit by making a new CAS-bound revision.
  async function readyAnalysis(revision: string) {
    let current: any;
    await expect
      .poll(
        async () => {
          const result = await page.request.get(
            f.base + "/revisions/" + revision + "/analysis",
          );
          const body = await result.json();
          if (
            result.status() === 404 &&
            body.error?.code === "ANALYSIS_NOT_READY"
          )
            return "pending";
          expect(result.ok(), JSON.stringify(body)).toBe(true);
          current = body.data;
          return current.parseStatus;
        },
        { timeout: 45000 },
      )
      .toBe("valid");
    return current;
  }
  const appliedAnalysis = await readyAnalysis(proposal.candidateRevisionId);
  const appliedField = appliedAnalysis.graph.initializerContexts.find(
    (context: any) =>
      context.label === "field" && context.sourceRange.filePath === "Main.java",
  );
  await revealPanel(page, "project", "Проект");
  await list.locator(`[data-initializer-id="${appliedField.id}"]`).click();
  await page.locator(".initializer-view").focus();
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await head(page.request, f.base)).id, { timeout: 45000 })
    .not.toBe(proposal.candidateRevisionId);
  const undone = await head(page.request, f.base);
  expect(undone.id).not.toBe(f.original.id);
  expect(
    undone.files.find((file: any) => file.path === "Main.java")!.canonicalText,
  ).toBe(source);
  await readyAnalysis(undone.id);
  await page.screenshot({
    path: info.outputPath("initializer-source-undo-new-revision.png"),
    animations: "disabled",
  });
  // Analysis IDs regenerate after source undo, so the prior context selection
  // may disappear. Use the current callable canvas for the same source history.
  await revealPanel(page, "graph", "Схема");
  const remainingInitializer = page.locator(".initializer-view");
  if (await remainingInitializer.isVisible())
    await remainingInitializer.focus();
  else await page.locator(".flow-area").focus();
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(async () => (await head(page.request, f.base)).id, { timeout: 45000 })
    .not.toBe(undone.id);
  const redone = await head(page.request, f.base);
  expect(redone.id).not.toBe(proposal.candidateRevisionId);
  expect(
    redone.files.find((file: any) => file.path === "Main.java")!.canonicalText,
  ).toBe(source.replace("field = 1", "field = (5)"));
  await readyAnalysis(redone.id);
  for (const path of ["Other.java", "notes.txt"]) {
    expect(undone.files.find((file: any) => file.path === path)).toEqual(
      f.original.files.find((file: any) => file.path === path),
    );
    expect(redone.files.find((file: any) => file.path === path)).toEqual(
      f.original.files.find((file: any) => file.path === path),
    );
  }
  expect(
    (
      await (
        await page.request.get(
          f.base + "/revisions/" + proposal.candidateRevisionId,
        )
      ).json()
    ).data.files,
  ).toEqual(detached.files);
  await page.screenshot({
    path: info.outputPath("initializer-source-redo-new-revision.png"),
    animations: "disabled",
  });
  await info.attach("initializer-actual-provenance", {
    body: JSON.stringify({
      projectId: f.projectId,
      original: f.original.id,
      analysis: f.analysis,
      command,
      proposal,
      detached: detached.id,
      sourceUndoRevisionId: undone.id,
      sourceRedoRevisionId: redone.id,
    }),
    contentType: "application/json",
  });
});

test("initializer API rejects mixed cross-context stale and malformed targets without changing the head", async ({
  request,
}, info) => {
  test.setTimeout(300000);
  const f = await fixture(request);
  const field = f.analysis.graph.initializerContexts.find(
    (context: any) => context.label === "field",
  );
  const sibling = f.analysis.graph.initializerContexts.find(
    (context: any) => context.label === "sibling",
  );
  const node = field.nodes.find((item: any) => item.label === "1");
  const valid = {
    baseRevisionId: f.original.id,
    analysisId: f.analysis.id,
    initializerContextId: field.id,
    nodeId: node.id,
    operation: "replace_expression",
    payload: { field: "expression", source: "5" },
    intent: "semantic_edit",
  };
  const mixed = await request.post(f.base + "/changes", {
    headers: await headers(request),
    data: { ...valid, methodId: f.analysis.graph.methods[0].id },
  });
  expect(mixed.status()).toBe(400);
  expect((await mixed.json()).error.code).toBe("INVALID_REQUEST");
  const failures: any[] = [];
  for (const command of [
    { ...valid, initializerContextId: sibling.id },
    { ...valid, payload: { field: "expression", source: "1; int injected=2" } },
  ]) {
    const response = await request.post(f.base + "/changes", {
      headers: await headers(request),
      data: command,
    });
    expect(response.status()).toBe(202);
    const queued = (await response.json()).data;
    const job = await completed(request, f.base, queued.jobId);
    expect(job.status).toBe("failed");
    const proposal = (
      await (await request.get(f.base + "/changes/" + queued.id)).json()
    ).data;
    expect(proposal.status).toBe("rejected");
    expect(proposal.candidateRevisionId).toBeUndefined();
    expect((await head(request, f.base)).id).toBe(f.original.id);
    failures.push({ command, job, proposal });
  }
  // A parse-valid expression still has to satisfy the original field's Java type in the isolated compiler.
  const badType = await request.post(f.base + "/changes", {
    headers: await headers(request),
    data: {
      ...valid,
      payload: { field: "expression", source: '"wrong type"' },
    },
  });
  expect(badType.status()).toBe(202);
  const badQueued = (await badType.json()).data;
  expect((await completed(request, f.base, badQueued.jobId)).status).toBe(
    "succeeded",
  );
  const badProposal = (
    await (await request.get(f.base + "/changes/" + badQueued.id)).json()
  ).data;
  expect(badProposal.status).toBe("rejected");
  expect(badProposal.checks.compileStatus).toBe("failed");
  const refusedApply = await request.post(f.base + "/head", {
    headers: await headers(request, f.original.id),
    data: {
      expectedHeadRevisionId: f.original.id,
      proposalId: badProposal.id,
      candidateRevisionId: badProposal.candidateRevisionId,
    },
  });
  expect(refusedApply.status()).toBeGreaterThanOrEqual(400);
  expect((await head(request, f.base)).id).toBe(f.original.id);
  const newer = await request.post(f.base + "/revisions", {
    headers: await headers(request, f.original.id),
    data: {
      files: f.original.files.map((file: any) => ({
        path: file.path,
        content:
          file.path === "Main.java"
            ? source.replace("field = 1", "field = 2")
            : file.canonicalText,
      })),
      intent: "semantic_edit",
    },
  });
  expect(newer.status()).toBe(201);
  const current = (await newer.json()).data;
  const stale = await request.post(f.base + "/changes", {
    headers: await headers(request),
    data: { ...valid, baseRevisionId: current.id },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe("ANALYSIS_CONFLICT");
  expect((await head(request, f.base)).id).toBe(current.id);
  await info.attach("initializer-refusals", {
    body: JSON.stringify({
      projectId: f.projectId,
      failures,
      badProposal,
      staleRevision: current.id,
    }),
    contentType: "application/json",
  });
});
