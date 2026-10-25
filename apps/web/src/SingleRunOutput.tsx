import type { Report } from "./types";
import ExecutionResources from "./ExecutionResources";

export default function SingleRunOutput({
  report,
  sourceHash,
  cancelled = false,
}: {
  report: Report;
  sourceHash: string | null;
  cancelled?: boolean;
}) {
  const compile = report.compileExecution;
  const runtime = report.runtimeExecution;
  const failedCompile = compile && compile.outcome !== "exited";
  const outcome = failedCompile ? compile.outcome : runtime?.outcome;
  const status =
    cancelled || outcome === "cancelled"
      ? "Остановлено"
      : failedCompile
        ? "Ошибка компиляции"
        : outcome === "timeout"
          ? "Превышено время запуска"
          : outcome === "output_limit"
            ? "Достигнут лимит вывода"
            : outcome === "oom"
              ? "Недостаточно памяти"
              : outcome === "sandbox_error"
                ? "Ошибка среды запуска"
                : runtime?.exitCode !== undefined && runtime.exitCode !== 0
                  ? "Программа завершилась с ошибкой"
                  : "Завершено";
  return (
    <section className="single-run-output" aria-label="Результат запуска">
      <div className="run-result-heading">
        <span>{status}</span>
        <span>
          {report.wallTimeMs !== undefined
            ? (report.wallTimeMs / 1000).toFixed(1) + " с"
            : ""}
        </span>
      </div>
      {failedCompile ? (
        <pre className="console-stderr">
          {compile.stderrUtf8 || compile.stdoutUtf8}
        </pre>
      ) : (
        <>
          {runtime?.stdoutUtf8 ? (
            <pre className="program-output">{runtime.stdoutUtf8}</pre>
          ) : (
            <p className="quiet">Нет вывода</p>
          )}
          {runtime?.stderrUtf8 && (
            <pre className="console-stderr">{runtime.stderrUtf8}</pre>
          )}
        </>
      )}
      {runtime?.truncated && (
        <p className="warning">Вывод обрезан после достижения лимита.</p>
      )}
      <details className="run-input">
        <summary>Ввод и аргументы</summary>
        <code>{report.entryPoint}</code>
        <code>argv {JSON.stringify(report.argv ?? [])}</code>
        <pre aria-label="Стандартный ввод отчёта">
          {report.stdinUtf8 ?? ""}
          {report.inputLines?.map((line) => line.text).join("")}
        </pre>
      </details>
      <details className="run-provenance">
        <summary>Подробности запуска</summary>
        <span className="run-revision">
          Версия <code>{report.revisionId}</code>
        </span>
        {sourceHash && <code>SHA-256 {sourceHash}</code>}
        <span>Код завершения: {runtime?.exitCode ?? "—"}</span>
        <ExecutionResources execution={runtime} />
      </details>
    </section>
  );
}
