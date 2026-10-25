import type { Graph, SourceRange } from "./types";
export type SearchHit = {
  id: string;
  file: string;
  title: string;
  detail: string;
  range?: SourceRange;
  nodeId?: string;
  methodId?: string;
  kind: "file" | "method" | "block" | "text";
};
const aliases: Record<string, string> = {
  method_entry: "метод функция method",
  method_exit: "завершение выход",
  condition: "условие проверка if да нет condition",
  loop: "цикл for while do foreach",
  return: "возврат return",
  break: "прервать break",
  continue: "продолжить continue",
  statement: "оператор действие statement",
  call: "вызов метод call",
  variable: "переменная объявление variable",
  throw: "исключение throw",
  catch: "исключение catch",
  finally: "finally завершение",
  switch: "выбор switch case",
};
export function searchProject(
  files: Record<string, string>,
  graph: Graph | null,
  query: string,
): SearchHit[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const hits: (SearchHit & { rank: number })[] = [];
  const add = (hit: SearchHit, rank: number) => hits.push({ ...hit, rank });
  for (const file of Object.keys(files).sort()) {
    if (file.toLocaleLowerCase().includes(q))
      add(
        { id: "file:" + file, file, title: file, detail: "Файл", kind: "file" },
        file.toLocaleLowerCase() === q ? 0 : 3,
      );
  }
  for (const m of graph?.methods ?? []) {
    if (!Object.hasOwn(files, m.sourceRange.filePath)) continue;
    if ((m.signature + " метод функция method").toLocaleLowerCase().includes(q))
      add(
        {
          id: "method:" + m.id,
          file: m.sourceRange.filePath,
          title: m.signature,
          detail: "Метод · " + m.sourceRange.filePath,
          range: m.sourceRange,
          methodId: m.id,
          kind: "method",
        },
        1,
      );
  }
  for (const n of graph?.nodes ?? []) {
    if (
      !n.sourceRange ||
      !Object.hasOwn(files, n.sourceRange.filePath) ||
      n.executionRole === "ast_projection"
    )
      continue;
    const family =
      (
        {
          entry: "method_entry",
          normal_exit: "method_exit",
          IfStmt: "condition",
          ForStmt: "loop",
          ForEachStmt: "loop",
          WhileStmt: "loop",
          DoStmt: "loop",
          for_init: "loop variable",
          for_update: "loop statement",
          foreach_source: "loop",
          foreach_check: "loop condition",
          foreach_bind: "loop variable",
          foreach_advance: "loop continue",
          ExpressionStmt: "statement",
          VariableDeclarationExpr: "variable",
          MethodCallExpr: "call",
        } as Record<string, string>
      )[n.kind] ?? n.kind.toLowerCase();
    const tags = Object.entries(aliases)
      .filter(([key]) => family.includes(key))
      .map(([, v]) => v)
      .join(" ");
    if ((n.label + " " + n.kind + " " + tags).toLocaleLowerCase().includes(q))
      add(
        {
          id: "node:" + n.id,
          file: n.sourceRange.filePath,
          title: n.label,
          detail:
            n.sourceRange.filePath +
            ":" +
            n.sourceRange.startLine +
            " · " +
            n.kind,
          range: n.sourceRange,
          nodeId: n.id,
          methodId: n.methodId,
          kind: "block",
        },
        2,
      );
  }
  // Source search still works while analysis is invalid or the code is a local draft.
  for (const [file, source] of Object.entries(files)) {
    let start = 0,
      line = 1;
    for (const content of source.split("\n")) {
      const col = content.toLocaleLowerCase().indexOf(q);
      if (
        col >= 0 &&
        !hits.some(
          (h) =>
            h.file === file &&
            h.range &&
            h.range.startOffset <= start + col &&
            h.range.endOffset >= start + col + q.length,
        )
      )
        add(
          {
            id: `text:${file}:${start + col}`,
            file,
            title: content.trim(),
            detail: file + ":" + line,
            kind: "text",
            range: {
              filePath: file,
              startOffset: start + col,
              endOffset: start + col + q.length,
              startLine: line,
              endLine: line,
              startColumn: col + 1,
              endColumn: col + q.length + 1,
            },
          },
          4,
        );
      start += content.length + 1;
      line++;
      if (hits.length >= 300) break;
    }
    if (hits.length >= 300) break;
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.detail.localeCompare(b.detail))
    .slice(0, 50)
    .map(({ rank: _, ...hit }) => hit);
}
