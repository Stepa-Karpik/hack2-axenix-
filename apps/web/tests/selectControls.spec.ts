import { test, expect, type Page } from "@playwright/test";
const projectId = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "select_owner",
  displayName: "Select owner",
  bio: "",
};
const people = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    username: "alpha",
    displayName: "Alpha",
    bio: "",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    username: "beta",
    displayName: "Beta",
    bio: "",
  },
];
async function fixture(page: Page) {
  const writes: { path: string; body: unknown }[] = [];
  let project = {
    id: projectId,
    name: "Select control fixture",
    headRevisionId: null,
    originalRevisionId: null,
    updatedAt: "2026-10-25T00:00:00Z",
    ownerId: actor.id,
    visibility: "private",
    role: "owner",
    canEdit: true,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown;
    if (path === "/session")
      data = {
        user: actor,
        mode: "account",
        csrfToken: "select-fixture",
        capabilities: {
          registration: true,
          emailDelivery: false,
          legacyGuestWorkspace: true,
        },
      };
    else if (path === "/capabilities") data = { runner: { available: false } };
    else if (path === "/friends") data = people;
    else if (path === `/projects/${projectId}`) data = project;
    else if (path === `/projects/${projectId}/revisions`) data = [];
    else if (path === `/projects/${projectId}/members`) {
      if (request.method() === "POST")
        writes.push({ path, body: request.postDataJSON() });
      data = [];
    } else if (
      path === `/projects/${projectId}/access` &&
      request.method() === "PATCH"
    ) {
      const body = request.postDataJSON();
      writes.push({ path, body });
      project = { ...project, ...body };
      data = project;
    } else {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: "NOT_FOUND",
            message: "Unexpected fixture request: " + path,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/projects/" + projectId);
  const intro = page.getByRole("dialog", {
    name: "Знакомство с JavaBlueprints",
  });
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "Закрыть обучение", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Поделиться", exact: true }),
  ).toBeEnabled();
  return writes;
}
test("custom select uses keyboard selection and emits the real invitation values", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.getByRole("button", { name: "Поделиться", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Доступ к проекту" });
  const friend = dialog.getByRole("combobox", { name: "Друг для приглашения" });
  await friend.focus();
  await page.keyboard.press("ArrowDown");
  const list = page.getByRole("listbox", { name: "Друг для приглашения" });
  await expect(list).toBeFocused();
  await expect(
    dialog.getByRole("listbox", { name: "Друг для приглашения" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(friend).toContainText("@beta");
  await expect(friend).toBeFocused();
  const role = dialog.getByRole("combobox", { name: "Роль участника" });
  await role.focus();
  await page.keyboard.press("Space");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "р",
    code: "KeyH",
    windowsVirtualKeyCode: 72,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "р",
    code: "KeyH",
    windowsVirtualKeyCode: 72,
  });
  await page.keyboard.press("Enter");
  await expect(role).toContainText("Редактирование");
  await dialog.getByRole("button", { name: "Пригласить", exact: true }).click();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        path: `/projects/${projectId}/members`,
        body: { username: "beta", role: "editor" },
      },
    ]);
  await expect(dialog).toBeVisible();
});
test("popup Escape restores trigger, Tab reaches next control, and modal Escape restores opener", async ({
  page,
}) => {
  await fixture(page);
  const opener = page.getByRole("button", { name: "Поделиться", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Доступ к проекту" }),
    friend = dialog.getByRole("combobox", { name: "Друг для приглашения" }),
    role = dialog.getByRole("combobox", { name: "Роль участника" });
  await friend.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(friend).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(role).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
test("mobile panel popup stays in viewport and closes on an outside pointer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const trigger = page.getByRole("combobox", { name: "Открытая панель" });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const list = page.getByRole("listbox", { name: "Открытая панель" });
  await expect(list).toBeVisible();
  const box = await list.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(list).toBeVisible();
  await page
    .getByRole("button", { name: "Открыть настройки аккаунта" })
    .click();
  await expect(list).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/profile$/);
});
