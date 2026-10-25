import { readFileSync } from "node:fs";
import { publishProject } from "./flowAssertions";
import { test, expect } from "@playwright/test";
import { fixture, head } from "./fileFixtures";

for (const [layout, key] of [
  ["English", "s"],
  ["Russian", "ы"],
] as const) {
  test(`physical Ctrl+S downloads the active draft in ${layout} layout inside and outside Monaco`, async ({
    page,
  }) => {
    const { projectId, base, original } = await fixture(page.request);
    await page.goto("/projects/" + projectId);
    await expect(page.locator(".blueprint-node.entry").first()).toBeVisible();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.code === "KeyS" && event.ctrlKey)
            // Observe after dispatch: React can reattach the application capture
            // handler after this observer when the draft changes.
            setTimeout(() => {
              document.body.dataset.physicalSaveEvent = JSON.stringify({
                key: event.key,
                code: event.code,
                trusted: event.isTrusted,
                prevented: event.defaultPrevented,
              });
            }, 0);
        },
        true,
      );
    });
    async function shortcut() {
      // Chromium receives a trusted native key event: one physical key with
      // different layout text. A synthetic DOM dispatch cannot test native Save.
      const parameters = {
        key,
        code: "KeyS",
        windowsVirtualKeyCode: 83,
        nativeVirtualKeyCode: 83,
        modifiers: 2,
      };
      await page.evaluate(() => {
        delete document.body.dataset.physicalSaveEvent;
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        ...parameters,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        ...parameters,
      });
      await expect
        .poll(() =>
          page.evaluate(() =>
            JSON.parse(document.body.dataset.physicalSaveEvent ?? "null"),
          ),
        )
        .toEqual({ key, code: "KeyS", trusted: true, prevented: true });
    }
    let previous = original.id;
    for (const focus of ["editor", "search"] as const) {
      await editor.focus();
      await page.keyboard.press("Control+End");
      const marker = `\n// ${layout} physical save from ${focus}\n`;
      await page.keyboard.insertText(marker);
      if (focus === "search")
        await page.getByRole("combobox", { name: "Поиск по проекту" }).focus();
      const pendingDownload = page.waitForEvent("download");
      await shortcut();
      const downloaded = await pendingDownload;
      expect(downloaded.suggestedFilename()).toBe("Main.java");
      expect(readFileSync((await downloaded.path())!, "utf8")).toContain(marker);
      expect((await head(page.request, base)).id).toBe(previous);
      await publishProject(page);
      await expect.poll(async () => (await head(page.request, base)).id).not.toBe(previous);
      const current = await head(page.request, base);
      expect(current.files.find((file: any) => file.path === "Main.java").canonicalText).toContain(marker);
      await expect(page.locator(".file-tabs-save")).toBeDisabled();
      expect((await head(page.request, base)).id).toBe(current.id);
      await shortcut();
      expect((await head(page.request, base)).id).toBe(current.id);
      previous = current.id;
    }
    expect(
      (await (await page.request.get(base + "/revisions?limit=100")).json())
        .data,
    ).toHaveLength(3);
    await cdp.detach();
  });
}
