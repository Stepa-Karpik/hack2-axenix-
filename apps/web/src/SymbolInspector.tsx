import type { SemanticModel, SourceRange, SymbolReference } from "./types";
import {
  declarationTarget,
  scopedReferences,
  symbolKinds,
  symbolReasons,
} from "./symbols";
export default function SymbolInspector({
  semantics,
  active,
  selected,
  file,
  scope,
  files,
  onSelect,
  onJump,
}: {
  semantics: SemanticModel | null | undefined;
  active: boolean;
  selected: SymbolReference | undefined;
  file: string;
  scope?: SourceRange | null;
  files: Record<string, string>;
  onSelect: (reference: SymbolReference) => void;
  onJump: (range: SourceRange) => void;
}) {
  if (!semantics) return null;
  const scoped = scopedReferences(semantics.references, file, scope);
  const target = declarationTarget(selected, semantics.symbols, files, active);
  const definitions =
    selected?.targetIds
      .slice(0, 5)
      .map((id) => semantics.symbols.find((s) => s.id === id))
      .filter((s) => !!s) ?? [];
  return (
    <section
      className="inspector-section symbol-inspector"
      aria-label="Символы"
    >
      <div className="panel-caption">
        СИМВОЛЫ <span>{active ? scoped.total : "—"}</span>
      </div>
      {!active ? (
        <p className="small quiet" role="status">
          Привязки устарели
        </p>
      ) : (
        <>
          {selected && (
            <div className="symbol-detail" data-reference-id={selected.id}>
              <strong>{selected.name}</strong>
              <span className="small quiet">
                {selected.resolution === "exact"
                  ? selected.kind === "call"
                    ? "Цель вызова"
                    : selected.kind === "constructor"
                      ? "Конструктор"
                      : "Объявление"
                  : selected.resolution === "candidates"
                    ? "Неоднозначная привязка"
                    : "Не разрешено"}
              </span>
              {definitions.map((symbol) => (
                <div
                  className="symbol-target"
                  key={symbol.id}
                  data-symbol-id={symbol.id}
                >
                  <span className="small quiet">
                    {symbolKinds[symbol.kind.toLowerCase()] ?? symbol.kind}
                    {symbol.external ? " · JDK" : ""}
                  </span>
                  <code>
                    {symbol.signature || symbol.qualifiedName || symbol.name}
                  </code>
                  {(symbol.resolvedType || symbol.declaredType) && (
                    <span className="small">
                      Тип: {symbol.resolvedType || symbol.declaredType}
                    </span>
                  )}
                </div>
              ))}
              {!definitions.length && selected.resolvedType && (
                <span className="small">Тип: {selected.resolvedType}</span>
              )}
              {selected.reason && (
                <span className="small quiet">
                  {symbolReasons[selected.reason] ?? "Привязка недоступна"}
                </span>
              )}
              {selected.dispatch === "virtual" && (
                <span className="small quiet">
                  Виртуальный вызов · цель выполнения зависит от объекта
                </span>
              )}
              {selected.dispatch === "unknown" && (
                <span className="small quiet">Цель выполнения неизвестна</span>
              )}
              {target?.sourceRange && (
                <button
                  className="wide subtle"
                  onClick={() => onJump(target.sourceRange!)}
                >
                  К объявлению
                </button>
              )}
            </div>
          )}
          <details className="symbol-usage-list">
            <summary>Использования · {scoped.total}</summary>
            <div className="symbol-reference-list">
              {scoped.rows.map((reference) => (
                <button
                  key={reference.id}
                  className={reference.id === selected?.id ? "active" : ""}
                  onClick={() => onSelect(reference)}
                  data-reference-id={reference.id}
                >
                  <span>{reference.sourceRange.startLine}</span>
                  <code>{reference.name}</code>
                  <span className="symbol-resolution">
                    {reference.resolution === "exact"
                      ? ""
                      : reference.resolution === "candidates"
                        ? "?"
                        : "—"}
                  </span>
                </button>
              ))}
            </div>
            {scoped.total > scoped.rows.length && (
              <p className="small quiet">
                Показано {scoped.rows.length} из {scoped.total}
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
