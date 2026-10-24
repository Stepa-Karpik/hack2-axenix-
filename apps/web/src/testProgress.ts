export function testDuration(milliseconds?: number | null) {
  if (
    milliseconds === undefined ||
    milliseconds === null ||
    !Number.isFinite(milliseconds)
  )
    return "—";
  return milliseconds < 1000
    ? Math.round(Math.max(0, milliseconds)) + " мс"
    : (milliseconds / 1000).toFixed(1) + " с";
}

export function visibleTestStatus(status: string, jobStatus: string) {
  if (["failed", "cancelled", "succeeded"].includes(jobStatus)) {
    if (status === "running")
      return jobStatus === "cancelled" ? "cancelled" : "inconclusive";
    if (status === "queued") return "not_run";
  }
  return status;
}

export const testStatusLabels: Record<string, string> = {
  queued: "Ожидает",
  running: "Выполняется",
  matched: "Совпало",
  mismatch: "Расхождение",
  inconclusive: "Неопределённо",
  cancelled: "Остановлен",
  not_run: "Не запускался",
};

export function testReason(reason: string) {
  return (
    (
      {
        timeout: "Лимит времени",
        output_limit: "Лимит вывода",
        memory_limit: "Лимит памяти",
        cancelled: "Проверка остановлена",
        incomplete: "Не все запуски завершены",
        nondeterministic: "Нестабильный результат",
        infrastructure_error: "Ошибка среды запуска",
        cleanup_pending: "Очистка среды не подтверждена",
        nonzero_without_oracle:
          "Ненулевой код завершения без ожидаемого результата",
        runner_unavailable: "Среда запуска недоступна",
        compile_error: "Ошибка компиляции",
        compile_execution_limit: "Не удалось завершить компиляцию",
      } as Record<string, string>
    )[reason] ?? reason
  );
}

export function progressTitle(
  phase: string | undefined,
  jobStatus: string,
  stopping = false,
) {
  if (jobStatus === "cancelled") return "Проверка остановлена";
  if (jobStatus === "failed") return "Не удалось завершить проверку";
  if (stopping) return "Останавливаем…";
  return (
    (
      {
        queued: "В очереди",
        compile_base: "Компиляция исходной версии",
        compile_candidate: "Компиляция изменений",
        tests: "Проверяем тесты",
        finished: "Проверка завершена",
        cancelled: "Проверка остановлена",
        compile_error: "Ошибка компиляции",
        unavailable: "Среда запуска недоступна",
        inconclusive: "Проверка не завершена",
        failed: "Не удалось завершить проверку",
      } as Record<string, string>
    )[phase ?? "queued"] ?? "Проверка"
  );
}
