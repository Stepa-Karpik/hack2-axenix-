import { selectValue } from "./selectControl";
import { test, expect, type APIResponse } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

const source = `public class Main {
  public static void main(String[] args) {
    int seed = 2;
    int doubled = seed * 2;
    int result = doubled + 1;
    System.out.println(result);
  }
}\n`;

test("selecting other complete statements while proposal response is pending retains the original compiled diff", async ({
  page,
}) => {
  test.setTimeout(180000);
  const request = page.request;
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Extraction continuity " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [{ path: "Main.java", content: source }],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data;
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({
    timeout: 30000,
  });
  await revealPanel(page, "code", "Код");
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+Home");
  for (let line = 0; line < 3; line++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
  await expect(
    page.getByRole("combobox", { name: "Действие", ...{ exact: true } }),
  ).toHaveAttribute("data-value", "extract_method");
  await page.getByLabel("Имя нового метода").fill("calculateOriginalSelection");
  const initialLast = await selectValue(
    page.getByRole("combobox", {
      name: "Последний оператор",
      ...{ exact: true },
    }),
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed!: (response: APIResponse) => void;
  const creation = new Promise<APIResponse>((resolve) => {
    committed = resolve;
  });
  let changed = 0;
  await page.route("**/api/v1/projects/*/changes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    changed++;
    const response = await route.fetch();
    committed(response);
    await released;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "Подготовить изменение", exact: true })
      .click();
    const response = await creation;
    expect(response.status()).toBe(202);
    const pending = (await response.json()).data;
    // Monaco readOnly blocks editing, but still permits an actual keyboard range
    // selection. Select the preceding declaration while the first request waits.
    await editor.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Home");
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.up("Shift");
    await expect(
      page.getByRole("combobox", {
        name: "Последний оператор",
        ...{ exact: true },
      }),
    ).toHaveAttribute("data-value", initialLast);
    release();
    await expect(
      page.getByLabel("Извлечённый метод", { exact: true }),
    ).toContainText("calculateOriginalSelection", { timeout: 60000 });
    const proposal = (
      await (await request.get(base + "/changes/" + pending.id)).json()
    ).data;
    expect(proposal.status).toBe("ready");
    expect(proposal.checks.compileStatus).toBe("passed");
    expect(proposal.extraction.methodName).toBe("calculateOriginalSelection");
    expect(changed).toBe(1);
    await expect(
      page.getByRole("button", { name: "Применить", exact: true }),
    ).toBeDisabled();
    expect((await head(request, base)).id).toBe(original.id);
  } finally {
    release?.();
  }
});
