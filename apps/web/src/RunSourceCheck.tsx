import { useEffect, useState } from "react";
import { api, projectPath } from "./api";
import { javaFilenameIssues } from "./projectFiles";
import type { Revision } from "./types";

export type RunSource = { id: string; label: string };
export type CheckedSource = { revision: Revision; label: string };
export function useRunSources(projectId: string, sources: RunSource[]) {
  const key = JSON.stringify([projectId, sources]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    key: string;
    sources: CheckedSource[];
    error: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    setState(undefined);
    const requested = JSON.parse(key)[1] as RunSource[];
    const targets = [...new Set(requested.map((source) => source.id))].map(
      (id) => ({
        id,
        label: requested
          .filter((source) => source.id === id)
          .map((source) => source.label)
          .join(" / "),
      }),
    );
    const requests = new Map(
      targets.map((target) => [
        target.id,
        api<Revision>(`${projectPath(projectId)}/revisions/${target.id}`, {
          signal: controller.signal,
        }),
      ]),
    );
    void Promise.all(
      targets.map(async (target) => ({
        revision: await requests.get(target.id)!,
        label: target.label,
      })),
    )
      .then((checked) => {
        if (!controller.signal.aborted)
          setState({ key, sources: checked, error: "" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            sources: [],
            error:
              error instanceof Error
                ? error.message
                : "Не удалось проверить файлы версии",
          });
      });
    return () => controller.abort();
  }, [key, projectId, retry]);
  const current = state?.key === key ? state : undefined;
  return {
    ready: !!current && !current.error,
    sources: current?.sources ?? [],
    error: current?.error ?? "",
    retry: () => setRetry((value) => value + 1),
  };
}
export function SourceFilenameIssues({
  sources,
  onOpen,
}: {
  sources: CheckedSource[];
  onOpen?: (revisionId: string, path: string) => void;
}) {
  return sources.flatMap(({ revision, label }) =>
    javaFilenameIssues(revision.files, revision.directories).map((issue) => (
      <div
        className="notice error"
        role="alert"
        key={revision.id + label + issue.path}
      >
        <strong>
          {label} · {issue.path}
        </strong>
        <p>
          Публичный тип {issue.type} требует имя файла {issue.type}.java.
        </p>
        {issue.targetOccupied && (
          <p>
            {issue.target} уже существует — его содержимое нельзя перезаписать.
          </p>
        )}
        {onOpen && (
          <button onClick={() => onOpen(revision.id, issue.path)}>
            Открыть {issue.path}
          </button>
        )}
      </div>
    )),
  );
}
export function CompileErrorHelp({
  projectId,
  sources,
  onOpen,
  onRetry,
}: {
  projectId: string;
  sources: RunSource[];
  onOpen?: (revisionId: string, path: string) => void;
  onRetry?: () => void;
}) {
  const checked = useRunSources(projectId, sources);
  return (
    <section aria-label="Почему тесты не запущены">
      <p className="notice error">
        Тесты не запускались: сначала нужно исправить ошибку компиляции.
      </p>
      <SourceFilenameIssues sources={checked.sources} onOpen={onOpen} />
      {checked.error && (
        <p role="alert">
          {checked.error}{" "}
          <button onClick={checked.retry}>Повторить проверку файлов</button>
        </p>
      )}
      {onRetry && (
        <button onClick={onRetry}>Настроить и повторить тесты</button>
      )}
    </section>
  );
}
