import type { Graph, GraphNode } from "./types";

const reserved = new Set(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _ var yield record sealed permits".split(
    " ",
  ),
);
export function validMethodName(name: string) {
  return (
    name.length <= 100 &&
    name !== "when" &&
    /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(name) &&
    !reserved.has(name)
  );
}
export function validClassName(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(name) && validMethodName(name);
}
export function extractionTargets(
  start: GraphNode | null,
  graph: Graph | null,
) {
  if (
    !start?.sourceRange ||
    !start.parentId ||
    start.synthetic ||
    start.analysisId !== graph?.analysisId ||
    start.revisionId !== graph.revisionId ||
    !graph.nodes.some((n) => n.id === start.id) ||
    !start.allowedOperations?.includes("extract_method")
  )
    return [];
  return graph.nodes
    .filter(
      (n) =>
        !n.synthetic &&
        n.parentId === start.parentId &&
        n.methodId === start.methodId &&
        n.analysisId === start.analysisId &&
        n.revisionId === start.revisionId &&
        n.sourceRange?.filePath === start.sourceRange!.filePath &&
        n.sourceRange.startOffset >= start.sourceRange!.startOffset &&
        n.allowedOperations?.includes("extract_method"),
    )
    .sort((a, b) => a.sourceRange!.startOffset - b.sourceRange!.startOffset);
}
// Offsets resolve immutable graph anchors locally; API commands contain node IDs.
export function extractionFromSelection(
  graph: Graph | null,
  file: string,
  source: string,
  startOffset: number,
  endOffset: number,
) {
  if (
    !graph ||
    startOffset < 0 ||
    endOffset > source.length ||
    startOffset >= endOffset
  )
    return null;
  while (startOffset < endOffset && /\s/.test(source[startOffset]))
    startOffset++;
  while (endOffset > startOffset && /\s/.test(source[endOffset - 1]))
    endOffset--;
  const starts = graph.nodes.filter(
    (n) =>
      n.sourceRange?.filePath === file &&
      n.sourceRange.startOffset === startOffset &&
      n.allowedOperations?.includes("extract_method"),
  );
  for (const start of starts) {
    const end = extractionTargets(start, graph).find(
      (n) => n.sourceRange!.endOffset === endOffset,
    );
    if (end) return { start, end };
  }
  return null;
}
