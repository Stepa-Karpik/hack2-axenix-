import { test, expect, type Page } from "@playwright/test";
import { headers } from "./fileFixtures";

// Own fixture project only. Long jumps (break, exception exits, loop exits) must route
// around cards, and a card dropped onto another is moved to the nearest free spot.
const source = `public class Main {
  public static void main(String[] args) {
    int total = 0;
    for (int i = 0; i < 10; i++) {
      if (i % 2 == 0) { total += i; } else if (i % 3 == 0) { total -= 1; } else { System.out.println("odd " + i); }
      switch (i) { case 1: total++; break; case 2: total--; break; default: total += 2; }
    }
    try { if (total > 5) throw new IllegalStateException("big"); System.out.println(total); }
    catch (IllegalStateException e) { System.out.println("caught " + e.getMessage()); }
    finally { System.out.println("done"); }
    while (total > 0) { total -= 3; if (total == 4) break; }
    System.out.println(total);
  }
}
`;
async function open(page: Page) {
  await page.goto("/");
  const created = await page.request.post("/api/v1/projects", {
    headers: await headers(page.request),
    data: { name: "Card readability " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id;
  const saved = await page.request.post(`/api/v1/projects/${id}/revisions`, {
    headers: await headers(page.request, "empty"),
    data: { intent: "semantic_edit", files: [{ path: "Main.java", content: source }] },
  });
  expect(saved.status()).toBe(201);
  await page.goto("/projects/" + id);
  await expect(page.locator(".blueprint-node.entry").first()).toBeVisible({ timeout: 30000 });
  const finish = page.getByRole("button", { name: "Завершить" });
  if (await finish.isVisible().catch(() => false)) await finish.click();
  await expect(page.locator(".flow-area")).toHaveAttribute("data-routing-state", "ready");
}
/** Cards in flow coordinates (independent of camera). */
const cards = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")]
      .filter((e) => e.querySelector(".blueprint-node"))
      .map((e) => {
        const m = new DOMMatrix(getComputedStyle(e).transform);
        const el = e as HTMLElement;
        return { id: e.getAttribute("data-id")!, x: m.e, y: m.f, w: el.offsetWidth, h: el.offsetHeight };
      }),
  );

test("no edge is drawn through a card it does not connect", async ({ page }) => {
  await open(page);
  const crossings = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".react-flow__node")]
      .filter((e) => e.querySelector(".blueprint-node"))
      .map((e) => {
        const m = new DOMMatrix(getComputedStyle(e).transform);
        const el = e as HTMLElement;
        return { id: e.getAttribute("data-id")!, l: m.e, t: m.f, r: m.e + el.offsetWidth, b: m.f + el.offsetHeight };
      });
    const hits: string[] = [];
    for (const g of document.querySelectorAll("g[data-route-source]")) {
      const path = g.querySelector("path") as SVGPathElement | null;
      if (!path) continue;
      const ends = [g.getAttribute("data-route-source"), g.getAttribute("data-route-target")];
      const total = path.getTotalLength();
      for (let l = 0; l <= total; l += 4) {
        const p = path.getPointAtLength(l);
        for (const box of boxes)
          if (!ends.includes(box.id) && p.x > box.l + 2 && p.x < box.r - 2 && p.y > box.t + 2 && p.y < box.b - 2)
            hits.push(`${ends.join("->")} through ${box.id}`);
      }
    }
    return { edges: document.querySelectorAll("g[data-route-source]").length, hits: [...new Set(hits)] };
  });
  expect(crossings.edges).toBeGreaterThan(50);
  expect(crossings.hits).toEqual([]);
});

test("a card dropped onto another card is moved to a free spot", async ({ page }) => {
  await open(page);
  const entry = page.locator(".blueprint-node.entry").first();
  const eb = (await entry.boundingBox())!;
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(eb.x + eb.width / 2, eb.y + 150);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  const visible = page.locator(".react-flow__node .blueprint-node:not(.entry)");
  const inView: { index: number; box: { x: number; y: number; width: number; height: number } }[] = [];
  for (let i = 0; i < (await visible.count()); i++) {
    const box = await visible.nth(i).boundingBox();
    if (box && box.y > 120 && box.y + box.height < 640 && box.x > 300 && box.x + box.width < 1240) inView.push({ index: i, box });
  }
  expect(inView.length).toBeGreaterThanOrEqual(2);
  const [from, onto] = [inView[0], inView.find((c) => Math.abs(c.box.y - inView[0].box.y) > 40)!];
  await page.mouse.move(from.box.x + from.box.width / 2, from.box.y + from.box.height / 2);
  await page.mouse.down();
  await page.mouse.move(onto.box.x + onto.box.width / 2 + 8, onto.box.y + onto.box.height / 2 + 4, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await cards(page);
  const overlaps = after.flatMap((a, i) =>
    after.slice(i + 1).filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).map((b) => a.id + "|" + b.id),
  );
  expect(overlaps).toEqual([]);
});
