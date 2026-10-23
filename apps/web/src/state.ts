export interface Draft {
  baseRevisionId: string;
  files: Record<string, string>;
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
