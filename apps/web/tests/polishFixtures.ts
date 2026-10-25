import { expect, type Page } from "@playwright/test";
export async function mount(page: Page, sample: any) {
  const user = {
    id: "d1111111-1111-4111-8111-111111111111",
    username: "showcase",
    displayName: "Showcase",
    emailVerified: true,
    authMethod: "password",
  };
  const project = {
    ...sample.project,
    ownerId: user.id,
    canEdit: true,
    role: "owner",
  };
  const writes: string[] = [];
  await page.addInitScript((id) => {
    for (const scope of ["settings", "profile", "home", "workspace"])
      localStorage.setItem(
        `java-blueprints:onboarding:v1:${id}:${scope}`,
        "done",
      );
  }, user.id);
  await page.context().route("**/api/v1/**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "READ_ONLY_FIXTURE",
            message: "Read-only acceptance fixture",
          },
        },
      });
    }
    let data: any = [];
    if (path === "/api/v1/session")
      data = {
        mode: "authenticated",
        csrfToken: "fixture",
        user,
        capabilities: {
          legacyGuestWorkspace: false,
          projectCreation: true,
          projectExport: true,
        },
      };
    else if (path === "/api/v1/profile") data = user;
    else if (path === "/api/v1/github/status")
      data = { configured: true, linked: null, repositoryAccess: false };
    else if (path === "/api/v1/friend-requests")
      data = { incoming: [], outgoing: [] };
    else if (path.endsWith("/overview"))
      data = {
        user,
        projects: { items: [project], totalVisible: 1, nextCursor: null },
        pinnedProjects: [],
        friends: { count: 0, mutualCount: 0 },
        contributions: { days: [], total: 0 },
        activity: [],
      };
    else if (path === "/api/v1/capabilities") data = sample.capabilities;
    else if (path === "/api/v1/projects") data = [project];
    else if (path === `/api/v1/projects/${project.id}`) data = project;
    else if (path.endsWith("/analysis")) data = sample.analysis;
    else if (path.endsWith("/layout"))
      data = {
        analysisId: sample.analysis.id,
        methodId: new URL(request.url()).searchParams.get("methodId"),
        positions: [],
        viewport: null,
        layoutVersion: 0,
      };
    else if (path.endsWith(`/revisions/${sample.revision.id}`))
      data = sample.revision;
    else if (path.endsWith("/revisions")) data = [sample.revision];
    return route.fulfill({
      json: { data, meta: { requestId: "local-acceptance" } },
    });
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator(".blueprint-node").first()).toBeAttached({
    timeout: 30000,
  });
  return { project, writes };
}
