import { setTheme } from "./flowAssertions";
import { test, expect } from "@playwright/test";
import {
  assertRoutes,
  panToNode as panTo,
  revealPanel,
} from "./flowAssertions";
const source = `import java.util.List;
public class Main {
  static int array(int[] values, int[] alternative) {
    int result = 0;
    for (int value : values) {
      if (value < 0) continue;
      switch (value) {
        case 0: continue;
        case 1: break;
        default: result += 10;
      }
      result += value;
    }
    return result;
  }
  static int iterable(List<Integer> values) {
    int result = 0;
    for (Integer value : values) {
      if (value == null) continue;
      result += value;
    }
    return result;
  }
}
`;
test("enhanced-for abstraction, readonly synthetic nodes and source candidate apply", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page
    .getByLabel("Название проекта")
    .fill("Enhanced for UI " + Date.now());
  await page
    .locator("input[type=file]")
    .setInputFiles({
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
  expect(analysis.analyzerVersion).toBe("engine-0.7.0");
  let layoutWrites = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/layout"))
      layoutWrites++;
  });
  const graph = analysis.graph;
  const byId = new Map<string, any>(
    graph.nodes.map((node: any) => [node.id, node]),
  );
  const out = (id: string) =>
    graph.edges.filter((edge: any) => edge.source === id);
  for (const name of ["array", "iterable"]) {
    const method = graph.methods.find((method: any) =>
      method.signature.startsWith(name + "("),
    );
    const nodes = graph.nodes.filter(
      (node: any) => node.methodId === method.id,
    );
    const node = (kind: string) =>
      nodes.find((node: any) => node.kind === kind);
    const sourceNode = node("foreach_source"),
      check = node("foreach_check"),
      bind = node("foreach_bind"),
      advance = node("foreach_advance");
    expect(
      nodes.filter((node: any) => node.kind === "foreach_source"),
    ).toHaveLength(1);
    expect(sourceNode.executionRole).toBe("statement");
    expect(
      source.slice(
        sourceNode.sourceRange.startOffset,
        sourceNode.sourceRange.endOffset,
      ),
    ).toBe("values");
    expect(out(sourceNode.id).map((edge: any) => edge.target)).toContain(
      check.id,
    );
    expect(out(check.id).find((edge: any) => edge.kind === "true").target).toBe(
      bind.id,
    );
    expect(out(advance.id).map((edge: any) => edge.target)).toContain(check.id);
    expect(
      graph.edges.some(
        (edge: any) =>
          edge.target === sourceNode.id &&
          [check.id, bind.id, advance.id].includes(edge.source),
      ),
    ).toBe(false);
    for (const synthetic of [check, bind, advance]) {
      expect(synthetic.executionRole).toBe("synthetic");
      expect(synthetic.sourceRange).toBeNull();
      expect(synthetic.allowedOperations).toEqual([]);
      expect(synthetic.editableFields).toEqual([]);
    }
    for (const continuation of nodes.filter(
      (node: any) => node.kind === "ContinueStmt",
    ))
      expect(out(continuation.id).map((edge: any) => edge.target)).toContain(
        advance.id,
      );
    if (name === "array") {
      const switchBreak = node("BreakStmt");
      expect(byId.get(out(switchBreak.id)[0].target).label).toContain(
        "result += value",
      );
    }
    await page
      .locator(".method-item")
      .filter({ hasText: name + "(" })
      .click();
    await page.getByRole("button", { name: "Схема", exact: true }).click();
    await expect(
      page.locator(".blueprint-node.ForEachStmt .node-label"),
    ).toHaveText("Обход");
    const sourceElement = page.locator(".blueprint-node.foreach_source");
    await panTo(page, sourceElement);
    await sourceElement.click();
    await expect(page.locator(".inspector-selection")).toContainText(
      "Источник",
    );
    await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Перейти к коду" }).click();
    await expect(
      page.locator(".monaco-editor .code-binding").first(),
    ).toBeVisible();
    for (const [kind, caption] of [
      ["foreach_check", "Есть элемент?"],
      ["foreach_bind", "Элемент"],
      ["foreach_advance", "Следующая итерация"],
    ]) {
      const element = page.locator(".blueprint-node." + kind);
      await panTo(page, element);
      await element.click();
      await expect(element.locator(".node-label")).toHaveText(caption);
      await expect(element).toHaveText(
        kind === "foreach_check" ? caption + "данет" : caption,
      );
      await expect(element.locator(".node-meta")).toHaveCount(0);
      await expect(page.locator(".inspector-selection")).toContainText(
        "Служебный узел",
      );
      const selection = page.locator(".inspector-selection");
      await expect(selection.locator(".eyebrow")).toHaveText(caption);
      await expect(selection.locator("h2")).toHaveCount(0);
      const captionBox = (await selection.locator(".eyebrow").boundingBox())!;
      const statusBox = (await selection
        .locator(".quiet.small")
        .boundingBox())!;
      expect(statusBox.y).toBeGreaterThanOrEqual(
        captionBox.y + captionBox.height,
      );
      await expect(
        page.getByRole("button", { name: "Перейти к коду" }),
      ).toHaveCount(0);
      await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
      await expect(page.locator(".monaco-editor .code-binding")).toHaveCount(0);
    }
    await assertRoutes(page);
  }
  expect(layoutWrites).toBe(0);
  await page.getByRole("button", { name: "Схема", exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await panTo(page, page.locator(".blueprint-node.foreach_check"));
  await expect(page.locator(".blueprint-node.foreach_check")).toBeInViewport();
  for (const theme of ["dark", "light"]) {
    await setTheme(page, theme);
    await page.screenshot({
      path: testInfo.outputPath("enhanced-for-" + theme + ".png"),
      animations: "disabled",
    });
  }
  await page.locator(".react-flow__controls-fitview").click();
  await page.screenshot({
    path: testInfo.outputPath("enhanced-for-overview.png"),
    animations: "disabled",
  });
  await page.locator(".method-item").filter({ hasText: "array(" }).click();
  await page.locator(".method-item").filter({ hasText: "iterable(" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await panTo(page, page.locator(".blueprint-node.foreach_check"));
  await expect(page.locator(".blueprint-node.foreach_check")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("enhanced-for-narrow.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1512, height: 982 });
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(head);
  await page.locator(".method-item").filter({ hasText: "array(" }).click();
  await revealPanel(page, "analysis", "Инспектор");
  await page.locator(".node-access summary").click();
  await page
    .locator(".node-access")
    .getByRole("button", { name: "Выражение · values", exact: true })
    .click();
  await expect(page.getByLabel("Выражение", { exact: true })).toHaveValue(
    "values",
  );
  const caps = (await (await page.request.get("/api/v1/capabilities")).json())
    .data;
  test.skip(!caps.runner.available, "Docker compiler unavailable");
  await page.getByLabel("Выражение", { exact: true }).fill("alternative");
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
  await page.locator(".method-item").filter({ hasText: "array(" }).click();
  await expect(
    page.locator(".blueprint-node.foreach_source .node-label"),
  ).toHaveText("(alternative)");
  await expect(page.locator(".blueprint-node.foreach_check")).toHaveCount(1);
  await assertRoutes(page);
  const current = (await (await page.request.get(base)).json()).data
    .headRevisionId;
  const snapshot = (
    await (await page.request.get(base + "/revisions/" + current)).json()
  ).data;
  const updated = (
    await (
      await page.request.get(base + "/revisions/" + current + "/analysis")
    ).json()
  ).data;
  const arrayMethod = updated.graph.methods.find((method: any) =>
    method.signature.startsWith("array("),
  );
  const bound = updated.graph.nodes.find(
    (node: any) =>
      node.methodId === arrayMethod.id && node.kind === "foreach_source",
  ).sourceRange;
  expect(
    snapshot.files[0].canonicalText.slice(bound.startOffset, bound.endOffset),
  ).toBe("(alternative)");
  expect(
    (await (await page.request.get(base + "/revisions/" + head)).json()).data
      .files[0].canonicalText,
  ).toBe(source);
});
