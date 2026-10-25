import {
  flowPorts,
  routePort,
  routeOrthogonal,
  branchLabelPosition,
} from "./flowLayout.ts";
import type { RouteBox, RoutePoint } from "./flowLayout.ts";
import { RouteCrowdingIndex } from "./flowCrowding.ts";

export const BRANCH_BADGE = { width: 44, height: 26 };
type Link = { id: string; source: string; target: string; kind: string };
const length = (points: RoutePoint[]) =>
  points
    .slice(1)
    .reduce(
      (sum, p, i) =>
        sum + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y),
      0,
    );
/** Plan the actual rendered polylines together; never move source nodes or rewrite edges. */
export function planFlowRoutes(boxes: RouteBox[], edges: Link[]) {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const labels = new Map<string, RouteBox>();
  for (const edge of edges) {
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (!source || !target || !["true", "false"].includes(edge.kind)) continue;
    const ports = flowPorts(source, target, edge.kind),
      at = branchLabelPosition(
        routePort(source, ports.sourceSide),
        ports.sourceSide,
      );
    labels.set(edge.id, {
      id: "label:" + edge.id,
      x: at.x - BRANCH_BADGE.width / 2,
      y: at.y - BRANCH_BADGE.height / 2,
      ...BRANCH_BADGE,
    });
  }
  const obstacles = [...boxes, ...labels.values()];
  const routes = new Map<
    string,
    {
      points: RoutePoint[];
      complete: boolean;
      sourceSide: ReturnType<typeof flowPorts>["sourceSide"];
      targetSide: ReturnType<typeof flowPorts>["targetSide"];
      label?: RouteBox;
    }
  >();
  const crowdingIndex = new RouteCrowdingIndex();
  const ordered = [...edges].sort((a, b) => {
    const span = (e: Link) =>
      Math.abs((byId.get(e.source)?.y ?? 0) - (byId.get(e.target)?.y ?? 0));
    return (
      span(a) - span(b) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id)
    );
  });
  for (const edge of ordered) {
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (!source || !target) continue;
    const ports = flowPorts(source, target, edge.kind),
      start = routePort(source, ports.sourceSide),
      end = routePort(target, ports.targetSide);
    const left = Math.min(source.x, target.x) - 30,
      right = Math.max(source.x + source.width, target.x + target.width) + 30;
    // Long jumps (break/continue/exception exits) span many rows; lanes beside
    // only the endpoints still cut through sibling columns. Outer lanes clear
    // every box in the vertical span, so the search never falls back to a
    // straight line through cards.
    const top = Math.min(start.y, end.y),
      bottom = Math.max(start.y, end.y);
    let outerLeft = left,
      outerRight = right;
    for (const box of obstacles)
      if (box.y < bottom && box.y + box.height > top) {
        outerLeft = Math.min(outerLeft, box.x - 30);
        outerRight = Math.max(outerRight, box.x + box.width + 30);
      }
    const lanes = [
      (start.x + end.x) / 2,
      left,
      right,
      left - 16,
      right + 16,
      left - 32,
      right + 32,
      ...(outerLeft < left || outerRight > right
        ? [outerLeft, outerRight, outerLeft - 16, outerRight + 16, outerLeft - 32, outerRight + 32]
        : []),
    ];
    const direct = routeOrthogonal(
      start,
      end,
      lanes[0],
      obstacles,
      22,
      ports.sourceSide,
      22,
      ports.targetSide,
      true,
    );
    const directCrowding = crowdingIndex.score(direct.points);
    const candidates =
      direct.complete && directCrowding === 0
        ? [direct]
        : [
            direct,
            ...lanes.map((lane) =>
              routeOrthogonal(
                start,
                end,
                lane,
                obstacles,
                22,
                ports.sourceSide,
                22,
                ports.targetSide,
                false,
              ),
            ),
          ];
    const scored = candidates.map((route) => ({
      route,
      score:
        length(route.points) +
        (route === direct
          ? directCrowding
          : crowdingIndex.score(route.points)) *
          8 +
        route.points.length * 5,
    }));
    scored.sort(
      (a, b) =>
        Number(b.route.complete) - Number(a.route.complete) ||
        a.score - b.score,
    );
    const chosen = scored[0].route;
    routes.set(edge.id, { ...chosen, ...ports, label: labels.get(edge.id) });
    crowdingIndex.add(chosen.points);
  }
  return { routes, obstacles };
}

export type CanvasPosition = {
  nodeId: string;
  methodId: string;
  x: number;
  y: number;
};
export function validOverviewPositions(
  value: unknown,
  bindings: Map<string, string>,
): value is CanvasPosition[] {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    value.length !== bindings.size
  )
    return false;
  const seen = new Set<string>();
  return value.every(
    (p) =>
      p &&
      typeof p.nodeId === "string" &&
      !seen.has(p.nodeId) &&
      seen.add(p.nodeId) &&
      bindings.get(p.nodeId) === p.methodId &&
      [p.x, p.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 1000000),
  );
}
