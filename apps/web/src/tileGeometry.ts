import type { LayoutNode, Group, Split } from "./workspaceLayout";
import type { DropEdge } from "./workspaceLayout";
export type TileRect = { x: number; y: number; width: number; height: number };
export type Tile = { group: Group; rect: TileRect };
export type Divider = { node: Split; rect: TileRect; parent: TileRect };
export function canDockTile(rect: TileRect, edge: DropEdge) {
  if (edge === "center" || edge === "tabs") return true;
  return edge === "left" || edge === "right"
    ? rect.width >= 368
    : rect.height >= 248;
}
export function tileGeometry(
  root: LayoutNode,
  bounds: TileRect,
  collapsedNavigation = false,
) {
  const tiles: Tile[] = [],
    dividers: Divider[] = [];
  function visit(node: LayoutNode, rect: TileRect) {
    if (node.type === "group") {
      tiles.push({ group: node, rect });
      return;
    }
    const horizontal = node.axis === "horizontal",
      gap = 8;
    const extent = Math.max(0, (horizontal ? rect.width : rect.height) - gap);
    const collapsed = (n: LayoutNode) =>
      collapsedNavigation && n.type === "group" && n.active === "navigation";
    const first =
      !horizontal && collapsed(node.first)
        ? Math.min(40, extent)
        : !horizontal && collapsed(node.second)
          ? Math.max(0, extent - 40)
          : extent * node.ratio;
    visit(node.first, {
      ...rect,
      width: horizontal ? first : rect.width,
      height: horizontal ? rect.height : first,
    });
    dividers.push({
      node,
      parent: rect,
      rect: {
        x: rect.x + (horizontal ? first : 0),
        y: rect.y + (horizontal ? 0 : first),
        width: horizontal ? gap : rect.width,
        height: horizontal ? rect.height : gap,
      },
    });
    visit(node.second, {
      x: rect.x + (horizontal ? first + gap : 0),
      y: rect.y + (horizontal ? 0 : first + gap),
      width: horizontal ? extent - first : rect.width,
      height: horizontal ? rect.height : extent - first,
    });
  }
  visit(root, bounds);
  return { tiles, dividers };
}
export function tileDrop(rect: TileRect, x: number, y: number) {
  const distances = {
    left: x - rect.x,
    right: rect.x + rect.width - x,
    top: y - rect.y,
    bottom: rect.y + rect.height - y,
  };
  const edge = (Object.keys(distances) as (keyof typeof distances)[]).reduce(
    (a, b) => (distances[a] < distances[b] ? a : b),
  );
  return distances[edge] <
    Math.min(48, Math.min(rect.width, rect.height) * 0.22)
    ? edge
    : "center";
}
export function minimumExtent(
  node: LayoutNode,
  axis: "horizontal" | "vertical",
): number {
  if (node.type === "group") return axis === "horizontal" ? 180 : 120;
  const a = minimumExtent(node.first, axis),
    b = minimumExtent(node.second, axis);
  return node.axis === axis ? a + b + 8 : Math.max(a, b);
}
