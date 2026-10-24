import { test, expect } from "@playwright/test";
import { fixture, headers, head, source } from "./fileFixtures";

test("an editable historical revision can be restored as a new head", async ({
  page,
}) => {
  const { projectId, base, original } = await fixture(page.request);
  const advanced = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, original.id),
    data: {
      files: [{ path: "Main.java", content: source + "// newer\n" }],
      directories: [],
      intent: "semantic_edit",
      expectedHeadRevisionId: original.id,
    },
  });
  expect(advanced.ok()).toBeTruthy();
  const current = (await advanced.json()).data.id;
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.locator("#project-history > summary").click();
  const row = page.locator(".revision-row").filter({
    has: page.getByRole("button", {
      name: "Восстановить версию " + original.id.slice(0, 8),
      exact: true,
    }),
  });
  await row.locator("button").first().click();
  await expect(
    page.getByText("Просмотр сохранённой версии", { exact: false }),
  ).toBeVisible();
  const restore = page.getByRole("button", {
    name: "Восстановить версию " + original.id.slice(0, 8),
    exact: true,
  });
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect
    .poll(async () => (await head(page.request, base)).id)
    .not.toBe(current);
  const restored = await head(page.request, base);
  expect(restored.files).toEqual(original.files);
});

test("focus refresh preserves a dirty editing base and exposes concurrent-save recovery", async ({
  page,
}) => {
  const { projectId, base, original } = await fixture(page.request);
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  const advanced = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, original.id),
    data: {
      files: [{ path: "Main.java", content: source + "// remote\n" }],
      directories: [],
      intent: "semantic_edit",
      expectedHeadRevisionId: original.id,
    },
  });
  expect(advanced.ok()).toBeTruthy();
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// retained local draft\n");
  const refreshed = page.waitForResponse(
    (r) => r.url().endsWith(base) && r.request().method() === "GET",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  const recover = page.getByRole("button", {
    name: "Выбрать актуальную основу",
    exact: true,
  });
  await expect(recover).toBeVisible({ timeout: 15000 });
  await recover.click();
  await expect(page.locator(".monaco-editor")).toContainText(
    "retained local draft",
  );
  await expect(
    page.locator(".monaco-editor textarea.inputarea"),
  ).toBeEditable();
  await page
    .getByRole("button", { name: "Сохранить новую версию", exact: true })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        (await head(page.request, base)).files.find(
          (f) => f.path === "Main.java",
        )?.canonicalText,
    )
    .toContain("retained local draft");
});
