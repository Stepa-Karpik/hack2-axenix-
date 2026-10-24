import type { GraphNode } from "./types";
type Edge = { source: string; target: string; kind: string };
function append<K, T>(map: Map<K, T[]>, key: K, value: T) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
export function executionNodes(nodes: GraphNode[], edges: Edge[]) {
  const candidates = nodes.filter(
    (node) => node.executionRole !== "ast_projection",
  );
  const ids = new Set(candidates.map((node) => node.id));
  const connected = new Set(
    edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .flatMap((edge) => [edge.source, edge.target]),
  );
  return candidates.filter(
    (node) =>
      connected.has(node.id) || node.kind === "entry" || node.kind === "exit",
  );
}
// Rank the API graph after excluding DFS back edges; each rank has disjoint fixed-width lanes.
// No source expression interpretation or control-flow edges are created here.
export function arrangeFlow(nodes: GraphNode[], edges: Edge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges)
    if (ids.has(edge.source) && ids.has(edge.target))
      append(outgoing, edge.source, edge);
  const color = new Map<string, number>();
  const forward: Edge[] = [];
  const starts = [
    ...nodes.filter((node) => node.kind === "entry"),
    ...nodes.filter((node) => node.kind !== "entry"),
  ];
  for (const start of starts) {
    if (color.has(start.id)) continue;
    const stack = [{ id: start.id, index: 0 }];
    color.set(start.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.id) ?? [];
      if (frame.index >= children.length) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const edge = children[frame.index++];
      if (color.get(edge.target) === 1) continue;
      forward.push(edge);
      if (!color.has(edge.target)) {
        color.set(edge.target, 1);
        stack.push({ id: edge.target, index: 0 });
      }
    }
  }
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const children = new Map<string, Edge[]>();
  const parents = new Map<string, string[]>();
  for (const edge of forward) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    append(children, edge.source, edge);
    append(parents, edge.target, edge.source);
  }
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const edge of children.get(id) ?? []) {
      rank.set(
        edge.target,
        Math.max(rank.get(edge.target) ?? 0, (rank.get(id) ?? 0) + 1),
      );
      indegree.set(edge.target, indegree.get(edge.target)! - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  const rows = new Map<number, string[]>();
  for (const node of nodes) {
    const row = rank.get(node.id) ?? 0;
    append(rows, row, node.id);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [row, members] of [...rows].sort(([a], [b]) => a - b)) {
    const center = (id: string) => {
      const sources = parents.get(id) ?? [];
      return sources.length
        ? sources.reduce(
            (sum, parent) => sum + (positions.get(parent)?.x ?? 0),
            0,
          ) / sources.length
        : 0;
    };
    const centers = new Map(members.map((id) => [id, center(id)]));
    members.sort((a, b) => centers.get(a)! - centers.get(b)!);
    const mean =
      members.reduce((sum, id) => sum + centers.get(id)!, 0) / members.length;
    members.forEach((id, index) =>
      positions.set(id, {
        x: mean + (index - (members.length - 1) / 2) * 320,
        y: row * 145,
      }),
    );
  }
  return positions;
}

export function routeFlowEdges(
  nodes: { id: string; position: { x: number; y: number } }[],
  edges: (Edge & { id: string })[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let left = 0,
    right = 0;
  for (const node of nodes) {
    left = Math.min(left, node.position.x);
    right = Math.max(right, node.position.x + 280);
  }
  left -= 40;
  right += 40;
  const routes = new Map<string, number>();
  for (const edge of edges) {
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (!source || !target) continue;
    const distance = target.position.y - source.position.y;
    if (distance <= 0 || distance > 146)
      routes.set(edge.id, edge.kind === "true" ? right : left);
  }
  return routes;
}

export type RoutePoint = { x: number; y: number };
export type RouteBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export function segmentHitsBox(a: RoutePoint, b: RoutePoint, box: RouteBox) {
  return a.x === b.x
    ? a.x > box.x + 0.5 &&
        a.x < box.x + box.width - 0.5 &&
        Math.max(a.y, b.y) > box.y + 0.5 &&
        Math.min(a.y, b.y) < box.y + box.height - 0.5
    : a.y > box.y + 0.5 &&
        a.y < box.y + box.height - 0.5 &&
        Math.max(a.x, b.x) > box.x + 0.5 &&
        Math.min(a.x, b.x) < box.x + box.width - 0.5;
}
export function routeOrthogonal(
  start: RoutePoint,
  end: RoutePoint,
  lane: number,
  boxes: RouteBox[],
) {
  const initial = [
    start,
    { x: start.x, y: start.y + 22 },
    { x: lane, y: start.y + 22 },
    { x: lane, y: end.y - 22 },
    { x: end.x, y: end.y - 22 },
    end,
  ];
  const blockers = (points: RoutePoint[]) =>
    boxes.filter((box) =>
      points
        .slice(1)
        .some((point, index) => segmentHitsBox(points[index], point, box)),
    );
  const initialBlockers = blockers(initial);
  if (!initialBlockers.length) return { points: initial, complete: true };
  const relevant = new Map(initialBlockers.map((box) => [box.id, box]));
  // Only obstructed saved/dragged layouts need this bounded visibility-grid search.
  // A budget failure retains the original endpoints/label and exposes an explicit limited route.
  for (let round = 0; round < 4 && relevant.size <= 32; round++) {
    const obstacles = [...relevant.values()];
    const xs = [
      ...new Set([
        start.x,
        end.x,
        lane,
        ...obstacles.flatMap((box) => [box.x - 12, box.x + box.width + 12]),
      ]),
    ].sort((a, b) => a - b);
    const ys = [
      ...new Set([
        start.y,
        end.y,
        ...obstacles.flatMap((box) => [box.y - 12, box.y + box.height + 12]),
      ]),
    ].sort((a, b) => a - b);
    const width = xs.length,
      index = (x: number, y: number) => y * width + x;
    const first = index(xs.indexOf(start.x), ys.indexOf(start.y)),
      last = index(xs.indexOf(end.x), ys.indexOf(end.y));
    const parents = new Map<number, number>();
    parents.set(first, -1);
    const queue = [first];
    const point = (id: number) => ({
      x: xs[id % width],
      y: ys[Math.floor(id / width)],
    });
    for (
      let offset = 0;
      offset < queue.length && !parents.has(last);
      offset++
    ) {
      const id = queue[offset],
        x = id % width,
        y = Math.floor(id / width);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
        const next = index(nx, ny);
        if (parents.has(next)) continue;
        if (
          obstacles.some((box) => segmentHitsBox(point(id), point(next), box))
        )
          continue;
        parents.set(next, id);
        queue.push(next);
      }
    }
    if (!parents.has(last)) break;
    const path: RoutePoint[] = [];
    let at = last;
    while (at !== -1) {
      path.push(point(at));
      at = parents.get(at)!;
    }
    path.reverse();
    const collisions = blockers(path);
    if (!collisions.length) return { points: path, complete: true };
    for (const box of collisions) relevant.set(box.id, box);
  }
  return { points: initial, complete: false };
}
