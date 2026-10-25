import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mount } from "./polishFixtures";
import { defaultLayout, groups, visiblePanels } from "../src/workspaceLayout";
const source = process.env.JB_THEME_FIXTURE_PATH;
const sample = () =>
  JSON.parse(readFileSync(source!, "utf8").replace(/^\uFEFF/, ""));

for (const legacy of [false, true]) {
  test(`photo lookup targets only requested controls (${legacy ? "saved" : "new"})`, async ({
    page,
  }, info) => {
    const { project, writes } = await mount(page, sample());
    await page.evaluate(() => {
      (window as any).focusSequence = [];
      new MutationObserver(() => {
        const value = document
          .querySelector("[data-assistant-focus]")
          ?.getAttribute("data-assistant-focus");
        const sequence = (window as any).focusSequence;
        if (value && sequence.at(-1)?.value !== value)
          sequence.push({ value, time: performance.now() });
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-assistant-focus"],
      });
    });
    let filePickers = 0;
    page.on("filechooser", () => filePickers++);
    const { chat, outcomes } = await assistant(
      page,
      project,
      "guide",
      legacy
        ? { topic: "profile" }
        : { topic: "profile_photo", mode: "locate" },
      "confirm",
      "Где изменить картинку профиля?",
      true,
    );
    await expect(
      chat.getByRole("button", { name: "Открыть", exact: true }),
    ).toHaveCount(0);
    await expect(
      chat.getByText("Текущий файл и версия", { exact: true }),
    ).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/projects/${project.id}`);
    await chat.getByRole("button", { name: "Показать", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(
      page.locator('[data-assistant-target="profile-photo-button"]'),
    ).toBeFocused();
    await expect(page.locator(".guided-tour")).toHaveCount(0);
    const sequence = await page.evaluate(() => (window as any).focusSequence);
    expect(sequence.map((item: any) => item.value)).toEqual([
      "profile-card",
      "profile-photo",
      "profile-photo-button",
    ]);
    for (let index = 1; index < sequence.length; index++) {
      expect(
        sequence[index].time - sequence[index - 1].time,
      ).toBeGreaterThanOrEqual(300);
      expect(sequence[index].time - sequence[index - 1].time).toBeLessThan(650);
    }
    await page.screenshot({ path: info.outputPath("photo-location.png") });
    expect(filePickers).toBe(0);
    expect(writes).toEqual([]);
    await expect.poll(() => outcomes[0]?.ok).toBe(true);
  });
}
async function assistant(
  page: Page,
  project: any,
  type: string,
  args: Record<string, unknown>,
  risk = "confirm",
  question = "Помоги с тестами",
  duplicateNavigation = false,
) {
  const outcomes: any[] = [];
  const action = {
    id: "action",
    type,
    args,
    risk,
    label:
      type === "guide"
        ? "Показать"
        : type === "workspace_action"
          ? "Выполнить"
          : type === "layout_action"
            ? "Изменить окна"
          : type === "optimize"
            ? "Оптимизировать"
            : type === "run_program"
              ? "Запустить программу"
              : "Запустить тесты",
    description: "Текущий файл и версия",
    status: "pending",
  };
  const conversation = {
    id: "chat",
    title: "Проверка помощника",
    messages: [] as any[],
  };
  await page.route("**/api/v1/assistant/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: any = conversation;
    if (path.endsWith("/status")) data = { configured: true, model: "fixture" };
    else if (
      path.endsWith("/conversations") &&
      route.request().method() === "GET"
    )
      data = [];
    else if (path.endsWith("/messages")) {
      conversation.messages = [
        {
          id: "question",
          role: "user",
          content: question,
          createdAt: new Date().toISOString(),
        },
        {
          id: "reply",
          role: "assistant",
          content: "Выберите действие",
          actions: duplicateNavigation
            ? [
                action,
                {
                  ...action,
                  id: "navigation",
                  type: "navigate",
                  risk: "none",
                  label: "Открыть",
                  args: { route: "profile" },
                },
              ]
            : [action],
          createdAt: new Date().toISOString(),
        },
      ];
    } else if (path.endsWith("/actions/action/result")) {
      outcomes.push(route.request().postDataJSON());
      data = { action: { ...action, status: "completed" } };
    } else if (path.endsWith("/actions/action"))
      data = {
        action,
        command: { type, args: { ...args, projectId: project.id } },
      };
    await route.fulfill({ json: { data } });
  });
  await page
    .getByRole("button", { name: "Открыть беседу с помощником" })
    .click();
  const chat = page.getByRole("dialog", { name: "Помощник — беседа" });
  await chat.getByLabel("Сообщение помощнику").fill(question);
  await chat.getByRole("button", { name: "Отправить сообщение" }).click();
  return { chat, outcomes };
}
async function step(page: Page, id: string) {
  await expect(page.locator(".guided-tour")).toHaveAttribute(
    "data-tour-step",
    id,
  );
  await expect(page.locator(".tour-aperture")).toBeVisible();
}

const locations = [
  ["tests", "tests-start", "Как запустить тесты?", ""],
  ["tests_results", "tests-result", "Где результаты тестов?", ""],
  ["run", "run-start", "Где запуск программы?", ""],
  ["run_console", "run-result", "Где консоль для Scanner?", ""],
  ["appearance", "theme-options", "Где поменять тему?", "/settings/appearance"],
  [
    "appearance_oled",
    "appearance_oled",
    "Где OLED тема?",
    "/settings/appearance",
  ],
  [
    "appearance_palette",
    "palette-apply",
    "Где своя палитра?",
    "/settings/appearance",
  ],
  ["files_create", "files_create", "Где создать файл?", ""],
  ["files_folder", "files_folder", "Где создать папку?", ""],
  ["files_rename", "files_rename", "Где переименовать файл?", ""],
  ["files_delete", "files_delete", "Где удалить файл?", ""],
  ["files_download", "files_download", "Где скачать файл?", ""],
  ["files_import", "files_import", "Где импорт из GitHub или ZIP?", ""],
  ["integrations", "integrations", "Где интеграции?", "/settings/integrations"],
  [
    "integrations_github",
    "github-control",
    "Где подключить GitHub?",
    "/settings/integrations",
  ],
];
for (const [topic, target, question, route] of locations) {
  test(`precise location: ${topic} does not run an operation or onboarding`, async ({
    page,
  }, info) => {
    const { project, writes } = await mount(page, sample());
    // Results must also be discoverable when the corresponding panel was hidden.
    if (["tests_results", "run_console", "files_create"].includes(topic)) {
      const panel =
        topic === "tests_results"
          ? "tests"
          : topic === "run_console"
            ? "console"
            : "project";
      const label = { tests: "Тесты", console: "Консоль", project: "Проект" }[
        panel
      ];
      const close = page.locator(
        `[data-tile-panel="${panel}"] button[aria-label="Скрыть ${label}"]`,
      );
      if (await close.count()) await close.click();
    }
    const beforeTheme = await page
      .locator("html")
      .getAttribute("data-theme-preset");
    const { chat, outcomes } = await assistant(
      page,
      project,
      "guide",
      { topic, mode: "locate" },
      "confirm",
      question,
      true,
    );
    await chat.getByRole("button", { name: "Показать", exact: true }).click();
    await expect(page.locator(".assistant-locator")).toHaveAttribute(
      "data-assistant-focus",
      target,
    );
    await expect(page.locator(".guided-tour")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(
      route || `/projects/${project.id}`,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preset",
      beforeTheme!,
    );
    expect(writes).toEqual([]);
    await expect.poll(() => outcomes[0]?.ok).toBe(true);
    if (
      ["integrations_github", "files_create", "tests_results"].includes(topic)
    ) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: info.outputPath(`${topic}.png`) });
    }
  });
}
test.beforeEach(() => test.skip(!source, "Captured parser graph required"));

test("project lookup returns from settings and reveals the requested file button", async ({
  page,
}) => {
  const { project, writes } = await mount(page, sample());
  await page.evaluate(() => {
    history.pushState({}, "", "/settings/appearance");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator(".appearance-settings")).toBeVisible();
  const { chat } = await assistant(page, project, "guide", {
    topic: "files_folder",
    mode: "locate",
  });
  await chat.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await expect(page.locator(".assistant-locator")).toHaveAttribute(
    "data-assistant-focus",
    "files_folder",
  );
  expect(writes).toEqual([]);
});

test("connected GitHub lookup highlights connection state without reconnecting", async ({
  page,
}) => {
  const { project, writes } = await mount(page, sample());
  await page.route("**/api/v1/github/status", (route) =>
    route.fulfill({
      json: {
        data: {
          configured: true,
          linked: { login: "fixture" },
          repositoryAccess: true,
        },
      },
    }),
  );
  const { chat } = await assistant(page, project, "guide", {
    topic: "integrations_github",
    mode: "locate",
  });
  await chat.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(page.locator(".assistant-locator")).toHaveAttribute(
    "data-assistant-focus",
    "github-control",
  );
  await expect(
    page.locator('[data-assistant-target="github-control"]'),
  ).toHaveText("Подключено");
  expect(writes).toEqual([]);
});
test("assistant guide opens real comparison settings and waits for a new result", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const fixture = sample();
  const { project, writes } = await mount(page, fixture);
  let polls = 0;
  const id = "ef111111-1111-4111-8111-111111111111";
  const job = {
    id,
    type: "compare",
    status: "running",
    revisionId: fixture.revision.id,
    entryPoint: "Main",
    progress: {
      phase: "running",
      finished: false,
      total: 3,
      completed: 0,
      matched: 0,
      elapsedMs: 20,
      plannedRepeatCount: 3,
      binding: { candidateRevisionId: fixture.revision.id },
      cases: [],
    },
  };
  await page.route("**/api/v1/projects/*/test-suites", (route) =>
    route.fulfill({ json: { data: { id: "suite" } } }),
  );
  await page.route("**/api/v1/projects/*/comparisons", (route) =>
    route.fulfill({ json: { data: job } }),
  );
  await page.route(`**/api/v1/projects/*/runs/${id}`, async (route) => {
    polls++;
    await route.fulfill({
      json: {
        data:
          polls < 4
            ? job
            : {
                ...job,
                status: "failed",
                progress: {
                  ...job.progress,
                  phase: "finished",
                  finished: true,
                  outcome: "compile_error",
                },
                error: { code: "COMPILE_ERROR", message: "Fixture failure" },
              },
      },
    });
  });
  const { chat, outcomes } = await assistant(page, project, "guide", {
    topic: "tests",
    mode: "walkthrough",
  });
  await chat.getByRole("button", { name: "Показать", exact: true }).click();
  await step(page, "file");
  await expect(chat).toHaveCount(0);
  await page
    .locator("[data-file-path]:not([data-directory-path])")
    .first()
    .click();
  await step(page, "method");
  await page.locator(".method-item").first().click();
  await step(page, "assistant-open-run");
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  await step(page, "assistant-entry");
  await page.locator("#entrypoint").click();
  await step(page, "assistant-versions");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await step(page, "assistant-parameters");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await step(page, "assistant-start");
  await page.locator("[data-assistant-start]").click();
  await step(page, "assistant-wait");
  await expect(page.locator(".guided-tour")).toHaveAttribute(
    "data-tour-step",
    "assistant-finished",
    { timeout: 20000 },
  );
  await expect(page.locator(".tour-card")).toContainText("ошибк");
  await expect(page.locator(".tour-card")).not.toContainText("Тесты пройдены");
  await page.screenshot({ path: info.outputPath("guide-test-result.png") });
  await expect.poll(() => outcomes[0]?.ok).toBe(true);
  expect(writes).toEqual([]);
});
test("confirmed test command opens configuration when no matching saved launch exists", async ({
  page,
}) => {
  const { project, writes } = await mount(page, sample());
  const { chat, outcomes } = await assistant(page, project, "run_tests", {});
  await expect(
    page.getByRole("dialog", { name: "Сравнение версий" }),
  ).toHaveCount(0);
  await chat.getByRole("button", { name: "Да, запустить тесты" }).click();
  await expect(
    page.getByRole("dialog", { name: "Сравнение версий" }),
  ).toBeVisible();
  await expect.poll(() => outcomes.length).toBe(1);
  expect(outcomes[0].message).toContain("ещё не запущены");
  expect(writes).toEqual([]);
});

test("compact chat expands above the mobile workbench dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { project } = await mount(page, sample());
  const { chat } = await assistant(page, project, "guide", { topic: "tests" });
  const compact = (await chat.boundingBox())!;
  await chat
    .getByRole("button", { name: "Развернуть беседу", exact: true })
    .click();
  await expect
    .poll(async () => (await chat.boundingBox())!.height)
    .toBeGreaterThan(compact.height + 100);
  const expanded = (await chat.boundingBox())!;
  expect(expanded.y).toBeGreaterThanOrEqual(0);
  expect(expanded.y + expanded.height).toBeLessThanOrEqual(700);
  await chat
    .getByRole("button", { name: "Компактный вид беседы", exact: true })
    .click();
  await expect
    .poll(async () =>
      Math.abs((await chat.boundingBox())!.height - compact.height),
    )
    .toBeLessThan(2);
});

const catalog = JSON.parse(
  readFileSync(
    new URL(
      "../../server/src/main/resources/assistant-locations.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const previouslyCovered = new Set([
  ...locations.map((item) => item[0]),
  "profile_photo",
]);
for (const [topic, definition] of Object.entries(catalog) as [string, any][]) {
  if (previouslyCovered.has(topic)) continue;
  test(`catalog location ${topic} opens the actual declared UI`, async ({
    page,
  }) => {
    const { project, writes } = await mount(page, sample());
    const { chat, outcomes } = await assistant(page, project, "guide", {
      topic,
      mode: "locate",
    });
    await chat.getByRole("button", { name: "Показать", exact: true }).click();
    await expect.poll(() => outcomes[0]?.ok, { timeout: 12000 }).toBe(true);
    const target = page.locator(definition.selectors.at(-1)).first();
    await expect(target).toBeVisible();
    if (definition.tab) {
      await expect(
        page.locator(`[data-assistant-target="analysis-${definition.tab}"]`),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.locator(
          `[data-assistant-target="analysis-content-${definition.tab}"]`,
        ),
      ).toBeVisible();
      await expect(page.locator('[data-tile-panel="tests"]')).toHaveCount(0);
    }
    await expect(page.locator(".guided-tour")).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
for (const [action, selector] of [
  ["create_file", "#explorer-path"],
  ["create_folder", "#explorer-path"],
  ["import", "#import-title"],
  ["run_settings", "#entrypoint"],
  ["test_settings", "#entrypoint"],
]) {
  test(`confirmed workspace command ${action} opens its real form without mutation`, async ({
    page,
  }) => {
    const { project, writes } = await mount(page, sample());
    const { chat, outcomes } = await assistant(
      page,
      project,
      "workspace_action",
      { action },
    );
    await chat.getByRole("button", { name: "Выполнить", exact: true }).click();
    await expect(page.locator(selector)).toBeVisible();
    await expect.poll(() => outcomes[0]?.ok).toBe(true);
    expect(writes).toEqual([]);
  });
}
test("run program command opens actual launch settings when no saved launch exists", async ({
  page,
}) => {
  const { project, writes } = await mount(page, sample());
  const { chat, outcomes } = await assistant(page, project, "run_program", {});
  await chat
    .getByRole("button", { name: "Запустить программу", exact: true })
    .click();
  await expect(page.locator("#entrypoint")).toBeVisible();
  await expect.poll(() => outcomes[0]?.message).toContain("ещё не запущена");
  expect(writes).toEqual([]);
});
test("optimization command opens actual recommendations when no supported candidate exists", async ({
  page,
}) => {
  const { project, writes } = await mount(page, sample());
  const { chat, outcomes } = await assistant(page, project, "optimize", {});
  await chat
    .getByRole("button", { name: "Оптимизировать", exact: true })
    .click();
  await expect(
    page.locator('[data-assistant-target="analysis-recommendations"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => outcomes[0]?.ok === false).toBe(true);
  expect(outcomes[0].message).toContain("не нашёл поддерживаемой");
  expect(writes).toEqual([]);
});
test("interrupted locator reports failure rather than claiming it showed the target", async ({
  page,
}) => {
  const { project } = await mount(page, sample());
  const { chat, outcomes } = await assistant(page, project, "guide", {
    topic: "analysis_metrics",
    mode: "locate",
  });
  await chat.getByRole("button", { name: "Показать", exact: true }).click();
  await expect(
    page.locator(".assistant-locator .target-spotlight"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => outcomes[0]?.ok).toBe(false);
  expect(outcomes[0].message).toContain("Не удалось показать");
});

for (const args of [
  {operation:"open",panel:"tests"}, {operation:"hide",panel:"code"},
  {operation:"toggle",panel:"code"}, {operation:"maximize",panel:"code"},
  {operation:"unmaximize"}, {operation:"swap",panel:"code",targetPanel:"console"},
  {operation:"resize",panel:"code",axis:"width",percent:35},
  {operation:"save"}, {operation:"save_default"}, {operation:"restore"},
  {operation:"reset"}, {operation:"preset",preset:"review"},
  {operation:"dock_navigation"}, {operation:"undock_navigation"},
  {operation:"collapse_navigation"}, {operation:"expand_navigation"},
  {operation:"hide",panel:"graph"},
]) {
  test(`confirmed layout command ${JSON.stringify(args)} changes real workspace and reports result`,async({page})=>{
    const data=sample(),pid=data.project.id;
    const layout=defaultLayout();
    await page.addInitScript(({pid,layout,operation})=>{
      localStorage.setItem("java-blueprints:workspace:v2:"+pid,JSON.stringify(layout));
      localStorage.setItem("java-blueprints:window-state:"+pid,JSON.stringify({
        focused:"code",maximized:operation==="unmaximize"?"code":null,
        navigationDocked:operation==="undock_navigation",collapsedNavigation:operation==="expand_navigation",
      }));
    },{pid,layout,operation:args.operation});
    const {project,writes}=await mount(page,data);
    const stored=()=>page.evaluate(id=>JSON.parse(localStorage.getItem("java-blueprints:workspace:v2:"+id)!),pid);
    const before=await stored();
    const {chat,outcomes}=await assistant(page,project,"layout_action",args,"confirm","Измени окна");
    expect(outcomes).toHaveLength(0);
    expect(await stored()).toEqual(before);
    await chat.getByRole("button",{name:"Изменить окна",exact:true}).click();
    await expect.poll(()=>outcomes.length).toBe(1);
    const protectedCanvas=args.operation==="hide"&&args.panel==="graph";
    expect(outcomes[0].ok).toBe(!protectedCanvas);
    const after=await stored();
    if(args.operation==="open")expect(visiblePanels(after)).toContain("tests");
    if(args.operation==="hide"&&!protectedCanvas || args.operation==="toggle")expect(visiblePanels(after)).not.toContain("code");
    if(args.operation==="swap") {
      expect(groups(after.root).find(g=>g.id==="code")?.tabs).toContain("console");
      expect(groups(after.root).find(g=>g.id==="output")?.tabs).toContain("code");
    }
    if(args.operation==="resize")expect(after).not.toEqual(before);
    if(args.operation==="save"||args.operation==="save_default") {
      const key="java-blueprints:workspace-saved:v1:"+(args.operation==="save"?pid:"default");
      expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key)).toMatchObject({version:1,layout:after});
    }
    const state=await page.evaluate(id=>JSON.parse(localStorage.getItem("java-blueprints:window-state:"+id)!),pid);
    if(args.operation==="maximize")expect(state.maximized).toBe("code");
    if(args.operation==="unmaximize")expect(state.maximized).toBeNull();
    if(args.operation==="dock_navigation")expect(state.navigationDocked).toBe(true);
    if(args.operation==="undock_navigation")expect(state.navigationDocked).toBe(false);
    if(args.operation==="collapse_navigation")expect(state.collapsedNavigation).toBe(true);
    if(args.operation==="expand_navigation")expect(state.collapsedNavigation).toBe(false);
    if(protectedCanvas)expect(after).toEqual(before);
    expect(writes).toEqual([]);
  });
}
