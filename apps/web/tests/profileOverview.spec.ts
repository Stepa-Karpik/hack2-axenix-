import { test, expect, type Page } from "@playwright/test";
const owner = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "profile_owner",
  displayName: "Profile owner",
  bio: "A real fixture profile",
};
const friend = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "actual_friend",
  displayName: "Actual friend",
  bio: "Mutual friendship fixture",
};
const ownProject = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Owned private project",
  ownerId: owner.id,
  visibility: "private",
  role: "owner",
  canEdit: true,
  headRevisionId: null,
  originalRevisionId: null,
  updatedAt: "2026-10-25T00:00:00Z",
};
const sharedProject = {
  ...ownProject,
  id: "44444444-4444-4444-8444-444444444444",
  name: "Authorized shared private project",
  ownerId: friend.id,
  role: "editor",
};
const publicProject = {
  ...ownProject,
  id: "55555555-5555-4555-8555-555555555555",
  name: "Visible public project",
  visibility: "public",
  role: "viewer",
  canEdit: false,
};
const days = Array.from({ length: 365 }, (_, i) => ({
  date: new Date(Date.UTC(2025, 9, 26 + i)).toISOString().slice(0, 10),
  count: i === 364 ? 2 : 0,
}));
async function fixture(
  page: Page,
  viewer: typeof owner | null,
  routeUsername = owner.username,
) {
  const pinWrites: string[][] = [];
  let pinned: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", "");
    let data: unknown;
    if (path === "/session")
      data = {
        user: viewer,
        mode: "account",
        csrfToken: "profile-fixture",
        capabilities: {
          registration: true,
          emailDelivery: false,
          legacyGuestWorkspace: true,
        },
      };
    else if (path === "/friends") data = [friend];
    else if (path === "/friend-requests") data = { incoming: [], outgoing: [] };
    else if (path === "/profile/pins" && request.method() === "PUT") {
      pinned = request.postDataJSON().projectIds;
      pinWrites.push([...pinned]);
      data = { items: pinned.includes(ownProject.id) ? [ownProject] : [] };
    } else if (path.toLowerCase() === `/users/${owner.username}/overview`)
      data = {
        user: owner,
        projects: {
          items:
            viewer?.id === owner.id
              ? [ownProject, sharedProject]
              : [publicProject],
          nextCursor: null,
          totalVisible: viewer?.id === owner.id ? 2 : 1,
        },
        pinnedProjects:
          viewer?.id === owner.id && pinned.includes(ownProject.id)
            ? [ownProject]
            : [],
        friends: { count: 1, mutualCount: 0 },
        contributions: {
          from: "2025-10-26",
          to: "2026-10-25",
          timezone: "UTC",
          days:
            viewer?.id === owner.id
              ? days
              : days.map((d) => ({ ...d, count: 0 })),
          total: viewer?.id === owner.id ? 2 : 0,
          attribution: "head_change_actor",
        },
        activity:
          viewer?.id === owner.id
            ? [
                {
                  revisionId: "66666666-6666-4666-8666-666666666666",
                  projectId: sharedProject.id,
                  projectName: sharedProject.name,
                  createdAt: "2026-10-25T00:00:00Z",
                  origin: "text_edit",
                },
              ]
            : [],
        tracking: { legacyUnattributed: true },
      };
    else if (path.toLowerCase() === `/users/${owner.username}/friends`)
      data = { items: [friend], count: 1, mutualCount: 0, nextOffset: null };
    else if (path.toLowerCase() === `/users/${friend.username}/overview`)
      data = {
        user: friend,
        projects: { items: [], nextCursor: null, totalVisible: 0 },
        pinnedProjects: [],
        friends: { count: 1, mutualCount: 1 },
        contributions: {
          days: days.map((d) => ({ ...d, count: 0 })),
          total: 0,
        },
        activity: [],
        tracking: { legacyUnattributed: true },
      };
    else {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Unexpected fixture path: " + path,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/u/" + routeUsername);
  if (viewer) {
    const intro = page.getByRole("dialog", {
      name: "Знакомство с JavaBlueprints",
    });
    await expect(intro).toBeVisible();
    await intro
      .getByRole("button", { name: "Закрыть обучение", exact: true })
      .click();
  }
  await expect(
    page.getByRole("heading", {
      name: owner.displayName,
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  return pinWrites;
}

test("own profile renders authorized private projects, 365 actual bins, and server-backed pin/unpin", async ({
  page,
}) => {
  const writes = await fixture(page, owner);
  const projects = page
    .getByRole("heading", { name: "Проекты 2", exact: true })
    .locator("..");
  await expect(projects.getByRole("article")).toHaveCount(2);
  const owned = projects.getByRole("article").filter({
      has: page.getByRole("heading", { name: ownProject.name, exact: true }),
    }),
    shared = projects.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: sharedProject.name,
        exact: true,
      }),
    });
  await expect(owned.getByText("Приватный", { exact: true })).toBeVisible();
  await expect(
    shared.getByText("Приватный · Общий доступ", { exact: true }),
  ).toBeVisible();
  await expect(
    shared.getByRole("button", { name: "Закрепить", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".contribution-day")).toHaveCount(365);
  await expect(page.locator('.contribution-day[data-level="2"]')).toHaveCount(
    1,
  );
  await expect(
    page.locator('.contribution-day[data-level="2"]'),
  ).toHaveAttribute("title", "2026-10-25: 2 изменений");
  await expect(
    page.getByRole("heading", {
      name: "2 изменений за последний год",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".activity-row")).toHaveCount(1);
  await expect(page.locator(".activity-row").getByRole("link")).toHaveAttribute(
    "href",
    "/projects/" + sharedProject.id,
  );
  await owned.getByRole("button", { name: "Закрепить", exact: true }).click();
  await expect.poll(() => writes).toEqual([[ownProject.id]]);
  const pins = page
    .getByRole("heading", { name: "Закреплённые проекты", exact: true })
    .locator("..");
  await expect(pins.getByRole("article")).toHaveCount(1);
  await expect(
    pins.getByRole("heading", { name: ownProject.name, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Закреплённые проекты", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Проекты 2", exact: true })
    .locator("..")
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: ownProject.name, exact: true }),
    })
    .getByRole("button", { name: "Открепить", exact: true })
    .click();
  await expect.poll(() => writes).toEqual([[ownProject.id], []]);
  await expect(
    page.getByRole("heading", { name: "Закреплённые проекты", exact: true }),
  ).toHaveCount(0);
  await expect(projects.getByRole("article")).toHaveCount(2);
});

test("outsider renders only viewer-filtered API project count and zero activity without fabricated contributions", async ({
  page,
}) => {
  await fixture(page, null);
  await expect(
    page.getByRole("heading", { name: "Проекты 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: publicProject.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(ownProject.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText(sharedProject.name, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Закреплённые проекты", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Закрепить|Открепить/ }),
  ).toHaveCount(0);
  await expect(page.locator(".contribution-day")).toHaveCount(365);
  await expect(
    page.locator('.contribution-day:not([data-level="0"])'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "0 изменений за последний год",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".activity-row")).toHaveCount(0);
  await expect(
    page.getByText("Пока нет изменений с подтверждённым автором.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/подписчик|followers|following/i)).toHaveCount(0);
});

test("real friendship list navigates to the actual friend profile while shared sidebar remains", async ({
  page,
}) => {
  await fixture(page, owner);
  await page
    .locator(".profile-counts")
    .getByRole("link", { name: "1 друзей", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/u/${owner.username}/friends$`));
  await expect(
    page.getByRole("heading", { name: "Друзья @" + owner.username, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Разделы приложения" }),
  ).toBeVisible();
  await expect(page.locator(".person-row")).toHaveCount(1);
  await page
    .locator(".person-row")
    .getByRole("link", { name: new RegExp(friend.displayName) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/u/${friend.username}$`));
  await expect(
    page.getByRole("heading", {
      name: friend.displayName,
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Разделы приложения" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".profile-counts")
      .getByRole("link", { name: "1 друзей", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".profile-counts").getByText("1 общих", { exact: true }),
  ).toBeVisible();
});

test("mixed-case own profile URL uses returned account ID for edit and pin controls", async ({
  page,
}) => {
  const uppercase = owner.username.toUpperCase();
  const writes = await fixture(page, owner, uppercase);
  await expect(page).toHaveURL(new RegExp(`/u/${uppercase}$`));
  await expect(
    page.getByRole("link", { name: "Редактировать профиль", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить в друзья", exact: true }),
  ).toHaveCount(0);
  const projects = page
    .getByRole("heading", { name: "Проекты 2", exact: true })
    .locator("..");
  await projects
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: ownProject.name, exact: true }),
    })
    .getByRole("button", { name: "Закрепить", exact: true })
    .click();
  await expect.poll(() => writes).toEqual([[ownProject.id]]);
  await expect(
    page.getByRole("heading", { name: "Закреплённые проекты", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Редактировать профиль", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить в друзья", exact: true }),
  ).toHaveCount(0);
});
