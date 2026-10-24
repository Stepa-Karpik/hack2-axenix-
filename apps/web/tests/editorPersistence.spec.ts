import { test, expect } from "@playwright/test";
import { fixture, headers, head } from "./fileFixtures";

test("Monaco Ctrl+S cancels browser save, publishes once and retains drafts during typing pauses", async ({
  page,
}) => {
  const { projectId, base, original } = await fixture(page.request);
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// local persistence regression\n");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          JSON.parse(
            localStorage.getItem("java-blueprints:draft:" + id) ?? "null",
          )?.files?.["Main.java"],
        projectId,
      ),
    )
    .toContain("local persistence regression");
  // A normal short thinking pause must not create another history entry.
  await page.waitForTimeout(2200);
  expect((await head(page.request, base)).id).toBe(original.id);
  await page.reload();
  await expect(page.locator(".monaco-editor")).toContainText(
    "local persistence regression",
  );
  await page.evaluate(() => {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.ctrlKey && event.key.toLowerCase() === "s")
          document.body.dataset.savePrevented = String(event.defaultPrevented);
      },
      true,
    );
  });
  await editor.focus();
  await page.keyboard.press("Control+s");
  await expect(page.locator("body")).toHaveAttribute(
    "data-save-prevented",
    "true",
  );
  await expect
    .poll(async () => (await head(page.request, base)).id)
    .not.toBe(original.id);
  const saved = await head(page.request, base);
  expect(
    saved.files.find((f) => f.path === "Main.java")?.canonicalText,
  ).toContain("local persistence regression");
  await expect(page.locator(".file-tabs-save")).toBeDisabled();
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(500);
  expect((await head(page.request, base)).id).toBe(saved.id);
  expect(
    (await (await page.request.get(base + "/revisions?limit=100")).json()).data,
  ).toHaveLength(2);
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// one idle autosave\n");
  await expect
    .poll(async () => (await head(page.request, base)).id, {
      timeout: 15000,
    })
    .not.toBe(saved.id);
  await expect(page.locator(".file-tabs-save")).toBeDisabled();
  const autosaved = await head(page.request, base);
  expect(
    autosaved.files.find((f) => f.path === "Main.java")?.canonicalText,
  ).toContain("one idle autosave");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(500);
  expect((await head(page.request, base)).id).toBe(autosaved.id);
  expect(
    (await (await page.request.get(base + "/revisions?limit=100")).json()).data,
  ).toHaveLength(3);
});

test("confirmed file and folder deletion preserves other dirty files, tabs and historical snapshots", async ({
  page,
}) => {
  const { projectId, base, original } = await fixture(page.request);
  const seeded = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, original.id),
    data: {
      files: [
        ...original.files.map((f) => ({
          path: f.path,
          content: f.canonicalText,
        })),
        { path: "folder/child.txt", content: "historical child\n" },
        { path: "folder-sibling.txt", content: "unrelated\n" },
      ],
      directories: ["empty", "folder/empty"],
      expectedHeadRevisionId: original.id,
      intent: "semantic_edit",
    },
  });
  expect(seeded.ok()).toBeTruthy();
  const before = (await seeded.json()).data;
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// retain other dirty file\n");
  await page.locator('[data-file-path="notes.txt"]').click();
  await page
    .getByRole("button", { name: "Удалить выбранный путь", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Удалить notes.txt?");
  await confirmation
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  expect((await head(page.request, base)).id).toBe(before.id);
  await expect(
    page.getByRole("tab", { name: "notes.txt", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Удалить выбранный путь", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Удалить из текущей версии", exact: true })
    .click();
  await expect(page.locator('[data-file-path="notes.txt"]')).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "notes.txt", exact: true }),
  ).toHaveCount(0);
  const fileDeleted = await head(page.request, base);
  expect(
    fileDeleted.files.find((f) => f.path === "Main.java")?.canonicalText,
  ).toContain("retain other dirty file");
  await page.locator('[data-directory-path="folder"]').click();
  await page
    .getByRole("button", { name: "Удалить выбранный путь", exact: true })
    .click();
  await expect(confirmation).toContainText("Папка и всё её содержимое");
  await confirmation
    .getByRole("button", { name: "Удалить из текущей версии", exact: true })
    .click();
  await expect(page.locator('[data-directory-path="folder"]')).toHaveCount(0);
  const deleted = await head(page.request, base);
  expect(deleted.files.some((f) => f.path.startsWith("folder/"))).toBe(false);
  expect(deleted.directories).not.toContain("folder/empty");
  expect(
    deleted.files.find((f) => f.path === "folder-sibling.txt")?.canonicalText,
  ).toBe("unrelated\n");
  expect(
    (await (await page.request.get(base + "/revisions/" + before.id)).json())
      .data.files,
  ).toEqual(before.files);
});

test("a stale delete keeps the current tab and local draft when project CAS rejects it", async ({
  page,
}) => {
  const { projectId, base, original } = await fixture(page.request);
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// keep rejected deletion draft\n");
  await page.locator('[data-file-path="Main.java"]').click();
  await page
    .getByRole("button", { name: "Удалить выбранный путь", exact: true })
    .click();
  const remote = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, original.id),
    data: {
      files: original.files.map((f) => ({
        path: f.path,
        content: f.canonicalText,
      })),
      directories: ["empty", "remote"],
      expectedHeadRevisionId: original.id,
      intent: "semantic_edit",
    },
  });
  expect(remote.ok()).toBeTruthy();
  const remoteId = (await remote.json()).data.id;
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith(base + "/revisions") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Удалить из текущей версии", exact: true })
    .click();
  expect((await rejected).status()).toBe(409);
  await expect(page.locator('[data-file-path="Main.java"]')).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Main.java", exact: true }),
  ).toBeVisible();
  expect((await head(page.request, base)).id).toBe(remoteId);
  expect(
    await page.evaluate(
      (id) =>
        JSON.parse(
          localStorage.getItem("java-blueprints:draft:" + id) ?? "null",
        )?.files?.["Main.java"],
      projectId,
    ),
  ).toContain("keep rejected deletion draft");
});
