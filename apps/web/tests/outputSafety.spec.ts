import { createHash } from "node:crypto";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { headers, head } from "./fileFixtures";
import { revealPanel } from "./flowAssertions";

// Harmless execution sentinel, no external URL or exfiltration target. Expected
// behavior is literal text everywhere, not creation of any of these elements.
const payload =
  '<img data-jb-output-probe src="data:," onerror="globalThis.__jbOutputInjection=1"><script data-jb-output-probe>globalThis.__jbOutputInjection=2</script><svg data-jb-output-probe onload="globalThis.__jbOutputInjection=3"></svg>';
const literal = JSON.stringify(payload);
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function fixture(page: Page, body: string) {
  await page.addInitScript(() => {
    (window as any).__jbOutputInjection = 0;
  });
  const source = `public class Main {\n  public static void main(String[] args) {\n    ${body}\n  }\n}\n`;
  const request = page.request;
  const capabilities = (
    await (await request.get("/api/v1/capabilities")).json()
  ).data;
  expect(
    capabilities.runner.available,
    "Actual isolated Docker runner required",
  ).toBe(true);
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Output safety " + crypto.randomUUID() },
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
  const started = await request.post(base + "/runs", {
    headers: await headers(request),
    data: {
      revisionId: original.id,
      entryPoint: "Main",
      profileId: "java21-v1",
      stdinUtf8: "",
      argv: [],
    },
  });
  expect(started.status()).toBe(202);
  const jobId = (await started.json()).data.id;
  await page.goto(`/projects/${id}/runs/${jobId}`);
  await revealPanel(page, "console", "Консоль");
  let job: any;
  await expect
    .poll(
      async () => {
        const response = await request.get(base + "/jobs/" + jobId);
        expect(response.ok()).toBe(true);
        job = (await response.json()).data;
        return job.status;
      },
      { timeout: 120000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
  const report = job.result.report;
  expect(report.revisionId).toBe(original.id);
  const panel = page.locator('[data-panel-id="console"]');
  await expect(
    panel.getByRole("region", { name: "Результат запуска" }),
  ).toBeVisible({ timeout: 30000 });
  return { request, id, base, original, source, report, panel };
}
async function literalOnly(page: Page) {
  expect(await page.evaluate(() => (window as any).__jbOutputInjection)).toBe(
    0,
  );
  await expect(
    page.locator(
      "img[data-jb-output-probe],svg[data-jb-output-probe],script[data-jb-output-probe]",
    ),
  ).toHaveCount(0);
}
async function artifact(
  request: APIRequestContext,
  base: string,
  ref: string,
  expected: string,
) {
  expect(ref).toMatch(/^[a-f0-9-]{36}$/);
  const response = await request.get(base + "/artifacts/" + ref);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain("attachment");
  const bytes = await response.body();
  expect(bytes.toString("utf8")).toBe(expected);
  expect(response.headers().etag?.replaceAll('"', "")).toBe(hash(bytes));
  return { bytes: bytes.length, sha256: hash(bytes) };
}

test("HTML-like source and real stdout/stderr stay literal and artifact downloads retain exact bytes", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(
    page,
    `String text = ${literal}; System.out.println(text); System.err.println(text);`,
  );
  const runtime = f.report.runtimeExecution;
  expect(f.report.compileExecution.outcome).toBe("exited");
  expect(runtime.outcome).toBe("exited");
  expect(runtime.exitCode).toBe(0);
  expect(runtime.truncated).toBe(false);
  const expected = payload + "\n";
  expect(runtime.stdoutUtf8).toBe(expected);
  expect(runtime.stderrUtf8).toBe(expected);
  await expect(f.panel.locator(".program-output")).toHaveText(expected);
  await expect(f.panel.locator(".console-stderr")).toHaveText(expected);
  await literalOnly(page);
  await revealPanel(page, "code", "Код");
  await expect(page.locator(".monaco-editor")).toContainText(
    "data-jb-output-probe",
  );
  await literalOnly(page);
  const stdout = await artifact(f.request, f.base, runtime.stdoutRef, expected);
  const stderr = await artifact(f.request, f.base, runtime.stderrRef, expected);
  expect((await head(f.request, f.base)).id).toBe(f.original.id);
  await info.attach("literal-source-output-artifacts", {
    body: JSON.stringify({
      source: f.source,
      reportId: f.report.id,
      stdout,
      stderr,
      sentinel: 0,
      controls:
        "No output copy/download buttons exist; actual project-scoped artifact download endpoints checked",
    }),
    contentType: "application/json",
  });
});

test("actual javac diagnostic echo of HTML-like source is displayed as escaped text", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  // Parse-valid Java, genuine unresolved call: javac echoes the actual source
  // line containing the HTML-like argument, rather than a mocked diagnostic.
  const f = await fixture(page, `missing(${literal});`);
  const compile = f.report.compileExecution;
  expect(compile.outcome).toBe("compile_error");
  expect(f.report.runtimeExecution).toBeNull();
  expect(compile.stderrUtf8).toContain("cannot find symbol");
  expect(compile.stderrUtf8).toContain("data-jb-output-probe");
  expect(compile.stderrUtf8).toContain("<img");
  await expect(f.panel.locator(".console-stderr")).toHaveText(
    compile.stderrUtf8,
  );
  await literalOnly(page);
  const downloaded = await artifact(
    f.request,
    f.base,
    compile.stderrRef,
    compile.stderrUtf8,
  );
  expect((await head(f.request, f.base)).id).toBe(f.original.id);
  await info.attach("literal-compiler-diagnostic", {
    body: JSON.stringify({
      source: f.source,
      reportId: f.report.id,
      outcome: compile.outcome,
      stderr: downloaded,
      sentinel: 0,
    }),
    contentType: "application/json",
  });
});

test("bounded large HTML-like output remains literal and console details and project menu stay usable", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(
    page,
    `String text = ${literal}; while (true) System.out.print(text);`,
  );
  const runtime = f.report.runtimeExecution;
  expect(runtime.outcome).toBe("output_limit");
  expect(runtime.exitCode).toBeNull();
  expect(runtime.truncated).toBe(true);
  expect(runtime.stderrUtf8).toBe("");
  const bytes = Buffer.byteLength(runtime.stdoutUtf8, "utf8");
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThanOrEqual(1024 * 1024);
  // Independent infinite-stream prefix contract; no baseline-derived golden.
  const expected = payload
    .repeat(Math.ceil(runtime.stdoutUtf8.length / payload.length))
    .slice(0, runtime.stdoutUtf8.length);
  expect(runtime.stdoutUtf8).toBe(expected);
  await expect(f.panel).toContainText("Вывод обрезан после достижения лимита.");
  expect(await f.panel.locator(".program-output").textContent()).toBe(expected);
  await literalOnly(page);
  await f.panel.locator(".run-input > summary").click();
  await expect(f.panel.getByLabel("Стандартный ввод отчёта")).toBeVisible();
  if ((await page.locator(".global-command-menu").getAttribute("open")) === null) await page.locator(".global-command-menu > summary").click();
  await page
    .locator(".workspace-menubar summary")
    .filter({ hasText: /^Файл$/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Скачать архив проекта", exact: true }),
  ).toBeVisible();
  await literalOnly(page);
  const downloaded = await artifact(
    f.request,
    f.base,
    runtime.stdoutRef,
    expected,
  );
  expect((await head(f.request, f.base)).id).toBe(f.original.id);
  await info.attach("bounded-literal-output", {
    body: JSON.stringify({
      source: f.source,
      reportId: f.report.id,
      outcome: runtime.outcome,
      truncated: true,
      stdout: downloaded,
      sentinel: 0,
      controls:
        "Actual details/menu interaction and artifact download; no output copy-button claim",
    }),
    contentType: "application/json",
  });
});
