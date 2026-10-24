import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel, panToNode, setTheme } from "./flowAssertions";

const longSource = `public class Main {
  static int calculate(int limit) {
    int value = 0;
${"    value++;\n".repeat(41)}    for (int i=0; i<limit; i++) {
      for (int j=0; j<2; j++) {
        if (i>0) { if (j>0) { value++; } }
      }
    }
${"    if (value>0) value++;\n".repeat(10)}    return value;
  }
  public static void main(String[] args) { System.out.println(calculate(2)); }
}\n`;

async function fixture(page: Page) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Code insights " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const save = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [
        { path: "Main.java", content: longSource },
        {
          path: "Helper.java",
          content: "class Helper { static int answer() { return 42; } }\n",
        },
      ],
      intent: "semantic_edit",
    },
  });
  expect(save.status()).toBe(201);
  const revision = (await save.json()).data;
  await page.goto("/projects/" + id);
  await expect(
    page.getByRole("button", { name: "calculate(int)", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page
    .getByRole("button", { name: "calculate(int)", exact: true })
    .click();
  await revealPanel(page, "analysis", "Анализ");
  const panel = page.locator('[data-panel-id="analysis"]');
  const analysis = (
    await (
      await page.request.get(base + "/revisions/" + revision.id + "/analysis")
    ).json()
  ).data;
  expect(analysis.analyzerVersion).toBe("engine-0.12.0");
  return { id, base, revision, panel, analysis };
}

test("metrics and recommendations use actual method/source bindings without mutating the project", async ({
  page,
}, info) => {
  const f = await fixture(page);
  const { panel } = f;
  const metric = f.analysis.quality.methods.find(
    (m: { methodId: string }) =>
      m.methodId ===
      f.analysis.graph.methods.find(
        (m: { signature: string }) => m.signature === "calculate(int)",
      ).id,
  );
  expect(f.analysis.quality.findings).toHaveLength(4);
  expect(f.analysis.diagnostics).toHaveLength(0);
  await panel.getByRole("tab", { name: "Метрики", exact: true }).click();
  await page.keyboard.press("Home");
  await expect(
    panel.getByRole("tab", { name: "Узел", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    panel.getByRole("tab", { name: "Метрики", exact: true }),
  ).toBeFocused();
  const metrics = panel.getByRole("region", { name: "Метрики метода" });
  await expect(metrics).toHaveAttribute("data-method-id", metric.methodId);
  await expect(
    metrics
      .locator("dl > div")
      .filter({ has: page.locator("dt").filter({ hasText: /^Строк кода$/ }) })
      .locator("dd"),
  ).toHaveText(String(metric.codeLines));
  await expect(metrics).toContainText("Не определена");
  await expect(metrics).not.toContainText("O(n");
  await setTheme(page, "dark");
  await page.screenshot({
    path: info.outputPath("method-metrics-dark.png"),
    animations: "disabled",
  });
  await panel.getByRole("tab", { name: /^Рекомендации/ }).click();
  await expect(panel.locator(".insight-finding")).toHaveCount(4);
  const finding = panel.locator('[data-finding-code="NESTED_LOOPS"]');
  await finding.locator("summary").click();
  await expect(finding).toContainText("ускорение не гарантируется");
  await finding.getByRole("button").click();
  await expect(page.locator(".view-lines")).toContainText(
    "for (int j=0; j<2; j++)",
  );
  await expect(page.locator(".code-binding").first()).toBeVisible();
  await page.getByRole("button", { name: "Helper.java", exact: true }).click();
  await panel.getByRole("tab", { name: "Метрики", exact: true }).click();
  await expect(metrics).toContainText("answer()");
  await expect(
    metrics
      .locator("dl > div")
      .filter({ has: page.locator("dt").filter({ hasText: /^Циклов$/ }) })
      .locator("dd"),
  ).toHaveText("0");
  expect((await head(page.request, f.base)).id).toBe(f.revision.id);
  await setTheme(page, "light");
  await page.screenshot({
    path: info.outputPath("method-metrics-light.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Открытая панель").selectOption("analysis");
  await expect(metrics).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("method-metrics-narrow.png"),
    animations: "disabled",
  });
});

test("dirty source disables old insight navigation and a selected graph node restores its edit form", async ({
  page,
}) => {
  const f = await fixture(page);
  const { panel } = f;
  await panel.getByRole("tab", { name: /^Рекомендации/ }).click();
  const editor = page.locator("textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("// new draft\n");
  await expect(panel.locator(".finding-location").first()).toBeDisabled();
  await expect(
    panel.getByText("Показан сохранённый анализ", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(panel.locator(".finding-location").first()).toBeEnabled({
    timeout: 30000,
  });
  await panel.getByRole("tab", { name: "Метрики", exact: true }).click();
  const node = page
    .locator(".blueprint-node")
    .filter({ hasText: "int value = 0" });
  await panToNode(page, node);
  await node.dblclick();
  await expect(
    panel.getByRole("tab", { name: "Узел", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Код блока", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Код блока", { exact: true })).toBeFocused();
  const saved = await head(page.request, f.base);
  expect(
    saved.files.find((file) => file.path === "Main.java")!.canonicalText,
  ).toBe("// new draft\n" + longSource);
});
