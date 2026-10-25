import { test, expect, type Page, type APIResponse } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { defaultLayout } from "../src/workspaceLayout";

const content = "Archive recovery: сохранить café 😀\n";

async function fixture(page: Page) {
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Archive recovery source " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id as string;
  const base = "/api/v1/projects/" + id;
  const saved = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [{ path: "notes.txt", content }],
      directories: ["empty"],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  const exported = await page.request.post(base + "/archives", {
    headers: await headers(page.request),
    data: {
      workspace: { layout: defaultLayout(), focused: "code", maximized: null },
    },
  });
  expect(exported.status()).toBe(201);
  const metadata = (await exported.json()).data;
  const download = await page.request.get(metadata.downloadUrl);
  expect(download.status()).toBe(200);
  const bytes = await download.body();
  await page.goto("/projects/" + id);
  await expect(page.locator(".monaco-editor textarea.inputarea")).toBeAttached({
    timeout: 30000,
  });
  const menu = page.locator(".sidebar-command-menu");
  if ((await menu.getAttribute("open")) === null)
    await menu.locator(":scope > summary").click();
  const fileMenu = page
    .locator(".workspace-menubar summary")
    .filter({ hasText: /^Файл$/ });
  await fileMenu.click();
  await page.getByLabel("Файл архива проекта").setInputFiles({
    name: "recovery.jbp.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  const dialog = page.getByRole("dialog", {
    name: "Открыть архив",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return { id, base, original, dialog };
}

test("archive retry reuses the committed project and its original creation body after a lost response", async ({
  page,
}) => {
  const f = await fixture(page);
  const name = "Archive recovered target " + crypto.randomUUID();
  await f.dialog.getByLabel("Название проекта", { exact: true }).fill(name);
  const attempts: { key: string | undefined; body: unknown; id: string }[] = [];
  const importedInto: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.endsWith("/archive-imports"))
      importedInto.push(path.split("/")[4]);
  });
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // The server commits and stores its idempotent response before transport loss.
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const project = (await response.json()).data;
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
      id: project.id,
    });
    if (attempts.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await f.dialog
    .getByRole("button", { name: "Открыть в новом проекте", exact: true })
    .click();
  await expect(f.dialog.getByRole("alert")).toBeVisible();
  expect(attempts).toHaveLength(1);
  expect(importedInto).toEqual([]);
  const target = attempts[0].id;
  const committed = (
    await (await page.request.get("/api/v1/projects/" + target)).json()
  ).data;
  expect(committed.name).toBe(name);
  expect(committed.headRevisionId).toBeNull();
  const nameInput = f.dialog.getByLabel("Название проекта", { exact: true });
  await expect(nameInput).toHaveValue(name);
  await expect(nameInput).toBeDisabled();
  await f.dialog
    .getByRole("button", { name: "Открыть в новом проекте", exact: true })
    .click();
  await expect(page).toHaveURL("/projects/" + target);
  await expect(f.dialog).not.toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body).toEqual({ name });
  expect(importedInto).toEqual([target]);
  const restored = await head(page.request, "/api/v1/projects/" + target);
  expect(restored.files.map((file) => [file.path, file.canonicalText])).toEqual(
    [["notes.txt", content]],
  );
  expect(restored.directories).toContain("empty");
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});

test("unmount after project creation does not continue archive import or workspace writes", async ({
  page,
}) => {
  const f = await fixture(page);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed!: (value: { id: string; response: APIResponse }) => void;
  const creation = new Promise<{ id: string; response: APIResponse }>(
    (resolve) => {
      committed = resolve;
    },
  );
  const imports: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/archive-imports")
    )
      imports.push(request.url());
  });
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed({ id: (await response.json()).data.id, response });
    await released;
    await route.fulfill({ response });
  });
  await f.dialog
    .getByRole("button", { name: "Открыть в новом проекте", exact: true })
    .click();
  const target = (await creation).id;
  // Use the app's SPA navigation protocol; a full reload would hide a missing unmount guard.
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(f.dialog).not.toBeVisible();
  await expect(
    page.getByLabel("Название проекта", { exact: true }),
  ).toBeVisible();
  const completed = page.waitForEvent(
    "requestfinished",
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/projects",
  );
  release();
  await completed;
  // Allow the fulfilled response/JSON promise and React effects to finish in the same document.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const untouched = (
    await (await page.request.get("/api/v1/projects/" + target)).json()
  ).data;
  expect(untouched.headRevisionId).toBeNull();
  expect(imports).toEqual([]);
  const storage = await page.evaluate(
    (id) => ({
      layout: localStorage.getItem("java-blueprints:workspace:v2:" + id),
      windows: localStorage.getItem("java-blueprints:window-state:" + id),
    }),
    target,
  );
  expect(storage).toEqual({ layout: null, windows: null });
  await expect(page).toHaveURL("/");
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});
