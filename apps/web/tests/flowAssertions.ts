import { expect, type Page } from "@playwright/test";
export async function assertRoutes(page: Page) {
  expect(await page.locator("g[data-shortcut-source]").count()).toBeGreaterThan(
    0,
  );
  await expect(page.locator("g[data-route-status=limited]")).toHaveCount(0);
  const crossings = await page
    .locator("g[data-shortcut-source]")
    .evaluateAll((groups) => {
      const boxes = Array.from(
        document.querySelectorAll(".react-flow__node"),
      ).map((node) => ({
        id: node.getAttribute("data-id"),
        r: node.getBoundingClientRect(),
      }));
      return groups.flatMap((group) => {
        const path = group.querySelector(
          "path.react-flow__edge-path",
        ) as SVGPathElement;
        const numbers = path
          .getAttribute("d")!
          .match(/-?[0-9.]+/g)!
          .map(Number);
        const matrix = path.getScreenCTM()!;
        const points = [];
        for (let index = 0; index < numbers.length; index += 2)
          points.push(
            new DOMPoint(numbers[index], numbers[index + 1]).matrixTransform(
              matrix,
            ),
          );
        const source = group.getAttribute("data-shortcut-source"),
          target = group.getAttribute("data-shortcut-target");
        return boxes
          .filter(
            (box) =>
              box.id !== source &&
              box.id !== target &&
              points.slice(1).some((point, index) => {
                const previous = points[index],
                  r = box.r;
                return point.x === previous.x
                  ? point.x > r.left + 1 &&
                      point.x < r.right - 1 &&
                      Math.max(point.y, previous.y) > r.top + 1 &&
                      Math.min(point.y, previous.y) < r.bottom - 1
                  : point.y > r.top + 1 &&
                      point.y < r.bottom - 1 &&
                      Math.max(point.x, previous.x) > r.left + 1 &&
                      Math.min(point.x, previous.x) < r.right - 1;
              }),
          )
          .map((box) => box.id);
      });
    });
  expect(crossings).toEqual([]);
}
