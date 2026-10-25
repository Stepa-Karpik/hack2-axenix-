/** Geometry indexes only. The complete graph and its authoritative IDs stay unchanged. */
export function groupByMethod<T extends { methodId: string }>(nodes: T[]) {
  const groups = new Map<string, T[]>();
  for (const node of nodes) {
    const group = groups.get(node.methodId);
    if (group) group.push(node);
    else groups.set(node.methodId, [node]);
  }
  return groups;
}

/** Keep uncertainty/provisional dashes legible at overview zoom rather than silently making them solid. */
export function overviewDashPattern(
  strokeDasharray: string | number | undefined,
  provisional: boolean,
  limited: boolean,
  zoom: number,
) {
  const value = strokeDasharray ?? (provisional || limited ? "4 4" : "");
  if (value === "none" || value === "") return [];
  const pattern = String(value)
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !pattern.length ||
    pattern.some((value) => !Number.isFinite(value) || value < 0)
  )
    return [];
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return pattern.map((value) => value / scale);
}

/** Exact spatial equivalent of the old all-boxes/own.some neighborhood test. */
export function routeNeighborhoodIndex<
  T extends { id: string; x: number; y: number },
>(boxes: T[]) {
  const cells = new Map<string, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i],
      key = `${Math.floor(box.x / 500)}:${Math.floor(box.y / 250)}`;
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  }
  return (own: T[]) => {
    const found = new Set<number>();
    for (const origin of own) {
      const x = Math.floor(origin.x / 500),
        y = Math.floor(origin.y / 250);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const index of cells.get(`${x + dx}:${y + dy}`) ?? []) {
            const box = boxes[index];
            if (
              Math.abs(origin.x - box.x) < 500 &&
              Math.abs(origin.y - box.y) < 250
            )
              found.add(index);
          }
        }
    }
    // Preserve original obstacle order so routing tie breaks remain deterministic.
    return [...found].sort((a, b) => a - b).map((index) => boxes[index]);
  };
}
