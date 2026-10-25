import type { Graph, GraphNode } from "./types.ts";

export type PreviewTemplate = {
  kind: "statement" | "condition" | "loop";
  anchorNodeId: string;
  position: string;
  source?: string;
  request?: number;
};
export const previewFingerprint = (
  scope: string,
  request: PreviewTemplate | null | undefined,
) => JSON.stringify([scope, request]);
export const dismissedPreviewKeys = (
  scope: string,
  hover: PreviewTemplate | null | undefined,
  draft: PreviewTemplate | null | undefined,
) => [
  ...new Set([
    previewFingerprint(scope, hover),
    previewFingerprint(scope, draft),
  ]),
];
type SceneNode = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
};
const size = (n: SceneNode) => ({
  width: n.measured?.width ?? 264,
  height: n.measured?.height ?? 84,
});
/** Freeze visible hit boxes once per native drag; projection changes cannot move the target under the pointer. */
export function previewHitSnapshot<T extends SceneNode>(nodes: T[]): T[] {
  return nodes.map((n) => ({
    ...n,
    position: { ...n.position },
    ...(n.measured ? { measured: { ...n.measured } } : {}),
  }));
}
export function baseNodeAt<T extends SceneNode>(
  nodes: T[],
  point: { x: number; y: number },
) {
  return nodes.find(
    (n) =>
      point.x >= n.position.x &&
      point.x <= n.position.x + size(n).width &&
      point.y >= n.position.y &&
      point.y <= n.position.y + size(n).height,
  );
}
/** A disposable display projection. No input, binding, semantic edge or saved position is changed. */
export function previewScene<T extends SceneNode>(
  nodes: T[],
  graph: Pick<Graph, "nodes" | "edges" | "revisionId" | "analysisId">,
  request: PreviewTemplate | null | undefined,
  disabled = false,
) {
  if (
    disabled ||
    !request ||
    !["statement", "condition", "loop"].includes(request.kind)
  )
    return null;
  const anchor = graph.nodes.find((n) => n.id === request.anchorNodeId);
  if (
    !anchor ||
    anchor.revisionId !== graph.revisionId ||
    anchor.analysisId !== graph.analysisId ||
    !anchor.allowedOperations?.includes("insert_statement") ||
    !anchor.insertionPositions?.includes(request.position)
  )
    return null;
  const source = new Map(graph.nodes.map((n) => [n.id, n]));
  const member = (n: SceneNode) =>
    source.get(n.id)?.methodId === anchor.methodId;
  const local = nodes.filter(member);
  if (!local.length) return null;
  const descendant = (n: GraphNode) => {
    const seen = new Set<string>();
    let id: string | null = n.id;
    while (id && !seen.has(id)) {
      if (id === anchor.id) return true;
      seen.add(id);
      id = source.get(id)?.parentId ?? null;
    }
    return false;
  };
  const subtree = local.filter((n) => {
    const s = source.get(n.id);
    return s && descendant(s);
  });
  let pivot: T | undefined =
    local.find((n) => n.id === anchor.id) ??
    subtree.slice().sort((a, b) => a.position.y - b.position.y)[0];
  if (!pivot) {
    let parent = anchor.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent) && !pivot) {
      seen.add(parent);
      pivot = local.find((n) => n.id === parent);
      parent = source.get(parent)?.parentId ?? null;
    }
  }
  if (!pivot) return null;
  const children = subtree.filter(
    (n) => n.id !== anchor.id && source.get(n.id)?.sourceRange,
  );
  let cut: number;
  if (request.position === "before")
    cut = Math.min(pivot.position.y, ...subtree.map((n) => n.position.y));
  else if (request.position === "after")
    cut =
      Math.max(
        pivot.position.y + size(pivot).height,
        ...subtree.map((n) => n.position.y + size(n).height),
      ) + 30;
  else if (request.position === "body_start")
    cut = children.length
      ? Math.min(...children.map((n) => n.position.y))
      : pivot.position.y + size(pivot).height + 30;
  else if (request.position === "body_end") {
    const terminal =
      anchor.kind === "entry"
        ? local.filter((n) =>
            ["normal_exit", "exceptional_exit"].includes(
              source.get(n.id)?.kind ?? "",
            ),
          )
        : [];
    cut = terminal.length
      ? Math.min(...terminal.map((n) => n.position.y))
      : Math.max(
          pivot.position.y + size(pivot).height,
          ...children.map((n) => n.position.y + size(n).height),
        ) + 30;
  } else return null;
  const height =
    request.kind === "condition" ? 370 : request.kind === "loop" ? 310 : 230;
  const gap = height + 60;
  const ghost = { x: pivot.position.x, y: cut + 20, width: 264, height };
  const shiftedIds = new Set(
    local.filter((n) => n.position.y >= cut).map((n) => n.id),
  );
  let display = nodes.map((n) =>
    shiftedIds.has(n.id)
      ? { ...n, position: { x: n.position.x, y: n.position.y + gap } }
      : n,
  );
  // Overview rows may be closer than the temporary insertion gap. Move whole
  // colliding method groups only in this projection, cascading downwards.
  const methods = [
    ...new Set(
      nodes
        .map((n) => source.get(n.id)?.methodId)
        .filter((id): id is string => !!id),
    ),
  ];
  const bounds = (items: T[]) => ({
    x: Math.min(...items.map((n) => n.position.x)) - 24,
    y: Math.min(...items.map((n) => n.position.y)) - 24,
    right: Math.max(...items.map((n) => n.position.x + size(n).width)) + 24,
    bottom: Math.max(...items.map((n) => n.position.y + size(n).height)) + 24,
  });
  const baseBounds = new Map(
    methods.map((id) => [
      id,
      bounds(nodes.filter((n) => source.get(n.id)?.methodId === id)),
    ]),
  );
  const displayBounds = new Map(
    methods.map((id) => [
      id,
      bounds(display.filter((n) => source.get(n.id)?.methodId === id)),
    ]),
  );
  const active = displayBounds.get(anchor.methodId)!;
  active.x = Math.min(active.x, ghost.x - 24);
  active.y = Math.min(active.y, ghost.y - 24);
  active.right = Math.max(active.right, ghost.x + ghost.width + 24);
  active.bottom = Math.max(active.bottom, ghost.y + ghost.height + 24);
  const overlap = (a: typeof active, b: typeof active) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
  const order = methods.sort(
    (a, b) => baseBounds.get(a)!.y - baseBounds.get(b)!.y || a.localeCompare(b),
  );
  const offsets = new Map<string, number>(),
    movedMethods = new Set([anchor.methodId]);
  for (let i = 0; i < order.length; i++) {
    const id = order[i],
      current = displayBounds.get(id)!;
    for (let j = 0; j < i; j++) {
      const previousId = order[j],
        previous = displayBounds.get(previousId)!;
      const area = overlap(previous, current);
      if (
        area > 0 &&
        area >
          overlap(baseBounds.get(previousId)!, baseBounds.get(id)!) + 0.01 &&
        (movedMethods.has(previousId) || movedMethods.has(id))
      ) {
        const delta = previous.bottom + 80 - current.y;
        if (delta > 0) {
          current.y += delta;
          current.bottom += delta;
          offsets.set(id, (offsets.get(id) ?? 0) + delta);
          movedMethods.add(id);
        }
      }
    }
  }
  display = display.map((n) => {
    const offset = offsets.get(source.get(n.id)?.methodId ?? "") ?? 0;
    if (!offset) return n;
    shiftedIds.add(n.id);
    return { ...n, position: { x: n.position.x, y: n.position.y + offset } };
  });
  ghost.y += offsets.get(anchor.methodId) ?? 0;
  const inside = new Set(subtree.map((n) => n.id));
  const boundary = graph.edges.filter((edge) => {
    if (
      source.get(edge.source)?.methodId !== anchor.methodId ||
      source.get(edge.target)?.methodId !== anchor.methodId
    )
      return false;
    if (request.position === "body_start" && anchor.kind === "entry")
      return edge.source === anchor.id && edge.target !== anchor.id;
    return request.position === "before" || request.position === "body_start"
      ? !inside.has(edge.source) && inside.has(edge.target)
      : inside.has(edge.source) && !inside.has(edge.target);
  });
  // Only a unique real insertion boundary can identify external connectors.
  // A sibling at a nearby y coordinate is never treated as a predecessor.
  const unique = boundary.length === 1 ? boundary[0] : null;
  const before = unique
    ? display.find((n) => n.id === unique.source)
    : undefined;
  const after = unique
    ? display.find((n) => n.id === unique.target)
    : undefined;
  const connector = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => `M ${a.x} ${a.y} V ${(a.y + b.y) / 2} H ${b.x} V ${b.y}`;
  const connectors: string[] = [];
  if (before)
    connectors.push(
      connector(
        {
          x: before.position.x + size(before).width / 2,
          y: before.position.y + size(before).height,
        },
        { x: ghost.x + 132, y: ghost.y },
      ),
    );
  if (after)
    connectors.push(
      connector(
        { x: ghost.x + 132, y: ghost.y + height },
        { x: after.position.x + size(after).width / 2, y: after.position.y },
      ),
    );
  return {
    nodes: display,
    ghost,
    shiftedIds,
    methodId: anchor.methodId,
    movedMethods,
    request,
    connectors,
  };
}
