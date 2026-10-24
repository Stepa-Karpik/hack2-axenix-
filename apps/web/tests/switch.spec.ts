import { setTheme } from "./flowAssertions";
import { test, expect } from "@playwright/test";
import { assertRoutes, panToNode as panTo } from "./flowAssertions";
const source = `public class Main {
  static int choose(int value) {
    int result = 0;
    switch (value) {
      case 1:
        result += 1;
      default:
        result += 10;
      case 2:
        result += 100;
        break;
      case 3, /* grouped: raw */ 4:
        result += 1000;
    }
    return result;
  }
  static int nested(int value) {
    int result = 0;
    for (int i = 0; i < 2; i++) {
      switch (value) {
        case 1: continue;
        default: break;
      }
      result++;
    }
    return result;
  }
  static int text(String value) {
    switch (value) {
      case "colon: && || long raw string constant for title": return 1;
      default: return 0;
    }
  }
  static int fanout(int value) {
    switch (value) {
      case 0: return 0;
      case 1: return 1;
      case 2: return 2;
      case 3: return 3;
      case 4: return 4;
      case 5: return 5;
      case 6: return 6;
      case 7: return 7;
      case 8: return 8;
      default: return -1;
    }
  }
  static int unmatched(int value) {
    switch (value) { case 1: return 1; }
    return 0;
  }
}
`;
test("traditional switch dispatch, fallthrough, source bindings and immutable candidate apply", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Switch UI " + Date.now());
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
  expect(analysis.analyzerVersion).toBe("engine-0.8.0");
  const graph = analysis.graph;
  const method = (name: string) =>
    graph.methods.find((method: any) =>
      method.signature.startsWith(name + "("),
    );
  const nodes = (name: string) =>
    graph.nodes.filter((node: any) => node.methodId === method(name).id);
  const byId = new Map<string, any>(
    graph.nodes.map((node: any) => [node.id, node]),
  );
  const out = (id: string) =>
    graph.edges.filter((edge: any) => edge.source === id);
  const selectors = nodes("choose").filter(
    (node: any) => node.kind === "switch_selector",
  );
  expect(selectors).toHaveLength(1);
  const selector = selectors[0];
  expect(selector.executionRole).toBe("statement");
  const alternatives = out(selector.id);
  expect(
    alternatives.filter((edge: any) => edge.kind === "default"),
  ).toHaveLength(1);
  expect(alternatives.filter((edge: any) => edge.kind === "case")).toHaveLength(
    3,
  );
  const grouped = alternatives.find((edge: any) =>
    edge.label.includes("grouped: raw"),
  );
  expect(grouped.label).toBe("3, /* grouped: raw */ 4");
  const defaultNode = byId.get(
    alternatives.find((edge: any) => edge.kind === "default").target,
  );
  expect(defaultNode.label).toBe("default:");
  const defaultBody = byId.get(out(defaultNode.id)[0].target);
  const following = byId.get(out(defaultBody.id)[0].target);
  expect(following.kind).toBe("switch_case");
  expect(following.label).toBe("case 2:");
  const breakNode = nodes("choose").find(
    (node: any) => node.kind === "BreakStmt",
  );
  expect(byId.get(out(breakNode.id)[0].target).kind).toBe("ReturnStmt");
  const continuation = nodes("nested").find(
    (node: any) => node.kind === "ContinueStmt",
  );
  expect(byId.get(out(continuation.id)[0].target).kind).toBe("for_update");
  const nestedBreak = nodes("nested").find(
    (node: any) => node.kind === "BreakStmt",
  );
  expect(byId.get(out(nestedBreak.id)[0].target).label).toContain("result++");
  const unmatched = nodes("unmatched").find(
    (node: any) => node.kind === "switch_selector",
  );
  expect(
    out(unmatched.id).find((edge: any) => edge.kind === "default").label,
  ).toBe("нет совпадения");
  await page.locator(".method-item").filter({ hasText: "fanout(" }).click();
  await page.reload();
  await page.locator(".method-item").filter({ hasText: "fanout(" }).click();
  await page.getByRole("button", { name: "Схема", exact: true }).click();
  const fanoutLabels = page.locator(".shortcut-label");
  await expect(fanoutLabels).toHaveCount(10);
  const overlap = await fanoutLabels.evaluateAll((elements) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    return boxes.flatMap((a, i) =>
      boxes
        .slice(i + 1)
        .flatMap((b, offset) =>
          a.left < b.right &&
          b.left < a.right &&
          a.top < b.bottom &&
          b.top < a.bottom
            ? [[i, i + offset + 1]]
            : [],
        ),
    );
  });
  expect(overlap).toEqual([]);
  expect(
    await fanoutLabels.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("title")).sort(),
    ),
  ).toEqual(
    [
      ...Array.from({ length: 9 }, (_, index) => String(index)),
      "default",
    ].sort(),
  );
  await assertRoutes(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.screenshot({
    path: testInfo.outputPath("switch-fanout.png"),
    animations: "disabled",
  });
  await page.locator(".method-item").filter({ hasText: "choose(" }).click();
  await page.getByRole("button", { name: "Схема", exact: true }).click();
  const selectorElement = page.locator(".blueprint-node.switch_selector");
  await panTo(page, selectorElement);
  await selectorElement.click();
  await expect(page.locator(".inspector-selection")).toContainText("Значение");
  await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Перейти к коду" }).click();
  await expect(
    page.locator(".monaco-editor .code-binding").first(),
  ).toBeVisible();
  const caseElement = page.locator(
    '.react-flow__node[data-id="' + defaultNode.id + '"] .blueprint-node',
  );
  await panTo(page, caseElement);
  await caseElement.click();
  await expect(page.getByLabel("Действие", { exact: true })).toHaveCount(0);
  await expect(page.locator(".inspector-selection")).toContainText("default:");
  await page.getByRole("button", { name: "Перейти к коду" }).click();
  await expect(
    page.locator(".monaco-editor .code-binding").first(),
  ).toBeVisible();
  await expect(
    page.locator('.shortcut-label[title="' + grouped.label + '"]'),
  ).toHaveText(grouped.label);
  await assertRoutes(page);
  await page.locator(".method-item").filter({ hasText: "text(" }).click();
  await page.getByRole("button", { name: "Схема", exact: true }).click();
  await panTo(page, page.locator(".blueprint-node.switch_selector"));
  const raw = out(
    nodes("text").find((node: any) => node.kind === "switch_selector").id,
  ).find((edge: any) => edge.kind === "case").label;
  const label = page.locator(".shortcut-label").filter({ hasText: /colon:/ });
  await expect(label).toHaveAttribute("title", raw);
  await expect(label).toContainText("…");
  await assertRoutes(page);
  await expect(page.locator(".blueprint-node.switch_case")).toHaveCount(2);
  const caseCaptionOverlap = await page
    .locator(".blueprint-node.switch_case")
    .evaluateAll((elements) =>
      elements.some((element) => {
        const label = element
          .querySelector(".node-label")!
          .getBoundingClientRect();
        const line = element
          .querySelector(".structural-line")!
          .getBoundingClientRect();
        return label.right > line.left;
      }),
    );
  expect(caseCaptionOverlap).toBe(false);
  for (const theme of ["dark", "light"]) {
    await setTheme(page, theme);
    await page.screenshot({
      path: testInfo.outputPath("switch-" + theme + ".png"),
      animations: "disabled",
    });
  }
  await page.locator(".react-flow__controls-fitview").click();
  await page.screenshot({
    path: testInfo.outputPath("switch-overview.png"),
    animations: "disabled",
  });
  await page.locator(".method-item").filter({ hasText: "choose(" }).click();
  await panTo(page, page.locator(".blueprint-node.switch_selector"));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("switch-narrow.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1512, height: 982 });
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(head);
  if (!(await page.locator(".inspector").count()))
    await page.getByRole("button", { name: "Переключить инспектор" }).click();
  await page.locator(".node-access summary").click();
  await page
    .locator(".node-access")
    .getByRole("button", { name: "Выражение · 100", exact: true })
    .click();
  await expect(page.getByLabel("Выражение", { exact: true })).toHaveValue(
    "100",
  );
  const caps = (await (await page.request.get("/api/v1/capabilities")).json())
    .data;
  test.skip(!caps.runner.available, "Docker compiler unavailable");
  await page.getByLabel("Выражение", { exact: true }).fill("200");
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
  await page.locator(".method-item").filter({ hasText: "choose(" }).click();
  await expect(page.locator(".blueprint-node.switch_selector")).toHaveCount(1);
  await expect(page.locator(".blueprint-node.switch_case")).toHaveCount(4);
  const current = (await (await page.request.get(base)).json()).data
    .headRevisionId;
  const snapshot = (
    await (await page.request.get(base + "/revisions/" + current)).json()
  ).data;
  expect(snapshot.files[0].canonicalText).toContain("200");
  expect(
    (await (await page.request.get(base + "/revisions/" + head)).json()).data
      .files[0].canonicalText,
  ).toBe(source);
});
