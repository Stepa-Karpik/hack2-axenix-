import { test, expect } from "@playwright/test";
import { headers, head } from "./fileFixtures";

test("running interactive output retains its original revision after editing and saving a new head", async ({
  page,
}) => {
  const made = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Run provenance " + crypto.randomUUID() },
  });
  expect(made.status()).toBe(201);
  const projectId = (await made.json()).data.id;
  const base = "/api/v1/projects/" + projectId;
  const source =
    'import java.util.Scanner; public class Main { public static void main(String[] args) { System.out.println("provenance-ready"); System.out.println(new Scanner(System.in).nextLine()); } }\n';
  const initial = await page.request.post(base + "/revisions", {
    headers: await headers(page.request, "empty"),
    data: {
      files: [{ path: "Main.java", content: source }],
      intent: "semantic_edit",
      expectedHeadRevisionId: "empty",
    },
  });
  expect(initial.status()).toBe(201);
  const r1 = (await initial.json()).data.id;
  await page.goto("/projects/" + projectId);
  await expect(page.locator(".blueprint-node.entry")).toBeVisible();
  await page.getByRole("button", { name: "Запуск", exact: true }).click();
  await page.getByLabel("Класс с main").fill("Main");
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith(base + "/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  const started = (await (await submitted).json()).data;
  expect(started.revisionId).toBe(r1);
  // Real Docker execution, no delayed or mocked polling. Act immediately after
  // the prompt because this runner's runtime budget is five seconds.
  await expect(page.locator(".live-console-output")).toContainText(
    "provenance-ready",
    { timeout: 60000 },
  );
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(
    "\n// saved while the prior revision is waiting for input\n",
  );
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith(base + "/revisions") && r.request().method() === "POST",
  );
  await page.keyboard.press("Control+s");
  const r2 = (await (await saved).json()).data.id;
  expect(r2).not.toBe(r1);
  await expect(page.locator(".file-tabs-save")).toBeDisabled();
  const warning = page.getByTestId("run-source-provenance");
  await expect(warning).toContainText(r1.slice(0, 8));
  await expect(warning).toContainText("запуск предыдущей версии");
  const running = (
    await (await page.request.get(base + "/runs/" + started.id)).json()
  ).data;
  expect(running.revisionId).toBe(r1);
  expect(running.status).toBe("running");
  expect(running.live.stdoutUtf8).toContain("provenance-ready");
  expect((await head(page.request, base)).id).toBe(r2);
  // Finish our own input-waiting run promptly rather than consuming its timeout.
  await page.getByLabel("Ответ программе").fill("done");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(warning).toContainText("запуск предыдущей версии");
});
