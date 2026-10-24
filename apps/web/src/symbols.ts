import type {
  Analysis,
  SourceRange,
  SymbolDefinition,
  SymbolReference,
} from "./types";
export const symbolKinds: Record<string, string> = {
  field: "Поле",
  parameter: "Параметр",
  local: "Локальная переменная",
  local_variable: "Локальная переменная",
  method: "Метод",
  constructor: "Конструктор",
  type: "Тип",
  class: "Класс",
  enum_constant: "Константа",
};
export function currentBindings(
  analysis: Analysis | null,
  revisionId: string | undefined,
  dirty: boolean,
) {
  return (
    !!analysis?.semantics &&
    analysis.revisionId === revisionId &&
    analysis.parseStatus === "valid" &&
    !dirty
  );
}
export function referenceAt(
  references: SymbolReference[],
  file: string,
  offset: number,
) {
  return references
    .filter(
      (r) =>
        r.sourceRange.filePath === file &&
        r.sourceRange.startOffset <= offset &&
        offset < r.sourceRange.endOffset,
    )
    .sort(
      (a, b) =>
        a.sourceRange.endOffset -
        a.sourceRange.startOffset -
        (b.sourceRange.endOffset - b.sourceRange.startOffset),
    )[0];
}
export function scopedReferences(
  references: SymbolReference[],
  file: string,
  scope?: SourceRange | null,
  limit = 20,
) {
  const matches = references.filter(
    (r) =>
      r.sourceRange.filePath === file &&
      (!scope ||
        (r.sourceRange.startOffset >= scope.startOffset &&
          r.sourceRange.endOffset <= scope.endOffset)),
  );
  return { rows: matches.slice(0, limit), total: matches.length };
}
export function declarationTarget(
  reference: SymbolReference | undefined,
  symbols: SymbolDefinition[],
  files: Record<string, string>,
  active: boolean,
) {
  if (
    !active ||
    reference?.resolution !== "exact" ||
    reference.targetIds.length !== 1
  )
    return undefined;
  const target = symbols.find((s) => s.id === reference.targetIds[0]);
  return target &&
    !target.external &&
    target.sourceRange &&
    Object.hasOwn(files, target.sourceRange.filePath)
    ? target
    : undefined;
}

export const symbolReasons: Record<string, string> = {
  ambiguous_overload: "Неоднозначная перегрузка",
  unresolved_symbol: "Символ недоступен",
  unresolved_type: "Тип недоступен",
  unresolved_or_unsupported: "Символ недоступен или не поддерживается",
  unsupported_jdk_runtime: "Версия JDK не поддерживается",
  reserved_source_package: "Зарезервированный пакет Java",
  ambiguous_source_declarations: "Неоднозначные объявления",
  semantic_type_budget: "Лимит анализа типов",
  cyclic_source_inheritance: "Циклическое наследование",
  semantic_symbol_budget: "Лимит анализа символов",
  unsupported_semantic_domain: "Конструкция не поддерживается",
  null_overload_not_proven: "Перегрузка для null не определена",
  out_of_scope_or_before_declaration: "Вне области видимости или до объявления",
};
