import type { Execution } from "./types";

export default function ExecutionResources({
  execution,
}: {
  execution?: Execution;
}) {
  const metrics = execution?.metrics;
  if (!metrics) return null;
  return (
    <span
      className="quiet"
      title="Время команды с запуском Docker exec и чтением потоков. Пик памяти cgroup за жизнь контейнера, включая подготовку и измерение; это не размер Java heap."
    >
      {(metrics.executionWallMs / 1000).toFixed(2)} с
      {metrics.containerPeakMemoryBytes !== null && (
        <> · {(metrics.containerPeakMemoryBytes / 1048576).toFixed(1)} МиБ</>
      )}
    </span>
  );
}
