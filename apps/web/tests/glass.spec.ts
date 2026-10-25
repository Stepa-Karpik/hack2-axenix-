import { test, expect } from "@playwright/test";
import { headers } from "./fileFixtures";
import { setTheme } from "./flowAssertions";
const source = `import java.util.List;

public class OrderService {
    public double calculateTotal(List<Order> orders) {
        double total = 0;
        for (Order order : orders) {
            if (order.isPaid()) total += order.amount();
        }
        return total;
    }
}
`;
async function create(page: import("@playwright/test").Page) {
  const request = page.request;
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "OrderService" },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id;
  const saved = await request.post(`/api/v1/projects/${id}/revisions`, {
    headers: await headers(request, "empty"),
    data: {
      intent: "semantic_edit",
      files: [
        { path: "src/OrderService.java", content: source },
        {
          path: "src/Order.java",
          content: "public record Order(boolean isPaid, double amount) {}",
        },
        {
          path: "src/Main.java",
          content:
            "import java.util.List; public class Main { public static void main(String[] args) { System.out.println(new OrderService().calculateTotal(List.of(new Order(true, 2450.0)))); } }",
        },
      ],
      directories: ["test"],
    },
  });
  expect(saved.status()).toBe(201);
  await page.goto(`/projects/${id}`);
  await expect(page.locator(".blueprint-node").first()).toBeVisible({
    timeout: 30000,
  });
  await page.locator('[data-file-path="src/OrderService.java"]').click();
  await page
    .locator(".method-item")
    .filter({ hasText: "calculateTotal(" })
    .click();
  await page.waitForTimeout(900);
  return id;
}
test("glass material, uncluttered dock, real output and restored windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = await create(page);
  await expect(
    page.getByRole("button", { name: "Запуск", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator('[data-tile-panel="graph"]')).toHaveCount(0);
  expect(
    await page
      .locator(".flow-area")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(0, 0, 0)");
  const material = await page
    .locator('[data-tile-panel="code"]')
    .evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      filter: getComputedStyle(el).backdropFilter,
      shadow: getComputedStyle(el).boxShadow,
    }));
  expect(material).toEqual({
    bg: "rgba(5, 5, 5, 0.84)",
    filter: "blur(18px)",
    shadow: "none",
  });
  const dock = (await page.locator(".workspace-dock").boundingBox())!;
  expect(dock.width).toBeLessThan(1100);
  expect(dock.y + dock.height).toBeLessThanOrEqual(1024);
  for (const panel of ["code", "console", "analysis"]) {
    const r = (await page
      .locator(`[data-tile-panel="${panel}"]`)
      .boundingBox())!;
    expect(r.y + r.height).toBeLessThan(dock.y);
  }
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("Поиск файлов и методов")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Запуск", exact: true }).click();
  await page.getByLabel("Класс с main").fill("Main");
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  // Execution belongs to Main, while the canvas still shows OrderService.
  // Follow the actual launch file before asserting its console history.
  await page
    .getByRole("button", { name: "Открыть src/Main.java", exact: true })
    .click();
  await expect(page.locator('[data-panel-id="console"]')).toContainText(
    "2450",
    { timeout: 60000 },
  );
  await page.screenshot({ path: test.info().outputPath("glass-dark.png") });
  const toggle = page
    .locator(".workspace-dock")
    .getByRole("button", { name: "Консоль", exact: true });
  await toggle.click();
  await expect(page.locator('[data-panel-id="console"]')).not.toBeVisible();
  await toggle.click();
  await expect(page.locator('[data-panel-id="console"]')).toContainText("2450");
  await page
    .getByRole("button", { name: "Развернуть Код Java", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Восстановить панель", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Восстановить панель", exact: true })
    .click();
  await expect(page.locator('[data-panel-id="console"]')).toContainText("2450");
  await setTheme(page, "light");
  await page.screenshot({ path: test.info().outputPath("glass-light.png") });
  await setTheme(page, "dark");
  await page
    .getByRole("button", { name: "Скрыть Проект", exact: true })
    .click();
  await page.getByLabel("Окна", { exact: true }).click();
  await page
    .locator(".dock-windows-menu")
    .getByRole("button", { name: "Проект", exact: true })
    .click();
  await expect(page.locator('[data-tile-panel="project"]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("glass-final.png") });
  await test.info().attach("project", {
    body: JSON.stringify({ id, url: page.url() }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});
