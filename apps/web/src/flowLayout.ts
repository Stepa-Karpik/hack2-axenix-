import type { GraphNode, Method, SemanticModel } from "./types";
// Analysis IDs change after source saves; camera identity describes the declaration.
export function methodViewKey(
  projectId: string,
  method: Method | undefined,
  methodId: string,
) {
  return JSON.stringify([
    projectId,
    method?.sourceRange.filePath ?? "",
    method?.fullyQualifiedName ?? methodId,
    method?.signature ?? "",
  ]);
}

// Migrate only unambiguous nodes: inserting repeated statements must not transfer
// one statement's manual position to a different equal statement.
export function stableNodeKeys(nodes: GraphNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fingerprints = new Map<string, string>();
  for (const node of nodes) {
    const ancestry: string[][] = [];
    const visited = new Set<string>();
    let current: GraphNode | undefined = node;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ancestry.push([
        current.kind,
        current.executionRole ?? "",
        current !== node ||
        ["entry", "block", "BlockStmt"].includes(current.kind)
          ? ""
          : current.label,
      ]);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    fingerprints.set(node.id, JSON.stringify(ancestry));
  }
  const counts = new Map<string, number>();
  for (const key of fingerprints.values())
    counts.set(key, (counts.get(key) ?? 0) + 1);
  return new Map([...fingerprints].filter(([, key]) => counts.get(key) === 1));
}

// Keep intentional manual positions fixed while automatic rows reflow around
// them. Pinning a whole old automatic layout would trap new nodes in old ranks.
export function placeManualFlow(
  automatic: Map<string, { x: number; y: number }>,
  manual: Map<string, { x: number; y: number }>,
) {
  const placed = new Map([...manual].filter(([id]) => automatic.has(id)));
  const rows = new Map<number, [string, { x: number; y: number }][]>();
  for (const [id, position] of automatic) {
    if (!placed.has(id)) append(rows, position.y, [id, position]);
  }
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x < b.x + 288 && a.x + 288 > b.x && a.y < b.y + 108 && a.y + 108 > b.y;
  let shift = 0;
  for (const [rank, members] of [...rows].sort(([a], [b]) => a - b)) {
    let y = rank + shift;
    while (
      members.some(([, position]) =>
        [...placed.values()].some((other) =>
          overlaps({ x: position.x, y }, other),
        ),
      )
    )
      y += 128;
    shift = y - rank;
    for (const [id, position] of members) placed.set(id, { x: position.x, y });
  }
  return placed;
}

export type VisualKind =
  | "method"
  | "terminal"
  | "return"
  | "condition"
  | "loop"
  | "variable"
  | "call"
  | "operation"
  | "jump"
  | "structure"
  | "join";
export function visualKind(
  node: GraphNode,
  semantics?: SemanticModel | null,
): VisualKind {
  if (
    ["resource_primary", "resource_throw", "resource_suppress"].includes(
      node.kind,
    )
  )
    return "return";
  if (["resource_check", "resource_suppression_check"].includes(node.kind))
    return "condition";
  if (node.kind === "resource_init") return "variable";
  if (node.kind === "resource_close") return "call";
  if (node.kind === "resource_resume") return "structure";
  if (node.kind === "entry") return "method";
  if (["normal_exit", "exceptional_exit", "exit"].includes(node.kind))
    return "terminal";
  if (["ReturnStmt", "return", "ThrowStmt"].includes(node.kind))
    return "return";
  if (
    ["BreakStmt", "ContinueStmt", "loop_back", "foreach_advance"].includes(
      node.kind,
    )
  )
    return "jump";
  if (
    [
      "condition_test",
      "catch_test",
      "foreach_check",
      "switch_selector",
      "condition",
      "if",
    ].includes(node.kind)
  )
    return "condition";
  if (
    ["ForStmt", "WhileStmt", "DoStmt", "ForEachStmt", "loop"].includes(
      node.kind,
    )
  )
    return "loop";
  if (["VariableDeclarationExpr", "foreach_bind"].includes(node.kind))
    return "variable";
  if (["MethodCallExpr", "ObjectCreationExpr"].includes(node.kind))
    return "call";
  if (node.kind === "merge") return "join";
  if (["finally_resume"].includes(node.kind)) return "jump";
  if (["try_entry", "catch_entry", "finally_entry"].includes(node.kind))
    return "structure";
  if (node.executionRole === "structural") return "structure";
  const range = node.sourceRange;
  if (
    ["ExpressionStmt", "for_init"].includes(node.kind) &&
    range &&
    semantics
  ) {
    const contained = (r: GraphNode["sourceRange"]) =>
      r &&
      r.filePath === range.filePath &&
      r.startOffset >= range.startOffset &&
      r.endOffset <= range.endOffset;
    const declarations = semantics.symbols.filter(
      (symbol) =>
        !symbol.external &&
        symbol.kind === "local" &&
        contained(symbol.sourceRange),
    );
    const calls = semantics.references.filter(
      (reference) =>
        ["call", "constructor"].includes(reference.kind) &&
        contained(reference.sourceRange),
    );
    if (declarations.length === 1 && calls.length === 0) return "variable";
    // A call occupies the whole ExpressionStmt except its trailing semicolon.
    // Contained calls in assignments/declarations remain ordinary operations.
    if (
      !declarations.length &&
      node.kind === "ExpressionStmt" &&
      calls.length === 1 &&
      calls[0].sourceRange.startOffset === range.startOffset &&
      calls[0].sourceRange.endOffset === range.endOffset - 1
    )
      return "call";
  }
  return "operation";
}
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
export function arrangeFlow(
  nodes: GraphNode[],
  edges: Edge[],
  ancestry = nodes,
) {
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
  const incoming = new Map<string, Edge[]>();
  for (const edge of forward) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    append(children, edge.source, edge);
    append(parents, edge.target, edge.source);
    append(incoming, edge.target, edge);
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
  // Keep real loop exits below their repeated body. This is a layout constraint,
  // not an execution edge: an early false/break/return keeps its exact endpoint.
  const allById = new Map(ancestry.map((node) => [node.id, node]));
  const loops = nodes.filter((node) =>
    ["WhileStmt", "ForStmt", "ForEachStmt", "DoStmt", "loop"].includes(
      node.kind,
    ),
  );
  const membersOf = (loop: GraphNode) =>
    new Set(
      nodes
        .filter((candidate) => {
          let node: GraphNode | undefined = candidate;
          const visited = new Set<string>();
          while (node && !visited.has(node.id)) {
            if (node.id === loop.id) return true;
            visited.add(node.id);
            node = node.parentId ? allById.get(node.parentId) : undefined;
          }
          return false;
        })
        .map((node) => node.id),
    );
  const groups = loops
    .map((loop) => membersOf(loop))
    .sort((a, b) => a.size - b.size);
  for (const members of groups) {
    const last = Math.max(...[...members].map((id) => rank.get(id) ?? 0));
    for (const edge of forward)
      if (members.has(edge.source) && !members.has(edge.target))
        rank.set(edge.target, Math.max(rank.get(edge.target) ?? 0, last + 1));
    for (const id of queue)
      for (const edge of children.get(id) ?? [])
        rank.set(
          edge.target,
          Math.max(rank.get(edge.target) ?? 0, (rank.get(id) ?? 0) + 1),
        );
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
    const branchOrder = (id: string) => {
      const links = incoming.get(id) ?? [];
      return (
        links.reduce(
          (sum, link) =>
            sum + (link.kind === "false" ? 1 : link.kind === "true" ? -1 : 0),
          0,
        ) / Math.max(1, links.length)
      );
    };
    // A bottom true port leads left; the right false port leads right. Only
    // break rank ties: sequential paths retain their single vertical lane.
    members.sort(
      (a, b) =>
        centers.get(a)! - centers.get(b)! || branchOrder(a) - branchOrder(b),
    );
    const mean =
      members.reduce((sum, id) => sum + centers.get(id)!, 0) / members.length;
    members.forEach((id, index) =>
      positions.set(id, {
        x: mean + (index - (members.length - 1) / 2) * 320,
        y: row * 128,
      }),
    );
  }
  return positions;
}

export function routeFlowEdges(
  nodes: {
    id: string;
    position: { x: number; y: number };
    data?: { kind?: string };
  }[],
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
  const reserved = new Map<
    number,
    { x: number; top: number; bottom: number; merge?: string }[]
  >();
  const lane = (
    base: number,
    direction: number,
    sourceY: number,
    targetY: number,
    merge?: string,
  ) => {
    const top = Math.min(sourceY, targetY) - 24;
    const bottom = Math.max(sourceY, targetY) + 84;
    let x = base;
    const occupied = () => {
      const cell = Math.floor(x / 24);
      for (let index = cell - 1; index <= cell + 1; index++) {
        for (const route of reserved.get(index) ?? []) {
          if (
            Math.abs(route.x - x) < 20 &&
            top < route.bottom &&
            bottom > route.top &&
            !(merge && merge === route.merge)
          )
            return true;
        }
      }
      return false;
    };
    while (occupied()) x += direction * 24;
    append(reserved, Math.floor(x / 24), { x, top, bottom, merge });
    return x;
  };
  for (const edge of [...edges].sort((a, b) => {
    const span = (e: typeof a) =>
      Math.abs(
        (byId.get(e.source)?.position.y ?? 0) -
          (byId.get(e.target)?.position.y ?? 0),
      );
    return span(a) - span(b) || a.id.localeCompare(b.id);
  })) {
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (!source || !target) continue;
    const distance = target.position.y - source.position.y;
    if (edge.kind === "case" || edge.kind === "default") {
      routes.set(
        edge.id,
        target.position.x < source.position.x
          ? lane(left, -1, source.position.y, target.position.y)
          : lane(right, 1, source.position.y, target.position.y),
      );
      continue;
    }
    // False branches leave the real right-side port. Sending them left forces
    // obstacle fallback across their own source, which can collapse unrelated
    // false paths onto the same source boundary despite distinct planned lanes.
    if (edge.kind === "false" && distance > 0) {
      routes.set(
        edge.id,
        lane(
          target.position.x + 132 >= source.position.x + 286
            ? target.position.x + 132
            : Math.max(source.position.x, target.position.x) + 304,
          1,
          source.position.y,
          target.position.y,
        ),
      );
      continue;
    }
    if (
      ["ReturnStmt", "ThrowStmt"].includes(source.data?.kind ?? "") &&
      distance > 161
    ) {
      routes.set(
        edge.id,
        lane(
          Math.max(source.position.x, target.position.x) + 304,
          1,
          source.position.y,
          target.position.y,
          "return:" + edge.target,
        ),
      );
      continue;
    }
    if (distance <= 0 || distance > 161)
      routes.set(
        edge.id,
        edge.kind === "true"
          ? lane(right, 1, source.position.y, target.position.y)
          : lane(left, -1, source.position.y, target.position.y),
      );
  }
  return routes;
}

export type RoutePoint = { x: number; y: number };
export type RouteSide = "top" | "right" | "bottom" | "left";
export function flowPorts(source: RouteBox, target: RouteBox, kind: string) {
  const dx = target.x + target.width / 2 - source.x - source.width / 2;
  const dy = target.y + target.height / 2 - source.y - source.height / 2;
  // Back edges keep an exterior corridor and arrive from above/beside the loop.
  if (kind === "loop")
    return { sourceSide: "left", targetSide: "left" } as const;
  if (dy <= -24 && Math.abs(dx) <= 40)
    return { sourceSide: "top", targetSide: "bottom" } as const;
  if (dy <= -24)
    return {
      sourceSide: dx < 0 ? "left" : "right",
      targetSide: "bottom",
    } as const;
  const branch = kind === "true" || kind === "false";
  const sideways = Math.abs(dx) > 40 && (branch || Math.abs(dy) < 100);
  const sourceSide: RouteSide =
    branch && Math.abs(dx) <= 40
      ? kind === "true"
        ? "left"
        : "right"
      : sideways
        ? dx < 0
          ? "left"
          : "right"
        : "bottom";
  const targetSide: RouteSide =
    target.y >= source.y + source.height + 24
      ? "top"
      : dx < 0
        ? "right"
        : dx > 0
          ? "left"
          : "top";
  return { sourceSide, targetSide };
}
export function routePort(box: RouteBox, side: RouteSide): RoutePoint {
  return {
    x:
      side === "left"
        ? box.x
        : side === "right"
          ? box.x + box.width
          : box.x + box.width / 2,
    y:
      side === "top"
        ? box.y
        : side === "bottom"
          ? box.y + box.height
          : box.y + box.height / 2,
  };
}
export function branchLabelPosition(start: RoutePoint, side: RouteSide) {
  return {
    x: start.x + (side === "left" ? -34 : side === "right" ? 34 : 26),
    y: start.y + (side === "top" ? -24 : side === "bottom" ? 24 : -19),
  };
}
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
  departure = 22,
  sourceSide: RouteSide = "bottom",
  arrival = 22,
  targetSide: RouteSide = "top",
  compact = false,
) {
  const outward = (point: RoutePoint, side: RouteSide, distance: number) => ({
    x:
      point.x + (side === "left" ? -distance : side === "right" ? distance : 0),
    y:
      point.y + (side === "top" ? -distance : side === "bottom" ? distance : 0),
  });
  const leave = outward(start, sourceSide, departure);
  const approach = outward(end, targetSide, arrival);
  const initial = [
    start,
    leave,
    { x: lane, y: leave.y },
    { x: lane, y: approach.y },
    approach,
    end,
  ];
  const blockers = (points: RoutePoint[]) =>
    boxes.filter((box) =>
      points
        .slice(1)
        .some((point, index) => segmentHitsBox(points[index], point, box)),
    );
  const initialBlockers = blockers(initial);
  if (compact) {
    const candidates = [
      [start, leave, { x: leave.x, y: approach.y }, approach, end],
      [start, leave, { x: approach.x, y: leave.y }, approach, end],
    ];
    const length = (points: RoutePoint[]) =>
      points
        .slice(1)
        .reduce(
          (sum, p, i) =>
            sum + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y),
          0,
        );
    const clear = candidates
      .filter((points) => !blockers(points).length)
      .sort((a, b) => length(a) - length(b));
    if (clear.length) return { points: clear[0], complete: true };
  }
  if (!initialBlockers.length && !compact)
    return { points: initial, complete: true };
  // Endpoint stems are fixed by the actual handle direction. Do not enter the
  // source/target through a different side just to report a successful route.
  if (blockers([start, leave]).length || blockers([approach, end]).length)
    return { points: initial, complete: false };
  const relevant = new Map(
    (compact
      ? boxes.filter(
          (box) =>
            box.x < Math.max(start.x, end.x) + 36 &&
            box.x + box.width > Math.min(start.x, end.x) - 36 &&
            box.y < Math.max(start.y, end.y) + 36 &&
            box.y + box.height > Math.min(start.y, end.y) - 36,
        )
      : initialBlockers
    ).map((box) => [box.id, box]),
  );
  // Only obstructed saved/dragged layouts need this bounded visibility-grid search.
  // A budget failure retains the original endpoints/label and exposes an explicit limited route.
  for (let round = 0; round < 4 && relevant.size <= 32; round++) {
    const obstacles = [...relevant.values()];
    const xs = [
      ...new Set([
        start.x,
        end.x,
        leave.x,
        approach.x,
        lane,
        ...obstacles.flatMap((box) => [box.x - 12, box.x + box.width + 12]),
      ]),
    ].sort((a, b) => a - b);
    const ys = [
      ...new Set([
        start.y,
        end.y,
        leave.y,
        approach.y,
        ...obstacles.flatMap((box) => [box.y - 12, box.y + box.height + 12]),
      ]),
    ].sort((a, b) => a - b);
    const width = xs.length,
      index = (x: number, y: number) => y * width + x;
    const first = index(xs.indexOf(leave.x), ys.indexOf(leave.y)),
      last = index(xs.indexOf(approach.x), ys.indexOf(approach.y));
    const parents = new Map<number, number>();
    parents.set(first, -1);
    const queue = [first];
    const distances = new Map<number, number>([[first, 0]]);
    const point = (id: number) => ({
      x: xs[id % width],
      y: ys[Math.floor(id / width)],
    });
    const estimate = (id: number) =>
      Math.abs(point(id).x - approach.x) + Math.abs(point(id).y - approach.y);
    const settled = new Set<number>();
    while (queue.length) {
      // Visibility cells have unequal lengths. A hop-count BFS can prefer a
      // huge exterior detour; A* minimizes actual canvas distance instead.
      queue.sort(
        (a, b) =>
          distances.get(a)! + estimate(a) - (distances.get(b)! + estimate(b)),
      );
      const id = queue.shift()!;
      if (id === last) break;
      if (settled.has(id)) continue;
      settled.add(id);
      const x = id % width,
        y = Math.floor(id / width);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
        const next = index(nx, ny);
        if (settled.has(next)) continue;
        const step = {
          x: point(next).x - point(id).x,
          y: point(next).y - point(id).y,
        };
        if (
          id === first &&
          step.x * (leave.x - start.x) + step.y * (leave.y - start.y) < 0
        )
          continue;
        if (
          next === last &&
          (point(id).x - approach.x) * (approach.x - end.x) +
            (point(id).y - approach.y) * (approach.y - end.y) <
            0
        )
          continue;
        if (
          obstacles.some((box) => segmentHitsBox(point(id), point(next), box))
        )
          continue;
        const distance =
          distances.get(id)! +
          Math.abs(point(id).x - point(next).x) +
          Math.abs(point(id).y - point(next).y);
        if (distance < (distances.get(next) ?? Infinity)) {
          distances.set(next, distance);
          parents.set(next, id);
          queue.push(next);
        }
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
    path.unshift(start);
    path.push(end);
    const collisions = blockers(path);
    if (!collisions.length) return { points: path, complete: true };
    for (const box of collisions) relevant.set(box.id, box);
  }
  return { points: initial, complete: !initialBlockers.length };
}

export type LoopArea = RouteBox & { kind: string; members: string[] };
const loopKinds = new Set([
  "WhileStmt",
  "ForStmt",
  "ForEachStmt",
  "DoStmt",
  "loop",
]);
// Parent identity, not source text or bounding source lines, defines membership.
// A rectangle is omitted when a foreign node overlaps it: visual containment
// must not imply membership that the engine did not provide.
export function loopAreas(all: GraphNode[], boxes: RouteBox[]): LoopArea[] {
  const byId = new Map(all.map((node) => [node.id, node]));
  const belongs = (id: string, loopId: string) => {
    const visited = new Set<string>();
    let node = byId.get(id);
    while (node && !visited.has(node.id)) {
      if (node.id === loopId) return true;
      visited.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return false;
  };
  const areas: LoopArea[] = [];
  for (const loop of all.filter((node) => loopKinds.has(node.kind))) {
    const members = boxes.filter(
      (box) =>
        belongs(box.id, loop.id) &&
        !(
          byId.get(box.id)?.parentId === loop.id &&
          ["foreach_source", "for_init"].includes(byId.get(box.id)?.kind ?? "")
        ) &&
        !(loop.kind === "ForEachStmt" && box.id === loop.id),
    );
    if (members.length < 2) continue;
    const x = Math.min(...members.map((box) => box.x)) - 24;
    const y = Math.min(...members.map((box) => box.y)) - 36;
    const right = Math.max(...members.map((box) => box.x + box.width)) + 24;
    const bottom = Math.max(...members.map((box) => box.y + box.height)) + 24;
    if (
      boxes.some(
        (box) =>
          !members.includes(box) &&
          box.x < right &&
          box.x + box.width > x &&
          box.y < bottom &&
          box.y + box.height > y,
      )
    )
      continue;
    areas.push({
      id: `loop-area:${loop.id}`,
      kind: loop.kind,
      x,
      y,
      width: right - x,
      height: bottom - y,
      members: members.map((box) => box.id),
    });
  }
  return areas.sort((a, b) => b.width * b.height - a.width * a.height);
}

export function compactFlowLabel(label: string, limit = 32) {
  const characters = Array.from(label);
  return characters.length > limit
    ? characters.slice(0, limit - 1).join("") + "…"
    : label;
}

export function dispatchLabelPosition(target: { x: number; y: number }) {
  return { x: target.x, y: target.y - 16 };
}

export function flowLabelTitle(
  fullLabel: string | undefined,
  complete: boolean,
) {
  if (complete) return fullLabel;
  return [fullLabel, "Маршрут ограничен: обход узлов не гарантирован"]
    .filter(Boolean)
    .join("\n");
}

// Round only the existing obstacle-safe polyline corners; preserve route topology.
export function roundedRoute(
  points: { x: number; y: number }[],
  radius = 16,
  boxes: RouteBox[] = [],
) {
  if (!points.length) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y),
      bc = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, ab / 2, bc / 2);
    if (!ab || !bc) continue;
    const x1 = b.x + ((a.x - b.x) * r) / ab,
      y1 = b.y + ((a.y - b.y) * r) / ab;
    const x2 = b.x + ((c.x - b.x) * r) / bc,
      y2 = b.y + ((c.y - b.y) * r) / bc;
    // A clear polyline may touch an obstacle corner. Never round into that box.
    const intersects = boxes.some(
      (box) =>
        Math.min(x1, b.x, x2) < box.x + box.width - 0.5 &&
        Math.max(x1, b.x, x2) > box.x + 0.5 &&
        Math.min(y1, b.y, y2) < box.y + box.height - 0.5 &&
        Math.max(y1, b.y, y2) > box.y + 0.5,
    );
    path += intersects
      ? ` L ${b.x} ${b.y}`
      : ` L ${x1} ${y1} Q ${b.x} ${b.y} ${x2} ${y2}`;
  }
  const end = points[points.length - 1];
  return path + ` L ${end.x} ${end.y}`;
}
