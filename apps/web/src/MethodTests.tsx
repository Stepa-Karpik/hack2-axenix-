import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import Select from "./Select";
import { methodReturnText } from "./methodResultView";
import "./methodTests.css";

type Target = {
  ownerType: string;
  methodName: string;
  parameterTypes: string[];
  returnType: string;
  filePath: string;
  startLine: number;
  signature: string;
  supported: boolean;
  reason: string | null;
  receiver?: "static" | "fresh_no_arg_instance";
};
export interface MethodTestsProps {
  projectId: string;
  revisionId: string;
  candidateRevisionId?: string;
  selectedMethod?: {
    sourceRange?: { filePath: string; startLine: number };
    signature?: string;
  };
  onReport?: (report: any) => void;
  onClose?: () => void;
}
const reasons: Record<string, string> = {
  owner_not_public: "Нужен public класс",
  method_not_public: "Пока доступны public методы",
  method_private: "private метод недоступен из пакета теста",
  instance_method_unsupported:
    "Метод экземпляра: создание объекта пока не поддержано",
  receiver_constructor_unsupported:
    "Метод экземпляра: нужен доступный конструктор без параметров и не abstract класс",
  abstract_method_unsupported: "Абстрактный метод нельзя вызвать",
  generic_method_unsupported: "Обобщённые методы пока не поддержаны",
  varargs_unsupported: "Varargs пока не поддержаны",
  type_adapter_unsupported:
    "Поддержаны примитивы, обёртки, String, массивы, List/Set/Map/Optional из java.util и Scanner",
  interface_owner_unsupported: "Методы интерфейса пока не поддержаны",
};
// JSON shapes: collections and Map ([key,value] pairs) are arrays,
// Optional is {"present":bool,"value":...}, Scanner is its input text.
const rawType = (t: string) =>
  t.replace(/<.*$/, "").replace(/^java\.(lang|util)\./, "");
function sampleArgument(t: string): unknown {
  const raw = rawType(t);
  if (
    t.endsWith("[]") ||
    /^(List|ArrayList|LinkedList|Collection|Set|HashSet|LinkedHashSet|TreeSet|SortedSet|NavigableSet|Queue|Deque|ArrayDeque|Map|HashMap|LinkedHashMap|TreeMap|SortedMap|NavigableMap)$/.test(
      raw,
    )
  )
    return [];
  if (raw === "Optional") return { present: false };
  if (raw === "String" || raw === "Scanner") return "";
  if (raw === "char" || raw === "Character") return "a";
  if (raw === "boolean" || raw === "Boolean") return false;
  return 0;
}
function sampleReturn(t: string): unknown {
  return t === "void" || t === "String" ? null : sampleArgument(t);
}
export default function MethodTests({
  projectId,
  revisionId,
  candidateRevisionId,
  selectedMethod,
  onReport,
  onClose,
}: MethodTestsProps) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState("");
  const [raw, setRaw] = useState(
    '[\n  {"id":"case-1","arguments":[],"expectedReturn":null}\n]',
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [report, setReport] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  const [jobId, setJobId] = useState("");
  const epoch = useRef(0);
  const activeJob = useRef<{ base: string; id: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    epoch.current++;
    setBusy(false);
    setJobId("");
    setExpanded(false);
    setTargets([]);
    setSelected("");
    setError("");
    setReport(null);
    api<{ targets: Target[] }>(
      `/projects/${projectId}/revisions/${revisionId}/method-targets`,
      { signal: controller.signal },
    )
      .then((result) => {
        setTargets(result.targets);
        const signature = selectedMethod?.signature
          ?.replace(/\s+/g, "")
          .replaceAll("java.lang.String", "String");
        const candidates = result.targets.filter(
          (t) =>
            t.filePath === selectedMethod?.sourceRange?.filePath &&
            t.startLine === selectedMethod?.sourceRange?.startLine &&
            (!signature ||
              `${t.methodName}(${t.parameterTypes.join(",")})` === signature),
        );
        const chosen = selectedMethod
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : (result.targets.find((t) => t.supported) ?? result.targets[0]);
        if (selectedMethod && !chosen)
          setError(
            "Не удалось однозначно сопоставить выбранное объявление. Выберите точную перегрузку в списке.",
          );
        if (chosen) {
          setSelected(
            JSON.stringify([
              chosen.ownerType,
              chosen.methodName,
              chosen.parameterTypes,
            ]),
          );
          const args = chosen.parameterTypes.map(sampleArgument);
          setRaw(
            JSON.stringify(
              [
                {
                  id: "case-1",
                  arguments: args,
                  expectedReturn: sampleReturn(chosen.returnType),
                },
              ],
              null,
              2,
            ),
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      epoch.current++;
      const job = activeJob.current;
      activeJob.current = null;
      if (job)
        void api(job.base + "/jobs/" + job.id + "/cancel", {
          method: "POST",
          body: {},
        }).catch(() => {});
    };
  }, [
    projectId,
    revisionId,
    selectedMethod?.sourceRange?.filePath,
    selectedMethod?.sourceRange?.startLine,
  ]);
  const target = targets.find(
    (t) =>
      JSON.stringify([t.ownerType, t.methodName, t.parameterTypes]) ===
      selected,
  );
  async function run() {
    if (!target?.supported || busy) return;
    setError("");
    setReport(null);
    setBusy(true);
    setExpanded(false);
    const runEpoch = epoch.current;
    // Capture immutable bindings before any asynchronous work. Later editor changes cannot retarget this run.
    const base = `/projects/${projectId}`,
      source = revisionId,
      candidate = candidateRevisionId ?? revisionId;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100)
        throw new Error("Укажите от 1 до 100 тестов");
      const cases = parsed.map((row: any, index: number) => {
        if (
          !Array.isArray(row.arguments) ||
          row.arguments.length !== target.parameterTypes.length
        )
          throw new Error(`Тест ${index + 1}: неверное количество аргументов`);
        let expected = row.expectedMethodResult;
        if (!expected && Object.hasOwn(row, "expectedReturn"))
          expected = {
            complete: true,
            completion: "return",
            returnValue: row.expectedReturn,
            exception: null,
            argumentsAfter: row.expectedArgumentsAfter ?? row.arguments,
          };
        if (!expected && row.expectedException)
          expected = {
            complete: true,
            completion: "throw",
            returnValue: null,
            exception: row.expectedException,
            argumentsAfter: row.expectedArgumentsAfter ?? row.arguments,
          };
        if (!expected)
          throw new Error(
            `Тест ${index + 1}: задайте expectedReturn или expectedException`,
          );
        return {
          id: row.id ?? `case-${index + 1}`,
          arguments: row.arguments,
          expectedMethodResult: expected,
          expectedStdout: row.expectedStdout ?? "",
          expectedStderr: row.expectedStderr ?? "",
        };
      });
      setProgress("Подготовка набора тестов…");
      const suite = await api<{ id: string }>(base + "/test-suites", {
        method: "POST",
        body: {
          mode: "method",
          comparisonPolicyId: "method-v1",
          revisionId: source,
          target: {
            ownerType: target.ownerType,
            methodName: target.methodName,
            parameterTypes: target.parameterTypes,
          },
          cases,
        },
      });
      const job = await api<{ id: string }>(base + "/comparisons", {
        method: "POST",
        body: {
          baseRevisionId: source,
          candidateRevisionId: candidate,
          suiteVersionId: suite.id,
          profileId: "java21-v1",
        },
      });
      if (epoch.current !== runEpoch) {
        void api(base + "/jobs/" + job.id + "/cancel", {
          method: "POST",
          body: {},
        }).catch(() => {});
        return;
      }
      activeJob.current = { base, id: job.id };
      setJobId(job.id);
      const deadline = Date.now() + 600000;
      for (;;) {
        const current = await api<any>(base + "/jobs/" + job.id);
        if (epoch.current !== runEpoch) return;
        setProgress(
          `Проверка метода: ${current.progress?.completed ?? 0}/${cases.length}, ${current.status}`,
        );
        if (["failed", "cancelled"].includes(current.status))
          throw new Error(current.error?.message ?? "Проверка не завершена");
        if (current.status === "succeeded") {
          const result =
            current.result.report ??
            (await api<any>(
              base + "/comparisons/" + current.result.comparisonId,
            ));
          setReport(result);
          onReport?.(result);
          break;
        }
        if (Date.now() > deadline)
          throw new Error(
            "Проверка ещё выполняется. Её immutable job сохранён на сервере",
          );
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } catch (e) {
      if (epoch.current === runEpoch)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch.current === runEpoch) {
        setBusy(false);
        setJobId("");
        activeJob.current = null;
      }
    }
  }
  async function stop() {
    const job = activeJob.current;
    if (job) {
      setProgress("Остановка проверки…");
      try {
        await api(job.base + "/jobs/" + job.id + "/cancel", {
          method: "POST",
          body: {},
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return (
    <section
      className="method-tests"
      aria-label="Тестирование отдельного метода"
    >
      <header>
        <h2>Тест метода</h2>
        {onClose && (
          <button onClick={onClose} aria-label="Закрыть тесты метода">
            ×
          </button>
        )}
      </header>
      <p>
        Вызов выбранного метода в изолированной Java 21. Точка main не
        требуется. Каждый вход — 3 запуска на версию.
      </p>
      <label>
        Метод
        <Select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy}
        >
          <option value="">Выберите точную перегрузку</option>
          {targets.map((t) => (
            <option
              key={JSON.stringify([
                t.ownerType,
                t.methodName,
                t.parameterTypes,
              ])}
              value={JSON.stringify([
                t.ownerType,
                t.methodName,
                t.parameterTypes,
              ])}
            >
              {t.ownerType}.{t.methodName}({t.parameterTypes.join(", ")})
              {t.supported ? "" : " — недоступен"}
            </option>
          ))}
        </Select>
      </label>
      {target && !target.supported && (
        <p role="status">{reasons[target.reason ?? ""] ?? target.reason}</p>
      )}
      {target?.supported && target.receiver === "fresh_no_arg_instance" && (
        <p data-method-receiver="fresh">
          Метод экземпляра: для каждого теста создаётся новый объект{" "}
          {target.ownerType}(). Поля объекта после вызова не сравниваются;
          ошибка конструктора даёт неполный результат.
        </p>
      )}
      <p>
        JSON: arguments — значения параметров, expectedReturn — ожидаемый
        результат. Для исключения: expectedException с type, message, cause и
        suppressed. Мутации массивов: expectedArgumentsAfter. Большие long в
        аргументах и ожидаемых значениях задавайте десятичной строкой.
      </p>
      <label>
        Тесты метода JSON
        <textarea
          rows={13}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
          disabled={busy}
        />
      </label>
      <small>
        Версия {revisionId}.{" "}
        {candidateRevisionId
          ? "Сравнение двух указанных версий"
          : "Текущая версия проверяется против заданных ожиданий; это не проверка преобразования"}
        . Stack trace не входит в семантическое исключение; stdout/stderr
        сравниваются точно.
      </small>
      <button onClick={run} disabled={busy || !target?.supported}>
        {busy ? "Выполняется…" : "Запустить тесты метода"}
      </button>
      {busy && (
        <button onClick={stop} disabled={!jobId}>
          Остановить проверку метода
        </button>
      )}
      {busy && <p role="status">{progress}</p>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <div aria-label="Результат тестов метода">
          <strong>
            {report.outcome === "matched_on_tests"
              ? `Совпало на ${report.matched} входах, 3 повтора на версию`
              : report.outcome}
          </strong>
          <ul>
            {report.testResults?.map((row: any) => {
              const execution = row.baseExecutions?.[0],
                observed = execution?.methodResult;
              return (
                <li key={row.caseId}>
                  <b>{row.caseId}: </b>
                  {row.verdict === "matched"
                    ? "совпало"
                    : row.verdict === "mismatch"
                      ? "различие"
                      : "проверка неполна"}
                  {observed && (
                    <span>
                      {" "}
                      ·{" "}
                      {observed.completion === "throw"
                        ? `${observed.exception?.type}: ${observed.exception?.message ?? ""}`
                        : `Результат: ${methodReturnText(execution.methodResultRaw, observed.returnValue).slice(0, 300)}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
            <summary>Подробный отчёт и наблюдения</summary>
            {expanded && (
              <pre>
                {JSON.stringify(
                  {
                    version: report.baseRevisionId,
                    target: report.methodTarget,
                    testResults: report.testResults,
                    reasons: report.inconclusiveReasons,
                  },
                  null,
                  2,
                )}
              </pre>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
