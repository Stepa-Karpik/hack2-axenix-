import { test, expect, type Page } from "@playwright/test";
const projectId = "88888888-8888-4888-8888-888888888888";
async function fixture(page: Page) {
  const accountId = "workspace-continuity-account";
  await page.addInitScript((id) => {
    for (const scope of ["home", "workspace", "settings", "profile"])
      localStorage.setItem(
        "java-blueprints:onboarding:v1:" + id + ":" + scope,
        "done",
      );
  }, accountId);
  await page.addInitScript((id) => {
    localStorage.setItem(
      "java-blueprints:window-state:" + id,
      JSON.stringify({
        navigationDocked: false,
        collapsedNavigation: false,
        focused: "code",
        maximized: null,
      }),
    );
  }, projectId);
  const mutations: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET")
      mutations.push(request.method() + " " + path);
    let data: unknown;
    if (path === "/session")
      data = {
        user: {
          id: accountId,
          username: "continuity_fixture",
          displayName: "Workspace continuity",
          emailVerified: true,
          authMethod: "password",
        },
        mode: "local",
        csrfToken: "workspace-continuity",
        capabilities: {
          registration: true,
          emailDelivery: false,
          legacyGuestWorkspace: false,
        },
      };
    else if (path === "/capabilities") data = { runner: { available: false } };
    else if (path === `/projects/${projectId}`)
      data = {
        id: projectId,
        name: "Workspace continuity fixture",
        headRevisionId: null,
        originalRevisionId: null,
        updatedAt: "2026-10-25T00:00:00Z",
        role: "owner",
        ownerId: accountId,
        visibility: "private",
        canEdit: true,
      };
    else if (path === `/projects/${projectId}/revisions`) data = [];
    else {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Unexpected fixture request: " + path,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/projects/" + projectId);
  await expect(page.locator('[data-tile-panel="project"]')).toBeVisible();
  await expect(page.locator('[data-tile-panel="code"]')).toBeVisible();
  return mutations;
}

test("collapsed navigation uses current rectangles for drag ghost and exact drop target", async ({
  page,
}) => {
  const mutations = await fixture(page);
  const navigation = page.locator('[data-tile-panel="navigation"]'),
    project = page.locator('[data-tile-panel="project"]'),
    code = page.locator('[data-tile-panel="code"]');
  const originalGroup = await project.getAttribute("data-group-id"),
    navigationGroup = await navigation.getAttribute("data-group-id");
  await page
    .getByRole("button", { name: "Свернуть навигацию", exact: true })
    .click();
  await expect(navigation).toHaveCSS("height", "40px");
  await project.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const before = (await project.boundingBox())!,
    grip = (await project.locator(".tile-grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 + 18,
    grip.y + grip.height / 2 + 18,
    { steps: 4 },
  );
  await expect(page.locator('[data-workspace-dragging="true"]')).toHaveCount(1);
  await expect
    .poll(async () =>
      Math.abs((await project.boundingBox())!.height - before.height),
    )
    .toBeLessThan(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator('[data-workspace-dragging="true"]')).toHaveCount(0);
  await expect(project).toHaveAttribute("data-group-id", originalGroup!);
  const source = (await code.locator(".tile-grip").boundingBox())!,
    target = (await project.boundingBox())!;
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 60, {
    steps: 12,
  });
  await expect(page.locator('[data-workspace-dragging="true"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(code).toHaveAttribute("data-group-id", originalGroup!);
  await expect(navigation).toHaveAttribute("data-group-id", navigationGroup!);
  await expect(navigation).toHaveCSS("height", "40px");
  expect(mutations).toEqual([]);
});

test("pointer selection in portaled custom popup keeps panel move menu open and usable", async ({
  page,
}) => {
  const mutations = await fixture(page);
  const code = page.locator('[data-tile-panel="code"]'),
    menu = code.locator(".workspace-move-menu");
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");
  const target = menu.getByRole("combobox", { name: "Панель назначения" });
  await target.click();
  await page
    .getByRole("listbox", { name: "Панель назначения" })
    .getByRole("option", { name: "Консоль", exact: true })
    .click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(target).toBeFocused();
  await expect(target).toContainText("Консоль");
  await menu.getByRole("combobox", { name: "Способ перемещения" }).click();
  await page
    .getByRole("listbox", { name: "Способ перемещения" })
    .getByRole("option", { name: "Объединить вкладки", exact: true })
    .click();
  await expect(menu).toHaveAttribute("open", "");
  await menu.getByRole("button", { name: "Переместить", exact: true }).click();
  const output = page.locator('[data-tile-panel="code"]');
  await expect(
    output.getByRole("tab", { name: "Код Java", exact: true }),
  ).toBeVisible();
  await expect(
    output.getByRole("tab", { name: "Консоль", exact: true }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});
