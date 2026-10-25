import { migrateLayout } from "./workspaceLayout.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";

export type WorkspaceSnapshot = {
  version: 1;
  layout: WorkspaceLayout;
  collapsedNavigation: boolean;
  navigationDocked: boolean;
};
export const savedWorkspaceKey = (projectId?: string) =>
  "java-blueprints:workspace-saved:v1:" + (projectId ?? "default");

export function readWorkspaceSnapshot(
  projectId?: string,
): WorkspaceSnapshot | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(savedWorkspaceKey(projectId)) ?? "null",
    );
    const layout = value?.version === 1 ? migrateLayout(value.layout) : null;
    return layout
      ? {
          version: 1,
          layout,
          collapsedNavigation: value.collapsedNavigation === true,
          navigationDocked: value.navigationDocked !== false,
        }
      : null;
  } catch {
    return null;
  }
}
export function writeWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  projectId?: string,
) {
  try {
    localStorage.setItem(
      savedWorkspaceKey(projectId),
      JSON.stringify(snapshot),
    );
    return true;
  } catch {
    return false;
  }
}
