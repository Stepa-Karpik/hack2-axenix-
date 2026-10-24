import { useEffect, useId, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  newCase,
  oracleExit,
  parseCases,
  withOracleExit,
  writeCases,
  type EditableCase,
} from "./testCases";

const validCode = (text: string) =>
  /^[+-]?\d+$/.test(text) &&
  Number(text) >= -2147483648 &&
  Number(text) <= 2147483647;
function draftError(
  cases: EditableCase[] | null,
  drafts: Record<string, string>,
) {
  const index =
    cases?.findIndex(
      (test) =>
        oracleExit(test) !== null &&
        drafts[test.id] !== undefined &&
        !validCode(drafts[test.id]),
    ) ?? -1;
  return index < 0
    ? null
    : `Тест ${index + 1}: укажите целый код завершения от −2147483648 до 2147483647`;
}
export default function TestCasesEditor({
  raw,
  onChange,
  onValidityChange,
}: {
  raw: string;
  onChange: (raw: string) => void;
  onValidityChange: (error: string | null) => void;
}) {
  const parsed = useMemo(() => parseCases(raw), [raw]);
  const [mode, setMode] = useState<"form" | "json">(() =>
    parseCases(raw).cases ? "form" : "json",
  );
  const [selectedId, setSelectedId] = useState("");
  const [codeDrafts, setCodeDrafts] = useState<Record<string, string>>({});
  const prefix = useId();
  const selected =
    parsed.cases?.find((test) => test.id === selectedId) ?? parsed.cases?.[0];
  const codeError = draftError(parsed.cases, codeDrafts);
  const error = parsed.error ?? codeError;
  useEffect(() => onValidityChange(error), [error, onValidityChange]);
  function emit(cases: EditableCase[], drafts = codeDrafts) {
    const text = writeCases(cases);
    onChange(text);
    onValidityChange(parseCases(text).error ?? draftError(cases, drafts));
  }
  function replace(next: EditableCase, drafts = codeDrafts) {
    if (parsed.cases)
      emit(
        parsed.cases.map((test) => (test.id === next.id ? next : test)),
        drafts,
      );
  }
  function patch(values: Partial<EditableCase>) {
    if (selected) replace({ ...selected, ...values });
  }
  function toggleText(
    key: "expectedStdout" | "expectedStderr",
    enabled: boolean,
  ) {
    if (!selected) return;
    const next = { ...selected };
    if (enabled) next[key] = "";
    else delete next[key];
    replace(next);
    if (enabled)
      requestAnimationFrame(() =>
        document
          .getElementById(field(key === "expectedStdout" ? "stdout" : "stderr"))
          ?.focus(),
      );
  }
  function toggleExit(enabled: boolean) {
    if (!selected) return;
    const drafts = { ...codeDrafts };
    delete drafts[selected.id];
    setCodeDrafts(drafts);
    replace(withOracleExit(selected, enabled ? 0 : null), drafts);
    if (enabled)
      requestAnimationFrame(() => {
        const input = document.getElementById(
          field("exit"),
        ) as HTMLInputElement | null;
        input?.focus();
        input?.select();
      });
  }
  const field = (key: string) => `${prefix}-${selected?.id ?? "empty"}-${key}`;
  return (
    <section className="cases-editor" aria-label="Редактор тестов">
      <div className="cases-toolbar">
        <strong>Тесты {parsed.cases?.length ?? ""}</strong>
        <div role="group" aria-label="Вид редактора тестов">
          <button
            type="button"
            aria-pressed={mode === "form"}
            disabled={!parsed.cases}
            onClick={() => setMode("form")}
          >
            Форма
          </button>
          <button
            type="button"
            aria-pressed={mode === "json"}
            disabled={!!codeError}
            onClick={() => setMode("json")}
          >
            JSON
          </button>
        </div>
      </div>
      {error && (
        <p className="cases-error" role="alert">
          {error}
        </p>
      )}
      {mode === "json" || !parsed.cases ? (
        <div className="cases-json">
          <label htmlFor={`${prefix}-json`}>Входные данные · JSON cases</label>
          <textarea
            id={`${prefix}-json`}
            rows={10}
            value={raw}
            spellCheck={false}
            onChange={(event) => {
              setCodeDrafts({});
              onChange(event.target.value);
              onValidityChange(parseCases(event.target.value).error);
            }}
          />
        </div>
      ) : (
        <div className="cases-form">
          <div className="cases-list" aria-label="Тестовые входы">
            {parsed.cases.map((test, index) => (
              <div className="case-list-row" key={test.id}>
                <button
                  type="button"
                  className={selected?.id === test.id ? "active" : ""}
                  aria-pressed={selected?.id === test.id}
                  onClick={() => setSelectedId(test.id)}
                >
                  <span>{index + 1}</span>
                  <span>
                    {test.name?.trim() ? test.name : `Тест ${index + 1}`}
                  </span>
                </button>
                <button
                  type="button"
                  className="case-delete"
                  aria-label={`Удалить тест ${index + 1}`}
                  title="Удалить тест"
                  onClick={() => {
                    const next = parsed.cases!.filter(
                      (item) => item.id !== test.id,
                    );
                    const drafts = { ...codeDrafts };
                    delete drafts[test.id];
                    setCodeDrafts(drafts);
                    if (selected?.id === test.id)
                      setSelectedId(next[0]?.id ?? "");
                    emit(next, drafts);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="case-add"
              disabled={parsed.cases.length >= 100}
              onClick={() => {
                const made = newCase(
                  "case-" + crypto.randomUUID(),
                  `Тест ${parsed.cases!.length + 1}`,
                );
                emit([...parsed.cases!, made]);
                setSelectedId(made.id);
              }}
            >
              <Plus size={14} />
              Добавить тест
            </button>
          </div>
          {selected && (
            <div
              className="case-fields"
              role="group"
              aria-label="Параметры теста"
            >
              <label htmlFor={field("name")}>Название теста</label>
              <input
                id={field("name")}
                value={selected.name ?? ""}
                onChange={(event) => patch({ name: event.target.value })}
              />
              <label htmlFor={field("stdin")}>Ввод (stdin)</label>
              <textarea
                id={field("stdin")}
                rows={3}
                spellCheck={false}
                value={selected.stdinUtf8 ?? ""}
                onChange={(event) => patch({ stdinUtf8: event.target.value })}
              />
              <div className="case-args">
                {(selected.argv ?? []).map((arg, index) => (
                  <div className="case-arg" key={index}>
                    <label className="sr-only" htmlFor={field("arg-" + index)}>
                      Аргумент {index + 1}
                    </label>
                    <textarea
                      id={field("arg-" + index)}
                      rows={1}
                      value={arg}
                      placeholder="Пустая строка"
                      onChange={(event) =>
                        patch({
                          argv: selected.argv!.map((value, i) =>
                            i === index ? event.target.value : value,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Удалить аргумент ${index + 1}`}
                      onClick={() =>
                        patch({
                          argv: selected.argv!.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="subtle"
                  disabled={(selected.argv?.length ?? 0) >= 100}
                  onClick={() =>
                    patch({ argv: [...(selected.argv ?? []), ""] })
                  }
                >
                  <Plus size={13} />
                  Добавить аргумент
                </button>
              </div>
              <fieldset className="case-oracle">
                <legend>Ожидаемый результат</legend>
                <label className="oracle-toggle">
                  <input
                    type="checkbox"
                    checked={typeof selected.expectedStdout === "string"}
                    onChange={(event) =>
                      toggleText("expectedStdout", event.target.checked)
                    }
                  />
                  Вывод (stdout)
                </label>
                {typeof selected.expectedStdout === "string" && (
                  <>
                    <label className="sr-only" htmlFor={field("stdout")}>
                      Ожидаемый stdout
                    </label>
                    <textarea
                      id={field("stdout")}
                      rows={3}
                      spellCheck={false}
                      value={selected.expectedStdout}
                      onChange={(event) =>
                        patch({ expectedStdout: event.target.value })
                      }
                    />
                  </>
                )}
                <label className="oracle-toggle">
                  <input
                    type="checkbox"
                    checked={typeof selected.expectedStderr === "string"}
                    onChange={(event) =>
                      toggleText("expectedStderr", event.target.checked)
                    }
                  />
                  Ошибки (stderr)
                </label>
                {typeof selected.expectedStderr === "string" && (
                  <>
                    <label className="sr-only" htmlFor={field("stderr")}>
                      Ожидаемый stderr
                    </label>
                    <textarea
                      id={field("stderr")}
                      rows={2}
                      spellCheck={false}
                      value={selected.expectedStderr}
                      onChange={(event) =>
                        patch({ expectedStderr: event.target.value })
                      }
                    />
                  </>
                )}
                <label className="oracle-toggle">
                  <input
                    type="checkbox"
                    checked={oracleExit(selected) !== null}
                    onChange={(event) => toggleExit(event.target.checked)}
                  />
                  Код завершения
                </label>
                {oracleExit(selected) !== null && (
                  <>
                    <label className="sr-only" htmlFor={field("exit")}>
                      Ожидаемый код завершения
                    </label>
                    <input
                      id={field("exit")}
                      inputMode="numeric"
                      value={
                        codeDrafts[selected.id] ?? String(oracleExit(selected))
                      }
                      aria-invalid={
                        codeDrafts[selected.id] !== undefined &&
                        !validCode(codeDrafts[selected.id])
                      }
                      onChange={(event) => {
                        const text = event.target.value,
                          drafts = { ...codeDrafts, [selected.id]: text };
                        setCodeDrafts(drafts);
                        if (validCode(text))
                          replace(
                            withOracleExit(selected, Number(text)),
                            drafts,
                          );
                        else
                          onValidityChange(
                            parsed.error ?? draftError(parsed.cases, drafts),
                          );
                      }}
                    />
                  </>
                )}
              </fieldset>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
