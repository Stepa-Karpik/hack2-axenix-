import type { Report } from "./types";
function csvCell(v: unknown) {
  const value = String(v ?? "");
  return (
    '"' +
    (/^[=+@\-\t\r]/.test(value) ? "'" : "") +
    value.replaceAll('"', '""') +
    '"'
  );
}
export default function ReportDownloads({ report }: { report: Report }) {
  function download(format: "json" | "csv") {
    const rows = report.testResults?.map((t) => [
      t.caseId,
      t.verdict,
      t.reasons.join("; "),
      t.baseExecutions?.length ?? 0,
      t.candidateExecutions?.length ?? 0,
    ]) ?? [
      [
        report.entryPoint,
        report.outcome ?? report.runtimeExecution?.outcome,
        report.runtimeExecution?.exitCode,
        report.wallTimeMs,
      ],
    ];
    const header = report.testResults
      ? ["caseId", "verdict", "reasons", "baseObserved", "candidateObserved"]
      : ["entryPoint", "outcome", "exitCode", "wallTimeMs"];
    const content =
      format === "json"
        ? JSON.stringify(report, null, 2)
        : "\uFEFF" +
          [header, ...rows]
            .map((row) => row.map(csvCell).join(","))
            .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([content], {
        type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "report-" +
      (report.revisionId ?? report.candidateRevisionId ?? "result").slice(
        0,
        8,
      ) +
      "." +
      format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <details className="report-downloads">
      <summary>Скачать отчёт</summary>
      <button onClick={() => download("json")}>JSON</button>
      <button onClick={() => download("csv")}>CSV</button>
    </details>
  );
}
