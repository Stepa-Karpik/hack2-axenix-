import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Info } from "lucide-react";
import type { Analysis, SourceRange } from "./types";

const tabs = [
  ["node", "Узел"],
  ["problems", "Проблемы"],
  ["recommendations", "Рекомендации"],
  ["metrics", "Метрики"],
] as const;
type Tab = (typeof tabs)[number][0];

export default function CodeInsights({
  analysis,
  methodId,
  file,
  focusKey,
  current,
  children,
  onNavigate,
  onOptimize,
  optimizationEnabled,
}: {
  analysis: Analysis | null;
  methodId: string;
  file: string;
  focusKey: number;
  current: boolean;
  children: ReactNode;
  onNavigate: (range: SourceRange, methodId?: string) => void;
  onOptimize: (nodeId: string) => void;
  optimizationEnabled: boolean;
}) {
  const [tab, setTab] = useState<Tab>("node");
  const id = useId();
  const quality = analysis?.quality;
  const metric = quality?.methods.find((m) => m.methodId === methodId);
  const method = analysis?.graph?.methods.find((m) => m.id === methodId);
  const diagnostics = (analysis?.diagnostics ?? []).filter(
    (item) => !item.sourceRange || item.sourceRange.filePath === file,
  );
  const optimizations = (analysis?.optimizations ?? []).filter(
    (item) => item.sourceRange.filePath === file,
  );
  const findings = (quality?.findings ?? []).filter(
    (item) => item.sourceRange.filePath === file,
  );
  useEffect(() => {
    if (focusKey > 0) setTab("node");
  }, [focusKey]);
  useEffect(() => {
    if (analysis?.parseStatus === "invalid") setTab("problems");
  }, [analysis?.id]);
  const count = (key: Tab) =>
    key === "problems"
      ? diagnostics.length
      : key === "recommendations"
        ? findings.length + optimizations.length
        : 0;
  return (
    <div className="code-insights" data-source-file={file}>
      <div className="small quiet" title={file}>
        {file || "Выберите файл"}
      </div>
      <div className="insight-tabs" role="tablist" aria-label="Раздел анализа">
        {tabs.map(([key, label], index) => (
          <button
            key={key}
            type="button"
            id={`${id}-tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`${id}-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            title={key === "recommendations" ? "Рекомендации" : label}
            onClick={() => setTab(key)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft")
                next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              setTab(tabs[next][0]);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
          >
            {label}
            {count(key) > 0 && (
              <span className="insight-count">{count(key)}</span>
            )}
          </button>
        ))}
      </div>
      {!current && analysis && tab !== "node" && (
        <p className="insight-stale" role="status">
          Показан сохранённый анализ
        </p>
      )}
      <div
        role="tabpanel"
        id={`${id}-panel-node`}
        className="insight-node"
        aria-labelledby={`${id}-tab-node`}
        hidden={tab !== "node"}
      >
        {children}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-problems`}
        aria-labelledby={`${id}-tab-problems`}
        hidden={tab !== "problems"}
      >
        <div className="analysis-diagnostics">
          {!analysis ? (
            <p className="insight-empty">Анализ ещё не готов</p>
          ) : diagnostics.length === 0 ? (
            <p className="insight-empty">
              <Check size={16} /> Синтаксис проверен
            </p>
          ) : (
            diagnostics.map((d) => (
              <button
                className="diagnostic"
                key={d.id}
                disabled={!current || !d.sourceRange}
                onClick={() => d.sourceRange && onNavigate(d.sourceRange)}
              >
                <span className="diagnostic-symbol">
                  {d.severity === "error" ? "!" : "△"}
                </span>
                <span>
                  {d.code === "UNSUPPORTED_CONTROL_FLOW"
                    ? "Для этого метода пока недоступны точная схема потока и правки блоками. Код сохранён."
                    : d.message}
                </span>
                <code>
                  {d.sourceRange
                    ? `${d.sourceRange.filePath}:${d.sourceRange.startLine}`
                    : d.code}
                </code>
              </button>
            ))
          )}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-recommendations`}
        aria-labelledby={`${id}-tab-recommendations`}
        hidden={tab !== "recommendations"}
      >
        {!quality ? (
          <p className="insight-empty">Нужен актуальный анализ</p>
        ) : findings.length === 0 && optimizations.length === 0 ? (
          <p className="insight-empty">
            <Check size={16} /> Рекомендаций нет
          </p>
        ) : (
          <>
            <div className="insight-findings">
              {optimizations.map((op) => (
                <article
                  className="insight-finding"
                  key={op.nodeId}
                  data-optimization={op.ruleId}
                >
                  <button
                    className="finding-location"
                    disabled={!current}
                    onClick={() => onNavigate(op.sourceRange, op.methodId)}
                    title="Перейти к коду"
                  >
                    <Info size={14} />
                    <strong>Повторный поиск в списке</strong>
                    <ArrowUpRight size={14} />
                  </button>
                  <code className="finding-source">
                    {op.sourceRange.filePath}:{op.sourceRange.startLine} ·{" "}
                    {op.receiverName}
                  </code>
                  <p className="small quiet">
                    Мест поиска в цикле: {op.querySites}
                  </p>
                  <button
                    className="subtle optimization-open"
                    disabled={!current || !optimizationEnabled}
                    onClick={() => onOptimize(op.nodeId)}
                  >
                    Открыть изменение
                  </button>
                </article>
              ))}
              {findings.map((f) => (
                <article
                  className="insight-finding"
                  key={f.id}
                  data-finding-code={f.code}
                >
                  <button
                    className="finding-location"
                    disabled={!current}
                    onClick={() => onNavigate(f.sourceRange, f.methodId)}
                    title="Перейти к коду"
                  >
                    <Info size={14} />
                    <strong>{f.title}</strong>
                    <span>
                      {f.observed} ≥ {f.threshold}
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                  <code className="finding-source">
                    {f.sourceRange.filePath}:{f.sourceRange.startLine}
                  </code>
                  <details>
                    <summary>Рекомендация</summary>
                    <p>{f.explanation}</p>
                    <p>{f.recommendation}</p>
                    <p className="quiet">{f.expectedEffect}</p>
                  </details>
                </article>
              ))}
            </div>
            {quality.findingsTruncated && (
              <p className="small quiet">Показаны первые 400 рекомендаций.</p>
            )}
          </>
        )}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-metrics`}
        aria-labelledby={`${id}-tab-metrics`}
        hidden={tab !== "metrics"}
      >
        {!metric ? (
          <p className="insight-empty">
            {analysis?.parseStatus === "invalid"
              ? "Исправьте синтаксис для расчёта метрик"
              : "Выберите метод"}
          </p>
        ) : (
          <section
            className="method-metrics"
            aria-label="Метрики метода"
            data-method-id={metric.methodId}
          >
            <h3 title={method?.fullyQualifiedName}>{method?.signature}</h3>
            <button
              className="metric-location"
              disabled={!current}
              onClick={() => onNavigate(metric.sourceRange, metric.methodId)}
            >
              {metric.sourceRange.filePath}:{metric.sourceRange.startLine}
              <ArrowUpRight size={13} />
            </button>
            <dl>
              {[
                [
                  "Строк кода",
                  metric.codeLines,
                  "Строки тела с лексемами, включая скобки. Комментарии и пустые строки исключены; многострочный литерал занимает все свои строки.",
                ],
                [
                  "Строк тела",
                  metric.bodyLines,
                  "Физические строки тела, включая скобки, комментарии и пустые строки.",
                ],
                [
                  "Операторов",
                  metric.statements,
                  "Узлы операторов без блоков-контейнеров, пустых операторов и объявлений локальных классов.",
                ],
                [
                  "Ветвление",
                  metric.branchingScore,
                  "Синтаксический показатель: 1 + if + циклы + ?: + &&/|| + недефолтные case + catch. Не Big O и не точная сложность CFG.",
                ],
                [
                  "Вложенность",
                  metric.maxNesting,
                  "Максимум вложенных if, циклов, switch, try, catch и synchronized по AST.",
                ],
                [
                  "Циклов",
                  metric.loops,
                  "Число for, for-each, while и do-while.",
                ],
                [
                  "Глубина циклов",
                  metric.maxLoopNesting,
                  "Максимальное число циклов, вложенных друг в друга.",
                ],
                [
                  "Вызовов",
                  metric.calls,
                  "Вызовы методов, создание объектов и явные this()/super(). Это количество мест вызова, не запусков.",
                ],
              ].map(([label, value, definition]) => (
                <div key={label} title={String(definition)}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="metric-complexity">
              <span>Сложность по времени</span>
              <strong>Не определена</strong>
              <p>Границы циклов и стоимость вызовов не доказаны.</p>
            </div>
            <p className="metric-scope">
              Тела лямбд и вложенных объявлений исключены.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
