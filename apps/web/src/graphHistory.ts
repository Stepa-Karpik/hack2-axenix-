export type GraphPosition = { id: string; x: number; y: number };
export function positionsOf(
  nodes: { id: string; position: { x: number; y: number } }[],
): GraphPosition[] {
  return nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
  }));
}
const equal = (a: GraphPosition[], b: GraphPosition[]) =>
  a.length === b.length &&
  a.every(
    (point, index) =>
      point.id === b[index].id &&
      point.x === b[index].x &&
      point.y === b[index].y,
  );
export class GraphHistory {
  private past: GraphPosition[][] = [];
  private future: GraphPosition[][] = [];
  private limit: number;
  constructor(limit = 30) {
    this.limit = limit;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
  commit(before: GraphPosition[], after: GraphPosition[]) {
    if (equal(before, after)) return false;
    this.past.push(before.map((point) => ({ ...point })));
    this.past = this.past.slice(-this.limit);
    this.future = [];
    return true;
  }
  undo(current: GraphPosition[]) {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(current.map((point) => ({ ...point })));
    return previous;
  }
  redo(current: GraphPosition[]) {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current.map((point) => ({ ...point })));
    return next;
  }
}
export function graphHistoryShortcut(
  event: Pick<
    KeyboardEvent,
    "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key" | "code"
  >,
): "undo" | "redo" | null {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    !(event.code === "KeyZ" || ["z", "я"].includes(event.key.toLowerCase()))
  )
    return null;
  return event.shiftKey ? "redo" : "undo";
}
