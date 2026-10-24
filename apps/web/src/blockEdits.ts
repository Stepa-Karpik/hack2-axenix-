import type { Graph, GraphNode } from "./types";

export type MovePosition = "before" | "after";
export interface BlockEditFields {
  position: string;
  statement: string;
  expression: string;
  condition: string;
  elseSource: string;
  targetNodeId: string;
  movePosition: string;
}

export function moveTargets(node: GraphNode | null, graph: Graph | null) {
  if (
    !node?.sourceRange ||
    !node.parentId ||
    !node.allowedOperations?.includes("move_statement") ||
    graph?.analysisId !== node.analysisId ||
    graph.revisionId !== node.revisionId
  )
    return [];
  return graph.nodes
    .filter(
      (target) =>
        target.id !== node.id &&
        target.parentId === node.parentId &&
        target.analysisId === node.analysisId &&
        target.revisionId === node.revisionId &&
        target.methodId === node.methodId &&
        !target.synthetic &&
        target.sourceRange?.filePath === node.sourceRange!.filePath &&
        target.allowedOperations?.includes("move_statement") &&
        target.insertionPositions?.some((p) => p === "before" || p === "after"),
    )
    .sort((a, b) => a.sourceRange!.startOffset - b.sourceRange!.startOffset);
}

export function movePositions(
  node: GraphNode,
  target: GraphNode,
  graph: Graph,
) {
  const siblings = [node, ...moveTargets(node, graph)].sort(
    (a, b) => a.sourceRange!.startOffset - b.sourceRange!.startOffset,
  );
  const from = siblings.findIndex((n) => n.id === node.id);
  const to = siblings.findIndex((n) => n.id === target.id);
  if (to < 0) return [];
  return (["before", "after"] as MovePosition[]).filter(
    (position) =>
      target.insertionPositions?.includes(position) &&
      !(position === "before" && to === from + 1) &&
      !(position === "after" && to === from - 1),
  );
}

export function blockEditPayload(
  node: GraphNode | null,
  graph: Graph | null,
  operation: string,
  fields: BlockEditFields,
): Record<string, string> | null {
  if (
    !node ||
    !graph ||
    node.analysisId !== graph.analysisId ||
    node.revisionId !== graph.revisionId ||
    !graph.nodes.some((n) => n.id === node.id) ||
    !node.allowedOperations?.includes(operation)
  )
    return null;
  switch (operation) {
    case "delete_statement":
    case "remove_else":
      return {};
    case "replace_expression": {
      const field = node.editableFields[0];
      return field &&
        fields.expression.trim() &&
        (node.editableFieldRanges?.[field] ||
          (field === "expression" && node.sourceRange))
        ? { field, source: fields.expression }
        : null;
    }
    case "replace_statement":
      return fields.statement.trim() ? { source: fields.statement } : null;
    case "insert_statement":
      return node.insertionPositions?.includes(fields.position) &&
        fields.statement.trim()
        ? { position: fields.position, source: fields.statement }
        : null;
    case "move_statement": {
      const target = moveTargets(node, graph).find(
        (n) => n.id === fields.targetNodeId,
      );
      return target &&
        movePositions(node, target, graph).includes(
          fields.movePosition as MovePosition,
        )
        ? { targetNodeId: target.id, position: fields.movePosition }
        : null;
    }
    case "wrap_if":
    case "wrap_while":
      return fields.condition.trim() ? { condition: fields.condition } : null;
    case "add_else":
      return fields.elseSource.trim().startsWith("{") &&
        fields.elseSource.trim().endsWith("}")
        ? { source: fields.elseSource }
        : null;
    default:
      return null;
  }
}
