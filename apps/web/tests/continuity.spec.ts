import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";
const source = `import java.util.ArrayList;
public class Main {
  public static void main(String[] args) {
    ArrayList<String> values = new ArrayList<>();
    values.add("yes");
    for (String value : args) { System.out.println(values.contains(value)); }
  }
}\n`;
const key = (id: string) => "java-blueprints:prepared-proposal:" + id;
async function fixture(page: Page) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Continuity " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [
        { path: "Main.java", content: source },
        { path: "notes.txt", content: "keep me\n" },
      ],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 30000,
  });
  const analysis = (
    await (
      await page.request.get(base + "/revisions/" + original.id + "/analysis")
    ).json()
  ).data;
  return { id, base, original, analysis };
}
async function prepare(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  const op = f.analysis.optimizations[0];
  expect(op).toBeTruthy();
  const response = await page.request.post(f.base + "/changes", {
    headers: await headers(page.request),
    data: {
      baseRevisionId: f.original.id,
      analysisId: f.analysis.id,
      methodId: op.methodId,
      nodeId: op.nodeId,
      operation: "optimize_membership",
      payload: {},
      intent: "preserve_behavior",
    },
  });
  expect(response.status()).toBe(202);
  return (await response.json()).data;
}
async function remember(page: Page, id: string, proposal: string) {
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [key(id), proposal],
  );
}
test("queued proposal reconnects without changing source; dismiss removes only its own hint", async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture(page),
    p = await prepare(page, f);
  expect(p.status).toBe("queued");
  await remember(page, f.id, p.id);
  await page.reload();
  await revealPanel(page, "changes", "Изменения");
  await expect(page.locator(".proposal .added")).toContainText("jbMembership", {
    timeout: 60000,
  });
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
  const newer = crypto.randomUUID();
  await remember(page, f.id, newer);
  await page.getByRole("button", { name: "Отклонить", exact: true }).click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key(f.id)),
  ).toBe(newer);
  await page.reload();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key(f.id)))
    .toBeNull();
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});
test("foreign and stale hints are rejected while local conflicting draft remains exact", async ({
  page,
}) => {
  test.setTimeout(120000);
  const a = await fixture(page),
    p = await prepare(page, a),
    b = await fixture(page);
  await remember(page, b.id, p.id);
  await page.reload();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key(b.id)))
    .toBeNull();
  expect((await head(page.request, b.base)).id).toBe(b.original.id);
  await page.goto("/projects/" + a.id);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
  const changed = await page.request.post(a.base + "/revisions", {
    headers: await headers(page.request, a.original.id),
    data: {
      files: a.original.files.map((f: any) => ({
        path: f.path,
        content: f.canonicalText + "\n",
      })),
      intent: "semantic_edit",
    },
  });
  expect(changed.status()).toBe(201);
  const next = (await changed.json()).data;
  await remember(page, a.id, p.id);
  await page.reload();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key(a.id)))
    .toBeNull();
  const draft = source.replace(
    'values.add("yes")',
    'values.add("local draft")',
  );
  await page.evaluate(
    ({ id, proposal, base, files }) => {
      localStorage.setItem("java-blueprints:prepared-proposal:" + id, proposal);
      localStorage.setItem(
        "java-blueprints:draft:" + id,
        JSON.stringify({ baseRevisionId: base, files, directories: [] }),
      );
    },
    {
      id: a.id,
      proposal: p.id,
      base: a.original.id,
      files: { "Main.java": draft, "notes.txt": "keep me\n" },
    },
  );
  await page.reload();
  await revealPanel(page, "code", "Код");
  await expect(page.locator(".monaco-editor")).toContainText("local draft");
  await expect(
    page.getByText("Конфликт версий", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".proposal")).not.toBeVisible();
  expect((await head(page.request, a.base)).id).toBe(next.id);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key(a.id)),
  ).toBe(p.id);
});
test("late restored proposal cannot replace a new source edit or reveal a hidden panel", async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture(page),
    p = await prepare(page, f);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(f.base + "/changes/" + p.id)).json())
          .data.status,
      { timeout: 60000 },
    )
    .toBe("ready");
  await remember(page, f.id, p.id);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    arrived = new Promise<void>((r) => (seen = r));
  await page.route("**/changes/" + p.id, async (route) => {
    const response = await route.fetch();
    seen();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.reload();
    await arrived;
    await revealPanel(page, "code", "Код");
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await editor.focus();
    await page.keyboard.press("Control+Home");
    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/revisions"))
        saves++;
    });
    await page.keyboard.insertText("// local edit wins\n");
    release();
    await expect(page.locator(".monaco-editor")).toContainText(
      "local edit wins",
    );
    await expect(page.locator(".proposal")).not.toBeVisible();
    await expect(page.locator(".local-label")).toHaveText("Сохранено", {
      timeout: 30000,
    });
    expect((await head(page.request, f.base)).files[0].canonicalText).toContain(
      "local edit wins",
    );
    const saved = await head(page.request, f.base);
    expect(saved.files[0].canonicalText).not.toContain("\r");
    await page.waitForTimeout(2300);
    expect((await head(page.request, f.base)).id).toBe(saved.id);
    expect(saves).toBe(1);
  } finally {
    release();
  }
});
test("leaving during a pending suite request cannot start a later comparison or navigate back", async ({
  page,
}) => {
  const f = await fixture(page);
  let release!: () => void,
    seen!: () => void,
    count = 0;
  const gate = new Promise<void>((r) => (release = r)),
    arrived = new Promise<void>((r) => (seen = r));
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/comparisons")) count++;
  });
  await page.route("**/test-suites", async (route) => {
    const response = await route.fetch();
    seen();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "Сравнить", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Сравнить", exact: true })
      .click();
    await arrived;
    await page.keyboard.press("Escape");
    await page
      .getByRole("navigation", { name: "Навигация проекта" })
      .getByRole("button", { name: "Проекты", exact: true })
      .click();
    await expect(page.getByLabel("Название проекта")).toBeVisible();
    release();
    await page.waitForTimeout(800);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(count).toBe(0);
    expect((await head(page.request, f.base)).id).toBe(f.original.id);
  } finally {
    release();
  }
});
test("explorer toolbar rename follows active code tab rather than an earlier file selection", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "notes.txt", exact: true }).click();
  await page
    .locator(".file-tabs")
    .getByRole("tab", { name: "Main.java", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Переименовать", exact: true })
    .click();
  await expect(page.getByLabel("Новый путь", { exact: true })).toHaveValue(
    "Main.java",
  );
  await page.keyboard.press("Escape");
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});
