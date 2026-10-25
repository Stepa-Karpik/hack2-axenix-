import { createHash } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

const raw =
  "\uFEFFpublic class Main { public static void main(String[] args) { System.out.println(2 + 3); } }\r\n";
const canonical = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
const changed = canonical.replace("2 + 3", "5");
async function finished(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect
    .poll(
      async () => {
        const response = await request.get(base + "/jobs/" + id);
        expect(response.ok()).toBe(true);
        job = (await response.json()).data;
        return job.status;
      },
      { timeout: 180000 },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status, JSON.stringify(job)).toBe("succeeded");
  return job;
}
async function fixture(request: APIRequestContext) {
  const made = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Archive acceptance " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = (await made.json()).data.id,
    base = "/api/v1/projects/" + id;
  const save = async (content: string, previous: string, imported = false) => {
    const response = await request.post(base + "/revisions", {
      headers: await headers(request, previous),
      data: {
        files: [
          { path: "Main.java", content },
          { path: "notes.txt", content: "preserve companion\n" },
        ],
        directories: ["empty", "deep/folder"],
        ...(imported ? { importedPaths: ["Main.java"] } : {}),
        intent: "semantic_edit",
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const original = await save(raw, "empty", true),
    candidate = await save(changed, original.id);
  return { id, base, original, candidate };
}
async function comparison(
  request: APIRequestContext,
  base: string,
  left: string,
  right: string,
) {
  const created = await request.post(base + "/test-suites", {
    headers: await headers(request),
    data: {
      mode: "console",
      entryPoint: "Main",
      comparisonPolicyId: "exact-v1",
      cases: [
        {
          id: "five",
          name: "Independent arithmetic oracle",
          argv: [],
          stdinUtf8: "",
          expectedStdout: "5\n",
          expectedStderr: "",
          expectedExitCode: 0,
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const suite = (await created.json()).data;
  const started = await request.post(base + "/comparisons", {
    headers: await headers(request),
    data: {
      baseRevisionId: left,
      candidateRevisionId: right,
      suiteVersionId: suite.id,
      profileId: "java21-v1",
    },
  });
  expect(started.status()).toBe(202);
  const job = await finished(request, base, (await started.json()).data.id);
  const report =
    job.result.report ??
    (
      await (
        await request.get(base + "/comparisons/" + job.result.comparisonId)
      ).json()
    ).data;
  expect(report.outcome, JSON.stringify(report)).toBe("matched_on_tests");
  expect(report.coverageComplete).toBe(true);
  expect(report.observedRepeatCounts).toEqual({ base: 3, candidate: 3 });
  for (const execution of [
    ...report.testResults[0].baseExecutions,
    ...report.testResults[0].candidateExecutions,
  ]) {
    expect(execution.stdoutUtf8).toBe("5\n");
    expect(execution.stderrUtf8).toBe("");
    expect(execution.exitCode).toBe(0);
  }
  return report;
}

test("project archive UI preserves raw/canonical history and inert graph/layout/reports, then replays with fresh IDs", async ({
  page,
}, info) => {
  test.setTimeout(480000);
  const request = page.request,
    capabilities = (await (await request.get("/api/v1/capabilities")).json())
      .data;
  expect(
    capabilities.runner.available,
    "Isolated Docker required for fresh archive replay",
  ).toBe(true);
  const f = await fixture(request),
    historical = await comparison(
      request,
      f.base,
      f.original.id,
      f.candidate.id,
    );
  const started = await request.post(
    f.base + "/revisions/" + f.original.id + "/analysis",
    { headers: await headers(request), data: {} },
  );
  expect(started.status()).toBe(202);
  await finished(request, f.base, (await started.json()).data.id);
  const analysis = (
    await (
      await request.get(f.base + "/revisions/" + f.original.id + "/analysis")
    ).json()
  ).data;
  const method = analysis.graph.methods.find((m: any) =>
    m.signature.startsWith("main("),
  );
  expect(method).toBeTruthy();
  const positions = [{ nodeId: method.entryNodeId, x: 123, y: 67 }];
  const layout = await request.put(
    f.base + "/revisions/" + f.original.id + "/layout",
    {
      headers: await headers(request),
      data: {
        analysisId: analysis.id,
        sourceMapVersion: analysis.sourceMapVersion,
        methodId: method.id,
        layoutVersion: 0,
        positions,
        collapsedNodeIds: [],
        viewport: { x: 12, y: 3, zoom: 1 },
      },
    },
  );
  expect(layout.ok()).toBe(true);
  await page.goto("/projects/" + f.id);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  await page.locator(".sidebar-command-menu > summary").click();
  await page
    .locator(".workspace-menubar summary")
    .filter({ hasText: /^Вид$/ })
    .click();
  await page
    .getByRole("button", { name: "Проверка изменений", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          JSON.parse(
            localStorage.getItem("java-blueprints:workspace:v2:" + id)!,
          ).root.ratio,
        f.id,
      ),
    )
    .toBe(0.65);
  const workspaceBefore = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("java-blueprints:workspace:v2:" + id)!),
    f.id,
  );
  expect(workspaceBefore.root.type).toBe("split");
  await info.attach("workspace-before-archive", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page
    .locator(".workspace-menubar summary")
    .filter({ hasText: /^Файл$/ })
    .click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать архив проекта", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("project.jbp.json");
  const stream = await download.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks),
    archive = JSON.parse(bytes.toString("utf8"));
  expect(archive.format).toBe("java-blueprints-project-archive-v1");
  expect(archive.payload.workspace.layout).toEqual(workspaceBefore);
  expect(archive.payload.revisions).toHaveLength(2);
  const archivedOriginal = archive.payload.revisions.find(
      (r: any) => r.id === f.original.id,
    ),
    archivedFile = archivedOriginal.files.find(
      (file: any) => file.path === "Main.java",
    );
  expect(archivedFile.canonicalText).toBe(canonical);
  expect(Buffer.from(archivedFile.rawBase64, "base64").toString("utf8")).toBe(
    raw,
  );
  expect(
    archive.payload.layouts.some(
      (l: any) =>
        l.analysisId === analysis.id &&
        JSON.stringify(l.data.positions) === JSON.stringify(positions),
    ),
  ).toBe(true);
  expect(
    archive.payload.resources.some(
      (r: any) => r.id === historical.id && r.kind === "comparison",
    ),
  ).toBe(true);
  // Upload the actual UI download; nothing is extracted or run on the host.
  await page.getByLabel("Файл архива проекта").setInputFiles({
    name: "project.jbp.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  const dialog = page.getByRole("dialog", {
    name: "Открыть архив",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("проверить повторным запуском");
  await dialog
    .getByLabel("Название проекта", { exact: true })
    .fill("Archive replay " + crypto.randomUUID());
  const importedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/archive-imports"),
  );
  await dialog
    .getByRole("button", { name: "Открыть в новом проекте", exact: true })
    .click();
  const response = await importedResponse;
  expect(response.status()).toBe(201);
  const receipt = (await response.json()).data;
  expect(receipt.historicalEvidence).toBe("inert");
  expect(receipt.verificationStatus).toBe("unverified");
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+$/);
  const newId = page.url().split("/projects/")[1];
  expect(newId).not.toBe(f.id);
  const base = "/api/v1/projects/" + newId;
  expect(receipt.headRevisionId).toBe(receipt.revisionIdMap[f.candidate.id]);
  expect(receipt.revisionIdMap[f.original.id]).not.toBe(f.original.id);
  const newHead = await head(request, base);
  expect(newHead.id).toBe(receipt.headRevisionId);
  expect(newHead.verificationStatus).toBe("unverified");
  expect(newHead.directories).toEqual(f.candidate.directories);
  expect(
    await page.evaluate(
      (id) =>
        JSON.parse(localStorage.getItem("java-blueprints:workspace:v2:" + id)!),
      newId,
    ),
  ).toEqual(workspaceBefore);
  await page.reload();
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  expect(
    await page.evaluate(
      (id) =>
        JSON.parse(localStorage.getItem("java-blueprints:workspace:v2:" + id)!),
      newId,
    ),
  ).toEqual(workspaceBefore);
  await info.attach("workspace-after-archive-reload", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  expect(
    (await request.get(base + "/comparisons/" + historical.id)).status(),
  ).toBe(404);
  const stored = (
    await (
      await request.get(base + "/archive-imports/" + receipt.receiptId)
    ).json()
  ).data;
  expect(stored.archive).toEqual(archive);
  const fresh = await comparison(
    request,
    base,
    receipt.revisionIdMap[f.original.id],
    receipt.revisionIdMap[f.candidate.id],
  );
  expect(fresh.id).not.toBe(historical.id);
  expect((await head(request, f.base)).id).toBe(f.candidate.id);
  await info.attach("archive-fresh-replay", {
    body: JSON.stringify({
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      receipt,
      historicalReportId: historical.id,
      freshReport: fresh,
      scope:
        "Historical graph/node layouts remain inert; validated current browser panel tiling restored only to the new project",
    }),
    contentType: "application/json",
  });
});

test("archive UI validates a tampered checksum before creating a target project", async ({
  page,
}) => {
  test.setTimeout(90000);
  const f = await fixture(page.request);
  const exported = await page.request.post(f.base + "/archives", {
    headers: await headers(page.request),
    data: {},
  });
  expect(exported.status()).toBe(201);
  const metadata = (await exported.json()).data,
    archive = await (await page.request.get(metadata.downloadUrl)).json();
  archive.manifest.payloadSha256 = "0".repeat(64);
  await page.goto("/projects/" + f.id);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible({
    timeout: 30000,
  });
  await page.locator(".sidebar-command-menu > summary").click();
  await page
    .locator(".workspace-menubar summary")
    .filter({ hasText: /^Файл$/ })
    .click();
  await page.getByLabel("Файл архива проекта").setInputFiles({
    name: "tampered.jbp.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  let created = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/projects"
    )
      created++;
  });
  const dialog = page.getByRole("dialog", {
    name: "Открыть архив",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Открыть в новом проекте", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(created).toBe(0);
  expect((await head(page.request, f.base)).id).toBe(f.candidate.id);
});
