import { publishProject } from "./flowAssertions";
import { setTheme } from "./flowAssertions";
import { revealPanel } from "./flowAssertions";
import { test, expect, type Page } from "@playwright/test";

const mainSource = `public class Main {
    int value = 1;
    int use(int value) {
        this.value = value;
        System.out.println(value);
        return Helper.twice(this.value);
    }
    int localUse() {
        int value = 2;
        return value;
    }
    void unknown() {
        Missing.call();
    }
}
`;
const helperSource = `public class Helper {
    public static int twice(int value) { return value * 2; }
    public static String twice(String value) { return value + value; }
}
`;
async function cursor(page: Page, source: string, offset: number) {
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  for (let i = 1; i < lines.length; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  // Home may land at the first non-whitespace column; press twice to reach column 1.
  await page.keyboard.press("Home");
  for (let i = 0; i < lines.at(-1)!.length; i++)
    await page.keyboard.press("ArrowRight");
}

test("symbol identities, cross-file declarations and stale binding guards", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Название проекта").fill("Symbols UI " + Date.now());
  await page.locator("input[type=file]").setInputFiles([
    {
      name: "Main.java",
      mimeType: "text/x-java-source",
      buffer: Buffer.from(mainSource),
    },
    {
      name: "Helper.java",
      mimeType: "text/x-java-source",
      buffer: Buffer.from(helperSource),
    },
  ]);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 30000,
  });
  const base = "/api/v1/projects/" + page.url().split("/projects/")[1];
  const project = (await (await page.request.get(base)).json()).data;
  const revision = (
    await (
      await page.request.get(base + "/revisions/" + project.headRevisionId)
    ).json()
  ).data;
  const analysis = (
    await (
      await page.request.get(base + "/revisions/" + revision.id + "/analysis")
    ).json()
  ).data;
  const semantics = analysis.semantics;
  expect(semantics).toBeTruthy();
  const symbols = new Map<string, any>(
    semantics.symbols.map((s: any) => [s.id, s]),
  );
  const refs: any[] = semantics.references;
  const source = revision.files.find(
    (f: any) => f.path === "Main.java",
  ).canonicalText;
  const inside = (reference: any) => {
    const position = source.indexOf(
      reference.name,
      reference.sourceRange.startOffset,
    );
    return position >= reference.sourceRange.startOffset &&
      position < reference.sourceRange.endOffset
      ? position + Math.min(1, reference.name.length - 1)
      : reference.sourceRange.startOffset;
  };
  await page.locator(".file-item").filter({ hasText: "Main.java" }).click();
  for (const kind of ["field", "parameter", "local"]) {
    const ref = refs.find(
      (r) =>
        r.sourceRange.filePath === "Main.java" &&
        r.resolution === "exact" &&
        r.name === "value" &&
        symbols.get(r.targetIds[0])?.kind === kind,
    );
    expect(ref, kind + " reference").toBeTruthy();
    await cursor(page, source, inside(ref));
    await expect(page.locator(".symbol-detail")).toHaveAttribute(
      "data-reference-id",
      ref.id,
    );
    await expect(page.locator(".symbol-target")).toHaveAttribute(
      "data-symbol-id",
      ref.targetIds[0],
    );
    await expect(
      page.getByRole("button", { name: "К объявлению", exact: true }),
    ).toBeVisible();
  }
  await page.locator(".symbol-inspector").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("symbols-source-target.png"),
  });
  const crossFile = refs.find(
    (r) =>
      r.name === "twice" &&
      r.resolution === "exact" &&
      symbols.get(r.targetIds[0])?.sourceRange?.filePath === "Helper.java",
  );
  expect(crossFile).toBeTruthy();
  await cursor(page, source, inside(crossFile));
  await expect(page.locator(".symbol-detail")).toHaveAttribute(
    "data-reference-id",
    crossFile.id,
  );
  await page.getByRole("button", { name: "К объявлению", exact: true }).click();
  await expect(page.locator(".canvas-breadcrumb")).toContainText("Helper.java");
  await expect(page.locator(".monaco-editor")).toContainText("value * 2");
  await expect(
    page.locator(".monaco-editor .code-binding").first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("symbols-cross-file.png"),
  });
  await page.locator(".file-item").filter({ hasText: "Main.java" }).click();
  const external = refs.find(
    (r) =>
      r.name === "println" &&
      r.resolution === "exact" &&
      symbols.get(r.targetIds[0])?.external,
  );
  expect(external).toBeTruthy();
  await cursor(page, source, inside(external));
  await expect(page.locator(".symbol-detail")).toHaveAttribute(
    "data-reference-id",
    external.id,
  );
  await expect(page.locator(".symbol-target")).toContainText("println");
  await expect(
    page.getByRole("button", { name: "К объявлению", exact: true }),
  ).toHaveCount(0);
  if (external.dispatch === "virtual")
    await expect(page.locator(".symbol-detail")).toContainText(
      "цель выполнения зависит от объекта",
    );
  const unresolved = refs.find(
    (r) =>
      r.sourceRange.filePath === "Main.java" && r.resolution === "unresolved",
  );
  expect(unresolved).toBeTruthy();
  await cursor(page, source, inside(unresolved));
  await expect(page.locator(".symbol-detail")).toContainText("Не разрешено");
  await expect(
    page.getByRole("button", { name: "К объявлению", exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await page.request.get(base)).json()).data.headRevisionId,
  ).toBe(project.headRevisionId);
  for (const theme of ["dark", "light"]) {
    await setTheme(page, theme);
    await cursor(page, source, inside(external));
    await page.locator(".symbol-inspector").scrollIntoViewIfNeeded();
    expect(
      await page.locator(".symbol-reference-list button").count(),
    ).toBeLessThanOrEqual(20);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("symbols-" + theme + ".png"),
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await revealPanel(page, "analysis", "Инспектор");
  await page.locator(".symbol-inspector").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("symbols-narrow.png") });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("public class Main { invalid ! }");
  await expect(page.locator(".symbol-inspector")).toContainText(
    "Привязки устарели",
  );
  await expect(page.locator(".symbol-detail")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "К объявлению", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".monaco-editor .code-binding")).toHaveCount(0);
  await publishProject(page);
  await expect(
    page.getByText("Исходник сохранён · ошибка разбора"),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".symbol-detail")).toHaveCount(0);
});

test("older analysis without semantics remains navigable without symbol bindings", async ({
  page,
}) => {
  await page.goto("/");
  await page.route("**/revisions/*/analysis", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.data) delete json.data.semantics;
    await route.fulfill({ response, json });
  });
  await page
    .getByLabel("Название проекта")
    .fill("Legacy symbols UI " + Date.now());
  await page.getByRole("button", { name: "Начать с примера" }).click();
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 30000,
  });
  await page
    .locator(".method-item")
    .filter({ hasText: /^main\(/ })
    .click();
  await page.locator(".blueprint-node.entry").click();
  await expect(page.locator(".symbol-inspector")).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await page.unroute("**/revisions/*/analysis");
  await page.reload();
  await expect(page.locator(".symbol-inspector")).toBeVisible({
    timeout: 30000,
  });
});
