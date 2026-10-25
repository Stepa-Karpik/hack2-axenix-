import { test, expect, type Page } from "@playwright/test";

// Synthetic image and fully intercepted account traffic. No real account, mail,
// provider, project or stored workspace is read or changed.
const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAHElEQVR4nGPw2HIHjjSiZsMRAxUlkDnIiqgoAQDYhF6hVDG9fAAAAABJRU5ErkJggg==", "base64");
const user = { id: "c1111111-1111-4111-8111-111111111111", username: "photo_fixture", displayName: "Photo fixture", bio: "Synthetic profile", email: "photo@example.invalid", emailVerified: true, authMethod: "password" };
const imageUrl = (version: number) => `/api/v1/users/${user.username}/avatar?v=fixture${version}`;
async function fixture(page: Page, options: { avatar?: boolean; signedIn?: boolean; broken?: boolean; theme?: string } = {}) {
  const state = { avatarUrl: options.avatar ? imageUrl(1) : null as string | null, posts: 0, deletes: 0, sessions: 0, reject: false, gate: undefined as Promise<void> | undefined, unexpected: [] as string[] };
  await page.addInitScript(({ id, theme }) => {
    for (const scope of ["settings", "profile", "home", "workspace"]) localStorage.setItem(`java-blueprints:onboarding:v1:${id}:${scope}`, "done");
    localStorage.setItem("java-blueprints:theme", theme);
  }, { id: user.id, theme: options.theme ?? "dark" });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const currentUser = () => ({ ...user, avatarUrl: state.avatarUrl });
    let data: unknown;
    if (path.endsWith("/avatar") && method === "GET") return route.fulfill({ status: options.broken ? 404 : 200, contentType: "image/png", body: options.broken ? Buffer.from("") : photo });
    if (path === "/api/v1/session") {
      state.sessions++;
      data = { mode: options.signedIn === false ? "anonymous" : "authenticated", csrfToken: "fixture-csrf", user: options.signedIn === false ? null : currentUser(), capabilities: { registration: true, emailDelivery: false, legacyGuestWorkspace: false, projectCreation: true, projectExport: true } };
    } else if (path === "/api/v1/profile/avatar" && method === "POST") {
      state.posts++;
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      expect(request.headers()["content-type"]).toContain("multipart/form-data; boundary=");
      const body = request.postDataBuffer()!;
      expect(body.toString("latin1")).toContain('name="file"; filename="photo.png"');
      expect(body.includes(photo)).toBe(true);
      await state.gate;
      if (state.reject) return route.fulfill({ status: 400, json: { error: { code: "INVALID_AVATAR", message: "Invalid fixture image" } } });
      state.avatarUrl = imageUrl(state.posts + 1); data = currentUser();
    } else if (path === "/api/v1/profile/avatar" && method === "DELETE") {
      state.deletes++; expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      state.avatarUrl = null; data = currentUser();
    } else if (path.endsWith("/overview")) data = { user: currentUser(), projects: { items: [], nextCursor: null, totalVisible: 0 }, pinnedProjects: [], friends: { count: 0, mutualCount: 0 }, contributions: { days: [], total: 0 }, activity: [] };
    else if (path === "/api/v1/profile" || path === `/api/v1/users/${user.username}`) data = currentUser();
    else if (path === "/api/v1/friends") data = [currentUser()];
    else if (path === "/api/v1/friend-requests") data = { incoming: [], outgoing: [] };
    else if (path === "/api/v1/github/status") data = { configured: false, linked: null, repositoryAccess: false };
    else if (method === "GET") data = [];
    else { state.unexpected.push(`${method} ${path}`); return route.fulfill({ status: 409, json: { error: { code: "FIXTURE_UNEXPECTED_WRITE", message: "Unexpected fixture write" } } }); }
    return route.fulfill({ json: { data, meta: { requestId: "fixture" } } });
  });
  return state;
}
const file = { name: "photo.png", mimeType: "image/png", buffer: photo };
async function loaded(page: Page, selector: string, url: string) {
  const image = page.locator(selector);
  await expect(image).toHaveAttribute("src", url);
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
}

test("photo upload, replacement and removal refresh settings, navigation, profile and friends", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/settings/profile");
  await expect(page.locator(".settings-avatar")).toHaveText("P");
  await page.getByLabel("Выбрать фото профиля").setInputFiles(file);
  await loaded(page, ".settings-avatar img", imageUrl(2));
  await loaded(page, ".account-nav img", imageUrl(2));
  expect(state.posts).toBe(1); expect(state.sessions).toBeGreaterThan(1);
  await page.getByLabel("Выбрать фото профиля").setInputFiles(file);
  await loaded(page, ".settings-avatar img", imageUrl(3));
  await page.goto(`/u/${user.username}`);
  await loaded(page, ".profile-avatar img", imageUrl(3));
  await page.goto("/settings/friends");
  await loaded(page, ".person-avatar img", imageUrl(3));
  await page.goto("/settings/profile");
  await page.getByRole("button", { name: "Удалить фото", exact: true }).click();
  await expect(page.locator(".settings-avatar")).toHaveText("P");
  await expect(page.locator(".account-nav img")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Загрузить фото", exact: true })).toBeEnabled();
  await expect(page.locator(".settings-avatar img")).toHaveCount(0);
  expect(state.posts).toBe(2); expect(state.deletes).toBe(1); expect(state.unexpected).toEqual([]);
});

test("invalid files stay local, failed upload preserves photo and pending upload prevents duplicates", async ({ page }) => {
  const state = await fixture(page, { avatar: true });
  await page.goto("/settings/profile");
  const input = page.getByLabel("Выбрать фото профиля");
  await input.setInputFiles({ name: "photo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.getByRole("alert")).toContainText("PNG или JPEG");
  await input.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert")).toContainText("не больше 2 МБ");
  expect(state.posts).toBe(0);
  state.reject = true;
  await input.setInputFiles(file);
  await expect(page.getByRole("alert")).toContainText("Не удалось прочитать фото");
  await loaded(page, ".settings-avatar img", imageUrl(1));
  state.reject = false;
  let release!: () => void;
  state.gate = new Promise<void>(resolve => { release = resolve; });
  await input.setInputFiles(file);
  await expect(page.getByRole("button", { name: "Загрузка…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Удалить фото", exact: true })).toBeDisabled();
  await expect.poll(() => state.posts).toBe(2);
  await input.setInputFiles(file);
  expect(state.posts).toBe(2);
  release();
  await loaded(page, ".settings-avatar img", imageUrl(3));
  expect(state.posts).toBe(2); expect(state.unexpected).toEqual([]);
});

test("public profile photo has an accessible name without editing controls", async ({ page }) => {
  const state = await fixture(page, { avatar: true, signedIn: false });
  await page.goto(`/u/${user.username}`);
  await loaded(page, ".profile-avatar img", imageUrl(1));
  await expect(page.getByRole("img", { name: `Фото профиля ${user.username}`, exact: true })).toBeVisible();
  await expect(page.locator(".avatar-editor")).toHaveCount(0);
  expect(state.posts).toBe(0); expect(state.unexpected).toEqual([]);
});

test("failed photo requests keep a visible initial in settings and navigation", async ({ page }) => {
  await fixture(page, { avatar: true, broken: true });
  await page.goto("/settings/profile");
  await expect(page.locator(".settings-avatar")).toHaveText("P");
  await expect(page.locator(".account-nav .account-photo")).toHaveText("P");
  await expect(page.locator(".settings-avatar img")).toHaveCount(0);
});

for (const appearance of [{ name: "dark", theme: "dark", width: 1512, height: 982 }, { name: "light", theme: "light", width: 1512, height: 982 }, { name: "mobile", theme: "dark", width: 390, height: 844 }]) {
  test(`photo settings and public profile fit ${appearance.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: appearance.width, height: appearance.height });
    const state = await fixture(page, { avatar: true, theme: appearance.theme });
    for (const [route, name, selector] of [["/settings/profile", "settings", ".settings-avatar img"], [`/u/${user.username}`, "profile", ".profile-avatar img"]]) {
      await page.goto(route);
      await loaded(page, selector, imageUrl(1));
      await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`photo-${name}-${appearance.name}.png`), fullPage: true });
    }
    expect(state.unexpected).toEqual([]);
  });
}
