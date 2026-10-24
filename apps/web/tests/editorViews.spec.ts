import { test, expect } from "@playwright/test";
import { headers, head } from "./fileFixtures";
const source =
  "public class Main {\n  public static void main(String[] args) {\n" +
  Array.from({ length: 90 }, (_, i) => `    int value${i} = ${i};`).join("\n") +
  "\n  }\n}\n";
test("fresh project never inherits the caret of another project with the same filename", async ({
  page,
}) => {
  async function make() {
    const made = await page.request.post("/api/v1/projects", {
      headers: await headers(page.request),
      data: { name: "Editor views " + crypto.randomUUID() },
    });
    expect(made.status()).toBe(201);
    const id = (await made.json()).data.id,
      base = "/api/v1/projects/" + id;
    const saved = await page.request.post(base + "/revisions", {
      headers: await headers(page.request, "empty"),
      data: {
        files: [{ path: "Main.java", content: source }],
        intent: "semantic_edit",
      },
    });
    expect(saved.status()).toBe(201);
    return { id, base, revision: (await saved.json()).data };
  }
  const a = await make(),
    b = await make();
  await page.goto("/projects/" + a.id);
  await expect(page.locator(".monaco-editor")).toContainText(
    "public class Main",
    { timeout: 30000 },
  );
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(250);
  await page.goto("/projects/" + b.id);
  await expect(page.locator(".monaco-editor")).toContainText(
    "public class Main",
  );
  await editor.focus();
  await page.keyboard.insertText("// B CARET\n");
  await page.keyboard.press("Control+s");
  await expect
    .poll(async () => (await head(page.request, b.base)).files[0].canonicalText)
    .toContain("// B CARET");
  expect(
    (await head(page.request, b.base)).files[0].canonicalText.startsWith(
      "// B CARET\n",
    ),
  ).toBe(true);
  expect((await head(page.request, b.base)).files[0].canonicalText).toBe(
    "// B CARET\n" + source,
  );
  expect((await head(page.request, a.base)).id).toBe(a.revision.id);
});
test("saved caret returns after a delayed source response without creating an empty editor model", async ({
  page,
}) => {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Editor reload " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [{ path: "Main.java", content: source }],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const revision = (await saved.json()).data;
  await page.goto("/projects/" + id);
  await expect(page.locator(".monaco-editor")).toContainText(
    "public class Main",
  );
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+Home");
  for (let line = 0; line < 45; line++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          JSON.parse(
            localStorage.getItem(
              "java-blueprints:editor-view:" + id + "/Main.java",
            ) ?? "null",
          )?.cursorState?.[0]?.position?.lineNumber ?? 0,
        id,
      ),
    )
    .toBe(46);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    arrived = new Promise<void>((r) => (seen = r));
  await page.route("**/revisions/" + revision.id, async (route) => {
    const response = await route.fetch();
    seen();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.reload();
    await arrived;
    await expect(page.locator(".monaco-editor")).not.toBeVisible();
    await expect(
      page.getByText("Загрузка исходника…", { exact: true }),
    ).toBeVisible();
    release();
    await expect(page.locator('[data-file-path="Main.java"]')).toBeVisible();
    await expect(page.locator(".local-label")).toHaveText("Сохранено", {
      timeout: 30000,
    });
    await expect(page.locator(".monaco-editor")).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "value43",
    );
    await editor.focus();
    await page.keyboard.insertText("// RESTORED END\n");
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () => (await head(page.request, base)).files[0].canonicalText)
      .toContain("// RESTORED END");
    const lines = source.split("\n");
    lines.splice(45, 0, "// RESTORED END");
    expect((await head(page.request, base)).files[0].canonicalText).toBe(
      lines.join("\n"),
    );
  } finally {
    release();
  }
});
