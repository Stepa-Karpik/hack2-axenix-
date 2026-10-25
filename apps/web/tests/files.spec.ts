import { publishProject } from "./flowAssertions";
import { chooseOption } from "./selectControl";
import { setTheme } from "./flowAssertions";
import { expect, test } from "@playwright/test";
import { fixture, head, headers, source, unzip, zip } from "./fileFixtures";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("file tree snapshots preserve empty directories, reject stale CAS and export exact old/new revisions", async ({
  request,
}) => {
  const { base, original } = await fixture(request);
  const key = crypto.randomUUID();
  const body = {
    files: original.files.map((file) => ({
      path: file.path === "Main.java" ? "src/Main.java" : file.path,
      content: file.canonicalText,
    })),
    directories: ["src", "src/deep", "empty"],
    intent: "semantic_edit",
  };
  const options = {
    headers: await headers(request, original.id, key),
    data: body,
  };
  const response = await request.post(base + "/revisions", options);
  expect(response.status()).toBe(201);
  const moved = (await response.json()).data;
  expect(moved.id).not.toBe(original.id);
  expect(moved.bundleHash).not.toBe(original.bundleHash);
  expect(moved.directories).toEqual(["empty", "src", "src/deep"]);
  expect(moved.files.map((f: { path: string }) => f.path)).toEqual([
    "notes.txt",
    "src/Main.java",
  ]);
  expect(
    moved.files.find((f: { path: string }) => f.path === "src/Main.java")
      .canonicalText,
  ).toBe(source);
  const replay = await request.post(base + "/revisions", options);
  expect(replay.status()).toBe(201);
  expect((await replay.json()).data.id).toBe(moved.id);
  const stale = await request.post(base + "/revisions", {
    headers: await headers(request, original.id),
    data: { ...body, directories: ["other"] },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe("REVISION_CONFLICT");
  expect((await head(request, base)).id).toBe(moved.id);
  expect(
    (await (await request.get(base + "/revisions/" + original.id)).json()).data,
  ).toEqual(original);
  for (const revision of [original, moved]) {
    const exported = await request.post(base + "/exports", {
      headers: await headers(request),
      data: { revisionId: revision.id, includeReportIds: [] },
    });
    expect(exported.status()).toBe(201);
    const artifact = (await exported.json()).data;
    expect(artifact.revisionId).toBe(revision.id);
    const download = await request.get(artifact.downloadUrl);
    expect(download.ok()).toBe(true);
    const contents = unzip(await download.body());
    expect(
      Object.fromEntries(
        Object.entries(contents).filter(([path]) => !path.endsWith("/")),
      ),
    ).toEqual(
      Object.fromEntries(
        revision.files.map((file: { path: string; canonicalText: string }) => [
          file.path,
          file.canonicalText,
        ]),
      ),
    );
    for (const directory of revision.directories ?? [])
      expect(contents[directory + "/"]).toBe("");
  }
});

test("ZIP preview is read-only and rejects hostile or ambiguous archives without losing source", async ({
  request,
}) => {
  const { base, original } = await fixture(request);
  const preview = async (buffer: Buffer) =>
    request.post(base + "/import-previews", {
      headers: await headers(request),
      multipart: {
        files: { name: "project.zip", mimeType: "application/zip", buffer },
      },
    });
  const valid = await preview(
    zip([
      { path: "package/" },
      { path: "package/empty/" },
      {
        path: "package/Helper.java",
        text: "class Helper {}\r\n",
        deflate: true,
      },
      { path: "README.txt", text: "café\n" },
    ]),
  );
  expect(valid.status()).toBe(200);
  const parsed = (await valid.json()).data;
  expect(parsed.directories).toEqual(["package", "package/empty"]);
  expect(parsed.files).toEqual([
    { path: "README.txt", content: "café\n" },
    { path: "package/Helper.java", content: "class Helper {}\r\n" },
  ]);
  expect((await head(request, base)).id).toBe(original.id);
  const cases = [
    [{ path: "../Escape.java", text: "class Escape {}" }],
    [{ path: "/Absolute.java", text: "class Absolute {}" }],
    [{ path: "C:/Drive.java", text: "class Drive {}" }],
    [{ path: "p\\Backslash.java", text: "class Backslash {}" }],
    [
      { path: "Duplicate.java", text: "class A {}" },
      { path: "Duplicate.java", text: "class B {}" },
    ],
    [
      { path: "collision", text: "text" },
      { path: "collision/Inside.java", text: "class Inside {}" },
    ],
    [{ path: "too-large.txt", text: "x".repeat(1048577), deflate: true }],
    Array.from({ length: 101 }, (_, index) => ({
      path: `f${index}.txt`,
      text: "",
    })),
  ];
  for (const entries of cases) {
    const rejected = await preview(zip(entries));
    expect([400, 409, 413]).toContain(rejected.status());
    expect((await head(request, base)).id).toBe(original.id);
  }
  const imported = await request.post(base + "/revisions", {
    headers: await headers(request, original.id),
    data: {
      files: [
        ...original.files.map((file) => ({
          path: file.path,
          content: file.canonicalText,
        })),
        ...parsed.files,
      ],
      directories: [...original.directories!, ...parsed.directories],
      importedPaths: parsed.files.map((file: { path: string }) => file.path),
      intent: "semantic_edit",
    },
  });
  expect(imported.status()).toBe(201);
  const saved = (await imported.json()).data;
  expect(
    saved.files.find(
      (file: { path: string }) => file.path === "package/Helper.java",
    ).canonicalText,
  ).toBe("class Helper {}\n");
  expect(
    (await (await request.get(base + "/revisions/" + original.id)).json()).data,
  ).toEqual(original);
  const collision = await request.post(base + "/revisions", {
    headers: await headers(request, saved.id),
    data: {
      files: saved.files.map(
        (file: { path: string; canonicalText: string }) => ({
          path: file.path,
          content: file.canonicalText,
        }),
      ),
      directories: saved.directories,
      importedPaths: ["Main.java"],
      intent: "semantic_edit",
    },
  });
  expect(collision.status()).toBe(409);
  expect((await collision.json()).error.code).toBe("FILE_CONFLICT");
  expect((await head(request, base)).id).toBe(saved.id);
});

test("non-Java trees remain editable and restore preserves original text and directories", async ({
  request,
}) => {
  const { base, original } = await fixture(request);
  const response = await request.post(base + "/revisions", {
    headers: await headers(request, original.id),
    data: {
      files: [{ path: "данные/read me.txt", content: "Привет\n" }],
      directories: ["данные", "empty/deep"],
      intent: "semantic_edit",
    },
  });
  expect(response.status()).toBe(201);
  const textOnly = (await response.json()).data;
  expect(textOnly.bundleHash).toBeNull();
  for (const [suffix, body] of [
    ["/revisions/" + textOnly.id + "/analysis", {}],
    ["/compilations", { revisionId: textOnly.id, profileId: "java21-v1" }],
    [
      "/runs",
      {
        revisionId: textOnly.id,
        profileId: "java21-v1",
        entryPoint: "Main",
        argv: [],
        stdinUtf8: "",
      },
    ],
  ] as const) {
    const rejected = await request.post(base + suffix, {
      headers: await headers(request),
      data: body,
    });
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).data).toBeUndefined();
    expect((await head(request, base)).id).toBe(textOnly.id);
  }
  const restored = await request.post(
    base + "/revisions/" + original.id + "/restore",
    {
      headers: await headers(request, textOnly.id),
      data: { expectedHeadRevisionId: textOnly.id },
    },
  );
  expect(restored.status()).toBe(201);
  const snapshot = (await restored.json()).data;
  expect(
    snapshot.files.map((file: { path: string; canonicalText: string }) => [
      file.path,
      file.canonicalText,
    ]),
  ).toEqual(original.files.map((file) => [file.path, file.canonicalText]));
  expect(snapshot.directories).toEqual(original.directories);
  expect(
    (await (await request.get(base + "/revisions/" + textOnly.id)).json()).data
      .files[0].canonicalText,
  ).toBe("Привет\n");
});

test("explorer creation, subtree rename and drag preserve source while tabs retain editor undo and selected method", async ({
  page,
}, testInfo) => {
  const { projectId, base } = await fixture(page.request);
  await page.goto("/projects/" + projectId);
  await expect(
    page.locator(".method-item").filter({ hasText: "answer(" }),
  ).toBeVisible({ timeout: 30000 });
  await page.locator(".method-item").filter({ hasText: "answer(" }).click();
  const editor = page.locator(".monaco-editor textarea.inputarea");
  await editor.focus();
  await page.keyboard.press("Control+Home");
  for (let line = 0; line < 3; line++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  for (let column = 0; column < source.split("\n")[3].indexOf("42"); column++)
    await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.insertText("43");
  await publishProject(page);
  await expect
    .poll(
      async () =>
        (await head(page.request, base)).files.find(
          (file) => file.path === "Main.java",
        )?.canonicalText,
    )
    .toContain("marker = 43");
  await expect(page.locator(".method-item.active")).toContainText("answer(");
  await editor.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.locator('[data-file-path="notes.txt"]').click();
  await expect(page.locator(".monaco-editor")).toContainText("keep exact café");
  await page.getByRole("tab", { name: "Main.java", exact: true }).click();
  await expect(page.locator(".monaco-editor")).toContainText("marker = 43");
  await editor.focus();
  // Inserting over the previous selection proves that per-file view state returned.
  await page.keyboard.insertText("44");
  await expect(page.locator(".monaco-editor")).toContainText("marker = 44;");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".monaco-editor")).toContainText("marker = 43;");
  await page.keyboard.press("Control+z");
  await publishProject(page);
  await expect
    .poll(
      async () =>
        (await head(page.request, base)).files.find(
          (file) => file.path === "Main.java",
        )?.canonicalText,
    )
    .toBe(source);
  await expect(page.locator(".method-item.active")).toContainText("answer(");
  await page
    .getByRole("button", { name: "Создать папку", exact: true })
    .click();
  await page
    .getByLabel("Путь новой папки", { exact: true })
    .fill("nested/empty");
  await page.locator("#explorer-path").press("Enter");
  await expect
    .poll(async () => (await head(page.request, base)).directories)
    .toContain("nested/empty");
  await page.getByRole("button", { name: "Создать файл", exact: true }).click();
  await page
    .getByLabel("Путь нового файла", { exact: true })
    .fill("nested/info.txt");
  await page.locator("#explorer-path").press("Enter");
  await expect
    .poll(async () =>
      (await head(page.request, base)).files.map((file) => file.path),
    )
    .toContain("nested/info.txt");
  // Folder operations apply to the complete subtree, including an empty child.
  await page.locator('[data-directory-path="nested"]').click();
  await page
    .getByRole("button", { name: "Переименовать", exact: true })
    .click();
  await page.getByLabel("Новый путь", { exact: true }).fill("renamed");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect
    .poll(async () => (await head(page.request, base)).directories)
    .toContain("renamed/empty");
  await page.locator('[data-file-path="notes.txt"]').click();
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("unsaved across move\n");
  await page
    .locator('[data-file-path="Main.java"]')
    .dragTo(page.locator('[data-directory-path="renamed"]'));
  await expect
    .poll(async () =>
      (await head(page.request, base)).files.map((file) => file.path),
    )
    .toContain("renamed/Main.java");
  const moved = await head(page.request, base);
  expect(
    moved.files.find((file) => file.path === "renamed/Main.java")
      ?.canonicalText,
  ).toBe(source);
  expect(
    moved.files.find((file) => file.path === "notes.txt")?.canonicalText,
  ).toBe("keep exact café\nunsaved across move\n");
  expect(moved.directories).toEqual(
    expect.arrayContaining(["empty", "renamed", "renamed/empty"]),
  );
  expect(moved.files.some((file) => file.path.startsWith("nested/"))).toBe(
    false,
  );
  await page.locator('[data-file-path="renamed/Main.java"]').click();
  await page.reload();
  await expect(page.locator('[data-directory-path="renamed"]')).toBeVisible();
  await expect(page.locator(".monaco-editor")).toContainText(
    "public class Main",
  );
  await page.screenshot({
    path: testInfo.outputPath("explorer-tabs-light.png"),
  });
  await setTheme(page, "dark");
  await page.screenshot({
    path: testInfo.outputPath("explorer-tabs-dark.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseOption(
    page.getByRole("combobox", { name: "Открытая панель" }),
    "project",
  );
  await expect(page.locator('[data-directory-path="renamed"]')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("explorer-narrow-dark.png"),
  });
  expect((await head(page.request, base)).id).toBe(moved.id);
  await writeFile(
    testInfo.outputPath("project.json"),
    JSON.stringify(
      { projectId, url: "/projects/" + projectId, head: moved.id },
      null,
      2,
    ),
  );
});

test("runner uses each selected immutable Java snapshot after a file move and keeps companion files", async ({
  request,
}) => {
  test.setTimeout(180000);
  const capabilities = (
    await (await request.get("/api/v1/capabilities")).json()
  ).data;
  test.skip(
    !capabilities.runner.available,
    "Real isolated runner unavailable; no execution claim.",
  );
  const { base, original } = await fixture(request);
  const response = await request.post(base + "/revisions", {
    headers: await headers(request, original.id),
    data: {
      files: [
        { path: "src/Main.java", content: source.replace("42", "43") },
        { path: "notes.txt", content: "keep exact café\n" },
      ],
      directories: ["empty", "src"],
      intent: "semantic_edit",
    },
  });
  expect(response.status()).toBe(201);
  const current = (await response.json()).data;
  for (const [revision, output] of [
    [original, "42\n"],
    [current, "43\n"],
  ] as const) {
    const started = await request.post(base + "/runs", {
      headers: await headers(request),
      data: {
        revisionId: revision.id,
        entryPoint: "Main",
        argv: [],
        stdinUtf8: "",
        profileId: "java21-v1",
      },
    });
    expect(started.status()).toBe(202);
    const job = (await started.json()).data;
    await expect
      .poll(
        async () =>
          (await (await request.get(base + "/jobs/" + job.id)).json()).data
            .status,
        { timeout: 70000 },
      )
      .toBe("succeeded");
    const completed = (
      await (await request.get(base + "/runs/" + job.id)).json()
    ).data;
    expect(completed.result.report.revisionId).toBe(revision.id);
    expect(completed.result.report.stdinUtf8).toBe("");
    expect(completed.result.report.compileExecution.exitCode).toBe(0);
    expect(completed.result.report.runtimeExecution.stdoutUtf8).toBe(output);
    expect(completed.result.report.runtimeExecution.exitCode).toBe(0);
  }
  expect(
    (await head(request, base)).files.find((file) => file.path === "notes.txt")
      ?.canonicalText,
  ).toBe("keep exact café\n");
});

test("ZIP and native folder pickers preview relative paths and commit only selected files", async ({
  page,
}, testInfo) => {
  const { projectId, base, original } = await fixture(page.request);
  await page.goto("/projects/" + projectId);
  await expect(page.locator('[data-file-path="Main.java"]')).toBeVisible();
  await page
    .locator(".explorer-tools")
    .getByRole("button", { name: "Импорт", exact: true })
    .click();
  const zipChooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Выбрать ZIP или файлы", exact: true })
    .click();
  await (
    await zipChooser
  ).setFiles({
    name: "selected.zip",
    mimeType: "application/zip",
    buffer: zip([
      { path: "imported/empty/" },
      { path: "imported/Helper.java", text: "\uFEFFclass Helper {}\r\n" },
      { path: "skip.txt", text: "must not import" },
    ]),
  });
  const dialog = page.getByRole("dialog", { name: "Импорт файлов" });
  await expect(
    dialog.getByRole("checkbox", { name: "imported/Helper.java", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "skip.txt", exact: true })
    .uncheck();
  await page.screenshot({
    path: testInfo.outputPath("import-preview-light.png"),
  });
  expect((await head(page.request, base)).id).toBe(original.id);
  await dialog
    .getByRole("button", { name: "Импортировать выбранное", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const imported = await head(page.request, base);
  expect(imported.files.map((file) => file.path)).toEqual(
    expect.arrayContaining(["Main.java", "notes.txt", "imported/Helper.java"]),
  );
  expect(imported.files.some((file) => file.path === "skip.txt")).toBe(false);
  expect(imported.directories).toContain("imported/empty");
  const helper = imported.files.find(
    (file) => file.path === "imported/Helper.java",
  )!;
  expect(helper.canonicalText).toBe("class Helper {}\n");
  const raw = helper as typeof helper & {
    rawArtifactRef: string;
    normalization: { bomRemoved: boolean; lineEndingsNormalized: boolean };
  };
  expect(raw.normalization).toEqual({
    bomRemoved: true,
    lineEndingsNormalized: true,
  });
  const artifact = await page.request.get(
    base + "/artifacts/" + raw.rawArtifactRef,
  );
  expect(await artifact.body()).toEqual(
    Buffer.from("\uFEFFclass Helper {}\r\n"),
  );

  const folder = testInfo.outputPath("picked-folder");
  await mkdir(join(folder, "child"), { recursive: true });
  await mkdir(join(folder, "unobservable-empty"));
  await writeFile(
    join(folder, "child", "read me.txt"),
    "folder preserved\n",
    "utf8",
  );
  await writeFile(join(folder, "excluded.txt"), "excluded", "utf8");
  await page
    .locator(".explorer-tools")
    .getByRole("button", { name: "Импорт", exact: true })
    .click();
  const folderChooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Выбрать папку", exact: true })
    .click();
  await (await folderChooser).setFiles(folder);
  await expect(
    dialog.getByRole("checkbox", {
      name: "picked-folder/child/read me.txt",
      exact: true,
    }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "picked-folder/excluded.txt", exact: true })
    .uncheck();
  await dialog
    .getByRole("button", { name: "Импортировать выбранное", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const final = await head(page.request, base);
  expect(
    final.files.find((file) => file.path === "picked-folder/child/read me.txt")
      ?.canonicalText,
  ).toBe("folder preserved\n");
  expect(
    final.files.some((file) => file.path === "picked-folder/excluded.txt"),
  ).toBe(false);
  expect(final.directories).toContain("picked-folder/child");
  expect(final.directories).not.toContain("picked-folder/unobservable-empty");
});
