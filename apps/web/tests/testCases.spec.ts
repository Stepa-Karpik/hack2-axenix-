import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { setTheme } from "./flowAssertions";

const source = `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    Scanner input = new Scanner(System.in);
    String line = input.hasNextLine() ? input.nextLine() : "";
    System.out.println(args.length + "|" + String.join(",", args) + "|" + line);
  }
}\n`;
async function fixture(page: Page) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Case editor " + crypto.randomUUID() },
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
  const original = (await saved.json()).data;
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  return { base, original };
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Форма", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  return dialog;
}
async function oneCase(dialog: ReturnType<Page["getByRole"]>) {
  await dialog
    .getByRole("button", { name: "Удалить тест 3", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Удалить тест 2", exact: true })
    .click();
}
async function finished(page: Page, base: string, id: string) {
  let result: any;
  await expect
    .poll(
      async () => {
        result = (await (await page.request.get(base + "/jobs/" + id)).json())
          .data;
        return result.status;
      },
      { timeout: 90000 },
    )
    .toBe("succeeded");
  return result;
}

test("form builds an exact independent input oracle, survives JSON roundtrip and verifies real Java output", async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const f = await fixture(page);
  await setTheme(page, "light");
  const dialog = await open(page);
  await oneCase(dialog);
  await dialog
    .getByLabel("Название теста", { exact: true })
    .fill("Пробелы и UTF-8");
  await dialog.getByLabel("Ввод (stdin)", { exact: true }).fill("  привет\n");
  await dialog
    .getByRole("button", { name: "Добавить аргумент", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Добавить аргумент", exact: true })
    .click();
  await dialog.getByLabel("Аргумент 2", { exact: true }).fill("two words");
  await dialog.getByLabel("Вывод (stdout)", { exact: true }).check();
  await dialog
    .getByLabel("Ожидаемый stdout", { exact: true })
    .fill("2|,two words|  привет\n");
  await dialog.getByLabel("Ошибки (stderr)", { exact: true }).check();
  await dialog.getByLabel("Код завершения", { exact: true }).check();
  await dialog.getByRole("button", { name: "JSON", exact: true }).click();
  const expected = {
    id: "case-1",
    name: "Пробелы и UTF-8",
    stdinUtf8: "  привет\n",
    argv: ["", "two words"],
    expectedStdout: "2|,two words|  привет\n",
    expectedStderr: "",
    expectedExitCode: 0,
  };
  expect(
    JSON.parse(
      await dialog.getByLabel("Входные данные · JSON cases").inputValue(),
    ),
  ).toEqual([expected]);
  await dialog.getByRole("button", { name: "Форма", exact: true }).click();
  await expect(dialog.getByLabel("Аргумент 1", { exact: true })).toHaveValue(
    "",
  );
  await expect(dialog.getByLabel("Аргумент 2", { exact: true })).toHaveValue(
    "two words",
  );
  await page.screenshot({
    path: info.outputPath("case-form-light.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("case-form-narrow.png"),
    animations: "disabled",
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**" + f.base + "/test-suites", async (route) => {
    await held;
    await route.continue();
  });
  const suiteRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/test-suites") && request.method() === "POST",
  );
  const comparison = page.waitForResponse(
    (response) =>
      response.url().endsWith("/comparisons") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Сравнить", exact: true }).click();
  try {
    expect((await suiteRequest).postDataJSON().cases).toEqual([expected]);
    await expect(
      dialog.getByLabel("Название теста", { exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "JSON", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  const job = (await (await comparison).json()).data;
  const report = (await finished(page, f.base, job.id)).result.report;
  expect(report.outcome).toBe("matched_on_tests");
  expect(report.matched).toBe(1);
  expect(report.testResults[0].input.argv).toEqual(["", "two words"]);
  expect(report.testResults[0].baseExecutions).toHaveLength(3);
  expect(report.testResults[0].candidateExecutions).toHaveLength(3);
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});

test("invalid numeric and JSON drafts cannot submit; expected empty stdout produces a real mismatch", async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const f = await fixture(page);
  await setTheme(page, "dark");
  const dialog = await open(page);
  await oneCase(dialog);
  let submits = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(test-suites|comparisons)$/.test(request.url())
    )
      submits++;
  });
  await dialog.getByLabel("Код завершения", { exact: true }).check();
  await dialog
    .getByLabel("Ожидаемый код завершения", { exact: true })
    .fill("-");
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "JSON", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("целый код завершения");
  expect(submits).toBe(0);
  await dialog
    .getByLabel("Ожидаемый код завершения", { exact: true })
    .fill("0");
  await dialog.getByRole("button", { name: "JSON", exact: true }).click();
  const raw = dialog.getByLabel("Входные данные · JSON cases");
  const invalid = '[{"id":"kept","typo":1}]';
  await raw.fill(invalid);
  await expect(raw).toHaveValue(invalid);
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  const unsafe = '[{"id":"kept","tags":{"number":9007199254740993}}]';
  await raw.fill(unsafe);
  await expect(raw).toHaveValue(unsafe);
  await expect(dialog.getByRole("alert")).toContainText(
    "нельзя сохранить точно",
  );
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  const body = [
    {
      id: "kept",
      name: null,
      stdinUtf8: "",
      argv: [],
      expectedStdout: "",
      expectedExitCodes: [0],
      tags: { keep: "да" },
    },
  ];
  await raw.fill(JSON.stringify(body));
  await dialog.getByRole("button", { name: "Форма", exact: true }).click();
  await expect(
    dialog.getByLabel("Вывод (stdout)", { exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByLabel("Ожидаемый stdout", { exact: true }),
  ).toHaveValue("");
  await page.screenshot({
    path: info.outputPath("case-form-dark.png"),
    animations: "disabled",
  });
  expect(submits).toBe(0);
  const suiteRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/test-suites") && request.method() === "POST",
  );
  const comparison = page.waitForResponse(
    (response) =>
      response.url().endsWith("/comparisons") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Сравнить", exact: true }).click();
  expect((await suiteRequest).postDataJSON().cases).toEqual(body);
  const report = (
    await finished(page, f.base, (await (await comparison).json()).data.id)
  ).result.report;
  expect(report.outcome).toBe("mismatch");
  expect(report.matched).toBe(0);
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});

test("empty list recovery and editable argument limits preserve ids, metadata and newline arguments", async ({
  page,
}) => {
  const f = await fixture(page);
  const dialog = await open(page);
  await oneCase(dialog);
  await dialog
    .getByRole("button", { name: "Удалить тест 1", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Добавить тест", exact: true })
    .click();
  await dialog.getByRole("button", { name: "JSON", exact: true }).click();
  const raw = dialog.getByLabel("Входные данные · JSON cases");
  expect(JSON.parse(await raw.inputValue())[0].id).toMatch(
    /^case-[a-f0-9-]{36}$/,
  );
  const imported = [
    {
      id: "stable",
      name: null,
      stdinUtf8: " a\n",
      argv: ["", "\n", "кириллица"],
      expectedStdout: "",
      expectedExitCodes: [0],
      tags: { opaque: [1, "value"] },
    },
  ];
  await raw.fill(JSON.stringify(imported));
  await dialog.getByRole("button", { name: "Форма", exact: true }).click();
  await expect(dialog.getByLabel("Аргумент 2", { exact: true })).toHaveValue(
    "\n",
  );
  await dialog.getByLabel("Название теста", { exact: true }).fill("Новое имя");
  await dialog.getByLabel("Аргумент 3", { exact: true }).fill("x".repeat(8193));
  await expect(
    dialog.getByRole("button", { name: "Сравнить", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("Аргумент 3", { exact: true })).toBeVisible();
  await dialog.getByLabel("Аргумент 3", { exact: true }).fill("кириллица");
  await dialog.getByRole("button", { name: "JSON", exact: true }).click();
  expect(JSON.parse(await raw.inputValue())).toEqual([
    { ...imported[0], name: "Новое имя" },
  ]);
  expect((await head(page.request, f.base)).id).toBe(f.original.id);
});
