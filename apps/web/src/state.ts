import type { GraphNode } from "./types";

export function operationAnchor(
  node: GraphNode,
  nodes: GraphNode[],
  operation: string,
): GraphNode | null {
  if (node.allowedOperations?.includes(operation)) return node;
  if (node.kind !== "condition_test") return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set([node.id]);
  let parent = node.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const candidate = byId.get(parent);
    if (
      !candidate ||
      candidate.methodId !== node.methodId ||
      candidate.analysisId !== node.analysisId ||
      candidate.revisionId !== node.revisionId
    )
      return null;
    if (
      candidate.allowedOperations?.includes(operation) &&
      (operation !== "replace_expression" ||
        candidate.editableFields?.includes("condition"))
    )
      return candidate;
    parent = candidate.parentId;
  }
  return null;
}

export interface Draft {
  baseRevisionId: string;
  files: Record<string, string>;
  directories?: string[];
}
export function draftKey(projectId: string) {
  return "java-blueprints:draft:" + projectId;
}
export function hasChanges(
  files: Record<string, string>,
  original: Record<string, string>,
) {
  return (
    Object.keys(files).length !== Object.keys(original).length ||
    Object.entries(files).some(([path, text]) => original[path] !== text)
  );
}
export function canApply(
  status: string,
  base: string,
  head: string | null,
  intent: string,
  matched: boolean,
) {
  return (
    status === "ready" &&
    base === head &&
    (intent === "semantic_edit" || matched)
  );
}
export function nodeAtOffset<
  T extends {
    sourceRange: {
      filePath: string;
      startOffset: number;
      endOffset: number;
    } | null;
  },
>(nodes: T[], file: string, offset: number) {
  return nodes
    .filter(
      (n) =>
        n.sourceRange?.filePath === file &&
        n.sourceRange.startOffset <= offset &&
        n.sourceRange.endOffset > offset,
    )
    .sort(
      (a, b) =>
        a.sourceRange!.endOffset -
        a.sourceRange!.startOffset -
        (b.sourceRange!.endOffset - b.sourceRange!.startOffset),
    )[0];
}

export const operationLabels: Record<string, string> = {
  replace_expression: "Изменить выражение",
  replace_statement: "Редактировать блок",
  insert_statement: "Вставить оператор",
  delete_statement: "Удалить оператор",
  move_statement: "Переместить оператор",
  wrap_if: "Обернуть в if",
  wrap_while: "Обернуть в while",
  add_else: "Добавить ветку else",
  remove_else: "Удалить ветку else",
};

export function nodeOperations(node: { allowedOperations?: string[] } | null) {
  return (node?.allowedOperations ?? []).filter((op) =>
    Object.hasOwn(operationLabels, op),
  );
}

export const statementTemplates: Record<string, string> = {
  statement: 'System.out.println("value");',
  condition: 'if (true) {\n    System.out.println("value");\n}',
  loop: "for (int index = 0; index < 1; index++) {\n    System.out.println(index);\n}",
};
