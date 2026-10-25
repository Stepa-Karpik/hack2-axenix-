import {
  flowPorts,
  routePort,
  routeOrthogonal,
  branchLabelPosition,
} from "./flowLayout.ts";
import type { RouteBox, RoutePoint } from "./flowLayout.ts";

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
function crowding(points: RoutePoint[], previous: RoutePoint[][]) {
  let score = 0;
  for (let i = 1; i < points.length; i++)
    for (const other of previous)
      for (let j = 1; j < other.length; j++) {
        const a = points[i - 1],
          b = points[i],
          c = other[j - 1],
          d = other[j];
        if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < 10)
          score += Math.max(
            0,
            Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
              Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)),
          );
        if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < 10)
          score += Math.max(
            0,
            Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
              Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)),
          );
      }
  return score;
}

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
  const prior: RoutePoint[][] = [];
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
    const lanes = [
      (start.x + end.x) / 2,
      left,
      right,
      left - 16,
      right + 16,
      left - 32,
      right + 32,
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
    const candidates =
      direct.complete && crowding(direct.points, prior) === 0
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
    candidates.sort(
      (a, b) =>
        Number(b.complete) - Number(a.complete) ||
        length(a.points) +
          crowding(a.points, prior) * 8 +
          a.points.length * 5 -
          (length(b.points) +
            crowding(b.points, prior) * 8 +
            b.points.length * 5),
    );
    const chosen = candidates[0];
    routes.set(edge.id, { ...chosen, ...ports, label: labels.get(edge.id) });
    prior.push(chosen.points);
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
