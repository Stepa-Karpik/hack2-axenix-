import { test, expect } from "@playwright/test";
import { assertRoutes, panToNode } from "./flowAssertions";
const source = `public class Main {
  static boolean a() { return true; }
  static boolean b() { return false; }
  static boolean c() { return true; }
  static int andTest() {
    if (a() && b()) return 1;
    return 0;
  }
  static int orTest() {
    if (a() || b()) return 1;
    return 0;
  }
  static int mixedTest() {
    if ((a() || b()) && c()) return 1;
    return 0;
  }
  static int loopTest() {
    int i = 0;
    while (i < 2 && a()) { i++; }
    return i;
  }
}
`;

test("real short-circuit graph atoms, branches, whole-condition edit and scoped layout", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Conditions UI " + Date.now());
  await page.locator("input[type=file]").setInputFiles({
    name: "Main.java",
    mimeType: "text/x-java-source",
    buffer: Buffer.from(source),
  });
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  const base = "/api/v1/projects/" + page.url().split("/projects/")[1];
  const head = (await (await page.request.get(base)).json()).data
    .headRevisionId;
  const analysis = (
    await (
      await page.request.get(base + "/revisions/" + head + "/analysis")
    ).json()
  ).data;
  expect(analysis.analyzerVersion).toBe("engine-0.6.0");
  for (const name of ["andTest", "orTest", "mixedTest", "loopTest"]) {
    await page
      .locator(".method-item")
      .filter({ hasText: name + "(" })
      .click();
    await expect(page.locator(".blueprint-node.condition_test")).toHaveCount(
      name === "mixedTest" ? 3 : 2,
    );
    await expect(
      page.locator(".blueprint-node.role-ast_projection"),
    ).toHaveCount(0);
    const method = analysis.graph.methods.find((m: any) =>
      m.signature.startsWith(name + "("),
    );
    const atoms = analysis.graph.nodes.filter(
      (n: any) =>
        n.methodId === method.id && n.executionRole === "condition_test",
    );
    for (const atom of atoms) {
      expect(atom.allowedOperations).toEqual([]);
      expect(atom.editableFields).toEqual([]);
    }
    const a = atoms.find((n: any) => n.label === "a()");
    const b = atoms.find((n: any) => n.label === "b()");
    if (name === "andTest" || name === "orTest")
      expect(
        analysis.graph.edges.some(
          (e: any) =>
            e.source === a.id &&
            e.target === b.id &&
            e.kind === (name === "andTest" ? "true" : "false"),
        ),
      ).toBe(true);
    await panToNode(page, page.locator(".blueprint-node.condition_test").first());
    await page.locator(".blueprint-node.condition_test").first().click();
    await expect(page.locator(".inspector-selection")).toContainText(
      "Проверка",
    );
    await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
    await expect(
      page.locator(".monaco-editor .code-binding").first(),
    ).toBeVisible();
    await expect(
      page
        .locator(".react-flow__edge-text, .shortcut-label, .graph-port-true")
        .filter({ hasText: "да" })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .locator(".react-flow__edge-text, .shortcut-label, .graph-port-false")
        .filter({ hasText: "нет" })
        .first(),
    ).toBeVisible();
    const overlaps = await page
      .locator(".react-flow__node:not(.react-flow__node-loopArea)")
      .evaluateAll((nodes) => {
        const boxes = nodes.map((n) => ({
          id: n.getAttribute("data-id"),
          r: n.getBoundingClientRect(),
        }));
        return boxes.flatMap((a, i) =>
          boxes
            .slice(i + 1)
            .filter(
              (b) =>
                a.r.left < b.r.right &&
                a.r.right > b.r.left &&
                a.r.top < b.r.bottom &&
                a.r.bottom > b.r.top,
            )
            .map((b) => [a.id, b.id]),
        );
      });
    expect(overlaps).toEqual([]);
    await assertRoutes(page);
  }
  await page.locator(".method-item").filter({ hasText: "mixedTest(" }).click();
  await page.getByRole("tab", { name: "Схема", exact: true }).click();
  for (const theme of ["dark", "light"]) {
    const toggle = page.getByRole("button", {
      name: theme === "dark" ? "Включить тёмную тему" : "Включить светлую тему",
    });
    if (await toggle.count()) await toggle.click();
    await page.screenshot({
      path: testInfo.outputPath("conditions-" + theme + ".png"),
      animations: "disabled",
    });
  }
  await expect
    .poll(async () =>
      page
        .locator(".react-flow__viewport")
        .evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).a,
        ),
    )
    .toBeCloseTo(0.85, 2);
  await page.locator(".react-flow__controls-fitview").click();
  await expect
    .poll(async () =>
      page
        .locator(".react-flow__viewport")
        .evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).a,
        ),
    )
    .toBeLessThan(0.85);
  await page.screenshot({
    path: testInfo.outputPath("conditions-overview.png"),
    animations: "disabled",
  });
  // Re-enter the method to restore the readable entry viewport before narrow-screen QA.
  await page.locator(".method-item").filter({ hasText: "orTest(" }).click();
  await page.locator(".method-item").filter({ hasText: "mixedTest(" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".blueprint-node.entry")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("conditions-narrow.png") });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.locator(".method-item").filter({ hasText: "andTest(" }).click();
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  await expect(page.locator(".blueprint-node.IfStmt .node-label")).toHaveText(
    "Если",
  );
  await expect(page.getByLabel("Условие", { exact: true })).toHaveValue(
    "a() && b()",
  );
  const caps = (await (await page.request.get("/api/v1/capabilities")).json())
    .data;
  test.skip(!caps.runner.available, "Docker compiler unavailable");
  await page.getByLabel("Условие", { exact: true }).fill("a() || b()");
  await page.getByRole("button", { name: "Подготовить изменение" }).click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(head);
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base)).json()).data.headRevisionId,
    )
    .not.toBe(head);
  await page.reload();
  await page.locator(".method-item").filter({ hasText: "andTest(" }).click();
  await expect(page.locator(".blueprint-node.condition_test")).toHaveCount(2);
  await panToNode(page, page.locator(".blueprint-node.IfStmt"));
  await page.locator(".blueprint-node.IfStmt").click();
  const current = (await (await page.request.get(base)).json()).data
    .headRevisionId;
  const snapshot = (
    await (await page.request.get(base + "/revisions/" + current)).json()
  ).data;
  const candidateAnalysis = (
    await (
      await page.request.get(base + "/revisions/" + current + "/analysis")
    ).json()
  ).data;
  const editedMethod = candidateAnalysis.graph.methods.find((m: any) =>
    m.signature.startsWith("andTest("),
  );
  const editedHeader = candidateAnalysis.graph.nodes.find(
    (n: any) => n.methodId === editedMethod.id && n.kind === "IfStmt",
  );
  const bound = editedHeader.editableFieldRanges.condition;
  const canonicalCondition = snapshot.files
    .find((file: any) => file.path === bound.filePath)
    .canonicalText.slice(bound.startOffset, bound.endOffset);
  expect(canonicalCondition).toContain("a() || b()");
  await expect(page.getByLabel("Условие", { exact: true })).toHaveValue(
    canonicalCondition,
  );
  // Persist a nonoverlapping dragged-layout counterexample: a fixed y+22 escape crossed B.
  const layoutPath = base + "/revisions/" + current + "/layout";
  const saved = (
    await (
      await page.request.get(
        layoutPath +
          "?analysisId=" +
          candidateAnalysis.id +
          "&methodId=" +
          editedMethod.id,
      )
    ).json()
  ).data;
  const methodNodes = candidateAnalysis.graph.nodes.filter(
    (node: any) =>
      node.methodId === editedMethod.id &&
      node.executionRole !== "ast_projection",
  );
  const atomA = methodNodes.find(
    (node: any) => node.kind === "condition_test" && node.label === "a()",
  );
  const atomB = methodNodes.find(
    (node: any) => node.kind === "condition_test" && node.label === "b()",
  );
  const skip = candidateAnalysis.graph.edges.find(
    (edge: any) => edge.source === atomA.id && edge.kind === "true",
  );
  const csrf = (await (await page.request.get("/api/v1/session")).json()).data
    .csrfToken;
  const response = await page.request.put(layoutPath, {
    headers: { Origin: "http://127.0.0.1:5174", "X-CSRF-Token": csrf },
    data: {
      analysisId: candidateAnalysis.id,
      methodId: editedMethod.id,
      sourceMapVersion: candidateAnalysis.sourceMapVersion,
      layoutVersion: saved.layoutVersion,
      positions: methodNodes.map((node: any, index: number) => ({
        nodeId: node.id,
        ...(node.id === atomA.id
          ? { x: 320, y: 0 }
          : node.id === atomB.id
            ? { x: 640, y: 80 }
            : node.id === skip.target
              ? { x: 320, y: 290 }
              : { x: 1000, y: 600 + index * 145 }),
      })),
      collapsedNodeIds: [],
      viewport: { x: 0, y: 35, zoom: 0.85 },
    },
  });
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(page.locator("g[data-shortcut-source]")).not.toHaveCount(0);
  await assertRoutes(page);
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(current);
  await page.screenshot({
    path: testInfo.outputPath("conditions-saved-layout.png"),
    animations: "disabled",
  });
});
