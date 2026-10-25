import { planFlowRoutes } from "./flowRouting.ts";
import { roundedRoute } from "./flowLayout.ts";
import type { RouteBox } from "./flowLayout.ts";
import { routeNeighborhoodIndex } from "./flowScene.ts";

export type RouteScene = {
  boxes: (RouteBox & { methodId?: string })[];
  edges: { id: string; source: string; target: string; kind: string }[];
  ghost?: RouteBox & { methodId: string };
};
export function computeRoutePlan(scene: RouteScene) {
  const groups = new Map<string | undefined, RouteBox[]>();
  const byId = new Map(scene.boxes.map((box) => [box.id, box]));
  for (const box of scene.boxes) {
    const group = groups.get(box.methodId) ?? [];
    group.push(box);
    groups.set(box.methodId, group);
  }
  const edgesByMethod = new Map<string | undefined, RouteScene["edges"]>();
  for (const edge of scene.edges) {
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (!source || !target || source.methodId !== target.methodId) continue;
    const group = edgesByMethod.get(source.methodId) ?? [];
    group.push(edge);
    edgesByMethod.set(source.methodId, group);
  }
  const routes = new Map<
    string,
    ReturnType<typeof planFlowRoutes>["routes"] extends Map<string, infer R>
      ? R & { path: string }
      : never
  >();
  const neighborhood = routeNeighborhoodIndex(scene.boxes);
  for (const [methodId, own] of groups) {
    // Include neighboring methods as obstacles without planning their edges twice.
    // Every own-method box must remain an obstacle even when disconnected/far away.
    const nearby = groups.size === 1 ? [...scene.boxes] : neighborhood(own);
    if (scene.ghost && scene.ghost.methodId === methodId)
      nearby.push(scene.ghost);
    const plan = planFlowRoutes(nearby, edgesByMethod.get(methodId) ?? []);
    for (const [id, route] of plan.routes)
      routes.set(id, {
        ...route,
        path: roundedRoute(route.points, 16, plan.obstacles),
      });
  }
  return routes;
}
