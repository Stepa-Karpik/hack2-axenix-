import { publishProject } from "./flowAssertions";
import { test, expect, type Page } from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { panToNode } from "./flowAssertions";

async function project(page: Page, source?: string) {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Usability " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id;
  const base = "/api/v1/projects/" + id;
  if (source)
    expect(
      (
        await page.request.post(base + "/revisions", {
          headers: await headers(page.request, "empty"),
          data: {
            files: [{ path: "Main.java", content: source }],
            intent: "semantic_edit",
          },
        })
      ).status(),
    ).toBe(201);
  await page.goto("/projects/" + id);
  if (source)
    await expect(page.locator(".blueprint-node").first()).toBeVisible({
      timeout: 30000,
    });
  return { id, base };
}
async function run(page: Page) {
  await page.getByRole("button", { name: "Запуск", exact: true }).click();
  await page.getByLabel("Класс с main").fill("Main");
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
}

test("inline create, complete clipboard paste, filename repair and latest file graph", async ({
  page,
}) => {
  const { base } = await project(page);
  await page.getByRole("button", { name: "Создать файл", exact: true }).click();
  const input = page.getByLabel("Путь нового файла", { exact: true });
  await expect(
    page
      .locator(".explorer-form")
      .getByRole("button", { name: "Применить", exact: true }),
  ).toHaveCount(0);
  await input.fill("abc.java");
  await expect(page.locator(".inline-file-icon")).toContainText("J");
  await input.press("Enter");
  await expect(page.locator('[data-file-path="abc.java"]')).toBeVisible();
  const source =
    "public class Main {\n" +
    Array.from(
      { length: 1000 },
      (_, i) => `  // Строка ${i + 1}: проверка полного текста`,
    ).join("\n") +
    '\n  public static void main(String[] args) { System.out.println("полный файл"); }\n  static int lastMarker() { return 842; }\n}\n';
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+a");
  const clipboard = await page.evaluateHandle((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    return data;
  }, source);
  await editor.evaluate(
    (element, data) =>
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      ),
    clipboard,
  );
  await expect
    .poll(
      async () =>
        (await head(page.request, base)).files.find(
          (f) => f.path === "abc.java",
        )?.canonicalText,
      { timeout: 30000 },
    )
    .toBe(source);
  await expect(page.locator(".editor-file-status")).toContainText("1005 строк");
  await expect(page.locator(".stale-banner")).toHaveCount(0, {
    timeout: 30000,
  });
  await page
    .getByRole("button", { name: "Переименовать в Main.java", exact: true })
    .click();
  await expect(page.locator('[data-file-path="Main.java"]')).toBeVisible();
  await expect(
    page.locator(".method-item").filter({ hasText: "lastMarker()" }),
  ).toBeVisible({ timeout: 30000 });
  await page.reload();
  expect(
    (await head(page.request, base)).files.find((f) => f.path === "Main.java")
      ?.canonicalText,
  ).toBe(source);
  await page.getByRole("button", { name: "Создать файл", exact: true }).click();
  await page.getByLabel("Путь нового файла", { exact: true }).fill("notes.py");
  await expect(page.locator(".inline-file-icon")).toContainText("Py");
  await page.getByRole("combobox", { name: "Поиск по проекту" }).click();
  await expect(page.locator('[data-file-path="notes.py"]')).toBeVisible();
  await page.getByRole("button", { name: "Создать файл", exact: true }).click();
  await page
    .getByLabel("Путь нового файла", { exact: true })
    .fill("cancel.txt");
  await page.getByLabel("Путь нового файла", { exact: true }).press("Escape");
  expect(
    (await head(page.request, base)).files.some((f) => f.path === "cancel.txt"),
  ).toBe(false);
});

test("paste in the editor Find widget cannot replace program text", async ({
  page,
}) => {
  const source =
    'public class Main { public static void main(String[] args) { System.out.println("unchanged"); } }\n';
  const { base } = await project(page, source);
  await page.locator("textarea.inputarea").focus();
  await page.keyboard.press("Control+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeFocused();
  const data = await page.evaluateHandle(() => {
    const value = new DataTransfer();
    value.setData("text/plain", "search text");
    return value;
  });
  expect(
    await find.evaluate(
      (el, clipboardData) =>
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        ),
      data,
    ),
  ).toBe(true);
  await expect(page.locator(".editor-file-status")).toContainText("Сохранено");
  await page.waitForTimeout(2200);
  expect(
    (await head(page.request, base)).files.find((f) => f.path === "Main.java")
      ?.canonicalText,
  ).toBe(source);
});

test("syntax diagnostics reveal their current source line without trusting a stale graph", async ({
  page,
}) => {
  const { base } = await project(
    page,
    "public class Main { static void f() {} }\n",
  );
  const source =
    "public class Main {\n" +
    "// padding\n".repeat(180) +
    "static void broken() { int value = ; }\n}\n";
  const editor = page.locator("textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(source);
  await publishProject(page);
  await expect(
    page.getByText("Исходник сохранён · ошибка разбора", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const saved = await head(page.request, base);
  await editor.focus();
  await page.keyboard.press("Control+Home");
  await expect(page.locator(".view-lines")).not.toContainText("int value =");
  const diagnostics = page.locator(".analysis-diagnostics .diagnostic");
  await diagnostics.first().click();
  await expect(page.locator(".view-lines")).toContainText("int value =");
  await expect(page.locator(".code-binding").first()).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("// new draft\n");
  await expect(diagnostics.first()).toBeDisabled();
  await expect(page.locator(".code-binding")).toHaveCount(0);
  expect((await head(page.request, base)).id).toBe(saved.id);
});

test("drag inserts a real statement and double click edits Java through compiled preview", async ({
  page,
}) => {
  const { base } = await project(
    page,
    "public class Main { public static void main(String[] args) { System.out.println(5); } }\n",
  );
  await page.getByLabel("Добавить блок", { exact: true }).click();
  const node = page
    .locator('.blueprint-node[data-node-kind="ExpressionStmt"]')
    .first();
  await panToNode(page, node);
  await page
    .locator(".palette-statement")
    .dragTo(node, { targetPosition: { x: 80, y: 60 } });
  await expect(page.getByLabel("Java оператор", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Позиция", ...{ exact: true } }),
  ).toHaveAttribute("data-value", "after");
  await page
    .getByLabel("Java оператор", { exact: true })
    .fill('System.out.println("Готово");');
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(async () => (await head(page.request, base)).files[0].canonicalText)
    .toContain('System.out.println("Готово")');
  await expect(page.locator(".stale-banner")).toHaveCount(0, {
    timeout: 30000,
  });
  const first = page
    .locator('.blueprint-node[data-node-kind="ExpressionStmt"]')
    .filter({ hasText: "println(5)" });
  await panToNode(page, first);
  await first.dblclick();
  await page
    .getByLabel("Код блока", { exact: true })
    .fill("System.out.println(6);");
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(page.locator(".stale-banner")).toHaveCount(0, {
    timeout: 30000,
  });
  await run(page);
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "Готово",
    { timeout: 60000 },
  );
  await expect
    .poll(async () => (await head(page.request, base)).files[0].canonicalText)
    .toContain("println(6)");
});

test("a condition diamond opens its whole condition and accepts a real insertion before it", async ({
  page,
}) => {
  const source =
    "public class Main { public static void main(String[] args) { if (args.length > 0 && args[0] != null) { System.out.println(1); } } }\n";
  const { base } = await project(page, source);
  const diamond = page.locator(".blueprint-node.condition_test").first();
  await panToNode(page, diamond);
  await diamond.dblclick();
  const condition = page.getByLabel("Условие", { exact: true });
  await expect(condition).toHaveValue("args.length > 0 && args[0] != null");
  await expect(condition).toBeFocused();
  await page.getByLabel("Добавить блок", { exact: true }).click();
  await panToNode(page, diamond);
  await page
    .locator(".palette-statement")
    .dragTo(diamond, { targetPosition: { x: 80, y: 12 } });
  await expect(
    page.getByRole("combobox", { name: "Позиция", ...{ exact: true } }),
  ).toHaveAttribute("data-value", "before");
  await page
    .getByLabel("Java оператор", { exact: true })
    .fill('System.out.println("before condition");');
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  const apply = page.getByRole("button", { name: "Применить", exact: true });
  await expect(apply).toBeEnabled({ timeout: 60000 });
  expect((await head(page.request, base)).files[0].canonicalText).toBe(source);
  await apply.click();
  await expect
    .poll(async () => (await head(page.request, base)).files[0].canonicalText)
    .toContain(
      'System.out.println("before condition");\nif (args.length > 0 && args[0] != null)',
    );
});

test("interactive answers arrive while running, duplicate input is not delivered twice, reload reconnects", async ({
  page,
}) => {
  const { base } = await project(
    page,
    'import java.util.Scanner; public class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); System.out.println("Имя?"); String name=s.nextLine(); System.out.println("Число?"); String n=s.nextLine(); System.out.println("Повтор?"); String end=s.nextLine(); System.out.println(name+":"+n+":"+end); } }',
  );
  await run(page);
  await expect(page.locator(".live-console-output")).toContainText("Имя?", {
    timeout: 60000,
  });
  await page.getByLabel("Ответ программе").fill("Степан");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator(".live-console-output")).toContainText("Число?");
  await page.reload();
  await expect(page.locator(".live-console-output")).toContainText("Число?", {
    timeout: 30000,
  });
  const runId = page.url().split("/runs/")[1];
  const key = crypto.randomUUID();
  const h = await headers(page.request, undefined, key);
  const send = () =>
    page.request.post(base + `/runs/${runId}/input`, {
      headers: h,
      data: { text: "12\n", eof: false },
    });
  expect((await send()).status()).toBe(200);
  expect((await send()).status()).toBe(200);
  await expect(page.locator(".live-console-output")).toContainText("Повтор?");
  await expect(page.getByLabel("Ответ программе")).toBeEnabled();
  await page.getByLabel("Ответ программе").fill("да");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "Степан:12:да",
    { timeout: 30000 },
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + `/runs/${runId}`)).json()).data
          .status,
    )
    .toBe("succeeded");
  expect((await send()).status()).toBe(409);
  await test.info().attach("project", {
    body: JSON.stringify({ url: page.url() }),
    contentType: "application/json",
  });
});

test("EOF closes input cleanly and stop retains output", async ({ page }) => {
  const { base } = await project(
    page,
    'import java.util.Scanner; public class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); System.out.println("Готов к вводу"); while(s.hasNextLine()) System.out.println("echo:"+s.nextLine()); System.out.println("EOF завершён"); } }',
  );
  await run(page);
  await expect(page.locator(".live-console-output")).toContainText(
    "Готов к вводу",
    { timeout: 60000 },
  );
  await page.getByLabel("Ответ программе").fill("первая строка");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator(".live-console-output")).toContainText(
    "echo:первая строка",
  );
  await page
    .getByRole("button", { name: "Завершить ввод", exact: true })
    .click();
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "EOF завершён",
    { timeout: 30000 },
  );
  await expect(
    page.getByRole("button", { name: "Запуск", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await run(page);
  await expect(page.locator(".live-console-output")).toContainText(
    "Готов к вводу",
    { timeout: 60000 },
  );
  const runId = page.url().split("/runs/")[1];
  await page
    .getByRole("button", { name: "Остановить выполнение", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + `/runs/${runId}`)).json()).data
          .status,
      { timeout: 30000 },
    )
    .toBe("cancelled");
  await page.reload();
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "Готов к вводу",
    { timeout: 30000 },
  );
});

test("cancelling a queued run stays cancelled after reload without inventing a report", async ({
  page,
}) => {
  const first = await project(
    page,
    'import java.util.Scanner; public class Main { public static void main(String[] a) { System.out.println("holding worker"); new Scanner(System.in).nextLine(); } }',
  );
  await run(page);
  await expect(page.locator(".live-console-output")).toContainText(
    "holding worker",
    { timeout: 60000 },
  );
  const firstRun = page.url().split("/runs/")[1];
  try {
    const second = await project(
      page,
      'public class Main { public static void main(String[] a) { System.out.println("queued"); } }',
    );
    const snapshot = await head(page.request, second.base);
    const response = await page.request.post(second.base + "/runs", {
      headers: await headers(page.request),
      data: {
        revisionId: snapshot.id,
        profileId: "java21-v1",
        entryPoint: "Main",
        argv: [],
        stdinUtf8: "",
        interactive: true,
      },
    });
    expect(response.status()).toBe(202);
    const queued = (await response.json()).data;
    await page.goto("/projects/" + second.id + "/runs/" + queued.id);
    await page
      .getByRole("button", { name: "Остановить выполнение", exact: true })
      .click();
    await expect(page.locator('[data-panel-id="console"]')).toContainText(
      "Запуск отменён",
    );
    await page.reload();
    await expect(page.locator('[data-panel-id="console"]')).toContainText(
      "Запуск отменён",
    );
    const job = (
      await (await page.request.get(second.base + "/runs/" + queued.id)).json()
    ).data;
    expect(job.status).toBe("cancelled");
    expect(job.result).toBeNull();
    expect((await head(page.request, second.base)).id).toBe(snapshot.id);
  } finally {
    await page.request.post(first.base + "/jobs/" + firstRun + "/cancel", {
      headers: await headers(page.request),
    });
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(first.base + "/runs/" + firstRun)
            ).json()
          ).data.status,
        { timeout: 30000 },
      )
      .toBe("cancelled");
  }
});

test("typing during a pending autosave never truncates the next snapshot", async ({
  page,
}) => {
  const { base } = await project(
    page,
    "public class Main { static int value=1; public static void main(String[] args) {} }\n",
  );
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const intercepted = new Promise<void>((r) => (started = r));
  let first = true;
  await page.route("**" + base + "/revisions", async (route) => {
    if (route.request().method() !== "POST" || !first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch();
    started();
    await hold;
    await route.fulfill({ response });
  });
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("// first edit\n");
  await intercepted;
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("// второй ввод во время сохранения\n");
  release();
  await expect
    .poll(async () => (await head(page.request, base)).files[0].canonicalText, {
      timeout: 30000,
    })
    .toContain("// второй ввод во время сохранения");
  await page.reload();
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+End");
  await expect(page.locator(".monaco-editor")).toContainText(
    "второй ввод во время сохранения",
  );
});

test("condition and return edges use the color of their source blocks", async ({
  page,
}) => {
  await project(
    page,
    "public class Main { public static void main(String[] args) { System.out.println(check(1)); } static int check(int x) { if(x<0) return -1; return x; } }",
  );
  await page.locator(".method-item").filter({ hasText: "check(int)" }).click();
  await expect(
    page.locator('.blueprint-node[data-visual-kind="return"]'),
  ).toHaveCount(2);
  const readColors = () =>
    page.locator(".react-flow__node-blueprint").evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const block = node.querySelector(".blueprint-node")!;
        const kind = block.getAttribute("data-visual-kind");
        if (kind !== "return" && kind !== "condition") return [];
        const path = document.querySelector(
          `g[data-route-source="${node.getAttribute("data-id")}"] .react-flow__edge-path`,
        );
        const icon = block.querySelector(".graph-node-icon");
        return path && icon
          ? [
              {
                kind,
                edge: getComputedStyle(path).stroke,
                block: getComputedStyle(icon).color,
              },
            ]
          : [];
      }),
    );

  await expect
    .poll(async () => {
      const list = await readColors();
      return (
        list.some((c) => c.kind === "return") &&
        list.some((c) => c.kind === "condition")
      );
    })
    .toBe(true);
  const colors = await readColors();
  for (const c of colors) expect(c.edge).toBe(c.block);
});

test("invalid replacement shows compiler feedback without applying or losing the original", async ({
  page,
}) => {
  const { base } = await project(
    page,
    "public class Main { public static void main(String[] args) { int value=1; System.out.println(value); } }",
  );
  const original = await head(page.request, base);
  const block = page
    .locator('.blueprint-node[data-node-kind="ExpressionStmt"]')
    .filter({ hasText: "int value" });
  await panToNode(page, block);
  await block.dblclick();
  await page.getByLabel("Код блока", { exact: true }).fill("String value = 1;");
  await page
    .getByRole("button", { name: "Подготовить изменение", exact: true })
    .click();
  await expect(page.locator('[data-panel-id="changes"]')).toContainText(
    "Ошибка компиляции",
    { timeout: 60000 },
  );
  await expect(page.locator('[data-panel-id="changes"]')).toContainText(
    "incompatible types",
  );
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  expect((await head(page.request, base)).id).toBe(original.id);
  expect((await head(page.request, base)).files[0].canonicalText).toBe(
    original.files[0].canonicalText,
  );
});
